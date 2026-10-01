import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { Pool } from 'pg';
import {
  MAINTAINER_TICK_FAILURE, createMaintainerHandler, readMaintainerConfig,
  type MaintainerEnv, type ScheduledContext, type SyncContext,
} from '../../apps/platform-api/src/maintainer-worker.js';
import worker from '../../apps/platform-api/src/maintainer-worker.js';
import type { MaintainerSummary } from '../../modules/repo-maintainer/tick.js';

const DSN = 'postgres://sync-user:pool-secret-do-not-log@10.1.2.3/freedom_secret';
const KEY = '-----BEGIN PRIVATE KEY-----\nSECRETKEYMATERIAL\n-----END PRIVATE KEY-----\n';
const ZERO = '0'.repeat(32);
const empty: MaintainerSummary = {
  deliveries_deleted: 0, jobs_deleted: 0, rederived: 0, ignored_accounts: 0, repositories_upserted: 0, repositories_removed: 0,
  sweeps: 0, jobs_done: 0, jobs_failed: 0, jobs_released: 0, github_requests: 0, stopped: null,
};

function env(overrides: Partial<MaintainerEnv> = {}): MaintainerEnv {
  return { HYPERDRIVE: { connectionString: DSN }, GITHUB_MAINTAINER_APP_ID: '12345', GITHUB_MAINTAINER_ORG: 'FreeTWAI-AI', GITHUB_MAINTAINER_PRIVATE_KEY: KEY, ...overrides };
}
function tick(): ScheduledContext {
  return { scheduledTime: Date.UTC(2026, 8, 30, 4, 0, 0), cron: '* * * * *' };
}
function context() {
  const pending: Promise<unknown>[] = [];
  const ctx: SyncContext = { waitUntil(promise) { pending.push(promise); } };
  return { ctx, pending };
}
function endedPool(endError?: Error) {
  const state = { ended: 0 };
  return { state, async end() { state.ended += 1; if (endError) throw endError; } } as unknown as Pool & { state: { ended: number } };
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
  assert.equal(text.includes(DSN), false, text);
  assert.equal(text.includes('SECRETKEYMATERIAL'), false, text);
  assert.equal(text.includes('pool-secret-do-not-log'), false, text);
}

