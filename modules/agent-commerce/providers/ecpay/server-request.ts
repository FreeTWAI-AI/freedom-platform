import { EcpayProtocolError } from './errors.js';
import { encodeForm, type FormFields } from './form.js';

const INSPECT_CUSTOM = Symbol.for('nodejs.util.inspect.custom');
const PRIVATE_CONSTRUCTOR_TOKEN = Symbol('EcpayServerRequest');

export interface RedactedServerRequestJson {
  readonly method: 'POST';
  readonly url: string;
  readonly contentType: 'application/x-www-form-urlencoded';
  readonly body: '[redacted]';
}

const requestBodyStore = new WeakMap<EcpayServerRequest, string>();

export class EcpayServerRequest {
  readonly method: 'POST' = 'POST';
  readonly url: string;
  readonly contentType: 'application/x-www-form-urlencoded' =
    'application/x-www-form-urlencoded';

  constructor(token: symbol, url: string) {
    if (token !== PRIVATE_CONSTRUCTOR_TOKEN) {
      throw new EcpayProtocolError('invalid_input');
    }
    this.url = url;
    Object.freeze(this);
  }

  bodyText(): string {
    const body = requestBodyStore.get(this);
    if (body === undefined) {
      throw new EcpayProtocolError('invalid_input');
    }
    return body;
  }

  toJSON(): RedactedServerRequestJson {
    return Object.freeze({
      method: this.method,
      url: this.url,
      contentType: this.contentType,
      body: '[redacted]' as const,
    });
  }

  toString(): string {
    return `EcpayServerRequest POST ${this.url} [body redacted]`;
  }

  [INSPECT_CUSTOM](): string {
    return this.toString();
  }
}

Object.freeze(EcpayServerRequest);
Object.freeze(EcpayServerRequest.prototype);

export function createServerRequest(
  url: string,
  signedFields: FormFields,
): EcpayServerRequest {
  const body = encodeForm(signedFields);
  const instance = new EcpayServerRequest(PRIVATE_CONSTRUCTOR_TOKEN, url);
  requestBodyStore.set(instance, body);
  return instance;
}
