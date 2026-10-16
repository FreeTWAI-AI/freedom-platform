import {randomBytes,randomUUID} from 'node:crypto';
import {Hono} from 'hono';
import type {Pool} from 'pg';
import type {FreedomEnv} from '../apps/platform-api/src/env.js';
import {isolatedTransaction,clearTenantContext} from '../packages/resource-scopes/tenant-transaction.js';
import {bindStore} from '../modules/agent-commerce/checkout/authority.js';
import type {CheckoutPorts} from '../modules/agent-commerce/checkout/terms.js';
import {MemoryEffectJournal} from '../modules/agent-commerce/operations/journal/memory.js';
import {createFixturePaymentGateway,paymentGatewayUrls} from '../modules/agent-commerce/payments/gateway.js';
import {readProviderForm} from '../modules/agent-commerce/payments/provider-input.js';
import {loadServiceCredentials} from '../modules/agent-commerce/payments/accounts.js';
import type {CommerceCredentialKeyring} from '../modules/agent-commerce/payments/credentials.js';
import {escapePaymentHtml as escape} from '../modules/agent-commerce/payments/handoff-page.js';
import {parseForm,verifySignedForm,signFields,encodeForm,ECPAY_ACK,type FormFields} from '../modules/agent-commerce/providers/ecpay/index.js';
import {formatTaipeiDateTime} from '../modules/agent-commerce/providers/ecpay/aio-credit/index.js';

