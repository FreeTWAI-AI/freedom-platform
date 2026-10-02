# Closed member-managed agent connections

`createAgentConnections(pool, { environment, clientId })` adds a durable connection
record after a real runtime enrollment. The host fixes both options; inputs cannot
choose environment, client identity, owner, expiry or policy. The engineering
profile is specified in [08-agent-connections-bootstrap](../../docs/platform-plan/execution/unified-foundation/08-agent-connections-bootstrap.md).

The current-member methods are `create(actor, { key, runtimeDeviceId })`,
`read(actor, { connectionId })` and
`revoke(actor, { key, connectionId, expectedVersion })`. Metadata includes its
server UUID, runtime, environment, client ID, state, decimal aggregate version
and ISO millisecond issuance/expiry. Every result has `operational_authority:false`.
No token, refresh secret, nonce or copied runtime public key is stored here.

Connections last exactly 720 hours from the database clock. All 32 lifetime
records per owner/environment count, including revoked and expired records.
The runtime/client pair remains unique after revocation. There is no renewal,
rebind or delete; expiry does not rewrite the durable `active` state. This is a
closed engineering profile, not an approved production refresh/session policy.
An active connection whose runtime was revoked is likewise not usable machine
authority; the separate [bootstrap status service](bootstrap-status.md) checks
current runtime authority before admitting its one status operation. Future
execution validators must do the same for their own Grant/Attempt boundaries.

Create and its exact receipt replay require the same current member, session,
onboarding, principal, personal scope and enrolled runtime. An existing connection
must remain active and unexpired. Enrollment challenge expiry after confirmation
does not expire a runtime. Read/revoke deliberately remain available to the
current owner after runtime revocation or connection expiry. Matching revoke
receipt replay is safe; missing/stale versions retain 428/412 semantics.

Lock order matches runtime enrollment: user, session, person, personal scope,
scoped command advisory, enrollment owner/environment advisory, enrollment key
advisory, challenge, runtime, connection. Reads omit the command advisory.
The owner advisory serializes quotas across host clients and runtime revocation.
No scope SHARE lock is upgraded. Mutable input is snapshotted before any await.
Session clock is checked after domain locks, writing domain facts, and scoped
receipt reads/writes. Create checks expiry at its locked domain decision point;
that is not a promise about client delivery time. Scoped receipts and facts use the existing command
transaction and never publish to the legacy community outbox.

Provisional [088](../../migrations/088_agent_connections.sql) enforces real
person/user and personal-scope FKs, immutable identity/time fields, terminal
versioned revocation and tombstones. Its INSERT trigger reads the physical
`TG_TABLE_SCHEMA` runtime row under a lock and checks current enrollment and
matching owner/environment; TEMP search-path objects cannot replace it.
Successful INSERT expiry is rechecked after possible unique-index waits.
SQL does not authenticate a machine or protect against a compromised trusted
application database credential or schema owner.

[Author tests](../../tests/runtime/agent-connections.test.ts) use a fresh explicit
`fp_*` test database schema and actual enrollment signatures. They cover member
ownership, host binding, limits, replay/CAS, revocation, schema immutability,
concurrency and transaction rollback of all three scoped sinks. These checks
are local evidence; no HTTP route, token issuer, machine DB validator, execution
Grant, provider call or production activation is added.
