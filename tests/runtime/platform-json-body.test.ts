import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Pool } from 'pg';
import { createApp } from '../../apps/platform-api/src/app.js';

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
