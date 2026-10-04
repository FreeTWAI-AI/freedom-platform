# Closed fresh-device authorization

`await createDeviceAuthorizations(pool, {host, signingKey})` composes the real
pairing verifier, constrained bootstrap issuer and current PostgreSQL authority.
The host profile is snapshotted; the nonextractable private signing handle must
match its purpose-bound public descriptor. There is no injected verifier/signer,
caller clock, member-session impersonation or execution authority. See
[specification 10](../../docs/platform-plan/execution/unified-foundation/10-device-authorization.md)
and the [central inputs/results](../../contracts/execution/v1/device-pairing.ts).

The four methods form one closed device flow:

- `begin({publicJwk,runtimeKind,proof})` verifies actual key possession and returns
  device/user codes once. Only purpose-separated code hashes, the public request
  binding and a unique begin JTI are stored. Public keys cannot be reserved by
  someone who cannot sign. Runtime kind is metadata, not build attestation.
- `inspect(actor,{userCode})` returns exact review metadata, including the immutable
  client display name captured at begin. It never discloses another owner's
  identity. `decide(actor,{key,userCode,authorizationId,requestDigest,decision})`
  rechecks the exact request and current member authority, then atomically records
  approval/denial and scoped journal/outbox/receipt. Approval creates only a real
  [087 enrollment challenge](../../migrations/087_runtime_registrations.sql), not
  an enrolled runtime or connection.
- `poll({authorizationId,deviceCode,proof,enrollmentProof?})` requires the secret
  code and genuine purpose-bound device proof. Pending, slow-down, denied,
  expired and enrollment-proof-required outcomes are committed protocol results.
  Exchange additionally verifies the exact 087 enrollment signature, atomically
  consumes its challenge, creates the runtime and immutable 30-day connection,
  creates the initial refresh family/generation and first status nonce, signs an in-memory token restricted to
  `bootstrap.status.read`, then stores the consumed authorization and token JTI.
  Only successful COMMIT releases the raw
  token and refresh handle response. Machine calls never require or receive the member cookie.

The first public nonce makes [09 status admission](bootstrap-status.md) usable
without another member call. The result says `refreshSupported:true`, includes
the one-time-delivered refresh DTO, and retains `operational_authority:false`.
[Specification 11](../../docs/platform-plan/execution/unified-foundation/11-bootstrap-sessions.md)
and the separate [session service](bootstrap-sessions.md) define rotation/reuse
revocation and repeated nonce acquisition. There is no HTTP/UI, production issuer
trust, model access, Grant or Attempt here.
Read [pairing cryptography](device-pairing-proof.md) for the separate pure-proof
and signing boundaries.

## Locks, clocks and retained facts

Approved machine calls use user/person/personal-scope SHARE locks, then the
existing enrollment owner/environment advisory, key advisory, enrollment
challenge, any existing runtime/connection, authorization/proof ledger and first
bootstrap nonce; initial family/generation insertion follows the connection.
Member decisions add session and scoped-command locks in the
existing order. A pending locator that becomes approved while waiting causes
a bounded transaction restart, never an authorization-to-owner lock inversion.
Machine identity lookup does not lazily create mappings.

The original authorization deadline remains begin time plus 300 seconds. The
087 challenge's separate exact 300-second TTL starts on approval but cannot
extend that original deadline. Clocks are sampled after actual crypto, after
signing and after final storage; proof/token intervals, original authorization,
enrollment, connection and first nonce must remain valid at their decision point.
Locks retain current authority through commit. This does not guarantee that a
network response arrives before expiry.

[Migration 090](../../migrations/090_device_authorizations.sql) preserves immutable
request/owner binding and terminal approval/consumption. Required decision and
consumption timestamps explicitly reject NULL, nonfinite and submillisecond
values; nullable SQL comparisons alone are not sufficient. Its added trigger on
087 prevents the legacy member `confirm` entry point from consuming a linked
device-flow challenge. Only exchange appends a poll ledger marker after genuine
enrollment verification. A deferred constraint requires that marker to commit
with the completed authorization exchange; 091 additionally requires its initial
family/generation. Failed exchanges leave no reusable
permit. Standalone 087 challenges are unaffected. SQL backing queries are
physical-schema-qualified, not TEMP shadows. These guards do not defend against
compromise of trusted app credentials or the schema owner.

Every accepted poll JTI is one-use. The initial five-second interval permanently
increases by five on a valid early poll. Wrong signatures/codes or replayed JTIs
do not change throttle. Ordinary protocol outcomes commit throttle/JTI updates;
invalid enrollment, signing failure, storage failure or a final clock failure
roll the exchange back. Machine-invalid errors are fixed 401
`device_authorization_invalid`; unexpected storage errors are fixed 503
`device_authorization_unavailable`, without SQL or submitted secrets.

Member code lookups charge a durable 60-second/10-attempt bucket in a separate
current-member transaction, including unknown codes. An exhausted bucket returns
429; an unknown/unavailable code returns 404 only after its charge commits.
The charge survives a later decision/fact rollback. It conveys no authority:
the scoped decision transaction independently re-resolves code/ID/digest and
current membership under locks. Exact receipt replay also spends a lookup.

Environment admission is serialized and bounded to 1,000 live/10,000 lifetime
requests; each key has four live/32 lifetime requests and each authorization has
64 accepted poll proofs. Existing enrollment/connection quotas also apply.
These are closed engineering limits, not retention/GC/payment policy or complete
Internet abuse protection. There is no cleanup or expiry extension.

No code/token/refresh secret or raw proof is written to ordinary receipts or any durable
table. A lost begin response requires another begin JTI; a lost committed exchange
response cannot mint again. Fresh-only re-pairing requires a new key and still
counts against lifetime quotas. This is not exactly-once network delivery or a
complete long-term device session. Future HTTP must supply TLS, trusted request
budgets, CSRF and an exact human confirmation UI.

[Author tests](../../tests/runtime/device-authorizations.test.ts) use real ES256,
an ephemeral nonextractable issuer handle, actual bootstrap status verification
and separate non-superuser migrator/app LOGINs in an explicitly supplied
disposable database. No production credentials or database are used.
Quota tests fill synthetic retained rows through the trusted fixture owner, with
guards enabled; those rows are not claimed to have passed cryptographic admission.
