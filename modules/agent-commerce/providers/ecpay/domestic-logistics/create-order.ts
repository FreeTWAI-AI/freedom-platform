import { assertFieldsCdnSafe } from '../cdn-guard.js';
import type { VerifySignedFormFailureReason } from '../checkmac.js';
import { sanitizeMessage } from '../encoding.js';
import { EcpayProtocolError } from '../errors.js';
import {
  MINOR_PER_TWD,
  assertEnvironment,
  assertMerchantId,
  assertPositiveWholeTwdMinor,
  assertValidEcpayHttpsUrl,
  isPlainObject,
} from '../field-rules.js';
import type { FormFields } from '../form.js';
import { ECPAY_ORIGINS, type EcpayEnvironment } from '../index.js';
import { unwrapKeyList, unwrapKeyPair, type EcpayKeyPair } from '../keys.js';
import { logistics } from '../logistics.js';
import {
  createServerRequest,
  type EcpayServerRequest,
} from '../server-request.js';
import { formatTaipeiDateTime, parseTaipeiDateTime } from '../taipei-time.js';
import { isTradeNumber } from '../trade-number.js';
import {
  CVS_PAYMENT_NO_PATTERN,
  CVS_VALIDATION_NO_PATTERN,
  LOGISTICS_ID_PATTERN,
  assertCellPhone,
  assertHomeAddress,
  assertPersonName,
  assertStoreId,
  assertZipCode,
} from './party-rules.js';
import {
  ECPAY_LOGISTICS_SUBTYPES,
  assertCvsSubType,
  assertHomeSubType,
  assertLogisticsSubType,
  type EcpayCvsSubType,
  type EcpayHomeSubType,
  type EcpayLogisticsSubType,
} from './profile.js';

export const FIXED_GOODS_NAME = '訂購商品' as const;

const MERCHANT_TRADE_NO_RESPONSE_PATTERN = /^[0-9A-Za-z]{1,20}$/;
const GOODS_AMOUNT_PATTERN = /^[0-9]{1,9}$/;
const RTN_CODE_PATTERN = /^[0-9]{1,10}$/;
const UPDATE_STATUS_DATE_PATTERN = /^[0-9/: ]{1,20}$/;
const BOOKING_NOTE_PATTERN = /^[0-9A-Za-z-]{1,50}$/;

const TCAT_DISTANCE_CODES: Readonly<Record<HomeDeliveryDistance, string>> =
  Object.freeze({
    same_county: '00',
    other_county: '01',
    outlying: '02',
  });

const TCAT_SPECIFICATION_CODES: Readonly<Record<HomeDeliverySizeCm, string>> =
  Object.freeze({
    60: '0001',
    90: '0002',
    120: '0003',
    150: '0004',
  });

export type HomeDeliveryDistance = 'same_county' | 'other_county' | 'outlying';
export type HomeDeliverySizeCm = 60 | 90 | 120 | 150;

export interface CvsSenderPartyInput {
  readonly name: string;
  readonly cellPhone: string;
}

export interface CvsReceiverPartyInput {
  readonly name: string;
  readonly cellPhone: string;
  readonly storeId: string;
}

export interface CvsCreateOrderInput {
  readonly environment: EcpayEnvironment;
  readonly merchantId: string;
  readonly merchantTradeNo: string;
  readonly createdAtEpochMs: number;
  readonly subType: EcpayCvsSubType;
  readonly goodsAmountMinor: number;
  readonly sender: CvsSenderPartyInput;
  readonly receiver: CvsReceiverPartyInput;
  readonly serverReplyUrl: string;
}

export interface HomePartyInput {
  readonly name: string;
  readonly cellPhone: string;
  readonly zipCode: string;
  readonly address: string;
}

export interface HomeCreateOrderInput {
  readonly environment: EcpayEnvironment;
  readonly merchantId: string;
  readonly merchantTradeNo: string;
  readonly createdAtEpochMs: number;
  readonly subType: EcpayHomeSubType;
  readonly goodsAmountMinor: number;
  readonly sender: HomePartyInput;
  readonly receiver: HomePartyInput;
  readonly serverReplyUrl: string;
  readonly distance?: HomeDeliveryDistance;
  readonly sizeCm?: HomeDeliverySizeCm;
  readonly weightGrams?: number;
}

export interface ParseCreateOrderResponseOptions {
  readonly merchantId: string;
  readonly merchantTradeNo: string;
  readonly subType: EcpayLogisticsSubType;
  readonly goodsAmountMinor: number;
}

