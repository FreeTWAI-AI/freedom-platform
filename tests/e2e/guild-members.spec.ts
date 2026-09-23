import { test, expect, type Page } from './fixtures.js';
import { randomUUID } from 'node:crypto';
import { DEMO_COMMUNITY, DEMO_USERS } from '../../packages/testing/seed.js';

const guilds = [
  { guild_key: 'guild_event_space', name: '活動與空間公會', guild_master: { user_id: 'member-0', display_name: '同名夥伴' }, guild_experts: [{user_id:'member-0',display_name:'同名夥伴'},{user_id:'member-2',display_name:'活動夥伴 2'}] },
  { guild_key: 'guild_security', name: '資安公會', guild_master: null },
].map(guild => ({ ...guild, purpose: '一起分享專業與合作', first_step: '認識公會夥伴', track_count: 1, is_primary: false, skill_books: [], membership: null }));
function member(index: number, nickname = `活動夥伴 ${index}`) {
  return { user_id: `member-${index}`, nickname, positioning_title: '活動協作者', primary_guild: { guild_key: guilds[0].guild_key, name: guilds[0].name }, secondary_guilds: [], capabilities: ['python'], equipment: [], contacts: {}, is_self: false, friendship: { state: 'none' }, joined_at: '2026-09-23T00:00:00Z' };
}
async function login(page: Page) {
  await page.goto('/');
  await page.getByLabel('電子郵件', { exact: true }).fill('maker@local.test');
  await page.getByLabel('密碼', { exact: true }).fill('freedom-local-demo');
  await page.getByRole('button', { name: '登入', exact: true }).click();
  await page.getByRole('button', { name: '職業公會', exact: true }).click();
}
async function fixtureGuilds(page: Page) {
  await page.route('**/api/v1/guilds/directory', route => route.fulfill({ json: { items: guilds } }));
  await page.route('**/api/v1/me/guild-preferences', route => route.fulfill({ json: { primary_guild_key: null } }));
  await page.route('**/api/v1/me/skill-books', route => route.fulfill({ json: { items: [] } }));
  await page.route('**/api/v1/guild-applications', route => route.fulfill({ json: { items: [] } }));
  await page.route('**/api/v1/members/*/social-links?*', route => route.fulfill({ json: { items: [], total: 0, next_offset: null } }));
}

test('guild member lists load on demand, preserve guild filtering across pages and identify the leader by ID', async ({ page }) => {
  await fixtureGuilds(page); const queries: URLSearchParams[] = [];
  await page.route('**/api/v1/members?*', route => {
    const query = new URL(route.request().url()).searchParams; queries.push(query);
    if (query.get('guild_key') === 'guild_security') return route.fulfill({ json: { items: [], total: 0, next_offset: null } });
    if (query.get('search')) return route.fulfill({ json: { items: [member(11, '剪輯活動夥伴')], total: 1, next_offset: null } });
    return route.fulfill({ json: { items: query.get('offset') === '10' ? [member(10)] : Array.from({ length: 10 }, (_, index) => member(index, index < 2 ? '同名夥伴' : undefined)), total: 11, next_offset: query.get('offset') === '10' ? null : 10 } });
  });
  await login(page); const card = page.getByRole('article', { name: '活動與空間公會', exact: true });
  await expect(card.getByRole('button', { name: '查看成員', exact: true })).toBeVisible(); expect(queries).toHaveLength(0);
  await card.getByRole('button', { name: '查看成員', exact: true }).click();
  const panel = card.getByRole('region', { name: '活動與空間公會成員', exact: true });
  await expect(panel.locator('.directory-member')).toHaveCount(10); await expect(panel).toContainText('顯示 10 / 11 位成員');
  expect(queries[0].get('guild_key')).toBe('guild_event_space'); expect(queries[0].get('sort')).toBe('nickname');
  await expect(panel.locator('[data-member-id="member-0"] .guild-member-leader')).toHaveText('公會長');
  await expect(panel.locator('[data-member-id="member-1"] .guild-member-leader')).toHaveCount(0);
  await expect(card.locator('.guild-experts')).toContainText('同名夥伴');await expect(card.locator('.guild-experts')).toContainText('活動夥伴 2');
  await expect(panel.locator('[data-member-id="member-0"] .guild-member-expert')).toHaveText('公會專家');await expect(panel.locator('[data-member-id="member-2"] .guild-member-expert')).toHaveText('公會專家');await expect(panel.locator('[data-member-id="member-1"] .guild-member-expert')).toHaveCount(0);
  await page.setViewportSize({width:1440,height:960});await panel.scrollIntoViewIfNeeded();await page.screenshot({path:'test-results/guild-experts-desktop.png'});
  await page.setViewportSize({width:320,height:844});await panel.scrollIntoViewIfNeeded();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:'test-results/guild-experts-phone.png'});await page.setViewportSize({width:1280,height:720});
  await panel.getByRole('button', { name: '查看更多成員', exact: true }).click();
  await expect(panel.locator('.directory-member')).toHaveCount(11); expect(queries.at(-1)?.get('guild_key')).toBe('guild_event_space'); expect(queries.at(-1)?.get('offset')).toBe('10');
  await panel.getByRole('searchbox', { name: '搜尋公會成員', exact: true }).fill('剪輯');
  await panel.getByRole('combobox', { name: '成員排序', exact: true }).selectOption('newest');
  await panel.getByRole('button', { name: '搜尋成員', exact: true }).click();
  await expect(panel.locator('.directory-member')).toHaveCount(1); await expect(panel).toContainText('剪輯活動夥伴');
  expect(queries.at(-1)?.get('guild_key')).toBe('guild_event_space'); expect(queries.at(-1)?.get('sort')).toBe('newest'); expect(queries.at(-1)?.get('offset')).toBe('0');
  await page.getByRole('article', { name: '資安公會', exact: true }).getByRole('button', { name: '查看成員', exact: true }).click();
  await expect(panel).toHaveCount(0); await expect(page.getByRole('region', { name: '資安公會成員', exact: true })).toContainText('目前沒有可顯示的公會成員。');
  expect(queries.at(-1)?.get('guild_key')).toBe('guild_security'); expect(queries.at(-1)?.has('search')).toBe(false);
});

