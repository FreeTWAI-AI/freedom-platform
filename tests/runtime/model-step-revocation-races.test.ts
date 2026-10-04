import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { CompactSign, exportJWK, generateKeyPair } from 'jose';
import { Pool, type PoolClient } from 'pg';
import type { BootstrapSessionHost } from '../../contracts/execution/v1/bootstrap-session.js';
import type { CreateExecutionGrantInput, ModelSelection } from '../../contracts/execution/v1/member-execution.js';
import { ModelStepBindingSchema, ModelStepMetadataSchema, type ModelStepBinding, type ModelStepMetadata } from '../../contracts/execution/v2/model-step.js';
import { createAgentConnections } from '../../modules/agent-control/agent-connections.js';
import { createBootstrapSessions } from '../../modules/agent-control/bootstrap-sessions.js';
import { insertInitialRefreshFamily } from '../../modules/agent-control/bootstrap-session-store.js';
import { createDeviceAuthorizations } from '../../modules/agent-control/device-authorizations.js';
import { createRuntimeRegistrationChallenge, parseRuntimePublicJwk } from '../../modules/agent-control/runtime-proof.js';
import { createRuntimeRegistrations } from '../../modules/agent-control/runtime-registration.js';
import { AdapterFault } from '../../modules/agent-execution/adapters/common.js';
import { createModelStepCapability, createLocalFixtureModelStepHost } from '../../modules/agent-execution/model-step-host.js';
import { createModelStepRunner } from '../../modules/agent-execution/model-step-runner.js';
import { createModelStepService } from '../../modules/agent-execution/model-step-service.js';
import { createExecutionPrerequisites } from '../../modules/agent-execution/prerequisites.js';
import { createExecutionRuns } from '../../modules/agent-execution/runs.js';
import { resolvePrivateWorkPersistencePolicy } from '../../modules/autopilot-work/policy.js';
import type { Actor } from '../../modules/identity-membership/service.js';
import { createPrivateWorkCommands } from '../../modules/opportunity-project-work/private-commands.js';
import { transaction } from '../../packages/db/transaction.js';
import { withMemberScope } from '../../packages/resource-scopes/index.js';
import { Problem } from '../../packages/shared/problem.js';
import { migrate } from '../../scripts/database.js';

/** Loopback synthetic provider only. A same-key begin is the historical receipt.
 * Withdrawing backing must not create another dispatch or POST. Owner stop, not
 * the revoke itself, is what reconciles a consumed step. Nothing here enables a
 * flag, accepts a real owner, or contacts a production provider. */

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString || !/^\/fp_[a-z0-9_]+$/.test(new URL(connectionString).pathname)) {
  throw new Error('Explicit isolated fp_* TEST_DATABASE_URL required.');
}
const schema = `fp_revoke_race_${process.pid}_${Date.now()}`;
const migrator = `${schema}_owner`;
const runtime = `${schema}_app`;
const admin = new Pool({ connectionString });
function roleUrl(role: string) {
  const url = new URL(connectionString!);
  url.username = role;
  url.password = '';
  return url.toString();
}
const owner = new Pool({ connectionString: roleUrl(migrator), options: `-c search_path=${schema} -c statement_timeout=10000`, max: 8 });
const app = new Pool({ connectionString: roleUrl(runtime), options: `-c search_path=${schema} -c statement_timeout=10000`, max: 12 });
const options = { environment: 'local' as const, clientId: 'revocation-race' };
const api = createExecutionPrerequisites(app, options);
const runs = createExecutionRuns(app);
const works = createPrivateWorkCommands(app, { resolvePolicy: resolvePrivateWorkPersistencePolicy });
const enrollment = createRuntimeRegistrations(app, { environment: options.environment });
const connections = createAgentConnections(app, options);
const selection: ModelSelection = {
  providerRef: 'openai', modelRef: 'synthetic-model', processingLocation: 'provider_remote',
  artifactCustody: 'platform_asset', credentialCustody: 'platform_vault', engineLocation: 'platform', billingSource: 'user_byok',
};
const community = randomUUID();
let created = false;
let pairing: Awaited<ReturnType<typeof createDeviceAuthorizations>>;
let sessions: Awaited<ReturnType<typeof createBootstrapSessions>>;
let sessionHost: BootstrapSessionHost;
let pairingHost: Parameters<typeof createDeviceAuthorizations>[1]['host'];
let host: ReturnType<typeof createLocalFixtureModelStepHost>;
let steps: ReturnType<typeof createModelStepService>;
let posts = 0;
let nextPost: 'refuse' | 'complete' = 'refuse';
const credentialExpires = () => new Date(Date.now() + 60000).toISOString();

