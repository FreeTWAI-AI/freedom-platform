import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {Pool, PoolClient} from 'pg';
import {command, transaction, checkVersion, digest, journal, type Command} from '../../packages/db/index.js';
import {assertCurrentSessionClock} from '../../packages/db/member-session.js';
import {Problem, requireCondition} from '../../packages/shared/problem.js';
import type {Actor} from '../identity-membership/service.js';
import {
  BLOCK_KINDS, ConfigValidationError, VERSION_PATTERN, assertStoredVersion, hasLoneSurrogate, parseConfig, parseFieldErrors,
  type Config, type ConfigView,
} from '../../contracts/guild-launchpad/v1/config.js';
import {assertOfferedApplications, availableReleases} from '../module-registry/catalog.js';
import {LAUNCHPAD_PROFILES} from './launchpad-profiles.js';

/** Revision 2 adds guild purpose profiles and scoped default recommendations. */
export const PLATFORM_DEFAULT_REVISION = '2';
/** Initial pointer CAS remains 1 independently of the default content revision. */
export const DEFAULT_POINTER_VERSION = '1';
export const PUBLISHED_EVENT = 'freedom.guild.launchpad.config.published.v1';
const CAPABILITIES = ['guild.content.edit', 'guild.config.preview', 'guild.config.publish'] as const;
export type LaunchpadCapability = typeof CAPABILITIES[number];

const OBJECTIVE_HINT = '寫下這次工作的目標。';
const NOTE_HINT = '記下過程、來源與下一步。';
const FALLBACK_TITLE = '我的第一個工作';
/** SP-03 §2.3 cell text. A fullwidth semicolon splits title and objective. */
const STARTER_CELLS: Record<string, string> = {
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
function starterCopy(guildKey: string): Config['starter'] {
  const cell = STARTER_CELLS[guildKey];
  if (!cell) return {title_label: FALLBACK_TITLE, objective_hint: OBJECTIVE_HINT, note_hint: NOTE_HINT};
  const split = cell.indexOf('；');
  if (split === -1) return {title_label: cell, objective_hint: OBJECTIVE_HINT, note_hint: NOTE_HINT};
  return {title_label: cell.slice(0, split), objective_hint: cell.slice(split + 1), note_hint: NOTE_HINT};
}
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EXPIRY_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;

export type CatalogGuild = {guild_key: string; name: string; purpose: string};
export type ConfigProblem = {code: 'config_schema_unsupported'; revision: string} | null;
type StoredRevision = {
  config_id: string; revision: string; schema_version: string; body: unknown; body_sha256: string;
  status: 'draft' | 'published' | 'superseded'; source: 'platform_default' | 'guild_editor'; created_at: Date | string;
};

export function defaultConfigFor(guild: CatalogGuild, offered: readonly {application_key: string; release_ref: string}[] = []): Config {
  requireCondition(typeof guild.name === 'string' && typeof guild.purpose === 'string', 404, 'guild_not_found', '找不到這個公會。');
  const profile = LAUNCHPAD_PROFILES[guild.guild_key];
  const application_refs: Config['application_refs'] = [];
  for (const key of profile?.preferred_applications ?? []) {
    const release = offered.find(item => item.application_key === key);
    if (release) application_refs.push({application_key: release.application_key, release_ref: release.release_ref, order: application_refs.length});
  }
  return {
    schema_version: 'guild-launchpad.config/v1',
    guild_key: guild.guild_key,
    mission_override: null,
    blocks: (profile?.block_order ?? BLOCK_KINDS).map((kind, order) => ({id: kind, kind, order, enabled: true, title: null})),
    application_refs,
    starter: starterCopy(guild.guild_key),
    support: {kind: 'platform_help', public_url: null},
    extensions: {},
  };
}

export function platformDefaultView(guild: CatalogGuild, pointerVersion = DEFAULT_POINTER_VERSION, offered: readonly {application_key: string; release_ref: string}[] = []): ConfigView {
  const body = defaultConfigFor(guild, offered);
  return {config_id: null, revision: PLATFORM_DEFAULT_REVISION, pointer_version: pointerVersion, source: 'platform_default', status: 'published', body, body_sha256: digest(body), updated_at: null};
}

export function isUuid(value: string): boolean { return UUID_PATTERN.test(value); }

function fail(error: z.ZodError, prefix = ''): never {
  throw new ConfigValidationError(parseFieldErrors(error, prefix));
}
function parseInput<T>(schema: z.ZodType<T>, input: unknown, prefix = ''): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) fail(parsed.error, prefix);
  return parsed.data;
}
function configFrom(input: unknown, guildKey: string, prefix = ''): Config {
  try { return parseConfig(input, guildKey); }
  catch (error) {
    if (error instanceof ConfigValidationError && prefix) throw new ConfigValidationError(error.errors.map(item => ({code: item.code, path: item.path ? `${prefix}.${item.path}` : prefix})));
    throw error;
  }
}
function pgCode(error: unknown): string { return typeof error === 'object' && error !== null && 'code' in error ? String((error as {code: unknown}).code) : ''; }
async function assertRefs(q: PoolClient, guildKey: string, communityId: string, config: Config, prefix = '') {
  try { await assertOfferedApplications(q, guildKey, communityId, config.application_refs); }
  catch (error) {
    if (error instanceof ConfigValidationError && prefix) throw new ConfigValidationError(error.errors.map(item => ({code: item.code, path: item.path ? `${prefix}.${item.path}` : prefix})));
    throw error;
  }
}

