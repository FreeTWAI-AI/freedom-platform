import { Hono } from 'hono';
import type { Pool } from 'pg';
import { OpaqueId } from '../../../../contracts/guild-launchpad/v1/primitives.js';
import { CancelInputSchema, IntentLookupQuerySchema, QuoteInputSchema, SubmitInputSchema, OrderPageQuerySchema } from '../../../../contracts/guild-launchpad/v1/hosted-order.js';
import { StoreSlugSchema } from '../../../../contracts/guild-launchpad/v1/storefront.js';
import { createDirectQuote } from '../../../../modules/agent-commerce/hosted/direct-quotes.js';
import { readDirectReadiness } from '../../../../modules/agent-commerce/hosted/direct-authority.js';
import { submitDirectOrderOutcome, readDirectOrder, readDirectOrderByIntent, cancelDirectOrder, listBuyerOrders } from '../../../../modules/agent-commerce/hosted/direct-orders.js';
import { listSellerOrders, readSellerOrder, cancelSellerOrder, readReservationSetting, configureReservations } from '../../../../modules/agent-commerce/hosted/seller-orders.js';
import {createSharedQuote} from '../../../../modules/agent-commerce/hosted/shared-quotes.js';
import {submitSharedOrderOutcome} from '../../../../modules/agent-commerce/hosted/shared-orders.js';
import {listSupplierOrders} from '../../../../modules/agent-commerce/hosted/supplier-orders.js';
import {ReservationSettingInputSchema} from '../../../../contracts/guild-launchpad/v1/hosted-shared-order.js';
import type { TenantListCursorCodec } from '../../../../packages/shared/tenant-list-cursor.js';
import { requireCondition } from '../../../../packages/shared/problem.js';
import type { PlatformEnv } from '../module-context.js';
import { privateCache, singleQuery, commandHeaders, etag } from './tenant-http.js';

/** Mounted only after the real cookie/CSRF member boundary. Host admission and
 * the store's separate DB setting never grant seller tenant membership. */
