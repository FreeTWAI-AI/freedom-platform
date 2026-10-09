import {test,before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {createPool,LOCAL_DATABASE_URL} from '../../packages/db/index.js';
import {migrate} from '../../scripts/database.js';
import {GitHubSocial,type GitHubSocialConfig} from '../../modules/github-social/service.js';
import {GitHubSocialProvider,type GitHubDenialDiagnostic} from '../../modules/github-social/provider.js';
import type {Actor} from '../../modules/identity-membership/service.js';

const databaseUrl=process.env.TEST_DATABASE_URL??LOCAL_DATABASE_URL,schema=`fp_github_social_${process.pid}_${Date.now()}`;
const database=createPool(databaseUrl),pool=new Pool({connectionString:databaseUrl,options:`-c search_path=${schema}`,max:12});
const config:GitHubSocialConfig={clientId:'Iv1.test-client',clientSecret:'synthetic-client-secret',tokenKey:randomBytes(32).toString('base64'),redirectUri:'https://workshop.example.invalid/github/callback'};
const book='social-post',repository='Hao0321/claude-skill-social-post';
const snapshot={stargazers_count:42,forks_count:7,open_issues_count:11,subscribers_count:4,pushed_at:'2026-09-23T00:00:00Z',language:'Python',archived:false,private:false};
type Call={url:string;method:string;headers:Headers;body:string};
class GitHubMock {
  calls:Call[]=[];starred=false;expires=28800;metricsStatus=200;stats={...snapshot};tokenFailure=false;userId=12345;revokeFailure=false;starStatus=204;
  following=false;followStatus=204;followHeaders:Record<string,string>={};
  fetch:typeof fetch=async(input,init={})=>{
    const url=String(input),method=init.method??'GET',headers=new Headers(init.headers),body=String(init.body??'');this.calls.push({url,method,headers,body});
    assert.equal(init.redirect,'manual');assert.notEqual(init.redirect,'error');assert.ok(init.signal);assert.equal(headers.get('x-github-api-version'),'2026-03-10');
    if(url.startsWith('https://api.github.com/repos/'))return Response.json(this.metricsStatus===200?this.stats:{message:'synthetic provider failure'},{status:this.metricsStatus});
    if(url==='https://github.com/login/oauth/access_token'){
      if(this.tokenFailure)return Response.json({error:'bad_verification_code',error_description:'synthetic-secret-must-not-leak'});
      const refresh=new URLSearchParams(body).has('refresh_token');
      return Response.json({access_token:refresh?'ghu_refreshed':'ghu_synthetic',refresh_token:refresh?'ghr_rotated':'ghr_synthetic',token_type:'bearer',scope:'',expires_in:refresh?28800:this.expires,refresh_token_expires_in:15897600});
    }
    if(url==='https://api.github.com/user')return Response.json({id:this.userId,login:'verified-github-user'});
    if(url==='https://api.github.com/user/following/source-author'){
      if(this.followStatus!==204)return Response.json({message:'synthetic follow denial'},{status:this.followStatus,headers:this.followHeaders});
      if(method==='GET')return new Response(null,{status:this.following?204:404});
      assert.equal(headers.get('content-length'),'0');assert.equal(headers.get('authorization'),'Bearer ghu_synthetic');
      this.following=method==='PUT';return new Response(null,{status:204});
    }
    if(url===`https://api.github.com/user/starred/${repository}`){
      if(method==='GET')return new Response(null,{status:this.starred?204:404});
      if(this.starStatus!==204)return Response.json({message:'synthetic denial'},{status:this.starStatus});
      this.starred=method==='PUT';return new Response(null,{status:204});
    }
    if(url===`https://api.github.com/applications/${config.clientId}/token`&&method==='DELETE')return this.revokeFailure?Response.json({message:'unavailable'},{status:503}):new Response(null,{status:204});
    throw new Error('Unexpected mock endpoint');
  };
}
let actor:Actor,other:Actor,outsider:Actor,mock:GitHubMock,social:GitHubSocial;
before(async()=>{await database.query(`CREATE SCHEMA ${schema}`);await migrate(pool);});
after(async()=>{await pool.end();await database.query(`DROP SCHEMA ${schema} CASCADE`);await database.end();});
async function member(community:string):Promise<Actor>{
  const id=randomUUID(),csrf=randomBytes(16).toString('hex'),session=randomBytes(32).toString('hex');
  const user=(await pool.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref) VALUES($1,$2,$3,'Synthetic member','unused-test-password-hash',$4) RETURNING *`,[id,community,`${id}@example.invalid`,randomUUID()])).rows[0];
  await pool.query("INSERT INTO sessions VALUES($1,$2,$3,now()+interval '1 hour',NULL)",[session,id,csrf]);
  return {...user,session_hash:session,csrf_token:csrf};
}
beforeEach(async()=>{
  await pool.query('TRUNCATE communities,github_repository_metrics,skill_star_support CASCADE');
  const community=randomUUID(),outsideCommunity=randomUUID();await pool.query('INSERT INTO communities VALUES($1,$2),($3,$4)',[community,'Social tests',outsideCommunity,'Other community']);
  actor=await member(community);other=await member(community);outsider=await member(outsideCommunity);mock=new GitHubMock();social=new GitHubSocial(pool,config,mock.fetch);
});
function errorCode(code:string){return (error:unknown)=>!!error&&typeof error==='object'&&'code' in error&&error.code===code;}
async function connect(service=social,memberActor=actor){
  const start=await service.start(memberActor,'#guilds'),state=new URL(start.authorization_url).searchParams.get('state')!;
  return {start,state,complete:await service.complete(memberActor,state,'synthetic-code')};
}

test('GitHub author follow and unfollow use member token, confirm state and remain separate from workshop support',async()=>{
  assert.deepEqual(await social.following(actor,'source-author'),{username:'source-author',connected:false,following:null});
  await assert.rejects(()=>social.follow(actor,'source-author',true),errorCode('github_connect_required'));
  const connected=await connect();assert.equal(new URL(connected.start.authorization_url).searchParams.has('scope'),false);
  assert.equal((await social.following(actor,'source-author')).following,false);
  assert.equal((await social.follow(actor,'source-author',true)).confirmed,true);
  assert.equal((await social.following(actor,'source-author')).following,true);
  await social.follow(actor,'source-author',true);
  await social.follow(actor,'source-author',false);
  assert.equal((await social.following(actor,'source-author')).following,false);
  assert.equal((await pool.query('SELECT count(*) FROM skill_star_support')).rows[0].count,'0');
  await assert.rejects(()=>social.follow(other,'source-author',true),errorCode('github_connect_required'));
  const calls=mock.calls.length;
  await assert.rejects(()=>social.follow(actor,'../user',true));assert.equal(mock.calls.length,calls);
  await pool.query('UPDATE sessions SET revoked_at=now() WHERE token_hash=$1',[actor.session_hash]);
  await assert.rejects(()=>social.follow(actor,'source-author',true),errorCode('session_expired'));
});

test('GitHub follow permission denial requests reauthorization without discarding valid connection',async()=>{
  await connect();mock.followStatus=403;
  await assert.rejects(()=>social.follow(actor,'source-author',true),errorCode('github_follow_permission_required'));
  assert.equal((await social.session(actor)).connected,true);assert.equal(mock.following,false);
});

test('GitHub follow 401 removes expired credentials; 403 and 429 rate limits retain them',async()=>{
  await connect();
  for(const status of [403,429]){
    mock.followStatus=status;mock.followHeaders=status===403?{'x-ratelimit-remaining':'0'}:{};
    await assert.rejects(()=>social.follow(actor,'source-author',true),errorCode('github_rate_limited'));
    assert.equal((await social.session(actor)).connected,true);
  }
  mock.followStatus=401;mock.followHeaders={};
  await assert.rejects(()=>social.follow(actor,'source-author',true),errorCode('github_reconnect_required'));
  assert.equal((await social.session(actor)).connected,false);
});

test('GitHub follow member write budget stops requests before reaching provider',async()=>{
  await connect();
  for(let index=0;index<30;index++)await social.follow(actor,'source-author',true);
  const calls=mock.calls.length;
  await assert.rejects(()=>social.follow(actor,'source-author',false),errorCode('github_rate_limited'));
  assert.equal(mock.calls.length,calls);
});

test('only successful member-directed GitHub writes enter workshop rankings; reads and rejected writes do not',async()=>{
  await connect();mock.starred=true;
  await social.starred(actor,book);
  assert.equal((await pool.query('SELECT count(*) FROM skill_star_support')).rows[0].count,'0');
  mock.starStatus=403;
  await assert.rejects(()=>social.star(actor,book,true));
  assert.equal((await pool.query('SELECT count(*) FROM skill_star_support')).rows[0].count,'0');
  mock.starStatus=204;
  await social.star(actor,book,true);await social.star(actor,book,true);
  let rows=(await pool.query('SELECT * FROM skill_star_support')).rows;
  assert.equal(rows.length,1);assert.equal(rows[0].github_user_id,'12345');assert.equal(rows[0].active,true);
  mock.starred=false;await social.starred(actor,book);
  rows=(await pool.query('SELECT * FROM skill_star_support')).rows;assert.equal(rows[0].active,false);
});

async function seedMetrics(stars=snapshot.stargazers_count,options:{checked?:string;error?:string|null}={}){
  await pool.query(`INSERT INTO github_repository_metrics(repository_key,snapshot,checked_at,retry_after,last_error) VALUES($1,$2::jsonb,COALESCE($3::timestamptz,now()),now()+interval '1 hour',$4)
    ON CONFLICT(repository_key) DO UPDATE SET snapshot=EXCLUDED.snapshot,checked_at=EXCLUDED.checked_at,retry_after=EXCLUDED.retry_after,last_error=EXCLUDED.last_error`,
  [repository.toLowerCase(),JSON.stringify({...snapshot,stargazers_count:stars}),options.checked??null,options.error??null]);
}

test('public metrics read the stored catalog snapshot and never call GitHub',async()=>{
  await seedMetrics();
  const unconfigured=new GitHubSocial(pool,undefined,mock.fetch),another=new GitHubSocial(pool,undefined,mock.fetch);
  const all=await Promise.all(Array.from({length:12},(_,index)=>(index%2?unconfigured:another).metrics(book)));
  assert.equal(mock.calls.length,0);
  assert.ok(all.every(result=>result.stargazers_count===42&&result.forks_count===7&&result.open_issues_count===11&&result.subscribers_count===4&&result.stale===false&&result.error===null));
  assert.equal(all[0].repository_url,`https://github.com/${repository}`);assert.ok(all[0].checked_at);
  assert.deepEqual(await another.metrics(book),all[0]);assert.equal(mock.calls.length,0);
  await assert.rejects(()=>unconfigured.metrics('https://internal.example.invalid'),errorCode('skill_book_not_found'));assert.equal(mock.calls.length,0);
  assert.deepEqual(await unconfigured.session(actor),{configured:false,connected:false,github_user:null});
  await assert.rejects(()=>unconfigured.start(actor),errorCode('github_not_configured'));
});

