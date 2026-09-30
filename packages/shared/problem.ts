export class Problem extends Error {
  retryAfterSeconds?: number;
  constructor(public status: number, public code: string, message: string, retryAfterSeconds?: number) {
    super(message);
    if (retryAfterSeconds !== undefined) this.retryAfterSeconds = retryAfterSeconds;
  }
}
export function requireCondition(condition: unknown, status: number, code: string, message: string): asserts condition {
  if (!condition) throw new Problem(status, code, message);
}
