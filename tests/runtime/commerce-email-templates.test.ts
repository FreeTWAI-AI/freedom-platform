import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import {
  COMMERCE_EMAIL_TEMPLATES,
  CARRIER_LABELS,
  CommerceEmailTemplateError,
  formatTwd,
  renderCommerceEmail,
  renderOrderConfirmedEmail,
  renderPaidUnallocatableEmail,
  renderOrderAccessEmail,
  renderShipmentHandedOverEmail,
  renderAftersaleReplyEmail,
  sanitizeSellerText,
  type CommerceEmailInput,
  type RenderedCommerceEmail,
} from '../../modules/agent-commerce/operations/notifications/templates.js';
import { SERVICE_KEYS } from '../../modules/agent-commerce/fulfilment/rules/index.js';

const SHARED_COMMON = {
  origin: 'https://example.test',
  store: {
    slug: 'demo-store',
    name: '示範店家',
    contactEmail: 'shop@example.test',
  },
  displayNumber: '261015-ABCDEF',
  orderRef: '018d0000-0000-7000-8000-000000000001',
  accessToken: 'abcdefghijklmnopqrstuvwxyz0123456789-_ABCDE',
} as const;

function extractUrls(text: string): string[] {
  const matches = text.match(/https?:\/\/[^\s]+/g);
  return matches ? [...matches] : [];
}

function verifyInvariants(
  rendered: RenderedCommerceEmail,
  input: { origin: string; contactEmail: string | null; accessToken?: string | null },
): void {
  // Output object is frozen
  assert.equal(Object.isFrozen(rendered), true, 'Rendered email object must be frozen');

  // Subject invariants
  assert.equal(rendered.subject.includes('\r'), false, 'Subject must have no CR');
  assert.equal(rendered.subject.includes('\n'), false, 'Subject must have no LF');
  assert.equal(rendered.subject.startsWith('自由工坊：'), true, 'Subject must start with 自由工坊：');
  assert.equal(rendered.subject.length <= 200, true, 'Subject must be <= 200 characters');

  // Text invariants
  assert.equal(rendered.text.includes('\r'), false, 'Text must have no CR');
  assert.equal(rendered.text.includes('\t'), false, 'Text must have no tabs');
  assert.equal(rendered.text.endsWith('\n'), false, 'Text must have no trailing newline');

  const lines = rendered.text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    assert.equal(line.endsWith(' ') || line.endsWith('\t'), false, `Line ${i + 1} has trailing whitespace`);
    const byteLen = Buffer.byteLength(line, 'utf-8');
    assert.equal(byteLen <= 998, true, `Line ${i + 1} exceeds 998 UTF-8 bytes (${byteLen} bytes)`);
  }

  // URL checks
  const urls = extractUrls(rendered.text);
  const expectedOrderLinkBase = `${input.origin}/shops/${SHARED_COMMON.store.slug}/orders/${SHARED_COMMON.orderRef}`;
  const expectedOrderLink = input.accessToken ? `${expectedOrderLinkBase}#access=${input.accessToken}` : expectedOrderLinkBase;
  const expectedStoreUrl = `${input.origin}/shops/${SHARED_COMMON.store.slug}`;

  if (input.contactEmail !== null) {
    // Only the order link is present
    assert.deepEqual(urls, [expectedOrderLink], 'Only order link should be present when contactEmail is provided');
  } else {
    // Order link and store page URL are present
    assert.deepEqual(urls, [expectedOrderLink, expectedStoreUrl], 'Order link and store page URL must be the only URLs');
  }

  // Token presence check
  if (input.accessToken) {
    const tokenOccurrences = (rendered.text.match(new RegExp(input.accessToken, 'g')) || []).length;
    assert.equal(tokenOccurrences, 1, 'Access token must appear exactly once when given');
  } else {
    assert.equal(rendered.text.includes('#access='), false, 'Order link must not contain access token when null');
  }

  // HTTP check
  const isLoopback =
    input.origin.includes('localhost') || input.origin.includes('127.0.0.1') || input.origin.includes('[::1]');
  if (!isLoopback) {
    assert.equal(rendered.text.includes('http://'), false, 'No http:// allowed unless loopback');
  }

  // replyTo check
  assert.equal(rendered.replyTo, input.contactEmail, 'replyTo must equal contactEmail or null');
}

test('carrier map keys equal SERVICE_KEYS exactly', () => {
  const mapKeys = Object.keys(CARRIER_LABELS).sort();
  const serviceKeys = [...SERVICE_KEYS].sort();
  assert.deepEqual(mapKeys, serviceKeys);
});

