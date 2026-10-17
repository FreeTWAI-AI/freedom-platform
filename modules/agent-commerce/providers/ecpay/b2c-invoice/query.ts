import { EcpayProtocolError } from '../errors.js';
import { isPlainObject } from '../field-rules.js';
import type { EcpayJsonRequest } from '../json-request.js';
import type { EcpayKeyPair } from '../keys.js';
import { sealInvoiceRequest } from './envelope.js';
import {
  ALLOWANCE_NO_PATTERN,
  INVOICE_NO_PATTERN,
  RANDOM_NUMBER_PATTERN,
  assertAllowanceNo,
  assertInvoiceNo,
  assertRelateNumber,
  assertRequestContext,
  assertRequestDate,
  isCleanText,
  type InvoiceRequestContext,
} from './fields.js';
import {
  assertBaseParseOptions,
  mapOpenedInvoiceResponse,
  readOptionalUploadDateTime,
  readRequiredAmountMinor,
  readRequiredDateTime,
  readRequiredPatternString,
  readStatusFlagBoolean,
  unknownFieldResult,
  type FieldReadResult,
  type InvoiceCallResult,
  type ParseInvoiceResponseOptions,
} from './result.js';

export type GetIssueRequestInput =
  | (InvoiceRequestContext & {
      readonly by: 'relate_number';
      readonly relateNumber: string;
    })
  | (InvoiceRequestContext & {
      readonly by: 'invoice_no';
      readonly invoiceNo: string;
      readonly invoiceDate: string;
    });

export type ParseGetIssueResponseOptions =
  | (ParseInvoiceResponseOptions & {
      readonly by: 'relate_number';
      readonly relateNumber: string;
    })
  | (ParseInvoiceResponseOptions & {
      readonly by: 'invoice_no';
      readonly invoiceNo: string;
    });

export interface InvoiceRecord {
  readonly invoiceNo: string;
  readonly relateNumber: string;
  readonly issuedDateTime: string;
  readonly issuedAtEpochMs: number;
  readonly issueStatus: 'issued' | 'cancelled';
  readonly voided: boolean;
  readonly uploaded: boolean;
  readonly uploadedDateTime: string | null;
  readonly uploadedAtEpochMs: number | null;
  readonly turnkeyStatus: 'accepted' | 'failed' | null;
  readonly salesAmountMinor: number;
  readonly remainingAllowanceMinor: number;
  readonly randomNumber: string;
}

export type GetAllowanceListRequestInput =
  | (InvoiceRequestContext & {
      readonly by: 'allowance_no';
      readonly allowanceNo: string;
    })
  | (InvoiceRequestContext & {
      readonly by: 'invoice_date' | 'allowance_date';
      readonly invoiceNo: string;
      readonly date: string;
    });

export interface ParseGetAllowanceListResponseOptions
  extends ParseInvoiceResponseOptions {
  readonly invoiceNo?: string;
  readonly allowanceNo?: string;
}

export interface AllowanceRecord {
  readonly allowanceNo: string;
  readonly invoiceNo: string;
  readonly allowanceDateTime: string;
  readonly allowanceAtEpochMs: number;
  readonly voided: boolean;
  readonly uploaded: boolean;
  readonly uploadedDateTime: string | null;
  readonly uploadedAtEpochMs: number | null;
  readonly amountMinor: number;
}

export interface GetAllowanceListResult {
  readonly allowances: readonly AllowanceRecord[];
}

export interface GetInvalidRequestInput extends InvoiceRequestContext {
  readonly relateNumber: string;
  readonly invoiceNo: string;
  readonly invoiceDate: string;
}

export interface ParseGetInvalidResponseOptions
  extends ParseInvoiceResponseOptions {
  readonly invoiceNo: string;
}

export interface InvalidInvoiceRecord {
  readonly invoiceNo: string;
  readonly voidedDateTime: string;
  readonly voidedAtEpochMs: number;
  readonly uploaded: boolean;
  readonly uploadedDateTime: string | null;
  readonly uploadedAtEpochMs: number | null;
}

export interface GetAllowanceInvalidRequestInput extends InvoiceRequestContext {
  readonly invoiceNo: string;
  readonly allowanceNo: string;
}

export interface ParseGetAllowanceInvalidResponseOptions
  extends ParseInvoiceResponseOptions {
  readonly invoiceNo: string;
  readonly allowanceNo: string;
}

