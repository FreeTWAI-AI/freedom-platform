import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, before, beforeEach, describe, test } from 'node:test';
import type { PoolClient } from 'pg';
import { authenticate } from '../../modules/identity-membership/service.js';
import type { Session } from './module-registry-harness.js';
import {hostedPaymentHarness} from '../e2e/hosted-payment-fixture.js';
import {createTenantListCursorCodec} from '../../packages/shared/tenant-list-cursor.js';
import {sellerCheckoutCommand} from '../../modules/agent-commerce/checkout/seller-command.js';
import {cancelSellerCheckoutOrder,sellerCustomer,readSellerCheckoutOrder,listSellerCheckoutOrders,readSellerOrderContact} from '../../modules/agent-commerce/checkout/seller-orders.js';
import {bindStore} from '../../modules/agent-commerce/checkout/authority.js';
import {openException} from '../../modules/agent-commerce/checkout/exceptions.js';
import {COMMERCE_LIMITS} from '../../modules/agent-commerce/checkout/limits.js';
import {hashKey} from '../../modules/agent-commerce/checkout/terms.js';
import {cancelUnpaidOrder} from '../../modules/agent-commerce/checkout/orders.js';
import {applyConfirmedPayment,recordHandover,releaseAllocation} from '../../modules/agent-commerce/checkout/payments.js';
import {settleDueCheckoutHolds} from '../../modules/agent-commerce/checkout/settlement.js';
import {EcpayKeyPair,encodeForm,signFields} from '../../modules/agent-commerce/providers/ecpay/index.js';

const code = (expected: string) => (e: unknown) => (e as { code?: string }).code === expected;

