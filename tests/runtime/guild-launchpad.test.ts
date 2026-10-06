import {test, before, after, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {createPool, LOCAL_DATABASE_URL} from '../../packages/db/index.js';
import {migrate} from '../../scripts/database.js';
import {seedLocal, DEMO_USERS, DEMO_PASSWORD, DEMO_COMMUNITY} from '../../packages/testing/seed.js';
import {createApp} from '../../apps/platform-api/src/app.js';
import {BLOCK_KINDS, parseConfig} from '../../contracts/guild-launchpad/v1/config.js';
import {defaultConfigFor} from '../../modules/guild-workspace/launchpad-config.js';

const origin = 'http://127.0.0.1:4310';
const databaseUrl = process.env.TEST_DATABASE_URL ?? LOCAL_DATABASE_URL;
const schema = `fp_guild_launchpad_${process.pid}_${Date.now()}`;
const admin = createPool(databaseUrl);
const pool = new Pool({connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 12});
const app = createApp(pool, origin, 'local', {guildLaunchpadEnabled: true});
const disabled = createApp(pool, origin, 'local');
type Session = {cookie: string; csrf: string; user: {user_id: string}};
const guild = 'guild_music_mv';
const event = 'freedom.guild.launchpad.config.published.v1';

before(async () => { await admin.query(`CREATE SCHEMA ${schema}`); await migrate(pool); });
after(async () => { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
beforeEach(async () => { await pool.query('TRUNCATE communities, login_attempts, auth_rate_limits CASCADE'); await seedLocal(pool); });

async function request(path: string, session?: Session, body?: unknown, version?: string, key = randomUUID(), target = app) {
  const headers: Record<string, string> = {Origin: origin, ...(session ? {Cookie: session.cookie, 'X-CSRF-Token': session.csrf} : {})};
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    headers['Idempotency-Key'] = key;
    if (version) headers['If-Match'] = `"${version}"`;
  }
  const response = await target.request(origin + '/api/v1' + path, {method: body === undefined ? 'GET' : 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body)});
  const data = await response.json() as any;
  return {status: response.status, data, response};
}
async function signIn(email = DEMO_USERS[0].email): Promise<Session> {
  const result = await request('/auth/login', undefined, {email, password: DEMO_PASSWORD});
  assert.equal(result.status, 200, JSON.stringify(result.data));
  return {cookie: result.response.headers.get('set-cookie')!.split(';')[0], csrf: result.data.csrf_token, user: result.data.user};
}
async function join(userId: string, key: string) {
  await pool.query(`INSERT INTO positioning_profession_memberships(membership_id, community_id, user_id, guild_key, state, member_tier)
    VALUES($1,$2,$3,$4,'active','full') ON CONFLICT (community_id, user_id, guild_key) DO UPDATE SET state='active', member_tier='full'`,
  [randomUUID(), DEMO_COMMUNITY, userId, key]);
}
async function lead(userId: string, key = guild) {
  await join(userId, key);
  await pool.query(`INSERT INTO positioning_guild_officers(community_id, guild_key, user_id) VALUES($1,$2,$3)
    ON CONFLICT (community_id, guild_key) DO UPDATE SET user_id=$3`, [DEMO_COMMUNITY, key, userId]);
}
async function catalog(key: string) {
  const row = (await pool.query('SELECT guild_key, name, purpose FROM positioning_guild_catalog WHERE guild_key=$1', [key])).rows[0];
  assert.ok(row, key);
  return row as {guild_key: string; name: string; purpose: string};
}
function assertBlocks(body: any, key: string) {
  assert.equal(body.schema_version, 'guild-launchpad.config/v1');
  assert.equal(body.guild_key, key);
  assert.equal(body.mission_override, null);
  assert.deepEqual(body.application_refs, []);
  assert.equal(body.blocks.length, BLOCK_KINDS.length);
  assert.deepEqual([...body.blocks.map((block: {kind: string}) => block.kind)].sort(), [...BLOCK_KINDS].sort());
  assert.ok(body.blocks.every((block: {enabled: boolean}) => block.enabled));
}
function hasError(data: any, code: string) {
  assert.equal(data.code, 'validation_failed', JSON.stringify(data));
  assert.ok(Array.isArray(data.errors) && data.errors.some((error: {code: string}) => error.code === code), JSON.stringify(data));
}
async function counts() {
  const tables = ['guild_launchpad_config_revisions', 'guild_launchpad_config_pointers', 'guild_launchpad_delegations', 'principals', 'outbox', 'transition_journal', 'command_receipts'];
  const result: Record<string, number> = {};
  for (const table of tables) result[table] = (await pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n;
  return result;
}

test('every catalog guild and one custom guild resolve the platform default on public and member views', async () => {
  const hex = randomUUID().replaceAll('-', '');
  const customKey = `guild_custom_${hex}`;
  await pool.query(`INSERT INTO positioning_guild_catalog(guild_key, profession_key, name, purpose, first_step, module_key, alias, profession_title)
    VALUES($1,$2,$3,$4,$5,'guilds','','')`, [customKey, `custom_${hex}`, `自訂公會 ${hex.slice(0, 8)}`, '給還沒有專用起步提示的公會。', '寫下一個真實的下一步。']);
  const member = await signIn();
  const rows = (await pool.query('SELECT guild_key, name, purpose FROM positioning_guild_catalog ORDER BY guild_key')).rows as {guild_key: string; name: string; purpose: string}[];
  let resolved = 0;
  for (const row of rows) {
    await join(member.user.user_id, row.guild_key);
    const pub = await request(`/public/guilds/${row.guild_key}/launchpad`);
    const view = await request(`/guilds/${row.guild_key}/launchpad`, member);
    assert.equal(pub.status, 200, JSON.stringify(pub.data));
    assert.equal(view.status, 200, JSON.stringify(view.data));
    assert.equal(pub.data.guild.category, null);
    assert.equal(view.data.guild.category, null);
    assert.equal(pub.response.headers.get('cache-control'), 'public, max-age=60');
    assert.equal(pub.response.headers.get('vary'), null);
    assert.equal(view.response.headers.get('cache-control'), 'private, no-store');
    assertBlocks(pub.data.config.body, row.guild_key);
    assert.equal('extensions' in pub.data.config.body, false);
    assertBlocks(view.data.config.body, row.guild_key);
    parseConfig(view.data.config.body, row.guild_key);
    assert.equal(view.data.config.pointer_version, '1');
    assert.equal(view.data.config.source, 'platform_default');
    assert.deepEqual(pub.data.announcements, []);
    assert.deepEqual(pub.data.public_results, []);
    resolved += 1;
  }
  const talent = rows.find(row => row.guild_key === 'guild_talent_direction');
  const custom = rows.find(row => row.guild_key === customKey);
  assert.ok(talent && custom);
  const talentView = await request(`/public/guilds/${talent.guild_key}/launchpad`);
  const customView = await request(`/public/guilds/${custom.guild_key}/launchpad`);
  assert.equal(talentView.data.config.body.starter.title_label, '私人方向筆記');
  assert.equal(customView.data.config.body.starter.title_label, '我的第一個工作');
  const keys = rows.map(row => row.guild_key).sort();
  assert.deepEqual({catalog_count: rows.length, resolved_count: resolved, keys}, {catalog_count: rows.length, resolved_count: rows.length, keys});
});

test('launchpad drafts stay private, publication is conditional, and authority is current', async () => {
  const leader = await signIn(DEMO_USERS[0].email);
  const member = await signIn(DEMO_USERS[1].email);
  const outsider = await signIn(DEMO_USERS[2].email);
  await lead(leader.user.user_id);
  await join(member.user.user_id, guild);
  const info = await catalog(guild);
  const config = defaultConfigFor(info);
  const marker = `DRAFT_MARKER_${randomUUID()}`;
  const draftBody = {...config, mission_override: marker};
  const inert = {...config, mission_override: '<script>alert(1)</script>'};
  assert.equal((await pool.query('SELECT 1 FROM principals WHERE user_ref=$1', [leader.user.user_id])).rowCount, 0);
  const previewBefore = await counts();
  const preview = await request(`/guilds/${guild}/launchpad-config/preview`, leader, {body: draftBody, preview_mode: 'my_work'});
  assert.equal(preview.status, 200, JSON.stringify(preview.data));
  assert.deepEqual(Object.keys(preview.data).sort(), ['effective_config', 'preview_data_origin', 'validation']);
  assert.equal(preview.data.preview_data_origin, 'synthetic_fixture');
  assert.equal('preview_mode' in preview.data, false);
  assert.deepEqual(preview.data.validation, []);
  assert.deepEqual(await counts(), previewBefore);
  assert.equal((await pool.query('SELECT 1 FROM principals WHERE user_ref=$1', [leader.user.user_id])).rowCount, 0);

  const stored = await request(`/guilds/${guild}/launchpad-config/drafts`, leader, {body: inert}, '1');
  assert.equal(stored.status, 201, JSON.stringify(stored.data));
  assert.equal(stored.data.body.mission_override, '<script>alert(1)</script>');
  assert.match(stored.response.headers.get('content-type') ?? '', /application\/json/);
  const wiped = await request(`/guilds/${guild}/launchpad-config/drafts`, leader, {body: draftBody}, stored.data.pointer_version);
  assert.equal(wiped.status, 201, JSON.stringify(wiped.data));
  const pub = await request(`/public/guilds/${guild}/launchpad`);
  const memberView = await request(`/guilds/${guild}/launchpad`, member);
  assert.equal(JSON.stringify(pub.data).includes(marker), false);
  assert.equal(JSON.stringify(memberView.data).includes(marker), false);
  assert.equal(JSON.stringify(pub.data).includes('<script>'), false);

  const beforeRejected = await counts();
  const rejected: {body: unknown; code: string}[] = [
    {body: {...draftBody, blocks: draftBody.blocks.map(block => block.kind === 'mission' ? {...block, kind: 'nope'} : block)}, code: 'block_kind_invalid'},
    {body: {...draftBody, blocks: draftBody.blocks.map((block, index) => index === 1 ? {...block, kind: 'mission'} : block)}, code: 'block_kind_duplicate'},
    {body: {...draftBody, blocks: draftBody.blocks.slice(1)}, code: 'block_kind_missing'},
    {body: {...draftBody, extensions: {extra: true}}, code: 'unknown_field'},
    {body: {...draftBody, support: {kind: 'platform_help', public_url: 'javascript:alert(1)'}}, code: 'unsupported_url'},
    {body: {...draftBody, support: {kind: 'platform_help', public_url: 'data:text/plain,hi'}}, code: 'unsupported_url'},
    {body: {...draftBody, support: {kind: 'platform_help', public_url: 'http://example.com/help'}}, code: 'unsupported_url'},
    {body: {...draftBody, support: {kind: 'platform_help', public_url: 'https://user:pass@example.com/help'}}, code: 'unsupported_url'},
    {body: {...draftBody, mission_override: 'a'.repeat(1201)}, code: 'too_long'},
    {body: {...draftBody, blocks: draftBody.blocks.map(block => block.kind === 'mission' ? {...block, title: '題'.repeat(121)} : block)}, code: 'too_long'},
    {body: {...draftBody, blocks: draftBody.blocks.map(block => block.kind === 'mission' ? {...block, order: 1001} : block)}, code: 'invalid_order'},
    {body: {...draftBody, blocks: draftBody.blocks.map(block => block.kind === 'announcements' ? {...block, order: 0} : block)}, code: 'invalid_order'},
    {body: {...draftBody, blocks: draftBody.blocks.map(block => block.kind === 'mission' ? {...block, enabled: false} : block)}, code: 'enabled_locked'},
    {body: {...draftBody, mission_override: '第一行\n第二行'}, code: 'control_character'},
  ];
  for (const item of rejected) {
    const result = await request(`/guilds/${guild}/launchpad-config/drafts`, leader, {body: item.body}, wiped.data.pointer_version);
    assert.equal(result.status, 422, JSON.stringify(result.data));
    hasError(result.data, item.code);
  }
  assert.deepEqual(await counts(), beforeRejected);

  const upper = await request(`/guilds/${guild}/launchpad-config/${wiped.data.config_id}/publish`, leader, {expected_body_sha256: wiped.data.body_sha256.toUpperCase()}, wiped.data.pointer_version);
  assert.equal(upper.status, 422);
  assert.equal(upper.data.code, 'invalid_body_sha256');
  const mismatch = await request(`/guilds/${guild}/launchpad-config/${wiped.data.config_id}/publish`, leader, {expected_body_sha256: 'ab'.repeat(32)}, wiped.data.pointer_version);
  assert.equal(mismatch.status, 412);
  assert.equal(mismatch.data.code, 'version_conflict');

  const raced = await Promise.all([
    request(`/guilds/${guild}/launchpad-config/${wiped.data.config_id}/publish`, leader, {expected_body_sha256: wiped.data.body_sha256}, wiped.data.pointer_version),
    request(`/guilds/${guild}/launchpad-config/${wiped.data.config_id}/publish`, leader, {expected_body_sha256: wiped.data.body_sha256}, wiped.data.pointer_version),
  ]);
  assert.deepEqual(raced.map(item => item.status).sort(), [200, 412]);
  const published = raced.find(item => item.status === 200)!;
  const again = await request(`/guilds/${guild}/launchpad-config/${wiped.data.config_id}/publish`, leader, {expected_body_sha256: wiped.data.body_sha256}, published.data.pointer_version);
  assert.equal(again.status, 409);
  assert.equal(again.data.code, 'config_not_draft');
  const outbox = (await pool.query('SELECT event_type, payload FROM outbox WHERE event_type=$1', [event])).rows;
  assert.equal(outbox.length, 1);
  assert.deepEqual(outbox[0].payload.data, {guild_key: guild, config_id: published.data.config_id, revision: published.data.revision});
  assert.equal('tenant_id' in outbox[0].payload, false);
  assert.equal('source_instance_id' in outbox[0].payload, false);
  assert.equal('tenant_id' in outbox[0].payload.data, false);
  const visible = await request(`/public/guilds/${guild}/launchpad`);
  assert.equal(visible.data.config.body.mission_override, marker);

  const prior = (await pool.query(`SELECT config_id, revision::text AS revision, body, status FROM guild_launchpad_config_revisions
    WHERE guild_key=$1 ORDER BY revision`, [guild])).rows;
  const reverted = await request(`/guilds/${guild}/launchpad-config/revert`, leader, {to_revision: published.data.revision, reason: '回復這次測試發布的內容'}, published.data.pointer_version);
  assert.equal(reverted.status, 200, JSON.stringify(reverted.data));
  assert.ok(BigInt(reverted.data.revision) > BigInt(published.data.revision));
  assert.notEqual(reverted.data.config_id, published.data.config_id);
  assert.equal(reverted.data.body.mission_override, marker);
  const after = (await pool.query(`SELECT config_id, revision::text AS revision, body, status FROM guild_launchpad_config_revisions
    WHERE guild_key=$1 ORDER BY revision`, [guild])).rows;
  for (const row of prior) {
    const same = after.find(item => item.config_id === row.config_id);
    assert.equal(same.revision, row.revision);
    assert.deepEqual(same.body, row.body);
    if (row.status === 'published') assert.equal(same.status, 'superseded');
    else assert.equal(same.status, row.status);
  }

  const freshLeader = await signIn(DEMO_USERS[0].email);
  await pool.query('DELETE FROM positioning_guild_officers WHERE community_id=$1 AND guild_key=$2', [DEMO_COMMUNITY, 'guild_event_space']);
  await lead(freshLeader.user.user_id, 'guild_event_space');
  const space = defaultConfigFor(await catalog('guild_event_space'));
  const firstDrafts = await Promise.all([
    request('/guilds/guild_event_space/launchpad-config/drafts', freshLeader, {body: space}, '1'),
    request('/guilds/guild_event_space/launchpad-config/drafts', freshLeader, {body: space}, '1'),
  ]);
  assert.deepEqual(firstDrafts.map(item => item.status).sort(), [201, 412]);

  await pool.query('INSERT INTO principals(user_ref) VALUES($1) ON CONFLICT (user_ref) DO NOTHING', [member.user.user_id]);
  const principal = (await pool.query('SELECT principal_id FROM principals WHERE user_ref=$1', [member.user.user_id])).rows[0].principal_id as string;
  const expires = new Date(Date.now() + 86_400_000).toISOString();
  const granted = await request(`/guilds/${guild}/launchpad-delegations`, leader, {principal_id: principal, capabilities: ['guild.content.edit', 'guild.config.publish'], expires_at: expires});
  assert.equal(granted.status, 201, JSON.stringify(granted.data));
  assert.equal(granted.data.version, '1');
  const delegateDraftKey = randomUUID();
  const delegated = await request(`/guilds/${guild}/launchpad-config/drafts`, member, {body: draftBody}, reverted.data.pointer_version, delegateDraftKey);
  assert.equal(delegated.status, 201, JSON.stringify(delegated.data));
  const revoked = await request(`/guilds/${guild}/launchpad-delegations/${granted.data.delegation_id}/revoke`, leader, {reason: '測試結束，收回授權'}, granted.data.version);
  assert.equal(revoked.status, 200, JSON.stringify(revoked.data));
  const replay = await request(`/guilds/${guild}/launchpad-config/drafts`, member, {body: draftBody}, reverted.data.pointer_version, delegateDraftKey);
  assert.equal(replay.status, 403);
  assert.equal(replay.data.code, 'guild_leader_required');
  const deniedPublish = await request(`/guilds/${guild}/launchpad-config/${delegated.data.config_id}/publish`, member, {expected_body_sha256: delegated.data.body_sha256}, delegated.data.pointer_version);
  assert.equal(deniedPublish.status, 403);
  assert.equal(deniedPublish.data.code, 'guild_leader_required');

  const stranger = await request(`/guilds/${guild}/launchpad-config/drafts`, outsider, {body: config}, '1');
  assert.equal(stranger.status, 403);
  assert.equal(stranger.data.code, 'guild_leader_required');
  const notMember = await request(`/guilds/${guild}/launchpad`, outsider);
  assert.equal(notMember.status, 403);
  assert.equal(notMember.data.code, 'guild_member_required');
  const missing = await request('/public/guilds/not_a_guild/launchpad');
  assert.equal(missing.status, 404);
  assert.equal(missing.data.code, 'guild_not_found');
  const missingMember = await request('/guilds/not_a_guild/launchpad', leader);
  assert.equal(missingMember.status, 404);
  assert.equal(missingMember.data.code, 'guild_not_found');

  for (const target of [disabled]) {
    const anon = await request(`/public/guilds/${guild}/launchpad`, undefined, undefined, undefined, randomUUID(), target);
    const signed = await request(`/guilds/${guild}/launchpad`, leader, undefined, undefined, randomUUID(), target);
    assert.equal(anon.status, 404);
    assert.equal(anon.data.code, 'not_found');
    assert.equal(anon.data.detail, '此版本尚未提供這個 API。');
    assert.equal(signed.status, 404);
    assert.equal(signed.data.code, 'not_found');
  }
});
