# Bounded source-registration audit

`surface-audit.mjs` is a read-only internal host/harness port, not a GitHub check
publisher or a replacement for `verifyWorkspace`. It does not change
`context.mjs`, `verify.mjs`, `trusted-ci.mjs`, their impact calculation, or the
unconditional `registration_behavior_audit_required` blocker. No consumer export
or production runtime dependency is added by this slice.

## What it compares

The fixed `platform-member-routes/v1` profile maps these actual source
registrations to the already-declared operation IDs:

| Factory | Method and mounted path | Operation |
| --- | --- | --- |
| `createAvatarRoutes` | GET `/api/v1/me/avatar` | `member.avatar.metadata` |
| `createAvatarRoutes` | POST `/api/v1/me/avatar` | `member.avatar.replace` |
| `createAvatarRoutes` | POST `/api/v1/me/avatar/remove` | `member.avatar.remove` |
| `createAvatarRoutes` | GET `/api/v1/members/:id/avatar` | `member.avatar.read` |
| `createPrivateWorkRoutes` | GET `/api/v1/me/private-work` | `work.private.list` |
| `createPrivateWorkRoutes` | GET `/api/v1/me/private-work/:id` | `work.private.read` |

Operation IDs are not inferred from request handlers, URL words, comments or
descriptor claims. The mapping is reviewed host code. Both baseline and
candidate must independently match it. HTTP HEAD behavior inherited from Hono
is not a separate explicit registration or a behavior proof from this audit.

The admitted leaf grammar is intentionally narrow: an exported, synchronous,
non-generator function, one direct `const app = new Hono<...>()`, top-level
direct `app.get/post(string literal, arrow handler)` statements, the fixed
private-work `app.use` path, and a final `return app`. The only other leaf setup
allowed is the reviewed avatar `uploadAvatar = createAvatarUploadFacade(pool,
{store, legacySave: (input, upload) => saveAvatar(pool, input, upload)})` shape.
Arbitrary constant initializers, including throwing IIFEs, are not admitted.
Hono must be a
direct unaliased named import from `hono`. All receiver references, including
escaped identifier spelling and template interpolations, are inspected.
Computed members, method/receiver aliases, conditional/nested registration,
optional calls, nonliteral paths, extra methods/routes, middleware changes,
constructor aliases and receiver escapes fail closed. Handler implementation
is not interpreted or executed.

`platform-app.ts` must directly import the two fixed factory names from their
fixed route modules and mount each exactly once with
`app.route('/api/v1', factory(...))` in the body of `createPlatformApp`.
Missing/aliased/conditional mounts, changed import source/prefix, literal shadow
endpoints, early root return/throw, wrong final receiver, and root receiver
mutation/unknown escapes are detected. Four pre-existing public/member
promotion/service delegates are explicitly recognized as **uncovered** escapes,
not certified registration implementations. The aggregate's other routes, delegated helpers,
dynamic loops, middleware and runtime entrypoints remain **uncovered**.

`registration_status: passed` only means the fixed six leaf registrations and
their mount syntax matched. Overall `status` is always `unavailable` or
`failed`, never `passed`. Auth-profile equality checks a declaration, not actual
session/onboarding/CSRF/share/HEAD/304 behavior. Real runtime acceptance remains
mandatory. The report never authorizes execution or merge.
This is structural registration consistency, not semantic reachability: even
reviewed constructor/setup dependencies can throw or fail configuration at run
time. No static success here removes that runtime acceptance requirement.

## Host and data boundary

```js
auditSurfaceRegistrations({
  baseline: { paths: baselinePaths, read: readImmutableBaselineBytes },
  candidate: { paths: candidatePaths, read: readImmutableCandidateBytes },
  changedPaths, // host-computed, including deletions and rename endpoints
  profile: 'platform-member-routes/v1',
}, {
  parser: { api: installedParser, version, installationSha256 },
  approvedParser: { version: approvedVersion, installationSha256: approvedDigest },
});
```

