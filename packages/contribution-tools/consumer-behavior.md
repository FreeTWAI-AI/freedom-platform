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

The existing immutable cached base image must be installed deliberately:
`sha256:88200866dfff7ea7f5cbcb6ec7c8a701889efe6fe859fe64d6990e4b07ea4171`.
The runner never pulls an image implicitly. Required host facilities are Linux,
non-root Node24+, Docker control and the existing supervisor's trusted installed
dependencies. Consumer mode needs no database container or candidate node_modules.
The current image/local host OS are still unapproved supply-chain identities in
the report; provision and approve an immutable host/image recipe before claiming
installed runtime trust. Do not mount Docker socket, credentials, the host checkout
or a writable shared cache into the candidate.

Node is taken from the canonical realpath of the running trusted interpreter and
mounted as a single read-only `/trusted-node` file. This supports setup-node's
`/opt/hostedtoolcache/.../bin/node` location without mounting its parent directory.
The existing `/usr` read-only mount supplies the explicitly hashed linked library
paths. The interpreter must be a bounded regular executable; its bytes and the
installation are checked before and after observations. The existing member
supervisor's `/usr/bin/node` profile is unchanged. A different host ABI/layout
needs an explicitly validated runtime recipe; absence fails closed.

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
