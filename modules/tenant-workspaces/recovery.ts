import type { Pool, PoolClient } from 'pg';
import { OpaqueId } from '../../contracts/common/v1/identity.js';
import {
  AdminRecoveryCaseViewSchema, EmptyObjectSchema, RecoveryAcceptInputSchema, RecoveryApproveInputSchema,
  RecoveryCasePageSchema, RecoveryCaseViewSchema, RecoveryCloseInputSchema, RecoveryExecuteResultSchema,
  RecoveryOpenInputSchema, type AdminRecoveryCaseView, type RecoveryCaseView,
} from '../../contracts/guild-launchpad/v1/tenant.js';
import type { Actor } from '../identity-membership/service.js';
import { adminCommand, audit, type AdminActor, type AdminCommand } from '../platform-admin/service.js';
import { checkVersion } from '../../packages/db/index.js';
import { transaction } from '../../packages/db/transaction.js';
import { lockMemberSession } from '../../packages/db/member-session.js';
import { mapPersonPrincipal } from '../../packages/resource-scopes/index.js';
import { scopedMemberCommand } from '../../packages/scoped-commands/index.js';
import { Problem, requireCondition } from '../../packages/shared/problem.js';
import {
  auditTenant, bumpAuthorizationRevision, encodeCursor, iso, limitOf, readCursor, RECOVERY_MISSING, versionOf, writeTenantControlEvent,
} from './facts.js';
import { consumeFreshVerification, receiptNamespaceDigest, requireFreshVerification } from './high-risk-verification.js';
import { loadActivePolicy } from './policy.js';

const MEMBER_PROFILE = 'freedom.scoped-member-command/v1';
type Capability = 'tenant.recovery.open' | 'tenant.recovery.review' | 'tenant.recovery.execute' | 'tenant.recovery.read';

interface CaseRow {
  case_id: string; tenant_id: string; tenant_display_name: string; community_id: string;
  proposed_owner_principal_id: string; state: RecoveryCaseView['state']; approved_scope: RecoveryCaseView['approved_scope'];
  expires_at: Date | null; recipient_accepted_at: Date | null; version: string; evidence_ref: string;
  opened_by_admin_id: string; approved_by_admin_id: string | null; executed_by_admin_id: string | null;
  target_email: string; owner_user_id: string; owner_active: boolean; principal_status: string;
}

async function requireCapability(q: PoolClient, adminId: string, capability: Capability): Promise<void> {
  const row = await q.query(`SELECT 1 FROM platform_admin_tenant_recovery_capabilities
    WHERE admin_id=$1 AND capability=$2 AND revoked_at IS NULL`, [adminId, capability]);
  requireCondition(row.rowCount === 1, 403, 'recovery_authority_required', '需要獨立的復原權限。');
}

function assertIndependent(admin: AdminActor, targetEmail: string, blockedAdminIds: Array<string | null>): void {
  requireCondition(admin.email !== targetEmail && blockedAdminIds.every(id => id !== admin.admin_id),
    403, 'recovery_authority_required', '復原的開啟、核准與執行必須由不同的人負責。');
}

async function loadCase(q: PoolClient, caseId: string, lock = false): Promise<CaseRow> {
  const row = (await q.query<CaseRow>(`SELECT c.case_id, c.tenant_id, t.display_name AS tenant_display_name, t.community_id,
      c.proposed_owner_principal_id, c.state, c.approved_scope, c.expires_at, c.recipient_accepted_at, c.version::text AS version,
      c.evidence_ref, c.opened_by_admin_id, c.approved_by_admin_id, c.executed_by_admin_id,
      lower(u.email) AS target_email, u.user_id AS owner_user_id, u.active AS owner_active, p.status AS principal_status
    FROM tenant_recovery_cases c
    JOIN tenants t ON t.tenant_id=c.tenant_id
    JOIN principals p ON p.principal_id=c.proposed_owner_principal_id
    JOIN users u ON u.user_id=p.user_ref
    WHERE c.case_id=$1 ${lock ? 'FOR UPDATE OF c' : ''}`, [caseId])).rows[0];
  if (!row) throw new Problem(404, 'recovery_case_not_found', RECOVERY_MISSING);
  return row;
}

