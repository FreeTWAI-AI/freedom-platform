import { mkdirSync } from 'node:fs';
import { test, expect, type Page } from './fixtures.js';

// Synthetic accounts and routes only; server rules are covered by the runtime suites.
const evidence = process.env.AUDIT_EVIDENCE_DIR ?? 'test-results/audit-identity-final';
mkdirSync(evidence, { recursive: true });
const viewports = [['desktop', { width: 1280, height: 900 }], ['mobile', { width: 390, height: 844 }]] as const;
const fits = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

async function login(page: Page) {
  await page.goto('/');
  await page.getByLabel('電子郵件', { exact: true }).fill('maker@local.test');
  await page.getByLabel('密碼', { exact: true }).fill('freedom-local-demo');
  await page.getByRole('button', { name: '登入', exact: true }).click();
  await expect(page.getByRole('button', { name: '登出', exact: true })).toBeVisible();
}

test.describe('skill shelf refresh without a shown baseline', () => {
  const unlockedTab = (page: Page) => page.getByRole('group', { name: '技能書範圍', exact: true }).getByRole('button').first();
  const newBooksNotice = (page: Page) => page.getByRole('status').filter({ hasText: /本新技能書/ });

  async function openSkills(page: Page, first: 'slow' | 'fail') {
    const calls: string[] = [];
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    await page.route('**/api/v1/me/github', route => route.fulfill({ json: { configured: false, connected: false, github_user: null } }));
    await page.route('**/api/v1/me/skill-books', async route => {
      calls.push(route.request().url());
      if (calls.length === 1) {
        if (first === 'fail') return route.fulfill({ status: 503, json: { detail: 'synthetic outage' } });
        await held;
        return route.fulfill({ json: { items: [{ book_id: 'agent-kit' }] } });
      }
      return route.fulfill({ json: { items: calls.length === 2 ? [{ book_id: 'agent-kit' }, { book_id: 'ai-sister' }] : [{ book_id: 'agent-kit' }, { book_id: 'ai-sister' }, { book_id: 'ai-avatar-bot' }] } });
    });
    await login(page);
    await page.goto('/#skills');
    await expect.poll(() => calls.length).toBe(1);
    return { calls, release };
  }

  test('a guild join while the first shelf is still loading shows the books without announcing them as new', async ({ page }) => {
    const { calls, release } = await openSkills(page, 'slow');
    await expect(page.getByText('正在載入解鎖紀錄…', { exact: true })).toBeVisible();
    // Same event the development dialog sends after a guild join.
    await page.evaluate(() => window.dispatchEvent(new Event('freedom-profile-updated')));
    await expect(unlockedTab(page)).toHaveText('已解鎖 · 2');
    await expect(newBooksNotice(page)).toHaveCount(0);
    release();
    await page.waitForTimeout(300);
    // The stale initial answer is ignored instead of replacing the newer shelf.
    await expect(unlockedTab(page)).toHaveText('已解鎖 · 2');
    await expect(newBooksNotice(page)).toHaveCount(0);

    // With a shelf on screen, a genuine new grant is still announced.
    await page.evaluate(() => window.dispatchEvent(new Event('freedom-profile-updated')));
    await expect(newBooksNotice(page)).toHaveText('已解鎖 1 本新技能書，可在「已解鎖」查看。');
    await expect(unlockedTab(page)).toHaveText('已解鎖 · 3');
    expect(calls).toHaveLength(3);
  });

  test('a refresh after a failed first load shows the books without announcing them as new', async ({ page }) => {
    await openSkills(page, 'fail');
    await expect(page.getByRole('alert')).toContainText('技能書解鎖紀錄暫時無法載入。');
    await page.evaluate(() => window.dispatchEvent(new Event('freedom-profile-updated')));
    await expect(unlockedTab(page)).toHaveText('已解鎖 · 2');
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(newBooksNotice(page)).toHaveCount(0);
  });
});