test('page-view metrics ignore the operator token even when the stored row is due',async()=>{
  await seedMetrics();
  const token='github_pat_synthetic_metrics_token';
  const live=await new GitHubSocial(pool,undefined,mock.fetch,token).metrics(book);
  assert.equal(live.error,null);assert.equal(live.stargazers_count,42);assert.equal(mock.calls.length,0);
  await pool.query("UPDATE github_repository_metrics SET retry_after=now()-interval '1 minute'");
  const again=await new GitHubSocial(pool,undefined,mock.fetch,token).metrics(book);
  assert.equal(again.stargazers_count,42);assert.equal(mock.calls.length,0);
});

test('stored metrics keep real counters and a missing row stays null',async()=>{
  const checked=new Date(Date.now()-2*60*60*1000).toISOString();
  await seedMetrics(42,{checked,error:'github_unavailable'});
  const stale=await social.metrics(book);assert.equal(stale.stargazers_count,42);assert.equal(stale.stale,true);assert.equal(stale.error,'github_unavailable');assert.equal(stale.checked_at,new Date(checked).toISOString());
  assert.equal((await social.metrics(book)).checked_at,stale.checked_at);
  const missing=await social.metrics('security-scanner');assert.equal(missing.stargazers_count,null);assert.equal(missing.forks_count,null);assert.equal(missing.checked_at,null);assert.equal(missing.stale,true);
  await new GitHubSocial(pool,config,mock.fetch).metrics('security-scanner');assert.equal(mock.calls.length,0);
});

