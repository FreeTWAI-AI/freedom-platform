import assert from 'node:assert/strict';
import {randomInt, randomUUID} from 'node:crypto';
import {after, before, beforeEach, test} from 'node:test';
import {createApp} from '../../apps/platform-api/src/app.js';
import {TENANT_CURSOR_TEST_KEY} from './tenant-cursor-fixture.js';
import {OfflinePaymentSettingsViewSchema, OfflineSettingsErrorSchema} from '../../contracts/guild-launchpad/v1/hosted-offline-payment.js';
import {hashJSON} from '../../modules/agent-commerce/checkout/terms.js';
import {authenticate, type Actor} from '../../modules/identity-membership/service.js';
import {IMPLEMENTED_PROVIDER_PROFILES} from '../../modules/agent-commerce/operations/runtime-settings.js';
import {saveOfflinePaymentSettings, OFFLINE_BANK_PROFILE, OFFLINE_MEETUP_PROFILE} from '../../modules/agent-commerce/payments/offline/settings.js';
import {Problem} from '../../packages/shared/problem.js';
import {DEMO_PASSWORD} from '../../packages/testing/seed.js';
import {checkoutHarness, type CheckoutHarness} from './hosted-checkout-harness.js';
import type {Session} from './module-registry-harness.js';

const SYLLABLES = ['青', '禾', '川', '石', '林', '安', '白', '南'] as const;
const SCHEMA = 'freedom.offline-payment-settings/v1';
const STRING_FIELDS = ['bank_code', 'bank_name', 'branch_name', 'account_number', 'account_name', 'note'] as const;
type Store = Awaited<ReturnType<CheckoutHarness['store']>>;
type Reply = {status: number; data: any; response: Response};

let x: CheckoutHarness;
let app: ReturnType<typeof createApp>;
let closed: ReturnType<typeof createApp>;

function syntheticName(length = 4) {
  let name = '';
  for (let i = 0; i < length; i++) name += SYLLABLES[randomInt(SYLLABLES.length)];
  return name;
}
function digits(length: number) {
  let value = '';
  for (let i = 0; i < length; i++) value += String(randomInt(10));
  return value;
}
function bankCode() {
  return String(100 + randomInt(900));
}
function separated(account: string) {
  return `${account.slice(0, 2)} ${account.slice(2, 4)}-${account.slice(4, 6)} ${account.slice(6)}`;
}
function settingsPath(tenantId: string, instanceId: string) {
  return `/tenants/${tenantId}/storefronts/${instanceId}/offline-payment-settings`;
}
function bank(overrides: Record<string, unknown> = {}) {
  return {bank_code: bankCode(), bank_name: syntheticName(6), branch_name: syntheticName(6), account_number: digits(12), account_name: syntheticName(8), note: syntheticName(8), ...overrides};
}
function command(freshId: string, bankTransfer: unknown, meetup: unknown = {}) {
  return {schema: SCHEMA, bank_transfer: bankTransfer, cash_on_meetup: meetup, fresh_auth_verification_id: freshId};
}
function pairs(fields: {path: string; code: string}[]) {
  return fields.map(field => `${field.path}:${field.code}`).sort();
}
function problemOf(error: unknown) {
  assert.ok(error instanceof Problem, error instanceof Error ? error.message : String(error));
  return error;
}

before(async () => {
  x = await checkoutHarness('fp_offline_settings');
  const common = {guildLaunchpadEnabled: true, hostedReservationsEnabled: true, tenantCursorSigningKey: TENANT_CURSOR_TEST_KEY};
  app = createApp(x.runtime, x.h.origin, 'local', {...common, commerceSettings: {consoleEnabled: true, checkoutEnabled: true, quarantine: false, providerProfiles: [...IMPLEMENTED_PROVIDER_PROFILES]}});
  closed = createApp(x.runtime, x.h.origin, 'local', common);
});
beforeEach(async () => {
  await x.reset();
  await x.h.pool.query(`INSERT INTO tenant_authority_policies(revision,status,fresh_auth_ttl_seconds,transfer_ttl_seconds,recovery_approval_ttl_seconds,max_open_recovery_cases_per_tenant)
    SELECT 1,'active',600,86400,86400,1 WHERE NOT EXISTS (SELECT 1 FROM tenant_authority_policies WHERE status='active')`);
});
after(async () => { await x?.stop(); });

