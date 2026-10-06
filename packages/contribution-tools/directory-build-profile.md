# Directory build profile

This candidate semantic-profile upgrade extends the existing fixed native runtime host to
`FreeTWAI-AI/FreeTWAI-AI.github.io`. The source prerequisite still checks approved
01b ancestry, immutable build/Pages automation, preview bytes, manifests and
executable registrations. Directory data and product renderers are then exercised
through the actual `scripts/build.mjs` entry, with no candidate tests or reports.

The host checks ten cases: current data, fresh text/HTML-escaping challenges, an
empty directory, duplicate repositories, invalid directory schema, invalid
privacy sections, traversal/absolute/encoded paths and malformed privacy JSON.
Successful cases require both complete pages under the fixed HTML5 semantic
profile `freedom.directory-html/v2`; normal rejection requires
exit 1 and an unchanged input tree with no output directories or files. A timeout,
transport error, incomplete readback or cleanup failure is unavailable and fails
the combined gate. Exit codes come from the exact Docker daemon exec object's
identity/command/container readback, not the CLI exit status; a CLI transport error
can also return 1. Candidate stdout/stderr are detached and never parsed. Current
privacy data must retain `privacy/discord-bot/`, the
destination of the directory footer link.

Each case uses the existing pinned Debian/Node recipe, network-none, nonroot UID,
read-only root and source binds, dropped capabilities, no-new-privileges and
bounded memory/CPU/PIDs/descriptors. A separately owned Docker local volume uses
tmpfs with a 32 MiB ceiling; it is not a writable host source directory. The host
checks actual container and volume settings before/after the build, pauses all
container processes, and obtains the complete working tree through Docker's
archive API. A trusted Python standard-library reader never extracts anything:
it rejects links, special files, duplicate/traversal paths and size/count overflow,
then hashes regular files and, only in the explicit HTML mode, includes base64
bytes for the two fixed output paths. The host compares every source hash and
the exact output path/directory set, binds each returned HTML body to its archived
hash, and sends only those bytes to the fixed parser. Candidate output remains
data, never code or a self-reported verdict. Unknown create outcomes
remain unverified even if a later empty listing is observed. Containers and volumes
are removed only with this invocation's unique ownership label.

Docker's archive API did not expose a directly mounted container tmpfs during the
initial local attempt. That attempt failed closed and cleaned up. The explicitly
named tmpfs volume allows daemon readback while every candidate process is paused;
both its memory bound and exact ownership are checked.

`directory-reference/` preserves the reviewed directory's 01b source and authorship.
Its input validators remain fixed, and its renderers provide positive test examples.
They no longer generate expected whole-page hashes. A normal CSS, class, wrapper
or accessibility change can pass without editing a central rendering baseline.

