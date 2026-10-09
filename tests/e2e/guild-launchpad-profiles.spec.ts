import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import type {Pool} from 'pg';
import {test, expect, type Page} from './fixtures.js';
import {signOut} from './navigation.js';
import {DEMO_COMMUNITY, DEMO_PASSWORD} from '../../packages/testing/seed.js';
import {hashPassword} from '../../modules/identity-membership/service.js';
import type {Config} from '../../contracts/guild-launchpad/v1/config.js';

const commerce = 'guild_commerce_sales';
const production = 'guild_commercial_production';
const talent = 'guild_talent_direction';
const profiles = [
  {key: commerce, title: '線上商店', headings: ['使命', '應用', '我的工作', '公告', '技能書', '公共任務', '協助']},
  {key: talent, title: '我的方向卡', headings: ['使命', '我的工作', '技能書', '公告', '應用', '公共任務', '協助']},
  {key: production, title: '拍攝brief／分鏡／交付', headings: ['使命', '我的工作', '技能書', '公告', '應用', '公共任務', '協助']},
];
const primary = (page: Page) => page.getByRole('region', {name: '主要動作', exact: true});
const recommendations = (page: Page) => page.getByRole('region', {name: '公會推薦', exact: true});
const flow = (page: Page) => page.getByRole('region', {name: '啟動應用', exact: true});

