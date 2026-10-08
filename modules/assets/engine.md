# Shared member-personal Asset lifecycle engine

`engine.ts` is the single prepare/claim/effect/store/finalize implementation.
`index.ts` now supplies only avatar input validation, eligibility/target locks,
avatar CAS/pointer changes, avatar facts, target metadata reads and its legacy
receipt compatibility bridge. Existing avatar method names, request fields,
prepare request digest, response shapes, scoped command operations and original
HTTP receipt hash/namespace are unchanged.

## Trusted ports, not a generic client API

`createAssetLifecycle(pool, dependencies, profile)` accepts a trusted server
code object. The module export is an internal server-to-server port, not a
generalized public API. It is not registered as an HTTP handler, and no client can submit
a profile, purpose, target discriminator, SQL callback or VerifiedObject. The
supported manifest combinations are fixed: member.avatar/avatar (2 MiB input,
128 KiB WebP output), work.private-draft/work.private-result/draft (256 KiB
UTF-8 text), and work.tenant-result/work.tenant-result/draft (256 KiB UTF-8
text, tenant authority only). The private profile requires migration 084 and a
separately reviewed domain adapter/policy; merely having the engine branch does
not enable private writes. The tenant profile requires migration 123 and
`tenant-lifecycle-authority.ts`. The domain media profiles (service cover, event
banner/video/highlight, social thumbnail, skill image) and
member.message-image/member.message-image/image (2 MiB input, 1 MiB canonical
WebP output with an `inside` fit, sender-owned personal scope; migration 134,
see [message-image.md](message-image.md)) are closed in the same way.

The profile owns strict domain input parsing, representation processing,
current target eligibility/locks, the trusted DB-only policy/capacity resolver,
publication locks and real domain CAS/pointer/facts. The engine owns member
scope authorization, command receipts, policy revision and required quota
validation, bounded input/actual source SHA, immutable object effects/readback,
intent state/fence/lease/expiry, ready/finalized state and scoped journal calls.
Representations are checked against profile MIME/transform/output cap before
PUT. The target domain returns the version resulting from its publication; the
engine never independently increments a Work version. Immutable Work Result
history must use `retireReplacedAsset=false`.

`finalizeVia` is a narrow in-process callable command bridge for avatar's old
receipt adapter. It still performs the engine's own current DB inspection,
object verification and revalidation. It does not accept a serialized storage
proof. Its command adapter must supply the live scopedJournal context; the
shared core rejects forged/reused/wrong-transaction contexts.

## Lock and decision order

Prepare uses current user/session/principal/personal scope, then the scoped
receipt advisory lock, then `asset.quota/v1/{scope_id}/{purpose}`, then the
domain target and policy rows. The quota advisory serializes reservations for
one owner/purpose across multiple Work targets. It does not upgrade a shared
scope lock to UPDATE; another owner's allocation is independent. Idempotent
replay cannot allocate or double-charge a reservation.

Other phases first read only immutable intent routing metadata bound to the
current owner/scope/purpose/target kind, without a lifecycle row lock. They then
lock the domain target/pointer, re-read and lock the intent, and lock the current
Asset. State/fence never come from the initial routing hint. If the profile
retires the previous Asset, both current and previous Asset rows are locked in
UUID order before policy/publication locks and the final database-clock checks.
This agrees with backup capture order and prevents a later retirement UPDATE
from waiting past session expiry after authorization was already checked.

`lockTarget` and `lockPublication` must acquire all required domain publication
locks before returning. `publish` only reuses those locks; it must not perform
external I/O or introduce another blocking lock after the decision-clock check.
The engine then verifies current policy, lease/intent expiry and session expiry,
checks real target version, marks ready, calls domain publication, optionally
retires the former Asset, finalizes the intent and appends scoped metadata facts
in the command's same transaction. Any failure rolls back all SQL effects.

Source processing and every object-store call occur outside these transactions.
GC observations never automatically release retained quota. Schema ownership,
typed FKs, immutable routing fields, object identity and deletion fences remain
mandatory backstops; the engine is not a substitute for those constraints.

## Local evidence

The existing avatar lifecycle, independent races, bridge, upload-facade and
legacy avatar suites remain the regression oracle. `asset-engine.test.ts`
additionally proves the quota advisory namespace and target-lock ordering,
real-clock expiry after a demonstrated quota wait, previous-Asset prelock
expiry with zero object GETs, exact old prepare digest, and invalid mixed
profile manifests. The combined local engine/avatar/maintenance regression run
passed 127 tests with no skips. Independent review reproduced the former
late-retirement clock bug against the first extraction checkpoint, then verified
the unchanged reproduction and 89 combined tests against the sorted prelock fix.
The sorted prelock followup is required, not optional. Cross-Work/domain acceptance belongs with the actual
084 adapter and its independent tests, not a fabricated generic test target.
