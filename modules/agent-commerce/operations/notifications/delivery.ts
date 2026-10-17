import type {Pool,PoolClient} from 'pg';
import {clearTenantContext,isolatedTransaction} from '../../../../packages/resource-scopes/tenant-transaction.js';
import {createAccessLink} from '../../checkout/access.js';
import {bindStore} from '../../checkout/authority.js';
import type {CheckoutTerms} from '../../checkout/terms.js';
import type {EffectJournalPort} from '../journal/journal.js';
import {
  isPermanentCommerceEmailError,
  mapCommerceEmailErrorCode,
  type CommerceEmailErrorCode,
  type CommerceEmailSender,
  type CommerceOutboundEmailTemplate,
} from './email-port.js';
import {renderCommerceEmail} from './templates.js';

export type CommerceOutboundEmailState = 'queued' | 'sent' | 'suppressed' | 'expired' | 'failed';

export interface OutboundEmailRow {
  email_id: string;
  tenant_id: string;
  instance_id: string;
  order_id: string;
  template: CommerceOutboundEmailTemplate;
  application_id: string | null;
  access_request_id: string | null;
  state: CommerceOutboundEmailState;
  attempts: number;
  last_error: string | null;
  journaled_at: Date | null;
  sent_at: Date | null;
  expires_at: Date;
  created_at: Date;
  updated_at: Date;
}

interface DueEmailWorkRow {
  due_work_id: string;
  tenant_id: string;
  instance_id: string;
  kind: string;
  target_id: string;
  due_at: Date;
  lease_until: Date | null;
  token: string | null;
  attempts: number;
  failure_count: number;
  last_error: string | null;
}

export interface CommerceEmailDeliveryDependencies {
  sender: CommerceEmailSender;
  journal: EffectJournalPort;
  origin: string;
  now?: () => Date;
  quarantine?: boolean;
  signal?: AbortSignal;
}

export interface CommerceEmailClaim {
  dueWorkId: string;
  leaseToken: string;
  tenantId: string;
}

const timestamp = async (q: PoolClient, deps: Pick<CommerceEmailDeliveryDependencies, 'now'>): Promise<Date> =>
  deps.now?.() ?? (await q.query<{t: Date}>('SELECT clock_timestamp() AS t')).rows[0].t;

export function emailBackoffMinutes(attemptNumber: number): 1 | 5 | 15 | 60 {
  if (attemptNumber <= 1) return 1;
  if (attemptNumber === 2) return 5;
  if (attemptNumber === 3) return 15;
  return 60;
}

async function lockDueWork(q: PoolClient, dueWorkId: string, emailId: string): Promise<DueEmailWorkRow | undefined> {
  return (
    await q.query<DueEmailWorkRow>(
      `SELECT *, lease_until::text AS token
       FROM commerce_due_work
       WHERE due_work_id = $1 AND kind = 'email' AND target_id = $2
       FOR UPDATE`,
      [dueWorkId, emailId],
    )
  ).rows[0];
}

async function lockOutboundEmail(q: PoolClient, emailId: string): Promise<OutboundEmailRow | undefined> {
  return (
    await q.query<OutboundEmailRow>(
      `SELECT *
       FROM commerce_outbound_emails
       WHERE email_id = $1
       FOR UPDATE`,
      [emailId],
    )
  ).rows[0];
}

function isLeaseOurs(work: DueEmailWorkRow | undefined, leaseToken: string, now: Date): work is DueEmailWorkRow {
  return Boolean(
    work &&
      work.token === leaseToken &&
      work.lease_until !== null &&
      work.lease_until.getTime() > now.getTime(),
  );
}

async function deleteDueWork(q: PoolClient, dueWorkId: string): Promise<void> {
  await q.query('DELETE FROM commerce_due_work WHERE due_work_id = $1', [dueWorkId]);
}

