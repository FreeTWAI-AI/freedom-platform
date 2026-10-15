# WP-00 現況差異、可沿用的程式、缺口與來源權利

基準 `efaf314d`；2026-10-15 10:03Z 與 10:25Z 再讀 `origin/main`，都是 `5bee7376`。本文件只寫已在原始碼核對的事實，盤點方法與 Agent 盤點的更正見 [sources.md](sources.md) §5～§6。路徑相對 repo 根目錄，API 相對 `/api/v1`；`R` = `/tenants/:tenant_id/storefronts/:instance_id`。

需求：EC-R01、R02、R03、R40、R49 的 C0 部分。驗收：EC-AT01、AT02 的來源核對部分（仍是 `not_run`，正式核對在 WP-09 發布前）。

## 1. 最新差異

### 1.1 main

- `efaf314d..5bee7376`：27 個 commit、34 個檔案，由兩個整合 PR（#680、#707）合入。沒有改 `migrations/`、`modules/agent-commerce/`、hosted 路由、`contracts/guild-launchpad/`、`packages/db/` 與 `deploy/`；下一個 migration 編號仍是 168。
- 與本案共用、整合時要一起合併的檔案：`apps/platform-api/src/platform-app.ts`（1 行）、`scripts/ci/select-affected-jobs.test.mjs`、`.github/workflows/verify.yml`、`governance/README.md`、`contracts/preview/freedom.module.json`、`docs/platform-plan/execution/guild-launchpad/README.md`、inventory JSON。
- 治理規則（`e36e31bc`）：CI selector 會把 descriptor 自己的路徑算進 64 條上限。descriptor 不在自己已涵蓋的目錄時，`owned_paths` 最多 63 條；整個目錄都歸同一模組時用 `/**`。

### 1.2 部署與 schema

依 main 上的 `docs/platform-plan/execution/unified-foundation/current-state.json`（記錄於 2026-10-15 05:34Z）：

- staging 與 production 都跑安全發布 `938516ee`，schema 166。main 上的 `167_community_ar.sql` 還沒部署，所以 commerce 的 168 起要排在 167 之後（EC-SPEC-10 §4.1）。
- production 部署前的備份（`87ec37e7`）已完整還原驗證；部署後的備份還原還沒成功過。依 main `5bee7376` 的 closeout，共四次失敗：前三次在 capture 階段，第四次 `e021ebfc`（05:06 UTC 啟動）capture 與遠端讀回完成，05:24 UTC 在 restore 階段失敗；各次資源都已對帳清理。commerce 開放正式收款前，要先有成功的還原證據（EC-SPEC-10 §8.1）。
- 兩個環境都沒有收款、物流或發票能力：health 回報 money movement 為 false（`apps/platform-api/src/platform-app.ts:320`），報價條款寫死 `payment_state:'not_enabled'`、`shipping_state:'not_configured'`（`modules/agent-commerce/hosted/direct-quotes.ts:70`）。

### 1.3 相關的 open PR

| PR | 狀態 | 與本案的關係 |
| --- | --- | --- |
| #706（teddashh） | open | 分開呈現原作技能書、站內應用與可攜營業版本（EC-AT52 的介面與合成案例；EC-AT53 的「目前沒有發行物」）；列出三個上游的閱讀參考。沒有改 registry，`hosted-store` 的 `skill_book_refs` 仍是空的。EC-SPEC-07 沿用，不重做 |
| #689（teddashh） | draft | 原創程式改採 MIT；品牌、商標、Logo、圖片與插畫排除在外，第三方維持原授權。PR 自己記錄了 context 工具 `surface_unmapped` 的阻擋。是 DC07 的前置 |
| #670（YueyuHoshizora） | draft | 舊社群零售目錄分頁（`modules/catalog-commerce/service.ts`、`apps/platform-api/src/routes/commerce.ts`、`contracts/preview/v1`）。不碰 hosted commerce；本案若要改 preview 契約，先與它對齊 |

## 2. 可沿用的程式

