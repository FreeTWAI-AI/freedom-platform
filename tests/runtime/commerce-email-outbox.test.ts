import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, before, beforeEach, describe, test } from 'node:test';
import type { PoolClient } from 'pg';
import { hostedPaymentHarness } from '../e2e/hosted-payment-fixture.js';
import { EcpayKeyPair, encodeForm, signFields } from '../../modules/agent-commerce/providers/ecpay/index.js';
import { createFixtureQueryTransport } from '../../modules/agent-commerce/payments/query-transport.js';
import { queryAttempt } from '../../modules/agent-commerce/payments/queries.js';
import { applyDeferredPaymentEvents } from '../../modules/agent-commerce/payments/events.js';
import { applyConfirmedPayment } from '../../modules/agent-commerce/checkout/payments.js';
import { cancelUnpaidOrder } from '../../modules/agent-commerce/checkout/orders.js';
import { checkoutInventory } from '../../modules/agent-commerce/checkout/inventory.js';
import { bindStore, lockMachineOrder } from '../../modules/agent-commerce/checkout/authority.js';
import { lockCheckoutOrders } from '../../modules/agent-commerce/checkout/orders.js';
import { queueCommerceEmail, commerceEmailOutbox } from '../../modules/agent-commerce/operations/notifications/outbox.js';
import { scheduleDueWork } from '../../modules/agent-commerce/operations/due-work.js';
import { TENANT_DATA_CATALOG } from '../../modules/module-data/catalog.js';

