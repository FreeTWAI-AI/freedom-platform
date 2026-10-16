# Closed supplier material files

Migration 168 registers two tenant purposes and starts both policy rows in
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

Partner byte reads, grant/cooperation authority, public_use publication copying,
cloud installation, backup/restore acceptance and operational activation are
separate work. public_use never creates a public storage URL.
