import { navigate } from './navigation.js';
import {test,expect,type Page,type Locator} from './fixtures.js';
import type {SkillBook} from '../../modules/community/catalog';

test.beforeEach(async({page})=>{
  await page.route('**/api/v1/me/github',route=>route.fulfill({json:{configured:false,connected:false,github_user:null}}));
  await page.route('**/api/v1/github/books/*/metrics',route=>route.fulfill({json:{book_id:route.request().url().split('/').at(-2),repository_url:null,stargazers_count:null,forks_count:null,open_issues_count:null,subscribers_count:null,pushed_at:null,language:null,archived:null,checked_at:null,stale:false,error:'fixture_unavailable'}}));
});

async function openLibrary(page:Page){
  await page.goto('/');
  await page.getByLabel('電子郵件',{exact:true}).fill('maker@local.test');
  await page.getByLabel('密碼',{exact:true}).fill('freedom-local-demo');
  await page.getByRole('button',{name:'登入',exact:true}).click();
  await navigate(page, '技能書架');
  const library=page.locator('.community-library');
  await expect(page.getByRole('heading',{name:'技能書架',level:1,exact:true})).toBeVisible();
  await page.getByRole('button',{name:'全部技能書',exact:true}).click();
  await expect(library.locator('.skill-library-book')).toHaveCount(25);
  return library;
}


test('guild skill book introduces a real first deliverable before external reading and stays usable on a phone',async({page})=>{
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto('/');await page.getByLabel('電子郵件',{exact:true}).fill('maker@local.test');await page.getByLabel('密碼',{exact:true}).fill('freedom-local-demo');await page.getByRole('button',{name:'登入',exact:true}).click();
  await navigate(page, '職業公會');
  const guild=page.getByRole('article',{name:'商品品質與供應公會',exact:true});
  const trigger=guild.getByRole('button',{name:'供應端工作台',exact:true});await trigger.click();
  const modal=page.getByRole('dialog',{name:'供應端工作台',exact:true});await expect(modal).toBeVisible();
  await expect(modal).toContainText('一份能讀回自己商品與申請的私人供應端檢視。');
  await expect(modal).toContainText('沒有寫入或付款權限');
  const start=modal.locator('details').filter({has:page.getByText('練習與設定',{exact:true})});
  await expect(start).not.toHaveAttribute('open');await start.locator('summary').click();
  await expect(start).toContainText('Node.js 24');await expect(start.locator('pre')).toContainText('npm run read -- products');
  await expect(modal.getByRole('link',{name:'完整指南 ↗',exact:true})).toHaveAttribute('href','/development/skills/supplier-client');
  await expect(modal.getByRole('link',{name:'閱讀技能書 ↗',exact:true})).toHaveAttribute('href',/github\.com\/FreeTWAI-AI\/freedom-supplier-client\/blob\/[a-f0-9]{40}\/README\.md$/);
  await modal.getByText('作者、授權與收錄來源',{exact:true}).click();await expect(modal).toContainText('來源 GitHub 帳號：FreeTWAI-AI');await expect(modal).toContainText('未明確宣告授權條款');
  await page.setViewportSize({width:390,height:844});expect(await modal.evaluate(element=>element.scrollWidth<=element.clientWidth)).toBe(true);
  await page.screenshot({path:'test-results/skill-book-intro-phone.png'});
  await page.keyboard.press('Escape');await expect(modal).not.toBeVisible();await expect(trigger).toBeFocused();
  // Locate by the known book label so guild naming remains independent from the guide content.
  const music=page.getByRole('button',{name:'音樂與 MV 製作入門手冊',exact:true}).first();await music.click();
  const musicModal=page.getByRole('dialog',{name:'音樂與 MV 製作入門手冊',exact:true});await expect(musicModal).toContainText('歌曲／MV 小企劃');
  await musicModal.getByText('練習與設定',{exact:true}).click();await expect(musicModal.locator('pre')).toHaveCount(0);await expect(musicModal).not.toContainText('npm run read');
  await musicModal.getByRole('button',{name:'關閉技能書介紹',exact:true}).click();expect(errors).toEqual([]);
});


