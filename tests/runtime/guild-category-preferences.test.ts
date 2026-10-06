import {test, before, after, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {createLocalJWKSet, exportJWK, generateKeyPair, SignJWT} from 'jose';
import {createPool, LOCAL_DATABASE_URL} from '../../packages/db/index.js';
import {migrate} from '../../scripts/database.js';
import {seedLocal, DEMO_USERS, DEMO_PASSWORD, DEMO_COMMUNITY} from '../../packages/testing/seed.js';
import {createApp} from '../../apps/platform-api/src/app.js';
import {createAdminAccessVerifier} from '../../modules/platform-admin/access.js';

const origin = 'http://127.0.0.1:4310';
const databaseUrl = process.env.TEST_DATABASE_URL ?? LOCAL_DATABASE_URL;
const schema = `fp_guild_cat_${process.pid}_${Date.now()}`;
const database = createPool(databaseUrl);
const pool = new Pool({connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 12});
const issuer = 'https://category-test.cloudflareaccess.com';
const audience = 'guild-category-tests';
const email = 'category-admin@example.test';
const adminId = randomUUID();
const pair = await generateKeyPair('RS256');
const jwk = await exportJWK(pair.publicKey);
const verifier = createAdminAccessVerifier({
  issuer, audience, csrfSecret: 'category-test-csrf-secret-123456789',
  keySet: createLocalJWKSet({keys: [{...jwk, kid: 'category-test', alg: 'RS256'}]}),
});
const flagged = createApp(pool, origin, 'local', {guildLaunchpadEnabled: true, adminVerifier: verifier});
const flagOff = createApp(pool, origin, 'local', {adminVerifier: verifier});
const approved = [
  'guild_talent_direction', 'guild_member_operations', 'guild_platform_engineering', 'guild_opportunity_partnership',
  'guild_product_quality_supply', 'guild_media_automation', 'guild_commerce_settlement', 'guild_security',
  'guild_music_mv', 'guild_commercial_production', 'guild_projection_mapping', 'guild_human_design',
];
const internal = ['guild_talent_direction', 'guild_member_operations', 'guild_platform_engineering'];
const external = ['guild_opportunity_partnership'];
type Session = {cookie: string; csrf: string; user: {user_id: string}};
let jwt = '';
let csrf = '';

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
  await pool.query('TRUNCATE communities, login_attempts, auth_rate_limits CASCADE');
  await pool.query(`DELETE FROM positioning_guild_catalog WHERE guild_key LIKE 'guild_custom_%'`);
  await pool.query(`UPDATE guild_catalog_categories SET active = true, capability_tags = '{}',
    category = CASE guild_key
      WHEN 'guild_talent_direction' THEN 'internal'::guild_category
      WHEN 'guild_member_operations' THEN 'internal'::guild_category
      WHEN 'guild_platform_engineering' THEN 'internal'::guild_category
      WHEN 'guild_opportunity_partnership' THEN 'external'::guild_category
      WHEN 'guild_product_quality_supply' THEN 'professional_industry'::guild_category
      WHEN 'guild_media_automation' THEN 'professional_industry'::guild_category
      WHEN 'guild_commerce_settlement' THEN 'professional_industry'::guild_category
      WHEN 'guild_security' THEN 'professional_industry'::guild_category
      WHEN 'guild_music_mv' THEN 'professional_industry'::guild_category
      WHEN 'guild_commercial_production' THEN 'professional_industry'::guild_category
      WHEN 'guild_projection_mapping' THEN 'professional_industry'::guild_category
      WHEN 'guild_human_design' THEN 'professional_industry'::guild_category
      ELSE NULL END,
    category_review = CASE WHEN guild_key = ANY($1::text[]) THEN 'approved'::guild_category_review ELSE 'pending'::guild_category_review END`, [approved]);
  await seedLocal(pool);
  await pool.query('INSERT INTO platform_admins(admin_id, community_id, email, display_name) VALUES ($1,$2,$3,$4)', [adminId, DEMO_COMMUNITY, email, '分類管理員']);
  jwt = await sign(email);
  csrf = (await verifier(new Request(origin, {headers: {'Cf-Access-Jwt-Assertion': jwt}}))).csrfToken;
});

