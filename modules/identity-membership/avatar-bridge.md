# Avatar read bridge (ASSET-B local increment)

Migration 080 is additive and defaults `avatar_storage_policy.mode` to `legacy`.
It does not authorize persistence/retention, bind R2, migrate old bytes, or enable
new Asset uploads. The existing avatar URLs, response DTOs and authorization
surfaces are retained. No UI changes are needed.

## Source and rollback floor

`member_avatars.storage_source` is the only source selector. `legacy` rows read
their existing bytes. `asset` rows require a current typed ready pointer and
verified object metadata; missing binding/object, corruption, disabled owner
scope/principal, or stale pointer NEVER fall back to retained bytes. Old bytes
may remain physically present until an authorized retention/cleanup process.

In bridge/r2_only mode the internal lifecycle finalize marks the source asset
while advancing the real avatar version and attaching its pointer, atomically.
`linked_at_version` is a snapshot, not another version clock. Deferred triggers
require an active pointer at that exact version, or explicit removal with null
pointer and bytes. Source asset cannot return to legacy. After leaving legacy,
policy can switch between bridge/r2_only but cannot return to a legacy-only
release. Mode rows are not data-policy evidence.

Database guards reject legacy byte INSERT/UPDATE in r2_only, and any non-null
byte UPDATE of an asset-routed row, including same-byte assignments. Normal
metadata updates and clearing retained bytes remain possible. Explicit avatar
removal clears pointer, retires the Asset, clears retained bytes and increments
the real version in one existing member command transaction; it never calls
object delete. Asset-backed upload is deliberately unavailable through the old
POST until the trusted upload facade, persistence policy and retained quota
exist. Receipt replay retains the original command namespace, body digest and
authorization-before-receipt ordering and never reattaches old content.

Legacy normalization uses two short command passes: existing receipts return
without decoding; a new effect rolls back a private internal signal, normalizes
outside locks, then rechecks authority/policy/version in the same command path.
Both new-effect passes and remove refresh session expiry with database current
time after blocking target/policy/pointer queries. This does not rewrite the
legacy core's receipt replay clock semantics.

## Reads and revocation

Member reads bind current viewer session/community/completed status and owner
visibility in one SQL snapshot. Anonymous card avatar reads bind the current
share token, share aggregate_version, enabled/include_avatar choice and owner
visibility. Shares currently have no expiry field; no fictitious TTL is added.
The same complete ACL/source/version query runs again after one bounded object
GET with actual size/SHA verification. No SQL transaction or locks span storage
I/O. Successful reads linearize at the second SQL snapshot: revocation during
GET can commit and then rejects delivery. A changed pointer/version/generation
rejects without re-reading another object. Already downloaded bytes cannot be
recalled. Asset metadata/identities are immutable, so unchanged typed pointer
and representation imply unchanged expected digest/size.

GET and HEAD execute the same ACL path. Avatar Range/conditional headers do not
create a bypass or 304/partial response: the existing full-image behavior is
preserved. Member responses are private/no-store; public-card avatars remain
no-store and require opt-in, not generic public access to personal Assets.
`PlatformRuntime.avatarAssetStore` is an optional injected server port; absent
ports produce controlled unavailable only for asset-backed reads. No environment
variable activates storage routing.

## Presence and evidence

The metadata-only `member_avatar_presence` view is used by avatar metadata,
member card, public card, two communications projections, guild directory,
service cards, two highlight projections, social posts and promotion rankings.
Presence never performs object GET/LIST and never selects blob content. Existing
version URLs and batching are preserved; the legacy query-count test now names
the view instead of its backing table.

`tests/runtime/avatar-bridge.test.ts` runs explicit fresh fp_* PostgreSQL schemas,
real image decoding and fake immutable storage. It covers default legacy, asset
read parity, missing/corrupt storage without fallback, HTTP GET/HEAD/conditional,
six current-authority revocations during GET, four share changes during GET,
removal/retirement, actor mutation, zero-I/O denied reads, direct SQL writer and
rollback-floor guards, old receipt replay, unlocked normalization, and actual
row-lock session expiry before removal. Cloud rollout/backfill/restore, complete
upload activation and physical GC remain separate acceptance gates.
