import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {loadManifest} from '../lib/manifest.mjs';
import {MEDIA_WORKER_FEATURES} from '../lib/media-wrangler.mjs';
import {planIsolatedCandidate,inspectCandidateProvider,createCandidateProviderReader} from '../lib/isolated-candidate.mjs';
import {runCandidateAdmission} from '../candidate-admission.mjs';
const manifest=loadManifest(),account='a'.repeat(32);
const request=()=>({schema:'freedom.isolated-candidate-request/v1',environment:'staging-next',releaseSha:'b'.repeat(40),hostname:'base-candidate-unit.example.test',workers:{main:'fp-base-candidate-unit-main',broker:'fp-base-candidate-unit-broker',operator:'fp-base-candidate-unit-operator'},database:{branchId:'synthetic_branch_id',originHost:'synthetic-new-branch.example.test'},hyperdrive:{main:'1'.repeat(32),cipher:'2'.repeat(32),executor:'3'.repeat(32),operator:'4'.repeat(32)},bucket:'fp-base-candidate-unit-media'});
function nativeProvider(r=request(),mutate=()=>{}){
 const calls=[],roles=planIsolatedCandidate(r,manifest).expected_roles;
 const operational=Object.values(manifest.environments).map((e,n)=>({id:String(n+8).repeat(32),name:e.hyperdrive.name,origin:{host:`existing-${n}.example.test`,database:e.database.dbname,user:e.database.roles.runtime}}));
 const rows=[...operational,...Object.entries(r.hyperdrive).map(([key,id])=>({id,name:`candidate-${key}`,caching:{disabled:true},origin:{host:r.database.originHost,database:'freedom_staging_next',user:roles[key]}}))];
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
 for(const mutate of [r=>r.isolation=true,r=>r.routes=['freetwai.com/*'],r=>r.environment='next',r=>r.workers.secret='PRIVATE_SECRET',r=>r.hostname='x'.repeat(254),r=>r.database.password='PRIVATE_SECRET',r=>r.bucket='REPLACE_PRIVATE\nBearer PRIVATE_SECRET']){const r=request();mutate(r);const p=planIsolatedCandidate(r,manifest);assert.equal(p.structural,false);assert.ok(!JSON.stringify(p).includes('PRIVATE_SECRET'));assert.equal(p.configs,undefined);}
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
for(const boundary of ['shared-id','shared-origin','cache','role','database'])test(`provider ${boundary} is rejected using readback, not caller isolation claim`,async()=>{
 const r=request(),f=nativeProvider(r,rows=>{const c=rows[2];if(boundary==='shared-id')r.hyperdrive.main=rows[0].id;if(boundary==='shared-origin'){r.database.originHost=rows[0].origin.host;for(const row of rows.slice(2))row.origin.host=r.database.originHost;}if(boundary==='cache')c.caching.disabled=false;if(boundary==='role')c.origin.user='postgres';if(boundary==='database')c.origin.database='freedom_next';});
 const p=await inspectCandidateProvider(r,manifest,{client:f.client,accountId:account});assert.equal(p.provider_isolation_status,'rejected');assert.equal(p.deployment_authority,false);
});
test('partial provider inventory or exceptions never prove absence and never print private diagnostics',async()=>{
 for(const client of [{get:async()=>({http:200,success:true,result:[],result_info:{total_count:4}})},{get:async()=>{throw Error('postgres://PRIVATE_SECRET');}}]){const p=await inspectCandidateProvider(request(),manifest,{client,accountId:account});assert.equal(p.provider_isolation_status,'unavailable');assert.ok(!JSON.stringify(p).includes('PRIVATE_SECRET'));}
 const f=nativeProvider();await assert.rejects(f.client.get(`/accounts/${account}/r2/buckets/unsafe/delete`));assert.equal(f.calls.length,0);
});
test('default CLI never accesses environment/fetch and rejects execute/credentials flags',()=>{
 const saved=globalThis.fetch;globalThis.fetch=()=>{throw Error('network must not run');};try{const p=runCandidateAdmission([]);assert.equal(p.exitCode,2);assert.equal(p.report.database_connections,0);for(const args of [['--execute'],['--token','PRIVATE_SECRET'],['--request'],['--request','--execute']]){const result=runCandidateAdmission(args);assert.equal(result.exitCode,1);assert.ok(!JSON.stringify(result).includes('PRIVATE_SECRET'));}}finally{globalThis.fetch=saved;}
});
