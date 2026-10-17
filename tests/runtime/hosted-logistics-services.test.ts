import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {after,before,beforeEach,describe,test} from 'node:test';
import {shippingSettingsHarness,type ShippingSettingsHarness,type ShippingTestStore} from './module-registry-harness.js';
import {SERVICE_KEYS} from '../../modules/agent-commerce/fulfilment/rules/types.js';
import {activateLogisticsService} from '../../modules/agent-commerce/payments/logistics-services.js';
import {activateProviderService} from '../../modules/agent-commerce/payments/accounts.js';
import {logisticsAvailability,resolveLogisticsService} from '../../modules/agent-commerce/fulfilment/settings/logistics.js';
import {bindStore} from '../../modules/agent-commerce/checkout/authority.js';
import {flushControlEvents} from '../../modules/agent-commerce/operations/journal/journal.js';
import {ProviderAccountViewSchema} from '../../contracts/guild-launchpad/v1/hosted-commerce-setup.js';

describe('logistics sub-types',()=>{
  let h:ShippingSettingsHarness;
  before(async()=>{h=await shippingSettingsHarness('fp_logistics');});beforeEach(async()=>h.reset());after(async()=>h?.stop());
  const code=(expected:string)=>(error:unknown)=>(error as {code?:string}).code===expected;
  const path=(id:string,key=SERVICE_KEYS[0] as typeof SERVICE_KEYS[number])=>`/provider-accounts/${id}/logistics-services/${key}`;
  const account=async(s:ShippingTestStore,id:string)=>h.expect(await h.request(s,'GET','/provider-accounts')).items.find((a:{account_id:string})=>a.account_id===id);
  async function activate(s:ShippingTestStore,id:string,key=SERVICE_KEYS[0] as typeof SERVICE_KEYS[number],ref=randomUUID()){await h.f.x.tx(async q=>{await bindStore(q,s.tenantId);await activateLogisticsService(q,{accountId:id,serviceKey:key,activationRef:ref});});return account(s,id);}
  async function state(s:ShippingTestStore,a:{account_id:string;version:string},action:string,key=SERVICE_KEYS[0] as typeof SERVICE_KEYS[number]){return h.request(s,'POST',path(a.account_id,key)+'/'+action,{fresh_auth_verification_id:await h.fresh(s)},a.version);}
  test('create requires credentials, account CAS, one-use fresh verification and owner/admin authority',async()=>{
    const s=await h.store(),a=await h.provider(s,[],false,false),body={service_key:SERVICE_KEYS[0],fresh_auth_verification_id:await h.fresh(s)},p=`/provider-accounts/${a.account_id}/logistics-services`;
    let r=await h.request(s,'POST',p,body,a.version);assert.equal(r.status,409);assert.equal(r.data.code,'logistics_credentials_required');
    const b=await h.provider(s),target=`/provider-accounts/${b.account_id}/logistics-services`,input={...body,fresh_auth_verification_id:await h.fresh(s)};
    assert.equal((await h.request(s,'POST',target,input)).status,428);
    assert.equal((await h.request(s,'POST',target,input,'99')).status,412);
    assert.equal((await h.request(s,'POST',target,{service_key:SERVICE_KEYS[0]},b.version)).status,403);
    assert.equal((await h.request(s,'POST',target,{...input,fresh_auth_verification_id:randomUUID()},b.version)).status,403);
    const wrong=await h.fresh(s,s.owner,'tenant.ownership.propose');assert.equal((await h.request(s,'POST',target,{...input,fresh_auth_verification_id:wrong},b.version)).status,403);
    r=await h.request(s,'POST',target,input,b.version);h.expect(r,201);ProviderAccountViewSchema.parse(r.data);assert.equal(r.response.headers.get('ETag'),`"${r.data.version}"`);
    assert.equal((await h.request(s,'POST',target,{...input,service_key:SERVICE_KEYS[1]},r.data.version)).status,403);
    const duplicate=await h.request(s,'POST',target,{...input,fresh_auth_verification_id:await h.fresh(s)},r.data.version);assert.equal(duplicate.data.code,'logistics_service_exists');
    for(const role of ['operator','viewer'] as const){const m=await h.member(s,['store:manage'],role);const denied=await h.request(s,'POST',target,{...input,fresh_auth_verification_id:randomUUID()},r.data.version,m.session);assert.equal(denied.status,403);}
    const outsider=(await h.f.x.h.person('合成外部'+randomUUID())).session;const count=async()=>(await h.f.x.h.pool.query('SELECT count(*)::int n FROM commerce_logistics_services')).rows[0].n;const before=await count();assert.equal((await h.request(s,'POST',target,input,r.data.version,outsider)).status,404);assert.equal(await count(),before);
    let bview=await account(s,b.account_id);bview=h.expect(await state(s,bview,'retire'));
    const recreated=await h.request(s,'POST',target,{service_key:SERVICE_KEYS[0],fresh_auth_verification_id:await h.fresh(s)},bview.version);h.expect(recreated,201);assert.equal(recreated.data.logistics_services.length,1);assert.equal(recreated.data.logistics_services[0].state,'draft');

  });
  test('draft/suspended/retired transitions and active-key conflicts are enforced atomically',async()=>{
    const s=await h.store();let a=await h.provider(s,[SERVICE_KEYS[0]]);
    assert.equal((await state(s,a,'suspend')).data.code,'logistics_service_state');assert.equal((await state(s,a,'resume')).data.code,'logistics_service_state');
    a=await activate(s,a.account_id);assert.equal((await state(s,a,'resume')).data.code,'logistics_service_state');
    a=h.expect(await state(s,a,'suspend'));assert.equal((await state(s,a,'suspend')).data.code,'logistics_service_state');
    const b=await h.provider(s,[SERVICE_KEYS[0]],true);
    assert.equal((await state(s,a,'resume')).data.code,'logistics_service_conflict');
    let bview=h.expect(await state(s,b,'retire'));a=h.expect(await state(s,a,'resume'));assert.equal(a.logistics_services[0].state,'active');
    a=h.expect(await state(s,a,'retire'));assert.deepEqual(a.logistics_services,[]);assert.equal((await state(s,a,'retire')).status,404);
    bview=h.expect(await h.request(s,'POST',`/provider-accounts/${b.account_id}/services/logistics/retire`,{fresh_auth_verification_id:await h.fresh(s)},bview.version));
    assert.equal((await h.request(s,'POST',`/provider-accounts/${b.account_id}/logistics-services`,{service_key:SERVICE_KEYS[0],fresh_auth_verification_id:await h.fresh(s)},bview.version)).data.code,'provider_service_state');
  });
  test('internal activation records one immutable reference, permits separate logistics accounts and preserves payment conflict mapping',async()=>{
    const s=await h.store(),a=await h.provider(s,[SERVICE_KEYS[0]]),ref=randomUUID();await activate(s,a.account_id,SERVICE_KEYS[0],ref);
    const facts=(await h.f.x.h.pool.query(`SELECT l.activation_ref,l.activated_at,p.activation_ref AS purpose_ref,p.state FROM commerce_logistics_services l JOIN commerce_provider_account_services p USING(account_id,purpose) WHERE l.account_id=$1`,[a.account_id])).rows[0];assert.equal(facts.activation_ref,ref);assert.equal(facts.purpose_ref,ref);assert(facts.activated_at);assert.equal(facts.state,'active');
    await assert.rejects(activate(s,a.account_id),code('logistics_service_state'));
    const b=await h.provider(s,[SERVICE_KEYS[2]],true);assert.equal((await h.f.x.h.pool.query("SELECT count(*)::int n FROM commerce_provider_account_services WHERE purpose='logistics' AND state='active'")).rows[0].n,2);
    const c=await h.provider(s,[SERVICE_KEYS[0]]);await assert.rejects(activate(s,c.account_id),code('logistics_service_conflict'));assert.equal((await account(s,c.account_id)).services[0].state,'draft');
    for(const id of [a.account_id,b.account_id]){const current=await account(s,id);h.expect(await h.request(s,'PUT',`/provider-accounts/${id}/services/payment`,{profile:'ecpay.aio.credit.v1',hash_key:randomBytes(8).toString('hex'),hash_iv:randomBytes(8).toString('hex'),fresh_auth_verification_id:await h.fresh(s)},current.version));}
    await h.f.x.tx(async q=>{await bindStore(q,s.tenantId);await activateProviderService(q,{accountId:a.account_id,purpose:'payment',activationRef:randomUUID()});});
    await assert.rejects(h.f.x.tx(async q=>{await bindStore(q,s.tenantId);await activateProviderService(q,{accountId:b.account_id,purpose:'payment',activationRef:randomUUID()});}),code('provider_service_conflict'));
    await assert.rejects(h.f.x.h.pool.query("UPDATE commerce_logistics_services SET activation_ref='other',version=version+1,updated_at=clock_timestamp() WHERE account_id=$1",[a.account_id]),code('23514'));
  });
  test('availability and resolution share the state policy, environment, right account and current credential version',async()=>{
    const s=await h.store();
    const view=(environment:'sandbox'|'live'='sandbox')=>h.f.x.tx(async q=>{await bindStore(q,s.tenantId);return {availability:await logisticsAvailability(q,{instanceId:s.instanceId,environment}),resolved:await resolveLogisticsService(q,{instanceId:s.instanceId,environment,serviceKey:SERVICE_KEYS[0]})};});
    let v=await view();assert.equal(v.resolved,null);assert(v.availability.logistics.every(r=>r.state==='not_configured'));assert.equal(v.availability.profileServiceKeys.size,0);
    const a=await h.provider(s,[SERVICE_KEYS[0]]);v=await view();assert.equal(v.resolved,null);assert.equal(v.availability.logistics[0].state,'draft');assert.equal(v.availability.profileServiceKeys.size,0);
    let b=await h.provider(s,[SERVICE_KEYS[0]],true);v=await view();assert.equal(v.resolved?.accountId,b.account_id);assert.equal(v.resolved?.credentialVersion,1);assert.equal(v.availability.logistics[0].state,'active');assert(v.availability.profileServiceKeys.has(SERVICE_KEYS[0]));
    b=h.expect(await h.request(s,'PUT',`/provider-accounts/${b.account_id}/services/logistics`,{profile:'ecpay.logistics.domestic.v1',hash_key:randomBytes(8).toString('hex'),hash_iv:randomBytes(8).toString('hex'),fresh_auth_verification_id:await h.fresh(s)},b.version));assert.equal((await view()).resolved?.credentialVersion,2);
    b=h.expect(await state(s,b,'suspend'));v=await view();assert.equal(v.resolved,null);assert.equal(v.availability.logistics[0].state,'suspended');assert(v.availability.profileServiceKeys.has(SERVICE_KEYS[0]));
    b=h.expect(await state(s,b,'resume'));b=h.expect(await h.request(s,'POST',`/provider-accounts/${b.account_id}/services/logistics/suspend`,{fresh_auth_verification_id:await h.fresh(s)},b.version));v=await view();assert.equal(v.resolved,null);assert.equal(v.availability.logistics[0].state,'suspended');
    assert.equal((await view('live')).resolved,null);assert((await view('live')).availability.logistics.every(r=>r.state==='not_configured'));
    b=h.expect(await state(s,b,'suspend'));v=await view();assert.equal(v.availability.logistics[0].state,'suspended');assert.equal(v.resolved,null);assert(v.availability.profileServiceKeys.has(SERVICE_KEYS[0]));b=h.expect(await h.request(s,'POST',`/provider-accounts/${b.account_id}/services/logistics/retire`,{fresh_auth_verification_id:await h.fresh(s)},b.version));assert.equal((await state(s,b,'resume')).data.code,'provider_service_state');
    v=await view();assert.equal(v.availability.logistics[0].state,'draft');assert.equal(v.resolved,null);assert.equal(v.availability.profileServiceKeys.size,0);
    assert.equal((await account(s,a.account_id)).logistics_services[0].state,'draft');
  });
  test('account projection is ordered, control and journal records retain only the new service_key metadata',async()=>{
    const s=await h.store();let a=await h.provider(s,[SERVICE_KEYS[4],SERVICE_KEYS[0],SERVICE_KEYS[2]]);assert.deepEqual(a.logistics_services.map((r:{service_key:string})=>r.service_key),[SERVICE_KEYS[0],SERVICE_KEYS[2],SERVICE_KEYS[4]]);
    a=await activate(s,a.account_id);a=h.expect(await state(s,a,'suspend'));await flushControlEvents(h.f.x.runtime,h.f.journal,{limit:200});
    const rows=(await h.f.x.h.pool.query("SELECT * FROM commerce_control_events WHERE kind LIKE 'logistics_service.%' ORDER BY occurred_at")).rows;assert.equal(rows.length,5);
    for(const row of rows){assert(SERVICE_KEYS.includes(row.detail.service_key));assert.deepEqual(Object.keys(row.detail).sort(),(row.kind==='logistics_service.created'?['environment','service_key']:['from_state','service_key','to_state']).sort());assert(row.journaled_at);}
    const journal=[...h.f.journal.objects.values()].map(bytes=>JSON.parse(bytes)).filter(r=>r.tenant_id===s.tenantId&&r.kind.startsWith('control.logistics_service.'));assert.equal(journal.length,5);for(const row of journal){assert(SERVICE_KEYS.includes(row.detail.service_key));assert(Object.keys(row.detail).every(key=>['service_key','from_state','to_state'].includes(key)));}
    const retired=h.expect(await state(s,a,'retire'));assert.equal(retired.logistics_services.length,2);
  });
});
