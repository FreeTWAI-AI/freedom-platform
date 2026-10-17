import type { PoolClient } from 'pg';
// The 72-hour payment-case interval is an adjustable operational default.
const policy = (next_action: 'refund_payment' | 'allocate_or_refund' | 'check_with_provider' | 'contact_provider') => Object.freeze({ responsible_party: 'retailer' as const, due_hours: 72, next_action });
export const PAYMENT_EXCEPTION_POLICIES = Object.freeze({
  unmatched_payment: policy('check_with_provider'),
  amount_mismatch: policy('refund_payment'),
  paid_unallocatable: policy('allocate_or_refund'),
  paid_after_cancel: policy('refund_payment'),
  overpaid: policy('refund_payment'),
  payment_unconfirmed: policy('contact_provider'),
  contradicting_event: policy('check_with_provider'),
});
export type PaymentExceptionKind = keyof typeof PAYMENT_EXCEPTION_POLICIES;
export interface OpenExceptionInput {
  tenantId: string;
  instanceId: string;
  orderId?: string | null;
  kind: PaymentExceptionKind;
  subjectKind: 'payment_attempt' | 'payment_event' | 'offline_payment';
  subjectId: string;
  openedBy?: {
    kind: 'person';
    principalId: string;
  } | {
    kind: 'system';
  };
}
/** Caller binds the retailer tenant and owns the transaction. The partial
 * unique index serializes concurrent replays without reopening a closed case. */
export async function openException(q: PoolClient, input: OpenExceptionInput) {
  const rules = PAYMENT_EXCEPTION_POLICIES[input.kind], actor = input.openedBy ?? { kind: 'system' };
  if (!rules)
    throw new Error('exception_kind_invalid');
  for (let retry = 0;retry < 3;retry++) {
    const inserted = await q.query(`INSERT INTO commerce_exception_cases(tenant_id,instance_id,order_id,kind,subject_kind,subject_id,
      responsible_party,due_at,opened_by_kind,opened_by_principal_id,created_at,updated_at)
      SELECT $1,$2,$3,$4,$5,$6,$7,t+$8*interval '1 hour',$9,$10,t,t FROM (SELECT clock_timestamp() t) n
      ON CONFLICT(kind,subject_kind,subject_id) WHERE status='open' DO NOTHING RETURNING *`, [input.tenantId, input.instanceId, input.orderId ?? null, input.kind, input.subjectKind, input.subjectId, rules.responsible_party, rules.due_hours,
    actor.kind, actor.kind === 'person' ? actor.principalId : null]);
    if (inserted.rows[0])
      return inserted.rows[0];
    const existing = (await q.query(`SELECT * FROM commerce_exception_cases WHERE kind=$1 AND subject_kind=$2 AND subject_id=$3 AND status='open'`, [input.kind, input.subjectKind, input.subjectId])).rows[0];
    if (existing) {
      if (existing.tenant_id !== input.tenantId || existing.instance_id !== input.instanceId || existing.order_id !== (input.orderId ?? null))
        throw new Error('exception_binding_invalid');
      return existing;
    }
    // A closing transaction may win between the conflict and this snapshot.
  }
  throw new Error('exception_open_conflict');
}
