import { navigate } from './navigation.js';
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
  await card.getByLabel('分享／推薦連結',{exact:true}).fill('https://github.com/FreeTWAI-AI/freedom-platform');
  await card.getByLabel('分享備註（選填）',{exact:true}).fill('這是測試用人工紀錄。');
  await card.getByRole('button',{name:'儲存分享紀錄',exact:true}).click();
  await expect(card.getByText(/自行回報，未驗證發布或成效/)).toBeVisible();
  await page.reload();await navigate(page, '行銷工作室');
  card=page.getByRole('article',{name:`行銷活動：${title}`,exact:true});await expect(card.getByRole('link',{name:'社群討論 ↗',exact:true})).toBeVisible();
  await page.screenshot({path:'test-results/marketing-workspace.png',fullPage:true});
  await page.getByRole('button',{name:'登出',exact:true}).click();
  await expect(page.getByRole('heading',{name:'登入',exact:true})).toBeVisible();
  await login(page,'client@local.test');
  await navigate(page, '行銷工作室');await expect(page.getByRole('heading',{name:'我的行銷草稿',exact:true})).toBeVisible();
  await expect(page.getByRole('heading',{name:title,exact:true})).toHaveCount(0);
});

test('open-source entry clearly collects GitHub/use/license context and rejects arbitrary fetch targets',async({page})=>{
  await login(page);await navigate(page, '開源投稿');
  await page.getByText('手動登錄作品',{exact:true}).click();
  await expect(page.getByRole('heading',{name:'登錄開源作品',exact:true})).toBeVisible();
  await page.getByLabel('GitHub 儲存庫網址',{exact:true}).fill('https://untrusted.example/owner/repository');
  await page.getByLabel('作品名稱',{exact:true}).fill('不應送出網路的測試');
  await page.getByLabel('這個作品可以做什麼',{exact:true}).fill('驗證只接受 GitHub 儲存庫。');
  await page.getByLabel('如何開始使用',{exact:true}).fill('先閱讀使用文件。');
  await page.getByLabel('我同意讓社群會員看見作品介紹與來源關係',{exact:true}).check();
  await page.getByRole('button',{name:'從 GitHub 登錄',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('請使用 https://github.com/');
  await expect(page.getByLabel('作品名稱',{exact:true})).toHaveValue('不應送出網路的測試');
  await page.setViewportSize({width:390,height:844});
  const width=await page.evaluate(()=>({viewport:window.innerWidth,document:document.documentElement.scrollWidth}));expect(width.document).toBeLessThanOrEqual(width.viewport);
  await page.screenshot({path:'test-results/opensource-mobile.png',fullPage:true});
});
