import {z} from 'zod';
import {OpaqueId,Version} from './primitives.js';
export const CommerceSetupEmptyInputSchema=z.object({}).strict();
const release=z.object({module_release_ref:z.string().min(1).max(200),application_release_ref:z.string().min(1).max(200)}).strict();
export const StoreReleaseSchema=release.extend({version:Version,capabilities:z.array(z.string()).max(100),upgrade:release.nullable(),can_upgrade:z.boolean()}).strict();
import {IsoTimeSchema} from './tenant.js';
export const ProviderEnvironmentSchema=z.enum(['sandbox','live']);
export const ProviderPurposeSchema=z.enum(['payment','logistics','invoice']);
export const ProviderProfileSchema=z.enum(['ecpay.aio.credit.v1','ecpay.logistics.domestic.v1','ecpay.invoice.b2c.v1']);
export const ProviderServiceStateSchema=z.enum(['draft','active','suspended','retired']);
const fresh={fresh_auth_verification_id:OpaqueId};
export const ProviderAccountCreateInputSchema=z.object({provider:z.literal('ecpay'),environment:ProviderEnvironmentSchema,merchant_id:z.string().regex(/^[0-9]{7,10}$/),...fresh}).strict();
export const ProviderServicePutInputSchema=z.object({profile:ProviderProfileSchema,hash_key:z.string().regex(/^[A-Za-z0-9]{16}$/),hash_iv:z.string().regex(/^[A-Za-z0-9]{16}$/),credit_check_code:z.string().regex(/^[0-9]{8}$/).optional(),...fresh}).strict();
export const ProviderServiceStateInputSchema=z.object(fresh).strict();
export const ProviderServiceViewSchema=z.object({purpose:ProviderPurposeSchema,profile:ProviderProfileSchema,state:ProviderServiceStateSchema,
  credential_version:z.number().int().min(1),credential_updated_at:IsoTimeSchema,activated_at:IsoTimeSchema.nullable(),throttled_until:IsoTimeSchema.nullable()}).strict();
export const ProviderAccountViewSchema=z.object({account_id:OpaqueId,provider:z.literal('ecpay'),environment:ProviderEnvironmentSchema,
  merchant_id:z.string().regex(/^[0-9]{7,10}$/),version:Version,created_at:IsoTimeSchema,services:z.array(ProviderServiceViewSchema).max(3)}).strict();
export const ProviderAccountPageSchema=z.object({items:z.array(ProviderAccountViewSchema)}).strict();
