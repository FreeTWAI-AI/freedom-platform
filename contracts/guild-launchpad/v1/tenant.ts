import { z } from 'zod';
import { OpaqueId } from '../../common/v1/identity.js';

// Wire versions are positive decimal strings. Do not name a field aggregate_version:
// the platform JSON middleware rewrites only that literal name into a number.
export const VersionSchema = z.string().regex(/^[1-9][0-9]{0,18}$/).refine(value => {
  try { return BigInt(value) <= 9223372036854775807n; } catch { return false; }
}, '版本超出範圍。');
export const TenantRoleSchema = z.enum(['owner', 'admin', 'operator', 'viewer']);
export const InviteRoleSchema = z.enum(['admin', 'operator', 'viewer']);
export const TenantStatusSchema = z.enum(['active', 'suspended', 'recovery_required', 'archived']);
export const DisplayNameSchema = z.string().min(1).max(120).refine(value => new TextEncoder().encode(value).length <= 480 && !/[\u0000-\u001f\u007f]/.test(value), '名稱含有不允許的字元。');
export const PersonNameSchema = z.string().min(1).max(240);
export const PublicSlugSchema = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{1,62}[a-z0-9])$/);
export const ReasonSchema = z.string().min(3).max(1000).refine(value => !/[\u0000-\u001f\u007f]/.test(value), '原因含有不允許的字元。');
export const IsoTimeSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/);

// This slice has no module instances. Inputs must send an empty list so the
// shape can grow later. Any grant, including high-risk keys, is rejected here.
export const EmptyInstanceCapabilitiesSchema = z.array(z.object({
  instance_id: OpaqueId,
  capabilities: z.array(z.string().max(80)).max(100),
}).strict()).max(0);

