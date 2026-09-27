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
  const fetcher:typeof fetch=async()=>{calls++;return Response.json([
    {number:7,title:'我的定位提示',body:issuePageMarker('positioning'),state:'open',created_at:'2026-09-25T10:00:00Z',user:{login:'ted'},labels:[]},
    {number:8,title:'定位 PR',body:issuePageMarker('positioning'),state:'open',created_at:'2026-09-25T11:00:00Z',user:{login:'contributor'},labels:[],pull_request:{}},
    {number:9,title:'已結束提案',body:issuePageMarker('positioning'),state:'closed',created_at:'2026-09-25T12:00:00Z',user:{login:'ted'},labels:[]},
  ])};
  const reader=new PageGitHubReader(fetcher,()=>clock);
  const page=await reader.read('positioning');
  assert.deepEqual(page.items.map(item=>item.number),[7]);
  assert.equal(page.items[0].url,'https://github.com/FreeTWAI-AI/freedom-platform/issues/7');
  assert.deepEqual((await reader.read()).items.map(item=>item.kind),['issue','pr','issue']);
  assert.equal(calls,1);
  clock=90001;await reader.read();assert.equal(calls,2);
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
  ]))};
  const reader=new PageGitHubEventReader(fetcher,()=>clock);
  assert.deepEqual((await reader.read()).items.map(item=>item.kind),['issue_opened','pr_opened','pr_approved','design_claimed']);
  assert.equal((await reader.read()).items[3].actor,'member');assert.equal(calls,1);
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
