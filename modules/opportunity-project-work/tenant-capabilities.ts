import type { TenantAccessRole, TenantScopeContext } from '../../packages/resource-scopes/index.js';
import type { PoolClient } from 'pg';
import { Problem, requireCondition } from '../../packages/shared/problem.js';

/** Owner/admin templates stay separate from explicit ordinary instance grants. */
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

const GRANTABLE_WORK_KEYS = new Set<string>(TENANT_WORK_CAPABILITIES.filter(key => key !== 'instance.manage'));

/** Before target lookup: retain the existing denial for members with no key anywhere. */
export async function requireWorkCapability(q: PoolClient, context: TenantScopeContext, capability: string, write: boolean) {
  if (write && context.tenant_status !== 'active') throw new Problem(403, 'capability_denied', '目前無法使用這個業務空間。');
  const template = context.capabilities.includes(capability);
  const explicit = !template && GRANTABLE_WORK_KEYS.has(capability) && (await q.query(`SELECT 1 FROM tenant_module_permissions
    WHERE tenant_id=$1 AND principal_id=$2 AND purpose IS NULL AND status='active' AND $3=ANY(capabilities) LIMIT 1`,
  [context.tenant_id, context.principal_id, capability])).rowCount === 1;
  requireCondition(template || explicit, 403, 'capability_denied', '目前沒有這個操作的權限。');
}

export async function hasInstanceWorkCapability(q: PoolClient, context: TenantScopeContext, instanceId: string, capability: string) {
  if (context.capabilities.includes(capability)) return true;
  if (!GRANTABLE_WORK_KEYS.has(capability)) return false;
  return (await q.query(`SELECT 1 FROM tenant_module_permissions WHERE tenant_id=$1 AND principal_id=$2
    AND instance_id=$3 AND purpose IS NULL AND status='active' AND $4=ANY(capabilities)`,
  [context.tenant_id, context.principal_id, instanceId, capability])).rowCount === 1;
}

/** Id-addressed targets hide unreadable instances with that route's exact missing body.
 * Workspace-addressed callers omit missingMessage because every member sees workspaces. */
export async function requireWorkInstance(q: PoolClient, context: TenantScopeContext, instanceId: string, capability: string, missingMessage?: string) {
  if (missingMessage) requireCondition(await hasInstanceWorkCapability(q, context, instanceId, 'work:read'), 404, 'not_found', missingMessage);
  requireCondition(await hasInstanceWorkCapability(q, context, instanceId, capability), 403, 'capability_denied', '目前沒有這個操作的權限。');
}

/** New Work/Result writes require the instance and its current deployment to be active. */
export function isWorkInstanceWritable(instanceStatus: string | undefined, deploymentState: string | undefined): boolean {
  return instanceStatus === 'active' && deploymentState === 'active';
}
