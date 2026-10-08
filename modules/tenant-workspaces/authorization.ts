import type { InviteRole, TenantRole } from '../../contracts/guild-launchpad/v1/tenant.js';

// Tenant role templates. Ordinary module keys for operators/viewers come from
// explicit instance grants, independently of these tenant metadata permissions.
export const TENANT_CAPABILITIES = Object.freeze([
  'tenant.metadata.read',
  'tenant.metadata.edit',
  'tenant.member.read',
  'tenant.member.invite',
  'tenant.member.manage',
  'tenant.workspace.read',
  'tenant.workspace.create',
] as const);
export type TenantCapability = typeof TENANT_CAPABILITIES[number];

const ROLE_CAPABILITIES: Record<TenantRole, readonly TenantCapability[]> = {
  viewer: ['tenant.metadata.read', 'tenant.workspace.read'],
  operator: ['tenant.metadata.read', 'tenant.workspace.read'],
  admin: ['tenant.metadata.read', 'tenant.metadata.edit', 'tenant.member.read', 'tenant.member.invite', 'tenant.member.manage', 'tenant.workspace.read', 'tenant.workspace.create'],
  owner: ['tenant.metadata.read', 'tenant.metadata.edit', 'tenant.member.read', 'tenant.member.invite', 'tenant.member.manage', 'tenant.workspace.read', 'tenant.workspace.create'],
};

export const MAX_ACTIVE_TENANTS_PER_PERSON = 5;
export const MAX_WORKSPACES_PER_TENANT = 10;
export const MAX_PENDING_INVITATIONS_PER_TENANT = 20;
export const MAX_INVITATION_DAYS = 7;

export const RESERVED_SLUGS = Object.freeze(new Set([
  'admin', 'api', 'www', 'app', 'tenant', 'tenants', 'me', 'null', 'undefined', 'freedom',
  'guild', 'workspace', 'workspaces', 'public', 'private', 'system', 'root', 'support',
  'help', 'static', 'assets', 'login', 'auth', 'owner', 'new', 'create', 'settings', 'business',
]));

export function roleCapabilities(role: TenantRole): readonly TenantCapability[] {
  return ROLE_CAPABILITIES[role] ?? [];
}
export function can(role: TenantRole, capability: TenantCapability): boolean {
  return roleCapabilities(role).includes(capability);
}
export function canInviteRole(actorRole: TenantRole, targetRole: InviteRole): boolean {
  if (actorRole === 'owner') return targetRole === 'admin' || targetRole === 'operator' || targetRole === 'viewer';
  if (actorRole === 'admin') return targetRole === 'operator' || targetRole === 'viewer';
  return false;
}
/** member.change never manages an owner. Admin manages only operator and viewer. */
export function canManageRole(actorRole: TenantRole, targetRole: TenantRole): boolean {
  if (targetRole === 'owner') return false;
  if (actorRole === 'owner') return targetRole === 'admin' || targetRole === 'operator' || targetRole === 'viewer';
  if (actorRole === 'admin') return targetRole === 'operator' || targetRole === 'viewer';
  return false;
}
