import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { OpaqueId, Version } from '../../../contracts/guild-launchpad/v1/primitives.js';
import { SupplyMaterialReceiptSchema, SUPPLY_MATERIAL_IMAGE_SOURCE_TYPES, SUPPLY_MATERIAL_VIDEO_TYPES,
  SUPPLY_MATERIAL_VERSION_LIMIT, type SupplyMaterialReceipt } from '../../../contracts/guild-launchpad/v1/supplier-console.js';
import { checkVersion, digest } from '../../../packages/db/index.js';
import { AssetStorageError, objectKey, readPinnedObjectRange, readVerifiedObject, type ObjectStore, type ObjectMetadata } from '../../../packages/asset-storage/index.js';
import { planObjectHttpRequest } from '../../../packages/asset-storage/http-range.js';
import type { TenantScopeContext } from '../../../packages/resource-scopes/index.js';
import { scopedTenantCommand } from '../../../packages/scoped-commands/index.js';
import { Problem, requireCondition } from '../../../packages/shared/problem.js';
import type { Actor } from '../../identity-membership/service.js';
import type { LifecycleIntent, LifecyclePublication, LifecycleTarget } from '../../assets/engine.js';
import { snapshotSupplyMaterialBytes, materialFormat, materialUploadUnavailable, type SupplyMaterialPurpose, type createSupplyMaterialLifecycle } from '../../assets/supply-material.js';
import { storeCapabilities } from '../hosted/capabilities.js';
import { lockStorefrontPhotoBoundary, type StorefrontPhotoActor } from '../hosted/photo-authority.js';
import { profile, ready, storeRead } from '../hosted/store.js';
import { partnerVisibleMaterials } from './materials.js';

export type SupplyMaterialAssets = ReturnType<typeof createSupplyMaterialLifecycle>;
export type SupplyMaterialCompletion = SupplyMaterialReceipt;
export const SUPPLY_MATERIAL_UPLOAD_OPERATION = 'storefront.supply-material.upload';
const missing = () => new Problem(404, 'not_found', '找不到這個素材。');
const mismatch = () => new Problem(409, 'material_kind_mismatch', '這個素材的種類不接受這個內容。');
const kindFor = (purpose: SupplyMaterialPurpose) => purpose === 'storefront.supply-material' ? 'image' : 'video';

/** Boundary and policy locks precede this row on every lifecycle phase. */
export async function lockSupplyMaterialTarget(q: PoolClient, context: TenantScopeContext, actor: StorefrontPhotoActor,
  materialId: string, purpose: SupplyMaterialPurpose): Promise<LifecycleTarget> {
  const row = (await q.query<{ material_id: string; kind: string; state: string; version: string }>(`SELECT material_id,kind,state,aggregate_version::text AS version
    FROM supply_materials WHERE material_id=$1 AND tenant_id=$2 AND instance_id=$3 FOR UPDATE`, [materialId, context.tenant_id, actor.instance_id])).rows[0];
  if (!row) throw missing();
  requireCondition(row.state !== 'withdrawn', 409, 'material_withdrawn', '這個素材已撤回，不能再修改。');
  if (row.kind !== kindFor(purpose)) throw mismatch();
  const count = (await q.query<{ n: number }>('SELECT count(*)::int AS n FROM supply_material_versions WHERE material_id=$1', [materialId])).rows[0].n;
  requireCondition(count < SUPPLY_MATERIAL_VERSION_LIMIT, 409, 'material_version_limit', '這個素材已有 100 個版本，請另外建立新素材。');
  return { targetId: row.material_id, aggregateVersion: row.version, assetId: null };
}
/** The engine marks ready first and journals the returned fact once in this
 * same transaction, with the same payload as storeFact(...,'supply_material'). */
