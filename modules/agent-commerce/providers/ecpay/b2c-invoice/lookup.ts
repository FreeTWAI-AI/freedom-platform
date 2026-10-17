import { sanitizeMessage } from '../encoding.js';
import { EcpayProtocolError } from '../errors.js';
import { isPlainObject } from '../field-rules.js';
import type { EcpayJsonRequest } from '../json-request.js';
import type { EcpayKeyPair } from '../keys.js';
import { sealInvoiceRequest } from './envelope.js';
import {
  assertLoveCode,
  assertMobileBarcode,
  assertRequestContext,
  assertUbn,
  type InvoiceRequestContext,
} from './fields.js';
import {
  assertBaseParseOptions,
  mapOpenedInvoiceResponse,
  unknownFieldResult,
  type FieldReadResult,
  type InvoiceCallResult,
  type ParseInvoiceResponseOptions,
} from './result.js';

const COMPANY_NAME_INVALID_UBN_CODES = new Set(['1200125', '2027000']);

export interface CheckBarcodeRequestInput extends InvoiceRequestContext {
  readonly barcode: string;
}

export interface CheckBarcodeResult {
  readonly exists: boolean;
}

export interface CheckLoveCodeRequestInput extends InvoiceRequestContext {
  readonly loveCode: string;
}

export interface CheckLoveCodeResult {
  readonly exists: boolean;
  readonly organName: string | null;
}

export interface CompanyNameRequestInput extends InvoiceRequestContext {
  readonly ubn: string;
}

export interface CompanyNameResult {
  readonly companyName: string;
}

export type BuyerLookupClassification = 'valid' | 'invalid' | 'indeterminate';

export type CompanyNameClassification =
  | { readonly kind: 'found'; readonly companyName: string }
  | { readonly kind: 'invalid_ubn' }
  | { readonly kind: 'indeterminate' };

function readIsExist(
  record: Readonly<Record<string, unknown>>,
): FieldReadResult<boolean> {
  const raw = record.IsExist;
  if (raw === undefined || raw === null || raw === '') {
    return { ok: false, error: unknownFieldResult('missing_field', 'IsExist') };
  }
  if (raw === 'Y') {
    return { ok: true, value: true };
  }
  if (raw === 'N') {
    return { ok: true, value: false };
  }
  return { ok: false, error: unknownFieldResult('invalid_field', 'IsExist') };
}

export function buildCheckBarcodeRequest(
  input: CheckBarcodeRequestInput,
  keys: EcpayKeyPair,
): EcpayJsonRequest {
  assertRequestContext(input, keys);
  assertMobileBarcode(input.barcode);

  return sealInvoiceRequest(
    input.environment,
    'checkBarcode',
    input.merchantId,
    input.timestampSeconds,
    {
      MerchantID: input.merchantId,
      BarCode: input.barcode,
    },
    keys,
  );
}

export function parseCheckBarcodeResponse(
  body: string,
  keys: EcpayKeyPair,
  options: ParseInvoiceResponseOptions,
): InvoiceCallResult<CheckBarcodeResult> {
  assertBaseParseOptions(options, keys);

  return mapOpenedInvoiceResponse(body, keys, options.merchantId, (data) => {
    const exists = readIsExist(data);
    if (!exists.ok) {
      return exists.error;
    }

    return Object.freeze({
      kind: 'ok' as const,
      value: Object.freeze({
        exists: exists.value,
      }),
    });
  });
}

export function buildCheckLoveCodeRequest(
  input: CheckLoveCodeRequestInput,
  keys: EcpayKeyPair,
): EcpayJsonRequest {
  assertRequestContext(input, keys);
  assertLoveCode(input.loveCode);

  return sealInvoiceRequest(
    input.environment,
    'checkLoveCode',
    input.merchantId,
    input.timestampSeconds,
    {
      MerchantID: input.merchantId,
      LoveCode: input.loveCode,
    },
    keys,
  );
}

