import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { Console } from 'node:console';
import { createHash } from 'node:crypto';
import { Writable } from 'node:stream';
import { describe, it } from 'node:test';
import util from 'node:util';

import {
  ECPAY_AIO_CREDIT_PROFILE,
  EcpayCreditCheckCode,
  EcpayServerRequest,
  buildCreditCheckoutForm,
  buildCreditDetailQuery,
  buildDoActionRequest,
  buildItemName,
  buildTradeInfoQuery,
  checkCreditAvailability,
  doActionWindow,
  formatTaipeiDateTime,
  nextDayCancelEarliest,
  parseCreditDetailResponse,
  parseDoActionResponse,
  parsePaymentBrowserReturn,
  parsePaymentNotification,
  parseTaipeiDateTime,
  parseTradeInfoResponse,
  planCreditRefund,
  type CreditSettlementStatus,
} from '../../modules/agent-commerce/providers/ecpay/aio-credit/index.js';
import {
  EcpayKeyPair,
  EcpayProtocolError,
  aio,
  dotnetUrlEncode,
  encodeForm,
  parseForm,
  type EcpayErrorCode,
} from '../../modules/agent-commerce/providers/ecpay/index.js';
import {
  AIO_CREDIT_GOLDEN_MERCHANT_ID,
  AIO_CREDIT_GOLDEN_TRADE_NO,
  CHECKOUT_COMMON_BASE,
  CHECKOUT_FORBIDDEN_FIELDS,
  CHECKOUT_GOLDEN_VECTORS,
  CREDIT_DETAIL_GOLDEN_VECTOR,
  DO_ACTION_GOLDEN_VECTOR,
  QUERY_GOLDEN_VECTOR,
} from '../worker/ecpay-fixtures/aio-credit-vectors.js';
import {
  ALL_STAGE_KEY_STRINGS,
  CHECKMAC_VECTORS,
  STAGE_KEYS,
} from '../worker/ecpay-fixtures/vectors.js';

const collectedErrors: EcpayProtocolError[] = [];
const TEST_URLS = [
  CHECKOUT_COMMON_BASE.returnUrl,
  CHECKOUT_COMMON_BASE.orderResultUrl,
  CHECKOUT_COMMON_BASE.clientBackUrl,
  'https://freedom.example.com',
];
const sensitiveSnippets = new Set<string>([
  ...ALL_STAGE_KEY_STRINGS,
  STAGE_KEYS.aio3002607.creditCheckCode,
  ...TEST_URLS,
  AIO_CREDIT_GOLDEN_TRADE_NO,
  '777777',
  '9876',
  '431195',
]);

function expectProtocolError(fn: () => unknown, expectedCode: EcpayErrorCode): EcpayProtocolError {
  let caught: unknown;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  assert.ok(
    caught instanceof EcpayProtocolError,
    `Expected EcpayProtocolError(${expectedCode}), got ${String(caught)}`,
  );
  assert.equal(caught.code, expectedCode);
  assert.equal(caught.name, 'EcpayProtocolError');
  assert.equal(caught.cause, undefined);
  collectedErrors.push(caught);
  return caught;
}

