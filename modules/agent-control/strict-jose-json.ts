import { base64url } from 'jose';
import { BOOTSTRAP_LIMITS } from '../../contracts/execution/v1/bootstrap.js';

const invalid = (): never => { throw new Error('invalid_bootstrap_proof'); };
/** Internal bounded JOSE framing. No JSON key may be discarded before validation. */
function json(bytes: Uint8Array): unknown {
  const raw = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  let offset = 0, nodes = 0;
  const space = () => { while (/[\x20\t\r\n]/.test(raw[offset] ?? '\0')) offset++; };
  function string(): string {
    const start = offset++;
    while (offset < raw.length) {
      const char = raw[offset++];
      if (char === '"') {
        const value: string = JSON.parse(raw.slice(start, offset));
        if (/[\uD800-\uDFFF]/u.test(value)) invalid();
        return value;
      }
      if (char === '\\') offset++;
    }
    return invalid();
  }
  function value(depth: number): unknown {
    if (depth > BOOTSTRAP_LIMITS.jsonDepth || ++nodes > BOOTSTRAP_LIMITS.jsonNodes) invalid();
    space(); const char = raw[offset];
    if (char === '"') return string();
    if (char === '{' || char === '[') {
      offset++; const object = char === '{', end = object ? '}' : ']';
      const result: any = object ? Object.create(null) : [];
      space(); if (raw[offset] === end) { offset++; return result; }
      for (;;) {
        if (object) {
          if (raw[offset] !== '"') invalid(); const key = string();
          if (Object.hasOwn(result, key) || ['__proto__', 'constructor', 'prototype'].includes(key)) invalid();
          space(); if (raw[offset++] !== ':') invalid(); result[key] = value(depth + 1);
        } else result.push(value(depth + 1));
        space(); const separator = raw[offset++];
        if (separator === end) return result;
        if (separator !== ',') invalid(); space();
      }
    }
    for (const [literal, parsed] of [['true', true], ['false', false], ['null', null]] as const) {
      if (raw.startsWith(literal, offset)) { offset += literal.length; return parsed; }
    }
    const number = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(raw.slice(offset));
    if (!number || /[.eE]/.test(number[0])) return invalid();
    offset += number[0].length; const parsed = Number(number[0]);
    if (!Number.isSafeInteger(parsed) || Object.is(parsed, -0)) invalid(); return parsed;
  }
  const parsed = value(0); space(); if (offset !== raw.length) invalid(); return parsed;
}
function segment(raw: string, maxBytes: number): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$(?![\s\S])/.test(raw) || raw.length > Math.ceil(maxBytes * 4 / 3)) invalid();
  const bytes = base64url.decode(raw);
  if (bytes.byteLength > maxBytes || base64url.encode(bytes) !== raw) invalid();
  return bytes;
}
export function parseBootstrapCompact(raw: string): { header: unknown; claims: unknown } {
  if (typeof raw !== 'string' || raw.length > BOOTSTRAP_LIMITS.compactBytes) return invalid();
  const parts = raw.split('.'); if (parts.length !== 3) return invalid();
  const header = segment(parts[0], BOOTSTRAP_LIMITS.headerBytes);
  const payload = segment(parts[1], BOOTSTRAP_LIMITS.payloadBytes);
  if (segment(parts[2], 64).byteLength !== 64) return invalid();
  return { header: json(header), claims: json(payload) };
}
