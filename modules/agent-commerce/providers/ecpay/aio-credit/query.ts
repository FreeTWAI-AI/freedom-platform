import { aio } from '../aio.js';
import { assertFieldsCdnSafe } from '../cdn-guard.js';
import type { VerifySignedFormFailureReason } from '../checkmac.js';
import { EcpayProtocolError } from '../errors.js';
import {
  MINOR_PER_TWD,
  assertEnvironment,
  assertMerchantId,
  isPlainObject,
  parseOptionalFeeMinor,
  parseOptionalSanitized,
} from '../field-rules.js';
import type { FormFields } from '../form.js';
import { ECPAY_ORIGINS, type EcpayEnvironment } from '../index.js';
import { unwrapKeyList, unwrapKeyPair, type EcpayKeyPair } from '../keys.js';
import { createServerRequest, type EcpayServerRequest } from '../server-request.js';
import { parseTaipeiDateTime } from '../taipei-time.js';
import { isTradeNumber } from '../trade-number.js';
import { assertCreditAmountMinor } from './profile.js';

const ALPHANUMERIC_ID_PATTERN = /^[0-9A-Za-z]{1,20}$/;
const TRADE_AMT_PATTERN = /^[0-9]{1,9}$/;
const NUMERIC_STATUS_PATTERN = /^[0-9]{1,10}$/;
const MAX_PAYMENT_TYPE_CODE_POINTS = 50;

export interface TradeInfoQueryInput {
  readonly environment: EcpayEnvironment;
  readonly merchantId: string;
  readonly merchantTradeNo: string;
  readonly timestampSeconds: number;
}

export interface ParseTradeInfoResponseOptions {
  readonly merchantId: string;
  readonly merchantTradeNo: string;
  readonly expectedAmountMinor: number;
  readonly expectedTradeNo?: string;
}

export type TradeInfoUnknownReason =
  | VerifySignedFormFailureReason
  | 'merchant_mismatch'
  | 'merchant_trade_no_mismatch'
  | 'platform_mismatch'
  | 'missing_field'
  | 'invalid_field'
  | 'unrecognized_status';

export type TradeInfoResponseResult =
  | {
      readonly kind: 'paid';
      readonly tradeNo: string;
      readonly tradeAmtMinor: number;
      readonly paymentDate: string | null;
      readonly paymentDateEpochMs: number | null;
      readonly paymentType: string | null;
      readonly handlingChargeMinor: number | null;
      readonly chargeFeeMinor: number | null;
      readonly keyIndex: number;
    }
  | {
      readonly kind: 'unpaid';
      readonly keyIndex: number;
    }
  | {
      readonly kind: 'failed';
      readonly keyIndex: number;
    }
  | {
      readonly kind: 'amount_mismatch';
      readonly tradeNo: string;
      readonly tradeAmtMinor: number;
      readonly keyIndex: number;
    }
  | {
      readonly kind: 'trade_no_mismatch';
      readonly tradeNo: string;
      readonly keyIndex: number;
    }
  | {
      readonly kind: 'unknown';
      readonly reason: TradeInfoUnknownReason;
      readonly field?: string;
      readonly tradeStatus?: string;
    };

export function buildTradeInfoQuery(
  input: TradeInfoQueryInput,
  keys: EcpayKeyPair,
): EcpayServerRequest {
  unwrapKeyPair(keys);
  if (!isPlainObject(input)) {
    throw new EcpayProtocolError('invalid_input');
  }
  assertEnvironment(input.environment);
  assertMerchantId(input.merchantId);

  if (
    typeof input.merchantTradeNo !== 'string' ||
    !isTradeNumber(input.merchantTradeNo, 'F')
  ) {
    throw new EcpayProtocolError('invalid_input');
  }

  if (
    typeof input.timestampSeconds !== 'number' ||
    !Number.isSafeInteger(input.timestampSeconds) ||
    input.timestampSeconds <= 0
  ) {
    throw new EcpayProtocolError('invalid_input');
  }

  const unsignedFields: FormFields = [
    ['MerchantID', input.merchantId],
    ['MerchantTradeNo', input.merchantTradeNo],
    ['TimeStamp', String(input.timestampSeconds)],
  ];
  assertFieldsCdnSafe(unsignedFields);

  const signedFields = aio.sign(unsignedFields, keys);

  const url = `${ECPAY_ORIGINS.payment[input.environment]}/Cashier/QueryTradeInfo/V5`;
  return createServerRequest(url, signedFields);
}

