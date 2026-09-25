// Cloud candidate acceptance CLI. Default is a plan with no network access.
//   npx tsx scripts/verify-cloud-candidate.ts plan --target staging
//   npx tsx scripts/verify-cloud-candidate.ts execute --target public --expected-release-sha <40-hex> --phases health,protocol
// Only https://staging.freetwai.com and https://freetwai.com are addressable.
// Credentials come from private files named by environment variables, never argv.
// The JSON report goes to stdout; progress lines (no values) go to stderr.
import { lstat, readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  LOAD_LIMITS, PHASES, READ_ONLY_PHASES, UsageError, accountFileRequired, candidateTarget, describeError, loadOptions, runCandidate, selectPhases,
  type AccessCredential, type Account, type PhaseId, type Target,
} from './verify-cloud-candidate-lib.js';

export const ACCOUNT_ENV = 'FREEDOM_CANDIDATE_ACCOUNT_FILE';
export const ACCESS_ENV = 'FREEDOM_CANDIDATE_ACCESS_FILE';
const DEMO_PASSWORDS = new Set(['freedom-local-demo']);

export const HELP = `Usage: npx tsx scripts/verify-cloud-candidate.ts [plan|execute] --target staging|public [options]

  plan (default)          Print the acceptance plan as JSON. No network, no credential files read.
  execute                 Run the selected phases against the exact allowlisted origin.
  --target                staging (https://staging.freetwai.com, mode staging)
                          public  (https://freetwai.com, mode public)
                          staging-next and next no longer resolve
  --phases a,b            ${PHASES.filter(id => id !== 'preflight').join(', ')}
                          default: ${READ_ONLY_PHASES.filter(id => id !== 'preflight').join(', ')} (read-only)
                          health is always added to any network run
  --expected-release-sha S  full 40-hex commit SHA the Worker health.release_sha must equal
                          (required by execute; plan may omit it and reports health not_run)
  --expected-version V    health.version to require (default: local package.json version)
  --dev-guild KEY         guild_ai_vibe (default) or guild_ai_field for guild-cache
  --dev-book ID           skill book used for /me/development/skill/:book (default video-autopilot)
  --load-requests N       ${LOAD_LIMITS.requests.min}-${LOAD_LIMITS.requests.max} (default ${LOAD_LIMITS.requests.default})
  --load-concurrency N    ${LOAD_LIMITS.concurrency.min}-${LOAD_LIMITS.concurrency.max} (default ${LOAD_LIMITS.concurrency.default})
  --load-rps N            ${LOAD_LIMITS.rps.min}-${LOAD_LIMITS.rps.max} (default ${LOAD_LIMITS.rps.default})
  --load-timeout-ms N     ${LOAD_LIMITS.timeoutMs.min}-${LOAD_LIMITS.timeoutMs.max} (default ${LOAD_LIMITS.timeoutMs.default})
  --load-max-error-rate R 0-0.5 (default 0.01)
  --load-max-p95-ms N     50-30000 (default 2000)

Environment (paths to private 0600 files owned by you; read only by execute):
  ${ACCOUNT_ENV}  {"candidate_origin","label","email","password","synthetic":true}
  ${ACCESS_ENV}   {"candidate_origin","client_id","client_secret"}   (optional; omit for public, which has no whole-host Access)

See scripts/verify-cloud-candidate.md for prerequisites, cleanup and acceptance gates.`;

export type Cli = { command: 'help' | 'plan' | 'execute'; target: Target | null; phases: PhaseId[]; expectedVersion: string | null; expectedReleaseSha: string | null; developmentGuild: string; developmentBook: string; load: ReturnType<typeof loadOptions> };

