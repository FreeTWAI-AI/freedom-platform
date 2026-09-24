import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { Hono } from 'hono';
import { Pool } from 'pg';
import { createPool, LOCAL_DATABASE_URL } from '../../packages/db/index.js';
import { migrate } from '../../scripts/database.js';
import { seedLocal, DEMO_USERS, DEMO_PASSWORD } from '../../packages/testing/seed.js';
import { tokenHash } from '../../modules/identity-membership/service.js';
import { createWorkerHandler, cloudflareSourceNetwork, readWorkerConfig, workerRuntime, workerScope, type WorkerEnv } from '../../apps/platform-api/src/worker.js';
import { createApp } from '../../apps/platform-api/src/app.js';
import { authoredUploadText } from '../../apps/platform-api/src/routes/published-skills.js';
import { currentImageProcessor } from '../../packages/shared/image-runtime.js';
import { assertPublicDatabase, assertStagingDatabase } from '../../apps/platform-api/src/readiness.js';
import { githubSocialCss, skillUploadProtocolMarkdown, skillUploadSkillMarkdown } from '../../apps/platform-api/src/generated/runtime-text.js';

const SHA_A = 'a'.repeat(40), SHA_B = 'b'.repeat(40);
const COMMUNITY = '10000000-0000-4000-8000-00000000000b';
const SECRET_DSN = 'postgres://candidate_user:do-not-print@db.internal.example:5432/freedom_candidate_secret';
const SHELL = '<!doctype html><title>shell</title>';

/** Records every query and whether the request pool was ended; answers readiness probes. */
function fakePool(facts: { name?: string; rolsuper?: boolean; community?: boolean; demo?: boolean; fail?: boolean; endFails?: boolean; emptyReads?: boolean } = {}) {
  const state = { queries: [] as string[], ended: 0 };
  const pool = {
    state,
    async query(sql: string) {
      state.queries.push(sql);
      if (facts.fail) throw new Error('connection refused ' + SECRET_DSN);
      if (sql.includes('current_database()')) return { rows: [{ name: facts.name ?? 'freedom_candidate', rolsuper: facts.rolsuper ?? false }], rowCount: 1 };
      if (sql.includes('FROM communities')) return { rows: [], rowCount: facts.community === false ? 0 : 1 };
      if (sql.includes('@local.test')) return { rows: [], rowCount: facts.demo ? 1 : 0 };
      // Public page reads (editorial, discovery, metrics) see an empty database when allowed.
      if (facts.emptyReads && /^\s*(SELECT|WITH)\b/i.test(sql)) return { rows: [], rowCount: 0 };
      throw new Error('unexpected query in adapter test');
    },
    async connect() { throw new Error('unexpected transaction in adapter test'); },
    async end() { state.ended++; if (facts.endFails) throw new Error('end failed'); },
  };
  return pool;
}
type FakePool = ReturnType<typeof fakePool>;

function fakeAssets() {
  const seen: string[] = [];
  return {
    seen,
    async fetch(request: Request) {
      const path = new URL(request.url).pathname; seen.push(path);
      if (path === '/') return new Response(SHELL, { headers: { 'Content-Type': 'text/html', 'Cache-Control': 'public, max-age=3600', ETag: '"shell"' } });
      if (path === '/assets/app.js') return new Response('console.log(1)', { headers: { 'Content-Type': 'text/javascript', 'Cache-Control': 'public, max-age=31536000, immutable' } });
      return new Response('missing', { status: 404 });
    },
  };
}

function env(overrides: Partial<WorkerEnv> = {}): WorkerEnv & { ASSETS: ReturnType<typeof fakeAssets> } {
  return { HYPERDRIVE: { connectionString: SECRET_DSN }, ASSETS: fakeAssets(), FREEDOM_ENV: 'local', APP_ORIGIN: 'http://127.0.0.1:8787', ...overrides } as any;
}
const stagingEnv = (o: Partial<WorkerEnv> = {}) => env({ FREEDOM_ENV: 'staging', APP_ORIGIN: 'https://staging-next.freetwai.com', FREEDOM_RELEASE_SHA: SHA_A, FREEDOM_DATABASE_NAME: 'freedom_candidate', FREEDOM_TRUST_CF_CONNECTING_IP: 'true', ...o });
const publicEnv = (o: Partial<WorkerEnv> = {}) => env({ FREEDOM_ENV: 'public', APP_ORIGIN: 'https://next.freetwai.com', FREEDOM_RELEASE_SHA: SHA_B, FREEDOM_DATABASE_NAME: 'freedom_candidate', FREEDOM_REGISTRATION_COMMUNITY_ID: COMMUNITY, FREEDOM_TRUST_CF_CONNECTING_IP: 'true', ...o });

