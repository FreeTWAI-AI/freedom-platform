import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {Pool} from 'pg';
import {createPool,LOCAL_DATABASE_URL} from '../../packages/db/index.js';
import {migrate} from '../../scripts/database.js';
import {communityCatalog,skillBooksForGuild} from '../../modules/community/catalog.js';
import {skillMarkdown,pageHtml,skillAgentMarkdown} from '../../modules/development/service.js';
import {communityAuthorSources} from '../../modules/community/community-author-skills.js';

const url=process.env.TEST_DATABASE_URL??LOCAL_DATABASE_URL,schema=`fp_member_books_${process.pid}_${Date.now()}`;
const db=createPool(url),pool=new Pool({connectionString:url,options:`-c search_path=${schema}`});
before(async()=>{await db.query(`CREATE SCHEMA ${schema}`);await migrate(pool);});
after(async()=>{await pool.end();await db.query(`DROP SCHEMA ${schema} CASCADE`);await db.end();});

test('registered member books retain named original credit, original PR targets and accurate source limitations',()=>{
  for(const [id,name,repo,guild] of [
    ['local-workspace-mcp','Mini','arumwu/local-workspace-mcp','guild_ai_field'],
    ['editkin','Hao','Hao0321/Editkin','guild_media_automation'],
    ['positioning-companion','Jason','jason201385-commits/positioning-companion','guild_talent_direction'],
    ['freedom-party-guild-lounge','David','davidni0729/freedom-party-guild-lounge','guild_event_space'],
  ]){
    const book=communityCatalog.skill_books.find(value=>value.id===id)!;
    assert.equal(book.guide?.author_name,name);assert.equal(book.upstream_url,'https://github.com/'+repo);
    assert.equal(book.repository_url,book.upstream_url);assert.equal(book.star_url,book.upstream_url);
    assert.ok(skillBooksForGuild(guild).some(value=>value.id===id));
    const md=skillMarkdown(id)!;assert.ok(md.includes('作者：'+name));
    assert.ok(pageHtml(book.title,md,`/development/skills/${id}.md`).includes('作者：'+name));
    assert.ok(skillAgentMarkdown(id)?.includes('預設 PR 目標：'+repo+':main'));
  }
  assert.match(communityCatalog.skill_books.find(value=>value.id==='editkin')!.guide!.status,/尚無.*官方安裝包/);
  assert.equal(communityCatalog.skill_books.find(value=>value.id==='freedom-party-guild-lounge')!.license_status,'NOASSERTION');
});

test('eight community works credit original authors and use the actual upstream branch and source limitations',()=>{
  for(const [id,source] of Object.entries(communityAuthorSources)){
    const book=communityCatalog.skill_books.find(value=>value.id===id)!;
    assert.equal(book.guide?.author_name,source.author);
    assert.equal(book.source_commit,source.sha);assert.equal(book.repository_url,'https://github.com/'+source.repo);
    assert.equal(book.star_url,book.repository_url);assert.equal(book.fork_url,book.repository_url+'/fork');
    assert.equal(book.guide?.reading_url,book.repository_url+'/blob/'+source.sha+'/'+source.reading);
    for(const guild of source.guilds)assert.ok(skillBooksForGuild(guild).some(value=>value.id===id));
    const branch=['aiwff-runtime','line-persona'].includes(id)?'master':'main';
    assert.ok(skillAgentMarkdown(id)?.includes('預設 PR 目標：'+source.repo+':'+branch));
    assert.ok(skillMarkdown(id)?.includes('作者：'+source.author));
  }
  const status=(id:string)=>communityCatalog.skill_books.find(book=>book.id===id)!.guide!.status;
  assert.match(status('bidding-radar-concept'),/沒有可安裝程式/);
  assert.match(status('ai-avatar-bot'),/Haru.*專有授權/);
  assert.match(status('aiwff-runtime'),/mock.*免費.*Claude.*費用/);
  assert.match(status('line-persona'),/LINE 訊息仍經 LINE 服務/);
  assert.match(status('anti-gambling-trader-tw'),/不保證獲利.*PaperBroker/);
});

