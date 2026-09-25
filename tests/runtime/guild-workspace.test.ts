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
import {changeGuildMembership} from '../../modules/positioning/service.js';
import {developmentGuilds} from '../../modules/development-access/service.js';

const databaseUrl=process.env.TEST_DATABASE_URL??LOCAL_DATABASE_URL,database=createPool(databaseUrl),schema=`fp_guild_workspace_${process.pid}_${Date.now()}`;
database.on('error',()=>{});
const pool=new Pool({connectionString:databaseUrl,options:`-c search_path=${schema} -c application_name=${schema}`,max:12});
pool.on('error',()=>{});
// Separate application names let race tests observe exactly which backend is waiting on which lock.
const racer=(role:string)=>{const extra=new Pool({connectionString:databaseUrl,options:`-c search_path=${schema}`,application_name:`${schema}_${role}`,max:2});extra.on('error',()=>{});return extra;};
const guild='guild_event_space',otherGuild='guild_projection_mapping',book='event-space',aiVibe='guild_ai_vibe',aiField='guild_ai_field';
const requiredGuilds=[{guild_key:aiField,name:'AI 導入與驗證公會'},{guild_key:aiVibe,name:'AI 開發公會'}];
const access=(appointed_books:number,active_guilds:string[])=>({appointed_books,eligible:active_guilds.length>0,requires_development_guild:appointed_books>0&&!active_guilds.length,active_guilds,required_guilds:requiredGuilds});
const emptyWorkspace={managed_guilds:[],managed_books:[],can_discuss:false,skill_editor_access:access(0,[])};
const admin:AdminActor={admin_id:randomUUID(),community_id:DEMO_COMMUNITY,email:'guild-admin@example.invalid',display_name:'管理測試者',role:'super_admin',subject:'verified-test'};
let actors:Actor[]=[];
const cmd=(actor:Actor,body:unknown,expected?:number,key=randomUUID()):Command=>({actor,body,expected:expected?String(expected):undefined,key,operation:'test-guild-workspace'});
const adm=(body:unknown,expected?:number,key=randomUUID(),who=admin):AdminCommand=>({admin:who,body,expected:expected?String(expected):undefined,key,operation:'test-admin-workspace'});
const denied=(status:number)=>((error:unknown)=>error instanceof Problem&&error.status===status);
const editorial={summary:'共讀與場地規劃技能書',collaboration_intro:'一起改善主持模板，範圍以維護者確認的 Issue 為準。',milestones:[{id:'m1',title:'主持模板'}],tasks:[{id:'task1',title:'補充讀書會提問',description:'用合成資料補兩種人數的範例。',acceptance:['主持人可照流程接手。'],issue_url:'https://github.com/FreeTWAI-AI/freedom-skill-event-space/issues/1',milestone_id:'m1',status:'todo' as const}]};
before(async()=>{await database.query(`CREATE SCHEMA ${schema}`);await migrate(pool);});
after(async()=>{
  try{await pool.end();}catch{/* still drop */}
  // Race pools are named `${schema}_${role}`. End the main pool first so idle clients are not killed out from under it.
  await database.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE pid<>pg_backend_pid() AND (application_name=$1 OR starts_with(application_name,$1||'_'))`,[schema]).catch(()=>{});
  try{await database.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);}finally{await database.end();}
});
beforeEach(async()=>{await pool.query('TRUNCATE communities,login_attempts,auth_rate_limits CASCADE');await seedLocal(pool);await pool.query('INSERT INTO platform_admins(admin_id,community_id,email,display_name) VALUES($1,$2,$3,$4)',[admin.admin_id,DEMO_COMMUNITY,admin.email,admin.display_name]);actors=await Promise.all(DEMO_USERS.map(async user=>(await login(pool,user.email,DEMO_PASSWORD)).actor));});
async function join(actor=actors[0],key=guild){await pool.query("INSERT INTO positioning_profession_memberships(membership_id,community_id,user_id,guild_key,state) VALUES($1,$2,$3,$4,'active') ON CONFLICT(community_id,user_id,guild_key) DO UPDATE SET state='active'",[randomUUID(),actor.community_id,actor.user_id,key]);}
async function lead(actor=actors[0],key=guild){await join(actor,key);await pool.query('INSERT INTO positioning_guild_officers(community_id,guild_key,user_id) VALUES($1,$2,$3) ON CONFLICT(community_id,guild_key) DO UPDATE SET user_id=$3',[actor.community_id,key,actor.user_id]);}
async function appoint(actor=actors[0]){return service.appointSkillMaintainer(pool,adm({user_id:actor.user_id,active:true,reason:'維護者已確認參與範圍。'}),book);}
/** Successful editing needs an explicit AI guild membership in addition to the appointment. */
async function appointEditor(actor=actors[0],key=aiField){await join(actor,key);return appoint(actor);}
async function changeGuild(actor:Actor,key:string,action:'join'|'leave',on=pool){const row=(await pool.query('SELECT aggregate_version FROM positioning_profession_memberships WHERE community_id=$1 AND user_id=$2 AND guild_key=$3',[actor.community_id,actor.user_id,key])).rows[0];return changeGuildMembership(on,{actor,body:{},expected:row?String(row.aggregate_version):undefined,key:randomUUID(),operation:`${action}/${key}`},key,action);}
const code=(value:string)=>((error:unknown)=>error instanceof Problem&&error.code===value);
/** Deterministic barrier: resolves once the racer backend is blocked on the given lock wait event. */
async function waitingOn(role:string,event:string){const name=`${schema}_${role}`;for(let i=0;i<2000;i++){if((await database.query("SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock' AND wait_event=$2",[name,event])).rowCount)return;await new Promise(resolve=>setImmediate(resolve));}throw Error(`${role} never waited on ${event}`);}
async function foreign(){const community=randomUUID(),user=randomUUID();await pool.query('INSERT INTO communities VALUES($1,$2)',[community,'Other']);await pool.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref) SELECT $1,$2,'outsider-workspace@example.invalid','Other member',password_hash,$3 FROM users LIMIT 1`,[user,community,randomUUID()]);const actor=(await login(pool,'outsider-workspace@example.invalid',DEMO_PASSWORD)).actor;const otherAdmin={...admin,admin_id:randomUUID(),community_id:community,email:'other-admin@example.invalid'};await pool.query('INSERT INTO platform_admins(admin_id,community_id,email,display_name) VALUES($1,$2,$3,$4)',[otherAdmin.admin_id,community,otherAdmin.email,'Other admin']);return {actor,admin:otherAdmin};}

