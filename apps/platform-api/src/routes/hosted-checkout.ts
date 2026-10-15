import {Hono} from 'hono';
import {z} from 'zod';
import type {Pool} from 'pg';
import * as wire from '../../../../contracts/guild-launchpad/v1/hosted-checkout.js';
import * as commands from '../../../../modules/agent-commerce/checkout/public-commands.js';
import {readShopCookie,orderAccessNotFound} from '../../../../modules/agent-commerce/checkout/access.js';
import {CheckoutStockUnavailable,UnresolvedCheckoutOrder} from '../../../../modules/agent-commerce/checkout/orders.js';
import {Problem,requireCondition} from '../../../../packages/shared/problem.js';
import {readSessionCookie} from '../session-cookie.js';
import type {PlatformRuntime} from '../runtime.js';
import type {FreedomEnv} from '../env.js';

/** Parsing and response mapping only. Store resolution, access and effects live
 * together in the domain transaction; there is no member middleware boundary. */
export function createHostedCheckoutRoutes(pool:Pool,origin:string,runtime:PlatformRuntime,environment:FreedomEnv) {
  const app=new Hono();
  const options:commands.HostedCheckoutOptions={origin,settings:runtime.commerceSettings,environment:environment==='public'?'live':'sandbox',...runtime.commercePorts};
  app.use('*',async(c,next)=>{c.header('Cache-Control','no-store');c.header('Referrer-Policy','no-referrer');await next();});
  app.onError((error,c)=>{
    if(error instanceof z.ZodError)error=new Problem(422,'validation_failed','結帳資料無效。');
    if(!(error instanceof Problem))throw error;
    if(error.retryAfterSeconds!==undefined)c.header('Retry-After',String(error.retryAfterSeconds));
    const value=wire.CheckoutErrorSchema.parse({type:'about:blank',title:error.code,status:error.status,code:error.code,detail:error.message,
      ...(error instanceof CheckoutStockUnavailable?{items:error.items}:{}),...(error instanceof UnresolvedCheckoutOrder?{order_ref:error.order_ref}:{})});
    return c.json(value,error.status as 404);
  });
  const access=(c:Parameters<PlatformRuntime['sourceNetwork']>[0]):commands.BrowserAccess=>({
    deviceToken:readShopCookie(c.req.header('Cookie'),origin),sessionToken:readSessionCookie(c.req.header('Cookie'),origin),network:(runtime.rateLimitNetwork??runtime.sourceNetwork)(c),
  });
  const noQuery=(url:string)=>requireCondition(new URL(url).search==='',422,'validation_failed','不接受查詢參數。');
  const root='/api/v1/public/stores/:slug';
  app.post(root+'/cart-quotes',async c=>{
    commands.checkoutGate(options);noQuery(c.req.url);const input=wire.CartQuoteInputSchema.parse(await c.req.json());
    return c.json(wire.CartQuoteResponseSchema.parse(await commands.quotePublicCart(pool,c.req.param('slug')!,input,access(c),options)));
  });
  app.post(root+'/checkouts',async c=>{
    commands.checkoutGate(options);noQuery(c.req.url);const input=wire.CheckoutInputSchema.parse(await c.req.json()),key=c.req.header('Idempotency-Key')??'';
    requireCondition(/^[A-Za-z0-9_-]{22,128}$/.test(key),422,'invalid_idempotency_key','冪等鍵無效。');
    const result=await commands.createPublicCheckout(pool,c.req.param('slug')!,input,key,access(c),options);
    c.header('Set-Cookie',result.cookie);return c.json(wire.CheckoutResponseSchema.parse(result.value),result.created?201:200);
  });
  app.post(root+'/checkouts/:checkout_ref/orders',async c=>{
    commands.checkoutGate(options);noQuery(c.req.url);const input=wire.PlaceOrderInputSchema.parse(await c.req.json());
    const result=await commands.placePublicOrder(pool,c.req.param('slug')!,c.req.param('checkout_ref')!,input,access(c),options);
    return c.json(wire.PlaceOrderResponseSchema.parse(result.value),result.created?201:200);
  });
  app.get(root+'/orders/:order_ref',async c=>{
    noQuery(c.req.url);return c.json(wire.PublicOrderSchema.parse(await commands.readPublicOrder(pool,c.req.param('slug')!,c.req.param('order_ref')!,access(c),options)));
  });
  app.post(root+'/orders/:order_ref/access',async c=>{
    noQuery(c.req.url);commands.quarantineGate(options);
    const parsed=wire.RedeemAccessInputSchema.safeParse(await c.req.json());if(!parsed.success)orderAccessNotFound();
    const result=await commands.redeemPublicOrder(pool,c.req.param('slug')!,c.req.param('order_ref')!,parsed.data!.token,access(c),options);
    c.header('Set-Cookie',result.cookie);return c.json(wire.PublicOrderSchema.parse(result.value));
  });
  app.post(root+'/order-access-requests',async c=>{
    noQuery(c.req.url);const input=wire.AccessRequestInputSchema.parse(await c.req.json());
    await commands.requestPublicOrderAccess(pool,c.req.param('slug')!,input,access(c),options);wire.EmptyResponseSchema.parse(undefined);return c.body(null,202);
  });
  app.post('/api/v1/public/order-access/forget',async c=>{
    c.header('Set-Cookie',commands.clearShopCookie(options));noQuery(c.req.url);wire.ForgetAccessInputSchema.parse(await c.req.json());
    await commands.forgetPublicBrowser(pool,access(c),options);wire.EmptyResponseSchema.parse(undefined);return c.body(null,204);
  });
  return app;
}