export interface InvalidAllowanceRecord {
  readonly allowanceNo: string;
  readonly invoiceNo: string;
  readonly voidedDateTime: string;
  readonly voidedAtEpochMs: number;
  readonly uploaded: boolean;
  readonly uploadedDateTime: string | null;
  readonly uploadedAtEpochMs: number | null;
}

export function buildGetIssueRequest(
  input: GetIssueRequestInput,
  keys: EcpayKeyPair,
): EcpayJsonRequest {
  assertRequestContext(input, keys);

  if (input.by === 'relate_number') {
    assertRelateNumber(input.relateNumber);
    return sealInvoiceRequest(
      input.environment,
      'getIssue',
      input.merchantId,
      input.timestampSeconds,
      {
        MerchantID: input.merchantId,
        RelateNumber: input.relateNumber,
      },
      keys,
    );
  }

  if (input.by === 'invoice_no') {
    assertInvoiceNo(input.invoiceNo);
    assertRequestDate(input.invoiceDate);
    return sealInvoiceRequest(
      input.environment,
      'getIssue',
      input.merchantId,
      input.timestampSeconds,
      {
        MerchantID: input.merchantId,
        InvoiceNo: input.invoiceNo,
        InvoiceDate: input.invoiceDate,
      },
      keys,
    );
  }

  throw new EcpayProtocolError('invalid_input');
}

function readIssueStatus(
  record: Readonly<Record<string, unknown>>,
): FieldReadResult<'issued' | 'cancelled'> {
  const raw = record.IIS_Issue_Status;
  if (raw === undefined || raw === null || raw === '') {
    return {
      ok: false,
      error: unknownFieldResult('missing_field', 'IIS_Issue_Status'),
    };
  }
  if (raw === '1') {
    return { ok: true, value: 'issued' };
  }
  if (raw === '0') {
    return { ok: true, value: 'cancelled' };
  }
  return {
    ok: false,
    error: unknownFieldResult('invalid_field', 'IIS_Issue_Status'),
  };
}

function readTurnkeyStatus(
  record: Readonly<Record<string, unknown>>,
): FieldReadResult<'accepted' | 'failed' | null> {
  const raw = record.IIS_Turnkey_Status;
  if (raw === undefined || raw === null) {
    return {
      ok: false,
      error: unknownFieldResult('missing_field', 'IIS_Turnkey_Status'),
    };
  }
  if (raw === '') {
    return { ok: true, value: null };
  }
  if (raw === 'C') {
    return { ok: true, value: 'accepted' };
  }
  if (raw === 'E') {
    return { ok: true, value: 'failed' };
  }
  return {
    ok: false,
    error: unknownFieldResult('invalid_field', 'IIS_Turnkey_Status'),
  };
}

function readResponseRelateNumber(
  record: Readonly<Record<string, unknown>>,
): FieldReadResult<string> {
  const raw = record.IIS_Relate_Number;
  if (raw === undefined || raw === null || raw === '') {
    return {
      ok: false,
      error: unknownFieldResult('missing_field', 'IIS_Relate_Number'),
    };
  }
  if (!isCleanText(raw, 1, 50)) {
    return {
      ok: false,
      error: unknownFieldResult('invalid_field', 'IIS_Relate_Number'),
    };
  }
  return { ok: true, value: raw };
}

