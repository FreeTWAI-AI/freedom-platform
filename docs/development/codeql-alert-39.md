# CodeQL alert 39: random session-token dataflow

Disposition applied: **alert39 only was dismissed as a false positive** on
2026-10-04 at 16:34:38 UTC. The root agent acted under Ted's instruction to
resolve the outstanding work and merge PR108, after the independent Sol review
and a second source review. GitHub readback confirms `dismissed_reason: false
positive` and PR-head instance state `dismissed`. The SHA-256 input is an
independently random 256-bit session token; passwords use salted scrypt.
This is a specific reviewed false-positive disposition, not acceptance of weak
password hashing or removal of the CodeQL query. The new PR-head checks must
still complete before merge; disposition alone does not establish CI success.

Reviewed evidence is pinned to PR108 head `a1adecc9da819209dcc7248f3387cb355ea782de`,
ref **`refs/pull/108/head`**, JavaScript/TypeScript analysis **1888288476**,
created `2026-10-04T09:20:41Z`. The SARIF contains five results; this review
addresses only `js/insufficient-password-hash`, alert39 at
`modules/identity-membership/service.ts:11`. Its message has **ten numbered
login source locations**, while `codeFlows` still contains **four expanded
paths** (nine steps each). Its fourteen related locations comprise those ten
numbered sources and four unnumbered duplicate sources for the expanded paths.
Ten message entries must not be described as ten expanded SARIF paths.

All ten current source call sites and their imported production functions were
individually read, as were all 36 expanded path steps. Every site selects the
`.token` property of the successful `login` result before calling the imported
`authenticate`; none supplies its password string as that argument.

| SARIF source | Current location | Actual selected value | Expanded path in this SARIF |
| --- | --- | --- | --- |
| 1 | `tests/runtime/credential-ingest-authorizations.test.ts:83` | `signedIn.token` at line84 | 1 |
| 2 | `tests/runtime/credential-ingest-authorizations.test.ts:139` | `signed.token` at line139 | 2 |
| 3 | `tests/runtime/credential-ingest-helpers.ts:110` | `session.token` at line110 | 3 |
| 4 | `tests/runtime/member-model-settings-helpers.ts:108` | `session.token` at line108 | 4 |
| 5 | `tests/runtime/member-model-settings.test.ts:84` | `signed.token` at line84 | not supplied |
| 6 | `tests/runtime/model-broker-authorizations.test.ts:89` | `signedIn.token` at line90 | not supplied |
| 7 | `tests/runtime/model-broker-authorizations.test.ts:148` | `another.token` at line148 | not supplied |
| 8 | `tests/runtime/model-broker-client.test.ts:89` | `signedIn.token` at line90 | not supplied |
| 9 | `tests/runtime/model-broker-process.test.ts:104` | `session.token` at line104 | not supplied |
| 10 | `tests/worker/broker-worker-sql.test.ts:93` | `session.token` at line93 | not supplied |

Each expanded path starts at the return value of `login`, follows its awaited
result/local variable, selects `.token`, enters `authenticate(raw)` at line56,
then follows `raw` through the session query's `tokenHash(raw)` at line60 to
SHA-256 at line11. Sources5–10 have no expanded paths in this artifact; their
same value selection is established by individually reading current source,
not by extrapolating the previous four paths.

