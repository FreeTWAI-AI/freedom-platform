import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, afterEach, before, beforeEach, test } from 'node:test';
import type { PoolClient } from 'pg';
import { checkoutHarness, type CheckoutHarness } from './hosted-checkout-harness.js';
import { bindStore } from '../../modules/agent-commerce/checkout/authority.js';
import { openException, PAYMENT_EXCEPTION_POLICIES } from '../../modules/agent-commerce/checkout/exceptions.js';
import { scheduleDueWork } from '../../modules/agent-commerce/operations/due-work.js';
import { CommerceCredentialKeyring, sealCredential } from '../../modules/agent-commerce/payments/credentials.js';
import { newTradeNumber } from '../../modules/agent-commerce/providers/ecpay/index.js';
let x: CheckoutHarness, q: PoolClient, s: Awaited<ReturnType<CheckoutHarness['store']>>, other: typeof s;
let accountId: string, orderId: string, principalId: string, rlsCase: string;
let activationSequence = 10;
before(async () => {
  x = await checkoutHarness('fp_payment_schema');
  await x.reset();
  s = await x.store();
  other = await x.store();
  orderId = (await x.place(s, await x.frozen(s))).order_id;
  principalId = (await x.h.pool.query('SELECT principal_id FROM principals WHERE user_ref=$1', [s.owner.user.user_id])).rows[0].principal_id;
  accountId = randomUUID();
  await x.tx(async (c) => {
    await bindStore(c, s.tenantId);
    await c.query(`INSERT INTO commerce_provider_accounts(account_id,tenant_id,instance_id,provider,environment,merchant_id,created_by_principal_id)
      VALUES($1,$2,$3,'ecpay','sandbox','1234567',$4)`, [accountId, s.tenantId, s.instanceId, principalId]);
    await c.query(`INSERT INTO commerce_provider_account_services(account_id,purpose,tenant_id,instance_id,environment,profile,credential_version)
      VALUES($1,'payment',$2,$3,'sandbox','ecpay.aio.credit.v1',1)`, [accountId, s.tenantId, s.instanceId]);
    const ring = CommerceCredentialKeyring.parse('test:' + randomBytes(32).toString('base64'))!;
    const material = { hash_key: randomBytes(8).toString('hex'), hash_iv: randomBytes(8).toString('hex') };
    const sealed = sealCredential(ring, { account_id: accountId, purpose: 'payment', environment: 'sandbox', credential_version: 1 }, material);
    await c.query(`INSERT INTO commerce_provider_credentials(account_id,purpose,credential_version,tenant_id,instance_id,environment,key_id,sealed,created_by_principal_id)
      VALUES($1,'payment',1,$2,$3,'sandbox',$4,$5,$6)`, [accountId, s.tenantId, s.instanceId, sealed.key_id, sealed.sealed, principalId]);
    rlsCase = (await openException(c, { tenantId: s.tenantId, instanceId: s.instanceId, orderId, kind: 'amount_mismatch', subjectKind: 'payment_attempt', subjectId: randomUUID() })).case_id;
  });
});
beforeEach(async () => { q = await x.h.pool.connect(); await q.query('BEGIN'); });
afterEach(async () => { await q.query('ROLLBACK'); q.release(); });
after(async () => x?.stop());
test('payment table foreign keys have nonpartial lookup indexes', async () => {
  const missing = await q.query(`SELECT conrelid::regclass::text AS table_name, conname
    FROM pg_constraint c
    WHERE contype='f' AND conrelid=ANY(ARRAY[
      'commerce_payment_attempts'::regclass, 'commerce_hosted_payment_events'::regclass,
      'commerce_due_work'::regclass, 'commerce_outbound_emails'::regclass, 'commerce_exception_cases'::regclass])
      AND NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid=c.conrelid
        AND i.indisvalid AND i.indpred IS NULL AND i.indkey[0]=c.conkey[1])
    ORDER BY table_name, conname`);
  assert.deepEqual(missing.rows, []);
});
async function insert(table: string, row: Record<string, unknown>) {
  const names = Object.keys(row);
  return (await q.query(`INSERT INTO ${table}(${names.join(',')}) VALUES(${names.map((_, i) => '$' + (i + 1)).join(',')}) RETURNING *`, Object.values(row))).rows[0];
}
const attemptInput = () => ({ tenant_id: s.tenantId, instance_id: s.instanceId, kind: 'order', order_id: orderId, sequence: 1, account_id: accountId, purpose: 'payment', environment: 'sandbox', merchant_id: '1234567', credential_version: 1, provider: 'ecpay', profile: 'ecpay.aio.credit.v1', merchant_trade_no: newTradeNumber('F'), amount_minor: 500, currency: 'TWD' });
const attempt = (changes: Record<string, unknown> = {}) => insert('commerce_payment_attempts', { ...attemptInput(), ...changes });
const eventInput = () => ({ tenant_id: s.tenantId, instance_id: s.instanceId, account_id: accountId, source: 'notification', outcome: 'paid', trade_no: 'SYNTHETIC', payment_date: new Date(), trade_amt_minor: 500, dedupe_key: randomBytes(32).toString('hex') });
const event = (changes: Record<string, unknown> = {}) => insert('commerce_hosted_payment_events', { ...eventInput(), ...changes });
async function rejects(run: () => Promise<unknown>, code = '23514') {
  await q.query('SAVEPOINT invalid_write');
  await assert.rejects(run, { code });
  await q.query('ROLLBACK TO SAVEPOINT invalid_write');
}
const stateTime: Record<string, string> = { paid: 'paid_at', confirmed: 'confirmed_at', failed: 'failed_at', superseded: 'superseded_at', expired_unpaid: 'expired_at' };
const states = ['issued', 'paid', 'confirmed', 'failed', 'superseded', 'expired_unpaid'];
async function transition(id: string, to: string) { return q.query(`UPDATE commerce_payment_attempts SET state=$2,${stateTime[to] ?? 'paid_at'}=clock_timestamp(),${to === 'paid' ? "trade_no=coalesce(trade_no,'SYNTHETIC'),payment_date=coalesce(payment_date,clock_timestamp())," : ''}version=version+1 WHERE attempt_id=$1`, [id, to]); }
async function inState(state: string) {
  const a = await attempt(); if (state === 'confirmed') {
    await transition(a.attempt_id, 'paid');
    await transition(a.attempt_id, state);
  }
  else if (state !== 'issued')
    await transition(a.attempt_id, state); return a;
}
for (const from of states)
  for (const to of states)
    test(`attempt transition ${from} -> ${to}`, async () => {
      const a = await inState(from), allowed = from === 'issued' && ['paid', 'failed', 'superseded', 'expired_unpaid'].includes(to)
        || from === 'superseded' && ['paid', 'failed', 'expired_unpaid'].includes(to) || ['failed', 'expired_unpaid'].includes(from) && to === 'paid' || from === 'paid' && to === 'confirmed';
      if (from === to) {
        await q.query('UPDATE commerce_payment_attempts SET version=version+1 WHERE attempt_id=$1', [a.attempt_id]);
        return;
      }
      if (allowed) {
        await transition(a.attempt_id, to);
        assert.equal((await q.query('SELECT state FROM commerce_payment_attempts WHERE attempt_id=$1', [a.attempt_id])).rows[0].state, to);
      }
      else
        await rejects(() => transition(a.attempt_id, to));
    });