function memberView(row: CaseRow): RecoveryCaseView {
  return RecoveryCaseViewSchema.parse({
    case_id: row.case_id, tenant_id: row.tenant_id, tenant_display_name: row.tenant_display_name,
    proposed_owner_principal_id: row.proposed_owner_principal_id, state: row.state, approved_scope: row.approved_scope,
    expires_at: row.expires_at ? iso(row.expires_at) : null, recipient_accepted: row.recipient_accepted_at !== null,
    version: versionOf(row.version),
  });
}
function adminView(row: CaseRow): AdminRecoveryCaseView {
  return AdminRecoveryCaseViewSchema.parse({ ...memberView(row), evidence_ref: row.evidence_ref });
}
function terminal(state: string): boolean {
  return state === 'executed' || state === 'denied' || state === 'cancelled';
}

async function withinApprovalTtl(q: PoolClient, expiresAt: string, ttlSeconds: number): Promise<void> {
  const row = (await q.query<{ ok: boolean }>(
    `SELECT $1::timestamptz > clock_timestamp() AND $1::timestamptz <= clock_timestamp() + make_interval(secs => $2::int) AS ok`,
    [expiresAt, ttlSeconds])).rows[0];
  requireCondition(row?.ok, 422, 'validation_failed', '核准期限超出政策允許的範圍。');
}

export async function openRecoveryCase(pool: Pool, input: AdminCommand) {
  const body = RecoveryOpenInputSchema.parse(input.body);
  OpaqueId.parse(body.tenant_id); OpaqueId.parse(body.proposed_owner_principal_id); OpaqueId.parse(body.evidence_ref);
  return adminCommand(pool, input, async q => {
    await requireCapability(q, input.admin.admin_id, 'tenant.recovery.open');
    await loadActivePolicy(q);
  }, async q => {
    const policy = await loadActivePolicy(q);
    const person = (await q.query<{ user_id: string; email: string; active: boolean; status: string; community_id: string }>(
      `SELECT u.user_id, lower(u.email) AS email, u.active, p.status, u.community_id
       FROM principals p JOIN users u ON u.user_id=p.user_ref
       WHERE p.principal_id=$1 AND p.kind='person'`, [body.proposed_owner_principal_id])).rows[0];
    requireCondition(person?.status === 'active' && person.active && person.community_id === input.admin.community_id, 404, 'member_not_found', '找不到這位成員。');
    assertIndependent(input.admin, person.email, []);
    await q.query(`SELECT user_id FROM users WHERE user_id=$1 FOR SHARE`, [person.user_id]);
    const tenant = (await q.query<{ status: string; community_id: string; authorization_revision: string }>(
      `SELECT status, community_id, authorization_revision::text AS authorization_revision FROM tenants WHERE tenant_id=$1 FOR UPDATE`,
      [body.tenant_id])).rows[0];
    if (!tenant || tenant.community_id !== input.admin.community_id) throw new Problem(404, 'tenant_not_found', '找不到這個業務空間。');
    requireCondition(tenant.status === 'recovery_required', 409, 'recovery_not_required', '這個業務空間目前不需要復原。');
    const open = (await q.query<{ n: number }>(`SELECT count(*)::int AS n FROM tenant_recovery_cases
      WHERE tenant_id=$1 AND state IN ('opened','evidence_required','approved')`, [body.tenant_id])).rows[0].n;
    requireCondition(open < policy.max_open_recovery_cases_per_tenant, 409, 'recovery_case_pending', '這個業務空間已有進行中的復原。');
    const inserted = (await q.query<{ case_id: string }>(`INSERT INTO tenant_recovery_cases(
      tenant_id, state, proposed_owner_principal_id, reason, evidence_ref, opened_by_admin_id)
      VALUES($1,'evidence_required',$2,$3,$4,$5) RETURNING case_id`,
    [body.tenant_id, body.proposed_owner_principal_id, body.reason, body.evidence_ref, input.admin.admin_id])).rows[0];
    const view = adminView(await loadCase(q, inserted.case_id));
    await auditTenant(q, body.tenant_id, body.proposed_owner_principal_id, 'tenant.recovery.open', body.proposed_owner_principal_id, tenant.authorization_revision, tenant.authorization_revision, 'tenant.recovery.opened');
    await audit(q, input.admin, 'tenant.recovery.open', 'tenant_recovery_case', inserted.case_id, body.reason, null, { state: view.state, tenant_id: body.tenant_id });
    return view;
  });
}

