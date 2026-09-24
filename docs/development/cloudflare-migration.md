# Cloudflare Workers＋PlanetScale Postgres 遷移：preflight、演練、切換與回退

> 狀態（2026-09-24）：**preflight 階段**。沒有建立任何 Cloudflare／PlanetScale 資源，沒有讀寫或匯出任何資料庫，也沒有切換流量。本文的名稱與價格都是計畫值；實際 provider ID 只在之後經審查的 provisioning 階段寫入私密 evidence 檔。

Canonical 方向見 [08 Bootstrap／Hosting](../platform-plan/08-bootstrap-hosting-project-lifecycle.md) §3.3、§5.1：Workers → Hyperdrive → Cloudflare 計費的 PlanetScale Postgres。本頁把它落成這次搬遷可執行、可回退的順序。工具與測試在 [deploy/cloudflare](../../deploy/cloudflare/README.md)。

## 1. 不動範圍（protected）

目前 `freetwai.com`（Castle `127.0.0.1:4312`）和 `staging.freetwai.com`（`127.0.0.1:4310`）都經 Tunnel 服務，DB 是 Docker PG18 `127.0.0.1:54339` 內各自的資料庫，見 [公開運行手冊](public-operations.md)、[staging 運行手冊](staging-operations.md)。搬遷期間以下全部維持原狀，工具採 default-deny：

| 類型 | 保護對象 |
| --- | --- |
| Hostname | `freetwai.com`、`staging.freetwai.com`；zone 內除 `staging-next`／`next` 以外全部 |
| Tunnel | 所有既有 Tunnel。2026-09-24 唯讀 probe：兩個受保護 hostname 的 DNS 指向**同一個** tunnel target，所以那條 Tunnel 同時承載 live，staging 工作不可改它 |
| Access | `Freedom public administrators`、`Freedom staging`、`Freedom staging administrators` |
| R2 | 所有既有 bucket（目前 4 個，皆非 Freedom） |
| 本機 | port 4310／4312／54339；`freedom-public*`、`freedom-staging*` user units；`freedom_local`／`freedom_staging`／`freedom_public` DB；既有 release、config、backup 目錄與 [backup.sh](../../deploy/staging/backup.sh) |

保護清單的機器可讀版本在 [environments.json](../../deploy/cloudflare/environments.json) 的 `protected`，mutation guard 與測試都讀它。

## 2. 目標：兩個獨立候選環境

| | `staging-next.freetwai.com` | `next.freetwai.com` |
| --- | --- | --- |
| 用途 | Workers runtime 的 staging | Production candidate；切換前一直受 Access 保護 |
| 資料 | **只用 synthetic**：migration＋空 community＋明確命名的測試會員；不跑 `seedLocal`，不含 `@local.test`，不還原 staging 或 public 資料 | 演練時還原已驗 checksum 的 `freedom_public` 備份；最後切換時才做最終匯出 |
| Worker | `freedom-platform-staging-next` | `freedom-platform-next` |
| Hyperdrive | `freedom-staging-next-fresh`（caching disabled，必需）；`-cached` 選配 | `freedom-next-fresh`（caching disabled，必需）；`-cached` 選配 |
| PlanetScale | `freedom-staging-next`，PS-5 single node | `freedom-next`，PS-5 HA（1 primary＋2 replicas） |
| DB roles | `freedom_staging_next_migrator`／`_app` | `freedom_next_migrator`／`_app` |
| R2（選配） | `freedom-staging-next-private` | `freedom-next-private` |
| Access | `Freedom staging-next`＋`/admin` app | `Freedom next candidate`＋`/admin` app |

兩環境沒有任何共用 resource、token、secret、DB role 或 Hyperdrive ID。Worker 必須明寫 `workers_dev = false` 與 `preview_urls = false`：Cloudflare 文件指出省略 `preview_urls` 時不會改動既有設定，而 Version／Preview URL 啟用時是公開的；因此不以 preview URL 繞過 Access。Access application 要在任何 Worker route 生效**之前**建立，只允許具名人員，不設 Bypass／Everyone。

Runtime DB 連線只來自 Hyperdrive binding；Worker 不持有 `DATABASE_URL` secret。Worker secrets 只有 `GITHUB_SOCIAL_TOKEN_KEY`、`FREEDOM_ADMIN_CSRF_SECRET`，其他設定為一般 vars。

