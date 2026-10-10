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
- Full decoding and canonical re-encoding finish before prepare can persist an
  Asset, target, intent or retained-byte reservation; invalid input leaves none.
  The canonical WebP stays request-local and bound to the original source hash,
  size and MIME. Upload then runs the common lifecycle (prepare → claim → write
  → finalize) on the server inside one request. The browser never holds an upload lease. The draft id
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
community, the caller is active and onboarded, the session is live and the Asset is ready. Everyone else, including
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
  every image route answers 404 until both ports exist. This is installation
  state, not the DB policy: an installed port with persistence disabled returns
  503 for new uploads, while currently authorized existing-image reads and
  original successful upload receipts remain available.
- Release capability `media.message-image.asset.v1` (provisional migration 139).

## Retention and deletion

This change defines the rules; it does **not** run any cleanup.

- A sent image is kept as long as its message exists. Messages are not deleted by
  any product path today, so a sent image is retained indefinitely. Retracting a
  message (#398) only hides it: the bytes route answers 404 and DTOs omit the
  image, but the Asset, object and sidecar stay in place; deleting them still
  needs the separately reviewed maintenance profile below.
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

- Reporting remains outside this change. Existing blocks deny new uploads, all
  lifecycle phases, upload receipt replay and sends in either direction. Pair
  locking and current contact checks run before and after receipts. Blocking or
  disabling the peer does not remove a current caller’s historical message read
  access; caller session/onboarding checks still run before and after object I/O.
- Bulk deletion, retention windows and orphan cleanup (see above).
- Remote Workers/R2 acceptance: only local tests and Miniflare R2 were run.

## Candidate integration

Unapplied DM SQL is renamed byte-for-byte to provisional 139 after the real
134–138 parent chain; 138 and 139 remain candidates, not deployed migrations.
Unknown browser sends retain the original caption, attachment bytes/image ID
and keys in session memory across conversation changes. Caption/attachment
edits are disabled until the original attempt is confirmed; no media is put
in localStorage. Page navigation and closing the document guard unresolved
image attempts. The page and dock guard intentional logout; actual session
revocation clears private memory. A main-window logout cannot currently consult
another popout’s pending attempt; cross-window pending coordination is not
implemented. Beforeunload is a best-effort prompt, not crash durability.
