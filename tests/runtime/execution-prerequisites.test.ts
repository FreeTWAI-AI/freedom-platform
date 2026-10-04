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
import { Problem } from '../../packages/shared/problem.js';

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString || !/^\/fp_[a-z0-9_]+$/.test(new URL(connectionString).pathname)) throw new Error('Explicit isolated fp_* TEST_DATABASE_URL required.');
const schema = `fp_prereq_${process.pid}_${Date.now()}`, migrator = `${schema}_owner`, runtime = `${schema}_app`;
const admin = new Pool({ connectionString });
function roleUrl(role: string) { const url = new URL(connectionString!); url.username = role; url.password = ''; return url.toString(); }
const owner = new Pool({ connectionString: roleUrl(migrator), options: `-c search_path=${schema} -c statement_timeout=10000`, max: 8 });
const app = new Pool({ connectionString: roleUrl(runtime), options: `-c search_path=${schema} -c statement_timeout=10000`, max: 12 });
const options = { environment: 'local' as const, clientId: 'prerequisite-test' };
const api = createExecutionPrerequisites(app, options), runs = createExecutionRuns(app);
const works = createPrivateWorkCommands(app, { resolvePolicy: resolvePrivateWorkPersistencePolicy });
const enrollment = createRuntimeRegistrations(app, { environment: options.environment }), connections = createAgentConnections(app, options);
const selection: ModelSelection = { providerRef: 'synthetic-provider', modelRef: 'synthetic-model', processingLocation: 'unverified-location',
  artifactCustody: 'runtime_local', credentialCustody: 'official_cli', engineLocation: 'runtime_local', billingSource: 'user_cli' };
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
    for (const row of rows.rows) await q.query(Object.values(row)[0] as string); await q.query('COMMIT'); }
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

