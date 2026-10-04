# Member service cover Worker installation

The main Worker installs the genuine cover lifecycle only when
`FREEDOM_SERVICE_COVER_ENABLED` is literal `true` and the existing native `MEDIA`
binding can construct the ordinary nondeleting R2 store. No default Worker or
deployment profile enables this port. `IMAGES` is still required for verified
normalization; original upload formats, byte limits and WebP profile remain.

The lifecycle uses `resolveServiceCoverUploadPolicy` on the current SQL
transaction. A nonlegacy storage mode alone does not grant persistence. The
canonical row must explicitly permit persistence and supply its revision and
retained-byte quota; the installed resolver cannot override that policy. All
original owner/session/CSRF, idempotency, CAS, quota and publication checks remain.
Missing installation or policy fails closed, without old-byte fallback in an
asset storage mode. The same environment private bucket is used for avatars,
private assets and these domain covers; no second storage truth is introduced.

`tests/worker/service-cover-assets.test.ts` loads the ordinary Wrangler platform
bundle in native workerd with an explicitly owned restricted application SQL role,
Hyperdrive and native ephemeral R2. IMAGES uses Miniflare's local low-fidelity
emulator. The fixture tests absent/malformed opt-in, missing bindings, mode without
permission, retained quota, owner/CSRF denial, verified upload, exact original DTO
replay, owner/public reads, pause ACL and removal without unapproved object GC.
It requires an owned loopback/Unix `fp_*` test admin URL and removes only its own
database/roles. No paid image/provider calls or remote resource changes occur.

Local workerd evidence does not prove actual cloud bindings, policy provisioning,
remote image processing, backfill completion, restore, GC or staging acceptance.
Those remain governed by the existing release and media migration procedures.
