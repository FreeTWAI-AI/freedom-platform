import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { e2eOrigin } from '../../packages/testing/e2e-origin.js';
import { navigate } from './navigation.js';
import { test, expect, type Page } from './fixtures.js';

type Member = { id: string; email: string; nickname: string };
// Each case gets its own legacy (onboarding_required=false) members in this run's
// schema, so no other spec's squads, contacts or owner limits can leak in.
async function member(pool: Pool, label: string): Promise<Member> {
  const id = randomUUID(), email = `squad-invite-${id}@local.test`, nickname = `${label}${id.slice(0, 8)}`;
  await pool.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref,onboarding_required)
    SELECT $1,community_id,$2,$3,password_hash,$4,false FROM users WHERE email='maker@local.test'`, [id, email, nickname, randomUUID()]);
  return { id, email, nickname };
}
async function login(page: Page, email: string) {
  await page.goto('/');
  await page.getByLabel('電子郵件', { exact: true }).fill(email);
  await page.getByLabel('密碼', { exact: true }).fill('freedom-local-demo');
  await page.getByRole('button', { name: '登入', exact: true }).click();
  await expect(page.getByRole('button', { name: '登出', exact: true })).toBeVisible();
}
async function logout(page: Page) {
  await page.getByRole('button', { name: '登出', exact: true }).click();
  await expect(page.getByLabel('電子郵件', { exact: true })).toBeVisible();
}
async function command(page: Page, path: string, data: unknown, ifMatch?: number) {
  const session = await (await page.request.get('/api/v1/session')).json();
  const response = await page.request.post(`/api/v1${path}`, {
    headers: { Origin: e2eOrigin(), 'X-CSRF-Token': session.csrf_token, 'Idempotency-Key': randomUUID(), ...(ifMatch ? { 'If-Match': `"${ifMatch}"` } : {}) },
    data,
  });
  expect(response.ok(), `Create isolated test fixture: ${path}`).toBe(true);
  return response.json();
}
const get = async (page: Page, path: string) => (await page.request.get(`/api/v1${path}`)).json();
async function shareLineWithSquad(page: Page, value: string) {
  const account = await get(page, '/me/account');
  const contacts = Object.fromEntries(Object.entries(account.contacts as Record<string, { value: string; audiences: string[] }>).map(([key, field]) => [key, key === 'email' ? { audiences: field.audiences } : { value: field.value, audiences: field.audiences }]));
  await command(page, '/me/account', { nickname: account.nickname, contacts: { ...contacts, line: { value, audiences: ['squad'] } } }, account.aggregate_version);
}
const notifications = async (pool: Pool, recipient: string) => (await pool.query(
  'SELECT kind,source_key,title,body,action_tab,action_resource_id FROM member_notifications WHERE recipient_ref=$1 ORDER BY created_at,source_key', [recipient])).rows;
const membership = async (pool: Pool, squadId: string, userId: string) => (await pool.query(
  'SELECT state FROM member_squad_memberships WHERE squad_id=$1 AND user_id=$2', [squadId, userId])).rows[0]?.state;
async function openSquad(page: Page, name: string) {
  await navigate(page, '小隊集合');
  await page.getByLabel('搜尋小隊', { exact: true }).fill(name);
  await page.getByRole('button', { name: `查看小隊：${name}`, exact: true }).click();
  const detail = page.getByRole('region', { name: '小隊詳情' });
  await expect(detail.getByRole('heading', { name: `${name}的夥伴`, exact: true })).toBeFocused();
  return detail;
}
async function invite(page: Page, detail: ReturnType<Page['getByRole']>, nickname: string) {
  await detail.getByLabel('搜尋要邀請的夥伴', { exact: true }).fill(nickname);
  await detail.getByRole('button', { name: '搜尋夥伴', exact: true }).click();
  await detail.getByRole('button', { name: `邀請 ${nickname}`, exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: `已邀請 ${nickname}，等候對方回覆。` })).toBeVisible();
  await expect(detail.getByRole('heading', { name: '送出的邀請', exact: true })).toBeFocused();
}
async function phoneLayoutFits(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const heights = await page.locator('.squad-invitations .btn:visible, .squad-invite-manager .btn:visible').evaluateAll(buttons => buttons.map(button => button.getBoundingClientRect().height));
  expect(heights.length).toBeGreaterThan(0);
  for (const height of heights) expect(height).toBeGreaterThanOrEqual(44);
}

test('owner invites from the member search; squad-only contacts appear only after the recipient accepts', async ({ page, e2eAuthPool }) => {
  const [owner, recipient, third] = [await member(e2eAuthPool, '隊主'), await member(e2eAuthPool, '受邀者'), await member(e2eAuthPool, '旁觀者')];
  const name = `邀請小隊 ${owner.id.slice(0, 8)}`;
  await login(page, owner.email);
  await shareLineWithSquad(page, 'synthetic-squad-line');
  const squad = await command(page, '/squads', { name, kind: 'project', purpose: '合成邀請流程。' });
  const detail = await openSquad(page, name);
  await expect(detail.getByText('還沒有送出邀請。')).toBeVisible();
  await invite(page, detail, recipient.nickname);
  await expect(detail.locator('.squad-invitation').filter({ hasText: '待回覆' })).toContainText(recipient.nickname);
  await expect(detail.locator('.squad-invitation').filter({ hasText: '已邀請，等候回覆' })).toContainText(recipient.nickname);
  await page.screenshot({ path: 'test-results/squad-invitations-owner-desktop.png' });
  const [sent] = await notifications(e2eAuthPool, recipient.id);
  expect(sent).toMatchObject({ kind: 'squad_invitation', title: `${owner.nickname}邀請你加入小隊「${name}」`, body: '前往小隊集合，接受或婉拒邀請。', action_tab: 'squads', action_resource_id: squad.squad_id });
  expect(await membership(e2eAuthPool, squad.squad_id, recipient.id)).toBeUndefined();
  await logout(page);

  await login(page, recipient.email);
  expect((await get(page, `/members/${owner.id}`)).contacts.line).toBeUndefined();
  await navigate(page, '小隊集合');
  const received = page.getByRole('region', { name: '收到的小隊邀請' });
  await expect(received.locator('.squad-invitation').filter({ hasText: name })).toContainText('待回覆');
  expect((await get(page, `/squads/${squad.squad_id}`)).members.map((row: { user_id: string }) => row.user_id)).toEqual([owner.id]);
  await received.getByRole('button', { name: `接受邀請：${name}`, exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: `已加入「${name}」。` })).toBeVisible();
  await expect(received.getByRole('heading', { name: '收到的小隊邀請', exact: true })).toBeFocused();
  await expect(received.getByText('目前沒有待回覆的小隊邀請。')).toBeVisible();
  await received.getByLabel('顯示已回覆', { exact: true }).check();
  await expect(received.locator('.squad-invitation').filter({ hasText: name })).toContainText('已接受');
  await page.getByLabel('搜尋小隊', { exact: true }).fill(name);
  await expect(page.locator('.expedition-squad').filter({ hasText: name })).toContainText('已加入');
  expect(await membership(e2eAuthPool, squad.squad_id, recipient.id)).toBe('active');
  expect((await get(page, `/members/${owner.id}`)).contacts.line).toBe('synthetic-squad-line');
  expect((await notifications(e2eAuthPool, owner.id)).map(row => row.title)).toEqual([`${recipient.nickname}接受了小隊「${name}」的邀請`]);
  await logout(page);

  // A member outside the squad still sees neither the contact nor the invitation.
  await login(page, third.email);
  expect((await get(page, `/members/${owner.id}`)).contacts.line).toBeUndefined();
  expect((await get(page, '/me/squad-invitations?state=all')).items).toEqual([]);
  expect(await notifications(e2eAuthPool, third.id)).toEqual([]);
});

test('phone layout: owner withdraws one invitation and the recipient declines another', async ({ page, e2eAuthPool }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const [owner, decliner, withdrawnFrom] = [await member(e2eAuthPool, '手機隊主'), await member(e2eAuthPool, '婉拒者'), await member(e2eAuthPool, '被撤回')];
  const name = `手機邀請 ${owner.id.slice(0, 8)}`;
  await login(page, owner.email);
  const squad = await command(page, '/squads', { name, kind: 'mutual_help', purpose: '手機回覆流程。' });
  const detail = await openSquad(page, name);
  await invite(page, detail, decliner.nickname);
  await invite(page, detail, withdrawnFrom.nickname);
  await phoneLayoutFits(page);
  await detail.getByRole('button', { name: `撤回給 ${withdrawnFrom.nickname} 的邀請`, exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: `已撤回給 ${withdrawnFrom.nickname} 的邀請。` })).toBeVisible();
  await expect(detail.locator('.squad-invitation').filter({ hasText: '已撤回' })).toContainText(withdrawnFrom.nickname);
  await page.screenshot({ path: 'test-results/squad-invitations-owner-phone.png', fullPage: true });
  expect((await notifications(e2eAuthPool, withdrawnFrom.id)).map(row => row.title)).toEqual([`${owner.nickname}邀請你加入小隊「${name}」`, `${owner.nickname}撤回了小隊「${name}」的邀請`]);
  await logout(page);

  await login(page, withdrawnFrom.email);
  expect((await get(page, '/me/squad-invitations?state=all')).items.map((item: { state: string }) => item.state)).toEqual(['withdrawn']);
  await navigate(page, '小隊集合');
  await expect(page.getByRole('region', { name: '收到的小隊邀請' }).getByText('目前沒有待回覆的小隊邀請。')).toBeVisible();
  await expect(page.getByRole('button', { name: `接受邀請：${name}`, exact: true })).toHaveCount(0);
  await logout(page);

  await login(page, decliner.email);
  await navigate(page, '小隊集合');
  const received = page.getByRole('region', { name: '收到的小隊邀請' });
  await expect(received.locator('.squad-invitation').filter({ hasText: name })).toContainText('待回覆');
  await phoneLayoutFits(page);
  await page.screenshot({ path: 'test-results/squad-invitations-recipient-phone.png', fullPage: true });
  await received.getByRole('button', { name: `婉拒邀請：${name}`, exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: `已婉拒「${name}」的邀請。` })).toBeVisible();
  await received.getByLabel('顯示已回覆', { exact: true }).check();
  await expect(received.locator('.squad-invitation').filter({ hasText: name })).toContainText('已婉拒');
  expect((await get(page, `/squads/${squad.squad_id}`)).members.map((row: { user_id: string }) => row.user_id)).toEqual([owner.id]);
  expect(await membership(e2eAuthPool, squad.squad_id, decliner.id)).toBeUndefined();
  expect((await notifications(e2eAuthPool, owner.id)).map(row => row.title)).toEqual([`${decliner.nickname}婉拒了小隊「${name}」的邀請`]);
});

test('an invitation withdrawn in another session shows the error and never lets the old pending version join', async ({ page, browser, e2eAuthPool }) => {
  const [owner, recipient] = [await member(e2eAuthPool, '撤回隊主'), await member(e2eAuthPool, '舊畫面')];
  const name = `舊版邀請 ${owner.id.slice(0, 8)}`;
  const ownerContext = await browser.newContext({ baseURL: e2eOrigin() });
  try {
    const ownerPage = await ownerContext.newPage();
    await login(ownerPage, owner.email);
    await shareLineWithSquad(ownerPage, 'stale-squad-line');
    const squad = await command(ownerPage, '/squads', { name, kind: 'project', purpose: '舊畫面回覆。' });
    const ownerDetail = await openSquad(ownerPage, name);
    await invite(ownerPage, ownerDetail, recipient.nickname);

    await login(page, recipient.email);
    await navigate(page, '小隊集合');
    const received = page.getByRole('region', { name: '收到的小隊邀請' });
    const accept = received.getByRole('button', { name: `接受邀請：${name}`, exact: true });
    await expect(accept).toBeVisible();

    await ownerDetail.getByRole('button', { name: `撤回給 ${recipient.nickname} 的邀請`, exact: true }).click();
    await expect(ownerPage.getByRole('status').filter({ hasText: `已撤回給 ${recipient.nickname} 的邀請。` })).toBeVisible();

    // The recipient's page still shows the old pending row until they act on it.
    const answer = page.waitForResponse(response => response.url().includes('/api/v1/squad-invitations/') && response.request().method() === 'POST');
    await accept.click();
    // Withdraw bumped the version, so the old If-Match is rejected before the state check.
    expect((await answer).status()).toBe(412);
    await expect(page.getByRole('alert').filter({ hasText: '資料已更新，請重新整理後再操作。' })).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: `已加入「${name}」。` })).toHaveCount(0);
    // The real record replaces the stale row; no old version remains clickable.
    await expect(accept).toHaveCount(0);
    await expect(received.getByRole('button', { name: `婉拒邀請：${name}`, exact: true })).toHaveCount(0);
    await expect(received.getByText('目前沒有待回覆的小隊邀請。')).toBeVisible();
    await received.getByLabel('顯示已回覆', { exact: true }).check();
    await expect(received.locator('.squad-invitation').filter({ hasText: name })).toContainText('已撤回');
    await expect(page.getByRole('alert').filter({ hasText: '資料已更新，請重新整理後再操作。' })).toBeVisible();
    expect(await membership(e2eAuthPool, squad.squad_id, recipient.id)).toBeUndefined();
    expect((await get(page, `/members/${owner.id}`)).contacts.line).toBeUndefined();
    expect(await notifications(e2eAuthPool, owner.id)).toEqual([]);
    expect((await e2eAuthPool.query('SELECT state FROM member_squad_invitations WHERE squad_id=$1', [squad.squad_id])).rows).toEqual([{ state: 'withdrawn' }]);
  } finally {
    await ownerContext.close();
  }
});

test('owner sees a pending invitation to a now-inactive member anonymized and can withdraw it', async ({ page, e2eAuthPool }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const [owner, gone] = [await member(e2eAuthPool, '釋放隊主'), await member(e2eAuthPool, '已停用')];
  const name = `釋放名額 ${owner.id.slice(0, 8)}`;
  await login(page, owner.email);
  const squad = await command(page, '/squads', { name, kind: 'project', purpose: '撤回不可用會員的邀請。' });
  await command(page, `/squads/${squad.squad_id}/invitations`, { recipient_ref: gone.id });
  await e2eAuthPool.query('UPDATE users SET active=false WHERE user_id=$1', [gone.id]);
  const detail = await openSquad(page, name);
  const row = detail.locator('.squad-invitation').filter({ hasText: '目前不可用的會員' });
  await expect(row).toContainText('待回覆');
  await expect(detail).not.toContainText(gone.nickname);
  await phoneLayoutFits(page);
  await row.getByRole('button', { name: '撤回給 目前不可用的會員 的邀請', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '已撤回給 目前不可用的會員 的邀請。' })).toBeVisible();
  await expect(row).toContainText('已撤回');
  await expect(page.locator('body')).not.toContainText(gone.nickname);
  expect((await e2eAuthPool.query('SELECT state FROM member_squad_invitations WHERE squad_id=$1 AND recipient_ref=$2', [squad.squad_id, gone.id])).rows).toEqual([{ state: 'withdrawn' }]);
  expect(await membership(e2eAuthPool, squad.squad_id, gone.id)).toBeUndefined();
});

test('received invitations recover from a failed load, and an old squad detail cannot replace the newer selection', async ({ page, e2eAuthPool }) => {
  const owner = await member(e2eAuthPool, '載入隊主');
  const stamp = owner.id.slice(0, 8), first = `較早小隊 ${stamp}`, second = `較新小隊 ${stamp}`;
  await login(page, owner.email);
  const older = await command(page, '/squads', { name: first, kind: 'project', purpose: '慢回應。' });
  await command(page, '/squads', { name: second, kind: 'project', purpose: '新選擇。' });
  let failInvites = true;
  await page.route('**/api/v1/me/squad-invitations?*', route => failInvites ? route.abort() : route.continue());
  let release!: () => void, requested!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { requested = resolve; });
  await page.route(`**/api/v1/squads/${older.squad_id}`, async route => { requested(); await held; await route.continue(); });
  await navigate(page, '小隊集合');
  const received = page.getByRole('region', { name: '收到的小隊邀請' });
  await expect(received.getByRole('alert')).toBeVisible();
  failInvites = false;
  await received.getByRole('button', { name: '重新載入邀請', exact: true }).click();
  await expect(received.getByRole('alert')).toHaveCount(0);
  await expect(received.getByText('目前沒有待回覆的小隊邀請。')).toBeVisible();
  await page.getByLabel('搜尋小隊', { exact: true }).fill(stamp);
  await page.getByRole('button', { name: `查看小隊：${first}`, exact: true }).click();
  await started;
  await page.getByRole('button', { name: `查看小隊：${second}`, exact: true }).click();
  const detail = page.getByRole('region', { name: '小隊詳情' });
  await expect(detail.getByRole('heading', { name: `${second}的夥伴`, exact: true })).toBeVisible();
  const delivered = page.waitForResponse(response => response.url().endsWith(`/api/v1/squads/${older.squad_id}`));
  release();
  await delivered;
  await expect(detail.getByRole('heading', { name: `${second}的夥伴`, exact: true })).toBeVisible();
  await expect(detail.getByRole('heading', { name: `${first}的夥伴`, exact: true })).toHaveCount(0);
});
