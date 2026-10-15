import { EcpayProtocolError } from '../errors.js';
import {
  MINOR_PER_TWD,
  assertEnvironment,
  assertMerchantId,
  assertPositiveWholeTwdMinor,
  assertValidEcpayHttpsUrl,
  isPlainObject,
} from '../field-rules.js';
import type { EcpayEnvironment } from '../index.js';
import { unwrapKeyPair, type EcpayKeyPair } from '../keys.js';
import { parseTaipeiDateTime } from '../taipei-time.js';
import { isTradeNumber } from '../trade-number.js';

const LONE_SURROGATE_PATTERN =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const CONTROL_CHAR_PATTERN = /[\u0000-\u001f\u007f-\u009f]/;

export const INVOICE_NO_PATTERN = /^[A-Z]{2}[0-9]{8}$/;
export const ALLOWANCE_NO_PATTERN = /^[0-9]{16}$/;
export const RANDOM_NUMBER_PATTERN = /^[0-9]{4}$/;
export const MOBILE_BARCODE_PATTERN = /^\/[0-9A-Z+\-.]{7}$/;
export const CITIZEN_CERT_PATTERN = /^[A-Z]{2}[0-9]{14}$/;
export const LOVE_CODE_PATTERN = /^[0-9]{3,7}$/;
export const UBN_PATTERN = /^[0-9]{8}$/;
export const ROC_YEAR_PATTERN = /^[0-9]{3}$/;
export const TRACK_ID_PATTERN = /^[0-9A-Za-z]{1,10}$/;
export const TRACK_HEADER_PATTERN = /^[A-Z]{2}$/;
export const TRACK_NUMBER_PATTERN = /^[0-9]{8}$/;

const REQUEST_DATE_PATTERN = /^20[0-9]{2}-[0-9]{2}-[0-9]{2}$/;
const REQUEST_DATETIME_PATTERN =
  /^20[0-9]{2}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}$/;
const RESPONSE_DATETIME_PATTERN =
  /^(20[0-9]{2})([-/])([0-9]{2})\2([0-9]{2}) ([0-9]{2}:[0-9]{2}:[0-9]{2})$/;

const MAX_INVOICE_EMAIL_LENGTH = 80;
const INVOICE_EMAIL_PATTERN =
  /^[A-Za-z0-9!#$%&*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&*+/=?^_`{|}~-]+)*@(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)+[A-Za-z](?:[A-Za-z0-9-]*[A-Za-z])?$/;

const MIN_ITEMS_COUNT = 1;
const MAX_ITEMS_COUNT = 200;
const MIN_ITEM_COUNT = 1;
const MAX_ITEM_COUNT = 99;

const ALLOWED_ITEM_KEYS = new Set([
  'name',
  'count',
  'priceMinor',
  'amountMinor',
]);

export interface InvoiceRequestContext {
  readonly environment: EcpayEnvironment;
  readonly merchantId: string;
  readonly timestampSeconds: number;
}

export type EcpayInvoiceBuyer =
  | { readonly type: 'member_carrier' }
  | { readonly type: 'mobile_barcode'; readonly barcode: string }
  | { readonly type: 'citizen_cert'; readonly certificate: string }
  | { readonly type: 'donation'; readonly loveCode: string }
  | {
      readonly type: 'company';
      readonly ubn: string;
      readonly title: string;
      readonly barcode?: string;
    };

export interface EcpayInvoiceItemInput {
  readonly name: string;
  readonly count: number;
  readonly priceMinor: number;
  readonly amountMinor: number;
}

export interface EcpaySerializedInvoiceItem {
  readonly ItemSeq: number;
  readonly ItemName: string;
  readonly ItemCount: number;
  readonly ItemWord: string;
  readonly ItemPrice: number;
  readonly ItemAmount: number;
}

export interface ResolvedBuyerFields {
  readonly CustomerIdentifier: string;
  readonly CustomerName: string;
  readonly Print: '0';
  readonly Donation: '0' | '1';
  readonly LoveCode: string;
  readonly CarrierType: '' | '1' | '2' | '3';
  readonly CarrierNum: string;
}

export interface ParsedInvoiceDateTime {
  readonly text: string;
  readonly epochMs: number;
}

export function isCleanText(
  value: unknown,
  minCodePoints: number,
  maxCodePoints: number,
): value is string {
  if (
    typeof value !== 'string' ||
    LONE_SURROGATE_PATTERN.test(value) ||
    CONTROL_CHAR_PATTERN.test(value) ||
    value !== value.trim()
  ) {
    return false;
  }
  const codePointLength = Array.from(value).length;
  return codePointLength >= minCodePoints && codePointLength <= maxCodePoints;
}

export function assertCleanText(
  value: unknown,
  minCodePoints: number,
  maxCodePoints: number,
): asserts value is string {
  if (!isCleanText(value, minCodePoints, maxCodePoints)) {
    throw new EcpayProtocolError('invalid_input');
  }
}

export function assertRequestContext(
  input: unknown,
  keys: EcpayKeyPair,
): asserts input is Record<string, unknown> & InvoiceRequestContext {
  unwrapKeyPair(keys);
  if (!isPlainObject(input)) {
    throw new EcpayProtocolError('invalid_input');
  }
  assertEnvironment(input.environment);
  assertMerchantId(input.merchantId);
  if (
    typeof input.timestampSeconds !== 'number' ||
    !Number.isSafeInteger(input.timestampSeconds) ||
    input.timestampSeconds <= 0
  ) {
    throw new EcpayProtocolError('invalid_input');
  }
}

export function assertRelateNumber(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !isTradeNumber(value, 'I')) {
    throw new EcpayProtocolError('invalid_input');
  }
}