The host parses captured HTML with [parse5](https://parse5.js.org/), not substring
matching or candidate DOM reports. Directory project text must be complete and
associated with the correct unique GitHub link. Both privacy languages and their
public content and data-derived HTTPS/mail links must remain complete. Host
challenges give separate fresh markers to the individual fields. Text is compared
through the parsed tree with whitespace normalization; layout elements, classes,
CSS declarations and safe ARIA attributes can change. Broken fragment/ARIA
references, wrong or missing fields, constant pages and injected markup fail.

The fixed static-page element/attribute profile excludes executable elements,
foreign namespaces, event handlers, forms and external resource elements. Every
link, including hidden links, must match an approved public destination or a real
same-document target. CSP must precede styles and preserve `default-src 'none'`,
`style-src 'unsafe-inline'`, `base-uri 'none'` and `form-action 'none'`;
additional directives can only deny the listed resource types. Referrer policy
stays `no-referrer`. Thus CSS freedom cannot enable remote stylesheet/resource
loads. This is semantic static HTML validation, not visual quality, browser
acceptance, a general HTML sanitizer, or proof of internal library invocation.
The observation covers the working tree, not every temporary scratch write or
every possible input. No Pages publication or installed gate upgrade is implied.

## Fixed parser trust and bounds

The isolated host-only `directory-html-host/package-lock.json` pins
`parse5@8.0.1` (MIT) and `entities@8.0.0` (BSD-2-Clause), including their npm
tarball integrity values. They contain 91 package files / 573,101 bytes; their
approved installed byte-tree digest is
`23432fe7cdf370e67a8289a1cce223d6c23cf2969550a7f9864c40b353caa9be`.
The official package licenses remain in the installed packages. No product
dependencies or browser runtime are added.

Only a trusted-source installation step runs `npm ci --ignore-scripts` for these
two packages, before probes. The host never installs or resolves candidate
`node_modules`. The parser/checker source, host-only package/lock, and actual
package byte identity join the directory supervisor identity before and after
execution. Symlinked, missing, extra or changed package files are rejected.
Generic workspace/CLI consumer modes do not require this parser installation.

The existing 8 MiB archive, 1,024-entry, 2 MiB-per-file and 4 MiB-total content
limits remain. Only the two expected HTML outputs are returned, with a 6 MiB
archive-summary limit. Each HTML page is at most 2 MiB; the parser subprocess has
a 128 MiB heap ceiling, a 3-second timeout and 64 KiB stdout/stderr budget. The
tree is limited to 20,000 nodes, depth 128 and 32 attributes per element. Parsing
never executes scripts or fetches resources. It uses the existing sanitized
subprocess environment, and candidate builds retain network-none containers.
Malformed parser reports, parser crashes/timeouts, missing parser bytes and incomplete
readback are unavailable, never accepted as expected input rejection.

Run `node --test packages/contribution-tools/test/directory-build.test.mjs` for the
bounded archive reader. Install and check the isolated semantic profile with:

```sh
empty_npm_config=$(mktemp)
npm ci --prefix packages/contribution-tools/directory-html-host --ignore-scripts --no-audit --no-fund --registry https://registry.npmjs.org --userconfig /dev/null --globalconfig "$empty_npm_config"
rm "$empty_npm_config"
node --test tests/integration/directory-html-semantics.test.mjs
```

Full integration needs separate full Git clones, Docker,
the exact runtime recipe and the source validator's fixed jsonschema dependency:

```sh
FREEDOM_RUN_DIRECTORY_RUNTIME=1 \
FREEDOM_DIRECTORY_ROOT=/absolute/directory-clone \
FREEDOM_CONSUMER_SOURCE_ROOT=/absolute/source-clone \
FREEDOM_CONSUMER_WORKFLOW_SHA=<source-clone-HEAD> \
node --test --test-concurrency=1 tests/integration/directory-runtime.test.mjs
```

The candidate CI workflow exercises approved Git ancestry: valid builds/data edits,
CSS redesign and wrapper/ARIA changes, plus source-valid constant output, escaping
removal, missing public fields, weak CSP, encoded hidden URLs, duplicate-validation
removal, early writes, extra files, route drift, symlink and hang counterexamples.
It remains diagnostic until an independently reviewed workflow upgrade.

The previously installed byte-comparison implementation was merged in central PR #128 as
`5b471fe730f11a85700d5ab3225d6c862cee7bc3`. Directory-only main rule **24516222**
requires that unchanged fixed runtime workflow, published at
`refs/heads/governance/directory-runtime-source-20261005`. Two temporary positives
merged, three source-valid build negatives received actual merge 405 responses,
and a main-target positive/negative repeated the enforcement check. All seven
probes and their temporary resources were closed/removed; directory main was
unchanged. [Installation evidence](../../docs/platform-plan/verification/directory-runtime-enforcement-2026-10-05.json)
records the exact native runs, rule configuration and cleanup. Those observations
belong to the old installed profile; they are not acceptance of this semantic
candidate. This change moves no installed ref, ruleset, source pin or Pages deployment.

Source rule24473806 remains at a254 and the separate three-consumer runtime
rule24476100 remains at92. Future upgrades need independently reviewed source,
a new fixed publication ref and their own hosted acceptance. Do not broaden the
three-repo rule blindly or move an installed immutable source ref.