export async function approveRecoveryCase(pool: Pool, input: AdminCommand, caseId: string) {
  const body = RecoveryApproveInputSchema.parse(input.body);
  OpaqueId.parse(caseId);
  return adminCommand(pool, input, async q => {
    await requireCapability(q, input.admin.admin_id, 'tenant.recovery.review');
    await loadActivePolicy(q);
  }, async q => {
    const policy = await loadActivePolicy(q);
    const current = await loadCase(q, caseId, true);
    requireCondition(current.community_id === input.admin.community_id, 404, 'recovery_case_not_found', RECOVERY_MISSING);
    if (terminal(current.state) || current.state !== 'evidence_required') throw new Problem(409, 'recovery_case_terminal', '這份復原目前不能這樣變更。');
    checkVersion(versionOf(current.version), input.expected);
    assertIndependent(input.admin, current.target_email, [current.opened_by_admin_id]);
    await withinApprovalTtl(q, body.expires_at, policy.recovery_approval_ttl_seconds);
    requireCondition(body.approved_scope.length === 1 && body.approved_scope[0] === 'tenant.owner.restore', 403, 'recovery_authority_required', '核准範圍只能恢復擁有者。');
    await q.query(`UPDATE tenant_recovery_cases
      SET state='approved', approved_by_admin_id=$2, approved_scope=$3::jsonb, expires_at=$4, version=version+1, updated_at=clock_timestamp()
      WHERE case_id=$1 AND state='evidence_required'`, [caseId, input.admin.admin_id, JSON.stringify(body.approved_scope), body.expires_at]);
    const view = adminView(await loadCase(q, caseId));
    const revision = (await q.query<{ authorization_revision: string }>(`SELECT authorization_revision::text AS authorization_revision FROM tenants WHERE tenant_id=$1`, [current.tenant_id])).rows[0].authorization_revision;
    await auditTenant(q, current.tenant_id, current.proposed_owner_principal_id, 'tenant.recovery.approve', current.proposed_owner_principal_id, revision, revision, 'tenant.recovery.approved');
    await audit(q, input.admin, 'tenant.recovery.approve', 'tenant_recovery_case', caseId, body.reason, { state: 'evidence_required' }, { state: 'approved' });
    return view;
  });
}

