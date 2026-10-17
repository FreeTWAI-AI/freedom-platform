# EC-SPEC-09 安全、隱私、限流、CI 與測試層級

狀態：proposed（2026-10-15），基準 `efaf314d`。對應需求 EC-R05、R06、R16、R17、R24、R30、R32、R36、R41、R42、R43、R44、R45、R55、R57、R58、R59；驗收 EC-AT02～06、11、13～16、19、24、25、27、29、33、38、39、43、48～51、56、57、59、61、63、65～68（全部 `not_run`）。

各領域的細節在 EC-SPEC-02～06。本文件定跨領域的規則，並定案其他文件交給本文件的項目：能力名稱（§2.2）、機器路徑的交易身分（§2.4）、請求閘道的例外（§2.6）、保存與遮罩（§3）、限流數值（§4）。標「提議」的表、路由與函式尚未存在。

## 1. 現況（已核對）

| 範圍 | 事實 | 位置 |
| --- | --- | --- |
| 店的能力 | `storefront@1.0.0` 只有 `store:manage`、`store:read`、`store:write`、`store:publish`，DB 端的清單凍結 | `modules/module-registry/definitions.ts:75`、`migrations/134_hosted_storefronts.sql:88` |
| owner／admin | 自動擁有全部 store 能力；清單取自程式常數，不是實例登錄的版本 | `modules/agent-commerce/hosted/capabilities.ts:7-16` |
| 一般授權 | `tenant_module_permissions` 每人每實例一列；admin 不另列授權；viewer 只能拿 `:read` 結尾的鍵；模組有 `:read` 鍵時，每列至少要含一個 | `modules/tenant-workspaces/instance-grants.ts:21`、`:30-32` |
| 高風險鍵 | `module.data.export`、`module.authority.transfer`、`module.binding.manage`、`tenant.ownership.transfer`、`instance.manage` 不能出現在授權列（程式與 DB 各擋一次） | `instance-grants.ts:5`、`migrations/131_tenant_module_permissions.sql:26-27` |
| 模組版本 | `module_definitions` 不可改（只有發布狀態與授權審查能各自前進）；實例的 `module_release_ref` 等身分欄位不可改；`storefront@1.0.0` 的 `supported_upgrade_paths` 是 `[]`，也沒有程式讀這個欄位；SP-04 的升級 API 只在規劃 | `migrations/128_module_registry.sql:130-164`、`131:39-50`、`134:93`、`docs/platform-plan/execution/guild-launchpad/decision-log.md`（SP-04） |
| 會員命令 | `storeCommand` → `scopedTenantCommand`：鎖住 receipt 之後重查 session 時鐘、`authorization_revision`、成員版本與角色，能力檢查當作 `revalidate` 再跑一次；receipt 依 principal、身分種類、scope、操作與 key 分開 | `modules/agent-commerce/hosted/store.ts:94`、`packages/scoped-commands/index.ts:196-283` |
| 權限異動 | 每次權限變更都要呼叫 `bumpAuthorizationRevision` | `modules/tenant-workspaces/facts.ts:42` |
| 交易身分 | RLS 以 `freedom_ctx_tenant()` 判斷；`bindTenantContext` 拒絕從已綁定的 tenant 直接換到另一個，也不檢查 scope 狀態；shared 訂單需要供應商的資料時，先 `clearTenantContext` 再明確綁定下一方（同一交易內依序切換）；公開讀取 `readPublicStorePage` 不綁 tenant；模組排程逐一掃每個 tenant scope | `packages/resource-scopes/tenant-transaction.ts:84-98`、`modules/agent-commerce/hosted/shared-authority.ts:13-17`、`modules/agent-commerce/hosted/public.ts:10`、`modules/module-registry/operations.ts:529` |
| 請求閘道 | 非 GET 一律要 `application/json`、≤ 32 KiB、Origin 在允許清單；例外只有 Agent 上傳、`/shop-api/v1/` 與 maintainer webhook，而且有帶 Origin 時仍要相符 | `apps/platform-api/src/platform-app.ts:228-235`、`:270-273` |
| session cookie | 會員 session 是 `SameSite=Strict` | `platform-app.ts:502` |
| 限流 | `authRateLimit`／`authRateLimitInTransaction`：固定視窗、bucket 名稱存雜湊、超過回 429 `auth_rate_limited`，排程清除過期 bucket。網路鍵是 IPv4 位址或分組後的 IPv6；edge 不可信時全部共用 `shared-server`。`Problem` 帶 `retryAfterSeconds` 時回 `Retry-After` | `modules/identity-membership/members.ts:49-62`、`migrations/005_member_accounts.sql:10`、`auth-pruning.ts:22`、`apps/platform-api/src/worker.ts:174`、`:210-213`、`runtime.ts:20`、`platform-app.ts:186-187` |
| 重新確認身分 | 重新輸入密碼換取短效、一次性的確認；用途只有 owner 轉移與復原三種 | `contracts/guild-launchpad/v1/tenant.ts:114`、`migrations/124_tenant_ownership_recovery.sql:12`、`modules/tenant-workspaces/high-risk-verification.ts:41`、`:91`、`:121` |
| 保存 | OPEN-07（2026-10-07 owner 決定）：備份 30 天；刪除後的衍生副本先隱藏、7 天內清除；匯出下載連結 7 天；tombstone／撤權紀錄至少 45 天；備份到期清除尚未實作。catalog 的保存狀態不能是 `forever`／`needed`／`analytics`；現有 commerce 資料集都是 `policy_undecided` | `guild-launchpad/decision-log.md:13`、`modules/module-data/catalog-check.ts:137`、`:312-315` |
| 個資遮罩 | `commerce_checkout_contacts` 只允許一次遮罩：個資欄位與摘要用的 salt 一起清成 NULL 並填 `redacted_at`，保留加 salt 的摘要。`commerce_customers` 只允許一次遮罩：Email 換成 `redacted:<customer_id>`、清掉 Email 驗證時間；會員關聯照樣保留，與訂單的 `buyer_principal_id` 一樣屬於交易紀錄。遮罩後同一個真實 Email 再結帳會建新的顧客列（分支 `fc/wp03-core` `16caa586`，尚未合併） | `migrations/168_hosted_checkout_core.sql` 的 `preserve_commerce_checkout_contact()`、`preserve_commerce_customer()` |
| 秘密 | repo 沒有 secret scanner；沒有測試檢查 provider 金鑰或卡號片段外洩 | — |
| 測試資料庫 | runtime 測試只接受 `fp_` 開頭、主機為 localhost／127.0.0.1 的資料庫；E2E 的 schema 是 `fp_e2e_<32 hex>` | `tests/runtime/agent-commerce-key-expiry.test.ts:13`、`scripts/e2e-server.ts:67` |
| CI 選測 | `affected` 只涵蓋固定的前端 leaf；SQL、migration、契約、安全路徑、未知路徑與新檔一律 full | `scripts/ci/affected-jobs.md` |

