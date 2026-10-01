import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createLocalJWKSet, exportJWK, exportPKCS8, generateKeyPair, SignJWT } from 'jose';
import { createPool, LOCAL_DATABASE_URL } from '../../packages/db/index.js';
import { migrate } from '../../scripts/database.js';
import { seedLocal, DEMO_USERS, DEMO_COMMUNITY, DEMO_PASSWORD } from '../../packages/testing/seed.js';
import { createApp } from '../../apps/platform-api/src/app.js';
import { createAdminAccessVerifier } from '../../modules/platform-admin/access.js';
import { login } from '../../modules/identity-membership/service.js';
import { runMaintainerTick } from '../../modules/repo-maintainer/tick.js';
import { settleMaintainerClaims } from '../../modules/repo-maintainer/claims.js';

const origin = 'http://127.0.0.1:4310';
const databaseUrl = process.env.TEST_DATABASE_URL ?? LOCAL_DATABASE_URL;
const schema = `fp_mguild_${process.pid}_${Date.now()}`;
const database = createPool(databaseUrl);
const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 4 });
const issuer = 'https://test-team.cloudflareaccess.com';
const audience = 'admin-route-tests';
const adminEmail = 'admin@example.invalid';
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
let githubSeq = 9000;

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
  githubSeq = 9000;
  await pool.query('TRUNCATE communities, login_attempts, auth_rate_limits CASCADE');
  await seedLocal(pool);
  await pool.query('INSERT INTO platform_admins (admin_id, community_id, email, display_name) VALUES ($1,$2,$3,$4)', [adminId, DEMO_COMMUNITY, adminEmail, 'Verified Admin']);
  await pool.query(`UPDATE maintainer_worker_state SET next_installation_sync_at='2099-01-01T00:00:00Z', last_error=NULL WHERE singleton`);
  app = createApp(pool, origin, 'local', { adminVerifier: verifier });
  jwt = await sign(adminEmail);
  csrf = (await verifier(new Request(origin, { headers: { 'Cf-Access-Jwt-Assertion': jwt } }))).csrfToken;
});
async function sign(claimedEmail: string) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ type: 'app', email: claimedEmail, sub: 'verified-human-fixture', iss: issuer, aud: audience, iat: now, nbf: now, exp: now + 600 }).setProtectedHeader({ alg: 'RS256', kid: 'admin-test' }).sign(pair.privateKey);
}
async function adminRequest(path: string, body?: unknown, version?: number, key: string = randomUUID()) {
  const headers: Record<string, string> = { Origin: origin, 'Cf-Access-Jwt-Assertion': jwt, 'X-Admin-CSRF': csrf };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    headers['Idempotency-Key'] = key;
    if (version !== undefined) headers['If-Match'] = `"${version}"`;
  }
  const response = await app.request(origin + '/admin/api' + path, { method: body === undefined ? 'GET' : 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  return { status: response.status, data: text ? JSON.parse(text) : null };
}
async function memberRequest(auth: { token: string; actor: { csrf_token: string } }, path: string, body?: unknown, version?: number, key: string = randomUUID()) {
  const headers: Record<string, string> = { Origin: origin, Cookie: `freedom_local_session=${auth.token}`, 'X-CSRF-Token': auth.actor.csrf_token };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    headers['Idempotency-Key'] = key;
    if (version !== undefined) headers['If-Match'] = `"${version}"`;
  }
  const response = await app.request(origin + '/api/v1' + path, { method: body === undefined ? 'GET' : 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  return { status: response.status, data: text ? JSON.parse(text) : null };
}
async function insertRepo(over: { github?: string; guild?: string | null; open?: boolean; scope?: string | null; full?: string; book?: string | null } = {}) {
  const id = randomUUID();
  githubSeq += 1;
  const book = over.book ?? null;
  await pool.query(`INSERT INTO maintainer_repositories
    (repository_id, community_id, github_repository_id, installation_id, full_name, default_branch, installation_state, mode, guild_key, scope_kind, open_to_guilds, skill_book_id, next_sweep_at)
    VALUES ($1,$2,$3,'77',$4,'main','active','observe',$5,$6,$7,$8,'2099-01-01T00:00:00Z')`,
  [id, DEMO_COMMUNITY, over.github ?? String(githubSeq), over.full ?? 'FreeTWAI-AI/freedom-platform', over.guild ?? null, book ? 'skill_book' : (over.scope ?? null), over.open ?? false, book]);
  return id;
}
async function insertPull(repository: string, number: number, author = '42') {
  const id = randomUUID();
  await pool.query(`INSERT INTO maintainer_pull_requests (
    pull_id, repository_id, number, github_pull_id, title, html_url, state, is_draft, author_github_id, author_login, author_type,
    author_association, is_fork, head_sha, base_ref, base_sha, labels, additions, deletions, changed_files, github_created_at,
    github_updated_at, head_observed_at, attention_reasons, queue_state, queue_reasons, policy_version, synced_at)
    VALUES ($1,$2,$3,$4,$5,$6,'open',false,$7,'octocat','User','CONTRIBUTOR',false,$8,'main',$9,'{}',1,0,1,$10,$10,$10,'[]','awaiting_review','[]','2026-10-01.1',$10)`,
  [id, repository, number, String(8000 + number + githubSeq), `PR ${number}`, `https://github.com/FreeTWAI-AI/freedom-platform/pull/${number}`, author, SHA, OLD, '2026-09-30T11:00:00Z']);
  await pool.query(`INSERT INTO maintainer_checks (pull_id, head_sha, source, name, app_slug, status, conclusion) VALUES ($1,$2,'check_run','verify','github-actions','completed','success')`, [id, SHA]);
  return id;
}
async function link(userId: string, githubId: string, loginName: string) {
  await pool.query(`INSERT INTO github_social_connections (user_id, community_id, github_user_id, github_login, encrypted_tokens) VALUES ($1,$2,$3,$4,$5)`, [userId, DEMO_COMMUNITY, githubId, loginName, TOKEN]);
}
async function lead(userId: string, guildKey: string) {
  await pool.query(`INSERT INTO positioning_profession_memberships (membership_id, community_id, user_id, guild_key, state)
    VALUES ($1,$2,$3,$4,'active') ON CONFLICT (community_id, user_id, guild_key) DO UPDATE SET state='active', left_at=NULL`,
  [randomUUID(), DEMO_COMMUNITY, userId, guildKey]);
  await pool.query(`INSERT INTO positioning_guild_officers (community_id, guild_key, user_id) VALUES ($1,$2,$3)
    ON CONFLICT (community_id, guild_key) DO UPDATE SET user_id=$3`, [DEMO_COMMUNITY, guildKey, userId]);
}
async function insertClaim(pullId: string, userId: string, githubId: string, loginName: string, guildKey: string | null, expires: string | null = null) {
  const id = randomUUID();
  await pool.query(`INSERT INTO maintainer_review_claims (
    claim_id, pull_id, reviewer_user_id, reviewer_github_id, reviewer_login, acting_as, guild_key,
    claimed_by_user, assignment, head_sha, created_at, expires_at, state, github_request_state)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$3,'self',$8,'2026-09-30T10:00:00Z',$9,'active','not_requested')`,
  [id, pullId, userId, githubId, loginName, guildKey ? 'guild_leader' : 'admin', guildKey, SHA, expires]);
  return id;
}
async function insertReview(pullId: string, githubId: string, state: string) {
  reviewSeq += 1;
  await pool.query(`INSERT INTO maintainer_reviews (pull_id, github_review_id, reviewer_github_id, reviewer_login, reviewer_type, reviewer_association, state, commit_id, submitted_at)
    VALUES ($1,$2,$3,'ada','User','MEMBER',$4,$5,'2026-09-30T11:30:00Z')`, [pullId, String(reviewSeq), githubId, state, SHA]);
}
async function eligible(repositoryId: string) {
  return (await pool.query(`SELECT user_id, github_user_id, acting_as, guild_key, skill_book_id FROM maintainer_eligible_reviewers WHERE repository_id=$1 ORDER BY acting_as, guild_key, skill_book_id`, [repositoryId])).rows;
}
async function appointBook(userId: string, bookId: string, active = true) {
  await pool.query(`INSERT INTO skill_editorial_ownership (book_id, community_id) VALUES ($1,$2) ON CONFLICT (book_id) DO NOTHING`, [bookId, DEMO_COMMUNITY]);
  await pool.query(`INSERT INTO skill_book_maintainers (book_id, community_id, user_id, appointed_by, active)
    VALUES ($1,$2,$3,$4,$5)
    ON CONFLICT (book_id, user_id) DO UPDATE SET active=EXCLUDED.active, appointed_by=EXCLUDED.appointed_by`,
  [bookId, DEMO_COMMUNITY, userId, adminId, active]);
}
async function insertBookClaim(pullId: string, userId: string, githubId: string, loginName: string, bookId: string) {
  const id = randomUUID();
  await pool.query(`INSERT INTO maintainer_review_claims (
    claim_id, pull_id, reviewer_user_id, reviewer_github_id, reviewer_login, acting_as, guild_key, skill_book_id,
    claimed_by_user, assignment, head_sha, created_at, expires_at, state, github_request_state)
    VALUES ($1,$2,$3,$4,$5,'skill_book_maintainer',NULL,$6,$3,'self',$7,'2026-09-30T10:00:00Z',NULL,'active','not_requested')`,
  [id, pullId, userId, githubId, loginName, bookId, SHA]);
  return id;
}

test('the eligibility view follows admins, leaders, open repositories and a departed officer', async () => {
  const owned = await insertRepo({ guild: 'guild_ai_vibe', scope: 'module' });
  const open = await insertRepo({ open: true, full: 'FreeTWAI-AI/open-book' });
  const adminOnly = await insertRepo({ full: 'FreeTWAI-AI/central-core' });
  const other = await insertRepo({ guild: 'guild_platform_engineering', scope: 'skill_book', full: 'FreeTWAI-AI/platform-book' });
  const adminUser = randomUUID();
  await pool.query(`INSERT INTO users (user_id, community_id, email, display_name, password_hash, profession_membership_ref)
    SELECT $1, community_id, $2, '審核管理員', password_hash, $3 FROM users WHERE user_id=$4`,
  [adminUser, adminEmail, randomUUID(), DEMO_USERS[0].user_id]);
  await link(adminUser, '88001', 'admin-gh');
  assert.equal((await eligible(owned)).some(row => row.user_id === adminUser), false);
  await pool.query('UPDATE users SET email_verified_at=now() WHERE user_id=$1', [adminUser]);
  for (const repository of [owned, open, adminOnly, other]) {
    const rows = await eligible(repository);
    assert.equal(rows.some(row => row.user_id === adminUser && row.acting_as === 'admin' && row.guild_key === null), true, repository);
  }
  await pool.query('DELETE FROM github_social_connections WHERE user_id=$1', [adminUser]);
  assert.equal((await eligible(owned)).some(row => row.user_id === adminUser), false);
  await link(adminUser, '88001', 'admin-gh');

  const leader = DEMO_USERS[0].user_id;
  await lead(leader, 'guild_ai_vibe');
  await link(leader, '88002', 'leader-gh');
  const sees = async (repository: string) => (await eligible(repository)).some(row => row.user_id === leader && row.acting_as === 'guild_leader' && row.guild_key === 'guild_ai_vibe');
  assert.equal(await sees(owned), true);
  assert.equal(await sees(open), true);
  assert.equal(await sees(adminOnly), false);
  assert.equal(await sees(other), false);
  await pool.query(`DELETE FROM positioning_guild_officers WHERE community_id=$1 AND guild_key='guild_ai_vibe'`, [DEMO_COMMUNITY]);
  assert.equal(await sees(owned), false);
  await lead(leader, 'guild_ai_vibe');
  assert.equal(await sees(open), true);
  await pool.query(`UPDATE positioning_profession_memberships SET state='left', left_at=now() WHERE user_id=$1 AND guild_key='guild_ai_vibe'`, [leader]);
  assert.equal(await sees(open), false);
});

test('settlement expires only a dated claim, releases an ineligible reviewer, and adopts once', async () => {
  const leader = DEMO_USERS[0].user_id;
  const other = DEMO_USERS[1].user_id;
  await lead(leader, 'guild_ai_vibe');
  await lead(other, 'guild_platform_engineering');
  await link(leader, '88011', 'leader-one');
  await link(other, '88012', 'leader-two');

  const quiet = await insertRepo({ open: true, full: 'FreeTWAI-AI/never-expires' });
  const quietPull = await insertPull(quiet, 1);
  const lasting = await insertClaim(quietPull, leader, '88011', 'leader-one', 'guild_ai_vibe', null);
  const datedRepo = await insertRepo({ open: true, full: 'FreeTWAI-AI/does-expire' });
  const datedPull = await insertPull(datedRepo, 1);
  const dated = await insertClaim(datedPull, leader, '88011', 'leader-one', 'guild_ai_vibe', '2026-09-30T11:00:00Z');

  const moved = await insertRepo({ open: true, full: 'FreeTWAI-AI/will-move' });
  const movedPull = await insertPull(moved, 1);
  const movedClaim = await insertClaim(movedPull, leader, '88011', 'leader-one', 'guild_ai_vibe', null);
  await pool.query(`UPDATE maintainer_repositories SET guild_key='guild_marketing', open_to_guilds=false WHERE repository_id=$1`, [moved]);

  await lead(leader, 'guild_member_operations');
  const removed = await insertRepo({ guild: 'guild_member_operations', full: 'FreeTWAI-AI/officer-left' });
  const removedPull = await insertPull(removed, 1);
  const removedClaim = await insertClaim(removedPull, leader, '88011', 'leader-one', 'guild_member_operations', null);
  await pool.query(`DELETE FROM positioning_guild_officers WHERE community_id=$1 AND guild_key='guild_member_operations'`, [DEMO_COMMUNITY]);

  const open = await insertRepo({ open: true, scope: 'skill_book', full: 'FreeTWAI-AI/adopt-me' });
  await insertPull(open, 11);
  await insertPull(open, 12);
  const leftover = await insertPull(open, 13);
  const order = (await pool.query('SELECT pull_id, number FROM maintainer_pull_requests WHERE repository_id=$1 AND number IN (11, 12) ORDER BY pull_id', [open])).rows;
  const byPull = new Map(order.map(row => [row.pull_id, row.number]));
  const firstId = order[0].pull_id as string;
  const secondId = order[1].pull_id as string;
  const firstLeader = byPull.get(firstId) === 11 ? { user: leader, github: '88011', login: 'leader-one', guild: 'guild_ai_vibe' } : { user: other, github: '88012', login: 'leader-two', guild: 'guild_platform_engineering' };
  const secondLeader = firstLeader.user === leader ? { user: other, github: '88012', login: 'leader-two', guild: 'guild_platform_engineering' } : { user: leader, github: '88011', login: 'leader-one', guild: 'guild_ai_vibe' };
  await insertClaim(firstId, firstLeader.user, firstLeader.github, firstLeader.login, firstLeader.guild, null);
  await insertClaim(secondId, secondLeader.user, secondLeader.github, secondLeader.login, secondLeader.guild, null);
  await insertReview(firstId, firstLeader.github, 'APPROVED');
  await insertReview(secondId, secondLeader.github, 'APPROVED');

  const owned = await insertRepo({ guild: 'guild_ai_vibe', scope: 'module', full: 'FreeTWAI-AI/already-ours' });
  const ownedPull = await insertPull(owned, 1);
  await insertClaim(ownedPull, leader, '88011', 'leader-one', 'guild_ai_vibe', null);
  await insertReview(ownedPull, '88011', 'CHANGES_REQUESTED');

  const adminRepo = await insertRepo({ open: true, full: 'FreeTWAI-AI/admin-finishes' });
  const adminPull = await insertPull(adminRepo, 1);
  const adminUser = randomUUID();
  await pool.query(`INSERT INTO users (user_id, community_id, email, display_name, password_hash, profession_membership_ref, email_verified_at)
    SELECT $1, community_id, $2, '管理員本人', password_hash, $3, now() FROM users WHERE user_id=$4`,
  [adminUser, adminEmail, randomUUID(), DEMO_USERS[2].user_id]);
  await link(adminUser, '88013', 'admin-finisher');
  await pool.query(`INSERT INTO maintainer_review_claims (
    claim_id, pull_id, reviewer_user_id, reviewer_github_id, reviewer_login, acting_as, guild_key,
    claimed_by_admin, assignment, head_sha, created_at, expires_at, state, github_request_state)
    VALUES ($1,$2,$3,'88013','admin-finisher','admin',NULL,$4,'self',$5,'2026-09-30T10:00:00Z',NULL,'active','not_requested')`,
  [randomUUID(), adminPull, adminUser, adminId, SHA]);
  await insertReview(adminPull, '88013', 'APPROVED');

  const settled = await settleMaintainerClaims(pool, CLOCK);
  assert.equal(settled.adopted, 1);
  assert.equal(settled.expired, 1);
  assert.ok((await pool.query('SELECT recheck_at FROM maintainer_pull_requests WHERE pull_id=$1', [leftover])).rows[0].recheck_at);
  const later = await insertRepo({ open: true, full: 'FreeTWAI-AI/adopt-on-tick' });
  const laterPull = await insertPull(later, 1);
  await insertClaim(laterPull, leader, '88011', 'leader-one', 'guild_ai_vibe', null);
  await insertReview(laterPull, '88011', 'APPROVED');
  const summary = await runMaintainerTick(pool, { appId: '12345', organization: 'FreeTWAI-AI', privateKey, writes: 'off' }, {
    fetcher: async () => { throw new Error('unexpected fetch'); }, now: () => CLOCK,
  });
  assert.equal(summary.repositories_adopted, 1);
  assert.equal(summary.claims_expired, 0);
  assert.equal((await pool.query('SELECT guild_key, open_to_guilds FROM maintainer_repositories WHERE repository_id=$1', [later])).rows[0].guild_key, 'guild_ai_vibe');
  assert.equal((await pool.query('SELECT state FROM maintainer_review_claims WHERE claim_id=$1', [lasting])).rows[0].state, 'active');
  assert.equal((await pool.query('SELECT state FROM maintainer_review_claims WHERE claim_id=$1', [dated])).rows[0].state, 'expired');
  assert.equal((await pool.query(`SELECT end_reason FROM maintainer_review_claims WHERE claim_id=$1`, [movedClaim])).rows[0].end_reason, 'reviewer_not_eligible');
  assert.equal((await pool.query(`SELECT end_reason FROM maintainer_review_claims WHERE claim_id=$1`, [removedClaim])).rows[0].end_reason, 'reviewer_not_eligible');
  const adopted = (await pool.query('SELECT guild_key, open_to_guilds, scope_kind FROM maintainer_repositories WHERE repository_id=$1', [open])).rows[0];
  assert.equal(adopted.guild_key, firstLeader.guild);
  assert.equal(adopted.open_to_guilds, false);
  assert.equal(adopted.scope_kind, 'skill_book');
  const history = (await pool.query(`SELECT source, guild_key, changed_by_user, pull_id, open_to_guilds, reason FROM maintainer_ownership_changes WHERE repository_id=$1`, [open])).rows;
  assert.equal(history.length, 1);
  assert.equal(history[0].source, 'adopted');
  assert.equal(history[0].changed_by_user, firstLeader.user);
  assert.equal(history[0].pull_id, firstId);
  assert.equal(history[0].open_to_guilds, false);
  assert.match(history[0].reason, new RegExp(`審完 FreeTWAI-AI/adopt-me#${byPull.get(firstId)} 後歸到這個公會。`));
  assert.equal((await pool.query('SELECT guild_key FROM maintainer_repositories WHERE repository_id=$1', [owned])).rows[0].guild_key, 'guild_ai_vibe');
  assert.equal((await pool.query('SELECT guild_key, open_to_guilds FROM maintainer_repositories WHERE repository_id=$1', [adminRepo])).rows[0].open_to_guilds, true);
  assert.equal((await pool.query(`SELECT count(*) FROM maintainer_ownership_changes WHERE source='adopted' AND repository_id=$1`, [adminRepo])).rows[0].count, '0');
  const again = await settleMaintainerClaims(pool, CLOCK);
  assert.equal(again.adopted, 0);
});

test('a guild leader sees their own and open pulls, claims one guild, and releases only their claim', async () => {
  const mine = await insertRepo({ guild: 'guild_ai_vibe', scope: 'module', full: 'FreeTWAI-AI/our-module' });
  const open = await insertRepo({ open: true, full: 'FreeTWAI-AI/unclaimed-book' });
  const foreign = await insertRepo({ guild: 'guild_platform_engineering', full: 'FreeTWAI-AI/their-module' });
  const hidden = await insertRepo({ full: 'FreeTWAI-AI/admin-only' });
  const ownPull = await insertPull(mine, 1);
  const openPull = await insertPull(open, 2);
  const foreignPull = await insertPull(foreign, 3);
  const hiddenPull = await insertPull(hidden, 4);
  const stranger = await login(pool, DEMO_USERS[2].email, DEMO_PASSWORD);
  assert.equal((await memberRequest(stranger, '/guild-reviews?queue=open')).status, 403);
  assert.equal((await memberRequest(stranger, '/guild-reviews?queue=open')).data.code, 'review_access_required');

  await lead(DEMO_USERS[0].user_id, 'guild_ai_vibe');
  await lead(DEMO_USERS[0].user_id, 'guild_marketing');
  const leader = await login(pool, DEMO_USERS[0].email, DEMO_PASSWORD);
  const listed = await memberRequest(leader, '/guild-reviews?queue=open');
  assert.equal(listed.status, 200, JSON.stringify(listed.data));
  const ids = listed.data.items.map((item: { pull_id: string }) => item.pull_id);
  assert.ok(ids.includes(ownPull));
  assert.ok(ids.includes(openPull));
  assert.equal(ids.includes(foreignPull), false);
  assert.equal(ids.includes(hiddenPull), false);
  assert.equal(listed.data.viewer.github_login, null);
  assert.match(listed.data.viewer.reason, /連結 GitHub/);
  assert.equal((await memberRequest(leader, `/guild-reviews/${foreignPull}`)).status, 404);
  assert.equal((await memberRequest(leader, `/guild-reviews/${hiddenPull}`)).status, 404);
  const unlinked = await memberRequest(leader, `/guild-reviews/${openPull}/claim`, {}, 1);
  assert.equal(unlinked.status, 409);
  assert.equal(unlinked.data.code, 'maintainer_claim_identity_required');
  assert.match(unlinked.data.detail, /連結 GitHub/);

  await link(DEMO_USERS[0].user_id, '88021', 'maker-leader');
  const detail = await memberRequest(leader, `/guild-reviews/${openPull}`);
  assert.equal(detail.status, 200, JSON.stringify(detail.data));
  assert.equal(detail.data.eligible_reviewers, undefined);
  assert.equal(detail.data.claim_options.length, 2);
  assert.equal(detail.data.can_release, false);
  const missingGuild = await memberRequest(leader, `/guild-reviews/${openPull}/claim`, {}, 1);
  assert.equal(missingGuild.status, 422);
  assert.equal(missingGuild.data.code, 'maintainer_guild_required');
  const key = randomUUID();
  const claimed = await memberRequest(leader, `/guild-reviews/${openPull}/claim`, { guild_key: 'guild_marketing' }, 1, key);
  assert.equal(claimed.status, 201, JSON.stringify(claimed.data));
  assert.equal(claimed.data.claim.acting_as, 'guild_leader');
  assert.equal(claimed.data.claim.guild_key, 'guild_marketing');
  assert.equal(claimed.data.claim.reviewer_login, 'maker-leader');
  assert.equal(claimed.data.can_release, true);
  assert.equal(JSON.stringify(claimed.data).includes(TOKEN), false);
  const replay = await memberRequest(leader, `/guild-reviews/${openPull}/claim`, { guild_key: 'guild_marketing' }, 1, key);
  assert.equal(replay.status, 201);
  assert.deepEqual(replay.data, claimed.data);

  await lead(DEMO_USERS[1].user_id, 'guild_ai_vibe');
  await link(DEMO_USERS[1].user_id, '88022', 'other-leader');
  const second = await login(pool, DEMO_USERS[1].email, DEMO_PASSWORD);
  const notYours = await memberRequest(second, `/guild-reviews/claims/${claimed.data.claim.claim_id}/release`, {}, Number(claimed.data.claim.aggregate_version));
  assert.equal(notYours.status, 403);
  assert.equal(notYours.data.code, 'maintainer_claim_not_yours');
  const released = await memberRequest(leader, `/guild-reviews/claims/${claimed.data.claim.claim_id}/release`, {}, Number(claimed.data.claim.aggregate_version));
  assert.equal(released.status, 200, JSON.stringify(released.data));
  assert.equal(released.data.claim, null);
  assert.equal(released.data.claims[0].end_reason, 'self_released');
  const hiddenClaim = await insertClaim(hiddenPull, DEMO_USERS[1].user_id, '88022', 'other-leader', null, null);
  assert.equal((await memberRequest(leader, `/guild-reviews/claims/${hiddenClaim}/release`, {}, 1)).status, 404);
});

test('a skill-book maintainer is eligible only for the appointed book, with an active account and GitHub', async () => {
  const user = DEMO_USERS[1].user_id;
  const repository = await insertRepo({ book: 'career-guide', guild: 'guild_marketing', open: false, full: 'FreeTWAI-AI/freedom-skill-career-guide' });
  const other = await insertRepo({ book: 'event-space', full: 'FreeTWAI-AI/freedom-skill-event-space' });
  await appointBook(user, 'social-post');
  await link(user, '88041', 'book-reviewer');
  assert.equal((await eligible(repository)).some(row => row.user_id === user), false);
  await appointBook(user, 'career-guide', false);
  assert.equal((await eligible(repository)).some(row => row.user_id === user), false);
  await appointBook(user, 'career-guide', true);
  await pool.query('DELETE FROM github_social_connections WHERE user_id=$1', [user]);
  assert.equal((await eligible(repository)).some(row => row.user_id === user), false);
  await link(user, '88041', 'book-reviewer');
  const rows = (await eligible(repository)).filter(row => row.user_id === user);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].acting_as, 'skill_book_maintainer');
  assert.equal(rows[0].guild_key, null);
  assert.equal(rows[0].skill_book_id, 'career-guide');
  assert.equal((await eligible(other)).some(row => row.user_id === user), false);
});

