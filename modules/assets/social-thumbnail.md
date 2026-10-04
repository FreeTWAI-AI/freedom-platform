# Social-thumbnail Asset adapter

`createSocialThumbnailAssetService` is an explicitly installed server port for
manual uploads and automatic preview creation. Its canonical persistence settings come from migration100; the
closed migration102 profile uses the real community scope, post author, and
current active-post permission. Original PNG/JPEG/WebP input remains limited to
512 KiB and uses the existing 640×360 WebP normalizer outside SQL locks.

Original PUT receipts, public/member URLs, DTOs, CSRF checks, and cache headers
remain unchanged. No client `If-Match` is added. An internal `media_version`
fences asynchronous publication against original thumbnail writers and post
visibility changes; a stale intent cannot overwrite a newer source. The full
original response and typed pointer commit in the same command transaction.

Legacy mode remains the default. Migration106 routes automatic previews through
the same finite social Asset profile in nonlegacy mode. The original safe
link-preview fetch, redirect/address checks, HTML/image limits, deadline, and
normalizer remain unchanged. Already normalized preview WebP is stored exactly,
with original `youtube`/`page` provenance. Missing installed ports fail closed.
A preview without an image still creates an original plain post; it cannot
silently abandon an existing image reservation for the same receipt key.

Immutable, owner/community-bound create reservations are not domain posts.
They bind the original request and normalized preview digest, prepare/put/verify
through common intents, then insert the post, pointer, and original DTO receipt
on one current-member transaction. Generated foreign keys require published
pointers to match the real post author/community. Same-key concurrency, original
URL uniqueness and daily cap remain binding. Changed preview content cannot
rebind a pending source; an interrupted operation needs that same bounded source
again or an explicit new operation. No SQL locks span preview or object I/O.

Bridge mode retains historical bytes; Asset reads never fall back to them.
R2-only cutover now checks for remaining legacy sources/retained bytes rather
than assuming the automatic writer is unimplemented. No historical backfill,
byte purge, operator policy activation, or cloud cutover occurs in this change.
Replacement and hide/delete retire the pointer's immutable asset. Public reads
retain original active-post visibility and 300-second cache lifetime; member
reads recheck current community/session after I/O. Already downloaded bytes and
browser caches are not revoked by a later visibility change.
