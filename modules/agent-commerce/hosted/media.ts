import { createHash } from 'node:crypto';
import { z } from 'zod';
import { OpaqueId, Version } from '../../../contracts/guild-launchpad/v1/primitives.js';
import { PublicStoreProjectionSchema } from '../../../contracts/guild-launchpad/v1/storefront.js';
import {
  HOSTED_STORE_MEDIA_PROFILE, ProductMediaViewSchema, ProductPhotoMetadataSchema,
  ProductPhotoSkuSchema, ProductPhotoSlugSchema, PublicStoreMediaSchema,
} from '../../../contracts/guild-launchpad/v1/hosted-store-media.js';

/** Candidate limits only. This module installs no host, decoder or lifecycle port. */
export const PRODUCT_PHOTO_POLICY = Object.freeze({
  purpose: 'storefront.product-photo', transform_version: 'storefront.product-photo.webp.v1',
  uploads_enabled: false,
  input_content_types: Object.freeze(['image/png', 'image/jpeg', 'image/webp'] as const),
  input_max_bytes: 2 * 1024 * 1024, output_max_bytes: 1024 * 1024,
  output_max_dimension: 1920, static_only: true, strip_metadata: true, enlarge: false,
} as const);

const Sha256 = z.string().length(64).regex(/^[0-9a-f]{64}$(?![\s\S])/);
/** Server-only persisted references. Shape validation is NOT Asset/tenant authority. */
export const PublicationPhotoRefSchema = ProductPhotoMetadataSchema.extend({
  sku: ProductPhotoSkuSchema, asset_id: OpaqueId, representation_id: OpaqueId,
  sha256: Sha256,
  purpose: z.literal(PRODUCT_PHOTO_POLICY.purpose),
  transform_version: z.literal(PRODUCT_PHOTO_POLICY.transform_version),
}).strict();
const ManifestSchema = z.object({
  profile: z.literal(HOSTED_STORE_MEDIA_PROFILE),
  photos: z.array(PublicationPhotoRefSchema).max(200),
}).strict().refine(value => new Set(value.photos.map(photo => photo.sku)).size === value.photos.length);
export type PublicationPhotoRef = z.infer<typeof PublicationPhotoRefSchema>;

/** Detached, deeply frozen, canonical bytes for the independent publication digest.
 * No time, revision, URL or mutable product version enters this digest. */
export function publicationMediaSnapshot(raw: unknown) {
  const parsed = ManifestSchema.parse(raw);
  const photos = parsed.photos.sort((a, b) => a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0).map(photo => Object.freeze({
    sku: photo.sku, asset_id: photo.asset_id, representation_id: photo.representation_id,
    sha256: photo.sha256, purpose: photo.purpose, transform_version: photo.transform_version,
    content_type: photo.content_type, byte_size: photo.byte_size, width: photo.width, height: photo.height,
  }));
  const manifest = Object.freeze({ profile: HOSTED_STORE_MEDIA_PROFILE, photos: Object.freeze(photos) });
  const bytes = JSON.stringify(manifest);
  const sha256 = createHash('sha256').update(bytes, 'utf8').digest('hex');
  return Object.freeze({ manifest, bytes, sha256 });
}
export const EMPTY_PUBLICATION_MEDIA_SHA256 = publicationMediaSnapshot({ profile: HOSTED_STORE_MEDIA_PROFILE, photos: [] }).sha256;

export function publicProductPhotoPath(slug: string, revision: string, sku: string): string {
  return `/shops/${ProductPhotoSlugSchema.parse(slug)}/media/${Version.parse(revision)}/${ProductPhotoSkuSchema.parse(sku)}`;
}
const PrivateProductBinding = z.object({ tenant_id: OpaqueId, instance_id: OpaqueId, product_id: OpaqueId, version: Version }).strict();
export function privateProductPhotoPath(rawBinding: unknown): string {
  const binding = PrivateProductBinding.parse(rawBinding);
  return `/api/v1/tenants/${binding.tenant_id}/storefronts/${binding.instance_id}/products/${binding.product_id}/photo/${binding.version}`;
}

/** Call only after current store:read and exact product/ref authorization. */
export function projectPrivateProductMedia(rawBinding: unknown, rawPhoto: unknown | null) {
  const binding = PrivateProductBinding.parse(rawBinding);
  // Metadata must be selected explicitly from the authorized Asset representation.
  const metadata = rawPhoto === null ? null : ProductPhotoMetadataSchema.parse(rawPhoto);
  return ProductMediaViewSchema.parse({ profile: HOSTED_STORE_MEDIA_PROFILE,
    product_id: binding.product_id, version: binding.version,
    photo: metadata && { ...metadata, read_path: privateProductPhotoPath(binding) },
  });
}

/** Projection/manifest/digest must come from ONE authorized current publication.
 * This pure mapper grants no access and reads no live commerce/supplier snapshot. */
export function projectPublicStoreMedia(rawProjection: unknown, rawManifest: unknown, expectedDigest: string) {
  const projection = PublicStoreProjectionSchema.parse(rawProjection);
  const snapshot = publicationMediaSnapshot(rawManifest);
  if (snapshot.sha256 !== Sha256.parse(expectedDigest)) throw new Error('publication_media_digest_mismatch');
  const skus = new Set(projection.products.map(product => ProductPhotoSkuSchema.parse(product.sku)));
  if (skus.size !== projection.products.length) throw new Error('publication_product_sku_duplicate');
  const photos = snapshot.manifest.photos.map(ref => {
    if (!skus.has(ref.sku)) throw new Error('publication_media_product_missing');
    return { sku: ref.sku, photo: {
      content_type: ref.content_type, byte_size: ref.byte_size, width: ref.width, height: ref.height,
      read_path: publicProductPhotoPath(projection.slug, projection.revision, ref.sku),
    } };
  });
  return PublicStoreMediaSchema.parse({ profile: HOSTED_STORE_MEDIA_PROFILE, slug: projection.slug, revision: projection.revision, photos });
}

/** Renderer input in existing product order, preserving text/price authority.
 * A photo is null for every product without a ref; no placeholder/external URL. */
export function publicStoreMediaRenderProducts(rawProjection: unknown, rawManifest: unknown, expectedDigest: string) {
  const projection = PublicStoreProjectionSchema.parse(rawProjection);
  const media = projectPublicStoreMedia(projection, rawManifest, expectedDigest);
  const photos = new Map(media.photos.map(item => [item.sku, item.photo]));
  return projection.products.map(product => ({ ...product, photo: photos.get(product.sku) ?? null }));
}