const invalidAttempts: Record<string, unknown>[] = [
  { kind: 'unknown' }, { kind: 'service_activation' }, { kind: 'order', order_id: null }, { sequence: 0 }, { sequence: 6 }, { provider: 'other' }, { profile: 'other' },
  { purpose: 'invoice' }, { environment: 'other' }, { merchant_trade_no: 'f' + '0'.repeat(19) }, { merchant_trade_no: 'F' + 'I'.repeat(19) },
  { merchant_trade_no: 'F' + '0'.repeat(18) }, { amount_minor: 400 }, { amount_minor: 501 }, { currency: 'USD' },
  { state: 'paid' }, { state: 'other' }, { version: 0 }, { version: 2 }, { journaled_at: new Date() }, { handed_off_at: new Date() },
  { paid_at: new Date() }, { confirmed_at: new Date() }, { failed_at: new Date() }, { superseded_at: new Date() }, { expired_at: new Date() },
  { trade_no: 'TRADE' }, { payment_date: new Date() }, { payment_type: 'Credit_CreditCard' }, { charge_fee_minor: 0 }, { gwsr: '123' },
];
for (const [i, changes] of invalidAttempts.entries())
  test(`attempt insertion constraints ${i}: ${Object.keys(changes).join(',')}`, async () => { await rejects(() => attempt(changes)); });
for (const field of ['merchant_id', 'tenant_id', 'instance_id', 'environment', 'credential_version', 'account_id', 'order_id'])
  test(`attempt composite FK ${field}`, async () => {
    const changes: Record<string, unknown> = { merchant_id: '7654321', tenant_id: other.tenantId, instance_id: other.instanceId, environment: 'live', credential_version: 2, account_id: randomUUID(), order_id: randomUUID() };
    await rejects(() => attempt({ [field]: changes[field] }), '23503');
  });
