# Freedom Commerce Payments (`commerce-payments`)

This module provides the pure, I/O-free domain rule functions for Freedom Commerce payment refunds and allocation, following EC-SPEC-04 §2, §7.1, §7.2, §10 and EC-SPEC-06 §2.5.

## Scope & Status

### What exists now
- Pure rule functions and TypeScript types under `rules/` (`errors.ts`, `types.ts`, `allocation.ts`, `unapplied.ts`, `index.ts`).
- Pure refund line allocation, line refund caps, price-difference refund limits, conditional shipping refund suggestions, seller allocation validation, and unapplied attempt refund validation.
- 100% pure execution: no database access, no network calls, no system clock reads, no locale-sensitive formatters, no environment access, no console logging, no side-effects.
- All returned objects and nested arrays are deeply frozen with `Object.freeze`. Caller input objects and arrays are never mutated, aliased, or frozen.

### What does not yet exist (deferred to M2)
- Database tables and migrations (e.g. `commerce_provider_accounts`, `commerce_provider_account_services`, `commerce_provider_credentials`, `commerce_payment_attempts`, `commerce_refunds`, `commerce_refund_lines`).
- Database triggers repeating the hard constraints on `commerce_refund_lines` (unit multiples, sums equal to refund total, cumulative line amount ≤ L, cumulative line units ≤ Q, cumulative shipping ≤ F).
- HTTP routes and provider callbacks (payment initiation, provider webhook notifications, buyer redirect handlers).
- Payments-side ECPay API calls and their wiring (`QueryTradeInfo/V5`, `CreditDetail/DoAction`, `CreditDetail/QueryTrade/V2`) do not exist yet and will use the existing ECPay protocol layer from `modules/agent-commerce/providers/` (module `commerce-providers`, which provides CheckMacValue, AES, and signed-form parsing).
- Outbox workers and exception case lifecycle for payment processing.

## Public Exports

- `RefundRuleError`: Error class thrown exclusively for caller programming errors; exposes `code: 'invalid_input'` with a fixed English message and never leaks input values.
- `SETTLEMENT_UNITS`: Frozen array of supported settlement units in minor units (`[1, 100]` for USD and whole TWD).
- `REFUND_REQUEST_KINDS`: Frozen array of supported refund request kinds (`['cancel', 'return', 'refund_only']`).
- `REFUND_REASONS`: Frozen array of recognized aftersales reasons (`changed_mind`, `wrong_item`, `damaged`, `missing_parts`, `not_as_described`, `not_received`, `uncollected`, `lost`, `other`).
- `FAULT_REASONS`: Frozen array of seller- or carrier-fault reasons qualifying for shipping suggestions (`['wrong_item', 'damaged', 'missing_parts', 'not_as_described', 'not_received', 'lost']`).
- `refundNetForQuantity(input)`: Computes cumulative net price `net(j) = u × floor((L / u) × j / Q)` for `j` units using BigInt integer arithmetic.
- `itemRefundCap(input)`: Computes the maximum refundable amount for `k = units` additional units of an order line.
- `planRefund(input)`: Computes the suggested refund plan for an approved refund request, providing suggested item caps and shipping fee suggestions.
- `checkRefundAllocation(input)`: Validates seller-submitted refund allocation entries against item caps, attempt balance, and adjustment reason rules.
- `checkUnappliedRefund(input)`: Validates a refund against unapplied payment funds from an overpaid or paid-after-cancel attempt.
- Domain types: `SettlementUnit`, `RefundRequestKind`, `RefundReason`, `RefundOrderLine`, `RefundDeliveryGroup`, `RefundRequestLine`, `RefundRequest`, `RefundPlanInput`, `RefundPlanItem`, `RefundPlanShipping`, `RefundPlan`, `RefundAllocationInput`, `RefundAllocationErrorCode`, `RefundAllocationError`, `RefundLine`, `RefundAllocationResult`, `UnappliedRefundInput`, `UnappliedRefundErrorCode`, `UnappliedRefundError`, `UnappliedRefundResult`.

## Formulas and Core Rules

### Net Price and Item Cap Formulas

For an order line with net minor amount `L`, total quantity `Q`, settlement unit `u`, and previously refunded quantity `p` and amount `r`:

1. **Cumulative Net Formula**:
   `net(j) = u × floor((L / u) × j / Q)`
   Computed with `BigInt` to prevent integer overflow when `L × j` exceeds `2^53 − 1`.

2. **Item Refund Cap**:
   - For `k = 0` (price-difference refund): `cap = L − r`.
   - For `k ≥ 1` (refunding `k` units): `cap = min(net(p + k) − net(p), L − r)`.

