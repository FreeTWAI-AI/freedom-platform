import {test,before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {createLocalJWKSet,exportJWK,generateKeyPair,SignJWT} from 'jose';
import {createApp} from '../../apps/platform-api/src/app.js';
import {createAdminAccessVerifier} from '../../modules/platform-admin/access.js';
import {createPool,LOCAL_DATABASE_URL,type Command} from '../../packages/db/index.js';
import {migrate} from '../../scripts/database.js';
import {seedLocal,DEMO_USERS,DEMO_PASSWORD,DEMO_COMMUNITY} from '../../packages/testing/seed.js';
import {login,type Actor} from '../../modules/identity-membership/service.js';
import {changeGuildMembership} from '../../modules/positioning/service.js';
import {setGuildExpert} from '../../modules/platform-admin/guild-experts.js';
import {authenticateAdmin,type AdminActor,type AdminCommand} from '../../modules/platform-admin/service.js';
import {guildWorkspace,createGuildAnnouncement,listGuildCouncil,skillEditor} from '../../modules/guild-workspace/service.js';

const databaseUrl=process.env.TEST_DATABASE_URL??LOCAL_DATABASE_URL,schema=`fp_guild_experts_${process.pid}_${Date.now()}`;
const database=createPool(databaseUrl),pool=new Pool({connectionString:databaseUrl,options:`-c search_path=${schema}`,max:12});
const origin='http://127.0.0.1:4310',issuer='https://expert-test.cloudflareaccess.com',audience='expert-route-tests';
const pair=await generateKeyPair('RS256'),jwk=await exportJWK(pair.publicKey);
const verifier=createAdminAccessVerifier({issuer,audience,csrfSecret:'expert-route-test-secret-123456789',keySet:createLocalJWKSet({keys:[{...jwk,kid:'expert-test',alg:'RS256'}]})});
const app=createApp(pool,origin,'local',{adminVerifier:verifier});let adminJwt='',adminCsrf='',memberTokens:string[]=[];
const guild='guild_event_space',otherGuild='guild_projection_mapping',adminId=randomUUID();let admin:AdminActor,actors:Actor[];
before(async()=>{await database.query(`CREATE SCHEMA ${schema}`);await migrate(pool);});
after(async()=>{await pool.end();await database.query(`DROP SCHEMA ${schema} CASCADE`);await database.end();});
beforeEach(async()=>{
 await pool.query('TRUNCATE communities,login_attempts,auth_rate_limits CASCADE');await seedLocal(pool);
 await pool.query("INSERT INTO platform_admins(admin_id,community_id,email,display_name) VALUES($1,$2,'expert-admin@example.invalid','合成管理員')",[adminId,DEMO_COMMUNITY]);
 admin=await authenticateAdmin(pool,{email:'expert-admin@example.invalid',subject:'verified-expert-admin',csrfToken:'test-only'});
 const logins=await Promise.all(DEMO_USERS.map(user=>login(pool,user.email,DEMO_PASSWORD)));actors=logins.map(value=>value.actor);memberTokens=logins.map(value=>value.token);
 adminJwt=await signAdmin(admin.email);adminCsrf=(await verifier(new Request(origin,{headers:{'Cf-Access-Jwt-Assertion':adminJwt}}))).csrfToken;
});
const denied=(status:number)=>(error:any)=>error.status===status;
function input(userId=actors[0].user_id,active=true,expected?:number,key=randomUUID(),guildKey=guild):AdminCommand{
 return {admin,operation:`guilds/${guildKey}/experts`,key,body:{user_id:userId,active,reason:'合成測試：依管理員確認任命。'},...(expected===undefined?{}:{expected:String(expected)})};
}
function memberCommand(actor:Actor,operation:string,expected?:number):Command{return {actor,operation,key:randomUUID(),body:{},...(expected===undefined?{}:{expected:String(expected)})};}
async function expert(userId=actors[0].user_id,key=guild){return (await pool.query('SELECT * FROM positioning_guild_experts WHERE community_id=$1 AND guild_key=$2 AND user_id=$3',[DEMO_COMMUNITY,key,userId])).rows[0];}
async function membership(userId=actors[0].user_id,key=guild){return (await pool.query('SELECT * FROM positioning_profession_memberships WHERE community_id=$1 AND guild_key=$2 AND user_id=$3',[DEMO_COMMUNITY,key,userId])).rows[0];}
async function count(table:string,where='true',values:unknown[]=[]){return (await pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`,values)).rows[0].n;}

test('a guild supports multiple experts, autojoins nonmembers and grants books without completing onboarding or replacing the primary guild',async()=>{
 await changeGuildMembership(pool,memberCommand(actors[0],'join-other'),otherGuild,'join');
 await pool.query('INSERT INTO guild_member_preferences(community_id,user_id,primary_guild_key) VALUES($1,$2,$3)',[DEMO_COMMUNITY,actors[0].user_id,otherGuild]);
 await pool.query('UPDATE users SET onboarding_required=true,onboarding_completed_at=NULL WHERE user_id=$1',[actors[0].user_id]);
 const first=await setGuildExpert(pool,input(),guild),second=await setGuildExpert(pool,input(actors[1].user_id),guild);
 for(const result of [first,second]){assert.equal(result.active,true);assert.equal(result.aggregate_version,1);assert.equal(result.membership_joined,true);assert.equal((await membership(result.user_id)).state,'active');assert.equal(await count('member_skill_book_grants','user_id=$1 AND guild_key=$2 AND book_id=$3',[result.user_id,guild,'event-space']),1);}
 assert.equal(await count('positioning_guild_experts','guild_key=$1 AND active',[guild]),2);
 assert.equal((await pool.query('SELECT primary_guild_key FROM guild_member_preferences WHERE user_id=$1',[actors[0].user_id])).rows[0].primary_guild_key,otherGuild);
 const user=(await pool.query('SELECT onboarding_required,onboarding_completed_at FROM users WHERE user_id=$1',[actors[0].user_id])).rows[0];assert.equal(user.onboarding_required,true);assert.equal(user.onboarding_completed_at,null);
 assert.equal(await count('onboarding_assessments'),0);assert.equal(await count('platform_admin_audit',"action='appoint_guild_expert'"),2);
});

test('existing membership is reused, left membership is reactivated and book grants do not duplicate',async()=>{
 const joined=await changeGuildMembership(pool,memberCommand(actors[0],'join'),guild,'join');
 const result=await setGuildExpert(pool,input(),guild);assert.equal(result.membership_joined,false);assert.equal((await membership()).membership_id,joined.membership_id);
 const left=await changeGuildMembership(pool,memberCommand(actors[1],'join'),guild,'join');await changeGuildMembership(pool,memberCommand(actors[1],'leave',Number(left.aggregate_version)),guild,'leave');
 const reactivated=await setGuildExpert(pool,input(actors[1].user_id),guild);assert.equal(reactivated.membership_joined,true);assert.equal((await membership(actors[1].user_id)).membership_id,left.membership_id);assert.equal((await membership(actors[1].user_id)).aggregate_version,'3');
 await setGuildExpert(pool,input(actors[0].user_id,true,1),guild);assert.equal(await count('member_skill_book_grants','user_id=$1 AND guild_key=$2',[actors[0].user_id,guild]),1);
});

test('revocation and reappointment retain monotonic versions and reject missing or stale If-Match before joining',async()=>{
 await assert.rejects(setGuildExpert(pool,input(actors[0].user_id,true,1),guild),denied(412));assert.equal(await membership(),undefined);
 await assert.rejects(setGuildExpert(pool,input(actors[0].user_id,false),guild),denied(404));
 const created=await setGuildExpert(pool,input(),guild);assert.equal(created.aggregate_version,1);
 await assert.rejects(setGuildExpert(pool,input(actors[0].user_id,false),guild),denied(428));
 const removed=await setGuildExpert(pool,input(actors[0].user_id,false,1),guild);assert.equal(removed.aggregate_version,2);assert.equal(removed.active,false);assert.equal(removed.membership_joined,false);assert.equal((await membership()).state,'active');
 await assert.rejects(setGuildExpert(pool,input(actors[0].user_id,true,1),guild),denied(412));
 const appointed=await setGuildExpert(pool,input(actors[0].user_id,true,2),guild);assert.equal(appointed.aggregate_version,3);assert.equal(appointed.active,true);assert.equal(await count('positioning_guild_experts'),1);
 const record=await expert();assert.equal(record.appointed_by,adminId);assert.ok(record.appointed_at instanceof Date);
});

test('leaving atomically deactivates the role; ordinary rejoin and stale appointment retries never restore it',async()=>{
 const command=input(),first=await setGuildExpert(pool,command,guild),joined=await membership();
 await changeGuildMembership(pool,memberCommand(actors[0],'leave',Number(joined.aggregate_version)),guild,'leave');let row=await expert();assert.equal(row.active,false);assert.equal(row.aggregate_version,'2');
 assert.deepEqual(await setGuildExpert(pool,command,guild),first);assert.equal((await membership()).state,'left');assert.equal((await expert()).active,false);
 await assert.rejects(setGuildExpert(pool,input(actors[0].user_id,true,1),guild),denied(412));assert.equal((await membership()).state,'left');
 const left=await membership();await changeGuildMembership(pool,memberCommand(actors[0],'rejoin',Number(left.aggregate_version)),guild,'join');row=await expert();assert.equal(row.active,false);assert.equal(row.aggregate_version,'2');
 const reappointed=await setGuildExpert(pool,input(actors[0].user_id,true,2),guild);assert.equal(reappointed.aggregate_version,3);assert.equal(reappointed.membership_joined,false);
 // Repeated writes of the left state do not manufacture additional revisions.
 await pool.query("UPDATE positioning_profession_memberships SET state='left' WHERE user_id=$1 AND guild_key=$2",[actors[0].user_id,guild]);await pool.query("UPDATE positioning_profession_memberships SET state='left' WHERE user_id=$1 AND guild_key=$2",[actors[0].user_id,guild]);assert.equal((await expert()).aggregate_version,'4');
});

test('idempotent commands do not duplicate membership, books, role or audit; replay checks current admin and appointee authority',async()=>{
 const command=input();const [one,two]=await Promise.all([setGuildExpert(pool,command,guild),setGuildExpert(pool,command,guild)]);assert.deepEqual(one,two);assert.equal(await count('positioning_guild_experts'),1);assert.equal(await count('platform_admin_audit',"action='appoint_guild_expert'"),1);assert.equal(await count('member_skill_book_grants'),1);
 await assert.rejects(setGuildExpert(pool,{...command,body:{...(command.body as any),reason:'換了一個任命原因'}},guild),denied(409));
 await pool.query('UPDATE users SET active=false WHERE user_id=$1',[actors[0].user_id]);await assert.rejects(setGuildExpert(pool,command,guild),denied(422));
 // Removal remains available for an inactive member, without reactivating them.
 const removed=await setGuildExpert(pool,input(actors[0].user_id,false,1),guild);assert.equal(removed.active,false);
 await pool.query('UPDATE users SET active=true WHERE user_id=$1',[actors[0].user_id]);await pool.query('UPDATE platform_admins SET active=false WHERE admin_id=$1',[adminId]);await assert.rejects(setGuildExpert(pool,command,guild),denied(403));
});

test('unknown guild, inactive user and foreign community cannot be appointed or mutate another role',async()=>{
 await assert.rejects(setGuildExpert(pool,input(), 'guild_missing'),denied(404));
 await pool.query('UPDATE users SET active=false WHERE user_id=$1',[actors[1].user_id]);await assert.rejects(setGuildExpert(pool,input(actors[1].user_id),guild),denied(422));assert.equal(await membership(actors[1].user_id),undefined);
 const foreignCommunity=randomUUID(),foreignId=randomUUID();await pool.query('INSERT INTO communities VALUES($1,$2)',[foreignCommunity,'Other']);await pool.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref) SELECT $1,$2,'foreign-expert@example.invalid','外部',password_hash,$3 FROM users WHERE user_id=$4`,[foreignId,foreignCommunity,randomUUID(),actors[0].user_id]);
 await assert.rejects(setGuildExpert(pool,input(foreignId),guild),denied(422));await assert.rejects(setGuildExpert(pool,input(foreignId,false),guild),denied(422));assert.equal(await count('positioning_guild_experts'),0);assert.equal(await count('platform_admin_audit'),0);
});

