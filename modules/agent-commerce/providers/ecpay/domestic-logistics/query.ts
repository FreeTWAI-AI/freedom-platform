import { assertFieldsCdnSafe } from '../cdn-guard.js';
import type { VerifySignedFormFailureReason } from '../checkmac.js';
import { sanitizeMessage } from '../encoding.js';
import { EcpayProtocolError } from '../errors.js';
import {
  MINOR_PER_TWD,
  assertEnvironment,
  assertMerchantId,
  isPlainObject,
  parseOptionalFeeMinor,
} from '../field-rules.js';
import type { FormFields } from '../form.js';
import { ECPAY_ORIGINS, type EcpayEnvironment } from '../index.js';
import { unwrapKeyList, unwrapKeyPair, type EcpayKeyPair } from '../keys.js';
import { logistics } from '../logistics.js';
import {
  createServerRequest,
  type EcpayServerRequest,
} from '../server-request.js';
import { parseTaipeiDateTime } from '../taipei-time.js';
import { isTradeNumber } from '../trade-number.js';
import {
  CVS_PAYMENT_NO_PATTERN,
  CVS_VALIDATION_NO_PATTERN,
  LOGISTICS_ID_PATTERN,
  assertAllPayLogisticsId,
} from './party-rules.js';
import {
  ECPAY_LOGISTICS_SUBTYPES,
  isLogisticsSubType,
  type EcpayLogisticsSubType,
} from './profile.js';

const ASCII_WHITESPACE_TRIM = /^[ \t\r\n\f\v]+|[ \t\r\n\f\v]+$/g;
const MERCHANT_TRADE_NO_RESPONSE_PATTERN = /^[0-9A-Za-z]{1,20}$/;
const LOGISTICS_STATUS_PATTERN = /^[0-9]{1,10}$/;
const GOODS_AMOUNT_PATTERN = /^[0-9]{1,9}$/;
const COMBINED_LOGISTICS_TYPE_PATTERN = /^[0-9A-Za-z_]{1,30}$/;
const SHIP_CHARGE_DATE_PATTERN = /^[0-9]{4}\/[0-9]{2}\/[0-9]{2}$/;
const TRADE_DATE_PATTERN = /^[0-9/: ]{1,20}$/;
const SHIPMENT_NO_PATTERN = /^[0-9A-Za-z]{1,25}$/;
const BOOKING_NOTE_PATTERN = /^[0-9A-Za-z-]{1,50}$/;

export interface LogisticsQueryRequestInput {
  readonly environment: EcpayEnvironment;
  readonly merchantId: string;
  readonly allPayLogisticsId?: string;
  readonly merchantTradeNo?: string;
  readonly timestampSeconds: number;
}

export interface ParseLogisticsQueryResponseOptions {
  readonly merchantId: string;
  readonly allPayLogisticsId?: string;
  readonly merchantTradeNo?: string;
}

export type LogisticsQueryUnknownReason =
  | 'unparseable'
  | VerifySignedFormFailureReason
  | 'merchant_mismatch'
  | 'merchant_trade_no_mismatch'
  | 'logistics_id_mismatch'
  | 'missing_field'
  | 'invalid_field';

export interface LogisticsQueryFoundResult {
  readonly kind: 'found';
  readonly keyIndex: number;
  readonly merchantTradeNo: string;
  readonly allPayLogisticsId: string;
  readonly logisticsStatus: string;
  readonly logisticsType: string | null;
  readonly subType: EcpayLogisticsSubType | null;
  readonly goodsAmountMinor: number;
  readonly handlingChargeMinor: number | null;
  readonly shipChargeDate: string | null;
  readonly tradeDate: string | null;
  readonly tradeDateEpochMs: number | null;
  readonly cvsPaymentNo: string | null;
  readonly cvsValidationNo: string | null;
  readonly shipmentNo: string | null;
  readonly bookingNote: string | null;
  readonly ignoredFields: readonly string[];
}

export type LogisticsQueryResponseResult =
  | LogisticsQueryFoundResult
  | {
      readonly kind: 'rejected';
      readonly message: string;
    }
  | {
      readonly kind: 'unknown';
      readonly reason: LogisticsQueryUnknownReason;
      readonly field?: string;
    };