async function shop() {
  const s = await x.store();
  const version = (await x.h.pool.query('SELECT version::text FROM module_instances WHERE instance_id=$1', [s.instanceId])).rows[0].version as string;
  const upgraded = await x.send(s, '/upgrade', {}, version);
  assert.equal(upgraded.status, 200, JSON.stringify(upgraded.data));
  return s;
}
async function fresh(session: Session, tenantId: string) {
  const reply = await x.h.call('POST', '/me/high-risk-verifications', session, {tenant_id: tenantId, purpose: 'commerce.provider_account.write', password: DEMO_PASSWORD}, {'Idempotency-Key': randomUUID()}, app);
  assert.equal(reply.status, 201, JSON.stringify(reply.data));
  return reply.data.verification_id as string;
}
async function actorOf(session: Session): Promise<Actor> {
  return authenticate(x.runtime, session.cookie.slice(session.cookie.indexOf('=') + 1));
}
function put(s: Store, session: Session, body: unknown, headers: Record<string, string> = {}, target = app) {
  return x.h.call('PUT', settingsPath(s.tenantId, s.instanceId), session, body, {'Idempotency-Key': randomUUID(), ...headers}, target) as Promise<Reply>;
}
function get(s: Store, session: Session, target = app) {
  return x.h.call('GET', settingsPath(s.tenantId, s.instanceId), session, undefined, {}, target) as Promise<Reply>;
}
async function rows(instanceId: string) {
  const settings = (await x.h.pool.query('SELECT version::text, document, document_sha256 FROM commerce_offline_payment_settings WHERE instance_id=$1 ORDER BY version', [instanceId])).rows as {version: string; document: any; document_sha256: string}[];
  const receipts = (await x.h.pool.query("SELECT response FROM scoped_command_receipts WHERE operation='commerce.offline_payment_settings.save' AND target_id=$1", [instanceId])).rows as {response: {id?: string}}[];
  const events = (await x.h.pool.query("SELECT detail FROM commerce_control_events WHERE kind='offline_payment_settings.changed' AND instance_id=$1 ORDER BY (detail->>'settings_version')::int", [instanceId])).rows as {detail: {settings_version: number; methods: string}}[];
  return {settings, receipts, events};
}
async function verificationOpen(id: string) {
  return (await x.h.pool.query('SELECT consumed_at IS NULL AS open FROM tenant_high_risk_verifications WHERE verification_id=$1', [id])).rows[0].open === true;
}
async function grant(s: Store, role: 'admin' | 'operator', caps: string[] | null) {
  const session = (await x.h.person(syntheticName(4))).session;
  const principal = await x.h.candidate(s.owner, session.user.user_id);
  const invite = await x.h.invite(s.owner, s.tenantId, principal, role);
  assert.equal(invite.status, 201, JSON.stringify(invite.data));
  await x.h.accept(session, s.tenantId, invite);
  if (caps) await x.h.pool.query(`INSERT INTO tenant_module_permissions(tenant_id,principal_id,instance_id,capabilities,status,granted_by_principal_id)
    SELECT $1,$2,$3,$4::text[],'active',principal_id FROM principals WHERE user_ref=$5`, [s.tenantId, principal, s.instanceId, caps, s.owner.user.user_id]);
  return session;
}
function assertSecretsAbsent(serialized: string, secrets: string[]) {
  for (const secret of secrets) {
    assert.ok(secret.length >= 6, secret);
    assert.equal(serialized.includes(secret), false, secret);
  }
}
async function sinkText(extra: unknown) {
  const journal = (await x.h.pool.query('SELECT * FROM scoped_transition_journal')).rows;
  return JSON.stringify({journal, extra});
}
async function sqlReject(sql: string, params: unknown[], message: RegExp) {
  await assert.rejects(x.h.pool.query(sql, params), (error: unknown) => {
    const failed = error as {code?: string; message?: string};
    assert.equal(failed.code, '23514', failed.message ?? 'SQL must reject the mutation');
    assert.match(failed.message ?? '', message);
    return true;
  });
}

