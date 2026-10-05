import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { createByokTextAdapter, selectModelAdapterRoute, AdapterFault } from '../../modules/agent-execution/adapters/index.js';
import { ModelSelectionSchema } from '../../contracts/execution/v1/member-execution.js';
import { BrokerModelSelectionSchema } from '../../contracts/execution/v2/model-credential.js';
import { assertProviderTarget } from '../../modules/agent-execution/provider-target.js';
import { readOpenRouterKey, assertOpenRouterModel, openRouterModelPath } from '../../modules/agent-execution/openrouter-profile.js';
import { exchange as workerExchange } from '../../apps/credential-broker/src/worker-provider-transport.js';
import { createLocalFixtureModelStepHost, createModelStepCapability, readModelObservation, readVerifiedModelBinding, encodeModelStepContext } from '../../modules/agent-execution/model-step-host.js';
import type { ModelStepBinding } from '../../contracts/execution/v2/model-step.js';

const encode = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
const selected = { providerRef: 'openrouter', modelRef: 'openai/gpt-4.1-mini', processingLocation: 'provider_remote', artifactCustody: 'platform_asset', credentialCustody: 'platform_vault', engineLocation: 'platform', billingSource: 'user_byok' } as const;
const input = () => ({ selection: selected, prompt: 'Synthetic private draft.', maxOutputTokens: 32 });
const adapter = createByokTextAdapter();
const completion = () => ({ id: 'synthetic-completion', object: 'chat.completion', created: 1, model: selected.modelRef, provider: 'OpenAI', system_fingerprint: null, service_tier: 'default',
  choices: [{ index: 0, logprobs: null, finish_reason: 'stop', native_finish_reason: 'completed', message: { role: 'assistant', content: 'Synthetic private draft.', refusal: null, reasoning: null } }],
  usage: { prompt_tokens: 41, completion_tokens: 23, total_tokens: 64, cost: 0.0000532, is_byok: false,
    prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0, audio_tokens: 0, video_tokens: 0 },
    cost_details: { upstream_inference_cost: 0.0000532, upstream_inference_prompt_cost: 0.0000164, upstream_inference_completions_cost: 0.0000368 },
    completion_tokens_details: { reasoning_tokens: 0, image_tokens: 0, audio_tokens: 0 } } });
const observed = (value = completion()) => ({ status: 200, headers: { 'content-type': 'application/json' }, body: encode(value) });
const keyProfile = () => ({ data: { limit: 10, limit_remaining: 10, limit_reset: 'daily', usage: 0, expires_at: new Date(Date.now() + 45000).toISOString(), is_management_key: false } });
const modelProfile = () => ({ data: { id: selected.modelRef, canonical_slug: 'openai/gpt-4.1-mini-2025-04-14', name: 'Synthetic model metadata', created: 1, context_length: 1000, knowledge_cutoff: '2024-06-30',
  benchmarks: { design_arena: [{ arena: 'models', category: 'code', elo: 999, win_rate: 47.5, rank: 115 }], artificial_analysis: { intelligence_index: null, coding_index: 20.2, agentic_index: null } },
  architecture: { input_modalities: ['text'], output_modalities: ['text'], tokenizer: 'GPT', instruct_type: null },
  pricing: { prompt: '0.0000004', completion: '0.0000016' }, top_provider: { is_moderated: true, context_length: 1000, max_completion_tokens: 1000 }, supported_parameters: ['max_completion_tokens', 'tools', 'tool_choice'] } });
const fault = (code?: string) => (e: unknown) => e instanceof AdapterFault && (!code || e.code === code) && e.message === 'Model adapter request unavailable.';

