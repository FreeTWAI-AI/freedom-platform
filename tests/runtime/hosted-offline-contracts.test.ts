import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {after, test} from 'node:test';
import {createApp} from '../../apps/platform-api/src/app.js';
import {TENANT_CURSOR_TEST_KEY} from './tenant-cursor-fixture.js';
import * as checkout from '../../contracts/guild-launchpad/v1/hosted-checkout.js';
import * as offline from '../../contracts/guild-launchpad/v1/hosted-offline-payment.js';
import {syntheticShippingQuote} from '../../scripts/synthetic-shipping-quote.js';
import {IMPLEMENTED_PROVIDER_PROFILES} from '../../modules/agent-commerce/operations/runtime-settings.js';
import {OFFLINE_PAYMENT_REQUIRES_MEMBER} from '../../modules/agent-commerce/payments/offline/methods.js';
import {hostOfflineProfiles, OFFLINE_BANK_PROFILE, OFFLINE_MEETUP_PROFILE} from '../../modules/agent-commerce/payments/offline/settings.js';
import {DEMO_PASSWORD} from '../../packages/testing/seed.js';
import {checkoutHarness, type CheckoutHarness} from './hosted-checkout-harness.js';

const offlineBundle = JSON.parse(readFileSync(new URL('../../contracts/guild-launchpad/v1/hosted-offline-payment.schema.json', import.meta.url), 'utf8'));
const checkoutBundle = JSON.parse(readFileSync(new URL('../../contracts/guild-launchpad/v1/hosted-checkout.schema.json', import.meta.url), 'utf8'));
const SCHEMA = 'freedom.offline-payment-settings/v1';
const time = '2028-02-29T12:34:56.789Z';
let x: CheckoutHarness | undefined;

function validate(bundle: unknown, cases: {name: string; value: unknown; valid: boolean}[]) {
  const result = spawnSync('python3', ['-c', `import json,sys
from jsonschema import Draft202012Validator, FormatChecker
x=json.load(sys.stdin)
Draft202012Validator.check_schema(x['bundle'])
for c in x['cases']:
  s=x['bundle']['$defs'][c['name']]
  Draft202012Validator.check_schema(s)
  assert Draft202012Validator(s, format_checker=FormatChecker()).is_valid(c['value']) == c['valid'], c
print(len(x['cases']))`], {input: JSON.stringify({bundle, cases}), encoding: 'utf8', timeout: 15000});
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(Number(result.stdout), cases.length);
}
function shipping(method: checkout.ShippingMethodRef) {
  const shop = randomUUID();
  return syntheticShippingQuote({
    lines: [{sku: 'P0001', item_id: randomUUID(), quantity: 1, unit_price_minor: 100, supplier_shop_id: shop, own: true}],
    merchandise_net_minor: 100,
  }, {method_ref: method});
}
function publicShipping(quote: ReturnType<typeof shipping>) {
  return {
    destination_state: quote.destination_state,
    groups: quote.groups.map(group => ({
      group_ref: group.group_ref, method: group.method_ref, amount_minor: group.amount_minor,
      fee_per_parcel_minor: group.fee_per_parcel_minor, outlying_surcharge_per_parcel_minor: group.outlying_surcharge_per_parcel_minor,
      parcel_count: group.parcels.length, handling_days: group.logistics?.handling_days ?? null,
      items: group.parcels.flatMap(parcel => parcel.lines), meetup_note: group.meetup?.note ?? null,
    })),
  };
}
type OfflineTerms = {settings_version: string; bank_transfer_deadline_days: number | null; meetup_deadline_days: number | null};
function terms(methods: readonly string[], offlinePayment: OfflineTerms | null, method: checkout.ShippingMethodRef = 'home') {
  const quote = shipping(method);
  const shippingTotal = quote.groups.reduce((sum, group) => sum + group.amount_minor, 0);
  const shared = {
    publication_revision: '1', currency: 'TWD' as const,
    items: [{sku: 'P0001', title: '合成商品', quantity: 1, unit_price_minor: 100, line_total_minor: 100}],
    merchandise_total_minor: 100, discount_total_minor: 0 as const, discounts: [], shipping: quote,
    shipping_total_minor: shippingTotal, tax_state: 'not_assessed' as const, total_minor: 100 + shippingTotal, consents: [],
    payment_methods: [...methods], offline_payment: offlinePayment,
  };
  return {quote, shared};
}
function expectTerms(label: string, methods: readonly string[], offlinePayment: OfflineTerms | null, valid: boolean) {
  const home = terms(methods, offlinePayment, 'home');
  const publication = randomUUID();
  const shop = home.quote.groups[0].supplier_shop_id;
  const frozen = {
    profile: 'freedom.checkout-terms/v1' as const, publication_id: publication, publication_revision: '1', currency: 'TWD' as const,
    bindings: [{selection_id: randomUUID(), item_id: randomUUID(), version: '1', sku: 'P0001', quantity: 1, supplier_shop_id: shop, supplier_instance_id: randomUUID(), offer_id: null, offer_sha256: null, acceptance_id: null, listing_sha256: null, unit_price_minor: 100}],
    items: [{sku: 'P0001', title: '合成商品', quantity: 1, unit_price_minor: 100, line_total_minor: 100, offer_sha256: null}],
    merchandise_total_minor: 100, discount_total_minor: 0 as const, discounts: [], shipping: home.quote, shipping_total_minor: home.shared.shipping_total_minor,
    tax_state: 'not_assessed' as const, total_minor: home.shared.total_minor, consents: [], payment_methods: [...methods], offline_payment: offlinePayment, contact_sha256: 'a'.repeat(64),
  };
  const published = {...home.shared, items: [{sku: 'P0001', title: '合成商品', quantity: 1, unit_price_minor: 100, line_total_minor: 100}], shipping: publicShipping(home.quote)};
  const frozenResult = checkout.CheckoutTermsSchema.safeParse(frozen);
  const publicResult = checkout.PublicCheckoutTermsSchema.safeParse(published);
  assert.equal(frozenResult.success, valid, `${label} frozen ${frozenResult.success ? '' : JSON.stringify(frozenResult.error.issues)}`);
  assert.equal(publicResult.success, valid, `${label} public ${publicResult.success ? '' : JSON.stringify(publicResult.error.issues)}`);
}