| 範圍 | 既有 | 本案怎麼用 | 限制 |
| --- | --- | --- | --- |
| 事業與能力 | `tenant_workspaces`、`module_instances`、`deployment_bindings`；owner／admin 自動擁有 `store:*`（`modules/agent-commerce/hosted/capabilities.ts:9-12`） | 所有私有路由掛在 `R` 下 | `storefront@1.0.0` 的能力清單凍結（`migrations/134_hosted_storefronts.sql:88`）；新能力需要新的模組版本（EC-SPEC-09 §2） |
| 命令 | `storeCommand` → `scopedTenantCommand`：`Idempotency-Key`（8～128 字元）、CSRF、`If-Match`（缺 428、舊版 412）、同 key 不同內容 409 | 會員與 guest 的寫入都走同樣的冪等與版本規則 | `scoped_command_receipts` 只收 `principal_kind='person'`，沒有租約（`migrations/078_scoped_member_commands.sql:4`）；重播仍要當下的權限（`packages/db/command-core.ts:28`）。機器路徑不能用 |
| 庫存 | `commerce_items.stock`／`reserved`、`commerce_inventory_reservations` 與餘額 trigger（`migrations/162_hosted_inventory_reservations.sql`） | 唯一庫存，hold 之上加 allocation（EC-SPEC-03） | 文件明寫沒有 writer generation、外部切換與 hold 移交（`modules/agent-commerce/hosted/inventory-reservations.md:49-73`） |
| 秘密封存 | Worker secret 裡的 32-byte 金鑰＋AES-256-GCM＋AAD（`modules/identity-membership/totp.ts:44`、`modules/github-social/service.ts:58`） | `COMMERCE_CREDENTIAL_KEYS` keyring（EC-SPEC-04 §1） | broker vault 是模型憑證專用、最長 1 小時（`migrations/095_credential_vault.sql:28`），不拿來放商家金鑰 |
| 外部通知接收 | GitHub webhook：精確的 POST 路徑掛在會員邊界之前（`apps/platform-api/src/routes/repo-maintainer.ts:16`、`platform-app.ts:233`、`:552`），限制原始 bytes、HMAC＋`timingSafeEqual`，在同一交易存下 digest 後才回 202（`modules/repo-maintainer/webhook.ts:42`、`:65`、`:99`、`:140`） | 綠界 callback 照這個形狀：表單、CheckMacValue、回 `1\|OK`（EC-SPEC-04 §5） | 沒有商家、環境、金額與狀態轉移的驗證；去重只看 delivery ID，不比對內容衝突 |
| 對外呼叫的耐久操作 | 模組佈建的 operation／step 與租約（`migrations/128_module_registry.sql:449`、`:495`；`modules/module-registry/operations.ts:288-349`）：SQL → 對外 → SQL | 付款、物流、發票 operation 的租約與重試（EC-SPEC-04 §3、05 §5、06 §3） | 租約過期會再送一次 apply；付款與建單結果未知時必須先查詢（query-first） |
| 排程 | 主 Worker cron `*/10 * * * *`（`wrangler.jsonc:71`）→ `scheduled()` 依旗標執行具名工作（`apps/platform-api/src/worker.ts:431-458`） | commerce 的查詢與 operation 掃描用同樣方式加入（EC-SPEC-10 §5） | 沒有 queue consumer；每 10 分鐘一次是最細的節奏 |
| Email | `EMAIL` send_email binding，只在 staging／next，寄件人 `no-reply@mail.freetwai.com`（`wrangler.jsonc:88`、`:107`） | 訂單連結與通知（需寄送授權，EC-SPEC-10 §6.2） | 不是 outbox；活動提醒是在交易外直接寄，不能當可靠寄送的範本 |
| 物件與私有讀取 | `assets`／`asset_objects`／`asset_upload_intents`＋各領域的 target 表；R2 adapter 只建立不覆寫、app 端不能刪（`packages/asset-storage/r2.ts:50-127`）；私有內容由領域路由授權後讀出（`apps/platform-api/src/routes/tenant-work.ts:174`、`member-communications.ts:76`） | 商品照片（141）、封面與店標的新用途（EC-SPEC-02 §2）；匯出檔（EC-SPEC-08 §4） | MIME 白名單沒有 PDF、CSV、ZIP（`packages/asset-storage/index.ts:50`）；沒有通用的授權表或簽名網址；asset 一定要有會員 owner（`migrations/079_asset_upload_lifecycle.sql:6-7`），guest 不能上傳 |
| 備份與還原 | `packages/media-migration/`：PostgreSQL snapshot＋物件的一致備份與封存還原；演練 `tests/integration/tenant-rls-restore-drill.test.ts`、`recovery-generation-restore.test.ts` | 還原後的對帳流程（EC-SPEC-10 §8.4） | 只有整個平台的備份，沒有單一商店的匯出 |
| 綠界協定（本案新增） | `modules/agent-commerce/providers/ecpay/`（分支 `fc/ecpay-proto`）：CheckMacValue（SHA-256／MD5）、AES-128-CBC、.NET URL 編碼、表單解析上限、交易編號 | EC-SPEC-04～06 的 adapter 共用 | 已審查，2026-10-15 併入整合分支 `feat/freedom-commerce`（`931f8666`）；workerd 向量 5/5、runtime 13/13 |
| 發票規則（本案新增） | `modules/agent-commerce/invoices/rules/`（分支 `fc/invoice-rules`）：統編、買受人欄位、品項拆分、期別與作廢期限、更正建議 | EC-SPEC-06 | 已審查，2026-10-15 併入整合分支（`f250e66d`）；46/46 |
| 結帳核心（本案新增） | `modules/agent-commerce/checkout/`＋`migrations/168_hosted_checkout_core.sql`（分支 `fc/wp03-core`） | EC-SPEC-03 | 已審查（`16caa586`，含一輪修正），2026-10-15 併入整合分支（`d3cbb286`）；checkout 72/72 |
| 前端 | `PortalClient`、`ApiError`、`formatMinor`、`HostedStore.tsx`、`GuildLaunchpadApplications.tsx`；Supplier Console 的 `ConsoleShell`（`863614ef`） | Seller Console 沿用同一個 shell，不改 props；要加 props 先問 Supplier 工作階段 | 盤點細節見 pages.md |

