import {test} from 'node:test';
import assert from 'node:assert/strict';
import {communityCatalog} from '../../modules/community/catalog.js';
import {checkSkillBookUpstreams,formatSkillBookUpstreamReport,validateSkillBookPin} from '../../scripts/check-skill-book-upstreams.js';

test('all official books have internally consistent commit-pinned reading and evidence links',()=>{
  assert.equal(communityCatalog.skill_books.length,41);
  for(const book of communityCatalog.skill_books)validateSkillBookPin(book);
});

test('drift check follows original upstream rather than a newer FreeTWAI-AI fork',async()=>{
  const book=communityCatalog.skill_books.find(book=>book.id==='social-post')!;
  const latest='a'.repeat(40);
  const requested:string[]=[];
  const checks=await checkSkillBookUpstreams([book],async input=>{
    requested.push(String(input));
    return Response.json([{sha:latest}]);
  });
  assert.deepEqual(requested,['https://api.github.com/repos/Hao0321/claude-skill-social-post/commits?per_page=1']);
  assert.equal(checks[0].latest,latest);
  const report=formatSkillBookUpstreamReport(checks);
  assert.match(report,/1 checked; 1 changed; 0 errors/);
  assert.match(report,new RegExp(`/compare/${book.source_commit}\\.\\.\\.${latest}`));
});

test('an unchanged pin is reported as in sync and does not list a compare link',async()=>{
  const book=communityCatalog.skill_books.find(book=>book.id==='career-guide')!;
  const checks=await checkSkillBookUpstreams([book],async()=>Response.json([{sha:book.source_commit}]));
  assert.equal(checks[0].latest,book.source_commit);
  assert.equal(checks[0].error,undefined);
  const report=formatSkillBookUpstreamReport(checks);
  assert.match(report,/1 checked; 0 changed; 0 errors/);
  assert.match(report,/All catalog pins match their upstream default branches/);
  assert.doesNotMatch(report,/review diff/);
});

test('upstream http failures and rate limits stay in the error section',async()=>{
  const book=communityCatalog.skill_books.find(book=>book.id==='career-guide')!;
  for(const status of [500,403,429]){
    const checks=await checkSkillBookUpstreams([book],async()=>new Response('limited',{status}));
    assert.equal(checks[0].latest,undefined);
    assert.match(checks[0].error??'',new RegExp(`HTTP ${status}`));
    assert.match(formatSkillBookUpstreamReport(checks),new RegExp(`1 checked; 0 changed; 1 errors[\\s\\S]*HTTP ${status}`));
  }
});

test('a mismatched guide pin is reported before any upstream request',async()=>{
  const book=communityCatalog.skill_books.find(book=>book.id==='career-guide')!;
  const invalid={...book,guide:{...book.guide!,source_commit:'b'.repeat(40)}};
  let called=false;
  const checks=await checkSkillBookUpstreams([invalid],async()=>{called=true;return Response.json([]);});
  assert.equal(called,false);
  assert.match(checks[0].error??'',/guide source commit differs/);
  assert.match(formatSkillBookUpstreamReport(checks),/1 errors/);
});