export function parseTradeInfoResponse(
  body: string | Uint8Array,
  keys: EcpayKeyPair | readonly EcpayKeyPair[],
  options: ParseTradeInfoResponseOptions,
): TradeInfoResponseResult {
  unwrapKeyList(keys);
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

  assertCreditAmountMinor(options.expectedAmountMinor);

  if (
    options.expectedTradeNo !== undefined &&
    (typeof options.expectedTradeNo !== 'string' ||
      !ALPHANUMERIC_ID_PATTERN.test(options.expectedTradeNo))
  ) {
    throw new EcpayProtocolError('invalid_input');
  }

  const verified = aio.verify(body, keys);
  if (!verified.ok) {
    return Object.freeze({
      kind: 'unknown' as const,
      reason: verified.reason,
    });
  }

  const { fields, keyIndex } = verified;

  if (fields.MerchantID !== options.merchantId) {
    return Object.freeze({
      kind: 'unknown' as const,
      reason: 'merchant_mismatch' as const,
    });
  }

  const rawMerchantTradeNo = fields.MerchantTradeNo ?? '';
  if (
    !ALPHANUMERIC_ID_PATTERN.test(rawMerchantTradeNo) ||
    rawMerchantTradeNo.toUpperCase() !== options.merchantTradeNo.toUpperCase()
  ) {
    return Object.freeze({
      kind: 'unknown' as const,
      reason: 'merchant_trade_no_mismatch' as const,
    });
  }

  if (fields.PlatformID !== undefined && fields.PlatformID !== '') {
    return Object.freeze({
      kind: 'unknown' as const,
      reason: 'platform_mismatch' as const,
    });
  }

  const rawTradeStatus = fields.TradeStatus;

  if (rawTradeStatus === '1') {
    const rawTradeNo = fields.TradeNo;
    if (rawTradeNo === undefined || rawTradeNo === '') {
      return Object.freeze({
        kind: 'unknown' as const,
        reason: 'missing_field' as const,
        field: 'TradeNo',
      });
    }
    if (!ALPHANUMERIC_ID_PATTERN.test(rawTradeNo)) {
      return Object.freeze({
        kind: 'unknown' as const,
        reason: 'invalid_field' as const,
        field: 'TradeNo',
      });
    }

    const rawTradeAmt = fields.TradeAmt;
    if (rawTradeAmt === undefined || rawTradeAmt === '') {
      return Object.freeze({
        kind: 'unknown' as const,
        reason: 'missing_field' as const,
        field: 'TradeAmt',
      });
    }
    if (!TRADE_AMT_PATTERN.test(rawTradeAmt)) {
      return Object.freeze({
        kind: 'unknown' as const,
        reason: 'invalid_field' as const,
        field: 'TradeAmt',
      });
    }

    const rawPaymentDate = fields.PaymentDate ?? '';
    let paymentDateEpochMs: number | null = null;
    if (rawPaymentDate !== '') {
      paymentDateEpochMs = parseTaipeiDateTime(rawPaymentDate);
      if (paymentDateEpochMs === null) {
        return Object.freeze({
          kind: 'unknown' as const,
          reason: 'invalid_field' as const,
          field: 'PaymentDate',
        });
      }
    }

    const tradeNo = rawTradeNo.toUpperCase();
    const tradeAmtMinor = Number(rawTradeAmt) * MINOR_PER_TWD;

    if (
      options.expectedTradeNo !== undefined &&
      tradeNo !== options.expectedTradeNo.toUpperCase()
    ) {
      return Object.freeze({
        kind: 'trade_no_mismatch' as const,
        tradeNo,
        keyIndex,
      });
    }

    if (tradeAmtMinor !== options.expectedAmountMinor) {
      return Object.freeze({
        kind: 'amount_mismatch' as const,
        tradeNo,
        tradeAmtMinor,
        keyIndex,
      });
    }

    const paymentDate = rawPaymentDate !== '' ? rawPaymentDate : null;
    const paymentType = parseOptionalSanitized(fields.PaymentType, MAX_PAYMENT_TYPE_CODE_POINTS);
    const handlingChargeMinor = parseOptionalFeeMinor(fields.HandlingCharge);
    const chargeFeeMinor = parseOptionalFeeMinor(fields.PaymentTypeChargeFee);

    return Object.freeze({
      kind: 'paid' as const,
      tradeNo,
      tradeAmtMinor,
      paymentDate,
      paymentDateEpochMs,
      paymentType,
      handlingChargeMinor,
      chargeFeeMinor,
      keyIndex,
    });
  }

  if (rawTradeStatus === '0') {
    return Object.freeze({
      kind: 'unpaid' as const,
      keyIndex,
    });
  }

  if (rawTradeStatus === '10200095') {
    return Object.freeze({
      kind: 'failed' as const,
      keyIndex,
    });
  }

  if (rawTradeStatus !== undefined && NUMERIC_STATUS_PATTERN.test(rawTradeStatus)) {
    return Object.freeze({
      kind: 'unknown' as const,
      reason: 'unrecognized_status' as const,
      tradeStatus: rawTradeStatus,
    });
  }

  return Object.freeze({
    kind: 'unknown' as const,
    reason: 'unrecognized_status' as const,
  });
}
