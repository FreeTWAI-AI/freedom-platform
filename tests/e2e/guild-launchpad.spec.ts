import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import {test, expect, type Browser, type Page} from './fixtures.js';
import {navigate} from './navigation.js';
import {DEMO_COMMUNITY, DEMO_PASSWORD} from '../../packages/testing/seed.js';
import {hashPassword} from '../../modules/identity-membership/service.js';

const music = 'guild_music_mv';
const space = 'guild_event_space';

async function seed(db: Pool) {
  const run = randomUUID().slice(0, 8);
  const userId = randomUUID();
  const email = `launchpad-${run}@example.invalid`;
  const names = await db.query('SELECT guild_key, name FROM positioning_guild_catalog WHERE guild_key=ANY($1::text[])', [[music, space]]);
  const nameOf = (key: string) => names.rows.find(row => row.guild_key === key).name as string;
  const previous = await db.query('SELECT user_id FROM positioning_guild_officers WHERE community_id=$1 AND guild_key=$2', [DEMO_COMMUNITY, music]);
  await db.query(`INSERT INTO users(user_id, community_id, email, display_name, password_hash, profession_membership_ref, onboarding_required)
    VALUES($1,$2,$3,$4,$5,$6,false)`, [userId, DEMO_COMMUNITY, email, `啟動台會員 ${run}`, hashPassword(DEMO_PASSWORD), randomUUID()]);
  for (const key of [music, space]) {
    await db.query(`INSERT INTO positioning_profession_memberships(membership_id, community_id, user_id, guild_key, state, member_tier)
      VALUES($1,$2,$3,$4,'active','full')`, [randomUUID(), DEMO_COMMUNITY, userId, key]);
  }
  await db.query(`INSERT INTO guild_member_preferences(community_id, user_id, primary_guild_key) VALUES($1,$2,$3)`, [DEMO_COMMUNITY, userId, space]);
  await db.query(`INSERT INTO positioning_guild_officers(community_id, guild_key, user_id) VALUES($1,$2,$3)
    ON CONFLICT (community_id, guild_key) DO UPDATE SET user_id=$3`, [DEMO_COMMUNITY, music, userId]);
  return {userId, email, musicName: nameOf(music), spaceName: nameOf(space), previousOfficer: previous.rows[0]?.user_id as string | undefined};
}
async function cleanup(db: Pool, userId: string, previousOfficer: string | undefined) {
  await db.query('DELETE FROM guild_launchpad_delegations WHERE community_id=$1 AND guild_key=$2', [DEMO_COMMUNITY, music]);
  await db.query('DELETE FROM command_receipts WHERE user_id=$1', [userId]);
  await db.query('DELETE FROM outbox WHERE transition_id IN (SELECT transition_id FROM transition_journal WHERE actor_ref=$1)', [userId]);
  await db.query('DELETE FROM transition_journal WHERE actor_ref=$1', [userId]);
  await db.query('DELETE FROM guild_member_preferences WHERE community_id=$1 AND user_id=$2', [DEMO_COMMUNITY, userId]);
  await db.query('DELETE FROM positioning_profession_memberships WHERE community_id=$1 AND user_id=$2', [DEMO_COMMUNITY, userId]);
  await db.query('DELETE FROM member_skill_book_grants WHERE community_id=$1 AND user_id=$2', [DEMO_COMMUNITY, userId]);
  await db.query('DELETE FROM sessions WHERE user_id=$1', [userId]);
  if (previousOfficer) await db.query('UPDATE positioning_guild_officers SET user_id=$3 WHERE community_id=$1 AND guild_key=$2', [DEMO_COMMUNITY, music, previousOfficer]);
  else await db.query('DELETE FROM positioning_guild_officers WHERE community_id=$1 AND guild_key=$2 AND user_id=$3', [DEMO_COMMUNITY, music, userId]);
  await db.query('DELETE FROM users WHERE user_id=$1', [userId]).catch(() => undefined);
}
async function login(browser: Browser, baseURL: string, email: string) {
  const context = await browser.newContext({baseURL, viewport: {width: 1280, height: 900}});
  await context.route(url => !['127.0.0.1', 'localhost'].includes(url.hostname), route => route.abort());
  const page = await context.newPage();
  await page.goto('/');
  await page.getByLabel('電子郵件', {exact: true}).fill(email);
  await page.getByLabel('密碼', {exact: true}).fill(DEMO_PASSWORD);
  await page.getByRole('button', {name: '登入', exact: true}).click();
  await expect(page.getByRole('button', {name: '設定', exact: true})).toBeVisible();
  return {context, page};
}
async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}
async function tallEnough(page: Page) {
  const heights = await page.locator('.guild-launchpad .checkbox-row:visible, .guild-launchpad button:visible, .guild-launchpad input:not([type=checkbox]):visible, .guild-launchpad select:visible').evaluateAll(elements => elements.map(element => element.getBoundingClientRect().height));
  expect(heights.length).toBeGreaterThan(0);
  expect(Math.min(...heights)).toBeGreaterThanOrEqual(44);
}

