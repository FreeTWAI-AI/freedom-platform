# deploy/cloudflare

Cloudflare Workers＋Hyperdrive＋PlanetScale Postgres 遷移的 preflight 工具。流程、阻擋與回退見 [遷移手冊](../../docs/development/cloudflare-migration.md)。

目前是 preflight 階段：這裡沒有任何會改動 provider、資料庫或既有主機的程式。`freetwai.com`、`staging.freetwai.com`、既有 Tunnel／Access／R2、Castle 上的 systemd units 與資料庫都受保護，見 [environments.json](environments.json) 的 `protected`。

| 檔案 | 內容 |
| --- | --- |
| [environments.json](environments.json) | `staging-next`／`next` 的名稱、隔離規則、region 偏好與 catalog 價格快照 |
| [preflight.mjs](preflight.mjs) | CLI：`manifest`、`migrations`、`wrangler`、`cloudflare`、`planetscale`、`plan`、`all` |
| [lib/](lib/manifest.mjs) | manifest guard、GET-only Cloudflare client、allowlisted pscale runner、migration scanner、redaction |
| [sql/](sql/10-create-roles.psql) | 之後階段使用的 role／grant／唯讀驗證 SQL template（本階段未執行） |
| [test/](test/preflight.test.mjs) | mock provider 的 node:test 測試 |

```sh
node --test deploy/cloudflare/test/*.test.mjs
node deploy/cloudflare/preflight.mjs all
node deploy/cloudflare/preflight.mjs cloudflare --env-file <chmod 600 file> --report
```

Worker entry、`wrangler` config、`apps/platform-api`、`packages/db` 與套件依賴由其他工作流負責；本目錄只讀取並驗證它們。
