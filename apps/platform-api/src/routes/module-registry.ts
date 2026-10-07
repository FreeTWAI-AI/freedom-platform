import { Hono, type Context } from 'hono';
import type { Pool } from 'pg';
import { OpaqueId } from '../../../../contracts/common/v1/identity.js';
import { EnableManualWorkSchema, InstanceListQuerySchema, LaunchpadQuerySchema } from '../../../../contracts/guild-launchpad/v1/tenant-work.js';
import { enableManualWork, launchpadContext, listInstances } from '../../../../modules/module-registry/service.js';
import { listTenantWork } from '../../../../modules/opportunity-project-work/tenant-work.js';
import { Problem } from '../../../../packages/shared/problem.js';
import type { PlatformEnv } from '../module-context.js';

function privateCache(c: Context<PlatformEnv>) {
  c.header('Cache-Control', 'private, no-store');
  c.header('Vary', 'Cookie');
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Robots-Tag', 'noindex, nofollow');
  c.header('Referrer-Policy', 'no-referrer');
  c.header('Cross-Origin-Resource-Policy', 'same-origin');
}

function singleQuery(c: Context<PlatformEnv>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, values] of Object.entries(c.req.queries())) {
    if (values.length !== 1) throw new Problem(422, 'validation_failed', '查詢參數無效。');
    result[key] = values[0];
  }
  return result;
}

function commandHeaders(c: Context<PlatformEnv>) {
  const key = c.req.header('Idempotency-Key') ?? '';
  const quoted = c.req.header('If-Match');
  if (!(key.length >= 8 && key.length <= 128 && /^[A-Za-z0-9_-]+$/.test(key) && !/[\r\n]/.test(key))) {
    throw new Problem(400, 'idempotency_required', '請提供有效的 Idempotency-Key。');
  }
  if (quoted !== undefined) throw new Problem(400, 'invalid_version', '這個操作不使用 If-Match。');
  return key;
}

/** Manual-work enablement and instance reads. Mounted only when guild launchpad is enabled. */
export function createModuleRegistryRoutes(pool: Pool) {
  const app = new Hono<PlatformEnv>();
  app.use('*', async (c, next) => {
    try { await next(); }
    finally { privateCache(c); }
  });
  app.post('/tenants/:tenant_id/workspaces/:workspace_id/manual-work', async c => {
    const key = commandHeaders(c);
    const body = EnableManualWorkSchema.parse(await c.req.json());
    return c.json(await enableManualWork(pool, c.get('actor'), OpaqueId.parse(c.req.param('tenant_id')), OpaqueId.parse(c.req.param('workspace_id')), body, key));
  });
  app.get('/tenants/:tenant_id/module-instances', async c => {
    const query = InstanceListQuerySchema.parse(singleQuery(c));
    return c.json(await listInstances(pool, c.get('actor'), OpaqueId.parse(c.req.param('tenant_id')), query));
  });
  app.get('/tenants/:tenant_id/workspaces/:workspace_id/launchpad-context', async c => {
    const tenantId = OpaqueId.parse(c.req.param('tenant_id'));
    const workspaceId = OpaqueId.parse(c.req.param('workspace_id'));
    const query = LaunchpadQuerySchema.parse(singleQuery(c));
    const workPage = await listTenantWork(pool, c.get('actor'), tenantId, workspaceId, { limit: 20 });
    return c.json(await launchpadContext(pool, c.get('actor'), tenantId, workspaceId, query.guild_key, workPage));
  });
  return app;
}
