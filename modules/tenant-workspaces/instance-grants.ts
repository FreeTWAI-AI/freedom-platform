import type { PoolClient } from 'pg';
import { InstanceCapabilitiesInputSchema, type InstanceCapabilitiesInput, type InviteRole } from '../../contracts/guild-launchpad/v1/tenant.js';
import { Problem } from '../../packages/shared/problem.js';

export const HIGH_RISK_INSTANCE_CAPABILITIES: ReadonlySet<string> = new Set([
  'module.data.export', 'module.authority.transfer', 'module.binding.manage', 'tenant.ownership.transfer', 'instance.manage',
]);

/** Instance identity/release and registered keys are immutable. No instance locks here:
 * writers already hold the tenant and target membership FOR UPDATE; readers hold SHARE. */
export async function validateInstanceGrants(q: PoolClient, tenantId: string, role: InviteRole,
  raw: unknown, stale = false): Promise<InstanceCapabilitiesInput> {
  const fail = (): never => {
    throw stale
      ? new Problem(409, 'invitation_stale', '這份邀請的權限已不能授予，請邀請人重新邀請。')
      : new Problem(422, 'capability_not_grantable', '其中有無法授予的權限，請重新整理後再試。');
  };
  const parsed = InstanceCapabilitiesInputSchema.safeParse(raw);
  if (!parsed.success) return fail();
  const entries = parsed.data;
  if (role === 'admin' && entries.length) return fail();
  if (!entries.length) return [];
  const definitions = (await q.query<{ instance_id: string; capabilities: string[] }>(
    `SELECT i.instance_id,d.capabilities FROM module_instances i
     JOIN module_definitions d ON d.module_key=i.module_key AND d.release_ref=i.module_release_ref
     WHERE i.tenant_id=$1 AND i.instance_id=ANY($2::uuid[])`, [tenantId, entries.map(entry => entry.instance_id)])).rows;
  const registered = new Map(definitions.map(row => [row.instance_id, row.capabilities]));
  for (const entry of entries) {
    const keys = registered.get(entry.instance_id);
    if (!keys || entry.capabilities.some(key => HIGH_RISK_INSTANCE_CAPABILITIES.has(key) || !keys.includes(key)
      || role === 'viewer' && !key.endsWith(':read'))
      || keys.some(key => key.endsWith(':read')) && !entry.capabilities.some(key => key.endsWith(':read'))) return fail();
  }
  return entries.map(entry => ({ instance_id: entry.instance_id, capabilities: [...entry.capabilities].sort() }))
    .sort((a, b) => a.instance_id < b.instance_id ? -1 : a.instance_id > b.instance_id ? 1 : 0);
}

/** Complete ordinary set replacement. A revoked row is reactivated in place;
 * an unchanged active key set retains its version, including a different manager. */
export async function replaceInstanceGrants(q: PoolClient, tenantId: string, principalId: string,
  entries: InstanceCapabilitiesInput, grantorId: string): Promise<void> {
  await q.query(`UPDATE tenant_module_permissions SET status='revoked', revoked_at=clock_timestamp(),
      version=version+1, updated_at=clock_timestamp()
    WHERE tenant_id=$1 AND principal_id=$2 AND purpose IS NULL AND status='active' AND NOT (instance_id=ANY($3::uuid[]))`,
  [tenantId, principalId, entries.map(entry => entry.instance_id)]);
  for (const entry of entries) {
    await q.query(`INSERT INTO tenant_module_permissions(tenant_id,principal_id,instance_id,capabilities,status,granted_by_principal_id)
      VALUES($1,$2,$3,$4::text[],'active',$5)
      ON CONFLICT (tenant_id,principal_id,instance_id) WHERE purpose IS NULL DO UPDATE
      SET capabilities=EXCLUDED.capabilities,status='active',revoked_at=NULL,granted_by_principal_id=EXCLUDED.granted_by_principal_id,
        version=tenant_module_permissions.version+CASE WHEN tenant_module_permissions.status<>'active'
          OR tenant_module_permissions.capabilities IS DISTINCT FROM EXCLUDED.capabilities THEN 1 ELSE 0 END,
        updated_at=clock_timestamp()
      WHERE tenant_module_permissions.status<>'active' OR tenant_module_permissions.capabilities IS DISTINCT FROM EXCLUDED.capabilities
        OR tenant_module_permissions.granted_by_principal_id IS DISTINCT FROM EXCLUDED.granted_by_principal_id`,
    [tenantId, principalId, entry.instance_id, entry.capabilities, grantorId]);
  }
}

export async function revokeInstanceGrants(q: PoolClient, tenantId: string, principalId: string): Promise<void> {
  await q.query(`UPDATE tenant_module_permissions SET status='revoked',revoked_at=clock_timestamp(),version=version+1,updated_at=clock_timestamp()
    WHERE tenant_id=$1 AND principal_id=$2 AND purpose IS NULL AND status='active'`, [tenantId, principalId]);
}

/** One aggregated query for a whole members page, also reused for single-person views. */
export async function activeInstanceGrants(q: PoolClient, tenantId: string, principalIds: readonly string[]) {
  const rows = (await q.query<{ principal_id: string; entries: InstanceCapabilitiesInput }>(
    `SELECT principal_id,jsonb_agg(jsonb_build_object('instance_id',instance_id,'capabilities',
        ARRAY(SELECT key FROM unnest(capabilities) AS key ORDER BY key)) ORDER BY instance_id) AS entries
     FROM tenant_module_permissions WHERE tenant_id=$1 AND principal_id=ANY($2::uuid[]) AND purpose IS NULL AND status='active'
     GROUP BY principal_id`, [tenantId, principalIds])).rows;
  return new Map(rows.map(row => [row.principal_id, row.entries]));
}