export type CreateOrderUnknownReason =
  | 'unparseable'
  | 'unexpected_ack'
  | VerifySignedFormFailureReason
  | 'merchant_mismatch'
  | 'merchant_trade_no_mismatch'
  | 'subtype_mismatch'
  | 'amount_mismatch'
  | 'missing_field'
  | 'invalid_field';

export type CreateOrderResponseResult =
  | {
      readonly kind: 'created';
      readonly keyIndex: number;
      readonly merchantTradeNo: string;
      readonly allPayLogisticsId: string;
      readonly subType: EcpayLogisticsSubType;
      readonly rtnCode: string;
      readonly rtnMsg: string;
      readonly updateStatusDate: string | null;
      readonly updateStatusEpochMs: number | null;
      readonly cvsPaymentNo: string | null;
      readonly cvsValidationNo: string | null;
      readonly bookingNote: string | null;
      readonly ignoredFields: readonly string[];
    }
  | {
      readonly kind: 'rejected';
      readonly message: string;
    }
  | {
      readonly kind: 'unknown';
      readonly reason: CreateOrderUnknownReason;
      readonly field?: string;
    };

function assertLogisticsMerchantTradeNo(
  value: unknown,
): asserts value is string {
  if (typeof value !== 'string' || !isTradeNumber(value, 'L')) {
    throw new EcpayProtocolError('invalid_input');
  }
}

function assertGoodsAmountForSubType(
  goodsAmountMinor: unknown,
  subType: EcpayLogisticsSubType,
): asserts goodsAmountMinor is number {
  assertPositiveWholeTwdMinor(goodsAmountMinor);
  const maxGoodsAmountTwd = ECPAY_LOGISTICS_SUBTYPES[subType].maxGoodsAmountTwd;
  if (
    maxGoodsAmountTwd !== null &&
    goodsAmountMinor > maxGoodsAmountTwd * MINOR_PER_TWD
  ) {
    throw new EcpayProtocolError('invalid_input');
  }
}

function formatPostGoodsWeight(weightGrams: unknown): string {
  const maxWeightGrams = ECPAY_LOGISTICS_SUBTYPES.POST.maxWeightGrams!;
  if (
    typeof weightGrams !== 'number' ||
    !Number.isSafeInteger(weightGrams) ||
    weightGrams < 1 ||
    weightGrams > maxWeightGrams
  ) {
    throw new EcpayProtocolError('invalid_input');
  }
  const whole = Math.trunc(weightGrams / 1000);
  const rem = weightGrams % 1000;
  if (rem === 0) {
    return String(whole);
  }
  const frac = String(rem).padStart(3, '0').replace(/0+$/, '');
  return `${whole}.${frac}`;
}

export function buildCvsCreateOrderRequest(
  input: CvsCreateOrderInput,
  keys: EcpayKeyPair,
): EcpayServerRequest {
  unwrapKeyPair(keys);
  if (!isPlainObject(input)) {
    throw new EcpayProtocolError('invalid_input');
  }
  assertEnvironment(input.environment);
  assertMerchantId(input.merchantId);
  assertLogisticsMerchantTradeNo(input.merchantTradeNo);
  const merchantTradeDate = formatTaipeiDateTime(input.createdAtEpochMs);
  assertCvsSubType(input.subType);
  assertGoodsAmountForSubType(input.goodsAmountMinor, input.subType);

  if (!isPlainObject(input.sender) || !isPlainObject(input.receiver)) {
    throw new EcpayProtocolError('invalid_input');
  }
  assertPersonName(input.sender.name);
  assertCellPhone(input.sender.cellPhone);
  assertPersonName(input.receiver.name);
  assertCellPhone(input.receiver.cellPhone);
  assertStoreId(input.receiver.storeId);
  assertValidEcpayHttpsUrl(input.serverReplyUrl);

  const goodsAmount = String(input.goodsAmountMinor / MINOR_PER_TWD);

  const unsignedFields: FormFields = [
    ['MerchantID', input.merchantId],
    ['MerchantTradeNo', input.merchantTradeNo],
    ['MerchantTradeDate', merchantTradeDate],
    ['LogisticsType', 'CVS'],
    ['LogisticsSubType', input.subType],
    ['GoodsAmount', goodsAmount],
    ['IsCollection', 'N'],
    ['GoodsName', FIXED_GOODS_NAME],
    ['SenderName', input.sender.name],
    ['SenderCellPhone', input.sender.cellPhone],
    ['ReceiverName', input.receiver.name],
    ['ReceiverCellPhone', input.receiver.cellPhone],
    ['ServerReplyURL', input.serverReplyUrl],
    ['ReceiverStoreID', input.receiver.storeId],
  ];

  assertFieldsCdnSafe(unsignedFields);
  const signedFields = logistics.sign(unsignedFields, keys);
  const url = `${ECPAY_ORIGINS.logistics[input.environment]}/Express/Create`;
  return createServerRequest(url, signedFields);
}

