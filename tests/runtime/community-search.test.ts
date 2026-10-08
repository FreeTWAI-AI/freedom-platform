import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { migrate } from '../../scripts/database.js';
import { seedLocal, DEMO_USERS, DEMO_COMMUNITY } from '../../packages/testing/seed.js';
import { searchCommunityContent, listTaggableContent } from '../../modules/community/content-search.js';
import { login } from '../../modules/identity-membership/service.js';
import { createApp } from '../../apps/platform-api/src/app.js';
import { DEMO_PASSWORD } from '../../packages/testing/seed.js';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL must name a disposable database');
const schema = `fp_search_${process.pid}_${Date.now()}`;
const admin = new Pool({ connectionString: url });
const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}` });
before(async () => { await admin.query(`CREATE SCHEMA ${schema}`); await migrate(pool); await seedLocal(pool); });
after(async () => { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });

test('Chinese search respects event audience, source withdrawal, literal wildcards and microsecond pagination', async () => {
  const actor = (await login(pool, DEMO_USERS[0].email, DEMO_PASSWORD)).actor;
  const publicId = randomUUID(), privateId = randomUUID(), guildId = randomUUID();
  for (const [id, visibility] of [[publicId, 'open'], [privateId, 'workshop'], [guildId, 'guild']]) {
    await pool.query(`INSERT INTO community_events(event_id,community_id,organizer_ref,title,description,starts_at,ends_at,mode,location,state,visibility,event_kind,guild_key,created_at)
      VALUES($1,$2,$3,'中文入門教學','只公開摘要',now()+interval '1 day',now()+interval '2 days','online','私人位置','published',$4,$5,$6,'2026-01-01T00:00:00.000001Z')`,
      [id, DEMO_COMMUNITY, DEMO_USERS[1].user_id, visibility, visibility === 'guild' ? 'guild_skill_exchange' : 'other', visibility === 'guild' ? 'guild_security' : null]);
  }
  assert.deepEqual((await searchCommunityContent(pool, null, { q: '入門', kinds: 'event' })).items.map(row => row.id), [publicId]);
  const member = await searchCommunityContent(pool, actor, { q: '入門', kinds: 'event' });
  assert.deepEqual(new Set(member.items.map(row => row.id)), new Set([publicId, privateId]));
  assert.equal(JSON.stringify(member).includes('私人位置'), false);
  assert.deepEqual((await searchCommunityContent(pool, null, { q: '%', kinds: 'event' })).items, []);
  await pool.query(`INSERT INTO positioning_profession_memberships(membership_id,community_id,user_id,guild_key,state) VALUES($1,$2,$3,'guild_security','active')`, [randomUUID(), DEMO_COMMUNITY, actor.user_id]);
  const seen: string[] = []; let cursor: string | undefined;
  do { const page = await searchCommunityContent(pool, actor, { q: '入門', kinds: 'event', limit: '1', cursor }); seen.push(...page.items.map(row => row.id)); cursor = page.next_cursor ?? undefined; } while (cursor);
  assert.deepEqual(new Set(seen), new Set([publicId, privateId, guildId])); assert.equal(seen.length, 3);
  await pool.query(`UPDATE positioning_profession_memberships SET state='left' WHERE user_id=$1 AND guild_key='guild_security'`, [actor.user_id]);
  assert.equal((await searchCommunityContent(pool, actor, { q: '入門', kinds: 'event' })).items.some(row => row.id === guildId), false);
  await pool.query(`UPDATE community_events SET state='cancelled' WHERE event_id=$1`, [publicId]);
  assert.deepEqual((await searchCommunityContent(pool, null, { q: '入門', kinds: 'event' })).items, []);
});

test('posts stay member-only, topics combine with type and withdrawn sources disappear', async () => {
  const actor = (await login(pool, DEMO_USERS[0].email, DEMO_PASSWORD)).actor;
  const post = randomUUID();
  await pool.query(`INSERT INTO community_social_posts(post_id,community_id,author_user_id,url,platform,title,note,state) VALUES($1,$2,$3,'https://example.com/search252','other','中文設計分享','舊內容無標籤','active')`, [post, DEMO_COMMUNITY, actor.user_id]);
  assert.deepEqual((await searchCommunityContent(pool, null, { q: '設計', kinds: 'post' })).items, []);
  assert.deepEqual((await searchCommunityContent(pool, actor, { q: '設計', kinds: 'post' })).items.map(row => row.id), [post]);
  assert.deepEqual((await searchCommunityContent(pool, actor, { q: '設計', kinds: 'post', topics: 'showcase' })).items, []);
  await pool.query(`INSERT INTO community_content_topic_sets(set_id,community_id,content_kind,content_id,topics,updated_by) VALUES($1,$2,'post',$3,ARRAY['showcase'],$4)`, [randomUUID(), DEMO_COMMUNITY, post, actor.user_id]);
  assert.deepEqual((await searchCommunityContent(pool, actor, { q: '設計', kinds: 'post', topics: 'showcase' })).items.map(row => row.id), [post]);
  await pool.query(`UPDATE community_social_posts SET state='deleted' WHERE post_id=$1`, [post]);
  assert.deepEqual((await searchCommunityContent(pool, actor, { q: '設計', kinds: 'post', topics: 'showcase' })).items, []);
});

test('native feed notes without a URL are searchable by community members with an in-app path, then disappear when removed', async () => {
  const actor = (await login(pool, DEMO_USERS[0].email, DEMO_PASSWORD)).actor;
  const note = randomUUID();
  await pool.query(`INSERT INTO community_social_posts(post_id,community_id,author_user_id,kind,url,platform,title,note,state) VALUES($1,$2,$3,'note',NULL,'other','原生筆記搜尋252','原生筆記搜尋252\n今天整理了新手教學','active')`, [note, DEMO_COMMUNITY, actor.user_id]);
  assert.deepEqual((await searchCommunityContent(pool, null, { q: '原生筆記搜尋252', kinds: 'post' })).items, []);
  const [found] = (await searchCommunityContent(pool, actor, { q: '原生筆記搜尋252', kinds: 'post' })).items;
  assert.equal(found.id, note); assert.match(found.title, /原生筆記搜尋252/); assert.equal(found.path, '#social');
  assert.ok((await listTaggableContent(pool, actor)).items.some(row => row.kind === 'post' && row.id === note && row.title.length > 0));
  await pool.query(`UPDATE community_social_posts SET state='hidden' WHERE post_id=$1`, [note]);
  assert.deepEqual((await searchCommunityContent(pool, actor, { q: '原生筆記搜尋252', kinds: 'post' })).items, []);
});

test('published work search shares live consent and owner visibility and skills have valid original-page paths', async () => {
  const project = randomUUID(), version = randomUUID(), submission = randomUUID(), sha = 'a'.repeat(64);
  await pool.query(`INSERT INTO oss_projects(project_id,community_id,owner_ref,title,description,use_notes,repository_id,repository_full_name,repository_url,relationship) VALUES($1,$2,$3,'中文作品','說明','用法','8801001','example/search-work','https://github.com/example/search-work','author')`, [project, DEMO_COMMUNITY, DEMO_USERS[2].user_id]);
  await pool.query(`INSERT INTO oss_project_versions(version_id,project_id,repository_id,commit_sha,default_branch,repository_full_name,repository_url,readme_url,license_spdx,is_fork,archived,source_snapshot,source_sha256,facts_sha256,inspected_at) VALUES($1,$2,'8801001',$3,'main','example/search-work','https://github.com/example/search-work','https://github.com/example/search-work#readme','MIT',false,false,'{}',$4,$4,now())`, [version, project, 'b'.repeat(40), sha]);
  await pool.query('UPDATE oss_projects SET current_version_id=$2 WHERE project_id=$1', [project, version]);
  await pool.query(`INSERT INTO skill_submissions(submission_id,community_id,owner_ref,status,payload,payload_sha256,consent_to_share,project_id,project_version_id,published_at,grant_consumed_at) VALUES($1,$2,$3,'published',$4,$5,true,$6,$7,now(),now())`, [submission, DEMO_COMMUNITY, DEMO_USERS[2].user_id, JSON.stringify({title:'中文作品',description:'開源分享',relationship:'author',share_introductions:[],use_notes:'用法'}), sha, project, version]);
  const found = await searchCommunityContent(pool, null, { q: '中文作品', kinds: 'work' });
  assert.deepEqual(found.items.map(row => row.id), [submission]);
  assert.equal(found.items[0].path, `/development/submissions/${submission}`);
  await pool.query("UPDATE skill_submissions SET status='revoked',revoked_at=now(),consent_to_share=false WHERE submission_id=$1", [submission]);
  assert.deepEqual((await searchCommunityContent(pool, null, { q: '中文作品', kinds: 'work' })).items, []);
  const books = await searchCommunityContent(pool, null, { kinds: 'skill_book' });
  for (const book of books.items) assert.equal(book.path, `/development/skills/${book.id}`);
});

test('HTTP optional auth, feature flag and topic version boundaries remain enforced', async () => {
  const origin = 'http://127.0.0.1:4310';
  const app = createApp(pool, origin, 'local', { communitySearchEnabled: true });
  const sign = await app.request(origin+'/api/v1/auth/login', { method:'POST', headers:{Origin:origin,'Content-Type':'application/json'}, body:JSON.stringify({email:DEMO_USERS[0].email,password:DEMO_PASSWORD}) });
  const session = await sign.json() as any;
  const cookie = sign.headers.get('set-cookie')!.split(';')[0];
  const post = randomUUID();
  await pool.query(`INSERT INTO community_social_posts(post_id,community_id,author_user_id,url,platform,title,note,state) VALUES($1,$2,$3,'https://example.com/http-search252','other','HTTP搜尋分享','摘要','active')`, [post,DEMO_COMMUNITY,session.user.user_id]);
  const query = origin+'/api/v1/community-search?kinds=post&q=HTTP';
  const found = await app.request(query,{headers:{Cookie:cookie}});
  assert.equal(found.status,200); assert.deepEqual((await found.json() as any).items.map((row:any)=>row.id),[post]);
  const body = {kind:'post',id:post.toUpperCase(),topics:['showcase']};
  const headers = {Origin:origin,Cookie:cookie,'X-CSRF-Token':session.csrf_token,'Content-Type':'application/json','Idempotency-Key':randomUUID()};
  const saved = await app.request(origin+'/api/v1/community-search/topics',{method:'POST',headers,body:JSON.stringify(body)});
  assert.equal(saved.status,200,await saved.clone().text()); assert.equal(saved.headers.get('etag'),'"1"');
  const tagged = await app.request(query+'&topics=showcase',{headers:{Cookie:cookie}});
  assert.deepEqual((await tagged.json() as any).items.map((row:any)=>row.id),[post]);
  const replay = await app.request(origin+'/api/v1/community-search/topics',{method:'POST',headers,body:JSON.stringify(body)});
  assert.equal(replay.status,200); assert.equal(replay.headers.get('etag'),'"1"');
  const clear = await app.request(origin+'/api/v1/community-search/topics',{method:'POST',headers:{...headers,'Idempotency-Key':randomUUID(),'If-Match':'"1"'},body:JSON.stringify({...body,topics:[]})});
  assert.equal(clear.status,200); assert.equal(clear.headers.get('etag'),'"2"');
  const stale = await app.request(origin+'/api/v1/community-search/topics',{method:'POST',headers:{...headers,'Idempotency-Key':randomUUID(),'If-Match':'"1"'},body:JSON.stringify(body)});
  assert.equal(stale.status,412);
  await pool.query('UPDATE sessions SET revoked_at=now() WHERE user_id=$1',[session.user.user_id]);
  const revoked = await app.request(query,{headers:{Cookie:cookie}});
  assert.equal(revoked.status,200); assert.deepEqual((await revoked.json() as any).items,[]);
  assert.equal((await app.request(origin+'/api/v1/community-search/mine',{headers:{Cookie:cookie}})).status,401);
  assert.equal((await createApp(pool,origin).request(query)).status,404);
});

test('cross-community private titles and topics are absent while public events remain discoverable', async () => {
  const otherCommunity=randomUUID(),otherUser=randomUUID(),post=randomUUID(),event=randomUUID();
  await pool.query('INSERT INTO communities VALUES($1,$2)',[otherCommunity,'另一社群']);
  await pool.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref) VALUES($1,$2,'search-other@local.test','其他作者','hash',$3)`,[otherUser,otherCommunity,randomUUID()]);
  await pool.query(`INSERT INTO community_social_posts(post_id,community_id,author_user_id,url,platform,title,note,state) VALUES($1,$2,$3,'https://example.com/other252','other','跨社群私密分享','不可洩漏摘要','active')`,[post,otherCommunity,otherUser]);
  await pool.query(`INSERT INTO community_events(event_id,community_id,organizer_ref,title,description,starts_at,ends_at,mode,location,state,visibility,event_kind) VALUES($1,$2,$3,'跨社群公開活動','公開摘要',now()+interval '1 day',now()+interval '2 days','online','私人位置','published','open','other')`,[event,otherCommunity,otherUser]);
  const actor=(await login(pool,DEMO_USERS[1].email,DEMO_PASSWORD)).actor;
  const page=await searchCommunityContent(pool,actor,{q:'跨社群'});
  assert.deepEqual(page.items.map(row=>row.id),[event]);
  assert.equal(JSON.stringify(page).includes('不可洩漏摘要'),false);
  await pool.query("UPDATE community_events SET visibility='workshop' WHERE event_id=$1",[event]);
  assert.deepEqual((await searchCommunityContent(pool,actor,{q:'跨社群'})).items,[]);
});