async function person(db: Pool, leader = false) {
  const id = randomUUID();
  const email = `profile-${id}@example.test`;
  await db.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref,onboarding_required)
    VALUES($1,$2,$3,'用途配置測試會員',$4,$5,false)`, [id, DEMO_COMMUNITY, email, hashPassword(DEMO_PASSWORD), randomUUID()]);
  for (const key of [commerce, production, talent]) {
    await db.query(`INSERT INTO positioning_profession_memberships(membership_id,community_id,user_id,guild_key,state,member_tier)
      VALUES($1,$2,$3,$4,'active','full')`, [randomUUID(), DEMO_COMMUNITY, id, key]);
  }
  await db.query('INSERT INTO guild_member_preferences(community_id,user_id,primary_guild_key) VALUES($1,$2,$3)', [DEMO_COMMUNITY, id, commerce]);
  if (leader) await db.query(`INSERT INTO positioning_guild_officers(community_id,guild_key,user_id) VALUES($1,$2,$3)
    ON CONFLICT (community_id,guild_key) DO UPDATE SET user_id=$3`, [DEMO_COMMUNITY, commerce, id]);
  return {id, email};
}
async function login(page: Page, email: string) {
  await page.route(url => !['127.0.0.1', 'localhost'].includes(url.hostname), route => route.abort());
  await page.goto('/');
  await page.getByLabel('電子郵件', {exact: true}).fill(email);
  await page.getByLabel('密碼', {exact: true}).fill(DEMO_PASSWORD);
  await page.getByRole('button', {name: '登入', exact: true}).click();
  await expect(page.getByRole('button', {name: '設定', exact: true})).toBeVisible();
}
async function open(page: Page, guild: string) {
  await page.evaluate(key => {window.location.hash = `guilds/${key}`;}, guild);
  await expect(page.locator('.guild-launchpad > .guild-launchpad-block')).toHaveCount(7);
  await expect(page.locator('.launchpad-applications .application-card').first()).toBeVisible();
}
async function post(page: Page, path: string, body: unknown, status: number, pointer?: string) {
  const session = await (await page.request.get('/api/v1/session')).json();
  const response = await page.request.post(`/api/v1${path}`, {data: body, headers: {
    Origin: new URL(page.url()).origin, 'X-CSRF-Token': session.csrf_token, 'Idempotency-Key': randomUUID(),
    ...(pointer ? {'If-Match': `"${pointer}"`} : {}),
  }});
  const result = await response.json();
  expect(response.status(), JSON.stringify(result)).toBe(status);
  return result;
}
async function publishOriginal(page: Page, body: Config) {
  const current = await (await page.request.get(`/api/v1/guilds/${commerce}/launchpad-config`)).json();
  const draft = await post(page, `/guilds/${commerce}/launchpad-config/drafts`, {body}, 201, current.pointer_version);
  await post(page, `/guilds/${commerce}/launchpad-config/${draft.config_id}/publish`, {expected_body_sha256: draft.body_sha256}, 200, draft.pointer_version);
}

test('members see distinct purpose orders and their primary action focuses My Work', async ({page, e2eAuthPool}) => {
  const member = await person(e2eAuthPool);
  await login(page, member.email);
  for (const profile of profiles) {
    await open(page, profile.key);
    await expect(page.locator('.guild-launchpad > .guild-launchpad-block > h2')).toHaveText(profile.headings);
    await expect(primary(page).getByRole('heading', {level: 2})).toHaveText(profile.title);
    await expect(page.locator('.launchpad-applications')).toHaveCount(1);
    if (profile.key === commerce) {
      await expect(primary(page).getByRole('button', {name: '建立我的商店', exact: true})).toBeEnabled();
      await expect(recommendations(page).locator('.application-card').first()).toContainText('線上商店');
    } else {
      await primary(page).getByRole('button', {name: profile.key === talent ? '前往方向卡' : '前往我的工作', exact: true}).click();
      await expect(page.locator('.guild-launchpad-block').filter({has: page.getByRole('heading', {level: 2, name: '我的工作', exact: true})})).toBeFocused();
      await expect(recommendations(page).locator('.application-card').first()).toContainText('人工工作空間');
    }
  }
  for (const key of [commerce, talent]) {
    await e2eAuthPool.query(`UPDATE positioning_profession_memberships SET member_tier='intern',aggregate_version=aggregate_version+1
      WHERE community_id=$1 AND user_id=$2 AND guild_key=$3`, [DEMO_COMMUNITY, member.id, key]);
    await open(page, key);
    await expect(primary(page)).toContainText('你是這個公會的實習成員');
    await expect(primary(page)).not.toContainText('建立新方向卡或繼續原卡');
    await expect(primary(page).getByRole('button')).toHaveCount(0);
  }
});

test('talent entry focuses the existing workspace, then saves and reopens the same direction card after fresh login', async ({page, e2eAuthPool}) => {
  const member = await person(e2eAuthPool), title = `入口方向卡 ${randomUUID()}`;
  await login(page, member.email); await open(page, talent);
  const work = page.locator('.guild-launchpad > .guild-launchpad-block').filter({has: page.getByRole('heading', {level: 2, name: '我的工作', exact: true})});
  await expect(primary(page)).toContainText('選擇可使用的工作空間');
  await primary(page).getByRole('button', {name: '前往方向卡', exact: true}).click();
  await expect(work).toBeFocused(); await expect(work).toContainText('你還沒有業務空間');
  await expect(work.getByRole('link', {name: '前往業務空間', exact: true})).toBeVisible();
  // Use the same existing member API; the entry action itself creates nothing.
  const created = await post(page, '/tenants', {display_name: '方向卡入口空間', workspace_name: '主工作區'}, 201);
  await page.reload(); await open(page, talent);
  await primary(page).getByRole('button', {name: '前往方向卡', exact: true}).click(); await expect(work).toBeFocused();
  await work.getByRole('button', {name: '啟用手動工作', exact: true}).click(); await expect(work.getByText('繼續工作', {exact: true})).toBeVisible();
  await work.getByLabel('方向卡名稱', {exact: true}).fill(title); await work.getByLabel('這週想改變的一件事', {exact: true}).fill('選一件小事開始');
  await work.getByRole('button', {name: '建立', exact: true}).click();
  const card = work.getByRole('form', {name: '我的方向卡', exact: true}); await expect(card).toBeVisible();
  await card.getByLabel('目前的情境', {exact: true}).fill('從公會入口選一個小活動');
  await card.getByRole('button', {name: '儲存方向卡', exact: true}).click();
  await expect(work.locator('.my-work-stage')).toContainText('已儲存・第 1 版');
  await expect(card.getByRole('button', {name: '儲存方向卡', exact: true})).toBeEnabled();
  const rows = (await e2eAuthPool.query('SELECT work_item_id FROM work_items WHERE tenant_id=$1 AND title=$2', [created.tenant.tenant_id, title])).rows;
  expect(rows).toHaveLength(1);
  const results = (await e2eAuthPool.query('SELECT result_id FROM tenant_work_results WHERE work_item_id=$1', [rows[0].work_item_id])).rows;
  expect(results).toHaveLength(1);
  await signOut(page); expect((await page.request.get('/api/v1/session')).status()).toBe(401);
  await login(page, member.email); await open(page, talent);
  await primary(page).getByRole('button', {name: '前往方向卡', exact: true}).click(); await expect(work).toBeFocused();
  await work.getByRole('button', {name: title, exact: true}).click();
  await expect(work.getByRole('form', {name: '我的方向卡', exact: true})).toBeVisible();
  await expect(card.getByLabel('目前的情境', {exact: true})).toHaveValue('從公會入口選一個小活動');
  expect((await e2eAuthPool.query('SELECT work_item_id FROM work_items WHERE tenant_id=$1 AND title=$2', [created.tenant.tenant_id, title])).rows).toEqual(rows);
  expect((await e2eAuthPool.query('SELECT result_id FROM tenant_work_results WHERE work_item_id=$1', [rows[0].work_item_id])).rows).toEqual(results);
});

test('a leader publishes recommendations and the member primary action opens the existing launch flow', async ({page, browser, baseURL, e2eAuthPool}) => {
  const leader = await person(e2eAuthPool, true);
  const member = await person(e2eAuthPool);
  const appKey = `synthetic-profile-${randomUUID().replaceAll('-', '')}`;
  const releaseRef = `${appKey}@1.0.0`;
  const displayName = '合成拍攝工作';
  const offeringId = randomUUID();
  await e2eAuthPool.query(`INSERT INTO application_definitions(
      application_key,release_ref,display_name,source_commit,artifact_digest,skill_book_refs,module_requirements,
      entry_capability,runtime_profiles,launch_policy_ref,license_state,release_status,customization_schema_ref,license_review_ref,version)
    SELECT $1,$2,$3,source_commit,artifact_digest,skill_book_refs,module_requirements,
      entry_capability,runtime_profiles,launch_policy_ref,license_state,release_status,customization_schema_ref,license_review_ref,version
    FROM application_definitions WHERE application_key='manual-workspace'`, [appKey, releaseRef, displayName]);
  await e2eAuthPool.query(`INSERT INTO guild_application_offerings(
      offering_id,community_id,guild_key,application_key,release_ref,status,display_order,launch_policy_ref,version)
    VALUES($1,$2,$3,$4,$5,'offered',20,'{"policy_key":"manual-workspace.launch","version":"1"}',1)`,
  [offeringId, DEMO_COMMUNITY, commerce, appKey, releaseRef]);
  await login(page, leader.email);
  await open(page, commerce);
  const original = (await (await page.request.get(`/api/v1/guilds/${commerce}/launchpad-config`)).json()).body as Config;
  const memberContext = await browser.newContext({baseURL});
  const memberPage = await memberContext.newPage();
  try {
    const editor = page.locator('.guild-launchpad-editor');
    await editor.getByRole('combobox', {name: '加入推薦應用', exact: true}).selectOption(JSON.stringify([appKey, releaseRef]));
    await editor.getByRole('button', {name: '加入推薦', exact: true}).click();
    await editor.getByRole('button', {name: `上移${displayName}`, exact: true}).click();
    await editor.getByRole('button', {name: `上移${displayName}`, exact: true}).click();
    await expect(primary(page).getByRole('heading')).toHaveText(displayName);
    await expect(recommendations(page).locator('.application-card').first()).toContainText(displayName);
    await editor.getByRole('button', {name: '預覽會員', exact: true}).click();
    await expect(page.getByRole('dialog')).toContainText('合成資料');
    await page.getByRole('dialog').getByRole('button', {name: '關閉', exact: true}).click();
    await editor.getByRole('button', {name: '儲存草稿', exact: true}).click();
    await expect(page.getByText(/已儲存草稿版本/)).toBeVisible();
    await editor.getByRole('button', {name: '發布', exact: true}).click();
    await page.getByRole('button', {name: '確認發布', exact: true}).click();
    await expect(page.getByRole('status').filter({hasText: /^已發布版本 /})).toBeVisible();
    const published = await (await page.request.get(`/api/v1/guilds/${commerce}/launchpad`)).json();
    expect(published.config.body.application_refs.map((ref: {application_key: string}) => ref.application_key)).toEqual([appKey, 'hosted-store', 'manual-workspace']);

    await login(memberPage, member.email);
    await post(memberPage, '/tenants', {display_name: '推薦啟動測試空間', workspace_name: '測試區'}, 201);
    // Exercise automatic catalog paging while the member response carries every recommendation.
    let catalogReads = 0;
    await memberPage.route('**/api/v1/applications?*', async route => {
      catalogReads++;
      const url = new URL(route.request().url());
      const more = url.searchParams.has('cursor');
      url.searchParams.delete('cursor');
      const response = await route.fetch({url: url.toString()});
      const body = await response.json();
      await route.fulfill({response, json: {...body,
        items: body.items.filter((app: {application_key: string}) => more ? app.application_key === appKey : app.application_key !== appKey),
        next_cursor: more ? null : 'profile-next-page',
      }});
    });
    await open(memberPage, commerce);
    await expect(recommendations(memberPage).locator('.application-card').first()).toContainText(displayName);
    expect(catalogReads).toBe(2);
    await expect(primary(memberPage).getByRole('heading')).toHaveText(displayName);
    await primary(memberPage).getByRole('button', {name: `啟動${displayName}`, exact: true}).click();
    await expect(flow(memberPage).getByRole('heading', {name: `啟動${displayName}`, exact: true})).toBeFocused();
    await flow(memberPage).getByRole('button', {name: '取消', exact: true}).click();
    await expect(primary(memberPage).getByRole('button')).toBeFocused();
    await expect(flow(memberPage)).toHaveCount(0);
    await expect(memberPage.locator('.launchpad-applications')).toHaveCount(1);

    // Disabled application blocks suppress non-manual primary actions in the unsaved reading view.
    const applicationsBlock = editor.getByRole('group', {name: '版面區塊'}).locator('.guild-launchpad-block').filter({has: page.locator('p', {hasText: /^應用$/})});
    await applicationsBlock.getByLabel('顯示這個區塊').uncheck();
    await expect(primary(page)).toHaveCount(0);
    await expect(editor).toContainText('應用區塊關閉時，會員看不到推薦應用；主要動作只保留我的工作。');
    await applicationsBlock.getByLabel('顯示這個區塊').check();
    // A withdrawal produces a row-local field note without losing the draft.
    await e2eAuthPool.query("UPDATE guild_application_offerings SET status='withdrawn',version=version+1 WHERE offering_id=$1", [offeringId]);
    await editor.getByRole('button', {name: '儲存草稿', exact: true}).click();
    await expect(page.locator('#launchpad-recommendation-0-error')).toHaveText('這個應用版本尚未核准');
    await expect(editor.getByRole('button', {name: `移除${displayName}`, exact: true})).toHaveAttribute('aria-describedby', /launchpad-recommendation-0-error/);
    await expect(editor).toContainText(`推薦應用 ${appKey}：這個應用版本尚未核准`);
  } finally {
    await publishOriginal(page, original);
    await memberContext.close();
  }
});

test('profile pages remain readable in light and RPG at mobile and desktop widths', async ({page, e2eAuthPool}, testInfo) => {
  const member = await person(e2eAuthPool);
  await login(page, member.email);
  await page.emulateMedia({reducedMotion: 'reduce'});
  for (const profile of profiles) {
    await open(page, profile.key);
    await expect(primary(page).getByRole('heading')).toHaveText(profile.title);
    const myWork = page.locator('.guild-launchpad > .guild-launchpad-block').filter({has: page.getByRole('heading', {level: 2, name: '我的工作', exact: true})});
    await expect(myWork.getByRole('link', {name: '前往業務空間', exact: true})).toBeVisible();
    for (const theme of ['light', 'dark']) {
      await page.evaluate(value => {
        localStorage.setItem('freedom-theme', value);
        document.documentElement.dataset.theme = value;
        document.documentElement.dataset.experienceProfile = value;
        window.dispatchEvent(new Event('freedom-theme-changed'));
      }, theme);
      for (const width of [1440, 360, 768]) {
        await page.setViewportSize({width, height: 900});
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        const bounds = await primary(page).evaluate(card => ({
          width: card.getBoundingClientRect().width,
          buttons: [...card.querySelectorAll('.btn')].map(button => ({width: button.getBoundingClientRect().width, height: button.getBoundingClientRect().height})),
        }));
        for (const button of bounds.buttons) {
          expect(button.width).toBeLessThanOrEqual(bounds.width);
          expect(button.height).toBeGreaterThanOrEqual(44);
          if (width === 1440) expect(button.width).toBeLessThan(bounds.width / 2);
        }
        const myWorkBounds = await myWork.evaluate(block => ({
          width: block.getBoundingClientRect().width,
          buttons: [...block.querySelectorAll('.btn')].map(button => ({text: button.textContent?.trim(), width: button.getBoundingClientRect().width})),
        }));
        expect(myWorkBounds.buttons.length).toBeGreaterThan(0);
        for (const button of myWorkBounds.buttons) {
          expect(button.width).toBeLessThanOrEqual(myWorkBounds.width);
          if (width === 1440) expect(button.width).toBeLessThan(myWorkBounds.width / 2);
        }
        await writeFile(testInfo.outputPath(`${profile.key}-${theme}-${width}-my-work-buttons.json`), JSON.stringify(myWorkBounds, null, 2));
        const colours = await recommendations(page).locator('.pill').first().evaluate(element => ({
          color: getComputedStyle(element).color, background: getComputedStyle(element).backgroundColor,
        }));
        expect(colours).toEqual(theme === 'light'
          ? {color: 'rgb(86, 99, 118)', background: 'rgb(246, 248, 251)'}
          : {color: 'rgb(217, 223, 235)', background: 'rgb(43, 48, 58)'});
        await writeFile(testInfo.outputPath(`${profile.key}-${theme}-${width}-colours.json`), JSON.stringify(colours, null, 2));
        await page.evaluate(() => window.scrollTo({left: 0, top: 0, behavior: 'instant'}));
        await page.screenshot({path: testInfo.outputPath(`${profile.key}-${theme}-${width}.png`), fullPage: true});
      }
    }
  }
});
