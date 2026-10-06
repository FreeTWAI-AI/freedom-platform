import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { CompactSign, exportJWK, generateKeyPair, base64url } from 'jose';
import { Pool } from 'pg';
import { app, owner, admin, approved, works, api, steps, enrollment, connections, blocking, count } from './machine-text-fixtures.js';
import { FakeObjectStore } from '../../packages/asset-storage/fake-store.js';
import { createMachineModelHttpTransport } from '../../apps/platform-api/src/routes/machine-model-http.js';
import { createMachineModelBrokerClient } from '../../apps/platform-api/src/machine-model-broker-client.js';
import { createMachineModelBrokerAuthorizations } from '../../modules/agent-control/machine-model-broker-authorizations.js';
import { createMachineBrokerBridge, type MachineBrokerBridge } from '../../apps/credential-broker/src/machine-bridge.js';
import { createMachineBrokerModelExecution } from '../../apps/credential-broker/src/machine-execution.js';
import { createBrokerCredentialStore, getCredentialWriteBinding } from '../../apps/credential-broker/src/store.js';
import { createCredentialVault, type CredentialVault } from '../../apps/credential-broker/src/vault.js';
import { createBrokerBridge } from '../../apps/credential-broker/src/bridge.js';
import { createModelBrokerAuthorizations } from '../../modules/agent-control/model-broker-authorizations.js';
import type { BrokerModelExecution } from '../../apps/credential-broker/src/execution.js';
import { parseRuntimePublicJwk } from '../../modules/agent-control/runtime-proof.js';
import { machineTextRequestHash } from '../../modules/agent-control/machine-text-proof.js';
import type { MachineTextHost } from '../../contracts/execution/v3/machine-text-execution.js';
import type { MachineModelBrokerRequest } from '../../contracts/execution/v3/machine-model-broker.js';
import { Problem } from '../../packages/shared/problem.js';

