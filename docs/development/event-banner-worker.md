# Event banner Worker installation

`FREEDOM_EVENT_BANNER_ENABLED=true` installs the existing banner lifecycle on the
main Worker using the environment's existing private MEDIA bucket and IMAGES.
The flag accepts only absent, `false` or `true`; explicit activation without
required native bindings refuses requests before SQL or route effects. No default
or deployment profile activates it. Cover activation follows the same readiness
rule; absent flags retain original legacy behavior.

The request-scoped genuine service uses `resolveEventBannerUploadPolicy` and
community-owned `community.event-banner` policy, independent of private work
consent. Nonlegacy mode requires explicit DB persistence permission, revision and
retained quota. The runtime SQL role cannot modify those policy fields. Original
organizer, current membership, future/pending, CSRF, CAS, replay and bounded image
normalization checks remain. Removal does not authorize R2 garbage collection.

`tests/worker/event-banner-assets.test.ts` runs the ordinary Wrangler bundle in
native workerd against an owned restricted PostgreSQL role, Hyperdrive and native
R2. It verifies original HTTP DTO/ETag replay, 900x1200 portrait WebP bytes, private
and public ACLs, lifecycle denial and removal with no external calls. IMAGES uses
the local Miniflare emulator and a matching aspect ratio; this proves neither
remote image processing nor local emulator support for padded contain transforms.
The fixture cleans only its own database/roles. Actual cloud bindings, deployed
policy, migration/backfill, restore and staging acceptance remain unrun.
