import { base64url, calculateJwkThumbprint, compactVerify, importJWK } from 'jose';
import { BOOTSTRAP_LIMITS } from '../../contracts/execution/v1/bootstrap.js';
import { BootstrapSessionHostSchema, BootstrapRefreshHeaderSchema, BootstrapNonceHeaderSchema,
  BootstrapRefreshClaimsSchema, BootstrapNonceClaimsSchema, BootstrapRefreshProofInputSchema,
  BootstrapNonceProofInputSchema, type BootstrapSessionHost, type BootstrapRefreshProofResult,
  type BootstrapNonceProofResult } from '../../contracts/execution/v1/bootstrap-session.js';
import { freezeTree, snapshotInput } from '../../packages/execution-state/decode.js';
import { snapshotBootstrapCryptoHost, verifyBootstrapAccessCrypto } from './bootstrap-access-crypto.js';
import { parseRuntimePublicJwk } from './runtime-proof.js';
import { parseBootstrapCompact } from './strict-jose-json.js';

export class BootstrapSessionProofError extends Error {
  constructor() { super('invalid_bootstrap_session_configuration'); this.name = 'BootstrapSessionProofError'; }
}
export function parseBootstrapSessionHost(raw: unknown): BootstrapSessionHost {
  try {
    const host = BootstrapSessionHostSchema.parse(snapshotInput(raw));
    const { issuerKid, refreshUri, nonceUri, ...base } = host;
    snapshotBootstrapCryptoHost(base);
    for (const rawUri of [refreshUri, nonceUri]) {
      const uri = new URL(rawUri);
      if (uri.protocol !== 'https:' || uri.username || uri.password || uri.search || uri.hash
        || /[?#%\\\x00-\x20\x7f-\uffff]/.test(rawUri) || uri.href !== rawUri) throw new Error();
    }
    if (new Set([host.bootstrapUri, refreshUri, nonceUri]).size !== 3
      || !host.keys.some(key => key.kid === issuerKid)) throw new Error();
    return freezeTree(host);
  } catch { throw new BootstrapSessionProofError(); }
}
function interval(iat: number, nowMs: number, token?: { validFrom: bigint; validUntil: bigint }) {
  const from = [0n, token?.validFrom ?? 0n,
    (BigInt(iat) - BigInt(BOOTSTRAP_LIMITS.proofFutureSeconds)) * 1000n].reduce((a, b) => a > b ? a : b);
  const proofUntil = (BigInt(iat) + BigInt(BOOTSTRAP_LIMITS.proofPastSeconds) + 1n) * 1000n;
  const until = token && token.validUntil < proofUntil ? token.validUntil : proofUntil;
  if (BigInt(nowMs) < from || BigInt(nowMs) >= until || until > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return { validFromMs: Number(from), validUntilMs: Number(until) };
}
/** Closed purpose verifiers. Supplied host, binding and clock are trusted-server
 * assumptions, not authenticated facts. No DB state or replay ledger is consulted. */
export function createBootstrapSessionProofVerifier(configuration: BootstrapSessionHost) {
  const host = parseBootstrapSessionHost(configuration);
  return Object.freeze({
    async verifyRefresh(raw: unknown): Promise<BootstrapRefreshProofResult | null> {
      try {
        const input = BootstrapRefreshProofInputSchema.parse(snapshotInput(raw));
        const parsed = parseBootstrapCompact(input.proof);
        const header = BootstrapRefreshHeaderSchema.parse(parsed.header), claims = BootstrapRefreshClaimsSchema.parse(parsed.claims);
        if (claims.client_id !== host.clientId || claims.environment !== host.environment || claims.htu !== host.refreshUri
          || claims.connection_id !== input.connectionId || claims.family_id !== input.familyId
          || claims.generation !== input.generation || BigInt(input.generation) > 9223372036854775807n
          || claims.refresh_handle_hash !== input.refreshHandleHash) return null;
        const times = interval(claims.iat, input.nowMs);
        if (!times) return null;
        const key = parseRuntimePublicJwk(header.jwk), expected = parseRuntimePublicJwk(input.publicJwk);
        if (key.x !== expected.x || key.y !== expected.y) return null;
        await compactVerify(input.proof, await importJWK(key, 'ES256'), { algorithms: ['ES256'] });
        return freezeTree({ proofId: claims.jti, ...times, assurance: 'cryptographic_only' as const, operational_authority: false as const });
      } catch { return null; }
    },
    async verifyNonce(raw: unknown): Promise<BootstrapNonceProofResult | null> {
      try {
        const input = BootstrapNonceProofInputSchema.parse(snapshotInput(raw));
        const parsed = parseBootstrapCompact(input.proof);
        const header = BootstrapNonceHeaderSchema.parse(parsed.header), claims = BootstrapNonceClaimsSchema.parse(parsed.claims);
        if (claims.client_id !== host.clientId || claims.environment !== host.environment || claims.htu !== host.nonceUri
          || claims.connection_id !== input.expectedBinding.connectionId) return null;
        const access = await verifyBootstrapAccessCrypto(host, input.accessToken, input.expectedBinding, input.nowMs);
        if (!access) return null;
        const times = interval(claims.iat, input.nowMs, access);
        if (!times) return null;
        const key = parseRuntimePublicJwk(header.jwk);
        if (await calculateJwkThumbprint(key, 'sha256') !== access.claims.cnf.jkt) return null;
        const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input.accessToken)));
        if (claims.ath !== base64url.encode(hash)) return null;
        await compactVerify(input.proof, await importJWK(key, 'ES256'), { algorithms: ['ES256'] });
        return freezeTree({ tokenId: access.claims.jti, proofId: claims.jti, ...times,
          assurance: 'cryptographic_only' as const, operational_authority: false as const });
      } catch { return null; }
    },
  });
}