after(async () => { await x?.stop(); });

test('offline settings schemas match the generated contract and keep field ranges out of the input shape', () => {
  assert.equal(offlineBundle.$id, 'https://freetwai.com/contracts/guild-launchpad/v1/hosted-offline-payment');
  assert.deepEqual(Object.keys(offlineBundle.$defs), ['settings-input', 'settings-view', 'field-error-code', 'field-error', 'error-code', 'error']);
  assert.deepEqual(offlineBundle.$defs['field-error-code'].enum, [...offline.OfflineSettingsFieldErrorCodeSchema.options]);
  assert.deepEqual(offlineBundle.$defs['error-code'].enum, [...offline.OfflineSettingsErrorCodeSchema.options]);
  assert.match(offlineBundle.$defs['settings-input'].description, /field_rules_are_not_structural/);
  assert.match(offlineBundle.$defs['settings-view'].description, /version_saved_at_settings_together/);
  assert.match(offlineBundle.$defs['settings-view'].description, /account_number_null_exactly_for_last4/);
  const fresh = randomUUID();
  const input = {schema: SCHEMA, bank_transfer: {bank_code: '004', bank_name: '青禾川', account_number: '12345678', account_name: '石林安', deadline_days: 8}, cash_on_meetup: {deadline_days: 15}, fresh_auth_verification_id: fresh};
  const full = {version: '1', saved_at: time, account_visibility: 'full', host_profiles: {bank_transfer: true, cash_on_meetup: false}, settings: {bank_transfer: {bank_code: '004', bank_name: '青禾川', branch_name: null, account_number: '12345678', account_number_last4: '5678', account_name: '石林安', deadline_days: 3, note: null}, cash_on_meetup: {deadline_days: 7}}};
  const masked = {...full, account_visibility: 'last4', settings: {...full.settings, bank_transfer: {...full.settings.bank_transfer, account_number: null}}};
  const empty = {version: null, saved_at: null, account_visibility: 'full', host_profiles: {bank_transfer: false, cash_on_meetup: true}, settings: null};
  const field = {path: 'bank_transfer.account_number', code: 'too_short'};
  const error = {type: 'about:blank', title: 'offline_settings_invalid', status: 422, code: 'offline_settings_invalid', detail: '收款設定有誤。', fields: [field]};
  assert.equal(offline.OfflinePaymentSettingsInputSchema.safeParse(input).success, true);
  assert.equal(offline.OfflinePaymentSettingsViewSchema.safeParse({...full, settings: {...full.settings, bank_transfer: {...full.settings.bank_transfer, deadline_days: 8}}}).success, false);
  const leaked = {...masked, settings: {...masked.settings, bank_transfer: {...masked.settings.bank_transfer, account_number: '12345678'}}};
  const split = {...full, saved_at: null, settings: null};
  assert.equal(offline.OfflinePaymentSettingsViewSchema.safeParse(leaked).success, false);
  assert.equal(offline.OfflinePaymentSettingsViewSchema.safeParse(split).success, false);
  const cases: {name: string; value: unknown; valid: boolean}[] = [
    {name: 'settings-input', value: input, valid: true},
    {name: 'settings-input', value: {...input, secret: 'forbidden'}, valid: false},
    {name: 'settings-input', value: null, valid: false},
    {name: 'settings-input', value: {...input, bank_transfer: {...input.bank_transfer, deadline_days: 1.5}}, valid: false},
    {name: 'settings-view', value: full, valid: true},
    {name: 'settings-view', value: masked, valid: true},
    {name: 'settings-view', value: empty, valid: true},
    {name: 'settings-view', value: {...full, secret: 'forbidden'}, valid: false},
    {name: 'settings-view', value: null, valid: false},
    {name: 'settings-view', value: leaked, valid: true},
    {name: 'settings-view', value: split, valid: true},
    {name: 'field-error', value: field, valid: true},
    {name: 'field-error', value: {...field, value: '12345'}, valid: false},
    {name: 'field-error', value: null, valid: false},
    {name: 'error', value: error, valid: true},
    {name: 'error', value: {...error, fields: undefined}, valid: true},
    {name: 'error', value: {...error, account_number: '12345678'}, valid: false},
    {name: 'error', value: null, valid: false},
  ];
  for (const code of offline.OfflineSettingsFieldErrorCodeSchema.options) cases.push({name: 'field-error-code', value: code, valid: true});
  cases.push({name: 'field-error-code', value: 'invented', valid: false}, {name: 'field-error-code', value: null, valid: false});
  for (const code of ['offline_settings_invalid', 'invalid_command_json', 'validation_failed', 'version_conflict'] as const) cases.push({name: 'error-code', value: code, valid: true});
  cases.push({name: 'error-code', value: 'invented', valid: false}, {name: 'error-code', value: null, valid: false});
  validate(offlineBundle, cases);
});

