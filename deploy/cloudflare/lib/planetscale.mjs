import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { redactText } from './redact.mjs';

export const PSCALE_BIN = join(homedir(), '.local', 'bin', 'pscale');

// Exact read-only argument vectors; anything else is refused before a process starts.
const READ_ONLY = [
  (a) => a.join(' ') === 'version',
  (a) => a.join(' ') === 'auth check --format json',
  (a) => a.join(' ') === 'org list --format json',
  (a) => a.length === 6 && a[0] === 'database' && a[1] === 'list' && a[2] === '--org' && /^[a-z0-9-]+$/.test(a[3]) && a[4] === '--format' && a[5] === 'json',
  (a) => a.join(' ') === 'region list --format json',
  (a) => a.length === 11 && a.slice(0, 3).join(' ') === 'size cluster list' && a[3] === '--org' && /^[a-z0-9-]+$/.test(a[4]) && a[5] === '--engine' && a[6] === 'postgresql' && a[7] === '--region' && /^[a-z0-9-]+$/.test(a[8]) && a[9] === '--format' && a[10] === 'json',
];

export function assertReadOnlyArgs(args) {
  if (!READ_ONLY.some((ok) => ok(args))) throw new Error(`pscale arguments not in read-only allowlist: ${redactText(args.join(' '))}`);
}

// Pass only what pscale needs to find its own stored login (config dir or desktop keyring).
function pscaleEnv() {
  const env = { NO_COLOR: '1' };
  for (const k of ['PATH', 'HOME', 'XDG_CONFIG_HOME', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS']) if (process.env[k]) env[k] = process.env[k];
  return env;
}

export function defaultRunner(bin = PSCALE_BIN) {
  return (args) => new Promise((resolveRun) => {
    execFile(bin, args, { timeout: 30000, maxBuffer: 4 * 1024 * 1024, env: pscaleEnv() }, (error, stdout, stderr) => {
      resolveRun({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout: String(stdout), stderr: String(stderr), missing: error?.code === 'ENOENT' });
    });
  });
}

export function versionAtLeast(version, min) {
  const a = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version ?? '');
  if (!a) return null;
  const b = min.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (Number(a[i + 1]) !== b[i]) return Number(a[i + 1]) > b[i];
  return true;
}

function parseJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

export async function probePlanetScale({ run = defaultRunner(), manifest, org } = {}) {
  const call = async (args) => { assertReadOnlyArgs(args); return run(args); };
  const report = { cli: {}, auth: {}, orgs: [], databases: [], regions: [], sizes: {}, findings: [] };
  const version = await call(['version']);
  if (version.missing) return { ...report, cli: { installed: false }, auth: { status: 'not_run', reason: 'pscale not installed' } };
  report.cli = { installed: true, version: /pscale version (\S+)/.exec(version.stdout)?.[1] ?? 'unknown' };
  report.cli.meets_cloudflare_billing_minimum = versionAtLeast(report.cli.version, manifest.providers.planetscale.pscale_cli_min_version);
  if (report.cli.meets_cloudflare_billing_minimum === false) report.findings.push({ severity: 'high', id: 'pscale_too_old', detail: `--cloudflare-billing needs pscale >= ${manifest.providers.planetscale.pscale_cli_min_version}.` });

  const auth = await call(['auth', 'check', '--format', 'json']);
  const authBody = parseJson(auth.stdout) ?? parseJson(auth.stderr);
  report.auth = { status: authBody?.authenticated === true ? 'authenticated' : 'unauthenticated', method: authBody?.auth_method ?? null };
  if (report.auth.status !== 'authenticated') {
    report.findings.push({ severity: 'high', id: 'planetscale_not_authenticated', detail: 'Creating the Cloudflare-billed database needs an authenticated pscale organization (or the Cloudflare dashboard). This tool never logs in; org size availability stays not_run.' });
    return report;
  }

  const orgs = parseJson((await call(['org', 'list', '--format', 'json'])).stdout) ?? [];
  report.orgs = orgs.map((o) => ({ name: o.name, billing_via_cloudflare: o.billing_provider ? /cloudflare/i.test(o.billing_provider) : 'unknown' }));
  const chosen = org ?? (report.orgs.length === 1 ? report.orgs[0].name : null);
  if (!chosen) {
    report.findings.push({ severity: 'high', id: 'planetscale_org_ambiguous', detail: 'Pass --pscale-org explicitly; the tool does not guess between organizations.' });
    return report;
  }
  report.org = chosen;
  const dbs = parseJson((await call(['database', 'list', '--org', chosen, '--format', 'json'])).stdout) ?? [];
  // Names, kind, region and state only; never URLs, hosts or credentials.
  report.databases = dbs.map((d) => ({ name: d.name, kind: d.kind ?? d.engine ?? null, region: d.region?.slug ?? null, state: d.state ?? null }));
  const wanted = Object.values(manifest.environments).map((e) => e.database.name);
  for (const d of report.databases) if (wanted.includes(d.name)) report.findings.push({ severity: 'medium', id: 'database_name_taken', detail: `${d.name} already exists; confirm ownership before reuse.` });
  for (const d of report.databases) if (wanted.includes(d.name) && d.kind && !/postgres/i.test(d.kind)) report.findings.push({ severity: 'high', id: 'database_wrong_engine', detail: `${d.name} is ${d.kind}, not Postgres.` });

  const regions = parseJson((await call(['region', 'list', '--format', 'json'])).stdout) ?? [];
  report.regions = regions.map((r) => ({ slug: r.slug, provider: r.provider, enabled: r.enabled, postgres: r.postgresql_enabled ?? r.supports_postgres ?? null }));
  const preferred = manifest.providers.planetscale.region_preference;
  const available = new Set(report.regions.map((r) => r.slug));
  report.region_choice = preferred.map((p) => ({ ...p, listed: available.has(p.pscale_slug) }));
  const slug = preferred.map((p) => p.pscale_slug).find((s) => available.has(s));
  if (slug) {
    const sizes = parseJson((await call(['size', 'cluster', 'list', '--org', chosen, '--engine', 'postgresql', '--region', slug, '--format', 'json'])).stdout) ?? [];
    report.sizes = { region: slug, skus: sizes.map((s) => ({ name: s.name ?? s.display_name, rate: s.rate ?? s.price ?? null, replicas: s.replicas ?? null })) };
  }
  return report;
}