## 2. 權限

### 2.1 呼叫者

| 呼叫者 | 身分 | 能碰的資料 |
| --- | --- | --- |
| 訪客、guest 顧客 | 沒有 principal；`__Host-freedom_shop` 瀏覽器憑證或一次性信件連結（EC-SPEC-02 §4.2） | 已發布的店面；自己的 checkout 與訂單（依 grant） |
| 會員顧客 | 會員 session | 同上，另加本人的訂單 |
| 店的成員 | 會員 session＋角色＋實例授權（§2.2） | 依能力 |
| 出貨者的成員 | 出貨者事業的成員＋自己店的 `store:fulfil` | 自己事業的履約單與最小收件資料（EC-SPEC-05 §4.4） |
| 綠界 | 沒有身分；以該帳戶金鑰的簽章證明（EC-SPEC-04 §5.2、EC-SPEC-05 §6.1、EC-SPEC-06 §3.8） | 只寫入事件，不讀任何資料 |
| 排程 | 沒有 principal；cron 觸發（EC-SPEC-10 §5） | 依到期工作（§2.4） |
| Agent、MCP | C2 沒有任何 commerce 憑證（§2.8） | 無 |
| 平台管理員 | 既有 admin 身分 | 本案不新增讀顧客個資的管理頁 |

### 2.2 能力（`storefront@1.1.0`）

| 能力 | 可授予 viewer | 範圍 | 頁面 |
| --- | --- | --- | --- |
| `store:read`（既有） | 是 | 進入這間店的後台；營運概覽與報表（數字依其他能力裁切） | E02、報表 |
| `store:write`（既有） | 否 | 商品、變體、照片、分類、外觀、政策、優惠、商品配送屬性 | E03、E04、E08 |
| `store:publish`（既有） | 否 | 發布、停止公開 | E03 |
| `store:manage`（既有） | 否 | 商店設定、開放與關閉結帳、寄件地、出貨設定、代出貨同意 | E11 |
| `store:orders:read` | 是 | 訂單清單與詳情、各軸線狀態與時間線；顧客只顯示遮罩後的名稱，不含 Email、電話、地址與發票資料 | E05 |
| `store:customers:read` | 是 | 顧客清單；訂單的聯絡、收件與發票資料；訂單對話 | E07、E05 的聯絡卡 |
| `store:finance:read` | 是 | 付款 attempt、退款、對帳差異、發票、供貨帳；provider 帳戶的狀態（從不含金鑰） | E09、E10 |
| `store:orders:manage` | 否 | 取消、售後申請的開啟與決定、對話回覆、付款例外的處理 | E05、E07 |
| `store:fulfil` | 否 | 以出貨者身分操作履約單與包裹：接受、回報無法履約、讀收件資料、建單、列印、交寄、作廢、收退回與檢驗 | E06、SL-02～04 |
| `store:refund` | 否 | 建立與核准退款、送出 API 退款、登錄人工退款 | E09 |
| `store:invoices` | 否 | 發票設定、重試開立、登錄站外開立的號碼、更正 | E10 |
| `store:settlements` | 否 | 供貨帳：核對、異議、登錄付款（付款方）；開立對帳單、確認收款、提出調整（收款方） | E09、SL-05 |

規則：

- 名稱用 `:` 分段。viewer 只能拿 `:read` 結尾的鍵（`instance-grants.ts:31`），先前提議的 `store:orders.read`、`store:customers.read` 會讓 viewer 拿不到；`store:payments` 拆成唯讀的 `store:finance:read`，寫入由 `store:refund`、`store:invoices`、`store:settlements` 與下一點的 owner／admin 分擔。pages.md、EC-SPEC-01 §7.5、EC-SPEC-05 §9、EC-SPEC-06 §2、§8 已改用本表名稱。
- 收款、物流、發票帳戶與金鑰的寫入（新增、換金鑰、換特店、啟用、停用、退役）只有 owner 或 admin 能做，並要重新輸入密碼（§2.5 的新用途）。改收款帳戶等於改錢的去向，所以不放進可授予的能力；讀取帳戶狀態用 `store:finance:read` 或 `store:manage`。
- 店的資料匯出只有 owner，並要重新輸入密碼（EC-SPEC-08 §4.1）。
- 每個授權列都要含模組的基本讀取鍵（前綴加 `:read`，這裡是 `store:read`）。現在的規則只要求「至少一個 `:read` 鍵」；1.1.0 有四個 `:read` 鍵，只給 `store:orders:read` 會通過驗證，但 `requireStoreInstance` 要求 `store:read`（`capabilities.ts:27`），結果整間店 404。`validateInstanceGrants` 改成檢查基本讀取鍵；`TenantSettings.tsx` 勾任何 store 能力時自動勾 `store:read`。
- `store:orders:read` 看到的遮罩名稱：聯絡名稱去掉前後空白後的第一個字（Unicode code point）加「○○」，例如「王○○」、「J○○」；長度固定，不透露名字長度。聯絡資料已遮罩時顯示「已移除」。
- 能力之間不互相隱含。需要看聯絡資料才能完成的動作（例如回覆對話）同時檢查 `store:orders:manage` 與 `store:customers:read`。畫面依能力隱藏，伺服器逐一檢查。
- 「立即查詢」付款、物流或發票結果，有該軸線讀取權的人都能按（`store:orders:read`、`store:finance:read` 或 `store:fulfil`），受 §4 的限流。
- 供應商在零售商的實例沒有任何能力。出貨者的動作以出貨者自己店的 `store:fulfil` 檢查，並核對自己是這筆履約單的出貨者（EC-SPEC-05 §4.1、EC-SPEC-06 §2.7）。
- owner／admin 的能力改從實例登錄的版本讀（`module_definitions.capabilities`），不再用程式常數 `STORE_CAPABILITIES`（`capabilities.ts:7`、`:12`、`:16`）。這樣 1.0.0 與 1.1.0 的實例各自正確；hosted 程式已有兩處這樣讀（`hosted/seller-orders.ts:34`、`hosted/shared-authority.ts:53`）。

### 2.3 新的模組版本與升級

`storefront@1.0.0` 的能力清單與實例的版本都不可改（§1），所以要做以下幾件事。這是 SP-04 升級 API 的最小子集：同一個模組、能力只增不減、owner 觸發；資料 schema 與設定的遷移不在範圍。