test('profile ids and payment method names are the runtime constants', () => {
  assert.deepEqual([...IMPLEMENTED_PROVIDER_PROFILES], ['ecpay.aio.credit.v1', OFFLINE_BANK_PROFILE, OFFLINE_MEETUP_PROFILE]);
  assert.deepEqual([...checkout.PAYMENT_METHODS], ['immediate_card', 'bank_transfer', 'cash_on_meetup']);
  assert.deepEqual(hostOfflineProfiles(IMPLEMENTED_PROVIDER_PROFILES), {bank_transfer: true, cash_on_meetup: true});
  assert.equal(OFFLINE_BANK_PROFILE, 'offline.bank_transfer.v1');
  assert.equal(OFFLINE_MEETUP_PROFILE, 'offline.cash_on_meetup.v1');
  assert.equal(OFFLINE_PAYMENT_REQUIRES_MEMBER, true);
  const quoted = shipping('home');
  const meetup = shipping('meetup');
  assert.equal(checkout.CheckoutShippingSchema.safeParse(quoted).success, true);
  assert.equal(checkout.CheckoutShippingSchema.safeParse(meetup).success, true);
  assert.equal(meetup.groups[0].method_ref, 'meetup');
  assert.equal(meetup.groups[0].fulfilment_mode, 'self');
  validate(checkoutBundle, [
    {name: 'checkout-shipping', value: quoted, valid: true},
    {name: 'checkout-shipping', value: meetup, valid: true},
    {name: 'checkout-shipping', value: {...quoted, secret: 'forbidden'}, valid: false},
    {name: 'checkout-shipping', value: null, valid: false},
  ]);
});

