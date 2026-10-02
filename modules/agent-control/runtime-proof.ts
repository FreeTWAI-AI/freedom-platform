import { base64url, calculateJwkThumbprint, compactVerify, importJWK } from 'jose';
import {
  RUNTIME_ENROLLMENT_LIMITS, RUNTIME_ENROLLMENT_PROFILE, RUNTIME_ENROLLMENT_PROTECTED_HEADER,
  RUNTIME_ENROLLMENT_TTL_MS, RuntimePublicJwkSchema, RuntimeRegistrationChallengeBindingSchema,
  RuntimeRegistrationChallengeSchema, type RuntimePublicJwk, type RuntimeRegistrationChallenge,
  type RuntimeRegistrationChallengeBinding,
} from '../../contracts/execution/v1/runtime-registration.js';
import { snapshotInput } from '../../packages/execution-state/decode.js';

export class RuntimeProofError extends Error {
  constructor() { super('invalid_runtime_enrollment'); this.name = 'RuntimeProofError'; }
}
const invalid = (): never => { throw new RuntimeProofError(); };
const header = base64url.encode(RUNTIME_ENROLLMENT_PROTECTED_HEADER);

/** Object API only; transport must reject duplicate JSON keys before producing
 * an object. Accessors/toJSON, private key material, and extra fields fail shut. */
export function parseRuntimePublicJwk(input: unknown): RuntimePublicJwk {
  try { return Object.freeze(RuntimePublicJwkSchema.parse(snapshotInput(input))); }
  catch { return invalid(); }
}

/** Import checks that the claimed P-256 coordinates are actually a valid point.
 * This module never accepts, generates, persists, or logs private keys. */
export async function runtimePublicKeyThumbprint(input: unknown): Promise<string> {
  const key = parseRuntimePublicJwk(input);
  try {
    await importJWK(key, 'ES256');
    return await calculateJwkThumbprint(key, 'sha256');
  } catch { return invalid(); }
}

function binding(input: unknown): RuntimeRegistrationChallengeBinding {
  try {
    const value = RuntimeRegistrationChallengeBindingSchema.parse(snapshotInput(input));
    if (new Date(value.issued_at).toISOString() !== value.issued_at
      || new Date(value.expires_at).toISOString() !== value.expires_at) return invalid();
    if (Date.parse(value.expires_at) - Date.parse(value.issued_at) !== RUNTIME_ENROLLMENT_TTL_MS) return invalid();
    return value;
  } catch { return invalid(); }
}

/** Call with server-resolved owner/scope/environment, CSPRNG nonce, and database
 * times. The exact returned payload UTF-8 bytes are signed without reserializing.
 * Field order is part of this closed profile, not a general JCS implementation. */
export function createRuntimeRegistrationChallenge(input: RuntimeRegistrationChallengeBinding): RuntimeRegistrationChallenge {
  const value = binding(input);
  const signed = {
    profile: RUNTIME_ENROLLMENT_PROFILE, purpose: 'runtime_enrollment' as const,
    challenge_id: value.challenge_id, owner_member_id: value.owner_member_id,
    owner_principal_id: value.owner_principal_id, scope_id: value.scope_id,
    runtime_device_id: value.runtime_device_id, environment: value.environment,
    key_thumbprint: value.key_thumbprint, nonce: value.nonce,
    issued_at: value.issued_at, expires_at: value.expires_at, operational_authority: false as const,
  };
  const payload = JSON.stringify(signed);
  if (new TextEncoder().encode(payload).length > RUNTIME_ENROLLMENT_LIMITS.payloadBytes) return invalid();
  return Object.freeze({ ...signed, payload });
}

/** Pure signature check, NOT owner authorization or atomic nonce consumption.
 * This helper establishes neither freshness nor current owner authorization.
 * The caller must resolve current durable identity, locks, status and DB time,
 * and atomically consume the original challenge in its member transaction.
 * All failures are deliberately opaque and never echo submitted key/proof data. */
export async function verifyRuntimeRegistrationProof(input: {
  proof: unknown; challenge: RuntimeRegistrationChallenge; public_jwk: unknown;
}): Promise<boolean> {
  try {
    // Capture caller-owned inputs before the first await. In particular a mutable
    // challenge must not change between signature verification and binding checks.
    const { proof, challenge: rawChallenge, public_jwk: rawKey } = input;
    if (typeof proof !== 'string' || proof.length > RUNTIME_ENROLLMENT_LIMITS.proofBytes) return false;
    if (new TextEncoder().encode(proof).length > RUNTIME_ENROLLMENT_LIMITS.proofBytes) return false;
    const challenge = RuntimeRegistrationChallengeSchema.parse(snapshotInput(rawChallenge));
    const { profile: _profile, purpose: _purpose, operational_authority: _authority, payload, ...fields } = challenge;
    const expected = createRuntimeRegistrationChallenge(fields);
    if (payload !== expected.payload) return false;
    const parts = proof.split('.');
    // Byte-exact protected header/payload comparisons reject duplicate JSON keys,
    // alg/typ substitution, detached/unencoded payloads, extra headers (including
    // jku/x5u/crit), alternate JSON serializations, padding and base64url aliases.
    if (parts.length !== 3 || parts[0] !== header || parts[1] !== base64url.encode(payload)) return false;
    if (!/^[A-Za-z0-9_-]{85}[AQgw]$(?![\s\S])/.test(parts[2])) return false;
    const signature = base64url.decode(parts[2]);
    if (signature.length !== 64 || base64url.encode(signature) !== parts[2]) return false;
    const publicKey = parseRuntimePublicJwk(rawKey);
    if (await calculateJwkThumbprint(publicKey, 'sha256') !== challenge.key_thumbprint) return false;
    const key = await importJWK(publicKey, 'ES256');
    const verified = await compactVerify(proof, key, { algorithms: ['ES256'] });
    return base64url.encode(verified.payload) === parts[1];
  } catch { return false; }
}