export async function executeRecoveryCase(pool: Pool, input: AdminCommand, caseId: string) {
  EmptyObjectSchema.parse(input.body);
  OpaqueId.parse(caseId);
  return adminCommand(pool, input, async q => {
    await requireCapability(q, input.admin.admin_id, 'tenant.recovery.execute');
    await loadActivePolicy(q);
  }, async q => {
    await loadActivePolicy(q);
    const preview = await loadCase(q, caseId);
    requireCondition(preview.community_id === input.admin.community_id, 404, 'recovery_case_not_found', RECOVERY_MISSING);
    assertIndependent(input.admin, preview.target_email, [preview.opened_by_admin_id, preview.approved_by_admin_id]);
    await q.query(`SELECT user_id FROM users WHERE user_id=$1 FOR SHARE`, [preview.owner_user_id]);
    const tenant = (await q.query<{ status: string; authorization_revision: string }>(
      `SELECT status, authorization_revision::text AS authorization_revision FROM tenants WHERE tenant_id=$1 FOR UPDATE`, [preview.tenant_id])).rows[0];
    requireCondition(tenant, 404, 'recovery_case_not_found', RECOVERY_MISSING);
    await q.query(`SELECT principal_id FROM tenant_memberships WHERE tenant_id=$1 AND principal_id=$2 FOR UPDATE`, [preview.tenant_id, preview.proposed_owner_principal_id]);
    const current = await loadCase(q, caseId, true);
    if (terminal(current.state)) throw new Problem(409, 'recovery_case_terminal', '這份復原已結束，不能再變更。');
    requireCondition(current.state === 'approved', 409, 'recovery_case_terminal', '這份復原目前不能這樣變更。');
    checkVersion(versionOf(current.version), input.expected);
    const expired = (await q.query<{ expired: boolean }>(`SELECT expires_at<=clock_timestamp() AS expired FROM tenant_recovery_cases WHERE case_id=$1`, [caseId])).rows[0];
    if (expired?.expired) throw new Problem(409, 'recovery_approval_expired', '復原核准已過期。');
    if (!current.recipient_accepted_at) throw new Problem(409, 'recovery_acceptance_required', '受讓人尚未接受復原。');
    const loginable = await q.query(`SELECT 1 FROM tenant_memberships m
      JOIN principals p ON p.principal_id=m.principal_id AND p.status='active'
      JOIN users u ON u.user_id=p.user_ref AND u.active
      WHERE m.tenant_id=$1 AND m.role='owner' AND m.status='active'`, [current.tenant_id]);
    if (tenant.status !== 'recovery_required' || (loginable.rowCount ?? 0) > 0 || !current.owner_active || current.principal_status !== 'active') {
      throw new Problem(409, 'recovery_not_required', '目前不能完成這份復原。');
    }
    const existing = (await q.query<{ version: string }>(`SELECT version::text AS version FROM tenant_memberships WHERE tenant_id=$1 AND principal_id=$2`,
      [current.tenant_id, current.proposed_owner_principal_id])).rows[0];
    if (existing) {
      await q.query(`UPDATE tenant_memberships SET role='owner', status='active', revoked_at=NULL, accepted_at=clock_timestamp(), version=version+1, updated_at=clock_timestamp()
        WHERE tenant_id=$1 AND principal_id=$2`, [current.tenant_id, current.proposed_owner_principal_id]);
    } else {
      await q.query(`INSERT INTO tenant_memberships(tenant_id,principal_id,role,status,accepted_at) VALUES($1,$2,'owner','active',clock_timestamp())`,
        [current.tenant_id, current.proposed_owner_principal_id]);
    }
    await q.query(`UPDATE tenants SET status='active', updated_at=clock_timestamp() WHERE tenant_id=$1 AND status='recovery_required'`, [current.tenant_id]);
    await q.query(`UPDATE tenant_recovery_cases SET state='executed', executed_by_admin_id=$2, version=version+1, updated_at=clock_timestamp()
      WHERE case_id=$1 AND state='approved'`, [caseId, input.admin.admin_id]);
    const revision = await bumpAuthorizationRevision(q, current.tenant_id);
    const membership = (await q.query<{ version: string }>(`SELECT version::text AS version FROM tenant_memberships WHERE tenant_id=$1 AND principal_id=$2`,
      [current.tenant_id, current.proposed_owner_principal_id])).rows[0];
    await auditTenant(q, current.tenant_id, current.proposed_owner_principal_id, 'tenant.recovery.execute', current.proposed_owner_principal_id, tenant.authorization_revision, revision, 'tenant.recovery.executed');
    await audit(q, input.admin, 'tenant.recovery.execute', 'tenant_recovery_case', caseId, 'tenant.owner.restore', { state: 'approved' }, { state: 'executed', authorization_revision: revision });
    await writeTenantControlEvent(q, {
      tenantId: current.tenant_id, principalId: current.proposed_owner_principal_id, operation: 'tenant.recovery.execute',
      aggregateType: 'tenant_membership', aggregateId: current.proposed_owner_principal_id, aggregateVersion: versionOf(membership.version),
      data: { tenant_id: current.tenant_id, principal_id: current.proposed_owner_principal_id, role: 'owner', status: 'active', authorization_revision: revision },
      eventType: 'freedom.tenant.membership.changed.v1',
    });
    return RecoveryExecuteResultSchema.parse({ case: adminView(await loadCase(q, caseId)), authorization_revision: revision });
  });
}

