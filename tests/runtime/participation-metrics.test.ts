import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { migrate } from '../../scripts/database.js';
import { seedLocal, DEMO_COMMUNITY, DEMO_USERS } from '../../packages/testing/seed.js';
import { participationMetrics, MIN_SAMPLE } from '../../modules/community/participation-metrics.js';
import { createApp } from '../../apps/platform-api/src/app.js';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createAdminAccessVerifier } from '../../modules/platform-admin/access.js';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL must name a disposable database');
const schema = `fp_metrics_${process.pid}_${Date.now()}`;
const admin = new Pool({ connectionString: url });
const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}` });
const origin = 'http://127.0.0.1:4310';
// Taipei is UTC+8: 2026-10-01T00:00+08 is 2026-09-30T16:00Z.
const NOW = new Date('2026-10-20T00:00:00Z');
const range = { from: '2026-10-01', to: '2026-10-05' };
before(async () => { await admin.query(`CREATE SCHEMA ${schema}`); await migrate(pool); });
after(async () => { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
beforeEach(async () => { await pool.query('TRUNCATE communities CASCADE'); await seedLocal(pool); });

async function member(opts: { at: string; source?: 'registered' | 'launch_day'; test?: boolean; active?: boolean; community?: string } ) {
  const id = randomUUID(), community = opts.community ?? DEMO_COMMUNITY;
  if (community !== DEMO_COMMUNITY) await pool.query('INSERT INTO communities VALUES($1,$2) ON CONFLICT DO NOTHING', [community, '其他社群']);
  await pool.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref,created_at,created_at_source,active)
    VALUES($1,$2,$3,'指標會員','hash',$4,$5,$6,$7)`, [id, community, `m-${id}@${opts.test ? 'example.invalid' : 'example.test'}`, randomUUID(), opts.at, opts.source ?? 'registered', opts.active ?? true]);
  return { id, community };
}
async function post(author: { id: string; community: string }, at: string, state = 'active') {
  const id = randomUUID();
  await pool.query(`INSERT INTO community_social_posts(post_id,community_id,author_user_id,kind,url,platform,title,note,state,created_at,updated_at) VALUES($1,$2,$3,'note',NULL,'other','貼文','貼文內容',$4,$5,$5)`, [id, author.community, author.id, state, at]);
  return id;
}
async function comment(postId: string, author: { id: string; community: string }, at: string, state = 'active') {
  await pool.query('INSERT INTO community_social_comments(post_id,community_id,author_user_id,body,state,created_at) VALUES($1,$2,$3,$4,$5,$6)', [postId, author.community, author.id, '回覆', state, at]);
}
const metrics = async (community = DEMO_COMMUNITY, r: object = range) => (await participationMetrics(pool, { community_id: community }, r, NOW)).metrics;
async function many<T>(count: number, make: (index: number) => Promise<T>) { const out: T[] = []; for (let i = 0; i < count; i++) out.push(await make(i)); return out; }