function validateQueryIdentifierPair(input: {
  readonly allPayLogisticsId?: unknown;
  readonly merchantTradeNo?: unknown;
}):
  | { readonly kind: 'logistics_id'; readonly value: string }
  | { readonly kind: 'merchant_trade_no'; readonly value: string } {
  const hasLogisticsId =
    input.allPayLogisticsId !== undefined && input.allPayLogisticsId !== null;
  const hasTradeNo =
    input.merchantTradeNo !== undefined && input.merchantTradeNo !== null;
  if (hasLogisticsId === hasTradeNo) {
    throw new EcpayProtocolError('invalid_input');
  }
  if (hasLogisticsId) {
    assertAllPayLogisticsId(input.allPayLogisticsId);
    return { kind: 'logistics_id', value: input.allPayLogisticsId };
  }
  if (
    typeof input.merchantTradeNo !== 'string' ||
    !isTradeNumber(input.merchantTradeNo, 'L')
  ) {
    throw new EcpayProtocolError('invalid_input');
  }
  return { kind: 'merchant_trade_no', value: input.merchantTradeNo };
}

function parseCombinedSubType(
  rawLogisticsType: string | null,
): EcpayLogisticsSubType | null {
  if (rawLogisticsType === null) {
    return null;
  }
  const upper = rawLogisticsType.toUpperCase();
  const sepIndex = upper.indexOf('_');
  if (sepIndex === -1) {
    return null;
  }
  const prefix = upper.slice(0, sepIndex);
  const suffix = upper.slice(sepIndex + 1);
  if (!isLogisticsSubType(suffix)) {
    return null;
  }
  if (ECPAY_LOGISTICS_SUBTYPES[suffix].logisticsType !== prefix) {
    return null;
  }
  return suffix;
}

export function buildLogisticsQueryRequest(
  input: LogisticsQueryRequestInput,
  keys: EcpayKeyPair,
): EcpayServerRequest {
  unwrapKeyPair(keys);
  if (!isPlainObject(input)) {
    throw new EcpayProtocolError('invalid_input');
  }
  assertEnvironment(input.environment);
  assertMerchantId(input.merchantId);
  const identifier = validateQueryIdentifierPair(input);

  if (
    typeof input.timestampSeconds !== 'number' ||
    !Number.isSafeInteger(input.timestampSeconds) ||
    input.timestampSeconds <= 0
  ) {
    throw new EcpayProtocolError('invalid_input');
  }

  const unsignedFields: FormFields = [
    ['MerchantID', input.merchantId],
    identifier.kind === 'logistics_id'
      ? ['AllPayLogisticsID', identifier.value]
      : ['MerchantTradeNo', identifier.value],
    ['TimeStamp', String(input.timestampSeconds)],
  ];

  assertFieldsCdnSafe(unsignedFields);
  const signedFields = logistics.sign(unsignedFields, keys);
  const url = `${ECPAY_ORIGINS.logistics[input.environment]}/Helper/QueryLogisticsTradeInfo/V5`;
  return createServerRequest(url, signedFields);
}

