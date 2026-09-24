import {mkdirSync} from 'node:fs';
import {test,expect,type Page,type Route} from './fixtures.js';

// Synthetic route fixtures only: each source mirrors the real API DTO shape; the
// skills group's real-API spec covers the same six tasks against PostgreSQL.
const SHOTS='/tmp/freedom-member-todos-shots';
type Guild={key:string;state:string|null};
type Facts={required:boolean;completed:boolean;state:'new'|'draft'|'evaluated'|'completed';primary:string|null;books:number;guilds:Guild[];avatar:string|null;links:number;github:{configured:boolean;connected:boolean}};
type Fail=Partial<Record<'onboarding'|'directory'|'account'|'social'|'github',boolean>>;
const base=():Facts=>({required:false,completed:false,state:'new',primary:null,books:0,guilds:[{key:'maker',state:'active'},{key:'writer',state:null}],avatar:null,links:0,github:{configured:true,connected:false}});

const book=(n:number)=>({book_id:`synthetic-book-${n}`,title:`合成技能書 ${n}`,description:'合成說明',repository_url:'https://github.com/synthetic/book',fork_url:null,guild_keys:['maker'],granted_at:'2026-09-20T00:00:00Z'});
const onboardingDto=(f:Facts)=>({required:f.required,completed:f.completed,state:f.state,draft:null,result:null,primary_guild_key:f.primary,skill_books:Array.from({length:f.books},(_,n)=>book(n))});
const guildDto=(g:Guild)=>({guild_key:g.key,name:g.key==='maker'?'合成創客公會':'合成寫作公會',purpose:'合成用途',first_step:'合成第一步',track_count:0,guild_master:null,guild_experts:[],guild_master_nominee:null,is_primary:false,is_secondary:false,secondary_position:null,skill_books:[],membership:g.state?{state:g.state,aggregate_version:1}:null});
const accountDto=(f:Facts)=>({user_id:'synthetic-user',avatar:{avatar_url:f.avatar,aggregate_version:1},nickname:'合成會員',identity_label:null,login_email:'maker@local.test',email_verified:true,contacts:{},aggregate_version:1});
const linkDto=(n:number)=>({link_id:`synthetic-link-${n}`,platform:'facebook',label:`合成連結 ${n}`,url:'https://example.invalid/synthetic',audiences:[],aggregate_version:1,created_at:'2026-09-20T00:00:00Z',updated_at:'2026-09-20T00:00:00Z',verified:false});

/** A held fixture answers the request itself and returns true. */
type Held=(route:Route,n:number)=>Promise<boolean>;
/** Routes answer from `facts` at request time; `live` hands a request to the isolated local server instead. */
async function sources(page:Page,facts:Facts,fail:Fail={},opts:{live?:()=>boolean;onboarding?:Held;directory?:Held}={}){
  const live=opts.live??(()=>false);let onboardingReads=0,directoryReads=0;
  const unavailable=(route:Route)=>route.fulfill({status:503,json:{title:'unavailable'}});
  await page.route('**/api/v1/me/onboarding',async route=>{if(live())return route.fallback();const n=++onboardingReads;if(await opts.onboarding?.(route,n))return;
    return fail.onboarding&&n>1?unavailable(route):route.fulfill({json:onboardingDto(facts)});});
  await page.route('**/api/v1/guilds/directory',async route=>{if(live())return route.fallback();const n=++directoryReads;if(await opts.directory?.(route,n))return;
    return fail.directory?unavailable(route):route.fulfill({json:{items:facts.guilds.map(guildDto)}});});
  await page.route('**/api/v1/me/account',route=>live()?route.fallback():fail.account?unavailable(route):route.fulfill({json:accountDto(facts)}));
  await page.route(/\/api\/v1\/me\/social-links\?limit=1&offset=0$/,route=>live()?route.fallback():fail.social?unavailable(route):
    route.fulfill({json:{items:facts.links?[linkDto(1)]:[],total:facts.links,next_offset:facts.links>1?1:null}}));
  await page.route('**/api/v1/me/github',route=>live()?route.fallback():fail.github?unavailable(route):
    route.fulfill({json:{...facts.github,github_user:facts.github.connected?{id:'synthetic-id',login:'synthetic-owner'}:null}}));
}

test.beforeEach(async({page})=>{
  await page.route(url=>!['127.0.0.1','localhost'].includes(url.hostname),route=>route.abort());
  await page.route('**/api/v1/me/skill-books',route=>route.fulfill({json:{items:[]}}));
  await page.route(/\/api\/v1\/me\/channels\?/,route=>route.fulfill({json:{items:[],unread_count:0,next_offset:null}}));
  await page.route(/\/api\/v1\/me\/notifications\?/,route=>route.fulfill({json:{items:[],unread_count:0,next_offset:null}}));
  await page.route(/\/api\/v1\/me\/conversations\?/,route=>route.fulfill({json:{items:[],unread_count:0,next_offset:null}}));
});