export async function activeMember(q: PoolClient, actor: Actor) {
  requireCondition((await q.query('SELECT 1 FROM users WHERE user_id=$1 AND community_id=$2 AND active FOR SHARE', [actor.user_id, actor.community_id])).rowCount === 1, 401, 'session_expired', '請重新登入。');
  requireCondition((await q.query('SELECT 1 FROM sessions WHERE token_hash=$1 AND user_id=$2 AND revoked_at IS NULL AND expires_at>now() FOR SHARE', [actor.session_hash, actor.user_id])).rowCount === 1, 401, 'session_expired', '請重新登入。');
}
export async function loadCatalog(q: PoolClient, guildKey: string): Promise<CatalogGuild> {
  const row = (await q.query('SELECT guild_key, name, purpose FROM positioning_guild_catalog WHERE guild_key=$1', [guildKey])).rows[0];
  requireCondition(row, 404, 'guild_not_found', '找不到這個公會。');
  return row;
}
export async function requireGuildMember(q: PoolClient, actor: Actor, guildKey: string) {
  requireCondition((await q.query("SELECT 1 FROM positioning_profession_memberships WHERE community_id=$1 AND user_id=$2 AND guild_key=$3 AND state='active' FOR SHARE", [actor.community_id, actor.user_id, guildKey])).rowCount === 1, 403, 'guild_member_required', '加入公會後可閱讀公告。');
}
async function leaderRow(q: PoolClient, actor: Actor, guildKey: string) {
  return (await q.query(`SELECT 1 FROM positioning_guild_officers o
    JOIN positioning_profession_memberships m ON m.community_id=o.community_id AND m.guild_key=o.guild_key AND m.user_id=o.user_id AND m.state='active'
    WHERE o.community_id=$1 AND o.user_id=$2 AND o.guild_key=$3
    FOR SHARE OF m, o`, [actor.community_id, actor.user_id, guildKey])).rowCount === 1;
}
export async function requireLeader(q: PoolClient, actor: Actor, guildKey: string) {
  requireCondition(await leaderRow(q, actor, guildKey), 403, 'guild_leader_required', '此操作限目前在任的公會長。');
}
const DELEGATION_CAPABILITY_SQL = `SELECT d.capabilities FROM guild_launchpad_delegations d
  JOIN principals p ON p.principal_id=d.principal_id
  JOIN positioning_profession_memberships m ON m.community_id=d.community_id AND m.guild_key=d.guild_key AND m.user_id=p.user_ref AND m.state='active'
  WHERE d.community_id=$1 AND d.guild_key=$2 AND p.user_ref=$3 AND p.kind='person' AND p.status='active'
    AND d.status='active' AND d.expires_at>clock_timestamp()`;
