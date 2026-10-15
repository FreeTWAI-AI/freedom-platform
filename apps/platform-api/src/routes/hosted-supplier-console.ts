import {Hono} from 'hono';
import type {Pool} from 'pg';
import {OpaqueId} from '../../../../contracts/common/v1/identity.js';
import {EmptyStoreInputSchema} from '../../../../contracts/guild-launchpad/v1/storefront.js';
import {SupplyProfileUpdateInputSchema} from '../../../../contracts/guild-launchpad/v1/supplier-console.js';
import {readSupplierOverview,listSupplierProducts,readSupplierProduct,listSupplierPartners,readSupplierPartner} from '../../../../modules/agent-commerce/supplier-console/reads.js';
import {updateSupplyProfile} from '../../../../modules/agent-commerce/hosted/supply-catalog.js';
import type {PlatformEnv} from '../module-context.js';
import {privateCache,singleQuery,commandHeaders,etag} from './tenant-http.js';

export function createHostedSupplierConsoleRoutes(pool:Pool) {
  const app=new Hono<PlatformEnv>();
  app.use('*',async(c,next)=>{try{await next();}finally{privateCache(c);}});
  const root='/tenants/:tenant_id/storefronts/:instance_id';
  const ids=(c:Parameters<typeof singleQuery>[0])=>[OpaqueId.parse(c.req.param('tenant_id')),OpaqueId.parse(c.req.param('instance_id'))] as const;
  app.get(root+'/supplier-console/overview',async c=>{
    EmptyStoreInputSchema.parse(singleQuery(c));const [t,i]=ids(c);
    return c.json(await readSupplierOverview(pool,c.get('actor'),t,i));
  });
  app.get(root+'/supplier-console/products',async c=>{
    EmptyStoreInputSchema.parse(singleQuery(c));const [t,i]=ids(c);
    return c.json(await listSupplierProducts(pool,c.get('actor'),t,i));
  });
  app.get(root+'/supplier-console/products/:product_id',async c=>{
    EmptyStoreInputSchema.parse(singleQuery(c));const [t,i]=ids(c);
    return c.json(await readSupplierProduct(pool,c.get('actor'),t,i,OpaqueId.parse(c.req.param('product_id'))));
  });
  app.get(root+'/supplier-console/partners',async c=>{
    EmptyStoreInputSchema.parse(singleQuery(c));const [t,i]=ids(c);
    return c.json(await listSupplierPartners(pool,c.get('actor'),t,i));
  });
  app.get(root+'/supplier-console/partners/:partner_id',async c=>{
    EmptyStoreInputSchema.parse(singleQuery(c));const [t,i]=ids(c);
    return c.json(await readSupplierPartner(pool,c.get('actor'),t,i,OpaqueId.parse(c.req.param('partner_id'))));
  });
  app.patch(root+'/supply-profile',async c=>{
    EmptyStoreInputSchema.parse(singleQuery(c));const h=commandHeaders(c,true),[t,i]=ids(c);
    const receipt=await updateSupplyProfile(pool,c.get('actor'),t,i,SupplyProfileUpdateInputSchema.parse(await c.req.json()),h.key,h.expected!);
    etag(c,receipt.version);return c.json(receipt);
  });
  return app;
}
