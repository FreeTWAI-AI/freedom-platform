import { EcpayProtocolError } from './errors.js';

const INSPECT_CUSTOM = Symbol.for('nodejs.util.inspect.custom');
const PRIVATE_CONSTRUCTOR_TOKEN = Symbol('EcpayJsonRequest');

export interface RedactedJsonRequestJson {
  readonly method: 'POST';
  readonly url: string;
  readonly contentType: 'application/json';
  readonly body: '[redacted]';
}

const requestBodyStore = new WeakMap<EcpayJsonRequest, string>();

export class EcpayJsonRequest {
  readonly method: 'POST' = 'POST';
  readonly url: string;
  readonly contentType: 'application/json' = 'application/json';

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

  toJSON(): RedactedJsonRequestJson {
    return Object.freeze({
      method: this.method,
      url: this.url,
      contentType: this.contentType,
      body: '[redacted]' as const,
    });
  }

  toString(): string {
    return `EcpayJsonRequest POST ${this.url} [body redacted]`;
  }

  [INSPECT_CUSTOM](): string {
    return this.toString();
  }
}

Object.freeze(EcpayJsonRequest);
Object.freeze(EcpayJsonRequest.prototype);

export function createJsonRequest(
  url: string,
  bodyText: string,
): EcpayJsonRequest {
  if (typeof url !== 'string' || typeof bodyText !== 'string') {
    throw new EcpayProtocolError('invalid_input');
  }
  const instance = new EcpayJsonRequest(PRIVATE_CONSTRUCTOR_TOKEN, url);
  requestBodyStore.set(instance, bodyText);
  return instance;
}
