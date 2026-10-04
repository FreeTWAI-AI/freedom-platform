import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { CompactSign, base64url, exportJWK } from 'jose';
import { setTimeout as delay } from 'node:timers/promises';
import { bridgeFixture } from './model-broker-process.test.js';
import { ModelBrokerRequestSchema, ModelBrokerAssertionPayloadSchema } from '../../contracts/execution/v2/model-broker-bridge.js';
import { ModelStepMetadataSchema } from '../../contracts/execution/v2/model-step.js';

// Allow real HTTP/SQL work to reach its gate; still expire before the fixture's
// 10s statement timeout, without changing production limits or test timeouts.
const expiryPhaseMs=8000;
const nonce=()=>randomBytes(32).toString('base64url');
const payload=(envelope:{response:string})=>JSON.parse(new TextDecoder().decode(base64url.decode(envelope.response.split('.')[1]))) as any;
async function issue(f:Awaited<ReturnType<typeof bridgeFixture>>,member:{token:string;step?:{stepId:string};approval?:{approvalId:string}},operation:'activate'|'execute'='execute') {
  const command=operation==='execute'?{operation,input:{key:randomUUID(),stepId:member.step!.stepId,expectedVersion:'1'}}:{operation,input:{key:randomUUID(),approvalId:member.approval!.approvalId,expectedApprovalVersion:'1',expectedRunVersion:'1'}};
  return f.main.request('issue',{token:member.token,command,nonce:nonce()});
}
async function sqlBlocked(f:Awaited<ReturnType<typeof bridgeFixture>>,holder:any) {const pid=(await holder.query('SELECT pg_backend_pid() pid')).rows[0].pid;for(let i=0;i<300;i++){if((await f.admin.query('SELECT count(*)::int n FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))',[pid])).rows[0].n)return;await delay(10);}assert.fail('Actual SQL wait was not observed');}

test('BROKER-BRIDGE-ADV pinned signature profile denies malformed claims and request authority injection before any POST',async()=>{
 const f=await bridgeFixture();try{
  const member=await f.activated(),signed=await issue(f,member);
  for(const headers of ([{Cookie:member.headers.Cookie},{Origin:f.mainOrigin},{Authorization:'Bearer fake'},{'Content-Encoding':'gzip'}] as Record<string,string>[])){const response=await fetch(f.brokerOrigin+'/internal/model-execution',{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(signed.request)});assert.equal(response.status,403);assert.equal(f.posts.length,0);}
  const sign=(body:unknown,header:Record<string,unknown>={})=>new CompactSign(new TextEncoder().encode(typeof body==='string'?body:JSON.stringify(body))).setProtectedHeader({alg:'EdDSA',typ:'freedom-model-broker-assertion+jws',kid:'main-1',...header}).sign(f.issuerKeys.privateKey);
  const changes=[{issuer:'wrong'},{audience:'wrong'},{purpose:'bootstrap.status.read'},{purpose:'model-broker.activate'},{environment:'next'},{clientId:'wrong'},{commandDigest:'a'.repeat(64)},{nonce:nonce()},{authorizationRef:randomUUID()},{recoveryGeneration:'2'},{issuedAt:new Date(Date.now()+60000).toISOString()},{expiresAt:new Date().toISOString()},{actor:{user_id:member.actor.user_id}},{operational_authority:true}];
  for(const change of changes){const request={...signed.request,assertion:await sign({...signed.payload,...change})};try{const reply=payload(await f.broker.request('handle',request));assert.equal(reply.outcome.kind,'problem');}catch(error){assert.match((error as Error).message,/authorization|Broker/);}assert.equal(f.posts.length,0);}
  for(const header of [{kid:'uninstalled'},{typ:'freedom-bootstrap+jwt'},{jwk:await exportJWK(f.issuerKeys.publicKey)},{jku:'http://127.0.0.1/attacker'},{x5u:'http://127.0.0.1/attacker'}])await assert.rejects(f.broker.request('handle',{...signed.request,assertion:await sign(signed.payload,header)}));
  const duplicate=JSON.stringify(signed.payload).replace('"nonce":','"\\u006eonce":"'+signed.payload.nonce+'","nonce":');await assert.rejects(f.broker.request('handle',{...signed.request,assertion:await sign(duplicate)}));
  for(const injected of [{...signed.request,actor:member.actor},{...signed.request,endpoint:'http://127.0.0.1/attacker'},{...signed.request,prompt:'caller text'},{...signed.request,proof:{verified:true}},{...signed.payload}]){assert(!ModelBrokerRequestSchema.safeParse(injected).success);await assert.rejects(f.broker.request('handle',injected));}
  assert(ModelBrokerAssertionPayloadSchema.safeParse(signed.payload).success);
  for(const fake of [signed.request,signed.payload,JSON.parse(JSON.stringify(member.step)),{actor:member.actor,command:{operation:'execute'}}])await assert.rejects(f.broker.request('fake',fake));
  assert.equal(f.posts.length,0);
 }finally{await f.cleanup();}
});