async function rescheduleTransientFailure(
  q: PoolClient,
  work: DueEmailWorkRow,
  email: OutboundEmailRow,
  now: Date,
  code: CommerceEmailErrorCode | 'journal_unavailable',
): Promise<void> {
  const attempts = email.attempts + 1;
  const delayMs = emailBackoffMinutes(attempts) * 60_000;
  const dueAt = new Date(Math.min(now.getTime() + delayMs, email.expires_at.getTime()));
  await q.query(
    `UPDATE commerce_outbound_emails
     SET attempts = $2, last_error = $3, updated_at = $4
     WHERE email_id = $1 AND state = 'queued'`,
    [email.email_id, attempts, code, now],
  );
  await q.query(
    `UPDATE commerce_due_work
     SET due_at = $2, lease_until = NULL,
         attempts = attempts + 1, failure_count = failure_count + 1, updated_at = $3
     WHERE due_work_id = $1`,
    [work.due_work_id, dueAt, now],
  );
}

/** Delivers one leased email row across three short transactions so neither the
 * effect journal write nor the email send ever holds a database connection. */
export async function deliverCommerceEmail(
  pool: Pool,
  emailId: string,
  deps: CommerceEmailDeliveryDependencies,
  claim: CommerceEmailClaim,
): Promise<{externalCalls: 0 | 1}> {
  if (deps.quarantine || deps.signal?.aborted) {
    return {externalCalls: 0};
  }

  // 1. Check (transaction, tenant bound)
  const checked = await isolatedTransaction(pool, async q => {
    await clearTenantContext(q);
    await bindStore(q, claim.tenantId);
    const now = await timestamp(q, deps);
    const work = await lockDueWork(q, claim.dueWorkId, emailId);
    const email = await lockOutboundEmail(q, emailId);
    if (email && email.tenant_id !== claim.tenantId) {
      throw new Error('due_work_binding_invalid');
    }
    if (!isLeaseOurs(work, claim.leaseToken, now)) {
      return {action: 'stop' as const};
    }
    if (!email || email.state !== 'queued') {
      await deleteDueWork(q, claim.dueWorkId);
      return {action: 'stop' as const};
    }
    if (email.expires_at.getTime() <= now.getTime()) {
      await q.query(
        `UPDATE commerce_outbound_emails
         SET state = 'expired', updated_at = $2
         WHERE email_id = $1 AND state = 'queued'`,
        [emailId, now],
      );
      await deleteDueWork(q, claim.dueWorkId);
      return {action: 'stop' as const};
    }
    const redaction = (
      await q.query<{customer_redacted_at: Date | null; contact_redacted_at: Date | null}>(
        `SELECT c.redacted_at AS customer_redacted_at, contact.redacted_at AS contact_redacted_at
         FROM commerce_checkout_orders co
         JOIN commerce_customers c
           ON c.customer_id = co.customer_id AND c.tenant_id = co.tenant_id AND c.instance_id = co.instance_id
         JOIN commerce_checkout_contacts contact
           ON contact.contact_id = co.contact_id AND contact.checkout_id = co.checkout_id
          AND contact.tenant_id = co.tenant_id AND contact.instance_id = co.instance_id
         WHERE co.order_id = $1 AND co.tenant_id = $2 AND co.instance_id = $3`,
        [email.order_id, email.tenant_id, email.instance_id],
      )
    ).rows[0];
    if (!redaction || redaction.customer_redacted_at !== null || redaction.contact_redacted_at !== null) {
      await q.query(
        `UPDATE commerce_outbound_emails
         SET state = 'suppressed', updated_at = $2
         WHERE email_id = $1 AND state = 'queued'`,
        [emailId, now],
      );
      await deleteDueWork(q, claim.dueWorkId);
      return {action: 'stop' as const};
    }
    return {action: 'continue' as const, email};
  });

  if (checked.action === 'stop' || deps.signal?.aborted) {
    return {externalCalls: 0};
  }

  // 2. Journal, only while journaled_at is null (no DB transaction open during append)
  if (checked.email.journaled_at === null) {
    try {
      await deps.journal.append({
        environment: deps.journal.environment,
        kind: 'email_send',
        id: checked.email.email_id,
        occurred_at: checked.email.created_at.toISOString(),
        tenant_id: checked.email.tenant_id,
        instance_id: checked.email.instance_id,
        detail: {
          order_id: checked.email.order_id,
          purpose: checked.email.template,
        },
      });
    } catch {
      console.error(
        JSON.stringify({
          event: 'commerce_email_failed',
          template: checked.email.template,
          code: 'journal_unavailable',
        }),
      );
      await isolatedTransaction(pool, async q => {
        await clearTenantContext(q);
        await bindStore(q, claim.tenantId);
        const now = await timestamp(q, deps);
        const work = await lockDueWork(q, claim.dueWorkId, emailId);
        const email = await lockOutboundEmail(q, emailId);
        if (!isLeaseOurs(work, claim.leaseToken, now) || !email || email.state !== 'queued') {
          return;
        }
        await rescheduleTransientFailure(q, work, email, now, 'journal_unavailable');
      });
      return {externalCalls: 0};
    }

    const marked = await isolatedTransaction(pool, async q => {
      await clearTenantContext(q);
      await bindStore(q, claim.tenantId);
      const now = await timestamp(q, deps);
      const work = await lockDueWork(q, claim.dueWorkId, emailId);
      const email = await lockOutboundEmail(q, emailId);
      if (!email || email.state !== 'queued') {
        if (isLeaseOurs(work, claim.leaseToken, now)) {
          await deleteDueWork(q, claim.dueWorkId);
        }
        return false;
      }
      if (email.journaled_at === null) {
        await q.query(
          `UPDATE commerce_outbound_emails
           SET journaled_at = $2, updated_at = $2
           WHERE email_id = $1 AND state = 'queued' AND journaled_at IS NULL`,
          [emailId, now],
        );
      }
      return isLeaseOurs(work, claim.leaseToken, now);
    });

    if (!marked || deps.signal?.aborted) {
      return {externalCalls: 0};
    }
  }

  // 3. Prepare (transaction, tenant bound)
  const prepared = await isolatedTransaction(pool, async q => {
    await clearTenantContext(q);
    await bindStore(q, claim.tenantId);
    const now = await timestamp(q, deps);
    const work = await lockDueWork(q, claim.dueWorkId, emailId);
    const email = await lockOutboundEmail(q, emailId);
    if (!isLeaseOurs(work, claim.leaseToken, now)) {
      return null;
    }
    if (!email || email.state !== 'queued') {
      await deleteDueWork(q, claim.dueWorkId);
      return null;
    }
    if (email.expires_at.getTime() <= now.getTime()) {
      await q.query(
        `UPDATE commerce_outbound_emails
         SET state = 'expired', updated_at = $2
         WHERE email_id = $1 AND state = 'queued'`,
        [emailId, now],
      );
      await deleteDueWork(q, claim.dueWorkId);
      return null;
    }
    if (email.journaled_at === null) {
      return null;
    }
    const row = (
      await q.query<{
        checkout_id: string;
        display_number: string;
        terms: CheckoutTerms;
        store_slug: string | null;
        store_name: string;
        customer_redacted_at: Date | null;
        contact_email: string | null;
        contact_redacted_at: Date | null;
      }>(
        `SELECT
           co.checkout_id,
           co.display_number,
           co.terms,
           p.slug AS store_slug,
           shop.name AS store_name,
           c.redacted_at AS customer_redacted_at,
           contact.contact_email,
           contact.redacted_at AS contact_redacted_at
         FROM commerce_checkout_orders co
         JOIN commerce_storefront_profiles p
           ON p.tenant_id = co.tenant_id AND p.instance_id = co.instance_id
         JOIN commerce_shops shop
           ON shop.shop_id = p.storefront_shop_id
         JOIN commerce_customers c
           ON c.customer_id = co.customer_id AND c.tenant_id = co.tenant_id AND c.instance_id = co.instance_id
         JOIN commerce_checkout_contacts contact
           ON contact.contact_id = co.contact_id AND contact.checkout_id = co.checkout_id
          AND contact.tenant_id = co.tenant_id AND contact.instance_id = co.instance_id
         WHERE co.order_id = $1 AND co.tenant_id = $2 AND co.instance_id = $3`,
        [email.order_id, email.tenant_id, email.instance_id],
      )
    ).rows[0];
    if (!row || row.customer_redacted_at !== null || row.contact_redacted_at !== null || !row.contact_email) {
      await q.query(
        `UPDATE commerce_outbound_emails
         SET state = 'suppressed', updated_at = $2
         WHERE email_id = $1 AND state = 'queued'`,
        [emailId, now],
      );
      await deleteDueWork(q, claim.dueWorkId);
      return null;
    }
    const accessToken = await createAccessLink(q, {
      tenant_id: email.tenant_id,
      instance_id: email.instance_id,
      checkout_id: row.checkout_id,
      order_id: email.order_id,
    });
    const leased = (
      await q.query<{token: string}>(
        `UPDATE commerce_due_work
         SET lease_until = $2::timestamptz + interval '60 seconds',
             updated_at = clock_timestamp()
         WHERE due_work_id = $1
         RETURNING lease_until::text AS token`,
        [work.due_work_id, now],
      )
    ).rows[0];
    return {
      email,
      recipient: row.contact_email,
      storeSlug: row.store_slug ?? '',
      storeName: row.store_name,
      displayNumber: row.display_number,
      terms: row.terms,
      accessToken,
      sendLeaseToken: leased.token,
    };
  });

  if (!prepared || deps.signal?.aborted) {
    return {externalCalls: 0};
  }

  const baseRenderInput = {
    origin: deps.origin,
    store: {
      slug: prepared.storeSlug,
      name: prepared.storeName,
      contactEmail: null,
    },
    displayNumber: prepared.displayNumber,
    orderRef: prepared.email.order_id,
    accessToken: prepared.accessToken,
  };
  const rendered =
    prepared.email.template === 'order_confirmed'
      ? renderCommerceEmail({
          ...baseRenderInput,
          template: 'order_confirmed',
          items: prepared.terms.items.map(item => ({
            title: item.title,
            variantLabel: null,
            quantity: item.quantity,
          })),
          totalMinor: prepared.terms.total_minor,
        })
      : prepared.email.template === 'paid_unallocatable'
        ? renderCommerceEmail({
            ...baseRenderInput,
            template: 'paid_unallocatable',
          })
        : renderCommerceEmail({
            ...baseRenderInput,
            template: 'order_access',
          });

  // 4. Send with no transaction open
  let sendError: unknown = null;
  try {
    await deps.sender.send({
      to: prepared.recipient,
      subject: rendered.subject,
      text: rendered.text,
      replyTo: rendered.replyTo,
    });
  } catch (error) {
    sendError = error;
  }

  // 5. Record (transaction)
  if (sendError === null) {
    await isolatedTransaction(pool, async q => {
      await clearTenantContext(q);
      await bindStore(q, claim.tenantId);
      const now = await timestamp(q, deps);
      const work = await lockDueWork(q, claim.dueWorkId, emailId);
      const email = await lockOutboundEmail(q, emailId);
      if (email && email.state === 'queued') {
        await q.query(
          `UPDATE commerce_outbound_emails
           SET state = 'sent', sent_at = $2, last_error = NULL, updated_at = $2
           WHERE email_id = $1 AND state = 'queued'`,
          [emailId, now],
        );
      }
      if (work && work.token === prepared.sendLeaseToken) {
        await deleteDueWork(q, claim.dueWorkId);
      }
    });
    return {externalCalls: 1};
  }

  const code = mapCommerceEmailErrorCode(sendError);
  console.error(
    JSON.stringify({
      event: 'commerce_email_failed',
      template: prepared.email.template,
      code,
    }),
  );
  await isolatedTransaction(pool, async q => {
    await clearTenantContext(q);
    await bindStore(q, claim.tenantId);
    const now = await timestamp(q, deps);
    const work = await lockDueWork(q, claim.dueWorkId, emailId);
    const email = await lockOutboundEmail(q, emailId);
    if (!isLeaseOurs(work, prepared.sendLeaseToken, now) || !email || email.state !== 'queued') {
      return;
    }
    if (isPermanentCommerceEmailError(code)) {
      await q.query(
        `UPDATE commerce_outbound_emails
         SET state = 'failed', attempts = attempts + 1, last_error = $2, updated_at = $3
         WHERE email_id = $1 AND state = 'queued'`,
        [emailId, code, now],
      );
      await deleteDueWork(q, claim.dueWorkId);
      return;
    }
    await rescheduleTransientFailure(q, work, email, now, code);
  });
  return {externalCalls: 1};
}