test('public library searches all 25 books and intersects workshop categories without granting books',async({page})=>{
  const library=await openLibrary(page),cards=library.locator('article.skill-library-book');
  const grantedBefore=await (await page.request.get('/api/v1/me/skill-books')).json();
  await expect(library.getByRole('status')).toHaveText('顯示 25 / 25 本技能書');
  const illustrations=cards.locator('.skill-book-illustration');
  await expect(illustrations).toHaveCount(25);
  const urls=await illustrations.evaluateAll(images=>images.map(image=>image.getAttribute('src')));
  expect(new Set(urls).size).toBe(25);
  for(const url of urls){
    expect(url).toMatch(/^\/art\/skills\/[a-z0-9-]+\.webp$/);
    const response=await page.request.get(url!);
    expect(response.status(),url!).toBe(200);
    expect(response.headers()['content-type'],url!).toMatch(/^image\/webp/);
  }
  const search=library.getByLabel('搜尋技能書',{exact:true}),category=library.getByRole('combobox',{name:'依工坊用途篩選',exact:true});
  await category.selectOption({label:'資訊安全'});
  await expect(cards).toHaveCount(1);
  await expect(cards.first().getByRole('heading')).toHaveText('AI Security Scanner');
  // Search must narrow the selected category, not replace it or search only featured books.
  await search.fill('社群貼文');
  await expect(cards).toHaveCount(0);
  await expect(library.getByRole('status')).toHaveText('顯示 0 / 25 本技能書');
  await expect(library.getByText('沒有符合的技能書。試試另一個關鍵字或用途。',{exact:true})).toBeVisible();
  await category.selectOption({label:'內容與行銷'});
  await expect(cards).toHaveCount(1);
  await expect(cards.first().getByRole('heading')).toHaveText('Hao 社群貼文技能書');
  await expect(library.getByRole('status')).toHaveText('顯示 1 / 25 本技能書');
  await search.fill('');await category.selectOption({label:'全部用途'});
  await expect(cards).toHaveCount(25);
  const grantedAfter=await (await page.request.get('/api/v1/me/skill-books')).json();
  expect(grantedAfter).toEqual(grantedBefore);
  await page.setViewportSize({width:390,height:844});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});

