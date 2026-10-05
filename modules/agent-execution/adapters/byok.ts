import { z } from 'zod';
import { OpenRouterModelRefSchema } from '../../../contracts/execution/v1/member-execution.js';
import { AdapterFault, parseAdapterTextInput, parseModelJson, assertOutputText, copyModelBytes, MODEL_ADAPTER_LIMITS,
  type AdapterAssessment, type DecodedModelText } from './common.js';

// Primary protocol references, fetched for this implementation:
// https://developers.openai.com/api/reference/resources/responses/methods/create.md
// https://developers.openai.com/api/docs/guides/text
// https://platform.claude.com/docs/en/api/messages/create
// https://platform.claude.com/docs/en/build-with-claude/handling-stop-reasons
// This deliberately narrow codec does not establish credential custody,
// provider authentication, model readiness, a Run permit or Result authority.
const LIMITS = MODEL_ADAPTER_LIMITS;
const registry = Object.freeze({
  openrouter_chat_v1: Object.freeze({ providerRef: 'openrouter', endpoint: 'https://openrouter.ai/api/v1/chat/completions' }),
  openai_responses_v1: Object.freeze({ providerRef: 'openai', endpoint: 'https://api.openai.com/v1/responses' }),
  anthropic_messages_2023_06_01: Object.freeze({ providerRef: 'anthropic', endpoint: 'https://api.anthropic.com/v1/messages' }),
});
type Protocol = keyof typeof registry;
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const label = z.string().min(1).max(96).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$(?![\s\S])/);
const outputText = z.string().min(1).refine(v => !!v.trim().length && !/[\uD800-\uDFFF]/u.test(v)
  && new TextEncoder().encode(v).byteLength <= LIMITS.outputBytes);
const openaiUsage = z.object({ input_tokens: integer, output_tokens: integer.positive(), total_tokens: integer,
  input_tokens_details: z.object({ cached_tokens: integer, cache_write_tokens: integer.optional() }).strict().optional(),
  output_tokens_details: z.object({ reasoning_tokens: integer }).strict().optional(),
}).strict();
const anthropicUsage = z.object({ input_tokens: integer, output_tokens: integer.positive(),
  cache_creation_input_tokens: integer.optional(), cache_read_input_tokens: integer.optional(),
  cache_creation: z.object({ ephemeral_1h_input_tokens: integer, ephemeral_5m_input_tokens: integer }).strict().optional(),
  output_tokens_details: z.object({ thinking_tokens: z.literal(0) }).strict().optional(),
  server_tool_use: z.object({ web_fetch_requests: z.literal(0), web_search_requests: z.literal(0) }).strict().optional(),
  service_tier: z.string().max(64).optional(), inference_geo: z.string().max(96).optional(),
}).strict();
const openaiMessage = z.object({ id: z.string().min(1).max(256), type: z.literal('message'), role: z.literal('assistant'),
  status: z.literal('completed'), content: z.tuple([z.object({ type: z.literal('output_text'), text: outputText,
    annotations: z.tuple([]), logprobs: z.tuple([]).optional() }).strict()]),
}).strict();
const openaiEnvelope = z.object({ id: z.string().min(1).max(256), object: z.literal('response'), model: label,
  status: z.literal('completed'), output: z.tuple([openaiMessage]), usage: openaiUsage,
  error: z.null().optional(), incomplete_details: z.null().optional(), tools: z.tuple([]).optional(),
  tool_choice: z.literal('none').optional(), parallel_tool_calls: z.literal(false).optional(), store: z.literal(false).optional(),
  background: z.literal(false).optional(), previous_response_id: z.null().optional(), conversation: z.null().optional(),
  output_text: outputText.optional(),
  created_at: integer.optional(), completed_at: integer.nullable().optional(), instructions: z.string().max(16384).nullable().optional(),
  max_output_tokens: integer.nullable().optional(), max_tool_calls: z.literal(0).nullable().optional(),
  reasoning: z.object({ effort: z.enum(['none','minimal','low','medium','high','xhigh']).nullable().optional(),
    summary: z.enum(['auto','concise','detailed']).nullable().optional(), context: z.null().optional() }).strict().optional(),
  temperature: z.number().min(0).max(2).optional(), top_p: z.number().min(0).max(1).optional(),
  text: z.object({ format: z.object({ type: z.literal('text') }).strict(),
    verbosity: z.enum(['low','medium','high']).optional() }).strict().optional(),
  truncation: z.literal('disabled').optional(), user: z.null().optional(), metadata: z.object({}).strict().optional(),
  service_tier: z.string().max(64).optional(), access_programs: z.null().optional(), safety_identifier: z.null().optional(),
  prompt_cache_key: z.null().optional(), prompt_cache_retention: z.null().optional(),
  prompt_cache_options: z.object({ mode: z.literal('implicit'), ttl: z.literal('30m'), comparison_response_id: z.null().optional() }).strict().optional(),
  prompt_cache_diagnostics: z.null().optional(),
}).strict();
const anthropicEnvelope = z.object({ id: z.string().min(1).max(256), type: z.literal('message'), model: label,
  role: z.literal('assistant'), content: z.tuple([z.object({ type: z.literal('text'), text: outputText,
    citations: z.tuple([]).optional() }).strict()]), stop_reason: z.literal('end_turn'), stop_sequence: z.null(),
  stop_details: z.null().optional(), usage: anthropicUsage, container: z.null().optional(),
}).strict();

