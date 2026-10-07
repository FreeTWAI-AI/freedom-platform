import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Client, Pool, type PoolClient } from 'pg';
import { migrate } from '../../scripts/database.js';
import { seedLocal, DEMO_COMMUNITY } from '../../packages/testing/seed.js';
import { CEILINGS, operationPolicyId, policyLockKey, runTenantPolicy } from '../../scripts/tenant-policy.js';
import { lockCapacityPolicy, readCapacityPolicy } from '../../modules/opportunity-project-work/tenant-capacity.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('tenant-policy-operator tests require an explicit TEST_DATABASE_URL for a private test database.');
const testUrl = new URL(databaseUrl);
if (!testUrl.hostname || testUrl.hostname.includes('%') || !testUrl.port || Number(testUrl.port) < 1
  || !decodeURIComponent(testUrl.username) || !decodeURIComponent(testUrl.pathname.slice(1)) || testUrl.searchParams.has('host')) {
  throw new Error('tenant-policy-operator TEST_DATABASE_URL must explicitly name user, host, port and database, without a socket host or host query parameter.');
}
const expectedDatabase = new URL(databaseUrl).pathname.slice(1);
const refusalUrl = 'postgresql://x@192.0.2.1:5432/fp_refusal?sslmode=verify-full';
const wrongDatabase = 'fp_tpo_not_this_database';
const schema = `fp_tpo_${process.pid}_${Date.now()}`;
const admin = new Pool({ connectionString: databaseUrl });
const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 8 });
const toolUrl = new URL(databaseUrl);
toolUrl.searchParams.set('options', `-c search_path=${schema}`);
const defaults = {
  plan_ref: 'operator-test', max_active_instances: '10', max_instances_per_module: '3',
  max_concurrent_provisions: '2', max_work_items: '1000', max_retained_bytes: '104857600',
  max_concurrent_jobs: '2', max_model_budget: '0',
};
const flagFor = (key: string) => `--${key.replaceAll('_', '-')}`;
function args(command: 'plan' | 'apply', changes: Record<string, string> = {}, extra: string[] = []) {
  const executionFlags = command === 'apply' && extra.includes('--execute') ? { expect_revision: 'none', operation_id: randomUUID() } : {};
  return [command, '--database-url', toolUrl.href, '--expect-database', expectedDatabase,
    ...Object.entries({ ...defaults, ...executionFlags, ...changes }).flatMap(([key, value]) => [flagFor(key), value]), ...extra];
}
const run = (argv: string[]) => runTenantPolicy(argv, {});
function beforeConnecting(argv: string[]) {
  const result = [...argv];
  const index = result.indexOf('--database-url') + 1;
  if (index > 0 && result[index] !== undefined && !result[index].startsWith('--')) result[index] = refusalUrl;
  return result;
}
function expectDatabase(argv: string[], expected: string) {
  const result = [...argv];
  result[result.indexOf('--expect-database') + 1] = expected;
  return result;
}
function mismatch(result: Awaited<ReturnType<typeof runTenantPolicy>>, expected = wrongDatabase) {
  assert.notEqual(expected, expectedDatabase);
  assert.deepEqual(result, { exitCode: 2, report: {
    format: 'freedom.tenant-capacity-policy/v1', status: 'refused', code: 'database_mismatch',
    expected, connected: expectedDatabase,
  } });
}
function refused(result: Awaited<ReturnType<typeof runTenantPolicy>>, code: string, flag?: string) {
  assert.equal(result.exitCode, 2);
  assert.ok('status' in result.report);
  assert.equal(result.report.status, 'refused');
  assert.equal(result.report.code, code);
  if (flag) { assert.ok('flag' in result.report); assert.equal(result.report.flag, flag); }
  assert.ok(!JSON.stringify(result.report).includes(toolUrl.href));
}
async function plan(command: 'plan' | 'apply' = 'plan', changes: Record<string, string> = {}, extra: string[] = []) {
  const result = await run(args(command, changes, extra));
  assert.equal(result.exitCode, 0, JSON.stringify(result.report));
  assert.ok('command' in result.report && result.report.command !== 'status' && !result.report.executed);
  assert.equal(result.report.command, command);
  return result.report;
}
async function apply(changes: Record<string, string> = {}, extra: string[] = []) {
  const tenantIndex = extra.indexOf('--tenant');
  const tenantId = tenantIndex < 0 ? null : extra[tenantIndex + 1];
  const current = (await pool.query(`SELECT revision::text AS revision FROM tenant_capacity_policies
    WHERE status='active' AND tenant_id IS NOT DISTINCT FROM $1::uuid`, [tenantId])).rows[0];
  const result = await run(args('apply', { expect_revision: current?.revision ?? 'none', ...changes }, [...extra, '--execute']));
  assert.equal(result.exitCode, 0, JSON.stringify(result.report));
  assert.ok('command' in result.report && result.report.command === 'apply' && result.report.executed);
  assert.equal(result.report.active_rows_for_scope, 1);
  assert.equal(result.report.replayed, false);
  assert.ok(!result.report.replayed);
  return result.report;
}
async function snapshot() {
  const rows = (await pool.query('SELECT * FROM tenant_capacity_policies ORDER BY tenant_id NULLS FIRST, revision, policy_id')).rows;
  const count = Number((await pool.query('SELECT count(*) FROM tenant_capacity_policies')).rows[0].count);
  return { rows, count };
}
async function tenant() {
  const userId = randomUUID();
  await pool.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref)
    VALUES($1,$2,$3,'Operator fixture','not-a-login-hash',$4)`,
  [userId, DEMO_COMMUNITY, `${userId}@example.invalid`, randomUUID()]);
  const principal = (await pool.query('INSERT INTO principals(user_ref) VALUES($1) RETURNING principal_id', [userId])).rows[0].principal_id;
  return (await pool.query(`INSERT INTO tenants(community_id,display_name,status,created_by_principal_id)
    VALUES($1,'Operator tenant','recovery_required',$2) RETURNING tenant_id`, [DEMO_COMMUNITY, principal])).rows[0].tenant_id as string;
}
async function read(tenantId: string) {
  const client = await pool.connect();
  try { return await readCapacityPolicy(client, tenantId); } finally { client.release(); }
}

before(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  await migrate(pool);
  await seedLocal(pool);
});
beforeEach(async () => { await pool.query('DELETE FROM tenant_capacity_policies'); });
after(async () => {
  await pool.end();
  try { await admin.query(`DROP SCHEMA ${schema} CASCADE`); } finally { await admin.end(); }
});

test('unsafe targets are refused before a connection and DATABASE_URL is ignored', { timeout: 15000 }, async () => {
  refused(await runTenantPolicy(['status', '--expect-database', expectedDatabase], { DATABASE_URL: refusalUrl }), 'database_url_required');
  refused(await runTenantPolicy(['status', '--database-url', refusalUrl, '--expect-database', expectedDatabase], { NODE_ENV: 'production' }), 'production_refused');
  for (const url of [
    'postgresql://x@192.0.2.1:54339/fp_refusal', 'postgresql://x@192.0.2.1:054339/fp_refusal',
    'postgresql://x@192.0.2.1:5432/fp_refusal?port=54339', 'postgresql://x@192.0.2.1:5432/freedom_local',
  ]) {
    const result = await run(['status', '--database-url', url, '--expect-database', expectedDatabase]);
    refused(result, 'shared_local_database_refused');
    assert.ok(!JSON.stringify(result.report).includes('192.0.2.1'));
  }
  for (const url of ['https://192.0.2.1/fp_refusal', 'not a URL']) {
    refused(await run(['status', '--database-url', url, '--expect-database', expectedDatabase]), 'invalid_database_url');
  }
});

for (const [name, url, values, code] of [
  ['omitted port with PGPORT', 'postgresql://x@192.0.2.1/fp_refusal', { PGPORT: '54339' }, 'invalid_database_url'],
  ['omitted database with PGDATABASE', 'postgresql://x@192.0.2.1:5432', { PGDATABASE: 'freedom_local' }, 'invalid_database_url'],
  ['omitted database with shared username', 'postgresql://freedom_local@192.0.2.1:5432', {}, 'invalid_database_url'],
  ['empty database with shared username', 'postgresql://freedom_local@192.0.2.1:5432/', {}, 'invalid_database_url'],
  ['explicit shared port with PGPORT', 'postgresql://x@192.0.2.1:54339/fp_refusal', { PGPORT: '5432' }, 'shared_local_database_refused'],
] as const) {
  test(`${name} is refused for status and executed apply before connecting`, { timeout: 15000 }, async () => {
    const prior = new Map(Object.keys(values).map(name => [name, process.env[name]]));
    try {
      Object.assign(process.env, values);
      for (const argv of [
        ['status', '--database-url', url, '--expect-database', 'fp_refusal'],
        expectDatabase(beforeConnecting(args('apply', {}, ['--execute'])), 'fp_refusal'),
      ]) {
        argv[argv.indexOf('--database-url') + 1] = url;
        const result = await runTenantPolicy(argv, {});
        refused(result, code);
        assert.deepEqual(result.report, { format: 'freedom.tenant-capacity-policy/v1', status: 'refused', code });
        assert.ok(!JSON.stringify(result.report).includes('192.0.2.1'));
      }
    } finally {
      for (const [name, value] of prior) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    }
  });
}
for (const url of [
  'postgresql://x@192.0.2.1:0/fp_refusal', 'postgresql://192.0.2.1:5432/fp_refusal',
  'postgresql:///fp_refusal', 'postgresql://x@%2Ftmp:5432/fp_refusal',
  ...['host=/tmp', 'host=192.0.2.9', 'user=freedom_local', 'database=freedom_local', 'port=5432',
    'sslmode=require', 'sslmode=no-verify', 'ssl=false', 'options=', 'options=a&options=b',
    'sslmode=disable&sslmode=verify-full'].map(query => `postgresql://x@192.0.2.1:5432/fp_refusal?${query}`),
  `${refusalUrl}#fragment`, 'postgresql://x@192.0.2.1:5432/fp/refusal',
  'postgresql://x@192.0.2.1:5432/%E0%A4%A',
]) {
  test(`implicit or ambiguous URL ${url} is refused before connecting`, { timeout: 15000 }, async () => {
    const result = await runTenantPolicy(['status', '--database-url', url, '--expect-database', 'fp_refusal'], {});
    refused(result, 'invalid_database_url');
    assert.deepEqual(result.report, { format: 'freedom.tenant-capacity-policy/v1', status: 'refused', code: 'invalid_database_url' });
    assert.ok(!JSON.stringify(result.report).includes('192.0.2.1'));
  });
}
test('explicit connection does not inherit ambient PG target, TLS, password or SQL options', async () => {
  const values = { PGHOST: 'not-a-target.example.invalid', PGPORT: '9', PGUSER: 'not_the_role', PGDATABASE: wrongDatabase,
    PGSSLMODE: 'require', PGSSLNEGOTIATION: 'direct', PGOPTIONS: '-c default_transaction_read_only=on',
    PGPASSWORD: 'not-an-approved-secret', PGPASSFILE: '/nonexistent/synthetic-pgpass' };
  const prior = new Map(Object.keys(values).map(name => [name, process.env[name]]));
  const planRef = 'ambient-pg-apply';
  try {
    Object.assign(process.env, values);
    for (const argv of [
      ['status', '--database-url', toolUrl.href, '--expect-database', expectedDatabase],
      args('plan'), args('apply', { plan_ref: planRef }, ['--execute']),
    ]) {
      const result = await runTenantPolicy(argv, {});
      assert.equal(result.exitCode, 0, JSON.stringify(result.report));
      assert.ok('target' in result.report);
      assert.deepEqual(result.report.target, { database: expectedDatabase, role: decodeURIComponent(testUrl.username) });
    }
  } finally {
    for (const [name, value] of prior) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  }
  const saved = await snapshot();
  assert.equal(saved.count, 1);
  assert.equal(saved.rows[0].status, 'active');
  assert.equal(saved.rows[0].tenant_id, null);
  assert.equal(saved.rows[0].plan_ref, planRef);
});
for (const [name, url, ssl, options, password] of [
  ['without password or query', 'postgresql://x@127.0.0.2:5432/fp_refusal', false, '-c application_name=freedom-tenant-policy', ''],
  ['with password, TLS and options', 'postgresql://x:synthetic-secret@192.0.2.1:5432/fp_refusal?sslmode=verify-full&options=-c%20search_path%3Dfp_tpo_capture',
    { rejectUnauthorized: true }, '-c search_path=fp_tpo_capture', 'synthetic-secret'],
] as const) {
  test(`pg resolves only explicit URL values ${name} without a network connection`, { timeout: 15000 }, async () => {
    const values = { PGHOST: 'not-a-target.example.invalid', PGPORT: '54339', PGUSER: 'freedom_local', PGDATABASE: 'freedom_local',
      PGOPTIONS: '-c search_path=not_the_schema', PGSSLMODE: 'no-verify', PGSSLNEGOTIATION: 'direct',
      PGPASSWORD: 'not-an-approved-secret', PGPASSFILE: '/nonexistent/synthetic-pgpass', PGAPPNAME: 'not-the-tool', PGCLIENT_ENCODING: 'LATIN1' };
    const prior = new Map(Object.keys(values).map(name => [name, process.env[name]]));
    const original = Pool.prototype.connect, captured: Client[] = [];
    try {
      Object.assign(process.env, values);
      Pool.prototype.connect = function () {
        captured.push(new Client(this.options));
        return Promise.reject(new Error('synthetic connection capture'));
      };
      const argv = expectDatabase(beforeConnecting(args('apply', {}, ['--execute'])), 'fp_refusal');
      argv[argv.indexOf('--database-url') + 1] = url;
      const result = await runTenantPolicy(argv, {});
      assert.deepEqual(result, { exitCode: 1, report: { format: 'freedom.tenant-capacity-policy/v1', status: 'failed', code: 'database_error' } });
      assert.ok(!JSON.stringify(result.report).includes('synthetic-secret'));
      assert.ok(!JSON.stringify(result.report).includes('192.0.2.1'));
    } finally {
      Pool.prototype.connect = original;
      for (const [name, value] of prior) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    }
    assert.equal(captured.length, 1);
    // pg exposes these resolved fields at runtime but omits them from its public Client type.
    const client = captured[0] as unknown as { connectionParameters: Record<string, unknown>; password: () => string | Promise<string> };
    const parameters = client.connectionParameters;
    for (const [key, value] of Object.entries({ host: new URL(url).hostname, port: 5432, database: 'fp_refusal', user: 'x', ssl,
      sslnegotiation: 'postgres', options, application_name: 'freedom-tenant-policy', client_encoding: 'UTF8' })) {
      assert.deepEqual(parameters[key], value, key);
    }
    assert.equal(typeof client.password, 'function');
    assert.equal(await client.password(), password);
  });
}

