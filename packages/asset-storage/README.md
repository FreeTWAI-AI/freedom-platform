# Asset object I/O (ASSET-A first slice)

Runtime-neutral, internal storage primitives for [UF-SPEC-ASSET-WORK](../../docs/platform-plan/execution/unified-foundation/03-assets-private-work.md) and [UF-SPEC-MEDIA](../../docs/platform-plan/execution/unified-foundation/05-media-migration.md), plus an explicitly injected native R2 adapter. This package does not itself enable routes, database state, a deployed bucket/binding, background deletion or publication.

The [avatar lifecycle and read bridge](../../modules/assets/README.md) compose these primitives with durable PostgreSQL intents and fenced leases. The [existing POST facade](../../modules/assets/avatar-upload.md) preserves old receipts and responses, while default configuration remains legacy/persistence-disabled. Separate [maintenance](../../modules/assets/maintenance.md) owns deletion fences and backup pins. These local integrations do not establish production activation, cloud backup/restore or private AI execution; the evidence below remains this I/O package's own boundary.

`ObjectStore` supplies immutable create-if-absent PUT, streamed GET, metadata HEAD and idempotent DELETE. Production adapters must supply atomic create-if-absent behavior, including concurrent requests; HEAD-then-unconditional-PUT is insufficient. No LIST, remote URL fetch, bucket credentials or filesystem path input is provided. Web streams, Uint8Array and Web Crypto keep the entry point runtime-neutral. Common `OpaqueId` is the single UUID validator; shared raster/container validators are reused.

## Internal effect-phase interface

1. The caller's short prepare transaction resolves current principal/domain/scope authority, policy, quota, target version and durable intent/fence; it allocates immutable scope/asset/representation UUIDs. Those checks belong to the lifecycle, not this package.
2. Outside the transaction, call `preparePrivateText` or `prepareAvatar`. Call `writeVerifiedObject` with the intent's fixed `objectKey` and current resolved persistence policy. A successful PUT is always followed by a complete, bounded GET, metadata comparison and SHA-256 of actual bytes. An ambiguous PUT can recover this way; absent/corrupt/unreadable content is never success. Identical retries verify existing bytes, while different content cannot overwrite an existing key. The result is storage evidence only.
3. The caller's finalize transaction must re-resolve current policy/credential/domain/scope, expected target version, intent expiry/fence and applicable attempt/Grant, then atomically persist ready/pointer/Result/journal/receipt. Storage evidence is neither authorization nor a successful business receipt. Do not use this package inside a row-lock callback.

Only authoritative server policy should be passed. `PersistencePolicy` is deliberately just the revision and platform-persistence projection, not a complete data-policy contract. False, missing or non-boolean permission is rejected before reading the source or calling storage. Capture, allowed model/provider, retention, viewer and publication are separate domain policy decisions. This package has no logger. Do not log bytes or adapter exceptions. Policy and verification metadata are snapshotted before awaits; this prevents accidental attribution changes but does not replace fresh policy resolution at finalize.

`VerifiedObject` is internal and includes the raw object key. Never serialize it directly to a client. The future ArtifactRef DTO must omit keys/buckets and route all GET/HEAD/Range/conditional requests through current domain ACL. Scope in a key prevents identity collision; knowing a key does not confer read authority. Missing storage objects have no legacy fallback here.

## Fixed first-slice profiles

| Profile | Input | Stored representation |
| --- | --- | --- |
| `private-text.utf8.v1` | Exact MIME `text/plain` or `text/markdown`; nonempty, at most 256 KiB actual bytes; fatal UTF-8 validation; reject NUL/C0 controls except tab/LF/CR, and DEL | Original bytes including BOM, with no normalization; same MIME |
| `avatar.webp.v1` | Exact MIME `image/jpeg`, `image/png`, `image/webp`; nonempty, at most 2 MiB; complete static container, at most 4096×4096 | Fully decoded/oriented/resized/metadata-stripped 256×256 WebP, at most 128 KiB; quality 82, effort 3 |

The 256 KiB/nonempty/control-character rules fix this package's proposed first private-text profile; no private upload schema or HTTP activation is claimed. Text is untrusted, including HTML-looking text inside plain text or Markdown. This library does not render, execute, sanitize Markdown, detect embedded secrets or grant publication permission. Rendering must escape text and reject raw HTML/unsafe URLs. The original text/avatar preparation APIs reject binary/document/script/archive MIME types. Neither profile trusts Content-Length; it is not an input.

