import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { redactText } from './redact.mjs';

export const ALLOWED_PROFILES = Object.freeze(['oracle1', 'oracle2']);
// ocid1.<type>.<realm>.[region][.future].<unique>
const OCID = /^ocid1\.[a-z0-9]+\.[a-z0-9-]+\.[a-z0-9.-]*[a-z0-9]$/;

export function assertProfile(profile) {
  if (!ALLOWED_PROFILES.includes(profile)) throw new Error(`OCI profile ${redactText(profile)} is not allowed; use ${ALLOWED_PROFILES.join(' or ')}`);
  return profile;
}

/** Reads only the tenancy OCID of one allowlisted profile; key paths, fingerprints and users are skipped. */
export function tenancyFromConfig(text, profile) {
  assertProfile(profile);
  let current = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const section = /^\[(.+)\]$/.exec(line);
    if (section) { current = section[1]; continue; }
    if (current !== profile) continue;
    const m = /^tenancy\s*=\s*(\S+)$/.exec(line);
    if (m) {
      if (!OCID.test(m[1])) throw new Error(`tenancy in profile ${profile} is not an OCID`);
      return m[1];
    }
  }
  throw new Error(`profile ${profile} has no tenancy entry`);
}

// Read-only checks. Each builds the exact argv; the runner refuses anything else.
// Command names follow OCI CLI 3.x; a check that fails to parse is reported, not fatal.
export const CHECKS = {
  regions: (t) => ['iam', 'region-subscription', 'list', '--tenancy-id', t],
  compartments: (t) => ['iam', 'compartment', 'list', '--compartment-id', t, '--all', '--lifecycle-state', 'ACTIVE'],
  pg_db_systems: (t) => ['psql', 'db-system', 'list', '--compartment-id', t, '--all'],
  pg_shapes: (t) => ['psql', 'shape-summary', 'list-shapes', '--compartment-id', t, '--all'],
  pg_default_configs: (t) => ['psql', 'default-configuration-collection', 'list-default-configurations', '--all'],
  pg_limit_values: (t) => ['limits', 'value', 'list', '--service-name', 'postgresql', '--compartment-id', t, '--all'],
  pg_limit_definitions: (t) => ['limits', 'definition', 'list', '--service-name', 'postgresql', '--compartment-id', t, '--all'],
  ci_limit_values: (t) => ['limits', 'value', 'list', '--service-name', 'container-instances', '--compartment-id', t, '--all'],
};
const ALLOWED_ARGV = new Set(Object.values(CHECKS).map((f) => f('<t>').join(' ')));

export function assertReadOnlyOciArgs(args, tenancy) {
  const shape = args.map((a) => (a === tenancy ? '<t>' : a)).join(' ');
  if (!ALLOWED_ARGV.has(shape) || (tenancy && !OCID.test(tenancy))) throw new Error(`oci arguments not in read-only allowlist: ${redactText(shape)}`);
}

export function defaultOciRunner(bin = 'oci') {
  return (args, profile) => new Promise((done) => {
    const env = { OCI_CLI_SUPPRESS_FILE_PERMISSIONS_WARNING: 'True' };
    for (const k of ['PATH', 'HOME', 'OCI_CLI_CONFIG_FILE']) if (process.env[k]) env[k] = process.env[k];
    execFile(bin, [...args, '--profile', profile, '--output', 'json'], { timeout: 60000, maxBuffer: 16 * 1024 * 1024, env }, (error, stdout, stderr) => {
      done({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout: String(stdout), stderr: String(stderr), missing: error?.code === 'ENOENT' });
    });
  });
}

const OCI_ERROR_CODE = /^[A-Za-z0-9_-]{1,64}$/;

/** Allowlisted `code` from a JSON error object, if one is present. Raw CLI text is never returned. */
function allowlistedOciCode(text) {
  if (typeof text !== 'string' || !text) return null;
  const slices = [text];
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) slices.push(text.slice(start, end + 1));
  for (const slice of slices) {
    try {
      const value = JSON.parse(slice);
      const code = value && typeof value === 'object' && !Array.isArray(value) ? value.code : null;
      if (typeof code === 'string' && OCI_ERROR_CODE.test(code)) return code;
    } catch { /* not JSON; do not keep the line */ }
  }
  return null;
}

function ociErrorCheck(res) {
  return {
    status: 'error',
    exit_code: Number.isInteger(res?.code) ? res.code : null,
    code: allowlistedOciCode(res?.stdout) ?? allowlistedOciCode(res?.stderr),
  };
}

const items = (body) => (Array.isArray(body?.data) ? body.data : Array.isArray(body?.data?.items) ? body.data.items : []);
const freedomName = (n) => typeof n === 'string' && n.startsWith('freedom');

