import {test, before, after, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {createLocalJWKSet, exportJWK, generateKeyPair, SignJWT} from 'jose';
import {createPool, LOCAL_DATABASE_URL} from '../../packages/db/index.js';
import {migrate} from '../../scripts/database.js';
import {seedLocal, DEMO_USERS, DEMO_PASSWORD, DEMO_COMMUNITY} from '../../packages/testing/seed.js';
import {communityCatalog} from '../../modules/community/catalog.js';
import {githubCoordinate} from '../../modules/opensource-marketing/github.js';
import {PUBLIC_AUTHOR_CLAIM_SQL} from '../../modules/community/repo-author-claims.js';
import {createApp} from '../../apps/platform-api/src/app.js';
import {createAdminAccessVerifier} from '../../modules/platform-admin/access.js';

const origin = 'http://127.0.0.1:4310';
const databaseUrl = process.env.TEST_DATABASE_URL ?? LOCAL_DATABASE_URL;
const schema = `fp_repo_claims_${process.pid}_${Date.now()}`;
const database = createPool(databaseUrl);
const pool = new Pool({connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 12});
const issuer = 'https://test-team.cloudflareaccess.com';
const audience = 'repo-claim-tests';
const email = 'admin@example.invalid';
const adminId = randomUUID();
const pair = await generateKeyPair('RS256');
const jwk = await exportJWK(pair.publicKey);
const verifier = createAdminAccessVerifier({issuer, audience, csrfSecret: 'test-fixture-admin-csrf-secret-123456789', keySet: createLocalJWKSet({keys: [{...jwk, kid: 'claim-test', alg: 'RS256'}]})});
const SECRET = '秘密聲明只有本人看得到甲乙丙';
const OTHER_SECRET = '另一份聲明不該出現在公開頁面甲乙丙';
const EVIDENCE = 'https://evidence.example/secret-claim-note';
const PRIVATE_KEYS = ['evidence_url', 'statement', 'reason', 'email', 'reviewed_by', 'user_id', 'appeal_text', 'github_user_id'];

type RepoSpec = {id: number; full_name?: string; private?: boolean; visibility?: string; fork?: boolean; source?: {id?: number; full_name?: string}; omitVisibility?: boolean} | 'down' | 'limited';
const github = {calls: [] as string[], repos: new Map<string, RepoSpec>()};
const fetcher: typeof fetch = async input => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
  if (url.origin !== 'https://api.github.com') throw new Error('unexpected host ' + url.origin);
  github.calls.push(url.pathname);
  const spec = github.repos.get(url.pathname);
  if (!spec) return new Response('missing', {status: 404});
  if (spec === 'down') return new Response('down', {status: 503});
  if (spec === 'limited') return new Response('limited', {status: 429});
  const fullName = spec.full_name ?? url.pathname.slice('/repos/'.length);
  const body: Record<string, unknown> = {id: spec.id, full_name: fullName, private: spec.private ?? false, fork: spec.fork ?? false};
  if (!spec.omitVisibility) body.visibility = spec.visibility ?? 'public';
  if (spec.source) body.source = spec.source;
  return Response.json(body);
};
let app = createApp(pool, origin, 'local', {adminVerifier: verifier, githubSocial: {fetcher}});
let jwt = '';
let csrf = '';

before(async () => { await database.query(`CREATE SCHEMA ${schema}`); await migrate(pool); });
after(async () => { await pool.end(); await database.query(`DROP SCHEMA ${schema} CASCADE`); await database.end(); });
beforeEach(async () => {
  github.calls.length = 0;
  github.repos.clear();
  await pool.query('TRUNCATE repo_credit_claim_events, catalog_repo_identity_events, repo_credit_claims, catalog_repo_observations, canonical_repositories, communities, login_attempts, auth_rate_limits CASCADE');
  await seedLocal(pool);
  await pool.query('INSERT INTO platform_admins(admin_id,community_id,email,display_name) VALUES($1,$2,$3,$4)', [adminId, DEMO_COMMUNITY, email, '認領審核員']);
  app = createApp(pool, origin, 'local', {adminVerifier: verifier, githubSocial: {fetcher}});
  jwt = await sign(email);
  csrf = (await verifier(new Request(origin, {headers: {'Cf-Access-Jwt-Assertion': jwt}}))).csrfToken;
});

