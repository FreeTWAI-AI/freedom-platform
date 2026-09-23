// Read a temporary Cloudflare service credential from a private file, never argv/logs.
// The operator must remove the temporary Access policy and service token afterward.
import { chromium, request, expect } from '@playwright/test';
import { readFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const origin = 'https://staging.freetwai.com';
const credentialFile = process.env.FREEDOM_ACCESS_TOKEN_FILE;
if (!credentialFile) throw new Error('Set FREEDOM_ACCESS_TOKEN_FILE to a private service-token JSON file.');
const token = JSON.parse(await readFile(credentialFile, 'utf8'));
const headers = { 'CF-Access-Client-Id': token.client_id, 'CF-Access-Client-Secret': token.client_secret };
const evidence = process.env.FREEDOM_STAGING_EVIDENCE_DIR ?? join(homedir(), '.local/state/freedom-staging/verification');
const http = await request.newContext();
const anonymous = await request.newContext(); // Separate cookie jar: authenticated Access responses set cookies.
let browser;
try {
  const denied = await anonymous.get(origin, { maxRedirects: 0 });
  expect(denied.status()).toBe(302);
  expect(new URL(denied.headers().location).hostname.endsWith('.cloudflareaccess.com')).toBe(true);
  console.log('Unauthenticated public visitor is challenged by Access: PASS');

  // A newly installed Access policy can take time to reach the edge.
  await expect.poll(async () => (await http.get(origin + '/api/v1/health', { headers, maxRedirects: 0 })).status(), {
    timeout: 45000, intervals: [1000, 2000, 5000],
  }).toBe(200);
  const health = await http.get(origin + '/api/v1/health', { headers, maxRedirects: 0 });
  expect(health.status()).toBe(200);
  expect(await health.json()).toMatchObject({ status: 'ok', mode: 'staging', money_movement_enabled: false });
  console.log('Authenticated public HTTPS health through Tunnel: PASS');
  for (const name of ['workshop-hub','skill-codex','cooperation-forge','market-network']) {
    const art = await http.get(origin + '/art/rpg/' + name + '.webp', { headers, maxRedirects: 0 });
    expect(art.status(), name).toBe(200);
    expect(art.headers()['content-type']).toContain('image/webp');
    expect((await art.body()).byteLength).toBeGreaterThan(1000);
  }
  console.log('All four workshop illustrations served through Access: PASS');

  const protocol = await http.get(origin + '/api/v1/protocol', { headers, maxRedirects: 0 });
  expect(protocol.status()).toBe(200);
  const expectedProtocol = JSON.parse(await readFile(new URL('../contracts/preview/v1/metadata.json', import.meta.url), 'utf8'));
  expect(await protocol.json()).toEqual(expectedProtocol);
  console.log('Live HTTPS protocol matches the repository contract and SDK pin: PASS');

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  // Never attach the service secret to a redirect or request to another hostname.
  await context.route(origin + '/**', route => route.continue({ headers: { ...route.request().headers(), ...headers } }));
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const readResponses = paths => Promise.all(paths.map(path => page.waitForResponse(response =>
    response.url() === origin + '/api/v1' + path && response.request().method() === 'GET'
  ).then(async response => {
    expect(response.status(), path).toBe(200);
    return { path, body: await response.json() };
  })));
  await page.goto(origin, { waitUntil: 'networkidle' });
  await page.getByLabel('電子郵件', { exact: true }).fill('maker@local.test');
  await page.getByLabel('密碼', { exact: true }).fill('freedom-local-demo');
  const homeReads = readResponses(['/assessment-definition']);
  await page.getByRole('button', { name: '登入', exact: true }).click();
  await homeReads;
  await expect(page.getByRole('heading', { name: '會員首頁', exact: true })).toBeVisible();
  const cookie = (await context.cookies()).find(c => c.name === 'freedom_local_session');
  expect(cookie?.secure).toBe(true);
  expect(cookie?.httpOnly).toBe(true);
  const reloadReads = readResponses(['/assessment-definition']);
  await page.reload();
  await reloadReads;
  await expect(page.getByRole('heading', { name: '會員首頁', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '查看我的定位', exact: true })).toBeVisible();
  await mkdir(evidence, { recursive: true, mode: 0o700 });
  await page.screenshot({ path: join(evidence, 'staging-member-home.png'), fullPage: true });
  console.log('HTTPS browser login, secure session and reload: PASS');

  const modules = [
    ['我的定位', '我的定位', 'positioning', ['/me/onboarding', '/assessment-definition']],
    ['職業公會', '職業公會', 'guilds', ['/guilds/directory']],
    ['供貨中心', '供貨中心', 'supplier', ['/supplier/products', '/supplier/requests']],
    ['開店與銷售', '開店與銷售', 'retail', ['/retail/catalog', '/retail/stores', '/retail/listings']],
    ['開源作品', '開源作品', 'opensource', ['/opensource/projects']],
    ['行銷工作室', '行銷工作室', 'marketing', ['/marketing/campaigns', '/opensource/projects', '/supplier/products']],
    ['我的工作', '工作台', 'workbench', ['/dashboard', '/work-items']],
    ['一般作品與需求', '一般作品與需求', 'showcase', ['/showcases', '/opportunities']],
  ];
  for (const [navigation, heading, file, endpoints] of modules) {
    await page.setViewportSize({ width: 1440, height: 1000 });
    const responses = readResponses(endpoints);
    await page.getByRole('button', { name: navigation, exact: true }).click();
    const data = await responses;
    await expect(page.getByRole('heading', { name: heading, exact: true }).first()).toBeVisible();
    // SPA tab switches don't restart the document's networkidle lifecycle.
    // Wait for module responses and rendered data, not just the new heading.
    await expect(page.getByRole('status').filter({ hasText: /正在載入|載入中/ })).toHaveCount(0);
    await expect(page.getByRole('alert')).toHaveCount(0);
    if (file === 'opensource') await expect(page.getByRole('article', { name: /^開源作品：/ })).toHaveCount(data[0].body.items.length);
    if (file === 'marketing') await expect(page.getByRole('article', { name: /^行銷活動：/ })).toHaveCount(data[0].body.items.length);
    if (file === 'guilds') {
      await expect(page.locator('.guild-master .guild-leadership-role').first()).toHaveText('公會長');
      await expect(page.locator('.guild-master .guild-leadership-avatar').first()).toBeVisible();
    }
    await page.screenshot({ path: join(evidence, `staging-${file}.png`), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${file} mobile overflow`).toBe(true);
    await page.screenshot({ path: join(evidence, `staging-${file}-mobile.png`), fullPage: true });
    console.log(`HTTPS ${file} data and desktop/mobile rendering: PASS`);
  }
  await page.getByRole('button', { name: '登出', exact: true }).click();
  await expect(page.getByRole('heading', { name: '登入', exact: true })).toBeVisible();
  expect(errors).toEqual([]);
  console.log('HTTPS workspace, mobile layout and logout: PASS');
  console.log('Evidence saved to:', evidence);
  console.log('Human email/OTP sign-in remains a separate user check.');
} finally {
  await browser?.close();
  await http.dispose();
  await anonymous.dispose();
}
