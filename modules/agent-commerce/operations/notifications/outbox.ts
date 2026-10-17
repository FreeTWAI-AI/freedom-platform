import type {PoolClient} from 'pg';
import type {PaymentApplication} from '../../checkout/payments.js';
import {scheduleDueWork} from '../due-work.js';
import type {CommerceEmailOutbox,CommerceOutboundEmailTemplate,QueueCommerceEmailInput} from './email-port.js';
export type {CommerceEmailOutbox,CommerceOutboundEmailTemplate,QueueCommerceEmailInput} from './email-port.js';

/** Enqueues one outbound email reference and its immediate due-work row in the
 * caller's transaction. Replays that hit the unique key queue nothing new. */
export async function queueCommerceEmail(q:PoolClient,input:QueueCommerceEmailInput):Promise<{emailId:string}|null> {
  const inserted=(await q.query<{email_id:string;created_at:Date}>(
    `INSERT INTO commerce_outbound_emails(tenant_id,instance_id,order_id,template,application_id,access_request_id,created_at,expires_at)
     SELECT $1,$2,$3,$4,$5,$6,t,t+interval '7 days' FROM (SELECT clock_timestamp() AS t) clock
     ON CONFLICT DO NOTHING
     RETURNING email_id,created_at`,
    [input.tenantId,input.instanceId,input.orderId,input.template,input.applicationId??null,input.accessRequestId??null],
  )).rows[0];
  if(!inserted)return null;
  await scheduleDueWork(q,{
    tenantId:input.tenantId,
    instanceId:input.instanceId,
    kind:'email',
    targetId:inserted.email_id,
    dueAt:inserted.created_at,
  });
  return {emailId:inserted.email_id};
}

export const commerceEmailOutbox:CommerceEmailOutbox={queue:queueCommerceEmail};

/** Shared by notification receipt and query application so both paths map
 * payment outcomes to buyer emails identically. */
export async function queuePaymentOutcomeEmail(
  q:PoolClient,
  email:CommerceEmailOutbox|undefined,
  input:{tenantId:string;instanceId:string;application:PaymentApplication|null},
):Promise<{emailId:string}|null> {
  if(!email||!input.application)return null;
  const {outcome,application_id,order_id}=input.application;
  const template:CommerceOutboundEmailTemplate|null=
    outcome==='converted'||outcome==='allocated'
      ? 'order_confirmed'
      : outcome==='unallocatable'
        ? 'paid_unallocatable'
        : null;
  if(!template)return null;
  return email.queue(q,{
    template,
    tenantId:input.tenantId,
    instanceId:input.instanceId,
    orderId:order_id,
    applicationId:application_id,
  });
}
