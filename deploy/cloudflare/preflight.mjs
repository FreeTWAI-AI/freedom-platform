#!/usr/bin/env node
// Freedom Platform Cloudflare Workers + Cloudflare-billed PlanetScale Postgres migration preflight.
// Read-only by construction: offline checks, GET-only Cloudflare probes, allowlisted OCI/pscale reads.
// There is no execute mode in this phase; mutating steps are only rendered as a reviewable plan.
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCloudflareCredentials } from './lib/credentials.mjs';
import { createReadOnlyClient, probeCloudflare, readHyperdriveCaching } from './lib/cloudflare.mjs';
import { ociAlternativeCost, planetscaleCost } from './lib/cost.mjs';
import { DEFAULT_MANIFEST, loadManifest, validateManifest } from './lib/manifest.mjs';
import { checkMigrations } from './lib/migrations.mjs';
import { assertProfile, ociAlternativeStatus, probeOci } from './lib/oci.mjs';
import { probePlanetScale } from './lib/planetscale.mjs';
import { buildProvisionPlan } from './lib/provision-plan.mjs';
import { redactDeep, redactText } from './lib/redact.mjs';
import { checkWranglerConfig, parseJsonc } from './lib/wrangler.mjs';
import { readFileSync, existsSync } from 'node:fs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEFAULT_REPORT_DIR = join(homedir(), '.local', 'state', 'freedom-cloudflare-migration', 'reports');
const COMMANDS = ['manifest', 'migrations', 'wrangler', 'cost', 'oci-alternative', 'cloudflare', 'oci', 'planetscale', 'plan', 'all'];
const USAGE = `Usage: node deploy/cloudflare/preflight.mjs <command> [options]

Commands (all read-only):
  manifest                 validate deploy/cloudflare/environments.json
  migrations               static PG18 compatibility check of migrations/
  wrangler [--config P] [--env-file P]  validate a Worker config (default: wrangler.jsonc at repo root);
                           with --env-file also GET each real Hyperdrive id to prove caching.disabled
  cost                     PlanetScale (selected) and OCI alternative monthly arithmetic
  oci-alternative          offline OCI alternative status from recorded root facts (no OCI call)
  cloudflare --env-file P  GET-only permission and protected-resource probe
  oci [--oci-profile oracle1|oracle2] [--compare]  allowlisted OCI reads (alternative survey only)
  planetscale [--pscale-org O]  allowlisted pscale reads (never logs in or creates)
  plan --env staging-next|next  render the dry-run provisioning plan (Cloudflare-billed PlanetScale)
  all [--env-file P] [--oci]  offline checks + plans; network probes only when requested

The --env-file is a chmod 600 file with CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN
(legacy CF_ACCOUNT_ID / CF_API_TOKEN accepted; conflicting duplicates are refused).

Options:
  --report                 also write the redacted JSON report to ${DEFAULT_REPORT_DIR} (0700/0600)
  --manifest P             alternate manifest (tests)
  --execute                refused: no provider mutation exists in the preflight phase`;

export function parseArgs(argv) {
  const opts = { command: argv[0], flags: {} };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new Error(`Unexpected argument: ${a}`);
    const key = a.slice(2);
    if (['report', 'execute', 'help', 'compare', 'oci'].includes(key)) opts.flags[key] = true;
    else if (['env-file', 'pscale-org', 'env', 'config', 'manifest', 'oci-profile'].includes(key)) {
      if (argv[i + 1] === undefined) throw new Error(`--${key} needs a value`);
      opts.flags[key] = argv[++i];
    } else throw new Error(`Unknown option --${key}`);
  }
  return opts;
}

