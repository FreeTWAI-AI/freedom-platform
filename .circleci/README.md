# Native CircleCI worker suite candidate

`worker-tests` runs one `worker-unit` job for every pipeline delivered by the
existing native GitHub integration. There is no opt-in flag, historical candidate
parameter, controller, ledger writer, API dispatcher or automatic fallback.
Existing GitHub worker coverage remains until coordinated adoption below.

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

## Separate coordinated adoption (NOT applied)

The prepared `packages/contribution-tools/worker-unit-adoption.patch` removes
only the three-line worker suite invocation/environment from GitHub Verify.
It leaves static-worker's builds, typechecks, contracts, broker checks and both
media restore tests intact. It is a review artifact, not an applied change:

```sh
git apply --check packages/contribution-tools/worker-unit-adoption.patch
```

Before applying it, explicitly approve the live ruleset change adding the
**observed** CircleCI context and publisher App binding while retaining existing
`verify` and `CodeQL` requirements. Verify protection on a current PR and required
failure/pending outcomes. Then review/apply the patch in a separate adoption PR.
No skip status or GitHub success stub substitutes for CircleCI's worker result.

GitHub Verify currently runs `github.sha` (PR integration/merge-group candidate).
A native push typically tests the branch head instead. Those are NOT equivalent
commits. Adoption therefore also requires an explicit maintainer decision:
retain GitHub worker validation for integration/merge-group commits, or configure
and verify native CircleCI execution/status for those exact required candidates.
Do not remove coverage based solely on a head-commit success. Forks and merge
queues remain unverified until demonstrated through the existing integration.
The patch is deliberately not applied while that binding is unresolved.

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
