import { RefundRuleError, deepFreeze } from './errors.js';
import {
  SETTLEMENT_UNITS,
  type SettlementUnit,
  type UnappliedRefundError,
  type UnappliedRefundInput,
  type UnappliedRefundResult,
} from './types.js';

function isPlainObject(val: unknown): val is Record<string, unknown> {
  if (val === null || typeof val !== 'object' || Array.isArray(val)) {
    return false;
  }
  const proto = Object.getPrototypeOf(val);
  return proto === Object.prototype || proto === null;
}

function isSafeIntegerNonNegativeZero(n: unknown): n is number {
  return typeof n === 'number' && Number.isSafeInteger(n) && !Object.is(n, -0);
}

function validateSettlementUnit(u: unknown): asserts u is SettlementUnit {
  if (typeof u !== 'number' || Object.is(u, -0) || !SETTLEMENT_UNITS.includes(u as SettlementUnit)) {
    throw new RefundRuleError();
  }
}

/**
 * Validates a refund for payments never applied to the order (overpaid or paid_after_cancel).
 */
export function checkUnappliedRefund(input: UnappliedRefundInput): UnappliedRefundResult {
  if (!isPlainObject(input)) {
    throw new RefundRuleError();
  }
  validateSettlementUnit(input.settlement_unit_minor);
  const u = input.settlement_unit_minor;

  if (
    !isSafeIntegerNonNegativeZero(input.unapplied_minor) ||
    input.unapplied_minor < 0 ||
    input.unapplied_minor % u !== 0
  ) {
    throw new RefundRuleError();
  }
  const unapplied = input.unapplied_minor;

  if (
    !isSafeIntegerNonNegativeZero(input.refunded_minor) ||
    input.refunded_minor < 0 ||
    input.refunded_minor > unapplied ||
    input.refunded_minor % u !== 0
  ) {
    throw new RefundRuleError();
  }
  const refunded = input.refunded_minor;

  if (!isSafeIntegerNonNegativeZero(input.amount_minor) || input.amount_minor < 0) {
    throw new RefundRuleError();
  }
  const amount = input.amount_minor;

  if (amount % u !== 0) {
    const errors: readonly UnappliedRefundError[] = [{ path: 'amount_minor', code: 'not_unit_multiple' }];
    return deepFreeze({
      ok: false,
      errors,
    });
  }

  if (amount === 0) {
    const errors: readonly UnappliedRefundError[] = [{ path: 'amount_minor', code: 'total_zero' }];
    return deepFreeze({
      ok: false,
      errors,
    });
  }

  if (amount > unapplied - refunded) {
    const errors: readonly UnappliedRefundError[] = [{ path: 'amount_minor', code: 'above_cap' }];
    return deepFreeze({
      ok: false,
      errors,
    });
  }

  return deepFreeze({
    ok: true,
    line: {
      kind: 'unapplied',
      amount_minor: amount,
    },
  });
}
