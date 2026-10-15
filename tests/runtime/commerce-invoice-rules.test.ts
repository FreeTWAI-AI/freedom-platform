import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  InvoiceRuleError,
  assertMinorMoney,
  isValidUbn,
  normalizeInvoiceBuyer,
  ecpayBuyerFields,
  itemName,
  splitUnits,
  invoiceItems,
  allowanceItems,
  toEcpayItems,
  ntdFromMinor,
  invoiceRemark,
  parseEcpayDateTime,
  invoicePeriod,
  voidDeadline,
  platformVoidDeadline,
  suggestInvoiceCorrection,
  canVoidWithReissue,
  type InvoiceFacts,
  type RefundFacts,
} from '../../modules/agent-commerce/invoices/rules/index.js';

describe('InvoiceRuleError and assertMinorMoney', () => {
  it('throws InvoiceRuleError with code invalid_input', () => {
    const err = new InvoiceRuleError();
    assert.equal(err.code, 'invalid_input');
    assert.equal(err.name, 'InvoiceRuleError');
    assert.ok(err instanceof Error);
    assert.ok(err instanceof InvoiceRuleError);
  });

  it('validates minor money amounts', () => {
    assertMinorMoney(0);
    assertMinorMoney(100);
    assertMinorMoney(250000);

    assert.throws(() => assertMinorMoney(-100), InvoiceRuleError);
    assert.throws(() => assertMinorMoney(150), InvoiceRuleError);
    assert.throws(() => assertMinorMoney(99.9), InvoiceRuleError);
    assert.throws(() => assertMinorMoney('100'), InvoiceRuleError);
    assert.throws(() => assertMinorMoney(NaN), InvoiceRuleError);
    assert.throws(() => assertMinorMoney(Infinity), InvoiceRuleError);
    assert.throws(() => assertMinorMoney(Number.MAX_SAFE_INTEGER + 1), InvoiceRuleError);
  });
});

describe('1. UBN (統一編號) verification', () => {
  it('verifies valid UBN vectors', () => {
    // valid 22099131 [30], 04595257 [40], 10458575 [30], 20000637 [15, valid only under 2023 divisor],
    // 12345675 [39, 7th digit 7], 20000273 [19, 7th digit 7], 12345670 [34, 7th digit 7, valid only under 2023 divisor]
    const valid = [
      '22099131',
      '04595257',
      '10458575',
      '20000637',
      '12345675',
      '20000273',
      '12345670',
    ];
    for (const ubn of valid) {
      assert.equal(isValidUbn(ubn), true, `Expected UBN ${ubn} to be valid`);
    }
  });

  it('verifies invalid UBN vectors', () => {
    // invalid 12345678 [42], 20000000 [2], 20000091 [12], 20000182 [11]
    const invalid = [
      '12345678',
      '20000000',
      '20000091',
      '20000182',
    ];
    for (const ubn of invalid) {
      assert.equal(isValidUbn(ubn), false, `Expected UBN ${ubn} to be invalid`);
    }
  });

  it('verifies format failures', () => {
    const formatFailures = ['1234567', '123456789', '1234567a', '', 'abcdefgh', ' 22099131'];
    for (const val of formatFailures) {
      assert.equal(isValidUbn(val), false, `Expected format failure for "${val}"`);
    }
  });
});

