import type { PoolClient } from 'pg';
import type { TenantAccessRole, TenantScopeContext } from '../../../packages/resource-scopes/index.js';
import { Problem, requireCondition } from '../../../packages/shared/problem.js';
import { STORE_CAPABILITIES } from '../../module-registry/definitions.js';

export const STORE_MISSING = '找不到這間商店。';
const template = Object.freeze(['instance.manage', ...STORE_CAPABILITIES]);
export function storeCapabilities(role: TenantAccessRole): readonly string[] {
  return role === 'owner' || role === 'admin' ? template : [];
}
export async function effectiveStoreCapabilities(q: PoolClient, context: TenantScopeContext, instanceId: string): Promise<string[]> {
  if (context.role === 'owner' || context.role === 'admin') return [...STORE_CAPABILITIES];
  const row = (await q.query<{ capabilities: string[] }>(`SELECT capabilities FROM tenant_module_permissions
    WHERE tenant_id=$1 AND instance_id=$2 AND principal_id=$3 AND purpose IS NULL AND status='active'`,
  [context.tenant_id, instanceId, context.principal_id])).rows[0];
  return STORE_CAPABILITIES.filter(key => row?.capabilities.includes(key));
}
export async function requireStoreCapability(q: PoolClient, context: TenantScopeContext, key: string, write: boolean) {
  if (write && context.tenant_status !== 'active') throw new Problem(403, 'capability_denied', '目前無法使用這個業務空間。');
  const granted = context.capabilities.includes(key) || (await q.query(`SELECT 1 FROM tenant_module_permissions
    WHERE tenant_id=$1 AND principal_id=$2 AND purpose IS NULL AND status='active' AND $3=ANY(capabilities) LIMIT 1`,
  [context.tenant_id, context.principal_id, key])).rowCount === 1;
  requireCondition(granted, 403, 'capability_denied', '目前沒有這個操作的權限。');
}
export async function requireStoreInstance(q: PoolClient, context: TenantScopeContext, instanceId: string, key: string, write = false) {
  const keys = await effectiveStoreCapabilities(q, context, instanceId);
  requireCondition(keys.includes('store:read'), 404, 'not_found', STORE_MISSING);
  await requireStoreCapability(q, context, key, write);
  requireCondition(keys.includes(key), 403, 'capability_denied', '目前沒有這個操作的權限。');
  return keys;
}