test('workspace derives explicit current officer and maintainer capabilities without trusting a GitHub slug',async()=>{
 assert.deepEqual(await service.guildWorkspace(pool,actors[0]),emptyWorkspace);await lead();await appointEditor();
 const view=await service.guildWorkspace(pool,actors[0]);assert.deepEqual(view.managed_guilds,[{guild_key:guild,name:'活動與空間公會'}]);assert.deepEqual(view.managed_books,[{book_id:book,title:'活動與空間實作手冊'}]);assert.equal(view.can_discuss,true);assert.deepEqual(view.skill_editor_access,access(1,[aiField]));assert.equal(JSON.stringify(view).includes('@'),false);
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
 await appointEditor();await service.saveSkillEditorial(pool,cmd(actors[0],editorial),book);const thread=await service.createAdminCouncilThread(pool,adm({title:'僅議事',body:'secret discussion phrase'}));const key=randomUUID(),reply=adm({body:'private admin reply'},undefined,key);await service.replyAdminCouncilThread(pool,reply,thread.thread_id);await service.replyAdminCouncilThread(pool,reply,thread.thread_id);
 const detail=await service.getAdminCouncilThread(pool,admin,thread.thread_id);assert.equal(detail.replies.length,1);assert.equal((await pool.query("SELECT count(*)::int AS n FROM platform_admin_audit WHERE action='council_reply'")).rows[0].n,1);const pub=JSON.stringify(await service.readSkillEditorial(pool,book));assert.equal(pub.includes('secret discussion'),false);assert.equal(pub.includes('private admin'),false);
 await pool.query('UPDATE platform_admins SET active=false WHERE admin_id=$1',[admin.admin_id]);await assert.rejects(service.listAdminCouncil(pool,admin),denied(403));
});

