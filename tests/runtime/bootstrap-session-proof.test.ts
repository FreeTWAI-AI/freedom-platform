import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { base64url, CompactSign, exportJWK, generateKeyPair, calculateJwkThumbprint } from 'jose';
import { BootstrapSessionHostSchema, BootstrapRefreshProofResultSchema, BootstrapNonceProofResultSchema,
} from '../../contracts/execution/v1/bootstrap-session.js';
import { createBootstrapSessionProofVerifier, BootstrapSessionProofError } from '../../modules/agent-control/bootstrap-session-proof.js';

const issuer = await generateKeyPair('ES256'), device = await generateKeyPair('ES256'), stranger = await generateKeyPair('ES256');
const issuerJwk = await exportJWK(issuer.publicKey), deviceJwk = await exportJWK(device.publicKey);
const id = (n: number) => `61000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const now = 1800000000, nowMs = now * 1000 + 123;
const hash = (raw: string) => createHash('sha256').update(raw, 'ascii').digest('base64url');
const handleHash = hash(base64url.encode(new Uint8Array(32).fill(9)));
const binding = { ownerUserId: id(1), principalId: id(2), scopeId: id(3), runtimeDeviceId: id(4),
  connectionId: id(5), connectionVersion: '1', keyThumbprint: await calculateJwkThumbprint(deviceJwk) };
const host = BootstrapSessionHostSchema.parse({ environment: 'local', clientId: 'synthetic-client',
  issuer: 'https://issuer.example/', audience: 'https://platform.example/',
  bootstrapUri: 'https://platform.example/execution-api/v1/bootstrap', issuerKid: 'issuer-1',
  refreshUri: 'https://platform.example/refresh', nonceUri: 'https://platform.example/nonce',
  keys: [{ kid: 'issuer-1', purpose: 'bootstrap_access', environment: 'local', publicJwk: issuerJwk,
    notBeforeMs: nowMs - 1000000, notAfterMs: nowMs + 1000000, revoked: false }] });
const refreshHeader = { alg: 'ES256', typ: 'freedom-bootstrap-refresh+jwt', jwk: deviceJwk };
const nonceHeader = { ...refreshHeader, typ: 'freedom-bootstrap-nonce+jwt' };
const accessHeader = { alg: 'ES256', typ: 'freedom-bootstrap+jwt', kid: host.issuerKid };
const accessClaims = { iss: host.issuer, aud: host.audience, sub: binding.principalId, owner_user_id: binding.ownerUserId,
  scope_id: binding.scopeId, runtime_device_id: binding.runtimeDeviceId, connection_id: binding.connectionId,
  connection_version: '1', client_id: host.clientId, environment: host.environment, purpose: 'bootstrap_access',
  scope: 'bootstrap.status.read', cnf: { jkt: binding.keyThumbprint }, iat: now - 10, exp: now + 100, jti: 'access_token_id_0001' };
const refreshClaims = { purpose: 'bootstrap_refresh', client_id: host.clientId, environment: host.environment,
  connection_id: binding.connectionId, family_id: id(6), generation: '1', refresh_handle_hash: handleHash,
  jti: 'refresh_proof_id_0001', iat: now, htm: 'POST', htu: host.refreshUri };
async function sign(payload: unknown, header = refreshHeader, key = device.privateKey) {
  return new CompactSign(new TextEncoder().encode(typeof payload === 'string' ? payload : JSON.stringify(payload)))
    .setProtectedHeader(header).sign(key, { crit: { other: true } });
}
const accessToken = await sign(accessClaims, accessHeader as any, issuer.privateKey);
const nonceClaims = { purpose: 'bootstrap_nonce', client_id: host.clientId, environment: host.environment,
  connection_id: binding.connectionId, jti: 'nonce_proof_id_0001', iat: now, htm: 'POST', htu: host.nonceUri, ath: hash(accessToken) };
const refreshInput = { proof: await sign(refreshClaims), publicJwk: deviceJwk, familyId: id(6), generation: '1',
  connectionId: binding.connectionId, refreshHandleHash: handleHash, nowMs };
const nonceInput = { accessToken, proof: await sign(nonceClaims, nonceHeader), expectedBinding: binding, nowMs };
const verifier = createBootstrapSessionProofVerifier(host);

test('real refresh and nonce signatures return frozen crypto-only evidence; repeated proof is not admission', async () => {
  const refresh = await verifier.verifyRefresh(refreshInput), nonce = await verifier.verifyNonce(nonceInput);
  assert(refresh); assert(nonce); assert.deepEqual(BootstrapRefreshProofResultSchema.parse(refresh), refresh);
  assert.deepEqual(BootstrapNonceProofResultSchema.parse(nonce), nonce);
  assert(Object.isFrozen(refresh)); assert(Object.isFrozen(nonce));
  assert.equal(nonce.tokenId, accessClaims.jti); assert.equal(refresh.operational_authority, false);
  assert.deepEqual(await verifier.verifyRefresh(refreshInput), refresh);
  assert.deepEqual(await verifier.verifyNonce(nonceInput), nonce);
  assert.equal(refresh.validFromMs, (now - 5) * 1000); assert.equal(refresh.validUntilMs, (now + 61) * 1000);
});
for (const [field, value] of Object.entries({ purpose: 'bootstrap_nonce', client_id: 'another', environment: 'next',
  connection_id: id(99), family_id: id(99), generation: '2', refresh_handle_hash: hash('wrong'), jti: 'short',
  iat: now - 61, htm: 'GET', htu: host.nonceUri, extra: true })) {
  test(`refresh rejects signed claim substitution ${field}`, async () => {
    assert.equal(await verifier.verifyRefresh({ ...refreshInput, proof: await sign({ ...refreshClaims, [field]: value }) }), null);
  });
}
for (const [field, value] of Object.entries({ purpose: 'bootstrap_refresh', client_id: 'another', environment: 'next',
  connection_id: id(99), jti: 'short', iat: now + 6, htm: 'GET', htu: host.refreshUri, ath: hash('wrong'), nonce: hash('old') })) {
  test(`nonce rejects signed claim substitution ${field}`, async () => {
    assert.equal(await verifier.verifyNonce({ ...nonceInput, proof: await sign({ ...nonceClaims, [field]: value }, nonceHeader) }), null);
  });
}
for (const [field, value] of Object.entries({ purpose: 'execution', scope: 'work.read', iss: 'https://other.example/',
  aud: [host.audience], sub: id(99), owner_user_id: id(99), scope_id: id(99), runtime_device_id: id(99),
  connection_id: id(99), connection_version: '2', client_id: 'another', environment: 'next', cnf: { jkt: hash('wrong') },
  iat: now + 1, exp: now, extra: true })) {
  test(`nonce shares strict access-token semantics for ${field}`, async () => {
    const token = await sign({ ...accessClaims, [field]: value }, accessHeader as any, issuer.privateKey);
    assert.equal(await verifier.verifyNonce({ ...nonceInput, accessToken: token,
      proof: await sign({ ...nonceClaims, ath: hash(token) }, nonceHeader) }), null);
  });
}
test('strict host rejects aliases, colliding endpoints and unknown issuer descriptor without fetching keys', () => {
  for (const field of ['refreshUri', 'nonceUri'] as const) {
    for (const value of ['http://platform.example/x', 'https://u@platform.example/x', 'https://platform.example/x?',
      'https://platform.example/x#', 'https://platform.example/%78', 'https://platform.example/雪',
      'https://PLATFORM.example/x', 'https://platform.example/x/../y', host.bootstrapUri]) {
      assert.throws(() => createBootstrapSessionProofVerifier({ ...host, [field]: value }), BootstrapSessionProofError);
    }
  }
  assert.throws(() => createBootstrapSessionProofVerifier({ ...host, nonceUri: host.refreshUri }), BootstrapSessionProofError);
  assert.throws(() => createBootstrapSessionProofVerifier({ ...host, issuerKid: 'unknown' }), BootstrapSessionProofError);
});
test('exact proof millisecond boundaries and nonce token/key intersections', async () => {
  for (const nowMs of [(now - 5) * 1000, (now + 61) * 1000 - 1]) assert(await verifier.verifyRefresh({ ...refreshInput, nowMs }));
  for (const nowMs of [(now - 5) * 1000 - 1, (now + 61) * 1000]) assert.equal(await verifier.verifyRefresh({ ...refreshInput, nowMs }), null);
  for (const iat of [now - 60, now + 5]) assert(await verifier.verifyNonce({ ...nonceInput, proof: await sign({ ...nonceClaims, iat }, nonceHeader) }));
  const token = await sign({ ...accessClaims, exp: now + 1 }, accessHeader as any, issuer.privateKey);
  const input = { ...nonceInput, accessToken: token, proof: await sign({ ...nonceClaims, ath: hash(token) }, nonceHeader) };
  assert.equal((await verifier.verifyNonce(input))?.validUntilMs, (now + 1) * 1000);
  assert.equal(await verifier.verifyNonce({ ...input, nowMs: (now + 1) * 1000 }), null);
  const huge = Number.MAX_SAFE_INTEGER;
  assert.equal(await verifier.verifyRefresh({ ...refreshInput, nowMs: huge,
    proof: await sign({ ...refreshClaims, iat: Math.floor(huge / 1000) }) }), null);
});
test('wrong signers, key substitution, private material and purpose cross-use fail closed', async () => {
  for (const [input, verify, claims, header] of [[refreshInput, verifier.verifyRefresh, refreshClaims, refreshHeader],
    [nonceInput, verifier.verifyNonce, nonceClaims, nonceHeader]] as const) {
    assert.equal(await verify({ ...input, proof: await sign(claims, header, stranger.privateKey) }), null);
    for (const changes of [{ typ: 'dpop+jwt' }, { jwk: { ...deviceJwk, d: hash('private') } },
      { jwk: { ...deviceJwk, x: hash('invalid curve') } }, { crit: ['other'], other: true }, { jku: 'https://evil.example/' }]) {
      assert.equal(await verify({ ...input, proof: await sign(claims, { ...header, ...changes } as any) }), null);
    }
  }
  assert.equal(await verifier.verifyRefresh({ ...refreshInput, proof: nonceInput.proof }), null);
  assert.equal(await verifier.verifyNonce({ ...nonceInput, proof: refreshInput.proof }), null);
});
test('strict duplicate JSON, numeric lexemes, unknown fields and compact framing apply to both profiles', async () => {
  for (const [input, verify, claims, header] of [[refreshInput, verifier.verifyRefresh, refreshClaims, refreshHeader],
    [nonceInput, verifier.verifyNonce, nonceClaims, nonceHeader]] as const) {
    const raw = JSON.stringify(claims);
    for (const text of [raw.replace('"iat":', '"iat":1,"iat":'), raw.replace(String(now), `${now}.0`),
      raw.replace(String(now), '18e8'), raw.replace('"iat":', '"__proto__":{},"iat":')]) {
      assert.equal(await verify({ ...input, proof: await sign(text, header) }), null);
    }
    for (const proof of [input.proof + '=', input.proof.replace('.', '=.'), input.proof.split('.').slice(0, 2).join('.'), 'x'.repeat(8193)]) {
      assert.equal(await verify({ ...input, proof }), null);
    }
    assert.equal(await verify({ ...input, unknown: true }), null);
  }
});
test('host and input mutation across awaits cannot alter snapshots; getters and toJSON never execute', async () => {
  const mutableHost = structuredClone(host), v = createBootstrapSessionProofVerifier(mutableHost);
  mutableHost.clientId = 'changed'; mutableHost.keys[0].revoked = true;
  const refresh = structuredClone(refreshInput), refreshPromise = v.verifyRefresh(refresh);
  refresh.familyId = id(99); refresh.publicJwk.x = hash('changed'); assert(await refreshPromise);
  const nonce = structuredClone(nonceInput), noncePromise = v.verifyNonce(nonce);
  nonce.expectedBinding.connectionId = id(99); nonce.accessToken = 'changed'; assert(await noncePromise);
  let calls = 0;
  for (const [input, verify] of [[refreshInput, v.verifyRefresh], [nonceInput, v.verifyNonce]] as const) {
    assert.equal(await verify({ ...input, get proof() { calls++; return input.proof; } }), null);
    assert.equal(await verify({ ...input, toJSON() { calls++; return input; } }), null);
  }
  assert.equal(calls, 0);
});
test('high-S equivalent signature is valid evidence; durable replay control must use JTI', async () => {
  const order = BigInt('0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551');
  for (const [input, verify] of [[refreshInput, verifier.verifyRefresh], [nonceInput, verifier.verifyNonce]] as const) {
    const parts = input.proof.split('.'), bytes = base64url.decode(parts[2]);
    const s = BigInt('0x' + Buffer.from(bytes.slice(32)).toString('hex'));
    bytes.set(Buffer.from((order - s).toString(16).padStart(64, '0'), 'hex'), 32);
    parts[2] = base64url.encode(bytes);
    assert.deepEqual(await verify({ ...input, proof: parts.join('.') }), await verify(input));
  }
});
test('nonce rejects untrusted issuer, revoked/out-of-interval keys and overlong token lifetime', async () => {
  for (const changes of [{ revoked: true }, { notBeforeMs: nowMs }, { notAfterMs: nowMs },
    { publicJwk: deviceJwk }, { kid: 'other-key' }]) {
    const config = structuredClone(host);
    Object.assign(config.keys[0], changes);
    if (changes.kid) config.issuerKid = changes.kid;
    assert.equal(await createBootstrapSessionProofVerifier(config).verifyNonce(nonceInput), null);
  }
  for (const key of Object.keys(binding) as (keyof typeof binding)[]) {
    const expectedBinding = { ...binding, [key]: key === 'keyThumbprint' ? hash('wrong') : key === 'connectionVersion' ? '2' : id(99) };
    assert.equal(await verifier.verifyNonce({ ...nonceInput, expectedBinding }), null);
  }
  const token = await sign({ ...accessClaims, iat: now, exp: now + 601 }, accessHeader as any, issuer.privateKey);
  assert.equal(await verifier.verifyNonce({ ...nonceInput, accessToken: token,
    proof: await sign({ ...nonceClaims, ath: hash(token) }, nonceHeader) }), null);
});
test('refresh exact durable binding is mandatory without a token prerequisite', async () => {
  for (const changes of [{ familyId: id(99) }, { connectionId: id(99) }, { generation: '2' },
    { generation: '9223372036854775808' }, { refreshHandleHash: hash('wrong') }, { publicJwk: issuerJwk }, { accessToken }]) {
    assert.equal(await verifier.verifyRefresh({ ...refreshInput, ...changes }), null);
  }
  assert(await verifier.verifyRefresh(refreshInput));
});
