import { test, expect, type Page } from './fixtures.js';
import { navigate } from './navigation.js';
import { communityCatalog } from '../../modules/community/catalog.js';

const names = ['測試平台公會', '測試影像與自動剪輯公會', '測試資安公會', '測試音樂公會', '測試活動與空間規劃公會', '測試光雕公會'];
const keys = names.map((_, index) => `synthetic-guild-${index}`);
const books = ['social-post', 'video-autopilot', 'security-scanner'].map(id => communityCatalog.skill_books.find(book => book.id === id)!);

type Preferences = { primary_guild_key: string; secondary_guild_keys: string[]; aggregate_version: number };
async function setupGuilds(page: Page) {
  let preferences: Preferences = { primary_guild_key: keys[0], secondary_guild_keys: [keys[1], keys[2]], aggregate_version: 7 };
  const writes: { body: unknown; headers: Record<string, string> }[] = [];
  let memberReads = 0, announcementReads = 0;
  const directory = () => names.map((name, index) => ({
    guild_key: keys[index], name, purpose: index === 1 ? '把很長的協作專業說明、不同人數的公會幹部與技能書排成一致的卡片。' : '交流專長，一起完成作品。',
    first_step: '閱讀入門技能', track_count: 1,
    is_primary: keys[index] === preferences.primary_guild_key,
    is_secondary: preferences.secondary_guild_keys.includes(keys[index]),
    secondary_position: preferences.secondary_guild_keys.indexOf(keys[index]) + 1,
    membership: index < 5 ? { membership_id: `membership-${index}`, state: 'active', aggregate_version: 1 } : null,
    guild_master: index === 5 ? null : { user_id: `master-${index}`, display_name: index === 1 ? '一位名字很長的影像自動剪輯公會長' : `測試會長 ${index}`, avatar_url: null },
    guild_experts: Array.from({ length: [0, 3, 1, 2, 3, 0][index] }, (_, expert) => ({ user_id: `expert-${index}-${expert}`, display_name: expert === 2 ? '專注跨領域音樂影像與內容共創的測試專家' : `測試專家 ${index}-${expert}`, avatar_url: null })),
    skill_books: index === 0 ? books : [books[index % books.length]],
  }));
  await page.route('**/api/v1/guilds/directory', route => route.fulfill({ json: { items: directory() } }));
  await page.route('**/api/v1/me/guild-preferences', route => route.fulfill({ json: preferences }));
  await page.route('**/api/v1/me/guild-preferences/secondary', route => {
    const body = route.request().postDataJSON();
    writes.push({ body, headers: route.request().headers() });
    preferences = { ...preferences, secondary_guild_keys: body.secondary_guild_keys, aggregate_version: preferences.aggregate_version + 1 };
    return route.fulfill({ json: preferences });
  });
  await page.route('**/api/v1/guild-applications', route => route.fulfill({ json: { items: [] } }));
  await page.route('**/api/v1/me/skill-books', route => route.fulfill({ json: { items: books.map(book => ({ book_id: book.id })) } }));
  await page.route('**/api/v1/me/github', route => route.fulfill({ json: { configured: false, connected: false, github_user: null } }));
  await page.route('**/api/v1/github/books/*/metrics', route => route.fulfill({ json: { book_id: route.request().url().split('/').at(-2), repository_url: null, stargazers_count: null, forks_count: null, open_issues_count: null, subscribers_count: null, pushed_at: null, language: null, archived: null, checked_at: null, stale: false, error: 'synthetic_unavailable' } }));
  await page.route('**/api/v1/members?*', route => { memberReads++; return route.fulfill({ json: { items: [], total: 0, next_offset: null } }); });
  await page.route('**/api/v1/guilds/*/announcements', route => {
    announcementReads++;
    return route.fulfill({ json: { items: [{ announcement_id: 'synthetic-announcement', title: '測試共創日', body: '帶一份可以公開的合成素材。', state: 'published', updated_at: '2026-09-23T00:00:00Z' }] } });
  });
  return { writes, directory, reads: () => ({ memberReads, announcementReads }) };
}
async function login(page: Page) {
  await page.goto('/');
  await page.getByLabel('電子郵件', { exact: true }).fill('maker@local.test');
  await page.getByLabel('密碼', { exact: true }).fill('freedom-local-demo');
  await page.getByRole('button', { name: '登入', exact: true }).click();
  await navigate(page, '職業公會');
}
const group = (page: Page, name: string) => page.getByRole('region', { name, exact: true });
const guildIds = (page: Page, name: string) => group(page, name).locator('.guild-card').evaluateAll(cards => cards.map(card => card.getAttribute('data-guild-key')));