for (const command of ['plan', 'apply'] as const) {
  for (const key of Object.keys(defaults)) {
    test(`${command} requires ${flagFor(key)}`, { timeout: 15000 }, async () => {
      const argv = beforeConnecting(args(command)), index = argv.indexOf(flagFor(key));
      argv.splice(index, 2);
      refused(await run(argv), 'missing_flag', flagFor(key));
    });
  }
}
test('reviewed ceilings remain fixed', () => {
  assert.deepEqual(CEILINGS, {
    max_active_instances: 50, max_instances_per_module: 10, max_concurrent_provisions: 5,
    max_work_items: 10000, max_retained_bytes: 1073741824, max_concurrent_jobs: 10,
  });
});
for (const [key, ceiling] of Object.entries(CEILINGS)) {
  test(`${key} admits its ceiling and rejects larger or noncanonical integers`, { timeout: 15000 }, async () => {
    const over = await run(beforeConnecting(args('plan', { [key]: String(ceiling + 1) })));
    refused(over, 'over_ceiling', flagFor(key));
    assert.ok('ceiling' in over.report); assert.equal(over.report.ceiling, ceiling);
    const accepted = await plan('plan', { [key]: String(ceiling) });
    assert.equal(accepted.insert[key as keyof typeof CEILINGS], key === 'max_retained_bytes' ? String(ceiling) : ceiling);
    for (const value of ['-1', '1.5', '1e3', '01', '', 'abc', ' 5', '5\n']) {
      refused(await run(beforeConnecting(args('plan', { [key]: value }))), 'invalid_integer', flagFor(key));
    }
    await plan('plan', { [key]: '0' });
  });
}
test('model budgets must be exactly zero, and stored zero is not NULL', { timeout: 15000 }, async () => {
  for (const value of ['NULL', 'null', 'unlimited', '1', '']) {
    refused(await run(beforeConnecting(args('plan', { max_model_budget: value }))), 'model_budget_must_be_zero');
  }
  assert.equal((await plan()).insert.max_model_budget, '0');
  assert.equal((await apply()).inserted.max_model_budget, '0');
  assert.equal((await pool.query('SELECT max_model_budget FROM tenant_capacity_policies')).rows[0].max_model_budget, '0');
});
test('plan_ref uses Unicode code points and bounds 1 through 120', { timeout: 15000 }, async () => {
  for (const value of ['', 'x'.repeat(121)]) refused(await run(beforeConnecting(args('plan', { plan_ref: value }))), 'invalid_plan_ref');
  for (const value of ['x'.repeat(120), '容'.repeat(120), '😀'.repeat(120)]) {
    assert.equal((await plan('plan', { plan_ref: value })).insert.plan_ref, value);
    assert.equal((await apply({ plan_ref: value })).inserted.plan_ref, value);
  }
});
test('argument grammar rejects unknown, duplicate, misplaced and missing tokens', { timeout: 15000 }, async () => {
  const invalid = [
    [], ['unknown'], [...args('plan'), '--unknown', 'x'], [...args('plan'), '--plan-ref', 'x'],
    [...args('plan'), '--execute'], ['status', '--database-url', toolUrl.href, '--plan-ref', 'x'],
    ['status', '--execute'], ['status', '--database-url'], [...args('plan'), '--tenant', '--execute'],
    [...args('plan'), 'extra'], [...args('apply'), '--execute', '--execute'],
    ['status', '--database-url', toolUrl.href, '--tenant', randomUUID()],
    [...args('plan'), '--expect-database', expectedDatabase],
    [...args('apply').slice(0, 3), '--expect-database', '--execute'],
  ];
  for (const argv of invalid) refused(await run(argv.includes('--database-url') ? beforeConnecting(argv) : argv), 'invalid_arguments');
  for (const id of ['bad', randomUUID().toUpperCase(), `${randomUUID()}\n`]) {
    refused(await run(beforeConnecting(args('plan', {}, ['--tenant', id]))), 'invalid_tenant_id');
  }
});

