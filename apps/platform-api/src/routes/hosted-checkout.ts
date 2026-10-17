import {Hono} from 'hono';
import {z} from 'zod';
import type {Pool} from 'pg';
import * as wire from '../../../../contracts/guild-launchpad/v1/hosted-checkout.js';
import * as commands from '../../../../modules/agent-commerce/checkout/public-commands.js';
import {readShopCookie} from '../../../../modules/agent-commerce/checkout/access.js';
import {CheckoutStockUnavailable,UnresolvedCheckoutOrder} from '../../../../modules/agent-commerce/checkout/orders.js';
import {CheckoutDeliveryProblem} from '../../../../modules/agent-commerce/checkout/terms.js';
import {Problem,requireCondition} from '../../../../packages/shared/problem.js';
import {readSessionCookie} from '../session-cookie.js';
import type {PlatformRuntime} from '../runtime.js';
import type {FreedomEnv} from '../env.js';
import {providerEnvironment} from '../../../../modules/agent-commerce/operations/admissions.js';
import {runDueCommerceWork} from '../../../../modules/agent-commerce/operations/due-work.js';
import {commerceEmailOutbox} from '../../../../modules/agent-commerce/operations/notifications/outbox.js';
import type {PaymentQueryTransport} from '../../../../modules/agent-commerce/payments/query-transport.js';
import type {PaymentQueryDependencies} from '../../../../modules/agent-commerce/payments/queries.js';
import type {CommerceCredentialKeyring} from '../../../../modules/agent-commerce/payments/credentials.js';
import type {CommerceEmailOutbox} from '../../../../modules/agent-commerce/operations/notifications/email-port.js';

export function commerceCheckoutQueryDeps(input: {
  transport: PaymentQueryTransport;
  keyring: CommerceCredentialKeyring | null;
  freedomEnv: 'local' | 'staging' | 'public';
  quarantine?: boolean;
  emailEnabled?: boolean;
  email?: CommerceEmailOutbox;
}): PaymentQueryDependencies {
  const email = input.emailEnabled ? (input.email ?? commerceEmailOutbox) : undefined;
  return {
    transport: input.transport,
    keyring: input.keyring,
    freedomEnv: input.freedomEnv,
    quarantine: input.quarantine,
    ...(email ? { email } : {}),
  };
}

/** The one checkout configuration shared by the checkout API and the public store pages. */
export function hostedCheckoutOptions(origin:string,runtime:PlatformRuntime,environment:FreedomEnv):commands.HostedCheckoutOptions {
  const email=runtime.commerceSettings?.emailEnabled?(runtime.commercePorts?.email??commerceEmailOutbox):undefined;
  return {origin,settings:runtime.commerceSettings,environment:providerEnvironment(environment),...runtime.commercePorts,email};
}

/** Parsing and response mapping only. Store resolution, access and effects live
 * together in the domain transaction; there is no member middleware boundary. */
