import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {after,before,beforeEach,describe,test} from 'node:test';
import {shippingSettingsHarness,type ShippingSettingsHarness,type ShippingTestStore} from './module-registry-harness.js';
import {SERVICE_KEYS} from '../../modules/agent-commerce/fulfilment/rules/types.js';
import {canonicalJSON} from '../../modules/agent-commerce/checkout/terms.js';
import {ShippingProfileViewSchema} from '../../contracts/guild-launchpad/v1/hosted-shipping.js';

describe('shipping profile versions',()=>{
  let h:ShippingSettingsHarness;
  before(async()=>{h=await shippingSettingsHarness('fp_ship_profile');});beforeEach(async()=>h.reset());after(async()=>h?.stop());
  const service=(location:string,key=SERVICE_KEYS[0] as typeof SERVICE_KEYS[number])=>({service_key:key,ship_from_location_id:location,temperature:'ambient' as const,handling_days:1,cutoff_time:'17:00',limits:{max_weight_g:1000,max_longest_side_mm:1000,max_dimension_sum_mm:3000},outlying_islands:'excluded' as 'allowed'|'excluded'});
  async function location(s:ShippingTestStore,extra={}){return h.expect(await h.request(s,'POST','/ship-from-locations',{...h.locationInput(),...extra}),201).location_id as string;}
  test('first save, CAS, canonical hashing, replay and contiguous append-only versions',async()=>{
    const s=await h.store(),input={...h.document(),working_days:[5,1,3]},key=randomUUID();
    let r=await h.request(s,'GET','/shipping-profile');assert.equal(r.status,200);assert.equal(r.data.version,null);assert.equal(r.response.headers.get('ETag'),null);ShippingProfileViewSchema.parse(r.data);
    assert.equal((await h.request(s,'PUT','/shipping-profile',input,'1')).status,412);
    r=await h.request(s,'PUT','/shipping-profile',input,undefined,s.owner,key);assert.equal(r.status,201);assert.equal(r.data.version,'1');assert.equal(r.response.headers.get('ETag'),'"1"');assert.deepEqual(r.data.profile.working_days,[1,3,5]);
    assert.equal((await h.request(s,'PUT','/shipping-profile',input)).status,428);assert.equal((await h.request(s,'PUT','/shipping-profile',input,'2')).status,412);
    r=await h.request(s,'PUT','/shipping-profile',input,'1');assert.equal(r.status,200);assert.equal(r.data.version,'2');assert.equal(r.response.headers.get('ETag'),'"2"');
    const replay=await h.request(s,'PUT','/shipping-profile',input,undefined,s.owner,key);assert.equal(replay.data.version,'2');
    const rows=(await h.f.x.h.pool.query('SELECT * FROM commerce_shipping_profile_versions ORDER BY version')).rows;assert.deepEqual(rows.map(r=>r.version),[1,2]);for(const row of rows)assert.equal(row.document_sha256,createHash('sha256').update(canonicalJSON(row.document)).digest('hex'));
    for(const query of ['UPDATE commerce_shipping_profile_versions SET document=document','DELETE FROM commerce_shipping_profile_versions'])await assert.rejects(h.f.x.h.pool.query(query),(e:unknown)=>(e as {code?:string}).code==='23514');
    await assert.rejects(h.f.x.h.pool.query(`INSERT INTO commerce_shipping_profile_versions SELECT tenant_id,instance_id,4,document,document_sha256,created_by_principal_id,clock_timestamp() FROM commerce_shipping_profile_versions WHERE version=2`),(e:unknown)=>(e as {code?:string}).code==='23514');
    for(const row of (await h.f.x.h.pool.query("SELECT response FROM scoped_command_receipts WHERE operation='commerce.shipping_profile.save'")).rows)assert.deepEqual(Object.keys(row.response),['id']);
  });
  test('duplicate/post/drop-ship checks collect every invalid path without a write',async()=>{
    const s=await h.store(),id=await location(s),input=h.document();input.working_days=[1,1];input.services=[service(id,SERVICE_KEYS[1]),service(id,SERVICE_KEYS[1])];input.services[0].outlying_islands='allowed';input.delivery_options=[{method:'home',fee_per_parcel_minor:100,free_over_minor:null,outlying:{kind:'excluded'}},{method:'home',fee_per_parcel_minor:100,free_over_minor:null,outlying:{kind:'excluded'}}];
    input.drop_ship={offered:true,fees:[{service_key:SERVICE_KEYS[0],fee_per_parcel_minor:100},{service_key:SERVICE_KEYS[0],fee_per_parcel_minor:100}],return_location_id:id,liability:'合成責任',recipient_retention_days:1,accept_within_hours:1};
    let r=await h.request(s,'PUT','/shipping-profile',input);assert.equal(r.status,422);for(const code of ['duplicate','post_mainland_only','not_in_services'])assert(r.data.fields.some((f:{code:string})=>f.code===code));assert(r.data.fields.some((f:{path:string})=>f.path==='drop_ship.fees.1.service_key'));
    input.drop_ship.fees=[];r=await h.request(s,'PUT','/shipping-profile',input);assert(r.data.fields.some((f:{code:string})=>f.code==='fees_required'));assert.equal((await h.f.x.h.pool.query('SELECT count(*)::int n FROM commerce_shipping_profile_versions')).rows[0].n,0);
  });
  test('location reference checks distinguish missing, retired and missing roles with all paths',async()=>{
    const s=await h.store(),other=await h.store(),id=await location(other),retired=await location(s),returnOnly=await location(s,{ships:false});h.expect(await h.request(s,'POST',`/ship-from-locations/${retired}/retire`,{}));
    const input=h.document();input.services=[service(id),service(retired,SERVICE_KEYS[1]),service(returnOnly,SERVICE_KEYS[2])];
    const r=await h.request(s,'PUT','/shipping-profile',input);assert.equal(r.status,409);assert.equal(r.data.code,'ship_from_location_unavailable');assert.deepEqual(r.data.fields.map((f:{code:string})=>f.code),['not_found','retired','role_required']);assert.equal((await h.f.x.h.pool.query('SELECT count(*)::int n FROM commerce_shipping_profile_versions')).rows[0].n,0);
  });
  test('only activated retained sub-types in the route environment may be configured, including suspended services',async()=>{
    const s=await h.store(),id=await location(s),input=h.document();input.services=[service(id)];
    let r=await h.request(s,'PUT','/shipping-profile',input);assert.equal(r.data.code,'logistics_service_unavailable');assert.equal(r.data.fields[0].code,'not_activated');
    const draft=await h.provider(s,[SERVICE_KEYS[0]]);r=await h.request(s,'PUT','/shipping-profile',input);assert.equal(r.status,409);
    assert.equal(h.expect(await h.request(s,'GET','/shipping-profile')).logistics[0].state,'draft');
    const active=await h.provider(s,[SERVICE_KEYS[0]],true);r=await h.request(s,'PUT','/shipping-profile',input);h.expect(r,201);
    let a=h.expect(await h.request(s,'GET','/provider-accounts')).items.find((a:{account_id:string})=>a.account_id===active.account_id);
    a=h.expect(await h.request(s,'POST',`/provider-accounts/${a.account_id}/logistics-services/${SERVICE_KEYS[0]}/suspend`,{fresh_auth_verification_id:await h.fresh(s)},a.version));
    assert.equal(h.expect(await h.request(s,'GET','/shipping-profile')).logistics[0].state,'suspended');h.expect(await h.request(s,'PUT','/shipping-profile',input,'1'));
    a=h.expect(await h.request(s,'POST',`/provider-accounts/${a.account_id}/logistics-services/${SERVICE_KEYS[0]}/resume`,{fresh_auth_verification_id:await h.fresh(s)},a.version));
    a=h.expect(await h.request(s,'POST',`/provider-accounts/${a.account_id}/services/logistics/suspend`,{fresh_auth_verification_id:await h.fresh(s)},a.version));
    assert.equal(h.expect(await h.request(s,'GET','/shipping-profile')).logistics[0].state,'suspended');h.expect(await h.request(s,'PUT','/shipping-profile',input,'2'));
    a=h.expect(await h.request(s,'POST',`/provider-accounts/${a.account_id}/services/logistics/retire`,{fresh_auth_verification_id:await h.fresh(s)},a.version));
    assert.equal((await h.request(s,'PUT','/shipping-profile',input,'3')).status,409);
    h.f.install({commerceProviderEnvironment:'live'});assert.equal((await h.request(s,'PUT','/shipping-profile',input,'3')).status,409);assert.equal(h.expect(await h.request(s,'GET','/shipping-profile')).logistics[0].state,'not_configured');
    assert.equal(draft.logistics_services[0].state,'draft');
  });
  test('retired sub-types cannot be configured under an active purpose, and replacement drafts need activation',async()=>{
    const s=await h.store(),id=await location(s),input=h.document();input.services=[service(id)];
    let account=await h.provider(s,[SERVICE_KEYS[0]],true);
    account=h.expect(await h.request(s,'POST',`/provider-accounts/${account.account_id}/logistics-services/${SERVICE_KEYS[0]}/retire`,{fresh_auth_verification_id:await h.fresh(s)},account.version));
    assert.equal(account.services.find((row:{purpose:string})=>row.purpose==='logistics').state,'active');
    assert.equal(h.expect(await h.request(s,'GET','/shipping-profile')).logistics[0].state,'not_configured');
    const denied=await h.request(s,'PUT','/shipping-profile',input);assert.equal(denied.status,409);assert.equal(denied.data.code,'logistics_service_unavailable');assert.deepEqual(denied.data.fields,[{path:'services.0.service_key',code:'not_activated'}]);
    h.expect(await h.request(s,'POST',`/provider-accounts/${account.account_id}/logistics-services`,{service_key:SERVICE_KEYS[0],fresh_auth_verification_id:await h.fresh(s)},account.version),201);
    assert.equal(h.expect(await h.request(s,'GET','/shipping-profile')).logistics[0].state,'draft');
    assert.equal((await h.request(s,'PUT','/shipping-profile',input)).status,409);
    assert.equal((await h.f.x.h.pool.query('SELECT count(*)::int n FROM commerce_shipping_profile_versions')).rows[0].n,0);
  });
  test('meetup saves alone or mixed, and rejects bad notes, a duplicate and a sixth option',async()=>{
    const s=await h.store(),meetup={method:'meetup' as const,note:'面交於店門口'};
    const home={method:'home' as const,fee_per_parcel_minor:10000,free_over_minor:null,outlying:{kind:'excluded' as const}};
    const only={...h.document(),services:[],delivery_options:[meetup]};
    let r=await h.request(s,'PUT','/shipping-profile',only);assert.equal(r.status,201);assert.equal(r.data.version,'1');assert.deepEqual(r.data.profile.delivery_options,[meetup]);assert.deepEqual(r.data.profile.services,[]);
    assert.deepEqual(h.expect(await h.request(s,'GET','/shipping-profile')).profile.delivery_options,[meetup]);
    for(const note of ['',' ','a'.repeat(201),'😀'.repeat(201),'有\t字','有\u000B字']){
      const bad=await h.request(s,'PUT','/shipping-profile',{...only,delivery_options:[{method:'meetup',note}]},'1');
      assert.equal(bad.status,422,JSON.stringify(note));assert.equal(bad.data.code,'validation_failed');
    }
    r=await h.request(s,'PUT','/shipping-profile',{...only,delivery_options:[{method:'meetup',note:'面'.repeat(200)}]},'1');assert.equal(r.status,200);assert.equal(r.data.profile.delivery_options[0].note,'面'.repeat(200));
    r=await h.request(s,'PUT','/shipping-profile',{...only,delivery_options:[{method:'meetup',note:'  面交於店門口  '}]},'2');assert.equal(r.status,200);assert.equal(r.data.profile.delivery_options[0].note,'面交於店門口');
    r=await h.request(s,'PUT','/shipping-profile',{...only,delivery_options:[{method:'meetup',note:'第一行\n第二行'}]},'3');assert.equal(r.status,200);assert.equal(r.data.profile.delivery_options[0].note,'第一行\n第二行');
    const dup=await h.request(s,'PUT','/shipping-profile',{...only,delivery_options:[meetup,{method:'meetup',note:'另一處面交'}]},'4');
    assert.equal(dup.status,422);assert.equal(dup.data.code,'shipping_input_invalid');assert(dup.data.fields.some((f:{path:string;code:string})=>f.path==='delivery_options.1.method'&&f.code==='duplicate'));
    const methods=['home','cvs:UNIMARTC2C','cvs:FAMIC2C','cvs:HILIFEC2C'] as const;
    const five={...h.document(),services:[],delivery_options:[...methods.map(method=>({method,fee_per_parcel_minor:10000,free_over_minor:null,outlying:{kind:'excluded'}})),meetup]};
    r=await h.request(s,'PUT','/shipping-profile',five,'4');assert.equal(r.status,200);assert.equal(r.data.profile.delivery_options.length,5);
    const sixth=await h.request(s,'PUT','/shipping-profile',{...five,delivery_options:[...five.delivery_options,home]},'5');assert.equal(sixth.status,422);assert.equal(sixth.data.code,'validation_failed');
    const id=await location(s);await h.provider(s,[SERVICE_KEYS[0]],true);
    const mixed={...h.document(),services:[service(id)],delivery_options:[home,meetup]};
    r=await h.request(s,'PUT','/shipping-profile',mixed,'5');assert.equal(r.status,200);assert.deepEqual(r.data.profile.delivery_options.map((o:{method:string})=>o.method),['home','meetup']);assert.equal(r.data.profile.services.length,1);
    assert.equal((await h.f.x.h.pool.query('SELECT count(*)::int n FROM commerce_shipping_profile_versions')).rows[0].n,6);
  });
  test('capabilities, revocation, archived reads, unavailable writes and console flag gate the profile',async()=>{
    const s=await h.store();
    for(const [caps,role,read,write] of [[[],'admin',200,201],[['store:read'],'operator',403,403],[['store:fulfil'],'operator',200,403],[['store:manage'],'operator',200,200]] as const){const m=await h.member(s,caps,role);assert.equal((await h.request(s,'GET','/shipping-profile',undefined,undefined,m.session)).status,read);assert.equal((await h.request(s,'PUT','/shipping-profile',h.document(),write===200?'1':undefined,m.session)).status,write);}
    const granted=await h.member(s,['store:manage']);assert.equal((await h.request(s,'GET','/shipping-profile',undefined,undefined,granted.session)).status,200);
    await h.f.x.h.pool.query("UPDATE tenant_module_permissions SET status='revoked',revoked_at=clock_timestamp(),updated_at=clock_timestamp(),version=version+1 WHERE principal_id=$1",[granted.principal]);assert.equal((await h.request(s,'GET','/shipping-profile',undefined,undefined,granted.session)).status,404);
    const outsider=(await h.f.x.h.person('合成外部'+randomUUID())).session;assert.equal((await h.request(s,'GET','/shipping-profile',undefined,undefined,outsider)).status,404);
    h.f.settings.consoleEnabled=false;h.f.install();assert.equal((await h.request(s,'GET','/shipping-profile')).status,404);h.f.settings.consoleEnabled=true;h.f.install();
    await h.f.x.h.pool.query("UPDATE module_instances SET status='archived',version=version+1 WHERE instance_id=$1",[s.instanceId]);assert.equal((await h.request(s,'GET','/shipping-profile')).status,404);assert.equal((await h.request(s,'PUT','/shipping-profile',h.document(),'2')).status,409);
  });
});