test('canonical payment methods and offline deadlines stay coupled on frozen and public terms', () => {
  const both = {settings_version: '1', bank_transfer_deadline_days: 3, meetup_deadline_days: 7};
  expectTerms('card only', ['immediate_card'], null, true);
  expectTerms('card with an offline block', ['immediate_card'], both, false);
  expectTerms('bank', ['immediate_card', 'bank_transfer'], {...both, meetup_deadline_days: null}, true);
  expectTerms('meetup', ['cash_on_meetup'], {...both, bank_transfer_deadline_days: null}, true);
  expectTerms('both offline methods', ['bank_transfer', 'cash_on_meetup'], both, true);
  expectTerms('wrong order', ['cash_on_meetup', 'bank_transfer'], both, false);
  expectTerms('duplicate', ['bank_transfer', 'bank_transfer'], {...both, meetup_deadline_days: null}, false);
  expectTerms('bank deadline without its method', ['immediate_card'], {...both, meetup_deadline_days: null}, false);
  expectTerms('meetup deadline without its method', ['bank_transfer'], both, false);
  expectTerms('method without a deadline', ['bank_transfer', 'cash_on_meetup'], {...both, meetup_deadline_days: null}, false);
  expectTerms('bank lower bound', ['bank_transfer'], {settings_version: '1', bank_transfer_deadline_days: 1, meetup_deadline_days: null}, true);
  expectTerms('bank upper bound', ['bank_transfer'], {settings_version: '1', bank_transfer_deadline_days: 7, meetup_deadline_days: null}, true);
  expectTerms('meetup upper bound', ['cash_on_meetup'], {settings_version: '1', bank_transfer_deadline_days: null, meetup_deadline_days: 14}, true);
  expectTerms('bank above range', ['bank_transfer'], {settings_version: '1', bank_transfer_deadline_days: 8, meetup_deadline_days: null}, false);
  expectTerms('meetup above range', ['cash_on_meetup'], {settings_version: '1', bank_transfer_deadline_days: null, meetup_deadline_days: 15}, false);
  expectTerms('deadline zero', ['bank_transfer'], {settings_version: '1', bank_transfer_deadline_days: 0, meetup_deadline_days: null}, false);
  const meetupTerms = terms(['cash_on_meetup'], {settings_version: '1', bank_transfer_deadline_days: null, meetup_deadline_days: 7}, 'meetup');
  const published = {...meetupTerms.shared, items: [{sku: 'P0001', title: '合成商品', quantity: 1, unit_price_minor: 100, line_total_minor: 100}], shipping: publicShipping(meetupTerms.quote)};
  assert.equal(checkout.PublicCheckoutTermsSchema.safeParse(published).success, true, 'meetup shipping fixture');
  assert.equal(published.shipping.groups[0].method, 'meetup');
  assert.equal(published.shipping.groups[0].meetup_note, '面交取貨');
});