1. M2 的 migration 登錄 `storefront@1.1.0`（§2.2 的 12 個鍵）與 `hosted-store@1.1.0`（`skill_book_refs` 見 EC-SPEC-07 §3）。1.0.0 的列不動。1.1.0 沿用 1.0.0 的 `data_schema_version`：commerce 的新表都是加法，不改 1.0.0 會讀的欄位，所以升級只動兩個 release 欄位。
2. 同一個 migration 新增不可改的 `module_release_upgrades`（提議）：`module_key`、`from_release_ref`、`to_release_ref`、`from_application_release_ref`、`to_application_release_ref`。insert 時 trigger 檢查新版本的能力是舊版本的超集，不是就拒絕。只登錄 `storefront@1.0.0 → 1.1.0` 一列。
3. 以 `CREATE OR REPLACE` 放寬 `preserve_module_instance_identity()`（`131:39-50`）：其他身分欄位照舊不可改；`module_release_ref` 與 `application_release_ref` 只能一起、依 `module_release_upgrades` 的一列前進。不能降級。
4. 命令 `POST /api/v1/tenants/:t/storefronts/:i/upgrade`（提議）：只有 owner；要 `If-Match`（實例版本）與 `Idempotency-Key`。交易內鎖事業列，檢查事業與實例都是 `active`、升級列存在，然後改實例的版本、`bumpAuthorizationRevision`、寫稽核與一筆控制事件（`commerce_control_events`，EC-SPEC-10 §8.2）。既有授權列不變（舊鍵在新版本仍然存在）。讀取 `GET …/storefronts/:i/release`（`store:read`）回目前版本、呼叫者的有效能力、登錄的升級目標與 `can_upgrade`，給第 6 點的升級提示用。
5. M2 之後新建的商店直接用 `hosted-store@1.1.0`：`HOSTED_STORE_RELEASE`、`STOREFRONT_MODULE_RELEASE`（`definitions.ts:73-74`）改成新版本，`packages/testing/seed.ts:51-54` 一起改。
6. 開放結帳的條件（EC-SPEC-02 §2.3）加一項：實例是 1.1.0。1.0.0 的店在 E01／E02 顯示「升級商店以啟用訂單與收款」，只有 owner 看得到按鈕。
7. 舊 binary 讀到 1.1.0 的實例只會少掉新能力（常數過濾後只剩四個鍵），不會出錯。不能回退的原因是 callback 路由（EC-SPEC-10 §7），不是這次升級。

### 2.4 機器路徑與交易身分

guest、provider 通知與排程都沒有 principal。規則：

1. 個資表一律 tenant RLS（`tenant_id = freedom_ctx_tenant()`，比照 `134:22-25`）：顧客、聯絡資料、出貨者的收件投影、選店 session、訂單對話、發票的買家資料。`168` 的 `commerce_customers` 與 `commerce_checkout_contacts` 已是如此。
2. 不含個資的交易與帳本表可以豁免 RLS，catalog 記 `reason_code: commerce_profile_participant_acl` 與理由（`168` 的 checkout、訂單 sidecar、付款套用、配置與異動，以及 `169` 的退款紀錄 `commerce_refunds`、`commerce_refund_lines` 與信件佇列 `commerce_outbound_emails` 都這樣登錄）。授權由程式依儲存的關聯判斷；豁免不代表有任何 HTTP 讀取者。
3. 沒有 principal 的路徑，先從**已儲存、不含個資**的列解析出 tenant 與實例，再 `bindTenantContext`，然後才碰個資表。tenant 永遠不從請求內容取得（EC-SPEC-04 §9）。
4. 解析用的兩張表（M2，`169` 已建立）：
   - `commerce_entry_routes`：`(route_kind, route_key) → tenant_id, instance_id, target_id, expires_at, revoked_at`。`route_kind` 是 `provider_account`（`account_ref`，出現在 callback 網址，不是秘密）、`payment_handoff`、`cvs_map`、`cvs_map_return`、`label_print`；後四種只存 token 的 SHA-256。豁免 RLS、不含個資；只寫一次，撤銷與到期只能前進。`account_ref` 是 26 個小寫 Crockford Base32 字元（128 bits 隨機）；組成 §2.6 的四條 `account_ref` 路徑後，任一條含綠界 CDN 擋字（`findCdnBlockedTerm`，例如結尾 `cd` 會組成 `cd/`）就重抽，最多 16 次。以店的 slug 進來的公開路徑不需要這張表（`readPublicStorePage` 的解析方式）。
   - `commerce_due_work`：`(tenant_id, instance_id, kind, target_id, due_at, lease_until, attempts, last_error)`，每個 `(kind, target_id)` 只有一列。`169` 的種類是 `payment_query` 與 `payment_window_end`，下單建立 attempt 時一起建立；執行器由 wp04-queries 加入。寄信加入 `email`（EC-SPEC-10 §6.3）。排程以一個跨 tenant 的查詢取出到期列（`FOR UPDATE SKIP LOCKED`、每次有上限），每一列在自己的交易裡 `bindTenantContext` 後處理。不逐一掃描每個 tenant scope（`operations.ts:529` 的做法在店數變多時，10 分鐘一次的 cron 跑不完）。豁免 RLS、不含個資。
5. 同一時間只綁一個 tenant。需要另一方的資料時，照 shared 訂單的做法先 `clearTenantContext` 再明確綁定下一方（`hosted/shared-authority.ts:13-17`），不靠 `bindTenantContext` 直接切換。個資只在綁定該 tenant 時讀寫，讀到的個資不帶進下一方的綁定。效果跨兩個事業時（例如供應商帳戶收到的貨態要更新零售商的訂單軸線），跨過去的部分只能寫不含個資的豁免表，或排一筆到期工作由另一個交易處理。
6. 不用 `SECURITY DEFINER`（部署工具拒絕未審查的 definer，`deploy/cloudflare/lib/migrations.mjs:7-23`）。
7. 機器路徑寫的事件標明來源（`provider` 或 `scheduler`）與帳戶，不冒用任何會員 principal。`scoped_command_receipts` 只收 `person`（`migrations/078_scoped_member_commands.sql:4`），所以機器路徑用各領域的事件表去重（EC-SPEC-04 §5.4）。

### 2.5 決策點的重查（EC-R44、R45）

| 決策點 | 重查什麼 | 失敗時 |
| --- | --- | --- |
| 會員命令提交 | `scopedTenantCommand` 的 session 時鐘、`authorization_revision`、成員版本與角色，加上 `storeCommand` 的能力 revalidate（都在鎖住 receipt 之後） | 403 或 409，沒有副作用 |
| 延遲讀取（收件資料、聯絡卡、對話） | 每次讀取時重查能力、出貨者身分、`access_until` 與遮罩狀態，不用快取 | 403，例如「收件資料已到期」 |
| 一次性 token（付款交接、選店、列印） | 兌換時檢查未用、未到期；列印 token 綁建立它的 session，兌換時 session 仍有效、仍有 `store:fulfil`、仍是出貨者（SC-LAT13） | 失效頁，不送出表單 |
| provider operation 取得租約、對外呼叫前 | 事業與實例 `active`、服務 `active`（查詢除外）、環境相符、寫入者世代（C3，EC-SPEC-08 §5.2），以及操作自己的前提（例如建單要求付款 `confirmed`、履約單未取消、退款累計上限） | 不呼叫；操作停在 `blocked` 並開例外 |
| guest grant | 每次讀寫都檢查 grant 未撤銷、未到期、訂單屬於網址上的店 | 不揭露的 404 |
| 匯出授權 | 使用時檢查建立者仍是 owner | 403 |

