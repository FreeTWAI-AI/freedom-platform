import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {transformSync} from 'esbuild';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {PublishedSkillLinks,skillPublicationPath,projectSkillBookPath,projectSkillDraft,type ProjectSkillBook} from '../../apps/portal-web/src/modules/SkillPublication.js';
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


test('publication actions expose the acknowledged public destination and shelf only after publication', () => {
  const path='/development/submissions/10000000-0000-4000-8000-000000000001';
  for(const status of ['awaiting_upload','ready_for_review','revoked']) {
    const submission={status,public_path:path};
    assert.equal(skillPublicationPath(submission),null);
    assert.equal(renderToStaticMarkup(createElement(PublishedSkillLinks,{submission})), '');
  }
  const submission={status:'published',public_path:path};
  const rendered=renderToStaticMarkup(createElement(PublishedSkillLinks,{submission}));
  assert.equal(skillPublicationPath(submission),path);
  assert.match(rendered,new RegExp(`href="${path}"`));
  assert.match(rendered,/href="\/#skills"/);
  assert.match(rendered,/target="_blank" rel="noopener noreferrer"/);
});

test('publication links never use remote, malformed or draft destinations', () => {
  for(const path of [null,'//example.test/a','https://example.test/a','javascript:alert(1)','/development/submissions/not-an-id','/api/v1/me/skill-submissions/10000000-0000-4000-8000-000000000001','/development/submissions/10000000-0000-4000-8000-000000000001?grant=private']) {
    const submission={status:'published',public_path:path};
    assert.equal(skillPublicationPath(submission),null);
    const rendered=renderToStaticMarkup(createElement(PublishedSkillLinks,{submission}));
    assert.equal((rendered.match(/<a /g)??[]).length,1);
    assert.match(rendered,/href="\/#skills"/);
  }
});


test('project destinations prefer static catalog links, expose published books and preserve owner-only Agent drafts', () => {
  const id='10000000-0000-4000-8000-000000000001';
  const book:ProjectSkillBook={status:'published',submission_id:id,public_path:`/development/submissions/${id}`,catalog_book:null,can_edit:false};
  assert.equal(projectSkillBookPath(book),book.public_path);
  assert.equal(projectSkillDraft(book,true),null);
  const catalog={book_id:'example-skill',title:'技能',public_path:'/development/skills/example-skill'};
  assert.equal(projectSkillBookPath({...book,catalog_book:catalog}),catalog.public_path);
  assert.equal(projectSkillBookPath({...book,public_path:null,catalog_book:{...catalog,public_path:'//example.test'}}),null);
  for(const status of ['ready_for_review','awaiting_upload'] as const) {
    const draft={...book,status};
    assert.equal(projectSkillBookPath(draft),null);
    assert.equal(projectSkillDraft(draft,false),null);
    // Agent drafts are not manually editable, but their owner can continue them.
    assert.deepEqual(projectSkillDraft(draft,true),{submissionId:id,mode:status==='ready_for_review'?'preview':'complete'});
  }
  assert.equal(projectSkillDraft(null,true),null);
});

// Execute the component's actual command closure; do not mirror its branching.
function projectBridge(harness:Record<string,unknown>):()=>Promise<void> {
  const source=transformSync(readFileSync(new URL('../../apps/portal-web/src/modules/OpenSourcePanels.tsx',import.meta.url),'utf8'),{loader:'tsx',target:'es2023',format:'esm'}).code;
  const start=/^( *)async function makeSkill\(/m.exec(source);assert.ok(start);
  const tail=source.slice(start.index),end=new RegExp(`^${start[1]}}`,'m').exec(tail);assert.ok(end);
  return runInNewContext(`${tail.slice(0,end.index+end[0].length)};makeSkill`,harness);
}

test('project bridge sends only project CAS and opens the acknowledged original draft without publishing',async()=>{
  for(const [status,mode] of [['ready_for_review','preview'],['awaiting_upload','complete']]) {
    const calls:unknown[][]=[],opened:unknown[][]=[];let refreshed=0;
    const bridge=projectBridge({project:{project_id:'project-original',aggregate_version:7},mutate:async(...args:unknown[])=>{calls.push(args);return {submission:{submission_id:'draft-original',status},created:false};},onOpenSkill:(...args:unknown[])=>opened.push(args),setNotice:()=>assert.fail('draft treated as published'),reload:async()=>{refreshed++;}});
    await bridge();
    assert.deepEqual(JSON.parse(JSON.stringify(calls)),[['/opensource/projects/project-original/skill-submission',{},7]]);
    assert.deepEqual(opened,[['draft-original',mode]]);assert.equal(refreshed,1);
  }
});

test('project bridge failures keep the card; acknowledged public or static books refresh without opening a draft',async()=>{
  for(const result of [undefined,{submission:{submission_id:'public',status:'published'},created:false},{submission:null,created:false,catalog_book:{book_id:'static'}}]) {
    let refreshed=0,notices=0;
    await projectBridge({project:{project_id:'p',aggregate_version:8},mutate:async()=>result,onOpenSkill:()=>assert.fail('unexpected private draft'),setNotice:()=>{notices++;},reload:async()=>{refreshed++;}})();
    assert.equal(refreshed,result?1:0);assert.equal(notices,result?1:0);
  }
});