async function sign(value: string) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({type: 'app', email: value, sub: 'verified-category-admin', iss: issuer, aud: audience, iat: now, nbf: now, exp: now + 600}).setProtectedHeader({alg: 'RS256', kid: 'category-test'}).sign(pair.privateKey);
}
async function read(response: Response) {
  const text = await response.text();
  try { return text ? JSON.parse(text) : null; } catch { return text; }
}
async function member(app: ReturnType<typeof createApp>, path: string, s?: Session, body?: unknown, options: {version?: string; key?: string; preferenceVersion?: string} = {}) {
  const headers: Record<string, string> = {Origin: origin, ...s ? {Cookie: s.cookie, 'X-CSRF-Token': s.csrf} : {}};
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    headers['Idempotency-Key'] = options.key ?? randomUUID();
    if (options.version) headers['If-Match'] = `"${options.version}"`;
    if (options.preferenceVersion) headers['X-Preference-Version'] = options.preferenceVersion;
  }
  const response = await app.request(origin + '/api/v1' + path, {method: body === undefined ? 'GET' : 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body)});
  return {status: response.status, data: await read(response), response};
}
async function admin(app: ReturnType<typeof createApp>, path: string, body?: unknown, options: {version?: string; key?: string} = {}) {
  const headers: Record<string, string> = {Origin: origin, 'Cf-Access-Jwt-Assertion': jwt, 'X-Admin-CSRF': csrf};
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    headers['Idempotency-Key'] = options.key ?? randomUUID();
    if (options.version) headers['If-Match'] = `"${options.version}"`;
  }
  const response = await app.request(origin + '/admin/api' + path, {method: body === undefined ? 'GET' : 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body)});
  return {status: response.status, data: await read(response), response};
}
async function login(index = 0) {
  const result = await member(flagged, '/auth/login', undefined, {email: DEMO_USERS[index].email, password: DEMO_PASSWORD});
  assert.equal(result.status, 200, JSON.stringify(result.data));
  return {cookie: result.response.headers.get('set-cookie')!.split(';')[0], csrf: result.data.csrf_token, user: result.data.user} as Session;
}
async function join(s: Session, key: string) {
  const result = await member(flagged, `/guilds/${key}/join`, s, {});
  assert.equal(result.status, 200, JSON.stringify(result.data));
  return result.data as {aggregate_version: number};
}
async function revision(key: string) {
  return (await pool.query(`SELECT catalog_revision::text AS catalog_revision FROM guild_catalog_categories WHERE guild_key=$1`, [key])).rows[0]?.catalog_revision as string;
}
async function counts() {
  const tables = ['guild_category_preferences', 'guild_preference_sets', 'guild_preference_migration_audit', 'guild_preference_invalidations', 'positioning_profession_memberships', 'member_skill_book_grants'];
  const out: Record<string, string> = {};
  for (const table of tables) out[table] = (await pool.query(`SELECT count(*) FROM ${table}`)).rows[0].count;
  return out;
}
function slot(view: {primaries: {category: string; guild_key: string | null}[]}, category: string) {
  return view.primaries.find(item => item.category === category)?.guild_key ?? null;
}

