import { AdapterFault, parseAdapterTextInput, type AdapterAssessment } from './common.js';
export { createCodexSubscriptionAdapter } from './codex.js';
export { createClaudeSubscriptionAdapter } from './claude.js';
export { createByokTextAdapter } from './byok.js';
export { createIsolatedCliProbe } from './cli-probe.js';
export { AdapterFault } from './common.js';
export type { AdapterAssessment, AdapterTextInput, CliArtifact, CliObservation, CliProbe,
  DecodedModelText, PreparedCliInvocation } from './common.js';

/** Explicit route selection only. No provider/model defaults, credentials,
 * fallback, operational permit, process launch or outbound request. */
export function selectModelAdapterRoute(raw: unknown): AdapterAssessment['route'] {
  const { selection } = parseAdapterTextInput(raw);
  if (selection.processingLocation !== 'provider_remote') throw new AdapterFault('unsupported_selection');
  if (selection.credentialCustody === 'official_cli') {
    if (selection.providerRef === 'openai') return 'codex_subscription';
    if (selection.providerRef === 'anthropic') return 'claude_subscription';
  } else if (selection.providerRef === 'openai' || selection.providerRef === 'anthropic' || selection.providerRef === 'openrouter') return 'byok';
  throw new AdapterFault('unsupported_selection');
}