test('attempt order and activation sequences and merchant numbers are unique', async () => {
  const a = await attempt();
  await rejects(() => attempt(), '23505');
  const activation = { kind: 'service_activation', order_id: null, sequence: activationSequence++ };
  await attempt(activation);
  await rejects(() => attempt(activation), '23505');
  await rejects(() => attempt({ ...activation, sequence: activationSequence++, merchant_trade_no: a.merchant_trade_no }), '23505');
  await attempt({ ...activation, sequence: 999 });
});
for (const field of Object.keys({ attempt_id: '', ...{ created_at: '' }, ...{ tenant_id: '', instance_id: '', kind: '', order_id: '', sequence: '', account_id: '', purpose: '', environment: '', merchant_id: '', credential_version: '', provider: '', profile: '', merchant_trade_no: '', amount_minor: '', currency: '' } }))
  test(`attempt identity ${field} cannot change`, async () => {
    const a = await attempt();
    const change = field.endsWith('_id') ? randomUUID() : field === 'created_at' ? new Date(0) : ['sequence', 'credential_version', 'amount_minor'].includes(field) ? 99 : 'changed';
    await rejects(() => q.query(`UPDATE commerce_payment_attempts SET ${field}=$2,version=version+1 WHERE attempt_id=$1`, [a.attempt_id, change]));
  });
test('attempt timestamps require a transition, and updates require version +1', async () => {
  const a = await attempt();
  for (const field of Object.values(stateTime))
    await rejects(() => q.query(`UPDATE commerce_payment_attempts SET ${field}=clock_timestamp(),version=version+1 WHERE attempt_id=$1`, [a.attempt_id]));
  await rejects(() => q.query("UPDATE commerce_payment_attempts SET state='paid',version=version+1 WHERE attempt_id=$1", [a.attempt_id]));
  await rejects(() => q.query('UPDATE commerce_payment_attempts SET version=version+2 WHERE attempt_id=$1', [a.attempt_id]));
  await rejects(() => q.query('DELETE FROM commerce_payment_attempts WHERE attempt_id=$1', [a.attempt_id]));
});
test('journal precedes handoff, and every timestamp and provider fact is set once', async () => {
  const a = await attempt();
  await rejects(() => q.query('UPDATE commerce_payment_attempts SET handed_off_at=clock_timestamp(),version=version+1 WHERE attempt_id=$1', [a.attempt_id]));
  await q.query('UPDATE commerce_payment_attempts SET journaled_at=clock_timestamp(),version=version+1 WHERE attempt_id=$1', [a.attempt_id]);
  await q.query('UPDATE commerce_payment_attempts SET handed_off_at=clock_timestamp(),version=version+1 WHERE attempt_id=$1', [a.attempt_id]);
  await q.query("UPDATE commerce_payment_attempts SET trade_no='TRADE123',payment_date=clock_timestamp(),payment_type='Credit_CreditCard',charge_fee_minor=0,gwsr='123',version=version+1 WHERE attempt_id=$1", [a.attempt_id]);
  for (const state of ['superseded', 'failed', 'paid', 'confirmed'])
    await transition(a.attempt_id, state);
  for (const field of ['journaled_at', 'handed_off_at', 'superseded_at', 'failed_at', 'paid_at', 'confirmed_at', 'trade_no', 'payment_date', 'payment_type', 'charge_fee_minor', 'gwsr'])
    await rejects(() => q.query(`UPDATE commerce_payment_attempts SET ${field}=NULL,version=version+1 WHERE attempt_id=$1`, [a.attempt_id]));
});
for (const [field, value] of [['trade_no', 'lower'], ['trade_no', 'A'.repeat(21)], ['payment_type', 'Credit-Card'], ['payment_type', 'a'.repeat(41)], ['charge_fee_minor', -1], ['gwsr', 'a'], ['gwsr', '1'.repeat(21)]] as const)
  test(`attempt fact shape ${field}: ${typeof value === 'string' ? value.length : value}`, async () => {
    const a = await attempt();
    await rejects(() => q.query(`UPDATE commerce_payment_attempts SET ${field}=$2,version=version+1 WHERE attempt_id=$1`, [a.attempt_id, value]));
  });
for (const changes of [{ source: 'query' }, { outcome: 'returned' }, { outcome: 'other' }, { dedupe_key: null }, { dedupe_key: 'bad' }, { body_sha256: 'BAD' }, { merchant_trade_no: 'lower' }, { trade_no: 'lower' }, { payment_type: 'x-y' }, { gwsr: 'a' }, { charge_fee_minor: -1 }, { trade_amt_minor: -1 }, { source: 'browser_return', outcome: 'returned' }])
  test(`event check ${JSON.stringify(changes)}`, async () => { await rejects(() => event(changes)); });
