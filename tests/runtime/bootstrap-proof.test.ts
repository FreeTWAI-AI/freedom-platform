import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, generateKeyPairSync, KeyObject, sign } from 'node:crypto';
import { base64url, CompactSign, exportJWK, generateKeyPair } from 'jose';
import { BootstrapProofResultSchema, type BootstrapProofHost } from '../../contracts/execution/v1/bootstrap.js';
import { createBootstrapProofVerifier, BootstrapProofError } from '../../modules/agent-control/bootstrap-proof.js';

// Ephemeral synthetic issuers/devices, never production trust or saved secrets.
const issuer = await generateKeyPair('ES256', { extractable: true });
const device = await generateKeyPair('ES256', { extractable: true });
const stranger = await generateKeyPair('ES256', { extractable: true });
const issuerJwk = await exportJWK(issuer.publicKey), deviceJwk = await exportJWK(device.publicKey);
const thumb = (jwk: typeof deviceJwk) => createHash('sha256')
  .update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y })).digest('base64url');
const id = (n: number) => `60000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const nowMs = 1_800_000_000_123, now = Math.floor(nowMs / 1000);
const nonce = base64url.encode(new Uint8Array(32).fill(7));
const binding = { ownerUserId: id(1), principalId: id(2), scopeId: id(3), runtimeDeviceId: id(4),
  connectionId: id(5), connectionVersion: '1', keyThumbprint: thumb(deviceJwk) };
const host: BootstrapProofHost = {
  environment: 'local', clientId: 'synthetic-client', issuer: 'https://issuer.example/', audience: 'https://platform.example/',
  bootstrapUri: 'https://platform.example/execution-api/v1/bootstrap', keys: [{ kid: 'synthetic-issuer-1',
    purpose: 'bootstrap_access', environment: 'local', publicJwk: issuerJwk as BootstrapProofHost['keys'][number]['publicJwk'],
    notBeforeMs: nowMs - 1_000_000, notAfterMs: nowMs + 1_000_000, revoked: false }],
};
const accessHeader = { alg: 'ES256', typ: 'freedom-bootstrap+jwt', kid: host.keys[0].kid };
const claims = { iss: host.issuer, aud: host.audience, sub: binding.principalId, owner_user_id: binding.ownerUserId,
  scope_id: binding.scopeId, runtime_device_id: binding.runtimeDeviceId, connection_id: binding.connectionId,
  connection_version: binding.connectionVersion, client_id: host.clientId, environment: host.environment,
  purpose: 'bootstrap_access', scope: 'bootstrap.status.read', cnf: { jkt: binding.keyThumbprint },
  iat: now - 10, exp: now + 100, jti: 'synthetic_access_token_1' };
const proofHeader = { alg: 'ES256', typ: 'dpop+jwt', jwk: deviceJwk };
const hash = (token: string) => createHash('sha256').update(token, 'ascii').digest('base64url');
const proofClaims = (token: string) => ({ jti: 'synthetic_proof_id_1', htm: 'GET', htu: host.bootstrapUri,
  iat: now, ath: hash(token), nonce });
const serialize = (value: unknown) => typeof value === 'string' ? value : JSON.stringify(value);
async function signed(payload: unknown, header: { alg: string; [key: string]: any }, key = issuer.privateKey) {
  return new CompactSign(new TextEncoder().encode(serialize(payload))).setProtectedHeader(header).sign(key);
}
async function pair(accessClaims: unknown = claims, dpopClaims: Record<string, unknown> = {},
  headers = { access: accessHeader, proof: proofHeader }, keys = { issuer: issuer.privateKey, device: device.privateKey }) {
  const accessToken = await signed(accessClaims, headers.access, keys.issuer);
  const proof = await signed({ ...proofClaims(accessToken), ...dpopClaims }, headers.proof, keys.device);
  return { accessToken, proof, expectedNonce: nonce, nowMs, expectedBinding: { ...binding } };
}
const verifier = createBootstrapProofVerifier(host);
const good = await pair();
const verify = (input: unknown = good, configuration = host) => createBootstrapProofVerifier(configuration).verify(input);

test('bootstrap verifies actual issuer/device signatures and returns only frozen crypto evidence', async () => {
  const result = await verifier.verify(good);
  assert(result); assert.deepEqual(BootstrapProofResultSchema.parse(result), result);
  assert.deepEqual(result.binding, binding); assert.equal(result.assurance, 'cryptographic_only');
  assert.equal(result.operational_authority, false); assert(Object.isFrozen(result)); assert(Object.isFrozen(result.binding));
  assert.equal('accessToken' in result, false); assert.equal('proof' in result, false);
  assert.equal(result.proofId, 'synthetic_proof_id_1');
});
test('pure verifier intentionally allows repeated valid proof: no nonce consume, DB status or machine authentication', async () => {
  assert.deepEqual(await verify(), await verify());
  assert(await verify()); // A host-provided clock and binding are assertions, not authenticated observations.
});

for (const [field, value] of Object.entries({
  iss: 'https://other.example/', aud: ['https://platform.example/'], sub: id(91), owner_user_id: id(92),
  scope_id: id(93), runtime_device_id: id(94), connection_id: id(95), connection_version: '2',
  client_id: 'another-client', environment: 'next', purpose: 'execution', scope: 'bootstrap.status.read work.read',
  cnf: { jkt: thumb(issuerJwk) }, jti: 'short', iat: now + 1, exp: now,
})) test(`bootstrap rejects validly signed access claim substitution: ${field}`, async () => {
  assert.equal(await verify(await pair({ ...claims, [field]: value })), null);
});
for (const [field, value] of Object.entries({ jti: 'short', htm: 'POST', htu: host.bootstrapUri + '?q=x',
  iat: now - 61, ath: base64url.encode(new Uint8Array(32)), nonce: base64url.encode(new Uint8Array(32)) })) {
  test(`bootstrap rejects validly signed DPoP substitution: ${field}`, async () => {
    assert.equal(await verify(await pair(claims, { [field]: value })), null);
  });
}
test('bootstrap requires every expected durable identity and exact version/key binding', async () => {
  for (const key of Object.keys(binding)) {
    const value = key === 'connectionVersion' ? '2' : key === 'keyThumbprint' ? thumb(issuerJwk) : id(99);
    assert.equal(await verify({ ...good, expectedBinding: { ...binding, [key]: value } }), null);
  }
});
test('bootstrap rejects wrong issuer/device signer, swapped usages and signature corruption', async () => {
  for (const keys of [{ issuer: stranger.privateKey, device: device.privateKey },
    { issuer: issuer.privateKey, device: stranger.privateKey }, { issuer: device.privateKey, device: device.privateKey }]) {
    assert.equal(await verify(await pair(claims, {}, undefined, keys)), null);
  }
  assert.equal(await verify({ ...good, accessToken: good.proof, proof: good.accessToken }), null);
  for (const field of ['accessToken', 'proof'] as const) {
    const parts = good[field].split('.'), signature = base64url.decode(parts[2]); signature[0] ^= 1;
    parts[2] = base64url.encode(signature); assert.equal(await verify({ ...good, [field]: parts.join('.') }), null);
  }
});
test('bootstrap access lifetime and DPoP clock windows have explicit boundaries', async () => {
  for (const iat of [now - 60, now + 5]) assert(await verify(await pair(claims, { iat })));
  for (const iat of [now - 61, now + 6]) assert.equal(await verify(await pair(claims, { iat })), null);
  assert(await verify(await pair({ ...claims, iat: now, exp: now + 600 })));
  assert.equal(await verify(await pair({ ...claims, iat: now, exp: now + 601 })), null);
  for (const times of [{ iat: now, exp: now }, { iat: now, exp: now - 1 }, { iat: now + 1, exp: now + 100 }]) {
    assert.equal(await verify(await pair({ ...claims, ...times })), null);
  }
  const last = await pair({ ...claims, iat: now - 1, exp: now + 1 });
  assert(await verify({ ...last, nowMs: now * 1000 + 999 }));
  assert.equal(await verify({ ...last, nowMs: (now + 1) * 1000 }), null);
});
test('issuer key must cover entire token interval and current host time; exact endpoints work', async () => {
  const config = structuredClone(host);
  config.keys[0].notBeforeMs = claims.iat * 1000; config.keys[0].notAfterMs = claims.exp * 1000;
  assert(await verify(good, config));
  config.keys[0].notBeforeMs++; assert.equal(await verify(good, config), null);
  config.keys[0].notBeforeMs--; config.keys[0].notAfterMs--; assert.equal(await verify(good, config), null);
  config.keys[0].notAfterMs = claims.exp * 1000;
  config.keys[0].revoked = true; assert.equal(await verify(good, config), null);
  assert.equal(await verify(await pair({ ...claims, exp: Number.MAX_SAFE_INTEGER })), null);
});
test('keyset has fixed local purpose/environment/kid and no unknown-kid refresh', async () => {
  assert.equal(await verify(await pair(claims, {}, { access: { ...accessHeader, kid: 'unknown' }, proof: proofHeader })), null);
  for (const changes of [{ purpose: 'execution' }, { environment: 'next' }, { kid: '' },
    { notBeforeMs: nowMs, notAfterMs: nowMs }, { revoked: 'false' }]) {
    const config: any = structuredClone(host); Object.assign(config.keys[0], changes);
    assert.throws(() => createBootstrapProofVerifier(config), BootstrapProofError);
  }
  for (const keys of [[], [host.keys[0], host.keys[0]], Array(5).fill(host.keys[0])]) {
    assert.throws(() => createBootstrapProofVerifier({ ...host, keys }), BootstrapProofError);
  }
});

for (const field of ['issuer', 'audience', 'bootstrapUri'] as const) test(`host ${field} rejects noncanonical and ambiguous URI forms`, () => {
  const original = host[field];
  for (const uri of [original.replace('https:', 'http:'), original + '?', original + '#', original + '?a=1', original + '#x',
    original.replace('https://', 'https://name@'), original.replace('https://', 'HTTPS://'),
    original.replace('.example', '.example:443'), original.replace('.example', '.EXAMPLE'), ' ' + original, original + '\n']) {
    assert.throws(() => createBootstrapProofVerifier({ ...host, [field]: uri }), BootstrapProofError);
  }
});
test('bootstrap endpoint URI and exact DPoP htu prohibit path, trailing slash, and percent aliases', async () => {
  for (const uri of [host.bootstrapUri + '/', host.bootstrapUri.replace('/bootstrap', '/other'),
    host.bootstrapUri.replace('/bootstrap', '/%62ootstrap'), host.bootstrapUri.replace('/v1/', '/v1/a/../')]) {
    assert.throws(() => createBootstrapProofVerifier({ ...host, bootstrapUri: uri }), BootstrapProofError);
    assert.equal(await verify(await pair(claims, { htu: uri })), null);
  }
});
test('all protected headers reject unknown fields, wrong typ/alg, and private JWK material', async () => {
  const rawSign = (payload: unknown, header: unknown, key: CryptoKey) => {
    const body = `${base64url.encode(JSON.stringify(header))}.${base64url.encode(JSON.stringify(payload))}`;
    return `${body}.${sign('sha256', Buffer.from(body), { key: KeyObject.from(key), dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
  };
  for (const extra of [{ jku: 'https://evil.example/' }, { x5u: 'https://evil.example/' }, { crit: [] },
    { b64: true }, { jwk: issuerJwk }, { typ: 'JWT' }, { typ: 'dpop+jwt' }, { alg: 'none' }, { alg: 'HS256' }, { alg: 'ES384' }]) {
    const accessToken = rawSign(claims, { ...accessHeader, ...extra }, issuer.privateKey);
    assert.equal(await verify({ ...good, accessToken, proof: await signed(proofClaims(accessToken), proofHeader, device.privateKey) }), null);
  }
  for (const extra of [{ jku: 'https://evil.example/' }, { x5u: 'https://evil.example/' }, { crit: [] },
    { kid: 'issuer' }, { typ: 'freedom-bootstrap+jwt' }, { jwk: { ...deviceJwk, d: 'private' } }]) {
    assert.equal(await verify({ ...good, proof: rawSign(proofClaims(good.accessToken), { ...proofHeader, ...extra }, device.privateKey) }), null);
  }
});

