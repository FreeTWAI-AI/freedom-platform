# Native CircleCI worker suite candidate

`worker-tests` runs one `worker-unit` job for every pipeline delivered by the
existing native GitHub integration. There is no opt-in flag, historical candidate
parameter, controller, ledger writer, API dispatcher or automatic fallback.
GitHub worker execution is substituted only by the guarded policy below.

The candidate is `pipeline.git.revision`, checked against `CIRCLE_SHA1` and verified after checkout. The OAuth integration
does not provide `pipeline.config.sha` (pipeline 9 compiled it as null). Public anonymous
Git fetches materialize that exact commit. The reviewed runner is pinned to main
`3c1ff74476d4072f5a1b8b179a1bb0faecefc461`; worker runner/definition behavior is
unchanged from the successful #718 pilot (the intervening runner edit concerns
runtime partition aggregation only). The resource class is explicitly `medium`.
Node 24.21.0, pinned PostgreSQL and build/dry-run prerequisites reuse #718.

The existing complete `ci.worker-unit` runner discovers the candidate worker
files and validates complete case accounting. Its exit code controls the job:
failure, timeout and not-run remain failures. Artifacts retain the complete
`worker-unit-evidence.json` report and `worker-unit-source.json` containing exact
candidate/runner SHA, checked-out config-file hash, pipeline/workflow/job IDs, resource class and Node
version. No-workflow is never worker success. Cancellation or missing artifacts
is not acceptance. This retains existing candidate-test trust, not independent
attestation against malicious test code.

The project must remain free of attached provider secrets/contexts. No checkout
key or controller token is needed by these commands. Native CircleCI GitHub
status/check publication uses the existing integration, not credentials in this
job. No provider permission, trigger setting or GitHub ruleset is changed here.

## Validate this branch before adoption

1. Read back the existing pipeline definition: config and checkout must both use
   this repository and the pushed candidate ref, config path `.circleci/config.yml`.
   Use the existing native push trigger; do not add an overlapping PR trigger
   that runs the same commit twice. Check whether current native trigger coverage
   includes required PR/fork events rather than assuming that from this YAML.
2. Follow the automatically created pipeline for this PR head. Require a real
   successful `worker-unit` job, matching candidate/head SHA and checked-out config hash, complete
   file/case artifacts and provider job identity. Record duration/credits.
   The old 143-credit, 38-file/109-case run on `1e584aa8` is historical only.
3. Inspect GitHub's actual check/status: record its exact context/name, publisher
   App identity and head SHA. Do not guess `ci/circleci: worker-unit` from the job
   name. Verify genuine failure and cancellation cannot satisfy the required
   result; absence must block rather than pass. No current successful readback
   or required-status binding is claimed by this code change.

## Guarded Verify substitution (approved 2026-10-16 01:51 UTC)

Verify's static-worker job receives only `contents: read` and `statuses: read`.
Before candidate checkout/package execution, it checks out the status guard from
`job.workflow_sha` and runs it with the existing GitHub token scoped to that step.
No CircleCI token, ledger, dispatch service or ruleset change is required.

Only a same-repository PR whose exact head and integration commits have identical
Git tree IDs may substitute CircleCI. Forks, different trees, main pushes and
merge groups still run the existing GitHub worker suite. Every other static-worker
command (including contracts, builds, typechecks, broker checks and media restore)
is retained. The old unconditional three-line removal patch was withdrawn.

For eligible PRs, the guard reads statuses for the exact event head SHA and
selects the newest `ci/circleci: worker-unit` entry before evaluating success.
It pins the observed legacy OAuth publisher login `teddashh`, numeric user ID
`233386770`, status commit URL, and canonical CircleCI repository/job URL.
This is a trusted OAuth-user status, NOT an App-attested check: the same account
can publish statuses manually. Its avatar and target URL alone do not authenticate
CircleCI execution. This accepted trust limit does not change the live ruleset.
Historical provider artifacts establish the existing job's full suite behavior;
the guard itself consumes the native status, not those artifacts or a new report
collector. CI controls retain code-owner review and existing Verify trust limits.

A newer failure/error, wrong identity, wrong commit, malformed metadata or API
outage fails Verify. Missing/pending statuses wait at most 15 minutes, then fail;
no older green status or rerun on GitHub hides the outcome. Reads have 15-second
request deadlines, 2 MB bodies and at most five 100-status pages per poll. The
existing 40-minute job deadline remains an additional bound. Cancellation cannot
make an absent/pending result pass. Statuses can change after the final read; this
is a point-in-time gate, not a new independently bound required CircleCI check.

The current candidate SHA and identical integration tree are logged on success.
A fresh head requires its own status. Separately approved live check/ruleset
adoption and broader fork/merge-queue substitution are outside this change.

## Local checks and limits

Offline YAML structure, shell syntax and exact runner pin checks do not prove
CircleCI compilation, resource availability, trigger mapping or status delivery.
CircleCI CLI/browser access is unavailable in this execution environment; use
the existing integration's automatic pipeline and readback for provider validation.
No manual duplicate full GitHub CI is required. The unfinished evidence collector
and disabled automatic budget controller in #818 are preserved but are not used
by this native path.

References: [pipeline values](https://circleci.com/docs/reference/variables/),
[native GitHub Checks](https://circleci.com/docs/guides/integration/enable-checks/).

## OAuth config provenance correction

Official variable documentation limits `pipeline.config.*` to GitHub App / App
Server; OAuth uses the same repository as checkout. The first step hashes
`git show <exact-candidate>:.circleci/config.yml` before dependency installation
and records `checkout_commit`, `circle_sha1`, `config_file_sha256` and
`config_provenance: oauth-same-repository-checkout-assumption`. This identifies
committed config bytes, not an independently authenticated copy of the compiled
provider config. Native push provenance and the same-repository configuration
assumption must be checked against provider pipeline metadata. `CIRCLE_SHA1` is
a checkout identity, not a separately proven event-trigger SHA. No unsupported
config SHA is relabeled as verified; candidate equality and exact checkout
checks stay mandatory. The authenticated pipeline 9 evidence confirms its null
CONFIG_SHA caused the old guard to reject before any tests ran.