規則：

- 決策點是**建立操作的那個命令**。成員核准退款或建立物流單的命令提交後，這個操作是店的義務，該成員之後被撤權不會取消它（「已合法提交可恢復」，EC-AT50）。但店本身被停用、服務被停用、寫入者移走時，新的對外呼叫一律停止；查詢不受服務停用影響（在途責任，EC-R56）。
- 撤權、角色變更、移除成員、owner 轉移本來就呼叫 `bumpAuthorizationRevision`；commerce 新增的權限異動（升級實例、provider 帳戶寫入）也要呼叫。
- 列印 token 與重新確認身分都綁 session：登出或 session 被撤銷就失效。
- 重新確認身分的新用途：`commerce.provider_account.write`、`commerce.store_export.create`。M2 的 migration 放寬 `124:12` 的 CHECK，契約 `HighRiskPurposeSchema` 加值；有效期與一次性規則沿用 `requireFreshVerification`／`consumeFreshVerification`。
- 切換登入或事業（EC-AT49、AT51）：
  - 伺服器：receipt 依 principal 與 scope 分開，同一個 `Idempotency-Key` 在另一個 session 下取不回前一人的結果；寫入都要 `If-Match`。
  - 前端：草稿與未完成的命令以（principal、tenant、instance）為鍵保存。回應到達時，若目前的身分或事業已經不同，丟棄回應、不顯示、不寫進目前的畫面；回到原身分時，用原本的 key 與內容查回結果（EC-SPEC-01 §6.1 的「寫入回應遺失」）。

### 2.6 請求閘道的例外

綠界的瀏覽器返回（付款的 `OrderResultURL`、電子地圖的 `ServerReplyURL`）是買家瀏覽器從綠界頁面送出的跨站表單 POST：帶綠界的 Origin（或 `null`）、`application/x-www-form-urlencoded`。現在的閘道會在進到路由前回 403 `origin_rejected` 或 415 `json_required`（`platform-app.ts:235`、`:270`）。伺服器之間的通知是否帶 Origin 沒有保證。所以只對下表的確切路徑開例外：

| 方法與路徑 | 呼叫者 | 規格 |
| --- | --- | --- |
| `POST /api/v1/provider-callbacks/ecpay/{account_ref}/payment` | 綠界伺服器 | EC-SPEC-04 §5.1 |
| `POST /api/v1/provider-callbacks/ecpay/{account_ref}/logistics` | 綠界伺服器 | EC-SPEC-05 §6.1 |
| `POST /api/v1/provider-callbacks/ecpay/{account_ref}/invoice-allowance` | 綠界伺服器 | EC-SPEC-06 §3.8 |
| `POST /pay/ecpay/return/{account_ref}` | 買家瀏覽器（綠界付款頁送出） | EC-SPEC-04 §4.2 |
| `POST /ship/ecpay/map-return/{session_ref}` | 買家瀏覽器（綠界電子地圖送出） | EC-SPEC-05 §3.6 |

規則：

- 一個判斷函式（`isCommerceProviderEntry(method, path)`，`modules/agent-commerce/operations/provider-entry-paths.ts`）只認上表的方法與路徑格式（ref 的字元與長度固定），比照 `isMaintainerWebhookPath`。M2 只認付款通知與付款的瀏覽器返回兩條；其他三條隨 M3、M4 的路由加入。閘道對它跳過 Origin 與 JSON 檢查，改由路由自己檢查 `Content-Type`、以串流計算 16 KiB 上限、拒絕重複的參數名、限制參數名字元（EC-SPEC-04 §5.1）。Host 檢查（`host_rejected`）照舊。
- 不檢查 Origin 的理由：這些端點不讀也不設定任何 cookie、不依 session 做事，回應只有下列固定內容，沒有可被跨站借用的身分。測試證明：帶有效的會員 session 與買家憑證、帶外站 Origin、不帶 Origin，結果都相同。
  - 伺服器通知：`1|OK`（200）、`0|invalid`（400）、`0|limited`（429，帶 `Retry-After`）、`0|unavailable`（503，金鑰環不可用）、`0|error`（500），找不到帳戶是空的 404。
  - 瀏覽器返回：303 到固定的站內路徑，或不含任何訂單資料的錯誤頁（金鑰環不可用 503、其他錯誤 500）；不回機器文字。找到 attempt 之後，記錄失敗也照樣 303 到付款返回頁。
- 其他新路徑都不加例外：B04～B10 的公開命令是同站 JSON（EC-SPEC-02 §5.1）；付款交接、選店與列印頁都是 GET。
- 會員 session 是 `SameSite=Strict`：從綠界回來的導轉（303 之後的第一個 GET）不帶它，`SameSite=Lax` 的買家憑證則會帶。所以付款返回頁與訂單頁的 HTML 不依身分產生，狀態一律由頁面內的同站 fetch 讀取（這時兩種 cookie 都會帶）。
- staging 的 Access 要排除上表五條路徑：綠界伺服器沒有 Access 身分，買家瀏覽器從綠界頁面送出的跨站 POST 也不一定帶得到 Access 的 cookie。設定由 Ted 操作（EC-SPEC-10 §4.4）。

### 2.7 公開與私人的界線（EC-R42）

- 公開讀取只走發布版本的允許欄位（`catalog.ts` 的 `field_allowlist`）。新的店面內容（封面、分類、政策、賣方揭露）先加進白名單再公開；草稿與預覽只在私有路由（EC-AT06）。
- 公開命令（報價、checkout、下單、選店、發票輔助查詢、找回訂單）只接受店的 slug，不接受 tenant、實例或帳戶 ID；伺服器解析出店之後才綁 tenant（§2.4）。
- 結帳的公開配送投影只含 `destination_state`，各群組只含 `group_ref`、`method`、`amount_minor`、`fee_per_parcel_minor`、`outlying_surcharge_per_parcel_minor`、`parcel_count`、`handling_days`、SKU 與數量的 `items`、`meetup_note`。供應商／商店 ID、代出貨同意、設定與屬性版本、寄件地、物流服務參照只留在伺服器的凍結 terms。公開 `offline_payment` 只含設定版本與期限；銀行帳號只依 EC-SPEC-11 §6.2 的訂單存取條件顯示。
- 快取：公開 JSON 60 秒；報價、checkout、訂單、付款狀態與 provider 入口都是 `no-store`。
- 公開店面維持 `noindex`。訂單、付款交接與返回、選店、列印頁另外回 `Referrer-Policy: no-referrer`，網址裡的 ref 不會經由 Referer 流到外站。
- 匿名可以加購物車、走到結帳；E 頁與所有私有 API 照舊拒絕（EC-AT04）。

