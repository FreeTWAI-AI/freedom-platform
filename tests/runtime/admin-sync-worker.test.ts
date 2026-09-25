import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { Pool } from 'pg';
import {
  ADMIN_SYNC_FAILURE, adminSyncShouldForce, createAdminSyncHandler, readAdminSyncConfig,
  type AdminSyncEnv, type ScheduledContext, type SyncContext,
} from '../../apps/platform-api/src/admin-sync-worker.js';
import worker from '../../apps/platform-api/src/admin-sync-worker.js';
import { syncAdminAccess } from '../../modules/platform-admin/access-sync.js';

const ACCOUNT = 'a'.repeat(32);
const APP = '00000000-0000-4000-8000-00000000000a';
const POLICY = '00000000-0000-4000-8000-00000000000b';
const DOMAIN = 'workshop.example.invalid/admin';
const TOKEN = 'synthetic-token-do-not-log';
const DSN = 'postgres://sync-user:pool-secret-do-not-log@10.1.2.3/freedom_secret';
const EMAIL = 'admin@example.invalid';
const ZERO = '0'.repeat(32);
const NIL = '00000000-0000-0000-0000-000000000000';

function env(overrides: Partial<AdminSyncEnv> = {}): AdminSyncEnv {
  return {
    HYPERDRIVE: { connectionString: DSN },
    CF_ACCOUNT_ID: ACCOUNT,
    FREEDOM_ADMIN_SYNC_APP_ID: APP,
    FREEDOM_ADMIN_SYNC_POLICY_ID: POLICY,
    FREEDOM_ADMIN_SYNC_DOMAIN: DOMAIN,
    CF_API_TOKEN: TOKEN,
    ...overrides,
  };
}
function tick(minute: number, second = 0): ScheduledContext {
  return { scheduledTime: Date.UTC(2026, 8, 25, 4, minute, second), cron: '* * * * *' };
}
function context() {
  const pending: Promise<unknown>[] = [];
  const ctx: SyncContext = { waitUntil(promise) { pending.push(promise); } };
  return { ctx, pending };
}
function endedPool(endError?: Error) {
  const state = { ended: 0 };
  const pool = {
    state,
    async connect() { throw new Error('unexpected connect ' + DSN); },
    async end() { state.ended += 1; if (endError) throw endError; },
  };
  return pool;
}
async function capture(run: () => Promise<unknown>) {
  const originalLog = console.log, originalError = console.error, logged: string[] = [];
  const record = (...args: unknown[]) => { logged.push(args.map(value => String(value)).join(' ')); };
  console.log = record; console.error = record;
  try { return { result: await run(), logged }; }
  finally { console.log = originalLog; console.error = originalError; }
}
function assertQuiet(logged: string[]) {
  const text = logged.join('\n');
  for (const secret of [TOKEN, DSN, EMAIL, 'pool-secret-do-not-log', 'synthetic-token']) assert.equal(text.includes(secret), false, text);
}

