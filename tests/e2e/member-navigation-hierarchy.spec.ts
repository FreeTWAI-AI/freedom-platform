import {test,expect,type Page} from './fixtures';
import {navigate,openHomeGuide,openFeatureSearch,setHomeViewport} from './navigation';
async function login(page:Page){
  await page.goto('/');
  await page.getByLabel('電子郵件',{exact:true}).fill('maker@local.test');
  await page.getByLabel('密碼',{exact:true}).fill('freedom-local-demo');
  const response=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/v1/auth/login'&&r.request().method()==='POST',{timeout:25_000});
  await page.getByRole('button',{name:'登入',exact:true}).click();
  expect((await response).status()).toBe(200);
  await expect(page.locator('.home-timeline')).toBeVisible();
}

test('home and global navigation reach the same supply catalog and preserve history on a phone',async({page})=>{
  await page.setViewportSize({width:390,height:844});await login(page);
  await openHomeGuide(page);
  await page.locator('.home-destinations').getByRole('button',{name:'我的供貨商品庫 管理商品與合作條件',exact:true}).click();
  await expect(page).toHaveURL(/#stores\/supply$/);
  await expect(page.getByRole('heading',{name:'我的供貨商品庫',level:1,exact:true})).toBeVisible();
  await navigate(page,'我的商店');await expect(page).toHaveURL(/#stores$/);
  await page.goBack();await expect(page).toHaveURL(/#stores\/supply$/);
  await page.reload();await expect(page.getByRole('heading',{name:'我的供貨商品庫',level:1,exact:true})).toBeVisible();
  await navigate(page,'我的供貨商品庫');
  await expect(page.getByRole('navigation',{name:'主要工作區'})).toBeHidden();
  await expect(page.locator('#main-content')).toBeFocused();
  await navigate(page,'我的內容');await expect(page).toHaveURL(/#my-content$/);
  await expect(page.getByRole('heading',{name:'草稿與已發布內容',exact:true})).toBeVisible();
  // Old feed links and feature search continue to reach their existing destination.
  await navigate(page,'社群分享');await expect(page).toHaveURL(/#social$/);
});

test('disabled content and catalog capabilities do not advertise their entry points',async({page})=>{
  await page.route('**/api/v1/site',async route=>{
    const response=await route.fetch();await route.fulfill({response,json:{...await response.json(),personal_content_enabled:false,guild_launchpad_enabled:false}});
  });
  await login(page);await openHomeGuide(page);
  await expect(page.locator('.home-destinations').getByRole('button',{name:/我的供貨商品庫|我的商店/})).toHaveCount(0);
  await expect(page.locator('.nav-primary').getByRole('button',{name:'我的內容',exact:true})).toHaveCount(0);
  await openFeatureSearch(page);await page.getByLabel('搜尋功能').fill('我的內容');
  await expect(page.getByRole('navigation',{name:'主要工作區'}).getByRole('button',{name:'我的內容',exact:true})).toHaveCount(0);
});

test('member hierarchy keeps one feed, distinct destinations and readable controls in each theme and viewport',async({page,e2eAuthPool},testInfo)=>{
  await page.route(url=>!['127.0.0.1','localhost'].includes(url.hostname),route=>route.abort());
  await login(page);
  await expect(page.locator('.home-next-step')).toBeAttached();
  const createdPosts:{id:string;text:string}[]=[];
  let primaryError:unknown;
  try {
  for (const text of [
    '合成示範｜把開源筆記工具整理成可分享的作品。這週補上用途、授權與操作畫面，讓第一次看到的人知道如何試用。',
    '合成示範｜週末一起交流商品攝影。想練習的人可以先整理自己的商品照片；正式活動資訊以活動頁為準。',
  ]) {
    await page.getByRole('button',{name:'建立貼文',exact:true}).click();
    const composer=page.getByRole('dialog',{name:'建立貼文',exact:true});
    await composer.getByLabel('貼文內容',{exact:true}).fill(text);
    const [response]=await Promise.all([
      page.waitForResponse(r=>new URL(r.url()).pathname==='/api/v1/social-posts/notes'&&r.request().method()==='POST',{timeout:25_000}),
      composer.getByRole('button',{name:'發布貼文',exact:true}).click(),
    ]);
    expect(response.status(),await response.text()).toBe(201);
    const created=await response.json();
    expect(created.post_id).toMatch(/^[0-9a-f-]{36}$/);
    createdPosts.push({id:created.post_id,text});
    await expect(composer).not.toBeVisible();
    await expect(page.getByText(text,{exact:true})).toBeVisible();
  }

  for(const theme of ['light','dark','versefolk'])for(const width of [390,768,1440]){
    await setHomeViewport(page,{width,height:width===1440?900:844});
    await page.evaluate(value=>{document.documentElement.dataset.theme=value;document.documentElement.dataset.experienceProfile=value;window.dispatchEvent(new Event('freedom-theme-changed'));},theme);
    await expect(page.locator('.home-timeline')).toBeVisible();
    await openHomeGuide(page);
    const destinations=page.locator('.home-destinations');
    await expect(destinations.getByRole('heading')).toHaveText(['商品與供貨','作品與活動']);
    await expect(destinations.getByRole('button')).toHaveCount(4);
    await expect(page.locator('.platform-purpose--member,.home-module-card')).toHaveCount(0);
    for(const button of await destinations.getByRole('button').all())expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    // The guide click scrolls on phones; capture the sticky header at the actual page top.
    await page.evaluate(()=>window.scrollTo({top:0,behavior:'instant'}));
    const header=await page.locator('.community-header').boundingBox();
    const title=await page.locator('.workspace-topbar').boundingBox();
    expect(header!.y).toBeGreaterThanOrEqual(0);
    expect(header!.y+header!.height).toBeLessThanOrEqual(title!.y);
    await page.screenshot({path:testInfo.outputPath(`home-${theme}-${width}.png`),fullPage:true});
    await openFeatureSearch(page);
    await expect(page.locator('.nav-primary > button')).toHaveText(['會員首頁','我的內容','職業公會','技能書架','搜尋社群內容']);
    await page.evaluate(()=>window.scrollTo({top:0,behavior:'instant'}));
    await page.screenshot({path:testInfo.outputPath(`navigation-${theme}-${width}.png`)});
    await page.keyboard.press('Escape');
    const close=page.getByRole('button',{name:'關閉選單',exact:true});if(await close.isVisible())await close.click();
  }
  } catch(error) { primaryError=error; throw error; } finally {
    const cleanupErrors:unknown[]=[];
    // Text-only rows owned by this case, inside the run-specific E2E schema.
    // Soft deletion still consumes the shared author's daily post allowance.
    for(const post of createdPosts){
      try {
      const removed=await e2eAuthPool.query(`DELETE FROM community_social_posts
        WHERE post_id=$1 AND kind='note' AND note=$2
          AND author_user_id=(SELECT user_id FROM users WHERE email='maker@local.test')
        RETURNING post_id`,[post.id,post.text]);
      expect(removed.rowCount).toBe(1);
      } catch(error) { cleanupErrors.push(error); }
    }
    if(cleanupErrors.length)throw new AggregateError(primaryError?[primaryError,...cleanupErrors]:cleanupErrors,
      'Member hierarchy fixture cleanup failed');
  }
});
