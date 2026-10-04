import { compactVerify, importJWK } from 'jose';
import { BOOTSTRAP_LIMITS, type BootstrapProofHost } from '../../contracts/execution/v1/bootstrap.js';
import { DeviceAuthorizationHostSchema, DevicePairingHeaderSchema, DevicePairingBeginClaimsSchema,
  DevicePairingPollClaimsSchema, DevicePairingBeginProofInputSchema, DevicePairingPollProofInputSchema,
  type DeviceAuthorizationHost, type DevicePairingProofResult } from '../../contracts/execution/v1/device-pairing.js';
import { freezeTree, snapshotInput } from '../../packages/execution-state/decode.js';
import { createBootstrapProofVerifier } from './bootstrap-proof.js';
import { parseRuntimePublicJwk, runtimePublicKeyThumbprint } from './runtime-proof.js';
import { parseBootstrapCompact } from './strict-jose-json.js';

export class DevicePairingProofError extends Error {
  constructor() { super('invalid_device_pairing_configuration'); this.name = 'DevicePairingProofError'; }
}
/** Fixed host snapshot, never a trust source. No URI is fetched. */
export function parseDeviceAuthorizationHost(raw: unknown): DeviceAuthorizationHost {
  try {
    const host = DeviceAuthorizationHostSchema.parse(snapshotInput(raw));
    const { issuerKid, beginUri, pollUri, verificationUri, clientDisplayName: _display, ...bootstrap } = host;
    createBootstrapProofVerifier(bootstrap as BootstrapProofHost);
    for (const rawUri of [beginUri, pollUri, verificationUri]) {
      const uri = new URL(rawUri);
      // This closed profile uses literal ASCII paths: no percent-encoding aliases.
      if (uri.protocol !== 'https:' || uri.username || uri.password || uri.search || uri.hash
        || /[?#%\\\x00-\x20\x7f-\uffff]/.test(rawUri) || uri.href !== rawUri) throw new Error();
    }
    if (beginUri === pollUri || !host.keys.some(key => key.kid === issuerKid)) throw new Error();
    return freezeTree(host);
  } catch { throw new DevicePairingProofError(); }
}

/** Pure key possession/binding evidence. The service must own DB time/binding,
 * original authorization deadline, current identity and atomic JTI consumption. */
export function createDevicePairingProofVerifier(configuration: DeviceAuthorizationHost) {
  const host = parseDeviceAuthorizationHost(configuration);
  async function verify(raw: unknown, poll: boolean): Promise<DevicePairingProofResult | null> {
    try {
      const input = (poll ? DevicePairingPollProofInputSchema : DevicePairingBeginProofInputSchema).parse(snapshotInput(raw));
      const parsed = parseBootstrapCompact(input.proof), header = DevicePairingHeaderSchema.parse(parsed.header);
      const claims = (poll ? DevicePairingPollClaimsSchema : DevicePairingBeginClaimsSchema).parse(parsed.claims);
      if (claims.client_id !== host.clientId || claims.environment !== host.environment
        || claims.runtime_kind !== input.runtimeKind || claims.htu !== (poll ? host.pollUri : host.beginUri)) return null;
      if (poll) {
        const expected = DevicePairingPollProofInputSchema.parse(input), actual = DevicePairingPollClaimsSchema.parse(claims);
        if (actual.authorization_id !== expected.authorizationId || actual.nonce !== expected.nonce
          || actual.device_code_hash !== expected.deviceCodeHash || actual.request_digest !== expected.requestDigest) return null;
      }
      // Exact floor-based [-60,+5] seconds as a safe [from,until) ms interval.
      const from = (BigInt(claims.iat) - BigInt(BOOTSTRAP_LIMITS.proofFutureSeconds)) * 1000n;
      const validFrom = from < 0n ? 0n : from;
      const until = (BigInt(claims.iat) + BigInt(BOOTSTRAP_LIMITS.proofPastSeconds) + 1n) * 1000n;
      if (until > BigInt(Number.MAX_SAFE_INTEGER) || BigInt(input.nowMs) < validFrom || BigInt(input.nowMs) >= until) return null;
      const key = parseRuntimePublicJwk(header.jwk), expectedKey = parseRuntimePublicJwk(input.publicJwk);
      if (key.kty !== expectedKey.kty || key.crv !== expectedKey.crv || key.x !== expectedKey.x || key.y !== expectedKey.y) return null;
      const thumbprint = await runtimePublicKeyThumbprint(key);
      await compactVerify(input.proof, await importJWK(key, 'ES256'), { algorithms: ['ES256'] });
      return freezeTree({ keyThumbprint: thumbprint, proofId: claims.jti, issuedAt: claims.iat,
        validFromMs: Number(validFrom), validUntilMs: Number(until),
        assurance: 'cryptographic_only' as const, operational_authority: false as const });
    } catch { return null; }
  }
  return Object.freeze({ verifyBegin: (raw: unknown) => verify(raw, false), verifyPoll: (raw: unknown) => verify(raw, true) });
}
