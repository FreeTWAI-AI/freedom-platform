import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID, createHash } from 'node:crypto';
import { CompactSign, generateKeyPair, exportJWK, calculateJwkThumbprint, base64url } from 'jose';
import { createMachineTextProofVerifier, signMachineTextAccess, machineTextRequestHash, parseMachineTextHost } from '../../modules/agent-control/machine-text-proof.js';
import type { MachineTextHost, MachineTextBinding, MachineTextClaims } from '../../contracts/execution/v3/machine-text-execution.js';
import { parseRuntimePublicJwk } from '../../modules/agent-control/runtime-proof.js';

async function fixture() {
  const issuer = await generateKeyPair('ES256', { extractable: true }), device = await generateKeyPair('ES256', { extractable: true });
  const publicJwk = parseRuntimePublicJwk(await exportJWK(device.publicKey)), now = Math.floor(Date.now() / 1000) * 1000;
  const host: MachineTextHost = { profile: 'freedom.machine-text.host/v1', environment: 'local', clientId: 'agent-kit',
    origin: 'https://machine.example.invalid', issuer: 'https://machine.example.invalid/issuer',
    audience: 'https://machine.example.invalid/execution-api/v1/model-steps', issuerKid: 'machine-issuer-0001',
    keys: [{ kid: 'machine-issuer-0001', purpose: 'machine_text', environment: 'local',
      publicJwk: parseRuntimePublicJwk(await exportJWK(issuer.publicKey)), notBeforeMs: now - 60000, notAfterMs: now + 600000, revoked: false }] };
  const binding: MachineTextBinding = { ownerUserId: randomUUID(), principalId: randomUUID(), scopeId: randomUUID(),
    runtimeDeviceId: randomUUID(), runtimeVersion: '1', connectionId: randomUUID(), connectionVersion: '1', familyId: randomUUID(),
    keyThumbprint: await calculateJwkThumbprint(publicJwk), authorizationId: randomUUID(), stepId: randomUUID(), attemptId: randomUUID(),
    runId: randomUUID(), grantId: randomUUID(), grantVersion: '1', approvalId: randomUUID(), approvalVersion: '1',
    bindingSha256: 'a'.repeat(64), recoveryGeneration: '7' };
  const deviceBinding = Object.fromEntries(Object.entries(binding).filter(([k]) => ['ownerUserId','principalId','scopeId','runtimeDeviceId','runtimeVersion','connectionId','connectionVersion','familyId','keyThumbprint'].includes(k))) as Pick<MachineTextBinding,'ownerUserId'|'principalId'|'scopeId'|'runtimeDeviceId'|'runtimeVersion'|'connectionId'|'connectionVersion'|'familyId'|'keyThumbprint'>;
  const sign = (claims: unknown, key = device.privateKey, header: Record<string,unknown> = {}) => new CompactSign(new TextEncoder().encode(JSON.stringify(claims)))
    .setProtectedHeader({ alg: 'ES256', typ: 'dpop+jwt', jwk: publicJwk, ...header }).sign(key);
  const requestSha256 = machineTextRequestHash('POST', '/execution-api/v1/model-steps', new Uint8Array(), 'idempotency-key-01', '1');
  const base = { jti: randomUUID(), iat: now / 1000, htu: host.audience, client_id: 'agent-kit', environment: 'local',
    connection_id: binding.connectionId, family_id: binding.familyId, request_sha256: requestSha256 };
  const challengeId = randomUUID(), nonce = base64url.encode(new Uint8Array(32).fill(7));
  const activation = { ...base, purpose: 'machine_text.activate', htm: 'POST', nonce, challenge_id: challengeId };
  const verifier = createMachineTextProofVerifier(host);
  const claims = (evidence = false): MachineTextClaims => ({ iss: host.issuer, aud: host.audience, sub: binding.principalId,
    environment: 'local', client_id: 'agent-kit', purpose: evidence ? 'machine_text.evidence' : 'machine_text.execute',
    scope: evidence ? 'model.dispatch.evidence' : 'model.private-draft', binding, cnf: { jkt: binding.keyThumbprint },
    iat: now / 1000, exp: now / 1000 + (evidence ? 300 : 90), jti: randomUUID() });
  return { issuer, device, publicJwk, host, binding, deviceBinding, now, sign, requestSha256, base, challengeId, nonce, activation, verifier, claims };
}
test('MACHINE-PROOF-01 real device challenge and exact activation proof use separate signed purposes', async () => {
  const f = await fixture();
  const result = await f.verifier.device({ proof: await f.sign(f.activation), purpose: 'activate', binding: f.deviceBinding,
    requestSha256: f.requestSha256, nowMs: f.now, challengeId: f.challengeId, nonce: f.nonce });
  assert(result); assert.equal(result.assurance, 'cryptographic_only'); assert.equal(result.proofId, f.base.jti);
  assert(await f.verifier.device({ proof: await f.sign({ ...f.base, purpose: 'machine_text.challenge', htm: 'POST', htu: f.host.audience + '/challenge' }),
    purpose: 'challenge', binding: f.deviceBinding, requestSha256: f.requestSha256, nowMs: f.now }));
});
test('MACHINE-PROOF-02 changed activation signature/binding/method/URI/purpose/time/body/nonce is rejected', async () => {
  const f = await fixture();
  const check = async (claims: Record<string,unknown>, header?: Record<string,unknown>) => f.verifier.device({
    proof: await f.sign(claims, f.device.privateKey, header), purpose: 'activate', binding: f.deviceBinding,
    requestSha256: f.requestSha256, nowMs: f.now, challengeId: f.challengeId, nonce: f.nonce });
  for (const patch of [{ htm: 'GET' }, { htu: f.host.audience + '/' }, { htu: f.host.audience + '?x=1' },
    { purpose: 'bootstrap.nonce' }, { environment: 'next' }, { client_id: 'other' }, { connection_id: randomUUID() },
    { family_id: randomUUID() }, { request_sha256: 'b'.repeat(64) }, { nonce: base64url.encode(new Uint8Array(32)) },
    { challenge_id: randomUUID() }, { iat: f.now / 1000 - 61 }, { iat: f.now / 1000 + 6 }, { extra: true }])
    assert.equal(await check({ ...f.activation, ...patch }), null, JSON.stringify(Object.keys(patch)));
  assert.equal(await check(f.activation, { typ: 'freedom-bootstrap+jwt' }), null);
  const foreign = await generateKeyPair('ES256', { extractable: true });
  assert.equal(await f.verifier.device({ proof: await f.sign(f.activation, foreign.privateKey), purpose: 'activate', binding: f.deviceBinding,
    requestSha256: f.requestSha256, nowMs: f.now, challengeId: f.challengeId, nonce: f.nonce }), null);
});
test('MACHINE-PROOF-03 execution and evidence token operations are cryptographically disjoint', async () => {
  const f = await fixture();
  for (const operation of ['execute','status','evidence'] as const) {
    const token = await signMachineTextAccess(f.host, f.issuer.privateKey, f.claims(operation === 'evidence'));
    const claims = { ...f.base, purpose: 'machine_text.request', htm: operation === 'status' ? 'GET' : 'POST',
      htu: `${f.host.audience}/${f.binding.stepId}${operation === 'status' ? '' : '/' + operation}`,
      ath: base64url.encode(createHash('sha256').update(token).digest()) };
    assert(await f.verifier.access({ accessToken: token, proof: await f.sign(claims), operation, binding: f.binding,
      requestSha256: f.requestSha256, nowMs: f.now }));
    const wrongToken = await signMachineTextAccess(f.host, f.issuer.privateKey, f.claims(operation !== 'evidence'));
    assert.equal(await f.verifier.access({ accessToken: wrongToken, proof: await f.sign({ ...claims,
      ath: base64url.encode(createHash('sha256').update(wrongToken).digest()) }), operation, binding: f.binding,
      requestSha256: f.requestSha256, nowMs: f.now }), null);
  }
});
test('MACHINE-PROOF-04 token audience/key/current profile/time and DPoP ath/body are mandatory', async () => {
  const f = await fixture(), original = f.claims();
  const check = async (claims: MachineTextClaims, proofPatch: Record<string,unknown> = {}, binding = f.binding, host = f.host) => {
    const token = await new CompactSign(new TextEncoder().encode(JSON.stringify(claims)))
      .setProtectedHeader({ alg: 'ES256', typ: 'freedom-execution-text+jwt', kid: f.host.issuerKid }).sign(f.issuer.privateKey);
    return createMachineTextProofVerifier(host).access({ accessToken: token, proof: await f.sign({ ...f.base,
      purpose: 'machine_text.request', htm: 'POST', htu: `${f.host.audience}/${f.binding.stepId}/execute`,
      ath: base64url.encode(createHash('sha256').update(token).digest()), ...proofPatch }), operation: 'execute', binding,
      requestSha256: f.requestSha256, nowMs: f.now });
  };
  for (const patch of [{ aud: f.host.audience + '/' }, { iss: f.host.issuer + '/' }, { sub: randomUUID() },
    { environment: 'next' }, { exp: f.now / 1000 }, { exp: f.now / 1000 + 91 }, { iat: f.now / 1000 + 1 },
    { purpose: 'bootstrap_access' }, { scope: 'bootstrap.status.read' }, { cnf: { jkt: 'b'.repeat(43) } }])
    assert.equal(await check({ ...original, ...patch } as MachineTextClaims), null);
  for (const patch of [{ ath: 'a'.repeat(43) }, { htm: 'GET' }, { htu: f.host.audience },
    { purpose: 'machine_text.activate' }, { request_sha256: 'b'.repeat(64) }, { iat: f.now / 1000 - 61 }]) assert.equal(await check(original, patch), null);
  assert.equal(await check(original, {}, { ...f.binding, grantId: randomUUID() }), null);
  assert.equal(await check(original, {}, f.binding, { ...f.host, keys: f.host.keys.map(k => ({ ...k, revoked: true })) }), null);
});
test('MACHINE-PROOF-05 strict compact JSON rejects duplicate/escaped fields and arbitrary issuer configuration', async () => {
  const f = await fixture(), payload = JSON.stringify(f.activation).replace('"htm":"POST"', '"htm":"POST","h\\u0074m":"POST"');
  const proof = await new CompactSign(new TextEncoder().encode(payload)).setProtectedHeader({ alg: 'ES256', typ: 'dpop+jwt', jwk: f.publicJwk }).sign(f.device.privateKey);
  assert.equal(await f.verifier.device({ proof, purpose: 'activate', binding: f.deviceBinding, requestSha256: f.requestSha256,
    nowMs: f.now, challengeId: f.challengeId, nonce: f.nonce }), null);
  for (const patch of [{ origin: 'http://machine.example.invalid' }, { origin: f.host.origin + '/' },
    { audience: f.host.audience + '?x=1' }, { keys: [...f.host.keys, ...f.host.keys] }]) assert.throws(() => parseMachineTextHost({ ...f.host, ...patch }));
  for (const part of ['body','key','version','method','path']) {
    assert.notEqual(machineTextRequestHash(part === 'method' ? 'GET' : 'POST', part === 'path' ? '/other' : '/',
      new TextEncoder().encode(part === 'body' ? 'changed' : '{}'), part === 'key' ? 'other-key' : 'same-key', part === 'version' ? '2' : '1'),
    machineTextRequestHash('POST','/',new TextEncoder().encode('{}'),'same-key','1'));
  }
});