before(async () => {
  await admin.query(`CREATE ROLE ${migrator} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
    CREATE ROLE ${runtime} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
    CREATE SCHEMA ${schema} AUTHORIZATION ${migrator}; GRANT USAGE ON SCHEMA ${schema} TO ${runtime}`);
  created = true;
  await migrate(owner);
  const template = await readFile(new URL('../../deploy/cloudflare/sql/20-runtime-grants.psql', import.meta.url), 'utf8');
  const prefix = template.slice(template.indexOf('BEGIN;'), template.indexOf('-- BEGIN PRIVATE POLICY GRANTS'))
    .replaceAll('SCHEMA public', `SCHEMA ${schema}`).replaceAll(':"runtime"', `"${runtime}"`);
  const grants = template.split('-- BEGIN PRIVATE POLICY GRANTS\n')[1].split('\n\\gexec')[0]
    .replaceAll(":'runtime'", `'${runtime}'`).replace("n.nspname='public'", `n.nspname='${schema}'`);
  const q = await owner.connect();
  try {
    await q.query(prefix);
    const rows = await q.query(grants);
    assert.equal(rows.rowCount, 2);
    for (const row of rows.rows) await q.query(Object.values(row)[0] as string);
    await q.query('COMMIT');
  } catch (error) {
    await q.query('ROLLBACK');
    throw error;
  } finally { q.release(); }
  const issuer = await generateKeyPair('ES256');
  sessionHost = {
    ...options, issuerKid: 'synthetic-issuer', issuer: 'https://issuer.example.invalid/', audience: 'https://platform.example.invalid/',
    bootstrapUri: 'https://platform.example.invalid/execution-api/v1/bootstrap',
    refreshUri: 'https://platform.example.invalid/execution-api/v1/auth/refresh',
    nonceUri: 'https://platform.example.invalid/execution-api/v1/auth/nonce',
    keys: [{ kid: 'synthetic-issuer', purpose: 'bootstrap_access', environment: 'local',
      publicJwk: parseRuntimePublicJwk(await exportJWK(issuer.publicKey)), notBeforeMs: 0, notAfterMs: Number.MAX_SAFE_INTEGER, revoked: false }],
  };
  const { refreshUri: _refresh, nonceUri: _nonce, ...base } = sessionHost;
  pairingHost = {
    ...base, beginUri: 'https://platform.example.invalid/device/begin', pollUri: 'https://platform.example.invalid/device/poll',
    verificationUri: 'https://platform.example.invalid/device', clientDisplayName: 'Synthetic revocation race device',
  };
  pairing = await createDeviceAuthorizations(app, { host: pairingHost, signingKey: issuer.privateKey });
  sessions = await createBootstrapSessions(app, { host: sessionHost, signingKey: issuer.privateKey });
});
const server = createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  if (req.headers.authorization !== 'Bearer synthetic-not-a-provider-key') { res.statusCode = 401; res.end('{}'); return; }
  if (req.method === 'GET') { res.end(JSON.stringify({ id: 'synthetic-model', object: 'model', created: 0, owned_by: 'synthetic-fixture' })); return; }
  posts += 1;
  if (nextPost !== 'complete') { res.statusCode = 500; res.end('{}'); return; }
  res.end(JSON.stringify({
    id: 'synthetic-response', object: 'response', model: 'synthetic-model', status: 'completed',
    output: [{ id: 'synthetic-message', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'PRIVATE_SYNTHETIC_MODEL_OUTPUT', annotations: [] }] }],
    usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 },
  }));
});
before(async () => {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  host = createLocalFixtureModelStepHost({
    environment: 'local', origin: `http://127.0.0.1:${address.port}`,
    recover: async () => ({ generation: '7', expiresAt: credentialExpires() }),
    resolveCredential: async () => ({ key: new TextEncoder().encode('synthetic-not-a-provider-key'), expiresAt: credentialExpires() }),
  });
  steps = createModelStepService(app, { ...options, host });
});
after(async () => {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  await app.end();
  await owner.end();
  try { if (created) await admin.query(`DROP SCHEMA ${schema} CASCADE; DROP ROLE ${runtime},${migrator}`); }
  finally { await admin.end(); }
});
beforeEach(async () => {
  posts = 0;
  nextPost = 'refuse';
  await owner.query('TRUNCATE communities CASCADE');
  await owner.query("INSERT INTO communities VALUES($1,'Synthetic revocation')", [community]);
});

const problem = (status: number, code?: string) => (error: unknown) =>
  error instanceof Problem && error.status === status && (code === undefined || error.code === code);
