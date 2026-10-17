import {
  signFields,
  verifySignedForm,
  type VerifySignedFormResult,
} from './checkmac.js';
import type { FormFields, ParseFormOptions } from './form.js';
import type { EcpayKeyPair } from './keys.js';

export function signAio(
  fields: FormFields | Readonly<Record<string, string>>,
  keys: EcpayKeyPair,
): FormFields {
  return signFields(fields, keys, 'sha256');
}

export function verifyAio(
  body: string | Uint8Array,
  keys: EcpayKeyPair | readonly EcpayKeyPair[],
  options?: ParseFormOptions,
): VerifySignedFormResult {
  return verifySignedForm(body, keys, 'sha256', options);
}

export const aio = Object.freeze({
  sign: signAio,
  verify: verifyAio,
});
