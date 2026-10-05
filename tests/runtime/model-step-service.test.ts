import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { CompactSign, exportJWK, generateKeyPair } from 'jose';
import { Pool, type PoolClient } from 'pg';
import { migrate } from '../../scripts/database.js';
import { createExecutionPrerequisites } from '../../modules/agent-execution/prerequisites.js';
import { createExecutionRuns } from '../../modules/agent-execution/runs.js';
import { createPrivateWorkCommands } from '../../modules/opportunity-project-work/private-commands.js';
import { resolvePrivateWorkPersistencePolicy } from '../../modules/autopilot-work/policy.js';
import { createRuntimeRegistrations } from '../../modules/agent-control/runtime-registration.js';
import { createAgentConnections } from '../../modules/agent-control/agent-connections.js';
import { parseRuntimePublicJwk } from '../../modules/agent-control/runtime-proof.js';
import { insertInitialRefreshFamily } from '../../modules/agent-control/bootstrap-session-store.js';
import { transaction } from '../../packages/db/transaction.js';
import { withMemberScope } from '../../packages/resource-scopes/index.js';
import type { Actor } from '../../modules/identity-membership/service.js';
import type { CreateExecutionGrantInput, ModelSelection } from '../../contracts/execution/v1/member-execution.js';
import { createServer } from 'node:http';
import { createModelStepService } from '../../modules/agent-execution/model-step-service.js';
import { createLocalFixtureModelStepHost, createUnavailableModelStepHost } from '../../modules/agent-execution/model-step-host.js';
import { Problem } from '../../packages/shared/problem.js';

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString || !/^\/fp_[a-z0-9_]+$/.test(new URL(connectionString).pathname)) throw new Error('Explicit isolated fp_* TEST_DATABASE_URL required.');
const schema = `fp_model_step_${process.pid}_${Date.now()}`, migrator = `${schema}_owner`, runtime = `${schema}_app`;
const admin = new Pool({ connectionString });
function roleUrl(role: string) { const url = new URL(connectionString!); url.username = role; url.password = ''; return url.toString(); }
const owner = new Pool({ connectionString: roleUrl(migrator), options: `-c search_path=${schema} -c statement_timeout=10000`, max: 8 });
const app = new Pool({ connectionString: roleUrl(runtime), options: `-c search_path=${schema} -c statement_timeout=10000`, max: 12 });
const options = { environment: 'local' as const, clientId: 'prerequisite-test' };
const api = createExecutionPrerequisites(app, options), runs = createExecutionRuns(app);
const works = createPrivateWorkCommands(app, { resolvePolicy: resolvePrivateWorkPersistencePolicy });
const enrollment = createRuntimeRegistrations(app, { environment: options.environment }), connections = createAgentConnections(app, options);
const selection: ModelSelection = { providerRef: 'openai', modelRef: 'synthetic-model', processingLocation: 'provider_remote',
  artifactCustody: 'platform_asset', credentialCustody: 'platform_vault', engineLocation: 'platform', billingSource: 'user_byok' };