test('exact golden subject and text for shared synthetic samples', () => {
  const sharedSamples = {
    order_confirmed: {
      template: 'order_confirmed' as const,
      ...SHARED_COMMON,
      items: [{ title: '測試商品', variantLabel: null, quantity: 1 }],
      totalMinor: 123400,
    },
    paid_unallocatable: {
      template: 'paid_unallocatable' as const,
      ...SHARED_COMMON,
    },
    order_access: {
      template: 'order_access' as const,
      ...SHARED_COMMON,
    },
    shipment_handed_over: {
      template: 'shipment_handed_over' as const,
      ...SHARED_COMMON,
      serviceKey: 'ecpay.logistics.home.tcat' as const,
      trackingNumber: 'TCAT-12345678',
    },
    aftersale_reply: {
      template: 'aftersale_reply' as const,
      ...SHARED_COMMON,
    },
  };

  // Expected golden texts
  const expectedOrderConfirmedText = [
    '你向「示範店家」建立的訂單 261015-ABCDEF 已完成付款，店家將開始為你準備商品。',
    '訂單內容：\n・測試商品 × 1\n合計：NT$1,234',
    '查看訂單請開啟以下連結：\nhttps://example.test/shops/demo-store/orders/018d0000-0000-7000-8000-000000000001#access=abcdefghijklmnopqrstuvwxyz0123456789-_ABCDE',
    '此連結有效期限為 7 天，只能使用一次；使用後會在此瀏覽器開啟訂單，請勿轉寄給他人。',
    '這封信由自由工坊代「示範店家」僅就此筆訂單發送，不含任何行銷廣告。\n店家聯絡 Email：shop@example.test\n若你沒有在這間店下單，請忽略這封信。',
  ].join('\n\n');

  const expectedPaidUnallocatableText = [
    '你向「示範店家」建立的訂單 261015-ABCDEF 已完成付款。因商品目前庫存不足，暫時無法出貨。',
    '店家將確認庫存狀態，若補足庫存將為你出貨，或取消訂單並由店家辦理退款；後續處理結果將更新於訂單頁面。若有任何疑問，請透過下方的聯絡方式與店家聯繫。',
    '查看訂單請開啟以下連結：\nhttps://example.test/shops/demo-store/orders/018d0000-0000-7000-8000-000000000001#access=abcdefghijklmnopqrstuvwxyz0123456789-_ABCDE',
    '此連結有效期限為 7 天，只能使用一次；使用後會在此瀏覽器開啟訂單，請勿轉寄給他人。',
    '這封信由自由工坊代「示範店家」僅就此筆訂單發送，不含任何行銷廣告。\n店家聯絡 Email：shop@example.test\n若你沒有在這間店下單，請忽略這封信。',
  ].join('\n\n');

  const expectedOrderAccessText = [
    '有人申請了「示範店家」訂單 261015-ABCDEF 的查看連結。',
    '查看訂單請開啟以下連結：\nhttps://example.test/shops/demo-store/orders/018d0000-0000-7000-8000-000000000001#access=abcdefghijklmnopqrstuvwxyz0123456789-_ABCDE',
    '此連結有效期限為 7 天，只能使用一次；使用後會在此瀏覽器開啟訂單，請勿轉寄給他人。',
    '若不是你提出申請，請忽略此信。',
    '這封信由自由工坊代「示範店家」僅就此筆訂單發送，不含任何行銷廣告。\n店家聯絡 Email：shop@example.test',
  ].join('\n\n');

  const expectedShipmentHandedOverText = [
    '你向「示範店家」建立的訂單 261015-ABCDEF 有包裹已交寄。',
    '物流方式：黑貓宅急便\n包裹追蹤碼：TCAT-12345678',
    '查看訂單請開啟以下連結：\nhttps://example.test/shops/demo-store/orders/018d0000-0000-7000-8000-000000000001#access=abcdefghijklmnopqrstuvwxyz0123456789-_ABCDE',
    '此連結有效期限為 7 天，只能使用一次；使用後會在此瀏覽器開啟訂單，請勿轉寄給他人。',
    '這封信由自由工坊代「示範店家」僅就此筆訂單發送，不含任何行銷廣告。\n店家聯絡 Email：shop@example.test\n若你沒有在這間店下單，請忽略這封信。',
  ].join('\n\n');

  const expectedAftersaleReplyText = [
    '你向「示範店家」建立的訂單 261015-ABCDEF 的售後申請有新回覆或進度更新。',
    '查看訂單請開啟以下連結：\nhttps://example.test/shops/demo-store/orders/018d0000-0000-7000-8000-000000000001#access=abcdefghijklmnopqrstuvwxyz0123456789-_ABCDE',
    '此連結有效期限為 7 天，只能使用一次；使用後會在此瀏覽器開啟訂單，請勿轉寄給他人。',
    '這封信由自由工坊代「示範店家」僅就此筆訂單發送，不含任何行銷廣告。\n店家聯絡 Email：shop@example.test\n若你沒有在這間店下單，請忽略這封信。',
  ].join('\n\n');

  const r1 = renderCommerceEmail(sharedSamples.order_confirmed);
  assert.equal(r1.subject, '自由工坊：「示範店家」訂單 261015-ABCDEF 已成立');
  assert.equal(r1.text, expectedOrderConfirmedText);
  assert.equal(r1.replyTo, 'shop@example.test');
  verifyInvariants(r1, { origin: SHARED_COMMON.origin, contactEmail: SHARED_COMMON.store.contactEmail, accessToken: SHARED_COMMON.accessToken });

  const r2 = renderCommerceEmail(sharedSamples.paid_unallocatable);
  assert.equal(r2.subject, '自由工坊：「示範店家」訂單 261015-ABCDEF 已付款，等待配貨');
  assert.equal(r2.text, expectedPaidUnallocatableText);
  assert.equal(r2.replyTo, 'shop@example.test');
  verifyInvariants(r2, { origin: SHARED_COMMON.origin, contactEmail: SHARED_COMMON.store.contactEmail, accessToken: SHARED_COMMON.accessToken });

  const r3 = renderCommerceEmail(sharedSamples.order_access);
  assert.equal(r3.subject, '自由工坊：「示範店家」訂單 261015-ABCDEF 的查看連結');
  assert.equal(r3.text, expectedOrderAccessText);
  assert.equal(r3.replyTo, 'shop@example.test');
  verifyInvariants(r3, { origin: SHARED_COMMON.origin, contactEmail: SHARED_COMMON.store.contactEmail, accessToken: SHARED_COMMON.accessToken });

  const r4 = renderCommerceEmail(sharedSamples.shipment_handed_over);
  assert.equal(r4.subject, '自由工坊：「示範店家」訂單 261015-ABCDEF 有包裹已交寄');
  assert.equal(r4.text, expectedShipmentHandedOverText);
  assert.equal(r4.replyTo, 'shop@example.test');
  verifyInvariants(r4, { origin: SHARED_COMMON.origin, contactEmail: SHARED_COMMON.store.contactEmail, accessToken: SHARED_COMMON.accessToken });

  const r5 = renderCommerceEmail(sharedSamples.aftersale_reply);
  assert.equal(r5.subject, '自由工坊：「示範店家」訂單 261015-ABCDEF 有新回覆');
  assert.equal(r5.text, expectedAftersaleReplyText);
  assert.equal(r5.replyTo, 'shop@example.test');
  verifyInvariants(r5, { origin: SHARED_COMMON.origin, contactEmail: SHARED_COMMON.store.contactEmail, accessToken: SHARED_COMMON.accessToken });

  // Direct template functions dispatch
  assert.deepEqual(renderOrderConfirmedEmail(sharedSamples.order_confirmed), r1);
  assert.deepEqual(renderPaidUnallocatableEmail(sharedSamples.paid_unallocatable), r2);
  assert.deepEqual(renderOrderAccessEmail(sharedSamples.order_access), r3);
  assert.deepEqual(renderShipmentHandedOverEmail(sharedSamples.shipment_handed_over), r4);
  assert.deepEqual(renderAftersaleReplyEmail(sharedSamples.aftersale_reply), r5);
});

