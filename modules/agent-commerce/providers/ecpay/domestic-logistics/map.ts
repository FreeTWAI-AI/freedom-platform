import {
  createBrowserForm,
  type EcpayBrowserForm,
} from '../browser-form.js';
import { assertFieldsCdnSafe } from '../cdn-guard.js';
import { sanitizeMessage } from '../encoding.js';
import { EcpayProtocolError, type EcpayErrorCode } from '../errors.js';
import {
  assertEnvironment,
  assertMerchantId,
  assertValidEcpayHttpsUrl,
  isPlainObject,
} from '../field-rules.js';
import { parseForm, type FormFields } from '../form.js';
import { ECPAY_ORIGINS, type EcpayEnvironment } from '../index.js';
import { STORE_ID_PATTERN } from './party-rules.js';
import { assertCvsSubType, type EcpayCvsSubType } from './profile.js';

const EXTRA_DATA_PATTERN = /^[0-9A-Za-z]{1,20}$/;
const MAX_STORE_NAME_CODE_POINTS = 10;
const MAX_STORE_ADDRESS_CODE_POINTS = 60;

export type CvsMapDevice = 'desktop' | 'mobile';

const DEVICE_CODES: Readonly<Record<CvsMapDevice, string>> = Object.freeze({
  desktop: '0',
  mobile: '1',
});

export interface CvsMapFormInput {
  readonly environment: EcpayEnvironment;
  readonly merchantId: string;
  readonly subType: EcpayCvsSubType;
  readonly serverReplyUrl: string;
  readonly extraData: string;
  readonly device: CvsMapDevice;
}

export interface ParseCvsMapReturnOptions {
  readonly merchantId: string;
  readonly subType: EcpayCvsSubType;
}

export type CvsMapReturnInvalidReason =
  | EcpayErrorCode
  | 'merchant_mismatch'
  | 'subtype_mismatch'
  | 'missing_field'
  | 'invalid_field';

export type ParseCvsMapReturnResult =
  | {
      readonly kind: 'store';
      readonly subType: EcpayCvsSubType;
      readonly storeId: string;
      readonly storeName: string;
      readonly storeAddress: string;
      readonly outside: '0' | '1' | null;
      readonly extraData: string;
      readonly ignoredFields: readonly string[];
    }
  | {
      readonly kind: 'invalid';
      readonly reason: CvsMapReturnInvalidReason;
      readonly field?: string;
    };

export function buildCvsMapForm(input: CvsMapFormInput): EcpayBrowserForm {
  if (!isPlainObject(input)) {
    throw new EcpayProtocolError('invalid_input');
  }
  assertEnvironment(input.environment);
  assertMerchantId(input.merchantId);
  assertCvsSubType(input.subType);
  assertValidEcpayHttpsUrl(input.serverReplyUrl);

  if (
    typeof input.extraData !== 'string' ||
    !EXTRA_DATA_PATTERN.test(input.extraData)
  ) {
    throw new EcpayProtocolError('invalid_input');
  }

  if (
    typeof input.device !== 'string' ||
    !Object.prototype.hasOwnProperty.call(DEVICE_CODES, input.device)
  ) {
    throw new EcpayProtocolError('invalid_input');
  }

  const fields: FormFields = [
    ['MerchantID', input.merchantId],
    ['LogisticsType', 'CVS'],
    ['LogisticsSubType', input.subType],
    ['IsCollection', 'N'],
    ['ServerReplyURL', input.serverReplyUrl],
    ['ExtraData', input.extraData],
    ['Device', DEVICE_CODES[input.device]],
  ];

  assertFieldsCdnSafe(fields);
  const action = `${ECPAY_ORIGINS.logistics[input.environment]}/Express/map`;
  return createBrowserForm(action, fields);
}

