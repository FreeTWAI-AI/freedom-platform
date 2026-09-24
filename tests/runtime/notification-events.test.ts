import {test,before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {createPool,LOCAL_DATABASE_URL,type Command} from '../../packages/db/index.js';
import {migrate} from '../../scripts/database.js';
import {seedLocal,DEMO_USERS,DEMO_PASSWORD,DEMO_COMMUNITY} from '../../packages/testing/seed.js';
import {login,type Actor} from '../../modules/identity-membership/service.js';
import {changeFriendship} from '../../modules/identity-membership/members.js';
import {communityCatalog} from '../../modules/community/catalog.js';
import {authenticateAdmin,reviewGuildApplication,appointGuildMaster,type AdminActor,type AdminCommand} from '../../modules/platform-admin/service.js';
import {setGuildExpert} from '../../modules/platform-admin/guild-experts.js';
import {linkNominatedMember} from '../../modules/platform-admin/leadership.js';

const databaseUrl=process.env.TEST_DATABASE_URL??LOCAL_DATABASE_URL,schema=`fp_notification_events_${process.pid}_${Date.now()}`;
const database=createPool(databaseUrl),pool=new Pool({connectionString:databaseUrl,options:`-c search_path=${schema}`,max:12});
const adminEmail='events-admin@example.invalid',adminId=randomUUID(),guild='guild_event_space';
const [A,B,C]=DEMO_USERS.map(user=>user.user_id);
let admin:AdminActor,actors:Actor[];
before(async()=>{await database.query(`CREATE SCHEMA ${schema}`);await migrate(pool);});
after(async()=>{await pool.end();await database.query(`DROP SCHEMA ${schema} CASCADE`);await database.end();});
beforeEach(async()=>{
  await pool.query('TRUNCATE communities,login_attempts,auth_rate_limits CASCADE');await pool.query("DELETE FROM positioning_guild_catalog WHERE guild_key LIKE 'guild_custom_%'");
  await seedLocal(pool);
  await pool.query("INSERT INTO platform_admins(admin_id,community_id,email,display_name) VALUES($1,$2,$3,'合成管理員')",[adminId,DEMO_COMMUNITY,adminEmail]);
  admin=await authenticateAdmin(pool,{email:adminEmail,subject:'verified-events-admin',csrfToken:'test-only'});
  actors=(await Promise.all(DEMO_USERS.map(user=>login(pool,user.email,DEMO_PASSWORD)))).map(value=>value.actor);
});
type Row={recipient_ref:string;kind:string;title:string;body:string;action_tab:string|null;action_resource_id:string|null;source_key:string};
const notices=async(where='true',values:unknown[]=[]):Promise<Row[]>=>(await pool.query(`SELECT * FROM member_notifications WHERE ${where} ORDER BY created_at,notification_id`,values)).rows;
const kinds=async()=>(await notices()).map(n=>`${n.recipient_ref}:${n.kind}`);
const member=(actor:Actor,operation='friend',expected?:string|number,key=randomUUID()):Command=>({actor,operation,key,body:{},...(expected===undefined?{}:{expected:String(expected)})});
const adminInput=(operation:string,body:unknown,expected?:string|number,key=randomUUID()):AdminCommand=>({admin,operation,key,body,...(expected===undefined?{}:{expected:String(expected)})});
const noPrivate=(rows:Row[])=>{for(const row of rows){const text=`${row.title}${row.body}`;for(const needle of ['@','admin','token','合成管理員'])assert.ok(!text.includes(needle),`${needle} in ${text}`);}};
async function failOn(table:string,condition:string){
  // Local fixture only: a test-schema trigger forces a failure late in the
  // command transaction, after the domain write and the notification insert.
  await pool.query(`CREATE OR REPLACE FUNCTION fail_for_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF ${condition} THEN RAISE EXCEPTION 'forced test failure'; END IF; RETURN NEW; END $$`);
  await pool.query(`CREATE TRIGGER fail_for_test BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION fail_for_test()`);
  return async()=>{await pool.query(`DROP TRIGGER fail_for_test ON ${table}`);await pool.query('DROP FUNCTION fail_for_test()');};
}

test('friend request, accept, decline and cancel notify the correct member once; no-ops and replays are silent',async()=>{
  const [a,b]=actors,key=randomUUID();
  const requested=await changeFriendship(pool,member(a,'friend',undefined,key),B,'request');
  assert.equal((await changeFriendship(pool,member(a,'friend',undefined,key),B,'request')).aggregate_version,requested.aggregate_version);
  await changeFriendship(pool,member(a),B,'request');await changeFriendship(pool,member(b),A,'request');
  let rows=await notices();assert.equal(rows.length,1);
  assert.deepEqual({...rows[0],source_key:undefined},{...rows[0],source_key:undefined,recipient_ref:B,kind:'friend_request',action_tab:'members',action_resource_id:A});
  assert.equal(rows[0].body,`${DEMO_USERS[0].display_name} 想加你為好友。`);
  const accepted=await changeFriendship(pool,member(b,'accept',requested.aggregate_version),A.toUpperCase(),'accept');
  rows=await notices();assert.deepEqual(rows.map(n=>[n.recipient_ref,n.kind,n.action_resource_id]),[[B,'friend_request',A],[A,'friend_accepted',B]]);
  // Removing an accepted friend is not a decline.
  const removed=await changeFriendship(pool,member(b,'remove',accepted.aggregate_version),A,'remove');assert.equal((await notices()).length,2);
  // Requester cancelling their own pending request is silent.
  const again=await changeFriendship(pool,member(a,'friend',removed.aggregate_version),B,'request');assert.equal(again.aggregate_version,String(Number(removed.aggregate_version)+1));
  const cancelled=await changeFriendship(pool,member(a,'cancel',again.aggregate_version),B,'remove');
  assert.deepEqual(await kinds(),[`${B}:friend_request`,`${A}:friend_accepted`,`${B}:friend_request`]);
  // The invitee removing a pending request declines it: only the requester hears.
  const renewed=await changeFriendship(pool,member(b,'friend',cancelled.aggregate_version),A,'request');
  const declined=await changeFriendship(pool,member(a,'decline',renewed.aggregate_version),B,'remove');
  assert.deepEqual((await kinds()).slice(3),[`${A}:friend_request`,`${B}:friend_declined`]);
  await changeFriendship(pool,member(a,'noop-remove',declined.aggregate_version),B,'remove');
  rows=await notices();assert.equal(rows.length,5);assert.equal(new Set(rows.map(n=>n.source_key)).size,5);noPrivate(rows);
  assert.equal(await pool.query('SELECT 1 FROM member_notifications WHERE recipient_ref=$1',[C]).then(r=>r.rowCount),0);
});

test('a failure late in the friendship transaction rolls back both the friendship and its notification',async()=>{
  const restore=await failOn('command_receipts',"NEW.operation='friend-fail'");
  try{await assert.rejects(changeFriendship(pool,member(actors[0],'friend-fail'),B,'request'),/forced test failure/);}
  finally{await restore();}
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM member_friendships')).rows[0].n,0);assert.equal((await notices()).length,0);
  await changeFriendship(pool,member(actors[0],'friend-fail'),B,'request');assert.equal((await notices()).length,1);
});

async function application(user=A){const id=randomUUID();await pool.query('INSERT INTO guild_creation_applications(application_id,community_id,user_id,name,profession,reason) VALUES($1,$2,$3,$4,$5,$6)',[id,DEMO_COMMUNITY,user,'研究與協作公會','研究','把共同研究的方法整理清楚。']);return id;}
const approval={decision:'approve',reason:'已確認公會目標與第一步。',guild:{name:'研究與協作公會',purpose:'整理公開研究的方法與範例。',first_step:'提出第一份可以共同重現的研究。',module_key:'guilds',skill_book_ids:[communityCatalog.skill_books[0].id]}};

test('guild application approval and rejection notify only the applicant with the decision and reason',async()=>{
  const approvedId=await application(),key=randomUUID();
  const approved=await reviewGuildApplication(pool,adminInput('review',approval,1,key),approvedId);
  await reviewGuildApplication(pool,adminInput('review',approval,1,key),approvedId);
  let rows=await notices();assert.equal(rows.length,1);
  assert.equal(rows[0].recipient_ref,A);assert.equal(rows[0].kind,'guild_application_approved');assert.equal(rows[0].action_tab,'guilds');assert.equal(rows[0].action_resource_id,approved.approved_guild_key);
  assert.match(rows[0].body,/研究與協作公會/);assert.match(rows[0].body,/已確認公會目標與第一步。/);assert.equal(rows[0].source_key,`guild-application/${approvedId}/2`);
  const rejectedId=await application(B);
  await reviewGuildApplication(pool,adminInput('review',{decision:'reject',reason:'目前已有相近公會，請先加入。'},1),rejectedId);
  rows=await notices('recipient_ref=$1',[B]);assert.equal(rows.length,1);
  assert.equal(rows[0].kind,'guild_application_rejected');assert.equal(rows[0].action_tab,'guilds');assert.equal(rows[0].action_resource_id,null);assert.match(rows[0].body,/目前已有相近公會/);
  assert.equal((await notices()).length,2);noPrivate(await notices());
});

test('a forced audit failure rolls back the review, the new guild and the applicant notification together',async()=>{
  const id=await application(),restore=await failOn('platform_admin_audit',"NEW.action='guild_application_review'");
  try{await assert.rejects(reviewGuildApplication(pool,adminInput('review',approval,1),id),/forced test failure/);}
  finally{await restore();}
  assert.equal((await pool.query('SELECT state FROM guild_creation_applications WHERE application_id=$1',[id])).rows[0].state,'pending');
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM positioning_guild_catalog WHERE guild_key LIKE 'guild_custom_%'")).rows[0].n,0);
  assert.equal((await notices()).length,0);
});

test('guild expert notifications follow real inactive/active changes only',async()=>{
  const body=(active:boolean,user=A)=>({user_id:user,active,reason:'合成測試：依管理員確認任命。'}),key=randomUUID();
  const appointed=await setGuildExpert(pool,adminInput(`experts/${guild}`,body(true),undefined,key),guild);
  await setGuildExpert(pool,adminInput(`experts/${guild}`,body(true),undefined,key),guild);
  const rewritten=await setGuildExpert(pool,adminInput(`experts/${guild}`,body(true),appointed.aggregate_version),guild);assert.equal(rewritten.aggregate_version,2);
  assert.deepEqual(await kinds(),[`${A}:guild_expert_appointed`]);
  const revoked=await setGuildExpert(pool,adminInput(`experts/${guild}`,body(false),rewritten.aggregate_version),guild);
  await setGuildExpert(pool,adminInput(`experts/${guild}`,body(false),revoked.aggregate_version),guild);
  assert.deepEqual(await kinds(),[`${A}:guild_expert_appointed`,`${A}:guild_expert_revoked`]);
  const rows=await notices();assert.ok(rows.every(n=>n.action_tab==='guilds'&&n.action_resource_id===guild));
  assert.deepEqual(rows.map(n=>n.source_key),[`guild-expert/${guild}/${A}/1`,`guild-expert/${guild}/${A}/3`]);noPrivate(rows);
});

test('guild master appointment notifies the new holder and the replaced one; reappointing the same person is silent',async()=>{
  const body=(user:string)=>({user_id:user,reason:'合成測試：確認公會長任命。'}),key=randomUUID();
  const first=await appointGuildMaster(pool,adminInput(`master/${guild}`,body(A),undefined,key),guild);
  await appointGuildMaster(pool,adminInput(`master/${guild}`,body(A),undefined,key),guild);
  assert.deepEqual(await kinds(),[`${A}:guild_master_appointed`]);
  const same=await appointGuildMaster(pool,adminInput(`master/${guild}`,body(A.toUpperCase()),first.aggregate_version),guild);
  assert.equal((await notices()).length,1);
  // Uppercase input still compares against the canonical database UUID.
  await appointGuildMaster(pool,adminInput(`master/${guild}`,body(B.toUpperCase()),same.aggregate_version),guild);
  // Both notifications share one transaction timestamp, so compare as a set.
  const rows=await notices();assert.deepEqual(rows.map(n=>`${n.recipient_ref}:${n.kind}:${n.action_tab}`).sort(),[`${A}:guild_master_appointed:guild-workspace`,`${A}:guild_master_revoked:guilds`,`${B}:guild_master_appointed:guild-workspace`]);
  assert.ok(rows.every(n=>n.action_resource_id===guild));noPrivate(rows);
});

test('nominated guild master linking notifies once per newly inserted officer seat only',async()=>{
  await pool.query('UPDATE users SET email=$2 WHERE user_id=$1',[A,adminEmail]);const linked=(await login(pool,adminEmail,DEMO_PASSWORD)).actor;
  const fresh='guild_platform_engineering',existing='guild_security';
  for(const key of [fresh,existing])await pool.query('INSERT INTO guild_leadership_nominations(community_id,guild_key,admin_id) VALUES($1,$2,$3)',[DEMO_COMMUNITY,key,adminId]);
  await pool.query('INSERT INTO positioning_guild_officers(community_id,guild_key,user_id) VALUES($1,$2,$3)',[DEMO_COMMUNITY,existing,A]);
  const key=randomUUID(),result=await linkNominatedMember(pool,adminInput('link',{},undefined,key),linked);
  assert.deepEqual(result.activated_guilds.map(g=>g.guild_key).sort(),[fresh,existing].sort());
  await linkNominatedMember(pool,adminInput('link',{},undefined,key),linked);await linkNominatedMember(pool,adminInput('link',{}),linked);
  const rows=await notices();assert.deepEqual(rows.map(n=>`${n.recipient_ref}:${n.kind}:${n.action_resource_id}`),[`${A}:guild_master_appointed:${fresh}`]);
  const officer=(await pool.query('SELECT aggregate_version FROM positioning_guild_officers WHERE guild_key=$1',[fresh])).rows[0];
  assert.equal(rows[0].source_key,`guild-master/${fresh}/${officer.aggregate_version}/appointed`);noPrivate(rows);
  // The pre-existing seat and every other member stay silent.
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM member_notifications WHERE recipient_ref<>$1",[A])).rows[0].n,0);
});
