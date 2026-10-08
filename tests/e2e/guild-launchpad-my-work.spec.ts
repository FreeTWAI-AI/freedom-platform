import { createHash, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { test, expect, type Browser, type Dialog, type Page, type Route } from './fixtures.js';

import { DEMO_COMMUNITY, DEMO_PASSWORD } from '../../packages/testing/seed.js';
import { hashPassword } from '../../modules/identity-membership/service.js';

const ABC_SHA = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
const LEAVE = '有尚未儲存的內容，確定要離開嗎？';
const UPGRADE = '你是這個公會的實習成員：可以閱讀公會內容、在公會聊天室聊天。想發布或編輯，可以在聊天室跟會長打聲招呼，會長能把你設為正式成員。';

type GuildRow = { guild_key: string; name: string; category: string };
type Person = { userId: string; email: string };

async function guildsByCategory(db: Pool): Promise<GuildRow[]> {
  // positioning_guild_catalog has no active column; the category row does.
  const rows = await db.query<GuildRow>(`SELECT DISTINCT ON (c.category) g.guild_key, g.name, c.category::text AS category
    FROM positioning_guild_catalog g
    JOIN guild_catalog_categories c ON c.guild_key = g.guild_key
    WHERE c.category_review = 'approved' AND c.category IS NOT NULL AND c.active = true
    ORDER BY c.category, g.guild_key`);
  expect(rows.rows.map(row => row.category).sort()).toEqual(['external', 'internal', 'professional_industry']);
  return rows.rows;
}
async function otherGuild(db: Pool, keys: string[]) {
  const row = await db.query<{ guild_key: string; name: string }>(`SELECT guild_key, name FROM positioning_guild_catalog
    WHERE NOT (guild_key = ANY($1::text[])) ORDER BY guild_key LIMIT 1`, [keys]);
  return row.rows[0];
}
async function person(db: Pool, label: string, memberships: { guild_key: string; tier: 'full' | 'intern' }[], primary: string): Promise<Person> {
  const userId = randomUUID();
  const email = `my-work-${label}-${userId.slice(0, 8)}@example.invalid`;
  await db.query(`INSERT INTO users(user_id, community_id, email, display_name, password_hash, profession_membership_ref, onboarding_required)
    VALUES($1,$2,$3,$4,$5,$6,false)`, [userId, DEMO_COMMUNITY, email, `我的工作${label}`, hashPassword(DEMO_PASSWORD), randomUUID()]);
  for (const membership of memberships) {
    await db.query(`INSERT INTO positioning_profession_memberships(membership_id, community_id, user_id, guild_key, state, member_tier)
      VALUES($1,$2,$3,$4,'active',$5)`, [randomUUID(), DEMO_COMMUNITY, userId, membership.guild_key, membership.tier]);
  }
  await db.query(`INSERT INTO guild_member_preferences(community_id, user_id, primary_guild_key) VALUES($1,$2,$3)`, [DEMO_COMMUNITY, userId, primary]);
  return { userId, email };
}
async function cleanup(db: Pool, userId: string) {
  await db.query('DELETE FROM command_receipts WHERE user_id=$1', [userId]);
  await db.query('DELETE FROM outbox WHERE transition_id IN (SELECT transition_id FROM transition_journal WHERE actor_ref=$1)', [userId]);
  await db.query('DELETE FROM transition_journal WHERE actor_ref=$1', [userId]);
  await db.query('DELETE FROM guild_member_preferences WHERE community_id=$1 AND user_id=$2', [DEMO_COMMUNITY, userId]);
  await db.query('DELETE FROM positioning_profession_memberships WHERE community_id=$1 AND user_id=$2', [DEMO_COMMUNITY, userId]);
  await db.query('DELETE FROM sessions WHERE user_id=$1', [userId]);
  await db.query('DELETE FROM users WHERE user_id=$1', [userId]).catch(() => undefined);
}
async function login(browser: Browser, baseURL: string, email: string) {
  const context = await browser.newContext({ baseURL, viewport: { width: 1280, height: 900 } });
  const urls: string[] = [];
  await context.route(url => !['127.0.0.1', 'localhost'].includes(url.hostname), route => route.abort());
  const page = await context.newPage();
  page.on('request', request => urls.push(request.url()));
  await page.goto('/');
  await page.getByLabel('電子郵件', { exact: true }).fill(email);
  await page.getByLabel('密碼', { exact: true }).fill(DEMO_PASSWORD);
  await page.getByRole('button', { name: '登入', exact: true }).click();
  await expect(page.getByRole('button', { name: '設定', exact: true })).toBeVisible();
  return { context, page, urls };
}
async function relogin(page: Page, email: string) {
  const settings = page.getByRole('button', { name: '設定', exact: true });
  if (await settings.getAttribute('aria-expanded') !== 'true') await settings.click();
  await page.getByRole('menu', { name: '個人檔案' }).getByRole('menuitem', { name: '登出', exact: true }).click();
  // Leaving a guild hash stays on the public launchpad. Its login button opens the form.
  const heading = page.getByRole('heading', { name: '登入', exact: true });
  const enter = page.getByRole('button', { name: '會員登入', exact: true });
  await expect(heading.or(enter)).toBeVisible();
  if (!(await heading.isVisible())) await enter.click();
  await expect(heading).toBeVisible();
  await page.getByLabel('電子郵件', { exact: true }).fill(email);
  await page.getByLabel('密碼', { exact: true }).fill(DEMO_PASSWORD);
  await page.getByRole('button', { name: '登入', exact: true }).click();
  await expect(page.getByRole('button', { name: '設定', exact: true })).toBeVisible();
}
async function openGuild(page: Page, guildKey: string, name: string) {
  await page.evaluate(key => { window.location.hash = `guilds/${key}`; }, guildKey);
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
}
async function postJson(page: Page, path: string, data: unknown, status = 201) {
  const session = await page.request.get('/api/v1/session');
  expect(session.ok()).toBeTruthy();
  const csrf = ((await session.json()) as { csrf_token: string }).csrf_token;
  const response = await page.request.post(`/api/v1${path}`, { data, headers: { Origin: new URL(page.url()).origin, 'X-CSRF-Token': csrf, 'Idempotency-Key': randomUUID() } });
  const body = await response.json();
  expect(response.status(), JSON.stringify(body)).toBe(status);
  return body as Record<string, any>;
}
async function patchJson(page: Page, path: string, data: unknown, ifMatch: string, status = 200) {
  const session = await page.request.get('/api/v1/session');
  expect(session.ok()).toBeTruthy();
  const csrf = ((await session.json()) as { csrf_token: string }).csrf_token;
  const matchHeader = ifMatch.startsWith('"') ? ifMatch : `"${ifMatch}"`;
  const response = await page.request.patch(`/api/v1${path}`, { data, headers: { Origin: new URL(page.url()).origin, 'X-CSRF-Token': csrf, 'Idempotency-Key': randomUUID(), 'If-Match': matchHeader } });
  const body = await response.json();
  expect(response.status(), JSON.stringify(body)).toBe(status);
  return body as Record<string, any>;
}
async function chooseWorkspace(page: Page, tenantName: string, workspaceName: string) {
  const heading = page.getByRole('heading', { level: 3, name: `${tenantName}／${workspaceName}`, exact: true });
  if (await heading.count()) return;
  await page.getByRole('button', { name: workspaceName, exact: true }).click();
  await expect(heading).toBeVisible();
}
async function starterOf(page: Page, guildKey: string) {
  const response = await page.request.get(`/api/v1/guilds/${guildKey}/launchpad`);
  expect(response.ok()).toBeTruthy();
  const body = await response.json() as { config: { body: { starter: { title_label: string; objective_hint: string; note_hint: string } } } };
  return body.config.body.starter;
}
async function resultText(page: Page) {
  return (await page.locator('.my-work-result').allInnerTexts()).map(text => text.replace(/\s+/g, ' ').trim());
}
function assertLocal(urls: string[]) {
  for (const url of urls) {
    const parsed = new URL(url);
    expect(['127.0.0.1', 'localhost'], url).toContain(parsed.hostname);
    expect(parsed.pathname, url).not.toMatch(/\/(model|grant|execution|ai|private-ai)(\/|$)/i);
  }
}
async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}
async function assertMyWorkButtons(page: Page, width: number) {
  const measured = await page.locator('.my-work').evaluate(root => {
    const box = root.getBoundingClientRect().width;
    const buttons = [...root.querySelectorAll<HTMLElement>('.btn')].map(element => {
      const form = element.closest('form');
      return {
        label: (element.textContent ?? '').trim().slice(0, 24),
        width: element.getBoundingClientRect().width,
        formWidth: form ? form.getBoundingClientRect().width : 0,
        primary: element.classList.contains('my-work-primary'),
      };
    });
    return { box, buttons };
  });
  if (width === 1280) {
    for (const button of measured.buttons) expect(button.width, button.label).toBeLessThanOrEqual(measured.box * 0.6);
  }
  if (width === 360) {
    const inForm = measured.buttons.filter(button => button.formWidth > 0);
    const primaries = inForm.filter(button => button.primary);
    expect(primaries.length).toBeGreaterThan(0);
    for (const button of inForm) {
      if (button.width >= button.formWidth * 0.9) expect(button.primary, button.label).toBe(true);
    }
    for (const button of primaries) expect(button.width, button.label).toBeGreaterThanOrEqual(button.formWidth * 0.9);
  }
}
async function theme(page: Page, id: 'light' | 'dark' | 'versefolk') {
  await page.evaluate(value => {
    localStorage.setItem('freedom-theme', value);
    document.documentElement.dataset.theme = value;
    document.documentElement.dataset.experienceProfile = value;
    window.dispatchEvent(new Event('freedom-theme-changed'));
  }, id);
}

