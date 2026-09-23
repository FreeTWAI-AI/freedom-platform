import {test,expect,type Page} from './fixtures.js';

const guilds=[{guild_key:'engineering',name:'平台工程公會'},{guild_key:'media',name:'媒體自動化公會'}];
function member(index:number,extra:Record<string,unknown>={}){return {user_id:`synthetic-member-${index}`,nickname:`夥伴 ${String(index).padStart(2,'0')}`,positioning_title:'共同創作者',primary_guild:{...guilds[0],joined_at:'2026-09-22T10:00:00Z'},secondary_guilds:[{...guilds[1],joined_at:'2026-09-23T10:00:00Z'}],capabilities:['typescript','react','node','python'],featured_capabilities:['typescript','react','node'],custom_capabilities:['活動企劃'],equipment:['codex'],custom_equipment:[],contacts:{},is_self:false,friendship:{state:'none'},joined_at:'2026-09-23T10:00:00Z',...extra};}
async function openDirectory(page:Page){await page.goto('/');await page.getByLabel('電子郵件',{exact:true}).fill('maker@local.test');await page.getByLabel('密碼',{exact:true}).fill('freedom-local-demo');await page.getByRole('button',{name:'登入',exact:true}).click();await page.getByRole('button',{name:'工坊夥伴',exact:true}).click();return page.locator('.members-panel');}
test.beforeEach(async({page})=>{
  await page.route('**/api/v1/guilds/directory',route=>route.fulfill({json:{items:guilds}}));
  await page.route('**/api/v1/friends',route=>route.fulfill({json:{items:[]}}));
  await page.route('**/api/v1/me/github',route=>route.fulfill({json:{configured:false,connected:false,github_user:null}}));
});

test('member filters and pagination keep the server query together and reset to newest',async({page})=>{
  const requests:URLSearchParams[]=[];
  await page.route('**/api/v1/members?*',route=>{
    const q=new URL(route.request().url()).searchParams;requests.push(q);const offset=Number(q.get('offset'));
    if(q.get('search')==='企劃'&&q.get('guild_key')==='media'&&q.get('sort')==='oldest')return route.fulfill({json:{items:offset?[member(21,{nickname:'第 21 位企劃夥伴'})]:Array.from({length:20},(_,index)=>member(index+1)),next_offset:offset?null:20,total:21}});
    return route.fulfill({json:{items:[member(1)],next_offset:null,total:1}});
  });
  const panel=await openDirectory(page);await expect(panel.locator('.directory-result-count')).toHaveText('顯示 1 / 1 位夥伴');expect(requests[0].get('sort')).toBe('newest');
  await panel.getByRole('searchbox',{name:'搜尋夥伴',exact:true}).fill('企劃');await panel.getByRole('combobox',{name:'依公會篩選',exact:true}).selectOption('media');await panel.getByRole('combobox',{name:'排序方式',exact:true}).selectOption('oldest');await panel.getByRole('button',{name:'搜尋',exact:true}).click();
  await expect(panel.locator('.directory-member')).toHaveCount(20);await expect(panel.locator('.directory-result-count')).toHaveText('顯示 20 / 21 位夥伴');await panel.getByRole('button',{name:'查看更多夥伴',exact:true}).click();await expect(panel.getByRole('heading',{name:'第 21 位企劃夥伴',exact:true})).toBeVisible();await expect(panel.locator('.directory-result-count')).toHaveText('顯示 21 / 21 位夥伴');await expect(panel.getByRole('button',{name:'查看更多夥伴',exact:true})).toHaveCount(0);
  const continuation=requests.find(q=>q.get('offset')==='20')!;expect(continuation.get('search')).toBe('企劃');expect(continuation.get('guild_key')).toBe('media');expect(continuation.get('sort')).toBe('oldest');expect(continuation.get('limit')).toBe('20');
  await panel.getByRole('button',{name:'重設篩選',exact:true}).click();await expect(panel.getByRole('searchbox',{name:'搜尋夥伴',exact:true})).toHaveValue('');await expect(panel.getByRole('combobox',{name:'依公會篩選',exact:true})).toHaveValue('');await expect(panel.getByRole('combobox',{name:'排序方式',exact:true})).toHaveValue('newest');await expect(panel.locator('.directory-member')).toHaveCount(1);
  expect(requests.at(-1)!.has('search')).toBe(false);expect(requests.at(-1)!.has('guild_key')).toBe(false);
});

test('older filter responses never overwrite a newer guild selection',async({page})=>{
  let release!:()=>void,requested!:()=>void;const pending=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{requested=resolve;});
  await page.route('**/api/v1/members?*',async route=>{
    if(new URL(route.request().url()).searchParams.get('guild_key')==='media')return route.fulfill({json:{items:[member(2,{nickname:'目前選取的公會夥伴'})],next_offset:null,total:1}});
    requested();await pending;await route.fulfill({json:{items:[member(1,{nickname:'過期回應的夥伴'})],next_offset:null,total:1}});
  });
  const panel=await openDirectory(page);await started;await panel.getByRole('combobox',{name:'依公會篩選',exact:true}).selectOption('media');await expect(panel.getByRole('heading',{name:'目前選取的公會夥伴',exact:true})).toBeVisible();const delivered=page.waitForResponse(response=>response.url().includes('/api/v1/members?')&&!new URL(response.url()).searchParams.has('guild_key'));release();await delivered;await expect(panel.getByRole('heading',{name:'目前選取的公會夥伴',exact:true})).toBeVisible();await expect(panel.getByRole('heading',{name:'過期回應的夥伴',exact:true})).toHaveCount(0);
});