const origin = 'https://machine.example.invalid', route = '/execution-api/v1/model-steps';
const labels = { issuer: 'machine-main', audience: 'machine-broker-request', brokerIdentity: 'machine-broker', responseAudience: 'machine-main-response' };
const recover = async () => ({ generation: '7', expiresAt: new Date(Date.now() + 600_000).toISOString() });
const secret = new TextEncoder().encode('synthetic-not-a-provider-key');
let gets = 0, posts = 0, getWait: Promise<void> | undefined, postWait: Promise<void> | undefined, providerOrigin = '';
const provider = createServer(async (req, res) => {
  try {
    if (req.headers.authorization !== 'Bearer synthetic-not-a-provider-key') { res.statusCode = 401; res.end('{}'); return; }
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'GET') { gets++; await getWait; res.end(JSON.stringify({ id: 'synthetic-model', object: 'model', created: 0, owned_by: 'synthetic-fixture' })); return; }
    posts++; await postWait; const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    assert.equal(JSON.parse(Buffer.concat(chunks).toString()).model, 'synthetic-model');
    res.end(JSON.stringify({ id: 'synthetic-response', object: 'response', model: 'synthetic-model', status: 'completed',
      output: [{ id: 'synthetic-message', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'PRIVATE_SYNTHETIC_MODEL_OUTPUT', annotations: [] }] }],
      usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 } }));
  } catch { res.destroy(); }
});
before(async () => { await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve)); const address = provider.address(); assert(address && typeof address === 'object'); providerOrigin = `http://127.0.0.1:${address.port}`; });
after(async () => { provider.closeAllConnections(); await new Promise<void>((resolve, reject) => provider.close(error => error ? reject(error) : resolve())); });
beforeEach(() => { gets = 0; posts = 0; getWait = undefined; postWait = undefined; });
const until = async (ready: () => boolean) => { for (let i = 0; i < 500; i++) { if (ready()) return; await new Promise(resolve => setTimeout(resolve, 10)); } assert.fail('timed gate was not entered'); };
const problem = (status: number, name: string) => (error: unknown) => error instanceof Problem && error.status === status && error.code === name;
const sqlCode = (name: string) => (error: unknown) => (error as { code?: string }).code === name;
type Keys = { requestKeys: CryptoKeyPair; responseKeys: CryptoKeyPair };
const pair = async (): Promise<Keys> => ({ requestKeys: await generateKeyPair('EdDSA', { extractable: true }), responseKeys: await generateKeyPair('EdDSA', { extractable: true }) });
type Hook = (bridge: MachineBrokerBridge, request: MachineModelBrokerRequest) => Promise<{ response: string }>;
async function install(keys: Keys, options: { hook?: Hook; requestPublic?: CryptoKey; responsePublic?: CryptoKey } = {}) {
  const f = await approved();
  const kek = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const vault: CredentialVault = createCredentialVault({ kek: { current: async () => ({ keyId: 'synthetic-test-kek', key: kek }), readById: async id => id === 'synthetic-test-kek' ? kek : null }, recover });
  const credentials = createBrokerCredentialStore(owner, { environment: 'local', clientId: 'agent-kit', vault, recover });
  const intent = await credentials.prepareCreate(f.actor, { key: randomUUID(), modelConnectionId: f.model.modelConnectionId, expectedModelVersion: '1', consent: true });
  await credentials.commit(f.actor, intent, await vault.seal(getCredentialWriteBinding(intent), secret));
  const authorizations = createMachineModelBrokerAuthorizations(app, { environment: 'local', clientId: 'agent-kit', issuer: labels.issuer, audience: labels.audience, recover });
  const execution = createMachineBrokerModelExecution({ cipherPool: owner, executorPool: app, environment: 'local', clientId: 'agent-kit', vault, recover, store: new FakeObjectStore(), authorizations, fixtureOrigin: providerOrigin });
  const bridge = await createMachineBrokerBridge({ environment: 'local', clientId: 'agent-kit', issuer: labels.issuer, requestAudience: labels.audience, brokerId: labels.brokerIdentity, responseAudience: labels.responseAudience,
    requestKeys: new Map([['machine-request', options.requestPublic ?? keys.requestKeys.publicKey]]), responseSigningKey: keys.responseKeys.privateKey, responseKeyId: 'machine-response', authorizations, execution });
  const broker = await createMachineModelBrokerClient(app, { origin, environment: 'local', clientId: 'agent-kit', ...labels, requestKey: keys.requestKeys.privateKey, requestKid: 'machine-request',
    responseKeys: new Map([['machine-response', options.responsePublic ?? keys.responseKeys.publicKey]]), recover, exchange: request => options.hook ? options.hook(bridge, request) : bridge.handle(request), store: new FakeObjectStore() });
  const issuer = await generateKeyPair('ES256', { extractable: true }), jwk = parseRuntimePublicJwk(await exportJWK(f.pair.publicKey));
  const host: MachineTextHost = { profile: 'freedom.machine-text.host/v1', environment: 'local', clientId: 'agent-kit', origin, issuer: origin + '/issuer', audience: origin + route, issuerKid: 'machine-issuer-key-0001',
    keys: [{ kid: 'machine-issuer-key-0001', purpose: 'machine_text', environment: 'local', publicJwk: parseRuntimePublicJwk(await exportJWK(issuer.publicKey)), notBeforeMs: 0, notAfterMs: Date.now() + 3_600_000, revoked: false }] };
  const transport = await createMachineModelHttpTransport(app, { host, signingKey: issuer.privateKey, store: new FakeObjectStore(), broker, recover, evidenceOrigin: 'synthetic_local_fixture' });
  const sign = (claims: unknown, key = f.pair.privateKey) => new CompactSign(new TextEncoder().encode(JSON.stringify(claims))).setProtectedHeader({ typ: 'dpop+jwt', alg: 'ES256', jwk }).sign(key);
  async function request(name: 'challenge' | 'activate' | 'execute' | 'status', body: unknown, extra: { stepId?: string; token?: string; key?: string } = {}) {
    const path = name === 'challenge' ? route + '/challenge' : name === 'activate' ? route : route + '/' + extra.stepId + (name === 'status' ? '' : '/execute'), method = name === 'status' ? 'GET' : 'POST';
    const key = name === 'challenge' || name === 'status' ? null : extra.key ?? randomUUID(), version = key ? '1' : null, raw = JSON.stringify(body), bytes = new TextEncoder().encode(name === 'status' ? '' : raw);
    const proof = await sign({ purpose: name === 'activate' ? 'machine_text.activate' : name === 'challenge' ? 'machine_text.challenge' : 'machine_text.request', htm: method, htu: origin + path,
      client_id: 'agent-kit', environment: 'local', connection_id: f.connection.connectionId, family_id: f.family.familyId, jti: randomUUID(), iat: Math.floor(Date.now() / 1000), request_sha256: machineTextRequestHash(method, path, bytes, key, version),
      ...(name === 'activate' ? { challenge_id: (body as { challengeId: string }).challengeId, nonce: (body as { nonce: string }).nonce } : {}), ...(extra.token ? { ath: base64url.encode(createHash('sha256').update(extra.token).digest()) } : {}) });
    const response = await transport.fetch(new Request(origin + path, { method, headers: { DPoP: proof, ...(method === 'GET' ? {} : { 'Content-Type': 'application/json' }), ...(key ? { 'Idempotency-Key': key, 'If-Match': '"1"' } : {}), ...(extra.token ? { Authorization: 'DPoP ' + extra.token } : {}) }, ...(method === 'GET' ? {} : { body: raw }) }));
    const text = await response.text(); return { status: response.status, data: JSON.parse(text) as { code?: string; state?: string; challengeId?: string; nonce?: string; metadata?: { stepId: string }; credentials?: { accessToken: string } }, text };
  }
  const challenge = await request('challenge', { connectionId: f.connection.connectionId, familyId: f.family.familyId }); assert.equal(challenge.status, 201, challenge.text);
  const activate = await request('activate', { connectionId: f.connection.connectionId, familyId: f.family.familyId, challengeId: challenge.data.challengeId, nonce: challenge.data.nonce, approvalId: f.approval.approvalId, expectedRunVersion: '1' });
  assert.equal(activate.status, 201, activate.text);
  return { ...f, bridge, vault, keys, request, stepId: activate.data.metadata!.stepId, token: activate.data.credentials!.accessToken };
}
const decode = (compact: string) => JSON.parse(new TextDecoder().decode(base64url.decode(compact.split('.')[1]!)));
const resign = (payload: unknown, key: CryptoKey) => new CompactSign(new TextEncoder().encode(JSON.stringify(payload))).setProtectedHeader({ alg: 'EdDSA', typ: 'freedom-machine-model-broker-assertion+jws', kid: 'machine-request' }).sign(key);
const revoke = (f: Awaited<ReturnType<typeof install>>, kind: 'grant' | 'approval' | 'device' | 'family') => kind === 'grant' ? api.grants.revoke(f.actor, { key: randomUUID(), grantId: f.grant.grantId, expectedVersion: '1' })
  : kind === 'approval' ? steps.approvals.revoke(f.actor, { key: randomUUID(), approvalId: f.approval.approvalId, expectedVersion: '1' })
  : kind === 'device' ? enrollment.revoke(f.actor, { key: randomUUID(), runtimeDeviceId: f.device.runtimeDeviceId, expectedVersion: '1' })
  : connections.revoke(f.actor, { key: randomUUID(), connectionId: f.connection.connectionId, expectedVersion: '1' });
