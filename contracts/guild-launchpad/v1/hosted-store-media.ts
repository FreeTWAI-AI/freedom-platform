import { z } from 'zod';
import { OpaqueId, Version } from './primitives.js';

/** Independent extension. No field is added to the pinned storefront/v1 DTO. */
export const HOSTED_STORE_MEDIA_PROFILE = 'freedom.hosted-store-media/v1' as const;
export const ProductPhotoSkuSchema = z.string().max(24).regex(/^P[0-9]{4,}$(?![\s\S])/);
export const ProductPhotoSlugSchema = z.string().max(40).regex(/^[a-z][a-z0-9-]{1,38}[a-z0-9]$(?![\s\S])/);
export const ProductPhotoMetadataSchema = z.object({
  content_type: z.literal('image/webp'),
  byte_size: z.number().int().min(1).max(1024 * 1024),
  width: z.number().int().min(1).max(1920),
  height: z.number().int().min(1).max(1920),
}).strict();

const uuidPart = '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const privatePath = new RegExp(`^/api/v1/tenants/(${uuidPart})/storefronts/(${uuidPart})/products/(${uuidPart})/photo/([1-9][0-9]{0,18})$(?![\\s\\S])`);
const publicPath = /^\/shops\/([a-z][a-z0-9-]{1,38}[a-z0-9])\/media\/([1-9][0-9]{0,18})\/(P[0-9]{4,23})$(?![\s\S])/;
export const PrivateProductPhotoPathSchema = z.string().max(220).regex(privatePath).refine(path => Version.safeParse(privatePath.exec(path)?.[4]).success);
export const PublicProductPhotoPathSchema = z.string().max(110).regex(publicPath).refine(path => Version.safeParse(publicPath.exec(path)?.[2]).success);
export const PrivateProductPhotoSchema = ProductPhotoMetadataSchema.extend({ read_path: PrivateProductPhotoPathSchema }).strict();
export const PublicProductPhotoSchema = ProductPhotoMetadataSchema.extend({ read_path: PublicProductPhotoPathSchema }).strict();

export const ProductMediaViewSchema = z.object({
  profile: z.literal(HOSTED_STORE_MEDIA_PROFILE),
  product_id: OpaqueId,
  /** Existing commerce selection aggregate version, never a separate media version. */
  version: Version,
  photo: PrivateProductPhotoSchema.nullable(),
}).strict().refine(value => {
  if (!value.photo) return true;
  const match = privatePath.exec(value.photo.read_path);
  return match?.[3] === value.product_id && match[4] === value.version;
});
export const PublicStoreMediaSchema = z.object({
  profile: z.literal(HOSTED_STORE_MEDIA_PROFILE),
  slug: ProductPhotoSlugSchema,
  revision: Version,
  photos: z.array(z.object({ sku: ProductPhotoSkuSchema, photo: PublicProductPhotoSchema }).strict()).max(200),
}).strict().refine(value => new Set(value.photos.map(item => item.sku)).size === value.photos.length)
  .refine(value => value.photos.every(item => item.photo.read_path === `/shops/${value.slug}/media/${value.revision}/${item.sku}`));
/** Removal is a normal product CAS command; no caller-selected Asset attachment. */
export const RemoveProductPhotoInputSchema = z.object({}).strict();
export type ProductMediaView = z.infer<typeof ProductMediaViewSchema>;
export type PublicStoreMedia = z.infer<typeof PublicStoreMediaSchema>;