// Native signing lets malformed protected JSON reach the verifier without JOSE
// silently normalizing it. This is test-only and independent of verification.
const nativeIssuer = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const nativeHost: BootstrapProofHost = { ...host, keys: [{ ...host.keys[0],
  publicJwk: nativeIssuer.publicKey.export({ format: 'jwk' }) as BootstrapProofHost['keys'][number]['publicJwk'] }] };
function nativeSigned(payload: string | Uint8Array, header = JSON.stringify(accessHeader)) {
  const body = `${base64url.encode(header)}.${base64url.encode(payload)}`;
  return `${body}.${sign('sha256', Buffer.from(body), { key: nativeIssuer.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
}
async function nativeInput(payload: string | Uint8Array, header?: string) {
  const accessToken = nativeSigned(payload, header);
  return { ...good, accessToken, proof: await signed(proofClaims(accessToken), proofHeader, device.privateKey) };
}
test('valid arbitrary JSON order/whitespace is accepted; no fabricated canonical JSON requirement', async () => {
  const payload = JSON.stringify(Object.fromEntries(Object.entries(claims).reverse()), null, 1);
  const header = JSON.stringify(Object.fromEntries(Object.entries(accessHeader).reverse()), null, 1);
  assert(await verify(await nativeInput(payload, header), nativeHost));
});
test('decoded duplicate JSON keys in protected header/payload/nested binding fail closed', async () => {
  for (const header of [JSON.stringify(accessHeader).replace('{', '{"alg":"ES256",'),
    JSON.stringify(accessHeader).replace('{', '{"\\u0061lg":"ES256",')]) {
    assert.equal(await verify(await nativeInput(JSON.stringify(claims), header), nativeHost), null);
  }
  for (const payload of [JSON.stringify(claims).replace('{', '{"iss":"https://issuer.example/",'),
    JSON.stringify(claims).replace('{', '{"\\u0069ss":"https://issuer.example/",'),
    JSON.stringify(claims).replace('"cnf":{', `"cnf":{"jkt":"${binding.keyThumbprint}",`)]) {
    assert.equal(await verify(await nativeInput(payload), nativeHost), null);
  }
});
test('DPoP decoded duplicate header/claims/JWK keys fail despite a real device signature', async () => {
  const header = JSON.stringify(proofHeader), payload = JSON.stringify(proofClaims(good.accessToken));
  const signRaw = (h: string, p: string) => {
    const body = `${base64url.encode(h)}.${base64url.encode(p)}`;
    return `${body}.${sign('sha256', Buffer.from(body), { key: KeyObject.from(device.privateKey), dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
  };
  for (const badHeader of [header.replace('{', '{"typ":"dpop+jwt",'),
    header.replace('{', '{"\\u0074yp":"dpop+jwt",'), header.replace('"jwk":{', '"jwk":{"kty":"EC",')]) {
    assert.equal(await verify({ ...good, proof: signRaw(badHeader, payload) }), null);
  }
  for (const badPayload of [payload.replace('{', '{"htm":"GET",'), payload.replace('{', '{"\\u0068tm":"GET",')]) {
    assert.equal(await verify({ ...good, proof: signRaw(header, badPayload) }), null);
  }
});
test('strict JSON rejects illegal numbers, prototype keys, unknown claims, invalid UTF-8/BOM/surrogates', async () => {
  const json = JSON.stringify(claims);
  for (const payload of [json.replace(`"iat":${claims.iat}`, '"iat":-0'),
    json.replace(`"iat":${claims.iat}`, '"iat":1e9'), json.replace(`"iat":${claims.iat}`, '"iat":1.0'),
    json.replace(`"iat":${claims.iat}`, '"iat":9007199254740993'),
    json.replace('{', '{"__proto__":{},'), json.replace('{', '{"constructor":{},'),
    json.replace('{', '{"prototype":{},'), json.replace('{', '{"unknown":true,'),
    json.replace('synthetic_access_token_1', '\\ud800'), '\ufeff' + json,
    new Uint8Array([0xc3, 0x28]), json + '\0']) {
    assert.equal(await verify(await nativeInput(payload), nativeHost), null);
  }
});
test('bounded compact framing rejects padding, aliases, detached payload, signature width, and oversized input', async () => {
  for (const field of ['accessToken', 'proof'] as const) {
    const parts = good[field].split('.');
    for (const malformed of ['', good[field] + '.', good[field] + '\n', parts[0] + '..' + parts[2],
      ...parts.map((_, index) => parts.map((part, i) => i === index ? part + '=' : part).join('.')),
      `${parts[0]}.${parts[1]}.${base64url.encode(new Uint8Array(65))}`, 'A'.repeat(8193)]) {
      assert.equal(await verify({ ...good, [field]: malformed }), null);
    }
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_', last = alphabet.indexOf(parts[2].at(-1)!);
    for (let i = 1; i < 16; i++) {
      const alias = parts[2].slice(0, -1) + alphabet[last + i];
      assert.equal(await verify({ ...good, [field]: `${parts[0]}.${parts[1]}.${alias}` }), null);
    }
  }
  assert.equal(await verify(await nativeInput(JSON.stringify(claims) + ' '.repeat(4096)), nativeHost), null);
  assert.equal(await verify(await nativeInput(JSON.stringify(claims), JSON.stringify(accessHeader) + ' '.repeat(1024)), nativeHost), null);
  assert.equal(await verify(await nativeInput('{"x":' + '['.repeat(12) + '0' + ']'.repeat(12) + '}'), nativeHost), null);
});
test('P-256 keys reject private material, invalid curve points, other curves and extensions', async () => {
  for (const jwk of [{ ...deviceJwk, d: 'private' }, { ...deviceJwk, crv: 'P-384' }, { ...deviceJwk, use: 'sig' },
    { ...deviceJwk, x: base64url.encode(new Uint8Array(32)), y: base64url.encode(new Uint8Array(32)) }]) {
    const input = await pair({ ...claims, cnf: { jkt: thumb(jwk) } }, {}, { access: accessHeader, proof: { ...proofHeader, jwk } });
    input.expectedBinding.keyThumbprint = thumb(jwk);
    assert.equal(await verify(input), null);
  }
  const config = structuredClone(host); config.keys[0].publicJwk.x = base64url.encode(new Uint8Array(32));
  config.keys[0].publicJwk.y = base64url.encode(new Uint8Array(32));
  assert.equal(await verify(good, config), null);
});
test('positive bigint versions stay exact strings and reject signed-64-bit overflow', async () => {
  const input = await pair({ ...claims, connection_version: '9223372036854775807' });
  input.expectedBinding.connectionVersion = '9223372036854775807'; assert(await verify(input));
  for (const version of ['9223372036854775808', '0', '-1', '01', '1\n', 1]) {
    const bad: any = await pair({ ...claims, connection_version: version }); bad.expectedBinding.connectionVersion = version;
    assert.equal(await verify(bad), null);
  }
});
test('input/host snapshots resist mutation across crypto awaits without freezing caller objects', async () => {
  const config = structuredClone(host), instance = createBootstrapProofVerifier(config);
  config.environment = 'next'; config.keys[0].revoked = true; config.keys[0].publicJwk.x = 'invalid';
  const input = structuredClone(good), pending = instance.verify(input);
  input.accessToken = 'changed'; input.expectedBinding.principalId = id(99); input.nowMs = 0;
  assert(await pending); assert.equal(Object.isFrozen(config), false); assert.equal(Object.isFrozen(input), false);
});
test('unknown object fields, getters/toJSON, malformed clock and configs never invoke code or leak material', async () => {
  let touched = false;
  for (const input of [{ ...good, get secret() { touched = true; return 'sensitive'; } },
    { ...good, toJSON() { touched = true; return good; } }, { ...good, expectedNonce: nonce + '\n' },
    { ...good, nowMs: -1 }, { ...good, nowMs: 0.1 }, { ...good, nowMs: Number.NaN }, { ...good, extra: 'sensitive' }]) {
    assert.equal(await verify(input), null);
  }
  assert.throws(() => createBootstrapProofVerifier({ ...host, get keys() { touched = true; return host.keys; } }),
    { name: 'BootstrapProofError', message: 'invalid_bootstrap_configuration' });
  assert.equal(touched, false);
});
test('ECDSA high/low-S equivalents remain crypto evidence, so replay must use nonce/jti rather than proof bytes', async () => {
  const parts = good.proof.split('.'), bytes = Buffer.from(parts[2], 'base64url');
  const order = BigInt('0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551');
  const otherS = order - BigInt('0x' + bytes.subarray(32).toString('hex'));
  Buffer.from(otherS.toString(16).padStart(64, '0'), 'hex').copy(bytes, 32);
  parts[2] = bytes.toString('base64url');
  assert.notEqual(parts.join('.'), good.proof);
  assert.deepEqual(await verify({ ...good, proof: parts.join('.') }), await verify(good));
});
