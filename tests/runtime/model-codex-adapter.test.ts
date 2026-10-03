import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCodexSubscriptionAdapter } from '../../modules/agent-execution/adapters/codex.js';
import { AdapterFault, type CliArtifact, type CliObservation, type CliProbe } from '../../modules/agent-execution/adapters/common.js';

const encode = (text: string) => new TextEncoder().encode(text);
const artifact: CliArtifact = { executable: '/synthetic/codex', sha256: '12eb3e81114588aca3b7998f4f19e8997b056aca08e57a7ca7c8a3ec8c652aad', version: '0.160.0' };
const selected = { providerRef: 'openai', modelRef: 'explicit-synthetic-model', processingLocation: 'provider_remote',
  artifactCustody: 'runtime_local', credentialCustody: 'official_cli', engineLocation: 'runtime_local', billingSource: 'user_cli' };
const request = () => ({ selection: { ...selected }, prompt: 'A synthetic private prompt.', maxOutputTokens: 4 });
const observed = (stdout: string, exitCode = 0, stderr = ''): CliObservation => ({ stdout: encode(stdout), stderr: encode(stderr), exitCode, signal: null });
const help = '--json --ephemeral --ignore-user-config --ignore-rules --sandbox --model';
function adapter(auth = observed('', 1, 'Not logged in\n'), patches: Partial<Record<'version'|'help'|'auth_status', CliObservation>> = {}) {
  const responses = { version: observed('codex-cli 0.160.0\n'), help: observed(help), auth_status: auth, ...patches };
  const calls: string[] = [];
  const probe: CliProbe = { async probe(operation) { calls.push(operation); return responses[operation]; } };
  return { adapter: createCodexSubscriptionAdapter({ artifact, probe }), calls };
}
function throws(code: string, action: () => unknown) {
  assert.throws(action, (error: unknown) => error instanceof AdapterFault && error.code === code);
}
const stream = (extra: Record<string, unknown> = {}) => [
  { type: 'thread.started', thread_id: 'synthetic-thread' },
  { type: 'turn.started' },
  { type: 'item.completed', item: { id: 'reasoning', type: 'reasoning', text: 'PRIVATE REASONING MUST NOT LEAVE CODEC' } },
  { type: 'item.completed', item: { id: 'message', type: 'agent_message', text: 'Synthetic result.' } },
  { type: 'turn.completed', usage: { input_tokens: 3, cached_input_tokens: 1, output_tokens: 2, reasoning_output_tokens: 1 }, ...extra },
];
const lines = (events: unknown[]) => events.map(event => JSON.stringify(event)).join('\n') + '\n';

test('Codex diagnostic observations stay unsupported and never turn installation or fake login into execution authority', async () => {
  const fixture = adapter();
  const unavailable = await fixture.adapter.inspect();
  assert.deepEqual(new Set(fixture.calls), new Set(['version', 'help', 'auth_status']));
  assert.equal(unavailable.installedVersion, '0.160.0');
  assert.equal(unavailable.authentication, 'unavailable');
  assert.equal(unavailable.support, 'unsupported');
  assert.equal(unavailable.operational_authority, false);
  assert.ok(unavailable.blockers.includes('authentication_unavailable'));
  const syntheticSubscription = await adapter(observed('', 0, 'Logged in using ChatGPT\n')).adapter.inspect();
  assert.equal(syntheticSubscription.authentication, 'local_observed_subscription');
  assert.equal(syntheticSubscription.support, 'unsupported');
  assert.deepEqual(syntheticSubscription.blockers, ['effective_tool_policy_unavailable']);
  assert.ok(Object.isFrozen(syntheticSubscription));
  assert.ok(Object.isFrozen(syntheticSubscription.blockers));
  await assert.rejects(fixture.adapter.invoke(request()), (error: unknown) => error instanceof AdapterFault && error.code === 'execution_authority_unavailable');
});

