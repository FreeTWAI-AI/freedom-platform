export class RefundRuleError extends Error {
  readonly code: 'invalid_input' = 'invalid_input';

  constructor() {
    super('Invalid refund rule input');
    this.name = 'RefundRuleError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Deeply freezes an object or array in place and returns it.
 * Never call on caller-provided inputs.
 */
export function deepFreeze<T>(value: T): Readonly<T> {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const key of Object.keys(value)) {
    // @ts-expect-error indexing arbitrary frozen objects
    deepFreeze(value[key]);
  }
  return value;
}
