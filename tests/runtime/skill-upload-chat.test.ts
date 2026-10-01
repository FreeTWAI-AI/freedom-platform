import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chatSkillInstruction, parseChatSkillJson } from '../../apps/portal-web/src/modules/skill-upload-chat.js';

test('chat instructions name the repository and contain no grant or upload URL', () => {
  const text = chatSkillInstruction('https://github.com/Example/Skill-Demo/');
  assert.match(text, /https:\/\/github.com\/Example\/Skill-Demo/);
  assert.match(text, /README/);
  assert.match(text, /SKILL\.md/);
  assert.match(text, /只回覆一個 JSON/);
  assert.match(text, /curator/);
  assert.match(text, /100/);
  assert.doesNotMatch(text, /fpg_|fpk_|agent-api|Bearer /);
  const empty = chatSkillInstruction('  ');
  assert.match(empty, /README/);
  assert.doesNotMatch(empty, /fpg_|agent-api/);
});

test('a single surrounding json fence is stripped and other text is rejected', () => {
  const parsed = parseChatSkillJson('```json\n{"title":"筆記"}\n```');
  assert.equal(parsed.ok, true);
  if (parsed.ok) assert.deepEqual(parsed.value, { title: '筆記' });
  const plain = parseChatSkillJson('  {"title":"筆記"}  ');
  assert.equal(plain.ok, true);
  const wrapped = parseChatSkillJson('這是 JSON：\n```json\n{"title":"筆記"}\n```');
  assert.equal(wrapped.ok, false);
  if (!wrapped.ok) assert.match(wrapped.message, /不是 JSON/);
  const array = parseChatSkillJson('[1,2]');
  assert.equal(array.ok, false);
  if (!array.ok) assert.match(array.message, /JSON 物件/);
});
