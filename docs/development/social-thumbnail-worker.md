# Manual social thumbnail Worker installation

`FREEDOM_SOCIAL_THUMBNAIL_ENABLED=true` explicitly installs the genuine manual
thumbnail lifecycle on the main Worker using the existing private MEDIA bucket
and IMAGES. Only absent, `false` and `true` flags are accepted. Explicit activation
without required native bindings refuses requests before SQL or route effects.
Defaults and actual deployment profiles remain inactive.

The service uses `resolveSocialThumbnailUploadPolicy` on the current transaction:
nonlegacy storage mode requires independent community thumbnail DB persistence
permission, revision and retained quota. The application role cannot change those
fields. Original PUT, full DTO, URL, author/CSRF checks and receipt semantics remain;
no new public version or If-Match field is required. Verified asset reads preserve
original current community membership and active-post ACLs and public 300-second
cache behavior. Asset sources fail closed when the object store is unavailable.
Replacement and deletion retire assets; neither physically deletes R2 objects.

Automatic preview creation remains the original legacy writer. This increment
installs only manual uploads, and canonical SQL still refuses R2-only activation.
It does not claim automatic previews or backfill are migrated.

The native test loads the ordinary main Worker bundle against restricted-role
PostgreSQL, Hyperdrive and native R2. It verifies default legacy HTTP upload,
missing-binding refusal before legacy effects, canonical consent/quota, original
DTO replay, normalized 640x360 WebP SHA, member/public reads, author/CSRF denial,
replacement retirement and deleted-post ACLs. Domain posts are explicit synthetic
SQL fixtures so no preview or provider network calls occur. IMAGES uses the local
Miniflare emulator. Remote bindings, actual cloud processing, deployed policy,
restore, backfill and staging acceptance remain unverified.
