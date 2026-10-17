import { bodySha256Hex } from '../body-digest.js';
import type { VerifySignedFormFailureReason } from '../checkmac.js';
import type { ParseFormOptions } from '../form.js';
import { invoice } from '../invoice.js';
import { unwrapKeyList, type EcpayKeyPair } from '../keys.js';
import {
  ALLOWANCE_NO_PATTERN,
  INVOICE_NO_PATTERN,
  parseInvoiceDateTime,
} from './fields.js';
import { parseTwdAmountMinor } from './result.js';

export interface AllowanceConsentDedupeKey {
  readonly allowanceNo: string;
  readonly rtnCode: '1';
}

export interface AllowanceConsent {
  readonly kind: 'consent';
  readonly keyIndex: number;
  readonly allowanceNo: string;
  readonly invoiceNo: string;
  readonly allowanceDateTime: string | null;
  readonly allowanceAtEpochMs: number | null;
  readonly remainingAllowanceMinor: number | null;
  readonly dedupe: AllowanceConsentDedupeKey;
  readonly bodySha256: string;
}

export type AllowanceConsentInvalidReason =
  | VerifySignedFormFailureReason
  | 'missing_field'
  | 'invalid_field'
  | 'unexpected_rtn_code';

export type ParseAllowanceConsentResult =
  | AllowanceConsent
  | {
      readonly kind: 'invalid';
      readonly reason: AllowanceConsentInvalidReason;
      readonly field?: string;
    };

export function parseAllowanceConsentCallback(
  body: string | Uint8Array,
  keys: EcpayKeyPair | readonly EcpayKeyPair[],
  options?: ParseFormOptions,
): ParseAllowanceConsentResult {
  unwrapKeyList(keys);

  const verified = invoice.verifyAllowanceCallback(body, keys, options);
  if (!verified.ok) {
    return Object.freeze({
      kind: 'invalid' as const,
      reason: verified.reason,
    });
  }

  const { fields, keyIndex } = verified;

  const rawRtnCode = fields.RtnCode;
  if (rawRtnCode === undefined || rawRtnCode === '') {
    return Object.freeze({
      kind: 'invalid' as const,
      reason: 'missing_field' as const,
      field: 'RtnCode',
    });
  }
  if (rawRtnCode !== '1') {
    return Object.freeze({
      kind: 'invalid' as const,
      reason: 'unexpected_rtn_code' as const,
      field: 'RtnCode',
    });
  }

  const rawAllowanceNo = fields.IA_Allow_No;
  if (rawAllowanceNo === undefined || rawAllowanceNo === '') {
    return Object.freeze({
      kind: 'invalid' as const,
      reason: 'missing_field' as const,
      field: 'IA_Allow_No',
    });
  }
  if (!ALLOWANCE_NO_PATTERN.test(rawAllowanceNo)) {
    return Object.freeze({
      kind: 'invalid' as const,
      reason: 'invalid_field' as const,
      field: 'IA_Allow_No',
    });
  }

  const rawInvoiceNo = fields.IA_Invoice_No;
  if (rawInvoiceNo === undefined || rawInvoiceNo === '') {
    return Object.freeze({
      kind: 'invalid' as const,
      reason: 'missing_field' as const,
      field: 'IA_Invoice_No',
    });
  }
  if (!INVOICE_NO_PATTERN.test(rawInvoiceNo)) {
    return Object.freeze({
      kind: 'invalid' as const,
      reason: 'invalid_field' as const,
      field: 'IA_Invoice_No',
    });
  }

  const parsedDate =
    fields.IA_Date !== undefined ? parseInvoiceDateTime(fields.IA_Date) : null;
  const remainingAllowanceMinor =
    fields.IIS_Remain_Allowance_Amt !== undefined &&
    fields.IIS_Remain_Allowance_Amt !== ''
      ? parseTwdAmountMinor(fields.IIS_Remain_Allowance_Amt)
      : null;

  const bodySha256 = bodySha256Hex(body);
  const dedupe: AllowanceConsentDedupeKey = Object.freeze({
    allowanceNo: rawAllowanceNo,
    rtnCode: '1' as const,
  });

  return Object.freeze({
    kind: 'consent' as const,
    keyIndex,
    allowanceNo: rawAllowanceNo,
    invoiceNo: rawInvoiceNo,
    allowanceDateTime: parsedDate === null ? null : parsedDate.text,
    allowanceAtEpochMs: parsedDate === null ? null : parsedDate.epochMs,
    remainingAllowanceMinor,
    dedupe,
    bodySha256,
  });
}
