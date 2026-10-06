import type { Pool, PoolClient } from 'pg';
import {
  AcceptResultSchema, CreateResultSchema, DisplayNameSchema, EmptyObjectSchema, InvitationPageSchema, InvitationRevokeInputSchema,
  InvitationViewSchema, InviteCandidateSchema, InviteInputSchema, LeaveResultSchema, MemberChangeInputSchema, MemberPageSchema,
  MemberViewSchema, TenantCreateInputSchema, TenantEditInputSchema, TenantPageSchema, TenantViewSchema,
  WorkspaceCreateInputSchema, WorkspacePageSchema, WorkspaceViewSchema,
  type InvitationView, type MemberView, type TenantStatus, type TenantView, type WorkspaceView,
} from '../../contracts/guild-launchpad/v1/tenant.js';
import { OpaqueId } from '../../contracts/common/v1/identity.js';
import type { Actor } from '../identity-membership/service.js';
import { checkVersion } from '../../packages/db/index.js';
import { transaction } from '../../packages/db/transaction.js';
import { lockMemberSession } from '../../packages/db/member-session.js';
import { lockTenantScope, mapPersonPrincipal, type TenantScopeContext } from '../../packages/resource-scopes/index.js';
import { scopedJournal, scopedMemberCommand, scopedTenantCommand } from '../../packages/scoped-commands/index.js';
import { Problem, requireCondition } from '../../packages/shared/problem.js';
import {
  MAX_ACTIVE_TENANTS_PER_PERSON, MAX_INVITATION_DAYS, MAX_PENDING_INVITATIONS_PER_TENANT, MAX_WORKSPACES_PER_TENANT,
  RESERVED_SLUGS, can, canInviteRole, canManageRole, roleCapabilities, type TenantCapability,
} from './authorization.js';
import { auditTenant, bumpAuthorizationRevision, iso, requireMutableStatus, versionOf } from './facts.js';

const NOT_FOUND = '找不到這個業務空間。';
const INVITE_MISSING = '找不到這份邀請。';
const MEMBER_MISSING = '找不到這位成員。';
const DENIED = '你目前沒有這項業務空間權限。';

function writeError(error: unknown): never {
  const pg = error as { code?: string; constraint?: string };
  if (pg.code === '23505' && pg.constraint === 'tenants_public_slug_unique') throw new Problem(409, 'slug_conflict', '這個網址代號已被使用。');
  if (pg.code === '23505' && pg.constraint === 'tenant_invitations_one_pending') throw new Problem(409, 'invitation_pending', '這位成員已有待回覆的邀請。');
  throw error;
}
function requireMutable(context: TenantScopeContext): void {
  requireMutableStatus(context.tenant_status);
}
function requireCap(context: TenantScopeContext, capability: TenantCapability): void {
  requireCondition(can(context.role, capability), 403, 'tenant_capability_denied', DENIED);
}

function encodeCursor(principalId: string, kind: string, tenantId: string | null, after: string): string {
  return Buffer.from(JSON.stringify({ principal_id: principalId, kind, tenant_id: tenantId, after }), 'utf8').toString('base64url');
}
function readCursor(raw: string | undefined, principalId: string, kind: string, tenantId: string | null): string | null {
  if (raw === undefined) return null;
  let parsed: { principal_id?: unknown; kind?: unknown; tenant_id?: unknown; after?: unknown };
  try { parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as typeof parsed; }
  catch { throw new Problem(422, 'validation_failed', '分頁游標無效。'); }
  requireCondition(parsed?.principal_id === principalId && parsed.kind === kind && parsed.tenant_id === tenantId
    && typeof parsed.after === 'string' && OpaqueId.safeParse(parsed.after).success,
  422, 'validation_failed', '分頁游標無效。');
  return parsed.after;
}
function limitOf(raw: string | undefined): number {
  if (raw === undefined) return 20;
  requireCondition(/^[1-9][0-9]{0,2}$/.test(raw), 422, 'validation_failed', '分頁大小無效。');
  const value = Number(raw);
  requireCondition(value <= 100, 422, 'validation_failed', '分頁大小無效。');
  return value;
}


