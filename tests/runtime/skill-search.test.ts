import {test} from 'node:test';
import assert from 'node:assert/strict';
import {matchesSkillSearch} from '../../apps/portal-web/src/modules/skill-search.js';

const book=['社群貼文助手','幫你寫 Facebook 與 Threads 貼文','Hao0321','https://github.com/example/post-helper'];

test('an empty or blank search keeps every skill book',()=>{
  assert.equal(matchesSkillSearch('',book),true);
  assert.equal(matchesSkillSearch('   ',book),true);
});

test('a single phrase still matches case-insensitively across fields',()=>{
  assert.equal(matchesSkillSearch('facebook',book),true);
  assert.equal(matchesSkillSearch('HAO0321',book),true);
  assert.equal(matchesSkillSearch('Facebook 與 Threads',book),true);
});

test('space-separated words must all appear, in any order or field',()=>{
  assert.equal(matchesSkillSearch('threads 社群',book),true);
  assert.equal(matchesSkillSearch('  hao0321   貼文  ',book),true);
  assert.equal(matchesSkillSearch('threads 剪輯',book),false);
});

test('missing values and unmatched terms do not match',()=>{
  assert.equal(matchesSkillSearch('商店',[null,undefined,'貼文']),false);
  assert.equal(matchesSkillSearch('貼文',[null,undefined]),false);
});
