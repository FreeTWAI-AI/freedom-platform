import type { EcpayJsonRequest } from '../json-request.js';
import type { EcpayKeyPair } from '../keys.js';
import { sealInvoiceRequest } from './envelope.js';
import {
  INVOICE_NO_PATTERN,
  RANDOM_NUMBER_PATTERN,
  assertInvoiceEmail,
  assertInvoiceNo,
  assertReason,
  assertRelateNumber,
  assertRemark,
  assertRequestContext,
  assertRequestDateTime,
  resolveBuyerFields,
  serializeInvoiceItems,
  type EcpayInvoiceBuyer,
  type EcpayInvoiceItemInput,
  type InvoiceRequestContext,
} from './fields.js';
import {
  assertBaseParseOptions,
  mapOpenedInvoiceResponse,
  readRequiredDateTime,
  readRequiredPatternString,
  type InvoiceCallResult,
  type ParseInvoiceResponseOptions,
} from './result.js';

export interface IssueInvoiceRequestInput extends InvoiceRequestContext {
  readonly relateNumber: string;
  readonly buyer: EcpayInvoiceBuyer;
  readonly email: string;
  readonly salesAmountMinor: number;
  readonly remark: string;
  readonly itemWord: string;
  readonly items: readonly EcpayInvoiceItemInput[];
}

export interface VoidWithReissueRequestInput extends InvoiceRequestContext {
  readonly invoiceNo: string;
  readonly voidReason: string;
  readonly relateNumber: string;
  readonly invoiceDateTime: string;
  readonly buyer: EcpayInvoiceBuyer;
  readonly email: string;
  readonly salesAmountMinor: number;
  readonly remark: string;
  readonly itemWord: string;
  readonly items: readonly EcpayInvoiceItemInput[];
}

export interface IssuedInvoiceValue {
  readonly invoiceNo: string;
  readonly invoiceDateTime: string;
  readonly invoiceAtEpochMs: number;
  readonly randomNumber: string;
}

export function buildIssueInvoiceRequest(
  input: IssueInvoiceRequestInput,
  keys: EcpayKeyPair,
): EcpayJsonRequest {
  assertRequestContext(input, keys);
  assertRelateNumber(input.relateNumber);
  const buyerFields = resolveBuyerFields(input.buyer);
  assertInvoiceEmail(input.email);
  assertRemark(input.remark);
  const { totalTwd, items } = serializeInvoiceItems(
    input.items,
    input.itemWord,
    input.salesAmountMinor,
  );

  const data = {
    MerchantID: input.merchantId,
    RelateNumber: input.relateNumber,
    CustomerID: '',
    CustomerIdentifier: buyerFields.CustomerIdentifier,
    CustomerName: buyerFields.CustomerName,
    CustomerAddr: '',
    CustomerPhone: '',
    CustomerEmail: input.email,
    Print: buyerFields.Print,
    Donation: buyerFields.Donation,
    LoveCode: buyerFields.LoveCode,
    CarrierType: buyerFields.CarrierType,
    CarrierNum: buyerFields.CarrierNum,
    TaxType: '1',
    SalesAmount: totalTwd,
    InvoiceRemark: input.remark,
    InvType: '07',
    vat: '1',
    Items: items,
  };

  return sealInvoiceRequest(
    input.environment,
    'issue',
    input.merchantId,
    input.timestampSeconds,
    data,
    keys,
  );
}

export function buildVoidWithReissueRequest(
  input: VoidWithReissueRequestInput,
  keys: EcpayKeyPair,
): EcpayJsonRequest {
  assertRequestContext(input, keys);
  assertInvoiceNo(input.invoiceNo);
  assertReason(input.voidReason);
  assertRelateNumber(input.relateNumber);
  assertRequestDateTime(input.invoiceDateTime);
  const buyerFields = resolveBuyerFields(input.buyer);
  assertInvoiceEmail(input.email);
  assertRemark(input.remark);
  const { totalTwd, items } = serializeInvoiceItems(
    input.items,
    input.itemWord,
    input.salesAmountMinor,
  );

  const data = {
    MerchantID: input.merchantId,
    VoidModel: {
      InvoiceNo: input.invoiceNo,
      VoidReason: input.voidReason,
    },
    IssueModel: {
      RelateNumber: input.relateNumber,
      InvoiceDate: input.invoiceDateTime,
      CustomerID: '',
      CustomerIdentifier: buyerFields.CustomerIdentifier,
      CustomerName: buyerFields.CustomerName,
      CustomerAddr: '',
      CustomerPhone: '',
      CustomerEmail: input.email,
      Print: buyerFields.Print,
      Donation: buyerFields.Donation,
      LoveCode: buyerFields.LoveCode,
      CarrierType: buyerFields.CarrierType,
      CarrierNum: buyerFields.CarrierNum,
      TaxType: '1',
      SalesAmount: totalTwd,
      InvoiceRemark: input.remark,
      InvType: '07',
      vat: '1',
      Items: items,
    },
  };

  return sealInvoiceRequest(
    input.environment,
    'voidWithReissue',
    input.merchantId,
    input.timestampSeconds,
    data,
    keys,
  );
}

function extractIssuedInvoiceValue(
  data: Readonly<Record<string, unknown>>,
): InvoiceCallResult<IssuedInvoiceValue> {
  const invoiceNoCheck = readRequiredPatternString(
    data,
    'InvoiceNo',
    INVOICE_NO_PATTERN,
  );
  if (!invoiceNoCheck.ok) return invoiceNoCheck.error;

  const dateCheck = readRequiredDateTime(data, 'InvoiceDate');
  if (!dateCheck.ok) return dateCheck.error;

  const randomCheck = readRequiredPatternString(
    data,
    'RandomNumber',
    RANDOM_NUMBER_PATTERN,
  );
  if (!randomCheck.ok) return randomCheck.error;

  return Object.freeze({
    kind: 'ok' as const,
    value: Object.freeze({
      invoiceNo: invoiceNoCheck.value,
      invoiceDateTime: dateCheck.value.text,
      invoiceAtEpochMs: dateCheck.value.epochMs,
      randomNumber: randomCheck.value,
    }),
  });
}

export function parseIssueInvoiceResponse(
  body: string,
  keys: EcpayKeyPair,
  options: ParseInvoiceResponseOptions,
): InvoiceCallResult<IssuedInvoiceValue> {
  assertBaseParseOptions(options, keys);
  return mapOpenedInvoiceResponse(
    body,
    keys,
    options.merchantId,
    extractIssuedInvoiceValue,
  );
}

export function parseVoidWithReissueResponse(
  body: string,
  keys: EcpayKeyPair,
  options: ParseInvoiceResponseOptions,
): InvoiceCallResult<IssuedInvoiceValue> {
  assertBaseParseOptions(options, keys);
  return mapOpenedInvoiceResponse(
    body,
    keys,
    options.merchantId,
    extractIssuedInvoiceValue,
  );
}
