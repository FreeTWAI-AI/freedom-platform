import { Buffer } from 'node:buffer';
import { createHash, timingSafeEqual } from 'node:crypto';
import { dotnetUrlEncode } from './encoding.js';
import { EcpayProtocolError } from './errors.js';
import {
  normalizeFieldEntries,
  parseForm,
  type FormFields,
  type ParseFormOptions,
} from './form.js';
import {
  unwrapKeyList,
  unwrapKeyPair,
  type EcpayKeyPair,
  type KeyMaterial,
} from './keys.js';

export type CheckMacAlgorithm = 'sha256' | 'md5';

export type VerifySignedFormFailureReason =
  | 'malformed_form'
  | 'duplicate_field'
  | 'form_too_large'
  | 'empty_form'
  | 'invalid_text'
  | 'missing_mac'
  | 'mac_mismatch';

export type VerifySignedFormResult =
  | {
      readonly ok: true;
      readonly fields: Readonly<Record<string, string>>;
      readonly keyIndex: number;
    }
  | {
      readonly ok: false;
      readonly reason: VerifySignedFormFailureReason;
    };

const CHECK_MAC_KEY_LOWER = 'checkmacvalue';
const SHA256_HEX_PATTERN = /^[0-9A-Fa-f]{64}$/;
const MD5_HEX_PATTERN = /^[0-9A-Fa-f]{32}$/;

function assertAlgorithm(algorithm: unknown): asserts algorithm is CheckMacAlgorithm {
  if (algorithm !== 'sha256' && algorithm !== 'md5') {
    throw new EcpayProtocolError('invalid_input');
  }
}

function buildSigningInputFromNormalized(
  nonMacFields: FormFields,
  material: KeyMaterial,
): string {
  if (nonMacFields.length === 0) {
    throw new EcpayProtocolError('empty_form');
  }
  const sorted = [...nonMacFields].sort(([keyA], [keyB]) => {
    const lowerA = keyA.toLowerCase();
    const lowerB = keyB.toLowerCase();
    return lowerA < lowerB ? -1 : lowerA > lowerB ? 1 : 0;
  });

  const parts: string[] = [`HashKey=${material.hashKey}`];
  for (const [key, value] of sorted) {
    parts.push(`${key}=${value}`);
  }
  parts.push(`HashIV=${material.hashIV}`);

  return dotnetUrlEncode(parts.join('&')).toLowerCase();
}

function computeMacFromNormalized(
  nonMacFields: FormFields,
  material: KeyMaterial,
  algorithm: CheckMacAlgorithm,
): string {
  const signingInput = buildSigningInputFromNormalized(nonMacFields, material);
  return createHash(algorithm).update(signingInput, 'utf8').digest('hex').toUpperCase();
}

/**
 * Internal helper (not re-exported from index.ts) that returns the lower-cased
 * .NET-URL-encoded pre-hash string for official vector verification (ECPay doc 2902).
 */
export function buildCheckMacSigningInput(
  fields: FormFields | Readonly<Record<string, string>>,
  keys: EcpayKeyPair,
): string {
  const material = unwrapKeyPair(keys);
  const normalized = normalizeFieldEntries(fields);
  const nonMacFields = normalized.filter(
    ([key]) => key.toLowerCase() !== CHECK_MAC_KEY_LOWER,
  );
  return buildSigningInputFromNormalized(nonMacFields, material);
}

export function computeCheckMacValue(
  fields: FormFields | Readonly<Record<string, string>>,
  keys: EcpayKeyPair,
  algorithm: CheckMacAlgorithm,
): string {
  const material = unwrapKeyPair(keys);
  assertAlgorithm(algorithm);
  const normalized = normalizeFieldEntries(fields);
  const nonMacFields = normalized.filter(
    ([key]) => key.toLowerCase() !== CHECK_MAC_KEY_LOWER,
  );
  return computeMacFromNormalized(nonMacFields, material, algorithm);
}

export function signFields(
  fields: FormFields | Readonly<Record<string, string>>,
  keys: EcpayKeyPair,
  algorithm: CheckMacAlgorithm,
): FormFields {
  const material = unwrapKeyPair(keys);
  assertAlgorithm(algorithm);
  const normalized = normalizeFieldEntries(fields);
  for (const [key] of normalized) {
    if (key.toLowerCase() === CHECK_MAC_KEY_LOWER) {
      throw new EcpayProtocolError('invalid_input');
    }
  }
  const mac = computeMacFromNormalized(normalized, material, algorithm);
  return Object.freeze([
    ...normalized,
    Object.freeze(['CheckMacValue', mac] as const),
  ]);
}

export function verifySignedForm(
  body: string | Uint8Array,
  keys: EcpayKeyPair | readonly EcpayKeyPair[],
  algorithm: CheckMacAlgorithm,
  options?: ParseFormOptions,
): VerifySignedFormResult {
  const keyMaterials = unwrapKeyList(keys);
  assertAlgorithm(algorithm);

  let parsed: FormFields;
  try {
    parsed = parseForm(body, options);
  } catch (err) {
    if (err instanceof EcpayProtocolError) {
      switch (err.code) {
        case 'malformed_form':
        case 'duplicate_field':
        case 'form_too_large':
        case 'empty_form':
        case 'invalid_text':
          return Object.freeze({ ok: false as const, reason: err.code });
        default:
          if (typeof body !== 'string' && !(body instanceof Uint8Array)) {
            return Object.freeze({ ok: false as const, reason: 'malformed_form' as const });
          }
          throw err;
      }
    }
    throw err;
  }

  let macValue: string | undefined;
  const nonMacFields: Array<readonly [string, string]> = [];
  for (const field of parsed) {
    if (field[0].toLowerCase() === CHECK_MAC_KEY_LOWER) {
      macValue = field[1];
    } else {
      nonMacFields.push(field);
    }
  }

  if (nonMacFields.length === 0) {
    return Object.freeze({ ok: false as const, reason: 'empty_form' as const });
  }

  const macPattern = algorithm === 'sha256' ? SHA256_HEX_PATTERN : MD5_HEX_PATTERN;
  if (macValue === undefined || !macPattern.test(macValue)) {
    return Object.freeze({ ok: false as const, reason: 'missing_mac' as const });
  }

  const receivedMacBytes = Buffer.from(macValue.toUpperCase(), 'ascii');
  let matchedKeyIndex = -1;

  for (let i = 0; i < keyMaterials.length; i += 1) {
    const computedMac = computeMacFromNormalized(nonMacFields, keyMaterials[i], algorithm);
    const computedMacBytes = Buffer.from(computedMac, 'ascii');
    const equal =
      receivedMacBytes.byteLength === computedMacBytes.byteLength &&
      timingSafeEqual(receivedMacBytes, computedMacBytes);
    if (equal && matchedKeyIndex === -1) {
      matchedKeyIndex = i;
    }
  }

  if (matchedKeyIndex === -1) {
    return Object.freeze({ ok: false as const, reason: 'mac_mismatch' as const });
  }

  const fieldsRecord: Record<string, string> = Object.create(null);
  for (const [key, value] of nonMacFields) {
    Object.defineProperty(fieldsRecord, key, {
      value,
      enumerable: true,
      writable: false,
      configurable: false,
    });
  }
  Object.freeze(fieldsRecord);

  return Object.freeze({
    ok: true as const,
    fields: fieldsRecord,
    keyIndex: matchedKeyIndex,
  });
}