export function parseLogisticsQueryResponse(
  text: string,
  keys: EcpayKeyPair | readonly EcpayKeyPair[],
  options: ParseLogisticsQueryResponseOptions,
): LogisticsQueryResponseResult {
  unwrapKeyList(keys);
  if (!isPlainObject(options)) {
    throw new EcpayProtocolError('invalid_input');
  }
  assertMerchantId(options.merchantId);
  const expectedIdentifier = validateQueryIdentifierPair(options);

  if (typeof text !== 'string') {
    return Object.freeze({
      kind: 'unknown' as const,
      reason: 'unparseable' as const,
    });
  }

  const trimmed = text.replace(ASCII_WHITESPACE_TRIM, '');
  if (trimmed.startsWith('0|')) {
    return Object.freeze({
      kind: 'rejected' as const,
      message: sanitizeMessage(trimmed.slice(2)),
    });
  }
  const rest = trimmed.startsWith('1|') ? trimmed.slice(2) : trimmed;

  const verified = logistics.verify(rest, keys);
  if (!verified.ok) {
    return Object.freeze({
      kind: 'unknown' as const,
      reason: verified.reason,
    });
  }

  const { fields, keyIndex } = verified;

  const rawMerchantId = fields.MerchantID;
  if (rawMerchantId === undefined || rawMerchantId === '') {
    return Object.freeze({
      kind: 'unknown' as const,
      reason: 'missing_field' as const,
      field: 'MerchantID',
    });
  }
  if (rawMerchantId !== options.merchantId) {
    return Object.freeze({
      kind: 'unknown' as const,
      reason: 'merchant_mismatch' as const,
    });
  }

  const rawMerchantTradeNo = fields.MerchantTradeNo;
  if (rawMerchantTradeNo === undefined || rawMerchantTradeNo === '') {
    return Object.freeze({
      kind: 'unknown' as const,
      reason: 'missing_field' as const,
      field: 'MerchantTradeNo',
    });
  }
  if (!MERCHANT_TRADE_NO_RESPONSE_PATTERN.test(rawMerchantTradeNo)) {
    return Object.freeze({
      kind: 'unknown' as const,
      reason: 'invalid_field' as const,
      field: 'MerchantTradeNo',
    });
  }
  const merchantTradeNo = rawMerchantTradeNo.toUpperCase();
  if (
    expectedIdentifier.kind === 'merchant_trade_no' &&
    merchantTradeNo !== expectedIdentifier.value
  ) {
    return Object.freeze({
      kind: 'unknown' as const,
      reason: 'merchant_trade_no_mismatch' as const,
    });
  }

  const rawAllPayLogisticsId = fields.AllPayLogisticsID;
  if (rawAllPayLogisticsId === undefined || rawAllPayLogisticsId === '') {
    return Object.freeze({
      kind: 'unknown' as const,
      reason: 'missing_field' as const,
      field: 'AllPayLogisticsID',
    });
  }
  if (!LOGISTICS_ID_PATTERN.test(rawAllPayLogisticsId)) {
    return Object.freeze({
      kind: 'unknown' as const,
      reason: 'invalid_field' as const,
      field: 'AllPayLogisticsID',
    });
  }
  if (
    expectedIdentifier.kind === 'logistics_id' &&
    rawAllPayLogisticsId !== expectedIdentifier.value
  ) {
    return Object.freeze({
      kind: 'unknown' as const,
      reason: 'logistics_id_mismatch' as const,
    });
  }

  const rawLogisticsStatus = fields.LogisticsStatus;
  if (rawLogisticsStatus === undefined || rawLogisticsStatus === '') {
    return Object.freeze({
      kind: 'unknown' as const,
      reason: 'missing_field' as const,
      field: 'LogisticsStatus',
    });
  }
  if (!LOGISTICS_STATUS_PATTERN.test(rawLogisticsStatus)) {
    return Object.freeze({
      kind: 'unknown' as const,
      reason: 'invalid_field' as const,
      field: 'LogisticsStatus',
    });
  }

  const rawGoodsAmount = fields.GoodsAmount;
  if (rawGoodsAmount === undefined || rawGoodsAmount === '') {
    return Object.freeze({
      kind: 'unknown' as const,
      reason: 'missing_field' as const,
      field: 'GoodsAmount',
    });
  }
  if (!GOODS_AMOUNT_PATTERN.test(rawGoodsAmount)) {
    return Object.freeze({
      kind: 'unknown' as const,
      reason: 'invalid_field' as const,
      field: 'GoodsAmount',
    });
  }
  const goodsAmountMinor = Number(rawGoodsAmount) * MINOR_PER_TWD;

  const ignoredFields: string[] = [];

  function readLenientField(name: string, pattern: RegExp): string | null {
    const raw = fields[name];
    if (raw === undefined || raw === '') {
      return null;
    }
    if (!pattern.test(raw)) {
      ignoredFields.push(name);
      return null;
    }
    return raw;
  }

  const logisticsType = readLenientField(
    'LogisticsType',
    COMBINED_LOGISTICS_TYPE_PATTERN,
  );
  const subType = parseCombinedSubType(logisticsType);

  let handlingChargeMinor: number | null = null;
  const rawHandlingCharge = fields.HandlingCharge;
  if (rawHandlingCharge !== undefined && rawHandlingCharge !== '') {
    handlingChargeMinor = parseOptionalFeeMinor(rawHandlingCharge);
    if (handlingChargeMinor === null) {
      ignoredFields.push('HandlingCharge');
    }
  }

  const shipChargeDate = readLenientField(
    'ShipChargeDate',
    SHIP_CHARGE_DATE_PATTERN,
  );
  const tradeDate = readLenientField('TradeDate', TRADE_DATE_PATTERN);
  const tradeDateEpochMs =
    tradeDate !== null ? parseTaipeiDateTime(tradeDate) : null;
  const cvsPaymentNo = readLenientField('CVSPaymentNo', CVS_PAYMENT_NO_PATTERN);
  const cvsValidationNo = readLenientField(
    'CVSValidationNo',
    CVS_VALIDATION_NO_PATTERN,
  );
  const shipmentNo = readLenientField('ShipmentNo', SHIPMENT_NO_PATTERN);
  const bookingNote = readLenientField('BookingNote', BOOKING_NOTE_PATTERN);

  return Object.freeze({
    kind: 'found' as const,
    keyIndex,
    merchantTradeNo,
    allPayLogisticsId: rawAllPayLogisticsId,
    logisticsStatus: rawLogisticsStatus,
    logisticsType,
    subType,
    goodsAmountMinor,
    handlingChargeMinor,
    shipChargeDate,
    tradeDate,
    tradeDateEpochMs,
    cvsPaymentNo,
    cvsValidationNo,
    shipmentNo,
    bookingNote,
    ignoredFields: Object.freeze(ignoredFields),
  });
}
