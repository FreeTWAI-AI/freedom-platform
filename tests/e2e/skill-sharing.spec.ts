import { navigate } from './navigation.js';
import {test,expect,type Page} from './fixtures.js';

const metadata=(book_id:string,extra:Record<string,unknown>={})=>({book_id,published_at:null,official_guild_keys:[],is_new_today:false,week_rank:null,month_rank:null,week_stars:0,month_stars:0,...extra});
const discovery={as_of:'2026-09-23T14:00:00Z',timezone:'Asia/Taipei',ranking_basis:'distinct_verified_workshop_stars',books:[metadata('social-post',{official_guild_keys:['marketing'],week_rank:2,month_rank:1,week_stars:2,month_stars:7}),metadata('video-autopilot',{week_rank:1,month_rank:2,week_stars:5,month_stars:6}),metadata('event-space',{is_new_today:true,published_at:'2026-09-23T08:00:00Z'})],weekly:[{book_id:'video-autopilot',rank:1,stars:5},{book_id:'social-post',rank:2,stars:2}],monthly:[{book_id:'social-post',rank:1,stars:7},{book_id:'video-autopilot',rank:2,stars:6}]};
const origin='http://127.0.0.1:4311',title='Hao 社群貼文技能書';
const introductions=(bookId:string)=>Array.from({length:100},(_,index)=>`${bookId} 介紹 ${index+1}：一句給朋友的真實推薦。`);
const shareContent=(bookId:string)=>({introductions:introductions(bookId),illustration_url:`/brand/skill-illustrations/${bookId}.webp`,illustration_alt:`${bookId} 技能書的橫幅插畫`});
test.beforeEach(async({page})=>{
  await page.route('**/api/v1/me/skill-books',route=>route.fulfill({json:{items:[]}}));
  await page.route('**/api/v1/me/github',route=>route.fulfill({json:{configured:false,connected:false,github_user:null}}));
  await page.route('**/api/v1/skills/*/share-content',route=>route.fulfill({json:shareContent(route.request().url().split('/').at(-2)!)}));
  await page.route('**/api/v1/github/books/*/metrics',route=>route.fulfill({json:{repository_url:null,stargazers_count:null,forks_count:null,open_issues_count:null,subscribers_count:null,pushed_at:null,language:null,checked_at:null,stale:false,error:'fixture'}}));
});
async function library(page:Page){
  await page.goto('/');await page.getByLabel('電子郵件',{exact:true}).fill('maker@local.test');await page.getByLabel('密碼',{exact:true}).fill('freedom-local-demo');await page.getByRole('button',{name:'登入',exact:true}).click();await navigate(page, '技能書架');await page.getByRole('button',{name:'未解鎖',exact:true}).click();return page.locator('.community-library');
}
test('one discovery request supplies card and dialog badges; week and month use actual ranked order',async({page})=>{
  let reads=0;await page.route('**/api/v1/skills/discovery',route=>{reads++;return route.fulfill({json:discovery});});
  const lib=await library(page),social=lib.locator('article[data-book-id="social-post"]');
  await expect(social.getByText('官方公會技能',{exact:true})).toBeVisible();await expect(social.getByText('工坊週榜 #2',{exact:true})).toBeVisible();
  await social.getByRole('button',{name:'預覽技能書',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'Hao 社群貼文技能書',exact:true});await expect(dialog.getByText('官方公會技能',{exact:true})).toBeVisible();await expect(dialog.getByRole('link',{name:'交給 Agent ↗',exact:true})).toHaveAttribute('href','/development/skills/social-post/SKILL.md');await expect(dialog.getByRole('link',{name:'查看里程碑與任務 ↗',exact:true})).toHaveAttribute('href','/development/skills/social-post');
  await page.keyboard.press('Escape');expect(reads).toBe(1);
  await lib.getByRole('button',{name:'工坊週榜',exact:true}).click();await expect(lib.locator('article.skill-library-book')).toHaveCount(2);await expect(lib.locator('article.skill-library-book').first()).toHaveAttribute('data-book-id','video-autopilot');await expect(lib).toContainText('不是 GitHub 總星數');
  await lib.getByRole('button',{name:'工坊月榜',exact:true}).click();await expect(lib.locator('article.skill-library-book').first()).toHaveAttribute('data-book-id','social-post');
  await lib.getByRole('button',{name:'每日新技能',exact:true}).click();await expect(lib.locator('article.skill-library-book')).toHaveCount(1);await expect(lib.locator('article.skill-library-book').first()).toHaveAttribute('data-book-id','event-space');
  await page.setViewportSize({width:320,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);expect(reads).toBe(1);
});
async function socialCard(page:Page){const lib=await library(page);await lib.getByLabel('搜尋技能書',{exact:true}).fill('社群貼文');return lib.locator('article[data-book-id="social-post"]');}
async function openPreview(page:Page){const card=await socialCard(page);await card.getByRole('button',{name:'分享技能',exact:true}).click();const dialog=page.getByRole('dialog',{name:`分享「${title}」`,exact:true});await expect(dialog).toBeVisible();return {card,dialog};}
async function preview(dialog:ReturnType<Page['getByRole']>){
  const text=(await dialog.locator('.skill-share-text').innerText()).trim(),match=/^social-post 介紹 (\d+)：/.exec(text);expect(match).not.toBeNull();
  const url=`${origin}/development/skills/social-post?intro=${match![1]}`;await expect(dialog.locator('.skill-share-url')).toHaveText(url);return {text,url,number:Number(match![1])};
}
function stubShare(page:Page,mode:'share'|'cancel'|'error'|'none',clipboard:'ok'|'denied'|'none'='ok'){
  return page.addInitScript(({mode,clipboard})=>{
    const w=window as any;
    const share=mode==='none'?undefined:async(value:ShareData)=>{w.__shared=value;if(mode==='cancel')throw new DOMException('cancelled','AbortError');if(mode==='error')throw new DOMException('blocked','NotAllowedError');};
    Object.defineProperty(navigator,'share',{value:share,configurable:true});
    Object.defineProperty(navigator,'clipboard',{value:clipboard==='none'?undefined:{writeText:async(value:string)=>{if(clipboard==='denied')throw new DOMException('denied','NotAllowedError');w.__copied=value;}},configurable:true});
  },{mode,clipboard});
}
const shared=(page:Page)=>page.evaluate(()=>(window as any).__shared??null),copied=(page:Page)=>page.evaluate(()=>(window as any).__copied??null);
test('opening the share preview shows this book and one of its introductions without sending; dice keeps the same book',async({page})=>{
  await stubShare(page,'share');let reads=0;await page.unroute('**/api/v1/skills/*/share-content');await page.route('**/api/v1/skills/*/share-content',route=>{reads++;return route.fulfill({json:shareContent(route.request().url().split('/').at(-2)!)});});
  const {card,dialog}=await openPreview(page);expect(reads).toBe(1);expect(await shared(page)).toBeNull();expect(await copied(page)).toBeNull();
  await expect(dialog).toHaveAttribute('data-book-id','social-post');const first=await preview(dialog);await expect(dialog.getByText(`介紹 ${first.number}／100`,{exact:true})).toBeVisible();
  for(let round=0;round<5;round++){const before=await preview(dialog);await dialog.getByRole('button',{name:'換一句',exact:true}).click();await expect(dialog.locator('.skill-share-text')).not.toHaveText(before.text);await expect(dialog).toHaveAttribute('data-book-id','social-post');await expect(page.getByRole('dialog',{name:`分享「${title}」`,exact:true})).toBeVisible();await preview(dialog);}
  expect(await shared(page)).toBeNull();expect(await copied(page)).toBeNull();
  await dialog.getByRole('button',{name:'分享',exact:true}).click();const current=await preview(dialog);
  expect(await shared(page)).toEqual({title:`${title} · 自由工坊`,text:current.text,url:current.url});await expect(dialog.getByRole('status')).toHaveText('分享已送出');
  await page.keyboard.press('Escape');await expect(dialog).toBeHidden();await expect(card.getByRole('button',{name:'分享技能',exact:true})).toBeFocused();
});
test('copy writes the exact introduction and URL; reroll clears the previous status',async({page})=>{
  await stubShare(page,'none');const {dialog}=await openPreview(page);const current=await preview(dialog);
  await dialog.getByRole('button',{name:'複製介紹與連結',exact:true}).click();await expect(dialog.getByRole('status')).toHaveText('已複製介紹與連結');expect(await copied(page)).toBe(`${current.text}\n${current.url}`);
  await dialog.getByRole('button',{name:'換一句',exact:true}).click();await expect(dialog.getByRole('status')).toHaveCount(0);
  const next=await preview(dialog);await dialog.getByRole('button',{name:'分享',exact:true}).click();await expect(dialog.getByRole('status')).toHaveText('已複製介紹與連結');expect(await copied(page)).toBe(`${next.text}\n${next.url}`);
  await dialog.getByRole('button',{name:'關閉分享預覽',exact:true}).click();await expect(dialog).toBeHidden();
});
test('native share cancellation stays quiet and never copies',async({page})=>{
  await stubShare(page,'cancel');const {card,dialog}=await openPreview(page);expect(await shared(page)).toBeNull();const current=await preview(dialog);
  await dialog.getByRole('button',{name:'分享',exact:true}).click();await expect.poll(()=>shared(page)).toEqual({title:`${title} · 自由工坊`,text:current.text,url:current.url});
  await expect(dialog.getByRole('button',{name:'分享',exact:true})).toBeEnabled();await expect(card.locator('.skill-share-status')).toHaveCount(0);await expect(dialog.getByRole('textbox')).toHaveCount(0);expect(await copied(page)).toBeNull();
});
for(const [label,mode,clipboard] of [['native share failure','error','ok'],['denied clipboard','none','denied'],['missing clipboard','none','none']] as const){
  test(`${label} shows the introduction and link selected for manual copy`,async({page})=>{
    await stubShare(page,mode,clipboard);const {dialog}=await openPreview(page);const current=await preview(dialog);
    await dialog.getByRole('button',{name:'分享',exact:true}).click();const manual=dialog.getByLabel('手動複製分享內容',{exact:true});
    await expect(manual).toHaveValue(`${current.text}\n${current.url}`);await expect(manual).toBeFocused();await expect(dialog.getByText(/已複製|分享已送出/)).toHaveCount(0);expect(await copied(page)).toBeNull();
    expect(await manual.evaluate(element=>{const field=element as HTMLTextAreaElement;return field.selectionStart===0&&field.selectionEnd===field.value.length;})).toBe(true);
    await dialog.getByRole('button',{name:'換一句',exact:true}).click();await expect(manual).toHaveCount(0);
  });
}
test('unavailable or missing share content explains the problem, can retry and still shares the plain link',async({page})=>{
  await stubShare(page,'none');let state:'down'|'missing'|'ok'='down';await page.unroute('**/api/v1/skills/*/share-content');
  await page.route('**/api/v1/skills/*/share-content',route=>state==='down'?route.fulfill({status:503,json:{detail:'unavailable'}}):state==='missing'?route.fulfill({status:404,json:{detail:'not_found'}}):route.fulfill({json:shareContent('social-post')}));
  const {card,dialog}=await openPreview(page);await expect(dialog.getByRole('alert')).toContainText('分享介紹暫時無法載入');await expect(dialog.locator('.skill-share-url')).toHaveText(`${origin}/development/skills/social-post`);
  await expect(dialog.getByRole('button',{name:'換一句',exact:true})).toHaveCount(0);await dialog.getByRole('button',{name:'複製連結',exact:true}).click();expect(await copied(page)).toBe(`${origin}/development/skills/social-post`);await expect(dialog.getByRole('status')).toHaveText('已複製技能連結');
  state='missing';await dialog.getByRole('button',{name:'重試',exact:true}).click();await expect(dialog.getByRole('alert')).toContainText('還沒有分享介紹');
  state='ok';await dialog.getByRole('button',{name:'重試',exact:true}).click();await expect(dialog.getByRole('alert')).toHaveCount(0);await preview(dialog);
  await page.keyboard.press('Escape');await expect(card.getByRole('button',{name:'分享技能',exact:true})).toBeFocused();
});
test('the skill book dialog shows the full landscape illustration below the compact cover header',async({page})=>{
  await page.route('**/brand/skill-illustrations/*.webp',route=>route.fulfill({path:'apps/portal-web/public/art/skills/social-post.webp',contentType:'image/webp'}));
  const card=await socialCard(page);await card.getByRole('button',{name:'預覽技能書',exact:true}).click();const dialog=page.getByRole('dialog',{name:title,exact:true});
  const art=dialog.getByRole('img',{name:'social-post 技能書的橫幅插畫',exact:true});await expect(art).toBeVisible();await expect(art).toHaveAttribute('src','/brand/skill-illustrations/social-post.webp');
  expect(await art.evaluate(element=>(element as HTMLImageElement).naturalWidth>0)).toBe(true);await expect(dialog.locator('.skill-intro-cover .skill-intro-art')).toBeVisible();
  const cover=await dialog.locator('.skill-intro-cover').boundingBox(),box=await art.boundingBox();expect(box!.y).toBeGreaterThan(cover!.y+cover!.height-1);expect(box!.width).toBeGreaterThan(cover!.width*.9);
  await page.keyboard.press('Escape');await expect(card.locator('.skill-library-heading .skill-book-illustration')).toBeVisible();
});
test('Escape closes only a nested share preview and returns focus to the reading dialog',async({page})=>{
  await stubShare(page,'none');const card=await socialCard(page);await card.getByRole('button',{name:'預覽技能書',exact:true}).click();
  const reading=page.getByRole('dialog',{name:title,exact:true});await expect(reading).toBeVisible();
  await reading.getByRole('button',{name:'分享技能',exact:true}).click();
  const sharing=page.getByRole('dialog',{name:`分享「${title}」`,exact:true});await expect(sharing).toBeVisible();
  await page.keyboard.press('Escape');await expect(sharing).toBeHidden();await expect(reading).toBeVisible();
  await expect(reading.getByRole('button',{name:'分享技能',exact:true})).toBeFocused();
  await page.keyboard.press('Escape');await expect(reading).toBeHidden();
  await expect(card.getByRole('button',{name:'預覽技能書',exact:true})).toBeFocused();
});
test('sharing a second book uses only that book’s introductions and public URL',async({page})=>{
  await stubShare(page,'none');const lib=await library(page),search=lib.getByLabel('搜尋技能書',{exact:true});
  await search.fill('社群貼文');await lib.locator('article[data-book-id="social-post"]').getByRole('button',{name:'分享技能',exact:true}).click();
  const first=page.getByRole('dialog',{name:`分享「${title}」`,exact:true});await preview(first);await page.keyboard.press('Escape');
  await search.fill('影片自動化');const card=lib.locator('article[data-book-id="video-autopilot"]');await card.getByRole('button',{name:'分享技能',exact:true}).click();
  const next=page.locator('.skill-share-dialog[open]');await expect(next).toHaveAttribute('data-book-id','video-autopilot');
  const text=await next.locator('.skill-share-text').innerText(),url=await next.locator('.skill-share-url').innerText();
  expect(text).toMatch(/^video-autopilot 介紹 \d+：/);expect(url).toMatch(/\/development\/skills\/video-autopilot\?intro=\d+$/);
  await next.getByRole('button',{name:'複製介紹與連結',exact:true}).click();await expect(next.getByRole('status')).toHaveText('已複製介紹與連結');
  expect(await copied(page)).toBe(text+'\n'+url);expect(await copied(page)).not.toContain('social-post');
});
for(const viewport of [{name:'desktop',width:1280,height:800},{name:'mobile',width:390,height:844},{name:'small phone',width:320,height:844}]){
  test(`share preview stays compact on ${viewport.name}`,async({page})=>{
    await page.setViewportSize({width:viewport.width,height:viewport.height});await stubShare(page,'none');const {dialog}=await openPreview(page);await preview(dialog);
    const box=await dialog.boundingBox();expect(box!.x).toBeGreaterThanOrEqual(0);expect(box!.x+box!.width).toBeLessThanOrEqual(viewport.width);expect(box!.height).toBeLessThanOrEqual(viewport.height);if(viewport.name==='desktop')expect(box!.width).toBeLessThanOrEqual(560);
    for(const name of ['換一句','分享','複製介紹與連結']){const button=await dialog.getByRole('button',{name,exact:true}).boundingBox();expect(button!.height).toBeGreaterThanOrEqual(44);}
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  });
}
test('empty rankings are distinct from an unavailable discovery service and can be retried',async({page})=>{
  let broken=true;await page.route('**/api/v1/skills/discovery',route=>broken?route.fulfill({status:503,json:{detail:'unavailable'}}):route.fulfill({json:{...discovery,books:discovery.books.map(book=>({...book,week_rank:null,month_rank:null})),weekly:[],monthly:[]}}));
  const lib=await library(page);await lib.getByRole('button',{name:'工坊週榜',exact:true}).click();await expect(lib.getByRole('alert')).toContainText('暫時無法載入');await expect(lib).not.toContainText('目前還沒有上榜');broken=false;await lib.getByRole('button',{name:'重讀徽章與榜單',exact:true}).click();await expect(lib.getByRole('alert')).toHaveCount(0);await expect(lib).toContainText('目前還沒有上榜的技能書');await expect(lib.locator('article.skill-library-book')).toHaveCount(0);await lib.getByRole('button',{name:'全部技能',exact:true}).click();await expect(lib.locator('article.skill-library-book')).toHaveCount(25);
});