test('a skill-book maintainer who is not a guild leader lists, claims and releases the book pull', async () => {
  const user = DEMO_USERS[1].user_id;
  await appointBook(user, 'career-guide');
  const bookRepo = await insertRepo({ book: 'career-guide', guild: 'guild_marketing', open: false, full: 'FreeTWAI-AI/freedom-skill-career-guide' });
  const open = await insertRepo({ open: true, full: 'FreeTWAI-AI/unclaimed-book' });
  const foreign = await insertRepo({ guild: 'guild_platform_engineering', full: 'FreeTWAI-AI/their-module' });
  const hidden = await insertRepo({ full: 'FreeTWAI-AI/admin-only' });
  const bookPull = await insertPull(bookRepo, 1);
  const openPull = await insertPull(open, 2);
  const foreignPull = await insertPull(foreign, 3);
  const hiddenPull = await insertPull(hidden, 4);
  const member = await login(pool, DEMO_USERS[1].email, DEMO_PASSWORD);
  const listed = await memberRequest(member, '/guild-reviews?queue=open');
  assert.equal(listed.status, 200, JSON.stringify(listed.data));
  const ids = listed.data.items.map((item: { pull_id: string }) => item.pull_id);
  assert.ok(ids.includes(bookPull));
  assert.ok(ids.includes(openPull));
  assert.equal(ids.includes(foreignPull), false);
  assert.equal(ids.includes(hiddenPull), false);
  assert.equal(listed.data.viewer.github_login, null);
  assert.equal(listed.data.skill_books[0].skill_book_id, 'career-guide');
  assert.equal(listed.data.skill_books[0].title, '方向探索與陪跑入門');
  const unlinked = await memberRequest(member, `/guild-reviews/${bookPull}/claim`, { acting_as: 'skill_book_maintainer', skill_book_id: 'career-guide' }, 1);
  assert.equal(unlinked.status, 409);
  assert.equal(unlinked.data.code, 'maintainer_claim_identity_required');

  await link(user, '88042', 'book-reviewer');
  const detail = await memberRequest(member, `/guild-reviews/${bookPull}`);
  assert.equal(detail.status, 200, JSON.stringify(detail.data));
  assert.equal(detail.data.claim_options.length, 1);
  assert.equal(detail.data.claim_options[0].acting_as, 'skill_book_maintainer');
  assert.equal(detail.data.claim_options[0].skill_book_id, 'career-guide');
  assert.equal(detail.data.claim_options[0].skill_book_title, '方向探索與陪跑入門');
  assert.equal(detail.data.claim_options[0].guild_key, null);
  const openClaim = await memberRequest(member, `/guild-reviews/${openPull}/claim`, {}, 1);
  assert.equal(openClaim.status, 403);
  assert.equal(openClaim.data.code, 'maintainer_guild_scope');
  assert.match(openClaim.data.detail, /技能書/);
  const claimed = await memberRequest(member, `/guild-reviews/${bookPull}/claim`, { acting_as: 'skill_book_maintainer', skill_book_id: 'career-guide' }, 1);
  assert.equal(claimed.status, 201, JSON.stringify(claimed.data));
  assert.equal(claimed.data.claim.acting_as, 'skill_book_maintainer');
  assert.equal(claimed.data.claim.guild_key, null);
  assert.equal(claimed.data.claim.skill_book_id, 'career-guide');
  assert.equal(claimed.data.claim.skill_book_title, '方向探索與陪跑入門');
  assert.equal(claimed.data.can_release, true);
  const released = await memberRequest(member, `/guild-reviews/claims/${claimed.data.claim.claim_id}/release`, {}, Number(claimed.data.claim.aggregate_version));
  assert.equal(released.status, 200, JSON.stringify(released.data));
  assert.equal(released.data.claim, null);
  assert.equal(released.data.claims[0].end_reason, 'self_released');
});

