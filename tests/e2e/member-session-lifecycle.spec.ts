import { createHash } from 'node:crypto';
import { test, expect, type Page } from './fixtures.js';
import { signOut } from './navigation.js';

// #107 narrow regression coverage. A fresh page shares the browser's cookie jar;
// this does not claim to test an OS/browser restart or a password-manager vault.
async function login(page: Page) {
  await page.goto('/');
  const email = page.getByLabel('電子郵件', { exact: true });
  const password = page.getByLabel('密碼', { exact: true });
  await expect(email).toHaveAttribute('autocomplete', 'username');
  await expect(password).toHaveAttribute('autocomplete', 'current-password');
  await email.fill('maker@local.test');
  await password.fill('freedom-local-demo');
  await page.getByRole('button', { name: '登入', exact: true }).click();
  await expect(page.getByRole('heading', { name: '會員首頁', exact: true })).toBeVisible();
}

async function sessionCookie(page: Page) {
  const cookie = (await page.context().cookies(page.url())).find(value => value.name === 'freedom_local_session');
  expect(cookie).toBeDefined();
  return cookie!;
}

test('returning member reloads and reopens a page without submitting credentials again', async ({ page, context, baseURL }) => {
  let logins = 0;
  context.on('request', request => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/v1/auth/login') logins++;
  });
  await login(page);
  const initial = await sessionCookie(page);
  expect(initial.httpOnly).toBe(true);
  expect(initial.sameSite).toBe('Strict');
  expect(initial.expires).toBeGreaterThan(Date.now() / 1000 + 7 * 60 * 60);
  expect(initial.expires).toBeLessThanOrEqual(Date.now() / 1000 + 8 * 60 * 60);
  await page.reload();
  await expect(page.getByRole('heading', { name: '會員首頁', exact: true })).toBeVisible();
  await page.close();
  const returning = await context.newPage();
  await returning.goto(baseURL!);
  await expect(returning.getByRole('heading', { name: '會員首頁', exact: true })).toBeVisible();
  expect(await sessionCookie(returning)).toMatchObject({ value: initial.value, expires: initial.expires });
  expect(logins).toBe(1);
});

test('expired browser cookie returns to login even when the server session has not expired', async ({ page, context }) => {
  await login(page);
  const cookie = await sessionCookie(page);
  await context.addCookies([{ ...cookie, expires: Math.floor(Date.now() / 1000) - 60 }]);
  await page.reload();
  await expect(page.getByRole('heading', { name: '登入', exact: true })).toBeVisible();
  const missing = await page.request.get('/api/v1/session');
  expect(missing.status()).toBe(401);
  expect((await missing.json()).code).toBe('login_required');
  // The synthetic server session is deliberately still valid. This distinguishes
  // browser-cookie retention from server expiry instead of extending either one.
  expect((await page.request.get('/api/v1/session', { headers: { Cookie: `${cookie.name}=${cookie.value}` } })).status()).toBe(200);
});

test('expired server session returns to login despite a retained browser cookie', async ({ page, e2eAuthPool }) => {
  await login(page);
  const cookie = await sessionCookie(page);
  const hash = createHash('sha256').update(cookie.value).digest('hex');
  const expired = await e2eAuthPool.query("UPDATE sessions SET expires_at=now()-interval '1 second' WHERE token_hash=$1", [hash]);
  expect(expired.rowCount).toBe(1);
  await page.reload();
  await expect(page.getByRole('heading', { name: '登入', exact: true })).toBeVisible();
  expect((await sessionCookie(page)).value).toBe(cookie.value);
  const response = await page.request.get('/api/v1/session');
  expect(response.status()).toBe(401);
  expect((await response.json()).code).toBe('session_expired');
});

test('logout rejects a captured cookie and a previously open page cannot restore the session', async ({ page, context, baseURL }) => {
  await login(page);
  const cookie = await sessionCookie(page);
  const otherPage = await context.newPage();
  await otherPage.goto(baseURL!);
  await expect(otherPage.getByRole('heading', { name: '會員首頁', exact: true })).toBeVisible();
  await signOut(page);
  expect((await context.cookies(baseURL!)).some(value => value.name === cookie.name)).toBe(false);
  const replay = await page.request.get('/api/v1/session', { headers: { Cookie: `${cookie.name}=${cookie.value}` } });
  expect(replay.status()).toBe(401);
  expect((await replay.json()).code).toBe('session_expired');
  await otherPage.reload();
  await expect(otherPage.getByRole('heading', { name: '登入', exact: true })).toBeVisible();
  await expect(otherPage.locator('.shell')).toHaveCount(0);
});
