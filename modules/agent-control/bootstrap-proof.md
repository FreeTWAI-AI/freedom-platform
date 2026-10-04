# Closed bootstrap signature evidence

`createBootstrapProofVerifier(host).verify(input)` checks the exact profile in
[08-agent-connections-bootstrap.md](../../docs/platform-plan/execution/unified-foundation/08-agent-connections-bootstrap.md).
The constructor snapshots the explicit environment/client, canonical HTTPS
issuer/audience/bootstrap URI and 1–4 purpose-bound public issuer keys. No ambient
keys, remote key discovery, signing, token minting, or network requests exist.
Invalid configuration throws only `BootstrapProofError` with a fixed message;
all verification/input failures return `null` without submitted material.

Call input is `{accessToken, proof, expectedNonce, nowMs, expectedBinding}`.
The binding is `{ownerUserId, principalId, scopeId, runtimeDeviceId, connectionId,
connectionVersion, keyThumbprint}`. All inputs are snapshotted before crypto
awaits. Actual `jose` ES256 verification checks issuer and DPoP signatures;
central runtime public-JWK parsing plus import rejects extra/private fields
and invalid curve points. Compact sections use strict bounded UTF-8 JSON with
decoded-key duplicate rejection, canonical base64url and 64-byte signatures.
The closed JSON grammar admits integer number lexemes only: decimal fractions,
exponents, negative zero and unsafe integers are rejected before schema parsing.

The frozen result is `{binding,tokenId,proofId,issuedAt,expiresAt,nonce,validFromMs,validUntilMs,
assurance:'cryptographic_only',operational_authority:false}`. It contains no raw
token/proof and is not a branded credential or VerifiedContext. Versions are
positive signed-64-bit decimal strings; the central shape validator describes
their spelling, and the verifier additionally enforces the numeric maximum.
Issuer-key validity contains the whole token interval, with current time in
`[notBeforeMs,notAfterMs)`. Tokens have no expiry grace and at most 600 seconds;
DPoP accepts `nowSeconds-60 <= iat <= nowSeconds+5` and exact GET/URI/nonce/ath.
Token-second to key-millisecond comparisons use `BigInt` products, avoiding
floating-point overflow even when a malformed token uses the largest safe integer.
The millisecond interval `[validFromMs,validUntilMs)` intersects token validity,
issuer-key validity and the exact floor-based DPoP window using BigInt before
conversion. A trusted DB adapter must compare a fresh DB clock against this
interval after crypto awaits and its last potentially blocking query; it is not
a caller clock override or a promise of validity at response delivery. The pure
verifier itself neither reads that fresh clock nor authenticates its source.

Host input is not authenticated by its shape or by constructing this factory.
The caller must independently establish trusted configuration and current DB
time/binding. This component does not read owner/runtime/connection status,
issue/consume a nonce, retain replay IDs, mount HTTP, or grant any machine,
private Work, model, execution or operational access. Repeating a valid proof
can return the same success. ECDSA `(r,s)` and `(r,n-s)` signatures both satisfy
the standard verification algorithm: atomic replay protection must use
the server nonce/proof jti, not raw signature bytes. Do not enable a route by
combining these crypto claims with a caller-asserted active connection record.

The separate [bootstrap status service](bootstrap-status.md) implements the
[09 admission profile](../../docs/platform-plan/execution/unified-foundation/09-bootstrap-status.md):
current user/person/scope/runtime/connection checks, fresh DB clock checks after
cryptography, and atomic nonce/proof-ID consumption in one transaction. Its
result permits only that `bootstrap.status.read` response and remains
`operational_authority:false`; it is not a reusable authentication context.
HTTP transport, token issuance and execution-specific Grant/Attempt authority
remain separate work.

`tests/runtime/bootstrap-proof.test.ts` uses independent ephemeral issuer/device
keys and actual signatures, plus Node-native signing for malformed protected
JSON. It exercises bindings, timing, malformed JSON/encoding, key purpose,
mutation and signature malleability. Synthetic host inputs are local crypto
test evidence, never production issuer trust, DB authority or deployment proof.