test('OpenRouter is explicit BYOK with fixed endpoint, exact model, bounded output and no tools or fallback', () => {
  assert.equal(selectModelAdapterRoute(input()), 'byok');
  assert(BrokerModelSelectionSchema.safeParse(selected).success);
  const prepared = adapter.prepare(input()), body = JSON.parse(new TextDecoder().decode(prepared.body));
  assert.equal(prepared.endpoint, 'https://openrouter.ai/api/v1/chat/completions');
  assert.deepEqual(prepared.headers, { 'Content-Type': 'application/json' });
  assert.deepEqual(body, { model: selected.modelRef, messages: [{ role: 'user', content: input().prompt }], max_completion_tokens: 32, stream: false,
    tools: [], tool_choice: 'none', provider: { allow_fallbacks: false, data_collection: 'deny', require_parameters: true }, usage: { include: true } });
  const decoded = adapter.decode(observed(), input());
  assert.equal(decoded.modelRef, selected.modelRef); assert.equal(decoded.reportedModelRef, selected.modelRef);
  assert.deepEqual(decoded.usage, { inputTokens: 41, outputTokens: 23, totalTokens: 64 });
  assert.equal(decoded.evidence, 'unverified_provider_output'); assert.equal(decoded.operational_authority, false);
  assert.equal(prepared.billingSource, 'user_byok'); // Router is_byok=false means upstream custody, not our owner's billing choice.
});
test('namespaced model grammar never widens another provider or accepts path/URL injection', () => {
  for (const providerRef of ['openai', 'anthropic', 'other']) assert(!ModelSelectionSchema.safeParse({ ...selected, providerRef }).success);
  for (const modelRef of ['https://evil.test/x', '//evil/x', 'openai/../x', 'openai/x?redirect=x', 'openai/x#x', 'openai/%2e%2e', 'openai/x/y', 'openai/\nx']) {
    assert(!ModelSelectionSchema.safeParse({ ...selected, modelRef }).success); assert.throws(() => openRouterModelPath(modelRef), fault());
  }
  assert.throws(() => adapter.prepare({ ...input(), selection: { ...selected, modelRef: 'plain-model' } }), fault('unsupported_selection'));
  assert.throws(() => adapter.prepare({ ...input(), endpoint: 'https://evil.test/' }), fault('invalid_input'));
  assert.throws(() => adapter.prepare({ ...input(), selection: { ...selected, credentialCustody: 'official_cli', engineLocation: 'runtime_local', billingSource: 'user_cli' } }), fault('invalid_input'));
});
test('OpenRouter refuses model fallback, missing/invalid usage, hidden reasoning, tools, refusal and truncated output', () => {
  const mutations: Array<(v: any) => void> = [v => { v.model = 'openai/other'; }, v => { delete v.usage; }, v => { delete v.usage.cost; },
    v => { v.usage.cost = -1; }, v => { v.usage.total_tokens++; }, v => { v.usage.completion_tokens = 33; v.usage.total_tokens = 74; },
    v => { v.usage.prompt_tokens_details.cached_tokens = 42; }, v => { v.usage.completion_tokens_details.reasoning_tokens = 1; },
    v => { v.choices[0].message.reasoning = 'private'; }, v => { v.choices[0].message.refusal = 'no'; },
    v => { v.choices[0].message.tool_calls = []; }, v => { v.choices[0].finish_reason = 'length'; }, v => { v.choices.push(v.choices[0]); },
    v => { v.choices[0].message.content = ' '; }, v => { v.unknown = true; }];
  for (const mutate of mutations) { const value = completion(); mutate(value); assert.throws(() => adapter.decode(observed(value), input()), fault()); }
  for (const status of [401, 403, 429, 500]) assert.throws(() => adapter.decode({ ...observed(), status }, input()), fault(status === 401 || status === 403 ? 'authentication_unavailable' : 'outcome_unknown'));
  const raw = JSON.stringify(completion()).replace('"cost":0.0000532', '"cost":1e999'); assert.throws(() => adapter.decode({ ...observed(), body: new TextEncoder().encode(raw) }, input()), fault());
});
test('OpenRouter readiness fails closed for expired/exhausted/management keys and different model/capabilities', () => {
  assert(readOpenRouterKey(encode(keyProfile())).expiresAt); assertOpenRouterModel(encode(modelProfile()), selected.modelRef, 32);
  for (const patch of [{ expires_at: '2000-01-01T00:00:00Z' }, { limit_remaining: 0 }, { is_management_key: true }, { usage: -1 }]) assert.throws(() => readOpenRouterKey(encode({ data: { ...keyProfile().data, ...patch } })), fault('authentication_unavailable'));
  for (const patch of [{ id: 'openai/other' }, { knowledge_cutoff: 'invalid' }, { benchmarks: { unknown: true } }, { benchmarks: { design_arena: [{ arena: 'models', category: 'code', elo: 999, win_rate: 101, rank: 1 }] } }, { supported_parameters: [] }, { top_provider: { ...modelProfile().data.top_provider, max_completion_tokens: 8 } }]) assert.throws(() => assertOpenRouterModel(encode({ data: { ...modelProfile().data, ...patch } }), selected.modelRef, 32), fault());
});
test('Worker denies non-allowlisted targets before fetch and never follows or retries a provider error', async t => {
  const original = globalThis.fetch; let calls = 0;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async () => { calls++; return new Response('PRIVATE_UPSTREAM_ERROR', { status: 429 }); };
  for (const url of ['https://evil.test/api/v1/chat/completions', 'http://openrouter.ai/api/v1/chat/completions', 'https://openrouter.ai:444/api/v1/chat/completions', 'https://openrouter.ai/api/v1/chat/completions?x=1', 'https://openrouter.ai/api/v1/keys', 'https://openrouter.ai.evil.test/api/v1/chat/completions']) await assert.rejects(workerExchange(new URL(url), 'POST', {}), fault('invalid_input'));
  assert.equal(calls, 0);
  await assert.rejects(workerExchange(new URL('https://openrouter.ai/api/v1/chat/completions'), 'POST', { Authorization: 'Bearer SYNTHETIC' }, encode({})), fault('outcome_unknown')); assert.equal(calls, 1);
  globalThis.fetch = async (_url, options) => { calls++; assert.equal(options?.redirect, 'manual'); return new Response('', { status: 302, headers: { location: 'https://evil.test/' } }); };
  await assert.rejects(workerExchange(new URL('https://openrouter.ai/api/v1/key'), 'GET', {}), fault('outcome_unknown')); assert.equal(calls, 2);
  assert.throws(() => assertProviderTarget(new URL('https://openrouter.ai/api/v1/model/openai/%2Fsecret'), 'GET'), fault('invalid_input'));
});

