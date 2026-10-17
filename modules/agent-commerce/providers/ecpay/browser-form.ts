import { EcpayProtocolError } from './errors.js';
import { normalizeFieldEntries, type FormFields } from './form.js';

const INSPECT_CUSTOM = Symbol.for('nodejs.util.inspect.custom');
const PRIVATE_CONSTRUCTOR_TOKEN = Symbol('EcpayBrowserForm');

export interface RedactedBrowserFormJson {
  readonly method: 'POST';
  readonly action: string;
  readonly fields: '[redacted]';
}

const formFieldsStore = new WeakMap<EcpayBrowserForm, FormFields>();

export class EcpayBrowserForm {
  readonly method: 'POST' = 'POST';
  readonly action: string;

  constructor(token: symbol, action: string) {
    if (token !== PRIVATE_CONSTRUCTOR_TOKEN) {
      throw new EcpayProtocolError('invalid_input');
    }
    this.action = action;
    Object.freeze(this);
  }

  fields(): FormFields {
    const stored = formFieldsStore.get(this);
    if (stored === undefined) {
      throw new EcpayProtocolError('invalid_input');
    }
    return stored;
  }

  toJSON(): RedactedBrowserFormJson {
    return Object.freeze({
      method: this.method,
      action: this.action,
      fields: '[redacted]' as const,
    });
  }

  toString(): string {
    return `EcpayBrowserForm POST ${this.action} [fields redacted]`;
  }

  [INSPECT_CUSTOM](): string {
    return this.toString();
  }
}

Object.freeze(EcpayBrowserForm);
Object.freeze(EcpayBrowserForm.prototype);

export function createBrowserForm(
  action: string,
  fields: FormFields,
): EcpayBrowserForm {
  const normalized = normalizeFieldEntries(fields);
  const instance = new EcpayBrowserForm(PRIVATE_CONSTRUCTOR_TOKEN, action);
  formFieldsStore.set(instance, normalized);
  return instance;
}
