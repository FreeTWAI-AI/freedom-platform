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

This is a working local runtime increment, not a change to installed source rule
24473806 or its source55 workflow. A subsequent native required workflow must
separately pin the reviewed runner source, supply repository and exact event
candidate SHA from host contexts, run the independent source guard, and invoke
this runner itself. It must accept only the process exit status and its own
host-generated result with `check.status: passed` and `cleanup_verified: true`.
Never ingest a report uploaded by candidate CI as the host verdict. Missing
isolation, unsupported profiles, bad transport, missing traces or cleanup failure
produce a nonzero CLI result. Hosted positive/negative canaries remain necessary
before adding a native runtime rule. No new App, signature authority or general
collector is introduced.

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

The new `.github/workflows/trusted-consumer-runtime.yml` is a canary candidate.
Its host wrapper computes both the existing source check and this runtime check
for the same Git commit/tree. It uses no candidate verdict. The recipe documents
public provenance, remaining host approval boundaries and the required hosted
canaries; creating this workflow does not install or approve it.

## Actual agent-kit CLI candidate profile

A separate executable profile now exercises the actual approved consumer
`src/cli.mjs`, with the fixed `maker` loopback-demo arguments:

```
node packages/contribution-tools/behavior-supervisor.mjs consumer-cli \
  FreeTWAI-AI/freedom-agent-kit /absolute/consumer/checkout EXACT_CANDIDATE_SHA
```

The host API is `runIsolatedAgentKitCliBehavior` with the same exact
`{repository, candidateRepository, candidateCommit}` inputs as the workspace
runner. Other repositories are rejected for this profile. The existing three
workspace profiles and native c42 workflow remain unchanged in selection.

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
other consumers' launchers, package aliases, internal library invocation and full
surface coverage remain outside it. The launcher captures output inside the
untrusted container; capture itself is not authenticated proof. The host's actual
HTTP trace and unpredictable response comparison decide the verdict.

The new profile is executable locally but is **not selected by the installed c42
native workflow**. Installation requires a separately reviewed wrapper/workflow
that runs both source/workspace and CLI verdicts for the same commit/tree, followed
by a new immutable source pin and actual hosted CLI positive/stub-negative canaries.
Do not change c42/source55/library91 in place. No current rules or workflow YAML
are changed by this increment. `library_invocation` stays `not_checked`: candidate
JavaScript can reproduce the externally observed behavior without using the
approved workspace module.

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
