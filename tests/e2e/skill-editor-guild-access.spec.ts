import { mkdirSync } from 'node:fs';
import { test, expect, type Page } from './fixtures.js';

// Server authorization is covered by tests/runtime/guild-workspace.test.ts against PostgreSQL.
// These routes are explicit synthetic fixtures for the member UI; the nav entry is not relied on.
const evidence = process.env.AUDIT_EVIDENCE_DIR ?? 'test-results/audit-operations';
mkdirSync(evidence, { recursive: true });

const viewports = [['desktop', { width: 1280, height: 900 }], ['mobile', { width: 390, height: 844 }]] as const;
const book = { book_id: 'video-autopilot', title: '測試剪輯技能' };
const aiGuilds = [{ guild_key: 'guild_ai_field', name: 'AI 導入與驗證公會' }, { guild_key: 'guild_ai_vibe', name: 'AI 開發公會' }];
const recoveryText = '已被任命維護 1 本技能書，加入「AI 導入與驗證公會」或「AI 開發公會」即可編輯。';
const guildProblem = { type: 'about:blank', title: 'skill_editor_guild_required', status: 403, code: 'skill_editor_guild_required', detail: '技能書編輯需要目前加入「AI 開發公會」或「AI 導入與驗證公會」其中之一。' };
const maintainerProblem = { type: 'about:blank', title: 'skill_maintainer_required', status: 403, code: 'skill_maintainer_required', detail: '此操作限這本技能書的維護者。' };

type State = { appointed: boolean; inGuild: boolean; council: boolean; workspaceDown: boolean };
function workspace(state: State) {
  const eligible = state.inGuild;
  return {
    managed_guilds: [], managed_books: state.appointed && eligible ? [book] : [], can_discuss: state.council,
    skill_editor_access: { appointed_books: state.appointed ? 1 : 0, eligible, requires_development_guild: state.appointed && !eligible, active_guilds: eligible ? ['guild_ai_field'] : [], required_guilds: aiGuilds },
  };
}

/** Synthetic workspace + editor that apply the same two-part rule as the server. */
async function stub(page: Page, initial: Partial<State>) {
  const state: State = { appointed: true, inGuild: true, council: false, workspaceDown: false, ...initial };
  const calls = { workspace: 0, editorGets: 0, saves: [] as any[], denied: 0, joins: [] as string[], ifMatch: [] as (string | undefined)[] };
  let editorial = { book_id: book.book_id, summary: '一起製作剪輯工具。', collaboration_intro: '補上可重跑的合成素材測試。', milestones: [] as any[], tasks: [] as any[], aggregate_version: 3, updated_at: '2026-09-23T12:00:00Z' };
  await page.route('**/api/v1/me/github', route => route.fulfill({ json: { configured: false, connected: false, github_user: null } }));
  await page.route('**/api/v1/guild-workspace', route => {
    calls.workspace++;
    if (state.workspaceDown) return route.fulfill({ status: 503, json: { detail: 'synthetic outage' } });
    return route.fulfill({ json: workspace(state) });
  });
  await page.route(`**/api/v1/skill-books/${book.book_id}/editor`, route => {
    const post = route.request().method() === 'POST';
    if (!post) calls.editorGets++;
    if (!state.appointed) return route.fulfill({ status: 403, json: maintainerProblem });
    if (!state.inGuild) { calls.denied++; return route.fulfill({ status: 403, json: guildProblem }); }
    if (!post) return route.fulfill({ json: editorial });
    const body = route.request().postDataJSON();
    calls.saves.push(body); calls.ifMatch.push(route.request().headers()['if-match']);
    editorial = { ...editorial, ...body, aggregate_version: editorial.aggregate_version + 1, updated_at: '2026-09-24T09:00:00Z' };
    return route.fulfill({ json: editorial });
  });
  // Any automatic join would be a bug: joining is always the member's own action on the guild page.
  await page.route('**/api/v1/guilds/*/join', route => { calls.joins.push(route.request().url()); return route.fulfill({ status: 418, json: { detail: 'unexpected join' } }); });
  return { state, calls };
}