## 3. 缺口

| ID | 缺口 | 證據 | 補法 | 規格 |
| --- | --- | --- | --- | --- |
| G-01 | 沒有商家的收款、物流、發票帳戶與金鑰版本 | 095 只綁模型連線 | `commerce_provider_accounts`＋封存金鑰 | EC-SPEC-04 §1 |
| G-02 | 沒有可查詢、可續做的 provider operation | `scoped_outbox` 只存事件，沒有狀態、租約與次數（`078:45`） | 各領域的 operation 表＋租約＋先查詢 | EC-SPEC-04 §3、05 §5、06 §3 |
| G-03 | 沒有 commerce 的排程與 queue | `worker.ts:431` 只跑具名工作；模組排程逐一掃每個 tenant scope（`modules/module-registry/operations.ts:529`） | 在 `scheduled()` 加旗標控制的掃描；`commerce_due_work` 跨 tenant 取到期列、每列在自己的交易綁 tenant | EC-SPEC-09 §2.4、EC-SPEC-10 §5 |
| G-04 | 沒有 MD5、AES-128-CBC 與綠界編碼 | 執行中的程式只用 SHA／HMAC／GCM | `fc/ecpay-proto`（已完成） | EC-SPEC-04 §3.2、§10 |
| G-05 | 沒有綠界 callback 的公開路徑；staging 在 Access 之後 | GitHub 的例外是專用的 | 每個 callback 一條精確路徑；staging 的 Access 排除由 Ted 設定 | EC-SPEC-04 §5、EC-SPEC-10 §4.4 |
| G-06 | 沒有比對內容衝突的 provider 事件收件匣與狀態轉移表 | GitHub 只用 delivery ID 去重 | 依來源鍵與內容 digest 去重，衝突進例外 | EC-SPEC-04 §5、05 §6 |
| G-07 | 沒有固定 provider 主機、逾時與拒絕轉址的對外政策 | 現有目的地是 GitHub／Cloudflare／AI 專用 | `ECPAY_ORIGINS`＋10 秒逾時＋不跟隨轉址 | EC-SPEC-04 §3.2、§6.3 |
| G-08 | callback 路徑沒有應用層限流 | GitHub 接收端沒有 limiter | 每條 callback 的限流與大小上限 | EC-SPEC-09 §4 |
| G-09 | 沒有 guest 的訂單存取能力 | hosted 訂單路由要求會員（`routes/hosted-orders.ts:19`） | 瀏覽器憑證與一次性信件連結 | EC-SPEC-02 §4.2、EC-SPEC-09 §2 |
| G-10 | 沒有匯出、標籤以外的私有附件用途 | MIME 白名單、asset owner 規則 | 匯出：EC-SPEC-08 §4；附件：§7 | EC-SPEC-08、本文件 §7 |
| G-11 | 沒有商店層級的資料匯出；一般授權不能含匯出能力 | `migrations/131_tenant_module_permissions.sql:26-27` 拒絕 `module.data.export` 等能力 | 有用途與期限的匯出授權 | EC-SPEC-08 §4 |
| G-12 | 沒有 writer generation 與外部切換 | `inventory-reservations.md:49-73` | 可攜版本的單一寫入者規則 | EC-SPEC-08 §5 |
| G-13 | Node 主機沒有物件儲存與排程 | `apps/platform-api/src/server.ts` 只建 pool 與 app；`packages/asset-storage/` 只有 R2 與測試用 fake | 可攜 profile 的檔案系統／S3 相容 adapter 與排程程序 | EC-SPEC-08 §2 |
| G-14 | descriptor 與發行 schema 沒有授權欄位 | `governance/schemas/module.schema.json` 的 `additionalProperties:false`，沒有 license／SPDX 欄位 | 授權記在可攜發行的清單，不改 descriptor schema | EC-SPEC-08 §3 |
| G-15 | 站內應用與技能書沒有實際連結 | `skill_book_refs` 為空且不可改（§6） | 新版本的 application release | EC-SPEC-07 §3 |
| G-16 | 沒有 commerce 的整體開關與公開能力布林 | 預留旗標只有 Node／Worker 對應，沒有就緒檢查（`worker.ts:124`、`:258`） | 能力清單與站台投影 | EC-SPEC-10 §2.2、§2.3、§2.6 |
| G-17 | 沒有 provider 的反例測試 | 現有測試只有 GitHub／broker／asset | 簽章、商家混用、金額不符、重複欄位、亂序、回應遺失、還原對帳 | EC-SPEC-09 §5 |
| G-18 | 模組版本不能升級 | `module_definitions` 不可改、實例的 `module_release_ref` 不可改（`migrations/128_module_registry.sql:130-164`、`131:39-50`）；`supported_upgrade_paths` 沒有程式讀；SP-04 的升級 API 只在規劃 | `storefront@1.1.0`＋`module_release_upgrades`＋只限 owner 的升級命令（SP-04 的最小子集） | EC-SPEC-09 §2.3 |
| G-19 | 請求閘道會擋下綠界的瀏覽器返回與通知 | 非 GET 一律要 `application/json` 與相符的 Origin（`apps/platform-api/src/platform-app.ts:235`、`:270`） | 只對五條確切路徑開例外，路由自己檢查表單與大小 | EC-SPEC-09 §2.6 |
| G-20 | 授權列只要求「至少一個 `:read` 鍵」 | `modules/tenant-workspaces/instance-grants.ts:30-32`；但 `requireStoreInstance` 要求 `store:read`（`hosted/capabilities.ts:27`），只給 `store:orders:read` 會整間店 404 | 改成檢查基本讀取鍵；`TenantSettings.tsx` 自動勾選 | EC-SPEC-09 §2.2 |

