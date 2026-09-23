import { navigate } from './navigation.js';
import {test,expect,type Page} from './fixtures.js';

async function login(page:Page,email='maker@local.test'){await page.goto('/');await page.getByLabel('電子郵件',{exact:true}).fill(email);await page.getByLabel('密碼',{exact:true}).fill('freedom-local-demo');await page.getByRole('button',{name:'登入',exact:true}).click();await expect(page.getByRole('button',{name:'我的名片',exact:true})).toBeVisible();}
async function account(page:Page){await page.getByRole('button',{name:'我的名片',exact:true}).click();const editor=page.locator('.social-links-editor');await expect(editor.getByRole('heading',{name:'社群連結',exact:true})).toBeVisible();return editor;}
const link=(index:number,extra:Record<string,unknown>={})=>({link_id:`synthetic-link-${index}`,platform:'facebook',label:`測試粉專 ${index}`,url:`https://www.facebook.com/synthetic${index}`,audiences:[],aggregate_version:1,created_at:'2026-09-23T10:00:00Z',updated_at:'2026-09-23T10:00:00Z',verified:false,...extra});
test.beforeEach(async({page})=>{
  await page.route('**/api/v1/me/github',route=>route.fulfill({json:{configured:false,connected:false,github_user:null}}));
});

test('members add more than five Facebook links, keep per-link privacy, edit and remove through the real API',async({page,browser})=>{
  const ids:string[]=[],context=await browser.newContext();
  try{
    await login(page);let editor=await account(page);const session=await (await page.request.get('/api/v1/session')).json();
    for(let index=0;index<7;index++){
      await editor.getByRole('button',{name:'＋ 新增連結',exact:true}).click();const form=editor.getByRole('form',{name:'新增社群連結',exact:true});await expect(form.getByLabel('不公開',{exact:true})).toBeChecked();
      const platform=index===6?'instagram':'facebook';await form.getByRole('combobox',{name:'平台',exact:true}).selectOption(platform);await form.getByLabel('連結名稱',{exact:true}).fill(`合成共創帳號 ${index}`);await form.getByLabel('連結網址',{exact:true}).fill(platform==='facebook'?`https://www.facebook.com/syntheticworkshop${index}`:'https://www.instagram.com/syntheticworkshop7');
      if(index===6)await form.getByLabel('平台公開',{exact:true}).check();
      const response=page.waitForResponse(value=>new URL(value.url()).pathname==='/api/v1/me/social-links'&&value.request().method()==='POST');await form.getByRole('button',{name:'保存連結',exact:true}).click();const saved=await response;const record=await saved.json();if(record.link_id)ids.push(record.link_id);expect(saved.status()).toBe(201);await expect(editor.locator(`[data-link-id="${record.link_id}"]`)).toBeVisible();
    }
    await expect(editor.locator('.social-link-own-row')).toHaveCount(7);await expect(editor.getByRole('button',{name:'＋ 新增連結',exact:true})).toBeEnabled();
    const visitor=await context.newPage();await login(visitor,'client@local.test');const visible=await (await visitor.request.get(`/api/v1/members/${session.user.user_id}/social-links?limit=6&offset=0`)).json();expect(visible.total).toBe(1);expect(visible.items[0].label).toBe('合成共創帳號 6');expect(JSON.stringify(visible)).not.toContain('syntheticworkshop0');
    await page.reload();editor=page.locator('.social-links-editor');await expect(editor.locator('.social-link-own-row')).toHaveCount(7);await editor.getByRole('button',{name:'編輯 合成共創帳號 0',exact:true}).click();const edit=editor.getByRole('form',{name:'編輯社群連結',exact:true});await edit.getByLabel('連結名稱',{exact:true}).fill('工作室粉絲專頁');await edit.getByLabel('平台好友',{exact:true}).check();await edit.getByLabel('公會夥伴',{exact:true}).check();await expect(edit.getByLabel('不公開',{exact:true})).not.toBeChecked();const update=page.waitForResponse(value=>value.url().endsWith(`/me/social-links/${ids[0]}/edit`));await edit.getByRole('button',{name:'保存連結',exact:true}).click();const updated=await update;expect(updated.request().headers()['if-match']).toBe('"1"');expect((await updated.json()).audiences).toEqual(['friends','guild']);await expect(editor.locator(`[data-link-id="${ids[0]}"]`)).toContainText('平台好友、公會夥伴');
    const remove=page.waitForResponse(value=>value.url().endsWith(`/me/social-links/${ids[0]}/delete`));await editor.getByRole('button',{name:'移除 工作室粉絲專頁',exact:true}).click();const removed=await remove;expect(removed.status()).toBe(200);expect(removed.request().headers()['if-match']).toBe('"2"');await expect(editor.locator('.social-link-own-row')).toHaveCount(6);
    await page.setViewportSize({width:1440,height:960});await editor.scrollIntoViewIfNeeded();await page.screenshot({path:'test-results/social-links-desktop.png'});await page.setViewportSize({width:320,height:844});await editor.getByRole('button',{name:'＋ 新增連結',exact:true}).click();await expect(editor.getByRole('form',{name:'新增社群連結',exact:true})).toBeVisible();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:'test-results/social-links-phone.png'});
  }finally{
    const session=await (await page.request.get('/api/v1/session')).json();const existing=await (await page.request.get('/api/v1/me/social-links?limit=50&offset=0')).json();
    for(const item of existing.items??[])if(ids.includes(item.link_id))await page.request.post(`/api/v1/me/social-links/${item.link_id}/delete`,{headers:{Origin:new URL(page.url()).origin,'X-CSRF-Token':session.csrf_token,'Idempotency-Key':crypto.randomUUID(),'If-Match':`"${item.aggregate_version}"`},data:{}});
    await context.close();
  }
});

