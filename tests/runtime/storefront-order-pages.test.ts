import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import { createApp } from '../../apps/platform-api/src/app.js';
import { storeMissingHtml } from '../../modules/agent-commerce/hosted/page.js';
import { orderAccessPageHtml, orderMissingHtml, orderPageHtml } from '../../modules/agent-commerce/storefront/pages.js';
import { formatTaipeiDateTime } from '../../apps/portal-web/src/storefront/format.js';
import { orderEmailNote, type PaymentView } from '../../apps/portal-web/src/storefront/payment-view.js';
import { checkoutHarness, ok, type CheckoutHarness } from './hosted-checkout-harness.js';
import { TENANT_CURSOR_TEST_KEY } from './tenant-cursor-fixture.js';

let x: CheckoutHarness;

async function accessCounts() {
  return (
    await x.h.pool.query<{ devices: number; grants: number }>(
      'SELECT (SELECT count(*)::int FROM commerce_access_devices) AS devices, (SELECT count(*)::int FROM commerce_order_access_grants) AS grants',
    )
  ).rows[0];
}

before(async () => {
  x = await checkoutHarness('fc_storefront_pages');
});

beforeEach(async () => {
  await x.reset();
});

after(async () => {
  await x?.stop();
});

test('order page serves identical no-store HTML shell for real and random order refs without cookies or DB writes', async () => {
  const s = await x.store();
  const c = await x.frozen(s, 2);
  const placed = await x.place(s, c);
  const randomRef = randomUUID();
  const before = await accessCounts();

  const realRes = await x.app.request(`${x.h.origin}/shops/${s.slug}/orders/${placed.order_id}`);
  const randomRes = await x.app.request(`${x.h.origin}/shops/${s.slug.toUpperCase()}/orders/${randomRef}`);
  const realHtml = await realRes.text();
  const randomHtml = await randomRes.text();

  for (const res of [realRes, randomRes]) {
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /^text\/html\b/i);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(res.headers.get('x-robots-tag'), 'noindex');
    assert.match(res.headers.get('content-security-policy') ?? '', /script-src 'self'/);
    assert.equal(res.headers.get('set-cookie'), null);
  }

  assert.equal(realHtml.replaceAll(placed.order_id, randomRef), randomHtml);
  assert.ok(realHtml.startsWith('<!doctype html><html lang="zh-Hant">'));
  assert.ok(realHtml.includes('<body><a class="shop-skip-link" href="#main">跳到主要內容</a>'));
  assert.equal(realHtml.match(/<script\b/gi)?.length, 1);
  assert.ok(realHtml.includes('<script type="module" src="/assets/storefront.js"></script>'));
  assert.equal(/\bon[a-z]+\s*=/i.test(realHtml), false);
  assert.equal(realHtml.match(/<h1\b/gi)?.length, 1);
  assert.ok(realHtml.includes('<h1 id="shop-order-title">訂單</h1>'));
  assert.ok(realHtml.includes('<p role="status">正在讀取訂單…</p>'));
  assert.ok(realHtml.includes('<noscript><p>查看訂單需要開啟瀏覽器的 JavaScript。</p></noscript>'));
  assert.ok(realHtml.includes(`data-store-slug="${s.slug}"`));
  assert.ok(realHtml.includes('data-store-name="合成商店"'));
  assert.ok(realHtml.includes(`data-order-ref="${placed.order_id}"`));
  assert.ok(realHtml.includes('data-email-enabled="false"'));
  assert.ok(!realHtml.includes(placed.display_number));

  const emailApp = createApp(x.runtime, x.h.origin, 'local', {
    guildLaunchpadEnabled: true,
    hostedReservationsEnabled: true,
    tenantCursorSigningKey: TENANT_CURSOR_TEST_KEY,
    commerceSettings: { checkoutEnabled: true, emailEnabled: true, quarantine: false, providerProfiles: [] },
  });
  const emailRes = await emailApp.request(`${x.h.origin}/shops/${s.slug}/orders/${placed.order_id}`);
  assert.equal(emailRes.status, 200);
  const emailHtml = await emailRes.text();
  assert.equal(emailHtml, orderPageHtml({ slug: s.slug, name: '合成商店' }, placed.order_id, { emailEnabled: true }));
  assert.ok(emailHtml.includes('data-email-enabled="true"'));

  assert.deepEqual(await accessCounts(), before);
});