for (const [name, argv] of [
  ['status', ['status', '--database-url', refusalUrl, '--expect-database', expectedDatabase]],
  ['plan', beforeConnecting(args('plan'))],
  ['apply', beforeConnecting(args('apply'))],
  ['apply --execute', beforeConnecting(args('apply', {}, ['--execute']))],
] as const) {
  test(`${name} requires an expected database before connecting`, { timeout: 15000 }, async () => {
    const withoutExpected = [...argv], index = withoutExpected.indexOf('--expect-database');
    withoutExpected.splice(index, 2);
    refused(await run(withoutExpected), 'missing_flag', '--expect-database');
  });
}
for (const command of ['status', 'apply'] as const) {
  for (const expected of ['', 'Fp_upper', 'fp-hyphen', '1digit_first', 'fp name', 'fp_name\n', 'a'.repeat(64), '"fp"', refusalUrl]) {
    test(`${command} rejects expected database ${JSON.stringify(expected)} before connecting`, { timeout: 15000 }, async () => {
      const argv = command === 'status'
        ? ['status', '--database-url', refusalUrl, '--expect-database', expected]
        : expectDatabase(beforeConnecting(args('apply', {}, ['--execute'])), expected);
      const result = await run(argv);
      refused(result, 'invalid_expected_database');
      assert.deepEqual(result.report, { format: 'freedom.tenant-capacity-policy/v1', status: 'refused', code: 'invalid_expected_database' });
      if (expected === refusalUrl) assert.ok(!JSON.stringify(result.report).includes('192.0.2.1'));
    });
  }
}
test('mismatched executed applies preserve default and tenant policies', async () => {
  await apply();
  const t = await tenant();
  await apply({}, ['--tenant', t]);
  const before = await snapshot();
  for (const extra of [['--execute'], ['--tenant', t, '--execute']]) {
    mismatch(await run(expectDatabase(args('apply', {}, extra), wrongDatabase)));
    assert.deepEqual(await snapshot(), before);
  }
});
test('database mismatch precedes the missing tenant check', async () => {
  const missing = randomUUID();
  assert.equal((await pool.query('SELECT 1 FROM tenants WHERE tenant_id=$1', [missing])).rowCount, 0);
  const before = await snapshot();
  for (const argv of [args('plan', {}, ['--tenant', missing]), args('apply', {}, ['--tenant', missing, '--execute'])]) {
    mismatch(await run(expectDatabase(argv, wrongDatabase)));
    assert.deepEqual(await snapshot(), before);
  }
});
test('database mismatch refuses before waiting for the policy advisory lock', { timeout: 15000 }, async () => {
  await apply();
  const before = await snapshot();
  const holder = await openHolder(client => client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [policyLockKey(null)]));
  try {
    mismatch(await run(expectDatabase(args('apply', {}, ['--execute']), wrongDatabase)));
    assert.deepEqual(await snapshot(), before);
  } finally { await holder.release(); }
});
test('read-only commands refuse mismatched databases and accept boundary name syntax', async () => {
  await apply();
  const before = await snapshot();
  for (const expected of [wrongDatabase, 'a'.repeat(63), '_x']) {
    for (const argv of [
      ['status', '--database-url', toolUrl.href, '--expect-database', expected],
      expectDatabase(args('plan'), expected), expectDatabase(args('apply'), expected),
    ]) {
      mismatch(await run(argv), expected);
      assert.deepEqual(await snapshot(), before);
    }
  }
});
test('matching database works for status, plan, and both apply modes', async () => {
  for (const argv of [
    ['status', '--database-url', toolUrl.href, '--expect-database', expectedDatabase],
    args('plan'), args('apply'), args('apply', {}, ['--execute']),
  ]) {
    const result = await run(argv);
    assert.equal(result.exitCode, 0, JSON.stringify(result.report));
    assert.ok('target' in result.report);
    assert.equal(result.report.target.database, expectedDatabase);
  }
});

