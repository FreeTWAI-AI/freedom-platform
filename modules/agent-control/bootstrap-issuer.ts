import { base64url, CompactSign, compactVerify, importJWK } from 'jose';
import { BOOTSTRAP_LIMITS, BOOTSTRAP_TYP, BootstrapAccessClaimsSchema, BootstrapAccessHeaderSchema,
  BootstrapProofHostSchema, type BootstrapProofHost } from '../../contracts/execution/v1/bootstrap.js';
import { BootstrapTokenIssueInputSchema, type BootstrapTokenIssueResult } from '../../contracts/execution/v1/device-pairing.js';
import { freezeTree, snapshotInput } from '../../packages/execution-state/decode.js';
import { createBootstrapProofVerifier } from './bootstrap-proof.js';
import { parseRuntimePublicJwk } from './runtime-proof.js';
import { parseBootstrapCompact } from './strict-jose-json.js';

export class BootstrapIssuerError extends Error {
  constructor() { super('invalid_bootstrap_issuer_configuration'); this.name = 'BootstrapIssuerError'; }
}
export interface BootstrapTokenIssuerConfiguration { host: BootstrapProofHost; kid: string; signingKey: CryptoKey }

/** Host-only constrained signer, not current DB authorization. No private JWK,
 * secret lookup, network, general signing API, or caller signing callback. */
export async function createBootstrapTokenIssuer(configuration: BootstrapTokenIssuerConfiguration) {
  let host: BootstrapProofHost, kid: string, signingKey: CryptoKey, publicKey: CryptoKey;
  try {
    // Snapshot JSON fields without invoking getters or trying to serialize the
    // opaque native key. Capture all inputs before the first asynchronous call.
    if (!configuration || Object.getPrototypeOf(configuration) !== Object.prototype
      || Reflect.ownKeys(configuration).sort().join(',') !== 'host,kid,signingKey') throw new Error();
    const descriptors = Object.getOwnPropertyDescriptors(configuration);
    if (Object.values(descriptors).some(d => !d.enumerable || !('value' in d))) throw new Error();
    host = freezeTree(BootstrapProofHostSchema.parse(snapshotInput(descriptors.host.value)));
    kid = BootstrapAccessHeaderSchema.shape.kid.parse(descriptors.kid.value);
    signingKey = descriptors.signingKey.value!;
    createBootstrapProofVerifier(host);
    const ownKeyFields = Reflect.ownKeys(signingKey);
    const nativeGetters = Object.getOwnPropertyDescriptor(CryptoKey.prototype, 'extractable')?.get;
    const workerMetadata = ['algorithm', 'extractable', 'type', 'usages'];
    if (!(signingKey instanceof CryptoKey)
      || (nativeGetters ? ownKeyFields.length !== 0 : ownKeyFields.length !== 4
        || ownKeyFields.some(field => typeof field !== 'string' || !workerMetadata.includes(field))
        || Object.values(Object.getOwnPropertyDescriptors(signingKey)).some(d => !('value' in d) || d.writable || !d.enumerable))
      || signingKey.type !== 'private' || signingKey.extractable) throw new Error();
    const algorithm = snapshotInput(signingKey.algorithm) as {name?: unknown; namedCurve?: unknown};
    const usages = snapshotInput(signingKey.usages) as unknown[];
    if (Object.keys(algorithm).sort().join(',') !== 'name,namedCurve'
      || algorithm.name !== 'ECDSA' || algorithm.namedCurve !== 'P-256'
      || usages.length !== 1 || usages[0] !== 'sign') throw new Error();
    // Native Worker metadata is own data, and may be shadowed even on a genuine
    // handle. Verify nonextractability through a native operation as well.
    let exported: ArrayBuffer | undefined;
    try { exported = await crypto.subtle.exportKey('pkcs8', signingKey); } catch { /* Required native refusal. */ }
    if (exported) { new Uint8Array(exported).fill(0); throw new Error(); }
    const descriptor = host.keys.find(key => key.kid === kid);
    if (!descriptor || descriptor.revoked) throw new Error();
    publicKey = await importJWK(parseRuntimePublicJwk(descriptor.publicJwk), 'ES256') as CryptoKey;
    // A genuine sign/verify establishes that the opaque handle matches exactly
    // this descriptor. The random probe is not an access JWT or reusable proof.
    const probe = crypto.getRandomValues(new Uint8Array(32));
    const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, signingKey, probe);
    if (!await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, publicKey, signature, probe)) throw new Error();
  } catch { throw new BootstrapIssuerError(); }
  const descriptor = host.keys.find(key => key.kid === kid)!;
  const header = freezeTree({ alg: 'ES256' as const, typ: BOOTSTRAP_TYP, kid });
  return Object.freeze({
    async issue(raw: unknown): Promise<BootstrapTokenIssueResult | null> {
      try {
        const input = BootstrapTokenIssueInputSchema.parse(snapshotInput(raw)), binding = input.binding;
        if (BigInt(binding.connectionVersion) > 9223372036854775807n || input.nowMs < descriptor.notBeforeMs
          || input.nowMs >= descriptor.notAfterMs || input.nowMs >= input.notAfterMs) return null;
        const iat = Math.floor(input.nowMs / 1000);
        const exp = Math.min(iat + BOOTSTRAP_LIMITS.lifetimeSeconds, Math.floor(input.notAfterMs / 1000), Math.floor(descriptor.notAfterMs / 1000));
        if (exp <= iat || BigInt(iat) * 1000n < BigInt(descriptor.notBeforeMs)) return null;
        const jti = base64url.encode(crypto.getRandomValues(new Uint8Array(32)));
        const claims = BootstrapAccessClaimsSchema.parse({ iss: host.issuer, aud: host.audience, sub: binding.principalId,
          owner_user_id: binding.ownerUserId, scope_id: binding.scopeId, runtime_device_id: binding.runtimeDeviceId,
          connection_id: binding.connectionId, connection_version: binding.connectionVersion, client_id: host.clientId,
          environment: host.environment, purpose: 'bootstrap_access', scope: 'bootstrap.status.read', cnf: { jkt: binding.keyThumbprint }, iat, exp, jti });
        const payload = new TextEncoder().encode(JSON.stringify(claims));
        const accessToken = await new CompactSign(payload).setProtectedHeader(header).sign(signingKey);
        const verified = await compactVerify(accessToken, publicKey, { algorithms: ['ES256'] });
        const parsed = parseBootstrapCompact(accessToken);
        if (JSON.stringify(BootstrapAccessHeaderSchema.parse(parsed.header)) !== JSON.stringify(header)
          || JSON.stringify(BootstrapAccessClaimsSchema.parse(parsed.claims)) !== JSON.stringify(claims)
          || base64url.encode(verified.payload) !== base64url.encode(payload)) return null;
        return freezeTree({ accessToken, tokenId: jti, issuedAt: iat, expiresAt: exp,
          validFromMs: iat * 1000, validUntilMs: exp * 1000, operational_authority: false as const });
      } catch { return null; }
    },
  });
}
