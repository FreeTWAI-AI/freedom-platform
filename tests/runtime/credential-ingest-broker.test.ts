import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { CompactSign, compactVerify, base64url } from 'jose';
import { createCredentialIngestCrypto, signCredentialIngestBootstrap } from '../../apps/credential-broker/src/ingest-crypto.js';
import { CredentialIngestResponseClaimsSchema, type CredentialIngestBootstrapClaims } from '../../contracts/execution/v2/model-credential-ingest.js';
import { parseBoundedJson } from '../../packages/execution-state/decode.js';
import { readCredentialIngestBytes } from '../../apps/credential-broker/src/ingest-http.js';

async function fixture(){
  const main=await crypto.subtle.generateKey('Ed25519',false,['sign','verify']),broker=await crypto.subtle.generateKey('Ed25519',false,['sign','verify']);
  const options={environment:'local' as const,clientId:'freedom-platform',issuer:'main-ingest',requestAudience:'broker-ingest',setupOrigin:'https://broker.test',
    requestKeys:new Map([['ingest-main',main.publicKey]]),responseSigningKey:broker.privateKey,responseKeyId:'ingest-broker',responseIssuer:'broker-ingest',responseAudience:'main-ingest'};
  const now=Date.now(),claims:CredentialIngestBootstrapClaims={profile:'credential-ingest.bootstrap/v1',issuer:'main-ingest',audience:'broker-ingest',
    purpose:'credential-broker.ingest-bootstrap',setupOrigin:'https://broker.test',environment:'local',clientId:'freedom-platform',operation:'create',authorizationRef:randomUUID(),
    nonce:randomBytes(32).toString('base64url'),commandDigest:'a'.repeat(64),recoveryGeneration:'1',issuedAt:new Date(now).toISOString(),expiresAt:new Date(now+60_000).toISOString()};
  const port=await createCredentialIngestCrypto(options);
  const rawSign=(payload:unknown=claims,header:Record<string,unknown>={alg:'EdDSA',typ:'freedom-credential-ingest-bootstrap+jws',kid:'ingest-main'})=>
    new CompactSign(new TextEncoder().encode(JSON.stringify(payload))).setProtectedHeader(header as {alg:string}).sign(main.privateKey);
  return {main,broker,options,claims,port,rawSign};
}
// Transport-only actual WebCrypto tests. Genuine SQL/session/intent and full
// isolated encrypted custody are exercised by the independent process suite.
test('ingest cryptographic directions are distinct and safe responses bind the exact signed bootstrap',async()=>{
  const f=await fixture(),assertion=await signCredentialIngestBootstrap(f.claims,f.main.privateKey,'ingest-main');
  assert.deepEqual(await f.port.verify(assertion),f.claims);
  const envelope=await f.port.response(f.claims,{kind:'problem',code:'credential_ingest_unavailable'});
  const verified=await compactVerify(envelope.response,f.broker.publicKey,{algorithms:['EdDSA']});
  const payload=CredentialIngestResponseClaimsSchema.parse(parseBoundedJson(new TextDecoder().decode(verified.payload)));
  assert.equal(payload.authorizationRef,f.claims.authorizationRef);assert.equal(payload.nonce,f.claims.nonce);assert.equal(payload.commandDigest,f.claims.commandDigest);
  assert.equal(payload.purpose,'credential-broker.ingest-response');assert.equal(payload.operational_authority,false);
  assert.equal(Date.parse(payload.expiresAt)-Date.parse(payload.issuedAt),10_000);
  await assert.rejects(compactVerify(envelope.response,f.main.publicKey));
  await assert.rejects(createCredentialIngestCrypto({...f.options,responseSigningKey:f.main.privateKey}));
});
test('ingest purpose, pinned issuer/origin/client and strict header deny even genuinely signed wrong claims',async()=>{
  const f=await fixture();
  for(const change of[{issuer:'other'},{audience:'other'},{setupOrigin:'https://attacker.test'},{purpose:'model-broker.activate'},
    {clientId:'other'},{environment:'staging-next'},{actor:{user_id:randomUUID()}},{key:'synthetic-key-must-not-be-a-claim'},
    {expiresAt:new Date(Date.now()-1).toISOString()},{issuedAt:new Date(Date.now()+1000).toISOString()},
    {expiresAt:new Date(Date.parse(f.claims.issuedAt)+60001).toISOString()}])await assert.rejects(f.port.verify(await f.rawSign({...f.claims,...change})));
  for(const change of[{kid:'unknown'},{jwk:{kty:'OKP'}},{typ:'freedom-model-broker-assertion+jws'}])await assert.rejects(f.port.verify(await f.rawSign(f.claims,
    {alg:'EdDSA',typ:'freedom-credential-ingest-bootstrap+jws',kid:'ingest-main',...change})));
});
test('ingest compact grammar rejects decoded duplicate JSON, tamper, noncanonical base64 and extra segments',async()=>{
  const f=await fixture(),valid=await f.rawSign(),parts=valid.split('.');
  parts[1]=base64url.encode(JSON.stringify({...f.claims,commandDigest:'b'.repeat(64)}));await assert.rejects(f.port.verify(parts.join('.')));
  const raw=JSON.stringify(f.claims).replace('"issuer":"main-ingest"','"issuer":"main-ingest","iss\\u0075er":"main-ingest"');
  const duplicate=await new CompactSign(new TextEncoder().encode(raw)).setProtectedHeader({alg:'EdDSA',typ:'freedom-credential-ingest-bootstrap+jws',kid:'ingest-main'}).sign(f.main.privateKey);
  await assert.rejects(f.port.verify(duplicate));await assert.rejects(f.port.verify(valid+'='));await assert.rejects(f.port.verify(valid+'.extra'));
  await assert.rejects(f.port.verify('a'.repeat(8193)));await assert.rejects(createCredentialIngestCrypto({...f.options,requestKeys:new Map()}));
});

