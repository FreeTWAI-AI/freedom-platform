import { planetscaleCost } from './cost.mjs';
import { assertMutationTarget } from './manifest.mjs';

// Historical pre-cutover candidate plan kept libpq service names and a branch-suffixed
// TLS username out of argv, and piped the billing signature straight into pscale.
// The live plans below do not create databases or print those commands.

/**
 * Ordered, reviewable steps for one environment on Cloudflare-billed PlanetScale Postgres.
 * Nothing here executes: no billing signature is produced, no pscale login or database creation
 * is invoked.
 *
 * env next is production and env staging-next is staging (cutover_complete, 2026-09-25).
 * Each plan describes the live topology, the release command and R3 rollback. Neither
 * repeats the pre-cutover rehearsal. Historical: staging-next's plan created Access
 * apps, a database and a custom domain, and said which staging is canonical was open.
 * Those steps contradict the live topology.
 */
export function buildProvisionPlan(manifest, envKey) {
  const env = manifest.environments[envKey];
  if (!env) throw new Error(`Unknown environment: ${envKey}`);
  if (env.role === 'production') return buildProductionPlan(manifest, envKey, env);
  if (env.role === 'staging') return buildStagingPlan(manifest, envKey, env);
  throw new Error(`No live plan for role ${env.role}`);
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
    { id: 'staging', mutation: false, actor: 'reviewer', action: 'Staging is Worker freedom-platform-staging-next on zone route staging.freetwai.com/* (APP_ORIGIN https://staging.freetwai.com, FREEDOM_ENV staging). Castle staging is retired; Castle is dev only. staging-next.freetwai.com was removed. This production plan does not edit the staging route.' },
    { id: 'cost-context', mutation: false, actor: 'reviewer', action: `${envKey}: ${sku.sku} (${sku.nodes} nodes) US$${sku.usd_month}/month, billed through Cloudflare. Monthly base with Workers Paid: US$${cost.total}/month (base rates only, not total usage; storage/usage/tax excluded). Context only.` },
  ];
  return { environment: envKey, hostname: env.hostname, role: 'production', provider: manifest.providers.selected, dry_run: true, execution: 'not available in this phase', steps };
}

function buildStagingPlan(manifest, envKey, env) {
  const cost = planetscaleCost(manifest);
  const db = env.database;
  const hd = env.hyperdrive;
  const sku = cost.environments[envKey];
  const steps = [
    { id: 'topology', mutation: false, actor: 'reviewer', action: `Cutover complete 2026-09-25. ${envKey} is staging: Worker ${env.worker.name}, zone route ${env.route.pattern} (zone_name ${env.route.zone_name}) only, APP_ORIGIN https://${env.hostname}, FREEDOM_ENV ${env.freedom_env}, workers_dev false, preview_urls false. DNS is a proxied AAAA 100:: placeholder, not a tunnel CNAME. ${env.retired_hostnames.join(', ')} was removed, including its Worker hostname binding and its two Access applications. This tool does not execute.` },
    { id: 'data', mutation: false, actor: 'reviewer', action: `Hyperdrive ${hd.name} binding ${hd.binding}, caching disabled, origin_connection_limit 15. PlanetScale ${db.name} database ${db.dbname}, ${db.size} ${db.topology}, PG18, Tokyo. Data source ${env.data_source}: the final Castle freedom_staging dump (81 tables; staging demo accounts and demo community, never live member data) replaced the earlier synthetic rehearsal data. The staging registration community var points at that demo community. Secrets: FREEDOM_ADMIN_CSRF_SECRET is fresh; GITHUB_SOCIAL_TOKEN_KEY is the former Castle staging key so stored GitHub tokens still decrypt. Both are write-only; releases never re-upload them.` },
    { id: 'access', mutation: false, actor: 'reviewer', action: `Access stays the pre-existing applications "${env.access.application_name}" (whole host ${env.hostname}, named people only) and "${env.access.admin_application_name}" (${env.hostname}/admin). They are referenced protected applications, not created, edited or deleted by this plan. Castle's admin-access sync timer keeps the administrator list in sync; its staging scope reads PlanetScale through a 0600 override env file.` },
    { id: 'release', mutation: false, actor: 'operator', action: 'Release through the private helper release-deploy.mjs (plan, then deploy, then health and route verification; it never re-uploads secrets), then npx tsx scripts/verify-cloud-candidate.ts execute --target staging. --target staging-next and --target next no longer resolve.' },
    { id: 'rollback', mutation: false, actor: 'operator', action: `Rollback after real writes is R3 only, the same rule as production freetwai.com: dump ${db.dbname} and restore into a NEW local database. Never point the Worker or DNS back at a frozen old database (local freedom_staging was dropped after the verified dump). Do not remove the staging route as a rollback, and do not edit the production route.` },
    { id: 'castle', mutation: false, actor: 'reviewer', action: 'Castle is dev only. It keeps the shared Compose Postgres with freedom_local, the admin-access sync timer (both scopes read PlanetScale), and the daily off-provider pg_dump of freedom_next and freedom_staging_next. Retired: freedom-staging.service, freedom-staging-tunnel.service, freedom-staging-backup.service and its timer, tunnel freedom-staging, and local database freedom_staging. Ports 4310 and 4312 are free for npm run demo.' },
    { id: 'cost-context', mutation: false, actor: 'reviewer', action: `${envKey}: ${sku.sku} (${sku.nodes} node) US$${sku.usd_month}/month, billed through Cloudflare. Monthly base with Workers Paid: US$${cost.total}/month (base rates only, not total usage; storage/usage/tax excluded). Context only.` },
  ];
  for (const s of steps) if (s.mutation) assertMutationTarget(manifest, envKey, s.target[0], s.target[1]);
  return { environment: envKey, hostname: env.hostname, role: 'staging', provider: manifest.providers.selected, dry_run: true, execution: 'not available in this phase', steps };
}
