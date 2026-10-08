import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { OpaqueId } from '../../contracts/common/v1/identity.js';
import {
  ApplicationPageSchema, ApplicationReleaseViewSchema, ApplicationViewSchema, EligibilitySchema,
  type ApplicationView, type Eligibility,
} from '../../contracts/guild-launchpad/v1/module-registry.js';
import { assertCurrentSessionClock } from '../../packages/db/member-session.js';
import { bindPrincipalContext, bindTenantContext, clearTenantContext, isolatedTransaction } from '../../packages/resource-scopes/tenant-transaction.js';
import type { Actor } from '../identity-membership/service.js';
import { Problem, requireCondition } from '../../packages/shared/problem.js';
import { ConfigValidationError } from '../../contracts/guild-launchpad/v1/config.js';
import { assertProviderCapabilities } from './validate.js';

export interface CatalogQuery {
  guildKey?: string;
  communityId?: string;
  cursor?: string;
  limit?: number;
}

interface OfferingRow {
  offering_id: string;
  application_key: string;
  release_ref: string;
  display_name: string;
  module_requirements: unknown;
  runtime_profiles: unknown;
  launch_policy_ref: { policy_key: string; version: string };
  license_state: ApplicationView['license_state'];
  release_status: ApplicationView['release_status'];
  version: string;
  source_commit: string;
  artifact_digest: { algorithm: 'sha256'; value: string };
  skill_book_refs: string[];
  license_review_ref: string | null;
  customization_schema_ref: string;
  entry_capability: string;
  display_order: number;
  platform: boolean;
  offering_policy: { policy_key: string; version: string };
}

function eligibilityView(full: boolean, manages: boolean, policy: boolean, installed: boolean, policyRevision: string): Eligibility {
  const reason = !full ? 'guild_full_member_required' : !manages ? 'tenant_manage_required' : !policy ? 'policy_unconfigured' : null;
  const tenantAction = !full ? 'denied' : !manages ? 'create' : !policy ? 'denied' : installed ? 'continue' : 'select';
  return EligibilitySchema.parse({
    can_launch: full && manages && policy,
    reason_codes: reason ? [reason] : [],
    required_guild_tier: 'full',
    tenant_action: tenantAction,
    policy_revision: policyRevision,
  });
}

function encodeCursor(platform: boolean, order: number, id: string, filter: string) {
  return Buffer.from(JSON.stringify({ filter, platform: platform ? 0 : 1, order, id })).toString('base64url');
}

function decodeCursor(raw: string | undefined, filter: string): { platform: number; order: number; id: string } | null {
  if (!raw) return null;
  let parsed: Record<string, unknown>;
  try {
    const bytes = Buffer.from(raw, 'base64url');
    if (bytes.toString('base64url') !== raw) throw new Error('Invalid base64url');
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Problem(422, 'invalid_cursor', '分頁游標無效。');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
    || Object.keys(parsed).sort().join(',') !== 'filter,id,order,platform'
    || parsed.filter !== filter
    || (parsed.platform !== 0 && parsed.platform !== 1)
    || typeof parsed.order !== 'number' || !Number.isInteger(parsed.order) || parsed.order < 0 || parsed.order > 2147483647
    || !OpaqueId.safeParse(parsed.id).success) {
    throw new Problem(422, 'invalid_cursor', '分頁游標無效。');
  }
  return { platform: parsed.platform, order: parsed.order, id: parsed.id as string };
}

const SELECT_OFFERING = `SELECT o.offering_id, d.application_key, d.release_ref, d.display_name, d.module_requirements,
  d.runtime_profiles, d.launch_policy_ref, d.license_state, d.release_status, d.version::text AS version,
  d.source_commit, d.artifact_digest, d.skill_book_refs, d.license_review_ref, d.customization_schema_ref,
  d.entry_capability, o.display_order, (o.community_id IS NULL) AS platform, o.launch_policy_ref AS offering_policy`;

