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
    user_id: memberId, nickname: '首頁提示測試', last_login_at: null, is_online: false,
    positioning_title: null, primary_guild: null, secondary_guilds: [], joined_guilds: [],
    capabilities: [], equipment: [], contacts: {}, is_self: true, friendship: { state: 'self' },
    ...overrides,
  };
}

async function stubCard(page: Page, card: MemberCardData) {
  await page.route(memberCardUrl, route => route.request().method() === 'GET'
    ? route.fulfill({ json: card }) : route.fallback());
}

async function login(page: Page) {
  await page.goto('/');
  await page.getByLabel('電子郵件', { exact: true }).fill('maker@local.test');
  await page.getByLabel('密碼', { exact: true }).fill('freedom-local-demo');
  await page.getByRole('button', { name: '登入', exact: true }).click();
  await expect(page.getByRole('heading', { name: '會員首頁', level: 1, exact: true })).toBeVisible();
}

function suggestion(page: Page) {
  return page.getByRole('region', { name: '公會與技能書建議', exact: true });
}

async function checkConsole(page: Page, message: string, destination: 'guilds' | 'skills') {
  await page.getByRole('button', { name: '展開訊息控制台', exact: true }).click();
  await page.getByRole('tab', { name: /^系統導覽/ }).click();
  const next = page.locator('.game-console-entry[data-next-step="true"]').last();
  await expect(next).toContainText(message);
  await expect(next.getByRole('link', { name: '帶我到下一步', exact: true })).toHaveAttribute('href', `/#${destination}`);
  await page.getByRole('button', { name: '收合訊息控制台', exact: true }).click();
  // Collapse returns focus on the next animation frame; wait before testing another control.
  await expect(page.getByRole('button', { name: '展開訊息控制台', exact: true })).toBeFocused();
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
    await login(page);
    const prompt = suggestion(page);
    await expect(prompt).toHaveCount(1);
    await expect(prompt.getByText(scenario.message, { exact: true })).toBeVisible();
    await expect(prompt).not.toContainText('已解鎖');
    if (scenario.card.primary_guild) {
      const summary = page.getByRole('region', { name: '我的會員摘要', exact: true });
      await expect(summary).toContainText('主要公會 · 測試資安公會');
      await expect(summary).toContainText('測試探索者');
    }
    await checkConsole(page, scenario.message, scenario.destination);
    const button = prompt.getByRole('button', { name: scenario.button, exact: true });
    await button.focus();
    await expect(button).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(new RegExp(`#${scenario.destination}$`));
    await expect(page.getByRole('heading', { name: scenario.destination === 'guilds' ? '職業公會' : '技能書架', level: 1, exact: true })).toBeVisible();
  });
}

test('a changed guild fact produces the updated Console guidance when home is revisited', async ({ page }) => {
  let card = memberCard();
  await page.route(memberCardUrl, route => route.request().method() === 'GET'
    ? route.fulfill({ json: card }) : route.fallback());
  await login(page);
  await expect(suggestion(page)).toContainText(noGuildMessage);
  await checkConsole(page, noGuildMessage, 'guilds');
  await suggestion(page).getByRole('button', { name: '探索職業公會', exact: true }).click();
  await expect(page.getByRole('heading', { name: '職業公會', level: 1, exact: true })).toBeVisible();
  card = memberCard({ joined_guilds: [guild] });
  await navigate(page, '會員首頁');
  await expect(suggestion(page)).toContainText(choosePrimaryMessage);
  await checkConsole(page, choosePrimaryMessage, 'guilds');
  await suggestion(page).getByRole('button', { name: '設定主要公會', exact: true }).click();
  await expect(page.getByRole('heading', { name: '職業公會', level: 1, exact: true })).toBeVisible();
  // Leaving the only joined guild returns to an earlier state in this same login.
  card = memberCard();
  await navigate(page, '會員首頁');
  await expect(suggestion(page)).toContainText(noGuildMessage);
  await checkConsole(page, noGuildMessage, 'guilds');
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
  await expect(page.getByRole('navigation', { name: '常用入口', exact: true }).getByRole('button')).toHaveCount(4);
  mode = 'fail'; release();
  const alert = page.getByRole('alert').filter({ hasText: '名片暫時無法載入' });
  await expect(alert).toBeVisible();
  await expect(suggestion(page)).toHaveCount(0);
  await expect(summary).not.toContainText('尚未設定主要公會');
  await page.getByRole('button', { name: '展開訊息控制台', exact: true }).click();
  await page.getByRole('tab', { name: /^系統導覽/ }).click();
  await expect(page.locator('.game-console-entry[data-next-step="true"]')).toHaveCount(0);
  await page.getByRole('button', { name: '收合訊息控制台', exact: true }).click();
  await page.screenshot({ path: `${shots}/phone-read-failed.png`, fullPage: true });
  const baseline = requests;
  mode = 'pass';
  await alert.getByRole('button', { name: '重新載入名片', exact: true }).click();
  await expect(suggestion(page)).toContainText(choosePrimaryMessage);
  await expect(alert).toHaveCount(0);
  await expect(summary).toBeFocused();
  expect(requests).toBe(baseline + 1);
  await checkConsole(page, choosePrimaryMessage, 'guilds');
});

test('the home action stays compact, readable and reachable in all themes on desktop and phones', async ({ page }) => {
  test.setTimeout(90000);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 1440, height: 900 });
  await stubCard(page, memberCard({ primary_guild: guild, positioning_title: '測試探索者' }));
  await login(page);
  const prompt = suggestion(page);
  const button = prompt.getByRole('button', { name: '前往技能書架', exact: true });
  await expect(button).toBeVisible();
  for (const [theme, label] of [['light', '自由工坊－明亮'], ['dark', '自由工坊－夜航'], ['versefolk', '自由工坊－敘生']] as const) {
    await page.getByRole('button', { name: '設定', exact: true }).click();
    await page.getByRole('menuitemradio', { name: label, exact: true }).click();
    await page.getByRole('button', { name: '設定', exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(prompt.getByText(skillsMessage, { exact: true })).toBeVisible();
      await button.focus();
      await expect(button).toBeFocused();
      const box = await button.boundingBox();
      expect(box!.height, `${theme} ${width}px action height`).toBeGreaterThanOrEqual(44);
      expect(box!.width, `${theme} ${width}px action width`).toBeGreaterThanOrEqual(44);
      expect(await prompt.getByText(skillsMessage, { exact: true }).evaluate(element => parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(14);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${theme} ${width}px horizontal overflow`).toBe(true);
      await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
      await page.screenshot({ path: `${shots}/${theme}-${width}.png`, fullPage: true });
    }
  }
});