async function personName(q: PoolClient, principalId: string): Promise<string> {
  const row = (await q.query<{ display_name: string }>(`SELECT u.display_name FROM principals p JOIN users u ON u.user_id=p.user_ref WHERE p.principal_id=$1 AND p.kind='person'`, [principalId])).rows[0];
  requireCondition(row?.display_name, 500, 'internal_error', '成員名稱無法讀取。');
  return row.display_name;
}
async function defaultWorkspaceId(q: PoolClient, tenantId: string): Promise<string> {
  const row = (await q.query<{ workspace_id: string }>(`SELECT workspace_id FROM workspaces WHERE tenant_id=$1 AND is_default`, [tenantId])).rows[0];
  requireCondition(row, 500, 'internal_error', '預設工作區無法讀取。');
  return row.workspace_id;
}
async function tenantView(q: PoolClient, tenantId: string, principalId: string): Promise<TenantView> {
  const row = (await q.query<{
    tenant_id: string; community_id: string; display_name: string; public_slug: string | null; status: TenantStatus;
    version: string; authorization_revision: string; role: TenantView['my_membership']['role']; membership_version: string;
  }>(`SELECT t.tenant_id,t.community_id,t.display_name,t.public_slug,t.status,t.version::text AS version,t.authorization_revision::text AS authorization_revision,
      m.role,m.version::text AS membership_version
    FROM tenants t JOIN tenant_memberships m ON m.tenant_id=t.tenant_id AND m.principal_id=$2 AND m.status='active'
    WHERE t.tenant_id=$1`, [tenantId, principalId])).rows[0];
  requireCondition(row, 404, 'tenant_not_found', NOT_FOUND);
  return TenantViewSchema.parse({
    tenant_id: row.tenant_id, community_id: row.community_id, display_name: row.display_name, public_slug: row.public_slug,
    status: row.status, version: versionOf(row.version), authorization_revision: versionOf(row.authorization_revision),
    my_membership: { principal_id: principalId, role: row.role, version: versionOf(row.membership_version) },
    capabilities: [{ instance_id: null, keys: [...roleCapabilities(row.role)] }],
    default_workspace_id: await defaultWorkspaceId(q, tenantId),
  });
}
async function workspaceView(q: PoolClient, workspaceId: string): Promise<WorkspaceView> {
  const row = (await q.query<{ workspace_id: string; tenant_id: string; name: string; status: 'active' | 'archived'; version: string }>(
    `SELECT workspace_id,tenant_id,name,status,version::text AS version FROM workspaces WHERE workspace_id=$1`, [workspaceId])).rows[0];
  requireCondition(row, 500, 'internal_error', '工作區無法讀取。');
  return WorkspaceViewSchema.parse({ ...row, version: versionOf(row.version) });
}
async function memberView(q: PoolClient, tenantId: string, principalId: string): Promise<MemberView> {
  const row = (await q.query<{ principal_id: string; role: MemberView['role']; status: 'active' | 'revoked'; version: string }>(
    `SELECT principal_id,role,status,version::text AS version FROM tenant_memberships WHERE tenant_id=$1 AND principal_id=$2`, [tenantId, principalId])).rows[0];
  requireCondition(row, 404, 'member_not_found', MEMBER_MISSING);
  return MemberViewSchema.parse({
    principal_id: row.principal_id, display_name: await personName(q, row.principal_id), role: row.role, status: row.status,
    instance_capabilities: [], version: versionOf(row.version),
  });
}
async function invitationView(q: PoolClient, invitationId: string): Promise<InvitationView> {
  const row = (await q.query<{
    invitation_id: string; tenant_id: string; tenant_display_name: string; invitee_principal_id: string;
    role: InvitationView['role']; state: InvitationView['state']; expires_at: Date; version: string;
  }>(`SELECT i.invitation_id,i.tenant_id,t.display_name AS tenant_display_name,i.invitee_principal_id,i.role,i.state,i.expires_at,i.version::text AS version
    FROM tenant_invitations i JOIN tenants t ON t.tenant_id=i.tenant_id WHERE i.invitation_id=$1`, [invitationId])).rows[0];
  requireCondition(row, 404, 'invitation_not_found', INVITE_MISSING);
  return InvitationViewSchema.parse({
    invitation_id: row.invitation_id, tenant_id: row.tenant_id, tenant_display_name: row.tenant_display_name,
    invitee_principal_id: row.invitee_principal_id, role: row.role, instance_capabilities: [], state: row.state,
    expires_at: iso(row.expires_at), version: versionOf(row.version),
  });
}

async function activeOwnerCount(q: PoolClient, tenantId: string): Promise<number> {
  return (await q.query<{ n: number }>(`SELECT count(*)::int AS n FROM tenant_memberships WHERE tenant_id=$1 AND role='owner' AND status='active'`, [tenantId])).rows[0].n;
}
async function callerPrincipal(pool: Pool, actor: Actor): Promise<string> {
  return transaction(pool, async q => {
    await lockMemberSession(q, actor);
    const principal = await mapPersonPrincipal(q, actor.user_id);
    requireCondition(principal.status === 'active' && principal.kind === 'person', 403, 'principal_disabled', '這個身分目前無法使用。');
    return principal.principal_id;
  });
}

async function priorResponse(q: PoolClient, context: { subject_principal: { principal_id: string }; authn_kind: string; scope: { scope_id: string } }, operation: string, key: string): Promise<Record<string, unknown> | null> {
  const row = (await q.query<{ response: Record<string, unknown> }>(`SELECT response FROM scoped_command_receipts
    WHERE principal_id=$1 AND authn_kind=$2 AND scope_id=$3 AND operation=$4 AND idempotency_key=$5`,
  [context.subject_principal.principal_id, context.authn_kind, context.scope.scope_id, operation, key])).rows[0];
  return row?.response ?? null;
}
async function stillActiveMember(q: PoolClient, tenantId: string, principalId: string): Promise<void> {
  const row = (await q.query<{ member_status: string; tenant_status: string }>(`SELECT m.status AS member_status, t.status AS tenant_status
    FROM tenants t JOIN tenant_memberships m ON m.tenant_id=t.tenant_id AND m.principal_id=$2 WHERE t.tenant_id=$1`, [tenantId, principalId])).rows[0];
  requireCondition(row?.member_status === 'active' && row.tenant_status === 'active', 403, 'tenant_capability_denied', '目前無法使用這個業務空間。');
}

