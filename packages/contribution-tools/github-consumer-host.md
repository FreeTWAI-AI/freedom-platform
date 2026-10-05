# Native nine-consumer source gate

`.github/workflows/trusted-consumer-libraries.yml` uses existing GitHub-hosted
Actions and the native organization required-workflow rule. It needs no new App,
signed-job gateway, self-hosted runner, private key, Docker, npm install or database.
It runs only fixed central verifier code and reads candidate Git objects as data.
It does not run or import candidate tests, scripts, workflows or libraries.

The fixed profiles admit **all nine consumers**. Agent-kit, storefront and
supplier-client verify exact adopted shared-library bytes plus unchanged preview-v1
bytes. The other six use `consumer-source-profiles.mjs`: `.github`,
`FreeTWAI-AI.github.io`, growth-automation, project-page, project-template and
skill-registry verify canonical preview bytes, the full manifest schema and
approved manifest authority fields. They freeze build/verification automation
against the approved baseline and require the known product entry paths to exist.
Product source remains editable under ordinary CI; its presence is not behavior
proof. Reports distinguish `protected_automation` from `entries: required-paths-present`.
Both groups leave `library_usage` and `runtime_observation` as `not_checked`.
This gate cannot certify actual invocation, authorization behavior, discovered
runtime routes or full P2. The central repository explicitly skips this consumer job
and retains its existing central verification workflow.

## Concrete installation sequence

1. Merge/publish the reviewed shared library source and the existing
   `consumer-libraries.mjs` verifier and six-profile `consumer-source-profiles.mjs`
   helper. Record the exact publicly reachable library/canonical source
   commit. Re-export/repoint all three consumer source locks and bytes against that
   approved commit using the existing consumer exporter. A cherry-pick SHA is
   different from its original local source SHA.
2. Replace `REQUIRED_APPROVED_REACHABLE_SOURCE_SHA` in the new workflow with that
   exact source commit. The invalid placeholder deliberately fails before reading
   candidate code; it is not a deployable approval value. Review this workflow
   and host code together, publish their final central commit, and pin that exact
   workflow revision in the existing native org required-workflow rule for the
   nine repositories listed above. Preserve their other required checks/reviews.
   The six manifest profiles also need the workflow's fixed host Python 3.13 and
   `jsonschema==4.26.0` installation; dependency/validator failure cannot pass.
   The library source and workflow commits
   may differ; neither comes from a candidate lock or repository variable.
3. The workflow checks out its own source using `job.workflow_sha`, then checks
   out the event's exact `github.sha`, with full history and no persisted checkout
   credentials. The source checkout's committed `repositories.lock.json` is the
   **approved baseline source**, independently selected by the fixed workflow
   revision. Installation must include the separately approved directory baseline
   `90f790763f4f0507d123f325d194d2cf7b9bf73f`, whose profile includes the privacy
   page sources and protects its Pages workflow. Other baselines remain selected
   by that same reviewed lock, never by the candidate. The host requires each
   candidate to descend from its baseline, and compares every preview lock/vendor
   object and file mode exactly against that baseline. Missing history, added or
   removed preview files, extra libraries or rewritten candidate lock+library
   fail closed. Later approved preview changes require a separately reviewed
   baseline update; a candidate cannot approve its own new baseline. The full
   Python manifest validator and preview schemas come from the operator-selected
   canonical source commit. Python runs with `-I` against a private, fixed-path
   snapshot, without candidate modules on its import path.
4. Run genuine positive consumer PRs, negative library+lock rewrite PRs,
   protected build/verification script and manifest-authority rewrite PRs, and
   merge-group candidates. Read back required-workflow rules and exact candidate
   conclusions before claiming installed enforcement. Live verification is the
   operator's remaining step, not established by local tests.

GitHub documents `job.workflow_sha`, `job.workflow_repository` and
`job.workflow_file_path` as the source identity of the current job, including
checkout of co-located workflow code. They are used only in permitted step
contexts; these properties are not supported on GitHub Enterprise Server.
See [GitHub workflow context reference](https://docs.github.com/en/actions/reference/workflows-and-actions/contexts#job-context).
The workflow targets the existing Enterprise Cloud installation. Missing context
values or wrong source checkout fail; they are never replaced with the candidate
SHA. Ruleset pinning supplies the trust boundary; same-name candidate workflows
or locally spoofed environment variables do not install that boundary.

## Collector integration boundary

No candidate-produced collector artifact is consumed. For a later runtime gate,
invoke reviewed collector code from this same trusted checkout with the immutable
candidate commit/tree and an explicit supported profile. Candidate execution for
runtime observations needs an independent isolated process with bounded protocol
and no host writes/credentials. Missing/unknown coverage must block that separate
runtime gate. Do not promote this source gate's successful conclusion into runtime
observation, or execute a candidate import in the verifier process.

## Tests

`node --test packages/contribution-tools/test/github-consumer-host.test.mjs packages/contribution-tools/test/github-consumer-profiles.test.mjs`
requires host Python with jsonschema and uses real local Git objects. It verifies
all nine profiles, forged
lock+library bytes, fake passing artifacts, candidate test replacements, unchanged
preview baseline, extra libraries, symlinks, graph overrides, unavailable source
pins and native CLI identity/event handling. Expected library content contains a
throw to prove it is read rather than imported. Dirty working-tree bytes are
ignored in favor of the selected committed candidate. Additional six-profile
cases prove ordinary product edits can pass while protected automation changes,
missing required paths, invalid manifests, authority changes and forged canonical
source fail. Candidate passing artifacts and candidate-owned baseline files
cannot authorize any of these changes.

## Explicit executable registrations

The source host additionally applies `consumer-entry-coverage.mjs` to the complete
candidate and approved-baseline Git inventories for all nine consumers. It compares
every root/nested package manifest's non-descriptive metadata, including every
script and lifecycle hook, bin/main/module/browser/exports/imports, workspaces,
dependencies and unknown future fields. Only version, description, keywords,
authorship, license, repository/contact and funding metadata may change freely.
New/removed package manifests, known workflow/hook/launcher configuration files,
implicit Node/npm entry files and executable-mode registrations fail closed;
existing launcher configurations must retain their approved bytes. An entry change
requires a separately reviewed host baseline, never a candidate-owned approval.

The nine locked baselines each have one root package manifest. This includes kit's
`status` command, storefront/supplier `connect` and `read`, their export aliases,
and the existing six profiles' build/test/preview/dev commands. Product source
and existing executable target contents remain editable. The report calls this
`explicit-package-registrations-and-known-launcher-files`; it does **not** discover
arbitrary HTTP/queue/MCP registration inside source, certify dynamically generated
entries, or establish imports, internal invocation or GOV-04/05 completion.
`runtime_entry_discovery` and `library_invocation` remain `not_checked`.

The standalone library-byte verifier still checks only canonical library bytes;
this registration boundary belongs to the native host with its independently
selected baseline and complete Git inventory. The six-profile helper also compares
root package metadata, but cannot claim complete inventory coverage by itself.
No installed workflow/rule or external acceptance follows from this local change.
