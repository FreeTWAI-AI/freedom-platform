import { EcpayProtocolError } from './errors.js';

export const TAIPEI_OFFSET_MS = 8 * 60 * 60 * 1000;
export const DAY_MS = 24 * 60 * 60 * 1000;

const MIN_EPOCH_MS = Date.UTC(2000, 0, 1, 0, 0, 0, 0);
const MAX_EPOCH_MS = Date.UTC(2100, 0, 1, 0, 0, 0, 0);

const TAIPEI_DATETIME_PATTERN = /^(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;

export function assertSupportedEpochMs(epochMs: unknown): asserts epochMs is number {
  if (
    typeof epochMs !== 'number' ||
    !Number.isSafeInteger(epochMs) ||
    epochMs < MIN_EPOCH_MS ||
    epochMs > MAX_EPOCH_MS
  ) {
    throw new EcpayProtocolError('invalid_input');
  }
}

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

export function formatTaipeiDateTime(epochMs: number): string {
  assertSupportedEpochMs(epochMs);
  const taipeiDate = new Date(epochMs + TAIPEI_OFFSET_MS);
  const year = taipeiDate.getUTCFullYear();
  const month = pad2(taipeiDate.getUTCMonth() + 1);
  const day = pad2(taipeiDate.getUTCDate());
  const hour = pad2(taipeiDate.getUTCHours());
  const minute = pad2(taipeiDate.getUTCMinutes());
  const second = pad2(taipeiDate.getUTCSeconds());
  return `${year}/${month}/${day} ${hour}:${minute}:${second}`;
}

export function parseTaipeiDateTime(text: string): number | null {
  if (typeof text !== 'string') {
    return null;
  }
  const match = TAIPEI_DATETIME_PATTERN.exec(text);
  if (!match) {
    return null;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);

  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59 ||
    second < 0 ||
    second > 59
  ) {
    return null;
  }

  const taipeiAsUtcMs = Date.UTC(year, month - 1, day, hour, minute, second, 0);
  const verifyDate = new Date(taipeiAsUtcMs);
  if (
    verifyDate.getUTCFullYear() !== year ||
    verifyDate.getUTCMonth() + 1 !== month ||
    verifyDate.getUTCDate() !== day
  ) {
    return null;
  }

  return taipeiAsUtcMs - TAIPEI_OFFSET_MS;
}
