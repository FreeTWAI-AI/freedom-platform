# Event video Worker installation

`FREEDOM_EVENT_VIDEO_ENABLED=true` installs the genuine request-scoped event video
lifecycle and reader on the main Worker using the existing private MEDIA bucket.
Only absent, `false` and `true` are accepted. Explicit activation requires native
MEDIA before SQL or route effects; IMAGES is not required for video. Defaults and
actual deployment profiles remain inactive.

`resolveEventVideoUploadPolicy` requires the independent community event video
DB policy, explicit persistence consent, revision and retained quota. The runtime
SQL role cannot change that policy. Original organizer, current membership,
pending/future, CSRF, CAS, byte signature, size and idempotency checks remain.
The reader uses canonical pinned R2 ETags and current ACL checks; whole GET verifies
SHA-256, while partial responses retain the canonical pinned-range semantics.
Removal retires the asset and does not authorize physical object garbage collection.

The native workerd test loads the ordinary main Worker bundle with restricted
Hyperdrive SQL and native R2. Synthetic bounded WebM-signature bytes exercise the
original HTTP upload DTO, replay, full GET, HEAD, 206/416 and stale If-Range, public and private
ACL transitions and removal. This does not claim codec decoding/playback, paid
provider use, remote cloud bindings, deployed policy, restore or staging readiness.
