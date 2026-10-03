import assert from 'node:assert/strict';
import {test,before,after} from 'node:test';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {CompactSign,compactVerify} from 'jose';
import {ModelBrokerResponseEnvelopeSchema,ModelBrokerResponsePayloadSchema} from '../../contracts/execution/v2/model-broker-bridge.js';
import {createModelBrokerServiceBindingExchange} from '../../apps/platform-api/src/model-broker-service-binding.js';
import {createBrokerServiceBindingReceiver} from '../../apps/credential-broker/src/service-binding.js';
import {workerPrivateAiPorts} from '../../apps/platform-api/src/worker-private-ai.js';
import type {Pool} from 'pg';
const requestKeys=await crypto.subtle.generateKey('Ed25519',true,['sign','verify']),responseKeys=await crypto.subtle.generateKey('Ed25519',true,['sign','verify']);
async function minimalJwk(key:CryptoKey){const {kty,crv,x,d}=await crypto.subtle.exportKey('jwk',key);return {kty,crv,x,...(d?{d}:{})};}
let directory:string,mf:Miniflare;
before(async()=>{
  directory=await mkdtemp(resolve('.wrangler/fp-worker-binding-'));
  for(const name of ['sender','receiver','issuer'])await build({entryPoints:[resolve('tests/worker/private-ai-fixtures/'+name+'.ts')],outfile:join(directory,name+'.mjs'),bundle:true,format:'esm',platform:'neutral',conditions:['workerd','worker','browser'],external:['node:*']});
  mf=new Miniflare(convertV4MiniflareOptions({workers:[{name:'issuer-key-check',modules:true,scriptPath:join(directory,'issuer.mjs'),compatibilityDate:'2026-09-21'}, {name:'main-transport',modules:true,scriptPath:join(directory,'sender.mjs'),compatibilityDate:'2026-09-21',compatibilityFlags:['nodejs_compat'],serviceBindings:{MODEL_BROKER:'broker-transport'}},
    {name:'broker-transport',modules:true,scriptPath:join(directory,'receiver.mjs'),compatibilityDate:'2026-09-21',compatibilityFlags:['nodejs_compat'],bindings:{REQUEST_PUBLIC:JSON.stringify(await minimalJwk(requestKeys.publicKey)),RESPONSE_PRIVATE:JSON.stringify(await minimalJwk(responseKeys.privateKey))}}]}));await mf.ready;
});
after(async()=>{await mf?.dispose();if(directory)await rm(directory,{recursive:true,force:true});});
async function request(overrides:Record<string,unknown>={},signing=requestKeys.privateKey){const now=Date.now(),payload={profile:'model-broker.assertion/v1',issuer:'main-staging',audience:'broker-staging',environment:'staging-next',clientId:'worker-binding-test',
  operation:'activate',purpose:'model-broker.activate',authorizationRef:randomUUID(),nonce:'A'.repeat(43),commandDigest:'a'.repeat(64),recoveryGeneration:'1',issuedAt:new Date(now).toISOString(),expiresAt:new Date(now+60000).toISOString(),...overrides};
  const assertion=await new CompactSign(new TextEncoder().encode(JSON.stringify(payload))).setProtectedHeader({alg:'EdDSA',typ:'freedom-model-broker-assertion+jws',kid:'main-request'}).sign(signing);
  return {payload,body:{authorizationRef:payload.authorizationRef,nonce:payload.nonce,assertion}};}
async function send(body:unknown){return (await mf.getWorker('main-transport')).fetch('https://main.test/',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});}
test('native workerd service binding authenticates genuine purpose-separated signatures without exposing member or provider authority',async()=>{
  const input=await request(),response=await send(input.body);
  assert.equal(response.status,200);
  const envelope=ModelBrokerResponseEnvelopeSchema.parse(await response.json()),verified=await compactVerify(envelope.response,responseKeys.publicKey,{algorithms:['EdDSA']});
  const reply=ModelBrokerResponsePayloadSchema.parse(JSON.parse(new TextDecoder().decode(verified.payload)));
  assert.equal(reply.authorizationRef,input.payload.authorizationRef);assert.equal(reply.nonce,input.payload.nonce);assert.equal(reply.environment,'staging-next');
  assert.deepEqual(reply.outcome,{kind:'problem',code:'model_broker_registry_unavailable'});assert.equal(reply.operational_authority,false);
});
for(const [name,overrides] of [['environment',{environment:'next'}],['client',{clientId:'foreign-client'}],['purpose',{purpose:'credential-ingest.create'}],['audience',{audience:'foreign-broker'}]] as const)
  test('native binding refuses wrong '+name,async()=>{assert.equal((await send((await request(overrides)).body)).status,503);});
