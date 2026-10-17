import { EcpayProtocolError, type EcpayErrorCode } from './errors.js';

const LONE_SURROGATE_PATTERN = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const CONTROL_CHAR_PATTERN = /[\u0000-\u001f\u007f-\u009f]/g;

export function assertWellFormedText(value: string): void {
  if (LONE_SURROGATE_PATTERN.test(value)) {
    throw new EcpayProtocolError('invalid_text');
  }
}

export function dotnetUrlEncode(value: string): string {
  if (typeof value !== 'string') {
    throw new EcpayProtocolError('invalid_input');
  }
  let encoded: string;
  try {
    encoded = encodeURIComponent(value);
  } catch {
    throw new EcpayProtocolError('invalid_text');
  }
  return encoded.replace(/%20/g, '+').replace(/~/g, '%7E').replace(/'/g, '%27');
}

export function formUrlDecodeWithCode(component: string, errorCode: EcpayErrorCode): string {
  if (typeof component !== 'string') {
    throw new EcpayProtocolError(errorCode);
  }
  if (LONE_SURROGATE_PATTERN.test(component)) {
    throw new EcpayProtocolError(errorCode);
  }
  try {
    return decodeURIComponent(component.replace(/\+/g, ' '));
  } catch {
    throw new EcpayProtocolError(errorCode);
  }
}

export function formUrlDecode(component: string): string {
  return formUrlDecodeWithCode(component, 'malformed_form');
}

export function sanitizeMessage(raw: string, maxCodePoints = 200): string {
  const cleaned = raw.replace(CONTROL_CHAR_PATTERN, '');
  const codePoints = Array.from(cleaned);
  return codePoints.length > maxCodePoints
    ? codePoints.slice(0, maxCodePoints).join('')
    : cleaned;
}