async function captured(keys: Keys) {
  let seen: MachineModelBrokerRequest | undefined;
  const key = randomUUID(), before = posts;
  const world = await install(keys, { hook: async (_bridge, request) => { seen = request; throw new Error('stop before claim'); } });
  const stopped = await world.request('execute', {}, { stepId: world.stepId, token: world.token, key });
  assert.equal(stopped.status, 503, stopped.text); assert.ok(seen); assert.equal(posts, before);
  return { world, seen: seen!, key };
}
const brokerProblem = async (bridge: MachineBrokerBridge, request: MachineModelBrokerRequest) => {
  try { return decode((await bridge.handle(request)).response).outcome as { kind: string; code?: string }; }
  catch (error) { if (error instanceof Problem) return { kind: 'problem', code: error.code }; throw error; }
};

test('MACHINE-BROKER-01 one execute, one provider call, one Result; replay and a new process stay metadata', async () => {
  const keys = await pair(); let seen: MachineModelBrokerRequest | undefined;
  const world = await install(keys, { hook: (bridge, request) => { seen = request; return bridge.handle(request); } });
  const done = await world.request('execute', {}, { stepId: world.stepId, token: world.token });
  assert.equal(done.status, 200, done.text); assert.equal(done.data.state, 'succeeded'); assert.equal(posts, 1); assert.equal(gets, 1); assert.equal(await count('private_model_work_results'), 1);
  const version = (await owner.query<{ version: string }>('SELECT aggregate_version::text version FROM work_items WHERE work_item_id=$1', [world.work.workId])).rows[0]!.version;
  await works.update(world.actor, { key: randomUUID(), workId: world.work.workId, expectedVersion: version, title: 'Owner edit after broker', objective: 'PRIVATE_BODY_STILL_LOCAL' });
  assert.equal((await owner.query('SELECT title FROM work_items WHERE work_item_id=$1', [world.work.workId])).rows[0].title, 'Owner edit after broker');
  const again = await world.request('execute', {}, { stepId: world.stepId, token: world.token });
  assert.equal(again.status, 200, again.text); assert.equal(again.data.state, 'succeeded'); assert.equal(posts, 1);
  const authorizations = createMachineModelBrokerAuthorizations(app, { environment: 'local', clientId: 'agent-kit', issuer: labels.issuer, audience: labels.audience, recover });
  const execution = createMachineBrokerModelExecution({ cipherPool: owner, executorPool: app, environment: 'local', clientId: 'agent-kit', vault: world.vault, recover, store: new FakeObjectStore(), authorizations, fixtureOrigin: providerOrigin });
  const replay = await createMachineBrokerBridge({ environment: 'local', clientId: 'agent-kit', issuer: labels.issuer, requestAudience: labels.audience, brokerId: labels.brokerIdentity, responseAudience: labels.responseAudience,
    requestKeys: new Map([['machine-request', keys.requestKeys.publicKey]]), responseSigningKey: keys.responseKeys.privateKey, responseKeyId: 'machine-response', authorizations, execution });
  const second = decode((await replay.handle(seen!)).response);
  assert.equal(second.outcome.kind, 'metadata'); assert.equal(second.outcome.step.state, 'succeeded'); assert.equal(posts, 1);
  const stored = (await owner.query<{ assertion: string; command: string }>('SELECT assertion::text assertion, command::text command FROM execution_machine_broker_authorizations')).rows[0]!;
  assert.equal(stored.assertion.includes(world.token), false); assert.equal(stored.command.includes(world.token), false); assert.equal(stored.command.includes('synthetic-not-a-provider-key'), false);
  const receipts = (await owner.query<{ text: string }>("SELECT coalesce(string_agg(response::text, ''), '') text FROM scoped_command_receipts")).rows[0]!.text;
  assert.equal(receipts.includes(world.token), false); assert.equal(receipts.includes('synthetic-not-a-provider-key'), false);
});