export async function publishSupplyMaterialVersion(q: PoolClient, context: TenantScopeContext, actor: StorefrontPhotoActor,
  intent: LifecycleIntent, target: LifecycleTarget): Promise<LifecyclePublication<SupplyMaterialCompletion>> {
  requireCondition(intent.target_material_id === target.targetId && intent.target_instance_id === actor.instance_id
    && intent.target_tenant_id === context.tenant_id && intent.scope_id === context.scope.scope_id
    && ['storefront.supply-material', 'storefront.supply-material-video'].includes(intent.purpose) && intent.state === 'stored',
  409, 'asset_source_mismatch', '上傳內容與準備紀錄不同。');
  checkVersion(target.aggregateVersion, intent.expected_version);
  const versionId = randomUUID();
  await q.query(`INSERT INTO supply_material_versions(version_id,material_id,tenant_id,instance_id,scope_id,kind,version_no,
    asset_id,representation_id,policy_revision,purpose,created_by_principal_id)
    SELECT $1,$2,$3,$4,$5,$6,COALESCE(max(version_no),0)+1,$7,$8,$9,$10,$11 FROM supply_material_versions WHERE material_id=$2`,
  [versionId, target.targetId, context.tenant_id, actor.instance_id, context.scope.scope_id, kindFor(intent.purpose as SupplyMaterialPurpose),
    intent.asset_id, intent.representation_id, intent.policy_revision, intent.purpose, context.principal_id]);
  const next = (await q.query<{ version: string }>(`UPDATE supply_materials SET current_version_id=$4,aggregate_version=aggregate_version+1
    WHERE material_id=$1 AND tenant_id=$2 AND instance_id=$3 AND aggregate_version=$5 RETURNING aggregate_version::text AS version`,
  [target.targetId, context.tenant_id, actor.instance_id, versionId, intent.expected_version])).rows[0];
  requireCondition(next, 412, 'version_conflict', '資料已更新，請重新讀取。');
  return { aggregateVersion: next.version, result: SupplyMaterialReceiptSchema.parse({ material_id: target.targetId, version: next.version }),
    fact: { aggregateType: 'supply_material', id: target.targetId, data: { resource_id: target.targetId, version: next.version } } };
}
export async function uploadSupplyMaterialFile(pool: Pool, actor: Actor, tenantId: string, instanceId: string, materialId: string,
  key: string, expected: string, file: { bytes: Buffer; mime: string }, assets: SupplyMaterialAssets | undefined, uploadsAllowed: boolean) {
  const bytes = snapshotSupplyMaterialBytes(file.bytes), mime = file.mime;
  if (!([...SUPPLY_MATERIAL_IMAGE_SOURCE_TYPES, ...SUPPLY_MATERIAL_VIDEO_TYPES] as readonly string[]).includes(mime)) throw materialFormat();
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const owner = Object.freeze({ ...actor, tenant_id: OpaqueId.parse(tenantId), instance_id: OpaqueId.parse(instanceId) });
  materialId = OpaqueId.parse(materialId); expected = Version.parse(expected);
  const authorize = async (q: PoolClient, context: TenantScopeContext) => {
    await lockStorefrontPhotoBoundary(q, context, owner);
    // Existence only: an old success still replays after later versions/withdrawal.
    const row = await q.query('SELECT 1 FROM supply_materials WHERE material_id=$1 AND tenant_id=$2 AND instance_id=$3', [materialId, tenantId, instanceId]);
    if (row.rowCount !== 1) throw missing();
  };
  const command = (run: (q: PoolClient, context: TenantScopeContext) => Promise<SupplyMaterialReceipt>) => scopedTenantCommand(pool,
    { actor: owner, tenantId, tenantLock: 'share', operation: SUPPLY_MATERIAL_UPLOAD_OPERATION, key, expected,
      body: { mime, byte_size: bytes.length, sha256 }, target: { kind: 'supply_material', id: materialId }, capabilitiesForRole: storeCapabilities },
    authorize, run, authorize);
  const probe = async () => {
    const miss = new Error('supply_material_receipt_miss');
    try { return SupplyMaterialReceiptSchema.parse(await command(async () => { throw miss; })); }
    catch (error) { if (error !== miss) throw error; return undefined; }
  };
  const replay = await probe(); if (replay) return replay;
  if (!assets || !uploadsAllowed) throw materialUploadUnavailable();
  try {
    const kind = await storeRead(pool, owner, tenantId, instanceId, 'store:write', async q => {
      const p = await profile(q, tenantId, instanceId); ready(p);
      const row = (await q.query<{ kind: string }>('SELECT kind FROM supply_materials WHERE material_id=$1 AND tenant_id=$2 AND instance_id=$3', [materialId, tenantId, instanceId])).rows[0];
      if (!row) throw missing(); return row.kind;
    });
    if (kind !== 'image' && kind !== 'video' || !((kind === 'image' ? SUPPLY_MATERIAL_IMAGE_SOURCE_TYPES : SUPPLY_MATERIAL_VIDEO_TYPES) as readonly string[]).includes(mime)) throw mismatch();
    const api = await (kind === 'image' ? assets.forImage({ bytes, mime }) : assets.forVideo({ bytes, mime })), phaseKey = digest({ operation: SUPPLY_MATERIAL_UPLOAD_OPERATION, key });
    const prepared = await api.prepare(owner, { key: phaseKey, targetMaterialId: materialId, expectedVersion: expected,
      contentType: mime as 'image/png' | 'image/jpeg' | 'image/webp' | 'video/mp4' | 'video/webm', byteSize: bytes.length, sha256 });
    const lease = await api.resumeUpload(owner, { key: phaseKey, intentId: prepared.intentId });
    const binding = { intentId: lease.intentId, fence: lease.fence, leaseToken: lease.leaseToken };
    if (lease.state === 'prepared' || lease.state === 'processing') await api.write(owner, { ...binding, key: digest({ key: phaseKey, phase: 'write', fence: lease.fence }) },
      new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } }));
    return SupplyMaterialReceiptSchema.parse(await api.finalizeVia<SupplyMaterialReceipt>(owner, { ...binding, key: digest({ key: phaseKey, phase: 'finalize' }) }, {
      operation: SUPPLY_MATERIAL_UPLOAD_OPERATION, execute: run => command(run),
      validateIntent: row => requireCondition(row.target_material_id === materialId && row.target_instance_id === instanceId && row.target_tenant_id === tenantId
        && row.source_sha256 === sha256 && row.source_content_type === mime && row.source_byte_size === bytes.length && row.expected_version === expected,
      409, 'asset_source_mismatch', '上傳內容與準備紀錄不同。'), result: value => value,
    }));
  } catch (error) {
    const committed = await probe().catch(() => undefined); if (committed) return committed;
    if (error instanceof AssetStorageError) throw materialUploadUnavailable();
    throw error;
  }
}