export async function assertGuildKey(q: PoolClient, guildKey: string) {
  const found = await q.query('SELECT guild_key FROM positioning_guild_catalog WHERE guild_key=$1', [guildKey]);
  requireCondition(found.rowCount === 1, 404, 'guild_not_found', '找不到這個公會。');
}

export async function listApplications(q: PoolClient, query: CatalogQuery) {
  if (query.guildKey) await assertGuildKey(q, query.guildKey);
  const limit = query.limit ?? 20;
  const filter = createHash('sha256').update(JSON.stringify({ list: 'applications', guild_key: query.guildKey ?? null,
    community_id: query.guildKey && query.communityId ? query.communityId : null })).digest('hex');
  const cursor = decodeCursor(query.cursor, filter);
  const params: unknown[] = [];
  let guildParam = '';
  if (query.guildKey) {
    params.push(query.guildKey);
    guildParam = `$${params.length}`;
  }
  let communityParam = '';
  if (query.guildKey && query.communityId) {
    params.push(query.communityId);
    communityParam = `$${params.length}`;
  }
  const where = query.guildKey
    ? communityParam
      ? `((o.community_id IS NULL AND o.guild_key IS NULL) OR (o.community_id=${communityParam} AND (o.guild_key IS NULL OR o.guild_key=${guildParam})))`
      : `((o.community_id IS NULL AND o.guild_key IS NULL) OR o.guild_key=${guildParam})`
    : `(o.community_id IS NULL AND o.guild_key IS NULL)`;
  const scopeParams = [...params];
  params.push(cursor?.platform ?? null, cursor?.order ?? null, cursor?.id ?? null, limit + 1);
  const base = params.length;
  const rows = (await q.query<OfferingRow>(
    `${SELECT_OFFERING}
     FROM guild_application_offerings o
     JOIN application_definitions d ON d.application_key=o.application_key AND d.release_ref=o.release_ref
     WHERE o.status='offered' AND d.release_status='available' AND d.license_state='reviewed' AND ${where}
       AND ($${base - 3}::int IS NULL OR ((CASE WHEN o.community_id IS NULL THEN 0 ELSE 1 END), o.display_order, o.offering_id)
            > ($${base - 3}::int, $${base - 2}::int, $${base - 1}::uuid))
     ORDER BY (o.community_id IS NOT NULL), o.display_order, o.offering_id
     LIMIT $${base}`,
    params,
  )).rows;
  const page = rows.slice(0, limit);
  const source = (await q.query<{ v: string | null }>(
    `SELECT max(o.version)::text AS v FROM guild_application_offerings o WHERE ${where}`,
    scopeParams,
  )).rows[0].v;
  return {
    items: page.map(row => applicationView(row)),
    next_cursor: rows.length > limit ? encodeCursor(page[page.length - 1].platform, page[page.length - 1].display_order, page[page.length - 1].offering_id, filter) : null,
    source_version: source && source !== '0' ? source : '1',
  };
}

/** The pin stays in stored JSON. The public requirement schema does not carry it. */
function publishedRequirements(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return value.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
    const copy = { ...(item as Record<string, unknown>) };
    delete copy.module_release_ref;
    return copy;
  });
}

export function applicationView(row: OfferingRow, eligibility?: Eligibility): ApplicationView {
  return ApplicationViewSchema.parse({
    application_key: row.application_key,
    release_ref: row.release_ref,
    display_name: row.display_name,
    module_requirements: publishedRequirements(row.module_requirements),
    runtime_profiles: row.runtime_profiles,
    launch_policy_ref: row.launch_policy_ref,
    license_state: row.license_state,
    release_status: row.release_status,
    version: row.version,
    ...(eligibility ? { eligibility } : {}),
  });
}

