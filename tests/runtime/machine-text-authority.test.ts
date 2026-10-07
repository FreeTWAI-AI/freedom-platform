import assert from 'node:assert/strict';
import {test} from 'node:test';
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
  const step=await steps.activate(f.actor,activateInput(f)),origin='https://machine.example.invalid';
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
  const issued=await transaction(app,q=>authority.attach(q,activationInput,step.stepId));
  async function access<T extends 'execute'|'status'|'evidence'='execute'>(operation:T='execute' as T,key=randomUUID(),overrides:Record<string,unknown>={}){
    const token=operation==='evidence'?issued.evidenceToken:issued.accessToken;
    const path='/execution-api/v1/model-steps/'+step.stepId+(operation==='status'?'':'/'+operation);
    const method=operation==='status'?'GET':'POST',requestSha256=machineTextRequestHash(method,path,new TextEncoder().encode('{}'),key,'1');
    return {accessToken:token,operation,requestSha256,proof:await sign({purpose:'machine_text.request',htm:method,htu:origin+path,
      client_id:'agent-kit',environment:'local',connection_id:f.connection.connectionId,family_id:f.family.familyId,jti:randomUUID(),
      iat:Math.floor(Date.now()/1000),ath:base64url.encode(createHash('sha256').update(token).digest()),request_sha256:requestSha256,...overrides})};
  }
  return {...f,authority,host,step,issued,challenge,challengeInput,activationInput,access,proof};
}
const code=(...codes:string[])=>(error:unknown)=>codes.includes((error as {code?:string}).code??'');
test('MACHINE-SQL-01 real member-approved Step and ES256 device proof issue one exact nonmember authorization',async()=>{
  const f=await ready();assert.equal(await count('execution_machine_authorizations'),1);
  assert.equal(await count('execution_machine_proofs'),2);
  await transaction(app,async q=>{const c=await f.authority.access(q,await f.access('status'));await assertMachineTextCurrent(q,c);
    assert.equal(c.authn_kind,'execution_token');assert.equal(c.ownerUserId,f.actor.user_id);assert.equal(c.binding.attemptId,f.step.attemptId);forgetMachineTextContext(c);});
  const facts=JSON.stringify((await owner.query('SELECT * FROM scoped_command_receipts')).rows);
  for(const secret of [f.issued.accessToken,f.issued.evidenceToken,f.challenge.nonce])assert(!facts.includes(secret));
  const schema=await app.query("SELECT rolsuper,rolcreaterole,rolcreatedb,rolbypassrls FROM pg_roles WHERE rolname=current_user");
  assert.deepEqual(schema.rows[0],{rolsuper:false,rolcreaterole:false,rolcreatedb:false,rolbypassrls:false});
});
test('MACHINE-SQL-02 challenge and activation proofs cannot replay after acknowledgement loss or a new adapter',async()=>{
  const f=await ready();await assert.rejects(f.authority.challenge(f.challengeInput));
  await assert.rejects(transaction(app,q=>f.authority.attach(q,f.activationInput,f.step.stepId)));
  assert.equal(await count('execution_machine_authorizations'),1);assert.equal(await count('execution_machine_challenges'),1);
  assert.equal(await count('execution_machine_proofs'),2);
});
test('MACHINE-SQL-03 concurrent identical DPoP has one durable acceptance and never returns a second authority',async()=>{
  const f=await ready(),input=await f.access();
  const run=()=>transaction(app,async q=>{const c=await f.authority.access(q,input);await assertMachineTextCurrent(q,c);forgetMachineTextContext(c);});
  const results=await Promise.allSettled([run(),run()]);assert.equal(results.filter(x=>x.status==='fulfilled').length,1);
  assert.equal(await count('execution_machine_proofs'),3);
});
test('MACHINE-SQL-04 machine command replay requires fresh proof/current SQL and writes composite-bound facts once',async()=>{
  const f=await ready(),key=randomUUID();let calls=0;
  const run=async()=>executionTextCommand(app,f.authority,{...await f.access('execute',key),key,expected:'1'},async()=>{},async(q,c)=>{
    calls++;await scopedJournal(q,c,{aggregate_type:'machine_text_admission',id:f.issued.binding.authorizationId,version:'1',operation:'execution.machine-text.execute',data:{state:'admitted'}});
    return {stepId:f.step.stepId,state:'reserved'};});
  assert.deepEqual(await run(),await run());assert.equal(calls,1);
  const rows=(await owner.query("SELECT * FROM scoped_command_receipts WHERE authn_kind='execution_token'")).rows;assert.equal(rows.length,1);
  assert.equal(rows[0].execution_authorization_id,f.issued.binding.authorizationId);assert.equal(rows[0].execution_attempt_id,f.step.attemptId);
  await connections.revoke(f.actor,{key:randomUUID(),connectionId:f.connection.connectionId,expectedVersion:'1'});
  await assert.rejects(run());assert.equal(calls,1);
});
test('MACHINE-SQL-05 valid tokens cannot accept wrong URI/method/hash/key/owner or altered client metadata',async()=>{
  const f=await ready(),g=await ready();
  for(const changes of [{htm:'GET'},{htu:f.host.audience+'/'+f.step.stepId+'/execute?x=1'},{environment:'next'},{client_id:'foreign'},
    {ath:'A'.repeat(43)},{connection_id:g.connection.connectionId},{family_id:g.family.familyId},{request_sha256:'f'.repeat(64)},
    {iat:Math.floor(Date.now()/1000)-61},{iat:Math.floor(Date.now()/1000)+30},{extra:true}]){
    await assert.rejects(transaction(app,async q=>f.authority.access(q,await f.access('execute',randomUUID(),changes))));
  }
  const foreign=await g.access();await assert.rejects(transaction(app,q=>f.authority.access(q,{...foreign,accessToken:f.issued.accessToken})));
  assert.equal(await count('execution_machine_proofs'),4);
});
test('MACHINE-SQL-06 family/device revocation rejects the longer evidence token as well as execution',async()=>{
  const f=await ready();await connections.revoke(f.actor,{key:randomUUID(),connectionId:f.connection.connectionId,expectedVersion:'1'});
  for(const operation of ['execute','evidence'] as const)await assert.rejects(transaction(app,async q=>f.authority.access(q,await f.access(operation))));
  assert.equal(await count('execution_machine_proofs'),2);
});
test('MACHINE-SQL-07 evidence after Stop is narrowly possible, execution remains fenced and reservation stays held',async()=>{
  const f=await ready();await steps.begin(f.actor,{key:randomUUID(),stepId:f.step.stepId,expectedVersion:'1'});
  await steps.control(f.actor,{key:randomUUID(),stepId:f.step.stepId,expectedVersion:'2',action:'stop'});
  await assert.rejects(transaction(app,async q=>f.authority.access(q,await f.access())));
  await transaction(app,async q=>{const c=await f.authority.access(q,await f.access('evidence'));await assertMachineTextCurrent(q,c);forgetMachineTextContext(c);});
  assert.equal((await owner.query('SELECT reservation_held FROM model_text_steps WHERE step_id=$1',[f.step.stepId])).rows[0].reservation_held,true);
});
test('MACHINE-SQL-08 real receipt sink wait crossing lease expiry rolls back proof, receipt and journal',async()=>{
  const expires=new Date(Date.now()+1600).toISOString(),f=await ready(expires),key=randomUUID(),q=await owner.connect();
  try{await q.query('BEGIN');await q.query('LOCK TABLE scoped_command_receipts IN ACCESS EXCLUSIVE MODE');
    const pending=executionTextCommand(app,f.authority,{...await f.access('execute',key),key,expected:'1'},async()=>{},async()=>{assert.fail('Expired receipt read reached run');});
    const rejected=assert.rejects(pending);await blocking(q);await delay(Math.max(0,Date.parse(expires)-Date.now())+80);await q.query('COMMIT');await rejected;
  }finally{await q.query('ROLLBACK');q.release();}
  assert.equal(await count('execution_machine_proofs'),2);
  assert.equal((await owner.query("SELECT count(*)::int n FROM scoped_command_receipts WHERE authn_kind='execution_token'")).rows[0].n,0);
});
test('MACHINE-SQL-09 SQL rejects machine fact owner/Attempt rebinding and member facts carrying machine references',async()=>{
  const f=await ready(),g=await ready(),key=randomUUID();
  await executionTextCommand(app,f.authority,{...await f.access('execute',key),key,expected:'1'},async()=>{},async()=>({stepId:f.step.stepId}));
  for(const [kind,attempt] of [['execution_token',g.step.attemptId],['member_session',f.step.attemptId]])
    await assert.rejects(app.query(`INSERT INTO scoped_command_receipts(principal_id,principal_kind,authn_kind,scope_id,scope_kind,operation,idempotency_key,
      target_kind,target_id,request_sha256,response,execution_authorization_id,execution_attempt_id,execution_grant_id,execution_runtime_device_id,execution_connection_id)
      VALUES($1,'person',$2,$3,'personal','execution.machine-text.execute',$4,'model_text_step',$5,$6,'{}',$7,$8,$9,$10,$11)`,
    [f.context.subject_principal.principal_id,kind,f.context.scope.scope_id,randomUUID(),f.step.stepId,'a'.repeat(64),f.issued.binding.authorizationId,
      attempt,f.grant.grantId,f.device.runtimeDeviceId,f.connection.connectionId]),code('23514','23503'));
  await assert.rejects(app.query('DELETE FROM execution_machine_authorizations WHERE authorization_id=$1',[f.issued.binding.authorizationId]),code('23514'));
  await assert.rejects(app.query("UPDATE execution_machine_proofs SET request_sha256=$1",['b'.repeat(64)]),code('23514'));
});

