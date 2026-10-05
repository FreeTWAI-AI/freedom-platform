# Exact consumer library updates

`exportConsumerLibraries` is an opt-in companion to `exportPreviewBundle`. It installs shared runtime libraries for agent-kit, storefront and supplier-client without changing `contracts.lock.json` or any preview-v1 bytes. It requires clean checkouts at the exact commits in `repositories.lock.json`, validates every destination before writing, and refuses uncommitted source bytes. It performs no Git commit, remote write, release approval or feature enablement.

From a committed Platform checkout, prepare the independently cloned consumer bases:

```js
import { exportConsumerLibraries } from './packages/contribution-tools/export.mjs';
await exportConsumerLibraries([
  { repository: 'FreeTWAI-AI/freedom-agent-kit', root: '/absolute/agent-kit' },
  { repository: 'FreeTWAI-AI/freedom-storefront', root: '/absolute/storefront' },
  { repository: 'FreeTWAI-AI/freedom-supplier-client', root: '/absolute/supplier-client' },
], { expectedSourceCommit: 'EXTERNALLY_SELECTED_PLATFORM_SHA' });
```

Then make the concrete consumer source changes:

- Agent-kit `src/index.mjs` re-exports `loadMemberWorkspace` from `../vendor/freedom-libraries/packages/sdk/member-workspace.mjs`. Its CLI still uses its independently pinned preview SDK for the five member reads, with demo authentication restricted to loopback.
- Storefront `src/index.mjs` adds `loadConnectedStorefront` from `../vendor/freedom-libraries/packages/client-connections/storefront-workspace.mjs`. This uses the shared `ScopedReadClient` for connection metadata and the three approved-store resources. Supplier scope, mixed-store responses and revoked tokens reject the read. Existing preview write helpers remain separate.

- Supplier-client `src/index.mjs` re-exports `loadSupplierWorkspace` and `ScopedReadClient` from the canonical `vendor/freedom-libraries/packages/client-connections` modules. It preserves the connection/products/requests order and rejects storefront scope or revoked reads.

The generated `consumer-libraries.lock.json` records exact source paths, bytes and commit. It deliberately does not claim runtime usage, publisher trust or ReleaseSet approval. A host can invoke `verifyConsumerLibraries` from its independently selected Platform source without executing consumer code. The consumer CLI is a convenience, not an independent security boundary:

```sh
node scripts/verify-consumer-libraries.mjs FreeTWAI-AI/freedom-agent-kit EXPECTED_PLATFORM_SHA --source-root /path/to/platform
```

Select the expected SHA outside the candidate lock. Local verification reads committed Git objects; `--remote` instead reads that exact public commit with bounded requests and no redirects. Before remote consumer publication, make the source commit publicly reachable or re-export from the final published Platform commit. A cherry-pick creates a different SHA; changing only a claimed source pin without matching its committed bytes is insufficient.

## Upgrading already adopted consumers

Do not reset an adopted consumer to its old repository-lock baseline. Commit and review its current imports/tests, then supply that exact current consumer SHA and the independently selected previous Platform source SHA:

```js
await exportConsumerLibraries([
  {
    repository: 'FreeTWAI-AI/freedom-agent-kit', root: '/absolute/agent-kit',
    upgradeFrom: { consumerCommit: 'REVIEWED_CURRENT_CONSUMER_SHA', sourceCommit: 'PREVIOUS_PLATFORM_SHA' },
  },
], { sourceRoot: '/absolute/platform', expectedSourceCommit: 'NEW_PLATFORM_SHA' });
```

The producer HEAD must equal `expectedSourceCommit`; exported files must match that committed source. The previous source commit must be available in the producer Git object database. Upgrade verification compares the old manifest and every exported runtime/tooling file against that canonical old source, requires a clean consumer at the selected HEAD, and preflights the whole batch before writes. Modified exported tooling is rejected even if committed, so custom edits cannot be silently lost. Consumer-owned imports, tests, README, package scripts and preview files are preserved. The generated manifest records the reviewed current consumer commit as its new base. The exporter does not commit, reset, push or execute consumer code.

## Explicit library profiles

Omitting `expectedLibraryProfile` preserves `legacy-v1`: the current per-consumer
artifact sets and v1 lock format. Agent-kit can separately opt into
`agent-kit-device-v1`, whose exact artifact set is `packages/sdk/member-workspace.mjs`
and the dependency-free `packages/sdk/machine-device-client.mjs`. It uses a v2
lock with `profile: "agent-kit-device-v1"`. The source commit must contain both
committed files. Storefront and supplier-client retain their existing defaults;
they cannot select the Kit profile. There is no caller-defined file list.

```js
await exportConsumerLibraries([{
  repository: 'FreeTWAI-AI/freedom-agent-kit', root: '/absolute/agent-kit',
  expectedLibraryProfile: 'agent-kit-device-v1',
  upgradeFrom: {
    consumerCommit: 'REVIEWED_CURRENT_CONSUMER_SHA', sourceCommit: 'PREVIOUS_PLATFORM_SHA',
    expectedLibraryProfile: 'legacy-v1',
  },
}], { sourceRoot: '/absolute/platform', expectedSourceCommit: 'NEW_PLATFORM_SHA' });
```

The operator selects both old and new profiles independently of the lock. For a
later device-profile update, `upgradeFrom.expectedLibraryProfile` must also be
`agent-kit-device-v1`; omission still means legacy. A profile change that removes
artifacts is rejected before writes because this exporter does not delete retired
files. It does not silently downgrade and leave executable artifacts behind.

Local verification likewise requires an explicit selection:

```sh
node scripts/verify-consumer-libraries.mjs FreeTWAI-AI/freedom-agent-kit EXPECTED_PLATFORM_SHA --source-root /path/to/platform --profile agent-kit-device-v1
```

