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
import {backfillGuildPreferences, lockGuildCatalog, lockGuildCatalogShared} from '../../modules/positioning/guild-categories.js';
import {lockMemberGuilds} from '../../modules/positioning/onboarding.js';

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
  await pool.query(`INSERT INTO users(user_id, community_id, email, display_name, password_hash, profession_membership_ref)
    SELECT $1,$2,$3,$4,password_hash,$5 FROM users WHERE user_id = $6`, ['a0000000-0000-4000-8000-0000000000aa', DEMO_COMMUNITY, email, '分類管理員', randomUUID(), DEMO_USERS[0].user_id]);
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
  const rest = await admin(flagged, '/guild-preferences/backfill', {dry_run: false});
  assert.equal(rest.status, 200, JSON.stringify(rest.data));
  assert.equal(rest.data.processed, 3);
  assert.equal(rest.data.blocked, 4);
  assert.equal(rest.data.remaining, 4);
  const again = await admin(flagged, '/guild-preferences/backfill', {dry_run: false});
  assert.equal(again.data.processed, 0);
  assert.equal(again.data.remaining, 4);
  const audit = (await pool.query(`SELECT count(*) FROM guild_preference_migration_audit`)).rows[0].count;
  assert.equal(audit, '4');
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
  assert.equal(reasons.get(ids.ordered), null);
  assert.equal(reasons.get(ids.empty), null);
  assert.equal(reasons.get(ids.bare), null);
  assert.equal(reasons.has(ids.pending), false);
  assert.equal(reasons.has(ids.left), false);
  assert.equal(reasons.has(ids.invalid), false);
  assert.equal(reasons.has(ids.inactive), false);
  async function secondary(id: string) {
    return (await pool.query(`SELECT legacy_secondary IS NULL AS is_null, legacy_secondary::text AS raw FROM guild_preference_migration_audit WHERE user_id = $1`, [id])).rows[0] as {is_null: boolean; raw: string | null};
  }
  assert.equal((await secondary(ids.mapped)).is_null, true);
  assert.equal((await secondary(ids.empty)).raw, '[]');
  assert.deepEqual(JSON.parse((await secondary(ids.ordered)).raw!), ['guild_music_mv', 'guild_security']);
  for (const id of [ids.pending, ids.left, ids.invalid, ids.inactive]) {
    assert.equal((await pool.query(`SELECT count(*) FROM guild_preference_sets WHERE user_id = $1`, [id])).rows[0].count, '0');
    assert.equal((await pool.query(`SELECT count(*) FROM guild_preference_invalidations WHERE user_id = $1`, [id])).rows[0].count, '0');
  }
  const denied = await admin(flagged, '/guild-preferences/switch', {accept_blocked: false});
  assert.equal(denied.status, 409);
  assert.equal(denied.data.code, 'preference_switch_blocked');
  assert.equal((await pool.query(`SELECT count(*) FROM guild_preference_switch`)).rows[0].count, '0');
  assert.equal((await pool.query(`SELECT count(*) FROM guild_preference_migration_audit`)).rows[0].count, audit);
  const blocked = new Map((again.data.blocked_members ?? []).map((item: {user_id: string; reason: string}) => [item.user_id, item.reason]));
  assert.equal(blocked.get(ids.pending), 'unknown_category');
  assert.equal(blocked.get(ids.left), 'left_primary');
  assert.equal(blocked.get(ids.invalid), 'invalid_secondary');
  assert.equal(blocked.get(ids.inactive), 'inactive_guild');
  const listed = (await admin(flagged, '/guild-preferences/backfill', {dry_run: true})).data;
  assert.equal(listed.blocked, 4);
  assert.equal(listed.remaining, 4);
  assert.equal(listed.processed, 4);
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
  await join(s, 'guild_security');
  await pool.query(`UPDATE guild_catalog_categories SET active = false WHERE guild_key = 'guild_security'`);
  try {
    const inactive = await member(flagged, '/me/guild-preferences/v2/set', s, {category: 'professional_industry', guild_key: 'guild_security', catalog_revision: await revision('guild_security')}, {version: String((await member(flagged, '/me/guild-preferences/v2', s)).data.aggregate_version)});
    assert.equal(inactive.status, 409);
    assert.equal(inactive.data.code, 'guild_inactive');
    assert.equal((await pool.query(`SELECT guild_key FROM guild_category_preferences WHERE user_id = $1 AND category = 'professional_industry'`, [s.user.user_id])).rows[0], undefined);
    assert.equal((await pool.query(`SELECT guild_key FROM guild_category_preferences WHERE user_id = $1 AND category = 'internal'`, [s.user.user_id])).rows[0].guild_key, 'guild_member_operations');
  } finally {
    await pool.query(`UPDATE guild_catalog_categories SET active = true WHERE guild_key = 'guild_security'`);
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
  const directory = await member(flagged, '/guilds/directory', s);
  const talentMembership = directory.data.items.find((item: {guild_key: string}) => item.guild_key === 'guild_talent_direction').membership;
  const legacyLeave = await member(flagged, '/guilds/guild_talent_direction/leave', s, {}, {version: String(talentMembership.aggregate_version)});
  assert.equal(legacyLeave.status, 409);
  assert.equal(legacyLeave.data.code, 'primary_clear_required');
  assert.equal((await pool.query(`SELECT state FROM positioning_profession_memberships WHERE user_id = $1 AND guild_key = 'guild_talent_direction'`, [s.user.user_id])).rows[0].state, 'active');
  assert.equal((await pool.query(`SELECT guild_key FROM guild_category_preferences WHERE user_id = $1 AND category = 'internal'`, [s.user.user_id])).rows[0].guild_key, 'guild_talent_direction');
});

