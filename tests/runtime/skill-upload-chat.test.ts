import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chatSkillInstruction, parseChatSkillJson, repositoryKey } from '../../apps/portal-web/src/modules/skill-upload-chat.js';

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

test('a registration seed is copied after the source line and omitted when absent', () => {
  const url = 'https://github.com/Example/Skill-Demo';
  const plain = chatSkillInstruction(url);
  assert.equal(chatSkillInstruction(url, null), plain);
  assert.equal(chatSkillInstruction(`${url}/`), plain);
  assert.doesNotMatch(plain, /我已在自由工坊登錄/);
  const seed = { title: '示範 "技能"', description: '一行', use_notes: '步驟', relationship: 'curator', demo_url: null };
  const seeded = chatSkillInstruction(url, seed);
  const marker = '用繁體中文';
  const block = [
    '我已在自由工坊登錄這件作品，下列欄位請照抄；只有和 repo 內容不符時才修正：',
    `title：${JSON.stringify(seed.title)}`,
    `description：${JSON.stringify(seed.description)}`,
    `use_notes：${JSON.stringify(seed.use_notes)}`,
    `relationship：${JSON.stringify(seed.relationship)}`,
    `demo_url：null`,
    '',
  ].join('\n');
  assert.equal(seeded, `${plain.slice(0, plain.indexOf(marker))}${block}${plain.slice(plain.indexOf(marker))}`);
  assert.equal(repositoryKey('https://github.com/Example/Skill-Demo.git'), 'example/skill-demo');
  assert.equal(repositoryKey('https://gitlab.com/Example/Skill-Demo'), null);
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
