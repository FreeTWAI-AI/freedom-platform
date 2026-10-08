# PR #193 bounded integration, 2026-10-08

Source: [Hao's PR #193](https://github.com/FreeTWAI-AI/freedom-platform/pull/193),
`1c7bb9bcefb398bd612de2ed83d07136754475f3`. Integration base:
`59cfe68c8aef44582a601dfd7ea43faa87747f34`. Preserve the source author's work and
frozen feature scope. This candidate is prepared on a separate branch; the
original fork branch is not overwritten.

## Bounded changes

- A successful bulk-read acknowledgement still emits the two existing inbox
  events after Messages unmounts, provided the client session generation is
  unchanged. Local error/busy state retains its mount and session guards.
- The existing channel palette case waits for the rendered mobile Back/resume
  control before returning to the list and opening navigation. Its assertions,
  per-case timeout, worker count and retry policy remain unchanged.
- Main's password-reset session result, selected-cookie protections, public
  discovery, tenant isolation, instance permissions and unfinished-work behavior
  remain present. Login conflict resolution composes discovery with the existing
  language/install/entry controls and lazy module imports.
- The two unpublished PR migrations are provisionally renamed 132 and 133.
  Every SQL file from main and both original PR SQL bodies remain byte-identical.
  Manifest, release frontier, digest fixtures and source inventory are updated.
  The catalog has 132 SQL files, gap 22, ledger digest
  `d1db21c11eaa60dfad34713fb6f7da882d55c74b503150f795f344cc1cedaaaa`.
  Publication/merge must recheck the current catalog and other work in flight.

## Existing CI evidence and its limits

[Run 37649045291](https://github.com/FreeTWAI-AI/freedom-platform/actions/runs/37649045291)
used the same merged checkout `723840294e47dacd9f70c445ac499ca5b84aa7aa`
in both attempts. Attempt 1 completed 622 default cases, one palette-case
failure and 12 expected skips in 26.5 minutes. Attempt 2 printed all 623 eligible
cases passing and 12 expected skips, then exhausted the fixed 30-minute process
budget before its final teardown/summary. Neither failure completed all three
UI passes.

Across 622 common passing cases, printed durations total 1484.416 seconds in
attempt 1 and 1772.389 seconds in attempt 2, despite identical source. Against
[last green run 37642195140](https://github.com/FreeTWAI-AI/freedom-platform/actions/runs/37642195140),
the same 608 cases total 1743.234 versus 1755.970 seconds (+0.73%); the 15 added
feedback cases total 22.219 seconds. These observations show a tight budget and
runner variance. They do not establish a 25% product performance regression or
justify speculative product optimizations. The integrated candidate still needs
fresh hosted CI. No timeout, suite selection or security gate is weakened here.

## Local validation

- TypeScript no-emit: passed
- Portal build: passed, using cached dependencies matching the lock's React
  19.3.0, Vite 8.3.0 and TypeScript 7.0.2 versions
- Cloudflare deployment/release unit tests: 458 passed, zero failures/skips
- Portal client recovery and work-result client: 36 passed, zero failures/skips
- Social task/share and portal benchmark unit tests: 27 passed, zero failures/skips
- Guild-launchpad specification/status check: zero failures; observed deployment
  and applied-migration facts are unchanged
- Source inventory and local Markdown links: checked after final edits
- Context retains `surface_unmapped` and full fallback; no descriptor exception
  or reduced test selection is introduced

The full DB-backed runtime and browser suites have not run locally: this runner
has no disposable PostgreSQL binary/container. An attempted chat-content suite
failed at local database setup (`ECONNREFUSED`), not at a product assertion.
The separate actual-component browser harness could be built but Chromium could
not create its process-singleton socket; its six old/new cases are NOT_RUN.
Governance device fixtures also encounter prohibited local socket creation.
Contracts pytest is unavailable because pytest is not installed. These are
explicit gaps to be covered by exact-candidate hosted CI, not local passes.

No live database, provider credentials, deployment, production flag or acceptance
status was changed. Local evidence does not replace independent review or the
required hosted checks for the exact candidate.
