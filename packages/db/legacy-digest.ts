import { createHash } from 'node:crypto';

// Historical member receipts and migration ledgers use this exact encoding.
// It is deliberately not the future execution-contract JCS digest profile.
export function digest(value: unknown): string {
  function stable(v: any): any {
    if (Array.isArray(v)) return v.map(stable);
    if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map(k => [k,stable(v[k])]));
    return v;
  }
  return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}
