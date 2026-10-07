// Runs the maintainer dry-run bundle's scheduled handler in workerd.
// Build first: npm run worker:dry-run:maintainer
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { Pool } from 'pg';
import { exportPKCS8, exportSPKI, generateKeyPair, importSPKI, jwtVerify } from 'jose';
import { createPool, LOCAL_DATABASE_URL } from '../../packages/db/index.js';
import { migrate } from '../../scripts/database.js';
import { READ_PERMISSIONS } from '../../modules/repo-maintainer/github.js';

const bundlePath = '.wrangler/dry-run/maintainer-local/maintainer-worker.js';
const serverUrl = new URL(process.env.TEST_DATABASE_URL ?? LOCAL_DATABASE_URL);
const database = `fp_workerd_maintainer_${process.pid}_${Date.now()}`;
const databaseUrl = Object.assign(new URL(serverUrl), { pathname: '/' + database }).href;

// Required by Miniflare even when the database uses local trust auth.
const workerDatabase = new URL(databaseUrl);
workerDatabase.password ||= 'synthetic-workerd-only';
const compatibilityDate = '2026-09-21';
const APP_ID = '12345';
const pair = await generateKeyPair('RS256', { modulusLength: 2048, extractable: true });
const privateKey = await exportPKCS8(pair.privateKey);
const publicKey = await exportSPKI(pair.publicKey);
const server = createPool(serverUrl.href);
let mf: Miniflare, db: Pool;
const closedClients: Promise<void>[] = [];
const calls: Array<{ method: string; host: string; path: string; authorization: string; body: unknown }> = [];

before(async () => {
  await server.query(`CREATE DATABASE ${database}`);
  db = new Pool({ connectionString: databaseUrl, max: 2 });
  // Pool.end() resolves after removing clients, before their sockets necessarily close.
  // Wait for actual client end events before DROP FORCE, so teardown cannot kill an idle closing client.
  db.on('connect', client => closedClients.push(new Promise<void>(resolve => client.once('end', resolve))));
  await migrate(db);
  await db.query('INSERT INTO communities (community_id, name) VALUES ($1,$2)', [randomUUID(), 'Maintainer workerd']);
  // Wrangler's dry-run names the bundle after the entry. A scheduled-only module does not
  // finish Miniflare startup, so a one-line entry delegates scheduled and adds no route.
  const bundle = (await readFile(resolve(bundlePath), 'utf8')).replace(/\n\/\/# sourceMappingURL=.*\n?$/, '\n');
  const entry = `import worker from './maintainer-worker.js';\nexport default { fetch: () => new Response(null, { status: 404 }), scheduled: (controller, env, ctx) => worker.scheduled(controller, env, ctx) };\n`;
  mf = new Miniflare(convertV4MiniflareOptions({
    unsafeTriggerHandlers: true,
    workers: [{
      name: 'freedom-maintainer-workerd-test',
      modules: [
        { type: 'ESModule', path: 'entry.js', contents: entry },
        { type: 'ESModule', path: 'maintainer-worker.js', contents: bundle },
      ],
      compatibilityDate, compatibilityFlags: ['nodejs_compat'],
      bindings: { GITHUB_MAINTAINER_APP_ID: APP_ID, GITHUB_MAINTAINER_ORG: 'FreeTWAI-AI', GITHUB_MAINTAINER_PRIVATE_KEY: privateKey },
      hyperdrives: { HYPERDRIVE: workerDatabase.href },
      outboundService: async (request: Request) => {
        const url = new URL(request.url);
        const body = request.method === 'POST' ? await request.json() : null;
        calls.push({ method: request.method, host: url.host, path: url.pathname, authorization: request.headers.get('authorization') ?? '', body });
        if (url.host !== 'api.github.com') return new Response('wrong host', { status: 404 });
        if (url.pathname === '/app/installations') return Response.json([{ id: 77, account: { login: 'FreeTWAI-AI', type: 'Organization' }, suspended_at: null }]);
        if (/^\/app\/installations\/\d+\/repositories$/.test(url.pathname)) return new Response('missing', { status: 404 });
        if (url.pathname === '/installation/repositories') {
          if (request.headers.get('authorization') !== 'Bearer ghs_workerd_synthetic') return new Response('missing', { status: 404 });
          return Response.json({ total_count: 1, repository_selection: 'selected', repositories: [{ id: 9001, full_name: 'FreeTWAI-AI/freedom-platform', default_branch: 'main' }] });
        }
        if (url.pathname === '/app/installations/77/access_tokens') return Response.json({ token: 'ghs_workerd_synthetic', permissions: (body as { permissions: unknown }).permissions }, { status: 201 });
        if (url.pathname.endsWith('/pulls')) return Response.json([]);
        return new Response('missing', { status: 404 });
      },
    }],
  } as any));
  await mf.ready;
});
after(async () => {
  await mf?.dispose().catch(() => undefined);
  await db?.end().catch(() => undefined);
  await Promise.all(closedClients);
  try { await server.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`); }
  finally { await server.end(); }
});

test('the scheduled handler signs a PKCS#8 JWT and talks only to api.github.com', async () => {
  const cron = encodeURIComponent('* * * * *');
  const response = await mf.dispatchFetch(`http://127.0.0.1:8787/cdn-cgi/local/scheduled?cron=${cron}&time=${Date.now()}&format=json`) as unknown as Response;
  const text = await response.text();
  assert.equal(response.status, 200, text);
  assert.deepEqual([...new Set(calls.map(call => call.host))], ['api.github.com']);
  const jwt = calls.find(call => call.path === '/app/installations')?.authorization.replace(/^Bearer /, '') ?? '';
  const verified = await jwtVerify(jwt, await importSPKI(publicKey, 'RS256'));
  assert.equal(verified.protectedHeader.alg, 'RS256');
  assert.equal(verified.payload.iss, APP_ID);
  assert.equal(Number(verified.payload.exp) - Number(verified.payload.iat), 600);
  const mints = calls.filter(call => call.path === '/app/installations/77/access_tokens');
  assert.ok(mints.length >= 2);
  const syncMint = mints[0];
  assert.equal(Object.hasOwn(syncMint.body as object, 'repository_ids'), false);
  assert.equal(Object.hasOwn(syncMint.body as object, 'repositories'), false);
  assert.deepEqual((syncMint.body as { permissions: unknown }).permissions, { metadata: 'read' });
  const sweepMint = mints.find(call => Array.isArray((call.body as { repository_ids?: unknown }).repository_ids));
  assert.ok(sweepMint);
  assert.deepEqual((sweepMint.body as { repository_ids: number[] }).repository_ids, [9001]);
  assert.deepEqual((sweepMint.body as { permissions: unknown }).permissions, { ...READ_PERMISSIONS });
  const listed = calls.find(call => call.path === '/installation/repositories');
  assert.equal(listed?.authorization, 'Bearer ghs_workerd_synthetic');
  assert.notEqual(listed?.authorization, calls.find(call => call.path === '/app/installations')?.authorization);
  assert.equal(calls.some(call => /^\/app\/installations\/\d+\/repositories$/.test(call.path)), false);
  const row = (await db.query('SELECT full_name, installation_id, mode FROM maintainer_repositories')).rows[0];
  assert.equal(row.full_name, 'FreeTWAI-AI/freedom-platform');
  assert.equal(row.installation_id, '77');
  assert.equal(row.mode, 'observe');
  assert.equal(text.includes(privateKey.slice(40, 80)), false);
  assert.equal(text.includes('ghs_workerd_synthetic'), false);
});
