import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { HOSTED_ORDER_PROFILE, QuoteInputSchema, QuoteSchema, type HostedOrderQuote } from '../../../contracts/guild-launchpad/v1/hosted-order.js';
import { StoreSlugSchema } from '../../../contracts/guild-launchpad/v1/storefront.js';
import { digest } from '../../../packages/db/index.js';
import { requireCondition } from '../../../packages/shared/problem.js';
import { authRateLimitInTransaction } from '../../identity-membership/members.js';
import type { Actor } from '../../identity-membership/service.js';
import { publicProjection } from './publish.js';
import { directCommand, type DirectContext } from './direct-authority.js';
import { expireDirectForItems } from './direct-effects.js';
import { localReservationInventory } from './inventory.js';

export interface QuoteBinding { selection_id: string; item_id: string; version: string; sku: string; quantity: number }
export interface QuoteRow {
  quote_id: string; public_shop_id: string; buyer_principal_id: string; publication_id: string;
  terms: HostedOrderQuote; bindings: QuoteBinding[]; terms_sha256: string; quoted_at: Date; expires_at: Date;
}
export async function ownQuote(q: PoolClient, context: DirectContext, id: string): Promise<QuoteRow> {
  const row = (await q.query<QuoteRow>(`SELECT * FROM commerce_order_quotes WHERE quote_id=$1 AND buyer_principal_id=$2
    AND tenant_id=$3 AND instance_id=$4 AND public_shop_id=$5 FOR UPDATE`,
  [id, context.member.subject_principal.principal_id, context.profile.tenant_id, context.profile.instance_id, context.profile.storefront_shop_id])).rows[0];
  requireCondition(row, 404, 'hosted_quote_not_found', '找不到這份報價。');
  return row;
}
export async function quoteView(q: PoolClient, context: DirectContext, id: string) {
  const row = await ownQuote(q, context, id);
  return QuoteSchema.parse(row.terms);
}

/** Closed service; no public route or reservation-setting mutation is exported. */
export async function createDirectQuote(pool: Pool, actor: Actor, rawSlug: string, raw: unknown, key: string) {
  const slug = StoreSlugSchema.parse(rawSlug), input = QuoteInputSchema.parse(raw);
  return directCommand(pool, actor, { slug }, 'storefront.quote.create', { slug, ...input }, key, actor.user_id, undefined,
    async (q, context) => {
      const p = context.profile, buyer = context.member.subject_principal.principal_id;
      const projection = publicProjection(p.projection);
      requireCondition(projection.revision === input.publication_revision, 409, 'publication_changed', '商店公開內容已更新，請重新確認。');
      const active = (await q.query<{ count: number }>(`SELECT count(*)::int AS count FROM commerce_order_quotes quote
        WHERE buyer_principal_id=$1 AND public_shop_id=$2 AND expires_at>clock_timestamp()
        AND NOT EXISTS(SELECT 1 FROM commerce_orders o WHERE o.quote_id=quote.quote_id)`, [buyer, p.storefront_shop_id])).rows[0].count;
      requireCondition(active < 10, 429, 'quote_limit', '尚未到期的報價過多，請稍後再試。');
      await authRateLimitInTransaction(q, 'hosted-order.quote', buyer, 20, 60);
      const bindings: QuoteBinding[] = [], lines: HostedOrderQuote['items'] = [];
      // Community/profile serializes stock writers; row locks are sorted by
      // existing selection/item UUIDs, independently of buyer input order.
      const selected = (await q.query<{ item_id: string; sku: string }>(`SELECT i.item_id,i.sku FROM commerce_selections l JOIN commerce_items i USING(item_id)
        WHERE l.shop_id=$1 AND i.shop_id=$2 AND i.sku=ANY($3::text[])`, [p.storefront_shop_id, p.supply_shop_id, input.items.map(line => line.sku)])).rows;
      await expireDirectForItems(q, context, selected.map(item => ({ item_id: item.item_id, quantity: input.items.find(line => line.sku === item.sku)!.quantity })));
      const rows = (await q.query(`SELECT l.selection_id,i.item_id,l.aggregate_version::text AS version,i.sku,i.title,
        l.retail_price_minor FROM commerce_selections l JOIN commerce_items i USING(item_id)
        WHERE l.shop_id=$1 AND i.shop_id=$2 AND i.sku=ANY($3::text[]) ORDER BY l.selection_id,i.item_id FOR UPDATE OF l,i`,
      [p.storefront_shop_id, p.supply_shop_id, input.items.map(line => line.sku)])).rows;
      const balances = await localReservationInventory(q, context).lock(rows.map(row => row.item_id));
      for (const requested of [...input.items].sort((a, b) => a.sku.localeCompare(b.sku))) {
        const row = rows.find(row => row.sku === requested.sku), published = projection.products.find(line => line.sku === requested.sku);
        requireCondition(row && published && row.title === published.title && Number(row.retail_price_minor) === published.price_minor,
          409, 'publication_changed', '商品與公開版本不同，請等待商店重新公開。');
        requireCondition((balances.get(row.item_id)?.available ?? -1) >= requested.quantity, 409, 'stock_unavailable', '商品庫存不足。');
        bindings.push({ selection_id: row.selection_id, item_id: row.item_id, version: row.version, sku: row.sku, quantity: requested.quantity });
        lines.push({ sku: row.sku, title: row.title, quantity: requested.quantity, unit_price_minor: Number(row.retail_price_minor),
          line_total_minor: Number(row.retail_price_minor) * requested.quantity });
      }
      const now = (await q.query<{ now: Date }>("SELECT date_trunc('milliseconds',clock_timestamp()) AS now")).rows[0].now;
      const id = randomUUID(), expiry = new Date(now.getTime() + 300000);
      const terms = { profile: HOSTED_ORDER_PROFILE, store: { slug, name: projection.name }, publication_revision: projection.revision,
        currency: projection.currency, items: lines, merchandise_total_minor: lines.reduce((n, line) => n + line.line_total_minor, 0),
        amount_due_minor: null, shipping_state: 'not_configured', tax_state: 'not_assessed', payment_state: 'not_enabled',
        payment_enabled: false, refund_enabled: false, fulfilment_enabled: false, money_movement_enabled: false };
      const hash = digest({ terms, buyer, tenant_id: p.tenant_id, instance_id: p.instance_id, shop_id: p.storefront_shop_id,
        publication_id: p.current_publication_id, bindings });
      const view = QuoteSchema.parse({ ...terms, terms_sha256: hash, quote_id: id, quoted_at: now.toISOString(), expires_at: expiry.toISOString(), reserves_stock: false });
      await q.query(`INSERT INTO commerce_order_quotes(quote_id,tenant_id,instance_id,public_shop_id,buyer_principal_id,publication_id,
        terms,bindings,terms_sha256,quoted_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [id, p.tenant_id, p.instance_id, p.storefront_shop_id, buyer, p.current_publication_id, view, JSON.stringify(bindings), hash, now, expiry]);
      context.deadline = expiry;
      return { id };
    }, quoteView);
}
