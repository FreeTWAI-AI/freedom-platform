import type { Pool, PoolClient } from 'pg';
import type { Actor } from '../../modules/identity-membership/service.js';
import { OpaqueId, PrincipalRefSchema, ResourceScopeRefSchema, type PrincipalRef, type ResourceScopeRef } from '../../contracts/common/v1/identity.js';
import { transaction } from '../db/transaction.js';
import { lockMemberSession } from '../db/member-session.js';
import { requireCondition } from '../shared/problem.js';

type MemberScopeKind = 'personal' | 'community';
type PrincipalRow = { principal_id: string; kind: 'person'; status: 'active' | 'disabled' };
type ScopeRow = { scope_id: string; kind: MemberScopeKind; status: 'active' | 'disabled' };
type Created = { principals: number; community_scopes: number; personal_scopes: number };
export interface MemberScopeContext {
  readonly authn_kind: 'member_session';
  readonly subject_principal: Readonly<PrincipalRef>;
  readonly scope: Readonly<ResourceScopeRef>;
}
export interface MemberScopeInput {
  actor: Actor;
  scope: MemberScopeKind | ResourceScopeRef;
  lockUser?: boolean;
}

async function ensurePrincipal(q: PoolClient, userId: string, created?: Created): Promise<PrincipalRow> {
  let row = (await q.query<PrincipalRow>("SELECT principal_id,kind,status FROM principals WHERE user_ref=$1 FOR SHARE", [userId])).rows[0];
  if (!row) {
    const inserted = await q.query("INSERT INTO principals(user_ref) VALUES($1) ON CONFLICT(user_ref) DO NOTHING", [userId]);
    if (created) created.principals += inserted.rowCount ?? 0;
    // A separate READ COMMITTED statement sees the winner after a concurrent
    // INSERT. Never use DO UPDATE to fetch it: that could reset disabled state.
    row = (await q.query<PrincipalRow>("SELECT principal_id,kind,status FROM principals WHERE user_ref=$1 FOR SHARE", [userId])).rows[0];
  }
  requireCondition(row, 503, 'foundation_mapping_unavailable', '身分映射暫時無法使用。');
  return row;
}

async function ensureScope(q: PoolClient, kind: MemberScopeKind, backingId: string, created?: Created): Promise<ScopeRow> {
  // Only server-selected identifiers enter SQL. Values are always parameters.
  const column = kind === 'community' ? 'community_ref' : 'owner_principal_id';
  let row = (await q.query<ScopeRow>(`SELECT scope_id,kind,status FROM resource_scopes WHERE ${column}=$1 FOR SHARE`, [backingId])).rows[0];
  if (!row) {
    const inserted = await q.query(`INSERT INTO resource_scopes(kind,${column}) VALUES($1,$2) ON CONFLICT(${column}) DO NOTHING`, [kind, backingId]);
    if (created) created[kind === 'community' ? 'community_scopes' : 'personal_scopes'] += inserted.rowCount ?? 0;
    row = (await q.query<ScopeRow>(`SELECT scope_id,kind,status FROM resource_scopes WHERE ${column}=$1 FOR SHARE`, [backingId])).rows[0];
  }
  requireCondition(row && row.kind === kind, 503, 'foundation_mapping_unavailable', '資源範圍映射暫時無法使用。');
  return row;
}

/** Equality of typed refs is necessary, not sufficient, for domain authorization. */
export function requireSameScope(expected: ResourceScopeRef, actual: unknown): void {
  const parsed = ResourceScopeRefSchema.safeParse(actual);
  requireCondition(parsed.success && parsed.data.kind === expected.kind && parsed.data.scope_id === expected.scope_id,
    404, 'resource_not_found', '找不到這項資源。');
}

/**
 * A server-side transaction, not a command receipt/Grant and not an HTTP route.
 * Current user/session/principal/selected scope are locked before domain auth.
 * Mapping is lazy for new members, without touching any old member route.
 * Domain writes still need their own idempotency and version checks; never use
 * this wrapper to bypass command(). No network I/O in either callback.
 */
