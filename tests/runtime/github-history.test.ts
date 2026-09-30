import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {Pool} from 'pg';
import {createPool,LOCAL_DATABASE_URL} from '../../packages/db/index.js';
import {migrate} from '../../scripts/database.js';
import {GitHubHistory,historyRepositories} from '../../modules/community/github-history.js';
import type {Actor} from '../../modules/identity-membership/service.js';
import {contributionPoints,isGitHubBot,issueResolved,pullClosedUnmerged,pullUpdated} from '../../packages/shared/github-leaderboard.js';

const when='2026-09-28T12:00:00Z';
const databaseUrl=process.env.TEST_DATABASE_URL??LOCAL_DATABASE_URL;
const schema=`fp_github_history_${process.pid}_${Date.now()}`;
const admin=createPool(databaseUrl);
const pool=new Pool({connectionString:databaseUrl,options:`-c search_path=${schema}`,max:4});
const originalFetch=globalThis.fetch;
const issue=(number:number,extra:Record<string,unknown>={})=>({number,title:`想法 ${number}`,state:'open',state_reason:null,user:{login:'maker'},created_at:when,updated_at:when,...extra});
const pull=(number:number,extra:Record<string,unknown>={})=>({number,title:`更新 ${number}`,state:'closed',user:{login:'editor'},created_at:when,updated_at:when,merged_at:when,...extra});

before(async()=>{
  globalThis.fetch=(()=>{throw new Error('real network');}) as typeof fetch;
  await admin.query(`CREATE SCHEMA ${schema}`);
  await migrate(pool);
});
after(async()=>{
  globalThis.fetch=originalFetch;
  await pool.end();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
});

test('leaderboard scores stay display-only and skip automation accounts',()=>{
  assert.equal(isGitHubBot('dependabot[bot]'),true);
  assert.equal(isGitHubBot('Dependabot'),true);
  assert.equal(isGitHubBot('github-actions'),true);
  assert.equal(isGitHubBot('GitHub-Actions[bot]'),true);
  assert.equal(isGitHubBot('member-demo'),false);
  assert.equal(isGitHubBot(' '),true);
  assert.equal(contributionPoints(2,1),30);
  assert.equal(contributionPoints(0,2),40);
  assert.equal(issueResolved('closed'),true);
  assert.equal(issueResolved('open'),false);
  assert.equal(pullUpdated(when),true);
  assert.equal(pullUpdated(null),false);
  assert.equal(pullClosedUnmerged('closed',null),true);
  assert.equal(pullClosedUnmerged('open',null),false);
  assert.equal(pullClosedUnmerged('closed',when),false);
});

test('historical GitHub pages keep issue and pull states and serve a fresh cache without another request',async()=>{
  const urls:string[]=[];
  const fetcher:typeof fetch=async(input,init)=>{
    const url=String(input);urls.push(url);
    assert.equal(new URL(url).origin,'https://api.github.com');
    assert.equal(init?.redirect,'manual');
    assert.equal(new Headers(init?.headers).get('authorization'),null);
    if(url.includes('/issues?'))return Response.json(Array.from({length:99},(_,i)=>issue(i+1)).concat([issue(100,{pull_request:{url:'untrusted'}})]));
    return Response.json([pull(5),pull(6,{merged_at:null,state:'closed'})]);
  };
  const reader=new GitHubHistory(pool,fetcher);
  const issues=await reader.page('FreeTWAI-AI/freedom-platform','issue',1);
  assert.equal(issues.items.length,99);assert.equal(issues.has_more,true);assert.equal(issues.stale,false);
  assert.equal(issues.items[0].state,'open');assert.equal(issues.items[0].author,'maker');
  assert.equal(issues.items[0].url,'https://github.com/FreeTWAI-AI/freedom-platform/issues/1');
  const updates=await reader.page('FreeTWAI-AI/freedom-platform','pr',1);
  assert.equal(updates.items.length,2);assert.equal(updates.has_more,false);
  assert.equal(updates.items[0].merged_at,when);assert.equal(updates.items[1].merged_at,null);
  await reader.page('FreeTWAI-AI/freedom-platform','issue',1);
  await new GitHubHistory(pool,fetcher).page('FreeTWAI-AI/freedom-platform','issue',1);
  assert.equal(urls.length,2,'a fresh shared cache avoids another GitHub request');
  await assert.rejects(reader.page('https://example.com/secret','issue',1),{code:'invalid_repository'});
  assert.equal(urls.length,2);
});