/** Local browser harness only. No fetch, outbound request or provider client is installed. */
export function createE2eEcpayFixture(input:{freedomEnv:FreedomEnv;origin:string;pool:Pool;keyring:CommerceCredentialKeyring;forward:(request:Request)=>Promise<Response>}){
  if(input.freedomEnv!=='local')throw Error('payment_fixture_requires_local');
  const gateway=createFixturePaymentGateway({freedomEnv:input.freedomEnv,environment:'sandbox',publicBaseUrl:'https://e2e-payments.freedom.test',checkoutAction:input.origin+'/__e2e/ecpay/aio-checkout',localOrigin:input.origin});
  const journal=new MemoryEffectJournal('local'),profiles=['ecpay.aio.credit.v1'] as const;
  const shipping:CheckoutPorts['shipping']={async quote(_q,_store,request){return {groups:[...new Set(request.lines.map(l=>l.supplier_shop_id))].map(id=>({group_ref:id,supplier_shop_id:id,method_ref:'synthetic-fixed',amount_minor:0}))};}};
  const sessions=new Map<string,{attemptId:string;tradeNo:string}>(),pending=new Map<string,{url:string;body:string}>();
  const digits=(n:number)=>[...randomBytes(n)].map(b=>String(b%10)).join(''),card6=digits(6),card4=digits(4);
  async function attempt(id:string){return isolatedTransaction(input.pool,async q=>{
    const a=(await q.query('SELECT * FROM commerce_payment_attempts WHERE attempt_id=$1',[id])).rows[0];if(!a)throw Error('fixture_attempt_missing');
    await clearTenantContext(q);await bindStore(q,a.tenant_id);
    const credentials=await loadServiceCredentials(q,input.keyring,{accountId:a.account_id,purpose:'payment',credentialVersion:a.credential_version});
    const accountRef=(await q.query("SELECT route_key FROM commerce_entry_routes WHERE route_kind='provider_account' AND target_id=$1 AND revoked_at IS NULL",[a.account_id])).rows[0]?.route_key;
    if(!accountRef)throw Error('fixture_account_missing');return {a,credentials,urls:paymentGatewayUrls(gateway,{accountRef,attemptId:id})};
  });}
  const localUrl=(value:string)=>{const url=new URL(value);if(url.origin!==gateway.publicBaseUrl)throw Error('fixture_url_invalid');return input.origin+url.pathname;};
  const hidden=(fields:FormFields)=>fields.map(([name,value])=>`<input type="hidden" name="${escape(name)}" value="${escape(value)}">`).join('');
  const page=(body:string)=>`<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>本機付款測試</title><link rel="stylesheet" href="/pay/ecpay/handoff.css"></head><body><main><h1>本機付款測試</h1>${body}</main></body></html>`;
  const deliver=async(value:{url:string;body:string})=>{const response=await input.forward(new Request(localUrl(value.url),{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:value.body}));if(response.status!==200||await response.text()!==ECPAY_ACK)throw Error('fixture_notification_failed');};
  const routes=new Hono();routes.onError((_error,c)=>c.text('fixture_failed',500));
  routes.use('*',async(c,next)=>{c.header('Cache-Control','no-store');c.header('Referrer-Policy','no-referrer');c.header('X-Robots-Tag','noindex');c.header('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");await next();});
  routes.post('/__e2e/ecpay/aio-checkout',async c=>{
    const body=await readProviderForm(c.req.raw);if(!body)return c.text('invalid_form',400);
    const fields=Object.fromEntries(parseForm(body));
    const row=(await input.pool.query('SELECT attempt_id FROM commerce_payment_attempts WHERE merchant_trade_no=$1 AND merchant_id=$2 AND environment=$3',[fields.MerchantTradeNo?.toUpperCase(),fields.MerchantID,gateway.environment])).rows[0];
    if(!row)return c.text('invalid_form',400);
    const context=await attempt(row.attempt_id),verified=verifySignedForm(body,[context.credentials.keys],'sha256');
    if(!verified.ok||fields.TotalAmount!==String(Number(context.a.amount_minor)/100)||fields.ReturnURL!==context.urls.returnUrl||fields.OrderResultURL!==context.urls.orderResultUrl||fields.ClientBackURL!==context.urls.clientBackUrl)return c.text('invalid_form',400);
    const id=randomUUID();sessions.set(id,{attemptId:row.attempt_id,tradeNo:'T'+randomBytes(8).toString('hex').toUpperCase()});
    const modes=[['paid','付款成功'],['failed','付款失敗'],['pending','結果待確認'],['simulated','模擬付款'],['delayed','付款成功但通知延後']];
    return c.html(page(`<p>交易編號：<span data-trade-number>${escape(context.a.merchant_trade_no)}</span></p><p>金額：${Number(context.a.amount_minor)/100} TWD</p><form method="post" action="/__e2e/ecpay/result"><input type="hidden" name="session" value="${id}">${modes.map(([mode,label])=>`<p><button name="mode" value="${mode}" type="submit">${label}</button></p>`).join('')}</form><a href="${escape(localUrl(context.urls.clientBackUrl))}">返回商店</a>`));
  });
  routes.post('/__e2e/ecpay/result',async c=>{
    const bytes=await readProviderForm(c.req.raw);if(!bytes)return c.text('invalid_form',400);const fields=Object.fromEntries(parseForm(bytes)),session=sessions.get(fields.session);
    if(!session||!['paid','failed','pending','simulated','delayed'].includes(fields.mode))return c.text('invalid_form',400);
    const {a,credentials,urls}=await attempt(session.attemptId),date=formatTaipeiDateTime(Date.now());
    const facts={MerchantID:a.merchant_id,MerchantTradeNo:a.merchant_trade_no,TradeNo:session.tradeNo,TradeAmt:String(Number(a.amount_minor)/100),RtnCode:fields.mode==='failed'?'0':fields.mode==='pending'?'10300066':'1',RtnMsg:'本機合成結果',SimulatePaid:fields.mode==='simulated'?'1':'0',PaymentDate:date,PaymentType:'Credit_CreditCard'};
    const notification={url:urls.returnUrl,body:encodeForm(signFields({...facts,PaymentTypeChargeFee:'0',gwsr:digits(10),card6no:card6,card4no:card4,auth_code:randomBytes(3).toString('hex')},credentials.keys,'sha256'))};
    if(fields.mode==='delayed')pending.set(fields.session,notification);else await deliver(notification);
    const returned=signFields(facts,credentials.keys,'sha256');
    return c.html(page(`<p>${fields.mode==='delayed'?'通知尚未送達。':'結果已送出。'}</p><form method="post" action="${escape(localUrl(urls.orderResultUrl))}">${hidden(returned)}<button type="submit">返回商店查看結果</button></form>`));
  });
  routes.post('/__e2e/ecpay/deliver-pending',async c=>{let delivered=0;for(const [id,value] of pending){await deliver(value);pending.delete(id);delivered++;}return c.json({delivered});});
  return {routes,gateway,journal,profiles,shipping};
}