test('T-001 catalog shape, empty slots, rejected writes, and flag-off 404', async () => {
  const catalog = await member(flagged, '/guild-categories');
  assert.equal(catalog.status, 200);
  const items = [...catalog.data.categories.flatMap((group: {items: {guild_key: string; category: string}[]}) => group.items), ...catalog.data.pending];
  assert.equal(items.length, 18);
  assert.deepEqual(catalog.data.categories.map((group: {category: string}) => group.category), ['internal', 'external', 'professional_industry']);
  assert.deepEqual(catalog.data.categories[0].items.map((item: {guild_key: string}) => item.guild_key).sort(), [...internal].sort());
  assert.deepEqual(catalog.data.categories[1].items.map((item: {guild_key: string}) => item.guild_key), external);
  assert.equal(catalog.data.pending.length, 6);
  assert.ok(catalog.data.pending.some((item: {guild_key: string}) => item.guild_key === 'guild_ai_vibe'));
  assert.match(catalog.data.catalog_revision, /^[1-9][0-9]*$/);

  const s = await login();
  await join(s, 'guild_talent_direction');
  await join(s, 'guild_member_operations');
  await join(s, 'guild_ai_vibe');
  const switched = await admin(flagged, '/guild-preferences/switch', {accept_blocked: true});
  assert.equal(switched.status, 200, JSON.stringify(switched.data));
  assert.equal(typeof switched.data.aggregate_version, 'number');
  const before = await counts();
  const view = await member(flagged, '/me/guild-preferences/v2', s);
  assert.equal(view.status, 200, JSON.stringify(view.data));
  assert.equal(view.response.headers.get('cache-control'), 'private, no-store');
  assert.equal(typeof view.data.aggregate_version, 'number');
  assert.deepEqual(view.data.primaries.map((item: {guild_key: string | null}) => item.guild_key), [null, null, null]);
  assert.deepEqual(await counts(), before);
  const version = String(view.data.aggregate_version);

  const illegal = await member(flagged, '/me/guild-preferences/v2/set', s, {category: 'nope', guild_key: null, catalog_revision: catalog.data.catalog_revision}, {version});
  assert.equal(illegal.status, 422);
  assert.equal(illegal.data.code, 'validation_failed');
  const extra = await member(flagged, '/me/guild-preferences/v2/set', s, {category: 'internal', guild_key: null, catalog_revision: catalog.data.catalog_revision, user_id: s.user.user_id}, {version});
  assert.equal(extra.status, 422);
  await assert.rejects(pool.query(`UPDATE guild_catalog_categories SET category = NULL WHERE guild_key = 'guild_talent_direction'`), (error: {code?: string}) => error.code === '23514');
  await assert.rejects(pool.query(`UPDATE guild_catalog_categories SET capability_tags = ARRAY['<tag>'] WHERE guild_key = 'guild_talent_direction'`), (error: {code?: string}) => error.code === '23514');
  await assert.rejects(pool.query(`INSERT INTO guild_category_preferences(community_id, user_id, category, guild_key) VALUES ($1,$2,'external','guild_talent_direction')`, [DEMO_COMMUNITY, s.user.user_id]), (error: {code?: string; message?: string}) => error.code === '23514' && String(error.message).includes('guild_category_preference_rejected'));
  await pool.query(`UPDATE positioning_profession_memberships SET state = 'left' WHERE user_id = $1 AND guild_key = 'guild_talent_direction'`, [s.user.user_id]);
  await assert.rejects(pool.query(`INSERT INTO guild_category_preferences(community_id, user_id, category, guild_key) VALUES ($1,$2,'internal','guild_talent_direction')`, [DEMO_COMMUNITY, s.user.user_id]), (error: {code?: string; message?: string}) => error.code === '23514' && String(error.message).includes('guild_category_preference_rejected'));
  await pool.query(`UPDATE positioning_profession_memberships SET state = 'active' WHERE user_id = $1 AND guild_key = 'guild_talent_direction'`, [s.user.user_id]);

  const pending = await member(flagged, '/me/guild-preferences/v2/set', s, {category: 'internal', guild_key: 'guild_ai_vibe', catalog_revision: await revision('guild_ai_vibe')}, {version});
  assert.equal(pending.status, 409);
  assert.equal(pending.data.code, 'guild_category_unresolved');
  const mismatch = await member(flagged, '/me/guild-preferences/v2/set', s, {category: 'external', guild_key: 'guild_talent_direction', catalog_revision: await revision('guild_talent_direction')}, {version});
  assert.equal(mismatch.status, 409);
  assert.equal(mismatch.data.code, 'guild_category_unresolved');

  for (const path of ['/guild-categories', '/me/guild-preferences/v2']) {
    const hidden = await member(flagOff, path, s);
    assert.equal(hidden.status, 404, path);
    assert.equal(hidden.data.code, 'not_found');
    assert.equal(hidden.data.detail, '此版本尚未提供這個 API。');
  }
  const hiddenWrite = await member(flagOff, '/me/guild-preferences/v2/set', s, {category: 'internal', guild_key: null, catalog_revision: '1'}, {version: '1'});
  assert.equal(hiddenWrite.status, 404);
  assert.equal(hiddenWrite.data.detail, '此版本尚未提供這個 API。');
  const hiddenLeave = await member(flagOff, '/guilds/guild_talent_direction/leave-v2', s, {clear_primary: false}, {version: '1'});
  assert.equal(hiddenLeave.status, 404);
  const hiddenAdmin = await admin(flagOff, '/guild-categories');
  assert.equal(hiddenAdmin.status, 404);
  assert.equal(hiddenAdmin.data.detail, '找不到這個管理 API。');
  const missingVersion = await admin(flagged, '/guilds/guild_talent_direction/classification', {category: 'internal', capability_tags: [], reason: '缺少版本'});
  assert.equal(missingVersion.status, 428);
  assert.equal(missingVersion.data.code, 'version_required');

  const key = randomUUID();
  const saved = await member(flagged, '/me/guild-preferences/v2/set', s, {category: 'internal', guild_key: 'guild_member_operations', catalog_revision: await revision('guild_member_operations')}, {version, key});
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.equal(slot(saved.data, 'internal'), 'guild_member_operations');
  await pool.query('UPDATE sessions SET revoked_at = clock_timestamp() WHERE user_id = $1', [s.user.user_id]);
  const replay = await member(flagged, '/me/guild-preferences/v2/set', s, {category: 'internal', guild_key: 'guild_member_operations', catalog_revision: await revision('guild_member_operations')}, {version, key});
  assert.equal(replay.status, 401);
  assert.equal(replay.data.code, 'session_expired');
  assert.equal(replay.data.primaries, undefined);
  assert.equal((await pool.query(`SELECT guild_key FROM guild_category_preferences WHERE user_id = $1`, [s.user.user_id])).rows[0].guild_key, 'guild_member_operations');

  const created = await member(flagged, '/guild-applications', await login(1), {name: '分類測試公會', profession: '分類', reason: '想用一個尚未歸類的公會確認待審種子。'});
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const approvedGuild = await admin(flagged, `/guild-applications/${created.data.application_id}/review`, {
    decision: 'approve', reason: '核准一個待分類公會',
    guild: {name: '分類測試公會', purpose: '驗證新公會先進入待分類。', first_step: '先核對分類再開放主力。', module_key: 'guilds', skill_book_ids: ['career-guide']},
  }, {version: String(created.data.aggregate_version)});
  assert.equal(approvedGuild.status, 200, JSON.stringify(approvedGuild.data));
  const customKey = 'guild_custom_' + created.data.application_id.replaceAll('-', '');
  const custom = (await pool.query(`SELECT category::text AS category, category_review::text AS category_review FROM guild_catalog_categories WHERE guild_key = $1`, [customKey])).rows[0];
  assert.equal(custom.category, null);
  assert.equal(custom.category_review, 'pending');
});

