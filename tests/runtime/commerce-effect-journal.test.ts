import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { readCommerceSettings, readNodeCommerceSettings } from '../../modules/agent-commerce/operations/runtime-settings.js';
import { readWorkerConfig, workerRuntime, createWorkerHandler, type WorkerEnv } from '../../apps/platform-api/src/worker.js';
import { ReadinessError } from '../../apps/platform-api/src/readiness.js';
import { encodeEffectRecord, flushControlEvents, flushControlEventsBestEffort, type EffectRecord } from '../../modules/agent-commerce/operations/journal/journal.js';
import { createR2EffectJournal, type CommerceJournalBucket } from '../../modules/agent-commerce/operations/journal/r2.js';
import { MemoryEffectJournal } from '../../modules/agent-commerce/operations/journal/memory.js';
import { recordControlEvent } from '../../modules/agent-commerce/operations/control-events.js';
import { checkoutHarness } from './hosted-checkout-harness.js';
import { newTradeNumber } from '../../modules/agent-commerce/providers/ecpay/index.js';
import { createApp } from '../../apps/platform-api/src/app.js';
import { CommerceCredentialKeyring } from '../../modules/agent-commerce/payments/credentials.js';
import { DEMO_COMMUNITY, DEMO_PASSWORD } from '../../packages/testing/seed.js';
import { ok } from './hosted-checkout-harness.js';
const profile = 'ecpay.aio.credit.v1';
const workerBindings = (): WorkerEnv => ({ FREEDOM_ENV: 'local', APP_ORIGIN: 'http://127.0.0.1:4310', HYPERDRIVE: { connectionString: 'postgres://unused' }, ASSETS: { fetch: async () => new Response() } });
const randomRing = () => `test:${randomBytes(32).toString('base64')}`;
for (const value of [undefined, ''])
  test(`empty provider profiles (${String(value)}) leave payment ports uninstalled`, () => {
    assert.deepEqual(readCommerceSettings({ FREEDOM_COMMERCE_PROVIDER_PROFILES: value }).providerProfiles, []);
    assert.deepEqual(readNodeCommerceSettings({ FREEDOM_COMMERCE_PROVIDER_PROFILES: value }).providerProfiles, []);
    assert.deepEqual(readWorkerConfig({ ...workerBindings(), FREEDOM_COMMERCE_PROVIDER_PROFILES: value }).commerceSettings?.providerProfiles, []);
  });
for (const raw of [' ', `,${profile}`, `${profile},`, `${profile},${profile}`, `${profile},,${profile}`, ` ${profile}`, `${profile}\n`, `${profile},other`, 'other', profile.toUpperCase()])
  test(`provider profiles reject malformed or unimplemented list ${JSON.stringify(raw)}`, () => {
    for (const read of [() => readCommerceSettings({ FREEDOM_COMMERCE_PROVIDER_PROFILES: raw }), () => readNodeCommerceSettings({ FREEDOM_COMMERCE_PROVIDER_PROFILES: raw }), () => readWorkerConfig({ ...workerBindings(), FREEDOM_COMMERCE_PROVIDER_PROFILES: raw })])
      assert.throws(read, (e: unknown) => e instanceof ReadinessError && e.message === 'commerce_provider_profiles_invalid');
  });