test('an old load-more response cannot append members after the search changes',async({page})=>{
  let release!:()=>void,requested!:()=>void;const pending=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{requested=resolve;});
  await page.route('**/api/v1/members?*',async route=>{
    const query=new URL(route.request().url()).searchParams;
    if(query.get('search')==='剪輯')return route.fulfill({json:{items:[member(30,{nickname:'剪輯夥伴'})],next_offset:null,total:1}});
    if(query.get('offset')==='20'){requested();await pending;return route.fulfill({json:{items:[member(21,{nickname:'舊頁尾夥伴'})],next_offset:null,total:21}});}
    return route.fulfill({json:{items:Array.from({length:20},(_,index)=>member(index+1)),next_offset:20,total:21}});
  });
  const panel=await openDirectory(page);await panel.getByRole('button',{name:'查看更多夥伴',exact:true}).click();await started;await panel.getByRole('searchbox',{name:'搜尋夥伴',exact:true}).fill('剪輯');await expect(panel.getByRole('heading',{name:'剪輯夥伴',exact:true})).toBeVisible();const delivered=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/v1/members'&&new URL(response.url()).searchParams.get('offset')==='20');release();await delivered;await expect(panel.locator('.directory-member')).toHaveCount(1);await expect(panel.getByRole('heading',{name:'舊頁尾夥伴',exact:true})).toHaveCount(0);await expect(panel.locator('.directory-result-count')).toHaveText('顯示 1 / 1 位夥伴');
});

test('compact rows keep three skills visible and fold permitted contact and guild dates on desktop and phone',async({page})=>{
  await page.route('**/api/v1/members?*',route=>route.fulfill({json:{items:[member(1,{nickname:'一位有很長暱稱的影音與活動共創夥伴',contacts:{discord:'visible-handle'},login_email:'private@example.test',joined_at:'2026-09-22T16:00:00.000Z',joined_at_source:'launch_day'}),member(2,{nickname:'隱私夥伴',joined_at:null})],next_offset:null,total:2}}));
  const panel=await openDirectory(page),row=panel.locator('.directory-member').first();await expect(row.locator('.directory-member-skills .pill')).toHaveCount(3);const details=row.locator('details');await expect(details).not.toHaveAttribute('open');await expect(row.getByText('visible-handle',{exact:true})).not.toBeVisible();await expect(row.locator('.directory-member-meta time')).toHaveText('2026/09/23');await expect(panel).not.toContainText('private@example.test');
  await details.locator('summary').click();await expect(row.getByText('visible-handle',{exact:true})).toBeVisible();await expect(row.getByRole('heading',{name:'公會加入紀錄',exact:true})).toBeVisible();await expect(row.locator('.directory-guild-dates time')).toHaveText(['2026/09/22','2026/09/23']);await expect(row.getByText('活動企劃',{exact:true})).toBeVisible();
  const privateRow=panel.getByRole('article',{name:'隱私夥伴',exact:true});await privateRow.locator('summary').click();await expect(privateRow).toContainText('沒有對你公開的聯絡方式');await expect(privateRow.locator('.directory-member-meta')).toContainText('加入日期未記錄');
  await page.setViewportSize({width:320,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:'test-results/member-directory-phone.png'});
  await page.getByRole('button',{name:'我的名片',exact:true}).click();await expect(page.locator('.account-panel .member-card')).toHaveCount(1);await expect(page.locator('.account-panel .directory-member')).toHaveCount(0);await expect(page.getByLabel('喜歡的暱稱',{exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'保存個人資料與公開範圍',exact:true})).toBeVisible();
});

test('empty search and retry states remain distinct and keep the selected filters',async({page})=>{
  let broken=false;const queries:URLSearchParams[]=[];
  await page.route('**/api/v1/members?*',route=>{const query=new URL(route.request().url()).searchParams;queries.push(query);return broken?route.fulfill({status:503,json:{detail:'夥伴清單暫時無法讀取。'}}):route.fulfill({json:{items:query.has('search')?[]:[member(1)],next_offset:null,total:query.has('search')?0:1}});});
  const panel=await openDirectory(page);await panel.getByRole('searchbox',{name:'搜尋夥伴',exact:true}).fill('不存在的專長');await expect(panel.getByText('沒有符合的夥伴。換個關鍵字或公會試試。',{exact:true})).toBeVisible();broken=true;await panel.getByRole('combobox',{name:'排序方式',exact:true}).selectOption('nickname');await expect(panel.getByRole('alert')).toContainText('夥伴清單暫時無法讀取');await expect(panel.getByText('沒有符合的夥伴。換個關鍵字或公會試試。',{exact:true})).toHaveCount(0);broken=false;await panel.getByRole('button',{name:'重新載入夥伴',exact:true}).click();await expect(panel.getByRole('alert')).toHaveCount(0);await expect(panel.locator('.directory-result-count')).toHaveText('顯示 0 / 0 位夥伴');expect(queries.at(-1)!.get('sort')).toBe('nickname');expect(queries.at(-1)!.get('search')).toBe('不存在的專長');await panel.getByRole('button',{name:'查看全部夥伴',exact:true}).click();await expect(panel.locator('.directory-member')).toHaveCount(1);
});
