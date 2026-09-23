import { navigate } from './navigation.js';
import {test,expect,type Page} from './fixtures.js';

const caps={managed_guilds:[{guild_key:'synthetic-guild',name:'測試公會'}],managed_books:[{book_id:'video-autopilot',title:'測試剪輯技能'}],can_discuss:true};
const announcement={announcement_id:'synthetic-announcement',guild_key:'synthetic-guild',title:'週末共創',body:'帶一段合成素材一起測試。',state:'published',aggregate_version:2,created_at:'2026-09-23T10:00:00Z',updated_at:'2026-09-23T10:00:00Z'};
async function login(page:Page){await page.goto('/');await page.getByLabel('電子郵件',{exact:true}).fill('maker@local.test');await page.getByLabel('密碼',{exact:true}).fill('freedom-local-demo');await page.getByRole('button',{name:'登入',exact:true}).click();}
test.beforeEach(async({page})=>{
  await page.route('**/api/v1/guild-workspace',route=>route.fulfill({json:caps}));
  await page.route('**/api/v1/me/github',route=>route.fulfill({json:{configured:false,connected:false,github_user:null}}));
});
test('guild leaders edit announcements with version checks and retain their draft on a conflict',async({page})=>{
  await page.route('**/api/v1/guilds/synthetic-guild/announcements',route=>route.fulfill({json:{items:[announcement]}}));
  let writes=0;await page.route('**/api/v1/guild-announcements/synthetic-announcement/edit',route=>{writes++;expect(route.request().headers()['if-match']).toBe('"2"');expect(route.request().headers()['x-csrf-token']).toBeTruthy();expect(route.request().postDataJSON()).toMatchObject({title:'週末共創更新',state:'published'});return route.fulfill({status:412,json:{detail:'公告已由另一位會長更新，請重新載入。'}});});
  await login(page);await navigate(page, '公會管理');await page.getByRole('button',{name:'編輯公告',exact:true}).click();await page.getByLabel('公告標題',{exact:true}).fill('週末共創更新');await page.getByRole('button',{name:'保存公告',exact:true}).click();await expect(page.getByRole('alert')).toContainText('另一位會長更新');await expect(page.getByLabel('公告標題',{exact:true})).toHaveValue('週末共創更新');expect(writes).toBe(1);await expect(page.getByText('公告已保存。',{exact:true})).toHaveCount(0);
});
test('skill maintainers publish structured tasks and milestones without a raw JSON editor',async({page})=>{
  await page.route('**/api/v1/guilds/synthetic-guild/announcements',route=>route.fulfill({json:{items:[]}}));
  const draft={book_id:'video-autopilot',summary:'一起製作剪輯工具。',collaboration_intro:'補上可重跑的合成素材測試。',milestones:[],tasks:[],aggregate_version:0,updated_at:null};let saved:any;
  await page.route('**/api/v1/skill-books/video-autopilot/editor',route=>{if(route.request().method()==='POST'){saved=route.request().postDataJSON();expect(route.request().headers()['if-match']).toBeUndefined();expect(route.request().headers()['idempotency-key']).toBeTruthy();return route.fulfill({json:{...draft,...saved,aggregate_version:1,updated_at:'2026-09-23T12:00:00Z'}});}return route.fulfill({json:draft});});
  await login(page);await navigate(page, '公會管理');await page.getByRole('button',{name:'技能書編輯',exact:true}).click();await expect(page.getByRole('textbox',{name:'一句話摘要',exact:true})).toHaveValue(draft.summary);
  await page.getByRole('button',{name:'新增里程碑',exact:true}).click();await page.getByLabel('里程碑 1',{exact:true}).fill('第一組剪輯回歸');await page.getByRole('button',{name:'新增協作任務',exact:true}).click();await page.getByLabel('任務標題',{exact:true}).fill('加入合成字幕素材');await page.getByLabel('修改範圍',{exact:true}).fill('在 fixtures 加入十秒片段。');await page.getByLabel('完成條件（每行一項）',{exact:true}).fill('可重跑產生相同時長\n字幕位置有斷言');await page.getByRole('combobox',{name:'所屬里程碑',exact:true}).selectOption({label:'第一組剪輯回歸'});await page.getByRole('button',{name:'保存技能書',exact:true}).click();await expect(page.locator('.guild-workspace').getByRole('status')).toContainText('分享頁同步更新');expect(saved.tasks[0].acceptance).toEqual(['可重跑產生相同時長','字幕位置有斷言']);expect(saved.tasks[0].milestone_id).toBe(saved.milestones[0].id);expect(saved.tasks[0].status).toBe('todo');await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});