async function delegationCapabilities(q: PoolClient, actor: Actor, guildKey: string, lock: boolean): Promise<string[]> {
  const sql = lock ? `${DELEGATION_CAPABILITY_SQL} FOR SHARE OF d, m` : DELEGATION_CAPABILITY_SQL;
  const row = (await q.query(sql, [actor.community_id, guildKey, actor.user_id])).rows[0];
  return Array.isArray(row?.capabilities) ? row.capabilities : [];
}
function delegationDenied(caps: string[], capability: LaunchpadCapability) {
  requireCondition(caps.includes(capability), 403, 'guild_leader_required', '此操作限目前在任的公會長。');
}
async function requireFreshDelegate(q: PoolClient, actor: Actor, guildKey: string, capability: LaunchpadCapability) {
  delegationDenied(await delegationCapabilities(q, actor, guildKey, true), capability);
}
/** A locking read is not rechecked after a wait when the blocker did not update the row. This is a later, non-waiting statement. */
async function assertDelegationDeadline(q: PoolClient, actor: Actor, guildKey: string, capability: LaunchpadCapability) {
  delegationDenied(await delegationCapabilities(q, actor, guildKey, false), capability);
}
type ViewerAccess = {leader: boolean; edit: boolean; preview: boolean; publish: boolean};
/** Leaders stay on the officer lock. A delegate must still hold a live view capability after the last wait. */
export async function assertDelegatedViewerDeadline(q: PoolClient, actor: Actor, guildKey: string, access: ViewerAccess) {
  if (access.leader || !(access.edit || access.preview || access.publish)) return;
  const caps = await delegationCapabilities(q, actor, guildKey, false);
  requireCondition(
    (access.edit && caps.includes('guild.content.edit'))
      || (access.preview && caps.includes('guild.config.preview'))
      || (access.publish && caps.includes('guild.config.publish')),
    403, 'guild_leader_required', '此操作限目前在任的公會長。');
}
/** A guild member can still read the published launchpad. Delegate flags cannot stay true after the deadline. */
export async function refreshDelegateAccess(q: PoolClient, actor: Actor, guildKey: string, access: ViewerAccess): Promise<ViewerAccess> {
  if (access.leader || !(access.edit || access.preview || access.publish)) return access;
  const caps = await delegationCapabilities(q, actor, guildKey, false);
  return {leader: false, edit: caps.includes('guild.content.edit'), preview: caps.includes('guild.config.preview'), publish: caps.includes('guild.config.publish')};
}
function delegateRevalidation(actor: Actor, guildKey: string, capability: LaunchpadCapability, delegated: () => boolean) {
  return async (q: PoolClient) => {
    if (!delegated()) return;
    await assertDelegationDeadline(q, actor, guildKey, capability);
  };
}
export async function viewerAccess(q: PoolClient, actor: Actor, guildKey: string): Promise<ViewerAccess> {
  const leader = await leaderRow(q, actor, guildKey);
  const caps = new Set(leader ? CAPABILITIES : await delegationCapabilities(q, actor, guildKey, true));
  return {
    leader,
    edit: caps.has('guild.content.edit'),
    preview: caps.has('guild.config.preview'),
    publish: caps.has('guild.config.publish'),
  };
}
export async function requireCapability(q: PoolClient, actor: Actor, guildKey: string, capability: LaunchpadCapability) {
  const access = await viewerAccess(q, actor, guildKey);
  const allowed = capability === 'guild.content.edit' ? access.edit : capability === 'guild.config.preview' ? access.preview : access.publish;
  requireCondition(allowed, 403, 'guild_leader_required', '此操作限目前在任的公會長。');
  return access;
}
async function ensurePrincipal(q: PoolClient, actor: Actor): Promise<string> {
  await q.query('INSERT INTO principals(user_ref) VALUES($1) ON CONFLICT (user_ref) DO NOTHING', [actor.user_id]);
  const row = (await q.query('SELECT principal_id, status, kind FROM principals WHERE user_ref=$1 FOR SHARE', [actor.user_id])).rows[0];
  requireCondition(row?.kind === 'person' && row.status === 'active', 403, 'principal_disabled', '這個會員身分目前不能編輯公會啟動台。');
  return row.principal_id as string;
}
async function lockGuild(q: PoolClient, communityId: string, guildKey: string) {
  await q.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`guild-launchpad/${communityId}/${guildKey}`]);
}
async function lockedPointer(q: PoolClient, communityId: string, guildKey: string) {
  return (await q.query('SELECT config_id, pointer_version::text AS pointer_version FROM guild_launchpad_config_pointers WHERE community_id=$1 AND guild_key=$2 FOR UPDATE', [communityId, guildKey])).rows[0] as {config_id: string; pointer_version: string} | undefined;
}
export async function readPointerVersion(q: PoolClient, communityId: string, guildKey: string): Promise<string> {
  const row = (await q.query('SELECT pointer_version::text AS pointer_version FROM guild_launchpad_config_pointers WHERE community_id=$1 AND guild_key=$2', [communityId, guildKey])).rows[0];
  return row?.pointer_version ?? DEFAULT_POINTER_VERSION;
}
async function nextRevision(q: PoolClient, communityId: string, guildKey: string): Promise<string> {
  const row = (await q.query('SELECT COALESCE(MAX(revision),0)::text AS revision FROM guild_launchpad_config_revisions WHERE community_id=$1 AND guild_key=$2', [communityId, guildKey])).rows[0];
  return (BigInt(row.revision) + 1n).toString();
}
function toView(row: StoredRevision, body: Config, pointerVersion: string): ConfigView {
  return {
    config_id: row.config_id, revision: String(row.revision), pointer_version: pointerVersion, source: row.source, status: row.status,
    body, body_sha256: row.body_sha256, updated_at: new Date(row.created_at).toISOString(),
  };
}
export function tryView(row: StoredRevision | undefined, guildKey: string, pointerVersion: string): ConfigView | null {
  if (!row) return null;
  try { return toView(row, parseConfig(row.body, guildKey), pointerVersion); }
  catch (error) { if (error instanceof ConfigValidationError) return null; throw error; }
}
async function insertRevision(q: PoolClient, row: {configId: string; communityId: string; guildKey: string; revision: string; body: Config; hash: string; status: 'draft' | 'published'; principalId: string; revertReason?: string; revertedFromRevision?: string}) {
  const inserted = (await q.query(`INSERT INTO guild_launchpad_config_revisions
    (config_id, community_id, guild_key, revision, schema_version, body, body_sha256, status, source, created_by_principal_id, revert_reason, reverted_from_revision)
    VALUES ($1,$2,$3,$4::bigint,$5,$6::jsonb,$7,$8,'guild_editor',$9,$10,$11::bigint)
    RETURNING config_id, revision::text AS revision, schema_version, body, body_sha256, status, source, created_at`,
  [row.configId, row.communityId, row.guildKey, row.revision, row.body.schema_version, JSON.stringify(row.body), row.hash, row.status, row.principalId, row.revertReason ?? null, row.revertedFromRevision ?? null])).rows[0];
  return inserted as StoredRevision;
}
async function movePointer(q: PoolClient, communityId: string, guildKey: string, configId: string, previous: {pointer_version: string} | undefined, moveConfig: boolean) {
  if (!previous) {
    await q.query('INSERT INTO guild_launchpad_config_pointers(community_id, guild_key, config_id, pointer_version) VALUES ($1,$2,$3,2)', [communityId, guildKey, configId]);
    return '2';
  }
  const updated = await q.query(`UPDATE guild_launchpad_config_pointers
    SET config_id=CASE WHEN $5::boolean THEN $3::uuid ELSE config_id END, pointer_version=pointer_version+1, updated_at=now()
    WHERE community_id=$1 AND guild_key=$2 AND pointer_version=$4::bigint
    RETURNING pointer_version::text AS pointer_version`, [communityId, guildKey, configId, previous.pointer_version, moveConfig]);
  requireCondition(updated.rowCount === 1, 412, 'version_conflict', '資料已更新，請重新整理後再操作。');
  return updated.rows[0].pointer_version as string;
}
async function supersedePublished(q: PoolClient, communityId: string, guildKey: string, exceptConfigId: string) {
  await q.query("UPDATE guild_launchpad_config_revisions SET status='superseded' WHERE community_id=$1 AND guild_key=$2 AND status='published' AND config_id<>$3", [communityId, guildKey, exceptConfigId]);
}
async function publishEvent(q: PoolClient, actor: Actor, guildKey: string, configId: string, revision: string) {
  await journal(q, actor, 'guild_launchpad_config', configId, revision, 'publish', {guild_key: guildKey, config_id: configId, revision}, PUBLISHED_EVENT);
}