test('editorial requires appointed book maintainers, preserves versions, and exports only public fields',async()=>{
 await lead();await join(actors[0],aiVibe);await join(actors[1],aiVibe);await assert.rejects(service.skillEditor(pool,actors[0],book),denied(403));await appoint();assert.equal((await service.skillEditor(pool,actors[0],book)).aggregate_version,0);
 const input=cmd(actors[0],editorial),saved=await service.saveSkillEditorial(pool,input,book);assert.equal(saved.aggregate_version,1);assert.deepEqual(await service.saveSkillEditorial(pool,input,book),saved);await assert.rejects(service.saveSkillEditorial(pool,cmd(actors[1],editorial),book),denied(403));
 const exported=await service.readSkillEditorial(pool,book);assert.deepEqual(Object.keys(exported!).sort(),['summary','collaboration_intro','milestones','tasks','updated_at','aggregate_version'].sort());assert.deepEqual(await service.readSkillEditorialSummaries(pool),{[book]:editorial.summary});
 const edits=await Promise.allSettled([service.saveSkillEditorial(pool,cmd(actors[0],{...editorial,summary:'改稿A'},1),book),service.saveSkillEditorial(pool,cmd(actors[0],{...editorial,summary:'改稿B'},1),book)]);assert.equal(edits.filter(r=>r.status==='fulfilled').length,1);assert.ok(edits.some(r=>r.status==='rejected'&&denied(412)(r.reason)));
 await service.appointSkillMaintainer(pool,adm({user_id:actors[0].user_id,active:false,reason:'交接後撤回維護權。'},1),book);await assert.rejects(service.saveSkillEditorial(pool,input,book),denied(403));await assert.rejects(service.skillEditor(pool,actors[0],book),denied(403));
});

test('opening the first editor preserves visible collaboration tasks and actual issue references without publishing',async()=>{
 await appointEditor();const basic=await service.skillEditor(pool,actors[0],book);
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
 await appointEditor();const task=editorial.tasks[0];for(const issue_url of ['javascript:alert(1)','https://github.com/other/repo/issues/1','https://github.com/FreeTWAI-AI/freedom-skill-event-space/issues/1?token=secret','https://github.com/FreeTWAI-AI/freedom-skill-event-space/pull/1'])await assert.rejects(service.saveSkillEditorial(pool,cmd(actors[0],{...editorial,tasks:[{...task,issue_url}]}),book),denied(422));
 await assert.rejects(service.saveSkillEditorial(pool,cmd(actors[0],{...editorial,milestones:[]}),book),denied(422));await assert.rejects(service.saveSkillEditorial(pool,cmd(actors[0],{...editorial,tasks:[task,task]}),book),denied(422));
 await assert.rejects(service.saveSkillEditorial(pool,cmd(actors[0],{...editorial,collaboration_intro:'內'.repeat(3000),tasks:[{...task,description:'內'.repeat(1500)}]}),book),denied(422));assert.equal(await service.readSkillEditorial(pool,book),null);
});