test('unknown create results preserve the private draft and retry the same idempotency key',async({page})=>{
  const keys:string[]=[],record=link(1,{label:'我的兩個粉專之一'});let saved=false;
  await page.route('**/api/v1/members/*/social-links?*',route=>route.fulfill({json:{items:[],total:0,next_offset:null}}));
  await page.route('**/api/v1/me/social-links?*',route=>route.fulfill({json:{items:saved?[record]:[],total:saved?1:0,next_offset:null}}));
  await page.route('**/api/v1/me/social-links',route=>{expect(route.request().postDataJSON().audiences).toEqual([]);keys.push(route.request().headers()['idempotency-key']);if(keys.length===1)return route.fulfill({status:503,json:{detail:'回應中斷，連結保存結果尚未確認。'}});saved=true;return route.fulfill({json:record});});
  await login(page);const editor=await account(page);await editor.getByRole('button',{name:'＋ 新增連結',exact:true}).click();const form=editor.getByRole('form',{name:'新增社群連結',exact:true});await form.getByLabel('連結名稱',{exact:true}).fill(record.label);await form.getByLabel('連結網址',{exact:true}).fill(record.url);await form.getByRole('button',{name:'保存連結',exact:true}).click();await expect(editor.getByRole('alert')).toContainText('尚未確認');await expect(form.getByLabel('連結名稱',{exact:true})).toHaveValue(record.label);await expect(form.getByLabel('不公開',{exact:true})).toBeChecked();await form.getByRole('button',{name:'保存連結',exact:true}).click();await expect(editor.getByRole('status')).toHaveText('社群連結已新增。');expect(keys).toHaveLength(2);expect(keys[0]).toBeTruthy();expect(keys[1]).toBe(keys[0]);
});

test('owner pagination offers another add after twenty entries without an artificial platform limit',async({page})=>{
  await page.route('**/api/v1/members/*/social-links?*',route=>route.fulfill({json:{items:[],total:0,next_offset:null}}));
  await page.route('**/api/v1/me/social-links?*',route=>{const offset=Number(new URL(route.request().url()).searchParams.get('offset'));return route.fulfill({json:{items:Array.from({length:offset?7:20},(_,index)=>link(offset+index)),total:27,next_offset:offset?null:20}});});
  await login(page);const editor=await account(page);await expect(editor.locator('.social-link-own-row')).toHaveCount(20);await editor.getByRole('button',{name:'載入更多我的連結',exact:true}).click();await expect(editor.locator('.social-link-own-row')).toHaveCount(27);await expect(editor.getByRole('button',{name:'＋ 新增連結',exact:true})).toBeEnabled();await editor.getByRole('button',{name:'＋ 新增連結',exact:true}).click();await expect(editor.getByRole('form',{name:'新增社群連結',exact:true})).toBeVisible();await expect(editor.getByRole('form',{name:'新增社群連結',exact:true}).getByLabel('不公開',{exact:true})).toBeChecked();
});

test('member rows fetch social links only when expanded and discard removed visibility on reopening',async({page})=>{
  const target='11111111-1111-4111-8111-111111111111';let reads=0,allowed=true;
  await page.route('**/api/v1/members?*',route=>route.fulfill({json:{items:[{user_id:target,nickname:'連結測試夥伴',positioning_title:'共同創作者',primary_guild:null,secondary_guilds:[],capabilities:[],equipment:[],contacts:{},is_self:false,friendship:{state:'none'}}],total:1,next_offset:null}}));
  await page.route(`**/api/v1/members/${target}/social-links?*`,route=>{reads++;const offset=Number(new URL(route.request().url()).searchParams.get('offset'));return route.fulfill({json:{items:allowed?Array.from({length:offset?1:6},(_,index)=>link(offset+index)):[],total:allowed?7:0,next_offset:allowed&&!offset?6:null}});});
  await login(page);await navigate(page, '工坊夥伴');const row=page.getByRole('article',{name:'連結測試夥伴',exact:true});await expect(row).toBeVisible();expect(reads).toBe(0);await row.locator('summary').click();const links=row.locator('.member-social-display');await expect(links.getByRole('link')).toHaveCount(6);await expect(links.getByRole('link').first()).toHaveAttribute('rel',/noopener.*noreferrer/);await expect(links.getByRole('link').first()).toHaveAttribute('target','_blank');await links.getByRole('button',{name:'查看更多社群連結',exact:true}).click();await expect(links.getByRole('link')).toHaveCount(7);await row.locator('summary').click();await expect(links).toHaveCount(0);allowed=false;await row.locator('summary').click();await expect(row.locator('.member-social-display')).toContainText('沒有對你公開的社群連結');await expect(row.locator('.member-social-display').getByRole('link')).toHaveCount(0);expect(reads).toBe(3);
});