test('a visitor can read a guild launchpad without a session', async ({browser, baseURL, e2eAuthPool}) => {
  test.setTimeout(120_000);
  const names = await e2eAuthPool.query('SELECT name FROM positioning_guild_catalog WHERE guild_key=$1', [music]);
  const context = await browser.newContext({baseURL, viewport: {width: 360, height: 800}});
  await context.route(url => !['127.0.0.1', 'localhost'].includes(url.hostname), route => route.abort());
  const page = await context.newPage();
  try {
    await page.goto(`/#guilds/${music}`);
    await expect(page.getByRole('heading', {level: 1, name: names.rows[0].name as string})).toBeVisible();
    await expect(page.getByRole('button', {name: '會員登入', exact: true})).toBeVisible();
    await expect(page.getByText('登入並加入公會後，可以在這裡看到自己的工作。業務空間尚未在此環境啟用。')).toBeVisible();
    await expect(page.getByRole('button', {name: '儲存草稿', exact: true})).toHaveCount(0);
    await noOverflow(page);
  } finally { await context.close(); }
});

test('a late response from guild A never renders inside guild B', async ({browser, baseURL, e2eAuthPool}) => {
  test.setTimeout(180_000);
  const fixture = await seed(e2eAuthPool);
  const session = await login(browser, baseURL!, fixture.email);
  let seen = false;
  let release: () => void = () => undefined;
  const delivered = new Promise<void>(resolve => { release = resolve; });
  await session.page.route('**/api/v1/guilds/guild_event_space/launchpad', async route => {
    if (route.request().method() !== 'GET') return route.continue();
    seen = true;
    try {
      await new Promise(resolve => setTimeout(resolve, 800));
      const response = await route.fetch();
      const json = await response.json();
      json.guild.name = 'LAUNCHPAD_A_MARKER';
      await route.fulfill({status: response.status(), contentType: 'application/json', json});
    } finally { release(); }
  });
  try {
    await session.page.evaluate(() => { window.location.hash = 'guilds/guild_event_space'; });
    await expect.poll(() => seen).toBe(true);
    await session.page.evaluate(() => { window.location.hash = 'guilds/guild_music_mv'; });
    await expect(session.page.getByRole('heading', {level: 1, name: fixture.musicName})).toBeVisible();
    await delivered;
    await expect(session.page.getByText('LAUNCHPAD_A_MARKER')).toHaveCount(0);
    await expect(session.page.getByRole('heading', {level: 1})).toHaveText(fixture.musicName);
  } finally { await session.context.close(); await cleanup(e2eAuthPool, fixture.userId, fixture.previousOfficer); }
});

