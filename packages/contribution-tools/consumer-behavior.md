# Isolated consumer HTTP behavior

The existing behavior supervisor now has an executable `consumer` mode for the
three actual adopted entrypoints. Run it from a reviewed, fixed host installation:

```
node packages/contribution-tools/behavior-supervisor.mjs consumer \
  FreeTWAI-AI/freedom-agent-kit /absolute/consumer/checkout EXACT_CANDIDATE_SHA
```

The other fixed repository profiles are `FreeTWAI-AI/freedom-storefront` and
`FreeTWAI-AI/freedom-supplier-client`. The host materializes immutable Git objects,
then imports `/candidate/src/index.mjs` only inside the existing resource-limited,
network-disabled, read-only candidate container. Kit uses its real
`packages/client/index.mjs` PlatformClient. Storefront calls
`loadConnectedStorefront`; supplier calls `loadSupplierWorkspace` with its exported
`ScopedReadClient`. No candidate scripts, imports or callbacks execute in the host.

The fixed container launcher supplies a fetch adapter connected to a host-owned
synthetic HTTP server over one Unix socket. The host independently records actual
methods, paths, matched synthetic credentials, response status and response digest.
Unpredictable per-case values must appear in the returned assembled workspace.
Correct vendor bytes with a stubbed product entrypoint therefore fail: a forged
passing report or patched stdout cannot manufacture the host's missing HTTP trace.
Real requests with corrupted output also fail. All observation data is bound to
the exported candidate commit, tree and content digest, and installed supervisor,
fixture, launcher, protocol and Node runtime hashes.

Kit checks protocol negotiation plus session, dashboard, work, positioning and
guild reads. Storefront checks connection plus catalog/stores/listings; supplier
checks connection plus products/requests. Both read-connection profiles also
receive a wrong-scope connection and a revoked-token HTTP401. They must reject
without subsequent resource reads. These are synthetic **client-handling** cases;
they do not establish the platform server's owner/scope/revocation ACL behavior.
The existing HTTP/PostgreSQL integration tests cover that separate functional path.

`check.status` is the host's bounded behavioral comparison. Successful local
runs report `runtime_observation: host_observed_http`, while top-level status
remains `unavailable` for authoritative publication. `source_integrity`,
`library_usage`, `library_invocation` and `server_authorization` remain
`not_checked`; gate/merge/execution authorization stay false. A candidate could
implement the same externally observed requests without using the shared library.
This runner intentionally makes no internal JavaScript invocation claim. The
existing source gate must independently verify the exact canonical source91 bytes.

## Installation and authority

As of 2026-10-05 01:45 UTC, operator-installed runtime rule `24476100` selects
fixed source `c3e5a537a75303c4688e01b7f0d8477c3587a26f` for the three consumer
mains. Kit requires both workspace and actual CLI observations; the other two
retain workspace profiles. Existing source55/rule24473806 and library91 remain
unchanged. The [installation record](../../docs/platform-plan/execution/unified-foundation/governance-installation-2026-10-04.md)
records actual hosted canaries, main-target probes, merge denials and cleanup.

The native host uses repository/event candidate identity from GitHub contexts and
computes its own source and runtime verdicts. It accepts only complete matching
observations with `check.status: passed` and `cleanup_verified: true`. Never ingest
a report uploaded by candidate CI as the verdict. Missing isolation, unsupported
profiles, bad transport, missing traces or cleanup failure produce a nonzero CLI
result. Later source upgrades require another explicit reviewed pin and hosted
canary. No new App, signature authority or general collector was introduced;
conservative authority/provenance fields are not overwritten by installation.

The portable [consumer runtime recipe](consumer-runtime-recipe.md) selects a
public Debian amd64 manifest plus the exact official Node24.21.0 executable.
Provision it explicitly with `node packages/contribution-tools/consumer-runtime-recipe.mjs prepare`.
The supervisor never pulls implicitly. Consumer mode needs Linux x64, non-root
Node, Git and Docker; it needs neither npm dependencies nor a database container.
The member supervisor retains its separate existing cached-image/dependency profile.

Node is taken from the canonical realpath of the running host interpreter and
mounted as a single read-only `/trusted-node` file. This supports setup-node's
`/opt/hostedtoolcache/.../bin/node` location without mounting its parent directory.
The pinned image supplies all candidate linked libraries: there is **no host
`/usr` mount**. The only binds are `/trusted-node`, `/candidate`, `/target.mjs`
and the private HTTP socket directory `/fixture`. The exact executable, image,
installation and container settings are checked before and after observation.

The installed `.github/workflows/trusted-consumer-runtime.yml` runs its fixed host
entrypoint from the independently selected source commit. Source/workspace and
required CLI evidence must bind the same candidate commit/tree. The recipe records
public input provenance and the GitHub-managed host boundary; code or a successful
local check alone does not establish installation or operator approval.

## Actual agent-kit CLI profile

The additional executable profile exercises the actual approved consumer
`src/cli.mjs`, with the fixed `maker` loopback-demo arguments:

