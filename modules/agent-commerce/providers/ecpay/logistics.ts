import {
  signFields,
  verifySignedForm,
  type VerifySignedFormFailureReason,
  type VerifySignedFormResult,
} from './checkmac.js';
import {
  parsePipeResponse,
  type FormFields,
  type ParseFormOptions,
} from './form.js';
import { unwrapKeyList, type EcpayKeyPair } from './keys.js';

export type LogisticsCreateUnknownReason =
  | 'unparseable'
  | 'unexpected_ack'
  | VerifySignedFormFailureReason;

export type LogisticsCreateResult =
  | {
      readonly kind: 'created';
      readonly fields: Readonly<Record<string, string>>;
      readonly keyIndex: number;
    }
  | {
      readonly kind: 'rejected';
      readonly message: string;
    }
  | {
      readonly kind: 'unknown';
      readonly reason: LogisticsCreateUnknownReason;
    };

export function signLogistics(
  fields: FormFields | Readonly<Record<string, string>>,
  keys: EcpayKeyPair,
): FormFields {
  return signFields(fields, keys, 'md5');
}

export function verifyLogistics(
  body: string | Uint8Array,
  keys: EcpayKeyPair | readonly EcpayKeyPair[],
  options?: ParseFormOptions,
): VerifySignedFormResult {
  return verifySignedForm(body, keys, 'md5', options);
}

export function parseLogisticsCreateResponse(
  text: string,
  keys: EcpayKeyPair | readonly EcpayKeyPair[],
  options?: ParseFormOptions,
): LogisticsCreateResult {
  unwrapKeyList(keys);
  const piped = parsePipeResponse(text);
  if (piped.kind === 'unparseable') {
    return Object.freeze({ kind: 'unknown' as const, reason: 'unparseable' as const });
  }
  if (piped.kind === 'error') {
    return Object.freeze({ kind: 'rejected' as const, message: piped.message });
  }
  if (piped.rest === 'OK') {
    return Object.freeze({ kind: 'unknown' as const, reason: 'unexpected_ack' as const });
  }
  const verified = verifySignedForm(piped.rest, keys, 'md5', options);
  if (!verified.ok) {
    return Object.freeze({ kind: 'unknown' as const, reason: verified.reason });
  }
  return Object.freeze({
    kind: 'created' as const,
    fields: verified.fields,
    keyIndex: verified.keyIndex,
  });
}

export const logistics = Object.freeze({
  sign: signLogistics,
  verify: verifyLogistics,
  parseCreateResponse: parseLogisticsCreateResponse,
});
