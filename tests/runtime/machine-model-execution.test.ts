import assert from 'node:assert/strict';
import {test} from 'node:test';
import {FakeObjectStore} from '../../packages/asset-storage/fake-store.js';
import {createMachineModelStepService,createMachineModelPorts} from '../../modules/agent-execution/machine-model-step.js';
import {host as providerHost,posts,gets,api,works} from './machine-text-fixtures.js';
import {randomUUID,createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {CompactSign,exportJWK,generateKeyPair,base64url} from 'jose';
import {app,owner,approved,activateInput,steps,connections,blocking,count,setCredentialExpiry} from './machine-text-fixtures.js';
import {transaction} from '../../packages/db/transaction.js';
import {executionTextCommand} from '../../packages/scoped-commands/execution-text.js';
import {scopedJournal} from '../../packages/scoped-commands/index.js';
import {createMachineTextAuthority,assertMachineTextCurrent,forgetMachineTextContext} from '../../modules/agent-control/machine-text-authority.js';
import {machineTextRequestHash} from '../../modules/agent-control/machine-text-proof.js';
import {parseRuntimePublicJwk} from '../../modules/agent-control/runtime-proof.js';
import type {MachineTextHost} from '../../contracts/execution/v3/machine-text-execution.js';

async function ready(expiry?:string,issuerState?:'revoked'|'expired'|'future'){
  const f=await approved(),issuer=await generateKeyPair('ES256',{extractable:true});
  if(expiry)setCredentialExpiry(expiry);
  const origin='https://machine.example.invalid';
  const host:MachineTextHost={profile:'freedom.machine-text.host/v1',environment:'local',clientId:'agent-kit',origin,
    issuer:origin+'/issuer',audience:origin+'/execution-api/v1/model-steps',issuerKid:'machine-issuer-key-0001',
    keys:[{kid:'machine-issuer-key-0001',purpose:'machine_text',environment:'local',publicJwk:parseRuntimePublicJwk(await exportJWK(issuer.publicKey)),
      notBeforeMs:issuerState==='future'?Date.now()+60000:Date.now()-60000,notAfterMs:issuerState==='expired'?Date.now()-1:Date.now()+3600000,revoked:issuerState==='revoked'}]};
  const authority=createMachineTextAuthority(app,host,issuer.privateKey),jwk=parseRuntimePublicJwk(await exportJWK(f.pair.publicKey));
  const sign=async(claims:Record<string,unknown>,key=f.pair.privateKey)=>new CompactSign(new TextEncoder().encode(JSON.stringify(claims)))
    .setProtectedHeader({typ:'dpop+jwt',alg:'ES256',jwk}).sign(key);
  const proof=async(purpose:'challenge'|'activate',hash:string,extra:Record<string,unknown>={})=>sign({purpose:'machine_text.'+purpose,
    htm:'POST',htu:host.audience+(purpose==='challenge'?'/challenge':''),client_id:'agent-kit',environment:'local',connection_id:f.connection.connectionId,
    family_id:f.family.familyId,jti:randomUUID(),iat:Math.floor(Date.now()/1000),request_sha256:hash,...extra});
  const requestHash=machineTextRequestHash('POST','/execution-api/v1/model-steps/challenge',new Uint8Array(),null,null);
  const challengeInput={connectionId:f.connection.connectionId,familyId:f.family.familyId,requestSha256:requestHash,proof:await proof('challenge',requestHash)};
  const challenge=await authority.challenge(challengeInput),activationHash=machineTextRequestHash('POST','/execution-api/v1/model-steps',new Uint8Array(),randomUUID(),'1');
  const activationInput={connectionId:f.connection.connectionId,familyId:f.family.familyId,challengeId:challenge.challengeId,nonce:challenge.nonce,
    requestSha256:activationHash,proof:await proof('activate',activationHash,{challenge_id:challenge.challengeId,nonce:challenge.nonce})};
  const service=createMachineModelStepService(app,{environment:'local',clientId:'agent-kit',authority,host:providerHost,store:new FakeObjectStore()});
  const activated=await service.activate(activationInput,activateInput(f)),step=activated.metadata,issued=activated.credentials!;
  async function access<T extends 'execute'|'status'|'evidence'='execute'>(operation:T='execute' as T,key=randomUUID(),overrides:Record<string,unknown>={}){
    const token=operation==='evidence'?issued.evidenceToken:issued.accessToken;
    const path='/execution-api/v1/model-steps/'+step.stepId+(operation==='status'?'':'/'+operation);
    const method=operation==='status'?'GET':'POST',requestSha256=machineTextRequestHash(method,path,new TextEncoder().encode('{}'),key,'1');
    return {accessToken:token,operation,requestSha256,proof:await sign({purpose:'machine_text.request',htm:method,htu:origin+path,
      client_id:'agent-kit',environment:'local',connection_id:f.connection.connectionId,family_id:f.family.familyId,jti:randomUUID(),
      iat:Math.floor(Date.now()/1000),ath:base64url.encode(createHash('sha256').update(token).digest()),request_sha256:requestSha256,...overrides})};
  }
  return {...f,authority,host,step,issued,challenge,challengeInput,activationInput,access,proof,service};
}
test('MACHINE-MODEL-01 signed device activates genuine Attempt then one synthetic provider dispatch commits one shared private Result',async()=>{
  const f=await ready(),key=randomUUID();assert.equal(f.step.state,'reserved');assert.equal(await count('execution_machine_model_pins'),1);
  const result=await f.service.execute(await f.access('execute',key),{key,stepId:f.step.stepId,expectedVersion:'1'});
  assert.equal(result.metadata.state,'succeeded');assert.equal(result.result?.provenance,'model');assert.equal(result.result?.evidenceOrigin,'synthetic_local_fixture');
  assert.equal(posts,1);assert.equal(await count('private_model_work_results'),1);
  assert.equal((await owner.query('SELECT aggregate_version::text FROM work_items WHERE work_item_id=$1',[f.work.workId])).rows[0].aggregate_version,'2');
  assert.equal((await f.service.read(await f.access('status'),{stepId:f.step.stepId})).state,'succeeded');
  const replay=await f.service.execute(await f.access('execute',key),{key,stepId:f.step.stepId,expectedVersion:'1'});
  assert.equal(replay.metadata.state,'succeeded');assert.equal(replay.result,null);assert.equal(posts,1);
  const facts=JSON.stringify((await owner.query("SELECT * FROM scoped_command_receipts WHERE authn_kind='execution_token'")).rows);
  for(const secret of [f.issued.accessToken,f.issued.evidenceToken,f.challenge.nonce,'PRIVATE_SYNTHETIC_MODEL_OUTPUT','PRIVATE_BODY_NOT_IN_PREREQUISITES','leaseToken'])assert(!facts.includes(secret));
});
test('MACHINE-MODEL-02 concurrently accepted execute proofs cannot dispatch the durable Step twice',async()=>{
  const f=await ready(),a=randomUUID(),b=randomUUID();
  const out=await Promise.allSettled([f.service.execute(await f.access('execute',a),{key:a,stepId:f.step.stepId,expectedVersion:'1'}),
    f.service.execute(await f.access('execute',b),{key:b,stepId:f.step.stepId,expectedVersion:'1'})]);
  assert(out.some(r=>r.status==='fulfilled'));assert.equal(posts,1);assert.equal(await count('private_model_work_results'),1);
});
test('MACHINE-MODEL-03 fake subjects and purpose changes cannot reach private SQL callbacks',async()=>{
  const f=await ready(),ports=createMachineModelPorts(f.authority);let called=0;
  assert(Object.isFrozen(ports));assert.throws(()=>ports.snapshot({user_id:f.actor.user_id} as never));
  await assert.rejects(ports.read(app,{actor:{user_id:f.actor.user_id} as never,scope:'personal'},async()=>{called++;},async()=>{called++;}));
  await assert.rejects(f.service.execute(await f.access('status') as never,{key:randomUUID(),stepId:f.step.stepId,expectedVersion:'1'}));assert.equal(called,0);assert.equal(posts,0);
});
