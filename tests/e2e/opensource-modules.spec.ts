import { randomUUID } from 'node:crypto';
import { e2eOrigin } from '../../packages/testing/e2e-origin.js';
import { navigate, signOut } from './navigation.js';
import { test,expect,type Page } from './fixtures.js';

async function login(page:Page,email='maker@local.test'){
  await page.goto('/');await page.getByLabel('電子郵件',{exact:true}).fill(email);
  await page.getByLabel('密碼',{exact:true}).fill('freedom-local-demo');await page.getByRole('button',{name:'登入',exact:true}).click();
  await expect(page.getByRole('heading',{name:'會員首頁',exact:true})).toBeVisible();
}

test('member writes a private campaign, revises it and records a manual share that persists',async({page})=>{
  const title=`手動行銷驗證 ${Date.now()}`;
  await login(page);await navigate(page, '行銷工作室');
  await page.getByLabel('活動來源簡述',{exact:true}).fill('會員自願交流活動，分享開源工具的使用經驗。');
  await page.getByLabel('活動名稱',{exact:true}).fill(title);
  await page.getByLabel('想分享給誰',{exact:true}).fill('剛加入的會員');
  await page.getByLabel('希望對方下一步做什麼',{exact:true}).fill('閱讀使用說明並加入討論');
  await page.getByLabel('文案草稿',{exact:true}).fill('歡迎帶著真實使用問題，一起交換開源工具的實作心得。');
  await page.getByRole('button',{name:'儲存私人草稿',exact:true}).click();
  let card=page.getByRole('article',{name:`行銷活動：${title}`,exact:true});await expect(card).toBeVisible();
  await card.getByRole('button',{name:'編輯草稿',exact:true}).click();
  // The populated textarea is nested in its label; select its computed
  // accessible name rather than matching the label's descendant textContent.
  await card.getByRole('textbox',{name:'文案草稿',exact:true}).fill('更新：請先閱讀使用說明，帶一個問題加入交流。');
  await card.getByRole('button',{name:'儲存草稿修改',exact:true}).click();
  await expect(card.getByText('更新：請先閱讀使用說明，帶一個問題加入交流。',{exact:true})).toBeVisible();
  await card.getByRole('button',{name:'記錄分享連結',exact:true}).click();
  await card.getByLabel('分享渠道',{exact:true}).fill('社群討論');
  await card.getByLabel('分享／推薦連結',{exact:true}).fill('https://github.com/FreeTWAI/freedom-platform');
  await card.getByLabel('分享備註（選填）',{exact:true}).fill('這是測試用人工紀錄。');
  await card.getByRole('button',{name:'儲存分享紀錄',exact:true}).click();
  await expect(card.getByText(/自行回報，未驗證發布或成效/)).toBeVisible();
  await page.reload();await navigate(page, '行銷工作室');
  card=page.getByRole('article',{name:`行銷活動：${title}`,exact:true});await expect(card.getByRole('link',{name:'社群討論 ↗',exact:true})).toBeVisible();
  await page.screenshot({path:'test-results/marketing-workspace.png',fullPage:true});
  await signOut(page);
  await expect(page.getByRole('heading',{name:'登入',exact:true})).toBeVisible();
  await login(page,'client@local.test');
  await navigate(page, '行銷工作室');await expect(page.getByRole('heading',{name:'我的行銷草稿',exact:true})).toBeVisible();
  await expect(page.getByRole('heading',{name:title,exact:true})).toHaveCount(0);
});

test('campaign drafts load older pages and preserve them across retry and revision',async({page})=>{
  const prefix=`分頁草稿 ${Date.now()}`;
  await login(page);
  const session=await (await page.request.get('/api/v1/session')).json();
  for(let index=0;index<23;index++){
    const response=await page.request.post('/api/v1/marketing/campaigns',{
      headers:{Origin:e2eOrigin(),'X-CSRF-Token':session.csrf_token,'Idempotency-Key':randomUUID()},
      data:{title:`${prefix} ${String(index).padStart(2,'0')}`,audience:'新會員',goal:'閱讀內容',draft_text:'合成分頁草稿。',source_brief:'合成活動來源。'},
    });
    expect(response.status()).toBe(201);
  }
  await navigate(page,'行銷工作室');
  const drafts=page.getByRole('region',{name:'我的行銷草稿',exact:true});
  const fixtureCards=drafts.locator(`article[aria-label^="行銷活動：${prefix}"]`);
  await expect(fixtureCards).toHaveCount(20);
  const more=drafts.getByRole('button',{name:'載入更多行銷草稿',exact:true});
  await page.route('**/api/v1/marketing/campaigns?limit=20&offset=20',route=>route.fulfill({status:503,json:{status:503,code:'campaign_page_unavailable',detail:'暫時無法載入後續草稿。'}}),{times:1});
  await more.click();
  await expect(drafts.getByRole('alert')).toContainText('服務暫時無法回應（503）。請稍後重試。');
  await expect(fixtureCards).toHaveCount(20);
  await expect(more).toBeEnabled();
  await more.click();
  await expect(fixtureCards).toHaveCount(23);
  const older=drafts.getByRole('article',{name:`行銷活動：${prefix} 00`,exact:true});
  await older.getByRole('button',{name:'編輯草稿',exact:true}).click();
  await older.getByRole('textbox',{name:'文案草稿',exact:true}).fill('較舊草稿更新後仍保留完整已載入頁。');
  await older.getByRole('button',{name:'儲存草稿修改',exact:true}).click();
  await expect(older.getByText('較舊草稿更新後仍保留完整已載入頁。',{exact:true})).toBeVisible();
  await expect(fixtureCards).toHaveCount(23);
  await page.setViewportSize({width:320,height:844});
  const width=await page.evaluate(()=>({viewport:innerWidth,document:document.documentElement.scrollWidth}));
  expect(width.document).toBeLessThanOrEqual(width.viewport);
});