## 3. Preflight 工具

全部唯讀，沒有 execute 模式（`--execute` 直接以 exit 3 拒絕）：

```sh
node deploy/cloudflare/preflight.mjs manifest       # 名稱、隔離、預算、快取、資料來源規則
node deploy/cloudflare/preflight.mjs migrations     # 001–037 對 PlanetScale 非 superuser 的相容性
node deploy/cloudflare/preflight.mjs wrangler --config <path>   # 另一工作流的 Worker config；目前 not_run
node deploy/cloudflare/preflight.mjs cloudflare --env-file ~/.cloudflared/cf-api.env --report
node deploy/cloudflare/preflight.mjs planetscale [--pscale-org <org>]
node deploy/cloudflare/preflight.mjs plan --env staging-next   # 或 next；只輸出 dry-run 步驟
node --test deploy/cloudflare/test/*.test.mjs
```

- Cloudflare：credential 檔必須 0600 且屬於目前使用者；只保留 `CF_ACCOUNT_ID`／`CF_API_TOKEN` 兩個 key，token 只存在 closure 內，不進 argv、log、JSON 或 inspect。Client 只有 `get()`，路徑必須在 allowlist 內。
- PlanetScale：只接受固定的唯讀 argv（`version`、`auth check`、`org list`、`database list`、`region list`、`size cluster list`）；database 只保留 name／kind／region／state。
- 報告：stdout 與 `--report` 檔都經 redaction；檔案寫在 `~/.local/state/freedom-cloudflare-migration/reports`（目錄 0700、檔案 0600）。報告只記 DNS 內容的 fingerprint，不記 tunnel target 或 account ID。

## 4. 認證與權限阻擋（2026-09-24 實測）

### Cloudflare

既有 `~/.cloudflared/cf-api.env` token 為 active，但：

| 能力 | 結果 | 本次搬遷需要 |
| --- | --- | --- |
| DNS、Access apps／policies、Tunnel、R2 | 可讀寫 | DNS Edit、Access: Apps and Policies Edit、Workers R2 Storage Edit：已具備 |
| Workers scripts list | 200 但 0 筆，且 token 無 Workers Scripts 權限群組 | 視為**不確定**，不能證明帳戶沒有 Worker |
| Workers subdomain／custom domains | 403 | Workers Scripts Read／**Edit** |
| Hyperdrive | 403 | Hyperdrive Read／**Edit** |
| Workers routes（zone） | 403 | Workers Routes Read／**Edit** |
| Cache rules（zone） | 403 | Cache Rules Read（驗證沒有規則快取 `/api/*`） |
| Subscriptions | 403 | Billing Read（確認 Workers Paid；scrypt 密碼雜湊可能超過 Free 方案的 CPU 限制，需實測） |

另一個風險：這個 token 含 **API Tokens Write**，能自行建立或擴權 token；它也沒有 TTL 與 IP 限制。它不能用於部署自動化，工具也不會用它建立 token。

Ted 在 Cloudflare dashboard 的具體操作（工具不代為執行）：

1. **My Profile → API Tokens → Create Token → Create Custom Token**，名稱 `freedom-cf-readonly-preflight`：
   - Account：Workers Scripts Read、Hyperdrive Read、Billing Read、Access: Apps and Policies Read、Workers R2 Storage Read；Account Resources 只含 Freedom 帳戶。
   - Zone：Zone Read、DNS Read、Workers Routes Read、Cache Rules Read；Zone Resources 只含 `freetwai.com`。
   - Client IP filtering 設為 Castle 的出口 IP；TTL 設到演練結束。
2. 部署用 token 要到 provisioning 階段才建立：`freedom-cf-deploy-staging-next` 與 `freedom-cf-deploy-next` 各一，權限 Workers Scripts Edit、Hyperdrive Edit、Workers R2 Storage Edit（選配），zone `freetwai.com` 的 Workers Routes Edit、DNS Edit。Cloudflare token 無法限定單一 Worker script，兩環境的區隔靠分開的 token、名稱 guard 與審查，不宣稱 API 層級隔離。
3. Access app 由 Ted 或持 Access Edit 權限的一次性 token 建立，完成後撤銷。
4. 新 token 只存入新的 0600 檔（例如 `~/.config/freedom-cloudflare/readonly.env`）；不貼到對話、repo 或命令列。
5. 建議把既有 cloudflared token 的 API Tokens Write 移除，或改由獨立 token 管理。這會影響 Castle 其他專案，由 Ted 決定。

