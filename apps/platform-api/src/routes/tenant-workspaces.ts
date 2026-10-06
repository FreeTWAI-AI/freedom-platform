import { Hono, type Context } from 'hono';
import type { Pool } from 'pg';
import { OpaqueId } from '../../../../contracts/common/v1/identity.js';
import { EmptyObjectSchema, InviteCandidateQuerySchema, PageQuerySchema } from '../../../../contracts/guild-launchpad/v1/tenant.js';
import { createHighRiskVerification } from '../../../../modules/tenant-workspaces/high-risk-verification.js';
import * as ownership from '../../../../modules/tenant-workspaces/ownership.js';
import * as recovery from '../../../../modules/tenant-workspaces/recovery.js';
import * as service from '../../../../modules/tenant-workspaces/service.js';
import { Problem } from '../../../../packages/shared/problem.js';
import type { PlatformEnv } from '../module-context.js';

function privateCache(c: Context<PlatformEnv>) {
  c.header('Cache-Control', 'private, no-store');
  c.header('Vary', 'Cookie');
}

function singleQuery(c: Context<PlatformEnv>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, values] of Object.entries(c.req.queries())) {
    if (values.length !== 1) throw new Problem(422, 'validation_failed', '查詢參數無效。');
    result[key] = values[0];
  }
  return result;
}

function commandHeaders(c: Context<PlatformEnv>, versionRequired: boolean) {
  const key = c.req.header('Idempotency-Key') ?? '';
  const quoted = c.req.header('If-Match');
  if (!(key.length >= 8 && key.length <= 128 && /^[A-Za-z0-9_-]+$/.test(key) && !/[\r\n]/.test(key))) {
    throw new Problem(400, 'idempotency_required', '請提供有效的 Idempotency-Key。');
  }
  if (!versionRequired) {
    if (quoted !== undefined) throw new Problem(400, 'invalid_version', '這個操作不使用 If-Match。');
    return { key };
  }
  if (quoted === undefined) throw new Problem(428, 'version_required', '請提供 If-Match 版本。');
  if (!(/^"[1-9][0-9]{0,18}"$/.test(quoted) && !/[\r\n]/.test(quoted) && BigInt(quoted.slice(1, -1)) <= 9223372036854775807n)) {
    throw new Problem(400, 'invalid_version', 'If-Match 須為加引號的正整數版本。');
  }
  return { key, expected: quoted.slice(1, -1) };
}

