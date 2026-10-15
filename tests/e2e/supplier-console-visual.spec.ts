import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import type {BrowserContext, Page} from '@playwright/test';
import {test, expect} from './member-feature-fixture.js';
import {person, login, open, post, launchStore} from './hosted-store-fixture.js';

test.use({
  memberFeatures: {
    guildLaunchpadEnabled: true,
    hostedReservationsEnabled: true,
    supplierConsoleEnabled: true,
  },
});

function parseStore(store: {root: string; hash: string}) {
  const [, , tenantId, , instanceId] = store.root.split('/');
  return {root: store.root, hash: store.hash, tenantId, instanceId};
}

async function patch(page: Page, path: string, body: unknown, status: number, version?: string) {
  const session = await (await page.request.get('/api/v1/session')).json();
  const response = await page.request.patch(`/api/v1${path}`, {
    data: body,
    headers: {
      Origin: new URL(page.url()).origin,
      'X-CSRF-Token': session.csrf_token,
      'Idempotency-Key': randomUUID(),
      ...(version ? {'If-Match': `"${version}"`} : {}),
    },
  });
  const result = await response.json();
  expect(response.status(), JSON.stringify(result)).toBe(status);
  return result;
}

async function get(page: Page, path: string) {
  const response = await page.request.get(`/api/v1${path}`);
  expect(response.status()).toBe(200);
  return response.json();
}

async function withdrawSupplierOffers(db: Pool, supplierUserIds: string[]) {
  if (!supplierUserIds.length) return;
  await db.query(`UPDATE commerce_hosted_supply_offers o
    SET state='withdrawn',version=o.version+1
    FROM commerce_storefront_profiles p JOIN commerce_shops s ON s.shop_id=p.supply_shop_id
    WHERE o.instance_id=p.instance_id AND o.tenant_id=p.tenant_id
      AND s.owner_id=ANY($1::uuid[]) AND o.state='offered'`, [supplierUserIds]);
}

async function setTheme(page: Page, theme: string) {
  await page.addInitScript((t: string) => {
    localStorage.setItem('freedom-theme', t);
  }, theme);
  await page.evaluate((t: string) => {
    localStorage.setItem('freedom-theme', t);
  }, theme);
  await page.reload();
  await page.waitForFunction((t: string) => document.documentElement.dataset.experienceProfile === t, theme);
}

async function navigateTo(page: Page, hash: string) {
  const target = hash.startsWith('#') ? hash : `#${hash}`;
  await page.evaluate(h => { window.location.hash = h; }, target);
}

// The heading is the page's own, so a screenshot never catches the page the hash change is leaving.
async function waitForPageReady(page: Page, isConsole: boolean, heading: string) {
  if (isConsole) {
    await expect(page.locator('.supplier-console')).toBeVisible();
    await expect(page.locator('.sc-content [data-sc-active="true"] h2').first()).toHaveText(heading);
    await expect(page.locator('.supplier-console')).not.toContainText('正在讀取');
  } else {
    await expect(page.locator('.guild-launchpad-heading h1')).toHaveText(heading);
    await expect(page.locator('.guild-launchpad-status')).not.toContainText('正在載入');
    await expect(page.locator('.guild-launchpad-content h2').first()).toBeVisible();
  }
  await page.evaluate(() => { window.scrollTo(0, 0); });
}

type MeasurementData = {
  overflow: { scrollWidth: number; innerWidth: number; pass: boolean };
  navigation?: { navVis: boolean; selectVis: boolean; selectFontSize: number; selectHeight: number; pass: boolean };
  buttons?: { count: number; shortButtons: { text: string; height: number }[]; wideButtons: { text: string; width: number; maxAllowed: number }[]; pass: boolean };
  metrics?: { cardCount: number; rowCount: number; protruding: unknown[]; unequalRows: unknown[]; pass: boolean };
  typography?: { failingBody: unknown[]; failingHint: unknown[]; pass: boolean };
  brand: { checked: boolean; width?: number; height?: number; ratio?: number; target?: number; diff?: number; pass: boolean };
  contrast: { testedCount: number; failing: unknown[]; pass: boolean };
};

