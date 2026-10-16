import {Problem} from '../../../../packages/shared/problem.js';
import {readProviderForm,resolvePaymentAccount,paymentVerificationKeys} from '../../../../modules/agent-commerce/payments/provider-input.js';
import {parsePaymentNotification} from '../../../../modules/agent-commerce/providers/ecpay/aio-credit/index.js';
import {ECPAY_ACK} from '../../../../modules/agent-commerce/providers/ecpay/index.js';
import {receivePaymentNotification,InvalidPaymentCredential} from '../../../../modules/agent-commerce/payments/events.js';
import {chargeCommerceBudgets} from '../../../../modules/agent-commerce/checkout/limits.js';
import {Hono} from 'hono';
import type {Pool} from 'pg';
import type {PlatformRuntime} from '../runtime.js';
import {providerEnvironment} from '../../../../modules/agent-commerce/operations/admissions.js';
import type {FreedomEnv} from '../env.js';
import {servePaymentHandoff} from '../../../../modules/agent-commerce/payments/handoff.js';
import {HANDOFF_SCRIPT,HANDOFF_CSS,handoffErrorPage} from '../../../../modules/agent-commerce/payments/handoff-page.js';

export function createHostedPaymentRoutes(pool:Pool,runtime:PlatformRuntime,environment:FreedomEnv){
  const app=new Hono();
  app.onError((error,c)=>{
    if(c.req.path.startsWith('/api/v1/provider-callbacks/ecpay/')){
      if(error instanceof Problem&&error.status===429){c.header('Retry-After',String(error.retryAfterSeconds));return c.text('0|limited',429);}
      console.error('commerce_payment_notification_failed');return c.text('0|error',500);
    }
    console.error('commerce_handoff_failed');return c.html(handoffErrorPage('付款服務暫時無法使用。'),503);
  });
  app.use('/api/v1/provider-callbacks/ecpay/*',async(c,next)=>{c.header('Cache-Control','no-store');await next();});
  app.post('/api/v1/provider-callbacks/ecpay/:account_ref/payment',async c=>{
    const body=await readProviderForm(c.req.raw);if(!body)return c.text('0|invalid',400);
    const account=await resolvePaymentAccount(pool,c.req.param('account_ref')),network=(runtime.rateLimitNetwork??runtime.sourceNetwork)(c);
    if(!account){await chargeCommerceBudgets(pool,network,{network:'providerUnknownNetwork'});return c.body(null,404);}
    await chargeCommerceBudgets(pool,account.account_id,{network:'providerAccount'});
    let credentials;try{credentials=await paymentVerificationKeys(pool,account,runtime.commerceCredentialKeyring??null);}catch{return c.text('0|unavailable',503);}
    const message=parsePaymentNotification(body,credentials.map(c=>c.keys),{merchantId:account.merchant_id});
    const invalid=(reason:string)=>{console.warn(JSON.stringify({event:'provider_callback_invalid',account:account.account_id,reason}));return c.text('0|invalid',400);};
    if(message.kind==='invalid')return invalid(message.reason);
    try{await receivePaymentNotification(pool,{account,message,credentialVersion:credentials[message.keyIndex].credentialVersion,quarantine:runtime.commerceSettings?.quarantine??false});}
    catch(error){if(error instanceof InvalidPaymentCredential)return invalid('credential_version_mismatch');throw error;}
    return c.text(ECPAY_ACK,200);
  });
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