test('every settings field code can fail alone or together and writes nothing', async () => {
  const s = await shop();
  const proof = await fresh(s.owner, s.tenantId);
  const accountName = '禾'.repeat(41);
  const branch = `\u0001${syntheticName(8)}`;
  const cases: {body: ReturnType<typeof command>; expected: string[]}[] = [
    {body: command(proof, bank({bank_name: '   '})), expected: ['bank_transfer.bank_name:required']},
    {body: command(proof, bank({bank_code: '12'})), expected: ['bank_transfer.bank_code:format']},
    {body: command(proof, bank({account_number: '12345'})), expected: ['bank_transfer.account_number:too_short']},
    {body: command(proof, bank({bank_name: '青'.repeat(21)})), expected: ['bank_transfer.bank_name:too_long']},
    {body: command(proof, bank({deadline_days: 8})), expected: ['bank_transfer.deadline_days:out_of_range']},
    {body: command(proof, bank({bank_code: '12', account_number: '12345', bank_name: '', account_name: accountName, branch_name: branch, deadline_days: 8}), {deadline_days: 0}), expected: [
      'bank_transfer.bank_code:format', 'bank_transfer.account_number:too_short', 'bank_transfer.bank_name:required',
      'bank_transfer.account_name:too_long', 'bank_transfer.branch_name:format', 'bank_transfer.deadline_days:out_of_range', 'cash_on_meetup.deadline_days:out_of_range',
    ]},
  ];
  for (const item of cases) {
    const reply = await put(s, s.owner, item.body);
    assert.equal(reply.status, 422, JSON.stringify(reply.data));
    const error = OfflineSettingsErrorSchema.parse(reply.data);
    assert.equal(error.code, 'offline_settings_invalid');
    assert.equal(error.detail, '收款設定有誤。');
    assert.deepEqual(pairs(error.fields ?? []), item.expected.slice().sort());
    assertSecretsAbsent(JSON.stringify(reply.data), [accountName, branch]);
  }
  const structural = await put(s, s.owner, command(proof, bank({deadline_days: 1.5})));
  assert.equal(structural.status, 422, JSON.stringify(structural.data));
  assert.equal(structural.data.code, 'validation_failed');
  const extra = await put(s, s.owner, {...command(proof, bank()), unexpected: true});
  assert.equal(extra.status, 422, JSON.stringify(extra.data));
  assert.equal(extra.data.code, 'validation_failed');
  assert.equal(await verificationOpen(proof), true);
  assert.deepEqual(await rows(s.instanceId), {settings: [], receipts: [], events: []});
  const operator = await grant(s, 'operator', ['store:read', 'store:manage']);
  const denied = await put(s, operator, command(randomUUID(), bank({bank_code: '12'})));
  assert.equal(denied.status, 403, JSON.stringify(denied.data));
  assert.equal(denied.data.code, 'capability_denied');
  assert.deepEqual(await rows(s.instanceId), {settings: [], receipts: [], events: []});
});

