import assert from 'node:assert/strict';
import test from 'node:test';
import { CompactSign, base64url } from 'jose';
import { createCredentialVault, CredentialVaultError } from '../../apps/credential-broker/src/vault.js';
import { createSignedRecoverySource, CredentialRecoveryError } from '../../apps/credential-broker/src/recovery.js';
import type { ModelCredentialBinding } from '../../contracts/execution/v2/model-credential.js';

const epoch = Date.parse('2026-10-03T12:00:00.000Z');
const iso = (milliseconds: number) => new Date(milliseconds).toISOString();
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function binding(): ModelCredentialBinding {
  return { profile: 'model-credential.binding/v1', credentialId: id(1), generation: '9223372036854775807',
    modelConnectionId: id(2), modelVersion: '9007199254740993', ownerUserId: id(3), ownerPrincipalId: id(4), scopeId: id(5),
    environment: 'local', clientId: 'freedom-platform', runtimeDeviceId: id(6), connectionId: id(7), familyId: id(8),
    selection: { providerRef: 'openai', modelRef: 'synthetic-model', processingLocation: 'provider_remote',
      artifactCustody: 'platform_asset', credentialCustody: 'platform_vault', engineLocation: 'platform', billingSource: 'user_byok' },
    recoveryGeneration: '1', issuedAt: iso(epoch - 1000), expiresAt: iso(epoch + 60_000) };
}
const secret = () => new TextEncoder().encode('synthetic-provider-key-only');
const aes = (extractable = false) => crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, extractable, ['encrypt', 'decrypt']);
async function fixture() {
  const key = await aes(); let generation = '1';
  const vault = createCredentialVault({ kek: { current: async () => ({ keyId: 'synthetic-kek-1', key }), readById: async () => key },
    recover: async () => ({ generation, expiresAt: iso(epoch + 120_000) }), now: () => epoch });
  return { vault, key, advance: () => { generation = '2'; } };
}

test('broker AEAD roundtrip has fresh per-record DEKs/nonces and opaque instance provenance', async () => {
  const { vault, key } = await fixture(), expected = binding(), raw = secret();
  const first = vault.readSealedCredential(await vault.seal(expected, raw), expected);
  const secondHandle = await vault.seal(expected, raw), second = vault.readSealedCredential(secondHandle, expected);
  assert.equal(Object.isFrozen(first), true);
  assert.notEqual(first.nonce, first.wrapNonce); assert.notEqual(first.nonce, second.nonce);
  assert.notEqual(first.wrappedDek, second.wrappedDek); assert.notEqual(first.ciphertext, second.ciphertext);
  const opened = await vault.open(expected, first);
  try { assert.deepEqual(opened, raw); } finally { opened.fill(0); }
  assert.throws(() => vault.readSealedCredential({ ...secondHandle } as typeof secondHandle, expected), CredentialVaultError);
  assert.throws(() => vault.readSealedCredential(first as never, expected), CredentialVaultError);
  const other = createCredentialVault({ kek: { current: async () => ({ keyId: 'synthetic-kek-1', key }), readById: async () => key },
    recover: async () => ({ generation: '1', expiresAt: iso(epoch + 120_000) }), now: () => epoch });
  assert.throws(() => other.readSealedCredential(secondHandle, expected), CredentialVaultError);
  assert.throws(() => vault.readSealedCredential(secondHandle, { ...expected, modelVersion: '9007199254740994' }), CredentialVaultError);
  raw.fill(0);
});

