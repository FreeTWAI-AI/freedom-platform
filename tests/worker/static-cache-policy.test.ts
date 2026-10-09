import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import { createWorkerHandler, mountAssets, type WorkerEnv } from '../../apps/platform-api/src/worker.js';
import { platformResponseHeaders } from '../../apps/platform-api/src/platform-app.js';
import { IMMUTABLE_ASSET_CACHE_CONTROL } from '../../apps/platform-api/src/static-assets.js';
import { serveBuildAssets } from '../../apps/platform-api/src/static-assets-node.js';
import type { Pool } from 'pg';

const origin = 'http://127.0.0.1:8787', file = '/assets/app-AbCdEf12.js';
const security = ['content-security-policy', 'x-content-type-options', 'referrer-policy'];
test('Worker direct conditional and range responses retain cache policy in fast and mounted paths', async () => {
  for (const method of ['GET', 'HEAD']) for (const status of [200, 206, 304, 416]) {
    const assets: WorkerEnv['ASSETS'] = { async fetch(request) {
      assert.equal(request.headers.get('if-none-match'), '"fixture"');
      return new Response(method === 'HEAD' || status === 304 ? null : 'ab', { status, headers: {
        'Content-Type': 'text/javascript', ETag: '"fixture"', 'Cache-Control': 'untrusted',
        'Set-Cookie': 'bad=1', 'Content-Security-Policy': 'unsafe', 'X-Content-Type-Options': 'unsafe',
        'Referrer-Policy': 'unsafe', ...(status === 206 ? { 'Content-Range': 'bytes 0-1/14' } : {}),
      } });
    } };
    const env: WorkerEnv = { FREEDOM_ENV: 'local', APP_ORIGIN: origin, HYPERDRIVE: { connectionString: 'unused' }, ASSETS: assets };
    const handler = createWorkerHandler({ createPool: () => ({ async end() {} }) as Pool });
    const app = new Hono();
    app.use('*', async (c, next) => { for (const [k, v] of Object.entries(platformResponseHeaders(c.req.path))) c.header(k, v); await next(); });
    mountAssets(app, assets);
    const request = () => new Request(origin + file, { method, headers: { 'If-None-Match': '"fixture"' } });
    for (const response of [await handler.fetch(request(), env, { waitUntil() {} }), await app.fetch(request())]) {
      assert.equal(response.status, status);
      assert.equal(response.headers.get('cache-control'), status === 416 ? 'no-store' : IMMUTABLE_ASSET_CACHE_CONTROL);
      assert.equal(response.headers.get('etag'), '"fixture"');
      assert.equal(response.headers.get('set-cookie'), null);
      for (const name of security) assert.equal(response.headers.get(name), new Headers(platformResponseHeaders(file)).get(name));
      if (status === 206) assert.equal(response.headers.get('content-range'), 'bytes 0-1/14');
      if (method === 'HEAD' || status === 304) assert.equal(await response.text(), '');
    }
  }
});

test('Node immutable policy uses the completed direct response, preserving 416 and shell no-store', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fp-static-cache-'));
  try {
    await mkdir(join(root, 'assets'));
    await writeFile(join(root, file), 'console.log(1)');
    await writeFile(join(root, 'assets', 'skill-social.js'), 'fixed');
    await writeFile(join(root, 'index.html'), '<html>shell</html>');
    const app = new Hono();
    app.use('*', async (c, next) => { for (const [k, v] of Object.entries(platformResponseHeaders(c.req.path))) c.header(k, v); await next(); });
    app.use('*', serveBuildAssets(root));
    app.get('*', serveStatic({ path: join(root, 'index.html') }));
    for (const method of ['GET', 'HEAD']) for (const path of [file, '/assets/missing-AbCdEf12.js', '/assets/skill-social.js', '/']) {
      const response = await app.request(origin + path, { method });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), path === file ? IMMUTABLE_ASSET_CACHE_CONTROL : 'no-store');
      for (const name of security) assert.equal(response.headers.get(name), new Headers(platformResponseHeaders(path)).get(name));
      if (method === 'HEAD') assert.equal(await response.text(), '');
    }
    for (const [range, status] of [['bytes=0-2', 206], ['bytes=999-1000', 416]] as const) {
      const response = await app.request(origin + file, { headers: { Range: range } });
      assert.equal(response.status, status);
      assert.equal(response.headers.get('cache-control'), status === 206 ? IMMUTABLE_ASSET_CACHE_CONTROL : 'no-store');
      assert.equal(response.headers.get('content-range'), status === 206 ? 'bytes 0-2/14' : 'bytes */14');
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
