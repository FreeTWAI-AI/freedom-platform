import { createHash } from 'node:crypto';
import { z } from 'zod';
import { NativeTextBindingSchema, NativeTextContextSchema, NativeTextLimits, type NativeTextBinding } from '../../../contracts/execution/v3/native-text-invocation.js';
import { snapshotInput, freezeTree } from '../../../packages/execution-state/decode.js';
import { AdapterFault, parseModelJson, assertOutputText, copyModelBytes } from './common.js';

export const GROK_NATIVE_TEXT_PROFILE = Object.freeze({ id: 'grok-1.0.46-text/v1' as const,
  version: '1.0.46', sha256: '41626a53292324140b92556b9d42ff5542e3dcd04aff85eafb8689dd4adb44fc',
  requestedModelRef: 'grok-4.7', reportedModelRef: 'grok-4.7-build' });
export const nativeDigest = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');
export function nativeBinding(raw: unknown): NativeTextBinding {
  try {
    const b = NativeTextBindingSchema.parse(snapshotInput(raw));
    const start = Date.parse(b.activatedAt), end = Date.parse(b.leaseExpiresAt);
    if (end <= start || end - start > NativeTextLimits.leaseMs) throw new Error();
    return freezeTree(b);
  } catch { throw new AdapterFault('invalid_input'); }
}
export function nativeContext(raw: Uint8Array, binding: NativeTextBinding): Uint8Array {
  let copy: Uint8Array | undefined;
  try {
    copy = copyModelBytes(raw, NativeTextLimits.inputBytes);
    if (copy.byteLength !== binding.inputByteSize) throw new Error();
    const c = NativeTextContextSchema.parse(parseModelJson(copy));
    const canonical = new TextEncoder().encode(JSON.stringify({ schema: c.schema, title: c.title, objective: c.objective }));
    if (nativeDigest(copy) !== binding.contextSha256 || nativeDigest(canonical) !== binding.contextSha256
      || /\0/.test(c.title + c.objective)) { copy.fill(0); throw new Error(); }
    return copy;
  } catch { copy?.fill(0); throw new AdapterFault('invalid_input'); }
}
/** These are candidate flags, not proof that Grok applied an empty tool set. */
export const grokTextArguments = Object.freeze(['--permission-mode','dontAsk','--tools','',
  '--no-subagents','--disable-web-search','--model','grok-4.7','--max-turns','1',
  '--output-format','json','--verbatim','--prompt-file','/proc/self/fd/0']);

/** Fixture-only wire protocol. Real Grok output is intentionally not accepted
 * until its effective controls and terminal format are verified independently. */
const fixtureControls = z.object({ profile: z.literal('synthetic.native-text.controls/v1'),
  tools: z.tuple([]), mcpServers: z.tuple([]), plugins: z.tuple([]), hooks: z.tuple([]),
  subagents: z.tuple([]), network: z.literal('denied'), credentials: z.literal('none') }).strict();
export function checkFixtureControls(bytes: Uint8Array): void {
  try { fixtureControls.parse(parseModelJson(bytes)); }
  catch { throw new AdapterFault('effective_tool_policy_unavailable'); }
}
export function decodeFixtureText(bytes: Uint8Array): string {
  try {
    const out = z.object({ profile: z.literal('synthetic.native-text.output/v1'),
      stopReason: z.literal('end_turn'), model: z.literal('grok-4.7-build'),
      text: z.string().min(1), tools: z.tuple([]) }).strict().parse(parseModelJson(bytes, NativeTextLimits.stdoutBytes));
    return assertOutputText(out.text);
  } catch { throw new AdapterFault('outcome_unknown'); }
}
