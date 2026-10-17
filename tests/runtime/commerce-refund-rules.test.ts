import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  RefundRuleError,
  refundNetForQuantity,
  itemRefundCap,
  planRefund,
  checkRefundAllocation,
  checkUnappliedRefund,
  type RefundOrderLine,
  type RefundDeliveryGroup,
  type RefundPlanInput,
  type RefundAllocationInput,
} from '../../modules/agent-commerce/payments/rules/index.js';

// --- Immutability Helpers ---

function assertNotFrozen(val: unknown): void {
  if (val === null || typeof val !== 'object') {
    return;
  }
  assert.equal(Object.isFrozen(val), false, 'Expected object/array to NOT be frozen');
  for (const key of Object.keys(val)) {
    // @ts-expect-error indexing
    assertNotFrozen(val[key]);
  }
}

function assertDeepFrozen(val: unknown): void {
  if (val === null || typeof val !== 'object') {
    return;
  }
  assert.equal(Object.isFrozen(val), true, 'Expected object/array to be deeply frozen');
  for (const key of Object.keys(val)) {
    // @ts-expect-error indexing
    assertDeepFrozen(val[key]);
  }
}

function assertThrowsRuleError(fn: () => unknown): void {
  try {
    fn();
    assert.fail('Expected RefundRuleError to be thrown');
  } catch (err: any) {
    assert(err instanceof RefundRuleError);
    assert.equal(err.code, 'invalid_input');
    assert.equal(err.name, 'RefundRuleError');
    assert.equal(err.message, 'Invalid refund rule input');
  }
}

// --- Fixture Builders ---

function makeBaseOrder() {
  return {
    settlement_unit_minor: 100,
    groups: [
      { group_ref: 'g1', fee_minor: 6000, refunded_minor: 0 },
      { group_ref: 'g2', fee_minor: 8000, refunded_minor: 0 },
    ],
    lines: [
      {
        line_ref: 'a',
        group_ref: 'g1',
        quantity: 2,
        net_minor: 50000,
        refunded_quantity: 0,
        refunded_minor: 0,
        covered_quantity: 0,
      },
      {
        line_ref: 'b',
        group_ref: 'g1',
        quantity: 1,
        net_minor: 30000,
        refunded_quantity: 0,
        refunded_minor: 0,
        covered_quantity: 0,
      },
      {
        line_ref: 'c',
        group_ref: 'g2',
        quantity: 1,
        net_minor: 20000,
        refunded_quantity: 0,
        refunded_minor: 0,
        covered_quantity: 0,
      },
    ],
  };
}

