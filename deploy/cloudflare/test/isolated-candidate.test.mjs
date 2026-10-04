import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {loadManifest} from '../lib/manifest.mjs';
import {MEDIA_WORKER_FEATURES} from '../lib/media-wrangler.mjs';
import {planIsolatedCandidate,inspectCandidateProvider,createCandidateProviderReader} from '../lib/isolated-candidate.mjs';
import {runCandidateAdmission} from '../candidate-admission.mjs';
const manifest=loadManifest(),account='a'.repeat(32);
const request=()=>({schema:'freedom.isolated-candidate-request/v1',environment:'staging-next',releaseSha:'b'.repeat(40),hostname:'base-candidate-unit.example.test',workers:{main:'fp-base-candidate-unit-main',broker:'fp-base-candidate-unit-broker',operator:'fp-base-candidate-unit-operator'},database:{branchId:'synthetic_branch_id',originHost:'synthetic-new-branch.pg.psdb.cloud'},hyperdrive:{main:'1'.repeat(32),cipher:'2'.repeat(32),executor:'3'.repeat(32),operator:'4'.repeat(32)},bucket:'fp-base-candidate-unit-media'});
function nativeProvider(r=request(),mutate=()=>{}){
 const calls=[],roles=planIsolatedCandidate(r,manifest).expected_roles;
 const operational=Object.values(manifest.environments).map((e,n)=>({id:String(n+8).repeat(32),name:e.hyperdrive.name,origin:{host:`existing-${n}.pg.psdb.cloud`,database:e.database.dbname,user:`${e.database.roles.runtime}.synthetic_existing_branch_${n}`}}));
 const rows=[...operational,...Object.entries(r.hyperdrive).map(([key,id])=>({id,name:`candidate-${key}`,caching:{disabled:true},origin:{host:r.database.originHost,database:'freedom_staging_next',user:`${roles[key]}.${r.database.branchId}`}}))];
 mutate(rows);
 const client=createCandidateProviderReader({credentials:{authorizationHeader:()=> 'Bearer SYNTHETIC_READONLY'},fetchImpl:async(url,options)=>{calls.push({url,options});const suffix=url.split('/hyperdrive/configs')[1];const result=suffix?rows.find(c=>c.id===suffix.slice(1)):rows;return Response.json({success:true,result,result_info:{total_count:rows.length}});}});
 return {client,calls};
}
test('placeholder plan uses genuine entries with all mutations/acceptance unavailable and no resource claim',()=>{
 const r=JSON.parse(readFileSync(new URL('../candidate/isolated-request.example.json',import.meta.url),'utf8')),p=planIsolatedCandidate(r,manifest);
 assert.equal(p.structural,true);assert.equal(p.status,'unavailable');assert.equal(p.deployment_authority,false);assert.equal(p.execution_authority,false);assert.equal(p.provider_mutations,0);assert.equal(p.database_connections,0);
 assert.ok(p.blockers.includes('release_sha_placeholder'));assert.ok(p.blockers.includes('broker_candidate_origin_unsupported'));assert.ok(p.remaining_checks.every(c=>c.status==='not_run'));
 assert.equal(p.configs.main.main,'apps/platform-api/src/worker.ts');assert.equal(p.configs.broker.main,'apps/credential-broker/src/worker.ts');assert.equal(p.configs.operator.main,'apps/media-operator/src/worker.ts');
 assert.equal(p.configs.main.vars.FREEDOM_DATABASE_NAME,'freedom_staging_next');assert.equal(p.expected_roles.operator,'freedom_media_migrator');assert.equal(p.configs.broker.vars.FREEDOM_BROKER_ENABLED,'false');
 assert.deepEqual(p.media_mapping.map(f=>f.purpose),MEDIA_WORKER_FEATURES.map(f=>f.purpose));assert.equal(p.media_mapping.length,7);
 for(const c of Object.values(p.configs)){assert.deepEqual(c.routes,[]);assert.deepEqual(c.triggers.crons,[]);assert.equal(c.workers_dev,false);assert.equal(c.preview_urls,false);assert.equal(c.r2_buckets[0].bucket_name,r.bucket);}
});
test('closed bounded request rejects isolation promises, routes, keys, unknown mode and arbitrary bytes',()=>{
 for(const mutate of [r=>r.isolation=true,r=>r.routes=['freetwai.com/*'],r=>r.environment='next',r=>r.workers.secret='PRIVATE_SECRET',r=>r.hostname='x'.repeat(254),r=>r.database.password='PRIVATE_SECRET',r=>r.database.user='PRIVATE_SECRET',r=>r.expected_connection_users={main:'PRIVATE_SECRET'},r=>r.bucket='REPLACE_PRIVATE\nBearer PRIVATE_SECRET']){const r=request();mutate(r);const p=planIsolatedCandidate(r,manifest);assert.equal(p.structural,false);assert.ok(!JSON.stringify(p).includes('PRIVATE_SECRET'));assert.equal(p.configs,undefined);}
});
test('all canonical operating workers/hosts/buckets and repeated role IDs are rejected',()=>{
 for(const e of Object.values(manifest.environments))for(const mutate of [r=>r.workers.main=e.worker.name,r=>r.hostname=e.hostname,...e.r2_buckets.map(b=>r=>r.bucket=b.name)]){const r=request();mutate(r);assert.equal(planIsolatedCandidate(r,manifest).structural,false);}
 for(const name of ['freedom-platform','main']){const r=request();r.workers.main=name;assert.equal(planIsolatedCandidate(r,manifest).structural,false);}
 const r=request();r.hyperdrive.executor=r.hyperdrive.cipher;assert.ok(planIsolatedCandidate(r,manifest).errors.includes('hyperdrive_roles_must_not_share_ids'));
});
test('optional provider probe uses only existing GET client and does not confuse origin readback with complete admission',async()=>{
 const r=request(),f=nativeProvider(r),p=await inspectCandidateProvider(r,manifest,{client:f.client,accountId:account});
 assert.equal(p.provider_isolation_status,'partial_observation');assert.equal(p.deployment_authority,false);assert.equal(p.remote_acceptance,'not_run');assert.equal(p.status,'unavailable');assert.ok(p.remaining_checks.every(c=>c.status==='not_run'));
 assert.equal(f.calls.length,7);for(const c of f.calls){assert.equal(c.options.method,'GET');assert.equal(c.options.redirect,'error');assert.ok(c.url.startsWith('https://api.cloudflare.com/client/v4/accounts/'));}
 assert.equal(p.configs,undefined);assert.ok(!JSON.stringify(p).includes('Bearer'));
});
test('connection routing derives exact physical branch users while keeping SQL roles bare',()=>{
 const p=planIsolatedCandidate(request(),manifest);
 assert.deepEqual(p.expected_roles,{main:'freedom_staging_next_app',cipher:'freedom_staging_next_broker',executor:'freedom_staging_next_broker_executor',operator:'freedom_media_migrator'});
 assert.deepEqual(p.expected_connection_users,{main:'freedom_staging_next_app.synthetic_branch_id',cipher:'freedom_staging_next_broker.synthetic_branch_id',executor:'freedom_staging_next_broker_executor.synthetic_branch_id',operator:'freedom_media_migrator.synthetic_branch_id'});
});
test('every provider role rejects bare users, wrong branches, extra suffixes and role substitutions',async()=>{
 const r=request();
 for(const key of Object.keys(r.hyperdrive))for(const user of [planIsolatedCandidate(r,manifest).expected_roles[key],`${planIsolatedCandidate(r,manifest).expected_roles[key]}.foreign_branch_id`,`${planIsolatedCandidate(r,manifest).expected_roles[key]}.${r.database.branchId}.extra`,`postgres.${r.database.branchId}`]){
  const f=nativeProvider(r,rows=>{rows.find(row=>row.id===r.hyperdrive[key]).origin.user=user;});
  const p=await inspectCandidateProvider(r,manifest,{client:f.client,accountId:account});
  assert.equal(p.provider_isolation_status,'rejected',`${key} must reject ${user}`);assert.equal(p.deployment_authority,false);assert.equal(p.provider_mutations,0);
 }
});
for(const boundary of ['shared-id','shared-origin','cache','role','database'])test(`provider ${boundary} is rejected using readback, not caller isolation claim`,async()=>{
 const r=request(),f=nativeProvider(r,rows=>{const c=rows[2];if(boundary==='shared-id')r.hyperdrive.main=rows[0].id;if(boundary==='shared-origin'){r.database.branchId='synthetic_existing_branch_0';for(const [key,row] of Object.entries(r.hyperdrive).map(([key,id])=>[key,rows.find(row=>row.id===id)]))row.origin.user=`${planIsolatedCandidate(r,manifest).expected_roles[key]}.${r.database.branchId}`;}if(boundary==='cache')c.caching.disabled=false;if(boundary==='role')c.origin.user='postgres';if(boundary==='database')c.origin.database='freedom_next';});
 const p=await inspectCandidateProvider(r,manifest,{client:f.client,accountId:account});assert.equal(p.provider_isolation_status,'rejected');assert.equal(p.deployment_authority,false);
});
test('partial provider inventory or exceptions never prove absence and never print private diagnostics',async()=>{
 for(const client of [{get:async()=>({http:200,success:true,result:[],result_info:{total_count:4}})},{get:async()=>{throw Error('postgres://PRIVATE_SECRET');}}]){const p=await inspectCandidateProvider(request(),manifest,{client,accountId:account});assert.equal(p.provider_isolation_status,'unavailable');assert.ok(!JSON.stringify(p).includes('PRIVATE_SECRET'));}
 const f=nativeProvider();await assert.rejects(f.client.get(`/accounts/${account}/r2/buckets/unsafe/delete`));assert.equal(f.calls.length,0);
});
test('default CLI never accesses environment/fetch and rejects execute/credentials flags',()=>{
 const saved=globalThis.fetch;globalThis.fetch=()=>{throw Error('network must not run');};try{const p=runCandidateAdmission([]);assert.equal(p.exitCode,2);assert.equal(p.report.database_connections,0);for(const args of [['--execute'],['--token','PRIVATE_SECRET'],['--request'],['--request','--execute']]){const result=runCandidateAdmission(args);assert.equal(result.exitCode,1);assert.ok(!JSON.stringify(result).includes('PRIVATE_SECRET'));}}finally{globalThis.fetch=saved;}
});

