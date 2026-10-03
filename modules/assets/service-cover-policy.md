# Service-cover persistence policy

Migration 100 adds explicit operator-owned settings to `domain_media_storage_policy`.
Every existing row starts with `persistence_allowed=false`, and null revision and
retained-byte limit. Changing `mode` to `bridge` grants no persistence permission.

For `member.service-cover`, an operator must choose a canonical `policy_revision`,
explicitly allow persistence, and set a positive decimal `retained_byte_limit`.
The limit charges verified object bytes, outstanding reservations, retired objects,
and retained legacy cover bytes. No application quota or revision is guessed.
A limit below the profile's 512 KiB reservation cannot permit an upload.

The installed adapter uses `resolveServiceCoverUploadPolicy` from
[media-domain.ts](media-domain.ts). The lifecycle intersects the canonical database
policy with the installed server resolver: both must permit persistence, revisions
must agree, and the smaller retained-byte limit applies. A callback returning true
cannot override database prohibition. Policy rows stay locked through each SQL
phase; publication checks current policy after object verification and target
locks, with current session and lease checks before commit.

Policy revocation blocks preparation, transport progression, and publication;
it does not delete already published objects or revoke downloaded bytes. Revision
changes invalidate intents pinned to the old revision. Retained legacy bytes remain
until a separately authorized migration and recovery procedure clears them.
Asset reads never fall back to retained database bytes. Worker installation flags,
R2 bindings, a storage mode, and policy permission are separate prerequisites.
Other domains remain disabled until their own closed adapters are installed.

The runtime grants template removes all table and column write privileges from
`domain_media_storage_policy`. It grants SELECT and UPDATE on `policy_lock` only;
that column is generated as constant zero and accepts only DEFAULT assignments.
This permits PostgreSQL row locking without granting policy mutation. The guard
rejects inherited/PUBLIC write privileges, role memberships, administrative role
attributes, and a missing or mutable lock column. Reapply the grants after migration
or restore; policy changes require the separate operator/migrator role.