export async function createTenant(pool: Pool, actor: Actor, body: unknown, key: string) {
  const input = TenantCreateInputSchema.parse(body);
  const principalId = await callerPrincipal(pool, actor);
  return scopedMemberCommand(pool, {
    actor, scope: 'personal', operation: 'tenant.create', key, body: input,
    target: { kind: 'tenant_collection', id: principalId },
  }, async () => {}, async (q, context) => {
    // Do not upgrade the principal row: lockMemberScope already holds it FOR SHARE,
    // and two creates would deadlock on that upgrade. This lock queues them instead.
    await q.query(`SELECT pg_advisory_xact_lock(hashtextextended('tenant.create/v1/' || $1::text, 0))`, [context.subject_principal.principal_id]);
    const active = (await q.query<{ n: number }>(`SELECT count(*)::int AS n FROM tenant_memberships m JOIN tenants t ON t.tenant_id=m.tenant_id
      WHERE m.principal_id=$1 AND m.status='active' AND t.status='active'`, [context.subject_principal.principal_id])).rows[0].n;
    if (active >= MAX_ACTIVE_TENANTS_PER_PERSON) throw new Problem(429, 'quota_exceeded', '使用中的業務空間已達上限。', 60);
    const workspaceName = input.workspace_name ?? input.display_name;
    DisplayNameSchema.parse(workspaceName);
    const tenant = (await q.query<{ tenant_id: string }>(`INSERT INTO tenants(community_id,display_name,created_by_principal_id)
      VALUES($1,$2,$3) RETURNING tenant_id`, [actor.community_id, input.display_name, context.subject_principal.principal_id])).rows[0];
    await q.query(`INSERT INTO resource_scopes(kind,tenant_ref) VALUES('tenant',$1)`, [tenant.tenant_id]);
    await q.query(`INSERT INTO tenant_memberships(tenant_id,principal_id,role,status,accepted_at) VALUES($1,$2,'owner','active',clock_timestamp())`, [tenant.tenant_id, context.subject_principal.principal_id]);
    const workspace = (await q.query<{ workspace_id: string }>(`INSERT INTO workspaces(tenant_id,name,is_default) VALUES($1,$2,true) RETURNING workspace_id`, [tenant.tenant_id, workspaceName])).rows[0];
    await auditTenant(q, tenant.tenant_id, context.subject_principal.principal_id, 'tenant.create', context.subject_principal.principal_id, '1', '1', 'tenant.created');
    const view = await tenantView(q, tenant.tenant_id, context.subject_principal.principal_id);
    const space = await workspaceView(q, workspace.workspace_id);
    await scopedJournal(q, context, { aggregate_type: 'tenant', id: tenant.tenant_id, version: view.version, operation: 'tenant.create',
      data: { tenant_id: tenant.tenant_id, version: view.version }, eventType: 'freedom.tenant.created.v1' });
    await scopedJournal(q, context, { aggregate_type: 'tenant_membership', id: tenant.tenant_id, version: view.authorization_revision, operation: 'tenant.create',
      data: { tenant_id: tenant.tenant_id, principal_id: context.subject_principal.principal_id, role: 'owner', status: 'active', authorization_revision: view.authorization_revision },
      eventType: 'freedom.tenant.membership.changed.v1' });
    return CreateResultSchema.parse({ tenant: view, workspace: space });
  }, async (q, context) => {
    const prior = await priorResponse(q, context, 'tenant.create', key);
    if (!prior) return;
    const tenantId = (prior.tenant as { tenant_id?: unknown } | undefined)?.tenant_id;
    requireCondition(typeof tenantId === 'string', 403, 'tenant_capability_denied', '目前無法使用這個業務空間。');
    await stillActiveMember(q, tenantId, context.subject_principal.principal_id);
  });
}

export async function listMyTenants(pool: Pool, actor: Actor, query: { cursor?: string; limit?: string }) {
  const limit = limitOf(query.limit);
  return transaction(pool, async q => {
    const context = await lockMemberSession(q, actor).then(() => mapPersonPrincipal(q, actor.user_id));
    requireCondition(context.status === 'active', 403, 'principal_disabled', '這個身分目前無法使用。');
    const after = readCursor(query.cursor, context.principal_id, 'tenants', null);
    const rows = (await q.query<{ tenant_id: string }>(`SELECT t.tenant_id FROM tenant_memberships m JOIN tenants t ON t.tenant_id=m.tenant_id
      WHERE m.principal_id=$1 AND m.status='active' AND t.community_id=$2 AND ($3::uuid IS NULL OR t.tenant_id > $3::uuid)
      ORDER BY t.tenant_id LIMIT $4`, [context.principal_id, actor.community_id, after, limit + 1])).rows;
    const page = rows.slice(0, limit);
    const items = [];
    for (const row of page) items.push(await tenantView(q, row.tenant_id, context.principal_id));
    const source = (await q.query<{ version: string }>(`SELECT COALESCE(sum(t.version + t.authorization_revision + m.version), 0)::bigint::text AS version
      FROM tenant_memberships m JOIN tenants t ON t.tenant_id=m.tenant_id
      WHERE m.principal_id=$1 AND m.status='active' AND t.community_id=$2`, [context.principal_id, actor.community_id])).rows[0].version;
    return TenantPageSchema.parse({
      items, next_cursor: rows.length > limit ? encodeCursor(context.principal_id, 'tenants', null, page[page.length - 1].tenant_id) : null,
      source_version: versionOf(source === '0' ? '1' : source),
    });
  });
}

export async function getTenant(pool: Pool, actor: Actor, tenantId: string) {
  OpaqueId.parse(tenantId);
  return transaction(pool, async q => {
    const context = await lockTenantScope(q, { actor, tenantId, capabilitiesForRole: roleCapabilities });
    return tenantView(q, context.tenant_id, context.principal_id);
  });
}