export function parseGetIssueResponse(
  body: string,
  keys: EcpayKeyPair,
  options: ParseGetIssueResponseOptions,
): InvoiceCallResult<InvoiceRecord> {
  assertBaseParseOptions(options, keys);
  if (options.by === 'relate_number') {
    assertRelateNumber(options.relateNumber);
  } else if (options.by === 'invoice_no') {
    assertInvoiceNo(options.invoiceNo);
  } else {
    throw new EcpayProtocolError('invalid_input');
  }

  return mapOpenedInvoiceResponse(body, keys, options.merchantId, (data) => {
    const invoiceNo = readRequiredPatternString(
      data,
      'IIS_Number',
      INVOICE_NO_PATTERN,
    );
    if (!invoiceNo.ok) {
      return invoiceNo.error;
    }
    if (options.by === 'invoice_no' && invoiceNo.value !== options.invoiceNo) {
      return unknownFieldResult('invoice_no_mismatch', 'IIS_Number');
    }

    const relateNumber = readResponseRelateNumber(data);
    if (!relateNumber.ok) {
      return relateNumber.error;
    }
    if (
      options.by === 'relate_number' &&
      relateNumber.value !== options.relateNumber
    ) {
      return unknownFieldResult('relate_number_mismatch', 'IIS_Relate_Number');
    }

    const issuedDate = readRequiredDateTime(data, 'IIS_Create_Date');
    if (!issuedDate.ok) {
      return issuedDate.error;
    }

    const issueStatus = readIssueStatus(data);
    if (!issueStatus.ok) {
      return issueStatus.error;
    }

    const voided = readStatusFlagBoolean(data, 'IIS_Invalid_Status');
    if (!voided.ok) {
      return voided.error;
    }

    const uploaded = readStatusFlagBoolean(data, 'IIS_Upload_Status');
    if (!uploaded.ok) {
      return uploaded.error;
    }

    const uploadedDate = readOptionalUploadDateTime(data, 'IIS_Upload_Date');
    if (!uploadedDate.ok) {
      return uploadedDate.error;
    }

    const turnkeyStatus = readTurnkeyStatus(data);
    if (!turnkeyStatus.ok) {
      return turnkeyStatus.error;
    }

    const salesAmount = readRequiredAmountMinor(data, 'IIS_Sales_Amount');
    if (!salesAmount.ok) {
      return salesAmount.error;
    }

    const remainingAllowance = readRequiredAmountMinor(
      data,
      'IIS_Remain_Allowance_Amt',
    );
    if (!remainingAllowance.ok) {
      return remainingAllowance.error;
    }

    const randomNumber = readRequiredPatternString(
      data,
      'IIS_Random_Number',
      RANDOM_NUMBER_PATTERN,
    );
    if (!randomNumber.ok) {
      return randomNumber.error;
    }

    return Object.freeze({
      kind: 'ok' as const,
      value: Object.freeze({
        invoiceNo: invoiceNo.value,
        relateNumber: relateNumber.value,
        issuedDateTime: issuedDate.value.text,
        issuedAtEpochMs: issuedDate.value.epochMs,
        issueStatus: issueStatus.value,
        voided: voided.value,
        uploaded: uploaded.value,
        uploadedDateTime:
          uploadedDate.value === null ? null : uploadedDate.value.text,
        uploadedAtEpochMs:
          uploadedDate.value === null ? null : uploadedDate.value.epochMs,
        turnkeyStatus: turnkeyStatus.value,
        salesAmountMinor: salesAmount.value,
        remainingAllowanceMinor: remainingAllowance.value,
        randomNumber: randomNumber.value,
      }),
    });
  });
}

export function buildGetAllowanceListRequest(
  input: GetAllowanceListRequestInput,
  keys: EcpayKeyPair,
): EcpayJsonRequest {
  assertRequestContext(input, keys);

  if (input.by === 'allowance_no') {
    assertAllowanceNo(input.allowanceNo);
    return sealInvoiceRequest(
      input.environment,
      'getAllowanceList',
      input.merchantId,
      input.timestampSeconds,
      {
        MerchantID: input.merchantId,
        SearchType: '0',
        AllowanceNo: input.allowanceNo,
      },
      keys,
    );
  }

  if (input.by === 'invoice_date' || input.by === 'allowance_date') {
    assertInvoiceNo(input.invoiceNo);
    assertRequestDate(input.date);
    return sealInvoiceRequest(
      input.environment,
      'getAllowanceList',
      input.merchantId,
      input.timestampSeconds,
      {
        MerchantID: input.merchantId,
        SearchType: input.by === 'invoice_date' ? '1' : '2',
        InvoiceNo: input.invoiceNo,
        Date: input.date,
      },
      keys,
    );
  }

  throw new EcpayProtocolError('invalid_input');
}

