import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {test} from 'node:test';
import {createHash, randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {base64url, CompactSign, exportJWK, generateKeyPair} from 'jose';
import type {PoolClient} from 'pg';
import type {MachineTextHost} from '../../contracts/execution/v3/machine-text-execution.js';
import {FakeObjectStore} from '../../packages/asset-storage/fake-store.js';
import {createBootstrapSessions} from '../../modules/agent-control/bootstrap-sessions.js';
import {createMachineTextAuthority} from '../../modules/agent-control/machine-text-authority.js';
import {machineTextRequestHash} from '../../modules/agent-control/machine-text-proof.js';
import {parseRuntimePublicJwk} from '../../modules/agent-control/runtime-proof.js';
import {AdapterFault} from '../../modules/agent-execution/adapters/common.js';
import {createMachineModelPorts, createMachineModelStepService} from '../../modules/agent-execution/machine-model-step.js';
import {createLocalFixtureModelStepHost, readModelStepCapability, type ModelStepHost} from '../../modules/agent-execution/model-step-host.js';
import {createPrivateModelResultServiceWithAuthority} from '../../modules/agent-execution/model-results.js';
import {createModelStepServiceWithAuthority} from '../../modules/agent-execution/model-step-service.js';
import {Problem} from '../../packages/shared/problem.js';
import {activateInput, admin, api, app, approved, connections, count, enrollment, host as providerHost, owner, posts, steps} from './machine-text-fixtures.js';

const problem = (status: number, code?: string) => (error: unknown) => error instanceof Problem && error.status === status && (code === undefined || error.code === code);
async function until(check: () => Promise<boolean>, label: string) {
  for (let i = 0; i < 200; i++) { if (await check()) return; await delay(10); }
  assert.fail(label);
}
async function blockedBy(pid: number) {
  return (await admin.query<{n:number}>('SELECT count(*)::int n FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))', [pid])).rows[0].n > 0;
}
const settle = <T>(pending: Promise<T>) => pending.then(value => ({ok: true as const, value}), (error: unknown) => ({ok: false as const, error}));
interface Durability { stepState: string; reservation: boolean; usage: string; stepVersion: string; runState: string; runVersion: string; task: string; control: string; results: number }
async function durability(stepId: string): Promise<Durability> {
  const row = (await owner.query<{state:string;reservation_held:boolean;usage_status:string;step_version:string;run_state:string;run_version:string;task:string;control:string}>(
    `SELECT s.state,s.reservation_held,s.usage_status,s.aggregate_version::text step_version,r.state run_state,
      r.aggregate_version::text run_version,r.task_lease_epoch::text task,r.control_epoch::text control
      FROM model_text_steps s JOIN execution_runs r ON r.run_id=s.run_id WHERE s.step_id=$1`, [stepId])).rows[0];
  return {stepState: row.state, reservation: row.reservation_held, usage: row.usage_status, stepVersion: row.step_version,
    runState: row.run_state, runVersion: row.run_version, task: row.task, control: row.control, results: await count('private_model_work_results')};
}
async function ready(executionHost: ModelStepHost = providerHost) {
  const f = await approved(), issuer = await generateKeyPair('ES256', {extractable: true});
  const origin = 'https://machine.example.invalid';
  const host: MachineTextHost = {profile: 'freedom.machine-text.host/v1', environment: 'local', clientId: 'agent-kit', origin,
    issuer: origin + '/issuer', audience: origin + '/execution-api/v1/model-steps', issuerKid: 'machine-issuer-key-0001',
    keys: [{kid: 'machine-issuer-key-0001', purpose: 'machine_text', environment: 'local', publicJwk: parseRuntimePublicJwk(await exportJWK(issuer.publicKey)),
      notBeforeMs: Date.now() - 60000, notAfterMs: Date.now() + 3600000, revoked: false}]};
  const authority = createMachineTextAuthority(app, host, issuer.privateKey), jwk = parseRuntimePublicJwk(await exportJWK(f.pair.publicKey));
  const sign = async (claims: Record<string, unknown>) => new CompactSign(new TextEncoder().encode(JSON.stringify(claims)))
    .setProtectedHeader({typ: 'dpop+jwt', alg: 'ES256', jwk}).sign(f.pair.privateKey);
  const proof = async (purpose: 'challenge' | 'activate', hash: string, extra: Record<string, unknown> = {}) => sign({purpose: 'machine_text.' + purpose,
    htm: 'POST', htu: host.audience + (purpose === 'challenge' ? '/challenge' : ''), client_id: 'agent-kit', environment: 'local', connection_id: f.connection.connectionId,
    family_id: f.family.familyId, jti: randomUUID(), iat: Math.floor(Date.now() / 1000), request_sha256: hash, ...extra});
  const requestHash = machineTextRequestHash('POST', '/execution-api/v1/model-steps/challenge', new Uint8Array(), null, null);
  const challengeInput = {connectionId: f.connection.connectionId, familyId: f.family.familyId, requestSha256: requestHash, proof: await proof('challenge', requestHash)};
  const challenge = await authority.challenge(challengeInput), activationHash = machineTextRequestHash('POST', '/execution-api/v1/model-steps', new Uint8Array(), randomUUID(), '1');
  const activationInput = {connectionId: f.connection.connectionId, familyId: f.family.familyId, challengeId: challenge.challengeId, nonce: challenge.nonce,
    requestSha256: activationHash, proof: await proof('activate', activationHash, {challenge_id: challenge.challengeId, nonce: challenge.nonce})};
  const service = createMachineModelStepService(app, {environment: 'local', clientId: 'agent-kit', authority, host: executionHost, store: new FakeObjectStore()});
  const activated = await service.activate(activationInput, activateInput(f)), step = activated.metadata;
  async function access<T extends 'execute' | 'status' | 'evidence' = 'execute'>(operation: T = 'execute' as T, key = randomUUID(), overrides: Record<string, unknown> = {}) {
    const token = operation === 'evidence' ? activated.credentials!.evidenceToken : activated.credentials!.accessToken;
    const path = '/execution-api/v1/model-steps/' + step.stepId + (operation === 'status' ? '' : '/' + operation);
    const method = operation === 'status' ? 'GET' : 'POST', requestSha256 = machineTextRequestHash(method, path, new TextEncoder().encode('{}'), key, '1');
    return {accessToken: token, operation, requestSha256, proof: await sign({purpose: 'machine_text.request', htm: method, htu: origin + path,
      client_id: 'agent-kit', environment: 'local', connection_id: f.connection.connectionId, family_id: f.family.familyId, jti: randomUUID(),
      iat: Math.floor(Date.now() / 1000), ath: base64url.encode(createHash('sha256').update(token).digest()), request_sha256: requestSha256, ...overrides})};
  }
  const machineSteps = () => createModelStepServiceWithAuthority(app, {environment: 'local', clientId: 'agent-kit', host: providerHost}, createMachineModelPorts(authority));
  return {...f, authority, service, step, access, machineSteps};
}
type Ready = Awaited<ReturnType<typeof ready>>;
function syntheticHost(dispatch: ModelStepHost['dispatch']): ModelStepHost {
  return {verify: binding => providerHost.verify(binding), dispatch};
}
async function claim(f: Ready) {
  const machineSteps = f.machineSteps(), executeKey = randomUUID(), proof = await f.access('execute', executeKey);
  const actor = await f.authority.execution(proof);
  const begun = await machineSteps.begin(actor, {key: executeKey, stepId: f.step.stepId, expectedVersion: '1'});
  assert.equal(begun.metadata.state, 'dispatched');
  assert.equal(posts, 0);
  return {machineSteps, executeKey, proof, actor, begun};
}
async function ownerRevoke(kind: 'grant' | 'model' | 'approval' | 'runtime' | 'connection', f: Ready) {
  if (kind === 'grant') return api.grants.revoke(f.actor, {key: randomUUID(), grantId: f.grant.grantId, expectedVersion: '1'});
  if (kind === 'model') return api.models.revoke(f.actor, {key: randomUUID(), modelConnectionId: f.model.modelConnectionId, expectedVersion: '1'});
  if (kind === 'approval') return steps.approvals.revoke(f.actor, {key: randomUUID(), approvalId: f.approval.approvalId, expectedVersion: '1'});
  if (kind === 'runtime') return enrollment.revoke(f.actor, {key: randomUUID(), runtimeDeviceId: f.device.runtimeDeviceId, expectedVersion: '1'});
  return connections.revoke(f.actor, {key: randomUUID(), connectionId: f.connection.connectionId, expectedVersion: '1'});
}
const evidenceBody = (digest: string) => ({profile: 'freedom.machine-dispatch-evidence/v1' as const, outcome: 'outcome_unknown' as const, reason: 'client_lost_response' as const, evidenceSha256: digest});

test('revoke waits on the dispatch claim, then the committed dispatch stays unknown with its budget', async () => {
  const f = await ready(), machineSteps = f.machineSteps(), key = randomUUID(), proof = await f.access('execute', key);
  const actor = await f.authority.execution(proof), base = await durability(f.step.stepId);
  let calls = 0, beginPid = 0; let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const begun = settle(machineSteps.begin(actor, {key, stepId: f.step.stepId, expectedVersion: '1'}, async (q: PoolClient) => {
    calls += 1;
    if (calls === 2) { beginPid = (await q.query<{pid:number}>('SELECT pg_backend_pid() pid')).rows[0].pid; await gate; }
  }));
  await until(async () => beginPid !== 0, 'dispatch claim did not reach its locks');
  const revoked = settle(api.grants.revoke(f.actor, {key: randomUUID(), grantId: f.grant.grantId, expectedVersion: '1'}));
  await until(() => blockedBy(beginPid), 'owner revoke did not wait on the dispatch claim');
  release();
  const began = await begun; if (!began.ok) throw began.error;
  assert.equal(began.value.metadata.state, 'dispatched');
  const done = await revoked; if (!done.ok) throw done.error;
  assert.equal(done.value.state, 'revoked');
  const after = await durability(f.step.stepId);
  assert.equal(after.stepState, 'outcome_unknown'); assert.equal(after.reservation, true); assert.equal(after.usage, 'unknown');
  assert.equal(after.runState, 'reconciling'); assert.equal(after.results, 0); assert.equal(posts, 0);
  assert.equal(BigInt(after.stepVersion), BigInt(base.stepVersion) + 2n);
  assert.equal(BigInt(after.runVersion), BigInt(base.runVersion) + 1n);
  assert.equal(BigInt(after.task), BigInt(base.task) + 1n);
  assert.equal(BigInt(after.control), BigInt(base.control) + 1n);
  assert.equal(await count('execution_machine_authorizations'), 1);
  await assert.rejects(f.service.execute(proof, {key, stepId: f.step.stepId, expectedVersion: '1'}));
  assert.equal(posts, 0);
  assert.equal((await steps.read(f.actor, {stepId: f.step.stepId})).state, 'outcome_unknown');
});

test('revoke that already holds the step lock rejects the later claim and leaves the reserved step', async () => {
  const f = await ready(), machineSteps = f.machineSteps(), before = await durability(f.step.stepId);
  const holder = await owner.connect();
  try {
    await holder.query('BEGIN');
    const holderPid = (await holder.query<{pid:number}>('SELECT pg_backend_pid() pid')).rows[0].pid;
    await holder.query('SELECT step_id FROM model_text_steps WHERE step_id=$1 FOR UPDATE', [f.step.stepId]);
    const revoked = settle(api.grants.revoke(f.actor, {key: randomUUID(), grantId: f.grant.grantId, expectedVersion: '1'}));
    await until(() => blockedBy(holderPid), 'owner revoke did not wait on the held step');
    const revokePid = (await admin.query<{pid:number}>('SELECT pid FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))', [holderPid])).rows[0].pid;
    const key = randomUUID(), proof = await f.access('execute', key);
    const began = settle((async () => {
      const actor = await f.authority.execution(proof);
      return machineSteps.begin(actor, {key, stepId: f.step.stepId, expectedVersion: '1'});
    })());
    await until(() => blockedBy(revokePid), 'dispatch claim did not wait on owner revoke');
    await holder.query('ROLLBACK');
    const done = await revoked; if (!done.ok) throw done.error;
    assert.equal(done.value.state, 'revoked');
    const outcome = await began; assert.equal(outcome.ok, false);
    const after = await durability(f.step.stepId);
    assert.equal(after.stepState, 'reserved'); assert.equal(after.reservation, true); assert.equal(after.runState, 'running');
    assert.equal(after.stepVersion, before.stepVersion); assert.equal(after.task, before.task); assert.equal(after.control, before.control);
    assert.equal(posts, 0); assert.equal(await count('execution_attempts'), 1); assert.equal(await count('execution_machine_authorizations'), 1);
    assert.equal((await steps.read(f.actor, {stepId: f.step.stepId})).state, 'reserved');
    await assert.rejects(f.service.execute(proof, {key, stepId: f.step.stepId, expectedVersion: '1'}));
    assert.equal(posts, 0);
  } finally { await holder.query('ROLLBACK'); holder.release(); }
});

for (const kind of ['grant', 'model', 'approval', 'runtime', 'connection'] as const) {
  test(`owner ${kind} revoke after dispatch converges the machine step and denies the old proof`, async () => {
    const f = await ready(), claimed = await claim(f), before = await durability(f.step.stepId);
    const revoked = await ownerRevoke(kind, f); assert.equal(revoked.state, 'revoked');
    const after = await durability(f.step.stepId);
    assert.equal(after.stepState, 'outcome_unknown'); assert.equal(after.reservation, true); assert.equal(after.usage, 'unknown');
    assert.equal(after.runState, 'reconciling'); assert.equal(after.results, 0); assert.equal(posts, 0);
    assert.equal(BigInt(after.stepVersion), BigInt(before.stepVersion) + 1n);
    assert.equal(BigInt(after.runVersion), BigInt(before.runVersion) + 1n);
    assert.equal(BigInt(after.task), BigInt(before.task) + 1n);
    assert.equal(BigInt(after.control), BigInt(before.control) + 1n);
    assert.equal(await count('execution_machine_authorizations'), 1); assert.equal(await count('execution_attempts'), 1);
    await assert.rejects(f.service.execute(claimed.proof, {key: claimed.executeKey, stepId: f.step.stepId, expectedVersion: '1'}));
    assert.equal(posts, 0);
    assert.equal((await steps.read(f.actor, {stepId: f.step.stepId})).state, 'outcome_unknown');
    const allowsEvidence = kind === 'grant' || kind === 'model' || kind === 'approval';
    if (allowsEvidence) {
      const key = randomUUID(), body = evidenceBody('ab'.repeat(32));
      const accepted = await f.service.evidence(await f.access('evidence', key), f.step.stepId, key, body);
      assert.equal(accepted.evidenceAccepted, true); assert.equal(accepted.operational_authority, false);
      assert.deepEqual(await durability(f.step.stepId), after);
      const replay = await f.service.evidence(await f.access('evidence', key), f.step.stepId, key, body);
      assert.deepEqual(replay, accepted); assert.deepEqual(await durability(f.step.stepId), after);
      const other = randomUUID();
      await assert.rejects(f.service.evidence(await f.access('evidence', other), f.step.stepId, other, evidenceBody('cd'.repeat(32))), problem(409));
      assert.deepEqual(await durability(f.step.stepId), after); assert.equal(posts, 0);
    } else {
      await assert.rejects(f.service.evidence(await f.access('evidence'), f.step.stepId, randomUUID(), evidenceBody('ab'.repeat(32))));
      assert.deepEqual(await durability(f.step.stepId), after); assert.equal(posts, 0);
    }
  });
}

test('refresh reuse revokes the family and converges a dispatched machine step without another provider call', async () => {
  const f = await ready(), claimed = await claim(f), before = await durability(f.step.stepId);
  const issuer = await generateKeyPair('ES256');
  const refreshUri = 'https://platform.example.invalid/execution-api/v1/auth/refresh';
  const nonceUri = 'https://platform.example.invalid/execution-api/v1/auth/nonce';
  const sessions = await createBootstrapSessions(app, {host: {environment: 'local', clientId: 'agent-kit', issuerKid: 'synthetic-issuer',
    issuer: 'https://issuer.example.invalid/', audience: 'https://platform.example.invalid/',
    bootstrapUri: 'https://platform.example.invalid/execution-api/v1/bootstrap', refreshUri, nonceUri,
    keys: [{kid: 'synthetic-issuer', purpose: 'bootstrap_access', environment: 'local', publicJwk: parseRuntimePublicJwk(await exportJWK(issuer.publicKey)),
      notBeforeMs: 0, notAfterMs: Number.MAX_SAFE_INTEGER, revoked: false}]}, signingKey: issuer.privateKey});
  const jwk = parseRuntimePublicJwk(await exportJWK(f.pair.publicKey));
  const wire = (value: string) => createHash('sha256').update(value, 'ascii').digest('base64url');
  const dbSeconds = async () => Number((await owner.query<{n:string}>('SELECT floor(extract(epoch FROM clock_timestamp()))::text n')).rows[0].n);
  const spent = {familyId: f.family.familyId, refreshHandle: f.family.handle, proof: await new CompactSign(new TextEncoder().encode(JSON.stringify({
    purpose: 'bootstrap_refresh', client_id: 'agent-kit', environment: 'local', connection_id: f.connection.connectionId,
    family_id: f.family.familyId, generation: f.family.generation, refresh_handle_hash: wire(f.family.handle),
    jti: randomUUID(), iat: await dbSeconds(), htm: 'POST', htu: refreshUri}))).setProtectedHeader({alg: 'ES256', typ: 'freedom-bootstrap-refresh+jwt', jwk}).sign(f.pair.privateKey)};
  const rotated = await sessions.refresh(spent);
  assert.equal(rotated.refresh.generation, '2');
  assert.deepEqual(await durability(f.step.stepId), before);
  await assert.rejects(sessions.refresh(spent), problem(401, 'bootstrap_invalid'));
  const after = await durability(f.step.stepId);
  assert.equal(after.stepState, 'outcome_unknown'); assert.equal(after.reservation, true); assert.equal(after.usage, 'unknown');
  assert.equal(after.runState, 'reconciling'); assert.equal(after.results, 0); assert.equal(posts, 0);
  assert.equal(BigInt(after.stepVersion), BigInt(before.stepVersion) + 1n);
  assert.equal(BigInt(after.control), BigInt(before.control) + 1n);
  assert.equal((await owner.query('SELECT state,revocation_reason FROM bootstrap_refresh_families WHERE family_id=$1', [f.family.familyId])).rows[0].revocation_reason, 'refresh_reuse');
  assert.equal((await owner.query('SELECT state FROM agent_connections WHERE connection_id=$1', [f.connection.connectionId])).rows[0].state, 'revoked');
  await assert.rejects(f.service.execute(claimed.proof, {key: claimed.executeKey, stepId: f.step.stepId, expectedVersion: '1'}));
  assert.equal(posts, 0);
  assert.equal((await steps.read(f.actor, {stepId: f.step.stepId})).state, 'outcome_unknown');
  await assert.rejects(f.service.evidence(await f.access('evidence'), f.step.stepId, randomUUID(), evidenceBody('ab'.repeat(32))));
  assert.deepEqual(await durability(f.step.stepId), after);
});

test('revoke during an in-flight dispatch leaves the outcome unknown and does not call the provider again', async () => {
  let calls = 0, release!: () => void, entered!: () => void;
  const enteredGate = new Promise<void>(resolve => { entered = resolve; });
  const releaseGate = new Promise<void>(resolve => { release = resolve; });
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.headers.authorization !== 'Bearer synthetic-not-a-provider-key') { res.statusCode = 401; res.end('{}'); return; }
    if (req.method === 'GET') { res.end(JSON.stringify({id: 'synthetic-model', object: 'model', created: 0, owned_by: 'synthetic-fixture'})); return; }
    res.on('error', () => {});
    req.on('data', () => {});
    req.on('end', () => {
      calls += 1; entered();
      void releaseGate.then(() => { if (!res.writableEnded) res.end(JSON.stringify({id: 'synthetic-response', object: 'response', model: 'synthetic-model', status: 'completed',
        output: [{id: 'synthetic-message', type: 'message', role: 'assistant', status: 'completed', content: [{type: 'output_text', text: 'PRIVATE_SYNTHETIC_MODEL_OUTPUT', annotations: []}]}],
        usage: {input_tokens: 3, output_tokens: 4, total_tokens: 7}})); });
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address(); assert(address && typeof address === 'object');
  const expiresAt = () => new Date(Date.now() + 60000).toISOString();
  const executionHost = createLocalFixtureModelStepHost({environment: 'local', origin: `http://127.0.0.1:${address.port}`,
    recover: async () => ({generation: '7', expiresAt: expiresAt()}),
    resolveCredential: async () => ({key: new TextEncoder().encode('synthetic-not-a-provider-key'), expiresAt: expiresAt()})});
  try {
    const f = await ready(executionHost), key = randomUUID(), proof = await f.access('execute', key);
    const pending = settle(f.service.execute(proof, {key, stepId: f.step.stepId, expectedVersion: '1'}));
    await enteredGate;
    assert.equal(calls, 1); assert.equal(posts, 0);
    const revoked = await api.grants.revoke(f.actor, {key: randomUUID(), grantId: f.grant.grantId, expectedVersion: '1'});
    assert.equal(revoked.state, 'revoked');
    const during = await durability(f.step.stepId);
    assert.equal(during.stepState, 'outcome_unknown'); assert.equal(during.reservation, true); assert.equal(during.runState, 'reconciling'); assert.equal(during.results, 0);
    release();
    const done = await pending; assert.equal(done.ok, false); assert.equal(calls, 1);
    assert.deepEqual(await durability(f.step.stepId), during);
    await assert.rejects(f.service.execute(proof, {key, stepId: f.step.stepId, expectedVersion: '1'}));
    assert.equal(calls, 1); assert.equal(posts, 0); assert.equal(await count('execution_machine_authorizations'), 1);
    assert.equal((await steps.read(f.actor, {stepId: f.step.stepId})).state, 'outcome_unknown');
  } finally { release(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});

test('finalize after revoke cannot commit a result and leaves the recorded step awaiting result', async () => {
  const f = await ready(), ports = createMachineModelPorts(f.authority);
  const machineSteps = createModelStepServiceWithAuthority(app, {environment: 'local', clientId: 'agent-kit', host: providerHost}, ports);
  const results = createPrivateModelResultServiceWithAuthority(app, {steps: machineSteps, host: providerHost, store: new FakeObjectStore(), resolvePolicy: ports.persistencePolicy}, ports);
  const key = randomUUID(), proof = await f.access('execute', key), actor = await f.authority.execution(proof);
  const begun = await machineSteps.begin(actor, {key, stepId: f.step.stepId, expectedVersion: '1'});
  assert.ok(begun.capability);
  const bytes = await machineSteps.context(actor, begun.capability), observation = await providerHost.dispatch(begun.capability, bytes);
  const recorded = await machineSteps.record(actor, begun.capability, observation);
  assert.equal(recorded.state, 'awaiting_result'); assert.equal(posts, 1);
  const before = await durability(f.step.stepId);
  assert.equal(before.stepState, 'awaiting_result'); assert.equal(before.reservation, true); assert.equal(before.results, 0);
  await api.grants.revoke(f.actor, {key: randomUUID(), grantId: f.grant.grantId, expectedVersion: '1'});
  assert.deepEqual(await durability(f.step.stepId), before);
  const cap = readModelStepCapability(begun.capability);
  await assert.rejects(results.finalize(actor, {key: cap.binding.intentId, stepId: f.step.stepId, expectedVersion: recorded.aggregateVersion}, observation));
  assert.deepEqual(await durability(f.step.stepId), before); assert.equal(posts, 1);
  await assert.rejects(f.service.execute(proof, {key, stepId: f.step.stepId, expectedVersion: '1'}));
  assert.equal(posts, 1);
  assert.equal((await steps.read(f.actor, {stepId: f.step.stepId})).state, 'awaiting_result');
});

test('an unknown dispatch stays unknown after revoke and is not sent to the provider again', async () => {
  const f = await ready();
  const service = createMachineModelStepService(app, {environment: 'local', clientId: 'agent-kit', authority: f.authority, store: new FakeObjectStore(),
    host: syntheticHost(async (capability, bytes) => { await providerHost.dispatch(capability, bytes); throw new Error('synthetic lost provider response'); })});
  const key = randomUUID(), proof = await f.access('execute', key);
  await assert.rejects(service.execute(proof, {key, stepId: f.step.stepId, expectedVersion: '1'}), (error: unknown) => error instanceof AdapterFault && error.code === 'outcome_unknown');
  assert.equal(posts, 1);
  const before = await durability(f.step.stepId);
  assert.equal(before.stepState, 'outcome_unknown'); assert.equal(before.reservation, true); assert.equal(before.usage, 'unknown');
  assert.equal(before.runState, 'reconciling'); assert.equal(before.results, 0);
  await api.grants.revoke(f.actor, {key: randomUUID(), grantId: f.grant.grantId, expectedVersion: '1'});
  assert.deepEqual(await durability(f.step.stepId), before);
  await assert.rejects(service.execute(proof, {key, stepId: f.step.stepId, expectedVersion: '1'}));
  assert.equal(posts, 1); assert.equal(await count('execution_machine_authorizations'), 1);
  assert.equal((await steps.read(f.actor, {stepId: f.step.stepId})).state, 'outcome_unknown');
});