describe('2. Buyer invoice data & ECPay fields', () => {
  it('normalizes member_carrier', () => {
    const res = normalizeInvoiceBuyer({ type: 'member_carrier' });
    assert.deepEqual(res, { ok: true, buyer: { type: 'member_carrier' } });
  });

  it('normalizes mobile_barcode with full-width characters and lowercase', () => {
    // Full width: ／ -> /, ＡＢＣ -> ABC, ＋ -> +
    const res = normalizeInvoiceBuyer({
      type: 'mobile_barcode',
      barcode: '　／ａｂｃ＋１２３　',
    });
    assert.deepEqual(res, {
      ok: true,
      buyer: { type: 'mobile_barcode', barcode: '/ABC+123' },
    });
  });

  it('normalizes citizen_cert with full-width characters and lowercase', () => {
    const res = normalizeInvoiceBuyer({
      type: 'citizen_cert',
      certificate: '　ｔｐ１２３４５６７８９０１２３４　',
    });
    assert.deepEqual(res, {
      ok: true,
      buyer: { type: 'citizen_cert', certificate: 'TP12345678901234' },
    });
  });

  it('normalizes donation loveCode', () => {
    const res = normalizeInvoiceBuyer({
      type: 'donation',
      loveCode: '　１２３４５　',
    });
    assert.deepEqual(res, {
      ok: true,
      buyer: { type: 'donation', loveCode: '12345' },
    });
  });

  it('normalizes company with ubn, title, and optional barcode', () => {
    const res = normalizeInvoiceBuyer({
      type: 'company',
      ubn: '　２２０９９１３１　',
      title: '　合成買家\u0000有限公司　　測試分公司　',
      barcode: '　／ａｂｃ＋１２３　',
    });
    assert.deepEqual(res, {
      ok: true,
      buyer: {
        type: 'company',
        ubn: '22099131',
        title: '合成買家有限公司 測試分公司',
        barcode: '/ABC+123',
      },
    });
  });

  it('treats empty optional barcode on company as absent', () => {
    const res1 = normalizeInvoiceBuyer({
      type: 'company',
      ubn: '22099131',
      title: '合成買家',
      barcode: '   ',
    });
    assert.deepEqual(res1, {
      ok: true,
      buyer: {
        type: 'company',
        ubn: '22099131',
        title: '合成買家',
      },
    });
  });

  it('rejects unknown types and non-objects', () => {
    assert.deepEqual(normalizeInvoiceBuyer(null), {
      ok: false,
      errors: [{ field: 'type', code: 'unknown_type' }],
    });
    assert.deepEqual(normalizeInvoiceBuyer([1, 2]), {
      ok: false,
      errors: [{ field: 'type', code: 'unknown_type' }],
    });
    assert.deepEqual(normalizeInvoiceBuyer({ type: 'paper' }), {
      ok: false,
      errors: [{ field: 'type', code: 'unknown_type' }],
    });
  });

  it('rejects disallowed fields for type (mixed input)', () => {
    const res = normalizeInvoiceBuyer({
      type: 'donation',
      loveCode: '12345',
      ubn: '22099131',
    });
    assert.deepEqual(res, {
      ok: false,
      errors: [{ field: 'ubn', code: 'not_allowed_for_type' }],
    });
  });

  it('reports all field errors on company', () => {
    const res = normalizeInvoiceBuyer({
      type: 'company',
      ubn: '20000000', // bad checksum
      title: '', // required
      barcode: 'invalid', // format
      extra: 'unexpected', // not allowed
    });
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.deepEqual(res.errors, [
        { field: 'extra', code: 'not_allowed_for_type' },
        { field: 'ubn', code: 'checksum' },
        { field: 'title', code: 'required' },
        { field: 'barcode', code: 'format' },
      ]);
    }
  });

  it('rejects company title longer than 60 code points', () => {
    const longTitle = '測'.repeat(61);
    const res = normalizeInvoiceBuyer({
      type: 'company',
      ubn: '22099131',
      title: longTitle,
    });
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.deepEqual(res.errors, [{ field: 'title', code: 'too_long' }]);
    }
  });

  it('generates ecpayBuyerFields for all 5 buyer types', () => {
    const email = 'buyer@example.test';

    // 1. member_carrier
    assert.deepEqual(ecpayBuyerFields({ type: 'member_carrier' }, email), {
      CustomerIdentifier: '',
      CustomerName: '',
      CarrierType: '1',
      CarrierNum: '',
      Print: '0',
      Donation: '0',
      LoveCode: '',
      CustomerEmail: email,
    });

    // 2. mobile_barcode
    assert.deepEqual(ecpayBuyerFields({ type: 'mobile_barcode', barcode: '/ABC+123' }, email), {
      CustomerIdentifier: '',
      CustomerName: '',
      CarrierType: '3',
      CarrierNum: '/ABC+123',
      Print: '0',
      Donation: '0',
      LoveCode: '',
      CustomerEmail: email,
    });

    // 3. citizen_cert
    assert.deepEqual(ecpayBuyerFields({ type: 'citizen_cert', certificate: 'TP12345678901234' }, email), {
      CustomerIdentifier: '',
      CustomerName: '',
      CarrierType: '2',
      CarrierNum: 'TP12345678901234',
      Print: '0',
      Donation: '0',
      LoveCode: '',
      CustomerEmail: email,
    });

    // 4. donation
    assert.deepEqual(ecpayBuyerFields({ type: 'donation', loveCode: '12345' }, email), {
      CustomerIdentifier: '',
      CustomerName: '',
      CarrierType: '',
      CarrierNum: '',
      Print: '0',
      Donation: '1',
      LoveCode: '12345',
      CustomerEmail: email,
    });

    // 5. company without barcode
    assert.deepEqual(ecpayBuyerFields({ type: 'company', ubn: '22099131', title: '合成買家' }, email), {
      CustomerIdentifier: '22099131',
      CustomerName: '合成買家',
      CarrierType: '1',
      CarrierNum: '',
      Print: '0',
      Donation: '0',
      LoveCode: '',
      CustomerEmail: email,
    });

    // 5. company with barcode
    assert.deepEqual(ecpayBuyerFields({ type: 'company', ubn: '22099131', title: '合成買家', barcode: '/ABC+123' }, email), {
      CustomerIdentifier: '22099131',
      CustomerName: '合成買家',
      CarrierType: '3',
      CarrierNum: '/ABC+123',
      Print: '0',
      Donation: '0',
      LoveCode: '',
      CustomerEmail: email,
    });
  });

  it('rejects unnormalized buyer in ecpayBuyerFields', () => {
    // Unnormalized barcode (lowercase)
    assert.throws(
      () => ecpayBuyerFields({ type: 'mobile_barcode', barcode: '/abc+123' }, 'buyer@example.test'),
      InvoiceRuleError
    );
    // Extra property
    assert.throws(
      () => ecpayBuyerFields({ type: 'member_carrier', extra: 1 } as any, 'buyer@example.test'),
      InvoiceRuleError
    );
  });

  it('validates customerEmail in ecpayBuyerFields', () => {
    const validBuyer = { type: 'member_carrier' as const };
    const email80 = 'a'.repeat(80 - '@example.test'.length) + '@example.test';
    const email81 = 'a'.repeat(81 - '@example.test'.length) + '@example.test';

    const accepted = [
      'buyer@example.test',
      'first.last+tag@sub.example.test',
      email80,
    ];
    for (const email of accepted) {
      const result = ecpayBuyerFields(validBuyer, email);
      assert.equal(result.CustomerEmail, email);
    }

    const rejected = [
      email81,
      '',
      'a@b',
      '買家@example.test',
      '"x"@example.test',
      'a..b@example.test',
      '.a@example.test',
      'a@-b.test',
      'a@b.test1',
      'buyer @example.test',
      'buyer\n@example.test',
      'buyer@@example.test',
      '@example.test',
      'buyer@',
    ];
    for (const email of rejected) {
      assert.throws(
        () => ecpayBuyerFields(validBuyer, email),
        (err: unknown) => {
          assert.ok(err instanceof InvoiceRuleError);
          assert.equal(err.message, 'Invalid customer email');
          return true;
        }
      );
    }
  });
});