export function parseCvsMapReturn(
  body: string | Uint8Array,
  options: ParseCvsMapReturnOptions,
): ParseCvsMapReturnResult {
  if (!isPlainObject(options)) {
    throw new EcpayProtocolError('invalid_input');
  }
  assertMerchantId(options.merchantId);
  assertCvsSubType(options.subType);

  let parsed: FormFields;
  try {
    parsed = parseForm(body);
  } catch (err) {
    if (err instanceof EcpayProtocolError) {
      return Object.freeze({
        kind: 'invalid' as const,
        reason: err.code,
      });
    }
    throw err;
  }

  const fields: Record<string, string> = Object.create(null);
  for (const [key, value] of parsed) {
    fields[key] = value;
  }

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

  const rawSubType = fields.LogisticsSubType;
  if (rawSubType === undefined || rawSubType === '') {
    return Object.freeze({
      kind: 'invalid' as const,
      reason: 'missing_field' as const,
      field: 'LogisticsSubType',
    });
  }
  if (rawSubType.toUpperCase() !== options.subType) {
    return Object.freeze({
      kind: 'invalid' as const,
      reason: 'subtype_mismatch' as const,
    });
  }

  const rawStoreId = fields.CVSStoreID;
  if (rawStoreId === undefined || rawStoreId === '') {
    return Object.freeze({
      kind: 'invalid' as const,
      reason: 'missing_field' as const,
      field: 'CVSStoreID',
    });
  }
  if (!STORE_ID_PATTERN.test(rawStoreId)) {
    return Object.freeze({
      kind: 'invalid' as const,
      reason: 'invalid_field' as const,
      field: 'CVSStoreID',
    });
  }

  const rawStoreName = fields.CVSStoreName;
  if (rawStoreName === undefined || rawStoreName === '') {
    return Object.freeze({
      kind: 'invalid' as const,
      reason: 'missing_field' as const,
      field: 'CVSStoreName',
    });
  }
  const storeName = sanitizeMessage(
    rawStoreName.trim(),
    MAX_STORE_NAME_CODE_POINTS,
  ).trim();
  if (storeName === '') {
    return Object.freeze({
      kind: 'invalid' as const,
      reason: 'invalid_field' as const,
      field: 'CVSStoreName',
    });
  }

  const rawStoreAddress = fields.CVSAddress;
  if (rawStoreAddress === undefined || rawStoreAddress === '') {
    return Object.freeze({
      kind: 'invalid' as const,
      reason: 'missing_field' as const,
      field: 'CVSAddress',
    });
  }
  const storeAddress = sanitizeMessage(
    rawStoreAddress.trim(),
    MAX_STORE_ADDRESS_CODE_POINTS,
  ).trim();
  if (storeAddress === '') {
    return Object.freeze({
      kind: 'invalid' as const,
      reason: 'invalid_field' as const,
      field: 'CVSAddress',
    });
  }

  const rawExtraData = fields.ExtraData;
  if (rawExtraData === undefined || rawExtraData === '') {
    return Object.freeze({
      kind: 'invalid' as const,
      reason: 'missing_field' as const,
      field: 'ExtraData',
    });
  }
  if (!EXTRA_DATA_PATTERN.test(rawExtraData)) {
    return Object.freeze({
      kind: 'invalid' as const,
      reason: 'invalid_field' as const,
      field: 'ExtraData',
    });
  }

  const ignoredFields: string[] = [];
  let outside: '0' | '1' | null = null;
  const rawOutside = fields.CVSOutSide;
  if (rawOutside !== undefined && rawOutside !== '') {
    if (rawOutside === '0' || rawOutside === '1') {
      outside = rawOutside;
    } else {
      ignoredFields.push('CVSOutSide');
    }
  }

  return Object.freeze({
    kind: 'store' as const,
    subType: options.subType,
    storeId: rawStoreId,
    storeName,
    storeAddress,
    outside,
    extraData: rawExtraData,
    ignoredFields: Object.freeze(ignoredFields),
  });
}
