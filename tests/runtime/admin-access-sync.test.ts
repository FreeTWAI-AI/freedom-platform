import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createPool, LOCAL_DATABASE_URL } from '../../packages/db/index.js';
import { migrate } from '../../scripts/database.js';
import { syncAdminAccess, type AccessSyncConfig } from '../../modules/platform-admin/access-sync.js';
import { adminNominees, changePlatformAdminStatus, type AdminActor } from '../../modules/platform-admin/service.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? LOCAL_DATABASE_URL;
const schema = `fp_access_sync_${process.pid}_${Date.now()}`, database = createPool(databaseUrl);
const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, application_name: schema, max: 8 });
const community = randomUUID(), firstId = randomUUID(), secondId = randomUUID(), revokedId = randomUUID();
const firstEmail = 'alpha@example.invalid', secondEmail = 'zeta@example.invalid', revokedEmail = 'removed@example.invalid';
const activeEmails = [firstEmail, secondEmail];
const config: AccessSyncConfig = { accountId: 'a'.repeat(32), appId: randomUUID(), policyId: randomUUID(), domain: 'workshop.example.invalid/admin', token: 'synthetic-cloudflare-token' };
const base = `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/access/apps/${config.appId}`;
const app = { id: config.appId, domain: config.domain, type: 'self_hosted' };
const policyPath = `/policies/${config.policyId}`, listPath = '/policies?per_page=100';
const actor: AdminActor = { admin_id: firstId, community_id: community, email: firstEmail, display_name: 'Alpha', role: 'super_admin', subject: 'synthetic-verified-subject' };
let created = false;

before(async () => {
  await database.query(`CREATE SCHEMA ${schema}`); created = true;
  await migrate(pool);
  assert.equal((await pool.query("SELECT 1 FROM schema_migrations WHERE name='017_admin_appointments.sql'")).rowCount, 1);
});
after(async () => {
  await pool.end();
  try { if (created) await database.query(`DROP SCHEMA ${schema} CASCADE`); }
  finally { await database.end(); }
});
beforeEach(async () => {
  await pool.query('TRUNCATE communities CASCADE');
  await pool.query('INSERT INTO communities(community_id,name) VALUES($1,$2)', [community, 'Isolated Access synchronization fixture']);
  await pool.query(`INSERT INTO platform_admins(admin_id,community_id,email,display_name,active,aggregate_version,access_synced_version,access_synced_at) VALUES
    ($1,$4,$5,'Alpha',true,1,NULL,NULL),
    ($2,$4,$6,'Zeta',true,3,2,'2025-01-01T00:00:00Z'),
    ($3,$4,$7,'Removed',false,2,1,'2025-01-01T00:00:00Z')`,
  [firstId, secondId, revokedId, community, firstEmail, secondEmail, revokedEmail]);
});

function policy(emails = activeEmails, overrides: Record<string, unknown> = {}) {
  return { id: config.policyId, name: 'Nominated Freedom super administrators', decision: 'allow',
    include: emails.map(email => ({ email: { email } })), require: [], exclude: [], ...overrides };
}
type Step = { path: string; method?: string; result?: unknown; envelope?: unknown; status?: number; headers?: HeadersInit; error?: Error; before?: () => Promise<void> };
function provider(steps: Step[]) {
  const calls: { path: string; method: string; body: unknown }[] = [];
  // Every request is consumed locally. An unexpected call fails instead of
  // falling through to the real Cloudflare API.
  const fetcher: typeof fetch = async (input, init) => {
    const index = calls.length, step = steps[index], url = String(input), method = init?.method ?? 'GET';
    calls.push({ path: url.slice(base.length), method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    assert.ok(step, `Unexpected provider request ${method} ${url}`);
    assert.equal(url, base + step.path); assert.equal(method, step.method ?? 'GET');
    assert.equal(init?.redirect, 'manual'); assert.notEqual(init?.redirect, 'error'); assert.ok(init?.signal instanceof AbortSignal);
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('Authorization'), `Bearer ${config.token}`);
    assert.equal(headers.get('Content-Type'), 'application/json');
    await step.before?.();
    if (step.error) throw step.error;
    return Response.json(step.envelope ?? { success: true, result: step.result }, { status: step.status ?? 200, headers: step.headers });
  };
  return { fetcher, calls, complete: () => assert.equal(calls.length, steps.length) };
}
function updateSteps(prior = policy([revokedEmail]), verified = policy()): Step[] {
  return [{ path: '', result: app }, { path: listPath, result: [prior] },
    { path: policyPath, method: 'PUT', result: verified }, { path: policyPath, result: verified }];
}
async function revisions() {
  return (await pool.query('SELECT admin_id,email,active,aggregate_version,access_synced_version,access_synced_at FROM platform_admins ORDER BY email')).rows;
}
async function states() {
  return Object.fromEntries((await adminNominees(pool, actor)).map(row => [row.email, row.access_state]));
}
async function acknowledgeFixture() {
  await pool.query("UPDATE platform_admins SET access_synced_version=aggregate_version,access_synced_at='2025-01-01T00:00:00Z'");
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function within(promise: Promise<void>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error('Expected synchronization checkpoint was not reached.')), 3000); })]); }
  finally { if (timer) clearTimeout(timer); }
}
async function waitForAdvisoryBlocker(pid: number) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const blocked = await pool.query(`SELECT 1 FROM pg_stat_activity WHERE application_name=$1
      AND $2=ANY(pg_blocking_pids(pid)) AND wait_event_type='Lock' AND wait_event='advisory'`, [schema, pid]);
    if (blocked.rowCount) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('Expected operation to wait on the shared admin-role advisory lock.');
}

