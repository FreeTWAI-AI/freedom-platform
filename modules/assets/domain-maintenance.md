# Retired domain media maintenance (108)

This increment extends the existing 082 maintenance port to retired, unreferenced
service covers, event banners, event videos, social thumbnails, skill images and
both highlight representations. Private drafts are excluded. Avatar eligibility
and its original seven-column upload INSERT remain unchanged.

Both the installed host `domainMediaEnabled: true` and canonical DB
`asset_maintenance_policy.domain_media_enabled = true` are required at claim,
lease takeover and immediately before delete I/O. Both default off. Retention,
current typed pointers, common finalized intents, backup capture barriers, pins
and permanent deletion fences still apply. RLS or unsupported shapes on decision
relations fail closed. No background scheduler or real bucket deletion is enabled.

**Deployment prerequisite:** all active writers, permitted rollback binaries and
retained releases that can issue PUTs must support the write-effect protocol and
be fenced according to release compatibility before domain GC can be enabled.
An explicit host boolean is not independently verified release evidence. A new
asset's coverage bit cannot protect against an old binary replaying that intent
and issuing an unrecorded external PUT. Do not activate during mixed-version
writer operation.

Only new instrumented domain intents carry immutable write-effect coverage.
Existing assets default to false and cannot be adopted by UPDATE. The effect
ledger references the existing common intent, asset and fence; it does not own
object metadata or create a second storage catalog. Engine, skill grant and
operator cover/video writers admit effects before external PUT. The wrapper is
inside the operator deadline wrapper and observes the original trusted adapter
promise even after its caller times out. Actual fulfillment settles that effect;
rejection remains unknown, including when a later full readback verifies bytes.
HEAD, another PUT, elapsed clocks and successful publication do not settle an
older started or unknown effect. Settlement tickets/functions are not exported.
Unknown history blocks GC until a separately reviewed backend-specific proof
exists; this increment implements no such proof or retrospective reconciliation.

The original domain must actually retire an asset and remove its typed pointer.
Hidden, paused, revoked or expired ACLs alone never make it eligible. In particular,
the original skill image domain retains its pointer after revocation and has no
retirement/removal operation; this change does not invent one. Coverage does not
claim every source's end-to-end removal workflow is implemented.

`tests/runtime/domain-media-gc.test.ts` uses full PostgreSQL migrations and an
isolated native Miniflare R2 bucket. It exercises actual banner publication and
original attachment deletion, delayed PUT versus a newer publishing lease,
committed-but-rejected PUT/full-readback uncertainty, pins, RLS, immutable coverage
and revocation of both deletion opt-ins. Native R2 I/O runs locally; hashing and
lifecycle code in this suite run in Node. It establishes neither real cloud
quotas nor production activation, backup copies, restore or physical erasure.
