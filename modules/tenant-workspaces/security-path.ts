import type { PoolClient } from 'pg';
import { auditTenant, bumpAuthorizationRevision, invalidatePendingTransfersOfPrincipal, writeTenantControlEvent } from './facts.js';

/** Called from changeMemberStatus after that transaction has locked the user
 * and revoked sessions. Disabling the last loginable owner sets
 * recovery_required. It never assigns the tenant to a guild leader or admin.
 * Re-activation restores active only when the tenant is still recovery_required
 * for owner_account_disabled, no case has been approved or executed, and this
 * person is still an active owner. An evidence_required case does not block
 * re-activation. Recovery execute revokes every other active owner membership,
 * so re-activating a former owner never hands control back.
 * Audit actor is this person's principal: tenant_authority_audit cannot store
 * an admin, and platform_admin_audit already records the admin. */
export async function applyOwnerAccountStatus(q: PoolClient, userId: string, active: boolean): Promise<void> {
  await q.query(`SELECT user_id FROM users WHERE user_id=$1 FOR UPDATE`, [userId]);
  const principal = (await q.query<{ principal_id: string }>(
    `SELECT principal_id FROM principals WHERE user_ref=$1 AND kind='person'`, [userId])).rows[0];
  if (!principal) return;
  if (!active) {
    await transitionOwnedTenants(q, principal.principal_id, 'active', async tenantId => {
      const still = (await q.query<{ authorization_revision: string }>(`SELECT t.authorization_revision::text AS authorization_revision
        FROM tenants t
        WHERE t.tenant_id=$1 AND t.status='active'
          AND EXISTS (
            SELECT 1 FROM tenant_memberships self
            WHERE self.tenant_id=t.tenant_id AND self.principal_id=$2 AND self.role='owner' AND self.status='active')
          AND NOT EXISTS (
            SELECT 1 FROM tenant_memberships o
            JOIN principals p ON p.principal_id=o.principal_id AND p.status='active'
            JOIN users u ON u.user_id=p.user_ref AND u.active
            WHERE o.tenant_id=t.tenant_id AND o.role='owner' AND o.status='active' AND o.principal_id<>$2)`,
      [tenantId, principal.principal_id])).rows[0];
      if (!still) return;
      const updated = await q.query(`UPDATE tenants SET status='recovery_required', updated_at=clock_timestamp() WHERE tenant_id=$1 AND status='active'`, [tenantId]);
      if (updated.rowCount !== 1) return;
      const revision = await bumpAuthorizationRevision(q, tenantId);
      await auditTenant(q, tenantId, principal.principal_id, 'tenant.security.owner_disabled', principal.principal_id, still.authorization_revision, revision, 'owner_account_disabled');
      await writeTenantControlEvent(q, {
        tenantId, principalId: principal.principal_id, operation: 'tenant.security.owner_disabled',
        aggregateType: 'tenant_recovery', aggregateId: tenantId, aggregateVersion: revision,
        data: { tenant_id: tenantId, reason_code: 'owner_account_disabled', authorization_revision: revision },
        eventType: 'freedom.tenant.recovery.required.v1',
      });
    });
    await invalidatePendingTransfersOfPrincipal(q, principal.principal_id);
    return;
  }
  await transitionOwnedTenants(q, principal.principal_id, 'recovery_required', async tenantId => {
    const still = (await q.query<{ authorization_revision: string }>(`SELECT t.authorization_revision::text AS authorization_revision
      FROM tenants t
      WHERE t.tenant_id=$1 AND t.status='recovery_required'
        AND EXISTS (
          SELECT 1 FROM tenant_memberships self
          WHERE self.tenant_id=t.tenant_id AND self.principal_id=$2 AND self.role='owner' AND self.status='active')
        AND NOT EXISTS (
          SELECT 1 FROM tenant_recovery_cases c WHERE c.tenant_id=t.tenant_id AND c.state IN ('approved','executed'))
        AND (
          SELECT a.reason_code FROM tenant_authority_audit a
          WHERE a.tenant_id=t.tenant_id AND a.reason_code IN ('owner_account_disabled','owner_account_reactivated')
          ORDER BY a.occurred_at DESC, a.event_id DESC LIMIT 1
        ) = 'owner_account_disabled'`,
    [tenantId, principal.principal_id])).rows[0];
    if (!still) return;
    const updated = await q.query(`UPDATE tenants SET status='active', updated_at=clock_timestamp() WHERE tenant_id=$1 AND status='recovery_required'`, [tenantId]);
    if (updated.rowCount !== 1) return;
    const revision = await bumpAuthorizationRevision(q, tenantId);
    await auditTenant(q, tenantId, principal.principal_id, 'tenant.security.owner_reactivated', principal.principal_id, still.authorization_revision, revision, 'owner_account_reactivated');
  });
}

/** Lock first, in tenant_id order, then re-read. A NOT EXISTS in the locking
 * statement is not re-run after a row-lock wait under READ COMMITTED, so two
 * uncommitted owner disables would both miss the tenant. One row at a time
 * keeps both transactions on the same order. */
async function transitionOwnedTenants(q: PoolClient, principalId: string, status: 'active' | 'recovery_required', transition: (tenantId: string) => Promise<void>): Promise<void> {
  const owned = (await q.query<{ tenant_id: string }>(`SELECT t.tenant_id
    FROM tenants t
    JOIN tenant_memberships m ON m.tenant_id=t.tenant_id AND m.principal_id=$1 AND m.role='owner' AND m.status='active'
    WHERE t.status=$2
    ORDER BY t.tenant_id`, [principalId, status])).rows;
  for (const tenant of owned) {
    await q.query(`SELECT tenant_id FROM tenants WHERE tenant_id=$1 FOR UPDATE`, [tenant.tenant_id]);
  }
  for (const tenant of owned) await transition(tenant.tenant_id);
}
