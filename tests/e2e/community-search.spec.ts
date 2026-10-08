import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { test, expect, type Browser, type Page } from './fixtures.js';
import { navigate } from './navigation.js';
import { DEMO_COMMUNITY, DEMO_PASSWORD, DEMO_USERS } from '../../packages/testing/seed.js';
import { communityCatalog } from '../../modules/community/catalog.js';

// SQL supplies synthetic fixtures; all sign-in, search, topic writes and navigation
// below use the actual HTTP app. The harness owns and drops the whole test schema.
async function person(db: Pool, community = DEMO_COMMUNITY) {
  const id = randomUUID(), email = `search-browser-${id}@local.test`;
  await db.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref,onboarding_required)
    SELECT $1,$2,$3,'搜尋瀏覽器會員',password_hash,$4,false FROM users WHERE user_id=$5`,
  [id, community, email, randomUUID(), DEMO_USERS[0].user_id]);
  return { id, email, community };
}
async function signedIn(browser: Browser, baseURL: string, email: string) {
  const context = await browser.newContext({ baseURL, viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.goto('/');
  await page.getByLabel('電子郵件', { exact: true }).fill(email);
  await page.getByLabel('密碼', { exact: true }).fill(DEMO_PASSWORD);
  await page.getByRole('button', { name: '登入', exact: true }).click();
  await expect(page.locator('.shell')).toBeVisible();
  return { context, page };
}
async function post(page: Page, path: string, body: unknown, expected = 201) {
  const session = await (await page.request.get('/api/v1/session')).json();
  const response = await page.request.post(`/api/v1${path}`, { data: body, headers: {
    Origin: new URL(page.url()).origin, 'X-CSRF-Token': session.csrf_token, 'Idempotency-Key': randomUUID(),
  } });
  expect(response.status(), await response.text()).toBe(expected);
  return response;
}
async function search(page: Page, query: string) {
  await navigate(page, '搜尋社群內容');
  await expect(page.getByRole('heading', { level: 1, name: '搜尋社群內容', exact: true })).toBeVisible();
  await page.getByRole('searchbox', { name: '關鍵字', exact: true }).fill(query);
  await expect(page.getByRole('region', { name: '社群內容搜尋結果' })).toHaveAttribute('aria-busy', 'false');
}
const results = (page: Page) => page.getByRole('region', { name: '社群內容搜尋結果' });

test('SEARCH-001 actual anonymous and member HTTP search keep public and same-community audiences separate', async ({ browser, page, baseURL, e2eAuthPool }) => {
  const token = `搜尋範圍${randomUUID().slice(0, 8)}`;
  const member = await person(e2eAuthPool);
  const foreignCommunity = randomUUID();
  await e2eAuthPool.query('INSERT INTO communities VALUES($1,$2)', [foreignCommunity, '搜尋外部合成社群']);
  const foreign = await person(e2eAuthPool, foreignCommunity);
  const event = randomUUID();
  await e2eAuthPool.query(`INSERT INTO community_events(event_id,community_id,organizer_ref,title,description,starts_at,ends_at,mode,location,state,visibility,event_kind)
    VALUES($1,$2,$3,$4,'公開摘要',now()+interval '1 day',now()+interval '2 days','online','私人位置','published','open','other')`,
  [event, DEMO_COMMUNITY, member.id, `${token}公開活動`]);
  await e2eAuthPool.query(`INSERT INTO community_social_posts(post_id,community_id,author_user_id,kind,url,platform,title,note,state)
    VALUES($1,$2,$3,'note',NULL,'other',$4,$4,'active')`, [randomUUID(), foreignCommunity, foreign.id, `${token}外社群貼文`]);
  const logged = await signedIn(browser, baseURL!, member.email);
  try {
    await post(logged.page, '/social-posts/notes', { text: `${token}會員貼文` });
    const site = await page.request.get('/api/v1/site');
    expect((await site.json()).community_search_enabled).toBe(true);
    await page.goto(`/#community-search?q=${encodeURIComponent(token)}`);
    await expect(results(page).getByRole('link', { name: `${token}公開活動`, exact: true })).toBeVisible();
    await expect(results(page).getByRole('link', { name: `${token}會員貼文`, exact: true })).toHaveCount(0);
    await expect(results(page)).not.toContainText('外社群貼文');
    await expect(page.getByRole('button', { name: '編輯我的內容主題', exact: true })).toHaveCount(0);
    expect(await results(page).innerText()).not.toContain('私人位置');
    await search(logged.page, token);
    await expect(results(logged.page).getByRole('link', { name: `${token}會員貼文`, exact: true })).toBeVisible();
    await expect(results(logged.page).getByRole('link', { name: `${token}公開活動`, exact: true })).toBeVisible();
    await expect(results(logged.page)).not.toContainText('外社群貼文');
  } finally { await logged.context.close(); }
});

