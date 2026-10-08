import {test, before, after, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Client, Pool} from 'pg';
import {createPool, LOCAL_DATABASE_URL} from '../../packages/db/index.js';
import {migrate} from '../../scripts/database.js';
import {seedLocal, DEMO_USERS, DEMO_PASSWORD, DEMO_COMMUNITY} from '../../packages/testing/seed.js';
import {createApp} from '../../apps/platform-api/src/app.js';
import {BLOCK_KINDS, ConfigValidationError, parseConfig} from '../../contracts/guild-launchpad/v1/config.js';
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
    assert.deepEqual(Object.keys(view.data.guild).sort(), ['guild_key', 'name', 'purpose']);
    assert.equal(pub.data.config_problem, null);
    assert.equal(view.data.config_problem, null);
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
  const objective = '寫下這次工作的目標。';
  const note = '記下過程、來源與下一步。';
  const starterCells: Record<string, string> = {
    guild_talent_direction: '私人方向筆記；目標、下一步',
    guild_member_operations: '新人支援／活動準備',
    guild_platform_engineering: '問題重現／規格筆記',
    guild_ai_vibe: '開源作品需求／驗收',
    guild_ai_field: '導入測試計畫',
    guild_ai_project: '範圍／里程碑／交付',
    guild_opportunity_partnership: '合作需求紀錄',
    guild_product_quality_supply: '商品／供貨檢查清單',
    guild_commerce_sales: '選品／營運待辦',
    guild_commerce_settlement: '商家對帳步驟／證據索引',
    guild_marketing: '內容草稿／發布計畫',
    guild_media_automation: '腳本／素材與剪輯brief',
    guild_security: '授權範圍／檢查證據',
    guild_music_mv: '歌曲／MV構想與素材來源',
    guild_commercial_production: '拍攝brief／分鏡／交付',
    guild_event_space: '場地brief／動線／備援',
    guild_projection_mapping: '場勘／投影分區／cue表',
    guild_human_design: '共讀來源／限制／反思',
  };
  assert.equal(Object.keys(starterCells).length, 18);
  for (const [key, cell] of Object.entries(starterCells)) {
    const split = cell.indexOf('；');
    const title = split === -1 ? cell : cell.slice(0, split);
    const hint = split === -1 ? objective : cell.slice(split + 1);
    const seen = await request(`/public/guilds/${key}/launchpad`);
    assert.equal(seen.data.config.body.starter.title_label, title, key);
    assert.equal(seen.data.config.body.starter.objective_hint, hint, key);
    assert.equal(seen.data.config.body.starter.note_hint, note, key);
  }
  const custom = rows.find(row => row.guild_key === customKey);
  assert.ok(custom);
  const customView = await request(`/public/guilds/${custom.guild_key}/launchpad`);
  assert.equal(customView.data.config.body.starter.title_label, '我的第一個工作');
  assert.equal(customView.data.config.body.starter.objective_hint, objective);
  assert.equal(customView.data.config.body.starter.note_hint, note);
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
    {body: {...draftBody, support: {kind: 'platform_help', public_url: 'https:example.com'}}, code: 'unsupported_url'},
    {body: {...draftBody, support: {kind: 'platform_help', public_url: 'https:/example.com'}}, code: 'unsupported_url'},
    {body: {...draftBody, support: {kind: 'platform_help', public_url: 'https://'}}, code: 'unsupported_url'},
    {body: {...draftBody, support: {kind: 'platform_help', public_url: 'https://user:pw@example.com'}}, code: 'unsupported_url'},
    {body: {...draftBody, support: {kind: 'platform_help', public_url: 'vbscript:msgbox(1)'}}, code: 'unsupported_url'},
    {body: {...draftBody, support: {kind: 'platform_help', public_url: 'VBScript:msgbox(1)'}}, code: 'unsupported_url'},
    {body: {...draftBody, support: {kind: 'platform_help', public_url: 'JAVASCRIPT:alert(1)'}}, code: 'unsupported_url'},
    {body: {...draftBody, support: {kind: 'platform_help', public_url: ' https://example.com/help'}}, code: 'unsupported_url'},
    {body: {...draftBody, blocks: draftBody.blocks.map(block => block.kind === 'mission' ? {...block, title: ''} : block)}, code: 'too_short'},
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
  const revertReason = '回復這次測試發布的內容';
  const revertRow = (await pool.query(`SELECT revert_reason, reverted_from_revision::text AS reverted_from_revision
    FROM guild_launchpad_config_revisions WHERE config_id=$1`, [reverted.data.config_id])).rows[0];
  assert.equal(revertRow.revert_reason, revertReason);
  assert.equal(revertRow.reverted_from_revision, published.data.revision);
  const untouched = (await pool.query(`SELECT count(*)::int AS n FROM guild_launchpad_config_revisions
    WHERE guild_key=$1 AND config_id<>$2 AND revert_reason IS NOT NULL`, [guild, reverted.data.config_id])).rows[0].n;
  assert.equal(untouched, 0);
  await assert.rejects(pool.query(`UPDATE guild_launchpad_config_revisions SET revert_reason='改寫原因' WHERE config_id=$1`, [reverted.data.config_id]), (error: {message?: string}) => /immutable/.test(error.message ?? ''));
  const publicAfter = await request(`/public/guilds/${guild}/launchpad`);
  const memberAfter = await request(`/guilds/${guild}/launchpad`, member);
  assert.equal(JSON.stringify(publicAfter.data).includes(revertReason), false);
  assert.equal(JSON.stringify(memberAfter.data).includes(revertReason), false);
  const leaderView = await request(`/guilds/${guild}/launchpad-config`, leader);
  const listed = leaderView.data.revisions.find((item: {revision: string}) => item.revision === reverted.data.revision);
  assert.equal(listed.revert_reason, revertReason);
  assert.equal(listed.reverted_from_revision, published.data.revision);
  const publishedEvents = (await pool.query('SELECT payload FROM outbox WHERE event_type=$1', [event])).rows;
  assert.equal(JSON.stringify(publishedEvents).includes(revertReason), false);
  const journals = (await pool.query(`SELECT data FROM transition_journal WHERE aggregate_type='guild_launchpad_config'`)).rows;
  assert.equal(JSON.stringify(journals).includes(revertReason), false);
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

});