export async function editTenant(pool: Pool, actor: Actor, tenantId: string, body: unknown, key: string, expected: string) {
  const input = TenantEditInputSchema.parse(body);
  if (input.public_slug && RESERVED_SLUGS.has(input.public_slug)) throw new Problem(422, 'validation_failed', '這個網址代號無法使用。');
  OpaqueId.parse(tenantId);
  try {
    return await scopedTenantCommand(pool, {
      actor, tenantId, operation: 'tenant.edit', key, body: input, expected,
      target: { kind: 'tenant', id: tenantId }, capabilitiesForRole: roleCapabilities,
    }, async (_q, context) => { requireMutable(context); requireCap(context, 'tenant.metadata.edit'); }, async (q, context) => {
      const current = (await q.query<{ version: string }>(`SELECT version::text AS version FROM tenants WHERE tenant_id=$1`, [context.tenant_id])).rows[0];
      requireCondition(current, 404, 'tenant_not_found', NOT_FOUND);
      checkVersion(versionOf(current.version), expected);
      await q.query(`UPDATE tenants SET display_name=$2, public_slug=$3, version=version+1, updated_at=clock_timestamp() WHERE tenant_id=$1`, [context.tenant_id, input.display_name, input.public_slug]);
      await auditTenant(q, context.tenant_id, context.principal_id, 'tenant.edit', null, context.authorization_revision, context.authorization_revision, 'tenant.edited');
      return tenantView(q, context.tenant_id, context.principal_id);
    });
  } catch (error) { writeError(error); }
}

export async function createWorkspace(pool: Pool, actor: Actor, tenantId: string, body: unknown, key: string) {
  const input = WorkspaceCreateInputSchema.parse(body);
  OpaqueId.parse(tenantId);
  return scopedTenantCommand(pool, {
    actor, tenantId, operation: 'tenant.workspace.create', key, body: input,
    target: { kind: 'tenant_workspace_collection', id: tenantId }, capabilitiesForRole: roleCapabilities,
  }, async (_q, context) => { requireMutable(context); requireCap(context, 'tenant.workspace.create'); }, async (q, context) => {
    const count = (await q.query<{ n: number }>(`SELECT count(*)::int AS n FROM workspaces WHERE tenant_id=$1`, [context.tenant_id])).rows[0].n;
    if (count >= MAX_WORKSPACES_PER_TENANT) throw new Problem(429, 'quota_exceeded', '這個業務空間的工作區已達上限。', 60);
    const workspace = (await q.query<{ workspace_id: string }>(`INSERT INTO workspaces(tenant_id,name) VALUES($1,$2) RETURNING workspace_id`, [context.tenant_id, input.name])).rows[0];
    await auditTenant(q, context.tenant_id, context.principal_id, 'tenant.workspace.create', null, context.authorization_revision, context.authorization_revision, 'tenant.workspace.created');
    return workspaceView(q, workspace.workspace_id);
  });
}

export async function listWorkspaces(pool: Pool, actor: Actor, tenantId: string, query: { cursor?: string; limit?: string }) {
  OpaqueId.parse(tenantId);
  const limit = limitOf(query.limit);
  return transaction(pool, async q => {
    const context = await lockTenantScope(q, { actor, tenantId, capabilitiesForRole: roleCapabilities });
    requireCap(context, 'tenant.workspace.read');
    const after = readCursor(query.cursor, context.principal_id, 'workspaces', context.tenant_id);
    const rows = (await q.query<{ workspace_id: string }>(`SELECT workspace_id FROM workspaces WHERE tenant_id=$1 AND ($2::uuid IS NULL OR workspace_id > $2::uuid)
      ORDER BY workspace_id LIMIT $3`, [context.tenant_id, after, limit + 1])).rows;
    const page = rows.slice(0, limit);
    const items = [];
    for (const row of page) items.push(await workspaceView(q, row.workspace_id));
    const source = (await q.query<{ version: string | null }>(`SELECT max(version)::text AS version FROM workspaces WHERE tenant_id=$1`, [context.tenant_id])).rows[0].version;
    return WorkspacePageSchema.parse({
      items, next_cursor: rows.length > limit ? encodeCursor(context.principal_id, 'workspaces', context.tenant_id, page[page.length - 1].workspace_id) : null,
      source_version: versionOf(source ?? '1'),
    });
  });
}

export async function listMembers(pool: Pool, actor: Actor, tenantId: string, query: { cursor?: string; limit?: string }) {
  OpaqueId.parse(tenantId);
  const limit = limitOf(query.limit);
  return transaction(pool, async q => {
    const context = await lockTenantScope(q, { actor, tenantId, capabilitiesForRole: roleCapabilities });
    const full = can(context.role, 'tenant.member.read');
    const after = readCursor(query.cursor, context.principal_id, full ? 'members' : 'my_membership', context.tenant_id);
    const rows = full
      ? (await q.query<{ principal_id: string }>(`SELECT principal_id FROM tenant_memberships WHERE tenant_id=$1 AND ($2::uuid IS NULL OR principal_id > $2::uuid)
          ORDER BY principal_id LIMIT $3`, [context.tenant_id, after, limit + 1])).rows
      : (await q.query<{ principal_id: string }>(`SELECT principal_id FROM tenant_memberships WHERE tenant_id=$1 AND principal_id=$2
          AND ($3::uuid IS NULL OR principal_id > $3::uuid) ORDER BY principal_id LIMIT $4`, [context.tenant_id, context.principal_id, after, limit + 1])).rows;
    const page = rows.slice(0, limit);
    const items = [];
    for (const row of page) items.push(await memberView(q, context.tenant_id, row.principal_id));
    return MemberPageSchema.parse({
      items, next_cursor: rows.length > limit ? encodeCursor(context.principal_id, full ? 'members' : 'my_membership', context.tenant_id, page[page.length - 1].principal_id) : null,
      source_version: versionOf(context.authorization_revision),
    });
  });
}

async function visibleInvitee(q: PoolClient, principalId: string, communityId: string): Promise<void> {
  const row = (await q.query<{ ok: boolean }>(`SELECT true AS ok FROM principals p JOIN users u ON u.user_id=p.user_ref
    WHERE p.principal_id=$1 AND p.kind='person' AND p.status='active' AND u.community_id=$2 AND u.active
      AND (NOT u.onboarding_required OR u.onboarding_completed_at IS NOT NULL)`, [principalId, communityId])).rows[0];
  requireCondition(row?.ok, 404, 'member_not_found', '找不到這位會員。');
}

