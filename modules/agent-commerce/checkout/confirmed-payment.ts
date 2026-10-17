import type {PoolClient} from 'pg';
/** These retained outcomes alone confirm payment, independent of current stock. */
export const CONFIRMED_PAYMENT_OUTCOMES=['converted','allocated','unallocatable'] as const;
/** Internal SQL expression only; orderIdSQL is a trusted column or placeholder. */
export const confirmedPaymentSQL=(orderIdSQL:string)=>`EXISTS(SELECT 1 FROM commerce_checkout_payment_applications payment
  WHERE payment.order_id=${orderIdSQL} AND payment.outcome IN (${CONFIRMED_PAYMENT_OUTCOMES.map(outcome=>`'${outcome}'`).join(',')}))`;
export async function hasConfirmedPayment(q:PoolClient,orderId:string):Promise<boolean> {
  return (await q.query<{confirmed:boolean}>(`SELECT ${confirmedPaymentSQL('$1')} AS confirmed`,[orderId])).rows[0].confirmed;
}