describe('ECPay AIO credit-card protocol layer (ecpay.aio.credit.v1)', () => {
  const stageKeys = EcpayKeyPair.of(STAGE_KEYS.aio3002607.hashKey, STAGE_KEYS.aio3002607.hashIV);
  const stageCheckCode = EcpayCreditCheckCode.of(STAGE_KEYS.aio3002607.creditCheckCode);

  it('proves all 7 golden vectors (checkout, query, DoAction, credit-detail) and field ordering', () => {
    assert.equal(ECPAY_AIO_CREDIT_PROFILE, 'ecpay.aio.credit.v1');

    for (const vec of CHECKOUT_GOLDEN_VECTORS) {
      const form = buildCreditCheckoutForm(vec.input, stageKeys);

      assert.equal(Object.isFrozen(form), true);
      assert.equal(Object.isFrozen(form.fields), true);
      for (const tuple of form.fields) {
        assert.equal(Object.isFrozen(tuple), true);
      }

      assert.equal(form.action, vec.expectedAction);
      assert.deepEqual(form.fields, vec.expectedFields);

      const fieldKeys = new Set(form.fields.map(([k]) => k));
      for (const forbidden of CHECKOUT_FORBIDDEN_FIELDS) {
        assert.equal(
          fieldKeys.has(forbidden),
          false,
          `Forbidden field ${forbidden} present in ${vec.id}`,
        );
      }

      const encoded = encodeForm(form.fields);
      const verified = aio.verify(encoded, stageKeys);
      assert.equal(verified.ok, true, `aio.verify rejected golden ${vec.id}`);
    }

    // Live environment checkout action
    const liveForm = buildCreditCheckoutForm(
      {
        ...CHECKOUT_COMMON_BASE,
        environment: 'live',
        createdAtEpochMs: CHECKOUT_GOLDEN_VECTORS[0].input.createdAtEpochMs,
      },
      stageKeys,
    );
    assert.equal(liveForm.action, 'https://payment.ecpay.com.tw/Cashier/AioCheckOut/V5');

    // Golden 5: QueryTradeInfo/V5
    const queryReq = buildTradeInfoQuery(QUERY_GOLDEN_VECTOR.input, stageKeys);
    assert.equal(queryReq.method, 'POST');
    assert.equal(queryReq.url, QUERY_GOLDEN_VECTOR.expectedUrl);
    assert.equal(queryReq.contentType, 'application/x-www-form-urlencoded');
    assert.deepEqual(
      parseForm(queryReq.bodyText()),
      QUERY_GOLDEN_VECTOR.expectedFields,
    );
    assert.equal(queryReq.bodyText(), encodeForm(QUERY_GOLDEN_VECTOR.expectedFields));
    assert.equal(aio.verify(queryReq.bodyText(), stageKeys).ok, true);

    // Golden 6: DoAction
    const doActionReq = buildDoActionRequest(DO_ACTION_GOLDEN_VECTOR.input, stageKeys);
    assert.equal(doActionReq.method, 'POST');
    assert.equal(doActionReq.url, DO_ACTION_GOLDEN_VECTOR.expectedUrl);
    assert.equal(doActionReq.bodyText(), encodeForm(DO_ACTION_GOLDEN_VECTOR.expectedFields));
    assert.equal(aio.verify(doActionReq.bodyText(), stageKeys).ok, true);

    // Golden 7: CreditDetail/QueryTrade/V2
    const detailReq = buildCreditDetailQuery(
      CREDIT_DETAIL_GOLDEN_VECTOR.input,
      stageKeys,
      stageCheckCode,
    );
    assert.equal(detailReq.method, 'POST');
    assert.equal(detailReq.url, CREDIT_DETAIL_GOLDEN_VECTOR.expectedUrl);
    assert.equal(detailReq.bodyText(), encodeForm(CREDIT_DETAIL_GOLDEN_VECTOR.expectedFields));
    assert.equal(aio.verify(detailReq.bodyText(), stageKeys).ok, true);
  });

  it('enforces checkCreditAvailability reasons, precedence and input validation', () => {
    // 1. currency !== 'TWD' takes precedence over non-whole amounts and below-minimum total
    const nonTwd = checkCreditAvailability({
      currency: 'USD',
      totalMinor: 350,
      amountsMinor: [125, 225],
    });
    assert.deepEqual(nonTwd, { available: false, reason: 'currency_not_supported' });
    assert.equal(Object.isFrozen(nonTwd), true);

    // 2. totalMinor not whole TWD takes precedence over below-minimum
    const oddTotal = checkCreditAvailability({
      currency: 'TWD',
      totalMinor: 150050,
      amountsMinor: [150000],
    });
    assert.deepEqual(oddTotal, { available: false, reason: 'amount_not_whole_twd' });

    const oddSmallTotal = checkCreditAvailability({
      currency: 'TWD',
      totalMinor: 450,
      amountsMinor: [400],
    });
    assert.deepEqual(oddSmallTotal, { available: false, reason: 'amount_not_whole_twd' });

    // 3. line amount of 50 with a whole total -> amount_not_whole_twd
    const oddLine = checkCreditAvailability({
      currency: 'TWD',
      totalMinor: 150000,
      amountsMinor: [100000, 50, 49950],
    });
    assert.deepEqual(oddLine, { available: false, reason: 'amount_not_whole_twd' });

    // 4. totalMinor < 500 -> amount_below_minimum
    const belowMin = checkCreditAvailability({
      currency: 'TWD',
      totalMinor: 400,
      amountsMinor: [400, 0],
    });
    assert.deepEqual(belowMin, { available: false, reason: 'amount_below_minimum' });

    const zeroTotal = checkCreditAvailability({
      currency: 'TWD',
      totalMinor: 0,
      amountsMinor: [0],
    });
    assert.deepEqual(zeroTotal, { available: false, reason: 'amount_below_minimum' });

    // 5. 500 available
    const ok500 = checkCreditAvailability({
      currency: 'TWD',
      totalMinor: 500,
      amountsMinor: [500, 0],
    });
    assert.deepEqual(ok500, { available: true });
    assert.equal(Object.isFrozen(ok500), true);

    // 6. totalMinor above 999,999,999 TWD -> amount_above_maximum, after the other reasons
    assert.deepEqual(
      checkCreditAvailability({
        currency: 'TWD',
        totalMinor: 99999999900,
        amountsMinor: [99999999900, 0],
      }),
      { available: true },
    );
    const aboveMax = checkCreditAvailability({
      currency: 'TWD',
      totalMinor: 100000000000,
      amountsMinor: [100000000000, 0],
    });
    assert.deepEqual(aboveMax, { available: false, reason: 'amount_above_maximum' });
    assert.equal(Object.isFrozen(aboveMax), true);
    assert.deepEqual(
      checkCreditAvailability({ currency: 'USD', totalMinor: 100000000000, amountsMinor: [] }),
      { available: false, reason: 'currency_not_supported' },
    );
    assert.deepEqual(
      checkCreditAvailability({ currency: 'TWD', totalMinor: 100000000050, amountsMinor: [] }),
      { available: false, reason: 'amount_not_whole_twd' },
    );

    // Invalid inputs throw invalid_input
    expectProtocolError(
      () => checkCreditAvailability({ currency: 'TWD', totalMinor: -100, amountsMinor: [] }),
      'invalid_input',
    );
    expectProtocolError(
      () => checkCreditAvailability({ currency: 'TWD', totalMinor: 500.5, amountsMinor: [] }),
      'invalid_input',
    );
    expectProtocolError(
      () =>
        checkCreditAvailability({
          currency: 'TWD',
          totalMinor: Number.MAX_SAFE_INTEGER + 1,
          amountsMinor: [],
        }),
      'invalid_input',
    );
    expectProtocolError(
      () => checkCreditAvailability({ currency: 'TWD', totalMinor: 1000, amountsMinor: [-100] }),
      'invalid_input',
    );
    expectProtocolError(
      () => checkCreditAvailability({ currency: 'TWD', totalMinor: 1000, amountsMinor: [NaN] }),
      'invalid_input',
    );
    expectProtocolError(
      () =>
        checkCreditAvailability({
          currency: 'TWD',
          totalMinor: 1000,
          amountsMinor: 'not-array' as unknown as number[],
        }),
      'invalid_input',
    );
  });

  it('handles Asia/Taipei date-time formatting, parsing, DoAction window and next-day cancel boundaries', () => {
    // UTC 15:59:59.999 vs 16:00:00.000 crossing the Taipei date
    const beforeMidnightTaipei = Date.UTC(2026, 9, 14, 15, 59, 59, 999);
    const atMidnightTaipei = Date.UTC(2026, 9, 14, 16, 0, 0, 0);
    assert.equal(formatTaipeiDateTime(beforeMidnightTaipei), '2026/10/14 23:59:59');
    assert.equal(formatTaipeiDateTime(atMidnightTaipei), '2026/10/15 00:00:00');

    // Leap day 2028/02/29
    const leapDayTaipei = Date.UTC(2028, 1, 29, 4, 5, 6);
    assert.equal(formatTaipeiDateTime(leapDayTaipei), '2028/02/29 12:05:06');
    assert.equal(parseTaipeiDateTime('2028/02/29 12:05:06'), leapDayTaipei);

    // Exact bounds Date.UTC(2000,0,1) and Date.UTC(2100,0,1)
    assert.equal(formatTaipeiDateTime(Date.UTC(2000, 0, 1)), '2000/01/01 08:00:00');
    assert.equal(formatTaipeiDateTime(Date.UTC(2100, 0, 1)), '2100/01/01 08:00:00');

    // Out-of-range throws invalid_input
    expectProtocolError(() => formatTaipeiDateTime(Date.UTC(2000, 0, 1) - 1), 'invalid_input');
    expectProtocolError(() => formatTaipeiDateTime(Date.UTC(2100, 0, 1) + 1), 'invalid_input');
    expectProtocolError(() => formatTaipeiDateTime(1792026123000.5), 'invalid_input');
    expectProtocolError(() => formatTaipeiDateTime(NaN), 'invalid_input');

    // Round-trip
    for (const text of [
      '2026/10/15 09:02:03',
      '2026/10/15 00:00:00',
      '2026/10/15 23:59:59',
      '2027/01/01 00:00:00',
      '2024/02/29 23:59:59',
    ]) {
      const parsed = parseTaipeiDateTime(text);
      assert.notEqual(parsed, null);
      assert.equal(formatTaipeiDateTime(parsed!), text);
    }

    // parseTaipeiDateTime rejections
    for (const invalidText of [
      '2023/02/29 00:00:00', // non-leap year
      '2100/02/29 00:00:00', // century non-leap year
      '2026/13/01 00:00:00', // month 13
      '2026/00/01 00:00:00', // month 0
      '2026/04/31 00:00:00', // April 31
      '2026/10/00 00:00:00', // day 0
      '2026/10/15 24:00:00', // hour 24
      '2026/10/15 00:60:00', // minute 60
      '2026/10/15 00:00:60', // second 60
      '2026-10-15 09:02:03', // dashes
      '2026/10/15 09:02:03 ', // trailing space
      ' 2026/10/15 09:02:03', // leading space
      '', // empty
    ]) {
      assert.equal(parseTaipeiDateTime(invalidText), null, `Expected null for ${invalidText}`);
    }

    // doActionWindow boundaries:
    // 2026/10/15 20:15:00 Taipei = 2026-10-15T12:15:00.000Z
    // 2026/10/15 20:31:00 Taipei = 2026-10-15T12:31:00.000Z
    const t2015 = Date.UTC(2026, 9, 15, 12, 15, 0, 0);
    const t2031 = Date.UTC(2026, 9, 15, 12, 31, 0, 0);

    assert.deepEqual(doActionWindow(t2015 - 1), { allowed: true });
    assert.deepEqual(doActionWindow(t2015), { allowed: false, retryAtEpochMs: t2031 });
    assert.deepEqual(doActionWindow(t2031 - 1), { allowed: false, retryAtEpochMs: t2031 });
    assert.deepEqual(doActionWindow(t2031), { allowed: true });
    assert.equal(Object.isFrozen(doActionWindow(t2015)), true);
    expectProtocolError(() => doActionWindow(NaN), 'invalid_input');

    // nextDayCancelEarliest:
    // 2026/10/15 00:00:01 Taipei -> 2026/10/16 06:00:00 Taipei
    const authEarly = parseTaipeiDateTime('2026/10/15 00:00:01')!;
    const authLate = parseTaipeiDateTime('2026/10/15 23:59:59')!;
    const expectedOct16At06 = parseTaipeiDateTime('2026/10/16 06:00:00')!;
    assert.equal(nextDayCancelEarliest(authEarly), expectedOct16At06);
    assert.equal(nextDayCancelEarliest(authLate), expectedOct16At06);

    // Month end and year end
    const authOctEnd = parseTaipeiDateTime('2026/10/31 23:59:59')!;
    assert.equal(
      nextDayCancelEarliest(authOctEnd),
      parseTaipeiDateTime('2026/11/01 06:00:00')!,
    );
    const authYearEnd = parseTaipeiDateTime('2026/12/31 23:59:59')!;
    assert.equal(
      nextDayCancelEarliest(authYearEnd),
      parseTaipeiDateTime('2027/01/01 06:00:00')!,
    );
    const authLeapFeb28 = parseTaipeiDateTime('2028/02/28 23:59:59')!;
    assert.equal(
      nextDayCancelEarliest(authLeapFeb28),
      parseTaipeiDateTime('2028/02/29 06:00:00')!,
    );
    expectProtocolError(() => nextDayCancelEarliest(NaN), 'invalid_input');
  });

  it('sanitises ItemName, enforces 200 UTF-16 code unit fallback and surrogate-safe store truncation', () => {
    // Every removed character class:
    // #, <, >, |, ;, `, C0 (U+0000-U+001F), DEL (U+007F), C1 (U+0080-U+009F),
    // lone surrogates, U+200B-U+200F, U+202A-U+202E, U+2060-U+206F, U+FEFF,
    // plus whitespace collapse (U+3000 ideographic space and U+00A0 NBSP)
    const dirtyName =
      ' \uFEFFA#\u0000B<\u001FC>\u007FD|\u0080E;\u009FF`G\uD800H\uDFFFI\u200BJ\u200FK\u202AL\u202EM\u2060N\u206FO\u3000\u00A0\t\nP ';
    const cleaned = buildItemName([{ name: dirtyName, quantity: 3 }], '合成小舖');
    assert.equal(cleaned, 'A B C D E F G H I J K L M N O P x3');
    assert.doesNotThrow(() => dotnetUrlEncode(cleaned));

    // Empty name or all-sanitised name becomes 商品
    assert.equal(
      buildItemName(
        [
          { name: '', quantity: 1 },
          { name: '#<>|;`\u0000\u200B\uFEFF   ', quantity: 2 },
        ],
        '合成小舖',
      ),
      '商品 x1#商品 x2',
    );

    // Exactly 200 UTF-16 code units kept vs 201 -> fallback
    // " x1" is 3 code units, so a 197-char name produces a 200-code-unit result
    const name197 = 'A'.repeat(197);
    const item200 = buildItemName([{ name: name197, quantity: 1 }], '合成小舖');
    assert.equal(item200.length, 200);
    assert.equal(item200, `${name197} x1`);

    const name198 = 'A'.repeat(198);
    const item201Fallback = buildItemName([{ name: name198, quantity: 1 }], '合成小舖');
    assert.equal(item201Fallback, '合成小舖商品一批 x1');

    // Surrogate-safe store-name cut: 45 astral emoji (each 1 code point = 2 UTF-16 code units)
    const astralStore = '🎁'.repeat(45);
    const astralFallback = buildItemName([{ name: name198, quantity: 1 }], astralStore);
    const expectedStore40 = '🎁'.repeat(40);
    assert.equal(astralFallback, `${expectedStore40}商品一批 x1`);
    assert.doesNotThrow(() => dotnetUrlEncode(astralFallback));

    // Empty or all-removed store name -> 商品一批 x1
    assert.equal(buildItemName([{ name: name198, quantity: 1 }], '   #<>|;` '), '商品一批 x1');

    // Never contains # except as line separator
    const multiLine = buildItemName(
      [
        { name: 'Item#One', quantity: 1 },
        { name: 'Item#Two', quantity: 2 },
      ],
      'Store#Name',
    );
    assert.equal(multiLine, 'Item One x1#Item Two x2');
    assert.equal(multiLine.split('#').length, 2);

    // Invalid quantities and line counts throw invalid_input
    expectProtocolError(() => buildItemName([], '合成小舖'), 'invalid_input');
    expectProtocolError(
      () =>
        buildItemName(
          Array.from({ length: 201 }, () => ({ name: 'A', quantity: 1 })),
          '合成小舖',
        ),
      'invalid_input',
    );
    expectProtocolError(
      () => buildItemName([{ name: 'A', quantity: 0 }], '合成小舖'),
      'invalid_input',
    );
    expectProtocolError(
      () => buildItemName([{ name: 'A', quantity: 10000 }], '合成小舖'),
      'invalid_input',
    );
    expectProtocolError(
      () => buildItemName([{ name: 'A', quantity: 1.5 }], 'invalid_input'),
      'invalid_input',
    );
  });

  it('rejects invalid URLs and fields in buildCreditCheckoutForm', () => {
    const validBase = {
      ...CHECKOUT_COMMON_BASE,
      createdAtEpochMs: CHECKOUT_GOLDEN_VECTORS[0].input.createdAtEpochMs,
    };

    // URL length exactly 200 is allowed, 201 is rejected
    const prefix = 'https://freedom.example.com/';
    const url200 = prefix + 'a'.repeat(200 - prefix.length);
    assert.equal(url200.length, 200);
    assert.doesNotThrow(() =>
      buildCreditCheckoutForm({ ...validBase, returnUrl: url200 }, stageKeys),
    );
    const url201 = url200 + 'a';
    assert.equal(url201.length, 201);

    const badUrls = [
      'http://freedom.example.com/cb', // http:
      'https://freedom.example.com:8443/cb', // explicit non-default port
      'https://freedom.example.com:443/cb', // non-canonical default port
      'https://user@freedom.example.com/cb', // username
      'https://user:pass@freedom.example.com/cb', // username + password
      'https://freedom.example.com/cb#frag', // fragment
      'https://127.0.0.1/cb', // IPv4
      'https://host.123/cb', // all-digit last label
      'https://[::1]/cb', // IPv6
      'https://localhost/cb', // single-label host
      'https://-bad.example.com/cb', // leading hyphen label
      'https://bad-.example.com/cb', // trailing hyphen label
      'https://freedom.example.com/cb?a=1&b=2', // &
      'https://freedom.example.com/cb?a=1%26b=2', // %26
      'https://freedom.example.com/cb?a=%3c', // %3c
      'https://freedom.example.com/cb?a=%3C', // %3C
      'https://freedom.example.com/cb<x>', // < >
      'https://freedom.example.com/cb"x', // "
      "https://freedom.example.com/cb'x", // '
      'https://freedom.example.com/cb x', // space
      'https://Freedom.example.com/x', // non-canonical uppercase host
      'https://freedom.example.com', // non-canonical missing trailing slash
      url201, // 201 characters
    ];

    for (const badUrl of badUrls) {
      expectProtocolError(
        () => buildCreditCheckoutForm({ ...validBase, returnUrl: badUrl }, stageKeys),
        'invalid_input',
      );
      expectProtocolError(
        () => buildCreditCheckoutForm({ ...validBase, orderResultUrl: badUrl }, stageKeys),
        'invalid_input',
      );
      expectProtocolError(
        () => buildCreditCheckoutForm({ ...validBase, clientBackUrl: badUrl }, stageKeys),
        'invalid_input',
      );
    }

    // Bad merchantTradeNo (L... prefix, lowercase)
    expectProtocolError(
      () =>
        buildCreditCheckoutForm(
          { ...validBase, merchantTradeNo: 'LVTPVXVR14D2PF2DBSQQ' },
          stageKeys,
        ),
      'invalid_input',
    );
    expectProtocolError(
      () =>
        buildCreditCheckoutForm(
          { ...validBase, merchantTradeNo: 'fvtpvxvr14d2pf2dbsqq' },
          stageKeys,
        ),
      'invalid_input',
    );

    // Bad merchantId
    expectProtocolError(
      () => buildCreditCheckoutForm({ ...validBase, merchantId: '123456' }, stageKeys),
      'invalid_input',
    );

    // Bad displayNumber
    for (const badDisplay of ['261015-7K3QPI', '261015-7k3qpz', '26101-7K3QPZ', '261015_7K3QPZ']) {
      expectProtocolError(
        () => buildCreditCheckoutForm({ ...validBase, displayNumber: badDisplay }, stageKeys),
        'invalid_input',
      );
    }

    // Bad currency
    expectProtocolError(
      () => buildCreditCheckoutForm({ ...validBase, currency: 'USD' }, stageKeys),
      'invalid_input',
    );

    // Bad totalMinor: 150050 (not whole TWD), 400 (< 500), above 999,999,999 TWD (100000000000,
    // and the Int32 cap 214748364800)
    expectProtocolError(
      () => buildCreditCheckoutForm({ ...validBase, totalMinor: 150050 }, stageKeys),
      'invalid_input',
    );
    expectProtocolError(
      () => buildCreditCheckoutForm({ ...validBase, totalMinor: 400 }, stageKeys),
      'invalid_input',
    );
    for (const tooLarge of [100000000000, 214748364800]) {
      expectProtocolError(
        () => buildCreditCheckoutForm({ ...validBase, totalMinor: tooLarge }, stageKeys),
        'invalid_input',
      );
    }

    // Unknown environment
    expectProtocolError(
      () =>
        buildCreditCheckoutForm(
          { ...validBase, environment: 'staging' as unknown as 'sandbox' },
          stageKeys,
        ),
      'invalid_input',
    );
  });

  it('keeps one amount range from availability and the form to notifications, credit detail and refunds', () => {
    const largest = 99999999900;
    const tooLarge = largest + 100;
    const base = {
      ...CHECKOUT_COMMON_BASE,
      createdAtEpochMs: CHECKOUT_GOLDEN_VECTORS[0].input.createdAtEpochMs,
    };

    // The largest form amount comes back in a signed notification as paid
    const form = Object.fromEntries(
      buildCreditCheckoutForm({ ...base, totalMinor: largest }, stageKeys).fields,
    );
    assert.equal(form.TotalAmount, '999999999');
    const returnVec = CHECKMAC_VECTORS.find((v) => v.id === 'aio-return')!;
    const notified = parsePaymentNotification(
      encodeForm(
        aio.sign(
          returnVec.fields.map(([name, value]): readonly [string, string] => [
            name,
            name === 'TradeAmt' ? form.TotalAmount : value,
          ]),
          stageKeys,
        ),
      ),
      stageKeys,
      { merchantId: AIO_CREDIT_GOLDEN_MERCHANT_ID },
    );
    assert.equal(notified.kind, 'notification');
    if (notified.kind === 'notification') {
      assert.equal(notified.outcome, 'paid');
      assert.equal(notified.tradeAmtMinor, largest);
    }

    // One TWD more: unavailable before placement, and no form, query or refund carries it
    assert.deepEqual(
      checkCreditAvailability({ currency: 'TWD', totalMinor: tooLarge, amountsMinor: [tooLarge] }),
      { available: false, reason: 'amount_above_maximum' },
    );
    expectProtocolError(
      () => buildCreditCheckoutForm({ ...base, totalMinor: tooLarge }, stageKeys),
      'invalid_input',
    );
    const detail = {
      environment: 'live' as const,
      merchantId: AIO_CREDIT_GOLDEN_MERCHANT_ID,
      gwsr: '11943021',
    };
    assert.doesNotThrow(() =>
      buildCreditDetailQuery({ ...detail, amountMinor: largest }, stageKeys, stageCheckCode),
    );
    expectProtocolError(
      () => buildCreditDetailQuery({ ...detail, amountMinor: tooLarge }, stageKeys, stageCheckCode),
      'invalid_input',
    );
    expectProtocolError(
      () => parseCreditDetailResponse('{}', { expectedAmountMinor: tooLarge }),
      'invalid_input',
    );
    assert.equal(
      planCreditRefund({
        status: 'authorized',
        paidMinor: largest,
        refundedMinor: 0,
        requestedMinor: largest,
      }).kind,
      'plan',
    );
    expectProtocolError(
      () =>
        planCreditRefund({
          status: 'authorized',
          paidMinor: tooLarge,
          refundedMinor: 0,
          requestedMinor: largest,
        }),
      'invalid_input',
    );
    expectProtocolError(
      () =>
        planCreditRefund({
          status: 'authorized',
          paidMinor: largest,
          refundedMinor: 0,
          requestedMinor: tooLarge,
        }),
      'invalid_input',
    );
    const doAction = {
      environment: 'live' as const,
      merchantId: AIO_CREDIT_GOLDEN_MERCHANT_ID,
      merchantTradeNo: AIO_CREDIT_GOLDEN_TRADE_NO,
      tradeNo: '2610150902037371',
      action: 'R' as const,
    };
    assert.doesNotThrow(() => buildDoActionRequest({ ...doAction, amountMinor: largest }, stageKeys));
    expectProtocolError(
      () => buildDoActionRequest({ ...doAction, amountMinor: tooLarge }, stageKeys),
      'invalid_input',
    );
  });

  it('parses payment notifications: 2878 vector, case insensitivity, PAN stripping, outcomes, fees and bodySha256', () => {
    const returnVec = CHECKMAC_VECTORS.find((v) => v.id === 'aio-return')!;
    const signed2878 = encodeForm(aio.sign(returnVec.fields, stageKeys));
    const expectedSha256 = createHash('sha256').update(Buffer.from(signed2878, 'utf8')).digest('hex');

    const parsed = parsePaymentNotification(signed2878, stageKeys, {
      merchantId: AIO_CREDIT_GOLDEN_MERCHANT_ID,
    });
    assert.equal(Object.isFrozen(parsed), true);
    assert.equal(parsed.kind, 'notification');
    if (parsed.kind === 'notification') {
      assert.equal(Object.isFrozen(parsed.dedupe), true);
      assert.equal(parsed.outcome, 'paid');
      assert.equal(parsed.keyIndex, 0);
      assert.equal(parsed.merchantTradeNo, 'D9RMXNRIHUYM');
      assert.equal(parsed.tradeNo, '2412311225437371');
      assert.equal(parsed.rtnCode, '1');
      assert.equal(parsed.rtnMsg, '交易成功');
      assert.equal(parsed.tradeAmtMinor, 40200);
      assert.equal(parsed.paymentDate, '2024/12/31 12:26:09');
      assert.equal(parsed.paymentDateEpochMs, parseTaipeiDateTime('2024/12/31 12:26:09'));
      assert.equal(parsed.tradeDate, '2024/12/31 12:25:43');
      assert.equal(parsed.paymentType, 'Credit_CreditCard');
      assert.equal(parsed.chargeFeeMinor, 1000);
      assert.equal(parsed.gwsr, null);
      assert.equal(parsed.bodySha256, expectedSha256);
      assert.deepEqual(parsed.dedupe, {
        merchantTradeNo: 'D9RMXNRIHUYM',
        tradeNo: '2412311225437371',
        rtnCode: '1',
        simulatePaid: '0',
        paymentDate: '2024/12/31 12:26:09',
      });
    }

    // Uint8Array input produces identical result and bodySha256
    const bytesInput = new TextEncoder().encode(signed2878);
    const parsedFromBytes = parsePaymentNotification(bytesInput, stageKeys, {
      merchantId: AIO_CREDIT_GOLDEN_MERCHANT_ID,
    });
    assert.deepEqual(parsedFromBytes, parsed);

    // Lower-cased MerchantTradeNo -> same dedupe and same MAC acceptance
    const lowerBody = signed2878.replace('MerchantTradeNo=D9RMXNrihUYM', 'MerchantTradeNo=d9rmxnrihuym');
    const parsedLower = parsePaymentNotification(lowerBody, stageKeys, {
      merchantId: AIO_CREDIT_GOLDEN_MERCHANT_ID,
    });
    assert.equal(parsedLower.kind, 'notification');
    if (parsedLower.kind === 'notification' && parsed.kind === 'notification') {
      assert.equal(parsedLower.merchantTradeNo, 'D9RMXNRIHUYM');
      assert.deepEqual(parsedLower.dedupe, parsed.dedupe);
    }

    // NeedExtraPaidInfo=Y extras notification: gwsr kept, card6no/card4no/auth_code never returned
    const extrasBody = encodeForm(
      aio.sign(
        [
          ...returnVec.fields,
          ['gwsr', '11943021'],
          ['auth_code', '777777'],
          ['card4no', '9876'],
          ['card6no', '431195'],
          ['eci', '5'],
          ['process_date', '2024/06/13 14:42:08'],
          ['amount', '402'],
          ['stage', '0'],
          ['stast', '0'],
          ['staed', '0'],
          ['red_dan', '0'],
        ],
        stageKeys,
      ),
    );
    const parsedExtras = parsePaymentNotification(extrasBody, stageKeys, {
      merchantId: AIO_CREDIT_GOLDEN_MERCHANT_ID,
    });
    assert.equal(parsedExtras.kind, 'notification');
    if (parsedExtras.kind === 'notification') {
      assert.equal(parsedExtras.gwsr, '11943021');
      const serialized = JSON.stringify(parsedExtras);
      assert.equal(serialized.includes('777777'), false);
      assert.equal(serialized.includes('9876'), false);
      assert.equal(serialized.includes('431195'), false);
      assert.equal('card4no' in parsedExtras, false);
      assert.equal('card6no' in parsedExtras, false);
      assert.equal('auth_code' in parsedExtras, false);
    }

    const baseObj = Object.fromEntries(returnVec.fields);

    // SimulatePaid=1 with RtnCode=1 -> simulated
    const simBody = encodeForm(
      aio.sign({ ...baseObj, SimulatePaid: '1', RtnCode: '1' }, stageKeys),
    );
    const parsedSim = parsePaymentNotification(simBody, stageKeys, {
      merchantId: AIO_CREDIT_GOLDEN_MERCHANT_ID,
    });
    assert.equal(parsedSim.kind, 'notification');
    if (parsedSim.kind === 'notification') {
      assert.equal(parsedSim.outcome, 'simulated');
      assert.equal(parsedSim.dedupe.simulatePaid, '1');
    }

    // RtnCode=10300066 -> pending_confirmation
    const pendingBody = encodeForm(
      aio.sign({ ...baseObj, RtnCode: '10300066', PaymentDate: '' }, stageKeys),
    );
    const parsedPending = parsePaymentNotification(pendingBody, stageKeys, {
      merchantId: AIO_CREDIT_GOLDEN_MERCHANT_ID,
    });
    assert.equal(parsedPending.kind, 'notification');
    if (parsedPending.kind === 'notification') {
      assert.equal(parsedPending.outcome, 'pending_confirmation');
      assert.equal(parsedPending.paymentDate, null);
      assert.equal(parsedPending.paymentDateEpochMs, null);
    }

    // RtnCode=10100248 with empty PaymentDate -> failed
    const failedBody = encodeForm(
      aio.sign({ ...baseObj, RtnCode: '10100248', PaymentDate: '', TradeNo: '' }, stageKeys),
    );
    const parsedFailed = parsePaymentNotification(failedBody, stageKeys, {
      merchantId: AIO_CREDIT_GOLDEN_MERCHANT_ID,
    });
    assert.equal(parsedFailed.kind, 'notification');
    if (parsedFailed.kind === 'notification') {
      assert.equal(parsedFailed.outcome, 'failed');
      assert.equal(parsedFailed.tradeNo, null);
      assert.equal(parsedFailed.paymentDate, null);
    }

    // RtnCode=1 with empty TradeNo -> missing_field TradeNo
    const missingTradeNoBody = encodeForm(
      aio.sign({ ...baseObj, RtnCode: '1', TradeNo: '' }, stageKeys),
    );
    assert.deepEqual(
      parsePaymentNotification(missingTradeNoBody, stageKeys, {
        merchantId: AIO_CREDIT_GOLDEN_MERCHANT_ID,
      }),
      { kind: 'invalid', reason: 'missing_field', field: 'TradeNo' },
    );

    // RtnCode=1 with empty PaymentDate -> missing_field PaymentDate
    const missingPaymentDateBody = encodeForm(
      aio.sign({ ...baseObj, RtnCode: '1', PaymentDate: '' }, stageKeys),
    );
    assert.deepEqual(
      parsePaymentNotification(missingPaymentDateBody, stageKeys, {
        merchantId: AIO_CREDIT_GOLDEN_MERCHANT_ID,
      }),
      { kind: 'invalid', reason: 'missing_field', field: 'PaymentDate' },
    );

    // Merchant mismatch
    assert.deepEqual(
      parsePaymentNotification(signed2878, stageKeys, { merchantId: '2000132' }),
      { kind: 'invalid', reason: 'merchant_mismatch' },
    );

    // PlatformID=3002599 -> platform_mismatch
    const platformBody = encodeForm(
      aio.sign({ ...baseObj, PlatformID: '3002599' }, stageKeys),
    );
    assert.deepEqual(
      parsePaymentNotification(platformBody, stageKeys, {
        merchantId: AIO_CREDIT_GOLDEN_MERCHANT_ID,
      }),
      { kind: 'invalid', reason: 'platform_mismatch' },
    );

    // PlatformID= empty accepted
    const emptyPlatformBody = encodeForm(
      aio.sign({ ...baseObj, PlatformID: '' }, stageKeys),
    );
    assert.equal(
      parsePaymentNotification(emptyPlatformBody, stageKeys, {
        merchantId: AIO_CREDIT_GOLDEN_MERCHANT_ID,
      }).kind,
      'notification',
    );

    // Tampered TradeAmt -> mac_mismatch
    const tamperedBody = signed2878.replace('TradeAmt=402', 'TradeAmt=999');
    assert.deepEqual(
      parsePaymentNotification(tamperedBody, stageKeys, {
        merchantId: AIO_CREDIT_GOLDEN_MERCHANT_ID,
      }),
      { kind: 'invalid', reason: 'mac_mismatch' },
    );

    // Key rotation [oldKeys, stageKeys] -> keyIndex 1
    const oldKeys = EcpayKeyPair.of(STAGE_KEYS.invoice2000132.hashKey, STAGE_KEYS.invoice2000132.hashIV);
    const rotated = parsePaymentNotification(signed2878, [oldKeys, stageKeys], {
      merchantId: AIO_CREDIT_GOLDEN_MERCHANT_ID,
    });
    assert.equal(rotated.kind, 'notification');
    if (rotated.kind === 'notification') {
      assert.equal(rotated.keyIndex, 1);
    }

    // PaymentTypeChargeFee 10.5 -> 1050, abc -> null while outcome is still paid
    const fee105Body = encodeForm(
      aio.sign({ ...baseObj, PaymentTypeChargeFee: '10.5' }, stageKeys),
    );
    const parsedFee105 = parsePaymentNotification(fee105Body, stageKeys, {
      merchantId: AIO_CREDIT_GOLDEN_MERCHANT_ID,
    });
    assert.equal(parsedFee105.kind, 'notification');
    if (parsedFee105.kind === 'notification') {
      assert.equal(parsedFee105.outcome, 'paid');
      assert.equal(parsedFee105.chargeFeeMinor, 1050);
    }

    const feeAbcBody = encodeForm(
      aio.sign({ ...baseObj, PaymentTypeChargeFee: 'abc' }, stageKeys),
    );
    const parsedFeeAbc = parsePaymentNotification(feeAbcBody, stageKeys, {
      merchantId: AIO_CREDIT_GOLDEN_MERCHANT_ID,
    });
    assert.equal(parsedFeeAbc.kind, 'notification');
    if (parsedFeeAbc.kind === 'notification') {
      assert.equal(parsedFeeAbc.outcome, 'paid');
      assert.equal(parsedFeeAbc.chargeFeeMinor, null);
    }
  });

  it('parses browser returns with no outcome, amount or code', () => {
    const returnVec = CHECKMAC_VECTORS.find((v) => v.id === 'aio-return')!;
    const signed2878 = encodeForm(aio.sign(returnVec.fields, stageKeys));

    const browserReturn = parsePaymentBrowserReturn(signed2878, stageKeys, {
      merchantId: AIO_CREDIT_GOLDEN_MERCHANT_ID,
    });
    assert.equal(Object.isFrozen(browserReturn), true);
    assert.deepEqual(browserReturn, {
      kind: 'return',
      merchantTradeNo: 'D9RMXNRIHUYM',
      keyIndex: 0,
    });
    assert.deepEqual(Object.keys(browserReturn).sort(), ['keyIndex', 'kind', 'merchantTradeNo']);

    // Invalid MAC -> invalid
    const tampered = signed2878.replace('TradeAmt=402', 'TradeAmt=999');
    assert.deepEqual(
      parsePaymentBrowserReturn(tampered, stageKeys, { merchantId: AIO_CREDIT_GOLDEN_MERCHANT_ID }),
      { kind: 'invalid', reason: 'mac_mismatch' },
    );

    // Merchant mismatch -> invalid
    assert.deepEqual(
      parsePaymentBrowserReturn(signed2878, stageKeys, { merchantId: '2000132' }),
      { kind: 'invalid', reason: 'merchant_mismatch' },
    );
  });

  it('parses QueryTradeInfo/V5 responses across all outcomes and mismatches', () => {
    const baseFields = {
      MerchantID: AIO_CREDIT_GOLDEN_MERCHANT_ID,
      MerchantTradeNo: AIO_CREDIT_GOLDEN_TRADE_NO,
      StoreID: '',
      TradeNo: '2610150902037371',
      TradeAmt: '1500',
      PaymentDate: '2026/10/15 09:05:00',
      PaymentType: 'Credit_CreditCard',
      HandlingCharge: '27.5',
      PaymentTypeChargeFee: '30',
      TradeDate: '2026/10/15 09:02:03',
      TradeStatus: '1',
      ItemName: '合成測試 T恤 1 限定 x2',
      CustomField1: '',
      CustomField2: '',
      CustomField3: '',
      CustomField4: '',
    };

    const signQueryResp = (overrides: Record<string, string>) =>
      encodeForm(aio.sign({ ...baseFields, ...overrides }, stageKeys));

    // TradeStatus=1 matching -> paid with fees (HandlingCharge 27.5 -> 2750)
    const paidRes = parseTradeInfoResponse(signQueryResp({}), stageKeys, {
      merchantId: AIO_CREDIT_GOLDEN_MERCHANT_ID,
      merchantTradeNo: AIO_CREDIT_GOLDEN_TRADE_NO,
      expectedAmountMinor: 150000,
      expectedTradeNo: '2610150902037371',
    });
    assert.equal(Object.isFrozen(paidRes), true);
    assert.deepEqual(paidRes, {
      kind: 'paid',
      tradeNo: '2610150902037371',
      tradeAmtMinor: 150000,
      paymentDate: '2026/10/15 09:05:00',
      paymentDateEpochMs: parseTaipeiDateTime('2026/10/15 09:05:00'),
      paymentType: 'Credit_CreditCard',
      handlingChargeMinor: 2750,
      chargeFeeMinor: 3000,
      keyIndex: 0,
    });

    // The profile's largest amount reads back; one TWD more cannot be expected
    const largest = parseTradeInfoResponse(signQueryResp({ TradeAmt: '999999999' }), stageKeys, {
      merchantId: AIO_CREDIT_GOLDEN_MERCHANT_ID,
      merchantTradeNo: AIO_CREDIT_GOLDEN_TRADE_NO,
      expectedAmountMinor: 99999999900,
    });
    assert.equal(largest.kind, 'paid');
    if (largest.kind === 'paid') {
      assert.equal(largest.tradeAmtMinor, 99999999900);
    }
    expectProtocolError(
      () =>
        parseTradeInfoResponse(signQueryResp({ TradeAmt: '1000000000' }), stageKeys, {
          merchantId: AIO_CREDIT_GOLDEN_MERCHANT_ID,
          merchantTradeNo: AIO_CREDIT_GOLDEN_TRADE_NO,
          expectedAmountMinor: 100000000000,
        }),
      'invalid_input',
    );

    // Amount mismatch
    assert.deepEqual(
      parseTradeInfoResponse(signQueryResp({ TradeAmt: '1200' }), stageKeys, {
        merchantId: AIO_CREDIT_GOLDEN_MERCHANT_ID,
        merchantTradeNo: AIO_CREDIT_GOLDEN_TRADE_NO,
        expectedAmountMinor: 150000,
      }),
      {
        kind: 'amount_mismatch',
        tradeNo: '2610150902037371',
        tradeAmtMinor: 120000,
        keyIndex: 0,
      },
    );

    // expectedTradeNo mismatch
    assert.deepEqual(
      parseTradeInfoResponse(signQueryResp({}), stageKeys, {
        merchantId: AIO_CREDIT_GOLDEN_MERCHANT_ID,
        merchantTradeNo: AIO_CREDIT_GOLDEN_TRADE_NO,
        expectedAmountMinor: 150000,
        expectedTradeNo: '9999999999999999',
      }),
      {
        kind: 'trade_no_mismatch',
        tradeNo: '2610150902037371',
        keyIndex: 0,
      },
    );

    // TradeStatus=0 -> unpaid
    assert.deepEqual(
      parseTradeInfoResponse(signQueryResp({ TradeStatus: '0', PaymentDate: '' }), stageKeys, {
        merchantId: AIO_CREDIT_GOLDEN_MERCHANT_ID,
        merchantTradeNo: AIO_CREDIT_GOLDEN_TRADE_NO,
        expectedAmountMinor: 150000,
      }),
      { kind: 'unpaid', keyIndex: 0 },
    );

    // TradeStatus=10200095 -> failed
    assert.deepEqual(
      parseTradeInfoResponse(signQueryResp({ TradeStatus: '10200095', PaymentDate: '' }), stageKeys, {
        merchantId: AIO_CREDIT_GOLDEN_MERCHANT_ID,
        merchantTradeNo: AIO_CREDIT_GOLDEN_TRADE_NO,
        expectedAmountMinor: 150000,
      }),
      { kind: 'failed', keyIndex: 0 },
    );

    // TradeStatus=10200163 and empty -> unknown unrecognized_status
    assert.deepEqual(
      parseTradeInfoResponse(signQueryResp({ TradeStatus: '10200163' }), stageKeys, {
        merchantId: AIO_CREDIT_GOLDEN_MERCHANT_ID,
        merchantTradeNo: AIO_CREDIT_GOLDEN_TRADE_NO,
        expectedAmountMinor: 150000,
      }),
      { kind: 'unknown', reason: 'unrecognized_status', tradeStatus: '10200163' },
    );
    assert.deepEqual(
      parseTradeInfoResponse(signQueryResp({ TradeStatus: '' }), stageKeys, {
        merchantId: AIO_CREDIT_GOLDEN_MERCHANT_ID,
        merchantTradeNo: AIO_CREDIT_GOLDEN_TRADE_NO,
        expectedAmountMinor: 150000,
      }),
      { kind: 'unknown', reason: 'unrecognized_status' },
    );

    // Wrong MerchantTradeNo -> merchant_trade_no_mismatch
    assert.deepEqual(
      parseTradeInfoResponse(signQueryResp({ MerchantTradeNo: 'FOTHER00000000000000' }), stageKeys, {
        merchantId: AIO_CREDIT_GOLDEN_MERCHANT_ID,
        merchantTradeNo: AIO_CREDIT_GOLDEN_TRADE_NO,
        expectedAmountMinor: 150000,
      }),
      { kind: 'unknown', reason: 'merchant_trade_no_mismatch' },
    );

    // Bad MAC -> unknown mac_mismatch
    const tampered = signQueryResp({}).replace('TradeAmt=1500', 'TradeAmt=9999');
    assert.deepEqual(
      parseTradeInfoResponse(tampered, stageKeys, {
        merchantId: AIO_CREDIT_GOLDEN_MERCHANT_ID,
        merchantTradeNo: AIO_CREDIT_GOLDEN_TRADE_NO,
        expectedAmountMinor: 150000,
      }),
      { kind: 'unknown', reason: 'mac_mismatch' },
    );
  });

  it('validates and redacts EcpayCreditCheckCode and EcpayServerRequest, and parses QueryTrade/V2 responses', () => {
    // EcpayCreditCheckCode validation
    expectProtocolError(() => EcpayCreditCheckCode.of('1234567'), 'invalid_check_code');
    expectProtocolError(() => EcpayCreditCheckCode.of('123456789'), 'invalid_check_code');
    expectProtocolError(() => EcpayCreditCheckCode.of('abcdefgh'), 'invalid_check_code');
    expectProtocolError(() => EcpayCreditCheckCode.of(''), 'invalid_check_code');

    // EcpayCreditCheckCode redaction
    assert.equal(Object.isFrozen(EcpayCreditCheckCode), true);
    assert.equal(Object.isFrozen(EcpayCreditCheckCode.prototype), true);
    assert.equal(Object.isFrozen(stageCheckCode), true);
    assert.equal(stageCheckCode.toJSON(), '[redacted]');
    assert.equal(JSON.stringify(stageCheckCode), '"[redacted]"');
    assert.equal(String(stageCheckCode), '[redacted]');
    assert.equal(`${stageCheckCode}`, '[redacted]');
    assert.equal(util.inspect(stageCheckCode), 'EcpayCreditCheckCode [redacted]');
    assert.deepEqual(Object.keys(stageCheckCode), []);
    assert.deepEqual(Object.getOwnPropertyNames(stageCheckCode), []);
    assert.deepEqual(Object.getOwnPropertySymbols(stageCheckCode), []);

    // EcpayServerRequest redaction
    const detailReq = buildCreditDetailQuery(
      {
        environment: 'live',
        merchantId: AIO_CREDIT_GOLDEN_MERCHANT_ID,
        gwsr: '11943021',
        amountMinor: 150000,
      },
      stageKeys,
      stageCheckCode,
    );
    const checkCodeStr = STAGE_KEYS.aio3002607.creditCheckCode;
    assert.equal(JSON.stringify(detailReq).includes(checkCodeStr), false);
    assert.equal(String(detailReq).includes(checkCodeStr), false);
    assert.equal(util.inspect(detailReq).includes(checkCodeStr), false);
    assert.deepEqual(detailReq.toJSON(), {
      method: 'POST',
      url: 'https://payment.ecpay.com.tw/CreditDetail/QueryTrade/V2',
      contentType: 'application/x-www-form-urlencoded',
      body: '[redacted]',
    });
    assert.equal(
      String(detailReq),
      'EcpayServerRequest POST https://payment.ecpay.com.tw/CreditDetail/QueryTrade/V2 [body redacted]',
    );
    assert.equal(detailReq.bodyText().includes(checkCodeStr), true);

    // Console log check on both stageCheckCode and detailReq
    const chunks: string[] = [];
    const sink = new Writable({
      write(chunk, _enc, cb) {
        chunks.push(Buffer.from(chunk).toString('utf8'));
        cb();
      },
    });
    const testConsole = new Console({ stdout: sink, stderr: sink });
    testConsole.log(stageCheckCode, detailReq);
    const consoleOut = chunks.join('');
    assert.equal(consoleOut.includes(checkCodeStr), false);

    // Sandbox environment rejected for CreditDetail
    expectProtocolError(
      () =>
        buildCreditDetailQuery(
          {
            environment: 'sandbox',
            merchantId: AIO_CREDIT_GOLDEN_MERCHANT_ID,
            gwsr: '11943021',
            amountMinor: 150000,
          },
          stageKeys,
          stageCheckCode,
        ),
      'unsupported_environment',
    );

    // parseCreditDetailResponse: each status and close_data status, numbers as numbers and strings
    const statusMap: Array<[string, CreditSettlementStatus]> = [
      ['未授權', 'unauthorized'],
      ['已授權', 'authorized'],
      ['要關帳', 'capture_pending'],
      ['已關帳', 'captured'],
      ['操作取消', 'capture_cancelled'],
      ['已取消', 'voided'],
    ];

    for (const [rawStatus, expectedStatus] of statusMap) {
      const res = parseCreditDetailResponse(
        JSON.stringify({
          RtnMsg: '',
          RtnValue: {
            TradeID: '2610150902037371',
            amount: 1500,
            clsamt: '1000',
            authtime: '2026/10/15 09:02:10',
            status: rawStatus,
            close_data: [
              { status: '要關帳', sno: '1', amount: '1500', datetime: '2026/10/15 20:15:00' },
              { status: '已關帳', sno: '2', amount: 1500, datetime: '2026/10/16 02:00:00' },
              { status: '已取消', sno: '3', amount: '500', datetime: '2026/10/16 10:00:00' },
              { status: '操作取消', sno: '4', amount: 500, datetime: '2026/10/16 11:00:00' },
            ],
          },
        }),
        { expectedAmountMinor: 150000 },
      );
      assert.equal(Object.isFrozen(res), true);
      assert.equal(res.kind, 'detail');
      if (res.kind === 'detail') {
        assert.equal(res.status, expectedStatus);
        assert.equal(res.authorisedMinor, 150000);
        assert.equal(res.capturedMinor, 100000);
        assert.equal(res.closeData.length, 4);
        assert.equal(Object.isFrozen(res.closeData), true);
        assert.equal(Object.isFrozen(res.closeData[0]), true);
        assert.deepEqual(
          res.closeData.map((c) => c.status),
          ['capture_pending', 'captured', 'voided', 'capture_cancelled'],
        );
      }
    }

    // RtnMsg 'error_nopay' -> error
    assert.deepEqual(
      parseCreditDetailResponse(JSON.stringify({ RtnMsg: 'error_nopay', RtnValue: {} }), {
        expectedAmountMinor: 150000,
      }),
      { kind: 'error', message: 'error_nopay' },
    );

    // Amount mismatch
    assert.deepEqual(
      parseCreditDetailResponse(
        JSON.stringify({
          RtnMsg: '',
          RtnValue: { amount: 1200, clsamt: 1200, status: '已關帳', close_data: [] },
        }),
        { expectedAmountMinor: 150000 },
      ),
      { kind: 'unknown', reason: 'amount_mismatch' },
    );

    // Unknown status
    assert.deepEqual(
      parseCreditDetailResponse(
        JSON.stringify({
          RtnMsg: '',
          RtnValue: { amount: 1500, clsamt: 1500, status: '處理中', close_data: [] },
        }),
        { expectedAmountMinor: 150000 },
      ),
      { kind: 'unknown', reason: 'unrecognized_status' },
    );

    // Unknown close_data status
    assert.deepEqual(
      parseCreditDetailResponse(
        JSON.stringify({
          RtnMsg: '',
          RtnValue: {
            amount: 1500,
            clsamt: 1500,
            status: '已關帳',
            close_data: [{ status: '未知狀態', amount: 1500 }],
          },
        }),
        { expectedAmountMinor: 150000 },
      ),
      { kind: 'unknown', reason: 'unrecognized_status' },
    );

    // Non-JSON, array body, 65537-character body
    assert.deepEqual(
      parseCreditDetailResponse('<html>error</html>', { expectedAmountMinor: 150000 }),
      { kind: 'unknown', reason: 'invalid_json' },
    );
    assert.deepEqual(
      parseCreditDetailResponse('[]', { expectedAmountMinor: 150000 }),
      { kind: 'unknown', reason: 'not_an_object' },
    );
    assert.deepEqual(
      parseCreditDetailResponse(JSON.stringify({ RtnMsg: '', RtnValue: [] }), {
        expectedAmountMinor: 150000,
      }),
      { kind: 'unknown', reason: 'not_an_object' },
    );
    assert.deepEqual(
      parseCreditDetailResponse('x'.repeat(65537), { expectedAmountMinor: 150000 }),
      { kind: 'unknown', reason: 'too_large' },
    );
  });

  it('plans credit refunds across every cell of the decision table and check order', () => {
    // Full refunds (paidMinor 150000, refundedMinor 0, requestedMinor 150000)
    const fullAuth = planCreditRefund({
      status: 'authorized',
      paidMinor: 150000,
      refundedMinor: 0,
      requestedMinor: 150000,
    });
    assert.equal(Object.isFrozen(fullAuth), true);
    assert.deepEqual(fullAuth, {
      kind: 'plan',
      steps: [{ action: 'N', amountMinor: 150000 }],
    });

    assert.deepEqual(
      planCreditRefund({
        status: 'capture_cancelled',
        paidMinor: 150000,
        refundedMinor: 0,
        requestedMinor: 150000,
      }),
      {
        kind: 'plan',
        steps: [{ action: 'N', amountMinor: 150000 }],
      },
    );

    assert.deepEqual(
      planCreditRefund({
        status: 'capture_pending',
        paidMinor: 150000,
        refundedMinor: 0,
        requestedMinor: 150000,
      }),
      {
        kind: 'plan',
        steps: [
          { action: 'E', amountMinor: 150000 },
          { action: 'N', amountMinor: 150000 },
        ],
      },
    );

    assert.deepEqual(
      planCreditRefund({
        status: 'captured',
        paidMinor: 150000,
        refundedMinor: 0,
        requestedMinor: 150000,
      }),
      {
        kind: 'plan',
        steps: [{ action: 'R', amountMinor: 150000 }],
      },
    );

    // Partial refunds (paidMinor 150000, refundedMinor 0, requestedMinor 50000)
    assert.deepEqual(
      planCreditRefund({
        status: 'authorized',
        paidMinor: 150000,
        refundedMinor: 0,
        requestedMinor: 50000,
      }),
      {
        kind: 'plan',
        steps: [
          { action: 'C', amountMinor: 150000 },
          { action: 'R', amountMinor: 50000 },
        ],
      },
    );

    assert.deepEqual(
      planCreditRefund({
        status: 'capture_cancelled',
        paidMinor: 150000,
        refundedMinor: 0,
        requestedMinor: 50000,
      }),
      {
        kind: 'plan',
        steps: [
          { action: 'C', amountMinor: 150000 },
          { action: 'R', amountMinor: 50000 },
        ],
      },
    );

    assert.deepEqual(
      planCreditRefund({
        status: 'capture_pending',
        paidMinor: 150000,
        refundedMinor: 0,
        requestedMinor: 50000,
      }),
      {
        kind: 'plan',
        steps: [{ action: 'R', amountMinor: 50000 }],
      },
    );

    assert.deepEqual(
      planCreditRefund({
        status: 'captured',
        paidMinor: 150000,
        refundedMinor: 0,
        requestedMinor: 50000,
      }),
      {
        kind: 'plan',
        steps: [{ action: 'R', amountMinor: 50000 }],
      },
    );

    // Subsequent partial refunds (paidMinor 150000, refundedMinor 50000, requestedMinor 50000)
    assert.deepEqual(
      planCreditRefund({
        status: 'authorized',
        paidMinor: 150000,
        refundedMinor: 50000,
        requestedMinor: 50000,
      }),
      { kind: 'not_refundable', reason: 'state_inconsistent' },
    );

    assert.deepEqual(
      planCreditRefund({
        status: 'capture_cancelled',
        paidMinor: 150000,
        refundedMinor: 50000,
        requestedMinor: 50000,
      }),
      { kind: 'not_refundable', reason: 'state_inconsistent' },
    );

    assert.deepEqual(
      planCreditRefund({
        status: 'capture_pending',
        paidMinor: 150000,
        refundedMinor: 50000,
        requestedMinor: 50000,
      }),
      {
        kind: 'plan',
        steps: [{ action: 'R', amountMinor: 50000 }],
      },
    );

    assert.deepEqual(
      planCreditRefund({
        status: 'captured',
        paidMinor: 150000,
        refundedMinor: 50000,
        requestedMinor: 50000,
      }),
      {
        kind: 'plan',
        steps: [{ action: 'R', amountMinor: 50000 }],
      },
    );

    // Check order: unauthorized -> not_authorised; voided -> already_voided; exceeds_paid
    assert.deepEqual(
      planCreditRefund({
        status: 'unauthorized',
        paidMinor: 150000,
        refundedMinor: 100000,
        requestedMinor: 100000,
      }),
      { kind: 'not_refundable', reason: 'not_authorised' },
    );
    assert.deepEqual(
      planCreditRefund({
        status: 'voided',
        paidMinor: 150000,
        refundedMinor: 100000,
        requestedMinor: 100000,
      }),
      { kind: 'not_refundable', reason: 'already_voided' },
    );
    assert.deepEqual(
      planCreditRefund({
        status: 'captured',
        paidMinor: 150000,
        refundedMinor: 100000,
        requestedMinor: 60000,
      }),
      { kind: 'not_refundable', reason: 'exceeds_paid' },
    );

    // Invalid amounts throw invalid_input
    expectProtocolError(
      () =>
        planCreditRefund({
          status: 'captured',
          paidMinor: 0,
          refundedMinor: 0,
          requestedMinor: 50000,
        }),
      'invalid_input',
    );
    expectProtocolError(
      () =>
        planCreditRefund({
          status: 'captured',
          paidMinor: 150000,
          refundedMinor: -100,
          requestedMinor: 50000,
        }),
      'invalid_input',
    );
    expectProtocolError(
      () =>
        planCreditRefund({
          status: 'captured',
          paidMinor: 150000,
          refundedMinor: 0,
          requestedMinor: 0,
        }),
      'invalid_input',
    );
    expectProtocolError(
      () =>
        planCreditRefund({
          status: 'captured',
          paidMinor: 150050,
          refundedMinor: 0,
          requestedMinor: 50000,
        }),
      'invalid_input',
    );
  });

  it('builds and parses CreditDetail/DoAction requests and responses', () => {
    // Sandbox rejected
    expectProtocolError(
      () =>
        buildDoActionRequest(
          {
            environment: 'sandbox',
            merchantId: AIO_CREDIT_GOLDEN_MERCHANT_ID,
            merchantTradeNo: AIO_CREDIT_GOLDEN_TRADE_NO,
            tradeNo: '2610150902037371',
            action: 'R',
            amountMinor: 50000,
          },
          stageKeys,
        ),
      'unsupported_environment',
    );

    // Action X -> invalid_input
    expectProtocolError(
      () =>
        buildDoActionRequest(
          {
            environment: 'live',
            merchantId: AIO_CREDIT_GOLDEN_MERCHANT_ID,
            merchantTradeNo: AIO_CREDIT_GOLDEN_TRADE_NO,
            tradeNo: '2610150902037371',
            action: 'X' as unknown as 'R',
            amountMinor: 50000,
          },
          stageKeys,
        ),
      'invalid_input',
    );

    const expectedEcho = {
      merchantId: '3002607',
      merchantTradeNo: 'FVTPVXVR14D2PF2DBSQQ',
      tradeNo: '2610150902037371',
    };

    // RtnCode=1 -> succeeded (and trailing newline accepted)
    assert.deepEqual(
      parseDoActionResponse(
        'MerchantID=3002607&MerchantTradeNo=FVTPVXVR14D2PF2DBSQQ&TradeNo=2610150902037371&RtnCode=1&RtnMsg=OK\r\n',
        expectedEcho,
      ),
      { kind: 'succeeded' },
    );

    // RtnCode=10300077 -> rejected (message sanitised)
    assert.deepEqual(
      parseDoActionResponse(
        'MerchantID=3002607&MerchantTradeNo=FVTPVXVR14D2PF2DBSQQ&TradeNo=2610150902037371&RtnCode=10300077&RtnMsg=失敗%00\t原因',
        expectedEcho,
      ),
      { kind: 'rejected', rtnCode: '10300077', rtnMsg: '失敗原因' },
    );

    // Echo mismatch in each identifier
    assert.deepEqual(
      parseDoActionResponse(
        'MerchantID=2000132&MerchantTradeNo=FVTPVXVR14D2PF2DBSQQ&TradeNo=2610150902037371&RtnCode=1&RtnMsg=OK',
        expectedEcho,
      ),
      { kind: 'unknown', reason: 'echo_mismatch' },
    );
    assert.deepEqual(
      parseDoActionResponse(
        'MerchantID=3002607&MerchantTradeNo=FOTHER00000000000000&TradeNo=2610150902037371&RtnCode=1&RtnMsg=OK',
        expectedEcho,
      ),
      { kind: 'unknown', reason: 'echo_mismatch' },
    );
    assert.deepEqual(
      parseDoActionResponse(
        'MerchantID=3002607&MerchantTradeNo=FVTPVXVR14D2PF2DBSQQ&TradeNo=9999999999999999&RtnCode=1&RtnMsg=OK',
        expectedEcho,
      ),
      { kind: 'unknown', reason: 'echo_mismatch' },
    );

    // Missing RtnCode
    assert.deepEqual(
      parseDoActionResponse(
        'MerchantID=3002607&MerchantTradeNo=FVTPVXVR14D2PF2DBSQQ&TradeNo=2610150902037371&RtnMsg=OK',
        expectedEcho,
      ),
      { kind: 'unknown', reason: 'missing_field' },
    );

    // Invalid RtnCode -> invalid_field
    assert.deepEqual(
      parseDoActionResponse(
        'MerchantID=3002607&MerchantTradeNo=FVTPVXVR14D2PF2DBSQQ&TradeNo=2610150902037371&RtnCode=abc&RtnMsg=OK',
        expectedEcho,
      ),
      { kind: 'unknown', reason: 'invalid_field' },
    );

    // HTML error page -> unparseable
    assert.deepEqual(
      parseDoActionResponse('<html><body>502 Bad Gateway</body></html>', expectedEcho),
      { kind: 'unknown', reason: 'unparseable' },
    );

    // Empty body -> unparseable (parseForm rejects empty input)
    assert.deepEqual(parseDoActionResponse('', expectedEcho), {
      kind: 'unknown',
      reason: 'unparseable',
    });
  });

  it('applies CDN word guard fallbacks and rejects blocked URLs and trade numbers', () => {
    const validBase = {
      ...CHECKOUT_COMMON_BASE,
      createdAtEpochMs: CHECKOUT_GOLDEN_VECTORS[0].input.createdAtEpochMs,
    };

    // TradeDesc fallback when displayNumber contains a CDN-blocked term ('261015-TFTP7K')
    const tftpDisplayForm = buildCreditCheckoutForm(
      { ...validBase, displayNumber: '261015-TFTP7K' },
      stageKeys,
    );
    const tradeDescEntry = tftpDisplayForm.fields.find(([k]) => k === 'TradeDesc');
    assert.deepEqual(tradeDescEntry, ['TradeDesc', 'Freedom order']);
    assert.equal(aio.verify(encodeForm(tftpDisplayForm.fields), stageKeys).ok, true);

    // Line names containing 'cd ../x' and 'CHMOD +x' fall back to '{store}商品一批 x1'
    assert.equal(
      buildItemName([{ name: '套件 cd ../x 測試', quantity: 1 }], '合成小舖'),
      '合成小舖商品一批 x1',
    );
    assert.equal(
      buildItemName([{ name: '腳本 CHMOD +x 測試', quantity: 1 }], '合成小舖'),
      '合成小舖商品一批 x1',
    );

    // Too-long line list with storeName containing a blocked term ('tftp 小舖') falls back to '商品一批 x1'
    const longLines = Array.from({ length: 30 }, () => ({
      name: '合成測試商品名稱很長很長',
      quantity: 1,
    }));
    assert.equal(buildItemName(longLines, 'tftp 小舖'), '商品一批 x1');

    // URL rejections for query string, percent-escape, ';', '|', 'cd/' path, and 'echo' host
    const cdnBadUrls = [
      'https://freedom.example.com/cb?a=1',
      'https://freedom.example.com/cb?',
      'https://freedom.example.com/cb/%41',
      'https://freedom.example.com/cb;x',
      'https://freedom.example.com/cb|x',
      'https://freedom.example.com/abcd/x',
      'https://echo.example.com/x',
    ];
    for (const badUrl of cdnBadUrls) {
      expectProtocolError(
        () => buildCreditCheckoutForm({ ...validBase, returnUrl: badUrl }, stageKeys),
        'invalid_input',
      );
      expectProtocolError(
        () => buildCreditCheckoutForm({ ...validBase, orderResultUrl: badUrl }, stageKeys),
        'invalid_input',
      );
      expectProtocolError(
        () => buildCreditCheckoutForm({ ...validBase, clientBackUrl: badUrl }, stageKeys),
        'invalid_input',
      );
    }

    // merchantTradeNo spelling 'TFTP' ('FTFTP000000000000000') rejected by CDN guard
    const tftpTradeNo = 'FTFTP000000000000000';
    expectProtocolError(
      () =>
        buildCreditCheckoutForm(
          { ...validBase, merchantTradeNo: tftpTradeNo },
          stageKeys,
        ),
      'invalid_input',
    );
    expectProtocolError(
      () =>
        buildTradeInfoQuery(
          {
            environment: 'sandbox',
            merchantId: AIO_CREDIT_GOLDEN_MERCHANT_ID,
            merchantTradeNo: tftpTradeNo,
            timestampSeconds: 1792026123,
          },
          stageKeys,
        ),
      'invalid_input',
    );
  });

  it('maintains error hygiene across all thrown EcpayProtocolError instances', () => {
    assert.ok(
      collectedErrors.length >= 40,
      `Expected at least 40 collected errors, got ${collectedErrors.length}`,
    );
    for (const err of collectedErrors) {
      const inspected = `${err.message} ${util.inspect(err)} ${err.stack ?? ''}`;
      for (const snippet of sensitiveSnippets) {
        assert.equal(
          inspected.includes(snippet),
          false,
          `Error leaked sensitive snippet "${snippet}": ${inspected}`,
        );
      }
    }
  });
});