test('status, plan and unexecuted apply preserve every row and report the requested scope', async () => {
  const empty = await plan();
  assert.equal(empty.retire, null); assert.equal(empty.insert.revision, '1');
  assert.deepEqual(empty.scope, { kind: 'default', tenant_id: null });
  assert.deepEqual(empty.target, { database: new URL(databaseUrl).pathname.slice(1), role: 'freedom_local' });
  const first = await apply();
  const secondPlan = await plan();
  assert.deepEqual(secondPlan.retire, first.inserted); assert.equal(secondPlan.insert.revision, '2');
  const second = await apply({ plan_ref: 'second' });
  const t1 = await tenant(), t2 = await tenant();
  await apply({}, ['--tenant', t1]); await apply({}, ['--tenant', t2]);
  const before = await snapshot();
  await plan(); await plan('apply'); await plan('plan', {}, ['--tenant', t1]); await plan('apply', {}, ['--tenant', t1]);
  const status = await run(['status', '--database-url', toolUrl.href, '--expect-database', expectedDatabase]);
  assert.equal(status.exitCode, 0);
  assert.ok('command' in status.report && status.report.command === 'status');
  assert.equal(status.report.executed, false);
  assert.deepEqual(status.report.default, second.inserted);
  assert.deepEqual(status.report.overrides.map(row => row.tenant_id), [t1, t2].sort());
  assert.deepEqual(status.report.retired, [second.retired]); assert.equal(status.report.retired_total, 1);
  assert.ok(!('policy_lock' in status.report.default!));
  assert.deepEqual(await snapshot(), before);
});
test('apply retires the same row without changing other columns and runtime reads new limits', async () => {
  const first = await apply();
  assert.equal(first.inserted.revision, '1'); assert.equal(first.retired, null);
  const before = (await snapshot()).rows[0];
  const second = await apply({ max_work_items: '12', max_active_instances: '4', max_retained_bytes: '1234' });
  assert.equal(second.inserted.revision, '2');
  assert.deepEqual(second.retired, { ...first.inserted, status: 'retired' });
  const after = (await snapshot()).rows;
  assert.deepEqual(after.find(row => row.policy_id === before.policy_id), { ...before, status: 'retired' });
  assert.equal(after.filter(row => row.status === 'active' && row.tenant_id === null).length, 1);
  assert.deepEqual(await read(randomUUID()), {
    policy_id: second.inserted.policy_id, revision: '2', max_active_instances: 4, max_instances_per_module: 3,
    max_concurrent_provisions: 2, max_work_items: 12, max_retained_bytes: '1234',
  });
});
test('revision allocation includes retired rows even beyond the current active revision', async () => {
  await apply();
  await pool.query(`INSERT INTO tenant_capacity_policies
    (policy_id, revision, tenant_id, plan_ref, max_active_instances, max_instances_per_module, max_concurrent_provisions,
      max_work_items, max_retained_bytes, max_concurrent_jobs, max_model_budget, status, created_at)
    SELECT $1, 9, tenant_id, plan_ref, max_active_instances, max_instances_per_module, max_concurrent_provisions,
      max_work_items, max_retained_bytes, max_concurrent_jobs, max_model_budget, 'retired', created_at
    FROM tenant_capacity_policies WHERE status='active'`, [randomUUID()]);
  assert.equal((await plan()).insert.revision, '10');
  assert.equal((await apply()).inserted.revision, '10');
});
test('status limits retired history to the newest 20 rows while reporting the full total', async () => {
  for (let i = 0; i < 23; i += 1) await apply({ plan_ref: `history-${i}` });
  // Pin the revision tiebreaker independently of timestamp precision.
  await pool.query("UPDATE tenant_capacity_policies SET created_at='2026-10-07T00:00:00Z' WHERE status='retired'");
  const result = await run(['status', '--database-url', toolUrl.href, '--expect-database', expectedDatabase]);
  assert.equal(result.exitCode, 0);
  assert.ok('command' in result.report && result.report.command === 'status');
  assert.equal(result.report.retired_total, 22); assert.equal(result.report.retired.length, 20);
  assert.deepEqual(result.report.retired.map(row => row.revision), Array.from({ length: 20 }, (_, i) => String(22 - i)));
});