test('broker rejects changed AAD, ciphertext tags, canonical encoding and unknown KEKs', async () => {
  const { vault } = await fixture(), expected = binding();
  const envelope = vault.readSealedCredential(await vault.seal(expected, secret()), expected);
  for (const field of ['credentialId', 'ownerUserId', 'ownerPrincipalId', 'scopeId', 'modelConnectionId', 'runtimeDeviceId', 'connectionId', 'familyId'] as const)
    await assert.rejects(vault.open({ ...expected, [field]: id(99) }, envelope), CredentialVaultError);
  await assert.rejects(vault.open({ ...expected, modelVersion: '9007199254740994' }, envelope), CredentialVaultError);
  await assert.rejects(vault.open({ ...expected, selection: { ...expected.selection, modelRef: 'other-model' } }, envelope), CredentialVaultError);
  for (const field of ['ciphertext', 'wrappedDek'] as const) {
    const bytes = base64url.decode(envelope[field]); bytes[bytes.length - 1] ^= 1;
    await assert.rejects(vault.open(expected, { ...envelope, [field]: base64url.encode(bytes) }), CredentialVaultError);
  }
  await assert.rejects(vault.open(expected, { ...envelope, ciphertext: envelope.ciphertext + '=' }), CredentialVaultError);
  await assert.rejects(vault.open(expected, { ...envelope, nonce: envelope.wrapNonce }), CredentialVaultError);
  await assert.rejects(vault.open(expected, { ...envelope, unexpected: 'value' } as never), CredentialVaultError);
  const missing = createCredentialVault({ kek: { current: async () => { throw new Error('port detail'); }, readById: async () => null },
    recover: async () => ({ generation: '1', expiresAt: iso(epoch + 120_000) }), now: () => epoch });
  await assert.rejects(missing.open(expected, envelope), { name: 'CredentialVaultError', message: 'credential_vault_unavailable' });
});

test('broker bounds provider keys, rejects extractable KEK, expiry and recovery snapshot restore', async () => {
  const { vault, advance } = await fixture(), expected = binding();
  for (const bytes of [new Uint8Array(0), new Uint8Array(4097).fill(65), new Uint8Array([255]), new TextEncoder().encode('key\nvalue')])
    await assert.rejects(vault.seal(expected, bytes), CredentialVaultError);
  const boundary = new Uint8Array(4096).fill(65);
  const envelope = vault.readSealedCredential(await vault.seal(expected, boundary), expected);
  const opened = await vault.open(expected, envelope); assert.equal(opened.length, 4096); opened.fill(0); boundary.fill(0);
  await assert.rejects(vault.seal({ ...expected, expiresAt: iso(epoch) }, secret()), CredentialVaultError);
  await assert.rejects(vault.seal({ ...expected, issuedAt: iso(epoch + 1) }, secret()), CredentialVaultError);
  const extractable = await aes(true);
  const invalid = createCredentialVault({ kek: { current: async () => ({ keyId: 'synthetic', key: extractable }), readById: async () => extractable },
    recover: async () => ({ generation: '1', expiresAt: iso(epoch + 120_000) }), now: () => epoch });
  await assert.rejects(invalid.seal(expected, secret()), CredentialVaultError);
  advance();
  await assert.rejects(vault.open(expected, envelope), CredentialVaultError);
  await assert.rejects(vault.seal(expected, secret()), CredentialVaultError);
});

test('broker zeroes owned key and DEK copies when external recovery changes during crypto await', async () => {
  const { vault, advance } = await fixture(), raw = secret();
  const originalEncrypt = crypto.subtle.encrypt, originalImport = crypto.subtle.importKey;
  let capturedSecret: Uint8Array | undefined, capturedDek: Uint8Array | undefined;
  try {
    crypto.subtle.importKey = (async function (...args: Parameters<typeof originalImport>) {
      if (args[0] === 'raw' && args[1] instanceof Uint8Array) capturedDek = args[1];
      return originalImport.apply(crypto.subtle, args);
    }) as typeof originalImport;
    crypto.subtle.encrypt = async function (...args: Parameters<typeof originalEncrypt>) {
      if (args[2] instanceof Uint8Array) capturedSecret = args[2];
      const output = await originalEncrypt.apply(crypto.subtle, args); advance(); return output;
    };
    await assert.rejects(vault.seal(binding(), raw), CredentialVaultError);
    assert.ok(capturedSecret && capturedDek);
    assert.equal(capturedSecret.every(value => value === 0), true);
    assert.equal(capturedDek.every(value => value === 0), true);
    assert.equal(raw.some(value => value !== 0), true);
  } finally { crypto.subtle.encrypt = originalEncrypt; crypto.subtle.importKey = originalImport; raw.fill(0); }
});

