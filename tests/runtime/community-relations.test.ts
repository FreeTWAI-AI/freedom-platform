import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { migrate } from '../../scripts/database.js';
import { seedLocal, DEMO_USERS, DEMO_COMMUNITY, DEMO_PASSWORD } from '../../packages/testing/seed.js';
import { createApp } from '../../apps/platform-api/src/app.js';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL must name a disposable database');
const schema = `fp_relations_${process.pid}_${Date.now()}`;
const admin = new Pool({ connectionString: url });
const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}` });
const origin = 'http://127.0.0.1:4310';
const app = createApp(pool, origin, 'local', { communitySearchEnabled: true, communityRelationsEnabled: true });
before(async () => { await admin.query(`CREATE SCHEMA ${schema}`); await migrate(pool); await seedLocal(pool); });
after(async () => { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
async function member(index: number) {
  const response = await app.request(origin+'/api/v1/auth/login', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: DEMO_USERS[index].email, password: DEMO_PASSWORD }) });
  assert.equal(response.status, 200);
  const session = await response.json() as any;
  const cookie = response.headers.get('set-cookie')!.split(';')[0];
  const headers = { Origin: origin, Cookie: cookie, 'X-CSRF-Token': session.csrf_token, 'Content-Type': 'application/json' };
  return { session, headers, get: async (path: string) => app.request(origin+'/api/v1/community-relations/'+path, { headers }), post: async (path: string, body: unknown, key=randomUUID()) => app.request(origin+'/api/v1/community-relations/'+path, { method: 'POST', headers: { ...headers, 'Idempotency-Key': key }, body: JSON.stringify(body) }) };
}
async function post(owner: string, title: string) {
  const id = randomUUID();
  await pool.query(`INSERT INTO community_social_posts(post_id,community_id,author_user_id,url,platform,title,note,state) VALUES($1,$2,$3,$5,'other',$4,'不可洩漏摘要','active')`, [id, DEMO_COMMUNITY, owner, title, `https://example.com/relations253/${id}`]);
  return id;
}

test('private bookmarks survive re-login, remain owner-only, retry once and redact withdrawn content', async () => {
  const owner = await member(0), stranger = await member(1);
  const id = await post(DEMO_USERS[2].user_id, '私密收藏測試253');
  const body = { kind: 'post', id, selected: true }, key = randomUUID();
  const saved = await owner.post('bookmarks', body, key);
  assert.equal(saved.status, 200, await saved.clone().text());
  const replay = await owner.post('bookmarks', body, key);
  assert.equal(replay.status, 200, await replay.clone().text());
  const again = await member(0);
  const bookmarks = await (await again.get('bookmarks')).json() as any;
  assert.deepEqual(bookmarks.items.map((item: any) => item.id), [id]);
  assert.equal(bookmarks.items[0].content.title, '私密收藏測試253');
  const other = await (await stranger.get('bookmarks')).json() as any;
  assert.deepEqual(other.items, []);
  await pool.query(`UPDATE community_social_posts SET state='deleted' WHERE post_id=$1`, [id]);
  const hidden = await (await again.get('bookmarks')).json() as any;
  assert.equal(hidden.items[0].content, null);
  assert.equal(JSON.stringify(hidden).includes('不可洩漏摘要'), false);
  assert.equal(JSON.stringify(hidden).includes('私密收藏測試253'), false);
  const removed = await again.post('bookmarks', { ...body, selected: false });
  assert.equal(removed.status, 200, await removed.clone().text());
  assert.deepEqual((await (await again.get('bookmarks')).json() as any).items, []);
});