The optional `--profile` also follows `--remote`. Neither CLI input nor a changed
lock installs a trusted gate or proves SDK invocation. The native host must be
separately reviewed and installed with the same exact repository/profile/source
tuple. Existing pinned workflows and source pins remain unchanged by export;
their default profile intentionally rejects a new device-profile candidate.
Device CLI behavior, private execution grants and runtime invocation require
their own evidence beyond this source distribution check.

## Operation verification

Pure tests (also included by `npm run test:governance`):

```sh
node --test packages/contribution-tools/test/export.test.mjs packages/contribution-tools/test/consumer-libraries.test.mjs packages/contribution-tools/test/consumer-workspace.test.mjs
```

Run each consumer's `npm test`, plus agent-kit `npm run build` and both read consumers’ `npm run verify:client-source`. The existing `governance-consumers` CI job runs both repository integration suites through `npm run test:repos`. It checks out `repositories.lock.json`, fetches the immutable library source, verifies the three adopted consumers' clean locked HEADs and canonical library bytes, and invokes their real entrypoints against isolated HTTP/PostgreSQL fixtures:

```sh
export FREEDOM_REPOSITORIES_ROOT=/absolute/fresh-consumer-checkouts
node scripts/checkout-repositories.mjs
npm run test:repos
```

The checkout entrypoint obtains the exact `consumer_library_source` Git object from `repositories.lock.json` when absent, including in shallow CI checkouts; it does not change the source checkout's HEAD or files. Tests use that reviewed pin when `FREEDOM_CONSUMER_SOURCE_COMMIT` is unset, and still verify every consumer's source bytes. An explicit override remains available for local adoption work and must match those bytes; a missing object or mismatched pin fails rather than skipping verification.

This requires an explicitly allocated disposable `TEST_DATABASE_URL`. For local adoption work before a reviewed lock update, leave `FREEDOM_REPOSITORIES_ROOT` unset and select candidate checkouts explicitly:

```sh
FREEDOM_AGENT_KIT_ROOT=/absolute/agent-kit \
FREEDOM_STOREFRONT_ROOT=/absolute/storefront \
FREEDOM_SUPPLIER_CLIENT_ROOT=/absolute/supplier-client \
FREEDOM_CONSUMER_SOURCE_COMMIT=EXPECTED_PLATFORM_SHA \
node --import tsx --test --test-concurrency=1 tests/integration/consumer-libraries.test.ts
```

These suites use their own temporary schemas. The adoption suite verifies source bytes first, then tests the kit's real preview operations and storefront/supplier HTTP pairing, approved/owner-scoped SQL rows, wrong-scope rejection and revocation. Synthetic fixture onboarding is explicit. The resulting behavior evidence is limited to these operations and fixtures; it does not establish human approval or production provider acceptance. The separate native source guard continues to report runtime library usage as `not_checked`.

## Nine locked consumers: runtime inventory

At the existing `repositories.lock.json` commits, the observed source paths are:

| Consumer | Existing runtime usage | This bounded update |
| --- | --- | --- |
| freedom-agent-kit | `packages/client` imports preview SDK; CLI/member workspace executes five read operations | Import the shared member-workspace reader |
| freedom-storefront | Session SDK helpers execute preview operations; `client/cli.mjs` uses copied scoped read client | Add shared connection-to-workspace reader |
| freedom-growth-automation | `src/index.mjs` accepts a preview client for campaign, supply and project operations | Unchanged baseline |
| freedom-skill-registry | `src/index.mjs` accepts a preview client for project list/import | Unchanged baseline |
| freedom-supplier-client | `src/index.mjs` and client CLI use copied scoped supplier read client | Import shared scoped transport and supplier workspace reader |
| freedom-project-page | Public manifest rendering; no Platform transport operation in its product entrypoint | Unchanged baseline |
| freedom-project-template | Project skeleton/manifest; no Platform transport operation in its product entrypoint | Unchanged baseline |
| FreeTWAI-AI.github.io | Static project-directory generation | Unchanged baseline |
| .github | Community templates and workflow definitions | Unchanged baseline |

Vendored files and source inspection alone are not operation evidence. The integration tests exercise the named paths, not all nine consumer surfaces or the future execution libraries. Preview compatibility, library adoption and installed governance enforcement remain separate facts.

When testing a supplier candidate exported from a different intermediate source commit, explicitly set `FREEDOM_SUPPLIER_SOURCE_COMMIT` to that independently selected SHA; otherwise it uses the common expected source SHA. Final batch publication should use the final intended source pins.

## Versioned bootstrap CLI closure

`agent-kit-device-cli-v1` adds `packages/sdk/machine-device-cli.mjs` to the
existing device SDK set and generates `src/device-cli.mjs` from the producer's
`scripts/repository-bootstrap/agent-kit-device-cli.mjs`. The launcher and command
are intentionally versioned trust material: a direct relative import, fixed
pairing/refresh/status sequence and public-only JSON, without candidate callbacks
in the real CLI. `runDeviceCli` remains exported for isolated unit tests. The
supported command accepts exactly HTTPS origin, environment and client ID; it
provides bootstrap status only, never execution authority or durable custody.

The exporter requires the caller's explicit new profile and exact previous
profile/source/consumer tuple. It validates and writes the generated launcher
alongside canonical library artifacts, before the lock. It leaves preview v1 and
other consumer profiles unchanged. The source verifier compares the launcher to
the same independently selected producer commit. Merely installing this profile
is source evidence, not runtime invocation evidence or permission to upgrade an
installed workflow. A future trusted runtime gate must additionally launch this
exact closure in its isolated candidate snapshot and observe protocol behavior.