describe('commerce email outbox schema, queueing and B10', () => {
  let f: Awaited<ReturnType<typeof hostedPaymentHarness>>;
  type Placed = Awaited<ReturnType<typeof f.placed>>;

  before(async () => {
    f = await hostedPaymentHarness('fp_email_outbox', { publicSchema: true });
  });

  beforeEach(async () => {
    await f.reset();
    f.settings.emailEnabled = true;
    f.install();
  });

  after(async () => {
    await f?.stop();
  });

  async function rejects(q: PoolClient, run: () => Promise<unknown>, code = '23514') {
    await q.query('SAVEPOINT invalid_write');
    await assert.rejects(run, { code });
    await q.query('ROLLBACK TO SAVEPOINT invalid_write');
  }

  async function createConfirmedApplication(q: PoolClient, p: Placed) {
    return applyConfirmedPayment(q, {
      orderId: p.order.order_ref,
      paymentRef: p.payment.attempt_ref,
      amountMinor: p.order.total_minor,
      currency: 'TWD',
      simulated: false,
    });
  }

  test('catalog entry registers commerce_outbound_emails as an exempt commerce table', () => {
    const dc08 = TENANT_DATA_CATALOG.datasets.find(d => d.dataset_key === 'DC-08');
    assert(dc08, 'DC-08 must exist in TENANT_DATA_CATALOG');
    const entry = dc08.physical_locations.find(
      loc => loc.kind === 'table' && loc.table === 'commerce_outbound_emails',
    );
    assert(entry && entry.kind === 'table', 'commerce_outbound_emails must be in DC-08 physical_locations');
    assert.equal(entry.isolation.rls, 'exempt');
    if (entry.isolation.rls === 'exempt') {
      assert.equal(entry.isolation.reason_code, 'commerce_profile_participant_acl');
      assert(entry.isolation.reason.length > 20);
    }
    assert.deepEqual(entry.tenant_resolution, { kind: 'direct', column: 'tenant_id' });
  });

  test('schema CHECK constraints, trigger rules, unique keys, identity immutability, journaled_at once and retention delete', async () => {
    const p = await f.placed();
    const other = await f.x.store();
    const otherOrder = await f.x.place(other, await f.x.frozen(other));
    const app = await f.x.tx(q => createConfirmedApplication(q, p));

    const q = await f.x.h.pool.connect();
    await q.query('BEGIN');
    try {
      const baseRow = (overrides: Record<string, unknown> = {}) => ({
        tenant_id: p.s.tenantId,
        instance_id: p.s.instanceId,
        order_id: p.order.order_ref,
        template: 'order_confirmed',
        application_id: app.application_id,
        access_request_id: null,
        ...overrides,
      });

      const insertRow = async (overrides: Record<string, unknown> = {}, expiryInterval = "interval '7 days'") => {
        const row = baseRow(overrides);
        const cols = Object.keys(row);
        const vals = Object.values(row);
        return (
          await q.query(
            `INSERT INTO commerce_outbound_emails(${cols.join(',')},created_at,updated_at,expires_at)
             SELECT ${cols.map((_, i) => '$' + (i + 1)).join(',')},t,t,t+${expiryInterval}
             FROM (SELECT clock_timestamp() AS t) c RETURNING *`,
            vals,
          )
        ).rows[0];
      };

      // Invalid templates, states, attempts, last_error, expiry interval
      for (const bad of [
        { template: 'unknown_template' },
        { template: 'order_confirmed', application_id: null, access_request_id: null },
        { template: 'order_confirmed', application_id: app.application_id, access_request_id: randomUUID() },
        { template: 'paid_unallocatable', application_id: null, access_request_id: randomUUID() },
        { template: 'order_access', application_id: app.application_id, access_request_id: null },
        { template: 'order_access', application_id: app.application_id, access_request_id: randomUUID() },
        { state: 'sent' },
        { state: 'suppressed' },
        { state: 'expired' },
        { state: 'failed' },
        { state: 'other' },
        { attempts: -1 },
        { attempts: 1 },
        { last_error: 'rate_limited' },
        { last_error: 'Bad_Case' },
        { last_error: 'a'.repeat(65) },
        { journaled_at: new Date() },
        { sent_at: new Date() },
      ]) {
        await rejects(q, () => insertRow(bad));
      }
      await rejects(q, () => insertRow({}, "interval '6 days'"));

      // Order and application provenance checks in BEFORE INSERT trigger (raises 23514 before FK check)
      await rejects(q, () => insertRow({ order_id: otherOrder.order_id }));
      const otherApp = await f.x.tx(c =>
        applyConfirmedPayment(c, {
          orderId: otherOrder.order_id,
          paymentRef: randomUUID(),
          amountMinor: 100,
          currency: 'TWD',
          simulated: false,
        }),
      );
      await rejects(q, () => insertRow({ application_id: otherApp.application_id }));
      await rejects(q, () => insertRow({ tenant_id: other.tenantId, instance_id: p.s.instanceId }));
      await rejects(q, () => insertRow({ order_id: randomUUID() }));
      await rejects(q, () => insertRow({ application_id: randomUUID() }));

      // Valid inserts and UNIQUE keys: (application_id, template) and (access_request_id)
      const confirmedRow = await insertRow({ template: 'order_confirmed', application_id: app.application_id });
      await rejects(q, () => insertRow({ template: 'order_confirmed', application_id: app.application_id }), '23505');
      const unallocRow = await insertRow({ template: 'paid_unallocatable', application_id: app.application_id });
      assert.notEqual(unallocRow.email_id, confirmedRow.email_id);

      const accessReqId = randomUUID();
      const accessRow = await insertRow({
        template: 'order_access',
        application_id: null,
        access_request_id: accessReqId,
      });
      await rejects(
        q,
        () => insertRow({ template: 'order_access', application_id: null, access_request_id: accessReqId }),
        '23505',
      );

      // commerce_due_work accepts kind = 'email'
      await scheduleDueWork(q, {
        tenantId: p.s.tenantId,
        instanceId: p.s.instanceId,
        kind: 'email',
        targetId: confirmedRow.email_id,
        dueAt: new Date(),
      });

      // Identity immutability on UPDATE
      for (const [col, val] of [
        ['email_id', randomUUID()],
        ['tenant_id', other.tenantId],
        ['instance_id', other.instanceId],
        ['order_id', otherOrder.order_id],
        ['template', 'paid_unallocatable'],
        ['application_id', null],
        ['access_request_id', randomUUID()],
        ['created_at', new Date(0)],
        ['expires_at', new Date(0)],
      ] as const) {
        await rejects(q, () =>
          q.query(`UPDATE commerce_outbound_emails SET ${col} = $2 WHERE email_id = $1`, [confirmedRow.email_id, val]),
        );
      }

      // Sent requires both journaled_at and sent_at; non-sent forbids sent_at
      await rejects(q, () =>
        q.query("UPDATE commerce_outbound_emails SET state = 'sent', sent_at = clock_timestamp() WHERE email_id = $1", [
          confirmedRow.email_id,
        ]),
      );
      await rejects(q, () =>
        q.query("UPDATE commerce_outbound_emails SET sent_at = clock_timestamp() WHERE email_id = $1", [
          confirmedRow.email_id,
        ]),
      );

      // journaled_at can be set at most once
      await q.query('UPDATE commerce_outbound_emails SET journaled_at = clock_timestamp() WHERE email_id = $1', [
        confirmedRow.email_id,
      ]);
      await rejects(q, () =>
        q.query('UPDATE commerce_outbound_emails SET journaled_at = NULL WHERE email_id = $1', [confirmedRow.email_id]),
      );
      await rejects(q, () =>
        q.query(
          "UPDATE commerce_outbound_emails SET journaled_at = journaled_at + interval '1 second' WHERE email_id = $1",
          [confirmedRow.email_id],
        ),
      );

      // Transition to sent and verify closed rows cannot be updated
      await q.query(
        "UPDATE commerce_outbound_emails SET state = 'sent', sent_at = clock_timestamp(), updated_at = clock_timestamp() WHERE email_id = $1",
        [confirmedRow.email_id],
      );
      for (const sql of [
        "UPDATE commerce_outbound_emails SET state = 'queued', sent_at = NULL WHERE email_id = $1",
        "UPDATE commerce_outbound_emails SET attempts = attempts + 1 WHERE email_id = $1",
        "UPDATE commerce_outbound_emails SET last_error = 'send_failed' WHERE email_id = $1",
      ]) {
        await rejects(q, () => q.query(sql, [confirmedRow.email_id]));
      }

      // Delete rules: queued row cannot be deleted even if old; closed row cannot be deleted before 45 days
      await q.query(
        "UPDATE commerce_outbound_emails SET updated_at = clock_timestamp() - interval '46 days' WHERE email_id = $1",
        [accessRow.email_id],
      );
      await rejects(q, () =>
        q.query('DELETE FROM commerce_outbound_emails WHERE email_id = $1', [accessRow.email_id]),
      );
      await rejects(q, () =>
        q.query('DELETE FROM commerce_outbound_emails WHERE email_id = $1', [confirmedRow.email_id]),
      );

      // Closed row past 45 days can be deleted
      await q.query(
        "UPDATE commerce_outbound_emails SET state = 'expired', updated_at = clock_timestamp() - interval '45 days' - interval '1 second' WHERE email_id = $1",
        [unallocRow.email_id],
      );
      const deleted = await q.query('DELETE FROM commerce_outbound_emails WHERE email_id = $1', [unallocRow.email_id]);
      assert.equal(deleted.rowCount, 1);
    } finally {
      await q.query('ROLLBACK');
      q.release();
    }
  });

  async function signedNotification(p: Placed, overrides: Record<string, string> = {}) {
    const a = (
      await f.x.h.pool.query('SELECT merchant_trade_no FROM commerce_payment_attempts WHERE attempt_id=$1', [
        p.payment.attempt_ref,
      ])
    ).rows[0];
    return encodeForm(
      signFields(
        {
          MerchantID: '1234567',
          MerchantTradeNo: a.merchant_trade_no,
          TradeNo: 'T' + randomBytes(8).toString('hex').toUpperCase(),
          RtnCode: '1',
          RtnMsg: '合成付款結果',
          TradeAmt: String(p.order.total_minor / 100),
          SimulatePaid: '0',
          PaymentDate: '2026/10/15 10:20:30',
          PaymentType: 'Credit_CreditCard',
          PaymentTypeChargeFee: '0.3',
          gwsr: '12345',
          ...overrides,
        },
        EcpayKeyPair.of(p.provider.material.hash_key, p.provider.material.hash_iv),
        'sha256',
      ),
    );
  }

  async function postCallback(p: Placed, body: string) {
    const request = new Request(f.origin + '/api/v1/provider-callbacks/ecpay/' + p.provider.accountRef + '/payment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'CF-Connecting-IP': '192.0.2.1' },
      body,
    });
    Object.defineProperty(request, 'cf', { value: { colo: 'TEST' } });
    return f.app.fetch(request);
  }

  test('queueing: converted, allocated and unallocatable queue the right template; other outcomes and flag-off queue nothing', async () => {
    const freshPlaced = async () => {
      await f.x.h.pool.query('DELETE FROM auth_rate_limits');
      return f.placed();
    };

    // 1. converted -> order_confirmed
    const pConverted = await freshPlaced();
    const resConverted = await postCallback(pConverted, await signedNotification(pConverted));
    assert.equal(resConverted.status, 200);
    let emails = (
      await f.x.h.pool.query('SELECT * FROM commerce_outbound_emails WHERE order_id = $1', [pConverted.order.order_ref])
    ).rows;
    assert.equal(emails.length, 1);
    assert.equal(emails[0].template, 'order_confirmed');
    assert.equal(emails[0].state, 'queued');
    let due = (
      await f.x.h.pool.query("SELECT * FROM commerce_due_work WHERE kind = 'email' AND target_id = $1", [
        emails[0].email_id,
      ])
    ).rows;
    assert.equal(due.length, 1);

    // 2. allocated (holds released while stock remains available) -> order_confirmed
    const pAllocated = await freshPlaced();
    await f.x.tx(async q => {
      await lockMachineOrder(q, pAllocated.order.order_ref);
      await lockCheckoutOrders(q, [pAllocated.order.order_ref]);
      await (await checkoutInventory(q, pAllocated.order.order_ref)).releaseHolds();
    });
    await postCallback(pAllocated, await signedNotification(pAllocated));
    emails = (
      await f.x.h.pool.query('SELECT * FROM commerce_outbound_emails WHERE order_id = $1', [pAllocated.order.order_ref])
    ).rows;
    assert.equal(emails.length, 1);
    assert.equal(emails[0].template, 'order_confirmed');

    // 3. unallocatable (holds released and stock exhausted) -> paid_unallocatable
    const pUnalloc = await freshPlaced();
    await f.x.tx(async q => {
      await lockMachineOrder(q, pUnalloc.order.order_ref);
      await lockCheckoutOrders(q, [pUnalloc.order.order_ref]);
      await (await checkoutInventory(q, pUnalloc.order.order_ref)).releaseHolds();
      await q.query('UPDATE commerce_items SET stock = reserved WHERE item_id = $1', [pUnalloc.s.product.product_id]);
    });
    await postCallback(pUnalloc, await signedNotification(pUnalloc));
    emails = (
      await f.x.h.pool.query('SELECT * FROM commerce_outbound_emails WHERE order_id = $1', [pUnalloc.order.order_ref])
    ).rows;
    assert.equal(emails.length, 1);
    assert.equal(emails[0].template, 'paid_unallocatable');

    // 4. simulated, amount_mismatch, after_cancel, overpaid -> none
    const pSim = await freshPlaced();
    await postCallback(pSim, await signedNotification(pSim, { SimulatePaid: '1' }));
    assert.equal(
      (await f.x.h.pool.query('SELECT count(*)::int n FROM commerce_outbound_emails WHERE order_id = $1', [pSim.order.order_ref]))
        .rows[0].n,
      0,
    );

    const pMismatch = await freshPlaced();
    await postCallback(pMismatch, await signedNotification(pMismatch, { TradeAmt: '999' }));
    assert.equal(
      (
        await f.x.h.pool.query('SELECT count(*)::int n FROM commerce_outbound_emails WHERE order_id = $1', [
          pMismatch.order.order_ref,
        ])
      ).rows[0].n,
      0,
    );

    const pCancelled = await freshPlaced();
    await f.x.tx(q => cancelUnpaidOrder(q, pCancelled.s, pCancelled.order.order_ref, 'system', 'payment_not_completed'));
    await postCallback(pCancelled, await signedNotification(pCancelled));
    assert.equal(
      (
        await f.x.h.pool.query('SELECT count(*)::int n FROM commerce_outbound_emails WHERE order_id = $1', [
          pCancelled.order.order_ref,
        ])
      ).rows[0].n,
      0,
    );

    // Overpaid: a second distinct payment application on the already-confirmed pConverted order
    await f.x.tx(async q => {
      const overpaidApp = await applyConfirmedPayment(q, {
        orderId: pConverted.order.order_ref,
        paymentRef: randomUUID(),
        amountMinor: pConverted.order.total_minor,
        currency: 'TWD',
        simulated: false,
      });
      assert.equal(overpaidApp.outcome, 'overpaid');
      const { queuePaymentOutcomeEmail } = await import(
        '../../modules/agent-commerce/operations/notifications/outbox.js'
      );
      await queuePaymentOutcomeEmail(q, commerceEmailOutbox, {
        tenantId: pConverted.s.tenantId,
        instanceId: pConverted.s.instanceId,
        application: overpaidApp,
      });
    });
    assert.equal(
      (
        await f.x.h.pool.query('SELECT count(*)::int n FROM commerce_outbound_emails WHERE order_id = $1', [
          pConverted.order.order_ref,
        ])
      ).rows[0].n,
      1,
    );

    // 5. Flag off -> none
    f.settings.emailEnabled = false;
    f.install();
    const pFlagOff = await freshPlaced();
    await postCallback(pFlagOff, await signedNotification(pFlagOff));
    assert.equal(
      (
        await f.x.h.pool.query('SELECT count(*)::int n FROM commerce_outbound_emails WHERE order_id = $1', [
          pFlagOff.order.order_ref,
        ])
      ).rows[0].n,
      0,
    );
  });

  test('replayed notification, query applying the same payment, and deferred events produce exactly one outbox row, and rollback leaves neither outbox nor due_work row', async () => {
    const p = await f.placed();
    await f.x.h.pool.query(
      'UPDATE commerce_payment_attempts SET journaled_at=clock_timestamp(),handed_off_at=clock_timestamp(),version=version+1 WHERE attempt_id=$1',
      [p.payment.attempt_ref],
    );
    const attempt = (
      await f.x.h.pool.query('SELECT * FROM commerce_payment_attempts WHERE attempt_id=$1', [p.payment.attempt_ref])
    ).rows[0];
    const queryBody = encodeForm(
      signFields(
        {
          MerchantID: '1234567',
          MerchantTradeNo: attempt.merchant_trade_no,
          TradeStatus: '1',
          TradeNo: 'T1234567',
          TradeAmt: String(p.order.total_minor / 100),
          PaymentDate: '2026/10/15 10:20:30',
          PaymentType: 'Credit_CreditCard',
          HandlingCharge: '0.2',
          PaymentTypeChargeFee: '0.3',
        },
        EcpayKeyPair.of(p.provider.material.hash_key, p.provider.material.hash_iv),
        'sha256',
      ),
    );
    const notifBody = await signedNotification(p, { TradeNo: 'T1234567' });

    // Notification followed by replay and query
    await postCallback(p, notifBody);
    await postCallback(p, notifBody);
    await queryAttempt(
      f.x.runtime,
      p.payment.attempt_ref,
      {
        transport: createFixtureQueryTransport(async () => ({ kind: 'response', status: 200, body: queryBody }), 'local'),
        keyring: f.ring,
        freedomEnv: 'local',
        email: commerceEmailOutbox,
      },
      'schedule',
    );
    let rows = (
      await f.x.h.pool.query('SELECT * FROM commerce_outbound_emails WHERE order_id = $1', [p.order.order_ref])
    ).rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].template, 'order_confirmed');

    // Query applying payment when quarantined notification is applied via applyDeferredPaymentEvents
    const p2 = await f.placed();
    f.settings.quarantine = true;
    await postCallback(p2, await signedNotification(p2));
    assert.equal(
      (await f.x.h.pool.query('SELECT count(*)::int n FROM commerce_outbound_emails WHERE order_id = $1', [p2.order.order_ref]))
        .rows[0].n,
      0,
    );
    f.settings.quarantine = false;
    await applyDeferredPaymentEvents(f.x.runtime, { email: commerceEmailOutbox });
    rows = (
      await f.x.h.pool.query('SELECT * FROM commerce_outbound_emails WHERE order_id = $1', [p2.order.order_ref])
    ).rows;
    assert.equal(rows.length, 1);

    // Forced rollback leaves neither commerce_outbound_emails nor commerce_due_work row
    const accessRequestId = randomUUID();
    await assert.rejects(
      f.x.tx(async q => {
        await bindStore(q, p.s.tenantId);
        const queued = await queueCommerceEmail(q, {
          template: 'order_access',
          tenantId: p.s.tenantId,
          instanceId: p.s.instanceId,
          orderId: p.order.order_ref,
          accessRequestId,
        });
        assert(queued?.emailId);
        throw new Error('forced_rollback');
      }),
      /forced_rollback/,
    );
    assert.equal(
      (
        await f.x.h.pool.query('SELECT count(*)::int n FROM commerce_outbound_emails WHERE access_request_id = $1', [
          accessRequestId,
        ])
      ).rows[0].n,
      0,
    );
    assert.equal(
      (
        await f.x.h.pool.query("SELECT count(*)::int n FROM commerce_due_work WHERE kind = 'email' AND target_id <> $1 AND target_id <> $2", [
          (await f.x.h.pool.query('SELECT email_id FROM commerce_outbound_emails WHERE order_id = $1', [p.order.order_ref])).rows[0].email_id,
          rows[0].email_id,
        ])
      ).rows[0].n,
      0,
    );
  });

  test('B10: flag off returns 409 before SQL; flag on returns 202 for match and no match, queues only on match, and charges all 3 budgets', async () => {
    const p = await f.placed();
    const b10Path = f.root(p.s) + '/order-access-requests';

    // Flag off -> 409 before any SQL
    f.settings.emailEnabled = false;
    f.install();
    const originalConnect = f.x.runtime.connect;
    f.x.runtime.connect = (() => {
      throw new Error('must_not_connect_when_email_disabled');
    }) as typeof f.x.runtime.connect;
    try {
      const offRes = await f.http('POST', b10Path, {
        email: 'buyer@example.test',
        display_number: p.order.display_number,
      });
      assert.equal(offRes.status, 409);
      assert.equal(offRes.data.code, 'order_access_email_unavailable');
    } finally {
      f.x.runtime.connect = originalConnect;
    }

    // Flag on -> 202 for no match, no row queued, 3 budgets charged
    f.settings.emailEnabled = true;
    f.install();
    const noMatchRes = await f.http('POST', b10Path, {
      email: 'nomatch@example.test',
      display_number: p.order.display_number,
    });
    assert.equal(noMatchRes.status, 202);
    assert.equal(noMatchRes.data, null);
    assert.equal(
      (await f.x.h.pool.query("SELECT count(*)::int n FROM commerce_outbound_emails WHERE template = 'order_access'")).rows[0]
        .n,
      0,
    );
    assert.equal(
      (await f.x.h.pool.query("SELECT count(*)::int n FROM auth_rate_limits WHERE bucket LIKE 'commerce:accessRequest%'"))
        .rows[0].n,
      3,
    );

    // Flag on -> 202 for match (contact email from x.input is buyer@example.test), 1 row queued + due_work row
    const contactEmail = (
      await f.x.h.pool.query('SELECT contact_email FROM commerce_checkout_contacts WHERE checkout_id = $1', [
        p.checkout.checkout_ref,
      ])
    ).rows[0].contact_email as string;
    const matchRes = await f.http('POST', b10Path, {
      email: '  ' + contactEmail.toUpperCase() + '  ',
      display_number: p.order.display_number,
    });
    assert.equal(matchRes.status, 202);
    assert.equal(matchRes.data, null);
    const outboxRows = (
      await f.x.h.pool.query("SELECT * FROM commerce_outbound_emails WHERE order_id = $1 AND template = 'order_access'", [
        p.order.order_ref,
      ])
    ).rows;
    assert.equal(outboxRows.length, 1);
    assert.equal(outboxRows[0].state, 'queued');
    assert(outboxRows[0].access_request_id);
    assert.equal(outboxRows[0].application_id, null);
    assert.equal(
      (
        await f.x.h.pool.query("SELECT count(*)::int n FROM commerce_due_work WHERE kind = 'email' AND target_id = $1", [
          outboxRows[0].email_id,
        ])
      ).rows[0].n,
      1,
    );
  });
});
