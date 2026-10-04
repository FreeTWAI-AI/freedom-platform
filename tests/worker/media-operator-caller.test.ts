import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
// @ts-expect-error Canonical tooling is JavaScript without a declaration file.
import {verificationEnvironment} from '../../packages/contribution-tools/process-env.mjs';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {planOperatorBackfill} from '../../packages/media-migration/operator-backfill.js';
const directory=await mkdtemp(join(tmpdir(),'fp-media-caller-bundle-'));
let source:string;
try{await promisify(execFile)(process.execPath,['node_modules/wrangler/bin/wrangler.js','deploy','--dry-run','--config','wrangler.media-operator-caller.example.jsonc','--outdir',directory],{env:{...verificationEnvironment(),WRANGLER_SEND_METRICS:'false',XDG_CONFIG_HOME:join(directory,'config')},timeout:30000,maxBuffer:262144});source=await readFile(join(directory,'worker.js'),'utf8');}finally{await rm(directory,{recursive:true,force:true});}
const plan=planOperatorBackfill({target:{environment:'staging',database:'freedom_staging_next',schema:'public',role:'freedom_media_migrator',releaseSha:'a'.repeat(40)},jobId:'11111111-1111-4111-8111-111111111111',logicalStore:'MEDIA',storeBindingId:'synthetic-store',migrationId:'synthetic-migration',purpose:'member.service-cover',maxRows:1,maxBytes:3145728,leaseSeconds:10});
const bindings={FREEDOM_MEDIA_CALLER_ENABLED:'true',FREEDOM_MEDIA_CALLER_ENVIRONMENT:'staging',FREEDOM_MEDIA_CALLER_RELEASE_SHA:plan.target.releaseSha,FREEDOM_MEDIA_CALLER_STORE_BINDING_ID:plan.storeBindingId,FREEDOM_MEDIA_CALLER_PLAN:JSON.stringify(plan)};
async function fixture(extra:Record<string,string|undefined>={},fault=false){
 return new Miniflare(convertV4MiniflareOptions({workers:[
  {name:'caller',modules:true,script:source,compatibilityDate:'2026-09-21',compatibilityFlags:['nodejs_compat'],bindings:Object.fromEntries(Object.entries({...bindings,...extra}).filter(([,value])=>value!==undefined)),serviceBindings:{MEDIA_OPERATOR:{name:'operator',entrypoint:'MediaOperator'}}},
  {name:'operator',bindings:{FAULT:fault?'true':'false'},modules:true,script:`import {WorkerEntrypoint} from 'cloudflare:workers';let plans=[];export class MediaOperator extends WorkerEntrypoint {async execute(plan){plans.push(plan);if(this.env.FAULT==='true')throw new Error('synthetic unknown acknowledgement');return {status:'synthetic'};}}export default {fetch(){return Response.json(plans);}};`,compatibilityDate:'2026-09-21'}
 ]}));
}
test('actual workerd scheduled handler invokes named private RPC once with exact installed plan; HTTP cannot invoke',async()=>{
 const {planSha256,...base}=plan;
 for(const purpose of ['member.service-cover','community.event-video','community.event-banner','community.social-thumbnail','skill.submission-image','community.event-highlight','member.avatar'] as const){
  const installed=planOperatorBackfill({...base,purpose,maxBytes:purpose==='community.event-video'?125829120:purpose==='community.event-highlight'?8388608:3145728});
  const mf=await fixture({FREEDOM_MEDIA_CALLER_PLAN:JSON.stringify(installed)});try{
   const response=await mf.dispatchFetch('http://caller.test/execute');assert.equal(response.status,404);
   const caller=await mf.getWorker('caller');const scheduled=await caller.scheduled();assert.equal(scheduled.outcome,'ok');
   const operator=await mf.getWorker('operator');assert.deepEqual(await (await operator.fetch('http://operator.test/')).json(),[installed]);
  }finally{await mf.dispose();}
 }
});
test('default off, wrong hash/environment/role and unknown flag cannot invoke named RPC',async()=>{
 for(const override of [{FREEDOM_MEDIA_CALLER_ENABLED:undefined},{FREEDOM_MEDIA_CALLER_ENABLED:'false'},{FREEDOM_MEDIA_CALLER_ENABLED:'TRUE'},
  {FREEDOM_MEDIA_CALLER_ENVIRONMENT:'public'}, {FREEDOM_MEDIA_CALLER_PLAN:JSON.stringify({...plan,planSha256:'f'.repeat(64)})},
  {FREEDOM_MEDIA_CALLER_PLAN:JSON.stringify({...plan,target:{...plan.target,role:'freedom_staging_next_app'}})}]){
  const mf=await fixture(override);try{
   const caller=await mf.getWorker('caller');await caller.scheduled();
   const operator=await mf.getWorker('operator');assert.deepEqual(await (await operator.fetch('http://operator.test/')).json(),[]);
  }finally{await mf.dispose();}
 }
});

test('unknown private RPC acknowledgement is one attempt with no automatic retry',async()=>{
 const mf=await fixture({},true);try{
  const caller=await mf.getWorker('caller');assert.equal((await caller.scheduled()).outcome,'exception');
  const operator=await mf.getWorker('operator');assert.deepEqual(await (await operator.fetch('http://operator.test/')).json(),[plan]);
 }finally{await mf.dispose();}
});
