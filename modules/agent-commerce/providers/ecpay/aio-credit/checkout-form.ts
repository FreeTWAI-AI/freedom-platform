import { aio } from '../aio.js';
import { assertFieldsCdnSafe, findCdnBlockedTerm } from '../cdn-guard.js';
import { EcpayProtocolError } from '../errors.js';
import {
  MINOR_PER_TWD,
  assertEnvironment,
  assertMerchantId,
  assertValidEcpayHttpsUrl,
  isPlainObject,
} from '../field-rules.js';
import type { FormFields } from '../form.js';
import { ECPAY_ORIGINS, type EcpayEnvironment } from '../index.js';
import { unwrapKeyPair, type EcpayKeyPair } from '../keys.js';
import { formatTaipeiDateTime } from '../taipei-time.js';
import { isTradeNumber } from '../trade-number.js';
import { MAX_CREDIT_AMOUNT_MINOR, MIN_CREDIT_TOTAL_MINOR } from './profile.js';

const LONE_SURROGATE_GLOBAL =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
const FORBIDDEN_ITEM_CHARS =
  /[#<>|;\u0060\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/gu;
const WHITESPACE_RUN = /\s+/gu;

const MAX_ITEM_LINES = 200;
const MIN_ITEM_QUANTITY = 1;
const MAX_ITEM_QUANTITY = 9999;
const MAX_ITEM_NAME_UTF16_UNITS = 200;
const MAX_STORE_NAME_CODE_POINTS = 40;

const DISPLAY_NUMBER_PATTERN = /^[0-9]{6}-[0-9A-HJKMNP-TV-Z]{6}$/;

export interface CreditCheckoutLineItem {
  readonly name: string;
  readonly quantity: number;
}

export interface CreditCheckoutFormInput {
  readonly environment: EcpayEnvironment;
  readonly merchantId: string;
  readonly merchantTradeNo: string;
  readonly createdAtEpochMs: number;
  readonly currency: string;
  readonly totalMinor: number;
  readonly lines: readonly CreditCheckoutLineItem[];
  readonly storeName: string;
  readonly displayNumber: string;
  readonly returnUrl: string;
  readonly orderResultUrl: string;
  readonly clientBackUrl: string;
}

export interface CreditCheckoutForm {
  readonly action: string;
  readonly fields: FormFields;
}

function sanitizeItemFragment(raw: string): string {
  return raw
    .replace(LONE_SURROGATE_GLOBAL, ' ')
    .replace(FORBIDDEN_ITEM_CHARS, ' ')
    .replace(WHITESPACE_RUN, ' ')
    .trim();
}

export function buildItemName(
  lines: readonly CreditCheckoutLineItem[],
  storeName: string,
): string {
  if (!Array.isArray(lines) || lines.length < 1 || lines.length > MAX_ITEM_LINES) {
    throw new EcpayProtocolError('invalid_input');
  }
  if (typeof storeName !== 'string') {
    throw new EcpayProtocolError('invalid_input');
  }

  const formattedLines: string[] = [];
  for (const line of lines) {
    if (!isPlainObject(line) || typeof line.name !== 'string') {
      throw new EcpayProtocolError('invalid_input');
    }
    if (
      typeof line.quantity !== 'number' ||
      !Number.isSafeInteger(line.quantity) ||
      line.quantity < MIN_ITEM_QUANTITY ||
      line.quantity > MAX_ITEM_QUANTITY
    ) {
      throw new EcpayProtocolError('invalid_input');
    }
    const cleanedName = sanitizeItemFragment(line.name);
    const effectiveName = cleanedName.length > 0 ? cleanedName : '商品';
    formattedLines.push(`${effectiveName} x${line.quantity}`);
  }

  const joined = formattedLines.join('#');
  if (joined.length <= MAX_ITEM_NAME_UTF16_UNITS && findCdnBlockedTerm(joined) === null) {
    return joined;
  }

  const cleanedStore = sanitizeItemFragment(storeName);
  const storeCodePoints = Array.from(cleanedStore);
  const truncatedStore =
    storeCodePoints.length > MAX_STORE_NAME_CODE_POINTS
      ? storeCodePoints.slice(0, MAX_STORE_NAME_CODE_POINTS).join('')
      : cleanedStore;
  const safeStore = findCdnBlockedTerm(truncatedStore) === null ? truncatedStore : '';
  return `${safeStore}商品一批 x1`;
}

export function buildCreditCheckoutForm(
  input: CreditCheckoutFormInput,
  keys: EcpayKeyPair,
): CreditCheckoutForm {
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

  const merchantTradeDate = formatTaipeiDateTime(input.createdAtEpochMs);

  if (input.currency !== 'TWD') {
    throw new EcpayProtocolError('invalid_input');
  }

  if (
    typeof input.totalMinor !== 'number' ||
    !Number.isSafeInteger(input.totalMinor) ||
    input.totalMinor < MIN_CREDIT_TOTAL_MINOR ||
    input.totalMinor % MINOR_PER_TWD !== 0 ||
    input.totalMinor > MAX_CREDIT_AMOUNT_MINOR
  ) {
    throw new EcpayProtocolError('invalid_input');
  }

  if (
    typeof input.displayNumber !== 'string' ||
    !DISPLAY_NUMBER_PATTERN.test(input.displayNumber)
  ) {
    throw new EcpayProtocolError('invalid_input');
  }

  const itemName = buildItemName(input.lines, input.storeName);

  assertValidEcpayHttpsUrl(input.returnUrl);
  assertValidEcpayHttpsUrl(input.orderResultUrl);
  assertValidEcpayHttpsUrl(input.clientBackUrl);

  const totalAmount = String(input.totalMinor / MINOR_PER_TWD);
  const tradeDesc =
    findCdnBlockedTerm(input.displayNumber) === null
      ? `Freedom order ${input.displayNumber}`
      : 'Freedom order';

  const unsignedFields: FormFields = [
    ['MerchantID', input.merchantId],
    ['MerchantTradeNo', input.merchantTradeNo],
    ['MerchantTradeDate', merchantTradeDate],
    ['PaymentType', 'aio'],
    ['TotalAmount', totalAmount],
    ['TradeDesc', tradeDesc],
    ['ItemName', itemName],
    ['ReturnURL', input.returnUrl],
    ['ChoosePayment', 'Credit'],
    ['EncryptType', '1'],
    ['ClientBackURL', input.clientBackUrl],
    ['OrderResultURL', input.orderResultUrl],
    ['NeedExtraPaidInfo', 'Y'],
  ];

  assertFieldsCdnSafe(unsignedFields);

  const signedFields = aio.sign(unsignedFields, keys);
  const action = `${ECPAY_ORIGINS.payment[input.environment]}/Cashier/AioCheckOut/V5`;

  return Object.freeze({
    action,
    fields: signedFields,
  });
}
