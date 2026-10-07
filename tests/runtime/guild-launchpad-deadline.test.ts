import {test, before, after, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Client, Pool} from 'pg';
import {createPool, LOCAL_DATABASE_URL} from '../../packages/db/index.js';
import {migrate} from '../../scripts/database.js';
import {seedLocal, DEMO_USERS, DEMO_PASSWORD, DEMO_COMMUNITY} from '../../packages/testing/seed.js';
import {tokenHash} from '../../modules/identity-membership/service.js';
import {createApp} from '../../apps/platform-api/src/app.js';
import {defaultConfigFor} from '../../modules/guild-workspace/launchpad-config.js';

// Barrier tests for delegation and session deadlines that expire while a request
// is blocked. The holder locks a row or the receipt advisory key and does not
// update it, so a WHERE clause on the waiting statement is not rechecked.
const origin = 'http://127.0.0.1:4310';
const databaseUrl = process.env.TEST_DATABASE_URL ?? LOCAL_DATABASE_URL;
const schema = `fp_guild_launchpad_deadline_${process.pid}_${Date.now()}`;
const admin = createPool(databaseUrl);
const pool = new Pool({connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 12});
const app = createApp(pool, origin, 'local', {guildLaunchpadEnabled: true});
type Session = {cookie: string; csrf: string; user: {user_id: string}};
type Reply = {status: number; data: any};
const publishCaps = ['guild.content.edit', 'guild.config.publish'];
const viewCaps = ['guild.content.edit', 'guild.config.preview', 'guild.config.publish'];

