import { EcpayProtocolError } from '../errors.js';

export type InvoiceHttpStatusClassification =
  | 'response'
  | 'throttled'
  | 'unknown';

export function classifyInvoiceHttpStatus(
  status: number,
): InvoiceHttpStatusClassification {
  if (
    typeof status !== 'number' ||
    !Number.isSafeInteger(status) ||
    status < 100 ||
    status > 599
  ) {
    throw new EcpayProtocolError('invalid_input');
  }
  if (status === 200) {
    return 'response';
  }
  if (status === 403) {
    return 'throttled';
  }
  return 'unknown';
}