function writePrivateReport(report, dir = DEFAULT_REPORT_DIR) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const file = join(dir, `preflight-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(file, JSON.stringify(redactDeep(report), null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  return file;
}

export async function run(argv, deps = {}) {
  const { command, flags } = parseArgs(argv);
  if (!command || flags.help) return { code: command ? 0 : 2, output: USAGE };
  if (flags.execute) return { code: 3, output: 'Refused: this phase has no execute capability. Provisioning is a separate reviewed phase.' };
  if (!COMMANDS.includes(command)) return { code: 2, output: USAGE };
  if (flags['oci-profile']) assertProfile(flags['oci-profile']);
  const manifest = loadManifest(flags.manifest ?? DEFAULT_MANIFEST);
  const report = { tool: 'freedom-cloudflare-preflight/v3', generated_at: new Date().toISOString(), command, dry_run: true, provider_mutations: 0 };
  const want = (name) => command === name || command === 'all';

  if (want('manifest')) report.manifest = validateManifest(manifest);
  if (want('migrations')) report.migrations = (({ ledger, ...rest }) => rest)(checkMigrations(join(ROOT, 'migrations'), manifest.database_defaults.migrations));
  if (want('wrangler')) {
    const path = flags.config ?? join(ROOT, 'wrangler.jsonc');
    let hyperdriveConfigs;
    if (command === 'wrangler' && flags['env-file'] && existsSync(path)) {
      const credentials = loadCloudflareCredentials(flags['env-file']);
      const cfg = parseJsonc(readFileSync(path, 'utf8'));
      const ids = Object.values(cfg.env ?? {}).flatMap((b) => (b.hyperdrive ?? []).map((h) => h.id));
      hyperdriveConfigs = await readHyperdriveCaching({ client: createReadOnlyClient({ credentials, fetchImpl: deps.fetchImpl }), accountId: credentials.accountId, ids });
    }
    report.wrangler = checkWranglerConfig(path, manifest, { hyperdriveConfigs });
  }
  if (want('cost')) report.cost = { selected: planetscaleCost(manifest), oci_alternative: ['CI.Standard.E4.Flex', 'CI.Standard.A1.Flex'].map((connectorShape) => ociAlternativeCost(manifest, { connectorShape })) };
  if (want('oci-alternative')) report.oci_alternative = ociAlternativeStatus(manifest);
  if (command === 'plan') {
    if (!flags.env) throw new Error('plan needs --env staging-next|next');
    report.plan = buildProvisionPlan(manifest, flags.env);
  } else if (command === 'all') report.plan = Object.keys(manifest.environments).map((k) => buildProvisionPlan(manifest, k));
  if (command === 'cloudflare' || (command === 'all' && flags['env-file'])) {
    if (!flags['env-file']) throw new Error('cloudflare needs --env-file <chmod 600 file with CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN>');
    const credentials = loadCloudflareCredentials(flags['env-file']);
    const client = createReadOnlyClient({ credentials, fetchImpl: deps.fetchImpl });
    report.cloudflare = await probeCloudflare({ client, accountId: credentials.accountId, manifest });
  }
  if (command === 'oci' || (command === 'all' && flags.oci)) {
    const primary = flags['oci-profile'] ?? 'oracle1';
    const profiles = flags.compare ? [...new Set([primary, 'oracle2'])] : [primary];
    report.oci = [];
    for (const profile of profiles) report.oci.push(await probeOci({ profile, run: deps.ociRun, readConfig: deps.ociConfig }));
  }
  if (command === 'planetscale') {
    report.planetscale = await probePlanetScale({ run: deps.pscaleRun, manifest, org: flags['pscale-org'] });
  }

  const failed = report.manifest?.ok === false || report.migrations?.ok === false || report.wrangler?.status === 'fail';
  const safe = redactDeep(report);
  if (flags.report) safe.report_file = writePrivateReport(report, deps.reportDir);
  return { code: failed ? 1 : 0, output: JSON.stringify(safe, null, 2) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run(process.argv.slice(2)).then(
    ({ code, output }) => { process.stdout.write(output + '\n'); process.exitCode = code; },
    (error) => { process.stderr.write(`preflight error: ${redactText(error?.message ?? error)}\n`); process.exitCode = 2; },
  );
}
