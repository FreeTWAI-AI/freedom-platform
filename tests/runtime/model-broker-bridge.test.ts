import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { base64url, CompactSign, compactVerify } from 'jose';
import { createBrokerBridge, type BrokerBridgeOptions } from '../../apps/credential-broker/src/bridge.js';
import { createBrokerBridgeProcessServer } from '../../apps/credential-broker/src/process.js';
import { ModelBrokerResponsePayloadSchema, type ModelBrokerAssertionPayload } from '../../contracts/execution/v2/model-broker-bridge.js';
import { parseBoundedJson } from '../../packages/execution-state/decode.js';

async function fixture() {
  const main = await crypto.subtle.generateKey('Ed25519', false, ['sign', 'verify']);
  const broker = await crypto.subtle.generateKey('Ed25519', false, ['sign', 'verify']);
  let claims = 0, executions = 0;
  const options: BrokerBridgeOptions = { environment: 'local', clientId: 'freedom-platform', issuer: 'main-local',
    requestAudience: 'broker-local', brokerId: 'broker-local', responseAudience: 'main-local',
    requestKeys: new Map([['main-1', main.publicKey]]), responseSigningKey: broker.privateKey, responseKeyId: 'broker-1',
    // These transport tests deliberately stop at SQL authority. The isolated
    // PostgreSQL/process suite exercises actual accepted commands and effects.
    authorizations: { async claim() { claims++; throw new Error('private-sql-exception-sentinel'); } } as unknown as BrokerBridgeOptions['authorizations'],
    execution: { async run() { executions++; throw new Error('execution-must-not-be-reached'); } },
  };
  const bridge = await createBrokerBridge(options);
  const now = Date.now();
  const payload: ModelBrokerAssertionPayload = { profile: 'model-broker.assertion/v1', issuer: 'main-local', audience: 'broker-local',
    purpose: 'model-broker.activate', operation: 'activate', environment: 'local', clientId: 'freedom-platform',
    authorizationRef: randomUUID(), nonce: randomBytes(32).toString('base64url'), commandDigest: 'a'.repeat(64),
    recoveryGeneration: '1', issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + 60_000).toISOString() };
  const sign = (value: unknown = payload, header: Record<string, unknown> = { alg: 'EdDSA', typ: 'freedom-model-broker-assertion+jws', kid: 'main-1' }) =>
    new CompactSign(new TextEncoder().encode(JSON.stringify(value))).setProtectedHeader(header as { alg: string }).sign(main.privateKey);
  const request = async (value: unknown = payload, header?: Record<string, unknown>) =>
    ({ authorizationRef: payload.authorizationRef, nonce: payload.nonce, assertion: await sign(value, header) });
  return { main, broker, options, bridge, payload, sign, request, counts: () => ({ claims, executions }) };
}

test('broker uses actual distinct Ed25519 directions and signs only safe request-bound failure metadata', async () => {
  const f = await fixture();
  const response = await f.bridge.handle(await f.request());
  const verified = await compactVerify(response.response, f.broker.publicKey, { algorithms: ['EdDSA'] });
  const payload = ModelBrokerResponsePayloadSchema.parse(parseBoundedJson(new TextDecoder().decode(verified.payload)));
  assert.deepEqual(verified.protectedHeader, { alg: 'EdDSA', typ: 'freedom-model-broker-response+jws', kid: 'broker-1' });
  assert.equal(payload.purpose, 'model-broker.response');
  assert.equal(payload.issuer, 'broker-local'); assert.equal(payload.audience, 'main-local');
  assert.equal(payload.nonce, f.payload.nonce); assert.equal(payload.authorizationRef, f.payload.authorizationRef);
  assert.equal(payload.commandDigest, f.payload.commandDigest); assert.equal(payload.operational_authority, false);
  assert.equal(Date.parse(payload.expiresAt) - Date.parse(payload.issuedAt), 10_000);
  assert.deepEqual(payload.outcome, { kind: 'problem', code: 'model_broker_unavailable' });
  assert.deepEqual(f.counts(), { claims: 1, executions: 0 });
  assert.ok(!JSON.stringify(payload).includes('private-sql-exception-sentinel'));
  await assert.rejects(compactVerify(response.response, f.main.publicKey));
  await assert.rejects(createBrokerBridge({ ...f.options, responseSigningKey: f.main.privateKey }));
});

