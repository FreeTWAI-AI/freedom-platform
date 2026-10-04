import { ExecutionInputSchema, type ExecutionInput } from '../../contracts/execution/v1/state.js';

export const EXECUTION_LIMITS = Object.freeze({ inputBytes: 32768, snapshotBytes: 24576, depth: 24, nodes: 4096, attempts: 16, dispatches: 128, evidence: 128 });
export class ExecutionInputError extends Error {
  constructor(readonly code: 'invalid_input'|'input_limit' = 'invalid_input') { super(code); this.name = 'ExecutionInputError'; }
}
const invalid = (): never => { throw new ExecutionInputError(); };
const limit = (): never => { throw new ExecutionInputError('input_limit'); };
const scalarString = (value: string) => { if (/[\uD800-\uDFFF]/u.test(value)) invalid(); return value; };
export function freezeTree<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freezeTree(child); Object.freeze(value); }
  return value;
}

/** Bounded JSON grammar with decoded-key duplicate rejection. JSON.parse alone
 * would irreversibly discard duplicates. This is NOT a JCS implementation. */
function strictJson(raw: string): unknown {
  if (raw.length > EXECUTION_LIMITS.inputBytes) limit();
  if (new TextEncoder().encode(raw).byteLength > EXECUTION_LIMITS.inputBytes) limit();
  let index = 0, nodes = 0;
  const whitespace = () => { while (/[\x20\t\r\n]/.test(raw[index] ?? '') && index < raw.length) index++; };
  function string(): string {
    const start = index++; let escaped = false;
    for (; index < raw.length; index++) {
      const char = raw[index];
      if (!escaped && char === '"') {
        index++;
        try { return scalarString(JSON.parse(raw.slice(start, index))); } catch { return invalid(); }
      }
      if (!escaped && char === '\\') escaped = true; else escaped = false;
    }
    return invalid();
  }
  function value(depth: number): unknown {
    if (depth > EXECUTION_LIMITS.depth || ++nodes > EXECUTION_LIMITS.nodes) limit();
    whitespace(); const char = raw[index];
    if (char === '"') return string();
    if (char === '{') {
      index++; whitespace(); const object: Record<string, unknown> = Object.create(null), keys = new Set<string>();
      if (raw[index] === '}') { index++; return object; }
      for (;;) {
        whitespace(); if (raw[index] !== '"') invalid(); const key = string();
        if (keys.has(key) || ['__proto__', 'constructor', 'prototype'].includes(key)) invalid(); keys.add(key);
        whitespace(); if (raw[index++] !== ':') invalid(); object[key] = value(depth + 1); whitespace();
        if (raw[index] === '}') { index++; return object; }
        if (raw[index++] !== ',') invalid();
      }
    }
    if (char === '[') {
      index++; whitespace(); const array: unknown[] = [];
      if (raw[index] === ']') { index++; return array; }
      for (;;) { array.push(value(depth + 1)); whitespace(); if (raw[index] === ']') { index++; return array; } if (raw[index++] !== ',') invalid(); }
    }
    for (const [literal, parsed] of [['true', true], ['false', false], ['null', null]] as const) {
      if (raw.startsWith(literal, index)) { index += literal.length; return parsed; }
    }
    const number = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(raw.slice(index));
    if (!number) return invalid();
    // This closed wire profile permits integer tokens only, never rounded
    // fractions/exponents (even when Number would happen to return an integer).
    if (/[.eE]/.test(number[0])) invalid();
    index += number[0].length; const parsed = Number(number[0]);
    if (!Number.isSafeInteger(parsed) || Object.is(parsed, -0)) invalid(); return parsed;
  }
  const parsed = value(0); whitespace(); if (index !== raw.length) invalid(); return parsed;
}

/** Defend the object-call convenience API without invoking getters/toJSON or
 * silently dropping undefined/symbol values. No input object is ever frozen. */
export function snapshotInput(raw: unknown): unknown {
  let nodes = 0, bytes = 0; const seen = new Set<object>();
  const charge = (amount: number) => { bytes += amount; if (bytes > EXECUTION_LIMITS.inputBytes) limit(); };
  function string(value: string) {
    if (value.length > EXECUTION_LIMITS.inputBytes) limit();
    scalarString(value); charge(2);
    // Account escaped JSON bytes before allocating a serialized string.
    for (const char of value) {
      const cp = char.codePointAt(0)!;
      charge(cp < 32 ? [8, 9, 10, 12, 13].includes(cp) ? 2 : 6
        : char === '"' || char === '\\' ? 2 : cp < 128 ? 1 : cp < 2048 ? 2 : cp < 65536 ? 3 : 4);
    }
    return value;
  }
  function copy(value: unknown, depth: number): unknown {
    if (depth > EXECUTION_LIMITS.depth || ++nodes > EXECUTION_LIMITS.nodes) return limit();
    if (value === null || typeof value === 'boolean') { charge(value === false ? 5 : 4); return value; }
    if (typeof value === 'string') return string(value);
    if (typeof value === 'number') { if (!Number.isSafeInteger(value) || Object.is(value, -0)) invalid(); charge(String(value).length); return value; }
    if (!value || typeof value !== 'object' || seen.has(value)) return invalid();
    const array = Array.isArray(value), proto = Object.getPrototypeOf(value);
    if (!array && proto !== Object.prototype && proto !== null) invalid();
    if (array && value.length > EXECUTION_LIMITS.nodes) limit();
    charge(2); let entries = 0;
    seen.add(value); const result: any = array ? [] : Object.create(null);
    for (const key of Reflect.ownKeys(value)) {
      if (array && key === 'length') continue;
      if (typeof key !== 'string' || ['__proto__', 'constructor', 'prototype'].includes(key)) invalid();
      const desc = Object.getOwnPropertyDescriptor(value, key)!;
      if (!desc.enumerable || !('value' in desc) || array && (!/^(0|[1-9][0-9]*)$/.test(key as string)
        || Number(key) >= (value as unknown[]).length)) invalid();
      if (entries++) charge(1);
      if (!array) { string(key as string); charge(1); }
      result[key] = copy(desc.value, depth + 1);
    }
    if (array && Object.keys(result).length !== (value as unknown[]).length) invalid();
    seen.delete(value); return result;
  }
  const result = copy(raw, 0);
  return result;
}
/** Server-internal bounded JSON parsing only; success grants no authority. */
export function parseBoundedJson(raw: string): unknown { return strictJson(raw); }
export function decodeExecutionInput(raw: string): ExecutionInput {
  if (typeof raw !== 'string') return invalid();
  const parsed = ExecutionInputSchema.safeParse(strictJson(raw));
  if (!parsed.success) return invalid(); return freezeTree(parsed.data);
}
export function parseExecutionInput(raw: unknown): ExecutionInput {
  const parsed = ExecutionInputSchema.safeParse(typeof raw === 'string' ? strictJson(raw) : snapshotInput(raw));
  if (!parsed.success) return invalid(); return parsed.data;
}
