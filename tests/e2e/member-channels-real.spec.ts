import {randomUUID} from 'node:crypto';
import {mkdirSync} from 'node:fs';
import {Pool} from 'pg';
import {test,expect,type Browser,type Page,type Locator} from './fixtures.js';
import {LOCAL_DATABASE_URL} from '../../packages/db/index.js';
import {e2eSchema} from '../../packages/testing/e2e-auth-isolation.js';
import {DEMO_COMMUNITY,DEMO_PASSWORD} from '../../packages/testing/seed.js';
import {hashPassword} from '../../modules/identity-membership/service.js';
import {reviewGuildApplication} from '../../modules/platform-admin/service.js';

// Real API and PostgreSQL end to end: no channel, inbox or membership route is
// stubbed and nothing may leave the local server. Other specs post to the seeded
// guilds in the same schema, so every case uses members that exist only for this
// run, an approved custom guild of its own and a squad of its own: each room
// starts empty and each member starts at zero unread.
const SHOTS='/tmp/freedom-member-channels-real-shots';
type Kind='guild'|'squad';
type Account={user_id:string;email:string;display_name:string};
/** Every row key this case created; filled before each insert so a partial setup is still removed. */
type Owned={users:string[];admins:string[];applications:string[];guilds:string[];squads:string[]};
const copy={guild:{tab:'公會閒聊',back:'回到職業公會',hash:'#guilds'},squad:{tab:'小隊閒聊',back:'回到小隊集合',hash:'#squads'}} as const;

