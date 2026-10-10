import {Hono} from 'hono';
import type {Pool} from 'pg';
import {OpaqueId} from '../../../../contracts/common/v1/identity.js';
import {EmptyStoreInputSchema} from '../../../../contracts/guild-launchpad/v1/storefront.js';
import {DistributionInputSchema, DistributionDecisionSchema} from '../../../../contracts/guild-launchpad/v1/hosted-distribution.js';
import {listSupplyOffers, publishSupplyOffer, withdrawSupplyOffer, listDistributions, proposeDistribution, decideDistribution, withdrawDistribution} from '../../../../modules/agent-commerce/hosted/distribution.js';
import type {PlatformEnv} from '../module-context.js';
import {privateCache, singleQuery, commandHeaders, etag} from './tenant-http.js';

export function createHostedDistributionRoutes(pool: Pool) {
  const app = new Hono<PlatformEnv>();
  app.use('*', async (c, next) => {try {await next();} finally {privateCache(c);}});
  const root = '/tenants/:tenant_id/storefronts/:instance_id';
  const ids = (c: Parameters<typeof singleQuery>[0]) => [OpaqueId.parse(c.req.param('tenant_id')), OpaqueId.parse(c.req.param('instance_id'))] as const;
  for (const [path, own] of [['supply-offers', true], ['supply-catalog', false]] as const) app.get(root+'/'+path, async c => {
    EmptyStoreInputSchema.parse(singleQuery(c)); const [t,i] = ids(c);
    return c.json(await listSupplyOffers(pool, c.get('actor'), t, i, own));
  });
  app.post(root+'/products/:product_id/supply-offer', async c => {
    EmptyStoreInputSchema.parse(singleQuery(c)); EmptyStoreInputSchema.parse(await c.req.json()); const [t,i] = ids(c), h = commandHeaders(c,true);
    const view = await publishSupplyOffer(pool,c.get('actor'),t,i,OpaqueId.parse(c.req.param('product_id')),h.key,h.expected!);
    etag(c,view.version); return c.json(view);
  });
  app.post(root+'/supply-offers/:offer_id/withdraw', async c => {
    EmptyStoreInputSchema.parse(singleQuery(c)); EmptyStoreInputSchema.parse(await c.req.json()); const [t,i] = ids(c), h = commandHeaders(c,true);
    const view = await withdrawSupplyOffer(pool,c.get('actor'),t,i,OpaqueId.parse(c.req.param('offer_id')),h.key,h.expected!);
    etag(c,view.version); return c.json(view);
  });
  for (const [path,supplier] of [['distribution-selections',false],['supply-requests',true]] as const) app.get(root+'/'+path, async c => {
    EmptyStoreInputSchema.parse(singleQuery(c)); const [t,i] = ids(c);
    return c.json(await listDistributions(pool,c.get('actor'),t,i,supplier));
  });
  app.post(root+'/distribution-selections',async c => {
    EmptyStoreInputSchema.parse(singleQuery(c)); const [t,i] = ids(c), h = commandHeaders(c,false);
    const view = await proposeDistribution(pool,c.get('actor'),t,i,DistributionInputSchema.parse(await c.req.json()),h.key);
    etag(c,view.version); return c.json(view,201);
  });
  app.patch(root+'/distribution-selections/:selection_id',async c => {
    EmptyStoreInputSchema.parse(singleQuery(c)); const [t,i] = ids(c), h = commandHeaders(c,true);
    const view = await proposeDistribution(pool,c.get('actor'),t,i,DistributionInputSchema.parse(await c.req.json()),h.key,OpaqueId.parse(c.req.param('selection_id')),h.expected!);
    etag(c,view.version); return c.json(view);
  });
  app.post(root+'/supply-requests/:selection_id/decision',async c => {
    EmptyStoreInputSchema.parse(singleQuery(c)); const [t,i] = ids(c), h = commandHeaders(c,true);
    const view = await decideDistribution(pool,c.get('actor'),t,i,OpaqueId.parse(c.req.param('selection_id')),DistributionDecisionSchema.parse(await c.req.json()),h.key,h.expected!);
    etag(c,view.version); return c.json(view);
  });
  app.post(root+'/distribution-selections/:selection_id/withdraw',async c => {
    EmptyStoreInputSchema.parse(singleQuery(c)); EmptyStoreInputSchema.parse(await c.req.json()); const [t,i] = ids(c), h = commandHeaders(c,true);
    const view = await withdrawDistribution(pool,c.get('actor'),t,i,OpaqueId.parse(c.req.param('selection_id')),h.key,h.expected!);
    etag(c,view.version); return c.json(view);
  });
  return app;
}