test('closing a pending guild list prevents its response from leaking into another guild or a reopened list', async ({ page }) => {
  await fixtureGuilds(page); let release!: () => void, started!: () => void, visits = 0;
  const pending = new Promise<void>(resolve => { release = resolve; }), requested = new Promise<void>(resolve => { started = resolve; });
  await page.route('**/api/v1/members?*', async route => {
    const guild = new URL(route.request().url()).searchParams.get('guild_key');
    if (guild === 'guild_event_space' && visits++ === 0) { started(); await pending; return route.fulfill({ json: { items: [member(0, '已過期的活動回應')], total: 1, next_offset: null } }); }
    return route.fulfill({ json: { items: [member(2, guild === 'guild_security' ? '目前資安成員' : '重新讀取的活動成員')], total: 1, next_offset: null } });
  });
  await login(page); const first = page.getByRole('article', { name: '活動與空間公會', exact: true }), second = page.getByRole('article', { name: '資安公會', exact: true });
  await first.getByRole('button', { name: '查看成員', exact: true }).click(); await requested;
  await first.getByRole('button', { name: '收起成員', exact: true }).click();
  await second.getByRole('button', { name: '查看成員', exact: true }).click(); await expect(second).toContainText('目前資安成員');
  const delivered = page.waitForResponse(response => response.url().includes('/api/v1/members?') && new URL(response.url()).searchParams.get('guild_key') === 'guild_event_space');
  release(); await delivered; await expect(page.getByText('已過期的活動回應', { exact: true })).toHaveCount(0);
  await first.getByRole('button', { name: '查看成員', exact: true }).click(); await expect(first).toContainText('重新讀取的活動成員');
  await expect(second.getByRole('region')).toHaveCount(0); expect(visits).toBe(2);
});

