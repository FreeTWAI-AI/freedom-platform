import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Pool, PoolClient } from 'pg';
import { OpaqueId } from '../../contracts/common/v1/identity.js';
import type { TenantScopeContext } from '../../packages/resource-scopes/index.js';
import { Problem, requireCondition } from '../../packages/shared/problem.js';
import { normalizeImage } from '../../packages/shared/image-runtime.js';
import { assertCompleteRaster } from '../../packages/shared/image-container.js';
import { rasterFormat } from '../skill-submissions/payload.js';
import { readBounded, snapshotBoundedBytes, prepareLegacyMediaRepresentation } from '../../packages/asset-storage/index.js';
import { lockCapacityPolicy, lockDimension, retainedByteUsage } from '../opportunity-project-work/tenant-capacity.js';
import { lockStorefrontPhotoBoundary, type StorefrontPhotoActor } from '../agent-commerce/hosted/photo-authority.js';
import { lockCurrentPhotoProduct, publishPhotoPointer, type PhotoCompletion } from '../agent-commerce/hosted/photo-target.js';
import { assetCommandKey, assetVersion, createAssetLifecycleWithAuthority, type LifecyclePolicy, type LifecycleDependencies } from './engine.js';
import { createStorefrontLifecycleAuthority } from './storefront-lifecycle-authority.js';

export const PRODUCT_PHOTO_INPUT_BYTES = 2 * 1024 * 1024;
export const PRODUCT_PHOTO_OUTPUT_BYTES = 1024 * 1024;
export const PRODUCT_PHOTO_MAX_EDGE = 1920;
const invalidImage = () => new Problem(422, 'invalid_product_photo', '照片無法使用。請選擇完整的靜態 JPEG、PNG 或 WebP，長寬各不超過 4096 像素。');
const unavailable = () => new Problem(503, 'product_photo_unavailable', '商品照片上傳暫時無法使用。');

/** Full container framing is required on BOTH runtimes before native decode.
 * This gate alone does not prove a decodable compressed pixel stream. */
export function assertProductPhotoSource(mime: string, bytes: Uint8Array) {
  requireCondition(['image/png', 'image/jpeg', 'image/webp'].includes(mime), 415, 'product_photo_format', '請選擇 JPEG、PNG 或 WebP 照片。');
  requireCondition(bytes.byteLength > 0, 422, 'invalid_product_photo', '請先選擇照片。');
  requireCondition(bytes.byteLength <= PRODUCT_PHOTO_INPUT_BYTES, 413, 'product_photo_too_large', '照片需為 2 MB 以下的檔案。');
  const format = rasterFormat(Buffer.from(bytes));
  if (!format || mime !== `image/${format}`) throw invalidImage();
  try { assertCompleteRaster(bytes, format, 4096, 16_777_216); } catch { throw invalidImage(); }
  return format;
}
export async function normalizeProductPhoto(mime: string, bytes: Buffer): Promise<Buffer> {
  const format = assertProductPhotoSource(mime, bytes);
  try {
    const webp = await normalizeImage(bytes, { purpose: 'storefront_product_photo', format, maxDimension: 4096,
      maxPixels: 16_777_216, maxOutputBytes: PRODUCT_PHOTO_OUTPUT_BYTES,
      output: { width: PRODUCT_PHOTO_MAX_EDGE, height: PRODUCT_PHOTO_MAX_EDGE, fit: 'inside', quality: 80, effort: 4 } });
    requireCondition(webp.length > 0 && webp.length <= PRODUCT_PHOTO_OUTPUT_BYTES, 422, 'invalid_product_photo', '這張照片壓縮後仍過大，請換一張較小的照片。');
    return webp;
  } catch (error) {
    if (error instanceof Problem && error.status === 503) throw error;
    throw invalidImage();
  }
}
const input = z.object({ key: assetCommandKey, targetProductId: OpaqueId, expectedVersion: assetVersion,
  contentType: z.enum(['image/png', 'image/jpeg', 'image/webp']), byteSize: z.number().int().min(1).max(PRODUCT_PHOTO_INPUT_BYTES),
  sha256: z.string().length(64).regex(/^[0-9a-f]{64}$(?![\s\S])/) }).strict();
export type StorefrontProductPhotoPrepare = z.infer<typeof input>;

/** Existing policy rows only. Missing/legacy/off is unavailable; no defaults are
 * inferred and no caller-supplied policy or capacity resolver is accepted. */