export function parseGetAllowanceListResponse(
  body: string,
  keys: EcpayKeyPair,
  options: ParseGetAllowanceListResponseOptions,
): InvoiceCallResult<GetAllowanceListResult> {
  assertBaseParseOptions(options, keys);
  if (options.invoiceNo !== undefined) {
    assertInvoiceNo(options.invoiceNo);
  }
  if (options.allowanceNo !== undefined) {
    assertAllowanceNo(options.allowanceNo);
  }
  if (options.invoiceNo === undefined && options.allowanceNo === undefined) {
    throw new EcpayProtocolError('invalid_input');
  }

  return mapOpenedInvoiceResponse(body, keys, options.merchantId, (data) => {
    const rawList = data.AllowanceInfo;
    if (rawList === undefined || rawList === null || rawList === '') {
      return unknownFieldResult('missing_field', 'AllowanceInfo');
    }
    if (!Array.isArray(rawList)) {
      return unknownFieldResult('invalid_field', 'AllowanceInfo');
    }

    const allowances: AllowanceRecord[] = [];
    for (let i = 0; i < rawList.length; i += 1) {
      const rawEntry: unknown = rawList[i];
      const prefix = `AllowanceInfo[${i}]`;
      if (!isPlainObject(rawEntry)) {
        return unknownFieldResult('invalid_field', prefix);
      }

      const allowanceNo = readRequiredPatternString(
        rawEntry,
        'IA_Allow_No',
        ALLOWANCE_NO_PATTERN,
        `${prefix}.IA_Allow_No`,
      );
      if (!allowanceNo.ok) {
        return allowanceNo.error;
      }
      if (
        options.allowanceNo !== undefined &&
        allowanceNo.value !== options.allowanceNo
      ) {
        return unknownFieldResult(
          'allowance_no_mismatch',
          `${prefix}.IA_Allow_No`,
        );
      }

      const invoiceNo = readRequiredPatternString(
        rawEntry,
        'IA_Invoice_No',
        INVOICE_NO_PATTERN,
        `${prefix}.IA_Invoice_No`,
      );
      if (!invoiceNo.ok) {
        return invoiceNo.error;
      }
      if (
        options.invoiceNo !== undefined &&
        invoiceNo.value !== options.invoiceNo
      ) {
        return unknownFieldResult(
          'invoice_no_mismatch',
          `${prefix}.IA_Invoice_No`,
        );
      }

      const allowanceDate = readRequiredDateTime(
        rawEntry,
        'IA_Date',
        `${prefix}.IA_Date`,
      );
      if (!allowanceDate.ok) {
        return allowanceDate.error;
      }

      const voided = readStatusFlagBoolean(
        rawEntry,
        'IA_Invalid_Status',
        `${prefix}.IA_Invalid_Status`,
      );
      if (!voided.ok) {
        return voided.error;
      }

      const uploaded = readStatusFlagBoolean(
        rawEntry,
        'IA_Upload_Status',
        `${prefix}.IA_Upload_Status`,
      );
      if (!uploaded.ok) {
        return uploaded.error;
      }

      const uploadedDate = readOptionalUploadDateTime(
        rawEntry,
        'IA_Upload_Date',
        `${prefix}.IA_Upload_Date`,
      );
      if (!uploadedDate.ok) {
        return uploadedDate.error;
      }

      const amount = readRequiredAmountMinor(
        rawEntry,
        'IA_Total_Tax_Amount',
        `${prefix}.IA_Total_Tax_Amount`,
      );
      if (!amount.ok) {
        return amount.error;
      }

      allowances.push(
        Object.freeze({
          allowanceNo: allowanceNo.value,
          invoiceNo: invoiceNo.value,
          allowanceDateTime: allowanceDate.value.text,
          allowanceAtEpochMs: allowanceDate.value.epochMs,
          voided: voided.value,
          uploaded: uploaded.value,
          uploadedDateTime:
            uploadedDate.value === null ? null : uploadedDate.value.text,
          uploadedAtEpochMs:
            uploadedDate.value === null ? null : uploadedDate.value.epochMs,
          amountMinor: amount.value,
        }),
      );
    }

    return Object.freeze({
      kind: 'ok' as const,
      value: Object.freeze({
        allowances: Object.freeze(allowances),
      }),
    });
  });
}

export function buildGetInvalidRequest(
  input: GetInvalidRequestInput,
  keys: EcpayKeyPair,
): EcpayJsonRequest {
  assertRequestContext(input, keys);
  assertRelateNumber(input.relateNumber);
  assertInvoiceNo(input.invoiceNo);
  assertRequestDate(input.invoiceDate);

  return sealInvoiceRequest(
    input.environment,
    'getInvalid',
    input.merchantId,
    input.timestampSeconds,
    {
      MerchantID: input.merchantId,
      RelateNumber: input.relateNumber,
      InvoiceNo: input.invoiceNo,
      InvoiceDate: input.invoiceDate,
    },
    keys,
  );
}

