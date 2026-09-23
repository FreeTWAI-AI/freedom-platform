import {test,before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {createPool,LOCAL_DATABASE_URL,type Command} from '../../packages/db/index.js';
import {migrate} from '../../scripts/database.js';
import {seedLocal,DEMO_USERS,DEMO_PASSWORD,DEMO_COMMUNITY} from '../../packages/testing/seed.js';
import {login,type Actor} from '../../modules/identity-membership/service.js';
import type {AdminActor,AdminCommand} from '../../modules/platform-admin/service.js';
import {Problem} from '../../packages/shared/problem.js';
import * as service from '../../modules/guild-workspace/service.js';
import {createApp} from '../../apps/platform-api/src/app.js';

const databaseUrl=process.env.TEST_DATABASE_URL??LOCAL_DATABASE_URL,database=createPool(databaseUrl),schema=`fp_guild_workspace_${process.pid}_${Date.now()}`;
const pool=new Pool({connectionString:databaseUrl,options:`-c search_path=${schema}`,max:12});
const guild='guild_event_space',otherGuild='guild_projection_mapping',book='event-space';
const admin:AdminActor={admin_id:randomUUID(),community_id:DEMO_COMMUNITY,email:'guild-admin@example.invalid',display_name:'管理測試者',role:'super_admin',subject:'verified-test'};
let actors:Actor[]=[];
const cmd=(actor:Actor,body:unknown,expected?:number,key=randomUUID()):Command=>({actor,body,expected:expected?String(expected):undefined,key,operation:'test-guild-workspace'});
const adm=(body:unknown,expected?:number,key=randomUUID(),who=admin):AdminCommand=>({admin:who,body,expected:expected?String(expected):undefined,key,operation:'test-admin-workspace'});
const denied=(status:number)=>((error:unknown)=>error instanceof Problem&&error.status===status);
const editorial={summary:'共讀與場地規劃技能書',collaboration_intro:'一起改善主持模板，範圍以維護者確認的 Issue 為準。',milestones:[{id:'m1',title:'主持模板'}],tasks:[{id:'task1',title:'補充讀書會提問',description:'用合成資料補兩種人數的範例。',acceptance:['主持人可照流程接手。'],issue_url:'https://github.com/FreeTWAI-AI/freedom-skill-event-space/issues/1',milestone_id:'m1',status:'todo' as const}]};
before(async()=>{await database.query(`CREATE SCHEMA ${schema}`);await migrate(pool);});
after(async()=>{await pool.end();await database.query(`DROP SCHEMA ${schema} CASCADE`);await database.end();});
beforeEach(async()=>{await pool.query('TRUNCATE communities,login_attempts,auth_rate_limits CASCADE');await seedLocal(pool);await pool.query('INSERT INTO platform_admins(admin_id,community_id,email,display_name) VALUES($1,$2,$3,$4)',[admin.admin_id,DEMO_COMMUNITY,admin.email,admin.display_name]);actors=await Promise.all(DEMO_USERS.map(async user=>(await login(pool,user.email,DEMO_PASSWORD)).actor));});
async function join(actor=actors[0],key=guild){await pool.query("INSERT INTO positioning_profession_memberships(membership_id,community_id,user_id,guild_key,state) VALUES($1,$2,$3,$4,'active') ON CONFLICT(community_id,user_id,guild_key) DO UPDATE SET state='active'",[randomUUID(),actor.community_id,actor.user_id,key]);}
async function lead(actor=actors[0],key=guild){await join(actor,key);await pool.query('INSERT INTO positioning_guild_officers(community_id,guild_key,user_id) VALUES($1,$2,$3) ON CONFLICT(community_id,guild_key) DO UPDATE SET user_id=$3',[actor.community_id,key,actor.user_id]);}
async function appoint(actor=actors[0]){return service.appointSkillMaintainer(pool,adm({user_id:actor.user_id,active:true,reason:'維護者已確認參與範圍。'}),book);}
async function foreign(){const community=randomUUID(),user=randomUUID();await pool.query('INSERT INTO communities VALUES($1,$2)',[community,'Other']);await pool.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref) SELECT $1,$2,'outsider-workspace@example.invalid','Other member',password_hash,$3 FROM users LIMIT 1`,[user,community,randomUUID()]);const actor=(await login(pool,'outsider-workspace@example.invalid',DEMO_PASSWORD)).actor;const otherAdmin={...admin,admin_id:randomUUID(),community_id:community,email:'other-admin@example.invalid'};await pool.query('INSERT INTO platform_admins(admin_id,community_id,email,display_name) VALUES($1,$2,$3,$4)',[otherAdmin.admin_id,community,otherAdmin.email,'Other admin']);return {actor,admin:otherAdmin};}

test('workspace derives explicit current officer and maintainer capabilities without trusting a GitHub slug',async()=>{
 assert.deepEqual(await service.guildWorkspace(pool,actors[0]),{managed_guilds:[],managed_books:[],can_discuss:false});await lead();await appoint();
 const view=await service.guildWorkspace(pool,actors[0]);assert.deepEqual(view.managed_guilds,[{guild_key:guild,name:'活動與空間公會'}]);assert.deepEqual(view.managed_books,[{book_id:book,title:'活動與空間實作手冊'}]);assert.equal(view.can_discuss,true);assert.equal(JSON.stringify(view).includes('@'),false);
 await pool.query("UPDATE positioning_profession_memberships SET state='left' WHERE user_id=$1",[actors[0].user_id]);assert.equal((await service.guildWorkspace(pool,actors[0])).can_discuss,false);
});

test('announcements expose published text only to active same-guild members; only the current leader publishes',async()=>{
 await lead();await join(actors[1]);await lead(actors[2],otherGuild);
 const draft=await service.createGuildAnnouncement(pool,cmd(actors[0],{title:'草稿',body:'<script>alert(1)</script>',state:'draft'}),guild);
 assert.equal(draft.body,'<script>alert(1)</script>');assert.equal((await service.guildAnnouncements(pool,actors[0],guild)).items.length,1);assert.equal((await service.guildAnnouncements(pool,actors[1],guild)).items.length,0);
 await assert.rejects(service.guildAnnouncements(pool,actors[2],guild),denied(403));await assert.rejects(service.createGuildAnnouncement(pool,cmd(actors[1],{title:'越權',body:'不應發布',state:'published'}),guild),denied(403));
 await service.editGuildAnnouncement(pool,cmd(actors[0],{title:'已發布',body:'讀書會公告',state:'published'},1),draft.announcement_id);assert.equal((await service.guildAnnouncements(pool,actors[1],guild)).items[0].title,'已發布');
 await assert.rejects(service.editGuildAnnouncement(pool,cmd(actors[2],{title:'越權',body:'不應改別公會',state:'published'},2),draft.announcement_id),denied(403));
});

test('announcement lost updates are rejected; replay loses authority after an officer replacement',async()=>{
 await lead();const input=cmd(actors[0],{title:'討論',body:'一起共讀。',state:'published'}),created=await service.createGuildAnnouncement(pool,input,guild);assert.deepEqual(await service.createGuildAnnouncement(pool,input,guild),created);
 const edits=await Promise.allSettled([service.editGuildAnnouncement(pool,cmd(actors[0],{title:'新版A',body:'第一版更新',state:'published'},1),created.announcement_id),service.editGuildAnnouncement(pool,cmd(actors[0],{title:'新版B',body:'第二版更新',state:'archived'},1),created.announcement_id)]);assert.equal(edits.filter(r=>r.status==='fulfilled').length,1);assert.ok(edits.some(r=>r.status==='rejected'&&denied(412)(r.reason)));
 await lead(actors[1]);await assert.rejects(service.createGuildAnnouncement(pool,input,guild),denied(403));
});

test('council is private to current active leaders and verified admins, scoped to a community',async()=>{
 await lead();await lead(actors[1],otherGuild);const created=await service.createGuildCouncilThread(pool,cmd(actors[0],{title:'跨公會合作',body:'private council marker'}));await service.replyGuildCouncilThread(pool,cmd(actors[1],{body:'共同討論'}),created.thread_id);
 const view=await service.getGuildCouncilThread(pool,actors[1],created.thread_id);assert.equal(view.replies.length,1);assert.equal('author_user_id' in view,false);assert.equal('email' in view.replies[0],false);
 await assert.rejects(service.listGuildCouncil(pool,actors[2]),denied(403));assert.equal((await service.listAdminCouncil(pool,admin)).items.length,1);
 const outsider=await foreign();await lead(outsider.actor);assert.equal((await service.listGuildCouncil(pool,outsider.actor)).items.length,0);await assert.rejects(service.getGuildCouncilThread(pool,outsider.actor,created.thread_id),denied(404));assert.equal((await service.listAdminCouncil(pool,outsider.admin)).items.length,0);await assert.rejects(service.getAdminCouncilThread(pool,outsider.admin,created.thread_id),denied(404));
 await pool.query('DELETE FROM positioning_guild_officers WHERE community_id=$1 AND user_id=$2',[actors[1].community_id,actors[1].user_id]);await assert.rejects(service.getGuildCouncilThread(pool,actors[1],created.thread_id),denied(403));
});

test('admin council replies are audited without copying private discussion text into the public editorial',async()=>{
 await appoint();await service.saveSkillEditorial(pool,cmd(actors[0],editorial),book);const thread=await service.createAdminCouncilThread(pool,adm({title:'僅議事',body:'secret discussion phrase'}));const key=randomUUID(),reply=adm({body:'private admin reply'},undefined,key);await service.replyAdminCouncilThread(pool,reply,thread.thread_id);await service.replyAdminCouncilThread(pool,reply,thread.thread_id);
 const detail=await service.getAdminCouncilThread(pool,admin,thread.thread_id);assert.equal(detail.replies.length,1);assert.equal((await pool.query("SELECT count(*)::int AS n FROM platform_admin_audit WHERE action='council_reply'")).rows[0].n,1);const pub=JSON.stringify(await service.readSkillEditorial(pool,book));assert.equal(pub.includes('secret discussion'),false);assert.equal(pub.includes('private admin'),false);
 await pool.query('UPDATE platform_admins SET active=false WHERE admin_id=$1',[admin.admin_id]);await assert.rejects(service.listAdminCouncil(pool,admin),denied(403));
});

test('editorial requires appointed book maintainers, preserves versions, and exports only public fields',async()=>{
 await lead();await assert.rejects(service.skillEditor(pool,actors[0],book),denied(403));await appoint();assert.equal((await service.skillEditor(pool,actors[0],book)).aggregate_version,0);
 const input=cmd(actors[0],editorial),saved=await service.saveSkillEditorial(pool,input,book);assert.equal(saved.aggregate_version,1);assert.deepEqual(await service.saveSkillEditorial(pool,input,book),saved);await assert.rejects(service.saveSkillEditorial(pool,cmd(actors[1],editorial),book),denied(403));
 const exported=await service.readSkillEditorial(pool,book);assert.deepEqual(Object.keys(exported!).sort(),['summary','collaboration_intro','milestones','tasks','updated_at','aggregate_version'].sort());assert.deepEqual(await service.readSkillEditorialSummaries(pool),{[book]:editorial.summary});
 const edits=await Promise.allSettled([service.saveSkillEditorial(pool,cmd(actors[0],{...editorial,summary:'改稿A'},1),book),service.saveSkillEditorial(pool,cmd(actors[0],{...editorial,summary:'改稿B'},1),book)]);assert.equal(edits.filter(r=>r.status==='fulfilled').length,1);assert.ok(edits.some(r=>r.status==='rejected'&&denied(412)(r.reason)));
 await service.appointSkillMaintainer(pool,adm({user_id:actors[0].user_id,active:false,reason:'交接後撤回維護權。'},1),book);await assert.rejects(service.saveSkillEditorial(pool,input,book),denied(403));await assert.rejects(service.skillEditor(pool,actors[0],book),denied(403));
});

test('opening the first editor preserves visible collaboration tasks and actual issue references without publishing',async()=>{
 await appoint();const basic=await service.skillEditor(pool,actors[0],book);
 assert.equal(basic.aggregate_version,0);assert.equal(basic.updated_at,null);assert.equal(basic.tasks.length,1);
 assert.equal(basic.tasks[0].id,'proposal-1');assert.equal(basic.tasks[0].milestone_id,'first-contribution');assert.equal(basic.tasks[0].issue_url,null);assert.equal(basic.tasks[0].status,'todo');
 assert.equal(await service.readSkillEditorial(pool,book),null);
 const video='video-autopilot';await service.appointSkillMaintainer(pool,adm({user_id:actors[0].user_id,active:true,reason:'協作剪輯框架維護'}),video);
 const initial=await service.skillEditor(pool,actors[0],video);
 assert.equal(initial.aggregate_version,0);assert.equal(initial.tasks.length,5);assert.equal(initial.milestones.length,1);
 assert.deepEqual(initial.tasks.map(task=>task.id),['issue-1','issue-2','issue-3','issue-4','issue-5']);
 assert.deepEqual(initial.tasks.map(task=>task.issue_url),[1,2,3,4,5].map(n=>`https://github.com/FreeTWAI-AI/video-autopilot-kit/issues/${n}`));
 assert.ok(initial.tasks.every(task=>task.status==='todo'&&task.milestone_id==='first-contribution'&&task.acceptance.length>0));
 assert.match(initial.collaboration_intro,/Hao/);assert.equal(await service.readSkillEditorial(pool,video),null);
 const {book_id,aggregate_version,updated_at,...fields}=initial;
 const saved=await service.saveSkillEditorial(pool,cmd(actors[0],{...fields,summary:'更新摘要，保留大家正在看的五項共創任務。'}),video);
 assert.equal(saved.aggregate_version,1);assert.deepEqual(saved.tasks,initial.tasks);
 assert.deepEqual((await service.skillEditor(pool,actors[0],video)).tasks,initial.tasks);
});