test('only exact active-admin emails are allowed; ready/revoked acknowledgments wait for provider read-back', async () => {
  const initial = await revisions(), reading = deferred(), release = deferred(), steps = updateSteps();
  steps[3].before = async () => { reading.resolve(); await release.promise; };
  const remote = provider(steps), pending = syncAdminAccess(pool, config, { fetcher: remote.fetcher });
  try {
    await within(reading.promise);
    assert.deepEqual(await revisions(), initial);
    assert.deepEqual(await states(), { [firstEmail]: 'pending', [secondEmail]: 'pending', [revokedEmail]: 'pending_removal' });
    assert.deepEqual(remote.calls[2].body, { name: 'Nominated Freedom super administrators', decision: 'allow',
      include: activeEmails.map(email => ({ email: { email } })), exclude: [], require: [], precedence: 1 });
  } finally { release.resolve(); await pending; }
  assert.deepEqual(await pending, { checked: true, updated: true, active_admins: 2 }); remote.complete();
  assert.deepEqual(await states(), { [firstEmail]: 'ready', [secondEmail]: 'ready', [revokedEmail]: 'revoked' });
  for (const row of await revisions()) {
    assert.equal(row.access_synced_version, row.aggregate_version);
    assert.ok(row.access_synced_at instanceof Date);
    assert.ok(row.access_synced_at.getTime() > Date.parse('2025-01-01T00:00:00Z'));
    assert.equal(row.aggregate_version, initial.find(prior => prior.admin_id === row.admin_id)!.aggregate_version);
  }
});

test('pending revisions with an already exact allowlist are read back without an unnecessary policy write', async () => {
  const exact = policy([...activeEmails].reverse());
  const remote = provider([{ path: '', result: app }, { path: listPath, result: [exact] }, { path: policyPath, result: exact }]);
  assert.deepEqual(await syncAdminAccess(pool, config, { fetcher: remote.fetcher }), { checked: true, updated: false, active_admins: 2 });
  remote.complete(); assert.deepEqual(await states(), { [firstEmail]: 'ready', [secondEmail]: 'ready', [revokedEmail]: 'revoked' });
});

test('no pending revisions skips every provider request and preserves synchronization timestamps', async () => {
  await acknowledgeFixture(); const initial = await revisions(), remote = provider([]);
  assert.deepEqual(await syncAdminAccess(pool, config, { fetcher: remote.fetcher }), { checked: false, updated: false, active_admins: 2 });
  remote.complete(); assert.deepEqual(await revisions(), initial);
});

test('--force worker option detects and repairs remote drift even when all database revisions are acknowledged', async () => {
  await acknowledgeFixture();
  const remote = provider(updateSteps(policy([...activeEmails, 'unexpected@example.invalid'])));
  assert.deepEqual(await syncAdminAccess(pool, config, { fetcher: remote.fetcher, force: true }), { checked: true, updated: true, active_admins: 2 });
  remote.complete(); assert.deepEqual(remote.calls[2].body, { name: 'Nominated Freedom super administrators', decision: 'allow', include: policy().include, exclude: [], require: [], precedence: 1 });
});