test('PREREQ-01 dedicated non-superuser sessions create only unverified selection, exact consent and blocked immutable attempt', async () => {
  for (const [pool, name] of [[owner,migrator],[app,runtime]] as const) {
    const row = (await pool.query('SELECT current_user,session_user,rolsuper,rolcreaterole,rolcreatedb,rolreplication,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0];
    assert.deepEqual(row, { current_user:name,session_user:name,rolsuper:false,rolcreaterole:false,rolcreatedb:false,rolreplication:false,rolbypassrls:false });
  }
  const f = await fixture(), grant = await currentGrant(f), input = attemptInput(f, grant.grantId), attempt = await api.attempts.create(f.actor, input);
  assert.equal(f.model.state, 'unverified'); assert.deepEqual(f.model.selection, selection); assert.equal(f.model.operational_authority, false);
  assert.equal(grant.state, 'active'); assert.equal(grant.purpose, 'model.private-draft'); assert.equal(grant.familyId, f.family.familyId);
  assert.equal(Date.parse(grant.expiresAt)-Date.parse(grant.issuedAt), 3600000);
  assert.deepEqual(attempt.grant, grant); assert.equal(attempt.attemptNumber, 1); assert.equal(attempt.state, 'preflight_blocked');
  assert.deepEqual(attempt.blockers, ['model_authentication_unavailable','model_adapter_unavailable']); assert.equal(attempt.operational_authority, false);
  assert.deepEqual(await api.models.read(f.actor, { modelConnectionId:f.model.modelConnectionId }), f.model);
  assert.deepEqual(await api.grants.read(f.actor, { grantId:grant.grantId }), grant);
  assert.deepEqual(await api.attempts.read(f.actor, { attemptId:attempt.attemptId }), attempt);
  const work = (await owner.query('SELECT aggregate_version::text FROM work_items WHERE work_item_id=$1', [f.work.workId])).rows[0]; assert.equal(work.aggregate_version,'1');
  assert.deepEqual(await runs.read(f.actor, { runId:f.run.runId }), f.run);
  for (const table of ['outbox','private_work_results','work_claims','contributions']) assert.equal(await count(table),0);
  const persisted = JSON.stringify((await owner.query("SELECT data FROM scoped_transition_journal WHERE aggregate_type IN ('model_connection','execution_grant','execution_attempt')")).rows);
  assert(!persisted.includes('PRIVATE_BODY')); assert(!persisted.includes('synthetic-model')); assert(!persisted.includes(f.actor.session_hash));
});
test('PREREQ-02 concurrent same-key creates persist exactly once and altered metadata conflict', async () => {
  const f = await fixture(); assert.deepEqual(await api.models.create(f.actor,f.modelInput),f.model);
  const [a,b] = await Promise.all([currentGrant(f),currentGrant(f)]); assert.deepEqual(a,b); assert.equal(await count('execution_grants'),1);
  const input = attemptInput(f,a.grantId), [x,y] = await Promise.all([api.attempts.create(f.actor,input),api.attempts.create(f.actor,input)]);
  assert.deepEqual(x,y); assert.equal(await count('execution_attempts'),1);
  await assert.rejects(api.models.create(f.actor,{ ...f.modelInput,selection:{ ...selection,modelRef:'other-model' } }),status(409));
  await assert.rejects(api.grants.create(f.actor,{ ...f.grantInput,expectedModelVersion:'2' }),status(412));
});
test('PREREQ-03 strict explicit metadata forbids fake readiness, credentials, caller policy, fallback and omitted versions', async () => {
  const f = await fixture(), baseline = await counts();
  for (const extra of [{modelReady:true},{operational_authority:true},{secretRef:'forbidden'},{apiKey:'forbidden'},{familyId:randomUUID()},{providerUrl:'https://invalid.example'}])
    await assert.rejects(api.models.create(f.actor,{ ...f.modelInput,key:randomUUID(),...extra }));
  for (const field of ['providerRef','modelRef','processingLocation','artifactCustody','credentialCustody','engineLocation','billingSource']) {
    const incomplete = { ...selection } as Record<string,unknown>; delete incomplete[field]; await assert.rejects(api.models.create(f.actor,{ ...f.modelInput,key:randomUUID(),selection:incomplete } as never));
  }
  await assert.rejects(api.models.create(f.actor,{ key:randomUUID(),connectionId:f.connection.connectionId,selection } as never),status(428));
  for (const field of ['expectedRunVersion','expectedWorkVersion','expectedConnectionVersion','expectedModelVersion']) {
    const incomplete = { ...f.grantInput,key:randomUUID() } as Record<string,unknown>; delete incomplete[field]; await assert.rejects(api.grants.create(f.actor,incomplete as never),status(428));
  }
  for (const extra of [{consent:false},{policyRevision:'private-work.v1'},{fallback:'platform'},{expiresAt:'2099-01-01T00:00:00.000Z'},{budget:1}])
    await assert.rejects(api.grants.create(f.actor,{ ...f.grantInput,key:randomUUID(),...extra } as never));
  const raw = { ...f.modelInput,key:randomUUID() }; Object.defineProperty(raw,'selection',{ enumerable:true,get() { assert.fail('Untrusted getter executed'); } }); await assert.rejects(api.models.create(f.actor,raw));
  assert.throws(()=>createExecutionPrerequisites(app,{ ...options,grantTtlSeconds:0 })); assert.throws(()=>createExecutionPrerequisites(app,{ ...options,grantTtlSeconds:3601 }));
  assert.deepEqual(await counts(),baseline);
});
test('PREREQ-04 peer/admin assertions and wrong server environment/client cannot reveal private records', async () => {
  const f = await fixture(), peer = await member(), grant = await currentGrant(f), attempt = await api.attempts.create(f.actor,attemptInput(f,grant.grantId));
  const other = { ...peer.actor,is_admin:true } as Actor;
  for (const id of [f.model.modelConnectionId,randomUUID()]) await assert.rejects(api.models.read(other,{modelConnectionId:id}),status(404));
  for (const id of [grant.grantId,randomUUID()]) await assert.rejects(api.grants.read(other,{grantId:id}),status(404));
  for (const id of [attempt.attemptId,randomUUID()]) await assert.rejects(api.attempts.read(other,{attemptId:id}),status(404));
  await assert.rejects(api.grants.create(other,f.grantInput),status(404));
  for (const otherApi of [createExecutionPrerequisites(app,{...options,environment:'next'}),createExecutionPrerequisites(app,{...options,clientId:'other-client'})]) {
    await assert.rejects(otherApi.models.read(f.actor,{modelConnectionId:f.model.modelConnectionId}),status(404));
    await assert.rejects(otherApi.grants.read(f.actor,{grantId:grant.grantId}),status(404));
    await assert.rejects(otherApi.attempts.read(f.actor,{attemptId:attempt.attemptId}),status(404));
  }
});
test('PREREQ-05 grant revocation has one CAS winner, invalidates create/replay, and leaves original Attempt snapshot readable', async () => {
  const f = await fixture(), grant = await currentGrant(f), input = attemptInput(f,grant.grantId), attempt = await api.attempts.create(f.actor,input);
  const revoke = {key:randomUUID(),grantId:grant.grantId,expectedVersion:'1'};
  const settled = await Promise.allSettled([api.grants.revoke(f.actor,revoke),api.grants.revoke(f.actor,{...revoke,key:randomUUID()})]);
  assert.equal(settled.filter(v=>v.status==='fulfilled').length,1); const rejected = settled.find(v=>v.status==='rejected') as PromiseRejectedResult; assert(status(412)(rejected.reason));
  assert.deepEqual(await api.grants.revoke(f.actor,revoke),await api.grants.read(f.actor,{grantId:grant.grantId}));
  await assert.rejects(currentGrant(f),status(409)); await assert.rejects(api.attempts.create(f.actor,input),status(409));
  await assert.rejects(api.attempts.create(f.actor,attemptInput(f,grant.grantId)),status(409));
  assert.deepEqual(await api.attempts.read(f.actor,{attemptId:attempt.attemptId}),attempt); assert.equal(attempt.grant.state,'active');
  assert.equal((await api.grants.read(f.actor,{grantId:grant.grantId})).state,'revoked');
});
for (const withdrawal of ['policy','archive','pause','model','connection','runtime'] as const) test(`PREREQ-06 ${withdrawal} blocks fresh and replayed preflight but retained reads/revokes remain available`,async()=>{
  const f = await fixture(), grant = await currentGrant(f), input = attemptInput(f,grant.grantId), attempt = await api.attempts.create(f.actor,input);
  if (withdrawal==='policy') await policyOff(f);
  if (withdrawal==='archive') await works.archive(f.actor,{key:randomUUID(),workId:f.work.workId,expectedVersion:'1'});
  if (withdrawal==='pause') await runs.pause(f.actor,{key:randomUUID(),runId:f.run.runId,expectedVersion:'1'});
  if (withdrawal==='model') await api.models.revoke(f.actor,{key:randomUUID(),modelConnectionId:f.model.modelConnectionId,expectedVersion:'1'});
  if (withdrawal==='connection') await connections.revoke(f.actor,{key:randomUUID(),connectionId:f.connection.connectionId,expectedVersion:'1'});
  if (withdrawal==='runtime') await enrollment.revoke(f.actor,{key:randomUUID(),runtimeDeviceId:f.device.runtimeDeviceId,expectedVersion:'1'});
  await assert.rejects(currentGrant(f)); await assert.rejects(api.attempts.create(f.actor,input)); await assert.rejects(api.attempts.create(f.actor,attemptInput(f,grant.grantId)));
  assert.deepEqual(await api.attempts.read(f.actor,{attemptId:attempt.attemptId}),attempt);
  assert.equal((await api.grants.revoke(f.actor,{key:randomUUID(),grantId:grant.grantId,expectedVersion:'1'})).state,'revoked');
  if (withdrawal!=='model') assert.equal((await api.models.revoke(f.actor,{key:randomUUID(),modelConnectionId:f.model.modelConnectionId,expectedVersion:'1'})).state,'revoked');
});
test('PREREQ-07 human edit invalidates immutable Work input and stale Run/connection/model/grant versions fail closed',async()=>{
  const f = await fixture();
  for (const field of ['expectedRunVersion','expectedWorkVersion','expectedConnectionVersion','expectedModelVersion']) await assert.rejects(api.grants.create(f.actor,{...f.grantInput,key:randomUUID(),[field]:'2'}),status(412));
  const grant = await currentGrant(f); await assert.rejects(api.attempts.create(f.actor,{...attemptInput(f,grant.grantId),expectedGrantVersion:'2'}),status(412));
  await works.update(f.actor,{key:randomUUID(),workId:f.work.workId,expectedVersion:'1',title:'Human edit',objective:'Changed'});
  await assert.rejects(currentGrant(f),status(409)); await assert.rejects(api.attempts.create(f.actor,attemptInput(f,grant.grantId)),status(409)); assert.equal(await count('execution_attempts'),0);
});
test('PREREQ-08 exact bigint snapshot survives PostgreSQL JSONB parsing above Number safe integer',async()=>{
  const f = await fixture(), exact='9007199254740993';
  await owner.query('UPDATE work_items SET aggregate_version=$2 WHERE work_item_id=$1',[f.work.workId,exact]);
  const run = await runs.create(f.actor,{key:randomUUID(),workId:f.work.workId,expectedWorkVersion:exact});
  const grant = await api.grants.create(f.actor,{...f.grantInput,key:randomUUID(),runId:run.runId,expectedWorkVersion:exact});
  const attempt = await api.attempts.create(f.actor,{key:randomUUID(),runId:run.runId,grantId:grant.grantId,expectedRunVersion:'1',expectedGrantVersion:'1'});
  assert.equal(attempt.grant.inputWorkVersion,exact); assert.equal((await api.attempts.read(f.actor,{attemptId:attempt.attemptId})).grant.inputWorkVersion,exact);
  assert.equal((await owner.query('SELECT grant_snapshot->>\'input_work_version\' version FROM execution_attempts')).rows[0].version,exact);
});
test('PREREQ-09 SQL cannot rebind, activate, delete, mutate history or attach arbitrary Attempt snapshot',async()=>{
  const f = await fixture(), grant = await currentGrant(f), attempt = await api.attempts.create(f.actor,attemptInput(f,grant.grantId));
  for (const [table,idColumn,id,sets] of [
    ['model_connections','model_connection_id',f.model.modelConnectionId,["state='ready'","selection=selection||'{\"modelRef\":\"switched\"}'::jsonb","aggregate_version=2","family_id=gen_random_uuid()"]],
    ['execution_grants','grant_id',grant.grantId,["state='running'","run_version=2","expires_at=expires_at+interval '1 minute'","consent=false","persistence_policy_revision='private-work.v2'"]],
    ['execution_attempts','attempt_id',attempt.attemptId,["state='ready'","grant_snapshot='{}'::jsonb","attempt_number=2","created_at=created_at+interval '1 second'"]],
  ] as const) {
    for (const set of sets) await assert.rejects(app.query(`UPDATE ${table} SET ${set} WHERE ${idColumn}=$1`,[id]),sqlCode('23514'));
    await assert.rejects(app.query(`DELETE FROM ${table} WHERE ${idColumn}=$1`,[id]),sqlCode('23514'));
  }
  const raw=(await owner.query('SELECT * FROM execution_attempts WHERE attempt_id=$1',[attempt.attemptId])).rows[0];
  const changed={...raw,attempt_id:randomUUID(),attempt_number:2,grant_snapshot:{}};
  await assert.rejects(app.query(`INSERT INTO execution_attempts(${Object.keys(changed).join(',')}) VALUES(${Object.keys(changed).map((_,i)=>'$'+(i+1)).join(',')})`,Object.entries(changed).map(([key,value])=>['grant_snapshot','blockers'].includes(key)?JSON.stringify(value):value)),sqlCode('23514'));
});
for (const sink of ['scoped_transition_journal','scoped_outbox','scoped_command_receipts']) test(`PREREQ-10 ${sink} failure rolls back domain metadata and receipts atomically`,async()=>{
  const f=await fixture(), valid=await currentGrant(f), baseline=await counts();
  await owner.query("CREATE FUNCTION fp_prereq_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic fault'; END $$");
  await owner.query(`CREATE TRIGGER fp_prereq_fault BEFORE INSERT ON ${sink} FOR EACH ROW EXECUTE FUNCTION fp_prereq_fault()`);
  try {
    await assert.rejects(api.grants.create(f.actor,{...f.grantInput,key:randomUUID()}));
    await assert.rejects(api.models.create(f.actor,{...f.modelInput,key:randomUUID()}));
    await assert.rejects(api.attempts.create(f.actor,attemptInput(f,valid.grantId)));
  } finally { await owner.query(`DROP TRIGGER fp_prereq_fault ON ${sink}`); await owner.query('DROP FUNCTION fp_prereq_fault()'); }
  assert.deepEqual(await counts(),baseline); assert.equal((await currentGrant(f)).state,'active');
});
test('PREREQ-11 session expiry after a genuine Grant row wait rejects preflight without private replay or writes',async()=>{
  const f=await fixture(), grant=await currentGrant(f), input=attemptInput(f,grant.grantId), holder=await owner.connect();
  await owner.query("UPDATE sessions SET expires_at=clock_timestamp()+interval '350 milliseconds' WHERE token_hash=$1",[f.actor.session_hash]);
  await holder.query('BEGIN'); await holder.query('SELECT grant_id FROM execution_grants WHERE grant_id=$1 FOR UPDATE',[grant.grantId]);
  const operation=api.attempts.create(f.actor,input), rejected=assert.rejects(operation,status(401));
  try { await blocking(holder); while (!(await owner.query('SELECT expires_at<=clock_timestamp() expired FROM sessions WHERE token_hash=$1',[f.actor.session_hash])).rows[0].expired) await delay(10); }
  finally { await holder.query('ROLLBACK'); holder.release(); }
  await rejected; assert.equal(await count('execution_attempts'),0);
});
test('PREREQ-12 model lifetime32 and attempt lifetime16 limits retain tombstones and same-key replay',async()=>{
  const f=await fixture(), grant=await currentGrant(f);
  for(let i=1;i<32;i++) await api.models.create(f.actor,{...f.modelInput,key:randomUUID()});
  await api.models.revoke(f.actor,{key:randomUUID(),modelConnectionId:f.model.modelConnectionId,expectedVersion:'1'});
  await assert.rejects(api.models.create(f.actor,{...f.modelInput,key:randomUUID()}),status(429)); assert.equal(await count('model_connections'),32);
  // A new member avoids the deliberately revoked original binding.
  const next=await fixture(), nextGrant=await currentGrant(next); let lastInput=attemptInput(next,nextGrant.grantId),last=await api.attempts.create(next.actor,lastInput);
  for(let i=1;i<16;i++) {lastInput=attemptInput(next,nextGrant.grantId);last=await api.attempts.create(next.actor,lastInput);}
  assert.equal(last.attemptNumber,16); assert.deepEqual(await api.attempts.create(next.actor,lastInput),last);
  await assert.rejects(api.attempts.create(next.actor,attemptInput(next,nextGrant.grantId)),status(429)); assert.equal(await count('execution_attempts'),16);
  assert.equal(grant.operational_authority,false);
});

test('PREREQ-13 Grant lifetime256 limit retains revocation tombstones and permits exact valid replay',async()=>{
  const f=await fixture(), first=await currentGrant(f);
  let input=f.grantInput,last=first;
  for(let i=1;i<256;i++) {input={...f.grantInput,key:randomUUID()};last=await api.grants.create(f.actor,input);}
  assert.deepEqual(await api.grants.create(f.actor,input),last);
  await api.grants.revoke(f.actor,{key:randomUUID(),grantId:first.grantId,expectedVersion:'1'});
  await assert.rejects(api.grants.create(f.actor,{...f.grantInput,key:randomUUID()}),status(429));
  assert.equal(await count('execution_grants'),256);
});
