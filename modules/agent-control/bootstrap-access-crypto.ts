// Server-internal shared token checks, not an admission API or trust source.
import { compactVerify, importJWK } from 'jose';
import { BOOTSTRAP_LIMITS, BootstrapAccessClaimsSchema, BootstrapAccessHeaderSchema,
  BootstrapProofHostSchema, type BootstrapBinding, type BootstrapProofHost } from '../../contracts/execution/v1/bootstrap.js';
import { freezeTree, snapshotInput } from '../../packages/execution-state/decode.js';
import { parseRuntimePublicJwk } from './runtime-proof.js';
import { parseBootstrapCompact } from './strict-jose-json.js';

function canonicalHttps(raw: string): boolean {
  try {
    const uri = new URL(raw);
    return uri.protocol === 'https:' && !uri.username && !uri.password && !uri.search && !uri.hash
      && !raw.includes('?') && !raw.includes('#') && uri.href === raw;
  } catch { return false; }
}
export function snapshotBootstrapCryptoHost(raw: unknown): BootstrapProofHost {
  const host = freezeTree(BootstrapProofHostSchema.parse(snapshotInput(raw)));
  if (![host.issuer, host.audience, host.bootstrapUri].every(canonicalHttps)
    || new URL(host.bootstrapUri).pathname !== '/execution-api/v1/bootstrap'
    || new Set(host.keys.map(key => key.kid)).size !== host.keys.length
    || host.keys.some(key => key.environment !== host.environment || key.notAfterMs <= key.notBeforeMs)) throw new Error();
  return host;
}
const validVersion = (value: string) => BigInt(value) <= 9223372036854775807n;
export async function verifyBootstrapAccessCrypto(host: BootstrapProofHost, accessToken: string,
  expected: BootstrapBinding, nowMs: number) {
  const access = parseBootstrapCompact(accessToken);
  const header = BootstrapAccessHeaderSchema.parse(access.header);
  const claims = BootstrapAccessClaimsSchema.parse(access.claims);
  const key = host.keys.find(key => key.kid === header.kid), nowSeconds = Math.floor(nowMs / 1000);
  if (!key || key.revoked || nowMs < key.notBeforeMs || nowMs >= key.notAfterMs
    || BigInt(claims.iat) * 1000n < BigInt(key.notBeforeMs) || BigInt(claims.exp) * 1000n > BigInt(key.notAfterMs)
    || claims.iat > nowSeconds || claims.exp <= nowSeconds || claims.exp <= claims.iat
    || claims.exp - claims.iat > BOOTSTRAP_LIMITS.lifetimeSeconds
    || claims.iss !== host.issuer || claims.aud !== host.audience || claims.client_id !== host.clientId
    || claims.environment !== host.environment || !validVersion(claims.connection_version)
    || !validVersion(expected.connectionVersion)
    || claims.sub !== expected.principalId || claims.owner_user_id !== expected.ownerUserId
    || claims.scope_id !== expected.scopeId || claims.runtime_device_id !== expected.runtimeDeviceId
    || claims.connection_id !== expected.connectionId || claims.connection_version !== expected.connectionVersion
    || claims.cnf.jkt !== expected.keyThumbprint) return null;
  await compactVerify(accessToken, await importJWK(parseRuntimePublicJwk(key.publicJwk), 'ES256'), { algorithms: ['ES256'] });
  return { claims, validFrom: BigInt(key.notBeforeMs) > BigInt(claims.iat) * 1000n
    ? BigInt(key.notBeforeMs) : BigInt(claims.iat) * 1000n,
  validUntil: BigInt(key.notAfterMs) < BigInt(claims.exp) * 1000n
    ? BigInt(key.notAfterMs) : BigInt(claims.exp) * 1000n };
}