const launchpadRoutes: {method: 'GET' | 'POST'; path: string}[] = [
  {method: 'GET', path: `/public/guilds/${guild}/launchpad`},
  {method: 'GET', path: `/guilds/${guild}/launchpad`},
  {method: 'GET', path: `/guilds/${guild}/launchpad-config`},
  {method: 'POST', path: `/guilds/${guild}/launchpad-config/drafts`},
  {method: 'POST', path: `/guilds/${guild}/launchpad-config/preview`},
  {method: 'POST', path: `/guilds/${guild}/launchpad-config/${randomUUID()}/publish`},
  {method: 'POST', path: `/guilds/${guild}/launchpad-config/revert`},
  {method: 'POST', path: `/guilds/${guild}/launchpad-delegations`},
  {method: 'POST', path: `/guilds/${guild}/launchpad-delegations/${randomUUID()}/revoke`},
];

async function probe(target: ReturnType<typeof createApp>, path: string, method: 'GET' | 'POST', session?: Session, csrf = true) {
  const headers: Record<string, string> = {Origin: origin};
  if (session) {
    headers.Cookie = session.cookie;
    if (csrf) headers['X-CSRF-Token'] = session.csrf;
  }
  if (method === 'POST') {
    headers['Content-Type'] = 'application/json';
    headers['Idempotency-Key'] = randomUUID();
  }
  const response = await target.request(origin + '/api/v1' + path, {method, headers, body: method === 'POST' ? '{}' : undefined});
  return {status: response.status, data: await response.json()};
}

test('the site flag follows community and a disabled app matches unknown paths', async () => {
  for (const target of [app, disabled]) {
    const response = await target.request(origin + '/api/v1/site');
    const text = await response.text();
    assert.equal(response.status, 200);
    const body = JSON.parse(text) as Record<string, unknown>;
    const keys = Object.keys(body);
    assert.equal(keys[keys.indexOf('community') + 1], 'guild_launchpad_enabled');
    assert.equal(body.guild_launchpad_enabled, target === app);
    assert.match(text, /,"community":.+"guild_launchpad_enabled":(true|false)(?:,|})/);
  }
  const member = await signIn();
  const unknown = `/guilds/${guild}/launchpad-zz-${randomUUID()}`;
  for (const route of launchpadRoutes) {
    for (const session of [undefined, member] as const) {
      const actual = await probe(disabled, route.path, route.method, session);
      const control = await probe(disabled, unknown, route.method, session);
      assert.equal(actual.status, control.status, `${route.method} ${route.path} signed ${session ? 'in' : 'out'}`);
      assert.deepEqual(actual.data, control.data);
    }
    if (route.method === 'POST') {
      const actual = await probe(disabled, route.path, route.method, member, false);
      const control = await probe(disabled, unknown, route.method, member, false);
      assert.equal(actual.status, control.status);
      assert.deepEqual(actual.data, control.data);
    }
  }
});