const community = randomUUID(); let created = false;
before(async () => {
  await admin.query(`CREATE ROLE ${migrator} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
    CREATE ROLE ${runtime} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
    CREATE SCHEMA ${schema} AUTHORIZATION ${migrator}; GRANT USAGE ON SCHEMA ${schema} TO ${runtime}`);
  created = true; await migrate(owner);
  const template = await readFile(new URL('../../deploy/cloudflare/sql/20-runtime-grants.psql', import.meta.url), 'utf8');
  const prefix = template.slice(template.indexOf('BEGIN;'), template.indexOf('-- BEGIN PRIVATE POLICY GRANTS'))
    .replaceAll('SCHEMA public', `SCHEMA ${schema}`).replaceAll(':"runtime"', `"${runtime}"`);
  const grants = template.split('-- BEGIN PRIVATE POLICY GRANTS\n')[1].split('\n\\gexec')[0]
    .replaceAll(":'runtime'", `'${runtime}'`).replace("n.nspname='public'", `n.nspname='${schema}'`);
  const q = await owner.connect();
  try { await q.query(prefix); const rows = await q.query(grants); assert.equal(rows.rowCount, 2);
    for(const row of rows.rows) await q.query(Object.values(row)[0] as string); await q.query('COMMIT'); }
  catch (error) { await q.query('ROLLBACK'); throw error; } finally { q.release(); }
});
after(async () => { await app.end(); await owner.end(); try {
  if (created) await admin.query(`DROP SCHEMA ${schema} CASCADE; DROP ROLE ${runtime},${migrator}`);
} finally { await admin.end(); } });
beforeEach(async () => { await owner.query('TRUNCATE communities CASCADE'); await owner.query("INSERT INTO communities VALUES($1,'Synthetic prerequisites')", [community]); });
const status = (value: number) => (error: unknown) => error instanceof Problem && error.status === value;
const sqlCode = (...values: string[]) => (error: unknown) => values.includes((error as { code?: string }).code ?? '');
async function count(table: string) { return (await owner.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n; }
const tracked = ['model_connections','execution_grants','execution_attempts','scoped_transition_journal','scoped_outbox','scoped_command_receipts'];
const counts = () => Promise.all(tracked.map(count));
async function member() {
  const user = randomUUID(), session = randomUUID();
  const row = (await owner.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref)
    VALUES($1,$2,$3,'Synthetic owner','not-a-login',$4) RETURNING *`, [user, community, user+'@example.invalid', randomUUID()])).rows[0];
  await owner.query("INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at) VALUES($1,$2,'synthetic',clock_timestamp()+interval '1 hour')", [session, user]);
  const actor: Actor = { ...row, session_hash: session, csrf_token: 'synthetic' };
  const context = await withMemberScope(app, { actor, scope: 'personal' }, async () => {}, async (_q,c) => c);
  await owner.query(`INSERT INTO private_work_persistence_policy(scope_id,purpose,owner_principal_id,revision,persistence_allowed,retained_byte_limit)
    VALUES($1,'work.private-draft',$2,1,true,10485760)`, [context.scope.scope_id, context.subject_principal.principal_id]);
  return { actor, context };
}
async function fixture() {
  const f = await member(), pair = await generateKeyPair('ES256', { extractable: true });
  const challenge = await enrollment.begin(f.actor, { key: randomUUID(), publicJwk: parseRuntimePublicJwk(await exportJWK(pair.publicKey)) });
  const proof = await new CompactSign(new TextEncoder().encode(challenge.payload)).setProtectedHeader({ alg: 'ES256', typ: 'freedom-runtime-enrollment+jws' }).sign(pair.privateKey);
  const device = await enrollment.confirm(f.actor, { key: randomUUID(), challengeId: challenge.challenge_id, proof });
  const connection = await connections.create(f.actor, { key: randomUUID(), runtimeDeviceId: device.runtimeDeviceId });
  // Real 091 initial family/head built through its server composition helper.
  // No model evidence or machine execution credentials are fabricated.
  const family = await transaction(app, q => insertInitialRefreshFamily(q, connection.connectionId, new Date(connection.issuedAt), new Date(connection.expiresAt)));
  const work = await works.create(f.actor, { key: randomUUID(), title: 'Synthetic private goal', objective: 'PRIVATE_BODY_NOT_IN_PREREQUISITES' });
  const run = await runs.create(f.actor, { key: randomUUID(), workId: work.workId, expectedWorkVersion: '1' });
  const modelInput = { key: randomUUID(), connectionId: connection.connectionId, expectedConnectionVersion: '1', selection };
  const model = await api.models.create(f.actor, modelInput);
  const grantInput: CreateExecutionGrantInput = { key: randomUUID(), runId: run.runId, expectedRunVersion: '1', expectedWorkVersion: '1',
    connectionId: connection.connectionId, expectedConnectionVersion: '1', modelConnectionId: model.modelConnectionId, expectedModelVersion: '1', consent: true };
  return { ...f, device, connection, family, work, run, model, modelInput, grantInput };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const attemptInput = (f: Fixture, grantId: string) => ({ key: randomUUID(), runId: f.run.runId, grantId, expectedRunVersion: '1', expectedGrantVersion: '1' });
async function currentGrant(f: Fixture) { return api.grants.create(f.actor, f.grantInput); }
async function policyOff(f: Fixture) { await owner.query('UPDATE private_work_persistence_policy SET persistence_allowed=false,revision=revision+1 WHERE scope_id=$1', [f.context.scope.scope_id]); }
async function blocking(q: PoolClient) {
  const pid = (await q.query('SELECT pg_backend_pid() pid')).rows[0].pid;
  for (let i=0;i<200;i++) { if ((await admin.query('SELECT count(*)::int n FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))', [pid])).rows[0].n) return; await delay(10); }
  assert.fail('Actual PostgreSQL lock wait not observed');
}

let gets=0,posts=0,credentialExpires=()=>new Date(Date.now()+60000).toISOString(),generation='7';
const server=createServer((req,res)=>{
  res.setHeader('Content-Type','application/json');
  if(req.headers.authorization!=='Bearer synthetic-not-a-provider-key'){res.statusCode=401;res.end('{}');return;}
  if(req.method==='GET'){gets++;res.end(JSON.stringify({id:'synthetic-model',object:'model',created:0,owned_by:'synthetic-fixture'}));return;}
  posts++;let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{
    const parsed=JSON.parse(body);assert.equal(parsed.model,'synthetic-model');assert.equal(parsed.tools.length,0);
    res.end(JSON.stringify({id:'synthetic-response',object:'response',model:'synthetic-model',status:'completed',
      output:[{id:'synthetic-message',type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'PRIVATE_SYNTHETIC_MODEL_OUTPUT',annotations:[]}]}],
      usage:{input_tokens:3,output_tokens:4,total_tokens:7}}));
  });
});
let host:ReturnType<typeof createLocalFixtureModelStepHost>,steps:ReturnType<typeof createModelStepService>;
before(async()=>{await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();assert(address&&typeof address==='object');
  host=createLocalFixtureModelStepHost({environment:'local',origin:`http://127.0.0.1:${address.port}`,
    recover:async()=>({generation,expiresAt:credentialExpires()}),resolveCredential:async()=>({key:new TextEncoder().encode('synthetic-not-a-provider-key'),expiresAt:credentialExpires()})});
  steps=createModelStepService(app,{...options,host});});
