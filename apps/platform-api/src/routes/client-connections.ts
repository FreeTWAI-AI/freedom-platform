import { Hono,type Context } from 'hono';
import type { Pool } from 'pg';
import { z } from 'zod';
import { requireCondition } from '../../../../packages/shared/problem.js';
import { moduleCommand,type PlatformEnv } from '../module-context.js';
import { startClientPairing,pollClientPairing,pairingView,approveClientPairing,listClientConnections,revokeClientConnection,readClientResource } from '../../../../modules/client-connections/service.js';

// Mount under /api/v1 before browser session middleware. Same-origin JSON safety and body bounds remain global.
export function createPublicClientConnectionRoutes(pool:Pool,origin:string,network:(c:Context)=>string){
 const app=new Hono();
 app.post('/client-connections/start',async c=>c.json(await startClientPairing(pool,await c.req.json(),origin,network(c)),201));
 app.post('/client-connections/poll',async c=>{
   const result=await pollClientPairing(pool,await c.req.json(),network(c));
   if(result.status==='slow_down'){c.header('Retry-After','5');return c.json(result,429);}
   return c.json(result,result.status==='invalid_grant'?400:200);
 });
 return app;
}
// Mount under /api/v1 after browser session/CSRF/onboarding middleware.
export function createClientConnectionRoutes(pool:Pool){
 const app=new Hono<PlatformEnv>();
 app.get('/client-connections/:code',async c=>c.json(await pairingView(pool,c.get('actor'),c.req.param('code'))));
 app.post('/client-connections/:code/approve',async c=>c.json(await approveClientPairing(pool,await moduleCommand(c),c.req.param('code'))));
 app.get('/me/client-connections',async c=>c.json({items:await listClientConnections(pool,c.get('actor'))}));
 app.post('/me/client-connections/:id/revoke',async c=>c.json(await revokeClientConnection(pool,await moduleCommand(c),c.req.param('id'))));
 return app;
}
// Mount at /client-api/v1; no cookie is accepted and no browser session is created.
export function createClientApiRoutes(pool:Pool){
 const app=new Hono();
 app.use('*',async(c,next)=>{
   c.header('Cache-Control','no-store');
   requireCondition(c.req.method==='GET',405,'client_read_only','讀取連線不能修改資料；請回自由工坊網站操作。');
   requireCondition(Object.keys(c.req.query()).length===0,422,'client_query_unsupported','目前讀取端點不接受額外查詢參數。');
   await next();
 });
 app.get('/connection',async c=>c.json(await readClientResource(pool,c.req.header('Authorization'),'connection')));
 for(const [path,resource] of [['/retail/catalog','catalog'],['/retail/stores','stores'],['/retail/listings','listings'],['/supplier/products','products'],['/supplier/requests','requests']] as const)
   app.get(path,async c=>c.json(await readClientResource(pool,c.req.header('Authorization'),resource)));
 app.get('/retail/stores/:id',async c=>c.json(await readClientResource(pool,c.req.header('Authorization'),'stores',z.uuid().parse(c.req.param('id')))));
 app.get('/retail/stores/:id/listings',async c=>c.json(await readClientResource(pool,c.req.header('Authorization'),'listings',z.uuid().parse(c.req.param('id')))));
 app.all('*',c=>c.json({status:404,code:'client_route_not_found',detail:'這個端點不在讀取連線範圍內。'},404));
 return app;
}
