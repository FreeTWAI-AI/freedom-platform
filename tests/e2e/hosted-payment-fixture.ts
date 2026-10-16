import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {checkoutHarness,ok,ports} from '../runtime/hosted-checkout-harness.js';
import {createPlatformApp} from '../../apps/platform-api/src/platform-app.js';
import {nodeRuntime} from '../../apps/platform-api/src/app.js';
import {cloudflareRateLimitNetwork} from '../../apps/platform-api/src/worker.js';
import {CommerceCredentialKeyring,sealCredential} from '../../modules/agent-commerce/payments/credentials.js';
import {activateProviderService} from '../../modules/agent-commerce/payments/accounts.js';
import {createFixturePaymentGateway} from '../../modules/agent-commerce/payments/gateway.js';
import {MemoryEffectJournal} from '../../modules/agent-commerce/operations/journal/memory.js';
import {bindStore} from '../../modules/agent-commerce/checkout/authority.js';
import {DEMO_COMMUNITY,DEMO_PASSWORD} from '../../packages/testing/seed.js';
import type {CommerceSettings} from '../../modules/agent-commerce/operations/runtime-settings.js';
import type {PlatformRuntime} from '../../apps/platform-api/src/runtime.js';

/** Shared real-route setup, with only service activation using the M2 test shortcut. */
export async function hostedPaymentHarness(prefix:string,options:{publicSchema?:boolean}={}){
  const x=await checkoutHarness(prefix,options),origin=x.h.origin,adminEmail=`admin-${randomUUID()}@example.test`,csrf=randomUUID();
  const ring=CommerceCredentialKeyring.parse('test:'+randomBytes(32).toString('base64'))!,journal=new MemoryEffectJournal('local');
  const gateway=createFixturePaymentGateway({freedomEnv:'local',environment:'sandbox',publicBaseUrl:'https://e2e-payments.freedom.test',checkoutAction:origin+'/__e2e/ecpay/aio-checkout',localOrigin:origin});
  const settings:CommerceSettings={checkoutEnabled:true,quarantine:false,providerProfiles:['ecpay.aio.credit.v1']};
  let runtime:PlatformRuntime,app:ReturnType<typeof createPlatformApp>;
  function install(overrides:Partial<PlatformRuntime>={}){
    const configured=nodeRuntime('local',origin,{guildLaunchpadEnabled:true,
      commerceSettings:Object.hasOwn(overrides,'commerceSettings')?overrides.commerceSettings:settings,
      commerceCredentialKeyring:Object.hasOwn(overrides,'commerceCredentialKeyring')?overrides.commerceCredentialKeyring:ring,
      commercePayments:Object.hasOwn(overrides,'commercePayments')?overrides.commercePayments:{gateway,journal,profiles:settings.providerProfiles},
      commercePorts:{shipping:ports.shipping,...overrides.commercePorts},adminVerifier:async()=>({email:adminEmail,subject:'synthetic-payment-admin',csrfToken:csrf})});
    runtime={...configured,...overrides,commercePorts:configured.commercePorts};
    runtime.rateLimitNetwork=cloudflareRateLimitNetwork(true);app=createPlatformApp(x.runtime,origin,'local',runtime);return app;
  }
  install();
  async function http(method:string,path:string,body?:unknown,cookie?:string,headers:Record<string,string>={}){
    const request=new Request(origin+path,{method,headers:{Origin:origin,'CF-Connecting-IP':'192.0.2.1',...(body===undefined?{}:{'Content-Type':'application/json'}),...(cookie?{Cookie:cookie}:{}),...headers},body:body===undefined?undefined:JSON.stringify(body)});
    Object.defineProperty(request,'cf',{value:{colo:'TEST'}});
    const response=await app.fetch(request),text=await response.text();return {response,status:response.status,data:text?JSON.parse(text):null};
  }
  async function reset(){
    await x.reset();settings.quarantine=false;settings.checkoutEnabled=true;settings.providerProfiles=['ecpay.aio.credit.v1'];install();
    await x.h.pool.query('INSERT INTO platform_admins(admin_id,community_id,email,display_name) VALUES($1,$2,$3,$4)',[randomUUID(),DEMO_COMMUNITY,adminEmail,'合成付款管理員']);
    await x.h.pool.query(`INSERT INTO tenant_authority_policies(revision,status,fresh_auth_ttl_seconds,transfer_ttl_seconds,recovery_approval_ttl_seconds,max_open_recovery_cases_per_tenant) VALUES(1,'active',600,86400,86400,1) ON CONFLICT DO NOTHING`);
  }
  async function setup(s:Awaited<ReturnType<typeof x.store>>){
    const call=(method:string,path:string,body?:unknown,version?:string)=>x.h.call(method,path,s.owner,body,{'Idempotency-Key':randomUUID(),...(version?{'If-Match':`"${version}"`}:{})},app);
    const version=(await x.h.pool.query('SELECT version::text FROM module_instances WHERE instance_id=$1',[s.instanceId])).rows[0].version;
    ok(await call('POST',s.root+'/upgrade',{},version));
    const fresh=async()=>ok(await call('POST','/me/high-risk-verifications',{tenant_id:s.tenantId,purpose:'commerce.provider_account.write',password:DEMO_PASSWORD}),201).verification_id;
    let account=ok(await call('POST',s.root+'/provider-accounts',{provider:'ecpay',environment:'sandbox',merchant_id:'1234567',fresh_auth_verification_id:await fresh()}),201);
    const material={hash_key:randomBytes(8).toString('hex'),hash_iv:randomBytes(8).toString('hex'),credit_check_code:String(randomBytes(4).readUInt32BE()%100000000).padStart(8,'0')};
    account=ok(await call('PUT',s.root+`/provider-accounts/${account.account_id}/services/payment`,{profile:'ecpay.aio.credit.v1',...material,fresh_auth_verification_id:await fresh()},account.version));
    await x.tx(async q=>{await bindStore(q,s.tenantId);await activateProviderService(q,{accountId:account.account_id,purpose:'payment',activationRef:randomUUID()});});
    const admitted=await http('POST','/admin/api/commerce/store-admissions',{tenant_id:s.tenantId,instance_id:s.instanceId,reason:'合成付款驗證' },undefined,{'X-Admin-CSRF':csrf,'Idempotency-Key':randomUUID()});ok(admitted,201);
    const accountRef=(await x.h.pool.query("SELECT route_key FROM commerce_entry_routes WHERE route_kind='provider_account' AND target_id=$1",[account.account_id])).rows[0].route_key as string;
    return {accountId:account.account_id as string,accountRef,material,admissionId:admitted.data.admission_id as string};
  }
  const root=(s:{slug:string})=>`/api/v1/public/stores/${s.slug}`;
  async function readyCheckout(){
    const s=await x.store(100),provider=await setup(s);
    const checkout=await http('POST',root(s)+'/checkouts',x.input(s.product.sku,5),undefined,{'Idempotency-Key':randomUUID()});ok(checkout,201);
    const cookie=checkout.response.headers.get('Set-Cookie')!.split(';')[0],intent={terms_sha256:checkout.data.terms_sha256,client_order_id:randomUUID()};
    return {s,provider,checkout:checkout.data,cookie,intent};
  }
  async function placed(){
    const ready=await readyCheckout();
    const order=await http('POST',root(ready.s)+`/checkouts/${ready.checkout.checkout_ref}/orders`,ready.intent,ready.cookie);ok(order,201);assert(order.data.payment);
    return {...ready,order:order.data.order,payment:order.data.payment};
  }
  return {x,origin,settings,ring,journal,gateway,install,http,reset,setup,readyCheckout,placed,root,get app(){return app;},get runtime(){return runtime;},stop:()=>x.stop()};
}

