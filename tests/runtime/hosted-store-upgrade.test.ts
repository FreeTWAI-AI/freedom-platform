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
test('owner upgrade is atomic, versioned and replayable; preserves grants and records authority facts',async()=>{
  const s=await store(),call=(method:string,tail:string,body?:unknown,headers:Record<string,string>={})=>h.call(method,s.root+tail,s.owner,body,headers);
  assert.equal((await h.post(s.root+'/setup',s.owner,{name:'合成商店',slug:'synthetic-upgrade',currency:'TWD'})).status,201);
  assert.equal((await h.call('PATCH',s.root,s.owner,{name:'合成商店更新'},{'Idempotency-Key':crypto.randomUUID(),'If-Match':'"1"'})).status,200);
  const before=(await h.pool.query('SELECT authorization_revision::text FROM tenants WHERE tenant_id=$1',[s.tenantId])).rows[0].authorization_revision;
  const initial=await call('GET','/release');assert.equal(initial.status,200);assert.equal(initial.data.can_upgrade,true);
  const key=crypto.randomUUID(),headers={'Idempotency-Key':key,'If-Match':`"${s.instance.version}"`};
  const result=await call('POST','/upgrade',{},headers);assert.equal(result.status,200,JSON.stringify(result.data));
  assert.equal(result.data.module_release_ref,'storefront@1.1.0');assert.equal(result.data.application_release_ref,'hosted-store@1.1.0');
  assert.equal(result.data.version,String(BigInt(s.instance.version)+1n));assert.equal(result.data.can_upgrade,false);assert.equal(result.data.upgrade,null);
  assert.deepEqual(result.data.capabilities,keys);assert.equal(result.response.headers.get('etag'),`"${result.data.version}"`);
  assert.equal(result.response.headers.get('cache-control'),'private, no-store');
  assert.deepEqual((await call('POST','/upgrade',{},headers)).data,result.data);
  assert.equal((await call('POST','/upgrade',{}, {'Idempotency-Key':crypto.randomUUID()})).status,428);
  assert.equal((await call('POST','/upgrade',{}, {...headers,'Idempotency-Key':crypto.randomUUID()})).status,412);
  const current=await call('POST','/upgrade',{}, {'Idempotency-Key':crypto.randomUUID(),'If-Match':`"${result.data.version}"`});assert.equal(current.status,409);assert.equal(current.data.code,'store_upgrade_unavailable');
  assert.equal((await h.pool.query('SELECT authorization_revision::text FROM tenants WHERE tenant_id=$1',[s.tenantId])).rows[0].authorization_revision,String(BigInt(before)+1n));
  assert.equal((await h.pool.query("SELECT * FROM scoped_transition_journal WHERE aggregate_id=$1 AND operation='commerce.storefront.upgrade'",[s.instance.instance_id])).rowCount,1);
  assert.equal((await h.pool.query("SELECT * FROM commerce_control_events WHERE instance_id=$1 AND kind='storefront.upgraded'",[s.instance.instance_id])).rowCount,1);
});
test('identity trigger rejects partial, unregistered and mixed changes and downgrades',async()=>{
  const s=await store();
  for(const set of ["module_release_ref='storefront@1.1.0'","application_release_ref='hosted-store@1.1.0'","module_release_ref='storefront@1.1.0',application_release_ref='hosted-store@1.1.0',status='suspended',version=version+1"])
    await assert.rejects(h.pool.query(`UPDATE module_instances SET ${set} WHERE instance_id=$1`,[s.instance.instance_id]),{code:'23514'});
  await h.pool.query("UPDATE module_instances SET module_release_ref='storefront@1.1.0',application_release_ref='hosted-store@1.1.0',version=version+1 WHERE instance_id=$1",[s.instance.instance_id]);
  await assert.rejects(h.pool.query("UPDATE module_instances SET module_release_ref='storefront@1.0.0',application_release_ref='hosted-store@1.0.0',version=version+1 WHERE instance_id=$1",[s.instance.instance_id]),{code:'23514'});
});
test('upgrade authority, suspended lifecycle and concurrent requests preserve the existing grants',async()=>{
  const {effectiveStoreCapabilities}=await import('../../modules/agent-commerce/hosted/capabilities.js');
  const s=await store();
  for(const role of ['admin','operator','viewer'] as const){
    const member=(await h.person('合成升級權限')).session,principal=await h.candidate(s.owner,member.user.user_id);
    const invitation=await h.invite(s.owner,s.tenantId,principal,role);assert.equal(invitation.status,201);await h.accept(member,s.tenantId,invitation);
    if(role!=='admin')await h.pool.query(`INSERT INTO tenant_module_permissions(tenant_id,principal_id,instance_id,capabilities,status,granted_by_principal_id)
      VALUES($1,$2,$3,$4,'active',$5)`,[s.tenantId,principal,s.instance.instance_id,['store:read'],s.principal]);
    const read=await h.call('GET',s.root+'/release',member);assert.equal(read.status,200);assert.equal(read.data.can_upgrade,false);
    const denied=await h.post(s.root+'/upgrade',member,{},`"${s.instance.version}"`);assert.equal(denied.status,403);assert.equal(denied.data.code,'capability_denied');
    const q=await h.pool.connect();try{assert.deepEqual(await effectiveStoreCapabilities(q,{tenant_id:s.tenantId,principal_id:principal,role} as any,s.instance.instance_id),role==='admin'?keys.slice(0,4):['store:read']);}finally{q.release();}
  }
  const outsider=(await h.person('合成外部會員')).session;assert.equal((await h.post(s.root+'/upgrade',outsider,{},`"${s.instance.version}"`)).status,404);
  assert.equal((await h.call('POST',s.root+'/upgrade',s.owner,{}, {'If-Match':`"${s.instance.version}"`})).status,400);
  for(const table of ['tenants','module_instances']){
    const column=table==='tenants'?'tenant_id':'instance_id',id=table==='tenants'?s.tenantId:s.instance.instance_id;
    await h.pool.query(`UPDATE ${table} SET status='suspended',version=version+1 WHERE ${column}=$1`,[id]);
    const version=(await h.pool.query('SELECT version::text FROM module_instances WHERE instance_id=$1',[s.instance.instance_id])).rows[0].version;
    const denied=await h.post(s.root+'/upgrade',s.owner,{},`"${version}"`);assert.equal(denied.status,409);assert.equal(denied.data.code,'store_upgrade_unavailable');
    assert.equal((await h.call('GET',s.root+'/release',s.owner)).data.can_upgrade,false);
    await h.pool.query(`UPDATE ${table} SET status='active',version=version+1 WHERE ${column}=$1`,[id]);
  }
  const grants=(await h.pool.query('SELECT * FROM tenant_module_permissions WHERE tenant_id=$1 ORDER BY principal_id',[s.tenantId])).rows;
  const version=(await h.pool.query('SELECT version::text FROM module_instances WHERE instance_id=$1',[s.instance.instance_id])).rows[0].version;
  const results=await Promise.all([h.post(s.root+'/upgrade',s.owner,{},`"${version}"`),h.post(s.root+'/upgrade',s.owner,{},`"${version}"`)]);
  assert.deepEqual(results.map(r=>r.status).sort(),[200,412]);
  assert.deepEqual((await h.pool.query('SELECT * FROM tenant_module_permissions WHERE tenant_id=$1 ORDER BY principal_id',[s.tenantId])).rows,grants);
  assert.equal((await h.pool.query("SELECT 1 FROM commerce_control_events WHERE instance_id=$1 AND kind='storefront.upgraded'",[s.instance.instance_id])).rowCount,1);
});
test('manual-work still requires work:read and keeps ordinary operator and viewer grants',async()=>{
  const {validateInstanceGrants}=await import('../../modules/tenant-workspaces/instance-grants.js');
  const s=await store('1.1.0');
  const workspaceId=(await h.pool.query('SELECT workspace_id FROM workspaces WHERE tenant_id=$1 LIMIT 1',[s.tenantId])).rows[0].workspace_id;
  const planned=await h.plan(s.owner,s.tenantId,h.planBody('guild_commerce_sales',workspaceId));assert.equal(planned.status,201,JSON.stringify(planned.data));
  assert.equal((await h.launch(s.owner,s.tenantId,planned)).data.state,'succeeded');
  const manual=(await h.pool.query("SELECT instance_id FROM module_instances WHERE tenant_id=$1 AND module_key='work'",[s.tenantId])).rows[0].instance_id;
  const q=await h.pool.connect();try{
    for(const role of ['viewer','operator'] as const)assert.deepEqual(await validateInstanceGrants(q,s.tenantId,role,[{instance_id:manual,capabilities:['work:read']}]),[{instance_id:manual,capabilities:['work:read']}]);
    await assert.rejects(validateInstanceGrants(q,s.tenantId,'operator',[{instance_id:manual,capabilities:['work:write']}]),{status:422});
  }finally{q.release();}
});
