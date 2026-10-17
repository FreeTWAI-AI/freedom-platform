export const TAIPEI_OFFSET_MS = 8 * 3600 * 1000;

export interface TaipeiDateTime {
  readonly year: number;
  readonly month: number; // 1-12
  readonly day: number;   // 1-31
  readonly hours: number; // 0-23
  readonly minutes: number; // 0-59
  readonly seconds: number; // 0-59
  readonly milliseconds: number; // 0-999
  readonly isoWeekday: number;   // 1 (Monday) .. 7 (Sunday)
}

/**
 * Converts epoch ms to Asia/Taipei calendar components using pure arithmetic and UTC getters.
 */
export function toTaipeiDateTime(epochMs: number): TaipeiDateTime {
  const d = new Date(epochMs + TAIPEI_OFFSET_MS);
  const dayOfWeek = d.getUTCDay();
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hours: d.getUTCHours(),
    minutes: d.getUTCMinutes(),
    seconds: d.getUTCSeconds(),
    milliseconds: d.getUTCMilliseconds(),
    isoWeekday: dayOfWeek === 0 ? 7 : dayOfWeek,
  };
}

/**
 * Converts Asia/Taipei calendar components to epoch ms using Date.UTC and fixed +08:00 offset.
 */
export function fromTaipeiDateTime(
  year: number,
  month: number, // 1-12
  day: number,
  hours = 0,
  minutes = 0,
  seconds = 0,
  milliseconds = 0,
): number {
  return Date.UTC(year, month - 1, day, hours, minutes, seconds, milliseconds) - TAIPEI_OFFSET_MS;
}
