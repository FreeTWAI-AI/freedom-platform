import {randomUUID} from 'node:crypto';
import {mkdirSync} from 'node:fs';
import {Pool} from 'pg';
import sharp from 'sharp';
import {test,expect,type Browser,type Page} from './fixtures.js';
import {navigate} from './navigation.js';
import {LOCAL_DATABASE_URL} from '../../packages/db/index.js';
import {e2eSchema} from '../../packages/testing/e2e-auth-isolation.js';
import {DEMO_COMMUNITY,DEMO_PASSWORD} from '../../packages/testing/seed.js';
import {hashPassword} from '../../modules/identity-membership/service.js';

// Real API and PostgreSQL end to end: no task source is stubbed and nothing may
// leave the local server. Each case uses members that exist only for this run;
// the built-in event-space guild is joined, never created or changed.
const SHOTS='/tmp/freedom-member-todos-real-shots';
const GUILD='guild_event_space',GUILD_NAME='活動與空間公會';
const TASKS=['onboarding','primary-guild','github','avatar','social-link','skill-book'] as const;
/** Every member this case created, by id or by the email recorded before registering; filled before the write. */
type Owned={users:string[];emails:string[]};

function database(){
  return new Pool({connectionString:process.env.TEST_DATABASE_URL??LOCAL_DATABASE_URL,options:`-c search_path=${e2eSchema(process.env.FREEDOM_E2E_SCHEMA)}`,max:2});
}
const count=async(db:Pool,sql:string,values:unknown[]=[])=>(await db.query(`SELECT count(*)::int AS n FROM ${sql}`,values)).rows[0].n as number;

/** Removes exactly this case's members and their own rows in one transaction; children first, no FK cascades relied on. */
async function removeOwned(db:Pool,own:Owned){
  const client=await db.connect();let users:string[]=[];
  try{
    await client.query('BEGIN');
    const q=(sql:string,values:unknown[])=>client.query(sql,values);
    users=[...new Set([...own.users,...(await q('SELECT user_id FROM users WHERE email=ANY($1::text[])',[own.emails])).rows.map(row=>row.user_id as string)])];
    await q('DELETE FROM outbox WHERE transition_id IN (SELECT transition_id FROM transition_journal WHERE actor_ref=ANY($1::uuid[]))',[users]);
    await q('DELETE FROM transition_journal WHERE actor_ref=ANY($1::uuid[])',[users]);
    for(const table of ['member_social_links','member_avatars','onboarding_assessments','member_skill_book_grants','guild_member_preferences',
      'positioning_profession_memberships','member_accounts','command_receipts','sessions'])await q(`DELETE FROM ${table} WHERE user_id=ANY($1::uuid[])`,[users]);
    await q('DELETE FROM users WHERE user_id=ANY($1::uuid[])',[users]);
    await client.query('COMMIT');
  }catch(error){await client.query('ROLLBACK').catch(()=>undefined);throw error;}
  finally{client.release();}
  // Nothing of ours is left anywhere a users foreign key points from, nor in the journal.
  expect(await count(db,'users WHERE user_id=ANY($1::uuid[]) OR email=ANY($2::text[])',[users,own.emails])).toBe(0);
  const references=(await db.query(`SELECT c.conrelid::regclass::text AS tab,a.attname AS col FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=ANY(c.conkey) WHERE c.contype='f' AND c.confrelid='users'::regclass`)).rows as {tab:string;col:string}[];
  expect(references.length).toBeGreaterThan(5);
  for(const {tab,col} of references)expect(await count(db,`${tab} WHERE "${col}"=ANY($1::uuid[])`,[users]),`${tab}.${col}`).toBe(0);
  expect(await count(db,'transition_journal WHERE actor_ref=ANY($1::uuid[]) OR aggregate_id=ANY($1::uuid[])',[users])).toBe(0);
}
/** Runs a case, then always closes its browser, removes its rows and ends the pool; no failure hides another. */
async function owning(browser:Browser,baseURL:string,body:(db:Pool,own:Owned,open:(viewport:{width:number;height:number})=>Promise<Page>)=>Promise<void>){
  const db=database(),own:Owned={users:[],emails:[]},contexts:Awaited<ReturnType<Browser['newContext']>>[]=[],errors:unknown[]=[];
  const open=async(viewport:{width:number;height:number})=>{
    const context=await browser.newContext({baseURL,viewport});contexts.push(context);
    await context.route(url=>!['127.0.0.1','localhost'].includes(url.hostname),route=>route.abort());
    return context.newPage();
  };
  try{await body(db,own,open);}catch(error){errors.push(error);}
  for(const context of contexts)await context.close().catch(error=>errors.push(error));
  await removeOwned(db,own).catch(error=>errors.push(error));
  await db.end().catch(error=>errors.push(error));
  if(errors.length===1)throw errors[0];
  if(errors.length)throw new AggregateError(errors,errors.map(String).join('\n'));
}

