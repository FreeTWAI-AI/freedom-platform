import {test, before, after, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {createPool} from '../../packages/db/index.js';
import {migrate} from '../../scripts/database.js';
import {seedLocal, DEMO_USERS, DEMO_PASSWORD, DEMO_COMMUNITY} from '../../packages/testing/seed.js';
import {createApp} from '../../apps/platform-api/src/app.js';

const origin = 'http://127.0.0.1:4311';
const url = process.env.TEST_DATABASE_URL;
if (!url || !/^\/fp_[a-z0-9_]+$/.test(new URL(url).pathname)) throw new Error('Explicit isolated fp_* TEST_DATABASE_URL required.');
const schema = `fp_social_feed_${process.pid}_${Date.now()}`;
const admin = createPool(url);
const pool = new Pool({connectionString: url, options: `-c search_path=${schema}`, max: 12});
let previews = 0;
const app = createApp(pool, origin, 'local', {linkPreviewFetch: async () => { previews++; return new Response('<title>外部連結</title>', {headers: {'content-type': 'text/html'}}); }});
type Session = {cookie: string; csrf: string; id: string};
before(async () => { await admin.query(`CREATE SCHEMA ${schema}`); await migrate(pool); });
after(async () => { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
beforeEach(async () => { await pool.query('TRUNCATE communities,login_attempts,auth_rate_limits CASCADE'); await seedLocal(pool); previews = 0; });
async function request(path: string, session?: Session, body?: unknown, method = body === undefined ? 'GET' : 'POST', key = randomUUID()) {
  const response = await app.request(origin + '/api/v1' + path, {method, headers: {Origin: origin, ...(session ? {Cookie: session.cookie, 'X-CSRF-Token': session.csrf} : {}), ...(body === undefined ? {} : {'Content-Type': 'application/json', 'Idempotency-Key': key})}, body: body === undefined ? undefined : JSON.stringify(body)});
  return {status: response.status, data: await response.json() as any, response};
}
async function login(index = 0): Promise<Session> {
  const result = await request('/auth/login', undefined, {email: DEMO_USERS[index].email, password: DEMO_PASSWORD});
  assert.equal(result.status, 200);
  return {cookie: result.response.headers.get('set-cookie')!.split(';')[0], csrf: result.data.csrf_token, id: result.data.user.user_id};
}
async function post(session: Session, text = '一起分享新作品\n歡迎一起合作') {
  const result = await request('/social-posts/notes', session, {text}); assert.equal(result.status, 201, JSON.stringify(result.data)); return result.data;
}

test('write a native post without a URL/title/preview, replay once and reject a changed body', async () => {
  const session = await login(), key = randomUUID(), body = {text: '  分享作品\n第二行  '};
  const first = await request('/social-posts/notes', session, body, 'POST', key);
  assert.equal(first.status, 201, JSON.stringify(first.data)); assert.equal(first.data.kind, 'note'); assert.equal(first.data.url, null); assert.equal(first.data.note, '分享作品\n第二行'); assert.equal(previews, 0);
  assert.deepEqual((await request('/social-posts/notes', session, body, 'POST', key)).data, first.data);
  assert.equal((await request('/social-posts/notes', session, {text: 'different'}, 'POST', key)).status, 409);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM community_social_posts')).rows[0].n, 1);
  assert.equal((await request('/social-posts?kind=note', session)).data.items[0].like_count, 0);
  assert.equal((await request('/social-posts?platform=other', session)).data.items.length, 0);
  assert.equal((await request('/promotion/links', session, {kind: 'social_post', target: first.data.post_id})).status, 404);
});

test('native content validation rejects empty, control characters, oversized and unknown fields', async () => {
  const session = await login();
  for (const body of [{text: '  '}, {text: 'a'.repeat(2001)}, {text: 'abc\u0000'}, {text: 'hello', url: 'https://example.com'}]) assert.equal((await request('/social-posts/notes', session, body)).status, 422);
  assert.equal((await request('/social-posts/notes', undefined, {text: 'hello'})).status, 401);
  const denied = await app.request(origin + '/api/v1/social-posts/notes', {method: 'POST', headers: {Origin: origin, Cookie: session.cookie, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID()}, body: JSON.stringify({text: 'hello'})});
  assert.equal(denied.status, 403);
});

test('likes set the desired state, concurrent requests do not inflate counts, and promotion stays separate', async () => {
  const owner = await login(), other = await login(1), note = await post(owner);
  const path = `/social-posts/${note.post_id}/like`, key = randomUUID();
  assert.equal((await request(path, owner, {liked: true}, 'POST', key)).data.like_count, 1);
  assert.equal((await request(path, owner, {liked: true}, 'POST', key)).data.like_count, 1);
  await Promise.all([request(path, other, {liked: true}), request(path, other, {liked: true})]);
  let listed = (await request('/social-posts', owner)).data.items[0];
  assert.equal(listed.like_count, 2); assert.equal(listed.liked, true); assert.equal(listed.total_points, 0);
  assert.equal((await request(path, owner, {liked: false})).data.like_count, 1);
  listed = (await request('/social-posts', owner)).data.items[0]; assert.equal(listed.liked, false);
});

test('comments replay once, keep plain text, count accurately and only their author can delete', async () => {
  const owner = await login(), other = await login(2), note = await post(owner), key = randomUUID();
  const path = `/social-posts/${note.post_id}/comments`, body = {text: '<script>alert(1)</script>\n新的想法'};
  const first = await request(path, other, body, 'POST', key); assert.equal(first.status, 201, JSON.stringify(first.data));
  assert.deepEqual((await request(path, other, body, 'POST', key)).data, first.data);
  assert.equal((await request('/social-posts', owner)).data.items[0].comment_count, 1);
  assert.equal((await request(path, owner)).data.items[0].body, body.text);
  assert.equal((await request(path + '/' + first.data.comment_id, owner, {}, 'DELETE')).status, 403);
  assert.equal((await request(path + '/' + first.data.comment_id, other, {}, 'DELETE')).status, 200);
  assert.equal((await request(path, other, body, 'POST', key)).status, 404);
  assert.equal((await request(path, owner)).data.items.length, 0);
  assert.equal((await request('/social-posts', owner)).data.items[0].comment_count, 0);
});

test('comment pagination is stable with identical timestamps and rejects invalid cursors', async () => {
  const session = await login(), note = await post(session), path = `/social-posts/${note.post_id}/comments`;
  const time = new Date();
  for (let i = 0; i < 27; i++) await pool.query('INSERT INTO community_social_comments(post_id,community_id,author_user_id,body,created_at) VALUES($1,$2,$3,$4,$5)', [note.post_id, DEMO_COMMUNITY, session.id, `comment ${i}`, time]);
  const first = (await request(path, session)).data, next = (await request(path + '?cursor=' + first.next_cursor, session)).data;
  assert.equal(first.items.length, 24); assert.equal(next.items.length, 3); assert.equal(new Set([...first.items, ...next.items].map(item => item.comment_id)).size, 27); assert.equal(next.next_cursor, null);
  assert.equal((await request(path + '?cursor=broken', session)).status, 422);
});

test('other communities cannot read, like, comment or remove a known post', async () => {
  const owner = await login(), note = await post(owner), community = randomUUID();
  await pool.query('INSERT INTO communities(community_id,name) VALUES($1,$2)', [community, '合成隔離社群']);
  const user = randomUUID();
  await pool.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref) SELECT $1,$2,'outsider@local.test','外社群',password_hash,$3 FROM users WHERE user_id=$4`, [user, community, randomUUID(), owner.id]);
  const signed = await request('/auth/login', undefined, {email: 'outsider@local.test', password: DEMO_PASSWORD}); assert.equal(signed.status, 200);
  const outside = {id: user, csrf: signed.data.csrf_token, cookie: signed.response.headers.get('set-cookie')!.split(';')[0]};
  assert.equal((await request('/social-posts', outside)).data.items.length, 0);
  assert.equal((await request(`/social-posts/${note.post_id}/comments`, outside)).status, 404);
  assert.equal((await request(`/social-posts/${note.post_id}/comments`, outside, {text: 'hello'})).status, 404);
  assert.equal((await request(`/social-posts/${note.post_id}/like`, outside, {liked: true})).status, 404);
  assert.equal((await request(`/social-posts/${note.post_id}`, outside, {}, 'DELETE')).status, 404);
});

test('hidden/deleted posts deny new interactions and old creation/comment/like receipts', async () => {
  const session = await login(), createKey = randomUUID(), body = {text: 'hide later'};
  const note = (await request('/social-posts/notes', session, body, 'POST', createKey)).data;
  const likeKey = randomUUID(), commentKey = randomUUID();
  await request(`/social-posts/${note.post_id}/like`, session, {liked: true}, 'POST', likeKey);
  await request(`/social-posts/${note.post_id}/comments`, session, {text: 'private'}, 'POST', commentKey);
  await pool.query("UPDATE community_social_posts SET state='hidden' WHERE post_id=$1", [note.post_id]);
  assert.equal((await request('/social-posts/notes', session, body, 'POST', createKey)).status, 404);
  assert.equal((await request(`/social-posts/${note.post_id}/like`, session, {liked: true}, 'POST', likeKey)).status, 404);
  assert.equal((await request(`/social-posts/${note.post_id}/comments`, session, {text: 'private'}, 'POST', commentKey)).status, 404);
  assert.equal((await request(`/social-posts/${note.post_id}/comments`, session)).status, 404);
  assert.equal((await request('/social-posts', session)).data.items.length, 0);
});

test('revoked session denies replay and author daily limits include removed posts', async () => {
  const session = await login(), key = randomUUID(), body = {text: 'daily post'};
  const note = (await request('/social-posts/notes', session, body, 'POST', key)).data;
  await pool.query(`INSERT INTO community_social_posts(community_id,author_user_id,kind,platform,title,note,state) SELECT $1,$2,'note','other','daily','daily','deleted' FROM generate_series(1,19)`, [DEMO_COMMUNITY, session.id]);
  assert.equal((await request('/social-posts/notes', session, {text: 'over limit'})).status, 429);
  assert.equal((await request('/social-posts/notes', session, body, 'POST', key)).data.post_id, note.post_id);
  await pool.query('UPDATE sessions SET revoked_at=now() WHERE user_id=$1', [session.id]);
  assert.equal((await request('/social-posts/notes', session, body, 'POST', key)).status, 401);
});

const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

test('note publishes with its image in one command, replays by key and never exposes the public thumbnail route', async () => {
  const session = await login(), key = randomUUID(), body = {text: '附圖貼文', image: {mime_type: 'image/png', data_base64: PNG_1PX}};
  const first = await request('/social-posts/notes', session, body, 'POST', key);
  assert.equal(first.status, 201, JSON.stringify(first.data));
  assert.equal(first.data.thumbnail_url, `/api/v1/social-posts/${first.data.post_id}/thumbnail`);
  assert.deepEqual((await request('/social-posts/notes', session, body, 'POST', key)).data, first.data);
  assert.equal((await request('/social-posts/notes', session, {...body, image: {mime_type: 'image/png', data_base64: PNG_1PX.slice(0, -4) + 'AAA='}}, 'POST', key)).status, 409);
  assert.deepEqual((await pool.query('SELECT source,storage_source FROM community_social_post_thumbnails WHERE post_id=$1', [first.data.post_id])).rows[0], {source: 'upload', storage_source: 'legacy'});
  const image = await app.request(origin + `/api/v1/social-posts/${first.data.post_id}/thumbnail`, {headers: {Cookie: session.cookie}});
  assert.equal(image.status, 200); assert.equal(image.headers.get('content-type'), 'image/webp');
  assert.equal((await app.request(origin + `/api/v1/public/social-posts/${first.data.post_id}/thumbnail`)).status, 404);
  const replace = await app.request(origin + `/api/v1/social-posts/${first.data.post_id}/thumbnail`, {method: 'PUT', headers: {Origin: origin, Cookie: session.cookie, 'X-CSRF-Token': session.csrf, 'Content-Type': 'image/png', 'Idempotency-Key': randomUUID()}, body: new Uint8Array(Buffer.from(PNG_1PX, 'base64'))});
  assert.equal(replace.status, 422); assert.equal((await replace.json() as {code: string}).code, 'social_note_image_fixed');
});

test('rejected note images leave no post behind: over 2 MB, oversized body, wrong type and corrupt bytes', async () => {
  const session = await login();
  const oversized = await request('/social-posts/notes', session, {text: '太大', image: {mime_type: 'image/png', data_base64: Buffer.alloc(2 * 1024 * 1024 + 1, 1).toString('base64')}});
  assert.equal(oversized.status, 413); assert.equal(oversized.data.code, 'social_thumbnail_too_large');
  const flooded = await request('/social-posts/notes', session, {text: '太大', image: {mime_type: 'image/png', data_base64: Buffer.alloc(2 * 1024 * 1024 + 40000, 1).toString('base64')}});
  assert.equal(flooded.status, 413); assert.equal(flooded.data.code, 'body_too_large');
  const mismatched = await request('/social-posts/notes', session, {text: '型別不符', image: {mime_type: 'image/webp', data_base64: PNG_1PX}});
  assert.equal(mismatched.status, 422); assert.equal(mismatched.data.code, 'invalid_social_thumbnail');
  assert.equal((await request('/social-posts/notes', session, {text: '壞掉的 base64', image: {mime_type: 'image/png', data_base64: 'not*base64!'}})).status, 422);
  assert.equal((await request('/social-posts/notes', session, {text: '壞掉的圖', image: {mime_type: 'image/png', data_base64: Buffer.from('definitely not a png').toString('base64')}})).status, 422);
  assert.equal((await request('/social-posts/notes', session, {text: '不支援的型別', image: {mime_type: 'image/gif', data_base64: PNG_1PX}})).status, 422);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM community_social_posts')).rows[0].n, 0);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM command_receipts')).rows[0].n, 0);
  // Every other JSON command keeps the original 32 KiB ceiling.
  assert.equal((await request('/social-posts', session, {url: 'https://example.org/x', note: 'n'.repeat(40000)})).status, 413);
});

test('concurrent native and external publications share the same daily budget', async () => {
  const session = await login();
  await pool.query(`INSERT INTO community_social_posts(community_id,author_user_id,kind,platform,title,note,state) SELECT $1,$2,'note','other','daily','daily','deleted' FROM generate_series(1,19)`, [DEMO_COMMUNITY, session.id]);
  const results = await Promise.all([request('/social-posts/notes', session, {text: 'native race'}), request('/social-posts', session, {url: 'https://example.org/budget-race'})]);
  assert.deepEqual(results.map(result => result.status).sort(), [201, 429]);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM community_social_posts WHERE author_user_id=$1', [session.id])).rows[0].n, 20);
});

test('database constraints reject native null body, URLs and cross-community comment references', async () => {
  const session = await login(), note = await post(session);
  await assert.rejects(pool.query("UPDATE community_social_posts SET note=NULL WHERE post_id=$1", [note.post_id]), (e: any) => e.code === '23514');
  await assert.rejects(pool.query("UPDATE community_social_posts SET url='https://example.com' WHERE post_id=$1", [note.post_id]), (e: any) => e.code === '23514');
  await assert.rejects(pool.query('INSERT INTO community_social_comments(post_id,community_id,author_user_id,body) VALUES($1,$2,$3,$4)', [note.post_id, randomUUID(), session.id, 'cross scope']), (e: any) => e.code === '23503');
});

test('topics, check-ins, tags and member mentions round-trip with safe filters and validation', async()=>{
 const owner=await login(),other=await login(1);
 const name=(await pool.query('SELECT display_name FROM users WHERE user_id=$1',[other.id])).rows[0].display_name;
 const body={text:`@${name} 一起 #作品 #Workshop`,topic:'work',location_name:'台北松菸',mention_ids:[other.id]};
 const result=await request('/social-posts/notes',owner,body);
 assert.equal(result.status,201,JSON.stringify(result.data));assert.equal(result.data.topic,'work');assert.equal(result.data.location_name,'台北松菸');
 assert.deepEqual(result.data.tags,['作品','workshop']);assert.equal(result.data.mentions[0].user_id,other.id);
 assert.equal((await request('/social-posts?tag=WORKSHOP',owner)).data.items.length,1);
 assert.equal((await request('/social-posts?tag=不存在',owner)).data.items.length,0);
 for(const change of [{topic:'untrusted'},{location_name:'x'.repeat(121)},{mention_ids:[randomUUID()]}])assert.equal((await request('/social-posts/notes',owner,{...body,...change})).status,422);
});

test('read counts are explicit, unique across command keys and concurrent requests, and never list reader names',async()=>{
 const owner=await login(),other=await login(1),note=await post(owner),path=`/social-posts/${note.post_id}/read`;
 assert.equal((await request('/social-posts',owner)).data.items[0].read_count,0);
 await Promise.all([request(path,owner,{}),request(path,owner,{}),request(path,other,{})]);
 const value=(await request('/social-posts',owner)).data.items[0];assert.equal(value.read_count,2);assert.equal(value.readers,undefined);
 await request(`/social-posts/${note.post_id}`,owner,{},'DELETE');assert.equal((await request(path,owner,{})).status,404);
});

test('like names respect current membership and blocks; comment likes deduplicate and disappear with the comment',async()=>{
 const owner=await login(),other=await login(1),note=await post(owner),path=`/social-posts/${note.post_id}`;
 await request(`${path}/like`,other,{liked:true});
 assert.equal((await request(`${path}/likes`,owner)).data.items[0].user_id,other.id);
 await pool.query("INSERT INTO member_interaction_blocks(community_id,owner_ref,target_ref,state) VALUES($1,$2,$3,'active')",[DEMO_COMMUNITY,other.id,owner.id]);
 assert.equal((await request(`${path}/likes`,owner)).data.items.length,0);
 assert.equal((await request('/social-posts/notes',owner,{text:'@member',mention_ids:[other.id]})).status,422);
 await pool.query("UPDATE member_interaction_blocks SET state='removed',aggregate_version=aggregate_version+1 WHERE owner_ref=$1 AND target_ref=$2",[other.id,owner.id]);
 const created=await request(`${path}/comments`,other,{text:'好棒 😂',sticker_id:'workshop-v1-cheer'});assert.equal(created.status,201);
 const id=created.data.comment_id,key=randomUUID();
 const liked=await request(`${path}/comments/${id}/like`,owner,{liked:true},'POST',key);assert.equal(liked.data.like_count,1);
 await Promise.all([request(`${path}/comments/${id}/like`,owner,{liked:true}),request(`${path}/comments/${id}/like`,owner,{liked:true})]);
 let comment=(await request(`${path}/comments`,owner)).data.items[0];assert.equal(comment.liked,true);assert.equal(comment.like_count,1);assert.equal(comment.sticker_id,'workshop-v1-cheer');
 await request(`${path}/comments/${id}/like`,owner,{liked:false});comment=(await request(`${path}/comments`,owner)).data.items[0];assert.equal(comment.like_count,0);
 await request(`${path}/comments/${id}`,other,{},'DELETE');assert.equal((await request(`${path}/comments/${id}/like`,owner,{liked:true},'POST',key)).status,404);
 await pool.query('UPDATE users SET active=false WHERE user_id=$1',[other.id]);assert.equal((await request(`${path}/likes`,owner)).data.items.length,0);
});

test('comment image lifecycle binds owner and post, survives an unknown ACK, and denies hidden content',async()=>{
 const {FakeObjectStore}=await import('../../packages/asset-storage/fake-store.js');
 const {default:sharp}=await import('sharp');
 const role=`${schema}_images`,store=new FakeObjectStore();
 await admin.query(`CREATE ROLE ${role} NOLOGIN;GRANT USAGE ON SCHEMA ${schema} TO ${role}`);
 await pool.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA ${schema} TO ${role};GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA ${schema} TO ${role}`);
 const {readFile}=await import('node:fs/promises');
 const grants=await readFile(new URL('../../deploy/cloudflare/sql/20-runtime-grants.psql',import.meta.url),'utf8');
 for(const match of grants.matchAll(/-- BEGIN [A-Z ]+\n([\s\S]*?)\n\\gexec/g)){
  const sql=match[1].replaceAll(":'runtime'",`'${role}'`).replaceAll("n.nspname='public'",`n.nspname='${schema}'`);
  for(const row of (await pool.query(sql)).rows)await pool.query(Object.values(row)[0] as string);
 }
 const restricted=new Pool({connectionString:url,options:`-c role=${role} -c search_path=${schema}`});
 const imageApp=createApp(restricted,origin,'local',{socialThumbnailAssetStore:store});
 try{
 const owner=await login(),other=await login(1),note=await post(owner),another=await post(owner,'另一篇'),key=randomUUID();
 const bytes=await sharp({create:{width:60,height:40,channels:4,background:'#aabbcc'}}).png().toBuffer();
 const upload=async(session=owner,postId=note.post_id,uploadKey=key,source=bytes)=>{
  const response=await imageApp.request(`${origin}/api/v1/social-posts/${postId}/comment-images`,{method:'POST',headers:{Origin:origin,Cookie:session.cookie,'X-CSRF-Token':session.csrf,'Content-Type':'image/png','Idempotency-Key':uploadKey},body:new Uint8Array(source)});
  return {status:response.status,data:await response.json() as any};
 };
 assert.equal((await upload()).status,503);
 await pool.query("UPDATE domain_media_storage_policy SET mode='r2_only',policy_revision='test-social-wall',persistence_allowed=true,retained_byte_limit=104857600 WHERE purpose='community.comment-image'");
 store.failNext('put-after'); // Storage committed, transport reported failure: immutable readback recovers.
 const image=await upload();assert.equal(image.status,201,JSON.stringify(image.data));assert.deepEqual(await upload(),image);
 assert.equal((await upload(owner,note.post_id,key,Buffer.from('bad'))).status,422);
 assert.equal((await request(`/social-posts/${note.post_id}/comments`,other,{image_id:image.data.image_id})).status,404);
 assert.equal((await request(`/social-posts/${another.post_id}/comments`,owner,{image_id:image.data.image_id})).status,404);
 const body={image_id:image.data.image_id,text:'我的照片'},commentKey=randomUUID();
 const comment=await request(`/social-posts/${note.post_id}/comments`,owner,body,'POST',commentKey);assert.equal(comment.status,201,JSON.stringify(comment.data));
 assert.deepEqual((await request(`/social-posts/${note.post_id}/comments`,owner,body,'POST',commentKey)).data,comment.data);
 assert.equal((await request(`/social-posts/${note.post_id}/comments`,owner,body)).status,409);
 const read=()=>imageApp.request(origin+comment.data.image_url,{headers:{Cookie:other.cookie}});
 let response=await read();assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'private, no-store');
 const metadata=await sharp(Buffer.from(await response.arrayBuffer())).metadata();assert.equal(metadata.format,'webp');
 const get=store.get.bind(store);store.get=async(...args)=>{const value=await get(...args);await request(`/social-posts/${note.post_id}/comments/${comment.data.comment_id}`,owner,{},'DELETE');return value;};
 assert.equal((await read()).status,404,'deletion during object I/O cannot return bytes');store.get=get;assert.equal((await read()).status,404);
 await pool.query("UPDATE community_social_posts SET state='hidden' WHERE post_id=$1",[note.post_id]);assert.equal((await upload()).status,404);
 }finally{await restricted.end();await pool.query(`DROP OWNED BY ${role}`);await admin.query(`DROP ROLE ${role}`);}
});
