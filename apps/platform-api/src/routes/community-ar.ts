import {Hono} from 'hono';
import type {Pool} from 'pg';
import type {ObjectStore} from '../../../../packages/asset-storage/index.js';
import {readBounded} from '../../../../packages/asset-storage/index.js';
import {AR_EXPERIENCE_MAX_BYTES} from '../../../../packages/asset-storage/ar-target.js';
import {requireCondition,Problem} from '../../../../packages/shared/problem.js';
import {OpaqueId} from '../../../../contracts/common/v1/identity.js';
import {createArTarget,changeArTarget,listOwnArTargets,listArScene,readPublicAr,readPublicArPattern} from '../../../../modules/community-ar/index.js';
import {uploadArPattern} from '../../../../modules/community-ar/assets.js';
import {authRateLimit} from '../../../../modules/identity-membership/members.js';
import {moduleCommand,type PlatformEnv} from '../module-context.js';

export const isArUpload=(method:string,path:string)=>method==='PUT'&&/^\/api\/v1\/ar\/targets\/[0-9a-f-]{36}\/pattern$/.test(path);
export function checkArUploadHeaders(mime?:string,length?:string){
  requireCondition(mime==='application/octet-stream',415,'ar_pattern_format','請選擇完整的 AR 圖案辨識檔。');
  requireCondition(length===undefined||/^\d+$/.test(length)&&Number(length)<=AR_EXPERIENCE_MAX_BYTES,413,'ar_pattern_size','圖案辨識檔不可超過 20 MB。');
}
export function createPublicArRoutes(pool:Pool,store:ObjectStore){
  const app=new Hono();
  app.use('/public/ar/*',async(c,next)=>{c.header('Cache-Control','no-store');c.header('Cross-Origin-Resource-Policy','same-origin');c.header('X-Content-Type-Options','nosniff');await next();});
  app.get('/public/ar/:token',async c=>c.json(await readPublicAr(pool,c.req.param('token'))));
  app.get('/public/ar/:token/pattern',async c=>{const bytes=await readPublicArPattern(pool,c.req.param('token'),store);c.header('Content-Type','application/octet-stream');return c.body(new Uint8Array(bytes));});
  return app;
}
export function createMemberArRoutes(pool:Pool,store:ObjectStore){
  const app=new Hono<PlatformEnv>();
  app.get('/ar/targets',async c=>c.json(await listOwnArTargets(pool,c.get('actor'))));
  app.get('/ar/scene',async c=>c.json(await listArScene(pool,c.get('actor'),c.req.query('event'))));
  app.post('/ar/targets',async c=>c.json(await createArTarget(pool,await moduleCommand(c)),201));
  app.put('/ar/targets/:id/pattern',async c=>{
    const id=OpaqueId.parse(c.req.param('id'));checkArUploadHeaders(c.req.header('Content-Type'),c.req.header('Content-Length'));
    const match=c.req.header('If-Match');requireCondition(match&&/^"[1-9][0-9]{0,18}"$/.test(match),428,'version_required','請重新載入圖案後再上傳。');
    const key=c.req.header('Idempotency-Key')??'';requireCondition(/^[A-Za-z0-9_-]{8,128}$/.test(key),400,'idempotency_required','操作識別碼無效。');
    requireCondition(c.req.raw.body,422,'ar_pattern_required','請先選擇圖案。');
    await authRateLimit(pool,'ar-pattern-owner',c.get('actor').user_id,12,60);
    const bytes=await readBounded(c.req.raw.body,AR_EXPERIENCE_MAX_BYTES);
    try{return c.json(await uploadArPattern(pool,store,c.get('actor'),id,match.slice(1,-1),key,bytes));}
    catch(error){if(error instanceof Error&&error.message==='invalid_ar_target')throw new Problem(422,'ar_pattern_invalid','圖案辨識檔無法使用，請重新編譯圖片。');throw error;}
  });
  for(const action of ['publish','withdraw'] as const)app.post(`/ar/targets/:id/${action}`,async c=>c.json(await changeArTarget(pool,await moduleCommand(c),c.req.param('id'),action==='publish')));
  return app;
}
