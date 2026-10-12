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

async function signOutHere(page: Page) {
  const response = page.waitForResponse(value => new URL(value.url()).pathname === '/api/v1/auth/logout' && value.request().method() === 'POST');
  await page.getByRole('button', {name: '設定', exact: true}).click();
  await page.getByRole('menuitem', {name: '登出', exact: true}).click();
  expect((await response).status()).toBe(200); await (await response).finished();
}
async function privateShowcase(page: Page, title: string) {
  await page.evaluate(() => {window.location.hash = 'my-content';});
  await page.getByRole('button', {name: '新增私人作品草稿', exact: true}).click();
  const editor = page.getByRole('region', {name: '私人作品編輯', exact: true});
  await editor.getByLabel('作品標題', {exact: true}).fill(title);
  await editor.getByLabel('一句話介紹', {exact: true}).fill('公會區塊驗收的合成私人內容');
  const saved = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/me/showcases' && response.request().method() === 'POST');
  await editor.getByRole('button', {name: '儲存私人草稿', exact: true}).click();
  const response = await saved; expect(response.status()).toBe(201);
  const row = await response.json();
  await editor.getByRole('button', {name: '回到內容清單', exact: true}).click();
  await expect(page.getByRole('article', {name: `作品：${title}`, exact: true})).toBeVisible();
  return row.showcase_id as string;
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
    if (sample.guild === 'guild_product_quality_supply') {
      const session = await (await page.request.get('/api/v1/session')).json();
      const created = await page.request.post('/api/v1/tenants', {data: {display_name: `組裝離開守門 ${id}`, workspace_name: '預設工作區'}, headers: {
        Origin: baseURL!, 'X-CSRF-Token': session.csrf_token, 'Idempotency-Key': randomUUID(),
      }});
      expect(created.status()).toBe(201);
      // Reload once so the existing My Work panel discovers the synthetic tenant.
      await page.reload();
      await page.getByRole('button', {name: '啟用可組裝版面', exact: true}).click();
      await page.getByRole('button', {name: '啟用手動工作', exact: true}).click();
      await page.locator('#my-work-title').fill('尚未保存的組裝測試草稿');
      const workToggle = page.locator('.guild-launchpad-editor .guild-launchpad-block').filter({has: page.locator('p', {hasText: /^我的工作$/})}).getByRole('checkbox');
      page.once('dialog', dialog => {expect(dialog.message()).toBe('有尚未儲存的內容，確定要離開嗎？'); void dialog.dismiss();});
      await workToggle.click();
      await expect(workToggle).toBeChecked();
      await expect(page.locator('#my-work-title')).toHaveValue('尚未保存的組裝測試草稿');
      page.once('dialog', dialog => {expect(dialog.message()).toBe('有尚未儲存的內容，確定要離開嗎？'); void dialog.accept();});
      await workToggle.click();
      await expect(workToggle).not.toBeChecked();
      await expect(page.locator('#my-work-title')).toHaveCount(0);
      await workToggle.check();
    }

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
    const firstRevision = /已發布版本 (\d+)/.exec(await page.getByText(/已發布版本 \d+/).innerText())![1];
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
    if (sample.guild === 'guild_product_quality_supply') {
      // Start from the published custom block, then return to that block's
      // server-backed catalog entry rather than only checking an empty state.
      const custom = page.locator('.guild-launchpad > .guild-launchpad-block').filter({has: page.getByRole('heading', {level: 2, name: sample.title, exact: true})});
      await custom.getByRole('button', {name: '開始供貨設定', exact: true}).click();
      const launch = page.getByRole('region', {name: '啟動應用', exact: true});
      // Reuse the one tenant created by the dirty-work guard above.
      await expect(launch.getByRole('button', {name: `組裝離開守門 ${id}・擁有者`, exact: true})).toBeVisible();
      await launch.getByRole('button', {name: '產生啟動方案', exact: true}).click();
      await launch.getByRole('button', {name: '確認啟動', exact: true}).click();
      await launch.getByRole('button', {name: '設定供貨資料', exact: true}).click();
      const catalogHash = new URL(page.url()).hash, catalogName = `區塊商品庫 ${id.slice(0, 8)}`;
      const setup = page.getByRole('form', {name: '建立供貨商品庫', exact: true});
      await setup.getByLabel('商品庫名稱', {exact: true}).fill(catalogName);
      await setup.getByRole('button', {name: '建立供貨商品庫', exact: true}).click();
      const product = page.getByRole('form', {name: '新增供貨商品', exact: true});
      await product.getByLabel('商品名稱', {exact: true}).fill('區塊回訪茶杯');
      await product.getByLabel('供貨單價（TWD）', {exact: true}).fill('300');
      await product.getByLabel('庫存', {exact: true}).fill('10');
      await product.getByRole('button', {name: '新增供貨商品', exact: true}).click();
      await expect(page.locator('.hosted-store-product')).toContainText('區塊回訪茶杯');
      await signOutHere(page); await login(page, email);
      await page.goto(`/#guilds/${sample.guild}`);
      await custom.getByRole('button', {name: catalogName, exact: true}).click();
      await expect(page).toHaveURL(new RegExp(catalogHash + '$'));
      await expect(page.locator('.hosted-store-product')).toContainText('區塊回訪茶杯');
      const catalogs = await (await page.request.get('/api/v1/me/supply-catalogs?pagination=cursor')).json();
      expect(catalogs.items).toHaveLength(1);
      expect(catalogHash).toBe(`#stores/${catalogs.items[0].tenant_id}/${catalogs.items[0].instance_id}/supply`);
      await page.goto(`/#guilds/${sample.guild}`);

      // Exercise the actual v2 history UI; the finally restore is only cleanup.
      const changedMission = `第二版組裝 ${id}`;
      await page.locator('#launchpad-mission').fill(changedMission);
      await page.getByRole('button', {name: '儲存草稿', exact: true}).click();
      await expect(page.getByText(/已儲存草稿版本/)).toBeVisible();
      await page.getByRole('button', {name: '發布', exact: true}).click();
      await page.getByRole('button', {name: '確認發布', exact: true}).click();
      await expect(page.getByText(/已發布版本 \d+/)).toBeVisible();
      await guest.reload(); await expect(guest.getByText(changedMission, {exact: true})).toBeVisible();
      await page.getByRole('listitem').filter({hasText: new RegExp(`^版本 ${firstRevision} ·`)}).getByRole('button', {name: '回復到此版本', exact: true}).click();
      await page.getByRole('dialog').getByLabel('回復原因', {exact: true}).fill('回到第一份可組裝版面');
      await page.getByRole('button', {name: '確認回復', exact: true}).click();
      await expect(page.locator('#launchpad-mission')).toHaveValue(original.body.mission_override ?? '');
      const restored = await (await page.request.get(`/api/v1/public/guilds/${sample.guild}/launchpad`)).json();
      expect(restored.config.body.schema_version).toBe('guild-launchpad.config/v2');
      expect(restored.config.body.mission_override).toBe(original.body.mission_override);
      await guest.reload(); await expect(guest.getByText(changedMission, {exact: true})).toHaveCount(0);
      await expect(block).toContainText('公會公開頁不會顯示私人資料');
      expect(privateReads).toEqual([]);
    } else {
      const titleA = `本人甲私人作品 ${id.slice(0, 8)}`, titleB = `本人乙私人作品 ${id.slice(0, 8)}`;
      const workId = await privateShowcase(page, titleA);
      await page.evaluate(guild => {window.location.hash = `guilds/${guild}`;}, sample.guild);
      await expect(page.getByText(titleA, {exact: true})).toBeVisible();
      await page.getByRole('button', {name: '查看我的內容', exact: true}).click();
      await page.getByRole('article', {name: `作品：${titleA}`, exact: true}).getByRole('link', {name: '編輯', exact: true}).click();
      await expect(page).toHaveURL(new RegExp(`#my-content/showcases/${workId}$`));
      await expect(page.getByLabel('作品標題', {exact: true})).toHaveValue(titleA);
      await page.getByRole('button', {name: '回到內容清單', exact: true}).click();

      const otherId = randomUUID(), otherEmail = `block-member-${otherId}@example.test`;
      await e2eAuthPool.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref,onboarding_required)
        SELECT $1,$2,$3,'合成第二位區塊會員',password_hash,$4,false FROM users WHERE user_id=$5`, [otherId, DEMO_COMMUNITY, otherEmail, randomUUID(), DEMO_USERS[0].user_id]);
      await e2eAuthPool.query(`INSERT INTO positioning_profession_memberships(membership_id,community_id,user_id,guild_key,state,member_tier) VALUES($1,$2,$3,$4,'active','full')`, [randomUUID(), DEMO_COMMUNITY, otherId, sample.guild]);
      await login(guest, otherEmail); await privateShowcase(guest, titleB);
      let release = () => {}, settled = () => {}, intercepted = false, captured = false;
      const gate = new Promise<void>(resolve => {release = resolve;}), finished = new Promise<void>(resolve => {settled = resolve;});
      await page.route('**/api/v1/me/content', async route => {
        if (intercepted) return route.continue();
        intercepted = true;
        try {
          const response = await route.fetch();
          expect(response.status()).toBe(200);
          expect((await response.json()).items.some((item: {title: string}) => item.title === titleA)).toBe(true);
          captured = true;
          await gate;
          // Logout may abort the old request; either discard or late delivery
          // must keep account A's private data out of the new session.
          await route.fulfill({response}).catch(() => undefined);
        } finally {settled();}
      });
      try {
        await page.evaluate(guild => {window.location.hash = `guilds/${guild}`;}, sample.guild);
        await expect.poll(() => captured).toBe(true);
        await signOutHere(page);
        await page.getByRole('button', {name: '會員登入', exact: true}).click();
        await page.getByLabel('電子郵件', {exact: true}).fill(otherEmail);
        await page.getByLabel('密碼', {exact: true}).fill(DEMO_PASSWORD);
        await page.getByRole('button', {name: '登入', exact: true}).click();
        await expect(page.getByRole('button', {name: '設定', exact: true})).toBeVisible();
        await page.evaluate(guild => {window.location.hash = `guilds/${guild}`;}, sample.guild);
        await expect(page.getByText(titleB, {exact: true})).toBeVisible();
        release(); await finished;
        await expect(page.getByText(titleA, {exact: true})).toHaveCount(0);
        await expect(page.getByText(titleB, {exact: true})).toBeVisible();
        expect((await page.request.get(`/api/v1/me/showcases/${workId}`)).status()).toBe(404);
      } finally {release(); await page.unroute('**/api/v1/me/content');}
    }
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
