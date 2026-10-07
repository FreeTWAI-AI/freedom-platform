import type { FileHandle } from 'node:fs/promises';
import { AdapterFault, type CliArtifact, type CliObservation, type CliProbe } from './common.js';

import { nativeArtifactSnapshot, pinNativeExecutable, runPinnedNative, isolatedNativeArguments } from './native-executable.js';

const MAX_OUTPUT = 32768, PROCESS_MS = 3000;
const fail = (code: 'invalid_input'|'artifact_mismatch'|'probe_unavailable'|'response_limit'): never => { throw new AdapterFault(code); };
/** Diagnostic-only host port. The operation grammar cannot run a model, login,
 * logout, arbitrary arguments or caller-supplied commands/configuration. No
 * member home, credentials, profiles, repositories or network are mounted. */
export function createIsolatedCliProbe(raw: CliArtifact, kind: 'codex'|'claude'): CliProbe {
  const artifact = nativeArtifactSnapshot(raw);
  if (kind !== 'codex' && kind !== 'claude') return fail('invalid_input');
  return Object.freeze({
    async probe(operation: 'version'|'help'|'auth_status'): Promise<CliObservation> {
      if (!['version', 'help', 'auth_status'].includes(operation)) return fail('invalid_input');
      if (process.platform !== 'linux' || process.arch !== 'x64') return fail('probe_unavailable');
      let snapshot: FileHandle | undefined;
      try {
        const argv = operation === 'version' ? ['--version'] : operation === 'help' ? (kind === 'codex' ? ['exec','--help'] : ['--help']) : (kind === 'codex' ? ['login','status'] : ['auth','status']);
        const args = await isolatedNativeArguments(argv);
        snapshot = await pinNativeExecutable(artifact);
        return await runPinnedNative(snapshot, args, { timeoutMs: PROCESS_MS, combinedBytes: MAX_OUTPUT });
      } finally { await snapshot?.close(); }
    },
  });
}
