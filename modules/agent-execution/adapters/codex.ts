import {
  AdapterFault, assertOutputText, copyModelBytes, parseAdapterTextInput, parseModelJsonLines,
  type AdapterAssessment, type AdapterIssue, type CliArtifact, type CliObservation, type CliProbe,
  type DecodedModelText, type PreparedCliInvocation,
} from './common.js';

const PINNED_VERSION = '0.160.0';
const PINNED_SHA256 = '12eb3e81114588aca3b7998f4f19e8997b056aca08e57a7ca7c8a3ec8c652aad';
const diagnosticDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const fault = (code: AdapterIssue): never => { throw new AdapterFault(code); };
function dataObject(raw: unknown, keys: readonly string[], code: AdapterIssue): Record<string, PropertyDescriptor> {
  if (!raw || typeof raw !== 'object' || Object.getPrototypeOf(raw) !== Object.prototype
    || Reflect.ownKeys(raw).some(key => typeof key !== 'string' || !keys.includes(key))) return fault(code);
  const descriptors = Object.getOwnPropertyDescriptors(raw);
  if (Object.keys(descriptors).length !== keys.length || Object.values(descriptors).some(value => !value.enumerable || !('value' in value))) return fault(code);
  return descriptors;
}
function snapshotObservation(raw: CliObservation): CliObservation {
  const values = dataObject(raw, ['exitCode', 'signal', 'stdout', 'stderr'], 'invalid_response');
  const exitCode = values.exitCode.value, signal = values.signal.value;
  if (exitCode !== null && (!Number.isInteger(exitCode) || exitCode < 0 || exitCode > 255)
    || signal !== null && typeof signal !== 'string') return fault('invalid_response');
  return { exitCode, signal, stdout: copyModelBytes(values.stdout.value, 65536), stderr: copyModelBytes(values.stderr.value, 16384) };
}
function diagnostic(observation: CliObservation): string {
  observation = snapshotObservation(observation);
  if (!(observation.stdout instanceof Uint8Array) || !(observation.stderr instanceof Uint8Array)
    || observation.stdout.byteLength + observation.stderr.byteLength > 16384 || observation.signal !== null) return fault('probe_unavailable');
  // login status is written to stderr in some versions. Never concatenate two
  // streams into an apparently valid status, or return their account/key text.
  if (observation.stdout.byteLength && observation.stderr.byteLength) return fault('probe_unavailable');
  try {
    const raw = diagnosticDecoder.decode(observation.stdout.byteLength ? observation.stdout : observation.stderr);
    if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\uD800-\uDFFF]/u.test(raw)) return fault('probe_unavailable');
    return raw.replace(/\r?\n$/, '');
  } catch { return fault('probe_unavailable'); }
}
function assessment(authentication: AdapterAssessment['authentication'], blockers: readonly AdapterIssue[], installedVersion?: string): AdapterAssessment {
  return Object.freeze({ route: 'codex_subscription', support: 'unsupported', authentication,
    blockers: Object.freeze([...new Set(blockers)]), ...(installedVersion === undefined ? {} : { installedVersion }), operational_authority: false });
}
function selection(raw: unknown) {
  const input = parseAdapterTextInput(raw), selected = input.selection;
  if (selected.providerRef !== 'openai' || selected.credentialCustody !== 'official_cli'
    || selected.engineLocation !== 'runtime_local' || selected.billingSource !== 'user_cli'
    || selected.processingLocation !== 'provider_remote') return fault('unsupported_selection');
  // Selection is an explicit member preference, not proof of a supported model,
  // processing residency, credential custody or an inference authorization.
  return input;
}
function record(raw: unknown): Record<string, unknown> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return fault('invalid_response');
  return raw as Record<string, unknown>;
}
function integer(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 0 || Object.is(raw, -0)) return fault('invalid_response');
  return raw;
}
function onlyKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) return fault('invalid_response');
}

/** Member-local CLI diagnostics and a non-executable preparation plan. The
 * documented 0.160.0 profile cannot prove an empty tool set: read-only permits
 * commands, and shell_tool=false does not disable every independent tool.
 * No observation or candidate plan supplies an operational execution permit. */