test('titles and logins are sanitised without failing the page',async()=>{
  const fetcher:typeof fetch=async()=>Response.json([
    issue(3,{title:'想\u0000法  <img>',user:{login:'not a login'}}),
    issue(4,{title:'   ',user:null}),
    issue(5,{title:'機器人',state:'closed',state_reason:'not_planned',user:{login:'dependabot[bot]'}}),
  ]);
  const page=await new GitHubHistory(pool,fetcher).page('owner/sanitize','issue',1);
  assert.equal(page.items[0].title,'想法 <img>');
  assert.equal(page.items[0].author,null);
  assert.equal(page.items[1].title,'Issue #4');
  assert.equal(page.items[2].state,'closed');
  assert.equal(page.items[2].state_reason,'not_planned');
  assert.equal(page.items[2].author,'dependabot[bot]');
  assert.equal(String(JSON.stringify(page)).includes('\u0000'),false);
});

test('stale pages refresh and a failed refresh keeps the previous snapshot',async()=>{
  let now=Date.parse('2026-09-30T00:00:00Z'),fail=false,calls=0,generation=1;
  const fetcher:typeof fetch=async()=>{
    calls++;
    if(fail)return Response.json({message:'synthetic outage'},{status:503});
    return Response.json([issue(generation,{title:'保留下來'})]);
  };
  const reader=new GitHubHistory(pool,fetcher,()=>now);
  const first=await reader.page('owner/stale-history','issue',1);
  assert.equal(first.stale,false);assert.equal(first.items[0].number,1);
  now+=19*60*1000;
  await reader.page('owner/stale-history','issue',1);
  assert.equal(calls,1,'inside the fresh window');
  now+=2*60*1000;generation=2;
  const refreshed=await reader.page('owner/stale-history','issue',1);
  assert.equal(calls,2);assert.equal(refreshed.items[0].number,2);assert.equal(refreshed.stale,false);
  fail=true;now+=21*60*1000;
  const stale=await reader.page('owner/stale-history','issue',1);
  assert.equal(stale.stale,true);assert.equal(stale.unavailable,'github_unavailable');
  assert.equal(stale.items[0].title,'保留下來');assert.equal(stale.items[0].number,2);
  const afterFailure=calls;
  now+=60*1000;
  const held=await reader.page('owner/stale-history','issue',1);
  assert.equal(calls,afterFailure,'retry_after stops a failing refresh from being hammered');
  assert.equal(held.items[0].number,2);
});

test('Retry-After is stored instead of the default failure backoff',async()=>{
  let calls=0;
  const fetcher:typeof fetch=async()=>{calls++;return Response.json({message:'slow down'},{status:429,headers:{'retry-after':'120'}});};
  const before=Date.now();
  const page=await new GitHubHistory(pool,fetcher).page('owner/retry-after','issue',1);
  assert.equal(page.unavailable,'github_rate_limited');assert.deepEqual(page.items,[]);assert.equal(page.stale,true);
  const row=(await pool.query(`SELECT retry_after,last_error FROM github_history_cache WHERE cache_key=$1`,['owner/retry-after/issue/1'])).rows[0];
  const delta=row.retry_after.getTime()-before;
  assert.equal(row.last_error,'github_rate_limited');
  assert.ok(delta>100000&&delta<130000,`expected about 120s, got ${delta}`);
  await new GitHubHistory(pool,fetcher).page('owner/retry-after','issue',1);
  assert.equal(calls,1);
});

test('an HTTP-date Retry-After is honoured',async()=>{
  const future=new Date(Date.now()+90_000).toUTCString();
  const fetcher:typeof fetch=async()=>Response.json({message:'slow down'},{status:429,headers:{'retry-after':future}});
  const before=Date.now();
  await new GitHubHistory(pool,fetcher).page('owner/retry-date','issue',1);
  const row=(await pool.query(`SELECT retry_after FROM github_history_cache WHERE cache_key=$1`,['owner/retry-date/issue/1'])).rows[0];
  const delta=row.retry_after.getTime()-before;
  assert.ok(delta>60_000&&delta<120_000,`expected about 90s, got ${delta}`);
});

test('a rejected metrics token is retried once anonymously for 403 and 429',async()=>{
  const secret='synthetic-metrics-token';
  for(const [status,repo] of [[403,'owner/token-403'],[429,'owner/token-429']] as const){
    const authorizations:(string|null)[]=[];
    const fetcher:typeof fetch=async(input,init)=>{
      const authorization=new Headers(init?.headers).get('authorization');
      authorizations.push(authorization);
      assert.equal(new URL(String(input)).origin,'https://api.github.com');
      assert.equal(init?.redirect,'manual');
      if(authorization)return Response.json({message:'rejected'},{status,headers:{'retry-after':'30'}});
      return Response.json([issue(4,{title:'匿名讀到'})]);
    };
    const page=await new GitHubHistory(pool,fetcher).page(repo,'issue',1,secret);
    assert.equal(page.stale,false);assert.equal(page.unavailable,undefined);assert.equal(page.items[0].title,'匿名讀到');
    assert.deepEqual(authorizations,[`Bearer ${secret}`,null]);
    const stored=(await pool.query(`SELECT snapshot::text AS snapshot,last_error FROM github_history_cache WHERE cache_key=$1`,[`${repo}/issue/1`])).rows[0];
    assert.equal(stored.last_error,null);
    assert.equal(String(stored.snapshot).includes(secret),false);
  }
});

