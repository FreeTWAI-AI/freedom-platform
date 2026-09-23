import { test,expect,type Page } from './fixtures.js';

async function login(page:Page,email:string){
  await page.goto('/');await page.getByLabel('電子郵件',{exact:true}).fill(email);await page.getByLabel('密碼',{exact:true}).fill('freedom-local-demo');await page.getByRole('button',{name:'登入',exact:true}).click();await expect(page.getByRole('button',{name:'登出',exact:true})).toBeVisible();
}
async function switchTo(page:Page,email:string){await page.getByRole('button',{name:'登出',exact:true}).click();await expect(page.getByRole('heading',{name:'登入',exact:true})).toBeVisible();await login(page,email);}

test('supplier and retailer use distinct modules, agree on exact selection, and read persisted decision',async({page})=>{
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  const title='瀏覽器演練・山茶 150g';
  await login(page,'maker@local.test');await page.getByRole('button',{name:'供貨中心',exact:true}).click();
  await expect(page.getByRole('heading',{name:'供貨中心',level:1,exact:true})).toBeVisible();
  await page.getByLabel('商品名稱',{exact:true}).fill(title);
  await page.getByLabel('商品規格與介紹',{exact:true}).fill('合成茶葉範例。150g 茶罐裝，供內部選品練習。');
  await page.getByLabel('供貨價（新台幣）',{exact:true}).fill('300.00');
  await page.getByLabel('可供數量（有明確庫存時必填）',{exact:true}).fill('20');
  await page.getByLabel('出貨方式與條件',{exact:true}).fill('演練：確認後三天宅配，運費另議');
  await page.getByLabel('退換貨條件',{exact:true}).fill('演練：瑕疵先聯絡供貨商');
  await page.getByRole('button',{name:'保存商品與供貨條件',exact:true}).click();
  await expect(page.getByRole('heading',{name:title,exact:true})).toBeVisible();
  await expect(page.getByText('供貨商自報庫存 20 件',{exact:true})).toBeVisible();
  await page.screenshot({path:'test-results/supplier-module-desktop.png',fullPage:true});

  await switchTo(page,'client@local.test');await page.getByRole('button',{name:'開店與銷售',exact:true}).click();
  await page.getByLabel('商店名稱',{exact:true}).fill('瀏覽器演練選物店');
  await page.getByLabel('商店介紹',{exact:true}).fill('幫喜歡茶的人挑選好茶。');
  await page.getByLabel('客服聯絡方式',{exact:true}).fill('演練請聯絡店主');
  await page.getByRole('button',{name:'建立預覽商店',exact:true}).click();
  await expect(page.getByRole('heading',{name:'瀏覽器演練選物店',exact:true})).toBeVisible();
  const product=page.getByRole('article').filter({has:page.getByRole('heading',{name:title,exact:true})});
  await product.getByRole('button',{name:'選這件商品',exact:true}).click();
  await page.getByLabel('預計售價（新台幣）',{exact:true}).fill('550.25');
  await page.getByLabel('對買家的銷售說明',{exact:true}).fill('茶葉禮盒；由本店服務買家。');
  await page.getByRole('button',{name:'保存選品草稿',exact:true}).click();
  const listings=page.getByRole('region',{name:'我的選品與供貨狀態',exact:true});
  await expect(listings.getByText('選品草稿',{exact:true})).toBeVisible();
  await listings.getByRole('button',{name:'送出供貨確認（內部演練）',exact:true}).click();
  await expect(listings.getByText('待供貨商回覆',{exact:true})).toBeVisible();

  await switchTo(page,'maker@local.test');await page.getByRole('button',{name:'供貨中心',exact:true}).click();
  const requests=page.getByRole('region',{name:'銷售者的供貨請求',exact:true});
  await expect(requests.getByText('茶葉禮盒；由本店服務買家。',{exact:true})).toBeVisible();
  await expect(requests.getByText(/550\.25/)).toBeVisible();
  await requests.getByLabel('給銷售者的說明',{exact:true}).fill('演練供貨確認，售價與出貨說明已核對。');
  await requests.getByLabel('我已核對以上商品、售價與條件；這是內部演練回覆。',{exact:true}).check();
  await requests.getByRole('button',{name:'保存供貨回覆',exact:true}).click();
  await expect(requests.getByText('供貨商已確認（內部演練）',{exact:true})).toBeVisible();

  await switchTo(page,'client@local.test');await page.getByRole('button',{name:'開店與銷售',exact:true}).click();
  await expect(page.getByText('供貨商已確認（內部演練）',{exact:true})).toBeVisible();
  await page.reload();await page.getByRole('button',{name:'開店與銷售',exact:true}).click();
  await expect(page.getByText('供貨商已確認（內部演練）',{exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'結帳',exact:true})).toHaveCount(0);
  await page.setViewportSize({width:390,height:844});
  await expect(page.getByRole('heading',{name:'開店與銷售',level:1,exact:true})).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
  await page.screenshot({path:'test-results/retail-module-mobile.png',fullPage:true});
  expect(errors).toEqual([]);
});
