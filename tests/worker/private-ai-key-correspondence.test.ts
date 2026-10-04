import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';

/** workerd accepts mismatched Ed25519 x/d JWKs that Node rejects at import.
 * The main composition must check actual signers, not trust the declared x. */
test('native main composition verifies every private JWK before enforcing signer separation',async()=>{
  const pairs=await Promise.all(Array.from({length:4},()=>crypto.subtle.generateKey('Ed25519',true,['sign','verify'])));
  const jwk=async(key:CryptoKey)=>{const {kty,crv,x,y,d}=await crypto.subtle.exportKey('jwk',key);return {kty,crv,x,...(y?{y}:{}),...(d?{d}:{})};};
  const request=await jwk(pairs[0].privateKey),response=await jwk(pairs[1].publicKey),recovery=await jwk(pairs[2].publicKey);
  const profile={environment:'staging-next',platformOrigin:'https://platform.test',clientId:'synthetic-key-review',issuer:'main-staging',audience:'broker-staging',
    brokerIdentity:'broker-staging',responseAudience:'main-staging',requestKid:'request',responseKeys:[{keyId:'response',publicJwk:response}],
    recoveryAuthority:'recovery',recoveryKeys:[{keyId:'recovery',publicJwk:recovery}],settingsSelections:[],
    ingest:{setupOrigin:'https://setup.test',issuer:'main-ingest',audience:'broker-ingest',keyId:'ingest'}};
  const independent=await jwk(pairs[3].privateKey);
  // WebCrypto accepts noncanonical base64url pad bits. A different JWK string
  // may still be the same key, so separation must compare actual signatures.
  const alias=(x:string)=>{
    const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const value=x.slice(0,-1)+alphabet[alphabet.indexOf(x.at(-1)!)+1];
    assert.notEqual(value,x);assert.deepEqual(Buffer.from(value,'base64url'),Buffer.from(x,'base64url'));
    return value;
  };
  const bootstrapPairs=await Promise.all(Array.from({length:2},()=>crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify'])));
  const bootstrapPrivate=await jwk(bootstrapPairs[0].privateKey),bootstrapPublic=await jwk(bootstrapPairs[0].publicKey),otherBootstrapPublic=await jwk(bootstrapPairs[1].publicKey);
  const bootstrap={environment:profile.environment,clientId:profile.clientId,issuer:'https://issuer.test/',audience:profile.platformOrigin+'/',
    bootstrapUri:profile.platformOrigin+'/execution-api/v1/bootstrap',beginUri:profile.platformOrigin+'/execution-api/v1/auth/device-authorizations',
    pollUri:profile.platformOrigin+'/execution-api/v1/auth/token',verificationUri:profile.platformOrigin+'/device',clientDisplayName:'Synthetic key review',issuerKid:'bootstrap',
    keys:[{kid:'bootstrap',purpose:'bootstrap_access',environment:profile.environment,publicJwk:bootstrapPublic,notBeforeMs:0,notAfterMs:Number.MAX_SAFE_INTEGER,revoked:false}]};
  const {ingest:omitted,...withoutIngest}=profile;
  const baseBindings={FREEDOM_PRIVATE_AI_ENABLED:'true',FREEDOM_PRIVATE_AI_PROFILE:JSON.stringify(profile),
    FREEDOM_PRIVATE_AI_REQUEST_KEY:JSON.stringify(request),FREEDOM_PRIVATE_AI_INGEST_KEY:JSON.stringify(independent)};
  const cases=[
    {name:'concealed-request-reuse',expected:false,bindings:{...baseBindings,FREEDOM_PRIVATE_AI_REQUEST_KEY:JSON.stringify({...request,x:response.x}),FREEDOM_PRIVATE_AI_INGEST_KEY:JSON.stringify(request)}},
    {name:'mismatched-ingest',expected:false,bindings:{...baseBindings,FREEDOM_PRIVATE_AI_INGEST_KEY:JSON.stringify({...independent,x:request.x})}},
    {name:'mismatched-request-without-ingest',expected:false,bindings:{FREEDOM_PRIVATE_AI_ENABLED:'true',FREEDOM_PRIVATE_AI_PROFILE:JSON.stringify(withoutIngest),FREEDOM_PRIVATE_AI_REQUEST_KEY:JSON.stringify({...request,x:response.x})}},
    {name:'mismatched-bootstrap',expected:false,bindings:{...baseBindings,FREEDOM_PRIVATE_AI_PROFILE:JSON.stringify({...profile,bootstrap}),FREEDOM_PRIVATE_AI_BOOTSTRAP_KEY:JSON.stringify({...bootstrapPrivate,x:otherBootstrapPublic.x,y:otherBootstrapPublic.y})}},
    {name:'aliased-request-ingest-reuse',expected:false,bindings:{...baseBindings,FREEDOM_PRIVATE_AI_REQUEST_KEY:JSON.stringify({...request,x:alias(request.x!)}),FREEDOM_PRIVATE_AI_INGEST_KEY:JSON.stringify(request)}},
    {name:'aliased-response-ingest-reuse',expected:false,bindings:{...baseBindings,FREEDOM_PRIVATE_AI_PROFILE:JSON.stringify({...profile,responseKeys:[{keyId:'response',publicJwk:{kty:'OKP',crv:'Ed25519',x:alias(independent.x!)}}]})}},
    {name:'aliased-recovery-ingest-reuse',expected:false,bindings:{...baseBindings,FREEDOM_PRIVATE_AI_PROFILE:JSON.stringify({...profile,recoveryKeys:[{keyId:'recovery',publicJwk:{kty:'OKP',crv:'Ed25519',x:alias(independent.x!)}}]})}},
    {name:'aliased-request-response-reuse',expected:false,bindings:{FREEDOM_PRIVATE_AI_ENABLED:'true',FREEDOM_PRIVATE_AI_REQUEST_KEY:JSON.stringify(request),FREEDOM_PRIVATE_AI_PROFILE:JSON.stringify({...withoutIngest,responseKeys:[{keyId:'response',publicJwk:{kty:'OKP',crv:'Ed25519',x:alias(request.x!)}}]})}},
    {name:'aliased-independent-keys',expected:true,bindings:{...baseBindings,FREEDOM_PRIVATE_AI_REQUEST_KEY:JSON.stringify({...request,x:alias(request.x!)}),FREEDOM_PRIVATE_AI_INGEST_KEY:JSON.stringify({...independent,x:alias(independent.x!)}),FREEDOM_PRIVATE_AI_PROFILE:JSON.stringify({...profile,responseKeys:[{keyId:'response',publicJwk:{...response,x:alias(response.x!)}}],recoveryKeys:[{keyId:'recovery',publicJwk:{...recovery,x:alias(recovery.x!)}}]})}},
    {name:'matching-all-private-keys',expected:true,bindings:{...baseBindings,FREEDOM_PRIVATE_AI_PROFILE:JSON.stringify({...profile,bootstrap}),FREEDOM_PRIVATE_AI_BOOTSTRAP_KEY:JSON.stringify(bootstrapPrivate)}},
  ];
  await mkdir(resolve('.wrangler'),{recursive:true});const directory=await mkdtemp(resolve('.wrangler/fp-key-correspondence-'));
  let mf:Miniflare|undefined;
  try{
    await build({entryPoints:[resolve('tests/worker/private-ai-fixtures/ingest-composition.ts')],outfile:join(directory,'worker.mjs'),bundle:true,format:'esm',
      platform:'neutral',conditions:['workerd','worker','browser'],external:['node:*'],plugins:[{name:'no-sql-provider-test-capabilities',setup(b){
        b.onResolve({filter:/^pg$/},()=>({path:'pg',namespace:'forbidden-sql'}));
        b.onLoad({filter:/.*/,namespace:'forbidden-sql'},()=>({contents:"export class Pool {constructor(){throw Error('No SQL in key review');}}"}));
        b.onResolve({filter:/model-step-node-transport\.js$/},()=>({path:resolve('modules/agent-execution/model-step-worker-transport-unavailable.ts')}));
      }}]});
    mf=new Miniflare(convertV4MiniflareOptions({workers:cases.map(entry=>({name:entry.name,modules:true,scriptPath:join(directory,'worker.mjs'),
      compatibilityDate:'2026-09-21',compatibilityFlags:['nodejs_compat'],bindings:entry.bindings}))}));
    await mf.ready;
    for(const entry of cases){
      const response=await(await(await mf.getWorker(entry.name)).fetch('https://synthetic.test/')).json() as {installed:boolean;calls:number};
      assert.equal(response.installed,entry.expected,entry.name);assert.equal(response.calls,0);
    }
  }finally{await mf?.dispose();await rm(directory,{recursive:true,force:true});}
});