export async function loadRelease(q: PoolClient, applicationKey: string, releaseRef: string) {
  const row = (await q.query<OfferingRow>(
    `SELECT d.application_key, d.release_ref, d.display_name, d.module_requirements, d.runtime_profiles,
       d.launch_policy_ref, d.license_state, d.release_status, d.version::text AS version, d.source_commit,
       d.artifact_digest, d.skill_book_refs, d.license_review_ref, d.customization_schema_ref, d.entry_capability,
       0 AS display_order, NULL::uuid AS offering_id, true AS platform
     FROM application_definitions d WHERE d.application_key=$1 AND d.release_ref=$2
       AND d.release_status='available' AND d.license_state='reviewed'
       AND EXISTS (
         SELECT 1 FROM guild_application_offerings o
         WHERE o.application_key=d.application_key AND o.release_ref=d.release_ref AND o.status='offered'
       )`,
    [applicationKey, releaseRef],
  )).rows[0];
  requireCondition(row, 404, 'not_found', '找不到這個應用版本。');
  return ApplicationReleaseViewSchema.parse({
    ...applicationView(row),
    source_commit: row.source_commit,
    artifact_digest: row.artifact_digest,
    skill_book_refs: row.skill_book_refs,
    license_review_ref: row.license_review_ref,
  });
}

export interface DefinitionRow extends OfferingRow {
  offering_status: string;
  offering_policy: { policy_key: string; version: string };
}

export async function loadOfferedDefinition(q: PoolClient, guildKey: string, applicationKey: string, releaseRef: string, communityId: string): Promise<DefinitionRow> {
  const row = (await q.query<DefinitionRow>(
    `SELECT d.application_key, d.release_ref, d.display_name, d.module_requirements, d.runtime_profiles,
       d.launch_policy_ref, d.license_state, d.release_status, d.version::text AS version, d.source_commit,
       d.artifact_digest, d.skill_book_refs, d.license_review_ref, d.customization_schema_ref, d.entry_capability,
       o.display_order, o.offering_id, (o.community_id IS NULL) AS platform, o.status AS offering_status,
       o.launch_policy_ref AS offering_policy
     FROM application_definitions d
     JOIN guild_application_offerings o ON o.application_key=d.application_key AND o.release_ref=d.release_ref
     WHERE d.application_key=$2 AND d.release_ref=$3 AND o.status='offered'
       AND ((o.community_id IS NULL AND o.guild_key IS NULL) OR (o.community_id=$4 AND (o.guild_key IS NULL OR o.guild_key=$1)))
     ORDER BY o.community_id NULLS LAST
     LIMIT 1`,
    [guildKey, applicationKey, releaseRef, communityId],
  )).rows[0];
  requireCondition(row, 409, 'application_not_available', '這個應用目前無法啟動。');
  if (row.license_state !== 'reviewed') throw new Problem(409, 'license_unresolved', '這個應用的授權尚未完成審查。');
  requireCondition(row.release_status === 'available', 409, 'application_not_available', '這個應用目前無法啟動。');
  const requirements = row.module_requirements;
  if (!Array.isArray(requirements)) throw new Problem(409, 'application_not_available', '這個應用目前無法啟動。');
  assertProviderCapabilities(requirements as { capabilities?: readonly unknown[] }[]);
  return row;
}

/** Each stored ref must be an offered available reviewed release for this guild or the platform default. */
export async function assertOfferedApplications(q: PoolClient, guildKey: string, communityId: string, refs: readonly { application_key: string; release_ref: string }[]) {
  if (refs.length === 0) return;
  const errors: { code: string; path: string }[] = [];
  for (const [index, ref] of refs.entries()) {
    const row = (await q.query<{ license_state: string; release_status: string }>(
      `SELECT d.license_state, d.release_status
       FROM guild_application_offerings o
       JOIN application_definitions d ON d.application_key=o.application_key AND d.release_ref=o.release_ref
       WHERE o.status='offered' AND d.application_key=$2 AND d.release_ref=$3
         AND d.release_status='available' AND d.license_state='reviewed'
         AND ((o.community_id IS NULL AND o.guild_key IS NULL) OR (o.community_id=$4 AND (o.guild_key IS NULL OR o.guild_key=$1)))
       LIMIT 1`,
      [guildKey, ref.application_key, ref.release_ref, communityId],
    )).rows[0];
    if (!row) errors.push({ code: 'application_release_unknown', path: `application_refs.${index}.release_ref` });
  }
  if (errors.length) throw new ConfigValidationError(errors);
}

