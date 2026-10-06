import { randomUUID } from 'node:crypto';
import type { Browser, Page } from '@playwright/test';
import { test, expect } from './fixtures.js';
import { navigate } from './navigation.js';
import { DEMO_COMMUNITY, DEMO_PASSWORD } from '../../packages/testing/seed.js';
import { hashPassword } from '../../modules/identity-membership/service.js';

type Person = { user_id: string; email: string; display_name: string };

async function seed(db: import('pg').Pool, run: string): Promise<[Person, Person]> {
  const people: [Person, Person] = [
    { user_id: randomUUID(), email: `transfer-owner-${run}@example.test`, display_name: `移交主人${run}` },
    { user_id: randomUUID(), email: `transfer-guest-${run}@example.test`, display_name: `移交接收${run}` },
  ];
  for (const person of people) {
    await db.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref,onboarding_required)
      VALUES($1,$2,$3,$4,$5,$6,false)`, [person.user_id, DEMO_COMMUNITY, person.email, person.display_name, hashPassword(DEMO_PASSWORD), randomUUID()]);
  }
  return people;
}
async function cleanup(db: import('pg').Pool, people: Person[]) {
  const ids = people.map(person => person.user_id);
  await db.query('UPDATE sessions SET revoked_at=now() WHERE user_id=ANY($1::uuid[])', [ids]);
  await db.query('UPDATE users SET active=false WHERE user_id=ANY($1::uuid[])', [ids]);
}
async function open(browser: Browser, baseURL: string, person: Person, viewport: { width: number; height: number }) {
  const context = await browser.newContext({ baseURL, viewport });
  await context.route(url => !['127.0.0.1', 'localhost'].includes(url.hostname), route => route.abort());
  const page = await context.newPage();
  await page.goto('/');
  await page.getByLabel('電子郵件', { exact: true }).fill(person.email);
  await page.getByLabel('密碼', { exact: true }).fill(DEMO_PASSWORD);
  await page.getByRole('button', { name: '登入', exact: true }).click();
  await expect(page.getByRole('button', { name: '設定', exact: true })).toBeVisible();
  return { context, page };
}
async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}
async function widthAgainstForm(page: Page, name: string) {
  const button = page.getByRole('button', { name, exact: true });
  const form = button.locator('xpath=ancestor::form[1]');
  const buttonBox = await button.boundingBox();
  const formBox = await form.boundingBox();
  expect(buttonBox).not.toBeNull();
  expect(formBox).not.toBeNull();
  return buttonBox!.width / formBox!.width;
}

type Posted = { method: string; path: string; key?: string; ifMatch?: string; body: string | null };

function recordPosts(page: Page): Posted[] {
  const posted: Posted[] = [];
  page.on('request', request => {
    if (request.method() !== 'POST') return;
    const headers = request.headers();
    posted.push({
      method: request.method(),
      path: new URL(request.url()).pathname,
      key: headers['idempotency-key'],
      ifMatch: headers['if-match'],
      body: request.postData(),
    });
  });
  return posted;
}

function isHighRisk(path: string) {
  return path === '/api/v1/me/high-risk-verifications';
}

function isFollowUp(path: string) {
  return /\/ownership-transfers(?:\/|$)/.test(path) || /\/tenant-recovery-cases\/[^/]+\/accept$/.test(path);
}

/** Hold the fresh-auth response until the dialog is dismissed, then prove the
 * captured command is not sent. A short bound after the body arrives is the
 * only way to observe that no follow-up was emitted. */
async function dismissHeldVerification(page: Page, posted: Posted[], gesture: 'escape' | 'cancel') {
  let release: (() => void) | undefined;
  let arrived: (() => void) | undefined;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const held = new Promise<void>(resolve => { arrived = resolve; });
  let armed = true;
  await page.route('**/api/v1/me/high-risk-verifications', async route => {
    if (route.request().method() !== 'POST' || !armed) {
      await route.continue();
      return;
    }
    armed = false;
    arrived?.();
    await gate;
    await route.continue();
  });
  const password = page.getByLabel('目前的密碼', { exact: true });
  const before = posted.length;
  await password.pressSequentially(DEMO_PASSWORD);
  await page.getByRole('button', { name: '確認密碼', exact: true }).click();
  await held;
  if (gesture === 'escape') await page.keyboard.press('Escape');
  else await page.getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.getByRole('heading', { name: '重新驗證', exact: true })).toBeHidden();
  const response = page.waitForResponse(candidate => candidate.request().method() === 'POST' && isHighRisk(new URL(candidate.url()).pathname));
  release?.();
  await (await response).finished();
  await page.waitForTimeout(1000);
  const added = posted.slice(before);
  const leaked = added.filter(item => isFollowUp(item.path));
  expect(leaked, `${gesture} sent ${JSON.stringify(leaked)}`).toEqual([]);
  expect(added.filter(item => isHighRisk(item.path))).toHaveLength(1);
  await page.unroute('**/api/v1/me/high-risk-verifications');
}

async function confirmPropose(page: Page, posted: Posted[], recipientName: string) {
  const before = posted.length;
  await page.getByRole('button', { name: '繼續，重新驗證密碼', exact: true }).click();
  const password = page.getByLabel('目前的密碼', { exact: true });
  await expect(password).toBeFocused();
  await password.pressSequentially(DEMO_PASSWORD);
  await page.keyboard.press('Enter');
  await expect(page.getByText(`已提出移交給${recipientName}。對方接受前，擁有權不會改變。`)).toBeVisible();
  const follow = posted.slice(before).filter(item => /\/tenants\/[^/]+\/ownership-transfers$/.test(item.path));
  expect(follow).toHaveLength(1);
  expect(follow[0].method).toBe('POST');
  expect(follow[0].key).toMatch(/^[A-Za-z0-9_-]{8,128}$/);
  expect(follow[0].ifMatch).toBeUndefined();
  const body = JSON.parse(follow[0].body ?? '{}') as { to_principal_id?: string; fresh_auth_verification_id?: string; reason?: string; from_role_after?: string };
  expect(body.to_principal_id).toMatch(/^[0-9a-f-]{36}$/);
  expect(body.fresh_auth_verification_id).toMatch(/^[0-9a-f-]{36}$/);
  expect(body.reason).toBe('交給下一位擁有者');
  expect(body.from_role_after).toBe('admin');
}

async function openProposeDialog(page: Page, recipientName: string) {
  await navigate(page, '業務空間');
  await page.getByLabel('業務空間名稱', { exact: true }).fill('品牌甲');
  await page.getByLabel('工作區名稱（可略過）', { exact: true }).fill('櫃檯甲');
  await page.getByRole('button', { name: '建立業務空間', exact: true }).click();
  await expect(page.getByText('我的角色：擁有者', { exact: true })).toBeVisible();
  await page.getByLabel('搜尋接收者', { exact: true }).fill(recipientName);
  await page.getByRole('button', { name: '搜尋接收者', exact: true }).click();
  await page.getByRole('button', { name: `選擇${recipientName}為接收者`, exact: true }).click();
  await page.getByLabel('移交原因', { exact: true }).fill('交給下一位擁有者');
  await page.getByRole('button', { name: '檢視移交內容', exact: true }).click();
  await page.getByRole('button', { name: '繼續，重新驗證密碼', exact: true }).click();
  await expect(page.getByLabel('目前的密碼', { exact: true })).toBeFocused();
}

async function heldDismiss(gesture: 'escape' | 'cancel', browser: Browser, baseURL: string, db: import('pg').Pool) {
  const run = randomUUID().slice(0, 8);
  const people = await seed(db, run);
  const [owner, recipient] = people;
  const ownerSession = await open(browser, baseURL, owner, { width: gesture === 'escape' ? 1440 : 390, height: gesture === 'escape' ? 900 : 844 });
  const posted = recordPosts(ownerSession.page);
  try {
    await openProposeDialog(ownerSession.page, recipient.display_name);
    await dismissHeldVerification(ownerSession.page, posted, gesture);
    await confirmPropose(ownerSession.page, posted, recipient.display_name);
    await noOverflow(ownerSession.page);
  } finally {
    await ownerSession.context.close();
    await cleanup(db, people);
  }
}

test('Escape during a held password check does not send the captured transfer', async ({ browser, baseURL, e2eAuthPool }) => {
  test.setTimeout(180_000);
  await heldDismiss('escape', browser, baseURL!, e2eAuthPool);
});

test('Cancel during a held password check does not send the captured transfer', async ({ browser, baseURL, e2eAuthPool }) => {
  test.setTimeout(180_000);
  await heldDismiss('cancel', browser, baseURL!, e2eAuthPool);
});

test('an owner proposes a transfer and the named recipient accepts it', async ({ browser, baseURL, e2eAuthPool }) => {
  test.setTimeout(120_000);
  const run = randomUUID().slice(0, 8);
  const people = await seed(e2eAuthPool, run);
  const [owner, recipient] = people;
  const ownerSession = await open(browser, baseURL!, owner, { width: 1440, height: 900 });
  const recipientSession = await open(browser, baseURL!, recipient, { width: 390, height: 844 });
  try {
    await navigate(ownerSession.page, '業務空間');
    await ownerSession.page.getByLabel('業務空間名稱', { exact: true }).fill('品牌甲');
    await ownerSession.page.getByLabel('工作區名稱（可略過）', { exact: true }).fill('櫃檯甲');
    await ownerSession.page.getByRole('button', { name: '建立業務空間', exact: true }).click();
    await expect(ownerSession.page.getByText('我的角色：擁有者', { exact: true })).toBeVisible();
    const searchRatio = await widthAgainstForm(ownerSession.page, '搜尋接收者');
    await ownerSession.page.getByLabel('搜尋接收者', { exact: true }).fill(recipient.display_name);
    await ownerSession.page.getByRole('button', { name: '搜尋接收者', exact: true }).click();
    await ownerSession.page.getByRole('button', { name: `選擇${recipient.display_name}為接收者`, exact: true }).click();
    await ownerSession.page.getByLabel('移交原因', { exact: true }).fill('交給下一位擁有者');
    await ownerSession.page.getByRole('button', { name: '檢視移交內容', exact: true }).click();
    await expect(ownerSession.page.getByText('對方接受前，擁有權不會改變。')).toBeVisible();
    const confirm = ownerSession.page.getByRole('button', { name: '繼續，重新驗證密碼', exact: true });
    await confirm.click();
    const password = ownerSession.page.getByLabel('目前的密碼', { exact: true });
    await expect(password).toBeFocused();
    await ownerSession.page.keyboard.press('Escape');
    await expect(ownerSession.page.getByRole('heading', { name: '重新驗證', exact: true })).toBeHidden();
    await expect(confirm).toBeFocused();
    await confirm.click();
    await expect(password).toBeFocused();
    await password.pressSequentially(DEMO_PASSWORD);
    await ownerSession.page.keyboard.press('Enter');
    await expect(ownerSession.page.getByText(`已提出移交給${recipient.display_name}。對方接受前，擁有權不會改變。`)).toBeVisible();
    await expect(ownerSession.page.getByRole('button', { name: '取消移交', exact: true })).toBeVisible();
    const cancelRatio = await widthAgainstForm(ownerSession.page, '取消移交');
    expect(Math.max(searchRatio, cancelRatio)).toBeLessThan(0.5);
    await ownerSession.page.evaluate(() => sessionStorage.clear());
    await ownerSession.page.reload();
    await navigate(ownerSession.page, '業務空間');
    await expect(ownerSession.page.getByText(`已提議將擁有權移交給${recipient.display_name}`)).toBeVisible();
    await expect(ownerSession.page.getByRole('button', { name: '取消移交', exact: true })).toBeVisible();
    await ownerSession.page.screenshot({ path: 'test-results/tenant-ownership-1440.png', fullPage: true });

    await navigate(recipientSession.page, '業務空間');
    await expect(recipientSession.page.getByRole('button', { name: '接受品牌甲的擁有權移交', exact: true })).toBeVisible();
    await noOverflow(recipientSession.page);
    await recipientSession.page.screenshot({ path: 'test-results/tenant-ownership-390.png', fullPage: true });
    await recipientSession.page.getByRole('button', { name: '接受品牌甲的擁有權移交', exact: true }).click();
    const recipientPassword = recipientSession.page.getByLabel('目前的密碼', { exact: true });
    await expect(recipientPassword).toBeFocused();
    await recipientPassword.pressSequentially(DEMO_PASSWORD);
    await recipientSession.page.keyboard.press('Enter');
    await expect(recipientSession.page.getByText('已接受品牌甲的擁有權。')).toBeVisible();
    await expect(recipientSession.page.getByText('我的角色：擁有者', { exact: true })).toBeVisible();
    await noOverflow(recipientSession.page);

    await ownerSession.page.reload();
    await navigate(ownerSession.page, '業務空間');
    await expect(ownerSession.page.getByText('我的角色：管理員', { exact: true })).toBeVisible();
  } finally {
    await ownerSession.context.close();
    await recipientSession.context.close();
    await cleanup(e2eAuthPool, people);
  }
});

async function transferEvidence(db: import('pg').Pool, displayName: string) {
  const transfers = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM tenant_ownership_transfers tr
    JOIN tenants t ON t.tenant_id=tr.tenant_id WHERE t.display_name=$1`, [displayName]);
  const audit = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM tenant_authority_audit a
    JOIN tenants t ON t.tenant_id=a.tenant_id WHERE t.display_name=$1 AND a.action='tenant.ownership.propose'`, [displayName]);
  const receipts = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM scoped_command_receipts r
    JOIN resource_scopes s ON s.scope_id=r.scope_id JOIN tenants t ON t.tenant_id=s.tenant_ref
    WHERE t.display_name=$1 AND r.operation='tenant.ownership.propose'`, [displayName]);
  return { transfers: transfers.rows[0].n, audit: audit.rows[0].n, receipts: receipts.rows[0].n };
}

