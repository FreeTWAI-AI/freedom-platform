import { mkdirSync } from 'node:fs';
import type { MemberCardData } from '../../apps/portal-web/src/modules/Membership.js';
import { test, expect, type Page } from './fixtures.js';
import { navigate } from './navigation.js';

const shots = 'test-results/home-next-step';
mkdirSync(shots, { recursive: true });
const memberId = '20000000-0000-4000-8000-000000000001';
const memberCardUrl = (url: URL) => url.pathname === `/api/v1/members/${memberId}`;
const guild = { guild_key: 'guild_security', name: '測試資安公會' };
const noGuildMessage = '加入感興趣的公會，再選擇主要公會。';
const choosePrimaryMessage = '從已加入的公會選擇主要公會。';
const skillsMessage = '到技能書架選一本技能書閱讀，開始練習。';

// Synthetic card facts affect only this read. Real membership, grants and work records stay in the isolated fixture.
function memberCard(overrides: Partial<MemberCardData> = {}): MemberCardData {
  return {
    user_id: memberId, nickname: '首頁提示測試', last_seen_at: null, is_online: false,
    positioning_title: null, primary_guild: null, secondary_guilds: [], joined_guilds: [],
    capabilities: [], equipment: [], contacts: {}, is_self: true, friendship: { state: 'self' },
    ...overrides,
  };
}

async function stubCard(page: Page, card: MemberCardData) {
  await page.route(memberCardUrl, route => route.request().method() === 'GET'
    ? route.fulfill({ json: card }) : route.fallback());
}

async function stubJson(page: Page, pathname: string, json: unknown) {
  await page.route(url => url.pathname === pathname, route => route.request().method() === 'GET'
    ? route.fulfill({ json }) : route.fallback());
}

async function login(page: Page) {
  await page.goto('/');
  await page.getByLabel('電子郵件', { exact: true }).fill('maker@local.test');
  await page.getByLabel('密碼', { exact: true }).fill('freedom-local-demo');
  await page.getByRole('button', { name: '登入', exact: true }).click();
  await expect(page.getByRole('heading', { name: '會員首頁', level: 1, exact: true })).toBeVisible();
  // These cases inspect the optional member summary, reached through its visible disclosure.
  await page.locator('.home-personal > summary').click();
}

function suggestion(page: Page) {
  return page.getByRole('region', { name: '公會與技能書建議', exact: true });
}

async function checkGuidance(page: Page, message: string, _destination: 'guilds' | 'skills') {
  await expect(suggestion(page)).toContainText(message);
  await expect(page.locator('.game-console')).toHaveCount(0);
  await expect(page.locator('.floating-messages')).toBeVisible();
}

const scenarios = [
  { name: 'no joined guild', card: memberCard(), message: noGuildMessage, button: '探索職業公會', destination: 'guilds' },
  { name: 'another joined guild without a primary', card: memberCard({ joined_guilds: [guild] }), message: choosePrimaryMessage, button: '設定主要公會', destination: 'guilds' },
  { name: 'a secondary guild in a legacy card without joined_guilds', card: (() => {
    const card = memberCard({ secondary_guilds: [guild] });
    delete card.joined_guilds;
    return card;
  })(), message: choosePrimaryMessage, button: '設定主要公會', destination: 'guilds' },
  { name: 'a primary guild without assuming book grants', card: memberCard({ primary_guild: guild, positioning_title: '測試探索者' }), message: skillsMessage, button: '前往技能書架', destination: 'skills' },
] as const;

for (const scenario of scenarios) {
  test(`home next action follows card facts for ${scenario.name}`, async ({ page }) => {
    await stubCard(page, scenario.card);
    if (scenario.card.primary_guild) await stubJson(page, '/api/v1/me/skill-books', { items: [] });
    await login(page);
    const prompt = suggestion(page);
    await expect(prompt).toHaveCount(1);
    await expect(page.locator('.guild-next-steps')).toHaveCount(0);
    await expect(prompt.getByText(scenario.message, { exact: true })).toBeVisible();
    await expect(prompt).not.toContainText('已解鎖');
    if (!scenario.card.primary_guild) await expect(prompt.getByRole('button')).toHaveCount(1);
    if (scenario.card.primary_guild) {
      const summary = page.getByRole('region', { name: '我的會員摘要', exact: true });
      await expect(summary).toContainText('主要公會 · 測試資安公會');
      await expect(summary).toContainText('測試探索者');
    }
    await checkGuidance(page, scenario.message, scenario.destination);
    const button = prompt.getByRole('button', { name: scenario.button, exact: true });
    await button.focus();
    await expect(button).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(new RegExp(`#${scenario.destination}$`));
    await expect(page.getByRole('heading', { name: scenario.destination === 'guilds' ? '職業公會' : '技能書架', level: 1, exact: true })).toBeVisible();
  });
}