test('MACHINE-BROKER-02 direct model host is local-only and exactly one of host or broker', async () => {
  const keys = await pair(), issuer = await generateKeyPair('ES256', { extractable: true });
  const publicJwk = parseRuntimePublicJwk(await exportJWK(issuer.publicKey));
  const host = (environment: 'local' | 'staging-next'): MachineTextHost => ({ profile: 'freedom.machine-text.host/v1', environment, clientId: 'agent-kit', origin, issuer: origin + '/issuer', audience: origin + route, issuerKid: 'machine-issuer-key-0001',
    keys: [{ kid: 'machine-issuer-key-0001', purpose: 'machine_text', environment, publicJwk, notBeforeMs: 0, notAfterMs: Date.now() + 3_600_000, revoked: false }] });
  const signingKey = issuer.privateKey, store = new FakeObjectStore();
  await assert.rejects(createMachineModelHttpTransport(app, { host: host('local'), signingKey, store }), /invalid_machine_model_http_configuration/);
  await assert.rejects(createMachineModelHttpTransport(app, { host: host('local'), signingKey, store, modelHost: {} as never, broker: {} as never }), /invalid_machine_model_http_configuration/);
  await assert.rejects(createMachineModelHttpTransport(app, { host: host('staging-next'), signingKey, store, modelHost: {} as never }), /invalid_machine_model_http_configuration/);
  await assert.rejects(createMachineModelBrokerClient(app, { origin, environment: 'local', clientId: 'agent-kit', ...labels, requestKey: keys.requestKeys.privateKey, requestKid: 'machine-request',
    responseKeys: new Map([['machine-response', keys.requestKeys.publicKey]]), recover, exchange: async () => ({ response: '' }), store }), problem(503, 'machine_broker_unavailable'));
  const kek = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const authorizations = createMachineModelBrokerAuthorizations(app, { environment: 'local', clientId: 'agent-kit', issuer: labels.issuer, audience: labels.audience, recover });
  const execution = createMachineBrokerModelExecution({ cipherPool: owner, executorPool: app, environment: 'local', clientId: 'agent-kit', vault: createCredentialVault({ kek: { current: async () => ({ keyId: 'synthetic-test-kek', key: kek }), readById: async () => null }, recover }), recover, store, authorizations });
  await assert.rejects(createMachineBrokerBridge({ environment: 'local', clientId: 'agent-kit', issuer: labels.issuer, requestAudience: labels.audience, brokerId: labels.brokerIdentity, responseAudience: labels.responseAudience,
    requestKeys: new Map([['machine-request', keys.responseKeys.publicKey]]), responseSigningKey: keys.responseKeys.privateKey, responseKeyId: 'machine-response', authorizations, execution }), problem(503, 'machine_broker_unavailable'));
});

