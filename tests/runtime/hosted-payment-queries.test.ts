import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { ECPAY_ORIGINS, EcpayKeyPair, newTradeNumber } from '../../modules/agent-commerce/providers/ecpay/index.js';
import { buildTradeInfoQuery, type EcpayServerRequest } from '../../modules/agent-commerce/providers/ecpay/aio-credit/index.js';
import { createEcpayQueryTransport, createFixtureQueryTransport, assertQueryTransportInstallation } from '../../modules/agent-commerce/payments/query-transport.js';

const request = (environment: 'sandbox' | 'live' = 'sandbox') => buildTradeInfoQuery({
  environment, merchantId: '1234567', merchantTradeNo: newTradeNumber('F'), timestampSeconds: Math.floor(Date.now() / 1000),
}, EcpayKeyPair.of(randomBytes(8).toString('hex'), randomBytes(8).toString('hex')));
const fetchStub = (handler: (url: string, init: RequestInit) => Response | Promise<Response>): typeof fetch =>
  (async (url, init) => handler(String(url), init!)) as typeof fetch;

for (const environment of ['sandbox', 'live'] as const)
  test(`query transport sends the library request only to ${environment}`, async () => {
    const input = request(environment);
    let calls = 0;
    const transport = createEcpayQueryTransport({ fetch: fetchStub((url, init) => {
      calls++;
      assert.equal(url, ECPAY_ORIGINS.payment[environment] + '/Cashier/QueryTradeInfo/V5');
      assert.equal(init.method, 'POST'); assert.equal(init.redirect, 'manual');
      assert.deepEqual(init.headers, { 'Content-Type': input.contentType });
      assert.equal(init.body, input.bodyText());
      assert(init.signal instanceof AbortSignal); assert.equal(init.signal.aborted, false);
      return new Response('signed=response');
    }) });
    assert.deepEqual(await transport.send(input, environment), { kind: 'response', status: 200, body: 'signed=response' });
    assert.equal(calls, 1);
  });
test('query transport refuses every other host, environment, path and URL adornment before fetch', async () => {
  let calls = 0;
  const transport = createEcpayQueryTransport({ fetch: fetchStub(() => { calls++; throw Error('must never fetch'); }) });
  const origin = ECPAY_ORIGINS.payment.sandbox, path = '/Cashier/QueryTradeInfo/V5';
  for (const url of ['https://other.example.test' + path, ECPAY_ORIGINS.payment.live + path,
    ECPAY_ORIGINS.logistics.sandbox + path, 'http://payment-stage.ecpay.com.tw' + path,
    origin + ':8443' + path, origin + '/Cashier/AioCheckOut/V5', origin + path + '/',
    origin + path + '?credential=redacted', origin + path + '#fragment',
    'https://user:password@payment-stage.ecpay.com.tw' + path, 'invalid']) {
    await assert.rejects(transport.send({ url } as EcpayServerRequest, 'sandbox'), { message: 'transport_host_refused' });
  }
  assert.equal(calls, 0);
});
test('query transport distinguishes timeout and network failures with fixed codes', async () => {
  for (const name of ['TimeoutError', 'AbortError', 'TypeError']) {
    const transport = createEcpayQueryTransport({ fetch: fetchStub(() => { throw new DOMException('do not retain provider details', name); }) });
    assert.deepEqual(await transport.send(request(), 'sandbox'), { kind: 'error', code: name === 'TypeError' ? 'network' : 'timeout' });
  }
});
test('query transport aborts both fetch and a stalled response stream after ten seconds', async () => {
  const signals: AbortSignal[] = [];
  let now = 0;
  const originalTimeout = AbortSignal.timeout;
  AbortSignal.timeout = (ms: number) => {
    assert.equal(ms, 10_000); now++;
    const controller = new AbortController();
    queueMicrotask(() => controller.abort(new DOMException('expired', 'TimeoutError')));
    signals.push(controller.signal); return controller.signal;
  };
  try {
    const transport = createEcpayQueryTransport({ fetch: fetchStub(async (_url, init) => {
      await Promise.resolve(); init.signal!.throwIfAborted(); throw Error('unreachable');
    }) });
    assert.deepEqual(await transport.send(request(), 'sandbox'), { kind: 'error', code: 'timeout' });
    const streaming = createEcpayQueryTransport({ fetch: fetchStub((_url, init) => new Response(new ReadableStream({
      start(controller) { init.signal!.addEventListener('abort', () => controller.error(init.signal!.reason), { once: true }); },
    }))) });
    assert.deepEqual(await streaming.send(request(), 'sandbox'), { kind: 'error', code: 'timeout' });
    assert.equal(now, 2); assert(signals.every(signal => signal.aborted));
  }
  finally { AbortSignal.timeout = originalTimeout; }
});
test('query transport accepts exactly 64 KiB and stops reading the first oversized chunk', async () => {
  const exact = createEcpayQueryTransport({ fetch: fetchStub(() => new Response('a'.repeat(65536))) });
  const result = await exact.send(request(), 'sandbox');
  assert.equal(result.kind, 'response'); if (result.kind === 'response') assert.equal(result.body.length, 65536);
  let pulls = 0, cancelled = 0;
  const oversized = createEcpayQueryTransport({ fetch: fetchStub(() => new Response(new ReadableStream({
    pull(controller) { pulls++; controller.enqueue(new Uint8Array(32769)); },
    cancel() { cancelled++; },
  }, { highWaterMark: 0 }))) });
  assert.deepEqual(await oversized.send(request(), 'sandbox'), { kind: 'error', code: 'response_too_large' });
  assert.equal(pulls, 2); assert.equal(cancelled, 1);
});
test('query transport limits bytes rather than UTF-16 code units', async () => {
  const transport = createEcpayQueryTransport({ fetch: fetchStub(() => new Response('字'.repeat(22000))) });
  assert.deepEqual(await transport.send(request(), 'sandbox'), { kind: 'error', code: 'response_too_large' });
});
test('query transport retains 403 and other statuses without reading or following them', async () => {
  for (const status of [302, 307, 403, 429, 500]) {
    let cancelled = 0, reads = 0;
    const transport = createEcpayQueryTransport({ fetch: fetchStub((_url, init) => {
      assert.equal(init.redirect, 'manual');
      return new Response(new ReadableStream({ pull() { reads++; }, cancel() { cancelled++; } }, { highWaterMark: 0 }),
        { status, headers: { Location: 'https://other.example.test/private' } });
    }) });
    assert.deepEqual(await transport.send(request(), 'sandbox'), { kind: 'response', status, body: '' });
    assert.equal(reads, 0); assert.equal(cancelled, 1);
  }
});
test('fixture query transport requires an explicit local environment at construction and installation', async () => {
  for (const environment of ['staging', 'public'] as const)
    assert.throws(() => createFixtureQueryTransport(async () => ({ kind: 'error', code: 'network' }), environment), { message: 'payment_fixture_requires_local' });
  const fixture = createFixtureQueryTransport(async input => ({ kind: 'response', status: 200, body: input.bodyText() }), 'local');
  const input = request();
  assert.deepEqual(await fixture.send(input, 'sandbox'), { kind: 'response', status: 200, body: input.bodyText() });
  assertQueryTransportInstallation(fixture, 'local');
  for (const environment of ['staging', 'public'] as const)
    assert.throws(() => assertQueryTransportInstallation(fixture, environment), { message: 'payment_fixture_requires_local' });
});
