# Opt-in native owner acceptance with one real OpenRouter inference

This operator-only harness runs the production main/broker bundles in local
workerd, with an owned disposable PostgreSQL server and native R2 **emulator**.
It creates synthetic owners and pairing, installs a synthetic recovery/readiness
authority, ingests a runtime private-file key directly through the separate setup
origin, then uses genuine OpenRouter HTTPS. Node forwards the native adapter's
fixed HTTPS requests; it does not fabricate provider responses. It does not
attest remote R2, Cloudflare routing, real browser ingress, capture policy, or a
human browser interaction. Production flags and deployment configuration are unchanged.

Run only after the user authorizes this provider, exact model, expiry and budget.
Use a dedicated local PostgreSQL instance with an `fp_*` admin database; the
existing fixture creates and removes its own `freedom_staging_next` database and
restricted roles. Do not point it at a shared database server. Build first.

The root operator creates two mode-0700 directories: one new receipt directory
for this attempt and one shared budget ledger for **all calls using this session
key**, including earlier connectivity calls. In the ledger, create mode-0600
`session.json` once, with the actual approved expiry:

```json
{
  "profile": "private-ai.provider-session-ledger/v1",
  "maxUsd": 10,
  "expiresAt": "<approved ISO expiry>",
  "priorReservedUsd": 0.10,
  "priorKnownCostUsd": 0.0000532
}
```

Those prior values describe the initial authorized connectivity call for this
session; increase them for any additional earlier calls. Each harness attempt
atomically reserves another $0.10, retained even after success or an unknown
outcome. Every other provider-testing process must use the same ledger or first
be reconciled into its prior reservation. Do not run independent unaccounted
provider tests concurrently. An abandoned `reservation.lock` requires root
review; the harness never removes a lock it did not acquire. Provider daily
limits and delayed usage counters do not replace this session ledger.

Create a private configuration file (no model key inside):

```json
{
  "profile": "private-ai.openrouter-owner-acceptance/v1",
  "acknowledgeRealProvider": true,
  "expectedRelease": "<exact clean 40-character source SHA>",
  "keyFile": "<existing mode-0600 raw key file, no trailing newline>",
  "receiptDirectory": "<new existing mode-0700 receipt directory>",
  "ledgerDirectory": "<shared existing mode-0700 session ledger directory>",
  "model": "openai/gpt-4.1-mini",
  "expiresAt": "<approved ISO expiry>",
  "maxUsd": 10
}
```

From the clean release checkout:

```sh
npm run build
TEST_DATABASE_URL='<owned loopback PostgreSQL fp_* admin URL>' node --import tsx scripts/verify-openrouter-native-owner.ts --config '<private config file>'
```

The source SHA must match and the checkout must be clean. No provider key enters
an environment variable, main Worker binding, command line, receipt, or output.
The harness reads raw key bytes only immediately before the separate-origin
ingest, then clears its buffer. It exclusively creates and fsyncs the intent,
budget reservation, execution metadata, dispatch intent and final receipt.
Neither an existing intent nor receipt is overwritten. It prints only fixed
success/unavailable codes; raw errors, responses, key material and paths are not
printed. Exit 2 means unavailable; inspect the private receipt's fixed stage and
checks, fixed checkpoint and latest HTTP status. No error text or response body is recorded. Do not automatically rerun, create another attempt directory, or retry
an unknown dispatch.

Before forwarding its only inference POST, the guard verifies the approved key
expiry, bounded limit, exact model metadata and pricing, max 128 completion
tokens, no fallback/tools, and a conservative cost estimate below the $0.10
reservation. It records the provider-reported response cost when available.
The gate remains spent on timeout/error, and its durable dispatch-intent file
prevents another process using that attempt directory from sending again.

The sequence verifies direct ingest and SQL custody, activation, broker isolate
replacement, activation ACK without provider traffic, one inference, owner
Result and emulator R2 byte equality, foreign-owner refusal, completed replay
after another replacement, owner API text edit with a new human revision and unchanged model source, recovery withdrawal, Stop and Revoke. Replays happen
only after confirmed success. Another reserved draft exercises Stop without a
second inference. Generated text is not saved to receipts; only hash/byte count.
Local SQL and emulator state are cleaned up. Receipt labels explicitly retain
all remote/operator/browser evidence as `not_run` or synthetic.

Hermetic verification (no real provider):

```sh
node --import tsx --test tests/worker/openrouter-acceptance-guard.test.ts
TEST_DATABASE_URL='<owned loopback PostgreSQL fp_* admin URL>' node --import tsx --test tests/worker/private-ai-native-owner-flow.test.ts
TEST_DATABASE_URL='<owned loopback PostgreSQL fp_* admin URL>' node --import tsx --test tests/worker/openrouter-native-owner-harness.test.ts
```

The full harness regression injects a synthetic transport through the imported
function (there is no CLI transport override). Its intent/receipt explicitly say
`synthetic_test_transport` and `test_worktree`; it may test uncommitted source and
never establishes real-provider evidence. The real CLI still requires a clean
exact SHA. It exercises the same two native restarts, edit and source comparison,
then reacquires a current-generation R2 handle before checking retained objects.
Run fixed-database native fixtures serially on their dedicated server.
