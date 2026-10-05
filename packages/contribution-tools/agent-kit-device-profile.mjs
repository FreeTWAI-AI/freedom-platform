// Narrow versioned launch contract, not a general JS import analyzer.
import { requireCondition as check } from './errors.mjs';
import { parseJson, sha256 } from './io.mjs';
export const DEVICE_REPOSITORY = 'FreeTWAI-AI/freedom-agent-kit';
export const DEVICE_PROFILE = 'agent-kit-device-cli-v1';
export const DEVICE_ENTRY = 'src/device-cli.mjs';
export const DEVICE_CLOSURE = Object.freeze([
  ['scripts/repository-bootstrap/agent-kit-device-cli.mjs', DEVICE_ENTRY],
  ...['machine-device-cli', 'machine-device-client'].map(name => [
    `packages/sdk/${name}.mjs`, `vendor/freedom-libraries/packages/sdk/${name}.mjs`]),
]);
export async function verifyDeviceLaunchClosure(readCandidate, readCanonical) {
  const evidence = [];
  for (const [source, path] of DEVICE_CLOSURE) {
    const bytes = await readCandidate(path);
    check(bytes.equals(await readCanonical(source)), 'device_launch_closure_mismatch');
    evidence.push({ path, source, sha256: sha256(bytes) });
  }
  return { profile: DEVICE_PROFILE, entry: DEVICE_ENTRY, files: evidence,
    coverage: 'closed-canonical-bootstrap-command-only', arbitrary_candidate_provenance: 'not_checked' };
}
// A reviewed transition may add exactly this command and its syntax check. All
// other registrations and hooks retain the baseline policy. Future versions can
// make the already-upgraded package the baseline without a new exception.
export function deviceRegistrationBaseline(baseline) {
  const value = structuredClone(baseline);
  check(value.scripts && ['node --check src/cli.mjs', 'node --check src/cli.mjs && node --check src/device-cli.mjs'].includes(value.scripts.build),
    'device_baseline_registration_invalid');
  check(value.scripts['device:status'] === undefined || value.scripts['device:status'] === 'node src/device-cli.mjs',
    'device_baseline_registration_invalid');
  for (const hook of ['predevice:status', 'postdevice:status', 'prebuild', 'postbuild']) check(!Object.hasOwn(value.scripts, hook), 'device_baseline_registration_invalid');
  value.scripts['device:status'] = 'node src/device-cli.mjs';
  value.scripts.build = 'node --check src/cli.mjs && node --check src/device-cli.mjs';
  return parseJson(JSON.stringify(value));
}
