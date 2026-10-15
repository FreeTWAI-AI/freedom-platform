import { FulfilmentRuleError, deepFreeze } from './errors.js';

export type ShipmentState =
  | 'draft'
  | 'creating'
  | 'create_unknown'
  | 'create_failed'
  | 'created'
  | 'handed_over'
  | 'in_transit'
  | 'ready_for_pickup'
  | 'delivered'
  | 'returning'
  | 'returned'
  | 'voided';

export const SHIPMENT_STATE_ORDER: Readonly<Record<ShipmentState, number | null>> = Object.freeze({
  draft: 0,
  creating: 1,
  create_unknown: 1,
  create_failed: 1,
  created: 2,
  handed_over: 3,
  in_transit: 4,
  ready_for_pickup: 5,
  delivered: 6,
  returning: 7,
  returned: 8,
  voided: null,
});

export const ALL_SHIPMENT_STATES: readonly ShipmentState[] = Object.freeze([
  'draft',
  'creating',
  'create_unknown',
  'create_failed',
  'created',
  'handed_over',
  'in_transit',
  'ready_for_pickup',
  'delivered',
  'returning',
  'returned',
  'voided',
]);

export const VALID_INCOMING_STATES: readonly ShipmentState[] = Object.freeze([
  'created',
  'handed_over',
  'in_transit',
  'ready_for_pickup',
  'delivered',
  'returning',
  'returned',
]);

const FORWARD_STATES: readonly ShipmentState[] = Object.freeze([
  'created',
  'handed_over',
  'in_transit',
  'ready_for_pickup',
  'delivered',
]);

const RETURN_STATES: readonly ShipmentState[] = Object.freeze(['returning', 'returned']);

export type TrackingExceptionKind =
  | 'pickup_store_closed'
  | 'recipient_address_invalid'
  | 'uncollected'
  | 'lost'
  | 'damaged'
  | 'contradicting_event'
  | 'carrier_attention';

export type LogisticsStatusResult =
  | {
      readonly kind: 'progress';
      readonly state:
        | 'created'
        | 'handed_over'
        | 'in_transit'
        | 'ready_for_pickup'
        | 'delivered'
        | 'returning'
        | 'returned';
      readonly exception: 'uncollected' | 'damaged' | null;
    }
  | { readonly kind: 'exception'; readonly exception: TrackingExceptionKind }
  | { readonly kind: 'informational' }
  | { readonly kind: 'ops_review' }
  | { readonly kind: 'unmapped' };

export interface RawStatusEntry {
  readonly sub_type: string;
  readonly code: string;
  readonly effect: 'progress' | 'exception' | 'informational' | 'ops_review';
  readonly state: 'created' | 'handed_over' | 'in_transit' | 'ready_for_pickup' | 'delivered' | 'returning' | 'returned' | null;
  readonly exception: TrackingExceptionKind | null;
}

