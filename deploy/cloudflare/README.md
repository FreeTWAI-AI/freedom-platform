# deploy/cloudflare

這是 Cloudflare Workers＋Hyperdrive＋PlanetScale Postgres 18（由 Cloudflare 計費）遷移的 preflight 工具。流程、費用、替代方案與回退見 [遷移手冊](../../docs/development/cloudflare-migration.md)。

工具能力：唯讀 preflight，沒有 execute 能力。本目錄沒有任何會改動 provider、資料庫或既有主機的程式，不產生 billing signature、不登入 pscale；Cloudflare client 只發 GET。

階段是 `cutover_complete`（2026-09-25）。`next` 是正式環境：Worker `freedom-platform-next`，唯一路由是 zone route `freetwai.com/*`，`APP_ORIGIN` 為 `https://freetwai.com`。`next.freetwai.com` 與其兩個 Access application 已刪除。受保護 hostname 只剩 `staging.freetwai.com`。`staging-next` 維持 Cloudflare staging，沒有改角色。Castle `staging.freetwai.com` 也還在；哪一個算 staging 尚未決定，`plan` 不選邊。`plan --env next` 描述正式拓撲、發布與 R3 回退，不重提切換前的演練步驟。`plan --env staging-next` 仍是該環境的佈建形狀，且寫明不動正式 route。

2026-09-24 的候選站觀察（Workers Paid、Tokyo 報價、演練還原、132 項檢查）留在 manifest 的 historical 欄位，不是現行拓撲。細節見 [現況交接](../../docs/development/cloudflare-migration-status-2026-09-24.md) 與 [遷移手冊 §14](../../docs/development/cloudflare-migration.md#14-切換後現況2026-09-25)。切換前「候選 hostname 應該還沒有 DNS」「zone route 必須是 0」「兩個受保護 hostname 共用 tunnel」這類檢查已改成現行預期；舊判準寫在程式註解裡，沒有把 evidence 刪掉。

Repo 的 `wrangler.jsonc` Hyperdrive id 刻意維持全零 template，真實 id 只在私有 overlay；全零代表只靠 repo 不能部署，不代表資源不存在。受保護的對象見 [environments.json](environments.json) 的 `protected`：hostname 只有 `staging.freetwai.com`（`freetwai.com` 是正式 Worker route，不再是受保護的 tunnel hostname）、既有 Tunnel／Access／R2、OCI 上既有的 VM，以及 Castle 上仍在跑的 staging units 與資料庫。`freedom_public` 仍在受保護資料庫名單，因為回退不能指回那份凍結的舊 DB。PlanetScale 會自動安裝 `hypopg`（schema `pscale_extensions`，owner `pscale_admin`）；[30-verify-readonly.psql](sql/30-verify-readonly.psql) 列出 `plpgsql` 以外的 extension，讀結果時必須把 `hypopg` 列入 allowlist。

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

Worker entry、`wrangler.jsonc`、`apps/platform-api`、`packages/db` 與套件依賴由其他工作流負責；本目錄只讀取並驗證它們。
