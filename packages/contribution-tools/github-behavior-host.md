# Installed member behavior host

`github-behavior-host.mjs --verify CONFIG SIGNED_JOB` is a host entrypoint for
actual isolated member-route execution. It authenticates the existing
`github-candidate` envelope, installs the existing independently signed verifier,
validates the Git graph and pinned policy, and rejects missing suite coverage
**before** starting the candidate. It then runs the existing Docker supervisor
with the real candidate/policy/workflow binding, verifies cleanup and installation
pins, and reruns the real verifier with the observation it produced. Only complete
success exits zero. Candidate package scripts, workflows, test files, exit codes
and serialized reports are never proof. All output retains `gate_enforced:false`
and `merge_authorized:false`: the host process cannot attest GitHub rule installation.

Configuration is exactly `{adapter,dependency_root,installation}`. `adapter` is
the existing github-trusted-adapter configuration, including external trust,
verifier distribution, host directory, complete bare object repository, candidate
roots and expected policy. Native workflow execution does not require `app_id` or
`check_name`; those remain required by the separate App publisher. `installation`
has four independently approved SHA-256 pins: `supervisor_sha256`,
`harness_sha256`, `node_runtime_sha256`, `dependency_sha256`. Observe these with
`installedSupervisorIdentity()` and `validateBehaviorDependencyCache()` during
operator review, then install the approved values outside candidate control.
Observation is not approval. The supervisor fingerprint now also covers this
host adapter and GitHub verifier bootstrap. The existing runtime and OS
fingerprint limitations still apply; see behavior-supervisor.md.

The only implemented suite is `behavior.platform-member-routes` (27 cases/six
routes). Any additional selected suite, unknown changed path or selected operation
outside those routes fails closed. In particular the existing platform policies
requiring governance/runtime/source suites **cannot pass** this runner alone.
Do not delete those requirements or relabel them as member behavior to obtain
success. Extending installed harness coverage is required for a platform-wide gate.
This runner also retains the verifier's consumer ReleaseSet/lock admission;
it does not synthesize a missing approved central-repository baseline.

## Native required workflow installation

`workflows/trusted-member.yml` is an executable installation template, deliberately
outside `.github/workflows` until its runner exists. No new GitHub App or check
publisher credential is needed for its native workflow conclusion. The operator:

1. Installs reviewed immutable host bytes and dependencies at
   `/opt/freedom-trusted-host`, config at `/etc/freedom-trusted-host/member.json`,
   cached supervisor images, Node 24 and the existing Docker isolation prerequisites.
   Protect all parent directories and the runner identity from candidate writers.
2. Restricts `freedom-trusted-host` runner-group access to the reviewed fixed
   workflow. Never allow ordinary candidate-controlled workflows on this runner;
   Docker access and the runner account are host authority.
3. Installs an independently authenticated event gateway that writes a short-lived
   signed job to `/var/lib/freedom-trusted-host/jobs/RUN-ATTEMPT.json` and imports
   the exact complete Git objects into the configured host bare repository. The
   gateway and its `github-candidate` key remain external installation prerequisites;
   this change does not invent an approval/key or trust a candidate event artifact.
4. Copies the template to `.github/workflows/trusted-member.yml`, pins the reviewed
   workflow revision in the native org required-workflow rule, and approves the
   corresponding policy workflow identity/commit. Preserve other required checks.
5. Exercises genuine positive and malicious PRs and merge groups before claiming
   enforcement. Missing runner, job, pin, approved baseline or coverage blocks.

`--actions` additionally compares the authenticated job to native Actions
repository/run/attempt/event/candidate SHA, and compares approved workflow identity
and revision to `GITHUB_WORKFLOW_REF`/`GITHUB_WORKFLOW_SHA`. Those variables are only
a binding assertion within the fixed protected workflow, not standalone credentials.
Short-lived signed input is reauthenticated after execution. A merge-group uses
its real candidate and null PR; no synthetic PR identity is assigned.

## Existing separate App publisher

`createInstalledBehaviorSupervisor(config, operatorPrivateKey, kid, loadSignedJob)`
provides the existing `supervisor(binding)` port. It first checks the loaded
Ed25519 key against the already-installed runner-observations public trust entry,
then verifies exact requested binding, executes the concrete runner, and signs
only that successful observation. Candidate workers never receive the key. Use
this port with `createDurableSignedSupervisorPublisher` and existing authenticated
request closures if the operator selects the App path. It does not replace the
publisher's durable replay/freshness requirements or its current PR-only boundary.
The native workflow path needs no observation private key and makes no HTTP writes.

Focused checks:

```sh
node --test packages/contribution-tools/test/github-behavior-host.test.mjs
FREEDOM_RUN_ISOLATED_BEHAVIOR=1 node --test packages/contribution-tools/test/github-behavior-host.integration.mjs
```

The explicit integration uses real Git objects, copied verifier bytes, actual
Docker isolation and the real application, with synthetic ephemeral signing keys
and policy. It tests the publisher supervisor port through genuine 27-case
execution and authenticated observation readback while candidate test scripts
contain a throw/fake-success replacement. It is developer evidence, not installed
production trust. All containers/database fixtures belong to that invocation.
