import { Hono, type Context } from 'hono';
import { getCookie } from 'hono/cookie';
import type { Pool } from 'pg';
import { OpaqueId } from '../../../../contracts/common/v1/identity.js';
import {
  CancelInputSchema, CatalogQuerySchema, InstallationQuerySchema, InstanceQuerySchema, LaunchInputSchema,
  PlanInputSchema, ReconcileInputSchema, ResumeInputSchema, SuspendInputSchema,
} from '../../../../contracts/guild-launchpad/v1/module-registry.js';
import { EnableManualWorkSchema, LaunchpadQuerySchema } from '../../../../contracts/guild-launchpad/v1/tenant-work.js';
import { authenticate, type Actor } from '../../../../modules/identity-membership/service.js';
import { browseApplications, readPublicRelease } from '../../../../modules/module-registry/catalog.js';
import {
  advanceOperation, cancelOperation, enableManualWork, installationByOperation, launchApplication,
  launchpadContext, listInstallations, listInstances, planApplication, readInstance, readOperation,
  reconcileOperation, resumeInstance, suspendInstance,
} from '../../../../modules/module-registry/service.js';
import { resolveProviders, type ModuleProviderMap } from '../../../../modules/module-registry/providers.js';
import { listTenantWork } from '../../../../modules/opportunity-project-work/tenant-work.js';
import { Problem } from '../../../../packages/shared/problem.js';
import type { PlatformEnv } from '../module-context.js';

const COOKIE = 'freedom_local_session';

function privateCache(c: { header: (name: string, value: string) => void }) {
  c.header('Cache-Control', 'private, no-store');
  c.header('Vary', 'Cookie');
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Robots-Tag', 'noindex, nofollow');
  c.header('Referrer-Policy', 'no-referrer');
  c.header('Cross-Origin-Resource-Policy', 'same-origin');
}

function publicCache(c: { header: (name: string, value: string) => void }) {
  c.header('Cache-Control', 'public, max-age=60');
  c.header('Vary', 'Cookie');
}

function etag(c: { header: (name: string, value: string) => void }, version: string) {
  c.header('ETag', `"${version}"`);
}

function singleQuery(c: Context<PlatformEnv> | { req: { queries: () => Record<string, string[]> } }): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, values] of Object.entries(c.req.queries())) {
    if (values.length !== 1) throw new Problem(422, 'validation_failed', '查詢參數無效。');
    result[key] = values[0];
  }
  return result;
}

function requiredKey(c: Context<PlatformEnv>) {
  const key = c.req.header('Idempotency-Key') ?? '';
  if (!(key.length >= 8 && key.length <= 128 && /^[A-Za-z0-9_-]+$/.test(key) && !/[\r\n]/.test(key))) {
    throw new Problem(400, 'idempotency_required', '請提供有效的 Idempotency-Key。');
  }
  return key;
}

function commandHeaders(c: Context<PlatformEnv>) {
  const key = requiredKey(c);
  if (c.req.header('If-Match') !== undefined) throw new Problem(400, 'invalid_version', '這個操作不使用 If-Match。');
  return key;
}

function matchVersion(c: Context<PlatformEnv>) {
  const quoted = c.req.header('If-Match');
  if (quoted === undefined) throw new Problem(428, 'version_required', '請提供 If-Match 版本。');
  if (!/^"[1-9][0-9]{0,18}"$/.test(quoted) || BigInt(quoted.slice(1, -1)) > 9223372036854775807n) throw new Problem(400, 'invalid_version', 'If-Match 須為加引號的整數版本。');
  return quoted.slice(1, -1);
}

function optionalKey(c: Context<PlatformEnv>, fallback: string) {
  const key = c.req.header('Idempotency-Key');
  if (key === undefined) return fallback;
  if (!(key.length >= 8 && key.length <= 128 && /^[A-Za-z0-9_-]+$/.test(key) && !/[\r\n]/.test(key))) {
    throw new Problem(400, 'idempotency_required', '請提供有效的 Idempotency-Key。');
  }
  return key;
}

async function optionalActor(pool: Pool, cookie: string | undefined): Promise<Actor | null> {
  if (!cookie) return null;
  try { return await authenticate(pool, cookie); }
  catch (error) {
    if (error instanceof Problem && error.status === 401) return null;
    throw error;
  }
}

/** Catalog reads. Mounted at `/` before the member boundary, and only when guild launchpad is enabled. */
export function createPublicModuleRegistryRoutes(pool: Pool) {
  const app = new Hono();
  app.get('/api/v1/applications', async c => {
    c.header('Cache-Control', 'no-store');
    c.header('Vary', 'Cookie');
    const query = CatalogQuerySchema.parse(singleQuery(c));
    const actor = await optionalActor(pool, getCookie(c, COOKIE));
    const member = Boolean(actor && query.guild_key);
    if (member) privateCache(c);
    const result = await browseApplications(pool, {
      guildKey: query.guild_key, cursor: query.cursor, limit: query.limit,
    }, member ? actor : null);
    if (!member) publicCache(c);
    return c.json(result);
  });
  app.get('/api/v1/applications/:application_key/releases/:release_ref', async c => {
    c.header('Cache-Control', 'no-store');
    c.header('Vary', 'Cookie');
    const result = await readPublicRelease(pool, c.req.param('application_key'), c.req.param('release_ref'));
    publicCache(c);
    return c.json(result);
  });
  return app;
}

