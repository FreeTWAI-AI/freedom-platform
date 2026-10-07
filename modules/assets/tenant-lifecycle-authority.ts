import { isolatedTransaction } from '../../packages/resource-scopes/tenant-transaction.js';
import { assertCurrentSessionClock } from '../../packages/db/member-session.js';
import { lockTenantScope, type TenantScopeContext } from '../../packages/resource-scopes/index.js';
import { scopedJournal, scopedTenantCommand, type ScopedJournalInput } from '../../packages/scoped-commands/index.js';
import type { Actor } from '../identity-membership/service.js';
import { tenantWorkCapabilities } from '../opportunity-project-work/tenant-capabilities.js';
import type { LifecycleAuthority } from './lifecycle-authority.js';

export type TenantWorkActor = Actor & { readonly tenant_id: string };

const authorities = new WeakSet<object>();

/** Identity is the frozen object, never a caller-supplied flag. The member-shaped
 * scope argument is ignored: the URL tenant is locked inside this transaction. */
export function createTenantLifecycleAuthority(): LifecycleAuthority<TenantWorkActor, TenantScopeContext> {
  const authority: LifecycleAuthority<TenantWorkActor, TenantScopeContext> = {
    snapshot: actor => Object.freeze({ ...actor }),
    async read(pool, input, authorize, run) {
      return isolatedTransaction(pool, async q => {
        const context = await lockTenantScope(q, {
          actor: input.actor, tenantId: input.actor.tenant_id, forUpdate: false, lockUser: input.lockUser,
          capabilitiesForRole: tenantWorkCapabilities,
        });
        await authorize(q, context);
        return run(q, context);
      });
    },
    async command(pool, input, authorize, run, revalidate, assertCurrentTime) {
      return scopedTenantCommand(pool, {
        actor: input.actor, tenantId: input.actor.tenant_id, operation: input.operation, key: input.key,
        body: input.body, target: input.target, expected: input.expected, lockUser: input.lockUser, tenantLock: 'share',
        capabilitiesForRole: tenantWorkCapabilities,
      }, authorize, run, revalidate, assertCurrentTime);
    },
    clock: (q, actor) => assertCurrentSessionClock(q, actor),
    communityId: actor => actor.community_id,
    journal: (q, context, input: ScopedJournalInput) => scopedJournal(q, context, input),
  };
  const frozen = Object.freeze(authority);
  authorities.add(frozen);
  return frozen;
}

export function isTenantLifecycleAuthority(value: object): boolean {
  return authorities.has(value);
}
