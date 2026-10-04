# Autopilot Work: closed human private Result service

[results.ts](results.ts) composes the existing shared
[Asset engine](../assets/engine.ts), private UTF-8 storage profile and
[084 Result schema](../opportunity-project-work/results-schema.md). It does not
copy upload state transitions or create another Asset system. Despite the module
name, this slice has no model call, broker, Run, Grant or AI provenance. No HTTP,
MCP, background consumer, publication or UI is registered.

Construct `createPrivateResultService(pool, { store, resolvePolicy, ...limits })`
only in trusted server code. The required resolver receives the live transaction,
current member scope and Work ID. It must read authoritative per-profile policy
and hold mutable policy rows `FOR SHARE` until commit. Return an explicit
`revision`, boolean `platformPersistenceAllowed` and decimal-string
`retainedByteLimit` (at least 262144 bytes); no production policy/quota value is
inferred. Tests inject a synthetic DB policy, not approved operating settings.

## Closed DB-backed persistence policy

[policy.ts](policy.ts) now provides
`resolvePrivateWorkPersistencePolicy(q, context)` for explicit injection into
both `createPrivateWorkCommands(pool, { resolvePolicy })` and
`createPrivateResultService(pool, { store, resolvePolicy })`. No constructor
default, environment flag, HTTP/UI activation or allowing policy row is added.
The existing lower-level callback remains a trusted-server port, not request JSON.

Provisional [migration 085](../../migrations/085_private_work_policy.sql) stores
one policy per real personal scope and the fixed `work.private-draft` purpose.
Its composite FK binds the scope to the exact person owner, not merely to any
valid principal. Missing row, disabled policy, wrong context/scope/owner/purpose,
unavailable DB source, invalid revision or absent/insufficient quota fails closed.
Policy errors are sanitized and do not embed SQL, IDs or private text.

Operator-configured writes are distinct from application authority. Application
deployment roles get **SELECT plus column-level UPDATE(scope_kind)** on this
table, never table-level UPDATE or UPDATE of stored policy fields. PostgreSQL
requires some UPDATE privilege for `FOR SHARE`: pure SELECT is not sufficient.
`scope_kind` is a GENERATED ALWAYS constant; assigning DEFAULT is an exact no-op,
and assigning a different value is rejected. This narrow privilege exists only
to support row locking, not to configure policy. Blanket runtime DML grants are
not sufficient. The migration does not create/configure a role or
authenticate an operator; the deployment grants template must enforce that
boundary. Tests use a fresh synthetic `fp_*` NOLOGIN role to reproduce pure-SELECT
locking failure, then prove real Work/Result service calls succeed under the
lock-only grant while all stored-field UPDATEs, mixed assignments, INSERT, DELETE
and TRUNCATE remain denied. The generated DEFAULT update preserves the entire
row, revision, flags, quota and timestamps. Schema owners/superusers can bypass
ordinary grants or triggers and are not defended against by this application
contract; restore/truncate is not an allowed policy-reset workflow.

Policy starts at explicit bigint revision 1. Every changed row requires exactly
the next revision, with immutable scope/purpose/owner/creation identity and no
DELETE/recreate reset. An exact no-op may retain its revision. Disable and later
re-enable therefore produce distinct pins (`private-work.v1`, `.v2`, `.v3`), never
reuse an old upload revision. Both clocks are server-written. Enabling requires
an explicit retained-byte limit of at least 262144; no production quota is chosen.
This is the existing retained private-Asset budget, not a new limit/accounting
scheme for Work title/objective SQL bytes or a release of retained storage.

The resolver takes the current policy row `FOR SHARE` on the already authorized
transaction, after Work/Asset locks, until commit. Operator policy updates acquire
policy locks only, never reverse-acquire Work/Asset locks. The resolver is not
standalone authentication: service adapters must first hold current user/session,
principal/scope/domain locks and then refresh the DB session clock after this
query and every later blocking query. Existing Work/Result adapters do so. Real
policy-row lock waits crossing session expiry reject before private data/effects.

Work create/update and their successful receipt replays consult this current
policy; archive still never consults policy/provider and remains possible when
policy is disabled/unavailable. Existing Work read ACL semantics are unchanged.
Result reads/list/replays and upload phases consult current DB policy; reads use
the existing pre/post-I/O checks. A newer allowing policy may authorize a fresh
historical read, but any revision change during GET denies that call, and old
upload/finalize pins do not revive after disable/re-enable. Private GC, backup
copying, erasure/retention promises, provider processing and AI remain closed.

`tests/runtime/private-work-policy.test.ts` uses explicit disposable `fp_*`
PostgreSQL schemas, synthetic bytes and bounded runtime-role grants. It proves both
services use the resolver, strict SQL revision/FK guards, replay/revocation,
retained quota configuration, real policy lock/session expiry, and read-only
runtime lock-only privileges. It is not evidence of production policy approval or rollout.

## Internal methods

- `prepare(actor, { key, targetWorkId, expectedVersion, contentType, byteSize, sha256 })`
  accepts exact `text/plain`/`text/markdown` and a 1–256 KiB manifest.