test('author and topic opt-in updates respect current source ACL and unfollow keeps bookmarks', async () => {
  const owner = await member(0);
  const author = DEMO_USERS[2].user_id;
  const id = await post(author, '追蹤作者測試253');
  assert.equal((await owner.post('bookmarks', { kind: 'post', id, selected: true })).status, 200);
  assert.equal((await owner.post('follows', { kind: 'author', id: author, selected: true })).status, 200);
  let updates = await (await owner.get('updates')).json() as any;
  assert.equal(updates.items.some((item: any) => item.id === id), true);
  assert.equal((await owner.post('follows', { kind: 'author', id: author, selected: false })).status, 200);
  updates = await (await owner.get('updates')).json() as any;
  assert.equal(updates.items.some((item: any) => item.id === id), false);
  assert.equal((await (await owner.get('bookmarks')).json() as any).items.some((item: any) => item.id === id), true);
  assert.equal((await owner.post('follows', { kind: 'topic', id: 'showcase', selected: true })).status, 200);
  await pool.query(`INSERT INTO community_content_topic_sets(set_id,community_id,content_kind,content_id,topics,updated_by) VALUES($1,$2,'post',$3,ARRAY['showcase'],$4)`, [randomUUID(), DEMO_COMMUNITY, id, author]);
  updates = await (await owner.get('updates')).json() as any;
  assert.equal(updates.items.some((item: any) => item.id === id), true);
  await pool.query(`UPDATE community_social_posts SET state='deleted' WHERE post_id=$1`, [id]);
  updates = await (await owner.get('updates')).json() as any;
  assert.equal(updates.items.some((item: any) => item.id === id), false);
  assert.equal((await owner.post('follows', { kind: 'topic', id: 'showcase', selected: false })).status, 200);
});