Production `login` first verifies the supplied password with `matches` at
line41, using `derive`/salted scrypt at lines22/16. Only after successful
verification does it independently generate
`randomBytes(32).toString('base64url')` at line46. It inserts the token's hash
into `sessions` at line48 and returns that token at line50. `authenticate`
checks the 43-character token shape at line57 and hashes it for current session
lookup at line60 (and last-seen update at line64). Password creation separately
uses a random16-byte salt and a scrypt-derived64-byte value at lines12–18.
`login` also hashes normalized email at line32 for the rate-limit key; that is
not the input in these four expanded paths. No password-to-token assignment
appears in this source. This alert is not evidence of fast unsalted password
storage. The version-matched upstream CodeQL source model was inspected at the
`codeql-cli/v2.27.1` tag (commit `e7871f5403f68f679e57d627cf0d43c5d25cde12`).
[`SensitiveCall`](https://github.com/github/codeql/blob/codeql-cli/v2.27.1/javascript/ql/lib/semmle/javascript/security/SensitiveActions.qll#L29)
classifies the entire return of a call as sensitive when any argument has a
sensitive string value.
[`maybePassword`](https://github.com/github/codeql/blob/codeql-cli/v2.27.1/shared/concepts/codeql/concepts/internal/SensitiveDataHeuristics.qll#L76)
includes strings containing `password`. For example, the first source passes
`synthetic-member-password` to `login`; the heuristic classifies its returned
object as password data, then the reported flow selects the independently
random `.token`. This identifies a concrete model mismatch, rather than a
password-to-token assignment. Changing fixture strings or aliases merely to
avoid this heuristic would not fix a cryptographic vulnerability; no such
change is proposed.

The entire production service is byte-identical to current `origin/main`
`3de70ccbd24362a7925508fb42d36aaa256a0806`: SHA-256
`deaf732ec639c417953404192dba057e7252caefc282a3db8e13379b97676276` on both.
All ten current call/token excerpts and all 36 expanded path steps were
rechecked from this source and SARIF. Current SARIF SHA-256 is
`9a22a7610964ccc586106b9096b1519da408a95ea19140c7e150556664a7b395`.

[Analyze run37191741135](https://github.com/FreeTWAI-AI/freedom-platform/actions/runs/37191741135)
completed successfully, but
[CodeQL security check111405290239](https://github.com/FreeTWAI-AI/freedom-platform/runs/111405290239)
**failed** before disposition, reporting one new high security alert. Alert39's PR-head instance was open at that analysis; the readback above records the
subsequent disposition. A zero-result merge-ref analysis, analyzer completion, local
tests or this document cannot replace the failing PR-head security gate.
The other four JavaScript SARIF result keys (rule, path, line) are unchanged
from analysis1888173960 at d134371. Each current flagged expression was read:

| Rule | Location | Reviewed behavior |
| --- | --- | --- |
| `js/bad-tag-filter` | `tests/e2e/skill-book-library.spec.ts:191` | Assertion checking generated HTML script tags; lowercase regex is incomplete test coverage, not a production sanitizer. |
| `js/incomplete-sanitization` | `packages/skill-upload-client/test/cli.test.mjs:137` | Regex built from the synthetic test server's locally generated origin; not untrusted URL escaping in the CLI. |
| `js/incomplete-url-substring-sanitization` | `tests/runtime/published-skills.test.ts:39` | Assertion that Markdown includes a source issue URL; no URL authorization or sanitizer decision. |
| `js/incomplete-url-substring-sanitization` | `tests/runtime/social-links.test.ts:62` | Negative assertion that a revoked private URL is absent from a captured DTO; no URL authorization or sanitizer decision. |

No new production vulnerability or must-fix migration blocker was identified
in those four reported expressions. This is not a blanket disposition of
other alerts. Improving test assertion coverage can remain follow-up work.
Exact-head Python analysis1888286703 and Actions analysis1888286440 report
zero results.

A minimal upstream model reproducer remains useful follow-up and should
preserve real password verification and the independent random token. No alias
rename, query exclusion, password/token crypto change, scanner configuration,
trust/rules change or account migration was performed to resolve this alert.
The only remote security mutation was the documented alert39 disposition.

Current raw SARIF is retained in the isolated security worktree at
`.freedom/reports/codeql-1888288476.sarif.json`. Previous structured audits
remain historical evidence.

Historical GitHub gate readback earlier on 2026-10-04: `main` reports `protected: false`, the
branch-protection endpoint returns `404 Branch not protected`, and repository
rulesets are `[]`. Head checks observed during that readback were emitted by GitHub Actions
(App ID 15368) and CodeQL/GitHub Advanced Security (App ID 57789); no trusted
operator publisher check appears for this head. That readback observed no required or App-bound merge gate. Installing and configuring the
trusted publisher, requiring its exact check name and App ID, and enforcing
the security decision remain separate operator work. The diagnostic workflow
or its comments do not establish this configuration. No remote settings or
alert dispositions were changed during this readback.

## Exact dismissal reason and acceptance boundary

Applied GitHub reason: `false positive`. The concise submitted comment is:

> False positive: all 10 flows select login().token from independent randomBytes(32); SHA-256 is used for session lookup. Passwords use random salt + scrypt. Reviewed analysis 1888288476; full source/SARIF evidence in docs/development/codeql-alert-39.md.

Full independent review rationale:

> Reviewed PR108 source a1adecc9da819209dcc7248f3387cb355ea782de and
> CodeQL2.27.1 analysis1888288476. All ten sources select login's returned
> .token, generated independently with randomBytes(32), before authenticate
> hashes it for session lookup. Password verification/storage use randomly
> salted scrypt (16-byte salt,64-byte derived key). The version-matched
> SensitiveCall heuristic marks the entire login return as password data
> because synthetic password arguments contain the literal word "password".
> Four expanded paths confirm this object-to-token model mismatch. SHA256 is
> hashing a random256-bit bearer token, not a user password. Disposition applies
> only to alert39; no crypto, query, test text or scanner configuration changed.

Acceptance depends on the verified token/password separation and actual
randomness remaining intact. Re-review if passwords flow into tokenHash,
randomness becomes predictable, or the reported flow changes. This is not
risk acceptance of fast password hashing and does not exclude a query to
obtain a green check. A doc-only follow-up commit changes this review's head
but not the pinned source; new non-document changes require exact-head review.