/** Strict parser: known flags only, validated values only; nothing free-form can carry a secret. */
export function parseArgs(argv: readonly string[]): Cli {
  const args = [...argv];
  let command: Cli['command'] = 'plan';
  if (args[0] === 'plan' || args[0] === 'execute') command = args.shift() as Cli['command'];
  if (args.includes('--help') || args.includes('-h')) return { command: 'help', target: null, phases: [], expectedVersion: null, expectedReleaseSha: null, developmentGuild: 'guild_ai_vibe', developmentBook: 'video-autopilot', load: loadOptions() };
  const values = new Map<string, string>();
  const numeric = ['--load-requests', '--load-concurrency', '--load-rps', '--load-timeout-ms', '--load-max-p95-ms'];
  const known = new Set(['--target', '--phases', '--expected-version', '--expected-release-sha', '--dev-guild', '--dev-book', '--load-max-error-rate', ...numeric]);
  while (args.length) {
    const flag = args.shift()!;
    if (!known.has(flag)) throw new UsageError('unknown argument');
    if (values.has(flag)) throw new UsageError(`duplicate ${flag}`);
    const value = args.shift();
    if (value === undefined || value.startsWith('--')) throw new UsageError(`${flag} needs a value`);
    values.set(flag, value);
  }
  if (!values.has('--target')) throw new UsageError('--target is required');
  const target = candidateTarget(values.get('--target')!);
  const phases = selectPhases(values.has('--phases') ? values.get('--phases')!.split(',').filter(Boolean) : null);
  const expectedVersion = values.get('--expected-version') ?? null;
  if (expectedVersion !== null && !/^[0-9A-Za-z.+-]{1,64}$/.test(expectedVersion)) throw new UsageError('--expected-version must match [0-9A-Za-z.+-]{1,64}');
  // The Worker only accepts and reports lowercase SHAs, so uppercase input is normalized.
  const rawSha = values.get('--expected-release-sha') ?? null;
  if (rawSha !== null && !/^[0-9A-Fa-f]{40}$/.test(rawSha)) throw new UsageError('--expected-release-sha must be a full 40-hex commit SHA');
  const expectedReleaseSha = rawSha?.toLowerCase() ?? null;
  if (command === 'execute' && phases.includes('health') && expectedReleaseSha === null) throw new UsageError('execute needs --expected-release-sha (health verifies the Worker release)');
  const developmentGuild = values.get('--dev-guild') ?? 'guild_ai_vibe';
  if (!['guild_ai_vibe', 'guild_ai_field'].includes(developmentGuild)) throw new UsageError('--dev-guild must be guild_ai_vibe or guild_ai_field');
  const developmentBook = values.get('--dev-book') ?? 'video-autopilot';
  if (!/^[a-z0-9-]{1,100}$/.test(developmentBook)) throw new UsageError('--dev-book must be a skill book id');
  const number = (flag: string) => {
    if (!values.has(flag)) return undefined;
    const raw = values.get(flag)!;
    if (!/^[0-9]+(\.[0-9]+)?$/.test(raw)) throw new UsageError(`${flag} must be a number`);
    return Number(raw);
  };
  const load = loadOptions({ requests: number('--load-requests'), concurrency: number('--load-concurrency'), rps: number('--load-rps'), timeoutMs: number('--load-timeout-ms'), maxP95Ms: number('--load-max-p95-ms'), maxErrorRate: number('--load-max-error-rate') });
  return { command, target, phases, expectedVersion, expectedReleaseSha, developmentGuild, developmentBook, load };
}

