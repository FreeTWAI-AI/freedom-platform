import { Hono } from 'hono';
import { z } from 'zod';
import type { Pool } from 'pg';
import { moduleCommand, type PlatformEnv } from '../module-context.js';
import { createProduct, createOfferVersion, listSupplierProducts, listCatalogProducts, createStore, listStores, createListing, listListings, requestSupply, listSupplyRequests, decideSupply } from '../../../../modules/catalog-commerce/service.js';

export function createCommerceRoutes(pool:Pool){
  const app=new Hono<PlatformEnv>();
  const id=(value:string)=>z.uuid().parse(value.split(':')[0]);
  app.get('/supplier/products',async c=>c.json({items:await listSupplierProducts(pool,c.get('actor'))}));
  app.post('/supplier/products',async c=>c.json(await createProduct(pool,await moduleCommand(c)),201));
  app.post('/supplier/products/:id/offer-versions',async c=>c.json(await createOfferVersion(pool,await moduleCommand(c),id(c.req.param('id'))),201));
  app.get('/retail/catalog',async c=>c.json(await listCatalogProducts(pool,c.get('actor'),c.req.query())));
  app.get('/retail/stores',async c=>c.json({items:await listStores(pool,c.get('actor'))}));
  app.post('/retail/stores',async c=>c.json(await createStore(pool,await moduleCommand(c)),201));
  app.get('/retail/listings',async c=>c.json({items:await listListings(pool,c.get('actor'))}));
  app.post('/retail/listings',async c=>c.json(await createListing(pool,await moduleCommand(c)),201));
  app.post('/retail/listings/:id{[0-9a-f-]+:request-supply}',async c=>c.json(await requestSupply(pool,await moduleCommand(c),id(c.req.param('id')))));
  app.get('/supplier/requests',async c=>c.json({items:await listSupplyRequests(pool,c.get('actor'))}));
  app.post('/supplier/requests/:id{[0-9a-f-]+:decide}',async c=>c.json(await decideSupply(pool,await moduleCommand(c),id(c.req.param('id')))));
  return app;
}
