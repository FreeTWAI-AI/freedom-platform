# Member command compatibility core

`index.ts` retains the public `command(pool, input, authorize, run)`, `transaction`, `digest`, `journal` and `checkVersion` entrypoints. `command` is an alias of `memberCommand`. Existing callers and historical receipts do not migrate.

The internal orchestration in [command-core.ts](command-core.ts) depends on PostgreSQL types, transaction handling and neutral Problem errors, not the identity or execution domain. Server-owned adapter ports provide current authentication/locking, receipt serialization, digest and receipt storage. The member adapter is the only implemented adapter. No service/execution API or credential acceptance is enabled.

## Order and invariants

The member path remains: validate idempotency key → BEGIN → lock active user (`FOR SHARE`, or `FOR UPDATE` for user mutations) → lock current non-revoked/unexpired session → original user/operation/key advisory lock → current domain authorization → original request digest → receipt lookup → replay or domain mutation/receipt → COMMIT. All callbacks receive the same transaction client; errors roll back and release it.

The digest stays `digest({body, expected: expected ?? null})`. The historical sorted-key JSON encoder in `legacy-digest.ts` is unchanged; it is not JCS. Operation strings, receipt primary keys, response JSON and error codes remain unchanged. Scope/principal/attempt-based receipt namespaces must be implemented separately, never by pretending a service is a member.

The follow-on [resource-scopes package](../resource-scopes/README.md) shares only current member user/session locking through `member-session.ts`; it adds no scope check, query, mapping creation or new receipt behavior to the legacy `command()` path. Its separate context helper does not replace this command wrapper.

Ports are internal server functions, not a serialized VerifiedContext or an authorization proof. Each adapter must verify backing credentials and current authority inside this transaction, define lock ordering and a collision-free namespace, and pass real revocation/concurrency tests before exposing a route. No provider/object-store/network I/O belongs in core callbacks. Historical avatar normalization remains inside its existing command callback and is not fixed by this extraction.

## Additive scoped member commands

Import `scopedMemberCommand`, `scopedJournal` and `ScopedMemberCommand` directly
from [scoped-commands/index.ts](../scoped-commands/index.ts). The old index exports
and legacy adapter stay unchanged. This additional adapter accepts only a real
current member session; service/execution credentials and site scopes remain
unsupported. This is a server-only library with no new HTTP route.

```ts
scopedMemberCommand(pool, {
  actor, scope: 'personal', operation: 'asset.upload.finalize', key,
  target: { kind: 'asset_upload_intent', id: intentId }, expected: '1', body,
}, async (q, context) => {
  // Read and lock CURRENT domain authority and target scope here, including
  // permission to see any replay response. A valid scope is not a target ACL.
}, async (q, context) => {
  // Check actual expected version, mutate on q, then explicitly journal only
  // server-allowlisted metadata. Never perform object/provider/network I/O.
  await scopedJournal(q, context, {
    aggregate_type: 'asset_upload_intent', id: intentId, version: '2',
    operation: 'asset.upload.finalize', data: { content_sha256 },
    eventType: 'asset.upload.finalized.v1',
  });
  return { intent_id: intentId, aggregate_version: '2' };
});
```

The input accepts `scope: 'personal' | 'community' | ResourceScopeRef`, a typed
target `{kind,id}`, a stable lowercase operation ID, legacy-shaped idempotency
key and optional positive decimal bigint `expected`/`lockUser`. Operations and
target kinds match `[a-z][a-z0-9_.-]{0,159}`. `expected` binds request identity;
the domain still calls `checkVersion` against its current row (428/412). The
target UUID is not proof of its scope or authority; those checks belong in
`authorize` and the domain's typed FKs. Callbacks receive the same locked,
frozen `MemberScopeContext` and transaction client.

Order: validate/snapshot input → BEGIN → current user/session → principal →
selected scope → actual-clock session expiry check → scoped advisory lock →
current domain authorization/locks → actual-clock session expiry recheck →
digest/receipt → replay or domain mutation/journal/outbox/receipt → COMMIT.
The final session check uses `clock_timestamp()` so waiting for a domain/receipt
lock cannot keep an expired session alive using transaction-start `now()`.
An authorized command already past that decision may complete; expiry does not
retroactively cancel a committed effect. Revocation locks retain the documented
resource-scopes linearization order.