test('MACHINE-BROKER-03 wrong request key, wrong response key, and crossed purposes fail closed', async () => {
  const keys = await pair(), other = await pair();
  const wrongRequest = await install(keys, { requestPublic: other.requestKeys.publicKey, hook: (bridge, request) => bridge.handle(request) });
  const denied = await wrongRequest.request('execute', {}, { stepId: wrongRequest.stepId, token: wrongRequest.token });
  assert.equal(denied.status, 403, denied.text); assert.equal(denied.data.code, 'machine_broker_authorization_invalid'); assert.equal(posts, 0);
  const wrongResponse = await install(keys, { responsePublic: other.responseKeys.publicKey, hook: (bridge, request) => bridge.handle(request) });
  const mismatched = await wrongResponse.request('execute', {}, { stepId: wrongResponse.stepId, token: wrongResponse.token });
  assert.equal(mismatched.status, 403, mismatched.text); assert.equal(mismatched.data.code, 'machine_broker_authorization_invalid'); assert.equal(posts, 1);
  assert.equal((await owner.query('SELECT state FROM model_text_steps WHERE step_id=$1', [wrongResponse.stepId])).rows[0].state, 'succeeded');
  const held = await captured(keys);
  const memberAssertion = await new CompactSign(new TextEncoder().encode(JSON.stringify({ profile: 'model-broker.assertion/v1', purpose: 'model-broker.execute' }))).setProtectedHeader({ alg: 'EdDSA', typ: 'freedom-model-broker-assertion+jws', kid: 'machine-request' }).sign(keys.requestKeys.privateKey);
  assert.deepEqual(await brokerProblem(held.world.bridge, { authorizationRef: randomUUID(), nonce: 'a'.repeat(43), assertion: memberAssertion }), { kind: 'problem', code: 'machine_broker_authorization_invalid' });
  const unknownKid = await new CompactSign(new TextEncoder().encode(JSON.stringify(decode(held.seen.assertion)))).setProtectedHeader({ alg: 'EdDSA', typ: 'freedom-machine-model-broker-assertion+jws', kid: 'unknown-request' }).sign(keys.requestKeys.privateKey);
  assert.deepEqual(await brokerProblem(held.world.bridge, { ...held.seen, assertion: unknownKid }), { kind: 'problem', code: 'machine_broker_authorization_invalid' });
  const member = await createBrokerBridge({ environment: 'local', clientId: 'agent-kit', issuer: 'member-main', requestAudience: 'member-broker-request', brokerId: 'member-broker', responseAudience: 'member-main-response',
    requestKeys: new Map([['member-request', keys.requestKeys.publicKey]]), responseSigningKey: keys.responseKeys.privateKey, responseKeyId: 'member-response',
    authorizations: createModelBrokerAuthorizations(app, { environment: 'local', clientId: 'agent-kit', issuer: 'member-main', audience: 'member-broker-request', recover }),
    execution: { async run() { throw new Error('member execution must not run'); } } as BrokerModelExecution });
  await assert.rejects(member.handle(held.seen), problem(403, 'model_broker_authorization_invalid'));
  for (const change of [{ audience: 'other-audience' }, { issuer: 'other-issuer' }, { environment: 'staging-next' }, { clientId: 'other-client' }, { commandDigest: 'ab'.repeat(32) }] as const) {
    const body = { ...decode(held.seen.assertion), ...change };
    assert.deepEqual(await brokerProblem(held.world.bridge, { ...held.seen, nonce: body.nonce, assertion: await resign(body, keys.requestKeys.privateKey) }), { kind: 'problem', code: 'machine_broker_authorization_invalid' });
  }
  const expired = { ...decode(held.seen.assertion), expiresAt: new Date(Date.now() - 1000).toISOString() };
  assert.deepEqual(await brokerProblem(held.world.bridge, { ...held.seen, assertion: await resign(expired, keys.requestKeys.privateKey) }), { kind: 'problem', code: 'machine_broker_authorization_invalid' });
  const [head, middle, tail] = held.seen.assertion.split('.');
  assert.deepEqual(await brokerProblem(held.world.bridge, { ...held.seen, assertion: `${head}.${middle!.slice(0, -1)}${middle!.endsWith('a') ? 'b' : 'a'}.${tail}` }), { kind: 'problem', code: 'machine_broker_authorization_invalid' });
  const renamed = { ...decode(held.seen.assertion), nonce: 'b'.repeat(43) };
  assert.deepEqual(await brokerProblem(held.world.bridge, { ...held.seen, nonce: renamed.nonce, assertion: await resign(renamed, keys.requestKeys.privateKey) }), { kind: 'problem', code: 'machine_broker_authorization_invalid' });
  assert.equal(posts, 1);
});

