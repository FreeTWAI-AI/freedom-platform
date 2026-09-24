import { assertMutationTarget } from './manifest.mjs';

// Placeholders are literal strings; the plan never contains IDs, hosts, passwords or tokens.
const HD_API = 'https://api.cloudflare.com/client/v4/accounts/<account>/hyperdrive/configs';
// libpq service names resolve through PGSERVICEFILE/PGPASSFILE in the chmod 600 private directory,
// so no host, user or password is ever part of a command line.
const svc = (prefix, role) => `service=${prefix}_${role}`;

/**
 * Ordered, reviewable steps for one environment. Every mutating step names its target and passes
 * the default-deny guard, so a typo or protected name fails while the plan is being rendered.
 */
export function buildProvisionPlan(manifest, envKey) {
  const env = manifest.environments[envKey];
  if (!env) throw new Error(`Unknown environment: ${envKey}`);
  const prefix = env.database.roles.migrator.replace(/_migrator$/, '');
  const fresh = env.hyperdrive.find((h) => h.caching_disabled && !h.optional);
  const steps = [
    { id: 'gate-approval', mutation: false, actor: 'Ted', action: `Approve exact spend: PlanetScale ${env.database.sku} ${env.database.topology} ${env.database.architecture} in ${manifest.database_defaults.region_preference[0].label} (catalog US$${env.database.catalog_monthly_usd}/mo on ${manifest.database_defaults.catalog_checked_at}) and Workers Paid if not already active.` },
    { id: 'gate-tokens', mutation: false, actor: 'Ted', action: 'Create purpose-scoped Cloudflare tokens (see runbook); the existing cloudflared token is not used for deploys.' },
    { id: 'access-app', mutation: true, target: ['access_application', env.access.application_name], actor: 'operator', action: `Create Access application "${env.access.application_name}" for ${env.hostname} (all paths) with an allow policy for named people only; no Bypass or Everyone policy. Do this BEFORE any Worker route exists.` },
    { id: 'access-admin-app', mutation: true, target: ['access_application', env.access.admin_application_name], actor: 'operator', action: `Create Access application "${env.access.admin_application_name}" for ${env.hostname}/admin; record its AUD for FREEDOM_ADMIN_ACCESS_AUD.` },
    { id: 'database', mutation: true, target: ['database', env.database.name], actor: 'Ted (dashboard, Cloudflare-billed)', action: `Cloudflare dashboard → Storage & databases → Postgres & MySQL (Hyperdrive) → Create PlanetScale database → name ${env.database.name}, engine Postgres ${manifest.database_defaults.major_version}, region ${manifest.database_defaults.region_preference[0].pscale_slug}, ${env.database.sku} ${env.database.topology}.` },
    { id: 'roles', mutation: true, target: ['db_role', env.database.roles.migrator], actor: 'operator', command: `psql "${svc(prefix, 'admin')}" -v ON_ERROR_STOP=1 -v env_prefix=${prefix} -f deploy/cloudflare/sql/10-create-roles.psql`, action: `First CREATE DATABASE ${prefix} as the default role (services point at dbname=${prefix}); then create ${env.database.roles.migrator} and ${env.database.roles.runtime} inside it. Passwords are generated into the private directory and never printed.` },
    env.data_source === 'synthetic'
      ? { id: 'schema', mutation: true, target: ['database', env.database.name], actor: 'operator', action: 'Apply migrations 001–037 as the migrator role with the repository runner, then create a synthetic community only. Never run seedLocal (no @local.test accounts) and never restore staging or public data.' }
      : { id: 'restore-rehearsal', mutation: true, target: ['database', env.database.name], actor: 'operator', command: `pg_restore --no-owner --no-privileges --exit-on-error --single-transaction -d "${svc(prefix, 'migrator')}" <verified public backup in private dir>`, action: 'Restore a checksum-verified copy of the latest freedom_public backup into the EMPTY candidate DB; then run the repository migration runner (must report no changed digests), revoke all restored sessions, and run the read-only verification SQL.' },
    { id: 'grants', mutation: true, target: ['db_role', env.database.roles.runtime], actor: 'operator', command: `psql "${svc(prefix, 'migrator')}" -v ON_ERROR_STOP=1 -v env_prefix=${prefix} -f deploy/cloudflare/sql/20-runtime-grants.psql`, action: 'Grant DML-only to the runtime role; ledger read-only.' },
    { id: 'hyperdrive-fresh', mutation: true, target: ['hyperdrive', fresh.name], actor: 'operator', command: `curl -X POST ${HD_API} -H @<auth header fd> --data-binary @<chmod 600 body: name=${fresh.name}, origin=runtime role, caching.disabled=true>`, action: 'Cache-disabled Hyperdrive for every session/permission/write/read-after-write query. The origin password lives only in the private request body file, never in argv.' },
    ...env.hyperdrive.filter((h) => h.optional).map((h) => ({ id: `hyperdrive-${h.binding.toLowerCase()}`, mutation: true, optional: true, target: ['hyperdrive', h.name], actor: 'operator', command: `curl -X POST ${HD_API} -H @<auth header fd> --data-binary @<chmod 600 body: name=${h.name}, caching.max_age=${h.max_age_seconds}>`, action: `Only if the Worker binds ${h.binding}: ${h.use}.` })),
    ...env.r2_buckets.map((b) => ({ id: `r2-${b.name}`, mutation: true, optional: b.optional, target: ['r2_bucket', b.name], actor: 'operator', command: `wrangler r2 bucket create ${b.name}`, action: 'Private bucket; no r2.dev, no custom domain. Only when the Worker binds it.' })),
    { id: 'secrets', mutation: true, target: ['worker', env.worker.name], actor: 'operator', command: `wrangler secret put <NAME> --name ${env.worker.name} < <private file>`, action: `Secrets ${env.secret_names.join(', ')} from stdin. ${env.data_source === 'synthetic' ? 'Fresh random values.' : 'Rehearsal uses a NEW GITHUB_SOCIAL_TOKEN_KEY so restored GitHub credentials cannot be used (no stars/messages); the live key moves only at cutover.'}` },
    { id: 'deploy', mutation: true, target: ['worker', env.worker.name], actor: 'operator', command: `wrangler deploy --env ${envKey}`, action: `Only after 'preflight wrangler' passes (workers_dev=false, preview_urls=false, custom domain ${env.hostname} only).` },
    { id: 'verify', mutation: false, actor: 'operator', action: 'Anonymous request must be redirected by Access; then, using a short-lived Access service token, check health, login, session isolation, read-after-write permission change, Cache-Control no-store on /api/*, restore counters.' },
  ];
  for (const s of steps) if (s.mutation) assertMutationTarget(manifest, envKey, s.target[0], s.target[1]);
  return { environment: envKey, hostname: env.hostname, dry_run: true, steps };
}
