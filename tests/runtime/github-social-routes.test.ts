import {test,before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {createPool,LOCAL_DATABASE_URL} from '../../packages/db/index.js';
import {migrate} from '../../scripts/database.js';
import {seedLocal,DEMO_COMMUNITY,DEMO_USERS,DEMO_PASSWORD} from '../../packages/testing/seed.js';
import {createApp} from '../../apps/platform-api/src/app.js';

const origin='http://127.0.0.1:4310',url=process.env.TEST_DATABASE_URL??LOCAL_DATABASE_URL;
const schema=`fp_social_routes_${process.pid}_${Date.now()}`,database=createPool(url),pool=new Pool({connectionString:url,options:`-c search_path=${schema}`});
const tokenKey=Buffer.alloc(32,9).toString('base64'),adminId=randomUUID();
const config={clientId:'Iv1.route-tests',clientSecret:'test-secret-only-not-a-credential',tokenKey,redirectUri:origin+'/github/callback'};
let calls:{path:string;method:string;authorization:string|null}[]=[],starred=false,issueWrites=0,issueStatus=201,issueBody='',commentWrites=0,commentStatus=201,commentBody='';
const fetcher:typeof fetch=async(input,init)=>{
 const u=new URL(String(input));calls.push({path:u.pathname,method:init?.method??'GET',authorization:new Headers(init?.headers).get('Authorization')});
 if(u.origin==='https://github.com'&&u.pathname==='/login/oauth/access_token')return Response.json({access_token:'ghu_synthetic_route_test',token_type:'bearer',scope:'',expires_in:28800,refresh_token:'ghr_synthetic_route_test',refresh_token_expires_in:15897600});
 assert.equal(u.origin,'https://api.github.com');
 if(u.pathname==='/user')return Response.json({id:901,login:'actual-member'});
 if(u.pathname==='/user/following/source-author')return new Response(null,{status:init?.method==='PUT'||init?.method==='DELETE'?204:404});
 if(u.pathname.startsWith('/user/starred/')){
  if(init?.method==='PUT')starred=true;else if(init?.method==='DELETE')starred=false;
  return new Response(null,{status:init?.method==='PUT'||init?.method==='DELETE'||starred?204:404});
 }
 if(u.pathname==='/repos/FreeTWAI-AI/freedom-platform/issues'&&init?.method==='POST'){
  issueWrites++;issueBody=String(init.body);
  return issueStatus===201?Response.json({number:42,user:{id:901}},{status:201}):new Response(null,{status:issueStatus});
 }
 if(u.pathname==='/repos/FreeTWAI-AI/freedom-platform/issues/42'&&(init?.method??'GET')==='GET')return Response.json({number:42,title:'讓首頁引導更清楚',state:'open',body:'首頁提案\n<!-- freedom-page:home -->',labels:[{name:'page:home'}]});
 if(u.pathname==='/repos/FreeTWAI-AI/freedom-platform/issues/42/comments'&&init?.method==='POST'){
  commentWrites++;commentBody=String(init.body);
  return commentStatus===201?Response.json({id:91,user:{id:901},html_url:'https://github.com/FreeTWAI-AI/freedom-platform/issues/42#issuecomment-91'},{status:201}):new Response(null,{status:commentStatus});
 }
 if(u.pathname.startsWith('/repos/'))return Response.json({private:false,stargazers_count:starred?8:7,forks_count:3,open_issues_count:2,subscribers_count:1,pushed_at:'2026-09-20T12:00:00Z',language:'TypeScript',archived:false});
 if(u.pathname.startsWith('/applications/'))return new Response(null,{status:204});
 throw Error('Unexpected provider endpoint');
};
let app=createApp(pool,origin,'local',{githubSocial:{config,fetcher}});
type Member={cookie:string;csrf:string};
let member:Member;
async function login(index=0):Promise<Member>{
 const r=await app.request(origin+'/api/v1/auth/login',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({email:DEMO_USERS[index].email,password:DEMO_PASSWORD})});
 assert.equal(r.status,200);const data=await r.json() as any;return {cookie:r.headers.get('set-cookie')!.split(';')[0],csrf:data.csrf_token};
}
async function request(path:string,body?:unknown,as=member,headers:Record<string,string>={}){
 return app.request(origin+'/api/v1'+path,{method:body===undefined?'GET':'POST',headers:{Origin:origin,Cookie:as?.cookie??'','Content-Type':'application/json','X-CSRF-Token':as?.csrf??'',...headers},...(body!==undefined?{body:JSON.stringify(body)}:{})});
}
async function connect(as=member){
 const begin=await request('/me/github/connect',{return_to:'#community'},as);assert.equal(begin.status,200);
 const value=await begin.json() as any,u=new URL(value.authorization_url);
 assert.equal(u.origin,'https://github.com');assert.equal(u.searchParams.get('code_challenge_method'),'S256');assert.equal(u.searchParams.get('scope'),null);
 const body={state:u.searchParams.get('state'),code:'synthetic-code'};
 const response=await request('/me/github/complete',body,as);assert.equal(response.status,200,await response.clone().text());
 return body;
}
before(async()=>{await database.query(`CREATE SCHEMA ${schema}`);await migrate(pool);});
after(async()=>{await pool.end();await database.query(`DROP SCHEMA ${schema} CASCADE`);await database.end();});
beforeEach(async()=>{
 await pool.query('TRUNCATE communities,login_attempts,auth_rate_limits,github_repository_metrics CASCADE');await seedLocal(pool);
 calls=[];starred=false;issueWrites=0;issueStatus=201;issueBody='';commentWrites=0;commentStatus=201;commentBody='';app=createApp(pool,origin,'local',{githubSocial:{config,fetcher}});member=await login();
});