/** Acquire due-work before email, as delivery does. Candidate discovery takes
 * no row locks; both lock steps skip busy rows. A skipped due-work row must also
 * exclude its email, otherwise a subsequent DELETE would invert that order. */
async function lockSweepEmails(q: PoolClient, now: Date | null, limit: number, retention = false) {
  const eligible = retention
    ? "state IN ('sent', 'suppressed', 'expired', 'failed') AND updated_at <= coalesce($1::timestamptz, clock_timestamp()) - interval '45 days'"
    : "state = 'queued' AND expires_at <= coalesce($1::timestamptz, clock_timestamp())";
  const order = retention ? 'updated_at, email_id' : 'expires_at, email_id';
  const candidates = (await q.query<{email_id: string}>(
    `SELECT email_id FROM commerce_outbound_emails WHERE ${eligible} ORDER BY ${order} LIMIT $2`, [now, limit],
  )).rows.map(row => row.email_id);
  if (!candidates.length) return {emails: [], work: []};
  const work = (await q.query<{due_work_id: string; target_id: string}>(
    `SELECT due_work_id, target_id FROM commerce_due_work
     WHERE kind = 'email' AND target_id = ANY($1::uuid[])
     ORDER BY due_work_id FOR UPDATE SKIP LOCKED`, [candidates],
  )).rows;
  const lockedWork = work.map(row => row.due_work_id);
  const emails = (await q.query<{email_id: string}>(
    `SELECT email_id FROM commerce_outbound_emails e
     WHERE ${eligible} AND email_id = ANY($2::uuid[])
       AND NOT EXISTS (SELECT 1 FROM commerce_due_work w
         WHERE w.kind = 'email' AND w.target_id = e.email_id
           AND NOT (w.due_work_id = ANY($3::uuid[])))
     ORDER BY ${order} FOR UPDATE OF e SKIP LOCKED`, [now, candidates, lockedWork],
  )).rows.map(row => row.email_id);
  const selected = new Set(emails);
  // Never DELETE by target alone: a newly inserted work row was not locked by
  // this transaction. Delivery can retire that row after observing closed/missing email.
  return {emails, work: work.filter(row => selected.has(row.target_id)).map(row => row.due_work_id)};
}

