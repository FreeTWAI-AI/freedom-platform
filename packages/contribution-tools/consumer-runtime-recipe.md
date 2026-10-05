# Consumer runtime installation candidate

This recipe makes the three-consumer HTTP supervisor portable. It does not change
installed source rule 24473806, source55, library source91, or central rule
24469536. The new native workflow is a candidate for separately reviewed canaries.
No runtime rule is installed by this code.

## Fixed public inputs

`consumer-runtime-recipe.mjs` is the executable source of these exact pins:

| Input | Identity |
| --- | --- |
| Docker registry reference | `docker.io/library/debian@sha256:5ae3c39ebd15e229dcedd5cee596b2497182493d41ff162e824ba13fc1b2b867` |
| Platform | `linux/amd64` |
| OCI config | `sha256:160466e67bb85a4099d9d9c2356b4a6a64747b281a22c142efbd4539db1b8525` |
| Uncompressed rootfs | `sha256:1d69a5fd31932841d7825ef4780c06f008eea65aaa9f3110fe09d5832ed5c7d8` |
| Official Node | `v24.21.0`, `node-v24.21.0-linux-x64.tar.xz` |
| Node archive SHA256 | `fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6` |
| Extracted `bin/node` SHA256 | `7fde7b8afa198da66257f42ee2001d874c7355631e6d1579a5fb5ef1f246df4c` |

