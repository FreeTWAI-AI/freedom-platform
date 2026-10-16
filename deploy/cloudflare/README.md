# deploy/cloudflare

這是 Cloudflare Workers＋Hyperdrive＋PlanetScale Postgres 18（由 Cloudflare 計費）遷移的 preflight 工具。流程、費用、替代方案與回退見 [遷移手冊](../../docs/development/cloudflare-migration.md)。

工具能力：唯讀 preflight，沒有 execute 能力。本目錄沒有任何會改動 provider、資料庫或既有主機的程式，不產生 billing signature、不登入 pscale；Cloudflare client 只發 GET。

目前已於 2026-10-04 09:03:44 UTC 完成 staging／公開入口的新 PostgreSQL branch 切換，runtime 固定為 `9cc283c6`；現行 bindings、資料核對、HTTPS 與日備份證據見 [實際移植報告](../../docs/platform-plan/execution/unified-foundation/actual-migration-2026-10-04.md)。舊來源保留封存，開始新寫入後不能盲切回。以下 2026-09-25 的 `cutover_complete` 記錄描述首次 Cloudflare 切換；manifest 的舊 Hyperdrive／資料庫部署參數保留當時歷史，不代表本輪現行資源。`next` 是正式環境：Worker `freedom-platform-next`，唯一路由是 zone route `freetwai.com/*`，`APP_ORIGIN` 為 `https://freetwai.com`。`staging-next` 是 staging：Worker `freedom-platform-staging-next`，唯一路由是 zone route `staging.freetwai.com/*`，`APP_ORIGIN` 為 `https://staging.freetwai.com`，`FREEDOM_ENV` 為 `staging`。`next.freetwai.com` 與 `staging-next.freetwai.com` 及其 Access application 已刪除。受保護 hostname 清單是空的：zone 裡不再有 Castle tunnel hostname，允許的 hostname 只有這兩個環境，其餘拒絕。Castle 只做本機開發。`plan --env next` 與 `plan --env staging-next` 都描述現行拓撲、同一個私有 helper 的發布路徑，以及 R3 回退；staging 的驗收目標是 `verify-cloud-candidate.ts execute --target staging`。

