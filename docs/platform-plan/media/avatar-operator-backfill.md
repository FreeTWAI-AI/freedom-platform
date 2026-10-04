# Historical avatar operator backfill

Migration 111 extends the existing approved operator job, item, common intent,
Asset and immutable PUT-effect lifecycle with `member.avatar`. It neither creates
member sessions nor grants, and does not authorize an upload on behalf of a user.
The current owner must be active, have completed required onboarding, retain the
avatar's community mapping, and have an active person principal/personal scope.
The original `avatar_storage_policy` must explicitly permit bridge persistence
with a revision and retained-byte quota. Domain-media policy is not substituted.

Only the existing historical static WebP bytes, at most 128 KiB, are preserved.
Their metadata uses `profile_id=member.avatar` and
`member.avatar.legacy-bytes.v1`. Ordinary avatar uploads keep
`avatar.webp.v1` and NULL profile metadata. The operator-only representation is
bound to the exact currently approved plan/job/item, original SHA/size/version,
owner and common intent. Publication advances the actual avatar version and
updates its existing typed pointer atomically; historical bytes remain in SQL.
An intentional removed avatar with NULL bytes is not a source to migrate.
Blocked owners, missing authority, changed source and revoked policy prevent a
claim of complete migration. Unknown PUT acknowledgement remains unknown even
when a later verified GET permits the same Asset to resume.

Original private-session and public-share readers keep their current ACL queries
before and after object I/O. Asset reads never fall back to historical SQL bytes.
The optional persisted profile is checked against actual object metadata; NULL
continues to represent the original avatar normalizer.

Covered/operator avatar Assets are excluded from the existing avatar garbage
collector, including tombstone creation or takeover. This is a conservative
retention boundary, not an implementation of unknown-PUT reconciliation or
avatar cleanup. Existing uncovered avatar upload/GC behavior is unchanged. No
cloud flags, consent, GC scheduling, source deletion or remote installation is
performed by this migration. Local native R2 object-copy restore evidence does
not establish a database restore or staging acceptance.
