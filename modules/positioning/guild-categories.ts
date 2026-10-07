import {randomUUID} from 'node:crypto';
import type {Pool, PoolClient} from 'pg';
import {command, journal, checkVersion, transaction, type Command} from '../../packages/db/index.js';
import {Problem, requireCondition} from '../../packages/shared/problem.js';
import type {Actor} from '../identity-membership/service.js';
import {guildTitles} from './assessment.js';
import {
  BackfillReport, CATEGORY_LABELS, CATEGORY_ORDER, ClassificationInput, DISPLAY_PRECEDENCE, SECTION_LABELS, SetPreferenceInput,
} from '../../contracts/guild-launchpad/v1/guild-preferences.js';

type Queryable = Pick<Pool | PoolClient, 'query'>;
type MemberRef = Pick<Actor, 'community_id' | 'user_id'>;
export type GuildCategoryName = typeof CATEGORY_ORDER[number];
type SlotMap = Record<GuildCategoryName, string | null>;
type BlockReason = 'unknown_category' | 'left_primary' | 'inactive_guild' | 'invalid_secondary';

const emptySlots = (): SlotMap => ({internal: null, external: null, professional_industry: null});
const versionText = (value: unknown) => value == null ? null : String(value);
const journalActor = (communityId: string, userId: string): Actor => ({
  community_id: communityId, user_id: userId, email: '', display_name: '', profession_membership_ref: '', session_hash: '', csrf_token: '',
});

const catalogFence = 'guild-catalog-revision';
export async function lockGuildCatalog(q: PoolClient) {
  await q.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, [catalogFence]);
}
export async function lockGuildCatalogShared(q: PoolClient) {
  await q.query(`SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))`, [catalogFence]);
}
async function lockMember(q: PoolClient, member: MemberRef) {
  await q.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, [`guild-member/${member.community_id}/${member.user_id}`]);
}
export async function communitySwitched(q: Queryable, communityId: string) {
  return (await q.query(`SELECT 1 FROM guild_preference_switch WHERE community_id=$1 AND state='switched'`, [communityId])).rowCount === 1;
}

function effectiveSecondary(row: {primary_guild_key: string | null; secondary_guild_keys: string[] | null; active_guild_keys: string[]}) {
  const active = new Set(row.active_guild_keys ?? []);
  const source = row.secondary_guild_keys ?? row.active_guild_keys ?? [];
  return [...new Set(source)].filter(key => key !== row.primary_guild_key && active.has(key)).slice(0, 2);
}
function secondaryInvalid(row: {primary_guild_key: string | null; secondary_guild_keys: unknown; active_guild_keys: string[]}) {
  const raw = row.secondary_guild_keys;
  if (raw == null) return false;
  if (!Array.isArray(raw)) return true;
  if (raw.length > 2 || new Set(raw).size !== raw.length) return true;
  const active = new Set(row.active_guild_keys ?? []);
  return raw.some(key => typeof key !== 'string' || key === row.primary_guild_key || !active.has(key));
}

type LegacyRow = {
  user_id: string;
  primary_guild_key: string | null;
  secondary_guild_keys: string[] | null;
  legacy_version: string | null;
  primary_state: string | null;
  category: string | null;
  category_review: string | null;
  catalog_active: boolean | null;
  active_guild_keys: string[];
  has_legacy: boolean;
};
type MemberPlan = {
  user_id: string;
  slots: SlotMap;
  reason: BlockReason | null;
  old_category: GuildCategoryName | null;
  legacy_primary: string | null;
  legacy_secondary: unknown;
  legacy_version: string | null;
  effective_secondary: string[];
};

function planMember(row: LegacyRow): MemberPlan {
  const slots = emptySlots();
  const effective = row.has_legacy ? effectiveSecondary({
    primary_guild_key: row.primary_guild_key,
    secondary_guild_keys: row.secondary_guild_keys,
    active_guild_keys: row.active_guild_keys ?? [],
  }) : [];
  let reason: BlockReason | null = null;
  let category: GuildCategoryName | null = null;
  if (row.has_legacy) {
    const approved = row.category_review === 'approved' && !!row.category;
    category = approved ? row.category as GuildCategoryName : null;
    if (row.primary_state !== 'active') reason = 'left_primary';
    else if (!approved) reason = 'unknown_category';
    else if (row.catalog_active !== true) reason = 'inactive_guild';
    else if (secondaryInvalid(row)) reason = 'invalid_secondary';
    else if (category) slots[category] = row.primary_guild_key;
  }
  const oldCategory = reason && category ? category : null;
  return {
    user_id: row.user_id, slots, reason, old_category: oldCategory,
    legacy_primary: row.has_legacy ? row.primary_guild_key : null,
    legacy_secondary: row.has_legacy ? row.secondary_guild_keys : null,
    legacy_version: row.has_legacy ? versionText(row.legacy_version) : null,
    effective_secondary: effective,
  };
}