test('an explicit global book owner prevents other-community admins or maintainers from changing its public document',async()=>{
 await appointEditor();await service.saveSkillEditorial(pool,cmd(actors[0],editorial),book);const outsider=await foreign();await assert.rejects(service.appointSkillMaintainer(pool,adm({user_id:outsider.actor.user_id,active:true,reason:'跨社群越權'},undefined,randomUUID(),outsider.admin),book),denied(403));await assert.rejects(service.skillEditor(pool,outsider.actor,book),denied(403));await assert.rejects(service.saveSkillEditorial(pool,cmd(outsider.actor,editorial),book),denied(403));
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

test('skill editing needs BOTH the named appointment and a current AI guild; neither alone grants editing',async()=>{
 await appoint();assert.equal((await pool.query('SELECT count(*)::int AS n FROM positioning_profession_memberships WHERE user_id=$1 AND guild_key=ANY($2::text[])',[actors[0].user_id,developmentGuilds.skill])).rows[0].n,0,'appointment never adds guild membership');
 await assert.rejects(service.skillEditor(pool,actors[0],book),code('skill_editor_guild_required'));await assert.rejects(service.saveSkillEditorial(pool,cmd(actors[0],editorial),book),code('skill_editor_guild_required'));assert.equal(await service.readSkillEditorial(pool,book),null);
 assert.deepEqual(await service.guildWorkspace(pool,actors[0]),{...emptyWorkspace,skill_editor_access:access(1,[])});
 await join(actors[1],aiVibe);await join(actors[1],aiField);await assert.rejects(service.skillEditor(pool,actors[1],book),code('skill_maintainer_required'));await assert.rejects(service.saveSkillEditorial(pool,cmd(actors[1],editorial),book),code('skill_maintainer_required'));
 assert.deepEqual(await service.guildWorkspace(pool,actors[1]),{...emptyWorkspace,skill_editor_access:access(0,[aiField,aiVibe])});
 // An unrelated guild (even as its leader) does not satisfy the AI guild requirement.
 await lead();await assert.rejects(service.skillEditor(pool,actors[0],book),code('skill_editor_guild_required'));
});

test('either AI guild suffices; leaving one keeps editing, leaving the last denies GET, POST and replay; rejoining restores only the appointment',async()=>{
 await changeGuild(actors[0],aiVibe,'join');await changeGuild(actors[0],aiField,'join');await appoint();
 const grant=randomUUID(),devKey=randomUUID();await pool.query(`INSERT INTO development_grants(grant_id,community_id,user_id,capability,target_key,target_repository,target_repository_id,working_repository,working_repository_id,github_user_id,installation_id,app_id,guild_sources,policy_version) VALUES($1,$2,$3,'skill',$4,'FreeTWAI-AI/freedom-skill-event-space','1','contributor/freedom-skill-event-space','2','42','77','9',$5,'development-proposal-v1')`,[grant,actors[0].community_id,actors[0].user_id,book,[aiField,aiVibe]]);await pool.query('INSERT INTO development_keys(key_id,source_grant_id,secret_hash) VALUES($1,$2,$3)',[devKey,grant,'synthetic-'+devKey]);
 const first=cmd(actors[0],editorial),saved=await service.saveSkillEditorial(pool,first,book);assert.equal(saved.aggregate_version,1);
 await changeGuild(actors[0],aiVibe,'leave');assert.equal((await service.skillEditor(pool,actors[0],book)).aggregate_version,1);assert.deepEqual(await service.saveSkillEditorial(pool,first,book),saved);
 const second=cmd(actors[0],{...editorial,summary:'離開一個 AI 公會後仍可維護'},1);assert.equal((await service.saveSkillEditorial(pool,second,book)).aggregate_version,2);
 assert.deepEqual((await service.guildWorkspace(pool,actors[0])).skill_editor_access,access(1,[aiField]));
 await changeGuild(actors[0],aiField,'leave');
 await assert.rejects(service.skillEditor(pool,actors[0],book),code('skill_editor_guild_required'));await assert.rejects(service.saveSkillEditorial(pool,cmd(actors[0],{...editorial,summary:'離會後'},2),book),code('skill_editor_guild_required'));
 await assert.rejects(service.saveSkillEditorial(pool,second,book),code('skill_editor_guild_required'),'an idempotent replay re-checks current eligibility');
 const hidden=await service.guildWorkspace(pool,actors[0]);assert.deepEqual(hidden.managed_books,[]);assert.deepEqual(hidden.skill_editor_access,access(1,[]));assert.equal((await service.readSkillEditorial(pool,book))!.aggregate_version,2,'public reading is unchanged');
 const revoked=(await pool.query('SELECT revoked_at,revoke_reason FROM development_grants WHERE grant_id=$1',[grant])).rows[0];assert.equal(revoked.revoke_reason,'guild_eligibility_lost');
 await changeGuild(actors[0],aiField,'join');assert.equal((await service.skillEditor(pool,actors[0],book)).aggregate_version,2);assert.deepEqual((await service.guildWorkspace(pool,actors[0])).managed_books,[{book_id:book,title:'活動與空間實作手冊'}]);
 assert.equal((await service.saveSkillEditorial(pool,cmd(actors[0],{...editorial,summary:'重新加入後恢復'},2),book)).aggregate_version,3);
 const after=(await pool.query('SELECT g.revoked_at,g.revoke_reason,k.revoked_at AS key_revoked FROM development_grants g JOIN development_keys k ON k.source_grant_id=g.grant_id WHERE g.grant_id=$1',[grant])).rows[0];
 assert.deepEqual([after.revoked_at,after.revoke_reason],[revoked.revoked_at,'guild_eligibility_lost'],'editor eligibility never revives a revoked development grant');assert.notEqual(after.key_revoked,null);
 // Revoking the appointment still denies even with a current AI guild.
 await service.appointSkillMaintainer(pool,adm({user_id:actors[0].user_id,active:false,reason:'交接後撤回維護權。'},1),book);await assert.rejects(service.skillEditor(pool,actors[0],book),code('skill_maintainer_required'));assert.deepEqual((await service.guildWorkspace(pool,actors[0])).skill_editor_access,access(0,[aiField]));
});

test('disabled members and other-community members fail closed even with an appointment and an AI guild',async()=>{
 await appointEditor();const input=cmd(actors[0],editorial);await service.saveSkillEditorial(pool,input,book);
 const outsider=await foreign();await join(outsider.actor,aiVibe);await assert.rejects(service.skillEditor(pool,outsider.actor,book),code('skill_maintainer_required'));await assert.rejects(service.saveSkillEditorial(pool,cmd(outsider.actor,editorial),book),denied(403));assert.equal((await service.guildWorkspace(pool,outsider.actor)).skill_editor_access.appointed_books,0);
 await pool.query('UPDATE users SET active=false WHERE user_id=$1',[actors[0].user_id]);await assert.rejects(service.skillEditor(pool,actors[0],book),denied(401));await assert.rejects(service.saveSkillEditorial(pool,input,book),denied(401));await assert.rejects(service.guildWorkspace(pool,actors[0]),denied(401));
});

test('race: a leave that commits first makes a save waiting on the guild lock fail',async()=>{
 await changeGuild(actors[0],aiField,'join');await appoint();const leaver=racer('leave'),saver=racer('save'),holder=await pool.connect();
 try{
  // Hold the membership row so the real leave takes the guild advisory lock and then blocks before committing.
  await holder.query('BEGIN');await holder.query('SELECT 1 FROM positioning_profession_memberships WHERE user_id=$1 AND guild_key=$2 FOR KEY SHARE',[actors[0].user_id,aiField]);
  const leave=changeGuild(actors[0],aiField,'leave',leaver);await waitingOn('leave','transactionid');
  const save=service.saveSkillEditorial(saver,cmd(actors[0],editorial),book);await waitingOn('save','advisory');
  await holder.query('COMMIT');
  const [left,saved]=await Promise.allSettled([leave,save]);assert.equal(left.status,'fulfilled');assert.equal(saved.status,'rejected');assert.ok(code('skill_editor_guild_required')((saved as PromiseRejectedResult).reason));
  assert.equal(await service.readSkillEditorial(pool,book),null);
 }finally{await holder.query('ROLLBACK').catch(()=>{});holder.release();await leaver.end().catch(()=>{});await saver.end().catch(()=>{});}
});

test('race: a save that already holds the guild lock completes before a concurrent leave, which then denies further edits',async()=>{
 await changeGuild(actors[0],aiField,'join');await appoint();const leaver=racer('leave2'),saver=racer('save2'),holder=await pool.connect();
 try{
  // Block the save after authorization (it already holds the guild lock) on its per-book editorial lock.
  await holder.query('BEGIN');await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`skill-editorial/${book}`]);
  const save=service.saveSkillEditorial(saver,cmd(actors[0],editorial),book);await waitingOn('save2','advisory');
  const leave=changeGuild(actors[0],aiField,'leave',leaver);await waitingOn('leave2','advisory');
  await holder.query('COMMIT');
  const [saved,left]=await Promise.allSettled([save,leave]);assert.equal(saved.status,'fulfilled');assert.equal((saved as PromiseFulfilledResult<any>).value.aggregate_version,1);assert.equal(left.status,'fulfilled');
  assert.equal((await service.readSkillEditorial(pool,book))!.summary,editorial.summary);await assert.rejects(service.skillEditor(pool,actors[0],book),code('skill_editor_guild_required'));
 }finally{await holder.query('ROLLBACK').catch(()=>{});holder.release();await leaver.end().catch(()=>{});await saver.end().catch(()=>{});}
});