test('event account, attempt and credential provenance are enforced', async () => {
  const a = await attempt();
  for (const changes of [{ tenant_id: other.tenantId }, { instance_id: other.instanceId }, { credential_version: 2 }])
    await rejects(() => event(changes));
  await rejects(async () => { await event({ attempt_id: randomUUID() }); await q.query('SET CONSTRAINTS ALL IMMEDIATE'); }, '23503');
  await event({ attempt_id: a.attempt_id, credential_version: 1, rtn_code: 9999999999 });
});
test('notification dedupe is per account; browser returns do not have a dedupe key', async () => {
  const e = await event();
  await rejects(() => event({ dedupe_key: e.dedupe_key }), '23505');
  await event({ source: 'browser_return', outcome: 'returned', dedupe_key: null });
  await event({ source: 'browser_return', outcome: 'returned', dedupe_key: null });
});
test('events are immutable except for setting applied_at once', async () => {
  const e = await event();
  for (const field of ['source', 'outcome', 'merchant_trade_no', 'trade_no', 'rtn_code', 'simulate_paid', 'payment_type', 'trade_amt_minor', 'charge_fee_minor', 'gwsr', 'credential_version', 'body_sha256', 'dedupe_key', 'account_id', 'attempt_id', 'tenant_id', 'instance_id', 'event_id', 'received_at']) {
    const value = field.endsWith('_id') ? randomUUID() : field === 'rtn_code' || field === 'trade_amt_minor' || field === 'charge_fee_minor' || field === 'credential_version' ? 1 : field === 'simulate_paid' ? true : field === 'received_at' ? new Date(0) : 'changed';
    await rejects(() => q.query(`UPDATE commerce_hosted_payment_events SET ${field}=$2 WHERE event_id=$1`, [e.event_id, value]));
  }
  await q.query('UPDATE commerce_hosted_payment_events SET applied_at=clock_timestamp() WHERE event_id=$1', [e.event_id]);
  await rejects(() => q.query('UPDATE commerce_hosted_payment_events SET applied_at=NULL WHERE event_id=$1', [e.event_id]));
  await rejects(() => q.query("UPDATE commerce_hosted_payment_events SET applied_at=applied_at+interval '1 second' WHERE event_id=$1", [e.event_id]));
  await rejects(() => q.query('DELETE FROM commerce_hosted_payment_events WHERE event_id=$1', [e.event_id]));
});
test('due work keeps the earliest deadline, allows deletion and retains tenant provenance on conflict', async () => {
  const input = { tenantId: s.tenantId, instanceId: s.instanceId, kind: 'payment_query' as const, targetId: randomUUID(), dueAt: new Date('2030-01-02T00:00:00Z') };
  await scheduleDueWork(q, input);
  await scheduleDueWork(q, { ...input, dueAt: '2030-01-03T00:00:00Z' });
  await scheduleDueWork(q, { ...input, dueAt: '2030-01-01T00:00:00Z' });
  const rows = (await q.query('SELECT * FROM commerce_due_work WHERE target_id=$1', [input.targetId])).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].due_at.toISOString(), '2030-01-01T00:00:00.000Z');
  await assert.rejects(scheduleDueWork(q, { ...input, tenantId: other.tenantId, instanceId: other.instanceId }), { message: 'due_work_binding_invalid' });
  for (const change of ["attempts=-1", "kind='other'", "last_error='Unsafe value'", "last_error='" + 'a'.repeat(65) + "'"])
    await rejects(() => q.query(`UPDATE commerce_due_work SET ${change} WHERE target_id=$1`, [input.targetId]));
  await q.query('DELETE FROM commerce_due_work WHERE target_id=$1', [input.targetId]);
});
test('open exception replay, closing rules and a subsequent new case', async () => {
  const input = { tenantId: s.tenantId, instanceId: s.instanceId, orderId, kind: 'overpaid' as const, subjectKind: 'payment_attempt' as const, subjectId: randomUUID() };
  const a = await openException(q, input), b = await openException(q, input);
  assert.equal(a.case_id, b.case_id);
  assert.equal(a.responsible_party, 'retailer');
  assert.equal(a.due_at.getTime() - a.created_at.getTime(), 72 * 60 * 60 * 1000);
  for (const set of ["status='resolved'", "resolution_code='closed'", "resolution_note='note'", "due_at=clock_timestamp()", "kind='amount_mismatch'", "subject_id=gen_random_uuid()", "order_id=NULL", "responsible_party='buyer'", "status='resolved',resolution_code='BAD',resolution_note='',resolved_by_principal_id=$2", "status='resolved',resolution_code='closed',resolution_note=repeat('x',1001),resolved_by_principal_id=$2"])
    await rejects(() => q.query(`UPDATE commerce_exception_cases SET ${set},version=version+1,updated_at=clock_timestamp() WHERE case_id=$1`, set.includes('$2') ? [a.case_id, principalId] : [a.case_id]));
  await q.query("UPDATE commerce_exception_cases SET status='resolved',resolution_code='refunded',resolution_note='',resolved_by_principal_id=$2,version=version+1,updated_at=clock_timestamp() WHERE case_id=$1", [a.case_id, principalId]);
  for (const set of ["status='open'", "resolution_note='changed'", "version=version+1"])
    await rejects(() => q.query(`UPDATE commerce_exception_cases SET ${set} WHERE case_id=$1`, [a.case_id]));
  await rejects(() => q.query('DELETE FROM commerce_exception_cases WHERE case_id=$1', [a.case_id]));
  const c = await openException(q, input);
  assert.notEqual(c.case_id, a.case_id);
  await q.query("UPDATE commerce_exception_cases SET status='dismissed',resolution_code='duplicate',resolution_note='',resolved_by_principal_id=$2,version=version+1,updated_at=clock_timestamp() WHERE case_id=$1", [c.case_id, principalId]);
});
test('exception kind policies cover all payment cases and contain actionable retailer defaults', () => {
  assert.equal(Object.keys(PAYMENT_EXCEPTION_POLICIES).length, 7);
  for (const policy of Object.values(PAYMENT_EXCEPTION_POLICIES)) {
    assert.equal(policy.due_hours, 72);
    assert.equal(policy.responsible_party, 'retailer');
    assert(['refund_payment', 'allocate_or_refund', 'check_with_provider', 'contact_provider'].includes(policy.next_action));
  }
});
test('exception cases have tenant RLS for unbound, bound and foreign contexts', async () => {
  await x.tx(async (c) => { assert.equal((await c.query('SELECT * FROM commerce_exception_cases WHERE case_id=$1', [rlsCase])).rowCount, 0); await bindStore(c, s.tenantId); assert.equal((await c.query('SELECT * FROM commerce_exception_cases WHERE case_id=$1', [rlsCase])).rowCount, 1); await bindStore(c, other.tenantId); assert.equal((await c.query('SELECT * FROM commerce_exception_cases WHERE case_id=$1', [rlsCase])).rowCount, 0); });
  await assert.rejects(x.tx(async (c) => { await bindStore(c, other.tenantId); return openException(c, { tenantId: s.tenantId, instanceId: s.instanceId, kind: 'overpaid', subjectKind: 'payment_event', subjectId: randomUUID() }); }), { code: '42501' });
});
test('schema169 preserves the separate imported-payment table and its imported-only constraint', async () => {
  const columns = (await q.query(`SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema()
    AND table_name='commerce_payment_events' ORDER BY ordinal_position`)).rows.map(r => r.column_name);
  assert.deepEqual(columns, ['event_id', 'shop_id', 'external_event_id', 'request_sha256', 'order_id', 'transfer_id', 'event_type', 'provider', 'transaction_ref', 'amount_minor', 'evidence_source', 'created_at', 'order_profile']);
  const constraints = (await q.query(`SELECT conname,pg_get_constraintdef(oid) AS definition FROM pg_constraint
    WHERE conrelid='commerce_payment_events'::regclass`)).rows;
  assert(constraints.some(r => r.definition.includes('CHECK') && r.definition.includes('order_profile') && r.definition.includes('imported_reseller')));
  assert(constraints.some(r => r.conname === 'commerce_payment_imported_order' && r.definition.includes('FOREIGN KEY (order_id, order_profile)')));
});
for (const column of ['journaled_at', 'paid_at', 'failed_at', 'superseded_at', 'expired_at'])
  test(`attempt rejects ${column} before creation`, async () => {
    const a = await attempt();
    const state = Object.entries(stateTime).find(([, field]) => field === column)?.[0];
    await rejects(() => q.query(`UPDATE commerce_payment_attempts SET ${column}=created_at-interval '1 second',version=version+1${state ? ',state=$2' : ''} WHERE attempt_id=$1`, state ? [a.attempt_id, state] : [a.attempt_id]));
  });