/** Existing runtime admission fixtures need a service without changing their route assertions. */
export async function seedAdmissionPaymentService(x:Awaited<ReturnType<typeof checkoutHarness>>,s:Awaited<ReturnType<typeof x.store>>){
  const accountId=randomUUID(),ring=CommerceCredentialKeyring.parse('test:'+randomBytes(32).toString('base64'))!;
  const principalId=(await x.h.pool.query('SELECT principal_id FROM principals WHERE user_ref=$1',[s.owner.user.user_id])).rows[0].principal_id;
  const sealed=sealCredential(ring,{account_id:accountId,purpose:'payment',environment:'sandbox',credential_version:1},{hash_key:randomBytes(8).toString('hex'),hash_iv:randomBytes(8).toString('hex')});
  await x.tx(async q=>{
    await bindStore(q,s.tenantId);
    await q.query(`INSERT INTO commerce_provider_accounts(account_id,tenant_id,instance_id,provider,environment,merchant_id,created_by_principal_id) VALUES($1,$2,$3,'ecpay','sandbox','1234567',$4)`,[accountId,s.tenantId,s.instanceId,principalId]);
    await q.query(`INSERT INTO commerce_provider_account_services(account_id,purpose,tenant_id,instance_id,environment,profile,credential_version) VALUES($1,'payment',$2,$3,'sandbox','ecpay.aio.credit.v1',1)`,[accountId,s.tenantId,s.instanceId]);
    await q.query(`INSERT INTO commerce_provider_credentials(account_id,purpose,credential_version,tenant_id,instance_id,environment,key_id,sealed,created_by_principal_id) VALUES($1,'payment',1,$2,$3,'sandbox',$4,$5,$6)`,[accountId,s.tenantId,s.instanceId,sealed.key_id,sealed.sealed,principalId]);
    await activateProviderService(q,{accountId,purpose:'payment',activationRef:randomUUID()});
  });
}
