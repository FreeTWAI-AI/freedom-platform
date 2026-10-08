import type { TenantAccessRole, TenantScopeContext } from '../../packages/resource-scopes/index.js';
import { Problem, requireCondition } from '../../packages/shared/problem.js';

/** Work capabilities live here until tenant_module_permissions (slice B2).
 * Operator and viewer stay empty so every Work route fails closed. */
export const TENANT_WORK_CAPABILITIES = Object.freeze([
  'instance.manage', 'work:create', 'work:read', 'work:write', 'work:archive', 'work:result.write',
] as const);

export function tenantWorkCapabilities(role: TenantAccessRole): readonly string[] {
  return role === 'owner' || role === 'admin' ? TENANT_WORK_CAPABILITIES : [];
}

export function requireTenantCapability(context: TenantScopeContext, capability: string, write: boolean) {
  if (write && context.tenant_status !== 'active') throw new Problem(403, 'capability_denied', '目前無法使用這個業務空間。');
  requireCondition(context.capabilities.includes(capability), 403, 'capability_denied', '目前沒有這個操作的權限。');
}

/** New Work/Result writes require the instance and its current deployment to be active. */
export function isWorkInstanceWritable(instanceStatus: string | undefined, deploymentState: string | undefined): boolean {
  return instanceStatus === 'active' && deploymentState === 'active';
}