### 2.8 Agent 與 MCP（EC-R43）

- C2 不發任何 hosted commerce 的委派憑證（EC-SPEC-07 §6.2）。私有路由只接受會員 session＋CSRF；既有的非 session 憑證（`fw_read_` 客戶端配對 token、Agent 上傳 token、`/shop-api/v1/` 金鑰、模型 broker 憑證）呼叫任何 commerce 私有路由都回 401 或 403，沒有副作用。
- decisions.md「Agent 委派的界線」的禁止清單是日後任何委派的下限，不是 C2 的功能：讀收件或聯絡資料、開列印、建立或作廢託運單、核准或送出退款、取消已付款的訂單或行項、作廢發票或開折讓、修改寄件地、出貨設定、provider 帳戶、代出貨同意與政策。
- C4 若要開放委派，設計要另外經 Ted 同意，至少包含：綁一間店、一組能力、一段期限、可撤銷；principal 種類與會員分開，receipt 同時記下委派者與 Agent；走同樣的領域命令；禁止清單由伺服器依路由與操作名稱強制，任何委派範圍都打不開；平台不把商家的 provider 金鑰交給 Agent。
- commerce 的伺服器程式不 import 模型 client；C2 的端到端旅程在沒有模型金鑰的環境跑完（§5.4）。

## 3. 保存、遮罩與匯出（DC12、OPEN-07）

下表是 DC12 的建議預設，等 Ted 確認。法定的保存期間由商家（必要時專業人士）確認；C2 只用平台預設值，商家自訂期限在 C4。

| 資料 | 位置 | 預設 | 到期時 |
| --- | --- | --- | --- |
| 沒有成立訂單的結帳聯絡資料 | `commerce_checkout_contacts`（沒有訂單指向的列） | checkout 到期後 30 天 | 遮罩 |
| 訂單的聯絡、收件與發票買家資料 | `commerce_checkout_contacts` | 訂單各軸線都結束、售後期限也屆滿後 180 天 | 遮罩：五個個資欄位一起清空（`168` 的規則）；畫面改顯示「收件資料已依保存期限移除」 |
| 出貨者的收件投影 | `commerce_fulfilment_recipients` | `access_until`：送達或退回後加同意的天數（預設 14、上限 30） | 遮罩，拒絕新讀取（EC-SPEC-05 §4.4） |
| 選店 session 的門市暫存 | 選店 session | 到期後 1 天 | 刪除 |
| 訂單對話 | `commerce_support_messages` | 同訂單的聯絡資料 | 內文改成「（已依保存期限移除）」，保留作者種類與時間 |
| 發票的買家識別 | 發票文件 | 同訂單的聯絡資料 | 載具號碼遮罩；統編、捐贈碼、發票號碼與金額保留（帳務資料，不是個人資料） |
| 顧客記錄 | `commerce_customers` | 這位顧客所有訂單的聯絡資料都遮罩之後 | Email 換成 `redacted:<customer_id>`、清掉 `email_verified_at`、填 `redacted_at`（`168` 只允許這一次改動）；會員連結保留。同一個 Email 之後再下單會建立新的顧客記錄 |
| 訂單、行項、terms、付款、退款、履約、包裹、發票號碼與金額、供貨帳、provider 事件 | 各領域表 | 隨商店保留（交易與帳務紀錄，不含個資） | 不刪；商店遷出時依 EC-SPEC-08 §5.6 |
| 卡號片段、授權碼、通知與查詢回應裡的收件人與寄件人欄位、標籤檔 | 不保存 | — | — |
| 收件資料讀取與列印的紀錄（誰、哪一筆、用途，不含內容） | receipt | 1 年 | 刪除 |
| 買家瀏覽器憑證 | `commerce_access_devices` | 最後使用後 180 天 | 刪除，grant 一起失效 |
| 訂單存取 grant 與信件連結 | `commerce_order_access_grants` | 到期或撤銷後 45 天（比 30 天的備份長，OPEN-07） | 刪除 |
| 寄信佇列（只有參照與狀態，不含 Email） | `commerce_outbound_emails` | 結束（`sent`、`suppressed`、`expired`、`failed`）後 45 天 | 刪除 |
| 店的匯出檔 | 物件儲存 | 下載入口 7 天（OPEN-07） | 刪除檔案（EC-SPEC-08 §4.3） |
| 限流 bucket | `auth_rate_limits` | 既有：視窗過期後清除 | — |
| 備份 | 平台備份 | 30 天（OPEN-07） | 不改寫備份；還原後先重跑遮罩（下面） |

規則：

- 遮罩由到期工作（§2.4）執行，可以重跑，結果相同。遮罩後 `contact_sha256` 與 terms 裡的摘要保留，但無法再拿內容重算，這是預期的。
- 留下的摘要不能被拿來比對猜測的個資：聯絡資料的摘要含一個隨機 salt，salt 存在聯絡資料列、隨遮罩清除；建立 checkout 的請求摘要以冪等鍵為金鑰（HMAC-SHA256），明文的鍵不保存。
- 在途的訂單不遮罩（DC12）：有 `open` 例外、未結的退款、`unknown` 的退款或發票、未結的對帳單或售後時，延到這些結束。
- 衍生副本（搜尋、快取、報表彙總）本來就不放個資；萬一有，依 OPEN-07 先隱藏、7 天內清除。
- 還原：備份可能含有遮罩前的個資。還原後、重新開放前，先跑遮罩工作並重新套用還原點之後的撤銷（T-047，EC-SPEC-10 §8.4）。
- 匯出（EC-SPEC-08 §4）：下載入口 7 天；每次下載重新確認是 owner，再發一個 15 分鐘的網址；7 天後刪檔。
- catalog：commerce 資料集在 DC12 確認前維持 `policy_undecided`，`decision_refs` 加上 `DC12`；確認後改成指向本表的有界狀態。
- 日誌、journal、outbox、分析與模型都不含 Email、電話、地址、門市、載具、統編、對話內文與卡號片段（EC-AT48）。CSV 匯出同樣不含（EC-SPEC-06 §6），並防公式注入（EC-SPEC-07 §9）。

## 4. 限流

