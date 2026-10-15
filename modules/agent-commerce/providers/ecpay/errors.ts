export type EcpayErrorCode =
  | 'invalid_key'
  | 'invalid_check_code'
  | 'invalid_text'
  | 'invalid_input'
  | 'unsupported_environment'
  | 'malformed_form'
  | 'duplicate_field'
  | 'form_too_large'
  | 'empty_form'
  | 'invalid_base64'
  | 'decrypt_failed'
  | 'invalid_encoding'
  | 'invalid_json';

const ERROR_MESSAGES: Readonly<Record<EcpayErrorCode, string>> = Object.freeze({
  invalid_key: 'Invalid ECPay HashKey or HashIV; expected a 16-character alphanumeric string.',
  invalid_check_code: 'Invalid ECPay CreditCheckCode; expected an 8-digit numeric string.',
  invalid_text: 'Invalid text encoding; input contains malformed UTF-8 or a lone UTF-16 surrogate.',
  invalid_input: 'Invalid input parameter for ECPay protocol operation.',
  unsupported_environment: 'ECPay operation is only supported in the live environment.',
  malformed_form: 'Malformed URL-encoded form body or field key.',
  duplicate_field: 'Duplicate form field key (case-insensitive).',
  form_too_large: 'Form body exceeds maximum byte length or field count.',
  empty_form: 'Form body or field set is empty.',
  invalid_base64: 'Invalid Base64 ciphertext; expected padded 16-byte aligned Base64.',
  decrypt_failed: 'AES-128-CBC decryption or UTF-8 decoding failed.',
  invalid_encoding: 'Decrypted payload is not valid URL-encoded UTF-8.',
  invalid_json: 'Decrypted payload is not valid JSON.',
});

export class EcpayProtocolError extends Error {
  readonly code: EcpayErrorCode;

  constructor(code: EcpayErrorCode) {
    const resolvedCode: EcpayErrorCode = Object.prototype.hasOwnProperty.call(ERROR_MESSAGES, code)
      ? code
      : 'invalid_input';
    super(ERROR_MESSAGES[resolvedCode]);
    this.name = 'EcpayProtocolError';
    this.code = resolvedCode;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
