import { FulfilmentRuleError } from './errors.js';

export const SERVICE_KEYS = [
  'ecpay.logistics.home.tcat',
  'ecpay.logistics.home.post',
  'ecpay.logistics.cvs.unimartc2c',
  'ecpay.logistics.cvs.famic2c',
  'ecpay.logistics.cvs.hilifec2c',
] as const;

export const DELIVERY_METHODS = [
  'home',
  'cvs:UNIMARTC2C',
  'cvs:FAMIC2C',
  'cvs:HILIFEC2C',
] as const;

export const UNAVAILABLE_REASONS = [
  'fulfilment_not_agreed',
  'shipping_attributes_missing',
  'method_unsupported',
  'temperature_unsupported',
  'too_large',
  'cvs_value_limit',
  'outlying_unsupported',
] as const;

export const TEMPERATURES = ['ambient', 'chilled', 'frozen'] as const;

export type ServiceKey = (typeof SERVICE_KEYS)[number];
export type DeliveryMethod = (typeof DELIVERY_METHODS)[number];
export type UnavailableReason = (typeof UNAVAILABLE_REASONS)[number];
export type Temperature = (typeof TEMPERATURES)[number];
export type LogisticsSubType = 'TCAT' | 'POST' | 'UNIMARTC2C' | 'FAMIC2C' | 'HILIFEC2C';

export const CVS_PARCEL_VALUE_MAX_MINOR = 2_000_000;
export const POST_MAX_WEIGHT_G = 20_000;

export function methodOfService(key: ServiceKey | string): DeliveryMethod {
  switch (key) {
    case 'ecpay.logistics.home.tcat':
    case 'ecpay.logistics.home.post':
      return 'home';
    case 'ecpay.logistics.cvs.unimartc2c':
      return 'cvs:UNIMARTC2C';
    case 'ecpay.logistics.cvs.famic2c':
      return 'cvs:FAMIC2C';
    case 'ecpay.logistics.cvs.hilifec2c':
      return 'cvs:HILIFEC2C';
    default:
      throw new FulfilmentRuleError();
  }
}

export function logisticsSubTypeOfService(key: ServiceKey | string): LogisticsSubType {
  switch (key) {
    case 'ecpay.logistics.home.tcat':
      return 'TCAT';
    case 'ecpay.logistics.home.post':
      return 'POST';
    case 'ecpay.logistics.cvs.unimartc2c':
      return 'UNIMARTC2C';
    case 'ecpay.logistics.cvs.famic2c':
      return 'FAMIC2C';
    case 'ecpay.logistics.cvs.hilifec2c':
      return 'HILIFEC2C';
    default:
      throw new FulfilmentRuleError();
  }
}

export interface ItemShippingAttributes {
  readonly weight_g: number;                       // integer 1..1_000_000
  readonly length_mm: number;
  readonly width_mm: number;
  readonly height_mm: number;                      // integers 1..10_000
  readonly temperature: 'ambient' | 'chilled' | 'frozen';
  readonly cvs_allowed: boolean;
  readonly ship_alone: boolean;                    // needs its own box
  readonly max_per_parcel: number | null;          // integer 1..999, max units of this item per box
}

export interface ParcelLimits {
  readonly max_weight_g: number;
  readonly max_longest_side_mm: number;
  readonly max_dimension_sum_mm: number;
} // integers ≥ 1

export interface ProfileService {
  readonly service_key: ServiceKey;
  readonly ship_from_location_id: string;          // non-empty, ≤ 80 chars
  readonly temperature: 'ambient';                 // C2 has ambient only (spec §2.3): anything else → invalid_input
  readonly handling_days: number;                  // integer 1..14
  readonly cutoff_time: string;                    // ^([01][0-9]|2[0-3]):[0-5][0-9]$ (Asia/Taipei)
  readonly limits: ParcelLimits;
  readonly outlying_islands: 'allowed' | 'excluded';
}

export interface ShippingProfile {
  readonly shop_id: string;
  readonly version: string;                        // non-empty, ≤ 80 chars
  readonly working_days: readonly number[];        // ISO weekdays 1..7, unique, at least one
  readonly services: readonly ProfileService[];    // only services that are `active`; unique service_key; order = preference
}

export interface DeliveryOption {                  // the seller's buyer-facing options (spec §2.4)
  readonly method: DeliveryMethod;                 // unique within the list
  readonly fee_per_parcel_minor: number;           // ≥ 0, multiple of 100
  readonly free_over_minor: number | null;         // > 0, multiple of 100
  readonly outlying:
    | { readonly kind: 'excluded' }
    | { readonly kind: 'surcharge'; readonly surcharge_per_parcel_minor: number }; // ≥ 0, multiple of 100
}

export type QuoteLineFulfilment =
  | { readonly kind: 'self' }
  | {
      readonly kind: 'drop_ship';
      readonly executor_shop_id: string;
      readonly agreement_id: string;
      readonly agreement_version: string;
      readonly service_keys: readonly ServiceKey[];
    }
  | { readonly kind: 'not_agreed' };

export interface QuoteLine {
  readonly line_ref: string;                       // non-empty, ≤ 80 chars, unique
  readonly quantity: number;                       // integer 1..99
  readonly unit_price_minor: number;               // non-negative safe integer; declared value per unit (CVS value limit)
  readonly attributes: ItemShippingAttributes | null;
  readonly fulfilment: QuoteLineFulfilment;
}

export interface PlanInput {
  readonly seller_shop_id: string;
  readonly delivery_options: readonly DeliveryOption[];         // 0..10
  readonly profiles: Readonly<Record<string, ShippingProfile>>; // by shop_id; key must equal profile.shop_id
  readonly lines: readonly QuoteLine[];                         // 1..50
  readonly merchandise_net_minor: number;                       // after discounts, non-negative safe integer (free_over)
  readonly destination: { readonly outlying: boolean };         // cart quotes before an address pass false
}

export interface DeliveryParcelLine {
  readonly line_ref: string;
  readonly quantity: number;
}

export interface DeliveryParcel {
  readonly parcel_ref: string;                     // '<group_ref>-p<n>'
  readonly lines: readonly DeliveryParcelLine[];   // line input order
  readonly weight_g: number;
  readonly declared_value_minor: number;           // Σ unit prices
}

export interface DeliveryGroup {
  readonly group_ref: string;
  readonly executor_shop_id: string;
  readonly fulfilment_mode: 'self' | 'drop_ship';
  readonly agreement_id: string | null;
  readonly agreement_version: string | null;
  readonly profile_version: string;
  readonly service_key: ServiceKey;
  readonly logistics_sub_type: LogisticsSubType;
  readonly ship_from_location_id: string;
  readonly temperature: 'ambient';
  readonly handling_days: number;
  readonly cutoff_time: string;
  readonly working_days: readonly number[];
  readonly parcels: readonly DeliveryParcel[];
  readonly fee_per_parcel_minor: number;
  readonly outlying_surcharge_per_parcel_minor: number;
  readonly shipping_minor: number;
}

export type PlanDeliveryResult =
  | {
      readonly kind: 'plan';
      readonly method: DeliveryMethod;
      readonly groups: readonly DeliveryGroup[];
      readonly shipping_total_minor: number;
    }
  | {
      readonly kind: 'unavailable';
      readonly method: DeliveryMethod;
      readonly lines: readonly { readonly line_ref: string; readonly reason: UnavailableReason }[];
    };

export interface AvailableMethodOption {
  readonly method: DeliveryMethod;
  readonly result: PlanDeliveryResult;
}
