import {test,before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {Pool} from 'pg';
import {createPool,LOCAL_DATABASE_URL} from '../../packages/db/index.js';
import {migrate} from '../../scripts/database.js';
import {seedLocal,DEMO_USERS,DEMO_PASSWORD,DEMO_COMMUNITY} from '../../packages/testing/seed.js';
import {createApp} from '../../apps/platform-api/src/app.js';
import {communityCatalog} from '../../modules/community/catalog.js';
import {isVerificationTestEmail,VERIFICATION_TEST_EMAIL_SUFFIX} from '../../modules/identity-membership/test-accounts.js';
import {adminApplications,adminBootstrap,adminGuilds,adminMembers,type AdminActor} from '../../modules/platform-admin/service.js';
import {listSkillMaintainers} from '../../modules/guild-workspace/service.js';

const origin='http://127.0.0.1:4310',databaseUrl=process.env.TEST_DATABASE_URL??LOCAL_DATABASE_URL;
const schema=`fp_verify_filter_${process.pid}_${Date.now()}`,adminPool=createPool(databaseUrl);
const pool=new Pool({connectionString:databaseUrl,options:`-c search_path=${schema}`,max:8});
const app=createApp(pool,origin);
const sha='a'.repeat(64),book=communityCatalog.skill_books[0].id;
type Session={cookie:string;csrf:string;user:any};
before(async()=>{await adminPool.query(`CREATE SCHEMA ${schema}`);await migrate(pool);});
after(async()=>{await pool.end();await adminPool.query(`DROP SCHEMA ${schema} CASCADE`);await adminPool.end();});
beforeEach(async()=>{await pool.query('TRUNCATE communities,login_attempts,auth_rate_limits CASCADE');await seedLocal(pool);});

async function request(path:string,session?:Session,body?:unknown,version?:number|string){
  const headers:Record<string,string>={Origin:origin,...(session?{Cookie:session.cookie,'X-CSRF-Token':session.csrf}:{})};
  if(body!==undefined){headers['Content-Type']='application/json';headers['Idempotency-Key']=randomUUID();if(version)headers['If-Match']=`"${version}"`;}
  const response=await app.request(origin+'/api/v1'+path,{method:body===undefined?'GET':'POST',headers,body:body===undefined?undefined:JSON.stringify(body)});
  const text=await response.text();
  return {status:response.status,data:text?JSON.parse(text):null};
}
async function login(email:string):Promise<Session>{
  const headers:Record<string,string>={Origin:origin,'Content-Type':'application/json'};
  const response=await app.request(origin+'/api/v1/auth/login',{method:'POST',headers,body:JSON.stringify({email,password:DEMO_PASSWORD})});
  const data=await response.json() as any;
  assert.equal(response.status,200,JSON.stringify(data));
  return {cookie:response.headers.get('set-cookie')!.split(';')[0],csrf:data.csrf_token,user:data.user};
}
async function addUser(email:string,name:string){
  const id=randomUUID();
  await pool.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref)
    SELECT $1,community_id,$2,$3,password_hash,$4 FROM users WHERE user_id=$5`,[id,email,name,randomUUID(),DEMO_USERS[0].user_id]);
  return id;
}
async function eventRow(id:string,organizer:string,capacity:number|null){
  await pool.query(`INSERT INTO community_events(event_id,community_id,organizer_ref,title,description,starts_at,ends_at,mode,location,capacity,state,visibility,event_kind)
    VALUES($1,$2,$3,'驗收活動','一起確認名單',now()+interval '2 days',now()+interval '3 days','online','線上',$4,'published','open','other')`,[id,DEMO_COMMUNITY,organizer,capacity]);
}
const ids=(items:any[],key='user_id')=>items.map(item=>item[key]);

test('verification scripts keep the classified email suffix',async()=>{
  assert.equal(isVerificationTestEmail('Person@EXAMPLE.INVALID'),true);
  assert.equal(isVerificationTestEmail('person@member.test'),false);
  for(const file of ['scripts/verify-public.mjs','scripts/verify-cloud-candidate-members.ts']){
    assert.ok((await readFile(file,'utf8')).includes(VERIFICATION_TEST_EMAIL_SUFFIX),file);
  }
});

test('test accounts stay usable and disappear from other members lists and counts',async()=>{
  const host=await addUser(`host-${randomUUID()}@example.invalid`,'合成驗收員'),peer=await addUser(`peer-${randomUUID()}@example.invalid`,'合成同伴');
  const real=await login(DEMO_USERS[0].email);
  const stored=(await pool.query('SELECT email FROM users WHERE user_id=$1',[host])).rows[0].email as string;
  assert.equal((await pool.query('SELECT is_verification_test_account($1) AS hidden',[host])).rows[0].hidden,true);
  assert.equal((await pool.query('SELECT is_verification_test_email($1) AS hidden',[stored])).rows[0].hidden,isVerificationTestEmail(stored));
  const self=await login(stored),friend=await login((await pool.query('SELECT email FROM users WHERE user_id=$1',[peer])).rows[0].email);
  assert.equal((await request('/session',self)).status,200);
  assert.equal((await request('/me/account',self)).status,200);

  const hidden=await request('/members?search='+encodeURIComponent('合成驗收員'),real);
  assert.equal(hidden.data.total,0);
  const ownDirectory=await request('/members?search='+encodeURIComponent('合成驗收員'),self);
  assert.equal(ownDirectory.data.total,1);assert.equal(ownDirectory.data.items[0].user_id,host);
  assert.equal((await request('/members',real)).data.total,3);
  assert.equal((await request('/members',self)).data.total,4);
  assert.equal((await request('/members/presence?ids='+host,real)).data.items.length,0);
  assert.equal((await request('/members/presence?ids='+host,self)).data.items[0].user_id,host);
  assert.equal((await request('/members/'+host,real)).status,404);
  assert.equal((await request('/members/'+host,self)).status,200);
  await pool.query(`INSERT INTO member_friendships(community_id,low_ref,high_ref,requester_ref,state) VALUES($1,LEAST($2::uuid,$3::uuid),GREATEST($2::uuid,$3::uuid),$2,'accepted')`,[DEMO_COMMUNITY,real.user.user_id,host]);
  assert.ok(!ids( (await request('/friends',real)).data.items ).includes(host));
  assert.ok(ids((await request('/friends',self)).data.items).includes(real.user.user_id));
  await pool.query(`INSERT INTO member_social_links(link_id,community_id,user_id,platform,label,url,audiences) VALUES($1,$2,$3,'website','作品','https://example.com',ARRAY['public'])`,[randomUUID(),DEMO_COMMUNITY,host]);
  assert.equal((await request('/members/'+host+'/social-links',real)).status,404);
  assert.equal((await request('/members/'+host+'/social-links',self)).data.total,1);
  await pool.query('INSERT INTO member_avatars(user_id,community_id,image_bytes) VALUES($1,$2,$3)',[host,DEMO_COMMUNITY,Buffer.from([1])]);
  assert.equal((await app.request(origin+'/api/v1/members/'+host+'/avatar',{headers:{Origin:origin,Cookie:real.cookie}})).status,404);
  assert.equal((await app.request(origin+'/api/v1/members/'+host+'/avatar',{headers:{Origin:origin,Cookie:self.cookie}})).status,200);

  const adminId=randomUUID();
  const actor:AdminActor={admin_id:adminId,community_id:DEMO_COMMUNITY,email:'filter-admin@member.test',display_name:'篩選管理',role:'super_admin',subject:'verified-filter'};
  await pool.query('INSERT INTO platform_admins(admin_id,community_id,email,display_name) VALUES($1,$2,$3,$4)',[adminId,DEMO_COMMUNITY,actor.email,actor.display_name]);
  await pool.query(`INSERT INTO positioning_profession_memberships(membership_id,community_id,user_id,guild_key,state) VALUES($1,$2,$3,'guild_ai_vibe','active'),($4,$2,$5,'guild_ai_vibe','active')`,[randomUUID(),DEMO_COMMUNITY,host,randomUUID(),real.user.user_id]);
  await pool.query('INSERT INTO positioning_guild_officers(community_id,guild_key,user_id) VALUES($1,$2,$3)',[DEMO_COMMUNITY,'guild_ai_vibe',host]);
  await pool.query('INSERT INTO positioning_guild_experts(community_id,guild_key,user_id,appointed_by) VALUES($1,$2,$3,$4)',[DEMO_COMMUNITY,'guild_ai_vibe',host,adminId]);
  const directory=await request('/guilds/directory',real),ownGuild=await request('/guilds/directory',self);
  const guild=(items:any[])=>items.find(item=>item.guild_key==='guild_ai_vibe');
  assert.equal(guild(directory.data.items).guild_master,null);
  assert.deepEqual(guild(directory.data.items).guild_experts,[]);
  assert.equal(guild(ownGuild.data.items).guild_master.user_id,host);
  assert.equal(guild(ownGuild.data.items).guild_experts[0].user_id,host);
  assert.equal((await request('/members?guild_key=guild_ai_vibe',real)).data.items.some((item:any)=>item.user_id===host),false);
  assert.equal((await adminGuilds(pool,actor)).find(item=>item.guild_key==='guild_ai_vibe').member_count,1);
  assert.equal((await adminGuilds(pool,actor)).find(item=>item.guild_key==='guild_ai_vibe').guild_master,null);

  const made=await request('/squads',self,{name:'合成驗收小隊',kind:'project',purpose:'驗收用小隊'});
  assert.equal(made.status,201,JSON.stringify(made.data));
  const squadId=made.data.squad_id;
  assert.equal((await pool.query('SELECT is_test_data FROM member_squad_classification WHERE squad_id=$1',[squadId])).rows[0].is_test_data,true);
  assert.ok(!(await request('/squads',real)).data.items.some((item:any)=>item.squad_id===squadId));
  assert.ok((await request('/squads',self)).data.items.some((item:any)=>item.squad_id===squadId));
  assert.equal((await request('/squads/'+squadId,real)).status,404);
  await pool.query(`INSERT INTO member_squad_memberships(squad_id,user_id,state) VALUES($1,$2,'active')`,[squadId,real.user.user_id]);
  assert.ok(!(await request('/squads',real)).data.items.some((item:any)=>item.squad_id===squadId));
  const joined=await request('/squads/'+squadId,real);
  assert.equal(joined.status,200);assert.deepEqual(joined.data.members.map((item:any)=>item.user_id),[real.user.user_id]);
  assert.equal((await request('/squads',self)).data.items.find((item:any)=>item.squad_id===squadId).member_count,1);
  const invited=await request('/squads/'+squadId+'/invitations',self,{recipient_ref:peer});
  assert.equal(invited.status,200,JSON.stringify(invited.data));
  const inbound=await request('/me/squad-invitations',friend);
  assert.equal(inbound.data.items[0].squad_id,squadId);
  assert.equal((await request('/squad-invitations/'+inbound.data.items[0].invitation_id+'/accept',friend,{},inbound.data.items[0].aggregate_version)).status,200);
  assert.ok((await request('/squads/'+squadId,friend)).data.members.some((item:any)=>item.user_id===peer));
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM users WHERE user_id=ANY($1::uuid[])',[ [host,peer] ])).rows[0].n,2);

  assert.equal((await request('/me/channels/world/world/messages',self,{body:'世界驗收訊息'})).status,201);
  assert.equal((await request('/me/channels/guild/guild_ai_vibe/messages',self,{body:'公會驗收訊息'})).status,201);
  assert.equal((await request('/me/channels/squad/'+squadId+'/messages',self,{body:'小隊驗收訊息'})).status,201);
  const world=await request('/me/channels/world/world/messages',real),ownWorld=await request('/me/channels/world/world/messages',self);
  assert.ok(!world.data.items.some((item:any)=>item.body==='世界驗收訊息'));
  assert.ok(ownWorld.data.items.some((item:any)=>item.body==='世界驗收訊息'));
  assert.equal((await request('/me/channels?kind=world',real)).data.items.find((item:any)=>item.channel_key==='world').unread_count,0);
  assert.ok((await request('/me/channels/guild/guild_ai_vibe/messages',real)).data.items.some((item:any)=>item.body==='公會驗收訊息'));
  assert.ok((await request('/me/channels/squad/'+squadId+'/messages',real)).data.items.some((item:any)=>item.body==='小隊驗收訊息'));
});

test('events, feeds and admin statistics omit verification accounts without deleting them',async()=>{
  const host=await addUser(`event-${randomUUID()}@example.invalid`,'活動驗收員');
  const email=(await pool.query('SELECT email FROM users WHERE user_id=$1',[host])).rows[0].email as string;
  const self=await login(email),real=await login(DEMO_USERS[0].email),sharer=await login(DEMO_USERS[1].email),third=await login(DEMO_USERS[2].email);
  const hiddenEvent=randomUUID(),seats=randomUUID(),guests=randomUUID(),blocked=randomUUID(),shared=randomUUID();
  await eventRow(hiddenEvent,host,null);await eventRow(seats,real.user.user_id,1);await eventRow(guests,real.user.user_id,null);await eventRow(blocked,real.user.user_id,1);await eventRow(shared,real.user.user_id,null);
  assert.ok(!(await request('/events',real)).data.items.some((item:any)=>item.event_id===hiddenEvent));
  assert.ok((await request('/events',self)).data.items.some((item:any)=>item.event_id===hiddenEvent));
  assert.equal((await request('/events/'+hiddenEvent,real)).status,404);
  assert.equal((await request('/events/'+hiddenEvent,self)).status,200);
  assert.equal((await request('/public/events/'+hiddenEvent)).status,404);
  await pool.query(`INSERT INTO community_event_bulletins(bulletin_id,event_id,community_id,kind,actor_name,message) VALUES($1,$2,$3,'approved','活動驗收員','活動驗收員提交了公開活動')`,[randomUUID(),hiddenEvent,DEMO_COMMUNITY]);
  assert.ok(!(await request('/events/bulletins',real)).data.items.some((item:any)=>item.event_id===hiddenEvent));
  assert.ok((await request('/events/bulletins',self)).data.items.some((item:any)=>item.event_id===hiddenEvent));
  assert.equal((await request('/events/'+seats+'/rsvp',self,{going:true})).status,200);
  assert.equal((await request('/events',real)).data.items.find((item:any)=>item.event_id===seats).attending_count,0);
  assert.equal((await request('/events/'+seats+'/rsvp',real,{going:true})).status,200);
  assert.equal((await request('/events',real)).data.items.find((item:any)=>item.event_id===seats).attending_count,1);
  assert.equal((await request('/events/'+seats+'/rsvp',third,{going:true})).data.code,'event_full');
  await pool.query(`INSERT INTO community_event_guest_rsvps(event_id,email,name,email_sent_at) VALUES($1,'guest@member.test','來賓',now())`,[guests]);
  assert.equal((await request('/events',real)).data.items.find((item:any)=>item.event_id===guests).attending_count,1);
  await pool.query(`INSERT INTO community_event_guest_rsvps(event_id,email,name) VALUES($1,'waiting@member.test','未寄出')`,[blocked]);
  assert.equal((await request('/events/'+blocked+'/rsvp',real,{going:true})).data.code,'event_full');
  await pool.query(`INSERT INTO community_event_share_codes(event_id,user_id,code) VALUES($1,$2,'real-share-code-01'),($1,$3,'test-share-code-01')`,[shared,sharer.user.user_id,host]);
  assert.equal((await request('/events/'+shared+'/rsvp',self,{going:true,referral_code:'real-share-code-01'})).status,200);
  await pool.query(`INSERT INTO community_event_guest_rsvps(event_id,email,name,referred_by_user_id,email_sent_at) VALUES($1,'referred@member.test','分享來賓',$2,now())`,[shared,sharer.user.user_id]);
  const report=await request('/events/'+shared+'/referrals',real);
  assert.ok(!report.data.items.some((item:any)=>item.user_id===host));
  assert.equal(report.data.items.find((item:any)=>item.user_id===sharer.user.user_id).registrations,1);

  const showcase=randomUUID(),project=randomUUID(),version=randomUUID(),creation=randomUUID(),product=randomUUID();
  await pool.query(`INSERT INTO showcases(showcase_id,community_id,owner_ref,title,description,artifact_ref) VALUES($1,$2,$3,'驗收作品','說明','artifact-1')`,[showcase,DEMO_COMMUNITY,host]);
  assert.ok(!(await request('/showcases',real)).data.items.some((item:any)=>item.showcase_id===showcase));
  assert.ok((await request('/showcases',self)).data.items.some((item:any)=>item.showcase_id===showcase));
  await pool.query(`INSERT INTO oss_projects(project_id,community_id,owner_ref,title,description,use_notes,repository_id,repository_full_name,repository_url,relationship) VALUES($1,$2,$3,'開源','說明','用法','1382968099','FreeTWAI-AI/verify-filter','https://github.com/FreeTWAI-AI/verify-filter','author')`,[project,DEMO_COMMUNITY,host]);
  await pool.query(`INSERT INTO oss_project_versions(version_id,project_id,repository_id,commit_sha,default_branch,repository_full_name,repository_url,readme_url,license_spdx,is_fork,archived,source_snapshot,source_sha256,facts_sha256,inspected_at) VALUES($1,$2,'1382968099',$3,'main','FreeTWAI-AI/verify-filter','https://github.com/FreeTWAI-AI/verify-filter','https://github.com/FreeTWAI-AI/verify-filter#readme','MIT',false,false,'{}',$4,$4,now())`,[version,project,'b'.repeat(40),sha]);
  await pool.query('UPDATE oss_projects SET current_version_id=$2 WHERE project_id=$1',[project,version]);
  await pool.query(`INSERT INTO skill_submissions(submission_id,community_id,owner_ref,status,payload,payload_sha256,consent_to_share,project_id,project_version_id,published_at,grant_consumed_at) VALUES($1,$2,$3,'published',$4,$5,true,$6,$7,now(),now())`,[randomUUID(),DEMO_COMMUNITY,host,JSON.stringify({title:'驗收技能',description:'說明',relationship:'author',share_introductions:[],use_notes:'用法'}),sha,project,version]);
  await pool.query(`INSERT INTO co_creation_projects(project_id,community_id,source_project_id,coordinator_ref,title,goal,help_wanted,contribution_notes) VALUES($1,$2,$3,$4,'共創','目標',$5,'備註')`,[creation,DEMO_COMMUNITY,project,host,JSON.stringify(['development'])]);
  await pool.query(`INSERT INTO catalog_products(product_id,community_id,supplier_ref,title,specifications) VALUES($1,$2,$3,'驗收商品','規格')`,[product,DEMO_COMMUNITY,host]);
  await pool.query(`INSERT INTO supplier_offer_versions(offer_version_id,product_id,community_id,revision,supplier_ref,net_price_minor,currency,availability,stock,shipping_terms,return_terms,snapshot,snapshot_sha256) VALUES($1,$2,$3,1,$4,100,'TWD','finite',1,'自取','七日','{}',$5)`,[randomUUID(),product,DEMO_COMMUNITY,host,sha]);
  assert.ok(!(await request('/opensource/projects',real)).data.items.some((item:any)=>item.project_id===project));
  assert.ok((await request('/opensource/projects',self)).data.items.some((item:any)=>item.project_id===project));
  assert.ok(!(await request('/co-creation/projects',real)).data.items.some((item:any)=>item.project_id===creation));
  assert.ok((await request('/co-creation/projects',self)).data.items.some((item:any)=>item.project_id===creation));
  assert.ok(!(await request('/retail/catalog',real)).data.items.some((item:any)=>item.product_id===product));
  assert.ok((await request('/supplier/products',self)).data.items.some((item:any)=>item.product_id===product));
  const published=await app.request(origin+'/api/v1/skill-submissions/published?limit=20');
  assert.equal(published.status,200);
  assert.ok(!JSON.stringify(await published.json()).includes('驗收技能'));

  const work=randomUUID(),claim=randomUUID(),submission=randomUUID(),decision=randomUUID(),reviewWork=randomUUID(),reviewClaim=randomUUID();
  await pool.query(`INSERT INTO work_items(work_item_id,community_id,owner_ref,title,objective,acceptance_criteria,gain,state,participation_terms,participation_terms_sha256,claim_window_expires_at,due_at) VALUES($1,$2,$3,'驗收工作','目標','條件','收穫','open','{}',$4,now()+interval '7 days',now()+interval '14 days')`,[work,DEMO_COMMUNITY,real.user.user_id,sha]);
  await pool.query(`INSERT INTO work_claims(claim_id,work_item_id,claimant_ref,acting_profession_membership_ref,state,terms_revision,terms_sha256,terms_snapshot) VALUES($1,$2,$3,$4,'accepted',1,$5,'{}')`,[claim,work,host,randomUUID(),sha]);
  await pool.query(`INSERT INTO submissions(submission_id,claim_id,revision,summary,artifact_ref,sha256) VALUES($1,$2,1,'完成','artifact',$3)`,[submission,claim,sha]);
  await pool.query(`INSERT INTO work_decisions(decision_id,claim_id,submission_id,reviewer_ref,decision,feedback,submission_sha256) VALUES($1,$2,$3,$4,'accept','可以',$5)`,[decision,claim,submission,real.user.user_id,sha]);
  await pool.query(`INSERT INTO contributions(contribution_id,claim_id,user_id,community_id,work_item_id,decision_id,title,summary,artifact_ref) VALUES($1,$2,$3,$4,$5,$6,'驗收工作','完成','artifact')`,[randomUUID(),claim,host,DEMO_COMMUNITY,work,decision]);
  await pool.query(`INSERT INTO work_items(work_item_id,community_id,owner_ref,title,objective,acceptance_criteria,gain,state,participation_terms,participation_terms_sha256,claim_window_expires_at,due_at) VALUES($1,$2,$3,'待審','目標','條件','收穫','open','{}',$4,now()+interval '7 days',now()+interval '14 days')`,[reviewWork,DEMO_COMMUNITY,real.user.user_id,sha]);
  await pool.query(`INSERT INTO work_review_routes(work_item_id,reviewer_ref,valid_until) VALUES($1,$2,now()+interval '7 days')`,[reviewWork,real.user.user_id]);
  await pool.query(`INSERT INTO work_claims(claim_id,work_item_id,claimant_ref,acting_profession_membership_ref,state,terms_revision,terms_sha256,terms_snapshot) VALUES($1,$2,$3,$4,'submitted',1,$5,'{}')`,[reviewClaim,reviewWork,host,randomUUID(),sha]);
  assert.ok(!(await request('/community/accepted-work',real)).data.items.some((item:any)=>item.title==='驗收工作'));
  assert.ok((await request('/community/accepted-work',self)).data.items.some((item:any)=>item.title==='驗收工作'));
  assert.ok(!JSON.stringify((await request('/dashboard',real)).data.review_queue).includes('活動驗收員'));

  const adminId=randomUUID();
  const actor:AdminActor={admin_id:adminId,community_id:DEMO_COMMUNITY,email:'filter-admin@member.test',display_name:'篩選管理',role:'super_admin',subject:'verified-filter'};
  await pool.query('INSERT INTO platform_admins(admin_id,community_id,email,display_name) VALUES($1,$2,$3,$4)',[adminId,DEMO_COMMUNITY,actor.email,actor.display_name]);
  const testApplication=randomUUID(),realApplication=randomUUID();
  await pool.query(`INSERT INTO guild_creation_applications(application_id,community_id,user_id,name,profession,reason) VALUES($1,$2,$3,'驗收公會','測試','驗證用申請'),($4,$2,$5,'真實公會','設計','會員提出的申請')`,[testApplication,DEMO_COMMUNITY,host,realApplication,real.user.user_id]);
  const summary=(await adminBootstrap(pool,actor)).summary;
  assert.equal(summary.members,3);assert.equal(summary.active_members,3);assert.equal(summary.pending_guild_applications,1);
  const hiddenMembers=await adminMembers(pool,actor,20,0,'活動驗收員',false),shown=await adminMembers(pool,actor,20,0,'活動驗收員',true);
  assert.equal(hiddenMembers.items.length,0);assert.equal(shown.items.length,1);assert.equal(shown.items[0].is_test_account,true);
  const applications=await adminApplications(pool,actor,20,0,'all');
  assert.ok(applications.items.some(item=>item.application_id===realApplication));
  assert.ok(!applications.items.some(item=>item.application_id===testApplication));
  await pool.query('INSERT INTO skill_editorial_ownership(book_id,community_id) VALUES($1,$2)',[book,DEMO_COMMUNITY]);
  await pool.query('INSERT INTO skill_book_maintainers(book_id,community_id,user_id,appointed_by,active) VALUES($1,$2,$3,$4,true),($1,$2,$5,$4,true)',[book,DEMO_COMMUNITY,host,adminId,real.user.user_id]);
  const maintainers=(await listSkillMaintainers(pool,actor)).items.find(item=>item.book_id===book)!.maintainers;
  assert.deepEqual(maintainers.map(item=>item.user_id),[real.user.user_id]);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM users WHERE user_id=$1',[host])).rows[0].n,1);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM users WHERE lower(email) LIKE '%@example.invalid'")).rows[0].n,1);
});
