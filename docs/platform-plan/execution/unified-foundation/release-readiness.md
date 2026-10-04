# Push, merge and deployment readiness

Checked 2026-10-03 at integration baseline `946d67bd200624ba61d23032ee7571e9fd47c602`. This checklist records conditions, not authorization or completed checks. The historical 40–55% engineering estimate is not a deployment completion rate or calendar forecast; the 168 original product acceptance items remain `not_run`, as recorded in [implementation status](implementation-status.md), [foundation acceptance](acceptance.md) and [source acceptance](source-acceptance.md).

Ted’s latest scope is foundation-first; other PRs are not worked during this task. Full original Autopilot acceptance remains separate, and unaccepted functionality stays disabled. This changes development/release scope, not deployment authority.

The subsequent local target-runtime increment has passed standard runtime at
`1584a77` (2,430), with Worker/host-tool supplement at `d238a87` (43 Worker,
250 governance, six isolated supervisor cases). It adds Worker composition,
media profiles/read-only aggregate inventory and a pinned-host CI adapter. None
of the four actual release artifacts is delivered yet: remote staging flow,
seven-kind full migration report, DB+R2 restore report, or malicious PR refusal
through an installed GitHub gate. That paragraph describes the earlier source. The current foundation increment
adds genuine broker Worker execution, seven finite media-domain adapters,
bounded actual-content verification/delta and a consistent local DB+R2 restore
drill. All-source operator backfill/cutover,
complete recovery acceptance and authenticated publisher/enforcement
are still implementation work as well as configuration/acceptance dependencies.

## What changes a remote system

| Action | Effect and required condition |
| --- | --- |
| Push an authorized feature branch / update Draft PR 108 | Publishes reviewed code/docs and starts pull-request CI. Scan tracked changes for private material, regenerate inventory, run inventory verification and appropriate checks at the exact final SHA. Existing push authorization does not grant merge or deployment authority. |
| Merge to `main` | Changes shared source and runs main CI. Require explicit merge authorization, exact-head green checks, resolved review/dependencies, checked current merge policy and provenance; do not claim local checks establish GitHub enforcement. Product acceptance and security gaps must be resolved for a release-ready merge; a nonrelease integration merge requires an explicit scope decision. |
| Deploy to staging / public | Mutates a Worker, database or provider configuration. Requires separate deployment authorization for the exact SHA, environment and migration plan, and all gates below. A push or merge is not deployment permission. |

The checked repository has three [GitHub workflows](../../../../.github/workflows/verify.yml): verification on PR/main (including Wrangler **dry runs**), scheduled/manual upstream drift inspection, and issue labeling. None contains real deployment or migration commands. There is no repository automatic deploy on push/merge in these files. External provider integrations, private operator helpers or GitHub settings are not verified by this source audit; check them before an authorized release. No remote rules, live health or current CI conclusions were changed or inferred here.

## Environment and data boundaries

[wrangler.jsonc](../../../../wrangler.jsonc) maps `staging-next` to Worker `freedom-platform-staging-next`, route `staging.freetwai.com/*`, `FREEDOM_ENV=staging`; `next` maps to `freedom-platform-next`, route `freetwai.com/*`, `FREEDOM_ENV=public`. **`next` is production**, not a disposable candidate. Castle is local development. The checked configuration disables workers.dev and preview URLs. Staging and public require separate PostgreSQL databases, Hyperdrive resources, private overlays, secrets and Access configuration. Committed all-zero Hyperdrive IDs are intentional placeholders, not missing-resource evidence or deployable configuration. Provider-read evidence must establish cache disabled; comments cannot establish it.

Do not run migration/seed against the original checkout or `freedom_local.public`. Local development remains confined to the authorized isolated `fp_` test schema/database. The local [database script](../../../../scripts/database.ts) applies all pending migrations in sorted order within a transaction and checks previously applied hashes; its `NODE_ENV=production` refusal is not a substitute for checking the actual database target. It is not the production migrator. Local CI passing on a disposable PostgreSQL instance does not apply migration to staging or live.

## Required release evidence

- [ ] Complete the deployable foundation selected by Ted on 2026-10-03: preserve existing member flows and ACLs, finish all seven media adapters and migration/delta verification, consistent DB+R2 backup/restore, target Cloudflare wiring and trustworthy GitHub release checks. Unaccepted Autopilot/machine/multistep/cross-runtime features stay disabled and remain original-scope backlog; they are not foundation acceptance evidence. Review default-off behavior, installed authentication, secret boundaries, replay/rate limits, private reads and revocation.
- [ ] Revalidate the exact release SHA, artifact digest and affected consumers. Complete CI checks required by the actual current repository policy, verify source pins and inventory, and record independent review. Earlier CI or a Draft PR is insufficient. The checked baseline does not prove enforced branch protection or a trusted publisher.
- [ ] Reconcile migrations **076–107**, immutable ledger hashes and any subsequently merged numbering; these are not applied to staging/public by this work. Prepare migrator/runtime grants separation and app/grants probes. Additive/expand steps must preserve historical data shapes and ACLs; do not contract/remove legacy storage until supported consumers and data have exited. Per the [release decision](04-execution-adapters-release.md#發布與-restore), use controlled forward migration for the foundation-first scope recorded in the [latest decision](00-baseline-and-decisions.md#2026-10-03-基底優先的最新指示). Stop incompatible consumers during the approved maintenance window.
- [ ] Confirm each target's private overlay, routes, database identity, Hyperdrive cache-off readback, required secret/binding presence and `FREEDOM_RELEASE_SHA` injection through the [cloud migration procedure](../../../development/cloudflare-migration.md). Preserve Access boundaries and separately gate scheduled/admin-sync/maintainer writes. Repository dry-run is bundle verification only.
- [ ] Capture pre-migration backups and complete a restore drill into a new isolated database with schema/ledger/grants and DB+R2 object/version checks. Fence dispatch before restore; recover using an external generation that cannot rewind with a DB snapshot, then reconcile revocation/deletion tombstones, outbox and unknown provider effects. Demonstrate old tokens cannot revive. Backup policy, maintenance window and recovery authority still require explicit operator decisions.
- [ ] Deploy authorized exact SHA to staging first; verify real HTTPS/member/privacy flows, provider behavior, actual scheduled writes where applicable, release SHA and Access. Remove temporary verification policies/tokens and synthetic accounts. Only then perform the separately authorized public backup/migration/grants/deploy/probes and record resulting health/release evidence.

The [release compatibility diagnostic](../../../../deploy/cloudflare/release-compatibility.md) deliberately grants no deployment/execution authority or restore proof; a successful synthetic compatibility result cannot clear these gates. Until they are satisfied, preserve default legacy/persistence-disabled behavior and do not enable production private writes, nonlegacy avatar storage or execution dispatch. This document performs no push, merge, provider call, migration or deployment.