async function showcase(author:{id:string;community:string},at:string){
  const id=randomUUID();await pool.query(`INSERT INTO showcases(showcase_id,community_id,owner_ref,title,description,artifact_ref,consent_recorded_at,created_at)
    VALUES($1,$2,$3,'Published metric source','Source snapshot','synthetic-artifact',$4,$4)`,[id,author.community,author.id,at]);return id;
}
async function withdrawShowcase(id:string){
  await pool.query("UPDATE showcases SET status='withdrawn',visibility='private',aggregate_version=aggregate_version+1 WHERE showcase_id=$1",[id]);
  assert.ok((await pool.query('SELECT consent_recorded_at FROM showcases WHERE showcase_id=$1',[id])).rows[0].consent_recorded_at,'withdrawal retains historical consent');
}
async function shareEvent(author:{id:string;community:string},id:string,version:number,at:string,command='share_with_community'){
  await pool.query(`INSERT INTO transition_journal(transition_id,community_id,aggregate_type,aggregate_id,aggregate_version,command,actor_ref,data,created_at)
    VALUES($1,$2,'showcase',$3,$4,$5,$6,'{}',$7)`,[randomUUID(),author.community,id,version,command,author.id,at]);
}
const REPORT_TEXT = 'case-text-sentinel-9f3a';
async function memberReport(reporter:{id:string;community:string},at:string,events:{at:string;state:'in_progress'|'closed';command?:string}[]=[]){
  const id=randomUUID();
  // The row state stays received so the metric has to read the journal, not this column.
  await pool.query(`INSERT INTO member_reports(case_id,community_id,reporter_user_id,target_kind,target_id,reason,note,evidence,summary,processing_reason,state,created_at,updated_at)
    VALUES($1,$2,$3,'member',$4,'other',$5,'{}'::jsonb,$5,$5,'received',$6,$6)`,[id,reporter.community,reporter.id,randomUUID(),REPORT_TEXT,at]);
  let version=1;
  for(const event of events){
    version+=1;
    await pool.query(`INSERT INTO transition_journal(transition_id,community_id,aggregate_type,aggregate_id,aggregate_version,command,actor_ref,data,created_at)
      VALUES($1,$2,'member_report',$3,$4,$5,$6,$7::jsonb,$8)`,[randomUUID(),reporter.community,id,version,event.command??'transition',reporter.id,JSON.stringify({state:event.state,reason:REPORT_TEXT,summary:REPORT_TEXT}),event.at]);
  }
  return id;
}
test('republishing preserves the first showcase cohort and earlier return event while current withdrawal excludes both',async()=>{
  const author=await member({at:'2026-10-02T10:00:00+08'}),id=await showcase(author,'2026-10-03T10:00:00+08');
  await shareEvent(author,id,1,'2026-10-03T10:00:00+08');
  assert.equal((await metrics()).registration_first_share_7d.numerator,1);
  await withdrawShowcase(id);
  let value=await metrics();assert.equal(value.registration_first_share_7d.numerator,0);assert.equal(value.first_share_return_7d.denominator,0);
  // Mirror publishOwnShowcase: renewed consent changes, original journal facts do not.
  await pool.query("UPDATE showcases SET status='published',visibility='community',consent_recorded_at='2026-10-04T10:00:00+08',aggregate_version=3 WHERE showcase_id=$1",[id]);
  await shareEvent(author,id,3,'2026-10-04T10:00:00+08');
  await withdrawShowcase(id);
  await pool.query("UPDATE showcases SET status='published',visibility='community',consent_recorded_at='2026-10-15T10:00:00+08',aggregate_version=5 WHERE showcase_id=$1",[id]);
  await shareEvent(author,id,5,'2026-10-15T10:00:00+08');
  value=await metrics();assert.equal(value.registration_first_share_7d.numerator,1);
  assert.deepEqual([value.first_share_return_7d.numerator,value.first_share_return_7d.denominator],[1,1]);
  assert.equal((await metrics(DEMO_COMMUNITY,{from:'2026-10-15',to:'2026-10-15'})).first_share_return_7d.pending_window,0,'renewed consent cannot move the first-share cohort');
  await withdrawShowcase(id);value=await metrics();
  assert.equal(value.registration_first_share_7d.numerator,0);assert.equal(value.first_share_return_7d.denominator,0);
});
test('showcase publication history is scoped to owner and resource, with consent fallback only without a matching event',async()=>{
  const author=await member({at:'2026-10-02T10:00:00+08'}),other=await member({at:'2026-09-01T10:00:00+08',source:'launch_day'});
  const id=await showcase(author,'2026-10-03T10:00:00+08');
  await shareEvent(other,id,1,'2026-10-01T10:00:00+08');
  await shareEvent(author,id,2,'2026-10-01T10:00:00+08','draft');
  await shareEvent(author,randomUUID(),1,'2026-10-01T10:00:00+08');
  assert.equal((await metrics()).registration_first_share_7d.numerator,1,'unrelated journal rows do not defeat legacy consent fallback');
  await shareEvent(author,id,3,'2026-10-01T10:00:00+08');
  assert.equal((await metrics()).registration_first_share_7d.numerator,0,'valid earlier history wins over later consent, even outside the registration window');
});

