import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PageGitHubReader,PageGitHubEventReader,DESIGN_CLAIM_MARKER,issuePageMarker,pageIdsForIssue} from '../../modules/development/page-github.js';

test('page markers and GitHub labels resolve only known pages',()=>{
  assert.equal(issuePageMarker('home'),'<!-- freedom-page:home -->');
  assert.deepEqual(pageIdsForIssue('<!-- freedom-page:home -->', ['page:guilds','page:unknown']),['guilds','home']);
  assert.deepEqual(pageIdsForIssue('<!-- freedom-page:unknown -->',[]),[]);
  assert.throws(()=>issuePageMarker('unknown'));
});

test('recent GitHub issues and PRs are verified, cached and separated by page',async()=>{
  let calls=0,clock=0;
  const fetcher:typeof fetch=async url=>{calls++;if(String(url).includes('labels='))return Response.json([{number:2,title:'舊定位提案',body:null,state:'open',created_at:'2025-09-25T10:00:00Z',user:{login:'older'},labels:[{name:'page:positioning'}]}]);return Response.json([
    {number:7,title:'我的定位提示',body:issuePageMarker('positioning'),state:'open',created_at:'2026-09-25T10:00:00Z',user:{login:'ted'},labels:[]},
    {number:8,title:'定位 PR',body:issuePageMarker('positioning'),state:'open',created_at:'2026-09-25T11:00:00Z',user:{login:'contributor'},labels:[],pull_request:{}},
    {number:9,title:'已結束提案',body:issuePageMarker('positioning'),state:'closed',created_at:'2026-09-25T12:00:00Z',user:{login:'ted'},labels:[]},
  ])};
  const reader=new PageGitHubReader(fetcher,()=>clock);
  const page=await reader.read('positioning');
  assert.deepEqual(page.items.map(item=>item.number),[7,2]);
  assert.equal(page.items[0].url,'https://github.com/FreeTWAI-AI/freedom-platform/issues/7');
  assert.deepEqual((await reader.read()).items.map(item=>item.kind),['issue','pr','issue']);
  assert.equal(calls,2);
  clock=90001;await reader.read('positioning');assert.equal(calls,4);
});

test('GitHub fetch is invoked without a reader receiver for Workers',async()=>{
  const fetcher:typeof fetch=function(this:void){assert.equal(this,undefined);return Promise.resolve(Response.json([]))};
  assert.deepEqual((await new PageGitHubReader(fetcher).read('home')).items,[]);
});

test('world announcements use only verified GitHub actions and never a page open',async()=>{
  let calls=0,clock=0;
  const subject=(kind:'issues'|'pull',number:number)=>({number,title:`Task ${number}`,html_url:`https://github.com/FreeTWAI-AI/freedom-platform/${kind}/${number}`});
  const event=(id:string,type:string,payload:unknown)=>({id,type,actor:{login:'member'},created_at:'2026-09-27T12:00:00Z',payload});
  const fetcher:typeof fetch=function(this:void,url){assert.equal(this,undefined);assert.match(String(url),/\/events\?per_page=100$/);calls++;return Promise.resolve(Response.json([
    event('1','IssuesEvent',{action:'opened',issue:subject('issues',1)}),
    event('2','PullRequestEvent',{action:'opened',pull_request:subject('pull',2)}),
    event('3','PullRequestReviewEvent',{action:'created',pull_request:subject('pull',2),review:{state:'approved',html_url:'https://github.com/FreeTWAI-AI/freedom-platform/pull/2#pullrequestreview-3'}}),
    event('4','IssueCommentEvent',{action:'created',issue:subject('issues',1),comment:{body:`我願意接手設計\n${DESIGN_CLAIM_MARKER}`,html_url:'https://github.com/FreeTWAI-AI/freedom-platform/issues/1#issuecomment-4'}}),
    event('5','IssueCommentEvent',{action:'created',issue:subject('issues',1),comment:{body:'只是看看',html_url:'https://github.com/FreeTWAI-AI/freedom-platform/issues/1#issuecomment-5'}}),
    event('6','IssueCommentEvent',{action:'created',issue:{...subject('issues',1),pull_request:{}},comment:{body:DESIGN_CLAIM_MARKER,html_url:'https://github.com/FreeTWAI-AI/freedom-platform/issues/1#issuecomment-6'}}),
    event('7','PullRequestReviewEvent',{action:'dismissed',pull_request:subject('pull',2),review:{state:'approved',html_url:'https://github.com/FreeTWAI-AI/freedom-platform/pull/2#pullrequestreview-7'}}),
    event('8','PageOpenedEvent',{}),
    event('9','PullRequestEvent',{action:'opened',number:9,pull_request:{number:9,url:'https://api.github.com/repos/FreeTWAI-AI/freedom-platform/pulls/9'}}),
    event('10','PullRequestReviewEvent',{action:'created',pull_request:{number:9,url:'https://api.github.com/repos/FreeTWAI-AI/freedom-platform/pulls/9'},review:{state:'approved',html_url:'https://github.com/FreeTWAI-AI/freedom-platform/pull/9#pullrequestreview-10'}}),
    event('11','PullRequestEvent',{action:'opened',pull_request:{number:10,url:'https://api.github.com/repos/other/repo/pulls/10'}}),
  ]))};
  const reader=new PageGitHubEventReader(fetcher,()=>clock);
  assert.deepEqual((await reader.read()).items.map(item=>item.kind),['issue_opened','pr_opened','pr_approved','design_claimed','pr_opened','pr_approved']);
  assert.equal((await reader.read()).items[3].actor,'member');assert.equal(calls,1);
  assert.equal((await reader.read()).items[4].title,'PR #9');
  clock=90001;await reader.read();assert.equal(calls,2);
});

