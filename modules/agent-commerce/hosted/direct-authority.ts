import type { Pool, PoolClient } from 'pg';
import { performance } from 'node:perf_hooks';
import type { Actor } from '../../identity-membership/service.js';
import type { MemberScopeContext } from '../../../packages/resource-scopes/index.js';
import { bindPrincipalContext, bindTenantContext, isolatedTransaction } from '../../../packages/resource-scopes/tenant-transaction.js';
import { scopedMemberCommand, scopedJournal } from '../../../packages/scoped-commands/index.js';
import { assertCurrentSessionClock } from '../../../packages/db/member-session.js';
import { requireCondition } from '../../../packages/shared/problem.js';
import { profile, ready, type Profile } from './store.js';

export type DirectOperation = 'storefront.quote.create' | 'storefront.order.submit' | 'storefront.order.cancel' | 'storefront.order.read';
export type Target = { slug: string } | { order_id: string };
export interface DirectContext {
  member: MemberScopeContext; profile: Profile; operation: DirectOperation;
  /** Set only for a newly created effect, never a committed outcome replay. */
  deadline?: Date; monotonicDeadline?: number;
  reservationDeadline?: Date; deadlineCode?: 'quote_expired' | 'reservation_clock_changed';
}
const missing = () => requireCondition(false, 404, 'hosted_order_not_found', '找不到這間商店或訂單。');
export async function lockCommerceCommunity(q: PoolClient, communityId: string) {
  await q.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`commerce-orders/${communityId}`]);
}

/** Closed exact-store adapter. The member remains on their personal scope;
 * transaction-local tenant settings are a domain-selected RLS bound, not a
 * TenantScopeContext, tenant membership, or transferable authorization. */
async function authorize(q: PoolClient, actor: Actor, member: MemberScopeContext, target: Target, requireLive: boolean): Promise<Profile> {
  const principal = member.subject_principal.principal_id;
  await bindPrincipalContext(q, principal);
  const eligible = await q.query(`SELECT 1 FROM users WHERE user_id=$1 AND active
    AND (NOT onboarding_required OR onboarding_completed_at IS NOT NULL) AND NOT is_verification_test_account(user_id)`, [actor.user_id]);
  requireCondition(eligible.rowCount === 1, 403, 'member_unavailable', '目前無法使用會員訂單。');
  const row = 'slug' in target
    ? (await q.query(`SELECT tenant_id,instance_id FROM commerce_storefront_profiles WHERE slug=$1`, [target.slug])).rows[0]
    : (await q.query(`SELECT quote.tenant_id,quote.instance_id FROM commerce_orders o
        JOIN commerce_order_quotes quote ON quote.quote_id=o.quote_id
        WHERE o.order_id=$1 AND o.buyer_principal_id=$2 AND o.order_profile='hosted_direct_reservation'`, [target.order_id, principal])).rows[0];
  if (!row) missing();
  const scope = (await q.query(`SELECT scope_id,status FROM resource_scopes WHERE kind='tenant' AND tenant_ref=$1 FOR SHARE`, [row.tenant_id])).rows[0];
  if (!scope) missing();
  await bindTenantContext(q, { tenantId: row.tenant_id, tenantScopeId: scope.scope_id });
  // Owner membership/lifecycle/account mutators take this conflicting tenant
  // lock (tenant-workspaces/security-path.ts); never lock another user's row.
  const tenant = (await q.query(`SELECT community_id,status FROM tenants WHERE tenant_id=$1 FOR SHARE`, [row.tenant_id])).rows[0];
  if (!tenant) missing();
  const instance = (await q.query(`SELECT instance_id,status,binding_id FROM module_instances
    WHERE tenant_id=$1 AND instance_id=$2 AND module_key='storefront' FOR NO KEY UPDATE`, [row.tenant_id, row.instance_id])).rows[0];
  if (!instance) missing();
  const deployment = (await q.query(`SELECT state FROM deployment_bindings WHERE tenant_id=$1 AND instance_id=$2 AND binding_id=$3 FOR SHARE`,
    [row.tenant_id, row.instance_id, instance.binding_id])).rows[0];
  await lockCommerceCommunity(q, tenant.community_id);
  const p = await profile(q, row.tenant_id, row.instance_id, true); ready(p);
  if ('slug' in target && p.slug !== target.slug) missing();
  if (requireLive) {
    const owner = await q.query(`SELECT 1 FROM tenant_memberships m JOIN principals p ON p.principal_id=m.principal_id
      JOIN users u ON u.user_id=p.user_ref WHERE m.tenant_id=$1 AND m.role='owner' AND m.status='active'
      AND p.kind='person' AND p.status='active' AND u.active AND NOT is_verification_test_account(u.user_id) LIMIT 1`, [row.tenant_id]);
    requireCondition(scope.status === 'active' && tenant.status === 'active' && instance.status === 'active'
      && deployment?.state === 'active' && owner.rowCount === 1, 409, 'storefront_unavailable', '商店目前無法接受新訂單。');
    requireCondition(p.reservation_enabled, 409, 'reservation_not_enabled', '商店尚未啟用庫存保留訂單。');
    requireCondition(p.current_publication_id, 409, 'publication_required', '商店目前未公開。');
  }
  // Historical reads/releases deliberately survive suspension/archive/pause.
  // They still require the real buyer relation and both retained mappings.
  return p;
}