test('direct commands reject NUL and lone surrogates in every string field while HTTP uses the shared JSON guard', async () => {
  const s = await shop();
  const proof = await fresh(s.owner, s.tenantId);
  const actor = await actorOf(s.owner);
  for (const marker of ['\u0000', '\uD800']) {
    for (const field of STRING_FIELDS) {
      const body = command(proof, bank({[field]: `100${marker}`}));
      const direct = await saveOfflinePaymentSettings(x.runtime, actor, s.tenantId, s.instanceId, body, randomUUID(), undefined, IMPLEMENTED_PROVIDER_PROFILES).then(() => { throw new Error('direct command accepted an unsafe string'); }, problemOf);
      assert.equal(direct.status, 400, field);
      assert.equal(direct.code, 'invalid_command_json');
      assert.equal(direct.message, '操作資料必須是有界的 JSON。');
      const http = await put(s, s.owner, body);
      assert.equal(http.status, 422, JSON.stringify(http.data));
      assert.equal(http.data.code, 'validation_failed');
      assert.equal(http.data.code === 'invalid_command_json', false);
    }
  }
  const schemaNul = command(proof, bank());
  schemaNul.schema = `${SCHEMA}\u0000`;
  const directSchema = await saveOfflinePaymentSettings(x.runtime, actor, s.tenantId, s.instanceId, schemaNul, randomUUID(), undefined, IMPLEMENTED_PROVIDER_PROFILES).then(() => { throw new Error('schema NUL reached the command'); }, problemOf);
  assert.equal(directSchema.status, 422);
  assert.equal(directSchema.code, 'validation_failed');
  const httpSchema = await put(s, s.owner, schemaNul);
  assert.equal(httpSchema.status, 422, JSON.stringify(httpSchema.data));
  assert.equal(httpSchema.data.code, 'validation_failed');
  assert.equal(await verificationOpen(proof), true);
  assert.deepEqual(await rows(s.instanceId), {settings: [], receipts: [], events: []});
});

test('raw controls are rejected on the original string before trim', async () => {
  const s = await shop();
  const proof = await fresh(s.owner, s.tenantId);
  const account = digits(12);
  for (const control of ['\u0001', '\t', '\n', '\u007f', '\u009f']) {
    for (const field of STRING_FIELDS) {
      const raw = field === 'bank_code' ? `${control}004` : field === 'account_number' ? `${control}${account}` : `${control}${syntheticName(4)}`;
      const reply = await put(s, s.owner, command(proof, bank({[field]: raw})));
      assert.equal(reply.status, 422, JSON.stringify(reply.data));
      const error = OfflineSettingsErrorSchema.parse(reply.data);
      assert.equal(error.code, 'offline_settings_invalid');
      assert.ok(pairs(error.fields ?? []).includes(`bank_transfer.${field}:format`), JSON.stringify(error.fields));
      assert.equal(JSON.stringify(reply.data).includes(raw), false);
    }
  }
  const spaces = await put(s, s.owner, command(proof, bank({account_name: '   ', bank_name: ' \n '})));
  assert.equal(spaces.status, 422, JSON.stringify(spaces.data));
  assert.deepEqual(pairs(OfflineSettingsErrorSchema.parse(spaces.data).fields ?? []), ['bank_transfer.account_name:required', 'bank_transfer.bank_name:format']);
  assert.equal(await verificationOpen(proof), true);
  assert.equal((await rows(s.instanceId)).settings.length, 0);
});