test('MACHINE-SQL-10 actual final receipt INSERT wait crossing expiry rolls back every new fact',async()=>{
  const expires=new Date(Date.now()+1800).toISOString(),f=await ready(expires),key=randomUUID(),q=await owner.connect();
  await owner.query(`CREATE FUNCTION block_machine_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.authn_kind='execution_token' THEN PERFORM pg_advisory_xact_lock(617117001); END IF; RETURN NEW; END; $$;
    CREATE TRIGGER block_machine_receipt BEFORE INSERT ON scoped_command_receipts FOR EACH ROW EXECUTE FUNCTION block_machine_receipt()`);
  try{await q.query('BEGIN');await q.query('SELECT pg_advisory_xact_lock(617117001)');
    const pending=executionTextCommand(app,f.authority,{...await f.access('execute',key),key,expected:'1'},async()=>{},async(q,c)=>{
      await scopedJournal(q,c,{aggregate_type:'machine_text_admission',id:f.issued.binding.authorizationId,version:'1',operation:'execution.machine-text.execute',data:{state:'admitted'}});
      return {stepId:f.step.stepId};});
    const rejected=assert.rejects(pending);await blocking(q);await delay(Math.max(0,Date.parse(expires)-Date.now())+80);await q.query('COMMIT');await rejected;
  }finally{await q.query('ROLLBACK');q.release();await owner.query('DROP TRIGGER block_machine_receipt ON scoped_command_receipts; DROP FUNCTION block_machine_receipt()');}
  assert.equal(await count('execution_machine_proofs'),2);
  for(const table of ['scoped_command_receipts','scoped_transition_journal'])
    assert.equal((await owner.query(`SELECT count(*)::int n FROM ${table} WHERE authn_kind='execution_token'`)).rows[0].n,0);
});
test('MACHINE-SQL-11 receipt semantic conflict rolls back its fresh DPoP and never runs again',async()=>{
  const f=await ready(),key=randomUUID();let runs=0;
  const run=async(expected:string)=>executionTextCommand(app,f.authority,{...await f.access('execute',key),key,expected},async()=>{},async()=>{runs++;return {stepId:f.step.stepId};});
  await run('1');await assert.rejects(run('2'));assert.equal(runs,1);assert.equal(await count('execution_machine_proofs'),3);
});
test('MACHINE-SQL-12 Grant withdrawal denies execution with fresh proofs; evidence cannot unreserve',async()=>{
  const f=await ready();await owner.query("UPDATE execution_grants SET state='revoked',aggregate_version=aggregate_version+1,revoked_at=date_trunc('milliseconds',clock_timestamp()) WHERE grant_id=$1",[f.grant.grantId]);
  await assert.rejects(transaction(app,async q=>f.authority.access(q,await f.access())));
  await transaction(app,async q=>{const c=await f.authority.access(q,await f.access('evidence'));await assertMachineTextCurrent(q,c);forgetMachineTextContext(c);});
  assert.equal((await owner.query('SELECT state,reservation_held FROM model_text_steps WHERE step_id=$1',[f.step.stepId])).rows[0].reservation_held,true);
});

test('MACHINE-SQL-13 revoked, expired and future issuer configuration cannot consume a challenge or mint authorization',async()=>{
  for(const state of ['revoked','expired','future'] as const)await assert.rejects(ready(undefined,state));
  assert.equal(await count('execution_machine_authorizations'),0);
  assert.equal((await owner.query('SELECT count(*)::int n FROM execution_machine_challenges WHERE consumed_at IS NOT NULL')).rows[0].n,0);
  assert.equal(await count('execution_machine_proofs'),3);
});
