import { Hono } from 'hono';
import type { Pool } from 'pg';
import { OpaqueId } from '../../../../contracts/common/v1/identity.js';
import { EmptyStoreInputSchema, StoreSetupInputSchema, StoreUpdateInputSchema, ProductInputSchema, ProductUpdateInputSchema, SlugQuerySchema, SlugAvailabilitySchema } from '../../../../contracts/guild-launchpad/v1/storefront.js';
import { listMyStores, setupStore, updateStore, storeRead, storeView, slugAvailability } from '../../../../modules/agent-commerce/hosted/store.js';
import { listProducts, addProduct, updateProduct, removeProduct } from '../../../../modules/agent-commerce/hosted/products.js';
import { previewStore, publishStore } from '../../../../modules/agent-commerce/hosted/publish.js';
import { readPublicStore } from '../../../../modules/agent-commerce/hosted/public.js';
import { storeHtml, storeMissingHtml } from '../../../../modules/agent-commerce/hosted/page.js';
import { Problem } from '../../../../packages/shared/problem.js';
import type { PlatformEnv } from '../module-context.js';
import { privateCache, singleQuery, commandHeaders, etag } from './tenant-http.js';

export function createHostedStoreRoutes(pool: Pool) {
  const app = new Hono<PlatformEnv>();
  app.use('*', async (c, next) => { try { await next(); } finally { privateCache(c); } });
  const ids = (c: Parameters<typeof singleQuery>[0]) => [OpaqueId.parse(c.req.param('tenant_id')), OpaqueId.parse(c.req.param('instance_id'))] as const;
  const root = '/tenants/:tenant_id/storefronts/:instance_id';
  app.get('/me/stores', async c => { EmptyStoreInputSchema.parse(singleQuery(c)); return c.json(await listMyStores(pool, c.get('actor'))); });
  app.get(root, async c => {
    EmptyStoreInputSchema.parse(singleQuery(c));
    const [t, i] = ids(c); const view = await storeRead(pool, c.get('actor'), t, i, 'store:read', (q, context, inst) => storeView(q, context, inst));
    if (view.version) etag(c, view.version); return c.json(view);
  });
  app.post(root + '/setup', async c => {
    const h = commandHeaders(c, false); const body = StoreSetupInputSchema.parse(await c.req.json()); const [t, i] = ids(c);
    const result = await setupStore(pool, c.get('actor'), t, i, body, h.key); if (result.view.version) etag(c, result.view.version);
    return c.json(result.view, result.created ? 201 : 200);
  });
  app.patch(root, async c => {
    const h = commandHeaders(c, true); const body = StoreUpdateInputSchema.parse(await c.req.json()); const [t, i] = ids(c);
    const view = await updateStore(pool, c.get('actor'), t, i, body, h.key, h.expected!); if (view.version) etag(c, view.version); return c.json(view);
  });
  app.get(root + '/slug-availability', async c => {
    const query = SlugQuerySchema.parse(singleQuery(c)); const [t, i] = ids(c);
    return c.json(await storeRead(pool, c.get('actor'), t, i, 'store:manage', async q => SlugAvailabilitySchema.parse(await slugAvailability(q, query.slug, i))));
  });
  app.get(root + '/products', async c => { EmptyStoreInputSchema.parse(singleQuery(c)); const [t, i] = ids(c); return c.json(await listProducts(pool, c.get('actor'), t, i)); });
  app.post(root + '/products', async c => {
    const h = commandHeaders(c, false); const body = ProductInputSchema.parse(await c.req.json()); const [t, i] = ids(c);
    const result = await addProduct(pool, c.get('actor'), t, i, body, h.key); etag(c, result.version); return c.json(result, 201);
  });
  app.patch(root + '/products/:product_id', async c => {
    const h = commandHeaders(c, true); const body = ProductUpdateInputSchema.parse(await c.req.json()); const [t, i] = ids(c);
    const result = await updateProduct(pool, c.get('actor'), t, i, OpaqueId.parse(c.req.param('product_id')), body, h.key, h.expected!); etag(c, result.version); return c.json(result);
  });
  app.post(root + '/products/:product_id/remove', async c => {
    const h = commandHeaders(c, true); EmptyStoreInputSchema.parse(await c.req.json()); const [t, i] = ids(c);
    return c.json(await removeProduct(pool, c.get('actor'), t, i, OpaqueId.parse(c.req.param('product_id')), h.key, h.expected!));
  });
  app.get(root + '/preview', async c => { EmptyStoreInputSchema.parse(singleQuery(c)); const [t, i] = ids(c); return c.json(await previewStore(pool, c.get('actor'), t, i)); });
  for (const action of ['publish', 'unpublish'] as const) app.post(root + '/' + action, async c => {
    const h = commandHeaders(c, true); EmptyStoreInputSchema.parse(await c.req.json()); const [t, i] = ids(c);
    const view = await publishStore(pool, c.get('actor'), t, i, h.key, h.expected!, action === 'unpublish'); if (view.version) etag(c, view.version); return c.json(view);
  });
  return app;
}
export function createPublicHostedStoreRoutes(pool: Pool) {
  const app = new Hono<PlatformEnv>();
  app.get('/api/v1/public/stores/:slug', async c => {
    c.header('Cache-Control', 'no-store'); c.header('X-Robots-Tag', 'noindex');
    const store = await readPublicStore(pool, c.req.param('slug'));
    if (!store) throw new Problem(404, 'not_found', '找不到這間商店。');
    c.header('Cache-Control', 'public, max-age=60'); return c.json(store);
  });
  app.get('/shops/:slug', async c => {
    c.header('Cache-Control', 'no-store'); c.header('X-Robots-Tag', 'noindex');
    const store = await readPublicStore(pool, c.req.param('slug'));
    if (!store) return c.html(storeMissingHtml(), 404);
    c.header('Cache-Control', 'public, max-age=60'); return c.html(storeHtml(store));
  });
  return app;
}