test('cached metrics for public documents never make a provider request',async()=>{
  const missing=await social.cachedMetrics(book);assert.equal(missing.stargazers_count,null);assert.equal(missing.stale,true);assert.equal(mock.calls.length,0);
  await seedMetrics();
  const live=await social.metrics(book);assert.deepEqual(await new GitHubSocial(pool).cachedMetrics(book),live);assert.equal(mock.calls.length,0);
  await pool.query("UPDATE github_repository_metrics SET checked_at=now()-interval '2 hours'");assert.equal((await social.cachedMetrics(book)).stale,true);assert.equal(mock.calls.length,0);
});

test('a GitHub redirect is rejected once and the Location target is never requested',async()=>{
  let calls=0;
  const fetcher:typeof fetch=async(input,init)=>{
    calls++;assert.equal(init?.redirect,'manual');assert.notEqual(init?.redirect,'error');
    assert.equal(String(input),`https://api.github.com/repos/${repository}`);
    return new Response(null,{status:302,headers:{Location:'https://elsewhere.example.invalid/followed'}});
  };
  await assert.rejects(()=>new GitHubSocialProvider(fetcher).metrics(repository),errorCode('github_unavailable'));
  assert.equal(calls,1);
  const opaque:typeof fetch=async()=>({type:'opaqueredirect',status:0,ok:true,headers:new Headers(),body:null} as unknown as Response);
  await assert.rejects(()=>new GitHubSocialProvider(opaque).metrics(repository),errorCode('github_unavailable'));
});

