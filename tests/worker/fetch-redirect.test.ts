// Guards the dry-run bundles and the admin-sync scheduled handler in workerd.
// Build first:
//   npm run worker:dry-run
//   npm run worker:dry-run:admin-sync
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { Pool } from 'pg';
import { createPool, LOCAL_DATABASE_URL } from '../../packages/db/index.js';
import { migrate } from '../../scripts/database.js';

const REDIRECT_ERROR = /['"`]?redirect['"`]?\s*:\s*['"`]error['"`]/;
const bundles = [
  '.wrangler/dry-run/local/worker.js',
  '.wrangler/dry-run/staging-next/worker.js',
  '.wrangler/dry-run/next/worker.js',
  '.wrangler/dry-run/admin-sync-local/admin-sync-worker.js',
  '.wrangler/dry-run/admin-sync-staging-next/admin-sync-worker.js',
  '.wrangler/dry-run/admin-sync-next/admin-sync-worker.js',
];
const accountId = 'a'.repeat(32);
const appId = '11111111-1111-4111-8111-111111111111';
const policyId = '22222222-2222-4222-8222-222222222222';
const domain = 'workshop.example.invalid/admin';
const email = 'sync-admin@example.invalid';
const policyName = 'Nominated Freedom super administrators';
const appPath = `/client/v4/accounts/${accountId}/access/apps/${appId}`;
const compatibilityDate = '2026-09-21';

function policy(address: string) {
  return { id: policyId, name: policyName, decision: 'allow', include: [{ email: { email: address } }], require: [], exclude: [] };
}

test('dry-run bundles do not pass redirect "error" to fetch', async () => {
  for (const sample of [`redirect:'error'`, `redirect: "error"`, `"redirect":"error"`, `'redirect': 'error'`, 'redirect:\n"error"', 'redirect: `error`']) {
    assert.match(sample, REDIRECT_ERROR, sample);
  }
  assert.doesNotMatch(`redirect:'manual'`, REDIRECT_ERROR);
  assert.doesNotMatch(`redirect: "manual"`, REDIRECT_ERROR);
  assert.doesNotMatch(`redirectUri:"error"`, REDIRECT_ERROR);
  for (const bundle of bundles) {
    const source = await readFile(resolve(bundle), 'utf8');
    assert.equal(REDIRECT_ERROR.test(source), false, bundle);
    assert.match(source, /redirect\s*:\s*['"`]manual['"`]/, bundle);
  }
});

test('workerd admin-sync forced run rejects a redirect without following it, then reaches read-back', async () => {
  const serverUrl = new URL(process.env.TEST_DATABASE_URL ?? LOCAL_DATABASE_URL);
  const database = `fp_sync_wd_${process.pid}_${Date.now()}`;
  const databaseUrl = Object.assign(new URL(serverUrl), { pathname: '/' + database }).href;
  const server = createPool(serverUrl.href);
  const calls: string[] = [];
  let mode: 'redirect' | 'allow' = 'redirect';
  let mf: Miniflare | undefined, db: Pool | undefined;
  try {
    await server.query(`CREATE DATABASE ${database}`);
    db = new Pool({ connectionString: databaseUrl, max: 2 });
    await migrate(db);
    await db.query('INSERT INTO communities(community_id,name) VALUES($1,$2)', [randomUUID(), 'Workerd admin sync']);
    await db.query('INSERT INTO platform_admins(admin_id,community_id,email,display_name) VALUES($1,(SELECT community_id FROM communities),$2,$3)', [randomUUID(), email, 'Sync Admin']);
    // The dry-run entry exports a string constant, which workerd rejects as a handler,
    // and Miniflare does not finish startup when scheduled is the only handler.
    // This entry delegates to that bundle and adds no product route.
    const bundle = (await readFile(resolve('.wrangler/dry-run/admin-sync-local/admin-sync-worker.js'), 'utf8')).replace(/\n\/\/# sourceMappingURL=.*\n?$/, '\n');
    const entry = `import worker from './admin-sync-worker.js';\nexport default { fetch: () => new Response(null, { status: 404 }), scheduled: (controller, env, ctx) => worker.scheduled(controller, env, ctx) };\n`;
    mf = new Miniflare(convertV4MiniflareOptions({ workers: [{
      name: 'freedom-admin-sync-workerd-test',
      modules: [
        { type: 'ESModule', path: 'entry.js', contents: entry },
        { type: 'ESModule', path: 'admin-sync-worker.js', contents: bundle },
      ],
      compatibilityDate, compatibilityFlags: ['nodejs_compat'],
      bindings: {
        CF_ACCOUNT_ID: accountId, FREEDOM_ADMIN_SYNC_APP_ID: appId, FREEDOM_ADMIN_SYNC_POLICY_ID: policyId,
        FREEDOM_ADMIN_SYNC_DOMAIN: domain, CF_API_TOKEN: 'synthetic-admin-sync-token',
      },
      hyperdrives: { HYPERDRIVE: databaseUrl },
      outboundService: async (request: Request) => {
        const url = new URL(request.url);
        calls.push(`${request.method} ${url.pathname}${url.search}`);
        if (mode === 'redirect') return new Response(null, { status: 302, headers: { Location: 'https://evil.example/followed' } });
        let result: unknown = null;
        if (request.method === 'GET' && url.pathname === appPath) result = { id: appId, domain, type: 'self_hosted' };
        else if (request.method === 'GET' && url.pathname === `${appPath}/policies`) result = [policy('stale@example.invalid')];
        else if (url.pathname === `${appPath}/policies/${policyId}`) result = policy(email);
        return result === null ? Response.json({ success: false }, { status: 500 }) : Response.json({ success: true, result });
      },
    }] }));
    await mf.ready;
    const worker = await mf.getWorker() as { scheduled(options?: { scheduledTime?: Date; cron?: string }): Promise<{ outcome: string }> };
    const invoke = (minute: number) => worker.scheduled({ scheduledTime: new Date(Date.UTC(2026, 8, 25, 4, minute, 0)), cron: '* * * * *' });
    assert.equal((await invoke(0)).outcome, 'exception');
    assert.deepEqual(calls, [`GET ${appPath}`]);
    assert.equal((await db.query('SELECT access_synced_version FROM platform_admins')).rows[0].access_synced_version, null);
    mode = 'allow'; calls.length = 0;
    assert.equal((await invoke(15)).outcome, 'ok');
    assert.deepEqual(calls, [
      `GET ${appPath}`,
      `GET ${appPath}/policies?per_page=100`,
      `PUT ${appPath}/policies/${policyId}`,
      `GET ${appPath}/policies/${policyId}`,
    ]);
    const row = (await db.query('SELECT aggregate_version::text AS aggregate_version, access_synced_version::text AS access_synced_version FROM platform_admins')).rows[0];
    assert.equal(row.access_synced_version, row.aggregate_version);
  } finally {
    await mf?.dispose().catch(() => undefined); await db?.end().catch(() => undefined);
    try { await server.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`); }
    finally { await server.end(); }
  }
});