test('handoff and confirmation cannot precede their prerequisites, expiry is set once', async () => {
  const a = await attempt();
  await q.query('UPDATE commerce_payment_attempts SET journaled_at=clock_timestamp(),version=version+1 WHERE attempt_id=$1', [a.attempt_id]);
  await rejects(() => q.query("UPDATE commerce_payment_attempts SET handed_off_at=journaled_at-interval '1 second',version=version+1 WHERE attempt_id=$1", [a.attempt_id]));
  await transition(a.attempt_id, 'expired_unpaid');
  await rejects(() => q.query('UPDATE commerce_payment_attempts SET expired_at=NULL,version=version+1 WHERE attempt_id=$1', [a.attempt_id]));
  await transition(a.attempt_id, 'paid');
  await rejects(() => q.query("UPDATE commerce_payment_attempts SET state='confirmed',confirmed_at=paid_at-interval '1 second',version=version+1 WHERE attempt_id=$1", [a.attempt_id]));
});
test('attempt and hosted event primary keys are unique', async () => {
  const a = await attempt();
  await rejects(() => attempt({ attempt_id: a.attempt_id, sequence: 2 }), '23505');
  const e = await event();
  await rejects(() => event({ event_id: e.event_id }), '23505');
});
test('all notification outcomes and browser returns are admitted by the source check', async () => {
  for (const outcome of ['paid', 'failed', 'pending_confirmation', 'simulated'])
    await event({ outcome });
  await event({ source: 'browser_return', outcome: 'returned', dedupe_key: null });
  const e = await event();
  await rejects(() => q.query("UPDATE commerce_hosted_payment_events SET applied_at=received_at-interval '1 second' WHERE event_id=$1", [e.event_id]));
  const a = await attempt();
  await rejects(() => q.query('UPDATE commerce_hosted_payment_events SET payment_date=clock_timestamp() WHERE event_id=$1', [e.event_id]));
  await event({ attempt_id: a.attempt_id });
});
test('due work enforces its primary key, store FK and both kinds', async () => {
  const row = { tenant_id: s.tenantId, instance_id: s.instanceId, kind: 'payment_query', target_id: randomUUID(), due_at: new Date() };
  const a = await insert('commerce_due_work', row);
  await rejects(() => insert('commerce_due_work', { ...row, target_id: randomUUID(), due_work_id: a.due_work_id }), '23505');
  await rejects(() => insert('commerce_due_work', { ...row, target_id: randomUUID(), tenant_id: other.tenantId }), '23503');
  await insert('commerce_due_work', { ...row, kind: 'payment_window_end' });
  await insert('commerce_due_work', { ...row, kind: 'email' });
  await rejects(() => insert('commerce_due_work', row), '23505');
});
const caseInput = () => ({ tenant_id: s.tenantId, instance_id: s.instanceId, order_id: orderId, kind: 'overpaid', subject_kind: 'payment_attempt', subject_id: randomUUID(), responsible_party: 'retailer', due_at: new Date(), opened_by_kind: 'system' });
for (const [field, value] of [['kind', 'other'], ['subject_kind', 'other'], ['responsible_party', 'other'], ['opened_by_kind', 'other'], ['opened_by_kind', 'person'], ['opened_by_principal_id', 'principal'], ['status', 'resolved'], ['status', 'other'], ['resolution_code', 'closed'], ['resolution_note', 'note'], ['resolved_by_principal_id', 'principal'], ['version', 0], ['version', 2]] as const)
  test(`exception insertion check ${field} ${value}`, async () => {
    await rejects(() => insert('commerce_exception_cases', { ...caseInput(), [field]: value === 'principal' ? principalId : value }));
  });