test('withdrawn showcases leave both registration first-share and first-share return cohorts on recomputation',async()=>{
  const author=await member({at:'2026-10-02T10:00:00+08'}),id=await showcase(author,'2026-10-03T10:00:00+08');
  const before=await metrics();assert.equal(before.registration_first_share_7d.numerator,1);assert.equal(before.first_share_return_7d.denominator,1);
  await withdrawShowcase(id);
  const after=await metrics();assert.equal(after.registration_first_share_7d.numerator,0);assert.equal(after.first_share_return_7d.denominator,0);
});
test('withdrawn showcases cannot remain a later participation-return event',async()=>{
  const author=await member({at:'2026-09-01T10:00:00+08',source:'launch_day'});await post(author,'2026-10-02T10:00:00+08');
  const id=await showcase(author,'2026-10-03T10:00:00+08');assert.equal((await metrics()).first_share_return_7d.numerator,1);
  await withdrawShowcase(id);const after=(await metrics()).first_share_return_7d;assert.deepEqual([after.numerator,after.denominator],[0,1]);
});
for(const state of ['hidden','deleted'])test(`comments under ${state} parents leave first-comment and return metrics`,async()=>{
  const author=await member({at:'2026-10-02T08:00:00+08'}),other=await member({at:'2026-09-01T10:00:00+08',source:'launch_day'});
  await post(author,'2026-10-02T10:00:00+08');const parent=await post(other,'2026-09-29T10:00:00+08');await comment(parent,author,'2026-10-03T10:00:00+08');
  const before=await metrics();assert.equal(before.registration_first_comment_7d.numerator,1);assert.equal(before.first_share_return_7d.numerator,1);
  await pool.query('UPDATE community_social_posts SET state=$2 WHERE post_id=$1',[parent,state]);
  const after=await metrics();assert.equal(after.registration_first_comment_7d.numerator,0);assert.deepEqual([after.first_share_return_7d.numerator,after.first_share_return_7d.denominator],[0,1]);
});

test('registration cohort counts only registered, non-test members whose 7-day window has elapsed and keeps the Taipei day boundary', async () => {
  // 10 cohort members; the last registers at 2026-10-05T23:59+08 and is inside the range.
  const cohort = await many(MIN_SAMPLE, i => member({ at: i === MIN_SAMPLE - 1 ? '2026-10-05T23:59:00+08' : '2026-10-02T10:00:00+08' }));
  await member({ at: '2026-10-06T00:00:00+08' });                 // next Taipei day: outside range
  await member({ at: '2026-10-02T10:00:00+08', source: 'launch_day' }); // backfilled joining date
  await member({ at: '2026-10-02T10:00:00+08', test: true });      // test account
  await post(cohort[0], '2026-10-04T10:00:00+08');                 // within 7 days
  const late = await post(cohort[1], '2026-10-10T10:00:01+08');    // after 7 days: not counted
  await post(cohort[2], '2026-10-03T10:00:00+08'); await post(cohort[2], '2026-10-03T11:00:00+08', 'active'); // a retry/duplicate is still one member
  const removed = await post(cohort[3], '2026-10-03T10:00:00+08', 'deleted'); void removed;
  await comment(late, cohort[4], '2026-10-03T12:00:00+08');
  const result = (await metrics()).registration_first_share_7d;
  assert.deepEqual([result.numerator, result.denominator, result.pending_window, result.excluded_test_accounts], [2, 10, 0, 1]);
  assert.equal(result.rate, 0.2);
  assert.equal((await metrics()).registration_first_comment_7d.numerator, 1);
});

test('windows not yet elapsed are pending and a small sample reports no percentage', async () => {
  await many(3, () => member({ at: '2026-10-05T10:00:00+08' }));
  const small = await participationMetrics(pool, { community_id: DEMO_COMMUNITY }, range, new Date('2026-10-08T00:00:00+08:00'));
  const metric = small.metrics.registration_first_share_7d;
  assert.deepEqual([metric.denominator, metric.pending_window, metric.rate, metric.status], [0, 3, null, 'insufficient_sample']);
});