export async function availableReleaseRefs(q: PoolClient, guildKey: string, communityId: string | null): Promise<Set<string>> {
  const rows = (await q.query<{ release_ref: string }>(
    `SELECT d.release_ref FROM guild_application_offerings o
     JOIN application_definitions d ON d.application_key=o.application_key AND d.release_ref=o.release_ref
     WHERE o.status='offered' AND d.release_status='available' AND d.license_state='reviewed'
       AND ((o.community_id IS NULL AND o.guild_key IS NULL) OR (o.community_id=$2 AND (o.guild_key IS NULL OR o.guild_key=$1)))`,
    [guildKey, communityId],
  )).rows;
  return new Set(rows.map(row => row.release_ref));
}

async function personPrincipalId(q: PoolClient, userId: string): Promise<string | null> {
  const row = (await q.query<{ principal_id: string }>(
    `SELECT principal_id FROM principals WHERE user_ref=$1 AND kind='person'`,
    [userId],
  )).rows[0];
  return row?.principal_id ?? null;
}

/** Principal policies show every managed tenant only while T is clear. */
async function bindPrincipalOnly(q: PoolClient, principalId: string): Promise<void> {
  await clearTenantContext(q);
  await bindPrincipalContext(q, principalId);
}

async function managedTenantIds(q: PoolClient, principalId: string): Promise<string[]> {
  return (await q.query<{ tenant_id: string }>(
    `SELECT t.tenant_id
     FROM tenant_memberships m
     JOIN tenants t ON t.tenant_id=m.tenant_id
     WHERE m.principal_id=$1 AND m.status='active' AND m.role IN ('owner','admin') AND t.status='active'
     ORDER BY t.tenant_id`,
    [principalId],
  )).rows.map(row => row.tenant_id);
}

/** One tenant at a time. A missing scope stays unbound so that tenant's rows stay hidden. */
async function bindOneManagedTenant(q: PoolClient, principalId: string, tenantId: string): Promise<boolean> {
  const scope = (await q.query<{ scope_id: string }>(
    `SELECT scope_id FROM resource_scopes WHERE kind='tenant' AND tenant_ref=$1`,
    [tenantId],
  )).rows[0];
  await bindPrincipalOnly(q, principalId);
  if (!scope) return false;
  await bindTenantContext(q, { tenantId, tenantScopeId: scope.scope_id });
  return true;
}

/**
 * Principal-context eligibility. The caller may manage several tenants, and one
 * transaction binds one tenant at a time. Installations and tenant policies are
 * invisible until that tenant is bound.
 */
