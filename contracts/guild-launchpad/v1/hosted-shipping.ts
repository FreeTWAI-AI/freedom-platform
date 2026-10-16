import {z} from 'zod';
import {OpaqueId,Version} from './primitives.js';
import {IsoTimeSchema} from './tenant.js';
import {MeetupNoteSchema,ShippingMethodRefSchema} from './hosted-checkout.js';

export const LogisticsServiceKeySchema=z.enum(['ecpay.logistics.home.tcat','ecpay.logistics.home.post','ecpay.logistics.cvs.unimartc2c','ecpay.logistics.cvs.famic2c','ecpay.logistics.cvs.hilifec2c']);
export const LogisticsDeliveryMethodSchema=z.enum(['home','cvs:UNIMARTC2C','cvs:FAMIC2C','cvs:HILIFEC2C']);
export const DeliveryMethodSchema=ShippingMethodRefSchema;
export const DELIVERY_METHOD_LABELS={home:'宅配','cvs:UNIMARTC2C':'7-ELEVEN 取貨','cvs:FAMIC2C':'全家取貨','cvs:HILIFEC2C':'萊爾富取貨',meetup:'面交取貨'} as const;
const integer=(max:number)=>z.number().int().min(1).max(max);
const minor=(max:number)=>z.number().int().min(0).max(max).multipleOf(100);
export const ShippingEmptyInputSchema=z.object({}).strict();
export const ShipFromLocationInputSchema=z.object({label:z.string().min(1).max(80),sender_name:z.string().min(1).max(40),mobile:z.string().min(1).max(20),postal_code:z.string().min(1).max(10),address:z.string().min(1).max(120),ships:z.boolean(),receives_returns:z.boolean(),replaces_location_id:OpaqueId.optional()}).strict();
export const ShipFromLocationSchema=ShipFromLocationInputSchema.omit({replaces_location_id:true}).extend({location_id:OpaqueId,replaces_location_id:OpaqueId.nullable(),in_use:z.boolean(),created_at:IsoTimeSchema,retired_at:IsoTimeSchema.nullable()}).strict();
export const ShipFromLocationPageSchema=z.object({items:z.array(ShipFromLocationSchema).max(20)}).strict();
export const ShipFromLocationRetireInputSchema=ShippingEmptyInputSchema;
export const ParcelLimitsSchema=z.object({max_weight_g:integer(1_000_000),max_longest_side_mm:integer(10_000),max_dimension_sum_mm:integer(30_000)}).strict();
export const ProfileServiceSchema=z.object({service_key:LogisticsServiceKeySchema,ship_from_location_id:OpaqueId,temperature:z.literal('ambient'),handling_days:integer(14),cutoff_time:z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$(?![\s\S])/),limits:ParcelLimitsSchema,outlying_islands:z.enum(['allowed','excluded'])}).strict();
const logisticsDeliveryOption=z.object({method:LogisticsDeliveryMethodSchema,fee_per_parcel_minor:minor(1_000_000),free_over_minor:minor(1_000_000_000).min(100).nullable(),outlying:z.discriminatedUnion('kind',[z.object({kind:z.literal('excluded')}).strict(),z.object({kind:z.literal('surcharge'),surcharge_per_parcel_minor:minor(1_000_000)}).strict()])}).strict();
export const MeetupDeliveryOptionSchema=z.object({method:z.literal('meetup'),note:MeetupNoteSchema}).strict();
export const DeliveryOptionSchema=z.discriminatedUnion('method',[logisticsDeliveryOption,MeetupDeliveryOptionSchema]);
export const DropShipFeeSchema=z.object({service_key:LogisticsServiceKeySchema,fee_per_parcel_minor:minor(1_000_000)}).strict();
// The surrogate-pair expression counts Unicode code points in both JS and JSON Schema.
const liability=z.string().trim().regex(/^(?:[^\uD800-\uDFFF]|[\uD800-\uDBFF][\uDC00-\uDFFF]){1,1000}$(?![\s\S])/).regex(/^[^\u0000-\u0009\u000B-\u001F\u007F-\u009F]*$(?![\s\S])/);
export const DropShipSchema=z.object({offered:z.boolean(),fees:z.array(DropShipFeeSchema).max(5),return_location_id:OpaqueId,liability,recipient_retention_days:integer(30),accept_within_hours:integer(72)}).strict();
export const ShippingProfileDocumentSchema=z.object({schema:z.literal('freedom.shipping-profile/v1'),working_days:z.array(integer(7)).min(1).max(7),services:z.array(ProfileServiceSchema).max(5),delivery_options:z.array(DeliveryOptionSchema).max(5),drop_ship:DropShipSchema.nullable()}).strict();
export const ShippingProfileInputSchema=ShippingProfileDocumentSchema;
export const LogisticsAvailabilitySchema=z.object({service_key:LogisticsServiceKeySchema,state:z.enum(['active','suspended','draft','not_configured'])}).strict();
export const ShippingProfileViewSchema=z.object({version:Version.nullable(),profile:ShippingProfileDocumentSchema.nullable(),saved_at:IsoTimeSchema.nullable(),environment:z.enum(['sandbox','live']),logistics:z.tuple([
  LogisticsAvailabilitySchema.extend({service_key:z.literal('ecpay.logistics.home.tcat')}).strict(),
  LogisticsAvailabilitySchema.extend({service_key:z.literal('ecpay.logistics.home.post')}).strict(),
  LogisticsAvailabilitySchema.extend({service_key:z.literal('ecpay.logistics.cvs.unimartc2c')}).strict(),
  LogisticsAvailabilitySchema.extend({service_key:z.literal('ecpay.logistics.cvs.famic2c')}).strict(),
  LogisticsAvailabilitySchema.extend({service_key:z.literal('ecpay.logistics.cvs.hilifec2c')}).strict(),
])}).strict();
export const ItemShippingAttributesInputSchema=z.object({weight_g:integer(1_000_000),length_mm:integer(10_000),width_mm:integer(10_000),height_mm:integer(10_000),temperature:z.enum(['ambient','chilled','frozen']),cvs_allowed:z.boolean(),ship_alone:z.boolean(),max_per_parcel:integer(999).nullable()}).strict();
export const ItemShippingAttributesSchema=z.object({product_id:OpaqueId,version:Version.nullable(),attributes:ItemShippingAttributesInputSchema.nullable(),updated_at:IsoTimeSchema.nullable()}).strict();
export const ShippingFieldErrorCodeSchema=z.enum(['required','format','too_short','too_long','unknown_postal_code','blocked_term','duplicate','post_mainland_only','not_in_services','fees_required','not_found','retired','role_required','not_activated']);
export const ShippingFieldErrorSchema=z.object({path:z.string().max(80).regex(/^[a-z_]+(\.([0-9]{1,2}|[a-z_]+))*$(?![\s\S])/),code:ShippingFieldErrorCodeSchema}).strict();
/** Documented errors; domain authorization remains authoritative. */
export const ShippingErrorCodeSchema=z.enum(['shipping_input_invalid','ship_from_location_not_found','ship_from_location_retired','ship_from_location_limit','ship_from_location_role_required','ship_from_location_in_use','ship_from_location_unavailable','logistics_service_unavailable','not_found','tenant_not_found','capability_denied','tenant_capability_denied','storefront_unavailable','storefront_not_set_up','validation_failed','invalid_json','invalid_command_json','origin_rejected','host_rejected','json_required','body_too_large','login_required','csrf_rejected','onboarding_required','scope_kind_unavailable','foundation_mapping_unavailable','tenant_context_unavailable','resource_not_found','invalid_query','idempotency_required','idempotency_conflict','version_required','invalid_version','version_conflict','session_expired','principal_disabled','scope_disabled','internal_error']);
export const ShippingErrorSchema=z.object({type:z.literal('about:blank'),title:z.string(),status:z.number().int().min(400).max(599),code:ShippingErrorCodeSchema,detail:z.string(),fields:z.array(ShippingFieldErrorSchema).min(1).max(20).optional()}).strict();
const deliveryText=(max:number)=>z.string().max(max);
const cvsCheckout=z.object({name:deliveryText(40),mobile:deliveryText(20)}).strict();
/** Buyer delivery stored unchanged. Structural UTF-16 bounds; recipient rules run after this parse. */
export const CheckoutDeliveryInputSchema=z.discriminatedUnion('method',[
  z.object({method:z.literal('home'),name:deliveryText(40),mobile:deliveryText(20),postal_code:deliveryText(10),address:deliveryText(120)}).strict(),
  cvsCheckout.extend({method:z.literal('cvs:UNIMARTC2C')}),
  cvsCheckout.extend({method:z.literal('cvs:FAMIC2C')}),
  cvsCheckout.extend({method:z.literal('cvs:HILIFEC2C')}),
  cvsCheckout.extend({method:z.literal('meetup')}),
]);
export const CartDeliveryInputSchema=z.discriminatedUnion('method',[
  z.object({method:z.literal('home'),postal_code:z.string().max(10).optional()}).strict(),
  z.object({method:z.literal('cvs:UNIMARTC2C')}).strict(),
  z.object({method:z.literal('cvs:FAMIC2C')}).strict(),
  z.object({method:z.literal('cvs:HILIFEC2C')}).strict(),
  z.object({method:z.literal('meetup')}).strict(),
]);