function foundationRequest(){const r=request();r.schema='freedom.isolated-foundation-request/v1';r.features={private_ai:'false',broker:'false',machine_execution:'false'};delete r.workers.broker;delete r.hyperdrive.cipher;delete r.hyperdrive.executor;return r;}
test('explicit foundation profile removes only broker coupling, keeps actual main/operator entries and authority unavailable',()=>{
 const r=foundationRequest(),p=planIsolatedCandidate(r,manifest);
 assert.equal(p.structural,true);assert.equal(p.profile,'foundation-media');assert.equal(p.status,'unavailable');
 assert.deepEqual(Object.keys(p.configs),['main','operator']);assert.deepEqual(p.expected_roles,{main:'freedom_staging_next_app',operator:'freedom_media_migrator'});
 assert.deepEqual(Object.keys(p.expected_connection_users),['main','operator']);assert.ok(!p.blockers.includes('broker_candidate_origin_unsupported'));
 assert.ok(p.blockers.includes('physical_isolation_not_observed'));assert.ok(p.remaining_checks.every(c=>c.status==='not_run'));
 assert.ok(p.remaining_checks.some(c=>c.check_id==='fresh_candidate_only_sessions_and_operator_approval'));
 assert.equal(p.configs.main.vars.FREEDOM_PRIVATE_AI_ENABLED,'false');assert.equal(p.configs.operator.vars.FREEDOM_MEDIA_OPERATOR_ENABLED,'false');
 for(const f of MEDIA_WORKER_FEATURES.filter(f=>f.flag))assert.equal(p.configs.main.vars[f.flag],'false');
 for(const c of Object.values(p.configs)){assert.equal(c.services,undefined);assert.deepEqual(c.routes,[]);assert.equal(c.workers_dev,false);assert.equal(c.preview_urls,false);assert.deepEqual(c.triggers.crons,[]);}
 assert.equal(p.deployment_authority,false);assert.equal(p.database_connections,0);assert.equal(p.provider_mutations,0);
});
test('foundation rejects execution feature activation, unknown values/resources/keys and cross-environment role overrides',()=>{
 for(const mutate of [r=>r.features.private_ai='true',r=>r.features.broker='true',r=>r.features.machine_execution='true',
   r=>r.features.private_ai=false,r=>r.features.broker='FALSE',r=>delete r.features.machine_execution,r=>r.features.model='false',
   r=>r.workers.broker='fp-base-candidate-unit-broker',r=>r.hyperdrive.executor='3'.repeat(32),r=>r.environment='next',
   r=>r.database.role='freedom_next_app',r=>r.database.password='PRIVATE_SECRET',r=>r.keys={operator:'PRIVATE_SECRET'},
   r=>r.services=[{binding:'MODEL_BROKER'}],r=>r.vars={FREEDOM_PRIVATE_AI_ENABLED:'true'},
   r=>r.hyperdrive.operator=r.hyperdrive.main,r=>r.bucket=manifest.environments.next.r2_buckets[0].name]){
   const r=foundationRequest();mutate(r);const p=planIsolatedCandidate(r,manifest);assert.equal(p.structural,false);assert.equal(p.configs,undefined);assert.ok(!JSON.stringify(p).includes('PRIVATE_SECRET'));
 }
});
test('foundation two-role provider observations retain branch/cache/role rejection and never establish deployment',async()=>{
 const r=foundationRequest(),f=nativeProvider(r),p=await inspectCandidateProvider(r,manifest,{client:f.client,accountId:account});
 assert.equal(f.calls.length,5);assert.equal(p.provider_isolation_status,'partial_observation');assert.equal(p.deployment_authority,false);assert.equal(p.remote_acceptance,'not_run');
 for(const mutation of ['role','cache','branch','shared-origin']){
   const fixture=nativeProvider(r,rows=>{const row=rows.find(c=>c.id===r.hyperdrive.operator);if(mutation==='role')row.origin.user=`freedom_staging_next_broker.${r.database.branchId}`;if(mutation==='cache')row.caching.disabled=false;if(mutation==='branch')row.origin.user='freedom_media_migrator.foreign_branch';if(mutation==='shared-origin'){r.database.branchId='synthetic_existing_branch_0';for(const [key,id] of Object.entries(r.hyperdrive))rows.find(c=>c.id===id).origin.user=`${planIsolatedCandidate(r,manifest).expected_roles[key]}.${r.database.branchId}`;}});
   assert.equal((await inspectCandidateProvider(r,manifest,{client:fixture.client,accountId:account})).provider_isolation_status,'rejected');
 }
});
test('foundation placeholders are unavailable and full profile retains four-role broker blocker unchanged',()=>{
 const r=JSON.parse(readFileSync(new URL('../candidate/foundation-request.example.json',import.meta.url),'utf8'));
 const foundation=planIsolatedCandidate(r,manifest);assert.equal(foundation.structural,true);assert.equal(foundation.status,'unavailable');assert.ok(foundation.blockers.includes('hyperdrive_placeholder'));
 const full=planIsolatedCandidate(request(),manifest);assert.equal(Object.keys(full.configs).length,3);assert.equal(Object.keys(full.expected_roles).length,4);assert.ok(full.blockers.includes('broker_candidate_origin_unsupported'));
});

