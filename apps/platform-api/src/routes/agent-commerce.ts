import {cancelShopOrder} from '../../../../modules/agent-commerce/service-command.js';
import type {ShopServiceHost} from '../../../../packages/resource-scopes/shop-service.js';
import {Hono} from 'hono';
import type {Pool} from 'pg';
import {z} from 'zod';
import {moduleCommand,type PlatformEnv} from '../module-context.js';
import {requireCondition} from '../../../../packages/shared/problem.js';
import {authRateLimit} from '../../../../modules/identity-membership/members.js';
import {catalog,ownShops,previewImport,importShop,fetchManifest} from '../../../../modules/agent-commerce/imports.js';
import {parseManifestFile} from '../../../../modules/agent-commerce/schema.js';
import {agentKit} from '../../../../modules/agent-commerce/kit.js';
import {issueKey,revokeKey,machine,createOrder,orderView,shopOrders,payment,setPaymentUrl,recordShipment,memberOrders,setAcceptingOrders} from '../../../../modules/agent-commerce/orders.js';
import {decideAcceptance,listAcceptances} from '../../../../modules/agent-commerce/distribution.js';

export function createAgentCommerceRoutes(pool:Pool,origin:string,host:ShopServiceHost){
 const app=new Hono<PlatformEnv>();
 app.get('/commerce/catalog',async c=>c.json({items:await catalog(pool,c.get('actor'))}));
 app.get('/commerce/shops',async c=>c.json({items:await ownShops(pool,c.get('actor'))}));
 app.post('/commerce/preview',async c=>{
  await authRateLimit(pool,'commerce-import-preview',c.get('actor').user_id,20,60);
  const body=z.union([z.object({content:z.string().max(24000)}).strict(),z.object({url:z.url().max(2000)}).strict()]).parse(await c.req.json());
  const manifest='url'in body?await fetchManifest(body.url):parseManifestFile(body.content);
  return c.json(await previewImport(pool,c.get('actor'),manifest));
 });
 app.post('/commerce/import',async c=>c.json(await importShop(pool,await moduleCommand(c)),201));
 app.post('/commerce/agent-kit',async c=>{
  const body=z.object({kind:z.enum(['internal','public']),item_ids:z.array(z.uuid()).max(50).default([])}).strict().parse(await c.req.json());
  const items=(await catalog(pool,c.get('actor'))).filter(i=>body.item_ids.includes(i.item_id));
  requireCondition(new Set(body.item_ids).size===body.item_ids.length&&items.length===body.item_ids.length,422,'selection_changed','商品清單已變更，請重新挑選。');
  requireCondition(body.kind==='internal'||items.length>0,422,'selection_required','請先挑選商品。');
  requireCondition(body.kind==='internal'||new Set(items.map(i=>i.mode)).size===1,422,'mode_mismatch','一次請選擇相同測試／正式模式的商品。');
  requireCondition(body.kind==='internal'||new Set(items.map(i=>i.currency)).size===1,422,'currency_mismatch','一次請選擇相同幣別的商品。');
  return c.json({filename:body.kind==='internal'?'我的內部商店.md':'我的公開商店.md',markdown:agentKit(body.kind,body.kind==='internal'?[]:items,origin)});
 });
 app.post('/commerce/shops/:id/accepting-orders',async c=>{const input=await moduleCommand(c);const body=z.object({accepting:z.boolean()}).strict().parse(input.body);return c.json(await setAcceptingOrders(pool,input,z.uuid().parse(c.req.param('id')),body.accepting));});
 app.post('/commerce/shops/:id/key',async c=>{const input=await moduleCommand(c);z.object({}).strict().parse(input.body);return c.json(await issueKey(pool,input,z.uuid().parse(c.req.param('id')),host));});
 app.post('/commerce/shops/:id/revoke-key',async c=>{const input=await moduleCommand(c);z.object({}).strict().parse(input.body);return c.json(await revokeKey(pool,input,z.uuid().parse(c.req.param('id'))));});
 app.get('/commerce/shops/:id/orders',async c=>c.json({items:await memberOrders(pool,c.get('actor'),z.uuid().parse(c.req.param('id')))}));
 app.get('/commerce/distribution-acceptances',async c=>c.json({items:await listAcceptances(pool,c.get('actor'))}));
 app.post('/commerce/selections/:id/distribution-acceptance',async c=>c.json(await decideAcceptance(pool,await moduleCommand(c),z.uuid().parse(c.req.param('id')))));
 app.post('/commerce/transfers/:id/shipment',async c=>c.json(await recordShipment(pool,await moduleCommand(c),z.uuid().parse(c.req.param('id')))));
 return app;
}
// Bearer only. No cookie/session impersonation. The global JSON size and Origin guards still apply.
export function createShopMachineRoutes(pool:Pool,host:ShopServiceHost){
 const app=new Hono();
 app.use('*',async(c,next)=>{c.header('Cache-Control','no-store');await next();});
 app.get('/connection',async c=>c.json(await machine(pool,host,c.req.header('Authorization'),async(q,shop)=>({shop_id:shop.shop_id,kind:shop.kind,currency:shop.currency,mode:shop.mode,accepting_orders:shop.accepting_orders,
  selections:shop.kind==='public'?(await q.query("SELECT selection_id,item_id,snapshot FROM commerce_selections WHERE shop_id=$1 AND acceptance_state='sellable'",[shop.shop_id])).rows:[]}))));
 app.get('/orders',async c=>{const offset=z.coerce.number().int().min(0).max(100000).parse(c.req.query('offset')??0);return c.json({items:await machine(pool,host,c.req.header('Authorization'),(q,s)=>shopOrders(q,s,offset)),offset,limit:100});});
 app.post('/orders',async c=>{const body=await c.req.json();return c.json(await machine(pool,host,c.req.header('Authorization'),(q,s)=>createOrder(q,s,body)),201);});
 app.get('/orders/:id',async c=>c.json(await machine(pool,host,c.req.header('Authorization'),(q,s)=>orderView(q,s,z.uuid().parse(c.req.param('id'))))));
 app.post('/orders/:id/cancel',async c=>{z.object({}).strict().parse(await c.req.json());return c.json(await cancelShopOrder(pool,host,c.req.header('Authorization'),z.uuid().parse(c.req.param('id'))));});
 app.post('/orders/:id/payment',async c=>{const body=await c.req.json();return c.json(await machine(pool,host,c.req.header('Authorization'),(q,s)=>payment(q,s,z.uuid().parse(c.req.param('id')),undefined,body)));});
 app.post('/orders/:id/transfers/:transfer/payment',async c=>{const body=await c.req.json();return c.json(await machine(pool,host,c.req.header('Authorization'),(q,s)=>payment(q,s,z.uuid().parse(c.req.param('id')),z.uuid().parse(c.req.param('transfer')),body)));});
 app.post('/transfers/:id/payment-link',async c=>{const body=z.object({url:z.string().max(2000)}).strict().parse(await c.req.json());return c.json(await machine(pool,host,c.req.header('Authorization'),(q,s)=>setPaymentUrl(q,s,z.uuid().parse(c.req.param('id')),body.url)));});
 return app;
}
export function createPublicShopRoutes(pool:Pool){
 const app=new Hono();
 app.get('/api/v1/public-shops/:id',async c=>{
  const shop=(await pool.query(`SELECT s.shop_id,s.name,s.description,s.website_url,s.contact,s.mode,s.accepting_orders FROM commerce_shops s JOIN users u ON u.user_id=s.owner_id
   WHERE s.shop_id=$1 AND s.kind='public' AND u.active`,[z.uuid().parse(c.req.param('id'))])).rows[0];
  requireCondition(shop,404,'shop_not_found','找不到公開商店。');return c.json(shop);
 });
 return app;
}