test('simultaneous edits serialize per member and one stale version cannot overwrite the successful change',async()=>{
 await setGuildExpert(pool,input(),guild);
 const results=await Promise.allSettled([setGuildExpert(pool,input(actors[0].user_id,false,1),guild),setGuildExpert(pool,input(actors[0].user_id,true,1),guild)]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);const failed=results.find(r=>r.status==='rejected') as PromiseRejectedResult;assert.equal(failed.reason.status,412);assert.equal((await expert()).aggregate_version,'2');
});

test('expert badges grant no admin, council, announcement or skill editorial rights; the same member can separately be master',async()=>{
 await setGuildExpert(pool,input(),guild);const actor=actors[0];assert.deepEqual(await guildWorkspace(pool,actor),{managed_guilds:[],managed_books:[],can_discuss:false});
 await assert.rejects(authenticateAdmin(pool,{email:actor.email,subject:'verified-member',csrfToken:'test-only'}),denied(403));await assert.rejects(listGuildCouncil(pool,actor),denied(403));await assert.rejects(skillEditor(pool,actor,'event-space'),denied(403));
 await assert.rejects(createGuildAnnouncement(pool,{...memberCommand(actor,'announcement'),body:{title:'不應發布',body:'專家不代表會長。',state:'published'}},guild),denied(403));
 await pool.query('INSERT INTO positioning_guild_officers(community_id,guild_key,user_id) VALUES($1,$2,$3)',[DEMO_COMMUNITY,guild,actor.user_id]);assert.equal((await guildWorkspace(pool,actor)).can_discuss,true);assert.equal((await expert()).active,true);
 await setGuildExpert(pool,input(actor.user_id,false,1),guild);assert.equal((await guildWorkspace(pool,actor)).can_discuss,true);assert.equal(await count('positioning_guild_officers'),1);
});


