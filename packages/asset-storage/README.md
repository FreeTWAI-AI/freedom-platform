# Asset object I/O (ASSET-A first slice)

Runtime-neutral, internal storage primitives for [UF-SPEC-ASSET-WORK](../../docs/platform-plan/execution/unified-foundation/03-assets-private-work.md) and [UF-SPEC-MEDIA](../../docs/platform-plan/execution/unified-foundation/05-media-migration.md). This is not the complete ASSET-A lifecycle. No route, DB migration, R2 binding, private Work write, background deletion or publication is enabled.

`ObjectStore` supplies immutable create-if-absent PUT, streamed GET, metadata HEAD and idempotent DELETE. Production adapters must supply atomic create-if-absent behavior, including concurrent requests; HEAD-then-unconditional-PUT is insufficient. No LIST, remote URL fetch, bucket credentials or filesystem path input is provided. Web streams, Uint8Array and Web Crypto keep the entry point runtime-neutral. Common `OpaqueId` is the single UUID validator; shared raster/container validators are reused.

## Internal effect-phase interface

1. A future short prepare transaction resolves current principal/domain/scope authority, policy, quota, target version and durable intent/fence; it allocates immutable scope/asset/representation UUIDs. Those checks are not implemented here.
2. Outside the transaction, call `preparePrivateText` or `prepareAvatar`. Call `writeVerifiedObject` with the intent's fixed `objectKey` and current resolved persistence policy. A successful PUT is always followed by a complete, bounded GET, metadata comparison and SHA-256 of actual bytes. An ambiguous PUT can recover this way; absent/corrupt/unreadable content is never success. Identical retries verify existing bytes, while different content cannot overwrite an existing key. The result is storage evidence only.
3. The future finalize transaction must re-resolve current policy/credential/domain/scope, expected target version, intent expiry/fence and applicable attempt/Grant, then atomically persist ready/pointer/Result/journal/receipt. Storage evidence is neither authorization nor a successful business receipt. Do not use this package inside a row-lock callback.

Only authoritative server policy should be passed. `PersistencePolicy` is deliberately just the revision and platform-persistence projection, not a complete data-policy contract. False, missing or non-boolean permission is rejected before reading the source or calling storage. Capture, allowed model/provider, retention, viewer and publication are separate domain policy decisions. This package has no logger. Do not log bytes or adapter exceptions. Policy and verification metadata are snapshotted before awaits; this prevents accidental attribution changes but does not replace fresh policy resolution at finalize.

`VerifiedObject` is internal and includes the raw object key. Never serialize it directly to a client. The future ArtifactRef DTO must omit keys/buckets and route all GET/HEAD/Range/conditional requests through current domain ACL. Scope in a key prevents identity collision; knowing a key does not confer read authority. Missing storage objects have no legacy fallback here.

## Fixed first-slice profiles

| Profile | Input | Stored representation |
| --- | --- | --- |
| `private-text.utf8.v1` | Exact MIME `text/plain` or `text/markdown`; nonempty, at most 256 KiB actual bytes; fatal UTF-8 validation; reject NUL/C0 controls except tab/LF/CR, and DEL | Original bytes including BOM, with no normalization; same MIME |
| `avatar.webp.v1` | Exact MIME `image/jpeg`, `image/png`, `image/webp`; nonempty, at most 2 MiB; complete static container, at most 4096×4096 | Fully decoded/oriented/resized/metadata-stripped 256×256 WebP, at most 128 KiB; quality 82, effort 3 |

The 256 KiB/nonempty/control-character rules fix this package's proposed first private-text profile; no private upload schema or HTTP activation is claimed. Text is untrusted, including HTML-looking text inside plain text or Markdown. This library does not render, execute, sanitize Markdown, detect embedded secrets or grant publication permission. Rendering must escape text and reject raw HTML/unsafe URLs. Binary/document/script/archive MIME types are unsupported. Neither profile trusts Content-Length; it is not an input.

`readBounded` uses one fixed-capacity buffer plus the final snapshot, so many tiny chunks do not grow an unbounded array of retained chunks. It cancels on error/overflow and releases its reader. Transport deadlines and client disconnect cancellation belong to the future HTTP/runtime adapter; a byte bound alone does not time out a stalled stream.

Avatar decoding is a required trusted `AvatarNormalizer` injection. In the existing Node/Worker request adapter it can call `normalizeImage(Buffer.from(bytes), spec)` from `packages/shared/image-runtime.ts`; that adapter is intentionally not imported as runtime code here. The normalizer must fully decode compressed input: framing validators alone cannot prove decodability. This slice does not replace the old avatar handler or change its transaction/response behavior.

Metadata includes actual byte size/SHA-256, content type, transform version and policy revision. R2/adapter ETag is optional opaque transport metadata and is never accepted as a content digest. Prepared Uint8Array remains mutable, so the writer snapshots and rechecks its digest and shape before any PUT. The internal range port takes one validated byte offset/length; GET returns full-representation metadata and the selected raw bytes (possibly splitting a UTF-8 code point). It does not implement HTTP Range parsing, suffix/multi-range, 206/416 or If-Range behavior.

## Fake-store evidence and remaining lifecycle work

`FakeObjectStore` is test-only and models atomically visible writes, no overwrite while an object exists, independent snapshot reads, missing deletes and injected pre/post-effect failures. Errors use fixed codes. A post-PUT failure can leave durable bytes; a post-delete failure can leave absence. Repeated verification/delete reconcile those outcomes. A successful storage verification followed by failed DB finalize can be retried by the future service with the same intent identity.

DELETE has no ACL or GC eligibility checks. The fake permits a late PUT to recreate a deleted key: permanent tombstones, deletion fences, no-attach checks, live-reference/intent/backup pins, retention and orphan reconciliation are the future DB lifecycle's responsibility. No fake GC or fake intent state machine claims to prove those concurrency guarantees. Never call DELETE from untrusted client input or activate automatic cleanup from this package.

`tests/runtime/asset-storage.test.ts` registers `ASSET-IO-01` through `ASSET-IO-20`: keys/policy, byte/UTF-8 boundaries, error sanitization, policy/metadata await barriers, real decoder constraints, concurrent immutable writes, corrupt/missing read-back, recovery and delete/range behavior. Run `node --import tsx --test tests/runtime/asset-storage.test.ts` and `npm run typecheck`. These use synthetic data and no database/network. PostgreSQL prepare/fence/finalize/GC races, Work ACLs, avatar route integration, real R2/Images, staging/prod, backup/restore and complete UF acceptance remain unverified by this slice.
