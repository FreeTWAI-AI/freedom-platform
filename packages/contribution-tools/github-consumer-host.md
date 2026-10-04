# Native adopted-consumer source gate

`.github/workflows/trusted-consumer-libraries.yml` uses existing GitHub-hosted
Actions and the native organization required-workflow rule. It needs no new App,
signed-job gateway, self-hosted runner, private key, Docker, npm install or database.
It runs only fixed central verifier code and reads candidate Git objects as data.
It does not run or import candidate tests, scripts, workflows or libraries.

The current admission profiles are **agent-kit, storefront and supplier-client only**. A successful
job proves exact shared-library source integrity and unchanged preview-v1 bytes;
`library_usage` and `runtime_observation` remain `not_checked`. It cannot certify
actual invocation, authorization behavior, discovered runtime routes, all nine
consumers or full P2. The central repository explicitly skips this consumer job
and retains its existing central verification workflow.

## Concrete installation sequence

1. Merge/publish the reviewed shared library source and the existing
   `consumer-libraries.mjs` verifier. Record the exact publicly reachable source
   commit. Re-export/repoint all three consumer source locks and bytes against that
   approved commit using the existing consumer exporter. A cherry-pick SHA is
   different from its original local source SHA.
2. Replace `REQUIRED_APPROVED_REACHABLE_SOURCE_SHA` in the new workflow with that
   exact source commit. The invalid placeholder deliberately fails before reading
   candidate code; it is not a deployable approval value. Review this workflow
   and host code together, publish their final central commit, and pin that exact
   workflow revision in the existing native org required-workflow rule for only
   `FreeTWAI-AI/freedom-agent-kit`, `FreeTWAI-AI/freedom-storefront` and `FreeTWAI-AI/freedom-supplier-client`. Preserve
   their other required checks/reviews. The library source and workflow commits
   may differ; neither comes from a candidate lock or repository variable.
3. The workflow checks out its own source using `job.workflow_sha`, then checks
   out the event's exact `github.sha`, with full history and no persisted checkout
   credentials. The source checkout's committed `repositories.lock.json` is the
   **approved baseline source**, independently selected by the fixed workflow
   revision. Current baselines are kit `201fdab8017e2850bafc7b2f1e8dec7e4c0d6233`,
   storefront `9823df79f8eee86008c269437880ed2e49bdc394` and supplier-client
   `53fd5b0ac4a1b67ccd71a8cc4ba092ea15bb3534`. The host requires each
   candidate to descend from its baseline, and compares every preview lock/vendor
   object and file mode exactly against that baseline. Missing history, added or
   removed preview files, extra libraries or rewritten candidate lock+library
   fail closed. Later approved preview changes require a separately reviewed
   baseline update; a candidate cannot approve its own new baseline.
4. Run genuine positive consumer PRs, negative library+lock rewrite PRs and
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

The new runtime-surface/library collectors were not available when this increment
was written. No candidate-produced collector artifact is consumed. When available,
invoke reviewed collector code from this same trusted checkout with the immutable
candidate commit/tree and an explicit supported profile. Candidate execution for
runtime observations needs an independent isolated process with bounded protocol
and no host writes/credentials. Missing/unknown coverage must block that separate
runtime gate. Do not promote this source gate's successful conclusion into runtime
observation, or execute a candidate import in the verifier process.

## Tests

`node --test packages/contribution-tools/test/github-consumer-host.test.mjs`
uses real local Git objects and verifies all three supported profiles, forged
lock+library bytes, fake passing artifacts, candidate test replacements, unchanged
preview baseline, extra libraries, symlinks, graph overrides, unavailable source
pins and native CLI identity/event handling. Expected library content contains a
throw to prove it is read rather than imported. Dirty working-tree bytes are
ignored in favor of the selected committed candidate.