test('BROKER-BRIDGE-ADV concurrent identical signed command and nonce replay produce only one actual provider POST',async()=>{
 const f=await bridgeFixture();try{const member=await f.activated(),signed=await issue(f,member),gate=f.holdProvider();const first=f.broker.request('handle',signed.request);await gate.entered;const replay=f.broker.request('handle',JSON.parse(JSON.stringify(signed.request)));gate.release();const replies=await Promise.all([first,replay]);assert.equal(f.posts.length,1);assert(replies.some(r=>payload(r).outcome.kind==='metadata'));await f.broker.request('handle',signed.request);assert.equal(f.posts.length,1);assert.equal((await f.owner.query('SELECT count(*)::int n FROM private_model_work_results WHERE work_item_id=$1',[member.work.workId])).rows[0].n,1);
 const foreign=await f.member();await assert.rejects(f.main.request('issue',{token:foreign.token,command:{operation:'execute',input:{key:randomUUID(),stepId:member.step.stepId,expectedVersion:'1'}},nonce:nonce()}));
 }finally{await f.cleanup();}
});

test('BROKER-BRIDGE-ADV valid signature cannot outlive the original current member session or independent recovery floor',async()=>{
 for(const kind of ['session','scope','floor'] as const){const f=await bridgeFixture();try{const member=await f.activated(),signed=await issue(f,member);if(kind==='session')await f.owner.query('UPDATE sessions SET revoked_at=clock_timestamp() WHERE token_hash=$1',[member.actor.session_hash]);if(kind==='scope')await f.owner.query("UPDATE resource_scopes SET status='disabled' WHERE scope_id=$1",[member.context.scope.scope_id]);if(kind==='floor')f.recovery.floor='2';const reply=payload(await f.broker.request('handle',signed.request));assert.equal(reply.outcome.kind,'problem');assert.equal(f.posts.length,0);assert.equal((await f.owner.query('SELECT state FROM model_text_steps WHERE step_id=$1',[member.step.stepId])).rows[0].state,'reserved');}finally{await f.cleanup();}}
});

test('BROKER-BRIDGE-ADV actual committed dispatch ACK loss, tampered reply, and spent replay never resend provider',async()=>{
 for(const mode of ['dropNext','tamperNext']){const f=await bridgeFixture();try{const member=await f.activated();await f.main.request('exchangeMode',mode);const key=randomUUID();const response=await f.post(member,`/api/v1/me/model-steps/${member.step.stepId}:execute`,{}, {'Idempotency-Key':key});assert(response.status>=400);assert.equal(f.posts.length,1);assert.equal((await f.owner.query('SELECT count(*)::int n FROM private_model_work_results WHERE work_item_id=$1',[member.work.workId])).rows[0].n,1);const retry=await f.post(member,`/api/v1/me/model-steps/${member.step.stepId}:execute`,{}, {'Idempotency-Key':key});assert.equal(retry.status,200,await retry.clone().text());assert.equal(ModelStepMetadataSchema.parse(await retry.json()).state,'succeeded');const requests=await f.main.request('requests');assert.equal(requests.at(-1).authorizationRef,requests.at(-2).authorizationRef);assert.equal(requests.at(-1).nonce,requests.at(-2).nonce);assert.equal(f.posts.length,1);assert.equal((await f.owner.query('SELECT count(*)::int n FROM private_model_work_results WHERE work_item_id=$1',[member.work.workId])).rows[0].n,1);const refresh=await fetch(f.mainOrigin+`/api/v1/me/model-steps/${member.step.stepId}`,{headers:{Cookie:member.headers.Cookie}});assert.equal(refresh.status,200);assert.equal(ModelStepMetadataSchema.parse(await refresh.json()).state,'succeeded');}finally{await f.cleanup();}}
});

test('BROKER-BRIDGE-ADV wrong replica and restarted broker cannot reconstruct original opaque verification from DB or wire',async()=>{
 const f=await bridgeFixture();try{const member=await f.activated(),signed=await issue(f,member);const replica=await f.spawnReplica();const denied=payload(await replica.request('handle',signed.request));assert.equal(denied.outcome.kind,'problem');assert.equal(f.posts.length,0);assert.equal(payload(await f.broker.request('handle',signed.request)).outcome.kind,'metadata');assert.equal(f.posts.length,0);const fresh=await f.restartBroker();const reply=payload(await fresh.request('handle',signed.request));assert.equal(reply.outcome.kind,'problem');assert.equal(f.posts.length,0);assert.equal((await f.owner.query('SELECT state FROM model_text_steps WHERE step_id=$1',[member.step.stepId])).rows[0].state,'reserved');await fresh.request('handle',signed.request);assert.equal(f.posts.length,0);f.recovery.floor='2';assert.equal(payload(await fresh.request('handle',signed.request)).outcome.kind,'problem');assert.equal(f.posts.length,0);f.recovery.unavailable=true;const stop=await f.post(member,`/api/v1/me/model-steps/${member.step.stepId}:stop`,{});assert.equal(stop.status,200,await stop.clone().text());assert.equal(ModelStepMetadataSchema.parse(await stop.json()).state,'cancelled');}finally{await f.cleanup();}
});