These are in-process **trusted host** ports. The caller must authenticate and
freeze the baseline/candidate tree identity, path enumeration and reader;
the audit does not authenticate a Git tree, local filesystem, parser install or
publisher. A privileged host must load this auditor, its import closure and the
parser from an approved immutable installation outside candidate influence.
It must calculate/verify the parser installation digest over its real runtime
closure, not trust a candidate-provided digest or wrapper-package version.
Equal input digest strings alone are not a trust root. The report explicitly
labels parser provenance as host-supplied, not authenticated by this audit.

The implementation never imports, transpiles, compiles or runs candidate source,
configuration or test files. It never resolves an ambient/candidate parser,
follows a candidate module import, accesses a URL, spawns a command or writes a
file. The only reads are bounded source/descriptor bytes supplied by the host.
Parser availability/identity mismatch returns unavailable while still retaining
the descriptor union. The host must impose its normal process CPU/memory limits
as an additional boundary around parsing adversarial source.

Limits: 8,192 paths per revision; 256 descriptors; 128,000 bytes per selected
source/descriptor; 2,000,000 bytes across both revisions; fatal UTF-8 decoding;
30,000 AST nodes and depth 128 per source. Paths reject traversal and
case-colliding full names. Descriptor JSON uses the existing duplicate-key
rejecting reader/schema validator. Source bytes are copied and fingerprinted
before parsing. Reader/parser diagnostics never include external exception text
or source snippets. Returned paths are validated repo-relative paths.

Both revisions contribute module IDs, surface/operation IDs and required test
IDs. Removed declarations and decreased test lists cannot subtract baseline
requirements; new/changed declarations additionally require baseline review.
Unknown changed paths and non-covered declared surfaces remain `surface_unmapped`.
This port conservatively returns the union of every supplied descriptor's tests;
it does not replace the existing baseline/candidate impact or fallback logic.

## Parser installation and repeatability

TypeScript 7.0.2 remains the platform compiler. Its default package export no
longer contains the former synchronous `createSourceFile` API. Tests therefore
use Microsoft's official `@typescript/typescript6` compatibility package, pinned
at 6.0.2 as a **development-only** dependency. Microsoft describes this package
under [Running Side-by-Side in the TypeScript 7 announcement](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/).

The compatibility wrapper depends on `@typescript/old`; the committed lock pins
that actual parser to 6.0.3. Evidence records the actual `api.version`, not the
wrapper's version. Our local test fingerprint includes both the wrapper and
actual parser implementation bytes; it is synthetic harness evidence, not a
production-approved installation claim.

The transitive alias exposes a `tsc` bin and a clean npm installation can let it
win the shared `.bin/tsc` link. To keep the project's compiler deterministic,
`npm run typecheck` explicitly runs `node node_modules/typescript/bin/tsc`.
Do not substitute bare `tsc`/`npx tsc` for that command. No postinstall hook or
manual symlink repair is used. Clean `npm ci --ignore-scripts --no-audit`, then
`npm run typecheck -- --version` must still print `7.0.2`.

## Deliberate coverage gaps

Agent Kit's inspected local task checkout at
`84d30a342cc058b67b64e533e345a98e695d47a3` uses positional argv in `src/cli.mjs`,
then a `Promise.all` operation-array mapping in `src/index.mjs` and a separate
logout in `finally`. It has no matching Hono/command registration grammar.
Its adapter directories contain documentation; the MCP directory contains a
capability declaration, not evidence of a running tool. This slice does not
approve that CLI, MCP, page navigation, native bridges, queues, scheduled
handlers, arbitrary Hono modules or all platform routes. Unsupported profiles
remain unavailable. The Kit checkout is a local unpublished adoption, not an
approved release or verified external deployment.

Run the focused counterexamples with
`node --test packages/contribution-tools/test/surface-audit.test.mjs` after the
normal development install. Tests use real current avatar/private route sources
as data plus omitted/extra/aliased/dynamic/shadow registrations, deleted and
self-approving descriptors, parser mismatches and bounded malformed input.