before(async () => { await admin.query(`CREATE SCHEMA ${schema}`); await migrate(pool); });
after(async () => { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
beforeEach(async () => { await pool.query('TRUNCATE communities, login_attempts, auth_rate_limits CASCADE'); await seedLocal(pool); });

async function request(path: string, session?: Session, body?: unknown, version?: string, key = randomUUID()): Promise<Reply> {
  const headers: Record<string, string> = {Origin: origin, ...(session ? {Cookie: session.cookie, 'X-CSRF-Token': session.csrf} : {})};
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    headers['Idempotency-Key'] = key;
    if (version) headers['If-Match'] = `"${version}"`;
  }
  const response = await app.request(origin + '/api/v1' + path, {method: body === undefined ? 'GET' : 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body)});
  return {status: response.status, data: await response.json() as any};
}
async function signIn(email = DEMO_USERS[0].email): Promise<Session> {
  const headers: Record<string, string> = {Origin: origin, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID()};
  const response = await app.request(origin + '/api/v1/auth/login', {method: 'POST', headers, body: JSON.stringify({email, password: DEMO_PASSWORD})});
  const data = await response.json() as any;
  assert.equal(response.status, 200, JSON.stringify(data));
  return {cookie: response.headers.get('set-cookie')!.split(';')[0], csrf: data.csrf_token, user: data.user};
}
async function join(userId: string, key: string) {
  await pool.query(`INSERT INTO positioning_profession_memberships(membership_id, community_id, user_id, guild_key, state, member_tier)
    VALUES($1,$2,$3,$4,'active','full') ON CONFLICT (community_id, user_id, guild_key) DO UPDATE SET state='active', member_tier='full'`,
  [randomUUID(), DEMO_COMMUNITY, userId, key]);
}
async function lead(userId: string, key: string) {
  await join(userId, key);
  await pool.query(`INSERT INTO positioning_guild_officers(community_id, guild_key, user_id) VALUES($1,$2,$3)
    ON CONFLICT (community_id, guild_key) DO UPDATE SET user_id=$3`, [DEMO_COMMUNITY, key, userId]);
}
async function catalog(key: string) {
  const row = (await pool.query('SELECT guild_key, name, purpose FROM positioning_guild_catalog WHERE guild_key=$1', [key])).rows[0];
  assert.ok(row, key);
  return row as {guild_key: string; name: string; purpose: string};
}
async function draftOf(key: string, marker: string) {
  return {...defaultConfigFor(await catalog(key)), mission_override: marker};
}
async function saveDraft(leader: Session, key: string, marker: string, version = '1') {
  const body = await draftOf(key, marker);
  const draft = await request(`/guilds/${key}/launchpad-config/drafts`, leader, {body}, version);
  assert.equal(draft.status, 201, JSON.stringify(draft.data));
  return draft;
}
async function publishDraft(actor: Session, key: string, draft: Reply, idem = randomUUID()) {
  return request(`/guilds/${key}/launchpad-config/${draft.data.config_id}/publish`, actor, {expected_body_sha256: draft.data.body_sha256}, draft.data.pointer_version, idem);
}
function sessionHash(session: Session) {
  return tokenHash(session.cookie.slice(session.cookie.indexOf('=') + 1));
}
async function insertDelegation(guildKey: string, userId: string, grantorId: string, seconds: number, capabilities: string[]) {
  await pool.query('INSERT INTO principals(user_ref) VALUES($1) ON CONFLICT (user_ref) DO NOTHING', [userId]);
  await pool.query('INSERT INTO principals(user_ref) VALUES($1) ON CONFLICT (user_ref) DO NOTHING', [grantorId]);
  const principal = (await pool.query('SELECT principal_id FROM principals WHERE user_ref=$1', [userId])).rows[0].principal_id as string;
  const grantor = (await pool.query('SELECT principal_id FROM principals WHERE user_ref=$1', [grantorId])).rows[0].principal_id as string;
  const row = (await pool.query(`INSERT INTO guild_launchpad_delegations
    (delegation_id, community_id, guild_key, principal_id, capabilities, granted_by_principal_id, expires_at, version, status)
    VALUES ($1,$2,$3,$4,$5,$6,clock_timestamp() + make_interval(secs => $7),1,'active')
    RETURNING delegation_id`, [randomUUID(), DEMO_COMMUNITY, guildKey, principal, capabilities, grantor, seconds])).rows[0];
  return row.delegation_id as string;
}
async function delegationPast(delegationId: string) {
  return (await pool.query('SELECT clock_timestamp() > expires_at AS past FROM guild_launchpad_delegations WHERE delegation_id=$1', [delegationId])).rows[0].past === true;
}
async function sessionPast(hash: string) {
  return (await pool.query('SELECT clock_timestamp() > expires_at AS past FROM sessions WHERE token_hash=$1', [hash])).rows[0].past === true;
}
async function shortenSession(session: Session, seconds = 3) {
  const hash = sessionHash(session);
  await pool.query('UPDATE sessions SET expires_at = clock_timestamp() + make_interval(secs => $2) WHERE token_hash=$1', [hash, seconds]);
  return hash;
}
async function effects(guildKey: string) {
  const revisions = (await pool.query(`SELECT config_id::text, revision::text AS revision, status, body_sha256
    FROM guild_launchpad_config_revisions WHERE community_id=$1 AND guild_key=$2 ORDER BY revision`, [DEMO_COMMUNITY, guildKey])).rows;
  const pointer = (await pool.query(`SELECT config_id::text, pointer_version::text AS pointer_version
    FROM guild_launchpad_config_pointers WHERE community_id=$1 AND guild_key=$2`, [DEMO_COMMUNITY, guildKey])).rows;
  const journal = (await pool.query('SELECT count(*)::int AS n FROM transition_journal')).rows[0].n as number;
  const outbox = (await pool.query('SELECT count(*)::int AS n FROM outbox')).rows[0].n as number;
  const receipts = (await pool.query(`SELECT user_id::text, operation, idempotency_key, request_sha256, response
    FROM command_receipts ORDER BY user_id, operation, idempotency_key`)).rows;
  const delegations = (await pool.query(`SELECT delegation_id::text, status, version::text AS version
    FROM guild_launchpad_delegations WHERE community_id=$1 AND guild_key=$2 ORDER BY delegation_id`, [DEMO_COMMUNITY, guildKey])).rows;
  return {revisions, pointer, journal, outbox, receipts, delegations};
}
async function receiptOperation(userId: string, idempotencyKey: string) {
  const row = (await pool.query('SELECT operation FROM command_receipts WHERE user_id=$1 AND idempotency_key=$2', [userId, idempotencyKey])).rows[0];
  assert.ok(row, idempotencyKey);
  return row.operation as string;
}
function assertNoPrivate(data: unknown, marker: string) {
  const text = JSON.stringify(data);
  assert.equal(text.includes(marker), false, text);
  const record = data as Record<string, unknown>;
  for (const field of ['config_id', 'body', 'body_sha256', 'pointer_version', 'mission_override', 'effective_config', 'revisions', 'delegations', 'delegation_candidates', 'announcements', 'config', 'membership', 'viewer_can_edit_config', 'viewer_can_publish_config', 'viewer_can_preview_config']) {
    assert.equal(Object.hasOwn(record, field), false, `${field} leaked in ${text}`);
  }
}
async function waitForBlockedQuery(holderPid: number, waitingSql: RegExp) {
  const start = Date.now();
  let last = '';
  while (Date.now() - start < 5_000) {
    const rows = (await admin.query('SELECT query FROM pg_stat_activity WHERE $1 = ANY (pg_blocking_pids(pid))', [holderPid])).rows as {query: string | null}[];
    last = rows.map(row => row.query ?? '').join('\n');
    if (waitingSql.test(last)) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${waitingSql}. last blocked query:\n${last}`);
}
async function waitUntil(probe: () => Promise<boolean>, label: string) {
  const start = Date.now();
  while (Date.now() - start < 10_000) {
    if (await probe()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${label}`);
}
async function whileBlocked(hold: (holder: Client) => Promise<void>, start: () => Promise<Reply>, stillValid: () => Promise<boolean>, waitingSql: RegExp) {
  const holder = new Client({connectionString: databaseUrl, options: `-c search_path=${schema}`});
  await holder.connect();
  let inflight: Promise<Reply> | undefined;
  try {
    await holder.query('BEGIN');
    await hold(holder);
    const pid = (await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
    inflight = start();
    await waitForBlockedQuery(pid, waitingSql);
    assert.equal(await stillValid(), true, 'the deadline had already passed when the lock wait was observed');
    await waitUntil(async () => !(await stillValid()), 'deadline to pass during the lock wait');
    await holder.query('COMMIT');
    const result = await inflight;
    inflight = undefined;
    return result;
  } finally {
    await holder.query('ROLLBACK').catch(() => undefined);
    if (inflight) await inflight.catch(() => undefined);
    await holder.end();
  }
}
function live(id: string, kind: 'delegation' | 'session') {
  return () => kind === 'delegation' ? delegationPast(id).then(past => !past) : sessionPast(id).then(past => !past);
}

test('barrier: delegate publish waiting on the draft row loses a delegation that expires during the wait', {timeout: 30_000}, async () => {
  const key = 'guild_music_mv';
  const leader = await signIn(DEMO_USERS[0].email);
  const delegate = await signIn(DEMO_USERS[1].email);
  await lead(leader.user.user_id, key);
  await join(delegate.user.user_id, key);
  const marker = `PUBLISH_WAIT_${randomUUID()}`;
  const draft = await saveDraft(leader, key, marker);
  const delegationId = await insertDelegation(key, delegate.user.user_id, leader.user.user_id, 3, publishCaps);
  const before = await effects(key);
  const result = await whileBlocked(
    async holder => {
      const locked = await holder.query('SELECT config_id FROM guild_launchpad_config_revisions WHERE config_id=$1 FOR SHARE', [draft.data.config_id]);
      assert.equal(locked.rowCount, 1);
    },
    () => publishDraft(delegate, key, draft),
    live(delegationId, 'delegation'),
    /guild_launchpad_config_revisions[\s\S]*FOR UPDATE/,
  );
  assert.equal(result.status, 403, JSON.stringify(result.data));
  assert.equal(result.data.code, 'guild_leader_required');
  assertNoPrivate(result.data, marker);
  assert.deepEqual(await effects(key), before);
  assert.equal((await pool.query('SELECT status FROM guild_launchpad_config_revisions WHERE config_id=$1', [draft.data.config_id])).rows[0].status, 'draft');
});

test('barrier: publish replay waiting on the receipt advisory lock loses a delegation that expires during the wait', {timeout: 30_000}, async () => {
  const key = 'guild_commercial_production';
  const leader = await signIn(DEMO_USERS[0].email);
  const delegate = await signIn(DEMO_USERS[1].email);
  await lead(leader.user.user_id, key);
  await join(delegate.user.user_id, key);
  const marker = `PUBLISH_REPLAY_${randomUUID()}`;
  const draft = await saveDraft(leader, key, marker);
  const delegationId = await insertDelegation(key, delegate.user.user_id, leader.user.user_id, 5, publishCaps);
  const idem = randomUUID();
  const published = await publishDraft(delegate, key, draft, idem);
  assert.equal(published.status, 200, JSON.stringify(published.data));
  assert.equal(published.data.body.mission_override, marker);
  const operation = await receiptOperation(delegate.user.user_id, idem);
  const before = await effects(key);
  const result = await whileBlocked(
    holder => holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`${delegate.user.user_id}/${operation}/${idem}`]).then(() => undefined),
    () => publishDraft(delegate, key, draft, idem),
    live(delegationId, 'delegation'),
    /pg_advisory_xact_lock/,
  );
  assert.equal(result.status, 403, JSON.stringify(result.data));
  assert.equal(result.data.code, 'guild_leader_required');
  assertNoPrivate(result.data, marker);
  assert.deepEqual(await effects(key), before);
});