const candidateSql = `SELECT u.user_id, p.user_id IS NOT NULL AS has_legacy, p.primary_guild_key, p.secondary_guild_keys,
  p.aggregate_version AS legacy_version, m.state AS primary_state, c.category::text AS category,
  c.category_review::text AS category_review, c.active AS catalog_active,
  ARRAY(SELECT mm.guild_key FROM positioning_profession_memberships mm
    WHERE mm.community_id=u.community_id AND mm.user_id=u.user_id AND mm.state='active' ORDER BY mm.guild_key) AS active_guild_keys
  FROM users u
  LEFT JOIN guild_preference_sets s ON s.community_id=u.community_id AND s.user_id=u.user_id
  LEFT JOIN guild_member_preferences p ON p.community_id=u.community_id AND p.user_id=u.user_id
  LEFT JOIN positioning_profession_memberships m ON m.community_id=u.community_id AND m.user_id=u.user_id AND m.guild_key=p.primary_guild_key
  LEFT JOIN guild_catalog_categories c ON c.guild_key=p.primary_guild_key
  WHERE u.community_id=$1 AND (s.user_id IS NULL OR s.migration_state='legacy')
    AND (p.user_id IS NOT NULL OR EXISTS (
      SELECT 1 FROM positioning_profession_memberships any_m WHERE any_m.community_id=u.community_id AND any_m.user_id=u.user_id))
  `;

async function loadLegacy(q: Queryable, member: MemberRef): Promise<LegacyRow | null> {
  const row = (await q.query(`SELECT $3::uuid AS user_id, true AS has_legacy, p.primary_guild_key, p.secondary_guild_keys,
    p.aggregate_version AS legacy_version, m.state AS primary_state, c.category::text AS category,
    c.category_review::text AS category_review, c.active AS catalog_active,
    ARRAY(SELECT mm.guild_key FROM positioning_profession_memberships mm
      WHERE mm.community_id=$1 AND mm.user_id=$2 AND mm.state='active' ORDER BY mm.guild_key) AS active_guild_keys
    FROM guild_member_preferences p
    LEFT JOIN positioning_profession_memberships m ON m.community_id=p.community_id AND m.user_id=p.user_id AND m.guild_key=p.primary_guild_key
    LEFT JOIN guild_catalog_categories c ON c.guild_key=p.primary_guild_key
    WHERE p.community_id=$1 AND p.user_id=$2`, [member.community_id, member.user_id, member.user_id])).rows[0];
  return row ?? null;
}

async function slotsMatch(q: Queryable, member: MemberRef, slots: SlotMap) {
  const rows = (await q.query(`SELECT category::text AS category, guild_key FROM guild_category_preferences WHERE community_id=$1 AND user_id=$2`, [member.community_id, member.user_id])).rows as {category: string; guild_key: string}[];
  if (rows.length !== CATEGORY_ORDER.filter(category => slots[category]).length) return false;
  return rows.every(row => slots[row.category as GuildCategoryName] === row.guild_key);
}
async function auditExists(q: Queryable, member: MemberRef, plan: MemberPlan) {
  const hit = await q.query(`SELECT 1 FROM guild_preference_migration_audit
    WHERE community_id=$1 AND user_id=$2
      AND legacy_primary IS NOT DISTINCT FROM $3
      AND legacy_secondary IS NOT DISTINCT FROM $4::jsonb
      AND legacy_version IS NOT DISTINCT FROM $5::bigint
      AND new_snapshot IS NOT DISTINCT FROM $6::jsonb
      AND invalidation_reason IS NOT DISTINCT FROM $7 LIMIT 1`, [
    member.community_id, member.user_id, plan.legacy_primary,
    plan.legacy_secondary == null ? null : JSON.stringify(plan.legacy_secondary),
    plan.legacy_version, JSON.stringify(plan.slots), plan.reason ? 'legacy_ambiguous' : null,
  ]);
  return hit.rowCount === 1;
}

