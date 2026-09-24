import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_MANIFEST = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'environments.json');
const ENV_PREFIX = { 'staging-next': 'freedom-staging-next', next: 'freedom-next' };
const ENV_ROLE_PREFIX = { 'staging-next': 'freedom_staging_next_', next: 'freedom_next_' };

export function loadManifest(path = DEFAULT_MANIFEST) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** Every mutable name a candidate environment owns, keyed by resource kind. */
export function ownedResources(env) {
  return {
    hostname: [env.hostname],
    worker: [env.worker.name],
    hyperdrive: env.hyperdrive.map((h) => h.name),
    database: [env.database.name],
    db_role: Object.values(env.database.roles),
    r2_bucket: env.r2_buckets.map((b) => b.name),
    access_application: [env.access.application_name, env.access.admin_application_name],
  };
}

export function validateManifest(m) {
  const errors = [];
  const err = (msg) => errors.push(msg);
  if (m.schema !== 'freedom.cloudflare-migration-plan/v1') err('unexpected schema');
  if (m.zone !== 'freetwai.com') err('zone must be freetwai.com');
  const protectedHosts = new Set(m.protected?.hostnames ?? []);
  for (const h of ['freetwai.com', 'staging.freetwai.com']) if (!protectedHosts.has(h)) err(`protected hostnames must include ${h}`);
  for (const db of ['freedom_local', 'freedom_staging', 'freedom_public']) if (!m.protected?.local?.databases?.includes(db)) err(`protected local databases must include ${db}`);
  const d = m.database_defaults ?? {};
  if (d.provider !== 'planetscale' || d.engine !== 'postgresql') err('database must be PlanetScale Postgres (not Vitess/MySQL)');
  if (d.major_version !== 18) err('database major version must be 18 to match the current PG18 source');
  if (!Array.isArray(d.extensions_required)) err('extensions_required must be an explicit list');

  const envs = Object.entries(m.environments ?? {});
  if (envs.map(([k]) => k).sort().join(',') !== 'next,staging-next') err('environments must be exactly staging-next and next');
  const seen = new Map();
  let baseTotal = 0;
  let resizedTotal = 0;
  for (const [key, env] of envs) {
    const prefix = ENV_PREFIX[key];
    const expectedHost = `${key}.freetwai.com`;
    if (env.hostname !== expectedHost) err(`${key}: hostname must be ${expectedHost}`);
    if (protectedHosts.has(env.hostname)) err(`${key}: hostname is protected`);
    if (env.worker?.workers_dev !== false) err(`${key}: workers_dev must be false`);
    if (env.worker?.preview_urls !== false) err(`${key}: preview_urls must be false (no public preview URL bypassing Access)`);
    if (env.access?.required !== true) err(`${key}: Access protection is required`);
    const fresh = (env.hyperdrive ?? []).filter((h) => !h.optional);
    if (!fresh.length || fresh.some((h) => h.caching_disabled !== true)) err(`${key}: every required Hyperdrive config must have caching disabled`);
    for (const h of env.hyperdrive ?? []) if (h.caching_disabled === false && !(h.max_age_seconds > 0 && h.max_age_seconds <= 60)) err(`${key}: cached Hyperdrive ${h.name} needs max_age_seconds 1..60`);
    if (key === 'next' && env.data_source === 'synthetic') err('next: candidate rehearsal data must come from a public backup restore');
    if (key === 'staging-next' && env.data_source !== 'synthetic') err('staging-next: must use synthetic data only (no live data, no local demo accounts)');
    if (key === 'next' && env.database?.topology !== 'ha') err('next: production candidate must be HA');
    baseTotal += Number(env.database?.catalog_monthly_usd ?? 0);
    resizedTotal += Number(env.database?.resize_gate?.catalog_monthly_usd ?? env.database?.catalog_monthly_usd ?? 0);
    if ((env.secret_names ?? []).includes('DATABASE_URL')) err(`${key}: runtime DB access must come from the Hyperdrive binding, not a DATABASE_URL secret`);
    for (const secret of env.secret_names ?? []) if ((env.var_names ?? []).includes(secret)) err(`${key}: ${secret} listed as both secret and plain var`);
    for (const v of env.var_names ?? []) if (/(URL|KEY|SECRET|TOKEN|PASSWORD)$/.test(v) && v !== 'APP_ORIGIN') err(`${key}: ${v} looks secret and must not be a plain var`);
    for (const [kind, names] of Object.entries(ownedResources(env))) {
      for (const name of names) {
        if (!name) { err(`${key}: empty ${kind} name`); continue; }
        if (kind === 'worker') { if (name !== `freedom-platform-${key}`) err(`${key}: worker must be named freedom-platform-${key}`); }
        else if (kind === 'db_role' ? !name.startsWith(ENV_ROLE_PREFIX[key]) : kind === 'hostname' || kind === 'access_application' ? false : !name.startsWith(prefix)) err(`${key}: ${kind} ${name} must use the ${kind === 'db_role' ? ENV_ROLE_PREFIX[key] : prefix} prefix`);
        if (kind === 'access_application' && (m.protected.access_applications ?? []).includes(name)) err(`${key}: Access application ${name} is protected`);
        const tag = `${kind}:${name}`;
        if (seen.has(tag)) err(`${kind} ${name} is shared between ${seen.get(tag)} and ${key}`);
        seen.set(tag, key);
      }
    }
  }
  const cap = d.monthly_budget_usd?.database_base_cap_without_new_approval;
  if (typeof cap !== 'number' || baseTotal > cap) err(`database base catalog total ${baseTotal} exceeds cap ${cap}`);
  if (typeof cap === 'number' && resizedTotal > cap) err(`database total after resize gates ${resizedTotal} exceeds cap ${cap}`);
  return { ok: errors.length === 0, errors, database_base_monthly_usd: baseTotal, database_monthly_usd_after_resize_gates: resizedTotal };
}

/**
 * Default-deny guard for any future mutating step. A target passes only when it is a name the
 * manifest assigns to that exact environment and resource kind, and is not protected.
 */
export function assertMutationTarget(m, envKey, kind, name) {
  const env = m.environments?.[envKey];
  if (!env) throw new Error(`Unknown environment: ${envKey}`);
  const p = m.protected;
  if (kind === 'hostname' && p.hostnames.includes(name)) throw new Error(`Refusing protected hostname ${name}`);
  if (kind === 'access_application' && p.access_applications.includes(name)) throw new Error(`Refusing protected Access application ${name}`);
  if (kind === 'database' && p.local.databases.includes(name)) throw new Error(`Refusing protected local database ${name}`);
  if (kind === 'tunnel') throw new Error('Tunnels are never mutated by the migration tooling');
  const owned = ownedResources(env)[kind];
  if (!owned) throw new Error(`Unknown resource kind: ${kind}`);
  if (!owned.includes(name)) throw new Error(`${kind} ${name} is not owned by ${envKey}; refusing`);
  return true;
}