test('barrier: delegate revert waiting on the prior revision loses a delegation that expires during the wait', {timeout: 30_000}, async () => {
  const key = 'guild_projection_mapping';
  const leader = await signIn(DEMO_USERS[0].email);
  const delegate = await signIn(DEMO_USERS[1].email);
  await lead(leader.user.user_id, key);
  await join(delegate.user.user_id, key);
  const marker = `REVERT_WAIT_${randomUUID()}`;
  const draft = await saveDraft(leader, key, marker);
  const published = await publishDraft(leader, key, draft);
  assert.equal(published.status, 200, JSON.stringify(published.data));
  const delegationId = await insertDelegation(key, delegate.user.user_id, leader.user.user_id, 3, publishCaps);
  const before = await effects(key);
  const result = await whileBlocked(
    async holder => {
      const locked = await holder.query('SELECT config_id FROM guild_launchpad_config_revisions WHERE config_id=$1 FOR UPDATE', [published.data.config_id]);
      assert.equal(locked.rowCount, 1);
    },
    () => request(`/guilds/${key}/launchpad-config/revert`, delegate, {to_revision: published.data.revision, reason: '回復等待中的授權'}, published.data.pointer_version),
    live(delegationId, 'delegation'),
    /guild_launchpad_config_revisions[\s\S]*FOR SHARE/,
  );
  assert.equal(result.status, 403, JSON.stringify(result.data));
  assert.equal(result.data.code, 'guild_leader_required');
  assertNoPrivate(result.data, marker);
  assert.deepEqual(await effects(key), before);
});

