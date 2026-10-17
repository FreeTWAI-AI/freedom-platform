import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import {test, expect, type Browser, type Page} from './fixtures.js';
import {navigate} from './navigation.js';
import {DEMO_COMMUNITY, DEMO_PASSWORD} from '../../packages/testing/seed.js';
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

test('a switched community can set and clear two category primaries, including keyboard and a narrow viewport', async ({browser, baseURL, e2eAuthPool}, testInfo) => {
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
      for (const label of ['社群架構開發主力', '社群業務推廣主力', '社群專業服務主力']) {
        await expect(session.page.getByRole('group', {name: label, exact: true})).toContainText('尚未選擇');
      }
      const talent = session.page.getByRole('article', {name: guildNames.talent, exact: true});
      await talent.getByRole('button', {name: '設為本類主力', exact: true}).click();
      const internal = session.page.getByRole('group', {name: '社群架構開發主力', exact: true});
      await expect(internal.getByRole('article', {name: guildNames.talent, exact: true})).toBeVisible();
      await expect(internal.getByText('本類主力', {exact: true})).toBeVisible();
      const emptyCategory = session.page.getByRole('group', {name: '社群專業服務主力', exact: true});
      const emptyBox = await emptyCategory.boundingBox();
      const heldBox = await internal.boundingBox();
      expect(emptyBox).not.toBeNull();
      expect(heldBox).not.toBeNull();
      expect(emptyBox!.height).toBeLessThan(200);
      expect(heldBox!.height).toBeGreaterThan(400);
      const partnership = session.page.getByRole('article', {name: guildNames.partnership, exact: true});
      await partnership.getByRole('button', {name: '設為本類主力', exact: true}).click();
      const external = session.page.getByRole('group', {name: '社群業務推廣主力', exact: true});
      await expect(external.getByRole('article', {name: guildNames.partnership, exact: true})).toBeVisible();
      for (const theme of ['light', 'dark']) {
        await session.page.evaluate(value => {document.documentElement.dataset.theme = value;}, theme);
        for (const width of [360, 768, 1280]) {
          await session.page.setViewportSize({width, height: 900});
          await noOverflow(session.page);
          await session.page.evaluate(() => window.scrollTo(0, 0));
          await session.page.screenshot({path: testInfo.outputPath(`category-${theme}-${width}.png`), fullPage: false});
        }
      }
      await internal.getByRole('button', {name: '取消本類主力', exact: true}).click();
      await expect(internal).toContainText('尚未選擇');
      const pending = session.page.getByRole('article', {name: guildNames.vibe, exact: true});
      await expect(pending.getByText('分類整理中', {exact: true})).toBeVisible();
      await expect(pending.getByText('分類整理中，仍可使用公會工作區。')).toBeVisible();
      await expect(pending.getByRole('button', {name: '設為本類主力', exact: true})).toHaveCount(0);
      await session.page.setViewportSize({width: 360, height: 800});
      await noOverflow(session.page);
      const again = session.page.getByRole('article', {name: guildNames.talent, exact: true}).getByRole('button', {name: '設為本類主力', exact: true});
      // The cleared slot renders before its refresh finishes; focus() does not wait for enabled.
      await expect(again).toBeEnabled();
      await again.focus();
      await session.page.keyboard.press('Enter');
      const chosen = session.page.getByRole('group', {name: '社群架構開發主力', exact: true}).getByRole('button', {name: '取消本類主力', exact: true});
      await expect(chosen).toBeFocused();
      await expect(external.getByRole('article', {name: guildNames.partnership, exact: true})).toBeVisible();
      await chosen.click();
      await expect(session.page.getByRole('group', {name: '社群架構開發主力', exact: true})).toContainText('尚未選擇');
      await expect(external.getByRole('article', {name: guildNames.partnership, exact: true})).toBeVisible();
      await expect(session.page.getByLabel('我的公會概況', {exact: true})).toContainText('已加入 3 個公會');
      await session.page.getByRole('article', {name: guildNames.talent, exact: true}).getByRole('button', {name: '設為本類主力', exact: true}).click();
      const leave = session.page.getByRole('group', {name: '社群架構開發主力', exact: true}).getByRole('button', {name: `退出${guildNames.talent}`, exact: true});
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


test('confirmed category-primary leave survives reload and rejoin without changing private workspace access', async ({browser, baseURL, e2eAuthPool}) => {
  test.setTimeout(240_000);
  const run = randomUUID().slice(0, 8), communityId = DEMO_COMMUNITY, userId = randomUUID();
  const email = `category-lifecycle-${run}@example.invalid`;
  const labels = {internal: '社群架構開發主力', external: '社群業務推廣主力', professional_industry: '社群專業服務主力'} as const;
  type Category = keyof typeof labels;
  const guilds = (await e2eAuthPool.query<{guild_key: string; name: string; category: Category}>(`SELECT DISTINCT ON (c.category) g.guild_key,g.name,c.category::text AS category
    FROM positioning_guild_catalog g JOIN guild_catalog_categories c USING(guild_key)
    WHERE c.category_review='approved' AND c.category IS NOT NULL AND c.active
    ORDER BY c.category,g.guild_key`)).rows;
  expect(guilds.map(g => g.category).sort()).toEqual(Object.keys(labels).sort());
  // This suite uses one worker. Restore the exact shared switch after this synthetic journey.
  const priorSwitch = (await e2eAuthPool.query('SELECT state,aggregate_version,switched_at,switched_by FROM guild_preference_switch WHERE community_id=$1', [communityId])).rows[0];
  let session: Awaited<ReturnType<typeof open>> | undefined;
  try {
    await e2eAuthPool.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref,onboarding_required)
      VALUES($1,$2,$3,$4,$5,$6,false)`, [userId, communityId, email, `離會會員 ${run}`, hashPassword(DEMO_PASSWORD), randomUUID()]);
    for (const guild of guilds) await e2eAuthPool.query(`INSERT INTO positioning_profession_memberships(membership_id,community_id,user_id,guild_key,state,member_tier)
      VALUES($1,$2,$3,$4,'active','full')`, [randomUUID(), communityId, userId, guild.guild_key]);
    await e2eAuthPool.query(`INSERT INTO guild_preference_switch(community_id,state,aggregate_version,switched_at) VALUES($1,'switched',2,now())
      ON CONFLICT (community_id) DO UPDATE SET state='switched',aggregate_version=2,switched_at=now(),switched_by=NULL`, [communityId]);
    await e2eAuthPool.query(`INSERT INTO guild_preference_sets(community_id,user_id,aggregate_version,migration_state) VALUES($1,$2,1,'switched')`, [communityId, userId]);
    session = await open(browser, baseURL!, email, {width: 1280, height: 900});
    const page = session.page;
    const post = async <T,>(path: string, data: unknown, status: number): Promise<T> => {
      const current = await page.request.get('/api/v1/session');
      expect(current.ok()).toBe(true);
      const csrf = (await current.json() as {csrf_token: string}).csrf_token;
      const response = await page.request.post(`/api/v1${path}`, {data, headers: {
        Origin: new URL(page.url()).origin, 'X-CSRF-Token': csrf, 'Idempotency-Key': randomUUID(),
      }});
      const body = await response.json();
      expect(response.status(), JSON.stringify(body)).toBe(status);
      return body as T;
    };
    // Fixture writes use the same local HTTP APIs as the existing my-work tests.
    const tenantName = `保留的私人空間 ${run}`, workspaceName = '原工作區';
    const made = await post<{tenant: {tenant_id: string}; workspace: {workspace_id: string}}>('/tenants', {
      display_name: tenantName, workspace_name: workspaceName,
    }, 201);
    const tenantId = made.tenant.tenant_id, workspaceId = made.workspace.workspace_id;
    await post(`/tenants/${tenantId}/workspaces/${workspaceId}/manual-work`, {guild_key: guilds[0].guild_key}, 200);
    const work = await post<{resource_ref: {resource_id: string}}>(`/tenants/${tenantId}/workspaces/${workspaceId}/works`, {
      title: `私人工作 ${run}`, objective: '離會前後仍由原擁有者讀取', progress: 'todo',
    }, 201);
    const workPath = `/api/v1/tenants/${tenantId}/works/${work.resource_ref.resource_id}`;
    const readWork = async () => {
      const response = await page.request.get(workPath);
      expect(response.status()).toBe(200);
      expect(response.headers()['cache-control']).toBe('private, no-store');
      return response.json();
    };
    const originalWork = await readWork();
    const originalTenant = await page.request.get(`/api/v1/tenants/${tenantId}`);
    expect(originalTenant.status()).toBe(200);
    const originalMembership = (await originalTenant.json()).my_membership;

    await navigate(page, '職業公會');
    const expected = new Map(guilds.map(g => [g.category, g.guild_key as string | null]));
    for (const guild of guilds) {
      await page.getByRole('article', {name: guild.name, exact: true}).getByRole('button', {name: '設為本類主力', exact: true}).click();
      await expect(page.getByRole('group', {name: labels[guild.category], exact: true}).getByRole('article', {name: guild.name, exact: true})).toBeVisible();
    }
    const assertSlots = async () => {
      for (const guild of guilds) {
        const slot = page.getByRole('group', {name: labels[guild.category], exact: true});
        if (expected.get(guild.category)) await expect(slot.getByRole('article', {name: guild.name, exact: true})).toBeVisible();
        else await expect(slot).toContainText('尚未選擇');
      }
      const response = await page.request.get('/api/v1/me/guild-preferences/v2');
      expect(response.status()).toBe(200);
      const view = await response.json() as {primaries: {category: Category; guild_key: string | null}[]};
      expect(Object.fromEntries(view.primaries.map(slot => [slot.category, slot.guild_key]))).toEqual(Object.fromEntries(expected));
    };
    const assertPrivateAccess = async () => {
      await navigate(page, '業務空間');
      await expect(page.getByText(`${tenantName}／${workspaceName}`, {exact: true})).toBeVisible();
      await expect(page.getByText('我的角色：擁有者', {exact: true})).toBeVisible();
      const response = await page.request.get(`/api/v1/tenants/${tenantId}`);
      expect(response.status()).toBe(200);
      expect((await response.json()).my_membership).toEqual(originalMembership);
      expect(await readWork()).toEqual(originalWork);
    };

    for (const guild of guilds) {
      await assertSlots();
      await page.getByRole('group', {name: labels[guild.category], exact: true}).getByRole('button', {name: `退出${guild.name}`, exact: true}).click();
      const confirmation = page.getByRole('status').filter({hasText: `退出${guild.name}會清空${labels[guild.category]}`});
      await expect(confirmation).toContainText('私人業務資料不會移動，也不會刪除。');
      await confirmation.getByRole('button', {name: '確認退出', exact: true}).click();
      await expect(page.getByRole('status').filter({hasText: `已退出${guild.name}`})).toBeVisible();
      expected.set(guild.category, null);
      await page.reload();
      await assertSlots();
      const directory = await page.request.get('/api/v1/guilds/directory');
      expect(directory.status()).toBe(200);
      const left = (await directory.json() as {items: {guild_key: string; membership: {state: string; aggregate_version: number}}[]}).items.find(g => g.guild_key === guild.guild_key)!.membership;
      expect(left.state).toBe('left');
      await expect(page.getByRole('region', {name: '未加入公會', exact: true}).getByRole('article', {name: guild.name, exact: true})).toBeVisible();
      await assertPrivateAccess();

      await page.goto(`/#guilds/${guild.guild_key}`);
      const request = page.waitForRequest(r => r.method() === 'POST' && new URL(r.url()).pathname === `/api/v1/guilds/${guild.guild_key}/join`);
      await page.getByRole('button', {name: `加入${guild.name}`, exact: true}).click();
      expect((await request).headers()['if-match']).toBe(`"${left.aggregate_version}"`);
      await expect(page.getByText('成員身分：實習成員', {exact: true})).toBeVisible();
      await page.reload();
      await expect(page.getByText('成員身分：實習成員', {exact: true})).toBeVisible();
      await assertPrivateAccess();
      await navigate(page, '職業公會');
      await assertSlots(); // Rejoin must not resurrect the cleared category primary.
    }
    expect([...expected.values()]).toEqual([null, null, null]);
  } finally {
    await session?.context.close();
    if (priorSwitch) await e2eAuthPool.query('UPDATE guild_preference_switch SET state=$2,aggregate_version=$3,switched_at=$4,switched_by=$5 WHERE community_id=$1', [communityId, priorSwitch.state, priorSwitch.aggregate_version, priorSwitch.switched_at, priorSwitch.switched_by]);
    else await e2eAuthPool.query('DELETE FROM guild_preference_switch WHERE community_id=$1', [communityId]);
    // Tenant fixtures persist only in this disposable E2E schema, as in tenant-workspaces.spec.ts.
    await e2eAuthPool.query('UPDATE sessions SET revoked_at=now() WHERE user_id=$1', [userId]);
    await e2eAuthPool.query('UPDATE users SET active=false WHERE user_id=$1', [userId]);
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
      await expect(first.page.getByRole('group', {name: '社群架構開發主力', exact: true})).toContainText('尚未選擇');
      await expect(second.page.getByRole('group', {name: '社群業務推廣主力', exact: true})).toContainText('尚未選擇');
      await first.page.getByRole('article', {name: guildNames.talent, exact: true}).getByRole('button', {name: '設為本類主力', exact: true}).click();
      await expect(first.page.getByRole('group', {name: '社群架構開發主力', exact: true}).getByRole('article', {name: guildNames.talent, exact: true})).toBeVisible();
      const version = (await e2eAuthPool.query(`SELECT aggregate_version::text AS aggregate_version FROM guild_preference_sets WHERE user_id = $1`, [userId])).rows[0].aggregate_version as string;
      await second.page.getByRole('article', {name: guildNames.partnership, exact: true}).getByRole('button', {name: '設為本類主力', exact: true}).click();
      await expect(second.page.getByRole('status').filter({hasText: '草稿已保留'})).toBeVisible();
      await second.page.getByRole('button', {name: '用新版本送出草稿', exact: true}).click();
      await expect(second.page.getByRole('group', {name: '社群業務推廣主力', exact: true}).getByRole('article', {name: guildNames.partnership, exact: true})).toBeVisible();
      expect(matches).toHaveLength(2);
      expect(matches[0]).not.toBe(`"${version}"`);
      expect(matches[1]).toBe(`"${version}"`);


      // A real tier change also advances membership version. Inject that scoped
      // concurrent change here; tier-command authorization is covered separately.
      const internal = second.page.getByRole('group', {name: '社群架構開發主力', exact: true});
      const leavePath = `/api/v1/guilds/${keys.talent}/leave-v2`;
      const leaveMatches: string[] = [];
      second.page.on('request', request => {
        if (request.method() === 'POST' && new URL(request.url()).pathname === leavePath) leaveMatches.push(request.headers()['if-match'] ?? '');
      });
      await internal.getByRole('button', {name: `退出${guildNames.talent}`, exact: true}).click();
      const confirmation = second.page.getByRole('status').filter({hasText: `退出${guildNames.talent}會清空社群架構開發主力`});
      await expect(confirmation).toBeVisible();
      const changed = (await e2eAuthPool.query<{aggregate_version: string}>(`UPDATE positioning_profession_memberships
        SET member_tier='full',aggregate_version=aggregate_version+1
        WHERE community_id=$1 AND user_id=$2 AND guild_key=$3 AND state='active'
        RETURNING aggregate_version::text AS aggregate_version`, [communityId, userId, keys.talent])).rows[0];
      expect(changed).toBeDefined();
      const rejected = second.page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === leavePath);
      await confirmation.getByRole('button', {name: '確認退出', exact: true}).click();
      expect((await rejected).status()).toBe(412);
      await expect(second.page.getByRole('alert')).toContainText('資料已更新，請重新整理後再操作。');
      await expect(confirmation).toHaveCount(0);
      const stillJoined = (await e2eAuthPool.query(`SELECT state FROM positioning_profession_memberships
        WHERE community_id=$1 AND user_id=$2 AND guild_key=$3`, [communityId, userId, keys.talent])).rows[0];
      expect(stillJoined.state).toBe('active');
      await expect(internal.getByRole('article', {name: guildNames.talent, exact: true})).toBeVisible();

      // Reload does not submit the old decision. The member explicitly opens and
      // confirms a fresh leave against the newly displayed membership.
      await second.page.getByRole('alert').getByRole('button', {name: '重新載入公會', exact: true}).click();
      await expect(internal.getByRole('article', {name: guildNames.talent, exact: true})).toBeVisible();
      await expect(internal.locator('.guild-intern-notice')).toHaveCount(0);
      await expect(confirmation).toHaveCount(0);
      expect(leaveMatches).toHaveLength(1);
      await internal.getByRole('button', {name: `退出${guildNames.talent}`, exact: true}).click();
      await expect(confirmation).toContainText('私人業務資料不會移動，也不會刪除。');
      const completed = second.page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === leavePath);
      await confirmation.getByRole('button', {name: '確認退出', exact: true}).click();
      expect((await completed).status()).toBe(200);
      expect(leaveMatches).toEqual([`"${BigInt(changed.aggregate_version) - 1n}"`, `"${changed.aggregate_version}"`]);
      await expect(internal).toContainText('尚未選擇');
      await expect(second.page.getByRole('group', {name: '社群業務推廣主力', exact: true}).getByRole('article', {name: guildNames.partnership, exact: true})).toBeVisible();
      const departed = (await e2eAuthPool.query(`SELECT state,aggregate_version::text AS aggregate_version
        FROM positioning_profession_memberships WHERE community_id=$1 AND user_id=$2 AND guild_key=$3`, [communityId, userId, keys.talent])).rows[0];
      expect(departed).toEqual({state: 'left', aggregate_version: String(BigInt(changed.aggregate_version) + 1n)});

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
    await expect(session.page.getByRole('group', {name: '社群架構開發主力', exact: true})).toHaveCount(0);
  } finally {
    await session.context.close();
  }
});