/** Bounded DB-only sweep: expires queued rows past expires_at (deleting their
 * due-work rows) and deletes closed rows past the 45-day retention window. */
export async function sweepCommerceOutboundEmails(
  pool: Pool,
  options: {limit?: number; now?: () => Date; quarantine?: boolean} = {},
): Promise<{expired: number; deleted: number}> {
  const {limit = 500} = options;
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new Error('commerce_email_sweep_limit_invalid');
  }
  if (options.quarantine) {
    return {expired: 0, deleted: 0};
  }
  return isolatedTransaction(pool, async q => {
    const now = options.now?.() ?? null;
    const expired = await lockSweepEmails(q, now, limit), dueExpired = expired.emails;
    if (dueExpired.length > 0) {
      await q.query(
        `UPDATE commerce_outbound_emails
         SET state = 'expired', updated_at = coalesce($2::timestamptz, clock_timestamp())
         WHERE email_id = ANY($1::uuid[]) AND state = 'queued'`,
        [dueExpired, now],
      );
      await q.query(
        `DELETE FROM commerce_due_work
         WHERE due_work_id = ANY($1::uuid[])`,
        [expired.work],
      );
    }
    const remaining = limit - dueExpired.length;
    let deleted = 0;
    if (remaining > 0) {
      const retained = await lockSweepEmails(q, now, remaining, true), dueRetention = retained.emails;
      if (dueRetention.length > 0) {
        await q.query(
          `DELETE FROM commerce_due_work
           WHERE due_work_id = ANY($1::uuid[])`,
          [retained.work],
        );
        deleted =
          (
            await q.query(
              `DELETE FROM commerce_outbound_emails
               WHERE email_id = ANY($1::uuid[])`,
              [dueRetention],
            )
          ).rowCount ?? 0;
      }
    }
    return {expired: dueExpired.length, deleted};
  });
}