test('exact golden subject and text for second samples (12 items & CVS no token)', () => {
  // Second order_confirmed sample with 12 items, variantLabel, non-multiple-of-100 total, contactEmail: null
  const items12 = Array.from({ length: 12 }, (_, i) => ({
    title: `商品${i + 1}`,
    variantLabel: i === 0 ? '紅色 / S' : null,
    quantity: i + 1,
  }));

  const order2 = renderCommerceEmail({
    template: 'order_confirmed',
    ...SHARED_COMMON,
    store: {
      ...SHARED_COMMON.store,
      contactEmail: null,
    },
    items: items12,
    totalMinor: 123456,
  });

  const expectedOrder2Text = [
    '你向「示範店家」建立的訂單 261015-ABCDEF 已完成付款，店家將開始為你準備商品。',
    '訂單內容：\n・商品1（紅色 / S）× 1\n・商品2 × 2\n・商品3 × 3\n・商品4 × 4\n・商品5 × 5\n・商品6 × 6\n・商品7 × 7\n・商品8 × 8\n・商品9 × 9\n・商品10 × 10\n・以及另外 2 項商品\n合計：NT$1,234.56',
    '查看訂單請開啟以下連結：\nhttps://example.test/shops/demo-store/orders/018d0000-0000-7000-8000-000000000001#access=abcdefghijklmnopqrstuvwxyz0123456789-_ABCDE',
    '此連結有效期限為 7 天，只能使用一次；使用後會在此瀏覽器開啟訂單，請勿轉寄給他人。',
    '這封信由自由工坊代「示範店家」僅就此筆訂單發送，不含任何行銷廣告。\n店家的聯絡方式請見店家頁面：\nhttps://example.test/shops/demo-store\n若你沒有在這間店下單，請忽略這封信。',
  ].join('\n\n');

  assert.equal(order2.subject, '自由工坊：「示範店家」訂單 261015-ABCDEF 已成立');
  assert.equal(order2.text, expectedOrder2Text);
  assert.equal(order2.replyTo, null);
  verifyInvariants(order2, { origin: SHARED_COMMON.origin, contactEmail: null, accessToken: SHARED_COMMON.accessToken });

  // Second shipment_handed_over sample for CVS service with trackingNumber: null and no token
  const cvsShipment = renderCommerceEmail({
    template: 'shipment_handed_over',
    ...SHARED_COMMON,
    accessToken: null,
    serviceKey: 'ecpay.logistics.cvs.unimartc2c',
    trackingNumber: null,
  });

  const expectedCvsShipmentText = [
    '你向「示範店家」建立的訂單 261015-ABCDEF 有包裹已交寄。',
    '物流方式：7-ELEVEN 店到店\n包裹送達門市時，超商將發送取件簡訊通知，你也可以在訂單頁面查看取件門市與包裹狀態。',
    '查看訂單請開啟以下連結：\nhttps://example.test/shops/demo-store/orders/018d0000-0000-7000-8000-000000000001',
    '此連結可在先前下單或開啟過此訂單的瀏覽器直接查看；若更換裝置或瀏覽器，可至店家頁面以訂購時的 Email 與訂單編號重新取得查看連結。',
    '這封信由自由工坊代「示範店家」僅就此筆訂單發送，不含任何行銷廣告。\n店家聯絡 Email：shop@example.test\n若你沒有在這間店下單，請忽略這封信。',
  ].join('\n\n');

  assert.equal(cvsShipment.subject, '自由工坊：「示範店家」訂單 261015-ABCDEF 有包裹已交寄');
  assert.equal(cvsShipment.text, expectedCvsShipmentText);
  assert.equal(cvsShipment.replyTo, 'shop@example.test');
  verifyInvariants(cvsShipment, { origin: SHARED_COMMON.origin, contactEmail: 'shop@example.test', accessToken: null });

  // Home services with trackingNumber: null render carrier line, no tracking number line and no pickup sentence
  for (const [serviceKey, label] of [
    ['ecpay.logistics.home.tcat', '黑貓宅急便'],
    ['ecpay.logistics.home.post', '中華郵政'],
  ] as const) {
    const homeNoTracking = renderCommerceEmail({
      template: 'shipment_handed_over',
      ...SHARED_COMMON,
      serviceKey,
      trackingNumber: null,
    });
    assert.equal(homeNoTracking.text.includes(`物流方式：${label}\n\n查看訂單`), true);
    assert.equal(homeNoTracking.text.includes('包裹追蹤碼'), false);
    assert.equal(homeNoTracking.text.includes('超商將發送取件簡訊通知'), false);
    verifyInvariants(homeNoTracking, {
      origin: SHARED_COMMON.origin,
      contactEmail: SHARED_COMMON.store.contactEmail,
      accessToken: SHARED_COMMON.accessToken,
    });
  }
});

