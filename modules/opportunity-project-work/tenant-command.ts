import type { Pool, PoolClient } from 'pg';
import { scopedJournal, scopedTenantCommand, type ScopedTenantCommand } from '../../packages/scoped-commands/index.js';
import type { TenantScopeContext } from '../../packages/resource-scopes/index.js';
import { digest } from '../../packages/db/index.js';
import { tenantWorkCapabilities } from './tenant-capabilities.js';

/** Thrown from run only after authorize. Rollback leaves no receipt, so the caller can perform storage I/O and record the same body. */
export class ReceiptMiss extends Error {
  constructor() { super('tenant_work_receipt_miss'); this.name = 'ReceiptMiss'; }
}

type CommandFields = Omit<ScopedTenantCommand, 'capabilitiesForRole' | 'tenantLock' | 'actor'> & {
  actor: ScopedTenantCommand['actor'];
};

type Journal<T> = {
  id: string; version: string; record: boolean;
  commit?: (q: PoolClient, context: TenantScopeContext) => Promise<T>;
};

/** Same key and body replays the stored JSON. A miss runs produce outside any command so object I/O is not nested under the tenant lock.
 * produce fills journal with an aggregate id and version that are not already used: the journal is unique per scope, type, id and version.
 * record=false skips the fact when this attempt only rereads a commit that already journaled that version.
 * commit(work) opens the one receipt transaction. work runs inside it, then the journal fact and the receipt.
 * A stored receipt returns its response and does not call work. */
export async function rememberTenantCommand<T>(pool: Pool, fields: CommandFields,
  authorize: (q: PoolClient, context: TenantScopeContext) => Promise<unknown>,
  produce: (journal: Journal<T>, commit: (work: (q: PoolClient, context: TenantScopeContext) => Promise<T>) => Promise<T>) => Promise<T | undefined>,
  inspect?: (q: PoolClient, context: TenantScopeContext) => Promise<void>): Promise<T> {
  const input: ScopedTenantCommand = { ...fields, tenantLock: 'share', capabilitiesForRole: tenantWorkCapabilities };
  try {
    return await scopedTenantCommand(pool, input, authorize, async (q, context) => {
      if (inspect) await inspect(q, context);
      throw new ReceiptMiss();
    }, authorize);
  } catch (error) {
    if (!(error instanceof ReceiptMiss)) throw error;
  }
  const journal: Journal<T> = { id: fields.target.id, version: '1', record: true };
  let opened = false;
  const commit = (work: (q: PoolClient, context: TenantScopeContext) => Promise<T>) => {
    opened = true;
    return scopedTenantCommand(pool, input, authorize, async (q, context) => {
      const value = await work(q, context);
      if (journal.record) {
        await scopedJournal(q, context, {
          aggregate_type: 'tenant_work', id: journal.id, version: journal.version, operation: fields.operation,
          data: { tenant_id: fields.tenantId, target_id: journal.id },
        });
      }
      return value;
    }, authorize);
  };
  const produced = await produce(journal, commit);
  if (opened) return produced as T;
  // The probe already rolled back. This later commit still has to see result-write authority.
  return scopedTenantCommand(pool, input, authorize, async (q, context) => {
    const value = journal.commit ? await journal.commit(q, context) : produced as T;
    if (journal.record) {
      await scopedJournal(q, context, {
        aggregate_type: 'tenant_work', id: journal.id, version: journal.version, operation: fields.operation,
        data: { tenant_id: fields.tenantId, target_id: journal.id },
      });
    }
    return value;
  }, authorize);
}

/** Stable across a lost HTTP acknowledgement. Version nibble is fixed so the id stays a UUID. */
export function stableOperationId(tenantId: string, operation: string, key: string): string {
  const hex = digest({ profile: 'freedom.tenant-work-operation/v1', tenant_id: tenantId, operation, key });
  const chars = hex.slice(0, 32).split('');
  chars[12] = '5';
  chars[16] = 'a';
  const value = chars.join('');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}
