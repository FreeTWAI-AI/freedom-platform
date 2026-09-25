import { test,before,after,beforeEach,type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { Pool } from 'pg';
import { createPool,LOCAL_DATABASE_URL } from '../../packages/db/index.js';
import { migrate } from '../../scripts/database.js';
import { seedLocal,DEMO_USERS,DEMO_PASSWORD } from '../../packages/testing/seed.js';
import { authenticate,tokenHash } from '../../modules/identity-membership/service.js';
import { createApp } from '../../apps/platform-api/src/app.js';
import { isAgentSkillUploadPath } from '../../apps/platform-api/src/routes/skill-submissions.js';
import { importProject } from '../../modules/opensource-marketing/service.js';
import { listPublishedSkillSubmissions,readPublishedSkillSubmission,readPublishedSkillIllustration } from '../../modules/skill-submissions/public.js';

const origin='http://127.0.0.1:4310',databaseUrl=process.env.TEST_DATABASE_URL??LOCAL_DATABASE_URL;
const schema=`fp_skill_submission_test_${process.pid}_${Date.now()}`,admin=createPool(databaseUrl);
const pool=new Pool({connectionString:databaseUrl,options:`-c search_path=${schema}`,max:12});

// Exercise the real global Origin/body/session middleware and public routes.
const platform=createApp(pool,origin);
const app=platform;

interface Session{cookie:string;csrf:string;user:any}
before(async()=>{await admin.query(`CREATE SCHEMA ${schema}`);await migrate(pool);});
after(async()=>{await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();});
beforeEach(async()=>{await pool.query('TRUNCATE communities,login_attempts,auth_rate_limits CASCADE');await seedLocal(pool);});

async function api(path:string,session?:Session,body?:unknown,version?:string|number,key:string=randomUUID()){
 const headers:Record<string,string>={Origin:origin,...(session?{Cookie:session.cookie,'X-CSRF-Token':session.csrf}:{})};
 if(body!==undefined){headers['Content-Type']='application/json';headers['Idempotency-Key']=key;if(version!==undefined)headers['If-Match']=`"${version}"`;}
 const response=await app.request(origin+'/api/v1'+path,{method:body===undefined?'GET':'POST',headers,body:body===undefined?undefined:JSON.stringify(body)});
 const type=response.headers.get('Content-Type')??'';
 return {status:response.status,data:type.includes('json')?await response.json() as any:null,response};
}
async function agent(path:string,token:string|null,body:unknown,extra:Record<string,string>={}){
 const headers:Record<string,string>={'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{}),...extra};
 const response=await app.request(origin+'/agent-api/v1'+path,{method:'POST',headers,body:typeof body==='string'?body:JSON.stringify(body)});
 return {status:response.status,data:await response.json() as any};
}
async function login(email=DEMO_USERS[0].email):Promise<Session>{
 const r=await api('/auth/login',undefined,{email,password:DEMO_PASSWORD});assert.equal(r.status,200,JSON.stringify(r.data));
 return {cookie:r.response.headers.get('set-cookie')!.split(';')[0],csrf:r.data.csrf_token,user:r.data.user};
}
async function newKey(session:Session,label='我的 Agent'){const r=await api('/me/skill-upload-keys',session,{label});assert.equal(r.status,201,JSON.stringify(r.data));return r.data;}
async function agentDraft(key:string,idem=randomUUID()){const r=await agent('/skill-submissions',key,{},{'Idempotency-Key':idem});assert.equal(r.status,201,JSON.stringify(r.data));return r.data;}
const intros=(n=100)=>Array.from({length:n},(_,i)=>`第 ${i+1} 則介紹：這個技能幫助團隊整理共同筆記`);
const payload=(extra:Record<string,unknown>={})=>({repository_url:'https://github.com/example/project',title:'共同筆記技能',description:'把會議紀錄整理成可重用的筆記。',use_notes:'先閱讀 README，再在自己的 fork 試用。',demo_url:null,relationship:'author',share_introductions:intros(),...extra});
async function secretsAbsent(...secrets:string[]){
 for(const table of ['skill_submissions','skill_upload_keys','skill_agent_receipts','command_receipts','transition_journal','outbox','auth_rate_limits']){
  const text=(await pool.query(`SELECT coalesce(string_agg(row_to_json(t)::text,''),'') AS all FROM ${table} t`)).rows[0].all as string;
  for(const secret of secrets)assert.equal(text.includes(secret),false,`${table} must not contain a raw credential`);
 }
}
function mockGitHub(t:TestContext){
 const seen:string[]=[],sha='b'.repeat(40);
 t.mock.method(globalThis,'fetch',async(url:string,init:RequestInit)=>{
  seen.push(url);assert.equal(new URL(url).hostname,'api.github.com');assert.equal(init.redirect,'manual');assert.notEqual(init.redirect,'error');
  if(url==='https://api.github.com/repos/example/project')return Response.json({id:777,full_name:'example/project',private:false,visibility:'public',default_branch:'main',fork:false,archived:false});
  if(url==='https://api.github.com/repos/example/project/commits/main')return Response.json({sha});
  if(url===`https://api.github.com/repos/example/project/license?ref=${sha}`)return Response.json({path:'LICENSE',license:{spdx_id:'Apache-2.0'}});
  throw new Error('unexpected url');
 });
 return {seen,sha};
}
async function uploaded(session:Session,extra:Record<string,unknown>={}){
 const key=await newKey(session),draft=await agentDraft(key.token);
 const r=await agent(`/skill-submissions/${draft.submission.submission_id}`,draft.upload_grant.token,payload(extra));assert.equal(r.status,200,JSON.stringify(r.data));
 return (await api(`/me/skill-submissions/${draft.submission.submission_id}`,session)).data;
}
const png=(w=64,h=48)=>sharp({create:{width:w,height:h,channels:3,background:{r:200,g:120,b:40}}}).png().toBuffer();

function deferred(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};}

test('upload keys: secret shown once, only SHA-256 stored, replay hides token, owner-only revoke and ten-key limit',async()=>{
 const owner=await login(),other=await login(DEMO_USERS[1].email),idem=randomUUID();
 const first=await api('/me/skill-upload-keys',owner,{label:'筆電 Agent',expires_in_days:7},undefined,idem);
 assert.equal(first.status,201);assert.match(first.data.token,/^fpk_[A-Za-z0-9_-]{43}$/);
 assert.deepEqual(Object.keys(first.data.key).sort(),['created_at','expires_at','key_id','label','last_used_at','revoked_at','scope']);
 assert.equal(first.data.key.scope,'skill:submit');
 const replay=await api('/me/skill-upload-keys',owner,{label:'筆電 Agent',expires_in_days:7},undefined,idem);
 assert.equal(replay.data.token,null);assert.equal(replay.data.key.key_id,first.data.key.key_id);
 assert.equal((await pool.query('SELECT token_hash FROM skill_upload_keys')).rows[0].token_hash,tokenHash(first.data.token));
 await secretsAbsent(first.data.token);
 const listed=(await api('/me/skill-upload-keys',owner)).data.items;assert.equal(listed.length,1);assert.equal(JSON.stringify(listed).includes('hash'),false);
 assert.equal((await api('/me/skill-upload-keys',other)).data.items.length,0);
 assert.equal((await api('/me/skill-upload-keys',owner,{label:'x',expires_in_days:91})).status,422);
 assert.equal((await api('/me/skill-upload-keys',owner,{label:'x',scope:'admin'})).status,422);
 assert.equal((await api(`/me/skill-upload-keys/${first.data.key.key_id}/revoke`,other,{})).status,404);
 const revoked=await api(`/me/skill-upload-keys/${first.data.key.key_id}/revoke`,owner,{});assert.equal(revoked.status,200);assert.ok(revoked.data.revoked_at);
 assert.equal((await agent('/skill-submissions',first.data.token,{},{'Idempotency-Key':randomUUID()})).data.code,'upload_key_invalid');
 for(let i=0;i<10;i++)await newKey(owner,`key ${i}`);
 assert.equal((await api('/me/skill-upload-keys',owner,{label:'eleventh'})).data.code,'upload_key_limit');
});

test('agent auth: key creates draft only, cookies and other bearer kinds rejected, grant is exact and one-time',async()=>{
 const owner=await login(),key=(await newKey(owner)).token,idem=randomUUID();
 assert.equal((await agent('/skill-submissions',null,{},{'Idempotency-Key':idem,Cookie:owner.cookie,'X-CSRF-Token':owner.csrf})).status,401);
 assert.equal((await agent('/skill-submissions','fw_read_'+'a'.repeat(43),{},{'Idempotency-Key':idem})).status,401);
 assert.equal((await agent('/skill-submissions',key+'x',{},{'Idempotency-Key':idem})).status,401);
 assert.equal((await agent('/skill-submissions',key,{},{})).data.code,'idempotency_required');
 assert.equal((await agent('/skill-submissions',key,{title:'x'},{'Idempotency-Key':idem})).status,422);
 const draft=await agentDraft(key,idem),id=draft.submission.submission_id,grant=draft.upload_grant.token;
 assert.match(grant,/^fpg_[A-Za-z0-9_-]{43}$/);assert.equal(draft.upload_grant.submit_url,`${origin}/agent-api/v1/skill-submissions/${id}`);
 assert.equal(draft.submission.status,'awaiting_upload');assert.equal('payload' in draft.submission,false);
 const again=await agentDraft(key,idem);assert.equal(again.submission.submission_id,id);assert.equal(again.upload_grant,null);
 assert.equal((await pool.query('SELECT count(*) FROM skill_submissions')).rows[0].count,'1');
 // Neither the key nor a cookie can upload; a grant is bound to its own draft.
 assert.equal((await agent(`/skill-submissions/${id}`,key,payload())).data.code,'upload_grant_invalid');
 assert.equal((await agent(`/skill-submissions/${id}`,null,payload(),{Cookie:owner.cookie})).status,401);
 const second=await agentDraft(key);
 assert.equal((await agent(`/skill-submissions/${second.submission.submission_id}`,grant,payload())).status,401);
 const done=await agent(`/skill-submissions/${id}`,grant,payload());assert.equal(done.status,200,JSON.stringify(done.data));
 assert.deepEqual(Object.keys(done.data).sort(),['grant_consumed_at','review_url','status','submission_id']);assert.equal(done.data.status,'ready_for_review');
 const same=await agent(`/skill-submissions/${id}`,grant,payload());assert.equal(same.status,200);assert.deepEqual(same.data,done.data);
 assert.equal((await agent(`/skill-submissions/${id}`,grant,payload({title:'改過的標題'}))).data.code,'upload_grant_consumed');
 assert.equal((await pool.query('SELECT aggregate_version FROM skill_submissions WHERE submission_id=$1',[id])).rows[0].aggregate_version,'2');
 // Agent has no read, list, publish or key-management surface.
 const get=await app.request(origin+'/agent-api/v1/skill-submissions',{headers:{Authorization:'Bearer '+key}});assert.equal(get.status,405);
 assert.equal((await agent(`/skill-submissions/${id}/publish`,key,{consent_to_share:true})).status,403);
 assert.equal((await agent('/skill-upload-keys',key,{label:'x'})).status,403);
 await secretsAbsent(key,grant,second.upload_grant.token);
 const view=(await api(`/me/skill-submissions/${id}`,owner)).data;
 assert.equal(view.status,'ready_for_review');assert.equal(view.payload.share_introductions.length,100);assert.ok(view.grant_consumed_at);
 for(const secretField of ['grant_hash','token_hash','image_bytes','payload_sha256','owner_ref'])assert.equal(secretField in view,false);
 assert.equal((await api(`/me/skill-submissions/${id}`,await login(DEMO_USERS[1].email))).status,404);
 assert.equal(isAgentSkillUploadPath('POST','/agent-api/v1/skill-submissions'),true);assert.equal(isAgentSkillUploadPath('POST',`/agent-api/v1/skill-submissions/${id}`),true);
 assert.equal(isAgentSkillUploadPath('POST',`/agent-api/v1/skill-submissions/${id}/publish`),false);assert.equal(isAgentSkillUploadPath('GET','/agent-api/v1/skill-submissions'),false);
});

test('payload is strict: exactly 100 distinct single-line introductions and no consent/official/member fields',async()=>{
 const owner=await login(),key=(await newKey(owner)).token,draft=await agentDraft(key),id=draft.submission.submission_id,grant=draft.upload_grant.token;
 const bad:[string,Record<string,unknown>][]= [
  ['99',{share_introductions:intros(99)}],['101',{share_introductions:intros(101)}],
  ['duplicate',{share_introductions:[...intros(99),'第 1 則介紹：這個技能幫助團隊整理共同筆記'.toUpperCase()]}],
  ['spaced duplicate',{share_introductions:[...intros(99),'第 1 則介紹：這個技能幫助團隊整理共同筆記'.replace(' ','  ')]}],
  ['newline',{share_introductions:[...intros(99),'第一行內容足夠長\n第二行']}],['short',{share_introductions:[...intros(99),'太短']}],
  ['consent',{consent_to_share:true}],['official',{official:true}],['member',{owner_ref:DEMO_USERS[1].user_id}],
  ['url',{repository_url:'https://gitlab.com/example/project'}],['demo',{demo_url:'http://127.0.0.1/x'}],['relationship',{relationship:'owner'}],
 ];
 for(const [label,extra] of bad){const r=await agent(`/skill-submissions/${id}`,grant,payload(extra));assert.equal(r.status,422,label+' '+JSON.stringify(r.data));}
 // Nothing was consumed by rejected payloads; trimmed/NFC variants normalise to one digest.
 const spaced=payload({share_introductions:intros().map(v=>`  ${v}  `)});
 assert.equal((await agent(`/skill-submissions/${id}`,grant,spaced)).status,200);
 assert.equal((await agent(`/skill-submissions/${id}`,grant,payload())).status,200);
 assert.equal((await agent(`/skill-submissions/${id}`,grant,'{"title":')).data.code,'invalid_json');
 assert.equal((await app.request(origin+`/agent-api/v1/skill-submissions/${id}`,{method:'POST',headers:{Authorization:'Bearer '+grant,'Content-Type':'text/plain'},body:'{}'})).status,415);
});

test('cover image: vector, mislabelled and animated input rejected; raster re-encoded to stored WebP; body stream bounded',async()=>{
 const owner=await login(),key=(await newKey(owner)).token,draft=await agentDraft(key),id=draft.submission.submission_id,grant=draft.upload_grant.token;
 const svg=Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script></svg>');
 const raster=await png(),jpeg=await sharp(raster).jpeg().toBuffer();
 // Insert an APNG animation-control chunk right after IHDR (8 + 25 bytes).
 const acTL=Buffer.concat([Buffer.from([0,0,0,8]),Buffer.from('acTL'),Buffer.alloc(8),Buffer.alloc(4)]);
 const apng=Buffer.concat([raster.subarray(0,33),acTL,raster.subarray(33)]);
 const gif=await sharp(raster).gif().toBuffer();
 for(const [label,cover] of [
  ['svg',{mime_type:'image/png',data_base64:svg.toString('base64')}],['svg mime',{mime_type:'image/svg+xml',data_base64:svg.toString('base64')}],
  ['mismatch',{mime_type:'image/jpeg',data_base64:raster.toString('base64')}],['apng',{mime_type:'image/png',data_base64:apng.toString('base64')}],
  ['gif',{mime_type:'image/png',data_base64:gif.toString('base64')}],['data url',{mime_type:'image/png',data_base64:'data:image/png;base64,'+raster.toString('base64')}],
  ['wrapped',{mime_type:'image/png',data_base64:raster.toString('base64').replace(/(.{60})/g,'$1\n')}],['remote',{mime_type:'image/png',url:'https://example.com/x.png'}],
 ] as const){const r=await agent(`/skill-submissions/${id}`,grant,payload({cover_image:cover}));assert.equal(r.status,422,label+' '+JSON.stringify(r.data));}
 const big=await sharp({create:{width:4097,height:8,channels:3,background:'#fff'}}).png().toBuffer();
 assert.equal((await agent(`/skill-submissions/${id}`,grant,payload({cover_image:{mime_type:'image/png',data_base64:big.toString('base64')}}))).status,422);
 // Oversized chunked body without Content-Length is cut off by the stream reader.
 const chunk=new TextEncoder().encode(' '.repeat(64*1024));let sent=0,cancelled=false;
 const stream=new ReadableStream({pull(controller){if(sent++<64)controller.enqueue(chunk);else controller.close();},cancel(){cancelled=true;}});
 const oversized=await app.request(origin+`/agent-api/v1/skill-submissions/${id}`,{method:'POST',headers:{Authorization:'Bearer '+grant,'Content-Type':'application/json'},body:stream,duplex:'half'} as RequestInit);
 assert.equal(oversized.status,413);assert.ok(cancelled&&sent<20,'reader cancels near 800 KiB instead of draining 4 MiB');
 assert.equal((await agent(`/skill-submissions/${id}`,grant,payload(),{'Content-Length':String(900*1024)})).status,413);
 const ok=await agent(`/skill-submissions/${id}`,grant,payload({cover_image:{mime_type:'image/jpeg',data_base64:jpeg.toString('base64')}}));assert.equal(ok.status,200,JSON.stringify(ok.data));
 const view=(await api(`/me/skill-submissions/${id}`,owner)).data;
 assert.equal('cover_image' in view.payload,false);assert.equal(view.illustration_url,`/api/v1/me/skill-submissions/${id}/illustration`);
 const image=await api(`/me/skill-submissions/${id}/illustration`,owner);assert.equal(image.status,200);assert.equal(image.response.headers.get('Content-Type'),'image/webp');
 const meta=await sharp(Buffer.from(await image.response.arrayBuffer())).metadata();assert.equal(meta.format,'webp');assert.equal(meta.exif,undefined);
 assert.equal(meta.width,1200);assert.equal(meta.height,630);
 assert.equal((await api(`/me/skill-submissions/${id}/illustration`,await login(DEMO_USERS[1].email))).status,404);
 assert.equal(JSON.stringify((await api('/me/skill-submissions',owner)).data).includes(jpeg.toString('base64').slice(0,40)),false);
});

test('key revoke/expiry, grant expiry, member disable and incomplete onboarding reject uploads even for replays',async()=>{
 const owner=await login(),k1=await newKey(owner),d1=await agentDraft(k1.token);
 await api(`/me/skill-upload-keys/${k1.key.key_id}/revoke`,owner,{});
 assert.ok((await api(`/me/skill-submissions/${d1.submission.submission_id}`,owner)).data.grant_revoked_at);
 assert.equal((await agent(`/skill-submissions/${d1.submission.submission_id}`,d1.upload_grant.token,payload())).status,401);
 const k2=await newKey(owner),d2=await agentDraft(k2.token);
 await pool.query(`UPDATE skill_upload_keys SET created_at=now()-interval '2 days',expires_at=now()-interval '1 second' WHERE key_id=$1`,[k2.key.key_id]);
 assert.ok(Date.parse((await api(`/me/skill-submissions/${d2.submission.submission_id}`,owner)).data.grant_expires_at)<Date.now());
 assert.equal((await agent(`/skill-submissions/${d2.submission.submission_id}`,d2.upload_grant.token,payload())).status,401);
 assert.equal((await agent('/skill-submissions',k2.token,{},{'Idempotency-Key':randomUUID()})).status,401);
 const k3=await newKey(owner),d3=await agentDraft(k3.token),d4=await agentDraft(k3.token);
 assert.equal((await agent(`/skill-submissions/${d3.submission.submission_id}`,d3.upload_grant.token,payload())).status,200);
 await pool.query(`UPDATE skill_submissions SET grant_expires_at=now()-interval '1 second' WHERE submission_id=$1`,[d3.submission.submission_id]);
 assert.equal((await agent(`/skill-submissions/${d3.submission.submission_id}`,d3.upload_grant.token,payload())).status,401,'expired grant rejects identical replay');
 await pool.query('UPDATE users SET onboarding_required=true,onboarding_completed_at=NULL WHERE user_id=$1',[owner.user.user_id]);
 assert.equal((await agent(`/skill-submissions/${d4.submission.submission_id}`,d4.upload_grant.token,payload())).data.code,'onboarding_required');
 assert.equal((await agent('/skill-submissions',k3.token,{},{'Idempotency-Key':randomUUID()})).data.code,'onboarding_required');
 await pool.query('UPDATE users SET onboarding_required=false,active=false WHERE user_id=$1',[owner.user.user_id]);
 assert.equal((await agent(`/skill-submissions/${d4.submission.submission_id}`,d4.upload_grant.token,payload())).status,401);
 assert.equal((await pool.query("SELECT count(*) FROM skill_submissions WHERE status='ready_for_review'")).rows[0].count,'1');
});

test('browser issue/rotate/revoke: once-only grant, If-Match versions, old grant invalid, owner-only',async()=>{
 const owner=await login(),other=await login(DEMO_USERS[1].email),idem=randomUUID();
 const issued=await api('/me/skill-submissions',owner,{},undefined,idem);assert.equal(issued.status,201);
 const id=issued.data.submission.submission_id,v1=issued.data.submission.aggregate_version,firstGrant=issued.data.upload_grant.token;
 assert.equal(issued.response.headers.get('ETag'),`"${v1}"`);assert.match(firstGrant,/^fpg_/);
 const replay=await api('/me/skill-submissions',owner,{},undefined,idem);assert.equal(replay.data.upload_grant,null);assert.equal(replay.data.submission.submission_id,id);
 assert.equal((await api(`/me/skill-submissions/${id}/grant`,owner,{})).status,428);
 assert.equal((await api(`/me/skill-submissions/${id}/grant`,other,{},v1)).status,404);
 const rotated=await api(`/me/skill-submissions/${id}/grant`,owner,{},v1);assert.equal(rotated.status,200,JSON.stringify(rotated.data));
 assert.notEqual(rotated.data.upload_grant.token,firstGrant);
 assert.equal((await api(`/me/skill-submissions/${id}/grant`,owner,{},v1)).status,412);
 assert.equal((await agent(`/skill-submissions/${id}`,firstGrant,payload())).status,401);
 assert.equal((await agent(`/skill-submissions/${id}`,rotated.data.upload_grant.token,payload())).status,200);
 const current=(await api(`/me/skill-submissions/${id}`,owner)).data;
 assert.equal((await api(`/me/skill-submissions/${id}/grant`,owner,{},current.aggregate_version)).data.code,'submission_not_awaiting_upload');
 assert.equal((await api(`/me/skill-submissions/${id}/revoke`,other,{},current.aggregate_version)).status,404);
 const revoked=await api(`/me/skill-submissions/${id}/revoke`,owner,{},current.aggregate_version);assert.equal(revoked.data.status,'revoked');
 assert.equal((await agent(`/skill-submissions/${id}`,rotated.data.upload_grant.token,payload())).status,401,'revoked draft rejects identical replay');
 assert.equal((await api(`/me/skill-submissions/${id}/publish`,owner,{consent_to_share:true},revoked.data.aggregate_version)).data.code,'submission_not_ready');
 await secretsAbsent(firstGrant,rotated.data.upload_grant.token);
 assert.equal((await api('/me/skill-submissions',other)).data.items.length,0);
});

test('publish imports real pinned GitHub source once, needs consent and current version, then appears publicly',async t=>{
 const {seen,sha}=mockGitHub(t),owner=await login(),other=await login(DEMO_USERS[1].email);
 const cover=(await png()).toString('base64');
 const maliciousTitle='<script>alert("draft")</script>';
 const draft=await uploaded(owner,{title:maliciousTitle,cover_image:{mime_type:'image/png',data_base64:cover}}),id=draft.submission_id;
 assert.deepEqual(await listPublishedSkillSubmissions(pool),[]);assert.equal(await readPublishedSkillSubmission(pool,id),null);assert.equal(await readPublishedSkillIllustration(pool,id),null);
 for(const path of [`/development/submissions/${id}`,`/development/submissions/${id}/SKILL.md`,`/api/v1/skill-submissions/${id}/illustration`])assert.equal((await platform.request(origin+path)).status,404);
 assert.deepEqual((await api('/skill-submissions/published')).data.items,[]);
 assert.equal((await api(`/me/skill-submissions/${id}/publish`,owner,{},draft.aggregate_version)).status,422);
 assert.equal((await api(`/me/skill-submissions/${id}/publish`,owner,{consent_to_share:true,official:true},draft.aggregate_version)).status,422);
 assert.equal((await api(`/me/skill-submissions/${id}/publish`,owner,{consent_to_share:true},'999')).status,412);
 assert.equal((await api(`/me/skill-submissions/${id}/publish`,other,{consent_to_share:true},draft.aggregate_version)).status,404);
 assert.equal(seen.length,0,'no GitHub read on stale, unconsented or unauthorized requests');
 const idem=randomUUID(),published=await api(`/me/skill-submissions/${id}/publish`,owner,{consent_to_share:true},draft.aggregate_version,idem);
 assert.equal(published.status,200,JSON.stringify(published.data));assert.equal(published.data.status,'published');
 assert.equal(published.data.public_path,`/development/submissions/${id}`);assert.ok(published.data.project_id);assert.equal(seen.length,3);
 assert.deepEqual((await api(`/me/skill-submissions/${id}/publish`,owner,{consent_to_share:true},draft.aggregate_version,idem)).data,published.data);assert.equal(seen.length,3);
 assert.equal((await api(`/me/skill-submissions/${id}/publish`,owner,{consent_to_share:true},published.data.aggregate_version)).data.code,'submission_not_ready');
 assert.equal((await api(`/me/skill-submissions/${id}/revoke`,owner,{},published.data.aggregate_version)).data.code,'submission_published');
 const project=(await pool.query('SELECT * FROM oss_projects WHERE project_id=$1',[published.data.project_id])).rows[0];
 assert.equal(project.relationship,'author');assert.equal(project.relationship_verification,'self_declared');assert.equal(project.official,false);assert.equal(project.owner_ref,owner.user.user_id);
 const [item]=await listPublishedSkillSubmissions(pool);
 assert.equal(item.submission_id,id);assert.equal(item.official,false);assert.equal(item.relationship_verification,'self_declared');
 assert.deepEqual(item.source,{repository_full_name:'example/project',repository_url:'https://github.com/example/project',commit_sha:sha,license_spdx:'Apache-2.0',license_evidence_url:`https://github.com/example/project/blob/${sha}/LICENSE`,is_fork:false,archived:false});
 assert.equal(item.share_introductions.length,100);assert.equal(item.illustration_url,`/api/v1/skill-submissions/${id}/illustration`);
 const text=JSON.stringify(item);for(const secret of [owner.user.user_id,owner.user.email,'grant','hash'])assert.equal(text.includes(secret),false,secret);
 const detail=await readPublishedSkillSubmission(pool,id);assert.equal(detail?.use_notes,payload().use_notes);assert.equal(detail?.demo_url,null);
 assert.equal((await readPublishedSkillIllustration(pool,id))?.mime_type,'image/webp');
 const html=await platform.request(origin+`/development/submissions/${id}`);assert.equal(html.status,200);
 const markup=await html.text();assert.equal(markup.includes(maliciousTitle),false);assert.match(markup,/&lt;script&gt;/);
 const markdown=await platform.request(origin+`/development/submissions/${id}/SKILL.md`);assert.equal(markdown.status,200);assert.match(await markdown.text(),/example\/project/);
 const listing=(await api('/skill-submissions/published')).data.items;assert.equal(listing[0].submission_id,id);assert.equal('share_introductions' in listing[0],false);
 for(const field of ['owner_ref','grant_hash','grant_expires_at','payload','image_bytes'])assert.equal(field in listing[0],false);
 const illustration=await platform.request(origin+`/api/v1/skill-submissions/${id}/illustration`);assert.equal(illustration.status,200);assert.equal(illustration.headers.get('Content-Type'),'image/webp');
 // Deactivating the owner removes the publication from every public read.
 await pool.query('UPDATE users SET active=false WHERE user_id=$1',[owner.user.user_id]);
 assert.deepEqual(await listPublishedSkillSubmissions(pool),[]);assert.equal(await readPublishedSkillSubmission(pool,id),null);assert.equal(await readPublishedSkillIllustration(pool,id),null);
});

test('publication and source import roll back together, and the same request safely retries',async t=>{
 const {seen}=mockGitHub(t),owner=await login(),draft=await uploaded(owner),id=draft.submission_id,idem=randomUUID();
 await pool.query(`CREATE FUNCTION reject_skill_publish() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic publish failure'; END $$`);
 await pool.query(`CREATE TRIGGER reject_skill_publish BEFORE UPDATE ON skill_submissions FOR EACH ROW WHEN (NEW.status='published') EXECUTE FUNCTION reject_skill_publish()`);
 try {
  const failed=await api(`/me/skill-submissions/${id}/publish`,owner,{consent_to_share:true},draft.aggregate_version,idem);assert.equal(failed.status,500);
  assert.equal((await pool.query('SELECT count(*) FROM oss_projects')).rows[0].count,'0');
  assert.equal((await pool.query('SELECT count(*) FROM oss_project_versions')).rows[0].count,'0');
  assert.equal((await api(`/me/skill-submissions/${id}`,owner)).data.status,'ready_for_review');
 } finally { await pool.query('DROP FUNCTION reject_skill_publish() CASCADE'); }
 const retried=await api(`/me/skill-submissions/${id}/publish`,owner,{consent_to_share:true},draft.aggregate_version,idem);assert.equal(retried.status,200);
 assert.equal(seen.length,6);assert.equal((await pool.query('SELECT count(*) FROM oss_projects')).rows[0].count,'1');
});

test('two concurrent publications fit a two-connection pool without nested checkout deadlock', {timeout:10000}, async t=>{
 mockGitHub(t);const owner=await login(),drafts=[await uploaded(owner),await uploaded(owner)];
 const limited=new Pool({connectionString:databaseUrl,options:`-c search_path=${schema}`,max:2,connectionTimeoutMillis:1500});
 const limitedApp=createApp(limited,origin),originalFetch=globalThis.fetch;
 const barrier=deferred();let arrived=0;
 t.mock.method(globalThis,'fetch',async (...args:Parameters<typeof fetch>)=>{
  if(String(args[0])==='https://api.github.com/repos/example/project'){if(++arrived===2)barrier.resolve();await barrier.promise;}
  return originalFetch(...args);
 });
 try {
  const results=await Promise.all(drafts.map(draft=>limitedApp.request(origin+`/api/v1/me/skill-submissions/${draft.submission_id}/publish`,{
   method:'POST',headers:{Origin:origin,Cookie:owner.cookie,'X-CSRF-Token':owner.csrf,'Content-Type':'application/json','Idempotency-Key':randomUUID(),'If-Match':`"${draft.aggregate_version}"`},body:JSON.stringify({consent_to_share:true})
  })));
  assert.equal(arrived,2);assert.deepEqual(results.map(r=>r.status),[200,200]);
  assert.equal((await pool.query("SELECT count(*) FROM skill_submissions WHERE status='published'")).rows[0].count,'2');
  assert.equal((await pool.query('SELECT count(*) FROM oss_projects')).rows[0].count,'1');
 } finally {barrier.resolve();await limited.end();}
});

test('member disable waits for an in-flight publication then hides it and rejects retries', {timeout:10000}, async t=>{
 mockGitHub(t);const owner=await login(),draft=await uploaded(owner),originalFetch=globalThis.fetch;
 const entered=deferred(),release=deferred();
 t.mock.method(globalThis,'fetch',async (...args:Parameters<typeof fetch>)=>{
  if(String(args[0])==='https://api.github.com/repos/example/project'){entered.resolve();await release.promise;}
  return originalFetch(...args);
 });
 const publishing=api(`/me/skill-submissions/${draft.submission_id}/publish`,owner,{consent_to_share:true},draft.aggregate_version);
 await entered.promise;
 let disabled=false;
 const disabling=pool.query('UPDATE users SET active=false WHERE user_id=$1',[owner.user.user_id]).then(()=>{disabled=true;});
 await new Promise(resolve=>setTimeout(resolve,40));assert.equal(disabled,false,'publication retains the member lock while GitHub is inspected');
 release.resolve();assert.equal((await publishing).status,200);await disabling;
 assert.equal(await readPublishedSkillSubmission(pool,draft.submission_id),null);
 assert.equal((await api(`/me/skill-submissions/${draft.submission_id}/publish`,owner,{consent_to_share:true},draft.aggregate_version)).status,401);
});

test('publish reuses the owner registered source without overwriting project metadata',async t=>{
 const {seen}=mockGitHub(t),owner=await login(),draft=await uploaded(owner),id=draft.submission_id;
 const actor=await authenticate(pool,owner.cookie.split('=')[1]),p=payload();
 const imported:any=await importProject(pool,{actor,operation:'POST /api/v1/opensource/projects',key:randomUUID(),body:{repository_url:p.repository_url,title:'原有登錄標題',description:p.description,use_notes:p.use_notes,demo_url:null,relationship:p.relationship,consent_to_share:true}});
 assert.equal(seen.length,3);
 const published=await api(`/me/skill-submissions/${id}/publish`,owner,{consent_to_share:true},draft.aggregate_version);
 assert.equal(published.status,200,JSON.stringify(published.data));assert.equal(published.data.project_id,imported.project_id);
 assert.equal(seen.length,6,'publication re-verifies the already registered source');
 assert.equal((await pool.query('SELECT title FROM oss_projects WHERE project_id=$1',[imported.project_id])).rows[0].title,'原有登錄標題');
 assert.equal((await pool.query('SELECT count(*) FROM oss_projects')).rows[0].count,'1');
 const other=await uploaded(owner);
 const reused=await api(`/me/skill-submissions/${other.submission_id}/publish`,owner,{consent_to_share:true},other.aggregate_version);
 assert.equal(reused.status,200);assert.equal(reused.data.project_id,imported.project_id);
 assert.equal((await pool.query('SELECT count(*) FROM oss_projects')).rows[0].count,'1');
});

test('platform app wiring: agent POSTs work without Origin, foreign Origin is refused, browser routes need a session',async()=>{
 const owner=await login(),key=(await newKey(owner)).token;
 const post=(path:string,token:string,body:unknown,extra:Record<string,string>={})=>platform.request(origin+path,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token,...extra},body:JSON.stringify(body)});
 assert.equal((await post('/agent-api/v1/skill-submissions',key,{},{'Idempotency-Key':randomUUID(),Origin:'https://evil.example'})).status,403);
 const created=await post('/agent-api/v1/skill-submissions',key,{},{'Idempotency-Key':randomUUID()});assert.equal(created.status,201);
 const draft=await created.json() as any;
 const done=await post(`/agent-api/v1/skill-submissions/${draft.submission.submission_id}`,draft.upload_grant.token,payload());
 assert.equal(done.status,200,await done.clone().text());
 assert.equal((await platform.request(origin+'/api/v1/me/skill-submissions')).status,401);
 const listed=await platform.request(origin+'/api/v1/me/skill-submissions',{headers:{Cookie:owner.cookie}});
 const items=(await listed.json() as any).items;assert.equal(items[0].status,'ready_for_review');assert.equal(items[0].aggregate_version,2);
});
