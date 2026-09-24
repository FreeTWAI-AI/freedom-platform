# deploy/cloudflare

這是 Cloudflare Workers＋Hyperdrive＋PlanetScale Postgres 18（由 Cloudflare 計費）遷移的 preflight 工具。流程、費用、替代方案與回退見 [遷移手冊](../../docs/development/cloudflare-migration.md)。

工具能力：唯讀 preflight，沒有 execute 能力。本目錄沒有任何會改動 provider、資料庫或既有主機的程式，不產生 billing signature、不登入 pscale；Cloudflare client 只發 GET。

觀察到的 provider 進度（2026-09-24，與工具能力分開記錄；佈建由 operator 私有 helper 在本目錄外執行）：Workers Paid 與 PlanetScale partnership 已啟用；Tokyo（`ap-northeast`）兩個 PG18 DB 已 ready（PS-5 single node US$5、PS-5 HA US$15，加 Workers Paid 月基本費 US$25，不含 storage／用量／稅）；4 個候選 Access application 已驗證；next 演練還原（18:51 備份）已驗證。`staging-next` 與 `next` 都已部署 `aed75a2`，所選 10 個驗收階段／132 項檢查與有上限的匿名負載皆通過，臨時驗收資源已清理。**沒有切換**，舊站持續接受寫入。manifest 的 `status`／`observed` 記錄這些進度，細節見 [現況交接](../../docs/development/cloudflare-migration-status-2026-09-24.md)。

Repo 的 `wrangler.jsonc` Hyperdrive id 刻意維持全零 template，真實 id 只在私有 overlay；全零代表只靠 repo 不能部署，不代表資源不存在。受保護的對象見 [environments.json](environments.json) 的 `protected`，包括 `freetwai.com`、`staging.freetwai.com`、既有 Tunnel／Access／R2、OCI 上既有的 VM，以及 Castle 上的 systemd units 與資料庫。

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
