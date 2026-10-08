# Direct-message image Asset adapter (#230)

`createMessageImageAssetService` is an explicitly installed server port for one
image per direct (1:1) message. It is not an arbitrary attachment store: PNG, JPEG
or WebP input only, up to 2 MiB, and only the re-encoded WebP is ever kept.
Groups, channels, public pages and external image URLs are out of scope.

## Model

- Purpose `member.message-image`, variant `image`, profile and transform
  `member.message-image.webp.v1`. Scope is the **sender's personal scope**; the
  Asset is owned by the sender, never by the conversation.
- A typed sidecar `member_message_image_asset_targets` is the *draft attachment*.
  It exists before its message: the sender uploads to a draft bound to exactly one
  recipient, then the message sets `message_id`. The sidecar references the message
  (as every other typed target references its domain row), so `member_direct_messages`
  itself gains no foreign key into the Asset graph.
- Composite keys bind `community_id`, sender and recipient of the draft to the
  message, `UNIQUE(message_id)` allows one image per message, and triggers make a
  linked/attached target immutable. A draft links one Asset once.
- Upload runs the common lifecycle (prepare → claim → write → finalize) on the
  server inside one request. The browser never holds an upload lease. The draft id
  is derived from sender, recipient and `Idempotency-Key`, so a lost response
  replays to the same image and never creates a second Asset.

## Re-encoding

Input is checked for MIME, signature, animation (APNG / animated WebP), 4096 px and
16.7 MP bounds, then fully decoded, orientation applied, metadata (EXIF, GPS, ICC,
XMP) dropped and re-encoded to canonical WebP. The longest edge is limited to
1920 px with the aspect ratio kept (`inside` fit); smaller images are **not**
enlarged. Output above 1 MiB is refused with a Chinese message. This is the one
image profile that does not letterbox to a fixed canvas, so screenshots stay
readable.

## Access

Authority is the message row, not the Asset scope:
`GET /api/v1/me/conversations/:peer/messages/:messageId/image` returns the bytes
only when the caller is the sender or recipient of that exact message in their
community, the session is live and the Asset is ready. Everyone else, including
members of other communities and callers who name the wrong peer, gets `404
media_not_found`. The same query runs before and after object I/O, so a session
revoked during the read yields no bytes. There is no public URL, no signed URL and
no CDN cache: `Cache-Control: private, no-store`, `Vary: Cookie`, `nosniff`. The
DTO exposes only `image: {content_type, byte_size}`.

Image messages create no notification, so no image bytes reach a notification.
Message `body` is the caption, or the placeholder `[圖片]` for an image-only
message, which is what previews and search see.

## Policy and installation

- `domain_media_storage_policy` row `member.message-image` starts `mode='legacy'`
  (**OFF**). There is no legacy byte source, so `bridge` and `r2_only` are the same ON
  state; the operator enables the feature with a non-legacy mode (`r2_only`
  recommended), a policy revision, a `retained_byte_limit` (≥ 1 MiB) and
  `persistence_allowed=true`. Like every media purpose, the mode cannot return to
  `legacy` once raised; `persistence_allowed=false` is the stop switch.
- Worker flag `FREEDOM_MESSAGE_IMAGE_ENABLED` defaults off and, when `"true"`,
  requires `MEDIA` and `IMAGES`. Node/tests inject `messageImageAssets` and
  `messageImageAssetStore`. `/api/v1/site` reports `message_images_enabled`;
  every image route answers 404 until both ports exist.
- Release capability `media.message-image.asset.v1` (migration 134).

## Retention and deletion

This change defines the rules; it does **not** run any cleanup.

- A sent image is kept as long as its message exists. Messages are not deleted by
  any product path today, so a sent image is retained indefinitely.
- A draft that is never sent (upload succeeded, message not sent) stays a `ready`
  Asset owned by the sender and counts against `retained_byte_limit`. Nothing
  expires it automatically.
- Message-image Assets are **not** supported by the retired-domain GC:
  `lock_asset_deletion_domain` rejects the purpose and `asset_maintenance_policy`
  stays disabled. Removing orphaned drafts, or deleting images when a member
  leaves, needs a separately reviewed maintenance profile and operator approval.
  Until then an orphaned draft is bounded only by the per-member quota and the
  upload rate limit (12 per minute per member, 120 per minute globally).
- Backup/restore treat these objects like every other Asset (`asset_objects` rows
  and the immutable object key); no special handling is added.

## Not covered

- Blocking and reporting (#251): when member blocking lands, its read rule must be
  applied to `imageSnapshot` the same way it is applied to message text.
- Bulk deletion, retention windows and orphan cleanup (see above).
- Remote Workers/R2 acceptance: only local tests and Miniflare R2 were run.
