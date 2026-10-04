import { base64url, compactVerify } from 'jose';
import { z } from 'zod';
import { RuntimeEnvironmentSchema } from '../../../contracts/execution/v1/runtime-registration.js';
import { SignedCredentialRecoveryHeaderSchema as Header, SignedCredentialRecoveryStateSchema as State,
  CredentialRecoveryFloorSchema as Floor } from '../../../contracts/execution/v2/model-credential.js';
import { freezeTree, parseBoundedJson, snapshotInput } from '../../../packages/execution-state/decode.js';

export interface CredentialRecoveryObservation { generation: string; expiresAt: string }
export interface SignedRecoverySourceOptions {
  readSignedState(): Promise<string>;
  /** Trusted separately persisted monotonic source, never a PostgreSQL/R2 snapshot
   * or this process's memo. Its current generation must equal the signed state. */
  readMonotonicFloor(): Promise<CredentialRecoveryObservation>;
  pinnedKeys: readonly { keyId: string; key: CryptoKey }[];
  authority: string;
  environment: z.infer<typeof RuntimeEnvironmentSchema>;
  now?: () => number;
}
export class CredentialRecoveryError extends Error {
  constructor() { super('credential_recovery_unavailable'); this.name = 'CredentialRecoveryError'; }
}
const fail = (): never => { throw new CredentialRecoveryError(); };
const Label = Header.shape.kid;
const limits = Object.freeze({ compact: 4096, header: 512, payload: 2048, lifetime: 300_000, io: 3000 });

function segment(raw: string, max: number): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$(?![\s\S])/.test(raw) || raw.length > Math.ceil(max * 4 / 3)) fail();
  const value = base64url.decode(raw);
  if (value.byteLength > max || base64url.encode(value) !== raw) fail();
  return value;
}
function json(value: Uint8Array): unknown {
  return parseBoundedJson(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(value));
}
function publicKey(key: CryptoKey): boolean {
  return key instanceof CryptoKey && key.type === 'public' && key.algorithm.name === 'Ed25519'
    && key.usages.length === 1 && key.usages[0] === 'verify';
}

/** A broker-only verifier. Every recover() reads both external sources afresh.
 * Memo is an additional regression fence; a fresh process still rejects an old
 * signed snapshot using the separately persisted, injected external floor. */
export function createSignedRecoverySource(options: SignedRecoverySourceOptions): { recover(): Promise<CredentialRecoveryObservation> } {
  let readState: SignedRecoverySourceOptions['readSignedState'], readFloor: SignedRecoverySourceOptions['readMonotonicFloor'];
  let now: () => number, authority: string, environment: SignedRecoverySourceOptions['environment'];
  const keys = new Map<string, CryptoKey>();
  try {
    readState = options.readSignedState.bind(options); readFloor = options.readMonotonicFloor.bind(options);
    now = options.now ?? Date.now;
    authority = Label.parse(options.authority); environment = RuntimeEnvironmentSchema.parse(options.environment);
    if (typeof now !== 'function' || !Array.isArray(options.pinnedKeys) || options.pinnedKeys.length < 1 || options.pinnedKeys.length > 16) fail();
    for (const entry of options.pinnedKeys) {
      const id = Label.parse(entry.keyId);
      if (keys.has(id) || !publicKey(entry.key)) fail();
      keys.set(id, entry.key);
    }
  } catch { return fail(); }
  let highWater: bigint | undefined;
  const time = () => { const value = now(); if (!Number.isSafeInteger(value) || value < 0) fail(); return value; };
  async function bounded<T>(end: number, operation: () => Promise<T>): Promise<T> {
    const started = time(), remaining = end - performance.now(); let timer: ReturnType<typeof setTimeout> | undefined;
    if (remaining <= 0) return fail();
    try {
      const result = await Promise.race([operation(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new CredentialRecoveryError()), remaining);
      })]);
      if (time() - started >= limits.io || performance.now() >= end) fail();
      return result;
    } finally { if (timer !== undefined) clearTimeout(timer); }
  }
  function floor(raw: unknown): z.infer<typeof Floor> {
    const parsed = Floor.parse(snapshotInput(raw));
    if (Date.parse(parsed.expiresAt) <= time() || highWater !== undefined && BigInt(parsed.generation) < highWater) fail();
    return parsed;
  }
  return Object.freeze({ async recover() {
    try {
      const end = performance.now() + limits.io;
      const before = floor(await bounded(end, readFloor));
      const raw = await bounded(end, readState);
      if (typeof raw !== 'string' || raw.length > limits.compact) fail();
      const parts = raw.split('.'); if (parts.length !== 3) fail();
      const header = Header.parse(json(segment(parts[0], limits.header)));
      const state = State.parse(json(segment(parts[1], limits.payload)));
      if (segment(parts[2], 64).byteLength !== 64) fail();
      const key = keys.get(header.kid); if (!key) return fail();
      await bounded(end, () => compactVerify(raw, key, { algorithms: ['EdDSA'] }));
      const after = floor(await bounded(end, readFloor));
      const currentTime = time(), issued = Date.parse(state.issuedAt), expires = Date.parse(state.expiresAt);
      if (state.authority !== authority || state.environment !== environment || issued > currentTime || expires <= currentTime
        || expires <= issued || expires - issued > limits.lifetime || before.generation !== state.generation
        || after.generation !== state.generation || highWater !== undefined && BigInt(state.generation) < highWater
        || Date.parse(before.expiresAt) <= currentTime || Date.parse(after.expiresAt) <= currentTime) fail();
      highWater = BigInt(state.generation);
      return freezeTree({ generation: state.generation, expiresAt: new Date(Math.min(expires,
        Date.parse(before.expiresAt), Date.parse(after.expiresAt))).toISOString() });
    } catch { return fail(); }
  } });
}