/** Handler with injected pools plus a ctx that records waitUntil work. */
function harness(facts: Parameters<typeof fakePool>[0] = {}) {
  const pools: FakePool[] = [];
  const handler = createWorkerHandler({ createPool: () => { const p = fakePool(facts); pools.push(p); return p as unknown as Pool; } });
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => { pending.push(p); } };
  const fetch = (url: string, e: WorkerEnv, init?: RequestInit) => handler.fetch(new Request(url, init), e, ctx);
  return { pools, pending, fetch, settle: () => Promise.all(pending) };
}
async function quietly<T>(run: () => Promise<T>) {
  const original = console.error, logged: string[] = [];
  console.error = (...args: unknown[]) => { logged.push(args.join(' ')); };
  try { return { result: await run(), logged }; } finally { console.error = original; }
}

test('worker config fails closed without echoing bindings', () => {
  const bad: Partial<WorkerEnv>[] = [
    { FREEDOM_ENV: undefined }, { FREEDOM_ENV: 'production' }, { APP_ORIGIN: undefined },
    { FREEDOM_ENV: 'public', APP_ORIGIN: 'https://127.0.0.1', FREEDOM_RELEASE_SHA: SHA_A },
    { FREEDOM_ENV: 'staging', APP_ORIGIN: 'http://staging-next.freetwai.com', FREEDOM_RELEASE_SHA: SHA_A },
    { FREEDOM_ENV: 'staging', APP_ORIGIN: 'https://staging-next.freetwai.com' },
    { FREEDOM_ENV: 'staging', APP_ORIGIN: 'https://staging-next.freetwai.com', FREEDOM_RELEASE_SHA: 'main' },
    { FREEDOM_TRUST_CF_CONNECTING_IP: 'true' }, { FREEDOM_TRUST_CF_CONNECTING_IP: 'yes' },
    { HYPERDRIVE: undefined as any }, { HYPERDRIVE: { connectionString: '' } }, { ASSETS: undefined as any },
  ];
  for (const override of bad) {
    assert.throws(() => readWorkerConfig(env(override)), (error: Error) => {
      assert.equal(error.name, 'ReadinessError');
      assert.ok(!error.message.includes('do-not-print') && !error.message.includes('freedom_candidate'));
      return true;
    }, JSON.stringify(Object.keys(override)));
  }
  assert.deepEqual(readWorkerConfig(stagingEnv()), { freedomEnv: 'staging', origin: 'https://staging-next.freetwai.com', release: SHA_A, trustConnectingIp: true });
});

test('invalid configuration answers 503 on every path, including the static shell, without opening a pool', async () => {
  const h = harness();
  for (const path of ['/', '/guilds', '/assets/app.js', '/api/v1/health']) {
    const { result, logged } = await quietly(() => h.fetch('https://next.freetwai.com' + path, publicEnv({ FREEDOM_RELEASE_SHA: undefined })));
    assert.equal(result.status, 503);
    const body = await result.text();
    assert.ok(!body.includes(SHELL) && !body.includes('do-not-print'));
    assert.equal(result.headers.get('cache-control'), 'no-store');
    assert.ok(logged.every(line => !line.includes('do-not-print')));
  }
  assert.equal(h.pools.length, 0);
});

test('strict worker host: other hosts, loopback tunnels and workers.dev are rejected before any pool or asset', async () => {
  const h = harness(), e = stagingEnv();
  for (const url of ['https://next.freetwai.com/', 'https://freedom-platform-staging-next.example.workers.dev/', 'https://127.0.0.1/api/v1/health', 'https://staging-next.freetwai.com:8443/', 'https://evil.example/api/v1/health']) {
    const response = await h.fetch(url, e);
    assert.equal(response.status, 403, url);
    assert.equal(((await response.json()) as any).code, 'host_rejected');
  }
  const insecure = await h.fetch('http://staging-next.freetwai.com/guilds?x=1', e);
  assert.equal(insecure.status, 308);
  assert.equal(insecure.headers.get('location'), 'https://staging-next.freetwai.com/guilds?x=1');
  assert.equal((await h.fetch('http://staging-next.freetwai.com/api/v1/auth/login', e, { method: 'POST' })).status, 403);
  assert.equal(h.pools.length, 0);
  assert.deepEqual(e.ASSETS.seen, []);
});