test('guild list distinguishes empty/error states and compact details fit a narrow phone', async ({ page }) => {
  await fixtureGuilds(page); let unavailable = true;
  await page.route('**/api/v1/members?*', route => {
    const query = new URL(route.request().url()).searchParams;
    if (unavailable) return route.fulfill({ status: 503, json: { detail: '成員清單暫時無法讀取。' } });
    return route.fulfill({ json: { items: query.has('search') ? [] : [{ ...member(0, '一位很長名字的活動與空間協作夥伴'), contacts: { discord: 'allowed-contact-only' } }], total: query.has('search') ? 0 : 1, next_offset: null } });
  });
  await login(page); const card = page.getByRole('article', { name: '活動與空間公會', exact: true }); await card.getByRole('button', { name: '查看成員', exact: true }).click();
  const panel = card.getByRole('region', { name: '活動與空間公會成員', exact: true });
  await expect(panel.getByRole('alert')).toContainText('服務暫時無法回應（503）。請稍後重試。'); await expect(panel.getByText('目前沒有可顯示的公會成員。', { exact: true })).toHaveCount(0);
  unavailable = false; await panel.getByRole('button', { name: '重新載入成員', exact: true }).click();
  await expect(panel.locator('.directory-member')).toHaveCount(1); await expect(panel.getByText('allowed-contact-only', { exact: true })).not.toBeVisible();
  await panel.locator('.directory-member-details > summary').click(); await expect(panel.getByText('allowed-contact-only', { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 320, height: 844 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await panel.getByRole('searchbox', { name: '搜尋公會成員', exact: true }).fill('沒有這位成員'); await expect(panel).toContainText('沒有符合的公會成員。');
  await card.getByRole('button', { name: '收起成員', exact: true }).click(); await card.getByRole('button', { name: '查看成員', exact: true }).click();
  await expect(panel.getByRole('searchbox', { name: '搜尋公會成員', exact: true })).toHaveValue(''); await expect(panel.locator('.directory-member')).toHaveCount(1);
});

test('guild browsing uses the real membership filter and exposes only permitted contact fields', async ({ page, e2eAuthPool: pool }) => {
  const ids = [randomUUID(), randomUUID(), randomUUID()], names = ['Browser 公會長', 'Browser 活動夥伴', 'Browser 其他公會'], guild = 'guild_event_space';
  const previous = (await pool.query('SELECT * FROM positioning_guild_officers WHERE community_id=$1 AND guild_key=$2', [DEMO_COMMUNITY, guild])).rows[0];
  try {
    for (let i = 0; i < ids.length; i++) {
      await pool.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref) SELECT $1,$2,$3,$4,password_hash,$5 FROM users WHERE user_id=$6`, [ids[i], DEMO_COMMUNITY, ids[i] + '@example.invalid', names[i], randomUUID(), DEMO_USERS[0].user_id]);
      const key = i < 2 ? guild : 'guild_security';
      await pool.query(`INSERT INTO positioning_profession_memberships(membership_id,community_id,user_id,guild_key,state) VALUES($1,$2,$3,$4,'active')`, [randomUUID(), DEMO_COMMUNITY, ids[i], key]);
      await pool.query('INSERT INTO guild_member_preferences(community_id,user_id,primary_guild_key) VALUES($1,$2,$3)', [DEMO_COMMUNITY, ids[i], key]);
    }
    await pool.query(`INSERT INTO member_accounts(user_id,community_id,contacts) VALUES($1,$2,$3)`, [ids[1], DEMO_COMMUNITY, JSON.stringify({ email: { audiences: [] }, discord: { value: 'browser-visible-discord', audiences: ['public'] }, github: { value: 'browser-private-github', audiences: [] }, line: { value: '', audiences: [] } })]);
    await pool.query('INSERT INTO positioning_guild_officers(community_id,guild_key,user_id) VALUES($1,$2,$3) ON CONFLICT(community_id,guild_key) DO UPDATE SET user_id=$3', [DEMO_COMMUNITY, guild, ids[0]]);
    await login(page); const card = page.getByRole('article', { name: '活動與空間公會', exact: true });
    await card.getByRole('button', { name: '查看成員', exact: true }).click(); const panel = card.getByRole('region', { name: '活動與空間公會成員', exact: true });
    await panel.getByRole('searchbox', { name: '搜尋公會成員', exact: true }).fill('Browser');
    await expect(panel.locator('.directory-member')).toHaveCount(2); await expect(panel).not.toContainText(names[2]);
    await expect(panel.locator(`[data-member-id="${ids[0]}"] .guild-member-leader`)).toHaveText('公會長');
    const row = panel.locator(`[data-member-id="${ids[1]}"]`); await row.locator('.directory-member-details > summary').click();
    await expect(row).toContainText('browser-visible-discord'); await expect(row).not.toContainText('browser-private-github'); await expect(row).not.toContainText(ids[1] + '@example.invalid');
    const response = await page.request.get(`/api/v1/members?guild_key=${guild}&search=Browser&sort=nickname&limit=10&offset=0`), data = await response.json();
    expect(response.status()).toBe(200); expect(data.total).toBe(2); expect(data.items.map((item: any) => item.user_id).sort()).toEqual(ids.slice(0, 2).sort());
    expect(data.items.find((item: any) => item.user_id === ids[1]).contacts).toEqual({ discord: 'browser-visible-discord' });
  } finally {
    if (previous) await pool.query('UPDATE positioning_guild_officers SET user_id=$3 WHERE community_id=$1 AND guild_key=$2', [DEMO_COMMUNITY, guild, previous.user_id]);
    else await pool.query('DELETE FROM positioning_guild_officers WHERE community_id=$1 AND guild_key=$2', [DEMO_COMMUNITY, guild]);
    await pool.query('DELETE FROM member_accounts WHERE user_id=ANY($1::uuid[])', [ids]);
    await pool.query('DELETE FROM guild_member_preferences WHERE user_id=ANY($1::uuid[])', [ids]);
    await pool.query('DELETE FROM positioning_profession_memberships WHERE user_id=ANY($1::uuid[])', [ids]);
    await pool.query('DELETE FROM users WHERE user_id=ANY($1::uuid[])', [ids]);
  }
});
