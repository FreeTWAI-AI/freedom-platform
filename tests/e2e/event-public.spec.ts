import {test,expect} from './fixtures.js';
import {navigate} from './navigation.js';

const id='10000000-0000-4000-8000-000000000001',code='abcdefghijklmnopqrstuvwx';
const future=new Date(Date.now()+86400000).toISOString();
const publicEvent={event_id:id,title:'公開共學活動',description:'一起討論並交流。',starts_at:future,ends_at:new Date(Date.parse(future)+3600000).toISOString(),mode:'online',location:'線上參與資料將寄至報名信箱',online_url:null,event_kind:'reading_group',topic:'共學',visibility:'referral',capacity:20,attending_count:0,organizer_name:'活動夥伴',banner_url:null,video_url:null,video_mime:null};

test.beforeEach(async({page})=>{
  // These cases exercise inline event login, not the separate public-discovery join redirect.
  await page.route('**/api/v1/site',async route=>{
    const response=await route.fetch(),site=await response.json();
    await route.fulfill({response,json:{...site,community_discovery_enabled:false,event_participation_enabled:false}});
  });
});

test('public referral event keeps its share code when the URL query loses it',async({page})=>{
  let registered:string|null=null;
  await page.route(`**/api/v1/public/events/${id}`,route=>route.fulfill({json:publicEvent}));
  await page.route(`**/api/v1/public/events/${id}/register`,async route=>{registered=route.request().postDataJSON().referral_code;await route.fulfill({json:{registered:true}})});
  await page.goto(`/events/${id}?ref=${code}`);
  await expect(page.getByRole('heading',{name:'公開共學活動'})).toBeVisible();
  await expect(page.getByText('線上參與資料將寄至報名信箱')).toBeVisible();
  await page.setViewportSize({width:390,height:844});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:'test-results/event-public-phone.png',fullPage:true});
  await page.setViewportSize({width:1440,height:900});
  await page.screenshot({path:'test-results/event-public-desktop.png',fullPage:true});
  await page.goto(`/events/${id}`);
  await expect(page.getByRole('button',{name:'報名並寄送參與資料'})).toBeEnabled();
  await page.getByLabel('你的名字').fill('訪客');
  await page.getByLabel('接收參與資料的 Email').fill('guest@example.org');
  await page.getByRole('button',{name:'報名並寄送參與資料'}).click();
  await expect(page.getByText('報名已確認；Email 服務已接受參與資訊郵件，不代表郵件已送達。請檢查收件匣。')).toBeVisible();
  expect(registered).toBe(code);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.getByRole('button',{name:'會員登入'}).click();
  await expect(page.getByRole('button',{name:'登入',exact:true})).toBeVisible();
  expect(page.url()).toContain(`/events/${id}`);
});

for(const routeKind of ['path','hash'] as const)test(`public event ${routeKind} login returns to the event with its query and browser history intact`,async({page})=>{
  await page.route(`**/api/v1/public/events/${id}`,route=>route.fulfill({json:publicEvent}));
  await page.goto('/#home');
  const eventPath=routeKind==='path'?`/events/${id}?ref=${code}&utm_campaign=return-test`:`/?utm_campaign=return-test#events/${id}?ref=${code}`;
  await page.goto(eventPath);
  const eventUrl=page.url(),heading=page.getByRole('heading',{name:publicEvent.title,exact:true});
  const memberLogin=page.getByRole('button',{name:'會員登入',exact:true}),returnButton=page.getByRole('button',{name:'返回活動',exact:true});
  await expect(heading).toBeVisible();
  await memberLogin.click();
  await expect(returnButton).toBeVisible();await expect(page).toHaveURL(eventUrl);
  await page.reload();await expect(returnButton).toBeVisible();await expect(page).toHaveURL(eventUrl);
  await page.getByLabel('電子郵件',{exact:true}).fill('not-submitted@example.org');
  await returnButton.click();
  await expect(heading).toBeVisible();await expect(page).toHaveURL(eventUrl);
  await memberLogin.click();await expect(returnButton).toBeVisible();
  await page.goBack();await expect(heading).toBeVisible();await expect(page).toHaveURL(eventUrl);
  await page.goForward();await expect(returnButton).toBeVisible();await expect(page).toHaveURL(eventUrl);
  // A newer destination must not inherit the same-URL event login marker.
  await page.evaluate(()=>{window.location.hash='home';});
  await expect(page.getByRole('button',{name:'登入',exact:true})).toBeVisible();
  await expect(returnButton).toHaveCount(0);
  await page.goBack();await expect(returnButton).toBeVisible();
  await returnButton.click();await expect(heading).toBeVisible();await expect(page).toHaveURL(eventUrl);
});

test('returning from event login never restores a private participation fragment',async({page})=>{
  // This synthetic token is not issued by the server and is never submitted.
  const token='t'.repeat(43),safePath=`/events/${id}?utm_campaign=private-return-test`;
  await page.route(`**/api/v1/public/events/${id}`,route=>route.fulfill({json:publicEvent}));
  await page.goto(`${safePath}#participation=${token}`);
  await page.getByRole('button',{name:'會員登入',exact:true}).click();
  await expect(page.getByRole('button',{name:'返回活動',exact:true})).toBeVisible();
  const safeUrl=new URL(safePath,page.url()).href;
  await expect(page).toHaveURL(safeUrl);
  expect(await page.evaluate(()=>JSON.stringify(window.history.state))).not.toContain(token);
  await page.goBack();await expect(page.getByRole('heading',{name:publicEvent.title,exact:true})).toBeVisible();
  await expect(page).toHaveURL(safeUrl);
  await page.goForward();await expect(page.getByRole('button',{name:'返回活動',exact:true})).toBeVisible();
  await expect(page).toHaveURL(safeUrl);
  expect(await page.evaluate(()=>JSON.stringify(window.history.state))).not.toContain(token);
});

test('the member calendar opens a future event on its dedicated page',async({page})=>{
  const starts=new Date(Date.now()+2*86400000),ends=new Date(starts.getTime()+3600000),title='未來的共學活動';
  const event={event_id:id,organizer_ref:'20000000-0000-4000-8000-000000000002',organizer_name:'活動夥伴',title,description:'一起做一個小作品。',starts_at:starts.toISOString(),ends_at:ends.toISOString(),mode:'in_person',location:'台北市',event_kind:'meetup',topic:null,online_url:null,visibility:'workshop',banner_url:null,banner_orientation:null,video_url:null,video_mime:null,capacity:null,state:'published',aggregate_version:1,attending_count:0,my_rsvp:null,guild_key:null,review_guild_key:null,can_review:false,review_reason:null};
  await page.route('**/api/v1/events',route=>route.fulfill({json:{items:[event]}}));
  await page.goto('/');
  await page.getByLabel('電子郵件',{exact:true}).fill('maker@local.test');
  await page.getByLabel('密碼',{exact:true}).fill('freedom-local-demo');
  await page.getByRole('button',{name:'登入',exact:true}).click();
  await navigate(page,'社群活動');
  if(starts.getMonth()!==new Date().getMonth())await page.getByRole('button',{name:'下個月'}).click();
  await page.getByRole('button',{name:title}).click();
  await expect(page).toHaveURL(new RegExp(`#events/${id}$`));
  await expect(page.getByRole('region',{name:'活動專頁'}).getByRole('heading',{name:title})).toBeVisible();
});
