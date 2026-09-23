import {test,before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {Pool} from 'pg';
import {createPool,LOCAL_DATABASE_URL} from '../../packages/db/index.js';
import {migrate} from '../../scripts/database.js';
import {skillDiscovery,recordConfirmedStar,reconcileConfirmedStar} from '../../modules/community/discovery.js';
import {communityCatalog} from '../../modules/community/catalog.js';
import {createApp} from '../../apps/platform-api/src/app.js';

const url=process.env.TEST_DATABASE_URL??LOCAL_DATABASE_URL,schema=`fp_discovery_${process.pid}_${Date.now()}`;
const db=createPool(url),pool=new Pool({connectionString:url,options:`-c search_path=${schema}`});
const now=new Date('2026-09-23T16:30:00Z'),repository='Hao0321/claude-skill-social-post';
before(async()=>{await db.query(`CREATE SCHEMA ${schema}`);await migrate(pool);});
after(async()=>{await pool.end();await db.query(`DROP SCHEMA ${schema} CASCADE`);await db.end();});
beforeEach(async()=>{await pool.query('TRUNCATE skill_star_support,skill_publications');});

test('unknown dates and empty rankings stay empty; official guild selection is not fabricated popularity',async()=>{
  const result=await skillDiscovery(pool,now);
  assert.equal(result.books.length,communityCatalog.skill_books.length);
  assert.deepEqual(result.weekly,[]);assert.deepEqual(result.monthly,[]);
  assert.ok(result.books.every(book=>book.published_at===null&&!book.is_new_today&&book.week_rank===null&&book.month_rank===null));
  assert.ok(result.books.find(book=>book.book_id==='social-post')?.official_guild_keys.includes('guild_marketing'));
});
test('new skills use a stored actual publication date with Taipei day boundaries',async()=>{
  await pool.query("INSERT INTO skill_publications VALUES('social-post',$1),('video-autopilot',$2),('security-scanner',$3)",['2026-09-23T16:00:00Z','2026-09-23T15:59:59Z','2026-09-24T16:00:00Z']);
  const result=await skillDiscovery(pool,now);
  assert.equal(result.books.find(book=>book.book_id==='social-post')?.is_new_today,true);
  assert.equal(result.books.find(book=>book.book_id==='video-autopilot')?.is_new_today,false);
  assert.equal(result.books.find(book=>book.book_id==='security-scanner')?.published_at,null);
});
test('deduplicates real identity and preserves first confirmation on retries or unstar/restar',async()=>{
  const q=await pool.connect();
  try{
    await recordConfirmedStar(q,'123',repository,true);
    await q.query("UPDATE skill_star_support SET first_confirmed_at=$1",['2026-09-20T12:00:00Z']);
    await recordConfirmedStar(q,'123',repository.toUpperCase(),true);
    assert.equal((await skillDiscovery(pool,now)).books.find(b=>b.book_id==='social-post')?.week_stars,1);
    await recordConfirmedStar(q,'123',repository,false);
    assert.equal((await skillDiscovery(pool,now)).weekly.length,0);
    await recordConfirmedStar(q,'123',repository,true);
    assert.equal((await q.query('SELECT first_confirmed_at FROM skill_star_support')).rows[0].first_confirmed_at.toISOString(),'2026-09-20T12:00:00.000Z');
    await reconcileConfirmedStar(q,'123',repository,false);
    assert.equal((await skillDiscovery(pool,now)).weekly.length,0);
    await reconcileConfirmedStar(q,'999',repository,true);
    assert.equal((await q.query('SELECT count(*) FROM skill_star_support')).rows[0].count,'1');
  }finally{q.release();}
});
test('rolling windows exclude expired, future and withdrawn support; equal counts get equal ranks',async()=>{
  const rows=[['1',repository,'2026-09-22',true],['2',repository,'2026-09-10',true],['3',repository,'2026-08-01',true],['4',repository,'2026-09-25',true],['5',repository,'2026-09-22',false],['6','teddashh/ai-security-scanner','2026-09-22',true]];
  for(const [id,repo,date,active] of rows)await pool.query('INSERT INTO skill_star_support(github_user_id,repository_key,first_confirmed_at,active) VALUES($1,lower($2),$3,$4)',[id,repo,date,active]);
  const result=await skillDiscovery(pool,now),social=result.books.find(b=>b.book_id==='social-post')!;
  assert.equal(social.week_stars,1);assert.equal(social.month_stars,2);
  assert.deepEqual(result.weekly.map(b=>b.rank),[1,1]);
  assert.equal(result.monthly[0].book_id,'social-post');
  assert.equal(JSON.stringify(result).includes('github_user_id'),false);
});
test('public discovery endpoint contains aggregates only, never member identity or credentials',async()=>{
  const response=await createApp(pool).request('http://127.0.0.1:4310/api/v1/skills/discovery');
  assert.equal(response.status,200);const body=await response.json();assert.equal(body.timezone,'Asia/Taipei');
  assert.doesNotMatch(JSON.stringify(body),/github_user_id|email|encrypted_tokens|client_secret|csrf_token/);
});
