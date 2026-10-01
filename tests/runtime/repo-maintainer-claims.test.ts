import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createLocalJWKSet, exportJWK, exportPKCS8, generateKeyPair, SignJWT } from 'jose';
import { createPool, LOCAL_DATABASE_URL } from '../../packages/db/index.js';
import { migrate } from '../../scripts/database.js';
import { seedLocal, DEMO_USERS, DEMO_COMMUNITY } from '../../packages/testing/seed.js';
import { createApp } from '../../apps/platform-api/src/app.js';
import { createAdminAccessVerifier } from '../../modules/platform-admin/access.js';
import { runMaintainerTick, type MaintainerTickConfig } from '../../modules/repo-maintainer/tick.js';
import { settleMaintainerClaims } from '../../modules/repo-maintainer/claims.js';
import { enqueueMaintainerJob } from '../../modules/repo-maintainer/queue.js';

const origin = 'http://127.0.0.1:4310';
const databaseUrl = process.env.TEST_DATABASE_URL ?? LOCAL_DATABASE_URL;
const schema = `fp_mclaim_${process.pid}_${Date.now()}`;
const database = createPool(databaseUrl);
const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 4 });
const issuer = 'https://test-team.cloudflareaccess.com';
const audience = 'admin-route-tests';
const email = 'admin@example.invalid';
const adminId = randomUUID();
const pair = await generateKeyPair('RS256');
const jwk = await exportJWK(pair.publicKey);
const verifier = createAdminAccessVerifier({ issuer, audience, csrfSecret: 'test-fixture-admin-csrf-secret-123456789', keySet: createLocalJWKSet({ keys: [{ ...jwk, kid: 'admin-test', alg: 'RS256' }] }) });
const appPair = await generateKeyPair('RS256', { modulusLength: 2048, extractable: true });
const privateKey = await exportPKCS8(appPair.privateKey);
const TOKEN = 'enc-token-do-not-return';
const SHA = 'd'.repeat(40);
const OLD = 'e'.repeat(40);
const CLOCK = new Date('2026-09-30T12:00:00.000Z');
let app = createApp(pool, origin, 'local', { adminVerifier: verifier });
let jwt = '';
let csrf = '';
let reviewSeq = 100;

