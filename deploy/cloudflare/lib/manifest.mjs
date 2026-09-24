import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_MANIFEST = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'environments.json');
const ENV_PREFIX = { 'staging-next': 'freedom-staging-next', next: 'freedom-next' };
const ENV_ROLE_PREFIX = { 'staging-next': 'freedom_staging_next_', next: 'freedom_next_' };
// Kinds whose names are human labels or hostnames rather than prefixed resource names.
const UNPREFIXED = new Set(['hostname', 'access_application']);

export function loadManifest(path = DEFAULT_MANIFEST) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** Every mutable name a candidate environment owns, keyed by resource kind. */
export function ownedResources(env) {
  return {
    hostname: [env.hostname],
    worker: [env.worker.name],
    hyperdrive: [env.hyperdrive.name],
    database: [env.database.name],
    db_role: Object.values(env.database.roles),
    r2_bucket: env.r2_buckets.map((b) => b.name),
    access_application: [env.access.application_name, env.access.admin_application_name],
  };
}

export function validateManifest(m) {
  const errors = [];
  const err = (msg) => errors.push(msg);
  if (m.schema !== 'freedom.cloudflare-migration-plan/v3') err('unexpected schema');
  if (m.zone !== 'freetwai.com') err('zone must be freetwai.com');
  const protectedHosts = new Set(m.protected?.hostnames ?? []);
  for (const h of ['freetwai.com', 'staging.freetwai.com']) if (!protectedHosts.has(h)) err(`protected hostnames must include ${h}`);
  for (const db of ['freedom_local', 'freedom_staging', 'freedom_public']) if (!m.protected?.local?.databases?.includes(db)) err(`protected local databases must include ${db}`);
  const d = m.database_defaults ?? {};
  if (d.engine !== 'postgresql' || d.major_version !== 18) err('database must be PostgreSQL 18 to match the current PG18 source');
  if (!Array.isArray(d.extensions_required)) err('extensions_required must be an explicit list');
  if (m.providers?.selected !== 'planetscale_cloudflare_billed') err('selected provider must be planetscale_cloudflare_billed');
  const ps = m.providers?.planetscale ?? {};
  if (ps.billing !== 'cloudflare') err('PlanetScale must be billed through Cloudflare');
  if (!ps.catalog?.source || !['catalog_required', 'org_quote_recorded'].includes(ps.catalog?.status)) err('PlanetScale catalog needs a source and a status (catalog_required until an org quote is recorded)');
  if (ps.topology_nodes?.ha?.nodes !== 3 || ps.topology_nodes?.ha?.replicas !== 2) err('PlanetScale HA is 1 primary + 2 replicas (3 nodes)');
  if (m.providers?.oci && m.providers.oci.provisioning !== false) err('OCI is a surveyed alternative; provisioning must be false');
  if (m.providers?.d1 && m.providers.d1.drop_in !== false) err('D1 is not a drop-in replacement');
  if (m.budget?.authorized_cap_usd_month !== null && typeof m.budget?.authorized_cap_usd_month !== 'number') err('budget.authorized_cap_usd_month must be null (none given) or a user-provided number');
  const rt = m.runtime ?? {};
  if (rt.hyperdrive_binding !== 'HYPERDRIVE') err('runtime Hyperdrive binding must be HYPERDRIVE');

  const envs = Object.entries(m.environments ?? {});
  if (envs.map(([k]) => k).sort().join(',') !== 'next,staging-next') err('environments must be exactly staging-next and next');
  const seen = new Map();
  for (const [key, env] of envs) {
    const prefix = ENV_PREFIX[key];
    if (env.hostname !== `${key}.freetwai.com`) err(`${key}: hostname must be ${key}.freetwai.com`);
    if (protectedHosts.has(env.hostname)) err(`${key}: hostname ${env.hostname} is protected`);
    if (env.worker?.workers_dev !== false) err(`${key}: workers_dev must be false`);
    if (env.worker?.preview_urls !== false) err(`${key}: preview_urls must be false (no public preview URL bypassing Access)`);
    if (env.access?.required !== true) err(`${key}: Access protection is required`);
    const hd = env.hyperdrive;
    if (!hd || Array.isArray(hd)) err(`${key}: exactly one Hyperdrive config (object, not a list)`);
    else {
      if (hd.binding !== 'HYPERDRIVE') err(`${key}: Hyperdrive binding must be HYPERDRIVE`);
      if (hd.caching_disabled !== true) err(`${key}: Hyperdrive must have caching disabled for all platform queries`);
    }
    if (key === 'next' && env.data_source === 'synthetic') err('next: candidate rehearsal data must come from a public backup restore');
    if (key === 'staging-next' && env.data_source !== 'synthetic') err('staging-next: must use synthetic data only (no live data, no local demo accounts)');
    if (key === 'staging-next' && env.database?.topology !== 'single_node') err('staging-next: starts as a single_node PS-5');
    if (key === 'next' && env.database?.topology !== 'ha') err('next: production candidate must be HA before cutover');
    const price = ps.catalog?.monthly_usd?.[`${env.database?.size} ${env.database?.topology}`];
    if (price === undefined) err(`${key}: size ${env.database?.size} ${env.database?.topology} is not a catalog SKU`);
    else if (price !== null && !(typeof price === 'number' && price >= 0)) err(`${key}: catalog price must be null (unknown) or a recorded number`);
    if ((env.secret_names ?? []).includes('DATABASE_URL')) err(`${key}: runtime DB access must come from the Hyperdrive binding, not a DATABASE_URL secret`);
    for (const secret of env.secret_names ?? []) if ((env.var_names ?? []).includes(secret)) err(`${key}: ${secret} listed as both secret and plain var`);
    for (const v of env.var_names ?? []) if (/(URL|KEY|SECRET|TOKEN|PASSWORD)$/.test(v) && v !== 'APP_ORIGIN') err(`${key}: ${v} looks secret and must not be a plain var`);
    if (rt.release_var && !(env.var_names ?? []).includes(rt.release_var)) err(`${key}: ${rt.release_var} must be a required var`);
    let owned;
    try { owned = ownedResources(env); } catch { err(`${key}: incomplete resource names`); continue; }
    for (const [kind, names] of Object.entries(owned)) {
      for (const name of names) {
        if (!name) { err(`${key}: empty ${kind} name`); continue; }
        if (kind === 'worker') { if (name !== `freedom-platform-${key}`) err(`${key}: worker must be named freedom-platform-${key}`); }
        else if (kind === 'db_role') { if (!name.startsWith(ENV_ROLE_PREFIX[key])) err(`${key}: db_role ${name} must use the ${ENV_ROLE_PREFIX[key]} prefix`); }
        else if (!UNPREFIXED.has(kind) && !name.startsWith(prefix)) err(`${key}: ${kind} ${name} must use the ${prefix} prefix`);
        if (kind === 'access_application' && (m.protected.access_applications ?? []).includes(name)) err(`${key}: Access application ${name} is protected`);
        const tag = `${kind}:${name}`;
        if (seen.has(tag)) err(`${kind} ${name} is shared between ${seen.get(tag)} and ${key}`);
        seen.set(tag, key);
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Default-deny guard for any future mutating step. A target passes only when it is a name the
 * manifest assigns to that exact environment and resource kind, and is not protected. OCI is a
 * surveyed alternative only, so every OCI kind is refused.
 */
export function assertMutationTarget(m, envKey, kind, name) {
  const env = m.environments?.[envKey];
  if (!env) throw new Error(`Unknown environment: ${envKey}`);
  const p = m.protected;
  if (kind === 'hostname' && p.hostnames.includes(name)) throw new Error(`Refusing protected hostname ${name}`);
  if (kind === 'access_application' && p.access_applications.includes(name)) throw new Error(`Refusing protected Access application ${name}`);
  if (kind === 'database' && p.local.databases.includes(name)) throw new Error(`Refusing protected local database ${name}`);
  if (kind === 'oci_instance') throw new Error('Existing OCI compute instances are never used or changed');
  if (kind.startsWith('oci_')) throw new Error('OCI is a surveyed alternative; this plan provisions no OCI resource');
  const owned = ownedResources(env)[kind];
  if (!owned) throw new Error(`Unknown resource kind: ${kind}`);
  if (!owned.includes(name)) throw new Error(`${kind} ${name} is not owned by ${envKey}; refusing`);
  return true;
}