async function openHolder(lock: (client: PoolClient) => Promise<unknown>) {
  assert.match(schema, /^fp_tpo_[0-9]+_[0-9]+$/);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const pid = Number((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
    await lock(client);
    let closed = false;
    return { pid, release: async (commit = false) => {
      if (closed) return;
      closed = true;
      try { await client.query(commit ? 'COMMIT' : 'ROLLBACK'); } finally { client.release(); }
    } };
  } catch (error) { await client.query('ROLLBACK').catch(() => undefined); client.release(); throw error; }
}
async function blockedQueries(holderPid: number) {
  return (await admin.query<{ pid: number; query: string }>(`SELECT pid, query FROM pg_stat_activity
    WHERE datname=current_database() AND pid <> $1 AND $1 = ANY(pg_blocking_pids(pid))`, [holderPid])).rows;
}
async function waitForBlockedQuery(holderPid: number, parts: string[], count = 1) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const hits = (await blockedQueries(holderPid)).filter(row => parts.every(part => row.query.includes(part)));
    if (hits.length >= count) return hits;
    await delay(40);
  }
  assert.fail(`no ${count} backends blocked by ${holderPid} matching ${parts.join(' & ')}; saw ${JSON.stringify(await blockedQueries(holderPid))}`);
}
test('concurrent default applies serialize and allocate consecutive revisions', { timeout: 15000 }, async () => {
  const initial = await apply();
  const holder = await openHolder(client => client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [policyLockKey(null)]));
  const pending = [apply({ plan_ref: 'concurrent-a', expect_revision: initial.inserted.revision })];
  try {
    await waitForBlockedQuery(holder.pid, ['pg_advisory_xact_lock']);
    pending.push(apply({ plan_ref: 'concurrent-b', expect_revision: String(Number(initial.inserted.revision) + 1) }));
  } catch (error) { await holder.release(); throw error; }
  try { await waitForBlockedQuery(holder.pid, ['pg_advisory_xact_lock'], 2); } finally { await holder.release(); }
  const results = await Promise.all(pending);
  const revisions = results.map(result => Number(result.inserted.revision)).sort((a, b) => a - b);
  assert.deepEqual(revisions, [Number(initial.inserted.revision) + 1, Number(initial.inserted.revision) + 2]);
  assert.notEqual(results[0].inserted.plan_ref, results[1].inserted.plan_ref);
  const all = (await snapshot()).rows;
  assert.equal(all.length, 3); assert.equal(all.filter(row => row.status === 'active').length, 1);
  assert.equal(all.find(row => row.status === 'active').revision, String(revisions[1]));
  assert.ok(all.filter(row => row.revision !== String(revisions[1])).every(row => row.status === 'retired'));
});
test('tenant overrides preserve the default and missing tenants refuse without writes', async () => {
  const base = await apply(), t = await tenant(), other = await tenant();
  const before = (await snapshot()).rows[0];
  const first = await apply({ max_work_items: '7' }, ['--tenant', t]);
  assert.equal(first.inserted.revision, '2'); assert.deepEqual(first.scope, { kind: 'tenant', tenant_id: t });
  assert.equal((await read(t))?.policy_id, first.inserted.policy_id);
  assert.equal((await read(other))?.policy_id, base.inserted.policy_id);
  assert.deepEqual((await snapshot()).rows.find(row => row.policy_id === base.inserted.policy_id), before);
  const second = await apply({ max_work_items: '8' }, ['--tenant', t]);
  assert.equal(second.inserted.revision, '3'); assert.deepEqual(second.retired, { ...first.inserted, status: 'retired' });
  assert.equal((await read(t))?.revision, '3');
  assert.deepEqual((await snapshot()).rows.find(row => row.policy_id === base.inserted.policy_id), before);
  const snap = await snapshot(), missing = randomUUID();
  for (const argv of [args('plan', {}, ['--tenant', missing]), args('apply', {}, ['--tenant', missing]), args('apply', {}, ['--tenant', missing, '--execute'])]) {
    refused(await run(argv), 'tenant_not_found'); assert.deepEqual(await snapshot(), snap);
  }
});
test('tenant apply waits for the runtime tenant policy lock', { timeout: 15000 }, async () => {
  await apply();
  const t = await tenant();
  assert.equal(policyLockKey(t), `tenant.capacity/v1/${t}/policy`);
  assert.equal(policyLockKey(null), 'tenant.capacity/v1/default/policy');
  const first = await apply({}, ['--tenant', t]);
  const holder = await openHolder(client => lockCapacityPolicy(client, t));
  const pending = apply({ plan_ref: 'after-runtime-write' }, ['--tenant', t]);
  try { await waitForBlockedQuery(holder.pid, ['pg_advisory_xact_lock']); } finally { await holder.release(true); }
  const result = await pending;
  assert.equal(result.inserted.revision, '3'); assert.equal(result.retired?.policy_id, first.inserted.policy_id);
  assert.equal((await read(t))?.policy_id, result.inserted.policy_id);
});