test('T-054 an interrupted backfill resumes without a second audit row', async () => {
  const community = DEMO_COMMUNITY;
  const maker = DEMO_USERS[0].user_id;
  const ids = ['a0000000-0000-4000-8000-000000000031', 'a0000000-0000-4000-8000-000000000032', 'a0000000-0000-4000-8000-000000000033'];
  const guilds = ['guild_talent_direction', 'guild_member_operations', 'guild_platform_engineering'];
  for (const [index, id] of ids.entries()) {
    await pool.query(`INSERT INTO users(user_id, community_id, email, display_name, password_hash, profession_membership_ref)
      SELECT $1,$2,$3,$4,password_hash,$5 FROM users WHERE user_id = $6`, [id, community, `${id}@example.test`, `批次${index}`, randomUUID(), maker]);
    await pool.query(`INSERT INTO positioning_profession_memberships(membership_id, community_id, user_id, guild_key, state, member_tier) VALUES ($1,$2,$3,$4,'active','intern')`, [randomUUID(), community, id, guilds[index]]);
    await pool.query(`INSERT INTO guild_member_preferences(community_id, user_id, primary_guild_key, secondary_guild_keys) VALUES ($1,$2,$3,$4)`, [community, id, guilds[index], null]);
  }
  async function snapshot() {
    const sets = (await pool.query(`SELECT user_id, aggregate_version::text AS aggregate_version, migration_state FROM guild_preference_sets WHERE user_id = ANY($1::uuid[]) ORDER BY user_id`, [ids])).rows;
    const slots = (await pool.query(`SELECT user_id, category::text AS category, guild_key FROM guild_category_preferences WHERE user_id = ANY($1::uuid[]) ORDER BY user_id, category`, [ids])).rows;
    const audits = (await pool.query(`SELECT user_id, legacy_primary, legacy_secondary IS NULL AS legacy_secondary_null, new_snapshot, invalidation_reason FROM guild_preference_migration_audit WHERE user_id = ANY($1::uuid[]) ORDER BY user_id, legacy_primary`, [ids])).rows;
    return {sets, slots, audits};
  }
  const dry = await admin(flagged, '/guild-preferences/backfill', {});
  assert.equal(dry.status, 200, JSON.stringify(dry.data));
  assert.equal(dry.data.dry_run, true);
  assert.equal((await pool.query(`SELECT count(*) FROM guild_preference_sets WHERE user_id = ANY($1::uuid[])`, [ids])).rows[0].count, '0');
  const partial = await admin(flagged, '/guild-preferences/backfill', {dry_run: false, limit: 1});
  assert.equal(partial.data.processed, 1);
  assert.equal((await pool.query(`SELECT count(*) FROM guild_preference_migration_audit WHERE user_id = ANY($1::uuid[])`, [ids])).rows[0].count, '1');
  const continued = await admin(flagged, '/guild-preferences/backfill', {dry_run: false, limit: 1});
  assert.equal(continued.data.processed, 1);
  const finished = await admin(flagged, '/guild-preferences/backfill', {dry_run: false});
  assert.equal(finished.data.processed, 1);
  assert.equal(finished.data.remaining, 0);
  const interrupted = await snapshot();
  assert.equal(interrupted.audits.length, 3);
  assert.equal(new Set(interrupted.audits.map(row => row.user_id)).size, 3);
  await pool.query(`DELETE FROM guild_preference_sets WHERE user_id = ANY($1::uuid[])`, [ids]);
  await pool.query(`DELETE FROM guild_preference_migration_audit WHERE user_id = ANY($1::uuid[])`, [ids]);
  const once = await admin(flagged, '/guild-preferences/backfill', {dry_run: false});
  assert.equal(once.data.processed, 3);
  assert.deepEqual(await snapshot(), interrupted);
  const repeat = await admin(flagged, '/guild-preferences/backfill', {dry_run: false});
  assert.equal(repeat.data.processed, 0);
  assert.equal((await pool.query(`SELECT count(*) FROM guild_preference_migration_audit WHERE user_id = ANY($1::uuid[])`, [ids])).rows[0].count, '3');
});

