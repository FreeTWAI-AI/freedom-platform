# Closed storefront product photos

This source profile is disabled by default. Migration 141 adds the purpose and
its `domain_media_storage_policy` row with `mode=legacy`, persistence false, and
no revision or retained-byte limit. Host admission also requires a separate,
explicit option; source implementation is not activation or deployment approval.
There is no legacy photo byte source, operator backfill or GC admission.

The named commerce boundary proves the current member's tenant and installed
store capabilities, active instance/deployment and both confirmed shop mappings.
It is a separate frozen authority brand: Work tenant privileges cannot compose
this profile. The product is the existing item; selection aggregate_version is
the sole CAS. `commerce_product_photo_targets` retains immutable routing with a
nullable current ready Asset pointer. It never substitutes for a live product
or permission check. Remove clears the pointer before deleting the live item
and selection; historical intents and published photos remain retained.

All phases use boundary → capacity policy → media policy → item/selection →
retained target → intent → Asset. Prepare's existing receipt and per-purpose
quota locks precede target resolution. It reserves 1 MiB against BOTH the shared
Work/photo tenant budget and the photo-specific retained budget. Stored objects
charge actual bytes. Old versions, expired pending uploads and unknown writes
remain charged; repeated publication refs do not multiply a single Asset's size.

The receipt facade checks current authority and the exact immutable original
request before invoking `forProduct`. This closed factory snapshots at most
2 MiB of static PNG/JPEG/WebP, validates complete framing, fully decodes using
the existing Node/Worker image processor, strips metadata and emits canonical
WebP inside 1920×1920 without enlargement, capped at 1 MiB. Dimensions are read
from those actual canonical bytes into immutable asset_objects, never copied
from the client. Object I/O and decoding occur outside SQL locks. Native Node
and Worker output are not promised to be bit-identical across processors.

Finalize verifies stored bytes, current authority/policy/fence and product CAS,
then atomically marks ready, updates pointer and selection version, finalizes the
intent and records one scoped fact. Receipt completion keeps its original
`productId/completedVersion/intentId`; a later current DTO is distinct from that
historical success and must not falsely confirm an old image as the current one.
Successful replay must recheck current store authority. No lease or storage key
is a public capability. Remove does not require new-upload persistence admission.

Publication refs bind publication, SKU and the same tenant ready Asset/object
tuple, with metadata derived from immutable object rows. They have no live item
FK and cannot be updated/deleted. Public reads bind tenant context, require the
current live publication and recalculate the domain canonical media digest;
`jsonb::text` hashing is not a substitute for that exact serialization. Migration
141 assigns the exact empty-media digest to historical publications without
rewriting the original projection or its digest.

Backup collection already includes every unfenced registered object, including
historical photo versions. It cannot collect an unknown PUT without an
asset_objects row; its intent/effect and conservative quota remain. New-profile
native R2 capture/restore and operator rollout are separate unverified gates.
Runtime grants retain the existing policy SELECT/generated-lock-column-only
rules. No policy write, credential, binding or admission is installed here.
Old runtimes may reject new photo metadata, so rollback requires a compatible
reader/runtime with uploads disabled; no down-migration or history deletion.

Tests and execution receipts are reported separately. Pure controlled-processor
checks do not establish native decoder, database, HTTP, cloud or restore behavior.