async function login(page:Page,hash='#todos'){
  await page.goto('/'+hash);
  await page.getByLabel('電子郵件',{exact:true}).fill('maker@local.test');await page.getByLabel('密碼',{exact:true}).fill('freedom-local-demo');
  await page.getByRole('button',{name:'登入',exact:true}).click();await expect(page.getByRole('button',{name:'登出',exact:true})).toBeVisible();
}
const task=(page:Page,key:string)=>page.locator(`[data-task="${key}"]`);
async function expectStates(page:Page,states:Record<string,string>){
  for(const [key,state] of Object.entries(states))await expect(task(page,key)).toHaveAttribute('data-task-state',state);
}
const profileUpdated=(page:Page)=>page.evaluate(()=>window.dispatchEvent(new Event('freedom-profile-updated')));
const refocus=(page:Page)=>page.evaluate(()=>window.dispatchEvent(new Event('focus')));
const painted=(page:Page)=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
function gate(){let open:()=>void=()=>{};const held=new Promise<void>(resolve=>{open=resolve;});return {held,open};}

test('a legacy exemption is not completion, and an unfinished required member still meets the closed gate',async({page})=>{
  const facts={...base(),primary:'maker'};
  await sources(page,facts);
  await login(page);
  await expectStates(page,{onboarding:'todo','primary-guild':'done',github:'todo',avatar:'todo','social-link':'todo','skill-book':'todo'});
  await expect(task(page,'onboarding').getByRole('status')).toHaveText('待完成');
  await expect(task(page,'primary-guild')).toContainText('合成創客公會');
  // Visiting the page never starts OAuth or any write by itself.
  await expect(task(page,'github').getByRole('button',{name:'連結 GitHub',exact:true})).toBeVisible();
  facts.required=true;
  await page.reload();
  await expect(page.getByRole('button',{name:'登出',exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'設定',exact:true})).toHaveCount(0);await expect(page.locator('[data-task]')).toHaveCount(0);
});

test('recorded completion survives re-exploring, while an inactive or missing primary guild stays open',async({page})=>{
  const facts:Facts={...base(),completed:true,state:'draft',primary:'maker',books:1,guilds:[{key:'maker',state:'left'}],avatar:'/media/avatars/synthetic.webp',links:2};
  await sources(page,facts);
  await login(page);
  // Leaving the guild does not remove an earlier skill-book grant.
  await expectStates(page,{onboarding:'done','primary-guild':'todo','skill-book':'done',avatar:'done','social-link':'done'});
  await expect(task(page,'primary-guild')).toContainText('不在已加入狀態');
  await expect(task(page,'skill-book')).toContainText('已領取 1 本技能書');
  await expect(task(page,'social-link')).toContainText('已新增 2 個社群連結');
  facts.guilds=[{key:'maker',state:'active'}];facts.primary=null;
  await profileUpdated(page);
  await expectStates(page,{'primary-guild':'todo',onboarding:'done'});
  await expect(task(page,'primary-guild')).toContainText('加入公會後');
  facts.primary='writer';await refocus(page);
  await expect(task(page,'primary-guild')).toContainText('不在已加入狀態');
  facts.primary='maker';await refocus(page);
  await expectStates(page,{'primary-guild':'done'});
});

test('one failing source only marks the tasks that depend on it, and each retries on its own',async({page})=>{
  await page.setViewportSize({width:320,height:780});
  const facts:Facts={...base(),completed:true,primary:'maker',books:1};
  const fail:Fail={directory:true,social:true,github:true};
  await sources(page,facts,fail);
  await login(page);
  await expectStates(page,{onboarding:'done','primary-guild':'error','skill-book':'done',avatar:'todo','social-link':'error',github:'error'});
  for(const key of ['primary-guild','social-link','github']){
    await expect(task(page,key).getByRole('status')).toHaveText('狀態讀取失敗');
    await expect(task(page,key).getByRole('alert')).not.toBeEmpty();
  }
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.evaluate(()=>scrollTo(0,0));mkdirSync(SHOTS,{recursive:true});
  await page.screenshot({path:`${SHOTS}/partial-error-320.png`,fullPage:true});
  fail.directory=false;
  await task(page,'primary-guild').getByRole('button',{name:'重新讀取主要公會狀態',exact:true}).click();
  await expectStates(page,{'primary-guild':'done','social-link':'error',github:'error',onboarding:'done'});
  fail.social=false;
  await task(page,'social-link').getByRole('button',{name:'重新讀取社群連結狀態',exact:true}).click();
  await expectStates(page,{'social-link':'todo',github:'error'});
  // The retry button is gone once the card answers; focus stays in that card instead of falling to the page.
  expect(await page.evaluate(()=>Boolean(document.activeElement?.closest('[data-task="social-link"]')))).toBe(true);
  fail.github=false;
  await task(page,'github').getByRole('button',{name:'重新讀取 GitHub 連結',exact:true}).click();
  await expectStates(page,{github:'todo','primary-guild':'done','social-link':'todo'});
});