describe('commerce-refund-rules', () => {
  describe('1. net and caps', () => {
    it('u = 100, L = 29000, Q = 3 net and caps progression', () => {
      const u = 100;
      const L = 29000;
      const Q = 3;

      // net 0, 9600, 19300, 29000
      assert.equal(refundNetForQuantity({ settlement_unit_minor: u, quantity: Q, net_minor: L, units: 0 }), 0);
      assert.equal(refundNetForQuantity({ settlement_unit_minor: u, quantity: Q, net_minor: L, units: 1 }), 9600);
      assert.equal(refundNetForQuantity({ settlement_unit_minor: u, quantity: Q, net_minor: L, units: 2 }), 19300);
      assert.equal(refundNetForQuantity({ settlement_unit_minor: u, quantity: Q, net_minor: L, units: 3 }), 29000);

      // one by one 9600, 9700, 9700
      const c1 = itemRefundCap({ settlement_unit_minor: u, quantity: Q, net_minor: L, refunded_quantity: 0, refunded_minor: 0, units: 1 });
      assert.equal(c1, 9600);
      const c2 = itemRefundCap({ settlement_unit_minor: u, quantity: Q, net_minor: L, refunded_quantity: 1, refunded_minor: 9600, units: 1 });
      assert.equal(c2, 9700);
      const c3 = itemRefundCap({ settlement_unit_minor: u, quantity: Q, net_minor: L, refunded_quantity: 2, refunded_minor: 19300, units: 1 });
      assert.equal(c3, 9700);

      // two then one 19300, 9700
      const cTwo = itemRefundCap({ settlement_unit_minor: u, quantity: Q, net_minor: L, refunded_quantity: 0, refunded_minor: 0, units: 2 });
      assert.equal(cTwo, 19300);
      const cOneAfterTwo = itemRefundCap({ settlement_unit_minor: u, quantity: Q, net_minor: L, refunded_quantity: 2, refunded_minor: 19300, units: 1 });
      assert.equal(cOneAfterTwo, 9700);

      // price difference 5000 first (k = 0 cap 29000), then three single units 9600, 9700, 4700 (the last is L − r), or all three at once 24000
      const cPd = itemRefundCap({ settlement_unit_minor: u, quantity: Q, net_minor: L, refunded_quantity: 0, refunded_minor: 0, units: 0 });
      assert.equal(cPd, 29000);

      const rAfterPd = 5000;
      const cU1 = itemRefundCap({ settlement_unit_minor: u, quantity: Q, net_minor: L, refunded_quantity: 0, refunded_minor: rAfterPd, units: 1 });
      assert.equal(cU1, 9600);
      const cU2 = itemRefundCap({ settlement_unit_minor: u, quantity: Q, net_minor: L, refunded_quantity: 1, refunded_minor: rAfterPd + 9600, units: 1 });
      assert.equal(cU2, 9700);
      const cU3 = itemRefundCap({ settlement_unit_minor: u, quantity: Q, net_minor: L, refunded_quantity: 2, refunded_minor: rAfterPd + 9600 + 9700, units: 1 });
      assert.equal(cU3, 4700); // L - r = 29000 - 24300 = 4700

      const cAllThree = itemRefundCap({ settlement_unit_minor: u, quantity: Q, net_minor: L, refunded_quantity: 0, refunded_minor: rAfterPd, units: 3 });
      assert.equal(cAllThree, 24000); // min(29000, 24000) = 24000
    });

    it('u = 1, L = 1000, Q = 3 and Q = 7', () => {
      const u = 1;
      const L = 1000;
      // Q = 3: 333, 333, 334
      const c1 = itemRefundCap({ settlement_unit_minor: u, quantity: 3, net_minor: L, refunded_quantity: 0, refunded_minor: 0, units: 1 });
      const c2 = itemRefundCap({ settlement_unit_minor: u, quantity: 3, net_minor: L, refunded_quantity: 1, refunded_minor: c1, units: 1 });
      const c3 = itemRefundCap({ settlement_unit_minor: u, quantity: 3, net_minor: L, refunded_quantity: 2, refunded_minor: c1 + c2, units: 1 });
      assert.deepEqual([c1, c2, c3], [333, 333, 334]);

      // Q = 7: 142 then six × 143
      let p = 0;
      let r = 0;
      const q7Caps: number[] = [];
      for (let i = 0; i < 7; i++) {
        const cap = itemRefundCap({ settlement_unit_minor: u, quantity: 7, net_minor: L, refunded_quantity: p, refunded_minor: r, units: 1 });
        q7Caps.push(cap);
        p += 1;
        r += cap;
      }
      assert.deepEqual(q7Caps, [142, 143, 143, 143, 143, 143, 143]);
    });

    it('u = 100, L = 100000, Q = 7 net progression', () => {
      const u = 100;
      const L = 100000;
      const Q = 7;
      const nets = [0, 1, 2, 3, 4, 5, 6, 7].map(units =>
        refundNetForQuantity({ settlement_unit_minor: u, quantity: Q, net_minor: L, units }),
      );
      assert.deepEqual(nets, [0, 14200, 28500, 42800, 57100, 71400, 85700, 100000]);
    });

    it('BigInt large vectors', () => {
      // u = 1, L = 9007199254740991, Q = 99 → net(98) = 8916217444087041 and net(1) = 90981810653949
      assert.equal(
        refundNetForQuantity({ settlement_unit_minor: 1, quantity: 99, net_minor: 9007199254740991, units: 98 }),
        8916217444087041,
      );
      assert.equal(
        refundNetForQuantity({ settlement_unit_minor: 1, quantity: 99, net_minor: 9007199254740991, units: 1 }),
        90981810653949,
      );

      // Q = 97 → net(50) = 4642886213784015
      assert.equal(
        refundNetForQuantity({ settlement_unit_minor: 1, quantity: 97, net_minor: 9007199254740991, units: 50 }),
        4642886213784015,
      );

      // u = 100, L = 9007199254740900, Q = 99 → net(98) = 8916217444086900
      assert.equal(
        refundNetForQuantity({ settlement_unit_minor: 100, quantity: 99, net_minor: 9007199254740900, units: 98 }),
        8916217444086900,
      );
    });
  });

  describe('2. Partition property', () => {
    function generateCompositions(n: number): number[][] {
      if (n === 1) return [[1]];
      const prev = generateCompositions(n - 1);
      const res: number[][] = [];
      for (const comp of prev) {
        res.push([...comp, 1]);
        res.push([...comp.slice(0, -1), comp[comp.length - 1] + 1]);
      }
      return res;
    }

    it('partitions L exactly for all compositions of Q up to 6 across units and values', () => {
      const unitsList = [1, 100];
      for (const u of unitsList) {
        for (let Q = 1; Q <= 6; Q++) {
          const compositions = generateCompositions(Q);
          assert.equal(compositions.length, 2 ** (Q - 1));
          const amounts = [0, u, 7 * u, 290 * u, 1001 * u];
          for (const L of amounts) {
            for (const comp of compositions) {
              let p = 0;
              let r = 0;
              let sumCaps = 0;
              for (const k of comp) {
                const cap = itemRefundCap({
                  settlement_unit_minor: u,
                  quantity: Q,
                  net_minor: L,
                  refunded_quantity: p,
                  refunded_minor: r,
                  units: k,
                });
                const netPK = refundNetForQuantity({ settlement_unit_minor: u, quantity: Q, net_minor: L, units: p + k });
                const netP = refundNetForQuantity({ settlement_unit_minor: u, quantity: Q, net_minor: L, units: p });
                assert.equal(cap, netPK - netP);
                sumCaps += cap;
                r += cap;
                p += k;
              }
              assert.equal(sumCaps, L);
              assert.equal(r, L);
              assert.equal(p, Q);
            }
          }
        }
      }
    });
  });

  describe('3. Plans (S1 to S13)', () => {
    it('S1 cancel/changed_mind [a×2]', () => {
      const base = makeBaseOrder();
      const plan = planRefund({
        ...base,
        request: {
          kind: 'cancel',
          reason: 'changed_mind',
          lines: [{ line_ref: 'a', quantity: 2 }],
        },
      });
      assert.deepEqual(plan, {
        items: [{ line_ref: 'a', group_ref: 'g1', quantity: 2, cap_minor: 50000 }],
        shipping: [{ group_ref: 'g1', remaining_minor: 6000, suggested_minor: 0 }],
        suggested_total_minor: 50000,
      });
    });

    it('S2 with a p 2, r 50000, covered 2: cancel/changed_mind [b×1]', () => {
      const base = makeBaseOrder();
      base.lines[0] = { ...base.lines[0], refunded_quantity: 2, refunded_minor: 50000, covered_quantity: 2 };
      const plan = planRefund({
        ...base,
        request: {
          kind: 'cancel',
          reason: 'changed_mind',
          lines: [{ line_ref: 'b', quantity: 1 }],
        },
      });
      assert.deepEqual(plan, {
        items: [{ line_ref: 'b', group_ref: 'g1', quantity: 1, cap_minor: 30000 }],
        shipping: [{ group_ref: 'g1', remaining_minor: 6000, suggested_minor: 6000 }],
        suggested_total_minor: 36000,
      });
    });

    it('S3 cancel/changed_mind [a×2, b×1]', () => {
      const base = makeBaseOrder();
      const plan = planRefund({
        ...base,
        request: {
          kind: 'cancel',
          reason: 'changed_mind',
          lines: [{ line_ref: 'a', quantity: 2 }, { line_ref: 'b', quantity: 1 }],
        },
      });
      assert.deepEqual(plan, {
        items: [
          { line_ref: 'a', group_ref: 'g1', quantity: 2, cap_minor: 50000 },
          { line_ref: 'b', group_ref: 'g1', quantity: 1, cap_minor: 30000 },
        ],
        shipping: [{ group_ref: 'g1', remaining_minor: 6000, suggested_minor: 6000 }],
        suggested_total_minor: 86000,
      });
    });

    it('S4 return/damaged [c×1]', () => {
      const base = makeBaseOrder();
      const plan = planRefund({
        ...base,
        request: {
          kind: 'return',
          reason: 'damaged',
          lines: [{ line_ref: 'c', quantity: 1 }],
        },
      });
      assert.deepEqual(plan, {
        items: [{ line_ref: 'c', group_ref: 'g2', quantity: 1, cap_minor: 20000 }],
        shipping: [{ group_ref: 'g2', remaining_minor: 8000, suggested_minor: 8000 }],
        suggested_total_minor: 28000,
      });
    });

    it('S5 return/changed_mind [c×1]', () => {
      const base = makeBaseOrder();
      const plan = planRefund({
        ...base,
        request: {
          kind: 'return',
          reason: 'changed_mind',
          lines: [{ line_ref: 'c', quantity: 1 }],
        },
      });
      assert.deepEqual(plan, {
        items: [{ line_ref: 'c', group_ref: 'g2', quantity: 1, cap_minor: 20000 }],
        shipping: [{ group_ref: 'g2', remaining_minor: 8000, suggested_minor: 0 }],
        suggested_total_minor: 20000,
      });
    });

    it('S6 refund_only/not_as_described [c×0]', () => {
      const base = makeBaseOrder();
      const plan = planRefund({
        ...base,
        request: {
          kind: 'refund_only',
          reason: 'not_as_described',
          lines: [{ line_ref: 'c', quantity: 0 }],
        },
      });
      assert.deepEqual(plan, {
        items: [{ line_ref: 'c', group_ref: 'g2', quantity: 0, cap_minor: 20000 }],
        shipping: [{ group_ref: 'g2', remaining_minor: 8000, suggested_minor: 0 }],
        suggested_total_minor: 20000,
      });
    });

    it('S7 with c r 5000 (earlier price difference; p 0): refund_only/lost [c×1]', () => {
      const base = makeBaseOrder();
      base.lines[2] = { ...base.lines[2], refunded_minor: 5000, refunded_quantity: 0 };
      const plan = planRefund({
        ...base,
        request: {
          kind: 'refund_only',
          reason: 'lost',
          lines: [{ line_ref: 'c', quantity: 1 }],
        },
      });
      assert.deepEqual(plan, {
        items: [{ line_ref: 'c', group_ref: 'g2', quantity: 1, cap_minor: 15000 }],
        shipping: [{ group_ref: 'g2', remaining_minor: 8000, suggested_minor: 8000 }],
        suggested_total_minor: 23000,
      });
    });

    it('S8 with g2 refunded 3000: return/wrong_item [c×1]', () => {
      const base = makeBaseOrder();
      base.groups[1] = { ...base.groups[1], refunded_minor: 3000 };
      const plan = planRefund({
        ...base,
        request: {
          kind: 'return',
          reason: 'wrong_item',
          lines: [{ line_ref: 'c', quantity: 1 }],
        },
      });
      assert.deepEqual(plan, {
        items: [{ line_ref: 'c', group_ref: 'g2', quantity: 1, cap_minor: 20000 }],
        shipping: [{ group_ref: 'g2', remaining_minor: 5000, suggested_minor: 5000 }],
        suggested_total_minor: 25000,
      });
    });

    it('S9 with a p 2, r 50000, covered 2: return/damaged [b×1]', () => {
      const base = makeBaseOrder();
      base.lines[0] = { ...base.lines[0], refunded_quantity: 2, refunded_minor: 50000, covered_quantity: 2 };
      const plan = planRefund({
        ...base,
        request: {
          kind: 'return',
          reason: 'damaged',
          lines: [{ line_ref: 'b', quantity: 1 }],
        },
      });
      assert.deepEqual(plan, {
        items: [{ line_ref: 'b', group_ref: 'g1', quantity: 1, cap_minor: 30000 }],
        shipping: [{ group_ref: 'g1', remaining_minor: 6000, suggested_minor: 6000 }],
        suggested_total_minor: 36000,
      });
    });

    it('S10 with a p 2, r 50000, covered 0: return/damaged [b×1]', () => {
      const base = makeBaseOrder();
      base.lines[0] = { ...base.lines[0], refunded_quantity: 2, refunded_minor: 50000, covered_quantity: 0 };
      const plan = planRefund({
        ...base,
        request: {
          kind: 'return',
          reason: 'damaged',
          lines: [{ line_ref: 'b', quantity: 1 }],
        },
      });
      assert.deepEqual(plan, {
        items: [{ line_ref: 'b', group_ref: 'g1', quantity: 1, cap_minor: 30000 }],
        shipping: [{ group_ref: 'g1', remaining_minor: 6000, suggested_minor: 0 }],
        suggested_total_minor: 30000,
      });
    });

    it('S11 return/damaged [a×1, c×1]', () => {
      const base = makeBaseOrder();
      const plan = planRefund({
        ...base,
        request: {
          kind: 'return',
          reason: 'damaged',
          lines: [{ line_ref: 'a', quantity: 1 }, { line_ref: 'c', quantity: 1 }],
        },
      });
      assert.deepEqual(plan, {
        items: [
          { line_ref: 'a', group_ref: 'g1', quantity: 1, cap_minor: 25000 },
          { line_ref: 'c', group_ref: 'g2', quantity: 1, cap_minor: 20000 },
        ],
        shipping: [
          { group_ref: 'g1', remaining_minor: 6000, suggested_minor: 0 },
          { group_ref: 'g2', remaining_minor: 8000, suggested_minor: 8000 },
        ],
        suggested_total_minor: 53000,
      });
    });

    it('S12 cancel/other [c×1, a×2]', () => {
      const base = makeBaseOrder();
      const plan = planRefund({
        ...base,
        request: {
          kind: 'cancel',
          reason: 'other',
          lines: [{ line_ref: 'c', quantity: 1 }, { line_ref: 'a', quantity: 2 }],
        },
      });
      assert.deepEqual(plan, {
        items: [
          { line_ref: 'c', group_ref: 'g2', quantity: 1, cap_minor: 20000 },
          { line_ref: 'a', group_ref: 'g1', quantity: 2, cap_minor: 50000 },
        ],
        shipping: [
          { group_ref: 'g2', remaining_minor: 8000, suggested_minor: 8000 },
          { group_ref: 'g1', remaining_minor: 6000, suggested_minor: 0 },
        ],
        suggested_total_minor: 78000,
      });
    });

    it('S13 with g1 refunded 6000 and a p 2, r 50000, covered 2: cancel/changed_mind [b×1]', () => {
      const base = makeBaseOrder();
      base.groups[0] = { ...base.groups[0], refunded_minor: 6000 };
      base.lines[0] = { ...base.lines[0], refunded_quantity: 2, refunded_minor: 50000, covered_quantity: 2 };
      const plan = planRefund({
        ...base,
        request: {
          kind: 'cancel',
          reason: 'changed_mind',
          lines: [{ line_ref: 'b', quantity: 1 }],
        },
      });
      assert.deepEqual(plan, {
        items: [{ line_ref: 'b', group_ref: 'g1', quantity: 1, cap_minor: 30000 }],
        shipping: [{ group_ref: 'g1', remaining_minor: 0, suggested_minor: 0 }],
        suggested_total_minor: 30000,
      });
    });
  });

  describe('4. Allocation checks (S11 base, attempt paid 114000, refunded 0)', () => {
    function makeS11Input(): RefundAllocationInput {
      const base = makeBaseOrder();
      return {
        ...base,
        request: {
          kind: 'return',
          reason: 'damaged',
          lines: [{ line_ref: 'a', quantity: 1 }, { line_ref: 'c', quantity: 1 }],
        },
        attempt: { paid_minor: 114000, refunded_minor: 0 },
        allocation: {
          items: [
            { line_ref: 'a', quantity: 1, amount_minor: 25000 },
            { line_ref: 'c', quantity: 1, amount_minor: 20000 },
          ],
          shipping: [
            { group_ref: 'g1', amount_minor: 0 },
            { group_ref: 'g2', amount_minor: 8000 },
          ],
        },
        adjustment_reason: null,
      };
    }

    it('C1 items [a 25000, c 20000], shipping [g1 0, g2 8000], reason null → ok', () => {
      const input = makeS11Input();
      const res = checkRefundAllocation(input);
      assert.deepEqual(res, {
        ok: true,
        total_minor: 53000,
        adjustment_reason: null,
        lines: [
          { kind: 'item', line_ref: 'a', quantity: 1, amount_minor: 25000 },
          { kind: 'item', line_ref: 'c', quantity: 1, amount_minor: 20000 },
          { kind: 'shipping', group_ref: 'g2', amount_minor: 8000 },
        ],
      });
    });

    it('C2 items [a 20000, c 20000], same shipping, reason null or whitespace → adjustment_reason_required', () => {
      const input = makeS11Input();
      const inputLowered: RefundAllocationInput = {
        ...input,
        allocation: {
          ...input.allocation,
          items: [
            { line_ref: 'a', quantity: 1, amount_minor: 20000 },
            input.allocation.items[1],
          ],
        },
      };

      const resNull = checkRefundAllocation(inputLowered);
      assert.deepEqual(resNull, {
        ok: false,
        errors: [{ path: 'adjustment_reason', code: 'adjustment_reason_required' }],
      });

      const resSpace = checkRefundAllocation({ ...inputLowered, adjustment_reason: '   ' });
      assert.deepEqual(resSpace, {
        ok: false,
        errors: [{ path: 'adjustment_reason', code: 'adjustment_reason_required' }],
      });
    });

    it('C3 as C2 with reason "  商品有使用痕跡  " → ok, total 48000, reason "商品有使用痕跡"', () => {
      const input = makeS11Input();
      const inputLowered: RefundAllocationInput = {
        ...input,
        allocation: {
          ...input.allocation,
          items: [
            { line_ref: 'a', quantity: 1, amount_minor: 20000 },
            input.allocation.items[1],
          ],
        },
        adjustment_reason: '  商品有使用痕跡  ',
      };
      const res = checkRefundAllocation(inputLowered);
      assert.deepEqual(res, {
        ok: true,
        total_minor: 48000,
        adjustment_reason: '商品有使用痕跡',
        lines: [
          { kind: 'item', line_ref: 'a', quantity: 1, amount_minor: 20000 },
          { kind: 'item', line_ref: 'c', quantity: 1, amount_minor: 20000 },
          { kind: 'shipping', group_ref: 'g2', amount_minor: 8000 },
        ],
      });
    });

    it('C4 items [a 25100, c 20050], shipping [g1 6100, g2 8000], reason null → ordered errors', () => {
      const input = makeS11Input();
      const inputModified: RefundAllocationInput = {
        ...input,
        allocation: {
          items: [
            { line_ref: 'a', quantity: 1, amount_minor: 25100 },
            { line_ref: 'c', quantity: 1, amount_minor: 20050 },
          ],
          shipping: [
            { group_ref: 'g1', amount_minor: 6100 },
            { group_ref: 'g2', amount_minor: 8000 },
          ],
        },
      };
      const res = checkRefundAllocation(inputModified);
      assert.deepEqual(res, {
        ok: false,
        errors: [
          { path: 'allocation.items[0].amount_minor', code: 'above_cap' },
          { path: 'allocation.items[1].amount_minor', code: 'not_unit_multiple' },
          { path: 'allocation.shipping[0].amount_minor', code: 'above_cap' },
        ],
      });
    });

    it('C5 items [a 0, c 0], shipping [g1 0, g2 0], reason "包裝已拆" → total_zero', () => {
      const input = makeS11Input();
      const inputZero: RefundAllocationInput = {
        ...input,
        allocation: {
          items: [
            { line_ref: 'a', quantity: 1, amount_minor: 0 },
            { line_ref: 'c', quantity: 1, amount_minor: 0 },
          ],
          shipping: [
            { group_ref: 'g1', amount_minor: 0 },
            { group_ref: 'g2', amount_minor: 0 },
          ],
        },
        adjustment_reason: '包裝已拆',
      };
      const res = checkRefundAllocation(inputZero);
      assert.deepEqual(res, {
        ok: false,
        errors: [{ path: 'allocation.total', code: 'total_zero' }],
      });
    });

    it('C6 C1 with attempt refunded 70000 → above_attempt_balance', () => {
      const input = makeS11Input();
      const res = checkRefundAllocation({
        ...input,
        attempt: { paid_minor: 114000, refunded_minor: 70000 },
      });
      assert.deepEqual(res, {
        ok: false,
        errors: [{ path: 'allocation.total', code: 'above_attempt_balance' }],
      });
    });

    it('C7 C2 with reasons: 500 × 字 ok, 501 × 字 too long, lone surrogate/U+0000 format', () => {
      const input = makeS11Input();
      const inputLowered: RefundAllocationInput = {
        ...input,
        allocation: {
          ...input.allocation,
          items: [
            { line_ref: 'a', quantity: 1, amount_minor: 20000 },
            input.allocation.items[1],
          ],
        },
      };

      // 500 chars ok
      const r500 = checkRefundAllocation({ ...inputLowered, adjustment_reason: '字'.repeat(500) });
      assert.deepEqual(r500, {
        ok: true,
        total_minor: 48000,
        adjustment_reason: '字'.repeat(500),
        lines: [
          { kind: 'item', line_ref: 'a', quantity: 1, amount_minor: 20000 },
          { kind: 'item', line_ref: 'c', quantity: 1, amount_minor: 20000 },
          { kind: 'shipping', group_ref: 'g2', amount_minor: 8000 },
        ],
      });

      // 501 chars too long
      const r501 = checkRefundAllocation({ ...inputLowered, adjustment_reason: '字'.repeat(501) });
      assert.deepEqual(r501, {
        ok: false,
        errors: [{ path: 'adjustment_reason', code: 'adjustment_reason_too_long' }],
      });

      // U+0000 format
      const rNullChar = checkRefundAllocation({ ...inputLowered, adjustment_reason: 'a\u0000b' });
      assert.deepEqual(rNullChar, {
        ok: false,
        errors: [{ path: 'adjustment_reason', code: 'adjustment_reason_format' }],
      });

      // Lone surrogate format
      const rSurrogate = checkRefundAllocation({ ...inputLowered, adjustment_reason: '\uD800' });
      assert.deepEqual(rSurrogate, {
        ok: false,
        errors: [{ path: 'adjustment_reason', code: 'adjustment_reason_format' }],
      });
    });

    it('C8 C2 (lowered a) with shipping [g1 6100, g2 8000] → above_cap, then adjustment_reason_required', () => {
      const input = makeS11Input();
      const inputLowered: RefundAllocationInput = {
        ...input,
        allocation: {
          items: [
            { line_ref: 'a', quantity: 1, amount_minor: 20000 },
            input.allocation.items[1],
          ],
          shipping: [
            { group_ref: 'g1', amount_minor: 6100 },
            input.allocation.shipping[1],
          ],
        },
      };
      const res = checkRefundAllocation(inputLowered);
      assert.deepEqual(res, {
        ok: false,
        errors: [
          { path: 'allocation.shipping[0].amount_minor', code: 'above_cap' },
          { path: 'adjustment_reason', code: 'adjustment_reason_required' },
        ],
      });
    });

    it('C9 caller malformed input throws RefundRuleError', () => {
      const input = makeS11Input();

      // items in swapped order
      assertThrowsRuleError(() =>
        checkRefundAllocation({
          ...input,
          allocation: {
            ...input.allocation,
            items: [input.allocation.items[1], input.allocation.items[0]],
          },
        }),
      );

      // c missing
      assertThrowsRuleError(() =>
        checkRefundAllocation({
          ...input,
          allocation: {
            ...input.allocation,
            items: [input.allocation.items[0]],
          },
        }),
      );

      // a with quantity 2
      assertThrowsRuleError(() =>
        checkRefundAllocation({
          ...input,
          allocation: {
            ...input.allocation,
            items: [{ line_ref: 'a', quantity: 2, amount_minor: 25000 }, input.allocation.items[1]],
          },
        }),
      );

      // shipping missing g1
      assertThrowsRuleError(() =>
        checkRefundAllocation({
          ...input,
          allocation: {
            ...input.allocation,
            shipping: [input.allocation.shipping[1]],
          },
        }),
      );

      // shipping in swapped order
      assertThrowsRuleError(() =>
        checkRefundAllocation({
          ...input,
          allocation: {
            ...input.allocation,
            shipping: [input.allocation.shipping[1], input.allocation.shipping[0]],
          },
        }),
      );

      // amount −100
      assertThrowsRuleError(() =>
        checkRefundAllocation({
          ...input,
          allocation: {
            ...input.allocation,
            items: [{ line_ref: 'a', quantity: 1, amount_minor: -100 }, input.allocation.items[1]],
          },
        }),
      );

      // amount 1.5
      assertThrowsRuleError(() =>
        checkRefundAllocation({
          ...input,
          allocation: {
            ...input.allocation,
            items: [{ line_ref: 'a', quantity: 1, amount_minor: 1.5 }, input.allocation.items[1]],
          },
        }),
      );

      // amount '100'
      assertThrowsRuleError(() =>
        checkRefundAllocation({
          ...input,
          allocation: {
            ...input.allocation,
            items: [{ line_ref: 'a', quantity: 1, amount_minor: '100' as any }, input.allocation.items[1]],
          },
        }),
      );

      // amount -0
      assertThrowsRuleError(() =>
        checkRefundAllocation({
          ...input,
          allocation: {
            ...input.allocation,
            items: [{ line_ref: 'a', quantity: 1, amount_minor: -0 }, input.allocation.items[1]],
          },
        }),
      );

      // reason 5
      assertThrowsRuleError(() =>
        checkRefundAllocation({
          ...input,
          adjustment_reason: 5 as any,
        }),
      );

      // attempt refunded > paid
      assertThrowsRuleError(() =>
        checkRefundAllocation({
          ...input,
          attempt: { paid_minor: 1000, refunded_minor: 2000 },
        }),
      );

      // attempt paid 150
      assertThrowsRuleError(() =>
        checkRefundAllocation({
          ...input,
          attempt: { paid_minor: 150, refunded_minor: 0 },
        }),
      );
    });
  });

  describe('5. Unapplied refunds', () => {
    it('valid and business error cases', () => {
      const u = 100;
      const unapplied = 150000;

      // amount 150000 → ok
      const okRes = checkUnappliedRefund({
        settlement_unit_minor: u,
        unapplied_minor: unapplied,
        refunded_minor: 0,
        amount_minor: 150000,
      });
      assert.deepEqual(okRes, {
        ok: true,
        line: { kind: 'unapplied', amount_minor: 150000 },
      });

      // 150050 → not_unit_multiple
      const resNotMultiple = checkUnappliedRefund({
        settlement_unit_minor: u,
        unapplied_minor: unapplied,
        refunded_minor: 0,
        amount_minor: 150050,
      });
      assert.deepEqual(resNotMultiple, {
        ok: false,
        errors: [{ path: 'amount_minor', code: 'not_unit_multiple' }],
      });

      // 0 → total_zero
      const resZero = checkUnappliedRefund({
        settlement_unit_minor: u,
        unapplied_minor: unapplied,
        refunded_minor: 0,
        amount_minor: 0,
      });
      assert.deepEqual(resZero, {
        ok: false,
        errors: [{ path: 'amount_minor', code: 'total_zero' }],
      });

      // 160000 → above_cap
      const resAbove = checkUnappliedRefund({
        settlement_unit_minor: u,
        unapplied_minor: unapplied,
        refunded_minor: 0,
        amount_minor: 160000,
      });
      assert.deepEqual(resAbove, {
        ok: false,
        errors: [{ path: 'amount_minor', code: 'above_cap' }],
      });

      // refunded 100000 with 60000 → above_cap, with 50000 → ok
      const resRefAbove = checkUnappliedRefund({
        settlement_unit_minor: u,
        unapplied_minor: unapplied,
        refunded_minor: 100000,
        amount_minor: 60000,
      });
      assert.deepEqual(resRefAbove, {
        ok: false,
        errors: [{ path: 'amount_minor', code: 'above_cap' }],
      });

      const resRefOk = checkUnappliedRefund({
        settlement_unit_minor: u,
        unapplied_minor: unapplied,
        refunded_minor: 100000,
        amount_minor: 50000,
      });
      assert.deepEqual(resRefOk, {
        ok: true,
        line: { kind: 'unapplied', amount_minor: 50000 },
      });
    });

    it('throws on invalid inputs', () => {
      // unapplied 150050 (not multiple)
      assertThrowsRuleError(() =>
        checkUnappliedRefund({
          settlement_unit_minor: 100,
          unapplied_minor: 150050,
          refunded_minor: 0,
          amount_minor: 10000,
        }),
      );

      // refunded > unapplied
      assertThrowsRuleError(() =>
        checkUnappliedRefund({
          settlement_unit_minor: 100,
          unapplied_minor: 100000,
          refunded_minor: 100100,
          amount_minor: 10000,
        }),
      );

      // u = 10
      assertThrowsRuleError(() =>
        checkUnappliedRefund({
          settlement_unit_minor: 10 as any,
          unapplied_minor: 100000,
          refunded_minor: 0,
          amount_minor: 10000,
        }),
      );
    });
  });

  describe('6. Input validation (throws RefundRuleError)', () => {
    it('u 10 and "100"', () => {
      const base = makeBaseOrder();
      assertThrowsRuleError(() => planRefund({ ...base, settlement_unit_minor: 10 as any, request: { kind: 'cancel', reason: 'changed_mind', lines: [{ line_ref: 'a', quantity: 1 }] } }));
      assertThrowsRuleError(() => planRefund({ ...base, settlement_unit_minor: '100' as any, request: { kind: 'cancel', reason: 'changed_mind', lines: [{ line_ref: 'a', quantity: 1 }] } }));
    });

    it('0 and 51 lines', () => {
      const base = makeBaseOrder();
      assertThrowsRuleError(() => planRefund({ ...base, lines: [], request: { kind: 'cancel', reason: 'changed_mind', lines: [] } }));

      const lines51: RefundOrderLine[] = [];
      for (let i = 1; i <= 51; i++) {
        lines51.push({
          line_ref: `line_${i}`,
          group_ref: 'g1',
          quantity: 1,
          net_minor: 100,
          refunded_quantity: 0,
          refunded_minor: 0,
          covered_quantity: 0,
        });
      }
      assertThrowsRuleError(() => planRefund({ ...base, lines: lines51, request: { kind: 'cancel', reason: 'changed_mind', lines: [{ line_ref: 'line_1', quantity: 1 }] } }));
    });

    it('duplicate line_ref', () => {
      const base = makeBaseOrder();
      const dupLines = [
        base.lines[0],
        { ...base.lines[1], line_ref: base.lines[0].line_ref },
      ];
      assertThrowsRuleError(() => planRefund({ ...base, lines: dupLines, request: { kind: 'cancel', reason: 'changed_mind', lines: [{ line_ref: 'a', quantity: 1 }] } }));
    });

    it('ref "-a" and 81 characters', () => {
      const base = makeBaseOrder();
      assertThrowsRuleError(() =>
        planRefund({
          ...base,
          lines: [{ ...base.lines[0], line_ref: '-a' }],
          request: { kind: 'cancel', reason: 'changed_mind', lines: [{ line_ref: '-a', quantity: 1 }] },
        }),
      );

      const ref81 = 'a'.repeat(81);
      assertThrowsRuleError(() =>
        planRefund({
          ...base,
          lines: [{ ...base.lines[0], line_ref: ref81 }],
          request: { kind: 'cancel', reason: 'changed_mind', lines: [{ line_ref: ref81, quantity: 1 }] },
        }),
      );
    });

    it('Q 0 and 100', () => {
      const base = makeBaseOrder();
      assertThrowsRuleError(() => planRefund({ ...base, lines: [{ ...base.lines[0], quantity: 0 }], request: { kind: 'cancel', reason: 'changed_mind', lines: [{ line_ref: 'a', quantity: 1 }] } }));
      assertThrowsRuleError(() => planRefund({ ...base, lines: [{ ...base.lines[0], quantity: 100 }], request: { kind: 'cancel', reason: 'changed_mind', lines: [{ line_ref: 'a', quantity: 1 }] } }));
    });

    it('net_minor 150 with u 100', () => {
      const base = makeBaseOrder();
      assertThrowsRuleError(() => planRefund({ ...base, lines: [{ ...base.lines[0], net_minor: 150 }], request: { kind: 'cancel', reason: 'changed_mind', lines: [{ line_ref: 'a', quantity: 1 }] } }));
    });

    it('refunded_quantity > Q', () => {
      const base = makeBaseOrder();
      assertThrowsRuleError(() => planRefund({ ...base, lines: [{ ...base.lines[0], refunded_quantity: 3 }], request: { kind: 'cancel', reason: 'changed_mind', lines: [{ line_ref: 'a', quantity: 1 }] } }));
    });

    it('refunded_minor > L', () => {
      const base = makeBaseOrder();
      assertThrowsRuleError(() => planRefund({ ...base, lines: [{ ...base.lines[0], refunded_minor: 60000 }], request: { kind: 'cancel', reason: 'changed_mind', lines: [{ line_ref: 'a', quantity: 1 }] } }));
    });

    it('covered_quantity > p', () => {
      const base = makeBaseOrder();
      assertThrowsRuleError(() => planRefund({ ...base, lines: [{ ...base.lines[0], refunded_quantity: 1, covered_quantity: 2 }], request: { kind: 'cancel', reason: 'changed_mind', lines: [{ line_ref: 'a', quantity: 1 }] } }));
    });

    it('a line naming an unknown group', () => {
      const base = makeBaseOrder();
      assertThrowsRuleError(() => planRefund({ ...base, lines: [{ ...base.lines[0], group_ref: 'unknown_g' }], request: { kind: 'cancel', reason: 'changed_mind', lines: [{ line_ref: 'a', quantity: 1 }] } }));
    });

    it('a group without lines', () => {
      const base = makeBaseOrder();
      const extraGroup: RefundDeliveryGroup = { group_ref: 'g3', fee_minor: 1000, refunded_minor: 0 };
      assertThrowsRuleError(() => planRefund({ ...base, groups: [...base.groups, extraGroup], request: { kind: 'cancel', reason: 'changed_mind', lines: [{ line_ref: 'a', quantity: 1 }] } }));
    });

    it('duplicate group_ref', () => {
      const base = makeBaseOrder();
      assertThrowsRuleError(() => planRefund({ ...base, groups: [base.groups[0], { ...base.groups[1], group_ref: 'g1' }], request: { kind: 'cancel', reason: 'changed_mind', lines: [{ line_ref: 'a', quantity: 1 }] } }));
    });

    it('group refunded_minor > fee_minor', () => {
      const base = makeBaseOrder();
      assertThrowsRuleError(() => planRefund({ ...base, groups: [{ ...base.groups[0], refunded_minor: 7000 }, base.groups[1]], request: { kind: 'cancel', reason: 'changed_mind', lines: [{ line_ref: 'a', quantity: 1 }] } }));
    });

    it('Σ L + Σ F above MAX_SAFE_INTEGER', () => {
      const base = makeBaseOrder();
      const largeFee = Number.MAX_SAFE_INTEGER - 100;
      assertThrowsRuleError(() =>
        planRefund({
          ...base,
          groups: [{ group_ref: 'g1', fee_minor: 1, refunded_minor: 0 }, { group_ref: 'g2', fee_minor: 1, refunded_minor: 0 }],
          settlement_unit_minor: 1,
          lines: [
            { ...base.lines[0], net_minor: largeFee },
            { ...base.lines[1], net_minor: 500 },
            { ...base.lines[2], net_minor: 500 },
          ],
          request: { kind: 'cancel', reason: 'changed_mind', lines: [{ line_ref: 'a', quantity: 1 }] },
        }),
      );
    });

    it('unknown kind and reason', () => {
      const base = makeBaseOrder();
      assertThrowsRuleError(() => planRefund({ ...base, request: { kind: 'not_a_kind' as any, reason: 'changed_mind', lines: [{ line_ref: 'a', quantity: 1 }] } }));
      assertThrowsRuleError(() => planRefund({ ...base, request: { kind: 'cancel', reason: 'not_a_reason' as any, lines: [{ line_ref: 'a', quantity: 1 }] } }));
    });

    it('request line naming an unknown line', () => {
      const base = makeBaseOrder();
      assertThrowsRuleError(() => planRefund({ ...base, request: { kind: 'cancel', reason: 'changed_mind', lines: [{ line_ref: 'unknown_line', quantity: 1 }] } }));
    });

    it('duplicate request line', () => {
      const base = makeBaseOrder();
      assertThrowsRuleError(() => planRefund({ ...base, request: { kind: 'cancel', reason: 'changed_mind', lines: [{ line_ref: 'a', quantity: 1 }, { line_ref: 'a', quantity: 1 }] } }));
    });

    it('k = 0 for cancel and for return', () => {
      const base = makeBaseOrder();
      assertThrowsRuleError(() => planRefund({ ...base, request: { kind: 'cancel', reason: 'changed_mind', lines: [{ line_ref: 'a', quantity: 0 }] } }));
      assertThrowsRuleError(() => planRefund({ ...base, request: { kind: 'return', reason: 'damaged', lines: [{ line_ref: 'a', quantity: 0 }] } }));
    });

    it('k > Q − p', () => {
      const base = makeBaseOrder();
      assertThrowsRuleError(() => planRefund({ ...base, request: { kind: 'cancel', reason: 'changed_mind', lines: [{ line_ref: 'a', quantity: 3 }] } }));
      assertThrowsRuleError(() => planRefund({ ...base, request: { kind: 'refund_only', reason: 'damaged', lines: [{ line_ref: 'a', quantity: 3 }] } }));
    });

    it('input null, an array, Object.create({})', () => {
      assertThrowsRuleError(() => planRefund(null as any));
      assertThrowsRuleError(() => planRefund([] as any));
      assertThrowsRuleError(() => planRefund(Object.create({}) as any));
    });

    it('-0 in any number field', () => {
      const base = makeBaseOrder();
      // u: -0
      assertThrowsRuleError(() => planRefund({ ...base, settlement_unit_minor: -0 as any, request: { kind: 'cancel', reason: 'changed_mind', lines: [{ line_ref: 'a', quantity: 1 }] } }));
      // quantity: -0
      assertThrowsRuleError(() => planRefund({ ...base, lines: [{ ...base.lines[0], quantity: -0 }], request: { kind: 'cancel', reason: 'changed_mind', lines: [{ line_ref: 'a', quantity: 1 }] } }));
      // net_minor: -0
      assertThrowsRuleError(() => planRefund({ ...base, lines: [{ ...base.lines[0], net_minor: -0 }], request: { kind: 'cancel', reason: 'changed_mind', lines: [{ line_ref: 'a', quantity: 1 }] } }));
      // refunded_quantity: -0
      assertThrowsRuleError(() => planRefund({ ...base, lines: [{ ...base.lines[0], refunded_quantity: -0 }], request: { kind: 'cancel', reason: 'changed_mind', lines: [{ line_ref: 'a', quantity: 1 }] } }));
      // refunded_minor: -0
      assertThrowsRuleError(() => planRefund({ ...base, lines: [{ ...base.lines[0], refunded_minor: -0 }], request: { kind: 'cancel', reason: 'changed_mind', lines: [{ line_ref: 'a', quantity: 1 }] } }));
      // covered_quantity: -0
      assertThrowsRuleError(() => planRefund({ ...base, lines: [{ ...base.lines[0], covered_quantity: -0 }], request: { kind: 'cancel', reason: 'changed_mind', lines: [{ line_ref: 'a', quantity: 1 }] } }));
      // fee_minor: -0
      assertThrowsRuleError(() => planRefund({ ...base, groups: [{ ...base.groups[0], fee_minor: -0 }, base.groups[1]], request: { kind: 'cancel', reason: 'changed_mind', lines: [{ line_ref: 'a', quantity: 1 }] } }));
      // group refunded_minor: -0
      assertThrowsRuleError(() => planRefund({ ...base, groups: [{ ...base.groups[0], refunded_minor: -0 }, base.groups[1]], request: { kind: 'cancel', reason: 'changed_mind', lines: [{ line_ref: 'a', quantity: 1 }] } }));
      // request quantity: -0
      assertThrowsRuleError(() => planRefund({ ...base, request: { kind: 'refund_only', reason: 'damaged', lines: [{ line_ref: 'a', quantity: -0 }] } }));
      // unapplied number fields: -0
      assertThrowsRuleError(() => checkUnappliedRefund({ settlement_unit_minor: -0, unapplied_minor: 100, refunded_minor: 0, amount_minor: 100 }));
      assertThrowsRuleError(() => checkUnappliedRefund({ settlement_unit_minor: 100, unapplied_minor: -0, refunded_minor: 0, amount_minor: 100 }));
      assertThrowsRuleError(() => checkUnappliedRefund({ settlement_unit_minor: 100, unapplied_minor: 100, refunded_minor: -0, amount_minor: 100 }));
      assertThrowsRuleError(() => checkUnappliedRefund({ settlement_unit_minor: 100, unapplied_minor: 100, refunded_minor: 0, amount_minor: -0 }));
      // checkRefundAllocation item quantity: -0 (reproduction)
      assertThrowsRuleError(() =>
        checkRefundAllocation({
          settlement_unit_minor: 100,
          groups: [{ group_ref: 'g2', fee_minor: 8000, refunded_minor: 0 }],
          lines: [
            {
              line_ref: 'c',
              group_ref: 'g2',
              quantity: 1,
              net_minor: 20000,
              refunded_quantity: 0,
              refunded_minor: 0,
              covered_quantity: 0,
            },
          ],
          request: {
            kind: 'refund_only',
            reason: 'not_as_described',
            lines: [{ line_ref: 'c', quantity: 0 }],
          },
          attempt: { paid_minor: 100000, refunded_minor: 0 },
          allocation: {
            items: [{ line_ref: 'c', quantity: -0, amount_minor: 20000 }],
            shipping: [{ group_ref: 'g2', amount_minor: 0 }],
          },
          adjustment_reason: null,
        }),
      );
      // checkRefundAllocation shipping amount_minor: -0
      assertThrowsRuleError(() =>
        checkRefundAllocation({
          settlement_unit_minor: 100,
          groups: [{ group_ref: 'g2', fee_minor: 8000, refunded_minor: 0 }],
          lines: [
            {
              line_ref: 'c',
              group_ref: 'g2',
              quantity: 1,
              net_minor: 20000,
              refunded_quantity: 0,
              refunded_minor: 0,
              covered_quantity: 0,
            },
          ],
          request: {
            kind: 'refund_only',
            reason: 'not_as_described',
            lines: [{ line_ref: 'c', quantity: 0 }],
          },
          attempt: { paid_minor: 100000, refunded_minor: 0 },
          allocation: {
            items: [{ line_ref: 'c', quantity: 0, amount_minor: 20000 }],
            shipping: [{ group_ref: 'g2', amount_minor: -0 }],
          },
          adjustment_reason: null,
        }),
      );
      // checkRefundAllocation attempt paid_minor: -0
      assertThrowsRuleError(() =>
        checkRefundAllocation({
          settlement_unit_minor: 100,
          groups: [{ group_ref: 'g2', fee_minor: 8000, refunded_minor: 0 }],
          lines: [
            {
              line_ref: 'c',
              group_ref: 'g2',
              quantity: 1,
              net_minor: 20000,
              refunded_quantity: 0,
              refunded_minor: 0,
              covered_quantity: 0,
            },
          ],
          request: {
            kind: 'refund_only',
            reason: 'not_as_described',
            lines: [{ line_ref: 'c', quantity: 0 }],
          },
          attempt: { paid_minor: -0, refunded_minor: 0 },
          allocation: {
            items: [{ line_ref: 'c', quantity: 0, amount_minor: 20000 }],
            shipping: [{ group_ref: 'g2', amount_minor: 0 }],
          },
          adjustment_reason: null,
        }),
      );
      // checkRefundAllocation attempt refunded_minor: -0
      assertThrowsRuleError(() =>
        checkRefundAllocation({
          settlement_unit_minor: 100,
          groups: [{ group_ref: 'g2', fee_minor: 8000, refunded_minor: 0 }],
          lines: [
            {
              line_ref: 'c',
              group_ref: 'g2',
              quantity: 1,
              net_minor: 20000,
              refunded_quantity: 0,
              refunded_minor: 0,
              covered_quantity: 0,
            },
          ],
          request: {
            kind: 'refund_only',
            reason: 'not_as_described',
            lines: [{ line_ref: 'c', quantity: 0 }],
          },
          attempt: { paid_minor: 100000, refunded_minor: -0 },
          allocation: {
            items: [{ line_ref: 'c', quantity: 0, amount_minor: 20000 }],
            shipping: [{ group_ref: 'g2', amount_minor: 0 }],
          },
          adjustment_reason: null,
        }),
      );
      // refundNetForQuantity units: -0
      assertThrowsRuleError(() =>
        refundNetForQuantity({
          settlement_unit_minor: 100,
          quantity: 3,
          net_minor: 29000,
          units: -0,
        }),
      );
      // itemRefundCap units: -0 and refunded_quantity: -0
      assertThrowsRuleError(() =>
        itemRefundCap({
          settlement_unit_minor: 100,
          quantity: 3,
          net_minor: 29000,
          refunded_quantity: 0,
          refunded_minor: 0,
          units: -0,
        }),
      );
      assertThrowsRuleError(() =>
        itemRefundCap({
          settlement_unit_minor: 100,
          quantity: 3,
          net_minor: 29000,
          refunded_quantity: -0,
          refunded_minor: 0,
          units: 1,
        }),
      );
    });
  });

  describe('7. Immutability', () => {
    it('planRefund leaves input unfrozen and returns deeply frozen result', () => {
      const base = makeBaseOrder();
      const input: RefundPlanInput = {
        ...base,
        request: {
          kind: 'cancel',
          reason: 'changed_mind',
          lines: [{ line_ref: 'a', quantity: 1 }],
        },
      };

      const plan = planRefund(input);
      assertNotFrozen(input);
      assertDeepFrozen(plan);

      assert.throws(() => {
        (plan.items as any).push({});
      });

      // Modifying input after call does not alter result
      (input.lines as any)[0].quantity = 99;
      assert.equal(plan.items[0].cap_minor, 25000);
    });

    it('checkRefundAllocation leaves input unfrozen and returns deeply frozen result', () => {
      const base = makeBaseOrder();
      const input: RefundAllocationInput = {
        ...base,
        request: {
          kind: 'return',
          reason: 'damaged',
          lines: [{ line_ref: 'a', quantity: 1 }],
        },
        attempt: { paid_minor: 100000, refunded_minor: 0 },
        allocation: {
          items: [{ line_ref: 'a', quantity: 1, amount_minor: 25000 }],
          shipping: [{ group_ref: 'g1', amount_minor: 0 }],
        },
        adjustment_reason: null,
      };

      const result = checkRefundAllocation(input);
      assertNotFrozen(input);
      assertDeepFrozen(result);

      if (result.ok) {
        assert.throws(() => {
          (result.lines as any).push({});
        });
      }

      // Modifying input after call does not alter result
      (input.allocation.items as any)[0].amount_minor = 0;
      if (result.ok) {
        assert.equal(result.total_minor, 25000);
      }
    });

    it('checkUnappliedRefund leaves input unfrozen and returns deeply frozen result', () => {
      const input = {
        settlement_unit_minor: 100,
        unapplied_minor: 10000,
        refunded_minor: 0,
        amount_minor: 10000,
      };

      const result = checkUnappliedRefund(input);
      assertNotFrozen(input);
      assertDeepFrozen(result);

      if (result.ok) {
        assert.throws(() => {
          (result.line as any).amount_minor = 999;
        });
      }

      // Modifying input after call does not alter result
      input.amount_minor = 0;
      if (result.ok) {
        assert.equal(result.line.amount_minor, 10000);
      }
    });
  });
});