// OpenRouter chat completion reference and root's credential-free observed shape:
// https://openrouter.ai/docs/api/api-reference/chat/create-a-chat-completion
const cost = z.number().finite().nonnegative();
const openrouterUsage = z.object({ prompt_tokens: integer, completion_tokens: integer.positive(), total_tokens: integer,
  cost, is_byok: z.boolean().optional(),
  prompt_tokens_details: z.object({ cached_tokens: integer.optional(), cache_write_tokens: integer.optional(),
    audio_tokens: z.literal(0).optional(), video_tokens: z.literal(0).optional() }).strict().optional(),
  completion_tokens_details: z.object({ reasoning_tokens: z.literal(0).optional(), image_tokens: z.literal(0).optional(), audio_tokens: z.literal(0).optional() }).strict().optional(),
  cost_details: z.object({ upstream_inference_cost: cost.nullable().optional(), upstream_inference_prompt_cost: cost.nullable().optional(),
    upstream_inference_completions_cost: cost.nullable().optional() }).strict().optional(),
}).strict();
const openrouterEnvelope = z.object({ id: z.string().min(1).max(256), object: z.literal('chat.completion'),
  created: integer, model: OpenRouterModelRefSchema, provider: z.string().min(1).max(96).optional(),
  system_fingerprint: z.string().max(256).nullable().optional(), service_tier: z.string().max(64).optional(),
  choices: z.tuple([z.object({ index: z.literal(0), finish_reason: z.literal('stop'),
    native_finish_reason: z.enum(['stop', 'completed']).optional(), logprobs: z.null().optional(),
    message: z.object({ role: z.literal('assistant'), content: outputText, refusal: z.null().optional(), reasoning: z.null().optional() }).strict(),
  }).strict()]), usage: openrouterUsage,
}).strict();

function invalid(): never { throw new AdapterFault('invalid_response'); }
function safeSum(a: number, b: number) { const n = a + b; if (!Number.isSafeInteger(n)) invalid(); return n; }