test('normalization strips account separators, clears empty optional text, and applies deadline defaults', async () => {
  const s = await shop();
  const proof = await fresh(s.owner, s.tenantId);
  const account = digits(12);
  const bankName = ` ${syntheticName(6)} `;
  const accountName = syntheticName(8);
  const logs: unknown[][] = [];
  const original = {log: console.log, info: console.info, warn: console.warn, error: console.error};
  for (const level of Object.keys(original) as (keyof typeof original)[]) console[level] = (...args: unknown[]) => { logs.push(args); };
  let saved: Reply;
  try {
    saved = await put(s, s.owner, command(proof, {bank_code: ' 004', bank_name: bankName, branch_name: '', account_number: separated(account), account_name: accountName}));
  } finally {
    Object.assign(console, original);
  }
  assert.equal(saved.status, 201, JSON.stringify(saved.data));
  assert.equal(saved.response.headers.get('etag'), '"1"');
  const view = OfflinePaymentSettingsViewSchema.parse(saved.data);
  assert.equal(view.version, '1');
  assert.equal(view.account_visibility, 'full');
  assert.ok(view.settings?.bank_transfer);
  assert.ok(view.settings.cash_on_meetup);
  assert.deepEqual(view.host_profiles, {bank_transfer: true, cash_on_meetup: true});
  assert.equal(view.settings.bank_transfer.bank_code, '004');
  assert.equal(view.settings.bank_transfer.bank_name, bankName.trim());
  assert.equal(view.settings.bank_transfer.branch_name, null);
  assert.equal(view.settings.bank_transfer.account_number, account);
  assert.equal(view.settings.bank_transfer.account_number_last4, account.slice(-4));
  assert.equal(view.settings.bank_transfer.account_name, accountName);
  assert.equal(view.settings.bank_transfer.note, null);
  assert.equal(view.settings.bank_transfer.deadline_days, 3);
  assert.equal(view.settings.cash_on_meetup.deadline_days, 7);
  const stored = await rows(s.instanceId);
  assert.equal(stored.settings.length, 1);
  assert.equal(stored.settings[0].document_sha256, hashJSON(stored.settings[0].document));
  assert.equal(stored.settings[0].document.schema, SCHEMA);
  assert.equal(stored.settings[0].document.bank_transfer.account_number, account);
  assert.equal(JSON.stringify(stored.settings[0].document).includes('fresh_auth'), false);
  assert.deepEqual(stored.receipts.map(row => row.response), [{id: '1'}]);
  assert.deepEqual(stored.events.map(row => row.detail), [{settings_version: 1, methods: 'bank_transfer,cash_on_meetup'}]);
  assert.equal(await verificationOpen(proof), false);
  assertSecretsAbsent(await sinkText({receipts: stored.receipts, events: stored.events, logs}), [account, bankName.trim(), accountName]);
});

test('settings versions stay contiguous and immutable across If-Match and direct SQL', async () => {
  const s = await shop();
  const proof = await fresh(s.owner, s.tenantId);
  const firstBody = command(proof, bank(), {deadline_days: 7});
  const premature = await put(s, s.owner, firstBody, {'If-Match': '"1"'});
  assert.equal(premature.status, 412, JSON.stringify(premature.data));
  assert.equal(premature.data.code, 'version_conflict');
  assert.equal(await verificationOpen(proof), true);
  const created = await put(s, s.owner, firstBody);
  assert.equal(created.status, 201, JSON.stringify(created.data));
  assert.equal(created.data.version, '1');
  const missing = await put(s, s.owner, command(await fresh(s.owner, s.tenantId), bank()));
  assert.equal(missing.status, 428, JSON.stringify(missing.data));
  assert.equal(missing.data.code, 'version_required');
  assert.equal(missing.data.detail, '請提供 If-Match 版本。');
  for (const header of ['1', '"0"', '"01"', '"1 "', 'W/"1"']) {
    const malformed = await put(s, s.owner, command(proof, bank()), {'If-Match': header});
    assert.equal(malformed.status, 400, `${header} ${JSON.stringify(malformed.data)}`);
    assert.equal(malformed.data.code, 'invalid_version');
  }
  const noKey = await x.h.call('PUT', settingsPath(s.tenantId, s.instanceId), s.owner, command(proof, bank()), {}, app);
  assert.equal(noKey.status, 400, JSON.stringify(noKey.data));
  assert.equal(noKey.data.code, 'idempotency_required');
  const secondProof = await fresh(s.owner, s.tenantId);
  const second = await put(s, s.owner, command(secondProof, bank(), null), {'If-Match': '"1"'});
  assert.equal(second.status, 200, JSON.stringify(second.data));
  assert.equal(second.response.headers.get('etag'), '"2"');
  const stale = await put(s, s.owner, command(await fresh(s.owner, s.tenantId), bank()), {'If-Match': '"1"'});
  assert.equal(stale.status, 412, JSON.stringify(stale.data));
  assert.equal(stale.data.code, 'version_conflict');
  assert.equal(stale.data.detail, '資料已更新，請重新整理後再操作。');
  const stored = await rows(s.instanceId);
  assert.deepEqual(stored.settings.map(row => row.version), ['1', '2']);
  for (const row of stored.settings) assert.equal(row.document_sha256, hashJSON(row.document));
  await sqlReject('UPDATE commerce_offline_payment_settings SET document=document WHERE instance_id=$1', [s.instanceId], /append only/);
  await sqlReject('DELETE FROM commerce_offline_payment_settings WHERE instance_id=$1', [s.instanceId], /append only/);
  await sqlReject(`INSERT INTO commerce_offline_payment_settings(tenant_id,instance_id,version,document,document_sha256,created_by_principal_id)
    SELECT tenant_id,instance_id,4,document,document_sha256,created_by_principal_id FROM commerce_offline_payment_settings WHERE instance_id=$1 AND version=1`, [s.instanceId], /contiguous/);
  await sqlReject(`INSERT INTO commerce_offline_payment_settings(tenant_id,instance_id,version,document,document_sha256,created_by_principal_id)
    SELECT tenant_id,instance_id,3,document,'zz',created_by_principal_id FROM commerce_offline_payment_settings WHERE instance_id=$1 AND version=1`, [s.instanceId], /document_sha256|check constraint/);
  assert.deepEqual((await rows(s.instanceId)).settings.map(row => row.version), ['1', '2']);
});