const failures: { name: string; steps: Step[]; expected: RegExp; writes?: number }[] = [
  { name: 'HTTP provider error', steps: [{ path: '', status: 503 }], expected: /provider request failed \(503\)/ },
  { name: 'redirect response', steps: [{ path: '', status: 302, headers: { Location: 'https://evil.example/steal' } }], expected: /provider request failed \(302\)/ },
  { name: 'read-back redirect', steps: [...updateSteps().slice(0, 3), { path: policyPath, status: 301, headers: { Location: 'https://evil.example/steal' } }], expected: /provider request failed \(301\)/, writes: 1 },
  { name: 'provider error envelope', steps: [{ path: '', envelope: { success: false, result: app } }], expected: /incomplete result/ },
  { name: 'missing provider result', steps: [{ path: '', envelope: { success: true } }], expected: /incomplete result/ },
  { name: 'network failure', steps: [{ path: '', error: Error('Synthetic provider connection failure') }], expected: /Synthetic provider connection failure/ },
  ...Object.entries({ id: randomUUID(), domain: 'workshop.example.invalid/*', type: 'saas' }).map(([field, value]) => ({
    name: `wrong application ${field}`, steps: [{ path: '', result: { ...app, [field]: value } }], expected: /application scope mismatch/,
  })),
  { name: 'additional policy', steps: [{ path: '', result: app }, { path: listPath, result: [policy(), policy([], { id: randomUUID(), decision: 'bypass' })] }], expected: /Unexpected admin access policies/ },
  { name: 'different policy ID', steps: [{ path: '', result: app }, { path: listPath, result: [policy([], { id: randomUUID() })] }], expected: /Unexpected admin access policies/ },
  { name: 'missing policy', steps: [{ path: '', result: app }, { path: listPath, result: [] }], expected: /Unexpected admin access policies/ },
  { name: 'paginated policy set', steps: [{ path: '', result: app }, { path: listPath, envelope: { success: true, result: [policy()], result_info: { total_pages: 2 } } }], expected: /paginated admin policy set/ },
  ...Object.entries({ name: 'Unrelated policy', decision: 'bypass', require: [{ email_domain: { domain: 'example.invalid' } }], exclude: [{ email: { email: firstEmail } }] }).map(([field, value]) => ({
    name: `unexpected policy ${field}`, steps: [{ path: '', result: app }, { path: listPath, result: [policy([], { [field]: value })] }], expected: /Unexpected admin policy constraints/,
  })),
  { name: 'policy write failure', steps: [...updateSteps().slice(0, 2), { path: policyPath, method: 'PUT', status: 500 }], expected: /provider request failed \(500\)/, writes: 1 },
  { name: 'read-back provider failure', steps: [...updateSteps().slice(0, 3), { path: policyPath, status: 502 }], expected: /provider request failed \(502\)/, writes: 1 },
  ...Object.entries({
    'missing active email': { include: policy([firstEmail]).include },
    'additional email': { include: policy([...activeEmails, revokedEmail]).include },
    'duplicate email': { include: policy([firstEmail, firstEmail]).include },
    'broad allow rule': { include: [{ everyone: {} }, { email: { email: firstEmail } }] },
    'extra selector': { include: [{ email: { email: firstEmail }, everyone: {} }, { email: { email: secondEmail } }] },
    'different policy': { id: randomUUID() }, 'bypass decision': { decision: 'bypass' },
    'new requirement': { require: [{ email_domain: { domain: 'example.invalid' } }] },
    'new exclusion': { exclude: [{ email: { email: firstEmail } }] },
  }).map(([name, override]) => ({ name: `read-back ${name}`, steps: updateSteps(policy([revokedEmail]), policy(activeEmails, override)), expected: /read-back did not match/, writes: 1 })),
];
for (const scenario of failures) test(`${scenario.name} leaves all pending revisions and timestamps unchanged`, async () => {
  const initial = await revisions(), remote = provider(scenario.steps);
  await assert.rejects(syncAdminAccess(pool, config, { fetcher: remote.fetcher }), scenario.expected);
  remote.complete(); assert.equal(remote.calls.filter(call => call.method === 'PUT').length, scenario.writes ?? 0);
  assert.ok(remote.calls.every(call => !String(call.path).includes('evil.example')));
  assert.deepEqual(await revisions(), initial);
  assert.deepEqual(await states(), { [firstEmail]: 'pending', [secondEmail]: 'pending', [revokedEmail]: 'pending_removal' });
});

