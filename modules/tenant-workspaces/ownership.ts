import type { Pool, PoolClient } from 'pg';
import { OpaqueId } from '../../contracts/common/v1/identity.js';
import {
  EmptyObjectSchema, TransferAcceptInputSchema, TransferAcceptResultSchema, TransferCancelInputSchema,
  TransferPageSchema, TransferProposeInputSchema, TransferViewSchema, type TransferView,
} from '../../contracts/guild-launchpad/v1/tenant.js';
import type { Actor } from '../identity-membership/service.js';
import { checkVersion } from '../../packages/db/index.js';
import { transaction } from '../../packages/db/transaction.js';
import { lockMemberSession } from '../../packages/db/member-session.js';
import { mapPersonPrincipal } from '../../packages/resource-scopes/index.js';
import { scopedJournal, scopedMemberCommand, scopedTenantCommand } from '../../packages/scoped-commands/index.js';
import { Problem, requireCondition } from '../../packages/shared/problem.js';
import { roleCapabilities } from './authorization.js';
import {
  auditTenant, bumpAuthorizationRevision, countedSourceVersion, encodeCursor, iso, limitOf, NOT_FOUND, persistTransferFailure,
  readCursor, requireMutableStatus, TRANSFER_MISSING, versionOf,
} from './facts.js';
import { assertFreshVerificationCurrent, consumeFreshVerification, receiptNamespaceDigest, requireFreshVerification } from './high-risk-verification.js';
import { loadActivePolicy } from './policy.js';

const MEMBER_PROFILE = 'freedom.scoped-member-command/v1';
const TENANT_PROFILE = 'freedom.scoped-tenant-command/v1';
const DENIED = '你目前沒有這項業務空間權限。';

async function transferView(q: PoolClient, transferId: string): Promise<TransferView> {
  const row = (await q.query<{
    transfer_id: string; tenant_id: string; tenant_display_name: string; from_principal_id: string; to_principal_id: string;
    from_display_name: string; to_display_name: string; from_role_after: TransferView['from_role_after'];
    state: TransferView['state']; expires_at: Date; version: string;
  }>(`SELECT tr.transfer_id, tr.tenant_id, t.display_name AS tenant_display_name, tr.from_principal_id, tr.to_principal_id,
      fu.display_name AS from_display_name, tu.display_name AS to_display_name, tr.from_role_after, tr.state, tr.expires_at, tr.version::text AS version
    FROM tenant_ownership_transfers tr
    JOIN tenants t ON t.tenant_id=tr.tenant_id
    JOIN principals fp ON fp.principal_id=tr.from_principal_id
    JOIN users fu ON fu.user_id=fp.user_ref
    JOIN principals tp ON tp.principal_id=tr.to_principal_id
    JOIN users tu ON tu.user_id=tp.user_ref
    WHERE tr.transfer_id=$1`, [transferId])).rows[0];
  requireCondition(row, 404, 'transfer_not_found', TRANSFER_MISSING);
  return TransferViewSchema.parse({ ...row, expires_at: iso(row.expires_at), version: versionOf(row.version) });
}

async function callerPrincipal(q: PoolClient, actor: Actor): Promise<string> {
  await lockMemberSession(q, actor);
  const principal = await mapPersonPrincipal(q, actor.user_id);
  requireCondition(principal.status === 'active' && principal.kind === 'person', 403, 'principal_disabled', '這個身分目前無法使用。');
  return principal.principal_id;
}

/** Same rule as lockTenantScope: a disabled tenant scope is 403 scope_disabled.
 * Lock the scope before the tenant row. A fresh status read follows the lock
 * because a waiting UPDATE can commit a disable that this statement's first
 * snapshot did not see. */
async function requireActiveTenantScope(q: PoolClient, tenantId: string): Promise<void> {
  const locked = await q.query(`SELECT scope_id FROM resource_scopes WHERE tenant_ref=$1 FOR SHARE`, [tenantId]);
  if ((locked.rowCount ?? 0) !== 1) throw new Problem(404, 'transfer_not_found', TRANSFER_MISSING);
  const current = (await q.query<{ status: string }>(`SELECT status FROM resource_scopes WHERE tenant_ref=$1`, [tenantId])).rows[0];
  if (!current) throw new Problem(404, 'transfer_not_found', TRANSFER_MISSING);
  requireCondition(current.status === 'active', 403, 'scope_disabled', '這個資源範圍目前無法使用。');
}

