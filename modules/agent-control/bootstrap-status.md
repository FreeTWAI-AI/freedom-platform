# Closed bootstrap status admission

`createBootstrapStatus(pool, host)` composes the real bootstrap signature verifier
with current database authority for exactly `bootstrap.status.read`. Host settings
are deeply snapshotted and validated; callers cannot inject a verifier, current
clock, expected owner, or an already verified result. Contracts and bounds are
centralized in [bootstrap-status.ts](../../contracts/execution/v1/bootstrap-status.ts).
The [engineering specification](../../docs/platform-plan/execution/unified-foundation/09-bootstrap-status.md)
defines this closed increment and its remaining pairing/issuer work.

`challenge(actor, {key, connectionId})` requires the current member session,
onboarding, person/personal scope, enrolled runtime and active unexpired connection.
It issues a public random nonce for 60 seconds, capped by connection expiry.
Eight pending and 4,096 lifetime records per connection are engineering limits;
there is no cleanup or implied production retention policy. Exact receipt replay
checks an unconsumed, unexpired nonce and current member/domain authority at the
locked domain decision, before receipt lookup.
The nonce and three scoped sinks commit together; public nonce disclosure alone
confers no authority and never sends a member cookie to a device.

For member challenge, the final connection/nonce clock check is before receipt
SELECT on replay, or after domain facts and before receipt INSERT on issuance.
If receipt storage subsequently waits across expiry, the scoped adapter rechecks
member session time only: the response may contain an already-expired public
nonce. Its `expiresAt` is never extended, and receipt delivery does not guarantee
a usable challenge. Machine admission still rejects expired nonces/connections.

`read({connectionId, nonceId, accessToken, proof})` requires actual issuer and
device signatures and has no Actor/session parameter. It locks and checks the
current user, person, personal scope, enrolled runtime, connection and nonce.
Member session logout does not revoke this separate connection. Owner disablement,
required onboarding, runtime/connection revocation, expiry, mismatched host or
token binding all deny admission. This path never creates lazy identity mappings.

The lock order follows enrollment: user, optional member session, person, personal
scope, optional member command advisory, enrollment owner/environment advisory,
enrollment key advisory, enrollment challenge, runtime, connection, nonce.
Machine identity lookup before locking is only a locator; all binding and current
authority are checked again under locks. Transactions use five-second statement
and lock timeouts. Cryptography has bounded input and performs no external I/O;
the eventual host still owns request/concurrency budgets.

For machine read, after locks, after actual asynchronous cryptography and after
nonce storage, the service samples the database clock. Connection and nonce expiry
and the verifier's exact `[validFromMs, validUntilMs)` interval must still allow admission. The final
decision precedes commit, not client delivery. Current state locks remain held to
commit. A successful read consumes the nonce and stores bounded proof/token JTIs
in that transaction, without a fake member receipt or business outbox event.

Migration [089](../../migrations/089_bootstrap_nonces.sql) retains immutable
identity/nonce/time bindings and single-consumption tombstones. SQL backing checks
use physical schema-qualified runtime/connection tables, not TEMP shadows.
`(runtime_device_id, proof_jti)` is unique across connections and clients. Reusing
a nonce with another proof ID or reusing a proof ID with another nonce fails;
equivalent ECDSA signatures cannot bypass this ledger. Raw tokens, proofs and
private keys are never stored. SQL guards do not defend against compromise of
trusted application database credentials or a schema owner disabling invariants.

Malformed/unavailable identity, invalid signature, mismatched binding and replay
all return fixed 401 `bootstrap_invalid`; unexpected storage failures return fixed
503 `bootstrap_unavailable`. Failures do not consume a nonce. Successful output
is only the fixed status DTO with `operational_authority:false`, never a reusable
VerifiedContext, execution Grant or private Work credential.

[Author tests](../../tests/runtime/bootstrap-status.test.ts) use actual ES256
signatures and separate non-superuser migrator/app LOGIN connections to an explicit
disposable PostgreSQL database. No HTTP endpoint, token issuer, device flow,
refresh family, production trust configuration, model or execution path is added.
