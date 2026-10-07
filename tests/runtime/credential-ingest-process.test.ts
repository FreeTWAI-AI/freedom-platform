import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {ingestFixture} from './credential-ingest-helpers.js';
import {fileStore} from './credential-ingest-fixtures/shared.js';
import {createPrivateResultService} from '../../modules/autopilot-work/results.js';
import {resolvePrivateWorkPersistencePolicy} from '../../modules/autopilot-work/policy.js';
import {ModelStepMetadataSchema} from '../../contracts/execution/v2/model-step.js';

test('INGEST-PROCESS actual Chromium cross-site HTTPS setup stores an encrypted key and the separate broker publishes one original private Result', {timeout:90000},async()=>{
 const f=await ingestFixture();try{
  const member=await f.activated();assert.equal(f.posts.length,0);
  const response=await f.post(member,`/api/v1/me/model-steps/${member.step.stepId}:execute`,{});
  assert.equal(response.status,200,JSON.stringify({body:await response.clone().text(),sqlErrors:await f.broker.request('sqlErrors')}));
  const step=ModelStepMetadataSchema.parse(await response.json());assert.equal(step.state,'succeeded');assert.equal(step.operational_authority,false);
  assert.equal(f.posts.length,1);assert.equal((await readdir(f.directory)).length,1);
  const envelope=(await f.brokerPool.query('SELECT envelope FROM broker_credential_vault')).rows[0].envelope;
  assert(!JSON.stringify(envelope).includes(f.secret));assert.equal((await f.owner.query('SELECT count(*)::int n FROM private_model_work_results')).rows[0].n,1);
  const results=createPrivateResultService(f.app,{store:fileStore(f.directory),resolvePolicy:resolvePrivateWorkPersistencePolicy});
  const result=await results.readCurrent(member.actor,{workId:member.work.workId});assert(result);assert.equal(result.text,f.output);assert.equal(result.provenance,'model');assert.equal(result.aggregateVersion,'2');
  const foreign=await f.member();await assert.rejects(results.readCurrent(foreign.actor,{workId:member.work.workId}));
  const main=await f.main.request('snapshot'),broker=await f.broker.request('snapshot');
  assert.notEqual(main.pid,broker.pid);assert.notEqual(main.pid,process.pid);
  for(const forbidden of ['secret','kekBytes','cipherUrl','providerOrigin','responsePrivateJwk'])assert(!main.configKeys.includes(forbidden));
  const entry=await readFile(new URL('./credential-ingest-fixtures/main-child.ts',import.meta.url),'utf8');assert(!entry.includes(f.secret));assert(!entry.includes('SYNTHETIC_DIRECT_INGEST_KEY'));assert(!entry.includes('/vault.js'));
  assert(!JSON.stringify(main).includes(f.secret));assert(!f.main.logs().includes(f.secret));
  assert(broker.requests.every((r:{cookie:string|null})=>!r.cookie?.includes('__Host-freedom_session')));
  const bootstrap=broker.requests.find((r:any)=>r.path==='/credential-setup'&&r.method==='POST');assert(bootstrap);assert.equal(bootstrap.cookie,null);assert.equal(bootstrap.origin,f.mainOrigin);assert.equal(bootstrap.mode,'navigate');assert.equal(bootstrap.site,'cross-site');
  assert(broker.requests.some((r:any)=>r.path==='/credential-setup/prepare'&&r.cookie?.includes('__Host-fp_broker_setup=')));
  assert.equal(broker.reads.length,1);assert(broker.reads.every((r:any)=>r.cleared));assert.equal(broker.storePuts,1);
  assert(broker.surfaceChecks.length>=3); // Only explicit local application capture-port evidence.
  for(const p of [f.app,f.executor,f.brokerPool])assert.deepEqual((await p.query('SELECT rolsuper,rolbypassrls,rolinherit FROM pg_roles WHERE rolname=current_user')).rows[0],{rolsuper:false,rolbypassrls:false,rolinherit:false});
  for(const p of [f.app,f.executor])for(const sql of ['SELECT envelope FROM broker_credential_vault',`SET ROLE ${f.roles.broker}`])await assert.rejects(p.query(sql),(e:any)=>e.code==='42501');
 }finally{await f.cleanup();}
});
