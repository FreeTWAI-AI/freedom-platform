import { aio } from '../aio.js';
import { bodySha256Hex } from '../body-digest.js';
import type { VerifySignedFormFailureReason } from '../checkmac.js';
import { sanitizeMessage } from '../encoding.js';
import { EcpayProtocolError } from '../errors.js';
import {
  MINOR_PER_TWD,
  assertMerchantId,
  isPlainObject,
  parseOptionalFeeMinor,
  parseOptionalSanitized,
} from '../field-rules.js';
import { unwrapKeyList, type EcpayKeyPair } from '../keys.js';
import { parseTaipeiDateTime } from '../taipei-time.js';

const ALPHANUMERIC_ID_PATTERN = /^[0-9A-Za-z]{1,20}$/;
const RTN_CODE_PATTERN = /^-?[0-9]{1,10}$/;
const TRADE_AMT_PATTERN = /^[0-9]{1,9}$/;
const GWSR_PATTERN = /^[0-9]{1,20}$/;
const MAX_PAYMENT_TYPE_CODE_POINTS = 50;

export type PaymentNotificationOutcome =
  | 'paid'
  | 'simulated'
  | 'pending_confirmation'
  | 'failed';

export interface PaymentNotificationDedupeKey {
  readonly merchantTradeNo: string;
  readonly tradeNo: string;
  readonly rtnCode: string;
  readonly simulatePaid: '0' | '1';
  readonly paymentDate: string;
}

export interface PaymentNotification {
  readonly kind: 'notification';
  readonly outcome: PaymentNotificationOutcome;
  readonly keyIndex: number;
  readonly merchantTradeNo: string;
  readonly tradeNo: string | null;
  readonly rtnCode: string;
  readonly rtnMsg: string;
  readonly tradeAmtMinor: number;
  readonly paymentDate: string | null;
  readonly paymentDateEpochMs: number | null;
  readonly tradeDate: string | null;
  readonly paymentType: string | null;
  readonly chargeFeeMinor: number | null;
  readonly gwsr: string | null;
  readonly dedupe: PaymentNotificationDedupeKey;
  readonly bodySha256: string;
}

export type PaymentNotificationInvalidReason =
  | VerifySignedFormFailureReason
  | 'merchant_mismatch'
  | 'platform_mismatch'
  | 'missing_field'
  | 'invalid_field';

export interface ParsePaymentNotificationOptions {
  readonly merchantId: string;
}

export type ParsePaymentNotificationResult =
  | PaymentNotification
  | {
      readonly kind: 'invalid';
      readonly reason: PaymentNotificationInvalidReason;
      readonly field?: string;
    };

export type ParsePaymentBrowserReturnResult =
  | {
      readonly kind: 'return';
      readonly merchantTradeNo: string;
      readonly keyIndex: number;
    }
  | {
      readonly kind: 'invalid';
      readonly reason: PaymentNotificationInvalidReason;
      readonly field?: string;
    };

function assertNotificationOptions(
  options: unknown,
): asserts options is ParsePaymentNotificationOptions {
  if (!isPlainObject(options)) {
    throw new EcpayProtocolError('invalid_input');
  }
  assertMerchantId(options.merchantId);
}

