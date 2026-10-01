// /go/:code is an app route, so it wins over the asset handler and the SPA shell.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { createPool, LOCAL_DATABASE_URL } from '../../packages/db/index.js';
import { migrate } from '../../scripts/database.js';
import { seedLocal, DEMO_USERS, DEMO_PASSWORD } from '../../packages/testing/seed.js';
import { createPlatformApp } from '../../apps/platform-api/src/platform-app.js';
import { nodeRuntime } from '../../apps/platform-api/src/app.js';
import { mountAssets } from '../../apps/platform-api/src/worker.js';

const origin = 'http://127.0.0.1:4310';
const SHELL = '<!doctype html><title>spa shell</title>';
const GO_JS = '/* go.js asset */';
const databaseUrl = process.env.TEST_DATABASE_URL ?? LOCAL_DATABASE_URL;
const schema = `fp_sharego_${process.pid}_${Date.now()}`;
const admin = createPool(databaseUrl);
const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 4 });
const assets = { async fetch(request: Request) {
  const path = new URL(request.url).pathname;
  if (path === '/go.js') return new Response(GO_JS, { status: 200, headers: { 'content-type': 'text/javascript' } });
  if (path === '/' || path === '/index.html') return new Response(SHELL, { status: 200, headers: { 'content-type': 'text/html' } });
  return new Response('missing', { status: 404 });
} };
const app = createPlatformApp(pool, origin, 'local', nodeRuntime('local', origin));
mountAssets(app, assets);

before(async () => { await admin.query(`CREATE SCHEMA ${schema}`); await migrate(pool); await seedLocal(pool); });
after(async () => { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });

async function login() {
  const response = await app.request(origin + '/api/v1/auth/login', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: DEMO_USERS[0].email, password: DEMO_PASSWORD }) });
  assert.equal(response.status, 200);
  const body = await response.json() as { csrf_token: string };
  return { cookie: response.headers.get('set-cookie')!.split(';')[0], csrf: body.csrf_token };
}

test('an unknown share code is the app redirect, not the SPA shell', async () => {
  const response = await app.request(origin + '/go/aaaaaaaaaa');
  assert.equal(response.status, 302);
  assert.ok((response.headers.get('location') ?? '').endsWith('/'));
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-robots-tag'), 'noindex, nofollow');
  assert.ok(!(await response.text()).includes('spa shell'));
});

test('a live share code returns the interstitial before assets, and /go.js stays a static file', async () => {
  const session = await login();
  const created = await app.request(origin + '/api/v1/promotion/links', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', Cookie: session.cookie, 'X-CSRF-Token': session.csrf }, body: JSON.stringify({ kind: 'platform', target: 'workshop' }) });
  assert.equal(created.status, 200, await created.clone().text());
  const code = (await created.json() as { code: string }).code;
  const page = await app.request(origin + '/go/' + code);
  const html = await page.text();
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type') ?? '', /text\/html/);
  assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(page.headers.get('x-robots-tag'), 'noindex, nofollow');
  assert.match(page.headers.get('content-security-policy') ?? '', /script-src 'self'/);
  assert.match(html, /正在開啟：自由工坊/);
  assert.match(html, new RegExp(`data-code="${code}"`));
  assert.ok(!html.includes('spa shell'));
  const asset = await app.request(origin + '/go.js');
  assert.equal(asset.status, 200);
  assert.equal(await asset.text(), GO_JS);
  const shell = await app.request(origin + '/skills');
  assert.equal(shell.status, 200);
  assert.equal(await shell.text(), SHELL);
});

test('/services is the app page, not the SPA shell', async () => {
  const list = await app.request(origin + '/services');
  const html = await list.text();
  assert.equal(list.status, 200);
  assert.match(list.headers.get('content-type') ?? '', /text\/html/);
  assert.equal(list.headers.get('cache-control'), 'public, max-age=60');
  assert.match(html, /社員服務/);
  assert.equal(html.includes('spa shell'), false);
  const missing = await app.request(origin + '/services/00000000-0000-4000-8000-000000000099');
  const missingHtml = await missing.text();
  assert.equal(missing.status, 404);
  assert.match(missingHtml, /找不到這項服務/);
  assert.equal(missingHtml.includes('spa shell'), false);
  const css = await app.request(origin + '/services.css');
  assert.equal(await css.text(), SHELL);
});
