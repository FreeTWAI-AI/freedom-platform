import { decryptData, encryptData } from './aes.js';
import {
  verifySignedForm,
  type VerifySignedFormResult,
} from './checkmac.js';
import { sanitizeMessage } from './encoding.js';
import { EcpayProtocolError } from './errors.js';
import type { ParseFormOptions } from './form.js';
import { unwrapKeyPair, type EcpayKeyPair } from './keys.js';

const MERCHANT_ID_PATTERN = /^[0-9]{7,10}$/;

export interface InvoiceEnvelopeInput {
  readonly merchantId: string;
  readonly timestamp: number;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface InvoiceRequestEnvelope {
  readonly PlatformID: '';
  readonly MerchantID: string;
  readonly RqHeader: {
    readonly Timestamp: number;
  };
  readonly Data: string;
}

export interface OpenInvoiceResponseOptions {
  readonly merchantId: string;
}

export type InvoiceOpenInvalidReason =
  | 'invalid_json'
  | 'not_an_object'
  | 'merchant_mismatch'
  | 'invalid_base64'
  | 'decrypt_failed'
  | 'invalid_encoding'
  | 'invalid_payload';

export type InvoiceOpenResponseResult =
  | {
      readonly kind: 'ok';
      readonly data: Readonly<Record<string, unknown>>;
    }
  | {
      readonly kind: 'rejected';
      readonly rtnCode: string;
      readonly rtnMsg: string;
      readonly data: Readonly<Record<string, unknown>>;
    }
  | {
      readonly kind: 'transport_error';
      readonly transCode: string;
      readonly transMsg: string;
    }
  | {
      readonly kind: 'invalid';
      readonly reason: InvoiceOpenInvalidReason;
    };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || value instanceof Uint8Array) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function assertMerchantId(merchantId: unknown): asserts merchantId is string {
  if (typeof merchantId !== 'string' || !MERCHANT_ID_PATTERN.test(merchantId)) {
    throw new EcpayProtocolError('invalid_input');
  }
}

export function buildInvoiceEnvelope(
  input: InvoiceEnvelopeInput,
  keys: EcpayKeyPair,
): InvoiceRequestEnvelope {
  unwrapKeyPair(keys);
  if (!isPlainObject(input)) {
    throw new EcpayProtocolError('invalid_input');
  }
  assertMerchantId(input.merchantId);
  if (
    typeof input.timestamp !== 'number' ||
    !Number.isSafeInteger(input.timestamp) ||
    input.timestamp <= 0
  ) {
    throw new EcpayProtocolError('invalid_input');
  }

  const encryptedData = encryptData(input.payload, keys);
  return Object.freeze({
    PlatformID: '' as const,
    MerchantID: input.merchantId,
    RqHeader: Object.freeze({
      Timestamp: input.timestamp,
    }),
    Data: encryptedData,
  });
}

