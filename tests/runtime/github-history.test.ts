import test from 'node:test';
import assert from 'node:assert/strict';
import type {Pool} from 'pg';
import {GitHubHistory,historyRepositories} from '../../modules/community/github-history.js';
import type {Actor} from '../../modules/identity-membership/service.js';

const when='2026-09-28T12:00:00Z';
const issue=(number:number,extra:Record<string,unknown>={})=>({number,title:`想法 ${number}`,state:'open',state_reason:null,user:{login:'maker'},created_at:when,updated_at:when,...extra});
const pull=(number:number,extra:Record<string,unknown>={})=>({number,title:`更新 ${number}`,state:'closed',user:{login:'editor'},created_at:when,updated_at:when,merged_at:when,...extra});

test('historical GitHub pages keep issue and PR states, ignore PRs in the issue endpoint, and continue past full pages',async()=>{
  const urls:string[]=[];
  const fetcher:typeof fetch=async(input,init)=>{
    const url=String(input);urls.push(url);
    assert.equal(new URL(url).origin,'https://api.github.com');
    assert.equal(init?.redirect,'manual');
    if(url.includes('/issues?'))return Response.json(Array.from({length:99},(_,i)=>issue(i+1)).concat([issue(100,{pull_request:{url:'untrusted'}})]));
    return Response.json([pull(5),pull(6,{merged_at:null})]);
  };
  const reader=new GitHubHistory(fetcher,()=>Date.parse(when));
  const issues=await reader.page('FreeTWAI-AI/freedom-platform','issue',1);
  assert.equal(issues.items.length,99);assert.equal(issues.has_more,true);
  assert.equal(issues.items[0].state,'open');assert.equal(issues.items[0].author,'maker');
  assert.equal(issues.items[0].url,'https://github.com/FreeTWAI-AI/freedom-platform/issues/1');
  const updates=await reader.page('FreeTWAI-AI/freedom-platform','pr',1);
  assert.equal(updates.items.length,2);assert.equal(updates.has_more,false);
  assert.equal(updates.items[0].merged_at,when);assert.equal(updates.items[1].merged_at,null);
  await reader.page('FreeTWAI-AI/freedom-platform','issue',1);
  assert.equal(urls.length,2,'cached history avoids another GitHub request');
  await assert.rejects(reader.page('https://example.com/secret','issue',1),{code:'invalid_repository'});
});

test('repository categories prioritize platform architecture and guild assigned skill books',async()=>{
  const pool={query:async(sql:string)=>({rows:sql.includes('guild_skill_book_bindings')?[{book_id:'video-autopilot'}]:[
    {repository_full_name:'FreeTWAI-AI/freedom-platform',title:'重複平台'},
    {repository_full_name:'example/personal-tool',title:'個人工具'},
  ]})} as unknown as Pool;
  const actor={community_id:'test-community'} as Actor;
  const repos=await historyRepositories(pool,actor);
  assert.equal(repos.find(repo=>repo.name==='FreeTWAI-AI/freedom-platform')?.category,'platform');
  assert.equal(repos.find(repo=>repo.name==='example/personal-tool')?.category,'personal');
  assert.ok(repos.some(repo=>repo.category==='official'));
  assert.equal(new Set(repos.map(repo=>repo.name.toLowerCase())).size,repos.length);
});
