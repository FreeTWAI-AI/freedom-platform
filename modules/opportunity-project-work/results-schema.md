# Closed human Result schema (084)

This is the additive SQL foundation for private human-authored text Results in
[ASSET-WORK](../../docs/platform-plan/execution/unified-foundation/03-assets-private-work.md).
It is not a Result application service, HTTP route, AI execution, Grant,
publication, Contribution or accepted Work. No body is stored in Work, Result
metadata, command receipts, journal or outbox by this migration. Text bytes will
use the existing private ObjectStore and its UTF-8 validation profile.

084 is an unpublished provisional numeric migration. It does not rewrite
077–083 or alter existing community Work facts. The schema vectors deliberately
use synthetic SQL fixtures; they are not evidence of member authorization,
current policy enforcement, stream validation or cloud persistence.

## Shared Asset profiles

| Purpose | Typed upload target | Source | Stored object |
| --- | --- | --- | --- |
| `member.avatar` | `member.avatar`; actual avatar owner | PNG/JPEG/WebP, 1–2097152 bytes | `avatar`, WebP, 1–131072 bytes, `avatar.webp.v1` |
| `work.private-draft` | `work.private-result`; exact personal Work | plain text/Markdown, 1–262144 bytes | `draft`, same text MIME, 1–262144 bytes, `private-text.utf8.v1` |

Both purposes use **the same** `assets`, `asset_objects`,
`asset_upload_intents`, immutable object-key layout, lease/fence/state guards and
deletion fence. `asset_objects.purpose` participates in a real Asset identity FK;
its conditional CHECK preserves every old avatar format/size/transform bound.
The existing object immutable trigger covers the added purpose too.

`asset_upload_intents.target_user_id` remains the exact owner for both profiles.
New `target_kind` defaults to `member.avatar`; `target_work_id` is NULL for
avatars. A generated avatar-target user discriminator retains the actual
avatar-target FK. Private intents instead require `target_work_id`, generated
`personal_execution`, and a composite Work ID/mode/scope/principal/user FK.
Neither branch can use NULL to escape its required target. Purpose/target pairs,
source types, source caps and reservation bytes are mutually exclusive. Added
target fields have an immutable guard; old identity/state/lease triggers remain.
Text needs no fake avatar row. It does not use avatar persistence policy or quota.

The original avatar INSERT column lists and defaults still work. The upgrade
test snapshots all pre-084 columns of existing rows and a real synthetic legacy
receipt, then compares them after migration. No media bytes are transformed.

## The Result append transaction

The future trusted domain adapter calls:

```sql
INSERT INTO private_work_results(result_id,intent_id)
VALUES($1,$2)
RETURNING result_id,revision,work_version;
```

Only those two identities are input. The BEFORE trigger locks and derives Work,
scope, owner, Asset, representation, policy, revision and next Work version from
the immutable intent and real Work. Caller-supplied derived fields are rejected;
`provenance` is a generated `human` literal. This records the supported schema
kind, **not proof that a SQL caller authenticated as a human**. The future
member-session adapter supplies that authority; there is no machine branch.

`work_items.aggregate_version` is the only mutable CAS authority. A live stored
intent must match its current version and point to a ready, unfenced text Asset.
The AFTER INSERT trigger increments Work exactly once and publishes
`private_work_result_targets`. The application must not increment Work again.
Doing the mutation after actual INSERT is essential: `ON CONFLICT DO NOTHING`
can suppress a row after BEFORE triggers ran, and must not consume a version or
allocate a phantom pointer. Any UPDATE of Result history, including a no-op
`ON CONFLICT DO UPDATE`, is rejected.

The surrounding transaction must mark the intent finalized and write the scoped
metadata-only fact/receipt. Deferred constraints require both a Result for every
finalized private intent and a finalized intent for every Result. Any failure
rolls back Result, pointer and Work increment together. A stale expected version
raises SQLSTATE `P0412`; the future adapter maps **only that code** to the existing
412 `version_conflict`, not every SQL constraint failure.

Result `revision` is immutable ordering within a Work, not a second mutable
version. `work_version` records the real Work version at append. Human edits can
create gaps: Result revisions 1/2 may record Work versions 2/4. Bigints stay
decimal strings through the application interface. Same-Work multi-row INSERTs
with the same expected version fail atomically; different Work rows can each
advance once when all intents are finalized in the same transaction. The future
single-Result API must not expose an unbounded multi-Work batch.

## Locking, history and reads

The domain order is current member/session/scope and receipt lock → shared
`(scope,purpose)` quota advisory lock for prepare → Work → existing Result
pointer → intent → Asset → trusted policy. The generic lifecycle owns quota
serialization and I/O phases; it must not grow a second Result-specific upload
implementation. Target routing read before locks is safe only because the
intent's typed identity is immutable. First pointer creation is serialized by
the Work lock. Direct control-plane pointer DML must also lock Work first;
arbitrary inverse-order SQL is not promised deadlock-free. Bulk operations need
deterministic Work ordering. A detected deadlock must abort, never bypass locks.

History is immutable and references exact owner/scope/purpose but does not bind
Asset state forever: historical Assets can be `retired`. The current pointer
does require a ready Asset and the latest Result, so it cannot attach an older
revision or clear itself outside a future explicit lifecycle. Its
`linked_at_work_version` is a snapshot, not a second counter. Changing a Work
title/objective does not erase historical Results.

Archive remains terminal and prevents new append. Retained pointers/history do
not grant reads after archive. Future owner history reads must allow a legitimate
ready/retired historical Asset, but independently verify current active user,
session, principal, personal scope and exact draft Work ownership; current
pointer membership is not the ACL for history. Recheck current authority and
session clock after external GET and the final blocking query. No raw object
key, bucket identity, text body or private prompt belongs in a receipt/event.

## Maintenance and rollout boundary

082 explicitly rejects deletion claims for any purpose other than
`member.avatar`; private text GC remains closed until its Work/reference lock
and retention lifecycle is implemented. Existing tombstones/fences remain
permanent. No scheduler, retention default or cloud DELETE is added.

Reference capture can pin a 256 KiB text object. The pin's full metadata FK
requires the actual verified object's exact size and SHA; the object's
purpose-specific CHECK still caps avatars at 128 KiB. Raising the outer pin cap
does **not** permit oversized avatar pins. The reference set is not a copied
backup, exported DB snapshot or restore certificate. Backup policy and real
copy/restore evidence remain separate.

Until the shared profile-neutral lifecycle is integrated, the old avatar service
is not a private-text adapter: its historical intent lookup does not discriminate
purpose. No private Result writer may be activated with that version. The new
engine must filter purpose and target kind before any lease/storage operation,
apply explicit text persistence policy/quota, and pass cross-profile rejection
tests. Once private text exists, rollback must retain 084-aware private ACL and
profile-aware lifecycle, not merely a UI that still starts.

`private-result-schema.test.ts` covers profile and typed-FK reject vectors,
immutable identity/history, terminal archive, deferred rollback, real two-client
Work races, conflict suppression, exact bigint versions, metadata pins, disabled
private GC and 083 upgrade compatibility. These tests do not claim authenticated
Result commands/reads, text upload I/O, cross-purpose runtime safety, HTTP
cache/HEAD/Range behavior, private-text quota/retention approval, AI generation,
R2 deployment, backup copying or restore. Those remain future stages.