test('fresh verification is required, single use, and replay stays on the same receipt', async () => {
  const s = await shop();
  const missing = await put(s, s.owner, {schema: SCHEMA, bank_transfer: null, cash_on_meetup: null});
  assert.equal(missing.status, 403, JSON.stringify(missing.data));
  assert.equal(missing.data.code, 'fresh_auth_required');
  assert.equal(missing.data.detail, '請重新驗證身分。');
  const wrong = await put(s, s.owner, command(randomUUID(), null, null));
  assert.equal(wrong.status, 403, JSON.stringify(wrong.data));
  assert.equal(wrong.data.code, 'fresh_auth_required');
  assert.equal(wrong.data.detail, '需要重新驗證。');
  const proof = await fresh(s.owner, s.tenantId);
  const body = command(proof, null, null);
  const key = randomUUID();
  const created = await put(s, s.owner, body, {'Idempotency-Key': key});
  assert.equal(created.status, 201, JSON.stringify(created.data));
  assert.deepEqual(created.data.settings, {bank_transfer: null, cash_on_meetup: null});
  assert.equal(await verificationOpen(proof), false);
  const replay = await put(s, s.owner, body, {'Idempotency-Key': key});
  assert.equal(replay.status, 201, JSON.stringify(replay.data));
  assert.equal(replay.data.version, '1');
  assert.deepEqual(replay.data, created.data);
  const conflict = await put(s, s.owner, command(proof, bank()), {'Idempotency-Key': key});
  assert.equal(conflict.status, 409, JSON.stringify(conflict.data));
  assert.equal(conflict.data.code, 'idempotency_conflict');
  const reused = await put(s, s.owner, command(proof, null, {deadline_days: 4}), {'If-Match': '"1"'});
  assert.equal(reused.status, 403, JSON.stringify(reused.data));
  assert.equal(reused.data.code, 'fresh_auth_required');
  const stored = await rows(s.instanceId);
  assert.deepEqual(stored.settings.map(row => row.version), ['1']);
  assert.deepEqual(stored.events.map(row => row.detail), [{settings_version: 1, methods: 'none'}]);
  assert.deepEqual(stored.receipts, [{response: {id: '1'}}]);
  assert.equal(stored.settings[0].document.bank_transfer, null);
  assert.equal(stored.settings[0].document.cash_on_meetup, null);
});