test('book cards credit the original GitHub author and offer direct reading actions with details available on demand',async({page})=>{
  const library=await openLibrary(page);
  const catalog=await (await page.request.get('/api/v1/community')).json() as {skill_books:SkillBook[]};
  const book=catalog.skill_books.find(value=>value.id==='social-post')!,beginner=book.guide!.beginner;
  await library.getByLabel('搜尋技能書',{exact:true}).fill('社群貼文');
  const card=library.locator('article[data-book-id="social-post"]');
  await expect(card.getByRole('heading',{name:book.title,exact:true})).toBeVisible();
  await expect(card.locator('.skill-library-purpose')).toHaveText(beginner.purpose);
  await expect(card.locator('.skill-library-purpose')).toBeVisible();
  await expect(card).not.toContainText('你能做出什麼');
  await expect(card.locator('.skill-book-illustration')).toHaveAttribute('src',book.cover_url!);
  await card.locator('.github-metrics-details > summary').click();
  const star=card.getByRole('link',{name:'原作者 GitHub ↗',exact:true});
  await expect(star).toHaveAttribute('href','https://github.com/Hao0321/claude-skill-social-post');
  await expect(star).toHaveAttribute('target','_blank');
  await expect(star).toHaveAttribute('rel',/\bnoopener\b/);
  await expect(star).toHaveAttribute('rel',/\bnoreferrer\b/);
  await card.locator('.github-metrics-details > summary').click();
  expect(book.repository_url).toBe('https://github.com/FreeTWAI-AI/claude-skill-social-post');
  const trigger=card.getByRole('button',{name:'閱讀技能書',exact:true});
  await trigger.click();
  const modal=page.getByRole('dialog',{name:book.title,exact:true});
  await expect(modal).toBeVisible();
  await expect(modal.getByText(beginner.purpose,{exact:true})).toBeVisible();
  await expect(modal.getByRole('heading',{name:/能做什麼|下一步|誰適合/})).toHaveCount(0);
  await expect(modal.getByText(book.guide!.first_result,{exact:true})).toBeVisible();
  await expect(modal.locator('.skill-intro-art')).toHaveAttribute('src',book.cover_url!);
  await expect(modal.locator('.skill-intro-art')).toHaveJSProperty('complete',true);
  await expect.poll(()=>modal.locator('.skill-intro-art').evaluate(image=>(image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  await expect(modal.getByRole('link',{name:'原作者 GitHub ↗',exact:true})).toHaveAttribute('href',book.upstream_url);
  await expect(modal.getByRole('button',{name:'GitHub 連結尚未啟用',exact:true})).toBeDisabled();
  await expect(modal.getByRole('link',{name:'開啟專案 ↗',exact:true})).toHaveAttribute('href',book.upstream_url);
  await expect(modal.getByRole('link',{name:'閱讀技能書 ↗',exact:true})).toHaveAttribute('href',book.guide!.reading_url);
  await expect(modal.getByRole('link',{name:'Fork 專案 ↗',exact:true})).toHaveAttribute('href',`${book.upstream_url}/fork`);
  await expect(modal.getByRole('link',{name:'Fork 工坊版本 ↗',exact:true})).toHaveAttribute('href',book.fork_url);
  const practice=modal.locator('details').filter({has:page.getByText('練習與設定',{exact:true})});
  await expect(practice).not.toHaveAttribute('open');await practice.locator('summary').click();
  for(const step of book.guide!.first_steps)await expect(practice.getByText(step,{exact:true})).toBeVisible();
  await expect(modal.getByRole('link',{name:'完整指南 ↗',exact:true})).toHaveAttribute('href','/development/skills/social-post');
  const scope=modal.locator('details').filter({has:page.getByText('功能與使用範圍',{exact:true})});
  await expect(scope).not.toHaveAttribute('open');await scope.locator('summary').click();
  await expect(scope.getByText(book.guide!.status,{exact:true})).toBeVisible();
  await page.setViewportSize({width:390,height:844});
  expect(await modal.evaluate(element=>element.scrollWidth<=element.clientWidth)).toBe(true);
  await page.keyboard.press('Escape');
  await expect(modal).not.toBeVisible();await expect(trigger).toBeFocused();
  await expect(page).toHaveURL(/#skills$/);
});

test('all public book pages and Markdown preserve beginner summaries, covers, original stars and source facts',async({page,request})=>{
  const response=await request.get('/api/v1/development-map');expect(response.status()).toBe(200);
  const map=await response.json() as {skill_books:(SkillBook&{guide_url:string;markdown_url:string})[]};
  expect(map.skill_books).toHaveLength(25);
  for(const book of map.skill_books){
    const htmlResponse=await request.get(book.guide_url),markdownResponse=await request.get(book.markdown_url);
    expect(htmlResponse.status(),book.id).toBe(200);expect(markdownResponse.status(),book.id).toBe(200);
    expect(htmlResponse.headers()['content-type']).toMatch(/text\/html/);
    const html=await htmlResponse.text(),markdown=await markdownResponse.text();
    for(const value of Object.values(book.guide!.beginner)){
      expect(html,book.id).toContain(value);expect(markdown,book.id).toContain(value);
    }
    for(const value of [book.guide!.first_result,book.guide!.status,book.guide!.source_commit,book.repository_url,book.fork_url,book.upstream_url,book.cover_url!,book.license_status]){
      expect(html,book.id).toContain(value);expect(markdown,book.id).toContain(value);
    }
    expect(html,book.id).toContain(`src="${book.cover_url}"`);
    expect(html,book.id).toContain('href="/#skills">登入工坊 Star');
    expect(html.match(/<script[^>]*>/g),book.id).toEqual(['<script src="/development-share.js" defer>']);
    expect(html,book.id).not.toMatch(/<script(?![^>]*src=)[^>]*>/);
  }
  const example=map.skill_books.find(book=>book.id==='social-post')!;
  await page.goto(example.guide_url);
  await expect(page.getByRole('heading',{name:example.title,exact:true})).toBeVisible();
  await expect(page.locator('.public-skill-purpose')).toHaveText(example.guide!.beginner.purpose);
  const details=page.locator('.public-skill-details');
  await expect(details).not.toHaveAttribute('open');
  await expect(page.getByRole('link',{name:'閱讀技能書 ↗',exact:true})).toHaveAttribute('href',example.guide!.reading_url);
  await expect(page.getByRole('link',{name:'開啟專案 ↗',exact:true})).toHaveAttribute('href',example.upstream_url);
  await expect(page.getByRole('link',{name:'Fork 專案 ↗',exact:true})).toHaveAttribute('href',`${example.upstream_url}/fork`);
  await expect(page.getByRole('link',{name:'Fork 工坊版本 ↗',exact:true})).toHaveAttribute('href',example.fork_url);
  await expect(page.locator('.public-skill-cover img')).toHaveAttribute('src',example.cover_url!);
  await expect.poll(()=>page.locator('.public-skill-cover img').evaluate(image=>(image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  const star=page.getByRole('link',{name:'登入工坊 Star',exact:true});
  await expect(star).toHaveAttribute('href','/#skills');
  await details.locator('summary').click();
  await expect(details.getByText(example.guide!.beginner.workshop_use,{exact:true})).toBeVisible();
  for(const width of [390,320]){
    await page.setViewportSize({width,height:844});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    expect((await page.locator('.public-skill-cover img').boundingBox())!.height).toBeLessThanOrEqual(82);
  }
  await page.screenshot({path:'test-results/public-skill-compact-phone.png',fullPage:true});
  await details.locator('summary').click();await page.evaluate(()=>scrollTo(0,0));await page.screenshot({path:'test-results/public-skill-compact-viewport.png'});
});

test('every bookshelf uses compact illustrated rows with full copy, live counts and expandable secondary metrics',async({page})=>{
  const metrics={repository_url:'https://github.com/Hao0321/claude-skill-social-post',stargazers_count:127,forks_count:18,open_issues_count:4,subscribers_count:6,pushed_at:'2026-09-20T10:00:00Z',language:'TypeScript',archived:false,checked_at:'2026-09-23T10:00:00Z',stale:false,error:null};
  await page.route('**/api/v1/me/github',route=>route.fulfill({json:{configured:true,connected:true,github_user:{id:'synthetic-density',login:'synthetic-density'}}}));
  await page.route('**/api/v1/me/github/books/*/star',route=>route.fulfill({json:{book_id:route.request().url().split('/').at(-2),starred:false,connected:true}}));
  await page.route('**/api/v1/github/books/*/metrics',route=>route.fulfill({json:{...metrics,book_id:route.request().url().split('/').at(-2)}}));
  const library=await openLibrary(page),catalog=await (await page.request.get('/api/v1/community')).json() as {skill_books:SkillBook[]},book=catalog.skill_books.find(value=>value.id==='social-post')!;
  await page.route('**/api/v1/me/skill-books',route=>route.fulfill({json:{items:[{...book,book_id:book.id}]}}));
  await library.getByLabel('搜尋技能書',{exact:true}).fill('社群貼文');
  async function check(card:Locator,width:number){
    await page.setViewportSize({width,height:900});await card.scrollIntoViewIfNeeded();
    await expect(card.locator('.skill-library-purpose')).toHaveText(book.guide!.beginner.purpose);
    await expect(card.locator('.github-star-count,.github-fork-count')).toHaveText(['127','18']);
    const sizes=await card.evaluate(element=>{
      const cover=element.querySelector('.skill-library-heading > img')!,heading=element.querySelector('.skill-library-copy')!,purpose=element.querySelector<HTMLElement>('.skill-library-purpose')!,title=element.querySelector<HTMLElement>('h4')!;
      return {cover:cover.getBoundingClientRect().toJSON(),heading:heading.getBoundingClientRect().toJSON(),cardHeight:element.getBoundingClientRect().height,purposeHeight:purpose.clientHeight,purposeScroll:purpose.scrollHeight,titleHeight:title.clientHeight,titleScroll:title.scrollHeight,font:parseFloat(getComputedStyle(purpose).fontSize),overflow:element.scrollWidth>element.clientWidth};
    });
    expect(sizes.cover.width).toBeLessThanOrEqual(width<=600?64:80);expect(sizes.cover.height).toBeLessThanOrEqual(60);
    expect(sizes.cover.right).toBeLessThan(sizes.heading.left);expect(Math.abs(sizes.cover.top-sizes.heading.top)).toBeLessThan(35);
    expect(sizes.purposeScroll).toBeLessThanOrEqual(sizes.purposeHeight+1);expect(sizes.titleScroll).toBeLessThanOrEqual(sizes.titleHeight+1);expect(sizes.font).toBeGreaterThanOrEqual(14);
    expect(sizes.overflow).toBe(false);expect(sizes.cardHeight).toBeLessThan(300);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    for(const label of ['閱讀技能書','分享技能'])expect((await card.getByRole('button',{name:label,exact:true}).boundingBox())!.height).toBeGreaterThanOrEqual(44);
  }
  const card=library.locator('article[data-book-id="social-post"]');
  for(const width of [320,390,1440]){await check(card,width);await card.screenshot({path:`test-results/skill-shelf-compact-${width}.png`});}
  const more=card.locator('.github-metrics-details');await expect(more).not.toHaveAttribute('open');await expect(more.locator('dd').first()).not.toBeVisible();await more.locator('summary').click();await expect(more.locator('dd')).toHaveText(['4','6','2026/9/20']);await expect(more.getByText('數據更新',{exact:false})).toBeVisible();await more.locator('summary').click();
  await page.setViewportSize({width:320,height:900});await card.getByRole('button',{name:'閱讀技能書',exact:true}).click();const modal=page.getByRole('dialog',{name:book.title,exact:true});expect((await modal.locator('.skill-intro-art').boundingBox())!.height).toBeLessThanOrEqual(48);await expect(modal.locator('.skill-intro-purpose')).toHaveText(book.guide!.beginner.purpose);expect(await modal.evaluate(element=>element.scrollWidth<=element.clientWidth)).toBe(true);await page.screenshot({path:'test-results/skill-dialog-compact-phone.png'});await page.keyboard.press('Escape');
  await navigate(page, '會員首頁');await navigate(page, '技能書架');
  await page.getByRole('button',{name:/^我的技能書(?: · \d+)?$/}).click();await check(page.locator('.community-library article[data-book-id="social-post"]'),320);
  await navigate(page, '職業公會');await expect(page.locator('.guild-bookshelf')).toHaveCount(0);
  await page.getByRole('button',{name:'我的名片',exact:true}).click();await expect(page.locator('.member-bookshelf')).toHaveCount(0);
});