test('disabled authors become unavailable, foreign authors cannot be followed and flags/auth fail closed', async () => {
  const owner = await member(0);
  const author = DEMO_USERS[1].user_id;
  const followed = await owner.post('follows', { kind: 'author', id: author, selected: true });
  assert.equal(followed.status, 200, await followed.clone().text());
  await pool.query(`UPDATE users SET active=false WHERE user_id=$1`, [author]);
  const follows = await (await owner.get('follows')).json() as any;
  const unavailable = follows.items.find((item: any) => item.id === author);
  assert.equal(unavailable.available, false); assert.equal(unavailable.label, null);
  assert.equal((await owner.post('follows', { kind: 'author', id: author, selected: false })).status, 200);
  await pool.query(`UPDATE users SET active=true WHERE user_id=$1`, [author]);
  const community = randomUUID(), outsider = randomUUID();
  await pool.query(`INSERT INTO communities VALUES($1,$2)`, [community, '其他社群']);
  await pool.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref,active,onboarding_required) VALUES($1,$2,$3,'外社群作者','not-a-login-hash',$4,true,false)`, [outsider, community, outsider+'@example.test',randomUUID()]);
  assert.equal((await owner.post('follows', { kind: 'author', id: outsider, selected: true })).status, 404);
  assert.equal((await app.request(origin+'/api/v1/community-relations/bookmarks')).status, 401);
  const disabled = createApp(pool, origin, 'local', { communitySearchEnabled: true });
  assert.equal((await disabled.request(origin+'/api/v1/community-relations/bookmarks')).status, 404);
  const anonymous = await app.request(origin+'/api/v1/community-relations/follows');
  assert.equal(anonymous.headers.get('Cache-Control')?.includes('no-store'), true);
});

test('bookmarks resolve all four source kinds live without copying content or granting guild access', async () => {
  const owner = await member(0);
  const actor = owner.session.user.user_id;
  const event = randomUUID(), project = randomUUID(), version = randomUUID(), work = randomUUID(), sha = 'c'.repeat(64);
  await pool.query(`INSERT INTO community_events(event_id,community_id,organizer_ref,title,description,starts_at,ends_at,mode,location,state,visibility,event_kind,guild_key) VALUES($1,$2,$3,'收藏活動253','活動摘要',now()+interval '1 day',now()+interval '2 days','online','私人位置','published','guild','guild_skill_exchange','guild_security')`, [event, DEMO_COMMUNITY, DEMO_USERS[1].user_id]);
  const forbidden = await owner.post('bookmarks', { kind: 'event', id: event, selected: true });
  assert.equal(forbidden.status, 404, await forbidden.clone().text());
  await pool.query(`INSERT INTO positioning_profession_memberships(membership_id,community_id,user_id,guild_key,state) VALUES($1,$2,$3,'guild_security','active')`, [randomUUID(), DEMO_COMMUNITY, actor]);
  await pool.query(`INSERT INTO oss_projects(project_id,community_id,owner_ref,title,description,use_notes,repository_id,repository_full_name,repository_url,relationship) VALUES($1,$2,$3,'收藏作品253','說明','用法','8802001','example/bookmark-work','https://github.com/example/bookmark-work','author')`, [project, DEMO_COMMUNITY, DEMO_USERS[2].user_id]);
  await pool.query(`INSERT INTO oss_project_versions(version_id,project_id,repository_id,commit_sha,default_branch,repository_full_name,repository_url,readme_url,license_spdx,is_fork,archived,source_snapshot,source_sha256,facts_sha256,inspected_at) VALUES($1,$2,'8802001',$3,'main','example/bookmark-work','https://github.com/example/bookmark-work','https://github.com/example/bookmark-work#readme','MIT',false,false,'{}',$4,$4,now())`, [version, project, 'd'.repeat(40), sha]);
  await pool.query('UPDATE oss_projects SET current_version_id=$2 WHERE project_id=$1', [project, version]);
  await pool.query(`INSERT INTO skill_submissions(submission_id,community_id,owner_ref,status,payload,payload_sha256,consent_to_share,project_id,project_version_id,published_at,grant_consumed_at) VALUES($1,$2,$3,'published',$4,$5,true,$6,$7,now(),now())`, [work, DEMO_COMMUNITY, DEMO_USERS[2].user_id, JSON.stringify({ title:'收藏作品253',description:'開源分享',relationship:'author',share_introductions:[],use_notes:'用法' }), sha, project, version]);
  const books = await app.request(origin+'/api/v1/community-search?kinds=skill_book');
  const book = (await books.json() as any).items[0].id;
  const posted = await post(actor, '四類收藏253');
  const targets = [{kind:'event',id:event},{kind:'work',id:work},{kind:'skill_book',id:book},{kind:'post',id:posted}];
  for (const target of targets) {
    const saved = await owner.post('bookmarks', {...target,selected:true});
    assert.equal(saved.status,200,await saved.clone().text());
  }
  const visible = await (await owner.get('bookmarks')).json() as any;
  for (const target of targets) assert.equal(visible.items.some((item:any)=>item.id===target.id&&item.content?.kind===target.kind),true);
  await pool.query(`UPDATE positioning_profession_memberships SET state='left' WHERE community_id=$1 AND user_id=$2 AND guild_key='guild_security'`,[DEMO_COMMUNITY,actor]);
  await pool.query(`UPDATE skill_submissions SET status='revoked',revoked_at=now(),consent_to_share=false WHERE submission_id=$1`,[work]);
  const redacted = await (await owner.get('bookmarks')).json() as any;
  for (const id of [event,work]) assert.equal(redacted.items.find((item:any)=>item.id===id).content,null);
});

test('bookmark cursor traverses more than one page exactly once and ignores another owner query', async () => {
  const owner = await member(1), stranger = await member(2);
  const ids:string[]=[];
  for(let index=0;index<21;index++){
    const id=await post(DEMO_USERS[1].user_id,`分頁收藏253-${index}`);ids.push(id);
    const response=await owner.post('bookmarks',{kind:'post',id,selected:true});
    assert.equal(response.status,200,await response.clone().text());
  }
  const seen:string[]=[];let cursor:string|null=null;
  do{
    const response=await owner.get('bookmarks'+(cursor?'?cursor='+encodeURIComponent(cursor):''));
    assert.equal(response.status,200,await response.clone().text());
    const page=await response.json() as any;
    seen.push(...page.items.map((item:any)=>item.id));cursor=page.next_cursor;
  }while(cursor);
  assert.deepEqual(new Set(seen),new Set(ids));assert.equal(seen.length,ids.length);
  const unauthorized=await stranger.get('bookmarks?owner='+DEMO_USERS[1].user_id);
  if(unauthorized.status===200)assert.deepEqual((await unauthorized.json() as any).items,[]);
  else assert.equal(unauthorized.status,422);
});