### PlanetScale

`pscale` v0.338.0 已安裝在 `~/.local/bin/pscale`；tarball SHA-256 已對照 release `checksums.txt` 與 GitHub asset digest（此 release 沒有 GitHub build attestation）。目前**未登入**：兩次官方 device login 都在約 5 分鐘內以 `DEVICE_AUTH_FAILED` 結束，沒有保存任何 credential。下一步需要 Ted 在場：先執行 `pscale auth login --format json`，並在拿到網址後立刻用既有 PlanetScale 帳號核准；工具不建立帳號，也不代為接受條款。登入後執行 `preflight.mjs planetscale`，確認 organization、Tokyo region 與即時 SKU 價格。

## 5. 區域、規格與費用（2026-09-24 公開 catalog，不是報價）

PlanetScale 公開 catalog 沒有台灣或香港 region。依距離，偏好順序是 AWS `ap-northeast-1`（Tokyo，pscale slug `ap-northeast`），其次 GCP `asia-northeast3`（Seoul），再來 AWS `ap-southeast-1`（Singapore）。購買前以登入後的 `pscale size cluster list` 與實測延遲確認。

| 項目 | 規格 | Tokyo catalog 月費 |
| --- | --- | --- |
| staging-next DB | PS-5 arm64 single node（1/16 vCPU、512 MiB） | US$5 |
| next DB（演練起點） | PS-5 arm64 HA | US$15 |
| next DB 升級門檻 | PS-10 arm64 HA，只在負載／連線測試失敗時 | US$41 |
| Workers Paid | account 最低 | US$5（若尚未啟用） |

DB 基本費 US$20／月，觸發升級門檻則 US$46／月；加 Workers Paid 約 US$25–51。Storage、備份超額（US$0.023/GB-month）、egress 另計。US$50–100 是工程估算，不是可以超支的授權；manifest 把 DB 基本費上限鎖在 US$60，超過就要重新核准。不買 Metal、enterprise 或 Managed。PlanetScale 目前支援 Postgres 17.11 與 18.6，新 DB 預設最新版；本案固定 **18**，與來源 PG18 一致（PlanetScale 不提供 major version 原地升級）。

## 6. DB 權限、migration 與還原相容性

- PlanetScale 預設 `postgres` role 是 `NOSUPERUSER CREATEDB CREATEROLE … BYPASSRLS`，不是 superuser。不要假設 superuser。
- 靜態檢查結果：`migrations/` 共 36 個檔，001–037，**022 從未存在**（git 歷史也沒有），是已知缺號。沒有 `CREATE EXTENSION`、`ALTER SYSTEM`、role 管理、`OWNER TO`、`SECURITY DEFINER` 或 untrusted language；`gen_random_uuid()` 在 PG13 以後是內建。4 個檔建立 plpgsql trigger function（003、011、026、030），由 migrator 擁有即可。
- Migration ledger：`schema_migrations(name, sha256)`，sha256 為 `sha256(JSON.stringify(sql))`，與 `packages/db` 的 `digest()` 一致。工具輸出 ledger digest；還原後再跑一次 repository runner，結果必須是 no-op，不能出現 `Applied migration changed`。
- Roles（[10-create-roles.psql](../../deploy/cloudflare/sql/10-create-roles.psql)）：先以預設 role 建立專用 database（`freedom_next`／`freedom_staging_next`），再建立 `*_migrator`（擁有 schema objects）和 `*_app`（runtime，只有 DML）。密碼以 `\getenv` 從私密檔 source 進來的環境變數讀取；psql／pg_restore 一律用 `service=<name>`（PGSERVICEFILE／PGPASSFILE 放在 0600 私密目錄），命令列上沒有 host、user 或密碼。
- Grants（[20-runtime-grants.psql](../../deploy/cloudflare/sql/20-runtime-grants.psql)）：runtime 對 tables 只有 SELECT／INSERT／UPDATE／DELETE，沒有 DDL、TRUNCATE 或 ownership；`schema_migrations` 對 runtime 唯讀。Runtime code 沒有 DDL；所有 advisory lock 都是 `pg_advisory_xact_lock`，相容於 Hyperdrive 的 transaction pooling。
- 驗證（[30-verify-readonly.psql](../../deploy/cloudflare/sql/30-verify-readonly.psql)）：只輸出計數與布林值，包括 pg major、role 屬性、runtime 不能 CREATE、runtime 沒擁有任何物件、extension 清單、migration 數與首尾、`@local.test` 帳號數必須是 0、runtime 不能寫 ledger。
- 還原：`pg_restore --no-owner --no-privileges --exit-on-error --single-transaction`，目標是空 DB，以 migrator 連線；之後重跑 grants 與驗證。現有 dump 由 `freedom_local`（容器 superuser）產生，所以 owner／ACL 必須丟棄。
- 這些 SQL 在本階段**沒有**對任何伺服器執行過（not_run），第一次執行在 staging-next。

