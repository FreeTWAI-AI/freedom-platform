# Isolated base candidate installation request

`node deploy/cloudflare/candidate-admission.mjs` reads the bounded placeholder
request and prints three generated configs plus an **unavailable** admission
report (exit 2). `--request PATH` checks an explicit local request against the
same canonical `deploy/cloudflare/environments.json`; no alternative manifest,
credentials, environment file, execute flag, resource creation or deployment
is accepted. Invalid requests exit 1. Names and IDs have not been approved.
The generated configs are review artifacts, not an installation authorization.
Copying them into Wrangler does not complete any provider or runtime check.

The three configs import the real main, credential-broker and named media
operator entrypoints. Every route, cron, workers.dev and preview URL is off.
They share only the requested new private MEDIA bucket. Four Hyperdrive IDs
must be distinct: main app, cipher, executor and operator. All feature flags
remain off. Main's native avatar binding is also subject to original canonical
SQL consent and persistence guards; a binding alone is not permission to write.
Images processing uses the existing IMAGES binding, not a new decoder adapter.
The seven media mapping entries come from the existing canonical Worker feature
registry; they do not assert seven operator profiles installed in this source.

The separate candidate hostname and Worker names must not use normal operational
names/routes, production or staging buckets, or `freedom-platform`/`main`.
Staging still requires logical database `freedom_staging_next` and schema
`public` in a **new, empty, synthetic physical branch**, not a clone of member
or staging data. Creating a differently named Hyperdrive against the same
physical origin is rejected by readback. The app runtime role remains the
canonical staging runtime role, broker roles remain
`freedom_staging_next_broker`/`freedom_staging_next_broker_executor`, and the
operator remains `freedom_media_migrator`. Existing SQL installers and runtime
checks govern the role privileges; this tool installs no grants.

`expected_roles` contains those bare SQL role names for grants and runtime SQL
checks. `expected_connection_users` is derived from each role plus the exact
requested physical `database.branchId`: `<role>.<branch-id>`. This follows
[PlanetScale's role connection routing](https://planetscale.com/docs/postgres/connecting/roles#creating-roles-via-create-role)
and the canonical `20-runtime-grants.psql` distinction. Hyperdrive readback
must report that exact composite `origin.user` for each of the four roles.
Bare roles, another branch suffix, extra suffixes and caller-supplied username
overrides are rejected. This declared routing match still does not prove the
branch's provider identity, emptiness, current SQL privileges or connectivity.

Actual source constraints:

- Main `worker.ts` and `readiness.ts` accept an explicit non-loopback staging
  HTTPS origin and check the exact logical database/non-superuser and optional
  initialized community. These checks do not prove physical branch isolation.
- Broker `apps/credential-broker/src/worker.ts` additionally pins platformOrigin
  to the normal operational hostname. A distinct candidate cannot activate that
  broker with the current contract. `broker_candidate_origin_unsupported`
  remains blocked, with broker OFF; operational origin is never substituted.
- Operator `apps/media-operator/src/worker.ts` requires exact staging logical
  DB/public schema/migrator role and an installed closed profile, and rechecks
  current role authority. Profile/key/approval activation must be separately
  installed using fresh candidate-only authority. No existing keys are read.

Before a later approved installation: verify a fresh empty physical branch and
its provider branch identity; apply reviewed migrations/least-privilege grants
there; initialize only synthetic fixtures; allocate a new private R2 bucket
with public/custom access disabled; allocate four fresh cache-disabled
Hyperdrives to that branch; install fresh candidate-only keys/recovery services
and explicit canonical consent; then independently review the separate route
and hostname. No existing access app, secrets, DNS route or resources are reused
or edited by this increment. No acceptance user is registered here.

The optional library provider reader uses the existing GET-only Cloudflare
client and redaction. It compares a bounded complete Hyperdrive inventory and
both canonical operating Hyperdrive readbacks with all four candidate IDs,
physical origin host, cache setting and declared role/database. Partial inventory
never proves absence. This observes provider declarations only: it does not
prove physical branch identity or emptiness, R2 privacy or byte access, current
SQL roles, remote session/cache/ACL behavior, or remote operator atomicity.
Every such acceptance remains `not_run` and deployment/execution authority
remains false even after a successful mock or readback. The CLI deliberately
installs no provider reader; this batch makes no credentialed request.