function transferFailure(error: unknown): error is Problem {
  return error instanceof Problem && (error.code === 'transfer_expired' || error.code === 'transfer_authority_changed' || error.code === 'tenant_recovery_required');
}

async function withinTransferTtl(q: PoolClient, expiresAt: string, ttlSeconds: number): Promise<void> {
  const row = (await q.query<{ ok: boolean }>(
    `SELECT $1::timestamptz > clock_timestamp() AND $1::timestamptz <= clock_timestamp() + make_interval(secs => $2::int) AS ok`,
    [expiresAt, ttlSeconds])).rows[0];
  requireCondition(row?.ok, 422, 'validation_failed', '移交期限超出政策允許的範圍。');
}

export async function proposeTransfer(pool: Pool, actor: Actor, tenantId: string, body: unknown, key: string) {
  const input = TransferProposeInputSchema.parse(body);
  OpaqueId.parse(tenantId);
  await pool.query(`UPDATE tenant_ownership_transfers SET state='expired', version=version+1, decided_at=clock_timestamp(), updated_at=clock_timestamp()
    WHERE tenant_id=$1 AND state='pending' AND expires_at<=clock_timestamp()`, [tenantId]);
  return scopedTenantCommand(pool, {
    actor, tenantId, operation: 'tenant.ownership.propose', key, body: input,
    target: { kind: 'tenant_ownership_transfer', id: tenantId }, capabilitiesForRole: roleCapabilities,
  }, async (q, context) => {
    requireCondition(context.role === 'owner', 403, 'tenant_capability_denied', DENIED);
    requireMutableStatus(context.tenant_status);
    const digest = receiptNamespaceDigest(TENANT_PROFILE, [context.principal_id, context.authn_kind, context.scope.scope_id, 'tenant.ownership.propose', key]);
    await requireFreshVerification(q, {
      userId: actor.user_id, sessionHash: actor.session_hash, principalId: context.principal_id, tenantId,
      purpose: 'tenant.ownership.propose', verificationId: input.fresh_auth_verification_id, namespaceDigest: digest,
    });
    await loadActivePolicy(q);
    await assertFreshVerificationCurrent(q, input.fresh_auth_verification_id);
  }, async (q, context) => {
    await assertFreshVerificationCurrent(q, input.fresh_auth_verification_id);
    const policy = await loadActivePolicy(q);
    await assertFreshVerificationCurrent(q, input.fresh_auth_verification_id);
    await withinTransferTtl(q, input.expires_at, policy.transfer_ttl_seconds);
    requireCondition(input.to_principal_id !== context.principal_id, 422, 'validation_failed', '不能將擁有權移交給自己。');
    const recipient = (await q.query<{ principal_id: string }>(`SELECT p.principal_id FROM principals p
      JOIN users u ON u.user_id=p.user_ref
      WHERE p.principal_id=$1 AND p.kind='person' AND p.status='active' AND u.active AND u.community_id=$2`,
    [input.to_principal_id, actor.community_id])).rows[0];
    requireCondition(recipient, 404, 'member_not_found', '找不到這位成員。');
    const digest = receiptNamespaceDigest(TENANT_PROFILE, [context.principal_id, context.authn_kind, context.scope.scope_id, 'tenant.ownership.propose', key]);
    let transferId: string;
    try {
      transferId = (await q.query<{ transfer_id: string }>(`INSERT INTO tenant_ownership_transfers(
        tenant_id, from_principal_id, to_principal_id, from_role_after, state, expires_at, tenant_authorization_revision, reason)
        VALUES($1,$2,$3,$4,'pending',$5,$6,$7) RETURNING transfer_id`,
      [tenantId, context.principal_id, input.to_principal_id, input.from_role_after, input.expires_at, context.authorization_revision, input.reason])).rows[0].transfer_id;
    } catch (error) {
      const pg = error as { code?: string; constraint?: string };
      if (pg.code === '23505' && pg.constraint === 'tenant_ownership_transfers_one_pending') {
        throw new Problem(409, 'transfer_pending', '這個業務空間已有待接受的移交。');
      }
      throw error;
    }
    await consumeFreshVerification(q, input.fresh_auth_verification_id, digest);
    await auditTenant(q, tenantId, context.principal_id, 'tenant.ownership.propose', input.to_principal_id, context.authorization_revision, context.authorization_revision, 'tenant.ownership.proposed');
    return transferView(q, transferId);
  });
}

