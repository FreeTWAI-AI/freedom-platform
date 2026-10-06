import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { OpaqueId } from '../../contracts/common/v1/identity.js';
import { VersionSchema } from '../../contracts/guild-launchpad/v1/tenant.js';
import { Problem, requireCondition } from '../../packages/shared/problem.js';

export const NOT_FOUND = '找不到這個業務空間。';
export const TRANSFER_MISSING = '找不到這份移交。';
export const RECOVERY_MISSING = '找不到這份復原。';

export function versionOf(value: unknown): string {
  return VersionSchema.parse(String(value));
}

/** One plus the sum of `version`. VersionSchema rejects 0, and mapping an empty
 * sum to 1 would not move when the first version-1 row appears. Rows of these
 * tables are never deleted, and every state change bumps version by one. */
export async function countedSourceVersion(q: PoolClient, table: 'tenant_ownership_transfers' | 'tenant_recovery_cases', predicate: string, params: unknown[]): Promise<string> {
  const sum = (await q.query<{ version: string }>(
    `SELECT COALESCE(sum(version), 0)::bigint::text AS version FROM ${table} WHERE ${predicate}`, params)).rows[0].version;
  return versionOf((BigInt(sum) + 1n).toString());
}
export function iso(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value));
  requireCondition(!Number.isNaN(date.getTime()), 500, 'internal_error', '時間無法讀取。');
  return date.toISOString();
}
export function requireMutableStatus(status: string): void {
  if (status === 'suspended') throw new Problem(409, 'tenant_suspended', '這個業務空間已暫停。');
  if (status === 'recovery_required') throw new Problem(409, 'tenant_recovery_required', '這個業務空間需要復原後才能變更。');
  requireCondition(status === 'active', 409, 'tenant_capability_denied', '這個業務空間已封存，目前不能變更。');
}

export async function auditTenant(q: PoolClient, tenantId: string, actorPrincipalId: string, action: string, targetPrincipalId: string | null, oldRevision: string, newRevision: string, reason: string): Promise<void> {
  await q.query(`INSERT INTO tenant_authority_audit(tenant_id,actor_principal_id,action,target_principal_id,old_revision,new_revision,reason_code)
    VALUES($1,$2,$3,$4,$5,$6,$7)`, [tenantId, actorPrincipalId, action, targetPrincipalId, oldRevision, newRevision, reason]);
}

/** Bumps the tenant revision and invalidates its pending transfer together.
 * Every authority change must call this so a stale transfer cannot be accepted. */
export async function bumpAuthorizationRevision(q: PoolClient, tenantId: string): Promise<string> {
  const row = (await q.query<{ authorization_revision: string }>(
    `UPDATE tenants SET authorization_revision=authorization_revision+1, updated_at=clock_timestamp()
     WHERE tenant_id=$1 RETURNING authorization_revision::text`, [tenantId])).rows[0];
  requireCondition(row, 404, 'tenant_not_found', NOT_FOUND);
  await q.query(`UPDATE tenant_ownership_transfers
    SET state='invalidated', version=version+1, decided_at=clock_timestamp(), updated_at=clock_timestamp()
    WHERE tenant_id=$1 AND state='pending'`, [tenantId]);
  return versionOf(row.authorization_revision);
}

export async function invalidatePendingTransfersOfPrincipal(q: PoolClient, principalId: string): Promise<void> {
  await q.query(`UPDATE tenant_ownership_transfers
    SET state='invalidated', version=version+1, decided_at=clock_timestamp(), updated_at=clock_timestamp()
    WHERE state='pending' AND (from_principal_id=$1 OR to_principal_id=$1)`, [principalId]);
}

/** Admin and security transactions are not scoped member commands, so they
 * cannot call scopedJournal. Tenant journal rows only allow a person member
 * session; the admin identity stays on platform_admin_audit. */
