# SC-SPEC-03 商品、合作、條件與預留的讀寫

需求：SC-R03、R04、R06、R13～R17、R19～R24。驗收：AT-01～22、29～31、37。

## 原則

- 不新增任何商品、庫存、同意或訂單資料；新讀取都是既有資料列的投影，命令全部沿用既有路由、key 與版本。
- 新讀取與 `PATCH supply-profile` 只在 `guild launchpad` 與 `supplier console` 兩個 host 設定都開啟時掛載（`apps/platform-api/src/routes/hosted-supplier-console.ts`，掛在 `platform-app.ts` 的 launchpad 區塊內）；關閉時回 404，前端回到舊頁。
- 每個新讀取都先通過 `storeRead`（current tenant／instance／capability，並在結尾檢查 session 時鐘），所有數字在**同一個 SQL statement** 內算出，`as_of` 取該 statement 的 `statement_timestamp()`，到期判斷用同一個值。
- 舊 wire 欄位 `cost_minor` 在新投影一律命名 `supply_price_minor`（供貨單價），不代表製造成本；一個事業只有一種幣別，任何數量或金額都不跨幣相加。

## 功能設定

| 層 | 名稱 |
| --- | --- |
| Host 環境變數 | `FREEDOM_SUPPLIER_CONSOLE_ENABLED`（`'true'` 才開；預設關） |
| `createApp` 選項 | `supplierConsoleEnabled?: boolean`，未給時讀環境變數（`apps/platform-api/src/app.ts`） |
| Worker | `readWorkerConfig` 讀同名變數（`apps/platform-api/src/worker.ts`） |
| Runtime → site | `GET /api/v1/site` 回 `supplier_console_enabled = guildLaunchpadEnabled && supplierConsoleEnabled`（`platform-app.ts:322` 附近） |
| E2E | `tests/e2e/member-feature-fixture.ts` 的 `Features` 加 `supplierConsoleEnabled`，以每個測試自己的 feature host 開啟 |

這是畫面與新讀取的開關，不是授權；關閉不會撤銷 migration 或已發生的命令。

## 新讀取

`R` = `/tenants/:tenant_id/storefronts/:instance_id`。所有回應 `Cache-Control: private, no-store`，query 必須為空（`singleQuery`＋空 schema）。

### `GET R/supplier-console/overview` → `SupplierOverviewSchema`

- 權限 `store:read`；未設定 profile → 409 `storefront_not_set_up`。
- 呼叫者沒有 `store:write`：四項指標與 `todos` 都回 `unavailable`／`store_write_required`；這條路徑只算容量計數與 `as_of`，**不執行**帶價格、條件、選品或訂單的查詢。
- `active_reservation_lines`：tenant owner 才計算，其他人回 `unavailable`／`owner_required`。
- 定義：
  - `offered_products`＝本店商品中有 `state='offered'` offer 的件數。
  - `pending_requests`＝offer 屬於本 instance、`acceptance_state='awaiting_supply_acceptance'` 且 offer 仍 `offered` 的選品數（與舊頁提醒同義）。
  - `active_reservation_lines`＝`supplier_shop_id` 為本店、訂單 `order_profile='hosted_shared_reservation'`、`reservation_state='reserved'` 且 `expires_at > as_of` 的行項數。讀取不結算到期訂單（那是預留清單命令的責任）。
  - `out_of_stock_products`＝本店商品中 `stock - reserved = 0` 的件數。可用量只在讀取服務 `own` CTE 的 `available` 一欄計算，概覽、清單與詳情共用；Commerce 的庫存規則改變時只改這一欄（SC-SPEC-07 §1）。
  - `todos`：依「待確認申請（含店家 ID 與名稱）→ offer 已過期（目前條件的雜湊 ≠ offer 雜湊）→ 缺貨 → 尚未公開」排序，取 20 筆，`truncated` 表示還有更多。
- `product_count` 沿用既有共用容量計數。

### `GET R/supplier-console/products` → `SupplierProductsSchema`

- 權限 `store:write`。回傳完整的本店商品（與 `supply-products` 同一組資料列，最多 200；超過視為 500 不變條件錯誤）。
- 每列：`supply_price_minor`、`shipping_minor`、`stock`、`reserved`、`available`（schema 驗證 `available = stock - reserved`）、商品版本、目前 `offered` 的 offer（`offer_id`、`version`、`terms_sha256`、`matches_current_terms`）、合作數。
- 合作數以本商品所有 offer 版本上的賣家選品分桶：`awaiting`（待確認且 offer 仍公開）、`sellable`（可售且 offer 仍公開）、`changes_requested`、`inactive`（其餘：不同意、撤回、或 offer 已撤回）。
- `matches_current_terms` 必須與公開命令用同一個函式計算：把 `publishSupplyOffer` 內組 terms 的程式抽成 `supplyOfferTerms(row, currency)`（`modules/agent-commerce/hosted/distribution.ts`），公開與讀取都呼叫它再 `digest`。

### `GET R/supplier-console/products/:product_id` → `SupplierProductDetailSchema`

- 權限 `store:write`；不是本店商品 → 404 `not_found`。
- 回傳上面的單列、出貨與退貨條件全文、目前 offer 的完整凍結條款（可能為 null）、此商品所有 offer 版本上的賣家選品（`DistributionSchema`，依 待確認→可售→需修改→其他 排序，最多 200，`truncated`）。
- 影響預覽（公開新版本、撤回）只用這份讀取的 `selections` 顯示，並寫上 `as_of`；提交仍由命令以版本重新核對。

### `GET R/supplier-console/partners` → `SupplierPartnersSchema`

