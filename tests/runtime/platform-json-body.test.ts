import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Pool } from 'pg';
import { createApp } from '../../apps/platform-api/src/app.js';
import { Hono } from 'hono';
import { Problem } from '../../packages/shared/problem.js';

const origin = 'http://127.0.0.1:4310';
const app = createApp(new Pool(), origin);

function request(body: BodyInit, extra: Record<string, string> = {}) {
  return app.request(new Request(origin + '/api/v1/auth/login', {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', ...extra },
    body, duplex: 'half',
  } as RequestInit));
}

test('oversized JSON without Content-Length is cancelled before draining the source', async () => {
  let pulled = 0, cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled === 8) { controller.close(); return; }
      pulled++; controller.enqueue(new Uint8Array(8192).fill(32));
    },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  const response = await request(body);
  assert.equal(response.status, 413);
  assert.equal((await response.json()).code, 'body_too_large');
  assert.ok(pulled < 8, 'the remainder of the hostile stream must not be read');
  assert.equal(cancelled, true);
});

test('the byte boundary applies to streamed JSON including multi-byte UTF-8', async () => {
  for (const [size, expected] of [[32768, 400], [32769, 413]] as const) {
    // An incomplete JSON document distinguishes parser rejection from size rejection.
    const bytes = new TextEncoder().encode(' '.repeat(size - 4) + '"貓');
    assert.equal(bytes.byteLength, size);
    const response = await request(new ReadableStream({
      start(controller) { controller.enqueue(bytes); controller.close(); },
    }));
    assert.equal(response.status, expected);
    assert.equal((await response.json()).code, expected === 400 ? 'invalid_json' : 'body_too_large');
  }
});

test('declared oversized JSON is rejected without pulling its source', async () => {
  let pulled = 0;
  const body = new ReadableStream<Uint8Array>({ pull() { pulled++; } }, { highWaterMark: 0 });
  const response = await request(body, { 'Content-Length': '32769' });
  assert.equal(response.status, 413);
  assert.equal(pulled, 0);
});

test('slow requests log once at the threshold using nested route patterns, without request content', async t => {
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  const logs: unknown[][] = [];
  t.mock.method(console, 'warn', (...args: unknown[]) => { logs.push(args); });
  t.mock.method(console, 'log', (...args: unknown[]) => { logs.push(args); });
  const local = createApp(new Pool(), origin), child = new Hono(), nested = new Hono();
  nested.post('/items/:id', c => { now = 1000; return c.json({ ok: true }); });
  child.route('/nested', nested); local.route('/observability', child);
  // Worker mounts its wildcard static-asset middleware after platform routes.
  local.use('/*', async (_c, next) => { await next(); });
  const id = 'ebaf4467-a54c-4cbb-866c-179db5a19123';
  const response = await local.request(origin + '/observability/nested/items/' + id + '?private=private-query', {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', Cookie: 'private-cookie=private-value', Authorization: 'Bearer private-token' },
    body: JSON.stringify({ user_id: id, email: 'private@example.invalid' }),
  });
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), { ok: true });
  assert.equal(logs.length, 1); assert.equal(logs[0].length, 1);
  assert.deepEqual(JSON.parse(String(logs[0][0])), { event: 'slow_request', method: 'POST', route: '/observability/nested/items/:id', status: 200, duration_ms: 1000 });
  assert.doesNotMatch(String(logs[0][0]), /ebaf4467|private|email|user_id|Bearer/);
});

test('handled errors retain the existing response and request_failed log, with one server_error entry', async t => {
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  const logs: unknown[][] = [], errors: unknown[][] = [];
  t.mock.method(console, 'warn', (...args: unknown[]) => { logs.push(args); });
  t.mock.method(console, 'log', (...args: unknown[]) => { logs.push(args); });
  t.mock.method(console, 'error', (...args: unknown[]) => { errors.push(args); });
  const local = createApp(new Pool(), origin), child = new Hono();
  child.get('/items/:id', () => { now = 1500; throw new Error('private database error'); });
  local.route('/observability', child);
  local.use('/*', async (_c, next) => { await next(); });
  const response = await local.request(origin + '/observability/items/ebaf4467-a54c-4cbb-866c-179db5a19123?private=secret');
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { type: 'about:blank', title: 'Internal error', status: 500, code: 'internal_error', detail: '操作未完成，請重新整理並查看目前狀態。' });
  assert.deepEqual(errors, [['request_failed', 'Error']]);
  assert.deepEqual(logs, [[JSON.stringify({ event: 'server_error', method: 'GET', route: '/observability/items/:id', status: 500, duration_ms: 1500 })]]);
});

test('fast success, unmatched 404, explicit 4xx and Problem 4xx remain quiet', async t => {
  t.mock.method(performance, 'now', () => 0);
  const logs: unknown[][] = [];
  for (const method of ['warn', 'log', 'error'] as const) t.mock.method(console, method, (...args: unknown[]) => { logs.push(args); });
  const local = createApp(new Pool(), origin);
  local.get('/observability/explicit', c => c.json({ code: 'denied' }, 403));
  local.get('/observability/problem', () => { throw new Problem(409, 'conflict', 'private conflict'); });
  for (const [path, status] of [['/api/v1/health', 200], ['/observability/missing', 404], ['/observability/explicit', 403], ['/observability/problem', 409]] as const) {
    const response = await local.request(origin + path);
    assert.equal(response.status, status);
    if (status === 409) assert.deepEqual(await response.json(), { type: 'about:blank', title: 'conflict', status: 409, code: 'conflict', detail: 'private conflict' });
  }
  assert.deepEqual(logs, []);
});

test('fast explicit 5xx logs and the slow-request boundary excludes 999 ms', async t => {
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  const logs: unknown[][] = [];
  t.mock.method(console, 'warn', (...args: unknown[]) => { logs.push(args); });
  const local = createApp(new Pool(), origin);
  local.get('/observability/below-threshold', c => { now += 999; return c.json({ ok: true }); });
  local.get('/observability/unavailable', c => c.json({ code: 'unavailable' }, 503));
  assert.equal((await local.request(origin + '/observability/below-threshold')).status, 200);
  assert.deepEqual(logs, []);
  assert.equal((await local.request(origin + '/observability/unavailable')).status, 503);
  assert.deepEqual(logs, [[JSON.stringify({ event: 'server_error', method: 'GET', route: '/observability/unavailable', status: 503, duration_ms: 0 })]]);
});

test('slow unmatched requests use a fixed pattern placeholder rather than the raw path', async t => {
  let calls = 0;
  t.mock.method(performance, 'now', () => calls++ === 0 ? 0 : 1000);
  const logs: unknown[][] = [];
  t.mock.method(console, 'warn', (...args: unknown[]) => { logs.push(args); });
  const local = createApp(new Pool(), origin);
  assert.equal((await local.request(origin + '/ebaf4467-a54c-4cbb-866c-179db5a19123?private=secret')).status, 404);
  assert.deepEqual(logs, [[JSON.stringify({ event: 'slow_request', method: 'GET', route: 'unmatched', status: 404, duration_ms: 1000 })]]);
});
