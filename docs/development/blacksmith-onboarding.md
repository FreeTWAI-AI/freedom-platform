# Blacksmith onboarding pilot — disabled

Tracking and future admission ledger: [#866](https://github.com/FreeTWAI/freedom-platform/issues/866).

The [workflow](../../.github/workflows/blacksmith-onboarding.yml) is an optional
onboarding benchmark, not a required check or substitute for Verify, CodeQL or
the existing CircleCI worker-unit lane. It provides connection/build evidence only.
Its short workload does not prove that Blacksmith saves time on our bottleneck.
There is no automatic routing, deployment or paid overage authorization.

The job-level literal `false` prevents Blacksmith runner allocation, even after
a manual dispatch. There are no dispatch inputs. Activation needs a separately
reviewed change to that literal; do not activate or dispatch as part of this PR.
Only the canonical repository's `main` workflow/ref and first run attempt are
eligible after activation. Tags, PR refs, other branches, forks and reruns are
rejected. A maintainer who can change workflow source can change these controls:
existing code-owner review remains essential.

## Fixed experiment

- One `blacksmith-4vcpu-ubuntu-2404` job, 15-minute job timeout; no matrix,
  retries, caches, sticky disks, paid storage add-ons, secrets or services.
- Source pins merged main `75309b0747a5220e9aa2a478a5012cc3c3c35ee6` (#861).
  The workflow verifies the clean checkout before installation. Build commands
  come from that reviewed source; no separate test-runner checkout is needed.
  Pin changes require review; arbitrary source/command inputs are not accepted.
- Existing checkout/setup-node/upload-artifact action SHAs and Node 24 are
  reused. Checkout credentials are not persisted; token permissions are only
  `contents: read`. Install uses `npm ci --ignore-scripts --no-audit --no-fund`.
- Run the complete existing `npm run build`: guild-registry and runtime-text
  freshness checks, skill-client packaging, and production Vite build. No database,
  server startup or deployment. The command has a 300-second timeout, then at most
  five seconds for forced termination; the overall job remains 15 minutes.
  Required CI and its suite definitions are unchanged. This optional build never
  substitutes for governance, runtime, browser or other required verification.
- Four explicitly named JSON evidence files retain source/workflow SHA,
  runner label/identity, actual Node version, observed logical CPU count, available
  parallelism, CPU model(s), `/etc/os-release`, kernel and runner image identifiers
  (explicitly null when the provider does not expose `ImageOS`/`ImageVersion`),
  separate install/build durations and exit codes, and total elapsed time with
  step outcomes. Total spans the first step through the summary, including checkout
  and Node setup, but excludes queue, provisioning and artifact upload; it is not
  provider billing time. Missing start time yields null, never invented duration.
  GitHub artifacts expire after one day. Check free artifact allowance before
  admission; no storage purchase is authorized. A timeout, cancellation or setup failure can prevent
  final artifacts: retain the failed run/logs and never count it as a pass.

## Activation checklist and manual admission

1. Ted must privately confirm the applicable offer is active and obtain explicit
   provider confirmation of what happens when free minutes are exhausted with
   no payment method. Offer activation and exhaustion behavior remain unverified.
   Keep private account/dashboard and negotiated commercial details out of public
   evidence. An offer or absent payment method is not a hard stop guarantee.
2. Confirm the installed App remains limited to `freedom-platform`, the fixed
   runner is available, no paid overage can occur, and sufficient free compute
   and GitHub artifact allowance remain. Do not alter App permissions, billing,
   secrets, required checks, deployments or provider settings for this pilot.
   If those confirmations require changes, stop and seek separate authorization.
3. Require a complete successful fixed-source install/build rehearsal within the
   unchanged 300-second workload limit and 15-minute job budget. Record source,
   workflow, environment and results. Preserve the governance failures below;
   switching this optional benchmark does not resolve or waive mandatory evidence.
   Do not omit build steps or combine partial runs into a pass.
4. Review the source and action pins, approve a separate activation PR,
   and name one maintainer responsible for admission. Keep the first trial to
   **at most ten manually admitted runs**. Before each dispatch, record an ordinal,
   approver, UTC time, source/workflow SHA and remaining quota in the tracking
   issue; after it settles, add the run URL, result and provider-metered usage.
   Failed/cancelled runs count toward the ten. Do not queue runs or rerun jobs.
5. Admit the next run only after the previous run finishes and its provider usage
   settles. Stop on unexpected charges, missing metering, failure, exhausted
   headroom or uncertain behavior. Restore the literal `false` by reviewed change
   when the trial ends; maintainers can disable the workflow to stop admission.

[Blacksmith's runner documentation](https://docs.blacksmith.sh/blacksmith-runners/overview)
lists the fixed 4-vCPU Ubuntu runner and bills its runtime at twice normalized
2-vCPU minutes. Ten runs at the nominal 15-minute ceiling therefore budget
`10 × 15 × 2 = 300` normalized minutes **plus billing headroom** for provider
rounding, setup/teardown and delayed cancellation/metering. Confirm that headroom
with the provider before activation. Job timeout and workflow concurrency are
not billing controls. Concurrency only serializes runs; no run-number expression,
monthly cap or automatic quota enforcement is claimed. Shared organization usage
also consumes allowance. No-card exhaustion behavior remains unverified.

## Evidence and later comparison

Download the small artifacts before expiry and link them from the admission
record. Missing evidence is `not_run`/incomplete, never inferred success. Artifact
data is diagnostic, not independently authenticated merge evidence. Keep the
original failures and do not splice successful subsets into a passing run.

A later, separately admitted GitHub baseline must use the same source SHA,
workflow command identity, Node version, lockfile, install flags, full build and
cold-cache conditions. Record the actual GitHub runner class/CPU/OS, setup and queue time,
install/build/total duration, result and provider usage separately. Compare matched
samples only; no baseline has been run and no speed or cost saving is claimed.

## Preserved local governance failures and workload decision

The initial optional workload was the complete pinned `ci.governance-unit` suite
at source/runner `75309b0747a5220e9aa2a478a5012cc3c3c35ee6`. It was not reduced
or declared passing:

- Original full rehearsal: failed cancellation regression, then `test_timeout`
  at 300 seconds; 41 files selected, 26 started, 25 completed.
- Exact-base focused diagnosis: both servers received SIGTERM and closed their
  ports, but this environment's PID 1 (`tail`) left zombies. The unchanged PID
  assertion failed. Under local `tini 0.19.0`, the unchanged focused case passed
  1/1 with zero skips. That is not a full-suite pass.
- One authorized full subreaper rehearsal: `failed/test_timeout`, exit 1,
  300.422 seconds; 41 files selected, 25 started, 24 completed. No repeated
  attempts or increased suite budget followed. Full governance timing remains
  unresolved here, and its required CI obligations are untouched.

The approved replacement is the existing full build, not a filtered test subset.
One proposal measurement on the same source passed in 10.496 seconds (Vite 5.36s),
with dependencies already installed and no prior `dist`. That single local sample
is neither typical duration nor a matched GitHub/Blacksmith baseline. It supports
bounded onboarding/build execution only, not acceleration or cost savings.
The revised shell-step rehearsal on 2026-10-16 passed on a fresh pinned checkout:
install 10 seconds, full build 5 seconds, measured total 15.796 seconds (outer
wall time 15.836 seconds). It reused a local npm cache; checkout/setup-node/upload
actions were not executed locally. It is not a hosted or cold-cache comparison.
Original results and the decision are recorded on [PR #867](https://github.com/FreeTWAI/freedom-platform/pull/867).