test('a changed guild fact updates the home guidance when home is revisited', async ({ page }) => {
  let card = memberCard();
  await page.route(memberCardUrl, route => route.request().method() === 'GET'
    ? route.fulfill({ json: card }) : route.fallback());
  await login(page);
  await expect(suggestion(page)).toContainText(noGuildMessage);
  await checkGuidance(page, noGuildMessage, 'guilds');
  await suggestion(page).getByRole('button', { name: '探索職業公會', exact: true }).click();
  await expect(page.getByRole('heading', { name: '職業公會', level: 1, exact: true })).toBeVisible();
  card = memberCard({ joined_guilds: [guild] });
  await navigate(page, '會員首頁');
  await expect(suggestion(page)).toContainText(choosePrimaryMessage);
  await checkGuidance(page, choosePrimaryMessage, 'guilds');
  await suggestion(page).getByRole('button', { name: '設定主要公會', exact: true }).click();
  await expect(page.getByRole('heading', { name: '職業公會', level: 1, exact: true })).toBeVisible();
  // Leaving the only joined guild returns to an earlier state in this same login.
  card = memberCard();
  await navigate(page, '會員首頁');
  await expect(suggestion(page)).toContainText(noGuildMessage);
  await checkGuidance(page, noGuildMessage, 'guilds');
});

test('home does not guess a next action while the member read waits or fails and recovers on retry', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  let mode: 'hold' | 'fail' | 'pass' = 'hold', release!: () => void, requests = 0;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route(memberCardUrl, async route => {
    if (route.request().method() !== 'GET') return route.fallback();
    requests++;
    if (mode === 'hold') await held;
    return mode === 'fail' ? route.fulfill({ status: 503, body: '' }) : route.fulfill({ json: memberCard({ secondary_guilds: [guild] }) });
  });
  await login(page);
  const summary = page.getByRole('region', { name: '我的會員摘要', exact: true });
  await expect(summary).toHaveAttribute('aria-busy', 'true');
  await expect(summary).toContainText('正在載入名片');
  await expect(suggestion(page)).toHaveCount(0);
  await expect(page.getByRole('navigation', { name: '常用入口', exact: true }).getByRole('button')).toHaveCount(3);
  mode = 'fail'; release();
  const alert = page.getByRole('alert').filter({ hasText: '名片暫時無法載入' });
  await expect(alert).toBeVisible();
  await expect(suggestion(page)).toHaveCount(0);
  await expect(summary).not.toContainText('尚未設定主要公會');
  await expect(page.locator('.game-console')).toHaveCount(0);
  await page.screenshot({ path: `${shots}/phone-read-failed.png`, fullPage: true });
  const baseline = requests;
  mode = 'pass';
  await alert.getByRole('button', { name: '重新載入名片', exact: true }).click();
  await expect(suggestion(page)).toContainText(choosePrimaryMessage);
  await expect(alert).toHaveCount(0);
  await expect(summary).toBeFocused();
  expect(requests).toBe(baseline + 1);
  await checkGuidance(page, choosePrimaryMessage, 'guilds');
});