## 7. 快取與授權新鮮度

- Hyperdrive 預設會快取可快取的讀取（`max_age` 60s），寫入後不會失效。session、權限、會員資料、寫入與 read-after-write 查詢**全部**走 caching-disabled 的 `DB_FRESH`。`DB_CACHED`（`max_age` ≤ 60s）只在 Worker 真的需要時，給公開目錄顯示用。
- 現有 app 對所有經 Hono 的回應設 `Cache-Control: no-store`；驗證時確認 Worker adapter 仍保留。沒有任何 Cache Rule 快取 `/api/*` 或帶 cookie 的回應；需要 Cache Rules Read 才能驗證。
- 公開靜態資產（Workers static assets）可以快取。
- 驗收要包含：撤銷權限後下一個請求立即拒絕、登出後舊 cookie 立即失效、寫入後同一會員立刻讀到新值。

## 8. 演練順序（切換前全部要有 evidence）

1. **staging-next**：Access → DB → roles → migrations（synthetic）→ grants → Hyperdrive fresh → secrets（全新隨機值）→ `preflight wrangler` pass → deploy。以短效 Access service token 驗 health、註冊／登入、會員隔離、read-after-write、`no-store`；匿名請求必須被 Access 攔下。
2. **Load 與限制**：對 staging-next 做有上限的負載測試（Hyperdrive 連線數、PS-5 記憶體、scrypt CPU 時間），結果決定是否觸發 PS-10 門檻。
3. **PlanetScale restore drill**：從 PlanetScale 自動備份還原到新 branch，跑 `30-verify-readonly.psql`，完成後刪除該 branch。
4. **next 演練還原**：取最新 `freedom_public` 備份的副本（先驗 checksum，不在 live 上執行新 dump），依第 6 節還原並驗證。接著撤銷所有還原來的 sessions。`GITHUB_SOCIAL_TOKEN_KEY` 使用**新的**演練值：還原來的 GitHub OAuth client secret 與會員 token 因此無法解密，candidate 不可能替會員按星或發訊息；GitHub OAuth callback 仍指向 live origin。比對筆數（users、communities、profiles、sessions 已撤銷數、schema_migrations）。
5. **Identity**：以明確命名的驗證會員走登入、定位、名片、channel 與 unread；Access 後才可見。演練不寄信、不發 GitHub 或社群訊息。
6. 每次演練後保留 counters 與 redacted evidence；不把 raw live data 帶到 staging-next、preview、log 或 repo。演練結束後把 next DB 重建為空，或保留到切換，但一直留在 Access 後。

## 9. 切換（本輪不做；需另一次明確授權）

前提：第 8 節全部通過；[08](../platform-plan/08-bootstrap-hosting-project-lifecycle.md) 的 production HA／PITR 條件已有 evidence；Ted 核准時段與費用。

