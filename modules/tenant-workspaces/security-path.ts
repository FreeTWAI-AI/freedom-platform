import type { PoolClient } from 'pg';
import { auditTenant, bumpAuthorizationRevision, invalidatePendingTransfersOfPrincipal, writeTenantControlEvent } from './facts.js';

/** Called from changeMemberStatus after that transaction has locked the user
 * and revoked sessions. Disabling the last loginable owner sets
 * recovery_required. It never assigns the tenant to a guild leader or admin.
 * Re-activation restores active only when the tenant is still recovery_required
 * for owner_account_disabled, no case has been approved or executed, and this
 * person is still an active owner. An evidence_required case does not block
 * re-activation; a later execute then refuses because a loginable owner exists.
 * Audit actor is this person's principal: tenant_authority_audit cannot store
 * an admin, and platform_admin_audit already records the admin. */
export async function applyOwnerAccountStatus(q: PoolClient, userId: string, active: boolean): Promise<void> {
  await q.query(`SELECT user_id FROM users WHERE user_id=$1 FOR UPDATE`, [userId]);
  const principal = (await q.query<{ principal_id: string }>(
    `SELECT principal_id FROM principals WHERE user_ref=$1 AND kind='person'`, [userId])).rows[0];
  if (!principal) return;
  if (!active) {
    const tenants = (await q.query<{ tenant_id: string; authorization_revision: string }>(`SELECT t.tenant_id, t.authorization_revision::text AS authorization_revision
      FROM tenants t
      JOIN tenant_memberships m ON m.tenant_id=t.tenant_id AND m.principal_id=$1 AND m.role='owner' AND m.status='active'
      WHERE t.status='active'
        AND NOT EXISTS (
          SELECT 1 FROM tenant_memberships o
          JOIN principals p ON p.principal_id=o.principal_id AND p.status='active'
          JOIN users u ON u.user_id=p.user_ref AND u.active
          WHERE o.tenant_id=t.tenant_id AND o.role='owner' AND o.status='active' AND o.principal_id<>$1)
      ORDER BY t.tenant_id
      FOR UPDATE OF t`, [principal.principal_id])).rows;
    for (const tenant of tenants) {
      const updated = await q.query(`UPDATE tenants SET status='recovery_required', updated_at=clock_timestamp() WHERE tenant_id=$1 AND status='active'`, [tenant.tenant_id]);
      if (updated.rowCount !== 1) continue;
      const revision = await bumpAuthorizationRevision(q, tenant.tenant_id);
      await auditTenant(q, tenant.tenant_id, principal.principal_id, 'tenant.security.owner_disabled', principal.principal_id, tenant.authorization_revision, revision, 'owner_account_disabled');
      await writeTenantControlEvent(q, {
        tenantId: tenant.tenant_id, principalId: principal.principal_id, operation: 'tenant.security.owner_disabled',
        aggregateType: 'tenant_recovery', aggregateId: tenant.tenant_id, aggregateVersion: revision,
        data: { tenant_id: tenant.tenant_id, reason_code: 'owner_account_disabled', authorization_revision: revision },
        eventType: 'freedom.tenant.recovery.required.v1',
      });
    }
    await invalidatePendingTransfersOfPrincipal(q, principal.principal_id);
    return;
  }
  const restorations = (await q.query<{ tenant_id: string; authorization_revision: string }>(`SELECT t.tenant_id, t.authorization_revision::text AS authorization_revision
    FROM tenants t
    JOIN tenant_memberships m ON m.tenant_id=t.tenant_id AND m.principal_id=$1 AND m.role='owner' AND m.status='active'
    WHERE t.status='recovery_required'
      AND NOT EXISTS (
        SELECT 1 FROM tenant_recovery_cases c WHERE c.tenant_id=t.tenant_id AND c.state IN ('approved','executed'))
      AND (
        SELECT a.reason_code FROM tenant_authority_audit a
        WHERE a.tenant_id=t.tenant_id AND a.reason_code IN ('owner_account_disabled','owner_account_reactivated')
        ORDER BY a.occurred_at DESC, a.event_id DESC LIMIT 1
      ) = 'owner_account_disabled'
    ORDER BY t.tenant_id
    FOR UPDATE OF t`, [principal.principal_id])).rows;
  for (const tenant of restorations) {
    const updated = await q.query(`UPDATE tenants SET status='active', updated_at=clock_timestamp() WHERE tenant_id=$1 AND status='recovery_required'`, [tenant.tenant_id]);
    if (updated.rowCount !== 1) continue;
    const revision = await bumpAuthorizationRevision(q, tenant.tenant_id);
    await auditTenant(q, tenant.tenant_id, principal.principal_id, 'tenant.security.owner_reactivated', principal.principal_id, tenant.authorization_revision, revision, 'owner_account_reactivated');
  }
}