test('exception FKs and original order/store binding are enforced', async () => {
  await rejects(() => insert('commerce_exception_cases', { ...caseInput(), order_id: randomUUID() }));
  await rejects(() => insert('commerce_exception_cases', { ...caseInput(), tenant_id: other.tenantId, instance_id: other.instanceId }));
  await rejects(() => insert('commerce_exception_cases', { ...caseInput(), instance_id: randomUUID(), order_id: null }), '23503');
  await rejects(() => insert('commerce_exception_cases', { ...caseInput(), opened_by_kind: 'person', opened_by_principal_id: randomUUID() }), '23503');
  await rejects(() => insert('commerce_exception_cases', { ...caseInput(), executor_tenant_id: randomUUID() }), '23503');
  const a = await insert('commerce_exception_cases', caseInput());
  await rejects(() => insert('commerce_exception_cases', { ...caseInput(), case_id: a.case_id }), '23505');
  await rejects(() => insert('commerce_exception_cases', { ...caseInput(), subject_id: a.subject_id }), '23505');
  await rejects(() => q.query("UPDATE commerce_exception_cases SET status='resolved',resolution_code='closed',resolution_note='',resolved_by_principal_id=$2,version=version+1 WHERE case_id=$1", [a.case_id, randomUUID()]), '23503');
});
for (const field of ['tenant_id', 'instance_id', 'case_id', 'executor_tenant_id', 'opened_by_principal_id', 'created_at'])
  test(`exception identity ${field} is immutable`, async () => {
    const a = await insert('commerce_exception_cases', caseInput());
    await rejects(() => q.query(`UPDATE commerce_exception_cases SET ${field}=$2,status='resolved',resolution_code='closed',resolution_note='',resolved_by_principal_id=$3,updated_at=clock_timestamp(),version=version+1 WHERE case_id=$1`, [a.case_id, field === 'created_at' ? new Date(0) : randomUUID(), principalId]));
  });


