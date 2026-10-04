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

Every profile includes the existing manifest, package/toolchain files and actual execution entrypoints. Verification scripts and workflows, plus registered build automation (`scripts/build.mjs`, `scripts/check-registry.mjs`, `examples/preview-campaign.mjs`), must equal approved baseline bytes. Selected package commands and export paths must remain unchanged. Product `src`/domain/test files may change but required entry paths cannot disappear. Their presence does not prove correct behavior; existing CI remains responsible for product tests.

`freedom.project.yaml` is parsed without duplicate keys, bound to the selected repository and baseline identity/ownership/data-boundary/release/toolchain/publication fields, then validated with the existing canonical `scripts/repository-bootstrap/verify-project-manifest.py`. The host uses trusted Python3 plus `jsonschema==4.26.0`. Python runs with `-I` from a separately materialized canonical script; candidate scripts, build commands, Python modules and network checks are not executed. Missing dependencies return unavailable; invalid manifests fail. Both `.tool-versions` and `package-lock.json` are explicit fixed materialization paths, not candidate-selected paths.

Results distinguish `protected_automation` from `entries: required-paths-present`. `library_usage` and `runtime_observation` remain `not_checked`; source checks alone do not grant merge/execution authority or prove installed enforcement. Source-only profile coverage across all nine repositories is not complete behavioral P2 acceptance. A new approved build/profile baseline must be reviewed outside the candidate before protected automation or authority metadata can change.

The source-directory profile follows the independently reviewed `90f790763f4f0507d123f325d194d2cf7b9bf73f` directory baseline: it requires the privacy page source/data/tests and protects `.github/workflows/pages.yml` as existing approved deployment automation. That does not enable deployment or approve new publication. The previous profile was verified against78ce; a candidate cannot silently promote its own90f baseline. The native host must select the updated repository lock approved outside that candidate.