test('public GitHub reads retry anonymously when a configured read token is rejected',async()=>{
  const authorizations:(string|null)[]=[];
  const fetcher:typeof fetch=async(_url,init)=>{
    const authorization=new Headers(init?.headers).get('Authorization');authorizations.push(authorization);
    return authorization?Response.json({message:'Bad credentials'},{status:401}):Response.json([]);
  };
  assert.deepEqual((await new PageGitHubReader(fetcher,undefined,()=> 'stale-token').read()).items,[]);
  assert.deepEqual((await new PageGitHubEventReader(fetcher,undefined,()=> 'stale-token').read()).items,[]);
  assert.deepEqual(authorizations,['Bearer stale-token',null,'Bearer stale-token',null]);
});

test('a partial GitHub response keeps available page issues visible',async()=>{
  const fetcher:typeof fetch=async url=>String(url).includes('labels=')?Response.json({message:'Unavailable'},{status:503}):Response.json([{number:3,title:'首頁提案',body:issuePageMarker('home'),state:'open',created_at:'2026-09-25T10:00:00Z',user:{login:'ted'},labels:[]}]);
  const result=await new PageGitHubReader(fetcher).read('home');
  assert.deepEqual(result.items.map(item=>item.number),[3]);assert.equal(result.partial,true);
});

test('GitHub rate limits leave the issue composer available without claiming an empty list',async()=>{
  let clock=0,calls=0;
  const reader=new PageGitHubReader(async()=>{calls++;return Response.json({message:'rate limited'},{status:403,headers:{'x-ratelimit-remaining':'0'}})},()=>clock);
  const first=await reader.read('home');
  assert.deepEqual(first.items,[]);assert.equal(first.partial,true);assert.equal(first.stale,true);
  assert.equal((await reader.read('home')).partial,true);assert.equal(calls,2,'reuse the short lived fallback');
  clock=4000;assert.equal((await reader.read('home',true)).partial,true);assert.equal(calls,4,'explicit refresh still retries');
});

test('explicit page refresh finds a newly opened Issue despite a recent cache',async()=>{
  let clock=0,number=14;
  const fetcher:typeof fetch=async url=>Response.json(String(url).includes('labels=')?[{number,title:`Issue ${number}`,body:issuePageMarker('home'),state:'open',created_at:'2026-09-27T08:13:16Z',user:{login:'ted'},labels:[{name:'page:home'}]}]:[]);
  const reader=new PageGitHubReader(fetcher,()=>clock);
  assert.deepEqual((await reader.read('home')).items.map(item=>item.number),[14]);
  clock=4000;number=15;
  assert.deepEqual((await reader.read('home',true)).items.map(item=>item.number),[15]);
});

test('closed issues, merged and unmerged pull requests, and releases become distinct announcements',async()=>{
  const subject=(kind:'issues'|'pull',number:number,extra:Record<string,unknown>={})=>({number,title:`Task ${number}`,html_url:`https://github.com/FreeTWAI-AI/freedom-platform/${kind}/${number}`,...extra});
  const event=(id:string,type:string,payload:unknown)=>({id,type,actor:{login:'member'},created_at:'2026-09-27T12:00:00Z',payload});
  const fetcher:typeof fetch=async()=>Response.json([
    event('c1','IssuesEvent',{action:'closed',issue:subject('issues',4)}),
    event('c2','IssuesEvent',{action:'closed',issue:{...subject('issues',5),pull_request:{}}}),
    event('c3','IssuesEvent',{action:'reopened',issue:subject('issues',4)}),
    event('c4','PullRequestEvent',{action:'closed',pull_request:subject('pull',6,{merged:true})}),
    event('c5','PullRequestEvent',{action:'closed',pull_request:subject('pull',7,{merged:false})}),
    event('c6','PullRequestEvent',{action:'reopened',pull_request:subject('pull',7)}),
    event('c7','ReleaseEvent',{action:'published',release:{tag_name:'v1.2.0',name:'九月更新',html_url:'https://github.com/FreeTWAI-AI/freedom-platform/releases/tag/v1.2.0'}}),
    event('c8','ReleaseEvent',{action:'published',release:{tag_name:'v9',name:'別的倉庫',html_url:'https://github.com/other/repo/releases/tag/v9'}}),
  ]);
  const items=(await new PageGitHubEventReader(fetcher).read()).items;
  assert.deepEqual(items.map(item=>item.kind),['issue_closed','pr_merged','pr_closed','release_published']);
  assert.equal(items[3].number,null);assert.equal(items[3].title,'九月更新');
  assert.equal(items[3].url,'https://github.com/FreeTWAI-AI/freedom-platform/releases/tag/v1.2.0');
});

test('optional GitHub event feed backs off during provider outages',async()=>{
  let clock=0,calls=0;
  const reader=new PageGitHubEventReader(async()=>{calls++;return Response.json({message:'unavailable'},{status:503})},()=>clock);
  const first=await reader.read();assert.deepEqual(first.items,[]);assert.equal(first.stale,true);assert.equal(calls,1);
  clock=120000;assert.equal((await reader.read()).stale,true);assert.equal(calls,1);
  clock=301000;assert.equal((await reader.read()).stale,true);assert.equal(calls,2);
});