test('new publication grants match every active catalog guild and replay without changing prior grants',async()=>{
  const community=randomUUID();await pool.query('INSERT INTO communities VALUES($1,$2)',[community,'Synthetic eight-book publication']);
  const guilds=[...new Set(Object.values(communityAuthorSources).flatMap(source=>source.guilds))];
  const expected:{user_id:string;guild_key:string;book_id:string}[]=[];
  for(const guild of guilds){
    for(const [active,state] of [[true,'active'],[true,'left'],[false,'active']] as const){
      const id=randomUUID();await pool.query('INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref,active) VALUES($1,$2,$3,$4,$5,$6,$7)',[id,community,id+'@example.invalid','Synthetic','unused',randomUUID(),active]);
      await pool.query('INSERT INTO positioning_profession_memberships(membership_id,community_id,user_id,guild_key,state) VALUES($1,$2,$3,$4,$5)',[randomUUID(),community,id,guild,state]);
      if(active&&state==='active')for(const book of skillBooksForGuild(guild).filter(book=>Object.hasOwn(communityAuthorSources,book.id)))expected.push({user_id:id,guild_key:guild,book_id:book.id});
    }
  }
  const sql=await readFile(new URL('../../migrations/033_community_author_skills.sql',import.meta.url),'utf8');
  await pool.query(sql);
  const first=(await pool.query('SELECT * FROM member_skill_book_grants WHERE community_id=$1 ORDER BY user_id,book_id',[community])).rows;
  const sorted=(rows:typeof expected)=>rows.map(row=>JSON.stringify([row.user_id,row.guild_key,row.book_id])).sort();
  assert.deepEqual(sorted(first),sorted(expected));
  const publications=(await pool.query('SELECT * FROM skill_publications ORDER BY book_id')).rows;
  await pool.query(sql);
  assert.deepEqual((await pool.query('SELECT * FROM member_skill_book_grants WHERE community_id=$1 ORDER BY user_id,book_id',[community])).rows,first);
  assert.deepEqual((await pool.query('SELECT * FROM skill_publications ORDER BY book_id')).rows,publications);
  assert.equal((await pool.query('SELECT count(*) FROM development_grants')).rows[0].count,'0');
});

test('publication backfill grants only matching active memberships, is repeatable and preserves prior grants and primary choices',async()=>{
  const community=randomUUID();await pool.query('INSERT INTO communities VALUES($1,$2)',[community,'Synthetic book publication']);
  const ids:string[]=[];
  for(const [active,state,guild] of [[true,'active','guild_ai_field'],[true,'left','guild_ai_field'],[false,'active','guild_ai_field'],[true,'active','guild_marketing']] as const){
    const id=randomUUID();ids.push(id);
    await pool.query('INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref,active) VALUES($1,$2,$3,$4,$5,$6,$7)',[id,community,id+'@example.invalid','Synthetic','unused',randomUUID(),active]);
    await pool.query('INSERT INTO positioning_profession_memberships(membership_id,community_id,user_id,guild_key,state) VALUES($1,$2,$3,$4,$5)',[randomUUID(),community,id,guild,state]);
  }
  const oldId=randomUUID();await pool.query("INSERT INTO member_skill_book_grants(grant_id,community_id,user_id,guild_key,book_id,granted_at) VALUES($1,$2,$3,'guild_ai_field','agent-kit','2026-01-01')",[oldId,community,ids[0]]);
  await pool.query("INSERT INTO guild_member_preferences(community_id,user_id,primary_guild_key) VALUES($1,$2,'guild_ai_field')",[community,ids[0]]);
  const before=await pool.query('SELECT * FROM guild_member_preferences WHERE community_id=$1',[community]);
  const sql=await readFile(new URL('../../migrations/031_member_skill_books.sql',import.meta.url),'utf8');
  await pool.query(sql);const first=(await pool.query('SELECT * FROM member_skill_book_grants WHERE community_id=$1 ORDER BY book_id',[community])).rows;
  assert.equal(first.length,2);assert.ok(first.every(row=>row.user_id===ids[0]));assert.equal(first.find(row=>row.book_id==='agent-kit').grant_id,oldId);
  const publications=(await pool.query('SELECT * FROM skill_publications ORDER BY book_id')).rows;
  await pool.query(sql);
  assert.deepEqual((await pool.query('SELECT * FROM member_skill_book_grants WHERE community_id=$1 ORDER BY book_id',[community])).rows,first);
  assert.deepEqual((await pool.query('SELECT * FROM skill_publications ORDER BY book_id')).rows,publications);
  assert.deepEqual((await pool.query('SELECT * FROM guild_member_preferences WHERE community_id=$1',[community])).rows,before.rows);
  assert.equal((await pool.query('SELECT count(*) FROM development_grants')).rows[0].count,'0');
});
