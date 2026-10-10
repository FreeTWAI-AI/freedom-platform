# Hosted product media extension (#317)

`freedom.hosted-store-media/v1` is an additive strict contract. The existing
storefront/v1 JSON, IDs, text/price digest and registry pins stay unchanged.
A product remains `commerce_items.item_id`; its selection aggregate version is
the only photo CAS. No supplier/private `photo_url`, external URL or storage key
is accepted by the photo DTO, upload route or renderer.

The source connects the closed Asset lifecycle to current exact-store authority,
original command receipts, saved draft pointers and immutable publication refs.
Migration 141 must precede this binary. New metadata cannot be read by an older
binary; rollback needs a compatible reader with upload admission disabled.
All deployment, policy and host activation remain separate explicit actions.

## Reads, commands and publication

`photo-authority.ts` locks current instance/deployment, the existing commerce
community boundary and the mapped profile. The Asset adapter then locks tenant
capacity/media policy before `photo-target.ts` locks item, selection and retained
target. Receipt locks precede domain authorization; ObjectStore I/O holds no SQL
transaction. The separate branded Asset authority does not accept Work grants.

`photo-commands.ts` probes the original request receipt before full decoding or
new-upload admission. New work snapshots at most 2 MiB of original bytes and
passes them to the closed core factory. Upload keeps original source MIME, size,
digest, target, expected version and key for every retry. Receipts store only
completion product/version/changed; the strict ACK separately projects current
media, which may be newer than the completed operation. An empty remove still
requires current authorization/CAS and a receipt; it does not increment version.
Removal works with persistence disabled and never deletes retained assets.

`photo-projection.ts` reads actual product fields, selection version and typed
ready photo metadata in one statement. Preview uses this same rowset for text
and photos. Publish compares the original content digest, template and separate
canonical media digest. It writes publication plus immutable refs and switches
the existing current-publication pointer in one transaction. Refs survive draft
product removal, which first clears the nullable draft pointer.

Both existing public JSON/HTML and new media routes require current active
instance/deployment/tenant/owner and both confirmed hosted-shop mappings. Ref
queries run only after tenant RLS binding. Their reconstructed canonical digest
must match the immutable publication. Private version paths and public revision
paths recheck the same authority and tuple after full verified object readback.
GET and HEAD both perform verification; no early 304 or borrowed signed URL.
Images use fixed WebP, nosniff and no-store; photo-bearing public HTML is no-store.

## Installation and member behavior

The runtime takes explicit `storePhotoAssetStore`, `storePhotoAssets` and
`storePhotoUploadsEnabled` ports. Absence closes the photo surface. Worker
`FREEDOM_HOSTED_STORE_PHOTOS_ENABLED` installs retained reads and requires the
hosted-store feature plus MEDIA. Independent
`FREEDOM_HOSTED_STORE_PHOTO_UPLOADS_ENABLED` requires that installation and IMAGES.
Both default OFF. Node embedding passes the same explicit ports; the stock Node
server installs no media binding. No committed deployment variables enable them.
Tenant/media SQL policy still independently governs all new retained effects.

Existing saved products offer one photo with small secondary add/replace/remove
controls. Draft save and preview are separate from public publication. Unknown
results retain the original File/body/key/version and block navigation; later
known refusals cannot discard that tuple. A first known CAS conflict refreshes
current state and requires explicit manual review for a new key/version. Fresh
login reads current state without automatically submitting. Full-page close only
warns: this source does not promise durable recovery of a File after reload.

## Evidence boundary

Closed runtime registration includes contract/renderer, UI state and core pure
checks, plus the database/HTTP suite source. The shared fixture uses the existing
registry harness and a real restricted runtime role; its policy is disabled by
default. Native decoding, PostgreSQL, storage races, browser add/replace/remove,
backup/restore and production acceptance require their separately scheduled
runs. Source/type/pure success is not those results. DC-08/catalog and retained
quota registration do not claim export/restore authority or enable photo GC.
Initial broad context `surface_unmapped` remains in the artifact packet; final
context completeness is not a runtime scheduling or execution proof.
