import { InvoiceRuleError, assertMinorMoney } from './errors.js';
import { platformVoidDeadline } from './period.js';

export type CorrectionAction = 'void' | 'void_and_reissue_new' | 'allowance' | 'manual';

export interface InvoiceFacts {
  mode: 'ecpay_b2c' | 'manual_record' | 'not_issued';
  status: 'queued' | 'issuing' | 'unknown' | 'issued' | 'failed' | 'voided' | 'recorded';
  donation: boolean;
  invoiceAt: Date | null; // InvoiceDate; required when status is 'issued'
  amountMinor: number; // SalesAmount × 100
  uploaded: 'yes' | 'no' | 'unknown'; // upload to the MOF platform, from GetIssue
  allowances: Array<{
    status: 'submitting' | 'pending_buyer' | 'effective' | 'voided' | 'expired' | 'cancelled';
    amountMinor: number;
  }>;
  reissuedWithVoidWithReIssue: boolean;
  correctionInProgress: boolean;
}

export interface RefundFacts {
  kind: 'applied' | 'unapplied';
  cumulativeAppliedMinor: number;
}

export type SuggestInvoiceCorrectionResult =
  | { kind: 'none'; reason: 'unapplied_refund' | 'invoice_not_issued' | 'invoice_failed' | 'invoice_voided' }
  | { kind: 'wait'; reason: 'invoice_pending' | 'correction_in_progress' }
  | {
      kind: 'suggest';
      action: CorrectionAction;
      reason: string;
      alternatives: CorrectionAction[];
      afterUpload: boolean;
      platformVoidDeadline: Date | null;
      dueSoon: boolean;
    };

export function suggestInvoiceCorrection(
  invoice: InvoiceFacts,
  refund: RefundFacts,
  preference: 'allowance' | 'void_and_reissue_new',
  now: Date
): SuggestInvoiceCorrectionResult {
  // 1. unapplied refund
  if (refund.kind === 'unapplied') {
    return { kind: 'none', reason: 'unapplied_refund' };
  }

  // 2. invoice mode check
  if (invoice.mode === 'not_issued') {
    return { kind: 'none', reason: 'invoice_not_issued' };
  }
  if (invoice.mode === 'manual_record') {
    return {
      kind: 'suggest',
      action: 'manual',
      reason: 'manual_record',
      alternatives: ['manual'],
      afterUpload: false,
      platformVoidDeadline: null,
      dueSoon: false,
    };
  }

  // 3. invoice status check
  if (invoice.status === 'queued' || invoice.status === 'issuing' || invoice.status === 'unknown') {
    return { kind: 'wait', reason: 'invoice_pending' };
  }
  if (invoice.status === 'failed') {
    return { kind: 'none', reason: 'invoice_failed' };
  }
  if (invoice.status === 'voided') {
    return { kind: 'none', reason: 'invoice_voided' };
  }
  if (invoice.status === 'recorded') {
    return {
      kind: 'suggest',
      action: 'manual',
      reason: 'manual_record',
      alternatives: ['manual'],
      afterUpload: false,
      platformVoidDeadline: null,
      dueSoon: false,
    };
  }
  if (invoice.status !== 'issued') {
    throw new InvoiceRuleError('Unsupported invoice status');
  }

  // 4. correction in progress
  if (invoice.correctionInProgress) {
    return { kind: 'wait', reason: 'correction_in_progress' };
  }

  // 5. validation
  if (!invoice.invoiceAt || !(invoice.invoiceAt instanceof Date) || isNaN(invoice.invoiceAt.getTime())) {
    throw new InvoiceRuleError('InvoiceDate is required for issued invoice');
  }
  if (!(now instanceof Date) || isNaN(now.getTime())) {
    throw new InvoiceRuleError('Current time must be a valid Date object');
  }
  if (preference !== 'allowance' && preference !== 'void_and_reissue_new') {
    throw new InvoiceRuleError('Invalid preference');
  }

  assertMinorMoney(invoice.amountMinor);
  assertMinorMoney(refund.cumulativeAppliedMinor);

  if (!Array.isArray(invoice.allowances)) {
    throw new InvoiceRuleError('Allowances must be an array');
  }

  for (const a of invoice.allowances) {
    assertMinorMoney(a.amountMinor);
  }

  if (refund.cumulativeAppliedMinor <= 0 || refund.cumulativeAppliedMinor > invoice.amountMinor) {
    throw new InvoiceRuleError('cumulativeAppliedMinor must be between 0 and amountMinor');
  }

  const unvoided = invoice.allowances.filter(
    a => a.status === 'submitting' || a.status === 'pending_buyer' || a.status === 'effective'
  );
  const unvoidedSum = unvoided.reduce((sum, a) => sum + a.amountMinor, 0);
  if (unvoidedSum > invoice.amountMinor) {
    throw new InvoiceRuleError('Unvoided allowances sum cannot exceed invoice amount');
  }

  // 6. feasibility checks
  const pending = invoice.allowances.filter(
    a => a.status === 'submitting' || a.status === 'pending_buyer'
  );
  const effectiveSum = invoice.allowances
    .filter(a => a.status === 'effective')
    .reduce((sum, a) => sum + a.amountMinor, 0);

  const deadlineDate = platformVoidDeadline(invoice.invoiceAt);
  const voidAllowed =
    now.getTime() <= deadlineDate.getTime() &&
    unvoided.length === 0 &&
    !invoice.reissuedWithVoidWithReIssue;

  const allowancePossible =
    !invoice.donation &&
    pending.length === 0 &&
    invoice.allowances.length < 50 &&
    refund.cumulativeAppliedMinor - effectiveSum > 0;

  const isFullRefund = refund.cumulativeAppliedMinor === invoice.amountMinor;

  let action: CorrectionAction;
  let reason: string;

  if (isFullRefund) {
    // 7. Full refund
    if (voidAllowed) {
      action = 'void';
      reason = 'full_refund_within_deadline';
    } else if (allowancePossible) {
      action = 'allowance';
      reason = 'full_refund_void_expired_allowance';
    } else {
      action = 'manual';
      reason = 'no_automated_correction_available';
    }
  } else {
    // 8. Partial refund
    if (invoice.donation) {
      if (voidAllowed) {
        action = 'void_and_reissue_new';
        reason = 'donation_partial_refund_within_deadline';
      } else {
        action = 'manual';
        reason = 'donation_void_expired_manual';
      }
    } else if (preference === 'allowance') {
      if (allowancePossible) {
        action = 'allowance';
        reason = 'preference_allowance';
      } else if (voidAllowed) {
        action = 'void_and_reissue_new';
        reason = 'allowance_impossible_void_reissue';
      } else {
        action = 'manual';
        reason = 'no_automated_correction_available';
      }
    } else {
      // preference === 'void_and_reissue_new'
      if (voidAllowed) {
        action = 'void_and_reissue_new';
        reason = 'preference_void_reissue_within_deadline';
      } else if (allowancePossible) {
        action = 'allowance';
        reason = 'void_expired_allowance';
      } else {
        action = 'manual';
        reason = 'no_automated_correction_available';
      }
    }
  }

  // 9. Alternatives and flags
  // Feasible actions in order: void, void_and_reissue_new, allowance, manual
  const feasible: CorrectionAction[] = [];
  if (isFullRefund && voidAllowed) {
    feasible.push('void');
  }
  if (!isFullRefund && voidAllowed) {
    feasible.push('void_and_reissue_new');
  }
  if (allowancePossible) {
    feasible.push('allowance');
  }
  feasible.push('manual');

  const alternatives = feasible.filter(act => act !== action);

  const afterUpload = action === 'allowance' && invoice.uploaded !== 'yes';
  const dueSoon =
    (action === 'void' || action === 'void_and_reissue_new') &&
    now.getTime() >= deadlineDate.getTime() - 24 * 3600 * 1000;

  return {
    kind: 'suggest',
    action,
    reason,
    alternatives,
    afterUpload,
    platformVoidDeadline: deadlineDate,
    dueSoon,
  };
}