test('author follow routes enforce session, CSRF, origin and explicit confirmed desired state',async()=>{
 const path='/me/github/authors/source-author/follow',body={following:true,confirmed:true};
 assert.equal((await app.request(origin+'/api/v1'+path)).status,401);
 assert.equal((await request(path,body,member,{'X-CSRF-Token':'wrong'})).status,403);
 assert.equal((await request(path,body,member,{Origin:'https://elsewhere.invalid'})).status,403);
 assert.equal((await request(path,{following:true})).status,422);
 assert.equal((await request(path,{...body,username:'another'})).status,422);
 await connect();
 assert.equal((await request(path)).status,200);
 const result=await request(path,body);assert.equal(result.status,200);
 assert.deepEqual(await result.json(),{username:'source-author',connected:true,following:true,confirmed:true});
 assert.equal((await request(path,{following:false,confirmed:true})).status,200);
 assert.ok(calls.some(call=>call.path==='/user/following/source-author'&&call.method==='PUT'&&call.authorization==='Bearer ghu_synthetic_route_test'));
 assert.ok(calls.some(call=>call.path==='/user/following/source-author'&&call.method==='DELETE'));
 const other=await login(1);assert.equal((await request(path,body,other)).status,409);
});

test('member issue submission uses that member’s GitHub token and keeps the page marker without duplicate writes',async()=>{
 await connect();
 const body={title:'讓首頁引導更清楚',description:'目前入口不夠清楚，希望說明下一步。',confirmed:true};
 const headers={'Idempotency-Key':'page-issue-test-001'};
 const first=await request('/me/github/pages/home/issues',body,member,headers);
 assert.equal(first.status,201,await first.clone().text());
 assert.deepEqual(await first.json(),{confirmed:true,issue_number:42,issue_url:'https://github.com/FreeTWAI-AI/freedom-platform/issues/42'});
 assert.equal(issueWrites,1);assert.match(issueBody,/<!-- freedom-page:home -->/);assert.deepEqual(JSON.parse(issueBody).labels,['page:home']);
 await pool.query("UPDATE github_page_issue_submissions SET issue_title=NULL WHERE operation_key='page-issue-test-001'");
 const own=await request('/me/github/pages/home/issues');assert.equal(own.status,200);
 assert.deepEqual((await own.json() as any).items.map((item:any)=>({key:item.operation_key,state:item.state,number:item.issue_number,title:item.title,url:item.issue_url})),[{key:'page-issue-test-001',state:'confirmed',number:42,title:body.title,url:'https://github.com/FreeTWAI-AI/freedom-platform/issues/42'}]);
 assert.deepEqual((await (await request('/me/github/pages/positioning/issues')).json() as any).items,[]);
 assert.equal((await request('/me/github/pages/unknown/issues')).status,404);
 assert.equal((await app.request(origin+'/api/v1/me/github/pages/home/issues')).status,401);
 assert.ok(calls.some(call=>call.path==='/repos/FreeTWAI-AI/freedom-platform/issues'&&call.authorization==='Bearer ghu_synthetic_route_test'));
 assert.equal((await request('/me/github/pages/home/issues',body,member,headers)).status,201);
 assert.equal(issueWrites,1);
 issueStatus=403;
 const denied=await request('/me/github/pages/positioning/issues',{...body,title:'定位說明可以改善'},member,{'Idempotency-Key':'page-issue-test-002'});
 assert.equal(denied.status,403);assert.equal(issueWrites,2);
 assert.equal((await pool.query("SELECT state FROM github_page_issue_submissions WHERE operation_key='page-issue-test-002'")).rows[0].state,'denied');
});