`readBounded` uses one fixed-capacity buffer plus the final snapshot, so many tiny chunks do not grow an unbounded array of retained chunks. It cancels on error/overflow and releases its reader. Transport deadlines and client disconnect cancellation belong to the future HTTP/runtime adapter; a byte bound alone does not time out a stalled stream.

Avatar decoding is a required trusted `AvatarNormalizer` injection. In the existing Node/Worker request adapter it can call `normalizeImage(Buffer.from(bytes), spec)` from `packages/shared/image-runtime.ts`; that adapter is intentionally not imported as runtime code here. The normalizer must fully decode compressed input: framing validators alone cannot prove decodability. This slice does not replace the old avatar handler or change its transaction/response behavior.

Metadata includes actual byte size/SHA-256, content type, transform version and policy revision. R2/adapter ETag is optional opaque transport metadata and is never accepted as a content digest. Prepared Uint8Array remains mutable, so the writer snapshots and rechecks its digest and shape before any PUT. The internal range port takes one validated byte offset/length; GET returns full-representation metadata and the selected raw bytes (possibly splitting a UTF-8 code point). It does not implement HTTP Range parsing, suffix/multi-range, 206/416 or If-Range behavior.

## Fake-store evidence and remaining lifecycle work

### Native R2 adapter

Import `createR2ObjectStore` from [r2.ts](r2.ts) with an explicit native bucket
binding. No bucket, credential, environment setting, route or public URL is
created or discovered. The implementation follows the
[R2 Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/).
Conditional PUT uses `etagDoesNotMatch: '*'`; a precondition failure means only
`exists`, not same content. Call `writeVerifiedObject` for full read-back and
actual SHA-256 comparison, including a PUT whose outcome is unknown. There is
no unconditional write retry. ETag is not a content digest.

The adapter validates its versioned metadata, copies input before awaits and
bounds native response bytes to the profile size. A range is snapshotted,
validated against HEAD, and GET is conditioned on the same ETag; metadata-only
conditional failure is unavailable. Full GET accepts an absent range or exactly
offset zero/full length, as returned by the native runtime. Internal GET returns
only the shared metadata, opaque ETag and bounded body; domain ACL still belongs
to the caller. Upstream messages and arbitrary metadata are not propagated.

Delete is disabled unless a server-owned maintenance adapter explicitly sets
`allowDelete: true`. Its `deleted`/`missing` result describes the existence
observed before deletion, not an atomic existence result or durable tombstone.
The native R2 delete API returns no existence result. GC must still provide DB
fencing, pins and late-PUT reconciliation; this option does not authorize GC.

[Native binding tests](../../tests/runtime/asset-r2.test.ts) run actual local
workerd R2 via Miniflare with synthetic ephemeral objects, not cloud credentials.
They cover conditional/concurrent writes, ranges, input snapshots, digest
corruption, unknown outcomes, bounds, sanitized errors and disabled deletion.
Cloud/staging/prod, backup/restore and route activation are separate evidence.

The Worker adapter accepts an optional, request-scoped `MEDIA` native binding and
passes a delete-disabled store to avatar reads and the compatible upload facade. Missing or invalid storage leaves
asset-backed reads unavailable without breaking login/health or falling back to
retained legacy bytes. This wiring does not create a bucket, add a deployed
binding, change the default legacy write mode, or enable maintenance.

`FakeObjectStore` is test-only and models atomically visible writes, no overwrite while an object exists, independent snapshot reads, missing deletes and injected pre/post-effect failures. Errors use fixed codes. A post-PUT failure can leave durable bytes; a post-delete failure can leave absence. Repeated verification/delete reconcile those outcomes. A successful storage verification followed by failed DB finalize can be retried by the future service with the same intent identity.

DELETE has no ACL or GC eligibility checks. The fake permits a late PUT to recreate a deleted key: permanent tombstones, deletion fences, no-attach checks, live-reference/intent/backup pins, retention and orphan reconciliation belong to the separate DB maintenance service. This package alone does not prove those concurrency guarantees. Never call DELETE from untrusted client input or activate automatic cleanup from this package.

`tests/runtime/asset-storage.test.ts` registers `ASSET-IO-01` through `ASSET-IO-24`: keys/policy, byte/UTF-8 boundaries, error sanitization, policy/metadata await barriers, real decoder constraints, concurrent immutable writes, corrupt/missing read-back, recovery and delete/range behavior, pre-allocation bounds and malformed adapter output. Run `node --import tsx --test tests/runtime/asset-storage.test.ts` and `npm run typecheck`. These use synthetic data and no database/network. PostgreSQL prepare/fence/finalize/GC races, Work ACLs, avatar route integration, real R2/Images, staging/prod, backup/restore and complete UF acceptance remain unverified by this slice.


