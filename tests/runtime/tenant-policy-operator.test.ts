import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool, type PoolClient } from 'pg';
import { migrate } from '../../scripts/database.js';
import { seedLocal, DEMO_COMMUNITY } from '../../packages/testing/seed.js';
import { CEILINGS, policyLockKey, runTenantPolicy } from '../../scripts/tenant-policy.js';
import { lockCapacityPolicy, readCapacityPolicy } from '../../modules/opportunity-project-work/tenant-capacity.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('tenant-policy-operator tests require an explicit TEST_DATABASE_URL for a private test database.');
const expectedDatabase = new URL(databaseUrl).pathname.slice(1);
const refusalUrl = 'postgresql://x@192.0.2.1:5432/fp_refusal';
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
  return [command, '--database-url', toolUrl.href, '--expect-database', expectedDatabase,
    ...Object.entries({ ...defaults, ...changes }).flatMap(([key, value]) => [flagFor(key), value]), ...extra];
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
  const result = await run(args('apply', changes, [...extra, '--execute']));
  assert.equal(result.exitCode, 0, JSON.stringify(result.report));
  assert.ok('command' in result.report && result.report.command === 'apply' && result.report.executed);
  assert.equal(result.report.active_rows_for_scope, 1);
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
  const pending = [apply({ plan_ref: 'concurrent-a' }), apply({ plan_ref: 'concurrent-b' })];
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
  assert.equal(first.inserted.revision, '1'); assert.deepEqual(first.scope, { kind: 'tenant', tenant_id: t });
  assert.equal((await read(t))?.policy_id, first.inserted.policy_id);
  assert.equal((await read(other))?.policy_id, base.inserted.policy_id);
  assert.deepEqual((await snapshot()).rows.find(row => row.policy_id === base.inserted.policy_id), before);
  const second = await apply({ max_work_items: '8' }, ['--tenant', t]);
  assert.equal(second.inserted.revision, '2'); assert.deepEqual(second.retired, { ...first.inserted, status: 'retired' });
  assert.equal((await read(t))?.revision, '2');
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
  assert.equal(result.inserted.revision, '2'); assert.equal(result.retired?.policy_id, first.inserted.policy_id);
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
      const result = await run(args('apply', {}, ['--execute']));
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
    const result = await run(args('apply', {}, ['--execute']));
    assert.deepEqual(result, { exitCode: 1, report: { format: 'freedom.tenant-capacity-policy/v1', status: 'failed', code: 'scope_verification_failed' } });
    assert.deepEqual(await snapshot(), before);
  } finally {
    await pool.query('DROP TRIGGER operator_verification_failure ON tenant_capacity_policies');
    await pool.query('DROP FUNCTION operator_verification_failure()');
  }
});
