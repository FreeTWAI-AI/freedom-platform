import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import {
  CheckoutErrorSchema,
  PaymentHandoffResponseSchema,
  PublicOrderSchema,
  type PublicOrder,
} from '../../contracts/guild-launchpad/v1/hosted-checkout.js';
import { storeMissingHtml } from '../../modules/agent-commerce/hosted/page.js';
import {
  paymentReturnMissingHtml,
  paymentReturnPageHtml,
} from '../../modules/agent-commerce/storefront/pages.js';
import {
  formatRetryAfterTaipeiTime,
  formatTaipeiTime,
} from '../../apps/portal-web/src/storefront/format.js';
import {
  classifyQueryPaymentResponse,
  classifyStartPaymentResponse,
  isHandoffUrl,
  orderEmailNote,
  orderPaymentSectionCopy,
  parseRetryAfter,
  paymentView,
  type PaymentView,
  type StartPaymentRefusedCode,
} from '../../apps/portal-web/src/storefront/payment-view.js';
import { ok } from './hosted-checkout-harness.js';
import { hostedPaymentHarness } from '../e2e/hosted-payment-fixture.js';

const SAMPLE_ORDER_REF = '018f0000-0000-7000-8000-000000000001';
const SAMPLE_ATTEMPT_REF = '018f0000-0000-7000-8000-000000000002';

function makeOrder(overrides: Partial<PublicOrder> = {}): PublicOrder {
  return PublicOrderSchema.parse({
    order_ref: SAMPLE_ORDER_REF,
    display_number: '261016-012345',
    store: { slug: 'tea-shop', name: '山邊茶屋' },
    created_at: '2026-10-16T01:00:00.000Z',
    pay_by: '2026-10-16T02:00:00.000Z',
    reservation_expired: false,
    lifecycle_state: 'open',
    cancel_reason: null,
    currency: 'TWD',
    lines: [
      {
        sku: 'TEA-01',
        title: '高山烏龍',
        options: [],
        quantity: 1,
        unit_price_minor: 50000,
        line_total_minor: 50000,
      },
    ],
    merchandise_total_minor: 50000,
    discount_total_minor: 0,
    shipping_total_minor: 6000,
    total_minor: 56000,
    payment_state: 'unpaid',
    payment_method: 'immediate_card',
    payment_grace_until: null,
    offline_instructions: null,
    latest_payment_attempt: {
      attempt_ref: SAMPLE_ATTEMPT_REF,
      state: 'ready',
      created_at: '2026-10-16T01:00:00.000Z',
    },
    can_resume_payment: true,
    contact: {
      name: '合成買家',
      email: 'buyer@example.test',
      phone: '0900000000',
    },
    delivery: { method: 'synthetic' },
    invoice: null,
    redacted: false,
    ...overrides,
  });
}

function makeAttempt(state: NonNullable<PublicOrder['latest_payment_attempt']>['state']) {
  return {
    attempt_ref: SAMPLE_ATTEMPT_REF,
    state,
    created_at: '2026-10-16T01:00:00.000Z',
  };
}

