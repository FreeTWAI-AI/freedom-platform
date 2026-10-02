import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import {
  RUNTIME_ENROLLMENT_PROTECTED_HEADER, RUNTIME_ENROLLMENT_TTL_MS,
  type RuntimeRegistrationChallengeBinding,
} from '../../contracts/execution/v1/runtime-registration.js';
import {
  createRuntimeRegistrationChallenge, parseRuntimePublicJwk, RuntimeProofError,
  runtimePublicKeyThumbprint, verifyRuntimeRegistrationProof,
} from '../../modules/agent-control/runtime-proof.js';

// Ephemeral synthetic keys only. Native Node signing is independent of the JOSE
// implementation under test; no private key or submitted proof is persisted.
const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const otherKeys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const jwk = keys.publicKey.export({ format: 'jwk' });
const id = (n: number) => `50000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const b64 = (value: string | Uint8Array) => Buffer.from(value).toString('base64url');
const thumbprint = createHash('sha256').update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y })).digest('base64url');
const binding: RuntimeRegistrationChallengeBinding = {
  challenge_id: id(1), owner_member_id: id(2), owner_principal_id: id(3), scope_id: id(4),
  runtime_device_id: id(5), environment: 'local', key_thumbprint: thumbprint,
  nonce: b64(new Uint8Array(32).fill(7)),
  issued_at: '2026-10-02T12:00:00.000Z', expires_at: '2026-10-02T12:05:00.000Z',
};
const challenge = createRuntimeRegistrationChallenge(binding);
function signed(payload = challenge.payload, header = RUNTIME_ENROLLMENT_PROTECTED_HEADER, key: KeyObject = keys.privateKey) {
  const data = `${b64(header)}.${b64(payload)}`;
  return `${data}.${sign('sha256', Buffer.from(data), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
}
const verify = (proof: unknown, public_jwk: unknown = jwk, expected = challenge) =>
  verifyRuntimeRegistrationProof({ proof, public_jwk, challenge: expected });

test('runtime enrollment accepts real P-256 possession with RFC 7638 thumbprint, without operational authority', async () => {
  assert.equal(await runtimePublicKeyThumbprint(jwk), thumbprint);
  assert.equal(await verify(signed()), true);
  assert.equal(challenge.operational_authority, false);
  assert.equal(JSON.parse(challenge.payload).operational_authority, false);
  assert(Object.isFrozen(challenge));
  assert.equal(Date.parse(challenge.expires_at) - Date.parse(challenge.issued_at), RUNTIME_ENROLLMENT_TTL_MS);
});

test('runtime enrollment crypto result does not decide freshness or consume a challenge', async () => {
  // Trusted DB time and atomic challenge consumption belong to the member service.
  const old = createRuntimeRegistrationChallenge({ ...binding,
    issued_at: '2020-01-01T00:00:00.000Z', expires_at: '2020-01-01T00:05:00.000Z' });
  assert.equal(await verify(signed(old.payload), jwk, old), true);
  assert.equal(await verify(signed(old.payload), jwk, old), true);
});

test('runtime enrollment rejects wrong signer, wrong registered key, and corrupt signature', async () => {
  assert.equal(await verify(signed(challenge.payload, RUNTIME_ENROLLMENT_PROTECTED_HEADER, otherKeys.privateKey)), false);
  assert.equal(await verify(signed(), otherKeys.publicKey.export({ format: 'jwk' })), false);
  const parts = signed().split('.'), signature = Buffer.from(parts[2], 'base64url'); signature[0] ^= 1;
  assert.equal(await verify(`${parts[0]}.${parts[1]}.${b64(signature)}`), false);
});

for (const [field, value] of Object.entries({
  challenge_id: id(90), owner_member_id: id(90), owner_principal_id: id(90), scope_id: id(90),
  runtime_device_id: id(90), environment: 'next', key_thumbprint: b64(new Uint8Array(32).fill(1)),
  nonce: b64(new Uint8Array(32).fill(2)), issued_at: '2026-10-02T11:59:00.000Z',
  expires_at: '2026-10-02T12:06:00.000Z', profile: 'freedom.execution/v1', purpose: 'execution', operational_authority: true,
})) test(`runtime enrollment rejects validly signed substituted ${field}`, async () => {
  const payload = JSON.stringify({ ...JSON.parse(challenge.payload), [field]: value });
  assert.equal(await verify(signed(payload)), false);
});

for (const header of [
  '{"alg":"none","typ":"freedom-runtime-enrollment+jws"}',
  '{"alg":"HS256","typ":"freedom-runtime-enrollment+jws"}',
  '{"alg":"ES384","typ":"freedom-runtime-enrollment+jws"}',
  '{"alg":"ES256","typ":"JWT"}', '{"alg":"ES256","typ":"dpop+jwt"}',
  '{"alg":"ES256","typ":"freedom-runtime-enrollment+jws","jku":"https://invalid.example/key"}',
  '{"alg":"ES256","typ":"freedom-runtime-enrollment+jws","x5u":"https://invalid.example/cert"}',
  '{"alg":"ES256","typ":"freedom-runtime-enrollment+jws","crit":[]}',
  '{"alg":"ES256","typ":"freedom-runtime-enrollment+jws","b64":true}',
  '{"alg":"ES256","typ":"freedom-runtime-enrollment+jws","kid":"self-selected"}',
  '{"alg":"ES256","alg":"ES256","typ":"freedom-runtime-enrollment+jws"}',
  '{"alg":"ES256","\\u0061lg":"ES256","typ":"freedom-runtime-enrollment+jws"}',
  '{"typ":"freedom-runtime-enrollment+jws","alg":"ES256"}',
]) test(`runtime enrollment rejects non-profile protected header ${header}`, async () => {
  assert.equal(await verify(signed(challenge.payload, header)), false);
});

test('runtime enrollment rejects duplicate payload keys, altered whitespace, order, and authority', async () => {
  const parsed = JSON.parse(challenge.payload);
  for (const payload of [
    challenge.payload.replace('{', '{"purpose":"runtime_enrollment",'),
    challenge.payload.replace('{', '{"\\u0070urpose":"runtime_enrollment",'),
    JSON.stringify(parsed, null, 1), ` ${challenge.payload}`,
    JSON.stringify(Object.fromEntries(Object.entries(parsed).reverse())),
    JSON.stringify({ ...parsed, operational_authority: true }),
  ]) assert.equal(await verify(signed(payload)), false);
});

test('runtime enrollment rejects compact framing, padding, and all trailing-bit aliases', async () => {
  const proof = signed(), parts = proof.split('.');
  for (const malformed of ['', `${proof}.`, `${proof}\n`, `${parts[0]}..${parts[2]}`,
    ...parts.map((_, index) => parts.map((part, i) => part + (i === index ? '=' : '')).join('.'))]) {
    assert.equal(await verify(malformed), false);
  }
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const signature = parts[2], last = alphabet.indexOf(signature.at(-1)!);
  for (let offset = 1; offset < 16; offset++) {
    const alias = signature.slice(0, -1) + alphabet[last + offset];
    assert.deepEqual(Buffer.from(alias, 'base64url'), Buffer.from(signature, 'base64url'));
    assert.equal(await verify(`${parts[0]}.${parts[1]}.${alias}`), false);
  }
  assert.equal(await verify(`${parts[0]}.${parts[1]}.${b64(new Uint8Array(65))}`), false);
});

test('runtime enrollment fails shut for oversized/non-string proofs and malformed challenge objects', async () => {
  for (const proof of [undefined, null, {}, new String(signed()), 'a'.repeat(4097), '🔥'.repeat(2048)]) {
    assert.equal(await verify(proof), false);
  }
  assert.equal(await verify(signed(), jwk, { ...challenge, payload: `${challenge.payload} ` }), false);
  assert.equal(await verify(signed(), jwk, { ...challenge, scope_id: id(99) }), false);
  assert.equal(await verify(signed(), jwk, { ...challenge, extra: true } as typeof challenge), false);
});

test('runtime enrollment strict public JWK rejects private keys, extensions, algorithm substitutions and aliases', async () => {
  for (const invalid of [
    keys.privateKey.export({ format: 'jwk' }), { ...jwk, d: 'never-accepted' },
    { ...jwk, kid: 'extra' }, { ...jwk, alg: 'ES256' }, { ...jwk, use: 'sig' },
    { ...jwk, key_ops: ['verify'] }, { ...jwk, ext: true }, { ...jwk, crv: 'P-384' },
    { kty: 'oct', k: 'secret' }, { ...jwk, x: `${jwk.x}=` }, { ...jwk, y: '' },
    { ...jwk, x: 'A'.repeat(42) + 'B' }, JSON.stringify(jwk), null,
  ]) {
    assert.throws(() => parseRuntimePublicJwk(invalid), RuntimeProofError);
    assert.equal(await verify(signed(), invalid), false);
  }
  await assert.rejects(runtimePublicKeyThumbprint({ ...jwk, x: b64(new Uint8Array(32)), y: b64(new Uint8Array(32)) }), RuntimeProofError);
});

test('runtime enrollment object guards do not invoke getters or toJSON and errors contain no submitted material', async () => {
  let invoked = false;
  const getter = { ...jwk, get secret() { invoked = true; return 'sensitive-input'; } };
  const serialization = { ...jwk, toJSON() { invoked = true; return jwk; } };
  for (const value of [getter, serialization]) {
    assert.throws(() => parseRuntimePublicJwk(value), { name: 'RuntimeProofError', message: 'invalid_runtime_enrollment' });
    assert.equal(await verify(signed(), value), false);
  }
  assert.equal(invoked, false);
  const mutable = { ...jwk }, parsed = parseRuntimePublicJwk(mutable);
  assert(Object.isFrozen(parsed)); assert.equal(Object.isFrozen(mutable), false);
});

test('runtime enrollment copies mutable caller bindings and key before asynchronous crypto', async () => {
  const mutableChallenge = { ...challenge }, mutableKey = { ...jwk };
  const input = { proof: signed(), public_jwk: mutableKey, challenge: mutableChallenge };
  const pending = verifyRuntimeRegistrationProof(input);
  input.proof = 'substituted'; mutableChallenge.scope_id = id(99);
  mutableChallenge.payload = 'substituted'; mutableKey.x = 'invalid';
  assert.equal(await pending, true);
});

test('runtime enrollment challenge rejects unknown fields, noncanonical time, wrong TTL, and unknown environment', () => {
  for (const value of [
    { ...binding, ignored: true }, { ...binding, environment: 'production' },
    { ...binding, expires_at: '2026-10-02T12:05:00.001Z' },
    { ...binding, issued_at: '2026-10-02T12:00:00Z' },
    { ...binding, issued_at: '2026-10-02T12:00:00.000+00:00' },
    { ...binding, nonce: 'A'.repeat(42) + 'B' },
  ]) assert.throws(() => createRuntimeRegistrationChallenge(value as RuntimeRegistrationChallengeBinding), RuntimeProofError);
});
