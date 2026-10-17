import { RefundRuleError, deepFreeze } from './errors.js';
import {
  FAULT_REASONS,
  REFUND_REASONS,
  REFUND_REQUEST_KINDS,
  SETTLEMENT_UNITS,
  type RefundAllocationError,
  type RefundAllocationInput,
  type RefundAllocationResult,
  type RefundLine,
  type RefundPlan,
  type RefundPlanInput,
  type RefundPlanItem,
  type RefundPlanShipping,
  type SettlementUnit,
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

const REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/;

function isValidRef(ref: unknown): ref is string {
  return typeof ref === 'string' && REF_PATTERN.test(ref);
}

function validateSettlementUnit(u: unknown): asserts u is SettlementUnit {
  if (typeof u !== 'number' || Object.is(u, -0) || !SETTLEMENT_UNITS.includes(u as SettlementUnit)) {
    throw new RefundRuleError();
  }
}

/**
 * Computes net(j) = u × ⌊(L ÷ u) × j ÷ Q⌋ using BigInt arithmetic.
 */
export function refundNetForQuantity(input: {
  readonly settlement_unit_minor: number;
  readonly quantity: number;
  readonly net_minor: number;
  readonly units: number;
}): number {
  if (!isPlainObject(input)) {
    throw new RefundRuleError();
  }
  validateSettlementUnit(input.settlement_unit_minor);
  const u = input.settlement_unit_minor;

  if (
    !isSafeIntegerNonNegativeZero(input.quantity) ||
    input.quantity < 1 ||
    input.quantity > 99
  ) {
    throw new RefundRuleError();
  }
  const Q = input.quantity;

  if (
    !isSafeIntegerNonNegativeZero(input.net_minor) ||
    input.net_minor < 0 ||
    input.net_minor % u !== 0
  ) {
    throw new RefundRuleError();
  }
  const L = input.net_minor;

  if (
    !isSafeIntegerNonNegativeZero(input.units) ||
    input.units < 0 ||
    input.units > Q
  ) {
    throw new RefundRuleError();
  }
  const units = input.units;

  const uBig = BigInt(u);
  const lBig = BigInt(L);
  const qBig = BigInt(Q);
  const jBig = BigInt(units);

  const netBig = uBig * (((lBig / uBig) * jBig) / qBig);
  return Number(netBig);
}

/**
 * Computes the maximum refund amount for k = units more units of one line.
 * k = 0 → L − r
 * k ≥ 1 → min(net(p + k) − net(p), L − r)
 */
export function itemRefundCap(input: {
  readonly settlement_unit_minor: number;
  readonly quantity: number;
  readonly net_minor: number;
  readonly refunded_quantity: number;
  readonly refunded_minor: number;
  readonly units: number;
}): number {
  if (!isPlainObject(input)) {
    throw new RefundRuleError();
  }
  validateSettlementUnit(input.settlement_unit_minor);
  const u = input.settlement_unit_minor;

  if (
    !isSafeIntegerNonNegativeZero(input.quantity) ||
    input.quantity < 1 ||
    input.quantity > 99
  ) {
    throw new RefundRuleError();
  }
  const Q = input.quantity;

  if (
    !isSafeIntegerNonNegativeZero(input.net_minor) ||
    input.net_minor < 0 ||
    input.net_minor % u !== 0
  ) {
    throw new RefundRuleError();
  }
  const L = input.net_minor;

  if (
    !isSafeIntegerNonNegativeZero(input.refunded_quantity) ||
    input.refunded_quantity < 0 ||
    input.refunded_quantity > Q
  ) {
    throw new RefundRuleError();
  }
  const p = input.refunded_quantity;

  if (
    !isSafeIntegerNonNegativeZero(input.refunded_minor) ||
    input.refunded_minor < 0 ||
    input.refunded_minor > L ||
    input.refunded_minor % u !== 0
  ) {
    throw new RefundRuleError();
  }
  const r = input.refunded_minor;

  if (
    !isSafeIntegerNonNegativeZero(input.units) ||
    input.units < 0 ||
    input.units > Q - p
  ) {
    throw new RefundRuleError();
  }
  const k = input.units;

  if (k === 0) {
    return L - r;
  }

  const netPK = refundNetForQuantity({
    settlement_unit_minor: u,
    quantity: Q,
    net_minor: L,
    units: p + k,
  });
  const netP = refundNetForQuantity({
    settlement_unit_minor: u,
    quantity: Q,
    net_minor: L,
    units: p,
  });

  return Math.min(netPK - netP, L - r);
}

function validateRefundPlanInput(input: unknown): asserts input is RefundPlanInput {
  if (!isPlainObject(input)) {
    throw new RefundRuleError();
  }
  validateSettlementUnit(input.settlement_unit_minor);
  const u = input.settlement_unit_minor;

  if (!Array.isArray(input.lines) || input.lines.length < 1 || input.lines.length > 50) {
    throw new RefundRuleError();
  }
  const seenLineRefs = new Set<string>();
  for (const line of input.lines) {
    if (!isPlainObject(line)) {
      throw new RefundRuleError();
    }
    if (!isValidRef(line.line_ref) || seenLineRefs.has(line.line_ref)) {
      throw new RefundRuleError();
    }
    seenLineRefs.add(line.line_ref);
    if (!isValidRef(line.group_ref)) {
      throw new RefundRuleError();
    }
    if (
      !isSafeIntegerNonNegativeZero(line.quantity) ||
      line.quantity < 1 ||
      line.quantity > 99
    ) {
      throw new RefundRuleError();
    }
    if (
      !isSafeIntegerNonNegativeZero(line.net_minor) ||
      line.net_minor < 0 ||
      line.net_minor % u !== 0
    ) {
      throw new RefundRuleError();
    }
    if (
      !isSafeIntegerNonNegativeZero(line.refunded_quantity) ||
      line.refunded_quantity < 0 ||
      line.refunded_quantity > line.quantity
    ) {
      throw new RefundRuleError();
    }
    if (
      !isSafeIntegerNonNegativeZero(line.refunded_minor) ||
      line.refunded_minor < 0 ||
      line.refunded_minor > line.net_minor ||
      line.refunded_minor % u !== 0
    ) {
      throw new RefundRuleError();
    }
    if (
      !isSafeIntegerNonNegativeZero(line.covered_quantity) ||
      line.covered_quantity < 0 ||
      line.covered_quantity > line.refunded_quantity
    ) {
      throw new RefundRuleError();
    }
  }

  if (!Array.isArray(input.groups) || input.groups.length < 1 || input.groups.length > 50) {
    throw new RefundRuleError();
  }
  const seenGroupRefs = new Set<string>();
  for (const group of input.groups) {
    if (!isPlainObject(group)) {
      throw new RefundRuleError();
    }
    if (!isValidRef(group.group_ref) || seenGroupRefs.has(group.group_ref)) {
      throw new RefundRuleError();
    }
    seenGroupRefs.add(group.group_ref);
    if (
      !isSafeIntegerNonNegativeZero(group.fee_minor) ||
      group.fee_minor < 0 ||
      group.fee_minor % u !== 0
    ) {
      throw new RefundRuleError();
    }
    if (
      !isSafeIntegerNonNegativeZero(group.refunded_minor) ||
      group.refunded_minor < 0 ||
      group.refunded_minor > group.fee_minor ||
      group.refunded_minor % u !== 0
    ) {
      throw new RefundRuleError();
    }
  }

  const referencedGroups = new Set<string>();
  for (const line of input.lines) {
    if (!seenGroupRefs.has(line.group_ref as string)) {
      throw new RefundRuleError();
    }
    referencedGroups.add(line.group_ref as string);
  }
  if (referencedGroups.size !== seenGroupRefs.size) {
    throw new RefundRuleError();
  }

  let totalMoney = 0n;
  for (const line of input.lines) {
    totalMoney += BigInt(line.net_minor as number);
  }
  for (const group of input.groups) {
    totalMoney += BigInt(group.fee_minor as number);
  }
  if (totalMoney > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RefundRuleError();
  }

  if (!isPlainObject(input.request)) {
    throw new RefundRuleError();
  }
  if (!REFUND_REQUEST_KINDS.includes(input.request.kind as any)) {
    throw new RefundRuleError();
  }
  if (!REFUND_REASONS.includes(input.request.reason as any)) {
    throw new RefundRuleError();
  }
  if (!Array.isArray(input.request.lines) || input.request.lines.length < 1 || input.request.lines.length > 50) {
    throw new RefundRuleError();
  }

  const seenReqLines = new Set<string>();
  for (const rl of input.request.lines) {
    if (!isPlainObject(rl)) {
      throw new RefundRuleError();
    }
    if (!isValidRef(rl.line_ref) || seenReqLines.has(rl.line_ref)) {
      throw new RefundRuleError();
    }
    seenReqLines.add(rl.line_ref);
    const orderLine = input.lines.find(l => l.line_ref === rl.line_ref);
    if (!orderLine) {
      throw new RefundRuleError();
    }
    if (!isSafeIntegerNonNegativeZero(rl.quantity)) {
      throw new RefundRuleError();
    }
    const maxK = (orderLine.quantity as number) - (orderLine.refunded_quantity as number);
    if (input.request.kind === 'cancel' || input.request.kind === 'return') {
      if (rl.quantity < 1 || rl.quantity > maxK) {
        throw new RefundRuleError();
      }
    } else {
      // refund_only
      if (rl.quantity < 0 || rl.quantity > maxK) {
        throw new RefundRuleError();
      }
    }
  }
}

/**
 * Computes suggested refund plan for a refund request.
 */
export function planRefund(input: RefundPlanInput): RefundPlan {
  validateRefundPlanInput(input);
  const u = input.settlement_unit_minor;

  const items: RefundPlanItem[] = [];
  const touchedGroupRefs: string[] = [];
  const touchedGroupSet = new Set<string>();

  for (const rl of input.request.lines) {
    const line = input.lines.find(l => l.line_ref === rl.line_ref)!;
    const cap_minor = itemRefundCap({
      settlement_unit_minor: u,
      quantity: line.quantity,
      net_minor: line.net_minor,
      refunded_quantity: line.refunded_quantity,
      refunded_minor: line.refunded_minor,
      units: rl.quantity,
    });
    items.push({
      line_ref: rl.line_ref,
      group_ref: line.group_ref,
      quantity: rl.quantity,
      cap_minor,
    });
    if (!touchedGroupSet.has(line.group_ref)) {
      touchedGroupSet.add(line.group_ref);
      touchedGroupRefs.push(line.group_ref);
    }
  }

  const qualifies =
    input.request.kind === 'cancel' ||
    (FAULT_REASONS as readonly string[]).includes(input.request.reason);
  const requestLinesMap = new Map(input.request.lines.map(rl => [rl.line_ref, rl.quantity]));

  const shipping: RefundPlanShipping[] = [];
  for (const group_ref of touchedGroupRefs) {
    const group = input.groups.find(g => g.group_ref === group_ref)!;
    const remaining_minor = group.fee_minor - group.refunded_minor;

    const linesOfGroup = input.lines.filter(l => l.group_ref === group_ref);
    const allLinesCovered = linesOfGroup.every(l => {
      const k = requestLinesMap.get(l.line_ref);
      const added = qualifies && k !== undefined ? k : 0;
      const coveredCount = l.covered_quantity + added;
      return coveredCount === l.quantity;
    });

    const suggested_minor = allLinesCovered ? remaining_minor : 0;
    shipping.push({
      group_ref,
      remaining_minor,
      suggested_minor,
    });
  }

  const suggested_total_minor =
    items.reduce((sum, it) => sum + it.cap_minor, 0) +
    shipping.reduce((sum, sh) => sum + sh.suggested_minor, 0);

  return deepFreeze({
    items,
    shipping,
    suggested_total_minor,
  });
}

/**
 * Validates a seller-adjusted refund allocation.
 */
export function checkRefundAllocation(input: RefundAllocationInput): RefundAllocationResult {
  validateRefundPlanInput(input);
  const plan = planRefund(input);
  const u = input.settlement_unit_minor;

  if (!isPlainObject(input.attempt)) {
    throw new RefundRuleError();
  }
  if (
    !isSafeIntegerNonNegativeZero(input.attempt.paid_minor) ||
    input.attempt.paid_minor < 0 ||
    input.attempt.paid_minor % u !== 0
  ) {
    throw new RefundRuleError();
  }
  if (
    !isSafeIntegerNonNegativeZero(input.attempt.refunded_minor) ||
    input.attempt.refunded_minor < 0 ||
    input.attempt.refunded_minor > input.attempt.paid_minor ||
    input.attempt.refunded_minor % u !== 0
  ) {
    throw new RefundRuleError();
  }

  if (!isPlainObject(input.allocation)) {
    throw new RefundRuleError();
  }
  if (
    !Array.isArray(input.allocation.items) ||
    input.allocation.items.length !== input.request.lines.length
  ) {
    throw new RefundRuleError();
  }
  for (let i = 0; i < input.allocation.items.length; i++) {
    const item = input.allocation.items[i];
    const req = input.request.lines[i];
    if (!isPlainObject(item)) {
      throw new RefundRuleError();
    }
    if (
      item.line_ref !== req.line_ref ||
      !isSafeIntegerNonNegativeZero(item.quantity) ||
      item.quantity !== req.quantity
    ) {
      throw new RefundRuleError();
    }
    if (!isSafeIntegerNonNegativeZero(item.amount_minor) || item.amount_minor < 0) {
      throw new RefundRuleError();
    }
  }

  if (
    !Array.isArray(input.allocation.shipping) ||
    input.allocation.shipping.length !== plan.shipping.length
  ) {
    throw new RefundRuleError();
  }
  for (let i = 0; i < input.allocation.shipping.length; i++) {
    const ship = input.allocation.shipping[i];
    const pl = plan.shipping[i];
    if (!isPlainObject(ship)) {
      throw new RefundRuleError();
    }
    if (ship.group_ref !== pl.group_ref) {
      throw new RefundRuleError();
    }
    if (!isSafeIntegerNonNegativeZero(ship.amount_minor) || ship.amount_minor < 0) {
      throw new RefundRuleError();
    }
  }

  if (input.adjustment_reason !== null && typeof input.adjustment_reason !== 'string') {
    throw new RefundRuleError();
  }

  const errors: RefundAllocationError[] = [];

  // 1. Items
  for (let i = 0; i < input.allocation.items.length; i++) {
    const item = input.allocation.items[i];
    const cap = plan.items[i].cap_minor;
    if (item.amount_minor % u !== 0) {
      errors.push({ path: `allocation.items[${i}].amount_minor`, code: 'not_unit_multiple' });
    } else if (item.amount_minor > cap) {
      errors.push({ path: `allocation.items[${i}].amount_minor`, code: 'above_cap' });
    }
  }

  // 2. Shipping
  for (let i = 0; i < input.allocation.shipping.length; i++) {
    const ship = input.allocation.shipping[i];
    const remaining = plan.shipping[i].remaining_minor;
    if (ship.amount_minor % u !== 0) {
      errors.push({ path: `allocation.shipping[${i}].amount_minor`, code: 'not_unit_multiple' });
    } else if (ship.amount_minor > remaining) {
      errors.push({ path: `allocation.shipping[${i}].amount_minor`, code: 'above_cap' });
    }
  }

  // 3. Total
  let totalBig = 0n;
  for (const item of input.allocation.items) {
    totalBig += BigInt(item.amount_minor);
  }
  for (const ship of input.allocation.shipping) {
    totalBig += BigInt(ship.amount_minor);
  }
  const maxAttemptBalance = BigInt(input.attempt.paid_minor - input.attempt.refunded_minor);
  if (totalBig === 0n) {
    errors.push({ path: 'allocation.total', code: 'total_zero' });
  } else if (totalBig > maxAttemptBalance) {
    errors.push({ path: 'allocation.total', code: 'above_attempt_balance' });
  }

  // 4. Reason
  const rawReason = input.adjustment_reason;
  if (rawReason !== null) {
    if (rawReason.includes('\u0000') || !rawReason.isWellFormed()) {
      errors.push({ path: 'adjustment_reason', code: 'adjustment_reason_format' });
    } else {
      const trimmed = rawReason.trim();
      if (trimmed !== '') {
        if ([...trimmed].length > 500) {
          errors.push({ path: 'adjustment_reason', code: 'adjustment_reason_too_long' });
        }
      } else {
        const someItemLowered = input.allocation.items.some(
          (it, i) => it.amount_minor < plan.items[i].cap_minor,
        );
        if (someItemLowered) {
          errors.push({ path: 'adjustment_reason', code: 'adjustment_reason_required' });
        }
      }
    }
  } else {
    const someItemLowered = input.allocation.items.some(
      (it, i) => it.amount_minor < plan.items[i].cap_minor,
    );
    if (someItemLowered) {
      errors.push({ path: 'adjustment_reason', code: 'adjustment_reason_required' });
    }
  }

  if (errors.length > 0) {
    return deepFreeze({ ok: false, errors });
  }

  const trimmed = rawReason === null ? null : rawReason.trim();
  const effectiveReason = trimmed === null || trimmed === '' ? null : trimmed;

  const lines: RefundLine[] = [];
  for (let i = 0; i < input.allocation.items.length; i++) {
    const item = input.allocation.items[i];
    const req = input.request.lines[i];
    lines.push({
      kind: 'item',
      line_ref: item.line_ref,
      quantity: req.quantity,
      amount_minor: item.amount_minor,
    });
  }
  for (const ship of input.allocation.shipping) {
    if (ship.amount_minor > 0) {
      lines.push({
        kind: 'shipping',
        group_ref: ship.group_ref,
        amount_minor: ship.amount_minor,
      });
    }
  }

  return deepFreeze({
    ok: true,
    total_minor: Number(totalBig),
    adjustment_reason: effectiveReason,
    lines,
  });
}
