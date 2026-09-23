import {test,expect,type Page} from '@playwright/test';

const metadata=(book_id:string,extra:Record<string,unknown>={})=>({book_id,published_at:null,official_guild_keys:[],is_new_today:false,week_rank:null,month_rank:null,week_stars:0,month_stars:0,...extra});
const discovery={as_of:'2026-09-23T14:00:00Z',timezone:'Asia/Taipei',ranking_basis:'distinct_verified_workshop_stars',books:[metadata('social-post',{official_guild_keys:['marketing'],week_rank:2,month_rank:1,week_stars:2,month_stars:7}),metadata('video-autopilot',{week_rank:1,month_rank:2,week_stars:5,month_stars:6}),metadata('event-space',{is_new_today:true,published_at:'2026-09-23T08:00:00Z'})],weekly:[{book_id:'video-autopilot',rank:1,stars:5},{book_id:'social-post',rank:2,stars:2}],monthly:[{book_id:'social-post',rank:1,stars:7},{book_id:'video-autopilot',rank:2,stars:6}]};
test.beforeEach(async({page})=>{
  await page.route('**/api/v1/me/github',route=>route.fulfill({json:{configured:false,connected:false,github_user:null}}));
  await page.route('**/api/v1/github/books/*/metrics',route=>route.fulfill({json:{repository_url:null,stargazers_count:null,forks_count:null,open_issues_count:null,subscribers_count:null,pushed_at:null,language:null,checked_at:null,stale:false,error:'fixture'}}));
});
async function library(page:Page){
  await page.goto('/');await page.getByLabel('電子郵件',{exact:true}).fill('maker@local.test');await page.getByLabel('密碼',{exact:true}).fill('freedom-local-demo');await page.getByRole('button',{name:'登入',exact:true}).click();await page.getByRole('button',{name:'自由工坊社群',exact:true}).click();return page.locator('.community-library');
}
test('one discovery request supplies card and dialog badges; week and month use actual ranked order',async({page})=>{
  let reads=0;await page.route('**/api/v1/skills/discovery',route=>{reads++;return route.fulfill({json:discovery});});
  const lib=await library(page),social=lib.locator('article[data-book-id="social-post"]');
  await expect(social.getByText('官方公會技能',{exact:true})).toBeVisible();await expect(social.getByText('工坊週榜 #2',{exact:true})).toBeVisible();
  await social.getByRole('button',{name:'閱讀技能書',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'Hao 社群貼文技能書',exact:true});await expect(dialog.getByText('官方公會技能',{exact:true})).toBeVisible();await expect(dialog.getByRole('link',{name:'交給 Agent ↗',exact:true})).toHaveAttribute('href','/development/skills/social-post/SKILL.md');await expect(dialog.getByRole('link',{name:'查看里程碑與任務 ↗',exact:true})).toHaveAttribute('href','/development/skills/social-post');
  await page.keyboard.press('Escape');expect(reads).toBe(1);
  await lib.getByRole('button',{name:'工坊週榜',exact:true}).click();await expect(lib.locator('article.skill-library-book')).toHaveCount(2);await expect(lib.locator('article.skill-library-book').first()).toHaveAttribute('data-book-id','video-autopilot');await expect(lib).toContainText('不是 GitHub 總星數');
  await lib.getByRole('button',{name:'工坊月榜',exact:true}).click();await expect(lib.locator('article.skill-library-book').first()).toHaveAttribute('data-book-id','social-post');
  await lib.getByRole('button',{name:'每日新技能',exact:true}).click();await expect(lib.locator('article.skill-library-book')).toHaveCount(1);await expect(lib.locator('article.skill-library-book').first()).toHaveAttribute('data-book-id','event-space');
  await page.setViewportSize({width:320,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);expect(reads).toBe(1);
});
test('sharing copies the public cooperation page and falls back to a selectable link when clipboard fails',async({page})=>{
  await page.route('**/api/v1/skills/discovery',route=>route.fulfill({json:discovery}));
  await page.addInitScript(()=>{Object.defineProperty(navigator,'share',{value:undefined,configurable:true});Object.defineProperty(navigator,'clipboard',{value:{writeText:async(value:string)=>{(window as any).__copied=value;}},configurable:true});});
  const lib=await library(page);await lib.getByLabel('搜尋技能書',{exact:true}).fill('社群貼文');const card=lib.locator('article[data-book-id="social-post"]');
  await card.getByRole('button',{name:'分享技能',exact:true}).click();await expect(card.getByText('已複製技能連結',{exact:true})).toBeVisible();expect(await page.evaluate(()=>(window as any).__copied)).toBe('http://127.0.0.1:4311/development/skills/social-post');
  await page.evaluate(()=>{Object.defineProperty(navigator,'clipboard',{value:{writeText:async()=>{throw new Error('denied');}},configurable:true});});
  await card.getByRole('button',{name:'分享技能',exact:true}).click();await expect(card.getByText('已複製技能連結',{exact:true})).toHaveCount(0);const manual=card.getByLabel('技能分享連結',{exact:true});await expect(manual).toHaveValue('http://127.0.0.1:4311/development/skills/social-post');await manual.focus();expect(await manual.evaluate(element=>(element as HTMLInputElement).selectionEnd)).toBe((await manual.inputValue()).length);
});
test('native share cancellation never reports a completed share or copies without the member choosing it',async({page})=>{
  await page.route('**/api/v1/skills/discovery',route=>route.fulfill({json:discovery}));
  await page.addInitScript(()=>{Object.defineProperty(navigator,'share',{value:async(value:ShareData)=>{(window as any).__shared=value;throw new DOMException('cancelled','AbortError');},configurable:true});Object.defineProperty(navigator,'clipboard',{value:{writeText:async()=>{(window as any).__copied=true;}},configurable:true});});
  const lib=await library(page);await lib.getByLabel('搜尋技能書',{exact:true}).fill('社群貼文');const card=lib.locator('article[data-book-id="social-post"]');await card.getByRole('button',{name:'分享技能',exact:true}).click();await expect(card.getByRole('button',{name:'分享技能',exact:true})).toBeEnabled();await expect(card.locator('.skill-share-status')).toHaveCount(0);expect(await page.evaluate(()=>(window as any).__copied)).toBeUndefined();expect(await page.evaluate(()=>(window as any).__shared.url)).toBe('http://127.0.0.1:4311/development/skills/social-post');
});
test('empty rankings are distinct from an unavailable discovery service and can be retried',async({page})=>{
  let broken=true;await page.route('**/api/v1/skills/discovery',route=>broken?route.fulfill({status:503,json:{detail:'unavailable'}}):route.fulfill({json:{...discovery,books:discovery.books.map(book=>({...book,week_rank:null,month_rank:null})),weekly:[],monthly:[]}}));
  const lib=await library(page);await lib.getByRole('button',{name:'工坊週榜',exact:true}).click();await expect(lib.getByRole('alert')).toContainText('暫時無法載入');await expect(lib).not.toContainText('目前還沒有上榜');broken=false;await lib.getByRole('button',{name:'重讀徽章與榜單',exact:true}).click();await expect(lib.getByRole('alert')).toHaveCount(0);await expect(lib).toContainText('目前還沒有上榜的技能書');await expect(lib.locator('article.skill-library-book')).toHaveCount(0);await lib.getByRole('button',{name:'全部技能',exact:true}).click();await expect(lib.locator('article.skill-library-book')).toHaveCount(25);
});