export async function inviteMember(pool: Pool, actor: Actor, tenantId: string, body: unknown, key: string) {
  const input = InviteInputSchema.parse(body);
  OpaqueId.parse(tenantId);
  try {
    return await scopedTenantCommand(pool, {
      actor, tenantId, operation: 'tenant.invite', key, body: input,
      target: { kind: 'tenant_invitation', id: input.invitee_principal_id }, capabilitiesForRole: roleCapabilities,
    }, async (_q, context) => {
      requireMutable(context);
      requireCap(context, 'tenant.member.invite');
      requireCondition(canInviteRole(context.role, input.role), 403, 'tenant_capability_denied', '你不能邀請這個角色。');
    }, async (q, context) => {
      await visibleInvitee(q, input.invitee_principal_id, context.community_id);
      const existing = (await q.query<{ status: string }>(`SELECT status FROM tenant_memberships WHERE tenant_id=$1 AND principal_id=$2`, [context.tenant_id, input.invitee_principal_id])).rows[0];
      if (existing?.status === 'active') throw new Problem(409, 'membership_exists', '這位成員已在業務空間中。');
      const window = (await q.query<{ ok: boolean }>(`SELECT ($1::timestamptz > clock_timestamp() AND $1::timestamptz <= clock_timestamp() + ($2::text || ' days')::interval) AS ok`, [input.expires_at, String(MAX_INVITATION_DAYS)])).rows[0].ok;
      requireCondition(window, 422, 'validation_failed', '邀請到期時間必須在 7 日以內。');
      await q.query(`UPDATE tenant_invitations SET state='expired', version=version+1, updated_at=clock_timestamp()
        WHERE tenant_id=$1 AND state='pending' AND expires_at<=clock_timestamp()`, [context.tenant_id]);
      const pending = (await q.query<{ n: number }>(`SELECT count(*)::int AS n FROM tenant_invitations WHERE tenant_id=$1 AND state='pending' AND expires_at>clock_timestamp()`, [context.tenant_id])).rows[0].n;
      if (pending >= MAX_PENDING_INVITATIONS_PER_TENANT) throw new Problem(429, 'quota_exceeded', '待回覆的邀請已達上限。', 60);
      const created = (await q.query<{ invitation_id: string }>(`INSERT INTO tenant_invitations(tenant_id,invitee_principal_id,role,instance_capabilities,expires_at,state,created_by_principal_id)
        VALUES($1,$2,$3,'[]'::jsonb,$4::timestamptz,'pending',$5) RETURNING invitation_id`,
      [context.tenant_id, input.invitee_principal_id, input.role, input.expires_at, context.principal_id])).rows[0];
      await auditTenant(q, context.tenant_id, context.principal_id, 'tenant.invite', input.invitee_principal_id, context.authorization_revision, context.authorization_revision, 'tenant.invite.created');
      return invitationView(q, created.invitation_id);
    });
  } catch (error) { writeError(error); }
}

export async function listMyInvitations(pool: Pool, actor: Actor, query: { cursor?: string; limit?: string }) {
  const limit = limitOf(query.limit);
  const principalId = await callerPrincipal(pool, actor);
  await pool.query(`UPDATE tenant_invitations SET state='expired', version=version+1, updated_at=clock_timestamp()
    WHERE invitee_principal_id=$1 AND state='pending' AND expires_at<=clock_timestamp()`, [principalId]);
  return transaction(pool, async q => {
    await lockMemberSession(q, actor);
    const after = readCursor(query.cursor, principalId, 'my_invitations', null);
    const rows = (await q.query<{ invitation_id: string }>(`SELECT invitation_id FROM tenant_invitations WHERE invitee_principal_id=$1
      AND ($2::uuid IS NULL OR invitation_id > $2::uuid) ORDER BY invitation_id LIMIT $3`, [principalId, after, limit + 1])).rows;
    const page = rows.slice(0, limit);
    const items = [];
    for (const row of page) items.push(await invitationView(q, row.invitation_id));
    const source = (await q.query<{ version: string }>(`SELECT COALESCE(max(version)::text, '1') AS version
      FROM tenant_invitations WHERE invitee_principal_id=$1`, [principalId])).rows[0].version;
    return InvitationPageSchema.parse({
      items, next_cursor: rows.length > limit ? encodeCursor(principalId, 'my_invitations', null, page[page.length - 1].invitation_id) : null,
      source_version: versionOf(source),
    });
  });
}

async function invitationGate(pool: Pool, actor: Actor, tenantId: string, invitationId: string, who: 'invitee' | 'manager'): Promise<'ready' | 'expired'> {
  const decision = await transaction(pool, async q => {
    await lockMemberSession(q, actor);
    const principal = await mapPersonPrincipal(q, actor.user_id);
    requireCondition(principal.status === 'active', 403, 'principal_disabled', '這個身分目前無法使用。');
    const row = (await q.query<{ invitee_principal_id: string; created_by_principal_id: string; state: string; expired: boolean; role: 'admin' | 'operator' | 'viewer' }>(
      `SELECT invitee_principal_id,created_by_principal_id,state,role,(state='pending' AND expires_at<=clock_timestamp()) AS expired
       FROM tenant_invitations WHERE invitation_id=$1 AND tenant_id=$2 FOR SHARE`, [invitationId, tenantId])).rows[0];
    if (!row) return 'missing' as const;
    if (who === 'invitee' && row.invitee_principal_id !== principal.principal_id) return 'missing' as const;
    if (who === 'manager') {
      const actorMember = (await q.query<{ role: 'owner' | 'admin' | 'operator' | 'viewer'; status: string }>(
        `SELECT role,status FROM tenant_memberships WHERE tenant_id=$1 AND principal_id=$2`, [tenantId, principal.principal_id])).rows[0];
      const manager = actorMember?.status === 'active' && (actorMember.role === 'owner' || (row.created_by_principal_id === principal.principal_id && canInviteRole(actorMember.role, row.role)));
      if (!manager) return 'missing' as const;
    }
    if (row.expired || row.state === 'expired') return 'expired' as const;
    return 'ready' as const;
  });
  if (decision === 'missing') throw new Problem(404, 'invitation_not_found', INVITE_MISSING);
  if (decision === 'expired') {
    await pool.query(`UPDATE tenant_invitations SET state='expired', version=version+1, updated_at=clock_timestamp()
      WHERE invitation_id=$1 AND tenant_id=$2 AND state='pending' AND expires_at<=clock_timestamp()`, [invitationId, tenantId]);
    throw new Problem(409, 'invitation_expired', '邀請已過期。');
  }
  return decision;
}

