import {randomUUID} from 'node:crypto';
import type {Pool, PoolClient} from 'pg';
import {QuoteInputSchema} from '../../../contracts/guild-launchpad/v1/hosted-order.js';
import {HOSTED_SHARED_ORDER_PROFILE, SharedQuoteSchema, type ReservationQuote} from '../../../contracts/guild-launchpad/v1/hosted-shared-order.js';
import {StoreSlugSchema} from '../../../contracts/guild-launchpad/v1/storefront.js';
import {digest} from '../../../packages/db/index.js';
import {requireCondition} from '../../../packages/shared/problem.js';
import {authRateLimitInTransaction} from '../../identity-membership/members.js';
import type {Actor} from '../../identity-membership/service.js';
import {directCommand, type DirectContext} from './direct-authority.js';
import {ownQuote, type QuoteBinding} from './direct-quotes.js';
import {publicProjection} from './publish.js';
import {sharedSupplier} from './shared-authority.js';
import {boundReservationInventory} from './inventory.js';
import {expireDirectForItems} from './direct-effects.js';

export interface SharedBinding extends QuoteBinding {
  supplier_shop_id: string; supplier_instance_id: string;
  offer_id: string | null; offer_sha256: string | null;
  acceptance_id: string | null; listing_sha256: string | null;
}

/** Resolve by seller-local SKU, then verify current exact consent. Supplier
 * draft changes do not overwrite an explicitly offered immutable snapshot. */
export async function sharedLines(q: PoolClient, context: DirectContext, requested: readonly {sku: string; quantity: number}[]) {
  const p = context.profile, projection = publicProjection(p.projection);
  requireCondition(context.shared, 409, 'shared_context_required', '預留來源無效。');
  const rows = (await q.query(`SELECT l.*,l.aggregate_version::text AS version,COALESCE(l.hosted_sku,i.sku) AS sku,
      i.shop_id AS supplier_shop_id,i.title AS own_title,source.instance_id AS supplier_instance_id,
      o.terms AS offer_terms,o.terms_sha256 AS offer_sha256,o.state AS offer_state,
      a.acceptance_id,a.listing_sha256 AS accepted_sha256,a.decision AS acceptance_decision
    FROM commerce_selections l JOIN commerce_items i USING(item_id)
    JOIN commerce_storefront_profiles source ON source.supply_shop_id=i.shop_id
    LEFT JOIN commerce_hosted_supply_offers o ON o.offer_id=l.hosted_offer_id AND o.item_id=l.item_id
      AND o.tenant_id=source.tenant_id AND o.instance_id=source.instance_id
    LEFT JOIN commerce_distribution_acceptances a ON a.acceptance_id=l.current_acceptance_id AND a.selection_id=l.selection_id
    WHERE l.shop_id=$1 AND COALESCE(l.hosted_sku,i.sku)=ANY($2::text[])
    ORDER BY l.selection_id,i.item_id`, [p.storefront_shop_id, requested.map(line => line.sku)])).rows;
  const bindings: SharedBinding[] = [], lines: ReservationQuote['items'] = [];
  const sources = new Map<string,string>();
  for (const wanted of [...requested].sort((a,b) => a.sku.localeCompare(b.sku))) {
    const row = rows.find(row => row.sku === wanted.sku), published = projection.products.find(line => line.sku === wanted.sku);
    requireCondition(row && published, 409, 'publication_changed', '商品與公開版本不同，請等待商店重新公開。');
    const supplier = await sharedSupplier(q, p, context.shared, row.supplier_instance_id);
    requireCondition(supplier.supply_shop_id === row.supplier_shop_id, 409, 'supply_unavailable', '供貨來源已更新。');
    const own = supplier.instance_id === p.instance_id;
    requireCondition(own ? row.hosted_offer_id === null : row.hosted_offer_id && row.offer_state === 'offered'
      && row.acceptance_state === 'sellable' && row.acceptance_decision === 'accepted'
      && row.current_acceptance_id === row.acceptance_id && row.listing_sha256 === row.accepted_sha256
      && digest(row.snapshot) === row.listing_sha256 && row.snapshot.offer_sha256 === row.offer_sha256
      && row.snapshot.offer_id === row.hosted_offer_id && row.offer_terms?.currency === p.currency,
    409, 'supply_unavailable', '這項供貨已停止或條件已更新，請重新確認。');
    const title = own ? row.own_title : row.offer_terms.title;
    requireCondition(title === published.title && Number(row.retail_price_minor) === published.price_minor,
      409, 'publication_changed', '商品與公開版本不同，請等待商店重新公開。');
    bindings.push({selection_id: row.selection_id, item_id: row.item_id, version: row.version, sku: wanted.sku, quantity: wanted.quantity,
      supplier_shop_id: supplier.supply_shop_id, supplier_instance_id: supplier.instance_id,
      offer_id: own ? null : row.hosted_offer_id, offer_sha256: own ? null : row.offer_sha256,
      acceptance_id: own ? null : row.acceptance_id, listing_sha256: own ? null : row.listing_sha256});
    lines.push({sku: wanted.sku, title, quantity: wanted.quantity, unit_price_minor: Number(row.retail_price_minor),
      line_total_minor: Number(row.retail_price_minor) * wanted.quantity});
    sources.set(row.item_id, supplier.supply_shop_id);
  }
  return {bindings, lines, inventory: boundReservationInventory(q, sources)};
}

