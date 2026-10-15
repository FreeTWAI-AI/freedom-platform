import { assertCdnSafe } from './cdn-guard.js';
import { sanitizeMessage } from './encoding.js';
import { EcpayProtocolError } from './errors.js';
import { ECPAY_ORIGINS, type EcpayEnvironment } from './index.js';

export const MINOR_PER_TWD = 100;
export const MAX_ECPAY_TWD_AMOUNT = 2_147_483_647;

const MERCHANT_ID_PATTERN = /^[0-9]{7,10}$/;
const FEE_PATTERN = /^([0-9]{1,9})(?:\.([0-9]{1,2}))?$/;

const MAX_URL_LENGTH = 200;
const FORBIDDEN_URL_SUBSTRINGS = /[&<>"'\s]|%26|%3c/i;
const DNS_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const ALL_DIGITS_PATTERN = /^[0-9]+$/;
const URL_PATHNAME_PATTERN = /^\/[A-Za-z0-9._~/-]*$/;

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    value instanceof Uint8Array
  ) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function assertMerchantId(merchantId: unknown): asserts merchantId is string {
  if (typeof merchantId !== 'string' || !MERCHANT_ID_PATTERN.test(merchantId)) {
    throw new EcpayProtocolError('invalid_input');
  }
}

export function assertEnvironment(environment: unknown): asserts environment is EcpayEnvironment {
  if (
    typeof environment !== 'string' ||
    !Object.prototype.hasOwnProperty.call(ECPAY_ORIGINS.payment, environment)
  ) {
    throw new EcpayProtocolError('invalid_input');
  }
}

export function assertNonNegativeSafeInteger(value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new EcpayProtocolError('invalid_input');
  }
}

export function assertPositiveWholeTwdMinor(amountMinor: unknown): asserts amountMinor is number {
  if (
    typeof amountMinor !== 'number' ||
    !Number.isSafeInteger(amountMinor) ||
    amountMinor <= 0 ||
    amountMinor % MINOR_PER_TWD !== 0 ||
    amountMinor / MINOR_PER_TWD > MAX_ECPAY_TWD_AMOUNT
  ) {
    throw new EcpayProtocolError('invalid_input');
  }
}

export function parseOptionalFeeMinor(raw: string | undefined): number | null {
  if (typeof raw !== 'string' || raw.length === 0) {
    return null;
  }
  const match = FEE_PATTERN.exec(raw);
  if (!match) {
    return null;
  }
  const wholePart = match[1];
  const fracPart = (match[2] ?? '').padEnd(2, '0');
  return Number(wholePart) * MINOR_PER_TWD + Number(fracPart);
}

export function parseOptionalSanitized(
  raw: string | undefined,
  maxCodePoints: number,
): string | null {
  if (typeof raw !== 'string' || raw.length === 0) {
    return null;
  }
  const cleaned = sanitizeMessage(raw, maxCodePoints);
  return cleaned.length > 0 ? cleaned : null;
}

export function assertValidEcpayHttpsUrl(rawUrl: unknown): asserts rawUrl is string {
  if (
    typeof rawUrl !== 'string' ||
    rawUrl.length === 0 ||
    rawUrl.length > MAX_URL_LENGTH ||
    FORBIDDEN_URL_SUBSTRINGS.test(rawUrl) ||
    rawUrl.includes('#') ||
    rawUrl.includes('?')
  ) {
    throw new EcpayProtocolError('invalid_input');
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new EcpayProtocolError('invalid_input');
  }

  if (
    parsed.href !== rawUrl ||
    parsed.protocol !== 'https:' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.port !== '' ||
    parsed.hash !== '' ||
    parsed.search !== '' ||
    !URL_PATHNAME_PATTERN.test(parsed.pathname)
  ) {
    throw new EcpayProtocolError('invalid_input');
  }

  const host = parsed.hostname;
  if (host.length === 0 || host.startsWith('.') || host.endsWith('.')) {
    throw new EcpayProtocolError('invalid_input');
  }
  const labels = host.split('.');
  if (labels.length < 2) {
    throw new EcpayProtocolError('invalid_input');
  }
  for (const label of labels) {
    if (!DNS_LABEL_PATTERN.test(label)) {
      throw new EcpayProtocolError('invalid_input');
    }
  }
  if (ALL_DIGITS_PATTERN.test(labels[labels.length - 1])) {
    throw new EcpayProtocolError('invalid_input');
  }

  assertCdnSafe(rawUrl);
}
