import {
  DAY_MS,
  TAIPEI_OFFSET_MS,
  assertSupportedEpochMs,
} from '../taipei-time.js';

const DO_ACTION_BLACKOUT_START_MS = (20 * 60 + 15) * 60 * 1000;
const DO_ACTION_BLACKOUT_END_MS = (20 * 60 + 31) * 60 * 1000;
const NEXT_DAY_CANCEL_EARLIEST_OFFSET_MS = (24 + 6) * 60 * 60 * 1000;

export type DoActionWindowResult =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly retryAtEpochMs: number };

export function doActionWindow(epochMs: number): DoActionWindowResult {
  assertSupportedEpochMs(epochMs);
  const taipeiMs = epochMs + TAIPEI_OFFSET_MS;
  const msOfDay = taipeiMs % DAY_MS;

  if (msOfDay >= DO_ACTION_BLACKOUT_START_MS && msOfDay < DO_ACTION_BLACKOUT_END_MS) {
    const retryAtEpochMs = epochMs - msOfDay + DO_ACTION_BLACKOUT_END_MS;
    return Object.freeze({
      allowed: false as const,
      retryAtEpochMs,
    });
  }

  return Object.freeze({ allowed: true as const });
}

export function nextDayCancelEarliest(authorisedAtEpochMs: number): number {
  assertSupportedEpochMs(authorisedAtEpochMs);
  const taipeiMs = authorisedAtEpochMs + TAIPEI_OFFSET_MS;
  const msOfDay = taipeiMs % DAY_MS;
  const taipeiDayStartMs = taipeiMs - msOfDay;
  return taipeiDayStartMs + NEXT_DAY_CANCEL_EARLIEST_OFFSET_MS - TAIPEI_OFFSET_MS;
}