describe('hosted checkout seller commands',()=>{
  let f:Awaited<ReturnType<typeof hostedPaymentHarness>>;
  before(async()=>{f=await hostedPaymentHarness('fp_checkout_seller',{randomContact:true});});
  beforeEach(async()=>{await f.reset();f.settings.consoleEnabled=true;f.install({tenantListCursors:createTenantListCursorCodec(randomBytes(32).toString('base64url'),{environment:'local',origin:f.origin})});});
  after(async()=>f?.stop());
  test('store binding preserves the scoped principal, tenant and scope through cancellation and receipt replay',async()=>{
    const p=await f.placed(),a=await authenticate(f.x.runtime,p.s.owner.cookie.split('=')[1].split(';')[0]),key=randomUUID();
    const bound=async(q:PoolClient)=>(await q.query(`SELECT current_setting('freedom.principal_id') principal,current_setting('freedom.tenant_id') tenant,current_setting('freedom.tenant_scope_id') scope`)).rows[0];
    let runs=0,projections=0;
    const command=()=>sellerCheckoutCommand(f.x.runtime,a,p.s.tenantId,p.s.instanceId,'store:orders:manage','commerce.checkout_order.cancel',
      {kind:'hosted_checkout_order',id:p.order.order_ref},{},key,'1',async(q,context)=>{
        runs++;const before=await bound(q);
        assert.deepEqual(before,{principal:context.tenant.principal_id,tenant:context.tenant.tenant_id,scope:context.tenant.scope.scope_id});
        await cancelUnpaidOrder(q,{storefront_shop_id:context.profile.storefront_shop_id},p.order.order_ref,'seller','seller_cancelled',f.runtime.commercePorts);
        assert.deepEqual(await bound(q),before);return {id:p.order.order_ref};
      },async(q,context,id)=>{
        projections++;assert.deepEqual(await bound(q),{principal:context.tenant.principal_id,tenant:context.tenant.tenant_id,scope:context.tenant.scope.scope_id});
        return (await q.query('SELECT order_id,lifecycle_state,version::text FROM commerce_checkout_orders WHERE order_id=$1',[id])).rows[0];
      });
    assert.equal((await command()).lifecycle_state,'cancelled');assert.equal((await command()).version,'2');
    assert.equal(runs,1);assert.equal(projections,2);
    assert.deepEqual((await f.x.h.pool.query("SELECT response FROM scoped_command_receipts WHERE operation='commerce.checkout_order.cancel'")).rows.map(r=>r.response),[{id:p.order.order_ref}]);
  });
  test('checkout projections mask Unicode names, isolate contact and finance, and preserve expired holds',async()=>{
    const s=await f.x.store(100);await f.setup(s);
    const due=await f.x.due(s),a=await authenticate(f.x.runtime,s.owner.cookie.split('=')[1].split(';')[0]);
    const before=async()=>{const snapshot:Record<string,unknown>={};for(const r of (await f.x.h.pool.query("SELECT tablename FROM pg_tables WHERE schemaname=current_schema() AND tablename LIKE 'commerce_%' ORDER BY tablename")).rows)snapshot[r.tablename]=(await f.x.h.pool.query(`SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]') AS rows FROM ${r.tablename} t`)).rows[0].rows;return snapshot;};
    const saved=await before();
    const read=()=>readSellerCheckoutOrder(f.x.runtime,a,s.tenantId,s.instanceId,due.order_id,{payment:f.runtime.commercePorts?.payment,settings:f.settings});
    const result=await read();assert.equal(result.inventory_state,'hold_expired');assert.equal(result.customer.name_masked,'合○○');assert.equal(result.lines[0].inventory.held,5);
    assert.deepEqual(await before(),saved);
    const contact=await readSellerOrderContact(f.x.runtime,a,s.tenantId,s.instanceId,due.order_id);
    assert.equal(contact.contact?.name,f.x.input(s.product.sku).contact.name);assert.deepEqual(await before(),saved);
    const json=JSON.stringify(result);for(const value of [...Object.values(f.x.input(s.product.sku).contact),String(f.x.input(s.product.sku).delivery.address)])assert.equal(json.includes(value),false,value);
    for(const [name,masked] of [[' Alice ','A○○'],[' 王小明 ','王○○'],[' 😀 buyer ','😀○○'],['   ','○○']])assert.deepEqual(sellerCustomer(name,false),{name_masked:masked,contact_redacted:false});
    const removed=await f.x.h.pool.query(`UPDATE commerce_checkout_contacts SET contact_name=NULL,contact_email=NULL,contact_phone=NULL,delivery=NULL,invoice=NULL,contact_salt=NULL,redacted_at=clock_timestamp() WHERE contact_id=(SELECT contact_id FROM commerce_checkout_orders WHERE order_id=$1)`,[due.order_id]);assert.equal(removed.rowCount,1);
    assert.deepEqual((await read()).customer,{name_masked:null,contact_redacted:true});
    const redacted=await readSellerOrderContact(f.x.runtime,a,s.tenantId,s.instanceId,due.order_id);assert.equal(redacted.contact_redacted,true);assert.equal(redacted.contact,null);assert.equal(redacted.delivery,null);assert.equal(redacted.invoice,null);
  });
  test('checkout list uses exact filters and signed instance/principal/filter-bound cursors',async()=>{
    const s=await f.x.store(100);await f.setup(s);const a=await authenticate(f.x.runtime,s.owner.cookie.split('=')[1].split(';')[0]),options={cursors:f.runtime.tenantListCursors};
    const ids:string[]=[];for(let i=0;i<3;i++){const c=await f.x.frozen(s,1,{contact:{name:'合成'+randomUUID(),email:randomUUID()+'@example.test',phone:randomUUID().slice(0,8)}});ids.push((await f.x.place(s,c)).order_id);}
    const list=(query:unknown)=>listSellerCheckoutOrders(f.x.runtime,a,s.tenantId,s.instanceId,query,options);
    const first=await list({limit:'2'}),second=await list({limit:'2',cursor:first.next_cursor});
    assert.deepEqual([...first.items,...second.items].map(r=>r.order_ref),ids.reverse());assert.equal(second.next_cursor,null);
    assert.equal((await list({display_number:first.items[0].display_number})).items.length,1);
    assert.equal((await list({needs_action:'true'})).items.length,0);
    for(const query of [{limit:'0'},{limit:'51'},{unknown:'x'},{needs_action:'false'},{display_number:'x'},{lifecycle:'bad'}])await assert.rejects(list(query));
    await assert.rejects(list({lifecycle:'open',cursor:first.next_cursor}),code('invalid_cursor'));
    const attention=await f.x.tx(async q=>{await bindStore(q,s.tenantId);return openException(q,{tenantId:s.tenantId,instanceId:s.instanceId,orderId:ids[0],kind:'unmatched_payment',subjectKind:'payment_event',subjectId:randomUUID()});});assert(attention.case_id);assert.deepEqual((await list({needs_action:'true'})).items.map(v=>v.order_ref),[ids[0]]);
    await cancelSellerCheckoutOrder(f.x.runtime,a,s.tenantId,s.instanceId,ids[1],randomUUID(),'1');
    await f.x.h.pool.query("UPDATE commerce_checkout_orders SET lifecycle_state='closed',closed_at=clock_timestamp(),version=version+1 WHERE order_id=$1",[ids[2]]);
    assert.deepEqual((await list({lifecycle:'cancelled'})).items.map(v=>v.order_ref),[ids[1]]);assert.deepEqual((await list({lifecycle:'closed'})).items.map(v=>v.order_ref),[ids[2]]);assert.deepEqual((await list({lifecycle:'open'})).items.map(v=>v.order_ref),[ids[0]]);
    await assert.rejects(cancelSellerCheckoutOrder(f.x.runtime,a,s.tenantId,s.instanceId,ids[2],randomUUID(),'2'),code('checkout_order_closed'));
  });

  test('seller unpaid cancel checks the locked version, projects replays and schedules handed-off attempts',async()=>{
    const p=await f.placed(),a=await authenticate(f.x.runtime,p.s.owner.cookie.split('=')[1].split(';')[0]),options={settings:f.settings,payment:f.runtime.commercePorts?.payment},key=randomUUID();
    await f.x.h.pool.query('UPDATE commerce_payment_attempts SET journaled_at=clock_timestamp(),handed_off_at=clock_timestamp(),version=version+1 WHERE attempt_id=$1',[p.payment.attempt_ref]);
    const cancel=(version:string,k=key)=>cancelSellerCheckoutOrder(f.x.runtime,a,p.s.tenantId,p.s.instanceId,p.order.order_ref,k,version,options);
    await assert.rejects(cancel('2'),code('version_conflict'));
    const result=await cancel('1');assert.equal(result.version,'2');assert.equal(result.lifecycle_state,'cancelled');assert.equal(result.cancel_reason,'seller_cancelled');
    await f.x.h.pool.query(`UPDATE commerce_checkout_contacts SET contact_name=NULL,contact_email=NULL,contact_phone=NULL,delivery=NULL,invoice=NULL,contact_salt=NULL,redacted_at=clock_timestamp() WHERE contact_id=(SELECT contact_id FROM commerce_checkout_orders WHERE order_id=$1)`,[p.order.order_ref]);
    const replay=await cancel('1');assert.equal(replay.version,'2');assert.deepEqual(replay.customer,{name_masked:null,contact_redacted:true});assert.equal((await cancel('2',randomUUID())).version,'2');
    const due=(await f.x.h.pool.query("SELECT due_at<=clock_timestamp() AS ready FROM commerce_due_work WHERE kind='payment_query' AND target_id=$1",[p.payment.attempt_ref])).rows[0];assert.equal(due.ready,true);
    f.settings.quarantine=true;await assert.rejects(cancel('2',randomUUID()),code('commerce_quarantined'));
    assert.equal((await readSellerCheckoutOrder(f.x.runtime,a,p.s.tenantId,p.s.instanceId,p.order.order_ref,options)).actions.cancel,false);
    const receipts=(await f.x.h.pool.query("SELECT response FROM scoped_command_receipts WHERE operation='commerce.checkout_order.cancel'")).rows;assert.equal(receipts.length,2);for(const r of receipts)assert.deepEqual(r.response,{id:p.order.order_ref});
  });

  async function member(s:Awaited<ReturnType<typeof f.x.store>>,role:'admin'|'viewer'|'operator',caps:string[]=[]){
    const m=await f.x.h.person('合成成員'+randomUUID()),principal=await f.x.h.candidate(s.owner,m.id);await f.x.h.accept(m.session,s.tenantId,await f.x.h.invite(s.owner,s.tenantId,principal,role));
    if(caps.length)await f.x.h.pool.query(`INSERT INTO tenant_module_permissions(tenant_id,principal_id,instance_id,capabilities,status,granted_by_principal_id) SELECT $1,$2,$3,$4,'active',principal_id FROM principals WHERE user_ref=$5`,[s.tenantId,principal,s.instanceId,['store:read',...caps],s.owner.user.user_id]);return {...m,principal};
  }
  const request=(s:{root:string;owner:Session},method:string,path:string,session=s.owner,body?:unknown,headers:Record<string,string>={})=>f.x.h.call(method,s.root+path,session,body,headers,f.app);
  test('seller HTTP capabilities are independent; owner/admin and explicit grants use the installed release',async()=>{
    const p=await f.placed(),application=await f.x.tx(q=>applyConfirmedPayment(q,{orderId:p.order.order_ref,paymentRef:p.payment.attempt_ref,amountMinor:600,currency:'TWD',simulated:false}));
    for(const [role,caps] of [['owner',[]],['admin',[]],['viewer',['store:orders:read']],['viewer',['store:finance:read']],['viewer',['store:customers:read']],['operator',['store:orders:manage']],['operator',['store:refund']]] as const){
      const session=role==='owner'?p.s.owner:(await member(p.s,role,[...caps])).session,all=role==='owner'||role==='admin',orders=all||(caps as readonly string[]).includes('store:orders:read'),customers=all||(caps as readonly string[]).includes('store:customers:read'),manage=all||(caps as readonly string[]).includes('store:orders:manage');
      const c=await f.x.tx(async q=>{await bindStore(q,p.s.tenantId);return openException(q,{tenantId:p.s.tenantId,instanceId:p.s.instanceId,kind:'unmatched_payment',subjectKind:'payment_event',subjectId:randomUUID()});});
      for(const path of ['/checkout-orders','/checkout-orders/'+p.order.order_ref,'/exception-cases?view=retailer','/exception-cases/'+c.case_id]){
        const r=await request(p.s,'GET',path,session);assert.equal(r.status,orders?200:403,role+' '+caps+' '+path+' '+JSON.stringify(r.data));assert.equal(r.response.headers.get('Cache-Control'),'private, no-store');
        if(!orders)assert.equal(r.data.code,'capability_denied');
        if(orders&&path==='/checkout-orders/'+p.order.order_ref){assert.equal(r.data.payment_detail!==null,all);assert.equal(r.response.headers.get('ETag'),`"${r.data.version}"`);}
        if(orders&&path==='/exception-cases/'+c.case_id&&!manage){assert.deepEqual(r.data.allowed_actions,[]);assert.equal(r.data.payment_facts,null);}
      }
      const contact=await request(p.s,'GET','/checkout-orders/'+p.order.order_ref+'/contact',session);assert.equal(contact.status,customers?200:403);assert.equal(contact.response.headers.get('ETag'),null);
      const version=(await f.x.h.pool.query('SELECT version::text FROM commerce_checkout_orders WHERE order_id=$1',[p.order.order_ref])).rows[0].version;
      const cancelled=await request(p.s,'POST','/checkout-orders/'+p.order.order_ref+'/cancel',session,{}, {'Idempotency-Key':randomUUID(),'If-Match':`"${version}"`});assert.equal(cancelled.status,manage?200:403,JSON.stringify(cancelled.data));
      const finance=all||(caps as readonly string[]).includes('store:finance:read'),refund=all||(caps as readonly string[]).includes('store:refund');
      assert.equal((await request(p.s,'GET','/checkout-orders/'+p.order.order_ref+'/refunds',session)).status,finance?200:403);
      await f.x.h.pool.query("DELETE FROM auth_rate_limits WHERE bucket LIKE 'commerce:paymentQueryOrder%'");
      assert.equal((await request(p.s,'POST','/checkout-orders/'+p.order.order_ref+'/payment-queries',session,{})).status,orders||finance?200:403);
      const today=(await f.x.h.pool.query("SELECT to_char(clock_timestamp() AT TIME ZONE 'Asia/Taipei','YYYY-MM-DD') today")).rows[0].today;
      const recorded=await request(p.s,'POST','/checkout-orders/'+p.order.order_ref+'/refunds',session,{application_ref:application.application_id,amount_minor:100,refunded_on:today},{'Idempotency-Key':randomUUID()});assert.equal(recorded.status,refund?201:403,JSON.stringify(recorded.data));
      const resolved=await request(p.s,'POST','/exception-cases/'+c.case_id+'/actions/resolve_with_evidence',session,{code:'checked_with_provider',provider_date:today,provider_reference:'F1'}, {'Idempotency-Key':randomUUID(),'If-Match':'"1"'});assert.equal(resolved.status,manage?200:403,JSON.stringify(resolved.data));
    }
    const receipts=(await f.x.h.pool.query("SELECT response FROM scoped_command_receipts WHERE operation IN ('commerce.checkout_order.cancel','commerce.exception_case.resolve_with_evidence','commerce.exception_case.retry_allocation','commerce.refund.record')")).rows;for(const r of receipts)assert.deepEqual(Object.keys(r.response),['id']);
    const old=await f.x.store();assert.equal((await request(old,'GET','/checkout-orders')).status,403);
    const granted=await member(p.s,'viewer',['store:orders:read']);assert.equal((await request(p.s,'GET','/checkout-orders',granted.session)).status,200);
    await f.x.h.pool.query("UPDATE tenant_module_permissions SET capabilities=ARRAY['store:read'],updated_at=clock_timestamp(),version=version+1 WHERE tenant_id=$1 AND principal_id=$2",[p.s.tenantId,granted.principal]);assert.equal((await request(p.s,'GET','/checkout-orders',granted.session)).status,403);
    await f.x.h.pool.query("UPDATE tenant_module_permissions SET status='revoked',revoked_at=clock_timestamp(),updated_at=clock_timestamp(),version=version+1 WHERE tenant_id=$1 AND principal_id=$2",[p.s.tenantId,granted.principal]);assert.equal((await request(p.s,'GET','/checkout-orders',granted.session)).status,404);
  });
  test('seller HTTP validates strict queries, version headers and console mounting without exposing foreign orders',async()=>{
    const p=await f.placed(),order='/checkout-orders/'+p.order.order_ref;
    for(const path of ['/checkout-orders?unknown=x','/checkout-orders?limit=1&limit=2',order+'?x=1',order+'/contact?x=1'])assert.equal((await request(p.s,'GET',path)).status,422);
    const missing=await request(p.s,'POST',order+'/cancel',p.s.owner,{}, {'Idempotency-Key':randomUUID()});assert.equal(missing.status,428);assert.equal(missing.data.code,'version_required');
    assert.equal((await request(p.s,'POST',order+'/cancel',p.s.owner,{reason:'free text'},{'Idempotency-Key':randomUUID(),'If-Match':'"1"'})).status,422);
    const foreign=await f.x.store();await f.setup(foreign);assert.equal((await request(foreign,'GET',order)).status,404);
    const another=await f.x.store();await f.setup(another);const viewer=await member(another,'admin');assert.equal((await request(p.s,'GET',order,viewer.session)).status,404);
    f.settings.checkoutEnabled=false;assert.equal((await request(p.s,'GET',order)).status,200);
    f.settings.consoleEnabled=false;f.install();
    for(const [method,path,body] of [['GET','/checkout-orders',undefined],['GET',order,undefined],['GET',order+'/contact',undefined],['POST',order+'/cancel',{}],['GET',order+'/refunds',undefined],['POST',order+'/refunds',{}],['POST',order+'/payment-queries',{}],['GET','/exception-cases?view=retailer',undefined],['GET','/exception-cases/'+randomUUID(),undefined],['POST','/exception-cases/'+randomUUID()+'/actions/resolve_with_evidence',{}]] as const)assert.equal((await request(p.s,method,path,p.s.owner,body)).status,404);
    f.settings.consoleEnabled=true;
  });
  test('contact budget counts denied reads, refuses at the principal limit and leaves other principals available',async()=>{
    const p=await f.placed(),denied=await member(p.s,'viewer',['store:orders:read']),path='/checkout-orders/'+p.order.order_ref+'/contact',bucket='commerce:customerDataPrincipal:'+hashKey(denied.principal);
    assert.equal((await request(p.s,'GET',path,denied.session)).status,403);
    assert.equal((await f.x.h.pool.query('SELECT attempts FROM auth_rate_limits WHERE bucket=$1',[bucket])).rows[0].attempts,1);
    await f.x.h.pool.query('UPDATE auth_rate_limits SET attempts=$2 WHERE bucket=$1',[bucket,COMMERCE_LIMITS.customerDataPrincipal.limit]);
    const limited=await request(p.s,'GET',path,denied.session);assert.equal(limited.status,429);assert.equal(limited.data.code,'commerce_rate_limited');assert.ok(Number(limited.response.headers.get('Retry-After'))>0);
    assert.equal((await request(p.s,'GET',path)).status,200);
  });

  test('all inventory axes and line counters derive from retained holds and allocations without read effects',async()=>{
    const p=await f.placed(),a=await authenticate(f.x.runtime,p.s.owner.cookie.split('=')[1].split(';')[0]),options={settings:f.settings,payment:f.runtime.commercePorts?.payment};
    const read=()=>readSellerCheckoutOrder(f.x.runtime,a,p.s.tenantId,p.s.instanceId,p.order.order_ref,options);
    assert.equal((await read()).inventory_state,'held');assert.equal((await read()).payment_state,'unpaid');
    await f.x.tx(q=>applyConfirmedPayment(q,{orderId:p.order.order_ref,paymentRef:p.payment.attempt_ref,amountMinor:500,currency:'TWD',simulated:false}));
    let view=await read();assert.equal(view.inventory_state,'allocated');assert.equal(view.payment_state,'confirmed');assert.equal(view.actions.cancel,false);assert.deepEqual(view.lines[0].inventory,{held:0,allocated:5,shipped:0,released:0});
    await f.x.tx(q=>recordHandover(q,p.s,{shipmentRef:randomUUID(),lines:[{orderId:p.order.order_ref,itemId:p.s.product.product_id,quantity:2}]}));
    view=await read();assert.equal(view.inventory_state,'partially_shipped');assert.deepEqual(view.lines[0].inventory,{held:0,allocated:3,shipped:2,released:0});
    await f.x.tx(q=>recordHandover(q,p.s,{shipmentRef:randomUUID(),lines:[{orderId:p.order.order_ref,itemId:p.s.product.product_id,quantity:3}]}));assert.equal((await read()).inventory_state,'shipped');
    const other=await f.placed(),actor=await authenticate(f.x.runtime,other.s.owner.cookie.split('=')[1].split(';')[0]);
    await f.x.tx(q=>applyConfirmedPayment(q,{orderId:other.order.order_ref,paymentRef:other.payment.attempt_ref,amountMinor:500,currency:'TWD',simulated:false}));
    await f.x.tx(q=>releaseAllocation(q,other.s,{orderId:other.order.order_ref,commandRef:randomUUID()}));
    view=await readSellerCheckoutOrder(f.x.runtime,actor,other.s.tenantId,other.s.instanceId,other.order.order_ref,options);assert.equal(view.inventory_state,'released');assert.equal(view.lines[0].inventory.released,5);
    const due=await f.x.due(other.s);await f.x.tx(q=>settleDueCheckoutHolds(q,[other.s.product.product_id]));await f.x.h.pool.query('UPDATE commerce_items SET stock=0 WHERE item_id=$1',[other.s.product.product_id]);
    await f.x.tx(q=>applyConfirmedPayment(q,{orderId:due.order_id,paymentRef:randomUUID(),amountMinor:500,currency:'TWD',simulated:false}));
    assert.equal((await readSellerCheckoutOrder(f.x.runtime,actor,other.s.tenantId,other.s.instanceId,due.order_id,options)).inventory_state,'unallocated');
  });
  test('historical orders stay private across same-tenant store replacement and cursors reject another principal or store',async()=>{
    const p=await f.placed();for(let i=0;i<2;i++){const c=await f.x.frozen(p.s,1,{contact:{name:'合成'+randomUUID(),email:randomUUID()+'@example.test',phone:randomUUID().slice(0,8)}});await f.x.place(p.s,c);}
    const first=await request(p.s,'GET','/checkout-orders?limit=1');assert.equal(first.status,200);assert(first.data.next_cursor);
    const viewer=await member(p.s,'viewer',['store:orders:read']);assert.equal((await request(p.s,'GET','/checkout-orders?cursor='+encodeURIComponent(first.data.next_cursor),viewer.session)).status,422);
    await f.x.h.pool.query("UPDATE module_instances SET status='archived',version=version+1 WHERE instance_id=$1",[p.s.instanceId]);
    const workspace=await f.x.h.workspace(p.s.owner,p.s.tenantId,'合成新櫃檯'),plan=await f.x.h.plan(p.s.owner,p.s.tenantId,f.x.h.planBody('guild_commerce_sales',workspace,'hosted-store','hosted-store@1.0.0'));assert.equal(plan.status,201,JSON.stringify(plan.data));assert.equal((await f.x.h.launch(p.s.owner,p.s.tenantId,plan)).data.state,'succeeded');
    const id=(await f.x.h.pool.query("SELECT instance_id FROM module_instances WHERE tenant_id=$1 AND status='active'",[p.s.tenantId])).rows[0].instance_id,root=`/tenants/${p.s.tenantId}/storefronts/${id}`;
    assert.equal((await f.x.h.call('POST',root+'/setup',p.s.owner,{name:'合成新商店',slug:'r-'+randomUUID().slice(0,12),currency:'TWD'},{'Idempotency-Key':randomUUID()},f.app)).status,201);
    const next={...p.s,instanceId:id,root};await f.setup(next);
    assert.equal((await request(next,'GET','/checkout-orders/'+p.order.order_ref)).status,404);
    assert.equal((await request(next,'GET','/checkout-orders?cursor='+encodeURIComponent(first.data.next_cursor))).status,422);
  });
  test('suspended selling instances can cancel obligations, while inactive tenants cannot write',async()=>{
    const p=await f.placed(),order='/checkout-orders/'+p.order.order_ref;
    await f.x.h.pool.query("UPDATE module_instances SET status='suspended',version=version+1 WHERE instance_id=$1",[p.s.instanceId]);
    f.settings.checkoutEnabled=false;assert.equal((await request(p.s,'GET',order)).status,200);const r=await request(p.s,'POST',order+'/cancel',p.s.owner,{}, {'Idempotency-Key':randomUUID(),'If-Match':'"1"'});assert.equal(r.status,200,JSON.stringify(r.data));
    await f.x.h.pool.query("UPDATE tenants SET status='suspended',version=version+1 WHERE tenant_id=$1",[p.s.tenantId]);
    const view=await request(p.s,'GET',order);assert.equal(view.status,200);assert.equal(view.data.actions.cancel,false);assert.equal(view.data.actions.record_refund,false);
    assert.equal((await request(p.s,'POST',order+'/cancel',p.s.owner,{}, {'Idempotency-Key':randomUUID(),'If-Match':'"2"'})).status,403);
  });

  for(const first of ['cancel','notification'] as const)test(`seller cancel and signed notification serialize with ${first} committing first`,async()=>{
    const p=await f.placed(),a=await authenticate(f.x.runtime,p.s.owner.cookie.split('=')[1].split(';')[0]),trade=(await f.x.h.pool.query('SELECT merchant_trade_no FROM commerce_payment_attempts WHERE attempt_id=$1',[p.payment.attempt_ref])).rows[0].merchant_trade_no;
    const signed=encodeForm(signFields({MerchantID:'1234567',MerchantTradeNo:trade,TradeNo:'T'+randomBytes(8).toString('hex').toUpperCase(),RtnCode:'1',RtnMsg:'合成付款',TradeAmt:'5',SimulatePaid:'0',PaymentDate:'2026/10/15 10:20:30',PaymentType:'Credit_CreditCard'},EcpayKeyPair.of(p.provider.material.hash_key,p.provider.material.hash_iv),'sha256'));
    const notification=async()=>{const r=await f.app.fetch(new Request(f.origin+'/api/v1/provider-callbacks/ecpay/'+p.provider.accountRef+'/payment',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:signed}));assert.equal(r.status,200);assert.equal(await r.text(),'1|OK');};
    const cancel=()=>cancelSellerCheckoutOrder(f.x.runtime,a,p.s.tenantId,p.s.instanceId,p.order.order_ref,randomUUID(),'1',{settings:f.settings,payment:f.runtime.commercePorts?.payment}).then(data=>({status:200,data}),error=>({status:error.status,data:{code:error.code}}));
    const signal=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>resolve=r);return {promise,resolve};},atCommit=signal(),competitor=signal(),releaseCommit=signal(),connect=f.x.runtime.connect;let paused=false;
    f.x.runtime.connect=(async()=>{
      const q=await (connect as ()=>Promise<PoolClient>).call(f.x.runtime),query=q.query,release=q.release;let target=false;
      q.query=(async(...args:unknown[])=>{
        const sql=String(args[0]);if(sql.startsWith(first==='cancel'?'INSERT INTO scoped_command_receipts':'INSERT INTO commerce_hosted_payment_events'))target=true;
        if(target&&args[0]==='COMMIT'){paused=true;atCommit.resolve();await releaseCommit.promise;}
        if(!target&&paused&&sql.startsWith('SELECT pg_advisory_xact_lock')&&String((args[1] as unknown[])?.[0]).startsWith('commerce-orders/'))competitor.resolve();
        return (query as Function).apply(q,args);
      }) as typeof q.query;
      q.release=(error?:Error|boolean)=>{q.query=query;q.release=release;release.call(q,error);};return q;
    }) as typeof f.x.runtime.connect;
    try{
      const leading=first==='cancel'?cancel():notification();await Promise.race([atCommit.promise,leading.then(()=>{throw Error('first command did not reach the commit barrier');})]);const following=first==='cancel'?notification():cancel();await Promise.race([competitor.promise,following.then(()=>{throw Error('competing command did not wait for the lock');})]);releaseCommit.resolve();
      const [lead,follow]=await Promise.all([leading,following]),cancelled=first==='cancel'?lead:follow;
      assert(cancelled);assert.equal(cancelled.status,first==='cancel'?200:409);if(first==='notification'){assert('code' in cancelled.data);assert.equal(cancelled.data.code,'payment_already_applied');}
      const applications=(await f.x.h.pool.query('SELECT outcome FROM commerce_checkout_payment_applications WHERE order_id=$1',[p.order.order_ref])).rows;assert.deepEqual(applications.map(r=>r.outcome),[first==='cancel'?'after_cancel':'converted']);
      const receipts=(await f.x.h.pool.query("SELECT response FROM scoped_command_receipts WHERE operation='commerce.checkout_order.cancel'")).rows;assert.equal(receipts.length,first==='cancel'?1:0);for(const r of receipts)assert.deepEqual(r.response,{id:p.order.order_ref});
    }finally{releaseCommit.resolve();f.x.runtime.connect=connect;}
  });

  test('seller payment summaries include simulated and pending without exposing contact data',async()=>{
    for(const state of ['simulated','pending'] as const){
      const p=await f.placed();
      if(state==='simulated')await f.x.tx(q=>applyConfirmedPayment(q,{orderId:p.order.order_ref,paymentRef:p.payment.attempt_ref,amountMinor:500,currency:'TWD',simulated:true}));
      else await f.x.h.pool.query(`INSERT INTO commerce_hosted_payment_events(tenant_id,instance_id,account_id,attempt_id,source,outcome) SELECT tenant_id,instance_id,account_id,attempt_id,'browser_return','returned' FROM commerce_payment_attempts WHERE attempt_id=$1`,[p.payment.attempt_ref]);
      const result=await request(p.s,'GET','/checkout-orders/'+p.order.order_ref);assert.equal(result.status,200,JSON.stringify(result.data));assert.equal(result.data.payment_state,state);
      assert(!JSON.stringify(result.data).includes('synthetic-buyer@example.test'));if(state==='simulated')assert.equal(result.data.payment_detail.applications[0].attempt_ref,null);
    }
  });

});
