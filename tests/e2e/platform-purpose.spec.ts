import {randomUUID} from 'node:crypto';
import {test, expect, type Page} from './fixtures.js';
import {quickJoin} from './quick-join.js';

async function login(page:Page) {
  await page.getByRole('button',{name:'會員登入',exact:true}).click();
  await page.getByLabel('電子郵件',{exact:true}).fill('maker@local.test');
  await page.getByLabel('密碼',{exact:true}).fill('freedom-local-demo');
  await page.getByRole('button',{name:'登入',exact:true}).click();
}
const entries = [
  {button:'供貨商：展示商品、找合作', target:'supplier', label:'展示商品與供貨條件', heading:'我有東西要賣'},
  {button:'創作者：找案件與推廣合作', target:'showcase', label:'作品與合作案件', heading:'作品與需求'},
  {button:'開發者：找專案與夥伴', target:'tasks', label:'社群專案與任務', heading:'社群任務'},
];

for (const entry of entries) test(`${entry.target} entry survives registration and refresh, retains guild gate and opens the actual module`,async({page})=>{
  await page.setViewportSize({width:390,height:844});await page.goto('/');
  await page.getByRole('button',{name:entry.button,exact:true}).click();
  await expect(page.getByRole('heading',{name:'加入自由工坊',exact:true})).toBeVisible();
  await expect(page.getByLabel('電子郵件',{exact:true})).toBeFocused();
  await expect(page.locator('.purpose-next-destination')).toHaveText(`加入後前往：${entry.label}。`);
  await page.getByLabel('電子郵件',{exact:true}).fill(`entry-${randomUUID()}@example.test`);
  await page.getByLabel('密碼',{exact:true}).fill('freedom-entry-e2e-password');
  await page.getByRole('button',{name:'建立帳號，先逛工坊',exact:true}).click();
  await expect(page.getByRole('region',{name:'快速加入公會'})).toBeVisible();
  await page.reload();
  await expect(page.locator('.welcome-hero')).toContainText(`完成加入後，直接前往「${entry.label}」。`);
  expect((await page.request.get('/api/v1/retail/catalog')).status()).toBe(403);
  await expect(page.getByRole('navigation',{name:'主要工作區'})).toHaveCount(0);
  await quickJoin(page);
  await expect(page).toHaveURL(new RegExp(`#${entry.target}$`));
  await expect(page.getByRole('heading',{name:entry.heading,exact:true,level:1})).toBeVisible();
});

test('existing members reach their chosen entry and can use all six home actions without selecting a permanent role',async({page})=>{
  await page.goto('/');await page.getByRole('button',{name:entries[0].button,exact:true}).click();await login(page);
  await expect(page).toHaveURL(/#supplier$/);
  const actions=[['展示我的商品','supplier','我有東西要賣'],['找合作夥伴','members','工坊夥伴'],['找合作案件','showcase','作品與需求'],['挑商品推廣','retail','我可以賣東西'],['找專案任務','tasks','社群任務'],['分享開發作品','showcase','作品與需求']];
  for(const [label,target,heading] of actions){
    await page.goto('/#home');
    const entry=page.getByRole('region',{name:'商品、創作與開發合作入口'});
    await expect(entry).toBeVisible();
    await expect(page.getByRole('button',{name:'建立貼文',exact:true})).toBeVisible();
    await entry.getByRole('button',{name:label,exact:true}).click();
    await expect(page).toHaveURL(new RegExp(`#${target}$`));
    await expect(page.getByRole('heading',{name:heading,exact:true,level:1})).toBeVisible();
  }
});

test('public purpose is visible before the form on 320px in every theme, keeps original artwork and touch targets',async({page})=>{
  await page.setViewportSize({width:320,height:800});
  for(const theme of ['light','rpg','versefolk']){
    await page.goto('/');await page.evaluate(value=>document.documentElement.dataset.theme=value,theme);
    const entry=page.getByRole('region',{name:'商品、創作與開發合作入口'});
    await expect(entry).toBeVisible();
    for(const role of entries){const button=entry.getByRole('button',{name:role.button,exact:true});await expect(button).toBeVisible();expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);}
    expect((await entry.boundingBox())!.y).toBeLessThan((await page.locator('.login-form-area').boundingBox())!.y);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await expect(page.locator('.login-story .brand-poster img')).toHaveAttribute('src','/brand/freedom-workshop.webp');
    await page.screenshot({path:`test-results/platform-purpose-${theme}-320.png`,fullPage:true});
  }
});

test('closed registration offers login and does not create an extra registration path',async({page})=>{
  await page.route('**/api/v1/site',async route=>{const response=await route.fetch();await route.fulfill({response,json:{...await response.json(),registration_enabled:false}});});
  await page.goto('/');await page.getByRole('button',{name:entries[2].button,exact:true}).click();
  await expect(page.getByRole('heading',{name:'登入',exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'建立帳號',exact:true})).toHaveCount(0);
  await expect(page.getByLabel('電子郵件',{exact:true})).toBeFocused();
});

for(const width of [320,390])test(`phone login error separates submit and recovery, keeps tools collapsed and fits all themes (${width}px)`,async({page})=>{
  await page.setViewportSize({width,height:844});
  await page.route('**/api/v1/site',async route=>{const response=await route.fetch();await route.fulfill({response,json:{...await response.json(),password_recovery_enabled:true}});});
  for(const theme of ['light','rpg','versefolk']){
    await page.goto('/');await page.evaluate(value=>document.documentElement.dataset.theme=value,theme);
    const card=page.locator('.login-card');
    await expect(card.getByRole('button',{name:'提出想法',exact:true})).toHaveCount(0);
    await page.getByLabel('電子郵件',{exact:true}).fill('mobile-login-error@example.test');
    await page.getByLabel('密碼',{exact:true}).fill('invalid-mobile-password');
    const submit=card.getByRole('button',{name:'登入',exact:true}),recovery=card.getByRole('button',{name:'忘記密碼？',exact:true});
    await submit.click();await expect(card.getByRole('alert')).toBeVisible();
    const primary=(await submit.boundingBox())!,secondary=(await recovery.boundingBox())!;
    expect(secondary.y-primary.y-primary.height).toBeGreaterThanOrEqual(12);
    expect(primary.height).toBeGreaterThanOrEqual(44);expect(secondary.height).toBeGreaterThanOrEqual(44);
    expect(secondary.width).toBeLessThan(primary.width);
    expect(await card.evaluate(element=>element.scrollWidth<=element.clientWidth)).toBe(true);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    for(const label of ['電子郵件','密碼'])expect(await page.getByLabel(label,{exact:true}).evaluate(element=>parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(16);
    await card.scrollIntoViewIfNeeded();await page.screenshot({path:`test-results/mobile-login-error-${theme}-${width}.png`});
    await recovery.click();await expect(page.getByRole('heading',{name:'忘記密碼',exact:true})).toBeVisible();
    await card.getByRole('button',{name:'返回登入',exact:true}).click();await expect(page.getByRole('heading',{name:'登入',exact:true})).toBeVisible();
    const trigger=card.locator('.page-tools-menu > summary');await trigger.click();
    await card.getByRole('button',{name:'頁面說明',exact:true}).click();
    const help=page.getByRole('dialog');await expect(help).toBeVisible();await help.getByRole('button',{name:'關閉',exact:true}).click();
    await expect(trigger).toBeFocused();
  }
});