test('48-hour human reply ignores the author, test accounts, inactive members, other communities and removed comments', async () => {
  const authors = await many(MIN_SAMPLE, () => member({ at: '2026-09-01T00:00:00+08', source: 'launch_day' }));
  const responder = await member({ at: '2026-09-01T00:00:00+08', source: 'launch_day' });
  const bot = await member({ at: '2026-09-01T00:00:00+08', source: 'launch_day', test: true });
  const gone = await member({ at: '2026-09-01T00:00:00+08', source: 'launch_day', active: false });
  const outsider = await member({ at: '2026-09-01T00:00:00+08', source: 'launch_day', community: randomUUID() });
  const at = '2026-10-02T10:00:00+08';
  const posts = await many(MIN_SAMPLE, i => post(authors[i], at));
  await comment(posts[0], responder, '2026-10-03T09:59:59+08');   // inside 48h: counts
  await comment(posts[1], responder, '2026-10-04T10:00:01+08');   // just outside 48h
  await comment(posts[2], authors[2], '2026-10-02T11:00:00+08');  // author replying to themselves
  await comment(posts[3], bot, '2026-10-02T11:00:00+08');         // test account
  await comment(posts[4], gone, '2026-10-02T11:00:00+08');        // inactive member
  await comment(posts[5], responder, '2026-10-02T11:00:00+08', 'deleted'); // removed
  await pool.query('UPDATE community_social_comments SET community_id=community_id WHERE false');
  await comment(posts[6], responder, '2026-10-02T09:00:00+08');   // before the post
  void outsider;
  const result = (await metrics()).post_human_reply_48h;
  assert.deepEqual([result.numerator, result.denominator, result.pending_window], [1, 10, 0]);
  // Another community's administrator sees none of it.
  const other = await metrics(randomUUID());
  assert.deepEqual([other.post_human_reply_48h.denominator, other.post_human_reply_48h.rate], [0, null]);
});

test('participation return requires a durable event on a later Taipei day within 7 days', async () => {
  const sharers = await many(MIN_SAMPLE, () => member({ at: '2026-09-01T00:00:00+08', source: 'launch_day' }));
  await many(MIN_SAMPLE, i => post(sharers[i], '2026-10-02T23:30:00+08'));
  await post(sharers[0], '2026-10-03T00:10:00+08'); // next Taipei day, inside window
  await post(sharers[1], '2026-10-02T23:50:00+08'); // same day
  await post(sharers[2], '2026-10-09T23:31:00+08'); // after 7 days
  const result = (await metrics()).first_share_return_7d;
  assert.deepEqual([result.numerator, result.denominator], [1, 10]);
});

test('day-2 return survives day-8 activity in the same session when recomputing a full window', async () => {
  const sharer = await member({ at: '2026-09-01T00:00:00+08', source: 'launch_day' });
  const first = await post(sharer, '2026-10-02T10:00:00+08');
  const token = randomUUID();
  await pool.query(`INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at,created_at,last_seen_at)
    VALUES($1,$2,'csrf','2026-11-01T00:00:00+08','2026-10-02T10:00:00+08','2026-10-04T10:00:00+08')`, [token, sharer.id]);
  await comment(first, sharer, '2026-10-04T10:00:00+08');
  const before = (await metrics()).first_share_return_7d;
  assert.deepEqual([before.numerator, before.denominator], [1, 1]);
  await pool.query('UPDATE sessions SET last_seen_at=$2 WHERE token_hash=$1', [token, '2026-10-10T10:00:00+08']);
  await comment(first, sharer, '2026-10-10T10:00:00+08');
  assert.deepEqual((await metrics()).first_share_return_7d, before);
  await pool.query('DELETE FROM sessions WHERE token_hash=$1', [token]);
  assert.deepEqual((await metrics()).first_share_return_7d, before);
});

