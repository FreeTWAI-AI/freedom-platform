import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import { after, before, beforeEach, describe, test } from 'node:test';
import { hostedPaymentHarness } from '../e2e/hosted-payment-fixture.js';
import { EcpayKeyPair, encodeForm, signFields } from '../../modules/agent-commerce/providers/ecpay/index.js';
import { createFixtureQueryTransport } from '../../modules/agent-commerce/payments/query-transport.js';
import { applyConfirmedPayment } from '../../modules/agent-commerce/checkout/payments.js';
import { bindStore } from '../../modules/agent-commerce/checkout/authority.js';
import { queueCommerceEmail, commerceEmailOutbox } from '../../modules/agent-commerce/operations/notifications/outbox.js';
import {
  deliverCommerceEmail,
  sweepCommerceOutboundEmails,
} from '../../modules/agent-commerce/operations/notifications/delivery.js';
import {
  CommerceEmailSendError,
  FixtureEmailSender,
  createWorkerEmailSender,
  type CloudflareEmailErrorCode,
  type CommerceEmailErrorCode,
  type CommerceEmailMessage,
} from '../../modules/agent-commerce/operations/notifications/email-port.js';
import { renderCommerceEmail } from '../../modules/agent-commerce/operations/notifications/templates.js';
import { runDueCommerceWork } from '../../modules/agent-commerce/operations/due-work.js';
import { MemoryEffectJournal } from '../../modules/agent-commerce/operations/journal/memory.js';
import type { EffectJournalPort, EffectRecord } from '../../modules/agent-commerce/operations/journal/journal.js';