/** Reads a private JSON file: absolute path, regular file, owned by this user, mode 0600 or stricter. */
export async function readPrivateJson(path: string | undefined, label: string): Promise<Record<string, unknown>> {
  if (!path) throw new UsageError(`${label} file is not configured`);
  if (!isAbsolute(path)) throw new UsageError(`${label} file path must be absolute`);
  const info = await lstat(path).catch(() => null);
  if (!info || !info.isFile() || info.isSymbolicLink()) throw new UsageError(`${label} file must be a regular file`);
  if ((info.mode & 0o077) !== 0) throw new UsageError(`${label} file must not be readable by group or others (chmod 600)`);
  if (typeof process.getuid === 'function' && info.uid !== process.getuid()) throw new UsageError(`${label} file must be owned by the current user`);
  if (info.size > 4096) throw new UsageError(`${label} file is too large`);
  try {
    const value = JSON.parse(await readFile(path, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw new UsageError(`${label} file is not a JSON object`); }
}

export function validateAccount(raw: Record<string, unknown>, target: Target): Account {
  const keys = Object.keys(raw).sort().join(',');
  if (keys !== 'candidate_origin,email,label,password,synthetic') throw new UsageError('account file needs exactly candidate_origin, label, email, password, synthetic');
  if (raw.candidate_origin !== target.origin) throw new UsageError('account file is bound to a different origin');
  if (raw.synthetic !== true) throw new UsageError('account file must declare synthetic: true');
  if (typeof raw.label !== 'string' || !/^[a-z0-9-]{3,48}$/.test(raw.label)) throw new UsageError('account label must match [a-z0-9-]{3,48}');
  if (typeof raw.email !== 'string' || !/^[^\s@]{1,64}@[^\s@]{1,190}$/.test(raw.email)) throw new UsageError('account email is invalid');
  if (/@local\.test$/i.test(raw.email)) throw new UsageError('local demo accounts are not accepted on a candidate');
  if (typeof raw.password !== 'string' || raw.password.length < 12 || raw.password.length > 200 || DEMO_PASSWORDS.has(raw.password)) throw new UsageError('account password must be a dedicated 12-200 character secret');
  return { email: raw.email, password: raw.password, label: raw.label };
}

export function validateAccess(raw: Record<string, unknown>, target: Target): AccessCredential {
  const keys = Object.keys(raw).sort().join(',');
  if (keys !== 'candidate_origin,client_id,client_secret') throw new UsageError('access file needs exactly candidate_origin, client_id, client_secret');
  if (raw.candidate_origin !== target.origin) throw new UsageError('access file is bound to a different origin');
  if (typeof raw.client_id !== 'string' || !/^[A-Za-z0-9._-]{8,200}$/.test(raw.client_id) || typeof raw.client_secret !== 'string' || !/^[A-Za-z0-9._-]{16,200}$/.test(raw.client_secret)) throw new UsageError('access credential format is invalid');
  return { clientId: raw.client_id, clientSecret: raw.client_secret };
}

export async function main(argv: readonly string[], env: NodeJS.ProcessEnv = process.env) {
  const cli = parseArgs(argv);
  if (cli.command === 'help') { process.stdout.write(HELP + '\n'); return 0; }
  const target = cli.target!;
  const contract = JSON.parse(await readFile(new URL('../contracts/preview/v1/metadata.json', import.meta.url), 'utf8'));
  const expectedVersion = cli.expectedVersion ?? JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version;
  const base = { target, phases: cli.phases, expectedVersion, expectedReleaseSha: cli.expectedReleaseSha, contract, load: cli.load, developmentGuild: cli.developmentGuild, developmentBook: cli.developmentBook };
  if (cli.command === 'plan') {
    process.stdout.write(JSON.stringify(await runCandidate({ ...base, run: 'plan' }), null, 2) + '\n');
    return 0;
  }
  const account = accountFileRequired(cli.phases) ? validateAccount(await readPrivateJson(env[ACCOUNT_ENV], 'account'), target) : null;
  const access = env[ACCESS_ENV] ? validateAccess(await readPrivateJson(env[ACCESS_ENV], 'access'), target) : null;
  let browser: { close(): Promise<void>; newContext(options?: Record<string, unknown>): Promise<any> } | null = null;
  try {
    if (cli.phases.includes('browser') || cli.phases.includes('messages-mobile')) browser = await (await import('@playwright/test')).chromium.launch({ headless: true });
    const report = await runCandidate({ ...base, run: 'execute', account, access, browser, log: line => process.stderr.write(line + '\n') });
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    return report.overall === 'pass' ? 0 : 1;
  } finally {
    // The report is already written; a close failure is logged by sanitized class only.
    await browser?.close().catch(error => { process.stderr.write(`browser: close failed (${describeError(error)})\n`); });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }, error => {
    // Usage errors are our own fixed text; anything else is reduced to its class name.
    process.stderr.write((error instanceof UsageError ? `usage: ${error.message}` : `error: ${error instanceof Error ? error.name : 'Error'}`) + '\n');
    process.exitCode = 2;
  });
}