test('search signals keep no query text, count zero-result reads and only the owner can mark a result opened', async () => {
  const verificationEmail = 'metrics-maker@example.invalid';
  await pool.query('UPDATE users SET email=$1 WHERE user_id=$2', [verificationEmail, DEMO_USERS[0].user_id]);
  const app = createApp(pool, origin, 'local', { communitySearchEnabled: true, participationMetricsEnabled: true });
  const login = await app.request(origin + '/api/v1/auth/login', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: verificationEmail, password: 'freedom-local-demo' }) });
  const csrf = (await login.json() as { csrf_token: string }).csrf_token, cookie = login.headers.get('set-cookie')!.split(';')[0];
  const get = (q: string) => app.request(origin + '/api/v1/community-search?' + q, { headers: { Cookie: cookie } });
  const empty = await (await get('q=' + encodeURIComponent('絕對不存在的敏感詞彙'))).json() as { items: unknown[]; operation_id: string };
  assert.equal(empty.items.length, 0);
  const found = await (await get('q=' + encodeURIComponent('技能'))).json() as { items: { kind: string }[]; operation_id: string };
  assert.ok(found.items.length > 0);
  const columns = (await pool.query("SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name='community_search_operations'", [schema])).rows.map(r => r.column_name);
  assert.ok(!columns.some(name => /query|text|term|title/.test(name)));
  assert.equal(JSON.stringify((await pool.query('SELECT * FROM community_search_operations')).rows).includes('敏感'), false);
  const open = (id: string, headers: Record<string, string>) => app.request(`${origin}/api/v1/community-search/operations/${id}/open`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ kind: found.items[0]!.kind }) });
  assert.equal((await open(empty.operation_id, { Cookie: cookie, 'X-CSRF-Token': csrf })).status, 404); // nothing to open
  const other = await app.request(origin + '/api/v1/auth/login', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: DEMO_USERS[1].email, password: 'freedom-local-demo' }) });
  const otherCsrf = (await other.json() as { csrf_token: string }).csrf_token;
  assert.equal((await open(found.operation_id, { Cookie: other.headers.get('set-cookie')!.split(';')[0], 'X-CSRF-Token': otherCsrf })).status, 404);
  assert.equal((await open(found.operation_id, { Cookie: cookie, 'X-CSRF-Token': csrf })).status, 200);
  assert.equal((await open(found.operation_id, { Cookie: cookie, 'X-CSRF-Token': csrf })).status, 200); // repeat is a no-op
  const rows = (await pool.query('SELECT result_count>0 AS has, opened_at IS NOT NULL AS opened FROM community_search_operations ORDER BY searched_at')).rows;
  assert.deepEqual(rows, [{ has: false, opened: false }, { has: true, opened: true }]);
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date());
  const m = (await participationMetrics(pool, { community_id: DEMO_COMMUNITY }, { from: today, to: today })).metrics;
  assert.deepEqual([m.search_zero_result.numerator, m.search_zero_result.denominator, m.search_open.numerator, m.search_open.denominator], [0, 0, 0, 0]); // explicit verification accounts remain recorded but are excluded from the report
  assert.equal(m.search_zero_result.excluded_test_accounts, 1);
  assert.equal(m.search_zero_result.excluded_search_reads, 2);
  assert.equal(m.search_open.excluded_search_reads, 1);
  assert.equal(m.search_zero_result.rate, null); // below the minimum sample: no fake percentage
  assert.equal('moderation_case_time' in m, false);
  assert.deepEqual([m.moderation_first_handling_48h.status, m.moderation_first_handling_48h.median_hours, m.moderation_close_7d.status, m.moderation_close_7d.median_hours], ['insufficient_sample', null, 'insufficient_sample', null]);
  assert.deepEqual(m.repeat_abuse, { status: 'not_available', reason: 'repeat abuse is not yet defined' });
});