export function parsePaymentNotification(
  body: string | Uint8Array,
  keys: EcpayKeyPair | readonly EcpayKeyPair[],
  options: ParsePaymentNotificationOptions,
): ParsePaymentNotificationResult {
  unwrapKeyList(keys);
  assertNotificationOptions(options);

  const verified = aio.verify(body, keys);
  if (!verified.ok) {
    return Object.freeze({
      kind: 'invalid' as const,
      reason: verified.reason,
    });
  }

  const { fields, keyIndex } = verified;

  if (fields.MerchantID !== options.merchantId) {
    return Object.freeze({
      kind: 'invalid' as const,
      reason: 'merchant_mismatch' as const,
    });
  }

  if (fields.PlatformID !== undefined && fields.PlatformID !== '') {
    return Object.freeze({
      kind: 'invalid' as const,
      reason: 'platform_mismatch' as const,
    });
  }

  const rawMerchantTradeNo = fields.MerchantTradeNo;
  if (rawMerchantTradeNo === undefined || rawMerchantTradeNo === '') {
    return Object.freeze({
      kind: 'invalid' as const,
      reason: 'missing_field' as const,
      field: 'MerchantTradeNo',
    });
  }
  if (!ALPHANUMERIC_ID_PATTERN.test(rawMerchantTradeNo)) {
    return Object.freeze({
      kind: 'invalid' as const,
      reason: 'invalid_field' as const,
      field: 'MerchantTradeNo',
    });
  }

  const rawRtnCode = fields.RtnCode;
  if (rawRtnCode === undefined || rawRtnCode === '') {
    return Object.freeze({
      kind: 'invalid' as const,
      reason: 'missing_field' as const,
      field: 'RtnCode',
    });
  }
  if (!RTN_CODE_PATTERN.test(rawRtnCode)) {
    return Object.freeze({
      kind: 'invalid' as const,
      reason: 'invalid_field' as const,
      field: 'RtnCode',
    });
  }

  const rawSimulatePaid = fields.SimulatePaid;
  if (rawSimulatePaid === undefined || rawSimulatePaid === '') {
    return Object.freeze({
      kind: 'invalid' as const,
      reason: 'missing_field' as const,
      field: 'SimulatePaid',
    });
  }
  if (rawSimulatePaid !== '0' && rawSimulatePaid !== '1') {
    return Object.freeze({
      kind: 'invalid' as const,
      reason: 'invalid_field' as const,
      field: 'SimulatePaid',
    });
  }

  const rawTradeAmt = fields.TradeAmt;
  if (rawTradeAmt === undefined || rawTradeAmt === '') {
    return Object.freeze({
      kind: 'invalid' as const,
      reason: 'missing_field' as const,
      field: 'TradeAmt',
    });
  }
  if (!TRADE_AMT_PATTERN.test(rawTradeAmt)) {
    return Object.freeze({
      kind: 'invalid' as const,
      reason: 'invalid_field' as const,
      field: 'TradeAmt',
    });
  }

  const rawTradeNo = fields.TradeNo ?? '';
  if (rawTradeNo !== '' && !ALPHANUMERIC_ID_PATTERN.test(rawTradeNo)) {
    return Object.freeze({
      kind: 'invalid' as const,
      reason: 'invalid_field' as const,
      field: 'TradeNo',
    });
  }

  const rawPaymentDate = fields.PaymentDate ?? '';
  let paymentDateEpochMs: number | null = null;
  if (rawPaymentDate !== '') {
    paymentDateEpochMs = parseTaipeiDateTime(rawPaymentDate);
    if (paymentDateEpochMs === null) {
      return Object.freeze({
        kind: 'invalid' as const,
        reason: 'invalid_field' as const,
        field: 'PaymentDate',
      });
    }
  }

  const rawTradeDate = fields.TradeDate ?? '';
  if (rawTradeDate !== '') {
    if (parseTaipeiDateTime(rawTradeDate) === null) {
      return Object.freeze({
        kind: 'invalid' as const,
        reason: 'invalid_field' as const,
        field: 'TradeDate',
      });
    }
  }

  const rawGwsr = fields.gwsr ?? '';
  if (rawGwsr !== '' && !GWSR_PATTERN.test(rawGwsr)) {
    return Object.freeze({
      kind: 'invalid' as const,
      reason: 'invalid_field' as const,
      field: 'gwsr',
    });
  }

  let outcome: PaymentNotificationOutcome;
  if (rawSimulatePaid === '1') {
    outcome = 'simulated';
  } else if (rawRtnCode === '1') {
    if (rawTradeNo === '') {
      return Object.freeze({
        kind: 'invalid' as const,
        reason: 'missing_field' as const,
        field: 'TradeNo',
      });
    }
    if (rawPaymentDate === '') {
      return Object.freeze({
        kind: 'invalid' as const,
        reason: 'missing_field' as const,
        field: 'PaymentDate',
      });
    }
    outcome = 'paid';
  } else if (rawRtnCode === '10300066') {
    outcome = 'pending_confirmation';
  } else {
    outcome = 'failed';
  }

  const merchantTradeNo = rawMerchantTradeNo.toUpperCase();
  const tradeNo = rawTradeNo !== '' ? rawTradeNo.toUpperCase() : null;
  const paymentDate = rawPaymentDate !== '' ? rawPaymentDate : null;
  const tradeDate = rawTradeDate !== '' ? rawTradeDate : null;
  const gwsr = rawGwsr !== '' ? rawGwsr : null;
  const rtnMsg = sanitizeMessage(fields.RtnMsg ?? '');
  const paymentType = parseOptionalSanitized(fields.PaymentType, MAX_PAYMENT_TYPE_CODE_POINTS);
  const tradeAmtMinor = Number(rawTradeAmt) * MINOR_PER_TWD;
  const chargeFeeMinor = parseOptionalFeeMinor(fields.PaymentTypeChargeFee);

  const dedupe: PaymentNotificationDedupeKey = Object.freeze({
    merchantTradeNo,
    tradeNo: tradeNo ?? '',
    rtnCode: rawRtnCode,
    simulatePaid: rawSimulatePaid,
    paymentDate: paymentDate ?? '',
  });

  const bodySha256 = bodySha256Hex(body);

  return Object.freeze({
    kind: 'notification' as const,
    outcome,
    keyIndex,
    merchantTradeNo,
    tradeNo,
    rtnCode: rawRtnCode,
    rtnMsg,
    tradeAmtMinor,
    paymentDate,
    paymentDateEpochMs,
    tradeDate,
    paymentType,
    chargeFeeMinor,
    gwsr,
    dedupe,
    bodySha256,
  });
}

export function parsePaymentBrowserReturn(
  body: string | Uint8Array,
  keys: EcpayKeyPair | readonly EcpayKeyPair[],
  options: ParsePaymentNotificationOptions,
): ParsePaymentBrowserReturnResult {
  unwrapKeyList(keys);
  assertNotificationOptions(options);

  const verified = aio.verify(body, keys);
  if (!verified.ok) {
    return Object.freeze({
      kind: 'invalid' as const,
      reason: verified.reason,
    });
  }

  const { fields, keyIndex } = verified;

  if (fields.MerchantID !== options.merchantId) {
    return Object.freeze({
      kind: 'invalid' as const,
      reason: 'merchant_mismatch' as const,
    });
  }

  if (fields.PlatformID !== undefined && fields.PlatformID !== '') {
    return Object.freeze({
      kind: 'invalid' as const,
      reason: 'platform_mismatch' as const,
    });
  }

  const rawMerchantTradeNo = fields.MerchantTradeNo;
  if (rawMerchantTradeNo === undefined || rawMerchantTradeNo === '') {
    return Object.freeze({
      kind: 'invalid' as const,
      reason: 'missing_field' as const,
      field: 'MerchantTradeNo',
    });
  }
  if (!ALPHANUMERIC_ID_PATTERN.test(rawMerchantTradeNo)) {
    return Object.freeze({
      kind: 'invalid' as const,
      reason: 'invalid_field' as const,
      field: 'MerchantTradeNo',
    });
  }

  return Object.freeze({
    kind: 'return' as const,
    merchantTradeNo: rawMerchantTradeNo.toUpperCase(),
    keyIndex,
  });
}
