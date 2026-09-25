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
    // Production has no site-wide Access application. A referenced pre-existing
    // application is protected and is not owned or created by this plan.
    access_application: env.access?.required === true && env.access?.referenced_preexisting !== true
      ? [env.access.application_name, env.access.admin_application_name]
      : [],
  };
}

export function validateManifest(m) {
  const errors = [];
  const err = (msg) => errors.push(msg);
  if (m.schema !== 'freedom.cloudflare-migration-plan/v3') err('unexpected schema');
  if (m.phase !== 'cutover_complete') err('phase must be cutover_complete');
  if (m.zone !== 'freetwai.com') err('zone must be freetwai.com');
  // After the 2026-09-25 staging cutover the protected hostname list is empty.
  // No Castle tunnel hostname remains. The allowlist is the two environment
  // hostnames. Historical lists were [freetwai.com, staging.freetwai.com]
  // before the production cutover and [staging.freetwai.com] until staging cut over.
  const protectedList = m.protected?.hostnames ?? [];
  const protectedHosts = new Set(protectedList);
  if (!Array.isArray(protectedList) || protectedList.length !== 0) err('protected hostnames must be empty after the 2026-09-25 staging cutover');
  if (protectedHosts.has('freetwai.com') || protectedHosts.has('staging.freetwai.com')) err('environment hostnames must not be listed as protected tunnel hostnames');
  const liveDbs = m.protected?.local?.databases ?? [];
  if (liveDbs.length !== 1 || liveDbs[0] !== 'freedom_local') err('protected local databases must be exactly ["freedom_local"]');
  // Historical: freedom_staging and freedom_public were live protected databases.
  // Both were dropped on 2026-09-25 and must stay in the retired record only.
  const retiredLocal = m.protected?.local?.historical_retired_2026_09_25 ?? {};
  for (const db of ['freedom_staging', 'freedom_public']) {
    if (liveDbs.includes(db)) err(`dropped database ${db} must not be a live protected database`);
    if (!(retiredLocal.databases ?? []).includes(db)) err(`historical_retired_2026_09_25.databases must include ${db}`);
  }
  const liveUnits = m.protected?.local?.systemd_user_units ?? [];
  if (liveUnits.length) err('live systemd units must be empty; Castle staging and public units are retired');
  for (const unit of ['freedom-public.service', 'freedom-public-backup.service', 'freedom-public-backup.timer', 'freedom-staging.service', 'freedom-staging-backup.service', 'freedom-staging-backup.timer', 'freedom-staging-tunnel.service']) {
    if (liveUnits.includes(unit)) err(`${unit} is retired and must not be a live unit`);
    if (!(retiredLocal.systemd_user_units ?? []).includes(unit)) err(`historical record must keep ${unit}`);
  }
  const livePorts = m.protected?.local?.ports ?? [];
  if (!livePorts.includes(54339)) err('shared Compose Postgres port 54339 stays protected');
  for (const port of [4310, 4312]) {
    if (livePorts.includes(port)) err(`port ${port} is free for npm run demo and must not be a live protected port`);
    if (!(retiredLocal.ports ?? []).includes(port)) err(`historical record must keep port ${port}`);
  }
  const livePaths = m.protected?.local?.paths ?? [];
  if (livePaths.length) err('live protected paths must be empty; Castle staging paths are retired');
  for (const path of ['~/.local/share/freedom-staging', '~/.config/freedom-staging', '~/.local/state/freedom-staging', '~/.local/share/freedom-public', '~/.config/freedom-public', '~/.local/state/freedom-public']) {
    if (!(retiredLocal.paths ?? []).includes(path)) err(`historical paths must include ${path}`);
  }
  const d = m.database_defaults ?? {};
  if (d.engine !== 'postgresql' || d.major_version !== 18) err('database must be PostgreSQL 18 to match the current PG18 source');
  if (!Array.isArray(d.extensions_required)) err('extensions_required must be an explicit list');
  if (!Array.isArray(d.extensions_allowlist) || d.extensions_allowlist.length !== 2 || d.extensions_allowlist[0] !== 'plpgsql' || d.extensions_allowlist[1] !== 'hypopg') err('extensions_allowlist must be exactly ["plpgsql", "hypopg"] (PlanetScale installs hypopg; allowlist it, do not CREATE EXTENSION)');
  if (m.providers?.selected !== 'planetscale_cloudflare_billed') err('selected provider must be planetscale_cloudflare_billed');
  const ps = m.providers?.planetscale ?? {};
  if (ps.billing !== 'cloudflare') err('PlanetScale must be billed through Cloudflare');
  if (!ps.catalog?.source || !['catalog_required', 'org_quote_recorded'].includes(ps.catalog?.status)) err('PlanetScale catalog needs a source and a status (catalog_required until an org quote is recorded)');
  if (ps.catalog?.status === 'org_quote_recorded') {
    const q = ps.catalog.org_quote;
    if (!q?.retrieved || !q?.org || !q?.region || !q?.selected) err('org_quote_recorded needs org_quote retrieved/org/region/selected provenance');
    else for (const [sku, v] of Object.entries(q.selected)) if (ps.catalog.monthly_usd?.[sku] !== null && ps.catalog.monthly_usd?.[sku] !== v.rate_usd_month) err(`${sku}: monthly_usd must match the recorded org quote`);
  }
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
    // Both environments are live zone routes as of the 2026-09-25 staging cutover.
    // Historical: staging-next had no route in this file; its custom domain was
    // attached outside the config, and its hostname was staging-next.freetwai.com.
    if (key === 'next') {
      if (env.role !== 'production') err('next: role must be production');
      if (env.hostname !== 'freetwai.com') err('next: hostname must be freetwai.com (production apex since 2026-09-25; next.freetwai.com was removed)');
      if (!env.route || env.route.pattern !== 'freetwai.com/*' || env.route.zone_name !== 'freetwai.com' || env.route.custom_domain) err('next: route must be the zone route freetwai.com/*');
      const retired = env.retired_hostnames ?? [];
      if (retired.length !== 1 || retired[0] !== 'next.freetwai.com') err('next: retired_hostnames must be exactly ["next.freetwai.com"]');
    } else if (key === 'staging-next') {
      if (env.role !== 'staging') err('staging-next: role must be staging');
      if (env.hostname !== 'staging.freetwai.com') err('staging-next: hostname must be staging.freetwai.com');
      if (!env.route || env.route.pattern !== 'staging.freetwai.com/*' || env.route.zone_name !== 'freetwai.com' || env.route.custom_domain) err('staging-next: route must be the zone route staging.freetwai.com/*');
      const retired = env.retired_hostnames ?? [];
      if (retired.length !== 1 || retired[0] !== 'staging-next.freetwai.com') err('staging-next: retired_hostnames must be exactly ["staging-next.freetwai.com"]');
      if (env.access?.required !== true || env.access?.referenced_preexisting !== true) err('staging-next: Access is required and must reference pre-existing protected applications');
      if (env.access?.application_name !== 'Freedom staging' || env.access?.admin_application_name !== 'Freedom staging administrators') err('staging-next: must reference Freedom staging and Freedom staging administrators');
      const retiredApps = env.access?.retired_application_names ?? [];
      if (retiredApps.length !== 2 || retiredApps[0] !== 'Freedom staging-next' || retiredApps[1] !== 'Freedom staging-next administrators') err('staging-next: retired Access application names must be Freedom staging-next and Freedom staging-next administrators');
    }
    if (protectedHosts.has(env.hostname)) err(`${key}: hostname ${env.hostname} is protected`);
    for (const host of env.retired_hostnames ?? []) if (host === env.hostname) err(`${key}: retired hostname must not be the live hostname`);
    if (env.worker?.workers_dev !== false) err(`${key}: workers_dev must be false`);
    if (env.worker?.preview_urls !== false) err(`${key}: preview_urls must be false (no public preview URL bypassing Access)`);
    const declaredAccess = [env.access?.application_name, env.access?.admin_application_name].filter((name) => name != null && name !== '');
    if (env.access?.referenced_preexisting === true) {
      for (const name of declaredAccess) {
        if (!(m.protected.access_applications ?? []).includes(name)) err(`${key}: referenced Access application ${name} must stay on the protected list`);
      }
    } else {
      for (const name of declaredAccess) {
        if ((m.protected.access_applications ?? []).includes(name)) err(`${key}: Access application ${name} is protected`);
      }
    }
    if (key === 'next') {
      if (env.access?.required !== false) err('next: site-wide Access must not be required after cutover');
      if (declaredAccess.length) err('next: production must not declare an Access application; the candidate apps were removed on 2026-09-25');
    } else if (env.access?.required !== true) err(`${key}: Access protection is required`);
    const hd = env.hyperdrive;
    if (!hd || Array.isArray(hd)) err(`${key}: exactly one Hyperdrive config (object, not a list)`);
    else {
      if (hd.binding !== 'HYPERDRIVE') err(`${key}: Hyperdrive binding must be HYPERDRIVE`);
      if (hd.caching_disabled !== true) err(`${key}: Hyperdrive must have caching disabled for all platform queries`);
    }
    if (key === 'next' && env.data_source !== 'production') err('next: data_source must be production after cutover');
    // Staging never receives live member data. castle-staging-restore is the
    // Castle freedom_staging demo dump. Historical value was "synthetic".
    if (key === 'staging-next' && (env.data_source === 'production' || env.data_source === 'live' || env.data_source === 'rehearsal-restore-of-public-backup')) err('staging-next: never receives live member data');
    if (key === 'staging-next' && env.data_source !== 'castle-staging-restore') err('staging-next: data_source must be castle-staging-restore (Castle staging demo data, never live member data)');
    if (key === 'staging-next' && env.database?.topology !== 'single_node') err('staging-next: database stays a single_node PS-5');
    if (key === 'next' && env.database?.topology !== 'ha') err('next: production database must be HA');
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
  const retiredHosts = new Set(Object.values(m.environments).flatMap((env) => env.retired_hostnames ?? []));
  if (kind === 'hostname' && retiredHosts.has(name)) throw new Error(`Refusing retired hostname ${name}`);
  if (kind === 'access_application' && p.access_applications.includes(name)) throw new Error(`Refusing protected Access application ${name}`);
  if (kind === 'database' && p.local.databases.includes(name)) throw new Error(`Refusing protected local database ${name}`);
  if (kind === 'oci_instance') throw new Error('Existing OCI compute instances are never used or changed');
  if (kind.startsWith('oci_')) throw new Error('OCI is a surveyed alternative; this plan provisions no OCI resource');
  const owned = ownedResources(env)[kind];
  if (!owned) throw new Error(`Unknown resource kind: ${kind}`);
  if (!owned.includes(name)) throw new Error(`${kind} ${name} is not owned by ${envKey}; refusing`);
  return true;
}
