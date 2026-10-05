import assert from 'node:assert/strict';
import {after,before,test} from 'node:test';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';

let directory:string;
const pairs=await Promise.all(Array.from({length:4},()=>crypto.subtle.generateKey('Ed25519',true,['sign','verify'])));
async function jwk(key:CryptoKey){const {kty,crv,x,d}=await crypto.subtle.exportKey('jwk',key);return {kty,crv,x,...(d?{d}:{})};}
const requestKey=await jwk(pairs[0].privateKey),responseKey=await jwk(pairs[1].publicKey),recoveryKey=await jwk(pairs[2].publicKey),ingestKey=await jwk(pairs[3].privateKey);
const ingest={setupOrigin:'https://setup.test',issuer:'main-ingest-staging',audience:'broker-ingest-staging',keyId:'main-ingest'};
const profile={environment:'staging-next',platformOrigin:'https://platform.test',clientId:'synthetic-worker-ingest',issuer:'main-staging',audience:'broker-staging',
  brokerIdentity:'broker-staging',responseAudience:'main-staging',requestKid:'main-request',responseKeys:[{keyId:'broker-response',publicJwk:responseKey}],
  recoveryAuthority:'recovery-staging',recoveryKeys:[{keyId:'recovery-key',publicJwk:recoveryKey}],settingsSelections:[],ingest};
before(async()=>{
  await mkdir(resolve('.wrangler'),{recursive:true});
  directory=await mkdtemp(resolve('.wrangler/fp-ingest-composition-'));
  await build({entryPoints:[resolve('tests/worker/private-ai-fixtures/ingest-composition.ts')],outfile:join(directory,'worker.mjs'),
    bundle:true,format:'esm',platform:'neutral',conditions:['workerd','worker','browser'],external:['node:*'],plugins:[{name:'no-sql-provider-test-capabilities',setup(b){
      b.onResolve({filter:/^pg$/},()=>({path:'pg',namespace:'forbidden-sql'}));
      b.onLoad({filter:/.*/,namespace:'forbidden-sql'},()=>({contents:"export class Pool {constructor(){throw new Error('SQL is unavailable in composition fixture');}}"}));
      b.onResolve({filter:/model-step-node-transport\.js$/},()=>({path:resolve('modules/agent-execution/model-step-worker-transport-unavailable.ts')}));
    }}]});
});
after(async()=>{if(directory)await rm(directory,{recursive:true,force:true});});
async function check(profileValue:unknown=profile,key:unknown=ingestKey){
  const mf=new Miniflare(convertV4MiniflareOptions({workers:[{name:'synthetic-ingest-composition',modules:true,scriptPath:join(directory,'worker.mjs'),
    compatibilityDate:'2026-09-21',compatibilityFlags:['nodejs_compat'],bindings:{FREEDOM_PRIVATE_AI_ENABLED:'true',
      FREEDOM_PRIVATE_AI_PROFILE:JSON.stringify(profileValue),FREEDOM_PRIVATE_AI_REQUEST_KEY:JSON.stringify(requestKey),
      ...(key===null?{}:{FREEDOM_PRIVATE_AI_INGEST_KEY:typeof key==='string'?key:JSON.stringify(key)})}}]}));
  try {await mf.ready;return await(await mf.dispatchFetch('https://test.invalid/')).json() as {installed:boolean;setupOrigin?:string|null;status?:number;body?:{code:string};calls:number};}
  finally{await mf.dispose();}
}
test('native Worker installs genuine optional ingest child and derives browser setup origin with zero external I/O',async()=>{
  const result=await check();assert.equal(result.installed,true);assert.equal(result.setupOrigin,ingest.setupOrigin);
  assert.equal(result.status,405);assert.equal(result.body?.code,'method_not_allowed');assert.equal(result.calls,0);
});
test('native Worker keeps absent optional ingest unavailable while retaining the product',async()=>{
  const {ingest:omitted,...base}=profile;
  const result=await check(base,null);
  assert.equal(result.installed,true);assert.equal(result.setupOrigin,null);assert.equal(result.status,503);
  assert.equal(result.body?.code,'credential_ingest_unavailable');assert.equal(result.calls,0);
  assert.deepEqual(await check(base),{installed:false,calls:0});
  assert.deepEqual(await check(profile,null),{installed:false,calls:0});
});
test('native Worker refuses incomplete, injected and cross-origin ingest installation before I/O',async()=>{
  for(const bad of [{...ingest,setupOrigin:'https://platform.test:9443'},{...ingest,setupOrigin:'http://setup.test'},
    {...ingest,setupOrigin:'https://setup.test/'},{...ingest,providerUrl:'https://provider.test'},
    {...ingest,keyId:'bad key'}])assert.deepEqual(await check({...profile,ingest:bad}),{installed:false,calls:0});
  for(const key of ['',JSON.stringify({...ingestKey,providerKey:'must-not-be-accepted'}),'x'.repeat(4097)])
    assert.deepEqual(await check(profile,key),{installed:false,calls:0});
});
test('native Worker refuses ingest signer reuse across model request, broker response and recovery directions',async()=>{
  for(const pair of pairs.slice(0,3))assert.deepEqual(await check(profile,await jwk(pair.privateKey)),{installed:false,calls:0});
});
