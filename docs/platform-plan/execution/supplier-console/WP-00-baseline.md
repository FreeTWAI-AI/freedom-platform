# WP-00 現況差異與重用對照

基準 `efaf314d`。本文件只寫已在原始碼核對的事實；路徑皆相對 repo 根目錄，API 皆相對 `/api/v1`。`R` = `/tenants/:tenant_id/storefronts/:instance_id`。

## 1. 已經存在、本案直接沿用的東西

**資料與權威**：一個 hosted store instance 有兩間 hosted shop——供貨 shop（`supply_shop_id`，商品 `commerce_items` 所在）與店面 shop（`storefront_shop_id`，本店 `commerce_selections` 所在）。每個 tenant 最多一個非封存的 storefront instance（`migrations/134_hosted_storefronts.sql:6`）。純供貨事業是 `commerce_storefront_profiles.slug IS NULL` 的同一種 profile，不是另一套資料（`modules/agent-commerce/hosted/store.ts:128`）。商品容量 200 件，供貨商品、自有零售商品與選用他店商品共用（`store.ts:63`）。

**供貨單價**：wire 欄位 `cost_minor` 實際存在 `commerce_items.price_minor`；目前 UI 一律顯示「供貨單價」，不是製造成本（`supply-catalog.ts:35`、`apps/portal-web/src/modules/HostedSupplyCatalog.tsx:242`）。

**版本**：商品、條件、供貨版本公開與照片命令都以「本店 selection 的 `aggregate_version`」做 `If-Match`；任何一項修改都會讓其他編輯器的版本過期（`supply-catalog.ts:74`、`supply-terms.ts:36`、`distribution.ts:32`）。

**命令**：所有寫入都經 `storeCommand` → `scopedTenantCommand`，必帶 `Idempotency-Key`（8～128 字元）與 CSRF；需版本的命令缺 `If-Match` 回 428，舊版本回 412；同 key 不同 body 回 409 `idempotency_conflict`。商品與事業命令只回 ID／版本 receipt，供貨版本與同意命令回單筆投影；兩者都不是整頁最新資料，畫面必須重讀（`apps/platform-api/src/routes/tenant-http.ts`）。

**能力**：owner／admin 自動擁有 `store:read`、`store:write`、`store:manage`、`store:publish`；operator／viewer 依 `tenant_module_permissions`（`modules/agent-commerce/hosted/capabilities.ts:9-12`）。預留相關讀寫另外要求 `tenant.role === 'owner'`（`seller-orders.ts:29`）。

### 1.1 供應端 API（全部掛在 `FREEDOM_GUILD_LAUNCHPAD_ENABLED=true` 之下）

