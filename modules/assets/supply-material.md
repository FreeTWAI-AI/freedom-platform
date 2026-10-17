# Closed supplier material files

Migration 171 registers two tenant purposes and starts both policy rows in
`legacy` mode with persistence disabled. Source registration and host installation
do not authorize storage or enable any real environment. Media installation needs
both launchpad and supplier console; new uploads have a separate default-OFF flag.

`storefront.supply-material` accepts static PNG/JPEG/WebP sources up to 2 MiB.
It reuses the complete product-photo source validation and native decoder:
4096-pixel edges, 16,777,216 source pixels, metadata stripped, no enlargement,
WebP inside 1920×1920, quality 80, effort 4, at most 1 MiB. Pixel dimensions come
from those canonical output bytes. `storefront.supply-material-video` accepts
MP4/WebM from 1 byte through 20 MiB, with the same ftyp/EBML header checks as the
storage layer. Video bytes are stored exactly as sent. There is no transcoding,
re-muxing, thumbnail generation, browser compression or public byte read.

Both profiles require the branded storefront authority and exact tenant/instance
binding. Every engine phase follows current session/tenant authority → installed
store boundary and commerce advisory → tenant capacity policy → purpose policy
`FOR SHARE` → material `FOR UPDATE` → intent → Asset. Prepare also holds its
existing receipt and purpose quota advisories. No storage or decoder I/O holds
SQL locks. Full source validation happens before any quota reservation.

The tenant budget includes Work results, product photos and both material
purposes. Each unfinished image reserves 1 MiB and each video 20 MiB, also charged
against its independent purpose limit. Stored representations charge actual
bytes. Old versions and unfinished/expired uploads remain charged. Neither
withdrawal nor a missing object frees capacity. GC admission is not added.

The real material aggregate_version is the sole CAS. Finalization marks the exact
Asset ready, appends max(version_no)+1 under the material lock, advances the
current version and aggregate version once, and records one supply_material fact
with operation `storefront.supply-material.upload` in the same command transaction.
The engine journals the returned fact with the same payload as storeFact. Earlier
versions are retained (`retireReplacedAsset=false`); no product photo pointer or
publication reference is changed.

The facade probes the immutable original key/body/version under current authority
before processing or new-upload admission. A successful receipt contains only
`material_id` and the aggregate `version` after that command. Unknown outcomes
resume the same intent and storage identity. A later role or capability removal
refuses receipt replay.

Supplier GET/HEAD requires current `store:write`, confirmed profile mappings and
the exact material/version/ready Asset/object tuple before and after object I/O.
Withdrawn materials remain readable to their supplier. HEAD checks metadata and
ETag without downloading; ranges use an immutable ETag pin, while full GET checks
the whole SHA-256. A changed authority snapshot cancels any range stream and
returns 404. Store failure or metadata mismatch returns a 503 problem. Responses
are private/no-store, vary by Cookie and expose no object locator. A range does
not claim whole-file digest verification.

Partner GET/HEAD uses `store:read` on the seller's own confirmed storefront and
the same visibility query as its partner-material list: an active grant pinned
to that exact shop, an active material's current image/video version, and a
current cooperation (`awaiting_supply_acceptance` or `sellable`) on the material's
product, or any supplier product for brand materials. The ready Asset/object
tuple belongs to the material's supplier tenant. The complete authority and
object identity snapshot runs again after object I/O; every visibility refusal
returns the same 404 and cancels any started range stream. Metadata/store failures
return 503. Headers and range handling match the private supplier read; no public
storage URL is created. D-11 publication copying for `public_use`, cloud
installation, backup/restore acceptance and operational activation remain
separate work.

D-11 可把目前的 `image`／`public_use` 素材，透過既有 `readPartnerMaterial` 的逐店授權與合作規則，複製為合作賣家自己 tenant 的普通商品照片。複製在明確選用時發生（Ted 已在 2026-10-16 確認這個時機），經商品照片正規化，容量只記在賣家。來源新版本不改複本，賣家需明確「改用新版本」；撤回、撤銷授權、改回 partners 或合作失效後，下次發布不再引用，既有公開快照不變；來源版本與賣家複本均保留歷史。
