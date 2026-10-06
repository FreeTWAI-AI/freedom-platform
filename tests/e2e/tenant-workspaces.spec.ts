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