test('barrier: revert replay waiting on the receipt advisory lock loses a delegation that expires during the wait', {timeout: 30_000}, async () => {
  const key = 'guild_event_space';
  const leader = await signIn(DEMO_USERS[0].email);
  const delegate = await signIn(DEMO_USERS[1].email);
  await lead(leader.user.user_id, key);
  await join(delegate.user.user_id, key);
  const marker = `REVERT_REPLAY_${randomUUID()}`;
  const draft = await saveDraft(leader, key, marker);
  const published = await publishDraft(leader, key, draft);
  assert.equal(published.status, 200, JSON.stringify(published.data));
  const delegationId = await insertDelegation(key, delegate.user.user_id, leader.user.user_id, 5, publishCaps);
  const idem = randomUUID();
  const reverted = await request(`/guilds/${key}/launchpad-config/revert`, delegate, {to_revision: published.data.revision, reason: '回復這次已授權的內容'}, published.data.pointer_version, idem);
  assert.equal(reverted.status, 200, JSON.stringify(reverted.data));
  assert.equal(reverted.data.body.mission_override, marker);
  const operation = await receiptOperation(delegate.user.user_id, idem);
  const before = await effects(key);
  const result = await whileBlocked(
    holder => holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`${delegate.user.user_id}/${operation}/${idem}`]).then(() => undefined),
    () => request(`/guilds/${key}/launchpad-config/revert`, delegate, {to_revision: published.data.revision, reason: '回復這次已授權的內容'}, published.data.pointer_version, idem),
    live(delegationId, 'delegation'),
    /pg_advisory_xact_lock/,
  );
  assert.equal(result.status, 403, JSON.stringify(result.data));
  assert.equal(result.data.code, 'guild_leader_required');
  assertNoPrivate(result.data, marker);
  assert.deepEqual(await effects(key), before);
});