test('T-010 dry-run counts a blocked member past the first page and only an accepted switch stores it', async () => {
  const community = DEMO_COMMUNITY;
  const maker = DEMO_USERS[0].user_id;
  const blockedId = 'b0000000-0000-4000-8000-000000000101';
  for (let index = 1; index <= 101; index += 1) {
    const id = `b0000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
    const blocked = index === 101;
    await pool.query(`INSERT INTO users(user_id, community_id, email, display_name, password_hash, profession_membership_ref)
      SELECT $1,$2,$3,$4,password_hash,$5 FROM users WHERE user_id = $6`, [id, community, `${id}@example.test`, `候選${index}`, randomUUID(), maker]);
    await pool.query(`INSERT INTO positioning_profession_memberships(membership_id, community_id, user_id, guild_key, state, member_tier) VALUES ($1,$2,$3,$4,'active','intern')`, [randomUUID(), community, id, blocked ? 'guild_ai_vibe' : 'guild_talent_direction']);
    await pool.query(`INSERT INTO guild_member_preferences(community_id, user_id, primary_guild_key, secondary_guild_keys) VALUES ($1,$2,$3,NULL)`, [community, id, blocked ? 'guild_ai_vibe' : 'guild_talent_direction']);
  }
  const preview = await admin(flagged, '/guild-preferences/backfill', {dry_run: true});
  assert.equal(preview.status, 200, JSON.stringify(preview.data));
  assert.equal(preview.data.processed, 100);
  assert.equal(preview.data.remaining, 101);
  assert.equal(preview.data.blocked, 1);
  assert.equal(preview.data.blocked_members.length, 1);
  assert.equal(preview.data.blocked_members[0].user_id, blockedId);
  assert.equal(preview.data.blocked_members[0].reason, 'unknown_category');
  const refused = await admin(flagged, '/guild-preferences/switch', {accept_blocked: false});
  assert.equal(refused.status, 409);
  assert.equal(refused.data.code, 'preference_switch_blocked');
  assert.equal((await pool.query(`SELECT count(*) FROM guild_preference_sets WHERE user_id = $1`, [blockedId])).rows[0].count, '0');
  assert.equal((await pool.query(`SELECT count(*) FROM guild_preference_invalidations WHERE reason = 'legacy_ambiguous'`)).rows[0].count, '0');
  assert.equal((await pool.query(`SELECT count(*) FROM guild_preference_switch`)).rows[0].count, '0');
  const accepted = await admin(flagged, '/guild-preferences/switch', {accept_blocked: true});
  assert.equal(accepted.status, 200, JSON.stringify(accepted.data));
  assert.equal(accepted.data.state, 'switched');
  assert.equal(accepted.data.blocked, 1);
  const ambiguous = (await pool.query(`SELECT user_id FROM guild_preference_invalidations WHERE reason = 'legacy_ambiguous'`)).rows;
  assert.deepEqual(ambiguous.map(row => row.user_id), [blockedId]);
  const versions = (await pool.query(`SELECT s.aggregate_version::text AS aggregate_version, i.new_version::text AS new_version
    FROM guild_preference_sets s JOIN guild_preference_invalidations i USING (community_id, user_id)
    WHERE s.user_id = $1 AND i.reason = 'legacy_ambiguous'`, [blockedId])).rows[0];
  assert.equal(versions.new_version, versions.aggregate_version);
  assert.equal((await pool.query(`SELECT count(*) FROM guild_category_preferences WHERE user_id = $1`, [blockedId])).rows[0].count, '0');
  assert.equal((await pool.query(`SELECT count(*) FROM guild_category_preferences WHERE guild_key = 'guild_talent_direction'`)).rows[0].count, '100');
});

test('T-001 classification journals one public event and refuses without an active member', async () => {
  async function facts() {
    return {
      revision: await revision('guild_security'),
      audit: (await pool.query(`SELECT count(*) FROM platform_admin_audit`)).rows[0].count as string,
      outbox: (await pool.query(`SELECT count(*) FROM outbox WHERE event_type = 'freedom.guild.classification.changed.v1'`)).rows[0].count as string,
      journal: (await pool.query(`SELECT count(*) FROM transition_journal WHERE command = 'classify_guild'`)).rows[0].count as string,
    };
  }
  async function classifyAs(value: string, version: string) {
    const token = await sign(value);
    const tokenCsrf = (await verifier(new Request(origin, {headers: {'Cf-Access-Jwt-Assertion': token}}))).csrfToken;
    const response = await flagged.request(origin + '/admin/api/guilds/guild_security/classification', {
      method: 'POST',
      headers: {Origin: origin, 'Cf-Access-Jwt-Assertion': token, 'X-Admin-CSRF': tokenCsrf, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID(), 'If-Match': `"${version}"`},
      body: JSON.stringify({category: 'external', capability_tags: [], reason: '沒有可用的會員帳號'}),
    });
    return {status: response.status, data: await read(response)};
  }
  const before = await facts();
  await pool.query('INSERT INTO platform_admins(admin_id, community_id, email, display_name) VALUES ($1,$2,$3,$4)', [randomUUID(), DEMO_COMMUNITY, 'category-orphan@example.test', '無會員管理員']);
  const missing = await classifyAs('category-orphan@example.test', before.revision);
  assert.equal(missing.status, 403);
  assert.equal(missing.data.code, 'guild_classification_denied');
  assert.equal(missing.data.detail, '分類需要以同社群的會員帳號留下事件紀錄，請先確認管理員信箱有對應的會員帳號。');
  assert.deepEqual(await facts(), before);
  await pool.query(`INSERT INTO users(user_id, community_id, email, display_name, password_hash, profession_membership_ref, active)
    SELECT $1,$2,$3,$4,password_hash,$5,false FROM users WHERE user_id = $6`, [randomUUID(), DEMO_COMMUNITY, 'category-inactive@example.test', '停用會員', randomUUID(), DEMO_USERS[0].user_id]);
  await pool.query('INSERT INTO platform_admins(admin_id, community_id, email, display_name) VALUES ($1,$2,$3,$4)', [randomUUID(), DEMO_COMMUNITY, 'category-inactive@example.test', '停用管理員']);
  const inactive = await classifyAs('category-inactive@example.test', before.revision);
  assert.equal(inactive.status, 403);
  assert.equal(inactive.data.code, 'guild_classification_denied');
  assert.deepEqual(await facts(), before);
  const saved = await admin(flagged, '/guilds/guild_security/classification', {category: 'external', capability_tags: ['守門'], reason: '改測公開事件'}, {version: await revision('guild_security')});
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  const events = (await pool.query(`SELECT payload FROM outbox WHERE event_type = 'freedom.guild.classification.changed.v1'`)).rows;
  assert.equal(events.length, 1);
  assert.deepEqual(Object.keys(events[0].payload.data).sort(), ['active', 'capability_tags', 'catalog_revision', 'category', 'category_review', 'guild_key']);
  assert.equal(events[0].payload.data.guild_key, 'guild_security');
  assert.equal(events[0].payload.data.category, 'external');
  assert.equal(events[0].payload.data.reason, undefined);
  assert.equal(JSON.stringify(events[0].payload).includes(email), false);
  assert.equal(JSON.stringify(events[0].payload).includes('改測'), false);
  assert.equal((await pool.query(`SELECT count(*) FROM transition_journal WHERE command = 'classify_guild'`)).rows[0].count, '1');
});

test('T-016 the same guild cannot stay a primary after it is left', async () => {
  const s = await login();
  const guild = 'guild_member_operations';
  await join(s, 'guild_talent_direction');
  await join(s, guild);
  assert.equal((await admin(flagged, '/guild-preferences/switch', {accept_blocked: false})).status, 200);
  async function race(clearPrimary: boolean) {
    const membership = (await member(flagged, '/guilds/directory', s)).data.items.find((item: {guild_key: string}) => item.guild_key === guild).membership;
    const view = await member(flagged, '/me/guild-preferences/v2', s);
    assert.equal(view.status, 200, JSON.stringify(view.data));
    const version = String(view.data.aggregate_version);
    await Promise.all([
      member(flagged, '/me/guild-preferences/v2/set', s, {category: 'internal', guild_key: guild, catalog_revision: await revision(guild)}, {version, key: randomUUID()}),
      member(flagged, `/guilds/${guild}/leave-v2`, s, {clear_primary: clearPrimary}, {version: String(membership.aggregate_version), preferenceVersion: version, key: randomUUID()}),
    ]);
    const stuck = (await pool.query(`SELECT p.guild_key FROM guild_category_preferences p
      JOIN positioning_profession_memberships m ON m.community_id = p.community_id AND m.user_id = p.user_id AND m.guild_key = p.guild_key
      WHERE p.user_id = $1 AND m.state <> 'active'`, [s.user.user_id])).rows;
    assert.deepEqual(stuck, []);
    const state = (await pool.query(`SELECT state FROM positioning_profession_memberships WHERE user_id = $1 AND guild_key = $2`, [s.user.user_id, guild])).rows[0].state;
    const slotted = (await pool.query(`SELECT guild_key FROM guild_category_preferences WHERE user_id = $1 AND guild_key = $2`, [s.user.user_id, guild])).rows[0]?.guild_key ?? null;
    if (state === 'left') assert.equal(slotted, null);
  }
  await race(true);
  const left = (await pool.query(`SELECT state, aggregate_version::text AS aggregate_version FROM positioning_profession_memberships WHERE user_id = $1 AND guild_key = $2`, [s.user.user_id, guild])).rows[0];
  if (left.state === 'left') {
    const rejoined = await member(flagged, `/guilds/${guild}/join`, s, {}, {version: left.aggregate_version});
    assert.equal(rejoined.status, 200, JSON.stringify(rejoined.data));
  }
  await pool.query(`DELETE FROM guild_category_preferences WHERE user_id = $1 AND guild_key = $2`, [s.user.user_id, guild]);
  await race(false);
});

test('T-002 raw membership and catalog updates cannot keep a stale slot', async () => {
  const s = await login();
  await join(s, 'guild_security');
  await join(s, 'guild_talent_direction');
  assert.equal((await admin(flagged, '/guild-preferences/switch', {accept_blocked: true})).status, 200);
  const view = await member(flagged, '/me/guild-preferences/v2', s);
  const set = await member(flagged, '/me/guild-preferences/v2/set', s, {category: 'professional_industry', guild_key: 'guild_security', catalog_revision: await revision('guild_security')}, {version: String(view.data.aggregate_version)});
  assert.equal(set.status, 200, JSON.stringify(set.data));
  const rejectCode = (error: {code?: string}) => error.code === '23514';
  await assert.rejects(pool.query(`UPDATE positioning_profession_memberships SET state = 'left' WHERE community_id = $1 AND user_id = $2 AND guild_key = 'guild_security'`, [DEMO_COMMUNITY, s.user.user_id]), rejectCode);
  await assert.rejects(pool.query(`UPDATE guild_catalog_categories SET category = 'external' WHERE guild_key = 'guild_security'`), rejectCode);
  await assert.rejects(pool.query(`UPDATE guild_catalog_categories SET active = false WHERE guild_key = 'guild_security'`), rejectCode);
  assert.equal((await pool.query(`SELECT state FROM positioning_profession_memberships WHERE user_id = $1 AND guild_key = 'guild_security'`, [s.user.user_id])).rows[0].state, 'active');
  const catalog = (await pool.query(`SELECT category::text AS category, active FROM guild_catalog_categories WHERE guild_key = 'guild_security'`)).rows[0];
  assert.equal(catalog.category, 'professional_industry');
  assert.equal(catalog.active, true);
  const membership = (await member(flagged, '/guilds/directory', s)).data.items.find((item: {guild_key: string}) => item.guild_key === 'guild_security').membership;
  const current = await member(flagged, '/me/guild-preferences/v2', s);
  const left = await member(flagged, '/guilds/guild_security/leave-v2', s, {clear_primary: true}, {version: String(membership.aggregate_version), preferenceVersion: String(current.data.aggregate_version)});
  assert.equal(left.status, 200, JSON.stringify(left.data));
  assert.equal((await pool.query(`SELECT state FROM positioning_profession_memberships WHERE user_id = $1 AND guild_key = 'guild_security'`, [s.user.user_id])).rows[0].state, 'left');
  assert.equal((await pool.query(`SELECT count(*) FROM guild_category_preferences WHERE user_id = $1 AND guild_key = 'guild_security'`, [s.user.user_id])).rows[0].count, '0');
  const moved = await admin(flagged, '/guilds/guild_talent_direction/classification', {category: 'external', capability_tags: [], reason: '服務路徑仍可改分類'}, {version: await revision('guild_talent_direction')});
  assert.equal(moved.status, 200, JSON.stringify(moved.data));
});

test('T-001 member writes share the catalog fence and wait for an exclusive classification lock', async () => {
  const community = DEMO_COMMUNITY;
  const maker = DEMO_USERS[0].user_id;
  const first = 'a0000000-0000-4000-8000-000000000041';
  const second = 'a0000000-0000-4000-8000-000000000042';
  for (const id of [first, second]) {
    await pool.query(`INSERT INTO users(user_id, community_id, email, display_name, password_hash, profession_membership_ref)
      SELECT $1,$2,$3,$4,password_hash,$5 FROM users WHERE user_id = $6`, [id, community, `${id}@example.test`, id, randomUUID(), maker]);
    await pool.query(`INSERT INTO guild_preference_sets(community_id, user_id, aggregate_version, migration_state) VALUES ($1,$2,1,'backfilled')`, [community, id]);
    await pool.query(`INSERT INTO positioning_profession_memberships(membership_id, community_id, user_id, guild_key, state, member_tier) VALUES ($1,$2,$3,'guild_talent_direction','active','intern')`, [randomUUID(), community, id]);
  }
  const a = await pool.connect();
  const b = await pool.connect();
  try {
    await a.query('BEGIN');
    await b.query('BEGIN');
    await b.query(`SET LOCAL lock_timeout = '400ms'`);
    const pidA = Number((await a.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
    const pidB = Number((await b.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
    await lockGuildCatalogShared(a);
    await lockMemberGuilds(a, {community_id: community, user_id: first});
    await a.query(`SELECT aggregate_version FROM guild_preference_sets WHERE community_id = $1 AND user_id = $2 FOR UPDATE`, [community, first]);
    await lockGuildCatalogShared(b);
    await lockMemberGuilds(b, {community_id: community, user_id: second});
    await b.query(`SELECT aggregate_version FROM guild_preference_sets WHERE community_id = $1 AND user_id = $2 FOR UPDATE`, [community, second]);
    const locks = (await pool.query(`SELECT pid, mode, granted, pg_blocking_pids(pid) AS blockers FROM pg_locks WHERE locktype = 'advisory' AND pid = ANY($1::int[])`, [[pidA, pidB]])).rows as {pid: number; mode: string; granted: boolean; blockers: number[]}[];
    assert.equal(locks.some(row => row.granted === false), false);
    assert.ok(locks.some(row => Number(row.pid) === pidA && row.mode === 'ShareLock' && row.granted));
    assert.ok(locks.some(row => Number(row.pid) === pidB && row.mode === 'ShareLock' && row.granted));
    for (const row of locks) {
      const blockers = (row.blockers ?? []).map(Number);
      assert.equal(blockers.includes(pidA), false);
      assert.equal(blockers.includes(pidB), false);
    }
  } finally {
    await a.query('ROLLBACK').catch(() => undefined);
    await b.query('ROLLBACK').catch(() => undefined);
    a.release();
    b.release();
  }
  const s = await login();
  await join(s, 'guild_talent_direction');
  await join(s, 'guild_member_operations');
  assert.equal((await admin(flagged, '/guild-preferences/switch', {accept_blocked: false})).status, 200);
  const view = await member(flagged, '/me/guild-preferences/v2', s);
  const version = String(view.data.aggregate_version);
  const holder = await pool.connect();
  try {
    await holder.query('BEGIN');
    await lockGuildCatalog(holder);
    const holderPid = Number((await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
    const writePromise = member(flagged, '/me/guild-preferences/v2/set', s, {category: 'internal', guild_key: 'guild_member_operations', catalog_revision: await revision('guild_member_operations')}, {version});
    const deadline = Date.now() + 8000;
    let waiting: {mode: string}[] = [];
    while (Date.now() < deadline) {
      waiting = (await pool.query(`SELECT mode FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND $1 = ANY(pg_blocking_pids(pid))`, [holderPid])).rows;
      if (waiting.length) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.ok(waiting.some(row => row.mode === 'ShareLock'), JSON.stringify(waiting));
    await holder.query('ROLLBACK');
    const saved = await writePromise;
    assert.equal(saved.status, 200, JSON.stringify(saved.data));
    assert.equal(slot(saved.data, 'internal'), 'guild_member_operations');
  } finally {
    await holder.query('ROLLBACK').catch(() => undefined);
    holder.release();
  }
});

test('T-054 execute continues past a blocked member at the front of the batch', async () => {
  const communityId = randomUUID();
  const maker = DEMO_USERS[0].user_id;
  const blocked = 'c0000000-0000-4000-8000-000000000001';
  const firstClean = 'c0000000-0000-4000-8000-000000000002';
  const secondClean = 'c0000000-0000-4000-8000-000000000003';
  await pool.query('INSERT INTO communities(community_id, name) VALUES ($1,$2)', [communityId, '分批對照社群']);
  async function person(id: string, guild: string) {
    await pool.query(`INSERT INTO users(user_id, community_id, email, display_name, password_hash, profession_membership_ref)
      SELECT $1,$2,$3,$4,password_hash,$5 FROM users WHERE user_id = $6`, [id, communityId, `${id}@example.test`, id, randomUUID(), maker]);
    await pool.query(`INSERT INTO positioning_profession_memberships(membership_id, community_id, user_id, guild_key, state, member_tier)
      VALUES ($1,$2,$3,$4,'active','intern')`, [randomUUID(), communityId, id, guild]);
    await pool.query(`INSERT INTO guild_member_preferences(community_id, user_id, primary_guild_key, secondary_guild_keys)
      VALUES ($1,$2,$3,NULL)`, [communityId, id, guild]);
  }
  await person(blocked, 'guild_ai_vibe');
  await person(firstClean, 'guild_talent_direction');
  await person(secondClean, 'guild_member_operations');
  async function rows(table: string, userId: string) {
    return (await pool.query(`SELECT count(*) FROM ${table} WHERE user_id = $1`, [userId])).rows[0].count as string;
  }
  async function audits() {
    return (await pool.query(`SELECT user_id, count(*) FROM guild_preference_migration_audit WHERE community_id = $1 GROUP BY user_id ORDER BY user_id`, [communityId])).rows;
  }

  const dry = await backfillGuildPreferences(pool, {communityId, dryRun: true, limit: 1});
  assert.equal(dry.dry_run, true);
  assert.equal(dry.blocked, 1);
  assert.equal(dry.remaining, 3);
  assert.equal(dry.remaining_blocked, dry.blocked);
  assert.equal(await rows('guild_preference_sets', blocked), '0');
  assert.equal((await pool.query(`SELECT count(*) FROM guild_preference_sets WHERE community_id = $1`, [communityId])).rows[0].count, '0');

  const first = await backfillGuildPreferences(pool, {communityId, dryRun: false, limit: 1});
  assert.equal(first.processed, 1);
  assert.equal(await rows('guild_preference_sets', firstClean), '1');
  assert.equal(await rows('guild_preference_sets', secondClean), '0');
  assert.equal(await rows('guild_preference_sets', blocked), '0');
  assert.equal(await rows('guild_category_preferences', blocked), '0');
  assert.equal(await rows('guild_preference_invalidations', blocked), '0');

  const second = await backfillGuildPreferences(pool, {communityId, dryRun: false, limit: 1});
  assert.equal(second.processed, 1);
  assert.equal(await rows('guild_preference_sets', secondClean), '1');
  assert.equal(second.remaining, 1);
  assert.equal(second.remaining_blocked, 1);
  const written = await audits();
  assert.deepEqual(written, [{user_id: firstClean, count: '1'}, {user_id: secondClean, count: '1'}]);

  const third = await backfillGuildPreferences(pool, {communityId, dryRun: false, limit: 1});
  assert.equal(third.processed, 0);
  assert.equal(third.mapped, 0);
  assert.equal(third.remaining, third.remaining_blocked);
  assert.equal(third.remaining_blocked, 1);
  assert.equal(await rows('guild_preference_sets', blocked), '0');
  assert.equal(await rows('guild_category_preferences', blocked), '0');
  assert.equal(await rows('guild_preference_invalidations', blocked), '0');
  assert.deepEqual(await audits(), written);
});
