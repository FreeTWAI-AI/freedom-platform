import { planetscaleCost } from './cost.mjs';
import { assertMutationTarget } from './manifest.mjs';

// Placeholders are literal strings; the plan never contains IDs, hosts, passwords, tokens or signatures.
const HD_API = 'https://api.cloudflare.com/client/v4/accounts/<account>/hyperdrive/configs';
// libpq service names resolve through PGSERVICEFILE/PGPASSFILE in the chmod 600 private directory,
// so no host, user or password is on a command line. PlanetScale TLS usernames carry the branch
// routing suffix: the migrator service entry uses user=<migrator>.<branch-id>, the admin entry the
// provider-supplied default-role username as given. SQL role names (CREATE ROLE/GRANT) never do.
const BRANCH_ID = '<branch-id>';
const svc = (prefix, role) => `service=${prefix}_${role}`;

/**
 * Ordered, reviewable steps for one environment on Cloudflare-billed PlanetScale Postgres.
 * Nothing here executes: no billing signature is produced, no pscale login or database creation
 * is invoked.
 *
 * env next is production (cutover_complete, 2026-09-25). Its plan describes the live topology,
 * the release command and R3 rollback. It does not repeat the pre-cutover rehearsal (new GitHub
 * key, restore into a candidate, Access on next.freetwai.com, rollback by deleting the route).
 * env staging-next is still the Cloudflare staging shape. Every mutating step names its target
 * and passes the default-deny guard.
 */
export function buildProvisionPlan(manifest, envKey) {
  const env = manifest.environments[envKey];
  if (!env) throw new Error(`Unknown environment: ${envKey}`);
  if (env.role === 'production') return buildProductionPlan(manifest, envKey, env);
  return buildCandidatePlan(manifest, envKey, env);
}

function buildProductionPlan(manifest, envKey, env) {
  const cost = planetscaleCost(manifest);
  const db = env.database;
  const hd = env.hyperdrive;
  const sku = cost.environments[envKey];
  const steps = [
    { id: 'topology', mutation: false, actor: 'reviewer', action: `Cutover complete 2026-09-25. ${envKey} is production: Worker ${env.worker.name}, zone route ${env.route.pattern} (zone_name ${env.route.zone_name}) only, APP_ORIGIN https://${env.hostname}, FREEDOM_ENV ${env.freedom_env}, workers_dev false, preview_urls false, Smart Placement off. Apex DNS is a proxied AAAA 100:: placeholder, not a tunnel CNAME. ${env.retired_hostnames.join(', ')} and its two Access applications were removed. This tool does not execute.` },
    { id: 'data', mutation: false, actor: 'reviewer', action: `Hyperdrive ${hd.name} binding ${hd.binding}, caching disabled, origin_connection_limit 15. PlanetScale ${db.name} database ${db.dbname}, ${db.size} ${db.topology}, PG18, Tokyo, max_connections 25. Secrets ${env.secret_names.join(' and ')} are set write-only; releases never re-upload them. Extension allowlist: plpgsql and hypopg (schema pscale_extensions, owner pscale_admin, installed by PlanetScale).` },
    { id: 'release', mutation: false, actor: 'operator', action: 'Release through the private helper release-deploy.mjs (plan, then deploy, then health and route verification; it never re-uploads secrets), then npx tsx scripts/verify-cloud-candidate.ts execute --target public. Since 2026-09-25 --target next no longer resolves.' },
    { id: 'rollback', mutation: false, actor: 'operator', action: `Rollback after real writes is R3 only: dump ${db.dbname} and restore into a NEW local database. Never point the Worker or DNS back at the frozen freedom_public database. Do not remove the production route as a rollback.` },
    { id: 'staging', mutation: false, actor: 'reviewer', action: 'Castle staging.freetwai.com (protected tunnel) and Cloudflare staging-next.freetwai.com both still exist and are unchanged. Which one remains the staging environment is an open decision; this plan does not choose.' },
    { id: 'cost-context', mutation: false, actor: 'reviewer', action: `${envKey}: ${sku.sku} (${sku.nodes} nodes) US$${sku.usd_month}/month, billed through Cloudflare. Monthly base with Workers Paid: US$${cost.total}/month (base rates only, not total usage; storage/usage/tax excluded). Context only.` },
  ];
  return { environment: envKey, hostname: env.hostname, role: 'production', provider: manifest.providers.selected, dry_run: true, execution: 'not available in this phase', steps };
}

