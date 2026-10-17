import { InvoiceRuleError } from './errors.js';

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function getDaysInMonth(year: number, month: number): number {
  if (month === 2) {
    return isLeapYear(year) ? 29 : 28;
  }
  if (month === 4 || month === 6 || month === 9 || month === 11) {
    return 30;
  }
  return 31;
}

/**
 * Parses ECPay invoice date time string (yyyy-MM-dd HH:mm:ss or yyyy/MM/dd HH:mm:ss)
 * in Taiwan local time (UTC+08:00) into a UTC Date.
 */
export function parseEcpayDateTime(value: string): Date {
  if (typeof value !== 'string') {
    throw new InvoiceRuleError('Date time value must be a string');
  }

  const match = /^(\d{4})([-/])(\d{2})\2(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(value);
  if (!match) {
    throw new InvoiceRuleError('Date time format must be yyyy-MM-dd HH:mm:ss or yyyy/MM/dd HH:mm:ss');
  }

  const year = Number(match[1]);
  if (year < 2000 || year > 2099) {
    throw new InvoiceRuleError('Year must be between 2000 and 2099');
  }

  const month = Number(match[3]);
  const day = Number(match[4]);
  const hour = Number(match[5]);
  const min = Number(match[6]);
  const sec = Number(match[7]);

  if (month < 1 || month > 12) {
    throw new InvoiceRuleError('Invalid month');
  }

  if (hour < 0 || hour > 23 || min < 0 || min > 59 || sec < 0 || sec > 59) {
    throw new InvoiceRuleError('Invalid time components');
  }

  const maxDays = getDaysInMonth(year, month);
  if (day < 1 || day > maxDays) {
    throw new InvoiceRuleError('Invalid day for given month and year');
  }

  // Taiwan local time is UTC+08:00
  const utcMs = Date.UTC(year, month - 1, day, hour, min, sec) - 8 * 3600 * 1000;
  return new Date(utcMs);
}

/**
 * Returns the two-month invoice period { year, startMonth } for a given date in Taiwan local time.
 * Periods: 1 (Jan-Feb), 3 (Mar-Apr), 5 (May-Jun), 7 (Jul-Aug), 9 (Sep-Oct), 11 (Nov-Dec).
 */
export function invoicePeriod(at: Date): { year: number; startMonth: 1 | 3 | 5 | 7 | 9 | 11 } {
  if (!(at instanceof Date) || isNaN(at.getTime())) {
    throw new InvoiceRuleError('Invalid Date object');
  }

  const twMs = at.getTime() + 8 * 3600 * 1000;
  const twDate = new Date(twMs);
  const year = twDate.getUTCFullYear();
  const month = twDate.getUTCMonth() + 1; // 1..12

  const startMonth = (month % 2 === 1 ? month : month - 1) as 1 | 3 | 5 | 7 | 9 | 11;
  return { year, startMonth };
}

/**
 * Computes the statutory void deadline: 23:59:59 Taiwan time on the 13th of the month
 * following the end of the invoice period.
 * (Jan-Feb -> 13 Mar; Nov-Dec -> 13 Jan of the next year).
 */
export function voidDeadline(invoiceAt: Date): Date {
  const { year, startMonth } = invoicePeriod(invoiceAt);
  const deadlineYear = startMonth === 11 ? year + 1 : year;
  const deadlineMonth = startMonth === 11 ? 1 : startMonth + 2;

  // 13th of deadlineMonth at 23:59:59 Taiwan time (UTC+08:00)
  const utcMs = Date.UTC(deadlineYear, deadlineMonth - 1, 13, 23, 59, 59) - 8 * 3600 * 1000;
  return new Date(utcMs);
}

/**
 * Computes the platform safety deadline for voiding: voidDeadline minus 2 hours.
 */
export function platformVoidDeadline(invoiceAt: Date): Date {
  const deadline = voidDeadline(invoiceAt);
  return new Date(deadline.getTime() - 2 * 3600 * 1000);
}