test('owner and admin write, masked roles read last4, and other callers or a closed console do not', async () => {
  const s = await shop();
  const other = await shop();
  const account = digits(12);
  const names = {bank_name: syntheticName(6), branch_name: syntheticName(6), account_name: syntheticName(8), note: syntheticName(8)};
  const created = await put(s, s.owner, command(await fresh(s.owner, s.tenantId), bank({account_number: account, ...names})));
  assert.equal(created.status, 201, JSON.stringify(created.data));
  assert.equal(created.data.account_visibility, 'full');
  assert.equal(created.data.settings.bank_transfer.account_number, account);
  const admin = await grant(s, 'admin', null);
  const adminSaved = await put(s, admin, command(await fresh(admin, s.tenantId), bank({account_number: account, ...names}), {deadline_days: 9}), {'If-Match': '"1"'});
  assert.equal(adminSaved.status, 200, JSON.stringify(adminSaved.data));
  assert.equal(adminSaved.data.version, '2');
  assert.equal(adminSaved.data.account_visibility, 'full');
  assert.equal(adminSaved.data.settings.bank_transfer.account_number, account);
  assert.equal(adminSaved.data.settings.cash_on_meetup.deadline_days, 9);
  const ownerRead = await get(s, s.owner);
  assert.equal(ownerRead.status, 200, JSON.stringify(ownerRead.data));
  assert.equal(ownerRead.data.settings.bank_transfer.account_number, account);
  for (const caps of [['store:read', 'store:manage'], ['store:read', 'store:finance:read']] as const) {
    const reader = await grant(s, 'operator', [...caps]);
    const view = await get(s, reader);
    assert.equal(view.status, 200, JSON.stringify(view.data));
    assert.equal(view.data.account_visibility, 'last4');
    assert.equal(view.data.settings.bank_transfer.account_number, null);
    assert.equal(view.data.settings.bank_transfer.account_number_last4, account.slice(-4));
    assert.equal(view.data.settings.bank_transfer.account_name, names.account_name);
    assert.equal(JSON.stringify(view.data).includes(account), false);
    const denied = await put(s, reader, command(randomUUID(), bank({bank_code: 'no'})), {'If-Match': '"2"'});
    assert.equal(denied.status, 403, JSON.stringify(denied.data));
    assert.equal(denied.data.code, 'capability_denied');
  }
  const readerOnly = await grant(s, 'operator', ['store:read']);
  const unreadable = await get(s, readerOnly);
  assert.equal(unreadable.status, 403, JSON.stringify(unreadable.data));
  assert.equal(unreadable.data.code, 'capability_denied');
  const hiddenManage = await grant(s, 'operator', ['store:manage']);
  const missingRead = await get(s, hiddenManage);
  assert.equal(missingRead.status, 404, JSON.stringify(missingRead.data));
  assert.equal(missingRead.data.code, 'not_found');
  const stranger = (await x.h.person(syntheticName(4))).session;
  for (const [label, session, path] of [
    ['other-instance', s.owner, settingsPath(s.tenantId, other.instanceId)],
    ['other-tenant', s.owner, settingsPath(other.tenantId, s.instanceId)],
    ['stranger', stranger, settingsPath(s.tenantId, s.instanceId)],
  ] as const) {
    const hidden = await x.h.call('GET', path, session, undefined, {}, app);
    assert.equal(hidden.status, 404, `${label} ${JSON.stringify(hidden.data)}`);
    assert.equal(hidden.data.code, 'not_found');
    assert.equal(hidden.data.detail, '找不到這間商店。');
  }
  const liveProof = await fresh(s.owner, s.tenantId);
  const liveBody = command(liveProof, bank({account_number: account, ...names}));
  await x.h.pool.query("UPDATE deployment_bindings SET state='suspended' WHERE instance_id=$1 AND state='active'", [s.instanceId]);
  const deployment = await put(s, s.owner, liveBody, {'If-Match': '"2"'});
  assert.equal(deployment.status, 409, JSON.stringify(deployment.data));
  assert.equal(deployment.data.code, 'storefront_unavailable');
  await x.h.pool.query("UPDATE deployment_bindings SET state='active' WHERE instance_id=$1 AND state='suspended'", [s.instanceId]);
  await x.h.pool.query("UPDATE module_instances SET status='suspended' WHERE instance_id=$1", [s.instanceId]);
  const instance = await put(s, s.owner, liveBody, {'If-Match': '"2"'});
  assert.equal(instance.status, 409, JSON.stringify(instance.data));
  assert.equal(instance.data.code, 'storefront_unavailable');
  await x.h.pool.query("UPDATE module_instances SET status='active' WHERE instance_id=$1", [s.instanceId]);
  await x.h.pool.query("UPDATE tenants SET status='suspended' WHERE tenant_id=$1", [s.tenantId]);
  const tenant = await put(s, s.owner, liveBody, {'If-Match': '"2"'});
  assert.equal(tenant.status, 403, JSON.stringify(tenant.data));
  assert.equal(tenant.data.code, 'capability_denied');
  await x.h.pool.query("UPDATE tenants SET status='active' WHERE tenant_id=$1", [s.tenantId]);
  assert.equal(await verificationOpen(liveProof), true);
  assert.deepEqual((await rows(s.instanceId)).settings.map(row => row.version), ['1', '2']);
  const resumed = await put(s, s.owner, liveBody, {'If-Match': '"2"'});
  assert.equal(resumed.status, 200, JSON.stringify(resumed.data));
  assert.equal(resumed.data.version, '3');
  for (const method of ['GET', 'PUT'] as const) {
    const absent = await x.h.call(method, settingsPath(s.tenantId, s.instanceId), s.owner, method === 'PUT' ? liveBody : undefined, method === 'PUT' ? {'Idempotency-Key': randomUUID(), 'If-Match': '"3"'} : {}, closed);
    assert.equal(absent.status, 404, JSON.stringify(absent.data));
    assert.equal(absent.data.code, 'not_found');
    assert.equal(absent.data.detail, '此版本尚未提供這個 API。');
  }
});

