import { navigate } from './navigation.js';
import { test,expect,type Page } from './fixtures.js';

async function login(page:Page,email:string) {
  await page.goto('/');await page.getByLabel('電子郵件',{exact:true}).fill(email);
  await page.getByLabel('密碼',{exact:true}).fill('freedom-local-demo');
  await page.getByRole('button',{name:'登入',exact:true}).click();
  await expect(page.getByRole('heading',{name:'會員首頁',exact:true})).toBeVisible();
  await navigate(page, '我的工作');
  await expect(page.getByRole('heading',{name:'我的工作',exact:true})).toBeVisible();
}
async function switchAccount(page:Page,email:string) {await page.getByRole('button',{name:'登出',exact:true}).click();await expect(page.getByRole('heading',{name:'登入',exact:true})).toBeVisible();await login(page,email);}
const artifactLabel='成果引用（例如 artifact:template-v1）';

test('localhost alias permits browser login and logout',async({page,baseURL})=>{
  await page.goto(baseURL!.replace('127.0.0.1','localhost'));
  await page.getByLabel('電子郵件',{exact:true}).fill('maker@local.test');
  await page.getByLabel('密碼',{exact:true}).fill('freedom-local-demo');
  await page.getByRole('button',{name:'登入',exact:true}).click();
  await expect(page.getByRole('heading',{name:'會員首頁',exact:true})).toBeVisible();
  await navigate(page, '我的工作');
  await expect(page.getByRole('heading',{name:'我的工作',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'登出',exact:true}).click();
  await expect(page.getByRole('heading',{name:'登入',exact:true})).toBeVisible();
});

test('member completes work, reviewer accepts it, result survives reload and login',async({page})=>{
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  const title='把第一份作品整理成可重用說明';
  const titledCard=()=>page.locator('article.card').filter({has:page.getByRole('heading',{name:title,exact:true})});
  await login(page,'maker@local.test');
  const workCard=titledCard();await expect(workCard).toHaveCount(1);
  await workCard.getByRole('button',{name:'認領這張工作',exact:true}).click();
  await workCard.getByRole('button',{name:'開始進行',exact:true}).click();
  await workCard.getByLabel('提交摘要',{exact:true}).fill('已完成可重用範例與三個步驟。');
  await workCard.getByLabel(artifactLabel).fill('artifact:browser-result-v1');
  await workCard.getByRole('button',{name:'提交成果',exact:true}).click();
  await expect(workCard.getByText('已提交，等待回饋。')).toBeVisible();
  await switchAccount(page,'reviewer@local.test');
  const reviewSection=page.locator('section.section').filter({has:page.getByRole('heading',{name:'待你回饋',exact:true})});
  const reviewCard=reviewSection.locator('article.card').filter({has:page.getByRole('heading',{name:title,exact:true})});
  await reviewCard.getByRole('button',{name:'開始回饋',exact:true}).click();
  await reviewCard.getByLabel('回饋說明',{exact:true}).fill('範例能重跑，符合完成條件。');
  await reviewCard.getByRole('button',{name:'送出決定',exact:true}).click();
  await expect(reviewCard).toHaveCount(0);
  await switchAccount(page,'maker@local.test');
  const gainedSection=page.locator('section.section').filter({has:page.getByRole('heading',{name:'已獲得的成果',exact:true})});
  const gainedCard=gainedSection.locator('article.card').filter({has:page.getByRole('heading',{name:title,exact:true})});
  await expect(gainedCard.getByText('artifact:browser-result-v1',{exact:true})).toBeVisible();
  await page.reload();await expect(gainedCard.getByText('artifact:browser-result-v1',{exact:true})).toBeVisible();
  await page.screenshot({path:'test-results/workbench-desktop.png',fullPage:true});
  expect(errors).toEqual([]);
});

test('showcase and opportunity become a bilateral cooperation and attributed receipt report',async({page})=>{
  await login(page,'maker@local.test');await navigate(page, '作品與需求');
  await page.getByLabel('作品標題',{exact:true}).fill('瀏覽器驗證的週報模板');
  await page.getByLabel('說明',{exact:true}).fill('用合成資料產生可重用週報。');
  await page.getByLabel(artifactLabel).fill('artifact:browser-showcase-v1');
  await page.getByLabel('我同意以社群可見方式分享這件作品').check();
  await page.getByRole('button',{name:'發布作品',exact:true}).click();
  await expect(page.getByRole('heading',{name:'瀏覽器驗證的週報模板',exact:true})).toBeVisible();
  await switchAccount(page,'client@local.test');await navigate(page, '作品與需求');
  await page.getByRole('button',{name:'提出商機',exact:true}).click();
  await page.getByLabel('你的需求',{exact:true}).fill('希望調整三個週報欄位。');
  await page.getByRole('button',{name:'送出商機',exact:true}).click();
  await expect(page.getByText('希望調整三個週報欄位。',{exact:true})).toBeVisible();
  await switchAccount(page,'maker@local.test');await navigate(page, '作品與需求');
  await page.getByRole('button',{name:'提出合作',exact:true}).click();
  await page.getByLabel('合作範圍',{exact:true}).fill('調整三個欄位並提供使用說明');
  await page.getByLabel('完成條件',{exact:true}).fill('合成範例產出正確週報');
  await page.getByLabel('約定價格（新台幣，最多兩位小數）').fill('1200.50');
  await page.getByRole('button',{name:'送出合作提案',exact:true}).click();
  await expect(page.locator('p.hint',{hasText:'已提出合作'})).toHaveText('已提出合作，請到合作紀錄繼續同意、交付與收款回報。');
  await switchAccount(page,'client@local.test');await navigate(page, '合作紀錄');
  await page.getByRole('button',{name:'同意這份合作',exact:true}).click();
  await expect(page.getByText('已同意',{exact:true})).toBeVisible();
  await switchAccount(page,'maker@local.test');await navigate(page, '合作紀錄');
  await page.getByLabel(artifactLabel).fill('artifact:browser-delivery-v1');
  await page.getByRole('button',{name:'標記已交付',exact:true}).click();
  await expect(page.getByText('已交付',{exact:true})).toBeVisible();
  await switchAccount(page,'client@local.test');await navigate(page, '合作紀錄');
  await page.getByRole('button',{name:'接受交付',exact:true}).click();
  await expect(page.getByText('交付已接受',{exact:true})).toBeVisible();
  await switchAccount(page,'maker@local.test');await navigate(page, '合作紀錄');
  await page.getByLabel('回報金額（新台幣，最多兩位小數）',{exact:true}).fill('1200.50');
  await page.getByLabel('回報引用').fill('receipt:browser-demo-001');
  await page.getByRole('button',{name:'送出收款回報',exact:true}).click();
  await expect(page.getByText(/收款回報／待對方確認 ·/)).toBeVisible();
  await switchAccount(page,'client@local.test');await navigate(page, '合作紀錄');
  await page.getByRole('button',{name:'確認對方的收款回報',exact:true}).click();
  await expect(page.getByText(/雙方確認（未核對銀行）·/)).toBeVisible();
  await page.reload();await navigate(page, '合作紀錄');
  await expect(page.getByText(/雙方確認（未核對銀行）·/)).toBeVisible();
  await page.screenshot({path:'test-results/cooperation-desktop.png',fullPage:true});
});

test('phone viewport, wrong password, logout, and unavailable API remain honest',async({page})=>{
  await page.setViewportSize({width:390,height:844});await page.goto('/');
  await page.getByLabel('電子郵件',{exact:true}).fill('maker@local.test');await page.getByLabel('密碼',{exact:true}).fill('wrong');
  await page.getByRole('button',{name:'登入',exact:true}).click();await expect(page.getByRole('alert')).toContainText('帳號或密碼不正確');
  await login(page,'maker@local.test');await navigate(page, '作品與需求');
  const size=await page.evaluate(()=>({w:window.innerWidth,scroll:document.documentElement.scrollWidth}));expect(size.scroll).toBeLessThanOrEqual(size.w);
  await page.screenshot({path:'test-results/workspace-mobile.png',fullPage:true});
  await page.route('**/api/v1/engagements',r=>r.abort());await navigate(page, '合作紀錄');
  await expect(page.getByRole('alert')).toContainText('無法連線');
  await page.getByRole('button',{name:'登出',exact:true}).click();await expect(page.getByRole('heading',{name:'登入',exact:true})).toBeVisible();
  const response=await page.request.get('/api/v1/session');expect(response.status()).toBe(401);
});