test('design claim posts as the connected member once, preserves the marker, and rejects unrelated issues',async()=>{
 await connect();
 const path='/me/github/pages/home/issues/42/design-claim',body={message:'我願意接手這個 Issue 的設計，請維護者確認範圍。',confirmed:true};
 const headers={'Idempotency-Key':'design-claim-test-001'};
 assert.equal((await request(path,{...body,message:'太短'},member,headers)).status,422);
 assert.equal((await request('/me/github/pages/positioning/issues/42/design-claim',body,member,headers)).status,422);
 const first=await request(path,body,member,headers);
 assert.equal(first.status,201,await first.clone().text());
 assert.deepEqual(await first.json(),{confirmed:true,issue_number:42,comment_url:'https://github.com/FreeTWAI-AI/freedom-platform/issues/42#issuecomment-91'});
 assert.equal(commentWrites,1);assert.match(JSON.parse(commentBody).body,/<!-- freedom-design-claim -->/);
 assert.ok(calls.some(call=>call.path==='/repos/FreeTWAI-AI/freedom-platform/issues/42/comments'&&call.authorization==='Bearer ghu_synthetic_route_test'));
 assert.equal((await request(path,body,member,headers)).status,201);assert.equal(commentWrites,1);
 assert.equal((await request(path,{...body,message:'改成另一段認領內容。'},member,headers)).status,409);
 const own=await request('/me/github/pages/home/design-claims');
 assert.deepEqual((await own.json() as any).items.map((item:any)=>({state:item.state,number:item.issue_number,url:item.comment_url})),[{state:'confirmed',number:42,url:'https://github.com/FreeTWAI-AI/freedom-platform/issues/42#issuecomment-91'}]);
 assert.equal((await request('/me/github/pages/positioning/design-claims')).status,200);
 assert.equal((await request(path,body,member,{'X-CSRF-Token':'wrong',...headers})).status,403);
});

test('ambiguous design claim response remains pending and cannot be reposted',async()=>{
 await connect();commentStatus=503;
 const path='/me/github/pages/home/issues/42/design-claim',body={message:'我願意協助完成首頁這個 Issue 的設計。',confirmed:true};
 const first=await request(path,body,member,{'Idempotency-Key':'design-claim-test-002'});
 assert.equal(first.status,502);assert.equal(commentWrites,1);
 assert.equal((await request(path,body,member,{'Idempotency-Key':'design-claim-test-002'})).status,409);
 assert.equal(commentWrites,1);
 assert.equal((await (await request('/me/github/pages/home/design-claims')).json() as any).items[0].state,'pending');
});