test('control events name only the version and method list, and sinks keep no account material', async () => {
  const s = await shop();
  const samples = [
    {bankTransfer: null, meetup: null, methods: 'none'},
    {bankTransfer: bank(), meetup: null, methods: 'bank_transfer'},
    {bankTransfer: null, meetup: {deadline_days: 11}, methods: 'cash_on_meetup'},
    {bankTransfer: bank(), meetup: {}, methods: 'bank_transfer,cash_on_meetup'},
  ];
  const secrets: string[] = [];
  const logs: unknown[][] = [];
  const original = {log: console.log, info: console.info, warn: console.warn, error: console.error};
  for (const level of Object.keys(original) as (keyof typeof original)[]) console[level] = (...args: unknown[]) => { logs.push(args); };
  try {
    for (const [index, sample] of samples.entries()) {
      if (sample.bankTransfer && typeof sample.bankTransfer === 'object') {
        const block = sample.bankTransfer as {account_number: string; bank_name: string; branch_name: string; account_name: string; note: string};
        secrets.push(block.account_number, block.bank_name, block.branch_name, block.account_name, block.note);
      }
      const reply = await put(s, s.owner, command(await fresh(s.owner, s.tenantId), sample.bankTransfer, sample.meetup), index === 0 ? {} : {'If-Match': `"${index}"`});
      assert.equal(reply.status, index === 0 ? 201 : 200, JSON.stringify(reply.data));
      assert.equal(reply.data.version, String(index + 1));
    }
  } finally {
    Object.assign(console, original);
  }
  const stored = await rows(s.instanceId);
  assert.deepEqual(stored.events.map(row => row.detail), samples.map((sample, index) => ({settings_version: index + 1, methods: sample.methods})));
  for (const event of stored.events) assert.deepEqual(Object.keys(event.detail).sort(), ['methods', 'settings_version']);
  assert.deepEqual(stored.receipts.map(row => row.response).sort((a, b) => a.id!.localeCompare(b.id!)), samples.map((_, index) => ({id: String(index + 1)})));
  for (const row of stored.settings) assert.equal(row.document_sha256, hashJSON(row.document));
  const tooLongAccount = digits(17);
  const tooLongName = '南'.repeat(41);
  const problems = await put(s, s.owner, command(await fresh(s.owner, s.tenantId), bank({account_number: tooLongAccount, account_name: tooLongName}), {deadline_days: 4}), {'If-Match': '"4"'});
  assert.equal(problems.status, 422, JSON.stringify(problems.data));
  assertSecretsAbsent(await sinkText({receipts: stored.receipts, events: stored.events, logs, problem: problems.data}), [...secrets, tooLongAccount, tooLongName]);
});
