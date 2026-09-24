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
import sharp from 'sharp';
import { seedLocal, DEMO_USERS, DEMO_PASSWORD } from '../../packages/testing/seed.js';
import { tokenHash } from '../../modules/identity-membership/service.js';

const bundleDir = resolve(process.env.FREEDOM_WORKERD_BUNDLE_DIR ?? '.wrangler/dry-run/local');
const assetsDir = resolve(`.wrangler/test-assets-${process.pid}`);
const serverUrl = new URL(process.env.TEST_DATABASE_URL ?? LOCAL_DATABASE_URL);
const database = `fp_workerd_${process.pid}_${Date.now()}`;
const databaseUrl = Object.assign(new URL(serverUrl), { pathname: '/' + database }).href;
const origin = 'http://127.0.0.1:8787';
const SHELL = '<!doctype html><title>workerd shell</title>';
// Same date as wrangler.jsonc: the newest the pinned workerd 1.20260921.1 supports.
const compatibilityDate = '2026-09-21';

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

test('workerd runs the exact compatibility date and sharp alias from wrangler.jsonc', async () => {
  const config = await readFile('wrangler.jsonc', 'utf8');
  assert.match(config, new RegExp(`"compatibility_date": "${compatibilityDate}"`));
  assert.match(config, /"alias": \{ "sharp": "\.\/packages\/shared\/sharp-unavailable\.ts" \}/);
  const bundle = await readFile(resolve(bundleDir, 'worker.js'), 'utf8');
  assert.ok(bundle.includes('// packages/shared/sharp-unavailable.ts'));
  assert.ok(!/node_modules\/sharp\/|@img\/sharp-/.test(bundle), 'native sharp must not be bundled');
});

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
  for (const path of ['/api/unknown', '/api', '/client-api/other', '/agent-api/x', '/development-agent/x', '/admin/api/unknown', '/admin/api']) {
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
  // Authored upload guidance is served with this Worker's origin instead of the live site.
  const live = (text: string) => text.replaceAll('https://freetwai.com', origin);
  assert.equal(await (await call('/development/skill-upload/SKILL.md')).text(), live(await readFile('packages/skill-upload-client/SKILL.md', 'utf8')));
  assert.equal(await (await call('/development/skill-upload/protocol.md')).text(), live(await readFile('packages/skill-upload-client/protocol.md', 'utf8')));
  const page = await (await call('/development/skills/video-autopilot')).text();
  assert.ok(page.includes(`<link rel="canonical" href="${origin}/development/skills/video-autopilot">`) && page.includes(`data-share-base="${origin}/`));
  assert.ok(!/https:\/\/freetwai\.com(?!\/development\/skills\/[a-z0-9-]+#collaboration-title)/.test(page));
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

test('workerd: Node-seeded scrypt login, session, CSRF, image 503, logout and immediate revocation', async () => {
  const login = await call('/api/v1/auth/login', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: DEMO_USERS[1].email, password: DEMO_PASSWORD }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie')!.split(';')[0], body: any = await login.json();
  assert.equal(body.user.email, DEMO_USERS[1].email);
  const session = await call('/api/v1/session', { headers: { Cookie: cookie } });
  assert.equal(session.status, 200); assert.equal(((await session.json()) as any).user.email, DEMO_USERS[1].email);
  const noCsrf = await call('/api/v1/auth/logout', { method: 'POST', headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(noCsrf.status, 403); assert.equal(((await noCsrf.json()) as any).code, 'csrf_rejected');
  const crossSite = await call('/api/v1/auth/logout', { method: 'POST', headers: { Origin: 'https://evil.example', Cookie: cookie, 'Content-Type': 'application/json', 'X-CSRF-Token': body.csrf_token }, body: '{}' });
  assert.equal(crossSite.status, 403); assert.equal(((await crossSite.json()) as any).code, 'origin_rejected');
  // No Worker decoder is wired: the upload is refused, nothing is stored, the session survives.
  const png = await sharp({ create: { width: 32, height: 32, channels: 3, background: '#3044ff' } }).png().toBuffer();
  const avatar = await call('/api/v1/me/avatar', { method: 'POST', headers: { Origin: origin, Cookie: cookie, 'X-CSRF-Token': body.csrf_token, 'Content-Type': 'image/png', 'If-Match': '"1"', 'Idempotency-Key': randomUUID() }, body: new Uint8Array(png) });
  assert.equal(avatar.status, 503); assert.equal(((await avatar.json()) as any).code, 'image_processing_unavailable');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM member_avatars WHERE image_bytes IS NOT NULL')).rows[0].n, 0);
  assert.equal((await call('/api/v1/session', { headers: { Cookie: cookie } })).status, 200);
  const logout = await call('/api/v1/auth/logout', { method: 'POST', headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json', 'X-CSRF-Token': body.csrf_token }, body: '{}' });
  assert.equal(logout.status, 200);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM sessions WHERE token_hash=$1 AND revoked_at IS NOT NULL', [tokenHash(decodeURIComponent(cookie.split('=')[1]))])).rows[0].n, 1);
  const after = await call('/api/v1/session', { headers: { Cookie: cookie } });
  assert.equal(after.status, 401);
  const replay = await call('/api/v1/auth/logout', { method: 'POST', headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json', 'X-CSRF-Token': body.csrf_token }, body: '{}' });
  assert.equal(replay.status, 401);
});

test('workerd: with a local IMAGES binding the default scope stores a re-encoded avatar (low-fidelity mock)', async () => {
  // Wrangler/Miniflare's local Images binding renders with sharp in Node. This proves the
  // bundle's default scope uses env.IMAGES inside workerd; it is not Cloudflare Images evidence.
  const withImages = new Miniflare(convertV4MiniflareOptions({ workers: [{
    name: 'freedom-platform-workerd-images', modules: true, scriptPath: resolve(bundleDir, 'worker.js'),
    compatibilityDate, compatibilityFlags: ['nodejs_compat'],
    bindings: { FREEDOM_ENV: 'local', APP_ORIGIN: origin },
    hyperdrives: { HYPERDRIVE: databaseUrl }, images: { binding: 'IMAGES' },
    assets: { directory: assetsDir, binding: 'ASSETS', routerConfig: { has_user_worker: true, invoke_user_worker_ahead_of_assets: true }, assetConfig: { html_handling: 'auto-trailing-slash', not_found_handling: 'none' } },
  }] } as any));
  try {
    const send = (path: string, init?: RequestInit) => withImages.dispatchFetch(origin + path, init as any) as unknown as Promise<Response>;
    const login = await send('/api/v1/auth/login', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: DEMO_USERS[2].email, password: DEMO_PASSWORD }) });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie')!.split(';')[0], csrf = ((await login.json()) as any).csrf_token;
    const png = await sharp({ create: { width: 40, height: 30, channels: 3, background: '#c4ff20' } }).png().toBuffer();
    const avatar = await send('/api/v1/me/avatar', { method: 'POST', headers: { Origin: origin, Cookie: cookie, 'X-CSRF-Token': csrf, 'Content-Type': 'image/png', 'If-Match': '"1"', 'Idempotency-Key': randomUUID() }, body: new Uint8Array(png) });
    assert.equal(avatar.status, 200, await avatar.clone().text());
    const stored = (await db.query('SELECT image_bytes FROM member_avatars WHERE user_id=$1', [DEMO_USERS[2].user_id])).rows[0].image_bytes as Buffer;
    const meta = await sharp(stored).metadata();
    assert.equal(meta.format, 'webp'); assert.equal(meta.width, 256); assert.equal(meta.height, 256);
    assert.ok(!stored.equals(png));
  } finally { await withImages.dispose(); }
});