function storedMigrationState(plan: MemberPlan, creatingState: 'backfilled' | 'switched') {
  // A block reason is not a finished mapping. `legacy` stays in the candidate set until a later clean plan moves it to `backfilled`.
  return plan.reason ? 'legacy' as const : creatingState;
}
async function writeProjection(q: PoolClient, member: MemberRef, plan: MemberPlan, runId: string, creatingState: 'backfilled' | 'switched') {
  const storedState = storedMigrationState(plan, creatingState);
  const existing = (await q.query(`SELECT aggregate_version, migration_state FROM guild_preference_sets WHERE community_id=$1 AND user_id=$2 FOR UPDATE`, [member.community_id, member.user_id])).rows[0] as {aggregate_version: string | number; migration_state: string} | undefined;
  if (existing && await slotsMatch(q, member, plan.slots) && await auditExists(q, member, plan)) {
    if (existing.migration_state !== 'switched' && existing.migration_state !== storedState) {
      await q.query(`UPDATE guild_preference_sets SET migration_state=$3::guild_preference_migration_state, updated_at=now() WHERE community_id=$1 AND user_id=$2`, [member.community_id, member.user_id, storedState]);
    }
    return versionText(existing.aggregate_version)!;
  }
  const saved = existing
    ? (await q.query(`UPDATE guild_preference_sets SET aggregate_version=aggregate_version+1, migrated_from_version=$3,
        migration_state=CASE WHEN migration_state='switched' THEN 'switched' ELSE $4::guild_preference_migration_state END, updated_at=now()
        WHERE community_id=$1 AND user_id=$2 RETURNING aggregate_version::text AS aggregate_version`,
      [member.community_id, member.user_id, plan.legacy_version, storedState])).rows[0]
    : (await q.query(`INSERT INTO guild_preference_sets(community_id,user_id,aggregate_version,migration_state,migrated_from_version)
        VALUES ($1,$2,1,$3,$4) RETURNING aggregate_version::text AS aggregate_version`,
      [member.community_id, member.user_id, storedState, plan.legacy_version])).rows[0];
  const version = String(saved.aggregate_version);
  await q.query(`DELETE FROM guild_category_preferences WHERE community_id=$1 AND user_id=$2`, [member.community_id, member.user_id]);
  for (const category of CATEGORY_ORDER) {
    const guildKey = plan.slots[category];
    if (!guildKey) continue;
    await q.query(`INSERT INTO guild_category_preferences(community_id,user_id,category,guild_key) VALUES ($1,$2,$3::guild_category,$4)`, [member.community_id, member.user_id, category, guildKey]);
  }
  if (plan.reason) {
    await q.query(`INSERT INTO guild_preference_invalidations(community_id,user_id,guild_key,old_category,reason,old_version,new_version)
      VALUES ($1,$2,$3,$4::guild_category,'legacy_ambiguous',$5,$6)`, [
      member.community_id, member.user_id, plan.legacy_primary, plan.old_category, existing ? existing.aggregate_version : 0, version,
    ]);
  }
  await q.query(`INSERT INTO guild_preference_migration_audit(audit_id,run_id,community_id,user_id,legacy_primary,legacy_secondary,effective_secondary,legacy_version,new_snapshot,invalidation_reason)
    SELECT $1,$2,$3,$4,$5,$6::jsonb,$7::text[],$8::bigint,$9::jsonb,$10
    WHERE NOT EXISTS (SELECT 1 FROM guild_preference_migration_audit a
      WHERE a.community_id=$3 AND a.user_id=$4
        AND a.legacy_primary IS NOT DISTINCT FROM $5
        AND a.legacy_secondary IS NOT DISTINCT FROM $6::jsonb
        AND a.legacy_version IS NOT DISTINCT FROM $8::bigint
        AND a.new_snapshot IS NOT DISTINCT FROM $9::jsonb
        AND a.invalidation_reason IS NOT DISTINCT FROM $10)`, [
    randomUUID(), runId, member.community_id, member.user_id, plan.legacy_primary,
    plan.legacy_secondary == null ? null : JSON.stringify(plan.legacy_secondary),
    plan.effective_secondary, plan.legacy_version, JSON.stringify(plan.slots), plan.reason ? 'legacy_ambiguous' : null,
  ]);
  return version;
}

export async function recomputeLegacyProjection(q: PoolClient, member: MemberRef, runId = randomUUID()) {
  const legacy = await loadLegacy(q, member);
  if (!legacy) return;
  await writeProjection(q, member, planMember(legacy), runId, 'backfilled');
}

async function preferenceEvent(q: PoolClient, member: MemberRef, version: string, category: GuildCategoryName, guildKey: string | null, reason: string) {
  await journal(q, journalActor(member.community_id, member.user_id), 'guild_preference', member.user_id, version, reason, {
    community_id: member.community_id, user_id: member.user_id, aggregate_version: version, changed_category: category, guild_key: guildKey, reason,
  }, 'freedom.guild.preference.changed.v1');
}

