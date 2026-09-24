import { planetscaleCost } from './cost.mjs';
import { assertMutationTarget } from './manifest.mjs';

// Placeholders are literal strings; the plan never contains IDs, hosts, passwords, tokens or signatures.
const HD_API = 'https://api.cloudflare.com/client/v4/accounts/<account>/hyperdrive/configs';
// libpq service names resolve through PGSERVICEFILE/PGPASSFILE in the chmod 600 private directory,
// so no host, user or password is on a command line.
const svc = (prefix, role) => `service=${prefix}_${role}`;

/**
 * Ordered, reviewable steps for one environment on Cloudflare-billed PlanetScale Postgres. Every
 * mutating step names its target and passes the default-deny guard, so a typo or protected name
 * fails while the plan is rendered. Nothing here executes: no billing signature is produced, no
 * pscale login or database creation is invoked.
 */
export function buildProvisionPlan(manifest, envKey) {
  const env = manifest.environments[envKey];
  if (!env) throw new Error(`Unknown environment: ${envKey}`);
  const ps = manifest.providers.planetscale;
  const rt = manifest.runtime;
  const cost = planetscaleCost(manifest);
  const prefix = env.database.dbname;
  const db = env.database;
  const hd = env.hyperdrive;
  const region = ps.region_preference[0].pscale_slug;
  const steps = [
    { id: 'prerequisites', mutation: false, actor: 'root/operator', action: `Outside this tool: pscale CLI >= ${ps.pscale_cli_min_version} authenticated to the target PlanetScale organization (observed ${ps.pscale_auth_observed.status}; root's single pending device login is not restarted here), commands with --format json; org-level ${db.size} ${db.topology} availability in ${region} and its regional/org price read with \`pscale size cluster list --org <org> --format json\` (not_run). Workers Paid is already authorized (US$${manifest.cloudflare.workers_paid_usd_month}/month).` },
    { id: 'cost-context', mutation: false, actor: 'reviewer', action: `${envKey}: ${cost.environments[envKey].sku} (${cost.environments[envKey].nodes} node${cost.environments[envKey].nodes > 1 ? 's' : ''}) ${cost.environments[envKey].usd_month === null ? 'price unknown (catalog_required: read the regional/org quote before creation)' : `US$${cost.environments[envKey].usd_month}/month`}, billed through Cloudflare at the same price; total with Workers Paid US$${cost.cloudflare_workers_paid}: ${cost.total === null ? 'pending quote' : `US$${cost.total}/month`}. Context only, not a gate.` },
    { id: 'access-app', mutation: true, target: ['access_application', env.access.application_name], actor: 'operator (management token/dashboard)', action: `Access application "${env.access.application_name}" for ${env.hostname} (all paths), named people only; no Bypass/Everyone. Before any Worker route exists.` },
    { id: 'access-admin-app', mutation: true, target: ['access_application', env.access.admin_application_name], actor: 'operator (management token/dashboard)', action: `Access application "${env.access.admin_application_name}" for ${env.hostname}/admin; record its AUD for FREEDOM_ADMIN_ACCESS_AUD.` },
    { id: 'ps-database', mutation: true, target: ['database', db.name], actor: 'operator (dashboard, or authenticated pscale)', alternatives: {
      dashboard: `Cloudflare dashboard → Hyperdrive/PlanetScale: create ${db.name}, PostgreSQL ${manifest.database_defaults.major_version}, ${db.size} ${db.topology}, region ${region}, billed to the Cloudflare account.`,
      cli: `wrangler hyperdrive planetscale signature | pscale database create ${db.name} --org <authenticated org> --engine postgresql --region ${region} --cloudflare-billing @-`,
    }, action: `The signature is a credential-like billing authorization: pipe it straight into pscale, never print, store or paste it. It does not create anything by itself, and a Cloudflare API token alone cannot create the database. Choose ${db.size} ${db.topology}${db.topology === 'ha' ? ' (1 primary + 2 replicas)' : ''} only after its regional/org price is recorded; confirm size flags with \`pscale database create --help\` at execution time.` },
    { id: 'roles', mutation: true, target: ['db_role', db.roles.migrator], actor: 'operator', command: `psql "${svc(prefix, 'admin')}" -v ON_ERROR_STOP=1 -v env_prefix=${prefix} -f deploy/cloudflare/sql/10-create-roles.psql`, action: `As the PlanetScale default role: CREATE DATABASE ${prefix}, then least-privilege ${db.roles.migrator} and ${db.roles.runtime}. Credentials stay in the private dir.` },
    env.data_source === 'synthetic'
      ? { id: 'schema', mutation: true, target: ['database', db.name], actor: 'operator', action: 'Apply migrations 001–037 as the migrator with the repository runner, then a synthetic community only. Never seedLocal (no @local.test), never staging/public data.' }
      : { id: 'restore-rehearsal', mutation: true, target: ['database', db.name], actor: 'operator', command: `pg_restore --no-owner --no-privileges --exit-on-error --single-transaction -d "${svc(prefix, 'migrator')}" <verified full public backup in private dir>`, action: 'Take and checksum-verify a fresh full freedom_public backup first (old site keeps running); restore into the EMPTY candidate DB; migration runner must be a no-op; revoke restored sessions; read-only verification SQL.' },
    { id: 'grants', mutation: true, target: ['db_role', db.roles.runtime], actor: 'operator', command: `psql "${svc(prefix, 'migrator')}" -v ON_ERROR_STOP=1 -v env_prefix=${prefix} -f deploy/cloudflare/sql/20-runtime-grants.psql`, action: 'DML-only runtime role; ledger read-only.' },
    { id: 'hyperdrive', mutation: true, target: ['hyperdrive', hd.name], actor: 'operator (deploy token)', command: `curl -X POST ${HD_API} -H @<auth header fd> --data-binary @<chmod 600 body: name=${hd.name}, origin=PlanetScale ${db.name} over TLS, user=${db.roles.runtime}, caching.disabled=true>`, action: `The only DB config for binding ${hd.binding}; caching disabled for every platform query.` },
    { id: 'hyperdrive-verify', mutation: false, actor: 'operator', command: `node deploy/cloudflare/preflight.mjs wrangler --config <runtime wrangler.jsonc with real id> --env-file <chmod 600>`, action: 'Hard gate: provider GET must return caching.disabled === true. A comment, variable or HTTP no-store header is not proof.' },
    ...env.r2_buckets.map((b) => ({ id: `r2-${b.name}`, mutation: true, optional: b.optional, target: ['r2_bucket', b.name], actor: 'operator (deploy token)', command: `wrangler r2 bucket create ${b.name}`, action: 'Private bucket; no r2.dev, no custom domain. Only when the Worker binds it.' })),
    { id: 'secrets', mutation: true, target: ['worker', env.worker.name], actor: 'operator (deploy token)', command: `wrangler secret put <NAME> --name ${env.worker.name} < <private file>`, action: `Secrets ${env.secret_names.join(', ')} from stdin. ${env.data_source === 'synthetic' ? 'Fresh random values.' : 'Rehearsal uses a NEW GITHUB_SOCIAL_TOKEN_KEY so restored GitHub credentials cannot be used (no stars/messages); the live key moves only at cutover.'}` },
    { id: 'deploy', mutation: true, target: ['worker', env.worker.name], actor: 'operator (deploy token)', command: `wrangler deploy --env ${envKey} --var ${rt.release_var}:<git rev-parse HEAD>`, action: `Only after 'preflight wrangler' is structurally valid AND deployment_ready (real Hyperdrive id, caching.disabled read back, custom domain ${env.hostname} only, ${rt.images_binding} enabled).` },
    { id: 'verify', mutation: false, actor: 'operator', action: 'Anonymous request must be redirected by Access; then, with a short-lived Access service token, check health, release SHA, login, session isolation, read-after-write permission change, Cache-Control no-store on /api/*, restore counters, p50/p95 latency from Taiwan.' },
    { id: 'rollback', mutation: false, actor: 'operator', action: 'Old freetwai.com / staging.freetwai.com, their Tunnel, Castle DBs and the existing OCI VMs are never changed, so rollback is removing the candidate route/Access apps; the candidate DB is deleted only after the reviewed rehearsal record.' },
  ];
  for (const s of steps) if (s.mutation) assertMutationTarget(manifest, envKey, s.target[0], s.target[1]);
  return { environment: envKey, hostname: env.hostname, provider: manifest.providers.selected, dry_run: true, execution: 'not available in this phase', steps };
}
