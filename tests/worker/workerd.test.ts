// Runs the Wrangler dry-run bundle in local workerd (Miniflare) against a throwaway
// PostgreSQL database through the local Hyperdrive binding. Build first:
//   npm run worker:dry-run   (bundle from wrangler.jsonc into .wrangler/dry-run/local)
// FREEDOM_WORKERD_BUNDLE_DIR may point at another dry-run output directory.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { Pool } from 'pg';
import { createPool, LOCAL_DATABASE_URL } from '../../packages/db/index.js';
import { migrate } from '../../scripts/database.js';
import { seedLocal, DEMO_USERS } from '../../packages/testing/seed.js';
import { tokenHash } from '../../modules/identity-membership/service.js';

const bundleDir = resolve(process.env.FREEDOM_WORKERD_BUNDLE_DIR ?? '.wrangler/dry-run/local');
const assetsDir = resolve(`.wrangler/test-assets-${process.pid}`);
const serverUrl = new URL(process.env.TEST_DATABASE_URL ?? LOCAL_DATABASE_URL);
const database = `fp_workerd_${process.pid}_${Date.now()}`;
const databaseUrl = Object.assign(new URL(serverUrl), { pathname: '/' + database }).href;
const origin = 'http://127.0.0.1:8787';
const SHELL = '<!doctype html><title>workerd shell</title>';
// workerd 1.20260921 supports dates up to its build; production config pins 2026-09-24.
const compatibilityDate = process.env.FREEDOM_WORKERD_COMPAT_DATE ?? '2026-09-21';

const server = createPool(serverUrl.href);
let mf: Miniflare, db: Pool;
before(async () => {
  await mkdir(resolve(assetsDir, 'assets'), { recursive: true });
  await writeFile(resolve(assetsDir, 'index.html'), SHELL);
  await writeFile(resolve(assetsDir, 'assets/app.js'), 'console.log("asset")');
  await server.query(`CREATE DATABASE ${database}`);
  db = new Pool({ connectionString: databaseUrl, max: 2 });
  await migrate(db); await seedLocal(db);
  mf = new Miniflare(convertV4MiniflareOptions({ workers: [{
    name: 'freedom-platform-workerd-test', modules: true, scriptPath: resolve(bundleDir, 'worker.js'),
    compatibilityDate, compatibilityFlags: ['nodejs_compat'],
    bindings: { FREEDOM_ENV: 'local', APP_ORIGIN: origin },
    hyperdrives: { HYPERDRIVE: databaseUrl },
    assets: { directory: assetsDir, binding: 'ASSETS', routerConfig: { has_user_worker: true, invoke_user_worker_ahead_of_assets: true }, assetConfig: { html_handling: 'auto-trailing-slash', not_found_handling: 'none' } },
  }] }));
  await mf.ready;
});
after(async () => {
  // Each step runs even if workerd failed to start or an earlier step threw.
  await mf?.dispose().catch(() => undefined); await db?.end().catch(() => undefined);
  try { await server.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`); }
  finally { await server.end(); await rm(assetsDir, { recursive: true, force: true }); }
});
const call = (path: string, init?: RequestInit) => mf.dispatchFetch(origin + path, init as any) as unknown as Promise<Response>;

test('bundle starts in workerd and answers health with runtime metadata only', async () => {
  const response = await call('/api/v1/health');
  assert.equal(response.status, 200);
  const data: any = await response.json();
  assert.equal(data.runtime, 'cloudflare-workers'); assert.equal(data.mode, 'local'); assert.equal(data.release_sha, null);
  assert.ok(!JSON.stringify(data).includes(database));
});

test('workerd: strict host, JSON 404 for machine paths, assets with security headers', async () => {
  const other = await mf.dispatchFetch('http://localhost:8787/api/v1/health');
  assert.equal(other.status, 403);
  for (const path of ['/api/unknown', '/client-api/other', '/agent-api/x', '/development-agent/x']) {
    const response = await call(path);
    assert.match(response.headers.get('content-type') ?? '', /application\/json/, path);
    assert.ok(!(await response.text()).includes(SHELL), path);
  }
  const asset = await call('/assets/app.js');
  assert.equal(asset.status, 200); assert.equal(await asset.text(), 'console.log("asset")');
  assert.equal(asset.headers.get('cache-control'), 'no-store');
  assert.match(asset.headers.get('content-security-policy') ?? '', /default-src 'self'/);
  for (const path of ['/', '/guilds']) {
    const shell = await call(path);
    assert.equal(shell.status, 200, path); assert.equal(await shell.text(), SHELL);
  }
});

test('workerd: embedded Markdown and CSS match their canonical sources', async () => {
  assert.equal(await (await call('/development/skill-upload/SKILL.md')).text(), await readFile('packages/skill-upload-client/SKILL.md', 'utf8'));
  assert.equal(await (await call('/development/skill-upload/protocol.md')).text(), await readFile('packages/skill-upload-client/protocol.md', 'utf8'));
  assert.ok((await (await call('/development.css')).text()).endsWith(await readFile('apps/portal-web/src/modules/GitHubSocial.css', 'utf8')));
});

test('workerd: pg over local Hyperdrive reads data and spoofed client headers share one rate-limit key', async () => {
  const published = await call('/api/v1/skill-submissions/published');
  assert.equal(published.status, 200); assert.deepEqual(((await published.json()) as any).items, []);
  const login = await call('/api/v1/auth/login', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'CF-Connecting-IP': '192.0.2.77', 'X-Forwarded-For': '198.51.100.77' }, body: JSON.stringify({ email: DEMO_USERS[0].email, password: 'wrong-password-' + randomUUID() }) });
  assert.equal(login.status, 401);
  const buckets = (await db.query('SELECT bucket FROM auth_rate_limits')).rows.map(row => row.bucket);
  assert.ok(buckets.includes(tokenHash('login-network/shared-server')));
  assert.ok(!buckets.includes(tokenHash('login-network/192.0.2.77')) && !buckets.includes(tokenHash('login-network/198.51.100.77')));
});