/** The supplier retains its own historical files after withdrawal. Policy OFF
 * prevents new uploads, never bypasses or revokes these current supplier reads. */
export async function readSupplyMaterialContent(pool: Pool, store: ObjectStore, actor: Actor, tenantId: string, instanceId: string,
  rawMaterialId: string, rawVersionId: string, request: { method: 'GET' | 'HEAD'; rangeHeader?: string; ifRangeHeader?: string }) {
  const materialId = OpaqueId.parse(rawMaterialId), versionId = OpaqueId.parse(rawVersionId);
  const snapshot = () => storeRead(pool, actor, tenantId, instanceId, 'store:write', async q => {
    const p = await profile(q, tenantId, instanceId); ready(p);
    const row = (await q.query(`SELECT v.version_id,v.material_id,v.kind,v.asset_id,v.representation_id,v.scope_id,
      o.content_type,o.byte_size,o.content_sha256,o.transform_version,o.policy_revision,o.profile_id
      FROM supply_materials m JOIN supply_material_versions v ON v.material_id=m.material_id AND v.tenant_id=m.tenant_id AND v.instance_id=m.instance_id
      JOIN assets a ON a.asset_id=v.asset_id AND a.scope_id=v.scope_id AND a.tenant_ref=v.tenant_id AND a.scope_kind='tenant'
        AND a.purpose=v.purpose AND a.representation_id=v.representation_id AND a.state='ready' AND a.deletion_fence=0
      JOIN asset_objects o ON o.asset_id=a.asset_id AND o.scope_id=v.scope_id AND o.representation_id=v.representation_id
        AND o.policy_revision=v.policy_revision AND o.purpose=v.purpose AND o.profile_id=v.purpose AND o.content_sha256=v.content_sha256
      WHERE m.material_id=$1 AND m.tenant_id=$2 AND m.instance_id=$3 AND v.version_id=$4 AND v.kind IN ('image','video')`,
    [materialId, tenantId, instanceId, versionId])).rows[0];
    if (!row) throw missing();
    const metadata: ObjectMetadata = { contentType: row.content_type, byteSize: Number(row.byte_size), sha256: row.content_sha256,
      transformVersion: row.transform_version, policyRevision: row.policy_revision, profileId: row.profile_id };
    return { versionId: row.version_id, materialId: row.material_id, kind: row.kind,
      scopeId: row.scope_id, assetId: row.asset_id, representationId: row.representation_id, metadata };
  });
  return readMaterialContent(store, snapshot, request);
}

