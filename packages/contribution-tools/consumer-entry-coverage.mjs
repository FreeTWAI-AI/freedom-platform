// Trusted registration policy. Read Git blobs as data; never load candidate modules.
import { isDeepStrictEqual } from 'node:util';
import { deviceRegistrationBaseline, DEVICE_PROFILE } from './agent-kit-device-profile.mjs';
import { artifactPath, parseJson } from './io.mjs';
import { requireCondition as check } from './errors.mjs';

// All unlisted package fields require baseline review, including future execution
// metadata. Descriptive edits do not register a new executable entrance.
const descriptiveFields = new Set(['version', 'description', 'keywords', 'author', 'contributors',
  'license', 'repository', 'bugs', 'homepage', 'funding']);
export function verifyPackageEntryRegistrations(candidate, baseline) {
  for (const value of [candidate, baseline]) check(value && typeof value === 'object' && !Array.isArray(value), 'consumer_package_invalid');
  const registrations = value => Object.fromEntries(Object.entries(value).filter(([key]) => !descriptiveFields.has(key)));
  check(isDeepStrictEqual(registrations(candidate), registrations(baseline)), 'consumer_entry_registration_changed');
}

function registrationKind(path) {
  const name = path.split('/').at(-1);
  if (name.toLowerCase() === 'package.json') return 'package';
  if (/(?:^|\/)(?:\.github\/workflows|\.husky|\.githooks)\//i.test(path)
    || /(?:^|\/)(?:action\.ya?ml|\.npmrc|\.yarnrc(?:\.yml)?|\.pnpmfile\.cjs|pnpm-workspace\.yaml|binding\.gyp|Procfile|Dockerfile(?:\.[^/]+)?|compose\.ya?ml|docker-compose\.ya?ml)$/i.test(path)
    || /(?:^|\/)(?:wrangler(?:\.[^/]+)?\.(?:toml|jsonc?)|deno\.jsonc?|vercel\.json|netlify\.toml|ecosystem\.config\.[cm]?js|(?:vite|webpack|rollup|next|nuxt|svelte|astro)\.config\.[^/]+)$/i.test(path)) return 'automation';
  // npm's implicit start/install and Node's package-directory fallback can be
  // introduced without changing package.json. Existing targets remain editable.
  if (/(?:^|\/)(?:server\.js|index\.(?:js|node))$/i.test(path)) return 'implicit';
  return null;
}

/** Complete path inventories and readers MUST come from the host-selected Git trees.
 * This establishes explicit registration stability, not runtime route discovery,
 * actual imports, shared-library invocation, or operation authorization. */
export async function verifyConsumerEntryCoverage({ candidateFiles, baselineFiles, readCandidate, readBaseline, entryProfile }) {
  check(candidateFiles instanceof Map && baselineFiles instanceof Map
    && typeof readCandidate === 'function' && typeof readBaseline === 'function', 'trusted_entry_inventory_required');
  const paths = [...new Set([...candidateFiles.keys(), ...baselineFiles.keys()])].sort(), evidence = [];
  check(paths.length <= 16384, 'consumer_entry_inventory_limit');
  check(candidateFiles.has('package.json') && baselineFiles.has('package.json'), 'consumer_package_required');
  for (const path of paths) {
    artifactPath(path);
    const candidate = candidateFiles.get(path), baseline = baselineFiles.get(path), kind = registrationKind(path);
    if (candidate?.mode === '100755' || baseline?.mode === '100755') {
      check(candidate?.mode === baseline?.mode, 'consumer_executable_registration_changed');
    }
    if (!kind) continue;
    check(candidate && baseline, 'consumer_entry_registry_set_changed');
    if (kind === 'package') {
      const approved = parseJson(await readBaseline(path));
      verifyPackageEntryRegistrations(parseJson(await readCandidate(path)),
        entryProfile === DEVICE_PROFILE && path === 'package.json' ? deviceRegistrationBaseline(approved) : approved);
    }
    else if (kind === 'automation') check((await readCandidate(path)).equals(await readBaseline(path)), 'consumer_entry_automation_changed');
    evidence.push({ path, kind });
  }
  return { format: 'freedom.consumer-entry-coverage/v1', status: 'passed',
    coverage: 'explicit-package-registrations-and-known-launcher-files',
    registration_policy: 'unchanged-from-host-approved-baseline', registries: evidence,
    candidate_code_executed: false, runtime_entry_discovery: 'not_checked', library_invocation: 'not_checked' };
}