const task=(page:Page,key:string)=>page.locator(`article[data-task="${key}"]`);
const cta=(page:Page,key:string,name:string)=>task(page,key).getByRole('button',{name,exact:true});
async function expectStates(page:Page,states:Partial<Record<typeof TASKS[number],string>>){
  for(const [key,state] of Object.entries(states))await expect(task(page,key),key).toHaveAttribute('data-task-state',state);
}
async function openTodos(page:Page){
  await navigate(page,'待辦清單');await expect(page).toHaveURL(/#todos$/);
  for(const key of TASKS)await expect(task(page,key)).toBeVisible();
  // Nothing on this page can be ticked by hand.
  await expect(page.locator('article[data-task] input')).toHaveCount(0);await expect(page.locator('article[data-task]').getByRole('checkbox')).toHaveCount(0);
}
async function follow(page:Page,key:string,name:string,hash:string,title:string){
  await cta(page,key,name).click();await expect(page).toHaveURL(new RegExp(`#${hash}$`));await expect(page.getByRole('heading',{level:1})).toHaveText(title);
}
async function noOverflow(page:Page){expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);}
async function shot(page:Page,name:string){await page.evaluate(()=>scrollTo(0,0));await page.screenshot({path:`${SHOTS}/${name}.png`,fullPage:true});}
async function getJson(page:Page,path:string){const response=await page.request.get(`/api/v1${path}`);expect(response.status(),`${path} ${await response.text()}`).toBe(200);return response.json();}
/** The GitHub card mirrors whatever the local server really reports; OAuth is never started here. */
async function expectGithub(page:Page){
  const github=await getJson(page,'/me/github') as {configured:boolean;connected:boolean};
  await expectStates(page,{github:github.connected?'done':github.configured?'todo':'unavailable'});
}
async function answerPreferences(page:Page){
  await expect(page.getByRole('heading',{name:'你喜歡怎麼做事？',exact:true})).toBeVisible();
  for(const field of await page.locator('.quiz-question').all())await field.getByRole('radio').first().check();
  await page.getByRole('button',{name:'保存，繼續下一步 →',exact:true}).click();
  await expect(page.getByRole('heading',{name:'遇到這些情境，你會怎麼做？',exact:true})).toBeVisible();
}

