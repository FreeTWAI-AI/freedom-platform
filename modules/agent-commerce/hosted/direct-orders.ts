import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { OpaqueId, Version } from '../../../contracts/guild-launchpad/v1/primitives.js';
import { StoreSlugSchema } from '../../../contracts/guild-launchpad/v1/storefront.js';
import { SubmitInputSchema, OrderPageQuerySchema, OrderPageSchema } from '../../../contracts/guild-launchpad/v1/hosted-order.js';
import { checkVersion, digest } from '../../../packages/db/index.js';
import { requireCondition } from '../../../packages/shared/problem.js';
import type { Actor } from '../../identity-membership/service.js';
import { directCommand, directFact } from './direct-authority.js';
import { ownQuote } from './direct-quotes.js';
import { closeDirectOrder, directOrderView, expireDirectForItems, lockDirectOrder } from './direct-effects.js';
import { localReservationInventory } from './inventory.js';
import { lockMemberScope } from '../../../packages/resource-scopes/index.js';
import { bindPrincipalContext, isolatedTransaction } from '../../../packages/resource-scopes/tenant-transaction.js';
import { assertCurrentSessionClock } from '../../../packages/db/member-session.js';
import { type TenantListCursorCodec, unavailableTenantListCursor } from '../../../packages/shared/tenant-list-cursor.js';
import {ReservationPageSchema} from '../../../contracts/guild-launchpad/v1/hosted-shared-order.js';

/** Backend-only direct sale. Existing imported create/payment/shipment functions
 * cannot reach this profile; no supplier acceptance, transfer or payable exists. */