export async function lockProductPhotoPolicy(q: PoolClient, tenantId: string) {
  const tenant = await lockCapacityPolicy(q, tenantId);
  const media = (await q.query<{ mode: string; policy_revision: string | null; persistence_allowed: boolean; retained_byte_limit: string | null }>(
    "SELECT mode,policy_revision,persistence_allowed,retained_byte_limit::text AS retained_byte_limit FROM domain_media_storage_policy WHERE purpose='storefront.product-photo' FOR SHARE")).rows[0];
  if (!tenant || !media || !['bridge', 'r2_only'].includes(media.mode) || !media.persistence_allowed || !media.policy_revision
    || !media.retained_byte_limit || BigInt(media.retained_byte_limit) < BigInt(PRODUCT_PHOTO_OUTPUT_BYTES)) throw unavailable();
  const revision = createHash('sha256').update(JSON.stringify({ profile: 'storefront.product-photo.policy/v1',
    tenant_policy_id: tenant.policy_id, tenant_revision: tenant.revision, max_retained_bytes: tenant.max_retained_bytes,
    photo_revision: media.policy_revision, photo_limit: media.retained_byte_limit, photo_mode: media.mode })).digest('hex');
  const policy: LifecyclePolicy = Object.freeze({ revision, platformPersistenceAllowed: true, retainedByteLimit: media.retained_byte_limit });
  return { policy, tenant };
}
interface ValidatedSource { readonly mime: string; readonly byteSize: number; readonly sha256: string; readonly webp: Buffer }
function lifecycle(pool: Pool, dependencies: LifecycleDependencies, source: ValidatedSource) {
  return createAssetLifecycleWithAuthority<StorefrontProductPhotoPrepare, PhotoCompletion, StorefrontPhotoActor, TenantScopeContext>(pool, dependencies, {
    purpose: 'storefront.product-photo', targetKind: 'storefront.product-photo', variant: 'image',
    inputMaxBytes: PRODUCT_PHOTO_INPUT_BYTES, outputMaxBytes: PRODUCT_PHOTO_OUTPUT_BYTES, retireReplacedAsset: false,
    parsePrepare(raw) {
      const value = input.parse(raw);
      requireCondition(value.contentType === source.mime && value.byteSize === source.byteSize && value.sha256 === source.sha256,
        409, 'asset_source_mismatch', '上傳內容與準備紀錄不同。');
      return value;
    },
    targetId: value => value.targetProductId,
    async lockTarget(q, context, actor, id, create) {
      // All phases acquire policy BEFORE item/selection/target, including reads,
      // leases and finalizeVia. The boundary remains the named domain authority.
      await lockStorefrontPhotoBoundary(q, context, actor);
      await lockProductPhotoPolicy(q, context.tenant_id);
      return lockCurrentPhotoProduct(q, context, actor, id, create);
    },
    resolvePolicy: async (q, context) => (await lockProductPhotoPolicy(q, context.tenant_id)).policy,
    async requireCapacity(q, context, _actor, _target, policy, reserve) {
      const { tenant } = await lockProductPhotoPolicy(q, context.tenant_id);
      await lockDimension(q, context.tenant_id, 'retained_bytes');
      const shared = await retainedByteUsage(q, context.scope.scope_id, context.tenant_id);
      requireCondition(shared + BigInt(reserve) <= BigInt(tenant.max_retained_bytes), 429, 'quota_exceeded', '已達到這個業務空間的容量上限。');
      const used = (await q.query<{ used: string }>(`SELECT COALESCE(sum(COALESCE(o.byte_size,i.reserved_bytes,1048576)::bigint),0)::text AS used
        FROM assets a LEFT JOIN asset_objects o USING(asset_id) LEFT JOIN asset_upload_intents i USING(asset_id)
        WHERE a.scope_id=$1 AND a.tenant_ref=$2 AND a.purpose='storefront.product-photo'`, [context.scope.scope_id, context.tenant_id])).rows[0];
      requireCondition(BigInt(used.used) + BigInt(reserve) <= BigInt(policy.retainedByteLimit), 409, 'asset_retained_quota', '照片儲存容量已達上限。');
    },
    async prepareRepresentation(body, mime, policy) {
      const bytes = await readBounded(body, PRODUCT_PHOTO_INPUT_BYTES);
      requireCondition(mime === source.mime && bytes.length === source.byteSize && createHash('sha256').update(bytes).digest('hex') === source.sha256,
        409, 'asset_source_mismatch', '上傳內容與準備紀錄不同。');
      return prepareLegacyMediaRepresentation(new ReadableStream({ start(c) { c.enqueue(Buffer.from(source.webp)); c.close(); } }),
        'image/webp', 'storefront.product-photo', policy);
    },
    async lockPublication() { return undefined; },
    publish: (q, context, actor, intent, target) => publishPhotoPointer(q, context, actor, intent, target),
  }, createStorefrontLifecycleAuthority());
}
/** Receipt facade first probes the same original tuple under current authority.
 * Only a new/unfinished effect calls this decoder. No canonical bytes or decoder
 * callback can be injected by the route. Decode occurs before quota commits. */
export function createStorefrontProductPhotoLifecycle(pool: Pool, dependencies: LifecycleDependencies) {
  if (!dependencies?.store) throw unavailable();
  return Object.freeze({ async forProduct(file: { mime: string; bytes: Buffer }) {
    const bytes = Buffer.from(snapshotBoundedBytes(file.bytes, PRODUCT_PHOTO_INPUT_BYTES)), mime = file.mime;
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const webp = Buffer.from(await normalizeProductPhoto(mime, bytes));
    return lifecycle(pool, dependencies, Object.freeze({ mime, byteSize: bytes.length, sha256, webp }));
  } });
}
export type StorefrontProductPhotoLifecycle = ReturnType<typeof createStorefrontProductPhotoLifecycle>;