const draftInput = z.object({body: z.unknown()}).strict();
const previewInput = z.object({body: z.unknown(), preview_mode: z.enum(['public', 'member', 'my_work'])}).strict();
const publishInput = z.object({expected_body_sha256: z.string()}).strict();
const revertInput = z.object({to_revision: z.string().regex(VERSION_PATTERN), reason: z.string().min(3).max(1000)}).strict();
const grantInput = z.object({
  principal_id: z.uuid(),
  capabilities: z.array(z.enum(CAPABILITIES)).min(1).max(3),
  expires_at: z.string(),
}).strict();
const revokeInput = z.object({reason: z.string().min(3).max(1000)}).strict();

export async function createDraft(pool: Pool, input: Command, guildKey: string) {
  const wrapped = parseInput(draftInput, input.body);
  let config: Config | null = null;
  let principalId = '';
  let delegated = false;
  const revalidate = delegateRevalidation(input.actor, guildKey, 'guild.content.edit', () => delegated);
  return command(pool, input, async q => {
    await activeMember(q, input.actor);
    await loadCatalog(q, guildKey);
    config = configFrom(wrapped.body, guildKey, 'body');
    await assertRefs(q, guildKey, input.actor.community_id, config, 'body');
    principalId = await ensurePrincipal(q, input.actor);
    delegated = !(await requireCapability(q, input.actor, guildKey, 'guild.content.edit')).leader;
  }, async q => {
    if (!config) throw new ConfigValidationError([{code: 'unknown_field', path: 'body'}]);
    const hash = digest(config);
    await lockGuild(q, input.actor.community_id, guildKey);
    const current = await lockedPointer(q, input.actor.community_id, guildKey);
    if (delegated) await requireFreshDelegate(q, input.actor, guildKey, 'guild.content.edit');
    checkVersion(current?.pointer_version ?? DEFAULT_POINTER_VERSION, input.expected);
    const revision = await nextRevision(q, input.actor.community_id, guildKey);
    const stored = await insertRevision(q, {configId: randomUUID(), communityId: input.actor.community_id, guildKey, revision, body: config, hash, status: 'draft', principalId});
    let move = true;
    if (current) {
      const target = (await q.query('SELECT status FROM guild_launchpad_config_revisions WHERE config_id=$1', [current.config_id])).rows[0];
      move = target?.status !== 'published';
    }
    const pointerVersion = await movePointer(q, input.actor.community_id, guildKey, stored.config_id, current, move);
    await revalidate(q);
    return toView(stored, config, pointerVersion);
  }, revalidate);
}

