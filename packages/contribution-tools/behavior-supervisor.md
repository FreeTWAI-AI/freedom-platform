# Local isolated member-route supervisor

`runIsolatedMemberBehavior({candidateRepository,candidateCommit,dependencyRoot})`
runs the existing fixed 27-case member harness against an actual `createApp` in
a disposable Linux Docker container. It accepts host-selected source/cache
locations and a full commit ID, never candidate ports, test lists, results,
fixture identities, network endpoints or execution commands. This is a local
isolation prototype; every report remains `local`, `unavailable`, with
`publisher_trust:'unverified'` and merge/execution authority false.

The host supervisor must be installed separately from candidate control. Do not
import this module from a proposed checkout and treat its output as trusted CI.
Nothing here configures GitHub, signs evidence, authenticates a workflow, grants
release approval or expands the six-route suite's source coverage.

## Execution boundary

The supervisor reads regular blobs from the exact Git commit, verifies blob
hashes and materializes a private temporary snapshot. Mutable checkout files,
Git hooks, symlinks, submodules, case-colliding paths, `.git`, credential dotfiles
and candidate `node_modules` entries are rejected or excluded by construction.
The complete snapshot is capped at 8,192 files/64 MiB and mounted read-only.
Its file hashes are rechecked before and after the fixed request sequence.

Only cached local image identities are used, with `--pull=never`: the fixed
Debian image and PostgreSQL 18 Alpine image recorded in the module. The
candidate gets the host's Node 24 `/usr` tree read-only because the local cache's
Node images are older than the repository's supported runtime. No checkout,
home directory, Git metadata, Docker socket or host credential directory is
mounted. Candidate mounts are its export, a host-selected public dependency
cache, a fixed launcher, and the disposable database's socket directory; all
are read-only. The dependency directory must resolve to the host installation's
same `node_modules` realpath, so host fixture pg/sharp bytes and candidate
dependency bytes share one fingerprint; alternate caches are rejected. It must have
bounded entries/bytes, contain no credential dotfiles, and have only relative
symlinks resolving inside itself. Its actual file/link hashes are checked before
and after the run. A cache fingerprint does not authenticate registry origin.

Both containers have separate network/PID namespaces, network `none`, read-only
roots, no capabilities, no-new-privileges, 512 MiB memory with no extra swap,
128-PID limits, one CPU, bounded temporary filesystems and no Docker log storage.
The host inspects exact IDs, owner labels, images, users, mount sets and modes,
environment allowlists and resource settings. The candidate receives only
image PATH, fixed NODE_ENV/TMPDIR and its synthetic app database password.

The host creates a new PostgreSQL instance with local SCRAM authentication and
host authentication rejection, then applies **installed host migration SQL**
and fixed fixture SQL. It never executes candidate migrations, seeds, package
hooks or tests. Admin and app passwords are independent random values passed
through subprocess environments, not command arguments, files, output or
reports. The candidate has only the `behavior_app` credential: no ownership,
SUPERUSER, CREATEROLE, CREATEDB, replication, bypass or role memberships. A Unix
socket and nonroot process UID alone would not establish this DB boundary;
integration tests actually attempt and reject privileged logins/escalation.

The host harness remains outside candidate processes. A fixed in-container
launcher imports the candidate app and returns only bounded HTTP response
frames over stdio. The host rejects unknown frame fields, wrong sequence IDs,
duplicate JSON keys, malformed encoding, unsolicited output and invented
results/observations. It limits each frame to 384 KiB, total stdout to 4 MiB,
stderr to 16 KiB and response bodies to the harness's 256 KiB cap. The existing
two-second request timer kills stalled candidate processes. A separate
60-second candidate watchdog and 120-second setup deadline bound execution;
Docker control commands have their own 15-second timeout. These controls rely
on a working local Docker daemon, not cooperative candidate cancellation.

After the harness, the candidate is killed and its DB backends terminated.
Coherent host DB snapshots compare all public table rows/columns, excluding
only expected `sessions.last_seen_at` activity touches. Counts and hashes are
computed inside the bounded DB container; raw candidate-controlled table values
never enter host result arrays. A per-table 10,000-row/32 MiB observation limit
and statement timeout fail closed. This checks retained before/after facts, not
all transient intermediate effects or a general semantic audit.

Cleanup resolves only this invocation's random owner label and exact container
IDs, removes them and any attached anonymous volumes, then removes its own
`mkdtemp` directory. The PostgreSQL image's declared volume path is overridden
with bounded tmpfs; unexpected volume mounts are rejected. Success requires
the host to verify no such containers remain. Only disposable synthetic data
is discarded; no existing database, named volume or image is deleted.

## Identity and evidence limits

Reports retain the actual candidate commit/tree/export hash, observed container
image IDs and settings, and a separate installation fingerprint covering this
supervisor, its fixture/launcher, host migrations and package lock. The existing
harness digest is separate; it does not cover the new execution supervisor.
It does cover the imported manifest and the verifier's declared complete static
closure, including io/process-env/trusted-ci and their imported schemas. Both
fingerprints, and the dependency cache fingerprint covering pg/sharp, are checked.
Node and its listed linked libraries have their own byte fingerprint. The
entire host `/usr`, kernel, Docker daemon and supply chain are **not** approved
or fully fingerprinted; `host_os_approval` and cache approval stay unverified.

The harness's required PR/policy/workflow binding fields use clearly local,
synthetic identifiers. Its legacy `release_set_sha256` slot contains the local
export digest, not a claimed approved ReleaseSet. `source_commit` identifies the
host checkout, while the independent closure digest identifies actual installed
bytes, including uncommitted changes. Do not promote this local observation
into an authenticated publisher record or a production compatibility decision.
An adversarial app can implement expected HTTP responses; passing these fixed
black-box cases never proves all application behavior or all private surfaces.

## Local checks

Unit checks do not start containers:

```sh
node --test packages/contribution-tools/test/behavior-supervisor.test.mjs
```

The explicit Linux integration invocation uses only already-cached images and
the repository's existing public dependency cache:

```sh
FREEDOM_RUN_ISOLATED_BEHAVIOR=1 npx --no-install tsx --test --test-concurrency=1 tests/integration/behavior-supervisor.test.ts
```

Missing opt-in, Docker, Node 24, cache or isolation produces failure, never a
passing skip. This suite is not added to ordinary runtime tests. It exercises
all 27 real app requests; host-file/network/readonly-mount escape attempts;
postgres/unknown-role login and app-role escalation attempts; forged outcomes;
output flooding; a blocked candidate event loop; and retained DB tampering.
No external writes, image pulls, production resources or publisher API are used.

## Installed host binding

The optional `hostEvidence` argument supplies `{binding,workflow,harness_sha256}`
from the installed host adapter. The supervisor checks the candidate commit/tree,
installed harness and verifier digest before candidate startup and uses the
binding throughout the existing request sequence. This argument is structurally
validated, not an authentication mechanism. Local calls without it keep their
synthetic identifiers and unavailable status. Installed calls need no `.git`
metadata in the host installation. See [the concrete installed runner and native
required-workflow path](github-behavior-host.md) for authenticated input, pin,
coverage and post-execution verification. The runner still does not approve the
host OS or establish GitHub enforcement by itself.