test('client address headers are trusted only for an opted-in Cloudflare edge request', async () => {
  const probe = (trust: boolean) => {
    const app = new Hono(); app.get('/', c => c.text(cloudflareSourceNetwork(trust)(c)));
    return async (headers: Record<string, string>, cf?: object) => {
      const request = new Request('https://next.freetwai.com/', { headers });
      if (cf) Object.defineProperty(request, 'cf', { value: cf });
      return (await app.fetch(request)).text();
    };
  };
  const spoof = { 'CF-Connecting-IP': '192.0.2.10', 'X-Forwarded-For': '198.51.100.7', 'X-Real-IP': '198.51.100.8' };
  const untrusted = probe(false), trusted = probe(true);
  assert.equal(await untrusted(spoof, { colo: 'TPE' }), 'shared-server');
  assert.equal(await untrusted(spoof), 'shared-server');
  assert.equal(await trusted(spoof), 'shared-server', 'no request.cf: not an edge request');
  assert.equal(await trusted({ 'X-Forwarded-For': '198.51.100.7' }, { colo: 'TPE' }), 'shared-server');
  assert.equal(await trusted({ 'CF-Connecting-IP': 'not-an-ip' }, { colo: 'TPE' }), 'shared-server');
  assert.equal(await trusted(spoof, { colo: 'TPE' }), '192.0.2.10');
  assert.equal(await trusted({ 'CF-Connecting-IP': '2001:db8::1' }, { colo: 'TPE' }), '2001:db8::1');
  // Deployed local config cannot opt in at all.
  assert.throws(() => readWorkerConfig(env({ FREEDOM_TRUST_CF_CONNECTING_IP: 'true' })));
});

test('concurrent requests with different bindings never share origin, community, release, keys or pools', async () => {
  const h = harness();
  const a = stagingEnv({ GITHUB_SOCIAL_TOKEN_KEY: Buffer.alloc(32, 1).toString('base64') });
  const b = publicEnv({ GITHUB_SOCIAL_TOKEN_KEY: Buffer.alloc(32, 2).toString('base64') });
  const calls = Array.from({ length: 40 }, (_, i) => i % 2 === 0
    ? h.fetch('https://staging-next.freetwai.com/api/v1/' + (i % 4 ? 'site' : 'health'), a).then(r => ({ which: 'a', path: i % 4 ? 'site' : 'health', r }))
    : h.fetch('https://next.freetwai.com/api/v1/' + (i % 4 === 1 ? 'site' : 'health'), b).then(r => ({ which: 'b', path: i % 4 === 1 ? 'site' : 'health', r })));
  for (const { which, path, r } of await Promise.all(calls)) {
    assert.equal(r.status, 200);
    const data: any = await r.json();
    if (path === 'health') {
      assert.equal(data.release_sha, which === 'a' ? SHA_A : SHA_B);
      assert.equal(data.mode, which === 'a' ? 'staging' : 'public');
      assert.equal(data.runtime, 'cloudflare-workers');
      assert.ok(!JSON.stringify(data).includes('do-not-print'));
    } else {
      assert.equal(data.registration_enabled, which === 'b');
      assert.equal(data.public_mode, which === 'b');
    }
  }
  await h.settle();
  assert.equal(h.pools.length, 40);
  assert.ok(h.pools.every(p => p.state.ended === 1));
  // Per-request runtimes keep their own settings; nothing leaks through process.env.
  assert.equal(process.env.GITHUB_SOCIAL_TOKEN_KEY, undefined);
  const ra = workerRuntime(a, readWorkerConfig(a)), rb = workerRuntime(b, readWorkerConfig(b));
  assert.equal(ra.githubTokenKey(), a.GITHUB_SOCIAL_TOKEN_KEY); assert.equal(rb.githubTokenKey(), b.GITHUB_SOCIAL_TOKEN_KEY);
  assert.equal(ra.registrationCommunityId(), undefined); assert.equal(rb.registrationCommunityId(), COMMUNITY);
  assert.deepEqual([...ra.allowedHosts], ['staging-next.freetwai.com']); assert.deepEqual([...rb.allowedHosts], ['next.freetwai.com']);
  assert.equal(ra.publicOrigin, 'https://staging-next.freetwai.com'); assert.equal(rb.publicOrigin, 'https://next.freetwai.com');
});

