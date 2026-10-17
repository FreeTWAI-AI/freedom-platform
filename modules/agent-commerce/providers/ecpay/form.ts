import { Buffer } from 'node:buffer';
import {
  assertWellFormedText,
  dotnetUrlEncode,
  formUrlDecode,
  sanitizeMessage,
} from './encoding.js';
import { EcpayProtocolError } from './errors.js';

export type FormFields = ReadonlyArray<readonly [string, string]>;

export interface ParseFormOptions {
  readonly maxBytes?: number;
  readonly maxFields?: number;
}

export type PipeResponse =
  | { readonly kind: 'ok'; readonly rest: string }
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'unparseable' };

const DEFAULT_MAX_BYTES = 16384;
const DEFAULT_MAX_FIELDS = 128;
const FIELD_KEY_PATTERN = /^[A-Za-z0-9_]{1,64}$/;
const ASCII_WHITESPACE_TRIM = /^[ \t\r\n\f\v]+|[ \t\r\n\f\v]+$/g;
const fatalUtf8Decoder = new TextDecoder('utf-8', { fatal: true });

function resolveLimit(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new EcpayProtocolError('invalid_input');
  }
  return value;
}

export function parseForm(body: string | Uint8Array, options?: ParseFormOptions): FormFields {
  const maxBytes = resolveLimit(options?.maxBytes, DEFAULT_MAX_BYTES);
  const maxFields = resolveLimit(options?.maxFields, DEFAULT_MAX_FIELDS);

  let text: string;
  if (body instanceof Uint8Array) {
    if (body.byteLength === 0) {
      throw new EcpayProtocolError('empty_form');
    }
    if (body.byteLength > maxBytes) {
      throw new EcpayProtocolError('form_too_large');
    }
    try {
      text = fatalUtf8Decoder.decode(body);
    } catch {
      throw new EcpayProtocolError('invalid_text');
    }
  } else if (typeof body === 'string') {
    assertWellFormedText(body);
    if (body.length === 0) {
      throw new EcpayProtocolError('empty_form');
    }
    if (Buffer.byteLength(body, 'utf8') > maxBytes) {
      throw new EcpayProtocolError('form_too_large');
    }
    text = body;
  } else {
    throw new EcpayProtocolError('invalid_input');
  }

  const segments = text.split('&');
  if (segments.length > maxFields) {
    throw new EcpayProtocolError('form_too_large');
  }

  const seenKeys = new Set<string>();
  const fields: Array<readonly [string, string]> = [];

  for (const segment of segments) {
    if (segment.length === 0) {
      throw new EcpayProtocolError('malformed_form');
    }
    const eqIndex = segment.indexOf('=');
    if (eqIndex <= 0) {
      throw new EcpayProtocolError('malformed_form');
    }
    const key = segment.slice(0, eqIndex);
    if (!FIELD_KEY_PATTERN.test(key)) {
      throw new EcpayProtocolError('malformed_form');
    }
    const lowerKey = key.toLowerCase();
    if (seenKeys.has(lowerKey)) {
      throw new EcpayProtocolError('duplicate_field');
    }
    seenKeys.add(lowerKey);

    const rawValue = segment.slice(eqIndex + 1);
    const decodedValue = formUrlDecode(rawValue);
    fields.push(Object.freeze([key, decodedValue] as const));
  }

  return Object.freeze(fields);
}

export function normalizeFieldEntries(
  fields: FormFields | Readonly<Record<string, string>>,
): FormFields {
  if (fields === null || typeof fields !== 'object' || fields instanceof Uint8Array) {
    throw new EcpayProtocolError('invalid_input');
  }

  let rawEntries: ReadonlyArray<readonly [unknown, unknown]>;
  if (Array.isArray(fields)) {
    for (const entry of fields) {
      if (!Array.isArray(entry) || entry.length !== 2) {
        throw new EcpayProtocolError('invalid_input');
      }
    }
    rawEntries = fields as ReadonlyArray<readonly [unknown, unknown]>;
  } else {
    const proto = Object.getPrototypeOf(fields);
    if (proto !== Object.prototype && proto !== null) {
      throw new EcpayProtocolError('invalid_input');
    }
    rawEntries = Object.entries(fields);
  }

  const seenKeys = new Set<string>();
  const normalized: Array<readonly [string, string]> = [];

  for (const [rawKey, rawValue] of rawEntries) {
    if (typeof rawKey !== 'string' || typeof rawValue !== 'string') {
      throw new EcpayProtocolError('invalid_input');
    }
    if (!FIELD_KEY_PATTERN.test(rawKey)) {
      throw new EcpayProtocolError('invalid_input');
    }
    assertWellFormedText(rawValue);
    const lowerKey = rawKey.toLowerCase();
    if (seenKeys.has(lowerKey)) {
      throw new EcpayProtocolError('duplicate_field');
    }
    seenKeys.add(lowerKey);
    normalized.push(Object.freeze([rawKey, rawValue] as const));
  }

  return Object.freeze(normalized);
}

export function encodeForm(fields: FormFields | Readonly<Record<string, string>>): string {
  const normalized = normalizeFieldEntries(fields);
  if (normalized.length === 0) {
    throw new EcpayProtocolError('empty_form');
  }
  const parts: string[] = [];
  for (const [key, value] of normalized) {
    parts.push(`${dotnetUrlEncode(key)}=${dotnetUrlEncode(value)}`);
  }
  return parts.join('&');
}

export function parsePipeResponse(text: string): PipeResponse {
  if (typeof text !== 'string') {
    return Object.freeze({ kind: 'unparseable' as const });
  }
  const trimmed = text.replace(ASCII_WHITESPACE_TRIM, '');
  const pipeIndex = trimmed.indexOf('|');
  if (pipeIndex === -1) {
    return Object.freeze({ kind: 'unparseable' as const });
  }
  const prefix = trimmed.slice(0, pipeIndex);
  const rest = trimmed.slice(pipeIndex + 1);
  if (prefix === '1') {
    if (rest.length === 0) {
      return Object.freeze({ kind: 'unparseable' as const });
    }
    return Object.freeze({ kind: 'ok' as const, rest });
  }
  if (prefix === '0') {
    return Object.freeze({ kind: 'error' as const, message: sanitizeMessage(rest) });
  }
  return Object.freeze({ kind: 'unparseable' as const });
}