test('admin sync worker exports a scheduled handler and no fetch handler', () => {
  assert.deepEqual(Object.keys(worker), ['scheduled']);
  assert.equal('fetch' in worker, false);
  const source = readFileSync('apps/platform-api/src/admin-sync-worker.ts', 'utf8');
  assert.equal(/\bfetch\s*\(/.test(source), false);
  assert.equal(source.includes('process.env'), false);
});

test('missing or malformed configuration fails closed and does not open a pool', async () => {
  const cases: Array<[string, Partial<AdminSyncEnv>, RegExp]> = [
    ['no account', { CF_ACCOUNT_ID: undefined }, /^Missing CF_ACCOUNT_ID\.$/],
    ['blank account', { CF_ACCOUNT_ID: '' }, /^Missing CF_ACCOUNT_ID\.$/],
    ['zero account', { CF_ACCOUNT_ID: ZERO }, /^CF_ACCOUNT_ID is invalid\.$/],
    ['bad account', { CF_ACCOUNT_ID: TOKEN }, /^CF_ACCOUNT_ID is invalid\.$/],
    ['no app', { FREEDOM_ADMIN_SYNC_APP_ID: undefined }, /^Missing FREEDOM_ADMIN_SYNC_APP_ID\.$/],
    ['nil app', { FREEDOM_ADMIN_SYNC_APP_ID: NIL }, /^FREEDOM_ADMIN_SYNC_APP_ID is invalid\.$/],
    ['bad app', { FREEDOM_ADMIN_SYNC_APP_ID: 'not-a-uuid' }, /^FREEDOM_ADMIN_SYNC_APP_ID is invalid\.$/],
    ['no policy', { FREEDOM_ADMIN_SYNC_POLICY_ID: undefined }, /^Missing FREEDOM_ADMIN_SYNC_POLICY_ID\.$/],
    ['nil policy', { FREEDOM_ADMIN_SYNC_POLICY_ID: NIL.toUpperCase() }, /^FREEDOM_ADMIN_SYNC_POLICY_ID is invalid\.$/],
    ['no domain', { FREEDOM_ADMIN_SYNC_DOMAIN: undefined }, /^Missing FREEDOM_ADMIN_SYNC_DOMAIN\.$/],
    ['placeholder domain', { FREEDOM_ADMIN_SYNC_DOMAIN: 'REPLACE_BEFORE_DEPLOY' }, /^FREEDOM_ADMIN_SYNC_DOMAIN is invalid\.$/],
    ['domain carrying a token', { FREEDOM_ADMIN_SYNC_DOMAIN: `bad.example/${TOKEN}/admin` }, /^FREEDOM_ADMIN_SYNC_DOMAIN is invalid\.$/],
    ['no token', { CF_API_TOKEN: undefined }, /^Missing CF_API_TOKEN\.$/],
    ['blank token', { CF_API_TOKEN: '' }, /^Missing CF_API_TOKEN\.$/],
    ['spaced token', { CF_API_TOKEN: `${TOKEN} leaked` }, /^CF_API_TOKEN is invalid\.$/],
    ['no hyperdrive', { HYPERDRIVE: undefined }, /^Missing HYPERDRIVE\.$/],
    ['empty hyperdrive', { HYPERDRIVE: { connectionString: '   ' } }, /^Missing HYPERDRIVE\.$/],
  ];
  const previous = process.env.CF_API_TOKEN;
  process.env.CF_API_TOKEN = 'from-the-environment-do-not-use';
  try {
    for (const [label, override, expected] of cases) {
      let created = 0;
      const handler = createAdminSyncHandler({ createPool: () => { created += 1; throw new Error('pool created ' + DSN); } });
      const { ctx, pending } = context();
      const { logged } = await capture(async () => {
        await assert.rejects(handler.scheduled(tick(7), env(override), ctx), (error: Error) => {
          assert.match(error.message, expected, label);
          assertQuiet([error.message]);
          return true;
        });
      });
      assert.equal(created, 0, label);
      assert.equal(pending.length, 0, label);
      assertQuiet(logged);
      assert.equal(logged.length, 0, label);
    }
    assert.throws(() => readAdminSyncConfig({}), /Missing HYPERDRIVE\./);
  } finally {
    if (previous === undefined) delete process.env.CF_API_TOKEN;
    else process.env.CF_API_TOKEN = previous;
  }
});

test('a successful run calls sync with the configured ids and logs only the count', async () => {
  const pool = endedPool();
  let seen: { config: unknown; force: boolean | undefined; fetcher: unknown } | undefined;
  const handler = createAdminSyncHandler({
    createPool: () => pool as unknown as Pool,
    fetcher: async () => { throw new Error('injected sync must not fetch ' + TOKEN); },
    sync: async (_pool, config, options = {}) => {
      seen = { config, force: options.force, fetcher: options.fetcher };
      return { checked: true, updated: false, active_admins: 2, email: EMAIL, token: TOKEN } as Awaited<ReturnType<typeof syncAdminAccess>>;
    },
  });
  const { ctx, pending } = context();
  const { logged } = await capture(() => handler.scheduled(tick(16), env(), ctx));
  assert.deepEqual(seen?.config, { accountId: ACCOUNT, appId: APP, policyId: POLICY, domain: DOMAIN, token: TOKEN });
  assert.equal(seen?.force, false);
  assert.equal(typeof seen?.fetcher, 'function');
  assert.deepEqual(logged, ['{"checked":true,"updated":false,"active_admins":2}']);
  assertQuiet(logged);
  assert.equal(pool.state.ended, 1);
  assert.equal(pending.length, 1);
  await Promise.all(pending);
});

test('force follows the scheduled UTC minute and a missing time still forces', () => {
  for (let minute = 0; minute < 60; minute += 1) {
    assert.equal(adminSyncShouldForce(Date.UTC(2026, 8, 25, 4, minute, 30)), minute % 15 === 0, String(minute));
  }
  assert.equal(adminSyncShouldForce(new Date(Date.UTC(2026, 8, 25, 4, 45, 59))), true);
  assert.equal(adminSyncShouldForce(new Date(Date.UTC(2026, 8, 25, 4, 46, 0))), false);
  const quarter = Math.floor(Date.UTC(2026, 8, 25, 4, 15, 0) / 1000);
  const ordinary = Math.floor(Date.UTC(2026, 8, 25, 4, 7, 0) / 1000);
  assert.equal(adminSyncShouldForce(quarter), true);
  assert.equal(adminSyncShouldForce(ordinary), false);
  assert.equal(adminSyncShouldForce(undefined), true);
  assert.equal(adminSyncShouldForce(Number.NaN), true);
  assert.equal(adminSyncShouldForce(Number.POSITIVE_INFINITY), true);
});

test('the handler forces on the scheduled cadence and not on other minutes', async () => {
  for (const [minute, expected] of [[0, true], [14, false], [15, true], [59, false]] as const) {
    let force: boolean | undefined;
    const pool = endedPool();
    const handler = createAdminSyncHandler({
      createPool: () => pool as unknown as Pool,
      sync: async (_pool, _config, options) => { force = options?.force; return { checked: false, updated: false, active_admins: 1 }; },
    });
    const { ctx } = context();
    const { logged } = await capture(() => handler.scheduled(tick(minute), env(), ctx));
    assert.equal(force, expected, String(minute));
    assert.deepEqual(logged, []);
    assert.equal(pool.state.ended, 1);
  }
  let missing: boolean | undefined;
  const pool = endedPool();
  const handler = createAdminSyncHandler({
    createPool: () => pool as unknown as Pool,
    sync: async (_pool, _config, options) => { missing = options?.force; return { checked: false, updated: false, active_admins: 0 }; },
  });
  await handler.scheduled({ cron: '* * * * *' }, env(), context().ctx);
  assert.equal(missing, true);
  assert.equal(pool.state.ended, 1);
});

test('a quiet minute does not call the provider or mark revisions', async () => {
  const queries: string[] = [];
  const pool = scriptedPool(queries, { pending: false });
  let fetched = 0;
  const handler = createAdminSyncHandler({
    createPool: () => pool as unknown as Pool,
    fetcher: async () => { fetched += 1; throw new Error('unexpected fetch ' + TOKEN); },
  });
  const { ctx, pending } = context();
  const { logged } = await capture(() => handler.scheduled(tick(7), env(), ctx));
  assert.equal(fetched, 0);
  assert.deepEqual(logged, []);
  assert.equal(queries.some(sql => sql.startsWith('UPDATE')), false);
  assert.equal(queries.includes('COMMIT'), true);
  assert.equal(pool.state.ended, 1);
  await Promise.all(pending);
});

test('a sync failure is thrown, the pool is released, and nothing sensitive is logged', async () => {
  const queries: string[] = [];
  const pool = scriptedPool(queries, { pending: true });
  const calls: string[] = [];
  const handler = createAdminSyncHandler({
    createPool: () => pool as unknown as Pool,
    fetcher: async (input, init) => {
      calls.push(String(input));
      assert.equal(new Headers(init?.headers).get('Authorization'), `Bearer ${TOKEN}`);
      throw new Error(`provider payload ${TOKEN} ${DSN} ${EMAIL} ${String(input)}`);
    },
  });
  const { ctx, pending } = context();
  const { logged } = await capture(async () => {
    await assert.rejects(handler.scheduled(tick(7), env(), ctx), (error: Error) => {
      assert.equal(error.message, ADMIN_SYNC_FAILURE);
      assert.equal(error.cause, undefined);
      return true;
    });
  });
  assert.deepEqual(calls, [`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/access/apps/${APP}`]);
  assert.equal(queries.some(sql => sql.startsWith('UPDATE')), false);
  assert.equal(queries.includes('ROLLBACK'), true);
  assert.equal(pool.state.ended, 1);
  assert.deepEqual(logged, ['admin_sync_failed Error']);
  assertQuiet(logged);
  await Promise.all(pending);
});

test('pool release still happens when ending the pool fails, without logging the connection string', async () => {
  const pool = endedPool(new Error('end failed ' + DSN));
  const handler = createAdminSyncHandler({
    createPool: () => pool as unknown as Pool,
    sync: async () => { throw new Error('sync failed ' + TOKEN + ' ' + EMAIL); },
  });
  const { ctx, pending } = context();
  const { logged } = await capture(async () => {
    await assert.rejects(handler.scheduled(tick(30), env(), ctx), (error: Error) => {
      assert.equal(error.message, ADMIN_SYNC_FAILURE);
      return true;
    });
  });
  assert.equal(pool.state.ended, 1);
  assert.deepEqual(logged, ['admin_sync_failed Error', 'pool_end_failed']);
  assertQuiet(logged);
  await Promise.all(pending);
});

test('the admin-sync wrangler file is cron-only, placeholder-only, and separate from the platform Worker', () => {
  const text = readFileSync('wrangler.admin-sync.jsonc', 'utf8');
  const platform = readFileSync('wrangler.jsonc', 'utf8');
  assert.match(text, /"main": "apps\/platform-api\/src\/admin-sync-worker.ts"/);
  assert.match(platform, /"main": "apps\/platform-api\/src\/worker.ts"/);
  assert.equal(platform.includes('"crons"'), false);
  assert.equal(text.includes('"routes"'), false);
  assert.equal(text.includes('"assets"'), false);
  assert.equal(text.includes('"images"'), false);
  assert.equal((text.match(/"workers_dev": false/g) ?? []).length, 3);
  assert.equal((text.match(/"preview_urls": false/g) ?? []).length, 3);
  assert.equal((text.match(/"crons": \["\* \* \* \* \*"\]/g) ?? []).length, 3);
  assert.equal((text.match(/"binding": "HYPERDRIVE", "id": "00000000000000000000000000000000"/g) ?? []).length, 3);
  assert.match(text, /"name": "freedom-admin-sync-next"/);
  assert.match(text, /"name": "freedom-admin-sync-staging-next"/);
  for (const name of ['CF_ACCOUNT_ID', 'FREEDOM_ADMIN_SYNC_APP_ID', 'FREEDOM_ADMIN_SYNC_POLICY_ID', 'FREEDOM_ADMIN_SYNC_DOMAIN']) {
    assert.equal((text.match(new RegExp(`"${name}":`, 'g')) ?? []).length, 3, name);
  }
  assert.equal((text.match(/"CF_ACCOUNT_ID": "00000000000000000000000000000000"/g) ?? []).length, 3);
  assert.equal((text.match(/"FREEDOM_ADMIN_SYNC_APP_ID": "00000000-0000-0000-0000-000000000000"/g) ?? []).length, 3);
  assert.equal((text.match(/"FREEDOM_ADMIN_SYNC_POLICY_ID": "00000000-0000-0000-0000-000000000000"/g) ?? []).length, 3);
  assert.equal((text.match(/"FREEDOM_ADMIN_SYNC_DOMAIN": "REPLACE_BEFORE_DEPLOY"/g) ?? []).length, 3);
  assert.equal(text.includes('CF_API_TOKEN'), true);
  assert.equal(/"CF_API_TOKEN"\s*:/.test(text), false);
  assert.equal(text.includes('postgres://'), false);
  assert.equal(text.includes('Bearer '), false);
  assert.equal(text.includes('@'), false);
  const hex = text.match(/[0-9a-f]{32}/g) ?? [];
  assert.ok(hex.length >= 3 && hex.every(id => /^0+$/.test(id)));
  assert.match(text, /npm run worker:dry-run checks wrangler\.jsonc only/);
  assert.match(text, /npm run worker:dry-run:admin-sync/);
  assert.match(platform, /does not check wrangler\.admin-sync\.jsonc/);
  const scripts = JSON.parse(readFileSync('package.json', 'utf8')).scripts as Record<string, string>;
  assert.equal(scripts['worker:dry-run'].includes('wrangler.admin-sync.jsonc'), false);
  assert.equal(scripts['worker:dry-run:admin-sync'], [
    'wrangler deploy --dry-run --config wrangler.admin-sync.jsonc --env "" --outdir .wrangler/dry-run/admin-sync-local',
    'wrangler deploy --dry-run --config wrangler.admin-sync.jsonc --env staging-next --outdir .wrangler/dry-run/admin-sync-staging-next',
    'wrangler deploy --dry-run --config wrangler.admin-sync.jsonc --env next --outdir .wrangler/dry-run/admin-sync-next',
  ].join(' && '));
  assert.match(readFileSync('deploy/cloudflare/preflight.mjs', 'utf8'), /Does not validate wrangler\.admin-sync\.jsonc/);
  assert.match(readFileSync('deploy/cloudflare/lib/wrangler.mjs', 'utf8'), /does not validate wrangler\.admin-sync\.jsonc/);
});

function scriptedPool(queries: string[], facts: { pending: boolean }) {
  const state = { ended: 0 };
  const client = {
    async query(sql: string) {
      queries.push(sql);
      if (sql.startsWith('UPDATE')) throw new Error('revisions marked from the test pool');
      if (sql === 'BEGIN' || sql.startsWith('SET ') || sql.startsWith('SELECT pg_advisory') || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [], rowCount: 0 };
      if (sql.includes('FROM communities')) return { rows: [{ community_id: '00000000-0000-4000-8000-0000000000c1' }], rowCount: 1 };
      if (sql.includes('FROM platform_admins')) {
        return { rows: [{ admin_id: '00000000-0000-4000-8000-0000000000a1', email: EMAIL, active: true, aggregate_version: '2', access_synced_version: facts.pending ? null : '2' }], rowCount: 1 };
      }
      throw new Error('unexpected sql');
    },
    release() { queries.push('release'); },
  };
  return { state, async connect() { queries.push('connect'); return client; }, async end() { state.ended += 1; } };
}
