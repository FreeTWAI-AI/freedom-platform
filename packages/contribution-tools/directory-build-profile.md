# Directory build profile

This P2 increment extends the existing fixed native runtime host to
`FreeTWAI-AI/FreeTWAI-AI.github.io`. The source prerequisite still checks approved
01b ancestry, immutable build/Pages automation, preview bytes, manifests and
executable registrations. Directory data and product renderers are then exercised
through the actual `scripts/build.mjs` entry, with no candidate tests or reports.

The host checks ten cases: current data, fresh text/HTML-escaping challenges, an
empty directory, duplicate repositories, invalid directory schema, invalid
privacy sections, traversal/absolute/encoded paths and malformed privacy JSON.
Successful cases require both exact expected pages; normal rejection requires
exit 1 and an unchanged input tree with no output directories or files. A timeout,
transport error, incomplete readback or cleanup failure is unavailable and fails
the combined gate. Current privacy data must retain `privacy/discord-bot/`, the
destination of the directory footer link.

Each case uses the existing pinned Debian/Node recipe, network-none, nonroot UID,
read-only root and source binds, dropped capabilities, no-new-privileges and
bounded memory/CPU/PIDs/descriptors. A separately owned Docker local volume uses
tmpfs with a 32 MiB ceiling; it is not a writable host source directory. The host
checks actual container and volume settings before/after the build, pauses all
container processes, and obtains the complete working tree through Docker's
archive API. A trusted Python standard-library reader never extracts anything:
it rejects links, special files, duplicate/traversal paths and size/count overflow,
then hashes regular files. The host compares every source/output hash and directory.
Output bytes and candidate stdout never supply a verdict. Unknown create outcomes
remain unverified even if a later empty listing is observed. Containers and volumes
are removed only with this invocation's unique ownership label.

Docker's archive API did not expose a directly mounted container tmpfs during the
initial local attempt. That attempt failed closed and cleaned up. The explicitly
named tmpfs volume allows daemon readback while every candidate process is paused;
both its memory bound and exact ownership are checked.

`directory-reference/` preserves the reviewed directory's 01b renderers as fixed
host reference code (original FreeTWAI-AI authorship). The candidate never supplies
these functions. Exact byte comparisons deliberately freeze this limited rendering
contract, including markup/styles. Data text can evolve, but a legitimate visual
redesign needs a separately reviewed reference/profile update. This is a bounded
build contract, not a general HTML sanitizer, browser acceptance or proof of internal
library invocation; vulnerabilities shared with the reviewed reference are not
independently eliminated. The observation covers the working tree, not every
temporary scratch write or every possible input. There is no Pages publication or
broader library/server/merge-queue acceptance implied by a local pass.

Run `node --test packages/contribution-tools/test/directory-build.test.mjs` for the
bounded archive reader. Full integration needs separate full Git clones, Docker,
the exact runtime recipe and the source validator's fixed jsonschema dependency:

```sh
FREEDOM_RUN_DIRECTORY_RUNTIME=1 \
FREEDOM_DIRECTORY_ROOT=/absolute/directory-clone \
FREEDOM_CONSUMER_SOURCE_ROOT=/absolute/source-clone \
FREEDOM_CONSUMER_WORKFLOW_SHA=<source-clone-HEAD> \
node --test --test-concurrency=1 tests/integration/directory-runtime.test.mjs
```

The candidate CI workflow runs ten integration tests against approved Git ancestry:
valid builds/data edits and source-valid constant output, escaping removal,
duplicate-validation removal, early writes, extra files, route drift, symlink and
hang counterexamples. It is diagnostic. Existing installed rules remain pinned
to their previously reviewed sources: source rule24473806 at a254 and three-consumer
runtime rule24476100 at92. Installation requires review of this source, a new fixed
source ref, hosted temporary-ref positives/negatives and actual merge-denial
evidence before adding a directory-only runtime rule. Do not broaden the three-repo
rule blindly or move an installed immutable source ref.