test('public metrics read the stored catalog snapshot and appear in no-JavaScript skill pages',async()=>{
 await pool.query(`INSERT INTO github_repository_metrics(repository_key,snapshot,checked_at,retry_after,last_error) VALUES('teddashh/ai-security-scanner',$1::jsonb,now(),now()+interval '1 hour',NULL)`,[JSON.stringify({stargazers_count:7,forks_count:3,open_issues_count:2,subscribers_count:1,pushed_at:'2026-09-20T12:00:00Z',language:'TypeScript',archived:false})]);
 const r=await app.request(origin+'/api/v1/github/books/security-scanner/metrics');assert.equal(r.status,200);
 const data=await r.json() as any;assert.equal(data.stargazers_count,7);assert.equal(data.forks_count,3);assert.equal(data.repository_url,'https://github.com/teddashh/ai-security-scanner');assert.equal(data.stale,false);
 assert.deepEqual(calls,[]);
 await app.request(origin+'/api/v1/github/books/security-scanner/metrics');assert.equal(calls.length,0);
 const html=await (await app.request(origin+'/development/skills/security-scanner')).text();assert.ok(html.includes('Stars 7'));assert.ok(html.includes('Forks 3'));assert.ok(html.includes('登入工坊 Star'));assert.equal(calls.length,0);
 assert.equal((await app.request(origin+'/api/v1/github/books/not-a-real-book/metrics')).status,404);
 assert.equal((await app.request(origin+'/api/v1/me/github')).status,401);
});

test('member OAuth and star routes enforce origin, CSRF and explicit desired state before guild selection',async()=>{
 assert.equal((await request('/me/github/connect',{},member,{'X-CSRF-Token':'wrong'})).status,403);
 assert.equal((await request('/me/github/connect',{},member,{Origin:'https://elsewhere.invalid'})).status,403);
 assert.equal((await request('/me/github/connect',{return_to:'https://elsewhere.invalid'})).status,422);
 assert.equal((await request('/me/github/books/security-scanner/star',{starred:true})).status,422);
 assert.equal((await request('/me/github/books/security-scanner/star',{starred:true,confirmed:true,token:'override'})).status,422);
 await pool.query('UPDATE users SET onboarding_required=true,onboarding_completed_at=NULL WHERE user_id=$1',[DEMO_USERS[0].user_id]);
 assert.equal((await request('/me/github',undefined)).status,200);
 assert.equal(calls.length,0);
 await connect();
 assert.equal((await request('/me/github/books/security-scanner/star',{starred:true,confirmed:true})).status,200);
 assert.equal((await (await request('/me/github/books/security-scanner/star')).json() as any).starred,true);
 const before=calls.length;
 assert.equal((await request('/me/github/authors/source-author/follow',{following:true,confirmed:true})).status,403);
 assert.equal((await request('/me/github/pages/home/issues',{title:'首頁提案',description:'尚未選擇公會的提案內容',confirmed:true})).status,403);
 assert.equal(calls.length,before);
 assert.equal((await request('/me/github/disconnect',{})).status,200);
});

