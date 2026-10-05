import {test} from 'node:test';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {PRIVATE_AI_PREPARE_ENV,ACCOUNT_ENV,ACCESS_ENV} from '../../scripts/verify-cloud-candidate.js';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,readdir} from 'node:fs/promises';
import {join} from 'node:path';import {tmpdir} from 'node:os';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {compactVerify,importJWK,calculateJwkThumbprint} from 'jose';
import {createRuntimeRegistrationChallenge,verifyRuntimeRegistrationProof} from '../../modules/agent-control/runtime-proof.js';
import {DevicePairingBeginClaimsSchema,DevicePairingPollClaimsSchema} from '../../contracts/execution/v1/device-pairing.js';
import {runPrivateAiPrepare,validatePrivateAiPrepare,type PrivateAiPrepareConfig} from '../../scripts/verify-cloud-private-ai-prepare.js';
import {CandidateClient,Secrets,candidateTarget,selectPhases,runCandidate,type Transport} from '../../scripts/verify-cloud-candidate-lib.js';
const origin='https://staging.freetwai.com',release='a'.repeat(40),account={label:'test-owner',email:'owner@example.invalid',password:'synthetic-only'};
async function fixture(failure:'none'|'begin_ack'|'review_binding'|'challenge_binding'|'model_ack'='none'){
 const directory=await mkdtemp(join(tmpdir(),'fp-prepare-'));
 const c:PrivateAiPrepareConfig={profile:'private-ai.staging-owner-prepare/v1',mainOrigin:origin,environment:'staging-next',setupOrigin:'https://synthetic-broker.freetwai.com',mainReleaseSha:release,brokerReleaseSha:release,bindingReviewSha256:'b'.repeat(64),accountLabel:account.label,clientId:'synthetic-client',model:'synthetic/model',receiptDirectory:directory,paidExecution:false,syntheticOwner:true};
 const userId=randomUUID(),connectionId=randomUUID(),runtimeDeviceId=randomUUID(),familyId=randomUUID();
 const bytes=()=>randomBytes(32).toString('base64url'),secretToken='synthetic-bootstrap-access-token',refreshHandle=bytes();
 const selection={providerRef:'openrouter',modelRef:c.model,processingLocation:'provider_remote',artifactCustody:'platform_asset',credentialCustody:'platform_vault',engineLocation:'platform',billingSource:'user_byok'};
 let begin:any,publicJwk:any,challenge:any,issued=false,model:any=null,polls=0,login=0,lastPoll=0;const requests:any[]=[],metrics:Record<string,unknown>={};const proofIds=new Set<string>();
 const overview=()=>({profile:'member-model-settings/v1',connections:issued?[{connectionId,runtimeDeviceId,state:'active',aggregateVersion:'1',expiresAt:new Date(Date.now()+60000).toISOString()}]:[],models:model?[model]:[],credentials:[],selectionOptions:[selection],setup:{state:'installed',setupOrigin:c.setupOrigin},limit:50,operational_authority:false});
 const secrets=new Secrets();
 let revoked=false;const transport:Transport=async req=>{
  requests.push(req);const path=new URL(req.url).pathname,h=new Headers(req.headers),body=req.body?JSON.parse(String(req.body)):undefined;
  assert.equal(h.get('CF-Access-Client-Id'),'synthetic-access');assert.equal(new URL(req.url).origin,origin);
  const respond=(value:unknown,status=200)=>({status,headers:new Headers(),body:Buffer.from(JSON.stringify(value))});
  if(path==='/api/v1/health')return{...respond({status:'ok',mode:'staging',version:'1.0.0',money_movement_enabled:false,official:false,runtime:'cloudflare-workers',release_sha:release}),headers:new Headers({'Content-Type':'application/json','Cache-Control':'no-store'})};
  if(path==='/api/v1/auth/login'){await readFile(join(directory,'prepare-intent.json'));login++;return{status:200,headers:new Headers({'set-cookie':'freedom_local_session=synthetic-session-cookie; Path=/; Secure; HttpOnly; SameSite=Lax'}),body:Buffer.from(JSON.stringify({user:{user_id:userId,email:account.email},csrf_token:'synthetic-csrf'}))};}
  if(path==='/api/v1/auth/logout'){revoked=true;return{...respond({}),headers:new Headers({'Cache-Control':'no-store','set-cookie':'freedom_local_session=; Path=/; Max-Age=0; Secure; HttpOnly'})};}
  if(path==='/api/v1/session'){assert(revoked);return respond({code:'session_expired'},401);}
  if(!path.startsWith('/execution-api/'))assert.equal(h.get('Cookie'),'freedom_local_session=synthetic-session-cookie');
  if(path==='/api/v1/me/model-settings')return respond(overview());
  if(path.startsWith('/execution-api/')){
   assert.equal(h.get('Cookie'),null);assert.equal(h.get('X-CSRF-Token'),null);assert.equal(h.get('Authorization'),null);assert.equal(h.get('Origin'),null);
   const proof=h.get('DPoP')!,header=JSON.parse(Buffer.from(proof.split('.')[0],'base64url').toString());
   const checked=await compactVerify(proof,await importJWK(header.jwk,'ES256'));
   assert.equal(checked.protectedHeader.typ,'freedom-device-pairing+jwt');
   const claims=JSON.parse(new TextDecoder().decode(checked.payload));
   assert.equal(claims.htu,origin+path);assert.equal(claims.htm,'POST');assert.equal(claims.environment,c.environment);assert.equal(claims.client_id,c.clientId);assert.equal(claims.runtime_kind,'agent-kit');assert.equal(claims.scope,'bootstrap.status.read');
   assert(!proofIds.has(claims.jti));proofIds.add(claims.jti);
   if(path.endsWith('/device-authorizations')){
    DevicePairingBeginClaimsSchema.parse(claims);publicJwk=body.publicJwk;assert.deepEqual(header.jwk,publicJwk);assert(!('d'in publicJwk));
    begin={authorizationId:randomUUID(),deviceCode:bytes(),userCode:'12345-67890',nonce:bytes(),requestDigest:bytes(),verificationUri:origin+'/device',issuedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+300000).toISOString(),expiresIn:300,interval:5,operational_authority:false};
    // Ensure canonical exact TTL independent of milliseconds between reads.
    begin.expiresAt=new Date(Date.parse(begin.issuedAt)+300000).toISOString();lastPoll=performance.now();
    if(failure==='begin_ack')throw Error('synthetic lost acknowledgement');return respond(begin,201);
   }
   assert.equal(path,'/execution-api/v1/auth/token');DevicePairingPollClaimsSchema.parse(claims);assert.deepEqual(header.jwk,publicJwk);
   assert(performance.now()-lastPoll>=5000);lastPoll=performance.now();
   assert.equal(claims.authorization_id,begin.authorizationId);assert.equal(claims.nonce,begin.nonce);assert.equal(claims.request_digest,begin.requestDigest);assert.equal(claims.device_code_hash,createHash('sha256').update(begin.deviceCode,'ascii').digest('base64url'));
   assert.equal(body.authorizationId,begin.authorizationId);assert.equal(body.deviceCode,begin.deviceCode);assert.equal(body.grantType,'device_code');polls++;
   if(polls===1){const now=Date.now();challenge=createRuntimeRegistrationChallenge({challenge_id:randomUUID(),owner_member_id:failure==='challenge_binding'?randomUUID():userId,owner_principal_id:randomUUID(),scope_id:randomUUID(),runtime_device_id:runtimeDeviceId,environment:c.environment,key_thumbprint:await calculateJwkThumbprint(publicJwk),nonce:bytes(),issued_at:new Date(now).toISOString(),expires_at:new Date(now+300000).toISOString()});return respond({status:'proof_required',challenge,interval:5,operational_authority:false});}
   assert.equal(polls,2);assert(await verifyRuntimeRegistrationProof({proof:body.enrollmentProof,challenge,public_jwk:publicJwk}));issued=true;
   const now=new Date().toISOString(),future=new Date(Date.now()+60000).toISOString();return respond({status:'issued',accessToken:secretToken,tokenType:'DPoP',expiresAt:future,connectionId,runtimeDeviceId,nonce:{nonceId:randomUUID(),nonce:bytes(),connectionId,issuedAt:now,expiresAt:future,operational_authority:false},refreshSupported:true,refresh:{familyId,generation:'1',handle:refreshHandle,expiresAt:future},operational_authority:false});
  }
  assert.equal(h.get('Origin'),origin);assert.equal(h.get('X-CSRF-Token'),'synthetic-csrf');
  if(path.endsWith('/inspect')){assert.equal(h.get('If-Match'),null);assert.equal(body.userCode,begin.userCode);return respond({authorizationId:begin.authorizationId,requestDigest:begin.requestDigest,clientId:failure==='review_binding'?'wrong-client':c.clientId,clientDisplayName:'Synthetic',environment:c.environment,runtimeKind:'agent-kit',keyThumbprint:await calculateJwkThumbprint(publicJwk),scope:'bootstrap.status.read',expiresAt:begin.expiresAt,state:'pending',operational_authority:false});}
  if(path.endsWith('/decide')){assert.equal(h.get('If-Match'),null);assert(h.get('Idempotency-Key'));assert.deepEqual(body,{userCode:begin.userCode,authorizationId:begin.authorizationId,requestDigest:begin.requestDigest,decision:'approve'});return respond({authorizationId:begin.authorizationId,requestDigest:begin.requestDigest,state:'approved',operational_authority:false});}
  assert.equal(path,'/api/v1/me/model-connections');assert.equal(h.get('If-Match'),'"1"');assert(h.get('Idempotency-Key'));assert.deepEqual(body,{connectionId,selection});
  model={modelConnectionId:randomUUID(),connectionId,runtimeDeviceId,familyId,environment:c.environment,clientId:c.clientId,selection,state:'unverified',aggregateVersion:'1',createdAt:new Date().toISOString(),operational_authority:false};
  if(failure==='model_ack')throw Error('synthetic lost model acknowledgement');return{...respond(model,201),headers:new Headers({ETag:'"1"'})};
 };const access={clientId:'synthetic-access',clientSecret:'synthetic-secret'};const client=new CandidateClient(candidateTarget('staging'),transport,access,secrets);client.csrf='synthetic-csrf';
 const ctx={check:(id:string,ok:boolean)=>assert(ok,id),metric:(k:string,v:unknown)=>{metrics[k]=v;},cleanup:()=>{}};
 const run=()=>runPrivateAiPrepare({config:c,client,secrets,ctx,authenticate:async()=>{await readFile(join(directory,'prepare-intent.json'));await client.request('POST','/api/v1/auth/login',{json:{email:account.email,password:account.password},csrf:null});return{userId};}});
 const integrated=()=>runCandidate({run:'execute',target:candidateTarget('staging'),expectedVersion:'1.0.0',expectedReleaseSha:release,contract:{protocol:'synthetic'},account,access,privateAiPrepare:c,phases:selectPhases(['private-ai-prepare']),transport});
 return{integrated,c,directory,requests,metrics,run,secrets,login:()=>login,polls:()=>polls,sensitive:()=>[secretToken,refreshHandle,begin?.deviceCode,begin?.nonce,begin?.userCode],cleanup:()=>rm(directory,{recursive:true,force:true})};
}
test('closed preparation config and exclusive phase selection reject widening',async()=>{const f=await fixture();try{
 assert.deepEqual(selectPhases(['private-ai-prepare']),['preflight','health','private-ai-prepare','logout']);
 assert(!selectPhases(null).includes('private-ai-prepare'));
 assert.throws(()=>selectPhases(['private-ai-prepare','session']));assert.throws(()=>selectPhases(['private-ai-prepare','private-ai-owner']));
 assert.deepEqual(validatePrivateAiPrepare(f.c,candidateTarget('staging'),release,account),f.c);
 for(const patch of [{paidExecution:true},{keyFile:'/private/key'},{accountLabel:'foreign-owner'},{brokerReleaseSha:'c'.repeat(40)},{environment:'next'}])assert.throws(()=>validatePrivateAiPrepare({...f.c,...patch},candidateTarget('staging'),release,account));
 assert.throws(()=>validatePrivateAiPrepare(f.c,candidateTarget('public'),release,account));
}finally{await f.cleanup();}});
test('HTTP preparation signs exact proofs, honors intervals, creates unverified model and saves metadata only',async()=>{const f=await fixture();try{
 const report=await f.integrated();assert.equal(report.phases.find(p=>p.id==='private-ai-prepare')?.status,'pass');assert.equal(report.phases.find(p=>p.id==='logout')?.status,'pass');assert.equal(report.overall,'incomplete');assert.equal(report.cloud_proof,false);assert.equal(f.polls(),2);
 for(const secret of [...f.sensitive(),account.email,account.password,f.directory,f.c.model,'synthetic-session-cookie'])assert(!JSON.stringify(report).includes(secret));
 const files=await readdir(f.directory);assert.deepEqual(files.sort(),['prepare-handoff.json','prepare-intent.json']);const handoff=await readFile(join(f.directory,'prepare-handoff.json'),'utf8');
 for(const value of f.sensitive())assert(!handoff.includes(value));assert(!/accessToken|refresh|publicJwk|enrollmentProof|deviceCode|nonce/.test(handoff));
 assert(!JSON.stringify(f.metrics).includes(f.c.model));const count=f.requests.length;await assert.rejects(f.run(),{code:'EEXIST'});assert.equal(f.requests.length,count);assert.equal(f.login(),1);
}finally{await f.cleanup();}});
for(const mode of ['begin_ack','review_binding','challenge_binding','model_ack'] as const)test('unknown or mismatched '+mode+' never retries mutation or saves handoff',async()=>{const f=await fixture(mode);try{
 if(mode==='begin_ack'){const report=await f.integrated();assert.equal(report.overall,'fail');assert.equal(report.cloud_proof,false);assert.equal(report.phases.find(p=>p.id==='logout')?.status,'pass');assert(!JSON.stringify(report).includes('synthetic lost acknowledgement'));}else await assert.rejects(f.run());const count=f.requests.length;await assert.rejects(f.run(),{code:'EEXIST'});assert.equal(f.requests.length,count);assert.equal(f.login(),1);assert.deepEqual(await readdir(f.directory),['prepare-intent.json']);
 if(mode==='review_binding')assert.equal(f.requests.filter(r=>r.url.endsWith('/decide')).length,0);if(mode==='challenge_binding')assert.equal(f.polls(),1);
 if(mode==='model_ack')assert.equal(f.requests.filter(r=>r.url.endsWith('/model-connections')).length,1);
}finally{await f.cleanup();}});
test('DPoP transport cannot carry member authority or target an arbitrary route',async()=>{let calls=0;const c=new CandidateClient(candidateTarget('staging'),async()=>{calls++;throw Error('unexpected');},null,new Secrets());
 for(const options of [{dpop:'a.b.c'},{dpop:'a.b.c',session:false,csrf:null,origin:'same' as const}])await assert.rejects(c.request('POST','/execution-api/v1/auth/token',options));
 await assert.rejects(c.request('POST','/api/v1/me/model-steps',{dpop:'a.b.c',session:false,csrf:null,origin:'none'}));assert.equal(calls,0);
});

test('prepare plan never opens private input files or performs network requests',async()=>{
 const {stdout}=await promisify(execFile)(process.execPath,['--import','tsx','--import','data:text/javascript,globalThis.fetch=async()=>{throw Error("unexpected network")}',
  'scripts/verify-cloud-candidate.ts','plan','--target','staging','--phases','private-ai-prepare'],
  {env:{...process.env,[PRIVATE_AI_PREPARE_ENV]:'/nonexistent-private-preparation',[ACCOUNT_ENV]:'/nonexistent-account',[ACCESS_ENV]:'/nonexistent-access'}});
 const report=JSON.parse(stdout);assert.equal(report.overall,'not_run');assert.equal(report.cloud_proof,false);assert(!stdout.includes('nonexistent'));
});