after(async()=>{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));});
beforeEach(()=>{gets=0;posts=0;generation='7';credentialExpires=()=>new Date(Date.now()+60000).toISOString();});
async function approved() {
  const f=await fixture(),grant=await currentGrant(f);
  await owner.query(`INSERT INTO model_inference_export_policy(policy_id,scope_id,owner_principal_id,environment,client_id,selection,revision,export_allowed,max_prompt_bytes,max_output_tokens)
    VALUES($1,$2,$3,$4,$5,$6,1,true,16384,20)`,[randomUUID(),f.context.scope.scope_id,f.context.subject_principal.principal_id,options.environment,options.clientId,JSON.stringify(selection)]);
  const input={key:randomUUID(),runId:f.run.runId,grantId:grant.grantId,expectedRunVersion:'1',expectedGrantVersion:'1',expectedWorkVersion:'1',consent:true as const,maxOutputTokens:20};
  const approval=await steps.approvals.create(f.actor,input);return {...f,grant,approval,approvalInput:input};
}
const activateInput=(f:Awaited<ReturnType<typeof approved>>)=>({key:randomUUID(),approvalId:f.approval.approvalId,expectedApprovalVersion:'1',expectedRunVersion:'1'});
test('STEP-01 real paired backing needs separate exact export policy and explicit approval; unavailable host cannot activate',async()=>{
  const f=await fixture(),grant=await currentGrant(f);
  await assert.rejects(steps.approvals.create(f.actor,{key:randomUUID(),runId:f.run.runId,grantId:grant.grantId,expectedRunVersion:'1',expectedGrantVersion:'1',expectedWorkVersion:'1',consent:true,maxOutputTokens:20}),status(403));
  assert.equal(await count('model_export_approvals'),0);
  const a=await approved(),unavailable=createModelStepService(app,{...options,host:createUnavailableModelStepHost()});
  await assert.rejects(unavailable.activate(a.actor,activateInput(a)));assert.equal(await count('model_text_steps'),0);assert.equal(posts,0);
  assert.equal((await runs.read(a.actor,{runId:a.run.runId})).state,'created');
});
test('STEP-02 concurrent activation persists once, shares oldAttempt numbering, and begins exactly one replay-safe dispatch',async()=>{
  const f=await approved();await api.attempts.create(f.actor,attemptInput(f,f.grant.grantId));
  const input=activateInput(f),[a,b]=await Promise.all([steps.activate(f.actor,input),steps.activate(f.actor,input)]);assert.deepEqual(a,b);
  assert.equal(a.attemptNumber,2);assert.equal(a.activatedRunVersion,'2');assert.equal(a.taskLeaseEpoch,'2');assert.equal(a.controlEpoch,'1');assert.equal(a.operational_authority,false);
  assert.equal(await count('model_text_steps'),1);assert.equal(await count('execution_attempts'),2);
  await assert.rejects(currentGrant(f));await assert.rejects(api.attempts.create(f.actor,attemptInput(f,f.grant.grantId)));
  const beginInput={key:randomUUID(),stepId:a.stepId,expectedVersion:'1'},first=await steps.begin(f.actor,beginInput),replay=await steps.begin(f.actor,beginInput);
  assert(first.capability);assert.equal(replay.capability,null);assert.deepEqual(first.metadata,replay.metadata);assert.equal(first.metadata.usageStatus,'unknown');assert.equal(first.metadata.costStatus,'unknown');
  const context=await steps.context(f.actor,first.capability),observation=await host.dispatch(first.capability,context);assert.equal(posts,1);
  await assert.rejects(host.dispatch(first.capability,context));assert.equal(posts,1);
  const recorded=await steps.record(f.actor,first.capability,observation);assert.equal(recorded.state,'awaiting_result');assert.equal(recorded.usageStatus,'known');
  const persisted=JSON.stringify((await owner.query('SELECT observation FROM model_text_steps')).rows);assert(!persisted.includes('PRIVATE_SYNTHETIC_MODEL_OUTPUT'));
  const facts=JSON.stringify((await owner.query("SELECT data FROM scoped_transition_journal WHERE aggregate_type IN ('model_text_step','model_export_approval')")).rows);
  assert(!facts.includes('PRIVATE_BODY'));assert(!facts.includes('synthetic-not-a-provider-key'));assert(!facts.includes('PRIVATE_SYNTHETIC_MODEL_OUTPUT'));
});
test('STEP-03 Stop after begin prevents actual POST and retains consumed unknown reservation',async()=>{
  const f=await approved(),a=await steps.activate(f.actor,activateInput(f)),begun=await steps.begin(f.actor,{key:randomUUID(),stepId:a.stepId,expectedVersion:'1'});assert(begun.capability);
  const context=await steps.context(f.actor,begun.capability);const stopped=await steps.control(f.actor,{key:randomUUID(),stepId:a.stepId,expectedVersion:'2',action:'stop'});
  assert.equal(stopped.state,'outcome_unknown');assert.equal((await owner.query('SELECT state FROM execution_runs WHERE run_id=$1',[f.run.runId])).rows[0].state,'reconciling');
  await assert.rejects(runs.read(f.actor,{runId:f.run.runId}),status(409));
  await assert.rejects(host.dispatch(begun.capability,context));assert.equal(posts,0);
  assert.equal((await owner.query('SELECT reservation_held FROM model_text_steps')).rows[0].reservation_held,true);
  await assert.rejects(steps.begin(f.actor,{key:randomUUID(),stepId:a.stepId,expectedVersion:'3'}));
});
test('STEP-04 revoking approval denies old approval receipt, activation and pre-send callback',async()=>{
  const f=await approved(),a=await steps.activate(f.actor,activateInput(f)),begun=await steps.begin(f.actor,{key:randomUUID(),stepId:a.stepId,expectedVersion:'1'});assert(begun.capability);
  const bytes=await steps.context(f.actor,begun.capability);
  await steps.approvals.revoke(f.actor,{key:randomUUID(),approvalId:f.approval.approvalId,expectedVersion:'1'});
  await assert.rejects(steps.approvals.create(f.actor,f.approvalInput));await assert.rejects(host.dispatch(begun.capability,bytes));assert.equal(posts,0);
  assert.equal((await steps.approvals.read(f.actor,{approvalId:f.approval.approvalId})).state,'revoked');
});
test('STEP-05 Work edit, policy withdrawal and foreign owner block activation without POST',async()=>{
  for(const change of ['work','policy','owner'] as const){const f=await approved();
    if(change==='work')await works.update(f.actor,{key:randomUUID(),workId:f.work.workId,expectedVersion:'1',title:'Edited',objective:'Changed'});
    if(change==='policy')await owner.query('UPDATE model_inference_export_policy SET export_allowed=false,revision=revision+1 WHERE scope_id=$1',[f.context.scope.scope_id]);
    const actor=change==='owner'?(await member()).actor:f.actor;await assert.rejects(steps.activate(actor,activateInput(f)));}
  assert.equal(posts,0);assert.equal(await count('model_text_steps'),0);
});
test('STEP-06 genuine host proof expiry clips lease; expired dispatch never POSTs',async()=>{
  const f=await approved();credentialExpires=()=>new Date(Date.now()+450).toISOString();const a=await steps.activate(f.actor,activateInput(f));
  assert(Date.parse(a.expiresAt)-Date.now()<=450);await delay(500);await assert.rejects(steps.begin(f.actor,{key:randomUUID(),stepId:a.stepId,expectedVersion:'1'}));assert.equal(posts,0);
});
test('STEP-07 forged observations and external recovery change never become known durable evidence',async()=>{
  const f=await approved(),a=await steps.activate(f.actor,activateInput(f)),begun=await steps.begin(f.actor,{key:randomUUID(),stepId:a.stepId,expectedVersion:'1'});assert(begun.capability);
  const observation=await host.dispatch(begun.capability,await steps.context(f.actor,begun.capability));
  await assert.rejects(steps.record(f.actor,begun.capability,{} as never));generation='8';await assert.rejects(steps.record(f.actor,begun.capability,observation));
  assert.equal((await steps.read(f.actor,{stepId:a.stepId})).usageStatus,'unknown');
  const unknown=await steps.unknown(f.actor,begun.capability);assert.equal(unknown.state,'outcome_unknown');assert.equal(unknown.usageStatus,'unknown');assert.equal(posts,1);
});
test('STEP-08 strict caller input rejects arbitrary prompt, auth/policy claims and accessors before effects',async()=>{
  const f=await approved();for(const extra of [{prompt:'smuggled'},{modelReady:true},{policyAllowed:true},{recoveryGeneration:'1'},{operational_authority:true}])
    await assert.rejects(steps.activate(f.actor,{...activateInput(f),...extra}));
  const raw={...activateInput(f)};Object.defineProperty(raw,'approvalId',{enumerable:true,get(){assert.fail('Untrusted accessor ran');}});await assert.rejects(steps.activate(f.actor,raw));
  assert.equal(await count('model_text_steps'),0);assert.equal(posts,0);
});
test('STEP-09 direct runtime SQL rejects NULL dispatch permit, immutable Attempt mutation and operator policy edits',async()=>{
  const f=await approved(),a=await steps.activate(f.actor,activateInput(f));
  await assert.rejects(app.query(`UPDATE model_text_steps SET state='dispatched',usage_status='unknown',aggregate_version=aggregate_version+1,
    dispatched_at=date_trunc('milliseconds',clock_timestamp()),permit_expires_at=NULL WHERE step_id=$1`,[a.stepId]),sqlCode('23514'));
  assert.equal((await steps.read(f.actor,{stepId:a.stepId})).state,'reserved');
  await assert.rejects(app.query("UPDATE execution_attempts SET state='preflight_blocked',blockers='[]'::jsonb WHERE attempt_id=$1",[a.attemptId]),sqlCode('23514'));
  await assert.rejects(app.query('UPDATE model_inference_export_policy SET export_allowed=false WHERE scope_id=$1',[f.context.scope.scope_id]),sqlCode('42501'));
  assert.equal(posts,0);
});
test('STEP-10 actual receipt read lock crossing host expiry rolls back known observation and leaves unknown reservation',async()=>{
  const f=await approved(),expiry=new Date(Date.now()+900).toISOString();credentialExpires=()=>expiry;
  const a=await steps.activate(f.actor,activateInput(f)),begun=await steps.begin(f.actor,{key:randomUUID(),stepId:a.stepId,expectedVersion:'1'});assert(begun.capability);
  const observation=await host.dispatch(begun.capability,await steps.context(f.actor,begun.capability));const q=await owner.connect();
  try{await q.query('BEGIN');await q.query('LOCK TABLE scoped_command_receipts IN ACCESS EXCLUSIVE MODE');
    const pending=steps.record(f.actor,begun.capability,observation);const rejection=assert.rejects(pending);await blocking(q);
    await delay(Math.max(0,Date.parse(expiry)-Date.now())+100);await q.query('COMMIT');await rejection;
  }finally{await q.query('ROLLBACK');q.release();}
  const retained=await steps.read(f.actor,{stepId:a.stepId});assert.equal(retained.state,'dispatched');assert.equal(retained.usageStatus,'unknown');
  assert.equal((await owner.query('SELECT observation FROM model_text_steps')).rows[0].observation,null);assert.equal(posts,1);
});