export async function acceptInvitation(pool: Pool, actor: Actor, tenantId: string, invitationId: string, body: unknown, key: string, expected: string) {
  EmptyObjectSchema.parse(body);
  OpaqueId.parse(tenantId); OpaqueId.parse(invitationId);
  await invitationGate(pool, actor, tenantId, invitationId, 'invitee');
  const principalId = await callerPrincipal(pool, actor);
  return scopedMemberCommand(pool, {
    actor, scope: 'personal', operation: 'tenant.invite.accept', key, body: {}, expected,
    target: { kind: 'tenant_invitation', id: invitationId },
  }, async () => {}, async (q, context) => {
    requireCondition(context.subject_principal.principal_id === principalId, 403, 'tenant_capability_denied', DENIED);
    const scope = (await q.query<{ scope_id: string; status: string }>(`SELECT scope_id,status FROM resource_scopes WHERE tenant_ref=$1 FOR SHARE`, [tenantId])).rows[0];
    requireCondition(scope?.status === 'active', 404, 'invitation_not_found', INVITE_MISSING);
    const tenant = (await q.query<{ status: TenantStatus; community_id: string; authorization_revision: string }>(
      `SELECT status,community_id,authorization_revision::text AS authorization_revision FROM tenants WHERE tenant_id=$1 FOR UPDATE`, [tenantId])).rows[0];
    requireCondition(tenant && tenant.community_id === actor.community_id, 404, 'invitation_not_found', INVITE_MISSING);
    const invitation = (await q.query<{ invitee_principal_id: string; created_by_principal_id: string; role: 'admin' | 'operator' | 'viewer'; state: string; version: string; expired: boolean }>(
      `SELECT invitee_principal_id,created_by_principal_id,role,state,version::text AS version,(state='pending' AND expires_at<=clock_timestamp()) AS expired
       FROM tenant_invitations WHERE invitation_id=$1 AND tenant_id=$2 FOR UPDATE`, [invitationId, tenantId])).rows[0];
    requireCondition(invitation, 404, 'invitation_not_found', INVITE_MISSING);
    requireCondition(invitation.invitee_principal_id === context.subject_principal.principal_id, 404, 'invitation_not_found', INVITE_MISSING);
    if (invitation.expired || invitation.state === 'expired') throw new Problem(409, 'invitation_expired', '邀請已過期。');
    requireCondition(invitation.state === 'pending', 409, 'invitation_closed', '這份邀請已結束。');
    checkVersion(versionOf(invitation.version), expected);
    if (tenant.status === 'suspended') throw new Problem(409, 'tenant_suspended', '這個業務空間已暫停。');
    if (tenant.status === 'recovery_required') throw new Problem(409, 'tenant_recovery_required', '這個業務空間需要復原後才能變更。');
    requireCondition(tenant.status === 'active', 409, 'tenant_capability_denied', '這個業務空間已封存，目前不能變更。');
    const inviter = (await q.query<{ role: 'owner' | 'admin' | 'operator' | 'viewer'; status: string }>(
      `SELECT role,status FROM tenant_memberships WHERE tenant_id=$1 AND principal_id=$2 FOR SHARE`, [tenantId, invitation.created_by_principal_id])).rows[0];
    requireCondition(inviter?.status === 'active' && canInviteRole(inviter.role, invitation.role), 403, 'tenant_capability_denied', '邀請人目前不能授予這個角色。');
    const already = (await q.query<{ status: string }>(`SELECT status FROM tenant_memberships WHERE tenant_id=$1 AND principal_id=$2 FOR UPDATE`, [tenantId, context.subject_principal.principal_id])).rows[0];
    if (already?.status === 'active') throw new Problem(409, 'membership_exists', '這位成員已在業務空間中。');
    if (already) {
      await q.query(`UPDATE tenant_memberships SET role=$3,status='active',version=version+1,accepted_at=clock_timestamp(),revoked_at=NULL,updated_at=clock_timestamp()
        WHERE tenant_id=$1 AND principal_id=$2`, [tenantId, context.subject_principal.principal_id, invitation.role]);
    } else {
      await q.query(`INSERT INTO tenant_memberships(tenant_id,principal_id,role,status,accepted_at) VALUES($1,$2,$3,'active',clock_timestamp())`, [tenantId, context.subject_principal.principal_id, invitation.role]);
    }
    await q.query(`UPDATE tenant_invitations SET state='accepted', version=version+1, updated_at=clock_timestamp() WHERE invitation_id=$1`, [invitationId]);
    const revision = await bumpAuthorizationRevision(q, tenantId);
    await auditTenant(q, tenantId, context.subject_principal.principal_id, 'tenant.invite.accept', context.subject_principal.principal_id, tenant.authorization_revision, revision, 'tenant.invite.accepted');
    await scopedJournal(q, context, { aggregate_type: 'tenant_membership', id: tenantId, version: revision, operation: 'tenant.invite.accept',
      data: { tenant_id: tenantId, principal_id: context.subject_principal.principal_id, role: invitation.role, status: 'active', authorization_revision: revision },
      eventType: 'freedom.tenant.membership.changed.v1' });
    return AcceptResultSchema.parse({ invitation: await invitationView(q, invitationId), membership: await memberView(q, tenantId, context.subject_principal.principal_id) });
  }, async (q, context) => {
    const prior = await priorResponse(q, context, 'tenant.invite.accept', key);
    if (!prior) return;
    const recorded = (prior.invitation as { tenant_id?: unknown } | undefined)?.tenant_id;
    requireCondition(typeof recorded === 'string', 403, 'tenant_capability_denied', '目前無法使用這個業務空間。');
    await stillActiveMember(q, recorded, context.subject_principal.principal_id);
  });
}