test('default apply also waits for a runtime FOR SHARE holder', { timeout: 15000 }, async () => {
  const first = await apply();
  const holder = await openHolder(client => lockCapacityPolicy(client, randomUUID()));
  const pending = apply({ plan_ref: 'after-default-share' });
  try { await waitForBlockedQuery(holder.pid, ['tenant_capacity_policies', 'FOR UPDATE']); } finally { await holder.release(true); }
  assert.equal((await pending).retired?.policy_id, first.inserted.policy_id);
});

for (const [sqlstate, code] of [['42501', 'operator_privilege_required'], ['55P03', 'lock_timeout'], ['23514', 'database_error']]) {
  test(`SQLSTATE ${sqlstate} is sanitized and the entire replacement rolls back`, async () => {
    await apply();
    const before = await snapshot();
    await pool.query(`CREATE FUNCTION operator_failure() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'sensitive connection detail' USING ERRCODE='${sqlstate}'; END $$`);
    await pool.query('CREATE TRIGGER operator_failure BEFORE INSERT ON tenant_capacity_policies FOR EACH ROW EXECUTE FUNCTION operator_failure()');
    try {
      const result = await run(args('apply', { expect_revision: '1' }, ['--execute']));
      assert.deepEqual(result, { exitCode: 1, report: { format: 'freedom.tenant-capacity-policy/v1', status: 'failed', code, sqlstate } });
      assert.deepEqual(await snapshot(), before);
    } finally {
      await pool.query('DROP TRIGGER operator_failure ON tenant_capacity_policies');
      await pool.query('DROP FUNCTION operator_failure()');
    }
  });
}
test('scope verification failure rolls back retirement and insertion', async () => {
  await apply();
  const before = await snapshot();
  await pool.query(`CREATE FUNCTION operator_verification_failure() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN UPDATE tenant_capacity_policies SET status='retired' WHERE policy_id=NEW.policy_id; RETURN NEW; END $$`);
  await pool.query('CREATE TRIGGER operator_verification_failure AFTER INSERT ON tenant_capacity_policies FOR EACH ROW EXECUTE FUNCTION operator_verification_failure()');
  try {
    const result = await run(args('apply', { expect_revision: '1' }, ['--execute']));
    assert.deepEqual(result, { exitCode: 1, report: { format: 'freedom.tenant-capacity-policy/v1', status: 'failed', code: 'scope_verification_failed' } });
    assert.deepEqual(await snapshot(), before);
  } finally {
    await pool.query('DROP TRIGGER operator_verification_failure ON tenant_capacity_policies');
    await pool.query('DROP FUNCTION operator_verification_failure()');
  }
});