## Purpose profiles and legacy media

`profiles.ts` fixes storage limits for the seven existing media purposes; these
limits describe stored representations, not permission to upload. The highlight
thumbnail has its own fixed variant profile. No caller can supply a profile with
arbitrary caps, MIME types or transform versions.

| Profile ID | Maximum stored bytes | Existing source |
| --- | --- | --- |
| `member.avatar` | 128 KiB | `modules/identity-membership/avatars.ts` |
| `skill.submission-image` | 512 KiB | `modules/skill-submissions/payload.ts` |
| `community.event-banner` | 512 KiB | `modules/skill-submissions/payload.ts` |
| `community.event-video` | 20 MiB | `modules/community/events.ts` |
| `community.event-highlight` | 1 MiB | `modules/community/event-highlights.ts` |
| `community.event-highlight.thumbnail` | 200 KiB | `modules/community/event-highlights.ts` |
| `community.social-thumbnail` | 512 KiB | `modules/skill-submissions/payload.ts` |
| `member.service-cover` | 512 KiB | `modules/skill-submissions/payload.ts` |

Raster legacy profiles permit PNG/JPEG/WebP; video permits MP4/WebM. Media
metadata carries the exact `profileId` and its fixed `legacy-bytes.v1` transform.
Changing MIME, purpose, variant or cap cannot borrow the avatar or text profile.
Existing avatar/text metadata without `profileId`, normalization and caps remain
unchanged. Common byte-copy, bounded-read and SHA-256 primitives now have an
independent maximum of 20 MiB; each preparation/writer validates its narrower
purpose before I/O. The fake and native adapters validate the same metadata.

`prepareLegacyMediaRepresentation(body, mime, profileId, policy)` preserves the
bytes of an existing domain-validated representation. It checks nonempty bytes,
actual size, static raster framing (at most 8192 per axis/40 million pixels) or
the **existing** MP4 `ftyp`/WebM EBML header rules, then records their actual hash.
Header checks do not prove a complete playable video or decoder success. It is
not a replacement for new-upload domain decoding, orientation, thumbnail pairing,
SSRF checks or variant-specific dimensions. Such uploads must retain their
existing normalizers before preparing stored representations. An invalid legacy
row remains an exception; this library neither reencodes nor repairs it. The
media writer rechecks framing/header and digest after snapshotting caller bytes;
it does not apply the avatar's 256×256 rule to other purposes.

Native media GET and **all** native range GET return lazy exact-length bounded
streams. They never accumulate a whole object to serve a partial range; byte
length validation completes as the stream is consumed. Consumer cancellation
reaches the native reader and releases its lock. Full old avatar/text GET remains
eager to preserve its existing error timing. Whole `readVerifiedObject` still
accumulates bounded bytes and checks the full SHA-256 before returning evidence.

`readPinnedObjectRange(store, key, expected, range, expectedEtag)` requires a
caller-retained metadata/version pin. R2 additionally obtains HEAD and sends a
conditional native range GET using that ETag, checking returned metadata, version
and exact range. The helper returns `integrity: 'immutable-etag-range'` and
`wholeDigestVerified: false`: a partial response **cannot** verify the full
SHA-256. The pin relies on the adapter's immutable-version semantics and a
previously verified whole representation; it is not a substitute for ACL,
attachment readiness or cryptographic proof of partial contents. Native ETags
remain opaque transport versions, never content hashes. Cancellation and
truncated/oversized streams may fail after response bytes were delivered; domain
HTTP wrappers must handle that honestly. No HTTP Range parser or 206/416,
If-Range, player seek, deployed R2, backfill or cloud configuration is claimed.

`tests/runtime/asset-media-profiles.test.ts` exercises synthetic 20 MiB MP4 bytes
through shared preparation/writer in Node and local workerd R2 readback, native ranges,
lazy pull/cancel, stale pins, purpose caps, invalid metadata, fixed header/raster
checks, distinct non-avatar WebP and uncertain PUT reconciliation. These are
local storage semantics, not an uploaded real video or cloud delivery proof.

`tests/worker/media-object-io.test.ts` separately executes the shared preparation,
writer, full 20 MiB SHA readback and conditional range cancellation **inside the
actual workerd isolate**, with no Node compatibility flags. Its synthetic MP4
header is not a playable video. This local proof does not establish Cloudflare
CPU/memory quotas, real player seek, remote R2 configuration or domain adapters.
Full digest verification still buffers the bounded whole representation; partial
range streaming only pins the immutable ETag, not a whole-content SHA proof.
