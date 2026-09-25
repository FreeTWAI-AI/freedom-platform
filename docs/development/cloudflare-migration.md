# Cloudflare Workers＋PlanetScale Postgres 遷移：preflight、演練、切換與回退

> 狀態（2026-09-25 切換完成）：正式環境是 Worker `freedom-platform-next`（env `next`），zone route `freetwai.com/*`，`APP_ORIGIN` 為 `https://freetwai.com`。Staging 是 Worker `freedom-platform-staging-next`（env `staging-next`），zone route `staging.freetwai.com/*`，`APP_ORIGIN` 為 `https://staging.freetwai.com`，`FREEDOM_ENV` 為 `staging`。Castle 只做本機開發。`next.freetwai.com` 與 `staging-next.freetwai.com` 都已移除。受保護 hostname 清單是空的。本目錄工具仍是唯讀 preflight，沒有 execute。現行拓撲見 §14。§2–13 是切換前的計畫與演練紀錄。2026-09-24 的數字見 [現況交接](cloudflare-migration-status-2026-09-24.md)。

Canonical 方向見 [08 Bootstrap／Hosting](../platform-plan/08-bootstrap-hosting-project-lifecycle.md) §3.3、§5.1：Workers → Hyperdrive → managed PostgreSQL。依使用者最新指示，預設 provider 是 **由 Cloudflare 計費的 PlanetScale Postgres 18**（[Cloudflare 官方頁](https://developers.cloudflare.com/hyperdrive/planetscale/)）。OCI 是已調查的替代方案，不 provision；D1 是未來選項但不是 drop-in。工具與測試在 [deploy/cloudflare](../../deploy/cloudflare/README.md)。

## 1. 不動範圍（protected）

2026-09-25 正式與 staging 都切到 Worker 之後，受保護 hostname 清單是空的：zone 裡不再有 Castle tunnel hostname。允許的 hostname 只有 `freetwai.com` 與 `staging.freetwai.com`，其餘一律拒絕（見 §14）。

切換前 `freetwai.com`（Castle `127.0.0.1:4312`）和 `staging.freetwai.com`（`127.0.0.1:4310`）都經 Tunnel 服務，DB 是 Docker PG18 `127.0.0.1:54339` 內各自的資料庫，見 [公開運行手冊](public-operations.md)、[staging 運行手冊](staging-operations.md)。下表是當時的 default-deny 清單：

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

Runtime config 以 runtime 工作流的 `wrangler.jsonc`（commit `f089a84`）為準：`compatibility_date` 2026-09-21、`nodejs_compat`、兩個 env 各自的 `HYPERDRIVE`＋`IMAGES`、`APP_ORIGIN`、`FREEDOM_ENV`、`FREEDOM_TRUST_CF_CONNECTING_IP="true"`。Repo 內的 Hyperdrive id 刻意維持全零 template，真實 id 只放私有 overlay；全零代表「只靠 repo 不能部署」，**不**代表資源不存在。對 template 本身，checker 會判為 `structural: valid`、`deployment_ready: false`。`FREEDOM_RELEASE_SHA` 不寫在 config，由 deploy 以 `--var FREEDOM_RELEASE_SHA:$(git rev-parse HEAD)` 注入，checker 列為 `required_injections`，不算失敗也不算 ready。

## 3. 費用（org_quote_recorded，Tokyo organization 報價）

| 項目 | 狀態 | 月費 |
| --- | --- | --- |
| staging-next PS-5 single_node（1 node） | CLI cluster `PS_5_AWS_ARM`／`PS_5_AWS_X86`（`display_name` PS-5，`replicas` "0"，single node） | US$5 |
| next PS-5 HA（1 primary＋2 replicas） | 同上 cluster，`replicas` "2"，highly available | US$15 |
| Workers Paid | 已啟用（root 2026-09-24 驗證，state Paid） | US$5 |
| **月基本費合計** | `cost` 回傳 `total: 25`、`total_status: computed` | **US$25** |

- 來源：root 2026-09-24 以已認證 organization `ted-ted-h` 執行 `DBUS_SESSION_BUS_ADDRESS=unix:path=/dev/null pscale size cluster list --org ted-ted-h --engine postgresql --region ap-northeast --format json`（Tokyo 的實際 slug 是 `ap-northeast`，不是 `aws-ap-northeast-1`）。非秘密 catalogue 存在 `~/.local/state/freedom-cloudflare-migration/pscale-tokyo-sizes.json`；本工作流沒有呼叫 provider。參考：`PS_10_AWS_ARM` HA 為 US$41。
- CLI 欄位：`name` 是 cluster 識別碼（例如 `PS_5_AWS_ARM`），`display_name`（PS-5）只是標籤；`rate` 是月費、`replicas` 是字串。
- US$25 只是**月基本費**，不是總用量：PlanetScale storage／用量、Cloudflare 超出 Workers Paid 內含量的用量與稅**未計入**，也不代表任何併發容量。兩個 DB 已依此 SKU 建立；實際月帳單尚未觀察到。
- 若之後需要重新報價，把 manifest 對應 SKU 設為 `null`：`preflight cost` 的合計會回到 `null`（pending），不以 0、NaN 或猜測值加總。
- 依 Cloudflare 官方頁，經 Cloudflare 計費的 PlanetScale 價格與直接向 PlanetScale 購買相同。
- US$50–100 是使用者脈絡的估算，**不是**上限、也不是支出關卡。72cc125 的 US$60 上限是 agent 自行加的，已移除，沒有替代的人工關卡。
- `node deploy/cloudflare/preflight.mjs cost` 會列出 PlanetScale 待報價狀態與 OCI 替代方案試算。

## 4. 建立 PlanetScale DB 的途徑

2026-09-24 兩個候選 DB 已以下列 CLI 途徑建立（由工具外的 operator 私有 helper 執行）；重建或新增環境時照同一程序。

- **Dashboard**：Cloudflare dashboard 可直接建立並由 Cloudflare 計費的 PlanetScale DB。
- **CLI**：`wrangler hyperdrive planetscale signature` **只**產生類似憑證的 billing authorization，本身不建立任何東西；要以 `pscale database create <name> --org <org> --engine postgresql --cloudflare-billing @-` 從 stdin 讀入才會建立 DB。需要已認證的 pscale organization 與 pscale CLI ≥ 0.313.0（root 已安裝 0.338.0，足夠）。自動化命令一律加 `--format json`，`--org` 放在資源層級子命令，並只對該 process 設定 `DBUS_SESSION_BUS_ADDRESS=unix:path=/dev/null`。plan 產生的 CLI 形式為 `wrangler hyperdrive planetscale signature | DBUS_SESSION_BUS_ADDRESS=unix:path=/dev/null pscale database create <name> --org ted-ted-h --engine postgresql --region ap-northeast --cloudflare-billing @- --format json`；本工具只產生這段文字，沒有 execute 能力。Signature 視同 secret：直接 pipe，不列印、不存檔、不貼上。前提是帳戶已啟用 Workers Paid 與 PlanetScale partnership（未啟用時 signature 回傳 Cloudflare code 2025）。
- **只有 Cloudflare API token 不能建立 DB。** pscale 以 OAuth 認證到 organization `ted-ted-h`（`pscale auth check --format json` 回傳 `authenticated: true`）。沒有桌面 keyring 時，每個 pscale 子程序都要帶 process-scoped `DBUS_SESSION_BUS_ADDRESS=unix:path=/dev/null`，才會走官方的檔案 fallback（認證目錄 0700、token 檔 0600）；不改全域環境或設定，不重新登入，不讀取 credential 內容。本工具不登入、不產生 signature、不建立 DB。
- 官方 agent setup：root 已讀 agent-setup prompt 與 `pscale agent-guide --format json`；建議的 skills／MCP **未安裝**，也不加為依賴（CLI 已足夠），不宣稱 setup 已完成。
- `preflight planetscale` 只跑唯讀 argv（version、auth check、org／database／region／size list），會檢查 CLI 版本 ≥ 0.313.0；child process 只收到 `PATH`／`HOME`／`XDG_CONFIG_HOME`、`NO_COLOR` 與 process-scoped `DBUS_SESSION_BUS_ADDRESS=unix:path=/dev/null`，不轉交任何 token。Region 只在 CLI 回報 `postgresql_supported: true` 時才會選用；`false` 或欄位缺漏都不視為可用。Size 同時回報 `cluster`（CLI 的 `name`）與 `display_name`。

## 5. Cloudflare 認證與帳戶狀態

- Credential 檔（0600、屬於目前使用者）目前採用的 key 是 `CLOUDFLARE_API_TOKEN`／`CLOUDFLARE_ACCOUNT_ID`；舊名 `CF_API_TOKEN`／`CF_ACCOUNT_ID` 仍接受。兩種名稱同時存在且值不同時直接拒絕。所有值只在記憶體，錯誤與輸出都不含值。
- **管理用 parent token**：不變，只作管理，不用於新部署。
- **部署用 child token**：由 root 另行建立（0600，期限 10/1），有 Workers Scripts、Hyperdrive、R2、Workers Routes、DNS 寫入與 Billing Read，沒有 Tokens Write。
- Workers namespace `freetwai` 已由 root 身分初始化。
- Workers Paid：已啟用（root 2026-09-24 17:39:58 UTC 讀回 `workers_paid`、US$5／月、state Paid）。
- PlanetScale partnership：已啟用；這是與 Workers Paid 分開的 entitlement。啟用後 2026-09-24 18:21:19 UTC billing signature 成功，臨時 billing token 已撤銷。最小權限組合未證實，不要據此推論 scope。
- Access application：`staging-next`／`next` 的全站與 `/admin` 共 4 個已建立並 GET 驗證（帳戶總數 19→23，原 19 個未變）。
- Cache Rules：2026-09-24 兩站最終 provider addendum（staging-next 19:19:48、next 19:44:51 UTC）皆為 `no_applicable_cache_rule`，由完整 zone Rulesets 列表確認；child token 查特定 entrypoint 回 403。只代表觀察當時；切換前重新確認。

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
  - PlanetScale 路由：SQL `CREATE ROLE`／`GRANT`／`ALTER DEFAULT PRIVILEGES` 用**不帶後綴**的 role 名（勿修改）；TLS 連線 username 必須是 `<role>.<branch-id>`（migrator service entry、Hyperdrive `user=${runtime}.<branch-id>`），`<branch-id>` 是 provider connect metadata 的實際 branch ID，不是字面 `main` 或猜測值；default role 用 provider 提供的 username 原樣。依據 [PlanetScale roles](https://planetscale.com/docs/postgres/connecting/roles)。
- Grants（[20-runtime-grants.psql](../../deploy/cloudflare/sql/20-runtime-grants.psql)）：runtime 只有 DML，ledger 唯讀。所有 advisory lock 都是 transaction-scoped，相容於 Hyperdrive pooling。
- 驗證（[30-verify-readonly.psql](../../deploy/cloudflare/sql/30-verify-readonly.psql)）：只輸出計數與布林值，`@local.test` 帳號數必須為 0。
- 還原：`pg_restore --no-owner --no-privileges --exit-on-error --single-transaction` 到空 DB，之後重跑 grants 與驗證。
- 本目錄工具不執行任何 SQL。2026-09-24 的 staging-next bootstrap 與 next 還原由 operator 私有 helper 執行，結果（ledger、grants、ownership、schema 比對）見[現況交接 §5](cloudflare-migration-status-2026-09-24.md#5-資料庫-bootstrap-與還原已驗證)。
- 臨時 provider admin role 只在 bootstrap 期間存在，完成後明確刪除並確認沒有殘留。

## 8. 快取與授權新鮮度

- 每個環境**只有一個** Hyperdrive binding `HYPERDRIVE`，建立時 caching disabled，承載**所有**平台 DB 查詢。不另設 fresh／cached 兩種 binding，也沒有第二個 cached config。
- 唯一被接受的證明是 deploy 前以 provider GET 讀回 `caching.disabled === true`（`preflight wrangler --env-file`）。config 註解、環境變數或 HTTP `no-store` 都**不能**證明 Hyperdrive query cache 已關閉。
- 現有 app 對所有經 Hono 的回應都設 `Cache-Control: no-store`，Worker adapter 必須保留；也不能有 Cache Rule 快取 `/api/*` 或帶 cookie 的回應。公開靜態資產可以快取。
- 驗收：撤銷權限後下一個請求就被拒、登出後舊 cookie 立即失效、寫入後同一會員立刻讀到新值。

## 9. 演練（切換前全部要有 evidence）

2026-09-24 進度：兩站的佈建、Hyperdrive 讀回、strict TLS、secrets、部署、所選 10 個驗收階段／132 項檢查與清理都已完成；第 5 項 next 演練還原（含 GitHub 設定隔離）已完成。第 1 項中的註冊與台灣 p50／p95 **未跑**；第 3 項只有兩站的小型匿名負載，不是容量證明；第 4 項尚未進行。

1. **staging-next**：
   - 依序：Access → PlanetScale PS-5 single_node（Cloudflare 計費）→ roles → migrations（synthetic）→ grants → Hyperdrive `HYPERDRIVE`（caching disabled）→ 讀回 `caching.disabled` → secrets（全新隨機值）。
   - `preflight wrangler` 必須 `structural: valid` **且** `static_checks_pass: true`；`required_injections` 逐項另有 evidence（secret 名稱讀回、deploy 時注入 `FREEDOM_RELEASE_SHA`）才 deploy。checker 自己不會回報 `deployment_ready: true`。
   - 驗 health、release SHA、註冊／登入、隔離、read-after-write、`no-store`、台灣 p50／p95；匿名請求必須被 Access 攔下。
2. **TLS**：Hyperdrive 到 PlanetScale 使用 strict TLS，上傳自訂 CA（ISRG Root X2）並讀回核對；staging-next 已依此驗證。`next` 不得關閉或放寬 TLS。
3. **負載與限制**：有上限的負載測試，確認 PS-5 是否足夠；不足時依 catalog 升級 size 並記錄。
4. **backup／restore drill**：從 PlanetScale 備份還原成**新的**演練 DB，跑驗證 SQL，完成後刪除。
5. **next 演練還原**：
   - 以既有 `freedom-public-backup.service` oneshot 取新備份（唯讀 pg_dump、只新增檔案），私下複製並前後驗 checksum；還原 client 用獨立容器，不 exec 進舊容器。
   - 撤銷所有還原來的 sessions。
   - 使用新的 `GITHUB_SOCIAL_TOKEN_KEY`：還原來的加密 GitHub credential 無法解密使用。這**不**會停用一般會員訊息，也不阻止之後新連結的 GitHub 帳號。驗收只用自己的合成帳號、從不讀 inbox，外部 GitHub 動作不在驗收範圍。
   - GitHub 設定隔離：新 key 解不開還原來的 GitHub App 設定，guild status 會回 503 `github_setup_unavailable`。經審查後，只在候選 DB 移除還原來的 App 設定與相依的已使用 setup receipt，移除前先加密備份；會員的連結、OAuth state 與 audit 不動，候選站 GitHub 維持未設定。不繞過 verifier，也不改 runtime。
   - 核對 ledger no-op、ownership／grants 與 schema；計數只代表目標端現況，切換時才要求與 freeze counters 完全一致。
6. 不把 raw live data 帶到 staging-next、preview、log 或 repo。`next` 一直留在 Access 後。

## 10. 切換（本輪不做；需另一次明確授權）

前提：第 9 節全部通過、next 已是 PS-5 HA 並有 backup evidence、Ted 核准切換時段。

1. 切換前，live 一直是**唯一寫入權威**；任何時點只有一個可寫的 production。
2. 短暫 write freeze：停止 `freedom-public.service`（GET 也可能寫入，所以不採半凍結），然後取最終 counters。
3. 最終 `backup.sh` → checksum → 還原到重新清空的 `freedom-next` DB → migration runner no-op → grants → 驗證 SQL → counters 必須與 freeze 時完全一致。
4. production 設定：
   - 把 `GITHUB_SOCIAL_TOKEN_KEY` 換成與新最終備份相符的 live key，經審查過的 secret 轉移設定；演練的 GitHub 隔離不套用到切換。真實 GitHub 流程另外驗證。
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

已完成的項目見[現況交接](cloudflare-migration-status-2026-09-24.md)。

- Cloudflare remote Images：先前 alpha 修正 `125b022` 的遠端 targeted proof 6/6 PASS（root 私有 evidence）只是歷史紀錄，不代表整體部署。
- 新會員註冊；全 app 端到端（所選 10 個驗收階段不是全 app E2E）。
- 完整 GitHub OAuth／App consent／安裝與按星、fork、follow；會員訊息 UI；台灣延遲量測；PlanetScale 原生 backup／PITR 額外還原演練；DB 負載與 10k 併發容量。
- 切換（§10）與回退（§11）全部尚未進行。
- OCI TLS 可驗證路徑；OCI 資源一律不建立。

參考：[Hyperdrive × PlanetScale](https://developers.cloudflare.com/hyperdrive/planetscale/)、[Hyperdrive query caching](https://developers.cloudflare.com/hyperdrive/concepts/query-caching/)、[Workers previews](https://developers.cloudflare.com/workers/configuration/previews/)、[PlanetScale pricing](https://planetscale.com/pricing)、[OCI PostgreSQL pricing](https://www.oracle.com/cloud/postgresql/pricing/)、[OCI connect to DB](https://docs.oracle.com/en-us/iaas/Content/postgresql/connect-to-db.htm)。

## 14. 切換後現況（2026-09-25）

2026-09-25 02:14 UTC 切到 Worker，03:07–03:10 UTC 收尾。維護窗約 10.5 分鐘（503 頁）。Release `aba91745ae519a74c646975ba12ea3c71da490ef`。最終 Castle dump（81 tables、8,114 rows）已還原，列數相同，sessions 保留。本目錄工具仍無 execute。

正式環境：

- Worker `freedom-platform-next`（wrangler env `next`，`FREEDOM_ENV=public`）。`workers_dev` 與 `preview_urls` 為 false。Smart Placement 關。
- 唯一路由是 zone route `freetwai.com/*`（`zone_name` `freetwai.com`）。沒有 custom domain。
- `APP_ORIGIN` 是 `https://freetwai.com`。
- Apex DNS 是 proxied `AAAA 100::` placeholder，不再 CNAME 到 Castle tunnel。
- Hyperdrive `freedom-next-hd` → PlanetScale `freedom-next-pg` 資料庫 `freedom_next`（PG18，Tokyo）。Caching disabled，`origin_connection_limit` 15（PS-5 `max_connections` 25）。
- Secrets `FREEDOM_ADMIN_CSRF_SECRET` 與 `GITHUB_SOCIAL_TOKEN_KEY` 已設在 Worker，write-only。發布不重傳。
- Repo 內 Hyperdrive id 仍是全零 template。

已移除：custom domain `next.freetwai.com` 與其兩個 Access application；Castle 上舊的 `freedom-public*` user units 與舊 release checkouts。同日的 staging 切換刪除了 tunnel `freedom-staging`，見下方。

Castle 不再提供 `freetwai.com` 或 `staging.freetwai.com`。留下的是開發用 Compose Postgres、`freedom_local`、admin-access sync timer，以及兩個雲端資料庫的每日 dump。細節見下方 staging 段。

發布：私有 helper `release-deploy.mjs`（plan → deploy → health／route 驗證；不重傳 secrets），接著 `npx tsx scripts/verify-cloud-candidate.ts execute --target public ...`。`--target next` 自 2026-09-25 起不再解析。

回退只有 R3：已有真實寫入之後，dump `freedom_next`，還原進新的本機資料庫。不要指回凍結的舊 DB。

`hypopg`：PlanetScale 自動安裝（schema `pscale_extensions`，owner `pscale_admin`）。「沒有 extension」的驗證必須把它與 `plpgsql` 一起列入 allowlist。見 [30-verify-readonly.psql](../../deploy/cloudflare/sql/30-verify-readonly.psql)。

Staging（2026-09-25，同日切換完成）：Castle staging 已退役。Castle 只做開發。Staging 在雲上。

- Worker `freedom-platform-staging-next`（wrangler env `staging-next`，`FREEDOM_ENV=staging`），release 與正式環境相同：`aba91745ae519a74c646975ba12ea3c71da490ef`。`workers_dev` 與 `preview_urls` 為 false。
- 唯一路由是 zone route `staging.freetwai.com/*`（zone `freetwai.com`）。`APP_ORIGIN` 是 `https://staging.freetwai.com`。
- DNS 是 proxied `AAAA 100::` placeholder，不再 CNAME 到 Castle tunnel。
- Hyperdrive `freedom-staging-next-hd`（caching disabled，`origin_connection_limit` 15）→ PlanetScale `freedom_staging_next`（PG18，Tokyo，PS-5 單節點）。
- 資料：最終 Castle `freedom_staging` dump（81 tables；staging 示範帳號與示範社群，從來不是線上會員資料）已還原進 `freedom_staging_next`，取代先前的合成演練資料。註冊社群變數指向該示範社群。
- Secrets：`FREEDOM_ADMIN_CSRF_SECRET`（新值）與 `GITHUB_SOCIAL_TOKEN_KEY`（沿用原本 Castle staging 的 key，既有 GitHub token 仍可解密）。兩者 write-only，發布不重傳。
- Access 不變：既有 application `Freedom staging`（整個 `staging.freetwai.com`，具名人員）與 `Freedom staging administrators`（`staging.freetwai.com/admin`，指定的 super administrators）。Castle 的 admin-access sync timer 繼續同步；staging scope 經 0600 override env 讀 PlanetScale。這兩個 application 是既有受保護對象，計畫只引用、不建立、不修改、不刪除。
- 已移除：hostname `staging-next.freetwai.com`、它的 Worker custom domain，以及 Access application `Freedom staging-next` 與 `Freedom staging-next administrators`。
- Castle：`freedom-staging.service`、`freedom-staging-tunnel.service`、`freedom-staging-backup.service`／`.timer` 已退役；tunnel `freedom-staging` 已刪除；本機資料庫 `freedom_staging` 在驗證過最終 dump 之後已 drop。port 4310／4312 空出來給 `npm run demo`。Castle 保留：共用 Compose Postgres 與 `freedom_local`（開發）、admin-access sync timer（兩個 scope 都讀 PlanetScale）、`freedom_next` 與 `freedom_staging_next` 的每日 off-provider `pg_dump`（落到 Castle），以及 operator 私有的 release／cutover helper。
- 發布：同一個私有 helper，接著 `npx tsx scripts/verify-cloud-candidate.ts execute --target staging`。`--target staging-next` 與 `--target next` 都不再解析。
- 回退與正式環境同一條 R3：dump `freedom_staging_next`，還原進新的本機資料庫。不要指回已凍結的舊資料庫（本機 `freedom_staging` 也不存在了）。

受保護 hostname 清單是空的。允許的 hostname 只有這兩個環境；其餘拒絕。`next.freetwai.com` 與 `staging-next.freetwai.com` 必須維持不存在（DNS、custom domain、Access application）。