export async function directFact(q: PoolClient, context: DirectContext, id: string, version: string, state: string) {
  await scopedJournal(q, context.member, { aggregate_type: 'hosted_order', id, version, operation: context.operation,
    data: { order_id: id, state }, eventType: 'freedom.hosted.order.reservation.changed.v1' });
}
async function decisionClock(q: PoolClient, context: DirectContext) {
  const deadline = context.deadline && (!context.reservationDeadline || context.deadline < context.reservationDeadline)
    ? context.deadline : context.reservationDeadline;
  if (!deadline) return;
  context.deadlineCode = deadline === context.deadline ? 'quote_expired' : 'reservation_clock_changed';
  const before = performance.now();
  const now = (await q.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0].now;
  const remaining = deadline.getTime() - now.getTime();
  requireCondition(remaining > 0, 409, context.deadlineCode, '報價或庫存保留狀態已更新，請重新讀取。');
  // Conservatively include query/network wait; never extend from local wall time.
  context.monotonicDeadline = before + remaining;
}

/** Receipt stores only a reference. The supplied projection runs on this SAME
 * transaction, after receipt handling, under freshly checked current authority. */
export async function directCommand<T>(pool: Pool, actor: Actor, target: Target, operation: DirectOperation,
  body: unknown, key: string, targetId: string, expected: string | undefined,
  run: (q: PoolClient, context: DirectContext) => Promise<{ id: string }>,
  project: (q: PoolClient, context: DirectContext, id: string) => Promise<T>): Promise<T> {
  let context!: DirectContext, output!: T;
  const live = operation === 'storefront.quote.create' || operation === 'storefront.order.submit';
  const clock = () => requireCondition(context?.monotonicDeadline === undefined || performance.now() < context.monotonicDeadline,
    409, context?.deadlineCode ?? 'quote_expired', '報價或庫存保留狀態已更新，請重新讀取。');
  const revalidate = async (q: PoolClient, member: MemberScopeContext) => {
    context.profile = await authorize(q, actor, member, target, live);
    await decisionClock(q, context);
  };
  await scopedMemberCommand(pool, { actor, scope: 'personal', operation, body, key, expected,
    target: { kind: 'hosted_order', id: targetId } }, async (q, member) => {
    context = { member, operation, profile: await authorize(q, actor, member, target, live) };
  }, q => run(q, context), revalidate, clock, (source, command) => isolatedTransaction(source, async q => {
    const reference = await command(q);
    // The generic adapter returns its reference type; only this closed command
    // supplies these callbacks. No caller-controlled projection/authority port.
    output = await project(q, context, (reference as { id: string }).id);
    await revalidate(q, context.member);
    await assertCurrentSessionClock(q, actor); clock();
    return reference;
  }));
  return output;
}