async function bumpSet(q: PoolClient, member: MemberRef) {
  const row = (await q.query(`UPDATE guild_preference_sets SET aggregate_version=aggregate_version+1, updated_at=now()
    WHERE community_id=$1 AND user_id=$2 RETURNING aggregate_version::text AS aggregate_version`, [member.community_id, member.user_id])).rows[0];
  requireCondition(row, 503, 'preference_mapping_unavailable', '偏好對照尚未建立。');
  return String(row.aggregate_version);
}

export async function ensureRegisteredPreferenceSet(q: PoolClient, communityId: string, userId: string) {
  await lockGuildCatalogShared(q);
  const switched = await communitySwitched(q, communityId);
  // Registration has no legacy primary. The empty set starts reconciled; a later old write recomputes it and can return an ambiguous plan to `legacy`.
  await q.query(`INSERT INTO guild_preference_sets(community_id,user_id,aggregate_version,migration_state) VALUES ($1,$2,1,$3)
    ON CONFLICT DO NOTHING`, [communityId, userId, switched ? 'switched' : 'backfilled']);
}
export async function ensureProjectionSet(q: PoolClient, member: MemberRef) {
  const switched = await communitySwitched(q, member.community_id);
  await q.query(`INSERT INTO guild_preference_sets(community_id,user_id,aggregate_version,migration_state) VALUES ($1,$2,1,$3)
    ON CONFLICT DO NOTHING`, [member.community_id, member.user_id, switched ? 'switched' : 'backfilled']);
}

export async function assertLegacyPreferenceWritable(q: Queryable, communityId: string) {
  requireCondition(!(await communitySwitched(q, communityId)), 409, 'client_upgrade_required', '請改用三類主力設定。');
}

export async function projectOnboardingGuild(q: PoolClient, actor: Actor, guildKey: string) {
  if (!(await communitySwitched(q, actor.community_id))) {
    await recomputeLegacyProjection(q, actor);
    return;
  }
  await ensureProjectionSet(q, actor);
  const classification = (await q.query(`SELECT category::text AS category, category_review::text AS category_review, active
    FROM guild_catalog_categories WHERE guild_key=$1`, [guildKey])).rows[0];
  const membership = (await q.query(`SELECT state FROM positioning_profession_memberships WHERE community_id=$1 AND user_id=$2 AND guild_key=$3`, [actor.community_id, actor.user_id, guildKey])).rows[0];
  if (classification?.category_review === 'approved' && classification.active === true && classification.category && membership?.state === 'active') {
    await replaceSlot(q, actor, classification.category as GuildCategoryName, guildKey, 'member_selected');
  }
}

async function replaceSlot(q: PoolClient, member: MemberRef, category: GuildCategoryName, guildKey: string | null, reason: string, invalidatedGuild: string | null = null) {
  const prior = (await q.query(`SELECT aggregate_version FROM guild_preference_sets WHERE community_id=$1 AND user_id=$2`, [member.community_id, member.user_id])).rows[0];
  const version = await bumpSet(q, member);
  await q.query(`DELETE FROM guild_category_preferences WHERE community_id=$1 AND user_id=$2 AND (category=$3::guild_category OR guild_key=$4)`, [member.community_id, member.user_id, category, guildKey]);
  if (guildKey) await q.query(`INSERT INTO guild_category_preferences(community_id,user_id,category,guild_key) VALUES ($1,$2,$3::guild_category,$4)`, [member.community_id, member.user_id, category, guildKey]);
  if (reason === 'membership_left' || reason === 'guild_recategorized') {
    await q.query(`INSERT INTO guild_preference_invalidations(community_id,user_id,guild_key,old_category,reason,old_version,new_version)
      VALUES ($1,$2,$3,$4::guild_category,$5::guild_preference_invalidation_reason,$6,$7)`, [
      member.community_id, member.user_id, invalidatedGuild, category, reason, prior?.aggregate_version ?? 0, version,
    ]);
  }
  await preferenceEvent(q, member, version, category, guildKey, reason);
  return version;
}

export async function categorySlotForGuild(q: Queryable, member: MemberRef, guildKey: string) {
  const row = (await q.query(`SELECT category::text AS category, guild_key FROM guild_category_preferences
    WHERE community_id=$1 AND user_id=$2 AND guild_key=$3`, [member.community_id, member.user_id, guildKey])).rows[0];
  return row ? {category: row.category as GuildCategoryName, guild_key: row.guild_key as string} : null;
}
export async function clearCategorySlot(q: PoolClient, member: MemberRef, category: GuildCategoryName, previousGuild: string, reason: 'member_cleared' | 'membership_left' | 'guild_recategorized') {
  return replaceSlot(q, member, category, null, reason, reason === 'member_cleared' ? null : previousGuild);
}

