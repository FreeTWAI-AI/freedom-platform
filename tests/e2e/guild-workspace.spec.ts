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
    if(path==='/members')return route.fulfill({json:{items:[{user_id:'synthetic-member',display_name:'測試維護者',email:'member@example.test',active:true,onboarding_required:false,onboarding_completed_at:null,aggregate_version:1,guilds:[]}],next_offset:null}});
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

test('management tabs retain announcement and skill drafts without opening unvisited private panels',async({page})=>{
  let skillReads=0,councilReads=0;
  let permissions=caps;
  await page.route('**/api/v1/guild-workspace',route=>route.fulfill({json:permissions}));
  await page.route('**/api/v1/guilds/synthetic-guild/announcements',route=>route.fulfill({json:{items:[]}}));
  await page.route('**/api/v1/skill-books/video-autopilot/editor',route=>{skillReads++;return route.fulfill({json:{book_id:'video-autopilot',summary:'原技能摘要',collaboration_intro:'原協作說明',milestones:[],tasks:[],aggregate_version:4,updated_at:null}});});
  await page.route('**/api/v1/guild-council/threads',route=>{councilReads++;return route.fulfill({json:{items:[]}});});
  await login(page);await navigate(page,'公會管理');
  const workspace=page.locator('.guild-workspace'),tabs=workspace.getByRole('navigation',{name:'公會管理功能'});
  const title=workspace.getByLabel('公告標題',{exact:true}),body=workspace.getByLabel('公告內容',{exact:true});
  await title.fill('尚未保存的公告');await body.fill('仍屬於原公會的公告草稿');
  expect(skillReads).toBe(0);expect(councilReads).toBe(0);
  await tabs.getByRole('button',{name:'技能書編輯',exact:true}).click();
  const summary=workspace.getByLabel('一句話摘要',{exact:true});
  await expect(summary).toHaveValue('原技能摘要');await summary.fill('尚未保存的技能摘要');
  await expect(title).toBeHidden();await expect(title).toHaveValue('尚未保存的公告');
  await tabs.getByRole('button',{name:'公會公告',exact:true}).click();
  await expect(title).toBeVisible();await expect(title).toHaveValue('尚未保存的公告');
  await expect(body).toHaveValue('仍屬於原公會的公告草稿');await expect(summary).toBeHidden();
  permissions={...caps,managed_guilds:[...caps.managed_guilds,{guild_key:'another-guild',name:'另一公會'}],managed_books:[...caps.managed_books,{book_id:'another-book',title:'另一技能書'}]};
  await page.evaluate(()=>window.dispatchEvent(new Event('freedom-profile-updated')));
  await expect(workspace.getByLabel('管理公會',{exact:true}).locator('option')).toHaveCount(2);
  await expect(title).toHaveValue('尚未保存的公告');await expect(body).toHaveValue('仍屬於原公會的公告草稿');
  await title.focus();await page.keyboard.press('Tab');await expect(body).toBeFocused();
  await tabs.getByRole('button',{name:'技能書編輯',exact:true}).click();
  await expect(summary).toHaveValue('尚未保存的技能摘要');expect(skillReads).toBe(1);expect(councilReads).toBe(0);
});