test('a legacy member completes profile and positioning todos through the real UI and API, while re-exploration preserves completion',async({browser,baseURL})=>{
  test.setTimeout(180000);mkdirSync(SHOTS,{recursive:true});
  const run=randomUUID().slice(0,8);
  await owning(browser,baseURL!,async(db,own,open)=>{
    // A legacy member: exempt from the gate, never completed, no guild, book, avatar or link.
    const user_id=randomUUID(),email=`todos-legacy-${user_id}@example.invalid`;own.users.push(user_id);own.emails.push(email);
    await db.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref,onboarding_required)
      VALUES($1,$2,$3,$4,$5,$6,false)`,[user_id,DEMO_COMMUNITY,email,`待辦舊會員 ${run}`,hashPassword(DEMO_PASSWORD),randomUUID()]);
    expect((await db.query('SELECT onboarding_required,onboarding_completed_at FROM users WHERE user_id=$1',[user_id])).rows).toEqual([{onboarding_required:false,onboarding_completed_at:null}]);
    for(const table of ['positioning_profession_memberships','member_skill_book_grants','guild_member_preferences','member_avatars','member_social_links','onboarding_assessments'])
      expect(await count(db,`${table} WHERE user_id=$1`,[user_id]),table).toBe(0);

    const page=await open({width:1280,height:900});
    const githubWrites:string[]=[];page.on('request',request=>{const path=new URL(request.url()).pathname;if(path.startsWith('/api/v1/me/github')&&(request.method()!=='GET'||path!=='/api/v1/me/github'))githubWrites.push(`${request.method()} ${path}`);});
    await page.goto('/');
    await page.getByLabel('電子郵件',{exact:true}).fill(email);await page.getByLabel('密碼',{exact:true}).fill(DEMO_PASSWORD);
    await page.getByRole('button',{name:'登入',exact:true}).click();await expect(page.getByRole('button',{name:'登出',exact:true})).toBeVisible();
    expect((await getJson(page,'/session')).user.user_id).toBe(user_id);

    // Start: every non-GitHub task is to do; a legacy exemption is not completion.
    const initial=await getJson(page,'/me/onboarding');
    expect(initial.required).toBe(false);expect(initial.completed).toBe(false);expect(initial.primary_guild_key).toBeNull();expect(initial.skill_books).toEqual([]);
    await openTodos(page);
    await expectStates(page,{onboarding:'todo','primary-guild':'todo',avatar:'todo','social-link':'todo','skill-book':'todo'});await expectGithub(page);
    for(const [key,name] of [['onboarding','前往我的定位'],['primary-guild','前往職業公會'],['avatar','前往我的名片上傳頭像'],['social-link','前往我的名片新增連結'],['skill-book','前往技能書架']])
      await expect(cta(page,key,name)).toBeVisible();
    await noOverflow(page);await shot(page,'todos-desktop-start');

    // Joining a guild grants its books but is not choosing a primary guild.
    await follow(page,'primary-guild','前往職業公會','guilds','職業公會');
    const card=page.locator(`article.guild-card[data-guild-key="${GUILD}"]`);
    await card.getByRole('button',{name:`加入${GUILD_NAME}`,exact:true}).click();
    await expect(page.getByRole('status').filter({hasText:`已加入${GUILD_NAME}，技能書已解鎖。`})).toBeVisible();
    await expect(card.getByRole('button',{name:'設為主要公會',exact:true})).toBeVisible();
    const joined=await getJson(page,'/me/onboarding');
    expect(joined.primary_guild_key).toBeNull();expect(joined.skill_books.length).toBeGreaterThan(0);
    expect(joined.skill_books.every((book:{guild_keys:string[]})=>book.guild_keys.includes(GUILD))).toBe(true);
    await openTodos(page);
    await expectStates(page,{'skill-book':'done','primary-guild':'todo',onboarding:'todo'});
    await expect(task(page,'skill-book')).toContainText(`已領取 ${joined.skill_books.length} 本技能書。`);
    await expect(cta(page,'skill-book','查看技能書架')).toBeVisible();await expect(cta(page,'primary-guild','前往職業公會')).toBeVisible();

    // The member's own 設為主要公會 is what completes the primary guild task.
    await follow(page,'primary-guild','前往職業公會','guilds','職業公會');
    await card.getByRole('button',{name:'設為主要公會',exact:true}).click();
    await expect(page.getByRole('status').filter({hasText:`主要公會已設為${GUILD_NAME}。`})).toBeVisible();
    await openTodos(page);
    await expectStates(page,{'primary-guild':'done','skill-book':'done',onboarding:'todo'});
    await expect(task(page,'primary-guild')).toContainText(`主要公會：${GUILD_NAME}。`);await expect(cta(page,'primary-guild','查看職業公會')).toBeVisible();
    const primaryView=await getJson(page,'/me/onboarding');expect(primaryView.primary_guild_key).toBe(GUILD);expect(primaryView.completed).toBe(false);
    const directory=(await getJson(page,'/guilds/directory')).items as {guild_key:string;membership:{state:string}|null}[];
    expect(directory.filter(guild=>guild.membership?.state==='active').map(guild=>guild.guild_key)).toEqual([GUILD]);
    expect((await db.query('SELECT primary_guild_key FROM guild_member_preferences WHERE user_id=$1',[user_id])).rows).toEqual([{primary_guild_key:GUILD}]);
    expect((await db.query('SELECT guild_key,state FROM positioning_profession_memberships WHERE user_id=$1',[user_id])).rows).toEqual([{guild_key:GUILD,state:'active'}]);
    const grants=(await db.query('SELECT book_id,guild_key FROM member_skill_book_grants WHERE user_id=$1 ORDER BY book_id',[user_id])).rows;
    expect(grants.length).toBe(joined.skill_books.length);expect(grants.every(row=>row.guild_key===GUILD)).toBe(true);

    // One private social link completes the task; it never needs to be public.
    await follow(page,'social-link','前往我的名片新增連結','account','我的名片');
    const links=page.locator('.social-links-editor');
    await links.getByRole('button',{name:'＋ 新增連結',exact:true}).click();
    const form=links.getByRole('form',{name:'新增社群連結',exact:true});await expect(form.getByLabel('不公開',{exact:true})).toBeChecked();
    await form.getByLabel('連結名稱',{exact:true}).fill(`待辦合成連結 ${run}`);await form.getByLabel('連結網址',{exact:true}).fill(`https://www.facebook.com/synthetictodos${run}`);
    await form.getByRole('button',{name:'保存連結',exact:true}).click();
    await expect(links.getByRole('status')).toHaveText('社群連結已新增。');
    const social=await getJson(page,'/me/social-links?limit=1&offset=0');
    expect(social.items).toHaveLength(1);expect(social.items[0].audiences).toEqual([]);expect(social.total).toBe(1);
    expect(await count(db,'member_social_links WHERE user_id=$1 AND deleted_at IS NULL AND audiences=$2::text[]',[user_id,[]])).toBe(1);
    await openTodos(page);
    await expectStates(page,{'social-link':'done',avatar:'todo',onboarding:'todo'});await expect(cta(page,'social-link','到我的名片管理社群連結')).toBeVisible();

    // A real avatar upload through the account editor.
    await follow(page,'avatar','前往我的名片上傳頭像','account','我的名片');
    const editor=page.locator('.avatar-editor'),photo=await sharp({create:{width:64,height:64,channels:3,background:'#c4ff20'}}).png().toBuffer();
    await editor.getByLabel('選擇頭像',{exact:true}).setInputFiles({name:'synthetic-todos-avatar.png',mimeType:'image/png',buffer:photo});
    await expect(editor.getByRole('img',{name:'頭像預覽',exact:true})).toBeVisible();
    await editor.getByRole('button',{name:'保存頭像',exact:true}).click();
    await expect(editor.getByRole('status')).toHaveText('頭像已保存，工坊夥伴現在可以看見。');
    expect((await getJson(page,'/me/account')).avatar.avatar_url).toMatch(new RegExp(`^/api/v1/members/${user_id}/avatar\\?v=`));
    expect(await count(db,'member_avatars WHERE user_id=$1 AND image_bytes IS NOT NULL',[user_id])).toBe(1);
    await openTodos(page);
    await expectStates(page,{avatar:'done','social-link':'done','primary-guild':'done','skill-book':'done',onboarding:'todo'});
    await expect(cta(page,'avatar','到我的名片管理頭像')).toBeVisible();await expect(cta(page,'onboarding','前往我的定位')).toBeVisible();
    expect((await getJson(page,'/me/onboarding')).completed).toBe(false);

    // The real positioning flow, once: answers, evaluation, the joined primary guild, completion.
    await follow(page,'onboarding','前往我的定位','positioning','我的定位');
    await page.getByRole('button',{name:'開始探索我的定位',exact:true}).click();
    await answerPreferences(page);
    for(const field of await page.locator('.quiz-question').all())await field.getByRole('radio').first().check();
    await page.getByRole('button',{name:'保存，繼續下一步 →',exact:true}).click();
    await expect(page.getByRole('heading',{name:'你從哪裡來，帶著哪些能力？',exact:true})).toBeVisible();
    await page.getByRole('button',{name:'保存，繼續下一步 →',exact:true}).click();
    await expect(page.getByRole('heading',{name:'你的裝備庫',exact:true})).toBeVisible();
    await page.getByRole('button',{name:'看看適合我的公會',exact:true}).click();
    await expect(page.locator('.recommendation-card').first()).toBeVisible();
    expect((await getJson(page,'/me/onboarding')).state).toBe('evaluated');
    // The already joined primary guild is preselected from the member's real records.
    const confirmation=page.locator('.onboarding-confirmation');
    await expect(confirmation.getByRole('combobox',{name:'主要公會（必選）',exact:true})).toHaveValue(GUILD);
    const completion=page.waitForRequest(request=>request.method()==='POST'&&request.url().endsWith('/api/v1/me/onboarding/complete'));
    await confirmation.getByRole('button',{name:'確認加入公會，領取技能書',exact:true}).click();
    expect((await completion).postDataJSON()).toMatchObject({guild_keys:[GUILD],primary_guild_key:GUILD,confirmed:true});
    await expect(page.getByRole('heading',{name:'你的第一段旅程，現在開始。',exact:true})).toBeVisible();
    await page.getByRole('button',{name:'進入自由工坊 →',exact:true}).click();
    await expect(page.getByRole('heading',{name:'我的定位結果',exact:true})).toBeVisible();
    const completed=await getJson(page,'/me/onboarding');
    expect(completed).toMatchObject({required:false,completed:true,state:'completed',primary_guild_key:GUILD});
    expect((await db.query('SELECT onboarding_completed_at IS NOT NULL AS done FROM users WHERE user_id=$1',[user_id])).rows).toEqual([{done:true}]);
    await openTodos(page);
    await expectStates(page,{onboarding:'done','primary-guild':'done',avatar:'done','social-link':'done','skill-book':'done'});await expectGithub(page);
    await expect(cta(page,'onboarding','查看我的定位')).toBeVisible();

    // The skill-book CTA only opens the member's own shelf; no external book link is followed.
    await follow(page,'skill-book','查看技能書架','skills','技能書架');
    await openTodos(page);

    // Saving the first step of a re-exploration leaves a draft; the confirmed positioning still counts.
    await follow(page,'onboarding','查看我的定位','positioning','我的定位');
    await page.getByRole('button',{name:'重新探索定位',exact:true}).click();
    await answerPreferences(page);
    const draft=await getJson(page,'/me/onboarding');
    expect(draft).toMatchObject({state:'draft',completed:true,required:false,primary_guild_key:GUILD});
    await page.getByRole('button',{name:'返回我的定位',exact:true}).click();
    await expect(page.getByText('調整中的草稿尚未取代這份已確認的定位。',{exact:true})).toBeVisible();
    await openTodos(page);
    await expectStates(page,{onboarding:'done','primary-guild':'done',avatar:'done','social-link':'done','skill-book':'done'});await expectGithub(page);
    for(const [key,name] of [['onboarding','查看我的定位'],['primary-guild','查看職業公會'],['avatar','到我的名片管理頭像'],['social-link','到我的名片管理社群連結'],['skill-book','查看技能書架']])
      await expect(cta(page,key,name)).toBeVisible();
    // Leaving the page and returning (a remount) re-reads the same real facts.
    await page.reload();await expect(page.locator('.shell')).toBeVisible();await expect(page).toHaveURL(/#todos$/);
    await expectStates(page,{onboarding:'done','primary-guild':'done',avatar:'done','social-link':'done','skill-book':'done'});
    await noOverflow(page);await shot(page,'todos-desktop');

    await page.setViewportSize({width:320,height:844});
    await expectStates(page,{onboarding:'done','primary-guild':'done',avatar:'done','social-link':'done','skill-book':'done'});
    for(const key of TASKS){await task(page,key).scrollIntoViewIfNeeded();await expect(task(page,key)).toBeVisible();}
    await noOverflow(page);
    const buttons=page.locator('article[data-task] .member-task-actions button');
    expect(await buttons.count()).toBeGreaterThanOrEqual(5);
    for(const button of await buttons.all()){const box=await button.boundingBox();expect(box,await button.innerText()).not.toBeNull();expect(box!.height,await button.innerText()).toBeGreaterThanOrEqual(44);expect(box!.x+box!.width).toBeLessThanOrEqual(320);}
    await shot(page,'todos-320');
    expect(githubWrites,'the GitHub task never starts OAuth by itself').toEqual([]);
  });
});

