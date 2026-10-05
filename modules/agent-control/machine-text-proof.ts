import { base64url, calculateJwkThumbprint, compactVerify, importJWK, CompactSign } from 'jose';
import { createHash } from 'node:crypto';
import { MachineTextHostSchema, MachineTextProofHeaderSchema, MachineTextDeviceProofSchema,
  MachineTextAccessProofSchema, MachineTextAccessHeaderSchema, MachineTextAccessClaimsSchema,
  MachineTextDeviceBindingSchema, MachineTextBindingSchema, MachineTextLimits,
  type MachineTextHost, type MachineTextDeviceBinding, type MachineTextBinding,
  type MachineTextOperation, type MachineTextClaims } from '../../contracts/execution/v3/machine-text-execution.js';
import { snapshotInput, freezeTree } from '../../packages/execution-state/decode.js';
import { parseRuntimePublicJwk } from './runtime-proof.js';
import { parseBootstrapCompact } from './strict-jose-json.js';

export const machineTextHash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const canonical = (raw: string) => {
  const u = new URL(raw);
  return u.protocol === 'https:' && !u.username && !u.password && !u.search && !u.hash
    && !/[?#%\\\x00-\x20\x7f-\uffff]/.test(raw) && u.href === raw;
};
export function parseMachineTextHost(raw: unknown): MachineTextHost {
  try {
    const host = MachineTextHostSchema.parse(snapshotInput(raw));
    if (!canonical(host.origin + '/') || new URL(host.origin).origin !== host.origin
      || !canonical(host.issuer) || !canonical(host.audience)
      || host.audience !== host.origin + '/execution-api/v1/model-steps'
      || new Set(host.keys.map(k => k.kid)).size !== host.keys.length
      || !host.keys.some(k => k.kid === host.issuerKid)
      || host.keys.some(k => k.environment !== host.environment || k.notBeforeMs >= k.notAfterMs)) throw new Error();
    return freezeTree(host);
  } catch { throw new Error('invalid_machine_text_configuration'); }
}
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function times(iat: number, nowMs: number, from = 0, until = Number.MAX_SAFE_INTEGER) {
  const lower = Math.max(from, (iat - MachineTextLimits.proofFutureSeconds) * 1000);
  const upper = Math.min(until, (iat + MachineTextLimits.proofPastSeconds + 1) * 1000);
  if (!Number.isSafeInteger(nowMs) || nowMs < lower || nowMs >= upper) return null;
  return { validFromMs: lower, validUntilMs: upper };
}
function validVersions(binding: MachineTextDeviceBinding | MachineTextBinding) {
  return Object.entries(binding).every(([key, value]) => !key.endsWith('Version')
    && key !== 'recoveryGeneration' || BigInt(value) <= 9223372036854775807n);
}
export function machineTextRequestHash(method: string, path: string, body: Uint8Array,
  key: string | null, version: string | null): string {
  // Exact-byte body identity, distinct from existing member command digests.
  return machineTextHash(JSON.stringify(['freedom.machine-text.request/v1', method, path,
    machineTextHash(body), key, version]));
}
/** Cryptographic checks under trusted host/binding/clock assumptions only.
 * SQL current-authority, challenge/JTI consumption and domain checks are mandatory. */
export function createMachineTextProofVerifier(rawHost: MachineTextHost) {
  const host = parseMachineTextHost(rawHost);
  return Object.freeze({
    async device(input: { proof: string; purpose: 'challenge' | 'activate'; binding: MachineTextDeviceBinding;
      requestSha256: string; nowMs: number; challengeId?: string; nonce?: string }) {
      try {
        const binding = MachineTextDeviceBindingSchema.parse(snapshotInput(input.binding));
        if (!validVersions(binding)) return null;
        const parsed = parseBootstrapCompact(input.proof), header = MachineTextProofHeaderSchema.parse(parsed.header);
        const proof = MachineTextDeviceProofSchema.parse(parsed.claims);
        const expectedUri = host.audience + (input.purpose === 'challenge' ? '/challenge' : '');
        if (proof.purpose !== `machine_text.${input.purpose}` || proof.htu !== expectedUri
          || proof.environment !== host.environment || proof.client_id !== host.clientId
          || proof.connection_id !== binding.connectionId || proof.family_id !== binding.familyId
          || proof.request_sha256 !== input.requestSha256) return null;
        if (proof.purpose === 'machine_text.activate' && (proof.challenge_id !== input.challengeId || proof.nonce !== input.nonce)) return null;
        const key = parseRuntimePublicJwk(header.jwk);
        if (await calculateJwkThumbprint(key, 'sha256') !== binding.keyThumbprint) return null;
        const interval = times(proof.iat, input.nowMs); if (!interval) return null;
        await compactVerify(input.proof, await importJWK(key, 'ES256'), { algorithms: ['ES256'] });
        return freezeTree({ proofId: proof.jti, ...interval, assurance: 'cryptographic_only' as const });
      } catch { return null; }
    },
    async access(input: { accessToken: string; proof: string; operation: MachineTextOperation;
      binding: MachineTextBinding; requestSha256: string; nowMs: number }) {
      try {
        const binding = MachineTextBindingSchema.parse(snapshotInput(input.binding));
        if (!validVersions(binding)) return null;
        const access = parseBootstrapCompact(input.accessToken), header = MachineTextAccessHeaderSchema.parse(access.header);
        const claims = MachineTextAccessClaimsSchema.parse(access.claims), key = host.keys.find(k => k.kid === header.kid);
        const evidence = input.operation === 'evidence', seconds = Math.floor(input.nowMs / 1000);
        if (!key || key.revoked || input.nowMs < key.notBeforeMs || input.nowMs >= key.notAfterMs
          || claims.iss !== host.issuer || claims.aud !== host.audience || claims.environment !== host.environment
          || claims.client_id !== host.clientId || claims.sub !== binding.principalId
          || claims.cnf.jkt !== binding.keyThumbprint || !equal(claims.binding, binding)
          || claims.purpose !== (evidence ? 'machine_text.evidence' : 'machine_text.execute')
          || claims.scope !== (evidence ? 'model.dispatch.evidence' : 'model.private-draft')
          || claims.iat > seconds || claims.exp <= seconds || claims.exp <= claims.iat
          || claims.exp - claims.iat > (evidence ? MachineTextLimits.evidenceSeconds : MachineTextLimits.accessSeconds)
          || claims.iat * 1000 < key.notBeforeMs || claims.exp * 1000 > key.notAfterMs) return null;
        await compactVerify(input.accessToken, await importJWK(parseRuntimePublicJwk(key.publicJwk), 'ES256'), { algorithms: ['ES256'] });
        const parsed = parseBootstrapCompact(input.proof), dpopHeader = MachineTextProofHeaderSchema.parse(parsed.header);
        const proof = MachineTextAccessProofSchema.parse(parsed.claims);
        const uri = `${host.audience}/${binding.stepId}${input.operation === 'status' ? '' : '/' + input.operation}`;
        if (proof.htu !== uri || proof.htm !== (input.operation === 'status' ? 'GET' : 'POST')
          || proof.environment !== host.environment || proof.client_id !== host.clientId
          || proof.connection_id !== binding.connectionId || proof.family_id !== binding.familyId
          || proof.request_sha256 !== input.requestSha256
          || proof.ath !== base64url.encode(createHash('sha256').update(input.accessToken).digest())) return null;
        const dpopKey = parseRuntimePublicJwk(dpopHeader.jwk);
        if (await calculateJwkThumbprint(dpopKey, 'sha256') !== binding.keyThumbprint) return null;
        const interval = times(proof.iat, input.nowMs, Math.max(key.notBeforeMs, claims.iat * 1000), Math.min(key.notAfterMs, claims.exp * 1000));
        if (!interval) return null;
        await compactVerify(input.proof, await importJWK(dpopKey, 'ES256'), { algorithms: ['ES256'] });
        return freezeTree({ tokenId: claims.jti, proofId: proof.jti, ...interval, assurance: 'cryptographic_only' as const });
      } catch { return null; }
    },
  });
}

/** Trusted issuer primitive only; callers derive claims from current SQL and
 * deliver once after commit. It does not issue an authorization by itself. */
export async function signMachineTextAccess(rawHost: MachineTextHost, signingKey: CryptoKey, raw: MachineTextClaims): Promise<string> {
  const host = parseMachineTextHost(rawHost), claims = MachineTextAccessClaimsSchema.parse(snapshotInput(raw));
  if (claims.iss !== host.issuer || claims.aud !== host.audience || claims.environment !== host.environment
    || claims.client_id !== host.clientId) throw new Error('invalid_machine_text_configuration');
  const token = await new CompactSign(new TextEncoder().encode(JSON.stringify(claims)))
    .setProtectedHeader({ alg: 'ES256', typ: 'freedom-execution-text+jwt', kid: host.issuerKid }).sign(signingKey);
  if (token.length > MachineTextLimits.compactBytes) throw new Error('invalid_machine_text_configuration');
  const key = host.keys.find(k => k.kid === host.issuerKid)!;
  await compactVerify(token, await importJWK(parseRuntimePublicJwk(key.publicJwk), 'ES256'), { algorithms: ['ES256'] });
  return token;
}
