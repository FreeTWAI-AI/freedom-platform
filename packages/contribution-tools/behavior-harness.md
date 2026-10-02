# Fixed member-route behavior profile

`runMemberRouteBehavior(input, ports)` is a **local host-port boundary**, not
trusted CI, an authenticated transport, or permission to execute/publish/merge.
It imports no candidate modules, launches no processes, and has no ambient
network/database transport. The fixed manifest covers the six currently audited
avatar/private-Work routes; it does not register or validate every app surface.

The host supplies an exact existing evidence `binding` (repository, PR/run,
actual base/head/candidate/tree, source, policy and verifier pins), `workflow`,
`expectedHarnessSha256`, and synthetic `fixture`. The fixture has `instance_id`,
`work_id`, owner/outsider `{ id, cookie, csrf }` and revoked `{ cookie, csrf }`.
Use distinct synthetic sessions and communities, one owner draft, and an existing
version-1 legacy WebP avatar. Never use production users or credentials.

The only ports are:

- `observeTarget(): Promise<{ binding, workflow, harness_sha256, fixture }>`:
  `fixture` is the nonsecret `behaviorFixtureIdentity()` value.
- `request(fixedRequest, abortSignal): Promise<Response>`: the trusted host
  routes fixed loopback-origin requests into its isolated target; no URLs or
  paths are accepted from descriptors/candidates.

The host must independently provision/observe the frozen candidate, harness,
fixture and isolation. Merely passing a function or returning the expected
object is **not authentication or evidence of isolation**. A malicious in-process
port can fabricate responses; this API cannot sandbox arbitrary JavaScript.
The transport must honor cancellation and must not redirect/fallback to another
target. Before/after structural identity comparisons detect reported changes,
not dishonest host observations. The host-installed digest covers the fixed
manifest/harness and the existing verifier's complete declared dependency set.
Digest matching is installation identity, not approval of that installation.

The 27 fixed cases include owner positives, cross-community denials, anonymous
and revoked sessions, private conditional GET/HEAD authorization, and avatar
CSRF/version/idempotency preconditions. Every mutation request omits at least
one write precondition; auth-negative remove requests also omit the version so
an authentication regression alone cannot delete the fixture avatar. These are
negative mutation tests, **not successful upload/removal/replay tests**. The
fixture database is disposable even though successful writes are not expected.

Responses require actual bounded bytes, exact status, no-store, appropriate
content type and relevant DTO/marker assertions. JSON rejects duplicate keys
and malformed encoding. Bounds are 256 KiB/response, 2 MiB/run, 4096 chunks/body,
16 KiB/128 response headers, 2 seconds/request or identity observation, and
60 seconds/request loop. Raw response header markers (including HEAD), raw and
JSON-decoded synthetic credentials, and decoded private JSON markers are denied.
This is sentinel-based checking, not detection of arbitrary encoded exfiltration.
Missing
body (except HEAD), transport failure, timeout, oversized data and incomplete
cases cannot pass. Errors expose only fixed diagnostic reason IDs. A transport
which blocks the JavaScript event loop is outside these cooperative limits;
the future host must enforce external process/resource limits too.

Evidence hashes only safe case outcomes, the Git/policy/workflow/harness binding
and nonsecret fixture identity/revision. It never hashes/stores cookies, CSRF,
response bodies, private titles or private objectives. Changing synthetic
credentials alone does not change the fixture identity. The existing host
observation shape is returned only when all cases pass; there is no new signed
attestation format. Candidate-provided reports/test lists/executables/authority
flags are rejected. Callers must not promote this serialized observation into
authenticated runner evidence without a separately implemented trusted port.

The wrapper always has `assurance_level: local`, `status: unavailable`,
`merge_authorized: false`, `execution_authorized: false`, and unverified publisher
trust on successful bounded checks. `check.status: passed` and `observation`
mean only that these assertions were observed through the supplied host port.
Failure returns `failed`; absent/unapproved host installation or ports remain
`not_run`/unavailable. Source coverage and trusted publisher remain independent
blockers. No runtime CLI default, workflow registration or public route changes
are introduced by this slice.

DB-free tests use synthetic responses solely to validate the harness. The
separate `tests/runtime/fixed-behavior-harness.test.ts` instantiates the actual
`createApp`, migrates a fresh `fp_*` schema on an explicitly supplied disposable
`fp_*` database, issues all 27 requests, and checks unchanged avatar bytes,
versions and command facts. Its Git identity is real local HEAD/tree while
source/policy/workflow assertions are explicitly synthetic; it is still not CI
provenance. The test drops its schema and never discovers a default database.
