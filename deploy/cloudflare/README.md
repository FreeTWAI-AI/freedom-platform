# deploy/cloudflare

這是 Cloudflare Workers＋Hyperdrive＋PlanetScale Postgres 18（由 Cloudflare 計費）遷移的 preflight 工具。流程、費用、替代方案與回退見 [遷移手冊](../../docs/development/cloudflare-migration.md)。

目前在 preflight 階段，沒有 execute 能力：本目錄沒有任何會改動 provider、資料庫或既有主機的程式，也不會產生 billing signature 或登入 pscale。pscale 目前已認證（root 以 process-scoped `DBUS_SESSION_BUS_ADDRESS=unix:path=/dev/null` 檢查，organization `ted-ted-h`），Tokyo（`ap-northeast`）organization 報價已記錄：PS-5 single node US$5、PS-5 HA US$15，加 Workers Paid 月基本費 US$25（不含 storage／用量／稅）。資料庫、binding 與 custom domain 都尚未建立。受保護的對象見 [environments.json](environments.json) 的 `protected`，包括 `freetwai.com`、`staging.freetwai.com`、既有 Tunnel／Access／R2、OCI 上既有的 VM，以及 Castle 上的 systemd units 與資料庫。

| 檔案 | 內容 |
| --- | --- |
| [environments.json](environments.json) | `staging-next`／`next` 的名稱與隔離規則、單一 `HYPERDRIVE`、PS-5 size 與 Tokyo org 報價（org_quote_recorded）、OCI／D1 替代方案 |
| [preflight.mjs](preflight.mjs) | CLI：`manifest`、`migrations`、`wrangler`、`cost`、`oci-alternative`、`cloudflare`、`oci`、`planetscale`、`plan`、`all` |
| [lib/wrangler.mjs](lib/wrangler.mjs) | runtime config 靜態 checker：分開回報 structural、static checks 與 deployment readiness（注入未證明時為 false） |
| [lib/credentials.mjs](lib/credentials.mjs) | `CLOUDFLARE_API_TOKEN`／`CLOUDFLARE_ACCOUNT_ID`（接受舊名 `CF_*`，衝突即拒絕） |
| [lib/](lib/manifest.mjs) | manifest guard、cost、GET-only Cloudflare client、唯讀 pscale（process-scoped DBUS fallback、不轉交 token）／OCI runner、migration scanner、redaction |
| [sql/](sql/10-create-roles.psql) | 之後階段使用的 role／grant／唯讀驗證 SQL template（本階段未執行） |
| [test/](test/preflight.test.mjs) | 以 mock provider 撰寫的 node:test 測試 |

```sh
node --test deploy/cloudflare/test/*.test.mjs
node deploy/cloudflare/preflight.mjs all
node deploy/cloudflare/preflight.mjs wrangler --config <runtime wrangler.jsonc>
```

Worker entry、`wrangler.jsonc`、`apps/platform-api`、`packages/db` 與套件依賴由其他工作流負責；本目錄只讀取並驗證它們。