async function visibleTransfer(q: PoolClient, actor: Actor, tenantId: string, transferId: string): Promise<string> {
  const principalId = await callerPrincipal(q, actor);
  const row = (await q.query<{ from_principal_id: string; to_principal_id: string; community_id: string }>(
    `SELECT tr.from_principal_id, tr.to_principal_id, t.community_id
     FROM tenant_ownership_transfers tr JOIN tenants t ON t.tenant_id=tr.tenant_id
     WHERE tr.transfer_id=$1 AND tr.tenant_id=$2`, [transferId, tenantId])).rows[0];
  if (!row || row.community_id !== actor.community_id) throw new Problem(404, 'transfer_not_found', TRANSFER_MISSING);
  if (row.to_principal_id === principalId) return principalId;
  const owner = await q.query(`SELECT 1 FROM tenant_memberships
    WHERE tenant_id=$1 AND principal_id=$2 AND role='owner' AND status='active' AND principal_id=$3`,
  [tenantId, principalId, row.from_principal_id]);
  if (owner.rowCount !== 1) throw new Problem(404, 'transfer_not_found', TRANSFER_MISSING);
  return principalId;
}

export async function getTransfer(pool: Pool, actor: Actor, tenantId: string, transferId: string) {
  OpaqueId.parse(tenantId); OpaqueId.parse(transferId);
  return transaction(pool, async q => {
    await visibleTransfer(q, actor, tenantId, transferId);
    await q.query(`UPDATE tenant_ownership_transfers SET state='expired', version=version+1, decided_at=clock_timestamp(), updated_at=clock_timestamp()
      WHERE transfer_id=$1 AND state='pending' AND expires_at<=clock_timestamp()`, [transferId]);
    return transferView(q, transferId);
  });
}

export async function listMyTransfers(pool: Pool, actor: Actor, query: { cursor?: string; limit?: string }) {
  const limit = limitOf(query.limit);
  return transaction(pool, async q => {
    const principalId = await callerPrincipal(q, actor);
    const after = readCursor(query.cursor, principalId, 'my_transfers', null);
    await q.query(`UPDATE tenant_ownership_transfers SET state='expired', version=version+1, decided_at=clock_timestamp(), updated_at=clock_timestamp()
      WHERE to_principal_id=$1 AND state='pending' AND expires_at<=clock_timestamp()`, [principalId]);
    const rows = (await q.query<{ transfer_id: string }>(`SELECT transfer_id FROM tenant_ownership_transfers
      WHERE to_principal_id=$1 AND state='pending' AND ($2::uuid IS NULL OR transfer_id > $2::uuid)
      ORDER BY transfer_id LIMIT $3`, [principalId, after, limit + 1])).rows;
    const page = rows.slice(0, limit);
    const items = [];
    for (const row of page) items.push(await transferView(q, row.transfer_id));
    const sourceVersion = await countedSourceVersion(q, 'tenant_ownership_transfers', 'to_principal_id=$1', [principalId]);
    return TransferPageSchema.parse({
      items, next_cursor: rows.length > limit ? encodeCursor(principalId, 'my_transfers', null, page[page.length - 1].transfer_id) : null,
      source_version: sourceVersion,
    });
  });
}

export async function listTenantTransfers(pool: Pool, actor: Actor, tenantId: string, query: { cursor?: string; limit?: string }) {
  OpaqueId.parse(tenantId);
  const limit = limitOf(query.limit);
  return transaction(pool, async q => {
    const principalId = await callerPrincipal(q, actor);
    const tenant = (await q.query<{ community_id: string }>(`SELECT community_id FROM tenants WHERE tenant_id=$1`, [tenantId])).rows[0];
    if (!tenant || tenant.community_id !== actor.community_id) throw new Problem(404, 'transfer_not_found', TRANSFER_MISSING);
    const owner = await q.query(`SELECT 1 FROM tenant_memberships
      WHERE tenant_id=$1 AND principal_id=$2 AND role='owner' AND status='active'`, [tenantId, principalId]);
    if (owner.rowCount !== 1) throw new Problem(404, 'transfer_not_found', TRANSFER_MISSING);
    const after = readCursor(query.cursor, principalId, 'tenant_transfers', tenantId);
    await q.query(`UPDATE tenant_ownership_transfers SET state='expired', version=version+1, decided_at=clock_timestamp(), updated_at=clock_timestamp()
      WHERE tenant_id=$1 AND state='pending' AND expires_at<=clock_timestamp()`, [tenantId]);
    const rows = (await q.query<{ transfer_id: string }>(`SELECT transfer_id FROM tenant_ownership_transfers
      WHERE tenant_id=$1 AND state='pending' AND ($2::uuid IS NULL OR transfer_id > $2::uuid)
      ORDER BY transfer_id LIMIT $3`, [tenantId, after, limit + 1])).rows;
    const page = rows.slice(0, limit);
    const items = [];
    for (const row of page) items.push(await transferView(q, row.transfer_id));
    const sourceVersion = await countedSourceVersion(q, 'tenant_ownership_transfers', 'tenant_id=$1', [tenantId]);
    return TransferPageSchema.parse({
      items,
      next_cursor: rows.length > limit ? encodeCursor(principalId, 'tenant_transfers', tenantId, page[page.length - 1].transfer_id) : null,
      source_version: sourceVersion,
    });
  });
}