describe('commerce email delivery, executor integration, sweep and worker sender', () => {
  let f: Awaited<ReturnType<typeof hostedPaymentHarness>>;
  type Placed = Awaited<ReturnType<typeof f.placed>>;

  before(async () => {
    f = await hostedPaymentHarness('fp_email_delivery', { publicSchema: true });
  });

  beforeEach(async () => {
    await f.reset();
    f.settings.emailEnabled = true;
    f.install();
  });

  after(async () => {
    await f?.stop();
  });

  async function freshPlaced() {
    await f.x.h.pool.query('DELETE FROM auth_rate_limits');
    return f.placed();
  }

  async function queueTemplate(
    p: Placed,
    template: 'order_confirmed' | 'paid_unallocatable' | 'order_access',
  ): Promise<string> {
    if (template === 'order_access') {
      const queued = await f.x.tx(async q => {
        await bindStore(q, p.s.tenantId);
        return queueCommerceEmail(q, {
          template: 'order_access',
          tenantId: p.s.tenantId,
          instanceId: p.s.instanceId,
          orderId: p.order.order_ref,
          accessRequestId: randomUUID(),
        });
      });
      assert(queued?.emailId);
      return queued.emailId;
    }
    const app = await f.x.tx(q =>
      applyConfirmedPayment(q, {
        orderId: p.order.order_ref,
        paymentRef: randomUUID(),
        amountMinor: p.order.total_minor,
        currency: 'TWD',
        simulated: false,
      }),
    );
    const queued = await f.x.tx(async q => {
      await bindStore(q, p.s.tenantId);
      return queueCommerceEmail(q, {
        template,
        tenantId: p.s.tenantId,
        instanceId: p.s.instanceId,
        orderId: p.order.order_ref,
        applicationId: app.application_id,
      });
    });
    assert(queued?.emailId);
    return queued.emailId;
  }

  test('full delivery path for all 3 templates: journal record without PII, journaled_at before send, rendered message, sent state, due-work deleted, and no DB client held during journal or send', async () => {
    const p = await freshPlaced();
    const sender = new FixtureEmailSender();
    const journal = new MemoryEffectJournal('local');

    for (const template of ['order_confirmed', 'paid_unallocatable', 'order_access'] as const) {
      const emailId = await queueTemplate(p, template);
      let sawJournaledBeforeSend = false;

      const checkedJournal: EffectJournalPort = {
        environment: 'local',
        async append(record: EffectRecord) {
          assert.equal(
            f.x.runtime.totalCount,
            f.x.runtime.idleCount,
            'no DB client may be checked out during journal append',
          );
          const beforeRow = (
            await f.x.h.pool.query('SELECT state, journaled_at, sent_at FROM commerce_outbound_emails WHERE email_id = $1', [
              emailId,
            ])
          ).rows[0];
          assert.equal(beforeRow.state, 'queued');
          assert.equal(beforeRow.journaled_at, null);
          assert.equal(beforeRow.sent_at, null);
          return journal.append(record);
        },
      };

      const checkedSender = {
        async send(msg: CommerceEmailMessage) {
          assert.equal(
            f.x.runtime.totalCount,
            f.x.runtime.idleCount,
            'no DB client may be checked out during email send',
          );
          const midRow = (
            await f.x.h.pool.query('SELECT state, journaled_at, sent_at FROM commerce_outbound_emails WHERE email_id = $1', [
              emailId,
            ])
          ).rows[0];
          assert.equal(midRow.state, 'queued');
          assert(midRow.journaled_at instanceof Date, 'journaled_at must be committed before send');
          assert.equal(midRow.sent_at, null);
          sawJournaledBeforeSend = true;
          return sender.send(msg);
        },
      };

      const counts = await runDueCommerceWork(
        f.x.runtime,
        {
          freedomEnv: 'local',
          origin: f.origin,
          emailEnabled: true,
          emailSender: checkedSender,
          journal: checkedJournal,
        },
        { targets: [emailId], limit: 1 },
      );
      assert.equal(counts.claimed, 1);
      assert.equal(counts.completed, 1);
      assert.equal(counts.externalCalls, 1);
      assert(sawJournaledBeforeSend);

      const afterRow = (
        await f.x.h.pool.query('SELECT * FROM commerce_outbound_emails WHERE email_id = $1', [emailId])
      ).rows[0];
      assert.equal(afterRow.state, 'sent');
      assert(afterRow.journaled_at instanceof Date);
      assert(afterRow.sent_at instanceof Date);
      assert.equal(afterRow.last_error, null);

      const dueCount = (
        await f.x.h.pool.query("SELECT count(*)::int n FROM commerce_due_work WHERE kind = 'email' AND target_id = $1", [
          emailId,
        ])
      ).rows[0].n;
      assert.equal(dueCount, 0);

      // Verify journal object key and non-PII body
      const datePrefix = afterRow.created_at.toISOString().slice(0, 10).replaceAll('-', '/');
      const expectedKey = `local/${datePrefix}/email_send/${emailId}`;
      const journalBody = journal.objects.get(expectedKey);
      assert(journalBody, `expected journal key ${expectedKey}`);
      assert(!journalBody.includes('@'), 'journal record must never contain an email address');
      assert(!journalBody.includes('#access='), 'journal record must never contain an access token');
      const parsedJournal = JSON.parse(journalBody);
      assert.equal(parsedJournal.kind, 'email_send');
      assert.equal(parsedJournal.id, emailId);
      assert.equal(parsedJournal.detail.order_id, p.order.order_ref);
      assert.equal(parsedJournal.detail.purpose, template);

      // Verify rendered subject & text match renderCommerceEmail
      const msg = sender.messages.at(-1)!;
      const urlMatch = msg.text.match(/https?:\/\/[^\s]+#access=([A-Za-z0-9_-]+)/);
      assert(urlMatch, 'sent message must contain an order access link');
      const token = urlMatch[1];
      const expectedRender =
        template === 'order_confirmed'
          ? renderCommerceEmail({
              template: 'order_confirmed',
              origin: f.origin,
              store: { slug: p.s.slug, name: p.order.store.name, contactEmail: null },
              displayNumber: p.order.display_number,
              orderRef: p.order.order_ref,
              accessToken: token,
              items: p.order.lines.map((l: { title: string; quantity: number }) => ({
                title: l.title,
                variantLabel: null,
                quantity: l.quantity,
              })),
              totalMinor: p.order.total_minor,
            })
          : renderCommerceEmail({
              template,
              origin: f.origin,
              store: { slug: p.s.slug, name: p.order.store.name, contactEmail: null },
              displayNumber: p.order.display_number,
              orderRef: p.order.order_ref,
              accessToken: token,
            });
      assert.equal(msg.subject, expectedRender.subject);
      assert.equal(msg.text, expectedRender.text);
      assert.equal(msg.replyTo, null);
    }
  });

  test('journal failure does not send, backs off with journal_unavailable, and a subsequent run sends', async () => {
    const p = await freshPlaced();
    const emailId = await queueTemplate(p, 'order_confirmed');
    const sender = new FixtureEmailSender();
    const journal = new MemoryEffectJournal('local');
    let failJournal = true;
    const flakyJournal: EffectJournalPort = {
      environment: 'local',
      async append(record) {
        if (failJournal) throw new Error('r2_down');
        return journal.append(record);
      },
    };

    const t0 = new Date();
    const logs: string[] = [];
    const origError = console.error;
    console.error = (...args: unknown[]) => logs.push(args.map(String).join(' '));
    try {
      const r1 = await runDueCommerceWork(
        f.x.runtime,
        {
          freedomEnv: 'local',
          origin: f.origin,
          now: () => t0,
          emailEnabled: true,
          emailSender: sender,
          journal: flakyJournal,
        },
        { targets: [emailId], limit: 1 },
      );
      assert.equal(r1.claimed, 1);
      assert.equal(r1.externalCalls, 0);
      assert.equal(sender.messages.length, 0);
    } finally {
      console.error = origError;
    }

    assert.equal(logs.length, 1);
    assert.deepEqual(JSON.parse(logs[0]), {
      event: 'commerce_email_failed',
      template: 'order_confirmed',
      code: 'journal_unavailable',
    });

    const row1 = (await f.x.h.pool.query('SELECT * FROM commerce_outbound_emails WHERE email_id = $1', [emailId])).rows[0];
    assert.equal(row1.state, 'queued');
    assert.equal(row1.attempts, 1);
    assert.equal(row1.last_error, 'journal_unavailable');
    assert.equal(row1.journaled_at, null);
    const due1 = (
      await f.x.h.pool.query("SELECT * FROM commerce_due_work WHERE kind = 'email' AND target_id = $1", [emailId])
    ).rows[0];
    assert.equal(due1.lease_until, null);
    assert.equal(due1.due_at.getTime(), t0.getTime() + 60_000);

    // Later run after backoff succeeds
    failJournal = false;
    const t1 = new Date(t0.getTime() + 60_000);
    const r2 = await runDueCommerceWork(
      f.x.runtime,
      {
        freedomEnv: 'local',
        origin: f.origin,
        now: () => t1,
        emailEnabled: true,
        emailSender: sender,
        journal: flakyJournal,
      },
      { targets: [emailId], limit: 1 },
    );
    assert.equal(r2.externalCalls, 1);
    assert.equal(sender.messages.length, 1);
    const row2 = (await f.x.h.pool.query('SELECT * FROM commerce_outbound_emails WHERE email_id = $1', [emailId])).rows[0];
    assert.equal(row2.state, 'sent');
    assert.equal(row2.last_error, null);
  });

  test('suppression on redacted contact or redacted customer, and expiry when expires_at <= now', async () => {
    const sender = new FixtureEmailSender();
    const journal = new MemoryEffectJournal('local');

    // 1. Redacted contact -> suppressed
    const pContact = await freshPlaced();
    const emailContact = await queueTemplate(pContact, 'order_confirmed');
    await f.x.h.pool.query(
      'UPDATE commerce_checkout_contacts SET contact_name=NULL,contact_email=NULL,contact_phone=NULL,delivery=NULL,invoice=NULL,contact_salt=NULL,redacted_at=clock_timestamp() WHERE checkout_id=$1',
      [pContact.checkout.checkout_ref],
    );
    await runDueCommerceWork(
      f.x.runtime,
      { freedomEnv: 'local', origin: f.origin, emailEnabled: true, emailSender: sender, journal },
      { targets: [emailContact], limit: 1 },
    );
    assert.equal(
      (await f.x.h.pool.query('SELECT state FROM commerce_outbound_emails WHERE email_id = $1', [emailContact])).rows[0]
        .state,
      'suppressed',
    );
    assert.equal(
      (await f.x.h.pool.query("SELECT count(*)::int n FROM commerce_due_work WHERE target_id = $1", [emailContact])).rows[0]
        .n,
      0,
    );

    // 2. Redacted customer -> suppressed
    const pCustomer = await freshPlaced();
    const emailCustomer = await queueTemplate(pCustomer, 'order_confirmed');
    await f.x.h.pool.query(
      "UPDATE commerce_customers SET email_normalized='redacted:'||customer_id::text,email_verified_at=NULL,member_principal_id=NULL,redacted_at=clock_timestamp() WHERE customer_id=(SELECT customer_id FROM commerce_checkout_orders WHERE order_id=$1)",
      [pCustomer.order.order_ref],
    );
    await runDueCommerceWork(
      f.x.runtime,
      { freedomEnv: 'local', origin: f.origin, emailEnabled: true, emailSender: sender, journal },
      { targets: [emailCustomer], limit: 1 },
    );
    assert.equal(
      (await f.x.h.pool.query('SELECT state FROM commerce_outbound_emails WHERE email_id = $1', [emailCustomer])).rows[0]
        .state,
      'suppressed',
    );
    assert.equal(
      (await f.x.h.pool.query("SELECT count(*)::int n FROM commerce_due_work WHERE target_id = $1", [emailCustomer])).rows[0]
        .n,
      0,
    );

    // 3. Expiry when now >= expires_at -> expired
    const pExpired = await freshPlaced();
    const emailExpired = await queueTemplate(pExpired, 'order_access');
    const expiresAt: Date = (
      await f.x.h.pool.query('SELECT expires_at FROM commerce_outbound_emails WHERE email_id = $1', [emailExpired])
    ).rows[0].expires_at;
    await runDueCommerceWork(
      f.x.runtime,
      {
        freedomEnv: 'local',
        origin: f.origin,
        now: () => expiresAt,
        emailEnabled: true,
        emailSender: sender,
        journal,
      },
      { targets: [emailExpired], limit: 1 },
    );
    assert.equal(
      (await f.x.h.pool.query('SELECT state FROM commerce_outbound_emails WHERE email_id = $1', [emailExpired])).rows[0]
        .state,
      'expired',
    );
    assert.equal(
      (await f.x.h.pool.query("SELECT count(*)::int n FROM commerce_due_work WHERE target_id = $1", [emailExpired])).rows[0]
        .n,
      0,
    );
    assert.equal(sender.messages.length, 0);
  });

  test('permanent and transient sender error codes, backoff schedule (1, 5, 15, 60, 60 min) and stop at expires_at', async () => {
    const p = await freshPlaced();
    const journal = new MemoryEffectJournal('local');

    // Permanent codes transition immediately to failed and delete due_work
    for (const [cfCode, expectedCode] of [
      ['E_VALIDATION_ERROR', 'invalid_message'],
      ['E_RECIPIENT_NOT_ALLOWED', 'recipient_not_allowed'],
      ['E_SENDER_NOT_VERIFIED', 'sender_not_verified'],
      ['E_TOO_MANY_RECIPIENTS', 'invalid_message'],
    ] as const) {
      const emailId = await queueTemplate(p, 'order_access');
      const sender = new FixtureEmailSender();
      sender.failNext(1, cfCode);
      const logs: string[] = [];
      const origError = console.error;
      console.error = (...args: unknown[]) => logs.push(args.map(String).join(' '));
      try {
        const res = await runDueCommerceWork(
          f.x.runtime,
          { freedomEnv: 'local', origin: f.origin, emailEnabled: true, emailSender: sender, journal },
          { targets: [emailId], limit: 1 },
        );
        assert.equal(res.externalCalls, 1);
      } finally {
        console.error = origError;
      }
      const row = (await f.x.h.pool.query('SELECT * FROM commerce_outbound_emails WHERE email_id = $1', [emailId])).rows[0];
      assert.equal(row.state, 'failed');
      assert.equal(row.attempts, 1);
      assert.equal(row.last_error, expectedCode);
      assert.equal(
        (await f.x.h.pool.query("SELECT count(*)::int n FROM commerce_due_work WHERE target_id = $1", [emailId])).rows[0].n,
        0,
      );
      assert.equal(logs.length, 1);
      assert(!logs[0].includes('@'));
      assert.deepEqual(JSON.parse(logs[0]), {
        event: 'commerce_email_failed',
        template: 'order_access',
        code: expectedCode,
      });
    }

    // Transient codes (E_RATE_LIMIT_EXCEEDED -> rate_limited, generic -> send_failed) follow 1, 5, 15, 60, 60m and clamp at expires_at
    const emailId = await queueTemplate(p, 'order_access');
    const initialRow = (
      await f.x.h.pool.query('SELECT created_at, expires_at FROM commerce_outbound_emails WHERE email_id = $1', [emailId])
    ).rows[0];
    let now = new Date(initialRow.created_at.getTime());

    const schedule: Array<{ rawError: CloudflareEmailErrorCode | 'send_failed'; expectedCode: CommerceEmailErrorCode; minutes: number }> = [
      { rawError: 'E_RATE_LIMIT_EXCEEDED', expectedCode: 'rate_limited', minutes: 1 },
      { rawError: 'send_failed', expectedCode: 'send_failed', minutes: 5 },
      { rawError: 'E_RATE_LIMIT_EXCEEDED', expectedCode: 'rate_limited', minutes: 15 },
      { rawError: 'send_failed', expectedCode: 'send_failed', minutes: 60 },
      { rawError: 'send_failed', expectedCode: 'send_failed', minutes: 60 },
    ];

    const origError = console.error;
    console.error = () => {};
    try {
      for (const [idx, step] of schedule.entries()) {
        const sender = new FixtureEmailSender();
        sender.failNext(1, step.rawError);
        await runDueCommerceWork(
          f.x.runtime,
          { freedomEnv: 'local', origin: f.origin, now: () => now, emailEnabled: true, emailSender: sender, journal },
          { targets: [emailId], limit: 1 },
        );
        const row = (
          await f.x.h.pool.query('SELECT * FROM commerce_outbound_emails WHERE email_id = $1', [emailId])
        ).rows[0];
        const due = (
          await f.x.h.pool.query("SELECT * FROM commerce_due_work WHERE kind = 'email' AND target_id = $1", [emailId])
        ).rows[0];
        assert.equal(row.state, 'queued');
        assert.equal(row.attempts, idx + 1);
        assert.equal(row.last_error, step.expectedCode);
        assert.equal(due.due_at.getTime(), now.getTime() + step.minutes * 60_000);
        assert.equal(due.lease_until, null);
        now = due.due_at;
      }

      // Near expires_at (10 minutes before expires_at), a transient failure clamps due_at to expires_at
      now = new Date(initialRow.expires_at.getTime() - 10 * 60_000);
      const sender = new FixtureEmailSender();
      sender.failNext(1, 'send_failed');
      await runDueCommerceWork(
        f.x.runtime,
        { freedomEnv: 'local', origin: f.origin, now: () => now, emailEnabled: true, emailSender: sender, journal },
        { targets: [emailId], limit: 1 },
      );
      const clampedDue = (
        await f.x.h.pool.query("SELECT * FROM commerce_due_work WHERE kind = 'email' AND target_id = $1", [emailId])
      ).rows[0];
      assert.equal(clampedDue.due_at.getTime(), initialRow.expires_at.getTime());

      // At expires_at, the next run marks it expired and deletes the due_work row without calling sender
      now = new Date(initialRow.expires_at.getTime());
      const finalRes = await runDueCommerceWork(
        f.x.runtime,
        { freedomEnv: 'local', origin: f.origin, now: () => now, emailEnabled: true, emailSender: sender, journal },
        { targets: [emailId], limit: 1 },
      );
      assert.equal(finalRes.externalCalls, 0);
      assert.equal(sender.messages.length, 0);
      assert.equal(
        (await f.x.h.pool.query('SELECT state FROM commerce_outbound_emails WHERE email_id = $1', [emailId])).rows[0].state,
        'expired',
      );
      assert.equal(
        (await f.x.h.pool.query("SELECT count(*)::int n FROM commerce_due_work WHERE target_id = $1", [emailId])).rows[0].n,
        0,
      );
    } finally {
      console.error = origError;
    }
  });

  test('link in message redeems once; a retried send issues a new working link and leaves the first unredeemed', async () => {
    const p = await freshPlaced();
    const emailId = await queueTemplate(p, 'order_confirmed');
    const journal = new MemoryEffectJournal('local');
    const attemptedMessages: CommerceEmailMessage[] = [];
    let shouldFail = true;

    const customSender = {
      async send(msg: CommerceEmailMessage) {
        attemptedMessages.push(msg);
        if (shouldFail) {
          shouldFail = false;
          throw new CommerceEmailSendError('rate_limited');
        }
      },
    };

    const t0 = new Date();
    const origError = console.error;
    console.error = () => {};
    try {
      await runDueCommerceWork(
        f.x.runtime,
        { freedomEnv: 'local', origin: f.origin, now: () => t0, emailEnabled: true, emailSender: customSender, journal },
        { targets: [emailId], limit: 1 },
      );
    } finally {
      console.error = origError;
    }
    assert.equal(attemptedMessages.length, 1);

    const t1 = new Date(t0.getTime() + 60_000);
    await runDueCommerceWork(
      f.x.runtime,
      { freedomEnv: 'local', origin: f.origin, now: () => t1, emailEnabled: true, emailSender: customSender, journal },
      { targets: [emailId], limit: 1 },
    );
    assert.equal(attemptedMessages.length, 2);

    const token1 = attemptedMessages[0].text.match(/#access=([A-Za-z0-9_-]+)/)![1];
    const token2 = attemptedMessages[1].text.match(/#access=([A-Za-z0-9_-]+)/)![1];
    assert.notEqual(token1, token2);

    // Redeem the second link (from the successful send) -> 200 once, then 404
    const accessPath = `${f.root(p.s)}/orders/${p.order.order_ref}/access`;
    const redeem1 = await f.http('POST', accessPath, { token: token2 });
    assert.equal(redeem1.status, 200);
    const redeem2 = await f.http('POST', accessPath, { token: token2 });
    assert.equal(redeem2.status, 404);

    // The first link (from the failed send) remains unredeemed in commerce_order_access_grants
    const grants = (
      await f.x.h.pool.query(
        "SELECT redeemed_at FROM commerce_order_access_grants WHERE order_id = $1 AND kind = 'link' ORDER BY created_at",
        [p.order.order_ref],
      )
    ).rows;
    assert.equal(grants.length, 2);
    assert.equal(grants[0].redeemed_at, null);
    assert(grants[1].redeemed_at instanceof Date);
  });

  test('two concurrent executor runs send one message, and a lost lease never sends', async () => {
    const p = await freshPlaced();
    const emailId = await queueTemplate(p, 'order_confirmed');
    const sender = new FixtureEmailSender();
    const journal = new MemoryEffectJournal('local');

    // Concurrent executor runs on the same pool claim with FOR UPDATE SKIP LOCKED -> only 1 message sent
    const [r1, r2] = await Promise.all([
      runDueCommerceWork(
        f.x.runtime,
        { freedomEnv: 'local', origin: f.origin, emailEnabled: true, emailSender: sender, journal },
        { targets: [emailId], limit: 1 },
      ),
      runDueCommerceWork(
        f.x.runtime,
        { freedomEnv: 'local', origin: f.origin, emailEnabled: true, emailSender: sender, journal },
        { targets: [emailId], limit: 1 },
      ),
    ]);
    assert.equal(r1.claimed + r2.claimed, 1);
    assert.equal(r1.externalCalls + r2.externalCalls, 1);
    assert.equal(sender.messages.length, 1);

    // Lost lease before Check or during Journal never sends
    const emailId2 = await queueTemplate(p, 'order_access');
    const dueRow = (
      await f.x.h.pool.query(
        "UPDATE commerce_due_work SET lease_until = clock_timestamp() + interval '2 minutes' WHERE kind = 'email' AND target_id = $1 RETURNING due_work_id, lease_until::text AS token",
        [emailId2],
      )
    ).rows[0];

    // Steal the lease during journal.append
    const stealingJournal: EffectJournalPort = {
      environment: 'local',
      async append(record) {
        await journal.append(record);
        await f.x.h.pool.query(
          "UPDATE commerce_due_work SET lease_until = clock_timestamp() + interval '5 minutes' WHERE due_work_id = $1",
          [dueRow.due_work_id],
        );
      },
    };
    const sender2 = new FixtureEmailSender();
    const resultLost = await deliverCommerceEmail(
      f.x.runtime,
      emailId2,
      { sender: sender2, journal: stealingJournal, origin: f.origin },
      { dueWorkId: dueRow.due_work_id, leaseToken: dueRow.token, tenantId: p.s.tenantId },
    );
    assert.equal(resultLost.externalCalls, 0);
    assert.equal(sender2.messages.length, 0);
    const afterLost = (
      await f.x.h.pool.query('SELECT state, journaled_at FROM commerce_outbound_emails WHERE email_id = $1', [emailId2])
    ).rows[0];
    assert.equal(afterLost.state, 'queued');
    assert(afterLost.journaled_at instanceof Date);

    // 3. The lease expires during a successful send -> email still ends sent, due_work row is deleted, second run sends nothing
    const emailId3 = await queueTemplate(p, 'order_access');
    let clock3 = new Date();
    const dueRow3 = (
      await f.x.h.pool.query(
        "UPDATE commerce_due_work SET lease_until = $2::timestamptz + interval '2 minutes' WHERE kind = 'email' AND target_id = $1 RETURNING due_work_id, lease_until::text AS token",
        [emailId3, clock3],
      )
    ).rows[0];
    let sentCalls3 = 0;
    const slowSuccessSender = {
      async send() {
        sentCalls3 += 1;
        // Advance clock past the 60-second send lease set at the end of Prepare
        clock3 = new Date(clock3.getTime() + 90_000);
      },
    };
    const rSlow = await deliverCommerceEmail(
      f.x.runtime,
      emailId3,
      { sender: slowSuccessSender, journal, origin: f.origin, now: () => clock3 },
      { dueWorkId: dueRow3.due_work_id, leaseToken: dueRow3.token, tenantId: p.s.tenantId },
    );
    assert.equal(rSlow.externalCalls, 1);
    assert.equal(sentCalls3, 1);
    const afterSlow = (
      await f.x.h.pool.query('SELECT state, sent_at FROM commerce_outbound_emails WHERE email_id = $1', [emailId3])
    ).rows[0];
    assert.equal(afterSlow.state, 'sent');
    assert(afterSlow.sent_at instanceof Date);
    assert.equal(
      (await f.x.h.pool.query('SELECT count(*)::int n FROM commerce_due_work WHERE target_id = $1', [emailId3])).rows[0]
        .n,
      0,
    );
    const secondRun3 = await runDueCommerceWork(f.x.runtime, {
      freedomEnv: 'local',
      emailEnabled: true,
      emailSender: slowSuccessSender,
      journal,
      origin: f.origin,
      now: () => clock3,
    });
    assert.equal(secondRun3.externalCalls, 0);
    assert.equal(sentCalls3, 1);

    // 4. Another run takes the lease during a successful send -> email ends sent, due_work stays with other token, later run sends nothing and deletes due_work
    const emailId4 = await queueTemplate(p, 'order_access');
    let clock4 = new Date();
    const dueRow4 = (
      await f.x.h.pool.query(
        "UPDATE commerce_due_work SET lease_until = $2::timestamptz + interval '2 minutes' WHERE kind = 'email' AND target_id = $1 RETURNING due_work_id, lease_until::text AS token",
        [emailId4, clock4],
      )
    ).rows[0];
    let sentCalls4 = 0;
    let otherToken4 = '';
    const takeoverSender = {
      async send() {
        sentCalls4 += 1;
        clock4 = new Date(clock4.getTime() + 90_000);
        const taken = (
          await f.x.h.pool.query(
            "UPDATE commerce_due_work SET lease_until = $2::timestamptz + interval '2 minutes', updated_at = clock_timestamp() WHERE due_work_id = $1 RETURNING lease_until::text AS token",
            [dueRow4.due_work_id, clock4],
          )
        ).rows[0];
        otherToken4 = taken.token as string;
      },
    };
    const rTakeover = await deliverCommerceEmail(
      f.x.runtime,
      emailId4,
      { sender: takeoverSender, journal, origin: f.origin, now: () => clock4 },
      { dueWorkId: dueRow4.due_work_id, leaseToken: dueRow4.token, tenantId: p.s.tenantId },
    );
    assert.equal(rTakeover.externalCalls, 1);
    assert.equal(sentCalls4, 1);
    const afterTakeover = (
      await f.x.h.pool.query('SELECT state, sent_at FROM commerce_outbound_emails WHERE email_id = $1', [emailId4])
    ).rows[0];
    assert.equal(afterTakeover.state, 'sent');
    assert(afterTakeover.sent_at instanceof Date);
    const remainingDue4 = (
      await f.x.h.pool.query('SELECT lease_until::text AS token FROM commerce_due_work WHERE target_id = $1', [emailId4])
    ).rows;
    assert.equal(remainingDue4.length, 1);
    assert.equal(remainingDue4[0].token, otherToken4);

    // Run after the other lease expires: sends nothing and deletes the due_work row
    await f.x.h.pool.query(
      "UPDATE commerce_due_work SET lease_until = clock_timestamp() - interval '1 second' WHERE due_work_id = $1",
      [dueRow4.due_work_id],
    );
    const afterOtherLease = new Date(clock4.getTime() + 150_000);
    const cleanupRun4 = await runDueCommerceWork(
      f.x.runtime,
      {
        freedomEnv: 'local',
        emailEnabled: true,
        emailSender: takeoverSender,
        journal,
        origin: f.origin,
        now: () => afterOtherLease,
      },
      { targets: [emailId4] },
    );
    assert.equal(cleanupRun4.externalCalls, 0);
    assert.equal(sentCalls4, 1);
    assert.equal(
      (await f.x.h.pool.query('SELECT count(*)::int n FROM commerce_due_work WHERE target_id = $1', [emailId4])).rows[0]
        .n,
      0,
    );
  });

  test('claim skips email rows when flag is off, no sender is installed, or origin is omitted, while payment queries still run', async () => {
    const p = await freshPlaced();
    await f.x.h.pool.query(
      'UPDATE commerce_payment_attempts SET journaled_at=clock_timestamp(),handed_off_at=clock_timestamp(),version=version+1 WHERE attempt_id=$1',
      [p.payment.attempt_ref],
    );
    await f.x.h.pool.query(
      "UPDATE commerce_due_work SET due_at=clock_timestamp()-interval '1 second' WHERE kind='payment_query' AND target_id=$1",
      [p.payment.attempt_ref],
    );
    const emailId = await queueTemplate(p, 'order_access');
    const attempt = (
      await f.x.h.pool.query('SELECT merchant_trade_no FROM commerce_payment_attempts WHERE attempt_id=$1', [
        p.payment.attempt_ref,
      ])
    ).rows[0];
    const unpaidBody = encodeForm(
      signFields(
        {
          MerchantID: '1234567',
          MerchantTradeNo: attempt.merchant_trade_no,
          TradeStatus: '0',
        },
        EcpayKeyPair.of(p.provider.material.hash_key, p.provider.material.hash_iv),
        'sha256',
      ),
    );
    let queryCalls = 0;
    const transport = createFixtureQueryTransport(async () => {
      queryCalls += 1;
      return { kind: 'response', status: 200, body: unpaidBody };
    }, 'local');
    const sender = new FixtureEmailSender();
    const journal = new MemoryEffectJournal('local');

    // 1. Flag off -> payment_query runs, email row is not claimed
    const rOff = await runDueCommerceWork(f.x.runtime, {
      transport,
      keyring: f.ring,
      freedomEnv: 'local',
      origin: f.origin,
      emailEnabled: false,
      emailSender: sender,
      journal,
    });
    assert.equal(queryCalls, 1);
    assert.equal(rOff.externalCalls, 1);
    assert.equal(sender.messages.length, 0);
    let emailDue = (
      await f.x.h.pool.query("SELECT * FROM commerce_due_work WHERE kind = 'email' AND target_id = $1", [emailId])
    ).rows[0];
    assert.equal(emailDue.attempts, 0);
    assert.equal(emailDue.lease_until, null);

    // 2. No sender installed -> payment_query runs, email row is not claimed
    await f.x.h.pool.query(
      "UPDATE commerce_due_work SET due_at=clock_timestamp()-interval '1 second' WHERE kind='payment_query' AND target_id=$1",
      [p.payment.attempt_ref],
    );
    const rNoSender = await runDueCommerceWork(f.x.runtime, {
      transport,
      keyring: f.ring,
      freedomEnv: 'local',
      origin: f.origin,
      emailEnabled: true,
      journal,
    });
    assert.equal(queryCalls, 2);
    assert.equal(rNoSender.externalCalls, 1);
    emailDue = (
      await f.x.h.pool.query("SELECT * FROM commerce_due_work WHERE kind = 'email' AND target_id = $1", [emailId])
    ).rows[0];
    assert.equal(emailDue.attempts, 0);
    assert.equal(emailDue.lease_until, null);

    // 3. No origin provided -> payment_query runs, email row is not claimed
    await f.x.h.pool.query(
      "UPDATE commerce_due_work SET due_at=clock_timestamp()-interval '1 second' WHERE kind='payment_query' AND target_id=$1",
      [p.payment.attempt_ref],
    );
    const rNoOrigin = await runDueCommerceWork(f.x.runtime, {
      transport,
      keyring: f.ring,
      freedomEnv: 'local',
      emailEnabled: true,
      emailSender: sender,
      journal,
    });
    assert.equal(queryCalls, 3);
    assert.equal(rNoOrigin.externalCalls, 1);
    assert.equal(sender.messages.length, 0);
    emailDue = (
      await f.x.h.pool.query("SELECT * FROM commerce_due_work WHERE kind = 'email' AND target_id = $1", [emailId])
    ).rows[0];
    assert.equal(emailDue.attempts, 0);
    assert.equal(emailDue.lease_until, null);
  });

  test('sweep expires queued rows past expires_at, deletes closed rows past 45-day retention, respects bounds and skips quarantine', async () => {
    const p = await freshPlaced();
    const emailQueuedExpired = await queueTemplate(p, 'order_access');
    const emailClosedOld = await queueTemplate(p, 'order_access');
    const emailClosedRecent = await queueTemplate(p, 'order_access');
    const expireNow = new Date(Date.now() + 7 * 24 * 60 * 60_000 + 5_000);

    // emailClosedOld: closed > 45 days before both clock_timestamp() and expireNow
    await f.x.h.pool.query(
      "UPDATE commerce_outbound_emails SET state = 'suppressed', updated_at = clock_timestamp() - interval '46 days' WHERE email_id = $1",
      [emailClosedOld],
    );
    await f.x.h.pool.query("DELETE FROM commerce_due_work WHERE kind = 'email' AND target_id = $1", [emailClosedOld]);

    // emailClosedRecent: closed 10 days before expireNow (must not be deleted)
    await f.x.h.pool.query(
      "UPDATE commerce_outbound_emails SET state = 'failed', last_error = 'send_failed', updated_at = $2::timestamptz - interval '10 days' WHERE email_id = $1",
      [emailClosedRecent, expireNow],
    );
    await f.x.h.pool.query("DELETE FROM commerce_due_work WHERE kind = 'email' AND target_id = $1", [emailClosedRecent]);

    // Insert a queued row whose expires_at > expireNow
    const activeAccessId = randomUUID();
    const emailStillActive = (
      await f.x.h.pool.query(
        `INSERT INTO commerce_outbound_emails(tenant_id,instance_id,order_id,template,access_request_id,created_at,updated_at,expires_at)
         SELECT $1,$2,$3,'order_access',$4,t,t,t+interval '7 days'
         FROM (SELECT $5::timestamptz AS t) c RETURNING email_id`,
        [p.s.tenantId, p.s.instanceId, p.order.order_ref, activeAccessId, expireNow],
      )
    ).rows[0].email_id as string;

    // Quarantine runs nothing
    assert.deepEqual(await sweepCommerceOutboundEmails(f.x.runtime, { now: () => expireNow, quarantine: true }), {
      expired: 0,
      deleted: 0,
    });

    // Bounded to limit = 1: expires 1 queued row first, deletes 0 closed rows
    const sweep1 = await sweepCommerceOutboundEmails(f.x.runtime, { now: () => expireNow, limit: 1 });
    assert.deepEqual(sweep1, { expired: 1, deleted: 0 });
    assert.equal(
      (await f.x.h.pool.query('SELECT state FROM commerce_outbound_emails WHERE email_id = $1', [emailQueuedExpired])).rows[0]
        .state,
      'expired',
    );
    assert.equal(
      (await f.x.h.pool.query("SELECT count(*)::int n FROM commerce_due_work WHERE target_id = $1", [emailQueuedExpired]))
        .rows[0].n,
      0,
    );
    assert.equal(
      (await f.x.h.pool.query('SELECT count(*)::int n FROM commerce_outbound_emails WHERE email_id = $1', [emailClosedOld]))
        .rows[0].n,
      1,
    );

    // Second sweep deletes emailClosedOld and leaves emailStillActive (queued) and emailClosedRecent (closed 10d ago) untouched
    const sweep2 = await sweepCommerceOutboundEmails(f.x.runtime, { now: () => expireNow, limit: 500 });
    assert.deepEqual(sweep2, { expired: 0, deleted: 1 });
    assert.equal(
      (await f.x.h.pool.query('SELECT count(*)::int n FROM commerce_outbound_emails WHERE email_id = $1', [emailClosedOld]))
        .rows[0].n,
      0,
    );
    assert.equal(
      (await f.x.h.pool.query('SELECT state FROM commerce_outbound_emails WHERE email_id = $1', [emailStillActive])).rows[0]
        .state,
      'queued',
    );
    assert.equal(
      (await f.x.h.pool.query('SELECT state FROM commerce_outbound_emails WHERE email_id = $1', [emailClosedRecent])).rows[0]
        .state,
      'failed',
    );
  });

  for (const branch of ['expiry', 'retention'] as const) test(`sweep ${branch} skips a delivery's locked due-work without reversing the lock order or changing its lease`, async () => {
    const p = await freshPlaced(), emailId = await queueTemplate(p, 'order_access'), otherId = await queueTemplate(p, 'order_access');
    const now = branch === 'expiry' ? new Date(Date.now() + 7 * 86400_000 + 5000) : new Date();
    if (branch === 'retention') await f.x.h.pool.query(
      "UPDATE commerce_outbound_emails SET state='suppressed',updated_at=clock_timestamp()-interval '46 days' WHERE email_id=ANY($1::uuid[])", [[emailId, otherId]],
    );
    const claim = (await f.x.h.pool.query(
      "UPDATE commerce_due_work SET lease_until=$2::timestamptz+interval '2 minutes' WHERE kind='email' AND target_id=$1 RETURNING due_work_id,lease_until::text AS token,attempts,failure_count",
      [emailId, now],
    )).rows[0];
    const sender = new FixtureEmailSender(), journal = new MemoryEffectJournal('local');
    const connect = f.x.runtime.connect;
    let entered!: (pid: number) => void, release!: () => void, used = false, finished = false;
    const ready = new Promise<number>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    // Hold the real delivery transaction after PostgreSQL has granted its
    // due-work lock, before it requests the corresponding email lock.
    f.x.runtime.connect = (async () => {
      const q = await (connect as () => Promise<import('pg').PoolClient>).call(f.x.runtime), query = q.query, originalRelease = q.release;
      q.query = (async (...args: unknown[]) => {
        const result = await (query as Function).apply(q, args);
        if (!used && /WHERE due_work_id = \$1 AND kind = 'email' AND target_id = \$2/.test(String(args[0]))) {
          used = true; entered((await (query as Function).call(q, 'SELECT pg_backend_pid() pid')).rows[0].pid); await held;
        }
        return result;
      }) as typeof q.query;
      q.release = (error?: Error | boolean) => { q.query = query; q.release = originalRelease; originalRelease.call(q, error); };
      return q;
    }) as typeof f.x.runtime.connect;
    const delivered = deliverCommerceEmail(f.x.runtime, emailId, {sender, journal, origin: f.origin, now: () => now},
      {dueWorkId: claim.due_work_id, leaseToken: claim.token, tenantId: p.s.tenantId});
    // Attach rejection handlers immediately: the old inverse order produces
    // a real PostgreSQL deadlock when the delivery barrier is released.
    const deliveryResult = Promise.allSettled([delivered]);
    let sweepResult: Promise<PromiseSettledResult<{expired: number; deleted: number}>[]> | undefined;
    try {
      const pid = await Promise.race([ready, delivered.then(() => { throw Error('delivery missed its due-work barrier'); })]);
      const sweeping = sweepCommerceOutboundEmails(f.x.runtime, {now: () => now});
      sweepResult = Promise.allSettled([sweeping]);
      const blocked = (async () => {
        for (let i = 0; i < 500 && !finished; i++) {
          if ((await f.x.h.pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND state='active' AND $1=ANY(pg_blocking_pids(pid))", [pid])).rowCount) return 'blocked' as const;
          await delay(10);
        }
        return 'unobserved' as const;
      })();
      const order = await Promise.race([sweepResult.then(() => 'completed' as const), blocked]);
      finished = true; await blocked;
      if (order === 'completed') {
        assert.deepEqual((await f.x.h.pool.query('SELECT lease_until::text AS token,attempts,failure_count FROM commerce_due_work WHERE due_work_id=$1', [claim.due_work_id])).rows[0],
          {token: claim.token, attempts: claim.attempts, failure_count: claim.failure_count});
        assert.equal((await f.x.h.pool.query('SELECT state FROM commerce_outbound_emails WHERE email_id=$1', [emailId])).rows[0].state, branch === 'expiry' ? 'queued' : 'suppressed');
      }
      release();
      const [delivery, sweep] = [(await deliveryResult)[0], (await sweepResult)[0]];
      for (const result of [delivery, sweep]) assert.equal(result.status, 'fulfilled', result.status === 'rejected' ? `${result.reason.code}: ${result.reason.message}` : 'completed transaction');
      assert.equal(order, 'completed', 'sweep must finish while delivery still owns the due-work lock');
      assert.deepEqual((delivery as PromiseFulfilledResult<unknown>).value, {externalCalls: 0});
      assert.deepEqual((sweep as PromiseFulfilledResult<unknown>).value, branch === 'expiry' ? {expired: 1, deleted: 0} : {expired: 0, deleted: 1});
      assert.equal((await f.x.h.pool.query('SELECT count(*)::int n FROM commerce_due_work WHERE target_id=ANY($1::uuid[])', [[emailId, otherId]])).rows[0].n, 0);
      assert.equal(journal.objects.size, 0);
      assert.deepEqual(await sweepCommerceOutboundEmails(f.x.runtime, {now: () => now}), branch === 'expiry' ? {expired: 0, deleted: 0} : {expired: 0, deleted: 1});
    } finally {
      finished = true; release(); f.x.runtime.connect = connect;
      await deliveryResult; await sweepResult;
    }
  });

  test('createWorkerEmailSender passes exact payload (from, replyTo omitted when null) and maps Cloudflare error codes', async () => {
    const sentPayloads: unknown[] = [];
    let nextFailure: unknown = null;
    const sender = createWorkerEmailSender({
      async send(message) {
        if (nextFailure !== null) {
          const err = nextFailure;
          nextFailure = null;
          throw err;
        }
        sentPayloads.push(message);
      },
    });

    await sender.send({
      to: 'buyer@example.test',
      subject: '主旨一',
      text: '內容一',
      replyTo: null,
    });
    assert.deepEqual(sentPayloads[0], {
      to: 'buyer@example.test',
      from: 'no-reply@mail.freetwai.com',
      subject: '主旨一',
      text: '內容一',
    });
    assert(!Object.hasOwn(sentPayloads[0] as object, 'replyTo'));

    await sender.send({
      to: 'buyer@example.test',
      subject: '主旨二',
      text: '內容二',
      replyTo: 'shop@example.test',
    });
    assert.deepEqual(sentPayloads[1], {
      to: 'buyer@example.test',
      from: 'no-reply@mail.freetwai.com',
      subject: '主旨二',
      text: '內容二',
      replyTo: 'shop@example.test',
    });

    for (const [cfCode, expectedCode] of [
      ['E_VALIDATION_ERROR', 'invalid_message'],
      ['E_RECIPIENT_NOT_ALLOWED', 'recipient_not_allowed'],
      ['E_SENDER_NOT_VERIFIED', 'sender_not_verified'],
      ['E_TOO_MANY_RECIPIENTS', 'invalid_message'],
      ['E_RATE_LIMIT_EXCEEDED', 'rate_limited'],
      ['UNKNOWN_ERROR', 'send_failed'],
    ] as const) {
      nextFailure = { code: cfCode, message: 'sensitive detail must not leak' };
      await assert.rejects(
        sender.send({ to: 'buyer@example.test', subject: 's', text: 't', replyTo: null }),
        (err: unknown) => {
          assert(err instanceof CommerceEmailSendError);
          assert.equal(err.code, expectedCode);
          assert.equal(err.message, expectedCode);
          return true;
        },
      );
    }
  });
});
