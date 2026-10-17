import type { EcpayJsonRequest } from '../json-request.js';
import type { EcpayKeyPair } from '../keys.js';
import { sealInvoiceRequest } from './envelope.js';
import {
  ALLOWANCE_NO_PATTERN,
  INVOICE_NO_PATTERN,
  assertAllowanceNo,
  assertInvoiceEmail,
  assertInvoiceNo,
  assertReason,
  assertRequestContext,
  assertRequestDate,
  assertReturnUrl,
  resolveOptionalCompanyTitle,
  serializeInvoiceItems,
  type EcpayInvoiceItemInput,
  type InvoiceRequestContext,
} from './fields.js';
import {
  assertBaseParseOptions,
  mapOpenedInvoiceResponse,
  readRequiredAmountMinor,
  readRequiredDateTime,
  readRequiredPatternString,
  unknownFieldResult,
  type InvoiceCallResult,
  type ParseInvoiceResponseOptions,
} from './result.js';
import type {
  ParseVoidInvoiceResponseOptions,
  VoidedInvoiceValue,
} from './void.js';

export interface AllowanceRequestInput extends InvoiceRequestContext {
  readonly invoiceNo: string;
  readonly invoiceDate: string;
  readonly companyTitle: string | null;
  readonly email: string;
  readonly allowanceAmountMinor: number;
  readonly itemWord: string;
  readonly items: readonly EcpayInvoiceItemInput[];
}

export interface OnlineAllowanceRequestInput extends AllowanceRequestInput {
  readonly returnUrl: string;
}

export interface VoidAllowanceRequestInput extends InvoiceRequestContext {
  readonly invoiceNo: string;
  readonly allowanceNo: string;
  readonly reason: string;
}

export type CancelOnlineAllowanceRequestInput = VoidAllowanceRequestInput;

export interface ParseAllowanceResponseOptions
  extends ParseInvoiceResponseOptions {
  readonly invoiceNo: string;
}

export interface AllowanceValue {
  readonly allowanceNo: string;
  readonly invoiceNo: string;
  readonly allowanceDateTime: string;
  readonly allowanceAtEpochMs: number;
  readonly remainingAllowanceMinor: number;
}

export interface OnlineAllowanceValue {
  readonly allowanceNo: string;
  readonly invoiceNo: string;
  readonly submittedDateTime: string;
  readonly submittedAtEpochMs: number;
  readonly expiresDateTime: string;
  readonly expiresAtEpochMs: number;
  readonly remainingAllowanceMinor: number;
}

export function buildAllowanceRequest(
  input: AllowanceRequestInput,
  keys: EcpayKeyPair,
): EcpayJsonRequest {
  assertRequestContext(input, keys);
  assertInvoiceNo(input.invoiceNo);
  assertRequestDate(input.invoiceDate);
  const customerName = resolveOptionalCompanyTitle(input.companyTitle);
  assertInvoiceEmail(input.email);
  const { totalTwd, items } = serializeInvoiceItems(
    input.items,
    input.itemWord,
    input.allowanceAmountMinor,
  );

  const data = {
    MerchantID: input.merchantId,
    InvoiceNo: input.invoiceNo,
    InvoiceDate: input.invoiceDate,
    AllowanceNotify: 'E',
    CustomerName: customerName,
    NotifyMail: input.email,
    NotifyPhone: '',
    AllowanceAmount: totalTwd,
    Items: items,
  };

  return sealInvoiceRequest(
    input.environment,
    'allowance',
    input.merchantId,
    input.timestampSeconds,
    data,
    keys,
  );
}

export function buildOnlineAllowanceRequest(
  input: OnlineAllowanceRequestInput,
  keys: EcpayKeyPair,
): EcpayJsonRequest {
  assertRequestContext(input, keys);
  assertInvoiceNo(input.invoiceNo);
  assertRequestDate(input.invoiceDate);
  const customerName = resolveOptionalCompanyTitle(input.companyTitle);
  assertInvoiceEmail(input.email);
  const { totalTwd, items } = serializeInvoiceItems(
    input.items,
    input.itemWord,
    input.allowanceAmountMinor,
  );
  assertReturnUrl(input.returnUrl);

  const data = {
    MerchantID: input.merchantId,
    InvoiceNo: input.invoiceNo,
    InvoiceDate: input.invoiceDate,
    AllowanceNotify: 'E',
    CustomerName: customerName,
    NotifyMail: input.email,
    AllowanceAmount: totalTwd,
    Items: items,
    ReturnURL: input.returnUrl,
  };

  return sealInvoiceRequest(
    input.environment,
    'onlineAllowance',
    input.merchantId,
    input.timestampSeconds,
    data,
    keys,
  );
}

function buildAllowanceInvalidByOp(
  op: 'voidAllowance' | 'cancelOnlineAllowance',
  input: VoidAllowanceRequestInput,
  keys: EcpayKeyPair,
): EcpayJsonRequest {
  assertRequestContext(input, keys);
  assertInvoiceNo(input.invoiceNo);
  assertAllowanceNo(input.allowanceNo);
  assertReason(input.reason);

  const data = {
    MerchantID: input.merchantId,
    InvoiceNo: input.invoiceNo,
    AllowanceNo: input.allowanceNo,
    Reason: input.reason,
  };

  return sealInvoiceRequest(
    input.environment,
    op,
    input.merchantId,
    input.timestampSeconds,
    data,
    keys,
  );
}

export function buildVoidAllowanceRequest(
  input: VoidAllowanceRequestInput,
  keys: EcpayKeyPair,
): EcpayJsonRequest {
  return buildAllowanceInvalidByOp('voidAllowance', input, keys);
}