export async function declineInvitation(pool: Pool, actor: Actor, tenantId: string, invitationId: string, body: unknown, key: string) {
  EmptyObjectSchema.parse(body);
  OpaqueId.parse(tenantId); OpaqueId.parse(invitationId);
  await invitationGate(pool, actor, tenantId, invitationId, 'invitee');
  return scopedMemberCommand(pool, {
    actor, scope: 'personal', operation: 'tenant.invite.decline', key, body: {},
    target: { kind: 'tenant_invitation', id: invitationId },
  }, async () => {}, async (q, context) => {
    const invitation = (await q.query<{ invitee_principal_id: string; state: string; expired: boolean }>(
      `SELECT invitee_principal_id,state,(state='pending' AND expires_at<=clock_timestamp()) AS expired
       FROM tenant_invitations WHERE invitation_id=$1 AND tenant_id=$2 FOR UPDATE`, [invitationId, tenantId])).rows[0];
    requireCondition(invitation, 404, 'invitation_not_found', INVITE_MISSING);
    requireCondition(invitation.invitee_principal_id === context.subject_principal.principal_id, 404, 'invitation_not_found', INVITE_MISSING);
    if (invitation.expired || invitation.state === 'expired') throw new Problem(409, 'invitation_expired', '邀請已過期。');
    requireCondition(invitation.state === 'pending', 409, 'invitation_closed', '這份邀請已結束。');
    await q.query(`UPDATE tenant_invitations SET state='declined', version=version+1, updated_at=clock_timestamp() WHERE invitation_id=$1`, [invitationId]);
    const tenant = (await q.query<{ authorization_revision: string }>(`SELECT authorization_revision::text AS authorization_revision FROM tenants WHERE tenant_id=$1`, [tenantId])).rows[0];
    requireCondition(tenant, 404, 'invitation_not_found', INVITE_MISSING);
    await auditTenant(q, tenantId, context.subject_principal.principal_id, 'tenant.invite.decline', context.subject_principal.principal_id, tenant.authorization_revision, tenant.authorization_revision, 'tenant.invite.declined');
    return invitationView(q, invitationId);
  });
}

export async function revokeInvitation(pool: Pool, actor: Actor, tenantId: string, invitationId: string, body: unknown, key: string, expected: string) {
  const input = InvitationRevokeInputSchema.parse(body);
  OpaqueId.parse(tenantId); OpaqueId.parse(invitationId);
  await invitationGate(pool, actor, tenantId, invitationId, 'manager');
  return scopedTenantCommand(pool, {
    actor, tenantId, operation: 'tenant.invite.revoke', key, body: input, expected,
    target: { kind: 'tenant_invitation', id: invitationId }, capabilitiesForRole: roleCapabilities,
  }, async (_q, context) => { requireMutable(context); }, async (q, context) => {
    const invitation = (await q.query<{ invitee_principal_id: string; created_by_principal_id: string; role: 'admin' | 'operator' | 'viewer'; state: string; version: string; expired: boolean }>(
      `SELECT invitee_principal_id,created_by_principal_id,role,state,version::text AS version,(state='pending' AND expires_at<=clock_timestamp()) AS expired
       FROM tenant_invitations WHERE invitation_id=$1 AND tenant_id=$2 FOR UPDATE`, [invitationId, tenantId])).rows[0];
    requireCondition(invitation, 404, 'invitation_not_found', INVITE_MISSING);
    requireCondition(context.role === 'owner' || invitation.created_by_principal_id === context.principal_id && canInviteRole(context.role, invitation.role),
      404, 'invitation_not_found', INVITE_MISSING);
    if (invitation.expired || invitation.state === 'expired') throw new Problem(409, 'invitation_expired', '邀請已過期。');
    requireCondition(invitation.state === 'pending', 409, 'invitation_closed', '這份邀請已結束。');
    checkVersion(versionOf(invitation.version), expected);
    await q.query(`UPDATE tenant_invitations SET state='revoked', revoked_reason=$2, version=version+1, updated_at=clock_timestamp() WHERE invitation_id=$1`, [invitationId, input.reason]);
    await auditTenant(q, context.tenant_id, context.principal_id, 'tenant.invite.revoke', invitation.invitee_principal_id, context.authorization_revision, context.authorization_revision, 'tenant.invite.revoked');
    return invitationView(q, invitationId);
  });
}