沿用 `authRateLimitInTransaction` 的固定視窗與雜湊 bucket。每次嘗試都計數，包括失敗、被拒與重播：bucket 在命令之前用自己的短交易計數並提交，命令交易不持有 bucket 的列鎖，也不在交易中再借第二條連線。這樣重播和猜測都有上限，猜錯的請求同樣受限。provider 通知在驗證簽章之前就計數，所以鍵不能只用帳戶：`account_ref` 是公開的（每張付款交接表單的 `ReturnURL` 都帶著它），只以帳戶為鍵時，任何人都能用未簽章的請求耗盡額度，讓綠界的真通知與重送都收到 429。驗證前的帳戶額度因此以（帳戶, 網路）為鍵（decisions.md）。店的 bucket 以 slug 解析出的店為鍵；找不到店時只計網路。唯一的例外是「同時未付款的有效訂單」的網路近似：它只在命令交易裡對新建的訂單計數，命令失敗時一起回滾。commerce 用的版本回傳剩餘秒數，429 帶 `Retry-After`。網路鍵用 `rateLimitNetwork`；本機與不可信的 edge 會全部落在 `shared-server`，所以限流測試要用可信 edge 的設定。數值集中在一份常數表（§8），測試讀同一份表；調整數值不改規格，記在 PR。

買家（公開路由）：

| 操作 | 鍵與上限 | 超過時 |
| --- | --- | --- |
| 購物車報價 | 網路 60／分；店 600／分 | 429 |
| 建立 checkout | 網路 30／10 分；店 600／10 分 | 429 |
| 下單 | 網路 10／10 分；店 300／10 分 | 429 |
| 同時未付款的有效訂單 | 同一家店內，瀏覽器憑證、Email 各 3 張；網路以 bucket 近似：每 30 分新建 3 張（EC-SPEC-02 §5.5） | 429 `too_many_open_orders`（帶 `Retry-After`），不留下保留 |
| 單一 SKU 每單數量 | 店可設，≤ 99 | 422 |
| 找回訂單（B10） | 網路 10／時；Email 3／時；全域 300／時 | 一律 202（EC-SPEC-02 §4.2） |
| 兌換信件連結 | 網路 30／10 分 | 429 |
| 建立選店 session | checkout 10／10 分；網路 30／10 分 | 429 |
| 發票輔助查詢 | checkout 10／分；店 30／分 | 只做格式檢查，回 `check_unavailable`，不擋結帳 |
| 重新付款 | 距上一個 attempt ≥ 60 秒；每張訂單最多 5 個（EC-SPEC-04 §4.3） | 409 |
| 查詢付款結果 | 訂單 1／分、10／時（買家與賣家合計） | 429，畫面顯示下次可查的時間 |
| 訂單對話 | 訂單 20／時；網路 60／時 | 429 |
| 售後申請 | 訂單 5／日 | 429 |
| 重選門市、更正地址 | 包裹 5／時 | 429 |

provider 入口：

| 操作 | 鍵與上限 | 超過時 |
| --- | --- | --- |
| 付款、物流、折讓通知 | （帳戶, 網路）600／分，驗證前計數；body 16 KiB | 429 `0\|limited`（綠界會重送） |
| 找不到 `account_ref` | 網路 120／分 | 429 |
| 付款的瀏覽器返回 | 網路 60／分；同 attempt 的查詢 1／分；每個 attempt 只記一筆返回（EC-SPEC-04 §4.2） | 只 303，不排查詢 |
| 地圖返回 | 每個 session 一次 | 303 回原頁，不改暫存 |

賣家與出貨者：

| 操作 | 鍵與上限 | 超過時 |
| --- | --- | --- |
| 立即查詢（付款、物流、發票） | 每筆 1／分。付款查詢與買家共用訂單的 1／分、10／時，不另設 principal 或網路額度；授權通過後才計數，別人無法耗盡訂單的額度 | 429（帶 `Retry-After`） |
| 讀收件資料（SL-02）與聯絡卡（E05） | principal 300／時，兩者合計；在能力檢查之前計數，被拒的讀取也算 | 429，畫面顯示「讀取次數過多，請稍後再試」 |
| 開列印 session | 包裹 10／時 | 429 |
| provider 帳戶的驗證付款（EC-SPEC-04 §1.4） | 帳戶 10／時，包括收據重播。授權（店、owner／admin、帳戶屬於這間店）通過後才計數：別人無法耗盡額度，也無法從 429 與 404 的差別得知帳戶存在。帳戶的其他寫入每次都要重新輸入密碼（EC-SPEC-04 §1.4；密碼錯 10 次停 15 分），不另設額度 | 429（帶 `Retry-After`） |
| 匯出 | 店同時 1 份、每日 3 份 | 409 或 429 |

我們呼叫綠界時：

- 綠界回 HTTP 403 → 同帳戶、同用途（付款、物流或發票）的服務列 `throttled_until = now + 30 分`，這些服務的查詢與操作延後；其他用途不受影響（EC-SPEC-04 §1.2、§6.3）。
- 發票輔助查詢是買家觸發的，所以另有每店上限；綠界對輔助查詢回 403 時，這間店的輔助查詢立即停 30 分鐘（只做格式檢查），發票服務的 `throttled_until` 也照上一點設定，因為綠界可能是整個特店被擋。這樣買家無法靠大量查詢讓商家的發票開立長時間停擺。
- 逾時與網路錯誤依各領域的退避（EC-SPEC-04 §6.3、EC-SPEC-05 §5.3、EC-SPEC-06 §3.6）。

## 5. 反例與測試層級

### 5.1 證據層級（計畫 §19.1）

| 層級 | 驗收裡的用語 | 本案的跑法 | 不能代替 |
| --- | --- | --- | --- |
| 契約與向量 | `adapter_contract` | `node:test` 的純函式測試＋workerd 跑同一組官方向量；不連線 | 真實 provider |
| 隔離 DB／HTTP | `db_http`、`domain_and_journey` 的 API 部分 | `tests/runtime/*.test.ts`：自己的 `fp_` 資料庫、DB 時鐘與 barrier；provider 用本機假伺服器 | 實際部署、真實 callback |
| 瀏覽器 | `browser_db`、`visual_browser` | `npm run build` 之後 `npm run test:e2e`（Playwright、`fp_e2e_` schema）；視覺的五個寬度與鍵盤依 EC-SPEC-01 §9 | 真人使用 |
| 安全檢查 | `security_review` | canary 掃描（§5.3）＋人工審查紀錄 | 滲透測試 |
| CI 審查 | `ci_review` | selector 測試與同一候選的證據（§6） | hosted CI 的實際設定 |
| 來源審查 | `source_review` | 文件與原始碼審查紀錄 | 執行結果 |
| 還原演練 | `restore_lab` | 隔離環境還原後對帳（EC-SPEC-10 §8.6） | 正式環境的還原 |
| provider sandbox | 各領域的「外部驗證的分層」 | 綠界 stage，需要 Ted 授權 | 正式收款與寄件 |
| 受控正式 | `operational_review` | Ted＋商家（EC-SPEC-10 §9.1） | 全面上線 |
| clean room | `clean_room` | C3（EC-SPEC-08） | — |