test('historical synthetic searches cannot satisfy the sample floor or alter real search rates', async () => {
  const synthetic = await member({ at: '2026-09-01T00:00:00+08', test: true });
  const real = await member({ at: '2026-09-01T00:00:00+08' });
  async function searches(user: { id: string; community: string }, count: number, results: number, opened: boolean) {
    await pool.query(`INSERT INTO community_search_operations(community_id,user_id,searched_at,first_page,result_count,opened_at,opened_kind)
      SELECT $1,$2,'2026-10-02T12:00:00+08'::timestamptz,true,$3,
        CASE WHEN $4 THEN '2026-10-02T12:01:00+08'::timestamptz END,
        CASE WHEN $4 THEN 'post' END FROM generate_series(1,$5::int)`, [user.community, user.id, results, opened, count]);
  }
  // Pre-existing rows must be excluded at report time, not only at collection time.
  await searches(synthetic, MIN_SAMPLE, 0, false);
  await searches(synthetic, MIN_SAMPLE, 1, true);
  const syntheticOnly = await metrics();
  for (const value of [syntheticOnly.search_zero_result, syntheticOnly.search_open]) {
    assert.deepEqual([value.numerator, value.denominator, value.rate, value.status], [0, 0, null, 'insufficient_sample']);
  }
  await searches(real, 1, 1, false);
  const small = await metrics();
  for (const value of [small.search_zero_result, small.search_open]) {
    assert.deepEqual([value.numerator, value.denominator, value.rate, value.status], [0, 1, null, 'insufficient_sample']);
  }
  await searches(real, 9, 1, true);
  await searches(real, 10, 0, false);
  const mixed = await metrics();
  assert.deepEqual([mixed.search_zero_result.numerator, mixed.search_zero_result.denominator, mixed.search_zero_result.rate], [10, 20, 0.5]);
  assert.deepEqual([mixed.search_open.numerator, mixed.search_open.denominator, mixed.search_open.rate], [9, 10, 0.9]);
  assert.deepEqual([mixed.search_zero_result.excluded_test_accounts, mixed.search_zero_result.excluded_search_reads], [1, 20]);
  assert.deepEqual([mixed.search_open.excluded_test_accounts, mixed.search_open.excluded_search_reads], [1, 10]);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM community_search_operations')).rows[0].n, 40);
});

test('the report needs a verified platform admin, is flag-gated and only reads the admin own community', async () => {
  const issuer = 'https://metrics-test.cloudflareaccess.com', audience = 'metrics-tests', pair = await generateKeyPair('RS256');
  const jwk = await exportJWK(pair.publicKey);
  const verifier = createAdminAccessVerifier({ issuer, audience, csrfSecret: 'metrics-test-csrf-secret-1234567890', keySet: createLocalJWKSet({ keys: [{ ...jwk, kid: 'metrics', alg: 'RS256' }] }) });
  const sign = (email: string) => { const now = Math.floor(Date.now() / 1000); return new SignJWT({ type: 'app', email, sub: 'verified-' + email, iss: issuer, aud: audience, iat: now, nbf: now, exp: now + 600 }).setProtectedHeader({ alg: 'RS256', kid: 'metrics' }).sign(pair.privateKey); };
  const on = createApp(pool, origin, 'local', { participationMetricsEnabled: true, adminVerifier: verifier });
  const off = createApp(pool, origin, 'local', { adminVerifier: verifier });
  const email = 'metrics-admin@example.test';
  await pool.query('INSERT INTO platform_admins(admin_id,community_id,email,display_name) VALUES($1,$2,$3,$4)', [randomUUID(), DEMO_COMMUNITY, email, '指標管理員']);
  const read = async (app: ReturnType<typeof createApp>, who: string | null, query = 'from=2026-10-01&to=2026-10-05') => app.request(origin + '/admin/api/participation-metrics?' + query, { headers: { Origin: origin, ...(who ? { 'Cf-Access-Jwt-Assertion': await sign(who) } : {}) } });
  assert.equal((await read(on, null)).status === 200, false);
  assert.equal((await read(on, 'stranger@example.test')).status, 403); // verified identity that is not a platform admin
  assert.equal((await read(off, email)).status, 404);                 // flag off: the route does not exist
  assert.equal((await read(off, null)).status, 404); // before authentication
  const offSearch=createApp(pool,origin,'local',{communitySearchEnabled:true});
  assert.equal((await offSearch.request(origin+'/api/v1/community-search/operations/'+randomUUID()+'/open',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:'{"kind":"post"}'})).status,404);
  for (const day of ['2026-02-30','2025-02-29','1900-02-29','2026-04-31','2026-13-01','0000-01-01']) {
    assert.equal((await read(on, email, `from=${day}&to=${day}`)).status, 422, day);
  }
  for (const day of ['2024-02-29','2000-02-29','2026-04-30','0001-01-01']) {
    assert.equal((await read(on, email, `from=${day}&to=${day}`)).status, 200, day);
  }
  const ok = await read(on, email);
  assert.equal(ok.status, 200); assert.equal(ok.headers.get('cache-control'), 'no-store');
  const body = await ok.json() as { community_id: string; definition: { version: string }; metrics: Record<string, { status: string }> };
  assert.equal(body.community_id, DEMO_COMMUNITY); assert.equal(body.definition.version, 'participation-metrics/v3');
  assert.equal(body.metrics.registration_first_share_7d!.status, 'insufficient_sample'); // no data: no percentage
  await assert.rejects(participationMetrics(pool, { community_id: DEMO_COMMUNITY }, { from: '2026-10-05', to: '2026-10-01' }));
  await assert.rejects(participationMetrics(pool, { community_id: DEMO_COMMUNITY }, { from: '2020-01-01', to: '2026-10-01' }));
});

