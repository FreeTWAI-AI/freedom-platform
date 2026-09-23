// Live public deployment verification. Creates exactly one clearly synthetic member.
// The operator must deactivate that member afterward using the private run record.
// No database credentials, demo users, Cloudflare changes, or business writes.
import { chromium, request, expect as baseExpect } from '@playwright/test';
import { randomUUID, randomBytes } from 'node:crypto';
import sharp from 'sharp';
import { mkdir, chmod, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const target = new URL(process.env.FREEDOM_PUBLIC_ORIGIN ?? 'https://freetwai.com');
if (target.protocol !== 'https:' || target.username || target.password || target.pathname !== '/' || target.search || target.hash) {
  throw new Error('FREEDOM_PUBLIC_ORIGIN must be a plain HTTPS origin.');
}
const origin = target.origin;
async function navigate(page, name) {
  await expect(page.locator('.shell')).toBeVisible();
  const menu=page.getByRole('button',{name:'開啟選單',exact:true});
  if(await menu.isVisible())await menu.click();
  const nav=page.getByRole('navigation',{name:'主要工作區',includeHidden:true});
  await expect(nav).toBeVisible();
  const target=nav.getByRole('button',{name,exact:true,includeHidden:true});
  await expect(target).toHaveCount(1);
  const group=target.locator('xpath=ancestor::details[1]');
  if(await group.count()&&!await group.evaluate(element=>element.open))await group.locator(':scope > summary').click();
  await target.click();
}

// Unlike the test runner, this live script does not inherit playwright.config.
// Allow the actual HTTPS/Access route its bounded network budget.
const expect=baseExpect.configure({timeout:20000});
const evidence = join(homedir(), '.local/state/freedom-public/verification');
await mkdir(evidence, { recursive: true, mode: 0o700 });
await chmod(evidence, 0o700);
const runId = randomUUID();
const accountFile = join(evidence, 'verification-account.json');
const runFile = join(evidence, `verification-account-${runId}.json`);
const email = `verification-${runId}@example.invalid`;
const nickname = `部署驗證・測試帳號 ${runId.slice(0, 8)}`;
const password = randomBytes(36).toString('base64url');
const privateContact = `deployment.verify.${runId.slice(0, 8)}`;
const secrets = [password];
const errors = [];
const redact = value => secrets.reduce((text, secret) => secret ? text.split(secret).join('[REDACTED]') : text, String(value));
const record = {
  run_id: runId,
  origin,
  started_at: new Date().toISOString(),
  user_id: null,
  email,
  nickname,
  synthetic: true,
  purpose: 'public deployment verification; deactivate this synthetic member after verification',
  status: 'not_registered',
  cleanup_required: false,
  completed_at: null,
};
let previousAccounts = [];
try {
  const previous = JSON.parse(await readFile(accountFile, 'utf8'));
  previousAccounts = Array.isArray(previous.created_accounts)
    ? previous.created_accounts
    : previous.user_id ? [{ run_id: previous.run_id, user_id: previous.user_id, email: previous.email }] : [];
} catch (error) {
  if (error?.code !== 'ENOENT') throw new Error('Existing private verification-account.json could not be read; preserve it and inspect before another run.');
}
async function privateJson(path, value) {
  await writeFile(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await chmod(path, 0o600);
}
async function saveRecord() {
  const own = record.user_id ? [{ run_id: runId, user_id: record.user_id, email }] : [];
  await privateJson(runFile, record);
  await privateJson(accountFile, { ...record, created_accounts: [...previousAccounts, ...own] });
}
await saveRecord();
const anonymous = await request.newContext({ timeout: 30000, ignoreHTTPSErrors: false });
let browser;
let context;
let page;
let stage = 'anonymous site';
async function screenshot(name) {
  const path = join(evidence, name);
  await page.screenshot({ path, fullPage: true });
  await chmod(path, 0o600);
}
async function noOverflow(label) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), label).toBe(true);
}
async function noVisibleError() {
  await expect(page.getByRole('alert')).toHaveCount(0);
}
try {
  const landing = await anonymous.get(origin, { maxRedirects: 0 });
  expect(landing.status(), 'Public landing must load directly without an Access redirect').toBe(200);
  expect(landing.headers().location ?? '', 'Public landing must not redirect to Access').not.toContain('cloudflareaccess.com');
  const siteResponse = await anonymous.get(origin + '/api/v1/site', { maxRedirects: 0 });
  expect(siteResponse.status()).toBe(200);
  const site = await siteResponse.json();
  expect(site).toMatchObject({ brand: '自由工坊', public_mode: true, registration_enabled: true, demo_accounts_enabled: false });
  const brandResponse = await anonymous.get(origin + '/brand/freedom-workshop.webp', { maxRedirects: 0 });
  expect(brandResponse.status()).toBe(200);
  expect(brandResponse.headers()['content-type']).toContain('image/');
  expect((await brandResponse.body()).byteLength).toBeGreaterThan(1000);
  for (const name of ['workshop-hub','skill-codex','cooperation-forge','market-network']) {
    const art = await anonymous.get(origin + '/art/rpg/' + name + '.webp', { maxRedirects: 0 });
    expect(art.status(), name).toBe(200);
    expect(art.headers()['content-type']).toContain('image/webp');
    expect((await art.body()).byteLength).toBeGreaterThan(1000);
  }
  expect((await anonymous.get(origin + '/api/v1/session', { maxRedirects: 0 })).status()).toBe(401);
  for(const path of ['/admin','/admin/api/bootstrap','/admin/api/guilds/guild_security/master-candidates']) {
    const admin=await anonymous.get(origin+path,{maxRedirects:0});
    expect(admin.status()).toBe(302);expect(admin.headers().location).toContain('cloudflareaccess.com');
  }
  console.log('Public HTTPS landing, admin Access boundary, anonymous boundary and brand asset: PASS');
  const mapResponse=await anonymous.get(origin+'/api/v1/development-map');
  expect(mapResponse.status()).toBe(200);const development=await mapResponse.json();
  expect(development.pages).toHaveLength(21);expect(development.repositories).toHaveLength(31);expect(development.skill_books).toHaveLength(25);
  expect(JSON.stringify(development)).not.toMatch(/user_id|access_token|csrf_token/);
  for(const path of ['/llms.txt','/development','/development/guilds.md','/development/skills/security-scanner']){
    const response=await anonymous.get(origin+path);expect(response.status(),path).toBe(200);
    expect((await response.text()).length).toBeGreaterThan(100);
  }
  console.log('Anonymous Agent discovery, 21 page guides, 31 repository guides and 25 skill books: PASS');
  const discoveryResponse=await anonymous.get(origin+'/api/v1/skills/discovery');
  expect(discoveryResponse.status()).toBe(200);
  const discovery=await discoveryResponse.json();expect(discovery.books).toHaveLength(25);
  expect(discovery.timezone).toBe('Asia/Taipei');
  expect(JSON.stringify(discovery)).not.toMatch(/github_user_id|client_secret|csrf_token/);
  for(const id of ['video-autopilot','event-space','projection-mapping','human-design']){
    const share=await anonymous.get(origin+'/development/skills/'+id);expect(share.status()).toBe(200);
    const html=await share.text();expect(html).toContain('og:image');expect(html).toContain('SKILL.md');
    const skill=await anonymous.get(origin+'/development/skills/'+id+'/SKILL.md');expect(skill.status()).toBe(200);
    expect(await skill.text()).toMatch(/^---\nname:/);
    const cooperation=await anonymous.get(origin+'/api/v1/skills/'+id+'/collaboration');expect(cooperation.status()).toBe(200);
    const guide=await cooperation.json();expect(guide.book_id).toBe(id);expect(guide.repository.fork_url).toMatch(/^https:\/\/github\.com\//);expect(Array.isArray(guide.tasks)).toBe(true);if(!guide.editorial)expect(guide.tasks.length).toBeGreaterThan(0);
  }
  for(const pageId of ['home','guilds','guild-workspace','admin']){
    const skill=await anonymous.get(origin+'/development/'+pageId+'/SKILL.md');expect(skill.status()).toBe(200);expect(await skill.text()).toMatch(/^---\nname:/);
  }
  console.log('Public share metadata, 25-book discovery and readable skill/page Agent instructions: PASS');


  browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH } : {}) });
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, ignoreHTTPSErrors: false });
  page = await context.newPage();
  page.setDefaultTimeout(20000);
  page.on('pageerror', error => errors.push(redact(error.message)));
  await page.goto(origin, { waitUntil: 'networkidle' });
  expect(new URL(page.url()).origin).toBe(origin);
  await expect(page.locator('.demo-banner')).toHaveCount(0);
  await expect(page.getByRole('complementary', { name: '示範帳號' })).toHaveCount(0);
  await expect(page.locator('.brand-poster img')).toBeVisible();
  expect(await page.locator('.brand-poster img').evaluate(image => image.complete && image.naturalWidth > 0)).toBe(true);
  await screenshot('public-landing-desktop.png');
  await page.setViewportSize({ width: 390, height: 844 });
  await noOverflow('Anonymous mobile landing overflow');
  await screenshot('public-landing-mobile.png');
  await page.setViewportSize({ width: 1440, height: 1000 });

  stage = 'registration';
  await page.getByRole('button', { name: '建立帳號', exact: true }).click();
  await page.getByLabel('喜歡的暱稱', { exact: true }).fill(nickname);
  await page.getByLabel('電子郵件', { exact: true }).fill(email);
  await page.getByLabel('密碼', { exact: true }).fill(password);
  const registrationPromise = page.waitForResponse(response => response.url() === origin + '/api/v1/auth/register' && response.request().method() === 'POST');
  // Preserve an exact synthetic email even when a connection dies after the server creates the account.
  record.status = 'registration_attempted';
  record.cleanup_required = true;
  await saveRecord();
  await page.getByRole('button', { name: '註冊並開始定位', exact: true }).click();
  const registration = await registrationPromise;
  expect(registration.status(), 'Synthetic member registration').toBe(201);
  const registered = await registration.json();
  if (typeof registered.csrf_token === 'string') secrets.push(registered.csrf_token);
  const registeredId = registered.user?.user_id;
  if (typeof registeredId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(registeredId)) {
    throw new Error('Registration did not provide a valid cleanup user ID.');
  }
  record.user_id = registeredId;
  record.status = 'registered';
  await saveRecord();
  const sessionCookie = (await context.cookies(origin)).find(cookie => cookie.name === 'freedom_local_session');
  if (sessionCookie) secrets.push(sessionCookie.value);
  expect(Boolean(sessionCookie?.secure && sessionCookie?.httpOnly && sessionCookie?.sameSite === 'Strict'), 'HTTPS session must be Secure, HttpOnly and SameSite Strict').toBe(true);
  await expect(page.getByRole('heading', { name: '你喜歡怎麼做事？', exact: true })).toBeVisible();
  await expect(page.getByRole('navigation', { name: '主要工作區' })).toHaveCount(0);
  const blocked = await page.request.get(origin + '/api/v1/retail/catalog');
  expect(blocked.status()).toBe(403);
  expect((await blocked.json()).code).toBe('onboarding_required');
  expect((await page.request.get(origin + '/api/v1/members')).status()).toBe(403);
  await page.goto(origin + '/#retail', { waitUntil: 'networkidle' });
  await expect(page.getByRole('heading', { name: '你喜歡怎麼做事？', exact: true })).toBeVisible();
  await expect(page.getByRole('navigation', { name: '主要工作區' })).toHaveCount(0);
  console.log('Real signup, secure session and server-enforced pre-onboarding access denial: PASS');

  stage = 'mandatory orientation';
  await expect(page.getByRole('heading', { name: '你喜歡怎麼做事？', exact: true })).toBeVisible();
  await expect(page.locator('.quiz-question')).toHaveCount(6);
  for (const field of await page.locator('.quiz-question').all()) await field.getByRole('radio').first().check();
  await page.getByRole('button', { name: '保存，繼續下一步 →', exact: true }).click();
  await expect(page.getByRole('heading', { name: '遇到這些情境，你會怎麼做？', exact: true })).toBeVisible();
  await expect(page.locator('.quiz-question')).toHaveCount(9);
  for (const field of await page.locator('.quiz-question').all()) await field.getByRole('radio').first().check();
  await page.getByRole('button', { name: '保存，繼續下一步 →', exact: true }).click();
  await expect(page.getByRole('heading', { name: '你從哪裡來，帶著哪些能力？', exact: true })).toBeVisible();
  await page.getByLabel('你的職業／目前身分').fill('部署驗證用合成測試帳號');
  await page.getByLabel('剛開始探索，想從基礎學起', { exact: true }).check();
  await page.getByLabel('精選能力：剛開始探索，想從基礎學起', { exact: true }).check();
  await page.setViewportSize({width:390,height:844});
  await expect(page.locator('.category-group > .tree-toggle').first()).toHaveAttribute('aria-expanded','false');
  await noOverflow('Mobile collapsed skill tree overflow');
  await screenshot('public-skills-mobile.png');
  await page.setViewportSize({width:1440,height:1000});
  await expect(page.getByLabel('剛開始探索，想從基礎學起', { exact: true })).toBeChecked();
  await page.getByRole('button', { name: '保存，繼續下一步 →', exact: true }).click();
  await expect(page.getByRole('heading', { name: '你的裝備庫', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '看看適合我的公會', exact: true }).click();
  await expect(page.locator('.recommendation-card')).toHaveCount(3);
  const recommendation = page.locator('.recommendation-card').first();
  await recommendation.getByRole('checkbox').check();
  await recommendation.getByRole('radio').check();
  await page.getByRole('button', { name: '確認加入公會，領取技能書', exact: true }).click();
  await expect(page.getByRole('heading', { name: '你的第一段旅程，現在開始。', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '閱讀技能書', exact: true }).first().click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('dialog').getByRole('link', { name: '閱讀技能書 ↗', exact: true })).toBeVisible();
  await page.getByRole('button', {name:'關閉技能書介紹',exact:true}).click();
  await screenshot('public-onboarding-completed.png');
  await page.getByRole('button', { name: '進入自由工坊 →', exact: true }).click();
  await expect(page.locator('.shell')).toBeVisible();
  await expect(page.locator('.demo-banner')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '會員首頁', exact: true })).toBeVisible();
  const completed = await page.request.get(origin + '/api/v1/me/onboarding');
  expect(completed.status()).toBe(200);
  const onboarding = await completed.json();
  expect(onboarding.completed).toBe(true);
  expect(onboarding.required).toBe(false);
  expect(typeof onboarding.primary_guild_key).toBe('string');
  expect(onboarding.skill_books.length).toBeGreaterThan(0);
  record.status = 'orientation_completed';
  await saveRecord();
  await screenshot('public-member-home-desktop.png');
  console.log('Full 15-question preference and ability assessment, explicit primary Guild and skill-book grants: PASS');

  stage = 'completed positioning result';
  await navigate(page, '我的定位');
  await expect(page.getByRole('heading', { name: '我的定位結果', exact: true })).toBeVisible();
  await expect(page.locator('.positioning-result')).toContainText('主要公會');
  await expect(page.getByRole('heading',{level:1})).toHaveCount(1);
  await expect(page.locator('.positioning-heading')).toHaveCount(0);
  await page.getByRole('link',{name:'跳到主要內容',exact:true}).focus();await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/#positioning$/);await expect(page.locator('#main-content')).toBeFocused();
  await expect(page.getByText('合作偏好（選填）', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('我現在想完成的事')).toHaveCount(0);
  await expect(page.getByLabel('搜尋職業方向')).toHaveCount(0);
  await expect(page.getByRole('button', {name:'重新探索定位',exact:true})).toBeVisible();
  expect((await (await page.request.get(origin + '/api/v1/me/positioning')).json()).profile).toBeNull();
  await screenshot('public-positioning-result.png');
  console.log('Completed positioning shows published result without requiring another profile: PASS');

  stage = 'skill-book cover delivery';
  const covers=JSON.parse(await readFile(new URL('../docs/design/skill-book-art-manifest.json',import.meta.url),'utf8')).assets;
  expect(covers).toHaveLength(25);
  for(const cover of covers){
    const image=await anonymous.get(origin+'/art/skills/'+cover.id+'.webp');
    expect(image.status()).toBe(200);
    expect(image.headers()['content-type']).toContain('image/webp');
    const metadata=await sharp(await image.body()).metadata();
    expect(metadata.width).toBe(cover.width);
    expect(metadata.height).toBe(cover.height);
  }
  console.log('All 25 distinct skill-book covers delivered over HTTPS: PASS');

  stage = 'member card and privacy';
  await page.getByRole('button', { name: '我的名片', exact: true }).click();
  await expect(page.getByRole('heading', { name: '我的名片', level: 1, exact: true })).toBeVisible();
  const avatarFixture=await sharp({create:{width:320,height:240,channels:3,background:'#3044ff'}}).png().toBuffer();
  const editor=page.locator('.avatar-editor');
  await editor.getByLabel('選擇頭像',{exact:true}).setInputFiles({name:'synthetic-verification.png',mimeType:'image/png',buffer:avatarFixture});
  await expect(editor.getByRole('img',{name:'頭像預覽',exact:true})).toBeVisible();
  await editor.getByRole('button',{name:'保存頭像',exact:true}).click();
  await expect(editor.getByRole('status')).toHaveText('頭像已保存，工坊夥伴現在可以看見。');
  const avatarUrl=(await (await page.request.get(origin+'/api/v1/me/avatar')).json()).avatar_url;
  expect(typeof avatarUrl).toBe('string');
  expect((await anonymous.get(origin+avatarUrl)).status()).toBe(401);
  await page.reload({waitUntil:'networkidle'});
  await expect(page.locator('.member-card .member-avatar-photo img')).toHaveAttribute('src',avatarUrl);
  await expect.poll(()=>page.locator('.member-card .member-avatar-photo img').evaluate(image=>image.naturalWidth)).toBe(256);
  await editor.getByRole('button',{name:'移除頭像',exact:true}).click();
  await expect(editor.getByRole('status')).toHaveText('頭像已移除。');
  expect((await page.request.get(origin+avatarUrl)).status()).toBe(404);
  console.log('Own avatar HTTPS upload, normalized image, private visibility, reload and removal: PASS');
  await page.getByLabel('Discord 帳號', { exact: true }).fill(privateContact);
  const audiences = page.getByRole('group', { name: 'Discord 帳號可見範圍', exact: true });
  await audiences.getByRole('checkbox', { name: '平台好友', exact: true }).check();
  await audiences.getByRole('checkbox', { name: '公會夥伴', exact: true }).check();
  await page.getByRole('button', { name: '保存個人資料與公開範圍', exact: true }).click();
  await expect(page.getByText('個人資料與每一項聯絡方式的可見範圍已保存。', { exact: true })).toBeVisible();
  const accountResponse = await page.request.get(origin + '/api/v1/me/account');
  expect(accountResponse.status()).toBe(200);
  const account = await accountResponse.json();
  expect(account.contacts.email.value).toBe(email);
  expect(account.contacts.discord.value === privateContact && JSON.stringify([...account.contacts.discord.audiences].sort()) === JSON.stringify(['friends','guild'])).toBe(true);
  stage='multiple social links and per-entry persistence';
  const socialSession=await (await page.request.get(origin+'/api/v1/session')).json();
  secrets.push(socialSession.csrf_token);
  const socialWrite=async(path,body,version)=>{
    const response=await page.request.post(origin+'/api/v1'+path,{headers:{Origin:origin,'X-CSRF-Token':socialSession.csrf_token,'Idempotency-Key':randomUUID(),...(version?{'If-Match':`"${version}"`}:{})},data:body});
    expect(response.ok(),'Synthetic social link write').toBe(true);return response.json();
  };
  const socialBodies=[
    {platform:'facebook',label:'部署驗證粉絲團一',url:'https://www.facebook.com/freedom-verification-'+runId+'-one',audiences:[]},
    {platform:'facebook',label:'部署驗證粉絲團二',url:'https://www.facebook.com/freedom-verification-'+runId+'-two',audiences:[]},
    {platform:'instagram',label:'部署驗證 IG',url:'https://www.instagram.com/freedom_verify_'+runId.slice(0,8)+'/',audiences:[]},
  ];
  const socialEntries=[];
  for(const body of socialBodies)socialEntries.push(await socialWrite('/me/social-links',body));
  const socialPage=await (await page.request.get(origin+'/api/v1/me/social-links?limit=2&offset=0')).json();
  expect(socialPage.total).toBe(3);expect(socialPage.items).toHaveLength(2);expect(socialPage.next_offset).toBe(2);
  const changedLink=await socialWrite('/me/social-links/'+socialEntries[1].link_id+'/edit',{...socialBodies[1],label:'部署驗證粉絲團二・已更新'},socialEntries[1].aggregate_version);
  expect(changedLink.label).toBe('部署驗證粉絲團二・已更新');expect(changedLink.audiences).toEqual([]);
  await socialWrite('/me/social-links/'+socialEntries[0].link_id+'/delete',{},socialEntries[0].aggregate_version);
  const socialPersisted=await (await page.request.get(origin+'/api/v1/me/social-links')).json();
  expect(socialPersisted.total).toBe(2);expect(socialPersisted.items.some(link=>link.link_id===socialEntries[0].link_id)).toBe(false);
  expect((await anonymous.get(origin+'/api/v1/members/'+record.user_id+'/social-links')).status()).toBe(401);
  const visibleSocial=await (await page.request.get(origin+'/api/v1/members/'+record.user_id+'/social-links')).json();
  expect(visibleSocial.total).toBe(2);
  await page.reload({waitUntil:'networkidle'});
  await expect(page.locator('.member-card').getByRole('link',{name:/部署驗證粉絲團二・已更新/})).toBeVisible();
  await expect(page.locator('.member-card').getByRole('link',{name:/部署驗證 IG/})).toBeVisible();
  console.log('Multiple same-platform social links, paged persistence, individual edit/delete and anonymous privacy: PASS');
  stage='member card and directory';
  const selfResponse = await page.request.get(origin + '/api/v1/members/' + record.user_id);
  expect(selfResponse.status()).toBe(200);
  const self = await selfResponse.json();
  expect(self.nickname === nickname && self.primary_guild?.guild_key === onboarding.primary_guild_key).toBe(true);
  expect(typeof self.positioning_title).toBe('string');
  expect(self.capabilities).toContain('getting_started');
  expect(self.featured_capabilities).toEqual(['getting_started']);
  await expect(page.locator('.member-featured .pill')).toHaveCount(1);
  await noVisibleError();
  await screenshot('public-member-card-desktop.png');
  await page.setViewportSize({ width: 390, height: 844 });
  await noOverflow('Member card mobile overflow');
  await screenshot('public-member-card-mobile.png');
  await navigate(page, '職業公會');
  await expect(page.locator('.primary-guild')).toHaveCount(1);
  await expect(page.locator('.primary-guild .guild-master .guild-leadership-role')).toHaveText('公會長');
  await expect(page.locator('.guild-card').first()).toHaveClass(/primary-guild/);
  await expect(page.locator('.guild-card').first().locator('.guild-book-list')).toContainText('入門技能');
  await expect(page.locator('.guild-card').first().locator('.guild-book-list .skill-intro-trigger')).toHaveCount(1);
  const preferenceResponse=await page.request.get(origin+'/api/v1/me/guild-preferences');expect(preferenceResponse.status()).toBe(200);
  const preferences=await preferenceResponse.json();
  expect(preferences.primary_guild_key).toBe(onboarding.primary_guild_key);expect(preferences.secondary_guild_keys.length).toBeLessThanOrEqual(2);
  const featuredGuilds=page.getByRole('region',{name:'主要與次要公會',exact:true});
  await expect(featuredGuilds.locator('.guild-card')).toHaveCount(1+preferences.secondary_guild_keys.length);
  expect(await featuredGuilds.locator('.guild-card').evaluateAll(cards=>cards.map(card=>card.getAttribute('data-guild-key')))).toEqual([preferences.primary_guild_key,...preferences.secondary_guild_keys]);
  await expect(page.getByRole('region',{name:'其他已加入公會',exact:true})).toBeVisible();
  await expect(page.getByRole('region',{name:'未加入公會',exact:true})).toBeVisible();
  for(const width of [1440,390,320]){
    await page.setViewportSize({width,height:960});
    await expect.poll(async()=>page.locator('.guild-card').evaluateAll(cards=>{
      const heights=cards.map(card=>card.getBoundingClientRect().height);return Math.max(...heights)-Math.min(...heights);
    })).toBeLessThanOrEqual(2);
    expect(await page.locator('.guild-card').evaluateAll(cards=>cards.every(card=>card.scrollHeight<=card.clientHeight+1&&card.scrollWidth<=card.clientWidth+1))).toBe(true);
    const teams=page.locator('.guild-card .guild-leadership');
    await expect(teams).toHaveCount(await page.locator('.guild-card').count());
    for(const team of await teams.all()){
      const rows=team.locator('.guild-leadership-row');
      await expect(rows.first()).toHaveClass(/guild-master/);
      expect(await team.locator('.guild-expert').count()).toBeLessThanOrEqual(3);
      let previous;
      for(const row of await rows.all()){
        await expect(row).toBeVisible();const box=await row.boundingBox();expect(box).not.toBeNull();
        const portrait=row.locator('.guild-leadership-avatar'),name=row.locator('.guild-leadership-name'),role=row.locator('.guild-leadership-role');
        await expect(portrait).toBeVisible();await expect(name).toBeVisible();await expect(role).toBeVisible();
        const portraitBox=await portrait.boundingBox(),nameBox=await name.boundingBox(),roleBox=await role.boundingBox();
        expect(portraitBox.width).toBeGreaterThanOrEqual(44);expect(portraitBox.height).toBe(portraitBox.width);
        expect(nameBox.x).toBeGreaterThan(portraitBox.x+portraitBox.width);expect(roleBox.y).toBeGreaterThanOrEqual(nameBox.y+nameBox.height);
        const photo=portrait.locator('img');
        if(await photo.count())await expect(photo).toHaveAttribute('src',/^\/api\/v1\/members\/[0-9a-f-]{36}\/avatar\?v=[1-9][0-9]*$/);
        else await expect(portrait.locator('span')).not.toBeEmpty();
        if(previous){expect(box.y).toBeGreaterThanOrEqual(previous.y+previous.height);expect(Math.abs(box.x-previous.x)).toBeLessThanOrEqual(1);expect(Math.abs(box.width-previous.width)).toBeLessThanOrEqual(1);}
        previous=box;
      }
    }
    await noOverflow('Guild leadership rows overflow');
    await screenshot(width===1440?'public-guild-leadership-desktop.png':`public-guild-leadership-mobile-${width}.png`);
  }
  await page.setViewportSize({width:390,height:844});
  console.log('Guild master first, experts below, portrait/name/role rows on desktop and 390/320 px mobile: PASS');
  await page.locator('.guild-card').first().getByRole('button',{name:'查看成員',exact:true}).click();
  const guildMembers=page.locator('#members-'+onboarding.primary_guild_key);
  await expect(guildMembers).toBeVisible();
  await guildMembers.getByRole('searchbox',{name:'搜尋公會成員',exact:true}).fill(nickname);
  await guildMembers.getByRole('button',{name:'搜尋成員',exact:true}).click();
  await expect(guildMembers.locator('.directory-rows')).toHaveAttribute('aria-busy','false');
  await expect(guildMembers.locator('.directory-member')).toHaveCount(1);
  await expect(guildMembers.locator('.directory-member')).toHaveAttribute('data-member-id',record.user_id);
  await expect(guildMembers).toContainText('顯示 1 / 1 位成員');
  await noOverflow('Guild members mobile overflow');
  await page.locator('.guild-card').first().getByRole('button',{name:'關閉公會視窗',exact:true}).click();
  await expect(guildMembers).toHaveCount(0);
  console.log('Guild member dialog filters only that guild and closes cleanly; three groups and equal-height cards: PASS');
  await page.locator('.guild-card').first().locator('.skill-intro-trigger').first().click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('dialog').getByRole('link',{name:'原作者 GitHub ↗',exact:true})).toHaveAttribute('href',/^https:\/\/github\.com\//);
  await expect(page.getByRole('dialog').getByRole('link',{name:'Fork 專案 ↗',exact:true})).toHaveAttribute('href',/^https:\/\/github\.com\/[^/]+\/[^/]+\/fork$/);
  const social=await (await page.request.get(origin+'/api/v1/me/github')).json();
  await expect(page.getByRole('dialog').getByRole('button',{name:social.configured?'連結 GitHub 後 Star':'GitHub 連結尚未啟用',exact:true})).toBeVisible();
  await page.getByRole('dialog').getByText('練習與設定',{exact:true}).click();
  await expect(page.getByRole('dialog').getByRole('link',{name:'完整指南 ↗',exact:true})).toHaveAttribute('href',/^\/development\/skills\//);
  await noOverflow('Guild skill book introduction mobile overflow');
  await screenshot('public-guild-library-mobile.png');
  await page.getByRole('button',{name:'關閉技能書介紹',exact:true}).click();
  await noVisibleError();
  await noOverflow('Guild mobile overflow');
  await screenshot('public-guilds-mobile.png');
  await expect(page.getByRole('button', { name: '我的名片', exact: true })).toBeVisible();
  await navigate(page, '工坊夥伴');
  await expect(page.getByRole('heading', { name: '工坊夥伴', exact: true }).first()).toBeVisible();
  await expect(page.locator('.member-directory')).toHaveAttribute('aria-busy','false');
  const directoryQuery=new URLSearchParams({search:nickname,guild_key:onboarding.primary_guild_key,sort:'newest',limit:'1'});
  const directoryResponse=await page.request.get(origin+'/api/v1/members?'+directoryQuery);
  expect(directoryResponse.status()).toBe(200);
  const directory=await directoryResponse.json();
  expect(directory.total).toBe(1);expect(directory.next_offset).toBeNull();
  expect(directory.items).toHaveLength(1);
  expect(directory.items[0]).toMatchObject({user_id:record.user_id,joined_at_source:'registered'});
  expect(Number.isFinite(Date.parse(directory.items[0].joined_at))).toBe(true);
  const privateSearch=await page.request.get(origin+'/api/v1/members?'+new URLSearchParams({search:privateContact}));
  expect(privateSearch.status()).toBe(200);expect((await privateSearch.json()).total).toBe(0);
  await page.getByRole('searchbox',{name:'搜尋夥伴',exact:true}).fill(nickname);
  await page.getByRole('button',{name:'搜尋',exact:true}).click();
  await page.getByRole('combobox',{name:'依公會篩選',exact:true}).selectOption(onboarding.primary_guild_key);
  await page.getByRole('combobox',{name:'排序方式',exact:true}).selectOption('oldest');
  await expect(page.locator('.member-directory')).toHaveAttribute('aria-busy','false');
  await expect(page.locator('.directory-member')).toHaveCount(1);
  const directoryRow=page.locator('.directory-member');
  await expect(directoryRow).toHaveAttribute('data-member-id',record.user_id);
  await expect(page.locator('.directory-result-count')).toHaveText('顯示 1 / 1 位夥伴');
  await expect(directoryRow.locator('.directory-member-details')).not.toHaveAttribute('open','');
  await expect(directoryRow.locator('.directory-member-meta time')).toHaveAttribute('datetime',directory.items[0].joined_at);
  await directoryRow.getByText('更多資料',{exact:true}).click();
  await expect(directoryRow.getByText(privateContact,{exact:true})).toBeVisible();
  await expect(directoryRow.getByRole('heading',{name:'公會加入紀錄',exact:true})).toBeVisible();
  await expect(directoryRow.locator('.directory-guild-dates time').first()).toBeVisible();
  await noVisibleError();
  await noOverflow('Member directory mobile overflow');
  // The filtered page contains only this run's synthetic member.
  await screenshot('public-member-directory-mobile.png');
  console.log('Own member card, contact privacy, directory search/Guild filter/sort/joining date/fold and responsive navigation: PASS');

  stage = 'specialist Guilds and real co-creation repository';
  const guildResponse=await page.request.get(origin+'/api/v1/guilds/directory');
  expect(guildResponse.status()).toBe(200);
  const guilds=(await guildResponse.json()).items;
  expect(guilds).toHaveLength(18);
  for(const guild of guilds){
    expect(Array.isArray(guild.guild_experts),'Guild expert projection available after migration').toBe(true);
    for(const person of [guild.guild_master,...guild.guild_experts].filter(Boolean)){
      expect(Object.keys(person).sort()).toEqual(['avatar_url','display_name','user_id']);
      expect(typeof person.display_name).toBe('string');expect(typeof person.user_id).toBe('string');
      if(person.avatar_url!==null)expect(person.avatar_url).toMatch(new RegExp(`^/api/v1/members/${person.user_id}/avatar\\?v=[1-9][0-9]*$`));
    }
  }
  for(const key of ['guild_security','guild_music_mv','guild_commercial_production','guild_event_space','guild_projection_mapping','guild_human_design']) expect(guilds.some(g=>g.guild_key===key)).toBe(true);
  const workspaceResponse=await page.request.get(origin+'/api/v1/guild-workspace');expect(workspaceResponse.status()).toBe(200);
  expect(await workspaceResponse.json()).toMatchObject({managed_guilds:[],managed_books:[],can_discuss:false});
  expect((await page.request.get(origin+'/api/v1/guild-council/threads')).status()).toBe(403);
  await navigate(page, '一起開發');
  await expect(page.getByRole('heading',{name:'一起開發',exact:true}).first()).toBeVisible();
  const liveActivity=await page.request.get(origin+'/api/v1/co-creation/projects/workshop-video-autopilot/activity');
  expect(liveActivity.status()).toBe(200);
  const activity=await liveActivity.json();
  expect(activity.issues.length).toBeGreaterThanOrEqual(5);
  await expect(page.getByRole('button',{name:'複製工作說明',exact:true}).first()).toBeVisible();
  await noVisibleError();await noOverflow('Co-creation mobile overflow');await page.evaluate(()=>scrollTo(0,0));
  await screenshot('public-co-creation-mobile.png');
  await page.setViewportSize({width:1440,height:1000});await page.evaluate(()=>scrollTo(0,0));
  await screenshot('public-co-creation-desktop.png');
  console.log('18 Guilds and real GitHub co-creation Issues through deployed Platform: PASS');

  stage='unlocked and locked skill shelves';
  const publicCatalogResponse=await page.request.get(origin+'/api/v1/community');expect(publicCatalogResponse.status()).toBe(200);
  const fullBookIds=(await publicCatalogResponse.json()).skill_books.map(book=>book.id).sort();
  const grantResponse=await page.request.get(origin+'/api/v1/me/skill-books');expect(grantResponse.status()).toBe(200);
  const granted=(await grantResponse.json()).items.map(book=>book.book_id);
  const unlockedIds=fullBookIds.filter(id=>granted.includes(id)),lockedIds=fullBookIds.filter(id=>!granted.includes(id));
  await navigate(page, '技能書架');
  const library=page.locator('.community-library'),shelfTabs=page.getByRole('group',{name:'技能書範圍'});
  const unlockedTab=shelfTabs.getByRole('button',{name:/^已解鎖(?: · \d+)?$/}),lockedTab=shelfTabs.getByRole('button',{name:'未解鎖',exact:true});
  await expect(unlockedTab).toHaveAttribute('aria-pressed','true');
  await expect(library.locator('article[data-book-id]')).toHaveCount(unlockedIds.length);
  expect(await library.locator('article[data-book-id]').evaluateAll(cards=>cards.map(card=>card.getAttribute('data-book-id')).sort())).toEqual(unlockedIds);
  await expect(library.locator('article[data-access="unlocked"]')).toHaveCount(unlockedIds.length);
  await lockedTab.click();await expect(lockedTab).toHaveAttribute('aria-pressed','true');
  await expect(library.locator('article[data-book-id]')).toHaveCount(lockedIds.length);
  expect(await library.locator('article[data-book-id]').evaluateAll(cards=>cards.map(card=>card.getAttribute('data-book-id')).sort())).toEqual(lockedIds);
  await expect(library.locator('article[data-access="locked"]')).toHaveCount(lockedIds.length);
  expect([...unlockedIds,...lockedIds].sort()).toEqual(fullBookIds);
  // Previewing a public guide does not join a guild or write a skill grant.
  if(lockedIds.length){
    await library.locator('.skill-library-book').first().getByRole('button',{name:'預覽技能書',exact:true}).click();
    const preview=page.getByRole('dialog');await expect(preview).toBeVisible();
    await expect(preview.getByRole('link',{name:'閱讀技能書 ↗',exact:true})).toBeVisible();
    await preview.getByRole('button',{name:'關閉技能書介紹',exact:true}).click();
    expect((await (await page.request.get(origin+'/api/v1/me/skill-books')).json()).items.map(book=>book.book_id)).toEqual(granted);
  }
  // New member onboarding has granted at least its primary guild's first book.
  expect(unlockedIds.length).toBeGreaterThan(0);await unlockedTab.click();
  await expect(library.locator('.skill-library-book')).toHaveCount(unlockedIds.length);
  for(const width of [1440,390,320]){
    await page.setViewportSize({width,height:960});
    const firstBook=library.locator('.skill-library-book').first();
    await firstBook.scrollIntoViewIfNeeded();
    const cover=firstBook.locator('.skill-book-illustration');
    await expect(cover).toBeVisible();
    await expect.poll(()=>cover.evaluate(node=>node.naturalWidth)).toBeGreaterThan(0);
    const coverBox=await cover.boundingBox();
    expect(coverBox.width).toBeLessThanOrEqual(128);expect(coverBox.height).toBeLessThanOrEqual(128);
    await expect(firstBook.getByRole('heading')).toBeVisible();
    await expect(firstBook.getByRole('button',{name:'閱讀技能書',exact:true})).toBeVisible();
    await expect(firstBook.locator('.github-star-control')).toBeVisible();
    await expect(firstBook.locator('.github-star-icon')).toHaveText('☆');
    await expect(firstBook.locator('.github-fork-count')).toBeVisible();
    await noOverflow('Compact unlocked skill shelf overflow');
    await screenshot(`public-compact-skill-library-${width}.png`);
  }
  console.log('Default unlocked shelf and free locked previews form a complete, disjoint catalog; responsive rows: PASS');
  const githubConnection=await (await page.request.get(origin+'/api/v1/me/github')).json();
  if(githubConnection.configured){
    expect(githubConnection.connected).toBe(false);
    const starControl=library.locator('.skill-library-book').first().locator('.github-star-control');
    await expect(starControl).toBeEnabled();
    // Capture only the provider handoff; never authorize or Star as a real person.
    const authorizePattern='https://github.com/login/oauth/authorize?**';
    await page.route(authorizePattern,route=>route.fulfill({contentType:'text/html',body:'<title>Authorization handoff captured</title>'}));
    const connectUrl=origin+'/api/v1/me/github/connect';
    let handoff;
    // Read the real origin response before forwarding it: the app immediately
    // navigates away, after which Chromium may discard the old response body.
    await page.route(connectUrl,async route=>{
      const response=await route.fetch();const body=await response.json();
      handoff={status:response.status(),authorizationUrl:body.authorization_url};
      if(handoff.authorizationUrl)secrets.push(new URL(handoff.authorizationUrl).searchParams.get('state'));
      await route.fulfill({response});
    });
    await starControl.click();
    await page.waitForURL(authorizePattern);
    expect(handoff?.status).toBe(200);
    const authorization=new URL(handoff.authorizationUrl);
    expect(authorization.origin+authorization.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(authorization.searchParams.has('state')).toBe(true);
    await page.unroute(connectUrl);await page.unroute(authorizePattern);await page.goto(origin+'/#skills',{waitUntil:'networkidle'});
    await expect(page.locator('.community-library')).toBeVisible();
    console.log('Visible star icon starts real platform OAuth handoff; provider consent and Star were not submitted: PASS');
  }

  stage = 'grouped mobile navigation';
  const mobileMenu=page.getByRole('button',{name:/^(開啟|關閉)選單$/});
  const memberNavigation=page.getByRole('navigation',{name:'主要工作區',includeHidden:true});
  await expect(memberNavigation).toBeHidden();await mobileMenu.click();await expect(memberNavigation).toBeVisible();
  await expect(memberNavigation.locator('details > summary')).toHaveCount(3);
  await expect(memberNavigation.getByRole('button',{name:'公會管理',exact:true,includeHidden:true})).toHaveCount(0);
  await page.keyboard.press('Escape');await expect(memberNavigation).toBeHidden();await expect(mobileMenu).toBeFocused();
  await navigate(page,'自由工坊社群');await expect(page.locator('.community-library')).toHaveCount(0);
  await page.getByRole('button',{name:'前往技能書架',exact:true}).click();await expect(page).toHaveURL(/#skills$/);
  await navigate(page,'開源投稿');await expect(page.locator('.community-library')).toHaveCount(0);
  await expect(page.getByRole('heading',{name:'登錄開源作品',exact:true})).toBeVisible();
  await expect(memberNavigation).toBeHidden();await noOverflow('Grouped phone menu and source submission overflow');
  console.log('Grouped phone menu, Escape focus, selected-page closure, distinct community/submission and preserved skip-link route: PASS');

  stage = 'logout and fresh login';
  await page.getByRole('button', { name: '登出', exact: true }).click();
  await expect(page.getByRole('heading', { name: '登入', exact: true })).toBeVisible();
  expect((await page.request.get(origin + '/api/v1/session')).status()).toBe(401);
  await page.getByLabel('電子郵件', { exact: true }).fill(email);
  await page.getByLabel('密碼', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登入', exact: true }).click();
  await expect(page.locator('.shell')).toBeVisible();
  await expect(page.locator('.demo-banner')).toHaveCount(0);
  const renewedCookie = (await context.cookies(origin)).find(cookie => cookie.name === 'freedom_local_session');
  if (renewedCookie) secrets.push(renewedCookie.value);
  expect(Boolean(renewedCookie?.secure && renewedCookie?.httpOnly && renewedCookie?.sameSite === 'Strict')).toBe(true);
  await page.getByRole('button', { name: '我的名片', exact: true }).click();
  await expect(page.getByLabel('Discord 帳號', { exact: true })).toHaveValue(privateContact);
  await expect(page.getByRole('group', { name: 'Discord 帳號可見範圍', exact: true }).getByRole('checkbox', { name: '平台好友', exact: true })).toBeChecked();
  await expect(page.getByRole('group', { name: 'Discord 帳號可見範圍', exact: true }).getByRole('checkbox', { name: '公會夥伴', exact: true })).toBeChecked();
  await page.reload({ waitUntil: 'networkidle' });
  await expect(page.getByLabel('Discord 帳號', { exact: true })).toHaveValue(privateContact);
  await noVisibleError();
  await noOverflow('Reloaded mobile account overflow');
  await page.getByRole('button', { name: '登出', exact: true }).click();
  await expect(page.getByRole('heading', { name: '登入', exact: true })).toBeVisible();
  expect((await page.request.get(origin + '/api/v1/session')).status()).toBe(401);
  expect(errors.length, 'Browser JavaScript errors').toBe(0);
  await privateJson(join(evidence, 'page-errors.json'), errors);
  record.status = 'passed';
  record.completed_at = new Date().toISOString();
  await saveRecord();
  console.log('Fresh HTTPS login, reload persistence, final logout and no browser errors: PASS');
  console.log('Private evidence and synthetic-account cleanup record saved: PASS');
} catch (error) {
  record.status = 'failed';
  record.failed_stage = stage;
  await saveRecord();
  await privateJson(join(evidence, `failure-${runId}.json`), { stage, error: redact(error?.stack ?? error), page_errors: errors, occurred_at: new Date().toISOString() });
  if (page) await screenshot(`failure-${runId}.png`).catch(() => {});
  // Playwright exceptions can contain typed input values. Never print their text or stack.
  console.error(`Public deployment verification failed during ${stage}; inspect the private evidence and clean up the recorded synthetic account.`);
  process.exitCode = 1;
} finally {
  await context?.close();
  await browser?.close();
  await anonymous.dispose();
}