export const ECPAY_LOGISTICS_STATUS_TABLE: readonly RawStatusEntry[] = deepFreeze([
  { sub_type: 'UNIMARTC2C', code: '300', effect: 'progress', state: 'created', exception: null },
  { sub_type: 'UNIMARTC2C', code: '2030', effect: 'progress', state: 'in_transit', exception: null },
  { sub_type: 'UNIMARTC2C', code: '2041', effect: 'progress', state: 'in_transit', exception: null },
  { sub_type: 'UNIMARTC2C', code: '2042', effect: 'exception', state: null, exception: 'lost' },
  { sub_type: 'UNIMARTC2C', code: '2043', effect: 'progress', state: 'in_transit', exception: null },
  { sub_type: 'UNIMARTC2C', code: '2048', effect: 'exception', state: null, exception: 'carrier_attention' },
  { sub_type: 'UNIMARTC2C', code: '2051', effect: 'progress', state: 'returning', exception: null },
  { sub_type: 'UNIMARTC2C', code: '2053', effect: 'progress', state: 'returning', exception: null },
  { sub_type: 'UNIMARTC2C', code: '2058', effect: 'progress', state: 'in_transit', exception: null },
  { sub_type: 'UNIMARTC2C', code: '2061', effect: 'exception', state: null, exception: 'carrier_attention' },
  { sub_type: 'UNIMARTC2C', code: '2062', effect: 'informational', state: null, exception: null },
  { sub_type: 'UNIMARTC2C', code: '2066', effect: 'exception', state: null, exception: 'carrier_attention' },
  { sub_type: 'UNIMARTC2C', code: '2067', effect: 'progress', state: 'delivered', exception: null },
  { sub_type: 'UNIMARTC2C', code: '2068', effect: 'progress', state: 'handed_over', exception: null },
  { sub_type: 'UNIMARTC2C', code: '2069', effect: 'ops_review', state: null, exception: null },
  { sub_type: 'UNIMARTC2C', code: '2070', effect: 'progress', state: 'returned', exception: null },
  { sub_type: 'UNIMARTC2C', code: '2072', effect: 'progress', state: 'returned', exception: null },
  { sub_type: 'UNIMARTC2C', code: '2073', effect: 'progress', state: 'ready_for_pickup', exception: null },
  { sub_type: 'UNIMARTC2C', code: '2074', effect: 'progress', state: 'returning', exception: 'uncollected' },
  { sub_type: 'UNIMARTC2C', code: '2075', effect: 'exception', state: null, exception: 'carrier_attention' },
  { sub_type: 'UNIMARTC2C', code: '2076', effect: 'progress', state: 'returning', exception: 'uncollected' },
  { sub_type: 'UNIMARTC2C', code: '2077', effect: 'exception', state: null, exception: 'carrier_attention' },
  { sub_type: 'UNIMARTC2C', code: '2078', effect: 'progress', state: 'returning', exception: 'uncollected' },
  { sub_type: 'UNIMARTC2C', code: '2079', effect: 'progress', state: 'returning', exception: null },
  { sub_type: 'UNIMARTC2C', code: '2080', effect: 'progress', state: 'returning', exception: null },
  { sub_type: 'UNIMARTC2C', code: '2081', effect: 'progress', state: 'returning', exception: null },
  { sub_type: 'UNIMARTC2C', code: '2082', effect: 'progress', state: 'returning', exception: null },
  { sub_type: 'UNIMARTC2C', code: '2083', effect: 'progress', state: 'returning', exception: null },
  { sub_type: 'UNIMARTC2C', code: '2084', effect: 'progress', state: 'returning', exception: null },
  { sub_type: 'UNIMARTC2C', code: '2085', effect: 'progress', state: 'returning', exception: null },
  { sub_type: 'UNIMARTC2C', code: '2086', effect: 'progress', state: 'returning', exception: null },
  { sub_type: 'UNIMARTC2C', code: '2087', effect: 'progress', state: 'returning', exception: null },
  { sub_type: 'UNIMARTC2C', code: '2088', effect: 'exception', state: null, exception: 'lost' },
  { sub_type: 'UNIMARTC2C', code: '2089', effect: 'exception', state: null, exception: 'carrier_attention' },
  { sub_type: 'UNIMARTC2C', code: '2092', effect: 'exception', state: null, exception: 'pickup_store_closed' },
  { sub_type: 'UNIMARTC2C', code: '2093', effect: 'exception', state: null, exception: 'carrier_attention' },
  { sub_type: 'UNIMARTC2C', code: '2094', effect: 'exception', state: null, exception: 'carrier_attention' },
  { sub_type: 'UNIMARTC2C', code: '2096', effect: 'exception', state: null, exception: 'carrier_attention' },
  { sub_type: 'UNIMARTC2C', code: '2097', effect: 'progress', state: 'returning', exception: null },
  { sub_type: 'UNIMARTC2C', code: '2098', effect: 'progress', state: 'ready_for_pickup', exception: null },
  { sub_type: 'UNIMARTC2C', code: '2099', effect: 'progress', state: 'returned', exception: null },
  { sub_type: 'UNIMARTC2C', code: '2101', effect: 'exception', state: null, exception: 'pickup_store_closed' },
  { sub_type: 'UNIMARTC2C', code: '2102', effect: 'informational', state: null, exception: null },
  { sub_type: 'UNIMARTC2C', code: '2103', effect: 'exception', state: null, exception: 'pickup_store_closed' },
  { sub_type: 'UNIMARTC2C', code: '2104', effect: 'exception', state: null, exception: 'pickup_store_closed' },
  { sub_type: 'UNIMARTC2C', code: '2105', effect: 'informational', state: null, exception: null },
  { sub_type: 'UNIMARTC2C', code: '7013', effect: 'exception', state: null, exception: 'carrier_attention' },
  { sub_type: 'UNIMARTC2C', code: '7017', effect: 'exception', state: null, exception: 'carrier_attention' },
  { sub_type: 'UNIMARTC2C', code: '7018', effect: 'exception', state: null, exception: 'lost' },
  { sub_type: 'UNIMARTC2C', code: '7019', effect: 'exception', state: null, exception: 'carrier_attention' },
  { sub_type: 'UNIMARTC2C', code: '7020', effect: 'exception', state: null, exception: 'lost' },
  { sub_type: 'UNIMARTC2C', code: '7038', effect: 'exception', state: null, exception: 'carrier_attention' },
  { sub_type: 'UNIMARTC2C', code: '9999', effect: 'exception', state: null, exception: 'carrier_attention' },
  { sub_type: 'FAMIC2C', code: '300', effect: 'progress', state: 'created', exception: null },
  { sub_type: 'FAMIC2C', code: '310', effect: 'progress', state: 'created', exception: null },
  { sub_type: 'FAMIC2C', code: '2105', effect: 'informational', state: null, exception: null },
  { sub_type: 'FAMIC2C', code: '3018', effect: 'progress', state: 'ready_for_pickup', exception: null },
  { sub_type: 'FAMIC2C', code: '3019', effect: 'progress', state: 'returned', exception: null },
  { sub_type: 'FAMIC2C', code: '3020', effect: 'progress', state: 'returning', exception: 'uncollected' },
  { sub_type: 'FAMIC2C', code: '3021', effect: 'exception', state: null, exception: 'carrier_attention' },
  { sub_type: 'FAMIC2C', code: '3022', effect: 'progress', state: 'delivered', exception: null },
  { sub_type: 'FAMIC2C', code: '3023', effect: 'progress', state: 'returned', exception: null },
  { sub_type: 'FAMIC2C', code: '3024', effect: 'progress', state: 'in_transit', exception: null },
  { sub_type: 'FAMIC2C', code: '3025', effect: 'progress', state: 'returning', exception: 'uncollected' },
  { sub_type: 'FAMIC2C', code: '3029', effect: 'progress', state: 'ready_for_pickup', exception: null },
  { sub_type: 'FAMIC2C', code: '3031', effect: 'progress', state: 'returned', exception: null },
  { sub_type: 'FAMIC2C', code: '3032', effect: 'progress', state: 'handed_over', exception: null },
  { sub_type: 'FAMIC2C', code: '4001', effect: 'ops_review', state: null, exception: null },
  { sub_type: 'FAMIC2C', code: '4002', effect: 'ops_review', state: null, exception: null },
  { sub_type: 'FAMIC2C', code: '5009', effect: 'exception', state: null, exception: 'carrier_attention' },
  { sub_type: 'FAMIC2C', code: '7006', effect: 'exception', state: null, exception: 'lost' },
  { sub_type: 'FAMIC2C', code: '7007', effect: 'exception', state: null, exception: 'lost' },
  { sub_type: 'FAMIC2C', code: '7008', effect: 'exception', state: null, exception: 'damaged' },
  { sub_type: 'FAMIC2C', code: '7009', effect: 'exception', state: null, exception: 'carrier_attention' },
  { sub_type: 'FAMIC2C', code: '7010', effect: 'exception', state: null, exception: 'carrier_attention' },
  { sub_type: 'FAMIC2C', code: '7011', effect: 'exception', state: null, exception: 'pickup_store_closed' },
  { sub_type: 'FAMIC2C', code: '7012', effect: 'progress', state: 'returning', exception: null },
  { sub_type: 'FAMIC2C', code: '7013', effect: 'exception', state: null, exception: 'carrier_attention' },
  { sub_type: 'FAMIC2C', code: '7014', effect: 'progress', state: 'created', exception: null },
  { sub_type: 'FAMIC2C', code: '7015', effect: 'exception', state: null, exception: 'carrier_attention' },
  { sub_type: 'FAMIC2C', code: '7016', effect: 'progress', state: 'returning', exception: null },
  { sub_type: 'FAMIC2C', code: '7032', effect: 'exception', state: null, exception: 'carrier_attention' },
  { sub_type: 'FAMIC2C', code: '7034', effect: 'exception', state: null, exception: 'carrier_attention' },
  { sub_type: 'FAMIC2C', code: '7035', effect: 'exception', state: null, exception: 'carrier_attention' },
  { sub_type: 'FAMIC2C', code: '7036', effect: 'exception', state: null, exception: 'damaged' },
  { sub_type: 'HILIFEC2C', code: '300', effect: 'progress', state: 'created', exception: null },
  { sub_type: 'HILIFEC2C', code: '310', effect: 'progress', state: 'created', exception: null },
  { sub_type: 'HILIFEC2C', code: '311', effect: 'progress', state: 'created', exception: null },
  { sub_type: 'HILIFEC2C', code: '325', effect: 'ops_review', state: null, exception: null },
  { sub_type: 'HILIFEC2C', code: '2000', effect: 'informational', state: null, exception: null },
  { sub_type: 'HILIFEC2C', code: '2001', effect: 'progress', state: 'created', exception: null },
  { sub_type: 'HILIFEC2C', code: '2002', effect: 'exception', state: null, exception: 'carrier_attention' },
  { sub_type: 'HILIFEC2C', code: '2003', effect: 'exception', state: null, exception: 'carrier_attention' },
  { sub_type: 'HILIFEC2C', code: '2004', effect: 'exception', state: null, exception: 'carrier_attention' },
  { sub_type: 'HILIFEC2C', code: '2005', effect: 'exception', state: null, exception: 'carrier_attention' },
  { sub_type: 'HILIFEC2C', code: '2006', effect: 'exception', state: null, exception: 'carrier_attention' },
  { sub_type: 'HILIFEC2C', code: '2007', effect: 'exception', state: null, exception: 'carrier_attention' },
  { sub_type: 'HILIFEC2C', code: '2009', effect: 'exception', state: null, exception: 'carrier_attention' },
  { sub_type: 'HILIFEC2C', code: '2010', effect: 'exception', state: null, exception: 'carrier_attention' },
  { sub_type: 'HILIFEC2C', code: '2011', effect: 'exception', state: null, exception: 'carrier_attention' },
  { sub_type: 'HILIFEC2C', code: '2012', effect: 'exception', state: null, exception: 'carrier_attention' },
  { sub_type: 'HILIFEC2C', code: '2013', effect: 'exception', state: null, exception: 'carrier_attention' },
  { sub_type: 'HILIFEC2C', code: '2014', effect: 'exception', state: null, exception: 'carrier_attention' },
  { sub_type: 'HILIFEC2C', code: '2015', effect: 'exception', state: null, exception: 'carrier_attention' },
  { sub_type: 'HILIFEC2C', code: '2016', effect: 'progress', state: 'returning', exception: null },
  { sub_type: 'HILIFEC2C', code: '2017', effect: 'exception', state: null, exception: 'carrier_attention' },
  { sub_type: 'HILIFEC2C', code: '2018', effect: 'exception', state: null, exception: 'carrier_attention' },
  { sub_type: 'HILIFEC2C', code: '2019', effect: 'exception', state: null, exception: 'carrier_attention' },
  { sub_type: 'HILIFEC2C', code: '2020', effect: 'exception', state: null, exception: 'carrier_attention' },
  { sub_type: 'HILIFEC2C', code: '2021', effect: 'exception', state: null, exception: 'carrier_attention' },
  { sub_type: 'HILIFEC2C', code: '2022', effect: 'exception', state: null, exception: 'carrier_attention' },
  { sub_type: 'HILIFEC2C', code: '2023', effect: 'exception', state: null, exception: 'carrier_attention' },
  { sub_type: 'HILIFEC2C', code: '2024', effect: 'progress', state: 'created', exception: null },
  { sub_type: 'HILIFEC2C', code: '2025', effect: 'informational', state: null, exception: null },
  { sub_type: 'HILIFEC2C', code: '2026', effect: 'progress', state: 'returning', exception: null },
  { sub_type: 'HILIFEC2C', code: '2027', effect: 'progress', state: 'in_transit', exception: null },
  { sub_type: 'HILIFEC2C', code: '2028', effect: 'exception', state: null, exception: 'pickup_store_closed' },
  { sub_type: 'HILIFEC2C', code: '2029', effect: 'exception', state: null, exception: 'pickup_store_closed' },
  { sub_type: 'HILIFEC2C', code: '2030', effect: 'progress', state: 'in_transit', exception: null },
  { sub_type: 'HILIFEC2C', code: '2031', effect: 'progress', state: 'created', exception: null },
  { sub_type: 'HILIFEC2C', code: '2032', effect: 'exception', state: null, exception: 'carrier_attention' },
  { sub_type: 'HILIFEC2C', code: '2033', effect: 'progress', state: 'returning', exception: null },
  { sub_type: 'HILIFEC2C', code: '2034', effect: 'progress', state: 'returning', exception: null },
  { sub_type: 'HILIFEC2C', code: '2035', effect: 'exception', state: null, exception: 'carrier_attention' },
  { sub_type: 'HILIFEC2C', code: '2036', effect: 'exception', state: null, exception: 'carrier_attention' },
  { sub_type: 'HILIFEC2C', code: '2037', effect: 'exception', state: null, exception: 'pickup_store_closed' },
  { sub_type: 'HILIFEC2C', code: '2038', effect: 'progress', state: 'returning', exception: null },
  { sub_type: 'HILIFEC2C', code: '2039', effect: 'progress', state: 'returning', exception: null },
  { sub_type: 'HILIFEC2C', code: '2040', effect: 'progress', state: 'returning', exception: null },
  { sub_type: 'HILIFEC2C', code: '2041', effect: 'progress', state: 'in_transit', exception: null },
  { sub_type: 'HILIFEC2C', code: '2042', effect: 'exception', state: null, exception: 'lost' },
  { sub_type: 'HILIFEC2C', code: '2043', effect: 'progress', state: 'in_transit', exception: null },
  { sub_type: 'HILIFEC2C', code: '2045', effect: 'progress', state: 'returning', exception: null },
  { sub_type: 'HILIFEC2C', code: '2046', effect: 'progress', state: 'returning', exception: 'uncollected' },
  { sub_type: 'HILIFEC2C', code: '2047', effect: 'progress', state: 'returning', exception: null },
  { sub_type: 'HILIFEC2C', code: '2048', effect: 'exception', state: null, exception: 'carrier_attention' },
  { sub_type: 'HILIFEC2C', code: '2049', effect: 'progress', state: 'returning', exception: null },
  { sub_type: 'HILIFEC2C', code: '2050', effect: 'progress', state: 'returning', exception: null },
  { sub_type: 'HILIFEC2C', code: '2051', effect: 'progress', state: 'returning', exception: null },
  { sub_type: 'HILIFEC2C', code: '2052', effect: 'progress', state: 'returning', exception: null },
  { sub_type: 'HILIFEC2C', code: '2053', effect: 'progress', state: 'returning', exception: null },
  { sub_type: 'HILIFEC2C', code: '2054', effect: 'progress', state: 'returning', exception: null },
  { sub_type: 'HILIFEC2C', code: '2055', effect: 'progress', state: 'returning', exception: null },
  { sub_type: 'HILIFEC2C', code: '2057', effect: 'progress', state: 'in_transit', exception: null },
  { sub_type: 'HILIFEC2C', code: '2058', effect: 'progress', state: 'in_transit', exception: null },
  { sub_type: 'HILIFEC2C', code: '2059', effect: 'progress', state: 'in_transit', exception: null },
  { sub_type: 'HILIFEC2C', code: '2060', effect: 'progress', state: 'returning', exception: null },
  { sub_type: 'HILIFEC2C', code: '2061', effect: 'exception', state: null, exception: 'carrier_attention' },
  { sub_type: 'HILIFEC2C', code: '2062', effect: 'informational', state: null, exception: null },
  { sub_type: 'HILIFEC2C', code: '2063', effect: 'progress', state: 'ready_for_pickup', exception: null },
  { sub_type: 'HILIFEC2C', code: '2065', effect: 'progress', state: 'returning', exception: 'uncollected' },
  { sub_type: 'HILIFEC2C', code: '2066', effect: 'exception', state: null, exception: 'carrier_attention' },
  { sub_type: 'HILIFEC2C', code: '2067', effect: 'progress', state: 'delivered', exception: null },
  { sub_type: 'HILIFEC2C', code: '2068', effect: 'progress', state: 'handed_over', exception: null },
  { sub_type: 'HILIFEC2C', code: '2069', effect: 'ops_review', state: null, exception: null },
  { sub_type: 'HILIFEC2C', code: '2070', effect: 'progress', state: 'returned', exception: null },
  { sub_type: 'HILIFEC2C', code: '2071', effect: 'exception', state: null, exception: 'carrier_attention' },
  { sub_type: 'HILIFEC2C', code: '2072', effect: 'progress', state: 'returned', exception: null },
  { sub_type: 'HILIFEC2C', code: '2073', effect: 'progress', state: 'ready_for_pickup', exception: null },
  { sub_type: 'HILIFEC2C', code: '2074', effect: 'progress', state: 'returning', exception: 'uncollected' },
  { sub_type: 'HILIFEC2C', code: '2075', effect: 'exception', state: null, exception: 'carrier_attention' },
  { sub_type: 'HILIFEC2C', code: '2101', effect: 'exception', state: null, exception: 'pickup_store_closed' },
  { sub_type: 'HILIFEC2C', code: '2102', effect: 'informational', state: null, exception: null },
  { sub_type: 'HILIFEC2C', code: '2103', effect: 'exception', state: null, exception: 'pickup_store_closed' },
  { sub_type: 'HILIFEC2C', code: '2104', effect: 'exception', state: null, exception: 'pickup_store_closed' },
  { sub_type: 'HILIFEC2C', code: '2105', effect: 'informational', state: null, exception: null },
  { sub_type: 'HILIFEC2C', code: '3018', effect: 'progress', state: 'ready_for_pickup', exception: null },
  { sub_type: 'HILIFEC2C', code: '3019', effect: 'progress', state: 'returned', exception: null },
  { sub_type: 'HILIFEC2C', code: '3020', effect: 'progress', state: 'returning', exception: 'uncollected' },
  { sub_type: 'HILIFEC2C', code: '3021', effect: 'exception', state: null, exception: 'carrier_attention' },
  { sub_type: 'HILIFEC2C', code: '3022', effect: 'progress', state: 'delivered', exception: null },
  { sub_type: 'HILIFEC2C', code: '3023', effect: 'progress', state: 'returned', exception: null },
  { sub_type: 'HILIFEC2C', code: '3024', effect: 'progress', state: 'in_transit', exception: null },
  { sub_type: 'HILIFEC2C', code: '3025', effect: 'progress', state: 'returning', exception: 'uncollected' },
  { sub_type: 'HILIFEC2C', code: '3029', effect: 'progress', state: 'ready_for_pickup', exception: null },
  { sub_type: 'HILIFEC2C', code: '3031', effect: 'progress', state: 'returned', exception: null },
  { sub_type: 'HILIFEC2C', code: '3032', effect: 'progress', state: 'handed_over', exception: null },
  { sub_type: 'HILIFEC2C', code: '3033', effect: 'progress', state: 'returning', exception: null },
  { sub_type: 'HILIFEC2C', code: '4001', effect: 'ops_review', state: null, exception: null },
  { sub_type: 'HILIFEC2C', code: '4002', effect: 'ops_review', state: null, exception: null },
  { sub_type: 'HILIFEC2C', code: '5001', effect: 'progress', state: 'returning', exception: 'damaged' },
  { sub_type: 'HILIFEC2C', code: '5002', effect: 'exception', state: null, exception: 'lost' },
  { sub_type: 'HILIFEC2C', code: '5003', effect: 'exception', state: null, exception: 'carrier_attention' },
  { sub_type: 'HILIFEC2C', code: '5004', effect: 'exception', state: null, exception: 'carrier_attention' },
  { sub_type: 'HILIFEC2C', code: '5005', effect: 'progress', state: 'returning', exception: null },
  { sub_type: 'HILIFEC2C', code: '5006', effect: 'exception', state: null, exception: 'damaged' },
  { sub_type: 'HILIFEC2C', code: '5007', effect: 'exception', state: null, exception: 'lost' },
  { sub_type: 'HILIFEC2C', code: '5008', effect: 'progress', state: 'returned', exception: null },
  { sub_type: 'HILIFEC2C', code: '5009', effect: 'exception', state: null, exception: 'carrier_attention' },
  { sub_type: 'HILIFEC2C', code: '7001', effect: 'exception', state: null, exception: 'carrier_attention' },
  { sub_type: 'HILIFEC2C', code: '7002', effect: 'exception', state: null, exception: 'carrier_attention' },
  { sub_type: 'HILIFEC2C', code: '7003', effect: 'exception', state: null, exception: 'carrier_attention' },
  { sub_type: 'HILIFEC2C', code: '7004', effect: 'progress', state: 'in_transit', exception: null },
  { sub_type: 'HILIFEC2C', code: '7005', effect: 'exception', state: null, exception: 'carrier_attention' },
  { sub_type: 'HILIFEC2C', code: '7006', effect: 'exception', state: null, exception: 'lost' },
  { sub_type: 'HILIFEC2C', code: '7007', effect: 'exception', state: null, exception: 'lost' },
  { sub_type: 'HILIFEC2C', code: '7008', effect: 'exception', state: null, exception: 'damaged' },
  { sub_type: 'HILIFEC2C', code: '7009', effect: 'exception', state: null, exception: 'carrier_attention' },
  { sub_type: 'HILIFEC2C', code: '7010', effect: 'exception', state: null, exception: 'carrier_attention' },
  { sub_type: 'HILIFEC2C', code: '7011', effect: 'exception', state: null, exception: 'pickup_store_closed' },
  { sub_type: 'HILIFEC2C', code: '7012', effect: 'progress', state: 'returning', exception: null },
  { sub_type: 'HILIFEC2C', code: '7013', effect: 'exception', state: null, exception: 'carrier_attention' },
  { sub_type: 'HILIFEC2C', code: '7014', effect: 'progress', state: 'created', exception: null },
  { sub_type: 'HILIFEC2C', code: '7016', effect: 'progress', state: 'returning', exception: null },
  { sub_type: 'HILIFEC2C', code: '7032', effect: 'exception', state: null, exception: 'carrier_attention' },
  { sub_type: 'HILIFEC2C', code: '9001', effect: 'ops_review', state: null, exception: null },
  { sub_type: 'HILIFEC2C', code: '9002', effect: 'ops_review', state: null, exception: null },
  { sub_type: 'HILIFEC2C', code: '9999', effect: 'exception', state: null, exception: 'carrier_attention' },
  { sub_type: 'TCAT', code: '300', effect: 'progress', state: 'created', exception: null },
  { sub_type: 'TCAT', code: '310', effect: 'progress', state: 'created', exception: null },
  { sub_type: 'TCAT', code: '311', effect: 'progress', state: 'created', exception: null },
  { sub_type: 'TCAT', code: '325', effect: 'ops_review', state: null, exception: null },
  { sub_type: 'TCAT', code: '3001', effect: 'progress', state: 'in_transit', exception: null },
  { sub_type: 'TCAT', code: '3002', effect: 'progress', state: 'in_transit', exception: null },
  { sub_type: 'TCAT', code: '3003', effect: 'progress', state: 'delivered', exception: null },
  { sub_type: 'TCAT', code: '3004', effect: 'progress', state: 'in_transit', exception: null },
  { sub_type: 'TCAT', code: '3005', effect: 'progress', state: 'in_transit', exception: null },
  { sub_type: 'TCAT', code: '3006', effect: 'progress', state: 'in_transit', exception: null },
  { sub_type: 'TCAT', code: '3007', effect: 'progress', state: 'in_transit', exception: null },
  { sub_type: 'TCAT', code: '3008', effect: 'exception', state: null, exception: 'recipient_address_invalid' },
  { sub_type: 'TCAT', code: '3009', effect: 'exception', state: null, exception: 'recipient_address_invalid' },
  { sub_type: 'TCAT', code: '3010', effect: 'progress', state: 'in_transit', exception: null },
  { sub_type: 'TCAT', code: '3011', effect: 'progress', state: 'ready_for_pickup', exception: null },
  { sub_type: 'TCAT', code: '3012', effect: 'progress', state: 'ready_for_pickup', exception: null },
  { sub_type: 'TCAT', code: '3013', effect: 'progress', state: 'in_transit', exception: null },
  { sub_type: 'TCAT', code: '3014', effect: 'progress', state: 'in_transit', exception: null },
  { sub_type: 'TCAT', code: '3015', effect: 'progress', state: 'in_transit', exception: null },
  { sub_type: 'TCAT', code: '3016', effect: 'exception', state: null, exception: 'contradicting_event' },
  { sub_type: 'TCAT', code: '3017', effect: 'exception', state: null, exception: 'contradicting_event' },
  { sub_type: 'TCAT', code: '3117', effect: 'exception', state: null, exception: 'uncollected' },
  { sub_type: 'TCAT', code: '3118', effect: 'progress', state: 'in_transit', exception: null },
  { sub_type: 'TCAT', code: '3119', effect: 'progress', state: 'in_transit', exception: null },
  { sub_type: 'TCAT', code: '3120', effect: 'progress', state: 'in_transit', exception: null },
  { sub_type: 'TCAT', code: '3121', effect: 'progress', state: 'ready_for_pickup', exception: null },
  { sub_type: 'TCAT', code: '3122', effect: 'progress', state: 'in_transit', exception: null },
  { sub_type: 'TCAT', code: '3123', effect: 'progress', state: 'returning', exception: 'uncollected' },
  { sub_type: 'TCAT', code: '3124', effect: 'progress', state: 'returning', exception: null },
  { sub_type: 'TCAT', code: '3125', effect: 'progress', state: 'returning', exception: null },
  { sub_type: 'TCAT', code: '5001', effect: 'progress', state: 'returning', exception: 'damaged' },
  { sub_type: 'TCAT', code: '5002', effect: 'exception', state: null, exception: 'lost' },
  { sub_type: 'TCAT', code: '5003', effect: 'exception', state: null, exception: 'carrier_attention' },
  { sub_type: 'TCAT', code: '5004', effect: 'progress', state: 'returning', exception: null },
  { sub_type: 'TCAT', code: '5005', effect: 'progress', state: 'returning', exception: null },
  { sub_type: 'TCAT', code: '5006', effect: 'exception', state: null, exception: 'damaged' },
  { sub_type: 'TCAT', code: '5007', effect: 'exception', state: null, exception: 'lost' },
  { sub_type: 'TCAT', code: '5008', effect: 'progress', state: 'returned', exception: null },
  { sub_type: 'TCAT', code: '7001', effect: 'exception', state: null, exception: 'carrier_attention' },
  { sub_type: 'TCAT', code: '7002', effect: 'exception', state: null, exception: 'carrier_attention' },
  { sub_type: 'TCAT', code: '7003', effect: 'exception', state: null, exception: 'recipient_address_invalid' },
  { sub_type: 'TCAT', code: '7004', effect: 'progress', state: 'in_transit', exception: null },
  { sub_type: 'TCAT', code: '7005', effect: 'exception', state: null, exception: 'carrier_attention' },
  { sub_type: 'TCAT', code: '7024', effect: 'progress', state: 'in_transit', exception: null },
  { sub_type: 'TCAT', code: '7025', effect: 'exception', state: null, exception: 'carrier_attention' },
  { sub_type: 'TCAT', code: '7026', effect: 'exception', state: null, exception: 'carrier_attention' },
  { sub_type: 'TCAT', code: '7027', effect: 'exception', state: null, exception: 'carrier_attention' },
  { sub_type: 'TCAT', code: '7028', effect: 'exception', state: null, exception: 'carrier_attention' },
  { sub_type: 'TCAT', code: '7029', effect: 'ops_review', state: null, exception: null },
  { sub_type: 'TCAT', code: '7030', effect: 'exception', state: null, exception: 'carrier_attention' },
  { sub_type: 'TCAT', code: '7031', effect: 'exception', state: null, exception: 'carrier_attention' },
  { sub_type: 'POST', code: '320', effect: 'progress', state: 'created', exception: null },
  { sub_type: 'POST', code: '3301', effect: 'progress', state: 'handed_over', exception: null },
  { sub_type: 'POST', code: '3302', effect: 'progress', state: 'ready_for_pickup', exception: null },
  { sub_type: 'POST', code: '3303', effect: 'progress', state: 'in_transit', exception: null },
  { sub_type: 'POST', code: '3304', effect: 'exception', state: null, exception: 'carrier_attention' },
  { sub_type: 'POST', code: '3305', effect: 'progress', state: 'returning', exception: 'uncollected' },
  { sub_type: 'POST', code: '3306', effect: 'exception', state: null, exception: 'carrier_attention' },
  { sub_type: 'POST', code: '3307', effect: 'progress', state: 'delivered', exception: null },
  { sub_type: 'POST', code: '3308', effect: 'progress', state: 'delivered', exception: null },
  { sub_type: 'POST', code: '3309', effect: 'progress', state: 'delivered', exception: null },
  { sub_type: 'POST', code: '3310', effect: 'progress', state: 'returned', exception: null },
  { sub_type: 'POST', code: '3311', effect: 'progress', state: 'returning', exception: null },
  { sub_type: 'POST', code: '3312', effect: 'progress', state: 'in_transit', exception: null },
  { sub_type: 'POST', code: '3313', effect: 'progress', state: 'in_transit', exception: null },
  { sub_type: 'POST', code: '3314', effect: 'progress', state: 'ready_for_pickup', exception: null },
  { sub_type: 'POST', code: '3315', effect: 'progress', state: 'ready_for_pickup', exception: null },
  { sub_type: 'POST', code: '7300', effect: 'exception', state: null, exception: 'carrier_attention' },
  { sub_type: 'POST', code: '7301', effect: 'exception', state: null, exception: 'damaged' },
  { sub_type: 'POST', code: '7302', effect: 'exception', state: null, exception: 'lost' },
]);