async function signAdmin(email:string){const now=Math.floor(Date.now()/1000);return new SignJWT({type:'app',email,sub:'verified-route-admin',iss:issuer,aud:audience,iat:now,nbf:now,exp:now+600}).setProtectedHeader({alg:'RS256',kid:'expert-test'}).sign(pair.privateKey);}
async function adminHttp(path:string,body?:unknown,options:{version?:number;key?:string;headers?:Record<string,string>}={}){
 const headers:Record<string,string>={Origin:origin,'Cf-Access-Jwt-Assertion':adminJwt,'X-Admin-CSRF':adminCsrf,...options.headers};
 if(body!==undefined){headers['Content-Type']='application/json';headers['Idempotency-Key']=options.key??randomUUID();if(options.version!==undefined)headers['If-Match']=`"${options.version}"`;}
 const response=await app.request(origin+'/admin/api'+path,{method:body===undefined?'GET':'POST',headers,body:body===undefined?undefined:JSON.stringify(body)});return {status:response.status,data:await response.json() as any,response};
}
async function publicGuild(){const response=await app.request(origin+'/api/v1/guilds/directory',{headers:{Cookie:'freedom_local_session='+memberTokens[2]}});assert.equal(response.status,200);const data=await response.json() as any;return data.items.find((row:any)=>row.guild_key===guild);}
const expertBody=(userId:string,active=true)=>({user_id:userId,active,reason:'測試正式 HTTP 任命公會專家。'});