test('README samples equal the renderer output exactly', () => {
  const readmeContent = readFileSync('modules/agent-commerce/operations/notifications/README.md', 'utf-8');
  const exampleSection = readmeContent.slice(readmeContent.indexOf('## 範例'));

  const samples = {
    order_confirmed: {
      template: 'order_confirmed' as const,
      ...SHARED_COMMON,
      items: [{ title: '測試商品', variantLabel: null, quantity: 1 }],
      totalMinor: 123400,
    },
    paid_unallocatable: {
      template: 'paid_unallocatable' as const,
      ...SHARED_COMMON,
    },
    order_access: {
      template: 'order_access' as const,
      ...SHARED_COMMON,
    },
    shipment_handed_over: {
      template: 'shipment_handed_over' as const,
      ...SHARED_COMMON,
      serviceKey: 'ecpay.logistics.home.tcat' as const,
      trackingNumber: 'TCAT-12345678',
    },
    aftersale_reply: {
      template: 'aftersale_reply' as const,
      ...SHARED_COMMON,
    },
  };

  for (const [key, input] of Object.entries(samples)) {
    const rendered = renderCommerceEmail(input as any);
    const regex = new RegExp(`### ${key}\\s*\\x60\\x60\\x60text\\n([\\s\\S]*?)\\n\\x60\\x60\\x60`);
    const match = exampleSection.match(regex);
    assert.ok(match, `Missing fenced text block for ${key} in README.md`);
    const block = match[1];
    const [subjectLine, ...bodyParts] = block.split('\n\n');
    const parsedSubject = subjectLine.replace(/^主旨：/, '').trim();
    const parsedText = bodyParts.join('\n\n');

    assert.equal(rendered.subject, parsedSubject, `Mismatch subject for ${key} vs README`);
    assert.equal(rendered.text, parsedText, `Mismatch text for ${key} vs README`);
  }
});