test('MACHINE-PROOF-06 unknown kid and malicious jku never fetch an unapproved source (GOV27)',async()=>{
  const f=await fixture(),original=globalThis.fetch;let calls=0;
  globalThis.fetch=async()=>{calls++;throw new Error('network_denied_by_fixture');};
  try{for(const header of [{kid:'unknown-issuer-key-0001'},{kid:f.host.issuerKid,jku:'https://attacker.example.invalid/keys'},
    {kid:f.host.issuerKid,x5u:'https://attacker.example.invalid/cert'},{kid:f.host.issuerKid,jwk:parseRuntimePublicJwk(await exportJWK(f.issuer.publicKey))}]){
    const token=await new CompactSign(new TextEncoder().encode(JSON.stringify(f.claims(false))))
      .setProtectedHeader({alg:'ES256',typ:'freedom-execution-text+jwt',...header}).sign(f.issuer.privateKey);
    const proof=await f.sign({...f.base,purpose:'machine_text.request',htm:'POST',htu:f.host.audience+'/'+f.binding.stepId+'/execute',
      ath:base64url.encode(createHash('sha256').update(token).digest())});
    assert.equal(await f.verifier.access({accessToken:token,proof,operation:'execute',binding:f.binding,requestSha256:f.requestSha256,nowMs:f.now}),null);
  }assert.equal(calls,0);}finally{globalThis.fetch=original;}
});