test('the expert HTTP route requires verified administration and CSRF, returns exact DTO and ETag, and enforces If-Match',async()=>{
 const path='/guilds/'+guild+'/experts',body=expertBody(actors[0].user_id);
 assert.equal((await adminHttp(path,body,{headers:{'Cf-Access-Jwt-Assertion':'','Cf-Access-Authenticated-User-Email':admin.email}})).status,401);
 assert.equal((await adminHttp(path,body,{headers:{'Cf-Access-Jwt-Assertion':'',Cookie:'freedom_local_session='+memberTokens[0]}})).status,401);
 assert.equal((await adminHttp(path,body,{headers:{'Cf-Access-Jwt-Assertion':await signAdmin(actors[0].email)}})).status,403);
 assert.equal((await adminHttp(path,body,{headers:{'X-Admin-CSRF':''}})).status,403);
 assert.equal(await count('positioning_guild_experts'),0);assert.equal(await membership(),undefined);
 const key=randomUUID(),created=await adminHttp(path,body,{key});assert.equal(created.status,200,JSON.stringify(created.data));assert.equal(created.response.headers.get('ETag'),'"1"');
 assert.deepEqual(created.data,{guild_key:guild,user_id:actors[0].user_id,active:true,aggregate_version:1,membership_joined:true});assert.deepEqual((await adminHttp(path,body,{key})).data,created.data);
 assert.equal((await adminHttp(path,expertBody(actors[0].user_id,false))).status,428);assert.equal((await adminHttp(path,expertBody(actors[0].user_id,false),{version:2})).status,412);
 const removed=await adminHttp(path,expertBody(actors[0].user_id,false),{version:1});assert.equal(removed.status,200);assert.equal(removed.response.headers.get('ETag'),'"2"');assert.deepEqual(removed.data,{guild_key:guild,user_id:actors[0].user_id,active:false,aggregate_version:2,membership_joined:false});
});