test('private council posts a reply with member CSRF and renders plain text safely',async({page})=>{
  await page.route('**/api/v1/guilds/synthetic-guild/announcements',route=>route.fulfill({json:{items:[]}}));
  const thread={thread_id:'synthetic-thread',title:'跨公會共創安排',body:'<script>window.fake=true</script>',author_name:'測試會長',created_at:'2026-09-23T10:00:00Z',replies:[] as any[]};
  await page.route('**/api/v1/guild-council/threads',route=>route.fulfill({json:{items:[{...thread,replies:undefined,reply_count:thread.replies.length}]}}));
  await page.route('**/api/v1/guild-council/threads/synthetic-thread',route=>route.fulfill({json:thread}));
  await page.route('**/api/v1/guild-council/threads/synthetic-thread/replies',route=>{expect(route.request().headers()['x-csrf-token']).toBeTruthy();expect(route.request().postDataJSON()).toEqual({body:'我會整理測試素材。'});thread.replies.push({reply_id:'synthetic-reply',body:'我會整理測試素材。',author_name:'測試成員',created_at:'2026-09-23T11:00:00Z'});return route.fulfill({json:thread});});
  await login(page);await navigate(page, '公會管理');await page.getByRole('button',{name:'公會長議事區',exact:true}).click();await page.getByRole('button',{name:/跨公會共創安排/}).click();await expect(page.locator('.guild-workspace-body')).toHaveText(thread.body);expect(await page.evaluate(()=>(window as any).fake)).toBeUndefined();await page.getByLabel('回覆討論',{exact:true}).fill('我會整理測試素材。');await page.getByRole('button',{name:'發布回覆',exact:true}).click();await expect(page.locator('.guild-workspace').getByRole('status')).toContainText('回覆已發布');await expect(page.locator('.guild-council-reply')).toContainText('我會整理測試素材。');
});
test('Access admins assign and revoke a skill maintainer with a reason and admin CSRF',async({page})=>{
  let maintainers:{user_id:string;display_name:string;active:boolean;aggregate_version:number}[]=[];const writes:any[]=[];
  await page.route('**/admin/api/**',route=>{
    const path=new URL(route.request().url()).pathname.replace('/admin/api','');
    if(path==='/bootstrap')return route.fulfill({json:{admin:{admin_id:'synthetic-admin',display_name:'管理員',email:'admin@example.test',role:'super_admin',community_id:'synthetic-community'},csrf_token:'synthetic-csrf',summary:{members:1,active_members:1,pending_guild_applications:0,guilds:1,admins:1},available_skill_books:[],pending_guild_appointments:[]}});
    if(path==='/members')return route.fulfill({json:{items:[{user_id:'synthetic-member',display_name:'測試維護者',email:'member@example.test',active:true}],next_offset:null}});
    if(path==='/skill-maintainers')return route.fulfill({json:{items:[{book_id:'video-autopilot',title:'測試剪輯技能',maintainers}]}});
    if(path==='/skill-maintainers/video-autopilot'){expect(route.request().headers()['x-admin-csrf']).toBe('synthetic-csrf');const body=route.request().postDataJSON();if(maintainers.length)expect(route.request().headers()['if-match']).toBe(`"${maintainers[0].aggregate_version}"`);else expect(route.request().headers()['if-match']).toBeUndefined();writes.push(body);maintainers=[{user_id:'synthetic-member',display_name:'測試維護者',active:body.active,aggregate_version:(maintainers[0]?.aggregate_version??0)+1}];return route.fulfill({json:{book_id:'video-autopilot',maintainers}});}
    return route.fulfill({status:404,json:{detail:'unexpected fixture'}});
  });
  await page.goto('/admin');await page.getByRole('button',{name:'會長與維護者',exact:true}).click();await page.getByLabel('任命或解除原因',{exact:true}).fill('負責這一輪剪輯共創');await page.getByLabel('搜尋姓名或 E-mail',{exact:true}).fill('測試維護者');await page.getByRole('button',{name:'搜尋會員',exact:true}).click();await page.getByRole('combobox',{name:'選擇會員',exact:true}).selectOption('synthetic-member');await page.getByRole('button',{name:'任命為技能書維護者',exact:true}).click();await expect(page.locator('.guild-workspace').getByRole('status')).toContainText('已任命技能書維護者');await page.getByLabel('任命或解除原因',{exact:true}).fill('交接完成解除職務');await page.getByRole('button',{name:'解除維護職務',exact:true}).click();await expect(page.locator('.guild-workspace').getByRole('status')).toContainText('已解除技能書維護職務');await expect(page.getByText('尚未任命維護者。',{exact:true})).toBeVisible();await page.getByLabel('任命或解除原因',{exact:true}).fill('重新承接維護工作');await page.getByRole('button',{name:'搜尋會員',exact:true}).click();await page.getByRole('combobox',{name:'選擇會員',exact:true}).selectOption('synthetic-member');await page.getByRole('button',{name:'任命為技能書維護者',exact:true}).click();await expect(page.locator('.guild-workspace').getByRole('status')).toContainText('已任命技能書維護者');expect(writes.map(value=>value.active)).toEqual([true,false,true]);expect(writes.every(value=>value.user_id==='synthetic-member'&&value.reason.length>0)).toBe(true);
});