test('money formatting and error handling', () => {
  assert.equal(formatTwd(0), 'NT$0');
  assert.equal(formatTwd(1), 'NT$0.01');
  assert.equal(formatTwd(99), 'NT$0.99');
  assert.equal(formatTwd(100), 'NT$1');
  assert.equal(formatTwd(101), 'NT$1.01');
  assert.equal(formatTwd(12345), 'NT$123.45');
  assert.equal(formatTwd(100000), 'NT$1,000');
  assert.equal(formatTwd(123400), 'NT$1,234');
  assert.equal(formatTwd(100000000), 'NT$1,000,000');
  assert.equal(formatTwd(123456), 'NT$1,234.56');
  assert.equal(formatTwd(99999999), 'NT$999,999.99');
  assert.equal(formatTwd(Number.MAX_SAFE_INTEGER), 'NT$90,071,992,547,409.91');

  for (const invalidMinor of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '100' as unknown as number]) {
    assert.throws(
      () => formatTwd(invalidMinor),
      (err: any) => err instanceof CommerceEmailTemplateError && err.code === 'invalid_input' && err.message === 'invalid_input',
      `Expected error for formatTwd(${String(invalidMinor)})`,
    );
  }

  // Invalid money values in order_confirmed
  const baseOrderConfirmed = {
    template: 'order_confirmed' as const,
    ...SHARED_COMMON,
    items: [{ title: '測試商品', variantLabel: null, quantity: 1 }],
  };

  for (const invalidTotal of [-1, -100, 1.5, 123.45, NaN, Infinity, -Infinity, '100', null, undefined, {}]) {
    assert.throws(
      () => renderCommerceEmail({ ...baseOrderConfirmed, totalMinor: invalidTotal as any }),
      (err: any) => err instanceof CommerceEmailTemplateError && err.code === 'invalid_input' && err.message === 'invalid_input',
      `Expected error for invalid totalMinor: ${invalidTotal}`,
    );
  }
});

test('sanitising seller text matrix', () => {
  // CR, LF, tab, and NEL in names replaced with space and collapsed
  assert.equal(sanitizeSellerText('A\r\nB\tC\u0085D', 80), 'A B C D');

  // Bidi controls removed
  const bidiChars = '\u061C\u200E\u200F\u202A\u202B\u202C\u202D\u202E\u2066\u2067\u2068\u2069';
  assert.equal(sanitizeSellerText(`A${bidiChars}B`, 80), 'AB');

  // Zero-width and BOM characters removed
  const zeroWidth = '\u200B\u200C\u200D\u2060\uFEFF';
  assert.equal(sanitizeSellerText(`A${zeroWidth}B`, 80), 'AB');

  // U+3000 collapsed to one ASCII space and trimmed
  assert.equal(sanitizeSellerText('A\u3000\u3000B', 80), 'A B');
  assert.equal(sanitizeSellerText('\u3000A B\u3000', 80), 'A B');

  // Limits 80/81
  const s80 = 'x'.repeat(80);
  assert.equal(sanitizeSellerText(s80, 80), s80);
  const s81 = 'x'.repeat(81);
  const cut80 = sanitizeSellerText(s81, 80);
  assert.equal(Array.from(cut80).length, 80);
  assert.equal(cut80, 'x'.repeat(79) + '…');

  // Limits 120/121
  const s120 = 'x'.repeat(120);
  assert.equal(sanitizeSellerText(s120, 120), s120);
  const s121 = 'x'.repeat(121);
  const cut120 = sanitizeSellerText(s121, 120);
  assert.equal(Array.from(cut120).length, 120);
  assert.equal(cut120, 'x'.repeat(119) + '…');

  // Limits 60/61
  const s60 = 'x'.repeat(60);
  assert.equal(sanitizeSellerText(s60, 60), s60);
  const s61 = 'x'.repeat(61);
  const cut60 = sanitizeSellerText(s61, 60);
  assert.equal(Array.from(cut60).length, 60);
  assert.equal(cut60, 'x'.repeat(59) + '…');

  // Emoji at cut point (surrogate pair intact, truncation by code points, … appended)
  const withEmoji81 = 'x'.repeat(78) + '🎉' + 'y'.repeat(2);
  const cutEmoji = sanitizeSellerText(withEmoji81, 80);
  assert.equal(Array.from(cutEmoji).length, 80);
  assert.equal(cutEmoji, 'x'.repeat(78) + '🎉…');

  // Lone surrogates throw
  assert.throws(
    () => sanitizeSellerText('bad\uD800name', 80),
    (err: any) => err instanceof CommerceEmailTemplateError && err.code === 'invalid_input',
  );
  assert.throws(
    () => sanitizeSellerText('bad\uDC00name', 80),
    (err: any) => err instanceof CommerceEmailTemplateError && err.code === 'invalid_input',
  );

  // Only controls / only spaces throw
  assert.throws(
    () => sanitizeSellerText('\r\n\t\u0085', 80),
    (err: any) => err instanceof CommerceEmailTemplateError && err.code === 'invalid_input',
  );
  assert.throws(
    () => sanitizeSellerText('   \u3000   ', 80),
    (err: any) => err instanceof CommerceEmailTemplateError && err.code === 'invalid_input',
  );
  assert.throws(
    () => sanitizeSellerText('', 80),
    (err: any) => err instanceof CommerceEmailTemplateError && err.code === 'invalid_input',
  );
});

