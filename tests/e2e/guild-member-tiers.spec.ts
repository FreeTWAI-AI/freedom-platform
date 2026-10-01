import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import {test,expect,type Browser,type Page} from './fixtures.js';
import {navigate} from './navigation.js';
import {DEMO_COMMUNITY,DEMO_PASSWORD} from '../../packages/testing/seed.js';
import {hashPassword} from '../../modules/identity-membership/service.js';

const guildKey='guild_projection_mapping';
const notice='你是這個公會的實習成員：可以閱讀公會內容、在公會聊天室聊天。想發布或編輯，可以在聊天室跟會長打聲招呼，會長能把你設為正式成員。';
const internWrite='實習成員可以閱讀公會內容、在公會聊天室聊天；請會長把你設為正式成員後再發布或編輯。';
const cap='每個公會最多 3 位公會專家，請先移除一位再任命。';
const widths=[{width:1280,height:900},{width:820,height:900},{width:390,height:844}];
type Person={user_id:string;email:string;display_name:string;tier:'intern'|'full';expert?:boolean;master?:boolean};
type Fixture={guildName:string;people:Person[];master:Person;intern:Person;extra:Person};

async function seed(db:Pool):Promise<Fixture>{
 const run=randomUUID().slice(0,8);
 const guildName=(await db.query('SELECT name FROM positioning_guild_catalog WHERE guild_key=$1',[guildKey])).rows[0].name as string;
 const people:Person[]=[
  {user_id:randomUUID(),email:`tier-master-${run}@example.test`,display_name:`層級會長 ${run}`,tier:'full',master:true},
  {user_id:randomUUID(),email:`tier-intern-${run}@example.test`,display_name:`層級實習 ${run}`,tier:'intern'},
  {user_id:randomUUID(),email:`tier-expert-a-${run}@example.test`,display_name:`層級專家甲 ${run}`,tier:'full',expert:true},
  {user_id:randomUUID(),email:`tier-expert-b-${run}@example.test`,display_name:`層級專家乙 ${run}`,tier:'full',expert:true},
  {user_id:randomUUID(),email:`tier-extra-${run}@example.test`,display_name:`層級候補 ${run}`,tier:'full'},
 ];
 const master=people[0];
 for(const person of people){
  await db.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref,onboarding_required) VALUES($1,$2,$3,$4,$5,$6,false)`,[person.user_id,DEMO_COMMUNITY,person.email,person.display_name,hashPassword(DEMO_PASSWORD),randomUUID()]);
  await db.query(`INSERT INTO positioning_profession_memberships(membership_id,community_id,user_id,guild_key,state,member_tier) VALUES($1,$2,$3,$4,'active',$5)`,[randomUUID(),DEMO_COMMUNITY,person.user_id,guildKey,person.tier]);
  if(person.expert)await db.query('INSERT INTO positioning_guild_experts(community_id,guild_key,user_id,active,appointed_by_user_id) VALUES($1,$2,$3,true,$4)',[DEMO_COMMUNITY,guildKey,person.user_id,master.user_id]);
 }
 await db.query('INSERT INTO positioning_guild_officers(community_id,guild_key,user_id) VALUES($1,$2,$3)',[DEMO_COMMUNITY,guildKey,master.user_id]);
 return {guildName,people,master,intern:people[1],extra:people[4]};
}
async function cleanup(db:Pool,fixture:Fixture){
 const ids=fixture.people.map(person=>person.user_id);
 await db.query('DELETE FROM positioning_guild_experts WHERE community_id=$1 AND guild_key=$2 AND user_id=ANY($3::uuid[])',[DEMO_COMMUNITY,guildKey,ids]);
 await db.query('DELETE FROM positioning_guild_officers WHERE community_id=$1 AND guild_key=$2 AND user_id=ANY($3::uuid[])',[DEMO_COMMUNITY,guildKey,ids]);
 await db.query('DELETE FROM member_notifications WHERE community_id=$1 AND recipient_ref=ANY($2::uuid[])',[DEMO_COMMUNITY,ids]);
 await db.query('DELETE FROM member_skill_book_grants WHERE community_id=$1 AND user_id=ANY($2::uuid[])',[DEMO_COMMUNITY,ids]);
 await db.query('DELETE FROM command_receipts WHERE user_id=ANY($1::uuid[])',[ids]);
 await db.query('DELETE FROM outbox WHERE transition_id IN (SELECT transition_id FROM transition_journal WHERE actor_ref=ANY($1::uuid[]))',[ids]);
 await db.query('DELETE FROM transition_journal WHERE actor_ref=ANY($1::uuid[])',[ids]);
 await db.query('DELETE FROM positioning_profession_memberships WHERE community_id=$1 AND user_id=ANY($2::uuid[])',[DEMO_COMMUNITY,ids]);
 await db.query('DELETE FROM sessions WHERE user_id=ANY($1::uuid[])',[ids]);
 await db.query('DELETE FROM users WHERE user_id=ANY($1::uuid[])',[ids]);
}
async function open(browser:Browser,baseURL:string,person:Person,viewport:{width:number;height:number}){
 const context=await browser.newContext({baseURL,viewport});
 await context.route(url=>!['127.0.0.1','localhost'].includes(url.hostname),route=>route.abort());
 const page=await context.newPage();
 await page.goto('/');
 await page.getByLabel('電子郵件',{exact:true}).fill(person.email);
 await page.getByLabel('密碼',{exact:true}).fill(DEMO_PASSWORD);
 await page.getByRole('button',{name:'登入',exact:true}).click();
 await expect(page.getByRole('button',{name:'設定',exact:true})).toBeVisible();
 return {context,page};
}
async function noOverflow(page:Page){expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);}
async function memberRow(page:Page,name:string){
 const dialog=page.getByRole('dialog');
 const search=dialog.getByRole('searchbox',{name:'搜尋公會成員'});
 await search.fill(name);
 await dialog.getByRole('button',{name:'搜尋成員',exact:true}).click();
 const row=dialog.locator('.directory-member');
 await expect(row).toHaveCount(1);
 await expect(row).toContainText(name);
 return row;
}

test('an intern sees the calm notice and a disabled guild-exchange submit at phone, tablet and desktop',async({browser,baseURL,e2eAuthPool})=>{
 test.setTimeout(120_000);
 const fixture=await seed(e2eAuthPool);
 const session=await open(browser,baseURL!,fixture.intern,widths[0]);
 try{
  for(const viewport of widths){
   await session.page.setViewportSize(viewport);
   await navigate(session.page,'職業公會');
   const card=session.page.getByRole('article',{name:fixture.guildName,exact:true});
   await card.scrollIntoViewIfNeeded();
   await expect(card.getByRole('status')).toHaveText(notice);
   await noOverflow(session.page);
  }
  await session.page.setViewportSize(widths[0]);
  await navigate(session.page,'社群活動');
  await session.page.getByRole('button',{name:'＋ 提交活動'}).click();
  await session.page.getByLabel('活動類型').selectOption('guild_skill_exchange');
  await session.page.getByRole('combobox',{name:/^主辦公會/}).selectOption({label:fixture.guildName});
  const submit=session.page.getByRole('button',{name:'送出審核',exact:true});
  for(const viewport of widths){
   await session.page.setViewportSize(viewport);
   await expect(submit).toBeDisabled();
   await expect(session.page.getByText(internWrite)).toBeVisible();
   await noOverflow(session.page);
  }
 }finally{await session.context.close();await cleanup(e2eAuthPool,fixture);}
});

test('the guild master promotes an intern, appoints an expert, and sees the 3/3 refusal',async({browser,baseURL,e2eAuthPool})=>{
 test.setTimeout(120_000);
 const fixture=await seed(e2eAuthPool);
 const session=await open(browser,baseURL!,fixture.master,widths[0]);
 try{
  await navigate(session.page,'職業公會');
  const card=session.page.getByRole('article',{name:fixture.guildName,exact:true});
  await card.getByRole('button',{name:'查看成員',exact:true}).click();
  const dialog=session.page.getByRole('dialog');
  await expect(dialog.locator('.guild-expert-count')).toHaveText('專家 2/3');
  const intern=await memberRow(session.page,fixture.intern.display_name);
  await expect(intern.locator('.guild-member-tier-intern')).toHaveText('實習成員');
  await intern.getByRole('button',{name:'設為正式成員',exact:true}).click();
  await expect(intern.locator('.guild-member-tier-full')).toHaveText('正式成員');
  await intern.getByRole('button',{name:'任命專家',exact:true}).click();
  await expect(intern.locator('.guild-member-expert')).toHaveText('公會專家');
  await expect(dialog.locator('.guild-expert-count')).toHaveText('專家 3/3');
  const extra=await memberRow(session.page,fixture.extra.display_name);
  await expect(extra.getByRole('button',{name:'任命專家',exact:true})).toBeDisabled();
  await expect(dialog.getByText(cap).first()).toBeVisible();
  for(const viewport of widths){
   await session.page.setViewportSize(viewport);
   await expect(dialog.locator('.guild-expert-count')).toHaveText('專家 3/3');
   await expect(extra.getByRole('button',{name:'任命專家',exact:true})).toBeDisabled();
   await expect(dialog.getByText(cap).first()).toBeVisible();
   await noOverflow(session.page);
  }
 }finally{await session.context.close();await cleanup(e2eAuthPool,fixture);}
});
