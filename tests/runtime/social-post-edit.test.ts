import {test, before, after, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {createPool} from '../../packages/db/index.js';
import {migrate} from '../../scripts/database.js';
import {seedLocal, DEMO_USERS, DEMO_PASSWORD} from '../../packages/testing/seed.js';
import {createApp} from '../../apps/platform-api/src/app.js';

// #399: authors edit their own social posts and comments. In-process requests and a disposable schema only.
const origin = 'http://127.0.0.1:4313';
const url = process.env.TEST_DATABASE_URL;
if (!url || !/^\/fp_[a-z0-9_]+$/.test(new URL(url).pathname)) throw new Error('Explicit isolated fp_* TEST_DATABASE_URL required.');
const schema = `fp_social_edit_${process.pid}_${Date.now()}`;
const admin = createPool(url);
const pool = new Pool({connectionString: url, options: `-c search_path=${schema}`, max: 8});
const app = createApp(pool, origin, 'local', {linkPreviewFetch: async () => new Response('<title>外部連結</title>', {headers: {'content-type': 'text/html'}})});
type Session = {cookie: string; csrf: string; id: string};
type Post = {post_id: string; kind: 'link' | 'note'; url: string | null; title: string; note: string | null; created_at: string; edited_at: string | null; revision: number; like_count: number; comment_count: number; mine: boolean};
type Comment = {comment_id: string; body: string; created_at: string; edited_at: string | null; revision: number; mine: boolean};
type Problem = {code?: string};
before(async () => { await admin.query(`CREATE SCHEMA ${schema}`); await migrate(pool); });
after(async () => { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
beforeEach(async () => { await pool.query('TRUNCATE communities,login_attempts,auth_rate_limits CASCADE'); await seedLocal(pool); });

async function request<T = Problem>(path: string, session: Session | undefined, body?: unknown, headers: Record<string, string> = {}) {
  const response = await app.request(origin + '/api/v1' + path, {method: body === undefined ? 'GET' : 'POST', headers: {Origin: origin, ...(session ? {Cookie: session.cookie, 'X-CSRF-Token': session.csrf} : {}), ...(body === undefined ? {} : {'Content-Type': 'application/json', 'Idempotency-Key': randomUUID()}), ...headers}, body: body === undefined ? undefined : JSON.stringify(body)});
  return {status: response.status, etag: response.headers.get('etag'), data: await response.json() as T};
}
async function login(index = 0): Promise<Session> {
  const response = await app.request(origin + '/api/v1/auth/login', {method: 'POST', headers: {Origin: origin, 'Content-Type': 'application/json'}, body: JSON.stringify({email: DEMO_USERS[index].email, password: DEMO_PASSWORD})});
  const data = await response.json() as {csrf_token: string; user: {user_id: string}};
  return {cookie: response.headers.get('set-cookie')!.split(';')[0], csrf: data.csrf_token, id: data.user.user_id};
}
const ifMatch = (revision: number) => ({'If-Match': `"${revision}"`});

test('the author edits a note: text and title change, likes and comments stay, the edit is marked and versioned', async () => {
  const owner = await login(), other = await login(1);
  const created = await request<Post>('/social-posts/notes', owner, {text: '第一版\n內容'});
  assert.equal(created.status, 201); assert.equal(created.data.revision, 1); assert.equal(created.data.edited_at, null);
  const id = created.data.post_id;
  await request(`/social-posts/${id}/like`, other, {liked: true});
  await request(`/social-posts/${id}/comments`, other, {text: '好棒'});

  const missing = await request(`/social-posts/${id}/edit`, owner, {text: '第二版'});
  assert.equal(missing.status, 428);
  const edited = await request<Post>(`/social-posts/${id}/edit`, owner, {text: '  第二版標題\n更新後的內容  '}, ifMatch(1));
  assert.equal(edited.status, 200, JSON.stringify(edited.data));
  assert.equal(edited.etag, '"2"');
  assert.equal(edited.data.note, '第二版標題\n更新後的內容'); assert.equal(edited.data.title, '第二版標題');
  assert.equal(edited.data.revision, 2); assert.ok(edited.data.edited_at);
  assert.equal(edited.data.created_at, created.data.created_at);
  assert.equal(edited.data.like_count, 1); assert.equal(edited.data.comment_count, 1);

  const stale = await request(`/social-posts/${id}/edit`, owner, {text: '用舊版本覆蓋'}, ifMatch(1));
  assert.equal(stale.status, 412); assert.equal(stale.data.code, 'version_conflict');
  const listed = (await request<{items: Post[]}>('/social-posts?kind=note', other)).data.items.find(item => item.post_id === id)!;
  assert.equal(listed.note, '第二版標題\n更新後的內容'); assert.equal(listed.revision, 2); assert.ok(listed.edited_at); assert.equal(listed.mine, false);
});

test('only the author edits, invalid text is refused and deleted or hidden posts cannot be edited', async () => {
  const owner = await login(), other = await login(1);
  const id = (await request<Post>('/social-posts/notes', owner, {text: '原文'})).data.post_id;
  const stranger = await request(`/social-posts/${id}/edit`, other, {text: '改掉別人的'}, ifMatch(1));
  assert.equal(stranger.status, 403); assert.equal(stranger.data.code, 'author_required');
  for (const body of [{text: '  '}, {text: 'a'.repeat(2001)}, {text: 'abc\u0000'}, {text: 'ok', url: 'https://example.com'}, {title: '連結欄位', note: null}]) {
    assert.equal((await request(`/social-posts/${id}/edit`, owner, body, ifMatch(1))).status, 422, JSON.stringify(body));
  }
  assert.equal((await pool.query('SELECT note,edit_revision FROM community_social_posts WHERE post_id=$1', [id])).rows[0].note, '原文');
  assert.equal((await request(`/social-posts/${randomUUID()}/edit`, owner, {text: 'x'}, ifMatch(1))).status, 404);
  await pool.query("UPDATE community_social_posts SET state='hidden' WHERE post_id=$1", [id]);
  assert.equal((await request(`/social-posts/${id}/edit`, owner, {text: '藏起來後再改'}, ifMatch(1))).status, 404);
});

test('a link post edits only its title and description; the URL and platform stay', async () => {
  const owner = await login();
  const created = await request<Post>('/social-posts', owner, {url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', title: '原標題', note: '原說明'});
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const id = created.data.post_id;
  assert.equal((await request(`/social-posts/${id}/edit`, owner, {text: '連結不能用 text'}, ifMatch(1))).status, 422);
  assert.equal((await request(`/social-posts/${id}/edit`, owner, {title: '新標題', note: null, url: 'https://evil.example'}, ifMatch(1))).status, 422);
  const edited = await request<Post>(`/social-posts/${id}/edit`, owner, {title: '  新標題 ', note: '  '}, ifMatch(1));
  assert.equal(edited.status, 200, JSON.stringify(edited.data));
  assert.equal(edited.data.title, '新標題'); assert.equal(edited.data.note, null); assert.equal(edited.data.url, created.data.url);
  assert.equal((await request(`/social-posts/${id}/edit`, owner, {title: 'x'.repeat(121), note: null}, ifMatch(2))).status, 422);
});

test('the comment author edits a comment with If-Match; others and deleted comments cannot', async () => {
  const owner = await login(), other = await login(1);
  const id = (await request<Post>('/social-posts/notes', owner, {text: '請留言'})).data.post_id;
  const comment = (await request<Comment>(`/social-posts/${id}/comments`, other, {text: '第一版留言'})).data;
  assert.equal(comment.revision, 1); assert.equal(comment.edited_at, null);
  const path = `/social-posts/${id}/comments/${comment.comment_id}/edit`;
  const byPostOwner = await request(path, owner, {text: '貼文作者不能改別人留言'}, ifMatch(1));
  assert.equal(byPostOwner.status, 403); assert.equal(byPostOwner.data.code, 'author_required');
  assert.equal((await request(path, other, {text: '沒有版本'})).status, 428);
  assert.equal((await request(path, other, {text: 'a'.repeat(1001)}, ifMatch(1))).status, 422);
  const edited = await request<Comment>(path, other, {text: '  改過的留言 '}, ifMatch(1));
  assert.equal(edited.status, 200, JSON.stringify(edited.data));
  assert.equal(edited.etag, '"2"'); assert.equal(edited.data.body, '改過的留言'); assert.equal(edited.data.revision, 2); assert.ok(edited.data.edited_at); assert.equal(edited.data.mine, true);
  assert.equal((await request(path, other, {text: '舊版本'}, ifMatch(1))).status, 412);
  const listed = (await request<{items: Comment[]}>(`/social-posts/${id}/comments`, owner)).data.items[0];
  assert.equal(listed.body, '改過的留言'); assert.equal(listed.revision, 2); assert.equal(listed.mine, false); assert.ok(listed.edited_at);
  const removed = await app.request(origin + `/api/v1/social-posts/${id}/comments/${comment.comment_id}`, {method: 'DELETE', headers: {Origin: origin, Cookie: other.cookie, 'X-CSRF-Token': other.csrf, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID()}, body: '{}'});
  assert.equal(removed.status, 200);
  assert.equal((await request(path, other, {text: '刪掉後再改'}, ifMatch(2))).status, 404);
});