test('the maintainer worker exports scheduled and no fetch handler', () => {
  assert.deepEqual(Object.keys(worker), ['scheduled']);
  assert.equal('fetch' in worker, false);
  const source = readFileSync('apps/platform-api/src/maintainer-worker.ts', 'utf8');
  assert.equal(/\bfetch\s*\(/.test(source), false);
  assert.equal(source.includes('process.env'), false);
});

function rejects(run: () => unknown, pattern: RegExp) {
  assert.throws(run, (error: Error) => { assert.match(error.message, pattern); return true; });
}
test('configuration names the setting, rejects the placeholder and a PKCS#1 key, and accepts literal newlines', () => {
  rejects(() => readMaintainerConfig(env({ GITHUB_MAINTAINER_APP_ID: '0' })), /^GITHUB_MAINTAINER_APP_ID is invalid\.$/);
  rejects(() => readMaintainerConfig(env({ GITHUB_MAINTAINER_APP_ID: undefined })), /^Missing GITHUB_MAINTAINER_APP_ID\.$/);
  rejects(() => readMaintainerConfig(env({ GITHUB_MAINTAINER_PRIVATE_KEY: undefined })), /^Missing GITHUB_MAINTAINER_PRIVATE_KEY\.$/);
  rejects(() => readMaintainerConfig(env({ GITHUB_MAINTAINER_PRIVATE_KEY: '' })), /^Missing GITHUB_MAINTAINER_PRIVATE_KEY\.$/);
  rejects(() => readMaintainerConfig(env({ HYPERDRIVE: undefined })), /^Missing HYPERDRIVE\.$/);
  rejects(() => readMaintainerConfig(env({ GITHUB_MAINTAINER_ORG: 'not a login' })), /^GITHUB_MAINTAINER_ORG is invalid\.$/);
  rejects(
    () => readMaintainerConfig(env({ GITHUB_MAINTAINER_PRIVATE_KEY: '-----BEGIN RSA PRIVATE KEY-----\nMIIB\n-----END RSA PRIVATE KEY-----\n' })),
    /^GITHUB_MAINTAINER_PRIVATE_KEY is PKCS#1\. Convert it with openssl pkcs8 -topk8 -nocrypt\.$/,
  );
  const converted = readMaintainerConfig(env({ GITHUB_MAINTAINER_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\\nMIIB\\n-----END PRIVATE KEY-----' }));
  assert.equal(converted.privateKey.includes('\n'), true);
  assert.equal(converted.privateKey.includes('\\n'), false);
  assert.equal(converted.appId, '12345');
  assert.equal(converted.organization, 'FreeTWAI-AI');
  assert.equal(JSON.stringify(converted).includes(DSN), false);
});

test('a bad configuration does not open a pool or get wrapped', async () => {
  let created = 0;
  const handler = createMaintainerHandler({ createPool: () => { created += 1; throw new Error(DSN); } });
  const { ctx, pending } = context();
  const { logged } = await capture(async () => {
    await assert.rejects(handler.scheduled(tick(), env({ GITHUB_MAINTAINER_APP_ID: '0' }), ctx), (error: Error) => {
      assert.match(error.message, /^GITHUB_MAINTAINER_APP_ID is invalid\.$/);
      assert.notEqual(error.message, MAINTAINER_TICK_FAILURE);
      return true;
    });
  });
  assert.equal(created, 0);
  assert.equal(logged.length, 0);
  assert.equal(pending.length, 0);
});

test('the pool always ends and a tick failure throws the fixed message without the secret', async () => {
  const pool = endedPool();
  const handler = createMaintainerHandler({
    createPool: () => pool,
    run: async () => { throw new Error('sync failed ' + KEY + ' ' + DSN); },
  });
  const { ctx, pending } = context();
  const { logged } = await capture(async () => {
    await assert.rejects(handler.scheduled(tick(), env(), ctx), (error: Error) => {
      assert.equal(error.message, MAINTAINER_TICK_FAILURE);
      assert.equal(error.cause, undefined);
      return true;
    });
  });
  assert.equal(pool.state.ended, 1);
  assert.deepEqual(logged, ['maintainer_tick_failed Error']);
  assertQuiet(logged);
  await Promise.all(pending);

  const ending = endedPool(new Error('end failed ' + DSN));
  const both = createMaintainerHandler({ createPool: () => ending, run: async () => { throw new Error('again ' + KEY); } });
  const second = context();
  const captured = await capture(async () => {
    await assert.rejects(both.scheduled(tick(), env(), second.ctx), (error: Error) => error.message === MAINTAINER_TICK_FAILURE);
  });
  assert.equal(ending.state.ended, 1);
  assert.deepEqual(captured.logged, ['maintainer_tick_failed Error', 'pool_end_failed']);
  assertQuiet(captured.logged);

  let ended = 0;
  const factory = createMaintainerHandler({ createPool: () => { ended += 1; throw new Error(DSN); } });
  const third = context();
  const factoryLog = await capture(async () => {
    await assert.rejects(factory.scheduled(tick(), env(), third.ctx), (error: Error) => error.message === MAINTAINER_TICK_FAILURE);
  });
  assert.equal(ended, 1);
  assert.deepEqual(factoryLog.logged, ['maintainer_tick_failed Error']);
  assertQuiet(factoryLog.logged);
});

test('a successful tick logs counts only', async () => {
  const pool = endedPool();
  let seenKey = '';
  const handler = createMaintainerHandler({
    createPool: () => pool,
    run: async (_pool, seen) => { seenKey = seen.privateKey; return { ...empty, sweeps: 2, github_requests: 4 }; },
  });
  const { ctx, pending } = context();
  const { logged } = await capture(async () => { await handler.scheduled(tick(), env(), ctx); });
  assert.equal(seenKey, KEY);
  assert.equal(pool.state.ended, 1);
  assert.equal(logged.length, 1);
  assert.deepEqual(JSON.parse(logged[0]), { ...empty, sweeps: 2, github_requests: 4 });
  assertQuiet(logged);
  await Promise.all(pending);
});

test('the maintainer wrangler file is cron-only and separate from the platform Worker', () => {
  const text = readFileSync('wrangler.maintainer.jsonc', 'utf8');
  const platform = readFileSync('wrangler.jsonc', 'utf8');
  assert.match(text, /"main": "apps\/platform-api\/src\/maintainer-worker.ts"/);
  assert.equal(text.includes('"routes"'), false);
  assert.equal(text.includes('"assets"'), false);
  assert.equal(text.includes('"images"'), false);
  assert.equal((text.match(/"workers_dev": false/g) ?? []).length, 3);
  assert.equal((text.match(/"preview_urls": false/g) ?? []).length, 3);
  assert.equal((text.match(/"crons": \["\* \* \* \* \*"\]/g) ?? []).length, 3);
  assert.equal((text.match(/"binding": "HYPERDRIVE", "id": "00000000000000000000000000000000"/g) ?? []).length, 3);
  assert.match(text, /"name": "freedom-maintainer-local"/);
  assert.match(text, /"name": "freedom-maintainer-staging-next"/);
  assert.match(text, /"name": "freedom-maintainer-next"/);
  assert.equal((text.match(/"GITHUB_MAINTAINER_APP_ID": "0"/g) ?? []).length, 3);
  assert.equal((text.match(/"GITHUB_MAINTAINER_ORG": "FreeTWAI-AI"/g) ?? []).length, 3);
  assert.equal(text.includes('GITHUB_MAINTAINER_PRIVATE_KEY'), true);
  assert.equal(/"GITHUB_MAINTAINER_PRIVATE_KEY"\s*:/.test(text), false);
  assert.match(text, /openssl pkcs8 -topk8 -nocrypt/);
  assert.equal(text.includes('postgres://'), false);
  assert.equal(text.includes('@'), false);
  const hex = text.match(/[0-9a-f]{32}/g) ?? [];
  assert.ok(hex.length >= 3 && hex.every(id => /^0+$/.test(id)));
  assert.match(platform, /does not check wrangler\.admin-sync\.jsonc/);
  assert.match(platform, /wrangler\.maintainer\.jsonc/);
  const scripts = JSON.parse(readFileSync('package.json', 'utf8')).scripts as Record<string, string>;
  assert.equal(scripts['worker:dry-run'].includes('wrangler.maintainer.jsonc'), false);
  assert.equal(scripts['worker:dry-run:maintainer'], [
    'wrangler deploy --dry-run --config wrangler.maintainer.jsonc --env "" --outdir .wrangler/dry-run/maintainer-local',
    'wrangler deploy --dry-run --config wrangler.maintainer.jsonc --env staging-next --outdir .wrangler/dry-run/maintainer-staging-next',
    'wrangler deploy --dry-run --config wrangler.maintainer.jsonc --env next --outdir .wrangler/dry-run/maintainer-next',
  ].join(' && '));
  assert.match(readFileSync('.github/workflows/verify.yml', 'utf8'), /npm run worker:dry-run:maintainer/);
  assert.match(readFileSync('deploy/cloudflare/preflight.mjs', 'utf8'), /Does not validate wrangler\.admin-sync\.jsonc/);
  assert.match(readFileSync('deploy/cloudflare/lib/wrangler.mjs', 'utf8'), /does not validate wrangler\.admin-sync\.jsonc/);
  assert.equal(ZERO.length, 32);
});
