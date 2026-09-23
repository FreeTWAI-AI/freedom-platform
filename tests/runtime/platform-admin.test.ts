import {test,before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {Pool} from 'pg';
import {createLocalJWKSet,exportJWK,generateKeyPair,SignJWT} from 'jose';
import {command,createPool,LOCAL_DATABASE_URL} from '../../packages/db/index.js';
import {migrate} from '../../scripts/database.js';
import {seedLocal,DEMO_USERS,DEMO_PASSWORD,DEMO_COMMUNITY} from '../../packages/testing/seed.js';
import {authenticate,tokenHash} from '../../modules/identity-membership/service.js';
import {communityCatalog} from '../../modules/community/catalog.js';
import {createApp} from '../../apps/platform-api/src/app.js';
import {createAdminAccessVerifier} from '../../modules/platform-admin/access.js';
const origin='http://127.0.0.1:4310',databaseUrl=process.env.TEST_DATABASE_URL??LOCAL_DATABASE_URL;
const schema=`fp_admin_${process.pid}_${Date.now()}`,database=createPool(databaseUrl),pool=new Pool({connectionString:databaseUrl,options:`-c search_path=${schema}`,max:12});
const issuer='https://test-team.cloudflareaccess.com',audience='admin-route-tests',email='admin@example.invalid',adminId=randomUUID(),pair=await generateKeyPair('RS256');
const jwk=await exportJWK(pair.publicKey),verifier=createAdminAccessVerifier({issuer,audience,csrfSecret:'test-fixture-admin-csrf-secret-123456789',keySet:createLocalJWKSet({keys:[{...jwk,kid:'admin-test',alg:'RS256'}]})});
let app=createApp(pool,origin,'local',{adminVerifier:verifier}),jwt='',csrf='';
before(async()=>{await database.query(`CREATE SCHEMA ${schema}`);await migrate(pool);});
after(async()=>{await pool.end();await database.query(`DROP SCHEMA ${schema} CASCADE`);await database.end();});
beforeEach(async()=>{
 await pool.query('TRUNCATE communities,login_attempts,auth_rate_limits CASCADE');await pool.query("DELETE FROM positioning_guild_catalog WHERE guild_key LIKE 'guild_custom_%'");await seedLocal(pool);
 await pool.query('INSERT INTO platform_admins(admin_id,community_id,email,display_name) VALUES($1,$2,$3,$4)',[adminId,DEMO_COMMUNITY,email,'Verified Admin']);
 app=createApp(pool,origin,'local',{adminVerifier:verifier});jwt=await sign(email);csrf=(await verifier(new Request(origin,{headers:{'Cf-Access-Jwt-Assertion':jwt}}))).csrfToken;
});
async function sign(claimedEmail:string,aud=audience){const now=Math.floor(Date.now()/1000);return new SignJWT({type:'app',email:claimedEmail,sub:'verified-human-fixture',iss:issuer,aud,iat:now,nbf:now,exp:now+600}).setProtectedHeader({alg:'RS256',kid:'admin-test'}).sign(pair.privateKey);}
async function request(path:string,body?:unknown,version?:number,key:string=randomUUID(),headers:Record<string,string>={}){
 const defaults:Record<string,string>={Origin:origin,'Cf-Access-Jwt-Assertion':jwt,'X-Admin-CSRF':csrf,...headers};
 if(body!==undefined){defaults['Content-Type']??='application/json';defaults['Idempotency-Key']=key;if(version!==undefined)defaults['If-Match']=`"${version}"`;}
 const response=await app.request(origin+'/admin/api'+path,{method:body===undefined?'GET':'POST',headers:defaults,body:body===undefined?undefined:JSON.stringify(body)});
 return {status:response.status,data:await response.json() as any,response};
}
async function member(path:string,cookie='',body?:unknown,memberCsrf='',version?:number){
 const response=await app.request(origin+'/api/v1'+path,{method:body===undefined?'GET':'POST',headers:{Origin:origin,Cookie:cookie,'X-CSRF-Token':memberCsrf,'Content-Type':'application/json','Idempotency-Key':randomUUID(),...(version?{'If-Match':`"${version}"`}:{})},body:body===undefined?undefined:JSON.stringify(body)});
 return {status:response.status,data:await response.json() as any,response};
}
async function login(user=DEMO_USERS[0]){const result=await member('/auth/login','',{email:user.email,password:DEMO_PASSWORD});assert.equal(result.status,200);return {cookie:result.response.headers.get('set-cookie')!.split(';')[0],csrf:result.data.csrf_token};}
async function application(community=DEMO_COMMUNITY,user=DEMO_USERS[0].user_id){const id=randomUUID();await pool.query('INSERT INTO guild_creation_applications(application_id,community_id,user_id,name,profession,reason) VALUES($1,$2,$3,$4,$5,$6)',[id,community,user,'研究與協作公會','研究','把共同研究的方法整理清楚。']);return id;}
async function outsider(){const community=randomUUID(),user=randomUUID();await pool.query('INSERT INTO communities VALUES($1,$2)',[community,'Other community']);await pool.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref) SELECT $1,$2,'outsider@example.invalid','Outsider',password_hash,$3 FROM users LIMIT 1`,[user,community,randomUUID()]);return {community,user};}
const approval={decision:'approve',reason:'已確認公會目標與第一步。',guild:{name:'研究與協作公會',purpose:'整理公開研究的方法與範例。',first_step:'提出第一份可以共同重現的研究。',module_key:'guilds',skill_book_ids:[communityCatalog.skill_books[0].id]}};
const disabled={active:false,reason:'會員要求暫停帳號。'};
const guild='guild_marketing';
async function join(user=DEMO_USERS[0].user_id,key=guild){await pool.query("INSERT INTO positioning_profession_memberships(membership_id,community_id,user_id,guild_key,state) VALUES($1,$2,$3,$4,'active')",[randomUUID(),DEMO_COMMUNITY,user,key]);}

test('signed Access identity and separately provisioned admin are required; member cookies and email headers grant nothing',async()=>{
 const normal=await login();
 for(const path of ['/bootstrap','/members','/guilds','/guild-applications','/admins','/audit','/unknown']){
  const r=await request(path,undefined,undefined,randomUUID(),{'Cf-Access-Jwt-Assertion':'',Cookie:normal.cookie,'Cf-Access-Authenticated-User-Email':email});assert.equal(r.status,401);
 }
 assert.equal((await request('/bootstrap',undefined,undefined,randomUUID(),{'Cf-Access-Jwt-Assertion':await sign('not-nominated@example.invalid')})).status,403);
 assert.equal((await request('/bootstrap',undefined,undefined,randomUUID(),{'Cf-Access-Jwt-Assertion':await sign(email,'member-audience')})).status,401);
 const good=await request('/bootstrap');assert.equal(good.status,200);assert.equal(good.data.admin.email,email);assert.equal(good.data.csrf_token,csrf);assert.equal(good.data.summary.members,3);assert.equal(good.response.headers.get('cache-control'),'no-store');
 assert.equal((await request('/unknown')).status,404);
 await pool.query('UPDATE platform_admins SET active=false WHERE admin_id=$1',[adminId]);assert.equal((await request('/bootstrap')).status,403);
});

test('admin identity is independent of onboarding and unverified account email, which stays deactivatable',async()=>{
 await pool.query('UPDATE users SET email=$2,onboarding_required=true WHERE user_id=$1',[DEMO_USERS[0].user_id,email]);
 const nominated=(await request('/admins')).data.items[0];assert.equal(nominated.identity_binding,'unverified_email_match');assert.equal(nominated.member_email_verified,false);
 const memberSession=await login({...DEMO_USERS[0],email});assert.equal((await member('/members',memberSession.cookie)).status,403);
 assert.equal((await request('/bootstrap',undefined,undefined,randomUUID(),{'Cf-Access-Jwt-Assertion':'',Cookie:memberSession.cookie})).status,401);
 assert.equal((await request(`/members/${DEMO_USERS[0].user_id}/status`,disabled,1)).status,200);assert.equal((await request('/bootstrap')).status,200);
 assert.equal((await request('/admins')).data.items[0].member_account_active,false);
});

test('writes require admin CSRF, same origin, JSON, valid reason, UUID, version and idempotency',async()=>{
 const path=`/members/${DEMO_USERS[0].user_id}/status`;
 for(const [headers,status,code] of [[{'X-Admin-CSRF':'wrong'},403,'admin_csrf_rejected'],[{Origin:'https://evil.example'},403,'origin_rejected'],[{'Content-Type':'text/plain'},415,'json_required']] as const){const r=await request(path,disabled,1,randomUUID(),headers as Record<string,string>);assert.equal(r.status,status);assert.equal(r.data.code,code);}
 assert.equal((await request(path,disabled)).status,428);assert.equal((await request(path,{...disabled,reason:'a'},1)).status,422);assert.equal((await request('/members/not-a-uuid/status',disabled,1)).status,422);
 assert.equal((await request(path,{...disabled,admin:true},1)).status,422);assert.equal((await request(path,disabled,1,'x')).status,400);
 assert.equal((await request('/members?limit=101')).status,422);assert.equal((await request('/members?offset=-1')).status,422);assert.equal((await request('/guild-applications?state=wrong')).status,422);
 assert.equal((await pool.query('SELECT count(*) FROM platform_admin_audit')).rows[0].count,'0');
});

test('admin listings and mutations cannot cross community boundaries',async()=>{
 const other=await outsider(),appId=await application(other.community,other.user);
 await pool.query('INSERT INTO platform_admins(admin_id,community_id,email,display_name) VALUES($1,$2,$3,$4)',[randomUUID(),other.community,'other-admin@example.invalid','Other Admin']);
 const listed=await request('/members?limit=2');assert.equal(listed.data.items.length,2);assert.equal(listed.data.next_offset,2);assert.ok(!JSON.stringify(listed.data).includes('outsider@example.invalid'));
 assert.ok(!JSON.stringify((await request('/members?offset=2')).data).includes('outsider@example.invalid'));assert.equal((await request('/admins')).data.items.length,1);assert.equal((await request('/guild-applications?state=all')).data.items.length,0);
 assert.equal((await request(`/members/${other.user}/status`,disabled,1)).status,404);assert.equal((await request(`/guild-applications/${appId}/review`,{decision:'reject',reason:'不在本社群範圍。'},1)).status,404);
 const own=await application();assert.equal((await request(`/guild-applications/${own}/review`,approval,1)).data.code,'guild_catalog_scope_required');
});

test('deactivation revokes all sessions and client credentials; reactivation never revives them, and retry audits once',async()=>{
 const user=DEMO_USERS[0],first=await login(),second=await login(),token=randomBytes(32).toString('base64url');
 await pool.query("INSERT INTO member_client_connections(connection_id,community_id,user_id,client_name,kind,scope,token_hash) VALUES($1,$2,$3,'Fixture client','supplier','supplier:read',$4)",[randomUUID(),DEMO_COMMUNITY,user.user_id,tokenHash(token)]);
 const path=`/members/${user.user_id}/status`,key=randomUUID(),r=await request(path,disabled,1,key);assert.equal(r.status,200,JSON.stringify(r.data));assert.equal(r.data.aggregate_version,2);assert.equal(r.response.headers.get('etag'),'"2"');
 assert.deepEqual((await request(path,disabled,1,key)).data,r.data);assert.equal((await request(path,{...disabled,reason:'不同內容理由'},1,key)).status,409);assert.equal((await request(path,disabled,1)).status,412);
 assert.equal((await pool.query('SELECT count(*) FROM sessions WHERE revoked_at IS NULL')).rows[0].count,'0');assert.equal((await pool.query('SELECT count(*) FROM member_client_connections WHERE revoked_at IS NULL')).rows[0].count,'0');
 assert.equal((await member('/session',first.cookie)).status,401);assert.equal((await member('/session',second.cookie)).status,401);
 const enabled=await request(path,{active:true,reason:'會員已確認恢復使用。'},2);assert.equal(enabled.status,200);assert.equal((await member('/session',first.cookie)).status,401);
 const bearer=await app.request(origin+'/client-api/v1/supplier/products',{headers:{Authorization:'Bearer '+token}});assert.equal(bearer.status,401);
 const audit=(await request('/audit')).data.items;assert.equal(audit.length,2);assert.equal(audit[1].action,'member_status');assert.equal(audit[1].admin_name,'Verified Admin');assert.ok(!JSON.stringify(audit).includes(token));assert.ok(!JSON.stringify(audit).includes(jwt));
 assert.equal((await pool.query('SELECT verified_access_subject FROM platform_admin_audit LIMIT 1')).rows[0].verified_access_subject,'verified-human-fixture');
 await pool.query('UPDATE platform_admins SET active=false WHERE admin_id=$1',[adminId]);assert.equal((await request(path,disabled,1,key)).status,403);
});

test('guild approval requires explicit details and creates one catalog entry without silently joining, appointing or granting books',async()=>{
 const id=await application(),path=`/guild-applications/${id}/review`,key=randomUUID();
 assert.equal((await request(path,{decision:'approve',reason:'同意成立'},1)).status,422);assert.equal((await request(path,{...approval,guild:{...approval.guild,skill_book_ids:['unknown-book']}},1)).status,422);assert.equal((await request(path,{...approval,guild:{...approval.guild,skill_book_ids:[]}},1)).status,422);assert.equal((await request(path,{decision:'reject',reason:'不同意',guild:approval.guild},1)).status,422);
 const prior=(await request('/guild-applications')).data.items[0];assert.equal(prior.applicant_email,DEMO_USERS[0].email);assert.equal(prior.aggregate_version,1);
 const result=await request(path,approval,1,key);assert.equal(result.status,200,JSON.stringify(result.data));assert.equal(result.data.state,'approved');assert.equal(result.data.reviewed_by,adminId);assert.match(result.data.approved_guild_key,/^guild_custom_/);assert.equal(result.data.aggregate_version,2);
 assert.deepEqual((await pool.query('SELECT book_id FROM guild_skill_book_bindings WHERE community_id=$1 AND guild_key=$2',[DEMO_COMMUNITY,result.data.approved_guild_key])).rows.map(r=>r.book_id),approval.guild.skill_book_ids);
 assert.deepEqual((await request(path,approval,1,key)).data,result.data);assert.equal((await pool.query('SELECT count(*) FROM positioning_guild_catalog WHERE guild_key=$1',[result.data.approved_guild_key])).rows[0].count,'1');
 for(const table of ['positioning_profession_memberships','positioning_guild_officers','member_skill_book_grants'])assert.equal((await pool.query(`SELECT count(*) FROM ${table}`)).rows[0].count,'0');
 assert.equal((await request(path,{decision:'reject',reason:'第二次審核'},2)).data.code,'application_reviewed');assert.equal((await request('/audit')).data.items.length,1);
 const denied=await application(),reject=await request(`/guild-applications/${denied}/review`,{decision:'reject',reason:'目前需要補充具體目標。'},1);assert.equal(reject.data.state,'declined');assert.equal(reject.data.approved_guild_key,null);
});

test('concurrent guild reviews and concurrent identical requests cannot double approve or double audit',async()=>{
 const id=await application(),path=`/guild-applications/${id}/review`,key=randomUUID();
 const same=await Promise.all([request(path,approval,1,key),request(path,approval,1,key)]);assert.deepEqual(same.map(r=>r.status),[200,200]);assert.deepEqual(same[0].data,same[1].data);
 const second=await application(),approveOther={...approval,guild:{...approval.guild,name:'共同測試公會'}};
 const conflicting=await Promise.all([request(`/guild-applications/${second}/review`,approveOther,1),request(`/guild-applications/${second}/review`,{decision:'reject',reason:'尚未準備好，請補充內容。'},1)]);assert.deepEqual(conflicting.map(r=>r.status).sort(),[200,412]);
 assert.equal((await request('/audit')).data.items.length,2);
});

test('explicit administrator appointment joins active nonmembers, grants books, preserves primary selection and ends on leave',async()=>{
 const path=`/guilds/${guild}/master`,body={user_id:DEMO_USERS[0].user_id,reason:'管理員確認由此人帶領公會。'};
 await join(DEMO_USERS[1].user_id);await pool.query('UPDATE users SET active=false WHERE user_id=$1',[DEMO_USERS[1].user_id]);assert.equal((await request(path,{...body,user_id:DEMO_USERS[1].user_id})).status,422);
 const first=await request(path,body);assert.equal(first.status,200,JSON.stringify(first.data));assert.ok(first.data.aggregate_version>=2);
 const membership=(await pool.query('SELECT * FROM positioning_profession_memberships WHERE user_id=$1 AND guild_key=$2',[body.user_id,guild])).rows[0];assert.equal(membership.state,'active');assert.equal((await pool.query('SELECT count(*) FROM guild_member_preferences WHERE user_id=$1',[body.user_id])).rows[0].count,'0');
 assert.deepEqual((await pool.query('SELECT book_id FROM member_skill_book_grants WHERE user_id=$1 AND guild_key=$2 ORDER BY book_id',[body.user_id,guild])).rows.map(row=>row.book_id),['social-post','typo-studio']);
 assert.equal((await request(path,body)).status,428);const listed=(await request('/guilds')).data.items.find((g:any)=>g.guild_key===guild);assert.equal(listed.officer_version,first.data.aggregate_version);assert.equal(listed.guild_master.user_id,body.user_id);assert.equal(listed.member_count,1);
 const outsiderUser=await outsider();assert.equal((await request(path,{...body,user_id:outsiderUser.user},first.data.aggregate_version)).status,422);
 const memberSession=await login(),left=await member(`/guilds/${guild}/leave`,memberSession.cookie,{},memberSession.csrf,Number(membership.aggregate_version));assert.equal(left.status,200,JSON.stringify(left.data));assert.equal((await pool.query('SELECT count(*) FROM positioning_guild_officers')).rows[0].count,'0');
 assert.equal((await request(path,body,first.data.aggregate_version)).status,412);assert.equal((await pool.query('SELECT state FROM positioning_profession_memberships WHERE user_id=$1 AND guild_key=$2',[body.user_id,guild])).rows[0].state,'left');
 const reappointed=await request(path,body);assert.equal(reappointed.status,200);assert.ok(reappointed.data.aggregate_version>first.data.aggregate_version);assert.equal((await pool.query('SELECT state FROM positioning_profession_memberships WHERE user_id=$1 AND guild_key=$2',[body.user_id,guild])).rows[0].state,'active');
});

test('automatic guild admission does not rewrite primary guild, onboarding state or administrator roles',async()=>{
 const user=DEMO_USERS[0].user_id;await join(user,'guild_security');await pool.query('INSERT INTO guild_member_preferences(community_id,user_id,primary_guild_key) VALUES($1,$2,$3)',[DEMO_COMMUNITY,user,'guild_security']);await pool.query('UPDATE users SET onboarding_required=true,onboarding_completed_at=NULL WHERE user_id=$1',[user]);
 const before=(await pool.query('SELECT onboarding_required,onboarding_completed_at,email_verified_at FROM users WHERE user_id=$1',[user])).rows[0],preference=(await pool.query('SELECT * FROM guild_member_preferences WHERE user_id=$1',[user])).rows[0];
 const result=await request(`/guilds/${guild}/master`,{user_id:user,reason:'由管理員任命，原定位稍後由會員本人完成。'});assert.equal(result.status,200,JSON.stringify(result.data));
 assert.deepEqual((await pool.query('SELECT onboarding_required,onboarding_completed_at,email_verified_at FROM users WHERE user_id=$1',[user])).rows[0],before);assert.deepEqual((await pool.query('SELECT * FROM guild_member_preferences WHERE user_id=$1',[user])).rows[0],preference);
 assert.equal((await pool.query('SELECT count(*) FROM platform_admins')).rows[0].count,'1');const session=await login();assert.equal((await member('/members',session.cookie)).status,403);
});

test('replaying an old appointment after leave does not rejoin, add newly bound books or create fresh audit',async()=>{
 const path=`/guilds/${guild}/master`,body={user_id:DEMO_USERS[0].user_id,reason:'首次明確任命。'},key=randomUUID();const first=await request(path,body,undefined,key);assert.equal(first.status,200);
 const session=await login();const membership=(await pool.query('SELECT aggregate_version FROM positioning_profession_memberships WHERE user_id=$1 AND guild_key=$2',[body.user_id,guild])).rows[0];assert.equal((await member(`/guilds/${guild}/leave`,session.cookie,{},session.csrf,Number(membership.aggregate_version))).status,200);
 const before=(await pool.query('SELECT * FROM member_skill_book_grants WHERE user_id=$1 ORDER BY book_id',[body.user_id])).rows;await pool.query('INSERT INTO guild_skill_book_bindings(community_id,guild_key,book_id) VALUES($1,$2,$3)',[DEMO_COMMUNITY,guild,'event-space']);
 const replay=await request(path,body,undefined,key);assert.equal(replay.status,200);assert.deepEqual(replay.data,first.data);assert.equal((await pool.query('SELECT state FROM positioning_profession_memberships WHERE user_id=$1 AND guild_key=$2',[body.user_id,guild])).rows[0].state,'left');assert.equal((await pool.query('SELECT count(*) FROM positioning_guild_officers')).rows[0].count,'0');assert.deepEqual((await pool.query('SELECT * FROM member_skill_book_grants WHERE user_id=$1 ORDER BY book_id',[body.user_id])).rows,before);
 assert.equal((await pool.query("SELECT count(*) FROM platform_admin_audit WHERE action='appoint_guild_master'")).rows[0].count,'1');assert.equal((await pool.query('SELECT count(*) FROM platform_admin_receipts WHERE idempotency_key=$1',[key])).rows[0].count,'1');
});

test('failed book grants roll back automatic membership, officer assignment and administrator receipts together',async()=>{
 await pool.query("CREATE FUNCTION reject_test_grant() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic grant failure'; END; $$");
 await pool.query('CREATE TRIGGER reject_test_grant BEFORE INSERT ON member_skill_book_grants FOR EACH ROW EXECUTE FUNCTION reject_test_grant()');
 try{
  const result=await request(`/guilds/${guild}/master`,{user_id:DEMO_USERS[0].user_id,reason:'測試交易必須一併完成。'});assert.equal(result.status,500);
  for(const table of ['positioning_profession_memberships','member_skill_book_grants','positioning_guild_officers','platform_admin_audit','platform_admin_receipts'])assert.equal((await pool.query(`SELECT count(*) FROM ${table}`)).rows[0].count,'0',table);
 }finally{await pool.query('DROP TRIGGER reject_test_grant ON member_skill_book_grants');await pool.query('DROP FUNCTION reject_test_grant()');}
});

test('concurrent guild leave and a new explicit appointment yield a serial order without a nonmember officer',async()=>{
 await join();const session=await login(),body={user_id:DEMO_USERS[0].user_id,reason:'已確認成員參與。'};
 const [appointment,left]=await Promise.all([request(`/guilds/${guild}/master`,body),member(`/guilds/${guild}/leave`,session.cookie,{},session.csrf,1)]);
 assert.equal(appointment.status,200,JSON.stringify(appointment));assert.equal(left.status,200,JSON.stringify(left));
 const membership=(await pool.query('SELECT state FROM positioning_profession_memberships WHERE user_id=$1 AND guild_key=$2',[body.user_id,guild])).rows[0];const officers=(await pool.query('SELECT user_id FROM positioning_guild_officers WHERE guild_key=$1',[guild])).rows;
 if(membership.state==='active')assert.deepEqual(officers.map(row=>row.user_id),[body.user_id]);else{assert.equal(membership.state,'left');assert.deepEqual(officers,[]);}
 assert.equal((await pool.query(`SELECT count(*) FROM positioning_guild_officers o LEFT JOIN positioning_profession_memberships m ON m.community_id=o.community_id AND m.guild_key=o.guild_key AND m.user_id=o.user_id AND m.state='active' WHERE m.membership_id IS NULL`)).rows[0].count,'0');
});

async function waitForBlocker(pid:number){
 for(let i=0;i<100;i++){
  const rows=await pool.query("SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)) AND wait_event_type='Lock'",[pid]);
  if(rows.rowCount)return;
  await new Promise(resolve=>setTimeout(resolve,10));
 }
 assert.fail('Expected request to reach the deliberately locked user.');
}
test('ordinary mutation locks user before session, avoiding deadlock with administration revocation',async()=>{
 const logged=await login(),actor=await authenticate(pool,logged.cookie.split('=')[1]),blocker=await pool.connect();let pending:Promise<any>|undefined;
 try{
  await blocker.query('BEGIN');const pid=(await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  await blocker.query('SELECT user_id FROM users WHERE user_id=$1 FOR UPDATE',[actor.user_id]);
  pending=command(pool,{actor,operation:'lock-order-regression',key:randomUUID(),body:{}},async()=>{},async()=>({done:true})).then(value=>({value}),error=>({error}));
  await waitForBlocker(pid);
  // A blocked member mutation must not already hold the session row.
  await pool.query('SELECT token_hash FROM sessions WHERE token_hash=$1 FOR UPDATE NOWAIT',[actor.session_hash]);
  await blocker.query('UPDATE users SET active=false WHERE user_id=$1',[actor.user_id]);
  await blocker.query('UPDATE sessions SET revoked_at=now() WHERE user_id=$1',[actor.user_id]);await blocker.query('COMMIT');
  const result=await pending;assert.equal(result.error?.code,'session_expired');assert.equal(result.value,undefined);
 }finally{await blocker.query('ROLLBACK');blocker.release();if(pending)await pending;}
});

test('login racing deactivation cannot leave a fresh session that revives after account reactivation',async()=>{
 const blocker=await pool.connect();let pending:ReturnType<typeof member>|undefined;
 try{
  await blocker.query('BEGIN');const pid=(await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  await blocker.query('SELECT user_id FROM users WHERE user_id=$1 FOR UPDATE',[DEMO_USERS[0].user_id]);
  pending=member('/auth/login','',{email:DEMO_USERS[0].email,password:DEMO_PASSWORD});await waitForBlocker(pid);
  await blocker.query('UPDATE users SET active=false WHERE user_id=$1',[DEMO_USERS[0].user_id]);await blocker.query('UPDATE sessions SET revoked_at=now() WHERE user_id=$1',[DEMO_USERS[0].user_id]);await blocker.query('COMMIT');
  assert.equal((await pending).status,401);await pool.query('UPDATE users SET active=true WHERE user_id=$1',[DEMO_USERS[0].user_id]);assert.equal((await pool.query('SELECT count(*) FROM sessions WHERE revoked_at IS NULL')).rows[0].count,'0');
 }finally{await blocker.query('ROLLBACK');blocker.release();if(pending)await pending;}
});

test('officer removal and replacement never reuse an old revision for a stale administrator',async()=>{
 await Promise.all(DEMO_USERS.slice(0,2).map(user=>join(user.user_id)));
 const path=`/guilds/${guild}/master`,body={user_id:DEMO_USERS[0].user_id,reason:'第一位公會長的確認紀錄。'},first=await request(path,body);assert.equal(first.status,200);
 await pool.query("UPDATE positioning_profession_memberships SET state='left' WHERE user_id=$1 AND guild_key=$2",[DEMO_USERS[0].user_id,guild]);
 const second=await request(path,{...body,user_id:DEMO_USERS[1].user_id});assert.equal(second.status,200);assert.ok(second.data.aggregate_version>first.data.aggregate_version);
 const stale=await request(path,{...body,user_id:DEMO_USERS[2].user_id},first.data.aggregate_version);assert.equal(stale.status,412);
 assert.equal((await request('/guilds')).data.items.find((g:any)=>g.guild_key===guild).guild_master.user_id,DEMO_USERS[1].user_id);
 assert.equal((await pool.query('SELECT count(*) FROM positioning_profession_memberships WHERE user_id=$1',[DEMO_USERS[2].user_id])).rows[0].count,'0');assert.equal((await pool.query('SELECT count(*) FROM member_skill_book_grants WHERE user_id=$1',[DEMO_USERS[2].user_id])).rows[0].count,'0');
});

async function matchingMember(){await pool.query('UPDATE users SET email=$2 WHERE user_id=$1',[DEMO_USERS[0].user_id,email]);return login({...DEMO_USERS[0],email});}
async function nominate(keys:string[]){for(const key of keys)await pool.query('INSERT INTO guild_leadership_nominations(community_id,guild_key,admin_id) VALUES($1,$2,$3)',[DEMO_COMMUNITY,key,adminId]);}
const nominations=['guild_platform_engineering','guild_security'];

test('linking appointments requires both verified Access and matching live member session with completed onboarding',async()=>{
 await nominate(nominations);assert.equal((await request('/link-member',{})).status,401);
 const unmatched=await login();assert.equal((await request('/link-member',{},undefined,randomUUID(),{Cookie:unmatched.cookie})).data.code,'member_identity_mismatch');
 const matching=await matchingMember();assert.equal((await request('/link-member',{},undefined,randomUUID(),{Cookie:matching.cookie,'Cf-Access-Jwt-Assertion':''})).status,401);
 await pool.query('UPDATE users SET onboarding_required=true,onboarding_completed_at=NULL WHERE user_id=$1',[DEMO_USERS[0].user_id]);
 assert.equal((await request('/link-member',{},undefined,randomUUID(),{Cookie:matching.cookie})).data.code,'onboarding_required');
 assert.equal((await pool.query('SELECT count(*) FROM positioning_guild_officers')).rows[0].count,'0');assert.equal((await pool.query('SELECT email_verified_at FROM users WHERE user_id=$1',[DEMO_USERS[0].user_id])).rows[0].email_verified_at,null);
});

test('verified member linking activates only own nominations, grants skill books and preserves selected primary guild',async()=>{
 const matching=await matchingMember();await nominate(nominations);await join();await pool.query('INSERT INTO guild_member_preferences(community_id,user_id,primary_guild_key) VALUES($1,$2,$3)',[DEMO_COMMUNITY,DEMO_USERS[0].user_id,guild]);
 const before=await request('/bootstrap');assert.equal(before.data.pending_guild_appointments.length,2);assert.ok(before.data.pending_guild_appointments.every((row:any)=>row.state==='pending'));
 const key=randomUUID(),linked=await request('/link-member',{},undefined,key,{Cookie:matching.cookie});assert.equal(linked.status,200,JSON.stringify(linked.data));assert.equal(linked.data.linked_user_id,DEMO_USERS[0].user_id);assert.deepEqual(linked.data.activated_guilds.map((g:any)=>g.guild_key).sort(),[...nominations].sort());
 assert.deepEqual((await request('/link-member',{},undefined,key,{Cookie:matching.cookie})).data,linked.data);
 for(const nominated of nominations){assert.equal((await pool.query('SELECT user_id FROM positioning_guild_officers WHERE guild_key=$1',[nominated])).rows[0].user_id,DEMO_USERS[0].user_id);assert.equal((await pool.query("SELECT state FROM positioning_profession_memberships WHERE guild_key=$1 AND user_id=$2",[nominated,DEMO_USERS[0].user_id])).rows[0].state,'active');assert.ok((await pool.query('SELECT count(*)::int AS n FROM member_skill_book_grants WHERE guild_key=$1 AND user_id=$2',[nominated,DEMO_USERS[0].user_id])).rows[0].n>0);}
 assert.equal((await pool.query('SELECT primary_guild_key FROM guild_member_preferences WHERE user_id=$1',[DEMO_USERS[0].user_id])).rows[0].primary_guild_key,guild);
 assert.ok((await pool.query('SELECT email_verified_at FROM users WHERE user_id=$1',[DEMO_USERS[0].user_id])).rows[0].email_verified_at);assert.equal((await request('/admins')).data.items[0].identity_binding,'verified_email_match');
 const audit=(await request('/audit')).data.items;assert.equal(audit.filter((row:any)=>row.action==='accept_nominated_guild_master').length,2);assert.equal(audit.filter((row:any)=>row.action==='link_verified_member').length,1);
 assert.equal((await pool.query("SELECT count(*) FROM guild_leadership_nominations WHERE state='bound' AND bound_user_id=$1",[DEMO_USERS[0].user_id])).rows[0].count,'2');
});

test('conflicting nominated guild master rolls back every appointment, grant and email verification',async()=>{
 const matching=await matchingMember();await nominate(nominations);await join(DEMO_USERS[1].user_id,nominations[1]);await pool.query('INSERT INTO positioning_guild_officers(community_id,guild_key,user_id) VALUES($1,$2,$3)',[DEMO_COMMUNITY,nominations[1],DEMO_USERS[1].user_id]);
 const linked=await request('/link-member',{},undefined,randomUUID(),{Cookie:matching.cookie});assert.equal(linked.data.code,'appointment_changed');
 assert.equal((await pool.query('SELECT count(*) FROM positioning_profession_memberships WHERE user_id=$1',[DEMO_USERS[0].user_id])).rows[0].count,'0');assert.equal((await pool.query('SELECT count(*) FROM member_skill_book_grants')).rows[0].count,'0');assert.equal((await request('/audit')).data.items.length,0);
 assert.equal((await pool.query('SELECT email_verified_at FROM users WHERE user_id=$1',[DEMO_USERS[0].user_id])).rows[0].email_verified_at,null);assert.equal((await pool.query("SELECT count(*) FROM guild_leadership_nominations WHERE state='pending'")).rows[0].count,'2');
});
