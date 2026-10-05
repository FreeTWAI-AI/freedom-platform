# Existing consumer source profiles

`packages/contribution-tools/consumer-source-profiles.mjs` supplies fixed source-integrity profiles for the six consumers outside the new shared-workspace exports: `.github`, `FreeTWAI-AI.github.io`, growth automation, project page, project template and skill registry. It does not modify `consumer-libraries.mjs`, the three consumer commits pinned to source91, or any preview pin.

The native host supplies immutable candidate files and readers backed by its approved `repositories.lock.json` baseline and independently selected canonical source commit:

```js
const profile = CONSUMER_SOURCE_PROFILES[repository];
// Host materializes profile.required_paths plus the complete baseline preview tree.
const result = await verifyConsumerSourceProfile({
  repository,
  repositoryRoot: immutableCandidateSnapshot,
  readBaseline: path => readApprovedBaselineGitBlob(path),
  readCanonical: path => readSelectedPlatformGitBlob(path),
});
```

The helper requires the unchanged baseline preview lock, reuses `verifyContractPin` for the exact bundle/artifact set, and compares every preview byte to both approved baseline and canonical source. The old b221 source pin is preserved when its bytes match source91; a cosmetic repin is rejected as baseline drift.

Every profile includes the existing manifest, package/toolchain files and actual execution entrypoints. Verification scripts and workflows, plus registered build automation (`scripts/build.mjs`, `scripts/check-registry.mjs`, `examples/preview-campaign.mjs`), must equal approved baseline bytes. All root package executable registration metadata must remain unchanged: commands/hooks, export/import aliases, bin/main/browser and unknown non-descriptive fields. The native host additionally checks complete Git inventories for added nested packages and known launchers; see [explicit registration coverage](../../packages/contribution-tools/github-consumer-host.md#explicit-executable-registrations). Product `src`/domain/test files may change but required entry paths cannot disappear. Their presence does not prove correct behavior; existing CI remains responsible for product tests.

`freedom.project.yaml` is parsed without duplicate keys, bound to the selected repository and baseline identity/ownership/data-boundary/release/toolchain/publication fields, then validated with the existing canonical `scripts/repository-bootstrap/verify-project-manifest.py`. The host uses trusted Python3 plus `jsonschema==4.26.0`. Python runs with `-I` from a separately materialized canonical script; candidate scripts, build commands, Python modules and network checks are not executed. Missing dependencies return unavailable; invalid manifests fail. Both `.tool-versions` and `package-lock.json` are explicit fixed materialization paths, not candidate-selected paths.

Results distinguish `protected_automation` from `entries: required-paths-present`. `library_usage` and `runtime_observation` remain `not_checked`; source checks alone do not grant merge/execution authority or prove installed enforcement. Source-only profile coverage across all nine repositories is not complete behavioral P2 acceptance. A new approved build/profile baseline must be reviewed outside the candidate before protected automation or authority metadata can change.

The source-directory profile follows the independently reviewed `90f790763f4f0507d123f325d194d2cf7b9bf73f` directory baseline: it requires the privacy page source/data/tests and protects `.github/workflows/pages.yml` as existing approved deployment automation. That does not enable deployment or approve new publication. The previous profile was verified against78ce; a candidate cannot silently promote its own90f baseline. The native host must select the updated repository lock approved outside that candidate.


## Candidate directory baseline promotion: validate before writing

The candidate central lock promotes only `FreeTWAI-AI/FreeTWAI-AI.github.io`
from `90f790763f4f0507d123f325d194d2cf7b9bf73f` to the reviewed fix
`01b18397f9c5356a14e4cc66fa46f57216f11154`, published on
`fix/validate-directory-before-write`. The fix validates both directory and privacy
inputs, including the privacy output path, before any filesystem write. It adds
build regression tests. Its normal parent is the previously approved90f commit.

No build/workflow/vendor exemption is added. The native source guard still requires
that the exact approved baseline is an ancestor of the candidate and that protected
build/verification/workflow bytes match that baseline. Consequently the installed
old source correctly rejects01b's changed build script; the promoted source correctly
rejects old90f main. Under the new source, exact01b and its normal descendants pass,
while changed build or Pages automation and a same-tree squash without01b ancestry
fail. Library source91 and the preview contract pins remain unchanged.

Rollout is explicitly coordinated across the central and directory PRs:

1. Review and merge the central baseline promotion, regenerate central inventory,
   and publish a **new** immutable workflow-source commit; do not move installed92.
2. On owned temporary refs, canary that exact source against01b/descendant positives,
   old90f ancestry rejection and protected-build negatives. Preserve all existing
   source protections and review policies; no bypass or temporary exemption.
3. After canary acceptance, explicitly update the native source publisher/rule's
   selected workflow SHA. Until the directory fix merges, old90f main will not meet
   the new baseline; the fix PR's merge candidate must contain01b and pass the new
   native run. Do not substitute an old workflow green result.
4. Merge the directory fix normally, preserving01b ancestry, after its own required
   checks and reviews. A squash/rebase which removes01b is **not** compatible with
   this pin; it requires a separately reviewed exact-baseline repin instead.

`tests/integration/directory-baseline-transition.test.mjs` exercises those actual
Git snapshots with the existing native source host. Set
`FREEDOM_RUN_DIRECTORY_TRANSITION=1`, absolute `FREEDOM_DIRECTORY_ROOT` (a full
clone containing90f and01b), `FREEDOM_CONSUMER_SOURCE_ROOT` (a separate full clone of
the promoted central source), and `FREEDOM_CONSUMER_WORKFLOW_SHA` (that clone's exact
HEAD), then run `node --test tests/integration/directory-baseline-transition.test.mjs`.
The test derives a separate old-policy checkout at immutable92; it performs no
network/provider writes or candidate script execution.

`repositories.lock.json` is the sole mutable canonical consumer-baseline lock for
this transition. Historical verification JSON and earlier90f receipts remain
historical. Central `2026-09-20-file-inventory.json` must be regenerated after this
commit is integrated using `python3 scripts/update-inventory.py`, then checked with
`npm run verify:inventory`; no preview bundle, consumer library export, or source91
lock regeneration follows from this baseline change. Cross-repository checkout CI
must use a fresh directory because the old90f checkout intentionally no longer
matches the lock.
