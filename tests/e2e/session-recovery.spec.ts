import { test, expect, type Page, type Route } from './fixtures.js';
import { navigate } from './navigation.js';

async function signIn(page: Page, email: string) {
  await page.getByLabel('電子郵件', { exact: true }).fill(email);
  await page.getByLabel('密碼', { exact: true }).fill('freedom-local-demo');
  await page.getByRole('button', { name: '登入', exact: true }).click();
  await expect(page.locator('.shell')).toBeVisible();
}

test('a pending work mutation cannot expire the replacement session through its old workspace callback', async ({ page, browser, baseURL }) => {
  const title = `Session recovery ${crypto.randomUUID()}`;
  const owner = await browser.newContext({ baseURL });
  let workId: string;
  try {
    const login = await owner.request.post('/api/v1/auth/login', {
      headers: { Origin: baseURL! }, data: { email: 'reviewer@local.test', password: 'freedom-local-demo' },
    });
    expect(login.status()).toBe(200);
    const session = await login.json();
    const created = await owner.request.post('/api/v1/work-items', {
      headers: { Origin: baseURL!, 'X-CSRF-Token': session.csrf_token, 'Idempotency-Key': crypto.randomUUID() },
      data: { title, objective: '驗證延遲回應', acceptance_criteria: '新登入不受影響', gain: '合成測試', estimated_minutes: 15, maximum_minutes: 30,
        claim_by: new Date(Date.now() + 86400000).toISOString(), finish_by: new Date(Date.now() + 2 * 86400000).toISOString(), will_review: true },
    });
    expect(created.ok()).toBe(true);
    workId = (await created.json()).work_item_id;
  } finally { await owner.close(); }
  let held!: Route;
  let captured!: () => void;
  const requested = new Promise<void>(resolve => { captured = resolve; });
  await page.route(`**/api/v1/work-items/${workId}:claim`, route => { held = route; captured(); });
  await page.goto('/');
  await signIn(page, 'maker@local.test');
  await navigate(page, '我的工作');
  await page.locator('article.card').filter({ has: page.getByRole('heading', { name: title, exact: true }) }).getByRole('button', { name: '認領這張工作', exact: true }).click();
  await requested;
  await page.route('**/api/v1/session', route => route.fulfill({ status: 401, json: { code: 'session_expired' } }), { times: 1 });
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(page.locator('.login-card')).toBeVisible();
  await signIn(page, 'client@local.test');
  const finished = page.waitForEvent('requestfinished', request => request === held.request());
  await held.fulfill({ status: 401, json: { code: 'session_expired' } });
  await finished;
  await page.getByRole('button', { name: '設定', exact: true }).click();
  await page.getByRole('menuitem', { name: '登出', exact: true }).click();
  await expect(page.locator('.login-card')).toBeVisible();
  await expect(page.getByText('登入已過期，請重新登入。', { exact: true })).toHaveCount(0);
  expect((await page.request.get('/api/v1/session')).status()).toBe(401);
});

for (const accessExpired of [false, true]) {
  test(`a previous member's delayed ${accessExpired ? 'Access denial' : '401'} preserves the new login`, async ({ page }) => {
    let held!: Route;
    let captured!: () => void;
    const requested = new Promise<void>(resolve => { captured = resolve; });
    await page.route('**/api/v1/me/notifications?limit=6&offset=0', route => {
      if (!held) { held = route; captured(); return; }
      return route.continue();
    });
    await page.goto('/');
    await signIn(page, 'maker@local.test');
    await requested;
    await page.getByRole('button', { name: '設定', exact: true }).click();
    await page.getByRole('menuitem', { name: '登出', exact: true }).click();
    await expect(page.locator('.login-card')).toBeVisible();
    // Stay in this document so the original PortalClient request stays pending.
    await signIn(page, 'client@local.test');
    const current = await (await page.request.get('/api/v1/session')).json();
    const finished = page.waitForEvent('requestfinished', request => request === held.request());
    await held.fulfill(accessExpired
      ? { status: 403, contentType: 'text/html', body: '<html>Expired Access session</html>' }
      : { status: 401, json: { code: 'unauthorized' } });
    await finished;
    // A protected navigation also confirms the new session's CSRF state survived.
    await page.getByRole('button', { name: '設定', exact: true }).click();
    await page.getByRole('menuitem', { name: '登出', exact: true }).click();
    await expect(page.locator('.login-card')).toBeVisible();
    await expect(page.getByText('登入已過期，請重新登入。', { exact: true })).toHaveCount(0);
    expect(current.user.user_id).toBeTruthy();
    expect((await page.request.get('/api/v1/session')).status()).toBe(401);
  });
}