const fault = (code: string) => (error: unknown) => error instanceof AdapterFault && error.code === code;
async function dbNow() {
  return Number((await owner.query(`SELECT floor(extract(epoch FROM clock_timestamp())*1000)::text ms`)).rows[0].ms);
}
async function blockedBy(holder: PoolClient) {
  const pid = (await holder.query('SELECT pg_backend_pid() pid')).rows[0].pid;
  for (let i = 0; i < 300; i += 1) {
    if ((await admin.query('SELECT count(*)::int n FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))', [pid])).rows[0].n) return;
    await delay(10);
  }
  assert.fail('Actual PostgreSQL lock wait not observed');
}
async function member() {
  const user = randomUUID();
  const session = randomUUID();
  const row = (await owner.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref)
    VALUES($1,$2,$3,'Synthetic owner','not-a-login',$4) RETURNING *`, [user, community, `${user}@example.invalid`, randomUUID()])).rows[0];
  await owner.query("INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at) VALUES($1,$2,'synthetic',clock_timestamp()+interval '1 hour')", [session, user]);
  const actor: Actor = { ...row, session_hash: session, csrf_token: 'synthetic' };
  const context = await withMemberScope(app, { actor, scope: 'personal' }, async () => {}, async (_q, value) => value);
  await owner.query(`INSERT INTO private_work_persistence_policy(scope_id,purpose,owner_principal_id,revision,persistence_allowed,retained_byte_limit)
    VALUES($1,'work.private-draft',$2,1,true,10485760)`, [context.scope.scope_id, context.subject_principal.principal_id]);
  return { actor, context };
}
async function fixture() {
  const person = await member();
  const pair = await generateKeyPair('ES256', { extractable: true });
  const challenge = await enrollment.begin(person.actor, { key: randomUUID(), publicJwk: parseRuntimePublicJwk(await exportJWK(pair.publicKey)) });
  const proof = await new CompactSign(new TextEncoder().encode(challenge.payload))
    .setProtectedHeader({ alg: 'ES256', typ: 'freedom-runtime-enrollment+jws' }).sign(pair.privateKey);
  const device = await enrollment.confirm(person.actor, { key: randomUUID(), challengeId: challenge.challenge_id, proof });
  const connection = await connections.create(person.actor, { key: randomUUID(), runtimeDeviceId: device.runtimeDeviceId });
  const family = await transaction(app, q => insertInitialRefreshFamily(q, connection.connectionId, new Date(connection.issuedAt), new Date(connection.expiresAt)));
  const work = await works.create(person.actor, { key: randomUUID(), title: 'Synthetic private goal', objective: 'PRIVATE_BODY_NOT_IN_REVOCATION' });
  const run = await runs.create(person.actor, { key: randomUUID(), workId: work.workId, expectedWorkVersion: '1' });
  const model = await api.models.create(person.actor, { key: randomUUID(), connectionId: connection.connectionId, expectedConnectionVersion: '1', selection });
  const grantInput: CreateExecutionGrantInput = {
    key: randomUUID(), runId: run.runId, expectedRunVersion: '1', expectedWorkVersion: '1',
    connectionId: connection.connectionId, expectedConnectionVersion: '1', modelConnectionId: model.modelConnectionId, expectedModelVersion: '1', consent: true,
  };
  return { ...person, device, connection, family, work, run, model, grantInput };
}
async function approved() {
  const base = await fixture();
  const grant = await api.grants.create(base.actor, base.grantInput);
  await owner.query(`INSERT INTO model_inference_export_policy(policy_id,scope_id,owner_principal_id,environment,client_id,selection,revision,export_allowed,max_prompt_bytes,max_output_tokens)
    VALUES($1,$2,$3,$4,$5,$6,1,true,16384,20)`, [randomUUID(), base.context.scope.scope_id, base.context.subject_principal.principal_id, options.environment, options.clientId, JSON.stringify(selection)]);
  const approval = await steps.approvals.create(base.actor, {
    key: randomUUID(), runId: base.run.runId, grantId: grant.grantId, expectedRunVersion: '1', expectedGrantVersion: '1',
    expectedWorkVersion: '1', consent: true, maxOutputTokens: 20,
  });
  return { ...base, grant, approval };
}
interface Durability {
  stepState: string; stepVersion: string; reservation: boolean; usage: string;
  runState: string; runVersion: string; task: string; control: string;
}
async function durability(runId: string): Promise<Durability> {
  const step = (await owner.query(`SELECT state, aggregate_version::text version, reservation_held, usage_status
    FROM model_text_steps WHERE run_id=$1`, [runId])).rows[0];
  const run = (await owner.query(`SELECT state, aggregate_version::text version, task_lease_epoch::text task, control_epoch::text control
    FROM execution_runs WHERE run_id=$1`, [runId])).rows[0];
  return {
    stepState: step.state, stepVersion: step.version, reservation: step.reservation_held, usage: step.usage_status,
    runState: run.state, runVersion: run.version, task: run.task, control: run.control,
  };
}
async function stepJournals(stepId: string) {
  return (await owner.query(`SELECT count(*)::int n FROM scoped_transition_journal
    WHERE aggregate_type='model_text_step' AND aggregate_id=$1`, [stepId])).rows[0].n as number;
}
async function dispatched() {
  const base = await approved();
  const step = await steps.activate(base.actor, { key: randomUUID(), approvalId: base.approval.approvalId, expectedApprovalVersion: '1', expectedRunVersion: '1' });
  const beginKey = randomUUID();
  const begun = await steps.begin(base.actor, { key: beginKey, stepId: step.stepId, expectedVersion: '1' });
  assert.ok(begun.capability);
  const bytes = await steps.context(base.actor, begun.capability);
  const atDispatch = await durability(base.run.runId);
  assert.equal(atDispatch.stepState, 'dispatched');
  assert.equal(atDispatch.runState, 'running');
  assert.equal(atDispatch.reservation, true);
  assert.equal(atDispatch.usage, 'unknown');
  const replay = await steps.begin(base.actor, { key: beginKey, stepId: step.stepId, expectedVersion: '1' });
  assert.equal(replay.capability, null);
  assert.deepEqual(replay.metadata, begun.metadata);
  // The original key replays the stored receipt. A different key must name the
  // current step version; the pre-begin version is only a CAS conflict and never
  // reaches the one-use dispatch check.
  await assert.rejects(steps.begin(base.actor, { key: randomUUID(), stepId: step.stepId, expectedVersion: atDispatch.stepVersion }), problem(409, 'model_step_already_consumed'));
  assert.equal(posts, 0);
  const before = await durability(base.run.runId);
  assert.deepEqual(before, atDispatch);
  return { ...base, step, beginKey, capability: begun.capability, bytes, before, journals: await stepJournals(step.stepId) };
}
type Dispatched = Awaited<ReturnType<typeof dispatched>>;
type DispatchEvidence = Pick<Dispatched, 'actor' | 'run' | 'step' | 'beginKey' | 'capability' | 'bytes' | 'before' | 'journals'>;
async function assertNoNewDispatch(row: DispatchEvidence, unchanged: Durability) {
  await assert.rejects(steps.begin(row.actor, { key: row.beginKey, stepId: row.step.stepId, expectedVersion: '1' }), problem(409, 'model_step_binding_stale'));
  await assert.rejects(steps.begin(row.actor, { key: randomUUID(), stepId: row.step.stepId, expectedVersion: row.before.stepVersion }), problem(409, 'model_step_binding_stale'));
  await assert.rejects(host.dispatch(row.capability, row.bytes), fault('execution_authority_unavailable'));
  await assert.rejects(steps.record(row.actor, row.capability, {} as never));
  const runner = createModelStepRunner({
    service: steps, host, resultFinalizer: { async finalize() { throw new Error('must not finalize'); } },
  });
  await assert.rejects(runner.execute(row.actor, { key: row.beginKey, stepId: row.step.stepId, expectedVersion: '1' }), problem(409, 'model_step_binding_stale'));
  assert.equal(posts, 0);
  assert.deepEqual(await durability(row.run.runId), unchanged);
  assert.equal(await stepJournals(row.step.stepId), row.journals);
}
async function assertOwnerStop(row: DispatchEvidence) {
  const current = await durability(row.run.runId);
  const stopped = await steps.control(row.actor, { key: randomUUID(), stepId: row.step.stepId, expectedVersion: current.stepVersion, action: 'stop' });
  assert.equal(stopped.state, 'outcome_unknown');
  assert.equal(stopped.operational_authority, false);
  const later = await durability(row.run.runId);
  assert.equal(later.stepState, 'outcome_unknown');
  assert.equal(later.reservation, true);
  assert.equal(later.usage, 'unknown');
  assert.equal(later.runState, 'reconciling');
  assert.equal(BigInt(later.stepVersion), BigInt(current.stepVersion) + 1n);
  assert.equal(BigInt(later.runVersion), BigInt(current.runVersion) + 1n);
  assert.equal(BigInt(later.task), BigInt(current.task) + 1n);
  assert.equal(BigInt(later.control), BigInt(current.control) + 1n);
  assert.equal(posts, 0);
  await assert.rejects(steps.begin(row.actor, { key: row.beginKey, stepId: row.step.stepId, expectedVersion: '1' }), problem(409));
  await assert.rejects(host.dispatch(row.capability, row.bytes), fault('execution_authority_unavailable'));
  assert.equal(posts, 0);
}
async function withdraw(kind: 'grant' | 'model' | 'connection' | 'approval' | 'runtime', row: Dispatched) {
  if (kind === 'grant') {
    const revoked = await api.grants.revoke(row.actor, { key: randomUUID(), grantId: row.grant.grantId, expectedVersion: '1' });
    assert.equal(revoked.state, 'revoked');
  } else if (kind === 'model') {
    const revoked = await api.models.revoke(row.actor, { key: randomUUID(), modelConnectionId: row.model.modelConnectionId, expectedVersion: '1' });
    assert.equal(revoked.state, 'revoked');
  } else if (kind === 'connection') {
    const revoked = await connections.revoke(row.actor, { key: randomUUID(), connectionId: row.connection.connectionId, expectedVersion: '1' });
    assert.equal(revoked.state, 'revoked');
  } else if (kind === 'approval') {
    const revoked = await steps.approvals.revoke(row.actor, { key: randomUUID(), approvalId: row.approval.approvalId, expectedVersion: '1' });
    assert.equal(revoked.state, 'revoked');
  } else {
    const revoked = await enrollment.revoke(row.actor, { key: randomUUID(), runtimeDeviceId: row.device.runtimeDeviceId, expectedVersion: '1' });
    assert.equal(revoked.state, 'revoked');
  }
}

for (const kind of ['grant', 'model', 'connection', 'approval', 'runtime'] as const) {
  test(`withdrawing ${kind} after a consumed dispatch rejects receipt replay and any new dispatch`, async () => {
    const row = await dispatched();
    await withdraw(kind, row);
    const after = await durability(row.run.runId);
    assert.deepEqual(after, row.before);
    await assertNoNewDispatch(row, after);
    await assertOwnerStop(row);
  });
}

test('refresh reuse after a consumed dispatch revokes the family and reconciles without a provider POST', async () => {
  const person = await member();
  const device = await generateKeyPair('ES256');
  const publicJwk = parseRuntimePublicJwk(await exportJWK(device.publicKey));
  const sign = (typ: string, claims: Record<string, unknown>) => new CompactSign(new TextEncoder().encode(JSON.stringify(claims)))
    .setProtectedHeader({ alg: 'ES256', typ, jwk: publicJwk }).sign(device.privateKey);
  const claims = { client_id: options.clientId, environment: 'local', runtime_kind: 'agent-kit', scope: 'bootstrap.status.read', htm: 'POST' };
  const started = await pairing.begin({
    publicJwk, runtimeKind: 'agent-kit', proof: await sign('freedom-device-pairing+jwt', {
      ...claims, purpose: 'device_pairing_begin', jti: randomUUID(), iat: Math.floor(await dbNow() / 1000), htu: pairingHost.beginUri,
    }),
  });
  await pairing.decide(person.actor, {
    key: randomUUID(), userCode: started.userCode, authorizationId: started.authorizationId, requestDigest: started.requestDigest, decision: 'approve',
  });
  const enrollmentRow = (await owner.query(`SELECT c.* FROM runtime_registration_challenges c JOIN device_authorizations a USING(challenge_id)
    WHERE a.authorization_id=$1`, [started.authorizationId])).rows[0];
  const challenge = createRuntimeRegistrationChallenge({
    challenge_id: enrollmentRow.challenge_id, runtime_device_id: enrollmentRow.runtime_device_id,
    owner_member_id: enrollmentRow.owner_user_id, owner_principal_id: enrollmentRow.owner_principal_id, scope_id: enrollmentRow.scope_id,
    environment: enrollmentRow.environment, key_thumbprint: enrollmentRow.key_thumbprint, nonce: enrollmentRow.nonce,
    issued_at: enrollmentRow.issued_at.toISOString(), expires_at: enrollmentRow.expires_at.toISOString(),
  });
  const wire = (value: string) => createHash('sha256').update(value, 'ascii').digest('base64url');
  const initial = await pairing.poll({
    authorizationId: started.authorizationId, deviceCode: started.deviceCode,
    enrollmentProof: await new CompactSign(new TextEncoder().encode(challenge.payload)).setProtectedHeader({ alg: 'ES256', typ: 'freedom-runtime-enrollment+jws' }).sign(device.privateKey),
    proof: await sign('freedom-device-pairing+jwt', {
      ...claims, purpose: 'device_pairing_poll', jti: randomUUID(), iat: Math.floor(await dbNow() / 1000), htu: pairingHost.pollUri,
      authorization_id: started.authorizationId, request_digest: started.requestDigest, nonce: started.nonce, device_code_hash: wire(started.deviceCode),
    }),
  });
  assert.equal(initial.status, 'issued');
  if (initial.status !== 'issued') throw new Error('Device exchange did not issue a refresh family');
  const work = await works.create(person.actor, { key: randomUUID(), title: 'Synthetic private goal', objective: 'PRIVATE_BODY_NOT_IN_REVOCATION' });
  const run = await runs.create(person.actor, { key: randomUUID(), workId: work.workId, expectedWorkVersion: '1' });
  const model = await api.models.create(person.actor, { key: randomUUID(), connectionId: initial.connectionId, expectedConnectionVersion: '1', selection });
  const grant = await api.grants.create(person.actor, {
    key: randomUUID(), runId: run.runId, expectedRunVersion: '1', expectedWorkVersion: '1', connectionId: initial.connectionId,
    expectedConnectionVersion: '1', modelConnectionId: model.modelConnectionId, expectedModelVersion: '1', consent: true,
  });
  await owner.query(`INSERT INTO model_inference_export_policy(policy_id,scope_id,owner_principal_id,environment,client_id,selection,revision,export_allowed,max_prompt_bytes,max_output_tokens)
    VALUES($1,$2,$3,$4,$5,$6,1,true,16384,20)`, [randomUUID(), person.context.scope.scope_id, person.context.subject_principal.principal_id, options.environment, options.clientId, JSON.stringify(selection)]);
  const approval = await steps.approvals.create(person.actor, {
    key: randomUUID(), runId: run.runId, grantId: grant.grantId, expectedRunVersion: '1', expectedGrantVersion: '1', expectedWorkVersion: '1', consent: true, maxOutputTokens: 20,
  });
  const step = await steps.activate(person.actor, { key: randomUUID(), approvalId: approval.approvalId, expectedApprovalVersion: '1', expectedRunVersion: '1' });
  const beginKey = randomUUID();
  const begun = await steps.begin(person.actor, { key: beginKey, stepId: step.stepId, expectedVersion: '1' });
  assert.ok(begun.capability);
  const bytes = await steps.context(person.actor, begun.capability);
  const before = await durability(run.runId);
  const journals = await stepJournals(step.stepId);
  const spent = {
    familyId: initial.refresh.familyId, refreshHandle: initial.refresh.handle,
    proof: await sign('freedom-bootstrap-refresh+jwt', {
      purpose: 'bootstrap_refresh', client_id: options.clientId, environment: 'local', connection_id: initial.connectionId,
      family_id: initial.refresh.familyId, generation: initial.refresh.generation, refresh_handle_hash: wire(initial.refresh.handle),
      jti: randomUUID(), iat: Math.floor(await dbNow() / 1000), htm: 'POST', htu: sessionHost.refreshUri,
    }),
  };
  const replay = await steps.begin(person.actor, { key: beginKey, stepId: step.stepId, expectedVersion: '1' });
  assert.equal(replay.capability, null);
  assert.deepEqual(replay.metadata, begun.metadata);
  const rotated = await sessions.refresh(spent);
  assert.equal(rotated.refresh.generation, '2');
  const replayAfterRotation = await steps.begin(person.actor, { key: beginKey, stepId: step.stepId, expectedVersion: '1' });
  assert.equal(replayAfterRotation.capability, null);
  assert.deepEqual(replayAfterRotation.metadata, begun.metadata);
  assert.deepEqual(await durability(run.runId), before);
  await assert.rejects(sessions.refresh(spent), problem(401, 'bootstrap_invalid'));
  const after = await durability(run.runId);
  assert.deepEqual(after, before);
  assert.equal((await owner.query('SELECT state FROM agent_connections WHERE connection_id=$1', [initial.connectionId])).rows[0].state, 'revoked');
  assert.equal((await owner.query('SELECT state,revocation_reason FROM bootstrap_refresh_families WHERE family_id=$1', [initial.refresh.familyId])).rows[0].revocation_reason, 'refresh_reuse');
  assert.equal(await stepJournals(step.stepId), journals);
  await assert.rejects(sessions.refresh(spent), problem(401, 'bootstrap_invalid'));
  assert.deepEqual(await durability(run.runId), after);
  const row = { ...person, run, step, beginKey, capability: begun.capability, bytes, before, journals };
  await assertNoNewDispatch(row, after);
  await assertOwnerStop(row);
});

test('revoking a grant or connection before dispatch does not cancel the reserved step', async () => {
  for (const kind of ['grant', 'connection'] as const) {
    const row = await approved();
    const step = await steps.activate(row.actor, { key: randomUUID(), approvalId: row.approval.approvalId, expectedApprovalVersion: '1', expectedRunVersion: '1' });
    const before = await durability(row.run.runId);
    assert.equal(before.stepState, 'reserved');
    assert.equal(before.runState, 'running');
    if (kind === 'grant') await api.grants.revoke(row.actor, { key: randomUUID(), grantId: row.grant.grantId, expectedVersion: '1' });
    else await connections.revoke(row.actor, { key: randomUUID(), connectionId: row.connection.connectionId, expectedVersion: '1' });
    assert.deepEqual(await durability(row.run.runId), before);
    const stopped = await steps.control(row.actor, { key: randomUUID(), stepId: step.stepId, expectedVersion: before.stepVersion, action: 'stop' });
    assert.equal(stopped.state, 'cancelled');
    const after = await durability(row.run.runId);
    assert.equal(after.stepState, 'cancelled');
    assert.equal(after.reservation, false);
    assert.equal(after.runState, 'cancelled');
    assert.equal(posts, 0);
  }
});

test('grant revoke after a recorded observation leaves awaiting_result for the owner to cancel', async () => {
  const row = await dispatched();
  nextPost = 'complete';
  const observed = await host.dispatch(row.capability, row.bytes);
  assert.equal(posts, 1);
  const recorded = await steps.record(row.actor, row.capability, observed);
  assert.equal(recorded.state, 'awaiting_result');
  const before = await durability(row.run.runId);
  await api.grants.revoke(row.actor, { key: randomUUID(), grantId: row.grant.grantId, expectedVersion: '1' });
  assert.deepEqual(await durability(row.run.runId), before);
  const stopped = await steps.control(row.actor, { key: randomUUID(), stepId: row.step.stepId, expectedVersion: before.stepVersion, action: 'stop' });
  assert.equal(stopped.state, 'awaiting_result');
  const after = await durability(row.run.runId);
  assert.equal(after.stepState, 'awaiting_result');
  assert.equal(after.reservation, true);
  assert.equal(after.runState, 'cancelled');
  assert.equal(posts, 1);
});

test('pause of a consumed dispatch stays paused and advances both owner fences', async () => {
  const row = await dispatched();
  const paused = await steps.control(row.actor, { key: randomUUID(), stepId: row.step.stepId, expectedVersion: row.before.stepVersion, action: 'pause' });
  assert.equal(paused.state, 'outcome_unknown');
  const after = await durability(row.run.runId);
  assert.equal(after.stepState, 'outcome_unknown');
  assert.equal(after.reservation, true);
  assert.equal(after.runState, 'paused');
  assert.equal(BigInt(after.stepVersion), BigInt(row.before.stepVersion) + 1n);
  assert.equal(BigInt(after.task), BigInt(row.before.task) + 1n);
  assert.equal(BigInt(after.control), BigInt(row.before.control) + 1n);
  assert.equal(posts, 0);
});

test('a disabled personal scope still rejects stop and leaves the consumed dispatch running', async () => {
  const row = await dispatched();
  await owner.query("UPDATE resource_scopes SET status='disabled' WHERE scope_id=$1", [row.context.scope.scope_id]);
  await assert.rejects(steps.control(row.actor, { key: randomUUID(), stepId: row.step.stepId, expectedVersion: row.before.stepVersion, action: 'stop' }), problem(403, 'scope_disabled'));
  assert.deepEqual(await durability(row.run.runId), row.before);
  assert.equal(posts, 0);
});

test('stop waits out an owner-scope lock and still rejects once that scope is disabled', async () => {
  const row = await dispatched();
  const holder = await owner.connect();
  try {
    await holder.query('BEGIN');
    await holder.query('SELECT scope_id FROM resource_scopes WHERE scope_id=$1 FOR UPDATE', [row.context.scope.scope_id]);
    const pending = steps.control(row.actor, { key: randomUUID(), stepId: row.step.stepId, expectedVersion: row.before.stepVersion, action: 'stop' });
    const settled = pending.then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
    await blockedBy(holder);
    await holder.query("UPDATE resource_scopes SET status='disabled' WHERE scope_id=$1", [row.context.scope.scope_id]);
    await holder.query('COMMIT');
    const outcome = await settled;
    assert.equal(outcome.ok, false);
    assert.equal(problem(403, 'scope_disabled')(outcome.ok ? undefined : outcome.error), true);
  } finally {
    await holder.query('ROLLBACK');
    holder.release();
  }
  assert.deepEqual(await durability(row.run.runId), row.before);
  assert.equal((await owner.query('SELECT status FROM resource_scopes WHERE scope_id=$1', [row.context.scope.scope_id])).rows[0].status, 'disabled');
  assert.equal(posts, 0);
});

test('grant revoke waits on the run row, then still admits no new dispatch', async () => {
  const row = await dispatched();
  const holder = await owner.connect();
  try {
    await holder.query('BEGIN');
    await holder.query('SELECT run_id FROM execution_runs WHERE run_id=$1 FOR UPDATE', [row.run.runId]);
    const pending = api.grants.revoke(row.actor, { key: randomUUID(), grantId: row.grant.grantId, expectedVersion: '1' });
    const settled = pending.then(value => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }));
    await blockedBy(holder);
    assert.equal(posts, 0);
    await holder.query('ROLLBACK');
    const outcome = await settled;
    if (!outcome.ok) throw outcome.error;
    assert.equal(outcome.ok, true);
    assert.equal(outcome.value.state, 'revoked');
  } finally {
    await holder.query('ROLLBACK');
    holder.release();
  }
  const after = await durability(row.run.runId);
  assert.deepEqual(after, row.before);
  await assertNoNewDispatch(row, after);
  await assertOwnerStop(row);
});

test('a committed begin stays outcome_unknown when later recovery fails and does not dispatch again', async () => {
  const bytes = new TextEncoder().encode(JSON.stringify({ schema: 'model-step.context/v1', title: 'Synthetic title', objective: 'Synthetic objective.' }));
  const id = randomUUID;
  const binding = ModelStepBindingSchema.parse({
    profile: 'model-step.binding/v1', stepId: id(), attemptId: id(), intentId: id(), approvalId: id(), approvalVersion: '1',
    runId: id(), workId: id(), inputWorkVersion: '1', baseRunVersion: '1', runVersion: '2', baseTaskLeaseEpoch: '1', taskLeaseEpoch: '2', controlEpoch: '1',
    ownerUserId: id(), ownerPrincipalId: id(), scopeId: id(), environment: 'local', clientId: options.clientId,
    runtimeDeviceId: id(), runtimeVersion: '1', connectionId: id(), connectionVersion: '1', familyId: id(), modelConnectionId: id(), modelVersion: '1', selection,
    grantId: id(), grantVersion: '1', persistencePolicyRevision: 'private-work.v1', exportPolicyId: id(), exportPolicyRevision: '1',
    contextSha256: createHash('sha256').update(bytes).digest('hex'), inputByteSize: bytes.byteLength, maxOutputTokens: 8,
  }) as ModelStepBinding;
  const proof = await host.verify(binding);
  const metadata = (stepId: string): ModelStepMetadata => ModelStepMetadataSchema.parse({
    stepId, attemptId: binding.attemptId, attemptNumber: 1, runId: binding.runId, workId: binding.workId, inputWorkVersion: '1',
    approvalId: binding.approvalId, state: 'dispatched', aggregateVersion: '2', activatedRunVersion: '2', taskLeaseEpoch: '2', controlEpoch: '1',
    selection, evidenceOrigin: 'synthetic_local_fixture', expiresAt: credentialExpires(), usageStatus: 'unknown', costStatus: 'unknown', operational_authority: false,
  });
  const actor = {} as Actor;
  const input = { key: 'runner_fault', stepId: binding.stepId, expectedVersion: '1' };
  let unknownCalls = 0;
  let dispatchCalls = 0;
  const failed = createModelStepRunner({
    service: {
      async begin() {
        return { metadata: metadata(binding.stepId), capability: createModelStepCapability(binding, proof, new Date(Date.now() + 4000).toISOString(), async () => {}) };
      },
      async context() { throw new AdapterFault('authentication_unavailable'); },
      async record() { throw new AdapterFault('invalid_response'); },
      async unknown() { unknownCalls += 1; throw new AdapterFault('probe_unavailable'); },
      async read() { return metadata(binding.stepId); },
    },
    host: { verify: host.verify, async dispatch() { dispatchCalls += 1; throw new AdapterFault('invalid_response'); } },
    resultFinalizer: { async finalize() { return { published: false }; } },
  });
  await assert.rejects(failed.execute(actor, input), fault('outcome_unknown'));
  assert.equal(unknownCalls, 1);
  assert.equal(dispatchCalls, 0);
  unknownCalls = 0;
  const reconciled = createModelStepRunner({
    service: {
      async begin() {
        return { metadata: metadata(binding.stepId), capability: createModelStepCapability(binding, proof, new Date(Date.now() + 4000).toISOString(), async () => {}) };
      },
      async context() { throw new AdapterFault('authentication_unavailable'); },
      async record() { throw new AdapterFault('invalid_response'); },
      async unknown() { unknownCalls += 1; return metadata(binding.stepId); },
      async read() { return metadata(binding.stepId); },
    },
    host: { verify: host.verify, async dispatch() { dispatchCalls += 1; throw new AdapterFault('invalid_response'); } },
    resultFinalizer: { async finalize() { return { published: false }; } },
  });
  await assert.rejects(reconciled.execute(actor, { ...input, key: 'runner_unknown' }), fault('outcome_unknown'));
  assert.equal(unknownCalls, 1);
  assert.equal(dispatchCalls, 0);
  assert.equal(posts, 0);
});