test('admin API fails closed with 503 when Access bindings are missing or invalid', async () => {
  const h = harness();
  for (const e of [publicEnv(), publicEnv({ FREEDOM_ADMIN_ACCESS_ISSUER: 'https://evil.example', FREEDOM_ADMIN_ACCESS_AUD: 'aud', FREEDOM_ADMIN_CSRF_SECRET: 'x'.repeat(32) }), publicEnv({ FREEDOM_ADMIN_ACCESS_ISSUER: 'https://team.cloudflareaccess.com', FREEDOM_ADMIN_ACCESS_AUD: 'aud', FREEDOM_ADMIN_CSRF_SECRET: 'short' })]) {
    const response = await h.fetch('https://next.freetwai.com/admin/api/bootstrap', e, { headers: { 'Cf-Access-Jwt-Assertion': 'forged' } });
    assert.equal(response.status, 503);
    assert.equal(((await response.json()) as any).code, 'admin_not_configured');
  }
  const configured = publicEnv({ FREEDOM_ADMIN_ACCESS_ISSUER: 'https://team.cloudflareaccess.com', FREEDOM_ADMIN_ACCESS_AUD: 'aud', FREEDOM_ADMIN_CSRF_SECRET: 'x'.repeat(32) });
  const missingToken = await h.fetch('https://next.freetwai.com/admin/api/bootstrap', configured);
  assert.equal(missingToken.status, 401);
  assert.equal(((await missingToken.json()) as any).code, 'admin_identity_required');
});

