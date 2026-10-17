import { aesEncryptString } from '../aes.js';
import { findCdnBlockedTerm } from '../cdn-guard.js';
import { assertWellFormedText, dotnetUrlEncode } from '../encoding.js';
import { EcpayProtocolError } from '../errors.js';
import {
  assertEnvironment,
  assertMerchantId,
  isPlainObject,
} from '../field-rules.js';
import { ECPAY_ORIGINS, type EcpayEnvironment } from '../index.js';
import { createJsonRequest, type EcpayJsonRequest } from '../json-request.js';
import { unwrapKeyPair, type EcpayKeyPair } from '../keys.js';
import {
  ECPAY_B2C_INVOICE_PATHS,
  type EcpayInvoiceOperation,
} from './profile.js';

const MAX_SEAL_ATTEMPTS = 16;

export function sealInvoiceRequest(
  environment: EcpayEnvironment,
  op: EcpayInvoiceOperation,
  merchantId: string,
  timestampSeconds: number,
  data: Readonly<Record<string, unknown>>,
  keys: EcpayKeyPair,
  isBlocked: (value: string) => string | null = findCdnBlockedTerm,
): EcpayJsonRequest {
  unwrapKeyPair(keys);
  assertEnvironment(environment);
  if (
    typeof op !== 'string' ||
    !Object.prototype.hasOwnProperty.call(ECPAY_B2C_INVOICE_PATHS, op)
  ) {
    throw new EcpayProtocolError('invalid_input');
  }
  assertMerchantId(merchantId);
  if (
    typeof timestampSeconds !== 'number' ||
    !Number.isSafeInteger(timestampSeconds) ||
    timestampSeconds <= 0
  ) {
    throw new EcpayProtocolError('invalid_input');
  }
  if (!isPlainObject(data) || typeof isBlocked !== 'function') {
    throw new EcpayProtocolError('invalid_input');
  }

  let json: string;
  try {
    json = JSON.stringify(data, (key, value: unknown) => {
      assertWellFormedText(key);
      if (typeof value === 'string') {
        assertWellFormedText(value);
      }
      return value;
    });
  } catch (err) {
    if (err instanceof EcpayProtocolError) {
      throw err;
    }
    throw new EcpayProtocolError('invalid_input');
  }

  if (typeof json !== 'string' || !json.startsWith('{')) {
    throw new EcpayProtocolError('invalid_input');
  }

  const url = `${ECPAY_ORIGINS.invoice[environment]}${ECPAY_B2C_INVOICE_PATHS[op]}`;

  for (let attempt = 0; attempt < MAX_SEAL_ATTEMPTS; attempt += 1) {
    const text =
      attempt === 0 ? json : `{${' '.repeat(attempt)}${json.slice(1)}`;
    const encryptedData = aesEncryptString(dotnetUrlEncode(text), keys);
    const body = JSON.stringify({
      PlatformID: '',
      MerchantID: merchantId,
      RqHeader: {
        Timestamp: timestampSeconds,
      },
      Data: encryptedData,
    });
    if (isBlocked(body) === null) {
      return createJsonRequest(url, body);
    }
  }

  throw new EcpayProtocolError('invalid_input');
}
