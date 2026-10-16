import type { PoolClient } from 'pg';
export type CommerceDueWorkKind = 'payment_query' | 'payment_window_end';
/** Scheduling never postpones existing work and never changes its tenant. The
 * caller owns the transaction; this helper performs no external operation. */
export async function scheduleDueWork(q: PoolClient, input: {
  tenantId: string;
  instanceId: string;
  kind: CommerceDueWorkKind;
  targetId: string;
  dueAt: Date | string;
}): Promise<void> {
  const result = await q.query(`INSERT INTO commerce_due_work(tenant_id,instance_id,kind,target_id,due_at)
    VALUES($1,$2,$3,$4,$5) ON CONFLICT(kind,target_id) DO UPDATE
    SET due_at=LEAST(commerce_due_work.due_at,EXCLUDED.due_at),updated_at=clock_timestamp()
    WHERE commerce_due_work.tenant_id=EXCLUDED.tenant_id AND commerce_due_work.instance_id=EXCLUDED.instance_id`, [input.tenantId, input.instanceId, input.kind, input.targetId, input.dueAt]);
  if (result.rowCount !== 1)
    throw new Error('due_work_binding_invalid');
}
