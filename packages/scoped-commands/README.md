# Scoped member commands

This server-only adapter composes the existing neutral command core with current
member principal/resource-scope resolution. Import `scopedMemberCommand`,
`scopedJournal` and their input types from [index.ts](index.ts).

The full [API, lock order, input bounds, schema and local evidence](../db/README.md#additive-scoped-member-commands)
remain documented alongside the legacy command compatibility boundary. The
separate module depends on `command-core` and `resource-scopes`; neither dependency
imports this adapter. Do not move it back under command-core ownership or add a
reverse descriptor dependency that creates a governance module cycle.

The adapter accepts only current member sessions. It has no HTTP route, machine
credentials, external I/O, publication/fanout or implicit target ACL. Migration
[078](../../migrations/078_scoped_member_commands.sql) is additive; the separate
scoped journal/outbox never writes legacy community events. Domain callbacks must
authorize the actual target and supply only bounded, explicit metadata.

`scopedMemberCommand` rechecks the locked member session against the database
clock after receipt lookup and receipt insertion, including on replay. A receipt
storage wait that crosses session expiry fails and rolls back the domain change,
journal, outbox and receipt together. This is a pre-commit authorization decision,
not a promise that the session remains valid through commit or response delivery.
For time-bounded domain authority, the optional fifth server-owned callback
`revalidate(q, context)` runs after each actual receipt SELECT and INSERT and
the member-session clock check. It also runs when SELECT finds no receipt.
Keep it safe before the new-effect callback has created a record; afterward,
validate the actual new record as well. A failure after insertion rolls back
domain writes, scoped facts and the receipt on the same client. The callback is
outside caller JSON, receipt namespace and digest. Existing four-argument
callers are unchanged. Domain callbacks still check expiring resources after
their other waits; this does not alter `command()` or the avatar adapter.

## Closed avatar receipt compatibility

`avatarMemberCommand<T>(pool, input: Command, authorize(q, context), run(q, context))`
is a server-only migration adapter for exactly `POST /api/v1/me/avatar`. It does
not alter `command()` or make receipt profiles caller-selectable. Its body is
exactly `{content_type, sha256}` (JPEG/PNG/WebP MIME and the lowercase SHA-256 of
the original upload); asset/intent/generated representation IDs never enter the
historical request hash. Target is implicitly the authenticated member's own
avatar and scope is always that member's current personal scope. Arbitrary
operations, explicit target/scope/profile overrides and extra body fields fail.

The order is current user/session → person/personal scope → original
user/operation/key advisory lock → current domain authorization → decision-clock
session refresh → original digest/receipt → replay or new domain/facts/receipt
on one transaction client. Internal legacy receipt ports are shared with the
unchanged member wrapper; the digest remains `digest({body, expected: expected ??
null})`, not the scoped-command digest. Missing mappings are lazily created;
disabled principal/personal scope still denies even an old successful receipt.

The run callback may use `scopedJournal` only with operation
`member.avatar.replace`, aggregate type `member_avatar`, ID `actor.user_id` and
the real saved avatar version. Journal/outbox are scoped facts; there is no
community fanout or second scoped receipt. The callback must publish the actual
pointer/version and return the existing avatar response shape before this same
transaction inserts the old receipt. Failure of any part rolls all of it back.
As for `scopedMemberCommand`, input/response JSON snapshots are bounded and
frozen, but external variables captured by callbacks are the domain's duty to
snapshot; current target ACL and actual version/fence checks are not inferred.

A trusted upload facade can probe for old replay before selecting storage mode
or invoking any normalizer/provider: call this adapter and throw a private
identity sentinel from `run` on a miss. The transaction then rolls back without
creating a success receipt or retaining newly created mappings. A successful
old receipt skips `run`, including current version/CAS and new pipeline setup;
current member eligibility is still required in `authorize`. The final adapter
invocation rechecks the same receipt under its original lock, so a competing
legacy/new writer cannot produce a second effect. Keep media I/O outside these
callbacks. If the new-effect callback waits on additional domain/policy locks,
call `assertCurrentSessionClock` after those waits before publishing, on the
same locked transaction client. This adapter alone activates no HTTP route,
storage binding, mode switch, deployment or machine credentials.

`avatar-command-compat.test.ts` exercises actual avatar/pointer tables and scoped
facts, old/new receipt races, lazy legacy replay, revocation and elapsed-time
expiry, metadata-only rollback, closed input/live-context restrictions and a
DML-only database role. Object metadata is synthetic: these CORE tests perform
no provider write and are not proof of an upload pipeline or production cutover.

Local evidence on 2026-10-02: 22 compatibility cases plus legacy command/scoped
command/avatar/flows/access-session regressions passed (108 total, zero skips)
on an explicitly provisioned disposable PostgreSQL target. Fresh schemas and the
DML-only role were removed afterward; typecheck and diff whitespace checks also
passed. This evidence does not attest deployment, real object durability or
trusted CI enforcement.