function binding(bytes: Uint8Array): ModelStepBinding {
  const id = randomUUID;
  return { profile: 'model-step.binding/v1', stepId:id(), attemptId:id(), intentId:id(), approvalId:id(), approvalVersion:'1',runId:id(),workId:id(),inputWorkVersion:'1',baseRunVersion:'1',runVersion:'2',baseTaskLeaseEpoch:'1',taskLeaseEpoch:'2',controlEpoch:'1',
    ownerUserId:id(),ownerPrincipalId:id(),scopeId:id(),environment:'local',clientId:'synthetic-openrouter',runtimeDeviceId:id(),runtimeVersion:'1',connectionId:id(),connectionVersion:'1',familyId:id(),modelConnectionId:id(),modelVersion:'1',selection:selected,
    grantId:id(),grantVersion:'1',persistencePolicyRevision:'private-work.v1',exportPolicyId:id(),exportPolicyRevision:'1',contextSha256:createHash('sha256').update(bytes).digest('hex'),inputByteSize:bytes.length,maxOutputTokens:32 };
}
test('real isolated HTTP host authenticates key before metadata, binds exact model, clears key bytes and consumes one dispatch', async () => {
  const paths: string[] = [], keys: Uint8Array[] = []; let denied = false;
  const metadata = keyProfile();
  const server = createServer(async (req, res) => {
    paths.push(req.method + ' ' + req.url); assert.equal(req.headers.authorization, 'Bearer SYNTHETIC_OPENROUTER_KEY'); assert.equal(req.headers['x-api-key'], undefined);
    if (denied) { res.writeHead(401); res.end(); return; }
    let body: unknown;
    if (req.method === 'POST') { const parts = []; for await (const x of req) parts.push(x); const input = JSON.parse(Buffer.concat(parts).toString()); assert.equal(input.model, selected.modelRef); assert.equal(input.provider.allow_fallbacks, false); assert.equal(input.max_completion_tokens, 32); body = completion(); }
    else body = req.url === '/api/v1/key' ? metadata : modelProfile();
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); const address = server.address(); assert(address && typeof address !== 'string');
  const host = createLocalFixtureModelStepHost({ environment: 'local', origin: `http://127.0.0.1:${address.port}`, recover: async () => ({ generation: '1', expiresAt: new Date(Date.now() + 60000).toISOString() }), resolveCredential: async () => { const key = new TextEncoder().encode('SYNTHETIC_OPENROUTER_KEY'); keys.push(key); return { key, expiresAt: new Date(Date.now() + 60000).toISOString() }; } });
  try {
    const bytes = encodeModelStepContext({ schema:'model-step.context/v1',title:'Synthetic',objective:'Private synthetic draft only.' }), selectedBinding = binding(bytes);
    const proof = await host.verify(selectedBinding); assert(Date.parse(readVerifiedModelBinding(proof, selectedBinding).expiresAt) <= Date.parse(metadata.data.expires_at));
    const cap = createModelStepCapability(selectedBinding, proof, new Date(Date.now() + 4000).toISOString(), async () => {});
    const output = readModelObservation(await host.dispatch(cap, bytes), cap); assert.equal(output.reportedModelRef, selected.modelRef);
    assert.deepEqual(paths, ['GET /api/v1/key', 'GET /api/v1/model/openai/gpt-4.1-mini', 'POST /api/v1/chat/completions']);
    await assert.rejects(host.dispatch(cap, bytes), fault('execution_authority_unavailable')); assert.equal(paths.length, 3); assert(keys.every(key => key.every(byte => byte === 0)));
    denied = true; await assert.rejects(host.verify(selectedBinding), fault('authentication_unavailable')); assert.equal(paths.at(-1), 'GET /api/v1/key'); assert.equal(paths.length, 4);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