test('moderation windows count elapsed cases from the transition journal and keep the Taipei day boundary', async () => {
  const wide = { from: '2026-10-01', to: '2026-10-18' };
  const handled = await member({ at: '2026-09-01T00:00:00+08' });
  const late = await member({ at: '2026-09-01T00:00:00+08' });
  const untouched = await member({ at: '2026-09-01T00:00:00+08' });
  const young = await member({ at: '2026-09-01T00:00:00+08' });
  const openWeek = await member({ at: '2026-09-01T00:00:00+08' });
  const edge = await member({ at: '2026-09-01T00:00:00+08' });
  const after = await member({ at: '2026-09-01T00:00:00+08' });
  const tester = await member({ at: '2026-09-01T00:00:00+08', test: true });
  const outsider = await member({ at: '2026-09-01T00:00:00+08', community: randomUUID() });
  // Exactly 48h counts; a later in_progress row must not replace the first one.
  await memberReport(handled, '2026-10-02T10:00:00+08', [
    { at: '2026-10-04T10:00:00+08', state: 'in_progress' },
    { at: '2026-10-04T22:00:00+08', state: 'in_progress' },
    { at: '2026-10-04T10:00:00+08', state: 'closed' },
  ]);
  // A receive row is not a transition. 48h+1s and day 8 stay in the denominator only.
  await memberReport(late, '2026-10-02T11:00:00+08', [
    { at: '2026-10-02T12:00:00+08', state: 'in_progress', command: 'receive' },
    { at: '2026-10-04T12:00:01+08', state: 'in_progress' },
    { at: '2026-10-10T11:00:00+08', state: 'closed' },
  ]);
  await memberReport(untouched, '2026-10-02T12:00:00+08');
  // Younger than 48h, so pending for both windows even though it was already closed.
  await memberReport(young, '2026-10-18T20:00:00+08', [
    { at: '2026-10-18T20:30:00+08', state: 'in_progress' },
    { at: '2026-10-18T21:00:00+08', state: 'closed' },
  ]);
  // 48h has elapsed; the 7-day close window has not.
  await memberReport(openWeek, '2026-10-16T10:00:00+08', [
    { at: '2026-10-17T09:00:00+08', state: 'in_progress' },
  ]);
  await memberReport(edge, '2026-10-18T23:30:00+08');
  await memberReport(after, '2026-10-19T00:30:00+08');
  await memberReport(tester, '2026-10-02T13:00:00+08', [
    { at: '2026-10-02T14:00:00+08', state: 'in_progress' },
    { at: '2026-10-03T13:00:00+08', state: 'closed' },
  ]);
  await memberReport(tester, '2026-10-02T14:00:00+08', [
    { at: '2026-10-02T15:00:00+08', state: 'in_progress' },
    { at: '2026-10-03T14:00:00+08', state: 'closed' },
  ]);
  await memberReport(outsider, '2026-10-02T10:00:00+08', [
    { at: '2026-10-02T11:00:00+08', state: 'in_progress' },
    { at: '2026-10-03T10:00:00+08', state: 'closed' },
  ]);
  const full = await participationMetrics(pool, { community_id: DEMO_COMMUNITY }, wide, NOW);
  assert.equal(JSON.stringify(full).includes(REPORT_TEXT), false);
  const value = full.metrics;
  assert.deepEqual([value.moderation_first_handling_48h.numerator, value.moderation_first_handling_48h.denominator, value.moderation_first_handling_48h.pending_window, value.moderation_first_handling_48h.excluded_test_accounts], [2, 4, 2, 1]);
  assert.deepEqual([value.moderation_close_7d.numerator, value.moderation_close_7d.denominator, value.moderation_close_7d.pending_window, value.moderation_close_7d.excluded_test_accounts], [1, 3, 3, 1]);
  assert.equal(value.moderation_first_handling_48h.rate, null);
  assert.equal(value.moderation_close_7d.median_hours, null);
  assert.deepEqual(value.repeat_abuse, { status: 'not_available', reason: 'repeat abuse is not yet defined' });
  const other = await metrics(outsider.community, wide);
  assert.deepEqual([other.moderation_first_handling_48h.numerator, other.moderation_first_handling_48h.denominator, other.moderation_first_handling_48h.pending_window, other.moderation_first_handling_48h.excluded_test_accounts], [1, 1, 0, 0]);
  assert.deepEqual([other.moderation_close_7d.numerator, other.moderation_close_7d.denominator, other.moderation_close_7d.pending_window], [1, 1, 0]);
});

