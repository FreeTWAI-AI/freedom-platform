import { randomUUID, createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { StoreSetupInputSchema, StoreUpdateInputSchema, StoreViewSchema, type StoreView } from '../../../contracts/guild-launchpad/v1/storefront.js';
import { MyStoresPageSchema } from '../../../contracts/guild-launchpad/v1/storefront-pagination.js';
import type { StoreTemplate } from '../../../contracts/guild-launchpad/v1/storefront-presentation.js';
import { checkVersion } from '../../../packages/db/index.js';
import { assertCurrentSessionClock, lockMemberSession } from '../../../packages/db/member-session.js';
import { mapPersonPrincipal, withTenantRead, lockTenantScope, type TenantScopeContext } from '../../../packages/resource-scopes/index.js';
import { isolatedTransaction, bindPrincipalContext, clearTenantContext } from '../../../packages/resource-scopes/tenant-transaction.js';
import { scopedJournal, scopedTenantCommand } from '../../../packages/scoped-commands/index.js';
import { Problem, requireCondition } from '../../../packages/shared/problem.js';
import type { Actor } from '../../identity-membership/service.js';
import { effectiveStoreCapabilities, requireStoreInstance, storeCapabilities, STORE_MISSING } from './capabilities.js';
import { encodeCursor, readCursor } from '../../tenant-workspaces/facts.js';

export const SLUG_PATTERN = /^[a-z][a-z0-9-]{1,38}[a-z0-9]$/;
const reserved = new Set('admin api app apps assets auth billing cart checkout dashboard default freedom freetwai guild guilds help home login logout me new official order orders pay payment platform preview root search services settings shop shops signup static store stores support system test www'.split(' '));
export const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
export interface Instance { instance_id: string; status: string; deployment_state: string | null }
export interface Profile {
  instance_id: string; tenant_id: string; supply_shop_id: string; storefront_shop_id: string; slug: string; brand: string | null;
  version: string; product_seq: number; first_published_at: Date | null; current_publication_id: string | null;
  name: string; description: string; currency: 'TWD' | 'USD'; revision: string | null; published_at: Date | null;
  projection: unknown; projection_sha256: string | null; media_sha256: string | null;
  reservation_enabled: boolean;
  template_id: StoreTemplate; published_template_id: StoreTemplate | null;
}
export async function instance(q: PoolClient, tenantId: string, instanceId: string, write: boolean, allowArchived = false): Promise<Instance> {
  const row = (await q.query<Instance>(`SELECT i.instance_id,i.status,d.state AS deployment_state FROM module_instances i
    LEFT JOIN deployment_bindings d ON d.tenant_id=i.tenant_id AND d.instance_id=i.instance_id AND d.binding_id=i.binding_id
    WHERE i.tenant_id=$1 AND i.instance_id=$2 AND i.module_key='storefront'${write ? ' FOR NO KEY UPDATE OF i' : ''}`, [tenantId, instanceId])).rows[0];
  requireCondition(row, 404, 'not_found', STORE_MISSING);
  if (write) {
    // Match lifecycle's instance-before-deployment order. A deployment hold
    // that commits during this wait must refuse both fresh writes and replays.
    const live = await q.query(`SELECT 1 FROM deployment_bindings d
      JOIN module_instances i ON i.tenant_id=d.tenant_id AND i.instance_id=d.instance_id AND i.binding_id=d.binding_id
      WHERE i.tenant_id=$1 AND i.instance_id=$2 AND d.state='active' FOR SHARE OF d`, [tenantId, instanceId]);
    requireCondition(row.status === 'active' && live.rowCount === 1, 409, 'storefront_unavailable', '這間商店目前無法修改。');
  }
  else requireCondition(allowArchived || !['archived', 'failed'].includes(row.status), 404, 'not_found', STORE_MISSING);
  return row;
}
/** Every private profile read is anchored to both confirmed RLS mappings. */
export async function profile(q: PoolClient, tenantId: string, instanceId: string, lock = false): Promise<Profile | null> {
  return (await q.query<Profile>(`SELECT p.*,p.version::text AS version,s.name,s.description,s.currency,
    pub.revision::text AS revision,pub.published_at,pub.projection,pub.projection_sha256,pub.media_sha256,pub.template_id AS published_template_id
    FROM commerce_storefront_profiles p
    JOIN commerce_resource_tenants m ON m.resource_kind='shop' AND m.resource_id=p.storefront_shop_id AND m.tenant_id=p.tenant_id AND m.instance_id=p.instance_id AND m.mapping_state='confirmed'
    JOIN commerce_resource_tenants supply ON supply.resource_kind='shop' AND supply.resource_id=p.supply_shop_id AND supply.tenant_id=p.tenant_id AND supply.instance_id=p.instance_id AND supply.mapping_state='confirmed'
    JOIN commerce_shops s ON s.shop_id=m.resource_id AND s.origin='hosted'
    JOIN commerce_shops ss ON ss.shop_id=supply.resource_id AND ss.origin='hosted'
    LEFT JOIN commerce_storefront_publications pub ON pub.publication_id=p.current_publication_id AND pub.instance_id=p.instance_id AND pub.tenant_id=p.tenant_id
    WHERE m.tenant_id=$1 AND m.instance_id=$2${lock ? ' FOR UPDATE OF p' : ''}`, [tenantId, instanceId])).rows[0] ?? null;
}
export function ready(p: Profile | null): asserts p is Profile {
  requireCondition(p, 409, 'storefront_not_set_up', '請先設定商店。');
}
export async function productCount(q: PoolClient, p: Profile): Promise<number> {
  return (await q.query<{ n: number }>(`SELECT count(*)::int AS n FROM commerce_selections i
    JOIN commerce_resource_tenants m ON m.resource_kind='shop' AND m.resource_id=i.shop_id
    WHERE m.tenant_id=$1 AND m.instance_id=$2 AND m.resource_id=$3 AND m.mapping_state='confirmed'`,
  [p.tenant_id, p.instance_id, p.storefront_shop_id])).rows[0].n;
}
export async function storeView(q: PoolClient, context: TenantScopeContext, inst: Instance): Promise<StoreView> {
  const p = await profile(q, context.tenant_id, inst.instance_id);
  const keys = await effectiveStoreCapabilities(q, context, inst.instance_id);
  return StoreViewSchema.parse({ tenant_id: context.tenant_id, instance_id: inst.instance_id, instance_status: inst.status,
    setup_state: p ? 'ready' : 'setup_required',
    store: p ? { slug: p.slug, name: p.name, brand: p.brand, description: p.description, currency: p.currency, slug_locked: p.first_published_at !== null } : null,
    publication: { state: p?.current_publication_id ? 'published' : p?.first_published_at ? 'unpublished' : 'never_published', current_revision: p?.revision ?? null, published_at: p?.published_at?.toISOString() ?? null, public_path: p?.current_publication_id ? `/shops/${p.slug}` : null },
    product_count: p ? await productCount(q, p) : 0, product_limit: 200, transaction_state: 'not_enabled',
    writable: context.tenant_status === 'active' && inst.status === 'active' && inst.deployment_state === 'active' && keys.some(k => k !== 'store:read'),
    capabilities: keys, version: p?.version ?? null });
}
function mapError(error: unknown): never {
  if (error instanceof Problem && error.code === 'tenant_not_found') throw new Problem(404, 'not_found', STORE_MISSING);
  const e = error as { code?: string; constraint?: string };
  if (e.code === '23505' && e.constraint === 'commerce_storefront_profiles_slug_key') throw new Problem(409, 'storefront_slug_taken', '這個商店網址已被使用。');
  throw error;
}
export async function storeRead<T>(pool: Pool, actor: Actor, tenantId: string, instanceId: string, key: string, run: (q: PoolClient, context: TenantScopeContext, inst: Instance) => Promise<T>): Promise<T> {
  try { return await withTenantRead(pool, { actor, tenantId, capabilitiesForRole: storeCapabilities }, async (q, context) => {
    const inst = await instance(q, tenantId, instanceId, false);
    await requireStoreInstance(q, context, instanceId, key);
    return run(q, context, inst);
  }); } catch (e) { mapError(e); }
}
export async function storeCommand<T>(pool: Pool, actor: Actor, tenantId: string, instanceId: string, capability: string | readonly string[], operation: string, body: unknown, key: string, expected: string | undefined,
  run: (q: PoolClient, context: TenantScopeContext, inst: Instance) => Promise<T>, productId?: string): Promise<T> {
  let inst!: Instance;
  const authorize = async (q: PoolClient, context: TenantScopeContext) => {
    // Hide unreadable targets before reporting their lifecycle state.
    const peek = await instance(q, tenantId, instanceId, false, true);
    for (const key of typeof capability==='string' ? [capability] : capability) await requireStoreInstance(q, context, peek.instance_id, key, true);
    inst = await instance(q, tenantId, instanceId, true);
    // All hosted stock/price/publication writers share the order authority's
    // instance -> community -> profile ordering, including receipt replay.
    await q.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`commerce-orders/${context.community_id}`]);
  };
  try { return await scopedTenantCommand(pool, { actor, tenantId, tenantLock: 'share', operation, body, key, expected,
    target: { kind: productId ? 'storefront_product' : 'storefront', id: productId ?? instanceId }, capabilitiesForRole: storeCapabilities },
  authorize, (q, context) => run(q, context, inst), authorize); } catch (e) { mapError(e); }
}
export async function storeFact(q: PoolClient, context: TenantScopeContext, id: string, version: string, operation: string, aggregate = 'storefront') {
  await scopedJournal(q, context, { aggregate_type: aggregate, id, version, operation, data: { resource_id: id, version } });
}
export async function slugAvailability(q: PoolClient, raw: string, ownInstance: string) {
  const slug = raw.trim().toLowerCase();
  if (!SLUG_PATTERN.test(slug)) return { slug, available: false, reason: 'invalid' as const };
  if (reserved.has(slug)) return { slug, available: false, reason: 'reserved' as const };
  // Deliberate boolean-only global uniqueness check, no private profile data leaves this query.
  const taken = (await q.query(`SELECT 1 FROM commerce_storefront_profiles WHERE slug=$1 AND instance_id<>$2`, [slug, ownInstance])).rowCount === 1;
  return { slug, available: !taken, reason: taken ? 'taken' as const : null };
}
async function assertSlug(q: PoolClient, raw: string, instanceId: string) {
  const result = await slugAvailability(q, raw, instanceId);
  requireCondition(result.reason !== 'reserved', 422, 'storefront_slug_reserved', '這個商店網址保留給平台使用。');
  requireCondition(result.reason !== 'invalid', 422, 'validation_failed', '商店網址格式無效。');
  requireCondition(result.available, 409, 'storefront_slug_taken', '這個商店網址已被使用。');
  return result.slug;
}
export async function setupStore(pool: Pool, actor: Actor, tenantId: string, instanceId: string, raw: unknown, key: string) {
  const parsed = StoreSetupInputSchema.parse(raw);
  const input = { ...parsed, brand: parsed.brand ?? null, description: parsed.description ?? '', slug: parsed.slug.toLowerCase() };
  return storeCommand(pool, actor, tenantId, instanceId, 'store:manage', 'storefront.setup', input, key, undefined, async (q, context, inst) => {
    const prior = await profile(q, tenantId, instanceId, true);
    if (prior) {
      requireCondition(prior.slug === input.slug && prior.name === input.name && prior.brand === input.brand && prior.description === input.description && prior.currency === input.currency,
        409, 'storefront_already_set_up', '這間商店已經完成設定。');
      return { created: false, view: await storeView(q, context, inst) };
    }
    const slug = await assertSlug(q, input.slug, instanceId);
    const supply = randomUUID(), storefront = randomUUID();
    for (const [shopId, kind, suffix] of [[supply, 'internal', 'supply'], [storefront, 'public', 'storefront']]) {
      await q.query(`INSERT INTO commerce_shops(shop_id,community_id,owner_id,kind,origin,mode,accepting_orders,name,description,website_url,contact,currency,manifest_sha256)
        VALUES($1,$2,$3,$4,'hosted','test',false,$5,$6,'','',$7,$8)`,
      [shopId, context.community_id, actor.user_id, kind, input.name, input.description, input.currency, sha256(`freedom.hosted-store/v1\n${instanceId}\n${suffix}`)]);
      await q.query(`INSERT INTO commerce_resource_tenants(resource_kind,resource_id,tenant_id,instance_id,source_owner_id,mapping_state)
        VALUES('shop',$1,$2,$3,$4,'confirmed')`, [shopId, tenantId, instanceId, context.principal_id]);
    }
    await q.query(`INSERT INTO commerce_storefront_profiles(instance_id,tenant_id,supply_shop_id,storefront_shop_id,slug,brand,created_by_principal_id)
      VALUES($1,$2,$3,$4,$5,$6,$7)`, [instanceId, tenantId, supply, storefront, slug, input.brand, context.principal_id]);
    await storeFact(q, context, instanceId, '1', 'storefront.setup');
    return { created: true, view: await storeView(q, context, inst) };
  });
}
export async function updateStore(pool: Pool, actor: Actor, tenantId: string, instanceId: string, raw: unknown, key: string, expected: string) {
  const input = StoreUpdateInputSchema.parse(raw);
  return storeCommand(pool, actor, tenantId, instanceId, 'store:manage', 'storefront.update', input, key, expected, async (q, context, inst) => {
    const p = await profile(q, tenantId, instanceId, true); ready(p); checkVersion(p.version, expected);
    const slug = input.slug?.toLowerCase() ?? p.slug;
    requireCondition(slug === p.slug || !p.first_published_at, 409, 'storefront_slug_locked', '首次公開後不能更改商店網址。');
    await assertSlug(q, slug, instanceId);
    await q.query(`UPDATE commerce_shops s SET name=$3,description=$4 FROM commerce_resource_tenants m
      WHERE m.resource_kind='shop' AND m.resource_id=s.shop_id AND m.tenant_id=$1 AND m.instance_id=$2 AND m.mapping_state='confirmed' AND s.origin='hosted'`,
    [tenantId, instanceId, input.name ?? p.name, input.description ?? p.description]);
    await q.query(`UPDATE commerce_storefront_profiles p SET slug=$3,brand=$4,version=p.version+1,updated_at=clock_timestamp()
      FROM commerce_resource_tenants m WHERE m.resource_id=p.storefront_shop_id AND m.tenant_id=$1 AND m.instance_id=$2 AND p.instance_id=m.instance_id`,
    [tenantId, instanceId, slug, input.brand === undefined ? p.brand : input.brand]);
    await storeFact(q, context, instanceId, String(BigInt(p.version) + 1n), 'storefront.update');
    return storeView(q, context, inst);
  });
}
export async function listMyStores(pool: Pool, actor: Actor, cursor?: string) {
  return isolatedTransaction(pool, async q => {
    await lockMemberSession(q, actor);
    const principal = await mapPersonPrincipal(q, actor.user_id);
    requireCondition(principal.status === 'active', 403, 'principal_disabled', '這個身分目前無法使用。');
    await bindPrincipalContext(q, principal.principal_id);
    const after = readCursor(cursor, principal.principal_id, 'my_stores', null);
    const tenants = (await q.query<{ tenant_id: string; display_name: string }>(`SELECT t.tenant_id,t.display_name FROM tenant_memberships m JOIN tenants t USING(tenant_id)
      WHERE m.principal_id=$1 AND m.status='active' AND t.community_id=$2 AND ($3::uuid IS NULL OR t.tenant_id>$3)
      ORDER BY t.tenant_id LIMIT 101`, [principal.principal_id, actor.community_id, after])).rows;
    const items = [];
    for (const t of tenants.slice(0, 100)) {
      try {
        const context = await lockTenantScope(q, { actor, tenantId: t.tenant_id, capabilitiesForRole: storeCapabilities });
        const instances = (await q.query<Instance>(`SELECT i.instance_id,i.status,d.state AS deployment_state FROM module_instances i
          LEFT JOIN deployment_bindings d ON d.binding_id=i.binding_id AND d.tenant_id=i.tenant_id AND d.instance_id=i.instance_id
          WHERE i.tenant_id=$1 AND i.module_key='storefront' AND i.status NOT IN ('archived','failed')`, [t.tenant_id])).rows;
        for (const inst of instances) {
          if (!(await effectiveStoreCapabilities(q, context, inst.instance_id)).includes('store:read')) continue;
          // The list needs no product count or second capability read. Keep the
          // confirmed profile mappings and per-tenant RLS context authoritative.
          const p = await profile(q, context.tenant_id, inst.instance_id);
          items.push({ tenant_id: t.tenant_id, tenant_display_name: t.display_name, instance_id: inst.instance_id, setup_state: p ? 'ready' : 'setup_required',
            name: p?.name ?? null, slug: p?.slug ?? null, publication_state: p?.current_publication_id ? 'published' : p?.first_published_at ? 'unpublished' : 'never_published',
            public_path: p?.current_publication_id ? `/shops/${p.slug}` : null, version: p?.version ?? null });
        }
      } catch (e) { if (!(e instanceof Problem && ['tenant_not_found','scope_disabled'].includes(e.code))) throw e; }
      await clearTenantContext(q); await bindPrincipalContext(q, principal.principal_id);
    }
    await assertCurrentSessionClock(q, actor);
    return MyStoresPageSchema.parse({ items, next_cursor: tenants.length > 100 ? encodeCursor(principal.principal_id, 'my_stores', null, tenants[99].tenant_id) : null });
  });
}
