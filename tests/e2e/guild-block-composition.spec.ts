import {randomUUID} from 'node:crypto';
import {test, expect, type Page} from './fixtures.js';
import {DEMO_COMMUNITY, DEMO_PASSWORD, DEMO_USERS} from '../../packages/testing/seed.js';

async function login(page: Page, email: string) {
  await page.goto('/');
  await page.getByLabel('電子郵件', {exact: true}).fill(email);
  await page.getByLabel('密碼', {exact: true}).fill(DEMO_PASSWORD);
  await page.getByRole('button', {name: '登入', exact: true}).click();
  await expect(page.getByRole('button', {name: '設定', exact: true})).toBeVisible();
}
async function command(page: Page, path: string, body: unknown, version: string) {
  const session = await (await page.request.get('/api/v1/session')).json();
  return page.request.post(`/api/v1${path}`, {data: body, headers: {
    Origin: new URL(page.url()).origin, 'X-CSRF-Token': session.csrf_token,
    'Idempotency-Key': randomUUID(), 'If-Match': `"${version}"`,
  }});
}

for (const sample of [
  {guild: 'guild_product_quality_supply', id: 'guild-block.supply-catalog.v1', title: '商品與供貨', empty: '目前沒有可讀取的供貨商品庫。', endpoint: '/api/v1/me/supply-catalogs'},
  {guild: 'guild_ai_vibe', id: 'guild-block.open-source-works.v1', title: '我的作品與開源分享', empty: '還沒有作品或技能投稿，可以先保存一份私人草稿。', endpoint: '/api/v1/me/content'},
]) test(`${sample.guild} leader composes a reviewed block; publication, visitor privacy and member return use real APIs`, async ({page, browser, baseURL, e2eAuthPool}) => {
  test.setTimeout(180_000);
  const id = randomUUID(), email = `block-leader-${id}@example.test`;
  const previous = (await e2eAuthPool.query('SELECT user_id FROM positioning_guild_officers WHERE community_id=$1 AND guild_key=$2', [DEMO_COMMUNITY, sample.guild])).rows[0]?.user_id;
  await e2eAuthPool.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref,onboarding_required)
    SELECT $1,$2,$3,'合成公會區塊作者',password_hash,$4,false FROM users WHERE user_id=$5`, [id, DEMO_COMMUNITY, email, randomUUID(), DEMO_USERS[0].user_id]);
  await e2eAuthPool.query(`INSERT INTO positioning_profession_memberships(membership_id,community_id,user_id,guild_key,state,member_tier) VALUES($1,$2,$3,$4,'active','full')`, [randomUUID(), DEMO_COMMUNITY, id, sample.guild]);
  await e2eAuthPool.query(`INSERT INTO guild_member_preferences(community_id,user_id,primary_guild_key) VALUES($1,$2,$3)`, [DEMO_COMMUNITY, id, sample.guild]);
  await e2eAuthPool.query(`INSERT INTO positioning_guild_officers(community_id,guild_key,user_id) VALUES($1,$2,$3) ON CONFLICT(community_id,guild_key) DO UPDATE SET user_id=$3`, [DEMO_COMMUNITY, sample.guild, id]);
  const visitor = await browser.newContext({baseURL});
  await page.route(url => !['127.0.0.1', 'localhost'].includes(url.hostname), route => route.abort());
  await visitor.route(url => !['127.0.0.1', 'localhost'].includes(url.hostname), route => route.abort());
  let original: any;
  try {
    await login(page, email);
    original = await (await page.request.get(`/api/v1/guilds/${sample.guild}/launchpad-config`)).json();
    expect(original.body.schema_version).toBe('guild-launchpad.config/v1');
    await page.goto(`/#guilds/${sample.guild}`);
    await page.getByRole('button', {name: '啟用可組裝版面', exact: true}).click();
    await page.getByRole('combobox', {name: '加入公會工具', exact: true}).selectOption(sample.id);
    await page.getByRole('button', {name: '新增公會區塊', exact: true}).click();
    await page.getByRole('button', {name: '預覽公開', exact: true}).click();
    const preview = page.getByRole('dialog', {name: '合成預覽'});
    await expect(preview).toContainText(sample.title);
    await preview.getByRole('button', {name: '關閉', exact: true}).click();
    await page.getByRole('button', {name: '儲存草稿', exact: true}).click();
    await expect(page.getByText(/已儲存草稿版本/)).toBeVisible();
    const publicDraft = await (await page.request.get(`/api/v1/public/guilds/${sample.guild}/launchpad`)).json();
    expect(publicDraft.config.body.schema_version).toBe('guild-launchpad.config/v1');
    await page.getByRole('button', {name: '發布', exact: true}).click();
    await page.getByRole('button', {name: '確認發布', exact: true}).click();
    await expect(page.getByText(/已發布版本 \d+/)).toBeVisible();
    await expect(page.locator('.guild-launchpad > .guild-launchpad-block').getByRole('heading', {level: 2, name: sample.title, exact: true})).toBeVisible();
    await expect(page.getByText(sample.empty, {exact: true})).toBeVisible();

    const guest = await visitor.newPage();
    const privateReads: string[] = [];
    guest.on('request', request => {if (new URL(request.url()).pathname === sample.endpoint) privateReads.push(request.url());});
    await guest.goto(`/#guilds/${sample.guild}`);
    const block = guest.locator('.guild-launchpad-block').filter({has: guest.getByRole('heading', {level: 2, name: sample.title, exact: true})});
    await expect(block).toContainText('公會公開頁不會顯示私人資料');
    await expect(block.getByRole('button')).toHaveCount(0);
    expect(privateReads).toEqual([]);

    // A guild URL remains a readable public page after logout; the shared helper
    // for private pages expects the login form immediately and does not apply.
    const signedOut = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/auth/logout' && response.request().method() === 'POST');
    await page.getByRole('button', {name: '設定', exact: true}).click();
    await page.getByRole('menuitem', {name: '登出', exact: true}).click();
    const logout = await signedOut; expect(logout.status()).toBe(200); await logout.finished();
    await login(page, email);
    const read = page.waitForResponse(response => new URL(response.url()).pathname === sample.endpoint && response.request().method() === 'GET');
    await page.goto(`/#guilds/${sample.guild}`);
    const response = await read;
    expect(response.status()).toBe(200); await response.finished();
    await expect(page.getByText(sample.empty, {exact: true})).toBeVisible();
    await page.setViewportSize({width: 390, height: 844});
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally {
    // Preserve immutable history and restore the published configuration through
    // the same authorized commands. Synthetic identities live only in this run's DB.
    try {
      if (original) {
        // Cleanup also works if an assertion failed after the member signed out.
        const auth = await page.request.post('/api/v1/auth/login', {data: {email, password: DEMO_PASSWORD}, headers: {Origin: baseURL!}});
        expect(auth.status()).toBe(200);
        const current = await (await page.request.get(`/api/v1/guilds/${sample.guild}/launchpad-config`)).json();
        const saved = await command(page, `/guilds/${sample.guild}/launchpad-config/drafts`, {body: original.body}, current.pointer_version);
        expect(saved.status()).toBe(201);
        const draft = await saved.json();
        const restored = await command(page, `/guilds/${sample.guild}/launchpad-config/${draft.config_id}/publish`, {expected_body_sha256: draft.body_sha256}, draft.pointer_version);
        expect(restored.status()).toBe(200);
      }
    } finally {
      await visitor.close();
      if (previous) await e2eAuthPool.query('UPDATE positioning_guild_officers SET user_id=$3 WHERE community_id=$1 AND guild_key=$2', [DEMO_COMMUNITY, sample.guild, previous]);
      else await e2eAuthPool.query('DELETE FROM positioning_guild_officers WHERE community_id=$1 AND guild_key=$2 AND user_id=$3', [DEMO_COMMUNITY, sample.guild, id]);
    }
  }
});
