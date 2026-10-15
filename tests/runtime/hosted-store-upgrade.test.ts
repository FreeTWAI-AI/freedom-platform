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