test('barrier: draft replay waiting on the receipt advisory lock loses a delegation that expires during the wait', {timeout: 30_000}, async () => {
  const key = 'guild_marketing';
  const leader = await signIn(DEMO_USERS[0].email);
  const delegate = await signIn(DEMO_USERS[1].email);
  await lead(leader.user.user_id, key);
  await join(delegate.user.user_id, key);
  const marker = `DRAFT_REPLAY_${randomUUID()}`;
  const body = await draftOf(key, marker);
  const delegationId = await insertDelegation(key, delegate.user.user_id, leader.user.user_id, 5, publishCaps);
  const idem = randomUUID();
  const created = await request(`/guilds/${key}/launchpad-config/drafts`, delegate, {body}, '1', idem);
  assert.equal(created.status, 201, JSON.stringify(created.data));
  assert.equal(created.data.body.mission_override, marker);
  const operation = await receiptOperation(delegate.user.user_id, idem);
  const before = await effects(key);
  const result = await whileBlocked(
    holder => holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`${delegate.user.user_id}/${operation}/${idem}`]).then(() => undefined),
    () => request(`/guilds/${key}/launchpad-config/drafts`, delegate, {body}, '1', idem),
    live(delegationId, 'delegation'),
    /pg_advisory_xact_lock/,
  );
  assert.equal(result.status, 403, JSON.stringify(result.data));
  assert.equal(result.data.code, 'guild_leader_required');
  assertNoPrivate(result.data, marker);
  assert.deepEqual(await effects(key), before);
});

test('barrier: leader config GET waiting on the officer row loses a session that expires during the wait', {timeout: 30_000}, async () => {
  const key = 'guild_human_design';
  const leader = await signIn(DEMO_USERS[0].email);
  await lead(leader.user.user_id, key);
  const marker = `LEADER_GET_${randomUUID()}`;
  await saveDraft(leader, key, marker);
  const hash = await shortenSession(leader);
  const result = await whileBlocked(
    async holder => {
      const locked = await holder.query('SELECT user_id FROM positioning_guild_officers WHERE community_id=$1 AND guild_key=$2 AND user_id=$3 FOR UPDATE', [DEMO_COMMUNITY, key, leader.user.user_id]);
      assert.equal(locked.rowCount, 1);
    },
    () => request(`/guilds/${key}/launchpad-config`, leader),
    live(hash, 'session'),
    /positioning_guild_officers[\s\S]*FOR SHARE/,
  );
  assert.equal(result.status, 401, JSON.stringify(result.data));
  assert.equal(result.data.code, 'session_expired');
  assertNoPrivate(result.data, marker);
});

