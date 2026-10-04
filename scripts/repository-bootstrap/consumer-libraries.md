# Exact consumer library updates

`exportConsumerLibraries` is an opt-in companion to `exportPreviewBundle`. It installs shared runtime libraries for agent-kit and storefront without changing `contracts.lock.json` or any preview-v1 bytes. It requires clean checkouts at the exact commits in `repositories.lock.json`, validates every destination before writing, and refuses uncommitted source bytes. It performs no Git commit, remote write, release approval or feature enablement.

From a committed Platform checkout, prepare the two independently cloned consumer bases:

```js
import { exportConsumerLibraries } from './packages/contribution-tools/export.mjs';
await exportConsumerLibraries([
  { repository: 'FreeTWAI-AI/freedom-agent-kit', root: '/absolute/agent-kit' },
  { repository: 'FreeTWAI-AI/freedom-storefront', root: '/absolute/storefront' },
], { expectedSourceCommit: 'EXTERNALLY_SELECTED_PLATFORM_SHA' });
```

Then make the concrete consumer source changes:

- Agent-kit `src/index.mjs` re-exports `loadMemberWorkspace` from `../vendor/freedom-libraries/packages/sdk/member-workspace.mjs`. Its CLI still uses its independently pinned preview SDK for the five member reads, with demo authentication restricted to loopback.
- Storefront `src/index.mjs` adds `loadConnectedStorefront` from `../vendor/freedom-libraries/packages/client-connections/storefront-workspace.mjs`. This uses the shared `ScopedReadClient` for connection metadata and the three approved-store resources. Supplier scope, mixed-store responses and revoked tokens reject the read. Existing preview write helpers remain separate.

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

## Operation verification

Pure tests (also included by `npm run test:governance`):

```sh
node --test packages/contribution-tools/test/export.test.mjs packages/contribution-tools/test/consumer-libraries.test.mjs packages/contribution-tools/test/consumer-workspace.test.mjs
```

Run each consumer's `npm test`, plus agent-kit `npm run build` and storefront `npm run verify:client-source`. For real API/PostgreSQL tests, use only an explicitly allocated disposable database and the actual candidate checkouts:

```sh
FREEDOM_AGENT_KIT_ROOT=/absolute/agent-kit \
FREEDOM_STOREFRONT_ROOT=/absolute/storefront \
FREEDOM_CONSUMER_SOURCE_COMMIT=EXPECTED_PLATFORM_SHA \
node --import tsx --test --test-concurrency=1 tests/integration/consumer-libraries.test.ts
```

This command requires `TEST_DATABASE_URL` and uses its own temporary schema. It verifies source bytes first, then tests the kit's real preview operations and storefront's HTTP pairing, approved SQL rows, wrong-scope rejection and revocation. Synthetic fixture onboarding is explicit. It does not establish human approval or production provider acceptance. Also run the existing `test:repos` with a directory containing the two candidates plus seven pinned baseline checkouts; record their actual commits separately until an approved consumer batch updates the repository lock.

## Nine locked consumers: runtime inventory

At the existing `repositories.lock.json` commits, the observed source paths are:

| Consumer | Existing runtime usage | This bounded update |
| --- | --- | --- |
| freedom-agent-kit | `packages/client` imports preview SDK; CLI/member workspace executes five read operations | Import the shared member-workspace reader |
| freedom-storefront | Session SDK helpers execute preview operations; `client/cli.mjs` uses copied scoped read client | Add shared connection-to-workspace reader |
| freedom-growth-automation | `src/index.mjs` accepts a preview client for campaign, supply and project operations | Unchanged baseline |
| freedom-skill-registry | `src/index.mjs` accepts a preview client for project list/import | Unchanged baseline |
| freedom-supplier-client | `src/index.mjs` and client CLI use copied scoped supplier read client | Unchanged baseline |
| freedom-project-page | Public manifest rendering; no Platform transport operation in its product entrypoint | Unchanged baseline |
| freedom-project-template | Project skeleton/manifest; no Platform transport operation in its product entrypoint | Unchanged baseline |
| FreeTWAI-AI.github.io | Static project-directory generation | Unchanged baseline |
| .github | Community templates and workflow definitions | Unchanged baseline |

Vendored files and source inspection alone are not operation evidence. The integration tests exercise the named paths, not all nine consumer surfaces or the future execution libraries. Preview compatibility, library adoption and installed governance enforcement remain separate facts.
