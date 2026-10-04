# Event highlight pair Worker installation

`FREEDOM_EVENT_HIGHLIGHT_ENABLED=true` explicitly installs the existing paired
highlight service on the main Worker using the existing private MEDIA bucket and
IMAGES. Only absent, `false` and `true` flags are accepted. Every enabled finite
media lifecycle requires all native R2 factory methods (`get`, `put`, `head`,
`delete`); enabled image lifecycles also require IMAGES `info` and `input`.
Incomplete bindings refuse requests before SQL or legacy route effects. Defaults
and actual deployment profiles remain inactive.

The service uses canonical independent community highlight persistence policy,
revision and retained quota. Original any-current-member photo/poster upload and
uploader/organizer/admin removal permissions remain. Raw input retains its original
10 MiB limit and normalizer. Main image and thumbnail have their fixed profiles,
common intents and fences; both publish with original metadata and command receipt
in one transaction. Original DTOs, URLs, public cache and current ACLs remain.
Asset sources cannot fall back to SQL bytes, and removal does not perform R2 GC.

The native test loads the canonical main Worker bundle against restricted-role
PostgreSQL, Hyperdrive, native R2 and the local IMAGES emulator. It verifies legacy
default behavior, missing/partial native binding refusal before effects, consent,
quota, paired DTO replay and verified WebP bytes. Test-only forwarding wrappers
expose genuine native get/put without head/delete, interrupt the second object PUT,
and call the original authenticated removal route during native object GET.
Those cases prove complete binding readiness, no single-variant publication,
same-key recovery and current ACL denial after I/O. Removal by uploader, organizer
and an explicitly provisioned synthetic admin retires both assets. No outbound
provider or preview requests occur. Matching image aspect ratio avoids claiming
local emulator support for padded contain transforms.

Remote cloud bindings, image processing, deployed policy, backfill, restore,
physical deletion and staging acceptance remain unverified.
