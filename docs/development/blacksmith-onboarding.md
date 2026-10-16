# Blacksmith onboarding pilot — disabled

Tracking and future admission ledger: [#866](https://github.com/FreeTWAI/freedom-platform/issues/866).

The [workflow](../../.github/workflows/blacksmith-onboarding.yml) is an optional
onboarding benchmark, not a required check or substitute for Verify, CodeQL or
the existing CircleCI worker-unit lane. It proves runner onboarding only, not
heavy-job speedup. There is no automatic routing, deployment or paid overage
authorization.

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
- Source and suite runner both pin merged main
  `75309b0747a5220e9aa2a478a5012cc3c3c35ee6` (#861). The workflow checks both
  checkouts and the suite policy before dependency installation. Pin changes
  require review; arbitrary source/runner/command inputs are not accepted.
- Existing checkout/setup-node/upload-artifact action SHAs and Node 24 are
  reused. Checkout credentials are not persisted; token permissions are only
  `contents: read`. Install uses `npm ci --ignore-scripts --no-audit --no-fund`.
- The existing pinned `ci.governance-unit` suite remains `database: false`,
  `timeoutMs: 300000`; no custom runner or suite replacement is introduced.
- Four explicitly named JSON evidence files retain source/runner/workflow SHA,
  runner label/identity, actual Node version, install/test elapsed seconds and
  exit codes, plus the existing per-case suite result. GitHub artifacts expire
  after one day. Check free artifact allowance before admission; no storage
  purchase is authorized. A timeout, cancellation or setup failure can prevent
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
3. Review the source, runner and action pins, approve a separate activation PR,
   and name one maintainer responsible for admission. Keep the first trial to
   **at most ten manually admitted runs**. Before each dispatch, record an ordinal,
   approver, UTC time, source/workflow SHA and remaining quota in the tracking
   issue; after it settles, add the run URL, result and provider-metered usage.
   Failed/cancelled runs count toward the ten. Do not queue runs or rerun jobs.
4. Admit the next run only after the previous run finishes and its provider usage
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
runner code SHA, Node version, lockfile, install flags, suite and cold-cache
conditions. Record the actual GitHub runner class/CPU/OS, setup and queue time,
install/test duration, result and provider usage separately. Compare matched
samples only; no baseline has been run and no speed or cost saving is claimed.