describe('3. Items & Allowances', () => {
  it('truncates itemName according to 100 code-point budget', () => {
    // Clean whitespace and controls
    assert.equal(itemName(' 商品\u0000A  ', ' 紅色  '), '商品A（紅色）');

    // Exactly 100 code points without suffix
    const name100 = '字'.repeat(100);
    assert.equal(itemName(name100), name100);

    // 101 code points without suffix -> 99 + …
    const name101 = '字'.repeat(101);
    assert.equal(itemName(name101), '字'.repeat(99) + '…');

    // 100-code-point name with emoji (surrogate pairs) and a suffix
    // Emoji '😀' is 1 code point
    const suffix = '（折讓）'; // 5 code points
    const baseWithEmoji = '😀'.repeat(100); // 100 code points
    const result = itemName(baseWithEmoji, null, suffix);
    // budget = 100 - 5 = 95. Sliced to 94 + … + suffix
    assert.equal(Array.from(result).length, 100);
    assert.ok(result.endsWith('…（折讓）'));
    assert.equal(Array.from(result).slice(0, 94).join(''), '😀'.repeat(94));

    // Empty product name throws
    assert.throws(() => itemName('   \u0000  '), InvoiceRuleError);
  });

  it('splits units accurately with splitUnits', () => {
    // splitUnits(29000, 3) → [{count:1, priceMinor:9600}, {count:2, priceMinor:9700}]
    assert.deepEqual(splitUnits(29000, 3), [
      { count: 1, priceMinor: 9600 },
      { count: 2, priceMinor: 9700 },
    ]);

    // splitUnits(30000, 3) → [{count:3, priceMinor:10000}]
    assert.deepEqual(splitUnits(30000, 3), [
      { count: 3, priceMinor: 10000 },
    ]);

    // splitUnits(200, 3) → lumped 1 × 200
    assert.deepEqual(splitUnits(200, 3), [
      { count: 1, priceMinor: 200, lumped: true },
    ]);

    // splitUnits(150, 1) → invalid_input (not multiple of 100)
    assert.throws(() => splitUnits(150, 1), InvoiceRuleError);

    // splitUnits(0, 5) → []
    assert.deepEqual(splitUnits(0, 5), []);

    // invalid quantity
    assert.throws(() => splitUnits(10000, 0), InvoiceRuleError);
    assert.throws(() => splitUnits(10000, 100), InvoiceRuleError);
  });

  it('generates invoiceItems with 50 lines × 2 parts + 50 shipping groups = 150 items', () => {
    const lines = [];
    for (let i = 1; i <= 50; i++) {
      // 29000 with Q=3 splits into 2 parts
      lines.push({
        productName: `商品${i}`,
        quantity: 3,
        netMinor: 29000,
      });
    }
    const shippingGroups = [];
    for (let i = 1; i <= 50; i++) {
      shippingGroups.push({ feeMinor: 6000 });
    }

    const { items, salesMinor } = invoiceItems({ lines, shippingGroups });
    assert.equal(items.length, 150);
    // 50 * 29000 + 50 * 6000 = 1450000 + 300000 = 1750000
    assert.equal(salesMinor, 1750000);
    assert.equal(items[149].name, '運費');
    assert.equal(items[149].priceMinor, 6000);
  });

  it('omits 0 net lines and 0 fee shipping in invoiceItems', () => {
    const { items, salesMinor } = invoiceItems({
      lines: [
        { productName: '贈品', quantity: 1, netMinor: 0 },
        { productName: '正品', quantity: 1, netMinor: 50000 },
      ],
      shippingGroups: [{ feeMinor: 0 }],
    });
    assert.equal(items.length, 1);
    assert.equal(items[0].name, '正品');
    assert.equal(salesMinor, 50000);
  });

  it('handles lumped invoice items with suffix', () => {
    const { items } = invoiceItems({
      lines: [{ productName: '超特惠品', quantity: 5, netMinor: 400 }], // 4 NT$ for 5 units -> lumped
      shippingGroups: [],
    });
    assert.equal(items.length, 1);
    assert.equal(items[0].name, '超特惠品（共5件）');
    assert.equal(items[0].count, 1);
    assert.equal(items[0].amountMinor, 400);
  });

  it('creates allowanceItems mixing item split, price difference (k=0), and shipping', () => {
    const res = allowanceItems({
      refundLines: [
        { kind: 'item', productName: '商品A', quantity: 3, amountMinor: 29000 },
        { kind: 'item', productName: '商品B', quantity: 0, amountMinor: 5000 },
        { kind: 'shipping', amountMinor: 6000 },
      ],
    });

    // 商品A splits into 2 items (9600 x 1, 9700 x 2)
    // 商品B is 1 item with '（折讓）' (5000 x 1)
    // shipping is 1 item '運費' (6000 x 1)
    assert.equal(res.items.length, 4);
    assert.equal(res.items[0].name, '商品A');
    assert.equal(res.items[0].count, 1);
    assert.equal(res.items[0].priceMinor, 9600);
    assert.equal(res.items[1].name, '商品A');
    assert.equal(res.items[1].count, 2);
    assert.equal(res.items[1].priceMinor, 9700);
    assert.equal(res.items[2].name, '商品B（折讓）');
    assert.equal(res.items[2].count, 1);
    assert.equal(res.items[2].priceMinor, 5000);
    assert.equal(res.items[3].name, '運費');
    assert.equal(res.items[3].count, 1);
    assert.equal(res.items[3].priceMinor, 6000);
    assert.equal(res.allowanceMinor, 29000 + 5000 + 6000);
  });

  it('rejects allowanceItems with unapplied refund', () => {
    assert.throws(
      () =>
        allowanceItems({
          refundLines: [
            { kind: 'item', productName: '商品A', quantity: 1, amountMinor: 10000 },
            { kind: 'unapplied', amountMinor: 5000 },
          ],
        }),
      InvoiceRuleError
    );
  });

  it('converts to ECPay items with toEcpayItems', () => {
    const items = [
      { name: '商品A', count: 2, priceMinor: 10000, amountMinor: 20000 },
      { name: '運費', count: 1, priceMinor: 6000, amountMinor: 6000 },
    ];
    const ecpayRows = toEcpayItems(items, '件');
    assert.deepEqual(ecpayRows, [
      {
        ItemSeq: 1,
        ItemName: '商品A',
        ItemCount: 2,
        ItemWord: '件',
        ItemPrice: 100,
        ItemAmount: 200,
      },
      {
        ItemSeq: 2,
        ItemName: '運費',
        ItemCount: 1,
        ItemWord: '件',
        ItemPrice: 60,
        ItemAmount: 60,
      },
    ]);
  });

  it('validates ntdFromMinor and invoiceRemark', () => {
    assert.equal(ntdFromMinor(10000), 100);
    assert.equal(ntdFromMinor(0), 0);
    assert.throws(() => ntdFromMinor(150), InvoiceRuleError);

    assert.equal(invoiceRemark('261015-ABCDEF'), '訂單 261015-ABCDEF');
    assert.throws(() => invoiceRemark('invalid-remark'), InvoiceRuleError);
  });
});