test('provider bounds response size, rejects redirects and malformed/private snapshots, and never leaks provider errors',async()=>{
  const providers:[typeof fetch,string][]=[
    [async()=>new Response(null,{status:302,headers:{Location:'https://elsewhere.example.invalid'}}),'github_unavailable'],
    [async()=>new Response('x'.repeat(128*1024+1)),'github_invalid_response'],
    [async()=>new Response('not-json'),'github_invalid_response'],
    [async()=>Response.json({...snapshot,private:true}),'github_invalid_response'],
    [async()=>Response.json({...snapshot,stargazers_count:-1}),'github_invalid_response'],
    [async()=>Response.json({secret:'must-not-leak'},{status:429}),'github_rate_limited'],
    [async()=>{throw new Error('synthetic access-token must-not-leak');},'github_unavailable'],
  ];
  for(const [fetcher,code] of providers)await assert.rejects(()=>new GitHubSocialProvider(fetcher).metrics(repository),error=>{assert.ok(errorCode(code)(error));assert.doesNotMatch(String(error),/must-not-leak/);return true;});
});

test('provider aborts requests at the deadline and limits simultaneous outbound requests',async context=>{
  context.mock.timers.enable({apis:['setTimeout']});
  const hanging:typeof fetch=async(_input,init)=>new Promise((_resolve,reject)=>init!.signal!.addEventListener('abort',()=>reject(new Error('aborted')),{once:true}));
  const timed=assert.rejects(()=>new GitHubSocialProvider(hanging).metrics(repository),errorCode('github_unavailable'));
  context.mock.timers.tick(8000);await timed;context.mock.timers.reset();
  let active=0,maximum=0;const release:(()=>void)[]=[];
  const deferred:typeof fetch=async()=>{active++;maximum=Math.max(maximum,active);await new Promise<void>(resolve=>release.push(resolve));active--;return Response.json(snapshot);};
  const provider=new GitHubSocialProvider(deferred),requests=Array.from({length:10},()=>provider.metrics(repository));
  assert.equal(active,4);
  while(release.length){release.shift()!();await new Promise(resolve=>setImmediate(resolve));}
  await Promise.all(requests);assert.equal(maximum,4);
});

