import { Hono } from 'hono';
import type { Pool } from 'pg';
import { OpaqueId } from '../../../../contracts/guild-launchpad/v1/primitives.js';
import { CancelInputSchema, IntentLookupQuerySchema, QuoteInputSchema, SubmitInputSchema } from '../../../../contracts/guild-launchpad/v1/hosted-order.js';
import { StoreSlugSchema } from '../../../../contracts/guild-launchpad/v1/storefront.js';
import { createDirectQuote } from '../../../../modules/agent-commerce/hosted/direct-quotes.js';
import { readDirectReadiness } from '../../../../modules/agent-commerce/hosted/direct-authority.js';
import { submitDirectOrderOutcome, readDirectOrder, readDirectOrderByIntent, cancelDirectOrder } from '../../../../modules/agent-commerce/hosted/direct-orders.js';
import { requireCondition } from '../../../../packages/shared/problem.js';
import type { PlatformEnv } from '../module-context.js';
import { privateCache, singleQuery, commandHeaders, etag } from './tenant-http.js';

/** Mounted only after the real cookie/CSRF member boundary. Host admission and
 * the store's separate DB setting never grant seller tenant membership. */
export function createHostedOrderRoutes(pool: Pool, options: { discoveryInstalled: boolean; admissionEnabled: boolean }) {
  const app = new Hono<PlatformEnv>();
  app.use('*', async (c, next) => { try { await next(); } finally { privateCache(c); } });
  const emptyQuery = (c: Parameters<typeof singleQuery>[0]) => CancelInputSchema.parse(singleQuery(c));
  if (options.discoveryInstalled === true) {
    const root = '/hosted-stores/:slug';
    app.get(root + '/order-readiness', async c => {
      emptyQuery(c);
      return c.json(await readDirectReadiness(pool, c.get('actor'), StoreSlugSchema.parse(c.req.param('slug')), options.admissionEnabled));
    });
    app.post(root + '/quotes', async c => {
      emptyQuery(c); const headers = commandHeaders(c, false);
      const body = QuoteInputSchema.parse(await c.req.json()), slug = StoreSlugSchema.parse(c.req.param('slug'));
      requireCondition(options.admissionEnabled === true, 404, 'not_found', '此版本尚未提供建立預留。');
      return c.json(await createDirectQuote(pool, c.get('actor'), slug, body, headers.key), 201);
    });
    app.post(root + '/orders', async c => {
      emptyQuery(c); const headers = commandHeaders(c, false);
      const body = SubmitInputSchema.parse(await c.req.json()), slug = StoreSlugSchema.parse(c.req.param('slug'));
      requireCondition(options.admissionEnabled === true, 404, 'not_found', '此版本尚未提供建立預留。');
      const result = await submitDirectOrderOutcome(pool, c.get('actor'), slug, body, headers.key);
      etag(c, result.order.version); return c.json(result.order, result.created ? 201 : 200);
    });
  }
  // Recovery and release remain available when either admission/discovery flag
  // is OFF; the persisted order and current buyer ACL still decide access.
  app.get('/me/hosted-orders/by-intent/:client_order_id', async c => {
    const query = IntentLookupQuerySchema.parse(singleQuery(c));
    const order = await readDirectOrderByIntent(pool, c.get('actor'), query.store_slug, OpaqueId.parse(c.req.param('client_order_id')));
    etag(c, order.version); return c.json(order);
  });
  app.get('/me/hosted-orders/:order_id', async c => {
    emptyQuery(c);
    const order = await readDirectOrder(pool, c.get('actor'), OpaqueId.parse(c.req.param('order_id')));
    etag(c, order.version); return c.json(order);
  });
  app.post('/me/hosted-orders/:order_id/cancel', async c => {
    emptyQuery(c); const headers = commandHeaders(c, true); CancelInputSchema.parse(await c.req.json());
    const order = await cancelDirectOrder(pool, c.get('actor'), OpaqueId.parse(c.req.param('order_id')), headers.key, headers.expected!);
    etag(c, order.version); return c.json(order);
  });
  return app;
}
