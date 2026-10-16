import {Hono} from 'hono';
import type {Pool} from 'pg';
import {OpaqueId} from '../../../../contracts/guild-launchpad/v1/primitives.js';
import * as wire from '../../../../contracts/guild-launchpad/v1/hosted-shipping.js';
import {ShippingSettingsProblem} from '../../../../modules/agent-commerce/fulfilment/settings/command.js';
import {listShipFromLocations,readShipFromLocation,createShipFromLocation,retireShipFromLocation} from '../../../../modules/agent-commerce/fulfilment/settings/locations.js';
import {readShippingProfile,saveShippingProfile,type ShippingEnvironment} from '../../../../modules/agent-commerce/fulfilment/settings/profile.js';
import {readItemShippingAttributes,saveItemShippingAttributes} from '../../../../modules/agent-commerce/fulfilment/settings/attributes.js';
import type {PlatformEnv} from '../module-context.js';
import {commandHeaders,etag,privateCache,singleQuery} from './tenant-http.js';
export function createHostedShippingRoutes(pool:Pool,{environment}:{environment:ShippingEnvironment}){
  const app=new Hono<PlatformEnv>();
  const root='/tenants/:tenant_id/storefronts/:instance_id';
  for(const suffix of ['/ship-from-locations','/ship-from-locations/:location_id','/ship-from-locations/:location_id/retire','/shipping-profile','/products/:product_id/shipping-attributes'])app.use(root+suffix,async(c,next)=>{try{wire.ShippingEmptyInputSchema.parse(singleQuery(c));await next();}finally{privateCache(c);}});
  app.onError((error,c)=>{
    if(!(error instanceof ShippingSettingsProblem))throw error;
    privateCache(c);return c.json(wire.ShippingErrorSchema.parse({type:'about:blank',title:error.code,status:error.status,code:error.code,detail:error.message,fields:error.fields}),error.status as 422);
  });
  const ids=(c:Parameters<typeof singleQuery>[0])=>[OpaqueId.parse(c.req.param('tenant_id')),OpaqueId.parse(c.req.param('instance_id'))] as const;
  app.get(root+'/ship-from-locations',async c=>{const [t,i]=ids(c);return c.json(wire.ShipFromLocationPageSchema.parse(await listShipFromLocations(pool,c.get('actor'),t,i)));});
  app.get(root+'/ship-from-locations/:location_id',async c=>{const [t,i]=ids(c);return c.json(wire.ShipFromLocationSchema.parse(await readShipFromLocation(pool,c.get('actor'),t,i,OpaqueId.parse(c.req.param('location_id')))));});
  app.post(root+'/ship-from-locations',async c=>{const h=commandHeaders(c,false),[t,i]=ids(c);return c.json(wire.ShipFromLocationSchema.parse(await createShipFromLocation(pool,c.get('actor'),t,i,await c.req.json(),h.key,environment)),201);});
  app.post(root+'/ship-from-locations/:location_id/retire',async c=>{const h=commandHeaders(c,false),[t,i]=ids(c);return c.json(wire.ShipFromLocationSchema.parse(await retireShipFromLocation(pool,c.get('actor'),t,i,OpaqueId.parse(c.req.param('location_id')),await c.req.json(),h.key)));});
  app.get(root+'/shipping-profile',async c=>{const [t,i]=ids(c),view=wire.ShippingProfileViewSchema.parse(await readShippingProfile(pool,c.get('actor'),t,i,environment));if(view.version)etag(c,view.version);return c.json(view);});
  app.put(root+'/shipping-profile',async c=>{const h=commandHeaders(c,c.req.header('If-Match')!==undefined),[t,i]=ids(c),view=wire.ShippingProfileViewSchema.parse(await saveShippingProfile(pool,c.get('actor'),t,i,await c.req.json(),h.key,h.expected,environment));if(view.version)etag(c,view.version);return c.json(view,view.version==='1'?201:200);});
  app.get(root+'/products/:product_id/shipping-attributes',async c=>{const [t,i]=ids(c),view=wire.ItemShippingAttributesSchema.parse(await readItemShippingAttributes(pool,c.get('actor'),t,i,OpaqueId.parse(c.req.param('product_id'))));if(view.version)etag(c,view.version);return c.json(view);});
  app.put(root+'/products/:product_id/shipping-attributes',async c=>{const h=commandHeaders(c,c.req.header('If-Match')!==undefined),[t,i]=ids(c),view=wire.ItemShippingAttributesSchema.parse(await saveItemShippingAttributes(pool,c.get('actor'),t,i,OpaqueId.parse(c.req.param('product_id')),await c.req.json(),h.key,h.expected));if(view.version)etag(c,view.version);return c.json(view,view.version==='1'?201:200);});
  return app;
}
