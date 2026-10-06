import { z } from 'zod';
import { ModelSelectionSchema, type ModelSelection } from '../../../contracts/execution/v1/member-execution.js';
import { snapshotInput } from '../../../packages/execution-state/decode.js';
import { snapshotBoundedBytes } from '../../../packages/asset-storage/index.js';

export const MODEL_ADAPTER_LIMITS = Object.freeze({
  promptBytes: 16384, outputBytes: 16384, responseBytes: 32768,
  eventBytes: 65536, events: 64, depth: 24, nodes: 4096, outputTokens: 4096,
});
export const ADAPTER_ISSUES = Object.freeze([
  'invalid_input', 'unsupported_selection', 'unsupported_version', 'artifact_mismatch',
  'probe_unavailable', 'authentication_unavailable', 'billing_route_mismatch',
  'effective_tool_policy_unavailable', 'execution_authority_unavailable',
  'invalid_response', 'response_limit', 'model_mismatch', 'outcome_unknown', 'usage_unavailable',
] as const);
export type AdapterIssue = typeof ADAPTER_ISSUES[number];
export class AdapterFault extends Error {
  constructor(readonly code: AdapterIssue) {
    super('Model adapter request unavailable.'); this.name = 'AdapterFault';
  }
}
export interface AdapterTextInput {
  readonly selection: ModelSelection; readonly prompt: string; readonly maxOutputTokens: number;
}
export interface AdapterAssessment {
  readonly route: 'codex_subscription'|'claude_subscription'|'byok';
  readonly support: 'candidate_only'|'unsupported';
  readonly authentication: 'unknown'|'unavailable'|'local_observed_subscription'|'local_observed_api_key';
  readonly blockers: readonly AdapterIssue[]; readonly installedVersion?: string;
  readonly operational_authority: false;
}
export interface CliArtifact {
  readonly executable: string; readonly sha256: string; readonly version: string;
}
export interface CliObservation {
  readonly exitCode: number|null; readonly signal: string|null;
  readonly stdout: Uint8Array; readonly stderr: Uint8Array;
}
export interface CliProbe {
  probe(operation: 'version'|'help'|'auth_status'): Promise<CliObservation>;
}
/** PRIVATE host preparation. Contains prompt bytes, never a public DTO/permit.
 * No current execution entry accepts or runs these candidates. */
export interface PreparedCliInvocation {
  readonly kind: 'cli_text_candidate'; readonly argv: readonly string[];
  readonly stdin: Uint8Array; readonly environment: Readonly<Record<string,string>>;
  readonly assessment: AdapterAssessment; readonly operational_authority: false;
}
/** PRIVATE observation codec. A reported model is an unverified claim. Null
 * means the protocol did not report it; modelRef is only the requested label.
 * These bytes cannot be persisted as a platform AI Result. */
export interface DecodedModelText {
  readonly text: string; readonly modelRef: string; readonly reportedModelRef: string|null;
  readonly usage: { readonly inputTokens: number|null; readonly outputTokens: number|null; readonly totalTokens: number|null };
  readonly evidence: 'unverified_provider_output'; readonly operational_authority: false;
}

const inputSchema = z.object({ selection: ModelSelectionSchema,
  prompt: z.string().min(1).max(MODEL_ADAPTER_LIMITS.promptBytes),
  maxOutputTokens: z.number().int().min(1).max(MODEL_ADAPTER_LIMITS.outputTokens),
}).strict();
export function parseAdapterTextInput(raw: unknown): AdapterTextInput {
  try {
    const input = inputSchema.parse(snapshotInput(raw));
    if (input.prompt.includes('\0') || /[\uD800-\uDFFF]/u.test(input.prompt) || new TextEncoder().encode(input.prompt).byteLength > MODEL_ADAPTER_LIMITS.promptBytes)
      throw new Error();
    return Object.freeze({ ...input, selection: Object.freeze({ ...input.selection }) });
  } catch { throw new AdapterFault('invalid_input'); }
}
export function copyModelBytes(raw: unknown, maximum: number = MODEL_ADAPTER_LIMITS.responseBytes): Uint8Array {
  try { return snapshotBoundedBytes(raw, maximum); }
  catch (error) {
    if ((error as {code?:string})?.code === 'too_large') throw new AdapterFault('response_limit');
    throw new AdapterFault('invalid_response');
  }
}
export function assertOutputText(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.length || raw.length > MODEL_ADAPTER_LIMITS.outputBytes
    || /[\uD800-\uDFFF]/u.test(raw) || raw.includes('\0')
    || new TextEncoder().encode(raw).byteLength > MODEL_ADAPTER_LIMITS.outputBytes)
    throw new AdapterFault('invalid_response');
  return raw;
}

/** Separate provider grammar: unlike execution decision inputs, provider cost
 * metadata may contain finite decimals. Identity/version/usage schemas still
 * enforce their own integer/string constraints. No existing decoder is widened. */