test('review 12: a paid attempt requires trade_no', async () => {
  const a = await attempt();
  await rejects(() => q.query("UPDATE commerce_payment_attempts SET state='paid',paid_at=clock_timestamp(),payment_date=clock_timestamp(),version=version+1 WHERE attempt_id=$1", [a.attempt_id]));
});
for (const missing of ['trade_no', 'payment_date', 'trade_amt_minor'] as const)
  test(`review 12: a paid event requires ${missing}`, async () => {
    await rejects(() => event({ trade_no: 'SYNTHETIC', payment_date: new Date(), trade_amt_minor: 500, [missing]: null }));
  });


test('review 13: attempt amount accepts the protocol maximum and rejects one TWD more', async () => {
  assert.equal((await attempt({ amount_minor: 99999999900 })).amount_minor, '99999999900');
  await rejects(() => attempt({ sequence: 2, amount_minor: 100000000000 }));
});
test('review 13: event amount accepts the protocol maximum and rejects one TWD more', async () => {
  assert.equal((await event({ trade_amt_minor: 99999999900 })).trade_amt_minor, '99999999900');
  await rejects(() => event({ trade_amt_minor: 100000000000 }));
});


test('review 14: unused attempt journal and handoff partial indexes are absent', async () => {
  const unused = await q.query(`SELECT indexname FROM pg_indexes WHERE schemaname=current_schema()
    AND indexname=ANY($1::text[]) ORDER BY indexname`, [['commerce_payment_attempt_unjournaled', 'commerce_payment_attempt_unhanded']]);
  assert.deepEqual(unused.rows, []);
});

