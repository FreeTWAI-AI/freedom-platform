import type { TenantAccessRole } from '../../packages/resource-scopes/index.js';

/** Registry routes. The manual-work facade keeps tenant work capabilities. */
export function moduleRegistryCapabilities(role: TenantAccessRole): readonly string[] {
  return role === 'owner' || role === 'admin'
    ? Object.freeze(['instance.manage', 'module.operation.read', 'module.operation.reconcile', 'module.instance.suspend', 'module.instance.resume'])
    : Object.freeze([]);
}
