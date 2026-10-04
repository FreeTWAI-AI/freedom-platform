# CodeQL alert 39: random session-token dataflow

Disposition for review: the SHA-256 input in these reported paths is an
independently random session token, not the login password. This supports a
specific false-positive disposition; it is not formal acceptance. Keep the
GitHub security gate pending until an authorized decision.

Current evidence is PR108 head `f9005950739b62a71ee71ed31b2480323cf6d848`,
ref **`refs/pull/108/head`**, JavaScript/TypeScript analysis **1887441437**,
created `2026-10-04T01:39:45Z`. The SARIF contains five results; this review
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
| 4 | `tests/runtime/member-model-settings.test.ts:84` | `signed.token` at line84 | 4 |
| 5 | `tests/runtime/member-model-settings-helpers.ts:108` | `session.token` at line108 | not supplied |
| 6 | `tests/runtime/model-broker-authorizations.test.ts:89` | `signedIn.token` at line90 | not supplied |
| 7 | `tests/runtime/model-broker-authorizations.test.ts:148` | `another.token` at line148 | not supplied |
| 8 | `tests/runtime/model-broker-client.test.ts:89` | `signedIn.token` at line90 | not supplied |
| 9 | `tests/runtime/model-broker-process.test.ts:104` | `session.token` at line104 | not supplied |
| 10 | `tests/worker/broker-worker-sql.test.ts:89` | `session.token` at line89 | not supplied |

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
storage. The precise CodeQL source-model implementation was not independently
inspected, so the model-confusion cause remains an interpretation of the
reported paths and actual code.

The entire production service is byte-identical to current `origin/main`
`3de70ccbd24362a7925508fb42d36aaa256a0806`: SHA-256
`deaf732ec639c417953404192dba057e7252caefc282a3db8e13379b97676276` on both.
Current source-file hashes and all ten call/token excerpts are retained in the
structured audit. Current SARIF SHA-256 is
`11bc678a9c79f30f52da2dbfe20ab4582664946826608259f54e1678ff55d584`.

[Analyze run37168541892](https://github.com/FreeTWAI-AI/freedom-platform/actions/runs/37168541892)
completed successfully, but
[CodeQL security check111336610411](https://github.com/FreeTWAI-AI/freedom-platform/runs/111336610411)
**failed**, reporting one new high security alert. Alert39's PR-head instance
is still open. A zero-result merge-ref analysis, analyzer completion, local
tests or this document cannot replace the failing PR-head security gate.
The other four SARIF results are outside this specific disposition.

Actionable next step: an authorized security reviewer can adjudicate alert39
using this exact current analysis, source selections and hashes. A minimal
upstream model reproducer should preserve real password verification and the
independent random token. No alias rename, query exclusion, dismissal,
password/token crypto change, trust/rules change or account migration was
performed. This is a documentation-only update; no new CodeQL run or formal
security approval is claimed.

Locally retained raw evidence:
`.freedom/reports/codeql-alert39-current-1887441437.sarif.json`,
`codeql-alert39-current-alert.json`, `codeql-alert39-current-run.json`,
`codeql-alert39-current-check.json`, and the structured
`.freedom/reports/codeql-alert39-current-dataflow-audit.json`.
The earlier analysis1886887877 remains historical evidence, not the authority
for this ten-source review.