test('barrier: member launchpad GET waiting on the membership row loses a session that expires during the wait', {timeout: 30_000}, async () => {
  const key = 'guild_member_operations';
  const leader = await signIn(DEMO_USERS[0].email);
  const member = await signIn(DEMO_USERS[1].email);
  await lead(leader.user.user_id, key);
  await join(member.user.user_id, key);
  const marker = `MEMBER_GET_${randomUUID()}`;
  const draft = await saveDraft(leader, key, marker);
  const published = await publishDraft(leader, key, draft);
  assert.equal(published.status, 200, JSON.stringify(published.data));
  const hash = await shortenSession(member);
  const result = await whileBlocked(
    async holder => {
      const locked = await holder.query(`SELECT membership_id FROM positioning_profession_memberships WHERE community_id=$1 AND user_id=$2 AND guild_key=$3 FOR UPDATE`, [DEMO_COMMUNITY, member.user.user_id, key]);
      assert.equal(locked.rowCount, 1);
    },
    () => request(`/guilds/${key}/launchpad`, member),
    live(hash, 'session'),
    /positioning_profession_memberships[\s\S]*FOR SHARE/,
  );
  assert.equal(result.status, 401, JSON.stringify(result.data));
  assert.equal(result.data.code, 'session_expired');
  assertNoPrivate(result.data, marker);
});

test('barrier: delegated config GET waiting on the delegation row loses a delegation that expires during the wait', {timeout: 30_000}, async () => {
  const key = 'guild_security';
  const leader = await signIn(DEMO_USERS[0].email);
  const delegate = await signIn(DEMO_USERS[1].email);
  await lead(leader.user.user_id, key);
  await join(delegate.user.user_id, key);
  const marker = `DELEGATE_GET_${randomUUID()}`;
  await saveDraft(leader, key, marker);
  const delegationId = await insertDelegation(key, delegate.user.user_id, leader.user.user_id, 3, viewCaps);
  const result = await whileBlocked(
    async holder => {
      const locked = await holder.query('SELECT delegation_id FROM guild_launchpad_delegations WHERE delegation_id=$1 FOR UPDATE', [delegationId]);
      assert.equal(locked.rowCount, 1);
    },
    () => request(`/guilds/${key}/launchpad-config`, delegate),
    live(delegationId, 'delegation'),
    /guild_launchpad_delegations[\s\S]*FOR SHARE/,
  );
  assert.equal(result.status, 403, JSON.stringify(result.data));
  assert.equal(result.data.code, 'guild_leader_required');
  assertNoPrivate(result.data, marker);
});

test('barrier: delegated preview waiting on the delegation row loses a delegation that expires during the wait', {timeout: 30_000}, async () => {
  const key = 'guild_ai_field';
  const leader = await signIn(DEMO_USERS[0].email);
  const delegate = await signIn(DEMO_USERS[1].email);
  await lead(leader.user.user_id, key);
  await join(delegate.user.user_id, key);
  const marker = `PREVIEW_WAIT_${randomUUID()}`;
  const body = await draftOf(key, marker);
  const delegationId = await insertDelegation(key, delegate.user.user_id, leader.user.user_id, 3, ['guild.config.preview']);
  const result = await whileBlocked(
    async holder => {
      const locked = await holder.query('SELECT delegation_id FROM guild_launchpad_delegations WHERE delegation_id=$1 FOR UPDATE', [delegationId]);
      assert.equal(locked.rowCount, 1);
    },
    () => request(`/guilds/${key}/launchpad-config/preview`, delegate, {body, preview_mode: 'member'}),
    live(delegationId, 'delegation'),
    /guild_launchpad_delegations[\s\S]*FOR SHARE/,
  );
  assert.equal(result.status, 403, JSON.stringify(result.data));
  assert.equal(result.data.code, 'guild_leader_required');
  assertNoPrivate(result.data, marker);
});

