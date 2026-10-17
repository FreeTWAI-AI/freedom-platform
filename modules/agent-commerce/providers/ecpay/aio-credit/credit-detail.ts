import { aio } from '../aio.js';
import { assertFieldsCdnSafe } from '../cdn-guard.js';
import { sanitizeMessage } from '../encoding.js';
import { EcpayProtocolError } from '../errors.js';
import {
  MINOR_PER_TWD,
  assertMerchantId,
  isPlainObject,
} from '../field-rules.js';
import type { FormFields } from '../form.js';
import { ECPAY_ORIGINS, type EcpayEnvironment } from '../index.js';
import { unwrapKeyPair, type EcpayKeyPair } from '../keys.js';
import { createServerRequest, type EcpayServerRequest } from '../server-request.js';
import { MAX_CREDIT_AMOUNT_MINOR, assertCreditAmountMinor } from './profile.js';

const CHECK_CODE_PATTERN = /^[0-9]{8}$/;
const GWSR_PATTERN = /^[0-9]{1,20}$/;
const DIGIT_AMOUNT_PATTERN = /^[0-9]{1,9}$/;
const MAX_AMOUNT_TWD = MAX_CREDIT_AMOUNT_MINOR / MINOR_PER_TWD;
const MAX_RESPONSE_CHARS = 65_536;
const MAX_SHORT_FIELD_CODE_POINTS = 40;

const INSPECT_CUSTOM = Symbol.for('nodejs.util.inspect.custom');
const PRIVATE_CHECK_CODE_TOKEN = Symbol('EcpayCreditCheckCode');

const checkCodeStore = new WeakMap<EcpayCreditCheckCode, string>();

export type CreditSettlementStatus =
  | 'unauthorized'
  | 'authorized'
  | 'capture_pending'
  | 'captured'
  | 'capture_cancelled'
  | 'voided';

export type CreditCloseDataStatus =
  | 'capture_pending'
  | 'captured'
  | 'capture_cancelled'
  | 'voided';

export interface CreditCloseDataEntry {
  readonly status: CreditCloseDataStatus;
  readonly sno: string | null;
  readonly amountMinor: number;
  readonly datetime: string | null;
}

export interface CreditDetailQueryInput {
  readonly environment: EcpayEnvironment;
  readonly merchantId: string;
  readonly gwsr: string;
  readonly amountMinor: number;
}

export interface ParseCreditDetailResponseOptions {
  readonly expectedAmountMinor: number;
}

export type CreditDetailUnknownReason =
  | 'too_large'
  | 'invalid_json'
  | 'not_an_object'
  | 'invalid_field'
  | 'amount_mismatch'
  | 'unrecognized_status';

export type CreditDetailResponseResult =
  | {
      readonly kind: 'detail';
      readonly tradeId: string | null;
      readonly authorisedMinor: number;
      readonly capturedMinor: number;
      readonly status: CreditSettlementStatus;
      readonly authTime: string | null;
      readonly closeData: readonly CreditCloseDataEntry[];
    }
  | {
      readonly kind: 'error';
      readonly message: string;
    }
  | {
      readonly kind: 'unknown';
      readonly reason: CreditDetailUnknownReason;
    };

const CREDIT_DETAIL_STATUS_MAP: Readonly<Record<string, CreditSettlementStatus>> =
  Object.freeze({
    未授權: 'unauthorized',
    已授權: 'authorized',
    要關帳: 'capture_pending',
    已關帳: 'captured',
    操作取消: 'capture_cancelled',
    已取消: 'voided',
  });

const CLOSE_DATA_STATUS_MAP: Readonly<Record<string, CreditCloseDataStatus>> =
  Object.freeze({
    要關帳: 'capture_pending',
    已關帳: 'captured',
    操作取消: 'capture_cancelled',
    已取消: 'voided',
  });

export class EcpayCreditCheckCode {
  private constructor(token: symbol) {
    if (token !== PRIVATE_CHECK_CODE_TOKEN) {
      throw new EcpayProtocolError('invalid_check_code');
    }
    Object.freeze(this);
  }

  static of(value: string): EcpayCreditCheckCode {
    if (typeof value !== 'string' || !CHECK_CODE_PATTERN.test(value)) {
      throw new EcpayProtocolError('invalid_check_code');
    }
    const instance = new EcpayCreditCheckCode(PRIVATE_CHECK_CODE_TOKEN);
    checkCodeStore.set(instance, value);
    return instance;
  }

