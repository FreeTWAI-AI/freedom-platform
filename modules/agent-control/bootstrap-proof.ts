import { base64url, calculateJwkThumbprint, compactVerify, importJWK } from 'jose';
import {
  BOOTSTRAP_LIMITS, BootstrapAccessClaimsSchema, BootstrapAccessHeaderSchema,
  BootstrapDpopClaimsSchema, BootstrapDpopHeaderSchema, BootstrapProofHostSchema,
  BootstrapProofInputSchema, type BootstrapProofHost, type BootstrapProofResult,
} from '../../contracts/execution/v1/bootstrap.js';
import { freezeTree, snapshotInput } from '../../packages/execution-state/decode.js';
import { parseRuntimePublicJwk } from './runtime-proof.js';
import { parseBootstrapCompact } from './strict-jose-json.js';

export class BootstrapProofError extends Error {
  constructor() { super('invalid_bootstrap_configuration'); this.name = 'BootstrapProofError'; }
}
function canonicalHttps(raw: string): boolean {
  try {
    const uri = new URL(raw);
    return uri.protocol === 'https:' && !uri.username && !uri.password && !uri.search && !uri.hash
      && !raw.includes('?') && !raw.includes('#') && uri.href === raw;
  } catch { return false; }
}
const validVersion = (value: string) => BigInt(value) <= 9223372036854775807n;

/** Trusted-server convenience factory, NOT a trust source or a machine validator.
 * Host must independently own keys/configuration, current DB-clock/binding and
 * nonce. No remote key refresh, signer, nonce storage or operational API exists. */
export function createBootstrapProofVerifier(configuration: BootstrapProofHost) {
  let host: BootstrapProofHost;
  try {
    host = freezeTree(BootstrapProofHostSchema.parse(snapshotInput(configuration)));
    if (![host.issuer, host.audience, host.bootstrapUri].every(canonicalHttps)
      || new URL(host.bootstrapUri).pathname !== '/execution-api/v1/bootstrap'
      || new Set(host.keys.map(key => key.kid)).size !== host.keys.length
      || host.keys.some(key => key.environment !== host.environment || key.notAfterMs <= key.notBeforeMs)) throw new Error();
  } catch { throw new BootstrapProofError(); }

  return Object.freeze({
    /** Success establishes signatures/binding under the supplied host snapshot
     * only. It does NOT check current durable owner/runtime/connection authority,
     * consume the nonce, or prevent replay. Repeated valid proofs can succeed. */
    async verify(raw: unknown): Promise<BootstrapProofResult | null> {
      try {
        // Copy every host-per-call input before the first asynchronous operation.
        const input = BootstrapProofInputSchema.parse(snapshotInput(raw));
        const access = parseBootstrapCompact(input.accessToken), proof = parseBootstrapCompact(input.proof);
        const header = BootstrapAccessHeaderSchema.parse(access.header);
        const claims = BootstrapAccessClaimsSchema.parse(access.claims);
        const proofHeader = BootstrapDpopHeaderSchema.parse(proof.header);
        const proofClaims = BootstrapDpopClaimsSchema.parse(proof.claims);
        const expected = input.expectedBinding, key = host.keys.find(key => key.kid === header.kid);
        const nowSeconds = Math.floor(input.nowMs / 1000);
        if (!key || key.revoked || input.nowMs < key.notBeforeMs || input.nowMs >= key.notAfterMs
          || BigInt(claims.iat) * 1000n < BigInt(key.notBeforeMs) || BigInt(claims.exp) * 1000n > BigInt(key.notAfterMs)
          || claims.iat > nowSeconds || claims.exp <= nowSeconds || claims.exp <= claims.iat
          || claims.exp - claims.iat > BOOTSTRAP_LIMITS.lifetimeSeconds
          || claims.iss !== host.issuer || claims.aud !== host.audience || claims.client_id !== host.clientId
          || claims.environment !== host.environment || !validVersion(claims.connection_version)
          || !validVersion(expected.connectionVersion)
          || claims.sub !== expected.principalId || claims.owner_user_id !== expected.ownerUserId
          || claims.scope_id !== expected.scopeId || claims.runtime_device_id !== expected.runtimeDeviceId
          || claims.connection_id !== expected.connectionId || claims.connection_version !== expected.connectionVersion
          || claims.cnf.jkt !== expected.keyThumbprint || proofClaims.nonce !== input.expectedNonce
          || proofClaims.htu !== host.bootstrapUri || proofClaims.iat < nowSeconds - BOOTSTRAP_LIMITS.proofPastSeconds
          || proofClaims.iat > nowSeconds + BOOTSTRAP_LIMITS.proofFutureSeconds) return null;
        const deviceJwk = parseRuntimePublicJwk(proofHeader.jwk);
        const issuerJwk = parseRuntimePublicJwk(key.publicJwk);
        const thumbprint = await calculateJwkThumbprint(deviceJwk, 'sha256');
        if (thumbprint !== claims.cnf.jkt) return null;
        const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input.accessToken)));
        if (base64url.encode(hash) !== proofClaims.ath) return null;
        const issuerKey = await importJWK(issuerJwk, 'ES256'), deviceKey = await importJWK(deviceJwk, 'ES256');
        await compactVerify(input.accessToken, issuerKey, { algorithms: ['ES256'] });
        await compactVerify(input.proof, deviceKey, { algorithms: ['ES256'] });
        return freezeTree({ binding: expected, tokenId: claims.jti, proofId: proofClaims.jti,
          issuedAt: claims.iat, expiresAt: claims.exp, nonce: proofClaims.nonce,
          assurance: 'cryptographic_only' as const, operational_authority: false as const });
      } catch { return null; }
    },
  });
}