```
node packages/contribution-tools/behavior-supervisor.mjs consumer-cli \
  FreeTWAI-AI/freedom-agent-kit /absolute/consumer/checkout EXACT_CANDIDATE_SHA
```

The host API is `runIsolatedAgentKitCliBehavior` with the same exact
`{repository, candidateRepository, candidateCommit}` inputs as the workspace
runner. Other repositories are rejected for this profile. The existing three
workspace profiles are preserved. The c3e installed host requires this additional
kit CLI profile; the historical c42 host selected workspace observations only.

Only inside the existing candidate container, the installed launcher supplies a
socket-backed fetch adapter and fixed argv, then imports the real CLI. The CLI
must obtain a fresh synthetic session cookie/CSRF from login, perform its five
workspace reads, print the fresh assembled workspace and log out. The host
independently requires eight actual HTTP requests: protocol, login, five reads,
logout. Login must precede reads and logout must follow them, carrying the exact
cookie, Origin and CSRF with an empty JSON body. No session credentials are sent
in the driver command. A stub, omitted logout, forged cookie/CSRF, altered printed
output or forged transport response fails. Cookie/CSRF/body bytes are not retained
in evidence. The demo password is the existing consumer's public synthetic fixture
value; this is not production authentication or server authorization evidence.

This is one fixed maker-role CLI scenario. Reviewer/client roles, CLI error exits,
package aliases, internal library invocation and full
surface coverage remain outside it. The launcher captures output inside the
untrusted container; capture itself is not authenticated proof. The host's actual
HTTP trace and unpredictable response comparison decide the verdict.

The profile is selected by the installed c3e combined host after source/workspace
success. The CLI-only stub now fails that gate even when the original workspace
profile and consumer verify-template pass; actual-main forged-green merge denial
is recorded in the installation report. The [canary plan](consumer-cli-canary.md)
remains a template for separately reviewed future upgrades. The old c42, source55
and library91 publication refs remain immutable. `library_invocation` stays
`not_checked`: equivalent candidate code can reproduce the observed behavior
without invoking the approved workspace module.

## Storefront and supplier read launchers

The combined host source now requires CLI observations for all three consumers.
This source change does not establish that a new workflow pin is installed; the
existing c3e installation described above remains historical deployment evidence.
`runIsolatedConsumerCliBehavior` selects the kit profile or the scoped read profile.
The `consumer-cli` command also accepts storefront and supplier repositories.

For scoped consumers the installed launcher executes the actual
`scripts/run-client.mjs read RESOURCE`, which spawns the actual `client/cli.mjs`.
Both processes stay inside the same network-none, read-only candidate container.
An inherited fixed Node preload redirects fetch to the private Unix socket. The
launcher creates a mode-0600 synthetic credential file in container tmpfs, removes
it after each subprocess exits, and bounds combined stdout/stderr. Real credentials,
network services and candidate code on the host are never used.

Each resource gets a fresh unpredictable response: storefront connection, catalog,
stores and listings; supplier connection, products and requests. The host requires
exactly the expected authenticated request and deep-compares parsed CLI stdout to
its fresh response. Three additional cases require a nonzero exit and empty stdout:
a wrong-scope saved credential (no HTTP), a revoked connection (HTTP 401), and a
server error (HTTP 503). Signal termination of the directly supervised `scripts/run-client.mjs` launcher
does not count as a correct error exit. The launcher can translate a nested CLI
signal or exception into a nonzero exit; this check does not distinguish the
nested failure cause or prove a particular error-handling implementation.
Reports retain HTTP status/path/digests, not synthetic tokens, credential files or
stderr. Tests replace both launcher and CLI while keeping source/vendor/workspace
valid, proving the old source/workspace gate would pass and the new CLI gate fails.
They also reject real requests paired with forged output or swallowed errors.

This covers read commands only. Pairing, package-script aliases, default arguments,
all local-file error conditions and internal library invocation remain unverified.
`library_invocation` and server authorization remain `not_checked`; equivalent code
can reproduce the observed behavior. Cleanup is independently checked by the
existing supervisor before any passing verdict is accepted.

## Validation

```
node --test packages/contribution-tools/test/behavior-supervisor.test.mjs
FREEDOM_RUN_ISOLATED_CONSUMERS=1 \
FREEDOM_CONSUMER_RUNTIME_ROOT=/absolute/three-consumer-repositories \
node --import tsx --test --test-concurrency=1 tests/integration/consumer-behavior-supervisor.test.ts
```

The integration tests select the three actual merged consumer SHAs explicitly,
not mutable HEAD. They cover real authorized/scoped/revoked behavior, a stub in
each entrypoint with unchanged vendor/lock bytes, stdout forgery, corrupted
challenge output, swallowed scope/revocation failures, read-only/network isolation
and an interpreter copied outside `/usr` to exercise the hosted toolcache layout.
Every run removes only its randomly labeled containers and private snapshots.