test('native binding refuses wrong signer and locator substitution',async()=>{
  const input=await request({},responseKeys.privateKey);assert.equal((await send(input.body)).status,503);
  const valid=await request();assert.equal((await send({...valid.body,authorizationRef:randomUUID()})).status,503);
});
test('genuine receiver cannot be constructed from a copied or forged bridge',()=>{
  assert.throws(()=>createBrokerServiceBindingReceiver({handle:async()=>({response:'a.b.c'})} as never),/Broker ports are unavailable/);
});
test('main service binding refuses redirects, cookies and unbounded/malformed output',async()=>{
  const input=await request();for(const response of [new Response('',{status:302,headers:{Location:'https://foreign.test/'}}),
    Response.json({response:'a.b.c'},{headers:{'Set-Cookie':'foreign=1'}}),new Response('x'.repeat(32769),{headers:{'Content-Type':'application/json'}}),
    new Response('{"response":"a.b.c","response":"a.b.c"}',{headers:{'Content-Type':'application/json'}})])
    await assert.rejects(createModelBrokerServiceBindingExchange({fetch:async()=>response})(input.body),/Broker service binding is unavailable/);
});
test('missing or partial Worker bindings stay inactive without DB or service calls',async()=>{
  const pool={query(){throw new Error('Must not touch DB');}} as unknown as Pool;
  for(const bindings of [{},{FREEDOM_PRIVATE_AI_ENABLED:'false'},{FREEDOM_PRIVATE_AI_ENABLED:'true'},
    {FREEDOM_PRIVATE_AI_ENABLED:'true',FREEDOM_PRIVATE_AI_PROFILE:'{"clientId":"partial"}'}])
    assert.equal(await workerPrivateAiPorts(pool,bindings,{origin:'https://main.test',freedomEnv:'staging'}),undefined);
});
test('actual Wrangler Worker bundle excludes native provider transport and Node listeners',async()=>{
  const bundle=await readFile(resolve(process.env.FREEDOM_WORKERD_BUNDLE_DIR??'.wrangler/dry-run/private-ai','worker.js'),'utf8');
  assert(!bundle.includes('model-step-node-transport.ts'));assert(!/from ["']node:(?:https|http)["']/.test(bundle));
  const load=new Miniflare(convertV4MiniflareOptions({workers:[{name:'main-bundle',modules:true,scriptPath:resolve(process.env.FREEDOM_WORKERD_BUNDLE_DIR??'.wrangler/dry-run/private-ai','worker.js'),compatibilityDate:'2026-09-21',compatibilityFlags:['nodejs_compat']}]}));
  try{await load.ready;const response=await load.dispatchFetch('https://main.test/api/v1/me/model-settings');assert.equal(response.status,503);}finally{await load.dispose();}
});
test('Worker profile environment and exact platform origin reject before DB or binding calls',async()=>{
  const publicJwk=await minimalJwk(responseKeys.publicKey),privateJwk=await minimalJwk(requestKeys.privateKey);
  const profile={environment:'staging-next',platformOrigin:'https://main.test',clientId:'worker-profile-test',issuer:'main-staging',audience:'broker-staging',
    brokerIdentity:'broker-staging',responseAudience:'main-staging',requestKid:'main-request',responseKeys:[{keyId:'broker-response',publicJwk}],
    recoveryAuthority:'recovery-staging',recoveryKeys:[{keyId:'recovery-signing',publicJwk}],settingsSelections:[]};
  let calls=0;const binding=()=>({async fetch(){calls++;throw new Error('Must not call binding');}});
  const env={FREEDOM_PRIVATE_AI_ENABLED:'true',FREEDOM_PRIVATE_AI_REQUEST_KEY:JSON.stringify(privateJwk),MODEL_BROKER:binding(),CREDENTIAL_RECOVERY_STATE:binding(),CREDENTIAL_RECOVERY_FLOOR:binding(),MEDIA:{} as never};
  const pool={query(){calls++;throw new Error('Must not touch DB');}} as unknown as Pool;
  for(const overrides of [{environment:'next'},{platformOrigin:'https://foreign.test'}])assert.equal(await workerPrivateAiPorts(pool,{...env,FREEDOM_PRIVATE_AI_PROFILE:JSON.stringify({...profile,...overrides})},{origin:'https://main.test',freedomEnv:'staging'}),undefined);
  assert.equal(calls,0);
});

test('native Worker extractable key cannot spoof nonextractability through native-shaped own metadata',async()=>{
  const worker=await mf.getWorker('issuer-key-check');
  assert.deepEqual(await(await worker.fetch('https://issuer.test/check')).json(),{rejected:true});
});