test('a newly registered member at 320px stays behind the mandatory positioning gate on a #todos deep link',async({browser,baseURL})=>{
  test.setTimeout(90000);mkdirSync(SHOTS,{recursive:true});
  await owning(browser,baseURL!,async(db,own,open)=>{
    const page=await open({width:320,height:844});
    // Recorded before the account exists, so cleanup finds it even if the registration response is lost.
    const email=`todos-new-${randomUUID()}@example.test`,nickname=`待辦新會員 ${randomUUID().slice(0,8)}`;own.emails.push(email);
    await page.goto('/#todos');
    await page.getByRole('button',{name:'建立帳號',exact:true}).click();
    await page.getByLabel('社群顯示名稱',{exact:true}).fill(nickname);
    await page.getByLabel('電子郵件',{exact:true}).fill(email);await page.getByLabel('密碼',{exact:true}).fill('freedom-workshop-member-2026');
    const registered=page.waitForResponse(response=>response.request().method()==='POST'&&response.url().endsWith('/api/v1/auth/register'));
    await page.getByRole('button',{name:'註冊並開始定位',exact:true}).click();
    expect((await registered).status()).toBeLessThan(300);
    const gate=page.getByRole('heading',{name:'你喜歡怎麼做事？',exact:true});await expect(gate).toBeVisible();
    const row=(await db.query('SELECT user_id,onboarding_required,onboarding_completed_at FROM users WHERE email=$1',[email])).rows;
    expect(row).toHaveLength(1);own.users.push(row[0].user_id);
    expect(row[0].onboarding_required).toBe(true);expect(row[0].onboarding_completed_at).toBeNull();

    for(const attempt of ['registered','deep-link']){
      if(attempt==='deep-link'){await page.goto('/#todos');await page.reload();await expect(gate).toBeVisible();}
      await expect(page.locator('article[data-task]'),attempt).toHaveCount(0);
      await expect(page.locator('.shell'),attempt).toHaveCount(0);
      await expect(page.getByRole('navigation',{name:'主要工作區'}),attempt).toHaveCount(0);
      await expect(page.getByRole('button',{name:'設定',exact:true}),attempt).toHaveCount(0);
    }
    expect((await getJson(page,'/session')).user.user_id).toBe(row[0].user_id);
    expect(await getJson(page,'/me/onboarding')).toMatchObject({required:true,completed:false});
    for(const path of ['/me/social-links?limit=1&offset=0','/retail/catalog']){
      const response=await page.request.get(`/api/v1${path}`);expect(response.status(),path).toBe(403);expect((await response.json()).code,path).toBe('onboarding_required');
    }
    await noOverflow(page);await shot(page,'gated-320');
  });
});
