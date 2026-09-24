import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readdirSync} from 'node:fs';
import {communityCatalog} from '../../modules/community/catalog.js';
import {getSkillShareContent,skillShareContentBookIds,skillShareContentVersion} from '../../modules/community/skill-share-content.js';

const catalogIds=communityCatalog.skill_books.map(book=>book.id).sort();
const length=(text:string)=>[...text].length;

test('every catalog skill book has exactly 100 distinct, bounded share introductions',()=>{
  assert.equal(catalogIds.length,37);
  assert.match(skillShareContentVersion,/^\d{4}-\d{2}-\d{2}\.\d+$/);
  const everyLine=new Set<string>();
  for(const id of catalogIds){
    const content=getSkillShareContent(id);assert.ok(content,id);
    assert.equal(content.introductions.length,100,id);
    assert.equal(new Set(content.introductions).size,100,id);
    for(const line of content.introductions){
      assert.equal(typeof line,'string',id);
      assert.equal(line,line.trim(),`${id}: ${line}`);
      assert.ok(length(line)>=8&&length(line)<=200,`${id}: ${line}`);
      assert.match(line,/[一-鿿]/,`${id}: ${line}`);
      assert.doesNotMatch(line,/^\s*(?:[(（]?(?:[0-9０-９]+|[一二三四五六七八九十]+)\s*[.、．)）:：]|[#＃][0-9０-９]+|第\s*[0-9０-９一二三四五六七八九十]+\s*[則條句]|No\.\s*\d)/i,`${id}: ${line}`);
      assert.doesNotMatch(line,/TODO|TBD|placeholder|\{\{|\$\{|<[a-z]/i,`${id}: ${line}`);
      assert.ok(!everyLine.has(line),`duplicated across books: ${line}`);everyLine.add(line);
    }
  }
  assert.equal(everyLine.size,3700);
});

test('share content maps exactly the catalog ids and no unknown or extra ids',()=>{
  assert.deepEqual([...skillShareContentBookIds].sort(),catalogIds);
  const files=readdirSync(new URL('../../modules/community/share-introductions/',import.meta.url)).filter(name=>name.endsWith('.json')).map(name=>name.slice(0,-5)).sort();
  assert.deepEqual(files,catalogIds);
  for(const unknown of ['','unknown-book','__proto__','constructor','toString','Career-Guide'])assert.equal(getSkillShareContent(unknown),null,unknown);
});

test('share illustrations use a per-book path and a distinct workflow description',()=>{
  const alts=new Set<string>();
  for(const id of catalogIds){
    const content=getSkillShareContent(id)!;
    assert.equal(content.illustration_url,`/brand/skill-illustrations/${id}.webp`);
    assert.match(content.illustration_url,/^\/brand\/skill-illustrations\/[a-z0-9]+(?:-[a-z0-9]+)*\.webp$/);
    assert.ok(length(content.illustration_alt)>=15&&length(content.illustration_alt)<=120,id);
    assert.doesNotMatch(content.illustration_alt,/封面|書封|cover/i,id);
    assert.ok(!alts.has(content.illustration_alt),id);alts.add(content.illustration_alt);
  }
});

test('returned introductions are a copy so callers cannot mutate shared content',()=>{
  const first=getSkillShareContent('career-guide')!;first.introductions.length=0;
  assert.equal(getSkillShareContent('career-guide')!.introductions.length,100);
});
