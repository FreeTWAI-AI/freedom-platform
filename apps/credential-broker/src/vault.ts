import { base64url } from 'jose';
import { BrokerCredentialEnvelopeSchema, ModelCredentialBindingSchema, CredentialRecoveryFloorSchema as Recovery,
  type BrokerCredentialEnvelope, type ModelCredentialBinding } from '../../../contracts/execution/v2/model-credential.js';
import { freezeTree, snapshotInput } from '../../../packages/execution-state/decode.js';
import type { CredentialRecoveryObservation } from './recovery.js';

declare const sealedBrand: unique symbol;
export type OpaqueSealedCredential = { readonly [sealedBrand]: true };
export interface CredentialVaultOptions {
  kek: {
    current(): Promise<{ keyId: string; key: CryptoKey }>;
    readById(keyId: string): Promise<CryptoKey | null>;
  };
  recover(): Promise<CredentialRecoveryObservation>;
  now?: () => number;
}
export interface CredentialVault {
  seal(binding: ModelCredentialBinding, key: Uint8Array): Promise<OpaqueSealedCredential>;
  readSealedCredential(handle: OpaqueSealedCredential, expectedBinding: ModelCredentialBinding): BrokerCredentialEnvelope;
  /** Broker-internal trusted store seam. The store must authorize the exact
   * current DB binding before and after await, and zero returned key in finally.
   * This app is not exported by the main Worker or installed as a host resolver. */
  open(binding: ModelCredentialBinding, envelope: BrokerCredentialEnvelope): Promise<Uint8Array>;
}
export class CredentialVaultError extends Error {
  constructor() { super('credential_vault_unavailable'); this.name = 'CredentialVaultError'; }
}
const fail = (): never => { throw new CredentialVaultError(); };
const KeyId = BrokerCredentialEnvelopeSchema.shape.keyId;
const MAX_KEY_BYTES = 4096;
const OPERATION_MILLISECONDS = 3000;

function deadline() {
  const end = performance.now() + OPERATION_MILLISECONDS;
  return async function bounded<T>(operation: () => Promise<T>, discard?: (value: T) => void): Promise<T> {
    const remaining = end - performance.now();
    if (remaining <= 0) return fail();
    let expired = false, timer: ReturnType<typeof setTimeout> | undefined;
    // The continuation remains attached after timeout. In particular a late
    // decrypt result is zeroed before becoming an unreachable plaintext buffer.
    const work = Promise.resolve().then(operation).then(value => {
      if (expired || performance.now() >= end) { discard?.(value); return fail(); }
      return value;
    });
    try {
      return await Promise.race([work, new Promise<never>((_, reject) => {
        timer = setTimeout(() => { expired = true; reject(new CredentialVaultError()); }, remaining);
      })]);
    } finally { if (timer !== undefined) clearTimeout(timer); }
  };
}
type Budget = ReturnType<typeof deadline>;

// This is an internal closed-object encoding, not a public JCS wire contract.
function ordered(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value;
  const result: Record<string, unknown> = Object.create(null);
  for (const key of Object.keys(value).sort()) result[key] = ordered((value as Record<string, unknown>)[key]);
  return result;
}
function encoded(value: unknown): string { return JSON.stringify(ordered(value)); }
function binding(raw: unknown): ModelCredentialBinding { return freezeTree(ModelCredentialBindingSchema.parse(snapshotInput(raw))); }
function decode(raw: string, min: number, max: number): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$(?![\s\S])/.test(raw) || raw.length > Math.ceil(max * 4 / 3)) fail();
  const bytes = base64url.decode(raw);
  if (bytes.byteLength < min || bytes.byteLength > max || base64url.encode(bytes) !== raw) fail();
  return new Uint8Array(bytes);
}
function validSecret(raw: Uint8Array): boolean {
  // Same bounded ASCII/UTF-8 provider key profile as the existing trusted host.
  // Inspect bytes without creating an immutable plaintext JavaScript string.
  if (raw.byteLength < 1 || raw.byteLength > MAX_KEY_BYTES) return false;
  for (const value of raw) if (!(value >= 48 && value <= 57 || value >= 65 && value <= 90
    || value >= 97 && value <= 122 || value === 46 || value === 95 || value === 45)) return false;
  return true;
}
function validKek(key: CryptoKey): boolean {
  return key instanceof CryptoKey && key.type === 'secret' && !key.extractable && key.algorithm.name === 'AES-GCM'
    && (key.algorithm as AesKeyAlgorithm).length === 256 && key.usages.length === 2
    && key.usages.includes('encrypt') && key.usages.includes('decrypt');
}