test('GitHub permission denial directs administrators to permissions, while rate limits remain retryable',async()=>{
  const forbiddenEntries:GitHubDenialDiagnostic[]=[];
  const forbidden:typeof fetch=async()=>Response.json({message:'Resource not accessible by integration',secret:'must-not-leak'},{status:403,headers:{'x-accepted-github-permissions':'starring=write,metadata=read','x-ratelimit-remaining':'100','x-github-request-id':'C7A2:3F1B:1A2B3C:1B2C3D:670ABCDE'}});
  await assert.rejects(()=>new GitHubSocialProvider(forbidden,entry=>forbiddenEntries.push(entry)).star(repository,'ghu_synthetic',true),error=>{
    assert.ok(errorCode('github_permission_required')(error));assert.equal((error as {status?:number}).status,403);
    assert.match(String(error),/存取權限不足.*管理員/);assert.doesNotMatch(String(error),/暫時|稍後|must-not-leak/);return true;
  });
  assert.deepEqual(forbiddenEntries,[{event:'github_provider_denied',status:403,route:'PUT /user/starred/{repository}',reason:'not_accessible_by_integration',accepted_permissions:'starring=write,metadata=read',github_request_id:'C7A2:3F1B:1A2B3C:1B2C3D:670ABCDE',sso_required:false}]);
  assert.doesNotMatch(JSON.stringify(forbiddenEntries),/must-not-leak|ghu_synthetic|Resource not accessible|Hao0321\//);
  const limitedEntries:GitHubDenialDiagnostic[]=[];
  const limited:typeof fetch=async()=>Response.json({message:'synthetic secondary rate limit'},{status:403,headers:{'retry-after':'60'}});
  await assert.rejects(()=>new GitHubSocialProvider(limited,entry=>limitedEntries.push(entry)).star(repository,'ghu_synthetic',true),errorCode('github_rate_limited'));
  assert.deepEqual(limitedEntries,[]);
});

test('GitHub denial diagnostics keep only allow-listed values and never break the denial',async()=>{
  const ssoEntries:GitHubDenialDiagnostic[]=[];
  const sso:typeof fetch=async()=>Response.json({message:'Resource protected by organization SAML enforcement. You must grant your OAuth token access to this organization.'},{status:403,headers:{'x-github-sso':'required; url=https://github.com/orgs/synthetic/sso?authorization_request=must-not-leak','x-accepted-github-permissions':'starring=write; <script>','x-github-request-id':'A'.repeat(65),'x-ratelimit-remaining':'100'}});
  await assert.rejects(()=>new GitHubSocialProvider(sso,entry=>ssoEntries.push(entry)).star(repository,'ghu_synthetic',true),errorCode('github_permission_required'));
  assert.deepEqual(ssoEntries,[{event:'github_provider_denied',status:403,route:'PUT /user/starred/{repository}',reason:'sso_required',accepted_permissions:null,github_request_id:null,sso_required:true}]);
  const serialized=JSON.stringify(ssoEntries);assert.doesNotMatch(serialized,/must-not-leak|authorization_request|SAML/);
  const oversizeEntries:GitHubDenialDiagnostic[]=[];
  const oversize:typeof fetch=async()=>new Response(`{"message":"Resource not accessible by integration","pad":"${'x'.repeat(1_000_000)}"}`,{status:403,headers:{'x-ratelimit-remaining':'100'}});
  await assert.rejects(()=>new GitHubSocialProvider(oversize,entry=>oversizeEntries.push(entry)).star(repository,'ghu_synthetic',true),errorCode('github_permission_required'));
  assert.deepEqual(oversizeEntries,[{event:'github_provider_denied',status:403,route:'PUT /user/starred/{repository}',reason:'unknown',accepted_permissions:null,github_request_id:null,sso_required:false}]);
  const metricsEntries:GitHubDenialDiagnostic[]=[];
  const metricsForbidden:typeof fetch=async()=>Response.json({message:'Resource not accessible by integration'},{status:403,headers:{'x-ratelimit-remaining':'100'}});
  await assert.rejects(()=>new GitHubSocialProvider(metricsForbidden,entry=>metricsEntries.push(entry)).metrics(repository,'ghu_synthetic'),errorCode('github_permission_required'));
  assert.deepEqual(metricsEntries,[{event:'github_provider_denied',status:403,route:`GET /repos/{repository}`,reason:'not_accessible_by_integration',accepted_permissions:null,github_request_id:null,sso_required:false}]);
  const sinkDown:typeof fetch=async()=>Response.json({message:'Resource not accessible by integration'},{status:403,headers:{'x-ratelimit-remaining':'100'}});
  await assert.rejects(()=>new GitHubSocialProvider(sinkDown,()=>{throw new Error('log sink down');}).star(repository,'ghu_synthetic',true),errorCode('github_permission_required'));
  const tabbed:typeof fetch=async()=>Response.json({},{status:403,headers:{'x-accepted-github-permissions':'starring=write,\tmetadata=read','x-ratelimit-remaining':'100'}});
  const tabbedEntries:GitHubDenialDiagnostic[]=[];
  await assert.rejects(()=>new GitHubSocialProvider(tabbed,entry=>tabbedEntries.push(entry)).star(repository,'ghu_synthetic',true),errorCode('github_permission_required'));
  assert.equal(tabbedEntries[0]?.accepted_permissions,null);
});

test('a stalled denial body ends at the request deadline instead of holding the request',async context=>{
  context.mock.timers.enable({apis:['setTimeout']});
  const entries:GitHubDenialDiagnostic[]=[];
  const stalled:typeof fetch=async()=>new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('{"message":"Resource not'));}}),{status:403,headers:{'x-ratelimit-remaining':'100'}});
  const denied=assert.rejects(()=>new GitHubSocialProvider(stalled,entry=>entries.push(entry)).star(repository,'ghu_synthetic',true),errorCode('github_permission_required'));
  await new Promise(resolve=>setImmediate(resolve));assert.equal(entries.length,0);
  context.mock.timers.tick(8000);await denied;context.mock.timers.reset();
  assert.equal(entries.length,1);assert.equal(entries[0].reason,'unknown');
});

