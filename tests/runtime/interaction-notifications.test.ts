import {test, before, after, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {createPool, LOCAL_DATABASE_URL} from '../../packages/db/index.js';
import {migrate} from '../../scripts/database.js';
import {seedLocal, DEMO_USERS, DEMO_PASSWORD} from '../../packages/testing/seed.js';
import {createApp} from '../../apps/platform-api/src/app.js';

// #403: comments, likes and squad requests notify the other party in the same transaction.
const origin = 'http://127.0.0.1:4317', databaseUrl = process.env.TEST_DATABASE_URL ?? LOCAL_DATABASE_URL;
const schema = `fp_interaction_notes_${process.pid}_${Date.now()}`, admin = createPool(databaseUrl);
const pool = new Pool({connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 8});
const app = createApp(pool, origin);
type Session = {cookie: string; csrf: string; id: string};
type Notice = {kind: string; title: string; body: string; read_at: string | null; action: {tab: string; resource_id: string | null} | null};
before(async () => { await admin.query(`CREATE SCHEMA ${schema}`); await migrate(pool); });
after(async () => { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
beforeEach(async () => { await pool.query('TRUNCATE communities,login_attempts,auth_rate_limits CASCADE'); await seedLocal(pool); });

async function request<T = {code?: string}>(path: string, s: Session, body?: unknown, version?: string | number, key = randomUUID()) {
  const headers: Record<string, string> = {Origin: origin, Cookie: s.cookie, 'X-CSRF-Token': s.csrf};
  if (body !== undefined) { headers['Content-Type'] = 'application/json'; headers['Idempotency-Key'] = key; if (version !== undefined) headers['If-Match'] = `"${version}"`; }
  const response = await app.request(origin + '/api/v1' + path, {method: body === undefined ? 'GET' : 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body)});
  return {status: response.status, data: await response.json() as T};
}
async function signIn(index: number): Promise<Session> {
  const response = await app.request(origin + '/api/v1/auth/login', {method: 'POST', headers: {Origin: origin, 'Content-Type': 'application/json'}, body: JSON.stringify({email: DEMO_USERS[index].email, password: DEMO_PASSWORD})});
  const data = await response.json() as {csrf_token: string; user: {user_id: string}};
  return {cookie: response.headers.get('set-cookie')!.split(';')[0], csrf: data.csrf_token, id: data.user.user_id};
}
const notices = async (s: Session) => (await request<{items: Notice[]; unread_count: number}>('/me/notifications?limit=50&offset=0', s)).data;
const kinds = async (s: Session, kind: string) => (await notices(s)).items.filter(item => item.kind === kind);

test('a comment and a like notify the post author once each, never the actor, and open the post', async () => {
  const author = await signIn(0), fan = await signIn(1);
  const post = (await request<{post_id: string}>('/social-posts/notes', author, {text: '我的新作品\n歡迎留言'})).data;
  const key = randomUUID();
  assert.equal((await request(`/social-posts/${post.post_id}/comments`, fan, {text: '好喜歡這個配色'}, undefined, key)).status, 201);
  assert.equal((await request(`/social-posts/${post.post_id}/comments`, fan, {text: '好喜歡這個配色'}, undefined, key)).status, 201);
  const comments = await kinds(author, 'social_post_commented');
  assert.equal(comments.length, 1);
  assert.match(comments[0].title, /在你的貼文留言/);assert.match(comments[0].body, /我的新作品/);assert.match(comments[0].body, /好喜歡這個配色/);
  assert.deepEqual(comments[0].action, {tab: 'social', resource_id: post.post_id});

  let last = 0;
  for (const liked of [true, false, true, true]) { const result = await request<{like_count: number}>(`/social-posts/${post.post_id}/like`, fan, {liked}); assert.equal(result.status, 200); last = result.data.like_count; }
  assert.equal(last, 1, 'liking an already liked post keeps the like');
  const likes = await kinds(author, 'social_post_liked');
  assert.equal(likes.length, 1, 'unlike and like again do not notify twice');
  assert.match(likes[0].title, /按讚/);assert.deepEqual(likes[0].action, {tab: 'social', resource_id: post.post_id});

  // Own activity is never a notification.
  await request(`/social-posts/${post.post_id}/comments`, author, {text: '謝謝大家'});
  await request(`/social-posts/${post.post_id}/like`, author, {liked: true});
  assert.equal((await kinds(author, 'social_post_commented')).length, 1);
  assert.equal((await kinds(author, 'social_post_liked')).length, 1);
  assert.equal((await notices(fan)).items.length, 0);
});

test('an active block in either direction suppresses the notice but not the comment', async () => {
  const author = await signIn(0), other = await signIn(1);
  const post = (await request<{post_id: string}>('/social-posts/notes', author, {text: '封鎖測試'})).data;
  await pool.query(`INSERT INTO member_interaction_blocks(block_id,community_id,owner_ref,target_ref,state) SELECT $1,community_id,$2,$3,'active' FROM users WHERE user_id=$2`, [randomUUID(), author.id, other.id]);
  assert.equal((await request(`/social-posts/${post.post_id}/comments`, other, {text: '被封鎖仍可留言'})).status, 201);
  assert.equal((await request(`/social-posts/${post.post_id}/like`, other, {liked: true})).status, 200);
  assert.equal((await notices(author)).items.length, 0);
});

test('a squad request notifies the owner and acceptance notifies the requester, once per request', async () => {
  const owner = await signIn(0), joiner = await signIn(1);
  const squad = (await request<{squad_id: string}>('/squads', owner, {name: '通知小隊', kind: 'project', purpose: '合成通知測試'})).data;
  const key = randomUUID();
  const requested = await request<{aggregate_version: string}>(`/squads/${squad.squad_id}/request`, joiner, {}, undefined, key);
  assert.equal(requested.status, 200);
  await request(`/squads/${squad.squad_id}/request`, joiner, {}, undefined, key);
  const asked = await kinds(owner, 'squad_join_requested');
  assert.equal(asked.length, 1);assert.match(asked[0].title, /申請加入小隊「通知小隊」/);assert.deepEqual(asked[0].action, {tab: 'squads', resource_id: squad.squad_id});
  assert.equal((await request(`/squads/${squad.squad_id}/members/${joiner.id}/accept`, owner, {}, requested.data.aggregate_version)).status, 200);
  const accepted = await kinds(joiner, 'squad_join_accepted');
  assert.equal(accepted.length, 1);assert.match(accepted[0].title, /你已加入小隊「通知小隊」/);
  // Leaving and asking again is a new request and a new notice.
  const membership = (await pool.query('SELECT aggregate_version FROM member_squad_memberships WHERE squad_id=$1 AND user_id=$2', [squad.squad_id, joiner.id])).rows[0];
  assert.equal((await request(`/squads/${squad.squad_id}/leave`, joiner, {}, membership.aggregate_version)).status, 200);
  const left = (await pool.query('SELECT aggregate_version FROM member_squad_memberships WHERE squad_id=$1 AND user_id=$2', [squad.squad_id, joiner.id])).rows[0];
  assert.equal((await request(`/squads/${squad.squad_id}/request`, joiner, {}, left.aggregate_version)).status, 200);
  assert.equal((await kinds(owner, 'squad_join_requested')).length, 2);
});

test('a failing notification rolls the comment back with it', async () => {
  const author = await signIn(0), fan = await signIn(1);
  const post = (await request<{post_id: string}>('/social-posts/notes', author, {text: '回滾測試'})).data;
  await pool.query("ALTER TABLE member_notifications ADD CONSTRAINT synthetic_block_comments CHECK (kind<>'social_post_commented')");
  try {
    assert.equal((await request(`/social-posts/${post.post_id}/comments`, fan, {text: '不應留下'})).status, 500);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM community_social_comments WHERE post_id=$1', [post.post_id])).rows[0].n, 0);
  } finally { await pool.query('ALTER TABLE member_notifications DROP CONSTRAINT synthetic_block_comments'); }
});