export async function submitDirectOrderOutcome(pool: Pool, actor: Actor, rawSlug: string, raw: unknown, key: string) {
  const slug = StoreSlugSchema.parse(rawSlug), input = SubmitInputSchema.parse(raw);
  let created = false;
  const order = await directCommand(pool, actor, { slug }, 'storefront.order.submit', { slug, ...input }, key, input.client_order_id, undefined,
    async (q, context) => {
      const p = context.profile, buyer = context.member.subject_principal.principal_id, hash = digest(input);
      const quote = await ownQuote(q, context, input.quote_id);
      requireCondition(quote.quote_profile === 'hosted_direct_reservation', 409, 'quote_profile_changed', '請使用這份報價原本的預留入口。');
      requireCondition(quote.terms_sha256 === input.terms_sha256, 409, 'quote_terms_changed', '報價內容不符，請重新確認。');
      const prior = (await q.query(`SELECT order_id,request_sha256 FROM commerce_orders WHERE public_shop_id=$1 AND buyer_principal_id=$2 AND client_order_id=$3 FOR UPDATE`,
        [p.storefront_shop_id, buyer, input.client_order_id])).rows[0];
      if (prior) {
        requireCondition(prior.request_sha256 === hash, 409, 'order_intent_conflict', '這個訂單識別碼已用於另一份內容。');
        return { id: prior.order_id };
      }
      requireCondition(!(await q.query('SELECT 1 FROM commerce_orders WHERE quote_id=$1', [quote.quote_id])).rowCount,
        409, 'quote_consumed', '這份報價已建立訂單。');
      requireCondition(p.current_publication_id === quote.publication_id, 409, 'publication_changed', '商店公開版本已更新，請重新確認。');
      context.deadline = quote.expires_at;
      requireCondition((await q.query('SELECT 1 WHERE $1::timestamptz>clock_timestamp()', [quote.expires_at])).rowCount === 1,
        409, 'quote_expired', '報價已到期，請重新確認。');
      await expireDirectForItems(q, context, quote.bindings);
      const rows = (await q.query(`SELECT l.selection_id,i.item_id,l.aggregate_version::text AS version,i.sku,i.title,l.retail_price_minor
        FROM commerce_selections l JOIN commerce_items i USING(item_id) WHERE l.shop_id=$1 AND i.shop_id=$2 AND l.selection_id=ANY($3::uuid[])
        ORDER BY l.selection_id,i.item_id FOR UPDATE OF l,i`, [p.storefront_shop_id, p.supply_shop_id, quote.bindings.map(b => b.selection_id)])).rows;
      const inventory = localReservationInventory(q, context);
      const balances = await inventory.lock(rows.map(row => row.item_id));
      for (const binding of quote.bindings) {
        const row = rows.find(row => row.selection_id === binding.selection_id), terms = quote.terms.items.find(line => line.sku === binding.sku);
        requireCondition(row && terms && row.item_id === binding.item_id && row.version === binding.version && row.title === terms.title
          && Number(row.retail_price_minor) === terms.unit_price_minor, 409, 'quote_terms_changed', '商品已更新，請重新確認報價。');
        requireCondition((balances.get(row.item_id)?.available ?? -1) >= binding.quantity, 409, 'stock_unavailable', '商品庫存不足。');
      }
      const now = (await q.query<{ now: Date }>("SELECT date_trunc('milliseconds',clock_timestamp()) AS now")).rows[0].now;
      const id = randomUUID();
      await q.query(`INSERT INTO commerce_orders(order_id,public_shop_id,external_id,request_sha256,currency,total_minor,created_at,expires_at,
        order_profile,quote_id,buyer_principal_id,client_order_id,reservation_state,reservation_version)
        VALUES($1,$2,$3,$4,$5,$6,$7,$7::timestamptz+interval '30 minutes','hosted_direct_reservation',$8,$9,$10,'reserved',1)`,
      [id, p.storefront_shop_id, `${buyer}:${input.client_order_id}`, hash, quote.terms.currency, quote.terms.merchandise_total_minor,
        now, quote.quote_id, buyer, input.client_order_id]);
      for (const binding of [...quote.bindings].sort((a, b) => a.item_id.localeCompare(b.item_id))) {
        const terms = quote.terms.items.find(line => line.sku === binding.sku)!;
        await q.query(`INSERT INTO commerce_order_lines(order_id,selection_id,item_id,quantity,snapshot,order_profile)
          VALUES($1,$2,$3,$4,$5,'hosted_direct_reservation')`, [id, binding.selection_id, binding.item_id, binding.quantity, terms]);
        await inventory.reserve(binding.item_id, binding.quantity);
      }
      await directFact(q, context, id, '1', 'reserved');
      created = true;
      return { id };
    }, directOrderView);
  return { order, created };
}
/** Preserve the existing closed service DTO; transport status is not receipted. */
export async function submitDirectOrder(pool: Pool, actor: Actor, rawSlug: string, raw: unknown, key: string) {
  return (await submitDirectOrderOutcome(pool, actor, rawSlug, raw, key)).order;
}
export async function readDirectOrder(pool: Pool, actor: Actor, orderId: string, includeShared = false) {
  OpaqueId.parse(orderId);
  // This private authoritative read can expire its exact order. Record that
  // effect under this real member, never a fabricated background identity.
  // One stable reference receipt per buyer/order, never one per poll. Projection
  // still runs after every receipt lookup, including the first real expiry.
  return directCommand(pool, actor, { order_id: orderId }, 'storefront.order.read', {}, `order-read-${orderId}`, orderId, undefined,
    async () => ({ id: orderId }), directOrderView, includeShared ? {} : undefined);
}
export async function readDirectOrderByIntent(pool: Pool, actor: Actor, rawSlug: string, clientOrderId: string, includeShared = false) {
  const slug = StoreSlugSchema.parse(rawSlug); OpaqueId.parse(clientOrderId);
  return directCommand(pool, actor, { slug }, 'storefront.order.read', { slug, client_order_id: clientOrderId },
    `intent-read-${digest({ slug, client_order_id: clientOrderId })}`, clientOrderId, undefined,
    async (q, context) => {
      const row = (await q.query(`SELECT order_id FROM commerce_orders WHERE public_shop_id=$1 AND buyer_principal_id=$2
        AND client_order_id=$3 AND (order_profile='hosted_direct_reservation' OR $4::boolean AND order_profile='hosted_shared_reservation')`,
      [context.profile.storefront_shop_id, context.member.subject_principal.principal_id, clientOrderId, includeShared])).rows[0];
      requireCondition(row, 404, 'hosted_order_not_found', '找不到這份訂單。');
      return { id: row.order_id };
    }, directOrderView, includeShared ? {} : undefined);
}
export async function cancelDirectOrder(pool: Pool, actor: Actor, orderId: string, key: string, expected: string, includeShared = false) {
  OpaqueId.parse(orderId); Version.parse(expected);
  return directCommand(pool, actor, { order_id: orderId }, 'storefront.order.cancel', {}, key, orderId, expected,
    async (q, context) => {
      const row = await lockDirectOrder(q, context, orderId); checkVersion(row.reservation_version, expected);
      await closeDirectOrder(q, context, row, 'buyer_cancelled');
      return { id: orderId };
    }, directOrderView, includeShared ? {} : undefined);
}

