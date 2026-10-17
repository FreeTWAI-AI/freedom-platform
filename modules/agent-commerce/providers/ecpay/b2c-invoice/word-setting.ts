import { EcpayProtocolError } from '../errors.js';
import { isPlainObject } from '../field-rules.js';
import type { EcpayJsonRequest } from '../json-request.js';
import type { EcpayKeyPair } from '../keys.js';
import { sealInvoiceRequest } from './envelope.js';
import {
  ROC_YEAR_PATTERN,
  TRACK_HEADER_PATTERN,
  TRACK_ID_PATTERN,
  TRACK_NUMBER_PATTERN,
  assertRequestContext,
  type InvoiceRequestContext,
} from './fields.js';
import {
  assertBaseParseOptions,
  mapOpenedInvoiceResponse,
  readRequiredPatternString,
  unknownFieldResult,
  type FieldReadResult,
  type InvoiceCallResult,
  type ParseInvoiceResponseOptions,
} from './result.js';

const ONE_TO_SIX_DIGIT_PATTERN = /^[1-6]$/;

export type WordSettingTermInput = 0 | 1 | 2 | 3 | 4 | 5 | 6;
export type WordSettingUseStatusInput = 0 | 1 | 2 | 3 | 4 | 5 | 6;
export type WordTrackTerm = 1 | 2 | 3 | 4 | 5 | 6;
export type WordTrackUseStatus = 1 | 2 | 3 | 4 | 5 | 6;
export type WordTrackInvType = '07' | '08';

export interface WordSettingRequestInput extends InvoiceRequestContext {
  readonly invoiceYear: string;
  readonly invoiceTerm: WordSettingTermInput;
  readonly useStatus: WordSettingUseStatusInput;
  readonly invType: WordTrackInvType | null;
}

export interface WordTrack {
  readonly trackId: string;
  readonly invoiceYear: string;
  readonly invoiceTerm: WordTrackTerm;
  readonly invType: WordTrackInvType;
  readonly header: string;
  readonly start: string;
  readonly end: string;
  readonly lastUsed: string | null;
  readonly useStatus: WordTrackUseStatus;
}

export interface WordSettingResult {
  readonly tracks: readonly WordTrack[];
}

function assertZeroToSixInteger(
  value: unknown,
): asserts value is 0 | 1 | 2 | 3 | 4 | 5 | 6 {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > 6
  ) {
    throw new EcpayProtocolError('invalid_input');
  }
}

export function buildWordSettingRequest(
  input: WordSettingRequestInput,
  keys: EcpayKeyPair,
): EcpayJsonRequest {
  assertRequestContext(input, keys);

  if (
    typeof input.invoiceYear !== 'string' ||
    !ROC_YEAR_PATTERN.test(input.invoiceYear)
  ) {
    throw new EcpayProtocolError('invalid_input');
  }
  assertZeroToSixInteger(input.invoiceTerm);
  assertZeroToSixInteger(input.useStatus);
  if (
    input.invType !== null &&
    input.invType !== '07' &&
    input.invType !== '08'
  ) {
    throw new EcpayProtocolError('invalid_input');
  }

  const data: Record<string, unknown> = {
    MerchantID: input.merchantId,
    InvoiceYear: input.invoiceYear,
    InvoiceTerm: input.invoiceTerm,
    UseStatus: input.useStatus,
    InvoiceCategory: 1,
  };
  if (input.invType !== null) {
    data.InvType = input.invType;
  }

  return sealInvoiceRequest(
    input.environment,
    'wordSetting',
    input.merchantId,
    input.timestampSeconds,
    data,
    keys,
  );
}

function readOneToSixField(
  record: Readonly<Record<string, unknown>>,
  key: string,
  fieldName: string,
): FieldReadResult<1 | 2 | 3 | 4 | 5 | 6> {
  const raw = record[key];
  if (raw === undefined || raw === null || raw === '') {
    return { ok: false, error: unknownFieldResult('missing_field', fieldName) };
  }
  if (typeof raw === 'number') {
    if (Number.isSafeInteger(raw) && raw >= 1 && raw <= 6) {
      return { ok: true, value: raw as 1 | 2 | 3 | 4 | 5 | 6 };
    }
    return { ok: false, error: unknownFieldResult('invalid_field', fieldName) };
  }
  if (typeof raw === 'string' && ONE_TO_SIX_DIGIT_PATTERN.test(raw)) {
    return { ok: true, value: Number(raw) as 1 | 2 | 3 | 4 | 5 | 6 };
  }
  return { ok: false, error: unknownFieldResult('invalid_field', fieldName) };
}

function readTrackInvType(
  record: Readonly<Record<string, unknown>>,
  fieldName: string,
): FieldReadResult<WordTrackInvType> {
  const raw = record.InvType;
  if (raw === undefined || raw === null || raw === '') {
    return { ok: false, error: unknownFieldResult('missing_field', fieldName) };
  }
  if (raw === '07' || raw === '08') {
    return { ok: true, value: raw };
  }
  return { ok: false, error: unknownFieldResult('invalid_field', fieldName) };
}