test('a finished skill-book maintainer claim does not adopt the repository', async () => {
  const user = DEMO_USERS[1].user_id;
  await appointBook(user, 'career-guide');
  await link(user, '88043', 'book-reviewer');
  const repository = await insertRepo({ book: 'career-guide', open: true, full: 'FreeTWAI-AI/freedom-skill-career-guide' });
  const pull = await insertPull(repository, 1);
  const claim = await insertBookClaim(pull, user, '88043', 'book-reviewer', 'career-guide');
  await insertReview(pull, '88043', 'APPROVED');
  const settled = await settleMaintainerClaims(pool, CLOCK);
  assert.equal(settled.adopted, 0);
  assert.equal(settled.completed, 1);
  const repo = (await pool.query('SELECT guild_key, open_to_guilds, skill_book_id FROM maintainer_repositories WHERE repository_id=$1', [repository])).rows[0];
  assert.equal(repo.guild_key, null);
  assert.equal(repo.open_to_guilds, true);
  assert.equal(repo.skill_book_id, 'career-guide');
  assert.equal((await pool.query('SELECT state FROM maintainer_review_claims WHERE claim_id=$1', [claim])).rows[0].state, 'completed');
  assert.equal((await pool.query('SELECT count(*) FROM maintainer_ownership_changes WHERE repository_id=$1', [repository])).rows[0].count, '0');
});

