import { z } from 'zod';
import { OpaqueId, Version, page } from './primitives.js';

// Wire versions are positive decimal strings. Do not name a field aggregate_version:
// the platform JSON middleware rewrites only that literal name into a number.
export const VersionSchema = Version;
export const TenantRoleSchema = z.enum(['owner', 'admin', 'operator', 'viewer']);
export const InviteRoleSchema = z.enum(['admin', 'operator', 'viewer']);
export const TenantStatusSchema = z.enum(['active', 'suspended', 'recovery_required', 'archived']);
export const DisplayNameSchema = z.string().min(1).max(120).refine(value => new TextEncoder().encode(value).length <= 480 && !/[\u0000-\u001f\u007f]/.test(value), '名稱含有不允許的字元。');
export const PersonNameSchema = z.string().min(1).max(240);
export const PublicSlugSchema = z.string().max(64).regex(/^[a-z0-9](?:[a-z0-9-]{1,62}[a-z0-9])$(?![\s\S])/);
export const ReasonSchema = z.string().min(3).max(1000).refine(value => !/[\u0000-\u001f\u007f]/.test(value), '原因含有不允許的字元。');
export const IsoTimeSchema = z.string().regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,9})?(?:Z|[+-][0-9]{2}:[0-9]{2})$(?![\s\S])/);

// This slice has no module instances. Inputs must send an empty list so the
// shape can grow later. Any grant, including high-risk keys, is rejected here.
export const EmptyInstanceCapabilitiesSchema = z.array(z.object({
  instance_id: OpaqueId,
  capabilities: z.array(z.string().max(80)).max(100),
}).strict()).max(0);

export const CapabilityGrantSchema = z.object({
  instance_id: OpaqueId.nullable(),
  keys: z.array(z.string().max(80).regex(/^[a-z][a-z0-9._-]{0,79}$(?![\s\S])/)).max(100),
}).strict();
export const MemberCapabilitySchema = z.object({
  instance_id: OpaqueId,
  capabilities: z.array(z.string().max(80).regex(/^[a-z][a-z0-9._-]{0,79}$(?![\s\S])/)).max(100),
}).strict();

export const TenantViewSchema = z.object({
  tenant_id: OpaqueId,
  community_id: OpaqueId,
  display_name: DisplayNameSchema,
  public_slug: PublicSlugSchema.nullable(),
  status: TenantStatusSchema,
  version: VersionSchema,
  authorization_revision: VersionSchema,
  my_membership: z.object({ principal_id: OpaqueId, role: TenantRoleSchema, version: VersionSchema }).strict(),
  capabilities: z.array(CapabilityGrantSchema).max(100),
  default_workspace_id: OpaqueId,
}).strict();
export const WorkspaceViewSchema = z.object({
  workspace_id: OpaqueId,
  tenant_id: OpaqueId,
  name: DisplayNameSchema,
  status: z.enum(['active', 'archived']),
  version: VersionSchema,
}).strict();
export const MemberViewSchema = z.object({
  principal_id: OpaqueId,
  display_name: PersonNameSchema,
  role: TenantRoleSchema,
  status: z.enum(['active', 'revoked']),
  instance_capabilities: z.array(MemberCapabilitySchema).max(100),
  version: VersionSchema,
}).strict();
export const InvitationViewSchema = z.object({
  invitation_id: OpaqueId,
  tenant_id: OpaqueId,
  tenant_display_name: DisplayNameSchema,
  invitee_principal_id: OpaqueId,
  role: InviteRoleSchema,
  instance_capabilities: z.array(MemberCapabilitySchema).max(100),
  state: z.enum(['pending', 'accepted', 'declined', 'revoked', 'expired']),
  expires_at: IsoTimeSchema,
  version: VersionSchema,
}).strict();

export function PageSchema<T extends z.ZodType>(item: T) {
  return page(item);
}
export const TenantPageSchema = PageSchema(TenantViewSchema);
export const WorkspacePageSchema = PageSchema(WorkspaceViewSchema);
export const MemberPageSchema = PageSchema(MemberViewSchema);
export const InvitationPageSchema = PageSchema(InvitationViewSchema);

export const TenantCreateInputSchema = z.object({
  display_name: DisplayNameSchema,
  workspace_name: DisplayNameSchema.optional(),
}).strict();
export const TenantEditInputSchema = z.object({
  display_name: DisplayNameSchema,
  public_slug: PublicSlugSchema.nullable(),
}).strict();
export const WorkspaceCreateInputSchema = z.object({ name: DisplayNameSchema }).strict();
export const InviteInputSchema = z.object({
  invitee_principal_id: OpaqueId,
  role: InviteRoleSchema,
  instance_capabilities: EmptyInstanceCapabilitiesSchema,
  expires_at: IsoTimeSchema,
}).strict();
export const InvitationRevokeInputSchema = z.object({ reason: ReasonSchema }).strict();
export const MemberChangeInputSchema = z.object({
  role: InviteRoleSchema,
  status: z.enum(['active', 'revoked']),
  instance_capabilities: EmptyInstanceCapabilitiesSchema,
  reason: ReasonSchema,
}).strict();
export const EmptyObjectSchema = z.object({}).strict();
export const LeaveResultSchema = z.object({ status: z.literal('revoked'), version: VersionSchema }).strict();
export const AcceptResultSchema = z.object({ invitation: InvitationViewSchema, membership: MemberViewSchema }).strict();
export const CreateResultSchema = z.object({ tenant: TenantViewSchema, workspace: WorkspaceViewSchema }).strict();
export const InviteCandidateSchema = z.object({ principal_id: OpaqueId, display_name: PersonNameSchema }).strict();
export const PageQuerySchema = z.object({
  cursor: z.string().min(1).max(512).optional(),
  limit: z.string().regex(/^[1-9][0-9]{0,2}$/).optional(),
}).strict();
export const InviteCandidateQuerySchema = z.object({ user_id: OpaqueId }).strict();

export type TenantView = z.infer<typeof TenantViewSchema>;
export type WorkspaceView = z.infer<typeof WorkspaceViewSchema>;
export type MemberView = z.infer<typeof MemberViewSchema>;
export type InvitationView = z.infer<typeof InvitationViewSchema>;
export type TenantRole = z.infer<typeof TenantRoleSchema>;
export type InviteRole = z.infer<typeof InviteRoleSchema>;
export type TenantStatus = z.infer<typeof TenantStatusSchema>;
