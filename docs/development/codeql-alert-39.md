# CodeQL alert 39: random session-token dataflow

Disposition for review: the reported SHA-256 input is a random session token, not a password. Keep the GitHub security gate pending until an approved decision.

All nine related source locations directly import the production `login` and `authenticate`. Their passwords enter salted scrypt; each successful login separately creates `randomBytes(32).toString('base64url')` at `modules/identity-membership/service.ts:45`. The returned `.token` enters `authenticate` at line56 and is hashed for session lookup at line60, reaching the SHA-256 helper at line11. The password enters `matches`/`derive` at lines40/22/16, not this token lookup.

| SARIF source | Current location | Actual value |
| --- | --- | --- |
| 1 | `tests/runtime/credential-ingest-authorizations.test.ts:83` | independently random `login(...).token` → `authenticate` |
| 2 | `tests/runtime/credential-ingest-authorizations.test.ts:139` | independently random `login(...).token` → `authenticate` |
| 3 | `tests/runtime/credential-ingest-helpers.ts:110` | independently random `login(...).token` → `authenticate` |
| 4 | `tests/runtime/member-model-settings.test.ts:84` | independently random `login(...).token` → `authenticate` |
| 5 | `tests/runtime/member-model-settings-helpers.ts:108` | independently random `login(...).token` → `authenticate` |
| 6 | `tests/runtime/model-broker-authorizations.test.ts:89` | independently random `login(...).token` → `authenticate` |
| 7 | `tests/runtime/model-broker-authorizations.test.ts:148` | independently random `login(...).token` → `authenticate` |
| 8 | `tests/runtime/model-broker-client.test.ts:89` | independently random `login(...).token` → `authenticate` |
| 9 | `tests/runtime/model-broker-process.test.ts:104` | independently random `login(...).token` → `authenticate` |

The SARIF supplies four explicit flows, originating at sources1,2,3,4. All begin at the **return value** of `login`, then select `.token`, enter `authenticate(raw)`, and reach `tokenHash(raw)`. The other five are related locations without explicit path expansions in this artifact; their current-source expressions were individually checked and use the same imported functions and `.token` field. No inferred password-to-token assignment is present. This supports a false-positive source-model disposition for this specific alert; the underlying CodeQL model implementation was not independently inspected.

Production service bytes are identical to `origin/main` (3de70ccbd24362a7925508fb42d36aaa256a0806), SHA-256 `deaf732ec639c417953404192dba057e7252caefc282a3db8e13379b97676276`. Existing password storage uses random16-byte salt and scrypt-derived64-byte values; this alert is not evidence of fast unsalted password storage.

Actionable next step: authorized security reviewer can adjudicate alert39 using the attached exact paths and hashes. A minimal upstream model reproducer may preserve the real login/password verification plus independent random token. Do not rename aliases to evade the model, exclude the query, change token/password crypto, or begin an account migration for this alert. No remote decision or gate change was performed.

Locally retained structured evidence: `.freedom/reports/base-codeql-alert39-dataflow-audit.json`. GitHub analysis `1886887877` applies to PR108 head `787098258155377fbd79aa0b77714eb2f9f3ee8c`, ref `refs/pull/108/head`. SARIF SHA-256 `fa9b1f1387787ce05030b2ddb78bdeb7eaf7bd6c76edc1b6fb00d910ca39ae60`; checked local source head `0026383843cb5040b4033dbc27712c9aeb32d74b`. This review covers alert39 only.