## 4. 新增 migration 的登錄清單

依 Codex 盤點的清單整理；`fc/wp03-core` 的 `4af52eaa`（登錄 168）是實際範例。

1. 檔名 `migrations/NNN_<name>.sql`（`packages/db/migration-plan.mjs:6` 的 legacy 格式）。只新增表、欄位、函式與 trigger；已發布的 migration 不能改：CI 以 inventory 比對（`scripts/ci/verify-source-boundaries.py:77-82` 的 `published_migration_changed`），套用時也比對 digest（`migration-plan.mjs:132`）。
2. 不用 `CREATE EXTENSION`、role 管理、SUPERUSER 類屬性；`SECURITY DEFINER` 除非列進 `REVIEWED_DEFINER` 並附 sha256，一律被拒（`deploy/cloudflare/lib/migrations.mjs:7-23`）。commerce 的機器路徑用交易身分變數，不用 definer 函式（EC-SPEC-09 §2）。
3. `deploy/cloudflare/environments.json` 的 `migrations.last`（`:59`）。
4. `deploy/cloudflare/lib/release-compatibility.mjs` 的 `FOUNDATION_NAMES`（`:80` 起，167 在 `:183`），加註說明是否只擴充、會不會開能力。
5. `deploy/cloudflare/test/migration-plan.test.mjs`：`last` 與最後檔名（`:159`、`:167`）；140 與 161 的歷史 digest 不動。
6. `deploy/cloudflare/test/release-compatibility.test.mjs`：最後檔名（`:101`）與 fixture；`4af52eaa` 用 `fixtureAt(last)` 讓證據固定在被測的 schema。
7. 有新的能力下限時（例如 `commerce.hosted-payment.v1`）：`release-compatibility.mjs` 的 `CAPABILITIES`（`:15`）與 `SHAPES`（`:16`），以及約 15 個 `deploy/cloudflare/test/release-*.test.mjs` 裡核准能力的陣列。
8. 新表的 RLS 比照 `migrations/134_hosted_storefronts.sql:22-25`（policy 為 `tenant_id = freedom_ctx_tenant()`）；`deploy/cloudflare/sql/20-runtime-grants.psql` 涵蓋一般新表，但套用 migration 後要重跑（staging、production 由 Ted 操作）。
9. `modules/module-data/catalog.ts`：每張表與每個欄位登錄 tenant 解析與隔離方式（或豁免理由）；hosted commerce 的解析路徑在 `catalog-check.ts:33` 的 `COMMERCE_RESOURCE_PATHS`；跑 `tests/runtime/tenant-data-catalog.test.ts`。
10. descriptor：新路徑要有 owner，否則影響範圍擴到全部模組；跑 unknown-paths 與 selectImpact 的 owner 檢查。
11. 測試 harness：`tests/runtime/module-registry-harness.ts` 與 `scripts/e2e-server.ts` 若需要新表的權限要一起改。
12. 有契約變更時重新產生（`modules/guild-workspace/generate-contracts.ts`）。
13. 升級測試：舊資料在新 schema 下仍成立。例如 `tests/runtime/hosted-direct-orders.test.ts` 的 v1 fixture 要配合 168 新增的 FK 改用 `CASCADE` 重建。
14. 最後才跑 `python3 -B scripts/update-inventory.py`，再 `npm run verify:inventory`；改了前端先 `npm run build` 再跑瀏覽器測試。