export async function withMemberScope<T>(pool: Pool,
  input: MemberScopeInput,
  authorize: (q: PoolClient, context: MemberScopeContext) => Promise<unknown>,
  run: (q: PoolClient, context: MemberScopeContext) => Promise<T>): Promise<T> {
  const requested = typeof input.scope === 'string' ? null : ResourceScopeRefSchema.parse(input.scope);
  const kind = typeof input.scope === 'string' ? input.scope : requested!.kind;
  requireCondition(kind === 'personal' || kind === 'community', 403, 'scope_kind_unavailable', '這種資源範圍尚未開放。');
  return transaction(pool, async q => {
    const context = await lockMemberScope(q, { ...input, scope: requested ?? kind });
    await authorize(q, context); // A scope never substitutes for domain ACL.
    return run(q, context);
  });
}

/** Resolve/lock current authority on the caller's existing transaction client.
 * Does not begin a transaction, authorize a target, or read/write receipts.
 * Caller must maintain user -> session -> principal -> scope -> domain order.
 */
export async function lockMemberScope(q: PoolClient, input: MemberScopeInput): Promise<MemberScopeContext> {
  const requested = typeof input.scope === 'string' ? null : ResourceScopeRefSchema.parse(input.scope);
  const kind = typeof input.scope === 'string' ? input.scope : requested!.kind;
  requireCondition(kind === 'personal' || kind === 'community', 403, 'scope_kind_unavailable', '這種資源範圍尚未開放。');
  await lockMemberSession(q, input.actor, input.lockUser);
  const principal = await ensurePrincipal(q, input.actor.user_id);
  requireCondition(principal.status === 'active', 403, 'principal_disabled', '這個身分目前無法使用。');
  const scope = await ensureScope(q, kind, kind === 'personal' ? principal.principal_id : input.actor.community_id);
  const ref = ResourceScopeRefSchema.parse({ scope_id: scope.scope_id, kind: scope.kind });
  if (requested) requireSameScope(ref, requested);
  requireCondition(scope.status === 'active', 403, 'scope_disabled', '這個資源範圍目前無法使用。');
  return Object.freeze({ authn_kind: 'member_session' as const,
    subject_principal: Object.freeze(PrincipalRefSchema.parse({ principal_id: principal.principal_id, kind: principal.kind })),
    scope: Object.freeze(ref) });
}

/** No credentials, email matching or permission writes. Disabled rows count as
 * mapped and are never re-enabled. Each call is one bounded, resumable batch. */
export async function backfillLegacyScopeBatch(pool: Pool, limit = 100) {
  requireCondition(Number.isSafeInteger(limit) && limit >= 1 && limit <= 500, 400, 'invalid_batch_limit', '批次大小必須介於 1 到 500。');
  return transaction(pool, async q => {
    await q.query("SET LOCAL lock_timeout='5s'");
    await q.query("SET LOCAL statement_timeout='30s'");
    const created: Created = { principals: 0, community_scopes: 0, personal_scopes: 0 };
    const communities = await q.query<{ community_id: string }>(`SELECT c.community_id FROM communities c
      WHERE NOT EXISTS(SELECT 1 FROM resource_scopes s WHERE s.community_ref=c.community_id)
      ORDER BY c.community_id LIMIT $1 FOR UPDATE OF c SKIP LOCKED`, [limit]);
    for (const row of communities.rows) await ensureScope(q, 'community', row.community_id, created);
    // Never hold a newly inserted community scope while waiting for a member's
    // principal: the runtime takes user -> principal -> community scope. Keep
    // these phases in separate transactions; skip users already in use.
    const users = communities.rows.length ? { rows: [] } : await q.query<{ user_id: string }>(`SELECT u.user_id FROM users u
      WHERE NOT EXISTS(SELECT 1 FROM principals p JOIN resource_scopes s ON s.owner_principal_id=p.principal_id WHERE p.user_ref=u.user_id)
      ORDER BY u.user_id LIMIT $1 FOR UPDATE OF u SKIP LOCKED`, [limit]);
    for (const row of users.rows) {
      const principal = await ensurePrincipal(q, row.user_id, created);
      await ensureScope(q, 'personal', principal.principal_id, created);
    }
    const remaining = (await q.query<{ communities: number; users: number }>(`SELECT
      (SELECT count(*)::int FROM communities c WHERE NOT EXISTS(SELECT 1 FROM resource_scopes s WHERE s.community_ref=c.community_id)) AS communities,
      (SELECT count(*)::int FROM users u WHERE NOT EXISTS(SELECT 1 FROM principals p JOIN resource_scopes s ON s.owner_principal_id=p.principal_id WHERE p.user_ref=u.user_id)) AS users`)).rows[0];
    return { processed: communities.rows.length + users.rows.length, created, remaining };
  });
}