export function createHostedCheckoutRoutes(pool:Pool,origin:string,runtime:PlatformRuntime,environment:FreedomEnv) {
  const app=new Hono();
  const options=hostedCheckoutOptions(origin,runtime,environment);
  const root='/api/v1/public/stores/:slug';
  for(const path of [root+'/cart-quotes',root+'/checkouts',root+'/checkouts/:checkout_ref/orders',root+'/orders/:order_ref',root+'/orders/:order_ref/cancel',root+'/orders/:order_ref/payment-handoffs',root+'/orders/:order_ref/payment-queries',root+'/orders/:order_ref/access',root+'/order-access-requests','/api/v1/public/order-access/forget'])
    app.use(path,async(c,next)=>{c.header('Cache-Control','no-store');c.header('Referrer-Policy','no-referrer');await next();});
  app.onError((error,c)=>{
    if(!(error instanceof Problem)||!wire.CheckoutErrorCodeSchema.safeParse(error.code).success) {
      const code=error instanceof Problem?error.code:'';
      console.error('checkout_internal_error',/^[a-z][a-z0-9_]{0,63}$/.test(code)?code:'unknown');
      error=new Problem(500,'internal_error','結帳服務暫時無法使用。');
    }
    const problem=error as Problem;
    if(problem.retryAfterSeconds!==undefined)c.header('Retry-After',String(problem.retryAfterSeconds));
    const value=wire.CheckoutErrorSchema.parse({type:'about:blank',title:problem.code,status:problem.status,code:problem.code,detail:problem.message,
      ...(error instanceof CheckoutStockUnavailable?{items:error.items}:{}),...(error instanceof UnresolvedCheckoutOrder?{order_ref:error.order_ref}:{}),
      ...(error instanceof CheckoutDeliveryProblem&&error.fields?.length?{fields:error.fields}:{}),...(error instanceof CheckoutDeliveryProblem&&error.lines?.length?{lines:error.lines}:{})});
    return c.json(value,problem.status as 404);
  });
  const access=(c:Parameters<PlatformRuntime['sourceNetwork']>[0]):commands.BrowserAccess=>({
    deviceToken:readShopCookie(c.req.header('Cookie'),origin),sessionToken:readSessionCookie(c.req.header('Cookie'),origin),network:(runtime.rateLimitNetwork??runtime.sourceNetwork)(c),
  });
  const noQuery=(url:string)=>requireCondition(new URL(url).search==='',422,'validation_failed','不接受查詢參數。');
  const parse=<T>(schema:z.ZodType<T>,value:unknown):T=>{
    const parsed=schema.safeParse(value);
    requireCondition(parsed.success,422,'validation_failed','結帳資料無效。');return parsed.data;
  };
  app.post(root+'/cart-quotes',async c=>{
    commands.checkoutGate(options);noQuery(c.req.url);const input=parse(wire.CartQuoteInputSchema,await c.req.json());
    return c.json(wire.CartQuoteResponseSchema.parse(await commands.quotePublicCart(pool,c.req.param('slug')!,input,access(c),options)));
  });
  app.post(root+'/checkouts',async c=>{
    commands.checkoutGate(options);noQuery(c.req.url);const input=parse(wire.CheckoutInputSchema,await c.req.json()),key=c.req.header('Idempotency-Key')??'';
    requireCondition(/^[A-Za-z0-9_-]{22,128}$/.test(key),422,'invalid_idempotency_key','冪等鍵無效。');
    const result=await commands.createPublicCheckout(pool,c.req.param('slug')!,input,key,access(c),options);
    c.header('Set-Cookie',result.cookie);return c.json(wire.CheckoutResponseSchema.parse(result.value),result.created?201:200);
  });
  app.post(root+'/checkouts/:checkout_ref/orders',async c=>{
    commands.checkoutGate(options);noQuery(c.req.url);const input=parse(wire.PlaceOrderInputSchema,await c.req.json());
    const result=await commands.placePublicOrder(pool,c.req.param('slug')!,c.req.param('checkout_ref')!,input,access(c),options);
    return c.json(wire.PlaceOrderResponseSchema.parse(result.value),result.created?201:200);
  });
  app.get(root+'/orders/:order_ref',async c=>{
    noQuery(c.req.url);return c.json(wire.PublicOrderSchema.parse(await commands.readPublicOrder(pool,c.req.param('slug')!,c.req.param('order_ref')!,access(c),options)));
  });
  app.post(root+'/orders/:order_ref/cancel',async c=>{
    noQuery(c.req.url);commands.quarantineGate(options);parse(z.object({}).strict(),await c.req.json());
    return c.json(wire.PublicOrderSchema.parse(await commands.cancelPublicOrder(pool,c.req.param('slug')!,c.req.param('order_ref')!,access(c),options)));
  });
  app.post(root+'/orders/:order_ref/payment-handoffs',async c=>{
    commands.checkoutGate(options);noQuery(c.req.url);parse(wire.PaymentHandoffInputSchema,await c.req.json());
    return c.json(wire.PaymentHandoffResponseSchema.parse(await commands.resumePublicPayment(pool,c.req.param('slug')!,c.req.param('order_ref')!,access(c),options)),201);
  });
  app.post(root+'/orders/:order_ref/payment-queries',async c=>{
    commands.checkoutGate(options);noQuery(c.req.url);parse(wire.PaymentQueryInputSchema,await c.req.json());
    return c.json(wire.PaymentQueryResponseSchema.parse(await commands.queryPublicPayment(pool,c.req.param('slug')!,c.req.param('order_ref')!,access(c),options)));
  });
  app.post(root+'/orders/:order_ref/access',async c=>{
    noQuery(c.req.url);commands.quarantineGate(options);
    const parsed=parse(wire.RedeemAccessInputSchema,await c.req.json());
    const result=await commands.redeemPublicOrder(pool,c.req.param('slug')!,c.req.param('order_ref')!,parsed.token,access(c),options);
    c.header('Set-Cookie',result.cookie);return c.json(wire.PublicOrderSchema.parse(result.value));
  });
  app.post(root+'/order-access-requests',async c=>{
    commands.quarantineGate(options);noQuery(c.req.url);const input=parse(wire.AccessRequestInputSchema,await c.req.json());
    const queued=await commands.requestPublicOrderAccess(pool,c.req.param('slug')!,input,access(c),options);
    const journal=runtime.commercePayments?.journal??runtime.commerceJournal;
    if(queued&&runtime.afterResponse&&!runtime.commerceSettings?.quarantine&&runtime.commerceSettings?.emailEnabled&&runtime.commerceEmailSender&&journal){
      try{runtime.afterResponse(async()=>{await runDueCommerceWork(pool,{transport:runtime.commerceQueryTransport,keyring:runtime.commerceCredentialKeyring??null,freedomEnv:environment,email:options.email,emailEnabled:true,emailSender:runtime.commerceEmailSender,journal,origin},{targets:[queued.emailId],limit:1});});}
      catch{console.error('commerce_after_response_failed');}
    }
    wire.EmptyResponseSchema.parse(undefined);return c.body(null,202);
  });
  app.post('/api/v1/public/order-access/forget',async c=>{
    c.header('Set-Cookie',commands.clearShopCookie(options));noQuery(c.req.url);parse(wire.ForgetAccessInputSchema,await c.req.json());
    await commands.forgetPublicBrowser(pool,access(c),options);wire.EmptyResponseSchema.parse(undefined);return c.body(null,204);
  });
  return app;
}
