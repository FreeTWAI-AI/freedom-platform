import assert from 'node:assert/strict';
import {before,after,test} from 'node:test';
import {createRegistryHarness,type RegistryHarness} from './module-registry-harness.js';
let h:RegistryHarness;
before(async()=>{h=await createRegistryHarness('fp_store_upgrade');});
after(async()=>{if(h)await h.stop();});
const keys=['store:manage','store:read','store:write','store:publish','store:orders:read','store:customers:read','store:finance:read','store:orders:manage','store:fulfil','store:refund','store:invoices','store:settlements'];
test('1.1.0 preserves contract artifacts and registers ordered capabilities and skill book',async()=>{
  const rows=(await h.pool.query("SELECT * FROM module_definitions WHERE module_key='storefront' ORDER BY release_ref")).rows;
  assert.equal(rows.length,2);const [old,current]=rows;
  assert.deepEqual(current.capabilities,keys);
  for(const key of ['data_catalog_ref','contract_ref','data_schema_version','runtime_profiles','config_schema_ref','license_state','release_status'])assert.deepEqual(current[key],old[key]);
  assert.deepEqual(current.supported_upgrade_paths,[]);assert.equal(current.version,'1');
  const apps=(await h.pool.query("SELECT * FROM application_definitions WHERE application_key='hosted-store' ORDER BY release_ref")).rows;
  assert.deepEqual(apps[1].skill_book_refs,['storefront']);
  assert.deepEqual(apps[1].artifact_digest,apps[0].artifact_digest);assert.equal(apps[1].source_commit,apps[0].source_commit);
  assert.equal(apps[1].module_requirements[0].module_release_ref,'storefront@1.1.0');
  assert.deepEqual(apps[1].module_requirements[0].capabilities,keys);
  const offerings=(await h.pool.query("SELECT release_ref,status,version FROM guild_application_offerings WHERE application_key='hosted-store' ORDER BY release_ref")).rows;
  assert.deepEqual(offerings,[{release_ref:'hosted-store@1.0.0',status:'withdrawn',version:'2'},{release_ref:'hosted-store@1.1.0',status:'offered',version:'1'}]);
});
test('upgrade relation retains a single immutable superset path',async()=>{
  assert.equal((await h.pool.query('SELECT * FROM module_release_upgrades')).rowCount,1);
  for(const sql of ["UPDATE module_release_upgrades SET to_release_ref=from_release_ref","DELETE FROM module_release_upgrades",`INSERT INTO module_release_upgrades(module_key,from_release_ref,to_release_ref,from_application_release_ref,to_application_release_ref) VALUES('storefront','storefront@1.1.0','storefront@1.0.0','hosted-store@1.1.0','hosted-store@1.0.0')`])await assert.rejects(h.pool.query(sql),{code:'23514'});
});

async function store(release='1.0.0') {
  await h.reset();
  const owner=(await h.person('合成商店店主')).session;
  await h.fullMember(owner.user.user_id,'guild_commerce_sales');
  const {tenantId,workspaceId}=await h.createTenant(owner,'合成商店');
  if(release==='1.0.0')await h.pool.query(`INSERT INTO guild_application_offerings(offering_id,community_id,guild_key,application_key,release_ref,status,display_order,launch_policy_ref,version)
    SELECT gen_random_uuid(),community_id,'guild_commerce_sales','hosted-store','hosted-store@1.0.0','offered',10,'{"policy_key":"hosted-store.launch","version":"1"}',1 FROM tenants WHERE tenant_id=$1`,[tenantId]);
  const planned=await h.post(`/tenants/${tenantId}/application-launch-plans`,owner,h.planBody('guild_commerce_sales',workspaceId,'hosted-store',`hosted-store@${release}`));
  assert.equal(planned.status,201,JSON.stringify(planned.data));
  const launched=await h.post(`/tenants/${tenantId}/application-installations`,owner,{plan_id:planned.data.plan_id,expected_plan_version:planned.data.version,configuration_digest:planned.data.configuration_digest});
  assert.equal(launched.data.state,'succeeded',JSON.stringify(launched.data));
  const instance=(await h.pool.query("SELECT *,version::text FROM module_instances WHERE tenant_id=$1 AND module_key='storefront'",[tenantId])).rows[0];
  const principal=(await h.pool.query('SELECT principal_id FROM principals WHERE user_ref=$1',[owner.user.user_id])).rows[0].principal_id;
  return {owner,tenantId,instance,principal,root:`/tenants/${tenantId}/storefronts/${instance.instance_id}`};
}
test('new stores use 1.1.0; effective owner/admin capabilities follow the instance release',async()=>{
  const {effectiveStoreCapabilities}=await import('../../modules/agent-commerce/hosted/capabilities.js');
  for(const release of ['1.0.0','1.1.0']){
    const s=await store(release),q=await h.pool.connect();
    try {for(const role of ['owner','admin'])assert.deepEqual(await effectiveStoreCapabilities(q,{tenant_id:s.tenantId,role,principal_id:s.principal} as any,s.instance.instance_id),release==='1.0.0'?keys.slice(0,4):keys);}finally{q.release();}
  }
});
test('grants require the base read key and honor release and viewer constraints',async()=>{
  const {validateInstanceGrants}=await import('../../modules/tenant-workspaces/instance-grants.js');
  const s=await store('1.1.0'),q=await h.pool.connect();
  const grant=(capabilities:string[])=>[{instance_id:s.instance.instance_id,capabilities}];
  try {
    for(const [role,caps] of [['viewer',['store:orders:read']],['viewer',['store:read','store:fulfil']]] as const)await assert.rejects(validateInstanceGrants(q,s.tenantId,role,grant([...caps])),{status:422});
    assert.deepEqual((await validateInstanceGrants(q,s.tenantId,'viewer',grant(['store:read','store:finance:read'])))[0].capabilities,['store:finance:read','store:read']);
  }finally{q.release();}
  const old=await store(),oldq=await h.pool.connect();try{await assert.rejects(validateInstanceGrants(oldq,old.tenantId,'operator',[{instance_id:old.instance.instance_id,capabilities:['store:read','store:refund']}]),{status:422});}finally{oldq.release();}
});