test('astral titles round-trip and a lone surrogate is rejected', async () => {
  const leader = await signIn();
  await lead(leader.user.user_id);
  const config = defaultConfigFor(await catalog(guild));
  const astral = '起步 🚀 與 𠮷';
  const body = {
    ...config,
    mission_override: astral,
    blocks: config.blocks.map(block => block.kind === 'announcements' ? {...block, title: astral} : block),
    starter: {title_label: astral, objective_hint: astral, note_hint: astral},
  };
  const draft = await request(`/guilds/${guild}/launchpad-config/drafts`, leader, {body}, '1');
  assert.equal(draft.status, 201, JSON.stringify(draft.data));
  assert.equal(draft.data.body.mission_override, astral);
  assert.equal(draft.data.body.blocks.find((block: {kind: string}) => block.kind === 'announcements').title, astral);
  assert.equal(draft.data.body.starter.title_label, astral);
  assert.equal(draft.data.body.starter.objective_hint, astral);
  assert.equal(draft.data.body.starter.note_hint, astral);
  const published = await request(`/guilds/${guild}/launchpad-config/${draft.data.config_id}/publish`, leader, {expected_body_sha256: draft.data.body_sha256}, draft.data.pointer_version);
  assert.equal(published.status, 200, JSON.stringify(published.data));
  const pub = await request(`/public/guilds/${guild}/launchpad`);
  assert.equal(pub.status, 200, JSON.stringify(pub.data));
  const seen = pub.data.config.body;
  assert.equal(seen.mission_override, astral);
  assert.equal(seen.blocks.find((block: {kind: string}) => block.kind === 'announcements').title, astral);
  assert.equal(seen.starter.title_label, astral);
  assert.equal(seen.starter.objective_hint, astral);
  assert.equal(seen.starter.note_hint, astral);
  assert.equal(Buffer.from(JSON.stringify(seen.mission_override)).equals(Buffer.from(JSON.stringify(astral))), true);
  const lone = await request(`/guilds/${guild}/launchpad-config/drafts`, leader, {body: {...config, blocks: config.blocks.map(block => block.kind === 'announcements' ? {...block, title: '題\uD800'} : block)}}, published.data.pointer_version);
  assert.equal(lone.status, 422, JSON.stringify(lone.data));
  hasError(lone.data, 'lone_surrogate');
  const reverted = await request(`/guilds/${guild}/launchpad-config/revert`, leader, {to_revision: published.data.revision, reason: `回復 ${astral}`}, published.data.pointer_version);
  assert.equal(reverted.status, 200, JSON.stringify(reverted.data));
  assert.equal(reverted.data.body.mission_override, astral);
});

test('delegation refuses a non-member and a service principal', async () => {
  const leader = await signIn(DEMO_USERS[0].email);
  const outsider = await signIn(DEMO_USERS[2].email);
  await lead(leader.user.user_id);
  await pool.query(`INSERT INTO positioning_profession_memberships(membership_id, community_id, user_id, guild_key, state, member_tier)
    VALUES($1,$2,$3,$4,'left','full')`, [randomUUID(), DEMO_COMMUNITY, outsider.user.user_id, guild]);
  await pool.query('INSERT INTO principals(user_ref) VALUES($1)', [outsider.user.user_id]);
  const person = (await pool.query('SELECT principal_id FROM principals WHERE user_ref=$1', [outsider.user.user_id])).rows[0].principal_id as string;
  const shop = randomUUID();
  await pool.query(`INSERT INTO commerce_shops(shop_id, community_id, owner_id, kind, name, description, website_url, contact, currency, manifest_sha256)
    VALUES($1,$2,$3,'internal','服務身份','測試用商店','https://shop.example.invalid','none','TWD',$4)`, [shop, DEMO_COMMUNITY, leader.user.user_id, randomUUID().replaceAll('-', '')]);
  const service = (await pool.query(`INSERT INTO principals(kind, service_shop_ref) VALUES('service',$1) RETURNING principal_id`, [shop])).rows[0].principal_id as string;
  const expires = new Date(Date.now() + 86_400_000).toISOString();
  for (const principalId of [person, service]) {
    const denied = await request(`/guilds/${guild}/launchpad-delegations`, leader, {principal_id: principalId, capabilities: ['guild.content.edit'], expires_at: expires});
    assert.equal(denied.status, 422, JSON.stringify(denied.data));
    assert.equal(denied.data.code, 'delegation_recipient_invalid');
  }
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM guild_launchpad_delegations')).rows[0].n, 0);
});

