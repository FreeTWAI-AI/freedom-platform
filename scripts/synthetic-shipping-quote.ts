import {createHash} from 'node:crypto';
import {validateShippingQuote,type ShippingQuoteInput,type ShippingQuotePort} from '../modules/agent-commerce/checkout/terms.js';
import type {ShippingMethodRef} from '../contracts/guild-launchpad/v1/hosted-checkout.js';

/**
 * Test-only frozen quotes. Production quoting (fulfilment/quote) is unchanged:
 * a supplied line is `not_agreed` and fails with `fulfilment_not_agreed` until
 * the agreements job exists. This helper models already-agreed supplied
 * fulfilment so checkout and consent regressions can freeze a supplied line.
 * The agreement id is a reserved synthetic UUID derived from the supplier shop.
 * It is not an agreement row and must not be shown as one.
 * Meetup cannot drop-ship. A supplied meetup line throws `shipping_quote_invalid`
 * and is never relabeled as own. Non-meetup supplied lines stay `drop_ship`.
 */
export interface SyntheticShippingOptions {
  readonly method_ref?: ShippingMethodRef;
  readonly fee_per_parcel_minor?: number;
  readonly outlying_surcharge_per_parcel_minor?: number;
  /** Used only for an own-line meetup group. Ignored fees stay 0 so the group stays valid. */
  readonly meetup_note?: string;
  readonly destination_state?: 'complete' | 'store_required';
  readonly delivery_profile_version?: string;
  readonly profile_version?: string;
}

const LOGISTICS = {
  home: {service_key: 'ecpay.logistics.home.tcat', logistics_sub_type: 'TCAT'},
  'cvs:UNIMARTC2C': {service_key: 'ecpay.logistics.cvs.unimartc2c', logistics_sub_type: 'UNIMARTC2C'},
  'cvs:FAMIC2C': {service_key: 'ecpay.logistics.cvs.famic2c', logistics_sub_type: 'FAMIC2C'},
  'cvs:HILIFEC2C': {service_key: 'ecpay.logistics.cvs.hilifec2c', logistics_sub_type: 'HILIFEC2C'},
} as const;

function syntheticOpaqueId(purpose: string, supplierShopId: string): string {
  const hex = createHash('sha256').update(`freedom.synthetic-shipping/${purpose}\n${supplierShopId}`).digest('hex').slice(0, 32).split('');
  hex[12] = '4';
  hex[16] = '8';
  const raw = hex.join('');
  return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20)}`;
}

function money(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('shipping_quote_invalid');
  return value;
}

/** Quote-only. No `cart()`. Buyer delivery JSON is stored unchanged and is not interpreted here. */
export function syntheticShippingPort(options?: SyntheticShippingOptions): ShippingQuotePort {
  return {async quote(_q, _store, input) {return syntheticShippingQuote(input, options);}};
}

export function syntheticShippingQuote(input: ShippingQuoteInput, options: SyntheticShippingOptions = {}) {
  if (input.lines.length < 1) throw new Error('shipping_quote_invalid');
  const method = options.method_ref ?? 'home';
  const meetup = method === 'meetup';
  // Meetup has no drop-ship group. Reject the fixture; do not relabel a supplied line as own.
  if (meetup && input.lines.some(line => !line.own)) throw new Error('shipping_quote_invalid');
  const fee = meetup ? 0 : money(options.fee_per_parcel_minor ?? 0);
  const surcharge = meetup ? 0 : money(options.outlying_surcharge_per_parcel_minor ?? 0);
  let destination = options.destination_state ?? (method.startsWith('cvs:') ? 'store_required' : 'complete');
  // Meetup and home cannot freeze store_required. CVS stays store_required unless a test asks for complete.
  if (meetup || (destination === 'store_required' && !method.startsWith('cvs:'))) destination = 'complete';
  const buckets = new Map<string, {supplier_shop_id: string; own: boolean; lines: typeof input.lines[number][]}>();
  for (const line of input.lines) {
    const key = `${line.supplier_shop_id}\n${line.own ? 'own' : 'supplied'}`;
    const bucket = buckets.get(key) ?? {supplier_shop_id: line.supplier_shop_id, own: line.own, lines: []};
    bucket.lines.push(line);
    buckets.set(key, bucket);
  }
  // supplier_shop_id code-unit order, then supplied (own false) before own.
  const ordered = [...buckets.values()].sort((a, b) => a.supplier_shop_id < b.supplier_shop_id ? -1 : a.supplier_shop_id > b.supplier_shop_id ? 1 : (a.own ? 1 : 0) - (b.own ? 1 : 0));
  const groups = ordered.map((bucket, index) => {
    const lines = [...bucket.lines].sort((a, b) => a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0);
    const group_ref = `g${index + 1}`;
    const declared = lines.reduce((sum, line) => sum + line.unit_price_minor * line.quantity, 0);
    if (!Number.isSafeInteger(declared)) throw new Error('shipping_quote_invalid');
    const amount = fee + surcharge;
    if (!Number.isSafeInteger(amount)) throw new Error('shipping_quote_invalid');
    return {
      group_ref,
      supplier_shop_id: bucket.supplier_shop_id,
      method_ref: method,
      fulfilment_mode: bucket.own ? 'self' as const : 'drop_ship' as const,
      agreement: bucket.own ? null : {agreement_id: syntheticOpaqueId('agreement', bucket.supplier_shop_id), version: '1'},
      profile_version: options.profile_version ?? '1',
      logistics: meetup ? null : {
        ...LOGISTICS[method],
        ship_from_location_id: syntheticOpaqueId('ship-from', bucket.supplier_shop_id),
        temperature: 'ambient' as const,
        handling_days: 1,
        cutoff_time: '17:00',
        working_days: [1, 2, 3, 4, 5],
      },
      meetup: meetup ? {note: options.meetup_note ?? '面交取貨'} : null,
      parcels: [{
        parcel_ref: `${group_ref}-p1`,
        lines: lines.map(line => ({sku: line.sku, quantity: line.quantity})),
        weight_g: meetup ? null : 100,
        declared_value_minor: declared,
      }],
      attribute_versions: meetup ? [] : lines.map(line => ({sku: line.sku, version: '1'})),
      fee_per_parcel_minor: fee,
      outlying_surcharge_per_parcel_minor: surcharge,
      amount_minor: amount,
    };
  });
  return validateShippingQuote({
    delivery_profile_version: options.delivery_profile_version ?? '1',
    destination_state: destination,
    groups,
  }, input.lines);
}
