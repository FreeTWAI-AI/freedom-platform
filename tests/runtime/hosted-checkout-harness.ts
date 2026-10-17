import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Pool,type PoolClient} from 'pg';
import {createApp} from '../../apps/platform-api/src/app.js';
import {TENANT_CURSOR_TEST_KEY} from './tenant-cursor-fixture.js';
import {isolatedTransaction} from '../../packages/resource-scopes/tenant-transaction.js';
import {DEMO_COMMUNITY} from '../../packages/testing/seed.js';
import {createRegistryHarness,type RegistryHarness,type Session,type Reply} from './module-registry-harness.js';
import {freezeCheckout,placeCheckoutOrder,cancelUnpaidOrder,type CheckoutPorts,type CheckoutInput} from '../../modules/agent-commerce/checkout/index.js';
import {syntheticShippingPort} from '../../scripts/synthetic-shipping-quote.js';
export const ok=(r:Reply,status=200)=>{assert.equal(r.status,status,JSON.stringify(r.data));return r.data;};
export const code=(expected:string)=>(e:unknown)=>(e as {code?:string}).code===expected;
/** Quote-only synthetic port. Supplied lines are drop_ship with a fake agreement so consent tests can freeze; production still rejects them. */
export const ports:CheckoutPorts={admission:{allowed:()=>true},shipping:syntheticShippingPort()};
export async function checkoutHarness(prefix:string,options:{publicSchema?:boolean;randomContact?:boolean}={}) {
  const url=process.env.TEST_DATABASE_URL;assert.ok(url&&/^\/fp_[a-z0-9_]+$/.test(new URL(url).pathname),'Explicit disposable fp_* TEST_DATABASE_URL required');
  const h=await createRegistryHarness(prefix,options),role=`${prefix}_runtime_${process.pid}_${Date.now()}`;
  await h.admin.query(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
    GRANT USAGE ON SCHEMA ${h.schema} TO ${role}; GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA ${h.schema} TO ${role};
    GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA ${h.schema} TO ${role}; GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ${h.schema} TO ${role}`);
  const runtimeUrl=new URL(url);runtimeUrl.username=role;runtimeUrl.password='';
  const runtime=new Pool({connectionString:runtimeUrl.toString(),options:`-c search_path=${h.schema} -c statement_timeout=20000`,max:12});
  const app=createApp(runtime,h.origin,'local',{guildLaunchpadEnabled:true,hostedReservationsEnabled:true,tenantCursorSigningKey:TENANT_CURSOR_TEST_KEY});
  const tx=<T>(run:(q:PoolClient)=>Promise<T>)=>isolatedTransaction(runtime,run);
  const send=(s:{root:string;owner:Session},path:string,body:unknown={},version?:string,method='POST')=>h.call(method,s.root+path,s.owner,body,{'Idempotency-Key':randomUUID(),...(version?{'If-Match':`"${version}"`}:{})},app);
  async function reset(){await h.reset();await h.pool.query(`INSERT INTO guild_application_offerings(offering_id,community_id,guild_key,application_key,release_ref,status,display_order,launch_policy_ref,version)
    VALUES($1,$2,'guild_commerce_sales','hosted-store','hosted-store@1.0.0','offered',10,'{"policy_key":"hosted-store.launch","version":"1"}',1)`,[randomUUID(),DEMO_COMMUNITY]);}
  async function store(stock=10,withProduct=true){
    const owner=(await h.person('合成賣家')).session;await h.fullMember(owner.user.user_id,'guild_commerce_sales');const t=await h.createTenant(owner,'合成商店');
    const plan=await h.plan(owner,t.tenantId,h.planBody('guild_commerce_sales',t.workspaceId,'hosted-store','hosted-store@1.0.0'));ok(plan,201);assert.equal((await h.launch(owner,t.tenantId,plan)).data.state,'succeeded');
    const instanceId=(await h.pool.query("SELECT instance_id FROM module_instances WHERE tenant_id=$1 AND module_key='storefront'",[t.tenantId])).rows[0].instance_id as string;
    const root=`/tenants/${t.tenantId}/storefronts/${instanceId}`,slug=`s-${randomUUID().slice(0,12)}`,s={...t,owner,instanceId,root,slug};
    ok(await send(s,'/setup',{name:'合成商店',slug,currency:'TWD'}),201);
    const product=withProduct?ok(await send(s,'/products',{title:'合成商品',price_minor:100,stock}),201):null;
    const p=(await h.pool.query('SELECT * FROM commerce_storefront_profiles WHERE instance_id=$1',[instanceId])).rows[0] as {storefront_shop_id:string;supply_shop_id:string};
    await h.pool.query('UPDATE commerce_storefront_profiles SET reservation_enabled=true WHERE instance_id=$1',[instanceId]);
    if(withProduct)await publish(s);return {...s,...p,product};
  }
  async function publish(s:{root:string;owner:Session}){const current=ok(await h.call('GET',s.root,s.owner,undefined,{},app));return ok(await send(s,'/publish',{},current.version));}
  const contact=options.randomContact?{name:'合成買家-'+randomUUID(),email:'synthetic-'+randomUUID()+'@example.test',phone:'000'+randomUUID().replaceAll('-','').slice(0,7)}:{name:'合成買家',email:'synthetic-buyer@example.test',phone:'0000000000'};
  const address=options.randomContact?'合成測試地址-'+randomUUID():'合成測試地址';
  const input=(sku:string,quantity=5):CheckoutInput=>({publication_revision:'1',lines:[{sku,quantity}],contact:{...contact},delivery:{method:'synthetic',address},invoice:null,consents:[]});
  async function frozen(s:Awaited<ReturnType<typeof store>>,quantity=5,extra:Partial<CheckoutInput>={}){return tx(q=>freezeCheckout(q,s,{...input(s.product.sku,quantity),...extra,idempotencyKey:randomUUID()},ports));}
  const place=(s:Awaited<ReturnType<typeof store>>,c:Awaited<ReturnType<typeof frozen>>,clientOrderId=randomUUID(),buyerPrincipalId:string|null=null)=>tx(q=>placeCheckoutOrder(q,s,{checkoutId:c.checkout_id,termsSha256:c.terms_sha256,clientOrderId,buyerPrincipalId,environment:'sandbox'},ports));
  async function due(s:Awaited<ReturnType<typeof store>>,quantity=5){
    const c=await frozen(s,quantity),original=await place(s,c);await tx(q=>cancelUnpaidOrder(q,s,original.order_id,'buyer','buyer_cancelled'));
    const id=randomUUID(),client=randomUUID();
    await isolatedTransaction(h.pool,async q=>{
      await q.query(`INSERT INTO commerce_orders(order_id,public_shop_id,external_id,request_sha256,currency,total_minor,created_at,expires_at,order_profile,buyer_principal_id,client_order_id)
        SELECT $2,public_shop_id,'chk:'||$3::text||':'||$4::text,request_sha256,currency,total_minor,t,t+interval '30 minutes','hosted_checkout',NULL,$4::uuid
        FROM commerce_orders CROSS JOIN (SELECT date_trunc('milliseconds',clock_timestamp())-interval '31 minutes' t) n WHERE order_id=$1`,[original.order_id,id,c.checkout_id,client]);
      await q.query(`INSERT INTO commerce_checkout_orders(order_id,tenant_id,instance_id,checkout_id,customer_id,contact_id,display_number,terms,terms_sha256,environment)
        SELECT $2,co.tenant_id,co.instance_id,co.checkout_id,co.customer_id,co.contact_id,to_char(o.created_at AT TIME ZONE 'Asia/Taipei','YYMMDD')||'-'||upper(substr(replace($2::text,'-',''),1,6)),co.terms,co.terms_sha256,co.environment
        FROM commerce_checkout_orders co JOIN commerce_orders o ON o.order_id=$2 WHERE co.order_id=$1`,[original.order_id,id]);
      await q.query(`INSERT INTO commerce_order_lines(order_id,selection_id,item_id,quantity,snapshot,order_profile,supplier_shop_id,hosted_offer_id,acceptance_id,listing_sha256)
        SELECT $2,selection_id,item_id,quantity,snapshot,order_profile,supplier_shop_id,hosted_offer_id,acceptance_id,listing_sha256 FROM commerce_order_lines WHERE order_id=$1`,[original.order_id,id]);
      await q.query(`INSERT INTO commerce_inventory_reservations(order_id,item_id,supplier_shop_id,quantity,state,created_at,expires_at)
        SELECT o.order_id,l.item_id,l.supplier_shop_id,l.quantity,'held',o.created_at,o.expires_at FROM commerce_orders o JOIN commerce_order_lines l USING(order_id) WHERE o.order_id=$1`,[id]);
      await q.query('UPDATE commerce_items SET reserved=reserved+$2 WHERE item_id=$1',[s.product.product_id,quantity]);
    });return {order_id:id,checkout:c};
  }
  async function stop(){await runtime.end();await h.stop();await h.admin.end().catch(()=>{});const admin=new Pool({connectionString:url});try{await admin.query(`DROP ROLE ${role}`);}finally{await admin.end();}}
  return {h,runtime,app,tx,send,reset,store,publish,input,frozen,place,due,stop};
}
export type CheckoutHarness=Awaited<ReturnType<typeof checkoutHarness>>;
