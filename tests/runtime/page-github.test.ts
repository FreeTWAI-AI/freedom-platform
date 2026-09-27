import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PageGitHubReader,issuePageMarker,pageIdsForIssue} from '../../modules/development/page-github.js';

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