export async function acceptTransfer(pool: Pool, actor: Actor, tenantId: string, transferId: string, body: unknown, key: string, expected: string) {
  const input = TransferAcceptInputSchema.parse(body);
  OpaqueId.parse(tenantId); OpaqueId.parse(transferId);
  await pool.query(`UPDATE tenant_ownership_transfers SET state='expired', version=version+1, decided_at=clock_timestamp(), updated_at=clock_timestamp()
    WHERE transfer_id=$1 AND tenant_id=$2 AND state='pending' AND expires_at<=clock_timestamp()`, [transferId, tenantId]);
  try {
    return await scopedMemberCommand(pool, {
      actor, scope: 'personal', operation: 'tenant.ownership.accept', key, body: input, expected,
      target: { kind: 'tenant_ownership_transfer', id: transferId },
    }, async (q, context) => {
      const visible = (await q.query<{ to_principal_id: string }>(
        `SELECT to_principal_id FROM tenant_ownership_transfers WHERE transfer_id=$1 AND tenant_id=$2`, [transferId, tenantId])).rows[0];
      if (!visible || visible.to_principal_id !== context.subject_principal.principal_id) throw new Problem(404, 'transfer_not_found', TRANSFER_MISSING);
      const digest = receiptNamespaceDigest(MEMBER_PROFILE, [context.subject_principal.principal_id, context.authn_kind, context.scope.scope_id, 'tenant.ownership.accept', key]);
      await requireFreshVerification(q, {
        userId: actor.user_id, sessionHash: actor.session_hash, principalId: context.subject_principal.principal_id,
        tenantId, purpose: 'tenant.ownership.accept', verificationId: input.fresh_auth_verification_id, namespaceDigest: digest,
      });
      await loadActivePolicy(q);
      await assertFreshVerificationCurrent(q, input.fresh_auth_verification_id);
    }, async (q, context) => {
      await requireActiveTenantScope(q, tenantId);
      const tenant = (await q.query<{ status: string; authorization_revision: string; community_id: string }>(
        `SELECT status, authorization_revision::text AS authorization_revision, community_id FROM tenants WHERE tenant_id=$1 FOR UPDATE`, [tenantId])).rows[0];
      if (!tenant || tenant.community_id !== actor.community_id) throw new Problem(404, 'transfer_not_found', TRANSFER_MISSING);
      const peeked = (await q.query<{ from_principal_id: string; to_principal_id: string }>(
        `SELECT from_principal_id, to_principal_id FROM tenant_ownership_transfers WHERE transfer_id=$1 AND tenant_id=$2`, [transferId, tenantId])).rows[0];
      if (!peeked || peeked.to_principal_id !== context.subject_principal.principal_id) throw new Problem(404, 'transfer_not_found', TRANSFER_MISSING);
      const ids = [peeked.from_principal_id, peeked.to_principal_id].sort();
      await q.query(`SELECT principal_id FROM tenant_memberships WHERE tenant_id=$1 AND principal_id = ANY($2::uuid[]) ORDER BY principal_id FOR UPDATE`, [tenantId, ids]);
      const transfer = (await q.query<{
        from_principal_id: string; to_principal_id: string; from_role_after: TransferView['from_role_after'];
        state: string; version: string; tenant_authorization_revision: string; expired: boolean;
      }>(`SELECT from_principal_id, to_principal_id, from_role_after, state, version::text AS version,
          tenant_authorization_revision::text AS tenant_authorization_revision, expires_at<=clock_timestamp() AS expired
        FROM tenant_ownership_transfers WHERE transfer_id=$1 AND tenant_id=$2 FOR UPDATE`, [transferId, tenantId])).rows[0];
      if (!transfer || transfer.to_principal_id !== context.subject_principal.principal_id) throw new Problem(404, 'transfer_not_found', TRANSFER_MISSING);
      // A past row is pre-expired and its version has already moved. Say so
      // before If-Match, which would otherwise report a stale version.
      if (transfer.expired || transfer.state === 'expired') throw new Problem(409, 'transfer_expired', '移交已過期。');
      if (transfer.state === 'invalidated') throw new Problem(409, 'transfer_authority_changed', '業務空間的權限已變更，這份移交已失效。');
      requireCondition(transfer.state === 'pending', 409, 'transfer_closed', '這份移交已結束。');
      checkVersion(versionOf(transfer.version), expected);
      if (tenant.status === 'recovery_required') throw new Problem(409, 'tenant_recovery_required', '這個業務空間需要復原後才能變更。');
      requireMutableStatus(tenant.status);
      const proposer = (await q.query<{ ok: boolean }>(`SELECT (m.role='owner' AND m.status='active' AND p.status='active' AND u.active) AS ok
        FROM tenant_memberships m
        JOIN principals p ON p.principal_id=m.principal_id
        JOIN users u ON u.user_id=p.user_ref
        WHERE m.tenant_id=$1 AND m.principal_id=$2`, [tenantId, transfer.from_principal_id])).rows[0];
      if (!proposer?.ok || tenant.authorization_revision !== transfer.tenant_authorization_revision) {
        throw new Problem(409, 'transfer_authority_changed', '業務空間的權限已變更，這份移交已失效。');
      }
      const recipient = (await q.query<{ version: string }>(`SELECT version::text AS version FROM tenant_memberships WHERE tenant_id=$1 AND principal_id=$2`, [tenantId, transfer.to_principal_id])).rows[0];
      const recipientUser = (await q.query<{ ok: boolean }>(`SELECT (p.status='active' AND u.active) AS ok
        FROM principals p JOIN users u ON u.user_id=p.user_ref WHERE p.principal_id=$1 AND p.kind='person'`, [transfer.to_principal_id])).rows[0];
      requireCondition(recipientUser?.ok, 409, 'transfer_authority_changed', '業務空間的權限已變更，這份移交已失效。');
      await requireActiveTenantScope(q, tenantId);
      await assertFreshVerificationCurrent(q, input.fresh_auth_verification_id);
      if (recipient) {
        await q.query(`UPDATE tenant_memberships SET role='owner', status='active', revoked_at=NULL, accepted_at=clock_timestamp(), version=version+1, updated_at=clock_timestamp()
          WHERE tenant_id=$1 AND principal_id=$2`, [tenantId, transfer.to_principal_id]);
      } else {
        await q.query(`INSERT INTO tenant_memberships(tenant_id,principal_id,role,status,accepted_at) VALUES($1,$2,'owner','active',clock_timestamp())`, [tenantId, transfer.to_principal_id]);
      }
      if (transfer.from_role_after === 'revoked') {
        await q.query(`UPDATE tenant_memberships SET status='revoked', revoked_at=clock_timestamp(), version=version+1, updated_at=clock_timestamp()
          WHERE tenant_id=$1 AND principal_id=$2`, [tenantId, transfer.from_principal_id]);
      } else {
        await q.query(`UPDATE tenant_memberships SET role=$3, status='active', revoked_at=NULL, accepted_at=COALESCE(accepted_at,clock_timestamp()), version=version+1, updated_at=clock_timestamp()
          WHERE tenant_id=$1 AND principal_id=$2`, [tenantId, transfer.from_principal_id, transfer.from_role_after]);
      }
      await q.query(`UPDATE tenant_ownership_transfers SET state='accepted', version=version+1, decided_at=clock_timestamp(), accepted_at=clock_timestamp(), updated_at=clock_timestamp()
        WHERE transfer_id=$1 AND state='pending'`, [transferId]);
      const revision = await bumpAuthorizationRevision(q, tenantId);
      await auditTenant(q, tenantId, context.subject_principal.principal_id, 'tenant.ownership.accept', transfer.from_principal_id, tenant.authorization_revision, revision, 'tenant.ownership.accepted');
      const digest = receiptNamespaceDigest(MEMBER_PROFILE, [context.subject_principal.principal_id, context.authn_kind, context.scope.scope_id, 'tenant.ownership.accept', key]);
      await consumeFreshVerification(q, input.fresh_auth_verification_id, digest);
      const memberships = (await q.query<{ principal_id: string; role: string; status: string; version: string }>(
        `SELECT principal_id, role, status, version::text AS version FROM tenant_memberships WHERE tenant_id=$1 AND principal_id = ANY($2::uuid[])`,
        [tenantId, ids])).rows;
      await scopedJournal(q, context, {
        aggregate_type: 'tenant_ownership', id: transferId, version: revision, operation: 'tenant.ownership.accept',
        data: { tenant_id: tenantId, transfer_id: transferId, from_principal_id: transfer.from_principal_id, to_principal_id: transfer.to_principal_id, authorization_revision: revision },
        eventType: 'freedom.tenant.ownership.transferred.v1',
      });
      // Personal-scope journal identity is (scope, type, id, version). Both
      // membership facts share this transfer id and use different types so a
      // later transfer to the same person cannot collide.
      for (const membership of memberships) {
        await scopedJournal(q, context, {
          aggregate_type: membership.principal_id === transfer.to_principal_id ? 'tenant_membership' : 'tenant_membership_prior',
          id: transferId, version: revision, operation: 'tenant.ownership.accept',
          data: { tenant_id: tenantId, principal_id: membership.principal_id, role: membership.role, status: membership.status, authorization_revision: revision },
          eventType: 'freedom.tenant.membership.changed.v1',
        });
      }
      return TransferAcceptResultSchema.parse({
        transfer: await transferView(q, transferId), tenant_id: tenantId, authorization_revision: revision, my_role: 'owner',
      });
    }, async (q, context) => {
      await requireActiveTenantScope(q, tenantId);
      await assertFreshVerificationCurrent(q, input.fresh_auth_verification_id);
      const prior = (await q.query<{ response: { tenant_id?: unknown } }>(`SELECT response FROM scoped_command_receipts
        WHERE principal_id=$1 AND authn_kind=$2 AND scope_id=$3 AND operation='tenant.ownership.accept' AND idempotency_key=$4`,
      [context.subject_principal.principal_id, context.authn_kind, context.scope.scope_id, key])).rows[0];
      if (!prior) return;
      const recorded = prior.response?.tenant_id;
      requireCondition(typeof recorded === 'string', 403, 'tenant_capability_denied', DENIED);
      const still = (await q.query<{ ok: boolean }>(`SELECT (m.status='active' AND m.role='owner' AND t.status='active' AND u.active AND p.status='active') AS ok
        FROM tenant_memberships m
        JOIN tenants t ON t.tenant_id=m.tenant_id
        JOIN principals p ON p.principal_id=m.principal_id
        JOIN users u ON u.user_id=p.user_ref
        WHERE m.tenant_id=$1 AND m.principal_id=$2`, [recorded, context.subject_principal.principal_id])).rows[0];
      requireCondition(still?.ok, 403, 'tenant_capability_denied', '目前無法使用這個業務空間。');
    });
  } catch (error) {
    if (transferFailure(error)) await persistTransferFailure(pool, transferId);
    throw error;
  }
}

