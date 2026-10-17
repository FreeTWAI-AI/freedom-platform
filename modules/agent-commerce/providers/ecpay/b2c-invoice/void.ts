import type { EcpayJsonRequest } from '../json-request.js';
import type { EcpayKeyPair } from '../keys.js';
import { sealInvoiceRequest } from './envelope.js';
import {
  INVOICE_NO_PATTERN,
  assertInvoiceNo,
  assertReason,
  assertRequestContext,
  assertRequestDate,
  type InvoiceRequestContext,
} from './fields.js';
import {
  assertBaseParseOptions,
  mapOpenedInvoiceResponse,
  readRequiredPatternString,
  unknownFieldResult,
  type InvoiceCallResult,
  type ParseInvoiceResponseOptions,
} from './result.js';

export interface VoidInvoiceRequestInput extends InvoiceRequestContext {
  readonly invoiceNo: string;
  readonly invoiceDate: string;
  readonly reason: string;
}

export interface ParseVoidInvoiceResponseOptions
  extends ParseInvoiceResponseOptions {
  readonly invoiceNo: string;
}

export interface VoidedInvoiceValue {
  readonly invoiceNo: string;
}

export function buildVoidInvoiceRequest(
  input: VoidInvoiceRequestInput,
  keys: EcpayKeyPair,
): EcpayJsonRequest {
  assertRequestContext(input, keys);
  assertInvoiceNo(input.invoiceNo);
  assertRequestDate(input.invoiceDate);
  assertReason(input.reason);

  const data = {
    MerchantID: input.merchantId,
    InvoiceNo: input.invoiceNo,
    InvoiceDate: input.invoiceDate,
    Reason: input.reason,
  };

  return sealInvoiceRequest(
    input.environment,
    'void',
    input.merchantId,
    input.timestampSeconds,
    data,
    keys,
  );
}

export function parseVoidInvoiceResponse(
  body: string,
  keys: EcpayKeyPair,
  options: ParseVoidInvoiceResponseOptions,
): InvoiceCallResult<VoidedInvoiceValue> {
  assertBaseParseOptions(options, keys);
  assertInvoiceNo(options.invoiceNo);

  return mapOpenedInvoiceResponse(body, keys, options.merchantId, (data) => {
    const invoiceNoCheck = readRequiredPatternString(
      data,
      'InvoiceNo',
      INVOICE_NO_PATTERN,
    );
    if (!invoiceNoCheck.ok) return invoiceNoCheck.error;

    if (invoiceNoCheck.value !== options.invoiceNo) {
      return unknownFieldResult('invoice_no_mismatch', 'InvoiceNo');
    }

    return Object.freeze({
      kind: 'ok' as const,
      value: Object.freeze({
        invoiceNo: invoiceNoCheck.value,
      }),
    });
  });
}
