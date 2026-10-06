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