test('a slower earlier read never overwrites a newer one, even across a remount',async({page})=>{
  const facts:Facts={...base(),primary:'maker',guilds:[{key:'maker',state:'left'}]};
  const slowOnboarding=gate(),slowDirectory=gate(),delivered={onboarding:gate(),directory:gate()};
  // Read 1 is the App gate; read 2 is the page's first read, held with the older facts.
  await sources(page,facts,{},{
    onboarding:async(route,n)=>{if(n===2){const stale=onboardingDto(facts);await slowOnboarding.held;await route.fulfill({json:stale});delivered.onboarding.open();return true;}return false;},
    directory:async(route,n)=>{if(n===1){const stale={items:facts.guilds.map(guildDto)};await slowDirectory.held;await route.fulfill({json:stale});delivered.directory.open();return true;}return false;},
  });
  await login(page);
  await expectStates(page,{onboarding:'loading','primary-guild':'loading',avatar:'todo'});
  facts.completed=true;facts.guilds=[{key:'maker',state:'active'}];
  await profileUpdated(page);
  await expectStates(page,{onboarding:'done','primary-guild':'done'});
  slowOnboarding.open();slowDirectory.open();await delivered.onboarding.held;await delivered.directory.held;await painted(page);
  await expectStates(page,{onboarding:'done','primary-guild':'done'});

  // A read held by an unmounted page cannot render into the next mount.
  const late=gate(),lateDelivered=gate();let hold=true;
  await page.unroute('**/api/v1/me/onboarding');
  await page.route('**/api/v1/me/onboarding',async route=>{const json=onboardingDto(facts);
    if(hold){hold=false;await late.held;await route.fulfill({json});lateDelivered.open();return;}
    return route.fulfill({json});});
  await refocus(page);
  await page.getByRole('button',{name:'設定',exact:true}).click();await page.getByRole('menuitem',{name:'我的訊息',exact:true}).click();
  await expect(page).toHaveURL(/#messages$/);
  facts.completed=false;
  await page.getByRole('button',{name:'設定',exact:true}).click();await page.getByRole('menuitem',{name:'待辦清單',exact:true}).click();
  await expectStates(page,{onboarding:'todo'});
  late.open();await lateDelivered.held;await painted(page);
  await expectStates(page,{onboarding:'todo'});
});

test('six tasks in two groups put open work first, fit phone and desktop, and each action opens its page',async({page})=>{
  const facts:Facts={...base(),completed:true,state:'completed',avatar:'/media/avatars/synthetic.webp'};
  let live=false;
  await sources(page,facts,{},{live:()=>live});
  mkdirSync(SHOTS,{recursive:true});
  await page.setViewportSize({width:320,height:780});
  await login(page);
  await expectStates(page,{onboarding:'done','primary-guild':'todo',github:'todo',avatar:'done','social-link':'todo','skill-book':'todo'});
  const groups=page.locator('.member-tasks-group');
  await expect(groups.nth(0).getByRole('heading',{level:2})).toHaveText('必做待辦');await expect(groups.nth(1).getByRole('heading',{level:2})).toHaveText('建議待辦');
  expect(await groups.nth(0).locator('[data-task]').evaluateAll(nodes=>nodes.map(node=>(node as HTMLElement).dataset.task))).toEqual(['primary-guild','github','onboarding']);
  expect(await groups.nth(1).locator('[data-task]').evaluateAll(nodes=>nodes.map(node=>(node as HTMLElement).dataset.task))).toEqual(['social-link','skill-book','avatar']);
  await expect(page.getByRole('heading',{level:1})).toHaveCount(1);await expect(page.locator('.member-task h3')).toHaveCount(6);
  for(const [width,height,name] of [[320,780,'todos-320'],[1280,900,'todos-desktop']] as const){
    await page.setViewportSize({width,height});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    for(const button of await page.locator('.member-task button').all())expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    for(const text of await page.locator('.member-task p, .task-state').all())expect(await text.evaluate(node=>parseFloat(getComputedStyle(node).fontSize))).toBeGreaterThanOrEqual(14);
    await page.evaluate(()=>scrollTo(0,0));await page.screenshot({path:`${SHOTS}/${name}.png`,fullPage:true});
  }
  const actions:[string,string,string,string][]=[
    ['onboarding','查看我的定位','positioning','我的定位'],['primary-guild','前往職業公會','guilds','職業公會'],['avatar','到我的名片管理頭像','account','我的名片'],
    ['social-link','前往我的名片新增連結','account','我的名片'],['skill-book','前往技能書架','skills','技能書架'],['github','連結 GitHub','',''],
  ];
  for(const [key,label,tab,title] of actions){
    const button=task(page,key).getByRole('button',{name:label,exact:true});
    await expect(button).toBeVisible();
    if(!tab)continue; // OAuth only starts from this button; the settings spec covers that round trip.
    live=true;await button.click();
    await expect(page).toHaveURL(new RegExp(`#${tab}$`));await expect(page.getByRole('heading',{level:1})).toHaveText(title);
    expect(await page.evaluate(()=>document.activeElement?.id)).toBe('main-content');
    live=false;
    await page.getByRole('button',{name:'設定',exact:true}).click();await page.getByRole('menuitem',{name:'待辦清單',exact:true}).click();
    await expect(task(page,'skill-book')).toHaveAttribute('data-task-state','todo');
  }
});