/** Preview validates and returns the submitted config. It does not read tenant work or write rows. */
export async function previewLaunchpad(pool: Pool, actor: Actor, guildKey: string, input: unknown) {
  return transaction(pool, async q => {
    await activeMember(q, actor);
    await loadCatalog(q, guildKey);
    const access = await requireCapability(q, actor, guildKey, 'guild.config.preview');
    const wrapped = parseInput(previewInput, input);
    const config = configFrom(wrapped.body, guildKey, 'body');
    await assertRefs(q, guildKey, actor.community_id, config, 'body');
    await assertCurrentSessionClock(q, actor);
    if (!access.leader) await assertDelegationDeadline(q, actor, guildKey, 'guild.config.preview');
    return {effective_config: config, validation: [] as {code: string; path: string}[], preview_data_origin: 'synthetic_fixture' as const};
  });
}

export async function publishLaunchpad(pool: Pool, input: Command, guildKey: string, configId: string) {
  requireCondition(isUuid(configId), 404, 'config_not_found', '找不到這份啟動台配置。');
  const body = parseInput(publishInput, input.body);
  requireCondition(/^[a-f0-9]{64}$/.test(body.expected_body_sha256), 422, 'invalid_body_sha256', '配置摘要須為 64 碼小寫十六進位。');
  let principalId = '';
  let delegated = false;
  const revalidate = delegateRevalidation(input.actor, guildKey, 'guild.config.publish', () => delegated);
  return command(pool, input, async q => {
    await activeMember(q, input.actor);
    await loadCatalog(q, guildKey);
    principalId = await ensurePrincipal(q, input.actor);
    delegated = !(await requireCapability(q, input.actor, guildKey, 'guild.config.publish')).leader;
  }, async q => {
    void principalId;
    await lockGuild(q, input.actor.community_id, guildKey);
    const current = await lockedPointer(q, input.actor.community_id, guildKey);
    if (delegated) await requireFreshDelegate(q, input.actor, guildKey, 'guild.config.publish');
    checkVersion(current?.pointer_version ?? DEFAULT_POINTER_VERSION, input.expected);
    const row = (await q.query(`SELECT config_id, revision::text AS revision, schema_version, body, body_sha256, status, source, created_at
      FROM guild_launchpad_config_revisions WHERE config_id=$1 AND community_id=$2 AND guild_key=$3 FOR UPDATE`, [configId, input.actor.community_id, guildKey])).rows[0] as StoredRevision | undefined;
    requireCondition(row, 404, 'config_not_found', '找不到這份啟動台配置。');
    requireCondition(row.status === 'draft', 409, 'config_not_draft', '只有草稿可以發布。');
    requireCondition(row.body_sha256 === body.expected_body_sha256, 412, 'version_conflict', '配置內容與預期摘要不一致。');
    const config = parseConfig(row.body, guildKey);
    await assertRefs(q, guildKey, input.actor.community_id, config);
    requireCondition(digest(config) === row.body_sha256, 412, 'version_conflict', '配置摘要與內容不一致。');
    await supersedePublished(q, input.actor.community_id, guildKey, row.config_id);
    const published = (await q.query("UPDATE guild_launchpad_config_revisions SET status='published' WHERE config_id=$1 AND status='draft' RETURNING config_id, revision::text AS revision, schema_version, body, body_sha256, status, source, created_at", [row.config_id])).rows[0] as StoredRevision;
    const pointerVersion = await movePointer(q, input.actor.community_id, guildKey, published.config_id, current, true);
    await publishEvent(q, input.actor, guildKey, published.config_id, published.revision);
    await revalidate(q);
    return toView(published, config, pointerVersion);
  }, revalidate);
}

