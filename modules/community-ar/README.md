# Community image AR

This increment reuses the browser image-target engine from Hao's `AR_HAO`
project for published member cards, organizer-owned public events and an on-device
lightweight editor for text, trusted effects, images and videos. Exported
`.freedom-ar` packets carry the pattern and media together for a future full
software editor; no executable project scripts or remote media URLs are accepted. It does
not import the Unity/Unreal/Vuforia research runners or replace the community,
card, event, Asset, storage or command systems.

## Product and permission contract

1. Select a local image, orient/downsample it to a maximum 1024-pixel edge and
   compile it on this device. Metadata is removed. Pattern-quality hints describe
   image detail, not recognition probability. Cancel removes the compilation
   iframe and its worker/WebGL lifetime. Download the normalized print image.
   Image preparation/compilation has its own abort-controller identity; selecting
   an image does not invalidate pending target/event/scene loads. Replaced or
   cancelled preparation cannot clear a newer operation's progress or result.
   All continuations also retain the mounted page and original session boundary.
2. Try the actual image tracker with the rear camera. The trial is clearly local
   and unpublished. Do not represent a trial as another person's public card.
3. Publish an own card, an own public (`open` / `referral`) event or explicitly
   authored custom content. Custom publishing does not silently publish the
   owner's private member card. Creation, upload and publication use separate durable scoped receipts.
   A lost response keeps the same request, key, bytes and expected version.
4. Open `/ar/<opaque-token>` without login, or select a bounded scan set in
   `#ar`. Current active membership and current parent consent are checked on
   every public metadata/pattern read. Member-card rotation/closure and event
   withdrawal stop new reads. Pattern reads recheck after ObjectStore I/O.
   Live content refresh has a 15-second display lease; failed refresh clears
   the overlay. A public pattern is not identity, attendance or trust evidence.
5. Explicitly capture camera + AR pixels on-device, download, or hand the file
   to the OS share sheet. X/IG/Facebook/Threads logos are selectable and light up.
   Opening a composer or an OS handoff is not confirmed publication. No platform
   posting API, account password, automated browser bot or OAuth is introduced.

## Data and common-core boundary

`community_ar_targets` is an opt-in personal-scope sidecar registered in the
existing data responsibility catalog. The owner, community, kind, event,
opaque token and linked pattern are immutable. Changes use its one bigint
aggregate version. Scope/principal/owner/purpose/ready-Asset composite foreign
keys reject rebinding. One image fingerprint may be public per community;
fingerprints use actual grayscale tracking pixels, not randomized matcher
clusters. A member explicitly selects an optional public activity for display;
RSVP is never used to infer the scan set. Cancellation hides that activity's
scan set. An event scan filter does not create attendance or membership facts.

`.mind` packets contain grayscale source pixels. They live in the existing
Asset/ObjectStore lifecycle, never in a SQL byte column, command body, journal
or outbox. A closed 20 MiB `member.ar-target` profile validates the MindAR v2
packet, bounded nesting/collections, dimensions, keypoints, descriptors and
cluster indexes before storage or inference. Target inference data is bounded
to 2 MiB. Optional content has a versioned text/effect/image/video union; media
bytes stay in the same immutable Asset, while only a small sanitized binding
projection lives in SQL. Images are fully decoded and normalized through the
existing image runtime; videos use bounded MP4/WebM browser containers. One
scan set is at most 8 targets / 32 MiB; larger sets require a narrower selection. No arbitrary URL/project/effect
script from a share link is executed. Camera frames and captured photos are
not automatically persisted. Retained data is not physically deleted on
withdrawal; GC and retention/appeal policy remain an operator responsibility.

## Release and compatibility

The Node/Worker release setting is `arEnabled` / `FREEDOM_AR_ENABLED`, absent
by default. A trusted `arAssetStore` / MEDIA adapter is also required. Migration
167 adds a default-OFF domain storage policy. There is no legacy byte fallback.
Operators must independently approve persistence revision/quota, compatible
reader floor, backup/restore and retention before enabling publication.
The member publishing flag uses the same minimum 20 MiB retained quota as the
write policy's single-upload reservation; a smaller quota keeps publishing off.
Production flags/resources are not enabled by this PR. Do not downgrade to a
reader that cannot understand the new purpose after AR writes begin.

The MIT MindAR 1.2.5 npm browser distribution is SRI-verified and self-hosted.
See [vendor manifest](vendor/manifest.json) and [license](vendor/MindAR-LICENSE.txt).
Its worker factories and dependency filenames are adapted, unused inline
worker copies are removed, and its browser controller is minified with the
locked Rolldown build tool and legal comments retained so the
existing `script-src 'self'` CSP also covers workers, without `unsafe-eval`,
third-party scripts or blob/data worker permission. The full distribution's
native `canvas` dependency is not installed. Shared MessagePack is pinned in
the root lockfile. A managed web release provides SDK updates; there is no
Windows updater or platform driver.

To reproduce the browser SDK, verify the npm archive against the SRI above,
extract its `dist/controller-mGt1s8dJ.js`, `dist/ui-fBadYuor.js`,
`dist/mindar-image.prod.js` and `LICENSE` into a scratch directory, then run
`node modules/community-ar/vendor/build-sdk.mjs <scratch-directory>` after
`npm ci`. The builder verifies all original hashes, uses the locked Rolldown,
updates content filenames/descriptors and exposes the real processing Promise
for cancellation/error handling. Inference logic is unchanged.

Image content is at most 2 MiB after on-device preparation; the server fully
decodes and normalizes it to canonical WebP. Videos are at most 16 MiB, are
not transcoded, and playback depends on the device's supported codecs.

## Acceptance evidence

Run the focused `community-ar` runtime and browser tests against an explicitly
isolated database. Their fixtures are synthetic MIT images/videos; copied old
AR_HAO result JSON is not candidate evidence. The real tracker must acquire
the positive replay and reject the negative replay. Mock camera/clipboard
checks only establish UI recovery and lifetime behavior. Browser layout checks
cover narrow/mobile/desktop, current theme tokens, keyboard and touch sizes.

Physical printed shirts, folds, outdoor reflections and real iPhone/Android
devices require a separate operator field trial. Source/browser simulation
cannot establish those outcomes. The reference YouTube short was unavailable
to the current tools and is not claimed as viewed evidence.