export async function changeMember(pool: Pool, actor: Actor, tenantId: string, principalId: string, body: unknown, key: string, expected: string) {
  const input = MemberChangeInputSchema.parse(body);
  OpaqueId.parse(tenantId); OpaqueId.parse(principalId);
  return scopedTenantCommand(pool, {
    actor, tenantId, operation: 'tenant.member.change', key, body: input, expected,
    target: { kind: 'tenant_membership', id: principalId }, capabilitiesForRole: roleCapabilities,
  }, async (_q, context) => { requireMutable(context); requireCap(context, 'tenant.member.manage'); }, async (q, context) => {
    const target = (await q.query<{ role: MemberView['role']; status: 'active' | 'revoked'; version: string }>(
      `SELECT role,status,version::text AS version FROM tenant_memberships WHERE tenant_id=$1 AND principal_id=$2 FOR UPDATE`, [tenantId, principalId])).rows[0];
    requireCondition(target, 404, 'member_not_found', MEMBER_MISSING);
    checkVersion(versionOf(target.version), expected);
    if (target.status !== 'active') throw new Problem(409, 'member_not_active', '這位夥伴已不在業務空間，需要重新邀請並由對方接受。');
    if (target.role === 'owner') {
      const owners = await activeOwnerCount(q, tenantId);
      if (target.status === 'active' && owners <= 1) throw new Problem(409, 'last_owner_required', '業務空間至少要有一位使用中的擁有者。');
      throw new Problem(403, 'tenant_capability_denied', '擁有者變更需要所有權移交。');
    }
    requireCondition(canManageRole(context.role, target.role) && canManageRole(context.role, input.role), 403, 'tenant_capability_denied', DENIED);
    if (input.status === 'active') {
      await q.query(`UPDATE tenant_memberships SET role=$3,status='active',version=version+1,revoked_at=NULL,accepted_at=COALESCE(accepted_at,clock_timestamp()),updated_at=clock_timestamp()
        WHERE tenant_id=$1 AND principal_id=$2`, [tenantId, principalId, input.role]);
    } else {
      await q.query(`UPDATE tenant_memberships SET role=$3,status='revoked',version=version+1,revoked_at=clock_timestamp(),updated_at=clock_timestamp()
        WHERE tenant_id=$1 AND principal_id=$2`, [tenantId, principalId, input.role]);
    }
    const revision = await bumpAuthorizationRevision(q, tenantId);
    await auditTenant(q, tenantId, context.principal_id, 'tenant.member.change', principalId, context.authorization_revision, revision, 'tenant.member.changed');
    await scopedJournal(q, context, { aggregate_type: 'tenant_membership', id: tenantId, version: revision, operation: 'tenant.member.change',
      data: { tenant_id: tenantId, principal_id: principalId, role: input.role, status: input.status, authorization_revision: revision },
      eventType: 'freedom.tenant.membership.changed.v1' });
    return memberView(q, tenantId, principalId);
  });
}

export async function leaveTenant(pool: Pool, actor: Actor, tenantId: string, body: unknown, key: string, expected: string) {
  EmptyObjectSchema.parse(body);
  OpaqueId.parse(tenantId);
  return scopedTenantCommand(pool, {
    actor, tenantId, operation: 'tenant.member.leave', key, body: {}, expected,
    target: { kind: 'tenant_membership', id: tenantId }, capabilitiesForRole: roleCapabilities,
  }, async (_q, context) => { requireMutable(context); }, async (q, context) => {
    const mine = (await q.query<{ role: MemberView['role']; version: string }>(
      `SELECT role,version::text AS version FROM tenant_memberships WHERE tenant_id=$1 AND principal_id=$2 AND status='active' FOR UPDATE`,
      [tenantId, context.principal_id])).rows[0];
    requireCondition(mine, 404, 'tenant_not_found', NOT_FOUND);
    checkVersion(versionOf(mine.version), expected);
    if (mine.role === 'owner' && await activeOwnerCount(q, tenantId) <= 1) throw new Problem(409, 'last_owner_required', '業務空間至少要有一位使用中的擁有者。');
    const updated = (await q.query<{ version: string }>(`UPDATE tenant_memberships SET status='revoked', version=version+1, revoked_at=clock_timestamp(), updated_at=clock_timestamp()
      WHERE tenant_id=$1 AND principal_id=$2 RETURNING version::text`, [tenantId, context.principal_id])).rows[0];
    requireCondition(updated, 404, 'tenant_not_found', NOT_FOUND);
    const revision = await bumpAuthorizationRevision(q, tenantId);
    await auditTenant(q, tenantId, context.principal_id, 'tenant.member.leave', context.principal_id, context.authorization_revision, revision, 'tenant.member.left');
    await scopedJournal(q, context, { aggregate_type: 'tenant_membership', id: tenantId, version: revision, operation: 'tenant.member.leave',
      data: { tenant_id: tenantId, principal_id: context.principal_id, role: mine.role, status: 'revoked', authorization_revision: revision },
      eventType: 'freedom.tenant.membership.changed.v1' });
    return LeaveResultSchema.parse({ status: 'revoked', version: versionOf(updated.version) });
  });
}

export async function resolveInviteCandidate(pool: Pool, actor: Actor, userId: string) {
  OpaqueId.parse(userId);
  return transaction(pool, async q => {
    await lockMemberSession(q, actor);
    const user = (await q.query<{ user_id: string; display_name: string }>(`SELECT user_id,display_name FROM users
      WHERE user_id=$1 AND community_id=$2 AND active AND (NOT onboarding_required OR onboarding_completed_at IS NOT NULL)`, [userId, actor.community_id])).rows[0];
    requireCondition(user, 404, 'member_not_found', '找不到這位會員。');
    const principal = await mapPersonPrincipal(q, user.user_id);
    requireCondition(principal.kind === 'person' && principal.status === 'active', 404, 'member_not_found', '找不到這位會員。');
    return InviteCandidateSchema.parse({ principal_id: principal.principal_id, display_name: user.display_name });
  });
}