test('MACHINE-BROKER-04 pin substitution, a second mint, and a second consume fail closed', async () => {
  const keys = await pair(), first = await captured(keys);
  for (const column of ['grant_id', 'runtime_device_id', 'step_id', 'credential_id'])
    await assert.rejects(owner.query(`UPDATE execution_machine_broker_authorizations SET ${column}=$1`, [randomUUID()]), sqlCode('23514'));
  const consumed = await first.world.request('execute', {}, { stepId: first.world.stepId, token: first.world.token });
  assert.equal(consumed.status, 409, consumed.text); assert.equal(consumed.data.code, 'machine_broker_authorization_consumed'); assert.equal(posts, 0);
  const same = await first.world.request('execute', {}, { stepId: first.world.stepId, token: first.world.token, key: first.key });
  assert.equal(same.status, 409, same.text); assert.equal(same.data.code, 'idempotency_conflict');
  const done = await install(keys, { hook: (bridge, request) => bridge.handle(request) });
  assert.equal((await done.request('execute', {}, { stepId: done.stepId, token: done.token })).status, 200);
  await assert.rejects(owner.query(`UPDATE execution_machine_broker_authorizations SET consumed_at=date_trunc('milliseconds', clock_timestamp()) WHERE step_id=$1`, [done.stepId]), sqlCode('23514'));
});

test('MACHINE-BROKER-05 two connections claim once and dispatch once', async () => {
  const keys = await pair(); let seen: MachineModelBrokerRequest | undefined;
  const world = await install(keys, { hook: async (_bridge, request) => { seen = request; throw new Error('hold'); } });
  assert.equal((await world.request('execute', {}, { stepId: world.stepId, token: world.token })).status, 503);
  const [left, right] = await Promise.all([world.bridge.handle(seen!), world.bridge.handle(seen!)]);
  assert.equal(posts, 1); assert.equal([decode(left.response).outcome.kind, decode(right.response).outcome.kind].filter(kind => kind === 'metadata').length, 2);
  assert.equal((await owner.query('SELECT count(*)::int n FROM execution_machine_broker_authorizations WHERE consumed_at IS NOT NULL')).rows[0].n, 1);
});