export function createHostedOrderRoutes(pool: Pool, options: { discoveryInstalled: boolean; admissionEnabled: boolean; cursors?: TenantListCursorCodec }) {
  const app = new Hono<PlatformEnv>();
  app.use('*', async (c, next) => { try { await next(); } finally { privateCache(c); } });
  const emptyQuery = (c: Parameters<typeof singleQuery>[0]) => CancelInputSchema.parse(singleQuery(c));
  if (options.discoveryInstalled === true) {
    const root = '/hosted-stores/:slug';
    app.get(root + '/order-readiness', async c => {
      emptyQuery(c);
      return c.json(await readDirectReadiness(pool, c.get('actor'), StoreSlugSchema.parse(c.req.param('slug')), options.admissionEnabled));
    });
    for (const shared of [false, true]) {
      app.post(root + (shared ? '/reservation-quotes' : '/quotes'), async c => {
        emptyQuery(c); const headers = commandHeaders(c, false);
        const body = QuoteInputSchema.parse(await c.req.json()), slug = StoreSlugSchema.parse(c.req.param('slug'));
        requireCondition(options.admissionEnabled === true, 404, 'not_found', '此版本尚未提供建立預留。');
        return c.json(await (shared ? createSharedQuote : createDirectQuote)(pool, c.get('actor'), slug, body, headers.key), 201);
      });
      app.post(root + (shared ? '/reservation-orders' : '/orders'), async c => {
        emptyQuery(c); const headers = commandHeaders(c, false);
        const body = SubmitInputSchema.parse(await c.req.json()), slug = StoreSlugSchema.parse(c.req.param('slug'));
        requireCondition(options.admissionEnabled === true, 404, 'not_found', '此版本尚未提供建立預留。');
        const result = await (shared ? submitSharedOrderOutcome : submitDirectOrderOutcome)(pool, c.get('actor'), slug, body, headers.key);
        etag(c, result.order.version); return c.json(result.order, result.created ? 201 : 200);
      });
    }
  }
  // Recovery and release remain available when either admission/discovery flag
  // is OFF; the persisted order and current buyer ACL still decide access.
  for (const shared of [false, true]) {
    const buyer = shared ? '/me/reservations' : '/me/hosted-orders';
    app.get(buyer, async c => {
      const raw = singleQuery(c);
      if (raw.limit !== undefined) requireCondition(/^[1-9][0-9]?$/.test(raw.limit), 422, 'validation_failed', '頁面大小無效。');
      const query = OrderPageQuerySchema.parse({ ...raw, ...(raw.limit === undefined ? {} : { limit: Number(raw.limit) }) });
      return c.json(await listBuyerOrders(pool, c.get('actor'), query, options.cursors, shared));
    });
    app.get(buyer + '/by-intent/:client_order_id', async c => {
      const query = IntentLookupQuerySchema.parse(singleQuery(c));
      const order = await readDirectOrderByIntent(pool, c.get('actor'), query.store_slug, OpaqueId.parse(c.req.param('client_order_id')), shared);
      etag(c, order.version); return c.json(order);
    });
    app.get(buyer + '/:order_id', async c => {
      emptyQuery(c);
      const order = await readDirectOrder(pool, c.get('actor'), OpaqueId.parse(c.req.param('order_id')), shared);
      etag(c, order.version); return c.json(order);
    });
    app.post(buyer + '/:order_id/cancel', async c => {
      emptyQuery(c); const headers = commandHeaders(c, true); CancelInputSchema.parse(await c.req.json());
      const order = await cancelDirectOrder(pool, c.get('actor'), OpaqueId.parse(c.req.param('order_id')), headers.key, headers.expected!, shared);
      etag(c, order.version); return c.json(order);
    });
    const seller = '/tenants/:tenant_id/storefronts/:instance_id' + (shared ? '/reservations' : '/orders');
    const sellerIds = (c: Parameters<typeof singleQuery>[0]) => [OpaqueId.parse(c.req.param('tenant_id')), OpaqueId.parse(c.req.param('instance_id'))] as const;
    app.get(seller, async c => {
      const raw = singleQuery(c);
      if (raw.limit !== undefined) requireCondition(/^[1-9][0-9]?$/.test(raw.limit), 422, 'validation_failed', '頁面大小無效。');
      const query = OrderPageQuerySchema.parse({ ...raw, ...(raw.limit === undefined ? {} : { limit: Number(raw.limit) }) });
      const [t, i] = sellerIds(c); return c.json(await listSellerOrders(pool, c.get('actor'), t, i, query, options.cursors, shared));
    });
    app.get(seller + '/:order_id', async c => {
      emptyQuery(c); const [t, i] = sellerIds(c);
      const order = await readSellerOrder(pool, c.get('actor'), t, i, OpaqueId.parse(c.req.param('order_id')), shared);
      etag(c, order.version); return c.json(order);
    });
    app.post(seller + '/:order_id/cancel', async c => {
      emptyQuery(c); const headers = commandHeaders(c, true); CancelInputSchema.parse(await c.req.json());
      const [t, i] = sellerIds(c), order = await cancelSellerOrder(pool, c.get('actor'), t, i, OpaqueId.parse(c.req.param('order_id')), headers.key, headers.expected!, shared);
      etag(c, order.version); return c.json(order);
    });
  }
  const setting = '/tenants/:tenant_id/storefronts/:instance_id/reservation-setting';
  app.get('/tenants/:tenant_id/storefronts/:instance_id/supply-reservations',async c=>{
    const raw=singleQuery(c);
    if(raw.limit!==undefined) requireCondition(/^[1-9][0-9]?$/.test(raw.limit),422,'validation_failed','頁面大小無效。');
    const query=OrderPageQuerySchema.parse({...raw,...(raw.limit===undefined?{}:{limit:Number(raw.limit)})});
    return c.json(await listSupplierOrders(pool,c.get('actor'),OpaqueId.parse(c.req.param('tenant_id')),
      OpaqueId.parse(c.req.param('instance_id')),query,options.cursors));
  });
  app.get(setting, async c => {
    emptyQuery(c);
    const result = await readReservationSetting(pool,c.get('actor'),OpaqueId.parse(c.req.param('tenant_id')),
      OpaqueId.parse(c.req.param('instance_id')),options.admissionEnabled);
    etag(c,result.version); return c.json(result);
  });
  app.patch(setting, async c => {
    emptyQuery(c); const headers = commandHeaders(c,true), body = ReservationSettingInputSchema.parse(await c.req.json());
    const result = await configureReservations(pool,c.get('actor'),OpaqueId.parse(c.req.param('tenant_id')),
      OpaqueId.parse(c.req.param('instance_id')),body,headers.key,headers.expected!,options.admissionEnabled);
    etag(c,result.version); return c.json(result);
  });
  return app;
}