test('T-005 T-051 a full member saves a note and a file in each approved category without calling a model', async ({ browser, baseURL, e2eAuthPool }) => {
  test.setTimeout(600_000);
  const categories = await guildsByCategory(e2eAuthPool);
  const primary = await otherGuild(e2eAuthPool, categories.map(row => row.guild_key));
  const member = await person(e2eAuthPool, 't005', [...categories.map(row => ({ guild_key: row.guild_key, tier: 'full' as const })), { guild_key: primary.guild_key, tier: 'full' }], primary.guild_key);
  const session = await login(browser, baseURL!, member.email);
  const run = randomUUID().slice(0, 8);
  // One tenant per guild. A second workspace in the same tenant is asked to reuse the
  // instance the first workspace already bound (T-008), so it is not a first enable.
  const places: { guild: GuildRow; tenantName: string; workspaceName: string; tenantId: string }[] = [];
  for (const guild of categories) {
    const tenantName = `空間${guild.category}${run}`;
    const workspaceName = '主工作區';
    const made = await postJson(session.page, '/tenants', { display_name: tenantName, workspace_name: workspaceName });
    places.push({ guild, tenantName, workspaceName, tenantId: made.tenant.tenant_id as string });
  }
  try {
    for (const place of places) {
      const { guild, tenantName, workspaceName, tenantId } = place;
      const starter = await starterOf(session.page, guild.guild_key);
      const title = `類別工作${guild.category}${run}`;
      const objective = `完成${guild.category}這次工作`;
      const note = `過程紀錄${guild.category}${run}`;
      await openGuild(session.page, guild.guild_key, guild.name);
      const tenantButton = session.page.getByRole('button', { name: `${tenantName}・擁有者`, exact: true });
      await expect(tenantButton).toBeVisible();
      if ((await tenantButton.getAttribute('aria-current')) !== 'true') await tenantButton.click();
      await expect(session.page.getByRole('heading', { level: 3, name: `${tenantName}／${workspaceName}`, exact: true })).toBeVisible();
      await session.page.getByRole('button', { name: '啟用手動工作', exact: true }).click();
      await expect(session.page.getByText('繼續工作', { exact: true })).toBeVisible({ timeout: 20_000 });
      await expect(session.page.getByLabel(starter.title_label, { exact: true })).toBeVisible();
      await expect(session.page.getByLabel(starter.objective_hint, { exact: true })).toBeVisible();
      await session.page.getByLabel(starter.title_label, { exact: true }).fill(title);
      await session.page.getByLabel(starter.objective_hint, { exact: true }).fill(objective);
      await expect(session.page.locator('#my-work-progress')).toHaveValue('todo');
      await session.page.getByRole('button', { name: '建立', exact: true }).click();
      await expect(session.page.getByRole('button', { name: title, exact: true })).toBeVisible();
      await expect(session.page.getByLabel(starter.note_hint, { exact: true })).toBeVisible();
      const noteName = session.page.locator('#my-work-note-name');
      await expect(noteName).toHaveValue(/^筆記-\d{8}-\d{4}\.md$/);
      await session.page.getByLabel(starter.note_hint, { exact: true }).fill(note);
      await session.page.getByRole('button', { name: '儲存筆記', exact: true }).click();
      await expect(session.page.locator('.my-work-stage')).toContainText(/已儲存・第 \d+ 版・/, { timeout: 20_000 });
      await session.page.locator('#my-work-file').setInputFiles({ name: 'abc.txt', mimeType: 'text/plain', buffer: Buffer.from('abc') });
      await session.page.getByRole('button', { name: '儲存附件', exact: true }).click();
      await expect(session.page.locator('.my-work-stage')).toContainText(/已儲存・第 \d+ 版・/, { timeout: 20_000 });
      const before = await resultText(session.page);
      expect(before.some(row => row.includes('abc.txt') && row.includes('3 位元組') && row.includes(ABC_SHA.slice(0, 12)))).toBe(true);
      expect(before.some(row => row.includes('第 1 版') || row.includes('第 2 版'))).toBe(true);
      const link = session.page.locator('.my-work-result', { hasText: 'abc.txt' }).getByRole('link', { name: '下載', exact: true });
      const href = await link.getAttribute('href');
      expect(href).toMatch(new RegExp(`^/api/v1/tenants/${tenantId}/works/[^/]+/results/[^/]+/content$`));
      const downloaded = await session.page.request.get(href!);
      expect(downloaded.ok()).toBeTruthy();
      const bytes = await downloaded.body();
      expect(Buffer.from(bytes).equals(Buffer.from('abc'))).toBe(true);
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(ABC_SHA);
      await relogin(session.page, member.email);
      await openGuild(session.page, guild.guild_key, guild.name);
      await expect(session.page.getByRole('heading', { level: 3, name: `${tenantName}／${workspaceName}`, exact: true })).toBeVisible();
      await session.page.getByRole('button', { name: title, exact: true }).click();
      await expect(session.page.locator('.my-work-result')).toHaveCount(2);
      expect(await resultText(session.page)).toEqual(before);
      const again = await session.page.request.get(href!);
      expect(Buffer.from(await again.body()).equals(Buffer.from('abc'))).toBe(true);
    }
    assertLocal(session.urls);
  } finally {
    await session.context.close();
    await cleanup(e2eAuthPool, member.userId);
  }
});

test('T-008 continuing in another guild keeps the workspace list and a reused workspace stays empty', async ({ browser, baseURL, e2eAuthPool }) => {
  test.setTimeout(240_000);
  const categories = await guildsByCategory(e2eAuthPool);
  const [first, second] = categories;
  const primary = await otherGuild(e2eAuthPool, [first.guild_key, second.guild_key]);
  const member = await person(e2eAuthPool, 't008', [
    { guild_key: first.guild_key, tier: 'full' }, { guild_key: second.guild_key, tier: 'full' }, { guild_key: primary.guild_key, tier: 'full' },
  ], primary.guild_key);
  const session = await login(browser, baseURL!, member.email);
  const run = randomUUID().slice(0, 8);
  const tenantName = `沿用空間${run}`;
  const title = `沿用工作${run}`;
  try {
    const made = await postJson(session.page, '/tenants', { display_name: tenantName, workspace_name: '沿用甲' });
    const tenantId = made.tenant.tenant_id as string;
    const firstWorkspace = made.workspace.workspace_id as string;
    const secondWorkspace = (await postJson(session.page, `/tenants/${tenantId}/workspaces`, { name: '沿用乙' })).workspace_id as string;
    const starter = await starterOf(session.page, first.guild_key);
    await openGuild(session.page, first.guild_key, first.name);
    await chooseWorkspace(session.page, tenantName, '沿用甲');
    await session.page.getByRole('button', { name: '啟用手動工作', exact: true }).click();
    await expect(session.page.getByText('繼續工作', { exact: true })).toBeVisible();
    await session.page.getByLabel(starter.title_label, { exact: true }).fill(title);
    await session.page.getByLabel(starter.objective_hint, { exact: true }).fill('沿用同一個工作區');
    await session.page.getByRole('button', { name: '建立', exact: true }).click();
    await expect(session.page.getByRole('button', { name: title, exact: true })).toBeVisible();
    await openGuild(session.page, second.guild_key, second.name);
    await expect(session.page.getByRole('heading', { level: 3, name: `${tenantName}／沿用甲`, exact: true })).toBeVisible();
    await expect(session.page.getByText('繼續工作', { exact: true })).toBeVisible();
    await expect(session.page.getByRole('button', { name: '啟用手動工作', exact: true })).toHaveCount(0);
    await expect(session.page.getByRole('button', { name: title, exact: true })).toBeVisible();
    const firstList = await session.page.request.get(`/api/v1/tenants/${tenantId}/workspaces/${firstWorkspace}/works?limit=20`);
    expect((await firstList.json()).items).toHaveLength(1);
    await session.page.getByRole('button', { name: '沿用乙', exact: true }).click();
    await expect(session.page.getByRole('button', { name: '啟用手動工作', exact: true })).toBeVisible();
    await session.page.getByRole('button', { name: '啟用手動工作', exact: true }).click();
    const dialog = session.page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: '要沿用哪一個工作空間？' })).toBeVisible();
    await expect(dialog.getByText(/已綁定 \d+ 個工作區/)).toBeVisible();
    await dialog.getByRole('button', { name: '沿用這個工作空間', exact: true }).click();
    await expect(session.page.getByText('繼續工作', { exact: true })).toBeVisible();
    await expect(session.page.getByRole('button', { name: title, exact: true })).toHaveCount(0);
    await expect(session.page.getByText('這個工作區還沒有工作。', { exact: true })).toBeVisible();
    const secondList = await session.page.request.get(`/api/v1/tenants/${tenantId}/workspaces/${secondWorkspace}/works?limit=20`);
    const secondBody = await secondList.json() as { items: { title: string }[] };
    expect(secondBody.items).toHaveLength(0);
    expect(await session.page.locator('.my-work [aria-label="工作"] button').allInnerTexts()).toEqual(secondBody.items.map(item => item.title));
  } finally {
    await session.context.close();
    await cleanup(e2eAuthPool, member.userId);
  }
});

test('T-006 a non-member of the tenant sees none of its work and an unknown guild is not found', async ({ browser, baseURL, e2eAuthPool }) => {
  test.setTimeout(180_000);
  const [guild] = await guildsByCategory(e2eAuthPool);
  const primary = await otherGuild(e2eAuthPool, [guild.guild_key]);
  const owner = await person(e2eAuthPool, 't006a', [{ guild_key: guild.guild_key, tier: 'full' }, { guild_key: primary.guild_key, tier: 'full' }], primary.guild_key);
  const stranger = await person(e2eAuthPool, 't006b', [{ guild_key: guild.guild_key, tier: 'full' }, { guild_key: primary.guild_key, tier: 'full' }], primary.guild_key);
  const ownerSession = await login(browser, baseURL!, owner.email);
  const run = randomUUID().slice(0, 8);
  const tenantName = `隔離空間${run}`;
  const title = `隔離工作${run}`;
  try {
    const made = await postJson(ownerSession.page, '/tenants', { display_name: tenantName, workspace_name: '隔離區' });
    const starter = await starterOf(ownerSession.page, guild.guild_key);
    await openGuild(ownerSession.page, guild.guild_key, guild.name);
    await ownerSession.page.getByRole('button', { name: '啟用手動工作', exact: true }).click();
    await expect(ownerSession.page.getByText('繼續工作', { exact: true })).toBeVisible();
    await ownerSession.page.getByLabel(starter.title_label, { exact: true }).fill(title);
    await ownerSession.page.getByLabel(starter.objective_hint, { exact: true }).fill('只有這個業務空間看得到');
    await ownerSession.page.getByRole('button', { name: '建立', exact: true }).click();
    await expect(ownerSession.page.getByRole('button', { name: title, exact: true })).toBeVisible();
    await ownerSession.context.close();
    const other = await login(browser, baseURL!, stranger.email);
    try {
      await openGuild(other.page, guild.guild_key, guild.name);
      await expect(other.page.getByRole('link', { name: '前往業務空間', exact: true })).toBeVisible();
      const text = await other.page.locator('body').innerText();
      expect(text).not.toContain(tenantName);
      expect(text).not.toContain(title);
      await other.page.evaluate(() => { window.location.hash = 'guilds/guild_does_not_exist_zzzz'; });
      await expect(other.page.getByRole('heading', { level: 1, name: '找不到這個公會', exact: true })).toBeVisible();
      expect(await other.page.locator('body').innerText()).not.toContain(tenantName);
    } finally { await other.context.close(); }
  } finally {
    await cleanup(e2eAuthPool, owner.userId);
    await cleanup(e2eAuthPool, stranger.userId);
  }
});