test('a non-primary guild leader edits, publishes, and reverts the launchpad', async ({browser, baseURL, e2eAuthPool}) => {
  test.setTimeout(180_000);
  const fixture = await seed(e2eAuthPool);
  const session = await login(browser, baseURL!, fixture.email);
  const first = `使命甲 ${randomUUID().slice(0, 8)}`;
  const second = `使命乙 ${randomUUID().slice(0, 8)}`;
  try {
    await navigate(session.page, '職業公會');
    await session.page.setViewportSize({width: 360, height: 800});
    const card = session.page.getByRole('article', {name: fixture.musicName, exact: true});
    await card.scrollIntoViewIfNeeded();
    const open = card.getByRole('button', {name: '啟動台', exact: true});
    await expect(open).toBeVisible();
    expect(await open.evaluate(element => element.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
    await noOverflow(session.page);
    await session.page.setViewportSize({width: 1280, height: 900});
    await open.click();
    await expect(session.page.getByRole('heading', {level: 1, name: fixture.musicName})).toBeVisible();
    await expect(session.page.getByRole('button', {name: '儲存草稿', exact: true})).toHaveClass(/btn-ghost/);
    await expect(session.page.getByRole('button', {name: '發布', exact: true})).toHaveClass(/btn-primary/);
    await session.page.locator('#launchpad-support-url').fill('http://example.com/help');
    await session.page.getByRole('button', {name: '儲存草稿', exact: true}).click();
    const urlError = session.page.locator('#launchpad-support-url-error');
    await expect(urlError).toHaveText('只接受 https:// 開頭、不含帳號密碼的網址');
    await expect(session.page.locator('#launchpad-support-url')).toHaveAttribute('aria-describedby', /launchpad-support-url-error/);
    await expect(session.page.getByText('unsupported_url')).toHaveCount(0);
    await expect(session.page.getByText('blocks.')).toHaveCount(0);
    await session.page.locator('#launchpad-support-url').fill('');
    await session.page.locator('#launchpad-mission').fill(first);
    await session.page.getByRole('button', {name: '上移公告', exact: true}).click();
    await expect(session.page.getByRole('heading', {level: 2}).first()).toHaveText('公告');
    await session.page.getByRole('button', {name: '預覽公開', exact: true}).click();
    const preview = session.page.getByRole('dialog');
    await expect(preview.getByRole('heading', {name: '合成預覽'})).toBeVisible();
    await expect(preview.getByText('合成資料')).toBeVisible();
    await preview.getByRole('button', {name: '關閉', exact: true}).click();
    await session.page.getByRole('button', {name: '儲存草稿', exact: true}).click();
    await expect(session.page.getByText(/已儲存草稿版本/)).toBeVisible();
    await session.page.getByRole('button', {name: '發布', exact: true}).click();
    await session.page.getByRole('button', {name: '確認發布', exact: true}).click();
    const published = session.page.getByText(/已發布版本 \d+/);
    await expect(published).toBeVisible();
    const revision = /已發布版本 (\d+)/.exec(await published.innerText())?.[1];
    expect(revision).toBeTruthy();
    await expect(session.page.getByText(first).first()).toBeVisible();
    await session.page.locator('#launchpad-mission').fill(second);
    await session.page.getByRole('button', {name: '儲存草稿', exact: true}).click();
    await expect(session.page.getByText(/已儲存草稿版本/)).toBeVisible();
    await session.page.getByRole('button', {name: '發布', exact: true}).click();
    await session.page.getByRole('button', {name: '確認發布', exact: true}).click();
    await expect(session.page.getByText(second).first()).toBeVisible();
    await session.page.getByRole('listitem').filter({hasText: `版本 ${revision}`}).getByRole('button', {name: '回復到此版本', exact: true}).click();
    await session.page.getByRole('dialog').getByLabel('回復原因').fill('回復這次測試的第一個發布');
    await session.page.getByRole('button', {name: '確認回復', exact: true}).click();
    await expect(session.page.getByText(/已發布版本 \d+/)).toBeVisible();
    await expect(session.page.locator('#launchpad-mission')).toHaveValue(first);
    await expect(session.page.getByText(first).first()).toBeVisible();
    await session.page.setViewportSize({width: 360, height: 800});
    await noOverflow(session.page);
    await tallEnough(session.page);
  } finally { await session.context.close(); await cleanup(e2eAuthPool, fixture.userId, fixture.previousOfficer); }
});

test('a member who left can rejoin from the launchpad', async ({browser, baseURL, e2eAuthPool}) => {
  test.setTimeout(120_000);
  const run = randomUUID().slice(0, 8);
  const userId = randomUUID();
  const email = `launchpad-rejoin-${run}@example.invalid`;
  const names = await e2eAuthPool.query('SELECT name FROM positioning_guild_catalog WHERE guild_key=$1', [music]);
  const musicName = names.rows[0].name as string;
  await e2eAuthPool.query(`INSERT INTO users(user_id, community_id, email, display_name, password_hash, profession_membership_ref, onboarding_required)
    VALUES($1,$2,$3,$4,$5,$6,false)`, [userId, DEMO_COMMUNITY, email, `再加入會員 ${run}`, hashPassword(DEMO_PASSWORD), randomUUID()]);
  await e2eAuthPool.query(`INSERT INTO positioning_profession_memberships(membership_id, community_id, user_id, guild_key, state, member_tier)
    VALUES($1,$2,$3,$4,'active','full')`, [randomUUID(), DEMO_COMMUNITY, userId, space]);
  await e2eAuthPool.query(`INSERT INTO positioning_profession_memberships(membership_id, community_id, user_id, guild_key, state, member_tier, aggregate_version)
    VALUES($1,$2,$3,$4,'left','full',4)`, [randomUUID(), DEMO_COMMUNITY, userId, music]);
  await e2eAuthPool.query(`INSERT INTO guild_member_preferences(community_id, user_id, primary_guild_key) VALUES($1,$2,$3)`, [DEMO_COMMUNITY, userId, space]);
  const session = await login(browser, baseURL!, email);
  let ifMatch = '';
  await session.page.route('**/api/v1/guilds/guild_music_mv/join', async route => {
    ifMatch = route.request().headers()['if-match'] ?? '';
    await route.continue();
  });
  try {
    await session.page.goto(`/#guilds/${music}`);
    await session.page.getByRole('button', {name: `加入${musicName}`, exact: true}).click();
    await expect(session.page.getByText('成員身分：實習成員')).toBeVisible();
    expect(ifMatch).toBe('"4"');
  } finally { await session.context.close(); await cleanup(e2eAuthPool, userId, undefined); }
});
