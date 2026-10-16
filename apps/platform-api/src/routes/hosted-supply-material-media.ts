import { Hono, type Context } from 'hono';
import type { Pool } from 'pg';
import { OpaqueId } from '../../../../contracts/guild-launchpad/v1/primitives.js';
import { SupplyMaterialEmptyInputSchema, SUPPLY_MATERIAL_IMAGE_SOURCE_TYPES, SUPPLY_MATERIAL_VIDEO_TYPES, SUPPLY_MATERIAL_VIDEO_MAX_BYTES } from '../../../../contracts/guild-launchpad/v1/supplier-console.js';
import { AssetStorageError, readBounded } from '../../../../packages/asset-storage/index.js';
import { requireCondition } from '../../../../packages/shared/problem.js';
import { materialFormat, materialTooLarge, invalidMaterialFile } from '../../../../modules/assets/supply-material.js';
import { uploadSupplyMaterialFile, readSupplyMaterialContent, readPartnerMaterialContent } from '../../../../modules/agent-commerce/supplier-console/material-media.js';
import type { PlatformRuntime } from '../runtime.js';
import type { PlatformEnv } from '../module-context.js';
import { privateCache, singleQuery, commandHeaders, etag } from './tenant-http.js';

type MaterialRuntime = Pick<PlatformRuntime, 'supplyMaterialAssets' | 'supplyMaterialAssetStore' | 'supplyMaterialUploadsEnabled'>;
export const supplyMaterialMediaInstalled = (runtime: MaterialRuntime) => Boolean(runtime.supplyMaterialAssetStore);
export const supplyMaterialUploadsInstalled = (runtime: MaterialRuntime) => supplyMaterialMediaInstalled(runtime) && Boolean(runtime.supplyMaterialAssets) && runtime.supplyMaterialUploadsEnabled === true;
export function isSupplyMaterialUpload(method: string, path: string) {
  return method === 'POST' && /^\/api\/v1\/tenants\/[0-9A-Fa-f-]{36}\/storefronts\/[0-9A-Fa-f-]{36}\/supply-materials\/[0-9A-Fa-f-]{36}\/content$/.test(path);
}
export function checkSupplyMaterialHeaders(contentType?: string, contentLength?: string) {
  if (!([...SUPPLY_MATERIAL_IMAGE_SOURCE_TYPES, ...SUPPLY_MATERIAL_VIDEO_TYPES] as readonly string[]).includes(contentType ?? '')) throw materialFormat();
  if (contentLength !== undefined && !(/^\d+$/.test(contentLength) && Number(contentLength) >= 1 && Number(contentLength) <= SUPPLY_MATERIAL_VIDEO_MAX_BYTES)) throw materialTooLarge();
}
async function sourceBytes(request: Request) {
  if (!request.body) throw invalidMaterialFile();
  try { const bytes = await readBounded(request.body, SUPPLY_MATERIAL_VIDEO_MAX_BYTES); if (!bytes.length) throw materialTooLarge(); return Buffer.from(bytes); }
  catch (error) {
    if (error instanceof AssetStorageError) { if (error.code === 'too_large') throw materialTooLarge(); throw invalidMaterialFile(); }
    throw error;
  }
}
export function createHostedSupplyMaterialMediaRoutes(pool: Pool, runtime: MaterialRuntime) {
  const app = new Hono<PlatformEnv>(), root = '/tenants/:tenant_id/storefronts/:instance_id/supply-materials/:material_id';
  const partnerContent = '/tenants/:tenant_id/storefronts/:instance_id/partner-materials/:material_id/versions/:version_id/content';
  for (const path of [root + '/content', root + '/versions/:version_id/content', partnerContent]) app.use(path, async (c, next) => {
    try { requireCondition(supplyMaterialMediaInstalled(runtime), 404, 'not_found', '找不到這個素材。'); await next(); }
    finally { privateCache(c); }
  });
  const ids = (c: Context<PlatformEnv>) => [OpaqueId.parse(c.req.param('tenant_id')), OpaqueId.parse(c.req.param('instance_id')), OpaqueId.parse(c.req.param('material_id'))] as const;
  app.post(root + '/content', async c => {
    SupplyMaterialEmptyInputSchema.parse(singleQuery(c)); checkSupplyMaterialHeaders(c.req.header('Content-Type'), c.req.header('Content-Length'));
    const h = commandHeaders(c, true), [tenant, instance, material] = ids(c);
    const receipt = await uploadSupplyMaterialFile(pool, c.get('actor'), tenant, instance, material, h.key, h.expected!,
      { bytes: await sourceBytes(c.req.raw), mime: c.req.header('Content-Type')! }, runtime.supplyMaterialAssets, runtime.supplyMaterialUploadsEnabled === true);
    etag(c, receipt.version); return c.json(receipt);
  });
  app.on(['GET', 'HEAD'], root + '/versions/:version_id/content', async c => {
    SupplyMaterialEmptyInputSchema.parse(singleQuery(c)); const [tenant, instance, material] = ids(c);
    const result = await readSupplyMaterialContent(pool, runtime.supplyMaterialAssetStore!, c.get('actor'), tenant, instance, material,
      OpaqueId.parse(c.req.param('version_id')), { method: c.req.method as 'GET' | 'HEAD', rangeHeader: c.req.header('Range'), ifRangeHeader: c.req.header('If-Range') });
    for (const [name, value] of Object.entries(result.plan.headers)) c.header(name, value);
    c.header('Content-Disposition', 'inline');
    return result.body === null ? c.body(null, result.plan.status) : c.body(result.body as Uint8Array<ArrayBuffer> | ReadableStream, result.plan.status);
  });
  app.on(['GET', 'HEAD'], partnerContent, async c => {
    SupplyMaterialEmptyInputSchema.parse(singleQuery(c)); const [tenant, instance, material] = ids(c);
    const result = await readPartnerMaterialContent(pool, runtime.supplyMaterialAssetStore!, c.get('actor'), tenant, instance, material,
      OpaqueId.parse(c.req.param('version_id')), { method: c.req.method as 'GET' | 'HEAD', rangeHeader: c.req.header('Range'), ifRangeHeader: c.req.header('If-Range') });
    for (const [name, value] of Object.entries(result.plan.headers)) c.header(name, value);
    c.header('Content-Disposition', 'inline');
    return result.body === null ? c.body(null, result.plan.status) : c.body(result.body as Uint8Array<ArrayBuffer> | ReadableStream, result.plan.status);
  });
  return app;
}