test('Codex auth parsing requires exact status, billing route and exit status without exposing raw key/account diagnostics', async () => {
  const wrongBilling = await adapter(observed('', 0, 'Logged in using an API key - SYNTHETIC_SECRET_FINGERPRINT\n')).adapter.inspect();
  assert.equal(wrongBilling.authentication, 'local_observed_api_key');
  assert.ok(wrongBilling.blockers.includes('billing_route_mismatch'));
  assert.ok(!JSON.stringify(wrongBilling).includes('SYNTHETIC_SECRET'));
  for (const observation of [observed('Logged in using ChatGPT', 1), observed('Logged in using ChatGPT\nextra'),
    observed('Logged in using ChatGPT\n\n'), observed('Logged in using access token'), observed('Logged in using workload identity'),
    observed('Logged in using personal access token'), observed('Logged in using Amazon Bedrock API key'),
    observed('Logged in using ChatGPT', 0, 'Logged in using an API key - synthetic'),
    { ...observed('Logged in using ChatGPT'), signal: 'SIGTERM' },
    { ...observed(''), stdout: new Uint8Array([0xff]) }, observed('x'.repeat(16385))]) {
    const result = await adapter(observation).adapter.inspect();
    assert.equal(result.authentication, 'unknown');
    assert.ok(result.blockers.includes('authentication_unavailable'));
    assert.equal(result.operational_authority, false);
  }
});

test('Codex rejects unknown/prefix versions, missing required flags and invalid pinned artifacts', async () => {
  for (const stdout of ['codex-cli 0.160.0-preview', 'codex-cli 0.160.1', 'codex-cli 0.160.0\nwarning', 'codex-cli 0.160.0\u0000']) {
    const result = await adapter(undefined, { version: observed(stdout) }).adapter.inspect();
    assert.equal(result.installedVersion, undefined);
    assert.ok(result.blockers.includes('unsupported_version'));
  }
  const missingFlags = await adapter(undefined, { help: observed('--json --sandbox') }).adapter.inspect();
  assert.ok(missingFlags.blockers.includes('unsupported_version'));
  throws('artifact_mismatch', () => createCodexSubscriptionAdapter({ artifact: { ...artifact, sha256: 'not-a-hash' }, probe: { async probe() { throw Error('not called'); } } }));
  const unsupported = createCodexSubscriptionAdapter({ artifact: { ...artifact, version: '0.160.1' }, probe: { async probe() { throw Error('not called'); } } });
  assert.ok((await unsupported.inspect()).blockers.includes('unsupported_version'));
  throws('unsupported_version', () => unsupported.prepare(request()));
});

test('Codex preparation has explicit selection and private stdin, never caller argv/config/auth/ready or an undocumented token cap', () => {
  const instance = adapter().adapter;
  const input = request(), prepared = instance.prepare(input);
  assert.equal(prepared.kind, 'cli_text_candidate');
  assert.equal(prepared.operational_authority, false);
  assert.equal(prepared.assessment.support, 'unsupported');
  assert.ok(prepared.assessment.blockers.includes('effective_tool_policy_unavailable'));
  assert.equal(new TextDecoder().decode(prepared.stdin), input.prompt);
  assert.ok(!prepared.argv.includes(input.prompt));
  assert.equal(prepared.argv[prepared.argv.indexOf('--model') + 1], selected.modelRef);
  assert.equal(prepared.argv[prepared.argv.indexOf('--sandbox') + 1], 'read-only');
  assert.ok(prepared.argv.includes('--ignore-user-config'));
  assert.ok(prepared.argv.includes('--ignore-rules'));
  assert.ok(prepared.argv.includes('--ephemeral'));
  assert.ok(!prepared.argv.some(arg => arg.includes('max_output_tokens') || arg.includes('forced_login_method')));
  assert.deepEqual(prepared.environment, {});
  input.prompt = 'caller changed after preparation'; input.selection.modelRef = 'different-model';
  assert.equal(new TextDecoder().decode(prepared.stdin), 'A synthetic private prompt.');
  assert.ok(Object.isFrozen(prepared.argv));
  for (const field of ['argv', 'environment', 'auth', 'modelReady', 'operational_authority', 'capability', 'executable', 'fallback']) {
    throws('invalid_input', () => instance.prepare({ ...request(), [field]: true }));
  }
  for (const change of [{ providerRef: 'codex' }, { providerRef: 'anthropic' },
    { processingLocation: 'runtime_local' },
    { credentialCustody: 'local_keychain', billingSource: 'user_byok' }]) {
    throws('unsupported_selection', () => instance.prepare({ ...request(), selection: { ...selected, ...change } }));
  }
  throws('invalid_input', () => instance.prepare({ ...request(), prompt: '😀'.repeat(4097) }));
  for (const maxOutputTokens of [0, -1, 4097, 1.5, '4', Infinity]) throws('invalid_input', () => instance.prepare({ ...request(), maxOutputTokens }));
});