test('a pending announcement save survives tab changes and retries an unknown result with its original body version and key',async({page})=>{
  const writes:{body:unknown;version:string|undefined;key:string|undefined}[]=[];
  let saved=announcement,release=()=>{};
  let permissions=caps;
  await page.route('**/api/v1/guild-workspace',route=>route.fulfill({json:permissions}));
  const gate=new Promise<void>(resolve=>{release=resolve;});
  await page.route('**/api/v1/guilds/synthetic-guild/announcements',route=>route.fulfill({json:{items:[saved]}}));
  await page.route('**/api/v1/skill-books/video-autopilot/editor',route=>route.fulfill({json:{book_id:'video-autopilot',summary:'技能摘要',collaboration_intro:'協作說明',milestones:[],tasks:[],aggregate_version:4,updated_at:null}}));
  await page.route('**/api/v1/guild-announcements/synthetic-announcement/edit',async route=>{
    writes.push({body:route.request().postDataJSON(),version:route.request().headers()['if-match'],key:route.request().headers()['idempotency-key']});
    if(writes.length===1){await gate;return route.fulfill({status:503,json:{detail:'保存結果尚未確認。'}});}
    saved={...announcement,...route.request().postDataJSON(),aggregate_version:3};return route.fulfill({json:saved});
  });
  try{
    await login(page);await navigate(page,'公會管理');
    const workspace=page.locator('.guild-workspace'),tabs=workspace.getByRole('navigation',{name:'公會管理功能'});
    await workspace.getByRole('button',{name:'編輯公告',exact:true}).click();
    await workspace.getByLabel('公告標題',{exact:true}).fill('保留原操作的公告');
    await workspace.getByLabel('公告內容',{exact:true}).fill('原公告正文與版本');
    await workspace.getByRole('button',{name:'保存公告',exact:true}).click();await expect.poll(()=>writes.length).toBe(1);
    await tabs.getByRole('button',{name:'技能書編輯',exact:true}).click();
    await expect(workspace.getByLabel('公告標題',{exact:true})).toBeHidden();
    permissions={...caps,managed_guilds:[...caps.managed_guilds,{guild_key:'another-guild',name:'另一公會'}]};
    await page.evaluate(()=>window.dispatchEvent(new Event('freedom-profile-updated')));
    await expect(workspace.getByLabel('管理公會',{exact:true}).locator('option')).toHaveCount(2);
    await expect(workspace.getByLabel('公告標題',{exact:true})).toHaveValue('保留原操作的公告');
    await expect(workspace.getByLabel('公告標題',{exact:true})).toBeDisabled();
    const failed=page.waitForResponse(response=>response.url().endsWith('/guild-announcements/synthetic-announcement/edit'));
    release();expect((await failed).status()).toBe(503);
    await tabs.getByRole('button',{name:'公會公告',exact:true}).click();
    await expect(workspace.getByRole('alert')).toContainText('尚未確認');
    await expect(workspace.getByLabel('公告標題',{exact:true})).toHaveValue('保留原操作的公告');
    await expect(workspace.getByLabel('公告內容',{exact:true})).toHaveValue('原公告正文與版本');
    await workspace.getByRole('button',{name:'保存公告',exact:true}).click();
    await expect(workspace.getByRole('status')).toContainText('公告已保存');
    expect(writes).toHaveLength(2);expect(writes[0].key).toBeTruthy();expect(writes[0].version).toBe('"2"');
    expect(writes[0].body).toEqual({title:'保留原操作的公告',body:'原公告正文與版本',state:'published'});expect(writes[1]).toEqual(writes[0]);
    await tabs.getByRole('button',{name:'技能書編輯',exact:true}).click();await tabs.getByRole('button',{name:'公會公告',exact:true}).click();
    await expect(workspace.getByRole('heading',{name:'保留原操作的公告',exact:true})).toBeVisible();expect(writes).toHaveLength(2);
  }finally{release();}
});

