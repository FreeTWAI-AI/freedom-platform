import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import {test, expect, type Browser, type Page} from './fixtures.js';
import {navigate} from './navigation.js';
import {DEMO_PASSWORD} from '../../packages/testing/seed.js';
import {hashPassword} from '../../modules/identity-membership/service.js';

const keys = {
  talent: 'guild_talent_direction',
  partnership: 'guild_opportunity_partnership',
  vibe: 'guild_ai_vibe',
} as const;

async function names(db: Pool) {
  const rows = (await db.query(`SELECT guild_key, name FROM positioning_guild_catalog WHERE guild_key = ANY($1::text[])`, [Object.values(keys)])).rows as {guild_key: string; name: string}[];
  const byKey = new Map(rows.map(row => [row.guild_key, row.name]));
  return {talent: byKey.get(keys.talent)!, partnership: byKey.get(keys.partnership)!, vibe: byKey.get(keys.vibe)!};
}
async function cleanup(db: Pool, userId: string, communityId: string) {
  await db.query(`DELETE FROM outbox WHERE transition_id IN (SELECT transition_id FROM transition_journal WHERE actor_ref = $1 OR community_id = $2)`, [userId, communityId]).catch(() => undefined);
  const refs = await db.query(`SELECT c.relname AS table_name, a.attname AS column_name
    FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = con.conkey[1]
    JOIN pg_class f ON f.oid = con.confrelid
    WHERE con.contype = 'f' AND f.relname = 'users' AND array_length(con.conkey, 1) = 1`);
  const ident = (value: string) => `"${value.replaceAll('"', '""')}"`;
  for (let pass = 0; pass < 4; pass += 1) {
    for (const row of refs.rows) await db.query(`DELETE FROM ${ident(row.table_name)} WHERE ${ident(row.column_name)} = $1`, [userId]).catch(() => undefined);
  }
  await db.query('DELETE FROM users WHERE user_id = $1', [userId]);
  await db.query('DELETE FROM communities WHERE community_id = $1', [communityId]);
}
async function open(browser: Browser, baseURL: string, email: string, viewport: {width: number; height: number}) {
  const context = await browser.newContext({baseURL, viewport});
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
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

test('a switched community can set and clear two category primaries, including keyboard and a narrow viewport', async ({browser, baseURL, e2eAuthPool}) => {
  test.setTimeout(120_000);
  const run = randomUUID().slice(0, 8);
  const communityId = randomUUID();
  const userId = randomUUID();
  const email = `category-${run}@example.test`;
  const guildNames = await names(e2eAuthPool);
  try {
    await e2eAuthPool.query('INSERT INTO communities(community_id, name) VALUES ($1,$2)', [communityId, '分類測試社群']);
    await e2eAuthPool.query(`INSERT INTO users(user_id, community_id, email, display_name, password_hash, profession_membership_ref, onboarding_required)
      VALUES ($1,$2,$3,$4,$5,$6,false)`, [userId, communityId, email, `分類會員 ${run}`, hashPassword(DEMO_PASSWORD), randomUUID()]);
    for (const key of Object.values(keys)) {
      await e2eAuthPool.query(`INSERT INTO positioning_profession_memberships(membership_id, community_id, user_id, guild_key, state, member_tier)
        VALUES ($1,$2,$3,$4,'active','intern')`, [randomUUID(), communityId, userId, key]);
    }
    await e2eAuthPool.query(`INSERT INTO guild_preference_switch(community_id, state, aggregate_version, switched_at) VALUES ($1,'switched',2,now())`, [communityId]);
    await e2eAuthPool.query(`INSERT INTO guild_preference_sets(community_id, user_id, aggregate_version, migration_state) VALUES ($1,$2,1,'switched')`, [communityId, userId]);
    const session = await open(browser, baseURL!, email, {width: 1280, height: 900});
    try {
      await navigate(session.page, '職業公會');
      for (const label of ['內政主力', '外交主力', '專業與產業主力']) {
        await expect(session.page.getByRole('group', {name: label, exact: true})).toContainText('尚未選擇');
      }
      const talent = session.page.getByRole('article', {name: guildNames.talent, exact: true});
      await talent.getByRole('button', {name: '設為本類主力', exact: true}).click();
      const internal = session.page.getByRole('group', {name: '內政主力', exact: true});
      await expect(internal.getByRole('article', {name: guildNames.talent, exact: true})).toBeVisible();
      await expect(internal.getByText('本類主力', {exact: true})).toBeVisible();
      const partnership = session.page.getByRole('article', {name: guildNames.partnership, exact: true});
      await partnership.getByRole('button', {name: '設為本類主力', exact: true}).click();
      const external = session.page.getByRole('group', {name: '外交主力', exact: true});
      await expect(external.getByRole('article', {name: guildNames.partnership, exact: true})).toBeVisible();
      await internal.getByRole('button', {name: '取消本類主力', exact: true}).click();
      await expect(internal).toContainText('尚未選擇');
      const pending = session.page.getByRole('article', {name: guildNames.vibe, exact: true});
      await expect(pending.getByText('分類整理中', {exact: true})).toBeVisible();
      await expect(pending.getByText('分類整理中，仍可使用公會工作區。')).toBeVisible();
      await expect(pending.getByRole('button', {name: '設為本類主力', exact: true})).toHaveCount(0);
      await session.page.setViewportSize({width: 360, height: 800});
      await noOverflow(session.page);
      const again = session.page.getByRole('article', {name: guildNames.talent, exact: true}).getByRole('button', {name: '設為本類主力', exact: true});
      await again.focus();
      await session.page.keyboard.press('Enter');
      const chosen = session.page.getByRole('group', {name: '內政主力', exact: true}).getByRole('button', {name: '取消本類主力', exact: true});
      await expect(chosen).toBeFocused();
      await chosen.click();
      await expect(session.page.getByRole('group', {name: '內政主力', exact: true})).toContainText('尚未選擇');
      await session.page.getByRole('article', {name: guildNames.talent, exact: true}).getByRole('button', {name: '設為本類主力', exact: true}).click();
      const leave = session.page.getByRole('group', {name: '內政主力', exact: true}).getByRole('button', {name: `退出${guildNames.talent}`, exact: true});
      await leave.click();
      const confirm = session.page.getByRole('status').filter({hasText: '不會刪除'});
      await expect(confirm).toContainText('不會移動');
      await expect(confirm).toContainText('私人業務資料不會移動，也不會刪除。');
      await confirm.getByRole('button', {name: '取消', exact: true}).click();
      await expect(confirm).toHaveCount(0);
    } finally {
      await session.context.close();
    }
  } finally {
    await cleanup(e2eAuthPool, userId, communityId);
  }
});

test('用新版本送出草稿 reloads the version and sends that If-Match', async ({browser, baseURL, e2eAuthPool}) => {
  test.setTimeout(120_000);
  const run = randomUUID().slice(0, 8);
  const communityId = randomUUID();
  const userId = randomUUID();
  const email = `category-retry-${run}@example.test`;
  const guildNames = await names(e2eAuthPool);
  try {
    await e2eAuthPool.query('INSERT INTO communities(community_id, name) VALUES ($1,$2)', [communityId, '分類重送社群']);
    await e2eAuthPool.query(`INSERT INTO users(user_id, community_id, email, display_name, password_hash, profession_membership_ref, onboarding_required)
      VALUES ($1,$2,$3,$4,$5,$6,false)`, [userId, communityId, email, `分類重送 ${run}`, hashPassword(DEMO_PASSWORD), randomUUID()]);
    for (const key of [keys.talent, keys.partnership]) {
      await e2eAuthPool.query(`INSERT INTO positioning_profession_memberships(membership_id, community_id, user_id, guild_key, state, member_tier)
        VALUES ($1,$2,$3,$4,'active','intern')`, [randomUUID(), communityId, userId, key]);
    }
    await e2eAuthPool.query(`INSERT INTO guild_preference_switch(community_id, state, aggregate_version, switched_at) VALUES ($1,'switched',2,now())`, [communityId]);
    await e2eAuthPool.query(`INSERT INTO guild_preference_sets(community_id, user_id, aggregate_version, migration_state) VALUES ($1,$2,1,'switched')`, [communityId, userId]);
    const first = await open(browser, baseURL!, email, {width: 1280, height: 900});
    const second = await open(browser, baseURL!, email, {width: 1280, height: 900});
    const matches: string[] = [];
    second.page.on('request', request => {
      if (request.method() === 'POST' && request.url().includes('/me/guild-preferences/v2/set')) matches.push(request.headers()['if-match'] ?? '');
    });
    try {
      await navigate(first.page, '職業公會');
      await navigate(second.page, '職業公會');
      await expect(first.page.getByRole('group', {name: '內政主力', exact: true})).toContainText('尚未選擇');
      await expect(second.page.getByRole('group', {name: '外交主力', exact: true})).toContainText('尚未選擇');
      await first.page.getByRole('article', {name: guildNames.talent, exact: true}).getByRole('button', {name: '設為本類主力', exact: true}).click();
      await expect(first.page.getByRole('group', {name: '內政主力', exact: true}).getByRole('article', {name: guildNames.talent, exact: true})).toBeVisible();
      const version = (await e2eAuthPool.query(`SELECT aggregate_version::text AS aggregate_version FROM guild_preference_sets WHERE user_id = $1`, [userId])).rows[0].aggregate_version as string;
      await second.page.getByRole('article', {name: guildNames.partnership, exact: true}).getByRole('button', {name: '設為本類主力', exact: true}).click();
      await expect(second.page.getByRole('status').filter({hasText: '草稿已保留'})).toBeVisible();
      await second.page.getByRole('button', {name: '用新版本送出草稿', exact: true}).click();
      await expect(second.page.getByRole('group', {name: '外交主力', exact: true}).getByRole('article', {name: guildNames.partnership, exact: true})).toBeVisible();
      expect(matches).toHaveLength(2);
      expect(matches[0]).not.toBe(`"${version}"`);
      expect(matches[1]).toBe(`"${version}"`);
    } finally {
      await first.context.close();
      await second.context.close();
    }
  } finally {
    await cleanup(e2eAuthPool, userId, communityId);
  }
});

test('the demo community keeps the legacy primary and secondary guild page', async ({browser, baseURL}) => {
  test.setTimeout(120_000);
  const session = await open(browser, baseURL!, 'maker@local.test', {width: 1280, height: 900});
  try {
    await navigate(session.page, '職業公會');
    await expect(session.page.getByRole('heading', {name: '主要與次要公會', exact: true})).toBeVisible();
    await expect(session.page.getByRole('button', {name: '設定次要公會', exact: true})).toBeVisible();
    await expect(session.page.getByRole('group', {name: '內政主力', exact: true})).toHaveCount(0);
  } finally {
    await session.context.close();
  }
});