test('broker zeroes decrypted buffers when recovery or KEK changes during open', async () => {
  const { vault, key, advance } = await fixture(), expected = binding();
  const envelope = vault.readSealedCredential(await vault.seal(expected, secret()), expected);
  const originalDecrypt = crypto.subtle.decrypt;
  let decrypted: ArrayBuffer | undefined;
  try {
    crypto.subtle.decrypt = async function (...args: Parameters<typeof originalDecrypt>) {
      decrypted = await originalDecrypt.apply(crypto.subtle, args); advance(); return decrypted;
    };
    await assert.rejects(vault.open(expected, envelope), CredentialVaultError);
    assert.ok(decrypted); assert.equal(new Uint8Array(decrypted).every(value => value === 0), true);
  } finally { crypto.subtle.decrypt = originalDecrypt; }
  const replacement = await aes(); let reads = 0;
  const rotated = createCredentialVault({ kek: { current: async () => ({ keyId: envelope.keyId, key }),
    readById: async () => ++reads === 1 ? key : replacement }, recover: async () => ({ generation: '1', expiresAt: iso(epoch + 120_000) }), now: () => epoch });
  try {
    crypto.subtle.decrypt = async function (...args: Parameters<typeof originalDecrypt>) {
      decrypted = await originalDecrypt.apply(crypto.subtle, args); return decrypted;
    };
    await assert.rejects(rotated.open(expected, envelope), CredentialVaultError);
    assert.ok(decrypted); assert.equal(new Uint8Array(decrypted).every(value => value === 0), true);
  } finally { crypto.subtle.decrypt = originalDecrypt; }
  let currents = 0;
  const rotatingSeal = createCredentialVault({ kek: { current: async () => ({ keyId: envelope.keyId, key: ++currents === 1 ? key : replacement }),
    readById: async () => key }, recover: async () => ({ generation: '1', expiresAt: iso(epoch + 120_000) }), now: () => epoch });
  await assert.rejects(rotatingSeal.seal(expected, secret()), CredentialVaultError);
});

async function recoveryFixture() {
  const pair = await crypto.subtle.generateKey('Ed25519', false, ['sign', 'verify']);
  const state = { profile: 'credential-broker.recovery/v1', purpose: 'credential-broker.recovery',
    authority: 'synthetic-external-authority', environment: 'local', generation: '1', issuedAt: iso(epoch - 1000), expiresAt: iso(epoch + 120_000) };
  const sign = (payload: unknown = state, header: { alg: string; [key: string]: string } = { alg: 'EdDSA', typ: 'freedom-credential-recovery+jws', kid: 'synthetic-recovery-1' }) =>
    new CompactSign(new TextEncoder().encode(typeof payload === 'string' ? payload : JSON.stringify(payload))).setProtectedHeader(header).sign(pair.privateKey);
  const options = { pinnedKeys: [{ keyId: 'synthetic-recovery-1', key: pair.publicKey }], authority: state.authority,
    environment: 'local' as const, now: () => epoch };
  return { state, sign, options };
}

test('external signed recovery verifies exact pinned purpose and independently persisted current floor', async () => {
  const { state, sign, options } = await recoveryFixture();
  let raw = await sign(), floor = { generation: '1', expiresAt: iso(epoch + 90_000) };
  const source = () => createSignedRecoverySource({ ...options, readSignedState: async () => raw, readMonotonicFloor: async () => floor });
  const current = source(); assert.deepEqual(await current.recover(), floor);
  raw = await sign({ ...state, generation: '2' }); floor = { ...floor, generation: '2' }; assert.equal((await current.recover()).generation, '2');
  raw = await sign(); floor = { ...floor, generation: '1' };
  await assert.rejects(current.recover(), CredentialRecoveryError);
  floor = { ...floor, generation: '2' };
  // New process, same restored signed state: only the external floor prevents rollback.
  await assert.rejects(source().recover(), CredentialRecoveryError);
  floor = { ...floor, generation: '1' };
  let calls = 0;
  await assert.rejects(createSignedRecoverySource({ ...options, readSignedState: async () => raw,
    readMonotonicFloor: async () => ({ ...floor, generation: ++calls === 1 ? '1' : '2' }) }).recover(), CredentialRecoveryError);
});

