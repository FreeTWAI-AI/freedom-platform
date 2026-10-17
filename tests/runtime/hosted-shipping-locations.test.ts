import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {after,before,beforeEach,describe,test} from 'node:test';
import {shippingSettingsHarness,type ShippingSettingsHarness,type ShippingTestStore,type Reply} from './module-registry-harness.js';
import {ShipFromLocationSchema,ShippingErrorSchema} from '../../contracts/guild-launchpad/v1/hosted-shipping.js';
import {SERVICE_KEYS} from '../../modules/agent-commerce/fulfilment/rules/types.js';

describe('shipping locations',()=>{
  let h:ShippingSettingsHarness;
  before(async()=>{h=await shippingSettingsHarness('fp_ship_locations');});beforeEach(async()=>h.reset());after(async()=>h?.stop());
  async function receipts(){for(const row of (await h.f.x.h.pool.query("SELECT response FROM scoped_command_receipts WHERE operation LIKE 'commerce.ship_from_location.%'")).rows){assert.deepEqual(Object.keys(row.response),['id']);assert.match(row.response.id,/^[0-9a-f-]{36}$/);}}
  async function create(s:ShippingTestStore,input:ReturnType<ShippingSettingsHarness['locationInput']>&{replaces_location_id?:string}=h.locationInput(),status=201,key=randomUUID()){
    const r=await h.request(s,'POST','/ship-from-locations',input,undefined,s.owner,key);assert.equal(r.status,status,JSON.stringify(r.data));await receipts();if(status===201)ShipFromLocationSchema.parse(r.data);return r;
  }
  async function retire(s:ShippingTestStore,id:string,status=200){const r=await h.request(s,'POST',`/ship-from-locations/${id}/retire`,{});assert.equal(r.status,status,JSON.stringify(r.data));await receipts();return r;}
  const sqlState=(expected:string)=>(e:unknown)=>(e as {code?:string}).code===expected;
  test('normalization, all recipient/label errors, aggregated paths and no retained PII outside location rows',async t=>{
    const s=await h.store(),input=h.locationInput(),logs:unknown[][]=[];
    for(const method of ['log','warn','error','info','debug'] as const)t.mock.method(console,method,(...args:unknown[])=>{logs.push(args);});
    const full=(s:string)=>s.replace(/[0-9]/g,ch=>String.fromCharCode(ch.charCodeAt(0)+0xfee0));
    const r=await create(s,{...input,label:' '+input.label+' ',mobile:full('+886'+input.mobile.slice(1)),postal_code:full(input.postal_code)});
    assert.equal(r.data.mobile,input.mobile);assert.equal(r.data.postal_code,input.postal_code);assert.equal(r.data.label,input.label);
    const cases:[string,string,string][]=[['sender_name',' ','required'],['sender_name','星','too_short'],['sender_name','星'.repeat(6),'too_long'],['sender_name','A1','format'],['sender_name','Echo','blocked_term'],['mobile',' ','required'],['mobile','123','format'],['postal_code',' ','required'],['postal_code','12','format'],['postal_code','000','unknown_postal_code'],['address',' ','required'],['address','星禾路','too_short'],['address','星'.repeat(61),'too_long'],['address','合成星禾路<一號','format'],['address','合成Echo路一百號','blocked_term'],['label',' ','required'],['label','倉'.repeat(41),'too_long'],['label','星\u0001禾','format'],['label','\t合成倉','format'],['label','星\u001f禾','format'],['label','星\u007f禾','format'],['address','合成星\u0001禾路一號','format'],['address','合成星\u001f禾路一號','format'],['address','合成星\u007f禾路一號','format'],['address','合成星\t禾路一號','format']];
    for(const [path,value,code] of cases){const e=await create(s,{...input,[path]:value},422);ShippingErrorSchema.parse(e.data);assert(e.data.fields.some((f:{path:string;code:string})=>f.path===path&&f.code===code),JSON.stringify(e.data));}
    const errors=await create(s,{...input,label:' ',sender_name:'X',mobile:'1',postal_code:'000',address:'短',ships:false,receives_returns:false},422);assert.equal(errors.data.fields.length,6);
    await retire(s,r.data.location_id);await receipts();
    const elsewhere=JSON.stringify({logs,events:(await h.f.x.h.pool.query('SELECT detail FROM commerce_control_events')).rows,journal:[...h.f.journal.objects.values()]});
    for(const value of [input.label,input.sender_name,input.mobile,input.address])assert.equal(elsewhere.includes(value),false);
    assert.equal((await h.f.x.h.pool.query("SELECT count(*)::int n FROM commerce_ship_from_locations WHERE instance_id=$1",[s.instanceId])).rows[0].n,1);
  });
  test('the platform JSON guard rejects raw NUL and lone surrogates in each sender text field before location or profile writes',async()=>{
    const s=await h.store(),input=h.locationInput(),results:{path:string;character:string;status:number;code:string}[]=[];
    const counts=async()=> (await h.f.x.h.pool.query(`SELECT
      (SELECT count(*)::int FROM commerce_ship_from_locations WHERE instance_id=$1) AS locations,
      (SELECT count(*)::int FROM commerce_shipping_profile_versions WHERE instance_id=$1) AS profiles`,[s.instanceId])).rows[0];
    const before=await counts();assert.deepEqual(before,{locations:0,profiles:0});
    for(const path of ['label','sender_name','address'])for(const invalid of ['\u0000','\ud800']){
      const rejected=await h.request(s,'POST','/ship-from-locations',{...input,[path]:input[path as keyof typeof input]+invalid});
      await receipts();results.push({path,character:invalid==='\u0000'?'NUL':'lone surrogate',status:rejected.status,code:rejected.data.code});
      assert.deepEqual(await counts(),before,`raw command rejection changed rows for ${path}`);
    }
    assert.deepEqual(results,results.map(({path,character})=>({path,character,status:422,code:'validation_failed'})));
  });
  test('twenty-row limit permits replacement; replay reprojects retirement and rejects changed bodies',async()=>{
    const s=await h.store(),input=h.locationInput(),key=randomUUID(),first=(await create(s,input,201,key)).data;
    for(let i=1;i<20;i++)await create(s);assert.equal((await create(s,h.locationInput(),409)).data.code,'ship_from_location_limit');
    const replaced=(await create(s,{...h.locationInput(),replaces_location_id:first.location_id})).data;
    const replay=await create(s,input,201,key);assert(replay.data.retired_at);assert.equal(replay.data.in_use,false);
    assert.equal((await create(s,{...input,label:'合成另一倉'},409,key)).data.code,'idempotency_conflict');
    assert.equal((await create(s,{...h.locationInput(),replaces_location_id:first.location_id},409)).data.code,'ship_from_location_retired');
    assert.equal((await retire(s,first.location_id,409)).data.code,'ship_from_location_retired');await retire(s,replaced.location_id);
    assert.equal(h.expect(await h.request(s,'GET','/ship-from-locations')).items.length,19);
  });
  test('replacement substitutes every current profile reference once and rejects lost roles atomically',async()=>{
    const s=await h.store();await h.provider(s,[SERVICE_KEYS[0],SERVICE_KEYS[2]],true);
    const old=(await create(s)).data,profile=h.document();
    profile.services=[SERVICE_KEYS[0],SERVICE_KEYS[2]].map(service_key=>({service_key,ship_from_location_id:old.location_id,temperature:'ambient',handling_days:1,cutoff_time:'12:00',limits:{max_weight_g:1000,max_longest_side_mm:1000,max_dimension_sum_mm:3000},outlying_islands:'excluded'}));
    profile.drop_ship={offered:true,fees:[{service_key:SERVICE_KEYS[0],fee_per_parcel_minor:100}],return_location_id:old.location_id,liability:'合成責任條款',recipient_retention_days:1,accept_within_hours:1};
    h.expect(await h.request(s,'PUT','/shipping-profile',profile),201);
    const count=async()=>(await h.f.x.h.pool.query('SELECT count(*)::int n FROM commerce_ship_from_locations')).rows[0].n;
    for(const role of ['ships','receives_returns']){const r=await create(s,{...h.locationInput(),[role]:false,replaces_location_id:old.location_id},409);assert.equal(r.data.code,'ship_from_location_role_required');assert.equal(r.data.fields.length,role==='ships'?2:1);assert.equal(await count(),1);}
    const denied=await retire(s,old.location_id,409);assert.equal(denied.data.code,'ship_from_location_in_use');assert.equal(denied.data.fields.length,3);
    const replacement=(await create(s,{...h.locationInput(),replaces_location_id:old.location_id})).data;
    const current=h.expect(await h.request(s,'GET','/shipping-profile'));assert.equal(current.version,'2');for(const service of current.profile.services)assert.equal(service.ship_from_location_id,replacement.location_id);assert.equal(current.profile.drop_ship.return_location_id,replacement.location_id);assert(replacement.in_use);
    assert.equal((await h.f.x.h.pool.query('SELECT count(*)::int n FROM commerce_shipping_profile_versions')).rows[0].n,2);
    assert.equal(h.expect(await h.request(s,'GET',`/ship-from-locations/${old.location_id}`)).in_use,false);
  });
  test('append-only retirement and same-store replacement guards hold at SQL and tenant RLS boundaries',async()=>{
    const a=await h.store(),b=await h.store(),row=(await create(a)).data;
    await assert.rejects(h.f.x.h.pool.query('DELETE FROM commerce_ship_from_locations WHERE location_id=$1',[row.location_id]),sqlState('23514'));
    await assert.rejects(h.f.x.h.pool.query("UPDATE commerce_ship_from_locations SET label='改' WHERE location_id=$1",[row.location_id]),sqlState('23514'));
    const input=h.locationInput();await assert.rejects(h.f.x.h.pool.query(`INSERT INTO commerce_ship_from_locations(tenant_id,instance_id,label,sender_name,mobile,postal_code,address,ships,receives_returns,replaces_location_id,created_by_principal_id)
      SELECT $1,$2,$3,$4,$5,$6,$7,true,true,$8,principal_id FROM principals WHERE user_ref=$9`,[b.tenantId,b.instanceId,input.label,input.sender_name,input.mobile,input.postal_code,input.address,row.location_id,b.owner.user.user_id]),sqlState('23514'));
    assert.equal((await h.request(b,'GET',`/ship-from-locations/${row.location_id}`)).status,404);
    await h.f.x.tx(async q=>{const {bindStore}=await import('../../modules/agent-commerce/checkout/authority.js');await bindStore(q,b.tenantId);assert.equal((await q.query('SELECT * FROM commerce_ship_from_locations WHERE location_id=$1',[row.location_id])).rowCount,0);});
    await retire(a,row.location_id);await assert.rejects(h.f.x.h.pool.query('UPDATE commerce_ship_from_locations SET retired_at=clock_timestamp() WHERE location_id=$1',[row.location_id]),sqlState('23514'));
  });
  test('location capabilities remain independent, revoke immediately, and unavailable stores reject writes',async()=>{
    const s=await h.store(),location=(await create(s)).data;
    for(const [caps,role,read,write] of [[[],'admin',200,201],[['store:read'],'operator',403,403],[['store:fulfil'],'operator',200,403],[['store:manage'],'operator',200,201]] as const){
      const m=await h.member(s,caps,role);for(const path of ['/ship-from-locations',`/ship-from-locations/${location.location_id}`])assert.equal((await h.request(s,'GET',path,undefined,undefined,m.session)).status,read);
      const r=await h.request(s,'POST','/ship-from-locations',h.locationInput(),undefined,m.session);assert.equal(r.status,write,JSON.stringify(r.data));await receipts();
    }
    const m=await h.member(s,['store:manage']);assert.equal((await h.request(s,'GET','/ship-from-locations',undefined,undefined,m.session)).status,200);
    await h.f.x.h.pool.query("UPDATE tenant_module_permissions SET status='revoked',revoked_at=clock_timestamp(),updated_at=clock_timestamp(),version=version+1 WHERE principal_id=$1",[m.principal]);assert.equal((await h.request(s,'GET','/ship-from-locations',undefined,undefined,m.session)).status,404);
    const outsider=(await h.f.x.h.person('合成外部'+randomUUID())).session;assert.equal((await h.request(s,'GET',`/ship-from-locations/${location.location_id}`,undefined,undefined,outsider)).status,404);
    h.f.settings.quarantine=true;assert.equal((await create(s,h.locationInput(),503)).data.code,'commerce_quarantined');h.f.settings.quarantine=false;
    for(const status of ['suspended','archived']){await h.f.x.h.pool.query('UPDATE module_instances SET status=$2,version=version+1 WHERE instance_id=$1',[s.instanceId,status]);if(status==='archived')assert.equal((await h.request(s,'GET','/ship-from-locations')).status,404);const r=await h.request(s,'POST','/ship-from-locations',h.locationInput());assert.equal(r.status,409);assert.equal(r.data.code,'storefront_unavailable');await receipts();}
  });
  test('a replacement store in the same tenant cannot read or replace historical locations or item attributes',async()=>{
    const old=await h.store(),row=(await create(old)).data;
    h.expect(await h.request(old,'PUT',`/products/${old.product.product_id}/shipping-attributes`,h.attributes()),201);
    await h.f.x.h.pool.query("UPDATE module_instances SET status='archived',version=version+1 WHERE instance_id=$1",[old.instanceId]);
    const workspace=await h.f.x.h.workspace(old.owner,old.tenantId,'合成新櫃檯'+randomUUID().slice(0,8));
    const plan=await h.f.x.h.plan(old.owner,old.tenantId,h.f.x.h.planBody('guild_commerce_sales',workspace,'hosted-store','hosted-store@1.0.0'));h.expect(plan,201);assert.equal((await h.f.x.h.launch(old.owner,old.tenantId,plan)).data.state,'succeeded');
    const id=(await h.f.x.h.pool.query("SELECT instance_id FROM module_instances WHERE tenant_id=$1 AND status='active'",[old.tenantId])).rows[0].instance_id;
    const next={...old,instanceId:id,root:`/tenants/${old.tenantId}/storefronts/${id}`};
    h.expect(await h.request(next,'POST','/setup',{name:'合成新商店'+randomUUID().slice(0,8),slug:'s-'+randomUUID().slice(0,12),currency:'TWD'}),201);
    const version=(await h.f.x.h.pool.query('SELECT version::text FROM module_instances WHERE instance_id=$1',[id])).rows[0].version;h.expect(await h.request(next,'POST','/upgrade',{},version));
    assert.equal((await h.request(next,'GET',`/ship-from-locations/${row.location_id}`)).status,404);
    assert.equal((await create(next,{...h.locationInput(),replaces_location_id:row.location_id},404)).data.code,'ship_from_location_not_found');
    assert.equal((await h.request(next,'GET',`/products/${old.product.product_id}/shipping-attributes`)).status,404);
    assert.equal(h.expect(await h.request(next,'GET','/shipping-profile')).profile,null);
  });

});