test('OAuth binds the exact member session; direct Star uses that member token and never publishes credentials',async()=>{
 const begin=await request('/me/github/connect',{return_to:'#community'}),value=await begin.json() as any;
 const body={state:new URL(value.authorization_url).searchParams.get('state'),code:'synthetic-code'};
 const other=await login(1);assert.equal((await request('/me/github/complete',body,other)).status,409);assert.equal(calls.length,0);
 const finish=await request('/me/github/complete',body);assert.equal(finish.status,200);const text=await finish.text();assert.ok(!/ghu_|ghr_|clientSecret|encrypted_tokens/.test(text));
 assert.equal((await request('/me/github/complete',body)).status,409);
 const before=await request('/me/github/books/security-scanner/star');assert.equal((await before.json() as any).starred,false);
 const update=await request('/me/github/books/security-scanner/star',{starred:true,confirmed:true});assert.equal(update.status,200);assert.equal((await update.json() as any).starred,true);
 assert.ok(calls.some(x=>x.path==='/user/starred/teddashh/ai-security-scanner'&&x.method==='PUT'&&x.authorization==='Bearer ghu_synthetic_route_test'));
 assert.equal((await (await request('/me/github',undefined,other)).json() as any).connected,false);
 await request('/me/github/books/security-scanner/star',{starred:false,confirmed:true});assert.equal(starred,false);
 const stored=(await pool.query('SELECT encrypted_tokens FROM github_social_connections')).rows[0].encrypted_tokens;assert.ok(!stored.includes('ghu_'));assert.ok(!stored.includes('ghr_'));
});

test('an account switch or revoked session cannot finish an old OAuth flow or write Stars',async()=>{
 const begin=await request('/me/github/connect',{}),value=await begin.json() as any;
 const body={state:new URL(value.authorization_url).searchParams.get('state'),code:'synthetic-code'};
 const sameMemberNewSession=await login();assert.equal((await request('/me/github/complete',body,sameMemberNewSession)).status,409);
 await connect();await request('/auth/logout',{});
 assert.equal((await request('/me/github/books/security-scanner/star',{starred:true,confirmed:true})).status,401);
 assert.equal(calls.filter(x=>x.method==='PUT').length,0);
});

test('admin setup is separately authorized and limits the external form destination to GitHub registration',async()=>{
 await pool.query('INSERT INTO platform_admins(admin_id,community_id,email,display_name) VALUES($1,$2,$3,$4)',[adminId,DEMO_COMMUNITY,'setup-admin@example.invalid','Setup Admin']);
 app=createApp(pool,origin,'local',{githubSocial:{tokenKey,fetcher},adminVerifier:async req=>{
  if(req.headers.get('X-Synthetic-Admin')!=='valid')throw Error('Synthetic authorization missing');
  return {email:'setup-admin@example.invalid',subject:'synthetic-setup-admin',csrfToken:'admin-csrf'};
 }});
 const adminRequest=(path:string,body?:unknown,csrf='admin-csrf')=>app.request(origin+'/admin/api'+path,{method:body===undefined?'GET':'POST',headers:{Origin:origin,'Content-Type':'application/json','X-Synthetic-Admin':'valid','X-Admin-CSRF':csrf},...(body!==undefined?{body:JSON.stringify(body)}:{})});
 assert.equal((await adminRequest('/github-app/start',{},'wrong')).status,403);
 const start=await adminRequest('/github-app/start',{});assert.equal(start.status,200);const setup=await start.json() as any,manifest=JSON.parse(setup.manifest);
 assert.equal(new URL(setup.target).pathname,'/organizations/FreeTWAI-AI/settings/apps/new');assert.deepEqual(manifest.default_permissions,{starring:'write',metadata:'read',issues:'write'});assert.deepEqual(manifest.callback_urls,[origin+'/github/callback']);
 assert.equal(manifest.hook_attributes.active,false);assert.ok(!JSON.stringify(setup).includes('client_secret'));
 assert.deepEqual(await (await adminRequest('/github-app')).json(),{configured:false,setup_available:true});
 for(const path of ['/admin','/admin/github/callback'])assert.match((await app.request(origin+path)).headers.get('content-security-policy')!,/form-action 'self' https:\/\/github\.com\/organizations\/FreeTWAI-AI\/settings\/apps\/new/);
 assert.ok(!(await app.request(origin+'/github/callback')).headers.get('content-security-policy')!.includes('form-action \'self\' https:'));
 assert.equal(calls.length,0);
});