test('T-002 one category accepts one concurrent primary and empty slots still allow join and leave', async () => {
  const s = await login();
  await join(s, 'guild_talent_direction');
  await join(s, 'guild_member_operations');
  await join(s, 'guild_security');
  assert.equal((await member(flagged, '/guilds/guild_talent_direction/primary', s, {})).status, 200);
  assert.equal((await admin(flagged, '/guild-preferences/switch', {accept_blocked: true})).status, 200);
  const view = await member(flagged, '/me/guild-preferences/v2', s);
  assert.equal(view.status, 200, JSON.stringify(view.data));
  const version = String(view.data.aggregate_version);
  const [first, second] = await Promise.all([
    member(flagged, '/me/guild-preferences/v2/set', s, {category: 'internal', guild_key: 'guild_talent_direction', catalog_revision: await revision('guild_talent_direction')}, {version}),
    member(flagged, '/me/guild-preferences/v2/set', s, {category: 'internal', guild_key: 'guild_member_operations', catalog_revision: await revision('guild_member_operations')}, {version}),
  ]);
  assert.deepEqual([first.status, second.status].sort(), [200, 412]);
  const current = await member(flagged, '/me/guild-preferences/v2', s);
  assert.equal(current.data.primaries.filter((item: {guild_key: string | null}) => item.guild_key).length, 1);
  const top = (await member(flagged, '/guild-categories')).data.catalog_revision as string;
  const cleared = await member(flagged, '/me/guild-preferences/v2/set', s, {category: 'external', guild_key: null, catalog_revision: top}, {version: String(current.data.aggregate_version)});
  assert.equal(cleared.status, 200, JSON.stringify(cleared.data));
  assert.equal(slot(cleared.data, 'external'), null);
  const membership = (await member(flagged, '/guilds/directory', s)).data.items.find((item: {guild_key: string}) => item.guild_key === 'guild_security').membership;
  const left = await member(flagged, '/guilds/guild_security/leave-v2', s, {clear_primary: false}, {version: String(membership.aggregate_version)});
  assert.equal(left.status, 200, JSON.stringify(left.data));
  const rejoined = await member(flagged, '/guilds/guild_security/join', s, {}, {version: String(left.data.membership.aggregate_version)});
  assert.equal(rejoined.status, 200, JSON.stringify(rejoined.data));
  assert.equal((await pool.query(`SELECT state FROM positioning_profession_memberships WHERE user_id = $1 AND guild_key = 'guild_security'`, [s.user.user_id])).rows[0].state, 'active');
});