/** Manual-work enablement, plans, launches, and instance reads. Mounted only when guild launchpad is enabled. */
export function createModuleRegistryRoutes(pool: Pool, providers?: ModuleProviderMap) {
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
    const query = InstanceQuerySchema.parse(singleQuery(c));
    return c.json(await listInstances(pool, c.get('actor'), OpaqueId.parse(c.req.param('tenant_id')), query));
  });
  app.get('/tenants/:tenant_id/module-instances/:instance_id', async c => {
    return c.json(await readInstance(pool, c.get('actor'), OpaqueId.parse(c.req.param('tenant_id')), OpaqueId.parse(c.req.param('instance_id'))));
  });
  app.post('/tenants/:tenant_id/module-instances/:instance_id/suspend', async c => {
    const key = requiredKey(c);
    const expected = matchVersion(c);
    const body = SuspendInputSchema.parse(await c.req.json());
    const operation = await suspendInstance(pool, c.get('actor'), OpaqueId.parse(c.req.param('tenant_id')),
      OpaqueId.parse(c.req.param('instance_id')), expected, key, body);
    etag(c, operation.version);
    return c.json(operation, 200);
  });
  app.post('/tenants/:tenant_id/module-instances/:instance_id/resume', async c => {
    const key = requiredKey(c);
    const expected = matchVersion(c);
    const body = ResumeInputSchema.parse(await c.req.json());
    const operation = await resumeInstance(pool, c.get('actor'), OpaqueId.parse(c.req.param('tenant_id')),
      OpaqueId.parse(c.req.param('instance_id')), expected, key, body);
    etag(c, operation.version);
    return c.json(operation, 200);
  });
  app.get('/tenants/:tenant_id/application-installations', async c => {
    const query = InstallationQuerySchema.parse(singleQuery(c));
    return c.json(await listInstallations(pool, c.get('actor'), OpaqueId.parse(c.req.param('tenant_id')), query));
  });
  app.get('/tenants/:tenant_id/application-installations/by-operation/:operation_id', async c => {
    return c.json(await installationByOperation(pool, c.get('actor'), OpaqueId.parse(c.req.param('tenant_id')), OpaqueId.parse(c.req.param('operation_id'))));
  });
  app.post('/tenants/:tenant_id/application-launch-plans', async c => {
    const key = commandHeaders(c);
    const body = PlanInputSchema.parse(await c.req.json());
    const plan = await planApplication(pool, c.get('actor'), OpaqueId.parse(c.req.param('tenant_id')), body, key, providers);
    etag(c, plan.version);
    return c.json(plan, 201);
  });
  app.post('/tenants/:tenant_id/application-installations', async c => {
    const key = commandHeaders(c);
    const body = LaunchInputSchema.parse(await c.req.json());
    const tenantId = OpaqueId.parse(c.req.param('tenant_id'));
    const launched = await launchApplication(pool, c.get('actor'), tenantId, body, key, providers);
    await advanceOperation(pool, tenantId, launched.operation_id, { providers: resolveProviders(providers), budget: 3000 });
    const operation = await readOperation(pool, c.get('actor'), tenantId, launched.operation_id);
    etag(c, operation.version);
    return c.json(operation, operation.state === 'succeeded' ? 200 : 202);
  });
  app.get('/tenants/:tenant_id/operations/:operation_id', async c => {
    const operation = await readOperation(pool, c.get('actor'), OpaqueId.parse(c.req.param('tenant_id')), OpaqueId.parse(c.req.param('operation_id')));
    etag(c, operation.version);
    return c.json(operation);
  });
  app.post('/tenants/:tenant_id/operations/:operation_id/reconcile', async c => {
    const tenantId = OpaqueId.parse(c.req.param('tenant_id'));
    const operationId = OpaqueId.parse(c.req.param('operation_id'));
    const expected = matchVersion(c);
    ReconcileInputSchema.parse(await c.req.json());
    const key = optionalKey(c, `reconcile${operationId.replaceAll('-', '')}${expected}`);
    const operation = await reconcileOperation(pool, c.get('actor'), tenantId, operationId, expected, key, resolveProviders(providers));
    etag(c, operation.version);
    return c.json(operation, 202);
  });
  app.post('/tenants/:tenant_id/operations/:operation_id/cancel', async c => {
    const tenantId = OpaqueId.parse(c.req.param('tenant_id'));
    const operationId = OpaqueId.parse(c.req.param('operation_id'));
    const expected = matchVersion(c);
    const body = CancelInputSchema.parse(await c.req.json());
    const key = optionalKey(c, `cancel${operationId.replaceAll('-', '')}${expected}`);
    const operation = await cancelOperation(pool, c.get('actor'), tenantId, operationId, expected, key, body.reason);
    etag(c, operation.version);
    return c.json(operation, operation.state === 'cancelled' ? 200 : 202);
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