export async function eligibilityFor(q: PoolClient, actor: Actor, guildKey: string, applicationKey: string, releaseRef: string, policyRevision: string): Promise<Eligibility> {
  const principalId = await personPrincipalId(q, actor.user_id);
  if (principalId) await bindPrincipalOnly(q, principalId);
  const row = (await q.query<{ full_member: boolean; manages: boolean; policy: boolean; installed: boolean }>(
    `WITH me AS (
       SELECT principal_id FROM principals WHERE user_ref=$1 AND kind='person'
     ), full_member AS (
       SELECT 1 FROM positioning_profession_memberships
       WHERE community_id=$2 AND user_id=$1 AND guild_key=$3 AND state='active' AND member_tier='full'
     ), managed AS (
       SELECT t.tenant_id
       FROM tenant_memberships m
       JOIN tenants t ON t.tenant_id=m.tenant_id
       JOIN me ON me.principal_id=m.principal_id
       WHERE m.status='active' AND m.role IN ('owner','admin') AND t.status='active'
     ), policy_ok AS (
       SELECT 1 FROM managed
       WHERE EXISTS (
         SELECT 1 FROM tenant_capacity_policies p
         WHERE p.status='active' AND (p.tenant_id=managed.tenant_id OR p.tenant_id IS NULL))
     ), installed AS (
       SELECT 1 FROM application_installations i
       JOIN managed ON managed.tenant_id=i.tenant_id
       WHERE i.application_key=$4 AND i.release_ref=$5 AND i.status NOT IN ('archived','failed')
     )
     SELECT EXISTS(SELECT 1 FROM full_member) AS full_member,
            EXISTS(SELECT 1 FROM managed) AS manages,
            EXISTS(SELECT 1 FROM policy_ok) AS policy,
            EXISTS(SELECT 1 FROM installed) AS installed`,
    [actor.user_id, actor.community_id, guildKey, applicationKey, releaseRef],
  )).rows[0];
  const full = row.full_member === true;
  const manages = row.manages === true;
  let policy = row.policy === true;
  let installed = row.installed === true;
  if (principalId && manages && (!policy || !installed)) {
    for (const tenantId of await managedTenantIds(q, principalId)) {
      if (policy && installed) break;
      if (!await bindOneManagedTenant(q, principalId, tenantId)) continue;
      if (!policy) {
        const configured = await q.query(
          `SELECT 1 FROM tenant_capacity_policies
           WHERE status='active' AND (tenant_id=$1 OR tenant_id IS NULL) LIMIT 1`,
          [tenantId],
        );
        if (configured.rowCount === 1) policy = true;
      }
      if (!installed) {
        const present = await q.query(
          `SELECT 1 FROM application_installations
           WHERE tenant_id=$1 AND application_key=$2 AND release_ref=$3
             AND status NOT IN ('archived','failed') LIMIT 1`,
          [tenantId, applicationKey, releaseRef],
        );
        if (present.rowCount === 1) installed = true;
      }
    }
    await bindPrincipalOnly(q, principalId);
  }
  const eligibility = eligibilityView(full, manages, policy, installed, policyRevision);
  await assertCurrentSessionClock(q, actor);
  return eligibility;
}

/** Public catalog. Offerings have no tenant_id. Eligibility binds the principal, then one managed tenant at a time. */
export async function browseApplications(pool: Pool, query: CatalogQuery, actor: Actor | null) {
  return isolatedTransaction(pool, async q => {
    const page = await listApplications(q, { ...query, communityId: actor?.community_id });
    if (!actor || !query.guildKey) return ApplicationPageSchema.parse(page);
    const items = [];
    for (const item of page.items) {
      const policy = (await q.query<{ version: string }>(
        `SELECT o.launch_policy_ref->>'version' AS version
         FROM guild_application_offerings o
         WHERE o.release_ref=$1 AND o.application_key=$4 AND o.status='offered'
           AND ((o.community_id IS NULL AND o.guild_key IS NULL) OR (o.community_id=$3 AND (o.guild_key IS NULL OR o.guild_key=$2)))
         ORDER BY o.community_id NULLS LAST
         LIMIT 1`,
        [item.release_ref, query.guildKey, actor.community_id, item.application_key],
      )).rows[0];
      items.push({
        ...item,
        eligibility: await eligibilityFor(q, actor, query.guildKey, item.application_key, item.release_ref, policy?.version ?? item.launch_policy_ref.version),
      });
    }
    await assertCurrentSessionClock(q, actor);
    return ApplicationPageSchema.parse({ ...page, items });
  });
}

export async function readPublicRelease(pool: Pool, applicationKey: string, releaseRef: string) {
  return isolatedTransaction(pool, q => loadRelease(q, applicationKey, releaseRef));
}

