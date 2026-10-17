import { FulfilmentRuleError } from './errors.js';
import { fromTaipeiDateTime, toTaipeiDateTime } from './taipei.js';

export interface ShipByOptions {
  readonly working_days: readonly number[];
  readonly cutoff_time: string;
  readonly handling_days: number;
}

const MIN_CONFIRMED_EPOCH_MS = Date.UTC(2000, 0, 1);
const MAX_CONFIRMED_EPOCH_MS = Date.UTC(2100, 0, 1);

/**
 * Computes ship_by deadline in epoch ms (Asia/Taipei 23:59:59.000).
 * Spec §2.3:
 * - If confirmedAt local date is in working_days and strictly before cutoff_time,
 *   the start day is that date.
 * - Otherwise, start day is the next working day after it.
 * - ship_by is 23:59:59.000 Asia/Taipei of the handling_days-th working day AFTER start day.
 */
export function computeShipBy(confirmedAtEpochMs: number, options: ShipByOptions): number {
  if (
    typeof confirmedAtEpochMs !== 'number' ||
    !Number.isSafeInteger(confirmedAtEpochMs) ||
    confirmedAtEpochMs < MIN_CONFIRMED_EPOCH_MS ||
    confirmedAtEpochMs > MAX_CONFIRMED_EPOCH_MS
  ) {
    throw new FulfilmentRuleError();
  }

  if (typeof options !== 'object' || options === null) {
    throw new FulfilmentRuleError();
  }

  const { working_days, cutoff_time, handling_days } = options;

  if (!Array.isArray(working_days) || working_days.length === 0 || working_days.length > 7) {
    throw new FulfilmentRuleError();
  }

  const daysSet = new Set<number>();
  for (const day of working_days) {
    if (typeof day !== 'number' || !Number.isSafeInteger(day) || day < 1 || day > 7 || daysSet.has(day)) {
      throw new FulfilmentRuleError();
    }
    daysSet.add(day);
  }

  if (typeof cutoff_time !== 'string' || !/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(cutoff_time)) {
    throw new FulfilmentRuleError();
  }

  if (
    typeof handling_days !== 'number' ||
    !Number.isSafeInteger(handling_days) ||
    handling_days < 1 ||
    handling_days > 14
  ) {
    throw new FulfilmentRuleError();
  }

  const [cutoffH, cutoffM] = cutoff_time.split(':').map(Number);
  const cutoffMsInDay = (cutoffH * 3600 + cutoffM * 60) * 1000;

  const dt = toTaipeiDateTime(confirmedAtEpochMs);
  const timeInDay = (dt.hours * 3600 + dt.minutes * 60 + dt.seconds) * 1000 + dt.milliseconds;

  const isWorking = daysSet.has(dt.isoWeekday);
  const isBeforeCutoff = timeInDay < cutoffMsInDay;

  let currentEpoch = fromTaipeiDateTime(dt.year, dt.month, dt.day, 12, 0, 0, 0);

  if (!isWorking || !isBeforeCutoff) {
    do {
      currentEpoch += 24 * 3600 * 1000;
    } while (!daysSet.has(toTaipeiDateTime(currentEpoch).isoWeekday));
  }

  let remaining = handling_days;
  while (remaining > 0) {
    currentEpoch += 24 * 3600 * 1000;
    if (daysSet.has(toTaipeiDateTime(currentEpoch).isoWeekday)) {
      remaining--;
    }
  }

  const targetDt = toTaipeiDateTime(currentEpoch);
  return fromTaipeiDateTime(targetDt.year, targetDt.month, targetDt.day, 23, 59, 59, 0);
}