test('T-010 backfill maps only the legacy primary and reruns without duplicating rows', async () => {
  const community = DEMO_COMMUNITY;
  const maker = DEMO_USERS[0].user_id;
  const ids = {
    mapped: 'a0000000-0000-4000-8000-000000000011',
    ordered: 'a0000000-0000-4000-8000-000000000012',
    empty: 'a0000000-0000-4000-8000-000000000013',
    pending: 'a0000000-0000-4000-8000-000000000014',
    left: 'a0000000-0000-4000-8000-000000000015',
    invalid: 'a0000000-0000-4000-8000-000000000016',
    bare: 'a0000000-0000-4000-8000-000000000017',
    inactive: 'a0000000-0000-4000-8000-000000000018',
  };
  async function user(id: string, name: string) {
    await pool.query(`INSERT INTO users(user_id, community_id, email, display_name, password_hash, profession_membership_ref)
      SELECT $1,$2,$3,$4,password_hash,$5 FROM users WHERE user_id = $6`, [id, community, `${id}@example.test`, name, randomUUID(), maker]);
  }
  async function membership(id: string, key: string, state = 'active', tier = 'intern') {
    await pool.query(`INSERT INTO positioning_profession_memberships(membership_id, community_id, user_id, guild_key, state, member_tier) VALUES ($1,$2,$3,$4,$5,$6)`, [randomUUID(), community, id, key, state, tier]);
  }
  async function preference(id: string, primary: string, secondary: string[] | null) {
    await pool.query(`INSERT INTO guild_member_preferences(community_id, user_id, primary_guild_key, secondary_guild_keys) VALUES ($1,$2,$3,$4)`, [community, id, primary, secondary]);
  }
  await user(ids.mapped, '可對照');
  await membership(ids.mapped, 'guild_talent_direction', 'active', 'full');
  await membership(ids.mapped, 'guild_opportunity_partnership');
  await membership(ids.mapped, 'guild_security');
  await preference(ids.mapped, 'guild_talent_direction', null);
  await pool.query(`INSERT INTO member_skill_book_grants(grant_id, community_id, user_id, guild_key, book_id) VALUES ($1,$2,$3,'guild_talent_direction','career-guide')`, [randomUUID(), community, ids.mapped]);
  await user(ids.ordered, '兩個次要');
  await membership(ids.ordered, 'guild_member_operations');
  await membership(ids.ordered, 'guild_security');
  await membership(ids.ordered, 'guild_music_mv');
  await preference(ids.ordered, 'guild_member_operations', ['guild_music_mv', 'guild_security']);
  await user(ids.empty, '空白次要');
  await membership(ids.empty, 'guild_platform_engineering');
  await membership(ids.empty, 'guild_security');
  await preference(ids.empty, 'guild_platform_engineering', []);
  await user(ids.pending, '待分類主力');
  await membership(ids.pending, 'guild_ai_vibe');
  await preference(ids.pending, 'guild_ai_vibe', null);
  await user(ids.left, '已離開主力');
  await membership(ids.left, 'guild_talent_direction', 'left', 'full');
  await preference(ids.left, 'guild_talent_direction', null);
  await user(ids.invalid, '無效次要');
  await membership(ids.invalid, 'guild_talent_direction');
  await preference(ids.invalid, 'guild_talent_direction', ['guild_security']);
  await user(ids.bare, '只有會籍');
  await membership(ids.bare, 'guild_security');
  await user(ids.inactive, '停用分類');
  await membership(ids.inactive, 'guild_human_design');
  await preference(ids.inactive, 'guild_human_design', []);
  await pool.query(`UPDATE guild_catalog_categories SET active = false WHERE guild_key = 'guild_human_design'`);
  const beforeUsers = (await pool.query(`SELECT user_id, email, display_name FROM users ORDER BY user_id`)).rows;
  const beforeMemberships = (await pool.query(`SELECT user_id, guild_key, state, member_tier FROM positioning_profession_memberships ORDER BY user_id, guild_key`)).rows;
  const beforeGrants = (await pool.query(`SELECT user_id, guild_key, book_id FROM member_skill_book_grants ORDER BY user_id, book_id`)).rows;

  const dry = await admin(flagged, '/guild-preferences/backfill', {dry_run: true});
  assert.equal(dry.status, 200, JSON.stringify(dry.data));
  assert.equal(dry.data.dry_run, true);
  assert.equal(dry.data.processed, 8);
  assert.equal(dry.data.mapped, 3);
  assert.equal(dry.data.blocked, 4);
  assert.equal(dry.data.ambiguous, 4);
  assert.equal(dry.data.remaining, 8);
  const blockedByUser = new Map(dry.data.blocked_members.map((item: {user_id: string; reason: string}) => [item.user_id, item.reason]));
  assert.equal(blockedByUser.get(ids.pending), 'unknown_category');
  assert.equal(blockedByUser.get(ids.left), 'left_primary');
  assert.equal(blockedByUser.get(ids.invalid), 'invalid_secondary');
  assert.equal(blockedByUser.get(ids.inactive), 'inactive_guild');
  assert.equal((await pool.query(`SELECT count(*) FROM guild_preference_sets`)).rows[0].count, '0');
  const limited = await admin(flagged, '/guild-preferences/backfill', {dry_run: true, limit: 1});
  assert.equal(limited.data.processed, 1);
  assert.equal(limited.data.remaining, 8);

  const first = await admin(flagged, '/guild-preferences/backfill', {dry_run: false, limit: 1});
  assert.equal(first.status, 200, JSON.stringify(first.data));
  assert.equal(first.data.processed, 1);
  assert.equal(first.data.remaining, 7);
  let guard = 0;
  let last = first.data;
  while (last.remaining > 0 && guard < 10) {
    last = (await admin(flagged, '/guild-preferences/backfill', {dry_run: false, limit: 1})).data;
    guard += 1;
  }
  assert.equal(last.remaining, 0);
  const again = await admin(flagged, '/guild-preferences/backfill', {dry_run: false});
  assert.equal(again.data.processed, 0);
  const audit = (await pool.query(`SELECT count(*) FROM guild_preference_migration_audit`)).rows[0].count;
  assert.equal((await admin(flagged, '/guild-preferences/backfill', {dry_run: false})).data.processed, 0);
  assert.equal((await pool.query(`SELECT count(*) FROM guild_preference_migration_audit`)).rows[0].count, audit);
  async function only(id: string) {
    return (await pool.query(`SELECT guild_key FROM guild_category_preferences WHERE user_id = $1 ORDER BY guild_key`, [id])).rows.map(row => row.guild_key);
  }
  assert.deepEqual(await only(ids.mapped), ['guild_talent_direction']);
  assert.deepEqual(await only(ids.ordered), ['guild_member_operations']);
  assert.deepEqual(await only(ids.empty), ['guild_platform_engineering']);
  assert.deepEqual(await only(ids.pending), []);
  assert.deepEqual(await only(ids.left), []);
  assert.deepEqual(await only(ids.invalid), []);
  assert.deepEqual(await only(ids.bare), []);
  assert.deepEqual(await only(ids.inactive), []);
  const reasons = new Map((await pool.query(`SELECT user_id, invalidation_reason FROM guild_preference_migration_audit`)).rows.map(row => [row.user_id, row.invalidation_reason]));
  assert.equal(reasons.get(ids.mapped), null);
  assert.equal(reasons.get(ids.pending), 'legacy_ambiguous');
  assert.equal(reasons.get(ids.left), 'legacy_ambiguous');
  assert.equal(reasons.get(ids.invalid), 'legacy_ambiguous');
  assert.equal(reasons.get(ids.inactive), 'legacy_ambiguous');
  assert.equal(reasons.get(ids.bare), null);
  const blocked = new Map((again.data.blocked_members ?? []).map((item: {user_id: string; reason: string}) => [item.user_id, item.reason]));
  assert.equal(blocked.size, 0);
  const listed = (await admin(flagged, '/guild-preferences/backfill', {dry_run: true})).data;
  assert.equal(listed.processed, 0);
  assert.deepEqual(beforeUsers, (await pool.query(`SELECT user_id, email, display_name FROM users ORDER BY user_id`)).rows);
  assert.deepEqual(beforeMemberships, (await pool.query(`SELECT user_id, guild_key, state, member_tier FROM positioning_profession_memberships ORDER BY user_id, guild_key`)).rows);
  assert.deepEqual(beforeGrants, (await pool.query(`SELECT user_id, guild_key, book_id FROM member_skill_book_grants ORDER BY user_id, book_id`)).rows);

  await pool.query(`DELETE FROM guild_preference_sets WHERE user_id = $1`, [ids.mapped]);
  const resumed = await admin(flagged, '/guild-preferences/backfill', {dry_run: false});
  assert.equal(resumed.data.processed, 1);
  assert.deepEqual(await only(ids.mapped), ['guild_talent_direction']);
  assert.equal((await pool.query(`SELECT count(*) FROM guild_preference_migration_audit`)).rows[0].count, audit);

  const s = await login();
  await join(s, 'guild_opportunity_partnership');
  assert.equal((await member(flagged, '/guilds/guild_opportunity_partnership/primary', s, {})).status, 200);
  const during = await admin(flagged, '/guild-preferences/backfill', {dry_run: false});
  assert.equal(during.data.processed, 0);
  assert.equal((await pool.query(`SELECT count(*) FROM guild_preference_migration_audit WHERE user_id = $1`, [s.user.user_id])).rows[0].count, '1');
  assert.equal((await pool.query(`SELECT count(*) FROM outbox WHERE event_type = 'freedom.guild.preference.changed.v1'`)).rows[0].count, '0');
});

