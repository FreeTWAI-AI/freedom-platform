import { EcpayProtocolError } from '../errors.js';

const PERSON_NAME_PATTERN = /^(?:\p{Script=Han}|[A-Za-z])+$/u;
const HAN_CHAR_PATTERN = /^\p{Script=Han}$/u;
const CELL_PHONE_PATTERN = /^09[0-9]{8}$/;
const ZIP_CODE_PATTERN = /^(?:[0-9]{3}|[0-9]{5}|[0-9]{6})$/;
const LONE_SURROGATE_PATTERN =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const CONTROL_CHAR_PATTERN = /[\u0000-\u001f\u007f-\u009f]/;
const FORBIDDEN_ADDRESS_CHAR_PATTERN = /[<>&]/;
const LEADING_OR_TRAILING_WHITESPACE_PATTERN = /^\s|\s$/u;

export const STORE_ID_PATTERN = /^[0-9A-Za-z]{1,6}$/;
export const LOGISTICS_ID_PATTERN = /^[0-9]{1,20}$/;
export const CVS_PAYMENT_NO_PATTERN = /^[0-9A-Za-z]{1,15}$/;
export const CVS_VALIDATION_NO_PATTERN = /^[0-9A-Za-z]{1,10}$/;

const MIN_NAME_WEIGHT = 4;
const MAX_NAME_WEIGHT = 10;
const MIN_ADDRESS_CODE_POINTS = 7;
const MAX_ADDRESS_CODE_POINTS = 60;

export function assertPersonName(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !PERSON_NAME_PATTERN.test(value)) {
    throw new EcpayProtocolError('invalid_input');
  }
  let weight = 0;
  for (const ch of Array.from(value)) {
    weight += HAN_CHAR_PATTERN.test(ch) ? 2 : 1;
  }
  if (weight < MIN_NAME_WEIGHT || weight > MAX_NAME_WEIGHT) {
    throw new EcpayProtocolError('invalid_input');
  }
}

export function assertCellPhone(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !CELL_PHONE_PATTERN.test(value)) {
    throw new EcpayProtocolError('invalid_input');
  }
}

export function assertZipCode(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !ZIP_CODE_PATTERN.test(value)) {
    throw new EcpayProtocolError('invalid_input');
  }
}

export function assertHomeAddress(value: unknown): asserts value is string {
  if (
    typeof value !== 'string' ||
    LONE_SURROGATE_PATTERN.test(value) ||
    LEADING_OR_TRAILING_WHITESPACE_PATTERN.test(value) ||
    CONTROL_CHAR_PATTERN.test(value) ||
    FORBIDDEN_ADDRESS_CHAR_PATTERN.test(value)
  ) {
    throw new EcpayProtocolError('invalid_input');
  }
  const codePointCount = Array.from(value).length;
  if (
    codePointCount < MIN_ADDRESS_CODE_POINTS ||
    codePointCount > MAX_ADDRESS_CODE_POINTS
  ) {
    throw new EcpayProtocolError('invalid_input');
  }
}

export function assertStoreId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !STORE_ID_PATTERN.test(value)) {
    throw new EcpayProtocolError('invalid_input');
  }
}

export function assertAllPayLogisticsId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !LOGISTICS_ID_PATTERN.test(value)) {
    throw new EcpayProtocolError('invalid_input');
  }
}

export function assertCvsPaymentNo(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !CVS_PAYMENT_NO_PATTERN.test(value)) {
    throw new EcpayProtocolError('invalid_input');
  }
}

export function assertCvsValidationNo(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !CVS_VALIDATION_NO_PATTERN.test(value)) {
    throw new EcpayProtocolError('invalid_input');
  }
}