test('every validation rule and property-style error message leak check', () => {
  const secretPayloads = [
    'secret-buyer-token-12345',
    'private.buyer@secret-domain.test',
    'super-confidential-shop-name',
    'TRACK-SECRET-99999',
  ];

  function assertThrowsWithoutLeak(fn: () => void, payload: string) {
    let threw = false;
    try {
      fn();
    } catch (err: any) {
      threw = true;
      assert.ok(err instanceof CommerceEmailTemplateError, 'Error must be CommerceEmailTemplateError');
      assert.equal(err.code, 'invalid_input');
      assert.equal(err.message, 'invalid_input');
      if (payload.length > 0) {
        assert.equal(err.message.includes(payload), false, 'Error message must not leak input data');
        assert.equal(JSON.stringify(err).includes(payload), false, 'Error JSON must not leak input data');
      }
    }
    assert.ok(threw, 'Function was expected to throw CommerceEmailTemplateError');
  }

  // 1. Origin variants
  const invalidOrigins = [
    'http://example.test',
    'https://x.test/path',
    'https://user:pass@example.test',
    'https://example.test?query=1',
    'https://example.test#fragment',
    'not-a-url',
    '',
  ];
  for (const origin of invalidOrigins) {
    assertThrowsWithoutLeak(
      () =>
        renderCommerceEmail({
          template: 'paid_unallocatable',
          ...SHARED_COMMON,
          origin,
        }),
      origin,
    );
  }

  // Valid loopback origins
  for (const origin of ['http://localhost:3000', 'http://127.0.0.1:8080', 'http://[::1]:3000']) {
    const rendered = renderCommerceEmail({
      template: 'paid_unallocatable',
      ...SHARED_COMMON,
      origin,
    });
    verifyInvariants(rendered, { origin, contactEmail: SHARED_COMMON.store.contactEmail, accessToken: SHARED_COMMON.accessToken });
  }

  // Long origin accepted by URL parser (> 998 bytes) is rejected by the renderer output invariant check
  const longOrigin = 'https://' + 'a'.repeat(1000) + '.test';
  assert.equal(new URL(longOrigin).origin.length > 998, true);
  assertThrowsWithoutLeak(
    () =>
      renderCommerceEmail({
        template: 'paid_unallocatable',
        ...SHARED_COMMON,
        origin: longOrigin,
      }),
    longOrigin,
  );

  // 2. Slug validation
  const invalidSlugs = ['ab', '-abc', 'abc-', '0abc', 'a_b', ' ', '', 'a'.repeat(41)];
  for (const slug of invalidSlugs) {
    assertThrowsWithoutLeak(
      () =>
        renderCommerceEmail({
          template: 'paid_unallocatable',
          ...SHARED_COMMON,
          store: { ...SHARED_COMMON.store, slug },
        }),
      slug,
    );
  }

  // 3. Email edge cases
  const invalidEmails = [
    'a@b',
    '"x"@y.test',
    'x@y.test,z@w.test',
    'x\r@y.test',
    'x\n@y.test',
    'x y@test.test',
    'x@test.',
    'x@.test',
    'x@test..com',
    '@test.test',
    'a'.repeat(65) + '@test.test',
    'x@' + 'a'.repeat(250) + '.test',
    '店家@example.test',
    'shop\u202E@example.test',
    'shop\u200B@example.test',
    'shop\u00A0@example.test',
    'shop\u007F@example.test',
  ];
  for (const contactEmail of invalidEmails) {
    assertThrowsWithoutLeak(
      () =>
        renderCommerceEmail({
          template: 'paid_unallocatable',
          ...SHARED_COMMON,
          store: { ...SHARED_COMMON.store, contactEmail },
        }),
      contactEmail,
    );
  }

  // 4. Display number
  const invalidDisplayNumbers = ['12345-ABCDEF', '123456-ABCDE', '123456-ABCDEI', '123456-ABCDEO', '123456-abcdef', ''];
  for (const displayNumber of invalidDisplayNumbers) {
    assertThrowsWithoutLeak(
      () =>
        renderCommerceEmail({
          template: 'paid_unallocatable',
          ...SHARED_COMMON,
          displayNumber,
        }),
      displayNumber,
    );
  }

  // 5. Order ref uppercase or invalid UUID
  const invalidOrderRefs = [
    '018D0000-0000-7000-8000-000000000001',
    'not-a-uuid',
    '018d0000000070008000000000000001',
  ];
  for (const orderRef of invalidOrderRefs) {
    assertThrowsWithoutLeak(
      () =>
        renderCommerceEmail({
          template: 'paid_unallocatable',
          ...SHARED_COMMON,
          orderRef,
        }),
      orderRef,
    );
  }

  // 6. Token length 42/44 and token missing for the two templates that require it
  const invalidTokens = ['a'.repeat(42), 'a'.repeat(44), 'bad+token/with=symbols!1234567890123456789'];
  for (const accessToken of invalidTokens) {
    assertThrowsWithoutLeak(
      () =>
        renderCommerceEmail({
          template: 'order_confirmed',
          ...SHARED_COMMON,
          accessToken,
          items: [{ title: '測試商品', variantLabel: null, quantity: 1 }],
          totalMinor: 100,
        }),
      accessToken,
    );
  }

  // Missing token for order_confirmed and order_access
  assertThrowsWithoutLeak(
    () =>
      renderCommerceEmail({
        template: 'order_confirmed',
        ...SHARED_COMMON,
        accessToken: null as any,
        items: [{ title: '測試商品', variantLabel: null, quantity: 1 }],
        totalMinor: 100,
      }),
    'order_confirmed_missing_token',
  );

  assertThrowsWithoutLeak(
    () =>
      renderCommerceEmail({
        template: 'order_access',
        ...SHARED_COMMON,
        accessToken: null as any,
      }),
    'order_access_missing_token',
  );

  // 7. Quantity 0 / 10000 / 1.5, and 0 and 101 items
  for (const quantity of [0, 10000, 1.5]) {
    assertThrowsWithoutLeak(
      () =>
        renderCommerceEmail({
          template: 'order_confirmed',
          ...SHARED_COMMON,
          items: [{ title: '測試商品', variantLabel: null, quantity }],
          totalMinor: 100,
        }),
      String(quantity),
    );
  }

  // 0 items
  assertThrowsWithoutLeak(
    () =>
      renderCommerceEmail({
        template: 'order_confirmed',
        ...SHARED_COMMON,
        items: [],
        totalMinor: 100,
      }),
    '0 items',
  );

  // 101 items
  const items101 = Array.from({ length: 101 }, (_, i) => ({
    title: `商品${i + 1}`,
    variantLabel: null,
    quantity: 1,
  }));
  assertThrowsWithoutLeak(
    () =>
      renderCommerceEmail({
        template: 'order_confirmed',
        ...SHARED_COMMON,
        items: items101,
        totalMinor: 100,
      }),
    '101 items',
  );

  // 8. Unknown service key
  assertThrowsWithoutLeak(
    () =>
      renderCommerceEmail({
        template: 'shipment_handed_over',
        ...SHARED_COMMON,
        serviceKey: 'ecpay.logistics.unknown' as any,
        trackingNumber: 'TCAT-12345',
      }),
    'unknown-key',
  );

  // 9. Tracking number with space or invalid
  for (const trackingNumber of ['TCAT 12345', '', 'x'.repeat(51)]) {
    assertThrowsWithoutLeak(
      () =>
        renderCommerceEmail({
          template: 'shipment_handed_over',
          ...SHARED_COMMON,
          serviceKey: 'ecpay.logistics.home.tcat',
          trackingNumber,
        }),
      trackingNumber,
    );
  }

  // CVS keys with non-null trackingNumber throw invalid_input (never leak CVSPaymentNo)
  for (const serviceKey of [
    'ecpay.logistics.cvs.unimartc2c',
    'ecpay.logistics.cvs.famic2c',
    'ecpay.logistics.cvs.hilifec2c',
  ] as const) {
    assertThrowsWithoutLeak(
      () =>
        renderCommerceEmail({
          template: 'shipment_handed_over',
          ...SHARED_COMMON,
          serviceKey,
          trackingNumber: 'TCAT-1',
        }),
      'TCAT-1',
    );
  }

  // Check secret payload does not leak in error
  for (const secret of secretPayloads) {
    assertThrowsWithoutLeak(
      () =>
        renderCommerceEmail({
          template: 'order_confirmed',
          ...SHARED_COMMON,
          accessToken: secret, // invalid length
          items: [{ title: secret, variantLabel: null, quantity: 1 }],
          totalMinor: 100,
        }),
      secret,
    );
  }
});