export function buildHomeCreateOrderRequest(
  input: HomeCreateOrderInput,
  keys: EcpayKeyPair,
): EcpayServerRequest {
  unwrapKeyPair(keys);
  if (!isPlainObject(input)) {
    throw new EcpayProtocolError('invalid_input');
  }
  assertEnvironment(input.environment);
  assertMerchantId(input.merchantId);
  assertLogisticsMerchantTradeNo(input.merchantTradeNo);
  const merchantTradeDate = formatTaipeiDateTime(input.createdAtEpochMs);
  assertHomeSubType(input.subType);
  assertGoodsAmountForSubType(input.goodsAmountMinor, input.subType);

  if (!isPlainObject(input.sender) || !isPlainObject(input.receiver)) {
    throw new EcpayProtocolError('invalid_input');
  }
  assertPersonName(input.sender.name);
  assertCellPhone(input.sender.cellPhone);
  assertZipCode(input.sender.zipCode);
  assertHomeAddress(input.sender.address);

  assertPersonName(input.receiver.name);
  assertCellPhone(input.receiver.cellPhone);
  assertZipCode(input.receiver.zipCode);
  assertHomeAddress(input.receiver.address);

  assertValidEcpayHttpsUrl(input.serverReplyUrl);

  const goodsAmount = String(input.goodsAmountMinor / MINOR_PER_TWD);
  let unsignedFields: FormFields;

  if (input.subType === 'TCAT') {
    if (input.weightGrams !== undefined && input.weightGrams !== null) {
      throw new EcpayProtocolError('invalid_input');
    }
    if (
      typeof input.distance !== 'string' ||
      !Object.prototype.hasOwnProperty.call(TCAT_DISTANCE_CODES, input.distance)
    ) {
      throw new EcpayProtocolError('invalid_input');
    }
    if (
      typeof input.sizeCm !== 'number' ||
      !Object.prototype.hasOwnProperty.call(TCAT_SPECIFICATION_CODES, input.sizeCm)
    ) {
      throw new EcpayProtocolError('invalid_input');
    }
    const distanceCode = TCAT_DISTANCE_CODES[input.distance];
    const specificationCode = TCAT_SPECIFICATION_CODES[input.sizeCm];

    unsignedFields = [
      ['MerchantID', input.merchantId],
      ['MerchantTradeNo', input.merchantTradeNo],
      ['MerchantTradeDate', merchantTradeDate],
      ['LogisticsType', 'HOME'],
      ['LogisticsSubType', 'TCAT'],
      ['GoodsAmount', goodsAmount],
      ['IsCollection', 'N'],
      ['GoodsName', FIXED_GOODS_NAME],
      ['SenderName', input.sender.name],
      ['SenderCellPhone', input.sender.cellPhone],
      ['SenderZipCode', input.sender.zipCode],
      ['SenderAddress', input.sender.address],
      ['ReceiverName', input.receiver.name],
      ['ReceiverCellPhone', input.receiver.cellPhone],
      ['ReceiverZipCode', input.receiver.zipCode],
      ['ReceiverAddress', input.receiver.address],
      ['Temperature', '0001'],
      ['Distance', distanceCode],
      ['Specification', specificationCode],
      ['ScheduledPickupTime', '4'],
      ['ScheduledDeliveryTime', '4'],
      ['ServerReplyURL', input.serverReplyUrl],
    ];
  } else {
    if (
      (input.distance !== undefined && input.distance !== null) ||
      (input.sizeCm !== undefined && input.sizeCm !== null)
    ) {
      throw new EcpayProtocolError('invalid_input');
    }
    const goodsWeight = formatPostGoodsWeight(input.weightGrams);

    unsignedFields = [
      ['MerchantID', input.merchantId],
      ['MerchantTradeNo', input.merchantTradeNo],
      ['MerchantTradeDate', merchantTradeDate],
      ['LogisticsType', 'HOME'],
      ['LogisticsSubType', 'POST'],
      ['GoodsAmount', goodsAmount],
      ['GoodsName', FIXED_GOODS_NAME],
      ['GoodsWeight', goodsWeight],
      ['SenderName', input.sender.name],
      ['SenderCellPhone', input.sender.cellPhone],
      ['SenderZipCode', input.sender.zipCode],
      ['SenderAddress', input.sender.address],
      ['ReceiverName', input.receiver.name],
      ['ReceiverCellPhone', input.receiver.cellPhone],
      ['ReceiverZipCode', input.receiver.zipCode],
      ['ReceiverAddress', input.receiver.address],
      ['Temperature', '0001'],
      ['ServerReplyURL', input.serverReplyUrl],
    ];
  }

  assertFieldsCdnSafe(unsignedFields);
  const signedFields = logistics.sign(unsignedFields, keys);
  const url = `${ECPAY_ORIGINS.logistics[input.environment]}/Express/Create`;
  return createServerRequest(url, signedFields);
}