function replica() {
  const address=server.address();assert(address&&typeof address==='object');
  const host=createLocalFixtureModelStepHost({environment:'local',origin:`http://127.0.0.1:${address.port}`,
    recover:async()=>({generation,expiresAt:credentialExpires()}),
    resolveCredential:async()=>({key:new TextEncoder().encode('synthetic-not-a-provider-key'),expiresAt:credentialExpires()})});
  return {host,steps:createModelStepService(app,{...options,host})};
}
test('STEP-11 independent host/service continues SQL reservation with fresh proof; acknowledgement is metadata only',async()=>{
  const f=await approved(),input=activateInput(f),a=await steps.activate(f.actor,input);
  const stored=(await owner.query('SELECT verified_binding FROM model_text_steps WHERE step_id=$1',[a.stepId])).rows[0].verified_binding;
  const b=replica(),metadataOnly=createModelStepService(app,{...options,host:createUnavailableModelStepHost()});
  assert.deepEqual(await metadataOnly.readActivation(f.actor,input),a);assert.equal(gets,1);
  const command={key:randomUUID(),stepId:a.stepId,expectedVersion:'1'};
  const begun=await b.steps.begin(f.actor,command);assert(begun.capability);assert.equal(gets,2);
  const fresh=(await owner.query('SELECT verified_binding FROM model_text_steps WHERE step_id=$1',[a.stepId])).rows[0].verified_binding;
  assert.notEqual(fresh.bindingId,stored.bindingId);assert.deepEqual(fresh.binding,stored.binding);
  const replay=await replica().steps.begin(f.actor,command);assert.equal(replay.capability,null);assert.equal(gets,2);
  const observation=await b.host.dispatch(begun.capability,await b.steps.context(f.actor,begun.capability));
  await b.steps.record(f.actor,begun.capability,observation);assert.equal(posts,1);
  await assert.rejects(replica().steps.begin(f.actor,{...command,key:randomUUID(),expectedVersion:'3'}));
  assert.equal(gets,2);assert.equal(posts,1);
  assert.equal((await metadataOnly.readActivation(f.actor,input)).state,'awaiting_result');
});
test('STEP-12 two independent services race one SQL reservation; unknown dispatch never regains authority',async()=>{
  const f=await approved(),a=await steps.activate(f.actor,activateInput(f)),b=replica(),c=replica();
  const command={key:randomUUID(),stepId:a.stepId,expectedVersion:'1'};
  const results=await Promise.all([b.steps.begin(f.actor,command),c.steps.begin(f.actor,command)]);
  assert.equal(results.filter(r=>r.capability).length,1);
  const i=results.findIndex(r=>r.capability),winner=i===0?b:c,cap=results[i].capability!;
  await winner.host.dispatch(cap,await winner.steps.context(f.actor,cap));assert.equal(posts,1);
  await winner.steps.unknown(f.actor,cap);const before=gets;
  for(const service of [winner.steps,replica().steps]) {
    await assert.rejects(service.begin(f.actor,command));
    await assert.rejects(service.begin(f.actor,{...command,key:randomUUID(),expectedVersion:'3'}));
  }
  assert.equal(gets,before);assert.equal(posts,1);
});
test('STEP-13 continuation cannot cross recovery generation or withdrawn approval',async()=>{
  for(const change of ['generation','approval'] as const) {
    generation='7';const f=await approved(),a=await steps.activate(f.actor,activateInput(f));
    if(change==='generation')generation='8';else await steps.approvals.revoke(f.actor,{key:randomUUID(),approvalId:f.approval.approvalId,expectedVersion:'1'});
    await assert.rejects(replica().steps.begin(f.actor,{key:randomUUID(),stepId:a.stepId,expectedVersion:'1'}));
    assert.equal((await steps.read(f.actor,{stepId:a.stepId})).state,'reserved');
  }
  assert.equal(posts,0);
});
test('STEP-14 repeated control on cancelled step returns typed conflict without duplicate journal version',async()=>{
  const f=await approved(),a=await steps.activate(f.actor,activateInput(f));
  const command={key:randomUUID(),stepId:a.stepId,expectedVersion:'1',action:'pause' as const};
  const paused=await steps.control(f.actor,command);assert.equal(paused.state,'cancelled');
  assert.deepEqual(await replica().steps.control(f.actor,command),paused);
  const before=await counts();
  await assert.rejects(replica().steps.control(f.actor,{...command,key:randomUUID(),expectedVersion:'2',action:'stop'}),
    (error:unknown)=>error instanceof Problem&&error.status===409&&error.code==='model_step_already_consumed');
  assert.deepEqual(await counts(),before);assert.equal(posts,0);
});