// Suppliers use store:write for their withdrawn/historical files; partners use
// their own store:read and only the current, active, granted cooperation material.
export async function readPartnerMaterialContent(pool: Pool, store: ObjectStore, actor: Actor, tenantId: string, instanceId: string,
  rawMaterialId: string, rawVersionId: string, request: { method: 'GET' | 'HEAD'; rangeHeader?: string; ifRangeHeader?: string }) {
  const materialId = OpaqueId.parse(rawMaterialId), versionId = OpaqueId.parse(rawVersionId);
  const snapshot = () => storeRead(pool, actor, tenantId, instanceId, 'store:read', async q => {
    const p = await profile(q, tenantId, instanceId); ready(p);
    const row = (await q.query(`WITH visible AS (${partnerVisibleMaterials})
      SELECT v.version_id,v.material_id,v.kind,v.asset_id,v.representation_id,v.scope_id,
        o.content_type,o.byte_size,o.content_sha256,o.transform_version,o.policy_revision,o.profile_id
      FROM visible m JOIN supply_material_versions v ON v.version_id=m.version_id AND v.material_id=m.material_id
      JOIN assets a ON a.asset_id=v.asset_id AND a.scope_id=v.scope_id AND a.tenant_ref=v.tenant_id AND a.scope_kind='tenant'
        AND a.purpose=v.purpose AND a.representation_id=v.representation_id AND a.state='ready' AND a.deletion_fence=0
      JOIN asset_objects o ON o.asset_id=a.asset_id AND o.scope_id=v.scope_id AND o.representation_id=v.representation_id
        AND o.policy_revision=v.policy_revision AND o.purpose=v.purpose AND o.profile_id=v.purpose AND o.content_sha256=v.content_sha256
      WHERE m.material_id=$2 AND m.version_id=$3 AND m.kind IN ('image','video')`,
    [p.storefront_shop_id, materialId, versionId])).rows[0];
    if (!row) throw missing();
    const metadata: ObjectMetadata = { contentType: row.content_type, byteSize: Number(row.byte_size), sha256: row.content_sha256,
      transformVersion: row.transform_version, policyRevision: row.policy_revision, profileId: row.profile_id };
    return { versionId: row.version_id, materialId: row.material_id, kind: row.kind,
      scopeId: row.scope_id, assetId: row.asset_id, representationId: row.representation_id, metadata };
  });
  return readMaterialContent(store, snapshot, request);
}

type MaterialContentPin = { versionId: string; materialId: string; kind: string; scopeId: string; assetId: string;
  representationId: string; metadata: ObjectMetadata };
async function readMaterialContent(store: ObjectStore, snapshot: () => Promise<MaterialContentPin>,
  request: { method: 'GET' | 'HEAD'; rangeHeader?: string; ifRangeHeader?: string }) {
  const first = await snapshot(), pin = JSON.stringify(first);
  const unavailable = () => new Problem(503, 'material_content_unavailable', '素材檔案暫時無法讀取。');
  let body: ReadableStream<Uint8Array> | undefined, refused = false;
  const recheck = async () => {
    try { if (JSON.stringify(await snapshot()) !== pin) throw missing(); }
    catch { refused = true; throw missing(); }
  };
  try {
    const key = objectKey(first), head = await store.head(key);
    if (!head?.etag || !(['contentType', 'byteSize', 'sha256', 'transformVersion', 'policyRevision', 'profileId'] as const).every(field => head.metadata[field] === first.metadata[field])) throw unavailable();
    const plan = planObjectHttpRequest({ ...request, byteSize: first.metadata.byteSize, contentType: first.metadata.contentType, etag: head.etag });
    if (!plan.sendBody) { await recheck(); return { plan, body: null }; }
    if (plan.range) { body = (await readPinnedObjectRange(store, key, first.metadata, plan.range, head.etag)).body; await recheck(); return { plan, body }; }
    const full = await readVerifiedObject(store, key, first.metadata);
    if (full.etag !== head.etag) throw unavailable();
    await recheck(); return { plan, body: full.bytes };
  } catch {
    if (body) await body.cancel().catch(() => {});
    throw refused ? missing() : unavailable();
  }
}