export function parseCreateOrderResponse(
  text: string,
  keys: EcpayKeyPair | readonly EcpayKeyPair[],
  options: ParseCreateOrderResponseOptions,
): CreateOrderResponseResult {
  unwrapKeyList(keys);
  if (!isPlainObject(options)) {
    throw new EcpayProtocolError('invalid_input');
  }
  assertMerchantId(options.merchantId);
  assertLogisticsMerchantTradeNo(options.merchantTradeNo);
  assertLogisticsSubType(options.subType);
  assertGoodsAmountForSubType(options.goodsAmountMinor, options.subType);

  if (typeof text !== 'string') {
    return Object.freeze({
      kind: 'unknown' as const,
      reason: 'unparseable' as const,
    });
  }

  const parsed = logistics.parseCreateResponse(text, keys);
  if (parsed.kind === 'unknown') {
    return Object.freeze({
      kind: 'unknown' as const,
      reason: parsed.reason,
    });
  }
  if (parsed.kind === 'rejected') {
    return Object.freeze({
      kind: 'rejected' as const,
      message: parsed.message,
    });
  }

  const { fields, keyIndex } = parsed;

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
  if (merchantTradeNo !== options.merchantTradeNo) {
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

  const rawLogisticsType = fields.LogisticsType;
  if (rawLogisticsType === undefined || rawLogisticsType === '') {
    return Object.freeze({
      kind: 'unknown' as const,
      reason: 'missing_field' as const,
      field: 'LogisticsType',
    });
  }
  const rawLogisticsSubType = fields.LogisticsSubType;
  if (rawLogisticsSubType === undefined || rawLogisticsSubType === '') {
    return Object.freeze({
      kind: 'unknown' as const,
      reason: 'missing_field' as const,
      field: 'LogisticsSubType',
    });
  }
  const expectedDescriptor = ECPAY_LOGISTICS_SUBTYPES[options.subType];
  if (
    rawLogisticsType.toUpperCase() !== expectedDescriptor.logisticsType ||
    rawLogisticsSubType.toUpperCase() !== options.subType
  ) {
    return Object.freeze({
      kind: 'unknown' as const,
      reason: 'subtype_mismatch' as const,
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
  if (Number(rawGoodsAmount) * MINOR_PER_TWD !== options.goodsAmountMinor) {
    return Object.freeze({
      kind: 'unknown' as const,
      reason: 'amount_mismatch' as const,
    });
  }

  const rawRtnCode = fields.RtnCode;
  if (rawRtnCode === undefined || rawRtnCode === '') {
    return Object.freeze({
      kind: 'unknown' as const,
      reason: 'missing_field' as const,
      field: 'RtnCode',
    });
  }
  if (!RTN_CODE_PATTERN.test(rawRtnCode)) {
    return Object.freeze({
      kind: 'unknown' as const,
      reason: 'invalid_field' as const,
      field: 'RtnCode',
    });
  }

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

  const updateStatusDate = readLenientField(
    'UpdateStatusDate',
    UPDATE_STATUS_DATE_PATTERN,
  );
  const updateStatusEpochMs =
    updateStatusDate !== null ? parseTaipeiDateTime(updateStatusDate) : null;
  const cvsPaymentNo = readLenientField('CVSPaymentNo', CVS_PAYMENT_NO_PATTERN);
  const cvsValidationNo = readLenientField(
    'CVSValidationNo',
    CVS_VALIDATION_NO_PATTERN,
  );
  const bookingNote = readLenientField('BookingNote', BOOKING_NOTE_PATTERN);

  const rtnMsg = sanitizeMessage(fields.RtnMsg ?? '');

  return Object.freeze({
    kind: 'created' as const,
    keyIndex,
    merchantTradeNo,
    allPayLogisticsId: rawAllPayLogisticsId,
    subType: options.subType,
    rtnCode: rawRtnCode,
    rtnMsg,
    updateStatusDate,
    updateStatusEpochMs,
    cvsPaymentNo,
    cvsValidationNo,
    bookingNote,
    ignoredFields: Object.freeze(ignoredFields),
  });
}
