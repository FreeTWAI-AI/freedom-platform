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