async function login(page: Page) {
  await page.goto('/');
  await page.getByLabel('電子郵件', { exact: true }).fill('maker@local.test');
  await page.getByLabel('密碼', { exact: true }).fill('freedom-local-demo');
  await page.getByRole('button', { name: '登入', exact: true }).click();
  await expect(page.getByRole('button', { name: '登出', exact: true })).toBeVisible();
}
async function openWorkspace(page: Page) {
  await page.goto('/#guild-workspace');
  await expect(page.getByRole('heading', { level: 1, name: '公會管理' })).toBeVisible();
  await expect(page.getByText('正在載入管理權限…', { exact: true })).toHaveCount(0);
}
const fits = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
const workspaceRoot = (page: Page) => page.locator('.guild-workspace');

for (const [viewport, size] of viewports) {
  test(`${viewport}: an appointed maintainer outside the AI guilds gets a join path, not "no duties", and reloading after joining restores the editor`, async ({ page }) => {
    await page.setViewportSize(size);
    const { state, calls } = await stub(page, { inGuild: false });
    await login(page); await openWorkspace(page);
    const root = workspaceRoot(page);
    await expect(root.getByText(recoveryText, { exact: true })).toBeVisible();
    await expect(root.getByText('目前沒有公會或技能書的管理職務', { exact: true })).toHaveCount(0);
    await expect(root.getByRole('button', { name: '技能書編輯', exact: true })).toHaveCount(0);
    const link = root.getByRole('link', { name: '前往職業公會', exact: true });
    await expect(link).toHaveAttribute('href', '#guilds');
    await expect(link).not.toHaveAttribute('target', '_blank');
    expect((await link.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    expect(await fits(page)).toBe(true);
    await page.screenshot({ path: `${evidence}/after-skill-editor-guild-required-${viewport}.png`, fullPage: true });

    await link.click();
    await expect(page).toHaveURL(/#guilds$/);
    await expect(page.getByRole('heading', { level: 1, name: '職業公會' })).toBeVisible();
    expect(calls.joins).toEqual([]);
    expect(calls.editorGets).toBe(0);

    state.inGuild = true;
    await openWorkspace(page);
    await expect(workspaceRoot(page).getByRole('textbox', { name: '一句話摘要', exact: true })).toHaveValue('一起製作剪輯工具。');
    await expect(workspaceRoot(page).getByText(recoveryText, { exact: true })).toHaveCount(0);
    expect(calls.joins).toEqual([]);
  });

  test(`${viewport}: losing the last AI guild mid-edit keeps the draft, offers recovery, and a confirmed re-check restores saving`, async ({ page }) => {
    await page.setViewportSize(size);
    const { state, calls } = await stub(page, {});
    await login(page); await openWorkspace(page);
    const root = workspaceRoot(page);
    const summary = root.getByRole('textbox', { name: '一句話摘要', exact: true });
    await expect(summary).toHaveValue('一起製作剪輯工具。');
    await summary.fill('離會前還沒保存的摘要');
    await root.getByRole('button', { name: '新增協作任務', exact: true }).click();
    await root.getByLabel('任務標題', { exact: true }).fill('整理合成字幕素材');
    await root.getByLabel('修改範圍', { exact: true }).fill('在 fixtures 加入十秒片段。');
    await root.getByLabel('完成條件（每行一項）', { exact: true }).fill('可重跑產生相同時長');

    state.inGuild = false;
    await root.getByRole('button', { name: '保存技能書', exact: true }).click();
    await expect(root.getByText(recoveryText, { exact: true })).toBeVisible();
    expect(calls.denied).toBe(1);
    await expect(summary).toHaveValue('離會前還沒保存的摘要');
    await expect(root.getByLabel('任務標題', { exact: true })).toHaveValue('整理合成字幕素材');
    await expect(root.getByRole('button', { name: '保存技能書', exact: true })).toBeDisabled();
    await expect(root.getByText('此操作限這本技能書的維護者', { exact: false })).toHaveCount(0);
    await expect(root.getByText('skill_editor_guild_required', { exact: false })).toHaveCount(0);
    const link = root.getByRole('link', { name: /職業公會/ });
    await expect(link).toHaveAttribute('href', '#guilds');
    await expect(link).toHaveAttribute('target', '_blank');
    expect(await fits(page)).toBe(true);
    await page.screenshot({ path: `${evidence}/after-skill-editor-lost-guild-${viewport}.png`, fullPage: true });

    const recheck = root.getByRole('button', { name: '重新核對管理權限', exact: true });
    await recheck.click();
    await expect(root.getByText('已重新核對：目前仍未加入必要的 AI 公會。', { exact: true })).toBeVisible();
    await expect(root.getByRole('button', { name: '保存技能書', exact: true })).toBeDisabled();

    // A failed re-check must not look like success or re-open writing.
    state.inGuild = true; state.workspaceDown = true;
    await recheck.click();
    await expect(root.getByRole('alert')).toContainText('服務暫時無法回應');
    await expect(root.getByText(recoveryText, { exact: true })).toBeVisible();
    await expect(root.getByRole('button', { name: '保存技能書', exact: true })).toBeDisabled();
    await expect(summary).toHaveValue('離會前還沒保存的摘要');

    state.workspaceDown = false;
    await recheck.click();
    await expect(root.getByText(recoveryText, { exact: true })).toHaveCount(0);
    await expect(root.getByRole('status')).toContainText('尚未保存的內容仍在');
    await expect(summary).toHaveValue('離會前還沒保存的摘要');
    await root.getByRole('button', { name: '保存技能書', exact: true }).click();
    await expect(root.getByRole('status')).toContainText('分享頁同步更新');
    expect(calls.saves).toHaveLength(1);
    expect(calls.saves[0].summary).toBe('離會前還沒保存的摘要');
    expect(calls.saves[0].tasks[0]).toMatchObject({ title: '整理合成字幕素材', acceptance: ['可重跑產生相同時長'], status: 'todo' });
    expect(calls.ifMatch).toEqual(['"3"']);
    expect(calls.joins).toEqual([]);
  });
}

test('an eligible maintainer edits the summary and a structured task and saves them', async ({ page }) => {
  const { calls } = await stub(page, {});
  await login(page); await openWorkspace(page);
  const root = workspaceRoot(page);
  await expect(root.getByText(/即可編輯/)).toHaveCount(0);
  await root.getByRole('textbox', { name: '一句話摘要', exact: true }).fill('一起做可以重跑的剪輯工具。');
  await root.getByRole('button', { name: '新增里程碑', exact: true }).click();
  await root.getByLabel('里程碑 1', { exact: true }).fill('第一組剪輯回歸');
  await root.getByRole('button', { name: '新增協作任務', exact: true }).click();
  await root.getByLabel('任務標題', { exact: true }).fill('加入合成字幕素材');
  await root.getByLabel('修改範圍', { exact: true }).fill('在 fixtures 加入十秒片段。');
  await root.getByLabel('完成條件（每行一項）', { exact: true }).fill('可重跑產生相同時長\n字幕位置有斷言');
  await root.getByRole('combobox', { name: '所屬里程碑', exact: true }).selectOption({ label: '第一組剪輯回歸' });
  await root.getByRole('button', { name: '保存技能書', exact: true }).click();
  await expect(root.getByRole('status')).toContainText('分享頁同步更新');
  expect(calls.saves).toHaveLength(1);
  expect(calls.saves[0].summary).toBe('一起做可以重跑的剪輯工具。');
  expect(calls.saves[0].tasks[0].acceptance).toEqual(['可重跑產生相同時長', '字幕位置有斷言']);
  expect(calls.saves[0].tasks[0].milestone_id).toBe(calls.saves[0].milestones[0].id);
});

test('a failed first editor load offers a retry that restores the fields without a false saved notice', async ({ page }) => {
  const { calls } = await stub(page, {});
  let failures = 1;
  // Registered after stub, so it runs first; later GETs fall through to the synthetic editor.
  await page.route(`**/api/v1/skill-books/${book.book_id}/editor`, route => {
    if (route.request().method() === 'GET' && failures > 0) { failures--; calls.editorGets++; return route.fulfill({ status: 503, json: { detail: 'synthetic outage' } }); }
    return route.fallback();
  });
  await login(page); await openWorkspace(page);
  const root = workspaceRoot(page);
  const summary = root.getByRole('textbox', { name: '一句話摘要', exact: true });
  await expect(root.getByRole('alert')).toContainText('服務暫時無法回應');
  await expect(summary).toHaveCount(0);
  const retry = root.getByRole('button', { name: '重新載入技能書', exact: true });
  await expect(retry).toBeEnabled();
  await retry.click();
  await expect(summary).toHaveValue('一起製作剪輯工具。');
  await expect(root.getByRole('textbox', { name: '協作說明', exact: true })).toHaveValue('補上可重跑的合成素材測試。');
  await expect(root.getByRole('alert')).toHaveCount(0);
  await expect(retry).toHaveCount(0);
  await expect(root.getByText(/已保存|同步更新/)).toHaveCount(0);
  expect(calls.editorGets).toBe(2);
  expect(calls.saves).toEqual([]);
  expect(calls.joins).toEqual([]);
});

test('a guild leader missing the AI guild keeps the council and sees the editor join path beside it', async ({ page }) => {
  const { calls } = await stub(page, { inGuild: false, council: true });
  await page.route('**/api/v1/guild-council/threads', route => route.fulfill({ json: { items: [] } }));
  await login(page); await openWorkspace(page);
  const root = workspaceRoot(page);
  await expect(root.getByText(recoveryText, { exact: true })).toBeVisible();
  await expect(root.getByRole('button', { name: '公會長議事區', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(root.getByRole('heading', { name: '公會長議事區', exact: true })).toBeVisible();
  await expect(root.getByRole('button', { name: '建立討論', exact: true })).toBeEnabled();
  expect(calls.editorGets).toBe(0);
  expect(calls.joins).toEqual([]);
});

test('a revoked appointment keeps the maintainer error instead of the guild prompt', async ({ page }) => {
  const { state } = await stub(page, {});
  // Workspace still lists the book (stale), but the editor now answers skill_maintainer_required.
  await page.route('**/api/v1/guild-workspace', route => route.fulfill({ json: workspace({ ...state, appointed: true, inGuild: true }) }));
  state.appointed = false;
  await login(page); await openWorkspace(page);
  const root = workspaceRoot(page);
  await expect(root.getByRole('alert')).toContainText('此操作限這本技能書的維護者');
  await expect(root.getByText(/即可編輯/)).toHaveCount(0);
  await expect(root.getByRole('link', { name: /職業公會/ })).toHaveCount(0);
});

test('a member without any appointment keeps the ordinary empty state', async ({ page }) => {
  const { calls } = await stub(page, { appointed: false, inGuild: false });
  await login(page); await openWorkspace(page);
  const root = workspaceRoot(page);
  await expect(root.getByText('目前沒有公會或技能書的管理職務', { exact: true })).toBeVisible();
  await expect(root.getByText(/即可編輯/)).toHaveCount(0);
  await expect(root.getByRole('link', { name: /職業公會/ })).toHaveCount(0);
  expect(calls.editorGets).toBe(0);
});

test('admin nav group labels keep one line above their wrapped buttons on a phone', async ({ page }) => {
  await page.route('**/admin/api/**', route => {
    const path = new URL(route.request().url()).pathname.replace('/admin/api', '');
    if (path === '/bootstrap') return route.fulfill({ json: { admin: { admin_id: 'synthetic-admin', display_name: '稽核管理員', email: 'admin@example.test', role: 'super_admin', community_id: 'synthetic' }, csrf_token: 'synthetic-csrf', summary: { members: 1, active_members: 1, pending_guild_applications: 0, guilds: 1, admins: 1 }, available_skill_books: [], pending_guild_appointments: [] } });
    return route.fulfill({ json: { items: [], next_offset: null } });
  });
  for (const [viewport, size] of viewports) {
    await page.setViewportSize(size);
    await page.goto('/admin');
    await expect(page.getByRole('heading', { name: '會員管理', exact: true })).toBeVisible();
    for (const name of ['人員與權限', '公會', '系統']) {
      const group = page.getByRole('group', { name, exact: true });
      const label = group.locator('.admin-nav-label'), buttons = group.getByRole('button');
      const box = (await label.boundingBox())!, fontSize = await label.evaluate(el => parseFloat(getComputedStyle(el).fontSize)), lineHeight = await label.evaluate(el => parseFloat(getComputedStyle(el).lineHeight) || parseFloat(getComputedStyle(el).fontSize) * 1.6);
      expect(fontSize, `${name} ${viewport}`).toBe(14);
      expect(box.height, `${name} ${viewport} label stays on one line`).toBeLessThan(lineHeight * 1.5);
      for (const button of await buttons.all()) {
        const target = (await button.boundingBox())!;
        expect(target.height, `${name} ${viewport} touch target`).toBeGreaterThanOrEqual(44);
        expect(target.x + target.width).toBeLessThanOrEqual(size.width);
        if (viewport === 'mobile') expect(target.y, `${name} buttons sit below the label`).toBeGreaterThanOrEqual(box.y + box.height - 1);
      }
    }
    expect(await fits(page)).toBe(true);
    await page.screenshot({ path: `${evidence}/after-admin-nav-groups-${viewport}.png`, fullPage: true });
  }
});
