/** PostgreSQL keyset timestamps retain six fractional digits, including sub-millisecond precision. */
export function isKeysetTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(value)
    || value.startsWith('0000-')) return false;
  const date = new Date(value);
  // Date normalizes impossible dates and 24:00; comparing its UTC rendering rejects those aliases.
  return Number.isFinite(date.getTime()) && date.toISOString() === `${value.slice(0, 23)}Z`;
}