test('editorial rejects foreign issue targets, missing milestones, duplicate tasks and oversized UTF8 payloads',async()=>{
 await appoint();const task=editorial.tasks[0];for(const issue_url of ['javascript:alert(1)','https://github.com/other/repo/issues/1','https://github.com/FreeTWAI-AI/freedom-skill-event-space/issues/1?token=secret','https://github.com/FreeTWAI-AI/freedom-skill-event-space/pull/1'])await assert.rejects(service.saveSkillEditorial(pool,cmd(actors[0],{...editorial,tasks:[{...task,issue_url}]}),book),denied(422));
 await assert.rejects(service.saveSkillEditorial(pool,cmd(actors[0],{...editorial,milestones:[]}),book),denied(422));await assert.rejects(service.saveSkillEditorial(pool,cmd(actors[0],{...editorial,tasks:[task,task]}),book),denied(422));
 await assert.rejects(service.saveSkillEditorial(pool,cmd(actors[0],{...editorial,collaboration_intro:'內'.repeat(3000),tasks:[{...task,description:'內'.repeat(1500)}]}),book),denied(422));assert.equal(await service.readSkillEditorial(pool,book),null);
});

test('an explicit global book owner prevents other-community admins or maintainers from changing its public document',async()=>{
 await appoint();await service.saveSkillEditorial(pool,cmd(actors[0],editorial),book);const outsider=await foreign();await assert.rejects(service.appointSkillMaintainer(pool,adm({user_id:outsider.actor.user_id,active:true,reason:'跨社群越權'},undefined,randomUUID(),outsider.admin),book),denied(403));await assert.rejects(service.skillEditor(pool,outsider.actor,book),denied(403));await assert.rejects(service.saveSkillEditorial(pool,cmd(outsider.actor,editorial),book),denied(403));
 // An unowned global book cannot be silently claimed in a multi-community database.
 await assert.rejects(service.appointSkillMaintainer(pool,adm({user_id:outsider.actor.user_id,active:true,reason:'試圖搶未指定書籍'},undefined,randomUUID(),outsider.admin),'projection-mapping'),denied(409));assert.equal((await service.listSkillMaintainers(pool,outsider.admin)).items.find(b=>b.book_id===book)?.maintainers.length,0);
});