/** Member tenant routes. Mounted only when guild launchpad is enabled. */
export function createTenantWorkspaceRoutes(pool: Pool) {
  const app = new Hono<PlatformEnv>();
  app.use('*', async (c, next) => {
    try { await next(); }
    finally { privateCache(c); }
  });
  app.get('/tenants', async c => c.json(await service.listMyTenants(pool, c.get('actor'), PageQuerySchema.parse(singleQuery(c)))));
  app.post('/tenants', async c => {
    const headers = commandHeaders(c, false);
    return c.json(await service.createTenant(pool, c.get('actor'), await c.req.json(), headers.key), 201);
  });
  app.get('/tenants/invite-candidates', async c => c.json(await service.resolveInviteCandidate(pool, c.get('actor'), InviteCandidateQuerySchema.parse(singleQuery(c)).user_id)));
  app.get('/me/tenant-invitations', async c => c.json(await service.listMyInvitations(pool, c.get('actor'), PageQuerySchema.parse(singleQuery(c)))));
  app.post('/me/high-risk-verifications', async c => c.json(await createHighRiskVerification(pool, c.get('actor'), await c.req.json()), 201));
  app.get('/me/tenant-ownership-transfers', async c => c.json(await ownership.listMyTransfers(pool, c.get('actor'), PageQuerySchema.parse(singleQuery(c)))));
  app.get('/me/tenant-recovery-cases', async c => c.json(await recovery.listMyRecoveryCases(pool, c.get('actor'), PageQuerySchema.parse(singleQuery(c)))));
  app.post('/me/tenant-recovery-cases/:id/accept', async c => {
    const headers = commandHeaders(c, true);
    return c.json(await recovery.acceptRecoveryCase(pool, c.get('actor'), OpaqueId.parse(c.req.param('id')), await c.req.json(), headers.key, headers.expected!));
  });
  app.get('/tenants/:tenant_id', async c => {
    EmptyObjectSchema.parse(singleQuery(c));
    return c.json(await service.getTenant(pool, c.get('actor'), OpaqueId.parse(c.req.param('tenant_id'))));
  });
  app.post('/tenants/:tenant_id/edit', async c => {
    const tenantId = OpaqueId.parse(c.req.param('tenant_id'));
    const headers = commandHeaders(c, true);
    return c.json(await service.editTenant(pool, c.get('actor'), tenantId, await c.req.json(), headers.key, headers.expected!));
  });
  app.get('/tenants/:tenant_id/members', async c => c.json(await service.listMembers(pool, c.get('actor'), OpaqueId.parse(c.req.param('tenant_id')), PageQuerySchema.parse(singleQuery(c)))));
  app.post('/tenants/:tenant_id/invitations', async c => {
    const headers = commandHeaders(c, false);
    return c.json(await service.inviteMember(pool, c.get('actor'), OpaqueId.parse(c.req.param('tenant_id')), await c.req.json(), headers.key), 201);
  });
  app.post('/tenants/:tenant_id/invitations/:id/accept', async c => {
    const headers = commandHeaders(c, true);
    return c.json(await service.acceptInvitation(pool, c.get('actor'), OpaqueId.parse(c.req.param('tenant_id')), OpaqueId.parse(c.req.param('id')), await c.req.json(), headers.key, headers.expected!));
  });
  app.post('/tenants/:tenant_id/invitations/:id/decline', async c => {
    const headers = commandHeaders(c, false);
    return c.json(await service.declineInvitation(pool, c.get('actor'), OpaqueId.parse(c.req.param('tenant_id')), OpaqueId.parse(c.req.param('id')), await c.req.json(), headers.key));
  });
  app.post('/tenants/:tenant_id/invitations/:id/revoke', async c => {
    const headers = commandHeaders(c, true);
    return c.json(await service.revokeInvitation(pool, c.get('actor'), OpaqueId.parse(c.req.param('tenant_id')), OpaqueId.parse(c.req.param('id')), await c.req.json(), headers.key, headers.expected!));
  });
  app.post('/tenants/:tenant_id/members/:principal_id/change', async c => {
    const headers = commandHeaders(c, true);
    return c.json(await service.changeMember(pool, c.get('actor'), OpaqueId.parse(c.req.param('tenant_id')), OpaqueId.parse(c.req.param('principal_id')), await c.req.json(), headers.key, headers.expected!));
  });
  app.post('/tenants/:tenant_id/leave', async c => {
    const headers = commandHeaders(c, true);
    return c.json(await service.leaveTenant(pool, c.get('actor'), OpaqueId.parse(c.req.param('tenant_id')), await c.req.json(), headers.key, headers.expected!));
  });
  app.post('/tenants/:tenant_id/workspaces', async c => {
    const headers = commandHeaders(c, false);
    return c.json(await service.createWorkspace(pool, c.get('actor'), OpaqueId.parse(c.req.param('tenant_id')), await c.req.json(), headers.key), 201);
  });
  app.get('/tenants/:tenant_id/workspaces', async c => c.json(await service.listWorkspaces(pool, c.get('actor'), OpaqueId.parse(c.req.param('tenant_id')), PageQuerySchema.parse(singleQuery(c)))));
  app.post('/tenants/:tenant_id/ownership-transfers', async c => {
    const headers = commandHeaders(c, false);
    return c.json(await ownership.proposeTransfer(pool, c.get('actor'), OpaqueId.parse(c.req.param('tenant_id')), await c.req.json(), headers.key), 201);
  });
  app.get('/tenants/:tenant_id/ownership-transfers/:id', async c => {
    EmptyObjectSchema.parse(singleQuery(c));
    return c.json(await ownership.getTransfer(pool, c.get('actor'), OpaqueId.parse(c.req.param('tenant_id')), OpaqueId.parse(c.req.param('id'))));
  });
  app.post('/tenants/:tenant_id/ownership-transfers/:id/accept', async c => {
    const headers = commandHeaders(c, true);
    return c.json(await ownership.acceptTransfer(pool, c.get('actor'), OpaqueId.parse(c.req.param('tenant_id')), OpaqueId.parse(c.req.param('id')), await c.req.json(), headers.key, headers.expected!));
  });
  app.post('/tenants/:tenant_id/ownership-transfers/:id/cancel', async c => {
    const headers = commandHeaders(c, false);
    return c.json(await ownership.cancelTransfer(pool, c.get('actor'), OpaqueId.parse(c.req.param('tenant_id')), OpaqueId.parse(c.req.param('id')), await c.req.json(), headers.key));
  });
  app.post('/tenants/:tenant_id/ownership-transfers/:id/decline', async c => {
    const headers = commandHeaders(c, false);
    return c.json(await ownership.declineTransfer(pool, c.get('actor'), OpaqueId.parse(c.req.param('tenant_id')), OpaqueId.parse(c.req.param('id')), await c.req.json(), headers.key));
  });
  return app;
}