test('guild directory projects only public identity for active experts with current active membership, excluding removed, left, disabled and foreign records',async()=>{
 await setGuildExpert(pool,input(actors[0].user_id),guild);await setGuildExpert(pool,input(actors[1].user_id),guild);
 let shown=await publicGuild();assert.equal(shown.guild_experts.length,2);for(const row of shown.guild_experts)assert.deepEqual(Object.keys(row).sort(),['avatar_url','display_name','user_id']);
 const foreignCommunity=randomUUID(),foreignUser=randomUUID(),foreignAdmin=randomUUID();await pool.query('INSERT INTO communities VALUES($1,$2)',[foreignCommunity,'外部社群']);
 await pool.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref) SELECT $1,$2,'hidden-expert@example.invalid','不可洩漏的外部專家',password_hash,$3 FROM users WHERE user_id=$4`,[foreignUser,foreignCommunity,randomUUID(),actors[0].user_id]);
 await pool.query("INSERT INTO platform_admins(admin_id,community_id,email,display_name) VALUES($1,$2,'foreign-expert-admin@example.invalid','外部管理員')",[foreignAdmin,foreignCommunity]);
 await pool.query("INSERT INTO positioning_profession_memberships(membership_id,community_id,user_id,guild_key,state) VALUES($1,$2,$3,$4,'active')",[randomUUID(),foreignCommunity,foreignUser,guild]);
 await pool.query('INSERT INTO positioning_guild_experts(community_id,guild_key,user_id,appointed_by) VALUES($1,$2,$3,$4)',[foreignCommunity,guild,foreignUser,foreignAdmin]);
 assert.equal(JSON.stringify((await publicGuild()).guild_experts).includes('不可洩漏'),false);
 await setGuildExpert(pool,input(actors[1].user_id,false,1),guild);assert.deepEqual((await publicGuild()).guild_experts,[{user_id:actors[0].user_id,display_name:actors[0].display_name,avatar_url:null}]);
 const member=await membership();await changeGuildMembership(pool,memberCommand(actors[0],'leave',Number(member.aggregate_version)),guild,'leave');assert.deepEqual((await publicGuild()).guild_experts,[]);
 // Even an inconsistent legacy role row cannot bypass the current membership join.
 await pool.query('UPDATE positioning_guild_experts SET active=true WHERE community_id=$1 AND user_id=$2',[DEMO_COMMUNITY,actors[0].user_id]);assert.deepEqual((await publicGuild()).guild_experts,[]);
 await pool.query("UPDATE positioning_profession_memberships SET state='active' WHERE community_id=$1 AND user_id=$2 AND guild_key=$3",[DEMO_COMMUNITY,actors[0].user_id,guild]);await pool.query('UPDATE users SET active=false WHERE user_id=$1',[actors[0].user_id]);assert.deepEqual((await publicGuild()).guild_experts,[]);
});

test('admin candidate and guild projections retain revocation versions and allow removing a disabled member without exposing them publicly',async()=>{
 const userId=actors[0].user_id,path='/guilds/'+guild+'/experts';await adminHttp(path,expertBody(userId));
 const candidatePath='/guilds/'+guild+'/master-candidates?scope=all&q='+encodeURIComponent(actors[0].email);
 let candidates=await adminHttp(candidatePath);assert.equal(candidates.status,200);assert.equal(candidates.data.items[0].is_expert,true);assert.equal(candidates.data.items[0].expert_version,1);
 await pool.query('UPDATE users SET active=false WHERE user_id=$1',[userId]);const adminView=await adminHttp('/guilds');assert.equal(adminView.status,200);
 const shown=adminView.data.items.find((row:any)=>row.guild_key===guild).guild_experts;assert.equal(shown.length,1);assert.equal(shown[0].user_id,userId);assert.equal(shown[0].member_active,false);assert.equal(shown[0].aggregate_version,1);assert.deepEqual((await publicGuild()).guild_experts,[]);
 const removed=await adminHttp(path,expertBody(userId,false),{version:shown[0].aggregate_version});assert.equal(removed.status,200,JSON.stringify(removed.data));assert.equal(removed.data.active,false);
 candidates=await adminHttp(candidatePath);assert.equal(candidates.data.items[0].is_expert,false);assert.equal(candidates.data.items[0].expert_version,2);assert.equal(candidates.data.items[0].eligible,false);assert.equal(candidates.data.items[0].eligibility_reason,'inactive');
 assert.deepEqual((await adminHttp('/guilds')).data.items.find((row:any)=>row.guild_key===guild).guild_experts,[]);
});


async function extraMember(label:string){
 const id=randomUUID();await pool.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref)
  SELECT $1,$2,$3,$4,password_hash,$5 FROM users WHERE user_id=$6`,[id,DEMO_COMMUNITY,id+'@expert-limit.invalid',label,randomUUID(),actors[0].user_id]);return id;
}
const full=(error:any)=>error.status===409&&error.code==='guild_expert_limit_reached';

