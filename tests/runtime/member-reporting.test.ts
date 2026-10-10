import {test,before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import sharp from 'sharp';
import {FakeObjectStore} from '../../packages/asset-storage/fake-store.js';
import {createSocialThumbnailAssetService,resolveSocialThumbnailUploadPolicy} from '../../modules/assets/social-thumbnail.js';
import {createPool,type Command} from '../../packages/db/index.js';
import {migrate} from '../../scripts/database.js';
import {seedLocal,DEMO_USERS,DEMO_PASSWORD,DEMO_COMMUNITY} from '../../packages/testing/seed.js';
import {createApp} from '../../apps/platform-api/src/app.js';
import {login,type Actor} from '../../modules/identity-membership/service.js';
import {createNativeSocialPost,createSocialComment,listSocialPosts,listSocialComments,readSocialThumbnail} from '../../modules/community/social-posts.js';
import {createMessageImageAssetService} from '../../modules/assets/message-image.js';
import {uploadMessageImage,readMessageImage} from '../../modules/member-communications/images.js';
import {memberCard} from '../../modules/identity-membership/members.js';
import {sendDirectMessage} from '../../modules/member-communications/service.js';
import {sendChannelMessage} from '../../modules/member-communications/channels.js';
import {createMemberReport,listMyMemberReports,listAdminMemberReports,readAdminMemberReport,readAdminReportImage,transitionMemberReport} from '../../modules/community/member-reporting.js';
import {Problem} from '../../packages/shared/problem.js';

const url=process.env.TEST_DATABASE_URL;
if(!url)throw new Error('An explicit disposable TEST_DATABASE_URL is required.');
const schema=`fp_member_reporting_${process.pid}_${Date.now()}`,database=createPool(url);
const pool=new Pool({connectionString:url,options:`-c search_path=${schema}`,max:12});
const [A,B,C]=DEMO_USERS.map(user=>user.user_id),origin='http://127.0.0.1:4371';
let actors:Actor[]=[];
before(async()=>{await database.query(`CREATE SCHEMA ${schema}`);await migrate(pool);});
after(async()=>{await pool.end();await database.query(`DROP SCHEMA ${schema} CASCADE`);await database.end();});
beforeEach(async()=>{
  await pool.query('TRUNCATE communities,login_attempts,auth_rate_limits CASCADE');await seedLocal(pool);
  await pool.query('UPDATE users SET email_verified_at=now() WHERE user_id=$1',[C]);
  await pool.query('INSERT INTO platform_admins(admin_id,community_id,email,display_name) VALUES($1,$2,$3,$4)',[randomUUID(),DEMO_COMMUNITY,DEMO_USERS[2].email,'合成審查員']);
  actors=await Promise.all(DEMO_USERS.map(async user=>(await login(pool,user.email,DEMO_PASSWORD)).actor));
});
const cmd=(actor:Actor,operation:string,body:unknown,expected?:number,key=randomUUID()):Command=>({actor,operation,key,body,expected:expected===undefined?undefined:String(expected)});
const report=(actor:Actor,kind:string,id:string,key=randomUUID(),reason='harassment')=>createMemberReport(pool,cmd(actor,'POST /api/v1/me/reports',{target_kind:kind,target_id:id,reason,note:'合成私人證據說明'},undefined,key));
const move=(id:string,version:number,state:'in_progress'|'closed',action:'none'|'hide'|'restore'='none',actor=actors[2],key=randomUUID())=>transitionMemberReport(pool,cmd(actor,`POST /api/v1/admin/reports/${id}/transition`,{state,reason:'合成案件處理理由',summary:'已檢視並記錄實際動作。',action},version,key),id);
const status=(n:number)=>(error:unknown)=>error instanceof Problem&&error.status===n;
const post=()=>createNativeSocialPost(pool,cmd(actors[1],'create-post',{text:'可見的合成貼文正文'}));
const count=async(table:string)=>(await pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n as number;

test('permission matrix keeps private evidence from reporter projection, reported member, third party and guild-title non-admin',async()=>{
  const p=await post(),r=await report(actors[0],'post',p.post_id);
  assert.ok(r.case_number);assert.equal(r.state,'received');
  const mine=await listMyMemberReports(pool,actors[0]);assert.equal(mine.items[0].case_id,r.case_id);
  const safe=JSON.stringify(mine);assert.equal(safe.includes('合成私人證據說明'),false);assert.equal(safe.includes('可見的合成貼文正文'),false);
  assert.equal((await listMyMemberReports(pool,actors[1])).items.length,0);
  // A real guild title is intentionally insufficient for platform-wide evidence access.
  const guild=(await pool.query('SELECT guild_key FROM positioning_guild_catalog ORDER BY guild_key LIMIT 1')).rows[0].guild_key;
  await pool.query('INSERT INTO positioning_guild_officers(community_id,guild_key,user_id) VALUES($1,$2,$3)',[DEMO_COMMUNITY,guild,B]);
  for(const actor of [actors[0],actors[1]])await assert.rejects(listAdminMemberReports(pool,actor),status(403));
  const admin=await listAdminMemberReports(pool,actors[2]);assert.equal(admin.items[0].case_id,r.case_id);
  assert.equal(JSON.stringify(admin).includes('可見的合成貼文正文'),false);
  assert.ok(JSON.stringify(await readAdminMemberReport(pool,actors[2],r.case_id)).includes('可見的合成貼文正文'));
  for(const actor of [actors[0],actors[1]])await assert.rejects(readAdminMemberReport(pool,actor,r.case_id),status(403));
  await pool.query('UPDATE platform_admins SET active=false');
  assert.equal((await listMyMemberReports(pool,actors[2])).items.length,0);
  await assert.rejects(listAdminMemberReports(pool,actors[2]),status(403));
  await assert.rejects(move(r.case_id,r.aggregate_version,'in_progress','none',actors[1]),status(403));
});

test('reportable visibility is checked for all five real content targets and hidden/cross-community targets fail closed',async()=>{
  const p=await post(),comment=await createSocialComment(pool,cmd(actors[1],'create-comment',{text:'可見留言'}),p.post_id);
  const dm=await sendDirectMessage(pool,cmd(actors[1],'send-private',{body:'只有收件人可見的合成訊息'}),A);
  const channel=await sendChannelMessage(pool,cmd(actors[1],'send-world',{body:'合成共同頻道訊息'}),'world','world');
  for(const [kind,id] of [['post',p.post_id],['comment',comment.comment_id],['direct_message',dm.message_id],['channel_message',channel.message_id],['member',B]])assert.ok((await report(actors[0],kind,id)).case_number);
  await assert.rejects(report(actors[2],'direct_message',dm.message_id),status(404));
  await pool.query("UPDATE community_social_posts SET state='hidden' WHERE post_id=$1",[p.post_id]);
  await assert.rejects(report(actors[0],'post',p.post_id),status(404));
  await assert.rejects(report(actors[0],'comment',comment.comment_id),status(404));
  await assert.rejects(report(actors[0],'member',randomUUID()),status(404));
  const community=randomUUID(),outsider=randomUUID();await pool.query('INSERT INTO communities VALUES($1,$2)',[community,'合成外社群']);
  await pool.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref) SELECT $1,$2,$3,'外社群會員',password_hash,$4 FROM users WHERE user_id=$5`,[outsider,community,`${outsider}@example.invalid`,randomUUID(),A]);
  await assert.rejects(report(actors[0],'member',outsider),status(404));
});

test('dedupe serializes concurrent submissions and immutable server snapshot survives edits; replay uses original key',async()=>{
  const p=await post(),key=randomUUID();
  const reports=await Promise.all([report(actors[0],'post',p.post_id,key),report(actors[0],'post',p.post_id,key),report(actors[0],'post',p.post_id,randomUUID(),'spam')]);
  assert.equal(new Set(reports.map(r=>r.case_id)).size,1);assert.equal(await count('member_reports'),1);
  await pool.query("UPDATE community_social_posts SET note='編輯後正文' WHERE post_id=$1",[p.post_id]);
  const admin=JSON.stringify(await readAdminMemberReport(pool,actors[2],reports[0].case_id));assert.ok(admin.includes('可見的合成貼文正文'));assert.equal(admin.includes('編輯後正文'),false);
  const before=await count('transition_journal');await report(actors[0],'post',p.post_id,key);assert.equal(await count('transition_journal'),before);
  await assert.rejects(report(actors[0],'post',p.post_id,key,'fraud'),status(409));
});

test('serialized rate limit rejects the 21st new case but dedupe and existing replay do not consume budget',async()=>{
  const ids:string[]=[];
  for(let i=0;i<21;i++){const row=(await pool.query(`INSERT INTO community_social_posts(community_id,author_user_id,kind,platform,title,note,state) VALUES($1,$2,'note','other',$3,$3,'active') RETURNING post_id`,[DEMO_COMMUNITY,B,`合成頻率案例 ${i}`])).rows[0];ids.push(row.post_id);}
  const results=await Promise.allSettled(ids.map(id=>report(actors[0],'post',id)));
  assert.equal(results.filter(r=>r.status==='fulfilled').length,20);
  const failed=results.find(r=>r.status==='rejected') as PromiseRejectedResult;assert.ok(status(429)(failed.reason));
  const accepted=ids[results.findIndex(r=>r.status==='fulfilled')];assert.ok((await report(actors[0],'post',accepted)).case_number);
  assert.equal(await count('member_reports'),20);assert.equal((await pool.query('SELECT count(*)::int n FROM users WHERE active')).rows[0].n,3);
});

test('concurrent CAS transitions have one winner, hide/restore actions are real and audited, old replay cannot restore stale state',async()=>{
  const p=await post(),r=await report(actors[0],'post',p.post_id),key=randomUUID();
  const attempts=await Promise.allSettled([move(r.case_id,r.aggregate_version,'in_progress','hide',actors[2],key),move(r.case_id,r.aggregate_version,'in_progress','hide')]);
  assert.equal(attempts.filter(a=>a.status==='fulfilled').length,1);
  const successful=attempts.find(a=>a.status==='fulfilled');assert.ok(successful?.status==='fulfilled');const winner=successful.value;
  assert.equal((await listSocialPosts(pool,actors[0],{})).items.some(item=>item.post_id===p.post_id),false);
  const closed=await move(r.case_id,winner.aggregate_version,'closed','restore');assert.equal(closed.state,'closed');
  assert.equal((await listSocialPosts(pool,actors[0],{})).items.some(item=>item.post_id===p.post_id),true);
  assert.equal((await listMyMemberReports(pool,actors[0])).items[0].state,'closed');
  const facts=(await pool.query("SELECT command,data FROM transition_journal WHERE aggregate_type='member_report' AND aggregate_id=$1 ORDER BY aggregate_version",[r.case_id])).rows;
  assert.ok(facts.length>=3);assert.ok(JSON.stringify(facts).includes('hide'));assert.ok(JSON.stringify(facts).includes('restore'));
  await assert.rejects(move(r.case_id,closed.aggregate_version,'in_progress'),status(409));
});

test('audit failure rolls back moderation and case status, never displaying a failed operation as handled',async()=>{
  const p=await post(),r=await report(actors[0],'post',p.post_id);
  await pool.query(`CREATE FUNCTION fail_report_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.aggregate_type='member_report' THEN RAISE EXCEPTION 'synthetic report audit failure'; END IF; RETURN NEW; END $$`);
  await pool.query('CREATE TRIGGER report_audit_failure BEFORE INSERT ON transition_journal FOR EACH ROW EXECUTE FUNCTION fail_report_audit()');
  try{await assert.rejects(move(r.case_id,r.aggregate_version,'in_progress','hide'),/synthetic report audit failure/);}finally{await pool.query('DROP TRIGGER report_audit_failure ON transition_journal');await pool.query('DROP FUNCTION fail_report_audit()');}
  assert.equal((await listMyMemberReports(pool,actors[0])).items[0].state,'received');
  assert.equal((await listSocialPosts(pool,actors[0],{})).items.some(item=>item.post_id===p.post_id),true);
});

test('retired asset thumbnail restoration returns a clear conflict and preserves the entire case and evidence',async()=>{
  const store=new FakeObjectStore();
  const bytes=await sharp({create:{width:40,height:20,channels:3,background:'green'}}).png().toBuffer();
  await pool.query("UPDATE domain_media_storage_policy SET mode='bridge',policy_revision='synthetic-report-media',persistence_allowed=true,retained_byte_limit=10485760 WHERE purpose='community.social-thumbnail'");
  const assets=createSocialThumbnailAssetService(pool,{store,resolvePolicy:resolveSocialThumbnailUploadPolicy});
  const p=await createNativeSocialPost(pool,cmd(actors[1],'POST /api/v1/social-posts/notes',{text:'合成圖片貼文',image:{mime_type:'image/png',data_base64:bytes.toString('base64')}}),new Date(),assets);
  const r=await report(actors[0],'post',p.post_id);
  const asset=(await pool.query('SELECT asset_id FROM community_social_thumbnail_asset_targets WHERE post_id=$1',[p.post_id])).rows[0].asset_id;
  const hidden=await move(r.case_id,r.aggregate_version,'in_progress','hide');
  assert.equal((await pool.query('SELECT state FROM assets WHERE asset_id=$1',[asset])).rows[0].state,'retired');
  assert.equal((await pool.query('SELECT asset_id FROM community_social_thumbnail_asset_targets WHERE post_id=$1',[p.post_id])).rows[0].asset_id,null);
  const snapshot=async()=>({
    post:(await pool.query('SELECT * FROM community_social_posts WHERE post_id=$1',[p.post_id])).rows,
    thumbnail:(await pool.query('SELECT * FROM community_social_post_thumbnails WHERE post_id=$1',[p.post_id])).rows,
    target:(await pool.query('SELECT * FROM community_social_thumbnail_asset_targets WHERE post_id=$1',[p.post_id])).rows,
    asset:(await pool.query('SELECT * FROM assets WHERE asset_id=$1',[asset])).rows,
    objects:(await pool.query('SELECT * FROM asset_objects WHERE asset_id=$1',[asset])).rows,
    report:(await pool.query('SELECT * FROM member_reports WHERE case_id=$1',[r.case_id])).rows,
    journals:await count('transition_journal'),receipts:await count('command_receipts'),
  });
  const before=await snapshot();
  await assert.rejects(move(r.case_id,hidden.aggregate_version,'closed','restore'),error=>error instanceof Problem&&error.status===409&&error.code==='report_restore_media_unavailable');
  assert.deepEqual(await snapshot(),before);
  // The database guard remains authoritative even if application preflight is bypassed.
  await assert.rejects(pool.query("UPDATE community_social_posts SET state='active' WHERE post_id=$1",[p.post_id]),error=>(error as {code?:string}).code==='23514');
  assert.deepEqual(await snapshot(),before);
  await assert.rejects(readSocialThumbnail(pool,actors[0],p.post_id,store),status(404));
  assert.equal((await move(r.case_id,hidden.aggregate_version,'closed','none')).state,'closed');
});

test('comment hiding and restoration preserve parent visibility and audit the actual comment action',async()=>{
  const p=await post(),comment=await createSocialComment(pool,cmd(actors[1],'create-comment',{text:'合成可撤銷留言'}),p.post_id);
  const r=await report(actors[0],'comment',comment.comment_id);
  const hidden=await move(r.case_id,r.aggregate_version,'in_progress','hide');
  assert.equal((await listSocialComments(pool,actors[0],p.post_id)).items.some(item=>item.comment_id===comment.comment_id),false);
  assert.equal((await listSocialPosts(pool,actors[0],{})).items.some(item=>item.post_id===p.post_id),true);
  await move(r.case_id,hidden.aggregate_version,'closed','restore');
  assert.equal((await listSocialComments(pool,actors[0],p.post_id)).items.some(item=>item.comment_id===comment.comment_id),true);
  assert.equal((await pool.query("SELECT count(*)::int n FROM transition_journal WHERE aggregate_type='member_report' AND aggregate_id=$1",[r.case_id])).rows[0].n,3);
});

test('live session and administrator revocation deny direct service reads/writes and receipt replay',async()=>{
  const p=await post(),key=randomUUID(),r=await report(actors[0],'post',p.post_id,key);
  await pool.query('UPDATE sessions SET revoked_at=now() WHERE token_hash=$1',[actors[0].session_hash]);
  await assert.rejects(listMyMemberReports(pool,actors[0]),status(401));await assert.rejects(report(actors[0],'post',p.post_id,key),status(401));
  await pool.query('UPDATE users SET email_verified_at=NULL WHERE user_id=$1',[C]);
  await assert.rejects(listAdminMemberReports(pool,actors[2]),status(403));await assert.rejects(move(r.case_id,r.aggregate_version,'in_progress'),status(403));
});

test('feature OFF returns 404 before auth for every reporting route and site flag is exact boolean',async()=>{
  const off=createApp(pool,origin,'local',{memberReportingEnabled:false}),on=createApp(pool,origin,'local',{memberReportingEnabled:true});
  for(const [method,path] of [['GET','/me/reports'],['POST','/me/reports'],['GET','/admin/reports'],['GET',`/admin/reports/${randomUUID()}`],['GET',`/admin/reports/${randomUUID()}/image`],['POST',`/admin/reports/${randomUUID()}/transition`]])assert.equal((await off.request(origin+'/api/v1'+path,{method})).status,404);
  assert.equal((await (await off.request(origin+'/api/v1/site')).json() as {member_reporting_enabled:boolean}).member_reporting_enabled,false);
  assert.equal((await (await on.request(origin+'/api/v1/site')).json() as {member_reporting_enabled:boolean}).member_reporting_enabled,true);
  assert.equal((await on.request(origin+'/api/v1/me/reports')).status,401);
});

test('deployed routes enforce member CSRF, version and admin authority without exposing reporter identity',async()=>{
  const app=createApp(pool,origin,'local',{memberReportingEnabled:true}),p=await post();
  async function headersFor(index:number){
    const response=await app.request(origin+'/api/v1/auth/login',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({email:DEMO_USERS[index].email,password:DEMO_PASSWORD})});
    assert.equal(response.status,200);
    const body=await response.json() as {csrf_token:string};
    return {Origin:origin,Cookie:response.headers.get('set-cookie')!.split(';')[0],'X-CSRF-Token':body.csrf_token,'Content-Type':'application/json','Idempotency-Key':randomUUID()};
  }
  const reporter=await headersFor(0),reported=await headersFor(1),admin=await headersFor(2),body=JSON.stringify({target_kind:'post',target_id:p.post_id,reason:'harassment'});
  const {['X-CSRF-Token']:unused,...noCsrf}=reporter;
  assert.equal((await app.request(origin+'/api/v1/me/reports',{method:'POST',headers:noCsrf,body})).status,403);
  const created=await app.request(origin+'/api/v1/me/reports',{method:'POST',headers:reporter,body});
  assert.equal(created.status,201);
  const r=await created.json() as {case_id:string;aggregate_version:number};
  assert.equal((await app.request(origin+'/api/v1/admin/reports',{headers:reported})).status,403);
  const mine=await app.request(origin+'/api/v1/me/reports',{headers:reported});
  assert.deepEqual(await mine.json(),{items:[],next_cursor:null});
  const transition=origin+`/api/v1/admin/reports/${r.case_id}/transition`,moveBody=JSON.stringify({state:'in_progress',reason:'合成處理理由',summary:'已檢視',action:'none'});
  assert.equal((await app.request(transition,{method:'POST',headers:admin,body:moveBody})).status,428);
  assert.equal((await app.request(transition,{method:'POST',headers:{...reported,'If-Match':`"${r.aggregate_version}"`},body:moveBody})).status,403);
  const handled=await app.request(transition,{method:'POST',headers:{...admin,'Idempotency-Key':randomUUID(),'If-Match':`"${r.aggregate_version}"`},body:moveBody});
  assert.equal(handled.status,200);
  const safe=JSON.stringify(await (await app.request(origin+'/api/v1/me/reports',{headers:reporter})).json());
  assert.equal(safe.includes(A),false);assert.equal(safe.includes('可見的合成貼文正文'),false);
});


test('member evidence freezes the reporter-visible card while excluding hidden contact fields',async()=>{
  await pool.query('DELETE FROM member_friendships');
  await pool.query(`INSERT INTO member_accounts(user_id,community_id,contacts) VALUES($1,$2,$3::jsonb)
    ON CONFLICT(user_id) DO UPDATE SET contacts=excluded.contacts`,[B,DEMO_COMMUNITY,JSON.stringify({discord:{value:'visible-before',audiences:['public']},github:{value:'hidden-before',audiences:[]},email:{audiences:[]}})]);
  const visible=await memberCard(pool,actors[0],B),r=await report(actors[0],'member',B);
  const evidence=(await readAdminMemberReport(pool,actors[2],r.case_id)).evidence as {content:unknown};
  assert.deepEqual(evidence.content,visible);
  assert.ok(JSON.stringify(evidence).includes('visible-before'));assert.equal(JSON.stringify(evidence).includes('hidden-before'),false);assert.equal(JSON.stringify(evidence).includes(DEMO_USERS[1].email),false);
  await pool.query("UPDATE users SET display_name='changed after report' WHERE user_id=$1",[B]);
  await pool.query("UPDATE member_accounts SET contacts='{}'::jsonb WHERE user_id=$1",[B]);
  assert.deepEqual((await readAdminMemberReport(pool,actors[2],r.case_id)).evidence,evidence);
});

test('report queues are bounded, state-filtered and cursor-stable across newly arriving cases',async()=>{
  for(let i=0;i<27;i++)await pool.query(`INSERT INTO member_reports(community_id,reporter_user_id,target_kind,target_id,reason,evidence,state) VALUES($1,$2,'post',$3,'spam',$4::jsonb,$5)`,[DEMO_COMMUNITY,i===26?B:A,randomUUID(),JSON.stringify({private_marker:'never-in-list'}),i%2?'closed':'received']);
  const first=await listAdminMemberReports(pool,actors[2],{limit:10});assert.equal(first.items.length,10);assert.ok(first.next_cursor);
  assert.equal(JSON.stringify(first).includes('never-in-list'),false);assert.equal('evidence' in first.items[0],false);assert.equal('note' in first.items[0],false);
  await pool.query(`INSERT INTO member_reports(community_id,reporter_user_id,target_kind,target_id,reason,evidence) VALUES($1,$2,'post',$3,'spam','{}')`,[DEMO_COMMUNITY,A,randomUUID()]);
  const second=await listAdminMemberReports(pool,actors[2],{limit:10,cursor:first.next_cursor});assert.equal(second.items.length,10);assert.equal(second.items.some(row=>first.items.some(old=>old.case_id===row.case_id)),false);
  const closed=await listAdminMemberReports(pool,actors[2],{state:'closed'});assert.equal(closed.items.length,13);assert.ok(closed.items.every(row=>row.state==='closed'));assert.equal(closed.next_cursor,null);
  const mine=await listMyMemberReports(pool,actors[0]);assert.equal(mine.items.length,20);assert.ok(mine.next_cursor);
  const rest=await listMyMemberReports(pool,actors[0],{cursor:mine.next_cursor});assert.equal(rest.items.length,7);assert.equal(rest.next_cursor,null);
  await assert.rejects(listMyMemberReports(pool,actors[0],{limit:51}));await assert.rejects(listAdminMemberReports(pool,actors[2],{cursor:'9999999999999999999'}));
});

async function imageReport(){
  const store=new FakeObjectStore();
  await pool.query("UPDATE domain_media_storage_policy SET mode='r2_only',policy_revision='report-evidence',persistence_allowed=true,retained_byte_limit=104857600 WHERE purpose='member.message-image'");
  const bytes=await sharp({create:{width:40,height:30,channels:3,background:'#227799'}}).png().toBuffer();
  const uploaded=await uploadMessageImage(pool,cmd(actors[1],'upload-evidence',{}),A,{bytes,mime:'image/png'},createMessageImageAssetService(pool,{store}));
  const message=await sendDirectMessage(pool,cmd(actors[1],'send-evidence',{image_id:uploaded.image_id}),A,{messageImages:true});
  const original=await readMessageImage(pool,actors[0],B,message.message_id,store),r=await report(actors[0],'direct_message',message.message_id);
  return {store,message,original,r,uploaded};
}
test('private image evidence survives retraction and preserves immutable original bytes without giving members admin reads',async()=>{
  const {store,message,original,r,uploaded}=await imageReport();
  const detail=await readAdminMemberReport(pool,actors[2],r.case_id);assert.equal(detail.image_url,`/api/v1/admin/reports/${r.case_id}/image`);
  await pool.query('UPDATE member_direct_messages SET retracted_at=clock_timestamp() WHERE message_id=$1',[message.message_id]);
  await assert.rejects(readMessageImage(pool,actors[0],B,message.message_id,store),status(404));
  assert.deepEqual(await readAdminReportImage(pool,actors[2],r.case_id,store),original);
  for(const actor of [actors[0],actors[1]])await assert.rejects(readAdminReportImage(pool,actor,r.case_id,store),status(403));
  await assert.rejects(pool.query('DELETE FROM member_message_image_asset_targets WHERE image_id=$1',[uploaded.image_id]),/permanent/);
  await assert.rejects(pool.query('UPDATE member_message_image_asset_targets SET asset_id=NULL,linked_at_version=NULL WHERE image_id=$1',[uploaded.image_id]),/immutable/);
  await assert.rejects(pool.query("UPDATE member_reports SET evidence='{}' WHERE case_id=$1",[r.case_id]),/immutable/);
  await assert.rejects(report(actors[0],'direct_message',message.message_id),status(404));
  const app=createApp(pool,origin,'local',{memberReportingEnabled:true,messageImageAssetStore:store});
  assert.equal((await app.request(origin+detail.image_url!)).status,401);
  const logged=await login(pool,DEMO_USERS[2].email,DEMO_PASSWORD);
  const response=await app.request(origin+detail.image_url!,{headers:{Cookie:`freedom_local_session=${logged.token}`}});
  assert.equal(response.status,200);assert.equal(response.headers.get('Cache-Control'),'private, no-store');assert.equal(response.headers.get('Vary'),'Cookie');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()),original);
});
for(const change of ['session-revoked','session-expired','admin-revoked'] as const)test(`image evidence rejects ${change} committed during object I/O`,async()=>{
  const {store,r}=await imageReport(),originalGet=store.get.bind(store);let changed=false;
  store.get=async key=>{if(!changed){changed=true;if(change==='admin-revoked')await pool.query('UPDATE platform_admins SET active=false');else if(change==='session-revoked')await pool.query('UPDATE sessions SET revoked_at=clock_timestamp() WHERE token_hash=$1',[actors[2].session_hash]);else await pool.query("UPDATE sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=$1",[actors[2].session_hash]);}return originalGet(key);};
  await assert.rejects(readAdminReportImage(pool,actors[2],r.case_id,store),status(change==='admin-revoked'?403:401));assert.equal(changed,true);
});