export async function writeTenantControlEvent(q: PoolClient, input: {
  tenantId: string; principalId: string; operation: string; aggregateType: string; aggregateId: string;
  aggregateVersion: string; data: Record<string, unknown>; eventType: string;
}): Promise<void> {
  const scope = (await q.query<{ scope_id: string }>(
    `SELECT scope_id FROM resource_scopes WHERE kind='tenant' AND tenant_ref=$1 AND status='active'`, [input.tenantId])).rows[0];
  requireCondition(scope, 500, 'internal_error', '業務空間範圍無法讀取。');
  const transition = randomUUID();
  const version = versionOf(input.aggregateVersion);
  await q.query(`INSERT INTO scoped_transition_journal(transition_id,scope_id,scope_kind,principal_id,principal_kind,
    authn_kind,aggregate_type,aggregate_id,aggregate_version,operation,data)
    VALUES($1,$2,'tenant',$3,'person','member_session',$4,$5,$6,$7,$8)`,
  [transition, scope.scope_id, input.principalId, input.aggregateType, input.aggregateId, version, input.operation, JSON.stringify(input.data)]);
  const payload = {
    subject_principal: { principal_id: input.principalId, kind: 'person' },
    authn_kind: 'member_session',
    scope: { scope_id: scope.scope_id, kind: 'tenant' },
    aggregate_type: input.aggregateType, aggregate_id: input.aggregateId, aggregate_version: version, data: input.data,
  };
  await q.query(`INSERT INTO scoped_outbox(event_id,transition_id,scope_id,scope_kind,event_type,payload)
    VALUES($1,$2,$3,'tenant',$4,$5)`, [randomUUID(), transition, scope.scope_id, input.eventType, JSON.stringify(payload)]);
}

export async function persistTransferFailure(pool: Pool, transferId: string): Promise<void> {
  await pool.query(`UPDATE tenant_ownership_transfers
    SET state='expired', version=version+1, decided_at=clock_timestamp(), updated_at=clock_timestamp()
    WHERE transfer_id=$1 AND state='pending' AND expires_at<=clock_timestamp()`, [transferId]);
  await pool.query(`UPDATE tenant_ownership_transfers t
    SET state='invalidated', version=t.version+1, decided_at=clock_timestamp(), updated_at=clock_timestamp()
    FROM tenants tn
    WHERE t.transfer_id=$1 AND t.tenant_id=tn.tenant_id AND t.state='pending'
      AND (tn.authorization_revision<>t.tenant_authorization_revision OR tn.status<>'active'
        OR NOT EXISTS (
          SELECT 1 FROM tenant_memberships m
          JOIN principals p ON p.principal_id=m.principal_id AND p.status='active'
          JOIN users u ON u.user_id=p.user_ref AND u.active
          WHERE m.tenant_id=t.tenant_id AND m.principal_id=t.from_principal_id AND m.role='owner' AND m.status='active')
        OR NOT EXISTS (
          SELECT 1 FROM principals rp
          JOIN users ru ON ru.user_id=rp.user_ref AND ru.active
          WHERE rp.principal_id=t.to_principal_id AND rp.kind='person' AND rp.status='active'))`, [transferId]);
}

export function encodeCursor(principalId: string, kind: string, tenantId: string | null, after: string): string {
  return Buffer.from(JSON.stringify({ principal_id: principalId, kind, tenant_id: tenantId, after }), 'utf8').toString('base64url');
}
export function readCursor(raw: string | undefined, principalId: string, kind: string, tenantId: string | null): string | null {
  if (raw === undefined) return null;
  let parsed: { principal_id?: unknown; kind?: unknown; tenant_id?: unknown; after?: unknown };
  try { parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as typeof parsed; }
  catch { throw new Problem(422, 'validation_failed', '分頁游標無效。'); }
  requireCondition(parsed?.principal_id === principalId && parsed.kind === kind && parsed.tenant_id === tenantId
    && typeof parsed.after === 'string' && OpaqueId.safeParse(parsed.after).success,
  422, 'validation_failed', '分頁游標無效。');
  return parsed.after;
}
export function limitOf(raw: string | undefined): number {
  if (raw === undefined) return 20;
  requireCondition(/^[1-9][0-9]{0,2}$/.test(raw), 422, 'validation_failed', '分頁大小無效。');
  const value = Number(raw);
  requireCondition(value <= 100, 422, 'validation_failed', '分頁大小無效。');
  return value;
}
