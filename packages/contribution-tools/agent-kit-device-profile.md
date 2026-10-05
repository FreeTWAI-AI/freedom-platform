# Agent Kit bootstrap CLI runtime profile

This candidate profile attests only `node src/device-cli.mjs HTTPS_ORIGIN
ENVIRONMENT CLIENT_ID`. Kit has no bundler: its build syntax-checks native ESM,
and the isolated runtime executes that actual ESM entry. Pairing creates a
bootstrap-status connection, not an ExecutionGrant. No model, Work/Attempt,
private Result, durable reconnect, MCP, native bridge or general execution claim
follows from this profile.

## Why invocation is bounded but meaningful

The source host independently compares the generated seven-line launcher, shared
`machine-device-cli.mjs` command and `machine-device-client.mjs` to a fixed producer
commit. Their relative imports form a closed command path with only Node's
`node:url` builtin and the SDK's standard globals. The real launcher supplies no
candidate callback, fetch port, factory or module name. Other product code is
editable and is not imported by this entry. The command's exported test injection
port is not used by its real CLI. The host rejects unused imports, dead calls plus
handwritten requests, private same-shape clients, changed shared bytes, package
aliases/registrations, nested package scopes and additional preloads. This is an
explicit versioned execution adapter, not a claim that HTTP traces or candidate
coverage reveal arbitrary JavaScript call provenance.

The runtime independently materializes the exact Git candidate into a read-only
mount, validates the closed command again against the host-selected producer,
starts a fixed Node subprocess with fixed arguments and a small fresh environment,
and checks snapshot/installation bytes after every scenario. No candidate
`NODE_OPTIONS`, `NODE_PATH`, npm hook, executable, build callback or dependency tree
runs. The one preload is fixed host transport code included in the supervisor
installation digest. Other Kit workspace/demo CLI gates remain prerequisites and
retain `library_invocation=not_checked`; only `device_library_invocation` can be
`closed_canonical_cli_observed`.

## Host observations and limits

The existing fixed Docker recipe supplies non-root execution, no external network,
read-only mounts, resource limits, fixed Node bytes, container inspection and
owned-container cleanup. No platform DB or production secret is needed.

The fixed host service receives real request bytes over its mounted Unix socket.
Its responses and per-case credentials are random. It verifies P-256 signatures,
exact DPoP typ/purpose/client/environment/method/HTTPS URI/body bindings, fresh jti,
pairing challenge/enrollment proof, refresh rotation, access-token hash and
one-use nonce/handle sequence. It checks public-only JSON against its own fresh
challenge; candidate stdout cannot declare a verdict. Counts/order detect repeat
exchange/refresh after an unknown outcome. Cases include two supported origin /
environment / client configurations, denied pairing, foreign challenge, lost
exchange and refresh responses, synthetic revocation, SIGINT and insecure origin.
A SIGINT may race the first safe poll: either one or two total requests is valid;
no enrollment, refresh or status may follow cancellation.

The SDK still requires HTTPS. The host preload preserves the signed original
HTTPS URI, request controls and AbortSignal, and permits only the two fixed
synthetic origins/paths. It routes them over Unix-socket HTTP. This proves actual
CLI/SDK cryptographic protocol behavior under synthetic transport. It does not
prove TLS, cloud reachability, browser approval, a real member's ACL, the platform
DB's one-use enforcement or production revocation. Those retain their separate
real HTTP/PG and target-environment evidence requirements.

## Versioned transition and installation

`consumer-host-tuples.mjs` is the host-owned repository/source/library/runtime
selection. The Kit candidate uses producer `057201218b6d4ae3e96b4ab838677f2b484b55fa`
with `agent-kit-device-cli-v1`; all other consumers retain producer
`91b943ac61e132fbbce72ea066cb2301aa065600` and their existing profiles. Candidate
locks and environment variables cannot choose a SHA or profile. Legacy and
`agent-kit-device-v1` remain explicit local distribution/verification profiles;
they are not silently treated as the new runtime profile.

The new Kit registration transition permits exactly `device:status` =
`node src/device-cli.mjs` and build = `node --check src/cli.mjs && node --check
src/device-cli.mjs`, with no added pre/post hooks or other registration changes.
Already-upgraded baselines remain valid. A future command/SDK change must publish
a reviewed producer and update its explicit host tuple; the source SHA is an
existing commit, never a self-referential hash or candidate lock value.

These files do not move installed GitHub workflow pins or rules. The old installed
workflow still enforces its old tuple. Publication and local tests do not authorize
rollout: review the paired Kit/source/runtime candidates, run owned-ref hosted
positive and negative probes, then update the installed workflow under the normal
review and explicit merge/installation authorization. This packet adds no new
approval layer and does not claim that transition has occurred.

## Supported previous consumer during adoption

The native host explicitly supports two Agent Kit tuples: previous `legacy-v1`
from `91b943ac61e132fbbce72ea066cb2301aa065600`, and current
`agent-kit-device-cli-v1` from `057201218b6d4ae3e96b4ab838677f2b484b55fa`.
The immutable candidate lock must match one complete installed tuple; it cannot
introduce a source/profile or override policy with environment variables.
Unknown and mixed tuples fail before execution. Every selected tuple still
requires canonical artifact bytes and its exact approved entry registrations.
Keeping the new device registration with old libraries is rejected.

Previous consumers retain their workspace/CLI checks and receive no device
invocation claim. Current consumers must additionally pass the canonical device
closure and all device runtime cases. Ordinary product edits remain possible
under either supported version. Removing an old tuple requires a reviewed host
revision and native workflow installation; this local support table does not
replace signed ReleaseSet/revocation policy or activate installed gates.
