import {OpaqueId} from '../../../../contracts/guild-launchpad/v1/primitives';
import {ReservationPageSchema as OrderPageSchema, ReservationOrderSchema as OrderSchema, type ReservationOrder as HostedOrder} from '../../../../contracts/guild-launchpad/v1/hosted-shared-order';

export type SellerRoute = {tenantId: string; instanceId: string; supplier?: boolean};
/** Only opaque store locators; never a redirect, credential or buyer identity. */
export function sellerOrdersRoute(hash: string): SellerRoute | null {
  const p = hash.split('/');
  const id = (v: string) => /^[0-9a-f-]{36}$/.test(v) && OpaqueId.safeParse(v).success;
  return p.length === 4 && p[0] === '#stores' && ['orders','supply-orders'].includes(p[3]) && id(p[1]) && id(p[2])
    ? {tenantId: p[1], instanceId: p[2], ...(p[3] === 'supply-orders' ? {supplier:true} : {})} : null;
}
export function readSellerPage(raw: unknown) {
  const p = OrderPageSchema.safeParse(raw);
  if (!p.success || new Set(p.data.items.map(o => o.order_id)).size !== p.data.items.length) return null;
  return p.data;
}
export type SellerCancelAttempt = {order: HostedOrder; key: string; body: Record<string, never>; unknown: boolean};
/** Success must identify the original immutable order and advance its version.
 * A still-reserved read can be displayed, but cannot acknowledge cancellation. */
export function readSellerCancel(raw: unknown, original: HostedOrder): {order: HostedOrder; confirmed: boolean} | null {
  const p = OrderSchema.safeParse(raw);
  if (!p.success) return null;
  const o = p.data;
  if (o.order_id !== original.order_id || o.store.slug !== original.store.slug || o.client_order_id !== original.client_order_id
    || o.quote_id !== original.quote_id || o.terms_sha256 !== original.terms_sha256 || BigInt(o.version) < BigInt(original.version)) return null;
  return {order: o, confirmed: o.state !== 'reserved' && BigInt(o.version) > BigInt(original.version)};
}
