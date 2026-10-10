import { isolatedTransaction } from '../../packages/resource-scopes/tenant-transaction.js';
import { assertCurrentSessionClock } from '../../packages/db/member-session.js';
import { lockTenantScope, type TenantScopeContext } from '../../packages/resource-scopes/index.js';
import { scopedJournal, scopedTenantCommand } from '../../packages/scoped-commands/index.js';
import { storeCapabilities } from '../agent-commerce/hosted/capabilities.js';
import { lockStorefrontPhotoBoundary, type StorefrontPhotoActor } from '../agent-commerce/hosted/photo-authority.js';
import type { LifecycleAuthority } from './lifecycle-authority.js';

const authorities = new WeakSet<object>();
/** Closed storefront authority. Neither tenant Work privileges nor a same-shaped
 * caller object can authorize this profile. The current store boundary is also
 * rechecked before returning a historical command receipt. */
export function createStorefrontLifecycleAuthority(): LifecycleAuthority<StorefrontPhotoActor, TenantScopeContext> {
  const authority: LifecycleAuthority<StorefrontPhotoActor, TenantScopeContext> = {
    snapshot: actor => Object.freeze({ ...actor }),
    async read(pool, input, authorize, run) {
      return isolatedTransaction(pool, async q => {
        const context = await lockTenantScope(q, { actor: input.actor, tenantId: input.actor.tenant_id,
          forUpdate: false, lockUser: input.lockUser, capabilitiesForRole: storeCapabilities });
        await lockStorefrontPhotoBoundary(q, context, input.actor);
        await authorize(q, context);
        return run(q, context);
      });
    },
    async command(pool, input, authorize, run, revalidate, assertCurrentTime) {
      return scopedTenantCommand(pool, { actor: input.actor, tenantId: input.actor.tenant_id,
        operation: input.operation, key: input.key, body: input.body, target: input.target, expected: input.expected,
        lockUser: input.lockUser, tenantLock: 'share', capabilitiesForRole: storeCapabilities },
      async (q, context) => { await lockStorefrontPhotoBoundary(q, context, input.actor); await authorize(q, context); },
      run, async (q, context) => {
        await lockStorefrontPhotoBoundary(q, context, input.actor);
        if (revalidate) await revalidate(q, context);
      }, assertCurrentTime);
    },
    clock: (q, actor) => assertCurrentSessionClock(q, actor),
    communityId: actor => actor.community_id,
    journal: scopedJournal,
  };
  const frozen = Object.freeze(authority); authorities.add(frozen); return frozen;
}
export function isStorefrontLifecycleAuthority(value: object): boolean { return authorities.has(value); }