async function lockedSet(q: PoolClient, member: MemberRef) {
  return (await q.query(`SELECT aggregate_version::text AS aggregate_version, migration_state FROM guild_preference_sets
    WHERE community_id=$1 AND user_id=$2 FOR UPDATE`, [member.community_id, member.user_id])).rows[0] as {aggregate_version: string; migration_state: string} | undefined;
}

export async function getPreferenceView(q: Queryable, member: MemberRef) {
  const set = (await q.query(`SELECT aggregate_version::text AS aggregate_version, migration_state FROM guild_preference_sets
    WHERE community_id=$1 AND user_id=$2`, [member.community_id, member.user_id])).rows[0];
  requireCondition(set, 503, 'preference_mapping_unavailable', '偏好對照尚未建立。');
  const slotRows = (await q.query(`SELECT category::text AS category, guild_key FROM guild_category_preferences WHERE community_id=$1 AND user_id=$2`, [member.community_id, member.user_id])).rows as {category: string; guild_key: string}[];
  const slots = emptySlots();
  for (const row of slotRows) slots[row.category as GuildCategoryName] = row.guild_key;
  const invalidated = (await q.query(`SELECT DISTINCT ON (old_category) guild_key, old_category::text AS category, reason::text AS reason
    FROM guild_preference_invalidations
    WHERE community_id=$1 AND user_id=$2 AND old_category IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM guild_category_preferences p WHERE p.community_id=$1 AND p.user_id=$2 AND p.category=old_category)
    ORDER BY old_category, created_at DESC`, [member.community_id, member.user_id])).rows as {guild_key: string; category: string; reason: string}[];
  const legacy = await loadLegacy(q, member);
  return {
    aggregate_version: String(set.aggregate_version),
    primaries: CATEGORY_ORDER.map(category => ({category, guild_key: slots[category]})),
    invalidated: CATEGORY_ORDER.filter(category => invalidated.some(item => item.category === category)).map(category => {
      const item = invalidated.find(row => row.category === category)!;
      return {guild_key: item.guild_key, category, reason: item.reason};
    }),
    migration_state: set.migration_state as 'legacy' | 'backfilled' | 'switched',
    legacy: legacy ? {primary_guild_key: legacy.primary_guild_key, secondary_guild_keys: effectiveSecondary({
      primary_guild_key: legacy.primary_guild_key, secondary_guild_keys: legacy.secondary_guild_keys, active_guild_keys: legacy.active_guild_keys ?? [],
    })} : null,
  };
}

export async function setCategoryPreference(pool: Pool, input: Command) {
  const body = SetPreferenceInput.parse(input.body);
  return command(pool, input, async () => {}, async q => {
    await lockGuildCatalogShared(q);
    await lockMember(q, input.actor);
    requireCondition(await communitySwitched(q, input.actor.community_id), 409, 'preference_switch_pending', '社群尚未切換到三類主力。');
    const set = await lockedSet(q, input.actor);
    requireCondition(set, 503, 'preference_mapping_unavailable', '偏好對照尚未建立。');
    checkVersion(String(set.aggregate_version), input.expected);
    if (body.guild_key) {
      requireCondition((await q.query(`SELECT 1 FROM positioning_guild_catalog WHERE guild_key=$1`, [body.guild_key])).rowCount === 1, 404, 'guild_not_found', '找不到這個公會。');
      const classification = (await q.query(`SELECT category::text AS category, category_review::text AS category_review, active, catalog_revision::text AS catalog_revision
        FROM guild_catalog_categories WHERE guild_key=$1`, [body.guild_key])).rows[0];
      if (!classification) throw new Problem(409, 'guild_category_unresolved', '這個公會的分類尚未確定，不能設為本類主力。');
      requireCondition(String(classification.catalog_revision) === body.catalog_revision, 409, 'catalog_revision_changed', '這個公會的分類版本已更新，請重新載入。');
      requireCondition(classification.active === true, 409, 'guild_inactive', '這個公會目前未啟用。');
      requireCondition(classification.category_review === 'approved' && classification.category === body.category, 409, 'guild_category_unresolved', '這個公會的分類尚未確定，不能設為本類主力。');
      const membership = (await q.query(`SELECT state FROM positioning_profession_memberships WHERE community_id=$1 AND user_id=$2 AND guild_key=$3`, [input.actor.community_id, input.actor.user_id, body.guild_key])).rows[0];
      requireCondition(membership?.state === 'active', 409, 'active_guild_required', '請先加入這個公會，再設為本類主力。');
      await replaceSlot(q, input.actor, body.category, body.guild_key, 'member_selected');
    } else {
      await replaceSlot(q, input.actor, body.category, null, 'member_cleared');
    }
    return getPreferenceView(q, input.actor);
  });
}