test('admin category tools are reading-width cards and send the classification and switch writes', async ({page}) => {
  test.setTimeout(120_000);
  const csrf = 'synthetic-admin-csrf';
  const tagged = {guild_key: 'guild_talent_direction', name: '人才方向公會', category: 'internal', category_review: 'approved', capability_tags: ['人才盤點', '職涯'], catalog_revision: '3'};
  const catalog = {
    catalog_revision: '3',
    categories: [
      {category: 'internal', label: '社群架構開發', section: '社群架構開發主力', items: [tagged]},
      {category: 'external', label: '社群業務推廣', section: '社群業務推廣主力', items: [{guild_key: 'guild_opportunity_partnership', name: '機會合作公會', category: 'external', category_review: 'approved', capability_tags: [], catalog_revision: '3'}]},
      {category: 'professional_industry', label: '社群專業服務', section: '社群專業服務主力', items: [{guild_key: 'guild_member_operations', name: '會員經營公會', category: 'professional_industry', category_review: 'approved', capability_tags: [], catalog_revision: '3'}]},
    ],
    pending: [{guild_key: 'guild_ai_vibe', name: 'AI 氛圍公會', category: null, category_review: 'pending', capability_tags: [], catalog_revision: '3'}],
  };
  let classification: {headers: Record<string, string>; body: {category: string; capability_tags: string[]; reason: string}} | undefined;
  let switched: {body: {accept_blocked: boolean}} | undefined;
  await page.setViewportSize({width: 1280, height: 900});
  await page.route('**/admin/api/**', async route => {
    const path = new URL(route.request().url()).pathname.replace('/admin/api', '');
    if (path === '/bootstrap') return route.fulfill({json: {admin: {admin_id: 'synthetic-admin', display_name: '測試管理員', email: 'admin@example.test', role: 'super_admin', community_id: 'synthetic-community'}, csrf_token: csrf, summary: {members: 40, active_members: 40, pending_guild_applications: 0, guilds: 1, admins: 1}, available_skill_books: [], pending_guild_appointments: []}});
    if (path === '/guild-categories') return route.fulfill({json: catalog});
    if (path === '/guild-preferences/backfill') return route.fulfill({json: {dry_run: true, processed: 40, mapped: 37, blocked: 3, remaining: 40, remaining_blocked: 3}});
    if (path === `/guilds/${tagged.guild_key}/classification`) {
      classification = {headers: route.request().headers(), body: route.request().postDataJSON()};
      return route.fulfill({json: {guild_key: tagged.guild_key, name: tagged.name, category: classification.body.category, category_review: 'approved', capability_tags: classification.body.capability_tags, active: true, catalog_revision: '4'}});
    }
    if (path === '/guild-preferences/switch') {
      switched = {body: route.request().postDataJSON()};
      return route.fulfill({json: {state: 'switched', aggregate_version: 2, blocked: 3, processed: 40, already_switched: false}});
    }
    return route.fulfill({json: {items: [], next_offset: null}});
  });
  await page.goto('/admin');
  await page.getByRole('button', {name: '公會管理', exact: true}).click();
  const classifyToggle = page.getByRole('button', {name: '分類與能力標籤', exact: true});
  const switchToggle = page.getByRole('button', {name: '分類與主力切換', exact: true});
  await expect(classifyToggle).toHaveAttribute('aria-expanded', 'false');
  await expect(classifyToggle).toHaveAttribute('aria-controls', 'admin-guild-classification');
  await classifyToggle.click();
  await expect(classifyToggle).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('heading', {name: '分類與能力標籤', exact: true})).toBeVisible();
  await page.getByRole('combobox', {name: '公會', exact: true}).selectOption(tagged.guild_key);
  await expect(page.getByRole('combobox', {name: '類別', exact: true})).toHaveValue('internal');
  const tags = page.getByRole('textbox', {name: '能力標籤', exact: true});
  await expect(tags).toHaveValue('人才盤點\n職涯');
  await tags.fill('人才盤點, 新標籤');
  await page.getByRole('textbox', {name: '調整理由', exact: true}).fill('補上瀏覽用的能力標籤');
  await page.getByRole('button', {name: '儲存分類', exact: true}).click();
  await expect(page.getByRole('status').filter({hasText: '已儲存人才方向公會的分類。'})).toBeVisible();
  expect(classification?.headers['if-match']).toBe('"3"');
  expect(classification?.headers['x-admin-csrf']).toBe(csrf);
  expect(classification?.body).toEqual({category: 'internal', capability_tags: ['人才盤點', '新標籤'], reason: '補上瀏覽用的能力標籤'});
  const card = page.locator('#admin-guild-classification');
  const cardWidth = await card.evaluate(element => element.getBoundingClientRect().width);
  const widthLimit = await page.evaluate(() => 40 * Number.parseFloat(getComputedStyle(document.documentElement).fontSize) + 1);
  expect(cardWidth).toBeLessThanOrEqual(widthLimit);
  const cardColor = await card.evaluate(element => getComputedStyle(element).backgroundColor);
  const reportColor = await page.locator('.guild-discovery-report').evaluate(element => getComputedStyle(element).backgroundColor);
  expect(cardColor).toBe(reportColor);
  await switchToggle.click();
  await expect(switchToggle).toHaveAttribute('aria-expanded', 'true');
  await expect(switchToggle).toHaveAttribute('aria-controls', 'admin-guild-switch');
  await expect(classifyToggle).toHaveAttribute('aria-expanded', 'false');
  const region = page.getByRole('region', {name: '分類與主力切換', exact: true});
  await expect(region).toContainText('這一批檢視 40 位，可對照 37 位。全部尚餘 40 位，無法對照 3 位。');
  const confirm = region.getByRole('button', {name: '確認切換', exact: true});
  await expect(confirm).toBeDisabled();
  await region.getByRole('checkbox', {name: /我確認仍要切換/}).check();
  await confirm.click();
  await expect(region.getByRole('status')).toHaveText('已切換。這次處理 40 位，無法對照 3 位。');
  expect(switched?.body).toEqual({accept_blocked: true});
  await page.setViewportSize({width: 320, height: 800});
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
  await classifyToggle.click();
  await expect(page.getByRole('heading', {name: '分類與能力標籤', exact: true})).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
  const heights = await page.locator('.admin-guild-category-tools button').evaluateAll(elements => elements.map(element => element.getBoundingClientRect().height));
  expect(heights.length).toBeGreaterThan(0);
  for (const height of heights) expect(height).toBeGreaterThanOrEqual(44);
  const saveWidth = await page.getByRole('button', {name: '儲存分類', exact: true}).evaluate(element => element.getBoundingClientRect().width);
  const narrowCard = await page.locator('#admin-guild-classification').evaluate(element => element.getBoundingClientRect().width);
  expect(saveWidth).toBeLessThan(narrowCard);
});