export function parseModelJson(bytes: Uint8Array, maximum: number = MODEL_ADAPTER_LIMITS.responseBytes): unknown {
  // A trusted native codec may select the 64 KiB process profile. Existing
  // provider codecs retain their 32 KiB default; a request cannot lift this cap.
  if (!Number.isInteger(maximum) || maximum < 1 || maximum > MODEL_ADAPTER_LIMITS.eventBytes) throw new AdapterFault('invalid_input');
  const copy = copyModelBytes(bytes, maximum);
  let raw: string;
  try { raw = new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(copy); }
  catch { throw new AdapterFault('invalid_response'); }
  return strictJson(raw);
}
function strictJson(raw: string): unknown {
  let index = 0, nodes = 0;
  const invalid = (): never => { throw new AdapterFault('invalid_response'); };
  const whitespace = () => { while (index < raw.length && /[\x20\t\r\n]/.test(raw[index])) index++; };
  function string(): string {
    const start = index++; let escaped = false;
    for (; index < raw.length; index++) {
      if (!escaped && raw[index] === '"') {
        index++;
        let decoded: unknown;
        try { decoded = JSON.parse(raw.slice(start,index)); } catch { return invalid(); }
        if (typeof decoded !== 'string' || /[\uD800-\uDFFF]/u.test(decoded)) return invalid();
        return decoded;
      }
      if (!escaped && raw[index] === '\\') escaped = true; else escaped = false;
    }
    return invalid();
  }
  function value(depth: number): unknown {
    if (depth > MODEL_ADAPTER_LIMITS.depth || ++nodes > MODEL_ADAPTER_LIMITS.nodes) throw new AdapterFault('response_limit');
    whitespace(); const char = raw[index];
    if (char === '"') return string();
    if (char === '{') {
      index++; whitespace(); const object: Record<string,unknown> = Object.create(null), keys = new Set<string>();
      if (raw[index] === '}') { index++; return object; }
      for (;;) {
        whitespace(); if (raw[index] !== '"') return invalid(); const key = string();
        if (keys.has(key) || ['__proto__','constructor','prototype'].includes(key)) return invalid(); keys.add(key);
        whitespace(); if (raw[index++] !== ':') return invalid(); object[key] = value(depth+1); whitespace();
        if (raw[index] === '}') { index++; return object; }
        if (raw[index++] !== ',') return invalid();
      }
    }
    if (char === '[') {
      index++; whitespace(); const array: unknown[] = [];
      if (raw[index] === ']') { index++; return array; }
      for (;;) {
        array.push(value(depth+1)); whitespace(); if (raw[index] === ']') { index++; return array; }
        if (raw[index++] !== ',') return invalid();
      }
    }
    for (const [literal,decoded] of [['true',true],['false',false],['null',null]] as const)
      if (raw.startsWith(literal,index)) { index += literal.length; return decoded; }
    const token = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(raw.slice(index));
    if (!token) return invalid(); index += token[0].length; const parsed = Number(token[0]);
    if (!Number.isFinite(parsed) || Object.is(parsed,-0) || Number.isInteger(parsed) && !Number.isSafeInteger(parsed)) return invalid();
    // JSON numbers must not round fractional usage into an integer, or underflow
    // nonzero metadata into zero. Exact safe integer decimals/exponents remain
    // valid; finite fractional cost metadata keeps ordinary Number semantics.
    const parts = /^(-?)([0-9]+)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]+))?$/.exec(token[0])!;
    const digits = (parts[2] + (parts[3] ?? '')).replace(/^0+/, '');
    if (digits.length && parsed === 0) return invalid();
    if (digits.length && Number.isInteger(parsed)) {
      const significant = digits.replace(/0+$/, '');
      const scale = Number(parts[4] ?? 0) - (parts[3]?.length ?? 0) + digits.length - significant.length;
      if (!Number.isSafeInteger(scale) || scale < 0 || significant.length + scale > 16) return invalid();
      const exact = BigInt((parts[1] || '') + significant) * 10n ** BigInt(scale);
      if (exact !== BigInt(parsed)) return invalid();
    }
    return parsed;
  }
  const parsed = value(0); whitespace(); if (index !== raw.length) return invalid(); return parsed;
}
export function parseModelJsonLines(bytes: Uint8Array): readonly unknown[] {
  const copy = copyModelBytes(bytes,MODEL_ADAPTER_LIMITS.eventBytes);
  let raw: string;
  try { raw = new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(copy); }
  catch { throw new AdapterFault('invalid_response'); }
  if (raw.endsWith('\n')) raw = raw.slice(0,-1);
  const lines = raw.split('\n');
  if (!lines.length || lines.length > MODEL_ADAPTER_LIMITS.events) throw new AdapterFault('response_limit');
  return Object.freeze(lines.map(line => {
    if (!line.length) throw new AdapterFault('invalid_response');
    if (new TextEncoder().encode(line).byteLength > MODEL_ADAPTER_LIMITS.responseBytes) throw new AdapterFault('response_limit');
    return strictJson(line);
  }));
}
