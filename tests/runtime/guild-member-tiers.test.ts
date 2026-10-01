import {test,before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readdir,readFile} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Pool} from 'pg';
import {createPool,LOCAL_DATABASE_URL,digest,transaction,type Command} from '../../packages/db/index.js';
import {migrate} from '../../scripts/database.js';
import {seedLocal,DEMO_USERS,DEMO_PASSWORD,DEMO_COMMUNITY} from '../../packages/testing/seed.js';
import {login,type Actor} from '../../modules/identity-membership/service.js';
import {Problem} from '../../packages/shared/problem.js';
import {changeGuildMembership,listGuilds} from '../../modules/positioning/service.js';
import {quickStartOnboarding} from '../../modules/positioning/onboarding.js';
import {sampleGuildAnswers} from '../../modules/positioning/guild-questions.js';
import {appointGuildMaster,type AdminActor,type AdminCommand} from '../../modules/platform-admin/service.js';
import {setGuildExpert} from '../../modules/platform-admin/guild-experts.js';
import {GUILD_FULL_MEMBER_REQUIRED,setGuildExpertByMaster,setMemberTier} from '../../modules/positioning/member-tier.js';
import {sendChannelMessage} from '../../modules/member-communications/channels.js';
import {cancelEvent,createEvent,reviewEventAsGuildMaster,setRsvp,updateEvent} from '../../modules/community/events.js';
import {activeDevelopmentGuilds} from '../../modules/development-access/guild-eligibility.js';
import {appointSkillMaintainer,skillEditor} from '../../modules/guild-workspace/service.js';
import {listMembers} from '../../modules/identity-membership/members.js';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const databaseUrl=process.env.TEST_DATABASE_URL??LOCAL_DATABASE_URL;
const schema=`fp_guild_tiers_${process.pid}_${Date.now()}`;
const database=createPool(databaseUrl),pool=new Pool({connectionString:databaseUrl,options:`-c search_path=${schema}`,max:8});
const guild='guild_event_space',ai='guild_ai_vibe',book='event-space';
const admin:AdminActor={admin_id:randomUUID(),community_id:DEMO_COMMUNITY,email:'tier-admin@example.invalid',display_name:'等級測試管理員',role:'super_admin',subject:'verified-tier-admin'};
let actors:Actor[]=[];
const code=(status:number,name:string)=>(error:unknown)=>{assert.ok(error instanceof Problem);assert.equal(error.status,status);assert.equal(error.code,name);return true;};
const cmd=(actor:Actor,operation:string,body:unknown={},expected?:string,key=randomUUID()):Command=>({actor,operation,key,body,...(expected===undefined?{}:{expected})});
const adm=(body:unknown,expected?:string,key=randomUUID()):AdminCommand=>({admin,operation:'admin-tier',key,body,...(expected===undefined?{}:{expected})});
before(async()=>{await database.query(`CREATE SCHEMA ${schema}`);await migrate(pool);});
after(async()=>{await pool.end();await database.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await database.end();});
beforeEach(async()=>{
 await pool.query('TRUNCATE communities,login_attempts,auth_rate_limits CASCADE');await seedLocal(pool);
 await pool.query('INSERT INTO platform_admins(admin_id,community_id,email,display_name) VALUES($1,$2,$3,$4)',[admin.admin_id,DEMO_COMMUNITY,admin.email,admin.display_name]);
 actors=await Promise.all(DEMO_USERS.map(async user=>(await login(pool,user.email,DEMO_PASSWORD)).actor));
});
async function tier(userId:string,key=guild){const row=(await pool.query('SELECT member_tier,aggregate_version::text,state FROM positioning_profession_memberships WHERE community_id=$1 AND user_id=$2 AND guild_key=$3',[DEMO_COMMUNITY,userId,key])).rows[0] as {member_tier:string;aggregate_version:string;state:string}|undefined;assert.ok(row);return row;}
async function notices(userId:string,kind:string){return (await pool.query('SELECT title,body FROM member_notifications WHERE community_id=$1 AND recipient_ref=$2 AND kind=$3 ORDER BY created_at',[DEMO_COMMUNITY,userId,kind])).rows as {title:string;body:string}[];}
async function extra(label:string){
 const id=randomUUID();
 await pool.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref) SELECT $1,$2,$3,$4,password_hash,$5 FROM users WHERE user_id=$6`,[id,DEMO_COMMUNITY,`${id}@tier-limit.invalid`,label,randomUUID(),actors[0].user_id]);
 return id;
}
const soon=(hours:number)=>new Date(Date.now()+hours*3600_000).toISOString();
const exchange=(guildKey:string)=>({title:'公會技能交流',description:'交流並做出一份可分享的練習。',starts_at:soon(24),ends_at:soon(26),mode:'online' as const,location:'線上教室',capacity:5,event_kind:'guild_skill_exchange' as const,topic:null,online_url:null,visibility:'guild' as const,guild_key:guildKey});

test('member joins and quick start are intern; an already-active join does not reset a full member',async()=>{
 const joined=await changeGuildMembership(pool,cmd(actors[1],'join'),guild,'join');
 assert.equal(joined.member_tier,'intern');assert.equal(String(joined.aggregate_version),'1');
 const own=(await listGuilds(pool,actors[1])).find(row=>row.guild_key===guild);
 assert.ok(own);assert.equal(own.membership.member_tier,'intern');assert.equal(own.membership.rank,'runner');
 await appointGuildMaster(pool,adm({user_id:actors[0].user_id,reason:'指定現任公會長。'}),guild);
 const promoted=await setMemberTier(pool,cmd(actors[0],'promote',{member_tier:'full'},'1'),guild,actors[1].user_id);
 assert.equal(promoted.changed,true);
 const again=await changeGuildMembership(pool,cmd(actors[1],'join-again'),guild,'join');
 assert.equal(again.member_tier,'full');assert.equal(String(again.aggregate_version),String(promoted.aggregate_version));
 await changeGuildMembership(pool,cmd(actors[1],'leave',{},String(promoted.aggregate_version)),guild,'leave');
 const rejoined=await changeGuildMembership(pool,cmd(actors[1],'rejoin',{},String(Number(promoted.aggregate_version)+1)),guild,'join');
 assert.equal(rejoined.member_tier,'intern');assert.equal(rejoined.state,'active');
 const fresh=await extra('快速開始會員');const freshActor=(await login(pool,`${fresh}@tier-limit.invalid`,DEMO_PASSWORD)).actor;
 await quickStartOnboarding(pool,cmd(freshActor,'quick',{guild_keys:[guild],primary_guild_key:guild,confirmed:true,guild_answers:sampleGuildAnswers(guild)}));
 assert.equal((await tier(fresh)).member_tier,'intern');
 const shown=async(actor:Actor)=>listMembers(pool,actor,10,0,{guild_key:guild,search:actors[1].display_name});
 const roster=(await shown(actors[0])).items[0] as {guild_roster?:{member_tier:string};member_tiers?:{guild_key:string;member_tier:string}[]};
 assert.ok(roster);assert.equal(roster.guild_roster?.member_tier,'intern');assert.equal(roster.member_tiers,undefined);
 const self=(await shown(actors[1])).items[0] as {member_tiers?:{guild_key:string;member_tier:string}[]};
 assert.equal(self.member_tiers?.find(row=>row.guild_key===guild)?.member_tier,'intern');
 const stranger=(await shown(actors[2])).items[0] as {guild_roster?:unknown;member_tiers?:unknown};
 assert.equal(stranger.guild_roster,undefined);assert.equal(stranger.member_tiers,undefined);
});

test('admin master and expert appointments make the member full; a master appointment records the master',async()=>{
 await changeGuildMembership(pool,cmd(actors[1],'join'),guild,'join');
 const mastered=await appointGuildMaster(pool,adm({user_id:actors[1].user_id,reason:'任命已加入的實習成員為會長。'}),guild);
 assert.equal(mastered.membership_joined,false);assert.equal((await tier(actors[1].user_id)).member_tier,'full');
 await changeGuildMembership(pool,cmd(actors[2],'join'),guild,'join');
 await changeGuildMembership(pool,cmd(actors[2],'leave',{},'1'),guild,'leave');
 const expert=await setGuildExpert(pool,adm({user_id:actors[2].user_id,active:true,reason:'管理員任命已離開的會員為專家。'}),guild);
 assert.equal(expert.membership_joined,true);assert.equal((await tier(actors[2].user_id)).member_tier,'full');assert.equal((await tier(actors[2].user_id)).aggregate_version,'3');
 const row=(await pool.query('SELECT appointed_by,appointed_by_user_id FROM positioning_guild_experts WHERE user_id=$1 AND guild_key=$2',[actors[2].user_id,guild])).rows[0];
 assert.equal(row.appointed_by,admin.admin_id);assert.equal(row.appointed_by_user_id,null);
 await setGuildExpert(pool,adm({user_id:actors[2].user_id,active:true,reason:'重寫同一任命不應再通知。'},'1'),guild);
 assert.equal((await notices(actors[2].user_id,'guild_expert_appointed')).length,1);
 await appointGuildMaster(pool,adm({user_id:actors[0].user_id,reason:'指定資安公會的現任公會長。'}),'guild_security');
 await changeGuildMembership(pool,cmd(actors[1],'join-space'),'guild_security','join');
 const appointed=await setGuildExpertByMaster(pool,cmd(actors[0],'appoint',{user_id:actors[1].user_id,active:true}),'guild_security');
 assert.equal(appointed.membership_joined,false);assert.equal((await tier(actors[1].user_id,'guild_security')).member_tier,'full');
 const masterRow=(await pool.query('SELECT appointed_by,appointed_by_user_id,active FROM positioning_guild_experts WHERE user_id=$1 AND guild_key=$2',[actors[1].user_id,'guild_security'])).rows[0];
 assert.equal(masterRow.appointed_by,null);assert.equal(masterRow.appointed_by_user_id,actors[0].user_id);assert.equal(masterRow.active,true);
});

test('an intern can chat and RSVP, and gains post and development rights only after promotion',async()=>{
 await appointGuildMaster(pool,adm({user_id:actors[0].user_id,reason:'指定活動公會會長。'}),guild);
 await appointGuildMaster(pool,adm({user_id:actors[0].user_id,reason:'指定 AI 公會會長。'}),ai);
 await changeGuildMembership(pool,cmd(actors[1],'join'),guild,'join');
 await changeGuildMembership(pool,cmd(actors[1],'join-ai'),ai,'join');
 await changeGuildMembership(pool,cmd(actors[2],'join'),guild,'join');
 await setMemberTier(pool,cmd(actors[0],'promote-organizer',{member_tier:'full'},'1'),guild,actors[2].user_id);
 const sent=await sendChannelMessage(pool,cmd(actors[1],'chat',{body:'實習成員可以在公會聊天室聊天。'}),'guild',guild);
 assert.equal(sent.body,'實習成員可以在公會聊天室聊天。');
 const created=await createEvent(pool,cmd(actors[2],'exchange',exchange(guild)));
 const published=await reviewEventAsGuildMaster(pool,cmd(actors[0],'review',{decision:'approve',reason:'符合公會活動安排。'},String(created.aggregate_version)),created.event_id);
 assert.equal(published.state,'published');
 assert.equal((await setRsvp(pool,cmd(actors[1],'rsvp',{going:true}),created.event_id)).my_rsvp,'going');
 const reading=await createEvent(pool,cmd(actors[1],'reading',{title:'實習讀書會',description:'閱讀並討論一章。',starts_at:soon(30),ends_at:soon(32),mode:'online',location:'線上教室',capacity:5,event_kind:'reading_group',topic:'協作',online_url:null,visibility:'workshop',guild_key:null}));
 assert.equal(reading.event_kind,'reading_group');
 await assert.rejects(createEvent(pool,cmd(actors[1],'blocked',exchange(guild))),(error:unknown)=>{assert.ok(code(403,'guild_full_member_required')(error));assert.equal((error as Problem).message,GUILD_FULL_MEMBER_REQUIRED);return true;});
 await appointSkillMaintainer(pool,adm({user_id:actors[1].user_id,active:true,reason:'指定技能書維護者。'}),book);
 await assert.rejects(skillEditor(pool,actors[1],book),code(403,'guild_full_member_required'));
 assert.deepEqual(await transaction(pool,q=>activeDevelopmentGuilds(q,actors[1],'skill')),[]);
 await changeGuildMembership(pool,cmd(actors[1],'leave-ai',{},'1'),ai,'leave');
 await assert.rejects(skillEditor(pool,actors[1],book),code(403,'skill_editor_guild_required'));
 await changeGuildMembership(pool,cmd(actors[1],'rejoin-ai',{},'2'),ai,'join');
 await assert.rejects(skillEditor(pool,actors[1],book),code(403,'guild_full_member_required'));
 await setMemberTier(pool,cmd(actors[0],'promote-ai',{member_tier:'full'},'3'),ai,actors[1].user_id);
 assert.deepEqual(await transaction(pool,q=>activeDevelopmentGuilds(q,actors[1],'skill')),[ai]);
 assert.equal((await skillEditor(pool,actors[1],book)).book_id,book);
 await setMemberTier(pool,cmd(actors[0],'promote-guild',{member_tier:'full'},'1'),guild,actors[1].user_id);
 const owned=await createEvent(pool,cmd(actors[1],'allowed',exchange(guild)));
 assert.equal(owned.event_kind,'guild_skill_exchange');
 await setMemberTier(pool,cmd(actors[0],'demote-after-post',{member_tier:'intern'},'2'),guild,actors[1].user_id);
 const edited={...exchange(guild),title:'改標題'};
 await assert.rejects(updateEvent(pool,cmd(actors[1],'edit-blocked',edited,String(owned.aggregate_version)),owned.event_id),code(403,'guild_full_member_required'));
 await assert.rejects(cancelEvent(pool,cmd(actors[1],'cancel-blocked',{},String(owned.aggregate_version)),owned.event_id),code(403,'guild_full_member_required'));
});

test('only the current master changes a tier, a real change notifies once, and the same tier is a no-op',async()=>{
 await appointGuildMaster(pool,adm({user_id:actors[0].user_id,reason:'指定現任公會長。'}),guild);
 await changeGuildMembership(pool,cmd(actors[1],'join'),guild,'join');
 await assert.rejects(setMemberTier(pool,cmd(actors[2],'outsider',{member_tier:'full'},'1'),guild,actors[1].user_id),code(403,'guild_leader_required'));
 await assert.rejects(setMemberTier(pool,cmd(actors[0],'self',{member_tier:'intern'},'1'),guild,actors[0].user_id),code(409,'guild_member_tier_self'));
 await assert.rejects(setMemberTier(pool,cmd(actors[0],'missing-member',{member_tier:'full'},'1'),guild,randomUUID()),code(404,'guild_member_not_found'));
 await changeGuildMembership(pool,cmd(actors[2],'join'),guild,'join');await changeGuildMembership(pool,cmd(actors[2],'leave',{},'1'),guild,'leave');
 await assert.rejects(setMemberTier(pool,cmd(actors[0],'left',{member_tier:'full'},'2'),guild,actors[2].user_id),code(404,'guild_member_not_found'));
 await assert.rejects(setMemberTier(pool,cmd(actors[0],'stale',{member_tier:'full'},'9'),guild,actors[1].user_id),code(412,'version_conflict'));
 assert.equal((await tier(actors[1].user_id)).member_tier,'intern');
 const same=await setMemberTier(pool,cmd(actors[0],'same',{member_tier:'intern'},'1'),guild,actors[1].user_id);
 assert.deepEqual(same,{user_id:actors[1].user_id,guild_key:guild,member_tier:'intern',aggregate_version:1,changed:false});
 assert.equal((await notices(actors[1].user_id,'guild_member_promoted')).length,0);assert.equal((await tier(actors[1].user_id)).aggregate_version,'1');
 const key=randomUUID();
 const promoted=await setMemberTier(pool,cmd(actors[0],'promote',{member_tier:'full'},'1',key),guild,actors[1].user_id);
 assert.equal(promoted.changed,true);assert.equal(promoted.aggregate_version,2);
 assert.deepEqual(await setMemberTier(pool,cmd(actors[0],'promote',{member_tier:'full'},'1',key),guild,actors[1].user_id),promoted);
 const promotedNotes=await notices(actors[1].user_id,'guild_member_promoted');
 assert.equal(promotedNotes.length,1);assert.equal(promotedNotes[0].title,'你已成為正式成員');assert.equal(promotedNotes[0].body,'你已成為「活動與空間公會」的正式成員，可以發布與編輯公會內容。');
 const repeat=await setMemberTier(pool,cmd(actors[0],'repeat',{member_tier:'full'},'2'),guild,actors[1].user_id);
 assert.equal(repeat.changed,false);assert.equal(repeat.aggregate_version,2);assert.equal((await notices(actors[1].user_id,'guild_member_promoted')).length,1);
 const demoted=await setMemberTier(pool,cmd(actors[0],'demote',{member_tier:'intern'},'2'),guild,actors[1].user_id);
 assert.equal(demoted.changed,true);assert.equal(demoted.aggregate_version,3);
 const demotedNotes=await notices(actors[1].user_id,'guild_member_demoted');
 assert.equal(demotedNotes.length,1);assert.equal(demotedNotes[0].title,'你已改為實習成員');assert.equal(demotedNotes[0].body,'你在「活動與空間公會」改為實習成員。');
 await setGuildExpertByMaster(pool,cmd(actors[0],'appoint',{user_id:actors[1].user_id,active:true}),guild);
 await assert.rejects(setMemberTier(pool,cmd(actors[0],'locked',{member_tier:'intern'},String((await tier(actors[1].user_id)).aggregate_version)),guild,actors[1].user_id),code(409,'guild_member_tier_locked'));
 assert.equal((await tier(actors[1].user_id)).member_tier,'full');
});

test('only the current master appoints experts, the cap includes admin seats, and leaving revokes the role',async()=>{
 await appointGuildMaster(pool,adm({user_id:actors[0].user_id,reason:'指定現任公會長。'}),guild);
 await assert.rejects(setGuildExpertByMaster(pool,cmd(actors[1],'outsider',{user_id:actors[2].user_id,active:true}),guild),code(403,'guild_leader_required'));
 await assert.rejects(setGuildExpertByMaster(pool,cmd(actors[0],'self',{user_id:actors[0].user_id,active:true}),guild),code(409,'guild_expert_self'));
 assert.equal((await pool.query('SELECT count(*)::int AS n FROM positioning_guild_experts')).rows[0].n,0);
 for(const userId of [actors[1].user_id,actors[2].user_id,await extra('第三位專家')])await setGuildExpert(pool,adm({user_id:userId,active:true,reason:'管理員先占一個專家名額。'}),guild);
 const fourth=await extra('第四位專家');
 await assert.rejects(setGuildExpertByMaster(pool,cmd(actors[0],'over-cap',{user_id:fourth,active:true}),guild),code(409,'guild_expert_limit_reached'));
 assert.equal((await pool.query('SELECT 1 FROM positioning_profession_memberships WHERE community_id=$1 AND user_id=$2 AND guild_key=$3',[DEMO_COMMUNITY,fourth,guild])).rowCount,0);
 await changeGuildMembership(pool,cmd(actors[1],'leave',{},(await tier(actors[1].user_id)).aggregate_version),guild,'leave');
 const revoked=(await pool.query('SELECT active,aggregate_version::text FROM positioning_guild_experts WHERE user_id=$1 AND guild_key=$2',[actors[1].user_id,guild])).rows[0];
 assert.equal(revoked.active,false);assert.equal(revoked.aggregate_version,'2');
});

test('a membership created before migration 066 stays full and a membership created after defaults to intern',async()=>{
 const backfill=`fp_guild_tier_backfill_${process.pid}_${Date.now()}`;
 const adminPool=createPool(databaseUrl),back=new Pool({connectionString:databaseUrl,options:`-c search_path=${backfill}`,max:2});
 try{
  await adminPool.query(`CREATE SCHEMA ${backfill}`);
  await back.query('CREATE TABLE schema_migrations (name text PRIMARY KEY,sha256 text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())');
  for(const name of (await readdir(resolve(root,'migrations'))).filter(file=>file.endsWith('.sql')&&file!=='066_guild_member_tiers.sql').sort()){
   const sql=await readFile(resolve(root,'migrations',name),'utf8');
   await back.query(sql);await back.query('INSERT INTO schema_migrations(name,sha256) VALUES($1,$2)',[name,digest(sql)]);
  }
  await seedLocal(back);
  const priorId=randomUUID();
  await back.query(`INSERT INTO positioning_profession_memberships(membership_id,community_id,user_id,guild_key,state) VALUES($1,$2,$3,'guild_talent_direction','active')`,[priorId,DEMO_COMMUNITY,DEMO_USERS[0].user_id]);
  await migrate(back);
  assert.equal((await back.query('SELECT member_tier FROM positioning_profession_memberships WHERE membership_id=$1',[priorId])).rows[0].member_tier,'full');
  assert.equal((await back.query(`INSERT INTO positioning_profession_memberships(membership_id,community_id,user_id,guild_key,state) VALUES($1,$2,$3,'guild_marketing','active') RETURNING member_tier`,[randomUUID(),DEMO_COMMUNITY,DEMO_USERS[1].user_id])).rows[0].member_tier,'intern');
 }finally{await back.end();await adminPool.query(`DROP SCHEMA IF EXISTS ${backfill} CASCADE`);await adminPool.end();}
});