test('race: workspace GET waits on the guild lock of an AI guild officer leaving, without holding membership rows, then reflects the leave',async()=>{
 await lead(actors[0],aiField);await appoint();const leaver=racer('leave3'),reader=racer('workspace3'),holder=await pool.connect(),probe=await pool.connect();
 const pid=async(role:string)=>(await database.query('SELECT pid FROM pg_stat_activity WHERE application_name=$1 AND state<>$2',[`${schema}_${role}`,'idle'])).rows[0].pid as number;
 try{
  assert.deepEqual((await service.guildWorkspace(pool,actors[0])).managed_guilds,[{guild_key:aiField,name:'AI 導入與驗證公會'}]);
  // The leave takes the guild advisory lock, then blocks on its membership FOR UPDATE until the holder commits.
  await holder.query('BEGIN');await holder.query('SELECT 1 FROM positioning_profession_memberships WHERE user_id=$1 AND guild_key=$2 FOR KEY SHARE',[actors[0].user_id,aiField]);
  const leave=changeGuild(actors[0],aiField,'leave',leaver);await waitingOn('leave3','transactionid');
  const view=service.guildWorkspace(reader,actors[0]);await waitingOn('workspace3','advisory');
  const [leavePid,readerPid]=[await pid('leave3'),await pid('workspace3')];
  assert.deepEqual((await database.query('SELECT pg_blocking_pids($1) AS pids',[readerPid])).rows[0].pids,[leavePid],'the reader waits only on the leave');
  // Previously managedGuilds took FOR SHARE OF m,o here; the reader must hold neither while waiting.
  await probe.query('BEGIN');await probe.query("SET LOCAL lock_timeout='1ms'");
  assert.equal((await probe.query('SELECT 1 FROM positioning_guild_officers WHERE community_id=$1 AND user_id=$2 FOR UPDATE NOWAIT',[actors[0].community_id,actors[0].user_id])).rowCount,1);
  await probe.query('ROLLBACK');
  await holder.query('COMMIT');
  const [left,seen]=await Promise.allSettled([leave,view]);assert.equal(left.status,'fulfilled');assert.equal(seen.status,'fulfilled',String((seen as PromiseRejectedResult).reason));
  assert.deepEqual((seen as PromiseFulfilledResult<any>).value,{...emptyWorkspace,skill_editor_access:access(1,[])},'the committed leave removes officer and editor views');
 }finally{await holder.query('ROLLBACK').catch(()=>{});await probe.query('ROLLBACK').catch(()=>{});holder.release();probe.release();await leaver.end().catch(()=>{});await reader.end().catch(()=>{});}
});