test('only one order attempt is issued; superseding it permits the next sequence', async () => {
  const first = await attempt();
  await rejects(() => attempt({ sequence: 2 }), '23505');
  await transition(first.attempt_id, 'superseded');
  await attempt({ sequence: 2 });
  await rejects(() => attempt({ sequence: 3 }), '23505');
});
test('query paid facts allow an absent PaymentDate while notification paid facts require it', async () => {
  const a = await attempt();
  await q.query("UPDATE commerce_payment_attempts SET state='paid',paid_at=clock_timestamp(),trade_no='SYNTHETIC',version=version+1 WHERE attempt_id=$1", [a.attempt_id]);
  await transition(a.attempt_id, 'confirmed');
  assert.equal((await q.query('SELECT payment_date FROM commerce_payment_attempts WHERE attempt_id=$1', [a.attempt_id])).rows[0].payment_date, null);
  const result = await event({ source: 'query', query_trigger: 'schedule', credential_version: 1, dedupe_key: null, payment_date: null });
  assert.equal(result.payment_date, null);
  await rejects(() => event({ payment_date: null }));
  for (const missing of ['trade_no', 'trade_amt_minor'])
    await rejects(() => event({ source: 'query', query_trigger: 'schedule', credential_version: 1, dedupe_key: null, [missing]: null }));
});
const queryEvent = (changes: Record<string, unknown> = {}) => event({ source: 'query', outcome: 'unpaid', query_trigger: 'schedule', dedupe_key: null, credential_version: 1, ...changes });
test('query outcome, trigger, unknown and verification facts are source-bound closed values', async () => {
  for (const outcome of ['paid', 'unpaid', 'failed', 'amount_mismatch', 'trade_no_mismatch'])
    await queryEvent({ outcome });
  for (const query_trigger of ['schedule', 'window_end', 'notification', 'browser_return', 'buyer', 'repay', 'activation'])
    await queryEvent({ query_trigger });
  for (const unknown_reason of ['missing_field', 'invalid_field', 'unrecognized_status'])
    await queryEvent({ outcome: 'unknown', unknown_reason, credential_version: null,
      unknown_field: unknown_reason === 'unrecognized_status' ? null : 'TradeAmt', trade_status: '999', handling_charge_minor: 0 });
  // Every verified query is retained, even when its response bytes are identical.
  const one = await queryEvent({ body_sha256: 'a'.repeat(64) });
  const two = await queryEvent({ body_sha256: one.body_sha256 });
  assert.notEqual(one.event_id, two.event_id);
  for (const changes of [
    { outcome: 'pending_confirmation' }, { outcome: 'returned' }, { outcome: 'simulated' },
    { dedupe_key: 'a'.repeat(64) }, { query_trigger: null }, { query_trigger: 'other' },
    { trade_status: '' }, { trade_status: 'a' }, { trade_status: '1'.repeat(11) },
    { handling_charge_minor: -1 }, { unknown_reason: 'missing_field' }, { unknown_field: 'TradeAmt' },
    { outcome: 'unknown', credential_version: null },
    { outcome: 'unknown', unknown_reason: 'mac_mismatch', credential_version: null },
    { outcome: 'unknown', unknown_reason: 'missing_field' },
    { outcome: 'unknown', unknown_reason: 'unrecognized_status', credential_version: null, unknown_field: 'TradeAmt' },
    { outcome: 'unknown', unknown_reason: 'invalid_field', credential_version: null, unknown_field: 'Trade_Amt' },
    { outcome: 'unknown', unknown_reason: 'invalid_field', credential_version: null, unknown_field: 'a'.repeat(41) },
    { credential_version: null },
  ]) await rejects(() => queryEvent(changes));
  for (const fields of [{ trade_status: '0' }, { handling_charge_minor: 0 }, { unknown_reason: 'missing_field' }, { unknown_field: 'TradeAmt' }, { query_trigger: 'buyer' }]) {
    await rejects(() => event(fields));
    await rejects(() => event({ source: 'browser_return', outcome: 'returned', dedupe_key: null, ...fields }));
  }
});
test('due work separates consecutive failures from runs and limits errors to fixed codes', async () => {
  const input = { tenantId: s.tenantId, instanceId: s.instanceId, kind: 'payment_query' as const, targetId: randomUUID(), dueAt: new Date() };
  await scheduleDueWork(q, input);
  const row = (await q.query('SELECT failure_count,last_query_at FROM commerce_due_work WHERE target_id=$1', [input.targetId])).rows[0];
  assert.deepEqual(row, { failure_count: 0, last_query_at: null });
  await rejects(() => q.query('UPDATE commerce_due_work SET failure_count=-1 WHERE target_id=$1', [input.targetId]));
  await rejects(() => q.query("UPDATE commerce_due_work SET last_error='provider_secret' WHERE target_id=$1", [input.targetId]));
  for (const code of ['timeout', 'network', 'response_too_large', 'http_status', 'http_403', 'verify_failed', 'merchant_mismatch', 'merchant_trade_no_mismatch', 'platform_mismatch', 'keyring_unavailable', 'credential_unavailable', 'throttled', 'tenant_inactive', 'environment_mismatch', 'internal'])
    await q.query('UPDATE commerce_due_work SET last_error=$2,failure_count=2,attempts=5,last_query_at=clock_timestamp() WHERE target_id=$1', [input.targetId, code]);
});
test('trade number mismatches can retain a contradicting-event case on a payment attempt', async () => {
  const a = await attempt();
  const result = await openException(q, { tenantId: s.tenantId, instanceId: s.instanceId, orderId,
    kind: 'contradicting_event', subjectKind: 'payment_attempt', subjectId: a.attempt_id });
  assert.equal(result.subject_id, a.attempt_id);
});
test('retired payment services retain query throttles without reopening their lifecycle', async () => {
  await q.query("UPDATE commerce_provider_account_services SET state='retired',version=version+1,updated_at=clock_timestamp() WHERE account_id=$1 AND purpose='payment'", [accountId]);
  await q.query("UPDATE commerce_provider_account_services SET throttled_until=clock_timestamp()+interval '30 minutes',version=version+1,updated_at=clock_timestamp() WHERE account_id=$1 AND purpose='payment'", [accountId]);
  const row = (await q.query("SELECT state,credential_version,throttled_until>clock_timestamp() AS throttled FROM commerce_provider_account_services WHERE account_id=$1 AND purpose='payment'", [accountId])).rows[0];
  assert.deepEqual(row, { state: 'retired', credential_version: 1, throttled: true });
  await rejects(() => q.query("UPDATE commerce_provider_account_services SET state='draft',version=version+1,updated_at=clock_timestamp() WHERE account_id=$1 AND purpose='payment'", [accountId]));
  await rejects(() => q.query("UPDATE commerce_provider_account_services SET credential_version=2,version=version+1,updated_at=clock_timestamp() WHERE account_id=$1 AND purpose='payment'", [accountId]));
  await rejects(() => q.query("UPDATE commerce_provider_account_services SET version=version+1,updated_at=clock_timestamp() WHERE account_id=$1 AND purpose='payment'", [accountId]));
});