function decode(protocol: Protocol, bytes: Uint8Array, model: string, outputCap: number) {
  try {
    const raw = parseModelJson(bytes);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) invalid();
    const observed = raw as Record<string, unknown>;
    if (observed.model !== model) throw new AdapterFault('model_mismatch');
    if (!observed.usage || !(protocol === 'openai_responses_v1' ? openaiUsage : protocol === 'openrouter_chat_v1' ? openrouterUsage : anthropicUsage).safeParse(observed.usage).success)
      throw new AdapterFault('usage_unavailable');
    if (protocol === 'openrouter_chat_v1') {
      const r = openrouterEnvelope.parse(raw), u = r.usage;
      if (u.completion_tokens > outputCap || u.total_tokens !== safeSum(u.prompt_tokens, u.completion_tokens)
        || (u.prompt_tokens_details?.cached_tokens ?? 0) > u.prompt_tokens
        || (u.prompt_tokens_details?.cache_write_tokens ?? 0) > u.prompt_tokens) invalid();
      // Cost is validated metadata, not a debit/billing-authority assertion.
      return { text: assertOutputText(r.choices[0].message.content), reportedModelRef: r.model,
        inputTokens: u.prompt_tokens, outputTokens: u.completion_tokens };
    }
    if (protocol === 'openai_responses_v1') {
      const r = openaiEnvelope.parse(raw);
      if (r.model !== model || r.usage.output_tokens > outputCap
        || r.usage.total_tokens !== safeSum(r.usage.input_tokens,r.usage.output_tokens)
        || (r.usage.input_tokens_details?.cached_tokens ?? 0) > r.usage.input_tokens
        || (r.usage.input_tokens_details?.cache_write_tokens ?? 0) > r.usage.input_tokens
        || (r.usage.output_tokens_details?.reasoning_tokens ?? 0) > r.usage.output_tokens) invalid();
      const text = r.output[0].content[0].text;
      if (r.output_text !== undefined && r.output_text !== text) invalid();
      return { text: assertOutputText(text), reportedModelRef: r.model, inputTokens: r.usage.input_tokens, outputTokens: r.usage.output_tokens };
    }
    const r = anthropicEnvelope.parse(raw), u = r.usage;
    if (r.model !== model || u.output_tokens > outputCap) invalid();
    if (u.cache_creation && safeSum(u.cache_creation.ephemeral_1h_input_tokens,u.cache_creation.ephemeral_5m_input_tokens)
      !== (u.cache_creation_input_tokens ?? 0)) invalid();
    return { text: assertOutputText(r.content[0].text), reportedModelRef: r.model, inputTokens: safeSum(safeSum(u.input_tokens,u.cache_creation_input_tokens ?? 0),u.cache_read_input_tokens ?? 0), outputTokens: u.output_tokens };
  } catch (error) { if (error instanceof AdapterFault) throw error; return invalid(); }
}

export interface PreparedByokInvocation {
  readonly protocol: Protocol;
  readonly endpoint: string;
  readonly method: 'POST';
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
  readonly credentialCustody: 'local_keychain'|'platform_vault';
  readonly engineLocation: 'runtime_local'|'platform';
  readonly billingSource: 'user_byok';
  readonly operational_authority: false;
}
export interface ByokObservation {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
}
function chosen(raw: unknown) {
  const input = parseAdapterTextInput(raw), s = input.selection;
  if (s.credentialCustody === 'official_cli' || s.billingSource !== 'user_byok'
    || s.processingLocation !== 'provider_remote' || !['openai','anthropic','openrouter'].includes(s.providerRef)) throw new AdapterFault('unsupported_selection');
  if (s.providerRef === 'openrouter' && !OpenRouterModelRefSchema.safeParse(s.modelRef).success) throw new AdapterFault('unsupported_selection');
  const selected = Object.entries(registry).find(([, profile]) => profile.providerRef === s.providerRef);
  if (!selected) throw new AdapterFault('unsupported_selection');
  const protocol = selected[0] as Protocol;
  return { input, protocol, binding: registry[protocol] };
}
function observation(raw: ByokObservation) {
  try {
    if (!raw || Object.getPrototypeOf(raw) !== Object.prototype || Reflect.ownKeys(raw).length !== 3) invalid();
    const desc = Object.getOwnPropertyDescriptors(raw);
    if (!desc.status || !desc.headers || !desc.body || Object.values(desc).some(d => !d.enumerable || !('value' in d))) invalid();
    const status: unknown = desc.status.value, headers: unknown = desc.headers.value, body = copyModelBytes(desc.body.value);
    if (!Number.isInteger(status) || typeof status !== 'number' || status < 100 || status > 599
      || !headers || typeof headers !== 'object' || Object.getPrototypeOf(headers) !== Object.prototype) invalid();
    const clean = new Headers();
    for (const key of Reflect.ownKeys(headers)) {
      if (typeof key !== 'string') invalid(); const d = Object.getOwnPropertyDescriptor(headers,key)!;
      if (!d.enumerable || !('value' in d) || typeof d.value !== 'string' || clean.has(key)) invalid(); clean.set(key,d.value);
    }
    if (status !== 200) throw new AdapterFault(status === 401 || status === 403 ? 'authentication_unavailable' : 'outcome_unknown');
    if (clean.has('Location') || clean.has('Content-Encoding') && clean.get('Content-Encoding') !== 'identity'
      || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(clean.get('Content-Type') ?? '')) invalid();
    if (body.byteLength > LIMITS.responseBytes) throw new AdapterFault('response_limit');
    const length = clean.get('Content-Length');
    if (length !== null && (!/^(0|[1-9][0-9]*)$(?![\s\S])/.test(length) || BigInt(length) !== BigInt(body.byteLength))) invalid();
    return body;
  } catch (error) { if (error instanceof AdapterFault) throw error; return invalid(); }
}

