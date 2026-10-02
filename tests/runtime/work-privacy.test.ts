import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { migrate } from '../../scripts/database.js';
import { createPool, digest } from '../../packages/db/index.js';
import { tokenHash, type Actor } from '../../modules/identity-membership/service.js';
import { withMemberScope } from '../../packages/resource-scopes/index.js';
import { createApp } from '../../apps/platform-api/src/app.js';
import { createWork, claimWork, changeClaim } from '../../modules/opportunity-project-work/work.js';
import { listPrivateWork, readPrivateWork } from '../../modules/opportunity-project-work/private-work.js';
import { Problem } from '../../packages/shared/problem.js';

// Unlike legacy suites, this new suite refuses an implicit developer database.
const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) throw new Error('WORK-A tests require explicit isolated TEST_DATABASE_URL.');
const schema = `fp_work_privacy_${process.pid}_${Date.now()}`;
const admin = createPool(connectionString), pool = new Pool({ connectionString, options: `-c search_path=${schema} -c statement_timeout=10000`, max: 12 });
const origin = 'http://127.0.0.1:4310', app = createApp(pool, origin);
const community = randomUUID(), otherCommunity = randomUUID();
let initialized = false;
type Member = Actor & { cookie: string };
before(async () => { await admin.query(`CREATE SCHEMA ${schema}`); initialized = true; await migrate(pool); });
after(async () => { await pool.end(); if (initialized) await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
beforeEach(async () => {
  await pool.query('TRUNCATE communities CASCADE');
  await pool.query('INSERT INTO communities VALUES($1,$2),($3,$4)', [community, 'Synthetic A', otherCommunity, 'Synthetic B']);
});
async function member(communityId = community): Promise<Member> {
  const id = randomUUID(), token = randomBytes(32).toString('base64url');
  const row = (await pool.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref)
    VALUES($1,$2,$3,'Synthetic','not-a-login-hash',$4) RETURNING *`, [id, communityId, id + '@example.invalid', randomUUID()])).rows[0];
  const hash = tokenHash(token);
  await pool.query("INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at) VALUES($1,$2,'synthetic',now()+interval '1 hour')", [hash, id]);
  return { ...row, session_hash: hash, csrf_token: 'synthetic', cookie: 'freedom_local_session=' + token };
}
const command = (actor: Actor, body: unknown = {}, expected?: string, operation = 'synthetic', key = randomUUID()) => ({ actor, body, expected, operation, key });
async function privateRow(owner: Member, title = 'Private synthetic title') {
  const context = await withMemberScope(pool, { actor: owner, scope: 'personal' }, async () => {}, async (_q, context) => context);
  // DB-only synthetic fixture. There is no corresponding product write route.
  return (await pool.query(`INSERT INTO work_items(work_item_id,work_mode,scope_id,owner_principal_id,owner_ref,title,objective,state,participation_terms_revision)
    VALUES($1,'personal_execution',$2,$3,$4,$5,'Private synthetic objective','draft',NULL) RETURNING *`,
  [randomUUID(), context.scope.scope_id, context.subject_principal.principal_id, owner.user_id, title])).rows[0];
}
async function communityWork(owner: Member) {
  return createWork(pool, command(owner, { title: 'Community work', objective: 'Shared objective', acceptance_criteria: 'Shared criteria', gain: 'Voluntary public good',
    estimated_minutes: 10, maximum_minutes: 20, claim_by: new Date(Date.now() + 86400000).toISOString(), finish_by: new Date(Date.now() + 172800000).toISOString(), will_review: true }));
}
async function request(path: string, user?: Member, options: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  const method = options.method ?? (options.body === undefined ? 'GET' : 'POST');
  const response = await app.request(origin + '/api/v1' + path, { method, headers: {
    Origin: origin, ...(user ? { Cookie: user.cookie, 'X-CSRF-Token': user.csrf_token } : {}),
    ...(options.body !== undefined ? { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() } : {}), ...options.headers,
  }, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
  const text = await response.text();
  return { response, status: response.status, text, data: text && response.headers.get('Content-Type')?.includes('application/json') ? JSON.parse(text) : null };
}
const status = (code: number) => (error: unknown) => error instanceof Problem && error.status === code;
const sqlCode = (code: string) => (error: unknown) => (error as { code?: string })?.code === code;

test('WORK-A owner list/detail are bounded private DTOs; peer and cross-community IDs are indistinguishable from missing', async () => {
  const owner = await member(), peer = await member(), outside = await member(otherCommunity), row = await privateRow(owner);
  const listed = await request('/me/private-work', owner);
  assert.equal(listed.status, 200); assert.equal(listed.data.total, 1); assert.equal(listed.data.items[0].work_item_id, row.work_item_id);
  assert.equal(listed.response.headers.get('Cache-Control'), 'private, no-store');
  assert.deepEqual(Object.keys(listed.data.items[0]).sort(), ['aggregate_version', 'created_at', 'objective', 'state', 'title', 'work_item_id']);
  const detail = await request('/me/private-work/' + row.work_item_id, owner);
  assert.equal(detail.status, 200); assert.equal(detail.data.title, row.title);
  for (const denied of [peer, outside]) {
    const missing = await request('/me/private-work/' + randomUUID(), denied);
    assert.deepEqual((await request('/me/private-work/' + row.work_item_id, denied)).data, missing.data);
    const list = await request('/me/private-work?q=Private', denied);
    assert.equal(list.data.total, 0); assert.deepEqual(list.data.items, []);
  }
  assert.equal((await request('/me/private-work')).status, 401);
});

test('WORK-A search/count/pagination never include another owner and treat wildcard syntax literally', async () => {
  const owner = await member(), peer = await member();
  const own = [await privateRow(owner, 'first Shared'), await privateRow(owner, 'second Shared'), await privateRow(owner, '100%_literal')];
  await privateRow(peer, 'Shared secret');
  const first = await request('/me/private-work?q=shared&limit=1&offset=0', owner);
  const second = await request('/me/private-work?q=shared&limit=1&offset=1', owner);
  assert.equal(first.data.total, 2); assert.equal(second.data.total, 2);
  assert.notEqual(first.data.items[0].work_item_id, second.data.items[0].work_item_id);
  assert(first.data.items.every((item: any) => own.some(row => row.work_item_id === item.work_item_id)));
  const empty = await request('/me/private-work?q=shared&limit=1&offset=2', owner);
  assert.equal(empty.data.total, 2); assert.deepEqual(empty.data.items, []);
  assert.equal((await request('/me/private-work?q=%25_', owner)).data.total, 1);
  assert.equal((await request('/me/private-work?q=%27%20OR%20true--', owner)).data.total, 0);
});

test('WORK-A rejects caller ownership/scope, duplicate filters, invalid and oversized pagination', async () => {
  const owner = await member(), row = await privateRow(owner);
  for (const query of ['owner_ref=' + owner.user_id, 'scope_id=' + row.scope_id, 'owner_principal_id=' + row.owner_principal_id,
    'limit=51', 'limit=0', 'limit=-1', 'limit=2.5', 'offset=10001', 'offset=NaN', 'limit=1&limit=2', 'q=' + 'x'.repeat(121)]) {
    assert.equal((await request('/me/private-work?' + query, owner)).status, 422, query);
  }
  assert.equal((await request('/me/private-work/' + row.work_item_id + '?scope_id=' + row.scope_id, owner)).status, 422);
});

test('WORK-A private rows never change any legacy list/dashboard/discovery/feed/contribution projection', async () => {
  const owner = await member(), peer = await member(); await communityWork(owner);
  const paths = ['/work-items', '/dashboard', '/task-board/preview', '/me/contribution-records', '/community/accepted-work'];
  const before = await Promise.all(paths.map(path => request(path, peer)));
  const row = await privateRow(owner, 'UNIQUE_PRIVATE_SENTINEL');
  const after = await Promise.all(paths.map(path => request(path, peer)));
  for (let i = 0; i < paths.length; i++) {
    assert.equal(before[i].status, 200, paths[i]); assert.deepEqual(after[i].data, before[i].data, paths[i]);
    assert(!after[i].text.includes(row.work_item_id)); assert(!after[i].text.includes(row.title));
  }
  const old = (await request('/work-items', owner)).data.items[0];
  for (const column of ['work_mode', 'scope_id', 'scope_kind', 'owner_principal_id']) assert(!Object.hasOwn(old, column));
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM contributions')).rows[0].n, 0);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM work_claims')).rows[0].n, 0);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM outbox WHERE payload::text LIKE '%UNIQUE_PRIVATE_SENTINEL%'")).rows[0].n, 0);
});

test('WORK-A onboarding preview limit and legacy conditional/HEAD projections cannot reveal or displace private rows', async () => {
  const owner = await member(), peer = await member();
  for (let index = 0; index < 13; index++) await communityWork(owner);
  await pool.query('UPDATE users SET onboarding_required=true,onboarding_completed_at=NULL WHERE user_id=$1', [peer.user_id]);
  const before = await request('/task-board/preview', peer);
  assert.equal(before.status, 200); assert.equal(before.data.items.length, 12);
  const row = await privateRow(owner, 'PRIVATE_PREVIEW_SENTINEL');
  assert.deepEqual((await request('/task-board/preview', peer)).data, before.data);
  for (const path of ['/work-items', '/dashboard', '/task-board/preview', '/me/contribution-records', '/community/accepted-work']) {
    for (const method of ['GET', 'HEAD']) {
      const response = await request(path, owner, { method, headers: { Range: 'bytes=0-10', 'If-None-Match': '"1"' } });
      assert.equal(response.status, 200, path + ' ' + method); assert(!response.text.includes(row.title));
      assert(!response.text.includes(row.work_item_id)); assert.match(response.response.headers.get('Cache-Control') ?? '', /no-store/);
      if (method === 'HEAD') assert.equal(response.text, '');
    }
  }
});

test('WORK-A HEAD/Range/conditional requests authorize before returning metadata and never emit cached 304/206', async () => {
  const owner = await member(), peer = await member(), row = await privateRow(owner);
  for (const method of ['GET', 'HEAD']) {
    const options = { method, headers: { 'If-None-Match': '"1"', 'If-Modified-Since': 'Thu, 01 Jan 2099 00:00:00 GMT', Range: 'bytes=0-10' } };
    const allowed = await request('/me/private-work/' + row.work_item_id, owner, options);
    assert.equal(allowed.status, 200); assert.equal(allowed.response.headers.get('Cache-Control'), 'private, no-store');
    assert.equal(allowed.response.headers.get('ETag'), null); assert.equal(allowed.response.headers.get('Content-Range'), null);
    if (method === 'HEAD') assert.equal(allowed.text, '');
    const denied = await request('/me/private-work/' + row.work_item_id, peer, options);
    assert.equal(denied.status, 404); assert(!denied.text.includes(row.title));
  }
});

for (const revoke of ['session', 'expired', 'inactive', 'principal', 'scope'] as const) {
  test(`WORK-A current ${revoke} revocation defeats cached Actor, ID, and conditional HTTP read`, async () => {
    const owner = await member(), row = await privateRow(owner);
    assert.equal((await readPrivateWork(pool, owner, row.work_item_id)).title, row.title);
    if (revoke === 'session') await pool.query('UPDATE sessions SET revoked_at=now() WHERE token_hash=$1', [owner.session_hash]);
    if (revoke === 'expired') await pool.query("UPDATE sessions SET expires_at=now()-interval '1 second' WHERE token_hash=$1", [owner.session_hash]);
    if (revoke === 'inactive') await pool.query('UPDATE users SET active=false WHERE user_id=$1', [owner.user_id]);
    if (revoke === 'principal') await pool.query("UPDATE principals SET status='disabled' WHERE principal_id=$1", [row.owner_principal_id]);
    if (revoke === 'scope') await pool.query("UPDATE resource_scopes SET status='disabled' WHERE scope_id=$1", [row.scope_id]);
    const expected = revoke === 'principal' || revoke === 'scope' ? 403 : 401;
    await assert.rejects(readPrivateWork(pool, owner, row.work_item_id), status(expected));
    await assert.rejects(listPrivateWork(pool, owner, {}), status(expected));
    const response = await request('/me/private-work/' + row.work_item_id, owner, { headers: { 'If-None-Match': '"1"' } });
    assert.equal(response.status, expected); assert(!response.text.includes(row.title));
  });
}

test('WORK-A platform admin and guild officer membership never substitute for personal ownership', async () => {
  const owner = await member(), peer = await member(), row = await privateRow(owner);
  await pool.query("INSERT INTO platform_admins(admin_id,community_id,email,display_name,role) VALUES($1,$2,$3,'Synthetic admin','super_admin')", [randomUUID(), community, peer.email]);
  await pool.query("INSERT INTO positioning_guild_officers(community_id,guild_key,user_id) SELECT $1,guild_key,$2 FROM positioning_guild_catalog ORDER BY guild_key LIMIT 1", [community, peer.user_id]);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM positioning_guild_officers WHERE user_id=$1', [peer.user_id])).rows[0].n, 1);
  assert.equal((await request('/me/private-work/' + row.work_item_id, peer)).status, 404);
  assert.equal((await request('/me/private-work', peer)).data.total, 0);
});

test('WORK-A legacy claim and benefit mutations reject private IDs before replay; private writes/share/results remain absent', async () => {
  const owner = await member(), peer = await member(), row = await privateRow(owner);
  const body = { claimant_type: 'user', acting_profession_membership_ref: peer.profession_membership_ref, expected_aggregate_version: 1,
    terms_status: 'declared', participation_terms_revision: 1, participation_terms_sha256: 'a'.repeat(64) };
  const key = randomUUID(), operation = 'POST /api/v1/work-items/' + row.work_item_id + ':claim';
  // Adversarial stored receipt fixture: current domain ACL must win over replay.
  await pool.query('INSERT INTO command_receipts(user_id,operation,idempotency_key,request_sha256,response) VALUES($1,$2,$3,$4,$5)',
    [peer.user_id, operation, key, digest({ body, expected: '1' }), { title: row.title }]);
  await assert.rejects(claimWork(pool, command(peer, body, '1', operation, key), row.work_item_id), status(404));
  const benefit = { work_claim_ref: null, role: 'beneficiary', outcome: 'unconfirmed', actual_gain: null, evidence_refs: [], would_participate_again: null, effort_minutes: null, supersedes_observation_ref: null };
  assert.equal((await request('/work-items/' + row.work_item_id + '/benefit-observations', owner)).status, 404);
  assert.equal((await request('/work-items/' + row.work_item_id + '/benefit-observations', owner, { body: benefit, headers: { 'If-Match': '"1"' } })).status, 404);
  for (const path of ['/me/private-work', '/me/private-work/' + row.work_item_id, '/me/private-work/' + row.work_item_id + '/results', '/me/private-work/' + row.work_item_id + '/share']) {
    assert.equal((await request(path, owner, { body: {} })).status, 404, path);
  }
  for (const suffix of ['/results', '/export', '/share', '/events', '/assets', '/runs']) assert.equal((await request('/me/private-work/' + row.work_item_id + suffix, owner)).status, 404);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM work_benefit_observations')).rows[0].n, 0);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM transition_journal')).rows[0].n, 0);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM outbox')).rows[0].n, 0);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM command_receipts')).rows[0].n, 1);
});

test('WORK-A SQL constraints bind private user/principal/scope, forbid fake terms and service support', async () => {
  const owner = await member(), peer = await member(), a = await privateRow(owner), b = await privateRow(peer);
  const base = `INSERT INTO work_items(work_item_id,work_mode,scope_id,owner_principal_id,owner_ref,title,objective,state,participation_terms_revision)
    VALUES($1,$2,$3,$4,$5,'Synthetic','Synthetic','draft',NULL)`;
  for (const [work_mode, scope, principal, user, code] of [
    ['personal_execution', b.scope_id, a.owner_principal_id, owner.user_id, '23503'],
    ['personal_execution', a.scope_id, a.owner_principal_id, peer.user_id, '23503'],
    ['personal_execution', null, a.owner_principal_id, owner.user_id, '23514'],
    ['personal_execution', a.scope_id, null, owner.user_id, '23514'],
    ['service_operation', a.scope_id, a.owner_principal_id, owner.user_id, '23514'],
  ]) await assert.rejects(pool.query(base, [randomUUID(), work_mode, scope, principal, user]), sqlCode(code!));
  await assert.rejects(pool.query("UPDATE work_items SET participation_terms='{}' WHERE work_item_id=$1", [a.work_item_id]), sqlCode('23514'));
  await assert.rejects(pool.query("UPDATE work_items SET state='accepted' WHERE work_item_id=$1", [a.work_item_id]), sqlCode('23514'));
  await assert.rejects(pool.query('UPDATE work_items SET scope_id=$2 WHERE work_item_id=$1', [a.work_item_id, b.scope_id]), sqlCode('23514'));
  await assert.rejects(pool.query('UPDATE work_items SET owner_principal_id=$2,owner_ref=$3,scope_id=$4 WHERE work_item_id=$1', [a.work_item_id, b.owner_principal_id, peer.user_id, b.scope_id]), sqlCode('23514'));
  await assert.rejects(pool.query("UPDATE work_items SET work_mode='community_collaboration' WHERE work_item_id=$1", [a.work_item_id]), sqlCode('23514'));
  await assert.rejects(pool.query('DELETE FROM work_items WHERE work_item_id=$1', [a.work_item_id]), sqlCode('23514'));
  const old = await communityWork(owner);
  await assert.rejects(pool.query('DELETE FROM work_items WHERE work_item_id=$1', [old.work_item_id]), sqlCode('23514'));
  await assert.rejects(pool.query('UPDATE work_items SET work_item_id=$2 WHERE work_item_id=$1', [old.work_item_id, randomUUID()]), sqlCode('23514'));
  await assert.rejects(pool.query('UPDATE work_items SET scope_id=$2 WHERE work_item_id=$1', [old.work_item_id, a.scope_id]), sqlCode('23503'));
  const outside = await member(otherCommunity);
  const outsideScope = await withMemberScope(pool, { actor: outside, scope: 'community' }, async () => {}, async (_q, context) => context.scope);
  await assert.rejects(pool.query('UPDATE work_items SET scope_id=$2 WHERE work_item_id=$1', [old.work_item_id, outsideScope.scope_id]), sqlCode('23503'));
  const ownScope = await withMemberScope(pool, { actor: owner, scope: 'community' }, async () => {}, async (_q, context) => context.scope);
  await pool.query('UPDATE work_items SET scope_id=$2 WHERE work_item_id=$1', [old.work_item_id, ownScope.scope_id]);
  await assert.rejects(pool.query('UPDATE work_items SET scope_id=NULL WHERE work_item_id=$1', [old.work_item_id]), sqlCode('23514'));
});

test('WORK-A version projection remains exact and rejects HTTP bigint overflow rather than rounding', async () => {
  const owner = await member(), row = await privateRow(owner), version = '9007199254740993';
  await pool.query('UPDATE work_items SET aggregate_version=$2 WHERE work_item_id=$1', [row.work_item_id, version]);
  assert.equal((await readPrivateWork(pool, owner, row.work_item_id)).aggregate_version, version);
  assert.equal((await listPrivateWork(pool, owner, {})).items[0].aggregate_version, version);
  for (const path of ['/me/private-work', '/me/private-work/' + row.work_item_id]) {
    const response = await request(path, owner);
    assert.equal(response.status, 500); assert.equal(response.data.code, 'version_overflow');
    assert(!response.text.includes(row.title));
  }
});

test('WORK-A committed scope revocation wins over an in-flight read waiting for current authority', async () => {
  const owner = await member(), row = await privateRow(owner), locker = await pool.connect();
  let read: Promise<void> | undefined;
  try {
    await locker.query('BEGIN');
    const pid = (await locker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    await locker.query("UPDATE resource_scopes SET status='disabled' WHERE scope_id=$1", [row.scope_id]);
    read = assert.rejects(readPrivateWork(pool, owner, row.work_item_id), status(403));
    let blocked = false;
    for (let attempt = 0; attempt < 200; attempt++) {
      blocked = (await admin.query('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) AS blocked', [pid])).rows[0].blocked;
      if (blocked) break;
      await delay(10);
    }
    assert(blocked, 'The read must actually wait for the revocation transaction before COMMIT.');
    await locker.query('COMMIT'); await read;
  } finally { await locker.query('ROLLBACK'); locker.release(); await read?.catch(() => {}); }
});

test('WORK-A SQL forbids private claims, review routes, contribution and benefit facts', async () => {
  const owner = await member(), peer = await member(), row = await privateRow(owner);
  await assert.rejects(pool.query(`INSERT INTO work_claims(claim_id,work_item_id,claimant_ref,acting_profession_membership_ref,state,terms_revision,terms_sha256,terms_snapshot)
    VALUES($1,$2,$3,$4,'claimed',1,$5,'{}')`, [randomUUID(), row.work_item_id, peer.user_id, peer.profession_membership_ref, 'a'.repeat(64)]), sqlCode('23503'));
  await assert.rejects(pool.query("INSERT INTO work_review_routes(work_item_id,reviewer_ref,valid_until) VALUES($1,$2,now()+interval '1 day')", [row.work_item_id, peer.user_id]), sqlCode('23503'));
  await assert.rejects(pool.query(`INSERT INTO work_benefit_observations(observation_id,community_id,work_item_ref,reporter_principal_ref,role,observation_revision,report)
    VALUES($1,$2,$3,$4,'beneficiary',1,'{}')`, [randomUUID(), community, row.work_item_id, owner.user_id]), sqlCode('23503'));
  // Use genuine accepted community foreign keys, so only the private-work FK
  // rejects an attempted contribution (not an unrelated missing-row error).
  const work = await communityWork(owner);
  let claim: any = await claimWork(pool, command(peer, { claimant_type: 'user', acting_profession_membership_ref: peer.profession_membership_ref,
    expected_aggregate_version: 1, terms_status: 'declared', participation_terms_revision: 1, participation_terms_sha256: work.participation_terms_sha256 }, '1'), work.work_item_id);
  claim = await changeClaim(pool, command(peer, {}, String(claim.aggregate_version)), claim.claim_id, 'start');
  claim = await changeClaim(pool, command(peer, { summary: 'Synthetic result', artifact_ref: 'artifact:synthetic' }, String(claim.aggregate_version)), claim.claim_id, 'submit');
  claim = await changeClaim(pool, command(owner, {}, String(claim.aggregate_version)), claim.claim_id, 'begin-review');
  await changeClaim(pool, command(owner, { decision: 'accept', feedback: 'Synthetic acceptance', submission_sha256: claim.latest_submission.sha256 }, String(claim.aggregate_version)), claim.claim_id, 'decide');
  const contribution = (await pool.query('SELECT * FROM contributions')).rows[0];
  await assert.rejects(pool.query('UPDATE contributions SET work_item_id=$2 WHERE contribution_id=$1', [contribution.contribution_id, row.work_item_id]), sqlCode('23503'));
});

test('WORK-A surface inventory has only member reads; no private publication/event/export/execution registration', async () => {
  const source = await readFile(new URL('../../apps/platform-api/src/routes/private-work.ts', import.meta.url), 'utf8');
  assert.equal((source.match(/app\.get\(/g) ?? []).length, 2);
  assert(!/app\.(post|put|patch|delete)\(/.test(source));
  assert(!source.includes('journal(')); assert(!source.includes('outbox'));
  const domain = await readFile(new URL('../../modules/opportunity-project-work/private-work.ts', import.meta.url), 'utf8');
  assert(!/\b(journal|command)\s*\(|\b(INSERT|UPDATE|DELETE)\s+(INTO|FROM|work_items)\b/i.test(domain));
});
