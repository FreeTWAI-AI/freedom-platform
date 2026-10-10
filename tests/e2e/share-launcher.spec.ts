import {test,expect,type Page} from './fixtures.js';

async function login(page:Page){
  await page.goto('/');await page.getByLabel('電子郵件',{exact:true}).fill('maker@local.test');
  await page.getByLabel('密碼',{exact:true}).fill('freedom-local-demo');await page.getByRole('button',{name:'登入',exact:true}).click();
  await expect(page.getByRole('heading',{name:'會員首頁',level:1,exact:true})).toBeVisible();
}
async function choose(page:Page,label:string){
  await page.getByRole('button',{name:'分享或提交',exact:true}).click();
  await page.getByRole('dialog',{name:'你想分享什麼？',exact:true}).getByRole('button',{name:label,exact:true}).click();
}

for(const width of [1280,320])test(`one visible entry opens actual post, work, resource and product controls without automatic publication (${width}px)`,async({page})=>{
  await page.setViewportSize({width,height:844});await login(page);
  const writes:string[]=[];page.on('request',request=>{if(request.method()==='POST')writes.push(new URL(request.url()).pathname);});
  const title=`入口分享作品 ${width}`;
  await choose(page,'分享作品');await expect(page.getByLabel('作品標題',{exact:true})).toBeFocused();
  expect(writes).toEqual([]);
  await expect(page.locator('.work-sharing-form input[required],.work-sharing-form textarea[required]')).toHaveCount(2);
  await expect(page.getByLabel('成果引用（例如 artifact:template-v1）')).toBeHidden();
  await page.getByLabel('作品標題',{exact:true}).fill(title);
  await page.getByLabel('一句話介紹',{exact:true}).fill('這是透過分享入口提交的合成作品。');
  await page.getByLabel('我同意以社群可見方式分享這件作品').check();
  await page.getByRole('button',{name:'發布作品',exact:true}).click();
  await expect(page.getByRole('region',{name:'作品發布成功'})).toBeFocused();expect(writes).toEqual(['/api/v1/showcases']);
  await choose(page,'發文');const composer=page.getByRole('dialog',{name:'建立貼文',exact:true});
  await expect(composer.getByLabel('貼文內容',{exact:true})).toBeFocused();
  await composer.getByLabel('貼文內容',{exact:true}).fill('還沒要發布，先保留這份原稿。');
  await composer.getByRole('button',{name:'關閉發文',exact:true}).click();await choose(page,'發文');
  await expect(composer.getByLabel('貼文內容',{exact:true})).toHaveValue('還沒要發布，先保留這份原稿。');
  await composer.getByRole('button',{name:'關閉發文',exact:true}).click();
  await choose(page,'分享開源資源');await expect(page.getByLabel('GitHub 專案網址',{exact:true})).toBeFocused();
  await choose(page,'刊登商品');await page.getByRole('dialog',{name:'你的商品準備好了嗎？',exact:true}).getByRole('button',{name:'我已有商品成果檔',exact:true}).click();
  await expect(page.getByLabel('上傳成果檔',{exact:true})).toBeFocused();
  await choose(page,'刊登商品');await page.getByRole('dialog',{name:'你的商品準備好了嗎？',exact:true}).getByRole('button',{name:'我還沒準備商品',exact:true}).click();
  await expect(page.getByRole('button',{name:'下載內部商店 MD',exact:true})).toBeFocused();
  expect(writes).toEqual(['/api/v1/showcases']);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});

test('320px share choices fit all themes, back and Escape return keyboard focus',async({page})=>{
  await page.setViewportSize({width:320,height:640});await login(page);
  for(const theme of ['light','rpg','versefolk']){
    await page.evaluate(value=>document.documentElement.dataset.theme=value,theme);
    const trigger=page.getByRole('button',{name:'分享或提交',exact:true});await trigger.click();
    const dialog=page.getByRole('dialog',{name:'你想分享什麼？',exact:true});
    expect(await dialog.evaluate(element=>element.scrollWidth<=element.clientWidth)).toBe(true);
    for(const name of ['發文','分享作品','刊登商品','分享開源資源'])expect((await dialog.getByRole('button',{name,exact:true}).boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await page.screenshot({path:`test-results/share-launcher-${theme}-320.png`});
    await dialog.getByRole('button',{name:'刊登商品',exact:true}).click();
    await page.getByRole('button',{name:'← 返回分享選單',exact:true}).click();await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');await expect(dialog).not.toBeVisible();await expect(trigger).toBeFocused();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  }
});

test('an unavailable share page reports failure, keeps retry and does not create content',async({page})=>{
  await login(page);let unavailable=true;
  await page.route(/\/api\/v1\/showcases(?:\?.*)?$/,route=>unavailable?route.fulfill({status:503,json:{code:'synthetic_unavailable'}}):route.fallback());
  await choose(page,'分享作品');await expect(page.getByRole('status').filter({hasText:'分享入口暫時無法載入'})).toBeVisible();
  await expect(page.getByRole('button',{name:'重新載入',exact:true})).toBeEnabled();
  unavailable=false;await page.getByRole('button',{name:'重新載入',exact:true}).click();
  await expect(page.getByLabel('作品標題',{exact:true})).toBeVisible();await choose(page,'分享作品');
  await expect(page.getByLabel('作品標題',{exact:true})).toBeFocused();
});