export async function cancelTransfer(pool: Pool, actor: Actor, tenantId: string, transferId: string, body: unknown, key: string) {
  const input = TransferCancelInputSchema.parse(body);
  OpaqueId.parse(tenantId); OpaqueId.parse(transferId);
  await pool.query(`UPDATE tenant_ownership_transfers SET state='expired', version=version+1, decided_at=clock_timestamp(), updated_at=clock_timestamp()
    WHERE transfer_id=$1 AND tenant_id=$2 AND state='pending' AND expires_at<=clock_timestamp()`, [transferId, tenantId]);
  return scopedTenantCommand(pool, {
    actor, tenantId, operation: 'tenant.ownership.cancel', key, body: input,
    target: { kind: 'tenant_ownership_transfer', id: transferId }, capabilitiesForRole: roleCapabilities,
  }, async (_q, context) => {
    requireCondition(context.role === 'owner', 404, 'transfer_not_found', TRANSFER_MISSING);
    requireMutableStatus(context.tenant_status);
  }, async (q, context) => {
    const transfer = (await q.query<{ from_principal_id: string; state: string; expired: boolean }>(
      `SELECT from_principal_id, state, expires_at<=clock_timestamp() AS expired FROM tenant_ownership_transfers
       WHERE transfer_id=$1 AND tenant_id=$2 FOR UPDATE`, [transferId, tenantId])).rows[0];
    if (!transfer || transfer.from_principal_id !== context.principal_id) throw new Problem(404, 'transfer_not_found', TRANSFER_MISSING);
    if (transfer.expired || transfer.state === 'expired') throw new Problem(409, 'transfer_expired', '移交已過期。');
    requireCondition(transfer.state === 'pending', 409, 'transfer_closed', '這份移交已結束。');
    await q.query(`UPDATE tenant_ownership_transfers SET state='cancelled', version=version+1, decided_at=clock_timestamp(), updated_at=clock_timestamp()
      WHERE transfer_id=$1`, [transferId]);
    await auditTenant(q, tenantId, context.principal_id, 'tenant.ownership.cancel', transfer.from_principal_id, context.authorization_revision, context.authorization_revision, 'tenant.ownership.cancelled');
    return transferView(q, transferId);
  });
}