## 5. 來源權利（DC07）

### 5.1 平台本身

- `freedom.project.yaml` 的 licensing 是 `spdx_expression: "NOASSERTION"`、`license_file: null`、`source_distribution: "source_available"`，並寫明「NOASSERTION means licensing remains undecided; this metadata grants no additional reuse rights」。repo 根目錄沒有 LICENSE、NOTICE 或 COPYING。
- `packages/skill-upload-client/package.json` 是 `"UNLICENSED"`；根 `package.json` 沒有 license 欄位。
- registry 有 `license_state`（`unresolved`／`reviewed`／`blocked`，只能從 unresolved 前進一次）與 `license_review_ref`（`migrations/128_module_registry.sql:47-100`）。`hosted-store@1.0.0` 與 `storefront@1.0.0` 是 `reviewed`、`license_review_ref` 為 NULL、`portable_profile_ref` 為 NULL（`134:93`、`:100`）。這是站內託管用的審查，不是可攜再散布的授權證據。
- PR #689（draft）提議原創程式改 MIT，排除品牌與圖像；合併前 C3 不能發布可下載的營業版。

### 5.2 相依套件（`package-lock.json`，244 個第三方項目）

- lockfile 裡 33 項沒有 `license` 欄位，但已安裝套件的 `package.json` 與授權檔都有：MIT 24、ISC 8、Apache-2.0 1。這是 lockfile 的欄位缺漏，不是沒有授權；發行時的授權清單要從套件本身產生，不能只讀 lockfile。
- `sharp` 的 libvips 預建檔 14 項是 LGPL-3.0-or-later（皆為 optional，依平台安裝）。Node 自架版處理商品照片需要 sharp，發行時要附 LGPL 授權文字與來源取得方式（WP-09）。
- `lightningcss` 12 項是 MPL-2.0，只在建置時使用；只發佈建置產物時不散布它。
- 會員卡已附部分第三方授權文字（`apps/portal-web/public/licenses/member-card/`），可攜版的 NOTICE 依同樣做法，但要涵蓋整個發行物。