// ECPay B2C VoidWithReIssue 48-hour limit [support 6906] less 2-hour platform buffer
export const VOID_WITH_REISSUE_WINDOW_MS = 46 * 60 * 60 * 1000;

/**
 * Checks whether an invoice can be corrected via VoidWithReIssue (註銷重開)
 * for incorrect buyer data with an unchanged amount.
 */
export function canVoidWithReissue(invoice: InvoiceFacts, now: Date): boolean {
  if (invoice.mode !== 'ecpay_b2c' || invoice.status !== 'issued') {
    return false;
  }
  if (!invoice.invoiceAt || !(invoice.invoiceAt instanceof Date) || isNaN(invoice.invoiceAt.getTime())) {
    throw new InvoiceRuleError('InvoiceDate is required for issued invoice');
  }
  if (!(now instanceof Date) || isNaN(now.getTime())) {
    throw new InvoiceRuleError('Current time must be a valid Date object');
  }

  if (invoice.uploaded !== 'yes') {
    return false;
  }
  if (now.getTime() > invoice.invoiceAt.getTime() + VOID_WITH_REISSUE_WINDOW_MS) {
    return false;
  }

  const deadline = platformVoidDeadline(invoice.invoiceAt);
  if (now.getTime() > deadline.getTime()) {
    return false;
  }
  if (invoice.reissuedWithVoidWithReIssue) {
    return false;
  }
  if (!Array.isArray(invoice.allowances)) {
    throw new InvoiceRuleError('Allowances must be an array');
  }

  const hasUnvoided = invoice.allowances.some(
    a => a.status === 'submitting' || a.status === 'pending_buyer' || a.status === 'effective'
  );
  if (hasUnvoided) {
    return false;
  }

  return true;
}