test('issue permission denial identifies an App that is registered but not installed',async()=>{
  const calls:string[]=[];
  const fetcher:typeof fetch=async input=>{
    const url=String(input);calls.push(url);
    if(url.endsWith('/freedom-platform/issues'))return Response.json({message:'Resource not accessible by integration'},{status:403,headers:{'x-ratelimit-remaining':'100'}});
    if(url.includes('/user/installations?'))return Response.json({installations:[]});
    throw Error('Unexpected GitHub endpoint');
  };
  await assert.rejects(()=>new GitHubSocialProvider(fetcher).createPlatformIssue('ghu_synthetic','Title','Body','page:account','123'),errorCode('github_installation_required'));
  assert.equal(calls.length,2);
});

test('OAuth uses PKCE, verifies GitHub identity, stores encrypted tokens and never stars during connection',async()=>{
  const {start,state,complete}=await connect(),url=new URL(start.authorization_url),tokenCall=mock.calls.find(call=>call.url.includes('/access_token'))!,body=new URLSearchParams(tokenCall.body);
  assert.equal(url.origin,'https://github.com');assert.equal(url.pathname,'/login/oauth/authorize');assert.equal(url.searchParams.get('redirect_uri'),config.redirectUri);assert.equal(url.searchParams.has('scope'),false);assert.equal(url.searchParams.get('code_challenge_method'),'S256');assert.equal(url.searchParams.get('code_challenge'),createHash('sha256').update(body.get('code_verifier')!).digest('base64url'));
  assert.equal(body.get('client_secret'),config.clientSecret);assert.equal(body.get('redirect_uri'),config.redirectUri);
  assert.deepEqual(complete,{configured:true,connected:true,github_user:{id:'12345',login:'verified-github-user'},return_to:'#guilds'});
  assert.deepEqual(await social.session(actor),{configured:true,connected:true,github_user:{id:'12345',login:'verified-github-user'}});
  assert.equal(mock.calls.some(call=>call.url.includes('/starred/')),false);
  const connection=(await pool.query('SELECT * FROM github_social_connections WHERE user_id=$1',[actor.user_id])).rows[0];
  assert.doesNotMatch(connection.encrypted_tokens,/ghu_|ghr_|access_token|refresh_token/);assert.doesNotMatch(JSON.stringify(complete),/ghu_|ghr_|token|secret/);
  assert.equal((await pool.query('SELECT * FROM github_social_oauth_states')).rowCount,0);
  await assert.rejects(()=>social.complete(actor,state,'synthetic-code'),errorCode('github_oauth_expired'));
  assert.deepEqual(await social.session(other),{configured:true,connected:false,github_user:null});
});

test('OAuth state is bound to current user, community and exact session, with expiry and local-only return target',async()=>{
  await assert.rejects(()=>social.start(actor,'https://elsewhere.example.invalid'),errorCode('github_return_to_invalid'));
  await assert.rejects(()=>social.start(actor,'/#guilds'),errorCode('github_return_to_invalid'));
  for(const target of ['/development/skills/unknown','//elsewhere.example.invalid','/development/skills/social-post?next=https://elsewhere.example.invalid','/development/skills/social-post/../../admin','/development/skills/%73ocial-post'])await assert.rejects(()=>social.start(actor,target),errorCode('github_return_to_invalid'));
  const initial=await social.start(actor),state=new URL(initial.authorization_url).searchParams.get('state')!;
  await assert.rejects(()=>social.complete(other,state,'code'),errorCode('github_oauth_expired'));
  await assert.rejects(()=>social.complete(outsider,state,'code'),errorCode('github_oauth_expired'));
  const secondSession={...actor,session_hash:randomBytes(32).toString('hex')};
  await pool.query("INSERT INTO sessions VALUES($1,$2,$3,now()+interval '1 hour',NULL)",[secondSession.session_hash,actor.user_id,actor.csrf_token]);
  await assert.rejects(()=>social.complete(secondSession,state,'code'),errorCode('github_oauth_expired'));
  assert.equal(mock.calls.length,0);
  await pool.query("UPDATE github_social_oauth_states SET expires_at=now()-interval '1 second'");
  await assert.rejects(()=>social.complete(actor,state,'code'),errorCode('github_oauth_expired'));
  await assert.rejects(()=>social.session({...actor,community_id:outsider.community_id}),errorCode('session_expired'));
});

