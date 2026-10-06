# 共用瀏覽器測試 harness

`e2e-harness` 是這個倉庫裡的一個模組，不是另一個 repo。它只擁有 Playwright 共用啟動與規格會 import 的 helper。功能規格 `tests/e2e/*.spec.ts` 仍屬於各功能模組；這次沒有把它們劃進來，也不使用 `tests/e2e/**`。

## 擁有的檔案

| 路徑 | 角色 |
| --- | --- |
| `playwright.config.ts` | 單一 worker、每輪一個 `fp_e2e_` schema、本機 webServer |
| `scripts/e2e-server.ts` | 只聽 `127.0.0.1` 的本機測試伺服器，建立並卸下該輪 schema |
| `scripts/run-e2e.mjs` | `npm run test:e2e` 的編排：普通輪、private-AI 輪、avatar-asset 輪 |
| `scripts/run-e2e.test.mjs` | 編排邏輯的 Node 測試，不開瀏覽器 |
| `tests/e2e/fixtures.ts` | 規格使用的 `test`／`expect`，並在案例之間重設該 schema 的登入限流 |
| `tests/e2e/navigation.ts` | 會員看得到的導覽與登出 |
| `tests/e2e/quick-join.ts` | 快速加入公會 |
| `docs/development/e2e-harness.md` | 這份說明 |

`public_exports` 是三個 helper：`tests/e2e/fixtures.ts`、`navigation.ts`、`quick-join.ts`。功能規格用 `./fixtures.js` 這類路徑 import 它們。規格檔本身不是 export，也不是這個模組的擁有路徑。

## `npm run test:e2e` 的三輪

`package.json` 的 `test:e2e` 是 `node scripts/run-e2e.mjs`。沒有額外參數時，`planE2e` 依序跑三個行程，每一輪都是新的 Playwright 行程與新的 schema：

1. 普通輪。參數原樣轉交，不設 `FREEDOM_E2E_PRIVATE_AI_FIXTURE` 或 `FREEDOM_E2E_AVATAR_ASSET_FIXTURE`。
2. private-AI 輪。加上 `tests/e2e/private-work-ai.spec.ts`，且只設 `FREEDOM_E2E_PRIVATE_AI_FIXTURE=1`。
3. avatar-asset 輪。加上 `tests/e2e/member-avatar-asset.spec.ts`，且只設 `FREEDOM_E2E_AVATAR_ASSET_FIXTURE=1`。

前一輪非零結束碼或訊號會停下來，不開下一輪。呼叫端已經帶了其中一個 fixture 旗標、帶了檔案篩選，或是 `--help`／`--version` 時，維持單一行程，不再自動加另外兩輪。預設計畫不會在同一輪同時設兩個旗標。若環境已經兩個都是 `1`，編排不會拆開它們；`scripts/e2e-server.ts` 在啟動遷移前直接拋錯，兩個 fixture 不能一起用。

`playwright.config.ts` 的 webServer 另固定帶上 `FREEDOM_E2E_GUIDE_FIXTURE=1` 與 `FREEDOM_E2E_GITHUB_FIXTURES=1`，以及這一輪的 `FREEDOM_E2E_SCHEMA`。`reuseExistingServer` 是 false。

## 埠與 schema

埠來自 `FREEDOM_E2E_PORT`。`packages/testing/e2e-origin.ts` 的 `e2ePort()` 在未設定時用 4311；值必須是 1024–65535 的四或五位數字，並且拒絕 4310 與 4312。伺服器只綁 `127.0.0.1` 上的那個埠。Origin 是 `http://127.0.0.1:<port>`，不寫死別組的埠。

每一輪的 schema 必須符合 `fp_e2e_` 加 32 個十六進位字元。`playwright.config.ts` 在沒有 `FREEDOM_E2E_SCHEMA` 時用去掉連字號的 UUID 組出這個名字。`e2eSchema()` 拒絕其他名字，也拒絕 `NODE_ENV=production` 或 `FREEDOM_ENV` 已設且不是 `local`。伺服器對這個名字 `CREATE SCHEMA`，連線的 `search_path` 與 `application_name` 都是它。`fixtures.ts` 要求 worker 數為 1；案例之間只 `TRUNCATE` 該 schema 的 `auth_rate_limits` 與 `login_attempts`，而且目前 schema 必須就是這一輪，否則拒絕。

行程正常結束時，`stop()` 會 `DROP SCHEMA IF EXISTS` 這個 schema，並在有建立時卸下 `${schema}_app` role。SIGTERM／SIGINT／SIGHUP 會先走 `releaseOwnedResources()`。那個緊急路徑在連線字串含 `:54339` 時不另開卸下行程；54339 是本機預設開發庫的埠，避免在行程被 SIGKILL 的競態裡對那個庫多跑一次卸下。非 54339 的緊急路徑只卸下符合 `fp_e2e_[a-f0-9]{32}` 的 schema。若行程在 `stop()` 的 await 之前被 SIGKILL，54339 上的這一輪 schema 可能留下，需事後清掉；這不是寫入 `public`。

