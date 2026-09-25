# deploy/cloudflare

這是 Cloudflare Workers＋Hyperdrive＋PlanetScale Postgres 18（由 Cloudflare 計費）遷移的 preflight 工具。流程、費用、替代方案與回退見 [遷移手冊](../../docs/development/cloudflare-migration.md)。

工具能力：唯讀 preflight，沒有 execute 能力。本目錄沒有任何會改動 provider、資料庫或既有主機的程式，不產生 billing signature、不登入 pscale；Cloudflare client 只發 GET。

階段是 `cutover_complete`（2026-09-25）。`next` 是正式環境：Worker `freedom-platform-next`，唯一路由是 zone route `freetwai.com/*`，`APP_ORIGIN` 為 `https://freetwai.com`。`staging-next` 是 staging：Worker `freedom-platform-staging-next`，唯一路由是 zone route `staging.freetwai.com/*`，`APP_ORIGIN` 為 `https://staging.freetwai.com`，`FREEDOM_ENV` 為 `staging`。`next.freetwai.com` 與 `staging-next.freetwai.com` 及其 Access application 已刪除。受保護 hostname 清單是空的：zone 裡不再有 Castle tunnel hostname，允許的 hostname 只有這兩個環境，其餘拒絕。Castle 只做本機開發。`plan --env next` 與 `plan --env staging-next` 都描述現行拓撲、同一個私有 helper 的發布路徑，以及 R3 回退；staging 的驗收目標是 `verify-cloud-candidate.ts execute --target staging`。