test('SEARCH-002 real showcase links focus the existing card and browser back retains the query in light/dark layouts', async ({ browser, baseURL, e2eAuthPool }, testInfo) => {
  const member = await person(e2eAuthPool), title = `搜尋作品${randomUUID().slice(0, 8)}`;
  const logged = await signedIn(browser, baseURL!, member.email);
  try {
    const made = await (await post(logged.page, '/showcases', { title, description: '這是本人分享的合成作品摘要。', consent_to_share: true })).json();
    await search(logged.page, title);
    const link = results(logged.page).getByRole('link', { name: title, exact: true });
    await expect(link).toHaveAttribute('href', `#showcase/${made.showcase_id}`);
    for (const skin of ['light', 'dark'] as const) for (const width of [390, 1440]) {
      await logged.page.evaluate(value => {
        localStorage.setItem('freedom-theme', value);
        document.documentElement.dataset.theme = value;
        document.documentElement.dataset.experienceProfile = value;
        window.dispatchEvent(new Event('freedom-theme-changed'));
      }, skin);
      await logged.page.setViewportSize({ width, height: 900 });
      expect(await logged.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect(await logged.page.getByRole('searchbox', { name: '關鍵字', exact: true }).evaluate(node => parseFloat(getComputedStyle(node).fontSize))).toBeGreaterThanOrEqual(16);
      const controls = logged.page.locator('.community-content-search fieldset label');
      for (const control of await controls.all()) expect((await control.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      await logged.page.locator('.community-content-search').screenshot({ path: testInfo.outputPath(`search-${skin}-${width}.png`) });
    }
    await link.click();
    const card = logged.page.locator(`#showcase-${made.showcase_id}`);
    await expect(card).toBeVisible(); await expect(card).toBeFocused();
    await logged.page.goBack();
    await expect(logged.page.getByRole('searchbox', { name: '關鍵字', exact: true })).toHaveValue(title);
    await expect(results(logged.page).getByRole('link', { name: title, exact: true })).toBeVisible();
  } finally { await logged.context.close(); }
});

test('SEARCH-003 current full-guild maintainer saves topics through HTTP while an ordinary member cannot see or forge that editor', async ({ browser, baseURL, e2eAuthPool }) => {
  const maintainer = await person(e2eAuthPool), ordinary = await person(e2eAuthPool), admin = randomUUID();
  const occupied = new Set((await e2eAuthPool.query('SELECT book_id FROM skill_editorial_ownership')).rows.map(row => row.book_id));
  const book = communityCatalog.skill_books.find(item => !occupied.has(item.id));
  expect(book).toBeTruthy();
  await e2eAuthPool.query(`INSERT INTO positioning_profession_memberships(membership_id,community_id,user_id,guild_key,state,member_tier)
    VALUES($1,$2,$3,'guild_ai_vibe','active','full')`, [randomUUID(), DEMO_COMMUNITY, maintainer.id]);
  await e2eAuthPool.query('INSERT INTO platform_admins(admin_id,community_id,email,display_name) VALUES($1,$2,$3,$4)', [admin, DEMO_COMMUNITY, `search-admin-${admin}@local.test`, '合成管理員']);
  await e2eAuthPool.query('INSERT INTO skill_editorial_ownership(book_id,community_id) VALUES($1,$2)', [book!.id, DEMO_COMMUNITY]);
  await e2eAuthPool.query('INSERT INTO skill_book_maintainers(book_id,community_id,user_id,appointed_by,active) VALUES($1,$2,$3,$4,true)', [book!.id, DEMO_COMMUNITY, maintainer.id, admin]);
  const logged = await signedIn(browser, baseURL!, maintainer.email), denied = await signedIn(browser, baseURL!, ordinary.email);
  try {
    await search(logged.page, book!.title);
    await logged.page.getByRole('button', { name: '編輯我的內容主題', exact: true }).click();
    const editor = logged.page.locator('.community-content-search h3').filter({ hasText: book!.title }).locator('..');
    await expect(editor).toHaveCount(1);
    await editor.getByRole('checkbox', { name: '工具資源', exact: true }).check();
    const saved = logged.page.waitForResponse(response => response.url().endsWith('/api/v1/community-search/topics') && response.request().method() === 'POST');
    await editor.getByRole('button', { name: '儲存主題', exact: true }).click();
    expect((await saved).status()).toBe(200);
    await expect(logged.page.getByText('主題已儲存。', { exact: true })).toBeVisible();
    expect((await e2eAuthPool.query("SELECT topics,aggregate_version FROM community_content_topic_sets WHERE content_kind='skill_book' AND content_id=$1", [book!.id])).rows[0]).toMatchObject({ topics: ['tools'], aggregate_version: '1' });
    await search(denied.page, book!.title);
    await denied.page.getByRole('button', { name: '編輯我的內容主題', exact: true }).click();
    await expect(denied.page.getByText('目前沒有可編輯主題的內容。', { exact: true })).toBeVisible();
    await expect(denied.page.locator('.community-content-search h3').filter({ hasText: book!.title })).toHaveCount(0);
    await post(denied.page, '/community-search/topics', { kind: 'skill_book', id: book!.id, topics: ['help'] }, 403);
    await e2eAuthPool.query("UPDATE positioning_profession_memberships SET member_tier='intern' WHERE user_id=$1 AND guild_key='guild_ai_vibe'", [maintainer.id]);
    await logged.page.reload();
    await logged.page.getByRole('button', { name: '編輯我的內容主題', exact: true }).click();
    await expect(logged.page.getByText('目前沒有可編輯主題的內容。', { exact: true })).toBeVisible();
    await post(logged.page, '/community-search/topics', { kind: 'skill_book', id: book!.id, topics: ['help'] }, 403);
  } finally {
    await logged.context.close(); await denied.context.close();
    await e2eAuthPool.query("DELETE FROM community_content_topic_sets WHERE content_kind='skill_book' AND content_id=$1", [book!.id]);
    await e2eAuthPool.query('DELETE FROM skill_book_maintainers WHERE book_id=$1 AND user_id=$2', [book!.id, maintainer.id]);
    await e2eAuthPool.query('DELETE FROM skill_editorial_ownership WHERE book_id=$1 AND community_id=$2', [book!.id, DEMO_COMMUNITY]);
  }
});