test('T-055 keyboard, themes, narrow layout, unsaved leave, and a late workspace response', async ({ browser, baseURL, e2eAuthPool }, testInfo) => {
  test.setTimeout(300_000);
  // Button colors transition for 160ms. Reduced motion settles the theme before a color read.
  const [guild] = await guildsByCategory(e2eAuthPool);
  const primary = await otherGuild(e2eAuthPool, [guild.guild_key]);
  const member = await person(e2eAuthPool, 't055', [{ guild_key: guild.guild_key, tier: 'full' }, { guild_key: primary.guild_key, tier: 'full' }], primary.guild_key);
  const originalName = guild.name;
  const longName = `很長的公會名稱${'名稱'.repeat(30)}`;
  const session = await login(browser, baseURL!, member.email);
  await session.page.emulateMedia({ reducedMotion: 'reduce' });
  const run = randomUUID().slice(0, 8);
  const tenantName = `版面空間${run}`;
  const title = `鍵盤工作${run}`;
  try {
    const made = await postJson(session.page, '/tenants', { display_name: tenantName, workspace_name: '版面甲' });
    const workspaceA = made.workspace.workspace_id as string;
    await postJson(session.page, `/tenants/${made.tenant.tenant_id}/workspaces`, { name: '版面乙' });
    const starter = await starterOf(session.page, guild.guild_key);
    await openGuild(session.page, guild.guild_key, guild.name);
    await chooseWorkspace(session.page, tenantName, '版面甲');
    await session.page.getByRole('button', { name: '啟用手動工作', exact: true }).click();
    await expect(session.page.getByText('繼續工作', { exact: true })).toBeVisible();
    await session.page.locator('#my-work-title').focus();
    await session.page.keyboard.type(title);
    await session.page.keyboard.press('Tab');
    await expect(session.page.locator('#my-work-objective')).toBeFocused();
    await session.page.keyboard.type('用鍵盤寫下目標');
    await session.page.keyboard.press('Tab');
    await expect(session.page.locator('#my-work-progress')).toBeFocused();
    await expect(session.page.locator('#my-work-progress')).toHaveValue('todo');
    await session.page.keyboard.press('Tab');
    await expect(session.page.getByRole('button', { name: '建立', exact: true })).toBeFocused();
    await session.page.keyboard.press('Enter');
    await expect(session.page.getByRole('button', { name: title, exact: true })).toBeVisible();
    await expect(session.page.getByRole('heading', { level: 4, name: '新增工作', exact: true })).toBeVisible();
    await expect(session.page.getByRole('heading', { level: 4, name: title, exact: true })).toBeVisible();
    await session.page.locator('#my-work-note').focus();
    await session.page.keyboard.type(`鍵盤筆記${run}`);
    await session.page.keyboard.press('Tab');
    await expect(session.page.locator('#my-work-note-name')).toBeFocused();
    await session.page.keyboard.press('Tab');
    await expect(session.page.getByRole('button', { name: '儲存筆記', exact: true })).toBeFocused();
    await session.page.keyboard.press('Enter');
    await expect(session.page.locator('.my-work-stage')).toContainText(/已儲存・第 \d+ 版・/, { timeout: 20_000 });
    for (const id of ['light', 'dark', 'versefolk'] as const) {
      await theme(session.page, id);
      for (const [width, height] of [[1280, 900], [390, 844], [360, 780], [320, 640]] as const) {
        await session.page.setViewportSize({ width, height });
        await expect(session.page.getByRole('heading', { level: 1, name: guild.name })).toBeVisible();
        await noOverflow(session.page);
        await assertMyWorkButtons(session.page, width);
        await session.page.screenshot({ path: testInfo.outputPath(`t055-${id}-${width}.png`), fullPage: true });
      }
    }
    await theme(session.page, 'light');
    await session.page.setViewportSize({ width: 360, height: 780 });
    const primary = session.page.getByRole('button', { name: '建立', exact: true });
    const probe = await primary.evaluate(element => ({
      color: getComputedStyle(element).color,
      background: getComputedStyle(element).backgroundColor,
      theme: document.documentElement.dataset.theme ?? '',
      className: element.className,
    }));
    expect(probe.className).toContain('my-work-primary');
    expect(probe.theme).toBe('light');
    expect(probe.color, JSON.stringify(probe)).toBe('rgb(32, 48, 0)');
    expect(probe.background).not.toBe(probe.color);
    const inputSize = await session.page.locator('#my-work-title').evaluate(element => parseFloat(getComputedStyle(element).fontSize));
    expect(inputSize).toBeGreaterThanOrEqual(16);
    const target = await session.page.getByRole('button', { name: '儲存筆記', exact: true }).evaluate(element => element.getBoundingClientRect().height);
    expect(target).toBeGreaterThanOrEqual(44);
    await e2eAuthPool.query('UPDATE positioning_guild_catalog SET name=$2 WHERE guild_key=$1', [guild.guild_key, longName]);
    await session.page.reload();
    await expect(session.page.getByRole('heading', { level: 1, name: longName })).toBeVisible();
    await noOverflow(session.page);
    await session.page.screenshot({ path: testInfo.outputPath('t055-long-name-360.png'), fullPage: true });
    await e2eAuthPool.query('UPDATE positioning_guild_catalog SET name=$2 WHERE guild_key=$1', [guild.guild_key, originalName]);
    await session.page.setViewportSize({ width: 1280, height: 900 });
    await session.page.reload();
    await expect(session.page.getByRole('heading', { level: 1, name: originalName })).toBeVisible();
    await session.page.getByRole('button', { name: title, exact: true }).click();
    let release: () => void = () => undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let held = false;
    const matchA = (url: URL) => url.pathname.includes(`/workspaces/${workspaceA}/launchpad-context`);
    const holdA = async (route: import('@playwright/test').Route) => {
      if (route.request().method() !== 'GET' || held) return route.fallback();
      held = true;
      await gate;
      try {
        const response = await route.fetch();
        const json = await response.json();
        if (Array.isArray(json.work_page?.items) && json.work_page.items[0]) json.work_page.items[0].title = 'LATE_A_TITLE';
        await route.fulfill({ status: response.status(), contentType: 'application/json', json });
      } catch { /* Switching workspace aborts the held request. */ }
    };
    await session.page.route(matchA, holdA);
    await session.page.getByRole('button', { name: '版面乙', exact: true }).click();
    await expect(session.page.getByRole('heading', { level: 3, name: `${tenantName}／版面乙`, exact: true })).toBeVisible();
    await session.page.getByRole('button', { name: '版面甲', exact: true }).click({ noWaitAfter: true });
    await expect.poll(() => held).toBe(true);
    await session.page.getByRole('button', { name: '版面乙', exact: true }).click({ noWaitAfter: true });
    await expect(session.page.getByRole('heading', { level: 3, name: `${tenantName}／版面乙`, exact: true })).toBeVisible();
    release();
    await expect(session.page.getByText('LATE_A_TITLE')).toHaveCount(0);
    await expect(session.page.getByRole('button', { name: title, exact: true })).toHaveCount(0);
    await session.page.unroute(matchA, holdA);
    await session.page.getByRole('button', { name: '版面甲', exact: true }).click();
    await expect(session.page.getByRole('heading', { level: 3, name: `${tenantName}／版面甲`, exact: true })).toBeVisible({ timeout: 20_000 });
    await session.page.getByRole('button', { name: title, exact: true }).click();
    await session.page.locator('#my-work-note').fill('還沒按儲存');
    session.page.once('dialog', dialog => { expect(dialog.message()).toBe(LEAVE); void dialog.dismiss(); });
    await session.page.getByRole('button', { name: '返回公會列表', exact: true }).click();
    await expect(session.page.locator('#my-work-note')).toHaveValue('還沒按儲存');
    session.page.once('dialog', dialog => { expect(dialog.message()).toBe(LEAVE); void dialog.accept(); });
    await session.page.getByRole('button', { name: '返回公會列表', exact: true }).click();
    await expect(session.page.getByRole('heading', { level: 1, name: originalName })).toHaveCount(0);
    expect(starter.title_label.length).toBeGreaterThan(0);
  } finally {
    await e2eAuthPool.query('UPDATE positioning_guild_catalog SET name=$2 WHERE guild_key=$1', [guild.guild_key, originalName]);
    await session.context.close();
    await cleanup(e2eAuthPool, member.userId);
  }
});

test('T-057 retiring the capacity policy keeps saved results readable', async ({ browser, baseURL, e2eAuthPool }) => {
  test.setTimeout(180_000);
  const policy = await e2eAuthPool.query<{ policy_id: string }>(`SELECT policy_id FROM tenant_capacity_policies WHERE status='active' AND tenant_id IS NULL`);
  expect(policy.rows.length).toBeGreaterThan(0);
  const policyId = policy.rows[0].policy_id;
  const [guild] = await guildsByCategory(e2eAuthPool);
  const primary = await otherGuild(e2eAuthPool, [guild.guild_key]);
  const member = await person(e2eAuthPool, 't057', [{ guild_key: guild.guild_key, tier: 'full' }, { guild_key: primary.guild_key, tier: 'full' }], primary.guild_key);
  const session = await login(browser, baseURL!, member.email);
  const run = randomUUID().slice(0, 8);
  try {
    const made = await postJson(session.page, '/tenants', { display_name: `政策空間${run}`, workspace_name: '政策區' });
    const starter = await starterOf(session.page, guild.guild_key);
    await openGuild(session.page, guild.guild_key, guild.name);
    await session.page.getByRole('button', { name: '啟用手動工作', exact: true }).click();
    await expect(session.page.getByText('繼續工作', { exact: true })).toBeVisible();
    await session.page.getByLabel(starter.title_label, { exact: true }).fill(`政策工作${run}`);
    await session.page.getByLabel(starter.objective_hint, { exact: true }).fill('政策關閉後仍可讀');
    await session.page.getByRole('button', { name: '建立', exact: true }).click();
    await session.page.getByLabel(starter.note_hint, { exact: true }).fill(`政策筆記${run}`);
    await session.page.getByRole('button', { name: '儲存筆記', exact: true }).click();
    await expect(session.page.locator('.my-work-stage')).toContainText('已儲存', { timeout: 20_000 });
    await e2eAuthPool.query(`UPDATE tenant_capacity_policies SET status='retired' WHERE policy_id=$1`, [policyId]);
    await session.page.reload();
    await expect(session.page.getByText('保存功能尚未啟用', { exact: true })).toBeVisible();
    await session.page.getByRole('button', { name: `政策工作${run}`, exact: true }).click();
    await expect(session.page.locator('.my-work-result', { hasText: `筆記-` })).toBeVisible();
    await expect(session.page.locator('.my-work-result').getByRole('link', { name: '下載', exact: true })).toBeVisible();
    await expect(session.page.getByRole('button', { name: '儲存筆記', exact: true })).toBeDisabled();
    await expect(session.page.getByRole('button', { name: '建立', exact: true })).toBeDisabled();
  } finally {
    await e2eAuthPool.query(`UPDATE tenant_capacity_policies SET status='active' WHERE policy_id=$1`, [policyId]);
    await session.context.close();
    await cleanup(e2eAuthPool, member.userId);
  }
});

test('an intern sees the upgrade explanation and does not call tenant work', async ({ browser, baseURL, e2eAuthPool }) => {
  test.setTimeout(120_000);
  const [guild] = await guildsByCategory(e2eAuthPool);
  const primary = await otherGuild(e2eAuthPool, [guild.guild_key]);
  const member = await person(e2eAuthPool, 'intern', [{ guild_key: guild.guild_key, tier: 'intern' }, { guild_key: primary.guild_key, tier: 'full' }], primary.guild_key);
  const session = await login(browser, baseURL!, member.email);
  let tenantCall = false;
  await session.page.route(url => url.pathname.startsWith('/api/v1/tenants') || url.pathname.includes('manual-work'), route => { tenantCall = true; return route.abort(); });
  try {
    await openGuild(session.page, guild.guild_key, guild.name);
    await expect(session.page.getByText(UPGRADE, { exact: true })).toBeVisible();
    await expect(session.page.getByRole('button', { name: '啟用手動工作', exact: true })).toHaveCount(0);
    expect(tenantCall).toBe(false);
    expect(session.urls.some(url => url.includes('/api/v1/tenants') || url.includes('manual-work'))).toBe(false);
  } finally {
    await session.context.close();
    await cleanup(e2eAuthPool, member.userId);
  }
});