export type TenantAccessRole = 'owner' | 'admin' | 'operator' | 'viewer';
export type TenantLifecycle = 'active' | 'suspended' | 'recovery_required' | 'archived';
export interface TenantScopeContext extends MemberScopeContext {
  readonly tenant_id: string;
  readonly community_id: string;
  readonly role: TenantAccessRole;
  readonly capabilities: readonly string[];
  readonly authorization_revision: string;
  readonly tenant_status: TenantLifecycle;
  readonly principal_id: string;
  readonly membership_version: string;
}
export interface TenantScopeInput {
  actor: Actor;
  tenantId: string;
  forUpdate?: boolean;
  lockUser?: boolean;
  capabilitiesForRole: (role: TenantAccessRole) => readonly string[];
}

/** Lazy person principal only. Never creates a tenant, site, or service principal. */
export async function mapPersonPrincipal(q: PoolClient, userId: string): Promise<PrincipalRow> {
  return ensurePrincipal(q, userId);
}

/**
 * Resolve one existing tenant scope inside the caller's transaction.
 * Lock order: session, person principal, tenant scope, tenant row, membership.
 * The tenant scope row must already exist. This function never inserts one.
 * A missing tenant, a missing membership, and an inactive membership share one not-found result.
 */
export async function lockTenantScope(q: PoolClient, input: TenantScopeInput): Promise<TenantScopeContext> {
  requireCondition(typeof input.capabilitiesForRole === 'function', 500, 'foundation_mapping_unavailable', '資源範圍映射暫時無法使用。');
  requireCondition(OpaqueId.safeParse(input.tenantId).success, 404, 'tenant_not_found', '找不到這個業務空間。');
  await lockMemberSession(q, input.actor, input.lockUser);
  const principal = await ensurePrincipal(q, input.actor.user_id);
  requireCondition(principal.status === 'active' && principal.kind === 'person', 403, 'principal_disabled', '這個身分目前無法使用。');
  const lock = input.forUpdate ? 'FOR UPDATE' : 'FOR SHARE';
  const scope = (await q.query<{ scope_id: string; kind: string; status: 'active' | 'disabled' }>(`SELECT scope_id,kind,status FROM resource_scopes WHERE tenant_ref=$1 FOR SHARE`, [input.tenantId])).rows[0];
  requireCondition(scope?.kind === 'tenant', 404, 'tenant_not_found', '找不到這個業務空間。');
  requireCondition(scope.status === 'active', 403, 'scope_disabled', '這個資源範圍目前無法使用。');
  const tenant = (await q.query<{ tenant_id: string; community_id: string; status: TenantLifecycle; authorization_revision: string }>(
    `SELECT tenant_id,community_id,status,authorization_revision::text AS authorization_revision FROM tenants WHERE tenant_id=$1 ${lock}`,
    [input.tenantId])).rows[0];
  requireCondition(tenant, 404, 'tenant_not_found', '找不到這個業務空間。');
  const membership = (await q.query<{ role: TenantAccessRole; status: string; version: string }>(
    `SELECT role,status,version::text AS version FROM tenant_memberships WHERE tenant_id=$1 AND principal_id=$2 ${lock}`,
    [input.tenantId, principal.principal_id])).rows[0];
  requireCondition(membership?.status === 'active', 404, 'tenant_not_found', '找不到這個業務空間。');
  requireCondition(tenant.community_id === input.actor.community_id, 404, 'tenant_not_found', '找不到這個業務空間。');
  const role = membership.role;
  requireCondition(role === 'owner' || role === 'admin' || role === 'operator' || role === 'viewer', 404, 'tenant_not_found', '找不到這個業務空間。');
  const ref = ResourceScopeRefSchema.parse({ scope_id: scope.scope_id, kind: 'tenant' });
  return Object.freeze({
    authn_kind: 'member_session' as const,
    subject_principal: Object.freeze(PrincipalRefSchema.parse({ principal_id: principal.principal_id, kind: 'person' as const })),
    scope: Object.freeze(ref),
    tenant_id: tenant.tenant_id,
    community_id: tenant.community_id,
    role,
    capabilities: Object.freeze([...input.capabilitiesForRole(role)]),
    authorization_revision: tenant.authorization_revision,
    tenant_status: tenant.status,
    principal_id: principal.principal_id,
    membership_version: membership.version,
  });
}
