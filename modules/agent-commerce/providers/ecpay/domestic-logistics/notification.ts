import { bodySha256Hex } from '../body-digest.js';
import type { VerifySignedFormFailureReason } from '../checkmac.js';
import { sanitizeMessage } from '../encoding.js';
import { EcpayProtocolError } from '../errors.js';
import {
  MINOR_PER_TWD,
  assertMerchantId,
  isPlainObject,
} from '../field-rules.js';
import { unwrapKeyList, type EcpayKeyPair } from '../keys.js';
import { logistics } from '../logistics.js';
import { parseTaipeiDateTime } from '../taipei-time.js';
import { LOGISTICS_ID_PATTERN } from './party-rules.js';
import { isLogisticsSubType, type EcpayLogisticsSubType } from './profile.js';

const ALPHANUMERIC_ID_PATTERN = /^[0-9A-Za-z]{1,20}$/;
const RTN_CODE_PATTERN = /^[0-9]{1,10}$/;
const GOODS_AMOUNT_PATTERN = /^[0-9]{1,9}$/;
const UPDATE_STATUS_DATE_PATTERN = /^[0-9/: ]{1,20}$/;

export interface LogisticsNotificationDedupeKey {
  readonly allPayLogisticsId: string;
  readonly rtnCode: string;
  readonly updateStatusDate: string;
}

export interface LogisticsNotification {
  readonly kind: 'notification';
  readonly keyIndex: number;
  readonly merchantTradeNo: string;
  readonly allPayLogisticsId: string;
  readonly rtnCode: string;
  readonly rtnMsg: string;
  readonly logisticsSubType: string;
  readonly subType: EcpayLogisticsSubType | null;
  readonly goodsAmountMinor: number;
  readonly updateStatusDate: string;
  readonly updateStatusEpochMs: number | null;
  readonly dedupe: LogisticsNotificationDedupeKey;
  readonly bodySha256: string;
}

export type LogisticsNotificationInvalidReason =
  | VerifySignedFormFailureReason
  | 'merchant_mismatch'
  | 'missing_field'
  | 'invalid_field';

export interface ParseLogisticsNotificationOptions {
  readonly merchantId: string;
}

export type ParseLogisticsNotificationResult =
  | LogisticsNotification
  | {
      readonly kind: 'invalid';
      readonly reason: LogisticsNotificationInvalidReason;
      readonly field?: string;
    };

export function parseLogisticsNotification(
  body: string | Uint8Array,
  keys: EcpayKeyPair | readonly EcpayKeyPair[],
  options: ParseLogisticsNotificationOptions,
): ParseLogisticsNotificationResult {
  unwrapKeyList(keys);
  if (!isPlainObject(options)) {
    throw new EcpayProtocolError('invalid_input');
  }
  assertMerchantId(options.merchantId);

  const verified = logistics.verify(body, keys);
  if (!verified.ok) {
    return Object.freeze({
      kind: 'invalid' as const,
      reason: verified.reason,
    });
  }

  const { fields, keyIndex } = verified;

  const rawMerchantId = fields.MerchantID;
  if (rawMerchantId === undefined || rawMerchantId === '') {
    return Object.freeze({
      kind: 'invalid' as const,
      reason: 'missing_field' as const,
      field: 'MerchantID',
    });
  }
  if (rawMerchantId !== options.merchantId) {
    return Object.freeze({
      kind: 'invalid' as const,
      reason: 'merchant_mismatch' as const,
    });
  }

  function requireField(
    name: string,
    pattern: RegExp,
  ):
    | { readonly ok: true; readonly value: string }
    | {
        readonly ok: false;
        readonly error: {
          readonly kind: 'invalid';
          readonly reason: 'missing_field' | 'invalid_field';
          readonly field: string;
        };
      } {
    const raw = fields[name];
    if (raw === undefined || raw === '') {
      return {
        ok: false,
        error: Object.freeze({
          kind: 'invalid' as const,
          reason: 'missing_field' as const,
          field: name,
        }),
      };
    }
    if (!pattern.test(raw)) {
      return {
        ok: false,
        error: Object.freeze({
          kind: 'invalid' as const,
          reason: 'invalid_field' as const,
          field: name,
        }),
      };
    }
    return { ok: true, value: raw };
  }

  const merchantTradeNoCheck = requireField(
    'MerchantTradeNo',
    ALPHANUMERIC_ID_PATTERN,
  );
  if (!merchantTradeNoCheck.ok) return merchantTradeNoCheck.error;

  const allPayLogisticsIdCheck = requireField(
    'AllPayLogisticsID',
    LOGISTICS_ID_PATTERN,
  );
  if (!allPayLogisticsIdCheck.ok) return allPayLogisticsIdCheck.error;

  const rtnCodeCheck = requireField('RtnCode', RTN_CODE_PATTERN);
  if (!rtnCodeCheck.ok) return rtnCodeCheck.error;

  const logisticsSubTypeCheck = requireField(
    'LogisticsSubType',
    ALPHANUMERIC_ID_PATTERN,
  );
  if (!logisticsSubTypeCheck.ok) return logisticsSubTypeCheck.error;

  const goodsAmountCheck = requireField('GoodsAmount', GOODS_AMOUNT_PATTERN);
  if (!goodsAmountCheck.ok) return goodsAmountCheck.error;

  const updateStatusDateCheck = requireField(
    'UpdateStatusDate',
    UPDATE_STATUS_DATE_PATTERN,
  );
  if (!updateStatusDateCheck.ok) return updateStatusDateCheck.error;

  const merchantTradeNo = merchantTradeNoCheck.value.toUpperCase();
  const allPayLogisticsId = allPayLogisticsIdCheck.value;
  const rtnCode = rtnCodeCheck.value;
  const logisticsSubType = logisticsSubTypeCheck.value.toUpperCase();
  const subType: EcpayLogisticsSubType | null = isLogisticsSubType(
    logisticsSubType,
  )
    ? logisticsSubType
    : null;
  const goodsAmountMinor = Number(goodsAmountCheck.value) * MINOR_PER_TWD;
  const updateStatusDate = updateStatusDateCheck.value;
  const updateStatusEpochMs = parseTaipeiDateTime(updateStatusDate);
  const rtnMsg = sanitizeMessage(fields.RtnMsg ?? '');
  const bodySha256 = bodySha256Hex(body);

  const dedupe: LogisticsNotificationDedupeKey = Object.freeze({
    allPayLogisticsId,
    rtnCode,
    updateStatusDate,
  });

  return Object.freeze({
    kind: 'notification' as const,
    keyIndex,
    merchantTradeNo,
    allPayLogisticsId,
    rtnCode,
    rtnMsg,
    logisticsSubType,
    subType,
    goodsAmountMinor,
    updateStatusDate,
    updateStatusEpochMs,
    dedupe,
    bodySha256,
  });
}
