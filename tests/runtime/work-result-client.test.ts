import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApiError, PortalClient } from '../../apps/portal-web/src/api.js';
import { getWorkResultText, putWorkResultContent } from '../../apps/portal-web/src/modules/work-result-client.js';

test('putWorkResultContent times out when the 200 response body stalls', async (t) => {
  let recordedSignal: AbortSignal | null | undefined;
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (_input: unknown, init?: RequestInit) => {
    recordedSignal = init?.signal;
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"upload_id":"'));
        if (recordedSignal) {
          if (recordedSignal.aborted) {
            controller.error(new DOMException('The operation was aborted.', 'AbortError'));
          } else {
            recordedSignal.addEventListener('abort', () => {
              controller.error(new DOMException('The operation was aborted.', 'AbortError'));
            }, { once: true });
          }
        }
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const client = new PortalClient();
  client.csrfToken = 'synthetic-csrf';

  t.mock.timers.enable({ apis: ['setTimeout'] });

  let settled = false;
  let resultError: unknown;
  const promise = putWorkResultContent(
    client,
    '/api/v1/tenants/t-1/works/w-1/results/uploads/u-1/content',
    new Uint8Array([1, 2, 3]),
    'text/plain',
    '1',
    'key-1',
  ).then(
    () => { settled = true; },
    (error) => { settled = true; resultError = error; },
  );

  for (let i = 0; i < 20; i += 1) await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(20_000);
  for (let i = 0; i < 20; i += 1) await new Promise(resolve => setImmediate(resolve));

  assert.equal(settled, true, 'promise must settle after timeout');
  assert.ok(resultError instanceof ApiError);
  assert.equal(resultError.timedOut, true);
  assert.equal(resultError.network, true);
  assert.equal(resultError.status, 0);
});

test('putWorkResultContent aborts when caller controller aborts during body read', async (t) => {
  let recordedSignal: AbortSignal | null | undefined;
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (_input: unknown, init?: RequestInit) => {
    recordedSignal = init?.signal;
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"upload_id":"'));
        if (recordedSignal) {
          if (recordedSignal.aborted) {
            controller.error(new DOMException('The operation was aborted.', 'AbortError'));
          } else {
            recordedSignal.addEventListener('abort', () => {
              controller.error(new DOMException('The operation was aborted.', 'AbortError'));
            }, { once: true });
          }
        }
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const client = new PortalClient();
  client.csrfToken = 'synthetic-csrf';
  const callerController = new AbortController();

  t.mock.timers.enable({ apis: ['setTimeout'] });

  let settled = false;
  let resultError: unknown;
  const promise = putWorkResultContent(
    client,
    '/api/v1/tenants/t-1/works/w-1/results/uploads/u-1/content',
    new Uint8Array([1, 2, 3]),
    'text/plain',
    '1',
    'key-1',
    callerController.signal,
  ).then(
    () => { settled = true; },
    (error) => { settled = true; resultError = error; },
  );

  for (let i = 0; i < 20; i += 1) await new Promise(resolve => setImmediate(resolve));
  callerController.abort();
  for (let i = 0; i < 20; i += 1) await new Promise(resolve => setImmediate(resolve));

  assert.equal(settled, true, 'promise must settle after caller abort');
  assert.ok(resultError instanceof ApiError);
  assert.equal(resultError.code, 'aborted');
  assert.equal(recordedSignal?.aborted, true, 'recorded signal must be aborted');
});

test('getWorkResultText times out when the text body stalls', async (t) => {
  let recordedSignal: AbortSignal | null | undefined;
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (_input: unknown, init?: RequestInit) => {
    recordedSignal = init?.signal;
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('partial content'));
        if (recordedSignal) {
          if (recordedSignal.aborted) {
            controller.error(new DOMException('The operation was aborted.', 'AbortError'));
          } else {
            recordedSignal.addEventListener('abort', () => {
              controller.error(new DOMException('The operation was aborted.', 'AbortError'));
            }, { once: true });
          }
        }
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { 'Content-Type': 'text/plain' },
    });
  };

  const client = new PortalClient();

  t.mock.timers.enable({ apis: ['setTimeout'] });

  let settled = false;
  let resultError: unknown;
  const promise = getWorkResultText(
    client,
    '/api/v1/tenants/t-1/works/w-1/results/r-1/content',
  ).then(
    () => { settled = true; },
    (error) => { settled = true; resultError = error; },
  );

  for (let i = 0; i < 20; i += 1) await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(20_000);
  for (let i = 0; i < 20; i += 1) await new Promise(resolve => setImmediate(resolve));

  assert.equal(settled, true, 'promise must settle after timeout');
  assert.ok(resultError instanceof ApiError);
  assert.equal(resultError.timedOut, true);
});

test('putWorkResultContent resolves when complete 200 body is received', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => {
    return new Response(JSON.stringify({ upload_id: 'u-1', verified: true, version: '2' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const client = new PortalClient();
  client.csrfToken = 'synthetic-csrf';

  const result = await putWorkResultContent(
    client,
    '/api/v1/tenants/t-1/works/w-1/results/uploads/u-1/content',
    new Uint8Array([1, 2, 3]),
    'text/plain',
    '1',
    'key-1',
  );

  assert.deepEqual(result, { upload_id: 'u-1', verified: true, version: '2' });
});