test('delegate publish and same-key replay succeed before delegation expiry', async () => {
  const key = 'guild_commerce_sales';
  const leader = await signIn(DEMO_USERS[0].email);
  const delegate = await signIn(DEMO_USERS[1].email);
  await lead(leader.user.user_id, key);
  await join(delegate.user.user_id, key);
  const marker = `LIVE_PUBLISH_${randomUUID()}`;
  const draft = await saveDraft(leader, key, marker);
  await insertDelegation(key, delegate.user.user_id, leader.user.user_id, 86_400, publishCaps);
  const idem = randomUUID();
  const published = await publishDraft(delegate, key, draft, idem);
  assert.equal(published.status, 200, JSON.stringify(published.data));
  assert.equal(published.data.status, 'published');
  assert.equal(published.data.body.mission_override, marker);
  const replay = await publishDraft(delegate, key, draft, idem);
  assert.equal(replay.status, 200, JSON.stringify(replay.data));
  assert.deepEqual(replay.data, published.data);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM command_receipts WHERE user_id=$1 AND idempotency_key=$2', [delegate.user.user_id, idem])).rows[0].n, 1);
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM guild_launchpad_config_revisions WHERE community_id=$1 AND guild_key=$2 AND status='published'`, [DEMO_COMMUNITY, key])).rows[0].n, 1);
});

test('a leader publish is unaffected by delegation deadline checks', async () => {
  const key = 'guild_ai_project';
  const leader = await signIn(DEMO_USERS[0].email);
  await lead(leader.user.user_id, key);
  const marker = `LEADER_PUBLISH_${randomUUID()}`;
  const draft = await saveDraft(leader, key, marker);
  const published = await publishDraft(leader, key, draft);
  assert.equal(published.status, 200, JSON.stringify(published.data));
  assert.equal(published.data.status, 'published');
  assert.equal(published.data.body.mission_override, marker);
  const again = await request(`/guilds/${key}/launchpad-config/${draft.data.config_id}/publish`, leader, {expected_body_sha256: draft.data.body_sha256}, published.data.pointer_version);
  assert.equal(again.status, 409, JSON.stringify(again.data));
  assert.equal(again.data.code, 'config_not_draft');
});

test('private launchpad reads succeed while the session and delegation are current', async () => {
  const key = 'guild_product_quality_supply';
  const leader = await signIn(DEMO_USERS[0].email);
  const member = await signIn(DEMO_USERS[1].email);
  const delegate = await signIn(DEMO_USERS[2].email);
  await lead(leader.user.user_id, key);
  await join(member.user.user_id, key);
  await join(delegate.user.user_id, key);
  const marker = `LIVE_READ_${randomUUID()}`;
  const draft = await saveDraft(leader, key, marker);
  const leaderView = await request(`/guilds/${key}/launchpad-config`, leader);
  assert.equal(leaderView.status, 200, JSON.stringify(leaderView.data));
  assert.equal(leaderView.data.body.mission_override, marker);
  assert.ok(Array.isArray(leaderView.data.revisions));
  assert.ok(Array.isArray(leaderView.data.delegations));
  assert.deepEqual(await request(`/guilds/${key}/launchpad-config`, leader), leaderView);
  const published = await publishDraft(leader, key, draft);
  assert.equal(published.status, 200, JSON.stringify(published.data));
  const memberView = await request(`/guilds/${key}/launchpad`, member);
  assert.equal(memberView.status, 200, JSON.stringify(memberView.data));
  assert.equal(memberView.data.config.body.mission_override, marker);
  assert.equal(memberView.data.viewer_can_publish_config, false);
  assert.deepEqual((await request(`/guilds/${key}/launchpad`, member)).data, memberView.data);
  await insertDelegation(key, delegate.user.user_id, leader.user.user_id, 86_400, viewCaps);
  const delegateView = await request(`/guilds/${key}/launchpad-config`, delegate);
  assert.equal(delegateView.status, 200, JSON.stringify(delegateView.data));
  assert.equal(delegateView.data.body.mission_override, marker);
  assert.equal(delegateView.data.viewer_can_publish_config, true);
  assert.equal('delegations' in delegateView.data, false);
  assert.deepEqual((await request(`/guilds/${key}/launchpad-config`, delegate)).data, delegateView.data);
  const preview = await request(`/guilds/${key}/launchpad-config/preview`, delegate, {body: await draftOf(key, marker), preview_mode: 'public'});
  assert.equal(preview.status, 200, JSON.stringify(preview.data));
  assert.equal(preview.data.effective_config.mission_override, marker);
  assert.equal(preview.data.preview_data_origin, 'synthetic_fixture');
});