  toJSON(): string {
    return '[redacted]';
  }

  toString(): string {
    return '[redacted]';
  }

  [INSPECT_CUSTOM](): string {
    return 'EcpayCreditCheckCode [redacted]';
  }
}

Object.freeze(EcpayCreditCheckCode);
Object.freeze(EcpayCreditCheckCode.prototype);

export function unwrapCreditCheckCode(checkCode: unknown): string {
  if (!(checkCode instanceof EcpayCreditCheckCode)) {
    throw new EcpayProtocolError('invalid_check_code');
  }
  const value = checkCodeStore.get(checkCode);
  if (!value) {
    throw new EcpayProtocolError('invalid_check_code');
  }
  return value;
}

export function buildCreditDetailQuery(
  input: CreditDetailQueryInput,
  keys: EcpayKeyPair,
  checkCode: EcpayCreditCheckCode,
): EcpayServerRequest {
  unwrapKeyPair(keys);
  const rawCheckCode = unwrapCreditCheckCode(checkCode);

  if (!isPlainObject(input)) {
    throw new EcpayProtocolError('invalid_input');
  }
  if (input.environment !== 'live') {
    throw new EcpayProtocolError('unsupported_environment');
  }
  assertMerchantId(input.merchantId);

  if (typeof input.gwsr !== 'string' || !GWSR_PATTERN.test(input.gwsr)) {
    throw new EcpayProtocolError('invalid_input');
  }

  assertCreditAmountMinor(input.amountMinor);

  const unsignedFields: FormFields = [
    ['MerchantID', input.merchantId],
    ['CreditRefundId', input.gwsr],
    ['CreditAmount', String(input.amountMinor / MINOR_PER_TWD)],
    ['CreditCheckCode', rawCheckCode],
  ];
  assertFieldsCdnSafe(unsignedFields);

  const signedFields = aio.sign(unsignedFields, keys);

  const url = `${ECPAY_ORIGINS.payment.live}/CreditDetail/QueryTrade/V2`;
  return createServerRequest(url, signedFields);
}

function parseCreditDetailAmountMinor(raw: unknown): number | null {
  if (typeof raw === 'string') {
    if (!DIGIT_AMOUNT_PATTERN.test(raw)) {
      return null;
    }
    return Number(raw) * MINOR_PER_TWD;
  }
  if (typeof raw === 'number') {
    if (!Number.isSafeInteger(raw) || raw < 0 || raw > MAX_AMOUNT_TWD) {
      return null;
    }
    return raw * MINOR_PER_TWD;
  }
  return null;
}

function parseOptionalShortText(
  raw: unknown,
): { readonly ok: true; readonly value: string | null } | { readonly ok: false } {
  if (raw === undefined || raw === null) {
    return { ok: true, value: null };
  }
  if (typeof raw === 'string') {
    const cleaned = sanitizeMessage(raw, MAX_SHORT_FIELD_CODE_POINTS);
    return { ok: true, value: cleaned.length > 0 ? cleaned : null };
  }
  if (typeof raw === 'number' && Number.isSafeInteger(raw)) {
    const cleaned = sanitizeMessage(String(raw), MAX_SHORT_FIELD_CODE_POINTS);
    return { ok: true, value: cleaned.length > 0 ? cleaned : null };
  }
  return { ok: false };
}