test('moderation rate and median stay null below the sample floor', async () => {
  const people = await many(3, () => member({ at: '2026-09-01T00:00:00+08' }));
  for (const person of people) await memberReport(person, '2026-10-02T10:00:00+08', [
    { at: '2026-10-02T12:00:00+08', state: 'in_progress' },
    { at: '2026-10-03T10:00:00+08', state: 'closed' },
  ]);
  const value = await metrics();
  for (const metric of [value.moderation_first_handling_48h, value.moderation_close_7d]) {
    assert.deepEqual([metric.numerator, metric.denominator, metric.pending_window, metric.rate, metric.status, metric.median_hours], [3, 3, 0, null, 'insufficient_sample', null]);
  }
});

test('moderation rate and median are exact once the sample floor is met', async () => {
  const people = await many(12, () => member({ at: '2026-09-01T00:00:00+08' }));
  const receipt = '2026-10-02T10:00:00+08';
  const plus = (hours: number) => new Date(Date.parse('2026-10-02T02:00:00Z') + hours * 3_600_000).toISOString();
  for (let i = 0; i < people.length; i++) {
    const events: { at: string; state: 'in_progress' | 'closed' }[] = [];
    if (i < 10) events.push({ at: plus(i + 1), state: 'in_progress' }, { at: plus(10 + i), state: 'closed' });
    else if (i === 10) events.push({ at: plus(49), state: 'in_progress' }, { at: plus(50), state: 'closed' });
    await memberReport(people[i]!, receipt, events);
  }
  const value = await metrics();
  const handling = value.moderation_first_handling_48h;
  // 10 of 12 elapsed cases. Hours 1..10: percentile_cont(0.5) is halfway between 5 and 6.
  assert.deepEqual([handling.numerator, handling.denominator, handling.pending_window, handling.excluded_test_accounts, handling.status], [10, 12, 0, 0, 'ok']);
  assert.equal(handling.rate, 0.8333);
  assert.equal(handling.median_hours, 5.5);
  const closed = value.moderation_close_7d;
  // 11 of 12. Hours 10..19 and 50: the 6th of 11 ordered values is 15.
  assert.deepEqual([closed.numerator, closed.denominator, closed.pending_window, closed.excluded_test_accounts, closed.status], [11, 12, 0, 0, 'ok']);
  assert.equal(closed.rate, 0.9167);
  assert.equal(closed.median_hours, 15);
});
