import { z } from 'zod';
import { OpenRouterModelRefSchema } from '../../contracts/execution/v1/member-execution.js';
import { AdapterFault, parseModelJson } from './adapters/common.js';

// Fixed authenticated readiness and exact model metadata; neither is a dispatch.
// https://openrouter.ai/docs/api/api-reference/api-keys/get-current-api-key
// https://openrouter.ai/docs/api/api-reference/models/get-model
const amount = z.number().finite().nonnegative();
const text = z.string().max(16384);
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const keyProfile = z.object({ data: z.object({
  label: z.string().max(256).optional(), limit: amount.nullable(), limit_remaining: z.number().finite().nullable(),
  limit_reset: z.string().max(32).nullable(), usage: amount, expires_at: z.iso.datetime({ offset: true }).nullable(),
  is_management_key: z.literal(false), is_provisioning_key: z.literal(false).optional(), is_free_tier: z.boolean().optional(),
  include_byok_in_limit: z.boolean().optional(), usage_daily: amount.optional(), usage_weekly: amount.optional(), usage_monthly: amount.optional(),
  byok_usage: amount.optional(), byok_usage_daily: amount.optional(), byok_usage_weekly: amount.optional(), byok_usage_monthly: amount.optional(),
  creator_user_id: z.string().max(256).nullable().optional(), organization_id: z.string().max(256).nullable().optional(),
  workspace_id: z.string().max(256).nullable().optional(), allowed_data_regions: z.array(z.string().max(32)).max(16).optional(),
  free_model_daily_requests: z.object({ limit: integer, remaining: integer, used: integer }).strict().optional(),
  // Observed legacy -1 sentinel; this deprecated metadata never grants budget.
  rate_limit: z.object({ interval: z.string().max(64), requests: z.union([integer, z.literal(-1)]), note: text.optional() }).strict().optional(),
}).strict() }).strict();
const modelProfile = z.object({ data: z.object({ id: OpenRouterModelRefSchema, canonical_slug: OpenRouterModelRefSchema,
  name: text, created: integer, description: text.optional(), context_length: integer.positive(),
  hugging_face_id: z.string().max(256).nullable().optional(), expiration_date: z.iso.date().nullable().optional(),
  architecture: z.object({ input_modalities: z.array(z.string().max(32)).max(16), output_modalities: z.array(z.string().max(32)).max(16),
    modality: z.string().max(96).optional(), tokenizer: z.string().max(96).nullable().optional(), instruct_type: z.string().max(96).nullable().optional() }).strict(),
  pricing: z.record(z.string().max(96), z.string().max(64)),
  top_provider: z.object({ is_moderated: z.boolean(), context_length: integer.positive().nullable(), max_completion_tokens: integer.positive().nullable() }).strict(),
  per_request_limits: z.record(z.string().max(96), z.string().max(96)).nullable().optional(),
  supported_parameters: z.array(z.string().max(96)).max(64), supported_voices: z.array(z.string().max(96)).max(128).nullable().optional(),
  default_parameters: z.record(z.string().max(96), z.union([z.number().finite(), z.string().max(96), z.null()])).nullable().optional(),
  knowledge_cutoff: z.iso.date().nullable().optional(),
  benchmarks: z.object({
    design_arena: z.array(z.object({ arena: z.string().max(96), category: z.string().max(96),
      elo: z.number().finite(), win_rate: z.number().finite().min(0).max(100), rank: integer.positive() }).strict()).max(64).optional(),
    artificial_analysis: z.object({ intelligence_index: amount.nullable(), coding_index: amount.nullable(), agentic_index: amount.nullable() }).strict().optional(),
  }).strict().optional(),
  links: z.object({ details: z.string().max(512) }).strict().optional(),
}).strict() }).strict();

export function openRouterModelPath(model: string): string {
  const result = OpenRouterModelRefSchema.safeParse(model);
  if (!result.success) throw new AdapterFault('unsupported_selection');
  return '/api/v1/model/' + result.data.split('/').map(encodeURIComponent).join('/');
}
export function readOpenRouterKey(bytes: Uint8Array): { expiresAt: string | null } {
  const result = keyProfile.safeParse(parseModelJson(bytes));
  if (!result.success) throw new AdapterFault('authentication_unavailable');
  const key = result.data.data;
  if (key.expires_at && Date.parse(key.expires_at) <= Date.now()
    || key.limit_remaining !== null && key.limit_remaining <= 0) throw new AdapterFault('authentication_unavailable');
  return { expiresAt: key.expires_at };
}
export function assertOpenRouterModel(bytes: Uint8Array, model: string, cap: number): void {
  const result = modelProfile.safeParse(parseModelJson(bytes));
  if (!result.success || result.data.data.id !== model) throw new AdapterFault('model_mismatch');
  const data = result.data.data;
  if (!data.architecture.input_modalities.includes('text') || !data.architecture.output_modalities.includes('text')
    || !['max_completion_tokens', 'tools', 'tool_choice'].every(v => data.supported_parameters.includes(v))
    || data.top_provider.max_completion_tokens !== null && data.top_provider.max_completion_tokens < cap
    || data.expiration_date && data.expiration_date <= new Date().toISOString().slice(0, 10)) throw new AdapterFault('unsupported_selection');
}