const C2_SUBTYPES: ReadonlySet<string> = new Set([
  'UNIMARTC2C',
  'FAMIC2C',
  'HILIFEC2C',
  'TCAT',
  'POST',
]);

const UNMAPPED_STATUS: LogisticsStatusResult = Object.freeze({ kind: 'unmapped' });

const STATUS_MAP: ReadonlyMap<string, LogisticsStatusResult> = (() => {
  const map = new Map<string, LogisticsStatusResult>();
  for (const entry of ECPAY_LOGISTICS_STATUS_TABLE) {
    let result: LogisticsStatusResult;
    switch (entry.effect) {
      case 'progress':
        result = Object.freeze({
          kind: 'progress',
          state: entry.state!,
          exception: (entry.exception ?? null) as 'uncollected' | 'damaged' | null,
        });
        break;
      case 'exception':
        result = Object.freeze({
          kind: 'exception',
          exception: entry.exception!,
        });
        break;
      case 'informational':
        result = Object.freeze({ kind: 'informational' });
        break;
      case 'ops_review':
        result = Object.freeze({ kind: 'ops_review' });
        break;
    }
    map.set(`${entry.sub_type}:${entry.code}`, result);
  }
  return Object.freeze(map);
})();

/**
 * Maps ECPay logistics RtnCode and subType to domain shipment state/exception.
 * Strictly verified table only. Unknown subType or code returns { kind: 'unmapped' }.
 * Never throws.
 */