test('three expert seats exclude the separately appointed master; a fourth is rejected before membership, book or audit side effects',async()=>{
 for(const actor of actors)assert.equal((await setGuildExpert(pool,input(actor.user_id),guild)).active,true);
 const master=await extraMember('另列的會長'),fourth=await extraMember('第四位專家候選');
 const masterResult=await adminHttp('/guilds/'+guild+'/master',{user_id:master,reason:'會長職位與三位專家名額分開。'});assert.equal(masterResult.status,200,JSON.stringify(masterResult.data));
 assert.equal(await count('positioning_guild_experts','guild_key=$1 AND active',[guild]),3);assert.equal(await expert(master),undefined);
 const auditBefore=await count('platform_admin_audit'),receiptBefore=await count('platform_admin_receipts');
 const rejected=await adminHttp('/guilds/'+guild+'/experts',expertBody(fourth));assert.equal(rejected.status,409);assert.equal(rejected.data.code,'guild_expert_limit_reached');assert.match(rejected.data.detail,/最多 3 位公會專家/);
 assert.equal(await membership(fourth),undefined);assert.equal(await expert(fourth),undefined);assert.equal(await count('member_skill_book_grants','user_id=$1',[fourth]),0);assert.equal(await count('platform_admin_audit'),auditBefore);assert.equal(await count('platform_admin_receipts'),receiptBefore);
 // An inactive member remains an appointed expert until explicitly removed.
 await pool.query('UPDATE users SET active=false WHERE user_id=$1',[actors[1].user_id]);await assert.rejects(setGuildExpert(pool,input(fourth),guild),full);assert.equal(await membership(fourth),undefined);
 // Capacity is scoped to a guild, not a community-wide expert total.
 const other=await setGuildExpert(pool,input(fourth,true,undefined,randomUUID(),otherGuild),otherGuild);assert.equal(other.active,true);
});

