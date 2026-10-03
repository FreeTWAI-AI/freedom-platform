# Social-thumbnail Asset adapter

`createSocialThumbnailAssetService` is an explicitly installed server port for
manual uploads. Its canonical persistence settings come from migration100; the
closed migration102 profile uses the real community scope, post author, and
current active-post permission. Original PNG/JPEG/WebP input remains limited to
512 KiB and uses the existing 640×360 WebP normalizer outside SQL locks.

Original PUT receipts, public/member URLs, DTOs, CSRF checks, and cache headers
remain unchanged. No client `If-Match` is added. An internal `media_version`
fences asynchronous publication against original thumbnail writers and post
visibility changes; a stale intent cannot overwrite a newer source. The full
original response and typed pointer commit in the same command transaction.

Legacy mode remains the default. Automatic link previews still use the original
legacy byte writer with original `youtube`/`page` provenance. Bridge mode supports
manual Asset publication and retains historical bytes, but Asset reads never
fall back to them. R2-only cutover is refused until the automatic writer has also
been migrated. Replacement and hide/delete retire the pointer's immutable asset;
historical database bytes remain retained. Public reads retain the original
active-post visibility rule and 300-second cache lifetime; member reads also
recheck the current community/session after object I/O. Already downloaded bytes
and existing browser caches are not revoked by a later visibility change.
