import { Buffer } from 'node:buffer';
import { createCipheriv, createDecipheriv } from 'node:crypto';
import {
  assertWellFormedText,
  dotnetUrlEncode,
  formUrlDecodeWithCode,
} from './encoding.js';
import { EcpayProtocolError } from './errors.js';
import { unwrapKeyPair, type EcpayKeyPair } from './keys.js';

const STRICT_BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;
const fatalUtf8Decoder = new TextDecoder('utf-8', { fatal: true });

function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || value instanceof Uint8Array) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function aesEncryptString(plain: string, keys: EcpayKeyPair): string {
  const material = unwrapKeyPair(keys);
  if (typeof plain !== 'string') {
    throw new EcpayProtocolError('invalid_input');
  }
  assertWellFormedText(plain);
  const cipher = createCipheriv('aes-128-cbc', material.keyBytes, material.ivBytes);
  return Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]).toString('base64');
}

export function aesDecryptString(base64: string, keys: EcpayKeyPair): string {
  const material = unwrapKeyPair(keys);
  if (
    typeof base64 !== 'string' ||
    base64.length === 0 ||
    base64.length % 4 !== 0 ||
    !STRICT_BASE64_PATTERN.test(base64)
  ) {
    throw new EcpayProtocolError('invalid_base64');
  }

  const cipherBytes = Buffer.from(base64, 'base64');
  if (
    cipherBytes.byteLength === 0 ||
    cipherBytes.byteLength % 16 !== 0 ||
    cipherBytes.toString('base64') !== base64
  ) {
    throw new EcpayProtocolError('invalid_base64');
  }

  let plainBytes: Buffer;
  try {
    const decipher = createDecipheriv('aes-128-cbc', material.keyBytes, material.ivBytes);
    plainBytes = Buffer.concat([decipher.update(cipherBytes), decipher.final()]);
  } catch {
    throw new EcpayProtocolError('decrypt_failed');
  }

  try {
    return fatalUtf8Decoder.decode(plainBytes);
  } catch {
    throw new EcpayProtocolError('decrypt_failed');
  }
}

export function encryptData(
  payload: Readonly<Record<string, unknown>>,
  keys: EcpayKeyPair,
): string {
  unwrapKeyPair(keys);
  if (!isPlainObject(payload)) {
    throw new EcpayProtocolError('invalid_input');
  }
  let json: string;
  try {
    json = JSON.stringify(payload, (key, value: unknown) => {
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
  if (typeof json !== 'string') {
    throw new EcpayProtocolError('invalid_input');
  }
  const urlEncoded = dotnetUrlEncode(json);
  return aesEncryptString(urlEncoded, keys);
}

export function decryptData(data: string, keys: EcpayKeyPair): unknown {
  const decrypted = aesDecryptString(data, keys);
  const decoded = formUrlDecodeWithCode(decrypted, 'invalid_encoding');
  try {
    return JSON.parse(decoded);
  } catch {
    throw new EcpayProtocolError('invalid_json');
  }
}