describe('4. Period & Void Deadline', () => {
  it('parses valid ECPay date times in Taiwan time and computes deadlines', () => {
    // invoice 2026-01-05 10:00:00 → deadline 2026-03-13T15:59:59.000Z, platform 2026-03-13T13:59:59.000Z
    const d1 = parseEcpayDateTime('2026-01-05 10:00:00');
    assert.equal(voidDeadline(d1).toISOString(), '2026-03-13T15:59:59.000Z');
    assert.equal(platformVoidDeadline(d1).toISOString(), '2026-03-13T13:59:59.000Z');

    // 2026/02/28 23:59:59 → same
    const d2 = parseEcpayDateTime('2026/02/28 23:59:59');
    assert.equal(voidDeadline(d2).toISOString(), '2026-03-13T15:59:59.000Z');
    assert.equal(platformVoidDeadline(d2).toISOString(), '2026-03-13T13:59:59.000Z');

    // 2026-03-01 00:00:00 → 2026-05-13T15:59:59.000Z
    const d3 = parseEcpayDateTime('2026-03-01 00:00:00');
    assert.equal(voidDeadline(d3).toISOString(), '2026-05-13T15:59:59.000Z');

    // 2026-12-31 23:59:59 → 2027-01-13T15:59:59.000Z
    const d4 = parseEcpayDateTime('2026-12-31 23:59:59');
    assert.equal(voidDeadline(d4).toISOString(), '2027-01-13T15:59:59.000Z');

    // 2026-11-01 00:00:00 (that is 2026-10-31T16:00:00Z) → 2027-01-13T15:59:59.000Z
    const d5 = parseEcpayDateTime('2026-11-01 00:00:00');
    assert.equal(d5.toISOString(), '2026-10-31T16:00:00.000Z');
    assert.equal(voidDeadline(d5).toISOString(), '2027-01-13T15:59:59.000Z');

    // 2026-10-31 23:59:59 → 2026-11-13T15:59:59.000Z
    const d6 = parseEcpayDateTime('2026-10-31 23:59:59');
    assert.equal(voidDeadline(d6).toISOString(), '2026-11-13T15:59:59.000Z');

    // 2000-01-01 00:00:00 → 1999-12-31T16:00:00.000Z
    assert.equal(parseEcpayDateTime('2000-01-01 00:00:00').toISOString(), '1999-12-31T16:00:00.000Z');

    // 2000/02/29 12:00:00 → 2000-02-29T04:00:00.000Z
    assert.equal(parseEcpayDateTime('2000/02/29 12:00:00').toISOString(), '2000-02-29T04:00:00.000Z');

    // 2099-12-31 23:59:59 → 2099-12-31T15:59:59.000Z
    assert.equal(parseEcpayDateTime('2099-12-31 23:59:59').toISOString(), '2099-12-31T15:59:59.000Z');
  });

  it('rejects invalid date formats and impossible dates', () => {
    assert.throws(() => parseEcpayDateTime('2026-02-30 10:00:00'), InvoiceRuleError);
    assert.throws(() => parseEcpayDateTime('2026-1-5 10:00:00'), InvoiceRuleError);
    assert.throws(() => parseEcpayDateTime('2026-01-05T10:00:00'), InvoiceRuleError);
    assert.throws(() => parseEcpayDateTime('2026-01-05 24:00:00'), InvoiceRuleError);
    assert.throws(() => parseEcpayDateTime('2026-01/05 10:00:00'), InvoiceRuleError);
    assert.throws(() => parseEcpayDateTime('2026/01-05 10:00:00'), InvoiceRuleError);
    assert.throws(() => parseEcpayDateTime('0026-01-05 10:00:00'), InvoiceRuleError);
    assert.throws(() => parseEcpayDateTime('1999-12-31 23:59:59'), InvoiceRuleError);
    assert.throws(() => parseEcpayDateTime('2100-01-01 00:00:00'), InvoiceRuleError);
  });

  it('verifies invoicePeriod calculation', () => {
    // Jan 5 -> year 2026, startMonth 1
    assert.deepEqual(invoicePeriod(parseEcpayDateTime('2026-01-05 10:00:00')), {
      year: 2026,
      startMonth: 1,
    });
    // Feb 28 -> year 2026, startMonth 1
    assert.deepEqual(invoicePeriod(parseEcpayDateTime('2026-02-28 23:59:59')), {
      year: 2026,
      startMonth: 1,
    });
    // Nov 1 -> year 2026, startMonth 11
    assert.deepEqual(invoicePeriod(parseEcpayDateTime('2026-11-01 00:00:00')), {
      year: 2026,
      startMonth: 11,
    });
  });
});