/** Discover only the current personal principal's retained orders. Each DTO is
 * then read through the exact-order authority/expiry adapter, never a tenant grant. */
export async function listBuyerOrders(pool: Pool, actor: Actor, rawQuery: unknown,
  cursors: TenantListCursorCodec = unavailableTenantListCursor, includeShared = false) {
  const query = OrderPageQuerySchema.parse(rawQuery), limit = query.limit ?? 20;
  const page = await isolatedTransaction(pool, async q => {
    const member = await lockMemberScope(q, { actor, scope: 'personal' });
    const principalId = member.subject_principal.principal_id;
    await bindPrincipalContext(q, principalId);
    const eligible = await q.query(`SELECT 1 FROM users WHERE user_id=$1 AND active
      AND (NOT onboarding_required OR onboarding_completed_at IS NOT NULL) AND NOT is_verification_test_account(user_id)`, [actor.user_id]);
    requireCondition(eligible.rowCount === 1, 403, 'member_unavailable', '目前無法使用會員訂單。');
    const binding = { purpose: 'buyer-orders' as const, principalId,
      tenantId: '', scopeId: member.scope.scope_id, resourceId: null, filter: includeShared ? '{"shared":true}' : '{}' };
    const after = cursors.decode(query.cursor, binding);
    requireCondition(!after || Object.keys(after).sort().join(',') === 'at,id'
      && typeof after.at === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(after.at)
      && Number.isFinite(Date.parse(after.at)) && OpaqueId.safeParse(after.id).success,
    422, 'invalid_cursor', '分頁游標無效。');
    const rows = (await q.query<{ order_id: string; cursor_at: string }>(`SELECT order_id,
      to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at
      FROM commerce_orders WHERE buyer_principal_id=$1 AND (order_profile='hosted_direct_reservation' OR $5::boolean AND order_profile='hosted_shared_reservation')
        AND ($2::timestamptz IS NULL OR (created_at,order_id)<($2::timestamptz,$3::uuid))
      ORDER BY created_at DESC,order_id DESC LIMIT $4`,
    [principalId, after?.at ?? null, after?.id ?? null, limit + 1, includeShared])).rows;
    const selected = rows.slice(0, limit);
    await assertCurrentSessionClock(q, actor);
    return { selected, next_cursor: rows.length > limit
      ? cursors.encode({ at: selected[selected.length - 1].cursor_at, id: selected[selected.length - 1].order_id }, binding) : null };
  });
  const items = [];
  for (const row of page.selected) items.push(await readDirectOrder(pool, actor, row.order_id, includeShared));
  return (includeShared ? ReservationPageSchema : OrderPageSchema).parse({ items, next_cursor: page.next_cursor });
}
