# Contract release verification and development context

This directory defines the development schemas for the unified-foundation governance work. The first implementation verifies legacy preview pins and signed ReleaseSet pins locally. It does **not** configure a trusted publisher, GitHub protection, runtime authorization, or production signing.

The source schemas are in [schemas](schemas). The shared implementation is in [packages/contribution-tools](../packages/contribution-tools); consumers receive exact committed copies through the existing export command. Do not create a second consumer-owned verifier or change the preview bundle to enable execution.

## Local checks

```sh
npm run test:governance
npm run contracts:build
git diff --exit-code -- contracts/preview/v1 packages/sdk
```

The tests use synthetic repositories, ephemeral in-memory signing keys and temporary files. They do not connect to a database, provider, R2 or GitHub. Existing preview bytes are used for compatibility tests.

## Development entrypoints

```sh
node scripts/freedom.mjs prepare --base-ref origin/main --scope assets,member-card
node scripts/freedom.mjs context --base-ref origin/main --paths apps/portal-web/src/modules/Membership.tsx
node scripts/freedom.mjs verify --base-ref origin/main --report .freedom/reports/current.json
```

Run from the repository root with Node 24. `prepare` writes an ignored, task-scoped context bundle; `context` prints the full applicable content; `verify` runs the implemented local checks and optionally saves a report. Exit codes are 0 (complete for the requested local scope), 1 (failed), and 2 (required evidence unavailable). None of these results is a trusted merge or execution authorization.

Context contains repository/base/head, a hashed worktree identity, branch, staged and unstaged changes, untracked source, root and applicable nested AGENTS instructions, and both baseline and changed policy text. Contract pins/ReleaseSets include their public version information; dependency manifests are fingerprinted without copying potentially private registry settings. The bundle records `publisher_trust=unverified` and `library_usage=not_checked`, never that an Agent understood it. Regenerate after changing scope, base, lock, branch/worktree, or session; no receipt is committed into a shared JSON file.

Module descriptors use exact paths or directory `/**` patterns. Impact is the union of baseline and candidate descriptors plus reverse dependencies. Deleting, renaming or shrinking a descriptor cannot subtract baseline scope/tests. Unknown non-document paths select all modules and require a full fallback; missing baseline governance, missing instructions and unmapped surfaces remain explicit blockers. Descriptor references check file existence, **not** actual route registration or ACL behavior.