test('HTTP skill editor routes enforce the AI guild requirement and expose the recovery DTO',async()=>{
 const origin='http://127.0.0.1:4310',app=createApp(pool,origin,'local');await appoint();
 const auth=await login(pool,DEMO_USERS[0].email,DEMO_PASSWORD),headers=()=>({Origin:origin,Cookie:`freedom_local_session=${auth.token}`,'X-CSRF-Token':auth.actor.csrf_token,'Content-Type':'application/json','Idempotency-Key':randomUUID()});
 const path=origin+'/api/v1/skill-books/'+book+'/editor',body=JSON.stringify(editorial);
 const blocked=await app.request(path,{headers:headers()});assert.equal(blocked.status,403);assert.equal((await blocked.json()).code,'skill_editor_guild_required');
 assert.equal((await app.request(path,{method:'POST',headers:headers(),body})).status,403);
 const workspace=await (await app.request(origin+'/api/v1/guild-workspace',{headers:headers()})).json();assert.deepEqual(workspace.managed_books,[]);assert.deepEqual(workspace.skill_editor_access,access(1,[]));
 await changeGuild(auth.actor,aiVibe,'join');assert.equal((await app.request(path,{headers:headers()})).status,200);
 const replayHeaders=headers(),saved=await app.request(path,{method:'POST',headers:replayHeaders,body});assert.equal(saved.status,200,await saved.clone().text());
 await changeGuild(auth.actor,aiVibe,'leave');assert.equal((await app.request(path,{method:'POST',headers:replayHeaders,body})).status,403);assert.equal((await app.request(path,{headers:headers()})).status,403);
});