function applied(result: Awaited<ReturnType<typeof runTenantPolicy>>) {
  assert.equal(result.exitCode, 0, JSON.stringify(result.report));
  assert.ok('command' in result.report && result.report.command === 'apply' && result.report.executed);
  return result.report;
}
function revisionConflict(result: Awaited<ReturnType<typeof runTenantPolicy>>, expected: string, current: string) {
  assert.deepEqual(result, { exitCode: 2, report: {
    format: 'freedom.tenant-capacity-policy/v1', status: 'refused', code: 'revision_conflict', expected, current,
  } });
}

test('stale plans refuse after a newer default apply and preserve every row', async () => {
  const first = await apply();
  const reviewed = await plan();
  assert.equal(reviewed.expect_revision, first.inserted.revision);
  assert.equal(reviewed.provisional_revision, true);
  const second = await apply({ plan_ref: 'operator-b' });
  const before = await snapshot();
  revisionConflict(await run(args('apply', { expect_revision: reviewed.expect_revision }, ['--execute'])),
    reviewed.expect_revision, second.inserted.revision);
  for (const command of ['plan', 'apply'] as const) {
    revisionConflict(await run(args(command, { expect_revision: reviewed.expect_revision })),
      reviewed.expect_revision, second.inserted.revision);
  }
  assert.deepEqual(await snapshot(), before);
});
test('none means no active row in the requested scope, including tenant overrides', async () => {
  assert.equal((await plan()).expect_revision, 'none');
  const base = await apply();
  const before = await snapshot();
  revisionConflict(await run(args('apply', { expect_revision: 'none' }, ['--execute'])), 'none', base.inserted.revision);
  assert.deepEqual(await snapshot(), before);
  const t = await tenant();
  assert.equal((await plan('plan', {}, ['--tenant', t])).expect_revision, 'none');
  const inserted = applied(await run(args('apply', { expect_revision: 'none' }, ['--tenant', t, '--execute'])));
  assert.equal(inserted.inserted.tenant_id, t);
  const snap = await snapshot();
  revisionConflict(await run(args('apply', { expect_revision: '1' }, ['--tenant', await tenant(), '--execute'])), '1', 'none');
  assert.deepEqual(await snapshot(), snap);
});
for (const flag of ['--expect-revision', '--operation-id']) {
  test(`executed apply requires ${flag} before connecting`, async () => {
    const argv = beforeConnecting(args('apply', {}, ['--execute']));
    argv.splice(argv.indexOf(flag), 2);
    refused(await run(argv), 'missing_flag', flag);
  });
}
for (const [key, code, values] of [
  ['expect_revision', 'invalid_expected_revision', ['', '0', '01', '-1', '1.5', 'None', '1'.repeat(20), ' 1', '1\n', 'none\n']],
  ['operation_id', 'invalid_operation_id', ['', 'short', 'A2345678', '_1234567', 'a'.repeat(65), 'abcd/efgh', 'abcdefgh\n', ' abcdefgh']],
] as const) {
  test(`${key} rejects noncanonical grammar before connecting`, async () => {
    for (const value of values) refused(await run(beforeConnecting(args('apply', { [key]: value }, ['--execute']))), code);
  });
}
test('revision grammar accepts one through nineteen digits before a plain read', async () => {
  for (const value of ['1', '9999999999999999999']) {
    revisionConflict(await run(args('plan', { expect_revision: value })), value, 'none');
  }
});
test('operation identity and expected revision are refused on unsupported commands', async () => {
  for (const argv of [
    ['status', '--database-url', refusalUrl, '--expect-database', expectedDatabase, '--expect-revision', 'none'],
    ['status', '--database-url', refusalUrl, '--expect-database', expectedDatabase, '--operation-id', 'operation-001'],
    beforeConnecting(args('plan', { operation_id: 'operation-001' })),
    beforeConnecting(args('apply', { operation_id: 'operation-001' })),
  ]) refused(await run(argv), 'invalid_arguments');
});
test('identical operations replay active and later retired rows without writing', async () => {
  const argv = args('apply', { operation_id: 'replay-operation', expect_revision: 'none' }, ['--execute']);
  const first = applied(await run(argv));
  assert.equal(first.replayed, false);
  const before = await snapshot();
  const replay = applied(await run(argv));
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.inserted, first.inserted);
  assert.equal(replay.active_rows_for_scope, 1);
  assert.deepEqual(await snapshot(), before);
  await apply({ operation_id: 'newer-operation' });
  const retiredSnapshot = await snapshot();
  const retiredReplay = applied(await run(argv));
  assert.equal(retiredReplay.replayed, true);
  assert.deepEqual(retiredReplay.inserted, { ...first.inserted, status: 'retired' });
  assert.equal(retiredReplay.active_rows_for_scope, 1);
  assert.deepEqual(await snapshot(), retiredSnapshot);
});
test('discarding a successful response then retrying the same precondition replays', async () => {
  const argv = args('apply', { operation_id: 'lost-response-001', expect_revision: 'none' }, ['--execute']);
  await run(argv); // Simulate a committed response that the operator never received.
  const before = await snapshot();
  assert.equal(before.count, 1);
  const replay = applied(await run(argv));
  assert.equal(replay.replayed, true);
  assert.equal(replay.inserted.policy_id, before.rows[0].policy_id);
  assert.equal(replay.inserted.revision, String(before.rows[0].revision));
  assert.deepEqual(await snapshot(), before);
});
test('operation IDs cannot be reused with different limits, plans, model budgets or scopes', async () => {
  const operationId = 'conflict-operation';
  await apply({ operation_id: operationId });
  const t = await tenant(), missing = randomUUID();
  const before = await snapshot();
  for (const changes of [
    ...Object.keys(CEILINGS).map(key => ({ [key]: '1' })), { plan_ref: 'different-plan' },
  ]) {
    refused(await run(args('apply', { operation_id: operationId, ...changes }, ['--execute'])), 'operation_id_conflict');
    assert.deepEqual(await snapshot(), before);
  }
  for (const id of [t, missing]) {
    refused(await run(args('apply', { operation_id: operationId }, ['--tenant', id, '--execute'])), 'operation_id_conflict');
    assert.deepEqual(await snapshot(), before);
  }
  // A historical row with a different model budget also cannot replay the zero-budget request.
  await pool.query('UPDATE tenant_capacity_policies SET max_model_budget=1 WHERE policy_id=$1', [operationPolicyId(operationId)]);
  const changed = await snapshot();
  refused(await run(args('apply', { operation_id: operationId }, ['--execute'])), 'operation_id_conflict');
  assert.deepEqual(await snapshot(), changed);
});
test('operation policy IDs are deterministic lowercase version 5 UUIDs with RFC 4122 variants', () => {
  const id = operationPolicyId('operation-001');
  assert.equal(id, operationPolicyId('operation-001'));
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(id, operationPolicyId('operation-002'));
});
test('remote connections require verify-full before any network connection', async () => {
  const original = Pool.prototype.connect;
  let connections = 0;
  try {
    Pool.prototype.connect = function () { connections += 1; return Promise.reject(new Error('network forbidden')); };
    for (const query of ['', '?sslmode=disable']) {
      refused(await run(['status', '--database-url', `postgresql://x@192.0.2.1:5432/fp_refusal${query}`,
        '--expect-database', 'fp_refusal']), 'tls_required');
    }
    assert.equal(connections, 0);
  } finally { Pool.prototype.connect = original; }
});
test('loopback disable continues to work', async () => {
  const url = new URL(toolUrl); url.searchParams.set('sslmode', 'disable');
  const result = await run(['status', '--database-url', url.href, '--expect-database', expectedDatabase]);
  assert.equal(result.exitCode, 0, JSON.stringify(result.report));
});
test('global revisions distinguish default, first override, and later replacements in runtime SQL', async () => {
  const t = await tenant(), other = await tenant();
  const base = await apply();
  const r = BigInt(base.inserted.revision);
  assert.equal((await read(t))?.revision, String(r));
  const first = await apply({}, ['--tenant', t]);
  assert.equal(first.inserted.revision, String(r + 1n));
  assert.notEqual(first.inserted.revision, '1');
  assert.equal((await read(t))?.revision, String(r + 1n));
  const provisional = await plan();
  assert.equal(provisional.insert.revision, String(r + 2n));
  assert.equal(provisional.provisional_revision, true);
  const nextDefault = await apply();
  assert.equal(nextDefault.inserted.revision, String(r + 2n));
  // A default replacement changes fallback tenants; an override remains effective for its own tenant.
  assert.equal((await read(other))?.revision, String(r + 2n));
  assert.equal((await read(t))?.revision, String(r + 1n));
  const nextOverride = await apply({}, ['--tenant', t]);
  assert.equal((await read(t))?.revision, nextOverride.inserted.revision);
  assert.equal(nextOverride.inserted.revision, String(r + 3n));
});
test('concurrent applies on different scopes commit distinct global revisions', { timeout: 15000 }, async () => {
  const t = await tenant();
  const holder = await openHolder(client => client.query("SELECT pg_advisory_xact_lock(hashtextextended('tenant.capacity/v1/policy-revisions', 0))"));
  const pending = [apply({ plan_ref: 'global-default' }), apply({ plan_ref: 'global-tenant' }, ['--tenant', t])];
  try { await waitForBlockedQuery(holder.pid, ['pg_advisory_xact_lock', 'policy-revisions'], 2); } finally { await holder.release(); }
  const results = await Promise.all(pending);
  assert.deepEqual(results.map(result => result.inserted.revision).sort(), ['1', '2']);
  assert.notEqual(results[0].inserted.revision, results[1].inserted.revision);
  const saved = await snapshot();
  assert.equal(saved.count, 2);
  assert.ok(saved.rows.every(row => row.status === 'active'));
  assert.equal((await read(t))?.revision, results[1].inserted.revision);
});
