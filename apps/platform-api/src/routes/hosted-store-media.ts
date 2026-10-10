import { Hono, type Context } from 'hono';
import type { Pool } from 'pg';
import { OpaqueId } from '../../../../contracts/guild-launchpad/v1/primitives.js';
import { RemoveProductPhotoInputSchema } from '../../../../contracts/guild-launchpad/v1/hosted-store-media.js';
import { AssetStorageError, readBounded } from '../../../../packages/asset-storage/index.js';
import { Problem, requireCondition } from '../../../../packages/shared/problem.js';
import { PRODUCT_PHOTO_POLICY } from '../../../../modules/agent-commerce/hosted/media.js';
import { uploadProductPhoto, removeProductPhoto } from '../../../../modules/agent-commerce/hosted/photo-commands.js';
import { listProductMedia, readPrivateProductPhoto, readPublicProductPhoto } from '../../../../modules/agent-commerce/hosted/photo-read.js';
import { readPublicStorePage } from '../../../../modules/agent-commerce/hosted/public.js';
import type { PlatformRuntime } from '../runtime.js';
import type { PlatformEnv } from '../module-context.js';
import { privateCache, singleQuery, commandHeaders, etag } from './tenant-http.js';

type PhotoRuntime=Pick<PlatformRuntime,'storePhotoAssets'|'storePhotoAssetStore'|'storePhotoUploadsEnabled'>;
export const storePhotosInstalled=(runtime:PhotoRuntime)=>Boolean(runtime.storePhotoAssetStore);
export const storePhotoUploadsInstalled=(runtime:PhotoRuntime)=>storePhotosInstalled(runtime)&&Boolean(runtime.storePhotoAssets)&&runtime.storePhotoUploadsEnabled===true;
export function isStorePhotoUpload(method:string,path:string){return method==='POST'&&/^\/api\/v1\/tenants\/[0-9A-Fa-f-]{36}\/storefronts\/[0-9A-Fa-f-]{36}\/products\/[0-9A-Fa-f-]{36}\/photo$/.test(path);}
export function checkStorePhotoHeaders(contentType?:string,contentLength?:string){
  requireCondition((PRODUCT_PHOTO_POLICY.input_content_types as readonly string[]).includes(contentType??''),415,'product_photo_format','請選擇 JPEG、PNG 或 WebP 照片。');
  if(contentLength!==undefined)requireCondition(/^\d+$/.test(contentLength)&&Number(contentLength)<=PRODUCT_PHOTO_POLICY.input_max_bytes,413,'product_photo_too_large','照片需為 2 MB 以下的檔案。');
}
async function sourceBytes(request:Request){
  requireCondition(request.body,422,'invalid_product_photo','請先選擇照片。');
  try{const bytes=await readBounded(request.body,PRODUCT_PHOTO_POLICY.input_max_bytes);requireCondition(bytes.length>0,422,'invalid_product_photo','請先選擇照片。');return Buffer.from(bytes);}
  catch(error){if(error instanceof AssetStorageError&&error.code==='too_large')throw new Problem(413,'product_photo_too_large','照片需為 2 MB 以下的檔案。');throw error;}
}
function imageResponse(c:Context<PlatformEnv>,bytes:Uint8Array){
  c.header('Content-Type','image/webp');c.header('X-Content-Type-Options','nosniff');c.header('Cache-Control','no-store');
  c.header('Content-Length',String(bytes.length));
  // HEAD executes both authority snapshots and full object verification too.
  return c.req.method==='HEAD'?c.body(null):c.body(bytes as Uint8Array<ArrayBuffer>);
}
export function createHostedStoreMediaRoutes(pool:Pool,runtime:PhotoRuntime){
  const app=new Hono<PlatformEnv>(),root='/tenants/:tenant_id/storefronts/:instance_id';
  for(const path of [root+'/product-media',root+'/products/:product_id/photo',root+'/products/:product_id/photo/*']) app.use(path,async(c,next)=>{try{requireCondition(storePhotosInstalled(runtime),404,'not_found','找不到這個頁面。');await next();}finally{privateCache(c);}});
  const ids=(c:Context<PlatformEnv>)=>[OpaqueId.parse(c.req.param('tenant_id')),OpaqueId.parse(c.req.param('instance_id'))] as const;
  app.get(root+'/product-media',async c=>{RemoveProductPhotoInputSchema.parse(singleQuery(c));const[t,i]=ids(c);return c.json(await listProductMedia(pool,c.get('actor'),t,i));});
  app.post(root+'/products/:product_id/photo',async c=>{
    RemoveProductPhotoInputSchema.parse(singleQuery(c));checkStorePhotoHeaders(c.req.header('Content-Type'),c.req.header('Content-Length'));
    const h=commandHeaders(c,true),[t,i]=ids(c),productId=OpaqueId.parse(c.req.param('product_id'));
    const view=await uploadProductPhoto(pool,c.get('actor'),t,i,productId,h.key,h.expected!,{bytes:await sourceBytes(c.req.raw),mime:c.req.header('Content-Type')!},runtime.storePhotoAssets,runtime.storePhotoUploadsEnabled===true);
    etag(c,view.current.version);return c.json(view);
  });
  app.post(root+'/products/:product_id/photo/remove',async c=>{
    RemoveProductPhotoInputSchema.parse(singleQuery(c));RemoveProductPhotoInputSchema.parse(await c.req.json());const h=commandHeaders(c,true),[t,i]=ids(c);
    const view=await removeProductPhoto(pool,c.get('actor'),t,i,OpaqueId.parse(c.req.param('product_id')),h.key,h.expected!);etag(c,view.current.version);return c.json(view);
  });
  app.on(['GET','HEAD'],root+'/products/:product_id/photo/:version',async c=>{
    RemoveProductPhotoInputSchema.parse(singleQuery(c));const[t,i]=ids(c);
    return imageResponse(c,await readPrivateProductPhoto(pool,runtime.storePhotoAssetStore!,c.get('actor'),t,i,c.req.param('product_id')!,c.req.param('version')!));
  });
  return app;
}
export function createPublicHostedStoreMediaRoutes(pool:Pool,runtime:PhotoRuntime){
  const app=new Hono<PlatformEnv>();
  for(const path of ['/api/v1/public/stores/:slug/media','/shops/:slug/media/:revision/:sku']) app.use(path,async(c,next)=>{c.header('Cache-Control','no-store');c.header('X-Robots-Tag','noindex');requireCondition(storePhotosInstalled(runtime),404,'not_found','找不到這個頁面。');await next();});
  app.get('/api/v1/public/stores/:slug/media',async c=>{
    RemoveProductPhotoInputSchema.parse(singleQuery(c));const page=await readPublicStorePage(pool,c.req.param('slug'));
    requireCondition(page,404,'not_found','找不到這間商店。');return c.json(page.media);
  });
  app.on(['GET','HEAD'],'/shops/:slug/media/:revision/:sku',async c=>{
    RemoveProductPhotoInputSchema.parse(singleQuery(c));const bytes=await readPublicProductPhoto(pool,runtime.storePhotoAssetStore!,c.req.param('slug'),c.req.param('revision'),c.req.param('sku'));
    requireCondition(bytes,404,'not_found','找不到這張商品照片。');return imageResponse(c,bytes);
  });
  return app;
}