## 程式守住的條件

descriptor 的 invariants 是下面這些 slug。沒有寫進去的，就是這份程式沒有強制。

| slug | 程式實際做的事 |
| --- | --- |
| `isolated-fp-e2e-schema` | 只接受 `fp_e2e_` 加 32 hex；建立、搜尋路徑與卸下都對這個 schema |
| `fixture-flags-never-combined` | 預設三輪各設一個旗標；伺服器在兩個旗標都是 `1` 時拋錯 |
| `port-from-freedom-e2e-port` | 埠只從 `FREEDOM_E2E_PORT` 讀，未設定為 4311，拒絕 4310／4312 |
| `browser-server-local-only` | `NODE_ENV=production` 或非 `local` 的 `FREEDOM_ENV` 直接拋錯 |
| `github-fetch-stubbed-when-flagged` | `FREEDOM_E2E_GITHUB_FIXTURES=1` 時，伺服器行程的 `globalThis.fetch` 改成 GitHub fixture。webServer 會設這個旗標。沒設時，這行替換不會發生 |
| `link-preview-fetch-is-local` | 連結預覽只回固定的示範 JSON、HTML、1×1 PNG，或 404，不發網路請求 |
| `single-playwright-worker` | 設定 `workers: 1`；fixture 在 worker 數不是 1 時拋錯 |

沒有列 `no-real-network`。瀏覽器本身沒有被設成 offline；只有伺服器在 GitHub fixture 旗標下替換 `fetch`，以及連結預覽那條本地回應。沒有列 `no-secrets-in-artifacts`。private-AI 輪寫進 `.freedom/reports/member-model-e2e-fixture-observation.json` 的是固定的合成觀察（schema 名、計數、`real_provider_calls: false`），但 Playwright 失敗時保留的 trace 與截圖沒有另外的秘密清除。

## 依賴

只列這七個檔案真正 import、而且該檔已有模組擁有的對象：

| 模組 | 被 import 的擁有檔 |
| --- | --- |
| `command-core` | `packages/db/index.ts`、`scripts/database.ts` |
| `public-guide-assets` | `packages/public-guide-assets/node.ts`（`FREEDOM_E2E_GUIDE_FIXTURE=1` 時動態載入；webServer 會設） |
| `execution-runs` | `packages/testing/private-ai-product-fixture.ts`（只有 private-AI 那一輪） |
| `assets` | `packages/testing/e2e-avatar-asset-fixture.ts`（只有 avatar-asset 那一輪） |

private-AI 輪會 `readFile` `deploy/cloudflare/sql/20-runtime-grants.psql`。該檔歸 `runtime-registration`，但這是讀檔，不是 import，所以不列成 dependency。

下列 import 的檔案目前沒有任何 descriptor 擁有，因此 dependencies 不包含它們，也不在這次補上歸屬：

- `packages/testing/e2e-auth-isolation.ts`
- `packages/testing/e2e-origin.ts`
- `packages/testing/seed.ts`
- `packages/testing/github-collaboration.ts`
- `packages/testing/e2e-admin.ts`
- `apps/platform-api/src/app.ts`
- `modules/community/github-sync.ts`

`@playwright/test`、`pg`、`@hono/node-server` 是 npm 套件，不是本倉模組。

## `verify` 與 CI 各證明什麼

`e2e.harness` 是本機固定套件。它用與其他非 runtime adapter 相同的有界 Node reporter，在 60 秒、沒有資料庫的預算內只跑 `node --test scripts/run-e2e.test.mjs`。基準檔被刪、零測試、skip、TODO、取消或失敗都不能算通過。`governance.unit` 與 `runtime.full` 不會跑這個檔，所以 descriptor 的 `tests` 只有 `e2e.harness`。

這份套件證明的是編排計畫：三輪順序、旗標不疊加、失敗即停、`test:e2e` 指向這個 runner。它不開 Chromium，也不建立 PostgreSQL schema。

瀏覽器規格由 CI 的 `ui-e2e` job 跑：`npm ci`、安裝 Chromium、`npm run contracts:build`、`npm run build`，然後 `npm run test:e2e`。`node scripts/freedom.mjs verify` 不會取代那個 job。沒有 `TEST_DATABASE_URL` 時，runtime 套件是 `not_run`；那不表示瀏覽器已通過。

## 為什麼 `surfaces` 是空的

