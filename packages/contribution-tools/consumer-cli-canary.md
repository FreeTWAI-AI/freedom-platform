# Actual CLI enforcement: hosted canary template

Initial execution is complete: operator-installed rule24476100 now selects
`c3e5a537a75303c4688e01b7f0d8477c3587a26f`. Three temporary positives merged and
CLI-only negatives were denied on both a temporary base and actual kit main;
owned probes were cleaned. See the [installation record](../../docs/platform-plan/execution/unified-foundation/governance-installation-2026-10-04.md).
The procedure below is a reusable template for a subsequent reviewed source;
it does not replace the recorded receipts or authorize another installation.

The `github-consumer-runtime-host.mjs` requires source integrity,
workspace observation **and actual CLI observation** for agent-kit. It runs the CLI
only after source/workspace success, and accepts only its own same-commit/tree
observation with the fixed `src/cli.mjs#maker` entry, one complete case and verified
cleanup. Storefront and supplier retain their existing workspace profiles.

The existing workflow YAML invokes this same host entrypoint, so it needs no
command changes. A **new reviewed immutable source commit** must be published and
selected explicitly. This document/template does not modify installed runtime
rule24476100, source55/rule24473806, library91 or central24469536.

## Review inputs and template

Fill the deliberately invalid SHA placeholder in
[`consumer-cli-canary-ruleset.example.json`](consumer-cli-canary-ruleset.example.json)
with the full reviewed central commit. Confirm its selected source branch resolves
to that exact SHA and the full checkout contains library91 and approved baseline
objects. Do not move or rewrite the c42/source55/library91 publication refs.

The template is one temporary native required-workflow rule, limited to the three
adopted repository IDs and exact owned `ops/consumer-cli-canary/base` refs. It
contains no main target, bypass actor, wildcard or replacement policy. If that
owned ref/name already exists, stop and inspect rather than overwriting it. Root
owns all publication/API operations and a separate intent/readback/cleanup journal.

## Four bounded PR probes

Create the temporary base in each repository from its independently read and
approved current main SHA; record exact main/base/head/tree values. Preserve full
history. Create one docs-only positive head per base. For agent-kit additionally
create a negative head changing **only** `src/cli.mjs` to:

```js
console.log(JSON.stringify({status: 'passed'}));
```

Preserve `src/index.mjs`, the canonical vendor trees and all locks byte-for-byte.
Keep the negative as a sibling of the docs-positive head, not its descendant.
The negative must therefore pass source and the original workspace profile while
failing the newly required actual CLI observation.

A PR create body uses these exact fields after filling repository-specific titles:

```json
{
  "title": "Actual CLI canary: positive or deliberate CLI stub",
  "head": "ops/consumer-cli-canary/positive-or-negative",
  "base": "ops/consumer-cli-canary/base",
  "body": "Owned temporary probe. Fixed reviewed central source SHA; preserve main."
}
```

Before creation, root pushes only the journaled temporary refs and reads them back,
then installs/reads back the reviewed temporary rule. No force push, fake review or
policy bypass is part of this plan. Existing policies continue to apply.

## Required hosted evidence

All four runs must show the newly selected `job.workflow_sha`, central workflow
repository/path, independently selected merge-candidate SHA/tree, Ubuntu24 recipe
check, fixed public image and exact Node identity. A run from old c42 is not evidence
for the new CLI requirement. Neither a candidate report nor a same-name classic
status supplies these observations.

| Probe | Required host result |
| --- | --- |
| Kit positive | `status=passed`, source/workspace passed, `cli_required=true`, `cli_runtime.check.status=passed`, CLI entry exact, eight requests including CSRF logout, same candidate commit/tree and both cleanups verified |
| Storefront and supplier positives | `status=passed`, source/workspace passed, `cli_required=false`, `cli_runtime=null`, original bounded cases and cleanup verified |
| Kit CLI stub | Source/workspace passed; `status=failed`, `failure={stage:cli,kind:behavior_mismatch}`, CLI `consumer_behavior_mismatch`, zero CLI requests, cleanup verified, process exit1 |

`failure.kind=unavailable` identifies an absent/rejected runtime prerequisite or
invalid observation. It always blocks the gate, but **cannot count as the intended
behavioral negative proof**. A source failure, missing image, setup error, timeout
or unrelated candidate test failure likewise does not satisfy the CLI-stub canary.

After observing the intended negative, root may add a same-name green classic
status and attempt the exact-head-guarded negative merge. Require a native-workflow
denial. Positives may merge only into owned temporary bases where existing rules
allow it; no scratch documentation goes into main. Record actual API receipts.

Close remaining owned PRs, delete only the journaled temporary rule/refs and verify
absence. Read main SHAs and existing rules unchanged. Only after these results may
root review a separate main-rule revision to the new source, preserving the three
repository/main conditions, all9 source gate, central rule and review policies.
Follow that explicit installation with one actual-main docs positive (close without
merge) and CLI-stub negative (guarded merge denied); clean their owned refs/PRs.

## Claims retained

This increment enforces actual maker-demo CLI HTTP behavior, not general library
invocation, production login, server ACL correctness, all CLI roles or all entries.
An inline equivalent workspace implementation still passes; both workspace and CLI
reports keep `library_invocation=not_checked`. Native provenance rests on the
operator-accepted GitHub managed host plus fixed source/image/Node inputs. There is
no new App publisher, immutable kernel claim, automatic installation or full P2
acceptance in this candidate.