export function openInvoiceResponse(
  body: string,
  keys: EcpayKeyPair,
  options: OpenInvoiceResponseOptions,
): InvoiceOpenResponseResult {
  unwrapKeyPair(keys);
  if (!isPlainObject(options)) {
    throw new EcpayProtocolError('invalid_input');
  }
  assertMerchantId(options.merchantId);

  if (typeof body !== 'string') {
    return Object.freeze({ kind: 'invalid' as const, reason: 'invalid_json' as const });
  }

  let parsedEnvelope: unknown;
  try {
    parsedEnvelope = JSON.parse(body);
  } catch {
    return Object.freeze({ kind: 'invalid' as const, reason: 'invalid_json' as const });
  }

  if (!isPlainObject(parsedEnvelope)) {
    return Object.freeze({ kind: 'invalid' as const, reason: 'not_an_object' as const });
  }

  if (parsedEnvelope.MerchantID !== undefined && parsedEnvelope.MerchantID !== null) {
    if (
      typeof parsedEnvelope.MerchantID !== 'string' ||
      parsedEnvelope.MerchantID !== options.merchantId
    ) {
      return Object.freeze({ kind: 'invalid' as const, reason: 'merchant_mismatch' as const });
    }
  }

  const rawTransCode = parsedEnvelope.TransCode;
  if (
    (typeof rawTransCode !== 'number' && typeof rawTransCode !== 'string') ||
    (typeof rawTransCode === 'number' && !Number.isFinite(rawTransCode)) ||
    String(rawTransCode).trim() === ''
  ) {
    return Object.freeze({ kind: 'invalid' as const, reason: 'invalid_payload' as const });
  }

  const transOk = rawTransCode === 1 || rawTransCode === '1';
  if (!transOk) {
    const rawTransMsg = typeof parsedEnvelope.TransMsg === 'string' ? parsedEnvelope.TransMsg : '';
    return Object.freeze({
      kind: 'transport_error' as const,
      transCode: sanitizeMessage(String(rawTransCode)),
      transMsg: sanitizeMessage(rawTransMsg),
    });
  }

  const rawData = parsedEnvelope.Data;
  if (typeof rawData !== 'string') {
    return Object.freeze({ kind: 'invalid' as const, reason: 'invalid_payload' as const });
  }

  let decrypted: unknown;
  try {
    decrypted = decryptData(rawData, keys);
  } catch (err) {
    if (err instanceof EcpayProtocolError) {
      switch (err.code) {
        case 'invalid_base64':
          return Object.freeze({ kind: 'invalid' as const, reason: 'invalid_base64' as const });
        case 'decrypt_failed':
          return Object.freeze({ kind: 'invalid' as const, reason: 'decrypt_failed' as const });
        case 'invalid_encoding':
          return Object.freeze({ kind: 'invalid' as const, reason: 'invalid_encoding' as const });
        case 'invalid_json':
          return Object.freeze({ kind: 'invalid' as const, reason: 'invalid_payload' as const });
        default:
          return Object.freeze({ kind: 'invalid' as const, reason: 'invalid_payload' as const });
      }
    }
    return Object.freeze({ kind: 'invalid' as const, reason: 'invalid_payload' as const });
  }

  if (!isPlainObject(decrypted)) {
    return Object.freeze({ kind: 'invalid' as const, reason: 'invalid_payload' as const });
  }

  const rawRtnCode = decrypted.RtnCode;
  if (
    (typeof rawRtnCode !== 'number' && typeof rawRtnCode !== 'string') ||
    (typeof rawRtnCode === 'number' && !Number.isFinite(rawRtnCode)) ||
    String(rawRtnCode).trim() === ''
  ) {
    return Object.freeze({ kind: 'invalid' as const, reason: 'invalid_payload' as const });
  }

  const frozenData = Object.freeze({ ...decrypted });
  const rtnOk = rawRtnCode === 1 || rawRtnCode === '1';
  if (rtnOk) {
    return Object.freeze({
      kind: 'ok' as const,
      data: frozenData,
    });
  }

  const rawRtnMsg = typeof decrypted.RtnMsg === 'string' ? decrypted.RtnMsg : '';
  return Object.freeze({
    kind: 'rejected' as const,
    rtnCode: sanitizeMessage(String(rawRtnCode)),
    rtnMsg: sanitizeMessage(rawRtnMsg),
    data: frozenData,
  });
}

export function verifyInvoiceAllowanceCallback(
  body: string | Uint8Array,
  keys: EcpayKeyPair | readonly EcpayKeyPair[],
  options?: ParseFormOptions,
): VerifySignedFormResult {
  return verifySignedForm(body, keys, 'md5', options);
}

export const invoice = Object.freeze({
  buildEnvelope: buildInvoiceEnvelope,
  openResponse: openInvoiceResponse,
  verifyAllowanceCallback: verifyInvoiceAllowanceCallback,
});