export const CapabilityGrantSchema = z.object({
  instance_id: OpaqueId.nullable(),
  keys: z.array(z.string().regex(/^[a-z][a-z0-9._-]{0,79}$/)).max(100),
}).strict();
export const MemberCapabilitySchema = z.object({
  instance_id: OpaqueId,
  capabilities: z.array(z.string().regex(/^[a-z][a-z0-9._-]{0,79}$/)).max(100),
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
  return z.object({
    items: z.array(item),
    next_cursor: z.string().nullable(),
    source_version: VersionSchema,
  }).strict();
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

export const HighRiskPurposeSchema = z.enum(['tenant.ownership.propose', 'tenant.ownership.accept', 'tenant.recovery.accept']);
export const FromRoleAfterSchema = z.enum(['admin', 'operator', 'viewer', 'revoked']);
export const TransferStateSchema = z.enum(['pending', 'accepted', 'declined', 'cancelled', 'expired', 'invalidated']);
export const RecoveryStateSchema = z.enum(['opened', 'evidence_required', 'approved', 'executed', 'denied', 'cancelled']);
export const RestoreScopeSchema = z.tuple([z.literal('tenant.owner.restore')]);

export const HighRiskVerificationInputSchema = z.object({
  password: z.string().min(1).max(1024),
  purpose: HighRiskPurposeSchema,
  tenant_id: OpaqueId,
}).strict();
export const HighRiskVerificationSchema = z.object({
  verification_id: OpaqueId,
  purpose: HighRiskPurposeSchema,
  tenant_id: OpaqueId,
  expires_at: IsoTimeSchema,
}).strict();

export const TransferProposeInputSchema = z.object({
  to_principal_id: OpaqueId,
  from_role_after: FromRoleAfterSchema,
  expires_at: IsoTimeSchema,
  reason: ReasonSchema,
  fresh_auth_verification_id: OpaqueId,
}).strict();
export const TransferAcceptInputSchema = z.object({
  accept_scope: z.literal(true),
  fresh_auth_verification_id: OpaqueId,
}).strict();
export const TransferCancelInputSchema = z.object({ reason: ReasonSchema }).strict();
export const TransferViewSchema = z.object({
  transfer_id: OpaqueId,
  tenant_id: OpaqueId,
  tenant_display_name: DisplayNameSchema,
  from_principal_id: OpaqueId,
  to_principal_id: OpaqueId,
  from_display_name: PersonNameSchema,
  to_display_name: PersonNameSchema,
  from_role_after: FromRoleAfterSchema,
  state: TransferStateSchema,
  expires_at: IsoTimeSchema,
  version: VersionSchema,
}).strict();
export const TransferAcceptResultSchema = z.object({
  transfer: TransferViewSchema,
  tenant_id: OpaqueId,
  authorization_revision: VersionSchema,
  my_role: z.literal('owner'),
}).strict();
export const TransferPageSchema = PageSchema(TransferViewSchema);

export const RecoveryCaseViewSchema = z.object({
  case_id: OpaqueId,
  tenant_id: OpaqueId,
  tenant_display_name: DisplayNameSchema,
  proposed_owner_principal_id: OpaqueId,
  state: RecoveryStateSchema,
  approved_scope: z.union([z.tuple([]), RestoreScopeSchema]),
  expires_at: IsoTimeSchema.nullable(),
  recipient_accepted: z.boolean(),
  version: VersionSchema,
}).strict();
export const AdminRecoveryCaseViewSchema = RecoveryCaseViewSchema.extend({
  evidence_ref: OpaqueId,
}).strict();
export const RecoveryOpenInputSchema = z.object({
  tenant_id: OpaqueId,
  proposed_owner_principal_id: OpaqueId,
  reason: ReasonSchema,
  evidence_ref: OpaqueId,
}).strict();
export const RecoveryApproveInputSchema = z.object({
  approved_scope: RestoreScopeSchema,
  expires_at: IsoTimeSchema,
  reason: ReasonSchema,
}).strict();
export const RecoveryCloseInputSchema = z.object({
  decision: z.enum(['denied', 'cancelled']),
  reason: ReasonSchema,
}).strict();
export const RecoveryAcceptInputSchema = TransferAcceptInputSchema;
export const RecoveryExecuteResultSchema = z.object({
  case: AdminRecoveryCaseViewSchema,
  authorization_revision: VersionSchema,
}).strict();
export const RecoveryCasePageSchema = PageSchema(RecoveryCaseViewSchema);

// Wire problem codes for this slice. HTTP status mapping lives in the routes.
export const TENANT_AUTHORITY_PROBLEM_CODES = [
  'session_expired', 'tenant_capability_denied', 'guild_full_member_required', 'fresh_auth_required',
  'fresh_auth_rate_limited', 'recovery_authority_required', 'policy_unconfigured', 'tenant_not_found',
  'invitation_not_found', 'transfer_not_found', 'last_owner_required', 'invitation_expired',
  'transfer_expired', 'transfer_authority_changed', 'transfer_pending', 'transfer_closed',
  'tenant_recovery_required', 'tenant_suspended', 'slug_conflict', 'idempotency_conflict',
  'recovery_approval_expired', 'recovery_acceptance_required', 'recovery_case_terminal',
  'recovery_not_required', 'recovery_case_pending', 'version_conflict', 'version_required',
] as const;

export type TenantView = z.infer<typeof TenantViewSchema>;
export type WorkspaceView = z.infer<typeof WorkspaceViewSchema>;
export type MemberView = z.infer<typeof MemberViewSchema>;
export type InvitationView = z.infer<typeof InvitationViewSchema>;
export type TenantRole = z.infer<typeof TenantRoleSchema>;
export type InviteRole = z.infer<typeof InviteRoleSchema>;
export type TenantStatus = z.infer<typeof TenantStatusSchema>;
export type TransferView = z.infer<typeof TransferViewSchema>;
export type RecoveryCaseView = z.infer<typeof RecoveryCaseViewSchema>;
export type AdminRecoveryCaseView = z.infer<typeof AdminRecoveryCaseViewSchema>;