function database(){
  return new Pool({connectionString:process.env.TEST_DATABASE_URL??LOCAL_DATABASE_URL,options:`-c search_path=${e2eSchema(process.env.FREEDOM_E2E_SCHEMA)}`,max:4});
}
/** Finished members (onboarding_required=false) with the documented local demo password and no guild or squad yet. */
async function accounts(db:Pool,own:Owned,run:string,roles:[slug:string,label:string][]):Promise<Account[]>{
  const result:Account[]=[];
  for(const [slug,label] of roles){
    // ASCII local part: the login field is type=email.
    const user_id=randomUUID(),account={user_id,email:`channel-${slug}-${user_id}@example.invalid`,display_name:`頻道${label} ${run}`};own.users.push(user_id);
    await db.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref,onboarding_required)
      VALUES($1,$2,$3,$4,$5,$6,false)`,[user_id,DEMO_COMMUNITY,account.email,account.display_name,hashPassword(DEMO_PASSWORD),randomUUID()]);
    result.push(account);
  }
  return result;
}
/** A custom guild of this run: a real application of this community approved through the admin service (catalog + approval). */
async function approvedGuild(db:Pool,own:Owned,founder:Account,name:string){
  const admin={admin_id:randomUUID(),community_id:DEMO_COMMUNITY,email:`channel-admin-${randomUUID()}@example.invalid`,display_name:'頻道測試管理者',role:'super_admin' as const,subject:'verified-test'};own.admins.push(admin.admin_id);
  await db.query('INSERT INTO platform_admins(admin_id,community_id,email,display_name) VALUES($1,$2,$3,$4)',[admin.admin_id,DEMO_COMMUNITY,admin.email,admin.display_name]);
  const application=randomUUID();own.applications.push(application);
  await db.query('INSERT INTO guild_creation_applications(application_id,community_id,user_id,name,profession,reason) VALUES($1,$2,$3,$4,$5,$6)',[application,DEMO_COMMUNITY,founder.user_id,name,'研究','合成的頻道測試公會。']);
  const approved=await reviewGuildApplication(db,{admin,body:{decision:'approve',reason:'合成核准',guild:{name,purpose:'合成的公會用途說明',first_step:'先讀共同研究筆記',module_key:'guilds',skill_book_ids:['event-space']}},key:randomUUID(),operation:'e2e-approve',expected:'1'},application);
  own.guilds.push(approved.approved_guild_key as string);return approved.approved_guild_key as string;
}
/**
 * Removes exactly the rows of this case in one transaction. No schema FK cascades here, so children go first;
 * any row left behind makes a later delete fail on its FK instead of being skipped. Squads of an owned owner and
 * the guild of an owned application are re-derived, so a lost response still gets cleaned.
 */
async function removeOwned(db:Pool,own:Owned){
  const client=await db.connect();
  try{
    await client.query('BEGIN');
    const q=(sql:string,values:unknown[])=>client.query(sql,values);
    const users=own.users,admins=own.admins;
    const applications=[...new Set([...own.applications,...(await q('SELECT application_id FROM guild_creation_applications WHERE user_id=ANY($1::uuid[])',[users])).rows.map(row=>row.application_id as string)])];
    const guilds=[...new Set([...own.guilds,...(await q('SELECT approved_guild_key FROM guild_creation_applications WHERE application_id=ANY($1::uuid[]) AND approved_guild_key IS NOT NULL',[applications])).rows.map(row=>row.approved_guild_key as string)])];
    // Only approved custom guilds: a built-in catalog entry is never ours to delete.
    for(const key of guilds)expect(key).toMatch(/^guild_custom_[0-9a-f]{32}$/);
    const squads=[...new Set([...own.squads,...(await q('SELECT squad_id FROM member_squads WHERE owner_ref=ANY($1::uuid[])',[users])).rows.map(row=>row.squad_id as string)])];
    const channel=`(kind='guild' AND channel_key=ANY($1::text[])) OR (kind='squad' AND channel_key=ANY($2::text[]))`;
    await q(`DELETE FROM member_channel_reads WHERE ${channel} OR user_id=ANY($3::uuid[])`,[guilds,squads,users]);
    await q(`DELETE FROM member_channel_messages WHERE ${channel} OR sender_ref=ANY($3::uuid[])`,[guilds,squads,users]);
    await q(`DELETE FROM member_chat_channels WHERE ${channel}`,[guilds,squads]);
    await q('DELETE FROM member_direct_messages WHERE sender_ref=ANY($1::uuid[]) OR recipient_ref=ANY($1::uuid[])',[users]);
    await q('DELETE FROM member_friendships WHERE low_ref=ANY($1::uuid[]) OR high_ref=ANY($1::uuid[]) OR requester_ref=ANY($1::uuid[])',[users]);
    await q('DELETE FROM member_notifications WHERE recipient_ref=ANY($1::uuid[])',[users]);
    await q('DELETE FROM member_squad_invitations WHERE squad_id=ANY($1::uuid[]) OR owner_ref=ANY($2::uuid[]) OR recipient_ref=ANY($2::uuid[])',[squads,users]);
    await q('DELETE FROM member_squad_memberships WHERE squad_id=ANY($1::uuid[]) OR user_id=ANY($2::uuid[])',[squads,users]);
    await q('DELETE FROM member_squads WHERE squad_id=ANY($1::uuid[])',[squads]);
    await q('DELETE FROM positioning_profession_memberships WHERE guild_key=ANY($1::text[]) OR user_id=ANY($2::uuid[])',[guilds,users]);
    for(const table of ['guild_member_preferences','member_skill_book_grants'])await q(`DELETE FROM ${table} WHERE user_id=ANY($1::uuid[])`,[users]);
    for(const table of ['guild_skill_book_bindings','positioning_guild_officers','positioning_guild_experts'])await q(`DELETE FROM ${table} WHERE guild_key=ANY($1::text[])`,[guilds]);
    await q('DELETE FROM guild_creation_applications WHERE application_id=ANY($1::uuid[])',[applications]);
    await q('DELETE FROM positioning_guild_catalog WHERE guild_key=ANY($1::text[])',[guilds]);
    for(const table of ['platform_admin_audit','platform_admin_receipts'])await q(`DELETE FROM ${table} WHERE admin_id=ANY($1::uuid[])`,[admins]);
    await q('DELETE FROM platform_admins WHERE admin_id=ANY($1::uuid[])',[admins]);
    await q('DELETE FROM outbox WHERE transition_id IN (SELECT transition_id FROM transition_journal WHERE actor_ref=ANY($1::uuid[]))',[users]);
    await q('DELETE FROM transition_journal WHERE actor_ref=ANY($1::uuid[])',[users]);
    for(const table of ['command_receipts','sessions'])await q(`DELETE FROM ${table} WHERE user_id=ANY($1::uuid[])`,[users]);
    await q('DELETE FROM users WHERE user_id=ANY($1::uuid[])',[users]);
    await client.query('COMMIT');
    for(const [sql,values] of [['positioning_guild_catalog WHERE guild_key=ANY($1::text[])',[guilds]],['guild_creation_applications WHERE application_id=ANY($1::uuid[])',[applications]],
      ['platform_admins WHERE admin_id=ANY($1::uuid[])',[admins]],['users WHERE user_id=ANY($1::uuid[])',[users]],['member_squads WHERE squad_id=ANY($1::uuid[])',[squads]],
      [`member_chat_channels WHERE ${channel}`,[guilds,squads]]] as [string,unknown[]][])expect(await count(db,sql,values),sql).toBe(0);
  }catch(error){await client.query('ROLLBACK').catch(()=>undefined);throw error;}
  finally{client.release();}
}
/** Runs a case, then always closes its browsers, removes its rows and ends the pool; no failure hides another. */
async function owning(body:(db:Pool,own:Owned,opened:Member[])=>Promise<void>){
  const db=database(),own:Owned={users:[],admins:[],applications:[],guilds:[],squads:[]},opened:Member[]=[],errors:unknown[]=[];
  try{await body(db,own,opened);}catch(error){errors.push(error);}
  for(const m of opened)await m.context.close().catch(error=>errors.push(error));
  await removeOwned(db,own).catch(error=>errors.push(error));
  await db.end().catch(error=>errors.push(error));
  if(errors.length===1)throw errors[0];
  if(errors.length)throw new AggregateError(errors,errors.map(String).join('\n'));
}

async function member(browser:Browser,baseURL:string,user:Account,viewport:{width:number;height:number}){
  const context=await browser.newContext({baseURL,viewport});
  await context.route(url=>!['127.0.0.1','localhost'].includes(url.hostname),route=>route.abort());
  const page=await context.newPage();
  await page.goto('/');
  await page.getByLabel('電子郵件',{exact:true}).fill(user.email);await page.getByLabel('密碼',{exact:true}).fill(DEMO_PASSWORD);
  await page.getByRole('button',{name:'登入',exact:true}).click();await expect(page.getByRole('button',{name:'登出',exact:true})).toBeVisible();
  const session=await (await page.request.get('/api/v1/session')).json() as {user:{user_id:string};csrf_token:string};
  expect(session.user.user_id).toBe(user.user_id);
  const origin=new URL(baseURL).origin;
  const post=(path:string,data:unknown={},options:{key?:string;version?:string|number}={})=>page.request.post(`/api/v1${path}`,{data,headers:{
    'X-CSRF-Token':session.csrf_token,'Idempotency-Key':options.key??randomUUID(),Origin:origin,...(options.version!==undefined?{'If-Match':`"${options.version}"`}:{})}});
  const get=(path:string)=>page.request.get(`/api/v1${path}`);
  const unread=async(path:string)=>{const response=await get(path);expect(response.status(),path).toBe(200);return (await response.json() as {unread_count:number}).unread_count;};
  const channelRequests:string[]=[];
  page.on('request',request=>{const url=new URL(request.url());if(url.pathname.startsWith('/api/v1/me/channels'))channelRequests.push(`${request.method()} ${url.pathname}${url.search}`);});
  return {context,page,user,id:user.user_id,post,get,unread,channelRequests};
}
type Member=Awaited<ReturnType<typeof member>>;

async function expectOk(response:Promise<import('@playwright/test').APIResponse>,status=200){const r=await response;expect(r.status(),await r.text()).toBe(status);return r.json();}
const guildVersion=async(db:Pool,user:string,key:string)=>(await db.query('SELECT aggregate_version FROM positioning_profession_memberships WHERE user_id=$1 AND guild_key=$2',[user,key])).rows[0].aggregate_version as string;
const squadVersion=async(db:Pool,squad:string,user:string)=>(await db.query('SELECT aggregate_version FROM member_squad_memberships WHERE squad_id=$1 AND user_id=$2',[squad,user])).rows[0].aggregate_version as string;
async function joinGuild(m:Member,key:string){await expectOk(m.post(`/guilds/${key}/join`));}
async function newSquad(own:Owned,owner:Member,name:string){const squad=(await expectOk(owner.post('/squads',{name,kind:'project',purpose:'合成的頻道測試小隊。'}),201)).squad_id as string;own.squads.push(squad);return squad;}
async function joinSquad(db:Pool,squad:string,m:Member,owner:Member){
  await expectOk(m.post(`/squads/${squad}/request`));
  await expectOk(owner.post(`/squads/${squad}/members/${m.id}/accept`,{},{version:await squadVersion(db,squad,m.id)}));
}
const cursor=async(db:Pool,m:Member,kind:Kind,key:string)=>(await db.query('SELECT last_read_sequence::text AS s FROM member_channel_reads WHERE user_id=$1 AND kind=$2 AND channel_key=$3',[m.id,kind,key])).rows[0]?.s as string|undefined;

const count=async(db:Pool,sql:string,values:unknown[]=[])=>(await db.query(`SELECT count(*)::int AS n FROM ${sql}`,values)).rows[0].n as number;

const settings=(page:Page)=>page.getByRole('button',{name:'設定',exact:true});
async function menuUnread(page:Page){
  await settings(page).click();const text=(await page.getByRole('menuitem',{name:'我的訊息',exact:true}).textContent())??'';
  await page.keyboard.press('Escape');return text;
}
async function openMessages(page:Page){
  await settings(page).click();await page.getByRole('menuitem',{name:'我的訊息',exact:true}).click();await expect(page).toHaveURL(/#messages$/);
}
const tab=(page:Page,name:string)=>page.getByRole('tab',{name:new RegExp(`^${name}`)});
const panel=(page:Page,name:string)=>page.getByRole('tabpanel',{name:new RegExp(`^${name}`)});
const channelButton=(page:Page,kind:Kind,key:string)=>panel(page,copy[kind].tab).locator(`.member-channel-list button[data-channel-key="${key}"]`);
const thread=(page:Page,kind:Kind)=>panel(page,copy[kind].tab).locator('.messages-thread');
async function noOverflow(page:Page){expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);}
async function tall(locators:Locator[]){for(const locator of locators){const box=await locator.boundingBox();expect(box,String(locator)).not.toBeNull();expect(box!.height,String(locator)).toBeGreaterThanOrEqual(44);}}
async function shot(page:Page,name:string){await page.evaluate(()=>scrollTo(0,0));const path=`${SHOTS}/${name}.png`;await page.screenshot({path,fullPage:true});return path;}

test('two synthetic members chat in their own guild and squad through the real UI, API and PostgreSQL',async({browser,baseURL})=>{
  test.setTimeout(120000);mkdirSync(SHOTS,{recursive:true});
  const run=randomUUID().slice(0,8);
  await owning(async(db,own,opened)=>{
    const [senderAccount,receiverAccount,thirdAccount]=await accounts(db,own,run,[['sender','寄件人'],['receiver','收件人'],['third','旁觀者']]);
    const guildName=`E2E頻道公會 ${run}`,squadName=`E2E頻道小隊 ${run}`;
    const guild=await approvedGuild(db,own,senderAccount,guildName);
    const sender=await member(browser,baseURL!,senderAccount,{width:1280,height:900});opened.push(sender);
    const receiver=await member(browser,baseURL!,receiverAccount,{width:320,height:844});opened.push(receiver);
    const third=await member(browser,baseURL!,thirdAccount,{width:1280,height:900});opened.push(third);
    for(const m of [sender,receiver,third])await joinGuild(m,guild);
    const squad=await newSquad(own,sender,squadName);await joinSquad(db,squad,receiver,sender);await joinSquad(db,squad,third,sender);
    const room={guild:{key:guild,name:guildName},squad:{key:squad,name:squadName}};
    // Existing private and notification unread of the receiver, which a channel read must never clear.
    const privateText=`私訊 private-${run}`;
    await expectOk(sender.post(`/me/conversations/${receiver.id}/messages`,{body:privateText}),201);
    await expectOk(sender.post(`/friends/${receiver.id}/request`));
    expect(await receiver.unread('/me/conversations?limit=1&offset=0')).toBe(1);expect(await receiver.unread('/me/notifications?limit=1&offset=0')).toBe(1);
    for(const kind of ['guild','squad'] as const)expect(await receiver.unread(`/me/channels?kind=${kind}&limit=1&offset=0`)).toBe(0);
    // The founder's only unread is the real approval notice of this run's guild; read exactly that one through the
    // notification API so every sender source starts at 0 and the settings dot can only come from channel unread.
    const senderNotices=await expectOk(sender.get('/me/notifications?limit=50&offset=0')) as {unread_count:number;items:{notification_id:string;kind:string;read_at:string|null;action:{tab:string;resource_id:string|null}|null}[]};
    expect(senderNotices.unread_count).toBe(1);
    const approval=senderNotices.items.filter(item=>item.read_at===null);
    expect(approval).toHaveLength(1);expect(approval[0].kind).toBe('guild_application_approved');expect(approval[0].action).toEqual({tab:'guilds',resource_id:guild});
    expect((await expectOk(sender.post(`/me/notifications/${approval[0].notification_id}/read`))).notification_id).toBe(approval[0].notification_id);
    for(const path of ['/me/notifications','/me/conversations','/me/channels?kind=guild&','/me/channels?kind=squad&'])
      expect(await sender.unread(`${path}${path.includes('?')?'':'?'}limit=1&offset=0`),path).toBe(0);
    expect(await receiver.unread('/me/conversations?limit=1&offset=0')).toBe(1);expect(await receiver.unread('/me/notifications?limit=1&offset=0')).toBe(1);

    // Four tabs in order; opening a chat tab lists channels only - no history GET, no read.
    for(const m of [sender,receiver,third])await openMessages(m.page);
    // Opening the menu re-read the sender's real total: 0, so no dot before the first send.
    await expect(settings(sender.page)).toHaveAttribute('aria-expanded','false');await expect(settings(sender.page).locator('.settings-dot')).toHaveCount(0);
    await expect(receiver.page.getByRole('tab')).toHaveText([/^通知/,/^公會閒聊/,/^小隊閒聊/,/^私人訊息/]);
    for(const kind of ['guild','squad'] as const){
      const {key,name}=room[kind],r=receiver.page,s=sender.page,label=copy[kind].tab;
      receiver.channelRequests.length=0;
      await tab(r,label).click();await expect(channelButton(r,kind,key)).toHaveAccessibleName(name);
      await expect(thread(r,kind).locator('.messages-bubbles')).toHaveCount(0);
      expect(receiver.channelRequests.filter(entry=>!entry.startsWith('GET /api/v1/me/channels?')),'a chat tab without a picked channel only lists').toEqual([]);

      // The sender writes plain text from the desktop UI.
      await tab(s,label).click();await channelButton(s,kind,key).click();
      const sThread=thread(s,kind);await expect(sThread.getByRole('heading',{name:`${name}・${label}`})).toBeFocused();
      const text=`<b>${kind} 真實閒聊</b> & <img src=x onerror=alert(1)> ${run}`;
      const sBox=sThread.getByLabel(`在 ${name} 發言`);await sBox.fill(`  ${text}  `);
      const posted=s.waitForResponse(response=>response.request().method()==='POST'&&response.url().endsWith(`/api/v1/me/channels/${kind}/${key}/messages`));
      await sThread.getByRole('button',{name:'送出',exact:true}).click();
      expect((await posted).status()).toBe(201);
      const sent=sThread.getByRole('list',{name:'頻道訊息'}).locator('li').last();
      await expect(sent.locator('.messages-body')).toHaveText(text);await expect(sBox).toHaveValue('');
      await expect(sThread.locator('.messages-bubbles b, .messages-bubbles img')).toHaveCount(0);
      const rows=(await db.query('SELECT message_id,sequence::text FROM member_channel_messages WHERE kind=$1 AND channel_key=$2',[kind,key])).rows;
      expect(rows).toHaveLength(1);await expect(sent).toHaveAttribute('data-message-id',rows[0].message_id);
      // Own message: never unread for the sender.
      expect(await sender.unread(`/me/channels?kind=${kind}&limit=1&offset=0`)).toBe(0);
      await expect(sThread.getByRole('button',{name:'標為已讀',exact:true})).toHaveCount(0);

      // The receiver's list re-reads on focus: 0 → 1, and the tab badge follows the real total.
      await r.evaluate(()=>window.dispatchEvent(new Event('focus')));
      await expect(channelButton(r,kind,key).locator('.messages-count')).toHaveText('1 則未讀');await expect(tab(r,label)).toContainText('1 則未讀');
      expect(receiver.channelRequests.some(entry=>entry.includes(`/me/channels/${kind}/`)),'still no history read before picking').toBe(false);
      await channelButton(r,kind,key).click();
      const rThread=thread(r,kind);await expect(rThread.getByRole('heading',{name:`${name}・${label}`})).toBeFocused();
      await expect(rThread.locator(`li[data-message-id="${rows[0].message_id}"] .messages-body`)).toHaveText(text);
      await expect(rThread.locator('.messages-bubbles b, .messages-bubbles img')).toHaveCount(0);
      // Opening the history marked nothing read, on the API or in PostgreSQL.
      expect(receiver.channelRequests.filter(entry=>entry.startsWith('POST'))).toEqual([]);
      expect(await cursor(db,receiver,kind,key)).toBeUndefined();expect(await receiver.unread(`/me/channels/${kind}/${key}/messages?limit=1&offset=0`)).toBe(1);
      await noOverflow(r);
      const rBox=rThread.getByLabel(`在 ${name} 發言`);
      expect(await rBox.evaluate(node=>getComputedStyle(node).fontSize)).toBe('16px');
      await tall([tab(r,label),channelButton(r,kind,key),rThread.getByRole('button',{name:'重新讀取訊息',exact:true}),rThread.getByRole('button',{name:'標為已讀',exact:true}),rThread.getByRole('button',{name:'送出',exact:true})]);

      // Explicit read: PostgreSQL cursor, API and badges move together; private and notification unread stay.
      await rThread.getByRole('button',{name:'標為已讀',exact:true}).click();
      await expect(tab(r,label)).toContainText('沒有未讀');await expect(rThread.getByRole('button',{name:/標為已讀|正在標記/})).toHaveCount(0);
      expect(await cursor(db,receiver,kind,key)).toBe(rows[0].sequence);
      expect(await receiver.unread(`/me/channels?kind=${kind}&limit=1&offset=0`)).toBe(0);
      expect(await receiver.unread('/me/conversations?limit=1&offset=0')).toBe(1);expect(await receiver.unread('/me/notifications?limit=1&offset=0')).toBe(1);
      await expect(tab(r,'私人訊息')).toContainText('1 則未讀');await expect(tab(r,'通知')).toContainText('1 則未讀');
      await expect.poll(()=>menuUnread(r)).toBe('我的訊息2 則未讀');

      // The receiver answers from 320px; the sender sees it after a manual re-read.
      const reply=`${kind} 回覆 <i>純文字</i> ${run}`;
      await rBox.fill(reply);await rThread.getByRole('button',{name:'送出',exact:true}).click();
      await expect(rThread.getByRole('list',{name:'頻道訊息'}).locator('li').last().locator('.messages-body')).toHaveText(reply);await expect(rBox).toHaveValue('');
      expect(await receiver.unread(`/me/channels?kind=${kind}&limit=1&offset=0`)).toBe(0);
      // Before the sender re-reads, its page still shows the room at 0: no list badge, tab says none.
      await expect(tab(s,label).locator('.messages-count')).toHaveText('沒有未讀');await expect(channelButton(s,kind,key).locator('.messages-count')).toHaveCount(0);
      if(kind==='guild')await expect(settings(s).locator('.settings-dot')).toHaveCount(0);
      await sThread.getByRole('button',{name:'重新讀取訊息',exact:true}).click();
      await expect(sThread.getByRole('list',{name:'頻道訊息'}).locator('li').last().locator('.messages-body')).toHaveText(reply);
      await expect(sThread.locator('.messages-bubbles i')).toHaveCount(0);
      expect(await sender.unread(`/me/channels?kind=${kind}&limit=1&offset=0`)).toBe(1);
      // The manual re-read alone moves the room tab and this exact channel's list badge to 1 ...
      await expect(tab(s,label).locator('.messages-count')).toHaveText('1 則未讀');await expect(channelButton(s,kind,key).locator('.messages-count')).toHaveText('1 則未讀');
      // ... and the global settings dot, with the menu never opened and no focus event on the sender page.
      if(kind==='guild'){await expect(settings(s)).toHaveAttribute('aria-expanded','false');await expect(settings(s).locator('.settings-dot')).toBeVisible();}
      expect(await count(db,'member_channel_messages WHERE kind=$1 AND channel_key=$2',[kind,key])).toBe(2);
      await noOverflow(r);
      await shot(r,`${kind}-320`);await shot(s,`${kind}-desktop`);
    }

    // A third room member sees both rooms but never the private pair.
    const t=third.page;
    for(const kind of ['guild','squad'] as const){
      await tab(t,copy[kind].tab).click();await channelButton(t,kind,room[kind].key).click();
      await expect(thread(t,kind).getByRole('list',{name:'頻道訊息'}).locator('li')).toHaveCount(2);await expect(thread(t,kind)).not.toContainText(privateText);
    }
    await tab(t,'私人訊息').click();
    await expect(panel(t,'私人訊息')).not.toContainText(privateText);await expect(panel(t,'私人訊息').getByRole('list',{name:'對話列表'}).getByRole('button')).toHaveCount(0);
    expect((await expectOk(third.get('/me/conversations'))).items).toEqual([]);
    expect(await count(db,'member_notifications WHERE recipient_ref=$1',[third.id])).toBe(0);
    await shot(t,'third-desktop');
  });
});

test('after leaving a guild and a squad through the real API, the open chat clears its history, closes sending and returns to the entry',async({browser,baseURL})=>{
  test.setTimeout(120000);mkdirSync(SHOTS,{recursive:true});
  const run=randomUUID().slice(0,8);
  await owning(async(db,own,opened)=>{
    const [stayerAccount,leaverAccount]=await accounts(db,own,run,[['stayer','留下者'],['leaver','退出者']]);
    const guildName=`E2E退出公會 ${run}`,squadName=`E2E退出小隊 ${run}`;
    const guild=await approvedGuild(db,own,stayerAccount,guildName);
    const stayer=await member(browser,baseURL!,stayerAccount,{width:1280,height:900});opened.push(stayer);
    const leaver=await member(browser,baseURL!,leaverAccount,{width:320,height:844});opened.push(leaver);
    for(const m of [stayer,leaver])await joinGuild(m,guild);
    // The stayer owns the squad, so the leaver is an ordinary member who may leave; the guild is not the leaver's primary.
    const squad=await newSquad(own,stayer,squadName);await joinSquad(db,squad,leaver,stayer);
    const room={guild:{key:guild,name:guildName},squad:{key:squad,name:squadName}};
    const leave={
      guild:async()=>expectOk(leaver.post(`/guilds/${guild}/leave`,{},{version:await guildVersion(db,leaver.id,guild)})),
      squad:async()=>expectOk(leaver.post(`/squads/${squad}/leave`,{},{version:await squadVersion(db,squad,leaver.id)})),
    };
    const l=leaver.page;
    for(const kind of ['guild','squad'] as const){
      const {key,name}=room[kind],label=copy[kind].tab,secret=`${kind} 退出前的內容 ${run}`;
      const earlier=await expectOk(stayer.post(`/me/channels/${kind}/${key}/messages`,{body:secret}),201);
      await openMessages(l);await tab(l,label).click();await channelButton(l,kind,key).click();
      const lThread=thread(l,kind);
      await expect(lThread.locator(`li[data-message-id="${earlier.message_id}"] .messages-body`)).toHaveText(secret);
      await lThread.getByLabel(`在 ${name} 發言`).fill('退出後不應送出的草稿');
      const mine=await expectOk(leaver.post(`/me/channels/${kind}/${key}/messages`,{body:`${kind} 退出者自己的話`}),201);

      await leave[kind]();
      // Real API after the leave: history, send and read are all the same 404.
      for(const response of [await leaver.get(`/me/channels/${kind}/${key}/messages`),await leaver.post(`/me/channels/${kind}/${key}/messages`,{body:'退出後'}),
        await leaver.post(`/me/channels/${kind}/${key}/read`,{through_message_id:earlier.message_id})]){
        expect(response.status()).toBe(404);const problem=await response.json();expect(problem.code).toBe('channel_not_available');expect(JSON.stringify(problem)).not.toContain(secret);
      }
      expect((await expectOk(leaver.get(`/me/channels?kind=${kind}`))).items.map((item:{channel_key:string})=>item.channel_key)).not.toContain(key);

      // The page still showing the old history re-reads: history and composer are gone, the channel leaves the list.
      await lThread.getByRole('button',{name:'重新讀取訊息',exact:true}).click();
      await expect(lThread.getByRole('alert')).toContainText('目前無法使用此頻道。');
      await expect(lThread.getByRole('list',{name:'頻道訊息'})).toHaveCount(0);await expect(lThread).not.toContainText(secret);
      await expect(lThread.locator('textarea')).toHaveCount(0);await expect(lThread.getByRole('button',{name:'送出',exact:true})).toHaveCount(0);
      await expect(channelButton(l,kind,key)).toHaveCount(0);
      await noOverflow(l);await tall([lThread.getByRole('button',{name:copy[kind].back,exact:true})]);
      await shot(l,kind==='guild'?'revoked-320':'revoked-squad-320');
      await lThread.getByRole('button',{name:copy[kind].back,exact:true}).click();
      await expect(l).toHaveURL(new RegExp(`${copy[kind].hash}$`));

      // The room keeps both messages for the stayer; nothing was written after the leave.
      expect(await count(db,'member_channel_messages WHERE kind=$1 AND channel_key=$2 AND sender_ref=$3',[kind,key,leaver.id])).toBe(1);
      expect(await cursor(db,leaver,kind,key)).toBeUndefined();
      await openMessages(stayer.page);await tab(stayer.page,label).click();await channelButton(stayer.page,kind,key).click();
      await expect(thread(stayer.page,kind).locator(`li[data-message-id="${mine.message_id}"]`)).toHaveCount(1);
      await shot(stayer.page,`revoked-${kind}-desktop`);
    }
  });
});