2026-09-24 的候選站觀察（Workers Paid、Tokyo 報價、演練還原、132 項檢查）留在 manifest 的 historical 欄位，不是現行拓撲。細節見 [現況交接](../../docs/development/cloudflare-migration-status-2026-09-24.md) 與 [遷移手冊 §14](../../docs/development/cloudflare-migration.md#14-切換後現況2026-09-25)。切換前「候選 hostname 應該還沒有 DNS」「zone route 必須是 0」「兩個受保護 hostname 共用 tunnel」這類檢查已改成現行預期；舊判準寫在程式註解裡，沒有把 evidence 刪掉。

Repo 的 `wrangler.jsonc` Hyperdrive id 刻意維持全零 template，真實 id 只在私有 overlay；全零代表只靠 repo 不能部署，不代表資源不存在。受保護的對象見 [environments.json](environments.json) 的 `protected`：hostname 清單是空的；既有 Tunnel／Access（`Freedom public administrators`、`Freedom staging`、`Freedom staging administrators`，只引用、不建立）、R2、OCI 上既有的 VM，以及本機資料庫 `freedom_local`。`freedom_public` 與 `freedom_staging` 已 drop，回退不能指回那兩份凍結的舊 DB。Castle staging units、port 4310／4312 與對應路徑在 `historical_retired_2026_09_25`。PlanetScale 會自動安裝 `hypopg`（schema `pscale_extensions`，owner `pscale_admin`）；[30-verify-readonly.psql](sql/30-verify-readonly.psql) 列出 `plpgsql` 以外的 extension，讀結果時必須把 `hypopg` 列入 allowlist。

| 檔案 | 內容 |
| --- | --- |
| [environments.json](environments.json) | `staging-next`／`next` 的名稱與隔離規則、單一 `HYPERDRIVE`、PS-5 size 與 Tokyo org 報價（org_quote_recorded）、觀察到的佈建進度（不含 ID）、OCI／D1 替代方案 |
| [preflight.mjs](preflight.mjs) | CLI：`manifest`、`migrations`、`wrangler`、`cost`、`oci-alternative`、`cloudflare`、`oci`、`planetscale`、`plan`、`all` |
| [lib/wrangler.mjs](lib/wrangler.mjs) | runtime config 靜態 checker：分開回報 structural、static checks 與 deployment readiness（注入未證明時為 false） |
| [lib/credentials.mjs](lib/credentials.mjs) | `CLOUDFLARE_API_TOKEN`／`CLOUDFLARE_ACCOUNT_ID`（接受舊名 `CF_*`，衝突即拒絕） |
| [lib/](lib/manifest.mjs) | manifest guard、cost、GET-only Cloudflare client、唯讀 pscale（process-scoped DBUS fallback、不轉交 token）／OCI runner、migration scanner、redaction |
| [sql/](sql/10-create-roles.psql) | role／grant／唯讀驗證 SQL template（本目錄工具不執行） |
| [test/](test/preflight.test.mjs) | 以 mock provider 撰寫的 node:test 測試 |

```sh
node --test deploy/cloudflare/test/*.test.mjs
node deploy/cloudflare/preflight.mjs all
node deploy/cloudflare/preflight.mjs wrangler --config <runtime wrangler.jsonc>
```

Worker entry、`wrangler.jsonc`、`apps/platform-api`、`packages/db` 與套件依賴由其他工作流負責；本目錄只讀取並驗證它們。`preflight.mjs wrangler` 不驗證 [wrangler.admin-sync.jsonc](../../wrangler.admin-sync.jsonc)：那個 checker 要求平台 route、assets 與 images。cron Worker 由 `npm run worker:dry-run:admin-sync` 打包。見下方「管理員 Access 同步 Worker」。

## 管理員 Access 同步 Worker

Castle 上每 15 秒跑 `scripts/sync-admin-access.ts` 的 timer，是管理員 Access 允許名單仍依賴家用機器的最後一段。這個 Worker 把同一次 `syncAdminAccess()` 放進 cron。它只匯出 `scheduled`，沒有 `fetch`，沒有 route、custom domain、workers.dev 或 preview URL，所以不在公開網路上回答任何要求。入口是 [apps/platform-api/src/admin-sync-worker.ts](../../apps/platform-api/src/admin-sync-worker.ts)。Wrangler 不能讓同一個設定檔的環境使用不同 `main`，所以設定是 repo 根目錄的 [wrangler.admin-sync.jsonc](../../wrangler.admin-sync.jsonc)，與平台 Worker 的 `wrangler.jsonc` 分開。

`npm run worker:dry-run` 只檢查平台 Worker。`npm run worker:dry-run:admin-sync` 才打包這個檔的 top-level、`staging-next` 與 `next`。GitHub Actions 的 verify job 在 `npm run build` 之後依這個順序跑這兩個指令，再跑 `npm run test:worker`。dry-run 不需要 Cloudflare 憑證，步驟設 `WRANGLER_SEND_METRICS=false`。`deploy/cloudflare` 的 manifest 與 `preflight.mjs wrangler` 也不檢查它。

兩個環境各用自己的資料庫，綁定名稱都是 `HYPERDRIVE`，沿用該環境平台 Worker 已經在用、而且 caching disabled 的那一份 Hyperdrive。不要把兩個 Worker 綁到同一份 Hyperdrive。

| env | Worker 名稱 | 受保護網域（只寫在私有 overlay） |
| --- | --- | --- |
| `staging-next` | `freedom-admin-sync-staging-next` | `staging.freetwai.com/admin` |
| `next` | `freedom-admin-sync-next` | `freetwai.com/admin` |

Repo 裡的 Hyperdrive id 是全零。全零代表沒有 overlay 就不能部署，不代表資源不存在。帳號 id 全零、application／policy 是 nil UUID、網域是 `REPLACE_BEFORE_DEPLOY`。這四個 placeholder 會在排程函式裡被拒絕，不會對提供者送出請求。

每個環境要在私有 overlay 替換的名稱：

- `HYPERDRIVE`（該環境的 id，不提交）
- `CF_ACCOUNT_ID`
- `FREEDOM_ADMIN_SYNC_APP_ID`
- `FREEDOM_ADMIN_SYNC_POLICY_ID`
- `FREEDOM_ADMIN_SYNC_DOMAIN`

Secret 不進 repo、不進 `--var`、不進會被提交的 secrets file。每個環境各上傳一次，權限維持最小的 Access application policy 編輯，而且不要用平台 Worker 的 `FREEDOM_ADMIN_CSRF_SECRET` 或 `GITHUB_SOCIAL_TOKEN_KEY`：

```sh
npx wrangler secret put CF_API_TOKEN --config <private-overlay.jsonc> --env staging-next
npx wrangler deploy --config <private-overlay.jsonc> --env staging-next
npx wrangler secret put CF_API_TOKEN --config <private-overlay.jsonc> --env next
npx wrangler deploy --config <private-overlay.jsonc> --env next
```

先發布 staging，確認一次之後再發布 `next`。直接拿 repo 裡的 template 去 deploy 會因全零 Hyperdrive id 失敗。若只換了 Hyperdrive id、四個變數仍是 placeholder，cron 會因設定無效失敗，同樣不會改 Access。

Cloudflare cron 最短是一分鐘，所以排程是 `* * * * *`。舊 timer 是 15 秒。同步只在有待同步版本時寫入 Access，多出來的是輪詢間隔，不是多一次寫入。強制重驗沿用舊 timer 大約每 15 分鐘的 `--force`：排程時間的 UTC 分鐘是 0、15、30 或 45 才帶 `force`（用排程時間，不用執行當下的時鐘）。排程時間缺失或不是有限數值時也會 `force`，避免少一個綁定就變成永不重驗。

確認一次執行：

```sh
npx wrangler tail --config <private-overlay.jsonc> --env staging-next --format json
```

有檢查時，日誌只有一行 `{"checked":true,"updated":false,"active_admins":N}`（`updated` 可能為 true；N 是人數，沒有信箱）。沒有待同步、也不是強制分鐘時，不呼叫 Access，也不寫這行。失敗會讓這次 cron 被標成失敗，訊息固定是 `Administrator access synchronization failed; pending changes will be retried.`，日誌不含 token、連線字串、信箱或提供者本文。版本不會被標成已同步，下一分鐘可以再試。Dashboard 裡這個 Worker 的 Triggers 應只有這條 cron，不應有 route。

回退：先停掉這個 Worker，再把 Castle timer 開回來。兩者不要同時改同一份 policy。

```sh
npx wrangler delete --config <private-overlay.jsonc> --env staging-next
npx wrangler delete --config <private-overlay.jsonc> --env next
```

然後依 [會員工具部署](../../docs/development/member-toolkit.md) 恢復私有環境的 `node --import tsx scripts/sync-admin-access.ts`（每 15 秒，大約每 15 分鐘加 `--force`）。未同步的版本維持 pending，由 timer 重試。不要用舊的靜態名單覆蓋現行 Access policy。若這個 Worker 的程式可能被改過，先停 cron，再輪替 `CF_API_TOKEN`。刪除的是 `freedom-admin-sync-*`，不是平台 Worker。