`packages/contribution-tools/surface-audit.mjs` 的 `ROUTES` 是 `platform-member-routes/v1`。它只核對兩個 Hono factory：`createAvatarRoutes` 與 `createPrivateWorkRoutes`，文法是匯出的同步 factory、`new Hono()`、字面路徑的 `app.get`／`app.post`。`scripts/run-e2e.mjs` 是本機 Node 編排，不是會員 HTTP route。

把它放進 `ROUTES` 會讓 `inspectLeaf` 用那套 Hono 文法看一個沒有該 factory 的腳本，結果是失敗，或是為 CLI 加例外。例外會放寬這份審計，所以沒有改 `ROUTES`，也沒有把 harness 登記成 surface。既有的本機測試 CLI（例如 `verification.runtime-full`）寫在 governance descriptor 的 surfaces 裡，同樣不在 `ROUTES`；審計把這種未覆蓋的宣告標成 `surface_unmapped`（狀態是 unavailable，不是通過）。harness 沒有這份語法審計能核對的 HTTP 註冊，空的 `surfaces` 比多一筆永遠對不上的宣告誠實。

context 工具的 `surface_unmapped` blocker 是另一件事：非 `docs/**/*.md`、也不是根說明（`AGENTS.md`、`README.md`、`CONTRIBUTING.md`）的路徑，若沒有任何 descriptor 擁有，就會選全部模組。擁有上面八個檔之後，這七個 harness 路徑不再是未知路徑。

## 尚未歸屬的路徑

下面是沒有任何 descriptor `owned_paths` 蓋到的追蹤檔。已排除 `docs/**/*.md`。每個 `freedom.module.json` 由載入器視為該模組自己的路徑，所以不列在這裡。這份紀錄是後續歸屬用的，這次沒有替它們指定主人。目錄計數是 base `d1c9e18fffabebbdceaba233a34f3605220e2dd7`（2026-10-06）的快照，不會自動維護。

`AGENTS.md`、`README.md`、`CONTRIBUTING.md` 沒有被 `owned_paths` 擁有。context 把它們當根說明：變更它們會選全部模組，但不會單靠這三個路徑觸發 `surface_unmapped`。`DESIGN.md` 沒有這條約定，它若被改到且仍無主人，會是未知路徑。

共 1105 個。依最上層目錄計數：

| 目錄 | 數量 |
| --- | ---: |
| `apps` | 292 |
| `tests` | 233 |
| `docs` | 189 |
| `modules` | 122 |
| `migrations` | 92 |
| `deploy` | 70 |
| `packages` | 39 |
| `scripts` | 36 |
| `(repo root)` | 18 |
| `contracts` | 11 |
| `.github` | 3 |

這張表數的是該 base 的樹。當時還沒有 `tests/e2e/freedom.module.json`。目前追蹤樹已由 `e2e-harness` 擁有七個路徑，所以同一規則現在少這七個：`playwright.config.ts`、`scripts/e2e-server.ts`、`scripts/run-e2e.mjs`、`scripts/run-e2e.test.mjs`、`tests/e2e/fixtures.ts`、`tests/e2e/navigation.ts`、`tests/e2e/quick-join.ts`。

下面兩份是 harness 鄰近、而且目前仍未歸屬的路徑。它們依同一規則對目前的 `git ls-files` 重算，同樣不會自動維護。功能規格沒有劃進 `e2e-harness`。

未歸屬的 `tests/e2e/*.spec.ts` 功能規格，共 77 個：

