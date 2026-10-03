import type { PoolClient } from 'pg';
import { AdapterFault } from './adapters/common.js';

/** Additional server-only invocation authority. Domain authorization always
 * remains in the original transaction; this callback cannot replace it. */
export type ModelStepInvocationGuard = (q: PoolClient) => Promise<void>;
const deadlines = new WeakMap<ModelStepInvocationGuard, { expiry: number; monotonic: number }>();
const localInvocation: ModelStepInvocationGuard = async () => {};
/** Bind the SQL-issued deadline to the callable, never to request JSON or
 * mutable/global context. Monotonic time also fences wall-clock regression. */
export function bindModelStepInvocationDeadline(revalidate: ModelStepInvocationGuard, expiresAt: string): ModelStepInvocationGuard {
  if (typeof revalidate !== 'function') throw new AdapterFault('execution_authority_unavailable');
  const expiry = Date.parse(expiresAt), remaining = expiry - Date.now();
  if (!Number.isFinite(expiry) || remaining <= 0) throw new AdapterFault('execution_authority_unavailable');
  const guarded: ModelStepInvocationGuard = async q => {
    assertModelStepInvocationTime(guarded); await revalidate(q); assertModelStepInvocationTime(guarded);
  };
  deadlines.set(guarded, { expiry, monotonic: performance.now() + remaining });
  return guarded;
}
export function modelStepInvocationExpiry(guard: ModelStepInvocationGuard): number { return deadlines.get(guard)?.expiry ?? Infinity; }
export function assertModelStepInvocationTime(guard: ModelStepInvocationGuard): void {
  const deadline = deadlines.get(guard);
  if (deadline && (Date.now() >= deadline.expiry || performance.now() >= deadline.monotonic)) throw new AdapterFault('execution_authority_unavailable');
}
export function captureModelStepInvocation(guard?: ModelStepInvocationGuard): ModelStepInvocationGuard {
  if (guard === undefined) return localInvocation;
  if (typeof guard !== 'function') throw new AdapterFault('execution_authority_unavailable');
  return guard;
}