export function parseCheckLoveCodeResponse(
  body: string,
  keys: EcpayKeyPair,
  options: ParseInvoiceResponseOptions,
): InvoiceCallResult<CheckLoveCodeResult> {
  assertBaseParseOptions(options, keys);

  return mapOpenedInvoiceResponse(body, keys, options.merchantId, (data) => {
    const exists = readIsExist(data);
    if (!exists.ok) {
      return exists.error;
    }

    const rawOrganName = data.OrganName;
    let organName: string | null = null;
    if (rawOrganName !== undefined && rawOrganName !== null) {
      if (typeof rawOrganName !== 'string') {
        return unknownFieldResult('invalid_field', 'OrganName');
      }
      const cleaned = sanitizeMessage(rawOrganName, 60);
      organName = cleaned === '' ? null : cleaned;
    }

    return Object.freeze({
      kind: 'ok' as const,
      value: Object.freeze({
        exists: exists.value,
        organName,
      }),
    });
  });
}

export function buildCompanyNameRequest(
  input: CompanyNameRequestInput,
  keys: EcpayKeyPair,
): EcpayJsonRequest {
  assertRequestContext(input, keys);
  assertUbn(input.ubn);

  return sealInvoiceRequest(
    input.environment,
    'companyName',
    input.merchantId,
    input.timestampSeconds,
    {
      MerchantID: input.merchantId,
      UnifiedBusinessNo: input.ubn,
    },
    keys,
  );
}

export function parseCompanyNameResponse(
  body: string,
  keys: EcpayKeyPair,
  options: ParseInvoiceResponseOptions,
): InvoiceCallResult<CompanyNameResult> {
  assertBaseParseOptions(options, keys);

  return mapOpenedInvoiceResponse(body, keys, options.merchantId, (data) => {
    const rawCompanyName = data.CompanyName;
    if (
      rawCompanyName === undefined ||
      rawCompanyName === null ||
      rawCompanyName === ''
    ) {
      return unknownFieldResult('missing_field', 'CompanyName');
    }
    if (typeof rawCompanyName !== 'string') {
      return unknownFieldResult('invalid_field', 'CompanyName');
    }
    const companyName = sanitizeMessage(rawCompanyName, 100);
    if (companyName === '') {
      return unknownFieldResult('missing_field', 'CompanyName');
    }

    return Object.freeze({
      kind: 'ok' as const,
      value: Object.freeze({
        companyName,
      }),
    });
  });
}

export function classifyBarcodeCheck(
  result: InvoiceCallResult<CheckBarcodeResult>,
): BuyerLookupClassification {
  if (!isPlainObject(result)) {
    throw new EcpayProtocolError('invalid_input');
  }
  if (result.kind === 'ok') {
    return result.value.exists ? 'valid' : 'invalid';
  }
  return 'indeterminate';
}

export function classifyLoveCodeCheck(
  result: InvoiceCallResult<CheckLoveCodeResult>,
): BuyerLookupClassification {
  if (!isPlainObject(result)) {
    throw new EcpayProtocolError('invalid_input');
  }
  if (result.kind === 'ok') {
    return result.value.exists ? 'valid' : 'invalid';
  }
  return 'indeterminate';
}

export function classifyCompanyNameCheck(
  result: InvoiceCallResult<CompanyNameResult>,
): CompanyNameClassification {
  if (!isPlainObject(result)) {
    throw new EcpayProtocolError('invalid_input');
  }
  if (result.kind === 'ok') {
    return Object.freeze({
      kind: 'found' as const,
      companyName: result.value.companyName,
    });
  }
  if (
    result.kind === 'rejected' &&
    COMPANY_NAME_INVALID_UBN_CODES.has(result.rtnCode)
  ) {
    return Object.freeze({
      kind: 'invalid_ubn' as const,
    });
  }
  return Object.freeze({
    kind: 'indeterminate' as const,
  });
}