test.describe('guild leader drafts while skill editing needs an AI guild', () => {
  const guild = { guild_key: 'guild_synthetic_leader', name: '合成測試公會' };
  const recoveryText = '已被任命維護 1 本技能書，加入「AI 導入與驗證公會」或「AI 開發公會」即可編輯。';

  async function stub(page: Page) {
    const joins: string[] = [];
    await page.route('**/api/v1/me/github', route => route.fulfill({ json: { configured: false, connected: false, github_user: null } }));
    await page.route('**/api/v1/guild-workspace', route => route.fulfill({ json: {
      managed_guilds: [guild], managed_books: [], can_discuss: true,
      skill_editor_access: { appointed_books: 1, eligible: false, requires_development_guild: true, active_guilds: [], required_guilds: [{ guild_key: 'guild_ai_field', name: 'AI 導入與驗證公會' }, { guild_key: 'guild_ai_vibe', name: 'AI 開發公會' }] },
    } }));
    await page.route(`**/api/v1/guilds/${guild.guild_key}/announcements`, route => route.fulfill({ json: { items: [] } }));
    await page.route('**/api/v1/guild-council/threads', route => route.fulfill({ json: { items: [] } }));
    await page.route('**/api/v1/guilds/*/join', route => { joins.push(route.request().url()); return route.fulfill({ status: 418, json: { detail: 'unexpected join' } }); });
    await login(page);
    await page.goto('/#guild-workspace');
    await expect(page.getByRole('heading', { level: 1, name: '公會管理' })).toBeVisible();
    const root = page.locator('.guild-workspace');
    await expect(root.getByText(recoveryText, { exact: true })).toBeVisible();
    return { root, joins };
  }

  async function leaveInNewTab(page: Page, root: ReturnType<Page['locator']>, label: string) {
    const link = root.getByRole('link', { name: /職業公會/ });
    await expect(link).toHaveAttribute('href', '#guilds');
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', /noopener/);
    await expect(root.getByText(/編輯已暫停/)).toHaveCount(0);
    expect((await link.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    expect(await fits(page)).toBe(true);
    await page.screenshot({ path: `${evidence}/recovery-${label}.png`, fullPage: true });
    const popup = page.context().waitForEvent('page');
    await link.click();
    const guildPage = await popup;
    await expect(guildPage).toHaveURL(/#guilds$/);
    await guildPage.close();
    await expect(page).toHaveURL(/#guild-workspace$/);
  }

  test('an unsaved announcement survives the guild link', async ({ page }) => {
    const { root, joins } = await stub(page);
    await expect(root.getByRole('button', { name: '公會公告', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await root.getByRole('textbox', { name: '公告標題', exact: true }).fill('週五合成練習');
    await root.getByRole('textbox', { name: '公告內容', exact: true }).fill('還沒保存的公告內容');
    await leaveInNewTab(page, root, 'announcement');
    await expect(root.getByRole('textbox', { name: '公告標題', exact: true })).toHaveValue('週五合成練習');
    await expect(root.getByRole('textbox', { name: '公告內容', exact: true })).toHaveValue('還沒保存的公告內容');
    expect(joins).toEqual([]);
  });

  test('an unsaved council thread survives the guild link', async ({ page }) => {
    const { root, joins } = await stub(page);
    await root.getByRole('button', { name: '公會長議事區', exact: true }).click();
    await root.getByRole('textbox', { name: '討論標題', exact: true }).fill('合成議題');
    await root.getByRole('textbox', { name: '討論內容', exact: true }).fill('還沒送出的議事內容');
    await leaveInNewTab(page, root, 'council');
    await expect(root.getByRole('textbox', { name: '討論標題', exact: true })).toHaveValue('合成議題');
    await expect(root.getByRole('textbox', { name: '討論內容', exact: true })).toHaveValue('還沒送出的議事內容');
    expect(joins).toEqual([]);
  });
});

test.describe('onboarding skill shelf heading levels', () => {
  const password = 'freedom-workshop-member-2026';

  async function answerQuestions(page: Page) {
    await expect(page.getByRole('heading', { name: '你喜歡怎麼做事？' })).toBeVisible();
    for (const step of [0, 1]) {
      for (const field of await page.locator('.quiz-question').all()) await field.getByRole('radio').first().check();
      await page.getByRole('button', { name: '保存，繼續下一步 →', exact: true }).click();
      if (step === 0) await expect(page.getByRole('heading', { name: '遇到這些情境，你會怎麼做？' })).toBeVisible();
    }
    await expect(page.getByRole('heading', { name: '你從哪裡來，帶著哪些能力？' })).toBeVisible();
    await page.getByRole('button', { name: '保存，繼續下一步 →', exact: true }).click();
    await expect(page.getByRole('heading', { name: '你的裝備庫' })).toBeVisible();
    await page.getByRole('button', { name: '看看適合我的公會', exact: true }).click();
    const card = page.locator('.recommendation-card').first();
    await card.getByRole('checkbox').check(); await card.getByRole('radio').check();
    await page.getByRole('button', { name: '確認加入公會，領取技能書', exact: true }).click();
  }

  /** The shelf title sits one level below the completion heading and keeps the compact 16px card title. */
  async function checkShelf(page: Page, context: string, pageLevel: number) {
    const completion = page.getByRole('heading', { name: '你的第一段旅程，現在開始。', exact: true });
    await expect(completion).toBeVisible();
    expect(await completion.evaluate(element => element.tagName)).toBe(`H${pageLevel}`);
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
    const titles = page.locator('.skill-book-shelf .skill-library-copy > :is(h2, h3, h4, h5, h6)');
    expect(await titles.count()).toBeGreaterThan(0);
    expect(await titles.evaluateAll(elements => elements.map(element => element.tagName))).toEqual(Array(await titles.count()).fill(`H${pageLevel + 1}`));
    await expect(page.locator('.skill-book-shelf').getByRole('heading', { level: pageLevel + 1 })).toHaveCount(await titles.count());
    for (const [viewport, size] of viewports) {
      await page.setViewportSize(size);
      const styles = await titles.evaluateAll(elements => elements.map(element => { const style = getComputedStyle(element); return { fontSize: style.fontSize, lineHeight: style.lineHeight, fontWeight: style.fontWeight, margin: style.margin }; }));
      for (const style of styles) expect(style, `${context} ${viewport}`).toEqual({ fontSize: '16px', lineHeight: '23.2px', fontWeight: '700', margin: '0px' });
      expect(await fits(page)).toBe(true);
      await page.screenshot({ path: `${evidence}/onboarding-shelf-${context}-${viewport}.png`, fullPage: true });
    }
    await page.setViewportSize(viewports[0][1]);
  }

  test('first positioning and re-exploration keep the shelf under the completion heading at the same size', async ({ page }) => {
    test.setTimeout(120000);
    await page.goto('/');
    await page.getByRole('button', { name: '建立帳號', exact: true }).click();
    await page.getByLabel('社群顯示名稱', { exact: true }).fill('書架標題夥伴');
    await page.getByLabel('電子郵件', { exact: true }).fill(`shelf-${Date.now()}-${Math.random().toString(16).slice(2)}@example.test`);
    await page.getByLabel('密碼', { exact: true }).fill(password);
    await page.getByRole('button', { name: '註冊並開始定位', exact: true }).click();
    await answerQuestions(page);
    await checkShelf(page, 'first', 1);
    await page.getByRole('button', { name: '進入自由工坊 →', exact: true }).click();
    await expect(page.locator('.shell')).toBeVisible();

    await page.goto('/#positioning');
    await page.getByRole('button', { name: '重新探索定位', exact: true }).click();
    await answerQuestions(page);
    await checkShelf(page, 'retake', 2);
  });
});