export function mapLogisticsStatus(subType: unknown, rtnCode: unknown): LogisticsStatusResult {
  if (typeof subType !== 'string' || !C2_SUBTYPES.has(subType)) {
    return UNMAPPED_STATUS;
  }
  if (typeof rtnCode !== 'string' || !/^[0-9]{1,8}$/.test(rtnCode)) {
    return UNMAPPED_STATUS;
  }
  return STATUS_MAP.get(`${subType}:${rtnCode}`) ?? UNMAPPED_STATUS;
}

export type TrackingStateChange = 'advance' | 'none' | 'ignore_older' | 'contradiction';

export interface ApplyTrackingResult {
  readonly next: ShipmentState;
  readonly change: TrackingStateChange;
  readonly record_handover: boolean;
}

/**
 * Applies incoming tracking state to current shipment state.
 * Spec §5.5, §6.3, §6.4:
 * 1. current === 'voided' -> contradiction, next = 'voided'
 * 2. incoming === current -> none
 * 3. current order <= 1 -> advance
 * 4. current in F:
 *    incoming in F -> advance if higher order, else ignore_older
 *    incoming in R -> contradiction when current === 'delivered', else advance
 * 5. current in R:
 *    incoming in R -> advance from returning to returned, ignore_older from returned to returning
 *    incoming in F -> contradiction when incoming === 'delivered', else ignore_older
 * record_handover: true exactly when change === 'advance', currentOrder <= 2, nextOrder >= 3
 */