/** Closed, credential-free protocol preparation and observation decoding only.
 * No keychain/vault is installed, no provider authentication has been proved,
 * and no operational permit exists. The invocation entry always fails closed.
 * The private output is unverified codec evidence, never a Work Result. */
export function createByokTextAdapter() {
  return Object.freeze({
    inspect(raw: unknown): AdapterAssessment {
      try {
        chosen(raw);
        return Object.freeze({ route: 'byok', support: 'candidate_only', authentication: 'unavailable',
          blockers: Object.freeze(['authentication_unavailable','execution_authority_unavailable'] as const), operational_authority: false });
      } catch (error) {
        return Object.freeze({ route: 'byok', support: 'unsupported', authentication: 'unavailable',
          blockers: Object.freeze([error instanceof AdapterFault ? error.code : 'invalid_input'] as const), operational_authority: false });
      }
    },
    prepare(raw: unknown): PreparedByokInvocation {
      const { input, protocol, binding } = chosen(raw), s = input.selection;
      const headerValues: Record<string,string> = { 'Content-Type': 'application/json' };
      if (protocol === 'anthropic_messages_2023_06_01') headerValues['anthropic-version'] = '2023-06-01';
      const headers: Readonly<Record<string,string>> = Object.freeze(headerValues);
      const payload = protocol === 'openrouter_chat_v1'
        ? { model: s.modelRef, messages: [{ role: 'user', content: input.prompt }], max_completion_tokens: input.maxOutputTokens,
          stream: false, tools: [], tool_choice: 'none', provider: { allow_fallbacks: false, data_collection: 'deny', require_parameters: true }, usage: { include: true } }
        : protocol === 'openai_responses_v1'
        ? { model: s.modelRef, input: [{ role: 'user', content: [{ type: 'input_text', text: input.prompt }] }],
          max_output_tokens: input.maxOutputTokens, stream: false, store: false, background: false,
          tools: [], tool_choice: 'none', parallel_tool_calls: false, truncation: 'disabled', text: { format: { type: 'text' } } }
        : { model: s.modelRef, messages: [{ role: 'user', content: [{ type: 'text', text: input.prompt }] }],
          max_tokens: input.maxOutputTokens, stream: false, tools: [], tool_choice: { type: 'none' } };
      const body = new TextEncoder().encode(JSON.stringify(payload));
      if (body.byteLength > LIMITS.responseBytes) throw new AdapterFault('invalid_input');
      return Object.freeze({ protocol, endpoint: binding.endpoint, method: 'POST', headers,
        body, credentialCustody: s.credentialCustody as 'local_keychain'|'platform_vault',
        engineLocation: s.engineLocation, billingSource: 'user_byok', operational_authority: false });
    },
    decode(observed: ByokObservation, raw: unknown): DecodedModelText {
      const { input, protocol } = chosen(raw), parsed = decode(protocol,observation(observed),input.selection.modelRef,input.maxOutputTokens);
      return Object.freeze({ text: parsed.text, modelRef: input.selection.modelRef, reportedModelRef: parsed.reportedModelRef,
        usage: Object.freeze({ inputTokens: parsed.inputTokens, outputTokens: parsed.outputTokens, totalTokens: safeSum(parsed.inputTokens,parsed.outputTokens) }),
        evidence: 'unverified_provider_output', operational_authority: false });
    },
    async invoke(_raw: unknown): Promise<never> { throw new AdapterFault('execution_authority_unavailable'); },
  });
}