test('external recovery fails closed for tamper, wrong key/schema/env/purpose, expiry, floor and duplicate JSON', async () => {
  const { state, sign, options } = await recoveryFixture();
  const floor = { generation: '1', expiresAt: iso(epoch + 120_000) };
  const recover = (raw: string, observed: unknown = floor) => createSignedRecoverySource({ ...options,
    readSignedState: async () => raw, readMonotonicFloor: async () => observed as typeof floor }).recover();
  for (const changes of [{ authority: 'different' }, { environment: 'staging' }, { purpose: 'different' }, { profile: 'other' },
    { generation: '9223372036854775808' }, { generation: '01' }, { issuedAt: iso(epoch + 1) }, { expiresAt: iso(epoch) },
    { expiresAt: iso(epoch + 300_001) }, { extra: 'unexpected' }])
    await assert.rejects(recover(await sign({ ...state, ...changes })), CredentialRecoveryError);
  await assert.rejects(recover(await sign(state, { alg: 'EdDSA', typ: 'freedom-credential-recovery+jws', kid: 'unknown-key' })), CredentialRecoveryError);
  await assert.rejects(recover(await sign(state, { alg: 'EdDSA', typ: 'freedom-credential-recovery+jws', kid: 'synthetic-recovery-1', jku: 'https://invalid.test/key' })), CredentialRecoveryError);
  const raw = await sign(), parts = raw.split('.'), signature = base64url.decode(parts[2]); signature[0] ^= 1;
  await assert.rejects(recover([parts[0], parts[1], base64url.encode(signature)].join('.')), CredentialRecoveryError);
  await assert.rejects(recover(raw, { ...floor, expiresAt: iso(epoch) }), CredentialRecoveryError);
  await assert.rejects(recover(raw, null), CredentialRecoveryError);
  await assert.rejects(recover(await sign(JSON.stringify(state).replace('"generation":"1"', '"generation":"1","generation":"1"'))), CredentialRecoveryError);
  let clock = epoch;
  await assert.rejects(createSignedRecoverySource({ ...options, now: () => clock, readMonotonicFloor: async () => floor,
    readSignedState: async () => { clock += 5000; return raw; } }).recover(), CredentialRecoveryError);
});

test('broker has one three-second total deadline for hung ports and zeroes a late plaintext result', async () => {
  const { vault, key } = await fixture(), expected = binding();
  const envelope = vault.readSealedCredential(await vault.seal(expected, secret()), expected);
  const never = <T>() => new Promise<T>(() => {});
  const observation = async () => ({ generation: '1', expiresAt: iso(epoch + 120_000) });
  const waitingKek = createCredentialVault({ kek: { current: never, readById: never }, recover: observation, now: () => epoch });
  const waitingRecovery = createCredentialVault({ kek: { current: async () => ({ keyId: envelope.keyId, key }), readById: async () => key },
    recover: never, now: () => epoch });
  const { options, sign } = await recoveryFixture(), signed = await sign();
  const waitingFloor = createSignedRecoverySource({ ...options, readSignedState: async () => signed, readMonotonicFloor: never });
  const waitingState = createSignedRecoverySource({ ...options, readSignedState: never, readMonotonicFloor: observation });
  const originalDecrypt = crypto.subtle.decrypt;
  let latePlaintext: ArrayBuffer | undefined, release: ((value: ArrayBuffer) => void) | undefined, calls = 0;
  const started = performance.now();
  try {
    crypto.subtle.decrypt = async function (...args: Parameters<typeof originalDecrypt>) {
      const result = await originalDecrypt.apply(crypto.subtle, args);
      if (++calls === 1) return result;
      latePlaintext = result;
      return new Promise<ArrayBuffer>(resolve => { release = resolve; });
    };
    await Promise.all([
      assert.rejects(waitingKek.seal(expected, secret()), CredentialVaultError),
      assert.rejects(waitingKek.open(expected, envelope), CredentialVaultError),
      assert.rejects(waitingRecovery.seal(expected, secret()), CredentialVaultError),
      assert.rejects(waitingFloor.recover(), CredentialRecoveryError),
      assert.rejects(waitingState.recover(), CredentialRecoveryError),
      assert.rejects(vault.open(expected, envelope), CredentialVaultError),
    ]);
    assert.ok(performance.now() - started < 4500);
    assert.ok(latePlaintext && release);
    assert.equal(new Uint8Array(latePlaintext).some(value => value !== 0), true);
    release(latePlaintext);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(new Uint8Array(latePlaintext).every(value => value === 0), true);
  } finally { crypto.subtle.decrypt = originalDecrypt; if (latePlaintext) release?.(latePlaintext); }
});