export function applyTrackingState(
  current: ShipmentState,
  incoming: ShipmentState,
): ApplyTrackingResult {
  if (!ALL_SHIPMENT_STATES.includes(current)) {
    throw new FulfilmentRuleError();
  }
  if (!VALID_INCOMING_STATES.includes(incoming)) {
    throw new FulfilmentRuleError();
  }

  let change: TrackingStateChange;
  let next: ShipmentState;

  if (current === 'voided') {
    change = 'contradiction';
    next = 'voided';
  } else if (incoming === current) {
    change = 'none';
    next = current;
  } else {
    const currentOrder = SHIPMENT_STATE_ORDER[current]!;
    const incomingOrder = SHIPMENT_STATE_ORDER[incoming]!;

    if (currentOrder <= 1) {
      change = 'advance';
      next = incoming;
    } else if (FORWARD_STATES.includes(current)) {
      if (FORWARD_STATES.includes(incoming)) {
        if (incomingOrder > currentOrder) {
          change = 'advance';
          next = incoming;
        } else {
          change = 'ignore_older';
          next = current;
        }
      } else {
        // incoming in RETURN_STATES
        if (current === 'delivered') {
          change = 'contradiction';
          next = current;
        } else {
          change = 'advance';
          next = incoming;
        }
      }
    } else {
      // current in RETURN_STATES
      if (RETURN_STATES.includes(incoming)) {
        if (current === 'returning' && incoming === 'returned') {
          change = 'advance';
          next = incoming;
        } else {
          change = 'ignore_older';
          next = current;
        }
      } else {
        // incoming in FORWARD_STATES
        if (incoming === 'delivered') {
          change = 'contradiction';
          next = current;
        } else {
          change = 'ignore_older';
          next = current;
        }
      }
    }
  }

  const currentOrder = SHIPMENT_STATE_ORDER[current];
  const nextOrder = SHIPMENT_STATE_ORDER[next];
  const recordHandover =
    change === 'advance' &&
    currentOrder !== null &&
    currentOrder <= 2 &&
    nextOrder !== null &&
    nextOrder >= 3;

  return deepFreeze({
    next,
    change,
    record_handover: recordHandover,
  });
}

