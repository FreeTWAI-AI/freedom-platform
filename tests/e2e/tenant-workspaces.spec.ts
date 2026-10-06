import { randomUUID } from 'node:crypto';
import type { Browser, Page } from '@playwright/test';
import { test, expect } from './fixtures.js';
import { navigate } from './navigation.js';
import { DEMO_COMMUNITY, DEMO_PASSWORD } from '../../packages/testing/seed.js';
import { hashPassword } from '../../modules/identity-membership/service.js';

type Person = { user_id: string; email: string; display_name: string };

async function seed(db: import('pg').Pool, run: string): Promise<[Person, Person]> {
  const people: [Person, Person] = [
    { user_id: randomUUID(), email: `tenant-owner-${run}@example.test`, display_name: `品牌主人${run}` },
    { user_id: randomUUID(), email: `tenant-guest-${run}@example.test`, display_name: `受邀夥伴${run}` },
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
async function tallEnough(page: Page) {
  const heights = await page.locator('.tenant-workspace button:visible, .tenant-workspace input:visible, .tenant-workspace select:visible').evaluateAll(elements => elements.map(element => element.getBoundingClientRect().height));
  expect(heights.length).toBeGreaterThan(0);
  expect(Math.min(...heights)).toBeGreaterThanOrEqual(44);
}

test('two members create, invite, accept and switch tenants without sharing the second workspace', async ({ browser, baseURL, e2eAuthPool }) => {
  test.setTimeout(120_000);
  const run = randomUUID().slice(0, 8);
  const people = await seed(e2eAuthPool, run);
  const [owner, guest] = people;
  const ownerSession = await open(browser, baseURL!, owner, { width: 1280, height: 900 });
  const guestSession = await open(browser, baseURL!, guest, { width: 1280, height: 900 });
  try {
    await navigate(ownerSession.page, '業務空間');
    await expect(ownerSession.page.getByRole('heading', { name: '業務空間', level: 1, exact: true })).toBeVisible();
    await ownerSession.page.getByLabel('業務空間名稱', { exact: true }).fill('品牌甲');
    await ownerSession.page.getByLabel('工作區名稱（可略過）', { exact: true }).fill('櫃檯甲');
    await ownerSession.page.getByRole('button', { name: '建立業務空間', exact: true }).click();
    await expect(ownerSession.page.getByText('品牌甲／櫃檯甲', { exact: true })).toBeVisible();
    await expect(ownerSession.page.getByText('我的角色：擁有者', { exact: true })).toBeVisible();
    await expect(ownerSession.page.getByText('你是唯一使用中的擁有者，目前不能離開這個業務空間。')).toBeVisible();
    await expect(ownerSession.page.getByRole('button', { name: '離開這個業務空間', exact: true })).toBeDisabled();
    for (const name of ['建立業務空間', '搜尋', '建立工作區'] as const) {
      const box = await ownerSession.page.getByRole('button', { name, exact: true }).boundingBox();
      expect(box, name).not.toBeNull();
      expect(box!.width).toBeLessThan(400);
    }
    await expect(ownerSession.page.getByRole('region', { name: '我的業務空間' }).locator('ul')).toHaveCSS('list-style-type', 'none');
    const workspace = await ownerSession.page.locator('.tenant-workspace').boundingBox();
    const rootFontSize = await ownerSession.page.evaluate(() => Number.parseFloat(getComputedStyle(document.documentElement).fontSize));
    expect(workspace).not.toBeNull();
    expect(workspace!.width).toBeLessThanOrEqual(52 * rootFontSize + 1);
    await ownerSession.page.getByLabel('搜尋夥伴', { exact: true }).fill(guest.display_name);
    await ownerSession.page.getByRole('button', { name: '搜尋', exact: true }).click();
    await ownerSession.page.getByRole('button', { name: `邀請${guest.display_name}為檢視者`, exact: true }).click();
    await expect(ownerSession.page.getByText(`已邀請${guest.display_name}。`, { exact: true })).toBeVisible();

    await navigate(guestSession.page, '業務空間');
    await guestSession.page.getByRole('button', { name: '接受品牌甲的邀請', exact: true }).click();
    await expect(guestSession.page.getByText('我的角色：檢視者', { exact: true })).toBeVisible();
    await expect(guestSession.page.getByText('品牌甲／櫃檯甲', { exact: true })).toBeVisible();
    await expect(guestSession.page.getByLabel('搜尋夥伴', { exact: true })).toHaveCount(0);

    await ownerSession.page.getByLabel('業務空間名稱', { exact: true }).fill('品牌乙');
    await ownerSession.page.getByLabel('工作區名稱（可略過）', { exact: true }).fill('櫃檯乙');
    await ownerSession.page.getByRole('button', { name: '建立業務空間', exact: true }).click();
    await expect(ownerSession.page.getByText('品牌乙／櫃檯乙', { exact: true })).toBeVisible();
    await expect(ownerSession.page.getByRole('region', { name: '成員' })).not.toContainText(guest.display_name);
    await ownerSession.page.getByRole('button', { name: '品牌甲・擁有者', exact: true }).click();
    await expect(ownerSession.page.getByText('品牌甲／櫃檯甲', { exact: true })).toBeVisible();
    await expect(ownerSession.page.getByRole('region', { name: '成員' })).toContainText(guest.display_name);
    const members = ownerSession.page.getByRole('region', { name: '成員' });
    const revoke = await members.getByRole('button', { name: '撤銷', exact: true }).boundingBox();
    const role = await members.getByLabel('角色', { exact: true }).boundingBox();
    expect(revoke).not.toBeNull();
    expect(role).not.toBeNull();
    expect(Math.abs((revoke!.y + revoke!.height) - (role!.y + role!.height))).toBeLessThanOrEqual(2);

    await ownerSession.page.setViewportSize({ width: 390, height: 844 });
    await expect(ownerSession.page.getByRole('heading', { name: '業務空間', level: 1, exact: true })).toBeVisible();
    await noOverflow(ownerSession.page);
    await tallEnough(ownerSession.page);
    await guestSession.page.setViewportSize({ width: 390, height: 844 });
    await noOverflow(guestSession.page);
    await tallEnough(guestSession.page);
    await ownerSession.page.setViewportSize({ width: 360, height: 800 });
    await expect(ownerSession.page.getByRole('heading', { name: '業務空間', level: 1, exact: true })).toBeVisible();
    await noOverflow(ownerSession.page);
    await tallEnough(ownerSession.page);
    await guestSession.page.setViewportSize({ width: 360, height: 800 });
    await noOverflow(guestSession.page);
    await tallEnough(guestSession.page);
  } finally {
    await ownerSession.context.close();
    await guestSession.context.close();
    await cleanup(e2eAuthPool, people);
  }
});

async function workspaceEvidence(db: import('pg').Pool, displayName: string) {
  const spaces = await db.query<{ name: string }>(`SELECT w.name FROM workspaces w JOIN tenants t ON t.tenant_id=w.tenant_id
    WHERE t.display_name=$1 AND w.is_default=false ORDER BY w.name`, [displayName]);
  const audit = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM tenant_authority_audit a
    JOIN tenants t ON t.tenant_id=a.tenant_id WHERE t.display_name=$1 AND a.action='tenant.workspace.create'`, [displayName]);
  const receipts = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM scoped_command_receipts r
    JOIN resource_scopes s ON s.scope_id=r.scope_id JOIN tenants t ON t.tenant_id=s.tenant_ref
    WHERE t.display_name=$1 AND r.operation='tenant.workspace.create'`, [displayName]);
  return { names: spaces.rows.map(row => row.name), audit: audit.rows[0].n, receipts: receipts.rows[0].n };
}

test('a cancelled edit stays on its tenant when the member switches before the result returns', async ({ browser, baseURL, e2eAuthPool }) => {
  test.setTimeout(120_000);
  const run = randomUUID().slice(0, 8);
  const nameA = `品牌甲${run}`;
  const nameB = `品牌乙${run}`;
  const people = await seed(e2eAuthPool, run);
  const [owner] = people;
  const session = await open(browser, baseURL!, owner, { width: 1280, height: 900 });
  const page = session.page;
  const edits: { pathname: string; method: string; key: string; body: string; phase: string }[] = [];
  let phase = 'setup';
  let releaseHold: () => void = () => undefined;
  const held = new Promise<void>(resolve => { releaseHold = resolve; });
  let heldOnce = false;
  await page.route(url => /\/api\/v1\/tenants\/[^/]+\/edit$/.test(url.pathname), async route => {
    const request = route.request();
    edits.push({
      pathname: new URL(request.url()).pathname, method: request.method(),
      key: request.headers()['idempotency-key'] ?? '', body: request.postData() ?? '', phase,
    });
    if (!heldOnce) {
      heldOnce = true;
      await held;
      await route.abort('failed').catch(() => undefined);
      return;
    }
    await route.continue();
  });
  try {
    await navigate(page, '業務空間');
    await page.getByLabel('業務空間名稱', { exact: true }).fill(nameA);
    await page.getByLabel('工作區名稱（可略過）', { exact: true }).fill(`櫃檯甲${run}`);
    await page.getByRole('button', { name: '建立業務空間', exact: true }).click();
    await expect(page.getByText(`${nameA}／櫃檯甲${run}`, { exact: true })).toBeVisible();
    await page.getByLabel('業務空間名稱', { exact: true }).fill(nameB);
    await page.getByLabel('工作區名稱（可略過）', { exact: true }).fill(`櫃檯乙${run}`);
    await page.getByRole('button', { name: '建立業務空間', exact: true }).click();
    await expect(page.getByText(`${nameB}／櫃檯乙${run}`, { exact: true })).toBeVisible();
    await page.getByRole('button', { name: `${nameA}・擁有者`, exact: true }).click();
    await expect(page.getByText(`${nameA}／櫃檯甲${run}`, { exact: true })).toBeVisible();
    phase = 'A';
    await page.getByLabel('顯示名稱', { exact: true }).fill(`${nameA}改`);
    await page.getByRole('button', { name: '儲存', exact: true }).click();
    await expect.poll(() => edits.length).toBe(1);
    phase = 'B';
    await page.getByRole('button', { name: `${nameB}・擁有者`, exact: true }).click();
    releaseHold();
    await expect(page.getByText(`${nameB}／櫃檯乙${run}`, { exact: true })).toBeVisible();
    const retries = page.getByRole('button', { name: '再確認一次', exact: true });
    const retryCount = await retries.count();
    for (let index = 0; index < retryCount; index += 1) await retries.nth(index).click();
    expect(edits.filter(item => item.phase === 'B')).toEqual([]);
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(page.getByLabel('顯示名稱', { exact: true })).toHaveValue(nameB);
    phase = 'A-return';
    await page.getByRole('button', { name: `${nameA}・擁有者`, exact: true }).click();
    await expect(page.getByText(`${nameA}／櫃檯甲${run}`, { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '再確認一次', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '再確認一次', exact: true }).click();
    await expect.poll(() => edits.filter(item => item.phase === 'A-return').length).toBe(1);
    const retried = edits.filter(item => item.phase === 'A-return');
    expect(retried).toHaveLength(1);
    expect(retried[0]).toMatchObject({ pathname: edits[0].pathname, method: 'POST', key: edits[0].key, body: edits[0].body });
    await expect(page.getByText(`${nameA}改／櫃檯甲${run}`, { exact: true })).toBeVisible();
  } finally {
    releaseHold();
    await session.context.close();
    await cleanup(e2eAuthPool, people);
  }
});

test('a lost workspace acknowledgement is resent with the original key and body', async ({ browser, baseURL, e2eAuthPool }) => {
  test.setTimeout(120_000);
  const run = randomUUID().slice(0, 8);
  const tenantName = `品牌櫃${run}`;
  const people = await seed(e2eAuthPool, run);
  const [owner] = people;
  const session = await open(browser, baseURL!, owner, { width: 1280, height: 900 });
  const page = session.page;
  const posts: { key: string; body: string; method: string; pathname: string }[] = [];
  let settle = false;
  const waiters: Array<() => void> = [];
  await page.route(url => /\/api\/v1\/tenants\/[^/]+\/workspaces$/.test(url.pathname), async route => {
    if (route.request().method() !== 'POST') {
      await route.continue();
      return;
    }
    posts.push({
      method: route.request().method(), pathname: new URL(route.request().url()).pathname,
      key: route.request().headers()['idempotency-key'] ?? '', body: route.request().postData() ?? '',
    });
    if (posts.length === 1) {
      await route.fetch();
      await route.abort('failed').catch(() => undefined);
      return;
    }
    if (!settle) await new Promise<void>(resolve => { waiters.push(resolve); });
    await route.continue().catch(() => undefined);
  });
  try {
    await navigate(page, '業務空間');
    await page.getByLabel('業務空間名稱', { exact: true }).fill(tenantName);
    await page.getByLabel('工作區名稱（可略過）', { exact: true }).fill(`預設${run}`);
    await page.getByRole('button', { name: '建立業務空間', exact: true }).click();
    await expect(page.getByText(`${tenantName}／預設${run}`, { exact: true })).toBeVisible();
    await page.getByLabel('新工作區名稱', { exact: true }).fill('加開一');
    await page.getByRole('button', { name: '建立工作區', exact: true }).click();
    await expect(page.getByRole('alert')).toHaveText('正在確認是否已儲存');
    await expect.poll(() => posts.length).toBe(1);
    await page.getByRole('button', { name: '建立工作區', exact: true }).click();
    await expect.poll(() => posts.length).toBeGreaterThanOrEqual(2);
    await page.getByRole('button', { name: '建立工作區', exact: true }).dblclick();
    await page.waitForTimeout(1000);
    expect(new Set(posts.map(item => item.key)).size, JSON.stringify(posts)).toBe(1);
    expect(new Set(posts.map(item => item.body)).size, JSON.stringify(posts)).toBe(1);
    expect(posts.every(item => item.method === 'POST' && item.body === JSON.stringify({ name: '加開一' }))).toBe(true);
    settle = true;
    for (const release of waiters) release();
    await expect(page.getByText('已建立工作區加開一。', { exact: true })).toBeVisible();
    await expect.poll(async () => workspaceEvidence(e2eAuthPool, tenantName)).toEqual({ names: ['加開一'], audit: 1, receipts: 1 });
    await page.getByLabel('新工作區名稱', { exact: true }).fill('加開二');
    await page.getByRole('button', { name: '建立工作區', exact: true }).click();
    await expect(page.getByText('已建立工作區加開二。', { exact: true })).toBeVisible();
    await expect.poll(async () => workspaceEvidence(e2eAuthPool, tenantName)).toEqual({ names: ['加開一', '加開二'], audit: 2, receipts: 2 });
  } finally {
    settle = true;
    for (const release of waiters) release();
    await session.context.close();
    await cleanup(e2eAuthPool, people);
  }
});