export function buildCancelOnlineAllowanceRequest(
  input: CancelOnlineAllowanceRequestInput,
  keys: EcpayKeyPair,
): EcpayJsonRequest {
  return buildAllowanceInvalidByOp('cancelOnlineAllowance', input, keys);
}

export function parseAllowanceResponse(
  body: string,
  keys: EcpayKeyPair,
  options: ParseAllowanceResponseOptions,
): InvoiceCallResult<AllowanceValue> {
  assertBaseParseOptions(options, keys);
  assertInvoiceNo(options.invoiceNo);

  return mapOpenedInvoiceResponse(body, keys, options.merchantId, (data) => {
    const allowNoCheck = readRequiredPatternString(
      data,
      'IA_Allow_No',
      ALLOWANCE_NO_PATTERN,
    );
    if (!allowNoCheck.ok) return allowNoCheck.error;

    const invoiceNoCheck = readRequiredPatternString(
      data,
      'IA_Invoice_No',
      INVOICE_NO_PATTERN,
    );
    if (!invoiceNoCheck.ok) return invoiceNoCheck.error;
    if (invoiceNoCheck.value !== options.invoiceNo) {
      return unknownFieldResult('invoice_no_mismatch', 'IA_Invoice_No');
    }

    const dateCheck = readRequiredDateTime(data, 'IA_Date');
    if (!dateCheck.ok) return dateCheck.error;

    const remainCheck = readRequiredAmountMinor(data, 'IA_Remain_Allowance_Amt');
    if (!remainCheck.ok) return remainCheck.error;

    return Object.freeze({
      kind: 'ok' as const,
      value: Object.freeze({
        allowanceNo: allowNoCheck.value,
        invoiceNo: invoiceNoCheck.value,
        allowanceDateTime: dateCheck.value.text,
        allowanceAtEpochMs: dateCheck.value.epochMs,
        remainingAllowanceMinor: remainCheck.value,
      }),
    });
  });
}

export function parseOnlineAllowanceResponse(
  body: string,
  keys: EcpayKeyPair,
  options: ParseAllowanceResponseOptions,
): InvoiceCallResult<OnlineAllowanceValue> {
  assertBaseParseOptions(options, keys);
  assertInvoiceNo(options.invoiceNo);

  return mapOpenedInvoiceResponse(body, keys, options.merchantId, (data) => {
    const allowNoCheck = readRequiredPatternString(
      data,
      'IA_Allow_No',
      ALLOWANCE_NO_PATTERN,
    );
    if (!allowNoCheck.ok) return allowNoCheck.error;

    const invoiceNoCheck = readRequiredPatternString(
      data,
      'IA_Invoice_No',
      INVOICE_NO_PATTERN,
    );
    if (!invoiceNoCheck.ok) return invoiceNoCheck.error;
    if (invoiceNoCheck.value !== options.invoiceNo) {
      return unknownFieldResult('invoice_no_mismatch', 'IA_Invoice_No');
    }

    const tempDateCheck = readRequiredDateTime(data, 'IA_TempDate');
    if (!tempDateCheck.ok) return tempDateCheck.error;

    const expireDateCheck = readRequiredDateTime(data, 'IA_TempExpireDate');
    if (!expireDateCheck.ok) return expireDateCheck.error;

    const remainCheck = readRequiredAmountMinor(data, 'IA_Remain_Allowance_Amt');
    if (!remainCheck.ok) return remainCheck.error;

    return Object.freeze({
      kind: 'ok' as const,
      value: Object.freeze({
        allowanceNo: allowNoCheck.value,
        invoiceNo: invoiceNoCheck.value,
        submittedDateTime: tempDateCheck.value.text,
        submittedAtEpochMs: tempDateCheck.value.epochMs,
        expiresDateTime: expireDateCheck.value.text,
        expiresAtEpochMs: expireDateCheck.value.epochMs,
        remainingAllowanceMinor: remainCheck.value,
      }),
    });
  });
}

function parseAllowanceInvalidResponse(
  body: string,
  keys: EcpayKeyPair,
  options: ParseVoidInvoiceResponseOptions,
): InvoiceCallResult<VoidedInvoiceValue> {
  assertBaseParseOptions(options, keys);
  assertInvoiceNo(options.invoiceNo);

  return mapOpenedInvoiceResponse(body, keys, options.merchantId, (data) => {
    const invoiceNoCheck = readRequiredPatternString(
      data,
      'IA_Invoice_No',
      INVOICE_NO_PATTERN,
    );
    if (!invoiceNoCheck.ok) return invoiceNoCheck.error;
    if (invoiceNoCheck.value !== options.invoiceNo) {
      return unknownFieldResult('invoice_no_mismatch', 'IA_Invoice_No');
    }

    return Object.freeze({
      kind: 'ok' as const,
      value: Object.freeze({
        invoiceNo: invoiceNoCheck.value,
      }),
    });
  });
}

export function parseVoidAllowanceResponse(
  body: string,
  keys: EcpayKeyPair,
  options: ParseVoidInvoiceResponseOptions,
): InvoiceCallResult<VoidedInvoiceValue> {
  return parseAllowanceInvalidResponse(body, keys, options);
}

export function parseCancelOnlineAllowanceResponse(
  body: string,
  keys: EcpayKeyPair,
  options: ParseVoidInvoiceResponseOptions,
): InvoiceCallResult<VoidedInvoiceValue> {
  return parseAllowanceInvalidResponse(body, keys, options);
}
