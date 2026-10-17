# Blacksmith onboarding pilot — one manual admission

Tracking and future admission ledger: [#866](https://github.com/FreeTWAI/freedom-platform/issues/866).

The [workflow](../../.github/workflows/blacksmith-onboarding.yml) is an optional
onboarding benchmark, not a required check or substitute for Verify, CodeQL or
the existing CircleCI worker-unit lane. It provides connection/build evidence only.
Its short workload does not prove that Blacksmith saves time on our bottleneck.
There is no automatic routing, deployment or paid overage authorization.

The job is default-off: the non-secret Actions configuration variable
`BLACKSMITH_PILOT_ADMISSION` must equal `first-run-approved` before runner
allocation. An unset or other value rejects the job. There are no dispatch inputs.
This revision prepares admission; it does not set that variable or dispatch.
Only workflow run number **1**, attempt **1**, from the canonical repository's
`main` workflow/ref is eligible. Tags, PR refs, other branches, forks, later runs
and reruns are rejected, even if the variable remains enabled.

The admitting maintainer must inspect workflow history before activation. A
skipped or cancelled first dispatch consumes this numbered slot too: do not probe
with a dispatch, rename/recreate the workflow, increment the admitted number or
retry to recover it. A lost slot needs a new reviewed admission decision.
[GitHub's context reference](https://docs.github.com/en/actions/reference/workflows-and-actions/contexts)
defines the per-workflow run number and per-run attempt. This is a one-run source
guard, not monthly quota enforcement or a provider billing cap. A maintainer who
can change source or configuration can change these controls; code-owner review
and the manual ledger remain essential.

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

1. Obtain the parent/operator's fresh confirmation that the applicable free
   allowance is active and comfortably covers one bounded run plus metering
   headroom, including other organization use. Keep private dashboard and
   negotiated commercial details out of public evidence. No-card exhaustion
   behavior is still unverified; no card is not a hard cap. The first bounded run
   need not wait for general exhaustion terms if that fresh allowance and ample
   headroom are verified. Never authorize paid overage or run near exhaustion.
2. Obtain readback that the installed App and relevant runner groups are limited
   to `freedom-platform`, with the intended public-repository execution and fixed
   runner label available. Runner-group setup is separately owned; this workflow
   does not change it. Check free GitHub artifact allowance too. Do not alter App
   permissions, billing, secrets, required checks or deployment settings.
3. Preserve the complete successful fixed-source install/build rehearsal and its
   unchanged 300-second workload / 15-minute job budgets. Preserve the governance
   failures below and the separate required Verify failure on PR #867. The
   existing messaging lane owns its `chat-stickers.spec.ts` diagnosis/fix; do not
   bypass it or include a duplicate product fix in this pilot.
4. Finish independent exact-head review and all required CI, following the
   existing orchestrator's normal protected merge sequence. Source stays pinned
   to the reviewed SHA above even when the PR synchronizes newer main. Before
   admission, inspect the effective repository/organization admission variable
   and this workflow's complete run history. Confirm the next run is number 1;
   an unavailable history is a blocker, not evidence of zero runs.
5. Only after the parent confirms runner scope and fresh allowance, name the
   admitting maintainer and record ordinal **1**, approver, UTC time, exact
   source/workflow SHA and private allowance evidence reference in #866. Set the
   repository variable `BLACKSMITH_PILOT_ADMISSION` to `first-run-approved`, then
   manually dispatch this workflow on main once. No queue, second dispatch or
   rerun is authorized. Clear the variable immediately after admission; changing
   it does not cancel an already running job.
6. Retain the run URL, result and settled provider usage. Failed/cancelled runs
   count. Stop on missing metering, failure, unexpected charges or uncertain
   headroom. This revision admits only one run; the proposed **maximum ten-run
   trial** is a planning ceiling, not permission for the remaining nine. Each
   later admission requires a fresh reviewed source change and allowance check.

[Blacksmith's runner documentation](https://docs.blacksmith.sh/blacksmith-runners/overview)
lists the fixed 4-vCPU Ubuntu runner and bills its runtime at twice normalized
2-vCPU minutes. Ten runs at the nominal 15-minute ceiling therefore budget
`10 × 15 × 2 = 300` normalized minutes **plus billing headroom** for provider
rounding, setup/teardown and delayed cancellation/metering. One run budgets nominally `15 × 2 = 30` normalized minutes plus substantial
headroom. Verify fresh allowance before admission; do not infer a hard stop. Job timeout and workflow concurrency are
not billing controls. Concurrency only serializes runs; the fixed run-number guard
does not enforce a monthly spending cap or automatic quota accounting. Shared organization usage
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

## Local validation scratch

Historical local governance and build rehearsals used `/tmp` on tmpfs; retain
those results with that limitation. Future tests must use verified disk-backed
scratch (for example a task-owned directory under `/workspace` after checking
its mount), set `TMPDIR` explicitly, and remove only owned fixtures. Do not rerun
the complete suites merely to replace historical environment evidence.