function makeErrorResponse(
  status: number,
  code: ReturnType<typeof CheckoutErrorSchema.parse>['code'],
  headers: Record<string, string> = {},
): Response {
  const payload = CheckoutErrorSchema.parse({
    type: 'about:blank',
    title: code,
    status,
    code,
    detail: `合成錯誤：${code}`,
  });
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

test('paymentView maps every §1 table row, simulated fallthroughs, and priority interactions', () => {
  // Row 0: payment_state === 'overpaid' -> 'review' (highest priority even when cancelled or expired)
  assert.equal(
    paymentView(
      makeOrder({
        payment_state: 'overpaid',
        lifecycle_state: 'open',
        latest_payment_attempt: makeAttempt('paid'),
        can_resume_payment: true,
      }),
    ),
    'review',
  );
  assert.equal(
    paymentView(
      makeOrder({
        payment_state: 'overpaid',
        lifecycle_state: 'cancelled',
        cancel_reason: 'buyer_cancelled',
        reservation_expired: true,
      }),
    ),
    'review',
  );

  // Row 1: payment_state === 'confirmed' -> 'paid' (including confirmed on a cancelled or closed order)
  assert.equal(paymentView(makeOrder({ payment_state: 'confirmed' })), 'paid');
  assert.equal(
    paymentView(
      makeOrder({
        payment_state: 'confirmed',
        lifecycle_state: 'cancelled',
        cancel_reason: 'paid_cancelled',
      }),
    ),
    'paid',
  );
  assert.equal(
    paymentView(makeOrder({ payment_state: 'confirmed', lifecycle_state: 'closed' })),
    'paid',
  );

  // Row 2: payment_state === 'pending' -> 'checking' (including with reservation_expired or cancelled)
  assert.equal(paymentView(makeOrder({ payment_state: 'pending' })), 'checking');
  assert.equal(
    paymentView(makeOrder({ payment_state: 'pending', reservation_expired: true })),
    'checking',
  );

  // Row 3: lifecycle_state !== 'open' -> 'closed'
  assert.equal(
    paymentView(
      makeOrder({
        payment_state: 'unpaid',
        lifecycle_state: 'cancelled',
        cancel_reason: 'buyer_cancelled',
        latest_payment_attempt: makeAttempt('paid'),
      }),
    ),
    'closed',
  );
  assert.equal(
    paymentView(
      makeOrder({
        payment_state: 'simulated',
        lifecycle_state: 'cancelled',
        cancel_reason: 'seller_cancelled',
        latest_payment_attempt: makeAttempt('awaiting_result'),
      }),
    ),
    'closed',
  );

  // Row 4: latest attempt 'paid' -> 'checking'
  assert.equal(
    paymentView(makeOrder({ payment_state: 'unpaid', latest_payment_attempt: makeAttempt('paid') })),
    'checking',
  );
  assert.equal(
    paymentView(
      makeOrder({
        payment_state: 'unpaid',
        latest_payment_attempt: makeAttempt('paid'),
        reservation_expired: true,
      }),
    ),
    'checking',
  );

  // Row 5: latest attempt 'awaiting_result' -> 'awaiting' (even with reservation_expired)
  assert.equal(
    paymentView(
      makeOrder({
        payment_state: 'unpaid',
        latest_payment_attempt: makeAttempt('awaiting_result'),
      }),
    ),
    'awaiting',
  );
  assert.equal(
    paymentView(
      makeOrder({
        payment_state: 'unpaid',
        latest_payment_attempt: makeAttempt('awaiting_result'),
        reservation_expired: true,
      }),
    ),
    'awaiting',
  );

  // Row 6: reservation_expired -> 'expired' (beats failed/expired/ready/no attempt)
  assert.equal(
    paymentView(
      makeOrder({
        payment_state: 'unpaid',
        latest_payment_attempt: makeAttempt('failed'),
        reservation_expired: true,
      }),
    ),
    'expired',
  );
  assert.equal(
    paymentView(
      makeOrder({
        payment_state: 'unpaid',
        latest_payment_attempt: makeAttempt('ready'),
        reservation_expired: true,
      }),
    ),
    'expired',
  );
  assert.equal(
    paymentView(
      makeOrder({
        payment_state: 'unpaid',
        latest_payment_attempt: null,
        reservation_expired: true,
      }),
    ),
    'expired',
  );

  // Row 7: latest attempt 'failed' or 'expired' -> 'failed'
  assert.equal(
    paymentView(
      makeOrder({
        payment_state: 'unpaid',
        latest_payment_attempt: makeAttempt('failed'),
        reservation_expired: false,
      }),
    ),
    'failed',
  );
  assert.equal(
    paymentView(
      makeOrder({
        payment_state: 'unpaid',
        latest_payment_attempt: makeAttempt('expired'),
        reservation_expired: false,
      }),
    ),
    'failed',
  );

  // Row 8: otherwise (no attempt, or 'ready') -> 'ready'
  assert.equal(
    paymentView(makeOrder({ payment_state: 'unpaid', latest_payment_attempt: null })),
    'ready',
  );
  assert.equal(
    paymentView(
      makeOrder({ payment_state: 'unpaid', latest_payment_attempt: makeAttempt('ready') }),
    ),
    'ready',
  );

  // 'simulated' with each attempt state falls through like 'unpaid'
  assert.equal(
    paymentView(makeOrder({ payment_state: 'simulated', latest_payment_attempt: null })),
    'ready',
  );
  assert.equal(
    paymentView(
      makeOrder({ payment_state: 'simulated', latest_payment_attempt: makeAttempt('ready') }),
    ),
    'ready',
  );
  assert.equal(
    paymentView(
      makeOrder({
        payment_state: 'simulated',
        latest_payment_attempt: makeAttempt('awaiting_result'),
      }),
    ),
    'awaiting',
  );
  assert.equal(
    paymentView(
      makeOrder({ payment_state: 'simulated', latest_payment_attempt: makeAttempt('paid') }),
    ),
    'checking',
  );
  assert.equal(
    paymentView(
      makeOrder({ payment_state: 'simulated', latest_payment_attempt: makeAttempt('failed') }),
    ),
    'failed',
  );
  assert.equal(
    paymentView(
      makeOrder({ payment_state: 'simulated', latest_payment_attempt: makeAttempt('expired') }),
    ),
    'failed',
  );

  // Section copy helper covers every view without mentioning simulation
  for (const view of ['paid', 'refunded', 'review', 'checking', 'awaiting', 'failed', 'ready', 'expired', 'closed'] as const) {
    const copy = orderPaymentSectionCopy(view);
    assert.equal(/模擬|測試/.test(copy.label), false);
    assert.equal(/模擬|測試/.test(copy.description ?? ''), false);
  }
});

test('isHandoffUrl, parseRetryAfter and Taipei time rounding validate all edge cases', () => {
  const validToken = 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0_-z';
  assert.equal(validToken.length, 43);
  assert.equal(isHandoffUrl(`/pay/ecpay/${validToken}`), true);
  assert.equal(isHandoffUrl(`/pay/ecpay/${'a'.repeat(42)}`), false);
  assert.equal(isHandoffUrl(`/pay/ecpay/${'a'.repeat(44)}`), false);
  assert.equal(isHandoffUrl(`https://evil.example/pay/ecpay/${validToken}`), false);
  assert.equal(isHandoffUrl(`//evil.example/pay/ecpay/${validToken}`), false);
  assert.equal(isHandoffUrl(`/pay/ecpay/${validToken}?next=1`), false);
  assert.equal(isHandoffUrl(`/pay/ecpay/${validToken}\n`), false);
  assert.equal(isHandoffUrl(123), false);
  assert.equal(isHandoffUrl(null), false);
  assert.equal(isHandoffUrl(undefined), false);

  assert.equal(parseRetryAfter(undefined), 60);
  assert.equal(parseRetryAfter(null), 60);
  assert.equal(parseRetryAfter(''), 60);
  assert.equal(parseRetryAfter('0'), 1);
  assert.equal(parseRetryAfter('abc'), 60);
  assert.equal(parseRetryAfter('1.5'), 60);
  assert.equal(parseRetryAfter('-10'), 60);
  assert.equal(parseRetryAfter('120'), 120);
  assert.equal(parseRetryAfter('99999'), 3600);

  // Taipei HH:mm formatting and Retry-After rounding up to the minute
  const baseMs = Date.parse('2026-10-16T02:05:15.000Z'); // 10:05:15 Asia/Taipei
  assert.equal(formatTaipeiTime(baseMs), '10:05');
  assert.equal(formatRetryAfterTaipeiTime(20, baseMs), '10:06'); // 10:05:35 -> 10:06
  assert.equal(formatRetryAfterTaipeiTime(45, baseMs), '10:06'); // 10:06:00 -> 10:06
  assert.equal(formatRetryAfterTaipeiTime(46, baseMs), '10:07'); // 10:06:01 -> 10:07
});

test('classifyStartPaymentResponse and classifyQueryPaymentResponse cover every §2 outcome row', async () => {
  const validHandoff = PaymentHandoffResponseSchema.parse({
    handoff_url: `/pay/ecpay/${'B'.repeat(43)}`,
    attempt_ref: SAMPLE_ATTEMPT_REF,
    expires_at: '2026-10-16T01:15:00.000Z',
  });

  // startPayment: 201 valid handoff_url -> redirect
  assert.deepEqual(
    await classifyStartPaymentResponse(
      new Response(JSON.stringify(validHandoff), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      }),
    ),
    { kind: 'redirect', handoffUrl: validHandoff.handoff_url },
  );

  // startPayment: 201 with invalid handoff_url or malformed JSON -> failed
  assert.deepEqual(
    await classifyStartPaymentResponse(
      new Response(JSON.stringify({ ...validHandoff, handoff_url: 'https://evil.example/pay' }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      }),
    ),
    { kind: 'failed' },
  );
  assert.deepEqual(
    await classifyStartPaymentResponse(new Response('not-json', { status: 201 })),
    { kind: 'failed' },
  );

  // startPayment: 409 payment_result_pending -> pending (+ Retry-After)
  assert.deepEqual(
    await classifyStartPaymentResponse(
      makeErrorResponse(409, 'payment_result_pending', { 'Retry-After': '45' }),
    ),
    { kind: 'pending', retryAfterSeconds: 45 },
  );
  assert.deepEqual(
    await classifyStartPaymentResponse(makeErrorResponse(409, 'payment_result_pending')),
    { kind: 'pending', retryAfterSeconds: 60 },
  );

  // startPayment: 409 refused codes
  const refusedCodes: StartPaymentRefusedCode[] = [
    'checkout_hold_expired',
    'payment_already_applied',
    'payment_attempts_exhausted',
    'checkout_order_closed',
    'payment_handoff_unavailable',
    'checkout_not_enabled',
  ];
  for (const code of refusedCodes) {
    assert.deepEqual(await classifyStartPaymentResponse(makeErrorResponse(409, code)), {
      kind: 'refused',
      code,
    });
  }

  // startPayment: 409 unknown/other code -> failed
  assert.deepEqual(
    await classifyStartPaymentResponse(makeErrorResponse(409, 'order_intent_conflict')),
    { kind: 'failed' },
  );

  // startPayment: 429 -> rate_limited (+ Retry-After)
  assert.deepEqual(
    await classifyStartPaymentResponse(
      makeErrorResponse(429, 'commerce_rate_limited', { 'Retry-After': '90' }),
    ),
    { kind: 'rate_limited', retryAfterSeconds: 90 },
  );

  // startPayment: 503 commerce_quarantined -> paused; other 503 -> payment_unavailable
  assert.deepEqual(
    await classifyStartPaymentResponse(makeErrorResponse(503, 'commerce_quarantined')),
    { kind: 'paused' },
  );
  assert.deepEqual(
    await classifyStartPaymentResponse(makeErrorResponse(503, 'payment_profile_unavailable')),
    { kind: 'payment_unavailable' },
  );
  assert.deepEqual(
    await classifyStartPaymentResponse(new Response('service unavailable', { status: 503 })),
    { kind: 'payment_unavailable' },
  );

  // startPayment: 404 -> not_found
  assert.deepEqual(
    await classifyStartPaymentResponse(makeErrorResponse(404, 'checkout_order_not_found')),
    { kind: 'not_found' },
  );

  // startPayment: anything else / malformed body -> failed
  assert.deepEqual(
    await classifyStartPaymentResponse(makeErrorResponse(500, 'internal_error')),
    { kind: 'failed' },
  );
  assert.deepEqual(
    await classifyStartPaymentResponse(new Response('{malformed', { status: 409 })),
    { kind: 'failed' },
  );

  // queryPayment: 200 with valid order and matching order_ref -> ok
  const order = makeOrder({ payment_state: 'confirmed' });
  assert.deepEqual(
    await classifyQueryPaymentResponse(
      new Response(JSON.stringify(order), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
      SAMPLE_ORDER_REF,
    ),
    { kind: 'ok', order },
  );

  // queryPayment: 200 with mismatched order_ref or invalid shape -> failed
  assert.deepEqual(
    await classifyQueryPaymentResponse(
      new Response(JSON.stringify(order), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
      randomUUID(),
    ),
    { kind: 'failed' },
  );
  assert.deepEqual(
    await classifyQueryPaymentResponse(
      new Response(JSON.stringify({ order_ref: SAMPLE_ORDER_REF }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
      SAMPLE_ORDER_REF,
    ),
    { kind: 'failed' },
  );
  assert.deepEqual(
    await classifyQueryPaymentResponse(new Response('not-json', { status: 200 }), SAMPLE_ORDER_REF),
    { kind: 'failed' },
  );

  // queryPayment: 409 payment_result_pending -> pending; 409 checkout_not_enabled -> refused; other 409 -> failed
  assert.deepEqual(
    await classifyQueryPaymentResponse(
      makeErrorResponse(409, 'payment_result_pending', { 'Retry-After': '30' }),
      SAMPLE_ORDER_REF,
    ),
    { kind: 'pending', retryAfterSeconds: 30 },
  );
  assert.deepEqual(
    await classifyQueryPaymentResponse(
      makeErrorResponse(409, 'checkout_not_enabled'),
      SAMPLE_ORDER_REF,
    ),
    { kind: 'refused', code: 'checkout_not_enabled' },
  );
  assert.deepEqual(
    await classifyQueryPaymentResponse(
      makeErrorResponse(409, 'payment_already_applied'),
      SAMPLE_ORDER_REF,
    ),
    { kind: 'failed' },
  );

  // queryPayment: 429, 503, 404, 500
  assert.deepEqual(
    await classifyQueryPaymentResponse(
      makeErrorResponse(429, 'commerce_rate_limited', { 'Retry-After': '15' }),
      SAMPLE_ORDER_REF,
    ),
    { kind: 'rate_limited', retryAfterSeconds: 15 },
  );
  assert.deepEqual(
    await classifyQueryPaymentResponse(
      makeErrorResponse(503, 'commerce_quarantined'),
      SAMPLE_ORDER_REF,
    ),
    { kind: 'paused' },
  );
  assert.deepEqual(
    await classifyQueryPaymentResponse(
      makeErrorResponse(503, 'payment_profile_unavailable'),
      SAMPLE_ORDER_REF,
    ),
    { kind: 'payment_unavailable' },
  );
  assert.deepEqual(
    await classifyQueryPaymentResponse(
      makeErrorResponse(404, 'checkout_order_not_found'),
      SAMPLE_ORDER_REF,
    ),
    { kind: 'not_found' },
  );
  assert.deepEqual(
    await classifyQueryPaymentResponse(
      makeErrorResponse(500, 'internal_error'),
      SAMPLE_ORDER_REF,
    ),
    { kind: 'failed' },
  );
});

let f: Awaited<ReturnType<typeof hostedPaymentHarness>>;

async function tableCounts() {
  return (
    await f.x.h.pool.query<{
      attempts: number;
      events: number;
      due_work: number;
      rate_limits: number;
    }>(
      `SELECT
        (SELECT count(*)::int FROM commerce_payment_attempts) AS attempts,
        (SELECT count(*)::int FROM commerce_hosted_payment_events) AS events,
        (SELECT count(*)::int FROM commerce_due_work) AS due_work,
        (SELECT count(*)::int FROM auth_rate_limits) AS rate_limits`,
    )
  ).rows[0];
}

async function fetchPage(path: string, cookie?: string) {
  const req = new Request(f.origin + path, {
    method: 'GET',
    headers: cookie ? { Cookie: cookie } : {},
  });
  Object.defineProperty(req, 'cf', { value: { colo: 'TEST' } });
  const res = await f.app.fetch(req);
  const html = await res.text();
  return { res, status: res.status, html };
}

before(async () => {
  f = await hostedPaymentHarness('fp_storefront_pay_pages');
});

beforeEach(async () => {
  await f.reset();
});

after(async () => {
  await f?.stop();
});

test('B06 serves identical no-store HTML for real attempts regardless of cookies or query parameters and 404s on invalid or foreign attempts without DB writes', async () => {
  const p = await f.placed();
  const otherStore = await f.x.store(10);
  const before = await tableCounts();

  const returnPath = `/shops/${p.s.slug}/payment-return/${p.payment.attempt_ref}`;
  const noCookie = await fetchPage(returnPath);
  const withBuyerCookie = await fetchPage(returnPath, p.cookie);
  const withMemberCookie = await fetchPage(returnPath, p.s.owner.cookie);
  const withQueryParams = await fetchPage(`${returnPath}?RtnCode=1&TradeStatus=1`);

  for (const item of [noCookie, withBuyerCookie, withMemberCookie, withQueryParams]) {
    assert.equal(item.status, 200);
    assert.match(item.res.headers.get('content-type') ?? '', /^text\/html\b/i);
    assert.equal(item.res.headers.get('cache-control'), 'no-store');
    assert.equal(item.res.headers.get('x-robots-tag'), 'noindex');
    assert.match(item.res.headers.get('content-security-policy') ?? '', /script-src 'self'/);
    assert.equal(item.res.headers.get('set-cookie'), null);
  }

  assert.equal(noCookie.html, withBuyerCookie.html);
  assert.equal(noCookie.html, withMemberCookie.html);
  assert.equal(noCookie.html, withQueryParams.html);
  assert.equal(
    noCookie.html,
    paymentReturnPageHtml(
      { slug: p.s.slug, name: '合成商店' },
      p.order.order_ref,
      p.payment.attempt_ref,
    ),
  );

  assert.ok(noCookie.html.includes('<body><a class="shop-skip-link" href="#main">跳到主要內容</a>'));
  assert.equal(noCookie.html.match(/<script\b/gi)?.length, 1);
  assert.ok(noCookie.html.includes('<script type="module" src="/assets/storefront.js"></script>'));
  assert.equal(noCookie.html.match(/<h1\b/gi)?.length, 1);
  assert.ok(noCookie.html.includes('<h1 id="shop-pay-return-title" tabindex="-1">付款結果確認中</h1>'));
  assert.ok(noCookie.html.includes('<p role="status">正在向付款服務確認結果…</p>'));
  assert.ok(
    noCookie.html.includes(
      `<noscript><p>確認付款結果需要開啟瀏覽器的 JavaScript。</p><p><a href="/shops/${p.s.slug}/orders/${p.order.order_ref}">查看訂單</a></p></noscript>`,
    ),
  );
  assert.ok(noCookie.html.includes(`data-store-slug="${p.s.slug}"`));
  assert.ok(noCookie.html.includes('data-store-name="合成商店"'));
  assert.ok(noCookie.html.includes(`data-order-ref="${p.order.order_ref}"`));
  assert.ok(noCookie.html.includes(`data-attempt-ref="${p.payment.attempt_ref}"`));
  assert.equal(noCookie.html.includes('已收到付款'), false);
  assert.equal(noCookie.html.includes('付款成功'), false);
  assert.equal(noCookie.html.includes(p.order.display_number), false);

  // Unknown attempt, attempt of another store, and non-UUID -> 404 paymentReturnMissingHtml
  const upperAttempt = p.payment.attempt_ref.toUpperCase();
  const badVersionAttempt = p.payment.attempt_ref.replace(/^([0-9a-f]{8}-[0-9a-f]{4}-)[1-8]/, '$10');
  for (const [slug, badAttempt] of [
    [p.s.slug, randomUUID()],
    [otherStore.slug, p.payment.attempt_ref],
    [p.s.slug, 'not-a-uuid'],
    [p.s.slug, upperAttempt],
    [p.s.slug, badVersionAttempt],
  ] as const) {
    const missing = await fetchPage(`/shops/${slug}/payment-return/${badAttempt}`);
    assert.equal(missing.status, 404);
    assert.equal(missing.res.headers.get('cache-control'), 'no-store');
    assert.equal(missing.res.headers.get('x-robots-tag'), 'noindex');
    assert.equal(missing.res.headers.get('set-cookie'), null);
    assert.equal(missing.html, paymentReturnMissingHtml({ slug, name: '合成商店' }));
    assert.equal(missing.html.includes('<script'), false);
    assert.ok(missing.html.includes('<h1>找不到這次付款</h1>'));
    assert.ok(missing.html.includes(`/shops/${slug}/order-access`));
  }

  // Unknown store slug -> 404 storeMissingHtml
  const unknownStoreRes = await fetchPage(`/shops/no-such-store/payment-return/${p.payment.attempt_ref}`);
  assert.equal(unknownStoreRes.status, 404);
  assert.equal(unknownStoreRes.res.headers.get('cache-control'), 'no-store');
  assert.equal(unknownStoreRes.res.headers.get('x-robots-tag'), 'noindex');
  assert.equal(unknownStoreRes.res.headers.get('set-cookie'), null);
  assert.equal(unknownStoreRes.html, storeMissingHtml());

  assert.deepEqual(await tableCounts(), before);
});

test('store name with HTML characters is escaped in title, header and data attributes on B06 and missing page without DB writes', async () => {
  const p = await f.placed();
  const rawName = `<img src=x onerror=alert(1)>&"'`;
  const escapedName = '&lt;img src=x onerror=alert(1)&gt;&amp;&quot;&#39;';

  const current = ok(await f.x.h.call('GET', p.s.root, p.s.owner, undefined, {}, f.app));
  ok(
    await f.x.h.call(
      'PATCH',
      p.s.root,
      p.s.owner,
      { name: rawName },
      { 'Idempotency-Key': randomUUID(), 'If-Match': `"${current.version}"` },
      f.app,
    ),
  );
  const updated = ok(await f.x.h.call('GET', p.s.root, p.s.owner, undefined, {}, f.app));
  ok(
    await f.x.h.call(
      'POST',
      `${p.s.root}/publish`,
      p.s.owner,
      {},
      { 'Idempotency-Key': randomUUID(), 'If-Match': `"${updated.version}"` },
      f.app,
    ),
  );

  const before = await tableCounts();

  const b06 = await fetchPage(`/shops/${p.s.slug}/payment-return/${p.payment.attempt_ref}`);
  assert.equal(b06.status, 200);
  assert.equal(
    b06.html,
    paymentReturnPageHtml(
      { slug: p.s.slug, name: rawName },
      p.order.order_ref,
      p.payment.attempt_ref,
    ),
  );
  assert.ok(b06.html.includes(`<title>付款結果｜${escapedName}｜自由工坊</title>`));
  assert.ok(b06.html.includes(`<a class="shop-top-store" href="/shops/${p.s.slug}">${escapedName}</a>`));
  assert.ok(b06.html.includes(`data-store-name="${escapedName}"`));
  assert.equal(b06.html.includes('<img src=x'), false);
  assert.equal(/\bon[a-z]+\s*=/i.test(b06.html.replaceAll(escapedName, '')), false);

  const missing = await fetchPage(`/shops/${p.s.slug}/payment-return/${randomUUID()}`);
  assert.equal(missing.status, 404);
  assert.equal(missing.html, paymentReturnMissingHtml({ slug: p.s.slug, name: rawName }));
  assert.ok(missing.html.includes(`<title>找不到這次付款｜${escapedName}｜自由工坊</title>`));
  assert.ok(missing.html.includes(`<a class="shop-top-store" href="/shops/${p.s.slug}">${escapedName}</a>`));
  assert.ok(missing.html.includes(`<a href="/shops/${p.s.slug}">回到「${escapedName}」</a>`));
  assert.equal(missing.html.includes('<img src=x'), false);
  assert.equal(/\bon[a-z]+\s*=/i.test(missing.html.replaceAll(escapedName, '')), false);

  assert.deepEqual(await tableCounts(), before);
});

test('refunded is final after overpaid and confirmed, ahead of every lifecycle and attempt fallback',()=>{
  for(const lifecycle_state of ['open','cancelled','closed'] as const)for(const state of ['ready','awaiting_result','paid','failed','expired'] as const)for(const reservation_expired of [false,true]){
    const refunded=makeOrder({payment_state:'refunded',lifecycle_state,reservation_expired,latest_payment_attempt:makeAttempt(state),can_resume_payment:true});
    assert.equal(paymentView(refunded),'refunded');assert.equal(paymentView({...refunded,payment_state:'overpaid'}),'review');assert.equal(paymentView({...refunded,payment_state:'confirmed'}),'paid');
  }
  assert.deepEqual(orderPaymentSectionCopy('refunded'),{label:'已退款',description:'店家已登記退回這筆訂單收到的全部款項。入帳時間依發卡銀行而定，沒有收到時請聯絡店家。',canQueryWhenOpen:false});
});

test('orderEmailNote returns the off copy for every PaymentView and the pre-payment copy only for allowlisted views when on', () => {
  const offCopy = '這間店目前不寄確認信，請用這個瀏覽器回到訂單，或聯絡店家。';
  const onCopy = '付款確認後，訂單成立信會寄到你填寫的 Email。';
  const prePaymentViews: readonly PaymentView[] = ['ready', 'awaiting', 'checking', 'failed', 'expired'];
  const postOrTerminalViews: readonly PaymentView[] = ['paid', 'refunded', 'review', 'closed'];

  for (const view of [...prePaymentViews, ...postOrTerminalViews]) {
    assert.equal(orderEmailNote(view, false), offCopy, `expected off copy for ${view}`);
  }
  for (const view of prePaymentViews) {
    assert.equal(orderEmailNote(view, true), onCopy, `expected on copy for ${view}`);
  }
  for (const view of postOrTerminalViews) {
    assert.equal(orderEmailNote(view, true), null, `expected null for ${view} when on`);
  }
});