test('removing selected management targets clears their hidden drafts without reviving them when grants return',async({page})=>{
  const otherGuild={guild_key:'another-guild',name:'另一公會'},otherBook={book_id:'another-book',title:'另一技能書'};
  let permissions={...caps,managed_guilds:[...caps.managed_guilds,otherGuild],managed_books:[...caps.managed_books,otherBook]},release=()=>{},saving=false;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  await page.route('**/api/v1/guild-workspace',route=>route.fulfill({json:permissions}));
  await page.route('**/api/v1/guilds/*/announcements',async route=>{
    if(route.request().method()==='GET')return route.fulfill({json:{items:[]}});
    saving=true;await gate;return route.fulfill({json:{...announcement,...route.request().postDataJSON(),aggregate_version:3}});
  });
  await page.route('**/api/v1/skill-books/*/editor',route=>route.fulfill({json:{book_id:new URL(route.request().url()).pathname.split('/').at(-2),summary:'目前授權的摘要',collaboration_intro:'協作說明',milestones:[],tasks:[],aggregate_version:4,updated_at:null}}));
  await page.route('**/api/v1/guild-council/threads',route=>route.fulfill({json:{items:[]}}));
  try{
  await login(page);await navigate(page,'公會管理');
  const workspace=page.locator('.guild-workspace'),tabs=workspace.getByRole('navigation',{name:'公會管理功能'});
  await workspace.getByLabel('公告標題',{exact:true}).fill('撤權後不可保留的公告');
  await workspace.getByLabel('公告內容',{exact:true}).fill('原公會待確認的正文');
  await workspace.getByRole('button',{name:'保存公告',exact:true}).click();await expect.poll(()=>saving).toBe(true);
  await tabs.getByRole('button',{name:'技能書編輯',exact:true}).click();
  await workspace.getByLabel('一句話摘要',{exact:true}).fill('撤權後不可保留的技能草稿');
  permissions={...caps,managed_guilds:[otherGuild],managed_books:[otherBook]};
  await page.evaluate(()=>window.dispatchEvent(new Event('freedom-profile-updated')));
  await expect(workspace.getByLabel('管理技能書',{exact:true})).toHaveValue(otherBook.book_id);
  await expect(workspace.getByLabel('一句話摘要',{exact:true})).toHaveValue('目前授權的摘要');
  await tabs.getByRole('button',{name:'公會公告',exact:true}).click();
  await expect(workspace.getByLabel('管理公會',{exact:true})).toHaveValue(otherGuild.guild_key);
  await expect(workspace.getByLabel('公告標題',{exact:true})).toHaveValue('');
  await workspace.getByLabel('公告標題',{exact:true}).fill('新公會尚未保存的公告');
  const completed=page.waitForResponse(response=>response.request().method()==='POST'&&response.url().endsWith('/guilds/synthetic-guild/announcements'));
  const oldReload=page.waitForResponse(response=>response.request().method()==='GET'&&response.url().endsWith('/guilds/synthetic-guild/announcements'));
  release();const completedResponse=await completed;expect(completedResponse.status()).toBe(200);await completedResponse.finished();
  // The old save clears its local draft before this follow-up read. Waiting for
  // that continuation makes the replacement-draft assertion deterministic.
  await (await oldReload).finished();
  await expect(workspace.getByLabel('公告標題',{exact:true})).toHaveValue('新公會尚未保存的公告');
  await expect(workspace.getByLabel('公告標題',{exact:true})).toBeEnabled();
  await expect(workspace.getByText('公告已保存。',{exact:true})).toHaveCount(0);
  permissions={...caps,managed_guilds:[...caps.managed_guilds,otherGuild],managed_books:[...caps.managed_books,otherBook]};
  await page.evaluate(()=>window.dispatchEvent(new Event('freedom-profile-updated')));
  await expect(workspace.getByLabel('管理公會',{exact:true}).locator('option')).toHaveCount(2);
  await expect(workspace.getByLabel('管理公會',{exact:true})).toHaveValue(otherGuild.guild_key);
  await workspace.getByLabel('管理公會',{exact:true}).selectOption('synthetic-guild');
  await expect(workspace.getByLabel('公告標題',{exact:true})).toHaveValue('');
  await tabs.getByRole('button',{name:'技能書編輯',exact:true}).click();
  await expect(workspace.getByLabel('管理技能書',{exact:true})).toHaveValue(otherBook.book_id);
  await workspace.getByLabel('管理技能書',{exact:true}).selectOption('video-autopilot');
  await expect(workspace.getByLabel('一句話摘要',{exact:true})).toHaveValue('目前授權的摘要');
  permissions={...caps,managed_guilds:[],managed_books:[]};
  await page.evaluate(()=>window.dispatchEvent(new Event('freedom-profile-updated')));
  await expect(tabs.getByRole('button',{name:'技能書編輯',exact:true})).toHaveCount(0);
  await expect(workspace.getByLabel('公告標題',{exact:true})).toHaveCount(0);await expect(workspace.getByLabel('一句話摘要',{exact:true})).toHaveCount(0);
  }finally{release();}
});
test('a removed skill editor cannot lock its replacement with a late guild-required save rejection',async({page})=>{
  const otherBook={book_id:'another-book',title:'另一技能書'};
  let permissions={...caps,managed_books:[...caps.managed_books,otherBook]},release=()=>{},saving=false,failRefresh=false,permissionReads=0;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  await page.route('**/api/v1/guild-workspace',route=>{
    permissionReads++;
    return failRefresh?route.fulfill({status:503,json:{detail:'重新核對暫時不可用。'}}):route.fulfill({json:permissions});
  });
  await page.route('**/api/v1/guilds/synthetic-guild/announcements',route=>route.fulfill({json:{items:[]}}));
  await page.route('**/api/v1/skill-books/*/editor',async route=>{
    const book=new URL(route.request().url()).pathname.split('/').at(-2);
    if(route.request().method()==='GET')return route.fulfill({json:{book_id:book,summary:`目前摘要 ${book}`,collaboration_intro:'協作說明',milestones:[],tasks:[],aggregate_version:4,updated_at:null}});
    expect(book).toBe('video-autopilot');saving=true;await gate;
    return route.fulfill({status:403,contentType:'application/problem+json',json:{code:'skill_editor_guild_required',detail:'原技能書已失去編輯資格。'}});
  });
  try{
    await login(page);await navigate(page,'公會管理');
    const workspace=page.locator('.guild-workspace'),tabs=workspace.getByRole('navigation',{name:'公會管理功能'});
    await tabs.getByRole('button',{name:'技能書編輯',exact:true}).click();
    await workspace.getByLabel('一句話摘要',{exact:true}).fill('原技能書待確認草稿');
    await workspace.getByRole('button',{name:'保存技能書',exact:true}).click();await expect.poll(()=>saving).toBe(true);
    permissions={...caps,managed_books:[otherBook]};await page.evaluate(()=>window.dispatchEvent(new Event('freedom-profile-updated')));
    await expect(workspace.getByLabel('管理技能書',{exact:true})).toHaveValue(otherBook.book_id);
    await expect(workspace.getByLabel('一句話摘要',{exact:true})).toHaveValue(`目前摘要 ${otherBook.book_id}`);
    await workspace.getByLabel('一句話摘要',{exact:true}).fill('另一技能書仍可編輯的草稿');
    const reads=permissionReads;failRefresh=true;
    const rejected=page.waitForResponse(response=>response.request().method()==='POST'&&response.url().endsWith('/skill-books/video-autopilot/editor'));
    release();const response=await rejected;expect(response.status()).toBe(403);await response.finished();
    // Settle the completed response's rejection and React updates, rather than
    // asserting the replacement's pre-response enabled state.
    await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));
    await expect(workspace.getByLabel('一句話摘要',{exact:true})).toHaveValue('另一技能書仍可編輯的草稿');
    await expect(workspace.getByRole('button',{name:'保存技能書',exact:true})).toBeEnabled();
    await expect(workspace.getByRole('region',{name:'技能書編輯資格',exact:true})).toHaveCount(0);expect(permissionReads).toBe(reads);
  }finally{release();}
});