test('six synthetic guilds partition featured, other joined and unjoined memberships with lazy detail dialogs', async ({ page }) => {
  const fixture = await setupGuilds(page); await login(page);
  await expect(group(page, '主要與次要公會').locator('.guild-card')).toHaveCount(3);
  await expect(group(page, '其他已加入公會').locator('.guild-card')).toHaveCount(2);
  await expect(group(page, '未加入公會').locator('.guild-card')).toHaveCount(1);
  expect(await guildIds(page, '主要與次要公會')).toEqual(keys.slice(0, 3));
  expect(await guildIds(page, '其他已加入公會')).toEqual(keys.slice(3, 5));
  expect(await guildIds(page, '未加入公會')).toEqual([keys[5]]);
  expect(await page.locator('.guild-card').evaluateAll(cards => cards.map(card => card.getAttribute('data-guild-key')))).toEqual(keys);
  expect(fixture.reads()).toEqual({ memberReads: 0, announcementReads: 0 });
  const primary = page.getByRole('article', { name: names[0], exact: true });
  await expect(primary.locator('.guild-book-list')).toContainText('入門技能');
  await expect(primary.locator('.guild-book-list .skill-intro-trigger')).toHaveCount(1);
  await expect(primary.locator('.guild-book-list').getByRole('button', { name: books[0].title, exact: true })).toBeVisible();
  await expect(primary.locator('.guild-book-list').getByRole('button', { name: books[1].title, exact: true })).toHaveCount(0);
  const openBooks = primary.getByRole('button', { name: '公會技能書庫 · 3', exact: true });
  const initialHeight = (await primary.boundingBox())!.height;
  await openBooks.click();
  const library = primary.getByRole('dialog', { name: `${names[0]}技能書庫`, exact: true });
  await expect(library).toBeVisible(); await expect(library.locator('.guild-library-entry')).toHaveCount(3);
  await library.getByRole('button', { name: books[1].title, exact: true }).click();
  const introduction = page.getByRole('dialog', { name: books[1].title, exact: true });
  await expect(introduction).toBeVisible(); await expect(introduction.getByRole('link', { name: '閱讀技能書 ↗', exact: true })).toBeVisible();
  await page.keyboard.press('Escape'); await expect(introduction).toBeHidden(); await expect(library).toBeVisible();
  await library.getByRole('button', { name: '關閉公會視窗', exact: true }).click();
  await expect(library).toBeHidden(); await expect(openBooks).toBeFocused();
  expect(Math.abs((await primary.boundingBox())!.height - initialHeight)).toBeLessThanOrEqual(2);
  await primary.getByRole('button', { name: '查看成員', exact: true }).click();
  const members = primary.getByRole('dialog', { name: `${names[0]}成員`, exact: true });
  await expect(members.getByRole('region', { name: `${names[0]}成員`, exact: true })).toContainText('目前沒有可顯示的公會成員。');
  await members.getByRole('button', { name: '關閉公會視窗', exact: true }).click();
  await primary.getByRole('button', { name: '公會公告', exact: true }).click();
  const announcements = primary.getByRole('dialog', { name: `${names[0]}公告`, exact: true });
  await expect(announcements.locator('.guild-announcements')).toHaveAttribute('open'); await expect(announcements).toContainText('帶一份可以公開的合成素材。');
  await announcements.getByRole('button', { name: '關閉公會視窗', exact: true }).click();
  expect(fixture.reads()).toEqual({ memberReads: 1, announcementReads: 1 });
  expect(Math.abs((await primary.boundingBox())!.height - initialHeight)).toBeLessThanOrEqual(2);
});

