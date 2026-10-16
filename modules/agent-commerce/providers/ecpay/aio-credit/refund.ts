import { aio } from '../aio.js';
import { assertFieldsCdnSafe } from '../cdn-guard.js';
import { sanitizeMessage } from '../encoding.js';
import { EcpayProtocolError } from '../errors.js';
import {
  MINOR_PER_TWD,
  assertMerchantId,
  assertNonNegativeSafeInteger,
  isPlainObject,
} from '../field-rules.js';
import { parseForm, type FormFields } from '../form.js';
import { ECPAY_ORIGINS, type EcpayEnvironment } from '../index.js';
import { unwrapKeyPair, type EcpayKeyPair } from '../keys.js';
import { createServerRequest, type EcpayServerRequest } from '../server-request.js';
import { isTradeNumber } from '../trade-number.js';
import type { CreditSettlementStatus } from './credit-detail.js';
import { assertCreditAmountMinor } from './profile.js';

const ALPHANUMERIC_ID_PATTERN = /^[0-9A-Za-z]{1,20}$/;
const RTN_CODE_PATTERN = /^-?[0-9]{1,10}$/;
const ASCII_WHITESPACE_TRIM = /^[ \t\r\n\f\v]+|[ \t\r\n\f\v]+$/g;

const VALID_SETTLEMENT_STATUSES = new Set<CreditSettlementStatus>([
  'unauthorized',
  'authorized',
  'capture_pending',
  'captured',
  'capture_cancelled',
  'voided',
]);

const VALID_DO_ACTIONS = new Set<CreditDoActionKind>(['C', 'R', 'E', 'N']);

export type CreditDoActionKind = 'C' | 'R' | 'E' | 'N';

export interface CreditRefundStep {
  readonly action: CreditDoActionKind;
  readonly amountMinor: number;
}

export type CreditNotRefundableReason =
  | 'not_authorised'
  | 'already_voided'
  | 'state_inconsistent'
  | 'exceeds_paid';

export interface CreditRefundPlanInput {
  readonly status: CreditSettlementStatus;
  readonly paidMinor: number;
  readonly refundedMinor: number;
  readonly requestedMinor: number;
}

export type CreditRefundPlanResult =
  | {
      readonly kind: 'plan';
      readonly steps: readonly CreditRefundStep[];
    }
  | {
      readonly kind: 'not_refundable';
      readonly reason: CreditNotRefundableReason;
    };

export interface DoActionRequestInput {
  readonly environment: EcpayEnvironment;
  readonly merchantId: string;
  readonly merchantTradeNo: string;
  readonly tradeNo: string;
  readonly action: CreditDoActionKind;
  readonly amountMinor: number;
}

export interface ParseDoActionResponseOptions {
  readonly merchantId: string;
  readonly merchantTradeNo: string;
  readonly tradeNo: string;
}

export type DoActionUnknownReason =
  | 'unparseable'
  | 'missing_field'
  | 'invalid_field'
  | 'echo_mismatch';

export type DoActionResponseResult =
  | { readonly kind: 'succeeded' }
  | {
      readonly kind: 'rejected';
      readonly rtnCode: string;
      readonly rtnMsg: string;
    }
  | {
      readonly kind: 'unknown';
      readonly reason: DoActionUnknownReason;
    };

export function planCreditRefund(input: CreditRefundPlanInput): CreditRefundPlanResult {
  if (!isPlainObject(input)) {
    throw new EcpayProtocolError('invalid_input');
  }
  if (
    typeof input.status !== 'string' ||
    !VALID_SETTLEMENT_STATUSES.has(input.status as CreditSettlementStatus)
  ) {
    throw new EcpayProtocolError('invalid_input');
  }

  assertCreditAmountMinor(input.paidMinor);
  assertNonNegativeSafeInteger(input.refundedMinor);
  if (input.refundedMinor % MINOR_PER_TWD !== 0) {
    throw new EcpayProtocolError('invalid_input');
  }
  assertCreditAmountMinor(input.requestedMinor);

  if (input.status === 'unauthorized') {
    return Object.freeze({
      kind: 'not_refundable' as const,
      reason: 'not_authorised' as const,
    });
  }

  if (input.status === 'voided') {
    return Object.freeze({
      kind: 'not_refundable' as const,
      reason: 'already_voided' as const,
    });
  }

  if (input.refundedMinor + input.requestedMinor > input.paidMinor) {
    return Object.freeze({
      kind: 'not_refundable' as const,
      reason: 'exceeds_paid' as const,
    });
  }

  const full = input.refundedMinor === 0 && input.requestedMinor === input.paidMinor;

  if (input.status === 'authorized' || input.status === 'capture_cancelled') {
    if (full) {
      return Object.freeze({
        kind: 'plan' as const,
        steps: Object.freeze([
          Object.freeze({ action: 'N' as const, amountMinor: input.paidMinor }),
        ]),
      });
    }
    if (input.refundedMinor === 0) {
      return Object.freeze({
        kind: 'plan' as const,
        steps: Object.freeze([
          Object.freeze({ action: 'C' as const, amountMinor: input.paidMinor }),
          Object.freeze({ action: 'R' as const, amountMinor: input.requestedMinor }),
        ]),
      });
    }
    return Object.freeze({
      kind: 'not_refundable' as const,
      reason: 'state_inconsistent' as const,
    });
  }

  if (input.status === 'capture_pending') {
    if (full) {
      return Object.freeze({
        kind: 'plan' as const,
        steps: Object.freeze([
          Object.freeze({ action: 'E' as const, amountMinor: input.paidMinor }),
          Object.freeze({ action: 'N' as const, amountMinor: input.paidMinor }),
        ]),
      });
    }
    return Object.freeze({
      kind: 'plan' as const,
      steps: Object.freeze([
        Object.freeze({ action: 'R' as const, amountMinor: input.requestedMinor }),
      ]),
    });
  }

  // status === 'captured'
  return Object.freeze({
    kind: 'plan' as const,
    steps: Object.freeze([
      Object.freeze({ action: 'R' as const, amountMinor: input.requestedMinor }),
    ]),
  });
}

