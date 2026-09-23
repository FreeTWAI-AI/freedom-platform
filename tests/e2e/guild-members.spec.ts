import { test, expect, type Page } from './fixtures.js';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { DEMO_COMMUNITY, DEMO_USERS } from '../../packages/testing/seed.js';

const guilds = [
  { guild_key: 'guild_event_space', name: '活動與空間公會', guild_master: { user_id: 'member-0', display_name: '同名夥伴' }, guild_experts: [{user_id:'member-0',display_name:'同名夥伴'},{user_id:'member-2',display_name:'活動夥伴 2'},{user_id:'member-3',display_name:'專注活動動線與展場光影設計的專家'}] },
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
  const leaders=card.locator('.guild-leadership-row');await expect(leaders).toHaveCount(4);await expect(leaders.first()).toHaveClass(/guild-master/);for(const row of await leaders.all())await expect(row).toBeVisible();
  const assertRows=async()=>{const boxes=await leaders.evaluateAll(nodes=>nodes.map(node=>{const r=node.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,bottom:r.bottom};}));for(let i=1;i<boxes.length;i++){expect(boxes[i].x).toBeCloseTo(boxes[0].x,0);expect(boxes[i].width).toBeCloseTo(boxes[0].width,0);expect(boxes[i].y).toBeGreaterThanOrEqual(boxes[i-1].bottom);}};
  await page.setViewportSize({width:1440,height:960});await assertRows();await card.locator('.guild-leadership').scrollIntoViewIfNeeded();await page.screenshot({path:'test-results/guild-leadership-desktop.png'});
  await page.setViewportSize({width:320,height:844});await assertRows();await card.locator('.guild-leadership').scrollIntoViewIfNeeded();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:'test-results/guild-leadership-phone.png'});await page.setViewportSize({width:1280,height:900});
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
  const adminId=randomUUID();
  const previous = (await pool.query('SELECT * FROM positioning_guild_officers WHERE community_id=$1 AND guild_key=$2', [DEMO_COMMUNITY, guild])).rows[0];
  try {
    await pool.query('INSERT INTO platform_admins(admin_id,community_id,email,display_name) VALUES($1,$2,$3,$4)',[adminId,DEMO_COMMUNITY,`${adminId}@example.invalid`,'Synthetic avatar test admin']);
    const photo=await sharp({create:{width:256,height:256,channels:3,background:'#3044ff'}}).webp().toBuffer();
    for (let i = 0; i < ids.length; i++) {
      await pool.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref) SELECT $1,$2,$3,$4,password_hash,$5 FROM users WHERE user_id=$6`, [ids[i], DEMO_COMMUNITY, ids[i] + '@example.invalid', names[i], randomUUID(), DEMO_USERS[0].user_id]);
      const key = i < 2 ? guild : 'guild_security';
      await pool.query(`INSERT INTO positioning_profession_memberships(membership_id,community_id,user_id,guild_key,state) VALUES($1,$2,$3,$4,'active')`, [randomUUID(), DEMO_COMMUNITY, ids[i], key]);
      await pool.query('INSERT INTO guild_member_preferences(community_id,user_id,primary_guild_key) VALUES($1,$2,$3)', [DEMO_COMMUNITY, ids[i], key]);
    }
    for(const id of ids.slice(0,2))await pool.query('INSERT INTO member_avatars(user_id,community_id,image_bytes) VALUES($1,$2,$3)',[id,DEMO_COMMUNITY,photo]);
    await pool.query('INSERT INTO positioning_guild_experts(community_id,guild_key,user_id,appointed_by) VALUES($1,$2,$3,$4)',[DEMO_COMMUNITY,guild,ids[1],adminId]);
    await pool.query(`INSERT INTO member_accounts(user_id,community_id,contacts) VALUES($1,$2,$3)`, [ids[1], DEMO_COMMUNITY, JSON.stringify({ email: { audiences: [] }, discord: { value: 'browser-visible-discord', audiences: ['public'] }, github: { value: 'browser-private-github', audiences: [] }, line: { value: '', audiences: [] } })]);
    await pool.query('INSERT INTO positioning_guild_officers(community_id,guild_key,user_id) VALUES($1,$2,$3) ON CONFLICT(community_id,guild_key) DO UPDATE SET user_id=$3', [DEMO_COMMUNITY, guild, ids[0]]);
    await login(page); const card = page.getByRole('article', { name: '活動與空間公會', exact: true });
    await card.locator('.guild-leadership').scrollIntoViewIfNeeded();const masterPhoto=card.locator('.guild-master img'),expertPhoto=card.locator(`.guild-expert[data-user-id="${ids[1]}"] img`);for(const [image,id]of [[masterPhoto,ids[0]],[expertPhoto,ids[1]]]as const){await expect(image).toHaveAttribute('src',`/api/v1/members/${id}/avatar?v=1`);await expect.poll(()=>image.evaluate(node=>(node as HTMLImageElement).naturalWidth)).toBe(256);}
    const directory=(await (await page.request.get('/api/v1/guilds/directory')).json()).items.find((item:any)=>item.guild_key===guild);expect(directory.guild_master.avatar_url).toBe(`/api/v1/members/${ids[0]}/avatar?v=1`);expect(directory.guild_experts.find((item:any)=>item.user_id===ids[1]).avatar_url).toBe(`/api/v1/members/${ids[1]}/avatar?v=1`);
    await card.getByRole('button', { name: '查看成員', exact: true }).click(); const panel = card.getByRole('region', { name: '活動與空間公會成員', exact: true });
    await panel.getByRole('searchbox', { name: '搜尋公會成員', exact: true }).fill('Browser');
    await expect(panel.locator('.directory-member')).toHaveCount(2); await expect(panel).not.toContainText(names[2]);
    await expect(panel.locator(`[data-member-id="${ids[0]}"] .guild-member-leader`)).toHaveText('公會長');
    const row = panel.locator(`[data-member-id="${ids[1]}"]`); await row.locator('.directory-member-details > summary').click();
    await expect(row).toContainText('browser-visible-discord'); await expect(row).not.toContainText('browser-private-github'); await expect(row).not.toContainText(ids[1] + '@example.invalid');
    const response = await page.request.get(`/api/v1/members?guild_key=${guild}&search=Browser&sort=nickname&limit=10&offset=0`), data = await response.json();
    expect(response.status()).toBe(200); expect(data.total).toBe(2); expect(data.items.map((item: any) => item.user_id).sort()).toEqual(ids.slice(0, 2).sort());
    expect(data.items.find((item: any) => item.user_id === ids[1]).contacts).toEqual({ discord: 'browser-visible-discord' });
    await pool.query('UPDATE member_avatars SET image_bytes=NULL,aggregate_version=aggregate_version+1 WHERE user_id=$1',[ids[0]]);await page.reload();await expect(card.locator('.guild-master .member-avatar > span')).toHaveText('B');await expect(card.locator('.guild-master img')).toHaveCount(0);
  } finally {
    if (previous) await pool.query('UPDATE positioning_guild_officers SET user_id=$3 WHERE community_id=$1 AND guild_key=$2', [DEMO_COMMUNITY, guild, previous.user_id]);
    else await pool.query('DELETE FROM positioning_guild_officers WHERE community_id=$1 AND guild_key=$2', [DEMO_COMMUNITY, guild]);
    await pool.query('DELETE FROM positioning_guild_experts WHERE user_id=ANY($1::uuid[])',[ids]);
    await pool.query('DELETE FROM platform_admins WHERE admin_id=$1',[adminId]);
    await pool.query('DELETE FROM member_accounts WHERE user_id=ANY($1::uuid[])', [ids]);
    await pool.query('DELETE FROM guild_member_preferences WHERE user_id=ANY($1::uuid[])', [ids]);
    await pool.query('DELETE FROM positioning_profession_memberships WHERE user_id=ANY($1::uuid[])', [ids]);
    await pool.query('DELETE FROM users WHERE user_id=ANY($1::uuid[])', [ids]);
  }
});


test('onboarding recommendations show the master above three separate expert rows and retain guild selection',async({page})=>{
  await page.route('**/api/v1/guilds/directory',async route=>{const response=await route.fetch(),value=await response.json();value.items=value.items.map((guild:any)=>({...guild,guild_master:{user_id:'synthetic-master',display_name:'推薦公會會長'},guild_experts:[{user_id:'synthetic-master',display_name:'推薦公會會長'},{user_id:'synthetic-expert-2',display_name:'第二位專家'},{user_id:'synthetic-expert-3',display_name:'第三位專家'}]}));return route.fulfill({response,json:value});});
  await page.goto('/');await page.getByRole('button',{name:'建立帳號',exact:true}).click();await page.getByLabel('喜歡的暱稱',{exact:true}).fill('公會人物列測試');await page.getByLabel('電子郵件',{exact:true}).fill(`guild-people-${randomUUID()}@example.test`);await page.getByLabel('密碼',{exact:true}).fill('freedom-leadership-test-2026');await page.getByRole('button',{name:'註冊並開始定位',exact:true}).click();
  for(const title of ['你喜歡怎麼做事？','遇到這些情境，你會怎麼做？']){await expect(page.getByRole('heading',{name:title,exact:true})).toBeVisible();for(const question of await page.locator('.quiz-question').all())await question.getByRole('radio').first().check();await page.getByRole('button',{name:'保存，繼續下一步 →',exact:true}).click();}
  await expect(page.getByRole('heading',{name:'你從哪裡來，帶著哪些能力？',exact:true})).toBeVisible();await page.getByRole('button',{name:'保存，繼續下一步 →',exact:true}).click();await page.getByRole('button',{name:'看看適合我的公會',exact:true}).click();
  const card=page.locator('.recommendation-card').first(),rows=card.locator('.guild-leadership-row');await expect(rows).toHaveCount(4);await expect(rows.first().locator('.guild-leadership-name')).toHaveText('推薦公會會長');await expect(rows.first().locator('.guild-leadership-role')).toHaveText('公會長');await expect(rows.nth(1).locator('.guild-leadership-name')).toHaveText('推薦公會會長');await expect(rows.nth(1).locator('.guild-leadership-role')).toHaveText('公會專家');await expect(rows.nth(3).locator('.guild-leadership-name')).toHaveText('第三位專家');await expect(rows.locator('.member-avatar')).toHaveCount(4);await expect(rows.locator('img')).toHaveCount(0);
  await page.setViewportSize({width:320,height:844});await card.locator('.guild-leadership').scrollIntoViewIfNeeded();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:'test-results/onboarding-guild-leadership-phone.png'});await card.getByRole('checkbox').check();await card.getByRole('radio').check();await expect(page.getByRole('button',{name:'確認加入公會，領取技能書',exact:true})).toBeEnabled();
});


test('leadership avatars fall back safely and the phone layout keeps names readable with compact guild controls',async({page})=>{
  const missingId='aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',missingUrl=`/api/v1/members/${missingId}/avatar?v=1`;let imageReads=0,externalReads=0;
  await fixtureGuilds(page);await page.route('**/api/v1/guilds/directory',route=>route.fulfill({json:{items:[{...guilds[0],guild_master:{user_id:missingId,display_name:'圖片已移除的會長',avatar_url:missingUrl},guild_experts:[{user_id:'emoji-expert',display_name:'👩🏽‍💻 跨領域創作者',avatar_url:null},{user_id:'external-expert',display_name:'活動影像設計專家',avatar_url:'https://avatars.example.invalid/untrusted-photo.png'},{user_id:'missing-expert',display_name:'長名字也應該可以清楚閱讀的專業協作者',avatar_url:null}]},{...guilds[1],guild_master_nominee:{display_name:'預定會長',state:'pending'}}]}}));
  await page.route(`**${missingUrl}`,route=>{imageReads++;return route.fulfill({status:404,json:{detail:'頭像已移除'}});});await page.route('https://avatars.example.invalid/**',route=>{externalReads++;return route.abort();});
  await login(page);const card=page.getByRole('article',{name:'活動與空間公會',exact:true}),team=card.locator('.guild-leadership');await team.scrollIntoViewIfNeeded();await expect.poll(()=>imageReads).toBe(1);await expect(card.locator('.guild-master img')).toHaveCount(0);await expect(card.locator('.guild-master .member-avatar > span')).toHaveText('圖');await expect(card.locator('[data-user-id="emoji-expert"] .member-avatar > span')).toHaveText('👩🏽‍💻');await expect(card.locator('[data-user-id="external-expert"] img')).toHaveCount(0);expect(externalReads).toBe(0);
  await expect(page.getByRole('article',{name:'資安公會',exact:true}).locator('.guild-master .member-avatar > span')).toHaveText('預');
  for(const width of [1440,390,320]){
    await page.setViewportSize({width,height:960});await team.scrollIntoViewIfNeeded();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    const geometry=await team.locator('.guild-leadership-row').evaluateAll(nodes=>nodes.map(node=>{const row=node.getBoundingClientRect(),avatar=node.querySelector('.member-avatar')!.getBoundingClientRect(),name=node.querySelector('.guild-leadership-name')!.getBoundingClientRect(),role=node.querySelector('.guild-leadership-role')!.getBoundingClientRect();return {x:row.x,y:row.y,right:row.right,bottom:row.bottom,width:row.width,space:node.querySelector('.guild-leadership-person')!.getBoundingClientRect().width,avatar:{x:avatar.x,right:avatar.right,width:avatar.width},name:{x:name.x,y:name.y,right:name.right,bottom:name.bottom,width:name.width},role:{y:role.y,bottom:role.bottom}};}));
    for(let i=0;i<geometry.length;i++){const row=geometry[i];expect(row.avatar.width).toBeGreaterThanOrEqual(44);expect(row.name.x).toBeGreaterThan(row.avatar.right);expect(row.space).toBeGreaterThanOrEqual(width===320?145:180);expect(row.name.right).toBeLessThanOrEqual(row.right);expect(row.role.y).toBeGreaterThanOrEqual(row.name.bottom);expect(row.role.bottom).toBeLessThanOrEqual(row.bottom);if(i){expect(row.y).toBeGreaterThanOrEqual(geometry[i-1].bottom);expect(row.x).toBeCloseTo(geometry[0].x,0);expect(row.width).toBeCloseTo(geometry[0].width,0);}}
    if(width<760){const hero=await page.locator('.guild-hub-heading').boundingBox(),overview=await page.locator('.guild-overview').boundingBox();expect(hero!.height).toBeLessThan(210);expect(overview!.height).toBeLessThan(85);await page.locator('.guild-hub-heading').evaluate(node=>node.scrollIntoView({block:'start'}));await page.screenshot({path:`test-results/guild-mobile-top-${width}.png`});await team.scrollIntoViewIfNeeded();}
    await page.screenshot({path:`test-results/guild-avatar-layout-${width}.png`});
  }
  expect(externalReads).toBe(0);
});