export function parseGetInvalidResponse(
  body: string,
  keys: EcpayKeyPair,
  options: ParseGetInvalidResponseOptions,
): InvoiceCallResult<InvalidInvoiceRecord> {
  assertBaseParseOptions(options, keys);
  assertInvoiceNo(options.invoiceNo);

  return mapOpenedInvoiceResponse(body, keys, options.merchantId, (data) => {
    const invoiceNo = readRequiredPatternString(
      data,
      'II_Invoice_No',
      INVOICE_NO_PATTERN,
    );
    if (!invoiceNo.ok) {
      return invoiceNo.error;
    }
    if (invoiceNo.value !== options.invoiceNo) {
      return unknownFieldResult('invoice_no_mismatch', 'II_Invoice_No');
    }

    const voidedDate = readRequiredDateTime(data, 'II_Date');
    if (!voidedDate.ok) {
      return voidedDate.error;
    }

    const uploaded = readStatusFlagBoolean(data, 'II_Upload_Status');
    if (!uploaded.ok) {
      return uploaded.error;
    }

    const uploadedDate = readOptionalUploadDateTime(data, 'II_Upload_Date');
    if (!uploadedDate.ok) {
      return uploadedDate.error;
    }

    return Object.freeze({
      kind: 'ok' as const,
      value: Object.freeze({
        invoiceNo: invoiceNo.value,
        voidedDateTime: voidedDate.value.text,
        voidedAtEpochMs: voidedDate.value.epochMs,
        uploaded: uploaded.value,
        uploadedDateTime:
          uploadedDate.value === null ? null : uploadedDate.value.text,
        uploadedAtEpochMs:
          uploadedDate.value === null ? null : uploadedDate.value.epochMs,
      }),
    });
  });
}

export function buildGetAllowanceInvalidRequest(
  input: GetAllowanceInvalidRequestInput,
  keys: EcpayKeyPair,
): EcpayJsonRequest {
  assertRequestContext(input, keys);
  assertInvoiceNo(input.invoiceNo);
  assertAllowanceNo(input.allowanceNo);

  return sealInvoiceRequest(
    input.environment,
    'getAllowanceInvalid',
    input.merchantId,
    input.timestampSeconds,
    {
      MerchantID: input.merchantId,
      InvoiceNo: input.invoiceNo,
      AllowanceNo: input.allowanceNo,
    },
    keys,
  );
}

export function parseGetAllowanceInvalidResponse(
  body: string,
  keys: EcpayKeyPair,
  options: ParseGetAllowanceInvalidResponseOptions,
): InvoiceCallResult<InvalidAllowanceRecord> {
  assertBaseParseOptions(options, keys);
  assertInvoiceNo(options.invoiceNo);
  assertAllowanceNo(options.allowanceNo);

  return mapOpenedInvoiceResponse(body, keys, options.merchantId, (data) => {
    const allowanceNo = readRequiredPatternString(
      data,
      'AI_Allow_No',
      ALLOWANCE_NO_PATTERN,
    );
    if (!allowanceNo.ok) {
      return allowanceNo.error;
    }
    if (allowanceNo.value !== options.allowanceNo) {
      return unknownFieldResult('allowance_no_mismatch', 'AI_Allow_No');
    }

    const invoiceNo = readRequiredPatternString(
      data,
      'AI_Invoice_No',
      INVOICE_NO_PATTERN,
    );
    if (!invoiceNo.ok) {
      return invoiceNo.error;
    }
    if (invoiceNo.value !== options.invoiceNo) {
      return unknownFieldResult('invoice_no_mismatch', 'AI_Invoice_No');
    }

    const voidedDate = readRequiredDateTime(data, 'AI_Date');
    if (!voidedDate.ok) {
      return voidedDate.error;
    }

    const uploaded = readStatusFlagBoolean(data, 'AI_Upload_Status');
    if (!uploaded.ok) {
      return uploaded.error;
    }

    const uploadedDate = readOptionalUploadDateTime(data, 'AI_Upload_Date');
    if (!uploadedDate.ok) {
      return uploadedDate.error;
    }

    return Object.freeze({
      kind: 'ok' as const,
      value: Object.freeze({
        allowanceNo: allowanceNo.value,
        invoiceNo: invoiceNo.value,
        voidedDateTime: voidedDate.value.text,
        voidedAtEpochMs: voidedDate.value.epochMs,
        uploaded: uploaded.value,
        uploadedDateTime:
          uploadedDate.value === null ? null : uploadedDate.value.text,
        uploadedAtEpochMs:
          uploadedDate.value === null ? null : uploadedDate.value.epochMs,
      }),
    });
  });
}