test('a lost finalize acknowledgement retries once and keeps a single result', async ({ browser, baseURL, e2eAuthPool }) => {
  test.setTimeout(180_000);
  const [guild] = await guildsByCategory(e2eAuthPool);
  const primary = await otherGuild(e2eAuthPool, [guild.guild_key]);
  const member = await person(e2eAuthPool, 'ack', [{ guild_key: guild.guild_key, tier: 'full' }, { guild_key: primary.guild_key, tier: 'full' }], primary.guild_key);
  const session = await login(browser, baseURL!, member.email);
  const run = randomUUID().slice(0, 8);
  const title = `重試工作${run}`;
  try {
    const made = await postJson(session.page, '/tenants', { display_name: `重試空間${run}`, workspace_name: '重試區' });
    const tenantId = made.tenant.tenant_id as string;
    const workspaceId = made.workspace.workspace_id as string;
    const starter = await starterOf(session.page, guild.guild_key);
    await openGuild(session.page, guild.guild_key, guild.name);
    await session.page.getByRole('button', { name: '啟用手動工作', exact: true }).click();
    await expect(session.page.getByText('繼續工作', { exact: true })).toBeVisible();
    await session.page.getByLabel(starter.title_label, { exact: true }).fill(title);
    await session.page.getByLabel(starter.objective_hint, { exact: true }).fill('確認重試不會重複保存');
    await session.page.getByRole('button', { name: '建立', exact: true }).click();
    await expect(session.page.getByRole('button', { name: title, exact: true })).toBeVisible();
    let dropped = false;
    await session.page.route(url => url.pathname.endsWith('/finalize'), async route => {
      if (dropped || route.request().method() !== 'POST') return route.fallback();
      dropped = true;
      await route.fetch();
      await route.abort();
    });
    const longNote = 'a'.repeat(20_000);
    await session.page.getByLabel(starter.note_hint, { exact: true }).fill(longNote);
    await session.page.getByRole('button', { name: '儲存筆記', exact: true }).click();
    await expect(session.page.getByText('尚未確認是否儲存，請按重試（不會重複保存）', { exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(session.page.locator('.my-work-stage')).not.toContainText('已儲存');
    await expect(session.page.getByText('筆記超過 262144 位元組。', { exact: true })).toHaveCount(0);
    await session.page.getByRole('button', { name: '重試', exact: true }).click();
    await expect(session.page.locator('.my-work-stage')).toContainText(/已儲存・第 1 版・/, { timeout: 20_000 });
    await expect(session.page.locator('.my-work-result')).toContainText(`${longNote.length} 位元組`);
    const works = await session.page.request.get(`/api/v1/tenants/${tenantId}/workspaces/${workspaceId}/works?limit=20`);
    const workId = ((await works.json()) as { items: { work_id: string; title: string }[] }).items.find(item => item.title === title)?.work_id;
    expect(workId).toBeTruthy();
    const results = await session.page.request.get(`/api/v1/tenants/${tenantId}/works/${workId}/results?limit=20`);
    const items = ((await results.json()) as { items: { revision: string; byte_size: number }[] }).items;
    expect(items).toHaveLength(1);
    expect(items[0].revision).toBe('1');
    expect(items[0].byte_size).toBe(longNote.length);
  } finally {
    await session.context.close();
    await cleanup(e2eAuthPool, member.userId);
  }
});

test('a 502 after a committed finalize keeps the save and retries once', async ({ browser, baseURL, e2eAuthPool }) => {
  test.setTimeout(180_000);
  const [guild] = await guildsByCategory(e2eAuthPool);
  const primary = await otherGuild(e2eAuthPool, [guild.guild_key]);
  const member = await person(e2eAuthPool, '502f', [{ guild_key: guild.guild_key, tier: 'full' }, { guild_key: primary.guild_key, tier: 'full' }], primary.guild_key);
  const session = await login(browser, baseURL!, member.email);
  const run = randomUUID().slice(0, 8);
  const title = `五零二工作${run}`;
  try {
    const made = await postJson(session.page, '/tenants', { display_name: `五零二空間${run}`, workspace_name: '五零二區' });
    const tenantId = made.tenant.tenant_id as string;
    const workspaceId = made.workspace.workspace_id as string;
    const starter = await starterOf(session.page, guild.guild_key);
    await openGuild(session.page, guild.guild_key, guild.name);
    await session.page.getByRole('button', { name: '啟用手動工作', exact: true }).click();
    await expect(session.page.getByText('繼續工作', { exact: true })).toBeVisible();
    await session.page.getByLabel(starter.title_label, { exact: true }).fill(title);
    await session.page.getByLabel(starter.objective_hint, { exact: true }).fill('確認 502 保留 attempt');
    await session.page.getByRole('button', { name: '建立', exact: true }).click();
    await expect(session.page.getByRole('button', { name: title, exact: true })).toBeVisible();

    let intercepted = false;
    await session.page.route(url => url.pathname.endsWith('/finalize'), async route => {
      if (intercepted || route.request().method() !== 'POST') return route.fallback();
      intercepted = true;
      await route.fetch();
      await route.fulfill({
        status: 502,
        contentType: 'application/problem+json',
        body: JSON.stringify({ type: 'about:blank', title: 'Bad Gateway', status: 502, code: 'upstream_error', detail: 'synthetic' }),
      });
    });

    const noteText = `重要筆記${run}`;
    await session.page.getByLabel(starter.note_hint, { exact: true }).fill(noteText);
    await session.page.getByRole('button', { name: '儲存筆記', exact: true }).click();

    await expect(session.page.getByText('尚未確認是否儲存，請按重試（不會重複保存）', { exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(session.page.getByRole('button', { name: '重試', exact: true })).toBeVisible();
    await expect(session.page.locator('#my-work-note')).toHaveValue(noteText);
    await expect(session.page.getByRole('heading', { level: 4, name: title, exact: true })).toBeVisible();
    await expect(session.page.getByText('這份工作已無法繼續保存。', { exact: false })).toHaveCount(0);

    await session.page.getByRole('button', { name: '重試', exact: true }).click();
    await expect(session.page.locator('.my-work-stage')).toContainText(/已儲存・第 1 版・/, { timeout: 20_000 });

    const works = await session.page.request.get(`/api/v1/tenants/${tenantId}/workspaces/${workspaceId}/works?limit=20`);
    const workId = ((await works.json()) as { items: { work_id: string; title: string }[] }).items.find(item => item.title === title)?.work_id;
    expect(workId).toBeTruthy();
    const results = await session.page.request.get(`/api/v1/tenants/${tenantId}/works/${workId}/results?limit=20`);
    const items = ((await results.json()) as { items: { revision: string }[] }).items;
    expect(items).toHaveLength(1);
    expect(items[0].revision).toBe('1');
  } finally {
    await session.context.close();
    await cleanup(e2eAuthPool, member.userId);
  }
});

test('a definitive work_archived on finalize keeps the note readable', async ({ browser, baseURL, e2eAuthPool }) => {
  test.setTimeout(180_000);
  const [guild] = await guildsByCategory(e2eAuthPool);
  const primary = await otherGuild(e2eAuthPool, [guild.guild_key]);
  const member = await person(e2eAuthPool, 'arch', [{ guild_key: guild.guild_key, tier: 'full' }, { guild_key: primary.guild_key, tier: 'full' }], primary.guild_key);
  const session = await login(browser, baseURL!, member.email);
  const run = randomUUID().slice(0, 8);
  const title = `封存工作${run}`;
  try {
    const made = await postJson(session.page, '/tenants', { display_name: `封存空間${run}`, workspace_name: '封存區' });
    const starter = await starterOf(session.page, guild.guild_key);
    await openGuild(session.page, guild.guild_key, guild.name);
    await session.page.getByRole('button', { name: '啟用手動工作', exact: true }).click();
    await expect(session.page.getByText('繼續工作', { exact: true })).toBeVisible();
    await session.page.getByLabel(starter.title_label, { exact: true }).fill(title);
    await session.page.getByLabel(starter.objective_hint, { exact: true }).fill('確認封存保留筆記');
    await session.page.getByRole('button', { name: '建立', exact: true }).click();
    await expect(session.page.getByRole('button', { name: title, exact: true })).toBeVisible();

    let intercepted = false;
    await session.page.route(url => url.pathname.endsWith('/finalize'), async route => {
      if (intercepted || route.request().method() !== 'POST') return route.fallback();
      intercepted = true;
      await route.fulfill({
        status: 409,
        contentType: 'application/problem+json',
        body: JSON.stringify({ type: 'about:blank', title: 'Conflict', status: 409, code: 'work_archived', detail: '這份工作已封存。' }),
      });
    });

    const noteText = `孤兒筆記${run}`;
    await session.page.getByLabel(starter.note_hint, { exact: true }).fill(noteText);
    await session.page.getByRole('button', { name: '儲存筆記', exact: true }).click();

    await expect(session.page.getByText('這份工作已無法繼續保存。筆記還在這個畫面。', { exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(session.page.locator('#my-work-orphan-note')).toHaveValue(noteText);
    await expect(session.page.getByRole('button', { name: '重試', exact: true })).toHaveCount(0);
    await expect(session.page.locator('.my-work-stage')).toHaveCount(0);
    await expect(session.page.locator('.my-work').getByText('已儲存', { exact: false })).toHaveCount(0);
  } finally {
    await session.context.close();
    await cleanup(e2eAuthPool, member.userId);
  }
});

test('a failed read after create does not make a second Work', async ({ browser, baseURL, e2eAuthPool }) => {
  test.setTimeout(180_000);
  const [guild] = await guildsByCategory(e2eAuthPool);
  const primary = await otherGuild(e2eAuthPool, [guild.guild_key]);
  const member = await person(e2eAuthPool, 'readfail', [{ guild_key: guild.guild_key, tier: 'full' }, { guild_key: primary.guild_key, tier: 'full' }], primary.guild_key);
  const session = await login(browser, baseURL!, member.email);
  const run = randomUUID().slice(0, 8);
  const title = `讀回失敗工作${run}`;
  try {
    const made = await postJson(session.page, '/tenants', { display_name: `讀回空間${run}`, workspace_name: '讀回區' });
    const tenantId = made.tenant.tenant_id as string;
    const workspaceId = made.workspace.workspace_id as string;
    const starter = await starterOf(session.page, guild.guild_key);
    await openGuild(session.page, guild.guild_key, guild.name);
    await session.page.getByRole('button', { name: '啟用手動工作', exact: true }).click();
    await expect(session.page.getByText('繼續工作', { exact: true })).toBeVisible();

    const workPathPattern = new RegExp(`^/api/v1/tenants/${tenantId}/works/[^/]+$`);
    let intercepted = false;
    await session.page.route(url => Boolean(url.pathname.match(workPathPattern)), async route => {
      if (intercepted || route.request().method() !== 'GET') return route.fallback();
      intercepted = true;
      await route.fulfill({
        status: 502,
        contentType: 'application/problem+json',
        body: JSON.stringify({ type: 'about:blank', title: 'Bad Gateway', status: 502, code: 'upstream_error', detail: 'synthetic' }),
      });
    });

    const CREATE_UNCONFIRMED = '工作已送出，但還沒確認。請再按一次「建立」繼續確認（不會重複建立）。';
    await session.page.getByLabel(starter.title_label, { exact: true }).fill(title);
    await session.page.getByLabel(starter.objective_hint, { exact: true }).fill('讀回失敗重試建立');
    await session.page.getByRole('button', { name: '建立', exact: true }).click();

    await expect(session.page.getByText(CREATE_UNCONFIRMED, { exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(session.page.locator('#my-work-title')).toHaveValue(title);

    await session.page.getByRole('button', { name: '建立', exact: true }).click();
    await expect(session.page.getByRole('button', { name: title, exact: true })).toBeVisible({ timeout: 20_000 });

    const works = await session.page.request.get(`/api/v1/tenants/${tenantId}/workspaces/${workspaceId}/works?limit=20`);
    const items = ((await works.json()) as { items: { work_id: string; title: string }[] }).items.filter(item => item.title === title);
    expect(items).toHaveLength(1);
  } finally {
    await session.context.close();
    await cleanup(e2eAuthPool, member.userId);
  }
});

test('a save started in one tenant does not continue after switching tenant', async ({ browser, baseURL, e2eAuthPool }) => {
  test.setTimeout(180_000);
  const [guild] = await guildsByCategory(e2eAuthPool);
  const primary = await otherGuild(e2eAuthPool, [guild.guild_key]);
  const member = await person(e2eAuthPool, 'tntscope', [{ guild_key: guild.guild_key, tier: 'full' }, { guild_key: primary.guild_key, tier: 'full' }], primary.guild_key);
  const session = await login(browser, baseURL!, member.email);
  const run = randomUUID().slice(0, 8);
  const tenantNameA = `空間甲${run}`;
  const tenantNameB = `空間乙${run}`;
  const titleA = `工作甲${run}`;
  try {
    await postJson(session.page, '/tenants', { display_name: tenantNameA, workspace_name: '預設工作區' });
    await postJson(session.page, '/tenants', { display_name: tenantNameB, workspace_name: '預設工作區' });
    const starter = await starterOf(session.page, guild.guild_key);
    await openGuild(session.page, guild.guild_key, guild.name);
    await session.page.getByRole('button', { name: `${tenantNameA}・擁有者`, exact: true }).click();
    await expect(session.page.getByRole('heading', { level: 3, name: `${tenantNameA}／預設工作區`, exact: true })).toBeVisible({ timeout: 20_000 });
    await session.page.getByRole('button', { name: '啟用手動工作', exact: true }).click();
    await expect(session.page.getByText('繼續工作', { exact: true })).toBeVisible();
    await session.page.getByLabel(starter.title_label, { exact: true }).fill(titleA);
    await session.page.getByLabel(starter.objective_hint, { exact: true }).fill('測試跨tenant儲存隔離');
    await session.page.getByRole('button', { name: '建立', exact: true }).click();
    await expect(session.page.getByRole('button', { name: titleA, exact: true })).toBeVisible();

    await session.page.locator('#my-work-note').fill('即將跨空間儲存的筆記');

    await session.page.evaluate(() => {
      const original = crypto.subtle.digest.bind(crypto.subtle);
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      (window as any).__releaseDigest = () => release();
      (crypto.subtle as any).digest = async (...args: [AlgorithmIdentifier, BufferSource]) => { await gate; return original(...args); };
    });

    let uploadRequestsCount = 0;
    session.page.on('request', request => {
      if (new URL(request.url()).pathname.endsWith('/results/uploads')) {
        uploadRequestsCount++;
      }
    });

    await session.page.getByRole('button', { name: '儲存筆記', exact: true }).click();

    session.page.once('dialog', dialog => {
      expect(dialog.message()).toBe(LEAVE);
      void dialog.accept();
    });
    await session.page.getByRole('button', { name: `${tenantNameB}・擁有者`, exact: true }).click();
    await expect(session.page.getByRole('heading', { level: 3, name: `${tenantNameB}／預設工作區`, exact: true })).toBeVisible({ timeout: 20_000 });

    await session.page.evaluate(() => {
      (window as any).__releaseDigest();
    });
    await session.page.waitForTimeout(1000);

    expect(uploadRequestsCount).toBe(0);
    await expect(session.page.getByRole('button', { name: titleA, exact: true })).toHaveCount(0);
    await expect(session.page.locator('.my-work').getByText('已儲存', { exact: false })).toHaveCount(0);
  } finally {
    await session.context.close();
    await cleanup(e2eAuthPool, member.userId);
  }
});

test('a concurrent edit is not overwritten by stale fields after a save conflict', async ({ browser, baseURL, e2eAuthPool }) => {
  test.setTimeout(180_000);
  const [guild] = await guildsByCategory(e2eAuthPool);
  const primary = await otherGuild(e2eAuthPool, [guild.guild_key]);
  const member = await person(e2eAuthPool, 'editconflict', [{ guild_key: guild.guild_key, tier: 'full' }, { guild_key: primary.guild_key, tier: 'full' }], primary.guild_key);
  const session = await login(browser, baseURL!, member.email);
  const run = randomUUID().slice(0, 8);
  const tenantName = `空間${run}`;
  const title = `初始工作${run}`;
  const otherTitle = `其他編輯者標題${run}`;
  try {
    const made = await postJson(session.page, '/tenants', { display_name: tenantName, workspace_name: '預設工作區' });
    const tenantId = made.tenant.tenant_id as string;
    const workspaceId = made.workspace.workspace_id as string;
    const starter = await starterOf(session.page, guild.guild_key);
    await openGuild(session.page, guild.guild_key, guild.name);
    await session.page.getByRole('button', { name: '啟用手動工作', exact: true }).click();
    await expect(session.page.getByText('繼續工作', { exact: true })).toBeVisible();

    await session.page.getByLabel(starter.title_label, { exact: true }).fill(title);
    await session.page.getByLabel(starter.objective_hint, { exact: true }).fill('初始目標');
    await session.page.getByRole('button', { name: '建立', exact: true }).click();
    await expect(session.page.getByRole('button', { name: title, exact: true })).toBeVisible();

    const listRes = await session.page.request.get(`/api/v1/tenants/${tenantId}/workspaces/${workspaceId}/works?limit=20`);
    const list = await listRes.json();
    const workItem = list.items.find((item: any) => item.title === title);
    expect(workItem).toBeDefined();
    const workId = workItem.work_id;
    const v1 = workItem.version;

    await session.page.locator('#my-work-edit-objective').fill('我的未保存修改');

    await patchJson(session.page, `/tenants/${tenantId}/works/${workId}`, { title: otherTitle, objective: '初始目標', progress: 'todo' }, v1);

    await session.page.locator('#my-work-note').fill('衝突觸發筆記');
    await session.page.getByRole('button', { name: '儲存筆記', exact: true }).click();
    await expect(session.page.getByRole('button', { name: '用最新版本再儲存一次', exact: true })).toBeVisible({ timeout: 20_000 });

    await session.page.getByRole('button', { name: '儲存變更', exact: true }).click();
    await expect(session.page.locator('.my-work-conflict').getByText('這份工作剛剛被更新。', { exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(session.page.getByText(`伺服器的標題：${otherTitle}`, { exact: true })).toBeVisible();

    const checkRes = await session.page.request.get(`/api/v1/tenants/${tenantId}/works/${workId}`);
    const checkWork = await checkRes.json();
    expect(checkWork.title).toBe(otherTitle);
  } finally {
    await session.context.close();
    await cleanup(e2eAuthPool, member.userId);
  }
});

test('a clean edit form follows the newer version after a save conflict', async ({ browser, baseURL, e2eAuthPool }) => {
  test.setTimeout(180_000);
  const [guild] = await guildsByCategory(e2eAuthPool);
  const primary = await otherGuild(e2eAuthPool, [guild.guild_key]);
  const member = await person(e2eAuthPool, 'editclean', [{ guild_key: guild.guild_key, tier: 'full' }, { guild_key: primary.guild_key, tier: 'full' }], primary.guild_key);
  const session = await login(browser, baseURL!, member.email);
  const run = randomUUID().slice(0, 8);
  const tenantName = `空間${run}`;
  const title = `初始工作${run}`;
  const otherTitle = `其他編輯者標題${run}`;
  try {
    const made = await postJson(session.page, '/tenants', { display_name: tenantName, workspace_name: '預設工作區' });
    const tenantId = made.tenant.tenant_id as string;
    const workspaceId = made.workspace.workspace_id as string;
    const starter = await starterOf(session.page, guild.guild_key);
    await openGuild(session.page, guild.guild_key, guild.name);
    await session.page.getByRole('button', { name: '啟用手動工作', exact: true }).click();
    await expect(session.page.getByText('繼續工作', { exact: true })).toBeVisible();

    await session.page.getByLabel(starter.title_label, { exact: true }).fill(title);
    await session.page.getByLabel(starter.objective_hint, { exact: true }).fill('初始目標');
    await session.page.getByRole('button', { name: '建立', exact: true }).click();
    await expect(session.page.getByRole('button', { name: title, exact: true })).toBeVisible();

    const listRes = await session.page.request.get(`/api/v1/tenants/${tenantId}/workspaces/${workspaceId}/works?limit=20`);
    const list = await listRes.json();
    const workItem = list.items.find((item: any) => item.title === title);
    expect(workItem).toBeDefined();
    const workId = workItem.work_id;
    const v1 = workItem.version;

    await patchJson(session.page, `/tenants/${tenantId}/works/${workId}`, { title: otherTitle, objective: '初始目標', progress: 'todo' }, v1);

    await session.page.locator('#my-work-note').fill('衝突觸發筆記');
    await session.page.getByRole('button', { name: '儲存筆記', exact: true }).click();
    await expect(session.page.getByRole('button', { name: '用最新版本再儲存一次', exact: true })).toBeVisible({ timeout: 20_000 });

    await expect(session.page.locator('#my-work-edit-title')).toHaveValue(otherTitle);
  } finally {
    await session.context.close();
    await cleanup(e2eAuthPool, member.userId);
  }
});

test('create and edit drafts ask before leaving and do not follow into another tenant', async ({ browser, baseURL, e2eAuthPool }) => {
  test.setTimeout(180_000);
  const [guild] = await guildsByCategory(e2eAuthPool);
  const primary = await otherGuild(e2eAuthPool, [guild.guild_key]);
  const member = await person(e2eAuthPool, 'draftguard', [{ guild_key: guild.guild_key, tier: 'full' }, { guild_key: primary.guild_key, tier: 'full' }], primary.guild_key);
  const session = await login(browser, baseURL!, member.email);
  const run = randomUUID().slice(0, 8);
  const tenantNameA = `空間甲${run}`;
  const tenantNameB = `空間乙${run}`;
  const draftTitle = `機密新標題${run}`;
  const draftObjective = `機密新目標${run}`;
  const workTitle1 = `工作壹${run}`;
  const workTitle2 = `工作貳${run}`;
  try {
    await postJson(session.page, '/tenants', { display_name: tenantNameA, workspace_name: '預設工作區' });
    await postJson(session.page, '/tenants', { display_name: tenantNameB, workspace_name: '預設工作區' });
    const starter = await starterOf(session.page, guild.guild_key);
    await openGuild(session.page, guild.guild_key, guild.name);

    await session.page.getByRole('button', { name: `${tenantNameB}・擁有者`, exact: true }).click();
    await session.page.getByRole('button', { name: '啟用手動工作', exact: true }).click();
    await expect(session.page.getByText('繼續工作', { exact: true })).toBeVisible();

    await session.page.getByRole('button', { name: `${tenantNameA}・擁有者`, exact: true }).click();
    await session.page.getByRole('button', { name: '啟用手動工作', exact: true }).click();
    await expect(session.page.getByText('繼續工作', { exact: true })).toBeVisible();

    await session.page.locator('#my-work-title').fill(draftTitle);
    await session.page.locator('#my-work-objective').fill(draftObjective);

    session.page.once('dialog', dialog => {
      expect(dialog.message()).toBe(LEAVE);
      void dialog.dismiss();
    });
    await session.page.getByRole('button', { name: `${tenantNameB}・擁有者`, exact: true }).click();
    await expect(session.page.getByRole('heading', { level: 3, name: `${tenantNameA}／預設工作區`, exact: true })).toBeVisible();
    await expect(session.page.locator('#my-work-title')).toHaveValue(draftTitle);
    await expect(session.page.locator('#my-work-objective')).toHaveValue(draftObjective);

    session.page.once('dialog', dialog => {
      expect(dialog.message()).toBe(LEAVE);
      void dialog.accept();
    });
    await session.page.getByRole('button', { name: `${tenantNameB}・擁有者`, exact: true }).click();
    await expect(session.page.getByRole('heading', { level: 3, name: `${tenantNameB}／預設工作區`, exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(session.page.locator('#my-work-title')).toHaveValue('');
    await expect(session.page.locator('#my-work-objective')).toHaveValue('');

    await session.page.getByRole('button', { name: `${tenantNameA}・擁有者`, exact: true }).click();
    await expect(session.page.getByRole('heading', { level: 3, name: `${tenantNameA}／預設工作區`, exact: true })).toBeVisible({ timeout: 20_000 });

    await session.page.getByLabel(starter.title_label, { exact: true }).fill(workTitle1);
    await session.page.getByLabel(starter.objective_hint, { exact: true }).fill('目標一');
    await session.page.getByRole('button', { name: '建立', exact: true }).click();
    await expect(session.page.getByRole('button', { name: workTitle1, exact: true })).toBeVisible();

    await session.page.getByLabel(starter.title_label, { exact: true }).fill(workTitle2);
    await session.page.getByLabel(starter.objective_hint, { exact: true }).fill('目標二');
    await session.page.getByRole('button', { name: '建立', exact: true }).click();
    await expect(session.page.getByRole('button', { name: workTitle2, exact: true })).toBeVisible();

    await session.page.getByRole('button', { name: workTitle1, exact: true }).click();
    await expect(session.page.locator('#my-work-edit-title')).toHaveValue(workTitle1);
    const editedObjective = '未保存的目標編輯';
    await session.page.locator('#my-work-edit-objective').fill(editedObjective);

    session.page.once('dialog', dialog => {
      expect(dialog.message()).toBe(LEAVE);
      void dialog.dismiss();
    });
    await session.page.getByRole('button', { name: workTitle2, exact: true }).click();
    await expect(session.page.locator('#my-work-edit-objective')).toHaveValue(editedObjective);
  } finally {
    await session.context.close();
    await cleanup(e2eAuthPool, member.userId);
  }
});

test('a failed open of another Work closes the open Work instead of leaving a dead edit form', async ({ browser, baseURL, e2eAuthPool }) => {
  test.setTimeout(180_000);
  const [guild] = await guildsByCategory(e2eAuthPool);
  const primary = await otherGuild(e2eAuthPool, [guild.guild_key]);
  const member = await person(e2eAuthPool, 'failedopen', [{ guild_key: guild.guild_key, tier: 'full' }, { guild_key: primary.guild_key, tier: 'full' }], primary.guild_key);
  const session = await login(browser, baseURL!, member.email);
  const run = randomUUID().slice(0, 8);
  const tenantName = `空間${run}`;
  const title1 = `工作一${run}`;
  const title2 = `工作二${run}`;
  try {
    const made = await postJson(session.page, '/tenants', { display_name: tenantName, workspace_name: '預設工作區' });
    const tenantId = made.tenant.tenant_id as string;
    const workspaceId = made.workspace.workspace_id as string;
    const starter = await starterOf(session.page, guild.guild_key);
    await openGuild(session.page, guild.guild_key, guild.name);
    await session.page.getByRole('button', { name: '啟用手動工作', exact: true }).click();
    await expect(session.page.getByText('繼續工作', { exact: true })).toBeVisible();

    await session.page.getByLabel(starter.title_label, { exact: true }).fill(title1);
    await session.page.getByLabel(starter.objective_hint, { exact: true }).fill('目標一');
    await session.page.getByRole('button', { name: '建立', exact: true }).click();
    await expect(session.page.getByRole('button', { name: title1, exact: true })).toBeVisible();

    await session.page.getByLabel(starter.title_label, { exact: true }).fill(title2);
    await session.page.getByLabel(starter.objective_hint, { exact: true }).fill('目標二');
    await session.page.getByRole('button', { name: '建立', exact: true }).click();
    await expect(session.page.getByRole('button', { name: title2, exact: true })).toBeVisible();

    const listRes = await session.page.request.get(`/api/v1/tenants/${tenantId}/workspaces/${workspaceId}/works?limit=20`);
    const list = await listRes.json();
    const work1Item = list.items.find((item: any) => item.title === title1);
    const work2Item = list.items.find((item: any) => item.title === title2);
    expect(work1Item).toBeDefined();
    expect(work2Item).toBeDefined();
    const work1Id = work1Item.work_id;
    const work2Id = work2Item.work_id;

    await session.page.getByRole('button', { name: title1, exact: true }).click();
    await expect(session.page.locator('#my-work-edit-title')).toHaveValue(title1);
    await session.page.locator('#my-work-edit-objective').fill('失敗前的未保存修改');

    const failWork2 = (url: URL) => url.pathname === `/api/v1/tenants/${tenantId}/works/${work2Id}`
      || url.pathname.startsWith(`/api/v1/tenants/${tenantId}/works/${work2Id}/`);
    let failedReads = 0;
    const abortWork2 = (route: Route) => { failedReads += 1; return route.abort('failed'); };
    await session.page.route(failWork2, abortWork2);

    let patches = 0;
    session.page.on('request', request => { if (request.method() === 'PATCH') patches += 1; });

    session.page.once('dialog', dialog => {
      expect(dialog.message()).toBe(LEAVE);
      void dialog.accept();
    });
    await session.page.getByRole('button', { name: title2, exact: true }).click();

    await expect.poll(() => failedReads).toBeGreaterThan(0);
    await expect(session.page.locator('#my-work-edit-title')).toHaveCount(0);
    await expect(session.page.getByRole('button', { name: '儲存變更', exact: true })).toHaveCount(0);

    await session.page.unroute(failWork2, abortWork2);
    const recordedDialogs: string[] = [];
    const recordDialog = (dialog: Dialog) => {
      recordedDialogs.push(dialog.message());
      void dialog.dismiss();
    };
    session.page.on('dialog', recordDialog);
    await session.page.getByRole('button', { name: title1, exact: true }).click();
    await expect(session.page.locator('#my-work-edit-title')).toHaveValue(title1);
    await expect(session.page.locator('#my-work-edit-objective')).toHaveValue('目標一');
    session.page.off('dialog', recordDialog);
    expect(recordedDialogs).toHaveLength(0);

    await session.page.locator('#my-work-edit-objective').fill('重新開啟後的修改');
    const patched = session.page.waitForResponse(response => response.request().method() === 'PATCH' && response.url().includes(work1Id));
    await session.page.getByRole('button', { name: '儲存變更', exact: true }).click();
    expect((await patched).status()).toBe(200);

    expect(patches).toBe(1);
    const finalRes = await session.page.request.get(`/api/v1/tenants/${tenantId}/works/${work1Id}`);
    const finalWork = await finalRes.json();
    expect(finalWork.objective).toBe('重新開啟後的修改');
  } finally {
    await session.context.close();
    await cleanup(e2eAuthPool, member.userId);
  }
});

for (const lifecycle of ['archive', 'suspend'] as const) {
  test(`a workspace whose bound instance is ${lifecycle === 'archive' ? 'archived' : 'suspended'} keeps paginated Work and Results readable in light and RPG`, async ({ browser, baseURL, e2eAuthPool }, testInfo) => {
    test.setTimeout(180_000);
    const [guild] = await guildsByCategory(e2eAuthPool);
    const member = await person(e2eAuthPool, lifecycle, [{ guild_key: guild.guild_key, tier: 'full' }], guild.guild_key);
    const session = await login(browser, baseURL!, member.email);
    await session.page.emulateMedia({ reducedMotion: 'reduce' });
    const title = `保留工作${randomUUID().slice(0, 8)}`;
    try {
      const made = await postJson(session.page, '/tenants', { display_name: '保留工作業務', workspace_name: '歷史工作區' });
      const tenantId = made.tenant.tenant_id as string, workspaceId = made.workspace.workspace_id as string;
      await postJson(session.page, `/tenants/${tenantId}/workspaces/${workspaceId}/manual-work`, { guild_key: guild.guild_key }, 200);
      await postJson(session.page, `/tenants/${tenantId}/workspaces/${workspaceId}/works`, { title, objective: '保留工作目標', progress: 'todo' });
      await openGuild(session.page, guild.guild_key, guild.name);
      await session.page.getByRole('button', { name: title, exact: true }).click();
      await session.page.locator('#my-work-note').fill('封存或暫停前保存的成果');
      await session.page.getByRole('button', { name: '儲存筆記', exact: true }).click();
      await expect(session.page.locator('.my-work-stage')).toContainText('已儲存');
      for (let i = 0; i < 21; i++) await postJson(session.page, `/tenants/${tenantId}/workspaces/${workspaceId}/works`, { title: `其他工作${i}`, objective: '歷史資料', progress: 'todo' });
      for (const width of [1440, 390]) {
        await session.page.setViewportSize({ width, height: 900 });
        await session.page.screenshot({ path: testInfo.outputPath(`before-${lifecycle}-${width}.png`), fullPage: true });
      }
      await changeBoundInstance(session.page, tenantId, workspaceId, guild.guild_key, lifecycle);
      const bindingRead = session.page.waitForResponse(response => response.url().includes(`/workspaces/${workspaceId}/module-binding`));
      await session.page.reload();
      expect((await bindingRead).status()).toBe(200);
      const message = lifecycle === 'archive'
        ? '這個工作區的模組已封存，舊的工作仍可查看；請改用其他工作區建立新工作。'
        : '這個工作區的模組已暫停，舊的工作仍可查看；恢復後才能新增或修改。';
      await expect(session.page.getByText(message, { exact: true })).toBeVisible();
      await expect(session.page.locator('#my-work-title')).toHaveCount(0);
      await expect(session.page.getByRole('button', { name: '啟用手動工作', exact: true })).toHaveCount(0);
      await session.page.locator('.my-work').getByRole('button', { name: '載入更多', exact: true }).click();
      await session.page.getByRole('button', { name: title, exact: true }).click();
      await expect(session.page.getByText('保留工作目標', { exact: true })).toBeVisible();
      for (const name of ['儲存變更', '封存', '儲存筆記', '儲存附件']) await expect(session.page.locator('.my-work').getByRole('button', { name, exact: true })).toHaveCount(0);
      await session.page.getByRole('button', { name: '查看內容', exact: true }).click();
      await expect(session.page.locator('.my-work-result pre')).toHaveText('封存或暫停前保存的成果');
      await expect(session.page.locator('.my-work-result').getByRole('link', { name: '下載' })).toBeVisible();
      for (const id of ['light', 'dark'] as const) {
        await theme(session.page, id);
        for (const width of [1440, 768, 360]) {
          await session.page.setViewportSize({ width, height: 900 });
          await noOverflow(session.page);
          await session.page.screenshot({ path: testInfo.outputPath(`readonly-${lifecycle}-${id}-${width}.png`), fullPage: true });
        }
      }
    } finally { await session.context.close(); await cleanup(e2eAuthPool, member.userId); }
  });
}

async function changeBoundInstance(page: Page, tenantId: string, workspaceId: string, guildKey: string, lifecycle: 'archive' | 'suspend') {
  const context = await (await page.request.get(`/api/v1/tenants/${tenantId}/workspaces/${workspaceId}/launchpad-context?guild_key=${guildKey}`)).json();
  // Use the unchanged health summary as well so this regression can run on the unfixed API.
  const instanceId = context.connection_summary[0].instance_id as string;
  const detail = await (await page.request.get(`/api/v1/tenants/${tenantId}/module-instances/${instanceId}`)).json();
  const csrf = ((await (await page.request.get('/api/v1/session')).json()) as { csrf_token: string }).csrf_token;
  const response = await page.request.post(`/api/v1/tenants/${tenantId}/module-instances/${instanceId}/${lifecycle}`, {
    data: { reason: '保留歷史工作資料' }, headers: { Origin: new URL(page.url()).origin, 'X-CSRF-Token': csrf, 'Idempotency-Key': randomUUID(), 'If-Match': `"${detail.version}"` },
  });
  expect(response.status(), await response.text()).toBe(200);
}

for (const write of ['create', 'edit', 'result'] as const) {
  test(`${{ create: 'creating Work', edit: 'editing Work', result: 'saving a Result' }[write]} while the instance is suspended reloads the read-only context`, async ({ browser, baseURL, e2eAuthPool }) => {
    test.setTimeout(120_000);
    const [guild] = await guildsByCategory(e2eAuthPool);
    const member = await person(e2eAuthPool, `race-${write}`, [{ guild_key: guild.guild_key, tier: 'full' }], guild.guild_key);
    const session = await login(browser, baseURL!, member.email);
    try {
      const made = await postJson(session.page, '/tenants', { display_name: '競態工作業務', workspace_name: '競態工作區' });
      const tenantId = made.tenant.tenant_id as string, workspaceId = made.workspace.workspace_id as string;
      await postJson(session.page, `/tenants/${tenantId}/workspaces/${workspaceId}/manual-work`, { guild_key: guild.guild_key }, 200);
      await postJson(session.page, `/tenants/${tenantId}/workspaces/${workspaceId}/works`, { title: '競態前工作', objective: '保留目標', progress: 'todo' });
      await openGuild(session.page, guild.guild_key, guild.name);
      await expect(session.page.locator('#my-work-title')).toBeVisible();
      if (write !== 'create') await session.page.getByRole('button', { name: '競態前工作', exact: true }).click();
      if (write === 'create') { await session.page.locator('#my-work-title').fill('競態新工作'); await session.page.locator('#my-work-objective').fill('競態目標'); }
      if (write === 'edit') await session.page.locator('#my-work-edit-objective').fill('競態修改');
      if (write === 'result') await session.page.locator('#my-work-note').fill('未送出的筆記');
      await changeBoundInstance(session.page, tenantId, workspaceId, guild.guild_key, 'suspend');
      const bindingRead = session.page.waitForResponse(response => response.url().includes(`/workspaces/${workspaceId}/module-binding`));
      const contextRead = session.page.waitForResponse(response => response.url().includes(`/workspaces/${workspaceId}/launchpad-context`));
      await session.page.getByRole('button', { name: { create: '建立', edit: '儲存變更', result: '儲存筆記' }[write], exact: true }).click();
      expect((await bindingRead).status()).toBe(200);
      expect((await contextRead).status()).toBe(200);
      await expect(session.page.getByText('這個工作區的模組已暫停，舊的工作仍可查看；恢復後才能新增或修改。', { exact: true })).toBeVisible();
      await expect(session.page.locator('#my-work-title')).toHaveCount(0);
      await expect(session.page.locator('#my-work-edit-title')).toHaveCount(0);
      await expect(session.page.getByRole('button', { name: '競態前工作', exact: true })).toBeVisible();
      if (write === 'result') await expect(session.page.locator('#my-work-orphan-note')).toHaveValue('未送出的筆記');
    } finally { await session.context.close(); await cleanup(e2eAuthPool, member.userId); }
  });
}

for (const lifecycle of ['suspend', 'archive'] as const) {
  test(`enabling manual work on a stale page after the bound instance was ${lifecycle === 'suspend' ? 'suspended' : 'archived'} shows the read-only notice`, async ({ browser, baseURL, e2eAuthPool }) => {
    test.setTimeout(120_000);
    const [guild] = await guildsByCategory(e2eAuthPool);
    const member = await person(e2eAuthPool, `enable-${lifecycle}`, [{ guild_key: guild.guild_key, tier: 'full' }], guild.guild_key);
    const session = await login(browser, baseURL!, member.email);
    try {
      const made = await postJson(session.page, '/tenants', { display_name: '啟用競態業務', workspace_name: '啟用競態工作區' });
      const tenantId = made.tenant.tenant_id as string, workspaceId = made.workspace.workspace_id as string;
      await openGuild(session.page, guild.guild_key, guild.name);
      const enable = session.page.getByRole('button', { name: '啟用手動工作', exact: true });
      await expect(enable).toBeVisible();
      await postJson(session.page, `/tenants/${tenantId}/workspaces/${workspaceId}/manual-work`, { guild_key: guild.guild_key }, 200);
      await changeBoundInstance(session.page, tenantId, workspaceId, guild.guild_key, lifecycle);
      await expect(enable).toBeVisible();
      const enabled = session.page.waitForResponse(response => response.request().method() === 'POST'
        && new URL(response.url()).pathname === `/api/v1/tenants/${tenantId}/workspaces/${workspaceId}/manual-work`);
      const bindingRead = session.page.waitForResponse(response => response.request().method() === 'GET'
        && new URL(response.url()).pathname === `/api/v1/tenants/${tenantId}/workspaces/${workspaceId}/module-binding`);
      await enable.click();
      const refused = await enabled;
      expect(refused.status()).toBe(409);
      expect((await refused.json()).code).toBe('work_instance_unavailable');
      expect((await bindingRead).status()).toBe(200);
      const message = lifecycle === 'suspend'
        ? '這個工作區的模組已暫停，舊的工作仍可查看；恢復後才能新增或修改。'
        : '這個工作區的模組已封存，舊的工作仍可查看；請改用其他工作區建立新工作。';
      await expect(session.page.locator('.my-work').getByText(message, { exact: true })).toBeVisible();
      await expect(enable).toHaveCount(0);
      await expect(session.page.locator('#my-work-title')).toHaveCount(0);
      await expect(session.page.getByRole('alert')).toHaveCount(0);
      assertLocal(session.urls);
    } finally { await session.context.close(); await cleanup(e2eAuthPool, member.userId); }
  });
}

test('NP-003 production brief, exact material versions, delivery and feedback reopen after a fresh login', async ({ browser, baseURL, e2eAuthPool }, testInfo) => {
  test.setTimeout(240_000);
  const guildKey = 'guild_commercial_production';
  const guild = (await e2eAuthPool.query<{ name: string }>('SELECT name FROM positioning_guild_catalog WHERE guild_key=$1', [guildKey])).rows[0];
  const member = await person(e2eAuthPool, 'production', [{ guild_key: guildKey, tier: 'full' }], guildKey);
  const session = await login(browser, baseURL!, member.email);
  const errors: string[] = [];
  session.page.on('pageerror', error => errors.push(error.message));
  const page = session.page;
  try {
    await postJson(page, '/tenants', { display_name: `製作空間${randomUUID().slice(0, 8)}`, workspace_name: '主工作區' });
    await openGuild(page, guildKey, guild.name);
    await page.getByRole('button', { name: '啟用手動工作', exact: true }).click();
    await expect(page.getByText('繼續工作', { exact: true })).toBeVisible();
    await page.locator('#my-work-title').fill('飲品拍攝企劃');
    await page.locator('#my-work-objective').fill('完成三張品牌照片與短片規劃');
    await page.getByRole('button', { name: '建立', exact: true }).click();
    await expect(page.getByRole('heading', { name: '製作專案企劃與版本', exact: true })).toBeVisible();
    await page.getByLabel('目標受眾', { exact: true }).fill('戶外愛好者');
    await page.getByLabel('使用渠道／用途', { exact: true }).fill('品牌自有網站');
    await page.getByLabel('拍攝主體／產品事實', { exact: true }).fill('無糖飲品，依包裝核對成分');
    await page.getByRole('button', { name: '新增交付規格', exact: true }).click();
    await page.getByLabel('尺寸／比例', { exact: true }).fill('4:5');
    await page.getByRole('button', { name: '新增鏡位', exact: true }).click();
    await page.getByLabel('鏡位內容', { exact: true }).fill('逆光下瓶身與水滴特寫');
    await page.getByLabel('景別／構圖', { exact: true }).fill('近景');
    await page.getByLabel('光線／道具', { exact: true }).fill('窗光、白卡、水霧');
    await page.getByRole('button', { name: '儲存製作版本', exact: true }).click();
    await expect(page.locator('.my-work-stage')).toContainText('已儲存・第 1 版');
    await expect(page.getByRole('button', { name: '儲存製作版本', exact: true })).toBeEnabled();
    await page.locator('#my-work-file').setInputFiles({ name: '拍攝清單.txt', mimeType: 'text/plain', buffer: Buffer.from('現場清單 v1') });
    await page.getByRole('button', { name: '儲存附件', exact: true }).click();
    await expect(page.locator('.my-work-stage')).toContainText('已儲存・第 2 版');
    await expect(page.getByRole('button', { name: '儲存製作版本', exact: true })).toBeEnabled();
    const materialOption = page.getByLabel('已儲存文字成果', { exact: true }).locator('option').filter({ hasText: '拍攝清單.txt' });
    const materialId = (await materialOption.getAttribute('value', { timeout: 5000 }))!;
    await page.getByLabel('已儲存文字成果', { exact: true }).selectOption(materialId);
    await page.getByRole('button', { name: '登記文字版本', exact: true }).click();
    await page.getByRole('button', { name: '登記外部素材', exact: true }).click();
    await page.getByLabel('素材名稱', { exact: true }).last().fill('外部分鏡參考');
    await page.getByLabel('素材 HTTPS 網址', { exact: true }).fill(`https://example.invalid/production/${'long-version-reference-'.repeat(30)}`);
    await page.getByLabel('素材版本標記', { exact: true }).fill('分鏡 v1');
    await page.getByLabel('來源／使用權說明', { exact: true }).last().fill('僅登記參考位置，尚待自行核對使用權');
    await page.getByLabel('交付版本名稱', { exact: true }).fill('拍攝準備 v1');
    await page.getByLabel('交付素材：拍攝清單.txt', { exact: true }).check();
    await page.getByLabel('交付素材：外部分鏡參考', { exact: true }).check();
    await page.getByRole('button', { name: '儲存製作版本', exact: true }).click();
    await expect(page.getByText('先完成所選文字版本、交付清單或回饋的新增，或清空尚未新增的選擇，再儲存。', { exact: true })).toBeVisible();
    await expect(page.locator('.my-work-result')).toHaveCount(2);
    await page.getByRole('button', { name: '固定此版交付清單', exact: true }).click();
    const deliveryId = (await page.getByLabel('回饋對應版本', { exact: true }).locator('option').filter({ hasText: '拍攝準備 v1' }).getAttribute('value'))!;
    await page.getByLabel('回饋對應版本', { exact: true }).selectOption(deliveryId);
    await page.getByRole('button', { name: '新增版本回饋', exact: true }).click();
    await page.getByLabel('回饋內容', { exact: true }).fill('加拍瓶蓋細節');
    await page.getByLabel('後續修改', { exact: true }).fill('補一個鏡位');
    await page.getByRole('button', { name: '儲存製作版本', exact: true }).click();
    await expect(page.locator('.my-work-stage')).toContainText('已儲存・第 3 版');
    await expect(page.getByRole('button', { name: '儲存製作版本', exact: true })).toBeEnabled();
    const latest = page.locator('.my-work-result').first();
    const href = (await latest.getByRole('link', { name: '下載', exact: true }).getAttribute('href'))!;
    const stored = await page.request.get(href);
    const bytes = await stored.body();
    expect(stored.ok()).toBe(true);
    expect(bytes.toString('utf8')).toContain('freedom.production-dossier/v1');
    expect(bytes.toString('utf8')).toContain(materialId);
    expect(bytes.toString('utf8')).toContain(deliveryId);
    await expect(latest).toContainText(createHash('sha256').update(bytes).digest('hex').slice(0, 12));
    await relogin(page, member.email);
    await openGuild(page, guildKey, guild.name);
    await page.getByRole('button', { name: '飲品拍攝企劃', exact: true }).click();
    await expect(page.getByLabel('目標受眾', { exact: true })).toHaveValue('戶外愛好者');
    await expect(page.getByLabel('鏡位內容', { exact: true })).toHaveValue('逆光下瓶身與水滴特寫');
    await expect(page.getByLabel('回饋內容', { exact: true })).toHaveValue('加拍瓶蓋細節');
    await expect(page.locator('.my-work-result')).toHaveCount(3);
    expect(Buffer.from(await (await page.request.get(href)).body()).equals(bytes)).toBe(true);
    await page.locator('.my-work-result').first().getByRole('button', { name: '查看內容', exact: true }).click();
    await expect(page.locator('.my-work-result').first().locator('pre')).toContainText('freedom.production-dossier/v1');
    for (const skin of ['light', 'dark'] as const) {
      await theme(page, skin);
      for (const width of [1440, 768, 390]) {
        await page.setViewportSize({ width, height: 900 });
        await noOverflow(page);
        await page.locator('.my-work-open').screenshot({ path: testInfo.outputPath(`production-${skin}-${width}.png`) });
        await page.getByRole('heading', { name: '製作專案企劃與版本', exact: true }).evaluate(element => element.scrollIntoView({ block: 'start' }));
        await page.evaluate(() => window.scrollBy(0, -96));
        await page.screenshot({ path: testInfo.outputPath(`production-${skin}-${width}-viewport.png`) });
      }
    }
    assertLocal(session.urls);
    expect(errors).toEqual([]);
  } finally { await session.context.close(); await cleanup(e2eAuthPool, member.userId); }
});

test('NP-003 failed first save recovers the same Work, 412 preserves production draft, future profile locks editing', async ({ browser, baseURL, e2eAuthPool }) => {
  test.setTimeout(240_000);
  const guildKey = 'guild_commercial_production';
  const guild = (await e2eAuthPool.query<{ name: string }>('SELECT name FROM positioning_guild_catalog WHERE guild_key=$1', [guildKey])).rows[0];
  const member = await person(e2eAuthPool, 'production-recovery', [{ guild_key: guildKey, tier: 'full' }], guildKey);
  const session = await login(browser, baseURL!, member.email);
  const page = session.page;
  try {
    const made = await postJson(page, '/tenants', { display_name: `製作復原${randomUUID().slice(0, 8)}`, workspace_name: '主工作區' });
    const tenantId = made.tenant.tenant_id;
    const workspaceId = made.tenant.default_workspace_id;
    await openGuild(page, guildKey, guild.name);
    await page.getByRole('button', { name: '啟用手動工作', exact: true }).click();
    await expect(page.getByText('繼續工作', { exact: true })).toBeVisible();
    await page.locator('#my-work-title').fill('製作復原專案');
    await page.locator('#my-work-objective').fill('保留已建立的專案與未儲存資料');
    await page.getByRole('button', { name: '建立', exact: true }).click();
    await page.getByLabel('目標受眾', { exact: true }).fill('第一份製作草稿');
    let failed = false;
    await page.route('**/results/uploads', async route => {
      if (!failed && route.request().method() === 'POST') {
        failed = true;
        await route.fulfill({ status: 503, contentType: 'application/problem+json', body: JSON.stringify({ detail: 'fixture storage unavailable' }) });
      } else await route.continue();
    });
    await page.getByRole('button', { name: '儲存製作版本', exact: true }).click();
    await expect(page.getByRole('button', { name: '重試', exact: true })).toBeVisible();
    await expect(page.getByLabel('目標受眾', { exact: true })).toHaveValue('第一份製作草稿');
    await page.getByRole('button', { name: '重試', exact: true }).click();
    await expect(page.locator('.my-work-stage')).toContainText('已儲存・第 1 版');
    await expect(page.getByRole('button', { name: '儲存製作版本', exact: true })).toBeEnabled();
    const works = await (await page.request.get(`/api/v1/tenants/${tenantId}/workspaces/${workspaceId}/works`)).json();
    expect(works.items).toHaveLength(1);
    const work = works.items[0];
    await page.getByLabel('核心訊息', { exact: true }).fill('衝突後仍須保留的訊息');
    await patchJson(page, `/tenants/${tenantId}/works/${work.work_id}`, { title: work.title, objective: '另一分頁更新摘要', progress: work.progress }, work.version);
    await page.getByRole('button', { name: '儲存製作版本', exact: true }).click();
    await expect(page.getByRole('button', { name: '保留我的製作草稿', exact: true })).toBeEnabled();
    await expect(page.getByLabel('核心訊息', { exact: true })).toHaveValue('衝突後仍須保留的訊息');
    await page.getByRole('button', { name: '保留我的製作草稿', exact: true }).click();
    await page.getByRole('button', { name: '儲存製作版本', exact: true }).click();
    await expect(page.locator('.my-work-stage')).toContainText('已儲存・第 2 版');
    await expect(page.getByRole('button', { name: '儲存製作版本', exact: true })).toBeEnabled();
    await page.locator('#my-work-file').setInputFiles({ name: '新格式.md', mimeType: 'text/markdown', buffer: Buffer.from('<!-- freedom.production-dossier/v99 -->\n新版欄位不能覆寫') });
    await page.getByRole('button', { name: '儲存附件', exact: true }).click();
    await expect(page.getByText(/製作資料使用未知格式/)).toBeVisible();
    await expect(page.getByRole('button', { name: '儲存製作版本', exact: true })).toBeDisabled();
    await expect(page.locator('.my-work-result')).toHaveCount(3);
    // Fresh authenticated session must still stop at the newer unknown profile, not fall back to revision 2.
    await relogin(page, member.email);
    await openGuild(page, guildKey, guild.name);
    await page.getByRole('button', { name: '製作復原專案', exact: true }).click();
    await expect(page.getByText(/製作資料使用未知格式/)).toBeVisible();
    await expect(page.getByRole('button', { name: '儲存製作版本', exact: true })).toHaveCount(0);
    await expect(page.locator('.my-work-result')).toHaveCount(3);
    assertLocal(session.urls);
  } finally { await session.context.close(); await cleanup(e2eAuthPool, member.userId); }
});

test('NP-004 read-only production viewer keeps readable data without writes; an explicit result writer can save', async ({ browser, baseURL, e2eAuthPool }, testInfo) => {
  test.setTimeout(180_000);
  const guildKey = 'guild_commercial_production';
  const guild = (await e2eAuthPool.query<{ name: string }>('SELECT name FROM positioning_guild_catalog WHERE guild_key=$1', [guildKey])).rows[0];
  const owner = await person(e2eAuthPool, 'production-owner', [{ guild_key: guildKey, tier: 'full' }], guildKey);
  const viewer = await person(e2eAuthPool, 'production-viewer', [{ guild_key: guildKey, tier: 'full' }], guildKey);
  const writer = await person(e2eAuthPool, 'production-writer', [{ guild_key: guildKey, tier: 'full' }], guildKey);
  const session = await login(browser, baseURL!, owner.email);
  const contexts = [session.context];
  try {
    const made = await postJson(session.page, '/tenants', { display_name: `製作權限${randomUUID().slice(0, 8)}`, workspace_name: '主工作區' });
    const tenantId = made.tenant.tenant_id;
    const workspaceId = made.tenant.default_workspace_id;
    await openGuild(session.page, guildKey, guild.name);
    await session.page.getByRole('button', { name: '啟用手動工作', exact: true }).click();
    await expect(session.page.getByText('繼續工作', { exact: true })).toBeVisible();
    await session.page.locator('#my-work-title').fill('唯讀製作企劃');
    await session.page.locator('#my-work-objective').fill('閱讀保存資料與依明確授權寫入');
    await session.page.getByRole('button', { name: '建立', exact: true }).click();
    await session.page.getByLabel('目標受眾', { exact: true }).fill('可閱讀的私人企劃');
    await session.page.getByLabel('核心訊息', { exact: true }).fill('唯讀會員不應失去工作畫面');
    await session.page.getByRole('button', { name: '儲存製作版本', exact: true }).click();
    await expect(session.page.locator('.my-work-stage')).toContainText('已儲存・第 1 版');
    await expect(session.page.getByRole('button', { name: '儲存製作版本', exact: true })).toBeEnabled();
    const works = await (await session.page.request.get(`/api/v1/tenants/${tenantId}/workspaces/${workspaceId}/works`)).json();
    const work = works.items[0];
    for (const entry of [{ person: viewer, role: 'viewer', capabilities: ['work:read'] }, { person: writer, role: 'operator', capabilities: ['work:read', 'work:result.write'] }]) {
      const candidate = await (await session.page.request.get(`/api/v1/tenants/invite-candidates?user_id=${entry.person.userId}`)).json();
      const invite = await postJson(session.page, `/tenants/${tenantId}/invitations`, { invitee_principal_id: candidate.principal_id, role: entry.role,
        instance_capabilities: [{ instance_id: work.instance_id, capabilities: entry.capabilities }], expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString() });
      const member = await login(browser, baseURL!, entry.person.email); contexts.push(member.context);
      const auth = await (await member.page.request.get('/api/v1/session')).json();
      const accepted = await member.page.request.post(`/api/v1/tenants/${tenantId}/invitations/${invite.invitation_id}/accept`, { data: {}, headers: {
        Origin: new URL(member.page.url()).origin, 'X-CSRF-Token': auth.csrf_token, 'Idempotency-Key': randomUUID(), 'If-Match': `"${invite.version}"`,
      } });
      expect(accepted.status(), await accepted.text()).toBe(200);
      const writes: string[] = [];
      member.page.on('request', request => { if (/\/works(?:\/|$)/.test(new URL(request.url()).pathname) && ['POST', 'PUT', 'PATCH'].includes(request.method())) writes.push(request.method()); });
      await openGuild(member.page, guildKey, guild.name);
      await member.page.getByRole('button', { name: '唯讀製作企劃', exact: true }).click();
      await expect(member.page.getByLabel('目標受眾', { exact: true })).toHaveValue('可閱讀的私人企劃');
      await expect(member.page.getByLabel('核心訊息', { exact: true })).toHaveValue('唯讀會員不應失去工作畫面');
      await expect(member.page.getByRole('heading', { name: '建立製作專案', exact: true })).toHaveCount(0);
      await expect(member.page.locator('#my-work-edit-title')).toHaveCount(0);
      if (entry.role === 'viewer') {
        await expect(member.page.getByLabel('目標受眾', { exact: true })).toBeDisabled();
        await expect(member.page.getByRole('button', { name: '儲存製作版本', exact: true })).toHaveCount(0);
        await expect(member.page.getByRole('button', { name: '儲存附件', exact: true })).toHaveCount(0);
        await member.page.locator('.my-work-result').first().getByRole('button', { name: '查看內容', exact: true }).click();
        await expect(member.page.locator('.my-work-result pre')).toContainText('可閱讀的私人企劃');
        expect(writes).toEqual([]);
        for (const [skin, width] of [['light', 390], ['dark', 1440]] as const) {
          await theme(member.page, skin); await member.page.setViewportSize({ width, height: 900 }); await noOverflow(member.page);
          await member.page.getByRole('heading', { name: '製作專案企劃與版本', exact: true }).evaluate(element => element.scrollIntoView({ block: 'start' }));
          await member.page.evaluate(() => window.scrollBy(0, -96));
          await member.page.screenshot({ path: testInfo.outputPath(`production-viewer-${skin}-${width}.png`) });
        }
      } else {
        await expect(member.page.getByRole('button', { name: '儲存製作版本', exact: true })).toBeEnabled();
        await member.page.getByLabel('核心訊息', { exact: true }).fill('依明確成果寫入權限完成修改');
        await member.page.getByRole('button', { name: '儲存製作版本', exact: true }).click();
        await expect(member.page.locator('.my-work-stage')).toContainText('已儲存・第 2 版');
        expect(writes.length).toBeGreaterThan(0);
      }
      assertLocal(member.urls);
    }
  } finally {
    for (const context of contexts) await context.close();
    for (const member of [owner, viewer, writer]) await cleanup(e2eAuthPool, member.userId);
  }
});
