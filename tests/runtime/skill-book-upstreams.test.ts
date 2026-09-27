import {test} from 'node:test';
import assert from 'node:assert/strict';
import {communityCatalog} from '../../modules/community/catalog.js';
import {checkSkillBookUpstreams,formatSkillBookUpstreamReport,validateSkillBookPin} from '../../scripts/check-skill-book-upstreams.js';

test('all official books have internally consistent commit-pinned reading and evidence links',()=>{
  assert.equal(communityCatalog.skill_books.length,37);
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
  assert.match(formatSkillBookUpstreamReport(checks),new RegExp(`/compare/${book.source_commit}\\.\\.\\.${latest}`));
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