for (const kind of ['grant', 'approval', 'device', 'family'] as const) {
  test(`MACHINE-BROKER-06 revoke ${kind} after admission and before claim does not dispatch`, async () => {
    const keys = await pair(); let world: Awaited<ReturnType<typeof install>> | undefined;
    world = await install(keys, { hook: async (bridge, request) => {
      const holder = await owner.connect();
      try {
        await holder.query('BEGIN');
        await holder.query('SELECT authorization_id FROM execution_machine_broker_authorizations WHERE authorization_id=$1 FOR UPDATE', [request.authorizationRef]);
        const pending = bridge.handle(request);
        await blocking(holder); await revoke(world!, kind); await holder.query('COMMIT');
        return await pending;
      } finally { await holder.query('ROLLBACK').catch(() => undefined); holder.release(); }
    } });
    const response = await world.request('execute', {}, { stepId: world.stepId, token: world.token });
    assert.equal(response.status, 403, response.text); assert.equal(response.data.code, 'machine_broker_authorization_invalid'); assert.equal(posts, 0); assert.equal(gets, 0);
    const row = (await owner.query<{ state: string; held: boolean; consumed: Date | null }>('SELECT s.state, s.reservation_held held, b.consumed_at consumed FROM model_text_steps s JOIN execution_machine_broker_authorizations b ON b.step_id=s.step_id WHERE s.step_id=$1', [world.stepId])).rows[0]!;
    assert.equal(row.state, 'reserved'); assert.equal(row.held, true); assert.equal(row.consumed, null);
  });
  test(`MACHINE-BROKER-07 revoke ${kind} after claim and before provider send keeps the reservation`, async () => {
    const keys = await pair(); let releaseGet!: () => void; getWait = new Promise<void>(resolve => { releaseGet = resolve; });
    let world: Awaited<ReturnType<typeof install>> | undefined;
    world = await install(keys, { hook: async (bridge, request) => {
      const pending = bridge.handle(request); await until(() => gets >= 1);
      const holder = await owner.connect();
      try {
        await holder.query('BEGIN');
        await holder.query('SELECT authorization_id FROM execution_machine_broker_authorizations WHERE authorization_id=$1 FOR UPDATE', [request.authorizationRef]);
        releaseGet(); await blocking(holder); await revoke(world!, kind); await holder.query('COMMIT');
        return await pending;
      } finally { releaseGet(); await holder.query('ROLLBACK').catch(() => undefined); holder.release(); }
    } });
    const response = await world.request('execute', {}, { stepId: world.stepId, token: world.token });
    assert.equal(posts, 0, response.text);
    const row = (await owner.query<{ state: string; held: boolean }>('SELECT state, reservation_held held FROM model_text_steps WHERE step_id=$1', [world.stepId])).rows[0]!;
    assert.equal(row.state, 'outcome_unknown'); assert.equal(row.held, true);
    assert.ok(response.status === 503 || response.status === 403, response.text);
  });
}

test('MACHINE-BROKER-08 a lost broker response leaves unknown and does not retry or remint', async () => {
  const keys = await pair(); let releasePost!: () => void; postWait = new Promise<void>(resolve => { releasePost = resolve; });
  let pending: Promise<unknown> | undefined;
  const world = await install(keys, { hook: (bridge, request) => { pending = bridge.handle(request); pending.catch(() => undefined); return until(() => posts >= 1).then(() => { throw new Error('lost response'); }); } });
  try {
    const lost = await world.request('execute', {}, { stepId: world.stepId, token: world.token });
    assert.equal(lost.status, 503, lost.text); assert.equal(posts, 1);
    const row = (await owner.query<{ state: string; held: boolean; auths: number }>('SELECT s.state, s.reservation_held held, count(b.*)::int auths FROM model_text_steps s JOIN execution_machine_broker_authorizations b ON b.step_id=s.step_id WHERE s.step_id=$1 GROUP BY s.state, s.reservation_held', [world.stepId])).rows[0]!;
    assert.equal(row.state, 'outcome_unknown'); assert.equal(row.held, true); assert.equal(row.auths, 1);
    const later = await world.request('execute', {}, { stepId: world.stepId, token: world.token });
    assert.equal(later.status, 200, later.text); assert.equal(later.data.state, 'outcome_unknown'); assert.equal(posts, 1);
    assert.equal((await owner.query<{ n: number }>('SELECT count(*)::int n FROM execution_machine_broker_authorizations WHERE step_id=$1', [world.stepId])).rows[0]!.n, 1);
  } finally { releasePost(); await pending?.catch(() => undefined); }
});