test('SC-E2E-40 core console pages hold their layout across widths and themes (AT-40)', async ({browser, baseURL, e2eAuthPool}, testInfo) => {
  test.setTimeout(300_000);
  const contexts: BrowserContext[] = [];
  const supplierIds: string[] = [];
  const suffix = randomUUID().slice(0, 6);
  const measurements: Record<string, MeasurementData> = {};

  let buyerPageToClean: Page | null = null;

  try {
    // 1. Supplier A
    const ctxA = await browser.newContext({baseURL});
    contexts.push(ctxA);
    const memberA = await person(e2eAuthPool);
    supplierIds.push(memberA.id);
    const pageA = await ctxA.newPage();
    await pageA.addInitScript(() => {
      localStorage.setItem('freedom-theme', 'light');
    });
    await login(pageA, memberA.email);

    const rawStoreA = await launchStore(pageA, `視覺驗收供貨空間 ${suffix}`);
    const storeA = parseStore(rawStoreA);
    await post(pageA, storeA.root + '/supply-profile', {name: `視覺驗收供貨庫 ${suffix}`, currency: 'TWD'}, 201);

    // Product 1: Long title (~40 chars Traditional Chinese) to exercise wrapping, saved terms, published offer
    const longTitle = `台灣在地有機手採特級高山烏龍茶禮盒組附雙入紫砂品茗茶杯（初春限定版） ${suffix}`;
    const product1 = await post(pageA, storeA.root + '/supply-products', {
      title: longTitle,
      description: '嚴選高山產區手採烏龍茶葉，茶湯甘醇順口，搭配精選專用紫砂杯，送禮自用皆宜。',
      cost_minor: 400,
      stock: 10,
    }, 201);
    const terms1 = await patch(pageA, storeA.root + `/products/${product1.product_id}/supply-terms`, {
      cost_minor: 400,
      shipping_minor: 50,
      shipping_terms: '確認款項後三個工作天內依序出貨',
      return_terms: '七天內未開封享有退換貨服務',
    }, 200, product1.version);
    const offer1 = await post(pageA, storeA.root + `/products/${product1.product_id}/supply-offer`, {}, 200, terms1.version);

    // Product 2: Stock 0
    const zeroStockTitle = `手作柴燒粗陶隔熱保溫杯 ${suffix}`;
    await post(pageA, storeA.root + '/supply-products', {
      title: zeroStockTitle,
      description: '高溫柴燒獨特紋理，粗陶質樸手感，具備絕佳隔熱與保溫效果。',
      cost_minor: 350,
      stock: 0,
    }, 201);

    // Product 3: Never offered
    const neverOfferedTitle = `實木手工雕花精緻茶盤 ${suffix}`;
    await post(pageA, storeA.root + '/supply-products', {
      title: neverOfferedTitle,
      description: '天然實木雕琢，線條優美俐落，排水孔設計順暢實用。',
      cost_minor: 800,
      stock: 5,
    }, 201);

    // 2. Seller B (with store, setup, proposal on P1 accepted, reservation enabled, published)
    const ctxB = await browser.newContext({baseURL});
    contexts.push(ctxB);
    const memberB = await person(e2eAuthPool);
    const pageB = await ctxB.newPage();
    await login(pageB, memberB.email);
    const rawStoreB = await launchStore(pageB, `賣家空間 B ${suffix}`);
    const storeB = parseStore(rawStoreB);
    const slugB = `store-b-${suffix}`;
    await post(pageB, storeB.root + '/setup', {name: `慢活選物日常店 ${suffix}`, slug: slugB, currency: 'TWD'}, 201);
    const propB = await post(pageB, storeB.root + '/distribution-selections', {
      offer_id: offer1.offer_id,
      terms_sha256: offer1.terms_sha256,
      retail_price_minor: 1100,
    }, 201);

    // Accept B's proposal on Supplier A
    await post(pageA, storeA.root + `/supply-requests/${propB.selection_id}/decision`, {
      decision: 'accepted',
      listing_sha256: propB.listing_sha256 ?? offer1.terms_sha256,
    }, 200, propB.version);

    // Enable reservations on Supplier A
    const settingA = await get(pageA, storeA.root + '/reservation-setting');
    await patch(pageA, storeA.root + '/reservation-setting', {reservation_enabled: true}, 200, settingA.version);

    // Enable reservations and publish on Seller B
    const settingB = await get(pageB, storeB.root + '/reservation-setting');
    await patch(pageB, storeB.root + '/reservation-setting', {reservation_enabled: true}, 200, settingB.version);
    const storeBInfo = await get(pageB, storeB.root);
    await post(pageB, storeB.root + '/publish', {}, 200, storeBInfo.version);

    // 3. Buyer reservation on Seller B's published showcase
    const ctxBuyer = await browser.newContext({baseURL});
    contexts.push(ctxBuyer);
    const memberBuyer = await person(e2eAuthPool);
    const buyerPage = await ctxBuyer.newPage();
    buyerPageToClean = buyerPage;
    await login(buyerPage, memberBuyer.email);
    await buyerPage.goto(`/#reservations/${slugB}`);
    await buyerPage.getByLabel(`${longTitle}數量`, {exact: true}).fill('2');
    await buyerPage.getByRole('button', {name: '查看預留內容', exact: true}).click();
    await expect(buyerPage.getByRole('region', {name: '確認預留內容', exact: true})).toBeVisible();
    await buyerPage.getByRole('button', {name: '確認預留 30 分鐘', exact: true}).click();
    await expect(buyerPage.getByRole('region', {name: '我的預留', exact: true})).toContainText('預留中');

    // 4. Seller C (with store, setup, proposal on P1 pending)
    const ctxC = await browser.newContext({baseURL});
    contexts.push(ctxC);
    const memberC = await person(e2eAuthPool);
    const pageC = await ctxC.newPage();
    await login(pageC, memberC.email);
    const rawStoreC = await launchStore(pageC, `賣家空間 C ${suffix}`);
    const storeC = parseStore(rawStoreC);
    await post(pageC, storeC.root + '/setup', {name: `山居茶堂生活館 ${suffix}`, slug: `store-c-${suffix}`, currency: 'TWD'}, 201);
    const propC = await post(pageC, storeC.root + '/distribution-selections', {
      offer_id: offer1.offer_id,
      terms_sha256: offer1.terms_sha256,
      retail_price_minor: 1300,
    }, 201);

    // Core page routes for Supplier A
    const pages = {
      overview: `${storeA.hash}/supply`,
      products: `${storeA.hash}/supply/products`,
      product: `${storeA.hash}/supply/products/${product1.product_id}`,
      review: `${storeA.hash}/supply/terms/${propC.selection_id}`,
      reservations: `${storeA.hash}/supply/reservations`,
      settings: `${storeA.hash}/supply/settings`,
      'guild-supply': 'guilds/guild_product_quality_supply',
      'guild-sales': 'guilds/guild_commerce_sales',
    };
    const headings: Record<keyof typeof pages, string> = {
      overview: '營運概覽',
      products: '商品與庫存',
      product: `商品詳情：${longTitle}`,
      review: '審核售價申請',
      reservations: '預留與訂單',
      settings: '設定與資料',
      'guild-supply': '商品品質與供應公會',
      'guild-sales': '電商與銷售公會',
    };

    // Measurement & assertion helper for each screenshot
    async function captureAndAssert(pageKey: keyof typeof pages, width: number, theme: string) {
      const id = `${pageKey}-${width}-${theme}`;
      const isConsole = !pageKey.startsWith('guild-');
      await pageA.setViewportSize({width, height: 900});
      await waitForPageReady(pageA, isConsole, headings[pageKey]);
      await pageA.screenshot({path: testInfo.outputPath(`${id}.png`), fullPage: true});

      // 1. Horizontal overflow
      const overflow = await pageA.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
        pass: document.documentElement.scrollWidth <= window.innerWidth,
      }));
      expect.soft(overflow.pass, `[${id}] horizontal overflow: scrollWidth=${overflow.scrollWidth} innerWidth=${overflow.innerWidth}`).toBe(true);

      const m: MeasurementData = {
        overflow,
        brand: {checked: false, pass: true},
        contrast: {testedCount: 0, failing: [], pass: true},
      };

      // 2. Navigation
      if (isConsole) {
        const nav = await pageA.evaluate(w => {
          const navEl = document.querySelector('nav[aria-label="營運中心"]');
          const select = document.querySelector('.console-mobile-nav select') as HTMLSelectElement | null;
          const isVis = (el: Element | null) => {
            if (!el) return false;
            const cs = window.getComputedStyle(el);
            if (cs.display === 'none' || cs.visibility === 'hidden') return false;
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          };
          const navVis = isVis(navEl);
          const selectVis = isVis(select);
          let selectFontSize = 0;
          let selectHeight = 0;
          if (select) {
            const cs = window.getComputedStyle(select);
            selectFontSize = parseFloat(cs.fontSize) || 0;
            selectHeight = select.getBoundingClientRect().height || parseFloat(cs.height) || 0;
          }
          const expectDesktop = w >= 768;
          const navOk = expectDesktop ? (navVis && !selectVis) : (!navVis && selectVis);
          const selectSizeOk = expectDesktop ? true : (selectFontSize >= 15.9 && selectHeight >= 43.9);
          return {navVis, selectVis, selectFontSize, selectHeight, navOk, selectSizeOk, pass: navOk && selectSizeOk};
        }, width);
        m.navigation = nav;
        expect.soft(nav.navOk, `[${id}] navigation visibility (navVis=${nav.navVis}, selectVis=${nav.selectVis})`).toBe(true);
        if (width < 768) {
          expect.soft(nav.selectSizeOk, `[${id}] mobile nav select size (font=${nav.selectFontSize}px, height=${nav.selectHeight}px)`).toBe(true);
        }

        // 3. Buttons
        const buttons = await pageA.evaluate(w => {
          const sc = document.querySelector('.supplier-console');
          const content = document.querySelector('.sc-content');
          if (!sc) return {count: 0, shortButtons: [], wideButtons: [], pass: true};
          const contentWidth = content?.getBoundingClientRect().width ?? 0;
          const isVis = (el: Element) => {
            const cs = window.getComputedStyle(el);
            if (cs.display === 'none' || cs.visibility === 'hidden') return false;
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          };
          const allButtons = Array.from(sc.querySelectorAll('.btn, button')).filter(isVis);
          const shortButtons: {text: string; height: number}[] = [];
          const wideButtons: {text: string; width: number; maxAllowed: number}[] = [];
          for (const b of allButtons) {
            const rect = b.getBoundingClientRect();
            if (rect.height < 27.9) {
              shortButtons.push({text: (b.textContent || '').trim().slice(0, 30), height: rect.height});
            }
            if (w >= 768 && contentWidth > 0 && rect.width > contentWidth * 0.9 + 0.5) {
              wideButtons.push({text: (b.textContent || '').trim().slice(0, 30), width: rect.width, maxAllowed: contentWidth * 0.9});
            }
          }
          return {count: allButtons.length, shortButtons, wideButtons, pass: shortButtons.length === 0 && wideButtons.length === 0};
        }, width);
        m.buttons = buttons;
        expect.soft(buttons.shortButtons.length, `[${id}] buttons shorter than 28px: ${JSON.stringify(buttons.shortButtons)}`).toBe(0);
        if (width >= 768) {
          expect.soft(buttons.wideButtons.length, `[${id}] buttons wider than 90% content: ${JSON.stringify(buttons.wideButtons)}`).toBe(0);
        }

        // 4. Metrics (overview only)
        if (pageKey === 'overview') {
          const metrics = await pageA.evaluate(() => {
            const scMetrics = document.querySelector('.sc-metrics');
            if (!scMetrics) return {cardCount: 0, rowCount: 0, protruding: [], unequalRows: [], pass: true};
            const containerBottom = scMetrics.getBoundingClientRect().bottom;
            const cards = Array.from(scMetrics.querySelectorAll('.card'));
            const protruding: {index: number; cardBottom: number; containerBottom: number}[] = [];
            const rows: {top: number; heights: number[]}[] = [];
            cards.forEach((card, idx) => {
              const rect = card.getBoundingClientRect();
              if (rect.bottom > containerBottom + 1.0) {
                protruding.push({index: idx, cardBottom: rect.bottom, containerBottom});
              }
              let foundRow = rows.find(r => Math.abs(r.top - rect.top) <= 2.0);
              if (!foundRow) {
                foundRow = {top: rect.top, heights: []};
                rows.push(foundRow);
              }
              foundRow.heights.push(rect.height);
            });
            const unequalRows: {rowTop: number; heights: number[]; diff: number}[] = [];
            for (const r of rows) {
              const minH = Math.min(...r.heights);
              const maxH = Math.max(...r.heights);
              const diff = maxH - minH;
              if (diff > 1.0) {
                unequalRows.push({rowTop: r.top, heights: r.heights, diff});
              }
            }
            return {cardCount: cards.length, rowCount: rows.length, protruding, unequalRows, pass: protruding.length === 0 && unequalRows.length === 0};
          });
          m.metrics = metrics;
          expect.soft(metrics.protruding.length, `[${id}] metric cards extending below container: ${JSON.stringify(metrics.protruding)}`).toBe(0);
          expect.soft(metrics.unequalRows.length, `[${id}] metric cards with unequal row heights: ${JSON.stringify(metrics.unequalRows)}`).toBe(0);
        }

        // 5. Body text
        const typography = await pageA.evaluate(() => {
          const sc = document.querySelector('.supplier-console');
          if (!sc) return {failingBody: [], failingHint: [], pass: true};
          const isVis = (el: Element) => {
            const cs = window.getComputedStyle(el);
            if (cs.display === 'none' || cs.visibility === 'hidden') return false;
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          };
          const all = Array.from(sc.querySelectorAll('p, li, td, .field-hint'));
          const failingBody: {tag: string; text: string; fontSize: number}[] = [];
          const failingHint: {tag: string; text: string; fontSize: number}[] = [];
          for (const el of all) {
            if (!isVis(el)) continue;
            if (el.closest('.sr-only')) continue;
            if (!el.textContent?.trim()) continue;
            const cs = window.getComputedStyle(el);
            const fontSize = parseFloat(cs.fontSize) || 0;
            const isHint = el.classList.contains('field-hint') || !!el.closest('.field-hint');
            if (isHint) {
              if (fontSize < 11.9) failingHint.push({tag: el.tagName, text: el.textContent.trim().slice(0, 30), fontSize});
            } else {
              if (fontSize < 13.9) failingBody.push({tag: el.tagName, text: el.textContent.trim().slice(0, 30), fontSize});
            }
          }
          return {failingBody, failingHint, pass: failingBody.length === 0 && failingHint.length === 0};
        });
        m.typography = typography;
        expect.soft(typography.failingBody.length, `[${id}] body text < 14px: ${JSON.stringify(typography.failingBody)}`).toBe(0);
        expect.soft(typography.failingHint.length, `[${id}] field hint < 12px: ${JSON.stringify(typography.failingHint)}`).toBe(0);
      }

      // 6. Brand proportion
      const brand = await pageA.evaluate(() => {
        const el = document.querySelector('.sidebar-brand-art');
        if (!el) return {checked: false, pass: true};
        const cs = window.getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden') return {checked: false, pass: true};
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return {checked: false, pass: true};
        const ratio = rect.width / rect.height;
        const target = 1280 / 720;
        const diff = Math.abs(ratio - target) / target;
        return {checked: true, width: rect.width, height: rect.height, ratio, target, diff, pass: diff <= 0.02};
      });
      m.brand = brand;
      if (brand.checked) {
        expect.soft(brand.pass, `[${id}] brand logo ratio diff ${(brand.diff! * 100).toFixed(2)}% (ratio=${brand.ratio!.toFixed(4)}, target=${brand.target!.toFixed(4)})`).toBe(true);
      }

      // 7. Text contrast (h2 and .badge)
      const contrast = await pageA.evaluate(isConsole => {
        function parseRgb(colorStr: string) {
          const parts = colorStr.match(/[\d.]+/g)?.map(Number) ?? [];
          return {
            r: parts[0] ?? 0,
            g: parts[1] ?? 0,
            b: parts[2] ?? 0,
            a: parts.length > 3 ? parts[3] : 1,
          };
        }
        function channelLuminance(value: number) {
          const s = value / 255;
          return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
        }
        function relativeLuminance(color: {r: number; g: number; b: number}) {
          return 0.2126 * channelLuminance(color.r) + 0.7152 * channelLuminance(color.g) + 0.0722 * channelLuminance(color.b);
        }
        function contrastRatio(fg: {r: number; g: number; b: number}, bg: {r: number; g: number; b: number}) {
          const lum1 = relativeLuminance(fg);
          const lum2 = relativeLuminance(bg);
          const lighter = Math.max(lum1, lum2);
          const darker = Math.min(lum1, lum2);
          return (lighter + 0.05) / (darker + 0.05);
        }
        function findBackground(element: Element) {
          let curr: Element | null = element;
          while (curr) {
            const cs = window.getComputedStyle(curr);
            if (cs.backgroundImage && cs.backgroundImage !== 'none') {
              return {type: 'image' as const, color: null};
            }
            const bg = parseRgb(cs.backgroundColor);
            if (bg.a > 0.05) {
              return {type: 'color' as const, color: bg};
            }
            curr = curr.parentElement;
          }
          const docCs = window.getComputedStyle(document.documentElement);
          if (docCs.backgroundImage && docCs.backgroundImage !== 'none') {
            return {type: 'image' as const, color: null};
          }
          const docBg = parseRgb(docCs.backgroundColor);
          if (docBg.a > 0.05) return {type: 'color' as const, color: docBg};
          return {type: 'color' as const, color: {r: 255, g: 255, b: 255, a: 1}};
        }
        const isVis = (el: Element) => {
          const cs = window.getComputedStyle(el);
          if (cs.display === 'none' || cs.visibility === 'hidden') return false;
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        };

        const targets: {el: Element; kind: string}[] = [];
        if (isConsole) {
          const activeH2 = document.querySelector('.sc-content [data-sc-active="true"] h2') || document.querySelector('.supplier-console h2');
          if (activeH2 && isVis(activeH2)) targets.push({el: activeH2, kind: 'h2'});
          const badges = Array.from(document.querySelectorAll('.supplier-console .badge')).filter(isVis);
          for (const b of badges) targets.push({el: b, kind: 'badge'});
        } else {
          const guildH2 = document.querySelector('.guild-launchpad-content h2') || document.querySelector('.guild-launchpad-block h2') || document.querySelector('h2');
          if (guildH2 && isVis(guildH2)) targets.push({el: guildH2, kind: 'h2'});
        }

        const tested: {kind: string; text: string; fg: string; bg: string | null; ratio: number | null; skipped: boolean; reason?: string; pass: boolean}[] = [];
        for (const t of targets) {
          const cs = window.getComputedStyle(t.el);
          const bgInfo = findBackground(t.el);
          if (bgInfo.type === 'image') {
            tested.push({
              kind: t.kind,
              text: (t.el.textContent || '').trim().slice(0, 30),
              fg: cs.color,
              bg: null,
              ratio: null,
              skipped: true,
              reason: 'background-image',
              pass: true,
            });
            continue;
          }
          const fgColor = parseRgb(cs.color);
          const ratio = contrastRatio(fgColor, bgInfo.color!);
          const pass = ratio >= 4.49;
          tested.push({
            kind: t.kind,
            text: (t.el.textContent || '').trim().slice(0, 30),
            fg: cs.color,
            bg: `rgba(${bgInfo.color!.r}, ${bgInfo.color!.g}, ${bgInfo.color!.b}, ${bgInfo.color!.a})`,
            ratio,
            skipped: false,
            pass,
          });
        }
        const failing = tested.filter(item => !item.skipped && !item.pass);
        return {testedCount: tested.length, failing, pass: failing.length === 0};
      }, isConsole);
      m.contrast = contrast;
      expect.soft(contrast.failing.length, `[${id}] contrast failures: ${JSON.stringify(contrast.failing)}`).toBe(0);

      measurements[id] = m;
    }

    // Step A: Light theme across all core pages (1440, 1280, 768, 390, 320 px)
    await setTheme(pageA, 'light');
    const lightCorePages: (keyof typeof pages)[] = ['overview', 'products', 'product', 'review', 'reservations', 'settings'];
    const lightWidths = [1440, 1280, 768, 390, 320];

    for (const pageKey of lightCorePages) {
      await navigateTo(pageA, pages[pageKey]);
      for (const width of lightWidths) {
        await captureAndAssert(pageKey, width, 'light');
      }
    }

    // Step B: Guild pages regression in light theme (1440, 390 px)
    const guildPages: (keyof typeof pages)[] = ['guild-supply', 'guild-sales'];
    for (const pageKey of guildPages) {
      await navigateTo(pageA, pages[pageKey]);
      for (const width of [1440, 390]) {
        await captureAndAssert(pageKey, width, 'light');
      }
    }

    // Step C: Other themes (dark, versefolk, guide-dragon, guide-ai-sister) for overview, products, product at 1440 and 390 px
    const otherThemes = ['dark', 'versefolk', 'guide-dragon', 'guide-ai-sister'] as const;
    const otherPages: (keyof typeof pages)[] = ['overview', 'products', 'product'];

    for (const theme of otherThemes) {
      await setTheme(pageA, theme);
      for (const pageKey of otherPages) {
        await navigateTo(pageA, pages[pageKey]);
        for (const width of [1440, 390]) {
          await captureAndAssert(pageKey, width, theme);
        }
      }
    }
  } finally {
    if (buyerPageToClean) {
      try {
        buyerPageToClean.once('dialog', d => d.accept());
        const cancelBtn = buyerPageToClean.getByRole('button', {name: '取消預留', exact: true});
        if (await cancelBtn.isVisible()) {
          await cancelBtn.click();
        }
      } catch {}
    }
    await Promise.allSettled(contexts.map(c => c.close()));
    await withdrawSupplierOffers(e2eAuthPool, supplierIds);
    await testInfo.attach('measurements', {
      body: JSON.stringify(measurements, null, 2),
      contentType: 'application/json',
    });
  }
});