test('T-016 recategorize clears the slot, leave races do not keep a departed primary, and inactive has no deactivate command', async () => {
  const s = await login();
  const talent = await join(s, 'guild_talent_direction');
  const operations = await join(s, 'guild_member_operations');
  assert.equal((await member(flagged, '/guilds/guild_talent_direction/primary', s, {})).status, 200);
  assert.equal((await admin(flagged, '/guild-preferences/switch', {accept_blocked: true})).status, 200);
  const view = await member(flagged, '/me/guild-preferences/v2', s);
  const moved = await admin(flagged, '/guilds/guild_talent_direction/classification', {category: 'external', capability_tags: ['會員陪跑'], reason: '改測外交分類'}, {version: await revision('guild_talent_direction')});
  assert.equal(moved.status, 200, JSON.stringify(moved.data));
  assert.equal(moved.data.classification.category, 'external');
  assert.notEqual(moved.data.classification.catalog_revision, await revision('guild_member_operations'));
  const after = await member(flagged, '/me/guild-preferences/v2', s);
  assert.equal(slot(after.data, 'internal'), null);
  assert.equal(slot(after.data, 'external'), null);
  assert.equal(after.data.invalidated.find((item: {category: string}) => item.category === 'internal').reason, 'guild_recategorized');
  assert.equal((await pool.query(`SELECT state, member_tier FROM positioning_profession_memberships WHERE user_id = $1 AND guild_key = 'guild_talent_direction'`, [s.user.user_id])).rows[0].member_tier, 'intern');
  await admin(flagged, '/guilds/guild_talent_direction/classification', {category: 'internal', capability_tags: [], reason: '還原內政分類'}, {version: moved.data.classification.catalog_revision});

  const current = await member(flagged, '/me/guild-preferences/v2', s);
  const version = String(current.data.aggregate_version);
  const [selected, left] = await Promise.all([
    member(flagged, '/me/guild-preferences/v2/set', s, {category: 'internal', guild_key: 'guild_member_operations', catalog_revision: await revision('guild_member_operations')}, {version}),
    member(flagged, '/guilds/guild_talent_direction/leave-v2', s, {clear_primary: true}, {version: String(talent.aggregate_version), preferenceVersion: version}),
  ]);
  assert.ok([200, 412].includes(selected.status), JSON.stringify(selected.data));
  assert.equal(left.status, 200, JSON.stringify(left.data));
  const finalSlot = (await pool.query(`SELECT guild_key FROM guild_category_preferences WHERE user_id = $1 AND category = 'internal'`, [s.user.user_id])).rows[0]?.guild_key ?? null;
  const talentState = (await pool.query(`SELECT state FROM positioning_profession_memberships WHERE user_id = $1 AND guild_key = 'guild_talent_direction'`, [s.user.user_id])).rows[0].state;
  assert.equal(talentState, 'left');
  assert.notEqual(finalSlot, 'guild_talent_direction');
  assert.ok(finalSlot === null || finalSlot === 'guild_member_operations');
  assert.equal((await pool.query(`SELECT state FROM positioning_profession_memberships WHERE user_id = $1 AND guild_key = 'guild_member_operations'`, [s.user.user_id])).rows[0].state, 'active');
  assert.equal(operations.aggregate_version > 0, true);

  const kept = await member(flagged, '/me/guild-preferences/v2/set', s, {category: 'internal', guild_key: 'guild_member_operations', catalog_revision: await revision('guild_member_operations')}, {version: String((await member(flagged, '/me/guild-preferences/v2', s)).data.aggregate_version)});
  assert.equal(kept.status, 200, JSON.stringify(kept.data));
  await pool.query(`UPDATE guild_catalog_categories SET active = false WHERE guild_key = 'guild_member_operations'`);
  try {
    const inactive = await member(flagged, '/me/guild-preferences/v2/set', s, {category: 'internal', guild_key: 'guild_member_operations', catalog_revision: await revision('guild_member_operations')}, {version: String(kept.data.aggregate_version)});
    assert.equal(inactive.status, 409);
    assert.equal(inactive.data.code, 'guild_inactive');
    assert.equal((await pool.query(`SELECT guild_key FROM guild_category_preferences WHERE user_id = $1 AND category = 'internal'`, [s.user.user_id])).rows[0].guild_key, 'guild_member_operations');
  } finally {
    await pool.query(`UPDATE guild_catalog_categories SET active = true WHERE guild_key = 'guild_member_operations'`);
  }
  assert.equal(view.status, 200);
});