for(const first of ['creation','continuation'] as const){
test(`campaign ${first} serializes the other operation without skipping older drafts`,async({page},testInfo)=>{
  const prefix=`交錯草稿 ${first} ${Date.now()}`;
  await page.setViewportSize({width:first==='creation'?1440:390,height:900});
  await login(page);
  const session=await (await page.request.get('/api/v1/session')).json();
  const titles=Array.from({length:45},(_,index)=>`${prefix} ${String(index).padStart(2,'0')}`);
  for(const title of titles){
    const response=await page.request.post('/api/v1/marketing/campaigns',{
      headers:{Origin:e2eOrigin(),'X-CSRF-Token':session.csrf_token,'Idempotency-Key':randomUUID()},
      data:{title,audience:'新會員',goal:'閱讀內容',draft_text:'合成交錯草稿。',source_brief:'合成活動來源。'},
    });
    expect(response.status()).toBe(201);
  }
  await navigate(page,'行銷工作室');
  const drafts=page.getByRole('region',{name:'我的行銷草稿',exact:true});
  const cards=drafts.locator(`article[aria-label^="行銷活動：${prefix}"]`);
  await expect(cards).toHaveCount(20);
  const newTitle=`${prefix} 新增`;
  await page.getByLabel('活動來源簡述',{exact:true}).fill('合成活動來源。');
  await page.getByLabel('活動名稱',{exact:true}).fill(newTitle);
  await page.getByLabel('想分享給誰',{exact:true}).fill('新會員');
  await page.getByLabel('希望對方下一步做什麼',{exact:true}).fill('閱讀內容');
  await page.getByLabel('文案草稿',{exact:true}).fill('等待另一項操作時保留這份草稿。');
  const save=page.getByRole('button',{name:'儲存私人草稿',exact:true});
  const more=drafts.getByRole('button',{name:/^(載入更多行銷草稿|載入中…)$/});
  let release=()=>{},entered=()=>{},held=false;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  const responseReady=new Promise<void>(resolve=>{entered=resolve;});
  const requests:string[]=[];
  await page.route('**/api/v1/marketing/campaigns*',async route=>{
    const method=route.request().method();
    requests.push(method);
    if(!held&&method===(first==='creation'?'POST':'GET')){
      held=true;
      // Commit the actual write/read, then delay its response. This exposes the
      // original offset interleaving without replacing the campaign API or DB.
      const response=await route.fetch();
      expect(response.status()).toBe(first==='creation'?201:200);
      entered();await gate;await route.fulfill({response});
    }else await route.continue();
  });
  try{
    await (first==='creation'?save:more).click();
    await responseReady;
    await expect(first==='creation'?more:save).toBeDisabled();
    await page.screenshot({path:testInfo.outputPath('campaign-operation-pending.png')});
    if(first==='creation')await more.evaluate(button=>(button as HTMLButtonElement).click());
    else await save.evaluate(button=>(button as HTMLButtonElement).form!.requestSubmit());
    await expect(page.getByLabel('活動名稱',{exact:true})).toHaveValue(newTitle);
    expect(requests).toEqual([first==='creation'?'POST':'GET']);
  }finally{release();}
  if(first==='continuation'){
    await expect(cards).toHaveCount(40);
    await expect(save).toBeEnabled();await save.click();
  }
  await expect(drafts.getByRole('heading',{name:newTitle,exact:true})).toBeVisible();
  for(let pageIndex=0;pageIndex<10&&await more.count()>0;pageIndex++){
    await expect(more).toBeEnabled();await more.click();
    await expect(drafts.getByRole('button',{name:'載入中…',exact:true})).toHaveCount(0);
  }
  await expect(more).toHaveCount(0);
  await expect(cards).toHaveCount(46);
  expect((await cards.getByRole('heading').allTextContents()).sort()).toEqual([...titles,newTitle].sort());
  expect(requests.filter(method=>method==='POST')).toHaveLength(1);
});
}

test('open-source entry clearly collects GitHub/use/license context and rejects arbitrary fetch targets',async({page})=>{
  await login(page);await navigate(page, '開源投稿');
  await expect(page.getByRole('heading',{name:'投稿你的開源工具',exact:true})).toBeVisible();
  await page.getByLabel('GitHub 專案網址',{exact:true}).fill('https://untrusted.example/owner/repository');
  await page.getByLabel('作品名稱',{exact:true}).fill('不應送出網路的測試');
  await page.getByLabel('一句話介紹',{exact:true}).fill('驗證只接受 GitHub 儲存庫。');
  await page.getByRole('button',{name:'預覽投稿',exact:true}).click();
  await page.getByLabel('我同意公開這份作品介紹與來源關係',{exact:true}).check();
  await page.getByRole('button',{name:'確認並公開',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('請使用 https://github.com/');
  await page.getByRole('button',{name:'修改內容',exact:true}).click();
  await expect(page.getByLabel('作品名稱',{exact:true})).toHaveValue('不應送出網路的測試');
  await page.setViewportSize({width:390,height:844});
  const width=await page.evaluate(()=>({viewport:window.innerWidth,document:document.documentElement.scrollWidth}));expect(width.document).toBeLessThanOrEqual(width.viewport);
  await page.screenshot({path:'test-results/opensource-mobile.png',fullPage:true});
});