export async function revertLaunchpad(pool: Pool, input: Command, guildKey: string) {
  if (input.body && typeof input.body === 'object' && 'to_revision' in input.body) assertStoredVersion((input.body as {to_revision?: unknown}).to_revision, 'to_revision');
  const body = parseInput(revertInput, input.body);
  reasonIssue(body.reason);
  let principalId = '';
  let delegated = false;
  const revalidate = delegateRevalidation(input.actor, guildKey, 'guild.config.publish', () => delegated);
  return command(pool, input, async q => {
    await activeMember(q, input.actor);
    await loadCatalog(q, guildKey);
    principalId = await ensurePrincipal(q, input.actor);
    delegated = !(await requireCapability(q, input.actor, guildKey, 'guild.config.publish')).leader;
  }, async q => {
    await lockGuild(q, input.actor.community_id, guildKey);
    const current = await lockedPointer(q, input.actor.community_id, guildKey);
    if (delegated) await requireFreshDelegate(q, input.actor, guildKey, 'guild.config.publish');
    checkVersion(current?.pointer_version ?? DEFAULT_POINTER_VERSION, input.expected);
    const prior = (await q.query(`SELECT config_id, revision::text AS revision, schema_version, body, body_sha256, status, source, created_at
      FROM guild_launchpad_config_revisions WHERE community_id=$1 AND guild_key=$2 AND revision=$3::bigint FOR SHARE`, [input.actor.community_id, guildKey, body.to_revision])).rows[0] as StoredRevision | undefined;
    requireCondition(prior, 404, 'config_revision_not_found', '找不到這個啟動台版本。');
    const config = parseConfig(prior.body, guildKey);
    await assertRefs(q, guildKey, input.actor.community_id, config);
    const hash = digest(config);
    const revision = await nextRevision(q, input.actor.community_id, guildKey);
    await supersedePublished(q, input.actor.community_id, guildKey, randomUUID());
    const stored = await insertRevision(q, {configId: randomUUID(), communityId: input.actor.community_id, guildKey, revision, body: config, hash, status: 'published', principalId, revertReason: body.reason, revertedFromRevision: prior.revision});
    const pointerVersion = await movePointer(q, input.actor.community_id, guildKey, stored.config_id, current, true);
    await publishEvent(q, input.actor, guildKey, stored.config_id, stored.revision);
    await revalidate(q);
    return toView(stored, config, pointerVersion);
  }, revalidate);
}

function reasonIssue(value: string) {
  if (/[\u0000-\u001F\u007F\u0080-\u009F]/.test(value)) throw new ConfigValidationError([{code: 'control_character', path: 'reason'}]);
  if (hasLoneSurrogate(value)) throw new ConfigValidationError([{code: 'lone_surrogate', path: 'reason'}]);
}