沒有執行的驗收一律 `not_run`；缺第三方條件的標 `blocked` 並寫影響；本機假 provider 的結果不寫成 provider 驗證（計畫 §19.1）。

### 5.2 代表反例（計畫 §19.2）

各領域已定義的反例：

| 情境 | 定義在 | 驗收 |
| --- | --- | --- |
| 付款通知重送、兩筆相同通知並行 | EC-SPEC-04 §12 | AT17、21 |
| 簽章錯、商家錯、金額錯、環境錯、未知交易號 | EC-SPEC-04 §12、EC-SPEC-05 §12、EC-SPEC-06 §11 | AT15、16 |
| 模擬付款 | EC-SPEC-04 §12 | AT19 |
| 付款晚到、付款與保留到期競態、已付款不被到期釋放 | EC-SPEC-03 §9 | AT27、30、31 |
| 10 件庫存、6＋5 並行；已付款占用；部分出貨；退回不自動回庫 | EC-SPEC-03 §9、EC-SPEC-05 §12 | AT28、29、42 |
| 部分退款、並行退款、退款結果不明 | EC-SPEC-04 §12、EC-SPEC-06 §11 | AT22、23 |
| 分包部分出貨 | EC-SPEC-05 §12 | AT34 |
| 建單成功但回應遺失 | EC-SPEC-05 §12 | AT37 |
| 物流亂序、門市失效 | EC-SPEC-05 §12 | AT36、40 |
| 發票開立結果不明 | EC-SPEC-06 §11 | AT46 |
| 服務未開通、B2C 未測標、未完成驗證交易 | EC-SPEC-05 §12、EC-SPEC-10 §4.5 | AT68 |
| 搬遷中的有效保留與付款通知 | EC-SPEC-08 §8 | AT59、60（C3） |
| 還原後發現已收款、已寄出 | EC-SPEC-10 §8.4 | AT63 |

本文件新增的跨領域反例：

| 案例 | 要證明 | 驗收 |
| --- | --- | --- |
| 撤權跨等待：成員 A 的退款核准在鎖上等待時，owner 撤銷 A 的 `store:refund` | A 的命令 403，沒有退款列、沒有 operation；撤權前已提交的退款照常送出 | AT50 |
| 同上，對象換成讀收件資料、兌換列印 token、建立物流單 | 撤權後的讀取與兌換被拒；已建立的物流單照常查詢 | AT50、SC-LAT13 |
| owner 轉移跨等待：舊 owner 的 provider 帳戶寫入在等待中，轉移完成 | 寫入被拒 | AT50 |
| 切換登入：A 送出商品草稿、回應延遲；登出後以 B 登入 | 畫面不顯示 A 的資料；不會用 B 的 session 重送 A 的命令；A 的結果之後能用原 key 查回 | AT49、51 |
| 切換事業：同一人兩間店，在 A 店送出後切到 B 店 | 同上；receipt 依 scope 分開 | AT49 |
| 兩間店的收款隔離 | 用 B 的 `account_ref` 送 A 的交易、A 的金鑰簽 B 的通知、B 的成員讀 A 的帳戶狀態都被拒；A 的封存金鑰解不開 B 的 | AT13 |
| 金鑰輪替 | 新舊 `credential_version` 與兩把 Worker key 並存期間都能驗證；用途或環境不對就解不開 | AT14 |
| 能力矩陣 | 每條 commerce 私有路由 × 每種角色與能力組合（含 viewer、供應商成員、別店 owner）：沒有權限時 403 或 404、沒有副作用、沒有 receipt | AT03、33 |
| viewer 與基本讀取鍵 | viewer 只拿得到 §2.2 標「是」的鍵；缺 `store:read` 的授權列被拒 | AT03 |
| 升級 | 1.0.0 的實例升級後既有授權不變、新鍵可以授予；非 owner、降級、未登錄的升級都被拒；升級後 v1 預留照常 | EC-R06 |
| 機器路徑 | 用另一間店的 `account_ref`、在 body 放 tenant ID、偽造 Origin、附會員 session：結果只依簽章與帳戶決定 | AT13、16 |
| 閘道例外 | 只有 §2.6 的確切路徑能免 JSON 與 Origin；多一段路徑、改用 PUT、改大小寫，都回原本的 403 或 415 | EC-R06 |
| 公開界線 | 未登入、未入會能加購物車並走到結帳；E 頁與私有 API 仍拒絕；草稿與預覽不外流 | AT04、06 |
| guest 回查 | 本人讀得到；猜 `order_ref`、換店、用撤銷的憑證都讀不到；不建立會員 | AT05 |
| 收件資料最小揭露 | A、B 兩個供應商：A 只讀到自己那包；期限過後被拒；不帶出其他包 | AT11、43 |
| 標籤 | 重印同一單號；無權者、撤權後、期限後被拒；沒有公開網址 | AT38、39 |
| 限流 | §4 的每一列：上限內成功、上限加一被拒且沒有副作用、視窗過後恢復；一人多 Email、一個 Email 多網路 | EC-R05 |
| 報表與分析不含個資 | 報表、CSV、日誌、outbox、journal 沒有 §3 列的個資；CSV 防公式注入 | AT24、48 |
| 保存與遮罩 | 到期的聯絡資料遮罩一次、重跑結果相同；在途訂單不遮罩；還原後先遮罩再開放 | EC-R41 |

### 5.3 秘密與卡號：canary 掃描（EC-AT25）

- 測試用的金鑰、商家檢查碼與卡號片段都是每次執行隨機產生的 canary 值。綠界公開的 stage 測試金鑰只出現在需要重算官方向量的 fixture。
- 跑完付款、物流、發票、退款的完整旅程（假 provider 在通知裡回傳 canary 的 `card6no`、`card4no` 與收件人欄位），再掃描：
  1. 每個 HTTP 回應的 body 與 header，包括錯誤回應；
  2. 資料庫所有 text、jsonb、bytea 欄位，`commerce_provider_credentials.sealed` 除外（那裡只能找到密文）；
  3. 測試期間捕捉的 stdout、stderr 與 `console.*`；
  4. journal、outbox、receipt 與事件表；
  5. `npm run build` 產生的 `dist/`（含 source map）；
  6. 匯出檔（C3 加入）。