test('a slower council detail cannot replace the thread selected more recently',async({page})=>{
  await page.route('**/api/v1/guilds/synthetic-guild/announcements',route=>route.fulfill({json:{items:[]}}));
  const first={thread_id:'first',title:'第一個討論',body:'第一份內容',author_name:'測試會長',created_at:'2026-09-23T10:00:00Z',replies:[]},second={...first,thread_id:'second',title:'第二個討論',body:'第二份內容'};
  await page.route('**/api/v1/guild-council/threads',route=>route.fulfill({json:{items:[first,second].map(({replies,...item})=>({...item,reply_count:0}))}}));
  let release!:()=>void,requested!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{requested=resolve;});
  await page.route('**/api/v1/guild-council/threads/first',async route=>{requested();await gate;await route.fulfill({json:first});});
  await page.route('**/api/v1/guild-council/threads/second',route=>route.fulfill({json:second}));
  await login(page);await navigate(page, '公會管理');await page.getByRole('button',{name:'公會長議事區',exact:true}).click();await page.getByRole('button',{name:/第一個討論/}).click();await started;await page.getByRole('button',{name:/第二個討論/}).click();await expect(page.locator('.guild-workspace-body')).toHaveText('第二份內容');const delivered=page.waitForResponse(response=>response.url().endsWith('/guild-council/threads/first'));release();await delivered;await expect(page.locator('.guild-workspace-body')).toHaveText('第二份內容');await expect(page.getByRole('heading',{name:'第一個討論',exact:true})).toHaveCount(0);
});

test('retry after an unknown announcement result retains the idempotency key',async({page})=>{
  const keys:string[]=[],items:any[]=[];
  await page.route('**/api/v1/guilds/synthetic-guild/announcements',route=>{
    if(route.request().method()==='GET')return route.fulfill({json:{items}});
    keys.push(route.request().headers()['idempotency-key']);
    if(keys.length===1){items.push({...announcement,...route.request().postDataJSON()});return route.fulfill({status:503,json:{detail:'回應中斷，保存結果尚未確認。'}});}
    return route.fulfill({json:items[0]});
  });
  await login(page);await navigate(page, '公會管理');await page.getByLabel('公告標題',{exact:true}).fill('安排下一場共創');await page.getByLabel('公告內容',{exact:true}).fill('帶一份可以公開的合成測試素材。');await page.getByRole('button',{name:'保存公告',exact:true}).click();await expect(page.getByRole('alert')).toContainText('尚未確認');await expect(page.getByLabel('公告標題',{exact:true})).toHaveValue('安排下一場共創');await page.getByRole('button',{name:'保存公告',exact:true}).click();await expect(page.locator('.guild-workspace').getByRole('status')).toContainText('公告已保存');expect(keys).toHaveLength(2);expect(keys[0]).toBeTruthy();expect(keys[1]).toBe(keys[0]);expect(items).toHaveLength(1);
});
