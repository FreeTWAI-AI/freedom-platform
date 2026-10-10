import {test,expect,type Page} from './fixtures.js';
import {navigate,openFeatureSearch} from './navigation.js';
import {DEMO_USERS} from '../../packages/testing/seed.js';

async function login(page:Page){
  await page.goto('/');await page.getByLabel('電子郵件',{exact:true}).fill('maker@local.test');
  await page.getByLabel('密碼',{exact:true}).fill('freedom-local-demo');
  await page.getByRole('button',{name:'登入',exact:true}).click();
  await expect(page.getByRole('heading',{name:'會員首頁',level:1})).toBeVisible();
}

test('home and navigation reveal secondary functions on demand and page tools return keyboard focus',async({page})=>{
  await login(page);
  await expect(page.locator('.nav-primary > button')).toHaveCount(5);
  await expect(page.locator('.nav-primary > button')).toHaveText(['會員首頁','社群分享','職業公會','技能書架','搜尋社群內容']);
  await expect(page.locator('.nav-more')).not.toHaveAttribute('open','');
  await expect(page.locator('.home-personal')).not.toHaveAttribute('open','');
  await expect(page.locator('.home-module-section')).not.toHaveAttribute('open','');
  await expect(page.getByRole('navigation',{name:'常用入口'}).getByRole('button')).toHaveCount(3);
  await expect(page.locator('.topbar').getByRole('button',{name:'參與編修'})).toBeHidden();
  const tools=page.locator('.page-tools-menu > summary');await tools.click();
  await page.locator('.topbar').getByRole('button',{name:'頁面說明',exact:true}).click();
  const help=page.getByRole('dialog',{name:'會員首頁：頁面說明',exact:true});await expect(help).toBeVisible();
  await page.keyboard.press('Escape');await expect(help).toHaveCount(0);await expect(tools).toBeFocused();
  await navigate(page,'社群活動');await expect(page).toHaveURL(/#events$/);
  await page.goBack();await expect(page.getByRole('heading',{name:'會員首頁',level:1})).toBeVisible();
  await openFeatureSearch(page);
  await page.getByLabel('搜尋功能').fill('聊天室');
  await page.getByRole('navigation',{name:'主要工作區'}).getByRole('region',{name:'功能搜尋結果'}).getByRole('button',{name:'我的訊息',exact:true}).click();
  await expect(page.locator('.floating-message-panel')).toBeVisible();
});

test('simple mobile home fits 320px and keeps every theme and original brand',async({page})=>{
  await page.setViewportSize({width:320,height:800});await login(page);
  for(const [name,theme] of [['自由工坊－明亮','light'],['自由工坊－夜航','rpg'],['自由工坊－敘生','versefolk']]){
    await page.getByRole('button',{name:'設定',exact:true}).click();
    await page.getByRole('menuitemradio',{name,exact:true}).click();
    await page.getByRole('button',{name:'設定',exact:true}).click();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await expect(page.locator('.sidebar-brand-art')).toHaveAttribute('src','/brand/freedom-workshop.webp');
    await page.screenshot({path:`test-results/simple-home-${theme}-320.png`,fullPage:true});
  }
});

test('one click clears notification pages while preserving chat badges and persists after reload',async({page,e2eAuthPool})=>{
  const [a,b]=DEMO_USERS.map(user=>user.user_id),prefix=`bulk-e2e-${Date.now()}`;
  for(let n=0;n<24;n++)await e2eAuthPool.query(`INSERT INTO member_notifications(community_id,recipient_ref,kind,source_key,title,body)
    SELECT community_id,user_id,'friend_request',$2,'批次通知測試','通知內容保留' FROM users WHERE user_id=$1`,[a,`${prefix}/${n}`]);
  await e2eAuthPool.query(`INSERT INTO member_direct_messages(community_id,sender_ref,recipient_ref,body)
    SELECT community_id,$2,user_id,$3 FROM users WHERE user_id=$1`,[a,b,prefix]);
  await login(page);await page.getByRole('button',{name:/^通知/}).click();
  const notices=page.getByRole('region',{name:'最近通知'});
  await notices.getByRole('button',{name:'全部標為已讀',exact:true}).click();
  await expect(page.locator('.notification-bell-count')).toHaveCount(0);
  await expect.poll(async()=>(await e2eAuthPool.query('SELECT count(*)::int AS n FROM member_notifications WHERE recipient_ref=$1 AND read_at IS NULL',[a])).rows[0].n).toBe(0);
  expect((await e2eAuthPool.query('SELECT read_at FROM member_direct_messages WHERE recipient_ref=$1 AND body=$2',[a,prefix])).rows[0].read_at).toBeNull();
  expect((await e2eAuthPool.query('SELECT count(*)::int AS n FROM member_notifications WHERE source_key LIKE $1',[`${prefix}/%`])).rows[0].n).toBe(24);
  await page.reload();await expect(page.locator('.notification-bell-count')).toHaveCount(0);
});

test('lost bulk-read acknowledgement retries the same command and keeps newly arrived reminders',async({page,e2eAuthPool})=>{
  const a=DEMO_USERS[0].user_id,prefix=`bulk-retry-${Date.now()}`;
  const add=async(key:string)=>e2eAuthPool.query(`INSERT INTO member_notifications(community_id,recipient_ref,kind,source_key,title,body)
    SELECT community_id,user_id,'friend_request',$2,'批次重試測試','新通知不能被舊重試吃掉' FROM users WHERE user_id=$1`,[a,key]);
  await add(`${prefix}/before`);await login(page);
  const keys:string[]=[];
  await page.route('**/api/v1/me/inbox/read-all',async route=>{
    keys.push(route.request().headers()['idempotency-key']);
    if(keys.length===1){await route.fetch();await add(`${prefix}/after`);await route.abort('failed');}else await route.continue();
  });
  await page.getByRole('button',{name:/^通知/}).click();const notices=page.getByRole('region',{name:'最近通知'});
  await notices.getByRole('button',{name:'全部標為已讀',exact:true}).click();
  await expect(notices.getByRole('alert')).toContainText('尚未確認全部已讀');
  await notices.getByRole('button',{name:'全部標為已讀',exact:true}).click();
  await expect(page.locator('.notification-bell-count')).toHaveText('1');
  expect(keys).toHaveLength(2);expect(keys[0]).toBe(keys[1]);
  expect((await e2eAuthPool.query('SELECT read_at FROM member_notifications WHERE source_key=$1',[`${prefix}/after`])).rows[0].read_at).toBeNull();
});