The new receipt namespace combines principal, `member_session`, resolved scope
UUID, stable operation and key. The advisory key is a serialized JSON array with a
separate profile prefix, not delimiter concatenation. The new digest profile is
`freedom.scoped-member-command/v1`, covering exact resolved typed scope, target,
expected version and body through the existing sorted-key encoder. It is not
JCS and does not change any historical hash. Selecting the same scope by kind
or exact ref produces the same binding; different principals/scopes/operations
have separate namespaces.

Request/response snapshots accept only bounded plain JSON: at most 256 KiB,
20,000 nodes and depth 24; no cycles, accessors, custom objects, sparse arrays,
undefined, non-finite/unsafe integer values, NUL or unpaired surrogates. Responses
are snapshotted/frozen on both first result and replay. These copies protect the
core's namespace, digest and response; they cannot freeze arbitrary variables
captured by domain callbacks. Domains must snapshot/validate their own captured
inputs before starting a command. No raw body is automatically stored in a
receipt, journal or event; receipts contain only the explicit callback response.
Domains must not put private text, credentials, URLs or raw bytes in that
response or journal metadata. There is no generic secret-content detector.

`scopedJournal` accepts only the exact live context from the command's `run`
callback on the same client, after authorization. Cloned, foreign-client and
post-transaction contexts fail. The operation must match the enclosing command;
aggregate version is positive bigint. Data is an explicit plain metadata object
limited to 32 KiB. The optional event copies only those supplied metadata plus
typed principal/scope/aggregate refs; no automatic consumer/fanout is enabled.

[078](../../migrations/078_scoped_member_commands.sql) creates independent
`scoped_command_receipts`, `scoped_transition_journal` and `scoped_outbox`.
Principal/scope kinds have composite FKs; generated personal-owner columns also
bind personal facts to the actual owning principal, reusing 077's unique scope
identity. Community scopes retain no invented owner. The outbox's composite FK
must identify the same journal scope. Existing community journal/outbox are
untouched. New facts reject UPDATE/DELETE; a future retention/erasure lifecycle
must be separately designed. These are DML constraints, not protection against
a schema owner disabling triggers or truncating tables. SQL JSON byte caps allow
bounded jsonb formatting expansion; the stricter application limits apply first.

`scoped-member-command.test.ts` runs on an explicitly provided disposable
`TEST_DATABASE_URL` whose database starts `fp_`, with a new isolated schema. It
tests current authority before replay, real lock races and expiry while blocked,
typed namespaces/digest conflicts, SQL owner/FK/immutability constraints, scoped
event separation, snapshot/JSON bounds and transaction rollback on every fact
failure. Machine auth, real Asset/Work domain ACLs, deployed grants and actual
external effects are outside this adapter's evidence.

On 2026-10-02, all 71 scoped-member, legacy command-core and resource-scopes
cases passed on the separately provisioned disposable PostgreSQL 18.6 target
with no skips; this includes 28 scoped cases. Typecheck and diff whitespace
checks passed. The expiry cases observe an actual PostgreSQL blocking PID and
wait for the DB clock to cross expiry before releasing the domain lock. The
suite removes its generated schema and its DML-only test role afterward.

## Regression evidence

[command-core.test.ts](../../tests/runtime/command-core.test.ts) uses actual migrations and a new `fp_command_core_*` schema. It exercises a fixed legacy digest, response/namespace compatibility, key validation, session/user/domain revocation before replay, body/version conflicts, two sessions sharing a key, actual PostgreSQL lock waits, both revocation/command ordering directions, and atomic rollback of domain, journal, outbox and receipt failures.

The first 14 cases passed against the original member implementation before extraction and passed again after extraction, together with the existing flows, avatar and access-session regressions (56 total cases). With the journal/outbox failure cases added, all 16 core cases passed in the complete 898-test runtime suite; the 20-test workerd suite also passed. Final results and environment failures/retries are recorded in the [spec handoff](../../docs/platform-plan/execution/unified-foundation/implementation-status.md). These tests do not prove any machine credential, principal mapping, new Asset storage or private Work authorization.

For database tests use a disposable database or an isolated `fp_*` schema; never migrate/seed/truncate `freedom_local.public`. This change adds no migration and reserves no number. The local governance verifier still reports runtime suite adapters/registration coverage as unavailable; manually recorded runtime results are not a trusted CI check.