// Field pickers: only non-identifying catalog/state fields leave this module.
const SANITIZE = {
  regions: (b) => items(b).map((r) => ({ region: r['region-name'], status: r.status, home: r['is-home-region'] })),
  compartments: (b) => ({ count: items(b).length, freedom_named: items(b).map((c) => c.name).filter(freedomName) }),
  pg_db_systems: (b) => ({ count: items(b).length, freedom_named: items(b).filter((d) => freedomName(d['display-name'])).map((d) => ({ name: d['display-name'], state: d['lifecycle-state'] })) }),
  pg_shapes: (b) => items(b).map((s) => ({ shape: s.shape ?? s.name, ocpu_min: s['ocpu-options']?.['min'] ?? s['min-ocpu'] ?? null, memory_min_gb: s['memory-options']?.['min-in-gbs'] ?? null, flexible: s['is-flexible'] ?? null })),
  pg_default_configs: (b) => items(b).map((c) => ({ name: c['display-name'], db_version: c['db-version'], shape: c.shape ?? null, flexible: c['is-flexible'] ?? null, state: c['lifecycle-state'] ?? null })),
  pg_limit_values: (b) => items(b).map((v) => ({ name: v.name, scope: v['scope-type'], value: v.value })),
  pg_limit_definitions: (b) => items(b).map((d) => ({ name: d.name, deprecated: d['is-deprecated'] ?? null, scope: d['scope-type'], description: d.description ?? null })),
  ci_limit_values: (b) => items(b).map((v) => ({ name: v.name, scope: v['scope-type'], value: v.value })),
};

/**
 * dbsystem-count = 0 is a blocker whenever that aggregate limit is live (not deprecated): a shape
 * family limit such as dbsystem-e5-count = 20 does not override a zero total. Only a deprecated
 * aggregate lets shape-specific headroom govern.
 */
export function interpretPgLimits(values, definitions) {
  const val = (n) => values?.find((v) => v.name === n)?.value;
  const def = (n) => definitions?.find((d) => d.name === n);
  const aggregate = val('dbsystem-count');
  const shapeLimits = (values ?? []).filter((v) => /^dbsystem-.+-count$/.test(v.name) && v.value > 0 && !def(v.name)?.deprecated);
  if (!definitions?.length) return { status: 'unknown', reason: 'limit definitions not read', aggregate, shape_limits: shapeLimits };
  const aggregateDef = def('dbsystem-count');
  if (aggregate === 0 && !aggregateDef) return { status: 'unknown', reason: 'dbsystem-count has a value but no definition; ask Oracle or test in the console before relying on shape limits', shape_limits: shapeLimits };
  if (aggregate === 0 && aggregateDef.deprecated !== true) return { status: 'blocked', reason: 'dbsystem-count is an active limit with total 0; shape-family limits do not override it, so creation is blocked until Oracle raises it', shape_limits: shapeLimits };
  if (!shapeLimits.length) return { status: 'blocked', reason: 'no shape-specific DB system limit with headroom', aggregate };
  return { status: 'capacity_available', reason: aggregate === 0 ? 'dbsystem-count is deprecated; shape-specific limits apply' : 'aggregate and shape limits have headroom', shape_limits: shapeLimits };
}

export async function probeOci({ profile = 'oracle1', run = defaultOciRunner(), readConfig = () => readFileSync(process.env.OCI_CLI_CONFIG_FILE ?? join(homedir(), '.oci', 'config'), 'utf8') } = {}) {
  assertProfile(profile);
  const tenancy = tenancyFromConfig(readConfig(), profile);
  const report = { profile, checks: {}, findings: [] };
  for (const [id, build] of Object.entries(CHECKS)) {
    const args = build(tenancy);
    assertReadOnlyOciArgs(args, tenancy);
    const res = await run(args, profile);
    if (res.missing) return { ...report, cli: 'not_installed' };
    let body = null;
    try { body = JSON.parse(res.stdout); } catch { body = null; }
    if (res.code !== 0 || !body) {
      report.checks[id] = ociErrorCheck(res);
      continue;
    }
    report.checks[id] = { status: 'ok', data: SANITIZE[id](body) };
  }
  const data = (id) => (report.checks[id]?.status === 'ok' ? report.checks[id].data : null);
  report.pg_limits = interpretPgLimits(data('pg_limit_values'), data('pg_limit_definitions'));
  const pg18 = (data('pg_default_configs') ?? []).filter((c) => String(c.db_version).startsWith('18'));
  report.pg18_default_configs = pg18.length;
  if (data('pg_default_configs') && !pg18.length) report.findings.push({ severity: 'high', id: 'no_pg18_config', detail: 'No PostgreSQL 18 default configuration listed.' });
  if (data('pg_db_systems')?.freedom_named.length) report.findings.push({ severity: 'medium', id: 'freedom_db_system_exists', detail: 'A freedom-* DB system already exists; confirm ownership before reuse.' });
  if (data('compartments')?.freedom_named.length) report.findings.push({ severity: 'info', id: 'freedom_compartment_exists', detail: `Existing freedom-* compartments: ${data('compartments').freedom_named.join(', ')}` });
  return report;
}

/**
 * Offline summary of the surveyed OCI alternative from root's recorded live facts (no OCI call).
 * The quota verdict uses the same rule as a live read; TLS stays not_run until a verified path exists.
 */
export function ociAlternativeStatus(manifest) {
  const oci = manifest.providers.oci;
  const lim = oci.facts.limits;
  const values = Object.entries(lim).map(([name, v]) => ({ name, value: v.value }));
  const definitions = Object.entries(lim).filter(([, v]) => 'definition_is_deprecated' in v).map(([name, v]) => ({ name, deprecated: v.definition_is_deprecated }));
  return {
    role: oci.role,
    provisioning: false,
    profiles: oci.profiles,
    profiles_checked: oci.facts.profiles_identical,
    pg18_available: oci.facts.pg18_available,
    db_shape_minimum: oci.facts.db_shape_minimum,
    quota: interpretPgLimits(values, definitions),
    tls: { status: oci.tls.status, ready: false, detail: oci.tls.detail },
    existing_vms: 'forbidden (never used, changed or SSHed into)',
  };
}
