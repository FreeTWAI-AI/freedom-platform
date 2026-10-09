import type { TenantView } from '../../../../contracts/guild-launchpad/v1/tenant';

type WorkWriteCapability = 'work:create' | 'work:write' | 'work:archive' | 'work:result.write';

/** UI projection of tenantWorkCapabilities + same-instance ordinary grants. The API rechecks current authority. */
export function canWriteTenantWork(tenant: TenantView | null, instanceId: string | undefined, key: WorkWriteCapability): boolean {
  if (!tenant || tenant.status !== 'active' || !instanceId) return false;
  if (tenant.my_membership.role === 'owner' || tenant.my_membership.role === 'admin') return true;
  return tenant.capabilities.some(grant => grant.instance_id === instanceId && grant.keys.includes(key));
}