export async function applicationsForGuild(q: PoolClient, actor: Actor, guildKey: string) {
  await assertGuildKey(q, guildKey);
  const principalId = await personPrincipalId(q, actor.user_id);
  if (principalId) await bindPrincipalOnly(q, principalId);
  const rows = (await q.query<OfferingRow>(
    `${SELECT_OFFERING}
     FROM guild_application_offerings o
     JOIN application_definitions d ON d.application_key=o.application_key AND d.release_ref=o.release_ref
     WHERE o.status='offered' AND d.release_status='available' AND d.license_state='reviewed'
       AND ((o.community_id IS NULL AND o.guild_key IS NULL) OR (o.community_id=$2 AND (o.guild_key IS NULL OR o.guild_key=$1)))
     ORDER BY (o.community_id IS NOT NULL), o.display_order, o.offering_id`,
    [guildKey, actor.community_id],
  )).rows;
  const facts = (await q.query<{ full_member: boolean; manages: boolean; policy: boolean; installed: string[] }>(
    `WITH me AS (
       SELECT principal_id FROM principals WHERE user_ref=$1 AND kind='person'
     ), managed AS (
       SELECT t.tenant_id FROM tenant_memberships m
       JOIN tenants t ON t.tenant_id=m.tenant_id
       JOIN me ON me.principal_id=m.principal_id
       WHERE m.status='active' AND m.role IN ('owner','admin') AND t.status='active'
     )
     SELECT EXISTS (
         SELECT 1 FROM positioning_profession_memberships
         WHERE community_id=$2 AND user_id=$1 AND guild_key=$3 AND state='active' AND member_tier='full'
       ) AS full_member,
       EXISTS (SELECT 1 FROM managed) AS manages,
       EXISTS (
         SELECT 1 FROM managed
         WHERE EXISTS (
           SELECT 1 FROM tenant_capacity_policies p
           WHERE p.status='active' AND (p.tenant_id=managed.tenant_id OR p.tenant_id IS NULL))
       ) AS policy,
       COALESCE((
         SELECT array_agg(DISTINCT i.application_key || '|' || i.release_ref)
         FROM application_installations i JOIN managed ON managed.tenant_id=i.tenant_id
         WHERE i.status NOT IN ('archived','failed')
       ), ARRAY[]::text[]) AS installed`,
    [actor.user_id, actor.community_id, guildKey],
  )).rows[0];
  const full = facts.full_member === true;
  const manages = facts.manages === true;
  let policy = facts.policy === true;
  const installedKeys = new Set(facts.installed ?? []);
  if (principalId && manages && (!policy || installedKeys.size === 0)) {
    for (const tenantId of await managedTenantIds(q, principalId)) {
      if (!await bindOneManagedTenant(q, principalId, tenantId)) continue;
      if (!policy) {
        const configured = await q.query(
          `SELECT 1 FROM tenant_capacity_policies
           WHERE status='active' AND (tenant_id=$1 OR tenant_id IS NULL) LIMIT 1`,
          [tenantId],
        );
        if (configured.rowCount === 1) policy = true;
      }
      const present = (await q.query<{ key: string }>(
        `SELECT DISTINCT application_key || '|' || release_ref AS key
         FROM application_installations
         WHERE tenant_id=$1 AND status NOT IN ('archived','failed')`,
        [tenantId],
      )).rows;
      for (const row of present) installedKeys.add(row.key);
    }
  }
  if (principalId) await clearTenantContext(q);
  await assertCurrentSessionClock(q, actor);
  return rows.map(row => {
    const installed = installedKeys.has(`${row.application_key}|${row.release_ref}`);
    return {
      application_key: row.application_key,
      release_ref: row.release_ref,
      eligibility: eligibilityView(full, manages, policy, installed, row.offering_policy.version),
    };
  });
}
