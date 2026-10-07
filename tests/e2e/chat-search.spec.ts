import {randomUUID} from 'node:crypto';
import {mkdirSync} from 'node:fs';
import {Pool} from 'pg';
import {test,expect,type Browser,type BrowserContext,type Page} from './fixtures.js';
import {LOCAL_DATABASE_URL} from '../../packages/db/index.js';
import {e2eSchema} from '../../packages/testing/e2e-auth-isolation.js';
import {DEMO_USERS,DEMO_COMMUNITY,DEMO_PASSWORD} from '../../packages/testing/seed.js';

let db:Pool,contexts:BrowserContext[],accounts:{id:string;email:string;name:string}[],squads:string[];
test.beforeEach(async()=>{
  db=new Pool({connectionString:process.env.TEST_DATABASE_URL??LOCAL_DATABASE_URL,options:`-c search_path=${e2eSchema(process.env.FREEDOM_E2E_SCHEMA)}`,max:4});
  contexts=[];accounts=[];squads=[];
  for(const name of ['甲','乙','丙']){
    // Directory searches correctly hide verification-only @example.invalid users.
    const id=randomUUID(),email=`chat-search-${id}@example.test`,display=`合成搜尋${name} ${id.slice(0,8)}`;
    await db.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref,onboarding_required,email_verified_at)
      SELECT $1,$2,$3,$4,password_hash,$5,false,now() FROM users WHERE user_id=$6`,[id,DEMO_COMMUNITY,email,display,randomUUID(),DEMO_USERS[0].user_id]);
    await db.query("INSERT INTO positioning_profession_memberships(membership_id,community_id,user_id,guild_key,state) VALUES($1,$2,$3,'guild_ai_vibe','active')",[randomUUID(),DEMO_COMMUNITY,id]);
    accounts.push({id,email,name:display});
  }
});
test.afterEach(async()=>{
  await Promise.all(contexts.map(context=>context.close()));
  const ids=accounts.map(account=>account.id),q=await db.connect();
  try{
    await q.query('BEGIN');
    await q.query('DELETE FROM member_channel_reads WHERE user_id=ANY($1::uuid[])',[ids]);
    await q.query('DELETE FROM member_channel_messages WHERE sender_ref=ANY($1::uuid[])',[ids]);
    await q.query('DELETE FROM member_direct_messages WHERE sender_ref=ANY($1::uuid[]) OR recipient_ref=ANY($1::uuid[])',[ids]);
    await q.query("DELETE FROM member_chat_channels WHERE kind='squad' AND channel_key=ANY($1::text[])",[squads]);
    await q.query('DELETE FROM member_squad_memberships WHERE squad_id=ANY($1::uuid[])',[squads]);
    await q.query('DELETE FROM member_squads WHERE squad_id=ANY($1::uuid[])',[squads]);
    for(const table of ['positioning_profession_memberships','sessions','member_client_errors','command_receipts'])await q.query(`DELETE FROM ${table} WHERE user_id=ANY($1::uuid[])`,[ids]);
    await q.query('DELETE FROM member_notifications WHERE recipient_ref=ANY($1::uuid[])',[ids]);
    await q.query('DELETE FROM outbox WHERE transition_id IN (SELECT transition_id FROM transition_journal WHERE actor_ref=ANY($1::uuid[]))',[ids]);
    await q.query('DELETE FROM transition_journal WHERE actor_ref=ANY($1::uuid[])',[ids]);
    await q.query('DELETE FROM users WHERE user_id=ANY($1::uuid[])',[ids]);await q.query('COMMIT');
  }catch(error){await q.query('ROLLBACK');throw error;}finally{q.release();await db.end();}
});
async function member(browser:Browser,baseURL:string,width=390){
  const context=await browser.newContext({baseURL,viewport:{width,height:900}});contexts.push(context);
  await context.route(url=>!['localhost','127.0.0.1'].includes(url.hostname),route=>route.abort());
  const page=await context.newPage();await page.goto('/#messages');
  await page.getByLabel('電子郵件',{exact:true}).fill(accounts[0].email);await page.getByLabel('密碼',{exact:true}).fill(DEMO_PASSWORD);
  await page.getByRole('button',{name:'登入',exact:true}).click();await expect(page.locator('.messages-categories')).toBeVisible();return page;
}
async function direct(page:Page){
  const panel=page.locator('#messages-panel-direct');await panel.getByLabel('搜尋會員',{exact:true}).fill(accounts[1].name);
  await panel.getByRole('button',{name:'搜尋會員',exact:true}).click();await panel.getByRole('button',{name:`傳訊給 ${accounts[1].name}`,exact:true}).click();
  await expect(panel.locator('.messages-compose')).toBeVisible();return panel;
}
async function directHistory(bodies:string[]){
  for(const body of bodies)await db.query(`INSERT INTO member_direct_messages(community_id,sender_ref,recipient_ref,body,created_at)
    VALUES($1,$2,$3,$4,timestamptz '2026-09-01T00:00:00.123456Z')`,[DEMO_COMMUNITY,accounts[1].id,accounts[0].id,body]);
}
async function search(page:Page,text:string){
  const dialog=page.getByRole('dialog',{name:'搜尋訊息',exact:true});await expect(dialog).toBeVisible();
  await dialog.getByLabel('搜尋這個對話的訊息').fill(text);await dialog.getByRole('button',{name:'搜尋',exact:true}).click();return dialog;
}

test('private search finds older pages, preserves drafts and only reads new arrivals after closing',async({browser,baseURL})=>{
  await directHistory(Array.from({length:27},(_,i)=>`古訊息 100%_\\ ${i}`));
  const page=await member(browser,baseURL!),panel=await direct(page),box=panel.locator('textarea');
  await box.fill('這份草稿要保留');
  await expect.poll(async()=>(await db.query('SELECT count(*)::int AS n FROM member_direct_messages WHERE recipient_ref=$1 AND read_at IS NULL',[accounts[0].id])).rows[0].n).toBe(0);
  await panel.getByRole('button',{name:'搜尋訊息',exact:true}).click();const dialog=await search(page,'100%_\\');
  await expect(dialog.locator('[data-search-message-id]')).toHaveCount(20);await dialog.getByRole('button',{name:'更多搜尋結果',exact:true}).click();
  await expect(dialog.locator('[data-search-message-id]')).toHaveCount(27);await expect(dialog.getByRole('button',{name:'更多搜尋結果'})).toHaveCount(0);
  expect(await dialog.locator('mark').first().innerText()).toBe('100%_\\');
  await db.query('INSERT INTO member_direct_messages(community_id,sender_ref,recipient_ref,body) VALUES($1,$2,$3,$4)',[DEMO_COMMUNITY,accounts[1].id,accounts[0].id,'查詢期間的新到訊息']);
  await expect(panel.locator('.messages-bubbles')).toContainText('查詢期間的新到訊息');
  expect((await db.query('SELECT count(*)::int AS n FROM member_direct_messages WHERE recipient_ref=$1 AND read_at IS NULL',[accounts[0].id])).rows[0].n).toBe(1);
  await dialog.getByRole('button',{name:'關閉搜尋',exact:true}).click();await expect(dialog).toBeHidden();await expect(box).toHaveValue('這份草稿要保留');
  await expect(panel.getByRole('button',{name:'搜尋訊息',exact:true})).toBeFocused();
  await expect.poll(async()=>(await db.query('SELECT count(*)::int AS n FROM member_direct_messages WHERE recipient_ref=$1 AND read_at IS NULL',[accounts[0].id])).rows[0].n).toBe(0);
  const viewport=page.viewportSize()!,log=(await panel.getByRole('log').boundingBox())!;expect(log.height).toBeGreaterThanOrEqual(viewport.height/2);expect(log.width).toBe(viewport.width);
  for(const button of [panel.getByRole('button',{name:'搜尋訊息',exact:true}),panel.getByRole('button',{name:'送出',exact:true})])expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  mkdirSync('test-results/social-chat-search',{recursive:true});await page.screenshot({path:'test-results/social-chat-search/private-chat-390.png'});
});

test('guild, squad and public search stay in their selected conversation at 320px',async({browser,baseURL})=>{
  const squad=randomUUID();squads.push(squad);
  await db.query("INSERT INTO member_squads(squad_id,community_id,name,kind,purpose,owner_ref) VALUES($1,$2,'合成搜尋群組','project','搜尋測試',$3)",[squad,DEMO_COMMUNITY,accounts[0].id]);
  await db.query("INSERT INTO member_squad_memberships(squad_id,user_id,state) VALUES($1,$2,'active')",[squad,accounts[0].id]);
  for(const [kind,key] of [['guild','guild_ai_vibe'],['squad',squad],['world','world']]){
    await db.query('INSERT INTO member_chat_channels(community_id,kind,channel_key,last_sequence) VALUES($1,$2,$3,24) ON CONFLICT(community_id,kind,channel_key) DO UPDATE SET last_sequence=GREATEST(member_chat_channels.last_sequence,24)',[DEMO_COMMUNITY,kind,key]);
    const start=(await db.query('SELECT last_sequence::text AS n FROM member_chat_channels WHERE community_id=$1 AND kind=$2 AND channel_key=$3',[DEMO_COMMUNITY,kind,key])).rows[0].n;
    await db.query(`INSERT INTO member_channel_messages(community_id,kind,channel_key,sequence,sender_ref,body,created_at)
      SELECT $1,$2,$3,$4::bigint+n,$5,$6||n,timestamptz '2026-09-01T00:00:00Z' FROM generate_series(1,24) n`,[DEMO_COMMUNITY,kind,key,start,accounts[0].id,`共創 ${kind} `]);
    await db.query('UPDATE member_chat_channels SET last_sequence=$4::bigint+24 WHERE community_id=$1 AND kind=$2 AND channel_key=$3',[DEMO_COMMUNITY,kind,key,start]);
  }
  const page=await member(browser,baseURL!,320);
  for(const [kind,label,key] of [['guild','公會閒聊','guild_ai_vibe'],['squad','小隊閒聊',squad],['world','世界聊天','world']]){
    await page.locator('.messages-categories').getByRole('tab',{name:new RegExp(`^${label}`)}).click();const panel=page.locator(`#messages-panel-${kind}`);
    if(kind==='world')await panel.getByRole('button',{name:'世界聊天',exact:true}).click();else await panel.locator(`[data-channel-key="${key}"]`).click();
    await panel.getByRole('button',{name:'搜尋訊息',exact:true}).click();const dialog=await search(page,'共創');
    await expect(dialog.locator('[data-search-message-id]')).toHaveCount(20);await dialog.getByRole('button',{name:'更多搜尋結果',exact:true}).click();await expect(dialog.locator('[data-search-message-id]')).toHaveCount(24);
    await expect(dialog.getByRole('list',{name:'訊息搜尋結果'})).toContainText(`共創 ${kind}`);
    const bounds=(await dialog.boundingBox())!;expect(bounds.x).toBeGreaterThanOrEqual(0);expect(bounds.x+bounds.width).toBeLessThanOrEqual(320);expect(bounds.y+bounds.height).toBeLessThanOrEqual(900);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    if(kind==='world'){mkdirSync('test-results/social-chat-search',{recursive:true});await page.screenshot({path:'test-results/social-chat-search/public-search-320.png'});}
    await dialog.press('Escape');await expect(dialog).toBeHidden();await panel.locator('.chat-back').click();
  }
});

