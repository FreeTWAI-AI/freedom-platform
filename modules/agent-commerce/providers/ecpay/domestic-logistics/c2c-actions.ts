import { assertFieldsCdnSafe } from '../cdn-guard.js';
import { EcpayProtocolError } from '../errors.js';
import {
  assertEnvironment,
  assertMerchantId,
  isPlainObject,
} from '../field-rules.js';
import { parsePipeResponse, type FormFields } from '../form.js';
import { ECPAY_ORIGINS, type EcpayEnvironment } from '../index.js';
import { unwrapKeyPair, type EcpayKeyPair } from '../keys.js';
import { logistics } from '../logistics.js';
import {
  createServerRequest,
  type EcpayServerRequest,
} from '../server-request.js';
import {
  assertAllPayLogisticsId,
  assertCvsPaymentNo,
  assertCvsValidationNo,
  assertStoreId,
} from './party-rules.js';
import {
  ECPAY_LOGISTICS_SUBTYPES,
  assertCvsSubType,
  assertLogisticsSubType,
  type EcpayCvsSubType,
  type EcpayLogisticsSubType,
} from './profile.js';

export interface CancelC2COrderInput {
  readonly environment: EcpayEnvironment;
  readonly merchantId: string;
  readonly subType: EcpayLogisticsSubType;
  readonly allPayLogisticsId: string;
  readonly cvsPaymentNo: string;
  readonly cvsValidationNo: string;
}

export interface UpdateStoreInput {
  readonly environment: EcpayEnvironment;
  readonly merchantId: string;
  readonly subType: EcpayCvsSubType;
  readonly allPayLogisticsId: string;
  readonly cvsPaymentNo: string;
  readonly cvsValidationNo?: string;
  readonly receiverStoreId: string;
}

export type LogisticsAckUnknownReason = 'unparseable' | 'unexpected_response';

export type LogisticsAckResponseResult =
  | { readonly kind: 'ok' }
  | { readonly kind: 'rejected'; readonly message: string }
  | { readonly kind: 'unknown'; readonly reason: LogisticsAckUnknownReason };

export function buildCancelC2COrderRequest(
  input: CancelC2COrderInput,
  keys: EcpayKeyPair,
): EcpayServerRequest {
  unwrapKeyPair(keys);
  if (!isPlainObject(input)) {
    throw new EcpayProtocolError('invalid_input');
  }
  assertEnvironment(input.environment);
  assertMerchantId(input.merchantId);
  assertLogisticsSubType(input.subType);
  if (!ECPAY_LOGISTICS_SUBTYPES[input.subType].supportsCancel) {
    throw new EcpayProtocolError('invalid_input');
  }
  assertAllPayLogisticsId(input.allPayLogisticsId);
  assertCvsPaymentNo(input.cvsPaymentNo);
  assertCvsValidationNo(input.cvsValidationNo);

  const unsignedFields: FormFields = [
    ['MerchantID', input.merchantId],
    ['AllPayLogisticsID', input.allPayLogisticsId],
    ['CVSPaymentNo', input.cvsPaymentNo],
    ['CVSValidationNo', input.cvsValidationNo],
  ];

  assertFieldsCdnSafe(unsignedFields);
  const signedFields = logistics.sign(unsignedFields, keys);
  const url = `${ECPAY_ORIGINS.logistics[input.environment]}/Express/CancelC2COrder`;
  return createServerRequest(url, signedFields);
}

export function buildUpdateStoreRequest(
  input: UpdateStoreInput,
  keys: EcpayKeyPair,
): EcpayServerRequest {
  unwrapKeyPair(keys);
  if (!isPlainObject(input)) {
    throw new EcpayProtocolError('invalid_input');
  }
  assertEnvironment(input.environment);
  assertMerchantId(input.merchantId);
  assertCvsSubType(input.subType);
  if (!ECPAY_LOGISTICS_SUBTYPES[input.subType].supportsStoreUpdate) {
    throw new EcpayProtocolError('invalid_input');
  }
  assertAllPayLogisticsId(input.allPayLogisticsId);
  assertCvsPaymentNo(input.cvsPaymentNo);
  assertStoreId(input.receiverStoreId);

  const unsignedFields: Array<readonly [string, string]> = [
    ['MerchantID', input.merchantId],
    ['AllPayLogisticsID', input.allPayLogisticsId],
    ['CVSPaymentNo', input.cvsPaymentNo],
  ];

  if (input.subType === 'UNIMARTC2C') {
    assertCvsValidationNo(input.cvsValidationNo);
    unsignedFields.push(['CVSValidationNo', input.cvsValidationNo]);
  } else if (
    input.cvsValidationNo !== undefined &&
    input.cvsValidationNo !== null
  ) {
    throw new EcpayProtocolError('invalid_input');
  }

  unsignedFields.push(['StoreType', '01']);
  unsignedFields.push(['ReceiverStoreID', input.receiverStoreId]);

  const fieldsToSign: FormFields = unsignedFields;
  assertFieldsCdnSafe(fieldsToSign);
  const signedFields = logistics.sign(fieldsToSign, keys);
  const url = `${ECPAY_ORIGINS.logistics[input.environment]}/Express/UpdateStoreInfo`;
  return createServerRequest(url, signedFields);
}

export function parseLogisticsAckResponse(
  text: string,
): LogisticsAckResponseResult {
  const piped = parsePipeResponse(text);
  if (piped.kind === 'error') {
    return Object.freeze({
      kind: 'rejected' as const,
      message: piped.message,
    });
  }
  if (piped.kind === 'ok') {
    if (piped.rest === 'OK') {
      return Object.freeze({ kind: 'ok' as const });
    }
    return Object.freeze({
      kind: 'unknown' as const,
      reason: 'unexpected_response' as const,
    });
  }
  return Object.freeze({
    kind: 'unknown' as const,
    reason: 'unparseable' as const,
  });
}
