# Existing avatar POST: compatible Asset upload facade

`createAvatarUploadFacade` is wired to `/api/v1/me/avatar`, not a new public
upload-intent API. The old response remains `avatar_url` and `aggregate_version`
with the same ETag/wire conversion, CSRF/Origin, upload size/MIME/rate limits and
member authorization. No model or Grant is required for a human avatar.

## Closed configuration and policy

Migration 083 expands the existing `avatar_storage_policy` authority; it does
not create a second policy table. Defaults are `mode=legacy`,
`persistence_allowed=false`, null `policy_revision` and null
`retained_byte_limit`. Legacy mode delegates to the unchanged domain writer.
Bridge/r2_only requires an injected ObjectStore and all policy fields. Missing
configuration is unavailable, never a fallback bytea write. The database row is
locked/re-resolved at prepare, inspect, storage record and finalize. A changed
revision rejects an older intent; disabled persistence prevents new publication.
Synthetic test configuration is not evidence that production retention/cloud
permissions are approved. The facade never accepts a caller policy/resolver.

## Idempotency and transaction boundaries

The compatibility adapter keeps the OLD user/operation/key advisory namespace,
`command_receipts` table and digest of `{body:{content_type,sha256(original)},
expected}`. A short current-auth/domain receipt probe precedes storage setup and
normalization. Prior success returns historical metadata even if the current
pointer was replaced/removed or storage is unavailable; it cannot restore
content. Current session/principal/scope/onboarding still apply. Persistence
configuration gates new effects, not historical metadata receipts.

A miss rolls back a private sentinel, not a placeholder success. A stable
prepare key is derived from the original operation/key; source MIME/SHA/size
and expected version remain the immutable request manifest. A current owner
may resume the same unexpired intent lease. Expiry takeover uses a claim key
bound to the previous monotonic fence. Old fences cannot record/finalize.
Stored retries skip a new normalization/PUT but reverify the object before
finalization. Normalization, PUT and read-back run outside SQL locks.

Final `avatarMemberCommand` rechecks the OLD receipt namespace in the same
transaction that holds current authority, locks the avatar/pointer/intent/Asset,
resolves policy, checks real-clock lease/session and real target CAS, marks
ready, attaches the typed pointer, advances the REAL avatar version, retires
the previous Asset, finalizes intent, appends scoped member_avatar facts/outbox,
and commits the OLD success receipt. No route copies receipt SQL. The stable
scoped operation is `member.avatar.replace`; the domain aggregate is the real
user avatar, with asset/intent IDs only in explicit bounded metadata. No new
legacy community fanout is emitted.

If another same-key request finishes while one is processing, or COMMIT succeeds
but its response is lost, exactly one current-auth/domain receipt-only probe
can reconcile the success. A miss preserves the original failure; it does not
restart effects. Revoked scope/session/onboarding cannot use this recovery
probe to retrieve the historical receipt. Concurrency may still produce a
retryable failure before any request has committed; there is no busy wait.

## Retained quota

Every lifecycle policy resolver, including explicit synthetic fixture ports,
must supply a bounded positive bigint-decimal retained limit (minimum 128 KiB).
No optional quota bypass is exposed. Prepare serializes under the owner's real
avatar row and charges all owner Assets: immutable object metadata's actual
`byte_size` when available, otherwise the intent's maximum reserved output
(conservative 128 KiB for any unmatched Asset). It additionally charges retained
legacy bytea. Expired, orphaned, retired and tombstoned rows are NOT excluded.
Replay returns before inserting another reservation. Recording an actual
verified object replaces its maximum reservation with actual size.

No quota is released because a lease expired, removal retired an Asset, or a GC
request observed `missing`. A delayed PUT can recreate physical bytes after such
an observation. Maintenance owns permanent fences/reconciliation; this slice
provides no quota-release API. Consequently abandoned work can exhaust a member's
quota until a separately safe reclamation policy exists. There is no automatic
bucket deletion, default quota value, hidden billing promise or production
cutover in this module.

## Local evidence

`tests/runtime/avatar-upload.test.ts` covers the actual existing HTTP POST,
old digest/wire behavior, configuration denial, historical replay, four final
transaction fault points, storage-success/SQL-failure retry, accumulated quota,
expired reservations, concurrent allocation, policy/session revocation during
unlocked effects, mismatched retry bodies, fence takeover, truly overlapping
same-key effects, actual COMMIT followed by synthetic lost response, replacement
replay and revoked recovery probes. Tests require an explicit disposable DB and
fresh fp_* schema. Native Worker media and actual cloud rollout evidence are
separate suites/gates.