test('a lost transfer acknowledgement is resent with the original key and body', async ({ browser, baseURL, e2eAuthPool }) => {
  test.setTimeout(180_000);
  const run = randomUUID().slice(0, 8);
  const tenantName = `品牌失${run}`;
  const people = await seed(e2eAuthPool, run);
  const [owner, recipient] = people;
  const session = await open(browser, baseURL!, owner, { width: 1440, height: 900 });
  const page = session.page;
  const posts: { key: string; body: string; method: string }[] = [];
  await page.route(url => /\/api\/v1\/tenants\/[^/]+\/ownership-transfers$/.test(url.pathname), async route => {
    if (route.request().method() !== 'POST') {
      await route.continue();
      return;
    }
    posts.push({
      method: route.request().method(),
      key: route.request().headers()['idempotency-key'] ?? '',
      body: route.request().postData() ?? '',
    });
    if (posts.length === 1) {
      await route.fetch();
      await route.abort('failed').catch(() => undefined);
      return;
    }
    await route.continue().catch(() => undefined);
  });
  try {
    await navigate(page, '業務空間');
    await page.getByLabel('業務空間名稱', { exact: true }).fill(tenantName);
    await page.getByLabel('工作區名稱（可略過）', { exact: true }).fill(`櫃檯${run}`);
    await page.getByRole('button', { name: '建立業務空間', exact: true }).click();
    await expect(page.getByText('我的角色：擁有者', { exact: true })).toBeVisible();
    await page.getByLabel('搜尋接收者', { exact: true }).fill(recipient.display_name);
    await page.getByRole('button', { name: '搜尋接收者', exact: true }).click();
    await page.getByRole('button', { name: `選擇${recipient.display_name}為接收者`, exact: true }).click();
    await page.getByLabel('移交原因', { exact: true }).fill('交給下一位擁有者');
    await page.getByRole('button', { name: '檢視移交內容', exact: true }).click();
    await page.getByRole('button', { name: '繼續，重新驗證密碼', exact: true }).click();
    const password = page.getByLabel('目前的密碼', { exact: true });
    await expect(password).toBeFocused();
    await password.pressSequentially(DEMO_PASSWORD);
    await page.keyboard.press('Enter');
    await expect(page.getByRole('alert')).toHaveText('正在確認是否已儲存');
    await expect.poll(() => posts.length).toBe(1);
    await page.getByRole('button', { name: '繼續，重新驗證密碼', exact: true }).click();
    await expect(password).toBeFocused();
    await password.pressSequentially(DEMO_PASSWORD);
    await page.keyboard.press('Enter');
    await expect.poll(() => posts.length).toBeGreaterThanOrEqual(2);
    expect(new Set(posts.map(item => item.key)).size, JSON.stringify(posts)).toBe(1);
    expect(new Set(posts.map(item => item.body)).size, JSON.stringify(posts)).toBe(1);
    expect(posts.every(item => item.method === 'POST')).toBe(true);
    await expect(page.getByText(`已提議將擁有權移交給${recipient.display_name}`)).toBeVisible();
    await expect.poll(async () => transferEvidence(e2eAuthPool, tenantName)).toEqual({ transfers: 1, audit: 1, receipts: 1 });
  } finally {
    await session.context.close();
    await cleanup(e2eAuthPool, people);
  }
});
