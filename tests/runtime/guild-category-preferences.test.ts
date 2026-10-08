import {test, before, after, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {Pool} from 'pg';
import {createLocalJWKSet, exportJWK, generateKeyPair, SignJWT} from 'jose';
import {createPool, LOCAL_DATABASE_URL, transaction} from '../../packages/db/index.js';
import {migrate} from '../../scripts/database.js';
import {seedLocal, DEMO_USERS, DEMO_PASSWORD, DEMO_COMMUNITY} from '../../packages/testing/seed.js';
import {createApp} from '../../apps/platform-api/src/app.js';
import {createAdminAccessVerifier} from '../../modules/platform-admin/access.js';
import {
  backfillGuildPreferences,
  lockGuildCatalog,
  lockGuildCatalogShared,
  recomputeLegacyProjection,
  switchInTransaction,
} from '../../modules/positioning/guild-categories.js';
import {lockMemberGuilds} from '../../modules/positioning/onboarding.js';
import {sampleGuildAnswers} from '../../modules/positioning/guild-questions.js';
import {guildPreferenceStatus} from '../../scripts/guild-preferences-backfill.js';
// @ts-expect-error Existing host-only clean environment helper is an ESM JavaScript module.
import {verificationEnvironment} from '../../packages/contribution-tools/process-env.mjs';

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
  const overVersion = await member(flagged, '/me/guild-preferences/v2/set', s, {category: 'internal', guild_key: null, catalog_revision: '9223372036854775808'}, {version});
  assert.equal(overVersion.status, 422);
  assert.equal(overVersion.data.code, 'validation_failed');
  const atVersionBound = await member(flagged, '/me/guild-preferences/v2/set', s, {category: 'internal', guild_key: 'guild_talent_direction', catalog_revision: '9223372036854775807'}, {version});
  assert.equal(atVersionBound.status, 409);
  assert.equal(atVersionBound.data.code, 'catalog_revision_changed');
  const catalogRev = await revision('guild_talent_direction');
  const longTag = await admin(flagged, '/guilds/guild_talent_direction/classification', {category: 'internal', capability_tags: [' ' + 'a'.repeat(64)], reason: '原因足夠'}, {version: catalogRev});
  assert.equal(longTag.status, 422, JSON.stringify(longTag.data));
  assert.equal(longTag.data.code, 'validation_failed');
  const longReason = await admin(flagged, '/guilds/guild_talent_direction/classification', {category: 'internal', capability_tags: ['tag'], reason: ' ' + 'a'.repeat(1000)}, {version: catalogRev});
  assert.equal(longReason.status, 422, JSON.stringify(longReason.data));
  assert.equal(longReason.data.code, 'validation_failed');
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

test("T-001 T-002 a member who registers after the switch starts with three empty slots, and quick-start fills only the chosen approved guild's category", async () => {
  const switched = await admin(flagged, '/guild-preferences/switch', {accept_blocked: false});
  assert.equal(switched.status, 200, JSON.stringify(switched.data));
  assert.deepEqual(switched.data, {state: 'switched', aggregate_version: 2, blocked: 0, processed: 0, already_switched: false});
  const registered = await member(flagged, '/auth/register', undefined, {email: 'post-switch-approved@example.test', password: 'guild-onboarding-test-password'});
  assert.equal(registered.status, 201, JSON.stringify(registered.data));
  const s: Session = {cookie: registered.response.headers.get('set-cookie')!.split(';')[0], csrf: registered.data.csrf_token, user: registered.data.user};
  const initial = (await pool.query(`SELECT s.aggregate_version::text AS aggregate_version, s.migration_state,
    u.onboarding_required, u.onboarding_completed_at FROM guild_preference_sets s JOIN users u USING (community_id, user_id)
    WHERE s.community_id=$1 AND s.user_id=$2`, [DEMO_COMMUNITY, s.user.user_id])).rows;
  assert.deepEqual(initial, [{aggregate_version: '1', migration_state: 'switched', onboarding_required: true, onboarding_completed_at: null}]);
  assert.deepEqual((await pool.query(`SELECT guild_key FROM guild_category_preferences WHERE user_id=$1`, [s.user.user_id])).rows, []);

  const gated = await member(flagged, '/me/guild-preferences/v2', s);
  assert.equal(gated.status, 403);
  assert.equal(gated.data.code, 'onboarding_required');
  const onboarding = await member(flagged, '/me/onboarding', s);
  assert.equal(onboarding.status, 200, JSON.stringify(onboarding.data));
  assert.equal(onboarding.data.required, true);
  assert.equal(onboarding.data.completed, false);
  const guild = 'guild_member_operations';
  const launchpadBefore = await member(flagged, `/guilds/${guild}/launchpad`, s);
  assert.equal(launchpadBefore.status, 403);
  assert.equal(launchpadBefore.data.code, 'onboarding_required');
  const body = {guild_keys: [guild], primary_guild_key: guild, confirmed: true, guild_answers: sampleGuildAnswers(guild)};
  const quick = await member(flagged, '/me/onboarding/quick-start', s, body);
  assert.equal(quick.status, 200, JSON.stringify(quick.data));
  assert.equal(quick.data.required, false);
  assert.equal(quick.data.completed, true);
  assert.equal(quick.data.entry_mode, 'quick');
  assert.equal(quick.data.assessment_completed, false);
  assert.equal(quick.data.draft, null);
  const view = await member(flagged, '/me/guild-preferences/v2', s);
  assert.equal(view.status, 200, JSON.stringify(view.data));
  assert.equal(view.response.headers.get('cache-control'), 'private, no-store');
  assert.equal(view.data.migration_state, 'switched');
  assert.equal(view.data.aggregate_version, 2);
  assert.equal(view.data.aggregate_version, Number(initial[0].aggregate_version) + 1);
  assert.equal(view.response.headers.get('etag'), `"${view.data.aggregate_version}"`);
  assert.deepEqual(view.data.primaries, [
    {category: 'internal', guild_key: guild},
    {category: 'external', guild_key: null},
    {category: 'professional_industry', guild_key: null},
  ]);
  assert.deepEqual((await pool.query(`SELECT category::text AS category, guild_key FROM guild_category_preferences WHERE user_id=$1`, [s.user.user_id])).rows,
    [{category: 'internal', guild_key: guild}]);

  const legacy = await member(flagged, '/me/guild-preferences', s);
  assert.equal(legacy.status, 200, JSON.stringify(legacy.data));
  // Quick start saves its chosen legacy primary before projecting the category slot.
  assert.deepEqual(legacy.data, {primary_guild_key: guild, secondary_guild_keys: [], aggregate_version: 1, compatibility: 'legacy_projection'});
  const beforeLegacyWrite = await counts();
  const refused = await member(flagged, `/guilds/${guild}/primary`, s, {}, {version: String(legacy.data.aggregate_version)});
  assert.equal(refused.status, 409);
  assert.equal(refused.data.code, 'client_upgrade_required');
  assert.deepEqual(await counts(), beforeLegacyWrite);
  const afterLegacyWrite = await member(flagged, '/me/guild-preferences/v2', s);
  assert.equal(afterLegacyWrite.status, 200, JSON.stringify(afterLegacyWrite.data));
  assert.deepEqual(afterLegacyWrite.data, view.data);
  assert.equal(afterLegacyWrite.response.headers.get('etag'), view.response.headers.get('etag'));
  assert.deepEqual((await member(flagged, '/me/guild-preferences', s)).data, legacy.data);

  const otherGuild = 'guild_opportunity_partnership';
  await join(s, otherGuild);
  const selected = await member(flagged, '/me/guild-preferences/v2/set', s, {
    category: 'external', guild_key: otherGuild, catalog_revision: await revision(otherGuild),
  }, {version: String(view.data.aggregate_version)});
  assert.equal(selected.status, 200, JSON.stringify(selected.data));
  assert.equal(selected.data.aggregate_version, 3);
  assert.equal(selected.response.headers.get('etag'), '"3"');
  assert.equal(slot(selected.data, 'internal'), guild);
  assert.equal(slot(selected.data, 'external'), otherGuild);
  assert.equal(slot(selected.data, 'professional_industry'), null);
  const launchpad = await member(flagged, `/guilds/${guild}/launchpad`, s);
  assert.equal(launchpad.status, 200, JSON.stringify(launchpad.data));

  const beforeReplay = await counts();
  // A fresh command key is a second completion attempt, not a receipt replay.
  const repeated = await member(flagged, '/me/onboarding/quick-start', s, body);
  assert.equal(repeated.status, 409);
  assert.equal(repeated.data.code, 'onboarding_already_completed');
  assert.deepEqual(await counts(), beforeReplay);
  const afterReplay = await member(flagged, '/me/guild-preferences/v2', s);
  assert.equal(afterReplay.status, 200, JSON.stringify(afterReplay.data));
  assert.deepEqual(afterReplay.data, selected.data);
  assert.equal(afterReplay.response.headers.get('etag'), selected.response.headers.get('etag'));
});

test('T-001 quick-start after the switch with a pending guild completes onboarding and writes no slot', async () => {
  const switched = await admin(flagged, '/guild-preferences/switch', {accept_blocked: false});
  assert.equal(switched.status, 200, JSON.stringify(switched.data));
  assert.deepEqual(switched.data, {state: 'switched', aggregate_version: 2, blocked: 0, processed: 0, already_switched: false});
  const registered = await member(flagged, '/auth/register', undefined, {email: 'post-switch-pending@example.test', password: 'guild-onboarding-test-password'});
  assert.equal(registered.status, 201, JSON.stringify(registered.data));
  const s: Session = {cookie: registered.response.headers.get('set-cookie')!.split(';')[0], csrf: registered.data.csrf_token, user: registered.data.user};
  const initial = (await pool.query(`SELECT aggregate_version::text AS aggregate_version, migration_state FROM guild_preference_sets WHERE user_id=$1`, [s.user.user_id])).rows;
  assert.deepEqual(initial, [{aggregate_version: '1', migration_state: 'switched'}]);
  const guild = 'guild_ai_vibe';
  assert.deepEqual((await pool.query(`SELECT category::text AS category, category_review::text AS category_review, active FROM guild_catalog_categories WHERE guild_key=$1`, [guild])).rows,
    [{category: null, category_review: 'pending', active: true}]);
  const quick = await member(flagged, '/me/onboarding/quick-start', s, {
    guild_keys: [guild], primary_guild_key: guild, confirmed: true, guild_answers: sampleGuildAnswers(guild),
  });
  assert.equal(quick.status, 200, JSON.stringify(quick.data));
  assert.equal(quick.data.required, false);
  assert.equal(quick.data.completed, true);
  assert.equal(quick.data.entry_mode, 'quick');
  assert.equal(quick.data.assessment_completed, false);
  assert.ok((await pool.query(`SELECT onboarding_completed_at FROM users WHERE user_id=$1`, [s.user.user_id])).rows[0].onboarding_completed_at);
  const view = await member(flagged, '/me/guild-preferences/v2', s);
  assert.equal(view.status, 200, JSON.stringify(view.data));
  assert.equal(view.data.migration_state, 'switched');
  assert.equal(view.data.aggregate_version, 1);
  assert.equal(view.data.aggregate_version, Number(initial[0].aggregate_version));
  assert.equal(view.response.headers.get('etag'), '"1"');
  assert.deepEqual(view.data.primaries, [
    {category: 'internal', guild_key: null},
    {category: 'external', guild_key: null},
    {category: 'professional_industry', guild_key: null},
  ]);
  assert.deepEqual((await pool.query(`SELECT guild_key FROM guild_category_preferences WHERE user_id=$1`, [s.user.user_id])).rows, []);
  assert.deepEqual((await pool.query(`SELECT aggregate_version::text AS aggregate_version, migration_state FROM guild_preference_sets WHERE user_id=$1`, [s.user.user_id])).rows, initial);
  const launchpad = await member(flagged, `/guilds/${guild}/launchpad`, s);
  assert.equal(launchpad.status, 200, JSON.stringify(launchpad.data));

  const approvedGuild = 'guild_security';
  await join(s, approvedGuild);
  const selected = await member(flagged, '/me/guild-preferences/v2/set', s, {
    category: 'professional_industry', guild_key: approvedGuild, catalog_revision: await revision(approvedGuild),
  }, {version: String(view.data.aggregate_version)});
  assert.equal(selected.status, 200, JSON.stringify(selected.data));
  assert.equal(selected.data.aggregate_version, 2);
  assert.equal(selected.response.headers.get('etag'), '"2"');
  assert.equal(slot(selected.data, 'internal'), null);
  assert.equal(slot(selected.data, 'external'), null);
  assert.equal(slot(selected.data, 'professional_industry'), approvedGuild);
  assert.deepEqual((await pool.query(`SELECT category::text AS category, guild_key FROM guild_category_preferences WHERE user_id=$1`, [s.user.user_id])).rows,
    [{category: 'professional_industry', guild_key: approvedGuild}]);
});

test('T-001 quick-start after the switch with an approved but inactive guild completes onboarding and writes no slot', async () => {
  const switched = await admin(flagged, '/guild-preferences/switch', {accept_blocked: false});
  assert.equal(switched.status, 200, JSON.stringify(switched.data));
  assert.deepEqual(switched.data, {state: 'switched', aggregate_version: 2, blocked: 0, processed: 0, already_switched: false});
  const guild = 'guild_security';
  await pool.query(`UPDATE guild_catalog_categories SET active=false WHERE guild_key=$1`, [guild]);
  try {
    assert.deepEqual((await pool.query(`SELECT category::text AS category, category_review::text AS category_review, active FROM guild_catalog_categories WHERE guild_key=$1`, [guild])).rows,
      [{category: 'professional_industry', category_review: 'approved', active: false}]);
    const registered = await member(flagged, '/auth/register', undefined, {email: 'post-switch-inactive@example.test', password: 'guild-onboarding-test-password'});
    assert.equal(registered.status, 201, JSON.stringify(registered.data));
    const s: Session = {cookie: registered.response.headers.get('set-cookie')!.split(';')[0], csrf: registered.data.csrf_token, user: registered.data.user};
    assert.deepEqual((await pool.query(`SELECT aggregate_version::text AS aggregate_version, migration_state FROM guild_preference_sets WHERE user_id=$1`, [s.user.user_id])).rows,
      [{aggregate_version: '1', migration_state: 'switched'}]);
    const quick = await member(flagged, '/me/onboarding/quick-start', s, {
      guild_keys: [guild], primary_guild_key: guild, confirmed: true, guild_answers: sampleGuildAnswers(guild),
    });
    assert.equal(quick.status, 200, JSON.stringify(quick.data));
    assert.equal(quick.data.required, false);
    assert.equal(quick.data.completed, true);
    assert.equal(quick.data.entry_mode, 'quick');
    assert.ok((await pool.query(`SELECT onboarding_completed_at FROM users WHERE user_id=$1`, [s.user.user_id])).rows[0].onboarding_completed_at);
    const view = await member(flagged, '/me/guild-preferences/v2', s);
    assert.equal(view.status, 200, JSON.stringify(view.data));
    assert.equal(view.data.migration_state, 'switched');
    assert.equal(view.data.aggregate_version, 1);
    assert.equal(view.response.headers.get('etag'), '"1"');
    assert.deepEqual(view.data.primaries, [
      {category: 'internal', guild_key: null},
      {category: 'external', guild_key: null},
      {category: 'professional_industry', guild_key: null},
    ]);
    assert.deepEqual((await pool.query(`SELECT guild_key FROM guild_category_preferences WHERE user_id=$1`, [s.user.user_id])).rows, []);
    assert.deepEqual((await pool.query(`SELECT state, member_tier FROM positioning_profession_memberships WHERE user_id=$1 AND guild_key=$2`, [s.user.user_id, guild])).rows,
      [{state: 'active', member_tier: 'intern'}]);
  } finally {
    await pool.query(`UPDATE guild_catalog_categories SET active=true WHERE guild_key=$1`, [guild]);
  }
});

test("T-002 a member who registered before the switch finishes quick-start after it and gets the chosen guild's category", async () => {
  const registered = await member(flagged, '/auth/register', undefined, {email: 'before-switch-onboarding@example.test', password: 'guild-onboarding-test-password'});
  assert.equal(registered.status, 201, JSON.stringify(registered.data));
  const s: Session = {cookie: registered.response.headers.get('set-cookie')!.split(';')[0], csrf: registered.data.csrf_token, user: registered.data.user};
  assert.deepEqual((await pool.query(`SELECT aggregate_version::text AS aggregate_version, migration_state FROM guild_preference_sets WHERE user_id=$1`, [s.user.user_id])).rows,
    [{aggregate_version: '1', migration_state: 'backfilled'}]);
  assert.deepEqual((await pool.query(`SELECT guild_key FROM guild_category_preferences WHERE user_id=$1`, [s.user.user_id])).rows, []);
  const beforeSwitch = await counts();
  const preview = await admin(flagged, '/guild-preferences/backfill', {dry_run: true});
  assert.equal(preview.status, 200, JSON.stringify(preview.data));
  assert.deepEqual(preview.data, {dry_run: true, processed: 0, mapped: 0, blocked: 0, ambiguous: 0, remaining: 0, remaining_blocked: 0, blocked_members: []});
  const switched = await admin(flagged, '/guild-preferences/switch', {accept_blocked: false});
  assert.equal(switched.status, 200, JSON.stringify(switched.data));
  assert.deepEqual(switched.data, {state: 'switched', aggregate_version: 2, blocked: 0, processed: 0, already_switched: false});
  assert.deepEqual(await counts(), beforeSwitch);
  // The reconciled empty set is not a mapping candidate; switch still advances every set.
  assert.deepEqual((await pool.query(`SELECT aggregate_version::text AS aggregate_version, migration_state FROM guild_preference_sets WHERE user_id=$1`, [s.user.user_id])).rows,
    [{aggregate_version: '2', migration_state: 'switched'}]);
  assert.deepEqual((await pool.query(`SELECT guild_key FROM guild_category_preferences WHERE user_id=$1`, [s.user.user_id])).rows, []);
  assert.deepEqual((await pool.query(`SELECT user_id FROM guild_preference_migration_audit WHERE user_id=$1`, [s.user.user_id])).rows, []);
  const gated = await member(flagged, '/me/guild-preferences/v2', s);
  assert.equal(gated.status, 403);
  assert.equal(gated.data.code, 'onboarding_required');

  const guild = 'guild_security';
  const quick = await member(flagged, '/me/onboarding/quick-start', s, {
    guild_keys: [guild], primary_guild_key: guild, confirmed: true, guild_answers: sampleGuildAnswers(guild),
  });
  assert.equal(quick.status, 200, JSON.stringify(quick.data));
  assert.equal(quick.data.required, false);
  assert.equal(quick.data.completed, true);
  assert.equal(quick.data.entry_mode, 'quick');
  assert.equal(quick.data.assessment_completed, false);
  const view = await member(flagged, '/me/guild-preferences/v2', s);
  assert.equal(view.status, 200, JSON.stringify(view.data));
  assert.equal(view.data.migration_state, 'switched');
  assert.equal(view.data.aggregate_version, 3);
  assert.equal(view.response.headers.get('etag'), '"3"');
  assert.deepEqual(view.data.primaries, [
    {category: 'internal', guild_key: null},
    {category: 'external', guild_key: null},
    {category: 'professional_industry', guild_key: guild},
  ]);
  assert.deepEqual((await pool.query(`SELECT category::text AS category, guild_key FROM guild_category_preferences WHERE user_id=$1`, [s.user.user_id])).rows,
    [{category: 'professional_industry', guild_key: guild}]);
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
  const moved = await admin(flagged, '/guilds/guild_talent_direction/classification', {category: 'external', capability_tags: ['會員陪跑'], reason: '改測社群業務推廣分類'}, {version: await revision('guild_talent_direction')});
  assert.equal(moved.status, 200, JSON.stringify(moved.data));
  assert.equal(moved.data.classification.category, 'external');
  assert.notEqual(moved.data.classification.catalog_revision, await revision('guild_member_operations'));
  const after = await member(flagged, '/me/guild-preferences/v2', s);
  assert.equal(slot(after.data, 'internal'), null);
  assert.equal(slot(after.data, 'external'), null);
  assert.equal(after.data.invalidated.find((item: {category: string}) => item.category === 'internal').reason, 'guild_recategorized');
  assert.equal((await pool.query(`SELECT state, member_tier FROM positioning_profession_memberships WHERE user_id = $1 AND guild_key = 'guild_talent_direction'`, [s.user.user_id])).rows[0].member_tier, 'intern');
  await admin(flagged, '/guilds/guild_talent_direction/classification', {category: 'internal', capability_tags: [], reason: '還原社群架構開發分類'}, {version: moved.data.classification.catalog_revision});

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

test('T-001 commerce classification journals one public event and refuses without an active member', async () => {
  async function facts() {
    return {
      revision: await revision('guild_commerce_sales'),
      audit: (await pool.query(`SELECT count(*) FROM platform_admin_audit`)).rows[0].count as string,
      outbox: (await pool.query(`SELECT count(*) FROM outbox WHERE event_type = 'freedom.guild.classification.changed.v1'`)).rows[0].count as string,
      journal: (await pool.query(`SELECT count(*) FROM transition_journal WHERE command = 'classify_guild'`)).rows[0].count as string,
    };
  }
  async function classifyAs(value: string, version: string) {
    const token = await sign(value);
    const tokenCsrf = (await verifier(new Request(origin, {headers: {'Cf-Access-Jwt-Assertion': token}}))).csrfToken;
    const response = await flagged.request(origin + '/admin/api/guilds/guild_commerce_sales/classification', {
      method: 'POST',
      headers: {Origin: origin, 'Cf-Access-Jwt-Assertion': token, 'X-Admin-CSRF': tokenCsrf, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID(), 'If-Match': `"${version}"`},
      body: JSON.stringify({category: 'external', capability_tags: [], reason: '沒有可用的會員帳號'}),
    });
    return {status: response.status, data: await read(response)};
  }
  const initial = (await pool.query(`SELECT category, category_review FROM guild_catalog_categories WHERE guild_key = 'guild_commerce_sales'`)).rows[0];
  assert.deepEqual(initial, {category: null, category_review: 'pending'});
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
  const body = {category: 'external', capability_tags: ['通路'], reason: '改測公開事件'};
  const options = {version: await revision('guild_commerce_sales'), key: randomUUID()};
  const saved = await admin(flagged, '/guilds/guild_commerce_sales/classification', body, options);
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.equal(saved.data.classification.category, 'external');
  assert.equal(saved.data.classification.category_review, 'approved');
  assert.equal((await pool.query(`SELECT reviewed_by_principal_id FROM guild_catalog_categories WHERE guild_key = 'guild_commerce_sales'`)).rows[0].reviewed_by_principal_id, adminId);
  const savedFacts = await facts();
  const replay = await admin(flagged, '/guilds/guild_commerce_sales/classification', body, options);
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.data, saved.data);
  assert.deepEqual(await facts(), savedFacts);
  assert.equal(savedFacts.audit, String(Number(before.audit) + 1));
  assert.deepEqual((await pool.query(`SELECT admin_id, verified_access_subject FROM platform_admin_audit
    WHERE action = 'guild_classification' AND target_ref = 'guild_commerce_sales'`)).rows,
  [{admin_id: adminId, verified_access_subject: 'verified-category-admin'}]);
  assert.deepEqual((await pool.query(`SELECT actor_ref FROM transition_journal
    WHERE aggregate_type = 'guild_classification' AND command = 'classify_guild'`)).rows,
  [{actor_ref: 'a0000000-0000-4000-8000-0000000000aa'}]);
  const events = (await pool.query(`SELECT payload FROM outbox WHERE event_type = 'freedom.guild.classification.changed.v1'`)).rows;
  assert.equal(events.length, 1);
  assert.deepEqual(Object.keys(events[0].payload.data).sort(), ['active', 'capability_tags', 'catalog_revision', 'category', 'category_review', 'guild_key']);
  assert.equal(events[0].payload.data.guild_key, 'guild_commerce_sales');
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

test('T-010 T-030 T-054 an old pending primary stays blocked through backfill and switch', async () => {
  const pendingMember = await login(0);
  const mappedMember = await login(1);
  const pendingId = pendingMember.user.user_id;
  const mappedId = mappedMember.user.user_id;
  const ids = [pendingId, mappedId];
  const privacy = JSON.stringify({
    discord: {value: 'pa-privacy', audiences: ['guild']},
    github: {value: '', audiences: []},
    line: {value: '', audiences: []},
    email: {audiences: []},
  });
  for (const id of ids) {
    await pool.query(`INSERT INTO member_accounts(user_id, community_id, contacts, identity_label) VALUES ($1,$2,$3::jsonb,'alien')
      ON CONFLICT (user_id) DO UPDATE SET contacts = EXCLUDED.contacts, identity_label = EXCLUDED.identity_label`, [id, DEMO_COMMUNITY, privacy]);
  }
  async function rows(sql: string, params: unknown[] = []) {
    return (await pool.query(sql, params)).rows;
  }
  async function preserved() {
    return {
      legacy: await rows(`SELECT user_id, primary_guild_key, secondary_guild_keys FROM guild_member_preferences WHERE user_id = ANY($1::uuid[]) ORDER BY user_id`, [ids]),
      memberships: await rows(`SELECT user_id, guild_key, state, member_tier FROM positioning_profession_memberships WHERE user_id = ANY($1::uuid[]) ORDER BY user_id, guild_key`, [ids]),
      grants: await rows(`SELECT user_id, guild_key, book_id FROM member_skill_book_grants WHERE user_id = ANY($1::uuid[]) ORDER BY user_id, guild_key, book_id`, [ids]),
      privacy: await rows(`SELECT user_id, contacts, identity_label FROM member_accounts WHERE user_id = ANY($1::uuid[]) ORDER BY user_id`, [ids]),
      slots: await rows(`SELECT user_id, category::text AS category, guild_key FROM guild_category_preferences WHERE user_id = ANY($1::uuid[]) ORDER BY user_id, category`, [ids]),
      states: await rows(`SELECT user_id, migration_state FROM guild_preference_sets WHERE user_id = ANY($1::uuid[]) ORDER BY user_id`, [ids]),
      audits: await rows(`SELECT user_id, legacy_primary, invalidation_reason FROM guild_preference_migration_audit WHERE user_id = ANY($1::uuid[]) ORDER BY user_id, legacy_primary, invalidation_reason`, [ids]),
      switch: await rows(`SELECT state FROM guild_preference_switch WHERE community_id = $1`, [DEMO_COMMUNITY]),
      adminReceipts: (await pool.query(`SELECT count(*) FROM platform_admin_receipts`)).rows[0].count as string,
      preferenceEvents: (await pool.query(`SELECT count(*) FROM outbox WHERE event_type = 'freedom.guild.preference.changed.v1'`)).rows[0].count as string,
    };
  }
  function listed(report: {blocked_members: {user_id: string; reason: string}[]}, userId: string) {
    return report.blocked_members.find(item => item.user_id === userId);
  }

  await join(pendingMember, 'guild_ai_vibe');
  const pendingPrimary = await member(flagged, '/guilds/guild_ai_vibe/primary', pendingMember, {});
  assert.equal(pendingPrimary.status, 200, JSON.stringify(pendingPrimary.data));
  const repeated = await member(flagged, '/guilds/guild_ai_vibe/primary', pendingMember, {}, {version: String(pendingPrimary.data.aggregate_version)});
  assert.equal(repeated.status, 200, JSON.stringify(repeated.data));
  const afterPendingWrite = await admin(flagged, '/guild-preferences/backfill', {dry_run: true});

  await join(mappedMember, 'guild_talent_direction');
  await join(mappedMember, 'guild_security');
  const cleanPrimary = await member(flagged, '/guilds/guild_talent_direction/primary', mappedMember, {});
  assert.equal(cleanPrimary.status, 200, JSON.stringify(cleanPrimary.data));
  const mappedSet = (await pool.query(`SELECT migration_state FROM guild_preference_sets WHERE user_id = $1`, [mappedId])).rows[0];
  const mappedSlots = (await pool.query(`SELECT guild_key FROM guild_category_preferences WHERE user_id = $1 ORDER BY guild_key`, [mappedId])).rows.map(row => row.guild_key);
  const backfill = await admin(flagged, '/guild-preferences/backfill', {dry_run: false});
  await join(mappedMember, 'guild_ai_vibe');
  const legacyBeforeChange = await member(flagged, '/me/guild-preferences', mappedMember);
  const changed = await member(flagged, '/guilds/guild_ai_vibe/primary', mappedMember, {}, {version: String(legacyBeforeChange.data.aggregate_version)});
  assert.equal(changed.status, 200, JSON.stringify(changed.data));
  const afterChange = await admin(flagged, '/guild-preferences/backfill', {dry_run: true});
  const beforeRefusal = await preserved();
  const refused = await admin(flagged, '/guild-preferences/switch', {accept_blocked: false});
  const afterRefusal = await preserved();

  const observed = {
    after_pending_write: afterPendingWrite.data,
    mapped_state_after_clean_primary: mappedSet?.migration_state ?? null,
    mapped_slots_after_clean_primary: mappedSlots,
    backfill_after_clean_primary: backfill.data,
    after_pending_change: afterChange.data,
    refused_status: refused.status,
    refused_code: refused.data?.code ?? null,
    before_refusal_states: beforeRefusal.states,
    after_refusal_states: afterRefusal.states,
    after_refusal_switch: afterRefusal.switch,
    after_refusal_audits: afterRefusal.audits,
  };
  assert.equal(afterPendingWrite.status, 200, JSON.stringify(observed));
  assert.equal(listed(afterPendingWrite.data, pendingId)?.reason, 'unknown_category', JSON.stringify(observed));
  assert.equal(afterPendingWrite.data.blocked >= 1, true, JSON.stringify(observed));
  assert.equal(afterPendingWrite.data.remaining_blocked, afterPendingWrite.data.blocked, JSON.stringify(observed));
  assert.equal(mappedSet.migration_state, 'backfilled', JSON.stringify(observed));
  assert.deepEqual(mappedSlots, ['guild_talent_direction'], JSON.stringify(observed));
  assert.equal(backfill.status, 200, JSON.stringify(observed));
  assert.equal(backfill.data.processed, 0, JSON.stringify(observed));
  assert.equal(listed(afterChange.data, pendingId)?.reason, 'unknown_category', JSON.stringify(observed));
  assert.equal(listed(afterChange.data, mappedId)?.reason, 'unknown_category', JSON.stringify(observed));
  assert.equal(afterChange.data.blocked, 2, JSON.stringify(observed));
  assert.equal(afterChange.data.remaining_blocked, 2, JSON.stringify(observed));
  assert.equal(refused.status, 409, JSON.stringify(observed));
  assert.equal(refused.data.code, 'preference_switch_blocked', JSON.stringify(observed));
  assert.deepEqual(afterRefusal.switch, [], JSON.stringify(observed));
  assert.deepEqual(afterRefusal.states.map(row => row.migration_state), ['legacy', 'legacy'], JSON.stringify(observed));
  assert.equal(afterRefusal.states.some(row => row.migration_state === 'switched'), false);
  assert.deepEqual(afterRefusal.slots, []);
  assert.equal(afterRefusal.audits.some(row => row.legacy_primary === 'guild_ai_vibe' && row.invalidation_reason == null), false, JSON.stringify(afterRefusal.audits));
  assert.equal(afterRefusal.audits.filter(row => row.user_id === pendingId).every(row => row.invalidation_reason === 'legacy_ambiguous'), true, JSON.stringify(afterRefusal.audits));
  assert.deepEqual(afterRefusal.legacy, beforeRefusal.legacy);
  assert.deepEqual(afterRefusal.memberships, beforeRefusal.memberships);
  assert.deepEqual(afterRefusal.grants, beforeRefusal.grants);
  assert.deepEqual(afterRefusal.privacy, beforeRefusal.privacy);
  assert.equal(afterRefusal.adminReceipts, beforeRefusal.adminReceipts);
  assert.equal(afterRefusal.preferenceEvents, beforeRefusal.preferenceEvents);
  assert.deepEqual(afterRefusal.audits, beforeRefusal.audits);

  const beforeAccept = await preserved();
  const accepted = await admin(flagged, '/guild-preferences/switch', {accept_blocked: true});
  assert.equal(accepted.status, 200, JSON.stringify(accepted.data));
  assert.equal(accepted.data.state, 'switched');
  assert.equal(accepted.data.blocked, 2);
  const afterAccept = await preserved();
  assert.deepEqual(afterAccept.legacy, beforeAccept.legacy);
  assert.deepEqual(afterAccept.memberships, beforeAccept.memberships);
  assert.deepEqual(afterAccept.grants, beforeAccept.grants);
  assert.deepEqual(afterAccept.privacy, beforeAccept.privacy);
  assert.deepEqual(afterAccept.slots, []);
  assert.deepEqual(afterAccept.switch, [{state: 'switched'}]);
  assert.deepEqual(afterAccept.states.map(row => row.migration_state), ['switched', 'switched']);
  const ambiguous = await rows(`SELECT user_id FROM guild_preference_invalidations WHERE user_id = ANY($1::uuid[]) AND reason = 'legacy_ambiguous' ORDER BY user_id`, [ids]);
  assert.equal(ambiguous.some(row => row.user_id === pendingId), true);
  assert.equal(ambiguous.some(row => row.user_id === mappedId), true);
  const versions = await rows(`SELECT s.user_id, s.aggregate_version::text AS aggregate_version, i.new_version::text AS new_version
    FROM guild_preference_sets s JOIN guild_preference_invalidations i USING (community_id, user_id)
    WHERE s.user_id = ANY($1::uuid[]) AND i.reason = 'legacy_ambiguous'`, [ids]);
  assert.equal(versions.length >= 2, true, JSON.stringify(versions));
  assert.equal(versions.every(row => row.new_version === row.aggregate_version), true, JSON.stringify(versions));
  assert.equal(afterAccept.preferenceEvents, beforeAccept.preferenceEvents);
});

test('T-030 a clean primary after an ambiguous recompute is mapped and can switch', async () => {
  const memberSession = await login(0);
  await join(memberSession, 'guild_ai_vibe');
  await join(memberSession, 'guild_talent_direction');
  const pendingPrimary = await member(flagged, '/guilds/guild_ai_vibe/primary', memberSession, {});
  assert.equal(pendingPrimary.status, 200, JSON.stringify(pendingPrimary.data));
  const blocked = await admin(flagged, '/guild-preferences/backfill', {dry_run: true});
  assert.equal(blocked.data.blocked_members.some((item: {user_id: string; reason: string}) => item.user_id === memberSession.user.user_id && item.reason === 'unknown_category'), true, JSON.stringify(blocked.data));
  const current = await member(flagged, '/me/guild-preferences', memberSession);
  const clean = await member(flagged, '/guilds/guild_talent_direction/primary', memberSession, {}, {version: String(current.data.aggregate_version)});
  assert.equal(clean.status, 200, JSON.stringify(clean.data));
  const state = (await pool.query(`SELECT migration_state FROM guild_preference_sets WHERE user_id = $1`, [memberSession.user.user_id])).rows[0].migration_state;
  assert.equal(state, 'backfilled');
  const slots = (await pool.query(`SELECT category::text AS category, guild_key FROM guild_category_preferences WHERE user_id = $1 ORDER BY category`, [memberSession.user.user_id])).rows;
  assert.deepEqual(slots, [{category: 'internal', guild_key: 'guild_talent_direction'}]);
  const preview = await admin(flagged, '/guild-preferences/backfill', {dry_run: true});
  assert.equal(preview.data.blocked_members.some((item: {user_id: string}) => item.user_id === memberSession.user.user_id), false, JSON.stringify(preview.data));
  assert.equal(preview.data.blocked, 0, JSON.stringify(preview.data));
  const legacyBefore = (await pool.query(`SELECT primary_guild_key, secondary_guild_keys FROM guild_member_preferences WHERE user_id = $1`, [memberSession.user.user_id])).rows[0];
  const switched = await admin(flagged, '/guild-preferences/switch', {accept_blocked: false});
  assert.equal(switched.status, 200, JSON.stringify(switched.data));
  assert.equal(switched.data.blocked, 0);
  const legacyAfter = (await pool.query(`SELECT primary_guild_key, secondary_guild_keys FROM guild_member_preferences WHERE user_id = $1`, [memberSession.user.user_id])).rows[0];
  assert.deepEqual(legacyAfter, legacyBefore);
  assert.deepEqual((await pool.query(`SELECT category::text AS category, guild_key FROM guild_category_preferences WHERE user_id = $1 ORDER BY category`, [memberSession.user.user_id])).rows, slots);
});

test('T-010 T-030 read-only status reports legacy, backfilled, switched and blocked communities', async () => {
  const communityL = randomUUID();
  const communityF = randomUUID();
  const communityS = randomUUID();
  const communityB = randomUUID();
  await pool.query('INSERT INTO communities(community_id, name) VALUES ($1,$2)', [communityL, '社群 L']);
  await pool.query('INSERT INTO communities(community_id, name) VALUES ($1,$2)', [communityF, '社群 F']);
  await pool.query('INSERT INTO communities(community_id, name) VALUES ($1,$2)', [communityS, '社群 S']);
  await pool.query('INSERT INTO communities(community_id, name) VALUES ($1,$2)', [communityB, '社群 B']);

  const maker = DEMO_USERS[0].user_id;
  async function user(communityId: string, id: string, name: string) {
    await pool.query(`INSERT INTO users(user_id, community_id, email, display_name, password_hash, profession_membership_ref)
      SELECT $1,$2,$3,$4,password_hash,$5 FROM users WHERE user_id = $6`, [id, communityId, `${id}@example.test`, name, randomUUID(), maker]);
  }
  async function membership(communityId: string, id: string, key: string, state = 'active', tier = 'intern') {
    await pool.query(`INSERT INTO positioning_profession_memberships(membership_id, community_id, user_id, guild_key, state, member_tier) VALUES ($1,$2,$3,$4,$5,$6)`, [randomUUID(), communityId, id, key, state, tier]);
  }
  async function preference(communityId: string, id: string, primary: string, secondary: string[] | null = null) {
    await pool.query(`INSERT INTO guild_member_preferences(community_id, user_id, primary_guild_key, secondary_guild_keys) VALUES ($1,$2,$3,$4)`, [communityId, id, primary, secondary]);
  }

  const idL = 'd0000000-0000-4000-8000-000000000001';
  await user(communityL, idL, 'L成員');
  await membership(communityL, idL, 'guild_member_operations');
  await preference(communityL, idL, 'guild_member_operations');

  const idF = 'd0000000-0000-4000-8000-000000000002';
  await user(communityF, idF, 'F成員');
  await membership(communityF, idF, 'guild_platform_engineering');
  await preference(communityF, idF, 'guild_platform_engineering');
  await backfillGuildPreferences(pool, {communityId: communityF, dryRun: false});

  const idS = 'd0000000-0000-4000-8000-000000000003';
  await user(communityS, idS, 'S成員');
  await membership(communityS, idS, 'guild_talent_direction');
  await preference(communityS, idS, 'guild_talent_direction');
  await backfillGuildPreferences(pool, {communityId: communityS, dryRun: false});
  await transaction(pool, q => switchInTransaction(q, {communityId: communityS, acceptBlocked: false, switchedBy: null}));

  const b1 = 'd0000000-0000-4000-8000-000000000004';
  const b2 = 'd0000000-0000-4000-8000-000000000005';
  const b3 = 'd0000000-0000-4000-8000-000000000006';
  await user(communityB, b1, 'B1');
  await membership(communityB, b1, 'guild_security');
  await preference(communityB, b1, 'guild_security');

  await user(communityB, b2, 'B2');
  await membership(communityB, b2, 'guild_ai_vibe');
  await preference(communityB, b2, 'guild_ai_vibe');

  await user(communityB, b3, 'B3');
  await membership(communityB, b3, 'guild_talent_direction', 'left', 'full');
  await preference(communityB, b3, 'guild_talent_direction');

  await backfillGuildPreferences(pool, {communityId: communityB, dryRun: false});
  await transaction(pool, q => recomputeLegacyProjection(q, {community_id: communityB, user_id: b2}));

  const tableRows = (await pool.query(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE' AND left(table_name, 6) = 'guild_' ORDER BY table_name`,
  )).rows as {table_name: string}[];
  const tableNames = tableRows.map(r => r.table_name);
  for (const name of [
    'guild_preference_sets', 'guild_preference_switch', 'guild_category_preferences',
    'guild_preference_migration_audit', 'guild_preference_invalidations', 'guild_catalog_categories',
  ]) {
    assert.equal(tableNames.includes(name), true, `Missing required table: ${name}`);
  }
  async function snapshotGuildTables() {
    const counts: Record<string, number> = {};
    for (const name of tableNames) {
      const res = await pool.query(`SELECT count(*)::int AS count FROM ${name}`);
      counts[name] = Number(res.rows[0].count);
    }
    return counts;
  }
  const beforeSnapshot = await snapshotGuildTables();

  const status = await guildPreferenceStatus(pool);
  const byCommunity = new Map(status.communities.map(c => [c.community_id, c]));

  assert.deepEqual(byCommunity.get(communityL), {
    community_id: communityL,
    state: 'legacy',
    switched_at: null,
    remaining: 1,
    remaining_blocked: 0,
    blocking_reasons: {},
    blocking_reasons_complete: true,
    preference_sets: {legacy: 0, backfilled: 0, switched: 0},
  });

  assert.deepEqual(byCommunity.get(communityF), {
    community_id: communityF,
    state: 'backfilled',
    switched_at: null,
    remaining: 0,
    remaining_blocked: 0,
    blocking_reasons: {},
    blocking_reasons_complete: true,
    preference_sets: {legacy: 0, backfilled: 1, switched: 0},
  });

  const entryS = byCommunity.get(communityS)!;
  assert.ok(entryS?.switched_at);
  assert.equal(Number.isNaN(Date.parse(entryS.switched_at)), false);
  assert.deepEqual(entryS, {
    community_id: communityS,
    state: 'switched',
    switched_at: entryS.switched_at,
    remaining: 0,
    remaining_blocked: 0,
    blocking_reasons: {},
    blocking_reasons_complete: true,
    preference_sets: {legacy: 0, backfilled: 0, switched: 1},
  });

  assert.deepEqual(byCommunity.get(communityB), {
    community_id: communityB,
    state: 'blocked',
    switched_at: null,
    remaining: 2,
    remaining_blocked: 2,
    blocking_reasons: {unknown_category: 1, left_primary: 1},
    blocking_reasons_complete: true,
    preference_sets: {legacy: 1, backfilled: 1, switched: 0},
  });

  const ids = status.communities.map(c => c.community_id);
  assert.deepEqual(ids, [...ids].sort());

  assert.equal(status.totals.communities, status.communities.length);
  assert.equal(status.totals.legacy, status.communities.filter(c => c.state === 'legacy').length);
  assert.equal(status.totals.backfilled, status.communities.filter(c => c.state === 'backfilled').length);
  assert.equal(status.totals.switched, status.communities.filter(c => c.state === 'switched').length);
  assert.equal(status.totals.blocked, status.communities.filter(c => c.state === 'blocked').length);

  const sumPrefs = status.communities.reduce(
    (acc, c) => ({
      legacy: acc.legacy + c.preference_sets.legacy,
      backfilled: acc.backfilled + c.preference_sets.backfilled,
      switched: acc.switched + c.preference_sets.switched,
    }),
    {legacy: 0, backfilled: 0, switched: 0},
  );
  assert.deepEqual(status.totals.preference_sets, sumPrefs);

  const statusB = await guildPreferenceStatus(pool, {communityId: communityB});
  assert.deepEqual(statusB.communities, [byCommunity.get(communityB)]);
  assert.deepEqual(statusB.totals, {
    communities: 1,
    legacy: 0,
    backfilled: 0,
    switched: 0,
    blocked: 1,
    preference_sets: {legacy: 1, backfilled: 1, switched: 0},
  });
  await assert.rejects(
    () => guildPreferenceStatus(pool, {communityId: randomUUID()}),
    /No community matches --community-id/,
  );

  const afterSnapshot = await snapshotGuildTables();
  assert.deepEqual(afterSnapshot, beforeSnapshot);
});

test('T-010 status refuses --execute and --limit before connecting', () => {
  for (const extra of [['--execute'], ['--limit', '5']]) {
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/guild-preferences-backfill.ts', '--status', ...extra, '--database-url', 'postgresql://status-refusal@127.0.0.1:9/fp_status_refusal'], {
      cwd: fileURLToPath(new URL('../../', import.meta.url)), env: verificationEnvironment(),
      encoding: 'utf8', timeout: 30000, maxBuffer: 128 * 1024,
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /--status is read-only and cannot be combined with --execute or --limit\./);
    assert.equal(result.stdout, '');
  }
});

async function assertCatalogLockFree() {
  const countRes = await pool.query(`
    SELECT count(*)::int AS count
    FROM pg_locks l CROSS JOIN (SELECT hashtextextended('guild-catalog-revision', 0) AS k) h
    WHERE l.locktype = 'advisory'
      AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
      AND l.objsubid = 1
      AND l.classid::bigint = ((h.k >> 32) & 4294967295)
      AND l.objid::bigint = (h.k & 4294967295)
  `);
  assert.equal(countRes.rows[0].count, 0);

  const fresh = await database.connect();
  try {
    const lockRes = await fresh.query(`SELECT pg_try_advisory_lock(hashtextextended('guild-catalog-revision',0)) AS ok`);
    assert.equal(lockRes.rows[0].ok, true);
    const unlockRes = await fresh.query(`SELECT pg_advisory_unlock(hashtextextended('guild-catalog-revision',0)) AS ok`);
    assert.equal(unlockRes.rows[0].ok, true);
  } finally {
    fresh.release(true);
  }
}

test('T-010 status waits for the catalog lock and reports a write committed while it waited', async () => {
  const communityId = randomUUID();
  await pool.query(`INSERT INTO communities(community_id, name) VALUES ($1, 'Status Lock Test')`, [communityId]);
  const userId = 'e0000000-0000-4000-8000-000000000001';
  await pool.query(`INSERT INTO users(user_id, community_id, email, display_name, password_hash, profession_membership_ref)
    SELECT $1,$2,$3,$4,password_hash,$5 FROM users WHERE user_id = $6`, [userId, communityId, `${userId}@example.test`, 'Test User', randomUUID(), DEMO_USERS[0].user_id]);
  await pool.query(`INSERT INTO positioning_profession_memberships(membership_id, community_id, user_id, guild_key, state, member_tier) VALUES ($1,$2,$3,$4,$5,$6)`, [randomUUID(), communityId, userId, 'guild_member_operations', 'active', 'intern']);
  await pool.query(`INSERT INTO guild_member_preferences(community_id, user_id, primary_guild_key, secondary_guild_keys) VALUES ($1,$2,$3,$4)`, [communityId, userId, 'guild_member_operations', null]);

  const preStatus = await guildPreferenceStatus(pool, {communityId});
  assert.equal(preStatus.communities[0].state, 'legacy');
  assert.equal(preStatus.communities[0].remaining, 1);
  assert.equal(preStatus.communities[0].remaining_blocked, 0);
  assert.deepEqual(preStatus.communities[0].preference_sets, {legacy: 0, backfilled: 0, switched: 0});

  const w = await pool.connect();
  let settled = false;
  let statusPromise: ReturnType<typeof guildPreferenceStatus> | undefined;
  try {
    await w.query('BEGIN');
    const pid = (await w.query('SELECT pg_backend_pid()')).rows[0].pg_backend_pid;
    await lockGuildCatalogShared(w);
    await recomputeLegacyProjection(w, {community_id: communityId, user_id: userId});

    statusPromise = guildPreferenceStatus(pool).finally(() => { settled = true; });

    const deadline = Date.now() + 8000;
    let waiting = false;
    while (Date.now() < deadline) {
      const locks = await pool.query(`SELECT mode FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND $1 = ANY(pg_blocking_pids(pid))`, [pid]);
      if (locks.rows.some(r => r.mode === 'ExclusiveLock')) {
        waiting = true;
        break;
      }
      await new Promise(r => setTimeout(r, 20));
    }
    assert.equal(waiting, true);

    await new Promise(r => setTimeout(r, 300));
    assert.equal(settled, false);

    await w.query('COMMIT');

    const status = await statusPromise;
    const entry = status!.communities.find(c => c.community_id === communityId);
    assert.deepEqual(entry, {
      community_id: communityId,
      state: 'backfilled',
      switched_at: null,
      remaining: 0,
      remaining_blocked: 0,
      blocking_reasons: {},
      blocking_reasons_complete: true,
      preference_sets: {legacy: 0, backfilled: 1, switched: 0}
    });
  } finally {
    await w.query('ROLLBACK').catch(() => undefined);
    w.release();
    await statusPromise?.catch(() => undefined);
  }
});

test('T-010 status releases the catalog lock after a report', async () => {
  await guildPreferenceStatus(pool);
  await assertCatalogLockFree();
});

test('T-010 status releases the catalog lock after an error', async () => {
  await assert.rejects(() => guildPreferenceStatus(pool, {communityId: randomUUID()}), /No community matches --community-id/);
  await assertCatalogLockFree();
});