test('failed token exchange consumes state and persistent attempt budgets survive provider errors',async()=>{
  const initial=await social.start(actor),state=new URL(initial.authorization_url).searchParams.get('state')!;mock.tokenFailure=true;
  await assert.rejects(()=>social.complete(actor,state,'code'),errorCode('github_reconnect_required'));
  await assert.rejects(()=>social.complete(actor,state,'code'),errorCode('github_oauth_expired'));
  assert.equal(mock.calls.length,1);assert.equal((await pool.query('SELECT * FROM github_social_oauth_states')).rowCount,0);
  for(let index=0;index<4;index++)await social.start(actor);
  await assert.rejects(()=>new GitHubSocial(pool,config,mock.fetch).start(actor),errorCode('github_rate_limited'));
  assert.equal((await social.session(actor)).connected,false);
});

test('explicit star and unstar use only authenticated member token and GitHub-confirmed state',async()=>{
  await connect();assert.deepEqual(await social.starred(actor,book),{book_id:book,connected:true,starred:false});
  assert.deepEqual(await social.star(actor,book,true),{book_id:book,connected:true,starred:true,confirmed:true});assert.equal(mock.starred,true);
  assert.equal((await social.starred(actor,book)).starred,true);assert.equal((await social.star(actor,book,false)).starred,false);assert.equal(mock.starred,false);
  const mutations=mock.calls.filter(call=>['PUT','DELETE'].includes(call.method));assert.equal(mutations.length,2);for(const mutation of mutations){assert.equal(mutation.url,`https://api.github.com/user/starred/${repository}`);assert.equal(mutation.headers.get('authorization'),'Bearer ghu_synthetic');assert.equal(mutation.headers.get('content-length'),'0');}
  await assert.rejects(()=>social.star(other,book,true),errorCode('github_connect_required'));
  await assert.rejects(()=>social.star(actor,'uncatalogued-repo',true),errorCode('skill_book_not_found'));
  mock.starStatus=403;await assert.rejects(()=>social.star(actor,book,true),errorCode('github_permission_required'));assert.equal(mock.starred,false);
  mock.starStatus=401;await assert.rejects(()=>social.star(actor,book,true),errorCode('github_reconnect_required'));assert.equal((await social.session(actor)).connected,false);
});

test('post-star counters come only from repository response and metrics failure cannot undo confirmed star',async()=>{
  await connect();const before=mock.calls.length;await social.metrics(book);assert.equal(mock.calls.length,before);mock.stats.stargazers_count=47;
  await social.star(actor,book,true);assert.equal((await social.cachedMetrics(book)).stargazers_count,47);
  await social.star(actor,book,true);assert.equal((await social.cachedMetrics(book)).stargazers_count,47); // Retried desired state is not +1.
  const metricCalls=mock.calls.filter(call=>call.url===`https://api.github.com/repos/${repository}`);assert.equal(metricCalls.length,2);assert.ok(metricCalls.every(call=>call.headers.get('authorization')==='Bearer ghu_synthetic'));
  mock.metricsStatus=503;assert.equal((await social.star(actor,book,false)).confirmed,true);assert.equal(mock.starred,false);
  const stale=await social.cachedMetrics(book);assert.equal(stale.stargazers_count,47);assert.equal(stale.stale,true);assert.equal(stale.error,'github_unavailable');
});

test('expired tokens refresh once under concurrent commands, reverify identity and persist rotated encryption',async()=>{
  mock.expires=1;await connect();const original=(await pool.query('SELECT encrypted_tokens FROM github_social_connections WHERE user_id=$1',[actor.user_id])).rows[0].encrypted_tokens;
  const otherInstance=new GitHubSocial(pool,config,mock.fetch);await Promise.all([social.star(actor,book,true),otherInstance.starred(actor,book)]);
  const refreshes=mock.calls.filter(call=>new URLSearchParams(call.body).get('grant_type')==='refresh_token');assert.equal(refreshes.length,1);assert.equal(new URLSearchParams(refreshes[0].body).get('refresh_token'),'ghr_synthetic');
  assert.equal(mock.calls.filter(call=>call.url==='https://api.github.com/user').length,2);
  assert.ok(mock.calls.filter(call=>call.url.includes('/starred/')).every(call=>call.headers.get('authorization')==='Bearer ghu_refreshed'));
  assert.notEqual((await pool.query('SELECT encrypted_tokens FROM github_social_connections WHERE user_id=$1',[actor.user_id])).rows[0].encrypted_tokens,original);
});