#### The 290-元 Example
For `u = 100`, `L = 29000` (NT$290), and `Q = 3`:
- `net(0) = 0`
- `net(1) = 100 × floor(290 × 1 / 3) = 100 × 96 = 9600`
- `net(2) = 100 × floor(290 × 2 / 3) = 100 × 193 = 19300`
- `net(3) = 100 × floor(290 × 3 / 3) = 100 × 290 = 29000`

Refunding units one by one yields caps:
1. First unit (`p = 0`, `r = 0`, `k = 1`): `min(9600 − 0, 29000 − 0) = 9600` (NT$96).
2. Second unit (`p = 1`, `r = 9600`, `k = 1`): `min(19300 − 9600, 29000 − 9600) = 9700` (NT$97).
3. Third unit (`p = 2`, `r = 19300`, `k = 1`): `min(29000 − 19300, 29000 − 19300) = 9700` (NT$97).
Total refunded: `9600 + 9700 + 9700 = 29000 = L`.

If an earlier price difference of NT$50 (`r = 5000`, `p = 0`) was refunded:
1. First unit (`k = 1`): `min(9600 − 0, 29000 − 5000) = 9600`.
2. Second unit (`k = 1`): `min(19300 − 9600, 29000 − 14600) = min(9700, 14400) = 9700`.
3. Third unit (`k = 1`): `min(29000 − 19300, 29000 − 24300) = min(9700, 4700) = 4700` (capped by `L − r`).
Total refunded: `5000 + 9600 + 9700 + 4700 = 29000 = L`.

### Price-Difference Rule
Only `refund_only` requests support `k = 0` price-difference refunds. In this case, no units are marked as refunded (`p` remains unchanged), and the cap is strictly the unrefunded balance `L − r`. `cancel` and `return` requests require `1 ≤ k ≤ Q − p`.

### Shipping Suggestion Rule
Shipping entries are generated exclusively for delivery groups touched by the refund request (ordered by first touch in request line order). A request qualifies for a shipping fee refund if:
- `kind === 'cancel'` (any reason), or
- `reason` is one of `FAULT_REASONS` (`wrong_item`, `damaged`, `missing_parts`, `not_as_described`, `not_received`, `lost`).

Each line's covered units after the request is `covered_quantity + k` if the request qualifies and the line is in the request (`k = 0` adds nothing), else `covered_quantity`.
When **every** line in the delivery group has a covered unit count equal to its total quantity `Q`, the suggestion is the full remaining shipping fee (`F − s`); otherwise `0`.

### Allocation Checks and Order
When validating seller-submitted allocations in `checkRefundAllocation`, errors are collected in strict sequence (at most one error per entry):

1. **Item entries** (path `allocation.items[i].amount_minor`):
   - Amount not a multiple of `u` → `not_unit_multiple`.
   - Else amount > `cap_minor` → `above_cap`.
2. **Shipping entries** (path `allocation.shipping[i].amount_minor`):
   - Amount not a multiple of `u` → `not_unit_multiple`.
   - Else amount > `remaining_minor` → `above_cap`.
3. **Total amount** (path `allocation.total`, sum of all item and shipping amounts):
   - Total = 0 → `total_zero`.
   - Else total > `paid_minor − refunded_minor` → `above_attempt_balance`.
4. **Adjustment reason** (path `adjustment_reason`):
   - Reason trimmed with `String.prototype.trim`; empty string counts as `null`.
   - Contains U+0000 or a lone surrogate → `adjustment_reason_format`.
   - Else more than 500 code points (`[...text].length > 500`) → `adjustment_reason_too_long`.
   - Else `null` while any item amount is strictly below its cap → `adjustment_reason_required`. Lowering shipping fees requires no reason.

### Unapplied Refund Rule
`checkUnappliedRefund` validates refunds for payments not tied to order lines (e.g. overpayment or payment received after order cancellation). The refund amount is checked against the attempt's remaining unapplied balance (`unapplied_minor − refunded_minor`). Errors returned at path `amount_minor`:
- Amount not a multiple of `u` → `not_unit_multiple`.
- Else amount = 0 → `total_zero`.
- Else amount > `unapplied_minor − refunded_minor` → `above_cap`.

Unapplied refunds never alter order invoice documents.

### Database Trigger Invariant
These pure rules form the application-level validator. In M2, the PostgreSQL database trigger on `commerce_refund_lines` strictly repeats these hard invariants (multiples of `u`, sum matches refund amount, line amount ≤ `L`, line quantity ≤ `Q`, group shipping ≤ `F`, attempt balance not exceeded) under transaction row locks.