test('unknown machine paths return JSON 404 and never reach the browser shell', async () => {
  const h = harness(), e = env();
  for (const path of ['/api/unknown', '/api/v2/anything', '/client-api/v1/unknown', '/client-api/other', '/agent-api/v1/unknown', '/agent-api/x', '/development-agent/v1/unknown', '/development-agent/x']) {
    const response = await h.fetch('http://127.0.0.1:8787' + path, e);
    assert.ok(response.status >= 400 && response.status < 500, path + ' ' + response.status);
    assert.match(response.headers.get('content-type') ?? '', /application\/json/, path);
    assert.ok(!(await response.text()).includes(SHELL), path);
  }
  const api = await h.fetch('http://127.0.0.1:8787/api/unknown', e);
  assert.equal(api.status, 404); assert.equal(((await api.json()) as any).code, 'not_found');
  for (const path of ['/admin/api/unknown', '/admin/api', '/admin/api/v2/x', '/api', '/agent-api', '/client-api', '/development-agent']) {
    const response = await h.fetch('http://127.0.0.1:8787' + path, e);
    assert.ok(response.status >= 400 && response.status < 600, path + ' ' + response.status);
    assert.match(response.headers.get('content-type') ?? '', /application\/json/, path);
    assert.ok(!(await response.text()).includes(SHELL), path);
  }
  for (const method of ['POST', 'PUT', 'DELETE']) {
    const response = await h.fetch('http://127.0.0.1:8787/admin/api/unknown', e, { method, headers: { Origin: 'http://127.0.0.1:8787', 'Content-Type': 'application/json' }, body: '{}' });
    assert.match(response.headers.get('content-type') ?? '', /application\/json/, method);
  }
  assert.ok(e.ASSETS.seen.every(path => !/^\/(api|client-api|agent-api|admin\/api|development-agent)\//.test(path)), e.ASSETS.seen.join());
});

test('static files and navigation fallback come from ASSETS with platform security headers', async () => {
  const h = harness(), e = env();
  const file = await h.fetch('http://127.0.0.1:8787/assets/app.js', e);
  assert.equal(file.status, 200); assert.equal(await file.text(), 'console.log(1)');
  assert.equal(file.headers.get('cache-control'), 'no-store');
  assert.match(file.headers.get('content-type') ?? '', /javascript/);
  assert.match(file.headers.get('content-security-policy') ?? '', /default-src 'self'/);
  assert.equal(file.headers.get('x-content-type-options'), 'nosniff');
  for (const path of ['/', '/guilds', '/admin']) {
    const shell = await h.fetch('http://127.0.0.1:8787' + path, e);
    assert.equal(shell.status, 200, path); assert.equal(await shell.text(), SHELL);
    assert.equal(shell.headers.get('cache-control'), 'no-store');
    assert.match(shell.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
  }
  assert.match((await h.fetch('http://127.0.0.1:8787/admin', e)).headers.get('content-security-policy') ?? '', /github\.com\/organizations/);
  const post = await h.fetch('http://127.0.0.1:8787/guilds', e, { method: 'POST', headers: { Origin: 'http://127.0.0.1:8787', 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(post.status, 404); assert.ok(!(await post.text()).includes(SHELL));
  const missingShell = harness();
  const bare = env({ ASSETS: { fetch: async () => new Response('missing', { status: 404 }) } as any });
  assert.equal((await missingShell.fetch('http://127.0.0.1:8787/guilds', bare)).status, 404);
});

test('embedded public text is the canonical source and is served without filesystem access', async () => {
  execFileSync(process.execPath, ['scripts/generate-runtime-text.mjs', '--check']);
  assert.equal(githubSocialCss, readFileSync('apps/portal-web/src/modules/GitHubSocial.css', 'utf8'));
  assert.equal(skillUploadSkillMarkdown, readFileSync('packages/skill-upload-client/SKILL.md', 'utf8'));
  assert.equal(skillUploadProtocolMarkdown, readFileSync('packages/skill-upload-client/protocol.md', 'utf8'));
  const h = harness(), e = env();
  const skill = await h.fetch('http://127.0.0.1:8787/development/skill-upload/SKILL.md', e);
  assert.equal(await skill.text(), authoredUploadText(skillUploadSkillMarkdown, 'http://127.0.0.1:8787')); assert.match(skill.headers.get('content-type') ?? '', /text\/markdown/);
  assert.equal(await (await h.fetch('http://127.0.0.1:8787/development/skill-upload/protocol.md', e)).text(), authoredUploadText(skillUploadProtocolMarkdown, 'http://127.0.0.1:8787'));
  assert.ok((await (await h.fetch('http://127.0.0.1:8787/development.css', e)).text()).endsWith(githubSocialCss));
});

const LIVE = 'https://freetwai.com';
/** Absolute links to the live site; the pinned intent.source_url attribution is the one allowed exception. */
const liveLinks = (text: string) => (text.match(/https:\/\/freetwai\.com[^\s"'<>)`，；。]*/g) ?? []).filter(url => !/^https:\/\/freetwai\.com\/development\/skills\/[a-z0-9-]+#collaboration-title$/.test(url));

test('candidate origin: canonical, og, share, guidance and upload examples point at the configured Worker origin', async () => {
  const h = harness({ emptyReads: true });
  for (const [e, origin] of [[publicEnv(), 'https://next.freetwai.com'], [stagingEnv(), 'https://staging-next.freetwai.com'], [env(), 'http://127.0.0.1:8787']] as const) {
    const get = async (path: string) => { const r = await h.fetch(origin + path, e); assert.equal(r.status, 200, path); return r.text(); };
    const skillPage = await get('/development/skills/video-autopilot?intro=1');
    assert.ok(skillPage.includes(`<link rel="canonical" href="${origin}/development/skills/video-autopilot">`), origin);
    assert.ok(skillPage.includes(`<meta property="og:url" content="${origin}/development/skills/video-autopilot?intro=1">`));
    assert.ok(skillPage.includes(`data-share-base="${origin}/development/skills/video-autopilot"`));
    assert.match(skillPage, new RegExp(`<meta property="og:image" content="${origin.replaceAll('.', '\\.')}/brand/skill-illustrations/`));
    const pageHtml = await get('/development/registration');
    assert.ok(pageHtml.includes(`<link rel="canonical" href="${origin}/development/registration">`));
    const pageSkill = await get('/development/registration/SKILL.md');
    assert.ok(pageSkill.includes(`完整頁面說明：${origin}/development/registration`) && pageSkill.includes(`開發地圖：${origin}/api/v1/development-map`));
    assert.ok((await get('/development/skills/video-autopilot/SKILL.md')).includes(`分支資料來源：${origin}/api/v1/development-map`));
    const upload = await get('/development/skill-upload');
    assert.ok(upload.includes(`<link rel="canonical" href="${origin}/development/skill-upload">`) && upload.includes(`npm install -g ${origin}/downloads/freedom-skill-client.tgz`));
    const skillMd = await get('/development/skill-upload/SKILL.md'), protocol = await get('/development/skill-upload/protocol.md');
    assert.ok(skillMd.includes(`init --origin ${origin} --key-stdin`));
    assert.ok(protocol.includes(`"submit_url": "${origin}/agent-api/v1/skill-submissions/`) && protocol.includes(`"review_url": "${origin}/#skills"`));
    for (const [path, text] of Object.entries({ skillPage, pageHtml, pageSkill, upload, skillMd, protocol })) assert.deepEqual(liveLinks(text), [], `${origin} ${path}`);
  }
});

test('Node default keeps live-site links and serves the bundled upload text byte for byte', async () => {
  const node = createApp({ query: async () => ({ rows: [], rowCount: 0 }) } as any, 'http://127.0.0.1:4310');
  const get = async (path: string) => (await node.request('http://127.0.0.1:4310' + path)).text();
  assert.equal(await get('/development/skill-upload/SKILL.md'), skillUploadSkillMarkdown);
  assert.equal(await get('/development/skill-upload/protocol.md'), skillUploadProtocolMarkdown);
  assert.ok((await get('/development/skill-upload')).includes(`npm install -g ${LIVE}/downloads/freedom-skill-client.tgz`));
  assert.ok((await get('/development/registration')).includes(`<link rel="canonical" href="${LIVE}/development/registration">`));
  assert.ok((await get('/development/registration/SKILL.md')).includes(`開發地圖：${LIVE}/api/v1/development-map`));
  // Only the repository-authored upload text is rewritten, and only for another origin.
  assert.equal(authoredUploadText('see https://freetwai.com/x', LIVE), 'see https://freetwai.com/x');
  assert.equal(authoredUploadText('see https://freetwai.com/x', 'https://next.freetwai.com'), 'see https://next.freetwai.com/x');
});

test('request pool is ended after success, handler errors, readiness failures and failing cleanup', async () => {
  const ok = harness();
  await ok.fetch('http://127.0.0.1:8787/api/v1/health', env());
  const failing = harness({ fail: true });
  const { result: denied } = await quietly(() => failing.fetch('https://next.freetwai.com/api/v1/health', publicEnv()));
  assert.equal(denied.status, 503);
  const text = await denied.text(); assert.ok(!text.includes('do-not-print') && !text.includes('connection refused'));
  const throwing = harness();
  const { result: crashed } = await quietly(() => throwing.fetch('http://127.0.0.1:8787/api/v1/auth/login', env(), { method: 'POST', headers: { Origin: 'http://127.0.0.1:8787', 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'a@example.com', password: 'x' }) }));
  assert.equal(crashed.status, 500); assert.equal(((await crashed.json()) as any).code, 'internal_error');
  const endFails = harness({ endFails: true });
  const { logged } = await quietly(async () => { await endFails.fetch('http://127.0.0.1:8787/api/v1/health', env()); await endFails.settle(); });
  assert.ok(logged.includes('pool_end_failed'));
  for (const h of [ok, failing, throwing, endFails]) {
    await h.settle();
    assert.equal(h.pools.length, 1); assert.equal(h.pools[0].state.ended, 1);
  }
});

test('a throwing pool factory answers a sanitized 503 and schedules nothing', async () => {
  const pending: Promise<unknown>[] = [];
  const handler = createWorkerHandler({ createPool: () => { throw new Error('bad connection string ' + SECRET_DSN); } });
  const { result, logged } = await quietly(() => handler.fetch(new Request('https://next.freetwai.com/api/v1/health'), publicEnv(), { waitUntil: p => { pending.push(p); } }));
  assert.equal(result.status, 503); assert.equal(((await result.json()) as any).code, 'runtime_not_ready');
  assert.equal(result.headers.get('cache-control'), 'no-store');
  assert.ok(logged.length > 0 && logged.every(line => !line.includes('do-not-print') && !line.includes('bad connection string')), logged.join());
  assert.equal(pending.length, 0);
});

test('default Worker scope uses the fail-closed image processor, not the Node sharp default', async () => {
  assert.equal(currentImageProcessor().name, 'node-sharp');
  const seen: string[] = [];
  await Promise.all([1, 2].map(() => workerScope(env(), async () => { await Promise.resolve(); seen.push(currentImageProcessor().name); return new Response(null); })));
  assert.deepEqual(seen, ['unavailable', 'unavailable']);
  assert.equal(currentImageProcessor().name, 'node-sharp');
});

test('startup readiness mirrors the Node public guard, isolates staging and caches only success', async () => {
  const cases: [Parameters<typeof fakePool>[0], WorkerEnv][] = [
    [{ rolsuper: true }, publicEnv()], [{ name: 'other_db' }, publicEnv()], [{ name: 'freedom_staging' }, publicEnv({ FREEDOM_DATABASE_NAME: 'freedom_staging' })],
    [{ community: false }, publicEnv()], [{ demo: true }, publicEnv()], [{}, publicEnv({ FREEDOM_REGISTRATION_COMMUNITY_ID: 'not-a-uuid' })],
    [{ rolsuper: true }, stagingEnv()], [{ name: 'freedom_local' }, stagingEnv({ FREEDOM_DATABASE_NAME: 'freedom_local' })], [{}, stagingEnv({ FREEDOM_DATABASE_NAME: undefined })],
    [{ community: false }, stagingEnv({ FREEDOM_REGISTRATION_COMMUNITY_ID: COMMUNITY })],
  ];
  for (const [facts, e] of cases) {
    const h = harness(facts);
    const { result, logged } = await quietly(() => h.fetch(e.APP_ORIGIN + '/', e));
    assert.equal(result.status, 503, JSON.stringify(facts));
    assert.ok(!(await result.text()).includes(SHELL));
    assert.ok(logged.every(line => !/freedom_candidate|other_db|do-not-print/.test(line)), logged.join());
    assert.deepEqual((e.ASSETS as ReturnType<typeof fakeAssets>).seen, []);
  }
  const h = harness(), e = publicEnv();
  assert.equal((await h.fetch('https://next.freetwai.com/', e)).status, 200);
  assert.equal((await h.fetch('https://next.freetwai.com/', e)).status, 200);
  assert.equal(h.pools[0].state.queries.length, 3); assert.equal(h.pools[1].state.queries.length, 0);
  // Failure is not cached: the next request checks again.
  const flaky = harness({ fail: true }), fe = publicEnv();
  await quietly(() => flaky.fetch('https://next.freetwai.com/', fe));
  await quietly(() => flaky.fetch('https://next.freetwai.com/', fe));
  assert.ok(flaky.pools.every(p => p.state.queries.length === 1));
  // The shared guard keeps the Node server's public messages.
  await assert.rejects(assertPublicDatabase(fakePool({ rolsuper: true }) as any, { registrationCommunityId: COMMUNITY, databaseName: 'freedom_candidate' }), /dedicated non-superuser database/);
  await assert.rejects(assertPublicDatabase(fakePool() as any, { databaseName: 'freedom_candidate' }), /explicit community ID/);
  await assertStagingDatabase(fakePool() as any, { databaseName: 'freedom_candidate' });
});

// Real PostgreSQL through the Worker handler, isolated schema, per-request pools.
const databaseUrl = process.env.TEST_DATABASE_URL ?? LOCAL_DATABASE_URL;
const schema = `fp_worker_test_${process.pid}_${Date.now()}`;
const admin = createPool(databaseUrl), setup = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 2 });
before(async () => { await admin.query(`CREATE SCHEMA ${schema}`); await migrate(setup); await seedLocal(setup); });
after(async () => { await setup.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });

test('real database: login, session and CSRF work across request-scoped pools; spoofed headers share one limit key', async () => {
  const pools: Pool[] = [];
  const handler = createWorkerHandler({ createPool: () => { const p = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 5 }); pools.push(p); return p; } });
  const pending: Promise<unknown>[] = [], ctx = { waitUntil: (p: Promise<unknown>) => { pending.push(p); } };
  const origin = 'http://127.0.0.1:8787', e = env();
  const call = (path: string, init: RequestInit = {}) => handler.fetch(new Request(origin + path, init), e, ctx);
  const login = await call('/api/v1/auth/login', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'CF-Connecting-IP': '192.0.2.44', 'X-Forwarded-For': '198.51.100.44' }, body: JSON.stringify({ email: DEMO_USERS[0].email, password: DEMO_PASSWORD }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie')!.split(';')[0], csrf = ((await login.json()) as any).csrf_token;
  const session = await call('/api/v1/session', { headers: { Cookie: cookie } });
  assert.equal(session.status, 200); assert.equal(((await session.json()) as any).user.email, DEMO_USERS[0].email);
  // Image mutations refuse with 503 in the Worker; nothing is stored and the session keeps working.
  const png = await sharp({ create: { width: 32, height: 32, channels: 3, background: '#c4ff20' } }).png().toBuffer();
  const avatar = await call('/api/v1/me/avatar', { method: 'POST', headers: { Origin: origin, Cookie: cookie, 'X-CSRF-Token': csrf, 'Content-Type': 'image/png', 'If-Match': '"1"', 'Idempotency-Key': randomUUID() }, body: new Uint8Array(png) });
  assert.equal(avatar.status, 503); assert.equal(((await avatar.json()) as any).code, 'image_processing_unavailable');
  assert.equal((await setup.query('SELECT count(*)::int AS n FROM member_avatars WHERE image_bytes IS NOT NULL')).rows[0].n, 0);
  assert.equal((await call('/api/v1/session', { headers: { Cookie: cookie } })).status, 200);
  const forged = await call('/api/v1/auth/logout', { method: 'POST', headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json', 'X-CSRF-Token': 'wrong' }, body: '{}' });
  assert.equal(forged.status, 403);
  const logout = await call('/api/v1/auth/logout', { method: 'POST', headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: '{}' });
  assert.equal(logout.status, 200);
  assert.equal((await call('/api/v1/session', { headers: { Cookie: cookie } })).status, 401);
  const buckets = (await setup.query('SELECT bucket FROM auth_rate_limits')).rows.map(row => row.bucket);
  assert.ok(buckets.includes(tokenHash('login-network/shared-server')));
  assert.ok(!buckets.includes(tokenHash('login-network/192.0.2.44')) && !buckets.includes(tokenHash('login-network/198.51.100.44')));
  await Promise.all(pending);
  assert.equal(pools.length, 7);
  assert.ok(pools.every(p => (p as any).ending === true && p.totalCount === 0));
});

test('real database: default Worker scope sends avatar uploads through this request\'s IMAGES binding', async () => {
  // Injected stand-in for env.IMAGES, rendered by real sharp in Node. It proves the default
  // scope consumes the request's binding; it says nothing about Cloudflare's own transforms.
  const calls: string[] = [];
  const read = async (stream: ReadableStream<Uint8Array>) => Buffer.from(await new Response(stream).arrayBuffer());
  const IMAGES = {
    async info(stream: ReadableStream<Uint8Array>) { calls.push('info'); const bytes = await read(stream), meta = await sharp(bytes).metadata(); return { format: `image/${meta.format}`, fileSize: bytes.length, width: meta.width, height: meta.height }; },
    input(stream: ReadableStream<Uint8Array>) {
      calls.push('input'); let size = { width: 0, height: 0 };
      const transformer = {
        transform(t: { width: number; height: number; fit: string }) { calls.push(`transform:${t.fit}:${t.width}x${t.height}`); size = t; return transformer; },
        async output(o: { format: string; quality: number }) {
          calls.push(`output:${o.format}`);
          const webp = await sharp(await read(stream)).resize(size.width, size.height, { fit: 'cover' }).webp({ quality: o.quality }).toBuffer();
          return { contentType: () => 'image/webp', image: () => new Blob([new Uint8Array(webp)]).stream() };
        },
      };
      return transformer;
    },
  };
  const pools: Pool[] = [];
  const handler = createWorkerHandler({ createPool: () => { const p = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 5 }); pools.push(p); return p; } });
  const pending: Promise<unknown>[] = [], ctx = { waitUntil: (p: Promise<unknown>) => { pending.push(p); } };
  const origin = 'http://127.0.0.1:8787', e = env({ IMAGES } as Partial<WorkerEnv>);
  const call = (path: string, init: RequestInit = {}) => handler.fetch(new Request(origin + path, init), e, ctx);
  const login = await call('/api/v1/auth/login', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: DEMO_USERS[2].email, password: DEMO_PASSWORD }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie')!.split(';')[0], csrf = ((await login.json()) as any).csrf_token;
  const png = await sharp({ create: { width: 40, height: 30, channels: 3, background: '#c4ff20' } }).png().toBuffer();
  const avatar = await call('/api/v1/me/avatar', { method: 'POST', headers: { Origin: origin, Cookie: cookie, 'X-CSRF-Token': csrf, 'Content-Type': 'image/png', 'If-Match': '"1"', 'Idempotency-Key': randomUUID() }, body: new Uint8Array(png) });
  assert.equal(avatar.status, 200, await avatar.clone().text());
  assert.deepEqual(calls, ['info', 'input', 'transform:cover:256x256', 'output:image/webp']);
  const stored = (await setup.query('SELECT image_bytes FROM member_avatars WHERE user_id=$1', [DEMO_USERS[2].user_id])).rows[0].image_bytes as Buffer;
  const meta = await sharp(stored).metadata();
  assert.equal(meta.format, 'webp'); assert.equal(meta.width, 256); assert.equal(meta.height, 256);
  await Promise.all(pending); await Promise.all(pools.map(p => p.end().catch(() => undefined)));
});