function buildCandidatePlan(manifest, envKey, env) {
  const ps = manifest.providers.planetscale;
  const rt = manifest.runtime;
  const cost = planetscaleCost(manifest);
  const prefix = env.database.dbname;
  const db = env.database;
  const hd = env.hyperdrive;
  const region = ps.catalog.org_quote?.region ?? ps.region_preference[0].pscale_slug;
  const auth = ps.pscale_auth_observed;
  const org = auth.status === 'authenticated' && auth.org ? auth.org : '<authenticated org>';
  const pscaleEnvPrefix = Object.entries(auth.process_env ?? {}).map(([k, v]) => `${k}=${v}`).join(' ');
  const steps = [
    { id: 'prerequisites', mutation: false, actor: 'root/operator', action: `Outside this tool: pscale CLI >= ${ps.pscale_cli_min_version} (observed ${ps.pscale_cli_observed.version}) authenticated to the target PlanetScale organization; current: ${auth.status}${auth.method ? ` (${auth.method})` : ''}${auth.org ? `, org ${auth.org}` : ''}. Every pscale command runs with the process-scoped ${pscaleEnvPrefix} (no global change, no new login) and --format json. Org size availability: ${cost.org_size_availability}. Workers Paid is already authorized (US$${manifest.cloudflare.workers_paid_usd_month}/month).` },
    { id: 'cost-context', mutation: false, actor: 'reviewer', action: `${envKey}: ${cost.environments[envKey].sku} (${cost.environments[envKey].nodes} node${cost.environments[envKey].nodes > 1 ? 's' : ''}) ${cost.environments[envKey].usd_month === null ? 'price unknown (re-read the regional/org quote before creation)' : `US$${cost.environments[envKey].usd_month}/month`}, billed through Cloudflare at the same price; monthly base with Workers Paid US$${cost.cloudflare_workers_paid}: ${cost.total === null ? 'pending quote' : `US$${cost.total}/month (base rates only, not total usage; storage/usage/tax excluded)`}. Context only, not a gate.` },
    { id: 'access-app', mutation: true, target: ['access_application', env.access.application_name], actor: 'operator (management token/dashboard)', action: `Access application "${env.access.application_name}" for ${env.hostname} (all paths), named people only; no Bypass/Everyone. Cloudflare staging already exists; this records the required order (Access before its own route). It does not change production freetwai.com or the retired next.freetwai.com name.` },
    { id: 'access-admin-app', mutation: true, target: ['access_application', env.access.admin_application_name], actor: 'operator (management token/dashboard)', action: `Access application "${env.access.admin_application_name}" for ${env.hostname}/admin; record its AUD for FREEDOM_ADMIN_ACCESS_AUD.` },
    { id: 'ps-database', mutation: true, target: ['database', db.name], actor: 'operator (dashboard, or authenticated pscale)', alternatives: {
      dashboard: `Cloudflare dashboard → Hyperdrive/PlanetScale: create ${db.name}, PostgreSQL ${manifest.database_defaults.major_version}, ${db.size} ${db.topology}, region ${region}, billed to the Cloudflare account.`,
      cli: `wrangler hyperdrive planetscale signature | ${pscaleEnvPrefix ? `${pscaleEnvPrefix} ` : ''}pscale database create ${db.name} --org ${org} --engine postgresql --region ${region} --cloudflare-billing @- --format json`,
    }, action: `The signature is a credential-like billing authorization: pipe it straight into pscale, never print, store or paste it. It does not create anything by itself, and a Cloudflare API token alone cannot create the database. Only for a future explicit execution; this tool has no execute capability. Choose ${db.size} ${db.topology}${db.topology === 'ha' ? ' (1 primary + 2 replicas)' : ''} only with its regional/org price recorded in the manifest; confirm size flags with \`pscale database create --help\` at execution time.` },
    { id: 'roles', mutation: true, target: ['db_role', db.roles.migrator], actor: 'operator', command: `psql "${svc(prefix, 'admin')}" -v ON_ERROR_STOP=1 -v env_prefix=${prefix} -f deploy/cloudflare/sql/10-create-roles.psql`, action: `As the PlanetScale default role: CREATE DATABASE ${prefix}, then least-privilege ${db.roles.migrator} and ${db.roles.runtime}. Credentials stay in the private dir.` },
    env.data_source === 'synthetic'
      ? { id: 'schema', mutation: true, target: ['database', db.name], actor: 'operator', action: 'Apply migrations 001–037 as the migrator with the repository runner, then a synthetic community only. Never seedLocal (no @local.test), never staging/public data.' }
      : { id: 'restore-rehearsal', mutation: true, target: ['database', db.name], actor: 'operator', command: `pg_restore --no-owner --no-privileges --exit-on-error --single-transaction -d "${svc(prefix, 'migrator')}" <verified full public backup in private dir>`, action: 'Take and checksum-verify a fresh full freedom_public backup first (old site keeps running); restore into the EMPTY candidate DB; migration runner must be a no-op; revoke restored sessions; read-only verification SQL.' },
    { id: 'grants', mutation: true, target: ['db_role', db.roles.runtime], actor: 'operator', command: `psql "${svc(prefix, 'migrator')}" -v ON_ERROR_STOP=1 -v env_prefix=${prefix} -f deploy/cloudflare/sql/20-runtime-grants.psql`, action: 'DML-only runtime role; ledger read-only.' },
    { id: 'hyperdrive', mutation: true, target: ['hyperdrive', hd.name], actor: 'operator (deploy token)', command: `curl -X POST ${HD_API} -H @<auth header fd> --data-binary @<chmod 600 body: name=${hd.name}, origin=PlanetScale ${db.name} over TLS, user=${db.roles.runtime}.${BRANCH_ID} (actual provider branch ID from connect metadata, not literal main or guessed; SQL role stays ${db.roles.runtime}), caching.disabled=true>`, action: `The only DB config for binding ${hd.binding}; caching disabled for every platform query.` },
    { id: 'hyperdrive-verify', mutation: false, actor: 'operator', command: `node deploy/cloudflare/preflight.mjs wrangler --config <runtime wrangler.jsonc with real id> --env-file <chmod 600>`, action: 'Hard gate: provider GET must return caching.disabled === true. A comment, variable or HTTP no-store header is not proof.' },
    ...env.r2_buckets.map((b) => ({ id: `r2-${b.name}`, mutation: true, optional: b.optional, target: ['r2_bucket', b.name], actor: 'operator (deploy token)', command: `wrangler r2 bucket create ${b.name}`, action: 'Private bucket; no r2.dev, no custom domain. Only when the Worker binds it.' })),
    { id: 'secrets', mutation: true, target: ['worker', env.worker.name], actor: 'operator (deploy token)', command: `wrangler secret put <NAME> --name ${env.worker.name} < <private file>`, action: `Secrets ${env.secret_names.join(', ')} from stdin. ${env.data_source === 'synthetic' ? 'Fresh random values.' : 'Rehearsal uses a NEW GITHUB_SOCIAL_TOKEN_KEY so copied encrypted GitHub credentials cannot be decrypted or used; it does not disable member messaging or GitHub accounts connected later. The live key moves only at cutover.'}` },
    { id: 'deploy', mutation: true, target: ['worker', env.worker.name], actor: 'operator (deploy token)', command: `wrangler deploy --env ${envKey} --var ${rt.release_var}:<git rev-parse HEAD>`, action: `Only after 'preflight wrangler' reports structural valid AND static_checks_pass true (real Hyperdrive id, caching.disabled read back, custom domain ${env.hostname} only, ${rt.images_binding} enabled), PLUS separate explicit evidence for every required injection: provider/runtime secret names read back with \`wrangler secret list --env ${envKey}\` and the release SHA injected by this command. The standalone checker keeps deployment_ready false while injections are unproven; it is not the deploy gate.` },
    { id: 'verify', mutation: false, actor: 'operator', action: 'Anonymous request must be redirected by Access; then, with a short-lived Access service token, check health, release SHA, login, session isolation, read-after-write permission change, Cache-Control no-store on /api/*, restore counters, p50/p95 latency from Taiwan.' },
    { id: 'rollback', mutation: false, actor: 'operator', action: 'Production freetwai.com (Worker zone route, proxied AAAA 100:: placeholder) and protected Castle staging.freetwai.com stay outside this environment. Rollback of staging-next is removing its own route and Access apps only; its database is deleted only after the reviewed record. Do not edit the production route or the Castle tunnel. Which staging remains canonical is an open decision; this plan does not choose. Historical pre-cutover rollback was "remove the candidate and leave the old apex untouched"; the apex is production now.' },
  ];
  for (const s of steps) if (s.mutation) assertMutationTarget(manifest, envKey, s.target[0], s.target[1]);
  return { environment: envKey, hostname: env.hostname, provider: manifest.providers.selected, dry_run: true, execution: 'not available in this phase', steps };
}