1. 切換前 live 一直是**唯一寫入權威**，任何時點都只有一個可寫的 production。
2. **短暫 write freeze**：公告時段 → 停止 `freedom-public.service`（Tunnel 顯示錯誤頁，不接受寫入）→ 取得最終 counters。GET 也可能寫入，所以不採「只擋 POST」的半凍結。
3. 最終 `backup.sh` → checksum → 還原到**重新清空**的 `freedom-next` → migration runner no-op → grants → `30-verify-readonly.psql` → counters 與 freeze 時完全一致。
4. 設定 production 設定：`GITHUB_SOCIAL_TOKEN_KEY` 改為 live key（從私密檔 stdin 設定），重設 CSRF secret；`APP_ORIGIN` 改為 `https://freetwai.com`（app 會拒絕與 `APP_ORIGIN` 不同 host 的請求）；admin Access 的 issuer／AUD 改為 live `/admin` application 的值。確認 Hyperdrive 指向 runtime role。
5. **流量切換用 zone Worker route**：在既有 proxied `freetwai.com` 記錄上新增 route `freetwai.com/*` → `freedom-platform-next`（需要 Workers Routes Edit）。DNS 與 Tunnel 記錄不刪，舊 app 只停止、不移除。這個 cutover 用的 wrangler config 要以 cutover 模式另行審查，因為 preflight 會拒絕碰受保護 hostname 的 route。
6. 驗證 live：公開頁、註冊、登入、既有會員登入、admin Access、`no-store`、錯誤率。`next.freetwai.com` 保留在 Access 後。
7. `staging.freetwai.com` 與它的 Tunnel、DB 保持不動。

## 10. 回退

| 時點 | 做法 |
| --- | --- |
| freeze 後、route 生效前 | 啟動 `freedom-public.service`；舊 DB 未被改動 |
| route 生效、**尚無** candidate 寫入 | 刪除 Worker route，流量立即回到 Tunnel；啟動舊 service |
| **已有** candidate 寫入 | 不能直接指回舊 DB，因為它已過期。步驟：再次 freeze（停 Worker route 前先讓 Worker 進維護模式，或暫時以 Access 擋下）→ 從 PlanetScale 匯出 → 還原到本機**新的** `freedom_public_rollback_<UTC>`（不覆寫 `freedom_public`）→ migration runner no-op → 舊 app 的 env 指向新 DB → 刪 route → 啟動 |

回退相容性要在切換**前**確認，任何一項不成立就不切換：

- 切換後到回退窗口結束前，不套用新 migration；PlanetScale 的 `schema_migrations` 必須和舊 app 的 ledger 相同。
- 密碼：舊 app 驗 `salt:hex` 的 scrypt 格式。Worker 若改變密碼雜湊（例如 rehash-on-login），舊 app 必須能驗新格式；或者在回退窗口內停用 rehash。另一工作流的密碼可攜性實作要附這條測試。
- 圖片／avatar：Worker 寫入的格式與存放位置，舊 app 必須能讀；若搬到 R2，回退要一起帶回或保留 DB 內副本。
- Sessions：回退後讓所有 sessions 失效，要求重新登入，避免雙邊狀態。
- Castle 上舊 release、舊 DB、備份在回退窗口內都不刪除。

## 11. 本階段未驗證（not_run）

- 所有 provider mutation、DB 讀寫／匯出／還原、SQL template 執行、Worker 部署、負載測試、restore drill、瀏覽器驗證。
- Workers Paid 是否已啟用（Billing Read 403）；帳戶實際 Worker 數（token 缺 Workers Scripts 權限）；zone cache rules（403）。
- PlanetScale organization、帳單路徑（Cloudflare billing）、Tokyo 的即時可用性與價格（未登入）。
- Worker entry 與 wrangler config 由另一工作流負責，目前不存在；`preflight wrangler` 在它出現後才會跑。

參考：[Hyperdrive query caching](https://developers.cloudflare.com/hyperdrive/concepts/query-caching/)、[Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/)、[Workers previews](https://developers.cloudflare.com/workers/configuration/previews/)、[API token permissions](https://developers.cloudflare.com/fundamentals/api/reference/permissions/)、[PlanetScale roles](https://planetscale.com/docs/postgres/connecting/roles)、[PlanetScale versions](https://planetscale.com/docs/postgres/cluster-configuration/versions)、[PlanetScale pricing](https://planetscale.com/docs/postgres/pricing)、[PlanetScale via Cloudflare](https://planetscale.com/docs/connect/cloudflare)。