test('failed and late searches recover without replacing the new query, and Escape returns focus',async({browser,baseURL})=>{
  await directHistory(['慢速的舊查詢','共創的新查詢']);const page=await member(browser,baseURL!),panel=await direct(page);
  let failures=1,held=false,release=()=>{},settled=false;const gate=new Promise<void>(resolve=>{release=resolve});
  await page.route(/\/api\/v1\/me\/conversations\/[^/]+\/messages\/search\?/,async route=>{
    if(failures-->0)return route.abort();
    const response=await route.fetch();if(new URL(route.request().url()).searchParams.get('q')==='慢速'){
      held=true;await gate;try{await route.fulfill({response})}catch{if(!route.request().failure())throw new Error('Unexpected route fulfillment failure')}finally{settled=true;}
    }else await route.fulfill({response});
  });
  await panel.getByRole('button',{name:'搜尋訊息',exact:true}).click();const dialog=await search(page,'共創');
  await expect(dialog.getByRole('alert')).toContainText('搜尋未完成');await dialog.getByRole('button',{name:'重試搜尋',exact:true}).click();
  await expect(dialog.getByRole('list',{name:'訊息搜尋結果'})).toContainText('共創的新查詢');
  await search(page,'慢速');await expect.poll(()=>held).toBe(true);await expect(dialog.getByRole('status')).toContainText('正在搜尋');
  await search(page,'共創');await expect(dialog.getByRole('list',{name:'訊息搜尋結果'})).toContainText('共創的新查詢');release();await expect.poll(()=>settled).toBe(true);
  await expect(dialog.getByRole('list',{name:'訊息搜尋結果'})).not.toContainText('慢速的舊查詢');await dialog.press('Escape');await expect(panel.getByRole('button',{name:'搜尋訊息',exact:true})).toBeFocused();
});
