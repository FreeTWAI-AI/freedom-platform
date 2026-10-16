import {Hono} from 'hono';
import type {Pool} from 'pg';
import {OpaqueId} from '../../../../contracts/common/v1/identity.js';
import {EmptyStoreInputSchema} from '../../../../contracts/guild-launchpad/v1/storefront.js';
import {SupplyMaterialCreateInputSchema,SupplyMaterialUpdateInputSchema,SupplyMaterialCopyInputSchema,
  SupplyMaterialAccessInputSchema,SupplyMaterialGrantInputSchema,SupplyMaterialEmptyInputSchema} from '../../../../contracts/guild-launchpad/v1/supplier-console.js';
import {listSupplyMaterials,readSupplyMaterial,createSupplyMaterial,changeSupplyMaterial,listPartnerMaterials} from '../../../../modules/agent-commerce/supplier-console/materials.js';
import type {PlatformEnv} from '../module-context.js';
import {privateCache,singleQuery,commandHeaders,etag} from './tenant-http.js';

export function createHostedSupplyMaterialRoutes(pool:Pool) {
  const app=new Hono<PlatformEnv>();
  app.use('*',async(c,next)=>{try{await next();}finally{privateCache(c);}});
  const root='/tenants/:tenant_id/storefronts/:instance_id';
  const ids=(c:Parameters<typeof singleQuery>[0])=>[OpaqueId.parse(c.req.param('tenant_id')),OpaqueId.parse(c.req.param('instance_id'))] as const;
  app.get(root+'/supply-materials',async c=>{
    EmptyStoreInputSchema.parse(singleQuery(c));const [t,i]=ids(c);
    return c.json(await listSupplyMaterials(pool,c.get('actor'),t,i));
  });
  app.get(root+'/supply-materials/:material_id',async c=>{
    EmptyStoreInputSchema.parse(singleQuery(c));const [t,i]=ids(c);
    return c.json(await readSupplyMaterial(pool,c.get('actor'),t,i,OpaqueId.parse(c.req.param('material_id'))));
  });
  app.get(root+'/partner-materials',async c=>{
    EmptyStoreInputSchema.parse(singleQuery(c));const [t,i]=ids(c);
    return c.json(await listPartnerMaterials(pool,c.get('actor'),t,i));
  });
  app.post(root+'/supply-materials',async c=>{
    EmptyStoreInputSchema.parse(singleQuery(c));const h=commandHeaders(c,false),[t,i]=ids(c);
    const receipt=await createSupplyMaterial(pool,c.get('actor'),t,i,SupplyMaterialCreateInputSchema.parse(await c.req.json()),h.key);
    etag(c,receipt.version);return c.json(receipt,201);
  });
  app.patch(root+'/supply-materials/:material_id',async c=>{
    EmptyStoreInputSchema.parse(singleQuery(c));const h=commandHeaders(c,true),[t,i]=ids(c);
    const receipt=await changeSupplyMaterial(pool,c.get('actor'),t,i,OpaqueId.parse(c.req.param('material_id')),'update',
      SupplyMaterialUpdateInputSchema.parse(await c.req.json()),h.key,h.expected!);
    etag(c,receipt.version);return c.json(receipt);
  });
  for(const [suffix,change,schema] of [
    ['copy','copy',SupplyMaterialCopyInputSchema],['access','access',SupplyMaterialAccessInputSchema],
    ['grants','grant',SupplyMaterialGrantInputSchema],['withdraw','withdraw',SupplyMaterialEmptyInputSchema],
  ] as const)app.post(root+'/supply-materials/:material_id/'+suffix,async c=>{
    EmptyStoreInputSchema.parse(singleQuery(c));const h=commandHeaders(c,true),[t,i]=ids(c);
    const receipt=await changeSupplyMaterial(pool,c.get('actor'),t,i,OpaqueId.parse(c.req.param('material_id')),change,
      schema.parse(await c.req.json()),h.key,h.expected!);
    etag(c,receipt.version);return c.json(receipt);
  });
  app.post(root+'/supply-materials/:material_id/grants/:partner_id/revoke',async c=>{
    EmptyStoreInputSchema.parse(singleQuery(c));const h=commandHeaders(c,true),[t,i]=ids(c);
    const receipt=await changeSupplyMaterial(pool,c.get('actor'),t,i,OpaqueId.parse(c.req.param('material_id')),'revoke',
      SupplyMaterialEmptyInputSchema.parse(await c.req.json()),h.key,h.expected!,OpaqueId.parse(c.req.param('partner_id')));
    etag(c,receipt.version);return c.json(receipt);
  });
  return app;
}