test('T-030 legacy reads stay understandable and legacy writes stop only after the switch', async () => {
  const s = await login();
  await join(s, 'guild_talent_direction');
  await join(s, 'guild_opportunity_partnership');
  await join(s, 'guild_security');
  const before = await member(flagged, '/me/guild-preferences', s);
  assert.equal(before.status, 200);
  assert.equal(before.data.compatibility, undefined);
  const primary = await member(flagged, '/guilds/guild_talent_direction/primary', s, {});
  assert.equal(primary.status, 200, JSON.stringify(primary.data));
  const early = await member(flagged, '/me/guild-preferences/v2/set', s, {category: 'internal', guild_key: 'guild_talent_direction', catalog_revision: await revision('guild_talent_direction')}, {version: String(primary.data.aggregate_version)});
  assert.equal(early.status, 409);
  assert.equal(early.data.code, 'preference_switch_pending');
  const legacyStill = await member(flagged, '/me/guild-preferences', s);
  assert.equal(legacyStill.data.primary_guild_key, 'guild_talent_direction');
  assert.equal(legacyStill.data.compatibility, undefined);

  assert.equal((await admin(flagged, '/guild-preferences/switch', {accept_blocked: false})).status, 200);
  const projected = await member(flagged, '/me/guild-preferences', s);
  assert.equal(projected.data.compatibility, 'legacy_projection');
  assert.equal(projected.data.primary_guild_key, 'guild_talent_direction');
  const blockedPrimary = await member(flagged, '/guilds/guild_opportunity_partnership/primary', s, {}, {version: String(projected.data.aggregate_version)});
  assert.equal(blockedPrimary.status, 409);
  assert.equal(blockedPrimary.data.code, 'client_upgrade_required');
  const blockedSecondary = await member(flagged, '/me/guild-preferences/secondary', s, {secondary_guild_keys: ['guild_security']}, {version: String(projected.data.aggregate_version)});
  assert.equal(blockedSecondary.status, 409);
  assert.equal(blockedSecondary.data.code, 'client_upgrade_required');
  const view = await member(flagged, '/me/guild-preferences/v2', s);
  assert.equal(view.status, 200, JSON.stringify(view.data));
  assert.deepEqual(view.data.primaries.map((item: {category: string}) => item.category), ['internal', 'external', 'professional_industry']);
  assert.equal(slot(view.data, 'internal'), 'guild_talent_direction');
  assert.equal(slot(view.data, 'external'), null);
  assert.equal(slot(view.data, 'professional_industry'), null);
  assert.equal((await pool.query(`SELECT primary_guild_key FROM guild_member_preferences WHERE user_id = $1`, [s.user.user_id])).rows[0].primary_guild_key, 'guild_talent_direction');
});

