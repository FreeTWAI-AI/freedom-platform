# Remaining P2 boundaries after the c42 consumer runtime increment

Assessment reference: fixed source
`c42df49e3ee93beed95eeda463a3c7811772b3c5`, library source91 and the existing
source55 gate. This document does not change either installed workflow or certify
full P2. Rule installation and actual merge-denial receipts are operator evidence;
the source report deliberately does not invent that evidence.

## What the bounded gate establishes

The fixed native workflow computes canonical source integrity and observes the
three reviewed `src/index.mjs` workspace exports inside the existing isolated
container. Host HTTP traces and unpredictable response values defeat a stubbed
workspace or fabricated candidate passing report. The public native job logs also
bind the GitHub merge candidate/tree, fixed source, exact image/Node recipe and
cleanup. GitHub-managed Ubuntu24, kernel and Docker are the accepted operator host
boundary, not immutable host artifacts or a newly installed App publisher.

## Two executable limits

`tests/integration/native-consumer-runtime.test.ts` now includes these deliberate
source-valid mutations against the actual merged agent-kit snapshot:

| Mutation | Existing source and HTTP result | What remains unproven |
| --- | --- | --- |
| Replace `src/index.mjs` with a direct implementation that calls the same five client operations and assembles their fresh results; never import the approved workspace library | Both pass, six independently observed requests including protocol negotiation | Actual invocation of the approved workspace module |
| Replace actual user-facing `src/cli.mjs` with a constant-output stub; leave `src/index.mjs` intact | Both pass; evidence still names only `src/index.mjs#loadMemberWorkspace` | CLI execution and end-to-end user entrance coverage |

Both tests require unchanged vendor/lock bytes and confirmed cleanup. These are
positive assertions of the limited observation contract, not negatives being
mistakenly accepted as complete governance. Removing `library_invocation:
not_checked` or describing the workspace profile as the real CLI gate would be
incorrect. Instrumenting a candidate-owned Node loader/function or accepting its
reported calls cannot resolve this distinction. A candidate can bypass or imitate
that instrumentation, or invoke a library as a decoy while producing its own
behavior. File-open/module-digest evidence proves bytes were read, not semantic use.

## Concrete remaining gaps

| Area | Current evidence | Remaining requirement |
| --- | --- | --- |
| Shared library use | Canonical approved bytes plus bounded HTTP behavior | Actual resolution/import/operation boundaries, approved exceptions and adversarial direct-platform-fetch checks required by GOV-04; no broad invocation claim |
| Three adopted consumers | One workspace export each; storefront/supplier wrong-scope and revoked-response handling | Kit `src/cli.mjs`; storefront/supplier `scripts/run-client.mjs` → `client/cli.mjs`; package export aliases; build output and newly introduced entries |
| Other six source profiles | Approved manifest/preview/protected automation bytes and required paths | Actual runtime behavior for each real profile; path presence is not invocation |
| Central entry registration | Existing local fixed member harness and limited syntax audit | Actual HTTP/page/queue/scheduled/MCP/native registration coverage and conservative unknown-entry handling; no new standalone scanner is connected here |
| Native workflow provenance | Fixed source and exact event candidate in GitHub-owned workflow execution | Actual merge-queue/fork/supersession canaries and retained service readbacks; the existence of a `merge_group` trigger is not that evidence |
| Detached publisher product | Existing verifier/App/supervisor/durable publisher implementations and local tests | Operator installation, authenticated event source, protected single-writer journal, exact run/attempt binding, remote reconciliation/unknown-ACK/crash/replay acceptance if that separate publication product is required |

The governance specification explicitly permits native required workflows when
available; a new App is not necessary for this installed bounded gate. Native job
results must not be relabeled as detached signed ReleaseSet provenance. Likewise,
feeding their JSON into the existing App publisher would not establish its
independent authentication or durable ordering. The current P2 delivery plan's
App/replay acceptance rows still need either their actual evidence or an explicitly
reviewed native-equivalent acceptance definition; do not silently mark them done.

## Smallest next behavior improvement

The subsequent local candidate now implements this step as
`runIsolatedAgentKitCliBehavior` / `behavior-supervisor.mjs consumer-cli`; see the
[CLI profile instructions](consumer-behavior.md#actual-agent-kit-cli-candidate-profile).
The c42 native workflow still selects only the original workspace profile. The
new candidate does not alter any of the c42 limits reproduced above.

Extend the **existing isolated consumer supervisor** to the actual agent-kit CLI
as one separately reviewed profile. The real CLI performs demo login, workspace
reads and logout, so the host fixture must support those exact synthetic protocol,
login/session/CSRF/logout interactions and fresh values. Run the actual CLI only
inside the same constrained container; derive its argv and synthetic environment
from the fixed host. Independently observe HTTP requests and validate assembled
output, rather than trusting CLI exit0/stdout. Reject the existing constant-output
CLI mutation while preserving the real merged CLI positive. Keep internal library
invocation and platform-server ACL claims `not_checked`.

This adds a real entrance to the existing runner rather than introducing a
collector. It necessarily changes the reviewed harness/workflow source and must
receive a new immutable source pin and separate hosted positive/negative canaries
before any installed rule changes. It is therefore not smuggled into c42 as part
of this assessment. The two regression reproductions above are the immediate code
improvement: they make current claim limits testable without weakening a gate or
shipping an unused runtime subsystem.

References: [governance specification, shared-library and native-workflow sections](../../docs/platform-plan/execution/unified-foundation/01-contracts-and-governance.md),
[GOV-04/05/06/13/14 acceptance rows](../../docs/platform-plan/execution/unified-foundation/acceptance.md),
[P2 delivery requirements](../../docs/platform-plan/execution/unified-foundation/post-migration-plan-2026-10-04.md),
and the [portable runtime recipe](consumer-runtime-recipe.md).
