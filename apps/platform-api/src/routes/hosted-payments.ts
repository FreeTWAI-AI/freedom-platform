import type {PaymentAttemptOptions} from '../../../../modules/agent-commerce/payments/attempts.js';
import {runDueCommerceWork} from '../../../../modules/agent-commerce/operations/due-work.js';
import { OpaqueId } from '../../../../contracts/guild-launchpad/v1/primitives.js';
import { resolveReturnedAttempt, recordPaymentBrowserReturn, paymentBackLocation } from '../../../../modules/agent-commerce/payments/browser-return.js';
import { Problem } from '../../../../packages/shared/problem.js';
import { readProviderForm, resolvePaymentAccount, paymentVerificationKeys } from '../../../../modules/agent-commerce/payments/provider-input.js';
import { parsePaymentNotification, parsePaymentBrowserReturn } from '../../../../modules/agent-commerce/providers/ecpay/aio-credit/index.js';
import { ECPAY_ACK } from '../../../../modules/agent-commerce/providers/ecpay/index.js';
import { receivePaymentNotification, InvalidPaymentCredential } from '../../../../modules/agent-commerce/payments/events.js';
import { chargeCommerceBudgets, tryChargeCommerceBudget } from '../../../../modules/agent-commerce/checkout/limits.js';
import { Hono } from 'hono';
import type { Pool } from 'pg';
import type { PlatformRuntime } from '../runtime.js';
import { providerEnvironment } from '../../../../modules/agent-commerce/operations/admissions.js';
import type { FreedomEnv } from '../env.js';
import { servePaymentHandoff } from '../../../../modules/agent-commerce/payments/handoff.js';
import { HANDOFF_SCRIPT, HANDOFF_CSS, handoffErrorPage } from '../../../../modules/agent-commerce/payments/handoff-page.js';
import { hostedCheckoutOptions } from './hosted-checkout.js';
export function hostedPaymentOptions(runtime:PlatformRuntime,environment:FreedomEnv):PaymentAttemptOptions{
  return {settings:runtime.commerceSettings??{checkoutEnabled:false,quarantine:false,providerProfiles:[]},profiles:runtime.commercePayments?.profiles??[],environment:providerEnvironment(environment),
    admission:runtime.commercePorts?.admission??{allowed:()=>false},gateway:runtime.commercePayments?.gateway,keyring:runtime.commerceCredentialKeyring??null};
}
export function createHostedPaymentRoutes(pool: Pool, runtime: PlatformRuntime, environment: FreedomEnv, origin = runtime.publicOrigin) {
  const app = new Hono();
  const journal = runtime.commercePayments?.journal ?? runtime.commerceJournal;
  const afterResponse=(scheduled:{attemptId:string|null;orderId:string|null}|null,trigger:'notification'|'browser_return')=>{
    if(!scheduled||!runtime.afterResponse||runtime.commerceSettings?.quarantine)return;
    const transport=runtime.commerceQueryTransport,keyring=runtime.commerceCredentialKeyring;
    const emailEnabled=runtime.commerceSettings?.emailEnabled===true,emailSender=runtime.commerceEmailSender;
    const canQuery=Boolean(scheduled.attemptId&&transport&&keyring);
    const canEmail=Boolean(scheduled.orderId&&emailEnabled&&emailSender&&journal&&origin);
    if(!canQuery&&!canEmail)return;
    try{runtime.afterResponse(async()=>{
      const {email}=hostedCheckoutOptions(origin,runtime,environment);
      if(scheduled.attemptId&&transport&&keyring)
        await runDueCommerceWork(pool,{transport,keyring,freedomEnv:environment,email},{targets:[scheduled.attemptId],limit:1,trigger});
      if(scheduled.orderId&&runtime.commerceSettings?.emailEnabled&&runtime.commerceEmailSender&&journal&&origin){
        const emails=(await pool.query<{email_id:string}>("SELECT email_id FROM commerce_outbound_emails WHERE order_id=$1 AND state='queued' ORDER BY created_at LIMIT 10",[scheduled.orderId])).rows.map(r=>r.email_id);
        if(emails.length)await runDueCommerceWork(pool,{freedomEnv:environment,emailEnabled:true,emailSender:runtime.commerceEmailSender,journal,origin},{targets:emails,limit:emails.length,trigger});
      }
    });}
    catch{console.error('commerce_after_response_failed');}
  };
  const returnUnavailable = '暫時無法確認付款結果，請稍後到訂單頁查看。';
  app.onError((error, c) => {
    if (c.req.path.startsWith('/api/v1/provider-callbacks/ecpay/')) {
      if (error instanceof Problem && error.status === 429) {
        c.header('Retry-After', String(error.retryAfterSeconds));
        return c.text('0|limited', 429);
      }
      console.error('commerce_payment_notification_failed');
      return c.text('0|error', 500);
    }
    if (c.req.path.startsWith('/pay/ecpay/return/')) {
      console.error('commerce_payment_return_failed');
      return c.html(handoffErrorPage(returnUnavailable), 500);
    }
    console.error('commerce_handoff_failed');
    return c.html(handoffErrorPage('付款服務暫時無法使用。'), 503);
  });
  app.use('/api/v1/provider-callbacks/ecpay/*', async (c, next) => { c.header('Cache-Control', 'no-store'); await next(); });
  app.post('/api/v1/provider-callbacks/ecpay/:account_ref/payment', async (c) => {
    const body = await readProviderForm(c.req.raw);
    if (!body)
      return c.text('0|invalid', 400);
    const account = await resolvePaymentAccount(pool, c.req.param('account_ref')), network = (runtime.rateLimitNetwork ?? runtime.sourceNetwork)(c);
    if (!account) {
      await chargeCommerceBudgets(pool, network, { network: 'providerUnknownNetwork' });
      return c.body(null, 404);
    }
    await chargeCommerceBudgets(pool, account.account_id + ':' + network, { network: 'providerAccount' });
    let credentials;
    try {
      credentials = await paymentVerificationKeys(pool, account, runtime.commerceCredentialKeyring ?? null);
    }
    catch {
      return c.text('0|unavailable', 503);
    }
    const message = parsePaymentNotification(body, credentials.map(c => c.keys), { merchantId: account.merchant_id });
    const invalid = (reason: string) => { console.warn(JSON.stringify({ event: 'provider_callback_invalid', account: account.account_id, reason })); return c.text('0|invalid', 400); };
    if (message.kind === 'invalid')
      return invalid(message.reason);
    try {
      const { email } = hostedCheckoutOptions(origin, runtime, environment);
      const scheduledAttempt=await receivePaymentNotification(pool, { account, message, credentialVersion: credentials[message.keyIndex].credentialVersion, quarantine: runtime.commerceSettings?.quarantine ?? false, ...(email?{email}:{}) });
      afterResponse(scheduledAttempt,'notification');
    }
    catch (error) {
      if (error instanceof InvalidPaymentCredential)
        return invalid('credential_version_mismatch');
      throw error;
    }
    return c.text(ECPAY_ACK, 200);
  });
  app.use('/pay/ecpay/*', async (c, next) => { c.header('Cache-Control', 'no-store'); c.header('Referrer-Policy', 'no-referrer'); c.header('X-Robots-Tag', 'noindex'); await next(); });
  app.post('/pay/ecpay/return/:account_ref', async (c) => {
    const body = await readProviderForm(c.req.raw);
    if (!body)
      return c.redirect('/', 303);
    const allowed = await tryChargeCommerceBudget(pool, 'paymentReturnNetwork', (runtime.rateLimitNetwork ?? runtime.sourceNetwork)(c));
    const account = await resolvePaymentAccount(pool, c.req.param('account_ref'));
    if (!account)
      return c.redirect('/', 303);
    let credentials;
    try {
      credentials = await paymentVerificationKeys(pool, account, runtime.commerceCredentialKeyring ?? null);
    }
    catch {
      return c.html(handoffErrorPage(returnUnavailable), 503);
    }
    const message = parsePaymentBrowserReturn(body, credentials.map(c => c.keys), { merchantId: account.merchant_id });
    if (message.kind === 'invalid')
      return c.redirect('/', 303);
    const version = credentials[message.keyIndex].credentialVersion, attempt = await resolveReturnedAttempt(pool, account, message.merchantTradeNo, version);
    if (!attempt)
      return c.redirect('/', 303);
    if (allowed && !runtime.commerceSettings?.quarantine) {
      try {
        const scheduleQuery = await tryChargeCommerceBudget(pool, 'paymentReturnQuery', attempt.attempt_id);
        const recorded=await recordPaymentBrowserReturn(pool, { account, attemptId: attempt.attempt_id, merchantTradeNo: message.merchantTradeNo, credentialVersion: version, body, scheduleQuery });
        if(recorded)afterResponse({attemptId:attempt.attempt_id,orderId:attempt.order_id??null},'browser_return');
      } catch {
        console.error('payment_browser_return_record_failed');
      }
    }
    return c.redirect(attempt.kind === 'order' ? `/shops/${attempt.slug}/payment-return/${attempt.attempt_id}` : '/', 303);
  });
  app.get('/pay/ecpay/back/:attempt_id', async (c) => {
    if (c.req.method !== 'GET' || !OpaqueId.safeParse(c.req.param('attempt_id')).success)
      return c.html(handoffErrorPage('找不到這筆訂單。'), 404);
    const location = await paymentBackLocation(pool, c.req.param('attempt_id'));
    return location ? c.redirect(location, 303) : c.html(handoffErrorPage('找不到這筆訂單。'), 404);
  });
  app.get('/pay/ecpay/handoff.js', c => c.body(HANDOFF_SCRIPT, 200, { 'Content-Type': 'text/javascript; charset=utf-8' }));
  app.get('/pay/ecpay/handoff.css', c => c.body(HANDOFF_CSS, 200, { 'Content-Type': 'text/css; charset=utf-8' }));
  app.get('/pay/ecpay/:token', async (c) => {
    // Hono dispatches HEAD through GET. It must never consume a bearer token.
    if (c.req.method !== 'GET')
      return c.html(handoffErrorPage('付款連結已失效或不存在。'), 404);
    const payments = runtime.commercePayments;
    const page = await servePaymentHandoff(pool,c.req.param('token'),(runtime.rateLimitNetwork??runtime.sourceNetwork)(c),{...hostedPaymentOptions(runtime,environment),journal:payments?.journal});
    if (page.retryAfterSeconds !== undefined)
      c.header('Retry-After', String(page.retryAfterSeconds));
    return c.html(page.html, page.status);
  });
  return app;
}