test('stale sessions and disabled users cannot read workspace facts or replay a successful mutation',async()=>{
 await lead();const input=cmd(actors[0],{title:'原本有效',body:'公開公告',state:'published'});await service.createGuildAnnouncement(pool,input,guild);await pool.query('UPDATE sessions SET revoked_at=now() WHERE token_hash=$1',[actors[0].session_hash]);await assert.rejects(service.guildWorkspace(pool,actors[0]),denied(401));await assert.rejects(service.createGuildAnnouncement(pool,input,guild),denied(401));
 await lead(actors[1],otherGuild);await pool.query('UPDATE users SET active=false WHERE user_id=$1',[actors[1].user_id]);await assert.rejects(service.listGuildCouncil(pool,actors[1]),denied(401));
});

test('HTTP workspace uses existing member Origin, CSRF and onboarding guards; admin assignment uses verified Access CSRF',async()=>{
 await lead();const origin='http://127.0.0.1:4310',access=async(request:Request)=>{assert.equal(request.headers.get('cf-access-jwt-assertion'),'verified-fixture');return {email:admin.email,subject:admin.subject,csrfToken:'fixture-admin-csrf'};};const app=createApp(pool,origin,'local',{adminVerifier:access});
 const auth=await login(pool,DEMO_USERS[0].email,DEMO_PASSWORD),headers={Origin:origin,Cookie:`freedom_local_session=${auth.token}`,'X-CSRF-Token':auth.actor.csrf_token,'Content-Type':'application/json','Idempotency-Key':randomUUID()};
 const get=await app.request(origin+'/api/v1/guild-workspace',{headers});assert.equal(get.status,200,await get.text());
 const body=JSON.stringify({title:'公告',body:'討論活動場地',state:'published'}),path=origin+'/api/v1/guilds/'+guild+'/announcements';
 assert.equal((await app.request(path,{method:'POST',headers:{...headers,'X-CSRF-Token':''},body})).status,403);assert.equal((await app.request(path,{method:'POST',headers:{...headers,Origin:'https://other.invalid'},body})).status,403);
 assert.equal((await app.request(path,{method:'POST',headers,body})).status,201);await pool.query('UPDATE users SET onboarding_required=true WHERE user_id=$1',[auth.actor.user_id]);assert.equal((await app.request(path,{headers})).status,403);
 const adminHeaders={Origin:origin,'Cf-Access-Jwt-Assertion':'verified-fixture','X-Admin-CSRF':'fixture-admin-csrf','Content-Type':'application/json','Idempotency-Key':randomUUID()},assignment=JSON.stringify({user_id:actors[1].user_id,active:true,reason:'指定技能書維護者'}),adminPath=origin+'/admin/api/skill-maintainers/'+book;
 assert.equal((await app.request(adminPath,{method:'POST',headers:{...adminHeaders,'X-Admin-CSRF':''},body:assignment})).status,403);const created=await app.request(adminPath,{method:'POST',headers:adminHeaders,body:assignment});assert.equal(created.status,200,await created.text());
});