test('hostile seller text and maximum sizes through renderCommerceEmail', () => {
  const hostileStoreName = 'A\r\nBcc: x@example.test\u2028\u202E示範\u200B店家' + 'x'.repeat(100);
  const sanitisedName = sanitizeSellerText(hostileStoreName, 80);
  assert.equal(Array.from(sanitisedName).length, 80);
  assert.equal(sanitisedName.endsWith('…'), true);

  const hostileItems = [{ title: 'T\t1\u0085x', variantLabel: '\u2066L\u2069', quantity: 1 }];

  const renderedHostile = renderCommerceEmail({
    template: 'order_confirmed',
    ...SHARED_COMMON,
    store: {
      ...SHARED_COMMON.store,
      name: hostileStoreName,
    },
    items: hostileItems,
    totalMinor: 123400,
  });

  const baselineSample = renderCommerceEmail({
    template: 'order_confirmed',
    ...SHARED_COMMON,
    items: hostileItems,
    totalMinor: 123400,
  });

  // The subject is one line
  assert.equal(renderedHostile.subject.split(/\r|\n|\u0085|\u2028|\u2029/).length, 1);

  // Neither the subject nor the text contains CR, U+2028, U+202E or U+200B
  for (const forbidden of ['\r', '\u2028', '\u202E', '\u200B']) {
    assert.equal(renderedHostile.subject.includes(forbidden), false);
    assert.equal(renderedHostile.text.includes(forbidden), false);
  }

  // The text's only LFs are the template's own
  assert.equal(renderedHostile.text.split('\n').length, baselineSample.text.split('\n').length);

  // Sanitised name appears verbatim in both subject and footer
  assert.equal(renderedHostile.subject.includes(sanitisedName), true);
  const paragraphs = renderedHostile.text.split('\n\n');
  const footer = paragraphs[paragraphs.length - 1];
  assert.equal(footer.includes(sanitisedName), true);

  // The item line is exactly ・T 1 x（L）× 1
  assert.equal(renderedHostile.text.split('\n').includes('・T 1 x（L）× 1'), true);

  verifyInvariants(renderedHostile, {
    origin: SHARED_COMMON.origin,
    contactEmail: SHARED_COMMON.store.contactEmail,
    accessToken: SHARED_COMMON.accessToken,
  });
  verifyInvariants(baselineSample, {
    origin: SHARED_COMMON.origin,
    contactEmail: SHARED_COMMON.store.contactEmail,
    accessToken: SHARED_COMMON.accessToken,
  });

  // Maximum sizes
  const maxItems = Array.from({ length: 100 }, () => ({
    title: '𠀀'.repeat(120),
    variantLabel: '🎉'.repeat(60),
    quantity: 9999,
  }));

  const renderedMax = renderCommerceEmail({
    template: 'order_confirmed',
    ...SHARED_COMMON,
    store: {
      ...SHARED_COMMON.store,
      name: '🎉'.repeat(80),
    },
    items: maxItems,
    totalMinor: Number.MAX_SAFE_INTEGER,
  });

  verifyInvariants(renderedMax, {
    origin: SHARED_COMMON.origin,
    contactEmail: SHARED_COMMON.store.contactEmail,
    accessToken: SHARED_COMMON.accessToken,
  });
  assert.equal(renderedMax.subject.length <= 200, true);
});

test('COMMERCE_EMAIL_TEMPLATES list matches all 5 templates', () => {
  assert.deepEqual(COMMERCE_EMAIL_TEMPLATES, [
    'order_confirmed',
    'paid_unallocatable',
    'order_access',
    'shipment_handed_over',
    'aftersale_reply',
  ]);
});
