export class InvoiceRuleError extends Error {
  readonly code: 'invalid_input' = 'invalid_input';

  constructor(message = 'Invalid invoice rule input') {
    super(message);
    this.name = 'InvoiceRuleError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Validates that an amount in minor units is a non-negative safe integer
 * and a multiple of 100 (representing whole NT$).
 */
export function assertMinorMoney(minor: unknown): asserts minor is number {
  if (
    typeof minor !== 'number' ||
    !Number.isSafeInteger(minor) ||
    minor < 0 ||
    minor % 100 !== 0 ||
    Object.is(minor, -0)
  ) {
    throw new InvoiceRuleError('Amount must be a non-negative safe integer multiple of 100');
  }
}