export async function createSharedQuote(pool: Pool, actor: Actor, rawSlug: string, raw: unknown, key: string) {
  const slug = StoreSlugSchema.parse(rawSlug), input = QuoteInputSchema.parse(raw);
  return directCommand(pool, actor, {slug}, 'storefront.quote.create', {slug, ...input, reservation_profile: HOSTED_SHARED_ORDER_PROFILE}, key, actor.user_id, undefined,
    async (q, context) => {
      const p = context.profile, buyer = context.member.subject_principal.principal_id, projection = publicProjection(p.projection);
      requireCondition(projection.revision === input.publication_revision, 409, 'publication_changed', '商店公開內容已更新，請重新確認。');
      const active = (await q.query<{count:number}>(`SELECT count(*)::int AS count FROM commerce_order_quotes quote
        WHERE buyer_principal_id=$1 AND public_shop_id=$2 AND expires_at>clock_timestamp()
        AND NOT EXISTS(SELECT 1 FROM commerce_orders o WHERE o.quote_id=quote.quote_id)`, [buyer,p.storefront_shop_id])).rows[0].count;
      requireCondition(active < 10, 429, 'quote_limit', '尚未到期的報價過多，請稍後再試。');
      await authRateLimitInTransaction(q, 'hosted-order.quote', buyer, 20, 60);
      const resolved = await sharedLines(q, context, input.items);
      await expireDirectForItems(q, context, resolved.bindings, resolved.inventory);
      const balances = await resolved.inventory.lock(resolved.bindings.map(b => b.item_id));
      for (const b of resolved.bindings) requireCondition((balances.get(b.item_id)?.available ?? -1) >= b.quantity,
        409, 'stock_unavailable', '商品庫存不足。');
      const now = (await q.query<{now:Date}>("SELECT date_trunc('milliseconds',clock_timestamp()) AS now")).rows[0].now;
      const id = randomUUID(), expiry = new Date(now.getTime()+300000);
      const terms = {profile: HOSTED_SHARED_ORDER_PROFILE, store: {slug,name:projection.name}, publication_revision: projection.revision,
        currency: projection.currency, items: resolved.lines, merchandise_total_minor: resolved.lines.reduce((n,l) => n+l.line_total_minor,0),
        amount_due_minor: null, shipping_state: 'not_configured', tax_state: 'not_assessed', payment_state: 'not_enabled',
        payment_enabled: false, refund_enabled: false, fulfilment_enabled: false, money_movement_enabled: false};
      const hash = digest({terms, buyer, tenant_id:p.tenant_id, instance_id:p.instance_id, shop_id:p.storefront_shop_id,
        publication_id:p.current_publication_id, bindings:resolved.bindings});
      const view = SharedQuoteSchema.parse({...terms, terms_sha256:hash, quote_id:id, quoted_at:now.toISOString(), expires_at:expiry.toISOString(), reserves_stock:false});
      await q.query(`INSERT INTO commerce_order_quotes(quote_id,tenant_id,instance_id,public_shop_id,buyer_principal_id,publication_id,
        terms,bindings,terms_sha256,quoted_at,expires_at,quote_profile) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'hosted_shared_reservation')`,
      [id,p.tenant_id,p.instance_id,p.storefront_shop_id,buyer,p.current_publication_id,view,JSON.stringify(resolved.bindings),hash,now,expiry]);
      context.deadline = expiry; return {id};
    }, async (q,context,id) => SharedQuoteSchema.parse((await ownQuote(q,context,id)).terms), {skus:input.items.map(line => line.sku)});
}
