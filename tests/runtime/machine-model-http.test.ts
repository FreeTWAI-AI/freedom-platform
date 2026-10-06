import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID,createHash} from 'node:crypto';
import {CompactSign,exportJWK,generateKeyPair,base64url} from 'jose';
import {app,owner,approved,host as modelHost,posts,count,steps,connections} from './machine-text-fixtures.js';
import {FakeObjectStore} from '../../packages/asset-storage/fake-store.js';
import {createMachineModelHttpTransport} from '../../apps/platform-api/src/routes/machine-model-http.js';
import {parseRuntimePublicJwk} from '../../modules/agent-control/runtime-proof.js';
import {machineTextRequestHash} from '../../modules/agent-control/machine-text-proof.js';
import type {MachineTextHost} from '../../contracts/execution/v3/machine-text-execution.js';
const origin='https://machine.example.invalid',base='/execution-api/v1/model-steps';
async function fixture(){
 const f=await approved(),issuer=await generateKeyPair('ES256',{extractable:true}),jwk=parseRuntimePublicJwk(await exportJWK(f.pair.publicKey));
 const host:MachineTextHost={profile:'freedom.machine-text.host/v1',environment:'local',clientId:'agent-kit',origin,issuer:origin+'/issuer',audience:origin+base,issuerKid:'machine-issuer-key-0001',
  keys:[{kid:'machine-issuer-key-0001',purpose:'machine_text',environment:'local',publicJwk:parseRuntimePublicJwk(await exportJWK(issuer.publicKey)),notBeforeMs:0,notAfterMs:Date.now()+3600000,revoked:false}]};
 const transport=createMachineModelHttpTransport(app,{host,signingKey:issuer.privateKey,modelHost,store:new FakeObjectStore()});
 async function sign(claims:unknown,key=f.pair.privateKey,header:Record<string,unknown>={}){return new CompactSign(new TextEncoder().encode(JSON.stringify(claims))).setProtectedHeader({typ:'dpop+jwt',alg:'ES256',jwk,...header}).sign(key);}
 async function request(name:'challenge'|'activate'|'execute'|'status'|'evidence',body:unknown,extra:{stepId?:string;token?:string;key?:string;version?:string;claims?:Record<string,unknown>;headers?:Record<string,string>;raw?:string;method?:string;url?:string;proof?:string;privateKey?:CryptoKey;proofHeader?:Record<string,unknown>}={}){
  const path=name==='challenge'?base+'/challenge':name==='activate'?base:base+'/'+extra.stepId+(name==='status'?'':'/'+name),method=name==='status'?'GET':'POST';
  const key=name==='challenge'||name==='status'?null:extra.key??randomUUID(),version=key?extra.version??'1':null,raw=extra.raw??JSON.stringify(body),bytes=new TextEncoder().encode(name==='status'?'':raw);
  const requestSha256=machineTextRequestHash(method,path,bytes,key,version),claims={purpose:name==='activate'?'machine_text.activate':name==='challenge'?'machine_text.challenge':'machine_text.request',htm:method,htu:origin+path,
   client_id:'agent-kit',environment:'local',connection_id:f.connection.connectionId,family_id:f.family.familyId,jti:randomUUID(),iat:Math.floor(Date.now()/1000),request_sha256:requestSha256,
   ...(name==='activate'?{challenge_id:(body as any).challengeId,nonce:(body as any).nonce}:{}),...(extra.token?{ath:base64url.encode(createHash('sha256').update(extra.token).digest())}:{}),...extra.claims};
  const proof=extra.proof??await sign(claims,extra.privateKey,extra.proofHeader),headers={'DPoP':proof,...(name==='status'?{}:{'Content-Type':'application/json'}),
   ...(key?{'Idempotency-Key':key,'If-Match':'"'+version+'"'}:{}),...(extra.token?{Authorization:'DPoP '+extra.token}:{}),...extra.headers};
  const input=new Request(extra.url??origin+path,{method:extra.method??method,headers,...(method==='GET'||extra.method==='HEAD'?{}:{body:raw})});
  const response=await transport.fetch(input),text=await response.text();assert(text.length<=32768);assert.equal(response.headers.get('Cache-Control'),'private, no-store');
  return {status:response.status,data:JSON.parse(text),text,proof,input,claims};
 }
 const challenge=async()=>{const r=await request('challenge',{connectionId:f.connection.connectionId,familyId:f.family.familyId});assert.equal(r.status,201,r.text);return r.data;};
 const activate=async()=>{const c=await challenge(),body={connectionId:f.connection.connectionId,familyId:f.family.familyId,challengeId:c.challengeId,nonce:c.nonce,approvalId:f.approval.approvalId,expectedRunVersion:'1'};
  const r=await request('activate',body);assert.equal(r.status,201,r.text);return {...r.data,body,proof:r.proof,input:r.input};};
 return {...f,host,issuer,sign,request,challenge,activate,transport};
}
test('MACHINE-HTTP-01 mounted Hono signed device -> activation -> one dispatch -> private Result -> current status, no secret receipts/logs',async()=>{
 const logs:unknown[][]=[],old=console.error;console.error=(...args)=>logs.push(args);
 try{const f=await fixture(),activated=await f.activate(),stepId=activated.metadata.stepId,token=activated.credentials.accessToken;
  const done=await f.request('execute',{}, {stepId,token});assert.equal(done.status,200,done.text);assert.equal(done.data.state,'succeeded');assert.equal(posts,1);assert.equal(await count('private_model_work_results'),1);
  const status=await f.request('status',{}, {stepId,token});assert.equal(status.status,200,status.text);assert.equal(status.data.state,'succeeded');
  const lost=await f.transport.fetch(new Request(activated.input.url,{method:'POST',headers:activated.input.headers,body:JSON.stringify(activated.body)}));assert.equal(lost.status,401);assert.equal(posts,1);
  const capture=JSON.stringify([logs,(await owner.query('SELECT * FROM scoped_command_receipts')).rows,(await owner.query('SELECT * FROM scoped_transition_journal')).rows]);
  for(const secret of [token,activated.credentials.evidenceToken,activated.body.nonce,'synthetic-not-a-provider-key','PRIVATE_SYNTHETIC_MODEL_OUTPUT','PRIVATE_BODY_NOT_IN_PREREQUISITES'])assert(!capture.includes(secret));
 }finally{console.error=old;}
});
test('AP:AUTH-13 machine HTTP proof rejects key/audience/method/URI/expiry/replay and fixed trust refuses jku/unknown kid without network',async()=>{
 const f=await fixture(),a=await f.activate(),stepId=a.metadata.stepId,token=a.credentials.accessToken,other=await generateKeyPair('ES256');
 const rejected=async(extra:Parameters<typeof f.request>[2])=>{const r=await f.request('execute',{}, {stepId,token,...extra});assert.equal(r.status,401,r.text);assert.equal(posts,0);};
 for(const claims of [{htm:'GET'},{htu:origin+base+'/'+stepId},{iat:Math.floor(Date.now()/1000)-61},{iat:Math.floor(Date.now()/1000)+6},{connection_id:randomUUID()},{family_id:randomUUID()},{ath:'A'.repeat(43)},{request_sha256:'f'.repeat(64)}])await rejected({claims});
 await rejected({privateKey:other.privateKey});
 let fetched=0;const original=globalThis.fetch;globalThis.fetch=async()=>{fetched++;throw Error('network_denied');};
 try{
  await rejected({proofHeader:{jku:'https://attacker.invalid/keys'}});
  const parts=token.split('.'),claims=JSON.parse(Buffer.from(parts[1],'base64url').toString()),h=JSON.parse(Buffer.from(parts[0],'base64url').toString());
  for(const [header,payload] of [[{...h,kid:'unknown-issuer-key'},claims],[{...h,jku:'https://attacker.invalid/keys'},claims],[h,{...claims,aud:'https://attacker.invalid/execution-api/v1/model-steps'}]]){
   const changed=await new CompactSign(new TextEncoder().encode(JSON.stringify(payload))).setProtectedHeader(header).sign(f.issuer.privateKey);await rejected({token:changed});
  }
  assert.equal(fetched,0);
 }finally{globalThis.fetch=original;}
 const read=await f.request('status',{}, {stepId,token});assert.equal(read.status,200);const replay=await f.transport.fetch(new Request(read.input));assert.equal(replay.status,401);assert.equal(posts,0);
});
test('MACHINE-HTTP-03 closed purpose/body/path/method boundaries cannot consume a dispatch',async()=>{
 const f=await fixture(),a=await f.activate(),stepId=a.metadata.stepId,token=a.credentials.accessToken;
 const extras:NonNullable<Parameters<typeof f.request>[2]>[]=[{headers:{Cookie:'freedom_local_session=synthetic'}},{headers:{Origin:origin}},{headers:{Authorization:'Bearer synthetic-provider-key'}},{headers:{'Content-Encoding':'gzip'}},
  {raw:'{"x":1}'},{raw:'{"x":1,"x":2}'},{raw:' '.repeat(32769)},{headers:{'Content-Length':'1'}},{url:origin+base+'/'+stepId+'/execute?x=1'},
  {url:origin+base+'/'+stepId+'/%65xecute'},{method:'DELETE'},{headers:{Range:'bytes=0-1'}}];
 for(const extra of extras){
  const r=await f.request('execute',{}, {stepId,token,...extra});assert(r.status>=400,r.text);assert.equal(posts,0);
 }
 const evidence=await f.request('evidence',{profile:'freedom.machine-dispatch-evidence/v1',outcome:'outcome_unknown',reason:'process_restarted',evidenceSha256:'a'.repeat(64)},
  {stepId,token:a.credentials.evidenceToken});assert(evidence.status>=400);assert.equal(await count('execution_machine_dispatch_evidence'),0);
});
test('MACHINE-HTTP-04 late evidence after owner Stop stays metadata-only and revoked family still rejects',async()=>{
 const f=await fixture(),a=await f.activate(),stepId=a.metadata.stepId;
 await steps.begin(f.actor,{key:randomUUID(),stepId,expectedVersion:'1'});await steps.control(f.actor,{key:randomUUID(),stepId,expectedVersion:'2',action:'stop'});
 const body={profile:'freedom.machine-dispatch-evidence/v1',outcome:'outcome_unknown',reason:'client_lost_response',evidenceSha256:'a'.repeat(64)};
 const r=await f.request('evidence',body,{stepId,token:a.credentials.evidenceToken});assert.equal(r.status,200,r.text);
 const equal=await f.request('evidence',body,{stepId,token:a.credentials.evidenceToken});assert.equal(equal.status,200,equal.text);
 const changed=await f.request('evidence',{...body,evidenceSha256:'b'.repeat(64)},{stepId,token:a.credentials.evidenceToken});assert.equal(changed.status,409);
 const state=(await owner.query('SELECT state,reservation_held FROM model_text_steps WHERE step_id=$1',[stepId])).rows[0];assert.deepEqual(state,{state:'outcome_unknown',reservation_held:true});assert.equal(posts,0);
 assert.equal((await f.request('status',{}, {stepId,token:a.credentials.accessToken})).status,200);
 await connections.revoke(f.actor,{key:randomUUID(),connectionId:f.connection.connectionId,expectedVersion:'1'});
 assert.equal((await f.request('evidence',body,{stepId,token:a.credentials.evidenceToken})).status,401);
});
