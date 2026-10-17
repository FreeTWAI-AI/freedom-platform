import {Hono} from 'hono';
import type {Pool} from 'pg';
import {OpaqueId} from '../../../../contracts/common/v1/identity.js';
import {EmptyStoreInputSchema} from '../../../../contracts/guild-launchpad/v1/storefront.js';
import {SupplyProfileUpdateInputSchema,SupplierReservationQuerySchema,SupplierChangesQuerySchema,SupplierReportQuerySchema} from '../../../../contracts/guild-launchpad/v1/supplier-console.js';
import {readSupplierOverview,readSupplierSummary,listSupplierProducts,readSupplierProduct,listSupplierPartners,readSupplierPartner,readSupplierRequest} from '../../../../modules/agent-commerce/supplier-console/reads.js';
import {listSupplierConsoleReservations,readSupplierConsoleReservation} from '../../../../modules/agent-commerce/supplier-console/reservations.js';
import {readSupplierReport,readSupplierReportCsv} from '../../../../modules/agent-commerce/supplier-console/report.js';
import {readSupplierChanges} from '../../../../modules/agent-commerce/supplier-console/changes.js';
import type {TenantListCursorCodec} from '../../../../packages/shared/tenant-list-cursor.js';
import {requireCondition} from '../../../../packages/shared/problem.js';
import {updateSupplyProfile} from '../../../../modules/agent-commerce/hosted/supply-catalog.js';
import type {PlatformEnv} from '../module-context.js';
import {privateCache,singleQuery,commandHeaders,etag} from './tenant-http.js';

export function createHostedSupplierConsoleRoutes(pool:Pool,options:{cursors?:TenantListCursorCodec}={}) {
  const app=new Hono<PlatformEnv>();
  app.use('*',async(c,next)=>{try{await next();}finally{privateCache(c);}});
  const root='/tenants/:tenant_id/storefronts/:instance_id';
  const ids=(c:Parameters<typeof singleQuery>[0])=>[OpaqueId.parse(c.req.param('tenant_id')),OpaqueId.parse(c.req.param('instance_id'))] as const;
  app.get(root+'/supplier-console/reservations',async c=>{
    const raw=singleQuery(c);
    if(raw.limit!==undefined)requireCondition(/^[1-9][0-9]?$/.test(raw.limit),422,'validation_failed','頁面大小無效。');
    const query=SupplierReservationQuerySchema.parse({...raw,...(raw.limit===undefined?{}:{limit:Number(raw.limit)})}),[t,i]=ids(c);
    return c.json(await listSupplierConsoleReservations(pool,c.get('actor'),t,i,query,options.cursors));
  });
  app.get(root+'/supplier-console/reservations/:order_id',async c=>{
    EmptyStoreInputSchema.parse(singleQuery(c));const [t,i]=ids(c);
    return c.json(await readSupplierConsoleReservation(pool,c.get('actor'),t,i,OpaqueId.parse(c.req.param('order_id'))));
  });
  app.get(root+'/supplier-console/changes',async c=>{
    const query=SupplierChangesQuerySchema.parse(singleQuery(c)),[t,i]=ids(c);
    return c.json(await readSupplierChanges(pool,c.get('actor'),t,i,query));
  });
  app.get(root+'/supplier-console/report',async c=>{
    const query=SupplierReportQuerySchema.parse(singleQuery(c)),[t,i]=ids(c);
    return c.json(await readSupplierReport(pool,c.get('actor'),t,i,query));
  });
  app.get(root+'/supplier-console/report.csv',async c=>{
    const query=SupplierReportQuerySchema.parse(singleQuery(c)),[t,i]=ids(c);
    const file=await readSupplierReportCsv(pool,c.get('actor'),t,i,query);
    return c.body(file.body,200,{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':`attachment; filename="${file.filename}"`});
  });
  app.get(root+'/supplier-console/summary',async c=>{
    EmptyStoreInputSchema.parse(singleQuery(c));const [t,i]=ids(c);
    return c.json(await readSupplierSummary(pool,c.get('actor'),t,i));
  });
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
  app.get(root+'/supplier-console/requests/:selection_id',async c=>{
    EmptyStoreInputSchema.parse(singleQuery(c));const [t,i]=ids(c);
    return c.json(await readSupplierRequest(pool,c.get('actor'),t,i,OpaqueId.parse(c.req.param('selection_id'))));
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
