# Hosted product media contract candidate (#317)

This source-only slice implements `freedom.hosted-store-media/v1`, its generated
JSON Schema, detached immutable manifest/digest construction and controlled
private/public renderer inputs. It installs no routes, decoder, persistence
profile, schema, upload port or host flag. `PRODUCT_PHOTO_POLICY.uploads_enabled`
is false. It is not the completed photo feature or live acceptance.

The existing `storefront/v1` projection, its digest and release pins stay exact.
Media is a separate extension. Public DTOs expose only SKU, same-origin read path,
WebP dimensions and byte size. Private DTOs expose the existing item ID and
selection aggregate version, with a nullable photo. Unknown fields, external
URLs, storage locators and caller-selected Asset attachment are rejected.

`publicationMediaSnapshot` copies, sorts by SKU, rejects duplicates and freezes
all references before hashing explicit-key UTF-8 JSON with SHA-256. This is a
local versioned encoding, not RFC 8785. The digest binds Asset/representation
identity, content hash, purpose/transform and dimensions/size. It excludes route,
publication revision/time and mutable product version, so identical republishing
can compare the same photo manifest. An empty manifest has an explicit digest.
Parsing a valid reference does not prove its tenant, readiness or upload origin.

`projectPublicStoreMedia` requires the independent digest and rejects photo SKUs
outside the strict public product projection. Its renderer helper retains product
order, text and prices, with null for absent photos. The caller must select
projection, template, manifest and digest from the same current publication.
The helpers perform no ACL and cannot establish current publication liveness.
Private paths include product version so a preview cannot silently fetch a newer
photo under an older product representation. A stale path must return 404.

## Remaining integration, using the existing authorities

- `hosted/products.ts` owns `commerce_items.item_id` and
  `commerce_selections.aggregate_version`. Add/replace/remove must use that CAS
  and `storeFact`, keeping product/price/order authority in commerce. No photo
  counter or imported `photo_url` is authoritative. Reads need same-instance
  `store:read`; writes use the existing `store:write`; publish uses
  `store:publish`. Settings still use `store:manage`.
- Add a typed current-photo pointer keyed by tenant/instance/product and a
  publication-photo reference keyed by publication/SKU. Composite constraints
  must prove exact tenant scope, purpose, ready Asset and representation.
  Historical publication refs must survive removal of an otherwise deletable
  draft item, so they must not impose a live-item FK. Publication insertion and
  immutable media refs/digest belong to the same existing publication command.
  Existing rows require the empty media digest; old projection hashes are not
  rewritten. Compare content digest, template and media digest for republishing.
- `modules/assets/engine.ts` already supplies prepare/claim/immutable PUT and
  readback/finalize. Its tenant authority currently only admits Work. Add a
  closed storefront product authority and profile; do not relabel Work or DM
  inputs. `packages/shared/image-runtime.ts` needs an explicit photo purpose and
  verified full static decoding with pixel bounds, metadata removal and no
  enlargement. Policy constants here do not validate bytes or install policy.
- `hosted/store.ts` takes instance, `commerce-orders/<community>`, then profile
  locks. New phases must take these domain locks before sorted item/selection,
  intent and Asset locks. Integrate the engine's purpose quota lock with
  `tenant-capacity.ts` policy/retained dimension locks in one reviewed order;
  copying Work callbacks alone is insufficient. Both Work usage queries currently
  filter `work.tenant-result`; they must count both purposes, including retained
  history and reservations, using each intent's reservation/profile bound.
  Cross-purpose quota and publish/replace/revoke barriers remain untested.
- Public read path: `/shops/:slug/media/:revision/:sku`. Resolve only the current
  publication/ref using `hosted/public.ts` liveness, perform object I/O outside
  SQL locks, then revalidate the same publication/ref and ready representation.
  Unpublish, replacement publication or revoked liveness must return 404, never
  substitute current bytes for an old path. Private image reads revalidate the
  exact tenant/instance/product version/ref and current store read ACL around I/O.
  Use no-store/nosniff (private reads also private and Vary Cookie); no 304 before
  ACL. The existing publicly cached HTML will need deliberate media-era cache
  handling in that integration; these helpers do not change response caching.
- `modules/module-data/catalog.ts` DC-08 currently covers profile/publication
  columns only. Register new typed pointers and independent digest columns when
  schema is added. `maintenance.captureReferences` collects every unfenced
  `asset_objects` row; `createConsistentAssetBackup` shares its snapshot with
  the dump. New-purpose capture/restore, historical refs and current-authority
  restore tests remain required. Do not infer portability from this generic
  collector. Do not retire replaced assets or enable GC for this purpose.

The agent-commerce descriptor maps these source and pure-test paths. The existing
guild-workspace schema generator produces the additive schema. The preview
exporter exports only its pinned preview bundle/tooling; this extension is not
silently added to consumer bundles or a public release. Initial broad context's
`surface_unmapped` is retained in the evidence packet. Final descriptors map the
new paths, but this is not proof of runtime registration or behavior coverage.

The pure tests cover strict boundaries, path/version binding, deterministic
digest, detached immutable snapshots, stripped public identities, missing or
duplicate SKUs and compatibility of the existing renderer/digest. PostgreSQL,
HTTP, real decoding, native object I/O, browser, restore and GC integration are
not run in this slice. Follow-up acceptance and formal review belong to
[Issue #317](https://github.com/FreeTWAI-AI/freedom-platform/issues/317).
