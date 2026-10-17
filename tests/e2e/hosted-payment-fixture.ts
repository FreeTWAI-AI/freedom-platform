import assert from 'node:assert/strict';
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { checkoutHarness, ok, ports } from '../runtime/hosted-checkout-harness.js';
import { createPlatformApp } from '../../apps/platform-api/src/platform-app.js';
import { nodeRuntime } from '../../apps/platform-api/src/app.js';
import { cloudflareRateLimitNetwork } from '../../apps/platform-api/src/worker.js';
import { CommerceCredentialKeyring, sealCredential } from '../../modules/agent-commerce/payments/credentials.js';
import { activateProviderService } from '../../modules/agent-commerce/payments/accounts.js';
import { createFixturePaymentGateway } from '../../modules/agent-commerce/payments/gateway.js';
import { MemoryEffectJournal } from '../../modules/agent-commerce/operations/journal/memory.js';
import { bindStore } from '../../modules/agent-commerce/checkout/authority.js';
import { DEMO_COMMUNITY, DEMO_PASSWORD } from '../../packages/testing/seed.js';
import type { CommerceSettings } from '../../modules/agent-commerce/operations/runtime-settings.js';
import type { PlatformRuntime } from '../../apps/platform-api/src/runtime.js';
/** Shared real-route setup, with only service activation using the M2 test shortcut. */
export async function hostedPaymentHarness(prefix: string, options: {
  publicSchema?: boolean;
  randomContact?: boolean;
} = {}) {
  const x = await checkoutHarness(prefix, options), origin = x.h.origin, adminEmail = `admin-${randomUUID()}@example.test`, csrf = randomUUID();
  const ring = CommerceCredentialKeyring.parse('test:' + randomBytes(32).toString('base64'))!, journal = new MemoryEffectJournal('local');
  const gateway = createFixturePaymentGateway({ freedomEnv: 'local', environment: 'sandbox', publicBaseUrl: 'https://e2e-payments.freedom.test', checkoutAction: origin + '/__e2e/ecpay/aio-checkout', localOrigin: origin });
  const settings: CommerceSettings = { checkoutEnabled: true, consoleEnabled: true, quarantine: false, providerProfiles: ['ecpay.aio.credit.v1'] };
  let runtime: PlatformRuntime, app: ReturnType<typeof createPlatformApp>;
  function install(overrides: Partial<PlatformRuntime> = {}) {
    const configured = nodeRuntime('local', origin, {
      guildLaunchpadEnabled: true,commerceQueryTransport:overrides.commerceQueryTransport,
      commerceSettings: Object.hasOwn(overrides, 'commerceSettings') ? overrides.commerceSettings : settings,
      commerceCredentialKeyring: Object.hasOwn(overrides, 'commerceCredentialKeyring') ? overrides.commerceCredentialKeyring : ring,
      commercePayments: Object.hasOwn(overrides, 'commercePayments') ? overrides.commercePayments : { gateway, journal, profiles: settings.providerProfiles },
      commercePorts: { shipping: ports.shipping, ...overrides.commercePorts }, adminVerifier: async () => ({ email: adminEmail, subject: 'synthetic-payment-admin', csrfToken: csrf })
    });
    runtime = { ...configured, ...overrides, commercePorts: configured.commercePorts };
    runtime.rateLimitNetwork = cloudflareRateLimitNetwork(true);
    app = createPlatformApp(x.runtime, origin, 'local', runtime);
    return app;
  }
  install();
  async function http(method: string, path: string, body?: unknown, cookie?: string, headers: Record<string, string> = {}) {
    const request = new Request(origin + path, { method, headers: { Origin: origin, 'CF-Connecting-IP': '192.0.2.1', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(cookie ? { Cookie: cookie } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    Object.defineProperty(request, 'cf', { value: { colo: 'TEST' } });
    const response = await app.fetch(request), text = await response.text();
    return { response, status: response.status, data: text ? JSON.parse(text) : null };
  }
  async function reset() {
    await x.reset();
    settings.quarantine = false;
    settings.checkoutEnabled = true;
    settings.providerProfiles = ['ecpay.aio.credit.v1'];
    install();
    await x.h.pool.query('INSERT INTO platform_admins(admin_id,community_id,email,display_name) VALUES($1,$2,$3,$4)', [randomUUID(), DEMO_COMMUNITY, adminEmail, '合成付款管理員']);
    await x.h.pool.query(`INSERT INTO tenant_authority_policies(revision,status,fresh_auth_ttl_seconds,transfer_ttl_seconds,recovery_approval_ttl_seconds,max_open_recovery_cases_per_tenant) VALUES(1,'active',600,86400,86400,1) ON CONFLICT DO NOTHING`);
  }
  async function setup(s: Awaited<ReturnType<typeof x.store>>, materialOverride?: {
    hash_key: string;
    hash_iv: string;
    credit_check_code: string;
  }) {
    const call = (method: string, path: string, body?: unknown, version?: string) => x.h.call(method, path, s.owner, body, { 'Idempotency-Key': randomUUID(), ...(version ? { 'If-Match': `"${version}"` } : {}) }, app);
    const version = (await x.h.pool.query('SELECT version::text FROM module_instances WHERE instance_id=$1', [s.instanceId])).rows[0].version;
    ok(await call('POST', s.root + '/upgrade', {}, version));
    const fresh = async () => ok(await call('POST', '/me/high-risk-verifications', { tenant_id: s.tenantId, purpose: 'commerce.provider_account.write', password: DEMO_PASSWORD }), 201).verification_id;
    let account = ok(await call('POST', s.root + '/provider-accounts', { provider: 'ecpay', environment: 'sandbox', merchant_id: '1234567', fresh_auth_verification_id: await fresh() }), 201);
    const material = materialOverride ?? { hash_key: randomBytes(8).toString('hex'), hash_iv: randomBytes(8).toString('hex'), credit_check_code: String(randomInt(100000000)).padStart(8, '0') };
    account = ok(await call('PUT', s.root + `/provider-accounts/${account.account_id}/services/payment`, { profile: 'ecpay.aio.credit.v1', ...material, fresh_auth_verification_id: await fresh() }, account.version));
    await x.tx(async (q) => { await bindStore(q, s.tenantId); await activateProviderService(q, { accountId: account.account_id, purpose: 'payment', activationRef: randomUUID() }); });
    const admitted = await http('POST', '/admin/api/commerce/store-admissions', { tenant_id: s.tenantId, instance_id: s.instanceId, reason: '合成付款驗證' }, undefined, { 'X-Admin-CSRF': csrf, 'Idempotency-Key': randomUUID() });
    ok(admitted, 201);
    const accountRef = (await x.h.pool.query("SELECT route_key FROM commerce_entry_routes WHERE route_kind='provider_account' AND target_id=$1", [account.account_id])).rows[0].route_key as string;
    return { accountId: account.account_id as string, accountRef, material, admissionId: admitted.data.admission_id as string };
  }
  const root = (s: {
    slug: string;
  }) => `/api/v1/public/stores/${s.slug}`;
  async function readyCheckout(materialOverride?: {
    hash_key: string;
    hash_iv: string;
    credit_check_code: string;
  }) {
    const s = await x.store(100), provider = await setup(s, materialOverride);
    const checkout = await http('POST', root(s) + '/checkouts', x.input(s.product.sku, 5), undefined, { 'Idempotency-Key': randomUUID() });
    ok(checkout, 201);
    const cookie = checkout.response.headers.get('Set-Cookie')!.split(';')[0], intent = { terms_sha256: checkout.data.terms_sha256, client_order_id: randomUUID() };
    return { s, provider, checkout: checkout.data, cookie, intent };
  }
  async function placed(materialOverride?: {
    hash_key: string;
    hash_iv: string;
    credit_check_code: string;
  }) {
    const ready = await readyCheckout(materialOverride);
    const order = await http('POST', root(ready.s) + `/checkouts/${ready.checkout.checkout_ref}/orders`, ready.intent, ready.cookie);
    ok(order, 201);
    assert(order.data.payment);
    return { ...ready, order: order.data.order, payment: order.data.payment };
  }
  return { x, origin, settings, ring, journal, gateway, install, http, reset, setup, readyCheckout, placed, root, get app() { return app; }, get runtime() { return runtime; }, stop: () => x.stop() };
}
/** Existing runtime admission fixtures need a service without changing their route assertions. */
export async function seedAdmissionPaymentService(x: Awaited<ReturnType<typeof checkoutHarness>>, s: Awaited<ReturnType<typeof x.store>>, ring = CommerceCredentialKeyring.parse('test:' + randomBytes(32).toString('base64'))!) {
  const accountId = randomUUID();
  const principalId = (await x.h.pool.query('SELECT principal_id FROM principals WHERE user_ref=$1', [s.owner.user.user_id])).rows[0].principal_id;
  const sealed = sealCredential(ring, { account_id: accountId, purpose: 'payment', environment: 'sandbox', credential_version: 1 }, { hash_key: randomBytes(8).toString('hex'), hash_iv: randomBytes(8).toString('hex') });
  await x.tx(async (q) => {
    await bindStore(q, s.tenantId);
    await q.query(`INSERT INTO commerce_provider_accounts(account_id,tenant_id,instance_id,provider,environment,merchant_id,created_by_principal_id) VALUES($1,$2,$3,'ecpay','sandbox','1234567',$4)`, [accountId, s.tenantId, s.instanceId, principalId]);
    await q.query(`INSERT INTO commerce_provider_account_services(account_id,purpose,tenant_id,instance_id,environment,profile,credential_version) VALUES($1,'payment',$2,$3,'sandbox','ecpay.aio.credit.v1',1)`, [accountId, s.tenantId, s.instanceId]);
    await q.query(`INSERT INTO commerce_provider_credentials(account_id,purpose,credential_version,tenant_id,instance_id,environment,key_id,sealed,created_by_principal_id) VALUES($1,'payment',1,$2,$3,'sandbox',$4,$5,$6)`, [accountId, s.tenantId, s.instanceId, sealed.key_id, sealed.sealed, principalId]);
    await activateProviderService(q, { accountId, purpose: 'payment', activationRef: randomUUID() });
  });
}
/** Browser fixture: account/service writes and admission use the real HTTP routes. */
export async function setupE2ePayment(db: import('pg').Pool, browser: import('@playwright/test').Browser, origin: string, store: {
  seller: {
    email: string;
  };
  tenant: string;
  instance: string;
  root: string;
}, options:{activationOnly?:boolean}={}) {
  const { apiLogin, ownedSchema } = await import('./hosted-order-fixture.js');
  const { E2E_AUTHOR_CLAIM_ADMIN_TOKEN, E2E_AUTHOR_CLAIM_ADMIN_EMAIL } = await import('../../packages/testing/e2e-admin.js');
  await ownedSchema(db);
  const context = await browser.newContext({ baseURL: origin });
  try {
    const session = await apiLogin(context, origin, store.seller.email);
    const command = async (method: 'POST' | 'PUT', path: string, data: unknown, status: number, version?: string) => {
      const response = await context.request.fetch('/api/v1' + path, { method, data, headers: { Origin: origin, 'X-CSRF-Token': session.csrf_token, 'Idempotency-Key': randomUUID(), ...(version ? { 'If-Match': `"${version}"` } : {}) } });
      assert.equal(response.status(), status, 'payment fixture setup command failed');
      return response.json();
    };
    const fresh = async () => (await command('POST', '/me/high-risk-verifications', { tenant_id: store.tenant, purpose: 'commerce.provider_account.write', password: DEMO_PASSWORD }, 201)).verification_id;
    let account = await command('POST', store.root + '/provider-accounts', { provider: 'ecpay', environment: 'sandbox', merchant_id: '1234567', fresh_auth_verification_id: await fresh() }, 201);
    const material = { hash_key: randomBytes(8).toString('hex'), hash_iv: randomBytes(8).toString('hex'), credit_check_code: String(randomInt(100000000)).padStart(8, '0') };
    account = await command('PUT', store.root + `/provider-accounts/${account.account_id}/services/payment`, { profile: 'ecpay.aio.credit.v1', ...material, fresh_auth_verification_id: await fresh() }, 200, account.version);
    if(options.activationOnly)return {accountId:account.account_id as string,material,version:account.version as string};
    const { isolatedTransaction } = await import('../../packages/resource-scopes/tenant-transaction.js');
    await isolatedTransaction(db, async (q) => { await bindStore(q, store.tenant); await activateProviderService(q, { accountId: account.account_id, purpose: 'payment', activationRef: randomUUID() }); });
    await db.query(`INSERT INTO platform_admins(admin_id,community_id,email,display_name) VALUES($1,$2,$3,'合成付款准入管理員') ON CONFLICT(email) DO UPDATE SET active=true`, [randomUUID(), DEMO_COMMUNITY, E2E_AUTHOR_CLAIM_ADMIN_EMAIL]);
    const adminHeaders = { 'Cf-Access-Jwt-Assertion': E2E_AUTHOR_CLAIM_ADMIN_TOKEN }, bootstrap = await context.request.get('/admin/api/bootstrap', { headers: adminHeaders });
    assert.equal(bootstrap.status(), 200);
    const response = await context.request.post('/admin/api/commerce/store-admissions', { data: { tenant_id: store.tenant, instance_id: store.instance, reason: '本機付款測試准入' }, headers: { Origin: origin, ...adminHeaders, 'X-Admin-CSRF': (await bootstrap.json()).csrf_token, 'Idempotency-Key': randomUUID() } });
    assert.equal(response.status(), 201, 'payment fixture admission failed');
    return { accountId: account.account_id as string, material,version:account.version as string };
  }
  finally {
    await context.close();
  }
}
export async function createE2ePaymentOrder(db: import('pg').Pool, browser: import('@playwright/test').Browser, origin: string, context: import('@playwright/test').BrowserContext, options: {randomContact?: boolean} = {}) {
  const { fixtureStore } = await import('./hosted-order-fixture.js');
  const { CheckoutResponseSchema, PlaceOrderResponseSchema } = await import('../../contracts/guild-launchpad/v1/hosted-checkout.js');
  const store = await fixtureStore(db, browser, origin);
  await setupE2ePayment(db, browser, origin, store);
  const root = '/api/v1/public/stores/' + store.slug;
  const contact=options.randomContact?{name:'合成付款買家-'+randomUUID(),email:'synthetic-payment-'+randomUUID()+'@example.test',phone:'000'+randomUUID().replaceAll('-','').slice(0,7)}:{name:'合成付款買家',email:'synthetic-payment@example.test',phone:'0000000000'};
  let response = await context.request.post(root + '/checkouts', { data: { publication_revision: '1', lines: [{ sku: store.product.sku, quantity: 1 }], contact, delivery: { method: 'synthetic', address: options.randomContact?'合成測試地址-'+randomUUID():'合成測試地址' }, invoice: null, consents: [] }, headers: { Origin: origin, 'Idempotency-Key': randomUUID() } });
  assert.equal(response.status(), 201, 'payment checkout fixture failed');
  const checkout = CheckoutResponseSchema.parse(await response.json());
  response = await context.request.post(root + `/checkouts/${checkout.checkout_ref}/orders`, { data: { terms_sha256: checkout.terms_sha256, client_order_id: randomUUID() }, headers: { Origin: origin } });
  assert.equal(response.status(), 201, 'payment placement fixture failed');
  const placed = PlaceOrderResponseSchema.parse(await response.json());
  assert(placed.payment);
  return { store, order: placed.order, payment: placed.payment };
}