function budget(timeoutMs=5000){return {maxBytes:4096,maxChunks:128,timeoutMs,expiresAt:new Date(Date.now()+5000).toISOString(),monotonicDeadline:performance.now()+5000};}
test('secret byte reader owns the result and clears transport chunks on success and exact-length rejection',async()=>{
  const source=new TextEncoder().encode('Synthetic_key-123'),snapshot=new Uint8Array(source);
  const stream=new ReadableStream<Uint8Array>({start(c){c.enqueue(source);c.close();}},{highWaterMark:0});
  const result=await readCredentialIngestBytes(stream,new AbortController().signal,source.length,budget());
  assert.deepEqual(result,snapshot);assert.ok(source.every(v=>v===0));result.fill(0);
  const mismatch=new TextEncoder().encode('Synthetic_other');
  await assert.rejects(readCredentialIngestBytes(new ReadableStream({start(c){c.enqueue(mismatch);c.close();}},{highWaterMark:0}),new AbortController().signal,1,budget()));
  assert.ok(mismatch.every(v=>v===0));
});
test('late secret chunk after exclusive timeout is cleared without waiting for hostile cancellation',async()=>{
  let resolve!:(value:ReadableStreamReadResult<Uint8Array>)=>void;
  const late=new TextEncoder().encode('Synthetic_late-secret');let cancelled=0,released=0;
  const stream={getReader(){return {read(){return new Promise<ReadableStreamReadResult<Uint8Array>>(r=>{resolve=r;});},
    cancel(){cancelled++;return new Promise<void>(()=>{});},releaseLock(){released++;}};}} as unknown as ReadableStream<Uint8Array>;
  await assert.rejects(readCredentialIngestBytes(stream,new AbortController().signal,late.length,budget(10)));
  assert.equal(cancelled,1);assert.equal(released,1);resolve({done:false,value:late});await new Promise<void>(r=>setImmediate(r));
  assert.ok(late.every(v=>v===0));
});