test('an opaque redirect is rejected before a policy write and leaves revisions pending', async () => {
  const initial = await revisions();
  let calls = 0;
  const fetcher: typeof fetch = async (input, init) => {
    calls += 1;
    assert.equal(init?.redirect, 'manual'); assert.notEqual(init?.redirect, 'error');
    assert.equal(String(input), base);
    return { type: 'opaqueredirect', status: 0, ok: true, headers: new Headers({ Location: 'https://evil.example/steal' }), json: async () => { throw new Error('followed opaque redirect'); }, text: async () => 'followed' } as unknown as Response;
  };
  await assert.rejects(syncAdminAccess(pool, config, { fetcher }), /provider request failed \(0\)/);
  assert.equal(calls, 1); assert.deepEqual(await revisions(), initial);
});

test('an ambiguous community scope and an empty active-admin set fail before calling the provider', async () => {
  const remote = provider([]), extraCommunity = randomUUID();
  await pool.query('INSERT INTO communities VALUES($1,$2)', [extraCommunity, 'Other fixture community']);
  await assert.rejects(syncAdminAccess(pool, config, { fetcher: remote.fetcher }), /single-community database/);
  await pool.query('DELETE FROM communities WHERE community_id=$1', [extraCommunity]);
  await pool.query('UPDATE platform_admins SET active=false');
  const initial = await revisions();
  await assert.rejects(syncAdminAccess(pool, config, { fetcher: remote.fetcher }), /at least one distinct active administrator/);
  remote.complete(); assert.deepEqual(await revisions(), initial);
});

test('the worker waits for the same admin-role advisory lock before taking its email snapshot', async () => {
  const blocker = await pool.connect(), newcomer = 'newly-appointed@example.invalid';
  const expected = [firstEmail, newcomer].sort(), remote = provider(updateSteps(policy(activeEmails), policy(expected)));
  let pending: ReturnType<typeof syncAdminAccess> | undefined;
  try {
    await blocker.query('BEGIN');
    const pid = (await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    await blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`admin-roles/${community}`]);
    pending = syncAdminAccess(pool, config, { fetcher: remote.fetcher });
    await waitForAdvisoryBlocker(pid); assert.equal(remote.calls.length, 0);
    await blocker.query('UPDATE platform_admins SET active=false,aggregate_version=aggregate_version+1 WHERE admin_id=$1', [secondId]);
    await blocker.query('INSERT INTO platform_admins(admin_id,community_id,email,display_name) VALUES($1,$2,$3,$4)', [randomUUID(), community, newcomer, 'Newly appointed']);
    await blocker.query('COMMIT');
    assert.deepEqual(await pending, { checked: true, updated: true, active_admins: 2 }); remote.complete();
    assert.deepEqual((remote.calls[2].body as ReturnType<typeof policy>).include, policy(expected).include);
    assert.deepEqual(await states(), { [firstEmail]: 'ready', [secondEmail]: 'revoked', [revokedEmail]: 'revoked', [newcomer]: 'ready' });
  } finally { await blocker.query('ROLLBACK'); blocker.release(); await pending; }
});

test('a real revocation waits through read-back and remains pending removal at its new revision', async () => {
  const reading = deferred(), release = deferred(), steps = updateSteps();
  steps[3].before = async () => { reading.resolve(); await release.promise; };
  const remote = provider(steps), syncing = syncAdminAccess(pool, config, { fetcher: remote.fetcher });
  let revoking: ReturnType<typeof changePlatformAdminStatus> | undefined;
  try {
    await within(reading.promise);
    const worker = await pool.query("SELECT pid FROM pg_stat_activity WHERE application_name=$1 AND state='idle in transaction'", [schema]);
    assert.equal(worker.rowCount, 1);
    revoking = changePlatformAdminStatus(pool, { admin: actor, operation: 'test-revoke-during-access-sync', key: randomUUID(), expected: '3',
      body: { active: false, confirmed: true, reason: 'Confirmed fixture revocation.' } }, secondId);
    await waitForAdvisoryBlocker(worker.rows[0].pid);
    release.resolve();
    assert.deepEqual(await syncing, { checked: true, updated: true, active_admins: 2 }); remote.complete();
    const revoked = await revoking;
    assert.equal(revoked.aggregate_version, 4); assert.equal(revoked.access_synced_version, 3); assert.equal(revoked.access_state, 'pending_removal');
    assert.deepEqual(await states(), { [firstEmail]: 'ready', [secondEmail]: 'pending_removal', [revokedEmail]: 'revoked' });
    const retry = provider(updateSteps(policy(activeEmails), policy([firstEmail])));
    assert.deepEqual(await syncAdminAccess(pool, config, { fetcher: retry.fetcher }), { checked: true, updated: true, active_admins: 1 });
    retry.complete(); assert.equal((await states())[secondEmail], 'revoked');
  } finally { release.resolve(); await syncing; await revoking; }
});
