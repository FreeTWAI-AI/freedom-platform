# Cloudflare Workers＋PlanetScale Postgres 遷移：preflight、演練、切換與回退

> 狀態（2026-09-24）：**preflight 階段，沒有 execute 能力**。沒有建立任何 Cloudflare／PlanetScale／OCI 資源，沒有產生 billing signature、沒有 pscale login、沒有讀寫或匯出任何資料庫，也沒有切換流量。名稱與價格都是計畫值；實際 provider ID 只在之後的 provisioning 階段寫入私密 evidence 檔。

Canonical 方向見 [08 Bootstrap／Hosting](../platform-plan/08-bootstrap-hosting-project-lifecycle.md) §3.3、§5.1：Workers → Hyperdrive → managed PostgreSQL。依使用者最新指示，預設 provider 是 **由 Cloudflare 計費的 PlanetScale Postgres 18**（[Cloudflare 官方頁](https://developers.cloudflare.com/hyperdrive/planetscale/)）。OCI 是已調查的替代方案，不 provision；D1 是未來選項但不是 drop-in。工具與測試在 [deploy/cloudflare](../../deploy/cloudflare/README.md)。

## 1. 不動範圍（protected）

目前 `freetwai.com`（Castle `127.0.0.1:4312`）和 `staging.freetwai.com`（`127.0.0.1:4310`）都經 Tunnel 服務，DB 是 Docker PG18 `127.0.0.1:54339` 內各自的資料庫，見 [公開運行手冊](public-operations.md)、[staging 運行手冊](staging-operations.md)。搬遷期間以下全部維持原狀，工具採 default-deny：

| 類型 | 保護對象 |
| --- | --- |
| Hostname | `freetwai.com`、`staging.freetwai.com`；zone 內除 `staging-next`、`next` 以外全部 |
| Tunnel | 所有既有 Tunnel。兩個受保護 hostname 的 DNS 指向**同一個** tunnel target，那條 Tunnel 同時承載 live |
| Access | `Freedom public administrators`、`Freedom staging`、`Freedom staging administrators` |
| R2 | 所有既有 bucket |
| OCI | `oracle1`／`oracle2` 上既有的 3 台 VM：不 SSH、不重用、不修改；本計畫不建立任何 OCI 資源 |
| 本機 | port 4310／4312／54339；`freedom-public*`、`freedom-staging*` user units；`freedom_local`／`freedom_staging`／`freedom_public` DB；既有 release、config、backup 目錄與 [backup.sh](../../deploy/staging/backup.sh) |

機器可讀版本在 [environments.json](../../deploy/cloudflare/environments.json) 的 `protected`；mutation guard 拒絕所有 `oci_*` 目標。

## 2. 架構

```text
Browser → Cloudflare Access → Worker（staging-next／next，workers_dev=false，preview_urls=false）
  → Hyperdrive binding HYPERDRIVE（每環境一個，caching disabled）
  → PlanetScale Postgres 18（Cloudflare 計費，偏好 ap-northeast／Tokyo）
Static assets：binding ASSETS，run_worker_first=true；圖片：binding IMAGES（每環境各自宣告）。
R2 private bucket（選配）只經 Worker binding。
```

| 資源 | `staging-next` | `next` |
| --- | --- | --- |
| 資料 | **只用 synthetic**；不跑 `seedLocal`，不含 `@local.test` | 演練時還原已驗 checksum 的完整 `freedom_public` 備份 |
| Worker | `freedom-platform-staging-next`（env `staging-next`） | `freedom-platform-next`（env `next`） |
| Hyperdrive | `freedom-staging-next-hd` → `HYPERDRIVE` | `freedom-next-hd` → `HYPERDRIVE` |
| PlanetScale DB | `freedom-staging-next-pg`，PG18，**PS-5 single_node** | `freedom-next-pg`，PG18，**PS-5 HA**（1 primary＋2 replicas，3 nodes） |
| DB roles | `freedom_staging_next_migrator`／`_app` | `freedom_next_migrator`／`_app` |
| R2（選配） | `freedom-staging-next-private` | `freedom-next-private` |
| Web Access | `Freedom staging-next`＋`/admin` app | `Freedom next candidate`＋`/admin` app |

兩環境沒有共用的 DB、Hyperdrive、secret 或 Worker。Access application 要在任何 Worker route 生效**之前**建立。Runtime DB 連線只來自 `HYPERDRIVE`；Worker 不持有 `DATABASE_URL`。

Runtime config 以 runtime 工作流的 `wrangler.jsonc`（commit `f089a84`）為準：`compatibility_date` 2026-09-21、`nodejs_compat`、兩個 env 各自的 `HYPERDRIVE`＋`IMAGES`、`APP_ORIGIN`、`FREEDOM_ENV`、`FREEDOM_TRUST_CF_CONNECTING_IP="true"`。Hyperdrive id 目前是刻意的全零 placeholder，代表**尚未 provision**：checker 會判為 `structural: valid`、`deployment_ready: false`。`FREEDOM_RELEASE_SHA` 不寫在 config，由 deploy 以 `--var FREEDOM_RELEASE_SHA:$(git rev-parse HEAD)` 注入，checker 列為 `required_injections`，不算失敗也不算 ready。

## 3. 費用（catalog_required，尚無報價）

| 項目 | 狀態 | 月費 |
| --- | --- | --- |
| staging-next PS-5 single_node（1 node） | 偏好選擇；Tokyo 區域／organization 報價未取得 | **未知** |
| next PS-5 HA（1 primary＋2 replicas） | 偏好選擇；Tokyo 區域／organization 報價未取得 | **未知** |
| Workers Paid | 已由使用者授權 | US$5 |
| **合計** | `cost` 回傳 `total: null`、`total_status: pending_quote` | **待報價** |

- root 2026-09-24 只獨立確認 [PlanetScale pricing](https://planetscale.com/pricing) 的公開摘要：single-node **起價** US$5／月、HA 是 1 primary＋2 replicas、storage 與用量可能另計。這個「起價」**不是**所選 SKU 的區域／organization 報價，也不能加總成合計。
- `pricing.md?region=ap-northeast` 對 root 回傳 403；先前 CLI 聲稱的區域價格未經獨立驗證，本手冊不採用。
- 任何所選 SKU 價格未知時，`preflight cost` 的合計維持 `null`（pending），不以 0、NaN 或猜測值加總。價格要在建立前由已認證 organization 的 `pscale size cluster list --org <org> ... --format json`（目前 **not_run**）或 Cloudflare dashboard 讀取並記錄。
- 依 Cloudflare 官方頁，經 Cloudflare 計費的 PlanetScale 價格與直接向 PlanetScale 購買相同。
- US$50–100 是使用者脈絡的估算，**不是**上限、也不是支出關卡。72cc125 的 US$60 上限是 agent 自行加的，已移除，沒有替代的人工關卡。
- `node deploy/cloudflare/preflight.mjs cost` 會列出 PlanetScale 待報價狀態與 OCI 替代方案試算。

## 4. 建立 PlanetScale DB 的正確途徑（本階段只列步驟）

- **Dashboard**：Cloudflare dashboard 可直接建立並由 Cloudflare 計費的 PlanetScale DB。
- **CLI**：`wrangler hyperdrive planetscale signature` **只**產生類似憑證的 billing authorization，本身不建立任何東西；要以 `pscale database create <name> --org <org> --engine postgresql --cloudflare-billing @-` 從 stdin 讀入才會建立 DB。需要已認證的 pscale organization 與 pscale CLI ≥ 0.313.0（root 已安裝 0.338.0）。自動化命令一律加 `--format json`，`--org` 放在資源層級子命令。Signature 視同 secret：直接 pipe，不列印、不存檔、不貼上。
- **只有 Cloudflare API token 不能建立 DB。** root 的 device login 已不再 pending：瀏覽器交換後以 `TOKEN_SAVE_FAILED`（Object does not exist at path '/'）結束，root 最新觀察為 credential 儲存失敗、process 已結束，認證**仍未就緒**，由 root 協調修正。pscale CLI 0.338 版本足夠，但不宣稱 setup 完成。不得再啟動新的登入，也不讀取 root 的 auth log；本工具不登入、不產生 signature、不建立 DB。
- 官方 agent setup：root 已讀 agent-setup prompt 與 `pscale agent-guide --format json`；建議的 skills／MCP **未安裝**，也不加為依賴（CLI 已足夠），不宣稱 setup 已完成。
- `preflight planetscale` 只跑唯讀 argv（version、auth check、org／database／region／size list），會檢查 CLI 版本 ≥ 0.313.0。

## 5. Cloudflare 認證與帳戶狀態

- Credential 檔（0600、屬於目前使用者）目前採用的 key 是 `CLOUDFLARE_API_TOKEN`／`CLOUDFLARE_ACCOUNT_ID`；舊名 `CF_API_TOKEN`／`CF_ACCOUNT_ID` 仍接受。兩種名稱同時存在且值不同時直接拒絕。所有值只在記憶體，錯誤與輸出都不含值。
- **管理用 parent token**：不變，只作管理，不用於新部署。
- **部署用 child token**：由 root 另行建立（0600，期限 10/1），有 Workers Scripts、Hyperdrive、R2、Workers Routes、DNS 寫入與 Billing Read，沒有 Tokens Write。
- Workers namespace `freetwai` 已由 root 身分初始化，不是阻擋。
- Workers Paid 可能仍未啟用，但使用者已授權（US$5／月），不需要再次核准。
- 仍需：Access application 由有 Access 權限的身分建立；Cache Rules Read 確認沒有規則快取 `/api/*`。

## 6. Preflight 工具

全部唯讀；本階段沒有 execute 能力，`--execute` 一律以 exit 3 拒絕。`all` 預設完全離線，不發任何網路請求。

```sh
node deploy/cloudflare/preflight.mjs manifest
node deploy/cloudflare/preflight.mjs migrations
node deploy/cloudflare/preflight.mjs cost
node deploy/cloudflare/preflight.mjs oci-alternative                # 離線，使用 root 記錄的事實
node deploy/cloudflare/preflight.mjs plan --env staging-next         # 或 next；dry-run
node deploy/cloudflare/preflight.mjs wrangler --config <runtime wrangler.jsonc> [--env-file <0600 file>]
node deploy/cloudflare/preflight.mjs cloudflare --env-file <0600 file>
node deploy/cloudflare/preflight.mjs planetscale [--pscale-org O]
node --test deploy/cloudflare/test/*.test.mjs
```

- `wrangler`：分別回報 `structural`（config 形狀正確）、`static_checks_pass`（再加上真實 id、provider 讀回 cache-off、route 正確）與 `deployment_ready`。這是靜態檢查，看不到 deploy 時注入的值；只要 `required_injections`（`FREEDOM_RELEASE_SHA`、config 外提供的 vars、secrets）未證明，`deployment_ready` 就是 `false`，不代表完整 provider readiness。要求：兩個 env 恰好各一個 `HYPERDRIVE`、id 不共用、`IMAGES`、`ASSETS`＋`run_worker_first`、正確 origin／`FREEDOM_ENV`、來源 IP flag。加 `--env-file` 時對真實 id 做 GET，讀不到或 `caching.disabled !== true` 都不會 ready。
- `oci`（live，唯讀 allowlist）只用於替代方案調查，不在 `all` 預設內。
- 報告經 redaction；`--report` 寫到 `~/.local/state/freedom-cloudflare-migration/reports`（0700／0600）。

## 7. DB 權限、migration 與還原相容性

- PlanetScale Postgres 的 default role 是 NOSUPERUSER（CREATEROLE）；managed PostgreSQL 一律不假設 superuser。
- 靜態檢查：`migrations/` 36 個檔，001–037。**022 從未存在**，是已知缺號。沒有 `CREATE EXTENSION`、`ALTER SYSTEM`、role 管理、`OWNER TO`、`SECURITY DEFINER` 或 untrusted language；`gen_random_uuid()` 是內建函式。003、011、026、030 建立 plpgsql trigger function，由 migrator 擁有。
- Ledger：`schema_migrations(name, sha256)`，sha256 為 `sha256(JSON.stringify(sql))`，與 `packages/db` 的 `digest()` 一致。還原後重跑 repository runner 必須是 no-op。
- Roles（[10-create-roles.psql](../../deploy/cloudflare/sql/10-create-roles.psql)）：
  - 先以 PlanetScale default role 建立 `freedom_staging_next`／`freedom_next` database，再建立 least-privilege 的 `*_migrator` 與 `*_app`。
  - 密碼以 `\getenv` 讀取；psql 與 pg_restore 一律用 `service=<name>`（PGSERVICEFILE／PGPASSFILE 在 0600 目錄），命令列上沒有 host、user 或密碼。
- Grants（[20-runtime-grants.psql](../../deploy/cloudflare/sql/20-runtime-grants.psql)）：runtime 只有 DML，ledger 唯讀。所有 advisory lock 都是 transaction-scoped，相容於 Hyperdrive pooling。
- 驗證（[30-verify-readonly.psql](../../deploy/cloudflare/sql/30-verify-readonly.psql)）：只輸出計數與布林值，`@local.test` 帳號數必須為 0。
- 還原：`pg_restore --no-owner --no-privileges --exit-on-error --single-transaction` 到空 DB，之後重跑 grants 與驗證。
- 以上 SQL 本階段都**沒有**對任何伺服器執行。

## 8. 快取與授權新鮮度

- 每個環境**只有一個** Hyperdrive binding `HYPERDRIVE`，建立時 caching disabled，承載**所有**平台 DB 查詢。不另設 fresh／cached 兩種 binding，也沒有第二個 cached config。
- 唯一被接受的證明是 deploy 前以 provider GET 讀回 `caching.disabled === true`（`preflight wrangler --env-file`）。config 註解、環境變數或 HTTP `no-store` 都**不能**證明 Hyperdrive query cache 已關閉。
- 現有 app 對所有經 Hono 的回應都設 `Cache-Control: no-store`，Worker adapter 必須保留；也不能有 Cache Rule 快取 `/api/*` 或帶 cookie 的回應。公開靜態資產可以快取。
- 驗收：撤銷權限後下一個請求就被拒、登出後舊 cookie 立即失效、寫入後同一會員立刻讀到新值。

## 9. 演練（切換前全部要有 evidence）

1. **staging-next**：
   - 依序：Access → PlanetScale PS-5 single_node（Cloudflare 計費）→ roles → migrations（synthetic）→ grants → Hyperdrive `HYPERDRIVE`（caching disabled）→ 讀回 `caching.disabled` → secrets（全新隨機值）。
   - `preflight wrangler` 必須 `structural: valid` **且** `static_checks_pass: true`；`required_injections` 逐項另有 evidence（secret 名稱讀回、deploy 時注入 `FREEDOM_RELEASE_SHA`）才 deploy。checker 自己不會回報 `deployment_ready: true`。
   - 驗 health、release SHA、註冊／登入、隔離、read-after-write、`no-store`、台灣 p50／p95；匿名請求必須被 Access 攔下。
2. **TLS**：Hyperdrive 到 PlanetScale 走 provider 公開憑證的 TLS；`next` 不得關閉 TLS。
3. **負載與限制**：有上限的負載測試，確認 PS-5 是否足夠；不足時依 catalog 升級 size 並記錄。
4. **backup／restore drill**：從 PlanetScale 備份還原成**新的**演練 DB，跑驗證 SQL，完成後刪除。
5. **next 演練還原**：
   - 使用最新 `freedom_public` 備份的副本，先驗 checksum。
   - 撤銷所有還原來的 sessions。
   - 使用新的 `GITHUB_SOCIAL_TOKEN_KEY`，candidate 就不能按星或發訊息。
   - 比對 counters。
6. 不把 raw live data 帶到 staging-next、preview、log 或 repo。`next` 一直留在 Access 後。

## 10. 切換（本輪不做；需另一次明確授權）

前提：第 9 節全部通過、next 已是 PS-5 HA 並有 backup evidence、Ted 核准切換時段。

1. 切換前，live 一直是**唯一寫入權威**；任何時點只有一個可寫的 production。
2. 短暫 write freeze：停止 `freedom-public.service`（GET 也可能寫入，所以不採半凍結），然後取最終 counters。
3. 最終 `backup.sh` → checksum → 還原到重新清空的 `freedom-next` DB → migration runner no-op → grants → 驗證 SQL → counters 必須與 freeze 時完全一致。
4. production 設定：
   - 把 `GITHUB_SOCIAL_TOKEN_KEY` 換成 live key。
   - 重設 CSRF secret。
   - `APP_ORIGIN` 改為 `https://freetwai.com`，因為 app 會拒絕與它 host 不同的請求。
   - admin Access 的 issuer／AUD 改為 live 值。
5. 以 zone Worker route `freetwai.com/*` → `freedom-platform-next` 切流量。
   - 既有 DNS／Tunnel 記錄不刪，舊 app 只停止、不移除。
   - 這份 cutover config 要另外審查，因為 preflight 會拒絕碰受保護 hostname 的 route。
6. 驗證 live；`next.freetwai.com` 保留在 Access 後，`staging.freetwai.com` 不動。

## 11. 回退

| 時點 | 做法 |
| --- | --- |
| freeze 後、route 生效前 | 啟動 `freedom-public.service`；舊 DB 沒有被改動 |
| route 生效、**尚無** candidate 寫入 | 刪除 Worker route，然後啟動舊 service |
| **已有** candidate 寫入 | 不能直接指回已過期的舊 DB。步驟：再次 freeze → 從 PlanetScale 匯出 → 還原到本機**新的** `freedom_public_rollback_<UTC>`（不覆寫 `freedom_public`）→ runner no-op → 舊 app 指向新 DB → 刪 route → 啟動 |

切換**前**必須確認回退相容性：

- 回退窗口內不套新 migration。
- 密碼 hash 格式舊 app 能驗，或在窗口內停用 rehash。
- 圖片的格式與存放位置舊 app 能讀。
- 回退後讓所有 sessions 失效。
- 舊 release、舊 DB 與備份都保留。

## 12. 替代方案

### OCI Database with PostgreSQL（已調查，不 provision）

以下僅來自 root 2026-09-24 的 live 讀取，本輪沒有重新查詢：

- `oracle1` 是歷史調查的優先 profile，`oracle2` 只做比較；兩者都只訂閱 `us-ashburn-1`。既有 3 台 VM 禁止使用。
- PG18 存在；DB 最小 1 OCPU／16 GB。`oracle1` 的 Container Instance shape 有 `CI.Standard.A1.Flex`、`CI.Standard.E4.Flex`，最小 1 OCPU／1 GB。
- **Quota**：兩個 profile 的 `dbsystem-count` total 都是 0，且其 definition `is-deprecated=false`，所以建立會被阻擋；`dbsystem-e5-count` 20 **不能**覆蓋 total 0。
- **TLS（NOT_RUN）**：OCI PostgreSQL 使用 OCI private CA 的憑證；Workers VPC 不支援 custom CA；Tunnel 公開 hostname 與 OCI 憑證 SAN 不符，且沒有 SNI override。單有 cloudflared connector **不能**證明端到端 TLS 已驗證；之後必須驗證 PgBouncer double-TLS 或其他可驗證路徑。此路徑不是 ready，也不會自動部署。
- 費用（Oracle 公開 price list，付費單價，不假設 free credits；730 h）：

| 項目 | 單價 | 月費 |
| --- | --- | --- |
| DB node 1 OCPU／16 GB | (B99060 $0.098 + B97384 $0.03)／OCPU-hr + B97385 $0.002／GB-hr × 16 | US$116.80 |
| Connector E4（B93113 $0.025／OCPU-hr＋B93114 $0.0015／GB-hr） | 1 OCPU／1 GB | US$19.35 |
| Connector A1（B93297 $0.01／OCPU-hr＋B93298 $0.0015／GB-hr） | 1 OCPU／1 GB | US$8.40 |
| 合計（staging 1 node＋next 2 nodes＋2 connectors＋Workers Paid） | E4／A1 | **US$394.10／US$372.20** |

  未含：DB storage（B99062 $0.072／GB-month，容量未定）、備份、NAT、egress、稅。

### D1（未來選項，不實作）

不是 drop-in：平台依賴 PostgreSQL transaction、row lock／advisory lock、JSONB 與 pg driver。本計畫不改寫、不實作。

## 13. 未驗證項目（not_run）

- pscale 認證、organization 內的 size 可用性、`--cloudflare-billing` 實際建立流程。
- Workers Paid 啟用狀態（已授權，由 root 處理）。
- 真實 Hyperdrive id 與 `caching.disabled` 讀回。
- PlanetScale 所選 SKU 的區域／organization 報價（catalog_required）。
- Cloudflare remote Images 驗收：root 目前 12/13，alpha cover 修正由 root 負責，本工作流維持 pending。
- OCI TLS 可驗證路徑；OCI 資源一律不建立。
- 所有 provider mutation、SQL 執行、restore drill、負載測試、瀏覽器驗證與台灣延遲量測。

參考：[Hyperdrive × PlanetScale](https://developers.cloudflare.com/hyperdrive/planetscale/)、[Hyperdrive query caching](https://developers.cloudflare.com/hyperdrive/concepts/query-caching/)、[Workers previews](https://developers.cloudflare.com/workers/configuration/previews/)、[PlanetScale pricing](https://planetscale.com/pricing)、[OCI PostgreSQL pricing](https://www.oracle.com/cloud/postgresql/pricing/)、[OCI connect to DB](https://docs.oracle.com/en-us/iaas/Content/postgresql/connect-to-db.htm)。
