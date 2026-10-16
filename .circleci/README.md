# Manual worker test pilot

This optional CircleCI job runs the existing complete `ci.worker-unit` suite.
Its workflow is disabled unless `run-worker-pilot=true` is explicitly supplied.
The default candidate and reviewed runner are both
`1e584aa8734addfe251c7f081cf51cc84a52567f`; `candidate-sha` accepts an exact
40-character commit reachable from the public FreeTWAI/freedom-platform repository.
The job records both SHAs and retains the existing sanitized suite report.

The job uses Node 24.21.0, the same pinned PostgreSQL 18 image and disposable
fixture settings as the existing GitHub static-worker lane, and the existing
build/dry-run prerequisites. The suite retains its 900-second execution budget,
baseline plus file discovery, complete case accounting, and failure semantics.
The job has no CircleCI contexts or provider credentials; this file defines no trigger,
runtime partitions, browser suite, deployment, or change to GitHub required checks.
Use a project with no attached secrets; public HTTPS fetches need no checkout key.
The temporary PostgreSQL service belongs to the job and is discarded afterward.

## Run one pilot

After CircleCI authentication and the actual organization, integration and project
have been verified, use an existing project/pipeline or create the single intended
pipeline definition with this config path. Keep event/schedule triggers absent.
GitHub App projects use their verified CircleCI organization/project IDs; do not
infer an OAuth `gh/FreeTWAI/freedom-platform` slug from the repository name.

Manually trigger the config branch with boolean `run-worker-pilot=true` and an
explicit string `candidate-sha` for the candidate being compared. With current
CircleCI CLI v1, the equivalent command is:

```sh
circleci pipeline run --project <verified-project-slug> \
  --definition-id <verified-pipeline-id> --branch <branch-containing-this-config> \
  --param run-worker-pilot=true --param candidate-sha=<exact-40-character-sha>
```

Keep this a bounded comparison with the existing GitHub worker evidence. Inspect
the actual candidate/runner IDs, selected files and complete per-case result in
`worker-unit-source.json` and `worker-unit-evidence.json`, plus the job's duration
and credit use. Missing files, zero cases, failure, cancellation or timeout retain
the existing runner's failing/not-run outcome. Stop after the comparison and
resolve any missing coverage or environment mismatch before proposing adoption.

## Existing measurement

On 2026-10-15, GitHub [static-worker job 116291139919](https://github.com/FreeTWAI/freedom-platform/actions/runs/38694524884/job/116291139919)
tested candidate and runner `1e584aa8734addfe251c7f081cf51cc84a52567f` with Node
24.21.0. `ci.worker-unit` passed 38 files / 109 cases in 256 seconds
(07:53:25–07:57:41 UTC). The complete static-worker job took 427 seconds,
including other checks and media restore tests that this pilot does not run.
Suite evidence SHA-256:
`5070928f51a94ff106cb6aeb091537394d72b1107e935beb4612a8aca6733a52`.
The enclosing Verify run failed at runtime aggregation; the worker result does
not establish a successful full-platform run.

The historical CircleCI pipeline 2 also passed 38 files / 109 cases for that
same historical candidate/runner: 143 credits, job duration 7m07s. This is not
evidence for the current PR head or routing adapter. Queue time,
resource class and dependency-cache conditions can differ between providers.

Adoption is a separate reviewed change after the comparison: retain trustworthy
candidate attribution and required-check behavior, establish the supported fork
path without secrets, then remove duplicate worker execution from its original
lane only when the replacement is proven. Do not copy the full runtime/browser
suite to CircleCI or leave both worker jobs running automatically on every push.

## Validate configuration without credentials

```sh
circleci config validate .circleci/config.yml
circleci config process .circleci/config.yml --pipeline-parameters 'run-worker-pilot: false'
circleci config process .circleci/config.yml --pipeline-parameters 'run-worker-pilot: true'
```

The default configuration must compile to zero jobs; the opt-in form compiles to
one worker-unit job. These are configuration checks, not test execution. Public
configuration compilation uses CircleCI's API without credentials; local YAML
and compiled shell syntax checks can also run offline.

## Config availability and routing boundary (#818)

This file and config are imported from #718 at
`e9fd9cbdd2e40d38066fc41e42832cd7110321ed`; the config bytes are unchanged.
Main `3c1ff744` and #818 `bc2257ec` had no `.circleci/config.yml`.
Consequently an existing provider push trigger selecting either ref could fail
before workflow evaluation with “No configuration was found”. Adding this file
allows pushes whose **config source is this branch** to resolve the config.
It does not repair other branches or a pipeline definition pinned to main.
The provider's config repository/ref/path and checkout mapping must still be
read back by a maintainer; no provider trigger or permission is changed here.

An ordinary push supplies no pilot opt-in, so the only workflow is false and
no worker suite should launch. No-workflow/config-valid is not a passing worker
test and must never replace GitHub's required checks. No fake passing job is
added. Provider compilation and the next automatic push outcome still need
readback; offline YAML checks alone do not prove provider acceptance.

This is the historical **manual diagnostic pilot**, not live routing support.
It accepts only `run-worker-pilot` and `candidate-sha`; the reviewed runner stays
pinned to `1e584aa8734addfe251c7f081cf51cc84a52567f`. Do not point the routing
adapter at this config: `runner-sha`, `suite-digest` and `routing-attempt` are
unsupported, and its artifact/source shape is not the routing evidence contract.
Implementing and reviewing those parameters, exact source/config/job evidence,
and the credential-free execution boundary is a separate activation prerequisite.
Do not opt in or change trigger filters as part of this integration.
