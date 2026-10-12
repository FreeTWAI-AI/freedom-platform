import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import {test, expect, type Browser, type Page} from './fixtures.js';
import {navigate} from './navigation.js';
import {DEMO_COMMUNITY, DEMO_PASSWORD} from '../../packages/testing/seed.js';
import {hashPassword} from '../../modules/identity-membership/service.js';

const music = 'guild_music_mv';
const space = 'guild_event_space';
const edited = 'guild_human_design';

async function seed(db: Pool, appointLeader = true) {
  const run = randomUUID().slice(0, 8);
  const userId = randomUUID();
  const email = `launchpad-${run}@example.invalid`;
  const names = await db.query('SELECT guild_key, name FROM positioning_guild_catalog WHERE guild_key=ANY($1::text[])', [[music, space, edited]]);
  const nameOf = (key: string) => names.rows.find(row => row.guild_key === key).name as string;
  const previous = await db.query('SELECT user_id FROM positioning_guild_officers WHERE community_id=$1 AND guild_key=$2', [DEMO_COMMUNITY, edited]);
  await db.query(`INSERT INTO users(user_id, community_id, email, display_name, password_hash, profession_membership_ref, onboarding_required)
    VALUES($1,$2,$3,$4,$5,$6,false)`, [userId, DEMO_COMMUNITY, email, `啟動台會員 ${run}`, hashPassword(DEMO_PASSWORD), randomUUID()]);
  for (const key of [music, space, edited]) {
    await db.query(`INSERT INTO positioning_profession_memberships(membership_id, community_id, user_id, guild_key, state, member_tier)
      VALUES($1,$2,$3,$4,'active','full')`, [randomUUID(), DEMO_COMMUNITY, userId, key]);
  }
  await db.query(`INSERT INTO guild_member_preferences(community_id, user_id, primary_guild_key) VALUES($1,$2,$3)`, [DEMO_COMMUNITY, userId, space]);
  if (appointLeader) await db.query(`INSERT INTO positioning_guild_officers(community_id, guild_key, user_id) VALUES($1,$2,$3)
    ON CONFLICT (community_id, guild_key) DO UPDATE SET user_id=$3`, [DEMO_COMMUNITY, edited, userId]);
  return {userId, email, displayName: `啟動台會員 ${run}`, musicName: nameOf(music), spaceName: nameOf(space), editedName: nameOf(edited), previousOfficer: previous.rows[0]?.user_id as string | undefined};
}
async function cleanup(db: Pool, userId: string, previousOfficer: string | undefined) {
  await db.query('DELETE FROM guild_launchpad_delegations WHERE community_id=$1 AND guild_key=$2', [DEMO_COMMUNITY, edited]);
  await db.query('DELETE FROM command_receipts WHERE user_id=$1', [userId]);
  await db.query('DELETE FROM outbox WHERE transition_id IN (SELECT transition_id FROM transition_journal WHERE actor_ref=$1)', [userId]);
  await db.query('DELETE FROM transition_journal WHERE actor_ref=$1', [userId]);
  await db.query('DELETE FROM guild_member_preferences WHERE community_id=$1 AND user_id=$2', [DEMO_COMMUNITY, userId]);
  await db.query('DELETE FROM positioning_profession_memberships WHERE community_id=$1 AND user_id=$2', [DEMO_COMMUNITY, userId]);
  await db.query('DELETE FROM member_skill_book_grants WHERE community_id=$1 AND user_id=$2', [DEMO_COMMUNITY, userId]);
  await db.query('DELETE FROM sessions WHERE user_id=$1', [userId]);
  if (previousOfficer) await db.query('UPDATE positioning_guild_officers SET user_id=$3 WHERE community_id=$1 AND guild_key=$2', [DEMO_COMMUNITY, edited, previousOfficer]);
  else await db.query('DELETE FROM positioning_guild_officers WHERE community_id=$1 AND guild_key=$2 AND user_id=$3', [DEMO_COMMUNITY, edited, userId]);
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

test('a visitor can read a guild launchpad without a session', async ({browser, baseURL}) => {
  test.setTimeout(120_000);
  const context = await browser.newContext({baseURL, viewport: {width: 360, height: 800}});
  await context.route(url => !['127.0.0.1', 'localhost'].includes(url.hostname), route => route.abort());
  const page = await context.newPage();
  let releaseChunk: () => void = () => undefined;
  const chunkReleased = new Promise<void>(resolve => { releaseChunk = resolve; });
  await page.route(/\/assets\/GuildLaunchpadPage-[^/]+\.js$/, async route => {
    await chunkReleased;
    await route.continue();
  });
  try {
    const payload = await (await page.request.get(`/api/v1/public/guilds/${music}/launchpad`)).json() as {guild: {name: string; purpose: string}; config: {body: {mission_override: string | null}}};
    const mission = payload.config.body.mission_override ?? payload.guild.purpose;
    await page.goto(`/#guilds/${music}`, {waitUntil: 'domcontentloaded'});
    await expect(page.locator('.page-loading[role="status"]')).toBeVisible();
    await expect(page.locator('.guild-launchpad')).toHaveCount(0);
    releaseChunk();
    await expect(page.getByRole('heading', {level: 1, name: payload.guild.name})).toBeVisible();
    await expect(page.getByText(mission, {exact: true}).first()).toBeVisible();
    await expect(page.getByRole('button', {name: '會員登入', exact: true})).toBeVisible();
    const myWork = page.locator('.guild-launchpad-block').filter({has: page.getByRole('heading', {level: 2, name: '我的工作', exact: true})});
    await expect(myWork.locator('p').filter({hasText: /^登入並加入公會後，可以在這裡看到自己的工作。$/})).toBeVisible();
    await expect(page.locator('body')).not.toContainText('業務空間尚未在此環境啟用');
    await expect(page.getByRole('button', {name: '儲存草稿', exact: true})).toHaveCount(0);
    await noOverflow(page);
    await page.getByLabel('頁面工具', {exact: true}).click();
    await page.getByRole('button', {name: '頁面說明', exact: true}).click();
    const help = page.getByRole('dialog');
    await expect(help).toContainText('職業公會依工作領域聚集會員與技能書');
    await help.getByRole('button', {name: '關閉', exact: true}).click();
    await page.getByRole('button', {name: '會員登入', exact: true}).click();
    await expect(page.getByLabel('電子郵件', {exact: true})).toBeVisible();
    await page.getByRole('button', {name: '返回公會啟動台', exact: true}).click();
    await expect(page.getByRole('heading', {level: 1, name: payload.guild.name})).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`#guilds/${music}$`));
    await expect(page.getByRole('button', {name: '儲存草稿', exact: true})).toHaveCount(0);
    await noOverflow(page);
  } finally { releaseChunk(); await context.close(); }
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
    const card = session.page.getByRole('article', {name: fixture.editedName, exact: true});
    await card.scrollIntoViewIfNeeded();
    const open = card.getByRole('button', {name: '啟動台', exact: true});
    await expect(open).toBeVisible();
    expect(await open.evaluate(element => element.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
    await noOverflow(session.page);
    await session.page.setViewportSize({width: 1280, height: 900});
    await open.click();
    await expect(session.page.getByRole('heading', {level: 1, name: fixture.editedName})).toBeVisible();
    const back = session.page.getByRole('button', {name: '返回公會列表', exact: true});
    await expect(back).toBeVisible();
    const backBox = await back.boundingBox();
    expect(backBox).not.toBeNull();
    expect(backBox!.width).toBeLessThan(400);
    await expect(session.page.getByRole('link', {name: '前往業務空間', exact: true})).toBeVisible();
    await expect(session.page.getByText('目前沒有授權。', {exact: true})).toBeVisible();
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
    const moveAnnouncements = session.page.getByRole('button', {name: '上移公告', exact: true});
    for (let step = 0; step < 7; step += 1) {
      if (await session.page.getByRole('heading', {level: 2}).first().innerText() === '公告') break;
      await moveAnnouncements.click();
    }
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

test('a chair delegates editing and preview only, then revokes access from a stale editor', async ({browser, baseURL, e2eAuthPool}, testInfo) => {
  test.setTimeout(180_000);
  const chair = await seed(e2eAuthPool);
  const member = await seed(e2eAuthPool, false);
  // Existing active membership and person identity are fixture data; grants,
  // drafts, previews and revocation all go through the real authenticated API.
  await e2eAuthPool.query('INSERT INTO principals(user_ref) VALUES($1) ON CONFLICT (user_ref) DO NOTHING', [member.userId]);
  const sessions: Awaited<ReturnType<typeof login>>[] = [];
  const path = `/api/v1/guilds/${edited}`;
  const mission = `委派草稿 ${randomUUID().slice(0, 8)}`;
  let originalFailure: unknown;
  let failed = false;
  const responseFor = (page: Page, phase: string, endpoint: string, click: () => Promise<unknown>) => test.step(phase, async () => {
    const [response] = await Promise.all([
      page.waitForResponse(response => response.url().endsWith(endpoint) && response.request().method() === 'POST', {timeout: 30_000}),
      click(),
    ]);
    return response;
  });
  try {
    const leader = await login(browser, baseURL!, chair.email);
    sessions.push(leader);
    const delegate = await login(browser, baseURL!, member.email);
    sessions.push(delegate);
    const publicBefore = await leader.page.request.get(`/api/v1/public/guilds/${edited}/launchpad`);
    expect(publicBefore.status()).toBe(200);
    const publicConfig = (await publicBefore.json()).config;
    await leader.page.goto(`/#guilds/${edited}`);
    await expect(leader.page.getByRole('heading', {level: 1, name: chair.editedName})).toBeVisible();
    await leader.page.getByLabel(/^成員/).selectOption({label: member.displayName});
    await leader.page.getByLabel('編輯內容', {exact: true}).check();
    await leader.page.getByLabel('預覽配置', {exact: true}).check();
    await leader.page.getByLabel('發布配置', {exact: true}).uncheck();
    const expiry = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 16);
    await leader.page.getByLabel('到期時間', {exact: true}).fill(expiry);
    const grantResponse = await responseFor(leader.page, 'chair grants edit and preview', `${path}/launchpad-delegations`,
      () => leader.page.getByRole('button', {name: '授權', exact: true}).click());
    expect(grantResponse.status()).toBe(201);
    const grant = await grantResponse.json();
    expect(grant.capabilities).toEqual(['guild.content.edit', 'guild.config.preview']);
    await expect(leader.page.getByText('已新增授權。', {exact: true})).toBeVisible();

    await delegate.page.goto(`/#guilds/${edited}`);
    await expect(delegate.page.locator('#launchpad-mission')).toBeVisible();
    await expect(delegate.page.getByRole('button', {name: '發布', exact: true})).toHaveCount(0);
    await expect(delegate.page.getByRole('button', {name: '授權', exact: true})).toHaveCount(0);
    await expect(delegate.page.getByRole('button', {name: '撤銷', exact: true})).toHaveCount(0);
    await expect(delegate.page.getByLabel(/^成員/)).toHaveCount(0);
    await delegate.page.locator('#launchpad-mission').fill(mission);
    const savedResponse = await responseFor(delegate.page, 'delegate saves draft', `${path}/launchpad-config/drafts`,
      () => delegate.page.getByRole('button', {name: '儲存草稿', exact: true}).click());
    expect(savedResponse.status()).toBe(201);
    const draft = await savedResponse.json();
    expect(draft.body.mission_override).toBe(mission);
    await expect(delegate.page.getByText(/已儲存草稿版本/)).toBeVisible();
    const previewResponse = await responseFor(delegate.page, 'delegate previews draft', `${path}/launchpad-config/preview`,
      () => delegate.page.getByRole('button', {name: '預覽公開', exact: true}).click());
    expect(previewResponse.status()).toBe(200);
    expect(await previewResponse.json()).toMatchObject({effective_config: {mission_override: mission}, preview_data_origin: 'synthetic_fixture'});
    const preview = delegate.page.getByRole('dialog', {name: '合成預覽', exact: true});
    await expect(preview).toBeVisible();
    await preview.getByRole('button', {name: '關閉', exact: true}).click();

    // Hidden controls are not the permission boundary: correctly formed direct
    // requests must still be rejected by the server while this grant is active.
    const auth = await (await delegate.page.request.get('/api/v1/session')).json();
    for (const attempt of [
      {url: `${path}/launchpad-config/${draft.config_id}/publish`, body: {expected_body_sha256: draft.body_sha256}, version: draft.pointer_version},
      {url: `${path}/launchpad-delegations`, body: {principal_id: grant.principal_id, capabilities: ['guild.config.publish'], expires_at: grant.expires_at}, version: '1'},
      {url: `${path}/launchpad-delegations/${grant.delegation_id}/revoke`, body: {reason: '委派者不能管理授權'}, version: grant.version},
    ]) {
      const response = await delegate.page.request.post(attempt.url, {data: attempt.body, headers: {
        Origin: new URL(delegate.page.url()).origin, 'X-CSRF-Token': auth.csrf_token,
        'Idempotency-Key': randomUUID(), 'If-Match': `"${attempt.version}"`,
      }});
      expect(response.status()).toBe(403);
      expect(await response.json()).toMatchObject({code: 'guild_leader_required'});
    }
    const publicAfterSave = await leader.page.request.get(`/api/v1/public/guilds/${edited}/launchpad`);
    expect(publicAfterSave.status()).toBe(200);
    expect((await publicAfterSave.json()).config).toEqual(publicConfig);

    // Keep the delegate's loaded form open while the chair revokes in another
    // session, so the denial cannot be explained by simply hiding the editor.
    await delegate.page.locator('#launchpad-mission').fill(`${mission} 撤權後修改`);
    await leader.page.getByRole('listitem').filter({hasText: member.displayName}).getByRole('button', {name: '撤銷', exact: true}).click();
    await leader.page.getByRole('dialog', {name: '撤銷授權', exact: true}).getByLabel('撤銷原因', {exact: true}).fill('結束本次編輯委派');
    const revoked = await responseFor(leader.page, 'chair revokes delegate', `${path}/launchpad-delegations/${grant.delegation_id}/revoke`,
      () => leader.page.getByRole('button', {name: '確認撤銷', exact: true}).click());
    expect(revoked.status()).toBe(200);
    await expect(leader.page.getByText('已撤銷授權。', {exact: true})).toBeVisible();
    for (const action of [
      {label: '儲存草稿', endpoint: 'drafts'},
      {label: '預覽公開', endpoint: 'preview'},
    ]) {
      const response = await responseFor(delegate.page, `revoked delegate is denied: ${action.endpoint}`, `${path}/launchpad-config/${action.endpoint}`,
        () => delegate.page.getByRole('button', {name: action.label, exact: true}).click());
      expect(response.status()).toBe(403);
      expect(await response.json()).toMatchObject({code: 'guild_leader_required'});
      await expect(delegate.page.getByRole('alert')).toHaveText('此操作限目前在任的公會長。');
    }
    await expect(delegate.page.getByRole('dialog', {name: '合成預覽', exact: true})).not.toBeVisible();
    const latest = await leader.page.request.get(`${path}/launchpad-config`);
    expect(latest.status()).toBe(200);
    expect(await latest.json()).toMatchObject({config_id: draft.config_id, revision: draft.revision, pointer_version: draft.pointer_version, body: {mission_override: mission}});
    const publicAfterRevoke = await leader.page.request.get(`/api/v1/public/guilds/${edited}/launchpad`);
    expect(publicAfterRevoke.status()).toBe(200);
    expect((await publicAfterRevoke.json()).config).toEqual(publicConfig);
    await test.step('reload revoked delegate', () => delegate.page.reload({timeout: 30_000}));
    await expect(delegate.page.getByRole('heading', {level: 1, name: chair.editedName})).toBeVisible();
    await expect(delegate.page.locator('#launchpad-mission')).toHaveCount(0);
    await expect(delegate.page.getByRole('button', {name: '預覽公開', exact: true})).toHaveCount(0);
  } catch (error) {
    failed = true; originalFailure = error;
  } finally {
    // Do not let one context-close failure skip another context or fixture cleanup,
    // or replace the phase/assertion that originally failed.
    const cleanupErrors: unknown[] = [];
    const attempt = async (phase: string, action: () => Promise<unknown>) => {
      try { await test.step(phase, action); }
      catch (error) {
        cleanupErrors.push(error);
        console.error(`Delegation cleanup failed (${phase}): ${String(error)}`);
      }
    };
    await Promise.all(sessions.map((session, index) => attempt(`close session ${index + 1}`, () => session.context.close())));
    await attempt('clean delegate fixture', () => cleanup(e2eAuthPool, member.userId, undefined));
    await attempt('restore chair fixture', () => cleanup(e2eAuthPool, chair.userId, chair.previousOfficer));
    if (cleanupErrors.length) {
      try { await testInfo.attach('delegation-cleanup-errors', {body: cleanupErrors.map(error => String(error)).join('\n'), contentType: 'text/plain'}); }
      catch (error) { cleanupErrors.push(error); }
      if (!failed) { failed = true; originalFailure = new AggregateError(cleanupErrors, 'Delegation fixture cleanup failed'); }
    }
  }
  if (failed) throw originalFailure;
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

test('a failed public launchpad chunk can return home and recover after reload', async ({browser, baseURL}) => {
  const context = await browser.newContext({baseURL, viewport: {width: 360, height: 800}});
  await context.route(url => !['127.0.0.1', 'localhost'].includes(url.hostname), route => route.abort());
  const page = await context.newPage();
  const chunk = /\/assets\/GuildLaunchpadPage-[^/]+\.js$/;
  await page.route(chunk, route => route.abort());
  try {
    await page.goto(`/#guilds/${music}`);
    await expect(page.getByRole('alert')).toContainText('自由工坊暫時無法開啟');
    await page.getByRole('link', {name: '返回首頁', exact: true}).click();
    await expect(page).toHaveURL(/\/#home$/);
    await expect(page.getByLabel('電子郵件', {exact: true})).toBeVisible();
    await expect(page.getByRole('alert').filter({hasText: '自由工坊暫時無法開啟'})).toHaveCount(0);
    // React.lazy caches its rejected promise; recovery deliberately offers a
    // document reload rather than pretending a second route visit retries it.
    await page.goto(`/#guilds/${music}`);
    await expect(page.getByRole('alert')).toContainText('自由工坊暫時無法開啟');
    await page.unroute(chunk);
    await page.getByRole('button', {name: '重新載入頁面', exact: true}).click();
    await expect(page.locator('.guild-launchpad')).toBeVisible();
    await expect(page.getByRole('button', {name: '會員登入', exact: true})).toBeVisible();
  } finally { await context.close(); }
});