test('the secondary-guild editor sends a versioned command and reloads the synthetic saved preference without changing memberships', async ({ page }) => {
  const fixture = await setupGuilds(page); await login(page);
  const membershipsBefore = fixture.directory().map(guild => guild.membership);
  await page.getByRole('button', { name: '設定次要公會', exact: true }).click();
  const editor = page.locator('#secondary-guild-editor');
  await expect(editor.getByRole('checkbox')).toHaveCount(4);
  const choice = (index: number) => editor.getByRole('checkbox', { name: new RegExp(`^${names[index]}`) });
  await expect(choice(1)).toBeChecked(); await expect(choice(2)).toBeChecked();
  await expect(choice(3)).toBeDisabled(); await expect(choice(4)).toBeDisabled();
  await expect(editor.getByRole('checkbox', { name: names[0], exact: true })).toHaveCount(0);
  await expect(editor.getByRole('checkbox', { name: names[5], exact: true })).toHaveCount(0);
  await choice(2).uncheck(); await expect(choice(3)).toBeEnabled(); await choice(3).check();
  await expect(choice(2)).toBeDisabled(); await expect(choice(4)).toBeDisabled();
  await editor.getByRole('button', { name: '儲存次要公會', exact: true }).click();
  await expect(editor).toHaveCount(0); await expect(page.getByRole('region', { name: '公會目錄', exact: true }).getByRole('status')).toContainText('次要公會已儲存。');
  expect(fixture.writes).toHaveLength(1);
  expect(fixture.writes[0].body).toEqual({ secondary_guild_keys: [keys[1], keys[3]] });
  expect(fixture.writes[0].headers['if-match']).toBe('"7"');
  expect(fixture.writes[0].headers['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/);
  expect(fixture.writes[0].headers['x-csrf-token']).toBeTruthy();
  expect(await guildIds(page, '主要與次要公會')).toEqual([keys[0], keys[1], keys[3]]);
  expect(await guildIds(page, '其他已加入公會')).toEqual([keys[2], keys[4]]);
  await page.reload(); await expect(group(page, '主要與次要公會').locator('.guild-card')).toHaveCount(3);
  expect(await guildIds(page, '主要與次要公會')).toEqual([keys[0], keys[1], keys[3]]);
  expect(fixture.directory().map(guild => guild.membership)).toEqual(membershipsBefore);
  await page.getByRole('button', { name: '設定次要公會', exact: true }).click();
  await choice(1).uncheck(); await choice(3).uncheck();
  await editor.getByRole('button', { name: '儲存次要公會', exact: true }).click();
  await expect(editor).toHaveCount(0); await expect(group(page, '主要與次要公會').locator('.guild-card')).toHaveCount(1);
  await expect(group(page, '其他已加入公會').locator('.guild-card')).toHaveCount(4);
  expect(fixture.writes[1].body).toEqual({ secondary_guild_keys: [] });
  expect(fixture.writes[1].headers['if-match']).toBe('"8"');
  expect(fixture.writes[1].headers['idempotency-key']).not.toBe(fixture.writes[0].headers['idempotency-key']);
});

test('guild cards stay equal across all groups and keep every leader and expert readable at desktop and narrow phone widths', async ({ page }) => {
  const fixture = await setupGuilds(page); await login(page);
  const cards = page.locator('.guild-card'); await expect(cards).toHaveCount(6);
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 960 });
    // ResizeObserver may update the common intrinsic height on the next frame.
    await expect.poll(async () => cards.evaluateAll(nodes => {
      const heights = nodes.map(node => node.getBoundingClientRect().height); return Math.max(...heights) - Math.min(...heights);
    })).toBeLessThanOrEqual(2);
    for (const guild of fixture.directory()) {
      const card = page.locator(`.guild-card[data-guild-key="${guild.guild_key}"]`);
      const rows = card.locator('.guild-leadership-row'); await expect(rows).toHaveCount(1 + guild.guild_experts.length);
      await expect(rows.first()).toHaveClass(/guild-master/);
      for (const row of await rows.all()) {
        await expect(row).toBeVisible(); await expect(row.locator('.guild-leadership-avatar')).toBeVisible();
        const fits = await row.evaluate(node => {
          const box = node.getBoundingClientRect(), name = node.querySelector<HTMLElement>('.guild-leadership-name')!, role = node.querySelector('.guild-leadership-role')!.getBoundingClientRect();
          return name.scrollHeight <= name.clientHeight + 1 && name.getBoundingClientRect().right <= box.right + 1 && role.bottom <= box.bottom + 1;
        }); expect(fits).toBe(true);
      }
      expect(await card.evaluate(node => node.scrollWidth <= node.clientWidth + 1 && node.scrollHeight <= node.clientHeight + 1)).toBe(true);
      const bounds = await card.boundingBox(); expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width + 1);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await group(page, '主要與次要公會').scrollIntoViewIfNeeded();
    await page.screenshot({ path: `test-results/guild-partitions-${width}.png`, fullPage: true });
  }
});