- `claim`, `write`, `finalize` and `resumeUpload` use the shared engine's intent,
  key, fence and lease shapes. `write` receives a separate bounded Web stream.
  Raw keys, URLs, policy, provider credentials, owner IDs and provenance are not
  accepted in request objects. All target/read IDs use central `OpaqueId`.
- `readCurrent(actor, { workId })` returns the current text Result or NULL for an
  authorized Work without one. `readResult(actor, { workId, resultId })` reads
  an authorized historical Result, otherwise 404.
- `list(actor, { workId, limit?, offset? })` returns only bounded history metadata
  (default 20, maximum 50, offset maximum 10000), newest revision first. It does
  not read objects or include text.

Finalize returns the actual `resultId`, `workId`, `assetId`, `intentId`, immutable
`revision`, real Work `aggregateVersion` and `provenance: human`. The Result INSERT
alone performs Work CAS. Shared engine then finalizes the intent and writes the
scoped journal/outbox/receipt on the same transaction. Facts and receipts contain
only explicit IDs, versions and human-kind metadata—not text, object keys or
private prompts. Failure at any point rolls back publication and version. Lost
COMMIT response is unknown to that call; retrying the same finalize key returns
the committed real Result ID without publishing another Result or reattaching
history. Different content/targets under the same key conflict normally.

## Current authority, policy and retained quota

Each phase/replay obtains current user/session, principal and personal scope
through the shared member adapter, then verifies onboarding and exact draft
Work ownership. Admin/guild labels grant no additional access. Work locks precede
pointer, intent, Asset and trusted policy locks. The engine rechecks current
session/lease time after blocking domain locks; Result publication additionally
checks session time after its SQL INSERT, whose unique indexes could wait.
SQLSTATE `P0412` alone maps to 412 `version_conflict`.

Prepare takes the engine's shared `(scope,purpose)` quota advisory lock before
Work locks. Thus two different Work targets owned by one member cannot both
spend the same capacity. Accounting includes all private-text Assets: verified
objects charge actual size; unresolved/expired/orphaned intents charge their
256 KiB reservation; an Asset without either charges the same conservative
maximum. Historical, retired and tombstoned rows stay charged. Avatar usage is
not substituted for this profile's accounting. There is no quota-release API.

Private policy denial blocks Result reads and all new/upload/replay phases.
Archiving the Work remains the existing independent human control operation and
does not require this service or a healthy persistence policy. Archive is retained
terminal state, not erasure; private text GC is still explicitly disabled.

## Read linearization and immutable history

Reads use two short transactions around external I/O:

1. Verify current member/onboarding/scope, lock the exact draft Work and Asset,
   resolve current policy, then check the current session clock after the last
   blocking query. Snapshot Work version and exact Result/object identity.
2. Release all locks. Perform a bounded GET, compare complete metadata and actual
   bytes/SHA-256, and reuse the common fatal-UTF-8/control validator. No fallback
   to Work objective, retained DB content or a caller URL is available.
3. Repeat current authority, policy and clock checks. Require unchanged Work
   version and Result ID; reject policy revision changes during I/O. Only then
   return the exact verified text. This final authorization is the read's
   linearization point; already returned bytes cannot be recalled.

Historical ready **or retired** Assets are readable by the current owner while
their Work is draft; history does not need to be the current pointer. Human
purpose edits and new Results change Work version, so an in-flight old read
returns 412 and must be retried. Archive/revocation denies history and success
receipt replay. Metadata returns immutable `workVersion` and current
`aggregateVersion` separately, both decimal strings.

An already saved Result's original policy revision remains immutable metadata.
A fresh explicit read may use a newer currently allowing policy; changing policy
mid-read rejects. Upload/finalize/replay remains pinned to the intent's original
revision and requires re-preparation if that revision changes. The trusted policy
resolver is responsible for refusing historical reads when current policy so
requires; revision alone is not a universal deletion or publication decision.

Markdown/plain text is untrusted content, not HTML. BOM and exact code points are
preserved. No rendering/sanitization/publication is performed; future UI must
escape text and disable unsafe Markdown HTML/URLs. No raw storage identity or
presigned URL is returned. Future HTTP adapters must separately enforce no-store,
HEAD/Range/conditional semantics and complete read-surface review before opening.

## Evidence and remaining work

`tests/runtime/private-results.test.ts` uses only explicit disposable `fp_*`
schemas, real PostgreSQL transactions and synthetic FakeObjectStore bytes. It
covers owner/history/retired reads, current revocation and post-I/O version/policy
changes, actual expiry lock barriers, same-key and competing CAS, cross-Work
quota, strict profiles/UTF-8/size/UUID inputs, stale fences, late PUT without
attach, four final-transaction failure points, lost COMMIT replay, and all three
wrong-profile avatar APIs before policy/source/storage effects. Schema and shared
engine have separate independent counterexample suites.

These are local member-service proofs, not complete Autopilot acceptance.
Actual cloud wiring, private-text operating policy/retention decisions, model
custody and generation, machine credentials, HTTP/UI, backup copying/restore,
private GC and production rollout remain unimplemented or unverified here.