test('BROKER-BRIDGE-ADV invocation expiry while actual final Result INSERT is blocked rolls back Result and Work CAS',async()=>{
 const f=await bridgeFixture();let holder:any;try{const member=await f.activated();
  // Hold a test-owned advisory lock inside a genuine BEFORE INSERT trigger.
  // No production trigger is disabled or replaced. The INSERT resumes after
  // the issuer-bound authorization has expired, so its sink guard must reject.
  const lock='independent-broker-final-sink-'+randomUUID();
  await f.owner.query(`CREATE FUNCTION bridge_validation_result_gate() RETURNS trigger LANGUAGE plpgsql AS $gate$ BEGIN PERFORM pg_advisory_xact_lock(hashtextextended('${lock}',0)); RETURN NEW; END $gate$; CREATE TRIGGER z_bridge_validation_gate BEFORE INSERT ON private_model_work_results FOR EACH ROW EXECUTE FUNCTION bridge_validation_result_gate()`);
  holder=await f.owner.connect();await holder.query('BEGIN');await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[lock]);
  const provider=f.holdProvider();
  await f.broker.request('observeSqlSink','result');const sinkEntered=f.broker.request('sqlSinkEntered');
  await f.main.request('issuerDeadline',Date.now()+expiryPhaseMs);
  const pending=f.post(member,`/api/v1/me/model-steps/${member.step.stepId}:execute`,{}).then(response=>({response}),error=>({error}));
  // Observe the Result sink only after the genuine provider POST, not while
  // main/broker authorization and provider preparation are still running.
  const providerReached=await Promise.race([provider.entered.then(()=>true),pending.then(()=>false)]);
  assert(providerReached,'Actual provider POST was not observed');provider.release();
  // Asset preparation/PUT/finalize still follows the provider response. Start
  // the unchanged SQL-wait poll only when the Result INSERT is submitted.
  assert(await Promise.race([sinkEntered.then(()=>true),pending.then(()=>false)]),'Actual Result INSERT was not submitted');
  await sqlBlocked(f,holder);
  // Only the command expires: main conservatively narrows a real signed
  // recovery observation for issuance. The broker's external source, original
  // session and Step remain current, isolating the invocation sink guard.
  const last=(await f.main.request('requests')).at(-1);const claims=JSON.parse(new TextDecoder().decode(base64url.decode(last.assertion.split('.')[1])));
  const expires=Date.parse(claims.expiresAt);assert(expires>Date.now());assert(Date.parse(member.step.expiresAt)>expires+10000);const sessionExpiry=(await f.owner.query('SELECT expires_at FROM sessions WHERE token_hash=$1',[member.actor.session_hash])).rows[0].expires_at;assert(sessionExpiry.getTime()>expires+30000);const externalClaims=JSON.parse(new TextDecoder().decode(base64url.decode(f.recovery.raw.split('.')[1])));assert(Date.parse(externalClaims.expiresAt)>expires+30000);await delay(Math.max(0,expires-Date.now()+30));await holder.query('COMMIT');holder.release();holder=undefined;
  const settled=await pending;if('error' in settled)throw settled.error;const response=settled.response;assert(response.status>=400);assert.equal(f.posts.length,1);assert.equal((await f.owner.query('SELECT count(*)::int n FROM private_model_work_results WHERE work_item_id=$1',[member.work.workId])).rows[0].n,0);assert.equal((await f.owner.query('SELECT aggregate_version::text version FROM work_items WHERE work_item_id=$1',[member.work.workId])).rows[0].version,'1');
 }finally{if(holder){await holder.query('ROLLBACK');holder.release();}await f.cleanup();}
});

