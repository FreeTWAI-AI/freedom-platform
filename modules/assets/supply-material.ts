import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Pool, PoolClient } from 'pg';
import { OpaqueId } from '../../contracts/common/v1/identity.js';
import { SUPPLY_MATERIAL_IMAGE_SOURCE_TYPES, SUPPLY_MATERIAL_IMAGE_SOURCE_MAX_BYTES, SUPPLY_MATERIAL_IMAGE_MAX_BYTES,
  SUPPLY_MATERIAL_VIDEO_TYPES, SUPPLY_MATERIAL_VIDEO_MAX_BYTES } from '../../contracts/guild-launchpad/v1/supplier-console.js';
import type { TenantScopeContext } from '../../packages/resource-scopes/index.js';
import { Problem, requireCondition } from '../../packages/shared/problem.js';
import { AssetStorageError, readBounded, snapshotBoundedBytes, prepareLegacyMediaRepresentation } from '../../packages/asset-storage/index.js';
import { lockCapacityPolicy, lockDimension, retainedByteUsage } from '../opportunity-project-work/tenant-capacity.js';
import { lockStorefrontPhotoBoundary, type StorefrontPhotoActor } from '../agent-commerce/hosted/photo-authority.js';
import { lockSupplyMaterialTarget, publishSupplyMaterialVersion, type SupplyMaterialCompletion } from '../agent-commerce/supplier-console/material-media.js';
import { normalizeProductPhoto } from './storefront-product-photo.js';
import { assetCommandKey, assetVersion, createAssetLifecycleWithAuthority, type LifecyclePolicy, type LifecycleDependencies } from './engine.js';
import { createStorefrontLifecycleAuthority } from './storefront-lifecycle-authority.js';

export type SupplyMaterialPurpose = 'storefront.supply-material' | 'storefront.supply-material-video';
export const materialFormat = () => new Problem(415, 'material_format', '圖片請選擇 PNG、JPEG 或 WebP；影片請選擇 MP4 或 WebM。');
export const materialTooLarge = () => new Problem(413, 'material_too_large', '圖片需在 2 MB 以下；影片需在 20 MB 以下，請先壓縮（建議 H.264／AAC、720p、60 秒內）再上傳。');
export const invalidMaterialFile = () => new Problem(422, 'invalid_material_file', '這個檔案無法使用。圖片需為完整的靜態圖；影片需為完整的 MP4 或 WebM。');
export const materialUploadUnavailable = () => new Problem(503, 'material_upload_unavailable', '素材檔案上傳目前無法使用。');
const outputLimit = (purpose: SupplyMaterialPurpose) => purpose === 'storefront.supply-material' ? SUPPLY_MATERIAL_IMAGE_MAX_BYTES : SUPPLY_MATERIAL_VIDEO_MAX_BYTES;

/** The photo processor's purpose is a diagnostic hint; its exact bounded,
 * metadata-stripping normalization is also the material image contract. */
export async function normalizeSupplyMaterialImage(mime: string, bytes: Buffer): Promise<Buffer> {
  if (!(SUPPLY_MATERIAL_IMAGE_SOURCE_TYPES as readonly string[]).includes(mime)) throw materialFormat();
  try { return await normalizeProductPhoto(mime, bytes); }
  catch (error) {
    if (error instanceof Problem && error.status === 413) throw materialTooLarge();
    if (error instanceof Problem && error.status === 503) throw materialUploadUnavailable();
    throw invalidMaterialFile();
  }
}
export function assertSupplyMaterialVideo(mime: string, bytes: Uint8Array) {
  if (!(SUPPLY_MATERIAL_VIDEO_TYPES as readonly string[]).includes(mime)) throw materialFormat();
  if (bytes.byteLength < 1 || bytes.byteLength > SUPPLY_MATERIAL_VIDEO_MAX_BYTES) throw materialTooLarge();
  if (mime === 'video/mp4' ? bytes.length < 12 || String.fromCharCode(...bytes.subarray(4, 8)) !== 'ftyp'
    : bytes.length < 4 || ![0x1a, 0x45, 0xdf, 0xa3].every((byte, index) => bytes[index] === byte)) throw invalidMaterialFile();
  return bytes;
}
export function snapshotSupplyMaterialBytes(bytes: Uint8Array, max = SUPPLY_MATERIAL_VIDEO_MAX_BYTES) {
  try { return Buffer.from(snapshotBoundedBytes(bytes, max)); }
  catch (error) { if (error instanceof AssetStorageError && error.code === 'too_large') throw materialTooLarge(); throw invalidMaterialFile(); }
}
const input = z.object({ key: assetCommandKey, targetMaterialId: OpaqueId, expectedVersion: assetVersion,
  contentType: z.enum([...SUPPLY_MATERIAL_IMAGE_SOURCE_TYPES, ...SUPPLY_MATERIAL_VIDEO_TYPES]),
  byteSize: z.number().int().min(1).max(SUPPLY_MATERIAL_VIDEO_MAX_BYTES),
  sha256: z.string().length(64).regex(/^[0-9a-f]{64}$(?![\s\S])/) }).strict();
export type SupplyMaterialPrepare = z.infer<typeof input>;

