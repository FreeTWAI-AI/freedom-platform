import { EcpayProtocolError } from '../errors.js';
import {
  MINOR_PER_TWD,
  assertNonNegativeSafeInteger,
  assertPositiveWholeTwdMinor,
  isPlainObject,
} from '../field-rules.js';

export const ECPAY_AIO_CREDIT_PROFILE = 'ecpay.aio.credit.v1' as const;

export const MIN_CREDIT_TOTAL_MINOR = 500;

/**
 * The largest amount this profile sends or reads back: 999,999,999 TWD. The notification,
 * trade-info and credit-detail parsers accept at most nine digits, so the checkout form,
 * the queries and the refunds keep to the same range.
 */
export const MAX_CREDIT_AMOUNT_MINOR = 999_999_999 * MINOR_PER_TWD;

export type CreditUnavailableReason =
  | 'currency_not_supported'
  | 'amount_not_whole_twd'
  | 'amount_below_minimum'
  | 'amount_above_maximum';

export type CreditAvailabilityResult =
  | { readonly available: true }
  | { readonly available: false; readonly reason: CreditUnavailableReason };

export interface CreditAvailabilityInput {
  readonly currency: string;
  readonly totalMinor: number;
  readonly amountsMinor: readonly number[];
}

export function checkCreditAvailability(
  input: CreditAvailabilityInput,
): CreditAvailabilityResult {
  if (!isPlainObject(input)) {
    throw new EcpayProtocolError('invalid_input');
  }
  if (typeof input.currency !== 'string' || input.currency.length === 0) {
    throw new EcpayProtocolError('invalid_input');
  }
  assertNonNegativeSafeInteger(input.totalMinor);
  if (!Array.isArray(input.amountsMinor)) {
    throw new EcpayProtocolError('invalid_input');
  }
  for (const amount of input.amountsMinor) {
    assertNonNegativeSafeInteger(amount);
  }

  if (input.currency !== 'TWD') {
    return Object.freeze({
      available: false as const,
      reason: 'currency_not_supported' as const,
    });
  }

  if (
    input.totalMinor % MINOR_PER_TWD !== 0 ||
    input.amountsMinor.some((amount) => amount % MINOR_PER_TWD !== 0)
  ) {
    return Object.freeze({
      available: false as const,
      reason: 'amount_not_whole_twd' as const,
    });
  }

  if (input.totalMinor < MIN_CREDIT_TOTAL_MINOR) {
    return Object.freeze({
      available: false as const,
      reason: 'amount_below_minimum' as const,
    });
  }

  if (input.totalMinor > MAX_CREDIT_AMOUNT_MINOR) {
    return Object.freeze({
      available: false as const,
      reason: 'amount_above_maximum' as const,
    });
  }

  return Object.freeze({ available: true as const });
}

export function assertCreditAmountMinor(amountMinor: unknown): asserts amountMinor is number {
  assertPositiveWholeTwdMinor(amountMinor);
  if (amountMinor > MAX_CREDIT_AMOUNT_MINOR) {
    throw new EcpayProtocolError('invalid_input');
  }
}