| 用途 | Method 與路徑 | 權限 | 版本／分頁 | 回應重點 |
| --- | --- | --- | --- | --- |
| 我的商品庫 | `GET /me/supply-catalogs?pagination=cursor` | 各 tenant 的 `store:read` | tenant cursor | 含純供貨與已開零售的 instance、`setup_state`（`store.ts:174`） |
| 事業資料 | `GET R/supply-profile` | `store:read` | ETag＝profile 版本 | `SupplyCatalogView`：名稱、說明、幣別、`retail_enabled`、`product_count`、`writable`、`capabilities` |
| 建立事業資料 | `POST R/supply-profile` | `store:manage` | 無 If-Match | 已存在則回 `created:false`，**不會更新**（`supply-catalog.ts:28`） |
| 商品清單 | `GET R/supply-products` | `store:write` | 無游標，`LIMIT 201` | 只有 `stock`，**沒有 reserved／available／供貨版本** |
| 新增商品 | `POST R/supply-products` | `store:write` | 無 If-Match | `{title, description, cost_minor, stock}`；滿 200 回 409 `product_limit_reached` |
| 修改商品 | `PATCH R/supply-products/:product_id` | `store:write` | If-Match 商品版本 | 部分欄位；`stock < reserved` 回 409；已被舊式選品使用時改價回 409 `supply_terms_in_use` |
| 讀取條件 | `GET R/products/:product_id/supply-terms` | `store:write` | ETag | 唯一回傳 `reserved`、`available`、運費、出貨／退貨條件的讀取 |
| 修改條件 | `PATCH R/products/:product_id/supply-terms` | `store:write` | If-Match 商品版本 | 整組 `{cost_minor, shipping_minor, shipping_terms, return_terms}`；不改已公開版本 |
| 公開供貨版本 | `POST R/products/:product_id/supply-offer` | `store:write`＋`store:publish` | If-Match 商品版本 | 內容雜湊相同為 no-op；不同則撤回舊版並建立新版（凍結 terms 與 `supplier_name`） |
| 撤回供貨版本 | `POST R/supply-offers/:offer_id/withdraw` | `store:write` | If-Match offer 版本 | 已撤回時重送回傳同一投影；不撤銷既有可售同意，但跨店預留要求 offer 仍 `offered` |
| 我的供貨版本 | `GET R/supply-offers` | `store:write` | 最多 100，`truncated` | 只列 `offered` |
| 收到的申請 | `GET R/supply-requests` | `store:write` | 最多 200，`truncated` | 只有 `seller_name`，**沒有穩定店家 ID** |
| 回覆申請 | `POST R/supply-requests/:selection_id/decision` | `store:write` | If-Match selection 版本 | `{decision: accepted｜declined｜revoked, listing_sha256}`；先比版本（412），再檢查摘要（409 `snapshot_changed`）與狀態（409 `invalid_state`）；回傳完整 selection 投影 |
| 預留設定 | `GET/PATCH R/reservation-setting` | owner | If-Match profile 版本 | host 關閉時仍可停止；`payment/fulfilment` 皆 false |
| 供應端預留 | `GET R/supply-reservations?limit&cursor` | owner | 1～99（預設 20），簽章游標綁定空 filter | 只含本供應商行項；讀取時會把到期訂單結算為 expired（以 command 執行，`supplier-orders.ts:14`） |
| 商品照片 | `GET R/product-media`、`POST R/products/:id/photo`、`…/photo/remove` | 讀 `store:read`，寫 `store:write` | If-Match 商品版本 | 需照片旗標；**純供貨商品全部 404**（見 G-05） |

### 1.2 合作賣家端（SC-12 沿用）

賣家瀏覽 `GET R/supply-catalog`（同社群、同幣別、`offered`），以 `POST R/distribution-selections {offer_id, terms_sha256, retail_price_minor}` 申請，`PATCH R/distribution-selections/:id` 改價（重回待確認），`POST …/withdraw` 停用；`GET R/distribution-selections` 讀自己的選品。賣家必須已開零售（`retailReady`）。發布店面 `POST R/publish` 才會讓可售選品出現在公開頁；合作商品在公開頁沒有照片（`publish.ts:15`、`distribution.ts:158-166`）。賣家預留 `GET/POST R/reservations…` 只限賣家 owner。

## 2. 前端重用對照

依據 Codex 前端盤點並抽查。「拆分」＝保留行為、改由新頁面使用；「新做」＝目前沒有對應頁面。

| 既有 | 處理 | 說明 |
| --- | --- | --- |
| `PortalClient`、`ApiError`、`formatMinor`、`parseMajorToMinor` | 沿用 | 不另造 JSON client；金額沿最小單位 |
| `ProductSearch`、`PriceDifference`（`modules/agent-commerce/hosted-ui/CommerceTools.tsx`） | 沿用 | 價差保留「不是利潤」說明 |
| `HostedReservationSetting`、`SupplierOrdersLink` | 沿用 | 只在 owner 讀取成功後顯示控制 |
| `CatalogBlock`、`useGuildRead`、`useMyStores`、`LaunchFlow` | 沿用 | 公會區塊仍只讀／導覽／啟動；連到 `#stores/<t>/<i>/supply` |
| `HostedSupplyCatalog` 的 held attempt、busy lock、讀取票號、session 圍欄、離開保護 | 拆分 | 新 controller 保留相同語意，並補上 412 保留草稿 |
| `SupplySetupForm`、`SupplyProductForm`、`HostedSupplyTerms`、`HostedDistribution` 審核卡 | 拆分 | 表單欄位與金額解析沿用；重試與版本由 console controller 持有 |
| `HostedSupplierOrders` | 拆分 | 行項呈現沿用；頁面改為 console 的預留頁 |
| `HostedStorePhoto` 與照片狀態模組 | 沿用 | 不改成通用 JSON attempt；照片自己的未知結果保留 |
| 三區長頁（商品／合作／預留，同一 hash） | 新做 | 改為 console 頁面模型與 deep link |
| 概覽、合作店家、商品詳情、設定 | 新做 | 目前沒有對應畫面 |