test('revoking a skill-book appointment releases the claim on the next settlement', async () => {
  const user = DEMO_USERS[1].user_id;
  await appointBook(user, 'career-guide');
  await link(user, '88044', 'book-reviewer');
  const repository = await insertRepo({ book: 'career-guide', guild: 'guild_marketing', open: false, full: 'FreeTWAI-AI/freedom-skill-career-guide' });
  const pull = await insertPull(repository, 1);
  const claim = await insertBookClaim(pull, user, '88044', 'book-reviewer', 'career-guide');
  await pool.query(`UPDATE skill_book_maintainers SET active=false WHERE book_id='career-guide' AND user_id=$1`, [user]);
  const settled = await settleMaintainerClaims(pool, CLOCK);
  assert.equal(settled.released, 1);
  assert.equal(settled.adopted, 0);
  assert.equal((await pool.query('SELECT end_reason FROM maintainer_review_claims WHERE claim_id=$1', [claim])).rows[0].end_reason, 'reviewer_not_eligible');
  assert.equal((await pool.query('SELECT guild_key, skill_book_id FROM maintainer_repositories WHERE repository_id=$1', [repository])).rows[0].guild_key, 'guild_marketing');
});

test('an admin assigns a skill-book maintainer and rejects a mixed identity', async () => {
  const user = DEMO_USERS[1].user_id;
  await appointBook(user, 'career-guide');
  await appointBook(DEMO_USERS[2].user_id, 'event-space', false);
  await link(user, '88045', 'book-reviewer');
  const repository = await insertRepo({ book: 'career-guide', full: 'FreeTWAI-AI/freedom-skill-career-guide' });
  const pull = await insertPull(repository, 1);
  const directory = await adminRequest('/review-center/reviewers');
  assert.equal(directory.status, 200, JSON.stringify(directory.data));
  const book = directory.data.skill_books.find((row: { skill_book_id: string }) => row.skill_book_id === 'career-guide');
  assert.equal(book.title, '方向探索與陪跑入門');
  assert.equal(book.maintainers.find((row: { user_id: string }) => row.user_id === user).status, 'linked');
  assert.equal(book.maintainers.find((row: { user_id: string }) => row.user_id === user).github_login, 'book-reviewer');
  const inactive = directory.data.skill_books.find((row: { skill_book_id: string }) => row.skill_book_id === 'event-space');
  assert.equal(inactive.maintainers[0].status, 'inactive');
  assert.ok(directory.data.skill_book_choices.some((row: { skill_book_id: string }) => row.skill_book_id === 'career-guide'));
  const path = `/review-center/pulls/${pull}/assign`;
  const missing = await adminRequest(path, { user_id: user, acting_as: 'skill_book_maintainer', guild_key: null, reason: '請這位技能書維護者看這次變更。' }, 1);
  assert.equal(missing.status, 422);
  assert.equal(missing.data.code, 'maintainer_skill_book_invalid');
  const mixed = await adminRequest(path, { user_id: user, acting_as: 'guild_leader', guild_key: 'guild_ai_vibe', skill_book_id: 'career-guide', reason: '公會長不能帶技能書。' }, 1);
  assert.equal(mixed.status, 422);
  assert.equal(mixed.data.code, 'maintainer_skill_book_invalid');
  const assigned = await adminRequest(path, { user_id: user, acting_as: 'skill_book_maintainer', guild_key: null, skill_book_id: 'career-guide', reason: '請這位技能書維護者看這次變更。' }, 1);
  assert.equal(assigned.status, 200, JSON.stringify(assigned.data));
  assert.equal(assigned.data.claim.acting_as, 'skill_book_maintainer');
  assert.equal(assigned.data.claim.skill_book_id, 'career-guide');
  assert.equal(assigned.data.claim.guild_key, null);
});
