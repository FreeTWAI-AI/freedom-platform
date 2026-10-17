import {createHash} from 'node:crypto';
import {Hono,type Context} from 'hono';
import type {Pool} from 'pg';
import {OpaqueId} from '../../../../contracts/guild-launchpad/v1/primitives.js';
import {DistributionPhotosSchema,DistributionPhotoCommandSchema,DistributionPhotoUseInputSchema,SupplyMaterialEmptyInputSchema} from '../../../../contracts/guild-launchpad/v1/supplier-console.js';
import {createStorefrontDistributionPhotoLifecycle} from '../../../../modules/assets/storefront-distribution-photo.js';
import {listDistributionPhotos,useDistributionPhoto,detachDistributionPhoto,readDistributionPhoto} from '../../../../modules/agent-commerce/supplier-console/distribution-photos.js';
import {supplyMaterialMediaInstalled} from './hosted-supply-material-media.js';
import {storePhotosInstalled} from './hosted-store-media.js';
import {Problem} from '../../../../packages/shared/problem.js';
import type {PlatformRuntime} from '../runtime.js';
import type {PlatformEnv} from '../module-context.js';
import {singleQuery,commandHeaders,etag} from './tenant-http.js';
export function distributionPhotosInstalled(runtime:PlatformRuntime) {
 return runtime.guildLaunchpadEnabled===true && runtime.supplierConsoleEnabled===true && runtime.distributionPhotosEnabled===true
  && supplyMaterialMediaInstalled(runtime) && storePhotosInstalled(runtime);
}
function headers(c:Context<PlatformEnv>) {
 if(c.req.header('If-Match')==='"0"') {
  const key=c.req.header('Idempotency-Key')??'';
  if(!/^[A-Za-z0-9_-]{8,128}$(?![\s\S])/.test(key))throw new Problem(400,'idempotency_required','請提供有效的 Idempotency-Key。');
  return {key,expected:'0'};
 }
 return commandHeaders(c,true);
}
export function createHostedDistributionPhotoRoutes(pool:Pool,runtime:PlatformRuntime) {
 const app=new Hono<PlatformEnv>(),root='/tenants/:tenant_id/storefronts/:instance_id/distribution-photos';
 const assets=runtime.storePhotoAssets&&runtime.storePhotoAssetStore&&runtime.supplyMaterialAssetStore?
  {lifecycle:createStorefrontDistributionPhotoLifecycle(pool,{store:runtime.storePhotoAssetStore}),sourceStore:runtime.supplyMaterialAssetStore}:undefined;
 const ids=(c:Context<PlatformEnv>)=>[OpaqueId.parse(c.req.param('tenant_id')),OpaqueId.parse(c.req.param('instance_id'))] as const;
 app.get(root,async c=>{SupplyMaterialEmptyInputSchema.parse(singleQuery(c));const[t,i]=ids(c);
  return c.json(DistributionPhotosSchema.parse(await listDistributionPhotos(pool,c.get('actor'),t,i)));});
 app.post(root+'/:product_id/use',async c=>{SupplyMaterialEmptyInputSchema.parse(singleQuery(c));const h=headers(c),[t,i]=ids(c);
  const result=DistributionPhotoCommandSchema.parse(await useDistributionPhoto(pool,c.get('actor'),t,i,OpaqueId.parse(c.req.param('product_id')),
   DistributionPhotoUseInputSchema.parse(await c.req.json()),h.key,h.expected!,assets,runtime.storePhotoUploadsEnabled===true));
  etag(c,result.current.version);return c.json(result);});
 app.post(root+'/:product_id/detach',async c=>{SupplyMaterialEmptyInputSchema.parse(singleQuery(c));SupplyMaterialEmptyInputSchema.parse(await c.req.json());
  const h=headers(c),[t,i]=ids(c),result=DistributionPhotoCommandSchema.parse(await detachDistributionPhoto(pool,c.get('actor'),t,i,OpaqueId.parse(c.req.param('product_id')),h.key,h.expected!));
  etag(c,result.current.version);return c.json(result);});
 app.on(['GET','HEAD'],root+'/:product_id/photo/:version',async c=>{SupplyMaterialEmptyInputSchema.parse(singleQuery(c));const[t,i]=ids(c);
  const bytes=await readDistributionPhoto(pool,runtime.storePhotoAssetStore!,c.get('actor'),t,i,c.req.param('product_id')!,c.req.param('version')!);
  c.header('Content-Type','image/webp');c.header('Content-Length',String(bytes.length));c.header('Content-Disposition','inline');
  etag(c,createHash('sha256').update(bytes).digest('hex'));return c.req.method==='HEAD'?c.body(null):c.body(bytes as Uint8Array<ArrayBuffer>);});
 return app;
}