function parseSingleWordTrack(
  rawEntry: unknown,
  prefix: string,
): FieldReadResult<WordTrack> {
  if (!isPlainObject(rawEntry)) {
    return { ok: false, error: unknownFieldResult('invalid_field', prefix) };
  }

  const trackId = readRequiredPatternString(
    rawEntry,
    'TrackID',
    TRACK_ID_PATTERN,
    `${prefix}.TrackID`,
  );
  if (!trackId.ok) {
    return trackId;
  }

  const invoiceYear = readRequiredPatternString(
    rawEntry,
    'InvoiceYear',
    ROC_YEAR_PATTERN,
    `${prefix}.InvoiceYear`,
  );
  if (!invoiceYear.ok) {
    return invoiceYear;
  }

  const invoiceTerm = readOneToSixField(
    rawEntry,
    'InvoiceTerm',
    `${prefix}.InvoiceTerm`,
  );
  if (!invoiceTerm.ok) {
    return invoiceTerm;
  }

  const invType = readTrackInvType(rawEntry, `${prefix}.InvType`);
  if (!invType.ok) {
    return invType;
  }

  const header = readRequiredPatternString(
    rawEntry,
    'InvoiceHeader',
    TRACK_HEADER_PATTERN,
    `${prefix}.InvoiceHeader`,
  );
  if (!header.ok) {
    return header;
  }

  const start = readRequiredPatternString(
    rawEntry,
    'InvoiceStart',
    TRACK_NUMBER_PATTERN,
    `${prefix}.InvoiceStart`,
  );
  if (!start.ok) {
    return start;
  }

  const end = readRequiredPatternString(
    rawEntry,
    'InvoiceEnd',
    TRACK_NUMBER_PATTERN,
    `${prefix}.InvoiceEnd`,
  );
  if (!end.ok) {
    return end;
  }
  if (end.value < start.value) {
    return {
      ok: false,
      error: unknownFieldResult('invalid_field', `${prefix}.InvoiceEnd`),
    };
  }

  const rawLastUsed = rawEntry.InvoiceNo;
  let lastUsed: string | null = null;
  if (rawLastUsed !== undefined && rawLastUsed !== null && rawLastUsed !== '') {
    if (
      typeof rawLastUsed !== 'string' ||
      !TRACK_NUMBER_PATTERN.test(rawLastUsed)
    ) {
      return {
        ok: false,
        error: unknownFieldResult('invalid_field', `${prefix}.InvoiceNo`),
      };
    }
    lastUsed = rawLastUsed;
  }

  const useStatus = readOneToSixField(
    rawEntry,
    'UseStatus',
    `${prefix}.UseStatus`,
  );
  if (!useStatus.ok) {
    return useStatus;
  }

  return {
    ok: true,
    value: Object.freeze({
      trackId: trackId.value,
      invoiceYear: invoiceYear.value,
      invoiceTerm: invoiceTerm.value,
      invType: invType.value,
      header: header.value,
      start: start.value,
      end: end.value,
      lastUsed,
      useStatus: useStatus.value,
    }),
  };
}

export function parseWordSettingResponse(
  body: string,
  keys: EcpayKeyPair,
  options: ParseInvoiceResponseOptions,
): InvoiceCallResult<WordSettingResult> {
  assertBaseParseOptions(options, keys);

  return mapOpenedInvoiceResponse(body, keys, options.merchantId, (data) => {
    const rawInfo = data.InvoiceInfo;
    if (rawInfo === undefined || rawInfo === null || rawInfo === '') {
      return unknownFieldResult('missing_field', 'InvoiceInfo');
    }

    const tracks: WordTrack[] = [];
    if (Array.isArray(rawInfo)) {
      for (let i = 0; i < rawInfo.length; i += 1) {
        const parsed = parseSingleWordTrack(rawInfo[i], `InvoiceInfo[${i}]`);
        if (!parsed.ok) {
          return parsed.error;
        }
        tracks.push(parsed.value);
      }
    } else if (isPlainObject(rawInfo)) {
      const parsed = parseSingleWordTrack(rawInfo, 'InvoiceInfo');
      if (!parsed.ok) {
        return parsed.error;
      }
      tracks.push(parsed.value);
    } else {
      return unknownFieldResult('invalid_field', 'InvoiceInfo');
    }

    return Object.freeze({
      kind: 'ok' as const,
      value: Object.freeze({
        tracks: Object.freeze(tracks),
      }),
    });
  });
}

export function wordTrackRemaining(track: WordTrack): number | null {
  if (!isPlainObject(track)) {
    throw new EcpayProtocolError('invalid_input');
  }
  if (
    typeof track.start !== 'string' ||
    !TRACK_NUMBER_PATTERN.test(track.start) ||
    typeof track.end !== 'string' ||
    !TRACK_NUMBER_PATTERN.test(track.end) ||
    track.end < track.start
  ) {
    throw new EcpayProtocolError('invalid_input');
  }

  if (track.lastUsed === null) {
    return null;
  }
  if (
    typeof track.lastUsed !== 'string' ||
    !TRACK_NUMBER_PATTERN.test(track.lastUsed)
  ) {
    throw new EcpayProtocolError('invalid_input');
  }

  const startNum = Number(track.start);
  const endNum = Number(track.end);
  const lastUsedNum = Number(track.lastUsed);
  if (lastUsedNum < startNum || lastUsedNum > endNum) {
    return null;
  }
  return endNum - lastUsedNum;
}