export async function listGuildCategories(q: Queryable) {
  const rows = (await q.query(`SELECT g.guild_key, g.name, COALESCE(g.alias,'') AS alias, COALESCE(g.profession_title,'') AS profession_title,
    c.category::text AS category, COALESCE(c.category_review::text, 'pending') AS category_review,
    COALESCE(c.capability_tags, '{}') AS capability_tags, COALESCE(c.active, true) AS active, c.catalog_revision::text AS catalog_revision
    FROM positioning_guild_catalog g LEFT JOIN guild_catalog_categories c USING (guild_key) ORDER BY g.guild_key`)).rows as Array<{
      guild_key: string; name: string; alias: string; profession_title: string; category: string | null;
      category_review: string; capability_tags: string[]; active: boolean; catalog_revision: string | null;
    }>;
  const max = (await q.query(`SELECT max(catalog_revision)::text AS catalog_revision FROM guild_catalog_categories`)).rows[0]?.catalog_revision;
  const item = (row: typeof rows[number]) => ({
    guild_key: row.guild_key, name: row.name, alias: row.alias, profession_title: row.profession_title,
    category: row.category, category_review: row.category_review, capability_tags: row.capability_tags ?? [],
    active: row.active, catalog_revision: row.catalog_revision,
  });
  return {
    catalog_revision: max ?? '1',
    categories: CATEGORY_ORDER.map(category => ({
      category, label: CATEGORY_LABELS[category], section: SECTION_LABELS[category],
      items: rows.filter(row => row.category_review === 'approved' && row.category === category).map(item),
    })),
    pending: rows.filter(row => row.category_review !== 'approved' || !row.category).map(item),
  };
}

export async function seedPendingClassification(q: PoolClient, guildKey: string) {
  await lockGuildCatalog(q);
  await q.query(`INSERT INTO guild_catalog_categories(guild_key, category, category_review, catalog_revision, capability_tags, active)
    VALUES ($1, NULL, 'pending', nextval('guild_catalog_revision'), '{}', true) ON CONFLICT (guild_key) DO NOTHING`, [guildKey]);
}

function limitOf(value: number | undefined) {
  const limit = value ?? 100;
  requireCondition(Number.isInteger(limit) && limit >= 1 && limit <= 500, 422, 'validation_failed', '一次最多對照 500 位會員。');
  return limit;
}
async function candidates(q: Queryable, communityId: string) {
  return (await q.query(`${candidateSql} ORDER BY u.user_id`, [communityId])).rows as LegacyRow[];
}
async function projectionReconciled(q: Queryable, member: MemberRef) {
  const row = (await q.query(`SELECT migration_state FROM guild_preference_sets WHERE community_id=$1 AND user_id=$2`, [member.community_id, member.user_id])).rows[0] as {migration_state: string} | undefined;
  return !!row && row.migration_state !== 'legacy';
}
function blockedMembersOf(plans: MemberPlan[], limit: number) {
  return plans.filter(plan => plan.reason).slice(0, limit).map(plan => ({user_id: plan.user_id, reason: plan.reason!}));
}
export async function backfillInTransaction(q: PoolClient, options: {communityId: string; limit?: number; dryRun?: boolean; runId?: string}) {
  await lockGuildCatalog(q);
  const dryRun = options.dryRun !== false;
  const limit = limitOf(options.limit);
  const rows = await candidates(q, options.communityId);
  const plans = rows.map(planMember);
  const blockedAll = plans.filter(plan => plan.reason);
  const page = plans.slice(0, limit);
  if (dryRun) return BackfillReport.parse({
    dry_run: true,
    processed: page.length,
    mapped: page.filter(plan => !plan.reason && CATEGORY_ORDER.some(category => plan.slots[category])).length,
    blocked: blockedAll.length,
    ambiguous: blockedAll.length,
    remaining: rows.length,
    remaining_blocked: blockedAll.length,
    blocked_members: blockedMembersOf(plans, limit),
  });
  const runId = options.runId ?? randomUUID();
  let processed = 0, mapped = 0;
  const flipped: {user_id: string; reason: BlockReason}[] = [];
  for (const initial of plans.filter(plan => !plan.reason).slice(0, limit)) {
    const member = {community_id: options.communityId, user_id: initial.user_id};
    await lockMember(q, member);
    if (await projectionReconciled(q, member)) continue;
    const fresh = (await q.query(`${candidateSql} AND u.user_id=$2`, [options.communityId, initial.user_id])).rows[0] as LegacyRow | undefined;
    if (!fresh) continue;
    const plan = planMember(fresh);
    if (plan.reason) {
      flipped.push({user_id: plan.user_id, reason: plan.reason});
      continue;
    }
    await writeProjection(q, member, plan, runId, 'backfilled');
    processed += 1;
    if (CATEGORY_ORDER.some(category => plan.slots[category])) mapped += 1;
  }
  const blockedMembers = page.filter(plan => plan.reason).map(plan => ({user_id: plan.user_id, reason: plan.reason!}));
  for (const item of flipped) {
    if (!blockedMembers.some(member => member.user_id === item.user_id)) blockedMembers.push(item);
  }
  const left = (await candidates(q, options.communityId)).map(planMember);
  return BackfillReport.parse({
    dry_run: false, processed, mapped, blocked: blockedMembers.length, ambiguous: blockedMembers.length,
    remaining: left.length, remaining_blocked: left.filter(plan => plan.reason).length, blocked_members: blockedMembers,
  });
}
export function backfillGuildPreferences(pool: Pool, options: {communityId: string; limit?: number; dryRun?: boolean}) {
  return transaction(pool, q => backfillInTransaction(q, options));
}

