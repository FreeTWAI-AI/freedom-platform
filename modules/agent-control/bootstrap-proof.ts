import { base64url, calculateJwkThumbprint, compactVerify, importJWK } from 'jose';
import {
  BOOTSTRAP_LIMITS,
  BootstrapDpopClaimsSchema, BootstrapDpopHeaderSchema,
  BootstrapProofInputSchema, type BootstrapProofHost, type BootstrapProofResult,
} from '../../contracts/execution/v1/bootstrap.js';
import { freezeTree, snapshotInput } from '../../packages/execution-state/decode.js';
import { parseRuntimePublicJwk } from './runtime-proof.js';
import { parseBootstrapCompact } from './strict-jose-json.js';

import { snapshotBootstrapCryptoHost, verifyBootstrapAccessCrypto } from './bootstrap-access-crypto.js';

export class BootstrapProofError extends Error {
  constructor() { super('invalid_bootstrap_configuration'); this.name = 'BootstrapProofError'; }
}
/** Trusted-server convenience factory, NOT a trust source or a machine validator.
 * Host must independently own keys/configuration, current DB-clock/binding and
 * nonce. No remote key refresh, signer, nonce storage or operational API exists. */
export function createBootstrapProofVerifier(configuration: BootstrapProofHost) {
  let host: BootstrapProofHost;
  try {
    host = snapshotBootstrapCryptoHost(configuration);
  } catch { throw new BootstrapProofError(); }

  return Object.freeze({
    /** Success establishes signatures/binding under the supplied host snapshot
     * only. It does NOT check current durable owner/runtime/connection authority,
     * consume the nonce, or prevent replay. Repeated valid proofs can succeed. */
    async verify(raw: unknown): Promise<BootstrapProofResult | null> {
      try {
        // Copy every host-per-call input before the first asynchronous operation.
        const input = BootstrapProofInputSchema.parse(snapshotInput(raw));
        const proof = parseBootstrapCompact(input.proof);
        const proofHeader = BootstrapDpopHeaderSchema.parse(proof.header);
        const proofClaims = BootstrapDpopClaimsSchema.parse(proof.claims);
        const expected = input.expectedBinding, nowSeconds = Math.floor(input.nowMs / 1000);
        if (proofClaims.nonce !== input.expectedNonce || proofClaims.htu !== host.bootstrapUri
          || proofClaims.iat < nowSeconds - BOOTSTRAP_LIMITS.proofPastSeconds
          || proofClaims.iat > nowSeconds + BOOTSTRAP_LIMITS.proofFutureSeconds) return null;
        const access = await verifyBootstrapAccessCrypto(host, input.accessToken, expected, input.nowMs);
        if (!access) return null;
        const { claims } = access;
        const deviceJwk = parseRuntimePublicJwk(proofHeader.jwk);
        const thumbprint = await calculateJwkThumbprint(deviceJwk, 'sha256');
        if (thumbprint !== claims.cnf.jkt) return null;
        const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input.accessToken)));
        if (base64url.encode(hash) !== proofClaims.ath) return null;
        const deviceKey = await importJWK(deviceJwk, 'ES256');
        await compactVerify(input.proof, deviceKey, { algorithms: ['ES256'] });
        // NumericDate uses floor(nowMs/1000). Preserve its exact inclusive
        // second windows as [from,until) milliseconds, including the final
        // accepted second of the proof. BigInt prevents overflow before the
        // intersection with the already-bounded issuer-key interval.
        const from = [0n, access.validFrom,
          (BigInt(proofClaims.iat) - BigInt(BOOTSTRAP_LIMITS.proofFutureSeconds)) * 1000n]
          .reduce((a, b) => a > b ? a : b);
        const until = [access.validUntil,
          (BigInt(proofClaims.iat) + BigInt(BOOTSTRAP_LIMITS.proofPastSeconds) + 1n) * 1000n]
          .reduce((a, b) => a < b ? a : b);
        if (from > BigInt(input.nowMs) || BigInt(input.nowMs) >= until
          || until > BigInt(Number.MAX_SAFE_INTEGER)) return null;
        return freezeTree({ binding: expected, tokenId: claims.jti, proofId: proofClaims.jti,
          issuedAt: claims.iat, expiresAt: claims.exp, nonce: proofClaims.nonce,
          validFromMs: Number(from), validUntilMs: Number(until),
          assurance: 'cryptographic_only' as const, operational_authority: false as const });
      } catch { return null; }
    },
  });
}
