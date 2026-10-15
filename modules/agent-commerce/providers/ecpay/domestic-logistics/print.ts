import {
  createBrowserForm,
  type EcpayBrowserForm,
} from '../browser-form.js';
import { assertFieldsCdnSafe } from '../cdn-guard.js';
import { EcpayProtocolError } from '../errors.js';
import {
  assertEnvironment,
  assertMerchantId,
  isPlainObject,
} from '../field-rules.js';
import type { FormFields } from '../form.js';
import { ECPAY_ORIGINS, type EcpayEnvironment } from '../index.js';
import { unwrapKeyPair, type EcpayKeyPair } from '../keys.js';
import { logistics } from '../logistics.js';
import {
  assertAllPayLogisticsId,
  assertCvsPaymentNo,
  assertCvsValidationNo,
} from './party-rules.js';
import {
  ECPAY_LOGISTICS_SUBTYPES,
  assertLogisticsSubType,
  type EcpayLogisticsSubType,
} from './profile.js';

export type PrintLabelMode = 'a4' | 'a6';

export interface PrintLabelFormInput {
  readonly environment: EcpayEnvironment;
  readonly merchantId: string;
  readonly subType: EcpayLogisticsSubType;
  readonly allPayLogisticsId: string;
  readonly cvsPaymentNo?: string;
  readonly cvsValidationNo?: string;
  readonly printMode?: PrintLabelMode;
}

const PRINT_MODE_CODES: Readonly<Record<PrintLabelMode, string>> =
  Object.freeze({
    a4: '1',
    a6: '2',
  });

export function buildPrintLabelForm(
  input: PrintLabelFormInput,
  keys: EcpayKeyPair,
): EcpayBrowserForm {
  unwrapKeyPair(keys);
  if (!isPlainObject(input)) {
    throw new EcpayProtocolError('invalid_input');
  }
  assertEnvironment(input.environment);
  assertMerchantId(input.merchantId);
  assertLogisticsSubType(input.subType);
  assertAllPayLogisticsId(input.allPayLogisticsId);

  const descriptor = ECPAY_LOGISTICS_SUBTYPES[input.subType];

  const unsignedFields: Array<readonly [string, string]> = [
    ['MerchantID', input.merchantId],
    ['AllPayLogisticsID', input.allPayLogisticsId],
  ];

  if (input.subType === 'UNIMARTC2C') {
    assertCvsPaymentNo(input.cvsPaymentNo);
    assertCvsValidationNo(input.cvsValidationNo);
    unsignedFields.push(['CVSPaymentNo', input.cvsPaymentNo]);
    unsignedFields.push(['CVSValidationNo', input.cvsValidationNo]);
  } else if (input.subType === 'FAMIC2C' || input.subType === 'HILIFEC2C') {
    assertCvsPaymentNo(input.cvsPaymentNo);
    if (input.cvsValidationNo !== undefined && input.cvsValidationNo !== null) {
      throw new EcpayProtocolError('invalid_input');
    }
    unsignedFields.push(['CVSPaymentNo', input.cvsPaymentNo]);
  } else {
    if (
      (input.cvsPaymentNo !== undefined && input.cvsPaymentNo !== null) ||
      (input.cvsValidationNo !== undefined && input.cvsValidationNo !== null)
    ) {
      throw new EcpayProtocolError('invalid_input');
    }
  }

  if (input.printMode !== undefined && input.printMode !== null) {
    if (
      !descriptor.supportsPrintMode ||
      typeof input.printMode !== 'string' ||
      !Object.prototype.hasOwnProperty.call(PRINT_MODE_CODES, input.printMode)
    ) {
      throw new EcpayProtocolError('invalid_input');
    }
    unsignedFields.push(['PrintMode', PRINT_MODE_CODES[input.printMode]]);
  }

  const fieldsToSign: FormFields = unsignedFields;
  assertFieldsCdnSafe(fieldsToSign);
  const signedFields = logistics.sign(fieldsToSign, keys);
  const action = `${ECPAY_ORIGINS.logistics[input.environment]}${descriptor.printPath}`;
  return createBrowserForm(action, signedFields);
}
