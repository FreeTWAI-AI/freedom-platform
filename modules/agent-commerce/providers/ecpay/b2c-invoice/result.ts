import { EcpayProtocolError } from '../errors.js';
import {
  MINOR_PER_TWD,
  assertMerchantId,
  isPlainObject,
} from '../field-rules.js';
import { invoice, type InvoiceOpenInvalidReason } from '../invoice.js';
import { unwrapKeyPair, type EcpayKeyPair } from '../keys.js';
import {
  parseInvoiceDateTime,
  type ParsedInvoiceDateTime,
} from './fields.js';

const AMOUNT_DIGITS_PATTERN = /^[0-9]{1,12}$/;

export interface ParseInvoiceResponseOptions {
  readonly merchantId: string;
}

export type InvoiceUnknownReason =
  | InvoiceOpenInvalidReason
  | 'missing_field'
  | 'invalid_field'
  | 'invoice_no_mismatch'
  | 'relate_number_mismatch'
  | 'allowance_no_mismatch';

export type InvoiceCallResult<T> =
  | { readonly kind: 'ok'; readonly value: T }
  | {
      readonly kind: 'rejected';
      readonly rtnCode: string;
      readonly rtnMsg: string;
    }
  | {
      readonly kind: 'not_accepted';
      readonly transCode: string;
      readonly transMsg: string;
    }
  | {
      readonly kind: 'unknown';
      readonly reason: InvoiceUnknownReason;
      readonly field?: string;
    };

export type FieldReadResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly error: {
        readonly kind: 'unknown';
        readonly reason: InvoiceUnknownReason;
        readonly field: string;
      };
    };

export function assertBaseParseOptions(
  options: unknown,
  keys: EcpayKeyPair,
): asserts options is Record<string, unknown> & ParseInvoiceResponseOptions {
  unwrapKeyPair(keys);
  if (!isPlainObject(options)) {
    throw new EcpayProtocolError('invalid_input');
  }
  assertMerchantId(options.merchantId);
}

export function unknownFieldResult(
  reason: InvoiceUnknownReason,
  field: string,
): {
  readonly kind: 'unknown';
  readonly reason: InvoiceUnknownReason;
  readonly field: string;
} {
  return Object.freeze({
    kind: 'unknown' as const,
    reason,
    field,
  });
}

export function mapOpenedInvoiceResponse<T>(
  body: string,
  keys: EcpayKeyPair,
  merchantId: string,
  extract: (data: Readonly<Record<string, unknown>>) => InvoiceCallResult<T>,
): InvoiceCallResult<T> {
  const opened = invoice.openResponse(body, keys, { merchantId });
  switch (opened.kind) {
    case 'invalid':
      return Object.freeze({
        kind: 'unknown' as const,
        reason: opened.reason,
      });
    case 'transport_error':
      return Object.freeze({
        kind: 'not_accepted' as const,
        transCode: opened.transCode,
        transMsg: opened.transMsg,
      });
    case 'rejected':
      return Object.freeze({
        kind: 'rejected' as const,
        rtnCode: opened.rtnCode,
        rtnMsg: opened.rtnMsg,
      });
    case 'ok':
      return extract(opened.data);
  }
}

export function readRequiredPatternString(
  record: Readonly<Record<string, unknown>>,
  key: string,
  pattern: RegExp,
  fieldName = key,
): FieldReadResult<string> {
  const raw = record[key];
  if (raw === undefined || raw === null || raw === '') {
    return { ok: false, error: unknownFieldResult('missing_field', fieldName) };
  }
  if (typeof raw !== 'string' || !pattern.test(raw)) {
    return { ok: false, error: unknownFieldResult('invalid_field', fieldName) };
  }
  return { ok: true, value: raw };
}

export function readRequiredDateTime(
  record: Readonly<Record<string, unknown>>,
  key: string,
  fieldName = key,
): FieldReadResult<ParsedInvoiceDateTime> {
  const raw = record[key];
  if (raw === undefined || raw === null || raw === '') {
    return { ok: false, error: unknownFieldResult('missing_field', fieldName) };
  }
  const parsed = parseInvoiceDateTime(raw);
  if (parsed === null) {
    return { ok: false, error: unknownFieldResult('invalid_field', fieldName) };
  }
  return { ok: true, value: parsed };
}

export function readOptionalUploadDateTime(
  record: Readonly<Record<string, unknown>>,
  key: string,
  fieldName = key,
): FieldReadResult<ParsedInvoiceDateTime | null> {
  const raw = record[key];
  if (raw === undefined || raw === null) {
    return { ok: false, error: unknownFieldResult('missing_field', fieldName) };
  }
  if (raw === '') {
    return { ok: true, value: null };
  }
  const parsed = parseInvoiceDateTime(raw);
  if (parsed === null) {
    return { ok: false, error: unknownFieldResult('invalid_field', fieldName) };
  }
  return { ok: true, value: parsed };
}

export function parseTwdAmountMinor(raw: unknown): number | null {
  if (typeof raw === 'number') {
    if (
      !Number.isSafeInteger(raw) ||
      raw < 0 ||
      !Number.isSafeInteger(raw * MINOR_PER_TWD)
    ) {
      return null;
    }
    return raw * MINOR_PER_TWD;
  }
  if (typeof raw === 'string' && AMOUNT_DIGITS_PATTERN.test(raw)) {
    const parsed = Number(raw);
    if (
      !Number.isSafeInteger(parsed) ||
      !Number.isSafeInteger(parsed * MINOR_PER_TWD)
    ) {
      return null;
    }
    return parsed * MINOR_PER_TWD;
  }
  return null;
}

export function readRequiredAmountMinor(
  record: Readonly<Record<string, unknown>>,
  key: string,
  fieldName = key,
): FieldReadResult<number> {
  const raw = record[key];
  if (raw === undefined || raw === null || raw === '') {
    return { ok: false, error: unknownFieldResult('missing_field', fieldName) };
  }
  const minor = parseTwdAmountMinor(raw);
  if (minor === null) {
    return { ok: false, error: unknownFieldResult('invalid_field', fieldName) };
  }
  return { ok: true, value: minor };
}

export function readStatusFlagBoolean(
  record: Readonly<Record<string, unknown>>,
  key: string,
  fieldName = key,
): FieldReadResult<boolean> {
  const raw = record[key];
  if (raw === undefined || raw === null || raw === '') {
    return { ok: false, error: unknownFieldResult('missing_field', fieldName) };
  }
  if (raw === '1') {
    return { ok: true, value: true };
  }
  if (raw === '0') {
    return { ok: true, value: false };
  }
  return { ok: false, error: unknownFieldResult('invalid_field', fieldName) };
}