test('BROKER-BRIDGE-ADV owner Stop committed during actual provider wait fences the late Result and preserves spent dispatch',async()=>{
 const f=await bridgeFixture();try{const member=await f.activated(),gate=f.holdProvider();const execute=f.post(member,`/api/v1/me/model-steps/${member.step.stepId}:execute`,{});await gate.entered;
  const version=(await f.owner.query('SELECT aggregate_version::text version FROM model_text_steps WHERE step_id=$1',[member.step.stepId])).rows[0].version;
  const stop=await f.post(member,`/api/v1/me/model-steps/${member.step.stepId}:stop`,{}, {'If-Match':'"'+version+'"'});assert.equal(stop.status,200,await stop.clone().text());gate.release();const response=await execute;assert(response.status>=400);
  assert.equal(f.posts.length,1);assert.equal((await f.owner.query('SELECT count(*)::int n FROM private_model_work_results WHERE work_item_id=$1',[member.work.workId])).rows[0].n,0);assert.equal((await f.owner.query('SELECT aggregate_version::text version FROM work_items WHERE work_item_id=$1',[member.work.workId])).rows[0].version,'1');
  const step=(await f.owner.query('SELECT state,usage_status FROM model_text_steps WHERE step_id=$1',[member.step.stepId])).rows[0];assert.equal(step.state,'outcome_unknown');assert.equal(step.usage_status,'unknown');
  await f.post(member,`/api/v1/me/model-steps/${member.step.stepId}:execute`,{}, {'If-Match':'"'+version+'"'});assert.equal(f.posts.length,1);
 }finally{await f.cleanup();}
});

test('BROKER-BRIDGE-ADV invocation expiry during actual Asset prepare receipt INSERT rolls back Asset and intent before any PUT',async()=>{
 const f=await bridgeFixture();let holder:any;try{const member=await f.activated(),lock='independent-broker-asset-prepare-'+randomUUID();
  // Only the real prepare receipt write waits. Asset and intent INSERTs have
  // already run inside that transaction; the final validator must roll them
  // back when the delegated command expires after the receipt sink wait.
  await f.owner.query(`CREATE FUNCTION bridge_validation_prepare_gate() RETURNS trigger LANGUAGE plpgsql AS $gate$ BEGIN PERFORM pg_advisory_xact_lock(hashtextextended('${lock}',0)); RETURN NEW; END $gate$; CREATE TRIGGER z_bridge_validation_prepare_gate BEFORE INSERT ON scoped_command_receipts FOR EACH ROW WHEN (NEW.operation='asset.upload.prepare') EXECUTE FUNCTION bridge_validation_prepare_gate()`);
  holder=await f.owner.connect();await holder.query('BEGIN');await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[lock]);
  await f.broker.request('observeSqlSink','asset_prepare_receipt');const sinkEntered=f.broker.request('sqlSinkEntered');
  await f.main.request('issuerDeadline',Date.now()+expiryPhaseMs);
  const pending=f.post(member,`/api/v1/me/model-steps/${member.step.stepId}:execute`,{}).then(response=>({response}),error=>({error}));
  assert(await Promise.race([sinkEntered.then(()=>true),pending.then(()=>false)]),'Actual Asset prepare receipt INSERT was not submitted');
  await sqlBlocked(f,holder);
  const last=(await f.main.request('requests')).at(-1),claims=JSON.parse(new TextDecoder().decode(base64url.decode(last.assertion.split('.')[1]))),expires=Date.parse(claims.expiresAt);
  assert(expires>Date.now());assert(Date.parse(member.step.expiresAt)>expires+10000);assert((await f.owner.query('SELECT expires_at FROM sessions WHERE token_hash=$1',[member.actor.session_hash])).rows[0].expires_at.getTime()>expires+30000);
  const externalClaims=JSON.parse(new TextDecoder().decode(base64url.decode(f.recovery.raw.split('.')[1])));assert(Date.parse(externalClaims.expiresAt)>expires+30000);
  await delay(Math.max(0,expires-Date.now()+30));await holder.query('COMMIT');holder.release();holder=undefined;
  const settled=await pending;if('error' in settled)throw settled.error;const response=settled.response;assert(response.status>=400);assert.equal(f.posts.length,1);
  for(const table of ['assets','asset_upload_intents','private_model_work_results'])assert.equal((await f.owner.query(`SELECT count(*)::int n FROM ${table} WHERE scope_id=$1`,[member.context.scope.scope_id])).rows[0].n,0,table+' must roll back');
  assert.deepEqual(await f.broker.request('storeCounts'),{puts:0});assert.equal((await f.owner.query("SELECT count(*)::int n FROM scoped_command_receipts WHERE scope_id=$1 AND operation='asset.upload.prepare'",[member.context.scope.scope_id])).rows[0].n,0);
  assert.equal((await f.owner.query('SELECT aggregate_version::text version FROM work_items WHERE work_item_id=$1',[member.work.workId])).rows[0].version,'1');const step=(await f.owner.query('SELECT state,reservation_held FROM model_text_steps WHERE step_id=$1',[member.step.stepId])).rows[0];assert.notEqual(step.state,'succeeded');assert.equal(step.reservation_held,true);
 }finally{if(holder){await holder.query('ROLLBACK');holder.release();}await f.cleanup();}
});