### 5.3 素材

可攜版預設不含以下素材，改用原創占位或商家自己的素材：

| 素材 | 現況 | 原因 |
| --- | --- | --- |
| 自由工坊 Logo（`apps/portal-web/public/brand/freedom-workshop.webp`） | 平台最高視覺錨點（DESIGN.md） | 平台標識，不是商家品牌；自架店不能冒用官方身分（`freedom.project.yaml` 的 fork 政策） |
| AI Sister 引導圖（1,377 張） | 授權只限 Freedom Platform 的新手引導，要保留出處 | 授權範圍不含再散布 |
| 龍的引導圖（364 張） | 作者 mars-tw（PR #106） | 沒有再散布授權 |
| 貼圖 v2（Hao 提供）、聊天貼圖、VERSEFOLK 插畫、RPG／技能書插圖 | manifest 沒有開放授權 | 只在平台使用 |
| EC-website-project 的圖片 | 沒有 LICENSE（sources.md §2） | DC10：不使用 |

### 5.4 技能書與上游

- 41 本官方技能書的授權：MIT 23、NOASSERTION 14、Apache-2.0 3、GPL-3.0-or-later 1（`modules/community/catalog.ts`＋`skill-book-guides.ts`）。
- 商店相關：`storefront`（`FreeTWAI/freedom-storefront`，閱讀版本 `9823df79`，NOASSERTION，開店與銷售公會）、`supplier-client`（`53fd5b0a`，NOASSERTION）、`pos-pro`（`Hao0321/pos-pro`，MIT）、`reconciliation`（NOASSERTION）。
- `repositories.lock.json` 釘的是跨 repo 測試用的版本（例如 `FreeTWAI-AI/freedom-storefront@87eda487`），和技能書的閱讀版本是兩回事，不用來判斷授權或閱讀內容。
- 上游參考：Majordomo 與 Toolkit 是 MIT，EC-website-project 沒有 LICENSE（sources.md §2）。MIT 只涵蓋各自 repo 的內容，不延伸到私有相依、provider 商標或 MCP 服務。

### 5.5 結論

- 站內開發（C1、C2）不受影響：不散布平台程式，也不使用受限素材。
- C3 可下載的營業版本，要等 DC07（Ted 決定授權）、#689 合併，加上 WP-09 的發行清單（授權子集、NOTICE、SBOM、素材排除）才能發布。EC-SPEC-08 §3 定義子集與檢查方式。

## 6. 三種資產的現況與接法

