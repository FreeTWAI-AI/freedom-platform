import {z} from 'zod';
import {OpaqueId,Version} from './primitives.js';
import {IsoTimeSchema} from './tenant.js';
import {checkoutTextPattern} from './hosted-checkout.js';

const text=z.string().regex(checkoutTextPattern);
const looseInt=z.number().int();
const bankInput=z.object({bank_code:z.string(),bank_name:z.string(),branch_name:z.string().optional(),account_number:z.string(),account_name:z.string(),deadline_days:looseInt.optional(),note:z.string().optional()}).strict();
const meetupInput=z.object({deadline_days:looseInt.optional()}).strict();
/**
 * Request command metadata. `fresh_auth_verification_id` is required beside the settings blocks and is not part of the
 * versioned document stored in commerce_offline_payment_settings or projected on the view.
 */
export const OfflinePaymentSettingsInputSchema=z.object({schema:z.literal('freedom.offline-payment-settings/v1'),bank_transfer:bankInput.nullable(),cash_on_meetup:meetupInput.nullable(),fresh_auth_verification_id:OpaqueId}).strict();
const bankView=z.object({bank_code:z.string().regex(/^[0-9]{3}$(?![\s\S])/),bank_name:text.min(1).max(20),branch_name:text.min(1).max(20).nullable(),
  account_number:z.string().regex(/^[0-9]{6,16}$(?![\s\S])/).nullable(),account_number_last4:z.string().regex(/^[0-9]{4}$(?![\s\S])/),account_name:text.min(1).max(40),
  deadline_days:z.number().int().min(1).max(7),note:text.min(1).max(200).nullable()}).strict();
const meetupView=z.object({deadline_days:z.number().int().min(1).max(14)}).strict();
export const OfflinePaymentSettingsViewSchema=z.object({version:Version.nullable(),saved_at:IsoTimeSchema.nullable(),account_visibility:z.enum(['full','last4']),
  host_profiles:z.object({bank_transfer:z.boolean(),cash_on_meetup:z.boolean()}).strict(),
  settings:z.object({bank_transfer:bankView.nullable(),cash_on_meetup:meetupView.nullable()}).strict().nullable()}).strict()
  .refine(v=>(v.version===null)===(v.saved_at===null)&&(v.version===null)===(v.settings===null),'Version, saved time and settings are absent together.')
  .refine(v=>v.settings?.bank_transfer==null||(v.settings.bank_transfer.account_number===null)===(v.account_visibility==='last4'),'Account number is null exactly when visibility is last4.');
export const OfflineSettingsFieldErrorCodeSchema=z.enum(['required','format','too_short','too_long','out_of_range']);
export const OfflineSettingsFieldErrorSchema=z.object({path:z.string().max(80).regex(/^[a-z_]+(\.([0-9]{1,2}|[a-z_]+))*$(?![\s\S])/),code:OfflineSettingsFieldErrorCodeSchema}).strict();
/** Documented errors; domain authorization remains authoritative. */
export const OfflineSettingsErrorCodeSchema=z.enum(['offline_settings_invalid','fresh_auth_required','not_found','tenant_not_found','capability_denied','tenant_capability_denied','storefront_unavailable','storefront_not_set_up','validation_failed','invalid_json','invalid_command_json','origin_rejected','host_rejected','json_required','body_too_large','login_required','csrf_rejected','onboarding_required','scope_kind_unavailable','foundation_mapping_unavailable','tenant_context_unavailable','resource_not_found','invalid_query','idempotency_required','idempotency_conflict','version_required','invalid_version','version_conflict','session_expired','principal_disabled','scope_disabled','internal_error']);
export const OfflineSettingsErrorSchema=z.object({type:z.literal('about:blank'),title:z.string(),status:z.number().int().min(400).max(599),code:OfflineSettingsErrorCodeSchema,detail:z.string(),fields:z.array(OfflineSettingsFieldErrorSchema).min(1).max(20).optional()}).strict();