function canonicalSize(value: unknown) {
  const stable = (current: unknown): unknown => {
    if (Array.isArray(current)) return current.map(stable);
    if (current && typeof current === 'object') {
      const record = current as Record<string, unknown>;
      return Object.fromEntries(Object.keys(record).sort().map(key => [key, stable(record[key])]));
    }
    return current;
  };
  return new TextEncoder().encode(JSON.stringify(stable(value))).length;
}
async function editorPrincipal(userId: string) {
  await pool.query('INSERT INTO principals(user_ref) VALUES($1) ON CONFLICT (user_ref) DO NOTHING', [userId]);
  return (await pool.query('SELECT principal_id FROM principals WHERE user_ref=$1', [userId])).rows[0].principal_id as string;
}
async function guildFacts(key: string) {
  const revisions = (await pool.query('SELECT count(*)::int AS n FROM guild_launchpad_config_revisions WHERE community_id=$1 AND guild_key=$2', [DEMO_COMMUNITY, key])).rows[0].n as number;
  const pointer = (await pool.query('SELECT config_id, pointer_version::text AS pointer_version FROM guild_launchpad_config_pointers WHERE community_id=$1 AND guild_key=$2', [DEMO_COMMUNITY, key])).rows[0] as {config_id: string; pointer_version: string} | undefined;
  return {revisions, pointer: pointer ?? null};
}
async function waitUntil(probe: () => Promise<boolean>, label: string, budgetMs: number) {
  const start = Date.now();
  while (Date.now() - start < budgetMs) {
    if (await probe()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${label}`);
}
async function insertActiveDelegation(guildKey: string, principalId: string, grantorId: string, lifetime: '2 seconds' | '1 day' | '-1 second') {
  const expiresSql = lifetime === '2 seconds'
    ? "clock_timestamp() + interval '2 seconds'"
    : lifetime === '-1 second'
      ? "clock_timestamp() - interval '1 second'"
      : "clock_timestamp() + interval '1 day'";
  const row = (await pool.query(`INSERT INTO guild_launchpad_delegations
    (delegation_id, community_id, guild_key, principal_id, capabilities, granted_by_principal_id, expires_at, version, status)
    VALUES ($1,$2,$3,$4,$5,$6,${expiresSql},1,'active')
    RETURNING delegation_id`, [randomUUID(), DEMO_COMMUNITY, guildKey, principalId, ['guild.content.edit', 'guild.config.publish'], grantorId])).rows[0];
  return row.delegation_id as string;
}
async function delegationClockPassed(delegationId: string) {
  return (await pool.query('SELECT clock_timestamp() > expires_at AS past FROM guild_launchpad_delegations WHERE delegation_id=$1', [delegationId])).rows[0].past === true;
}
async function waitingOnGuildLock(holderPid: number) {
  const found = await admin.query(`SELECT blocked.pid
    FROM pg_locks blocked
    JOIN pg_locks holder
      ON holder.locktype = blocked.locktype
     AND holder.database IS NOT DISTINCT FROM blocked.database
     AND holder.classid IS NOT DISTINCT FROM blocked.classid
     AND holder.objid IS NOT DISTINCT FROM blocked.objid
     AND holder.objsubid IS NOT DISTINCT FROM blocked.objsubid
     AND holder.granted AND NOT blocked.granted
    WHERE holder.pid = $1 AND holder.locktype = 'advisory'
      AND holder.pid = ANY (pg_blocking_pids(blocked.pid))`, [holderPid]);
  return (found.rowCount ?? 0) > 0;
}
async function expectLockWaitRejects(guildKey: string, delegationId: string, start: () => Promise<{status: number; data: {code?: string}}>) {
  const holder = new Client({connectionString: databaseUrl, options: `-c search_path=${schema}`});
  await holder.connect();
  let inflight: Promise<{status: number; data: {code?: string}}> | undefined;
  try {
    await holder.query('BEGIN');
    await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`guild-launchpad/${DEMO_COMMUNITY}/${guildKey}`]);
    const pid = (await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
    inflight = start();
    await waitUntil(() => waitingOnGuildLock(pid), 'delegate waiting on the guild lock', 5_000);
    const before = await guildFacts(guildKey);
    await waitUntil(() => delegationClockPassed(delegationId), 'delegation expiry', 8_000);
    await holder.query('COMMIT');
    const result = await inflight;
    inflight = undefined;
    assert.equal(result.status, 403, JSON.stringify(result.data));
    assert.equal(result.data.code, 'guild_leader_required');
    assert.deepEqual(await guildFacts(guildKey), before);
  } finally {
    await holder.query('ROLLBACK').catch(() => undefined);
    if (inflight) await inflight.catch(() => undefined);
    await holder.end();
  }
}
async function insertDraftRow(guildKey: string, principalId: string, revision: string, body: unknown) {
  const configId = randomUUID();
  const schemaVersion = body && typeof body === 'object' && 'schema_version' in body ? String((body as {schema_version: unknown}).schema_version) : 'guild-launchpad.config/v1';
  await pool.query(`INSERT INTO guild_launchpad_config_revisions
    (config_id, community_id, guild_key, revision, schema_version, body, body_sha256, status, source, created_by_principal_id)
    VALUES ($1,$2,$3,$4::bigint,$5,$6::jsonb,$7,'draft','guild_editor',$8)`,
  [configId, DEMO_COMMUNITY, guildKey, revision, schemaVersion, JSON.stringify(body), 'ab'.repeat(32), principalId]);
  return configId;
}
async function publishStoredDraft(guildKey: string, configId: string) {
  await pool.query(`UPDATE guild_launchpad_config_revisions SET status='superseded'
    WHERE community_id=$1 AND guild_key=$2 AND status='published' AND config_id<>$3`, [DEMO_COMMUNITY, guildKey, configId]);
  await pool.query(`UPDATE guild_launchpad_config_revisions SET status='published' WHERE config_id=$1 AND status='draft'`, [configId]);
}
async function pointAt(guildKey: string, configId: string) {
  const updated = await pool.query(`UPDATE guild_launchpad_config_pointers
    SET config_id=$3, pointer_version=pointer_version+1
    WHERE community_id=$1 AND guild_key=$2
    RETURNING pointer_version::text AS pointer_version`, [DEMO_COMMUNITY, guildKey, configId]);
  assert.equal(updated.rowCount, 1);
  return updated.rows[0].pointer_version as string;
}

test('a literal https support url is stored on a draft', async () => {
  const key = 'guild_product_quality_supply';
  const leader = await signIn();
  await lead(leader.user.user_id, key);
  const body = {...defaultConfigFor(await catalog(key)), support: {kind: 'platform_help' as const, public_url: 'https://example.com/help'}};
  const draft = await request(`/guilds/${key}/launchpad-config/drafts`, leader, {body}, '1');
  assert.equal(draft.status, 201, JSON.stringify(draft.data));
  assert.equal(draft.data.body.support.public_url, 'https://example.com/help');
});

test('config size uses the canonical JSON byte length', async () => {
  const key = 'guild_ai_project';
  const leader = await signIn();
  await lead(leader.user.user_id, key);
  const base = defaultConfigFor(await catalog(key));
  const overhead = canonicalSize({...base, pad: ''});
  assert.ok(overhead < 24_000, String(overhead));
  const before = await guildFacts(key);
  const fit = {...base, pad: 'x'.repeat(30_000 - overhead)};
  assert.equal(canonicalSize(fit), 30_000);
  const within = await request(`/guilds/${key}/launchpad-config/drafts`, leader, {body: fit}, '1');
  assert.equal(within.status, 422, JSON.stringify(within.data));
  hasError(within.data, 'unknown_field');
  assert.equal(within.data.errors.some((error: {code: string}) => error.code === 'config_too_large'), false);
  const atCap = {...base, pad: 'x'.repeat(32_768 - overhead)};
  assert.equal(canonicalSize(atCap), 32_768);
  assert.throws(() => parseConfig(atCap, key), (error: unknown) => {
    assert.ok(error instanceof ConfigValidationError);
    assert.equal(error.errors.some(item => item.code === 'config_too_large'), false);
    assert.ok(error.errors.some(item => item.code === 'unknown_field'));
    return true;
  });
  const over = {...base, pad: 'x'.repeat(32_769 - overhead)};
  assert.equal(canonicalSize(over), 32_769);
  assert.throws(() => parseConfig(over, key), (error: unknown) => {
    assert.ok(error instanceof ConfigValidationError);
    assert.deepEqual(error.errors, [{code: 'config_too_large', path: ''}]);
    return true;
  });
  assert.deepEqual(await guildFacts(key), before);
});

test('revision and to_revision reject values outside the stored version range', async () => {
  const leader = await signIn();
  await lead(leader.user.user_id);
  const before = await guildFacts(guild);
  for (const value of ['abc', '0', '9223372036854775808']) {
    const read = await request(`/guilds/${guild}/launchpad-config?revision=${encodeURIComponent(value)}`, leader);
    assert.equal(read.status, 422, JSON.stringify(read.data));
    assert.equal(read.data.code, 'validation_failed');
    assert.ok(read.data.errors.some((error: {code: string; path: string}) => error.code === 'version_invalid' && error.path === 'revision'), JSON.stringify(read.data));
    const revert = await request(`/guilds/${guild}/launchpad-config/revert`, leader, {to_revision: value, reason: '版本格式不正確'}, '1');
    assert.equal(revert.status, 422, JSON.stringify(revert.data));
    assert.equal(revert.data.code, 'validation_failed');
    assert.ok(revert.data.errors.some((error: {code: string; path: string}) => error.code === 'version_invalid' && error.path === 'to_revision'), JSON.stringify(revert.data));
  }
  const max = await request(`/guilds/${guild}/launchpad-config?revision=9223372036854775807`, leader);
  assert.equal(max.status, 404, JSON.stringify(max.data));
  assert.equal(max.data.code, 'config_revision_not_found');
  assert.deepEqual(await guildFacts(guild), before);
});

test('a delegate who waits out the lock loses authority, and a departed member cannot use a delegation', async () => {
  const key = 'guild_platform_engineering';
  const leader = await signIn(DEMO_USERS[0].email);
  const editor = await signIn(DEMO_USERS[1].email);
  const publisher = await signIn(DEMO_USERS[2].email);
  await lead(leader.user.user_id, key);
  await join(editor.user.user_id, key);
  await join(publisher.user.user_id, key);
  const grantor = await editorPrincipal(leader.user.user_id);
  const body = defaultConfigFor(await catalog(key));
  const draftDelegation = await insertActiveDelegation(key, await editorPrincipal(editor.user.user_id), grantor, '2 seconds');
  await expectLockWaitRejects(key, draftDelegation, () => request(`/guilds/${key}/launchpad-config/drafts`, editor, {body}, '1'));

  const draft = await request(`/guilds/${key}/launchpad-config/drafts`, leader, {body}, '1');
  assert.equal(draft.status, 201, JSON.stringify(draft.data));
  const publishDelegation = await insertActiveDelegation(key, await editorPrincipal(publisher.user.user_id), grantor, '2 seconds');
  await expectLockWaitRejects(key, publishDelegation, () => request(`/guilds/${key}/launchpad-config/${draft.data.config_id}/publish`, publisher, {expected_body_sha256: draft.data.body_sha256}, draft.data.pointer_version));
  assert.equal((await pool.query('SELECT status FROM guild_launchpad_config_revisions WHERE config_id=$1', [draft.data.config_id])).rows[0].status, 'draft');

  const departedKey = 'guild_member_operations';
  await lead(leader.user.user_id, departedKey);
  const departed = await signIn(DEMO_USERS[1].email);
  await pool.query(`INSERT INTO positioning_profession_memberships(membership_id, community_id, user_id, guild_key, state, member_tier)
    VALUES($1,$2,$3,$4,'left','full')`, [randomUUID(), DEMO_COMMUNITY, departed.user.user_id, departedKey]);
  const stored = await request(`/guilds/${departedKey}/launchpad-config/drafts`, leader, {body: defaultConfigFor(await catalog(departedKey))}, '1');
  assert.equal(stored.status, 201, JSON.stringify(stored.data));
  await insertActiveDelegation(departedKey, await editorPrincipal(departed.user.user_id), await editorPrincipal(leader.user.user_id), '1 day');
  const facts = await guildFacts(departedKey);
  const deniedDraft = await request(`/guilds/${departedKey}/launchpad-config/drafts`, departed, {body: defaultConfigFor(await catalog(departedKey))}, stored.data.pointer_version);
  assert.equal(deniedDraft.status, 403, JSON.stringify(deniedDraft.data));
  assert.equal(deniedDraft.data.code, 'guild_leader_required');
  const deniedPublish = await request(`/guilds/${departedKey}/launchpad-config/${stored.data.config_id}/publish`, departed, {expected_body_sha256: stored.data.body_sha256}, stored.data.pointer_version);
  assert.equal(deniedPublish.status, 403, JSON.stringify(deniedPublish.data));
  assert.equal(deniedPublish.data.code, 'guild_leader_required');
  assert.deepEqual(await guildFacts(departedKey), facts);
});

test('an expired active delegation can be granted again and a live one cannot', async () => {
  const leader = await signIn(DEMO_USERS[0].email);
  const member = await signIn(DEMO_USERS[1].email);
  const marked = await signIn(DEMO_USERS[2].email);
  await lead(leader.user.user_id);
  await join(member.user.user_id, guild);
  await join(marked.user.user_id, guild);
  const principal = await editorPrincipal(member.user.user_id);
  const soon = (await pool.query(`SELECT to_char((clock_timestamp() + interval '4 seconds') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS expires_at`)).rows[0].expires_at as string;
  const first = await request(`/guilds/${guild}/launchpad-delegations`, leader, {principal_id: principal, capabilities: ['guild.content.edit', 'guild.config.publish'], expires_at: soon});
  assert.equal(first.status, 201, JSON.stringify(first.data));
  const live = new Date(Date.now() + 86_400_000).toISOString();
  const conflict = await request(`/guilds/${guild}/launchpad-delegations`, leader, {principal_id: principal, capabilities: ['guild.content.edit'], expires_at: live});
  assert.equal(conflict.status, 409, JSON.stringify(conflict.data));
  assert.equal(conflict.data.code, 'delegation_exists');
  await assert.rejects(
    pool.query(`UPDATE guild_launchpad_delegations SET status='expired', version=version+1 WHERE delegation_id=$1`, [first.data.delegation_id]),
    (error: {message?: string}) => /not allowed/.test(error.message ?? ''),
  );
  await waitUntil(() => delegationClockPassed(first.data.delegation_id), 'delegation expiry', 8_000);
  const again = await request(`/guilds/${guild}/launchpad-delegations`, leader, {principal_id: principal, capabilities: ['guild.config.publish'], expires_at: live});
  assert.equal(again.status, 201, JSON.stringify(again.data));
  assert.notEqual(again.data.delegation_id, first.data.delegation_id);
  assert.equal((await pool.query('SELECT status FROM guild_launchpad_delegations WHERE delegation_id=$1', [first.data.delegation_id])).rows[0].status, 'expired');
  const journal = (await pool.query(`SELECT command, data FROM transition_journal WHERE aggregate_type='guild_launchpad_delegation' AND aggregate_id=$1`, [first.data.delegation_id])).rows;
  assert.equal(journal.length, 1);
  assert.equal(journal[0].command, 'expire');
  assert.equal(journal[0].data.status, 'expired');
  const outbox = (await pool.query(`SELECT o.event_id FROM outbox o
    JOIN transition_journal j ON j.transition_id=o.transition_id
    WHERE j.aggregate_type='guild_launchpad_delegation' AND j.aggregate_id=$1`, [first.data.delegation_id])).rowCount;
  assert.equal(outbox, 0);
  const markedPrincipal = await editorPrincipal(marked.user.user_id);
  const stale = await insertActiveDelegation(guild, markedPrincipal, await editorPrincipal(leader.user.user_id), '-1 second');
  const listed = await request(`/guilds/${guild}/launchpad-config`, leader);
  assert.equal(listed.status, 200, JSON.stringify(listed.data));
  const fresh = listed.data.delegations.find((row: {delegation_id: string}) => row.delegation_id === again.data.delegation_id);
  const past = listed.data.delegations.find((row: {delegation_id: string}) => row.delegation_id === stale);
  assert.equal(listed.data.delegations.some((row: {delegation_id: string}) => row.delegation_id === first.data.delegation_id), false);
  assert.equal(fresh.expired, false);
  assert.match(fresh.expires_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(past.expired, true);
  assert.match(past.expires_at, /^\d{4}-\d{2}-\d{2}T/);
});

test('an unparsable published config falls back to the previous safe revision', async () => {
  const key = 'guild_security';
  const leader = await signIn(DEMO_USERS[0].email);
  const member = await signIn(DEMO_USERS[1].email);
  await lead(leader.user.user_id, key);
  await join(member.user.user_id, key);
  const marker = `SAFE_MARKER_${randomUUID()}`;
  const goodBody = {...defaultConfigFor(await catalog(key)), mission_override: marker};
  const published = await request(`/guilds/${key}/launchpad-config/drafts`, leader, {body: goodBody}, '1');
  assert.equal(published.status, 201, JSON.stringify(published.data));
  const live = await request(`/guilds/${key}/launchpad-config/${published.data.config_id}/publish`, leader, {expected_body_sha256: published.data.body_sha256}, published.data.pointer_version);
  assert.equal(live.status, 200, JSON.stringify(live.data));
  const principal = await editorPrincipal(leader.user.user_id);
  const badId = await insertDraftRow(key, principal, '2', {schema_version: 'nope'});
  await publishStoredDraft(key, badId);
  const pointer = await pointAt(key, badId);
  const problem = {code: 'config_schema_unsupported', revision: '2'};
  const pub = await request(`/public/guilds/${key}/launchpad`);
  const seen = await request(`/guilds/${key}/launchpad`, member);
  assert.equal(pub.status, 200, JSON.stringify(pub.data));
  assert.equal(seen.status, 200, JSON.stringify(seen.data));
  assert.deepEqual(pub.data.config_problem, problem);
  assert.deepEqual(seen.data.config_problem, problem);
  assert.equal(pub.data.config.revision, live.data.revision);
  assert.equal(pub.data.config.body.mission_override, marker);
  assert.equal(seen.data.config.revision, live.data.revision);
  assert.equal(seen.data.config.config_id, live.data.config_id);
  assert.equal(seen.data.config.source, 'guild_editor');
  assert.equal(seen.data.config.pointer_version, pointer);
  assert.equal(JSON.stringify(pub.data).includes('nope'), false);
  assert.equal(JSON.stringify(seen.data).includes('nope'), false);
  const leaderView = await request(`/guilds/${key}/launchpad-config`, leader);
  assert.equal(leaderView.status, 200, JSON.stringify(leaderView.data));
  assert.deepEqual(leaderView.data.config_problem, problem);
  assert.equal(leaderView.data.body.mission_override, marker);
  const explicit = await request(`/guilds/${key}/launchpad-config?revision=2`, leader);
  assert.equal(explicit.status, 422, JSON.stringify(explicit.data));
  hasError(explicit.data, 'schema_version_invalid');

  const deepKey = 'guild_ai_field';
  await lead(leader.user.user_id, deepKey);
  await join(member.user.user_id, deepKey);
  const deepMarker = `DEEP_MARKER_${randomUUID()}`;
  const first = await request(`/guilds/${deepKey}/launchpad-config/drafts`, leader, {body: {...defaultConfigFor(await catalog(deepKey)), mission_override: deepMarker}}, '1');
  assert.equal(first.status, 201, JSON.stringify(first.data));
  const firstPublish = await request(`/guilds/${deepKey}/launchpad-config/${first.data.config_id}/publish`, leader, {expected_body_sha256: first.data.body_sha256}, first.data.pointer_version);
  assert.equal(firstPublish.status, 200, JSON.stringify(firstPublish.data));
  let current = '';
  for (let revision = 2; revision <= 22; revision += 1) {
    current = await insertDraftRow(deepKey, principal, String(revision), {schema_version: 'nope'});
    await publishStoredDraft(deepKey, current);
  }
  const deepPointer = await pointAt(deepKey, current);
  const deepProblem = {code: 'config_schema_unsupported', revision: '22'};
  const deepPublic = await request(`/public/guilds/${deepKey}/launchpad`);
  const deepMember = await request(`/guilds/${deepKey}/launchpad`, member);
  assert.deepEqual(deepPublic.data.config_problem, deepProblem);
  assert.deepEqual(deepMember.data.config_problem, deepProblem);
  assert.equal(deepPublic.data.config.revision, '1');
  assert.equal(deepPublic.data.config.body.mission_override, null);
  assert.equal(JSON.stringify(deepPublic.data).includes(deepMarker), false);
  assert.equal(deepMember.data.config.source, 'platform_default');
  assert.equal(deepMember.data.config.config_id, null);
  assert.equal(deepMember.data.config.pointer_version, deepPointer);
  assert.equal(JSON.stringify(deepMember.data).includes(deepMarker), false);
});
