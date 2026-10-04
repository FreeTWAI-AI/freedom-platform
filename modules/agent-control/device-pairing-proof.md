# Device pairing cryptography and constrained bootstrap issuer

These helpers implement the closed cryptographic profile in
[specification 10](../../docs/platform-plan/execution/unified-foundation/10-device-authorization.md).
They do not read DB authority, consume codes/JTIs, approve a member, or supply
production keys. Runtime kind is request metadata, not build attestation.

`createDevicePairingProofVerifier(host)` snapshots the extended host and returns
`verifyBegin({proof,publicJwk,runtimeKind,nowMs})` and
`verifyPoll({proof,publicJwk,runtimeKind,authorizationId,nonce,deviceCodeHash,requestDigest,nowMs})`.
The host extends the existing bootstrap host with `issuerKid`, `beginUri`,
`pollUri`, `verificationUri` and `clientDisplayName`. Pairing endpoints use exact
canonical HTTPS ASCII URIs without credentials, query, fragment or percent
encoding; begin and poll differ. `parseDeviceAuthorizationHost` exports the same
frozen validation for the authoritative service. It is not trust discovery.

Both signatures use ES256 and `freedom-device-pairing+jwt`, distinct from both
runtime enrollment and resource DPoP. The public key must equal the supplied
begin request key or stored poll key, and be a valid P-256 point. Begin claims
bind host client/environment/scope/URI and the request runtime kind. Poll adds
authorization ID, nonce, exact device-code SHA-256 hash and the reviewed request
digest. The latter two are `device_code_hash` and `request_digest` on the wire;
neither is called standard DPoP `ath`. No raw code is accepted by this helper.

The existing bounded compact/JSON decoder rejects duplicate decoded keys,
unknown/private JOSE fields, invalid UTF-8, noncanonical base64url, wrong-size
signatures and non-integer numeric lexemes. Inputs are copied before awaits;
getters, toJSON and extra fields fail shut. Real `jose`/WebCrypto verification
is mandatory, with no injected verifier or network key lookup.

Success returns only `{keyThumbprint,proofId,issuedAt,validFromMs,validUntilMs,
assurance:'cryptographic_only',operational_authority:false}`. For signed `iat`,
the exact accepted interval is `[max(0,(iat-5)*1000),(iat+61)*1000)`. BigInt
arithmetic rejects overflow before conversion to safe integers. The service
must intersect this with its original authorization deadline and recheck a fresh
DB clock after awaits/last blocking queries. Repeating the proof, including its
valid high-S/low-S equivalent, can succeed here; only the DB ledger prevents
replay. Begin evidence does not require an already registered runtime. Fresh
enrollment still requires its separate genuine 087 challenge proof.

`await createBootstrapTokenIssuer({host,kid,signingKey})` accepts the **base**
bootstrap host, without pairing-only properties. The private key must be an
actual nonextractable P-256 WebCrypto handle with only `sign` usage. No JSON
private JWK, callbacks, environment secret discovery, or arbitrary signing API
exists. Startup signs random bytes and verifies with the configured purpose-
bound public descriptor, proving the key pair matches. This diagnostic is not
an access token. Unknown/revoked/wrong-purpose keys or malformed configuration
throw only a fixed `BootstrapIssuerError`.

`issue({binding,nowMs,notAfterMs})` snapshots the host-resolved binding/clock and
connection expiry, creates a fresh CSPRNG JTI and signs only the existing
`freedom-bootstrap+jwt` claims for `bootstrap.status.read`. `iat` is floor DB
seconds; `exp` is the minimum of `iat+600`, floored connection expiry and floored
key expiry. Empty intervals, current/key expiry and whole-token/key interval
mismatch fail closed. The token is verified back against the fixed public key,
exact header and claims before returning. Output contains `accessToken,tokenId,
issuedAt,expiresAt,validFromMs,validUntilMs,operational_authority:false`; issued/
expiry values are seconds, interval endpoints milliseconds. Invalid input or
signing/verification failure returns null without submitted material.

Signing alone is not DB authorization or a one-time exchange. The authoritative
service must keep current-state locks, recheck clock/authority after signing,
commit consumption and only then release the sensitive token. It must never
persist tokens or raw proofs in generic receipts, journal, outbox or logs.
Factory reconstruction is required to update a pinned key descriptor. Nothing
here configures production custody, mounts HTTP, refreshes tokens or permits
execution. Tests use ephemeral keys and actual signatures, not production trust.