test('when both token and anonymous reads fail, the first Retry-After is kept',async()=>{
  let calls=0;
  const secret='synthetic-metrics-token';
  const fetcher:typeof fetch=async(_input,init)=>{
    calls++;
    const authorization=new Headers(init?.headers).get('authorization');
    if(authorization)return Response.json({message:'rejected'},{status:403,headers:{'retry-after':'120'}});
    return Response.json({message:'also limited'},{status:429});
  };
  const before=Date.now();
  const page=await new GitHubHistory(pool,fetcher).page('owner/token-both','issue',1,secret);
  assert.equal(calls,2);assert.equal(page.unavailable,'github_rate_limited');assert.deepEqual(page.items,[]);
  const row=(await pool.query(`SELECT retry_after,last_error,snapshot::text AS snapshot FROM github_history_cache WHERE cache_key=$1`,['owner/token-both/issue/1'])).rows[0];
  const delta=row.retry_after.getTime()-before;
  assert.ok(delta>100000&&delta<130000,`expected the 120s header, got ${delta}`);
  assert.equal(row.last_error,'github_rate_limited');
  assert.equal(String(row.snapshot).includes(secret),false);
  await new GitHubHistory(pool,fetcher).page('owner/token-both','issue',1,secret);
  assert.equal(calls,2);
});

test('an invalid GitHub payload is not cached as an empty ranking',async()=>{
  let calls=0;
  const fetcher:typeof fetch=async()=>{calls++;return Response.json({not:'a list'});};
  const reader=new GitHubHistory(pool,fetcher);
  const page=await reader.page('owner/invalid-payload','issue',1);
  assert.equal(page.unavailable,'github_invalid_response');assert.deepEqual(page.items,[]);assert.equal(page.stale,true);
  await reader.page('owner/invalid-payload','issue',1);
  assert.equal(calls,1);
});

test('one isolate coalesces the same page and a second instance does not poison an in-flight refresh',async()=>{
  let calls=0;
  let release=()=>{};
  const gate=new Promise<void>(resolve=>{release=resolve;});
  let started=()=>{};
  const startedGate=new Promise<void>(resolve=>{started=resolve;});
  const fetcher:typeof fetch=async(input,init)=>{
    calls++;
    assert.equal(init?.redirect,'manual');
    assert.equal(new URL(String(input)).origin,'https://api.github.com');
    started();
    await gate;
    return Response.json([issue(1)]);
  };
  const first=new GitHubHistory(pool,fetcher);
  const pending=Promise.all([first.page('owner/parallel-lock','issue',1),first.page('owner/parallel-lock','issue',1)]);
  try{
    await Promise.race([startedGate,new Promise((_,reject)=>setTimeout(()=>reject(new Error('fetch did not start')),5000))]);
    const lost=await new GitHubHistory(pool,fetcher).page('owner/parallel-lock','issue',1);
    assert.equal(lost.unavailable,'github_refresh_in_progress');
    assert.equal(lost.items.length,0);
    assert.equal(calls,1);
  }finally{release();}
  const [won,same]=await pending;
  assert.equal(won.items.length,1);assert.equal(same.items[0].number,1);assert.equal(won.stale,false);
  const cached=await new GitHubHistory(pool,fetcher).page('owner/parallel-lock','issue',1);
  assert.equal(cached.items.length,1);assert.equal(cached.stale,false);assert.equal(calls,1);
  const row=(await pool.query(`SELECT last_error FROM github_history_cache WHERE cache_key=$1`,['owner/parallel-lock/issue/1'])).rows[0];
  assert.equal(row.last_error,null);
});

test('repository categories prioritize platform architecture and guild assigned skill books',async()=>{
  const fake={query:async(sql:string)=>({rows:sql.includes('guild_skill_book_bindings')?[{book_id:'video-autopilot'}]:[
    {repository_full_name:'FreeTWAI-AI/freedom-platform',title:'重複平台'},
    {repository_full_name:'example/personal-tool',title:'個人工具'},
  ]})} as unknown as Pool;
  const actor={community_id:'test-community'} as Actor;
  const repos=await historyRepositories(fake,actor);
  assert.equal(repos.find(repo=>repo.name==='FreeTWAI-AI/freedom-platform')?.category,'platform');
  assert.equal(repos.find(repo=>repo.name==='example/personal-tool')?.category,'personal');
  assert.ok(repos.some(repo=>repo.category==='official'));
  assert.equal(new Set(repos.map(repo=>repo.name.toLowerCase())).size,repos.length);
});