test('MACHINE-BROKER-09 runtime cannot read the vault and the cipher role cannot write business rows', async () => {
  const keys = await pair();
  await install(keys, { hook: (bridge, request) => bridge.handle(request) }).then(world => world.request('execute', {}, { stepId: world.stepId, token: world.token }));
  const schema = (await owner.query<{ s: string }>('SELECT current_schema() s')).rows[0]!.s;
  const runtime = (await app.query<{ u: string }>('SELECT current_user u')).rows[0]!.u;
  const brokerRole = `${schema}_broker`, executorRole = `${schema}_executor`;
  await admin.query(`CREATE ROLE ${brokerRole} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
    CREATE ROLE ${executorRole} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
    GRANT USAGE ON SCHEMA ${schema} TO ${brokerRole}, ${executorRole}`);
  const apply = async (file: string, role: string, variable: string) => {
    const source = (await readFile(new URL('../../deploy/cloudflare/sql/' + file, import.meta.url), 'utf8')).replace(/^\\set .*$/mg, '').replaceAll('SCHEMA public', 'SCHEMA ' + schema).replaceAll("n.nspname='public'", "n.nspname='" + schema + "'").replaceAll("'public','CREATE'", "'" + schema + "','CREATE'").replaceAll(':"' + variable + '"', '"' + role + '"').replaceAll(":'" + variable + "'", "'" + role + "'");
    const q = await owner.connect();
    try { const pieces = source.split('\\gexec'); for (let i = 0; i < pieces.length; i++) { const result = await q.query(pieces[i]!); if (i < pieces.length - 1) { const last = Array.isArray(result) ? result[result.length - 1] : result; for (const row of last.rows) await q.query(Object.values(row)[0] as string); } } }
    catch (error) { await q.query('ROLLBACK'); throw error; }
    finally { q.release(); }
  };
  try {
    await apply('40-credential-broker-grants.psql', brokerRole, 'broker');
    await apply('45-model-broker-execution-grants.psql', executorRole, 'executor');
    await apply('20-runtime-grants.psql', runtime, 'runtime');
    const connectionString = process.env.TEST_DATABASE_URL!, roleUrl = (role: string) => { const url = new URL(connectionString); url.username = role; url.password = ''; return url.toString(); };
    const cipher = new Pool({ connectionString: roleUrl(brokerRole), options: `-c search_path=${schema} -c statement_timeout=10000`, max: 1 });
    const executor = new Pool({ connectionString: roleUrl(executorRole), options: `-c search_path=${schema} -c statement_timeout=10000`, max: 1 });
    try {
      assert.equal((await cipher.query('SELECT count(*)::int n FROM broker_credential_vault')).rows[0].n > 0, true);
      await assert.rejects(cipher.query('INSERT INTO model_text_steps DEFAULT VALUES'), sqlCode('42501'));
      await assert.rejects(cipher.query('INSERT INTO execution_machine_broker_authorizations DEFAULT VALUES'), sqlCode('42501'));
      await assert.rejects(executor.query('SELECT envelope FROM broker_credential_vault'), sqlCode('42501'));
      await assert.rejects(executor.query('INSERT INTO execution_machine_broker_authorizations DEFAULT VALUES'), sqlCode('42501'));
      await assert.rejects(app.query('SELECT envelope FROM broker_credential_vault'), sqlCode('42501'));
    } finally { await cipher.end(); await executor.end(); }
  } finally { await admin.query(`DROP OWNED BY ${brokerRole}, ${executorRole}; DROP ROLE IF EXISTS ${brokerRole}, ${executorRole}`); }
});