- 任何一處出現 canary 的明文、Base64、URL 編碼或 hex 就失敗；報出位置，不印出值。
- 原始碼檢查：綠界 stage 金鑰的字串只能在 `tests/worker/ecpay-fixtures/` 與重算官方向量的協定測試（`tests/runtime/ecpay-*.test.ts`）之下，出現在 `docs/`、`modules/`、`apps/` 就失敗。
- 這是自動化的回歸檢查，不取代人工的安全審查；AT25 兩者都要。

### 5.4 沒有模型金鑰也能營業（EC-R43）

- E2E 啟動前清掉所有模型與 broker 相關的環境變數（清單放在測試裡，新增 provider 時一起加），C2 的旅程（J01～J09 的 sandbox 版本）照樣通過。
- 靜態檢查：`modules/agent-commerce/**` 不 import 任何模型 client 或 broker（EC-SPEC-07 §9）。
- 中央與 AI 都不可用時的營業是 C3（EC-AT56，EC-SPEC-08）。

## 6. CI 範圍與同一候選證據（EC-R59、EC-AT67）

- commerce 的 SQL、migration、契約、provider 協定、權限與 callback 路徑都不是 leaf，一律 full（`scripts/ci/affected-jobs.md`）。本案不申請 affected 的例外；只改店面樣式的檔案日後也許能當 leaf，那要另外的 selector 變更與審查。
- 新 descriptor（`hosted-checkout`、`commerce-providers`、`commerce-payments`、`commerce-fulfilment`、`commerce-invoices`、`commerce-aftersales`、`commerce-operations`）的 `tests` 用 `runtime.full`；`owned_paths` 的 64 條上限含 descriptor 自己（`e36e31bc`）。新增路徑後跑 unknown-paths 與 selectImpact 的 owner 檢查（WP-00 §4 第 10 項）。
- 同一候選：C2 的完成證據（runtime、E2E、向量、canary、視覺）都對同一個 commit 的 tree 產生。早先 commit 的結果保留原 SHA 與適用範圍，只有 tree 相同（`git rev-parse <sha>^{tree}`）時才能沿用。取消、未跑、skipped 都不算通過（計畫 §21）。
- 失敗要分類：產品錯誤、測試時序、CI 容量各自記錄；不用加重試或放寬 timeout 代替修正（計畫 §19.3、§21）。
- 每個 PR 的說明列出對應的 EC-R／EC-AT、實跑的命令與結果、`not_run` 的項目與原因。

## 7. 測試資料與環境

- 只用合成資料：「測試買家甲」這類名字、`@example.test` 的 Email、`0900000000`～`0900000099` 的手機、虛構地址。不用真實顧客、商家或員工的資料，也不從正式環境複製。
- 測試一律用本機的假 provider：重放官方格式，可以注入逾時、重送、亂序與錯誤簽章。不連綠界 stage 或正式環境；連 stage 要 Ted 另外授權（EC-SPEC-04 §11）。文件不寫任何金鑰值。
- 每個平行的工作用自己的一次性 PostgreSQL（`fp_` 開頭、只綁 127.0.0.1）與自己的 E2E 埠，不用共用的 54339；實際的埠分配在 [work-plan.md](work-plan.md)。工作結束就停止並移除容器（`docker rm -fv`）。
- 保存期限、確認窗與作業日都用 DB 時鐘注入，不用 sleep。
- 寄信只用 fixture sender（EC-SPEC-10 §6.4）。
- 改了前端先 `npm run build`，再跑瀏覽器測試，避免驗到舊畫面。

## 8. 程式位置

| 項目 | 位置（未註明已建的仍是提議） |
| --- | --- |
| `storefront@1.1.0`、`hosted-store@1.1.0`、`module_release_upgrades`、放寬的實例身分 trigger、重新確認身分的新用途 | 已建：`169`；`modules/module-registry/definitions.ts`；`contracts/guild-launchpad/v1/tenant.ts` |
| owner／admin 的能力改讀實例版本；升級命令 | 已建：`modules/agent-commerce/hosted/capabilities.ts`、`modules/agent-commerce/hosted/release-upgrade.ts`（`upgradeStoreRelease`） |
| 授權驗證的基本讀取鍵 | `modules/tenant-workspaces/instance-grants.ts`、`apps/portal-web/src/modules/TenantSettings.tsx` |
| provider 入口的判斷函式 | 已建：`modules/agent-commerce/operations/provider-entry-paths.ts`（`isCommerceProviderEntry`、`isCommerceProviderEntryPath`）；`platform-app.ts` 閘道加一個條件 |
| `commerce_entry_routes`、`commerce_due_work`、遮罩工作、限流常數表 | 已建：`169`；`modules/agent-commerce/payments/entry-routes.ts`、`modules/agent-commerce/operations/due-work.ts`、`modules/agent-commerce/checkout/limits.ts`。遮罩工作（`retention.ts`）尚未建立 |
| 跨領域測試 | 已建：`tests/runtime/commerce-rate-limits.test.ts`、`hosted-payment-canary.test.ts`（秘密 canary）、`hosted-payment-schema.test.ts`、`hosted-payment-handoff.test.ts`、`hosted-payment-notifications.test.ts`、`commerce-effect-journal.test.ts`。尚未建立：`commerce-capability-matrix.test.ts`、`commerce-entry-gate.test.ts`、`commerce-retention.test.ts`、`tests/e2e/commerce-no-model-keys.spec.ts` |

descriptor 的歸屬與工作順序在 [work-plan.md](work-plan.md)。

## 9. 測試（全部 not_run）

本文件的測試是 §5.2 的跨領域反例、§5.3 的 canary 掃描、§5.4 的無模型金鑰旅程，以及 §4 每一列限流的三個案例（上限內、上限加一、視窗過後）。各領域的反例在各自文件的測試一節。

## 10. 仍待決

| 項目 | 建議 | 只影響 |
| --- | --- | --- |
| DC12 保存期限 | §3 的預設：聯絡資料在各軸線結束且售後期限屆滿後 180 天遮罩；出貨者 14 天、上限 30 | 正式對外的隱私承諾與遮罩工作 |
| 能力的名稱與拆法 | §2.2 | 成員授權畫面；Ted 可以改 |
| 1.1.0 由 owner 手動升級 | 不自動升級既有商店 | 既有商店啟用訂單與收款的時間 |
| provider 帳戶只限 owner／admin，並重新輸入密碼 | 是 | 誰能設定收款、物流與發票帳戶 |
| 限流數值 | §4；以測試與 staging 的觀察校準 | 濫用防護與正常使用 |
| 收件資料讀取 300／時 | 是 | 出貨量很大的供應商 |
| Agent 委派（C4） | 禁止清單是下限；設計另經 Ted 同意 | Agent 能代做的事 |
| staging 排除五條入口路徑 | Ted 操作 Access | sandbox 的端到端驗證 |