export async function closeRecoveryCase(pool: Pool, input: AdminCommand, caseId: string) {
  const body = RecoveryCloseInputSchema.parse(input.body);
  OpaqueId.parse(caseId);
  return adminCommand(pool, input, async q => {
    await requireCapability(q, input.admin.admin_id, 'tenant.recovery.review');
  }, async q => {
    const current = await loadCase(q, caseId, true);
    requireCondition(current.community_id === input.admin.community_id, 404, 'recovery_case_not_found', RECOVERY_MISSING);
    if (terminal(current.state)) throw new Problem(409, 'recovery_case_terminal', '這份復原已結束，不能再變更。');
    requireCondition(current.state === 'evidence_required' || current.state === 'approved', 409, 'recovery_case_terminal', '這份復原目前不能這樣變更。');
    checkVersion(versionOf(current.version), input.expected);
    assertIndependent(input.admin, current.target_email, [current.opened_by_admin_id]);
    await q.query(`UPDATE tenant_recovery_cases SET state=$2, closed_reason=$3, version=version+1, updated_at=clock_timestamp()
      WHERE case_id=$1 AND state IN ('evidence_required','approved')`, [caseId, body.decision, body.reason]);
    const view = adminView(await loadCase(q, caseId));
    const revision = (await q.query<{ authorization_revision: string }>(`SELECT authorization_revision::text AS authorization_revision FROM tenants WHERE tenant_id=$1`, [current.tenant_id])).rows[0].authorization_revision;
    await auditTenant(q, current.tenant_id, current.proposed_owner_principal_id, 'tenant.recovery.close', current.proposed_owner_principal_id, revision, revision, 'tenant.recovery.closed');
    await audit(q, input.admin, 'tenant.recovery.close', 'tenant_recovery_case', caseId, body.reason, { state: current.state }, { state: body.decision });
    return view;
  });
}

export async function getRecoveryCase(pool: Pool, admin: AdminActor, caseId: string) {
  OpaqueId.parse(caseId);
  return transaction(pool, async q => {
    await requireCapability(q, admin.admin_id, 'tenant.recovery.read');
    const row = await loadCase(q, caseId);
    requireCondition(row.community_id === admin.community_id, 404, 'recovery_case_not_found', RECOVERY_MISSING);
    return adminView(row);
  });
}

export async function listMyRecoveryCases(pool: Pool, actor: Actor, query: { cursor?: string; limit?: string }) {
  const limit = limitOf(query.limit);
  return transaction(pool, async q => {
    await lockMemberSession(q, actor);
    const principal = await mapPersonPrincipal(q, actor.user_id);
    requireCondition(principal.status === 'active', 403, 'principal_disabled', '這個身分目前無法使用。');
    const after = readCursor(query.cursor, principal.principal_id, 'my_recovery_cases', null);
    const rows = (await q.query<CaseRow>(`SELECT c.case_id, c.tenant_id, t.display_name AS tenant_display_name, t.community_id,
        c.proposed_owner_principal_id, c.state, c.approved_scope, c.expires_at, c.recipient_accepted_at, c.version::text AS version,
        c.evidence_ref, c.opened_by_admin_id, c.approved_by_admin_id, c.executed_by_admin_id,
        lower(u.email) AS target_email, u.user_id AS owner_user_id, u.active AS owner_active, p.status AS principal_status
      FROM tenant_recovery_cases c
      JOIN tenants t ON t.tenant_id=c.tenant_id
      JOIN principals p ON p.principal_id=c.proposed_owner_principal_id
      JOIN users u ON u.user_id=p.user_ref
      WHERE c.proposed_owner_principal_id=$1 AND c.state IN ('opened','evidence_required','approved')
        AND ($2::uuid IS NULL OR c.case_id > $2::uuid)
      ORDER BY c.case_id LIMIT $3`, [principal.principal_id, after, limit + 1])).rows;
    const page = rows.slice(0, limit);
    return RecoveryCasePageSchema.parse({
      items: page.map(memberView),
      next_cursor: rows.length > limit ? encodeCursor(principal.principal_id, 'my_recovery_cases', null, page[page.length - 1].case_id) : null,
      source_version: '1',
    });
  });
}

