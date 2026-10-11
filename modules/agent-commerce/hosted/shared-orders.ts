import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import {SubmitInputSchema} from '../../../contracts/guild-launchpad/v1/hosted-order.js';
import {HOSTED_SHARED_ORDER_PROFILE} from '../../../contracts/guild-launchpad/v1/hosted-shared-order.js';
import {StoreSlugSchema} from '../../../contracts/guild-launchpad/v1/storefront.js';
import {digest} from '../../../packages/db/index.js';
import {requireCondition} from '../../../packages/shared/problem.js';
import type {Actor} from '../../identity-membership/service.js';
import {directCommand, directFact} from './direct-authority.js';
import {ownQuote} from './direct-quotes.js';
import {sharedLines} from './shared-quotes.js';
import {directOrderView, expireDirectForItems} from './direct-effects.js';

export async function submitSharedOrderOutcome(pool: Pool, actor: Actor, rawSlug: string, raw: unknown, key: string) {
  const slug = StoreSlugSchema.parse(rawSlug), input = SubmitInputSchema.parse(raw);
  let created = false;
  const order = await directCommand(pool, actor, {slug}, 'storefront.order.submit', {slug,...input,reservation_profile:HOSTED_SHARED_ORDER_PROFILE},
    key,input.client_order_id,undefined,async (q,context) => {
      const p = context.profile, buyer = context.member.subject_principal.principal_id, hash = digest(input);
      const quote = await ownQuote(q,context,input.quote_id);
      requireCondition(quote.quote_profile === 'hosted_shared_reservation' && quote.terms_sha256 === input.terms_sha256,
        409,'quote_terms_changed','報價內容不符，請重新確認。');
      const prior = (await q.query(`SELECT order_id,request_sha256,order_profile FROM commerce_orders
        WHERE public_shop_id=$1 AND buyer_principal_id=$2 AND client_order_id=$3 FOR UPDATE`, [p.storefront_shop_id,buyer,input.client_order_id])).rows[0];
      if (prior) {
        requireCondition(prior.request_sha256 === hash && prior.order_profile === 'hosted_shared_reservation',409,'order_intent_conflict','這個訂單識別碼已用於另一份內容。');
        return {id:prior.order_id};
      }
      requireCondition(!(await q.query('SELECT 1 FROM commerce_orders WHERE quote_id=$1',[quote.quote_id])).rowCount,409,'quote_consumed','這份報價已建立訂單。');
      requireCondition(p.current_publication_id === quote.publication_id,409,'publication_changed','商店公開版本已更新，請重新確認。');
      context.deadline = quote.expires_at;
      requireCondition((await q.query('SELECT 1 WHERE $1::timestamptz>clock_timestamp()',[quote.expires_at])).rowCount === 1,409,'quote_expired','報價已到期，請重新確認。');
      const resolved = await sharedLines(q,context,quote.terms.items);
      requireCondition(digest(resolved.bindings) === digest(quote.bindings) && digest(resolved.lines) === digest(quote.terms.items),
        409,'quote_terms_changed','售價或供貨同意已更新，請重新確認報價。');
      await expireDirectForItems(q,context,resolved.bindings,resolved.inventory);
      const balances = await resolved.inventory.lock(resolved.bindings.map(b => b.item_id));
      for (const b of resolved.bindings) requireCondition((balances.get(b.item_id)?.available ?? -1) >= b.quantity,409,'stock_unavailable','商品庫存不足。');
      const now = (await q.query<{now:Date}>("SELECT date_trunc('milliseconds',clock_timestamp()) AS now")).rows[0].now;
      const id = randomUUID();
      await q.query(`INSERT INTO commerce_orders(order_id,public_shop_id,external_id,request_sha256,currency,total_minor,created_at,expires_at,
        order_profile,quote_id,buyer_principal_id,client_order_id,reservation_state,reservation_version)
        VALUES($1,$2,$3,$4,$5,$6,$7,$7::timestamptz+interval '30 minutes','hosted_shared_reservation',$8,$9,$10,'reserved',1)`,
      [id,p.storefront_shop_id,`${buyer}:${input.client_order_id}`,hash,quote.terms.currency,quote.terms.merchandise_total_minor,now,quote.quote_id,buyer,input.client_order_id]);
      for (const b of [...resolved.bindings].sort((a,b) => a.item_id.localeCompare(b.item_id))) {
        const terms = quote.terms.items.find(line => line.sku === b.sku)!;
        await q.query(`INSERT INTO commerce_order_lines(order_id,selection_id,item_id,quantity,snapshot,order_profile,
          supplier_shop_id,hosted_offer_id,acceptance_id,listing_sha256)
          VALUES($1,$2,$3,$4,$5,'hosted_shared_reservation',$6,$7,$8,$9)`,
        [id,b.selection_id,b.item_id,b.quantity,terms,b.supplier_shop_id,b.offer_id,b.acceptance_id,b.listing_sha256]);
        await resolved.inventory.reserve(b.item_id,b.quantity);
      }
      await directFact(q,context,id,'1','reserved'); created = true; return {id};
    },directOrderView,{quoteId:input.quote_id});
  return {order,created};
}