test('signed wrong-purpose/direction/environment/ref assertions never reach delegated SQL authority', async () => {
  const f = await fixture();
  for (const change of [{ issuer: 'other' }, { audience: 'other' }, { purpose: 'model-broker.execute' },
    { environment: 'staging-next' }, { clientId: 'other-client' }, { authorizationRef: randomUUID() },
    { nonce: randomBytes(32).toString('base64url') }, { actor: { user_id: randomUUID() } },
    { expiresAt: new Date(Date.now() - 1).toISOString() }, { issuedAt: new Date(Date.now() + 1000).toISOString() },
    { expiresAt: new Date(Date.parse(f.payload.issuedAt) + 60_001).toISOString() }]) {
    await assert.rejects(f.bridge.handle(await f.request({ ...f.payload, ...change })));
  }
  for (const change of [{ kid: 'unknown' }, { jwk: { kty: 'OKP' } }, { typ: 'freedom-model-broker-response+jws' }, { alg: 'none' }]) {
    const header = { alg: 'EdDSA', typ: 'freedom-model-broker-assertion+jws', kid: 'main-1', ...change };
    if (change.alg === 'none') {
      const valid = await f.request(); const parts = valid.assertion.split('.');
      parts[0] = base64url.encode(JSON.stringify(header));
      await assert.rejects(f.bridge.handle({ ...valid, assertion: parts.join('.') }));
    } else await assert.rejects(f.bridge.handle(await f.request(f.payload, header)));
  }
  assert.deepEqual(f.counts(), { claims: 0, executions: 0 });
});

test('tampering, decoded duplicate keys, malformed signature and transport-shaped additions fail before SQL', async () => {
  const f = await fixture(), request = await f.request();
  const parts = request.assertion.split('.');
  parts[1] = base64url.encode(JSON.stringify({ ...f.payload, commandDigest: 'b'.repeat(64) }));
  await assert.rejects(f.bridge.handle({ ...request, assertion: parts.join('.') }));
  const duplicate = JSON.stringify(f.payload).replace('"issuer":"main-local"', '"issuer":"main-local","iss\\u0075er":"main-local"');
  const signedDuplicate = await new CompactSign(new TextEncoder().encode(duplicate))
    .setProtectedHeader({ alg: 'EdDSA', typ: 'freedom-model-broker-assertion+jws', kid: 'main-1' }).sign(f.main.privateKey);
  await assert.rejects(f.bridge.handle({ ...request, assertion: signedDuplicate }));
  await assert.rejects(f.bridge.handle({ ...request, assertion: request.assertion + '=' }));
  await assert.rejects(f.bridge.handle({ ...request, providerUrl: 'https://attacker.invalid' }));
  await assert.rejects(f.bridge.handle({ ...request, observation: { text: 'forged' } }));
  const attacker = await crypto.subtle.generateKey('Ed25519', false, ['sign', 'verify']);
  const forged = await new CompactSign(new TextEncoder().encode(JSON.stringify(f.payload)))
    .setProtectedHeader({ alg: 'EdDSA', typ: 'freedom-model-broker-assertion+jws', kid: 'main-1' }).sign(attacker.privateKey);
  await assert.rejects(f.bridge.handle({ ...request, assertion: forged }));
  assert.deepEqual(f.counts(), { claims: 0, executions: 0 });
});

test('missing ports or keys and non-local process listeners cannot be installed', async () => {
  const f = await fixture();
  await assert.rejects(createBrokerBridge({ ...f.options, requestKeys: new Map() }));
  await assert.rejects(createBrokerBridge({ ...f.options, execution: undefined as unknown as BrokerBridgeOptions['execution'] }));
  await assert.rejects(createBrokerBridge({ ...f.options, responseSigningKey: f.broker.publicKey }));
  assert.throws(() => createBrokerBridgeProcessServer({ origin: 'http://localhost:12345', bridge: f.bridge }));
  assert.throws(() => createBrokerBridgeProcessServer({ origin: 'https://127.0.0.1:12345', bridge: f.bridge }));
});