| 資產 | 現在在哪裡 | 記錄了什麼 | 缺什麼 |
| --- | --- | --- | --- |
| 原作技能書（SkillBook） | 靜態 TypeScript 目錄：`modules/community/catalog.ts`＋`skill-book-guides.ts`（不在資料庫） | 上游網址、閱讀版本（40 碼 SHA）、授權狀態、作者（部分）、來源證據路徑、推薦的公會 | 無；由上游作者維護，平台只更新閱讀版本 |
| 站內應用（HostedApplication） | `application_definitions`（`128:47`）＋`module_definitions`（`128:107`）＋公會上架 `guild_application_offerings`（`128:166`） | release、source commit、artifact digest、`skill_book_refs`、能力、授權審查狀態 | `skill_book_refs` 全部是空的；同一個 release 不能修改（`preserve_application_definition()`，`128:71-100`） |
| 可攜營業版本（PortableBusinessRelease） | 不存在 | `module_definitions.portable_profile_ref` 有欄位但都是 NULL；`deployment_bindings.mode` 允許 `external`，但沒有程式建立它（`modules/module-registry/launch.ts:221` 寫死 hosted） | 發行物、清單、支援矩陣，全部要新做 |

接法（EC-SPEC-07 §3、EC-SPEC-08 §6）：

- commerce 的新能力本來就需要新的 `storefront` 模組版本（EC-SPEC-09 §2）。同一次登錄新的 `hosted-store` release，`skill_book_refs` 填 `storefront`（以及 Ted 確認後的其他書），不改 `1.0.0`。
- PR #706 的 `ApplicationSkillSources` 已經依 `skill_book_refs` 顯示原作；資料有了，畫面自然出現，不必再改前端。
- 可攜版本先以發行物自帶的清單表達（EC-SPEC-08 §3）；有真的發行物後，才填 `portable_profile_ref` 並讓 #706 的「可攜營業版本」狀態顯示下載。

## 7. 私有附件的決定：C2 不存檔案，C4 再加

範圍：售後對話與申請的照片（EC-SPEC-06 §2.1、§2.2）、退貨檢驗的照片（EC-SPEC-05 §8.3）、供貨款的付款證據（EC-SPEC-06 §5.4）。

**決定**：C2 只存結構化文字（說明、數量、狀態、日期、金額、方式、參考末碼），不收檔案。畫面說明「平台目前不保存照片，請自行留存」。C4 新增 commerce 證據用途。

**理由**（都已在原始碼核對）：

- asset 一定要有會員 owner（`assets.owner_user_id` NOT NULL REFERENCES users，`migrations/079_asset_upload_lifecycle.sql:6-7`）；guest 買家沒有會員身分，要支援就得新增非會員上傳路徑，連帶匿名濫用、容量該算在哪個 tenant 等新問題。
- 三方讀取（買家、零售商、被指派的出貨者）需要新的 target 表與依訂單授權的讀取路由；現在沒有通用的授權表或簽名網址。
- 新用途還要決定保存期限、刪除墓碑、備份 pin 與還原後的處理（`migrations/082_asset_maintenance.sql`），這些和 DC12 一起定。
- 計畫的 C2 要求「可核對對帳與人工已付款證據入口」（§12.2）與有證據的退回流程，文字欄位已能滿足；照片是加分，不是 C2 的必要條件。

**C4 的形狀**（先記下，不在 C2 做）：用途 `commerce.evidence`；只收圖片，正規化成 WebP、每張 ≤ 1 MiB、每個案件 ≤ 5 張（比照 DM 圖片的 profile）；target 表以 `(tenant, case／inspection／payment)` 為鍵；只能經訂單範圍的路由讀取；保存期限依 EC-SPEC-09 §3。

## 8. 盤點時發現、後續容易弄錯的地方

- 表名以本文件與 sources.md §6.1 為準：沒有 `module_registry`、`tenant_module_instances`、`guild_module_launches`、`scoped_command_idempotency` 這些表。
- 「writer floor」是文件概念；部署工具以 `CAPABILITIES`、`SHAPES`、`FOUNDATION_NAMES` 與主機提供的 `rollback_floor` 表達（sources.md §6.1）。
- 現在沒有任何排程釋放 hold；到期由讀取、下單與取消時結算（EC-SPEC-03 §1.1、§1.2）。
- Access 排除與 `20-runtime-grants` 重跑都是部署動作，不能寫成程式完成就生效。
- Node 主機（`server.ts`）沒有物件儲存與排程，不能拿它直接當自架版本（G-13）。
