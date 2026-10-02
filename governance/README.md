# Contract release verification

This directory defines the development schemas for the unified-foundation governance work. The first implementation verifies legacy preview pins and signed ReleaseSet pins locally. It does **not** configure a trusted publisher, GitHub protection, runtime authorization, or production signing.

The source schemas are in [schemas](schemas). The shared implementation is in [packages/contribution-tools](../packages/contribution-tools); consumers receive exact committed copies through the existing export command. Do not create a second consumer-owned verifier or change the preview bundle to enable execution.

## Local checks

```sh
npm run test:governance
npm run contracts:build
git diff --exit-code -- contracts/preview/v1 packages/sdk
```

The tests use synthetic repositories, ephemeral in-memory signing keys and temporary files. They do not connect to a database, provider, R2 or GitHub. Existing preview bytes are used for compatibility tests.

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

The evidence supports the local portions of GOV-01/02/03/22, path/input safety and v1 compatibility; it does not mark those full product requirements passed. Release-proof purpose tests are not execution-token tests. Three real consumer checkouts, TS/Rust conformance, Windows/macOS, trusted GitHub checks, production publishers and runtime rejection remain unverified. All source acceptance rows remain `not_run` until their complete required evidence exists.