before(async () => {
  await database.query(`CREATE SCHEMA ${schema}`);
  await migrate(pool);
});
after(async () => {
  await pool.end();
  await database.query(`DROP SCHEMA ${schema} CASCADE`);
  await database.end();
});
beforeEach(async () => {
  reviewSeq = 100;
  await pool.query('TRUNCATE communities, login_attempts, auth_rate_limits CASCADE');
  await seedLocal(pool);
  await pool.query('INSERT INTO platform_admins (admin_id, community_id, email, display_name) VALUES ($1,$2,$3,$4)', [adminId, DEMO_COMMUNITY, email, 'Verified Admin']);
  await pool.query(`UPDATE maintainer_worker_state SET next_installation_sync_at='2099-01-01T00:00:00Z', last_error=NULL WHERE singleton`);
  app = createApp(pool, origin, 'local', { adminVerifier: verifier });
  jwt = await sign(email);
  csrf = (await verifier(new Request(origin, { headers: { 'Cf-Access-Jwt-Assertion': jwt } }))).csrfToken;
});
async function sign(claimedEmail: string) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ type: 'app', email: claimedEmail, sub: 'verified-human-fixture', iss: issuer, aud: audience, iat: now, nbf: now, exp: now + 600 }).setProtectedHeader({ alg: 'RS256', kid: 'admin-test' }).sign(pair.privateKey);
}
async function request(path: string, body?: unknown, version?: number, key: string = randomUUID(), headers: Record<string, string> = {}) {
  const defaults: Record<string, string> = { Origin: origin, 'Cf-Access-Jwt-Assertion': jwt, 'X-Admin-CSRF': csrf, ...headers };
  if (body !== undefined) {
    defaults['Content-Type'] ??= 'application/json';
    defaults['Idempotency-Key'] = key;
    if (version !== undefined) defaults['If-Match'] = `"${version}"`;
  }
  const response = await app.request(origin + '/admin/api' + path, { method: body === undefined ? 'GET' : 'POST', headers: defaults, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  let data: any = text;
  try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  return { status: response.status, data, etag: response.headers.get('etag') };
}
async function insertRepo(settings: Record<string, unknown> = {}, mode = 'observe') {
  const id = randomUUID();
  await pool.query(`INSERT INTO maintainer_repositories
    (repository_id, community_id, github_repository_id, installation_id, full_name, default_branch, installation_state, mode, settings, next_sweep_at)
    VALUES ($1,$2,'9001','77','FreeTWAI-AI/freedom-platform','main','active',$3,$4::jsonb,'2099-01-01T00:00:00Z')`,
  [id, DEMO_COMMUNITY, mode, JSON.stringify(settings)]);
  return id;
}
async function insertPull(repository: string, number: number, over: { queue?: string; risk?: string; author?: string; draft?: boolean; paused?: boolean; state?: string; file?: string; check?: { status: string; conclusion: string | null } | null; migration?: unknown[]; observed?: string; merged?: boolean } = {}) {
  const id = randomUUID();
  const file = over.file ?? 'README.md';
  const risk = over.risk ?? (file.includes('workflows') ? 'high' : 'low');
  const queue = over.queue ?? 'awaiting_review';
  const observed = over.observed ?? '2026-09-30T11:00:00Z';
  await pool.query(`INSERT INTO maintainer_pull_requests (
    pull_id, repository_id, number, github_pull_id, title, html_url, state, merged_at, is_draft, author_github_id, author_login, author_type,
    author_association, is_fork, head_sha, base_ref, base_sha, labels, additions, deletions, changed_files, github_created_at,
    github_updated_at, head_observed_at, risk_class, risk_reasons, queue_state, queue_reasons, migration_reasons, sla_due_at, paused, policy_version, synced_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'octocat','User','CONTRIBUTOR',false,$11,'main',$12,'{}',1,0,1,$13,$13,$13,$14,$15::jsonb,$16,'[]'::jsonb,$17::jsonb,$18,$19,'2026-09-30.1',$13)`,
  [id, repository, number, String(8000 + number), `PR ${number}`, `https://github.com/FreeTWAI-AI/freedom-platform/pull/${number}`, over.state ?? 'open', over.merged ? observed : null, over.draft ?? false, over.author ?? '42', SHA, OLD, observed, risk,
    JSON.stringify([{ code: risk === 'high' ? 'high_sensitive' : 'low_docs', message: risk === 'high' ? '敏感路徑' : '文件', paths: [file] }]), queue,
    JSON.stringify(over.migration ?? []), queue === 'awaiting_review' ? '2026-09-30T18:00:00Z' : null, over.paused ?? false]);
  await pool.query(`INSERT INTO maintainer_pull_files (pull_id, path, status, additions, deletions) VALUES ($1,$2,'modified',1,0)`, [id, file]);
  if (over.check !== null) {
    const check = over.check ?? { status: 'completed', conclusion: 'success' };
    await pool.query(`INSERT INTO maintainer_checks (pull_id, head_sha, source, name, app_slug, status, conclusion) VALUES ($1,$2,'check_run','verify','github-actions',$3,$4)`, [id, SHA, check.status, check.conclusion]);
  }
  return id;
}
async function member(address: string, name: string) {
  const id = randomUUID();
  await pool.query(`INSERT INTO users (user_id, community_id, email, display_name, password_hash, profession_membership_ref, email_verified_at)
    SELECT $1, community_id, $2, $3, password_hash, $4, now() FROM users WHERE user_id=$5`, [id, address, name, randomUUID(), DEMO_USERS[0].user_id]);
  return id;
}
async function link(userId: string, githubId: string, login: string) {
  await pool.query(`INSERT INTO github_social_connections (user_id, community_id, github_user_id, github_login, encrypted_tokens) VALUES ($1,$2,$3,$4,$5)`, [userId, DEMO_COMMUNITY, githubId, login, TOKEN]);
}
async function reviewer(userId: string, githubId: string, login: string, max: string, active = true) {
  const id = randomUUID();
  await pool.query(`INSERT INTO maintainer_reviewers (reviewer_id, community_id, github_user_id, github_login, user_id, max_risk, active, appointed_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [id, DEMO_COMMUNITY, githubId, login, userId, max, active, adminId]);
  return id;
}
async function asSelf(max = 'high') {
  const userId = await member(email, '審核管理員');
  await link(userId, '77001', 'self-reviewer');
  return { userId, reviewerId: await reviewer(userId, '77001', 'self-reviewer', max) };
}
async function insertClaim(pullId: string, reviewerId: string, over: { created?: string; expires?: string; github?: string } = {}) {
  const id = randomUUID();
  await pool.query(`INSERT INTO maintainer_review_claims (
    claim_id, pull_id, reviewer_id, claimed_by_admin, assignment, head_sha, created_at, expires_at, state, github_request_state)
    VALUES ($1,$2,$3,$4,'self',$5,$6,$7,'active',$8)`,
  [id, pullId, reviewerId, adminId, SHA, over.created ?? '2026-09-30T10:00:00Z', over.expires ?? '2026-09-30T18:00:00Z', over.github ?? 'not_requested']);
  return id;
}
async function insertReview(pullId: string, githubId: string, state: string, submitted: string, commit: string | null = SHA) {
  reviewSeq += 1;
  await pool.query(`INSERT INTO maintainer_reviews (pull_id, github_review_id, reviewer_github_id, reviewer_login, reviewer_type, reviewer_association, state, commit_id, submitted_at)
    VALUES ($1,$2,$3,'ada','User','MEMBER',$4,$5,$6)`, [pullId, String(reviewSeq), githubId, state, commit, submitted]);
}
function tick(writes: MaintainerTickConfig['writes'], fetcher: typeof fetch = async () => { throw new Error('unexpected fetch'); }, now = () => CLOCK) {
  return runMaintainerTick(pool, { appId: '12345', organization: 'FreeTWAI-AI', privateKey, writes }, { fetcher, now });
}
async function claimRow(id: string) {
  return (await pool.query(`SELECT state, end_reason, github_request_state, github_request_error FROM maintainer_review_claims WHERE claim_id=$1`, [id])).rows[0];
}
async function queueOf(id: string) {
  return (await pool.query(`SELECT queue_state FROM maintainer_pull_requests WHERE pull_id=$1`, [id])).rows[0].queue_state as string;
}

test('claim, assign, release, pause and resume enforce identity, version and the queue filters', async () => {
  const repository = await insertRepo();
  const low = await insertPull(repository, 1);
  const high = await insertPull(repository, 2, { file: '.github/workflows/verify.yml', queue: 'needs_owner', risk: 'high' });
  const authorQueue = await insertPull(repository, 3, { queue: 'needs_author', migration: [{ code: 'migration_number_collision', message: '編號衝突' }] });
  const ci = await insertPull(repository, 4, { queue: 'waiting_ci', check: { status: 'in_progress', conclusion: null } });
  const path = `/review-center/pulls/${low}/claim`;
  assert.equal((await request(path, {}, 1, randomUUID(), { 'Cf-Access-Jwt-Assertion': '' })).status, 401);
  assert.equal((await request(path, {}, 1, randomUUID(), { 'Cf-Access-Jwt-Assertion': await sign('not-nominated@example.invalid') })).status, 403);
  assert.equal((await request(path, {}, 1, randomUUID(), { 'X-Admin-CSRF': 'wrong' })).status, 403);
  assert.equal((await request(path, {}, 1, randomUUID(), { Origin: 'https://evil.example' })).data.code, 'origin_rejected');
  assert.equal((await request(path, {}, 1, 'short')).status, 400);
  assert.equal((await request(path, {})).status, 428);
  assert.equal((await request(path, {}, undefined, randomUUID(), { 'If-Match': '1' })).data.code, 'invalid_version');
  assert.equal((await request(path, {}, 9)).status, 412);
  const unnamed = await request(path, {}, 1);
  assert.equal(unnamed.status, 409);
  assert.equal(unnamed.data.code, 'maintainer_claim_identity_required');
  assert.match(unnamed.data.detail, /仍可以指派其他人/);
  const viewer = (await request('/review-center/summary')).data.viewer;
  assert.equal(viewer.github_login, null);
  assert.equal(viewer.reviewer_id, null);
  assert.match(viewer.reason, /不能認領給自己/);

  const linkedOnly = await member('linked-only@example.invalid', '只有連結');
  await link(linkedOnly, '77009', 'linked-only');
  await pool.query('UPDATE users SET email=$2 WHERE user_id=$1', [linkedOnly, email]);
  const notReviewer = await request(path, {}, 1);
  assert.equal(notReviewer.data.code, 'maintainer_claim_not_reviewer');
  await pool.query('DELETE FROM github_social_connections WHERE user_id=$1', [linkedOnly]);
  await pool.query('DELETE FROM users WHERE user_id=$1', [linkedOnly]);

  const self = await asSelf('low');
  const lowRank = await request(`/review-center/pulls/${high}/claim`, {}, 1);
  assert.equal(lowRank.data.code, 'maintainer_claim_rank_too_low');
  await pool.query(`UPDATE maintainer_reviewers SET max_risk='high' WHERE reviewer_id=$1`, [self.reviewerId]);
  const ownPr = await insertPull(repository, 5, { author: '77001' });
  assert.equal((await request(`/review-center/pulls/${ownPr}/claim`, {}, 1)).data.code, 'maintainer_claim_author');
  await pool.query(`UPDATE maintainer_pull_requests SET is_draft=true WHERE pull_id=$1`, [low]);
  assert.equal((await request(path, {}, 1)).data.code, 'maintainer_claim_unavailable');
  await pool.query(`UPDATE maintainer_pull_requests SET is_draft=false, paused=true WHERE pull_id=$1`, [low]);
  assert.equal((await request(path, {}, 1)).data.code, 'maintainer_claim_unavailable');
  await pool.query(`UPDATE maintainer_pull_requests SET paused=false, state='closed' WHERE pull_id=$1`, [low]);
  assert.equal((await request(path, {}, 1)).data.code, 'maintainer_claim_unavailable');
  await pool.query(`UPDATE maintainer_pull_requests SET state='open' WHERE pull_id=$1`, [low]);

  const key = randomUUID();
  const claimed = await request(path, {}, 1, key);
  assert.equal(claimed.status, 200, JSON.stringify(claimed.data));
  assert.equal(claimed.data.queue_state, 'in_review');
  assert.equal(claimed.data.claim.reviewer_login, 'self-reviewer');
  assert.equal(claimed.data.claim.assignment, 'self');
  assert.equal(claimed.data.claim.github_request_state, 'not_requested');
  assert.equal(claimed.etag, `"${claimed.data.aggregate_version}"`);
  assert.ok(claimed.data.queue_reasons.some((reason: { code: string }) => reason.code === 'review_claimed'));
  const replay = await request(path, {}, 1, key);
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.data, claimed.data);
  assert.equal((await pool.query(`SELECT count(*) FROM maintainer_review_claims WHERE pull_id=$1 AND state='active'`, [low])).rows[0].count, '1');
  const again = await request(path, {}, Number(claimed.data.aggregate_version));
  assert.equal(again.status, 409);
  assert.equal(again.data.code, 'maintainer_claim_exists');
  assert.match(again.data.detail, /self-reviewer/);
  const mine = await request('/review-center/pulls?queue=mine');
  assert.deepEqual(mine.data.items.map((item: { pull_id: string }) => item.pull_id), [low]);
  const authors = await request('/review-center/pulls?queue=author_action');
  assert.equal(authors.data.items.some((item: { pull_id: string }) => item.pull_id === authorQueue), true);
  assert.equal(authors.data.items.some((item: { pull_id: string }) => item.pull_id === low), false);
  const summary = await request('/review-center/summary');
  assert.equal(summary.data.counts.in_review, 1);
  assert.equal(summary.data.viewer.github_login, 'self-reviewer');
  assert.equal(summary.data.viewer.reviewer_id, self.reviewerId);
  assert.equal(summary.data.viewer.max_risk, 'high');
  assert.equal(summary.data.viewer.reason, null);

  const otherUser = await member('other-reviewer@example.invalid', '另一位');
  await link(otherUser, '77002', 'other-reviewer');
  const other = await reviewer(otherUser, '77002', 'other-reviewer', 'low');
  assert.equal((await request(`/review-center/pulls/${high}/assign`, { reviewer_id: other, reason: '請他看高風險。' }, 1)).data.code, 'maintainer_claim_rank_too_low');
  await pool.query(`UPDATE maintainer_reviewers SET max_risk='high' WHERE reviewer_id=$1`, [other]);
  await pool.query(`UPDATE github_social_connections SET github_user_id='77099' WHERE user_id=$1`, [otherUser]);
  assert.equal((await request(`/review-center/pulls/${high}/assign`, { reviewer_id: other, reason: '連結已換帳號。' }, 1)).data.code, 'maintainer_claim_not_reviewer');
  await pool.query(`UPDATE github_social_connections SET github_user_id='77002' WHERE user_id=$1`, [otherUser]);
  const assigned = await request(`/review-center/pulls/${high}/assign`, { reviewer_id: other, reason: '請他看這次高風險變更。' }, 1);
  assert.equal(assigned.status, 200, JSON.stringify(assigned.data));
  assert.equal(assigned.data.queue_state, 'in_review');
  assert.equal(assigned.data.claim.assignment, 'assigned');
  assert.equal(assigned.data.claim.reviewer_login, 'other-reviewer');

  const paused = await request(`/review-center/pulls/${ci}/pause`, { reason: '先暫停這次自動處理。' }, 1);
  assert.equal(paused.status, 200, JSON.stringify(paused.data));
  assert.equal(paused.data.paused, true);
  assert.equal(paused.data.queue_state, 'paused');
  const resumed = await request(`/review-center/pulls/${ci}/resume`, { reason: '恢復這次自動處理。' }, Number(paused.data.aggregate_version));
  assert.equal(resumed.status, 200, JSON.stringify(resumed.data));
  assert.equal(resumed.data.paused, false);
  assert.equal(resumed.data.queue_state, 'waiting_ci');

  const releasePath = `/review-center/claims/${claimed.data.claim.claim_id}/release`;
  assert.equal((await request(releasePath, { reason: '先放開。' }, 9)).status, 412);
  const released = await request(releasePath, { reason: '這次先不審。' }, Number(claimed.data.claim.aggregate_version));
  assert.equal(released.status, 200, JSON.stringify(released.data));
  assert.equal(released.data.claim, null);
  assert.equal(released.data.queue_state, 'awaiting_review');
  assert.equal(released.data.claims[0].state, 'released');
  assert.equal(released.data.claims[0].end_reason, 'admin_released');
  assert.equal((await request(releasePath, { reason: '再放一次。' }, Number(claimed.data.claim.aggregate_version) + 1)).data.code, 'maintainer_claim_inactive');
  assert.equal((await request(`/review-center/claims/${randomUUID()}/release`, { reason: '沒有這筆。' }, 1)).status, 404);
  const waiting = await request('/review-center/pulls?queue=awaiting_review');
  assert.equal(waiting.data.items.some((item: { pull_id: string }) => item.pull_id === low), true);
  const actions = (await pool.query(`SELECT action FROM platform_admin_audit ORDER BY created_at`)).rows.map(row => row.action);
  assert.ok(actions.includes('maintainer_claim_self'));
  assert.ok(actions.includes('maintainer_claim_assign'));
  assert.ok(actions.includes('maintainer_claim_release'));
  assert.ok(actions.includes('maintainer_pull_pause'));
  assert.ok(actions.includes('maintainer_pull_resume'));
  assert.equal(JSON.stringify(released.data).includes(TOKEN), false);
});

test('two concurrent claims leave exactly one active row', async () => {
  const repository = await insertRepo();
  const low = await insertPull(repository, 1);
  await asSelf();
  const path = `/review-center/pulls/${low}/claim`;
  const [first, second] = await Promise.all([request(path, {}, 1), request(path, {}, 1)]);
  const statuses = [first.status, second.status].sort();
  assert.equal(statuses[0], 200);
  assert.ok(statuses[1] === 409 || statuses[1] === 412, JSON.stringify(statuses));
  assert.equal((await pool.query(`SELECT count(*) FROM maintainer_review_claims WHERE pull_id=$1 AND state='active'`, [low])).rows[0].count, '1');
});

test('request_reviewers off stores not_requested and enqueues nothing', async () => {
  const repository = await insertRepo({ request_reviewers: false });
  const low = await insertPull(repository, 1);
  await asSelf();
  const claimed = await request(`/review-center/pulls/${low}/claim`, {}, 1);
  assert.equal(claimed.status, 200, JSON.stringify(claimed.data));
  assert.equal(claimed.data.claim.github_request_state, 'not_requested');
  assert.equal((await pool.query('SELECT count(*) FROM maintainer_jobs')).rows[0].count, '0');
});

test('the tick expires, releases and completes claims, then rederives the pull', async () => {
  const repository = await insertRepo();
  const selfUser = await member('tick-reviewer@example.invalid', '計時審查者');
  await link(selfUser, '77001', 'self-reviewer');
  const reviewerId = await reviewer(selfUser, '77001', 'self-reviewer', 'high');
  const expiredPull = await insertPull(repository, 1);
  const expired = await insertClaim(expiredPull, reviewerId, { expires: '2026-09-30T11:00:00Z', github: 'requested' });
  const closedPull = await insertPull(repository, 2, { state: 'closed', queue: 'closed' });
  const closed = await insertClaim(closedPull, reviewerId, { github: 'requested' });
  const inactivePull = await insertPull(repository, 3);
  const inactiveReviewer = await reviewer(selfUser, '77003', 'idle-reviewer', 'high', false);
  const inactive = await insertClaim(inactivePull, inactiveReviewer, { github: 'requested' });
  const lowUser = await member('low-reviewer@example.invalid', '低風險');
  await link(lowUser, '77004', 'low-reviewer');
  const lowReviewer = await reviewer(lowUser, '77004', 'low-reviewer', 'low');
  const rankPull = await insertPull(repository, 4, { file: '.github/workflows/verify.yml', queue: 'needs_owner', risk: 'high' });
  const ranked = await insertClaim(rankPull, lowReviewer, { github: 'requested' });
  const donePull = await insertPull(repository, 5);
  const done = await insertClaim(donePull, reviewerId);
  await insertReview(donePull, '77001', 'APPROVED', '2026-09-30T11:30:00Z');
  const changesPull = await insertPull(repository, 6);
  const changes = await insertClaim(changesPull, reviewerId);
  await insertReview(changesPull, '77001', 'CHANGES_REQUESTED', '2026-09-30T11:30:00Z');
  const commentPull = await insertPull(repository, 7);
  const comment = await insertClaim(commentPull, reviewerId);
  await insertReview(commentPull, '77001', 'COMMENTED', '2026-09-30T11:30:00Z');
  await pool.query(`UPDATE maintainer_pull_requests SET recheck_at=$2 WHERE pull_id=$1`, [commentPull, CLOCK]);
  const earlyPull = await insertPull(repository, 8);
  const early = await insertClaim(earlyPull, reviewerId, { created: '2026-09-30T11:00:00Z' });
  await insertReview(earlyPull, '77001', 'APPROVED', '2026-09-30T10:00:00Z');
  const stalePull = await insertPull(repository, 9);
  const stale = await insertClaim(stalePull, reviewerId);
  await insertReview(stalePull, '77001', 'APPROVED', '2026-09-30T11:30:00Z', OLD);

  const summary = await tick('off');
  assert.equal(summary.claims_expired, 1);
  assert.equal(summary.claims_released, 3);
  assert.equal(summary.claims_completed, 3);
  assert.equal((await claimRow(expired)).state, 'expired');
  assert.equal((await claimRow(expired)).end_reason, null);
  assert.equal((await claimRow(expired)).github_request_state, 'failed');
  assert.equal((await claimRow(expired)).github_request_error, 'writes_disabled');
  assert.equal(await queueOf(expiredPull), 'awaiting_review');
  assert.equal((await claimRow(closed)).end_reason, 'pull_closed');
  assert.equal((await claimRow(closed)).github_request_state, 'requested');
  assert.equal((await claimRow(inactive)).end_reason, 'reviewer_inactive');
  assert.equal((await claimRow(inactive)).github_request_state, 'failed');
  assert.equal((await claimRow(inactive)).github_request_error, 'writes_disabled');
  assert.equal((await claimRow(ranked)).end_reason, 'reviewer_rank_too_low');
  assert.equal((await claimRow(ranked)).github_request_state, 'failed');
  assert.equal((await claimRow(ranked)).github_request_error, 'writes_disabled');
  assert.equal((await claimRow(done)).end_reason, 'review_submitted');
  assert.equal((await claimRow(done)).github_request_state, 'not_requested');
  assert.equal(await queueOf(donePull), 'ready');
  assert.equal((await claimRow(changes)).end_reason, 'review_submitted');
  assert.equal(await queueOf(changesPull), 'needs_author');
  assert.equal((await claimRow(comment)).state, 'active');
  assert.equal(await queueOf(commentPull), 'in_review');
  assert.equal((await claimRow(early)).state, 'active');
  assert.equal((await claimRow(stale)).end_reason, 'review_submitted');
  assert.equal(await queueOf(stalePull), 'awaiting_review');
  const removals = (await pool.query(`SELECT state, last_error FROM maintainer_jobs WHERE kind='remove_reviewer_request' ORDER BY created_at`)).rows;
  assert.equal(removals.length, 3);
  assert.deepEqual(removals.map(row => row.state), ['failed', 'failed', 'failed']);
  assert.deepEqual(removals.map(row => row.last_error), ['writes_disabled', 'writes_disabled', 'writes_disabled']);
  assert.equal(summary.jobs_done, 0);
  assert.equal(summary.jobs_failed, 3);
  assert.equal(summary.github_requests, 0);
});

test('requested-reviewer jobs honor the worker switch, the status code and a release during the call', async () => {
  const repository = await insertRepo({ request_reviewers: true });
  const userId = await member('job-reviewer@example.invalid', '工作審查者');
  await link(userId, '77001', 'self-reviewer');
  const reviewerId = await reviewer(userId, '77001', 'self-reviewer', 'high');
  const pullId = await insertPull(repository, 7);
  const claimId = await insertClaim(pullId, reviewerId, { github: 'pending' });
  await enqueueMaintainerJob(pool, repository, 'request_reviewer', claimId, CLOCK);

  const skipped = await tick('off');
  assert.equal(skipped.jobs_done, 1);
  assert.equal(skipped.github_requests, 0);
  assert.equal((await claimRow(claimId)).github_request_state, 'skipped');
  assert.equal((await claimRow(claimId)).github_request_error, 'writes_disabled');

  await pool.query(`UPDATE maintainer_review_claims SET github_request_state='pending', github_request_error=NULL WHERE claim_id=$1`, [claimId]);
  await pool.query(`UPDATE maintainer_jobs SET state='queued', attempts=0, run_after=$2, finished_at=NULL, last_error=NULL WHERE payload->>'claim_id'=$1`, [claimId, CLOCK]);
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ method: init?.method ?? 'GET', path: url.pathname, body });
    if (url.pathname.endsWith('/access_tokens')) {
      return Response.json({ token: 'ghs_synthetic_token_value', permissions: (body as { permissions: Record<string, string> }).permissions }, { status: 201 });
    }
    return new Response('{}', { status: 201 });
  };
  const posted = await tick('requested_reviewers', fetcher, () => CLOCK);
  assert.equal(posted.jobs_done, 1, JSON.stringify(posted));
  const mint = calls.find(call => call.path.endsWith('/access_tokens'));
  const write = calls.find(call => call.path.endsWith('/requested_reviewers'));
  assert.equal(mint?.method, 'POST');
  assert.deepEqual((mint?.body as { repository_ids: number[] }).repository_ids, [9001]);
  assert.deepEqual((mint?.body as { permissions: Record<string, string> }).permissions, { metadata: 'read', pull_requests: 'write' });
  assert.equal(write?.method, 'POST');
  assert.deepEqual(write?.body, { reviewers: ['self-reviewer'] });
  assert.equal((await claimRow(claimId)).github_request_state, 'requested');

  await pool.query(`UPDATE maintainer_review_claims SET github_request_state='pending', github_request_error=NULL WHERE claim_id=$1`, [claimId]);
  await enqueueMaintainerJob(pool, repository, 'request_reviewer', claimId, CLOCK);
  const rejected = await tick('requested_reviewers', async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/access_tokens')) return Response.json({ token: 'ghs_synthetic_token_value', permissions: { metadata: 'read', pull_requests: 'write' } }, { status: 201 });
    return new Response('no', { status: 422 });
  }, () => CLOCK);
  assert.equal(rejected.jobs_failed, 1);
  assert.equal((await claimRow(claimId)).github_request_state, 'failed');
  assert.equal((await claimRow(claimId)).github_request_error, 'github_http_422');
  assert.equal((await pool.query(`SELECT state, attempts FROM maintainer_jobs WHERE payload->>'claim_id'=$1 AND kind='request_reviewer' ORDER BY created_at DESC`, [claimId])).rows[0].state, 'failed');

  const deniedPull = await insertPull(repository, 8);
  const denied = await insertClaim(deniedPull, reviewerId, { github: 'pending' });
  await enqueueMaintainerJob(pool, repository, 'request_reviewer', denied, CLOCK);
  let reviewerPosts = 0;
  await tick('requested_reviewers', async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/requested_reviewers')) reviewerPosts += 1;
    return new Response('missing permission', { status: 422 });
  }, () => CLOCK);
  assert.equal(reviewerPosts, 0);
  assert.equal((await claimRow(denied)).github_request_error, 'github_permission_missing');

  await pool.query(`UPDATE maintainer_review_claims SET state='released', end_reason='admin_released', ended_at=now(), github_request_state='removing' WHERE claim_id=$1`, [claimId]);
  await enqueueMaintainerJob(pool, repository, 'remove_reviewer_request', claimId, CLOCK);
  const removedCalls: string[] = [];
  await tick('requested_reviewers', async (input, init) => {
    const url = new URL(String(input));
    removedCalls.push(`${init?.method ?? 'GET'} ${url.pathname}`);
    if (url.pathname.endsWith('/access_tokens')) return Response.json({ token: 'ghs_synthetic_token_value', permissions: { metadata: 'read', pull_requests: 'write' } }, { status: 201 });
    return new Response('{}', { status: 200 });
  }, () => CLOCK);
  assert.ok(removedCalls.some(line => line.startsWith('DELETE ') && line.endsWith('/requested_reviewers')));
  assert.equal((await claimRow(claimId)).github_request_state, 'removed');

  const raced = await insertPull(repository, 9);
  const racedClaim = await insertClaim(raced, reviewerId, { github: 'pending' });
  await enqueueMaintainerJob(pool, repository, 'request_reviewer', racedClaim, CLOCK);
  const racedCalls: string[] = [];
  await tick('requested_reviewers', async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    racedCalls.push(`${method} ${url.pathname}`);
    if (url.pathname.endsWith('/access_tokens')) return Response.json({ token: 'ghs_synthetic_token_value', permissions: { metadata: 'read', pull_requests: 'write' } }, { status: 201 });
    if (method === 'POST') {
      await pool.query(`UPDATE maintainer_review_claims SET state='released', end_reason='admin_released', ended_at=now() WHERE claim_id=$1 AND state='active'`, [racedClaim]);
      return new Response('x'.repeat(70_000), { status: 201 });
    }
    return new Response('{}', { status: 200 });
  }, () => CLOCK);
  assert.ok(racedCalls.some(line => line.startsWith('DELETE ')));
  assert.equal((await claimRow(racedClaim)).github_request_state, 'removed');
  assert.notEqual((await claimRow(racedClaim)).github_request_state, 'requested');

  const closedPull = await insertPull(repository, 10);
  const closedClaim = await insertClaim(closedPull, reviewerId, { github: 'pending' });
  await enqueueMaintainerJob(pool, repository, 'request_reviewer', closedClaim, CLOCK);
  let closedDeletes = 0;
  await tick('requested_reviewers', async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    if (url.pathname.endsWith('/access_tokens')) return Response.json({ token: 'ghs_synthetic_token_value', permissions: { metadata: 'read', pull_requests: 'write' } }, { status: 201 });
    if (method === 'POST') {
      await pool.query(`UPDATE maintainer_review_claims SET state='released', end_reason='pull_closed', ended_at=now() WHERE claim_id=$1`, [closedClaim]);
      return new Response('{}', { status: 201 });
    }
    closedDeletes += 1;
    return new Response('{}', { status: 200 });
  }, () => CLOCK);
  assert.equal(closedDeletes, 0);
  assert.equal((await claimRow(closedClaim)).github_request_state, 'requested');

  const limitedPull = await insertPull(repository, 11);
  const limited = await insertClaim(limitedPull, reviewerId, { github: 'pending' });
  await enqueueMaintainerJob(pool, repository, 'request_reviewer', limited, CLOCK);
  const limitedSummary = await tick('requested_reviewers', async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/access_tokens')) return Response.json({ token: 'ghs_synthetic_token_value', permissions: { metadata: 'read', pull_requests: 'write' } }, { status: 201 });
    return new Response('slow', { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 120) } });
  }, () => CLOCK);
  assert.equal(limitedSummary.stopped, 'rate_limit');
  assert.equal(limitedSummary.jobs_released, 1);
  const limitedJob = (await pool.query(`SELECT state, attempts FROM maintainer_jobs WHERE payload->>'claim_id'=$1 AND kind='request_reviewer'`, [limited])).rows[0];
  assert.equal(limitedJob.state, 'queued');
  assert.equal(limitedJob.attempts, 0);
  assert.equal((await claimRow(limited)).github_request_state, 'pending');
});

function countingFetcher() {
  const calls: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    calls.push(`${init?.method ?? 'GET'} ${url.pathname}`);
    return new Response('should-not-be-called', { status: 500 });
  };
  return { calls, fetcher };
}
async function waitUntilBlocked(pid: number) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const count = (await pool.query('SELECT count(*) FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))', [pid])).rows[0].count;
    if (Number(count) > 0) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail('expected a backend to block on the held pull row');
}

test('a request_reviewer re-run leaves an already requested claim requested', async () => {
  const repository = await insertRepo({ request_reviewers: true });
  const userId = await member('rerun-request@example.invalid', '再跑請求');
  await link(userId, '77041', 'rerun-request');
  const reviewerId = await reviewer(userId, '77041', 'rerun-request', 'high');
  const pullId = await insertPull(repository, 21);
  const claimId = await insertClaim(pullId, reviewerId, { github: 'requested' });
  await enqueueMaintainerJob(pool, repository, 'request_reviewer', claimId, CLOCK);
  const seen = countingFetcher();
  const summary = await tick('requested_reviewers', seen.fetcher, () => CLOCK);
  assert.equal(seen.calls.length, 0);
  assert.equal(summary.github_requests, 0);
  assert.equal((await claimRow(claimId)).state, 'active');
  assert.equal((await claimRow(claimId)).github_request_state, 'requested');
  assert.equal((await claimRow(claimId)).github_request_error, null);
  const job = (await pool.query(`SELECT state, last_error FROM maintainer_jobs WHERE kind='request_reviewer' AND payload->>'claim_id'=$1`, [claimId])).rows[0];
  assert.equal(job.state, 'done');
  assert.equal(job.last_error, 'claim_state_changed');
  const version = Number((await pool.query('SELECT aggregate_version FROM maintainer_review_claims WHERE claim_id=$1', [claimId])).rows[0].aggregate_version);
  const released = await request(`/review-center/claims/${claimId}/release`, { reason: '再跑之後仍可放開。' }, version);
  assert.equal(released.status, 200, JSON.stringify(released.data));
  assert.equal((await claimRow(claimId)).github_request_state, 'removing');
  const removal = (await pool.query(`SELECT dedupe_key, state FROM maintainer_jobs WHERE kind='remove_reviewer_request' AND payload->>'claim_id'=$1`, [claimId])).rows[0];
  assert.equal(removal.dedupe_key, `remove_reviewer_request:${claimId}`);
  assert.equal(removal.state, 'queued');
});

test('a remove_reviewer_request re-run leaves an already removed claim removed', async () => {
  const repository = await insertRepo({ request_reviewers: true });
  const userId = await member('rerun-remove@example.invalid', '再跑移除');
  await link(userId, '77042', 'rerun-remove');
  const reviewerId = await reviewer(userId, '77042', 'rerun-remove', 'high');
  const pullId = await insertPull(repository, 22);
  const claimId = await insertClaim(pullId, reviewerId, { github: 'removed' });
  await pool.query(`UPDATE maintainer_review_claims SET state='released', end_reason='admin_released', ended_at=now() WHERE claim_id=$1`, [claimId]);
  await enqueueMaintainerJob(pool, repository, 'remove_reviewer_request', claimId, CLOCK);
  const seen = countingFetcher();
  const summary = await tick('requested_reviewers', seen.fetcher, () => CLOCK);
  assert.equal(seen.calls.length, 0);
  assert.equal(summary.github_requests, 0);
  assert.equal((await claimRow(claimId)).github_request_state, 'removed');
  assert.equal((await claimRow(claimId)).github_request_error, null);
  const job = (await pool.query(`SELECT state, last_error FROM maintainer_jobs WHERE kind='remove_reviewer_request' AND payload->>'claim_id'=$1`, [claimId])).rows[0];
  assert.equal(job.state, 'done');
  assert.equal(job.last_error, 'claim_state_changed');
});

test('a removal that cannot write fails the claim instead of skipping it', async () => {
  const repository = await insertRepo({ request_reviewers: true });
  const userId = await member('removal-off@example.invalid', '移除關閉');
  await link(userId, '77043', 'removal-off');
  const reviewerId = await reviewer(userId, '77043', 'removal-off', 'high');
  const offPull = await insertPull(repository, 23);
  const offClaim = await insertClaim(offPull, reviewerId, { github: 'removing' });
  await pool.query(`UPDATE maintainer_review_claims SET state='released', end_reason='admin_released', ended_at=now() WHERE claim_id=$1`, [offClaim]);
  await enqueueMaintainerJob(pool, repository, 'remove_reviewer_request', offClaim, CLOCK);
  const offSeen = countingFetcher();
  const off = await tick('off', offSeen.fetcher, () => CLOCK);
  assert.equal(offSeen.calls.length, 0);
  assert.equal(off.github_requests, 0);
  assert.equal((await claimRow(offClaim)).github_request_state, 'failed');
  assert.equal((await claimRow(offClaim)).github_request_error, 'writes_disabled');
  const offJob = (await pool.query(`SELECT state, last_error FROM maintainer_jobs WHERE payload->>'claim_id'=$1`, [offClaim])).rows[0];
  assert.equal(offJob.state, 'failed');
  assert.equal(offJob.last_error, 'writes_disabled');

  await pool.query(`UPDATE maintainer_repositories SET settings=$2::jsonb WHERE repository_id=$1`, [repository, JSON.stringify({ request_reviewers: false })]);
  const settingPull = await insertPull(repository, 24);
  const settingClaim = await insertClaim(settingPull, reviewerId, { github: 'removing' });
  await pool.query(`UPDATE maintainer_review_claims SET state='expired', ended_at=now() WHERE claim_id=$1`, [settingClaim]);
  await enqueueMaintainerJob(pool, repository, 'remove_reviewer_request', settingClaim, CLOCK);
  const settingSeen = countingFetcher();
  const setting = await tick('requested_reviewers', settingSeen.fetcher, () => CLOCK);
  assert.equal(settingSeen.calls.length, 0);
  assert.equal(setting.github_requests, 0);
  assert.equal((await claimRow(settingClaim)).github_request_state, 'failed');
  assert.equal((await claimRow(settingClaim)).github_request_error, 'writes_disabled');
  const settingJob = (await pool.query(`SELECT state, last_error FROM maintainer_jobs WHERE payload->>'claim_id'=$1 AND kind='remove_reviewer_request'`, [settingClaim])).rows[0];
  assert.equal(settingJob.state, 'failed');
  assert.equal(settingJob.last_error, 'writes_disabled');
});

test('settling an expired claim locks the pull before the claim', { timeout: 15_000 }, async () => {
  const repository = await insertRepo();
  const pullId = await insertPull(repository, 31);
  const userId = await member('lock-settle@example.invalid', '鎖結算');
  await link(userId, '77051', 'lock-settle');
  const reviewerId = await reviewer(userId, '77051', 'lock-settle', 'high');
  const claimId = await insertClaim(pullId, reviewerId, { expires: '2026-09-30T11:00:00Z' });
  const holder = await pool.connect();
  let pending: Promise<{ value?: { expired: number }; error?: unknown }> | undefined;
  try {
    await holder.query('BEGIN');
    const pid = (await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
    await holder.query('SELECT pull_id FROM maintainer_pull_requests WHERE pull_id=$1 FOR UPDATE', [pullId]);
    pending = settleMaintainerClaims(pool, CLOCK).then(value => ({ value }), error => ({ error }));
    await waitUntilBlocked(pid);
    const nowait = await holder.query('SELECT 1 FROM maintainer_review_claims WHERE claim_id=$1 FOR UPDATE NOWAIT', [claimId]);
    assert.equal(nowait.rowCount, 1);
    await holder.query('COMMIT');
    const settled = await pending;
    assert.equal(settled.error, undefined);
    assert.equal(settled.value?.expired, 1);
    assert.equal((await claimRow(claimId)).state, 'expired');
  } finally {
    await holder.query('ROLLBACK').catch(() => undefined);
    holder.release();
    if (pending) await pending;
  }
});

test('releasing a claim locks the pull before the claim', { timeout: 15_000 }, async () => {
  const repository = await insertRepo();
  const pullId = await insertPull(repository, 32);
  const userId = await member('lock-release@example.invalid', '鎖釋放');
  await link(userId, '77052', 'lock-release');
  const reviewerId = await reviewer(userId, '77052', 'lock-release', 'high');
  const claimId = await insertClaim(pullId, reviewerId);
  const holder = await pool.connect();
  let pending: Promise<{ status: number; data: any }> | undefined;
  try {
    await holder.query('BEGIN');
    const pid = (await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
    await holder.query('SELECT pull_id FROM maintainer_pull_requests WHERE pull_id=$1 FOR UPDATE', [pullId]);
    pending = request(`/review-center/claims/${claimId}/release`, { reason: '等拉取請求的鎖放開。' }, 1);
    await waitUntilBlocked(pid);
    const nowait = await holder.query('SELECT 1 FROM maintainer_review_claims WHERE claim_id=$1 FOR UPDATE NOWAIT', [claimId]);
    assert.equal(nowait.rowCount, 1);
    await holder.query('COMMIT');
    const released = await pending;
    assert.equal(released.status, 200, JSON.stringify(released.data));
    assert.equal((await claimRow(claimId)).state, 'released');
  } finally {
    await holder.query('ROLLBACK').catch(() => undefined);
    holder.release();
    if (pending) await pending.catch(() => undefined);
  }
});

test('a deadlock inside a claim command is a retryable 409', async () => {
  const repository = await insertRepo();
  const pullId = await insertPull(repository, 33);
  await asSelf();
  const key = randomUUID();
  await pool.query(`CREATE FUNCTION maintainer_claim_deadlock_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'deadlock detected' USING ERRCODE = '40P01'; END $$`);
  await pool.query('CREATE TRIGGER maintainer_claim_deadlock_test BEFORE INSERT ON maintainer_review_claims FOR EACH ROW EXECUTE FUNCTION maintainer_claim_deadlock_test()');
  try {
    const denied = await request(`/review-center/pulls/${pullId}/claim`, {}, 1, key);
    assert.equal(denied.status, 409, JSON.stringify(denied.data));
    assert.equal(denied.data.code, 'maintainer_write_conflict');
    assert.match(denied.data.detail, /請重新整理後再試一次/);
    assert.equal((await pool.query('SELECT count(*) FROM maintainer_review_claims WHERE pull_id=$1', [pullId])).rows[0].count, '0');
    assert.equal((await pool.query('SELECT count(*) FROM platform_admin_receipts WHERE idempotency_key=$1', [key])).rows[0].count, '0');
  } finally {
    await pool.query('DROP TRIGGER IF EXISTS maintainer_claim_deadlock_test ON maintainer_review_claims');
    await pool.query('DROP FUNCTION IF EXISTS maintainer_claim_deadlock_test()');
  }
  const retried = await request(`/review-center/pulls/${pullId}/claim`, {}, 1, key);
  assert.equal(retried.status, 200, JSON.stringify(retried.data));
});