export async function grantDelegation(pool: Pool, input: Command, guildKey: string) {
  const body = parseInput(grantInput, input.body);
  if (new Set(body.capabilities).size !== body.capabilities.length) throw new ConfigValidationError([{code: 'capability_duplicate', path: 'capabilities'}]);
  requireCondition(EXPIRY_PATTERN.test(body.expires_at) && !Number.isNaN(Date.parse(body.expires_at)), 422, 'delegation_expiry_invalid', '授權到期時間必須是未來的時間。');
  let grantor = '';
  return command(pool, input, async q => {
    await activeMember(q, input.actor);
    await loadCatalog(q, guildKey);
    grantor = await ensurePrincipal(q, input.actor);
    await requireLeader(q, input.actor, guildKey);
  }, async q => {
    const future = (await q.query('SELECT $1::timestamptz > now() AS ok', [body.expires_at])).rows[0];
    requireCondition(future.ok === true, 422, 'delegation_expiry_invalid', '授權到期時間必須是未來的時間。');
    const recipient = (await q.query(`SELECT p.principal_id FROM principals p
      JOIN users u ON u.user_id=p.user_ref AND u.community_id=$2
      JOIN positioning_profession_memberships m ON m.community_id=$2 AND m.user_id=u.user_id AND m.guild_key=$3 AND m.state='active'
      WHERE p.principal_id=$1 AND p.kind='person' AND p.status='active' AND u.active
      FOR SHARE OF p, u, m`, [body.principal_id, input.actor.community_id, guildKey])).rows[0];
    requireCondition(recipient, 422, 'delegation_recipient_invalid', '授權對象必須是這個公會的有效成員。');
    const expired = await q.query(`UPDATE guild_launchpad_delegations
      SET status='expired', version=version+1
      WHERE community_id=$1 AND guild_key=$2 AND principal_id=$3 AND status='active' AND expires_at<=clock_timestamp()
      RETURNING delegation_id, version::text AS version`, [input.actor.community_id, guildKey, body.principal_id]);
    if ((expired.rowCount ?? 0) > 0) {
      const previous = expired.rows[0];
      await journal(q, input.actor, 'guild_launchpad_delegation', previous.delegation_id as string, previous.version as string, 'expire', {guild_key: guildKey, delegation_id: previous.delegation_id, status: 'expired'});
    } else {
      const live = await q.query(`SELECT 1 FROM guild_launchpad_delegations
        WHERE community_id=$1 AND guild_key=$2 AND principal_id=$3 AND status='active' FOR UPDATE`, [input.actor.community_id, guildKey, body.principal_id]);
      if ((live.rowCount ?? 0) > 0) throw new Problem(409, 'delegation_exists', '這位成員已有尚未撤銷的授權。');
    }
    const delegationId = randomUUID();
    try {
      await q.query(`INSERT INTO guild_launchpad_delegations
        (delegation_id, community_id, guild_key, principal_id, capabilities, granted_by_principal_id, expires_at, version, status)
        VALUES ($1,$2,$3,$4,$5,$6,$7::timestamptz,1,'active')`, [delegationId, input.actor.community_id, guildKey, body.principal_id, body.capabilities, grantor, body.expires_at]);
    } catch (error) {
      if (pgCode(error) === '23505') throw new Problem(409, 'delegation_exists', '這位成員已有尚未撤銷的授權。');
      throw error;
    }
    return {delegation_id: delegationId, principal_id: body.principal_id, capabilities: body.capabilities, expires_at: new Date(body.expires_at).toISOString(), status: 'active' as const, version: '1'};
  });
}

export async function revokeDelegation(pool: Pool, input: Command, guildKey: string, delegationId: string) {
  requireCondition(isUuid(delegationId), 404, 'delegation_not_found', '找不到這筆授權。');
  const body = parseInput(revokeInput, input.body);
  reasonIssue(body.reason);
  return command(pool, input, async q => {
    await activeMember(q, input.actor);
    await loadCatalog(q, guildKey);
    await ensurePrincipal(q, input.actor);
    await requireLeader(q, input.actor, guildKey);
  }, async q => {
    const row = (await q.query(`SELECT delegation_id, status, version::text AS version FROM guild_launchpad_delegations
      WHERE delegation_id=$1 AND community_id=$2 AND guild_key=$3 FOR UPDATE`, [delegationId, input.actor.community_id, guildKey])).rows[0];
    requireCondition(row, 404, 'delegation_not_found', '找不到這筆授權。');
    requireCondition(row.status === 'active', 409, 'delegation_revoked', '這筆授權已經撤銷。');
    checkVersion(row.version, input.expected);
    const updated = (await q.query(`UPDATE guild_launchpad_delegations
      SET status='revoked', version=version+1, revoked_at=now(), revoke_reason=$2
      WHERE delegation_id=$1 RETURNING delegation_id, status, version::text AS version`, [delegationId, body.reason])).rows[0];
    return {delegation_id: updated.delegation_id as string, status: 'revoked' as const, version: updated.version as string};
  });
}