test('404s cover unknown slug, invalid order_ref shapes and unpublished stores without scripts or writes', async () => {
  const s = await x.store();
  const c = await x.frozen(s, 1);
  const placed = await x.place(s, c);
  const before = await accessCounts();

  for (const path of [`/shops/no-such-store/orders/${placed.order_id}`, '/shops/no-such-store/order-access']) {
    const res = await x.app.request(x.h.origin + path);
    assert.equal(res.status, 404);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(res.headers.get('x-robots-tag'), 'noindex');
    assert.equal(res.headers.get('set-cookie'), null);
    assert.equal(await res.text(), storeMissingHtml());
  }

  const upperUuid = placed.order_id.toUpperCase();
  const badVersionUuid = placed.order_id.replace(/^([0-9a-f]{8}-[0-9a-f]{4}-)[1-8]/, '$10');
  for (const badRef of ['abc', upperUuid, badVersionUuid]) {
    const res = await x.app.request(`${x.h.origin}/shops/${s.slug}/orders/${badRef}`);
    const html = await res.text();
    assert.equal(res.status, 404);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(res.headers.get('x-robots-tag'), 'noindex');
    assert.equal(res.headers.get('set-cookie'), null);
    assert.equal(html, orderMissingHtml({ slug: s.slug, name: '合成商店' }));
    assert.equal(html.includes('<script'), false);
    assert.ok(html.includes('找不到這筆訂單'));
    assert.ok(html.includes(`/shops/${s.slug}/order-access`));
  }

  const current = ok(await x.h.call('GET', s.root, s.owner, undefined, {}, x.app));
  ok(await x.send(s, '/unpublish', {}, current.version));

  for (const path of [`/shops/${s.slug}/orders/${placed.order_id}`, `/shops/${s.slug}/order-access`]) {
    const res = await x.app.request(x.h.origin + path);
    assert.equal(res.status, 404);
    assert.equal(res.headers.get('set-cookie'), null);
    assert.equal(await res.text(), storeMissingHtml());
  }

  assert.deepEqual(await accessCounts(), before);
});

test('B10 order-access page serves the exact EC-SPEC-10 §6.2 copy without form, input, script or DB writes when emailEnabled is off', async () => {
  const s = await x.store();
  const before = await accessCounts();

  const res = await x.app.request(`${x.h.origin}/shops/${s.slug}/order-access`);
  const html = await res.text();
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /^text\/html\b/i);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('x-robots-tag'), 'noindex');
  assert.equal(res.headers.get('set-cookie'), null);
  assert.equal(html, orderAccessPageHtml({ slug: s.slug, name: '合成商店' }));
  assert.equal(html, orderAccessPageHtml({ slug: s.slug, name: '合成商店' }, { emailEnabled: false }));
  assert.ok(html.includes('<title>找回訂單｜合成商店｜自由工坊</title>'));
  assert.ok(html.includes('<h1>找回訂單</h1>'));
  assert.ok(html.includes('<p>這間店目前不寄確認信，請用這個瀏覽器回到訂單，或聯絡店家。</p>'));
  assert.ok(html.includes(`<a href="/shops/${s.slug}">回到「合成商店」</a>`));
  assert.equal(/<(?:form|input|script)\b/i.test(html), false);
  assert.deepEqual(await accessCounts(), before);
});

test('B10 order-access page serves the form with Email, 訂單編號, submit button and storefront script when emailEnabled is on', async () => {
  const s = await x.store();
  const before = await accessCounts();
  const emailApp = createApp(x.runtime, x.h.origin, 'local', {
    guildLaunchpadEnabled: true,
    hostedReservationsEnabled: true,
    tenantCursorSigningKey: TENANT_CURSOR_TEST_KEY,
    commerceSettings: { checkoutEnabled: true, emailEnabled: true, quarantine: false, providerProfiles: [] },
  });

  const res = await emailApp.request(`${x.h.origin}/shops/${s.slug}/order-access`);
  const html = await res.text();
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /^text\/html\b/i);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('x-robots-tag'), 'noindex');
  assert.equal(res.headers.get('set-cookie'), null);
  assert.equal(html, orderAccessPageHtml({ slug: s.slug, name: '合成商店' }, { emailEnabled: true }));
  assert.ok(html.includes('<script type="module" src="/assets/storefront.js"></script>'));
  assert.ok(html.includes('<h1 id="shop-order-access-title" tabindex="-1">找回訂單</h1>'));
  assert.ok(html.includes('<form class="shop-order-section" method="post" novalidate>'));
  assert.ok(html.includes('<label class="shop-add-label" for="shop-order-access-email">Email</label>'));
  assert.ok(html.includes('<input id="shop-order-access-email"'));
  assert.ok(html.includes('<label class="shop-add-label" for="shop-order-access-display-number">訂單編號</label>'));
  assert.ok(html.includes('<input id="shop-order-access-display-number"'));
  assert.ok(html.includes('placeholder="261015-ABCDEF"'));
  assert.ok(html.includes('<button type="submit" class="shop-button shop-pay-primary" disabled>寄送查看連結</button>'));
  assert.ok(html.includes('<noscript><p>寄送查看連結需要開啟瀏覽器的 JavaScript。</p></noscript>'));
  assert.ok(html.includes(`<a href="/shops/${s.slug}">回到「合成商店」</a>`));
  assert.equal(html.includes('這間店目前不寄確認信'), false);
  assert.equal(/\bon[a-z]+\s*=/i.test(html), false);
  assert.deepEqual(await accessCounts(), before);
});

