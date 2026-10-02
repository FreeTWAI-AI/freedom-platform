import assert from 'node:assert/strict';
import test from 'node:test';
import { base64url, CompactSign, decodeJwt, decodeProtectedHeader, exportJWK, generateKeyPair } from 'jose';
import { type BootstrapProofHost } from '../../contracts/execution/v1/bootstrap.js';
import { BootstrapTokenIssueResultSchema } from '../../contracts/execution/v1/device-pairing.js';
import { createBootstrapTokenIssuer, BootstrapIssuerError } from '../../modules/agent-control/bootstrap-issuer.js';
import { createBootstrapProofVerifier } from '../../modules/agent-control/bootstrap-proof.js';
import { runtimePublicKeyThumbprint } from '../../modules/agent-control/runtime-proof.js';

const issuerKey = await generateKeyPair('ES256'), device = await generateKeyPair('ES256'), other = await generateKeyPair('ES256');
const publicJwk = await exportJWK(issuerKey.publicKey) as BootstrapProofHost['keys'][number]['publicJwk'];
const deviceJwk = await exportJWK(device.publicKey);
const id = (n: number) => `70000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const nowMs = 1_800_000_000_123, now = Math.floor(nowMs / 1000);
const host: BootstrapProofHost = { environment: 'local', clientId: 'synthetic-client', issuer: 'https://issuer.example/',
  audience: 'https://platform.example/', bootstrapUri: 'https://platform.example/execution-api/v1/bootstrap',
  keys: [{ kid: 'issuer-1', purpose: 'bootstrap_access', environment: 'local', publicJwk,
    notBeforeMs: nowMs - 1000000, notAfterMs: nowMs + 1000000, revoked: false }] };
const binding = { ownerUserId: id(1), principalId: id(2), scopeId: id(3), runtimeDeviceId: id(4),
  connectionId: id(5), connectionVersion: '1', keyThumbprint: await runtimePublicKeyThumbprint(deviceJwk) };
const configuration = { host, kid: 'issuer-1', signingKey: issuerKey.privateKey };
const issuer = await createBootstrapTokenIssuer(configuration);
const input = { binding, nowMs, notAfterMs: nowMs + 2000000 };
test('nonextractable matching issuer creates exact bootstrap claims accepted by actual verifier', async () => {
  assert.equal(issuerKey.privateKey.extractable, false);
  const issued = await issuer.issue(input); assert(issued); assert.deepEqual(BootstrapTokenIssueResultSchema.parse(issued), issued);
  assert(Object.isFrozen(issued)); assert.equal(issued.expiresAt, now + 600); assert.equal(issued.operational_authority, false);
  assert.deepEqual(decodeProtectedHeader(issued.accessToken), { alg: 'ES256', typ: 'freedom-bootstrap+jwt', kid: 'issuer-1' });
  assert.deepEqual(decodeJwt(issued.accessToken), { iss: host.issuer, aud: host.audience, sub: binding.principalId,
    owner_user_id: binding.ownerUserId, scope_id: binding.scopeId, runtime_device_id: binding.runtimeDeviceId,
    connection_id: binding.connectionId, connection_version: '1', client_id: host.clientId, environment: host.environment,
    purpose: 'bootstrap_access', scope: 'bootstrap.status.read', cnf: { jkt: binding.keyThumbprint }, iat: now, exp: now + 600, jti: issued.tokenId });
  const nonce = base64url.encode(new Uint8Array(32).fill(7));
  const ath = base64url.encode(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(issued.accessToken))));
  const proof = await new CompactSign(new TextEncoder().encode(JSON.stringify({ jti: 'synthetic_dpop_jti_1', htm: 'GET',
    htu: host.bootstrapUri, iat: now, nonce, ath }))).setProtectedHeader({ alg: 'ES256', typ: 'dpop+jwt', jwk: deviceJwk }).sign(device.privateKey);
  assert(await createBootstrapProofVerifier(host).verify({ accessToken: issued.accessToken, proof, expectedNonce: nonce, nowMs, expectedBinding: binding }));
  const second = await issuer.issue(input); assert(second); assert.notEqual(issued.tokenId, second.tokenId); // No DB one-time exchange here.
});
test('connection and issuer expiry bound token to whole seconds without extending either', async () => {
  const connection = await issuer.issue({ ...input, notAfterMs: nowMs + 10555 }); assert(connection);
  assert.equal(connection.expiresAt, now + 10); assert.equal(connection.validUntilMs, (now + 10) * 1000);
  const shortHost = structuredClone(host); shortHost.keys[0].notAfterMs = nowMs + 20555;
  const short = await (await createBootstrapTokenIssuer({ ...configuration, host: shortHost })).issue(input); assert(short);
  assert.equal(short.expiresAt, now + 20);
  for (const notAfterMs of [nowMs - 1, nowMs, (now + 1) * 1000 - 1]) assert.equal(await issuer.issue({ ...input, notAfterMs }), null);
});
test('key interval must contain current time and whole token interval including iat floor', async () => {
  const partial = structuredClone(host); partial.keys[0].notBeforeMs = nowMs;
  assert.equal(await (await createBootstrapTokenIssuer({ ...configuration, host: partial })).issue(input), null);
  for (const nowMs of [host.keys[0].notBeforeMs - 1, host.keys[0].notAfterMs]) assert.equal(await issuer.issue({ ...input, nowMs }), null);
});
test('issuer initialization rejects wrong private key, exportable keys, public handles and JSON substitutes', async () => {
  const exportable = await generateKeyPair('ES256', { extractable: true });
  for (const signingKey of [other.privateKey, issuerKey.publicKey, exportable.privateKey, {} as CryptoKey,
    { ...publicJwk, d: 'not-a-handle' } as unknown as CryptoKey, new Proxy(issuerKey.privateKey, {})]) {
    await assert.rejects(createBootstrapTokenIssuer({ ...configuration, signingKey }), BootstrapIssuerError);
  }
  const wrongCurve = await generateKeyPair('ES384');
  await assert.rejects(createBootstrapTokenIssuer({ ...configuration, signingKey: wrongCurve.privateKey }), BootstrapIssuerError);
});
test('issuer rejects unknown, revoked, wrong-purpose/environment descriptors and invalid host config', async () => {
  for (const change of [{ revoked: true }, { purpose: 'execution' }, { environment: 'next' }, { notAfterMs: 0 },
    { publicJwk: { ...publicJwk, d: 'private' } }, { publicJwk: await exportJWK(other.publicKey) }]) {
    const changed = structuredClone(host); Object.assign(changed.keys[0], change);
    await assert.rejects(createBootstrapTokenIssuer({ ...configuration, host: changed }), BootstrapIssuerError);
  }
  await assert.rejects(createBootstrapTokenIssuer({ ...configuration, kid: 'unknown' }), BootstrapIssuerError);
  await assert.rejects(createBootstrapTokenIssuer({ ...configuration, host: { ...host, issuer: 'http://issuer.example/' } }), BootstrapIssuerError);
});
test('issue rejects scope/claims overrides, malformed binding/version and unsafe clock inputs', async () => {
  for (const bad of [{ ...input, scope: 'work.read' }, { ...input, jti: 'caller_chooses_jti' },
    { ...input, binding: { ...binding, connectionVersion: '9223372036854775808' } },
    { ...input, binding: { ...binding, ownerUserId: 'bad' } }, { ...input, nowMs: -1 }, { ...input, nowMs: 1.1 },
    { ...input, nowMs: Number.MAX_SAFE_INTEGER + 1 }, { ...input, notAfterMs: Infinity }]) assert.equal(await issuer.issue(bad), null);
});
test('configuration and binding mutation cannot change an in-flight signing operation; getters do not execute', async () => {
  const mutable = structuredClone(host), creation = createBootstrapTokenIssuer({ ...configuration, host: mutable });
  mutable.clientId = 'mutated'; mutable.keys[0].publicJwk.x = base64url.encode(new Uint8Array(32));
  const isolated = await creation, data = structuredClone(input), pending = isolated.issue(data);
  data.binding.ownerUserId = id(99); data.notAfterMs = 0;
  const result = await pending; assert(result); assert.equal(decodeJwt(result.accessToken).owner_user_id, binding.ownerUserId);
  assert.equal(decodeJwt(result.accessToken).client_id, host.clientId);
  let touched = false;
  const evil = Object.defineProperty({ ...configuration }, 'signingKey', { enumerable: true, get() { touched = true; return issuerKey.privateKey; } });
  await assert.rejects(createBootstrapTokenIssuer(evil), BootstrapIssuerError); assert.equal(touched, false);
  const badInput = Object.defineProperty({ ...input }, 'nowMs', { enumerable: true, get() { touched = true; return nowMs; } });
  assert.equal(await issuer.issue(badInput), null); assert.equal(touched, false);
});
test('every token is verified back against the configured public key after signing', async () => {
  const original = crypto.subtle.sign.bind(crypto.subtle);
  crypto.subtle.sign = ((algorithm: AlgorithmIdentifier | RsaPssParams | EcdsaParams, _key: CryptoKey, data: BufferSource) =>
    original(algorithm, other.privateKey, data)) as typeof crypto.subtle.sign;
  try { assert.equal(await issuer.issue(input), null); }
  finally { crypto.subtle.sign = original; }
});