export interface LogisticsEventInput {
  readonly sub_type: unknown;          // LogisticsSubType from ECPay, untrusted
  readonly rtn_code: unknown;          // RtnCode from ECPay, untrusted
  readonly current: ShipmentState;     // the shipment state before this event
  readonly open_exception_kinds: readonly string[]; // kinds of the `open` exception cases linked to this shipment
}

export interface LogisticsEventOutcome {
  readonly status: LogisticsStatusResult;
  readonly next: ShipmentState;
  readonly change: TrackingStateChange;   // 'none' for every result that is not `progress`
  readonly record_handover: boolean;
  readonly open_exception: TrackingExceptionKind | null;
  readonly daily_review: boolean;         // true only for `ops_review` and `unmapped`
}

export function applyLogisticsEvent(input: LogisticsEventInput): LogisticsEventOutcome {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new FulfilmentRuleError();
  }
  if (!ALL_SHIPMENT_STATES.includes(input.current)) {
    throw new FulfilmentRuleError();
  }
  if (!Array.isArray(input.open_exception_kinds) || input.open_exception_kinds.length > 32) {
    throw new FulfilmentRuleError();
  }
  for (const k of input.open_exception_kinds) {
    if (typeof k !== 'string' || k.length === 0) {
      throw new FulfilmentRuleError();
    }
  }

  const status = mapLogisticsStatus(input.sub_type, input.rtn_code);
  const shouldOpen = (kind: TrackingExceptionKind): TrackingExceptionKind | null =>
    input.open_exception_kinds.includes(kind) ? null : kind;

  let next: ShipmentState;
  let change: TrackingStateChange;
  let recordHandover: boolean;
  let openException: TrackingExceptionKind | null = null;
  let dailyReview: boolean;

  switch (status.kind) {
    case 'progress': {
      const t = applyTrackingState(input.current, status.state);
      next = t.next;
      change = t.change;
      recordHandover = t.record_handover;
      dailyReview = false;

      if (t.change === 'advance') {
        if (status.exception !== null) {
          openException = shouldOpen(status.exception);
        } else if (
          (status.state === 'returning' || status.state === 'returned') &&
          input.current !== 'returning' &&
          input.current !== 'returned' &&
          input.open_exception_kinds.length === 0
        ) {
          openException = shouldOpen('carrier_attention');
        } else {
          openException = null;
        }
      } else if (t.change === 'contradiction') {
        openException = shouldOpen('contradicting_event');
      } else {
        openException = null;
      }
      break;
    }

    case 'exception': {
      next = input.current;
      change = 'none';
      recordHandover = false;
      dailyReview = false;

      if (input.current === 'delivered' || input.current === 'voided') {
        openException = shouldOpen('contradicting_event');
      } else if (
        status.exception === 'pickup_store_closed' ||
        status.exception === 'recipient_address_invalid'
      ) {
        const currentOrder = SHIPMENT_STATE_ORDER[input.current];
        if (currentOrder !== null && currentOrder >= 2 && currentOrder <= 5) {
          openException = shouldOpen(status.exception);
        } else {
          openException = null;
        }
      } else {
        openException = shouldOpen(status.exception);
      }
      break;
    }

    case 'informational': {
      next = input.current;
      change = 'none';
      recordHandover = false;
      openException = null;
      dailyReview = false;
      break;
    }

    case 'ops_review':
    case 'unmapped': {
      next = input.current;
      change = 'none';
      recordHandover = false;
      openException = null;
      dailyReview = true;
      break;
    }
  }

  return deepFreeze({
    status,
    next,
    change,
    record_handover: recordHandover,
    open_exception: openException,
    daily_review: dailyReview,
  });
}
