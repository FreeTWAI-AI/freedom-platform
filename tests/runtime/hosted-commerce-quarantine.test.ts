import assert from 'node:assert/strict';
import {createHash, randomBytes, randomInt, randomUUID} from 'node:crypto';
import {after, before, beforeEach, test} from 'node:test';
import {shippingSettingsHarness, type ShippingSettingsHarness, type ShippingTestStore} from './module-registry-harness.js';
import {SERVICE_KEYS} from '../../modules/agent-commerce/fulfilment/rules/types.js';
import {IMPLEMENTED_PROVIDER_PROFILES} from '../../modules/agent-commerce/operations/runtime-settings.js';

let h: ShippingSettingsHarness;
before(async () => { h = await shippingSettingsHarness('fp_commerce_quarantine'); });
beforeEach(async () => { await h.reset(); });
after(async () => { await h?.stop(); });

// Compare complete persisted rows, including credentials, versions, receipts,
// fresh-proof consumption and control events, without printing their contents.
async function snapshot() {
  const tables = (await h.f.x.h.pool.query(`SELECT tablename FROM pg_tables
    WHERE schemaname=current_schema() AND (tablename LIKE 'commerce_%'
      OR tablename LIKE 'hosted_%' OR tablename IN
      ('tenants','module_instances','tenant_high_risk_verifications','scoped_command_receipts','scoped_transition_journal'))
    ORDER BY tablename`)).rows as {tablename: string}[];
  assert(tables.some(t => t.tablename === 'scoped_command_receipts'));
  const hashes: Record<string, string> = {};
  for (const {tablename} of tables) {
    assert.match(tablename, /^[a-z_]+$/);
    const {rows} = await h.f.x.h.pool.query(`SELECT to_jsonb(t) AS row FROM "${tablename}" t ORDER BY to_jsonb(t)::text`);
    hashes[tablename] = createHash('sha256').update(JSON.stringify(rows)).digest('hex');
  }
  hashes.journal = createHash('sha256').update(JSON.stringify([...h.f.journal.objects.entries()].sort())).digest('hex');
  return hashes;
}

async function blockedThenAllowed(s: ShippingTestStore, method: string, path: string, body: unknown, version?: string, status = 200) {
  const key = randomUUID(), before = await snapshot();
  h.f.settings.quarantine = true;
  try {
    const denied = await h.request(s, method, path, body, version, s.owner, key);
    assert.equal(denied.status, 503, `${method} ${path}: ${JSON.stringify(denied.data)}`);
    assert.equal(denied.data.code, 'commerce_quarantined');
    assert.match(denied.response.headers.get('Cache-Control') ?? '', /no-store/);
    assert.deepEqual(await snapshot(), before, `${method} ${path} must not mutate persisted rows or journal`);
  } finally { h.f.settings.quarantine = false; }
  // The identical proof, key, body and version must still work after reopening.
  return h.expect(await h.request(s, method, path, body, version, s.owner, key), status);
}

test('quarantine blocks all shipping settings writes without receipts and preserves authorized GETs', async () => {
  const s = await h.store();
  const location = await blockedThenAllowed(s, 'POST', '/ship-from-locations', h.locationInput(), undefined, 201);
  await blockedThenAllowed(s, 'PUT', '/shipping-profile', h.document(), undefined, 201);
  await blockedThenAllowed(s, 'PUT', `/products/${s.product.product_id}/shipping-attributes`, h.attributes(), undefined, 201);
  const reader = await h.member(s, ['store:read']), fulfiller = await h.member(s, ['store:fulfil']);
  for (const session of [s.owner, reader.session, fulfiller.session]) {
    for (const path of ['/ship-from-locations', `/ship-from-locations/${location.location_id}`, '/shipping-profile', `/products/${s.product.product_id}/shipping-attributes`]) {
      const before = await h.request(s, 'GET', path, undefined, undefined, session);
      h.f.settings.quarantine = true;
      const during = await h.request(s, 'GET', path, undefined, undefined, session);
      h.f.settings.quarantine = false;
      assert.equal(during.status, before.status);
      assert.deepEqual(during.data, before.data);
    }
  }
  await blockedThenAllowed(s, 'POST', `/ship-from-locations/${location.location_id}/retire`, {});
});

test('quarantine blocks offline settings before consuming fresh proof and preserves its GET projection', async () => {
  h.f.settings.providerProfiles = [...IMPLEMENTED_PROVIDER_PROFILES]; h.f.install();
  const s = await h.store(), proof = await h.fresh(s);
  const body = {schema: 'freedom.offline-payment-settings/v1', fresh_auth_verification_id: proof,
    bank_transfer: {bank_code: String(randomInt(100, 1000)), bank_name: '青禾川石林安', branch_name: '白南青禾川石',
      account_number: Array.from({length: 12}, () => randomInt(10)).join(''), account_name: '青禾川石林安白南', note: '白南青禾川石林安'}, cash_on_meetup: {}};
  await blockedThenAllowed(s, 'PUT', '/offline-payment-settings', body, undefined, 201);
  const before = h.expect(await h.request(s, 'GET', '/offline-payment-settings'));
  h.f.settings.quarantine = true;
  assert.deepEqual(h.expect(await h.request(s, 'GET', '/offline-payment-settings')), before);
});

test('quarantine covers account creation, credential rotation and every service and logistics state command', async () => {
  const s = await h.store(); let account = await h.provider(s, [SERVICE_KEYS[0]], true);
  const root = `/provider-accounts/${account.account_id}`;
  account = await blockedThenAllowed(s, 'PUT', root + '/services/logistics', {
    profile: 'ecpay.logistics.domestic.v1', hash_key: randomBytes(8).toString('hex'), hash_iv: randomBytes(8).toString('hex'), fresh_auth_verification_id: await h.fresh(s),
  }, account.version);
  account = await blockedThenAllowed(s, 'POST', root + '/logistics-services', {service_key: SERVICE_KEYS[1], fresh_auth_verification_id: await h.fresh(s)}, account.version, 201);
  for (const suffix of [`/logistics-services/${SERVICE_KEYS[0]}`, '/services/logistics']) {
    for (const action of ['suspend', 'resume', 'retire']) {
      account = await blockedThenAllowed(s, 'POST', root + suffix + '/' + action, {fresh_auth_verification_id: await h.fresh(s)}, account.version);
    }
  }
  await blockedThenAllowed(s, 'POST', '/provider-accounts', {provider: 'ecpay', environment: 'sandbox', merchant_id: String(randomInt(1000000, 10000000)), fresh_auth_verification_id: await h.fresh(s)}, undefined, 201);
  const before = h.expect(await h.request(s, 'GET', '/provider-accounts'));
  h.f.settings.quarantine = true;
  assert.deepEqual(h.expect(await h.request(s, 'GET', '/provider-accounts')), before);
});

test('quarantine also covers neighboring release, storefront root and product writes', async () => {
  const s = await h.f.x.store();
  const release = h.expect(await h.request(s, 'GET', '/release'));
  await blockedThenAllowed(s, 'POST', '/upgrade', {}, release.version);
  const store = h.expect(await h.request(s, 'GET', ''));
  await blockedThenAllowed(s, 'PATCH', '', {name: '合成隔離商店'}, store.version);
  await blockedThenAllowed(s, 'PATCH', `/products/${s.product.product_id}`, {title: '合成隔離商品'}, s.product.version);
});
