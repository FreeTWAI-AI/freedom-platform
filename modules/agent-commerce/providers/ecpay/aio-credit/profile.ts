import { sanitizeMessage } from '../encoding.js';
import { EcpayProtocolError } from '../errors.js';
import { ECPAY_ORIGINS, type EcpayEnvironment } from '../index.js';

export const ECPAY_AIO_CREDIT_PROFILE = 'ecpay.aio.credit.v1' as const;

export const MINOR_PER_TWD = 100;
export const MIN_CREDIT_TOTAL_MINOR = 500;
export const MAX_ECPAY_TWD_AMOUNT = 2_147_483_647;

const MERCHANT_ID_PATTERN = /^[0-9]{7,10}$/;
const FEE_PATTERN = /^([0-9]{1,9})(?:\.([0-9]{1,2}))?$/;

export type CreditUnavailableReason =
  | 'currency_not_supported'
  | 'amount_not_whole_twd'
  | 'amount_below_minimum';

export type CreditAvailabilityResult =
  | { readonly available: true }
  | { readonly available: false; readonly reason: CreditUnavailableReason };

export interface CreditAvailabilityInput {
  readonly currency: string;
  readonly totalMinor: number;
  readonly amountsMinor: readonly number[];
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    value instanceof Uint8Array
  ) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function assertMerchantId(merchantId: unknown): asserts merchantId is string {
  if (typeof merchantId !== 'string' || !MERCHANT_ID_PATTERN.test(merchantId)) {
    throw new EcpayProtocolError('invalid_input');
  }
}

export function assertEnvironment(environment: unknown): asserts environment is EcpayEnvironment {
  if (
    typeof environment !== 'string' ||
    !Object.prototype.hasOwnProperty.call(ECPAY_ORIGINS.payment, environment)
  ) {
    throw new EcpayProtocolError('invalid_input');
  }
}

export function assertNonNegativeSafeInteger(value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new EcpayProtocolError('invalid_input');
  }
}

export function assertPositiveWholeTwdMinor(amountMinor: unknown): asserts amountMinor is number {
  if (
    typeof amountMinor !== 'number' ||
    !Number.isSafeInteger(amountMinor) ||
    amountMinor <= 0 ||
    amountMinor % MINOR_PER_TWD !== 0 ||
    amountMinor / MINOR_PER_TWD > MAX_ECPAY_TWD_AMOUNT
  ) {
    throw new EcpayProtocolError('invalid_input');
  }
}

export function parseOptionalFeeMinor(raw: string | undefined): number | null {
  if (typeof raw !== 'string' || raw.length === 0) {
    return null;
  }
  const match = FEE_PATTERN.exec(raw);
  if (!match) {
    return null;
  }
  const wholePart = match[1];
  const fracPart = (match[2] ?? '').padEnd(2, '0');
  return Number(wholePart) * MINOR_PER_TWD + Number(fracPart);
}

export function parseOptionalSanitized(
  raw: string | undefined,
  maxCodePoints: number,
): string | null {
  if (typeof raw !== 'string' || raw.length === 0) {
    return null;
  }
  const cleaned = sanitizeMessage(raw, maxCodePoints);
  return cleaned.length > 0 ? cleaned : null;
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

  return Object.freeze({ available: true as const });
}