2026-09-24 的候選站觀察（Workers Paid、Tokyo 報價、演練還原、132 項檢查）留在 manifest 的 historical 欄位，不是現行拓撲。細節見 [現況交接](../../docs/development/cloudflare-migration-status-2026-09-24.md) 與 [遷移手冊 §14](../../docs/development/cloudflare-migration.md#14-切換後現況2026-09-25)。切換前「候選 hostname 應該還沒有 DNS」「zone route 必須是 0」「兩個受保護 hostname 共用 tunnel」這類檢查已改成首次切換後預期；舊判準寫在程式註解裡，沒有把 evidence 刪掉。

Repo 的 `wrangler.jsonc` Hyperdrive id 刻意維持全零 template，真實 id 只在私有 overlay；全零代表只靠 repo 不能部署，不代表資源不存在。受保護的對象見 [environments.json](environments.json) 的 `protected`：hostname 清單是空的；既有 Tunnel／Access（`Freedom public administrators`、`Freedom staging`、`Freedom staging administrators`，只引用、不建立）、R2、OCI 上既有的 VM，以及本機資料庫 `freedom_local`。`freedom_public` 與 `freedom_staging` 已 drop，回退不能指回那兩份凍結的舊 DB。Castle staging units、port 4310／4312 與對應路徑在 `historical_retired_2026_09_25`。PlanetScale 會自動安裝 `hypopg`（schema `pscale_extensions`，owner `pscale_admin`）；[30-verify-readonly.psql](sql/30-verify-readonly.psql) 列出 `plpgsql` 以外的 extension，讀結果時必須把 `hypopg` 列入 allowlist。

| 檔案 | 內容 |
| --- | --- |
| [environments.json](environments.json) | `staging-next`／`next` 的名稱與隔離規則、單一 `HYPERDRIVE`、PS-5 size 與 Tokyo org 報價（org_quote_recorded）、觀察到的佈建進度（不含 ID）、OCI／D1 替代方案 |
| [preflight.mjs](preflight.mjs) | CLI：`manifest`、`migrations`、`wrangler`、`cost`、`oci-alternative`、`cloudflare`、`oci`、`planetscale`、`plan`、`all` |
| [release-compatibility.md](release-compatibility.md) | `compatibility --compatibility-input P`：來源／完整 schema ledger／rollback floor 的本機判定；可信 host port 另注入，沒有部署或還原授權。程式庫另有 host v3 精確集合；此 CLI 仍走 legacy scanner，不選 v3 |
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

[environments.json](environments.json) 的 `database_defaults.migrations.last` 是目前最後一個 migration 的編號。新增 migration 的 PR 要一併把它改成新的編號；測試裡的檔案數和最後一個檔名都由它推算，不必另外改。GitHub Actions 另有 `deploy-preflight` job 跑這組測試；它是否為必要合併檢查，仍以實際 GitHub 規則為準，不能由 workflow 註解推定。`migrations` 與 `all` 也會回報缺漏。

#257 的本分支 migration frontier 是 **155**，不是正式環境已套用的聲明。換入本版 source 前須先套用 `154_squad_outcomes.sql`、`155_event_outcomes.sql`，即使 `FREEDOM_SQUAD_OUTCOMES_ENABLED`／`FREEDOM_EVENT_OUTCOMES_ENABLED` 都維持預設關閉：既有集錦媒體入口仍須查 binding 表，關閉 flags 不得略過已存摘要／來源 ACL。活動精華 flag 需要小隊成果 flag 同時開啟，否則 Worker readiness 拒絕不完整設定。不可盲退到忽略 binding 的舊 reader；本機來源與 migration 檢查不授予 migrate、部署或啟用權，也不改寫上方歷史部署證據。契約見 [member API](../../docs/development/member-api.md#event-highlights-and-published-squad-outcomes-257)。

Worker entry、`wrangler.jsonc`、`apps/platform-api`、`packages/db` 與套件依賴由其他工作流負責；本目錄只讀取並驗證它們。`preflight.mjs wrangler` 不驗證 [wrangler.admin-sync.jsonc](../../wrangler.admin-sync.jsonc) 與 [wrangler.maintainer.jsonc](../../wrangler.maintainer.jsonc)：那個 checker 要求平台 route、assets 與 images。兩支 cron Worker 分別由 `npm run worker:dry-run:admin-sync` 與 `npm run worker:dry-run:maintainer` 打包。見下方「管理員 Access 同步 Worker」與「維護者鏡像 Worker」。

## 私人政策的應用角色邊界

085 之後，公開 [runtime grants template](sql/20-runtime-grants.psql) 在同一交易內先套一般 grants，再移除私人政策表的所有直接 table／column grants，只給 SELECT 與生成常數 `scope_kind` 的 column UPDATE。後者只讓 PostgreSQL `FOR SHARE` 能執行，不能修改保存開關、配額、revision 或 owner。一般 SELECT-only 角色不能取得該 row lock。

App role 必須是專用角色：沒有父角色 membership（包括 NOINHERIT 下仍可 SET ROLE 的 membership、ADMIN-only membership）或管理角色屬性。殘留 inherited／PUBLIC 寫入、其他 column UPDATE、grant option、生成欄位漂移都令 template 拒絕並 rollback；不自動撤銷別的角色／PUBLIC 權限。Operator 須處理根因後重跑，不能忽略錯誤。

每次 migration 或 restore 後、應用程式連回前重跑。085 前表不存在不做變更；這不是 085 後可缺表的證據。[唯讀 checker](sql/30-verify-readonly.psql) 是報表，不以 exit 0 表示安全：085 後須恰有一列 `private_policy_read=true`、`private_policy_lock=true`、`private_policy_unsafe=false`，並另通過原有角色、ownership、public CREATE 與 ledger 檢查。只有 SQL ledger 相符不足以排除 ACL／DDL 漂移。

這些是公開模板及隔離 PostgreSQL 測試，不會自動更新含秘密的 release helper。正式 grants-check 的接線與 redacted evidence 尚須另驗；未設定正式允許政策、quota、備份、私人 GC 或新的 HTTP/UI。

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

## 維護者鏡像 Worker

階段 1a 把拉取請求、檔案、審查與檢查鏡像進資料庫，並算出注意事項與佇列狀態。認領與儲存庫歸屬（階段 1b、1c）寫在資料庫。三個條件都成立時，這支 Worker 才會對被認領的那一位審查者呼叫 GitHub requested reviewers：App 的 Pull requests 是 Read & write（App 建立時就包含，不必事後重新同意）、`GITHUB_MAINTAINER_WRITES` 正好是 `requested_reviewers`、該儲存庫的 `request_reviewers` 沒有設成 false（沒設定時是 true）。`staging-next` 與 `next` 提交的變數值是 `requested_reviewers`，top-level 是 `off`。它不送審查、不留言、不改標籤、不合併，也不呼叫 AI。入口是 [apps/platform-api/src/maintainer-worker.ts](../../apps/platform-api/src/maintainer-worker.ts)，只匯出 `scheduled`，沒有 `fetch`、route、custom domain、workers.dev 或 preview URL。設定是 [wrangler.maintainer.jsonc](../../wrangler.maintainer.jsonc)。Webhook 收在平台 Worker，私鑰只放在這支 Worker。操作說明見 [repo-maintainer.md](../../docs/development/repo-maintainer.md)。

`npm run worker:dry-run:maintainer` 打包 top-level、`staging-next` 與 `next`。`preflight.mjs wrangler` 不檢查這個檔。Repo 只做 dry-run，不部署。

| env | Worker 名稱 | 資料庫 |
| --- | --- | --- |
| `staging-next` | `freedom-maintainer-staging-next` | 與 `freedom-platform-staging-next` 同一份、caching disabled 的 Hyperdrive |
| `next` | `freedom-maintainer-next` | 與 `freedom-platform-next` 同一份、caching disabled 的 Hyperdrive |

每個環境在私有 overlay 要替換的名稱：`HYPERDRIVE`、`GITHUB_MAINTAINER_APP_ID`（數字，不能是 0）、`GITHUB_MAINTAINER_ORG`。`GITHUB_MAINTAINER_WRITES` 在 `staging-next` 與 `next` 已提交為 `requested_reviewers`，top-level 是 `off`；要停止寫入 GitHub 時改成 `off`。其他值在 tick 摘要裡記成 `writes=invalid`，不會寫 GitHub。Secret 是 `GITHUB_MAINTAINER_PRIVATE_KEY`（PKCS#8），用 `wrangler secret put` 上傳，不要寫進 `--var`。平台 Worker 另有選填的 `GITHUB_MAINTAINER_WEBHOOK_SECRET`。排程是 `* * * * *`。失敗訊息固定，日誌只有計數。刪除的是 `freedom-maintainer-*`，不是平台 Worker。

## 平台 Worker 商家憑證金鑰（COMMERCE_CREDENTIAL_KEYS）

平台 Worker 選填 secret `COMMERCE_CREDENTIAL_KEYS`，用於封存商家服務憑證，見
[EC-SPEC-04 §1.3](../../docs/platform-plan/execution/commerce/EC-SPEC-04-payment.md#13-金鑰保存提議-commerce_provider_credentials)。
格式是 1–8 組以逗號分隔、沒有空白的 `key_id:base64`；id 不可重複，須符合
`^[a-z0-9][a-z0-9_-]{0,31}$`，每個值須為恰好 32 個隨機位元組的標準 base64
（解碼後重新編碼須與原值相同）。第一把金鑰封存新憑證；所有已安裝金鑰都能解封其對應的保留紀錄。
未設定或空字串時，憑證寫入回 503，讀取仍可用。格式錯誤會使 Worker 就緒檢查與 Node 啟動失敗，
錯誤訊息固定且不含設定值。Secret 不可寫進已提交的設定、日誌或 `--var`。

可把新金鑰放在第一組供新憑證使用，但須保留所有已安裝金鑰。`resealProviderCredentials`
目前是內部函式，尚無供操作者使用的 route、CLI 或排程入口。在 runtime 角色下，一次呼叫只會
重新封存呼叫者交易所綁定 tenant 的紀錄，最多 `limit` 列。操作者程序完成前，不可移除任何線上金鑰，
否則仍以該金鑰封存的紀錄將無法讀取。退役金鑰仍須離線保留至備份保存期結束，見
[EC-SPEC-10 §4.3](../../docs/platform-plan/execution/commerce/EC-SPEC-10-release-operations.md#43-部署設定ted-操作)。
金鑰環輪替會改變憑證寫入指紋，跨輪替重送會回 409；讀取目前帳戶版本後須使用新的命令識別碼。
`FREEDOM_ENV` 決定 provider 環境：`local`／`staging` 使用 `sandbox`，`public` 使用 `live`。
安裝這個 secret 不會啟用 provider adapter 或任何對外呼叫。

## 平台 Worker 付款 profile 與外部效果日誌

`FREEDOM_COMMERCE_PROVIDER_PROFILES` 未設定或空字串時為空清單，不開放付款。
目前只實作 `ecpay.aio.credit.v1`；格式為逗號分隔，不能含空白、空項目、重複或未知 ID。
格式錯誤會以固定訊息拒絕就緒，不回顯設定值。非空清單同時需要可用的
`COMMERCE_CREDENTIAL_KEYS` 與 `COMMERCE_JOURNAL` R2 binding；缺少時分別回報
`commerce_profiles_require_keyring`、`commerce_profiles_require_journal`。
Wrangler 檢查會要求同一設定區塊宣告 `binding: "COMMERCE_JOURNAL"` 的 `r2_buckets`
項目；設定檔無法證明 secret 可解封，仍由 Worker 就緒檢查把關。Node server 沒有
R2 日誌，非空清單會使啟動失敗；只有本機 E2E 使用記憶體日誌與合成付款閘道。

`COMMERCE_JOURNAL` bucket 由 Ted 另行建立，每個環境各一個，啟用 bucket lock，
保存期至少 60 天。Wrangler 預檢拒絕跨環境重複的日誌 bucket 名稱，也拒絕與任何
環境的其他 R2 binding（含媒體）共用 bucket。日誌使用條件式建立與固定 UTC 路徑，保留付款交接及控制事件的
小型允許欄位，不含個資、原始通知或金鑰。只有列出 profile 的環境才加入 binding；
bucket 尚未建立，因此本次不在 `wrangler.jsonc` 加入變數或 binding。帳戶、服務、
商店准入與 checkout 開關仍須各自完成，列出 profile 不授予付款或部署權限。

staging Access 僅對 `/api/v1/provider-callbacks/ecpay/*` 與
`/pay/ecpay/return/*` 設定 bypass，供綠界通知與瀏覽器 POST 返回；應用仍只接受
精確的 POST 路徑、Host、表單限制與簽章。其他付款路徑不需額外 bypass 或設定。
Worker 的付款確認查詢會從伺服器向 `payment-stage.ecpay.com.tw`（sandbox）或
`payment.ecpay.com.tw`（live）送出 QueryTradeInfo/V5。這是向外的請求，staging
不需新增 Access bypass。正式 transport 只接受對應環境的精確 origin 與查詢路徑，
不跟隨重新導向；單次逾時 10 秒，回應上限 64 KiB。本機及瀏覽器測試只安裝 fixture
transport，不會連到綠界。

每十分鐘的 commerce cron 先重放未套用的付款事件，再清理保留、執行 due work、
補寫控制事件日誌。due work 每次最多認領 200 列、呼叫提供者 50 次、執行 5 分鐘；
未開始的租約會釋出。通知及瀏覽器返回提交後也會透過 `waitUntil` 立即執行該筆工作，
每項最多 25 秒，完成後才關閉連線池；逾時由租約到期與 cron 接手。
隔離模式不執行這些工作。查詢是唯讀，不寫外部效果日誌；啟用收款服務的控制事件仍由
既有 flush 補寫。403 只暫停同一帳戶的付款查詢 30 分鐘，不影響物流或發票服務。

`FREEDOM_COMMERCE_EMAIL_ENABLED` 預設關閉，只接受 `'true'`／`'false'`。開啟時，同一環境區塊須宣告名稱為 `EMAIL` 的 `send_email` binding（缺少時回報 `commerce_email_binding_required`）以及 `COMMERCE_JOURNAL` R2 binding（缺少時回報 `commerce_journal_binding_required`），Worker 就緒檢查也會驗證 `EMAIL.send` 與 `COMMERCE_JOURNAL`。Node server 沒有 `EMAIL` binding 與外部效果日誌，設為 `'true'` 時以 `commerce_email_requires_worker` 拒絕啟動；只有本機測試與 E2E server 安裝記憶體 fixture sender 與記憶體日誌。是否於已部署環境開啟此旗標由 Ted 依 [EC-SPEC-10 §6.2](../../docs/platform-plan/execution/commerce/EC-SPEC-10-release-operations.md) 授權決定，不在 repo 預設啟用。

見 [EC-SPEC-04](../../docs/platform-plan/execution/commerce/EC-SPEC-04-payment.md)、
[EC-SPEC-10 §2.2、§4.4、§6.2、§8.2](../../docs/platform-plan/execution/commerce/EC-SPEC-10-release-operations.md)。

## 商務主控台與結帳開關

`FREEDOM_COMMERCE_CONSOLE_ENABLED` 預設關閉，只有明確的 `true` 才安裝新的賣家訂單、付款例外、人工退款紀錄與付款查詢路由；關閉時這些路由回傳 404。它需要同一環境的 `FREEDOM_GUILD_LAUNCHPAD_ENABLED=true` 與 `FREEDOM_SUPPLIER_CONSOLE_ENABLED=true`（賣家頁使用 Supplier Console 的殼）。`FREEDOM_COMMERCE_CHECKOUT_ENABLED=true` 則需要主控台開關同時開啟，確保店家可以處理新訂單。兩者都只接受 `true`／`false`；就緒與安裝檢查分別以 `commerce_launchpad_required`、`commerce_supplier_console_required`、`commerce_console_required` 拒絕缺少的依賴。關閉結帳不會關閉既有訂單的賣家服務。詳見 [EC-SPEC-10 §2.2](../../docs/platform-plan/execution/commerce/EC-SPEC-10-release-operations.md#22-主機設定提議)。