export async function lockSupplyMaterialPolicy(q: PoolClient, tenantId: string, purpose: SupplyMaterialPurpose) {
  const tenant = await lockCapacityPolicy(q, tenantId);
  const media = (await q.query<{ mode: string; policy_revision: string | null; persistence_allowed: boolean; retained_byte_limit: string | null }>(
    'SELECT mode,policy_revision,persistence_allowed,retained_byte_limit::text AS retained_byte_limit FROM domain_media_storage_policy WHERE purpose=$1 FOR SHARE', [purpose])).rows[0];
  if (!tenant || !media || !['bridge', 'r2_only'].includes(media.mode) || !media.persistence_allowed || !media.policy_revision
    || !media.retained_byte_limit || BigInt(media.retained_byte_limit) < BigInt(outputLimit(purpose))) throw materialUploadUnavailable();
  const revision = createHash('sha256').update(JSON.stringify({ profile: `${purpose}.policy/v1`,
    tenant_policy_id: tenant.policy_id, tenant_revision: tenant.revision, max_retained_bytes: tenant.max_retained_bytes,
    photo_revision: media.policy_revision, photo_limit: media.retained_byte_limit, photo_mode: media.mode })).digest('hex');
  const policy: LifecyclePolicy = Object.freeze({ revision, platformPersistenceAllowed: true, retainedByteLimit: media.retained_byte_limit });
  return { policy, tenant };
}
interface ValidatedSource { readonly mime: string; readonly bytes: Buffer; readonly sha256: string; readonly output: Buffer }
function lifecycle(pool: Pool, dependencies: LifecycleDependencies, purpose: SupplyMaterialPurpose, source: ValidatedSource) {
  const image = purpose === 'storefront.supply-material', max = image ? SUPPLY_MATERIAL_IMAGE_SOURCE_MAX_BYTES : SUPPLY_MATERIAL_VIDEO_MAX_BYTES;
  return createAssetLifecycleWithAuthority<SupplyMaterialPrepare, SupplyMaterialCompletion, StorefrontPhotoActor, TenantScopeContext>(pool, dependencies, {
    purpose, targetKind: purpose, variant: image ? 'image' : 'video', inputMaxBytes: max, outputMaxBytes: outputLimit(purpose), retireReplacedAsset: false,
    parsePrepare(raw) {
      const value = input.parse(raw);
      requireCondition(value.contentType === source.mime && value.byteSize === source.bytes.length && value.sha256 === source.sha256,
        409, 'asset_source_mismatch', '上傳內容與準備紀錄不同。');
      return value;
    },
    targetId: value => value.targetMaterialId,
    async lockTarget(q, context, actor, id) {
      await lockStorefrontPhotoBoundary(q, context, actor);
      await lockSupplyMaterialPolicy(q, context.tenant_id, purpose);
      return lockSupplyMaterialTarget(q, context, actor, id, purpose);
    },
    resolvePolicy: async (q, context) => (await lockSupplyMaterialPolicy(q, context.tenant_id, purpose)).policy,
    async requireCapacity(q, context, _actor, _target, policy, reserve) {
      const { tenant } = await lockSupplyMaterialPolicy(q, context.tenant_id, purpose);
      await lockDimension(q, context.tenant_id, 'retained_bytes');
      const shared = await retainedByteUsage(q, context.scope.scope_id, context.tenant_id);
      requireCondition(shared + BigInt(reserve) <= BigInt(tenant.max_retained_bytes), 429, 'quota_exceeded', '已達到這個業務空間的容量上限。');
      const used = (await q.query<{ used: string }>(`SELECT COALESCE(sum(COALESCE(o.byte_size,i.reserved_bytes,$4)::bigint),0)::text AS used
        FROM assets a LEFT JOIN asset_objects o USING(asset_id) LEFT JOIN asset_upload_intents i USING(asset_id)
        WHERE a.scope_id=$1 AND a.tenant_ref=$2 AND a.purpose=$3`, [context.scope.scope_id, context.tenant_id, purpose, outputLimit(purpose)])).rows[0];
      requireCondition(BigInt(used.used) + BigInt(reserve) <= BigInt(policy.retainedByteLimit), 409, 'asset_retained_quota', '素材儲存容量已達上限。');
    },
    async prepareRepresentation(body, mime, policy) {
      const bytes = await readBounded(body, max);
      requireCondition(mime === source.mime && bytes.length === source.bytes.length && createHash('sha256').update(bytes).digest('hex') === source.sha256,
        409, 'asset_source_mismatch', '上傳內容與準備紀錄不同。');
      return prepareLegacyMediaRepresentation(new ReadableStream({ start(c) { c.enqueue(Buffer.from(source.output)); c.close(); } }),
        image ? 'image/webp' : mime, purpose, policy);
    },
    async lockPublication() { return undefined; },
    publish: (q, context, actor, intent, target) => publishSupplyMaterialVersion(q, context, actor, intent, target),
  }, createStorefrontLifecycleAuthority());
}
/** Snapshot and fully validate before the engine can reserve any capacity. */
export function createSupplyMaterialLifecycle(pool: Pool, dependencies: LifecycleDependencies) {
  if (!dependencies?.store) throw materialUploadUnavailable();
  const forMaterial = async (file: { mime: string; bytes: Buffer }, image: boolean) => {
    const bytes = snapshotSupplyMaterialBytes(file.bytes, image ? SUPPLY_MATERIAL_IMAGE_SOURCE_MAX_BYTES : SUPPLY_MATERIAL_VIDEO_MAX_BYTES), mime = file.mime;
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const output = image ? Buffer.from(await normalizeSupplyMaterialImage(mime, bytes)) : Buffer.from(assertSupplyMaterialVideo(mime, bytes));
    return lifecycle(pool, dependencies, image ? 'storefront.supply-material' : 'storefront.supply-material-video', Object.freeze({ mime, bytes, sha256, output }));
  };
  return Object.freeze({ forImage: (file: { mime: string; bytes: Buffer }) => forMaterial(file, true),
    forVideo: (file: { mime: string; bytes: Buffer }) => forMaterial(file, false) });
}
