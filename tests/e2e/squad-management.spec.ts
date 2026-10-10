import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { e2eOrigin } from '../../packages/testing/e2e-origin.js';
import { navigate, signOut } from './navigation.js';
import { test, expect, type Page } from './fixtures.js';

// #400 with isolated synthetic members in this run's schema.
type Member = { id: string; email: string; nickname: string };
async function member(pool: Pool, label: string): Promise<Member> {
  const id = randomUUID(), email = `squad-manage-${id}@local.test`, nickname = `${label}${id.slice(0, 8)}`;
  await pool.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref,onboarding_required)
    SELECT $1,community_id,$2,$3,password_hash,$4,false FROM users WHERE email='maker@local.test'`, [id, email, nickname, randomUUID()]);
  return { id, email, nickname };
}
async function login(page: Page, email: string) {
  await page.goto('/');
  await page.getByLabel('電子郵件', { exact: true }).fill(email);
  await page.getByLabel('密碼', { exact: true }).fill('freedom-local-demo');
  await page.getByRole('button', { name: '登入', exact: true }).click();
  await expect(page.getByRole('button', { name: '設定', exact: true })).toBeVisible();
}
async function command(page: Page, path: string, data: unknown) {
  const session = await (await page.request.get('/api/v1/session')).json();
  const response = await page.request.post(`/api/v1${path}`, { headers: { Origin: e2eOrigin(), 'X-CSRF-Token': session.csrf_token, 'Idempotency-Key': randomUUID() }, data });
  expect(response.ok(), `fixture ${path}`).toBe(true);
  return response.json();
}
async function openSquad(page: Page, name: string) {
  await navigate(page, '小隊集合');
  await page.getByLabel('搜尋小隊', { exact: true }).fill(name);
  await page.getByRole('button', { name: `查看小隊：${name}`, exact: true }).click();
  return page.getByRole('region', { name: '小隊詳情' });
}
const state = async (pool: Pool, squad: string, user: string) => (await pool.query('SELECT state FROM member_squad_memberships WHERE squad_id=$1 AND user_id=$2', [squad, user])).rows[0]?.state;

test('an owner accepts, declines, removes, renames, transfers and finally the new owner disbands through site dialogs', async ({ page, e2eAuthPool }) => {
  const [owner, a, b, c] = [await member(e2eAuthPool, '隊主'), await member(e2eAuthPool, '甲'), await member(e2eAuthPool, '乙'), await member(e2eAuthPool, '丙')];
  const name = `管理小隊 ${owner.id.slice(0, 8)}`;
  await login(page, owner.email);
  const squad = await command(page, '/squads', { name, kind: 'project', purpose: '合成管理流程' });
  for (const person of [a, b, c]) { await signOut(page); await login(page, person.email); await command(page, `/squads/${squad.squad_id}/request`, {}); }
  await signOut(page); await login(page, owner.email);

  let detail = await openSquad(page, name);
  const row = (person: Member) => detail.locator('.member-request', { hasText: person.nickname });
  await row(a).getByRole('button', { name: '接受加入', exact: true }).click();
  await expect(row(a)).toContainText('已加入');
  await row(b).getByRole('button', { name: '婉拒', exact: true }).click();
  await expect(row(b)).toHaveCount(0);
  await row(c).getByRole('button', { name: '接受加入', exact: true }).click();
  await expect(row(c)).toContainText('已加入');

  // Remove through the dialog; Esc first returns focus.
  const remove = row(c).getByRole('button', { name: '移除', exact: true });
  await remove.click();
  const dialog = page.getByRole('dialog', { name: `移除 ${c.nickname}？` });
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape'); await expect(dialog).toBeHidden(); await expect(remove).toBeFocused();
  await remove.click(); await dialog.getByRole('button', { name: '確定移除', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: `已將 ${c.nickname} 移出小隊。` })).toBeVisible();
  expect(await state(e2eAuthPool, squad.squad_id, c.id)).toBe('left');
  expect((await e2eAuthPool.query("SELECT count(*)::int AS n FROM member_notifications WHERE recipient_ref=$1 AND kind='squad_member_removed'", [c.id])).rows[0].n).toBe(1);

  // Rename.
  await detail.locator('.squad-manage > summary').click();
  const renamed = `${name} 改`;
  await detail.getByLabel('小隊名稱', { exact: true }).fill(renamed);
  await detail.getByRole('button', { name: '儲存名稱與目標', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '小隊名稱與目標已更新。' })).toBeVisible();
  await expect(detail.getByRole('heading', { name: `${renamed}的夥伴`, exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await detail.screenshot({ path: 'test-results/squad-owner-tools-390.png' });
  await page.setViewportSize({ width: 1280, height: 900 });

  // Transfer to 甲.
  if (!(await detail.locator('.squad-manage').evaluate(element => (element as HTMLDetailsElement).open))) await detail.locator('.squad-manage > summary').click();
  await detail.getByRole('combobox', { name: '轉移隊主給' }).selectOption(a.id);
  await detail.getByRole('button', { name: '轉移隊主', exact: true }).click();
  const transfer = page.getByRole('dialog', { name: `把小隊交給 ${a.nickname}？` });
  await transfer.getByRole('button', { name: '確定轉移', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: `小隊已交給 ${a.nickname}。` })).toBeVisible();
  await expect(detail.locator('.squad-manage')).toHaveCount(0);
  await expect(detail.getByRole('button', { name: '退出這支小隊', exact: true })).toBeVisible();

  // The new owner disbands.
  await signOut(page); await login(page, a.email);
  detail = await openSquad(page, renamed);
  await detail.locator('.squad-manage > summary').click();
  await detail.getByRole('button', { name: '解散小隊', exact: true }).click();
  const disband = page.getByRole('dialog', { name: '解散這支小隊？' });
  await expect(disband).toContainText('無法復原');
  await page.screenshot({ path: 'test-results/squad-disband-dialog.png' });
  await disband.getByRole('button', { name: '確定解散', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: `小隊「${renamed}」已解散。` })).toBeVisible();
  await expect(page.getByRole('region', { name: '小隊詳情' })).toHaveCount(0);
  await page.getByLabel('搜尋小隊', { exact: true }).fill(renamed);
  await expect(page.getByRole('button', { name: `查看小隊：${renamed}`, exact: true })).toHaveCount(0);
  expect((await e2eAuthPool.query("SELECT count(*)::int AS n FROM member_squad_memberships WHERE squad_id=$1 AND state<>'left'", [squad.squad_id])).rows[0].n).toBe(0);
});