The first descriptors cover governance, legacy avatar/member-card entrypoints and work. This is not a complete runtime registry. `governance.unit` is the only implemented test adapter: fixed Node tests, no candidate shell commands or package hooks, bounded execution/output, no inherited provider/DB tokens or Node preload hooks. A custom reporter consumes [Node test summary events](https://nodejs.org/docs/latest-v24.x/api/test.html#event-testsummary), requiring real nonempty tests in every selected file and zero skips/TODO/failures. Unknown test adapters and runtime registration/behavior checks return `not_run`, making the report unavailable rather than green. The runner is not a security sandbox: local tests remain code with the current OS user's filesystem/network rights; untrusted PR tests require isolated secret-free CI.

During initial adoption, running against an `origin/main` without descriptors correctly returns `baseline_governance_unavailable`. Do not change the base to hide that result in PR evidence. Synthetic repositories with an established baseline test the successful path. The export command also supplies the same central context library and a thin `scripts/freedom.mjs` to consumers; each consumer must supply reviewed module descriptors and actual suite adapters.

An explicit export, after committing all source files, remains:

```sh
node scripts/export-contract-bundle.mjs /absolute/path/to/consumer
```

The destination must already exist and must not overlap the producer. Export checks committed bytes and destination paths before writing. It copies the preview bundle, central tooling and thin consumer entrypoints, then writes the existing v1 lock last. It does not remove unrelated files, commit, open a PR or push. Interruption can leave a partial export; rerun the same committed export and verify before using it.

In a consumer, `node scripts/verify-contracts.mjs` returns structured JSON and exits 0 for the requested local verification, 1 for invalid input/integrity, or 2 for unavailable trust/source. `--remote` additionally compares v1 bytes with the exact pinned GitHub commit. v2 does not accept `--remote` as a replacement for publisher approval.

## ReleaseSet and proof profile

`freedom.release-set/v1` binds source SHA, artifact bytes/digests, contract families, libraries, policy revision, generator, fixtures and runtime profiles. Every artifact must be classified and every reference must resolve. Paths, counts and total bytes are bounded; absolute/traversal/Windows-special paths, case collisions, symlinks, hardlinks, extra files and missing files are rejected.

The digest profile is `sha256-exact-bytes/v1`: SHA-256 of the exact UTF-8 manifest bytes. The authoring helper sorts object keys and artifact paths for repeatability, but this encoding is **not RFC 8785**. It does not change historical preview/SQL digests or select the future execution JCS implementation.

`freedom.release-proof/v1` is detached. Ed25519 signs the UTF-8 bytes of `freedom.release-set-signature/v1` followed by one NUL byte and the exact manifest bytes. The signature uses unpadded canonical base64url. The public key must be an Ed25519 public JWK; no private key, HMAC key, arbitrary algorithm, jku or x5u is accepted. The implementation uses Node's native Ed25519 verification, with a null algorithm as required by its [crypto API](https://nodejs.org/docs/latest-v24.x/api/crypto.html#cryptoverifyalgorithm-data-key-signature-callback).

This signature proves possession of an approved publisher key over a specific manifest. It does not itself prove a GitHub workflow ran. Workflow/provenance enforcement, secure signer custody and independent approval/revocation publication remain separate GOV-C/D work.

## Independent trust input

`verifyContractPin` accepts an operator-supplied `trustProfile`; it never discovers one in the candidate repository. The profile identifies environment, version, approved publisher keys, supported/withdrawn manifest digests and policy revisions. It expires, with a default maximum freshness window of 24 hours. The operator must obtain it from an authenticated, independently managed source. A self-consistent consumer hash and self-signed key are not approval.

There is no production trust profile or private signing key in this repository. The bootstrap CLI intentionally has no `--trust` flag: v2 is unavailable there until a trusted host injects the approved policy through the library API. `fixture` environment results remain fixture evidence; every result has `assurance_level=local` and `execution_authorized=false`.

The verifier checks only the supplied artifact set and policy. A build analyzer must independently collect actual library resolution records; `verifyLibraryResolution` validates those records but does not attest who collected them. `library_usage=not_checked` on a pin result is intentional.

## Boundaries

The governance validator implements only the fixed schema keyword subset used here and rejects unknown keywords. It is not a general JSON Schema engine and does not load candidate schemas or code. JSON parsing rejects duplicate keys, invalid UTF-8/surrogates, unsafe numbers and excessive depth/size. Errors expose stable codes, not input fragments or secret-bearing paths.

Trusted CI must run the fixed verifier against an isolated, immutable checkout with no production secrets. Filesystem checks do not make a concurrently hostile workspace a sandbox. Local candidate tests and reports cannot publish trusted CI status. No new runtime endpoints, tables or execution permissions are enabled by this package.

## Implementation evidence

On 2026-10-02, the first local implementation passed 88 Node tests with no skips. The existing preview build regenerated 32 operations and 9 bundle artifacts with no changes under `contracts/preview/v1` or `packages/sdk`.

The context increment passed 106 Node tests, zero skips, including baseline/candidate scope, deleted rules, nested context, branch/worktree changes, stale workspace/base, secret-free subprocess environment, bounded report writes, zero/skipped/forged test output and three independently initialized synthetic consumer repositories. Existing contract tests passed 659 cases with 4 pre-existing skips (clock cases with fewer than three schema paths). These fixtures do not mean the real Agent Kit, client or other consumer repos have been upgraded.

The evidence supports the local portions of GOV-01/02/03/22, path/input safety and v1 compatibility; it does not mark those full product requirements passed. Release-proof purpose tests are not execution-token tests. Three real consumer checkouts, TS/Rust conformance, Windows/macOS, trusted GitHub checks, production publishers and runtime rejection remain unverified. All source acceptance rows remain `not_run` until their complete required evidence exists.
