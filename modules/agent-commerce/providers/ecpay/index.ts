export { EcpayProtocolError, type EcpayErrorCode } from './errors.js';
export { EcpayKeyPair } from './keys.js';
export { dotnetUrlEncode, formUrlDecode } from './encoding.js';
export {
  parseForm,
  encodeForm,
  parsePipeResponse,
  type FormFields,
  type ParseFormOptions,
  type PipeResponse,
} from './form.js';
export {
  computeCheckMacValue,
  signFields,
  verifySignedForm,
  type CheckMacAlgorithm,
  type VerifySignedFormFailureReason,
  type VerifySignedFormResult,
} from './checkmac.js';
export {
  aesEncryptString,
  aesDecryptString,
  encryptData,
  decryptData,
} from './aes.js';
export { newTradeNumber, isTradeNumber } from './trade-number.js';
export { findCdnBlockedTerm } from './cdn-guard.js';
export { aio } from './aio.js';
export {
  logistics,
  type LogisticsCreateResult,
  type LogisticsCreateUnknownReason,
} from './logistics.js';
export {
  invoice,
  type InvoiceEnvelopeInput,
  type InvoiceRequestEnvelope,
  type OpenInvoiceResponseOptions,
  type InvoiceOpenInvalidReason,
  type InvoiceOpenResponseResult,
} from './invoice.js';

export type EcpayEnvironment = 'sandbox' | 'live';
export type EcpayServiceKind = 'payment' | 'logistics' | 'invoice';

export const ECPAY_ORIGINS: Readonly<
  Record<EcpayServiceKind, Readonly<Record<EcpayEnvironment, string>>>
> = Object.freeze({
  payment: Object.freeze({
    sandbox: 'https://payment-stage.ecpay.com.tw',
    live: 'https://payment.ecpay.com.tw',
  }),
  logistics: Object.freeze({
    sandbox: 'https://logistics-stage.ecpay.com.tw',
    live: 'https://logistics.ecpay.com.tw',
  }),
  invoice: Object.freeze({
    sandbox: 'https://einvoice-stage.ecpay.com.tw',
    live: 'https://einvoice.ecpay.com.tw',
  }),
});

export const ECPAY_ACK = '1|OK' as const;