test('store name with HTML characters is escaped in title, header and data attributes', async () => {
  const s = await x.store();
  const rawName = `<img src=x onerror=alert(1)>&"'`;
  const escapedName = '&lt;img src=x onerror=alert(1)&gt;&amp;&quot;&#39;';
  const current = ok(await x.h.call('GET', s.root, s.owner, undefined, {}, x.app));
  ok(await x.send(s, '', { name: rawName }, current.version, 'PATCH'));
  await x.publish(s);

  const orderRef = randomUUID();
  const before = await accessCounts();
  const orderRes = await x.app.request(`${x.h.origin}/shops/${s.slug}/orders/${orderRef}`);
  const orderHtml = await orderRes.text();
  assert.equal(orderRes.status, 200);
  assert.equal(orderHtml, orderPageHtml({ slug: s.slug, name: rawName }, orderRef));
  assert.ok(orderHtml.includes(`<title>訂單｜${escapedName}｜自由工坊</title>`));
  assert.ok(orderHtml.includes(`<a class="shop-top-store" href="/shops/${s.slug}">${escapedName}</a>`));
  assert.ok(orderHtml.includes(`data-store-name="${escapedName}"`));
  assert.equal(orderHtml.includes('<img src=x'), false);
  assert.equal(/\bon[a-z]+\s*=/i.test(orderHtml.replaceAll(escapedName, '')), false);

  const b10Res = await x.app.request(`${x.h.origin}/shops/${s.slug}/order-access`);
  const b10Html = await b10Res.text();
  assert.equal(b10Res.status, 200);
  assert.ok(b10Html.includes(`<title>找回訂單｜${escapedName}｜自由工坊</title>`));
  assert.ok(b10Html.includes(`<a href="/shops/${s.slug}">回到「${escapedName}」</a>`));
  assert.equal(b10Html.includes('<img src=x'), false);

  const b10EnabledHtml = orderAccessPageHtml({ slug: s.slug, name: rawName }, { emailEnabled: true });
  assert.ok(b10EnabledHtml.includes(`data-store-name="${escapedName}"`));
  assert.ok(b10EnabledHtml.includes(`<a href="/shops/${s.slug}">回到「${escapedName}」</a>`));
  assert.equal(b10EnabledHtml.includes('<img src=x'), false);

  assert.deepEqual(await accessCounts(), before);
});

test('orderEmailNote returns the off copy for every view and the pre-payment copy only for allowlisted views when on', () => {
  const allViews: PaymentView[] = ['ready', 'awaiting', 'checking', 'failed', 'expired', 'paid', 'review', 'closed'];
  for (const view of allViews) {
    assert.equal(orderEmailNote(view, false), '這間店目前不寄確認信，請用這個瀏覽器回到訂單，或聯絡店家。');
  }
  for (const view of ['ready', 'awaiting', 'checking', 'failed', 'expired'] as const) {
    assert.equal(orderEmailNote(view, true), '付款確認後，訂單成立信會寄到你填寫的 Email。');
  }
  for (const view of ['paid', 'review', 'closed'] as const) {
    assert.equal(orderEmailNote(view, true), null);
  }
  assert.equal(orderEmailNote('refunded' as unknown as PaymentView, true), null);
});

test('formatTaipeiDateTime formats Asia/Taipei 24-hour timestamps including midnight crossing', () => {
  assert.equal(formatTaipeiDateTime('2026-10-15T16:30:00.000Z'), '2026/10/16 00:30');
  assert.equal(formatTaipeiDateTime('2026-01-05T01:05:00.000Z'), '2026/01/05 09:05');
  assert.equal(formatTaipeiDateTime('2026-12-31T15:59:00.000Z'), '2026/12/31 23:59');
});