export function buildDoActionRequest(
  input: DoActionRequestInput,
  keys: EcpayKeyPair,
): EcpayServerRequest {
  unwrapKeyPair(keys);
  if (!isPlainObject(input)) {
    throw new EcpayProtocolError('invalid_input');
  }
  if (input.environment !== 'live') {
    throw new EcpayProtocolError('unsupported_environment');
  }
  assertMerchantId(input.merchantId);

  if (
    typeof input.merchantTradeNo !== 'string' ||
    !isTradeNumber(input.merchantTradeNo, 'F')
  ) {
    throw new EcpayProtocolError('invalid_input');
  }

  if (
    typeof input.tradeNo !== 'string' ||
    !ALPHANUMERIC_ID_PATTERN.test(input.tradeNo)
  ) {
    throw new EcpayProtocolError('invalid_input');
  }

  if (
    typeof input.action !== 'string' ||
    !VALID_DO_ACTIONS.has(input.action as CreditDoActionKind)
  ) {
    throw new EcpayProtocolError('invalid_input');
  }

  assertCreditAmountMinor(input.amountMinor);

  const unsignedFields: FormFields = [
    ['MerchantID', input.merchantId],
    ['MerchantTradeNo', input.merchantTradeNo],
    ['TradeNo', input.tradeNo],
    ['Action', input.action],
    ['TotalAmount', String(input.amountMinor / MINOR_PER_TWD)],
  ];
  assertFieldsCdnSafe(unsignedFields);

  const signedFields = aio.sign(unsignedFields, keys);

  const url = `${ECPAY_ORIGINS.payment.live}/CreditDetail/DoAction`;
  return createServerRequest(url, signedFields);
}

export function parseDoActionResponse(
  text: string,
  options: ParseDoActionResponseOptions,
): DoActionResponseResult {
  if (!isPlainObject(options)) {
    throw new EcpayProtocolError('invalid_input');
  }
  assertMerchantId(options.merchantId);
  if (
    typeof options.merchantTradeNo !== 'string' ||
    !ALPHANUMERIC_ID_PATTERN.test(options.merchantTradeNo)
  ) {
    throw new EcpayProtocolError('invalid_input');
  }
  if (
    typeof options.tradeNo !== 'string' ||
    !ALPHANUMERIC_ID_PATTERN.test(options.tradeNo)
  ) {
    throw new EcpayProtocolError('invalid_input');
  }

  if (typeof text !== 'string') {
    return Object.freeze({
      kind: 'unknown' as const,
      reason: 'unparseable' as const,
    });
  }

  const trimmed = text.replace(ASCII_WHITESPACE_TRIM, '');
  let parsedFields: FormFields;
  try {
    parsedFields = parseForm(trimmed);
  } catch {
    return Object.freeze({
      kind: 'unknown' as const,
      reason: 'unparseable' as const,
    });
  }

  const fields: Record<string, string> = Object.create(null);
  for (const [key, value] of parsedFields) {
    fields[key] = value;
  }

  const rawMerchantId = fields.MerchantID;
  const rawMerchantTradeNo = fields.MerchantTradeNo;
  const rawTradeNo = fields.TradeNo;
  const rawRtnCode = fields.RtnCode;

  if (
    rawMerchantId === undefined ||
    rawMerchantId === '' ||
    rawMerchantTradeNo === undefined ||
    rawMerchantTradeNo === '' ||
    rawTradeNo === undefined ||
    rawTradeNo === '' ||
    rawRtnCode === undefined ||
    rawRtnCode === ''
  ) {
    return Object.freeze({
      kind: 'unknown' as const,
      reason: 'missing_field' as const,
    });
  }

  if (
    rawMerchantId.toUpperCase() !== options.merchantId.toUpperCase() ||
    rawMerchantTradeNo.toUpperCase() !== options.merchantTradeNo.toUpperCase() ||
    rawTradeNo.toUpperCase() !== options.tradeNo.toUpperCase()
  ) {
    return Object.freeze({
      kind: 'unknown' as const,
      reason: 'echo_mismatch' as const,
    });
  }

  if (!RTN_CODE_PATTERN.test(rawRtnCode)) {
    return Object.freeze({
      kind: 'unknown' as const,
      reason: 'invalid_field' as const,
    });
  }

  if (rawRtnCode === '1') {
    return Object.freeze({ kind: 'succeeded' as const });
  }

  return Object.freeze({
    kind: 'rejected' as const,
    rtnCode: rawRtnCode,
    rtnMsg: sanitizeMessage(fields.RtnMsg ?? ''),
  });
}
