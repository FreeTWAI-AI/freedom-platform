import { test,before,after,beforeEach,type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import { Pool } from 'pg';
import { createPool,LOCAL_DATABASE_URL,digest } from '../../packages/db/index.js';
import { migrate } from '../../scripts/database.js';
import { seedLocal,DEMO_USERS,DEMO_PASSWORD } from '../../packages/testing/seed.js';
import { createApp } from '../../apps/platform-api/src/app.js';
import { hashPassword,tokenHash } from '../../modules/identity-membership/service.js';
import { githubCoordinate,inspectGitHubRepository } from '../../modules/opensource-marketing/github.js';

const origin='http://127.0.0.1:4310',databaseUrl=process.env.TEST_DATABASE_URL??LOCAL_DATABASE_URL;
const schema=`fp_oss_test_${process.pid}_${Date.now()}`,admin=createPool(databaseUrl);
const pool=new Pool({connectionString:databaseUrl,options:`-c search_path=${schema}`,max:12});
const app=createApp(pool,origin);
interface Session{cookie:string;csrf:string;user:any}
before(async()=>{await admin.query(`CREATE SCHEMA ${schema}`);await migrate(pool);});
after(async()=>{await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();});
beforeEach(async()=>{await pool.query('TRUNCATE communities,login_attempts CASCADE');await seedLocal(pool);});
async function request(path:string,session?:Session,body?:unknown,version?:number,key=randomUUID(),extra:Record<string,string>={}){
  const headers:Record<string,string>={Origin:origin,...(session?{Cookie:session.cookie,'X-CSRF-Token':session.csrf}:{}),...extra};
  if(body!==undefined){headers['Content-Type']='application/json';headers['Idempotency-Key']=key;if(version)headers['If-Match']=`"${version}"`;}
  const response=await app.request(origin+'/api/v1'+path,{method:body===undefined?'GET':'POST',headers,body:body===undefined?undefined:JSON.stringify(body)});
  return {status:response.status,data:await response.json() as any,response};
}
async function login(email=DEMO_USERS[0].email):Promise<Session>{
  const r=await request('/auth/login',undefined,{email,password:DEMO_PASSWORD});assert.equal(r.status,200,JSON.stringify(r.data));
  return {cookie:r.response.headers.get('set-cookie')!.split(';')[0],csrf:r.data.csrf_token,user:r.data.user};
}
const projectBody={repository_url:'https://github.com/example/project',title:'公共程式範例',description:'讓人整理共同筆記。',use_notes:'先閱讀 README，再建立自己的 fork。',relationship:'curator',consent_to_share:true};
const campaignBody={title:'作品介紹',audience:'新加入的會員',goal:'閱讀說明後試用',draft_text:'這份工具可以整理共同筆記；歡迎試用並回饋。'};
function mockGitHub(t:TestContext,options:{sha?:string;repositoryId?:number;license?:string|null;isFork?:boolean;isPrivate?:boolean}={}){
  const state={sha:'a'.repeat(40),repositoryId:501,license:'MIT' as string|null,isFork:false,isPrivate:false,archived:false,...options};
  const seen:string[]=[];
  t.mock.method(globalThis,'fetch',async(url:string,init:RequestInit)=>{
    seen.push(url);assert.equal(new URL(url).hostname,'api.github.com');assert.equal(init.redirect,'manual');assert.notEqual(init.redirect,'error');
    assert.equal(new Headers(init.headers).get('Authorization'),null);
    if(url==='https://api.github.com/repos/example/project')return Response.json({id:state.repositoryId,full_name:'example/project',private:state.isPrivate,visibility:state.isPrivate?'private':'public',default_branch:'main',fork:state.isFork,archived:state.archived});
    if(url==='https://api.github.com/repos/example/project/commits/main')return Response.json({sha:state.sha});
    if(url===`https://api.github.com/repos/example/project/license?ref=${state.sha}`)return state.license?Response.json({path:'LICENSE',license:{spdx_id:state.license}}):new Response('',{status:404});
    throw new Error(`Unexpected test URL ${url}`);
  });
  return {state,seen};
}
async function importOne(session:Session){const r=await request('/opensource/projects',session,projectBody);assert.equal(r.status,201,JSON.stringify(r.data));return r.data;}
async function createDraft(session:Session,source:Record<string,unknown>={source_brief:'社群自願分享會，無收費或收入承諾。'}){const r=await request('/marketing/campaigns',session,{...campaignBody,...source});assert.equal(r.status,201,JSON.stringify(r.data));return r.data;}

async function assertReadClock(s:Session,path:string,table:'oss_projects'|'skill_submissions'|'marketing_campaign_drafts',expected:unknown){
  const facts=async()=>(await pool.query('SELECT (SELECT count(*)::int FROM command_receipts) AS receipts,(SELECT count(*)::int FROM transition_journal) AS journal')).rows[0];
  const before=await facts(),hash=tokenHash(s.cookie.split('=')[1]);
  for(const expired of [true,false]){
    const gate=await admin.connect();let running:Promise<unknown>|undefined;
    try{
      await gate.query('BEGIN');await gate.query(`LOCK TABLE ${schema}.${table} IN ACCESS EXCLUSIVE MODE`);
      await pool.query("UPDATE sessions SET expires_at=clock_timestamp()+make_interval(secs=>$2) WHERE token_hash=$1",[hash,expired?3:3600]);
      const pid=(await gate.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      const response=request(path,s);running=response.catch(()=>undefined);
      const deadline=Date.now()+2000;
      for(;;){
        if((await admin.query('SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))',[pid])).rowCount!>0)break;
        assert.ok(Date.now()<deadline,'composed read reached its real domain gate');await setImmediate();
      }
      assert.equal((await pool.query('SELECT expires_at>clock_timestamp() AS live FROM sessions WHERE token_hash=$1',[hash])).rows[0].live,true);
      if(expired)await pool.query('SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM expires_at-clock_timestamp()))+0.05) FROM sessions WHERE token_hash=$1',[hash]);
      await gate.query('ROLLBACK');
      const result=await response;assert.equal(result.status,expired?401:200,JSON.stringify(result.data));
      if(expired){
        assert.equal(result.data.code,'session_expired');
        for(const field of ['items','project_id','skill_book','current_version'])assert.equal(field in result.data,false);
        assert.equal(result.response.headers.get('set-cookie'),null);
      }else assert.deepEqual(result.data,expected);
      assert.deepEqual(await facts(),before);
    }finally{
      await gate.query('ROLLBACK');gate.release();if(running)await running;
      await pool.query("UPDATE sessions SET expires_at=clock_timestamp()+interval '30 days' WHERE token_hash=$1",[hash]);
    }
  }
}

for(const surface of [
  {target:'list',table:'oss_projects'},
  {target:'detail',table:'oss_projects'},
  {target:'list',table:'skill_submissions'},
  {target:'detail',table:'skill_submissions'},
  {target:'campaigns',table:'marketing_campaign_drafts'}
] as const)test(`${surface.target} read fences the session after its ${surface.table} wait`,async t=>{
  const {seen}=mockGitHub(t),owner=await login(),project=await importOne(owner);
  await pool.query('UPDATE users SET email_verified_at=clock_timestamp() WHERE user_id=$1',[owner.user.user_id]);
  const prepared=await request(`/opensource/projects/${project.project_id}/skill-submission`,owner,{},Number(project.aggregate_version));
  assert.equal(prepared.status,201,JSON.stringify(prepared.data));
  const campaign=await createDraft(owner),path=surface.target==='campaigns'?'/marketing/campaigns':surface.target==='detail'?`/opensource/projects/${project.project_id}`:'/opensource/projects';
  const expected=await request(path,owner);assert.equal(expected.status,200);
  if(surface.target==='campaigns')assert.equal(expected.data.items[0].campaign_id,campaign.campaign_id);
  else{
    const card=surface.target==='detail'?expected.data:expected.data.items[0];
    assert.equal(card.project_id,project.project_id);
    assert.deepEqual(card.skill_book,{status:'ready_for_review',submission_id:prepared.data.submission.submission_id,public_path:null,catalog_book:null,can_edit:true});
  }
  await assertReadClock(owner,path,surface.table,expected.data);
  assert.equal(seen.length,3);
});

for(const surface of [
  {path:'/opensource/projects',table:'oss_projects',empty:{items:[]}},
  {path:'/marketing/campaigns',table:'marketing_campaign_drafts',empty:{items:[],next_offset:null}}
] as const)test(`empty ${surface.path} still checks the session after a source wait`,async()=>{
  const owner=await login(),expected=await request(surface.path,owner);assert.equal(expected.status,200);assert.deepEqual(expected.data,surface.empty);
  await assertReadClock(owner,surface.path,surface.table,expected.data);
});

test('public import pins stable identity, exact commit/license and keeps relationship self-declared',async t=>{
  const {seen}=mockGitHub(t),owner=await login(),project=await importOne(owner);
  assert.equal(project.repository_id,'501');assert.equal(project.current_version.commit_sha,'a'.repeat(40));
  assert.equal(project.current_version.license_spdx,'MIT');assert.equal(project.relationship_verification,'self_declared');
  assert.equal(project.current_version.source_sha256,digest(project.current_version.source_snapshot));
  assert.equal(project.status,'candidate');assert.equal(project.official,false);assert.equal(project.commercial_ready,false);
  assert.match(project.current_version.license_evidence_url,/\/a{40}\/LICENSE$/);assert.equal(seen.length,3);
  const fresh=createApp(pool,origin),response=await fresh.request(origin+'/api/v1/opensource/projects',{headers:{Cookie:owner.cookie}});
  assert.equal((await response.json() as any).items[0].project_id,project.project_id);
  assert.equal((await pool.query('SELECT count(*) FROM oss_project_versions')).rows[0].count,'1');
});
test('idempotent replay does not re-read GitHub or duplicate a candidate; duplicate imports conflict',async t=>{
  const {seen}=mockGitHub(t),owner=await login(),key=randomUUID();
  const first=await request('/opensource/projects',owner,projectBody,undefined,key);assert.equal(first.status,201);
  const replay=await request('/opensource/projects',owner,projectBody,undefined,key);assert.deepEqual(replay.data,first.data);assert.equal(seen.length,3);
  assert.equal((await request('/opensource/projects',owner,{...projectBody,title:'changed'},undefined,key)).status,409);
  assert.equal((await request('/opensource/projects',owner,projectBody)).data.code,'project_exists');
  assert.equal((await pool.query('SELECT count(*) FROM oss_projects')).rows[0].count,'1');
});
test('repository coordinates reject SSRF, credentials and deep URLs before any network request',async t=>{
  const {seen}=mockGitHub(t),owner=await login();
  for(const url of ['http://github.com/example/project','https://api.github.com/example/project','https://github.com.evil.example/example/project','https://user:pass@github.com/example/project','https://127.0.0.1/example/project','https://github.com/example/project/tree/main','https://github.com/example/project?ref=main']){
    assert.equal((await request('/opensource/projects',owner,{...projectBody,repository_url:url})).status,422,url);
  }
  assert.equal(seen.length,0);assert.equal(githubCoordinate('https://github.com/example/project.git'),'example/project');
});
test('private GitHub metadata and arbitrary user ownership flags cannot become public candidates',async t=>{
  mockGitHub(t,{isPrivate:true});const owner=await login();
  assert.equal((await request('/opensource/projects',owner,projectBody)).data.code,'github_repository_unavailable');
  assert.equal((await request('/opensource/projects',owner,{...projectBody,official:true})).status,422);
  assert.equal((await pool.query('SELECT count(*) FROM oss_projects')).rows[0].count,'0');
});
test('missing license and fork are visible factual labels; they do not fabricate official status',async t=>{
  mockGitHub(t,{license:null,isFork:true});const project=await importOne(await login());
  assert.equal(project.current_version.license_spdx,'NOASSERTION');assert.equal(project.current_version.license_evidence_url,null);
  assert.equal(project.current_version.is_fork,true);assert.equal(project.official,false);
});
test('a GitHub 3xx is rejected and its Location is never requested',async()=>{
  const seen:string[]=[];
  const fetcher:typeof fetch=async(url,init)=>{
    seen.push(String(url));assert.equal(init?.redirect,'manual');assert.notEqual(init?.redirect,'error');
    return new Response(null,{status:302,headers:{Location:'https://evil.example/redirected'}});
  };
  await assert.rejects(()=>inspectGitHubRepository('https://github.com/example/project',fetcher),(error:any)=>{assert.equal(error.code,'github_unavailable');assert.match(error.message,/暫時無法讀取 GitHub/);return true;});
  assert.deepEqual(seen,['https://api.github.com/repos/example/project']);
  const opaque:typeof fetch=async(url,init)=>{seen.push(String(url));assert.equal(init?.redirect,'manual');return {type:'opaqueredirect',status:0,ok:true,headers:new Headers()} as unknown as Response;};
  await assert.rejects(()=>inspectGitHubRepository('https://github.com/example/project',opaque),(error:any)=>error.code==='github_unavailable');
  assert.deepEqual(seen,['https://api.github.com/repos/example/project','https://api.github.com/repos/example/project']);
});
test('upstream unavailable, redirects and oversized JSON return actionable failures without writes',async t=>{
  const owner=await login();
  const transport=t.mock.method(globalThis,'fetch',async()=>new Response('',{status:429}));
  assert.equal((await request('/opensource/projects',owner,projectBody)).data.code,'github_rate_limited');
  transport.mock.mockImplementation(async()=>{throw new Error('redirect or timeout');});
  assert.equal((await request('/opensource/projects',owner,projectBody)).data.code,'github_unavailable');
  transport.mock.mockImplementation(async()=>new Response('x'.repeat(200000)));
  assert.equal((await request('/opensource/projects',owner,projectBody)).data.code,'github_response_too_large');
  assert.equal((await pool.query('SELECT count(*) FROM oss_projects')).rows[0].count,'0');
});
test('owner refresh creates immutable versions while campaigns retain their original source',async t=>{
  const {state}=mockGitHub(t),owner=await login(),project=await importOne(owner);
  const campaign=await createDraft(owner,{source_project_id:project.project_id});
  state.sha='b'.repeat(40);
  const refreshed=await request(`/opensource/projects/${project.project_id}:refresh`,owner,{},project.aggregate_version);assert.equal(refreshed.status,200);
  assert.equal(refreshed.data.current_version.commit_sha,'b'.repeat(40));assert.equal((await pool.query('SELECT count(*) FROM oss_project_versions')).rows[0].count,'2');
  const current=(await request('/marketing/campaigns',owner)).data.items[0];
  assert.equal(current.source_snapshot.commit_sha,'a'.repeat(40));assert.equal(current.source_sha256,campaign.source_sha256);
  state.repositoryId=502;
  assert.equal((await request(`/opensource/projects/${project.project_id}:refresh`,owner,{},refreshed.data.aggregate_version)).data.code,'repository_identity_changed');
  assert.equal((await request('/opensource/projects',owner)).data.items[0].current_version.commit_sha,'b'.repeat(40));
});
test('community readers cannot edit another member candidate or use it as their owned campaign source',async t=>{
  const {seen}=mockGitHub(t),owner=await login(),other=await login(DEMO_USERS[1].email),project=await importOne(owner);
  assert.equal((await request('/opensource/projects',other)).data.items.length,1);
  assert.equal((await request(`/opensource/projects/${project.project_id}:refresh`,other,{},project.aggregate_version)).status,404);
  assert.equal((await request('/marketing/campaigns',other,{...campaignBody,source_project_id:project.project_id})).status,404);
  assert.equal(seen.length,3);
  const community=randomUUID();await pool.query('INSERT INTO communities VALUES($1,$2)',[community,'Other']);
  await pool.query('INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref) VALUES($1,$2,$3,$4,$5,$6)',[randomUUID(),community,'outsider-oss@local.test','Other',hashPassword(DEMO_PASSWORD),randomUUID()]);
  const outsider=await login('outsider-oss@local.test');assert.deepEqual((await request('/opensource/projects',outsider)).data.items,[]);
  assert.equal((await request(`/opensource/projects/${project.project_id}:refresh`,outsider,{},project.aggregate_version)).status,404);
});
test('same-commit metadata changes create a fresh observation without rewriting prior evidence',async t=>{
  const {state}=mockGitHub(t),owner=await login(),project=await importOne(owner);
  state.archived=true;
  const refreshed=await request(`/opensource/projects/${project.project_id}:refresh`,owner,{},project.aggregate_version);assert.equal(refreshed.status,200);
  assert.equal(refreshed.data.current_version.commit_sha,project.current_version.commit_sha);assert.equal(refreshed.data.current_version.archived,true);
  assert.notEqual(refreshed.data.current_version.version_id,project.current_version.version_id);
  assert.equal((await pool.query('SELECT archived FROM oss_project_versions WHERE version_id=$1',[project.current_version.version_id])).rows[0].archived,false);
  const again=await request(`/opensource/projects/${project.project_id}:refresh`,owner,{},refreshed.data.aggregate_version);assert.equal(again.status,200);
  assert.equal(again.data.current_version.version_id,refreshed.data.current_version.version_id);
  assert.equal((await pool.query('SELECT count(*) FROM oss_project_versions')).rows[0].count,'2');
});
test('private campaign drafts return bounded stable pages beyond the legacy cap',async()=>{
  const owner=await login(),other=await login(DEMO_USERS[1].email);
  await pool.query(`INSERT INTO marketing_campaign_drafts(
      campaign_id,community_id,owner_ref,title,audience,goal,draft_text,source_snapshot,source_sha256,content_sha256,created_at
    ) SELECT ('96000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,(SELECT community_id FROM users WHERE user_id=$1),$1,'分頁草稿 '||n,'會員','閱讀內容','合成分頁內容',
      jsonb_build_object('kind','manual_brief','brief','合成來源','provided_by',$1::uuid,'evidence','self_declared'),
      repeat('a',64),repeat('b',64),'2026-01-02T03:04:05Z'::timestamptz
    FROM generate_series(0,102) AS n`,[owner.user.user_id]);
  const expected=Array.from({length:103},(_,index)=>`96000000-0000-4000-8000-${String(index).padStart(12,'0')}`).reverse();
  const bounded=await request('/marketing/campaigns?limit=10&offset=0',owner);
  assert.equal(bounded.status,200);assert.equal(bounded.data.items.length,10);assert.equal(bounded.data.next_offset,10);
  const first=await request('/marketing/campaigns?limit=50&offset=0',owner);
  const second=await request('/marketing/campaigns?limit=50&offset=50',owner);
  const tail=await request('/marketing/campaigns?limit=50&offset=100',owner);
  assert.deepEqual([...first.data.items,...second.data.items,...tail.data.items].map(item=>item.campaign_id),expected);
  assert.equal(first.data.next_offset,50);assert.equal(second.data.next_offset,100);
  assert.equal(tail.data.items.length,3);assert.equal(tail.data.next_offset,null);
  assert.deepEqual((await request('/marketing/campaigns?limit=20&offset=120',owner)).data,{items:[],next_offset:null});
  assert.deepEqual((await request('/marketing/campaigns',other)).data,{items:[],next_offset:null});
  for(const query of ['limit=0','limit=51','limit=1.5','offset=-1','offset=nope','extra=1'])
    assert.equal((await request(`/marketing/campaigns?${query}`,owner)).status,422,query);
});
test('campaign edits and manual shares are private, versioned, replayable and never claim publication',async()=>{
  const owner=await login(),other=await login(DEMO_USERS[1].email);let campaign=await createDraft(owner);
  assert.deepEqual((await request('/marketing/campaigns',other)).data.items,[]);
  assert.equal((await request(`/marketing/campaigns/${campaign.campaign_id}:revise`,other,campaignBody,campaign.aggregate_version)).status,404);
  const key=randomUUID(),share={channel:'Discord',share_url:'https://discord.com/channels/123/456/789',note:'自行記錄的示範連結，未驗證。'};
  const recorded=await request(`/marketing/campaigns/${campaign.campaign_id}/shares`,owner,share,campaign.aggregate_version,key);assert.equal(recorded.status,201);
  assert.equal(recorded.data.state,'draft');assert.equal(recorded.data.shares[0].verification_status,'self_reported');
  assert.deepEqual((await request(`/marketing/campaigns/${campaign.campaign_id}/shares`,owner,share,campaign.aggregate_version,key)).data,recorded.data);
  const originalSha=recorded.data.shares[0].content_sha256;campaign=recorded.data;
  const revised=await request(`/marketing/campaigns/${campaign.campaign_id}:revise`,owner,{...campaignBody,draft_text:'第二版文案'},campaign.aggregate_version);assert.equal(revised.status,200);
  assert.equal(revised.data.shares[0].content_sha256,originalSha);assert.notEqual(revised.data.content_sha256,originalSha);
  assert.equal((await request(`/marketing/campaigns/${campaign.campaign_id}:revise`,owner,campaignBody,campaign.aggregate_version)).status,412);
  assert.equal((await pool.query("SELECT count(*) FROM outbox WHERE event_type LIKE '%publication%' OR event_type LIKE '%payment%'")).rows[0].count,'0');
});
test('supplier campaigns pin an owned offer and remain unchanged by later price revisions',async()=>{
  const owner=await login(),other=await login(DEMO_USERS[1].email);
  const terms={net_price_minor:12000,currency:'TWD',availability:'finite',stock:10,shipping_terms:'三個工作天出貨',return_terms:'依約辦理退換貨'};
  const product=await request('/supplier/products',owner,{title:'測試茶包',specifications:'每盒二十包',...terms});assert.equal(product.status,201,JSON.stringify(product.data));
  assert.equal((await request('/marketing/campaigns',other,{...campaignBody,source_supplier_product_id:product.data.product_id})).status,404);
  const campaign=await createDraft(owner,{source_supplier_product_id:product.data.product_id});
  assert.equal(campaign.source_snapshot.kind,'supplier_product');assert.equal(campaign.source_snapshot.net_price_minor,'12000');assert.equal(campaign.source_snapshot.official,false);
  // Exercise the module application port through a persisted later offer, without cross-module writes.
  const change=await request(`/supplier/products/${product.data.product_id}/offer-versions`,owner,{...terms,net_price_minor:18000},product.data.aggregate_version);
  assert.equal(change.status,201,JSON.stringify(change.data));
  const saved=(await request('/marketing/campaigns',owner)).data.items[0];assert.equal(saved.source_snapshot.net_price_minor,'12000');assert.equal(saved.source_supplier_offer_id,product.data.current_offer.offer_version_id);
  assert.equal(saved.source_sha256,digest(saved.source_snapshot));
});
test('invalid source combinations, unsafe share links and missing session/CSRF never write',async()=>{
  const owner=await login(),campaign=await createDraft(owner);
  assert.equal((await request('/marketing/campaigns',owner,{...campaignBody,source_project_id:randomUUID(),source_supplier_product_id:randomUUID()})).status,422);
  assert.equal((await request('/marketing/campaigns',owner,campaignBody)).status,422);
  assert.equal((await request('/marketing/campaigns')).status,401);
  assert.equal((await request('/marketing/campaigns',owner,{...campaignBody,source_brief:'hello'},undefined,randomUUID(),{'X-CSRF-Token':'bad'})).status,403);
  for(const share_url of ['javascript:alert(1)','http://public.example/story','https://name:password@public.example/story','https://127.0.0.1/story']){
    assert.equal((await request(`/marketing/campaigns/${campaign.campaign_id}/shares`,owner,{channel:'web',share_url},campaign.aggregate_version)).status,422);
  }
  assert.equal((await pool.query('SELECT count(*) FROM marketing_share_records')).rows[0].count,'0');
});

test('external display URLs apply private-host policy to absolute DNS names without rewriting public links',async t=>{
  const {seen}=mockGitHub(t),owner=await login(),key=randomUUID();
  const showcase={title:'合成外部展示',description:'隔離 DNS root dot 邊界',consent_to_share:true};
  const facts=async()=>(await pool.query(`SELECT
    (SELECT count(*)::int FROM oss_projects) AS projects,
    (SELECT count(*)::int FROM oss_project_versions) AS versions,
    (SELECT count(*)::int FROM showcases) AS showcases,
    (SELECT count(*)::int FROM command_receipts) AS receipts,
    (SELECT count(*)::int FROM transition_journal) AS journal`)).rows[0];
  const before=await facts();
  for(const url of ['https://printer.local./secret','https://service.internal./secret','https://example.test./demo','https://example.invalid./demo','https://sub.localhost./demo','https://printer./demo','https://printer.local%2e/secret']){
    for(const [path,body] of [
      ['/opensource/projects',{...projectBody,demo_url:url}],
      ['/showcases',{...showcase,public_url:url}],
    ] as const){
      const denied=await request(path,owner,body,undefined,key);
      assert.equal(denied.status,422,url);assert.equal(denied.data.code,'invalid_external_url');
      assert.equal(JSON.stringify(denied.data).includes('printer.local'),false);
    }
    assert.deepEqual(await facts(),before);
  }
  assert.equal(seen.length,0);
  const publicUrl='https://public.example.com./demo?x=1#part';
  const projectBodyWithLink={...projectBody,demo_url:publicUrl};
  const project=await request('/opensource/projects',owner,projectBodyWithLink,undefined,key);
  assert.equal(project.status,201,JSON.stringify(project.data));assert.equal(project.data.demo_url,publicUrl);
  assert.deepEqual((await request('/opensource/projects',owner,projectBodyWithLink,undefined,key)).data,project.data);
  assert.equal(seen.length,3);
  const showcaseBody={...showcase,public_url:publicUrl};
  const created=await request('/showcases',owner,showcaseBody,undefined,key);
  assert.equal(created.status,201);assert.equal(created.data.public_url,publicUrl);
  assert.deepEqual((await request('/showcases',owner,showcaseBody,undefined,key)).data,created.data);
  assert.deepEqual(await facts(),{projects:before.projects+1,versions:before.versions+1,showcases:before.showcases+1,receipts:before.receipts+2,journal:before.journal+2});
});
