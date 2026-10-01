import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {Pool} from 'pg';
import {createWorkerHandler, type WorkerEnv} from '../../apps/platform-api/src/worker.js';
import {GITHUB_SYNC_REQUEST_BUDGET, type GitHubSyncOptions, type GitHubSyncSummary} from '../../modules/community/github-sync.js';

const TOKEN = 'synthetic-metrics-token';
const empty: GitHubSyncSummary = {requests: 0, repositories: 0, items_upserted: 0, not_modified: 0, stop_reason: 'completed'};

function env(): WorkerEnv {
  return {HYPERDRIVE: {connectionString: 'postgres://unused'}, ASSETS: {fetch: async () => new Response(null)}, GITHUB_METRICS_TOKEN: TOKEN} as WorkerEnv;
}
function context() {
  const pending: Promise<unknown>[] = [];
  return {pending, ctx: {waitUntil(promise: Promise<unknown>) { pending.push(promise); }}};
}
async function capture(run: () => Promise<void>) {
  const logged: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
  try { await run(); } finally { console.error = original; }
  return logged;
}

test('the platform worker exposes scheduled and runs one bounded sync for events, repositories and metrics', async () => {
  const pool = {ended: 0, async end() { this.ended += 1; }};
  let seen: {budget?: number; token?: string; pool?: unknown} = {};
  const handler = createWorkerHandler({
    createPool: () => pool as unknown as Pool,
    syncGitHub: async (given, options?: GitHubSyncOptions) => {
      seen = {budget: options?.budget, token: options?.token, pool: given};
      return empty;
    },
  });
  assert.equal(typeof handler.fetch, 'function');
  assert.equal(typeof handler.scheduled, 'function');
  const {ctx, pending} = context();
  await handler.scheduled({cron: '*/10 * * * *', scheduledTime: Date.now()}, env(), ctx);
  assert.equal(seen.budget, GITHUB_SYNC_REQUEST_BUDGET);
  assert.equal(GITHUB_SYNC_REQUEST_BUDGET, 40);
  assert.equal(seen.token, TOKEN);
  assert.equal(seen.pool, pool);
  assert.equal(pool.ended, 1);
  assert.equal(pending.length, 1);
  await Promise.all(pending);
});

test('a scheduled sync failure is logged without the token and still ends the pool', async () => {
  const pool = {ended: 0, async end() { this.ended += 1; }};
  const handler = createWorkerHandler({
    createPool: () => pool as unknown as Pool,
    syncGitHub: async () => { throw new Error('sync failed ' + TOKEN); },
  });
  const {ctx, pending} = context();
  const logged = await capture(async () => {
    await handler.scheduled({cron: '*/10 * * * *'}, env(), ctx);
  });
  assert.deepEqual(logged, ['github_sync_failed Error']);
  assert.equal(logged.join(' ').includes(TOKEN), false);
  assert.equal(pool.ended, 1);
  await Promise.all(pending);
});

test('a pool factory failure is logged by name and does not end a pool', async () => {
  let ended = 0;
  const handler = createWorkerHandler({
    createPool: () => { throw new Error('postgres://user:secret@127.0.0.1/freedom_local'); },
    syncGitHub: async () => { ended += 1; return empty; },
  });
  const {ctx, pending} = context();
  const logged = await capture(async () => {
    await handler.scheduled({cron: '*/10 * * * *'}, env(), ctx);
  });
  assert.deepEqual(logged, ['github_sync_failed Error']);
  assert.equal(logged.join(' ').includes('postgres://'), false);
  assert.equal(logged.join(' ').includes('secret'), false);
  assert.equal(ended, 0);
  await Promise.all(pending);
});