test('T-054 dry-run writes nothing and a second execute is the crash-resume path', async () => {
  const s = await login();
  await join(s, 'guild_security');
  assert.equal((await member(flagged, '/guilds/guild_security/primary', s, {})).status, 200);
  const dry = await admin(flagged, '/guild-preferences/backfill', {});
  assert.equal(dry.status, 200, JSON.stringify(dry.data));
  assert.equal(dry.data.dry_run, true);
  assert.equal((await pool.query(`SELECT count(*) FROM guild_preference_sets WHERE user_id = $1`, [s.user.user_id])).rows[0].count, '1');
  const version = (await pool.query(`SELECT aggregate_version FROM guild_preference_sets WHERE user_id = $1`, [s.user.user_id])).rows[0].aggregate_version;
  const run = await admin(flagged, '/guild-preferences/backfill', {dry_run: false});
  assert.equal(run.data.processed, 0);
  assert.equal((await pool.query(`SELECT aggregate_version FROM guild_preference_sets WHERE user_id = $1`, [s.user.user_id])).rows[0].aggregate_version, version);
  const blocked = await admin(flagged, '/guild-preferences/switch', {accept_blocked: false});
  assert.equal(blocked.status, 200, JSON.stringify(blocked.data));
  const repeat = await admin(flagged, '/guild-preferences/switch', {accept_blocked: false});
  assert.equal(repeat.status, 200, JSON.stringify(repeat.data));
  assert.equal(repeat.data.already_switched, true);
  assert.equal(repeat.data.aggregate_version, blocked.data.aggregate_version);
});