test('removal and leaving free a seat while reappointment at capacity preserves inactive roles and left membership',async()=>{
 for(const actor of actors)await setGuildExpert(pool,input(actor.user_id),guild);const replacement=await extraMember('遞補專家');
 const removed=await setGuildExpert(pool,input(actors[0].user_id,false,1),guild);assert.equal(removed.aggregate_version,2);
 await setGuildExpert(pool,input(replacement),guild);assert.equal(await count('positioning_guild_experts','guild_key=$1 AND active',[guild]),3);
 await assert.rejects(setGuildExpert(pool,input(actors[0].user_id,true,2),guild),full);assert.equal((await expert()).active,false);assert.equal((await expert()).aggregate_version,'2');
 const joined=await membership(actors[1].user_id);await changeGuildMembership(pool,memberCommand(actors[1],'leave-capacity',Number(joined.aggregate_version)),guild,'leave');assert.equal((await expert(actors[1].user_id)).active,false);
 const reappointed=await setGuildExpert(pool,input(actors[0].user_id,true,2),guild);assert.equal(reappointed.aggregate_version,3);
 await assert.rejects(setGuildExpert(pool,input(actors[1].user_id,true,2),guild),full);assert.equal((await membership(actors[1].user_id)).state,'left');assert.equal((await expert(actors[1].user_id)).aggregate_version,'2');
});

test('a full guild accepts receipt replays and versioned updates to an already active expert without allocating another seat',async()=>{
 const command=input(),first=await setGuildExpert(pool,command,guild);await setGuildExpert(pool,input(actors[1].user_id),guild);await setGuildExpert(pool,input(actors[2].user_id),guild);
 const auditBefore=await count('platform_admin_audit');assert.deepEqual(await setGuildExpert(pool,command,guild),first);assert.equal(await count('platform_admin_audit'),auditBefore);
 const updated=await setGuildExpert(pool,input(actors[0].user_id,true,1),guild);assert.equal(updated.aggregate_version,2);assert.equal(updated.membership_joined,false);assert.equal(await count('positioning_guild_experts','guild_key=$1 AND active',[guild]),3);
 await assert.rejects(setGuildExpert(pool,input(actors[0].user_id,true,1),guild),denied(412));
});

test('two different members racing for the final expert seat produce one success and one clean capacity rejection',async()=>{
 await setGuildExpert(pool,input(actors[0].user_id),guild);await setGuildExpert(pool,input(actors[1].user_id),guild);const rivals=[actors[2].user_id,await extraMember('競爭最後名額')];
 // Stretch the insertion window inside PostgreSQL so count-then-insert without
 // a guild lock would admit both requests. No production schema is touched.
 await pool.query(`CREATE FUNCTION test_slow_expert_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.08); RETURN NEW; END; $$`);
 await pool.query('CREATE TRIGGER test_slow_expert_insert BEFORE INSERT ON positioning_guild_experts FOR EACH ROW EXECUTE FUNCTION test_slow_expert_insert()');
 try{
  const results=await Promise.allSettled(rivals.map(id=>setGuildExpert(pool,input(id),guild)));
  assert.equal(results.filter(result=>result.status==='fulfilled').length,1);assert.equal(results.filter(result=>result.status==='rejected').length,1);
  const failedIndex=results.findIndex(result=>result.status==='rejected'),failed=results[failedIndex] as PromiseRejectedResult;assert.ok(full(failed.reason),String(failed.reason));
  assert.equal(await count('positioning_guild_experts','guild_key=$1 AND active',[guild]),3);assert.equal(await membership(rivals[failedIndex]),undefined);assert.equal(await expert(rivals[failedIndex]),undefined);assert.equal(await count('member_skill_book_grants','user_id=$1',[rivals[failedIndex]]),0);assert.equal(await count('platform_admin_audit',"action='appoint_guild_expert'"),3);
 }finally{await pool.query('DROP TRIGGER test_slow_expert_insert ON positioning_guild_experts');await pool.query('DROP FUNCTION test_slow_expert_insert()');}
});