## 3. 缺口

| ID | 缺口 | 影響頁面 | 補法 | 工作包 |
| --- | --- | --- | --- | --- |
| G-01 | 商品清單沒有 reserved／available／供貨版本／合作數；逐件讀條件會在瀏覽器拼出不同時間的數字 | SC-03、04 | 新增一次讀完的商品投影 | WP-03 |
| G-02 | 供貨申請沒有穩定店家 ID，同名店會被合併 | SC-06、07 | 合作店家投影以賣家店面 shop ID 分組 | WP-03 |
| G-03 | 沒有概覽數量與待辦的伺服器讀取；目前只有前端「至少 N 件」提示 | SC-03 | 新增概覽讀取，帶 `as_of` 與不可用原因 | WP-03 |
| G-04 | 沒有修改供貨事業名稱／說明的命令；重送 POST 不會更新 | SC-11 | 新增 `PATCH R/supply-profile`（限純供貨 profile） | WP-03 |
| G-05 | 純供貨商品無法上傳、讀取或移除照片 | SC-05 | 私人照片讀寫納入本店純供貨商品；公開發布範圍不變 | WP-04 |
| G-06 | 單一商品詳情只能讀條件，沒有該商品的合作清單 | SC-05、07 | 新增商品詳情投影（含該商品的選品，最多 200） | WP-03 |
| G-07 | 供應端預留沒有伺服器篩選與詳情路由 | SC-08 | 游標已綁 filter；補狀態／店家／商品／期間篩選與單筆讀取 | WP-03（第二批） |
| G-08 | 舊頁 412 會清掉商品與條件草稿 | SC-05、07 | 新 controller 保留草稿並顯示最新版本 | WP-02 |
| G-09 | selection 沒有時間欄位，「近期變更」沒有來源 | SC-03 | 由既有 transition journal 做本 instance 的有界投影 | WP-03（第二批） |
| G-10 | 沒有合作素材資料、授權與撤回模型 | SC-09、12 | 新 sidecar＋既有 Asset intent／finalize；需新 media profile | WP-05 |
| G-11 | 沒有報表與匯出；repo 無 CSV 公式防護 | SC-10 | 有界報表讀取＋CSV 產生器 | WP-05 |
| G-12 | 業主無法列出已發出的邀請 | SC-11 | R1 只連到既有團隊頁；列出邀請另案 | WP-05（不阻擋） |
| G-13 | 新頁面沒有頁面工具與導覽登錄 | 全部 | 登錄 `supplier-console` 頁面說明；引導維持「未審核」停用原因 | WP-02 |
| G-14 | 公會區塊無本人待辦摘要 | SC-01 | 第一批維持只讀連結；摘要需另一個以本人事業為範圍的讀取 | WP-04（第二批） |

## 4. 角色映射（不新增角色）

| 計畫角色 | 對應 | 本案可見 |
| --- | --- | --- |
| 供應事業 owner | tenant owner | 全部；預留設定與預留清單只限 owner |
| 受授權協作者 | admin（全部 store 能力）或 operator／viewer（依授權） | `store:write` 才看供貨價、條件、合作；`store:read` 只看名稱、幣別、容量 |
| 合作賣家 | 另一 tenant 的商店 | 只在自己的商店後台看到供貨版本、自己的選品與同意 |
| 公會長／作者 | 公會身分 | 只有公會區塊的讀取／導覽／啟動；沒有任何供應事業私人資料 |
| 訪客／買家 | 無 tenant 身分 | 只看已發布店面 |