async function sign(claimedEmail: string) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({type: 'app', email: claimedEmail, sub: 'verified-human-fixture', iss: issuer, aud: audience, iat: now, nbf: now, exp: now + 600}).setProtectedHeader({alg: 'RS256', kid: 'claim-test'}).sign(pair.privateKey);
}
function coordinate(bookId: string) {
  const book = communityCatalog.skill_books.find(item => item.id === bookId);
  assert.ok(book, bookId);
  return githubCoordinate(book.upstream_url);
}
function arm(bookId: string, spec: RepoSpec) {
  const name = coordinate(bookId);
  github.repos.set('/repos/' + name, spec);
  return name;
}
async function login(user = DEMO_USERS[0]) {
  const response = await app.request(origin + '/api/v1/auth/login', {method: 'POST', headers: {Origin: origin, 'Content-Type': 'application/json'}, body: JSON.stringify({email: user.email, password: DEMO_PASSWORD})});
  const data = await response.json() as {csrf_token: string};
  assert.equal(response.status, 200, JSON.stringify(data));
  return {cookie: response.headers.get('set-cookie')!.split(';')[0], csrf: data.csrf_token, user};
}
async function link(user: {user_id: string}, githubUserId: string, loginName: string) {
  await pool.query('INSERT INTO github_social_connections(user_id,community_id,github_user_id,github_login,encrypted_tokens) VALUES($1,$2,$3,$4,$5)', [user.user_id, DEMO_COMMUNITY, githubUserId, loginName, 'not-a-token']);
}
async function member(path: string, session: {cookie: string; csrf: string}, body?: unknown, extra: {version?: number; key?: string; csrf?: string; origin?: string} = {}) {
  const headers: Record<string, string> = {Origin: extra.origin ?? origin, Cookie: session.cookie, 'Content-Type': 'application/json'};
  if (extra.csrf !== '') headers['X-CSRF-Token'] = extra.csrf ?? session.csrf;
  if (body !== undefined) headers['Idempotency-Key'] = extra.key ?? randomUUID();
  if (extra.version !== undefined) headers['If-Match'] = `"${extra.version}"`;
  const response = await app.request(origin + '/api/v1' + path, {method: body === undefined ? 'GET' : 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body)});
  return {status: response.status, data: await response.json() as any, response};
}
async function admin(path: string, body?: unknown, version?: number, key: string = randomUUID(), headers: Record<string, string> = {}) {
  const defaults: Record<string, string> = {Origin: origin, 'Cf-Access-Jwt-Assertion': jwt, 'X-Admin-CSRF': csrf, ...headers};
  if (body !== undefined) {
    defaults['Content-Type'] = 'application/json';
    defaults['Idempotency-Key'] = key;
    if (version !== undefined) defaults['If-Match'] = `"${version}"`;
  }
  const response = await app.request(origin + '/admin/api' + path, {method: body === undefined ? 'GET' : 'POST', headers: defaults, body: body === undefined ? undefined : JSON.stringify(body)});
  return {status: response.status, data: await response.json() as any, response};
}
function claimBody(role = 'original_author', statement = SECRET, evidence: string | null | undefined = EVIDENCE) {
  return {role, statement, declared: true as const, ...(evidence === undefined ? {} : {evidence_url: evidence})};
}
function keysOf(value: unknown, found = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const item of value) keysOf(item, found);
  else if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) { found.add(key); keysOf(child, found); }
  return found;
}
function assertPublic(value: unknown) {
  const text = JSON.stringify(value);
  for (const key of PRIVATE_KEYS) assert.equal([...keysOf(value)].includes(key), false, key);
  for (const leak of [SECRET, OTHER_SECRET, EVIDENCE, 'maker@local.test', email, '已驗證']) assert.equal(text.includes(leak), false, leak);
}
async function submit(session: {cookie: string; csrf: string}, bookId: string, body = claimBody()) {
  return member(`/me/skill-books/${bookId}/author-claims`, session, body);
}
async function review(id: string, decision: string, version: number, key?: string) {
  return admin(`/author-claims/${id}/review`, {decision, reason: decision === 'reject' ? '公開紀錄對不上這位申請人。' : '已核對公開的原作紀錄。'}, version, key);
}

