import { findCdnBlockedTerm } from './cdn-guard.js';
import { EcpayProtocolError } from './errors.js';

const PREFIX_PATTERN = /^[A-Z]$/;
const TRADE_NUMBER_PATTERN = /^[A-Z][0-9A-HJKMNP-TV-Z]{19}$/;
const CROCKFORD_BASE32_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const RANDOM_BYTE_LENGTH = 12;
const MAX_GENERATION_ATTEMPTS = 16;

function defaultRandomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

export function newTradeNumber(
  prefix: string,
  randomBytes: (length: number) => Uint8Array = defaultRandomBytes,
): string {
  if (typeof prefix !== 'string' || !PREFIX_PATTERN.test(prefix)) {
    throw new EcpayProtocolError('invalid_input');
  }
  if (typeof randomBytes !== 'function') {
    throw new EcpayProtocolError('invalid_input');
  }

  for (let attempt = 0; attempt < MAX_GENERATION_ATTEMPTS; attempt += 1) {
    const bytes = randomBytes(RANDOM_BYTE_LENGTH);
    if (!(bytes instanceof Uint8Array) || bytes.byteLength !== RANDOM_BYTE_LENGTH) {
      throw new EcpayProtocolError('invalid_input');
    }

    let value = 0n;
    for (let i = 0; i < RANDOM_BYTE_LENGTH; i += 1) {
      value = (value << 8n) | BigInt(bytes[i]);
    }
    // Drop the lowest bit to retain the top 95 bits (19 × 5-bit Crockford Base32 symbols).
    value >>= 1n;

    let out = prefix;
    for (let i = 18; i >= 0; i -= 1) {
      const index = Number((value >> BigInt(i * 5)) & 31n);
      out += CROCKFORD_BASE32_ALPHABET[index];
    }

    if (findCdnBlockedTerm(out) === null) {
      return out;
    }
  }

  throw new EcpayProtocolError('invalid_input');
}

export function isTradeNumber(value: string, prefix?: string): boolean {
  if (typeof value !== 'string' || !TRADE_NUMBER_PATTERN.test(value)) {
    return false;
  }
  if (prefix !== undefined) {
    if (typeof prefix !== 'string' || !PREFIX_PATTERN.test(prefix)) {
      return false;
    }
    return value[0] === prefix;
  }
  return true;
}