export function parseCreditDetailResponse(
  text: string,
  options: ParseCreditDetailResponseOptions,
): CreditDetailResponseResult {
  if (!isPlainObject(options)) {
    throw new EcpayProtocolError('invalid_input');
  }
  assertCreditAmountMinor(options.expectedAmountMinor);

  if (typeof text !== 'string') {
    return Object.freeze({
      kind: 'unknown' as const,
      reason: 'invalid_json' as const,
    });
  }
  if (text.length > MAX_RESPONSE_CHARS) {
    return Object.freeze({
      kind: 'unknown' as const,
      reason: 'too_large' as const,
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return Object.freeze({
      kind: 'unknown' as const,
      reason: 'invalid_json' as const,
    });
  }

  if (!isPlainObject(parsed)) {
    return Object.freeze({
      kind: 'unknown' as const,
      reason: 'not_an_object' as const,
    });
  }

  if (typeof parsed.RtnMsg === 'string' && parsed.RtnMsg.length > 0) {
    return Object.freeze({
      kind: 'error' as const,
      message: sanitizeMessage(parsed.RtnMsg),
    });
  }
  if (parsed.RtnMsg !== undefined && parsed.RtnMsg !== '') {
    return Object.freeze({
      kind: 'unknown' as const,
      reason: 'invalid_field' as const,
    });
  }

  if (!isPlainObject(parsed.RtnValue)) {
    return Object.freeze({
      kind: 'unknown' as const,
      reason: 'not_an_object' as const,
    });
  }

  const rtnValue = parsed.RtnValue;

  const authorisedMinor = parseCreditDetailAmountMinor(rtnValue.amount);
  if (authorisedMinor === null) {
    return Object.freeze({
      kind: 'unknown' as const,
      reason: 'invalid_field' as const,
    });
  }

  const capturedMinor = parseCreditDetailAmountMinor(rtnValue.clsamt);
  if (capturedMinor === null) {
    return Object.freeze({
      kind: 'unknown' as const,
      reason: 'invalid_field' as const,
    });
  }

  if (authorisedMinor !== options.expectedAmountMinor) {
    return Object.freeze({
      kind: 'unknown' as const,
      reason: 'amount_mismatch' as const,
    });
  }

  const rawStatus = rtnValue.status;
  if (
    typeof rawStatus !== 'string' ||
    !Object.prototype.hasOwnProperty.call(CREDIT_DETAIL_STATUS_MAP, rawStatus)
  ) {
    return Object.freeze({
      kind: 'unknown' as const,
      reason: 'unrecognized_status' as const,
    });
  }
  const status = CREDIT_DETAIL_STATUS_MAP[rawStatus];

  const tradeIdParsed = parseOptionalShortText(rtnValue.TradeID);
  if (!tradeIdParsed.ok) {
    return Object.freeze({
      kind: 'unknown' as const,
      reason: 'invalid_field' as const,
    });
  }

  const authTimeParsed = parseOptionalShortText(rtnValue.authtime);
  if (!authTimeParsed.ok) {
    return Object.freeze({
      kind: 'unknown' as const,
      reason: 'invalid_field' as const,
    });
  }

  const rawCloseData = rtnValue.close_data === undefined ? [] : rtnValue.close_data;
  if (!Array.isArray(rawCloseData)) {
    return Object.freeze({
      kind: 'unknown' as const,
      reason: 'invalid_field' as const,
    });
  }

  const closeData: CreditCloseDataEntry[] = [];
  for (const item of rawCloseData) {
    if (!isPlainObject(item)) {
      return Object.freeze({
        kind: 'unknown' as const,
        reason: 'invalid_field' as const,
      });
    }

    const rawItemStatus = item.status;
    if (
      typeof rawItemStatus !== 'string' ||
      !Object.prototype.hasOwnProperty.call(CLOSE_DATA_STATUS_MAP, rawItemStatus)
    ) {
      return Object.freeze({
        kind: 'unknown' as const,
        reason: 'unrecognized_status' as const,
      });
    }
    const itemStatus = CLOSE_DATA_STATUS_MAP[rawItemStatus];

    const itemAmountMinor = parseCreditDetailAmountMinor(item.amount);
    if (itemAmountMinor === null) {
      return Object.freeze({
        kind: 'unknown' as const,
        reason: 'invalid_field' as const,
      });
    }

    const snoParsed = parseOptionalShortText(item.sno);
    const datetimeParsed = parseOptionalShortText(item.datetime);
    if (!snoParsed.ok || !datetimeParsed.ok) {
      return Object.freeze({
        kind: 'unknown' as const,
        reason: 'invalid_field' as const,
      });
    }

    closeData.push(
      Object.freeze({
        status: itemStatus,
        sno: snoParsed.value,
        amountMinor: itemAmountMinor,
        datetime: datetimeParsed.value,
      }),
    );
  }

  return Object.freeze({
    kind: 'detail' as const,
    tradeId: tradeIdParsed.value,
    authorisedMinor,
    capturedMinor,
    status,
    authTime: authTimeParsed.value,
    closeData: Object.freeze(closeData),
  });
}