test('several verified original authors stay public while a pending maintainer and another community do not leak', async () => {
  assert.equal(PUBLIC_AUTHOR_CLAIM_SQL.includes('evidence_url'), false);
  assert.equal(PUBLIC_AUTHOR_CLAIM_SQL.includes('statement'), false);
  assert.equal(PUBLIC_AUTHOR_CLAIM_SQL.includes('email'), false);
  assert.equal(PUBLIC_AUTHOR_CLAIM_SQL.includes('reviewed_by'), false);
  const upstream = arm('video-autopilot', {id: 88001122, fork: true, source: {id: 42, full_name: 'someone/parent-kit'}});
  arm('local-workspace-mcp', {id: 77001, omitVisibility: true});
  assert.equal((await member('/skills/video-autopilot/author-claim', {cookie: '', csrf: ''})).data.status, 'unclaimed');
  const maker = await login(DEMO_USERS[0]);
  const reviewer = await login(DEMO_USERS[1]);
  const client = await login(DEMO_USERS[2]);
  await link(DEMO_USERS[0], '101', 'aaa-author');
  await link(DEMO_USERS[1], '202', 'mmm-author');
  await link(DEMO_USERS[2], '303', 'client-maintainer');
  const first = await submit(maker, 'video-autopilot');
  assert.equal(first.status, 201, JSON.stringify(first.data));
  assert.equal(first.data.state, 'pending');
  assert.equal(first.data.version, 1);
  assert.equal(first.response.headers.get('etag'), '"1"');
  assert.equal(first.data.repo.provider_repo_id, '88001122');
  assert.deepEqual(github.calls, ['/repos/' + upstream]);
  assert.equal((await pool.query('SELECT source_repo_id FROM canonical_repositories WHERE provider_repo_id=$1', ['88001122'])).rows[0].source_repo_id, '42');
  assert.equal((await pool.query('SELECT count(*) FROM canonical_repositories WHERE provider_repo_id=$1', ['42'])).rows[0].count, '0');
  const second = await submit(reviewer, 'video-autopilot');
  assert.equal(second.status, 201, JSON.stringify(second.data));
  assert.equal(github.calls.length, 1);
  const pendingMaintainer = await submit(client, 'video-autopilot', claimBody('maintainer', OTHER_SECRET));
  assert.equal(pendingMaintainer.status, 201);
  assert.equal((await review(first.data.claim_id, 'verify', 1)).status, 200);
  assert.equal((await review(second.data.claim_id, 'verify', 1)).status, 200);
  const attributed = await submit(maker, 'local-workspace-mcp');
  assert.equal(attributed.status, 201, JSON.stringify(attributed.data));
  assert.equal((await review(attributed.data.claim_id, 'verify', 1)).status, 200);
  const duringPending = await app.request(origin + '/api/v1/skills/video-autopilot/author-claim');
  const duringBody = await duringPending.json() as any;
  assert.equal(duringBody.status, 'verified_original_author');
  assert.deepEqual(duringBody.verified.map((person: {github_login: string}) => person.github_login), ['aaa-author', 'mmm-author']);
  assert.equal(duringBody.verified.some((person: {github_login: string}) => person.github_login === 'client-maintainer'), false);
  const otherCommunity = randomUUID(), otherUser = randomUUID();
  await pool.query('INSERT INTO communities VALUES($1,$2)', [otherCommunity, 'Other community']);
  await pool.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref) SELECT $1,$2,'outside-author@example.invalid','外社群原作者',password_hash,$3 FROM users LIMIT 1`, [otherUser, otherCommunity, randomUUID()]);
  const repoId = (await pool.query('SELECT repo_id FROM canonical_repositories WHERE provider_repo_id=$1', ['88001122'])).rows[0].repo_id;
  await pool.query(`INSERT INTO repo_credit_claims(claim_id,community_id,repo_id,user_id,github_user_id,github_login,role,state,statement,source_snapshot)
    VALUES($1,$2,$3,$4,'404','zzz-outside','original_author','verified',$5,'{"book_id":"video-autopilot"}')`, [randomUUID(), otherCommunity, repoId, otherUser, SECRET]);
  const listed = await app.request(origin + '/api/v1/skills/author-claims');
  const catalog = await listed.json() as {items: any[]};
  const video = catalog.items.find(item => item.book_id === 'video-autopilot');
  assertPublic(catalog);
  assert.equal(video.status, 'verified_original_author');
  assert.equal(video.label, '已核實原作者');
  assert.deepEqual(video.verified.map((person: {github_login: string; display_name: string}) => [person.github_login, person.display_name]), [['aaa-author', '示範創作者'], ['mmm-author', '示範需求者'], ['zzz-outside', '外社群原作者']]);
  const mine = await member('/me/skill-books/video-autopilot/author-claim', maker);
  assert.equal(mine.data.claims.length, 1);
  assert.equal(mine.data.claims[0].statement, SECRET);
  assert.equal(Object.hasOwn(mine.data.claims[0], 'reviewed_by'), false);
  const queue = await admin('/author-claims?queue=verified');
  assert.equal(queue.status, 200);
  assert.equal(JSON.stringify(queue.data).includes('外社群原作者'), false);
  assert.equal(JSON.stringify(queue.data).includes('zzz-outside'), false);
  const page = await app.request(origin + '/development/skills/local-workspace-mcp');
  const html = await page.text();
  assert.equal(page.status, 200);
  assert.equal(html.includes('來源標示的作者：Mini'), true);
  assert.equal(html.includes('已核實原作者'), true);
  assert.equal(html.includes('data-author-claim-status="verified_original_author"'), true);
  for (const leak of [SECRET, EVIDENCE, 'maker@local.test', email, '已驗證']) assert.equal(html.includes(leak), false, leak);
});

test('a self-submitted claim stays pending and never becomes publicly verified', async () => {
  arm('video-autopilot', {id: 88001122});
  const maker = await login();
  const forged = await submit(maker, 'video-autopilot', {...claimBody(), verified: true} as any);
  assert.equal(forged.status, 422);
  assert.equal(forged.data.code, 'validation_failed');
  assert.equal((await submit(maker, 'video-autopilot', {...claimBody(), declared: false} as any)).status, 422);
  assert.equal((await submit(maker, 'video-autopilot', claimBody('original_author', SECRET, ''))).status, 422);
  const unlinked = await submit(maker, 'video-autopilot');
  assert.equal(unlinked.status, 409);
  assert.equal(unlinked.data.code, 'github_link_required');
  assert.equal(github.calls.length, 0);
  assert.equal((await pool.query('SELECT count(*) FROM repo_credit_claims')).rows[0].count, '0');
  assert.equal((await pool.query('SELECT count(*) FROM canonical_repositories')).rows[0].count, '0');
  await link(DEMO_USERS[0], '101', 'aaa-author');
  const pending = await submit(maker, 'video-autopilot');
  assert.equal(pending.status, 201);
  assert.equal(pending.data.state, 'pending');
  const pub = await (await app.request(origin + '/api/v1/skills/video-autopilot/author-claim')).json() as any;
  assertPublic(pub);
  assert.equal(pub.status, 'pending');
  assert.equal(pub.label, '認領審核中');
  assert.deepEqual(pub.verified, []);
  assert.equal((await app.request(origin + '/api/v1/skills/not-a-book/author-claim')).status, 404);
});

test('duplicate active claims are rejected, withdrawal frees the role, and verified claims cannot be withdrawn', async () => {
  arm('video-autopilot', {id: 88001122});
  const maker = await login();
  await link(DEMO_USERS[0], '101', 'aaa-author');
  const first = await submit(maker, 'video-autopilot', claimBody('original_author', SECRET, null));
  assert.equal(first.status, 201);
  assert.equal(first.data.evidence_url, null);
  const duplicate = await submit(maker, 'video-autopilot', claimBody('original_author', SECRET, null));
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.data.code, 'duplicate_active_claim');
  const maintainer = await submit(maker, 'video-autopilot', claimBody('maintainer', SECRET, null));
  assert.equal(maintainer.status, 201);
  const withdrawn = await member(`/me/author-claims/${first.data.claim_id}/withdraw`, maker, {}, {version: 1});
  assert.equal(withdrawn.status, 200, JSON.stringify(withdrawn.data));
  assert.equal(withdrawn.data.state, 'withdrawn');
  assert.equal(withdrawn.data.can_withdraw, false);
  const again = await submit(maker, 'video-autopilot', claimBody('original_author', SECRET, null));
  assert.equal(again.status, 201);
  const repoId = (await pool.query('SELECT repo_id FROM repo_credit_claims WHERE claim_id=$1', [again.data.claim_id])).rows[0].repo_id;
  await assert.rejects(() => pool.query(`INSERT INTO repo_credit_claims(claim_id,community_id,repo_id,user_id,github_user_id,github_login,role,state,statement,source_snapshot)
    VALUES($1,$2,$3,$4,'101','aaa-author','original_author','pending',$5,'{}')`, [randomUUID(), DEMO_COMMUNITY, repoId, DEMO_USERS[0].user_id, SECRET]), (error: any) => error.code === '23505' && error.constraint === 'repo_credit_claims_one_active_role');
  assert.equal((await review(again.data.claim_id, 'verify', 1)).status, 200);
  assert.equal((await member(`/me/author-claims/${again.data.claim_id}/withdraw`, maker, {}, {version: 2})).data.code, 'claim_not_withdrawable');
  assert.equal((await member(`/me/author-claims/${again.data.claim_id}/appeal`, maker, {appeal: '這筆還在核實中不該申訴。'}, {version: 2})).data.code, 'claim_not_appealable');
  const stranger = await login(DEMO_USERS[1]);
  assert.equal((await member(`/me/author-claims/${again.data.claim_id}/withdraw`, stranger, {}, {version: 2})).status, 404);
  const hidden = await member('/me/skill-books/video-autopilot/author-claim', stranger);
  assert.equal(JSON.stringify(hidden.data).includes(SECRET), false);
});

test('reject, one appeal, verify and revoke keep the row and the audit trail', async () => {
  arm('video-autopilot', {id: 88001122});
  const maker = await login();
  await link(DEMO_USERS[0], '101', 'aaa-author');
  const submitted = await submit(maker, 'video-autopilot');
  assert.equal((await review(submitted.data.claim_id, 'reject', 1)).data.version, 2);
  assert.equal((await admin('/author-claims?queue=review')).data.items.length, 0);
  const appeal = await member(`/me/author-claims/${submitted.data.claim_id}/appeal`, maker, {appeal: '請再核對一次公開的提交歷史。'}, {version: 2});
  assert.equal(appeal.status, 200, JSON.stringify(appeal.data));
  assert.equal(appeal.data.state, 'pending');
  assert.equal(appeal.data.version, 3);
  assert.equal(appeal.data.can_appeal, false);
  const second = await member(`/me/author-claims/${submitted.data.claim_id}/appeal`, maker, {appeal: '第二次申訴不應該再排隊。'}, {version: 3});
  assert.equal(second.status, 409);
  assert.equal(second.data.code, 'appeal_already_used');
  const queued = await admin('/author-claims?queue=review');
  assert.equal(queued.data.items[0].appeal_text, '請再核對一次公開的提交歷史。');
  assert.equal(queued.data.items[0].statement, SECRET);
  const verified = await review(submitted.data.claim_id, 'verify', 3);
  assert.equal(verified.status, 200, JSON.stringify(verified.data));
  assert.equal(verified.data.version, 4);
  const revoked = await review(submitted.data.claim_id, 'revoke', 4);
  assert.equal(revoked.status, 200, JSON.stringify(revoked.data));
  assert.equal(revoked.data.state, 'revoked');
  assert.equal(revoked.data.version, 5);
  assert.equal((await pool.query('SELECT state,version FROM repo_credit_claims WHERE claim_id=$1', [submitted.data.claim_id])).rows[0].state, 'revoked');
  assert.deepEqual((await pool.query('SELECT action FROM repo_credit_claim_events WHERE claim_id=$1 ORDER BY created_at,action', [submitted.data.claim_id])).rows.map(row => row.action), ['submit', 'reject', 'appeal', 'verify', 'revoke']);
  assert.deepEqual((await pool.query("SELECT action FROM platform_admin_audit WHERE target_ref=$1 ORDER BY created_at", [submitted.data.claim_id])).rows.map(row => row.action), ['author_claim_reject', 'author_claim_verify', 'author_claim_revoke']);
  const journal = (await pool.query("SELECT data::text AS data FROM transition_journal WHERE aggregate_id=$1", [submitted.data.claim_id])).rows.map(row => row.data).join('\n');
  const events = (await pool.query('SELECT coalesce(reason,\'\') AS reason FROM repo_credit_claim_events WHERE claim_id=$1', [submitted.data.claim_id])).rows.map(row => row.reason).join('\n');
  assert.equal(journal.includes(SECRET), false);
  assert.equal(events.includes(SECRET), false);
  assert.equal((await admin('/author-claims?queue=verified')).data.items.length, 0);
  assert.equal((await app.request(origin + '/api/v1/skills/video-autopilot/author-claim')).status, 200);
  const pub = await (await app.request(origin + '/api/v1/skills/video-autopilot/author-claim')).json() as any;
  assert.equal(pub.status, 'unclaimed');
  await assert.rejects(() => pool.query('DELETE FROM repo_credit_claims WHERE claim_id=$1', [submitted.data.claim_id]), /repo credit claims are retained/);
  await assert.rejects(() => pool.query('UPDATE repo_credit_claim_events SET reason=$2 WHERE claim_id=$1', [submitted.data.claim_id, '改寫']), /append-only/);
  assert.equal((await pool.query('SELECT count(*) FROM repo_credit_claims WHERE claim_id=$1', [submitted.data.claim_id])).rows[0].count, '1');
});

test('an admin cannot review a claim tied to their user or their current GitHub account', async () => {
  arm('video-autopilot', {id: 88001122});
  arm('typo-studio', {id: 88001123});
  const maker = await login(DEMO_USERS[0]);
  const reviewer = await login(DEMO_USERS[1]);
  await link(DEMO_USERS[0], '111', 'maker-gh');
  await link(DEMO_USERS[1], '222', 'reviewer-gh');
  const own = await submit(maker, 'video-autopilot');
  await pool.query('UPDATE users SET email=$2 WHERE user_id=$1', [DEMO_USERS[0].user_id, email]);
  await pool.query('UPDATE github_social_connections SET github_user_id=$2,github_login=$3 WHERE user_id=$1', [DEMO_USERS[0].user_id, '999', 'changed-gh']);
  const blockedUser = await review(own.data.claim_id, 'reject', 1);
  assert.equal(blockedUser.status, 403);
  assert.equal(blockedUser.data.code, 'self_review_forbidden');
  assert.equal((await pool.query('SELECT state FROM repo_credit_claims WHERE claim_id=$1', [own.data.claim_id])).rows[0].state, 'pending');
  const other = await submit(reviewer, 'typo-studio');
  await pool.query('DELETE FROM github_social_connections WHERE user_id=$1', [DEMO_USERS[1].user_id]);
  await pool.query('UPDATE github_social_connections SET github_user_id=$2,github_login=$3 WHERE user_id=$1', [DEMO_USERS[0].user_id, '222', 'shared-gh']);
  const blockedGithub = await review(other.data.claim_id, 'verify', 1);
  assert.equal(blockedGithub.status, 403);
  assert.equal(blockedGithub.data.code, 'self_review_forbidden');
  assert.equal((await pool.query('SELECT state FROM repo_credit_claims WHERE claim_id=$1', [other.data.claim_id])).rows[0].state, 'pending');
  assert.equal((await pool.query('SELECT count(*) FROM platform_admin_audit')).rows[0].count, '0');
});

test('members and guild officers have no review route', async () => {
  arm('video-autopilot', {id: 88001122});
  const maker = await login();
  await link(DEMO_USERS[0], '101', 'aaa-author');
  await pool.query("INSERT INTO positioning_profession_memberships(membership_id,community_id,user_id,guild_key,state) VALUES($1,$2,$3,'guild_marketing','active')", [randomUUID(), DEMO_COMMUNITY, DEMO_USERS[0].user_id]);
  await pool.query("INSERT INTO positioning_guild_officers(community_id,guild_key,user_id) VALUES($1,'guild_marketing',$2)", [DEMO_COMMUNITY, DEMO_USERS[0].user_id]);
  const submitted = await submit(maker, 'video-autopilot');
  const denied = await member(`/author-claims/${submitted.data.claim_id}/review`, maker, {decision: 'verify', reason: '會員不能自己核實。'});
  assert.equal(denied.status, 404);
  const adminDenied = await app.request(origin + '/admin/api/author-claims', {headers: {Origin: origin, Cookie: maker.cookie}});
  assert.equal(adminDenied.status, 401);
  assert.equal((await pool.query('SELECT state FROM repo_credit_claims WHERE claim_id=$1', [submitted.data.claim_id])).rows[0].state, 'pending');
});

test('stale versions conflict, the same idempotency key replays, and CSRF is required', async () => {
  arm('video-autopilot', {id: 88001122});
  const maker = await login();
  await link(DEMO_USERS[0], '101', 'aaa-author');
  const noOrigin = await member('/me/skill-books/typo-studio/author-claims', maker, claimBody(), {origin: ''});
  assert.equal(noOrigin.status, 403);
  assert.equal(noOrigin.data.code, 'origin_rejected');
  const noCsrf = await member('/me/skill-books/typo-studio/author-claims', maker, claimBody(), {csrf: ''});
  assert.equal(noCsrf.status, 403);
  assert.equal(noCsrf.data.code, 'csrf_rejected');
  assert.equal((await submit(maker, 'video-autopilot')).status, 201);
  const submitted = await member('/me/skill-books/video-autopilot/author-claim', maker);
  const claimId = (await pool.query('SELECT claim_id,version FROM repo_credit_claims')).rows[0];
  assert.equal(Number(claimId.version), 1);
  assert.equal(submitted.data.claims[0].claim_id, claimId.claim_id);
  const missing = await review(claimId.claim_id, 'verify', undefined as any);
  assert.equal(missing.status, 428);
  assert.equal(missing.data.code, 'version_required');
  const stale = await review(claimId.claim_id, 'verify', 2);
  assert.equal(stale.status, 409);
  assert.equal(stale.data.code, 'claim_version_conflict');
  assert.equal((await pool.query('SELECT state FROM repo_credit_claims')).rows[0].state, 'pending');
  const key = randomUUID();
  const verified = await review(claimId.claim_id, 'verify', 1, key);
  assert.equal(verified.status, 200, JSON.stringify(verified.data));
  assert.equal(verified.data.version, 2);
  assert.equal(verified.response.headers.get('etag'), '"2"');
  const replay = await review(claimId.claim_id, 'verify', 1, key);
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.data, verified.data);
  assert.equal((await pool.query("SELECT count(*) FROM repo_credit_claim_events WHERE action='verify'")).rows[0].count, '1');
  const conflict = await review(claimId.claim_id, 'reject', 1);
  assert.equal(conflict.status, 409);
  assert.equal((await pool.query('SELECT state,version FROM repo_credit_claims')).rows[0].state, 'verified');
});

test('claims follow the provider repo id across rename and do not move when the URL changes hands', async () => {
  const name = arm('video-autopilot', {id: 1001, full_name: 'Hao0321/video-autopilot-kit'});
  const maker = await login();
  await link(DEMO_USERS[0], '101', 'aaa-author');
  const submitted = await submit(maker, 'video-autopilot');
  assert.equal((await review(submitted.data.claim_id, 'verify', 1)).status, 200);
  github.repos.set('/repos/' + name, {id: 1001, full_name: 'RenamedOwner/video-autopilot-kit'});
  const renamed = await admin('/skill-books/video-autopilot/author-claim-observation', {});
  assert.equal(renamed.status, 200, JSON.stringify(renamed.data));
  assert.equal(renamed.data.full_name, 'RenamedOwner/video-autopilot-kit');
  assert.equal(renamed.data.needs_recheck, false);
  assert.equal(renamed.data.previous_provider_repo_id, null);
  const snapshot = (await pool.query('SELECT source_snapshot->>\'full_name\' AS name, r.full_name, r.provider_repo_id FROM repo_credit_claims c JOIN canonical_repositories r ON r.repo_id=c.repo_id')).rows[0];
  assert.equal(snapshot.name, 'Hao0321/video-autopilot-kit');
  assert.equal(snapshot.full_name, 'RenamedOwner/video-autopilot-kit');
  assert.equal(snapshot.provider_repo_id, '1001');
  assert.equal((await (await app.request(origin + '/api/v1/skills/video-autopilot/author-claim')).json() as any).status, 'verified_original_author');
  github.repos.set('/repos/' + name, {id: 2002, full_name: 'Hao0321/video-autopilot-kit'});
  const transferred = await admin('/skill-books/video-autopilot/author-claim-observation', {});
  assert.equal(transferred.data.provider_repo_id, '2002');
  assert.equal(transferred.data.previous_provider_repo_id, '1001');
  assert.equal(transferred.data.needs_recheck, true);
  const again = await admin('/skill-books/video-autopilot/author-claim-observation', {});
  assert.equal(again.data.needs_recheck, true);
  assert.equal((await pool.query('SELECT state,r.provider_repo_id FROM repo_credit_claims c JOIN canonical_repositories r ON r.repo_id=c.repo_id')).rows[0].provider_repo_id, '1001');
  assert.equal((await (await app.request(origin + '/api/v1/skills/video-autopilot/author-claim')).json() as any).status, 'unclaimed');
  const changes = await admin('/author-claims?queue=review');
  assert.equal(changes.data.identity_changes[0].book_id, 'video-autopilot');
  assert.equal(changes.data.identity_changes[0].previous_provider_repo_id, '1001');
  const acknowledged = await admin('/skill-books/video-autopilot/author-claim-observation/acknowledge', {reason: '已確認這是另一個 Repo。'});
  assert.equal(acknowledged.status, 200, JSON.stringify(acknowledged.data));
  assert.equal(acknowledged.data.needs_recheck, false);
  assert.equal((await admin('/skill-books/video-autopilot/author-claim-observation/acknowledge', {reason: '再確認一次也不該成功。'})).data.code, 'identity_already_current');
  assert.deepEqual((await pool.query('SELECT action FROM catalog_repo_identity_events ORDER BY created_at')).rows.map(row => row.action), ['identity_changed', 'acknowledged']);
  assert.equal((await pool.query('SELECT r.provider_repo_id FROM repo_credit_claims c JOIN canonical_repositories r ON r.repo_id=c.repo_id')).rows[0].provider_repo_id, '1001');
  assert.equal((await admin('/author-claims?queue=verified')).data.identity_changes.length, 0);
});

test('author-claim reads send the platform token and retry a non-rate-limit 403 once', async () => {
  const token = 'github_pat_synthetic_fixture';
  const seen: Array<string | null> = [];
  const signals: Array<AbortSignal | null | undefined> = [];
  const recording: typeof fetch = async (input, init) => {
    const authorization = new Headers(init?.headers).get('authorization');
    seen.push(authorization);
    signals.push(init?.signal);
    if (authorization) {
      assert.equal(authorization, `Bearer ${token}`);
      return new Response(JSON.stringify({message: 'Resource protected by organization SAML enforcement'}), {status: 403, headers: {'x-ratelimit-remaining': '100'}});
    }
    return fetcher(input, init);
  };
  const tokenApp = createApp(pool, origin, 'local', {adminVerifier: verifier, githubSocial: {fetcher: recording, metricsToken: token}});
  arm('video-autopilot', {id: 88001122});
  const logged = await tokenApp.request(origin + '/api/v1/auth/login', {method: 'POST', headers: {Origin: origin, 'Content-Type': 'application/json'}, body: JSON.stringify({email: DEMO_USERS[0].email, password: DEMO_PASSWORD})});
  const session = await logged.json() as {csrf_token: string};
  await link(DEMO_USERS[0], '101', 'aaa-author');
  const submitted = await tokenApp.request(origin + '/api/v1/me/skill-books/video-autopilot/author-claims', {
    method: 'POST', headers: {Origin: origin, Cookie: logged.headers.get('set-cookie')!.split(';')[0], 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrf_token, 'Idempotency-Key': randomUUID()},
    body: JSON.stringify(claimBody()),
  });
  const body = await submitted.json() as {code?: string};
  assert.equal(submitted.status, 201, JSON.stringify(body));
  assert.deepEqual(seen.slice(0, 2), [`Bearer ${token}`, null]);
  assert.equal(signals[0], signals[1]);
  assert.equal(JSON.stringify(body).includes(token), false);
  const observed = await tokenApp.request(origin + '/admin/api/skill-books/video-autopilot/author-claim-observation', {
    method: 'POST', headers: {Origin: origin, 'Cf-Access-Jwt-Assertion': jwt, 'X-Admin-CSRF': csrf, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID()}, body: '{}',
  });
  assert.equal(observed.status, 200, await observed.clone().text());
  assert.deepEqual(seen.slice(2, 4), [`Bearer ${token}`, null]);
  assert.equal(signals[2], signals[3]);
  assert.equal((await observed.text()).includes(token), false);
});

test('GitHub failures and private repositories do not invent an id or a claim', async () => {
  const maker = await login();
  await link(DEMO_USERS[0], '101', 'aaa-author');
  const missing = await submit(maker, 'video-autopilot');
  assert.equal(missing.status, 422);
  assert.equal(missing.data.code, 'claim_repository_unavailable');
  arm('video-autopilot', 'down');
  const down = await submit(maker, 'video-autopilot');
  assert.equal(down.status, 503);
  assert.equal(down.data.code, 'github_unavailable');
  assert.equal(down.data.detail.includes('請稍後再試'), true);
  github.repos.set('/repos/' + coordinate('typo-studio'), 'limited');
  const limitedBook = await submit(maker, 'typo-studio');
  assert.equal(limitedBook.status, 503);
  assert.equal(limitedBook.data.code, 'github_rate_limited');
  assert.equal(limitedBook.data.detail.includes('請稍後再試'), true);
  arm('pos-pro', {id: 88001124, private: true, visibility: 'private'});
  const hidden = await submit(maker, 'pos-pro');
  assert.equal(hidden.status, 422);
  assert.equal(hidden.data.detail, '這本技能書的原作不是可認領的公開 GitHub Repo。');
  assert.equal(hidden.data.code, missing.data.code);
  assert.equal((await pool.query('SELECT count(*) FROM repo_credit_claims')).rows[0].count, '0');
  assert.equal((await pool.query('SELECT count(*) FROM canonical_repositories')).rows[0].count, '0');
});

test('a fresh observation is reused and a forced admin refresh reads GitHub again', async () => {
  arm('video-autopilot', {id: 88001122, omitVisibility: true});
  const maker = await login(DEMO_USERS[0]);
  const reviewer = await login(DEMO_USERS[1]);
  await link(DEMO_USERS[0], '101', 'aaa-author');
  await link(DEMO_USERS[1], '202', 'mmm-author');
  assert.equal((await submit(maker, 'video-autopilot')).status, 201);
  assert.equal(github.calls.length, 1);
  assert.equal((await submit(reviewer, 'video-autopilot')).status, 201);
  assert.equal(github.calls.length, 1);
  assert.equal((await admin('/skill-books/video-autopilot/author-claim-observation', {})).status, 200);
  assert.equal(github.calls.length, 2);
  github.repos.set('/repos/' + coordinate('video-autopilot'), 'down');
  const failed = await admin('/skill-books/video-autopilot/author-claim-observation', {});
  assert.equal(failed.status, 503);
  assert.equal((await pool.query('SELECT provider_repo_id FROM catalog_repo_observations')).rows[0].provider_repo_id, '88001122');
});

test('the thirteenth member claim write in an hour is rate limited', async () => {
  const books: string[] = [];
  const seen = new Set<string>();
  for (const book of communityCatalog.skill_books) {
    let name = '';
    try { name = githubCoordinate(book.upstream_url); } catch { continue; }
    if (seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    books.push(book.id);
  }
  assert.ok(books.length >= 13, String(books.length));
  const maker = await login();
  await link(DEMO_USERS[0], '101', 'aaa-author');
  for (let index = 0; index < 12; index += 1) {
    arm(books[index], {id: 800000 + index});
    const result = await submit(maker, books[index], claimBody('original_author', SECRET, undefined));
    assert.equal(result.status, 201, books[index] + ' ' + JSON.stringify(result.data));
  }
  arm(books[12], {id: 800012});
  const blocked = await submit(maker, books[12], claimBody('original_author', SECRET, undefined));
  assert.equal(blocked.status, 429);
  assert.equal(blocked.data.code, 'auth_rate_limited');
  assert.equal((await pool.query('SELECT count(*) FROM repo_credit_claims')).rows[0].count, '12');
});

test('public status distinguishes a verified maintainer, a pending original author and a dispute', async () => {
  arm('video-autopilot', {id: 88001122});
  const maker = await login(DEMO_USERS[0]);
  const reviewer = await login(DEMO_USERS[1]);
  await link(DEMO_USERS[0], '101', 'aaa-author');
  await link(DEMO_USERS[1], '202', 'mmm-author');
  const maintainer = await submit(maker, 'video-autopilot', claimBody('maintainer'));
  assert.equal((await review(maintainer.data.claim_id, 'verify', 1)).status, 200);
  const alone = await (await app.request(origin + '/api/v1/skills/video-autopilot/author-claim')).json() as any;
  assertPublic(alone);
  assert.equal(alone.status, 'verified_maintainer');
  assert.equal(alone.label, '已核實維護者');
  assert.equal(alone.verified[0].role, 'maintainer');
  const pending = await submit(reviewer, 'video-autopilot', claimBody('original_author', OTHER_SECRET));
  const mixed = await (await app.request(origin + '/api/v1/skills/video-autopilot/author-claim')).json() as any;
  assert.equal(mixed.status, 'pending');
  assert.equal(mixed.label, '認領審核中');
  assert.deepEqual(mixed.verified.map((person: {github_login: string}) => person.github_login), ['aaa-author']);
  assert.equal((await review(pending.data.claim_id, 'dispute', 1)).status, 200);
  const disputed = await (await app.request(origin + '/api/v1/skills/video-autopilot/author-claim')).json() as any;
  assertPublic(disputed);
  assert.equal(disputed.status, 'disputed');
  assert.equal(disputed.label, '有爭議');
  assert.deepEqual(disputed.verified.map((person: {role: string}) => person.role), ['maintainer']);
  assert.equal(JSON.stringify(disputed).includes('mmm-author'), false);
  assert.equal(JSON.stringify(disputed).includes('示範需求者'), false);
});