describe('5. Corrections: suggestInvoiceCorrection & canVoidWithReissue', () => {
  const baseInvoice: InvoiceFacts = {
    mode: 'ecpay_b2c',
    status: 'issued',
    donation: false,
    invoiceAt: parseEcpayDateTime('2026-01-05 10:00:00'), // deadline: 2026-03-13T15:59:59.000Z, platform: 2026-03-13T13:59:59.000Z
    amountMinor: 100000, // 1,000 NT$
    uploaded: 'yes',
    allowances: [],
    reissuedWithVoidWithReIssue: false,
    correctionInProgress: false,
  };

  const platformDeadline = platformVoidDeadline(baseInvoice.invoiceAt!);

  it('suggests none on unapplied refund', () => {
    const refund: RefundFacts = { kind: 'unapplied', cumulativeAppliedMinor: 50000 };
    const res = suggestInvoiceCorrection(baseInvoice, refund, 'allowance', new Date('2026-01-10T00:00:00Z'));
    assert.deepEqual(res, { kind: 'none', reason: 'unapplied_refund' });
  });

  it('suggests none on not_issued mode and manual on manual_record', () => {
    const refund: RefundFacts = { kind: 'applied', cumulativeAppliedMinor: 50000 };
    const res1 = suggestInvoiceCorrection({ ...baseInvoice, mode: 'not_issued' }, refund, 'allowance', new Date('2026-01-10T00:00:00Z'));
    assert.deepEqual(res1, { kind: 'none', reason: 'invoice_not_issued' });

    const res2 = suggestInvoiceCorrection({ ...baseInvoice, mode: 'manual_record' }, refund, 'allowance', new Date('2026-01-10T00:00:00Z'));
    assert.deepEqual(res2, {
      kind: 'suggest',
      action: 'manual',
      reason: 'manual_record',
      alternatives: ['manual'],
      afterUpload: false,
      platformVoidDeadline: null,
      dueSoon: false,
    });
  });

  it('handles non-issued statuses correctly', () => {
    const refund: RefundFacts = { kind: 'applied', cumulativeAppliedMinor: 50000 };
    const now = new Date('2026-01-10T00:00:00Z');

    assert.deepEqual(suggestInvoiceCorrection({ ...baseInvoice, status: 'queued' }, refund, 'allowance', now), {
      kind: 'wait',
      reason: 'invoice_pending',
    });
    assert.deepEqual(suggestInvoiceCorrection({ ...baseInvoice, status: 'issuing' }, refund, 'allowance', now), {
      kind: 'wait',
      reason: 'invoice_pending',
    });
    assert.deepEqual(suggestInvoiceCorrection({ ...baseInvoice, status: 'unknown' }, refund, 'allowance', now), {
      kind: 'wait',
      reason: 'invoice_pending',
    });
    assert.deepEqual(suggestInvoiceCorrection({ ...baseInvoice, status: 'failed' }, refund, 'allowance', now), {
      kind: 'none',
      reason: 'invoice_failed',
    });
    assert.deepEqual(suggestInvoiceCorrection({ ...baseInvoice, status: 'voided' }, refund, 'allowance', now), {
      kind: 'none',
      reason: 'invoice_voided',
    });
    assert.deepEqual(suggestInvoiceCorrection({ ...baseInvoice, status: 'recorded' }, refund, 'allowance', now), {
      kind: 'suggest',
      action: 'manual',
      reason: 'manual_record',
      alternatives: ['manual'],
      afterUpload: false,
      platformVoidDeadline: null,
      dueSoon: false,
    });
  });

  it('waits if correctionInProgress is true', () => {
    const refund: RefundFacts = { kind: 'applied', cumulativeAppliedMinor: 50000 };
    const res = suggestInvoiceCorrection({ ...baseInvoice, correctionInProgress: true }, refund, 'allowance', new Date('2026-01-10T00:00:00Z'));
    assert.deepEqual(res, { kind: 'wait', reason: 'correction_in_progress' });
  });

  it('suggests void for full refund within deadline', () => {
    const refund: RefundFacts = { kind: 'applied', cumulativeAppliedMinor: 100000 };
    const now = new Date('2026-01-10T00:00:00Z');
    const res = suggestInvoiceCorrection(baseInvoice, refund, 'allowance', now);

    assert.deepEqual(res, {
      kind: 'suggest',
      action: 'void',
      reason: 'full_refund_within_deadline',
      alternatives: ['allowance', 'manual'],
      afterUpload: false,
      platformVoidDeadline: platformDeadline,
      dueSoon: false,
    });
  });

  it('suggests allowance for full refund after deadline (void expired)', () => {
    const refund: RefundFacts = { kind: 'applied', cumulativeAppliedMinor: 100000 };
    // One second after platform deadline
    const now = new Date(platformDeadline.getTime() + 1000);
    const res = suggestInvoiceCorrection(baseInvoice, refund, 'allowance', now);

    assert.deepEqual(res, {
      kind: 'suggest',
      action: 'allowance',
      reason: 'full_refund_void_expired_allowance',
      alternatives: ['manual'],
      afterUpload: false,
      platformVoidDeadline: platformDeadline,
      dueSoon: false,
    });
  });

  it('boundary test: exactly at and one second after platformVoidDeadline', () => {
    const refund: RefundFacts = { kind: 'applied', cumulativeAppliedMinor: 100000 };

    // Exactly at platformVoidDeadline
    const atDeadline = suggestInvoiceCorrection(baseInvoice, refund, 'allowance', platformDeadline);
    assert.equal(atDeadline.kind, 'suggest');
    if (atDeadline.kind === 'suggest') {
      assert.equal(atDeadline.action, 'void');
      assert.equal(atDeadline.dueSoon, true); // Since now >= deadline - 24h
    }

    // One second after platformVoidDeadline
    const pastDeadline = suggestInvoiceCorrection(
      baseInvoice,
      refund,
      'allowance',
      new Date(platformDeadline.getTime() + 1000)
    );
    assert.equal(pastDeadline.kind, 'suggest');
    if (pastDeadline.kind === 'suggest') {
      assert.equal(pastDeadline.action, 'allowance');
      assert.equal(pastDeadline.dueSoon, false);
    }
  });

  it('boundary test: dueSoon at 24 h and 24 h + 1 s before deadline', () => {
    const refund: RefundFacts = { kind: 'applied', cumulativeAppliedMinor: 100000 };

    // Exactly 24 hours before deadline
    const exactly24hBefore = new Date(platformDeadline.getTime() - 24 * 3600 * 1000);
    const res1 = suggestInvoiceCorrection(baseInvoice, refund, 'allowance', exactly24hBefore);
    assert.equal(res1.kind, 'suggest');
    if (res1.kind === 'suggest') {
      assert.equal(res1.action, 'void');
      assert.equal(res1.dueSoon, true);
    }

    // 24 hours + 1 second before deadline
    const oneSecBefore24h = new Date(platformDeadline.getTime() - 24 * 3600 * 1000 - 1000);
    const res2 = suggestInvoiceCorrection(baseInvoice, refund, 'allowance', oneSecBefore24h);
    assert.equal(res2.kind, 'suggest');
    if (res2.kind === 'suggest') {
      assert.equal(res2.action, 'void');
      assert.equal(res2.dueSoon, false);
    }
  });

  it('handles partial refund preference both ways', () => {
    const refund: RefundFacts = { kind: 'applied', cumulativeAppliedMinor: 30000 };
    const now = new Date('2026-01-10T00:00:00Z');

    // 1. Preference allowance
    const resPrefAllowance = suggestInvoiceCorrection(baseInvoice, refund, 'allowance', now);
    assert.deepEqual(resPrefAllowance, {
      kind: 'suggest',
      action: 'allowance',
      reason: 'preference_allowance',
      alternatives: ['void_and_reissue_new', 'manual'],
      afterUpload: false,
      platformVoidDeadline: platformDeadline,
      dueSoon: false,
    });

    // 2. Preference void_and_reissue_new
    const resPrefVoid = suggestInvoiceCorrection(baseInvoice, refund, 'void_and_reissue_new', now);
    assert.deepEqual(resPrefVoid, {
      kind: 'suggest',
      action: 'void_and_reissue_new',
      reason: 'preference_void_reissue_within_deadline',
      alternatives: ['allowance', 'manual'],
      afterUpload: false,
      platformVoidDeadline: platformDeadline,
      dueSoon: false,
    });
  });

  it('handles donation partial refund before and after deadline', () => {
    const donationInvoice: InvoiceFacts = {
      ...baseInvoice,
      donation: true,
    };
    const refund: RefundFacts = { kind: 'applied', cumulativeAppliedMinor: 30000 };

    // Before deadline
    const beforeDl = suggestInvoiceCorrection(donationInvoice, refund, 'allowance', new Date('2026-01-10T00:00:00Z'));
    assert.deepEqual(beforeDl, {
      kind: 'suggest',
      action: 'void_and_reissue_new',
      reason: 'donation_partial_refund_within_deadline',
      alternatives: ['manual'], // allowance impossible for donation
      afterUpload: false,
      platformVoidDeadline: platformDeadline,
      dueSoon: false,
    });

    // After deadline (allowance is impossible for donation -> manual)
    const afterDl = suggestInvoiceCorrection(
      donationInvoice,
      refund,
      'allowance',
      new Date(platformDeadline.getTime() + 1000)
    );
    assert.deepEqual(afterDl, {
      kind: 'suggest',
      action: 'manual',
      reason: 'donation_void_expired_manual',
      alternatives: [],
      afterUpload: false,
      platformVoidDeadline: platformDeadline,
      dueSoon: false,
    });
  });

  it('handles Nov-Dec invoice corrected in early January', () => {
    // Nov-Dec 2026 invoice
    const novInvoice: InvoiceFacts = {
      ...baseInvoice,
      invoiceAt: parseEcpayDateTime('2026-11-15 12:00:00'),
    };
    // Deadline is 2027-01-13 15:59:59 UTC, platform 13:59:59 UTC
    const novPlatformDl = platformVoidDeadline(novInvoice.invoiceAt!);
    assert.equal(novPlatformDl.toISOString(), '2027-01-13T13:59:59.000Z');

    const refund: RefundFacts = { kind: 'applied', cumulativeAppliedMinor: 100000 };
    // Corrected on 2027-01-05 (early January)
    const res = suggestInvoiceCorrection(novInvoice, refund, 'allowance', new Date('2027-01-05T00:00:00Z'));
    assert.equal(res.kind, 'suggest');
    if (res.kind === 'suggest') {
      assert.equal(res.action, 'void');
      assert.equal(res.reason, 'full_refund_within_deadline');
      assert.equal(res.dueSoon, false);
    }
  });

  it('handles full refund after earlier partial allowances (void impossible -> allowance for rest)', () => {
    const invoiceWithEarlierAllowance: InvoiceFacts = {
      ...baseInvoice,
      allowances: [
        { status: 'effective', amountMinor: 40000 },
      ],
    };
    // Cumulative applied is full 100000 (earlier 40000 + this 60000)
    const refund: RefundFacts = { kind: 'applied', cumulativeAppliedMinor: 100000 };
    const now = new Date('2026-01-10T00:00:00Z'); // within deadline

    const res = suggestInvoiceCorrection(invoiceWithEarlierAllowance, refund, 'allowance', now);
    assert.deepEqual(res, {
      kind: 'suggest',
      action: 'allowance',
      reason: 'full_refund_void_expired_allowance',
      alternatives: ['manual'], // void impossible because unvoided allowance exists
      afterUpload: false,
      platformVoidDeadline: platformDeadline,
      dueSoon: false,
    });
  });

  it('handles pending online allowance (allowance impossible)', () => {
    const invoiceWithPending: InvoiceFacts = {
      ...baseInvoice,
      allowances: [
        { status: 'pending_buyer', amountMinor: 20000 },
      ],
    };
    const refund: RefundFacts = { kind: 'applied', cumulativeAppliedMinor: 50000 };
    const now = new Date('2026-01-10T00:00:00Z');

    // Since pending allowance exists:
    // voidAllowed is false (unvoided exists)
    // allowancePossible is false (pending exists)
    // -> manual
    const res = suggestInvoiceCorrection(invoiceWithPending, refund, 'allowance', now);
    assert.deepEqual(res, {
      kind: 'suggest',
      action: 'manual',
      reason: 'no_automated_correction_available',
      alternatives: [],
      afterUpload: false,
      platformVoidDeadline: platformDeadline,
      dueSoon: false,
    });
  });

  it('handles 50 allowances limit (allowance impossible)', () => {
    const allowances = Array.from({ length: 50 }, () => ({
      status: 'voided' as const,
      amountMinor: 1000,
    }));
    const invoiceWith50: InvoiceFacts = {
      ...baseInvoice,
      allowances,
    };
    const refund: RefundFacts = { kind: 'applied', cumulativeAppliedMinor: 50000 };
    const now = new Date(platformDeadline.getTime() + 1000); // past deadline

    const res = suggestInvoiceCorrection(invoiceWith50, refund, 'allowance', now);
    assert.deepEqual(res, {
      kind: 'suggest',
      action: 'manual',
      reason: 'no_automated_correction_available',
      alternatives: [],
      afterUpload: false,
      platformVoidDeadline: platformDeadline,
      dueSoon: false,
    });
  });

  it('sets afterUpload = true when uploaded is not yes and action is allowance', () => {
    const invoiceUnknownUpload: InvoiceFacts = {
      ...baseInvoice,
      uploaded: 'unknown',
    };
    const refund: RefundFacts = { kind: 'applied', cumulativeAppliedMinor: 30000 };
    const now = new Date('2026-01-10T00:00:00Z');

    const res = suggestInvoiceCorrection(invoiceUnknownUpload, refund, 'allowance', now);
    assert.equal(res.kind, 'suggest');
    if (res.kind === 'suggest') {
      assert.equal(res.action, 'allowance');
      assert.equal(res.afterUpload, true);
    }
  });

  it('verifies canVoidWithReissue branches', () => {
    const invoiceAtMs = baseInvoice.invoiceAt!.getTime();
    const now = new Date(invoiceAtMs + 3600 * 1000); // invoiceAt + 1 h

    // 1. Valid case
    assert.equal(canVoidWithReissue(baseInvoice, now), true);

    // 2. Uploaded conditions
    assert.equal(canVoidWithReissue({ ...baseInvoice, uploaded: 'no' }, now), false);
    assert.equal(canVoidWithReissue({ ...baseInvoice, uploaded: 'unknown' }, now), false);

    // 3. 46-hour window boundary
    const exactly46h = new Date(invoiceAtMs + 46 * 3600 * 1000);
    const past46h1ms = new Date(invoiceAtMs + 46 * 3600 * 1000 + 1);
    const past7days = new Date(invoiceAtMs + 7 * 24 * 3600 * 1000);
    assert.equal(canVoidWithReissue(baseInvoice, exactly46h), true);
    assert.equal(canVoidWithReissue(baseInvoice, past46h1ms), false);
    assert.equal(canVoidWithReissue(baseInvoice, past7days), false);

    // 4. Past deadline
    assert.equal(canVoidWithReissue(baseInvoice, new Date(platformDeadline.getTime() + 1000)), false);

    // 5. Not ecpay_b2c
    assert.equal(canVoidWithReissue({ ...baseInvoice, mode: 'manual_record' }, now), false);

    // 6. Not issued
    assert.equal(canVoidWithReissue({ ...baseInvoice, status: 'issuing' }, now), false);

    // 7. Already reissuedWithVoidWithReIssue
    assert.equal(canVoidWithReissue({ ...baseInvoice, reissuedWithVoidWithReIssue: true }, now), false);

    // 8. Allowances
    // an effective allowance -> false
    assert.equal(
      canVoidWithReissue(
        {
          ...baseInvoice,
          allowances: [{ status: 'effective', amountMinor: 10000 }],
        },
        now
      ),
      false
    );
    // pending_buyer and submitting allowances -> false
    assert.equal(
      canVoidWithReissue(
        {
          ...baseInvoice,
          allowances: [{ status: 'pending_buyer', amountMinor: 10000 }],
        },
        now
      ),
      false
    );
    assert.equal(
      canVoidWithReissue(
        {
          ...baseInvoice,
          allowances: [{ status: 'submitting', amountMinor: 10000 }],
        },
        now
      ),
      false
    );
    // only a voided allowance -> true
    assert.equal(
      canVoidWithReissue(
        {
          ...baseInvoice,
          allowances: [{ status: 'voided', amountMinor: 10000 }],
        },
        now
      ),
      true
    );
    // expired and cancelled -> true
    assert.equal(
      canVoidWithReissue(
        {
          ...baseInvoice,
          allowances: [{ status: 'expired', amountMinor: 10000 }],
        },
        now
      ),
      true
    );
    assert.equal(
      canVoidWithReissue(
        {
          ...baseInvoice,
          allowances: [{ status: 'cancelled', amountMinor: 10000 }],
        },
        now
      ),
      true
    );
  });
});
