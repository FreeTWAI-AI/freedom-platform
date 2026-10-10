import type { PoolClient } from 'pg';
import { OpaqueId } from '../../../contracts/common/v1/identity.js';
import { assertCurrentSessionClock } from '../../../packages/db/member-session.js';
import type { TenantScopeContext } from '../../../packages/resource-scopes/index.js';
import { requireCondition } from '../../../packages/shared/problem.js';
import type { Actor } from '../../identity-membership/service.js';
import { requireStoreInstance } from './capabilities.js';
import { instance, profile, ready } from './store.js';

export type StorefrontPhotoActor = Actor & { readonly tenant_id: string; readonly instance_id: string };

/** Closed commerce authority shared by the upload engine and its receipt facade.
 * Caller already owns the real session/tenant transaction. This is not a wire port.
 * Order: instance/deployment -> commerce -> profile; policy/product follow later. */
export async function lockStorefrontPhotoBoundary(q: PoolClient, context: TenantScopeContext, actor: StorefrontPhotoActor) {
  const tenantId = OpaqueId.parse(actor.tenant_id), instanceId = OpaqueId.parse(actor.instance_id);
  requireCondition(context.tenant_id === tenantId, 404, 'not_found', '找不到這間商店。');
  await requireStoreInstance(q, context, instanceId, 'store:write', true);
  await instance(q, tenantId, instanceId, true);
  await q.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`commerce-orders/${context.community_id}`]);
  const p = await profile(q, tenantId, instanceId, true); ready(p);
  await assertCurrentSessionClock(q, actor);
  return p;
}

/** Same locked boundary is re-read after receipt/lease waits. */
export const revalidateStorefrontPhotoBoundary = lockStorefrontPhotoBoundary;