- 權限 `store:write`。對「offer 屬於本 instance 的所有賣家選品」以賣家店面 shop ID（`commerce_selections.shop_id`）分組；`name` 為該 shop 目前名稱。
- 每家：四個合作數與商品數（distinct item）。排序：`awaiting` 多者優先，再依名稱、ID；最多 200 家，`truncated`。
- 只回傳這間店與本供應商的關係；不讀賣家的其他選品、客戶、價格或 tenant。

### `GET R/supplier-console/partners/:partner_id` → `SupplierPartnerDetailSchema`

- 權限 `store:write`；該店沒有任何選品在本供應商的 offer 上 → 404 `not_found`（不透露該店是否存在）。
- `partner` 的計數涵蓋全部關係；`selections` 最多 200，`truncated`。

## 新命令：`PATCH R/supply-profile`

| 項目 | 規格 |
| --- | --- |
| 權限 | `store:manage`（與建立相同） |
| Header | `Idempotency-Key` 必填；`If-Match` 必填，為 profile 版本（`GET R/supply-profile` 的 `version`／ETag） |
| Body | `SupplyProfileUpdateInputSchema`：`name`、`description` 至少一項；幣別不可改 |
| 限制 | 只適用 `retail_enabled=false`；已開零售回 409 `retail_profile_settings`，畫面改連商店資料頁（單一寫入者） |
| 效果 | 同一交易內更新本 instance 兩間 hosted shop 的名稱／說明，profile 版本 +1，寫 `storefront.supply-profile.update` journal |
| 回應 | `SupplyProfileReceiptSchema` `{instance_id, version}`，ETag＝新版本 |
| 實作 | `updateSupplyProfile`（`modules/agent-commerce/hosted/supply-catalog.ts`），路由與新讀取同檔、同一個開關 |
| 錯誤 | 412 版本過期、428 缺版本、409 `idempotency_conflict`、403 權限、409 `storefront_not_set_up` |

既有已公開 offer 的 `supplier_name` 是凍結值，改名後要重新公開版本才會更新；設定頁需寫明這一點。

## 純供貨商品照片（G-05）

- `photoProducts(q, p, options)` 增加參數 `{retailOnly: boolean}`：`publish.ts` 的發布投影一律傳 `true`（行為不變）。私人照片清單、單張讀取、上傳與移除由 `hosted-store-media.ts` 依開關決定：新版開啟時傳 `false`，涵蓋本店所有自有商品（含 `own_retail_enabled=false`）；新版關閉時傳 `true`，與原本相同。
- 關閉新版不刪除已上傳的純供貨商品照片；它們只是不再出現在私人照片清單，重新開啟後照原樣回來。
- 私人照片讀取仍是 `store:read`，回傳只有商品 ID、版本與照片 metadata，不含價格或文字。
- 公開頁與合作賣家發布的投影不變：純供貨商品不出現在公開頁，合作商品在賣家公開頁仍沒有供應商照片（合作素材屬 SC-09）。

## 沿用的命令（console 動作 → 既有 API）

| 動作 | API | 版本 | 已知結果 |
| --- | --- | --- | --- |
| 設定商品庫 | `POST R/supply-profile` | 無 | `created:false` 時重讀，不重建 |
| 新增商品 | `POST R/supply-products` | 無 | 409 `product_limit_reached` |
| 改內容／庫存 | `PATCH R/supply-products/:id`（只送改動欄位） | 商品版本 | 409 `stock_below_reserved`、`supply_terms_in_use`；412 |
| 改供貨條件 | `PATCH R/products/:id/supply-terms`（整組四欄） | 商品版本 | 412 |
| 公開新版本 | `POST R/products/:id/supply-offer` `{}` | 商品版本 | 內容相同時回原 offer（不算新版本） |
| 撤回版本 | `POST R/supply-offers/:offer_id/withdraw` `{}` | offer 版本 | 已撤回時回同一投影 |
| 同意／不同意／撤回同意 | `POST R/supply-requests/:id/decision` | selection 版本 | 先 412，再 409 `snapshot_changed`、`invalid_state` |
| 預留開關 | `PATCH R/reservation-setting` | profile 版本 | owner 限定；host 關閉時只能停止 |
| 預留清單 | `GET R/supply-reservations?limit=20&cursor=` | — | owner 限定；讀取會結算到期訂單 |

## 反例（runtime 測試要涵蓋）

| 反例 | 期望 |
| --- | --- |
| viewer（只有 `store:read`）讀概覽 | 200，指標與待辦全部 `unavailable`；讀商品、詳情、合作店家 → 403 |
| admin 讀概覽 | 預留行項 `owner_required`，其他為數字 |
| 另一個 tenant 的成員讀任何新路由 | 404／403，不回任何列 |
| 兩間同名賣家店選同一商品 | 合作店家兩列，ID 不同（AT-16） |
| 預留到期時間剛過 `as_of` | 不計入有效預留行項 |
| 改條件後未重新公開 | `matches_current_terms=false`，待辦出現「供貨版本已過期」；重新公開後為 true |
| 公開同一份條件兩次 | 同一 offer，數量不變 |
| 已開零售的事業 PATCH supply-profile | 409 `retail_profile_settings`，名稱不變 |
| 同 key 不同 body 改事業名稱 | 409 `idempotency_conflict` |
| 純供貨商品上傳照片後發布零售店 | 公開投影不含該商品與照片 |
| 新版關閉時對純供貨商品上傳、移除或讀取照片 | 404，不寫入；零售商品照片不受影響 |
| 新版設定關閉 | 新路由 404；既有路由行為完全不變 |
