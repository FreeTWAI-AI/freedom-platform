export const SETTLEMENT_UNITS = Object.freeze([1, 100] as const);          // u: USD = 1, TWD = 100 (whole NT$)
export const REFUND_REQUEST_KINDS = Object.freeze(['cancel', 'return', 'refund_only'] as const);
export const REFUND_REASONS = Object.freeze([
  'changed_mind',
  'wrong_item',
  'damaged',
  'missing_parts',
  'not_as_described',
  'not_received',
  'uncollected',
  'lost',
  'other',
] as const);
export const FAULT_REASONS = Object.freeze([
  'wrong_item',
  'damaged',
  'missing_parts',
  'not_as_described',
  'not_received',
  'lost',
] as const);                                           // seller or carrier fault (spec §2.5)

export type SettlementUnit = (typeof SETTLEMENT_UNITS)[number];
export type RefundRequestKind = (typeof REFUND_REQUEST_KINDS)[number];
export type RefundReason = (typeof REFUND_REASONS)[number];

export interface RefundOrderLine {
  readonly line_ref: string;           // order line id
  readonly group_ref: string;          // its delivery group
  readonly quantity: number;           // Q
  readonly net_minor: number;          // L = unit price × Q − the line's discount share
  readonly refunded_quantity: number;  // p: units in non-failed `item` refund lines so far
  readonly refunded_minor: number;     // r: amount of non-failed `item` refund lines so far (incl. price differences)
  readonly covered_quantity: number;   // units of p whose refund was a `cancel`, or had a FAULT_REASONS reason
}

export interface RefundDeliveryGroup {
  readonly group_ref: string;
  readonly fee_minor: number;          // F
  readonly refunded_minor: number;     // s: shipping already refunded for this group by non-failed refunds
}

export interface RefundRequestLine {
  readonly line_ref: string;
  readonly quantity: number;           // k (approved units)
}

export interface RefundRequest {
  readonly kind: RefundRequestKind;
  readonly reason: RefundReason;
  readonly lines: readonly RefundRequestLine[];
}

export interface RefundPlanInput {
  readonly settlement_unit_minor: number;
  readonly lines: readonly RefundOrderLine[];       // every line of the order
  readonly groups: readonly RefundDeliveryGroup[];  // every delivery group of the order
  readonly request: RefundRequest;
}

export interface RefundPlanItem {
  readonly line_ref: string;
  readonly group_ref: string;
  readonly quantity: number;          // k from the request
  readonly cap_minor: number;         // itemRefundCap(...) — also the suggested amount
}

export interface RefundPlanShipping {
  readonly group_ref: string;
  readonly remaining_minor: number;   // F − s
  readonly suggested_minor: number;   // remaining_minor or 0
}

export interface RefundPlan {
  readonly items: readonly RefundPlanItem[];          // one per request line, in request order
  readonly shipping: readonly RefundPlanShipping[];   // one per group the request touches, in order of first touch
  readonly suggested_total_minor: number;             // Σ cap_minor + Σ suggested_minor
}

export interface RefundAllocationInput extends RefundPlanInput {
  readonly attempt: { readonly paid_minor: number; readonly refunded_minor: number };  // the attempt refunded
  readonly allocation: {
    readonly items: readonly { readonly line_ref: string; readonly quantity: number; readonly amount_minor: number }[];
    readonly shipping: readonly { readonly group_ref: string; readonly amount_minor: number }[];
  };
  readonly adjustment_reason: string | null;   // buyer-visible reason for lowering a line
}

export type RefundAllocationErrorCode =
  | 'not_unit_multiple'
  | 'above_cap'
  | 'total_zero'
  | 'above_attempt_balance'
  | 'adjustment_reason_required'
  | 'adjustment_reason_too_long'
  | 'adjustment_reason_format';

export interface RefundAllocationError {
  readonly path: string;
  readonly code: RefundAllocationErrorCode;
}

export type RefundLine =
  | { readonly kind: 'item'; readonly line_ref: string; readonly quantity: number; readonly amount_minor: number }
  | { readonly kind: 'shipping'; readonly group_ref: string; readonly amount_minor: number }
  | { readonly kind: 'unapplied'; readonly amount_minor: number };

export type RefundAllocationResult =
  | {
      readonly ok: true;
      readonly total_minor: number;
      readonly adjustment_reason: string | null;
      readonly lines: readonly RefundLine[];
    }
  | {
      readonly ok: false;
      readonly errors: readonly RefundAllocationError[];
    };

export interface UnappliedRefundInput {
  readonly settlement_unit_minor: number;
  readonly unapplied_minor: number;
  readonly refunded_minor: number;
  readonly amount_minor: number;
}

export type UnappliedRefundErrorCode = 'not_unit_multiple' | 'total_zero' | 'above_cap';

export interface UnappliedRefundError {
  readonly path: string;
  readonly code: UnappliedRefundErrorCode;
}

export type UnappliedRefundResult =
  | {
      readonly ok: true;
      readonly line: { readonly kind: 'unapplied'; readonly amount_minor: number };
    }
  | {
      readonly ok: false;
      readonly errors: readonly UnappliedRefundError[];
    };
