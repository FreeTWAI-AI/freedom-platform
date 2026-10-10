import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {test,expect,type Browser,type BrowserContext,type Page} from './fixtures.js';
import {LOCAL_DATABASE_URL} from '../../packages/db/index.js';
import {e2eSchema} from '../../packages/testing/e2e-auth-isolation.js';
import {DEMO_USERS,DEMO_COMMUNITY,DEMO_PASSWORD} from '../../packages/testing/seed.js';

// #398 with the real API and two synthetic members; rows are removed afterwards.
let db:Pool,contexts:BrowserContext[],accounts:{id:string;email:string;name:string}[];
test.beforeEach(async()=>{
  db=new Pool({connectionString:process.env.TEST_DATABASE_URL??LOCAL_DATABASE_URL,options:`-c search_path=${e2eSchema(process.env.FREEDOM_E2E_SCHEMA)}`,max:4});
  contexts=[];accounts=[];
  for(const name of ['甲','乙']){
    const id=randomUUID(),email=`retract-${id}@example.test`,display=`合成收回${name} ${id.slice(0,8)}`;
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
    for(const table of ['positioning_profession_memberships','sessions','member_client_errors','command_receipts'])await q.query(`DELETE FROM ${table} WHERE user_id=ANY($1::uuid[])`,[ids]);
    await q.query('DELETE FROM member_notifications WHERE recipient_ref=ANY($1::uuid[])',[ids]);
    await q.query('DELETE FROM outbox WHERE transition_id IN (SELECT transition_id FROM transition_journal WHERE actor_ref=ANY($1::uuid[]))',[ids]);
    await q.query('DELETE FROM transition_journal WHERE actor_ref=ANY($1::uuid[])',[ids]);
    await q.query('DELETE FROM users WHERE user_id=ANY($1::uuid[])',[ids]);await q.query('COMMIT');
  }catch(error){await q.query('ROLLBACK');throw error;}finally{q.release();await db.end();}
});
async function member(browser:Browser,baseURL:string,index:number,width=1280){
  const context=await browser.newContext({baseURL,viewport:{width,height:900}});contexts.push(context);
  await context.route(url=>!['localhost','127.0.0.1'].includes(url.hostname),route=>route.abort());
  const page=await context.newPage();await page.goto('/#messages');
  await page.getByLabel('電子郵件',{exact:true}).fill(accounts[index].email);await page.getByLabel('密碼',{exact:true}).fill(DEMO_PASSWORD);
  await page.getByRole('button',{name:'登入',exact:true}).click();await expect(page.locator('.messages-categories')).toBeVisible();return page;
}
async function openDirect(page:Page,peer:string){
  const panel=page.locator('#messages-panel-direct');await panel.getByLabel('搜尋會員',{exact:true}).fill(peer);
  await panel.getByRole('button',{name:'搜尋會員',exact:true}).click();await panel.getByRole('button',{name:`傳訊給 ${peer}`,exact:true}).click();
  await expect(panel.locator('.messages-compose')).toBeVisible();return panel;
}

test('a sender retracts a private message through the site dialog and the recipient sees only a placeholder',async({browser,baseURL})=>{
  await db.query('INSERT INTO member_direct_messages(community_id,sender_ref,recipient_ref,body) VALUES($1,$2,$3,$4),($1,$3,$2,$5)',
    [DEMO_COMMUNITY,accounts[0].id,accounts[1].id,'合成：電話 0912-000-000','合成：對方的訊息']);
  const sender=await member(browser,baseURL!,0),panel=await openDirect(sender,accounts[1].name);
  const mine=panel.locator('.messages-bubbles li.is-mine',{hasText:'0912'});
  await expect(mine).toBeVisible();
  // Only my own message offers 收回.
  await expect(panel.locator('.messages-bubbles li:not(.is-mine)').getByRole('button',{name:'收回你的訊息'})).toHaveCount(0);
  const trigger=mine.getByRole('button',{name:'收回你的訊息'});
  await trigger.click();
  const dialog=sender.getByRole('dialog',{name:'收回這則訊息？'});
  await expect(dialog).toBeVisible();await expect(dialog).toContainText('0912');
  await sender.keyboard.press('Escape');await expect(dialog).toBeHidden();await expect(trigger).toBeFocused();
  await trigger.click();await sender.screenshot({path:'test-results/message-retract-dialog.png'});
  await dialog.getByRole('button',{name:'確定收回'}).click();
  await expect(dialog).toBeHidden();
  await expect(panel.locator('.messages-bubbles')).not.toContainText('0912');
  await expect(panel.locator('.messages-bubbles .chat-retracted')).toHaveText('你已收回這則訊息。');

  const recipient=await member(browser,baseURL!,1,390),other=await openDirect(recipient,accounts[0].name);
  await expect(other.locator('.messages-bubbles .chat-retracted')).toHaveText('這則訊息已收回。');
  await expect(other.locator('.messages-bubbles')).not.toContainText('0912');
  await expect(other.locator('.messages-bubbles li',{has:recipient.locator('.chat-retracted')}).locator('.messages-meta')).not.toContainText('未讀');
  await expect(other.getByRole('button',{name:'收回你的訊息'})).toHaveCount(1);
  await recipient.screenshot({path:'test-results/message-retract-390.png'});
  expect((await db.query('SELECT count(*)::int AS n FROM member_direct_messages WHERE retracted_at IS NOT NULL AND sender_ref=$1',[accounts[0].id])).rows[0].n).toBe(1);
});