test('Codex factory and observations reject accessors without invoking them and snapshot trusted host ports', async () => {
  let invoked = 0;
  const evilArtifact = { ...artifact };
  Object.defineProperty(evilArtifact, 'version', { enumerable: true, get() { invoked++; return '0.160.0'; } });
  throws('invalid_input', () => createCodexSubscriptionAdapter({ artifact: evilArtifact, probe: { async probe() { throw Error(); } } }));
  const instance = adapter().adapter, evilObservation = observed(lines(stream()));
  Object.defineProperty(evilObservation, 'stdout', { enumerable: true, get() { invoked++; return encode(lines(stream())); } });
  throws('invalid_response', () => instance.decode(evilObservation, request()));
  const hostileStatus = observed('Logged in using ChatGPT');
  Object.defineProperty(hostileStatus, 'exitCode', { enumerable: true, get() { invoked++; throw Error('PRIVATE HOSTILE GETTER'); } });
  const result = await adapter(hostileStatus).adapter.inspect();
  assert.equal(result.authentication, 'unknown');
  assert.ok(result.blockers.includes('probe_unavailable'));
  assert.ok(!JSON.stringify(result).includes('PRIVATE HOSTILE GETTER'));
  assert.equal(invoked, 0);
  const mutableArtifact = { ...artifact }, mutableProbe: CliProbe = { async probe(operation) {
    return operation === 'version' ? observed('codex-cli 0.160.0') : operation === 'help' ? observed(help) : observed('Not logged in', 1);
  } };
  const captured = createCodexSubscriptionAdapter({ artifact: mutableArtifact, probe: mutableProbe });
  mutableArtifact.version = '0.160.1'; mutableProbe.probe = async () => { throw Error('later caller mutation'); };
  assert.equal((await captured.inspect()).installedVersion, '0.160.0');
  assert.equal(captured.prepare(request()).assessment.support, 'unsupported');
});

test('Codex private codec yields allowlisted text/counts while leaving unreported actual model unknown', () => {
  const instance = adapter().adapter;
  const decoded = instance.decode(observed(lines(stream()), 0, 'SYNTHETIC STDERR ACCOUNT TEXT'), request());
  assert.deepEqual(decoded, { text: 'Synthetic result.', modelRef: selected.modelRef, reportedModelRef: null,
    usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 }, evidence: 'unverified_provider_output', operational_authority: false });
  assert.ok(!JSON.stringify(decoded).includes('REASONING'));
  assert.ok(!JSON.stringify(decoded).includes('STDERR'));
  assert.ok(!JSON.stringify(decoded).includes('synthetic-thread'));
  assert.ok(Object.isFrozen(decoded));
  assert.ok(Object.isFrozen(decoded.usage));
  const reported = instance.decode(observed(lines(stream({ model: selected.modelRef }))), request());
  assert.equal(reported.reportedModelRef, selected.modelRef);
  throws('model_mismatch', () => instance.decode(observed(lines(stream({ model: 'different-model' }))), request()));
});