test('shared PlanetScale gateway accepts distinct authenticated branch routes only as partial evidence',async()=>{const r=request();r.database.originHost='aws-ap-northeast-1-2.pg.psdb.cloud';r.database.branchId='6260cnpwnkpr';const f=nativeProvider(r,rows=>{for(const [n,row] of rows.slice(0,2).entries()){row.origin.host=r.database.originHost;row.origin.user=row.origin.user.split('.')[0]+'.'+['hol9ueh8mo8k','tcv91thmspbm'][n];}});const result=await inspectCandidateProvider(r,manifest,{client:f.client,accountId:account});assert.equal(result.provider_isolation_status,'partial_observation');assert.equal(result.remote_acceptance,'not_run');assert.equal(result.deployment_authority,false);});

test('same branch remains rejected across changed gateway hosts',async()=>{const r=request();r.database.branchId='synthetic_existing_branch_0';const f=nativeProvider(r);assert.equal((await inspectCandidateProvider(r,manifest,{client:f.client,accountId:account})).provider_isolation_status,'rejected');});
test('untrusted operational routing metadata cannot prove isolation',async()=>{for(const kind of ['bare','extra','role','database','host']){const r=request(),f=nativeProvider(r,rows=>{const b=rows[0];if(kind==='bare')b.origin.user=manifest.environments.next.database.roles.runtime;if(kind==='extra')b.origin.user+='.'+'extra';if(kind==='role')b.origin.user='postgres.synthetic_existing_branch_0';if(kind==='database')b.origin.database='foreign';if(kind==='host')b.origin.host='not-planetscale.example.test';});assert.equal((await inspectCandidateProvider(r,manifest,{client:f.client,accountId:account})).provider_isolation_status,'unavailable',kind);}});
test('authorized foundation bucket prefix remains closed against operational names',()=>{const r=request();r.bucket='freedom-foundation-candidate-20261004-media';assert.equal(planIsolatedCandidate(r,manifest).structural,true);r.bucket=manifest.environments.next.r2_buckets[0].name;assert.equal(planIsolatedCandidate(r,manifest).structural,false);r.bucket='arbitrary-media';assert.equal(planIsolatedCandidate(r,manifest).structural,false);});

test('unknown candidate gateway readback never becomes partial routing evidence',async()=>{const r=request();r.database.originHost='not-planetscale.example.test';const f=nativeProvider(r);const p=await inspectCandidateProvider(r,manifest,{client:f.client,accountId:account});assert.equal(p.provider_isolation_status,'unavailable');assert.equal(p.deployment_authority,false);assert.ok(p.remaining_checks.every(c=>c.status==='not_run'));});
