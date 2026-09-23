import {test,before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {createPool,LOCAL_DATABASE_URL} from '../../packages/db/index.js';
import {migrate} from '../../scripts/database.js';
import {GitHubSocial,type GitHubSocialConfig} from '../../modules/github-social/service.js';
import {GitHubSocialProvider} from '../../modules/github-social/provider.js';
import type {Actor} from '../../modules/identity-membership/service.js';

const databaseUrl=process.env.TEST_DATABASE_URL??LOCAL_DATABASE_URL,schema=`fp_github_social_${process.pid}_${Date.now()}`;
const database=createPool(databaseUrl),pool=new Pool({connectionString:databaseUrl,options:`-c search_path=${schema}`,max:12});
const config:GitHubSocialConfig={clientId:'Iv1.test-client',clientSecret:'synthetic-client-secret',tokenKey:randomBytes(32).toString('base64'),redirectUri:'https://workshop.example.invalid/github/callback'};
const book='social-post',repository='Hao0321/claude-skill-social-post';
const snapshot={stargazers_count:42,forks_count:7,open_issues_count:11,subscribers_count:4,pushed_at:'2026-09-23T00:00:00Z',language:'Python',archived:false,private:false};
type Call={url:string;method:string;headers:Headers;body:string};
class GitHubMock {
  calls:Call[]=[];starred=false;expires=28800;metricsStatus=200;stats={...snapshot};tokenFailure=false;userId=12345;revokeFailure=false;starStatus=204;
  fetch:typeof fetch=async(input,init={})=>{
    const url=String(input),method=init.method??'GET',headers=new Headers(init.headers),body=String(init.body??'');this.calls.push({url,method,headers,body});
    assert.equal(init.redirect,'error');assert.ok(init.signal);assert.equal(headers.get('x-github-api-version'),'2026-03-10');
    if(url.startsWith('https://api.github.com/repos/'))return Response.json(this.metricsStatus===200?this.stats:{message:'synthetic provider failure'},{status:this.metricsStatus});
    if(url==='https://github.com/login/oauth/access_token'){
      if(this.tokenFailure)return Response.json({error:'bad_verification_code',error_description:'synthetic-secret-must-not-leak'});
      const refresh=new URLSearchParams(body).has('refresh_token');
      return Response.json({access_token:refresh?'ghu_refreshed':'ghu_synthetic',refresh_token:refresh?'ghr_rotated':'ghr_synthetic',token_type:'bearer',scope:'',expires_in:refresh?28800:this.expires,refresh_token_expires_in:15897600});
    }
    if(url==='https://api.github.com/user')return Response.json({id:this.userId,login:'verified-github-user'});
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
  await pool.query('TRUNCATE communities,github_repository_metrics CASCADE');
  const community=randomUUID(),outsideCommunity=randomUUID();await pool.query('INSERT INTO communities VALUES($1,$2),($3,$4)',[community,'Social tests',outsideCommunity,'Other community']);
  actor=await member(community);other=await member(community);outsider=await member(outsideCommunity);mock=new GitHubMock();social=new GitHubSocial(pool,config,mock.fetch);
});
function errorCode(code:string){return (error:unknown)=>!!error&&typeof error==='object'&&'code' in error&&error.code===code;}
async function connect(service=social,memberActor=actor){
  const start=await service.start(memberActor,'#guilds'),state=new URL(start.authorization_url).searchParams.get('state')!;
  return {start,state,complete:await service.complete(memberActor,state,'synthetic-code')};
}

test('public metrics use original allowlisted repository and persist real counts across service instances',async()=>{
  const unconfigured=new GitHubSocial(pool,undefined,mock.fetch),another=new GitHubSocial(pool,undefined,mock.fetch);
  const all=await Promise.all(Array.from({length:12},(_,index)=>(index%2?unconfigured:another).metrics(book)));
  assert.equal(mock.calls.length,1);assert.equal(mock.calls[0].url,`https://api.github.com/repos/${repository}`);assert.equal(mock.calls[0].headers.has('authorization'),false);
  assert.ok(all.every(result=>result.stargazers_count===42&&result.forks_count===7&&result.open_issues_count===11&&result.subscribers_count===4&&result.stale===false&&result.error===null));
  assert.equal(all[0].repository_url,`https://github.com/${repository}`);assert.ok(all[0].checked_at);
  assert.deepEqual(await another.metrics(book),all[0]);assert.equal(mock.calls.length,1);
  await assert.rejects(()=>unconfigured.metrics('https://internal.example.invalid'),errorCode('skill_book_not_found'));assert.equal(mock.calls.length,1);
  assert.deepEqual(await unconfigured.session(actor),{configured:false,connected:false,github_user:null});
  await assert.rejects(()=>unconfigured.start(actor),errorCode('github_not_configured'));
});

test('failed refresh retains dated real counters and a first failure returns null, never invented zero',async()=>{
  const first=await social.metrics(book);await pool.query("UPDATE github_repository_metrics SET retry_after=now()-interval '1 minute',checked_at=now()-interval '2 hours'");mock.metricsStatus=503;
  const stale=await social.metrics(book);assert.equal(stale.stargazers_count,first.stargazers_count);assert.equal(stale.stale,true);assert.equal(stale.error,'github_unavailable');assert.notEqual(stale.checked_at,first.checked_at);
  const missing=await social.metrics('security-scanner');assert.equal(missing.stargazers_count,null);assert.equal(missing.forks_count,null);assert.equal(missing.checked_at,null);assert.equal(missing.stale,true);
  const attempts=mock.calls.length;await new GitHubSocial(pool,config,mock.fetch).metrics('security-scanner');assert.equal(mock.calls.length,attempts);
});

test('cached metrics for public documents never make a provider request',async()=>{
  const missing=await social.cachedMetrics(book);assert.equal(missing.stargazers_count,null);assert.equal(missing.stale,true);assert.equal(mock.calls.length,0);
  const live=await social.metrics(book),count=mock.calls.length;assert.deepEqual(await new GitHubSocial(pool).cachedMetrics(book),live);assert.equal(mock.calls.length,count);
  await pool.query("UPDATE github_repository_metrics SET checked_at=now()-interval '2 hours'");assert.equal((await social.cachedMetrics(book)).stale,true);assert.equal(mock.calls.length,count);
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
  await connect();await social.metrics(book);mock.stats.stargazers_count=47;
  await social.star(actor,book,true);assert.equal((await social.cachedMetrics(book)).stargazers_count,47);
  await social.star(actor,book,true);assert.equal((await social.cachedMetrics(book)).stargazers_count,47); // Retried desired state is not +1.
  const metricCalls=mock.calls.filter(call=>call.url===`https://api.github.com/repos/${repository}`);assert.equal(metricCalls.length,3);assert.equal(metricCalls[0].headers.has('authorization'),false);assert.ok(metricCalls.slice(1).every(call=>call.headers.get('authorization')==='Bearer ghu_synthetic'));
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
  await pool.query(`INSERT INTO github_social_connections(user_id,community_id,github_user_id,github_login,encrypted_tokens) SELECT $1,$2,github_user_id,github_login,encrypted_tokens FROM github_social_connections WHERE user_id=$3`,[other.user_id,other.community_id,actor.user_id]);
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