test('Codex decoder rejects tool events, ambiguous ordering, missing terminal, failed outcome and trailing events', () => {
  const instance = adapter().adapter;
  for (const type of ['command_execution', 'file_change', 'mcp_tool_call', 'web_search', 'computer_use', 'tool_call', 'unknown']) {
    const events = stream(); events[2] = { type: 'item.completed', item: { id: 'tool', type, text: 'must not reach text' } };
    throws('effective_tool_policy_unavailable', () => instance.decode(observed(lines(events)), request()));
  }
  const duplicate = stream(); duplicate.splice(4, 0, duplicate[3]);
  for (const events of [stream().slice(0, -1), [...stream(), { type: 'turn.started' }], stream().slice(1),
    [{ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }], duplicate,
    [...stream().slice(0, 2), { type: 'arbitrary', secret: 'synthetic' }]]) {
    throws('invalid_response', () => instance.decode(observed(lines(events)), request()));
  }
  throws('outcome_unknown', () => instance.decode(observed(lines(stream()), 1), request()));
  throws('outcome_unknown', () => instance.decode({ ...observed(lines(stream())), signal: 'SIGTERM' }, request()));
  throws('outcome_unknown', () => instance.decode(observed(lines([...stream().slice(0, 2), { type: 'turn.failed', error: { message: 'SYNTHETIC SECRET' } }])), request()));
});

test('Codex response/count caps fail closed for unsafe counts, missing usage, output limit and malformed bounded JSON', () => {
  const instance = adapter().adapter;
  throws('usage_unavailable', () => instance.decode(observed(lines(stream({ usage: null }))), request()));
  for (const usage of [{ input_tokens: 1, output_tokens: -1 }, { input_tokens: 1, output_tokens: 1.5 },
    { input_tokens: 1, output_tokens: '2' }, { input_tokens: 1, output_tokens: 2, cached_input_tokens: 2 },
    { input_tokens: 1, output_tokens: 2, reasoning_output_tokens: 3 }, { input_tokens: 1, output_tokens: 2, total_tokens: 99 },
    { input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: 1 }]) {
    throws('invalid_response', () => instance.decode(observed(lines(stream({ usage }))), request()));
  }
  throws('response_limit', () => instance.decode(observed(lines(stream({ usage: { input_tokens: 1, output_tokens: 5 } }))), request()));
  const giant = stream(); giant[3] = { type: 'item.completed', item: { id: 'message', type: 'agent_message', text: '😀'.repeat(4097) } };
  throws('invalid_response', () => instance.decode(observed(lines(giant)), request()));
  for (const stdout of ['{"type":"turn.started","t\\u0079pe":"turn.completed"}\n', '{"__proto__":{}}\n',
    '{"type":"turn.started","constructor":{}}\n', '{"type":"turn.started","secret":"\\ud800"}\n',
    '{"type":"turn.started","n":9007199254740992}\n', '\uFEFF{}\n', '[\n', 'null\n']) {
    assert.throws(() => instance.decode(observed(stdout), request()), AdapterFault);
  }
  assert.throws(() => instance.decode({ ...observed(''), stdout: new Uint8Array([0xff]) }, request()), AdapterFault);
  assert.throws(() => instance.decode(observed('{}\n'.repeat(65)), request()), AdapterFault);
  assert.throws(() => instance.decode(observed('x'.repeat(65537)), request()), AdapterFault);
});

test('Codex caller JSON never gains invocation authority, even with fake status and prepared metadata', async () => {
  const instance = adapter(observed('Logged in using ChatGPT')).adapter;
  await instance.inspect();
  const prepared = instance.prepare(request());
  for (const raw of [prepared, { ...request(), ready: true }, { ...request(), operational_authority: true },
    { ...request(), permit: { operational_authority: true } }]) {
    await assert.rejects(instance.invoke(raw), (error: unknown) => error instanceof AdapterFault && error.code === 'invalid_input');
  }
  await assert.rejects(instance.invoke(request()), (error: unknown) => error instanceof AdapterFault && error.code === 'execution_authority_unavailable');
});
