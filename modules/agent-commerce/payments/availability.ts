import { Problem } from '../../../packages/shared/problem.js';
import { checkCreditAvailability, type CreditAvailabilityInput, type CreditUnavailableReason } from '../providers/ecpay/aio-credit/index.js';
export const CREDIT_UNAVAILABLE_MESSAGES: Readonly<Record<CreditUnavailableReason, string>> = Object.freeze({
  currency_not_supported: '這間店的幣別不能用信用卡付款。',
  amount_not_whole_twd: '金額有不到 1 元的零頭，不能用信用卡付款。',
  amount_below_minimum: '信用卡付款的總額至少 5 元。',
  amount_above_maximum: '信用卡付款的總額最多 999,999,999 元。',
});
export function creditUnavailableMessage(reason: CreditUnavailableReason): string {
  if (!Object.hasOwn(CREDIT_UNAVAILABLE_MESSAGES, reason))
    throw Error('payment_availability_reason_unknown');
  return CREDIT_UNAVAILABLE_MESSAGES[reason];
}
export function assertCreditPaymentAvailable(input: CreditAvailabilityInput): void {
  const result = checkCreditAvailability(input);
  if (!result.available)
    throw new Problem(409, 'payment_profile_unavailable', creditUnavailableMessage(result.reason));
}