test('Worker provider profiles require a usable keyring and journal methods; neither is used during readiness', () => {
  for (const keyring of [undefined, '', 'synthetic-invalid'])
    assert.throws(() => readWorkerConfig({ ...workerBindings(), FREEDOM_COMMERCE_PROVIDER_PROFILES: profile, COMMERCE_CREDENTIAL_KEYS: keyring }), { name: 'ReadinessError', message: 'commerce_profiles_require_keyring' });
  const env = { ...workerBindings(), FREEDOM_COMMERCE_PROVIDER_PROFILES: profile, COMMERCE_CREDENTIAL_KEYS: randomRing() };
  assert.throws(() => readWorkerConfig(env), { name: 'ReadinessError', message: 'commerce_profiles_require_journal' });
  for (const binding of [{}, { get() { } }, { put() { } }])
    assert.throws(() => readWorkerConfig({ ...env, COMMERCE_JOURNAL: binding } as unknown as WorkerEnv), { name: 'ReadinessError', message: 'commerce_profiles_require_journal' });
  const COMMERCE_JOURNAL = { put() { throw Error('unexpected I/O'); }, get() { throw Error('unexpected I/O'); } };
  assert.deepEqual(readWorkerConfig({ ...env, COMMERCE_JOURNAL }).commerceSettings?.providerProfiles, [profile]);
});
test('Node startup settings refuse every non-empty implemented provider list without a journal', () => {
  assert.throws(() => readNodeCommerceSettings({ FREEDOM_COMMERCE_PROVIDER_PROFILES: profile }), { name: 'ReadinessError', message: 'commerce_profiles_require_journal' });
  const parsed = readCommerceSettings({ FREEDOM_COMMERCE_PROVIDER_PROFILES: profile });
  assert.deepEqual(parsed.providerProfiles, [profile]);
  assert(Object.isFrozen(parsed.providerProfiles));
});
test('an offline-only Worker installs payment methods without a gateway, keyring or journal', async () => {
  const offline = 'offline.bank_transfer.v1,offline.cash_on_meetup.v1';
  const ready = { ...workerBindings(), FREEDOM_COMMERCE_PROVIDER_PROFILES: offline };
  const config = readWorkerConfig(ready), runtime = workerRuntime(ready, config);
  assert.equal(config.commerceCredentialKeyring, null);
  assert.equal(runtime.commercePayments, undefined);
  assert.equal(runtime.commerceJournal, undefined);
  assert.equal(runtime.commercePorts?.payment, undefined);
  assert.equal(typeof runtime.commercePorts?.paymentMethods?.resolve, 'function');
  let flushed = false;
  const handler = createWorkerHandler({
    createPool: () => ({ query: async () => { throw Error('offline readiness must not query'); }, connect: async () => { throw Error('offline readiness must not connect'); }, end: async () => {} }) as never,
    commerceApplyDeferred: async () => ({ applied: 0, failed: 0, skipped: 0 }),
    commerceSweep: async () => 0,
    commerceDueWork: async () => ({ claimed: 0, completed: 0, failed: 0, externalCalls: 0, released: 0, unknown: 0 }),
    commerceEmailSweep: async () => ({ expired: 0, deleted: 0 }),
    commerceFlushJournal: async () => { flushed = true; return { written: 0, failed: 0 }; },
    syncGitHub: async () => ({ requests: 0, repositories: 0, items_upserted: 0, not_modified: 0, stop_reason: 'completed' }),
    authPrune: async () => ({ sessions: 0, login_attempts: 0, auth_rate_limits: 0, password_reset_tokens: 0 }),
  });
  const pending: Promise<unknown>[] = [];
  await handler.scheduled({}, ready, { waitUntil: p => pending.push(p) });
  await Promise.all(pending);
  assert.equal(flushed, false);
});
test('Worker installs a production gateway and R2 journal only with listed profiles', () => {
  const binding = { put() { throw Error('unexpected I/O'); }, get() { throw Error('unexpected I/O'); } };
  const empty = { ...workerBindings(), COMMERCE_JOURNAL: binding };
  assert.equal(workerRuntime(empty, readWorkerConfig(empty)).commercePayments, undefined);
  for (const freedomEnv of ['staging', 'public'] as const) {
    const env = { ...workerBindings(), FREEDOM_ENV: freedomEnv, APP_ORIGIN: 'https://payments.freedom.test', FREEDOM_RELEASE_SHA: 'a'.repeat(40), FREEDOM_COMMERCE_PROVIDER_PROFILES: profile, COMMERCE_CREDENTIAL_KEYS: randomRing(), COMMERCE_JOURNAL: binding };
    const config = readWorkerConfig(env), runtime = workerRuntime(env, config);
    assert.deepEqual(runtime.commercePayments?.profiles, [profile]);
    assert.equal(runtime.commercePayments?.journal.environment, freedomEnv);
    assert.equal(runtime.commercePayments?.gateway?.publicBaseUrl, env.APP_ORIGIN);
    assert.equal(runtime.commercePayments?.gateway?.environment, config.commerceProviderEnvironment);
  }
});
const record = (): EffectRecord => ({ environment: 'local', kind: 'payment_handoff', id: randomUUID(), occurred_at: '2026-01-02T23:59:59.001Z', tenant_id: randomUUID(), instance_id: randomUUID(), detail: { merchant_trade_no: newTradeNumber('F'), currency: 'TWD', amount_minor: 500 } });
function bucket() {
  const objects = new Map<string, Uint8Array>(), writes: unknown[] = [];
  const binding = {
    async put(key: string, body: string, options: unknown) {
      writes.push(options);
      assert.deepEqual(options, { onlyIf: { etagDoesNotMatch: '*' }, httpMetadata: { contentType: 'application/json' } });
      if (objects.has(key))
        return null;
      objects.set(key, new TextEncoder().encode(body));
      return {};
    }, async get(key: string) { const body = objects.get(key); return body ? { arrayBuffer: async () => Uint8Array.from(body).buffer } : null; }
  } as unknown as CommerceJournalBucket;
  return { objects, writes, binding };
}
test('journal UTC key and canonical JSON contain only the declared record and detail fields', () => {
  const r = record(), encoded = encodeEffectRecord(r, 'local');
  assert.equal(encoded.key, `local/2026/01/02/payment_handoff/${r.id}`);
  assert.equal(encoded.body, JSON.stringify({ detail: { amount_minor: 500, currency: 'TWD', merchant_trade_no: r.detail.merchant_trade_no }, environment: 'local', id: r.id, instance_id: r.instance_id, kind: r.kind, occurred_at: r.occurred_at, tenant_id: r.tenant_id }));
  assert.deepEqual(encodeEffectRecord({ ...r, detail: { amount_minor: 500, merchant_trade_no: r.detail.merchant_trade_no, currency: 'TWD' } }, 'local'), encoded);
});
test('offline settings control journals retain only a positive version and canonical method names', () => {
  const base = {...record(), kind: 'control.offline_payment_settings.changed'};
  for (const methods of ['none', 'bank_transfer', 'cash_on_meetup', 'bank_transfer,cash_on_meetup']) {
    const detail = {settings_version: 2, methods};
    const encoded = encodeEffectRecord({...base, detail} as unknown as EffectRecord, 'local');
    assert.deepEqual(JSON.parse(encoded.body).detail, detail);
  }
  for (const detail of [
    {settings_version: 0}, {settings_version: '2'}, {settings_version: 1.5},
    {methods: 'cash_on_meetup,bank_transfer'}, {methods: 'bank_transfer,bank_transfer'},
    {methods: 'synthetic-private'}, {methods: ''}, {methods: ['bank_transfer']}, {account_number: '123456789012'},
  ]) assert.throws(() => encodeEffectRecord({...base, detail} as unknown as EffectRecord, 'local'), {message: 'journal_unavailable'});
});
test('journal rejects unknown fields, non-UTC timestamps, invalid identity and environment without exposing input', () => {
  const r = record();
  for (const change of [{ secret: 'synthetic-private' }, { detail: { card4no: '9876' } }, { detail: { amount_minor: 1.5 } }, { detail: { credential_version: 0 } }, { detail: { order_id: 'invalid' } }, { kind: '../escape' }, { id: '../escape' }, { environment: 'staging' }, { occurred_at: '2026-01-03T07:59:59.001+08:00' }, { occurred_at: 'invalid' }, { instance_id: 'invalid' }])
    assert.throws(() => encodeEffectRecord({ ...r, ...change } as EffectRecord, 'local'), { message: 'journal_unavailable' });
});
test('R2 conditionally creates, accepts identical bytes and rejects a conflicting retry', async () => {
  const b = bucket(), journal = createR2EffectJournal('local', b.binding), r = record();
  await journal.append(r);
  await journal.append(r);
  assert.equal(b.objects.size, 1);
  assert.equal(b.writes.length, 2);
  await assert.rejects(() => journal.append({ ...r, detail: { ...r.detail, amount_minor: 600 } }), { message: 'journal_conflict' });
  assert.equal(new TextDecoder().decode([...b.objects.values()][0]), encodeEffectRecord(r, 'local').body);
});
test('R2 compares raw bytes instead of parsed JSON', async () => {
  const b = bucket(), r = record(), { key, body } = encodeEffectRecord(r, 'local');
  b.objects.set(key, new TextEncoder().encode(body + '\n'));
  await assert.rejects(() => createR2EffectJournal('local', b.binding).append(r), { message: 'journal_conflict' });
});
test('R2 storage failures and a missing conditional-conflict object become a fixed unavailable error', async () => {
  for (const binding of [
    { put: async () => { throw Error('synthetic-private'); }, get: async () => null },
    { put: async () => null, get: async () => { throw Error('synthetic-private'); } },
    { put: async () => null, get: async () => null },
    { put: async () => null, get: async () => ({ arrayBuffer: async () => { throw Error('synthetic-private'); } }) },
  ])
    await assert.rejects(() => createR2EffectJournal('local', binding as unknown as CommerceJournalBucket).append(record()), { message: 'journal_unavailable' });
});
test('memory journal has the same retry, conflict, canonical bytes and namespace semantics', async () => {
  const journal = new MemoryEffectJournal('local'), r = record();
  await journal.append(r);
  await journal.append(r);
  assert.deepEqual([...journal.objects], [[encodeEffectRecord(r, 'local').key, encodeEffectRecord(r, 'local').body]]);
  await assert.rejects(() => journal.append({ ...r, detail: { ...r.detail, amount_minor: 600 } }), { message: 'journal_conflict' });
  await assert.rejects(() => journal.append({ ...r, environment: 'public' }), { message: 'journal_unavailable' });
  (journal.objects as Map<string, string>).clear();
  assert.equal(journal.objects.size, 1, 'inspection returns a copy');
});
test('control events append only after commit and journaled_at is filled only after success', async (t) => {
  const x = await checkoutHarness('fp_effect_journal');
  try {
    await x.reset();
    const s = await x.store(), journal = new MemoryEffectJournal('local');
    const event = async () => {
      const subjectId = randomUUID();
      await x.tx(q => recordControlEvent(q, { tenantId: s.tenantId, instanceId: s.instanceId, kind: 'provider_service.created', subjectId, detail: { purpose: 'payment', profile, environment: 'sandbox', credential_version: 1 }, actorKind: 'system', actorId: subjectId }));
      return (await x.h.pool.query('SELECT * FROM commerce_control_events WHERE subject_id=$1', [subjectId])).rows[0];
    };
    await t.test('append success precedes marking and a repeated flush does not append again', async () => {
      const e = await event();
      let appendCount = 0;
      const observing = {
        environment: 'local' as const, async append(r: EffectRecord) {
          appendCount++;
          assert.equal((await x.h.pool.query('SELECT journaled_at FROM commerce_control_events WHERE event_id=$1', [e.event_id])).rows[0].journaled_at, null);
          await journal.append(r);
        }
      };
      assert.deepEqual(await flushControlEvents(x.runtime, observing, { eventIds: [e.event_id], limit: 200 }), { written: 1, failed: 0 });
      const marked = (await x.h.pool.query('SELECT journaled_at FROM commerce_control_events WHERE event_id=$1', [e.event_id])).rows[0].journaled_at;
      assert(marked instanceof Date);
      assert.deepEqual(await flushControlEvents(x.runtime, observing, { eventIds: [e.event_id], limit: 200 }), { written: 0, failed: 0 });
      assert.equal(appendCount, 1);
      const [key, body] = [...journal.objects].find(([key]) => key.endsWith('/' + e.event_id))!;
      assert(key.includes('/control.provider_service.created/'));
      assert.deepEqual(JSON.parse(body), { environment: 'local', kind: 'control.provider_service.created', id: e.event_id, occurred_at: e.occurred_at.toISOString(), tenant_id: s.tenantId, instance_id: s.instanceId, detail: { purpose: 'payment', profile, credential_version: 1 } });
    });
    await t.test('failure leaves the event eligible for a later backfill', async () => {
      const e = await event(), broken = { environment: 'local' as const, append: async () => { throw Error('synthetic-private'); } };
      assert.deepEqual(await flushControlEvents(x.runtime, broken, { eventIds: [e.event_id], limit: 200 }), { written: 0, failed: 1 });
      assert.equal((await x.h.pool.query('SELECT journaled_at FROM commerce_control_events WHERE event_id=$1', [e.event_id])).rows[0].journaled_at, null);
      assert.deepEqual(await flushControlEvents(x.runtime, journal, { limit: 200 }), { written: 1, failed: 0 });
    });
    await t.test('concurrent backfills produce one immutable object and mark the row once', async () => {
      const e = await event(), before = journal.objects.size;
      const counts = await Promise.all([flushControlEvents(x.runtime, journal, { eventIds: [e.event_id], limit: 1 }), flushControlEvents(x.runtime, journal, { eventIds: [e.event_id], limit: 1 })]);
      assert.equal(counts.reduce((a, b) => a + b.written, 0), 1);
      assert.equal(journal.objects.size, before + 1);
    });
    await t.test('best effort logs only a fixed name, event id and reason without propagating adapter failure', async () => {
      const e = await event();
      const logs: unknown[][] = [], original = console.error;
      console.error = (...args) => { logs.push(args); };
      try {
        await flushControlEventsBestEffort(x.runtime, { environment: 'local', append: async () => { throw Error('synthetic-private'); } });
        assert.deepEqual(logs, [['commerce_control_journal_row_failed', e.event_id, 'journal_unavailable']]);
      }
      finally {
        console.error = original;
      }
    });
    await t.test('provider-account and admission routes flush after commit; journal failure preserves the account response', async () => {
      await x.h.pool.query(`INSERT INTO tenant_authority_policies(revision,status,fresh_auth_ttl_seconds,transfer_ttl_seconds,recovery_approval_ttl_seconds,max_open_recovery_cases_per_tenant) VALUES(1,'active',600,86400,86400,1)`);
      const csrf = randomUUID(), adminEmail = `admin-${randomUUID()}@example.test`;
      const options = { guildLaunchpadEnabled: true, commerceCredentialKeyring: CommerceCredentialKeyring.parse(randomRing())!, commercePayments: { journal, profiles: [] }, adminVerifier: async () => ({ email: adminEmail, subject: 'synthetic-journal-admin', csrfToken: csrf }) };
      const app = createApp(x.runtime, x.h.origin, 'local', options);
      const call = (path: string, body: unknown, version?: string, target = app) => x.h.call('POST', path, s.owner, body, { 'Idempotency-Key': randomUUID(), ...(version ? { 'If-Match': `"${version}"` } : {}) }, target);
      const version = (await x.h.pool.query('SELECT version::text FROM module_instances WHERE instance_id=$1', [s.instanceId])).rows[0].version;
      ok(await call(s.root + '/upgrade', {}, version));
      const fresh = async () => ok(await call('/me/high-risk-verifications', { tenant_id: s.tenantId, purpose: 'commerce.provider_account.write', password: DEMO_PASSWORD }), 201).verification_id;
      const account = ok(await call(s.root + '/provider-accounts', { provider: 'ecpay', environment: 'sandbox', merchant_id: '1234567', fresh_auth_verification_id: await fresh() }), 201);
      const accountEvent = (await x.h.pool.query("SELECT * FROM commerce_control_events WHERE subject_id=$1 AND kind='provider_account.created'", [account.account_id])).rows[0];
      assert(accountEvent.journaled_at instanceof Date);
      assert([...journal.objects.keys()].some(key => key.endsWith('/' + accountEvent.event_id)));
      const broken = createApp(x.runtime, x.h.origin, 'local', { ...options, commercePayments: { profiles: [], journal: { environment: 'local', append: async () => { throw Error('synthetic-private'); } } } });
      const logs: unknown[][] = [], original = console.error;
      console.error = (...args) => logs.push(args);
      let retained;
      try {
        retained = ok(await call(s.root + '/provider-accounts', { provider: 'ecpay', environment: 'sandbox', merchant_id: '1234568', fresh_auth_verification_id: await fresh() }, undefined, broken), 201);
        const id = (await x.h.pool.query('SELECT event_id FROM commerce_control_events WHERE subject_id=$1', [retained.account_id])).rows[0].event_id;
        assert.deepEqual(logs, [['commerce_control_journal_row_failed', id, 'journal_unavailable']]);
      }
      finally {
        console.error = original;
      }
      assert.equal((await x.h.pool.query('SELECT journaled_at FROM commerce_control_events WHERE subject_id=$1', [retained.account_id])).rows[0].journaled_at, null);
      await x.h.pool.query('INSERT INTO platform_admins(admin_id,community_id,email,display_name) VALUES($1,$2,$3,$4)', [randomUUID(), DEMO_COMMUNITY, adminEmail, '合成日誌管理員']);
      const admitted = await app.request(x.h.origin + '/admin/api/commerce/store-admissions', { method: 'POST', headers: { Origin: x.h.origin, 'X-Admin-CSRF': csrf, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, body: JSON.stringify({ tenant_id: s.tenantId, instance_id: s.instanceId, reason: '合成日誌驗證' }) });
      assert.equal(admitted.status, 201, await admitted.text());
      assert([...journal.objects.keys()].some(key => key.includes('/control.store_admission.admitted/')));
      assert.equal((await x.h.pool.query('SELECT count(*)::int n FROM commerce_control_events WHERE journaled_at IS NULL')).rows[0].n, 0, 'the next successful post-commit flush also backfills retained events');
    });
  }
  finally {
    await x.stop();
  }
});
test('the scheduled commerce block backfills retained control events into its R2 journal', async () => {
  const x = await checkoutHarness('fp_effect_scheduler');
  try {
    await x.reset();
    const s = await x.store(), subjectId = randomUUID(), b = bucket();
    await x.tx(q => recordControlEvent(q, { tenantId: s.tenantId, instanceId: s.instanceId, kind: 'provider_account.created', subjectId, detail: { environment: 'sandbox' }, actorKind: 'system', actorId: subjectId }));
    const id = (await x.h.pool.query('SELECT event_id FROM commerce_control_events WHERE subject_id=$1', [subjectId])).rows[0].event_id;
    const pool = { query: x.runtime.query.bind(x.runtime), connect: x.runtime.connect.bind(x.runtime), end: async () => { } } as unknown as import('pg').Pool;
    const handler = createWorkerHandler({ createPool: () => pool, syncGitHub: async () => ({ requests: 0, repositories: 0, items_upserted: 0, not_modified: 0, stop_reason: 'completed' }), authPrune: async () => ({ sessions: 0, login_attempts: 0, auth_rate_limits: 0, password_reset_tokens: 0 }) });
    const pending: Promise<unknown>[] = [], env = { ...workerBindings(), FREEDOM_COMMERCE_PROVIDER_PROFILES: profile, COMMERCE_CREDENTIAL_KEYS: randomRing(), COMMERCE_JOURNAL: b.binding };
    await handler.scheduled({}, env, { waitUntil: p => pending.push(p) });
    await Promise.all(pending);
    assert((await x.h.pool.query('SELECT journaled_at FROM commerce_control_events WHERE event_id=$1', [id])).rows[0].journaled_at instanceof Date);
    assert.equal(b.objects.size, 1);
    assert([...b.objects.keys()][0].endsWith('/control.provider_account.created/' + id));
  }
  finally {
    await x.stop();
  }
});

test('an email journal backfills offline settings with offline or disabled provider profiles', async t => {
  const x = await checkoutHarness('fp_effect_offline_email');
  try {
    for (const profiles of ['offline.bank_transfer.v1,offline.cash_on_meetup.v1', '']) await t.test(profiles || 'profiles disabled', async () => {
      await x.reset();
      const s = await x.store(), b = bucket(), detail = {settings_version: 1, methods: 'bank_transfer,cash_on_meetup'};
      await x.tx(q => recordControlEvent(q, {tenantId: s.tenantId, instanceId: s.instanceId,
        kind: 'offline_payment_settings.changed', subjectId: s.instanceId, detail, actorKind: 'system', actorId: s.instanceId}));
      const event = (await x.h.pool.query('SELECT event_id FROM commerce_control_events WHERE subject_id=$1', [s.instanceId])).rows[0];
      const pool = {query: x.runtime.query.bind(x.runtime), connect: x.runtime.connect.bind(x.runtime), end: async () => {}} as unknown as import('pg').Pool;
      const handler = createWorkerHandler({createPool: () => pool,
        syncGitHub: async () => ({requests: 0, repositories: 0, items_upserted: 0, not_modified: 0, stop_reason: 'completed'}),
        authPrune: async () => ({sessions: 0, login_attempts: 0, auth_rate_limits: 0, password_reset_tokens: 0})});
      const env = {...workerBindings(), FREEDOM_COMMERCE_PROVIDER_PROFILES: profiles,
        FREEDOM_COMMERCE_EMAIL_ENABLED: 'true', COMMERCE_JOURNAL: b.binding,
        EMAIL: {send: async () => {throw Error('no email is queued by this test');}}};
      const runtime = workerRuntime(env, readWorkerConfig(env));
      assert.equal(runtime.commerceCredentialKeyring, null);
      assert.equal(runtime.commercePayments, undefined);
      assert(runtime.commerceJournal);
      const tick = async () => {
        const pending: Promise<unknown>[] = [];
        await handler.scheduled({}, env, {waitUntil: p => pending.push(p)});
        await Promise.all(pending);
      };
      await tick();
      assert((await x.h.pool.query('SELECT journaled_at FROM commerce_control_events WHERE event_id=$1', [event.event_id])).rows[0].journaled_at instanceof Date);
      assert.equal(b.objects.size, 1);
      const [key, bytes] = [...b.objects][0];
      assert(key.endsWith('/control.offline_payment_settings.changed/' + event.event_id));
      assert.deepEqual(JSON.parse(new TextDecoder().decode(bytes)).detail, detail);
      await tick();
      assert.equal(b.writes.length, 1, 'a later tick must not copy the same event again');
    });
  } finally {await x.stop();}
});


test('review 9: a poison control event does not block the next journal row', async () => {
  const x = await checkoutHarness('fp_effect_poison');
  try {
    await x.reset();
    const s = await x.store(), journal = new MemoryEffectJournal('local');
    for (let i = 0; i < 2; i++)
      await x.tx(q => recordControlEvent(q, { tenantId: s.tenantId, instanceId: s.instanceId, kind: 'provider_account.created', subjectId: randomUUID(), detail: { environment: 'sandbox' }, actorKind: 'system', actorId: randomUUID() }));
    const rows = (await x.h.pool.query('SELECT event_id FROM commerce_control_events ORDER BY occurred_at,event_id')).rows;
    const logs: unknown[][] = [], original = console.error;
    console.error = (...args: unknown[]) => { logs.push(args); };
    try {
      const result = await flushControlEvents(x.runtime, { environment: 'local', append: async r => {
        if (r.id === rows[0].event_id) throw Error('journal_conflict');
        await journal.append(r);
      } }, { limit: 200 });
      assert.deepEqual(result, { written: 1, failed: 1 });
      assert.deepEqual(logs, [['commerce_control_journal_row_failed', rows[0].event_id, 'journal_conflict']]);
      const retained = (await x.h.pool.query('SELECT event_id,journaled_at FROM commerce_control_events ORDER BY occurred_at,event_id')).rows;
      assert.equal(retained[0].journaled_at, null);
      assert(retained[1].journaled_at);
      assert.equal(journal.objects.size, 1);
    } finally { console.error = original; }
  } finally { await x.stop(); }
});

test('email_send journal records encode order_id and template purpose without personal data', () => {
  const id = randomUUID(), tenantId = randomUUID(), instanceId = randomUUID(), orderId = randomUUID();
  for (const purpose of ['order_confirmed', 'paid_unallocatable', 'order_access'] as const) {
    const r: EffectRecord = {
      environment: 'local',
      kind: 'email_send',
      id,
      occurred_at: '2026-10-16T08:00:00.000Z',
      tenant_id: tenantId,
      instance_id: instanceId,
      detail: { order_id: orderId, purpose },
    };
    const encoded = encodeEffectRecord(r, 'local');
    assert.equal(encoded.key, `local/2026/10/16/email_send/${id}`);
    assert.deepEqual(JSON.parse(encoded.body), {
      detail: { order_id: orderId, purpose },
      environment: 'local',
      id,
      instance_id: instanceId,
      kind: 'email_send',
      occurred_at: '2026-10-16T08:00:00.000Z',
      tenant_id: tenantId,
    });
  }
  assert.throws(
    () =>
      encodeEffectRecord(
        {
          environment: 'local',
          kind: 'email_send',
          id,
          occurred_at: '2026-10-16T08:00:00.000Z',
          tenant_id: tenantId,
          instance_id: instanceId,
          detail: { order_id: orderId, purpose: 'order_confirmed', to: 'buyer@example.test' } as any,
        },
        'local',
      ),
    { message: 'journal_unavailable' },
  );
});