export async function acceptRecoveryCase(pool: Pool, actor: Actor, caseId: string, body: unknown, key: string, expected: string) {
  const input = RecoveryAcceptInputSchema.parse(body);
  OpaqueId.parse(caseId);
  return scopedMemberCommand(pool, {
    actor, scope: 'personal', operation: 'tenant.recovery.accept', key, body: input, expected,
    target: { kind: 'tenant_recovery_case', id: caseId },
  }, async (q, context) => {
    const visible = (await q.query<{ proposed_owner_principal_id: string; tenant_id: string }>(
      `SELECT proposed_owner_principal_id, tenant_id FROM tenant_recovery_cases WHERE case_id=$1`, [caseId])).rows[0];
    if (!visible || visible.proposed_owner_principal_id !== context.subject_principal.principal_id) throw new Problem(404, 'recovery_case_not_found', RECOVERY_MISSING);
    const digest = receiptNamespaceDigest(MEMBER_PROFILE, [context.subject_principal.principal_id, context.authn_kind, context.scope.scope_id, 'tenant.recovery.accept', key]);
    await requireFreshVerification(q, {
      userId: actor.user_id, sessionHash: actor.session_hash, principalId: context.subject_principal.principal_id,
      tenantId: visible.tenant_id, purpose: 'tenant.recovery.accept', verificationId: input.fresh_auth_verification_id, namespaceDigest: digest,
    });
    await loadActivePolicy(q);
  }, async (q, context) => {
    const current = await loadCase(q, caseId, true);
    if (current.proposed_owner_principal_id !== context.subject_principal.principal_id) throw new Problem(404, 'recovery_case_not_found', RECOVERY_MISSING);
    if (terminal(current.state)) throw new Problem(409, 'recovery_case_terminal', '這份復原已結束，不能再變更。');
    checkVersion(versionOf(current.version), expected);
    requireCondition(current.owner_active && current.principal_status === 'active', 403, 'tenant_capability_denied', '目前無法使用這個業務空間。');
    if (!current.recipient_accepted_at) {
      await q.query(`UPDATE tenant_recovery_cases SET recipient_accepted_at=clock_timestamp(), version=version+1, updated_at=clock_timestamp()
        WHERE case_id=$1 AND recipient_accepted_at IS NULL AND state IN ('evidence_required','approved')`, [caseId]);
      const revision = (await q.query<{ authorization_revision: string }>(`SELECT authorization_revision::text AS authorization_revision FROM tenants WHERE tenant_id=$1`, [current.tenant_id])).rows[0].authorization_revision;
      await auditTenant(q, current.tenant_id, context.subject_principal.principal_id, 'tenant.recovery.accept', context.subject_principal.principal_id, revision, revision, 'tenant.recovery.accepted');
    }
    const digest = receiptNamespaceDigest(MEMBER_PROFILE, [context.subject_principal.principal_id, context.authn_kind, context.scope.scope_id, 'tenant.recovery.accept', key]);
    await consumeFreshVerification(q, input.fresh_auth_verification_id, digest);
    return memberView(await loadCase(q, caseId));
  }, async (q, context) => {
    const prior = (await q.query(`SELECT 1 FROM scoped_command_receipts
      WHERE principal_id=$1 AND authn_kind=$2 AND scope_id=$3 AND operation='tenant.recovery.accept' AND idempotency_key=$4`,
    [context.subject_principal.principal_id, context.authn_kind, context.scope.scope_id, key])).rows[0];
    if (!prior) return;
    const account = (await q.query<{ ok: boolean }>(`SELECT (p.status='active' AND u.active AND c.proposed_owner_principal_id=$1) AS ok
      FROM tenant_recovery_cases c
      JOIN principals p ON p.principal_id=c.proposed_owner_principal_id
      JOIN users u ON u.user_id=p.user_ref
      WHERE c.case_id=$2`, [context.subject_principal.principal_id, caseId])).rows[0];
    requireCondition(account?.ok, 403, 'tenant_capability_denied', '目前無法使用這個業務空間。');
  });
}