export function createCodexSubscriptionAdapter(options: { artifact: CliArtifact; probe: CliProbe }) {
  const supplied = dataObject(options, ['artifact', 'probe'], 'invalid_input');
  const values = dataObject(supplied.artifact.value, ['executable', 'sha256', 'version'], 'invalid_input');
  const suppliedProbe = supplied.probe.value;
  const probeMethod = dataObject(suppliedProbe, ['probe'], 'invalid_input').probe.value;
  if (typeof probeMethod !== 'function') return fault('invalid_input');
  const probe: CliProbe = Object.freeze({ probe: probeMethod.bind(suppliedProbe) });
  const artifact: CliArtifact = Object.freeze({ executable: values.executable.value, sha256: values.sha256.value, version: values.version.value });
  if (artifact.sha256 !== PINNED_SHA256 || typeof artifact.executable !== 'string'
    || !artifact.executable.startsWith('/') || artifact.executable.length > 4096 || /[\u0000-\u001F\u007F]/.test(artifact.executable)) return fault('artifact_mismatch');
  const pinned = () => { if (artifact.version !== PINNED_VERSION) return fault('unsupported_version'); };
  return Object.freeze({
    async inspect(): Promise<AdapterAssessment> {
      const blockers: AdapterIssue[] = ['effective_tool_policy_unavailable'];
      let installedVersion: string | undefined, authentication: AdapterAssessment['authentication'] = 'unknown';
      if (artifact.version !== PINNED_VERSION) return assessment(authentication, [...blockers, 'unsupported_version']);
      // Fresh-home probes can observe only that isolated home. They never read
      // the member's existing auth/config or establish provider authentication.
      const results = await Promise.allSettled(['version', 'help', 'auth_status'].map(operation => probe.probe(operation as 'version'|'help'|'auth_status')));
      const captured: ({ observation: CliObservation; text: string } | undefined)[] = results.map(result => {
        if (result.status === 'rejected') { blockers.push('probe_unavailable'); return undefined; }
        try {
          const observation = snapshotObservation(result.value);
          return { observation, text: diagnostic(observation) };
        } catch { blockers.push('probe_unavailable'); return undefined; }
      });
      const versionResult = captured[0];
      if (versionResult?.observation.exitCode === 0 && versionResult.text === `codex-cli ${PINNED_VERSION}`) installedVersion = PINNED_VERSION;
      else blockers.push('unsupported_version');
      const helpResult = captured[1];
      if (helpResult?.observation.exitCode !== 0
        || !['--json', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--sandbox', '--model'].every(flag => helpResult.text.includes(flag))) blockers.push('unsupported_version');
      const authResult = captured[2];
      if (authResult?.observation.exitCode === 0 && authResult.text === 'Logged in using ChatGPT') {
        authentication = 'local_observed_subscription';
      } else if (authResult?.observation.exitCode === 0
        && /^Logged in using an API key - [^\r\n]+$(?![\s\S])/.test(authResult.text)) {
        authentication = 'local_observed_api_key'; blockers.push('billing_route_mismatch');
      } else {
        if (authResult?.observation.exitCode === 1 && authResult.text === 'Not logged in') authentication = 'unavailable';
        blockers.push('authentication_unavailable');
      }
      return assessment(authentication, blockers, installedVersion);
    },
    prepare(raw: unknown): PreparedCliInvocation {
      const input = selection(raw); pinned();
      const argv = Object.freeze(['exec', '--json', '--color', 'never', '--ephemeral', '--ignore-user-config', '--ignore-rules',
        '--skip-git-repo-check', '--sandbox', 'read-only', '--model', input.selection.modelRef,
        '-c', 'model_provider="openai"', '-c', 'web_search="disabled"', '-c', 'agents.enabled=false',
        ...['shell_tool', 'unified_exec', 'apps', 'plugins', 'hooks', 'multi_agent', 'browser_use', 'computer_use', 'image_generation', 'view_image', 'code_mode_host', 'skill_search']
          .flatMap(feature => ['--disable', feature]), '-']);
      // No undocumented token-budget option or shell/profile/path passthrough.
      // These overrides are defense in depth, not proof of no model tools.
      return Object.freeze({ kind: 'cli_text_candidate', argv, stdin: new TextEncoder().encode(input.prompt), environment: Object.freeze({}),
        assessment: assessment('unknown', ['effective_tool_policy_unavailable', 'authentication_unavailable']), operational_authority: false });
    },
    decode(observation: CliObservation, raw: unknown): DecodedModelText {
      const input = selection(raw); pinned();
      observation = snapshotObservation(observation);
      if (observation.exitCode !== 0 || observation.signal !== null) return fault('outcome_unknown');
      if (!(observation.stderr instanceof Uint8Array) || observation.stderr.byteLength > 16384) return fault('response_limit');
      const events = parseModelJsonLines(observation.stdout);
      let phase: 'initial'|'thread'|'turn'|'completed' = 'initial', text = '';
      let inputTokens: number | null = null, outputTokens: number | null = null, totalTokens: number | null = null;
      const finishedItems = new Set<string>();
      const pendingItems = new Map<string, string>();
      let reportedModelRef: string | null = null;
      for (const value of events) {
        const event = record(value);
        if (phase === 'completed') return fault('invalid_response');
        if (event.model !== undefined) {
          if (event.model !== input.selection.modelRef) return fault('model_mismatch');
          reportedModelRef = input.selection.modelRef;
        }
        if (event.type === 'thread.started' && phase === 'initial') {
          onlyKeys(event, ['type', 'thread_id', 'model']);
          if (typeof event.thread_id !== 'string' || event.thread_id.length < 1 || event.thread_id.length > 128) return fault('invalid_response');
          phase = 'thread';
        } else if (event.type === 'turn.started' && phase === 'thread') {
          onlyKeys(event, ['type', 'model']); phase = 'turn';
        }
        else if (event.type === 'item.started' || event.type === 'item.updated' || event.type === 'item.completed') {
          onlyKeys(event, ['type', 'item', 'model']);
          if (phase !== 'turn') return fault('invalid_response');
          const item = record(event.item);
          if (item.type !== 'agent_message' && item.type !== 'reasoning') return fault('effective_tool_policy_unavailable');
          onlyKeys(item, ['id', 'type', 'text']);
          if (typeof item.id !== 'string' || item.id.length < 1 || item.id.length > 128 || finishedItems.has(item.id)) return fault('invalid_response');
          if (item.text !== undefined && typeof item.text !== 'string') return fault('invalid_response');
          const pendingType = pendingItems.get(item.id);
          if (pendingType !== undefined && pendingType !== item.type) return fault('invalid_response');
          if (event.type === 'item.started') {
            if (pendingType !== undefined) return fault('invalid_response');
            pendingItems.set(item.id, item.type);
          } else if (event.type === 'item.updated' && pendingType === undefined) return fault('invalid_response');
          if (event.type === 'item.completed') {
            pendingItems.delete(item.id);
            finishedItems.add(item.id);
            if (item.type === 'agent_message') {
              if (typeof item.text !== 'string') return fault('invalid_response');
              text = assertOutputText(text + item.text);
            }
          }
        } else if (event.type === 'turn.completed' && phase === 'turn') {
          onlyKeys(event, ['type', 'usage', 'model']);
          if (pendingItems.size) return fault('invalid_response');
          if (event.usage === undefined || event.usage === null) return fault('usage_unavailable');
          const usage = record(event.usage);
          onlyKeys(usage, ['input_tokens', 'output_tokens', 'cached_input_tokens', 'reasoning_output_tokens', 'total_tokens']);
          inputTokens = integer(usage.input_tokens); outputTokens = integer(usage.output_tokens);
          if (usage.cached_input_tokens !== undefined && integer(usage.cached_input_tokens) > inputTokens) return fault('invalid_response');
          if (usage.reasoning_output_tokens !== undefined && integer(usage.reasoning_output_tokens) > outputTokens) return fault('invalid_response');
          if (outputTokens > input.maxOutputTokens) return fault('response_limit');
          totalTokens = inputTokens + outputTokens;
          if (!Number.isSafeInteger(totalTokens)) return fault('invalid_response');
          if (usage.total_tokens !== undefined && integer(usage.total_tokens) !== totalTokens) return fault('invalid_response');
          phase = 'completed';
        } else if (event.type === 'turn.failed' || event.type === 'error') return fault('outcome_unknown');
        else return fault('invalid_response');
      }
      if (phase !== 'completed' || !text) return fault('invalid_response');
      // modelRef is the requested selection label. Official exec JSONL does not
      // attest the executed model; this private codec explicitly remains unverified.
      return Object.freeze({ text: assertOutputText(text), modelRef: input.selection.modelRef, reportedModelRef,
        usage: Object.freeze({ inputTokens, outputTokens, totalTokens }), evidence: 'unverified_provider_output', operational_authority: false });
    },
    async invoke(raw: unknown): Promise<never> {
      selection(raw); return fault('execution_authority_unavailable');
    },
  });
}