export function assertInvoiceNo(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !INVOICE_NO_PATTERN.test(value)) {
    throw new EcpayProtocolError('invalid_input');
  }
}

export function assertAllowanceNo(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !ALLOWANCE_NO_PATTERN.test(value)) {
    throw new EcpayProtocolError('invalid_input');
  }
}

export function assertRequestDate(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !REQUEST_DATE_PATTERN.test(value)) {
    throw new EcpayProtocolError('invalid_input');
  }
  const slashDateTime = `${value.replace(/-/g, '/')} 00:00:00`;
  if (parseTaipeiDateTime(slashDateTime) === null) {
    throw new EcpayProtocolError('invalid_input');
  }
}

export function assertRequestDateTime(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !REQUEST_DATETIME_PATTERN.test(value)) {
    throw new EcpayProtocolError('invalid_input');
  }
  const slashDateTime = value.replace(/-/g, '/');
  if (parseTaipeiDateTime(slashDateTime) === null) {
    throw new EcpayProtocolError('invalid_input');
  }
}

export function parseInvoiceDateTime(
  text: unknown,
): ParsedInvoiceDateTime | null {
  if (typeof text !== 'string') {
    return null;
  }
  const match = RESPONSE_DATETIME_PATTERN.exec(text);
  if (!match) {
    return null;
  }
  const year = match[1];
  const month = match[3];
  const day = match[4];
  const time = match[5];
  const slashForm = `${year}/${month}/${day} ${time}`;
  const epochMs = parseTaipeiDateTime(slashForm);
  if (epochMs === null) {
    return null;
  }
  return Object.freeze({
    text: `${year}-${month}-${day} ${time}`,
    epochMs,
  });
}

export function assertReason(value: unknown): asserts value is string {
  assertCleanText(value, 1, 20);
}

export function assertRemark(value: unknown): asserts value is string {
  assertCleanText(value, 1, 200);
}

export function assertItemWord(value: unknown): asserts value is string {
  assertCleanText(value, 1, 6);
}

export function assertCompanyTitle(value: unknown): asserts value is string {
  assertCleanText(value, 1, 60);
}

export function resolveOptionalCompanyTitle(value: unknown): string {
  if (value === null) {
    return '';
  }
  assertCompanyTitle(value);
  return value;
}

export function isInvoiceEmail(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_INVOICE_EMAIL_LENGTH
  ) {
    return false;
  }
  return INVOICE_EMAIL_PATTERN.test(value);
}

export function assertInvoiceEmail(value: unknown): asserts value is string {
  if (!isInvoiceEmail(value)) {
    throw new EcpayProtocolError('invalid_input');
  }
}

export function assertMobileBarcode(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !MOBILE_BARCODE_PATTERN.test(value)) {
    throw new EcpayProtocolError('invalid_input');
  }
}

export function assertCitizenCert(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !CITIZEN_CERT_PATTERN.test(value)) {
    throw new EcpayProtocolError('invalid_input');
  }
}

export function assertLoveCode(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !LOVE_CODE_PATTERN.test(value)) {
    throw new EcpayProtocolError('invalid_input');
  }
}

export function assertUbn(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !UBN_PATTERN.test(value)) {
    throw new EcpayProtocolError('invalid_input');
  }
}

export function assertReturnUrl(value: unknown): asserts value is string {
  assertValidEcpayHttpsUrl(value);
}

function assertStrictObjectKeys(
  record: Record<string, unknown>,
  allowedKeys: readonly string[],
): void {
  const allowedSet = new Set(allowedKeys);
  for (const key of Object.keys(record)) {
    if (!allowedSet.has(key)) {
      throw new EcpayProtocolError('invalid_input');
    }
  }
}

