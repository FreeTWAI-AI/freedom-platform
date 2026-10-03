import assert from 'node:assert/strict';
import test from 'node:test';
import { KeyObject, sign } from 'node:crypto';
import { base64url, CompactSign, exportJWK, generateKeyPair } from 'jose';
import { DevicePairingProofResultSchema, DeviceAuthorizationPollResultSchema, DeviceUserCodeSchema,
  type DeviceAuthorizationHost } from '../../contracts/execution/v1/device-pairing.js';
import { createDevicePairingProofVerifier, DevicePairingProofError } from '../../modules/agent-control/device-pairing-proof.js';
import { runtimePublicKeyThumbprint } from '../../modules/agent-control/runtime-proof.js';

const device = await generateKeyPair('ES256', { extractable: true });
const other = await generateKeyPair('ES256');
const publicJwk = await exportJWK(device.publicKey) as DeviceAuthorizationHost['keys'][number]['publicJwk'];
const nowMs = 1_800_000_000_123, iat = Math.floor(nowMs / 1000);
const bytes = (n: number) => base64url.encode(new Uint8Array(32).fill(n));
const host: DeviceAuthorizationHost = { environment: 'local', clientId: 'synthetic-client',
  issuer: 'https://issuer.example/', audience: 'https://platform.example/', bootstrapUri: 'https://platform.example/execution-api/v1/bootstrap',
  keys: [{ kid: 'test-issuer', purpose: 'bootstrap_access', environment: 'local', publicJwk,
    notBeforeMs: nowMs - 100000, notAfterMs: nowMs + 1000000, revoked: false }],
  issuerKid: 'test-issuer', beginUri: 'https://platform.example/device/begin', pollUri: 'https://platform.example/device/poll',
  verificationUri: 'https://platform.example/device/verify', clientDisplayName: 'Synthetic client',
};
const header = { alg: 'ES256', typ: 'freedom-device-pairing+jwt', jwk: publicJwk };
const beginClaims = { purpose: 'device_pairing_begin', client_id: host.clientId, environment: host.environment,
  runtime_kind: 'agent-kit', scope: 'bootstrap.status.read', jti: 'synthetic_begin_jti_1', iat, htm: 'POST', htu: host.beginUri };
const expected = { authorizationId: '10000000-0000-4000-8000-000000000001', nonce: bytes(1), deviceCodeHash: bytes(2), requestDigest: bytes(3) };
const pollClaims = { ...beginClaims, purpose: 'device_pairing_poll', htu: host.pollUri,
  authorization_id: expected.authorizationId, nonce: expected.nonce, device_code_hash: expected.deviceCodeHash, request_digest: expected.requestDigest };