test('settings and cart routes parse with the generated schemas', async () => {
  x = await checkoutHarness('fp_offline_contracts');
  await x.reset();
  const common = {guildLaunchpadEnabled: true, hostedReservationsEnabled: true, tenantCursorSigningKey: TENANT_CURSOR_TEST_KEY};
  const app = createApp(x.runtime, x.h.origin, 'local', {...common, commerceSettings: {consoleEnabled: true, checkoutEnabled: true, quarantine: false, providerProfiles: [...IMPLEMENTED_PROVIDER_PROFILES]}});
  await x.h.pool.query(`INSERT INTO tenant_authority_policies(revision,status,fresh_auth_ttl_seconds,transfer_ttl_seconds,recovery_approval_ttl_seconds,max_open_recovery_cases_per_tenant)
    SELECT 1,'active',600,86400,86400,1 WHERE NOT EXISTS (SELECT 1 FROM tenant_authority_policies WHERE status='active')`);
  const s = await x.store();
  const version = (await x.h.pool.query('SELECT version::text FROM module_instances WHERE instance_id=$1', [s.instanceId])).rows[0].version as string;
  const upgraded = await x.send(s, '/upgrade', {}, version);
  assert.equal(upgraded.status, 200, JSON.stringify(upgraded.data));
  const path = `/tenants/${s.tenantId}/storefronts/${s.instanceId}/offline-payment-settings`;
  const empty = await x.h.call('GET', path, s.owner, undefined, {}, app);
  assert.equal(empty.status, 200, JSON.stringify(empty.data));
  assert.deepEqual(empty.data.host_profiles, hostOfflineProfiles(IMPLEMENTED_PROVIDER_PROFILES));
  assert.equal(offline.OfflinePaymentSettingsViewSchema.safeParse(empty.data).success, true);
  const proof = await x.h.call('POST', '/me/high-risk-verifications', s.owner, {tenant_id: s.tenantId, purpose: 'commerce.provider_account.write', password: DEMO_PASSWORD}, {'Idempotency-Key': randomUUID()}, app);
  assert.equal(proof.status, 201, JSON.stringify(proof.data));
  const invalid = await x.h.call('PUT', path, s.owner, {schema: SCHEMA, bank_transfer: {bank_code: '12', bank_name: '青禾', account_number: '12345', account_name: '石林'}, cash_on_meetup: null, fresh_auth_verification_id: proof.data.verification_id}, {'Idempotency-Key': randomUUID()}, app);
  assert.equal(invalid.status, 422, JSON.stringify(invalid.data));
  assert.equal(offline.OfflineSettingsErrorSchema.safeParse(invalid.data).success, true, JSON.stringify(invalid.data));
  const body = {schema: SCHEMA, bank_transfer: {bank_code: '004', bank_name: '青禾川', branch_name: '石林', account_number: '12345678', account_name: '安白南', deadline_days: 3, note: '川石'}, cash_on_meetup: {deadline_days: 7}, fresh_auth_verification_id: proof.data.verification_id};
  const saved = await x.h.call('PUT', path, s.owner, body, {'Idempotency-Key': randomUUID()}, app);
  assert.equal(saved.status, 201, JSON.stringify(saved.data));
  assert.equal(offline.OfflinePaymentSettingsViewSchema.safeParse(saved.data).success, true, JSON.stringify(saved.data));
  assert.equal(saved.data.settings.bank_transfer.account_number, '12345678');
  assert.deepEqual(saved.data.host_profiles, {bank_transfer: true, cash_on_meetup: true});
  validate(offlineBundle, [
    {name: 'settings-view', value: empty.data, valid: true},
    {name: 'settings-view', value: saved.data, valid: true},
    {name: 'error', value: invalid.data, valid: true},
    {name: 'settings-input', value: body, valid: true},
  ]);
  const adminId = randomUUID();
  await x.h.pool.query(`INSERT INTO platform_admins(admin_id,community_id,email,display_name)
    SELECT $1, community_id, $2, '合成准入' FROM tenants WHERE tenant_id=$3`, [adminId, `synthetic-admit-${adminId}@example.test`, s.tenantId]);
  await x.h.pool.query(`INSERT INTO commerce_store_admissions(tenant_id,instance_id,environment,admitted_by,reason)
    VALUES($1,$2,'sandbox',$3,'合成結帳報價')`, [s.tenantId, s.instanceId, adminId]);
  const quote = await x.h.call('POST', `/public/stores/${s.slug}/cart-quotes`, undefined, {publication_revision: '1', lines: [{sku: s.product.sku, quantity: 1}]}, {'Idempotency-Key': randomUUID()}, app);
  assert.equal(quote.status, 200, JSON.stringify(quote.data));
  const parsed = checkout.CartQuoteResponseSchema.safeParse(quote.data);
  assert.equal(parsed.success, true, parsed.success ? '' : JSON.stringify(parsed.error.issues));
  assert.ok(Array.isArray(quote.data.payment_options));
  assert.ok(Array.isArray(quote.data.delivery_options));
  assert.deepEqual(quote.data.payment_options, [
    {method: 'bank_transfer', available: false, reason: 'member_required'},
    {method: 'cash_on_meetup', available: false, reason: 'meetup_required'},
  ]);
  assert.equal(checkout.CartQuoteResponseSchema.safeParse({...quote.data, payment_options: undefined}).success, false);
  assert.equal(checkout.CartQuoteResponseSchema.safeParse({...quote.data, delivery_options: undefined}).success, false);
  validate(checkoutBundle, [
    {name: 'cart-quote', value: quote.data, valid: true},
    {name: 'cart-quote', value: {...quote.data, payment_options: undefined}, valid: false},
    {name: 'cart-quote', value: {...quote.data, delivery_options: undefined}, valid: false},
  ]);
});