The former cached image ID `sha256:88200866dfff7ea7f5cbcb6ec7c8a701889efe6fe859fe64d6990e4b07ea4171`
is the multi-platform Debian bookworm-slim index. Its amd64 child is the manifest
above. The pinned [upstream OCI index](https://github.com/debuerreotype/docker-debian-artifacts/blob/bae6d64d90b4068b09ff9d8b564c2773ef5d8d83/bookworm/slim/oci/index.json)
and the public registry independently expose that same child identity. The
[Docker Official Images Debian definition](https://github.com/docker-library/official-images/blob/master/library/debian)
identifies debuerreotype as its build source. The manifest/config/rootfs are pinned;
the moving `bookworm-slim` tag is not an installation input. Older pinned images do
not receive updates automatically; a new image requires another reviewed pin and
canary.

Node's official [release checksums](https://nodejs.org/dist/v24.21.0/SHASUMS256.txt)
provide the archive digest. Downloading that exact public archive, checking its
SHA256, and hashing the extracted `bin/node` reproduces the binary pin above.
The current official binary passed actual execution in the pinned Debian image.
[Node24's build requirements](https://github.com/nodejs/node/blob/v24.21.0/BUILDING.md)
state Linux x64 glibc >=2.28 and kernel >=4.18; this image supplies its own glibc
and linked libraries. Host glibc is not mounted into the candidate.

The workflow requests Ubuntu24.04 and exact Node24.21.0 through SHA-pinned
checkout/setup-node actions. The official [Ubuntu24 runner inventory](https://github.com/actions/runner-images/blob/main/images/ubuntu/Ubuntu2404-Readme.md)
is a rolling image, not a cryptographically fixed host OS. Setup-node may resolve
its toolcache or public distribution, but the host rejects anything except the
exact executable bytes above. It accepts a realpath under the hosted toolcache
without mounting that directory. Kernel, Docker daemon, Git, Actions service and
runner isolation remain the operator's host trust boundary. Registry provenance
and these checks do not approve that boundary or establish a publisher identity.

## Provision and verify

On the reviewed host, from the fixed central checkout:

```sh
node packages/contribution-tools/consumer-runtime-recipe.mjs prepare
node packages/contribution-tools/consumer-runtime-recipe.mjs verify
# On an actual GitHub Ubuntu24.04 runner only:
node packages/contribution-tools/consumer-runtime-recipe.mjs verify-hosted
```

`prepare` explicitly pulls only the fixed public amd64 reference, using a fresh
empty Docker configuration and sanitized environment. It does not consult private
registry credentials. `verify` rejects missing or altered images, image metadata,
wrong architecture, wrong Node version or wrong executable hash. Docker classic
storage uses the fixed config ID; containerd storage may use the fixed manifest
ID. Both must also expose the exact RepoDigest and rootfs identity. There is no
mutable-tag fallback. `verify-hosted` additionally requires the actual Ubuntu24.04
OS release and GitHub Actions context. Local Ubuntu26.04 correctly fails that
hosted check; local integration success does not establish hosted success.

No npm installation or Python dependency is required for these three consumer
profiles. The native workflow uses only the existing source verifier and supervisor
with built-in Node modules. Candidate imports occur only inside the constrained
container, with read-only rootfs, no network, no Docker socket, no credentials,
and four checked bind destinations: candidate snapshot, fixed launcher, exact Node
binary and private fixture socket directory. The source verifier and runtime
supervisor export the same immutable candidate commit/tree independently. The host
requires both checks to pass and owned-container cleanup to be confirmed. Neither
candidate stdout nor an uploaded report can supply a verdict.

## Reviewable hosted canary plan

1. Review this source together with the existing source verifier and supervisor.
   Publish an immutable central commit containing the combined files, exact source91
   Git objects and all9 approved baseline lock. Record its full commit SHA. Do not
   repoint source55 or library91. The runtime workflow path is
   `.github/workflows/trusted-consumer-runtime.yml`.
2. Read current rule24473806 and central24469536. Create owned temporary base refs
   in **only** `FreeTWAI-AI/freedom-agent-kit`, `FreeTWAI-AI/freedom-storefront`, and
   `FreeTWAI-AI/freedom-supplier-client`, each at its reviewed current main SHA.
   Record before-state and exact repository/ref IDs in a separate canary journal.
   Add one temporary native required-workflow rule restricted to those exact refs
   and repositories, with the new central workflow pinned to the reviewed full SHA,
   no bypass actors and no replacement of existing policies.
3. Open one harmless docs-only positive candidate per owned base. Open one negative
   per base changing only `src/index.mjs` to stub its workspace export, leaving
   canonical vendor files and both locks byte-identical. The kit stub should export
   `loadMemberWorkspace`; storefront `loadConnectedStorefront`; supplier may retain
   its `ScopedReadClient` export but stub `loadSupplierWorkspace`.
4. Read actual native runs. Confirm workflow source SHA/repository/path, runner
   version, recipe/image/Node readbacks, candidate commit/tree, source passed,
   runtime passed and cleanup verified for each positive. Each negative must pass
   source integrity, fail the observed HTTP comparison and exit nonzero. A setup,
   source, OS or registry failure is not proof of the negative behavioral test.
   Repeat a negative with a same-name classic green status if useful; attempt its
   merge and require a native-workflow denial. Do not bypass or forge reviews.
   Positive merges may occur only on owned temporary refs when existing rules allow.
5. Close remaining probe PRs, delete only journaled temporary branches and the owned
   temporary rule, and verify readbacks/main SHAs and existing rules unchanged.
   Missing evidence or cleanup blocks the installation recommendation.
6. Only after successful hosted positive/negative proofs and operator approval,
   prepare a separate additive main-target native workflow rule for these three
   repositories and exact new source SHA. Preserve all9 source rule24473806,
   central24469536, review requirements and every other policy. Read back effective
   rules for all three, then repeat one actual-main positive (no merge required)
   and stub negative, with the negative merge denied. Record/clean only owned probes.

The workflow uses [`job.workflow_sha`, `job.workflow_repository` and
`job.workflow_file_path`](https://docs.github.com/en/actions/reference/workflows-and-actions/contexts#job-context)
to bind the trusted source and uses the candidate event SHA independently. These
fields must be checked on the actual native required-workflow runs. The source
checkout has full history and no persisted credentials. Only the fixed host
wrapper's own exit status and computed source/runtime result are consumed.

## Evidence boundaries

Local tests exercise the actual three merged consumers, a correct vendor tree with
a stub in each product entrypoint, forged transport/output, wrong-scope/revoked
responses, cleanup, read-only mounts and a Node executable outside `/usr`.
The combined native host test confirms that a stub can pass source verification
while failing the runtime verdict. Sequential delayed cases also verify completed
request timeouts cannot abort a later case.

Successful results establish host-observed synthetic HTTP behavior for the bounded
three entrypoint profiles. `library_usage`, `library_invocation`, server ACL
validation and publication authority remain `not_checked`/unverified. This cannot
prove internal shared-module invocation or full consumer coverage. The other six
source profiles retain their existing source-only gate. Actual hosted approval,
canary results and rule installation are external operator steps, not test fixtures
or claims made by this repository.