export function resolveBuyerFields(buyer: unknown): ResolvedBuyerFields {
  if (!isPlainObject(buyer)) {
    throw new EcpayProtocolError('invalid_input');
  }

  switch (buyer.type) {
    case 'member_carrier': {
      assertStrictObjectKeys(buyer, ['type']);
      return {
        CustomerIdentifier: '',
        CustomerName: '',
        Print: '0',
        Donation: '0',
        LoveCode: '',
        CarrierType: '1',
        CarrierNum: '',
      };
    }

    case 'mobile_barcode': {
      assertStrictObjectKeys(buyer, ['type', 'barcode']);
      assertMobileBarcode(buyer.barcode);
      return {
        CustomerIdentifier: '',
        CustomerName: '',
        Print: '0',
        Donation: '0',
        LoveCode: '',
        CarrierType: '3',
        CarrierNum: buyer.barcode,
      };
    }

    case 'citizen_cert': {
      assertStrictObjectKeys(buyer, ['type', 'certificate']);
      assertCitizenCert(buyer.certificate);
      return {
        CustomerIdentifier: '',
        CustomerName: '',
        Print: '0',
        Donation: '0',
        LoveCode: '',
        CarrierType: '2',
        CarrierNum: buyer.certificate,
      };
    }

    case 'donation': {
      assertStrictObjectKeys(buyer, ['type', 'loveCode']);
      assertLoveCode(buyer.loveCode);
      return {
        CustomerIdentifier: '',
        CustomerName: '',
        Print: '0',
        Donation: '1',
        LoveCode: buyer.loveCode,
        CarrierType: '',
        CarrierNum: '',
      };
    }

    case 'company': {
      assertStrictObjectKeys(buyer, ['type', 'ubn', 'title', 'barcode']);
      assertUbn(buyer.ubn);
      assertCompanyTitle(buyer.title);
      let carrierType: '1' | '3' = '1';
      let carrierNum = '';
      if (buyer.barcode !== undefined) {
        assertMobileBarcode(buyer.barcode);
        carrierType = '3';
        carrierNum = buyer.barcode;
      }
      return {
        CustomerIdentifier: buyer.ubn,
        CustomerName: buyer.title,
        Print: '0',
        Donation: '0',
        LoveCode: '',
        CarrierType: carrierType,
        CarrierNum: carrierNum,
      };
    }

    default:
      throw new EcpayProtocolError('invalid_input');
  }
}

export function serializeInvoiceItems(
  items: unknown,
  itemWord: unknown,
  totalAmountMinor: unknown,
): {
  readonly totalTwd: number;
  readonly items: readonly EcpaySerializedInvoiceItem[];
} {
  assertPositiveWholeTwdMinor(totalAmountMinor);
  assertItemWord(itemWord);

  if (
    !Array.isArray(items) ||
    items.length < MIN_ITEMS_COUNT ||
    items.length > MAX_ITEMS_COUNT
  ) {
    throw new EcpayProtocolError('invalid_input');
  }

  let sumMinor = 0;
  const serialized: EcpaySerializedInvoiceItem[] = [];

  for (let i = 0; i < items.length; i += 1) {
    const rawItem: unknown = items[i];
    if (!isPlainObject(rawItem)) {
      throw new EcpayProtocolError('invalid_input');
    }
    const keys = Object.keys(rawItem);
    if (keys.length !== ALLOWED_ITEM_KEYS.size) {
      throw new EcpayProtocolError('invalid_input');
    }
    for (const key of keys) {
      if (!ALLOWED_ITEM_KEYS.has(key)) {
        throw new EcpayProtocolError('invalid_input');
      }
    }

    assertCleanText(rawItem.name, 1, 100);
    if (
      typeof rawItem.count !== 'number' ||
      !Number.isSafeInteger(rawItem.count) ||
      rawItem.count < MIN_ITEM_COUNT ||
      rawItem.count > MAX_ITEM_COUNT
    ) {
      throw new EcpayProtocolError('invalid_input');
    }
    assertPositiveWholeTwdMinor(rawItem.priceMinor);
    assertPositiveWholeTwdMinor(rawItem.amountMinor);

    if (rawItem.amountMinor !== rawItem.count * rawItem.priceMinor) {
      throw new EcpayProtocolError('invalid_input');
    }

    sumMinor += rawItem.amountMinor;
    serialized.push({
      ItemSeq: i + 1,
      ItemName: rawItem.name,
      ItemCount: rawItem.count,
      ItemWord: itemWord,
      ItemPrice: rawItem.priceMinor / MINOR_PER_TWD,
      ItemAmount: rawItem.amountMinor / MINOR_PER_TWD,
    });
  }

  if (sumMinor !== totalAmountMinor) {
    throw new EcpayProtocolError('invalid_input');
  }

  return {
    totalTwd: totalAmountMinor / MINOR_PER_TWD,
    items: serialized,
  };
}