```text
tests/e2e/admin-credentials.spec.ts
tests/e2e/admin-guilds.spec.ts
tests/e2e/admin-review-center.spec.ts
tests/e2e/admin.spec.ts
tests/e2e/agent-shops.spec.ts
tests/e2e/audit-identity-final.spec.ts
tests/e2e/audit-identity.spec.ts
tests/e2e/audit-operations.spec.ts
tests/e2e/audit-shell.spec.ts
tests/e2e/audit-skills.spec.ts
tests/e2e/avatar.spec.ts
tests/e2e/benefits.spec.ts
tests/e2e/calm-experience.spec.ts
tests/e2e/campaign-draft-newlines.spec.ts
tests/e2e/chat-stickers.spec.ts
tests/e2e/client-connections-recovery.spec.ts
tests/e2e/cloud-candidate-acceptance.spec.ts
tests/e2e/co-creation.spec.ts
tests/e2e/commerce-modules.spec.ts
tests/e2e/development-access.spec.ts
tests/e2e/development-guide.spec.ts
tests/e2e/event-highlights.spec.ts
tests/e2e/event-public.spec.ts
tests/e2e/events-past.spec.ts
tests/e2e/game-console.spec.ts
tests/e2e/github-setup.spec.ts
tests/e2e/github-social.spec.ts
tests/e2e/guild-alias.spec.ts
tests/e2e/guild-entry-questions.spec.ts
tests/e2e/guild-member-tiers.spec.ts
tests/e2e/guild-members.spec.ts
tests/e2e/guild-organization.spec.ts
tests/e2e/guild-reviews.spec.ts
tests/e2e/guild-workspace.spec.ts
tests/e2e/help-box-padding.spec.ts
tests/e2e/journeys.spec.ts
tests/e2e/member-channels-real.spec.ts
tests/e2e/member-channels.spec.ts
tests/e2e/member-connections-51.spec.ts
tests/e2e/member-connections.spec.ts
tests/e2e/member-directory.spec.ts
tests/e2e/member-ecard.spec.ts
tests/e2e/member-experience.spec.ts
tests/e2e/member-home-next-step.spec.ts
tests/e2e/member-services.spec.ts
tests/e2e/member-session-lifecycle.spec.ts
tests/e2e/member-settings-real.spec.ts
tests/e2e/member-settings.spec.ts
tests/e2e/member-todos-real.spec.ts
tests/e2e/member-todos.spec.ts
tests/e2e/modules-beginners.spec.ts
tests/e2e/navigation-audit.spec.ts
tests/e2e/notification-bell-actions.spec.ts
tests/e2e/onboarding-members.spec.ts
tests/e2e/onboarding-recovery.spec.ts
tests/e2e/opensource-modules.spec.ts
tests/e2e/page-issue-recovery.spec.ts
tests/e2e/page-tools-notification.spec.ts
tests/e2e/page-tools.spec.ts
tests/e2e/password-recovery.spec.ts
tests/e2e/positioning-modules.spec.ts
tests/e2e/repo-author-claims.spec.ts
tests/e2e/session-recovery.spec.ts
tests/e2e/share-promotion.spec.ts
tests/e2e/sidebar-refine.spec.ts
tests/e2e/simple-work-sharing.spec.ts
tests/e2e/skill-book-library.spec.ts
tests/e2e/skill-book-upgrade.spec.ts
tests/e2e/skill-editor-guild-access.spec.ts
tests/e2e/skill-sharing.spec.ts
tests/e2e/skill-upload.spec.ts
tests/e2e/social-links.spec.ts
tests/e2e/squad-invitations.spec.ts
tests/e2e/squad-types-channel.spec.ts
tests/e2e/text-autospace.spec.ts
tests/e2e/typed-line-breaks.spec.ts
tests/e2e/workshop-design.spec.ts
```

未歸屬的 `scripts/` 路徑，共 33 個：

```text
scripts/bootstrap-public.ts
scripts/build-contract-bundle.mjs
scripts/build-skill-upload-client.mjs
scripts/check-skill-book-upstreams.ts
scripts/checkout-repositories.mjs
scripts/ci/affected-jobs.md
scripts/ci/broker-bridge-check.mjs
scripts/ci/bwrap-deleted-compat.md
scripts/ci/native-cli-audit-readback.mjs
scripts/ci/native-cli-prerequisites.md
scripts/ci/native-cli-snapshot-check.mjs
scripts/ci/release-inventory.md
scripts/ci/render-bwrap-deleted-compat.py
scripts/ci/select-affected-jobs.mjs
scripts/ci/select-affected-jobs.test.mjs
scripts/ci/test_release_source_archive.py
scripts/ci/verify-native-cli-prerequisites.sh
scripts/ci/verify-runtime-postgres.sh
scripts/generate-runtime-text.mjs
scripts/label-page-issue.ts
scripts/lib/openrouter-acceptance-guard.ts
scripts/media-format-fixtures.ts
scripts/release-source-archive.py
scripts/runtime-aggregate.mjs
scripts/sync-admin-access.ts
scripts/verify-cloud-candidate-lib.ts
scripts/verify-cloud-candidate-members.ts
scripts/verify-cloud-candidate.md
scripts/verify-cloud-candidate.ts
scripts/verify-member-settings.mjs
scripts/verify-openrouter-native-owner.ts
scripts/verify-public.mjs
scripts/verify-staging.mjs
```

其餘路徑不逐條列在這裡。要重算完整剩餘集合，對 `git ls-files` 的每一條路徑：符合 `docs/**/*.md` 的排除；被任一 `freedom.module.json` 蓋到的排除。`owned_paths` 以 `/**` 結尾時，去掉末尾兩個字元當前綴（目錄加斜線）；其他樣式必須與路徑全等。載入器會把該 descriptor 自己的路徑加入 `owned_paths`，所以 `freedom.module.json` 不算剩餘。

查單一路徑：

```sh
node scripts/freedom.mjs prepare --base-ref <base> --paths <path>
```

該路徑若沒有 descriptor 擁有，而且不是 `docs/**/*.md`，也不是根說明 `AGENTS.md`、`README.md`、`CONTRIBUTING.md`，這道命令會回報 `surface_unmapped`，並把該路徑列在 `unknown_paths`。