export async function switchInTransaction(q: PoolClient, options: {communityId: string; acceptBlocked: boolean; switchedBy: string | null}) {
  await lockGuildCatalog(q);
  await q.query(`INSERT INTO guild_preference_switch(community_id, state, aggregate_version) VALUES ($1, 'legacy', 1) ON CONFLICT DO NOTHING`, [options.communityId]);
  const current = (await q.query(`SELECT state, aggregate_version::text AS aggregate_version FROM guild_preference_switch WHERE community_id=$1 FOR UPDATE`, [options.communityId])).rows[0];
  if (current.state === 'switched') return {state: 'switched' as const, aggregate_version: String(current.aggregate_version), blocked: 0, processed: 0, already_switched: true};
  const rows = await candidates(q, options.communityId);
  const ready: {member: MemberRef; plan: MemberPlan}[] = [];
  for (const row of rows) {
    const member = {community_id: options.communityId, user_id: row.user_id};
    await lockMember(q, member);
    if (await projectionReconciled(q, member)) continue;
    const fresh = (await q.query(`${candidateSql} AND u.user_id=$2`, [options.communityId, row.user_id])).rows[0] as LegacyRow | undefined;
    if (!fresh) continue;
    ready.push({member, plan: planMember(fresh)});
  }
  const blocked = ready.filter(item => item.plan.reason);
  requireCondition(blocked.length === 0 || options.acceptBlocked, 409, 'preference_switch_blocked', `還有 ${blocked.length} 位會員無法對照，請確認後再切換。`);
  const runId = randomUUID();
  for (const item of ready) await writeProjection(q, item.member, item.plan, runId, 'backfilled');
  await q.query(`UPDATE guild_preference_sets SET migration_state='switched', aggregate_version=aggregate_version+1, updated_at=now() WHERE community_id=$1`, [options.communityId]);
  if (blocked.length) {
    await q.query(`UPDATE guild_preference_invalidations i SET new_version = s.aggregate_version
      FROM guild_preference_sets s
      WHERE i.community_id = s.community_id AND i.user_id = s.user_id
        AND i.community_id = $1 AND i.user_id = ANY($2::uuid[]) AND i.reason = 'legacy_ambiguous'`,
      [options.communityId, blocked.map(item => item.member.user_id)]);
  }
  const switched = (await q.query(`UPDATE guild_preference_switch SET state='switched', aggregate_version=aggregate_version+1, switched_at=now(), switched_by=$2
    WHERE community_id=$1 RETURNING aggregate_version::text AS aggregate_version`, [options.communityId, options.switchedBy])).rows[0];
  return {state: 'switched' as const, aggregate_version: String(switched.aggregate_version), blocked: blocked.length, processed: ready.length, already_switched: false};
}