const verifier = createDevicePairingProofVerifier(host);
async function proof(claims: unknown, protectedHeader = header, key = device.privateKey) {
  return new CompactSign(new TextEncoder().encode(typeof claims === 'string' ? claims : JSON.stringify(claims)))
    .setProtectedHeader(protectedHeader).sign(key);
}
const begin = { proof: await proof(beginClaims), publicJwk, runtimeKind: 'agent-kit', nowMs };
const poll = { ...begin, ...expected, proof: await proof(pollClaims) };
test('actual new-device begin and exact poll signatures return frozen crypto-only intervals', async () => {
  for (const result of [await verifier.verifyBegin(begin), await verifier.verifyPoll(poll)]) {
    assert(result); assert.deepEqual(DevicePairingProofResultSchema.parse(result), result); assert(Object.isFrozen(result));
    assert.equal(result.keyThumbprint, await runtimePublicKeyThumbprint(publicJwk));
    assert.equal(result.validFromMs, (iat - 5) * 1000); assert.equal(result.validUntilMs, (iat + 61) * 1000);
    assert.equal(result.assurance, 'cryptographic_only'); assert.equal(result.operational_authority, false);
    assert.equal('proof' in result, false);
  }
  assert.deepEqual(await verifier.verifyPoll(poll), await verifier.verifyPoll(poll)); // Deliberately no atomic replay store.
});
for (const [field, value] of Object.entries({ purpose: 'device_pairing_poll', client_id: 'other', environment: 'next',
  runtime_kind: 'neo', scope: 'work.read', jti: 'short', iat: iat - 61, htm: 'GET', htu: host.pollUri,
  owner_user_id: expected.authorizationId })) test(`begin rejects signed ${field} substitution`, async () => {
  assert.equal(await verifier.verifyBegin({ ...begin, proof: await proof({ ...beginClaims, [field]: value }) }), null);
});
for (const [field, value] of Object.entries({ authorization_id: '10000000-0000-4000-8000-000000000002', nonce: bytes(7),
  device_code_hash: bytes(7), request_digest: bytes(7), purpose: 'device_pairing_begin', htu: host.beginUri })) {
  test(`poll rejects signed ${field} substitution`, async () => {
    assert.equal(await verifier.verifyPoll({ ...poll, proof: await proof({ ...pollClaims, [field]: value }) }), null);
  });
}
test('all expected poll bindings are checked against stored values, not caller claims', async () => {
  for (const field of ['nonce', 'deviceCodeHash', 'requestDigest']) assert.equal(await verifier.verifyPoll({ ...poll, [field]: bytes(9) }), null);
  assert.equal(await verifier.verifyPoll({ ...poll, authorizationId: '10000000-0000-4000-8000-000000000002' }), null);
  assert.equal(await verifier.verifyPoll({ ...poll, runtimeKind: 'neo' }), null);
});
test('purpose/type/key and actual signature cannot be replaced', async () => {
  assert.equal(await verifier.verifyBegin({ ...begin, proof: poll.proof }), null);
  assert.equal(await verifier.verifyPoll({ ...poll, proof: begin.proof }), null);
  assert.equal(await verifier.verifyBegin({ ...begin, proof: await proof(beginClaims, header, other.privateKey) }), null);
  assert.equal(await verifier.verifyBegin({ ...begin, publicJwk: await exportJWK(other.publicKey) }), null);
  for (const protectedHeader of [{ ...header, typ: 'dpop+jwt' }, { ...header, jku: 'https://untrusted.invalid/' },
    { ...header, x5u: 'https://untrusted.invalid/' }, { ...header, jwk: { ...publicJwk, d: bytes(1) } }]) {
    assert.equal(await verifier.verifyBegin({ ...begin, proof: await proof(beginClaims, protectedHeader) }), null);
  }
  const parts = begin.proof.split('.'), signature = base64url.decode(parts[2]); signature[0] ^= 1;
  assert.equal(await verifier.verifyBegin({ ...begin, proof: [parts[0], parts[1], base64url.encode(signature)].join('.') }), null);
});
test('invalid curve/private or extra public-key fields fail; high-S equivalent proof is still cryptographic evidence', async () => {
  for (const jwk of [{ ...publicJwk, x: bytes(0), y: bytes(0) }, { ...publicJwk, d: bytes(1) }, { ...publicJwk, key_ops: ['verify'] }]) {
    assert.equal(await verifier.verifyBegin({ ...begin, publicJwk: jwk, proof: await proof(beginClaims, { ...header, jwk }) }), null);
  }
  const parts = poll.proof.split('.'), signature = Buffer.from(base64url.decode(parts[2]));
  const order = BigInt('0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551');
  const alternativeS = (order - BigInt('0x' + signature.subarray(32).toString('hex'))).toString(16).padStart(64, '0');
  signature.set(Buffer.from(alternativeS, 'hex'), 32);
  assert(await verifier.verifyPoll({ ...poll, proof: [parts[0], parts[1], base64url.encode(signature)].join('.') }));
  // Durable replay keys must use proofId, never raw signature bytes.
});
test('exact floor intervals reject one millisecond beyond either boundary and numeric overflow', async () => {
  for (const now of [(iat - 5) * 1000, (iat + 61) * 1000 - 1]) assert(await verifier.verifyBegin({ ...begin, nowMs: now }));
  for (const now of [(iat - 5) * 1000 - 1, (iat + 61) * 1000, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(await verifier.verifyBegin({ ...begin, nowMs: now }), null);
  }
  assert.equal(await verifier.verifyBegin({ ...begin, nowMs: 0, proof: await proof({ ...beginClaims, iat: 0 }) }) === null, false);
  assert.equal(await verifier.verifyBegin({ ...begin, proof: await proof({ ...beginClaims, iat: Number.MAX_SAFE_INTEGER }) }), null);
});
test('strict signed JSON rejects decoded duplicates, fractions, exponent lexemes and excess size', async () => {
  const json = JSON.stringify(beginClaims);
  for (const raw of [json.replace(/^\{/, '{"jti":"first_duplicate",'), json.replace(/^\{/, '{"cl\\u0069ent_id":"other",'),
    json.replace(String(iat), iat + '.0'), json.replace(String(iat), '18e8'), json.replace(String(iat), '-0'),
    json.replace(/^\{/, '{"__proto__":{},'), json.replace(/^\{/, '{"extra":"' + 'x'.repeat(8200) + '",')]) {
    assert.equal(await verifier.verifyBegin({ ...begin, proof: await proof(raw) }), null);
  }
  const rawHeader = JSON.stringify(header).replace(/^\{/, '{"alg":"ES256",');
  const body = base64url.encode(rawHeader) + '.' + base64url.encode(json);
  const signature = sign('sha256', Buffer.from(body), { key: KeyObject.from(device.privateKey), dsaEncoding: 'ieee-p1363' });
  assert.equal(await verifier.verifyBegin({ ...begin, proof: body + '.' + base64url.encode(signature) }), null);
  assert.equal(await verifier.verifyBegin({ ...begin, proof: begin.proof + '=' }), null);
});
test('host and verification inputs are snapshotted before awaits; getters never run', async () => {
  const mutableHost = structuredClone(host), frozenVerifier = createDevicePairingProofVerifier(mutableHost);
  mutableHost.clientId = 'changed'; mutableHost.beginUri = host.pollUri;
  const input = structuredClone(begin), pending = frozenVerifier.verifyBegin(input); input.runtimeKind = 'neo'; input.publicJwk.x = bytes(7);
  assert(await pending);
  let touched = false;
  const evil = Object.defineProperty({ ...begin }, 'proof', { enumerable: true, get() { touched = true; return begin.proof; } });
  assert.equal(await verifier.verifyBegin(evil), null); assert.equal(touched, false);
});
test('constructor rejects endpoint aliases, extra host fields and missing issuer descriptor', () => {
  for (const config of [{ ...host, beginUri: host.pollUri }, { ...host, beginUri: host.beginUri + '?' },
    { ...host, beginUri: 'https://platform.example/device/%62egin' }, { ...host, beginUri: 'http://platform.example/device/begin' },
    { ...host, pollUri: 'https://u:p@platform.example/device/poll' }, { ...host, issuerKid: 'missing' }, { ...host, verifier: true }]) {
    assert.throws(() => createDevicePairingProofVerifier(config), DevicePairingProofError);
  }
});
test('canonical user-code and bounded protocol DTOs reject misleading shapes', () => {
  assert(DeviceUserCodeSchema.safeParse('01234-ABCDE').success);
  for (const code of ['01234-abcde', 'OOOOO-IIIII', 'ABCDEABCDE', 'ABCDE-ABCDE\n']) assert(!DeviceUserCodeSchema.safeParse(code).success);
  for (const interval of [0, 4, 326, Number.MAX_SAFE_INTEGER]) assert(!DeviceAuthorizationPollResultSchema.safeParse({ status: 'slow_down', interval, operational_authority: false }).success);
});