export async function declineTransfer(pool: Pool, actor: Actor, tenantId: string, transferId: string, body: unknown, key: string) {
  EmptyObjectSchema.parse(body);
  OpaqueId.parse(tenantId); OpaqueId.parse(transferId);
  await pool.query(`UPDATE tenant_ownership_transfers SET state='expired', version=version+1, decided_at=clock_timestamp(), updated_at=clock_timestamp()
    WHERE transfer_id=$1 AND tenant_id=$2 AND state='pending' AND expires_at<=clock_timestamp()`, [transferId, tenantId]);
  try {
    return await scopedMemberCommand(pool, {
      actor, scope: 'personal', operation: 'tenant.ownership.decline', key, body: {},
      target: { kind: 'tenant_ownership_transfer', id: transferId },
    }, async () => {}, async (q, context) => {
      const tenant = (await q.query<{ status: string; authorization_revision: string; community_id: string }>(
        `SELECT status, authorization_revision::text AS authorization_revision, community_id FROM tenants WHERE tenant_id=$1 FOR SHARE`, [tenantId])).rows[0];
      if (!tenant || tenant.community_id !== actor.community_id) throw new Problem(404, 'transfer_not_found', TRANSFER_MISSING);
      const transfer = (await q.query<{ to_principal_id: string; state: string; expired: boolean }>(
        `SELECT to_principal_id, state, expires_at<=clock_timestamp() AS expired FROM tenant_ownership_transfers
         WHERE transfer_id=$1 AND tenant_id=$2 FOR UPDATE`, [transferId, tenantId])).rows[0];
      if (!transfer || transfer.to_principal_id !== context.subject_principal.principal_id) throw new Problem(404, 'transfer_not_found', TRANSFER_MISSING);
      requireMutableStatus(tenant.status);
      if (transfer.expired || transfer.state === 'expired') throw new Problem(409, 'transfer_expired', '移交已過期。');
      requireCondition(transfer.state === 'pending', 409, 'transfer_closed', '這份移交已結束。');
      await q.query(`UPDATE tenant_ownership_transfers SET state='declined', version=version+1, decided_at=clock_timestamp(), updated_at=clock_timestamp()
        WHERE transfer_id=$1`, [transferId]);
      await auditTenant(q, tenantId, context.subject_principal.principal_id, 'tenant.ownership.decline', context.subject_principal.principal_id, tenant.authorization_revision, tenant.authorization_revision, 'tenant.ownership.declined');
      return transferView(q, transferId);
    }, async (q, context) => {
      const prior = (await q.query(`SELECT 1 FROM scoped_command_receipts
        WHERE principal_id=$1 AND authn_kind=$2 AND scope_id=$3 AND operation='tenant.ownership.decline' AND idempotency_key=$4`,
      [context.subject_principal.principal_id, context.authn_kind, context.scope.scope_id, key])).rows[0];
      if (!prior) return;
      const account = (await q.query<{ ok: boolean }>(`SELECT (p.status='active' AND u.active) AS ok
        FROM principals p JOIN users u ON u.user_id=p.user_ref WHERE p.principal_id=$1`, [context.subject_principal.principal_id])).rows[0];
      requireCondition(account?.ok, 403, 'tenant_capability_denied', '目前無法使用這個業務空間。');
    });
  } catch (error) {
    if (transferFailure(error)) await persistTransferFailure(pool, transferId);
    throw error;
  }
}