export async function listDelegations(q: PoolClient, communityId: string, guildKey: string) {
  const rows = (await q.query(`SELECT d.delegation_id, d.principal_id, d.capabilities, d.expires_at, d.status, d.version::text AS version, u.display_name,
      (d.expires_at<=clock_timestamp()) AS expired
    FROM guild_launchpad_delegations d
    JOIN principals p ON p.principal_id=d.principal_id
    JOIN users u ON u.user_id=p.user_ref
    WHERE d.community_id=$1 AND d.guild_key=$2 AND d.status='active'
    ORDER BY d.created_at, d.delegation_id`, [communityId, guildKey])).rows;
  return rows.map(row => ({delegation_id: row.delegation_id as string, principal_id: row.principal_id as string, capabilities: row.capabilities as string[], expires_at: new Date(row.expires_at).toISOString(), expired: row.expired === true, status: 'active' as const, version: row.version as string, display_name: row.display_name as string}));
}
export async function listDelegationCandidates(q: PoolClient, communityId: string, guildKey: string) {
  const rows = (await q.query(`SELECT u.display_name, p.principal_id
    FROM positioning_profession_memberships m
    JOIN users u ON u.user_id=m.user_id AND u.community_id=m.community_id
    LEFT JOIN principals p ON p.user_ref=u.user_id AND p.kind='person' AND p.status='active'
    WHERE m.community_id=$1 AND m.guild_key=$2 AND m.state='active' AND u.active
      AND NOT is_verification_test_account(u.user_id)
    ORDER BY u.display_name, u.user_id`, [communityId, guildKey])).rows;
  return rows.map(row => ({display_name: row.display_name as string, principal_id: (row.principal_id as string | null) ?? null}));
}
export async function listRevisionMeta(q: PoolClient, communityId: string, guildKey: string) {
  const rows = (await q.query(`SELECT revision::text AS revision, status, source, created_at, revert_reason, reverted_from_revision::text AS reverted_from_revision
    FROM guild_launchpad_config_revisions WHERE community_id=$1 AND guild_key=$2
    ORDER BY revision DESC LIMIT 50`, [communityId, guildKey])).rows;
  return rows.map(row => ({
    revision: row.revision as string,
    status: row.status as string,
    source: row.source as string,
    created_at: new Date(row.created_at).toISOString(),
    revert_reason: (row.revert_reason as string | null) ?? null,
    reverted_from_revision: (row.reverted_from_revision as string | null) ?? null,
  }));
}
export async function readStoredRevision(q: PoolClient, communityId: string, guildKey: string, revision?: string): Promise<StoredRevision | undefined> {
  if (revision) {
    return (await q.query(`SELECT config_id, revision::text AS revision, schema_version, body, body_sha256, status, source, created_at
      FROM guild_launchpad_config_revisions WHERE community_id=$1 AND guild_key=$2 AND revision=$3::bigint`, [communityId, guildKey, revision])).rows[0];
  }
  return (await q.query(`SELECT config_id, revision::text AS revision, schema_version, body, body_sha256, status, source, created_at
    FROM guild_launchpad_config_revisions WHERE community_id=$1 AND guild_key=$2 AND status='draft'
    ORDER BY revision DESC LIMIT 1`, [communityId, guildKey])).rows[0];
}
export async function readPublishedRevision(q: PoolClient, communityId: string, guildKey: string): Promise<StoredRevision | undefined> {
  return (await q.query(`SELECT config_id, revision::text AS revision, schema_version, body, body_sha256, status, source, created_at
    FROM guild_launchpad_config_revisions WHERE community_id=$1 AND guild_key=$2 AND status='published'`, [communityId, guildKey])).rows[0];
}
const EARLIER_REVISION_LIMIT = 20;
export async function resolvePublishedView(q: PoolClient, guild: CatalogGuild, communityId: string, pointerVersion: string): Promise<{view: ConfigView; problem: ConfigProblem}> {
  const current = await readPublishedRevision(q, communityId, guild.guild_key);
  if (!current) return {view: platformDefaultView(guild, pointerVersion, await availableReleases(q, guild.guild_key, communityId)), problem: null};
  const parsed = tryView(current, guild.guild_key, pointerVersion);
  if (parsed) return {view: parsed, problem: null};
  const problem: ConfigProblem = {code: 'config_schema_unsupported', revision: String(current.revision)};
  const earlier = (await q.query(`SELECT config_id, revision::text AS revision, schema_version, body, body_sha256, status, source, created_at
    FROM guild_launchpad_config_revisions
    WHERE community_id=$1 AND guild_key=$2 AND status IN ('published','superseded') AND revision < $3::bigint
    ORDER BY revision DESC LIMIT $4`, [communityId, guild.guild_key, current.revision, EARLIER_REVISION_LIMIT])).rows as StoredRevision[];
  for (const row of earlier) {
    const view = tryView(row, guild.guild_key, pointerVersion);
    if (view) return {view, problem};
  }
  return {view: platformDefaultView(guild, pointerVersion, await availableReleases(q, guild.guild_key, communityId)), problem};
}
export async function readSolePublicRevision(q: PoolClient, guildKey: string): Promise<(StoredRevision & {community_id: string}) | undefined> {
  const rows = (await q.query(`SELECT config_id, revision::text AS revision, schema_version, body, body_sha256, status, source, created_at, community_id
    FROM guild_launchpad_config_revisions WHERE guild_key=$1 AND status='published'`, [guildKey])).rows as (StoredRevision & {community_id: string})[];
  return rows.length === 1 ? rows[0] : undefined;
}
