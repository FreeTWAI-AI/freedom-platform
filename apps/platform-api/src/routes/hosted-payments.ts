import {Hono} from 'hono';
import type {Pool} from 'pg';
import type {PlatformRuntime} from '../runtime.js';
import {providerEnvironment} from '../../../../modules/agent-commerce/operations/admissions.js';
import type {FreedomEnv} from '../env.js';
import {servePaymentHandoff} from '../../../../modules/agent-commerce/payments/handoff.js';
import {HANDOFF_SCRIPT,HANDOFF_CSS,handoffErrorPage} from '../../../../modules/agent-commerce/payments/handoff-page.js';

export function createHostedPaymentRoutes(pool:Pool,runtime:PlatformRuntime,environment:FreedomEnv){
  const app=new Hono();
  app.onError((_error,c)=>{console.error('commerce_handoff_failed');return c.html(handoffErrorPage('付款服務暫時無法使用。'),503);});
  app.use('/pay/ecpay/*',async(c,next)=>{c.header('Cache-Control','no-store');c.header('Referrer-Policy','no-referrer');c.header('X-Robots-Tag','noindex');await next();});
  app.get('/pay/ecpay/handoff.js',c=>c.body(HANDOFF_SCRIPT,200,{'Content-Type':'text/javascript; charset=utf-8'}));
  app.get('/pay/ecpay/handoff.css',c=>c.body(HANDOFF_CSS,200,{'Content-Type':'text/css; charset=utf-8'}));
  app.get('/pay/ecpay/:token',async c=>{
    // Hono dispatches HEAD through GET. It must never consume a bearer token.
    if(c.req.method!=='GET')return c.html(handoffErrorPage('付款連結已失效或不存在。'),404);
    const payments=runtime.commercePayments;
    const page=await servePaymentHandoff(pool,c.req.param('token'),(runtime.rateLimitNetwork??runtime.sourceNetwork)(c),{
      settings:runtime.commerceSettings??{checkoutEnabled:false,quarantine:false,providerProfiles:[]},profiles:payments?.profiles??[],environment:providerEnvironment(environment),
      admission:runtime.commercePorts?.admission??{allowed:()=>false},gateway:payments?.gateway,keyring:runtime.commerceCredentialKeyring??null,journal:payments?.journal});
    if(page.retryAfterSeconds!==undefined)c.header('Retry-After',String(page.retryAfterSeconds));
    return c.html(page.html,page.status);
  });
  return app;
}