test('a granted primary-guild book opens from the same next-step region', async ({ page }) => {
  const skipped = { id: 'book-locked', book_id: 'book-locked', title: '尚未授權的技能書', description: '主要公會有這本，但還沒授權。', repository_url: 'https://github.com/example/locked' };
  const granted = { id: 'book-home-first', book_id: 'book-home-first', title: '首頁第一本技能書', description: '從主要公會開始的練習。', repository_url: 'https://github.com/example/first-book' };
  await stubCard(page, memberCard({ primary_guild: guild }));
  await page.route(url => url.pathname === '/api/v1/guilds/directory', async route => {
    if (route.request().method() !== 'GET') return route.fallback();
    const response = await route.fetch();
    const data = await response.json() as { items?: { guild_key: string; skill_books?: unknown[] }[] };
    const items = Array.isArray(data.items) ? data.items : [];
    const match = items.find(item => item.guild_key === guild.guild_key);
    if (match) match.skill_books = [skipped, granted];
    else items.push({ guild_key: guild.guild_key, skill_books: [skipped, granted] });
    await route.fulfill({ json: { ...data, items } });
  });
  await stubJson(page, '/api/v1/me/skill-books', { items: [{ book_id: 'book-other', id: 'book-other' }, { book_id: granted.book_id }] });
  await stubJson(page, '/api/v1/task-board/preview', { items: [] });
  await stubJson(page, '/api/v1/dashboard', { now: [] });
  await login(page);
  const prompt = suggestion(page);
  await expect(prompt.getByText(skillsMessage, { exact: true })).toBeVisible();
  await expect(prompt.getByRole('button', { name: '前往技能書架', exact: true })).toHaveCount(0);
  await expect(prompt.getByRole('button', { name: '進入測試資安公會聊天室', exact: true })).toBeVisible();
  await expect(prompt.getByRole('button', { name: '分享作品與需求', exact: true })).toBeVisible();
  await expect(prompt).not.toContainText('尚未授權的技能書');
  const open = prompt.getByRole('button', { name: '閱讀第一本技能書', exact: true });
  await expect(open).toHaveAttribute('aria-describedby', 'home-next-step-description');
  await open.click();
  const dialog = page.locator('dialog.skill-intro-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute('data-book-id', granted.book_id);
  await expect(dialog.getByRole('heading', { name: granted.title, exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: '關閉技能書介紹', exact: true }).click();
  await expect(dialog).toBeHidden();
  await prompt.getByRole('button', { name: '分享作品與需求', exact: true }).click();
  await expect(page).toHaveURL(/#showcase$/);
  await expect(page.getByRole('heading', { name: '作品與需求', level: 1, exact: true })).toBeVisible();
  await navigate(page, '會員首頁');
  await page.evaluate(() => {
    const seen: { kind: string; key: string }[] = [];
    window.addEventListener('freedom-open-channel', event => seen.push((event as CustomEvent<{ kind: string; key: string }>).detail));
    (window as unknown as { __openedChat?: typeof seen }).__openedChat = seen;
  });
  await suggestion(page).getByRole('button', { name: '進入測試資安公會聊天室', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __openedChat?: { kind: string; key: string }[] }).__openedChat)).toEqual([{ kind: 'guild', key: guild.guild_key }]);
});

const taskHint = '社群任務板有開放中的任務，可自行挑選一件參與。';

test('the task hint appears only when the board has open tasks and keeps the skill-book guidance', async ({ page }) => {
  await stubCard(page, memberCard({ primary_guild: guild }));
  await stubJson(page, '/api/v1/me/skill-books', { items: [] });
  await stubJson(page, '/api/v1/task-board/preview', { items: [{ work_item_id: 'preview-1', title: '不應顯示的任務標題' }] });
  await stubJson(page, '/api/v1/dashboard', { now: [] });
  await login(page);
  const prompt = suggestion(page);
  await expect(prompt.getByText(taskHint, { exact: true })).toBeVisible();
  await expect(prompt.locator('.home-next-copy #home-next-task-hint')).toHaveText(taskHint);
  await expect(prompt.getByText(skillsMessage, { exact: true })).toBeVisible();
  await expect(prompt).not.toContainText('不應顯示的任務標題');
  await expect(prompt.getByRole('button', { name: '查看社群任務', exact: true })).toHaveAccessibleDescription(`${skillsMessage} ${taskHint}`);
  await checkGuidance(page, skillsMessage, 'skills');
});

for (const [name, mock] of [
  ['an empty board', (page: Page) => stubJson(page, '/api/v1/task-board/preview', { items: [] })],
  ['a failed board read', (page: Page) => page.route(url => url.pathname === '/api/v1/task-board/preview', route => route.fulfill({ status: 503, body: '' }))],
] as const) {
  test(`the task hint stays hidden for ${name}`, async ({ page }) => {
    await stubCard(page, memberCard({ primary_guild: guild }));
    await stubJson(page, '/api/v1/me/skill-books', { items: [] });
    await mock(page);
    await stubJson(page, '/api/v1/dashboard', { now: [] });
    await login(page);
    const prompt = suggestion(page);
    await expect(prompt.getByText(skillsMessage, { exact: true })).toBeVisible();
    await expect(prompt.getByRole('button', { name: '進入測試資安公會聊天室', exact: true })).toBeVisible();
    await expect(prompt.getByText(taskHint, { exact: true })).toHaveCount(0);
    if (name === 'an empty board') {
      await expect(prompt.getByRole('button', { name: '分享作品與需求', exact: true })).toHaveAccessibleDescription(skillsMessage);
    } else await expect(prompt.getByRole('button', { name: /社群任務|分享作品與需求/ })).toHaveCount(0);
  });
}

const workHint = '你有認領中的工作還沒結案，可以回到「我的工作」繼續。';
// Only `now` matters to home; the shape mirrors work.ts dashboard() for a claim that is still in progress.
const unfinishedClaim = { work_item_id: 'claim-1', title: '不應顯示的工作標題', state: 'claiming_closed', my_claim: { claim_id: 'claim-1', state: 'in_progress' } };

test('an unfinished claim replaces the open-task hint with a return to my work', async ({ page }) => {
  await stubCard(page, memberCard({ primary_guild: guild }));
  await stubJson(page, '/api/v1/me/skill-books', { items: [] });
  await stubJson(page, '/api/v1/task-board/preview', { items: [{ work_item_id: 'preview-1', title: '不應顯示的任務標題' }] });
  await stubJson(page, '/api/v1/dashboard', { now: [unfinishedClaim] });
  await login(page);
  const prompt = suggestion(page);
  await expect(prompt.locator('.home-next-copy #home-next-task-hint')).toHaveText(workHint);
  await expect(prompt.getByText(skillsMessage, { exact: true })).toBeVisible();
  await expect(prompt.getByText(taskHint, { exact: true })).toHaveCount(0);
  await expect(prompt.getByRole('button', { name: /社群任務|分享作品與需求/ })).toHaveCount(0);
  await expect(prompt).not.toContainText('不應顯示的');
  const resume = prompt.getByRole('button', { name: '回到我的工作', exact: true });
  await expect(resume).toHaveAccessibleDescription(`${skillsMessage} ${workHint}`);
  await checkGuidance(page, skillsMessage, 'skills');
  await resume.focus();
  await expect(resume).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/#workbench$/);
  await expect(page.getByRole('heading', { name: '我的工作', level: 1, exact: true })).toBeVisible();
});

test('a failed work dashboard read keeps the open-task hint', async ({ page }) => {
  await stubCard(page, memberCard({ primary_guild: guild }));
  await stubJson(page, '/api/v1/me/skill-books', { items: [] });
  await stubJson(page, '/api/v1/task-board/preview', { items: [{ work_item_id: 'preview-1', title: '不應顯示的任務標題' }] });
  await page.route(url => url.pathname === '/api/v1/dashboard', route => route.fulfill({ status: 503, body: '' }));
  await login(page);
  const prompt = suggestion(page);
  await expect(prompt.getByText(taskHint, { exact: true })).toBeVisible();
  await expect(prompt.getByRole('button', { name: '查看社群任務', exact: true })).toBeVisible();
  await expect(prompt.getByText(workHint, { exact: true })).toHaveCount(0);
});

test('the home action stays compact, readable and reachable in all themes on desktop and phones', async ({ page }) => {
  test.setTimeout(90000);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 1440, height: 900 });
  await stubCard(page, memberCard({ primary_guild: guild, positioning_title: '測試探索者' }));
  await stubJson(page, '/api/v1/me/skill-books', { items: [] });
  await stubJson(page, '/api/v1/task-board/preview', { items: [{ work_item_id: 'preview-1', title: '不應顯示的任務標題' }] });
  await stubJson(page, '/api/v1/dashboard', { now: [] });
  await login(page);
  const prompt = suggestion(page);
  const names = ['前往技能書架', '進入測試資安公會聊天室', '查看社群任務'] as const;
  for (const name of names) await expect(prompt.getByRole('button', { name, exact: true })).toBeVisible();
  await expect(prompt).not.toContainText('不應顯示的任務標題');
  for (const [theme, label] of [['light', '自由工坊－明亮'], ['dark', '自由工坊－夜航'], ['versefolk', '自由工坊－敘生']] as const) {
    await page.getByRole('button', { name: '設定', exact: true }).click();
    await page.getByRole('menuitemradio', { name: label, exact: true }).click();
    await page.getByRole('button', { name: '設定', exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    for (const width of [1440, 820, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(prompt.getByText(skillsMessage, { exact: true })).toBeVisible();
      const region = await prompt.boundingBox();
      for (const name of names) {
        const button = prompt.getByRole('button', { name, exact: true });
        await expect(button).toHaveAttribute('aria-describedby', name === '查看社群任務' ? 'home-next-step-description home-next-task-hint' : 'home-next-step-description');
        await button.focus();
        await expect(button).toBeFocused();
        const box = await button.boundingBox();
        expect(box!.height, `${theme} ${width}px ${name} height`).toBeGreaterThanOrEqual(44);
        expect(box!.width, `${theme} ${width}px ${name} width`).toBeGreaterThanOrEqual(44);
        if (width >= 820) expect(box!.width, `${theme} ${width}px ${name} is not full width`).toBeLessThan(region!.width - 8);
        expect(await button.evaluate(element => parseFloat(getComputedStyle(element).fontSize)), `${theme} ${width}px ${name} font`).toBeGreaterThanOrEqual(14);
      }
      expect(await prompt.getByText(skillsMessage, { exact: true }).evaluate(element => parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(14);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${theme} ${width}px horizontal overflow`).toBe(true);
      await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
      await page.screenshot({ path: `${shots}/${theme}-${width}.png`, fullPage: true });
    }
  }
});