/** Explicit broker composition only: there is no default KEK, environment key,
 * ambient credential, HTTP secret route, database secret DTO, or global host. */
export function createCredentialVault(options: CredentialVaultOptions): CredentialVault {
  let current: CredentialVaultOptions['kek']['current'], readKey: CredentialVaultOptions['kek']['readById'];
  let recover: CredentialVaultOptions['recover'], now: () => number;
  try {
    current = options.kek.current.bind(options.kek); readKey = options.kek.readById.bind(options.kek);
    recover = options.recover.bind(options); now = options.now ?? Date.now;
    if (typeof now !== 'function') fail();
  } catch { return fail(); }
  const minted = new WeakMap<object, { binding: string; envelope: BrokerCredentialEnvelope }>();
  const time = () => { const value = now(); if (!Number.isSafeInteger(value) || value < 0) fail(); return value; };
  function live(expected: ModelCredentialBinding) {
    const currentTime = time();
    if (Date.parse(expected.issuedAt) > currentTime || Date.parse(expected.expiresAt) <= currentTime
      || Date.parse(expected.expiresAt) <= Date.parse(expected.issuedAt)) fail();
  }
  async function recovery(expected: ModelCredentialBinding, budget: Budget) {
    live(expected);
    const observed = Recovery.parse(snapshotInput(await budget(recover)));
    live(expected);
    if (observed.generation !== expected.recoveryGeneration || Date.parse(observed.expiresAt) <= time()) fail();
  }
  async function guarded<T>(expected: ModelCredentialBinding, budget: Budget, operation: () => Promise<T>, discard?: (value: T) => void): Promise<T> {
    await recovery(expected, budget);
    let result: T | undefined, completed = false;
    try {
      result = await budget(operation, discard); completed = true;
      await recovery(expected, budget);
      return result;
    } catch {
      if (completed && discard) discard(result!);
      // Re-observe after a failed asynchronous port too; never use its old state.
      if (!completed) await recovery(expected, budget);
      return fail();
    }
  }
  function aad(expected: ModelCredentialBinding, keyId: string, purpose: 'secret' | 'dek'): Uint8Array<ArrayBuffer> {
    return new TextEncoder().encode(encoded({ profile: 'broker-credential.envelope/v1',
      purpose: `broker-credential.${purpose}/v1`, keyId, binding: expected }));
  }
  function keyRecord(raw: { keyId: string; key: CryptoKey }) {
    const keyId = KeyId.parse(raw.keyId), key = raw.key;
    if (!validKek(key)) fail();
    return { keyId, key };
  }
  return Object.freeze({
    async seal(rawBinding: ModelCredentialBinding, rawKey: Uint8Array): Promise<OpaqueSealedCredential> {
      let secret: Uint8Array<ArrayBuffer> | undefined, dekBytes: Uint8Array<ArrayBuffer> | undefined;
      try {
        const budget = deadline();
        const expected = binding(rawBinding);
        if (!(rawKey instanceof Uint8Array) || rawKey.byteLength < 1 || rawKey.byteLength > MAX_KEY_BYTES) fail();
        // Own copy, before any await; callers retain responsibility for their input.
        secret = new Uint8Array(rawKey);
        if (!validSecret(secret)) fail();
        const kek = keyRecord(await guarded(expected, budget, current));
        dekBytes = crypto.getRandomValues(new Uint8Array(32));
        const nonce = crypto.getRandomValues(new Uint8Array(12)), wrapNonce = crypto.getRandomValues(new Uint8Array(12));
        if (base64url.encode(nonce) === base64url.encode(wrapNonce)) fail();
        const dek = await guarded(expected, budget, () => crypto.subtle.importKey('raw', dekBytes!, 'AES-GCM', false, ['encrypt', 'decrypt']));
        const ciphertext = await guarded(expected, budget, () => crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce,
          additionalData: aad(expected, kek.keyId, 'secret'), tagLength: 128 }, dek, secret!));
        const wrappedDek = await guarded(expected, budget, () => crypto.subtle.encrypt({ name: 'AES-GCM', iv: wrapNonce,
          additionalData: aad(expected, kek.keyId, 'dek'), tagLength: 128 }, kek.key, dekBytes!));
        const latest = keyRecord(await guarded(expected, budget, current));
        if (latest.keyId !== kek.keyId || latest.key !== kek.key) fail();
        const envelope = freezeTree(BrokerCredentialEnvelopeSchema.parse({ profile: 'broker-credential.envelope/v1',
          keyId: kek.keyId, nonce: base64url.encode(nonce), wrapNonce: base64url.encode(wrapNonce),
          ciphertext: base64url.encode(new Uint8Array(ciphertext)), wrappedDek: base64url.encode(new Uint8Array(wrappedDek)) }));
        const handle = Object.freeze(Object.create(null)) as OpaqueSealedCredential;
        minted.set(handle, { binding: encoded(expected), envelope });
        return handle;
      } catch { return fail(); }
      finally { secret?.fill(0); dekBytes?.fill(0); }
    },
    readSealedCredential(handle: OpaqueSealedCredential, rawBinding: ModelCredentialBinding): BrokerCredentialEnvelope {
      try {
        const expected = binding(rawBinding); live(expected);
        const record = minted.get(handle);
        if (!record || record.binding !== encoded(expected)) return fail();
        return record.envelope;
      } catch { return fail(); }
    },
    async open(rawBinding: ModelCredentialBinding, rawEnvelope: BrokerCredentialEnvelope): Promise<Uint8Array> {
      let dekBytes: Uint8Array<ArrayBuffer> | undefined, secret: Uint8Array<ArrayBuffer> | undefined;
      try {
        const budget = deadline();
        const expected = binding(rawBinding);
        const envelope = BrokerCredentialEnvelopeSchema.parse(snapshotInput(rawEnvelope));
        const nonce = decode(envelope.nonce, 12, 12), wrapNonce = decode(envelope.wrapNonce, 12, 12);
        const ciphertext = decode(envelope.ciphertext, 17, MAX_KEY_BYTES + 16), wrapped = decode(envelope.wrappedDek, 48, 48);
        if (envelope.nonce === envelope.wrapNonce) fail();
        const key = await guarded(expected, budget, () => readKey(envelope.keyId));
        if (!key || !validKek(key)) return fail();
        const rawDek = await guarded(expected, budget, () => crypto.subtle.decrypt({ name: 'AES-GCM', iv: wrapNonce,
          additionalData: aad(expected, envelope.keyId, 'dek'), tagLength: 128 }, key, wrapped), value => new Uint8Array(value).fill(0));
        dekBytes = new Uint8Array(rawDek);
        if (dekBytes.byteLength !== 32) fail();
        const dek = await guarded(expected, budget, () => crypto.subtle.importKey('raw', dekBytes!, 'AES-GCM', false, ['decrypt']));
        const rawSecret = await guarded(expected, budget, () => crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce,
          additionalData: aad(expected, envelope.keyId, 'secret'), tagLength: 128 }, dek, ciphertext), value => new Uint8Array(value).fill(0));
        secret = new Uint8Array(rawSecret);
        if (!validSecret(secret)) fail();
        const latestKey = await guarded(expected, budget, () => readKey(envelope.keyId));
        if (!latestKey || latestKey !== key || !validKek(latestKey)) fail();
        // Ownership of this sole remaining plaintext buffer transfers to the
        // trusted broker store; all other copies are zeroed below.
        const result = secret; secret = undefined;
        return result;
      } catch { return fail(); }
      finally { dekBytes?.fill(0); secret?.fill(0); }
    },
  });
}