export async function classifyInTransaction(q: PoolClient, admin: {admin_id: string; community_id: string; email: string}, guildKey: string, raw: unknown, expected?: string) {
  const body = ClassificationInput.parse(raw);
  const actor = (await q.query(`SELECT user_id FROM users WHERE community_id=$1 AND lower(email)=lower($2) AND active LIMIT 1`, [admin.community_id, admin.email])).rows[0];
  if (!actor) throw new Problem(403, 'guild_classification_denied', '分類需要以同社群的會員帳號留下事件紀錄，請先確認管理員信箱有對應的會員帳號。');
  await lockGuildCatalog(q);
  requireCondition((await q.query(`SELECT 1 FROM positioning_guild_catalog WHERE guild_key=$1`, [guildKey])).rowCount === 1, 404, 'guild_not_found', '找不到這個公會。');
  const current = (await q.query(`SELECT guild_key, category::text AS category, category_review::text AS category_review, capability_tags, active,
    catalog_revision::text AS catalog_revision, classification_id FROM guild_catalog_categories WHERE guild_key=$1 FOR UPDATE`, [guildKey])).rows[0];
  if (!current) throw new Problem(409, 'guild_category_unresolved', '這個公會還沒有分類資料，無法核對版本。');
  checkVersion(String(current.catalog_revision), expected);
  const operationId = randomUUID();
  if (current.category !== body.category) {
    const holders = (await q.query(`SELECT community_id, user_id, category::text AS category FROM guild_category_preferences WHERE guild_key=$1 ORDER BY user_id, community_id`, [guildKey])).rows as {community_id: string; user_id: string; category: string}[];
    for (const holder of holders) {
      const member = {community_id: holder.community_id, user_id: holder.user_id};
      await lockMember(q, member);
      const still = await categorySlotForGuild(q, member, guildKey);
      if (still) await clearCategorySlot(q, member, still.category, guildKey, 'guild_recategorized');
    }
  }
  const updated = (await q.query(`UPDATE guild_catalog_categories SET category=$2::guild_category, category_review='approved', capability_tags=$3,
    catalog_revision=nextval('guild_catalog_revision'), reviewed_by_principal_id=$4, reviewed_at=now()
    WHERE guild_key=$1 RETURNING category::text AS category, category_review::text AS category_review, capability_tags, active, catalog_revision::text AS catalog_revision, classification_id`,
    [guildKey, body.category, body.capability_tags, admin.admin_id])).rows[0];
  const classification = {
    guild_key: guildKey, category: updated.category as GuildCategoryName, category_review: 'approved' as const,
    capability_tags: updated.capability_tags as string[], active: updated.active === true, catalog_revision: String(updated.catalog_revision),
  };
  await journal(q, journalActor(admin.community_id, actor.user_id), 'guild_classification', updated.classification_id, classification.catalog_revision, 'classify_guild', {
    guild_key: guildKey, category: classification.category, category_review: classification.category_review,
    capability_tags: classification.capability_tags, active: classification.active, catalog_revision: classification.catalog_revision,
  }, 'freedom.guild.classification.changed.v1');
  return {
    classification, invalidation_operation_id: operationId,
    before: {category: current.category, category_review: current.category_review, capability_tags: current.capability_tags, active: current.active === true, catalog_revision: String(current.catalog_revision)},
  };
}

function professionTitle(guild: {guild_key: string; profession_title?: string | null}) {
  return guildTitles[guild.guild_key] ?? ((/^guild_custom_[0-9A-Fa-f]{32}$/.test(guild.guild_key) && guild.profession_title) ? guild.profession_title : '專業探索者');
}
export async function switchedPositioningCard(q: Queryable, communityId: string, userId: string) {
  if (!(await communitySwitched(q, communityId))) return null;
  const memberships = (await q.query(`SELECT g.guild_key, g.name, g.alias, g.profession_title, m.joined_at
    FROM positioning_profession_memberships m JOIN positioning_guild_catalog g USING (guild_key)
    WHERE m.community_id=$1 AND m.user_id=$2 AND m.state='active' ORDER BY g.guild_key`, [communityId, userId])).rows as Array<{guild_key: string; name: string; alias: string; profession_title: string; joined_at: string}>;
  const chosen = (await q.query(`SELECT category::text AS category, guild_key FROM guild_category_preferences WHERE community_id=$1 AND user_id=$2`, [communityId, userId])).rows as {category: string; guild_key: string}[];
  const byKey = new Map(memberships.map(row => [row.guild_key, row]));
  const select = (guild: typeof memberships[number]) => ({guild_key: guild.guild_key, name: guild.name, alias: guild.alias ?? '', joined_at: new Date(guild.joined_at).toISOString()});
  const categoryPrimaries = CATEGORY_ORDER.map(category => {
    const slot = chosen.find(row => row.category === category);
    const guild = slot ? byKey.get(slot.guild_key) : undefined;
    return {category, label: CATEGORY_LABELS[category], guild: guild ? select(guild) : null};
  });
  const display = DISPLAY_PRECEDENCE.map(category => categoryPrimaries.find(item => item.category === category)?.guild).find(Boolean) ?? null;
  const displayRow = display ? byKey.get(display.guild_key) : undefined;
  const primaryKeys = new Set(categoryPrimaries.flatMap(item => item.guild ? [item.guild.guild_key] : []));
  return {
    positioning_title: displayRow ? professionTitle(displayRow) : null,
    primary_guild: display,
    secondary_guilds: [] as {guild_key: string; name: string; alias: string; joined_at: string}[],
    joined_guilds: memberships.filter(row => !primaryKeys.has(row.guild_key)).map(select),
    category_primaries: categoryPrimaries,
  };
}