test('refresh identity mismatch and moved ciphertext cannot act on another member GitHub account',async()=>{
  mock.expires=1;await connect();mock.userId=99999;
  await assert.rejects(()=>social.star(actor,book,true),errorCode('github_reconnect_required'));assert.equal((await social.session(actor)).connected,false);assert.equal(mock.calls.some(call=>call.method==='PUT'),false);
  mock.expires=28800;mock.userId=12345;await connect();
  await pool.query(`INSERT INTO github_social_connections(user_id,community_id,github_user_id,github_login,encrypted_tokens) SELECT $1,$2,'67890',github_login,encrypted_tokens FROM github_social_connections WHERE user_id=$3`,[other.user_id,other.community_id,actor.user_id]);
  await assert.rejects(()=>social.star(other,book,true),errorCode('github_reconnect_required'));assert.equal((await social.session(other)).connected,false);assert.equal((await social.session(actor)).connected,true);
});

test('disconnect invalidates pending OAuth and local credentials even if GitHub cannot revoke remotely',async()=>{
  await connect();const pending=await social.start(actor),state=new URL(pending.authorization_url).searchParams.get('state')!;mock.revokeFailure=true;
  assert.deepEqual(await social.disconnect(actor),{configured:true,connected:false,github_user:null,provider_revoked:false});
  await assert.rejects(()=>social.complete(actor,state,'code'),errorCode('github_oauth_expired'));
  await assert.rejects(()=>social.star(actor,book,true),errorCode('github_connect_required'));
  assert.equal((await pool.query('SELECT * FROM github_social_connections')).rowCount,0);
  assert.equal(mock.calls.filter(call=>call.url.includes('/applications/')).length,1);
});

test('revoked and expired workshop sessions and inactive members cannot read or mutate GitHub state',async()=>{
  await connect();const calls=mock.calls.length;
  await pool.query('UPDATE sessions SET revoked_at=now() WHERE token_hash=$1',[actor.session_hash]);
  for(const operation of [()=>social.session(actor),()=>social.start(actor),()=>social.starred(actor,book),()=>social.star(actor,book,true),()=>social.disconnect(actor)])await assert.rejects(operation,errorCode('session_expired'));
  assert.equal(mock.calls.length,calls);
  await pool.query("UPDATE sessions SET revoked_at=NULL,expires_at=now()-interval '1 minute' WHERE token_hash=$1",[actor.session_hash]);await assert.rejects(()=>social.session(actor),errorCode('session_expired'));
  await pool.query('UPDATE users SET active=false WHERE user_id=$1',[other.user_id]);await assert.rejects(()=>social.start(other),errorCode('session_expired'));
});


test('OAuth preserves only an exact catalog skill page as a public return destination',async()=>{
  const start=await social.start(actor,'/development/skills/social-post'),state=new URL(start.authorization_url).searchParams.get('state')!;
  const result=await social.complete(actor,state,'synthetic-code');assert.equal(result.return_to,'/development/skills/social-post');
  assert.equal(mock.calls.some(call=>call.url.includes('/starred/')),false);
});

test('Follow rejects a session that expires while waiting for the GitHub member lock',async()=>{
  await connect();mock.calls=[];
  const blocker=await pool.connect();
  try{
    await pool.query("UPDATE sessions SET expires_at=clock_timestamp()+interval '2 seconds' WHERE token_hash=$1",[actor.session_hash]);
    await blocker.query('BEGIN');
    await blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`github-social/${actor.user_id}`]);
    const pending=social.follow(actor,'source-author',true);
    const rejected=assert.rejects(pending,errorCode('session_expired'));
    // Prove the operation reached its advisory wait before crossing expiry.
    const deadline=Date.now()+1500;let waiting=false;
    while(Date.now()<deadline){
      waiting=(await pool.query("SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND NOT granted AND objid::bigint=(hashtextextended($1,0)&4294967295) AND classid::bigint=((hashtextextended($1,0)>>32)&4294967295)) AS waiting",[`github-social/${actor.user_id}`])).rows[0].waiting;
      if(waiting)break;await new Promise(resolve=>setTimeout(resolve,10));
    }
    assert.equal(waiting,true,'Follow must reach the member-lock barrier');
    await blocker.query('SELECT pg_sleep(2.1)');await blocker.query('COMMIT');
    await rejected;
    assert.equal(mock.calls.some(call=>call.url.includes('/user/following/')&&call.method!=='GET'),false);
  }finally{await blocker.query('ROLLBACK');blocker.release();}
});
