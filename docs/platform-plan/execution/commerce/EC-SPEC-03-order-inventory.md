# EC-SPEC-03 訂單與庫存：新交易 profile、hold → paid allocation、出貨與退回

需求：EC-R03、R04、R09、R10、R12～R14、R26～R30、R33、R39、R44、R52、R56。驗收：EC-AT07、08、10、26～31、39、42、59、64。

本文件是 C2 交易核心的設計，基準 `efaf314d`。標「提議」的表名、欄位與函式名稱尚未存在；標「現況」的內容已在原始碼核對（路徑相對 repo 根目錄）。名稱可以收斂，不變條件與相容規則不可縮小。

## 1. 現況（已核對）

### 1.1 兩個 v1 預留 profile

| 項目 | 現況 | 來源 |
| --- | --- | --- |
| 訂單權威 | `commerce_orders`＋`commerce_order_lines`，`order_profile` ∈ `imported_reseller`／`hosted_direct_reservation`／`hosted_shared_reservation`，建立後不可改 | `migrations/138_hosted_direct_reservations.sql`、`161_hosted_shared_reservations.sql:9` |
| 報價 | `commerce_order_quotes`：5 分鐘、`terms_sha256`、`bindings`、`quote_profile`；買家必須是 `principals`（會員） | `138:…`、`161:3`、`modules/agent-commerce/hosted/direct-quotes.ts:34` |
| hosted 訂單欄位 | `buyer_payment='pending'` 固定；`expires_at=created_at+30 分`；`reservation_state` reserved→cancelled｜expired 只能一次 | `161:12-21`、`161:50-66` |
| 行項 | hosted 行項建立後不可改／刪；共同供貨行項由 trigger 核對報價、同意與供貨版本 | `161:68-118` |
| 持久 hold | `commerce_inventory_reservations`（held→released 一次，30 分，`UNIQUE(order_id,item_id)`，不可刪） | `162:3-45` |
| 餘額不變條件 | deferred trigger：hosted 商品 `commerce_items.reserved = Σ held`；hosted 訂單的 hold 必須與行項逐項相符，`held ⇔ reservation_state='reserved'` | `162:50-106` |
| 庫存 port | `ReservationInventory`：`status/lock/reservation/reserve/release`；`available = stock − reserved`，SQL 內檢查餘額 | `modules/agent-commerce/hosted/inventory.ts` |
| 到期 | 不靠背景排程：建立報價／訂單時依缺額結算到期單（每 item ≤99 單、≤50 item）；讀單、取消、供應端清單也會結算 | `direct-effects.ts:72-110` |
| 鎖序 | 身分／scope → tenant／instance／deployment → `commerce-orders/{community_id}` advisory lock → profile → quote／order → item（UUID 排序） | `direct-order-contract.md:55-63`、`direct-authority.ts:39-81`、`store.ts:104` |
| 寫入下限 | `commerce.hosted-inventory-reservation.v1`（162）、`commerce.hosted-shared-reservation.v1`（161） | `deploy/cloudflare/lib/release-compatibility.mjs:22-25` |
| 財務欄位 | v1 DTO 的 `payment/refund/fulfilment/money_movement_enabled` 是 `z.literal(false)`；`amount_due_minor=null` | `contracts/guild-launchpad/v1/hosted-order.ts:14-40` |

### 1.2 誰讀寫庫存

完整逐行清單（modules 227 處、apps 46、migrations 155、tests 429、contracts 21）在 inv-core 盤點報告（見 [sources.md](sources.md)）；下表是會影響本設計的寫入者與讀者，已逐條對原始碼核對（路徑在 `modules/agent-commerce/` 之下）：

| 對象 | 寫入／讀取 | 位置 | 本設計的處理 |
| --- | --- | --- | --- |
| `stock` | 新增商品 | `hosted/products.ts:45` | 不變 |
| `stock` | 修改商品、純供貨商品；`stock ≥ reserved` 否則 409 `stock_below_reserved` | `hosted/products.ts:66-69`、`hosted/supply-catalog.ts:64-69` | 不變：`reserved` 含 A 之後，這條下限自動涵蓋已付款配置 |
| `stock` | imported 舊流程匯入 | `imports.ts:57`（只有 `origin='imported'`） | 不變；A 只存在於 hosted |
| `reserved` | hold 建立：`reserved += q`，條件 `stock − reserved ≥ q` | `hosted/inventory.ts:92-93` | 不變（H） |
| `reserved` | hold 釋放：`reserved −= q` | `hosted/inventory.ts:102` | 不變（H） |
| `reserved` | imported 下單／到期／取消 | `orders.ts:45,91` | 不變；imported 的「已付款」仍保留 `reserved`、交寄（`recordShipment`）不扣 `stock`，這是舊流程的既有語意，與 hosted 分開（`orders.ts:168,181-191`） |
| 讀 `stock − reserved` | 報價／下單的餘額與鎖 | `hosted/inventory.ts:60,66` | 不變 |
| 讀 `stock − reserved` | 供貨條件（私人）DTO | `hosted/supply-terms.ts:11` | 不變 |
| 讀 `stock − reserved` | 供應商營運中心 | `supplier-console/reads.ts`（Supplier Console 分支 `9626ce5b`，`own` CTE 的 `available` 一欄） | 不變 |
| 讀 | 公開店面 | `hosted/public.ts` | 公開投影不讀即時庫存（只讀發布版本的允許欄位）；不變 |

其他已核對的事實：

- 沒有任何排程在釋放 hold：Worker 的 `scheduled()` 只跑活動提醒、GitHub 同步、模組佈建與登入清理（`apps/platform-api/src/worker.ts:431` 起）。到期完全靠讀取、取消與下單時的結算。
- 舊的會員 `/api/v1/commerce/*` 與 bearer `/shop-api/v1/*` 路由仍然掛載、沒有開關（`apps/platform-api/src/platform-app.ts:491,687`），但它們只能操作 `origin='imported'`（`orders.ts:46,69`、`packages/resource-scopes/shop-service.ts:48`），碰不到 hosted 庫存；新設計維持這個隔離，不把 A 套到 imported。
- 這五張表沒有 RLS（`modules/module-data/catalog.ts:2090-2111` 明列豁免與理由）；hosted 的私人存取經 `commerce_resource_tenants`（tenant 相等的 RLS，`migrations/134_hosted_storefronts.sql:22`）。報價表有 RLS：讀＝tenant 或買家，寫＝tenant 且買家（`138:26`）。
- 交易內的身分變數是 `freedom.principal_id`、`freedom.tenant_id`、`freedom.tenant_scope_id`、`freedom.platform_admin_id`（`migrations/125_tenant_row_security.sql:36`、`packages/resource-scopes/tenant-transaction.ts:76`）。guest 與機器路徑（provider 通知、查詢、排程）沒有 principal，新表的 RLS 與 SECURITY 設計要明確處理（EC-SPEC-09 §2）。
- 金額單位：`100 minor = 1 TWD`（也是 1 USD）；輸入最多兩位小數，超過直接拒絕、不四捨五入（`apps/portal-web/src/format.ts:46-65`、`hosted/format.ts:2`）。ECPay 的 `TotalAmount` 是整數新臺幣；綠界 profile 要求 terms 的每個金額都是整數元，規則在 EC-SPEC-04 §2。

## 2. 庫存不變條件（N／H／A）

對每個 hosted 商品 `i`：

| 符號 | 定義 | 儲存 |
| --- | --- | --- |
| N | 實體可售在庫量（含被 H、A 占住的件數；不含待檢退件） | `commerce_items.stock`（現況欄位） |
| H | 未付款的暫時保留 | `commerce_inventory_reservations` 中 `state='held'` 的數量和（現況表） |
| A | 已確認付款、待出貨的配置 | 提議 `commerce_inventory_allocations` 的 `quantity − shipped_quantity − released_quantity` 和 |
| reserved | H＋A | `commerce_items.reserved`（現況欄位，語意擴充） |
| available | N − H − A ＝ `stock − reserved` | 不儲存 |

**不變條件**

1. `reserved = H + A`，由新的 deferred constraint trigger 檢查（取代 162 的 `reserved = H`；舊 profile 不產生 A，所以對舊 writer 仍成立）。
2. `0 ≤ reserved ≤ stock`（現況 CHECK）。
3. 每張 `hosted_checkout` 訂單：每個 (order, item) 的 hold 量＋配置量＝該 item 行項量；hold 與配置同時只能有一個「有效」：hold `held` 時配置不存在；hold 已釋放後才可有配置。
4. 配置計數只增不減：`shipped_quantity`、`released_quantity` 單調遞增，`shipped + released ≤ quantity`；配置列不可刪。
5. 每次 N、A 的變動都有一筆不可改的 movement（提議 `commerce_inventory_movements`），以 `(kind, 來源 ID, allocation_id)` 唯一，重送同一事件不會再扣一次。

**相容性結論**：所有現有 reader 的 `available = stock − reserved` 不需修改仍然正確；v1 DTO 的 `reserved` 讀作 H＋A。新 DTO 才分開顯示 held／allocated。供應商 `reads.ts` 的公式保持有效，不必等本案 helper。

### 2.1 每個操作對 N、reserved 的影響

| 操作 | 觸發 | N | H | A | reserved | 守門條件 |
| --- | --- | --- | --- | --- | --- | --- |
| hold | 下單（placement） | – | +q | – | +q | `available ≥ q`，全部行項一起成功或全部回滾 |
| hold release | 未付款取消／到期 | – | −q | – | −q | hold 仍 `held`，每筆只能一次 |
| convert | 付款確認且 hold 仍 `held` | – | −q | +q | 0 | 同一交易：hold → released、建立配置（`source_reservation_id`） |
| allocate | 晚到付款（hold 已釋放） | – | – | +q | +q | 整張訂單所有 item `available ≥ q` 才成立，否則進例外（§5.3） |
| allocation release | 已付未出貨取消／改為不出貨 | – | – | −q | −q | 不超過剩餘配置量 |
| ship | shipment 確認交寄（handed_over） | −q | – | −q | −q | 以 shipment 行項為準；印單、建單不觸發 |
| return receive | 退件實體到達 | – | – | – | – | 進待檢（不可售），不動 N |
| restock | 驗收判定可再售 | +q | – | – | – | 每件退回只能一次；退款不觸發 |
| write-off | 驗收判定不可售 | – | – | – | – | 只記驗收結果 |
| 人工改庫存 | 商品編輯 | =n | – | – | – | `n ≥ reserved`（現況） |

hold 的期限仍是 30 分鐘、仍依現況 CHECK 與建立時間綁定，所以同一張訂單**不重新 hold**。保留期限過後要再付款，從同一個 checkout 重新下單（§4.3）。

## 3. 新交易 profile：`hosted_checkout`

v1 的兩個 profile 及其 wire 不變；不把 literal false 換成 true。新交易只寫新的 profile（EC-R27）。

### 3.1 存放位置（提議）

| 資料 | 位置 | 說明 |
| --- | --- | --- |
| 訂單身分、幣別、應付總額、建立時間、保留期限 | `commerce_orders`（`order_profile='hosted_checkout'`） | 建立後整列不可改；`quote_id`、`reservation_*`、`closed_*` 為 NULL；`buyer_principal_id` 只在會員登入下單時填，guest 為 NULL；`external_id = chk:{checkout_id}:{client_order_id}` |
| 行項 | `commerce_order_lines`（`order_profile='hosted_checkout'`） | 建立後不可改；必有 `supplier_shop_id`；外部供貨行項必有 offer／acceptance／listing digest（與 shared 相同規則） |
| 訂單生命週期與版本 | 提議 sidecar `commerce_checkout_orders` | `(order_id, order_profile)` 複合 FK；tenant／instance、customer、checkout、凍結 terms 與 `terms_sha256`、`environment`（sandbox／live）、`lifecycle_state`、`version` |
| 買家 | 提議 `commerce_customers` | 屬於零售商店（tenant／instance），不是平台會員；可選連結會員 principal（只依已驗證的 Email，EC-SPEC-02 §4.1）；Email 只允許一次遮罩（EC-SPEC-09 §3） |
| 聯絡、收件、發票資料 | 提議 `commerce_checkout_contacts` | 個資獨立一表，以 checkout 為鍵；買家每次修改就新增一列，列不可改（只允許一次性遮罩，EC-SPEC-09）。訂單指向下單當下那一列，所以同一份資料不會複製到每張訂單。不進 journal、outbox、log 與分析；存取規則見 EC-SPEC-05／09 |
| 結帳草稿 | 提議 `commerce_checkouts` | 見 EC-SPEC-02；凍結的 terms 不含個資，`terms_sha256` 涵蓋聯絡資料那一列的摘要。一個 checkout 依序可產生多張訂單，但同時最多一張「未付款且付款結果未定」的訂單 |
| 付款套用紀錄 | 提議 `commerce_checkout_payment_applications` | 每個已驗證的付款事實套用到訂單一次（`payment_ref` 唯一）並記下結果（§5），重送回原結果；付款本身的權威在 EC-SPEC-04 |
| H | 現況 `commerce_inventory_reservations` | 沿用，不改表 |
| A | 提議 `commerce_inventory_allocations` | §2 |
| 異動紀錄 | 提議 `commerce_inventory_movements` | append-only |
| 付款、出貨、發票、退貨 | EC-SPEC-04／05／06 的表 | 各自是自己軸線的權威 |

`commerce_shops` 的 hosted `mode='test'`、`accepting_orders=false` 約束（`134:4`）不動；新交易是否開放由新的店家設定與 provider account 決定，不重用 imported 的 mode。

### 3.2 狀態軸線

訂單沒有一個裝下全部真相的 status（計畫 §9.1）。`commerce_checkout_orders.lifecycle_state` 只記「這張單還算不算數」：

| lifecycle | 意義 | 進入 |
| --- | --- | --- |
| `open` | 有效訂單 | 下單 |
| `cancelled` | 不再履行（附 `cancel_reason`） | 未付款取消、付款期限結束確認未付、已付未出貨經賣家同意取消（退款另走 refund） |
| `closed` | 所有行項已出貨或取消、無進行中退貨與退款、已過賣家設定的售後期限 | 賣家或排程結案 |

其他軸線各有權威，訂單畫面組合顯示，不回寫成單一欄位：

| 軸線 | 權威 | 摘要值（讀取時計算） |
| --- | --- | --- |
| 付款 | payment attempts／refunds（EC-SPEC-04） | `unpaid`、`pending`、`paid`、`partially_refunded`、`refunded`、`overpaid`、`simulated` |
| 庫存 | holds＋allocations | `held`、`hold_expired`、`allocated`、`partially_shipped`、`shipped`、`released`、`unallocated`（已付但無貨） |
| 履約 | fulfilment orders／shipments（EC-SPEC-05） | 每個 fulfilment order、每個包裹各自狀態 |
| 發票 | invoice documents（EC-SPEC-06） | 每張發票與折讓各自狀態 |
| 售後 | 售後申請（EC-SPEC-06 §2） | 每張申請的決定，加上實物、錢、發票各軸的進度 |

付款摘要的 `overpaid`：這筆訂單有一筆結果為 `overpaid`、`after_cancel` 或 `amount_mismatch` 的付款套用紀錄（§5，以下稱未套用的付款），而且還沒退完：完成的退款（`confirmed` 或 `recorded`，EC-SPEC-04 §7.2）合計小於那筆紀錄的金額。表示收到的錢和訂單不符，店家必須核對並退款。它優先於其他付款摘要值，包括已確認付款。買家看到「付款金額待店家確認」（EC-SPEC-01 §6.2）；之後才到的正確付款仍照 §5 套用。

未套用的付款全部退完後就不是 `overpaid`：有確認付款時是 `confirmed`；沒有確認付款、但有完成的退款時是 `refunded`。買家 DTO 的 `payment_state` 依序取第一個成立的：`overpaid`、`confirmed`（即上表的 `paid`）、`refunded`、`pending`、`simulated`、`unpaid`。訂單只要有任何一筆未套用的付款，不論退完與否，就不再提供付款或重新付款（`can_resume_payment` 為假）：那筆 attempt 已經收過錢，重新付款前的查詢不會得到「確定未付」（EC-SPEC-04 §4.3）。確認付款的退款與 `partially_refunded` 隨 M4 的售後退款定義（EC-SPEC-06 §2）。

需要高效查詢的待辦（例如「已過保留期且付款未定」）以這些表的索引查詢，不另存第二份狀態。若之後加摘要欄位，只能由同一個領域函式在同一交易內更新，並有測試比對。

### 3.3 轉換（全部經同一組領域 command）

| 轉換 | 誰觸發 | 守門 | 效果（同一 DB 交易） |
| --- | --- | --- | --- |
| place | 買家（guest 或會員）＋checkout 能力憑證 | 店家已開通交易、checkout 版本與 `terms_sha256` 相符、供貨同意與發布版本有效、配送群組可行、`available` 足夠、同 checkout 無未定付款的舊單 | 建立訂單、行項、sidecar（指向當下的聯絡資料列）、全部 hold、第一個 payment attempt（EC-SPEC-04）；journal；不呼叫外部服務 |
| buyer cancel（未付） | 買家 | `open` 且無確認付款（§5 的定義；`simulated`、`amount_mismatch` 等紀錄不算確認付款，所以付款摘要是 `simulated` 或只因這些紀錄成為 `overpaid` 時仍可取消） | hold release；`cancelled(buyer_cancelled)`；撤銷還沒用掉的交接連結，已交接且仍未結的 attempt 排入查詢（晚到的付款照 §5.3 記 `paid_after_cancel`） |
| seller cancel（未付） | 賣家 owner／被授權者 | 同上 | `cancelled(seller_cancelled)`；attempt 的處理同 buyer cancel |
| hold expire | 讀取、下單缺額結算、排程 | hold 仍 `held` 且 DB 時間 ≥ `expires_at` | hold release；訂單仍 `open`（付款可能晚到） |
| payment confirmed | 已驗證的 provider 事件或查詢結果（EC-SPEC-04） | 金額、商家、環境、交易識別相符；非模擬 | 若 hold 仍 `held` → convert；否則 → allocate 或例外；成功後建立 fulfilment orders（EC-SPEC-05） |
| payment window end | 排程 | `open`、無確認付款、所有 attempt 都是 `failed` 或 `expired_unpaid`（EC-SPEC-04 §3.3、§6.2） | `cancelled(payment_not_completed)`；若 attempt 仍未知，繼續查詢，不取消（EC-SPEC-04 §6.3） |
| cancel paid（未出貨） | 買家申請＋賣家同意，或賣家主動（EC-SPEC-06 §2.4） | 已確認付款、該行項沒有已交寄的量 | 有配置就 allocation release（`paid_unallocatable` 沒有配置）；`cancelled(…)` 只在全部行項不出貨時；退款另建 refund，不視為已退 |
| ship | shipment 交寄證據 | 包裹行項 ≤ 剩餘配置 | 每個 (shipment, allocation) 一筆 movement：N、A 同減 |
| close | 賣家／排程 | §3.2 條件 | `closed` |

「已付款」只來自 server 端已驗證事件或查詢（EC-SPEC-04）；瀏覽器返回頁不觸發任何轉換。

## 4. 下單、保留與付款期限

### 4.1 下單

一次交易內：鎖序 §6 → 重新計算 checkout terms 並比對 `terms_sha256` → 依缺額結算過期的 hold（沿用 `expireDirectForItems` 的有界做法，擴充到 `hosted_checkout`）→ 鎖定全部 item（UUID 排序）→ 檢查每個 item `available ≥ q` → 建立訂單、行項、sidecar、hold、attempt、journal → commit。任何一項不足，整筆回滾，回 409 並附目前可售數量的提示，不保留部分行項。

### 4.2 保留期限與付款期限

- hold 30 分鐘（現況 CHECK）。保留期間內的再付款沿用同一訂單、同一 hold，只有前一 attempt 確定沒有付款（已驗證的失敗，或交接 60 秒後當場查詢顯示未付）才建立新 attempt；結果不明時不建立（EC-SPEC-04 §4.3）。
- 每個付款 profile 宣告 `confirmation_window`（provider 可能在多久之後才確認付款）。保留期過後、付款期限結束前，訂單 `open`、沒有庫存；之後查詢確認未付才取消。
- ATM／超商代碼／COD 這類長效付款不使用 30 分鐘 hold；在定義長效配置與取消政策之前不開放（DC05）。銀行匯款與面交付款的長效保留、晚付與取消見 EC-SPEC-11 §3.2、§5；它們沒有 payment attempt。

### 4.3 保留期過後要再付款

不重新 hold 舊單（每個 (order,item) 只有一筆 hold）。checkout 保留購物車、聯絡與配送資料，買家確認目前價格與庫存後從同一 checkout 重新下單；前一張單的付款結果必須先確定（未定時顯示「前一筆付款結果確認中」並提供查詢），避免兩張單都付款。

## 5. 付款確認後的庫存處理

付款模組（EC-SPEC-04）在驗證 provider 事件或查詢結果的同一個交易內呼叫庫存套用；每個付款事實以 `payment_ref` 在 `commerce_checkout_payment_applications` 記一次結果（`converted`、`allocated`、`unallocatable`、`after_cancel`、`overpaid`、`amount_mismatch`、`simulated`）。同一 `payment_ref` 重送直接回原結果，不再動庫存；不同 `payment_ref` 套到已有確認付款的訂單記為 `overpaid`。

「確認付款」只指結果為 `converted`、`allocated` 或 `unallocatable` 的套用紀錄。`simulated`、`amount_mismatch`、`after_cancel`、`overpaid` 都不算：金額不符之後買家再付正確金額，照常 convert 或 allocate；只有這些紀錄的訂單仍可依未付款取消，也仍算「付款結果未定」的舊單（§4.3）。未付款取消、已付款取消、`overpaid` 與 §4.3 的檢查都用這同一個定義。

### 5.1 正常（hold 仍有效）

convert：每筆 hold 改 `released`，建立同量配置並記 `source_reservation_id` 與付款 attempt。reserved 不變，任何其他買家看到的 `available` 不變。

### 5.2 hold 已到期但尚未被結算

hold 只要在決策當下仍是 `held`，代表那些件數從未釋放給別人，可以直接 convert（結果等同「釋放後立刻重新配置」且必定有貨）。結算與付款確認取相同的鎖，先提交者勝。

訂單的任一 attempt 有已驗證、尚未套用的 `paid` 通知事件時（例如隔離期間延後的事件），到期結算與排程的釋放都略過這張訂單的 hold，等付款事件套用（EC-SPEC-04 §5.4、EC-SPEC-10 §8.3）。否則買家準時付了款，卻因為套用延後而被當成晚到付款，貨被別人買走後只能退款。

### 5.3 晚到付款（hold 已釋放）

1. 先持久記錄付款事實（EC-SPEC-04），永不因庫存不足而丟棄。
2. 訂單 `open`：整張訂單每個 item `available ≥ q` → allocate（movement `allocate`）→ 進履約。
3. 任一 item 不足 → 不配置任何 item（不做部分配置），建立例外 `paid_unallocatable`（EC-SPEC-05 ExceptionCase），賣家可選：補庫存後配置、或取消並退款（沒有配置可釋放，直接 `cancelled(paid_cancelled)`，退款另建）。畫面顯示「已付款，等待配貨」，不顯示已出貨或缺貨取消。
4. 訂單已 `cancelled`（買家先取消後仍完成付款）→ 例外 `paid_after_cancel`，必須退款；v1 不重新開啟已取消訂單。
5. 同一訂單第二筆確認付款 → `overpaid` 例外，退款多付的 attempt；不悄悄忽略。

### 5.4 模擬付款

`SimulatePaid=1`（或任何 provider 的模擬旗標）記為 `simulated`，不 convert、不 allocate、不建立履約、不計入實收；sandbox 環境以真實 sandbox 付款驗證流程（EC-SPEC-04）。

## 6. 鎖序與競態

沿用現況鎖序（§1.1），新路徑的位置：

1. 呼叫者：會員 session／scope、guest 的 checkout 或訂單存取憑證、賣家 tenant scope；機器路徑（provider callback、查詢、排程）沒有會員身分。
2. 賣家（及所有供貨方）tenant／instance／deployment 生命週期鎖，依 (tenant_id, instance_id) 排序，全部在 community 鎖**之前**取得（同 `shared-authority.ts:20-68`）。機器路徑只處理既有訂單，不新增商務關係，可略過生命週期鎖，但不得在 community 鎖之後再取任何 instance 鎖。
3. `commerce-orders/{community_id}` advisory lock。
4. profile → checkout／sidecar → `commerce_orders` → 售後申請（UUID 排序）→ payment attempt → 退款 → 發票文件 → 履約單 → shipment（UUID 排序）→ hold／allocation 列 → item（UUID 排序）。退款在 M2、履約單與 shipment 在 M3（EC-SPEC-05 §5.5）、售後申請與發票文件在 M4（EC-SPEC-06 §9）才出現；較早的程式沒有這幾層，順序不受影響。
5. 外部 I/O 一律在交易提交之後（outbox／durable attempt，EC-SPEC-04／05）。

必測競態：同一 hold 的付款確認與到期結算；買家取消與付款確認；兩個重複的 provider 通知；交寄事件重送；兩個賣家同時下單同一供貨商品（10 件、6＋5）；人工改庫存與下單；退件驗收重送。

community 層級序列化保留（與 #437 相同），不宣稱吞吐量提升；之後若需要改成 item 層級，必須另立 spec。

## 7. Migration 與相容（expand／backfill／switch）

編號在整合當下依 main 決定（以下以 M1、M2… 稱呼）；162 及之前的 migration 檔案不修改。

**M1（訂單與庫存核心，expand）**

- `commerce_orders`：`order_profile` CHECK 加 `hosted_checkout`；`commerce_order_profile_fields` 加 `hosted_checkout` 分支（`quote_id`、`reservation_*`、`closed_*` 為 NULL，`client_order_id` 非 NULL，`buyer_payment='pending'`，`expires_at=created_at+30 分`）；`preserve_commerce_order_profile()` 對 `hosted_checkout` 整列不可改。
- `commerce_order_lines`：profile CHECK 加 `hosted_checkout` 分支；新增 checkout 行項核對 trigger（行項必須等於 sidecar 凍結 terms 的對應 binding）。
- 新表：`commerce_customers`、`commerce_checkouts`、`commerce_checkout_contacts`、`commerce_checkout_orders`、`commerce_checkout_payment_applications`、`commerce_inventory_allocations`、`commerce_inventory_movements`，含 RLS（或在 `modules/module-data/catalog.ts` 明列豁免理由；個資表不豁免）、不可刪 trigger、monotonic trigger、索引。瀏覽器憑證與訂單存取 grant 的表（EC-SPEC-02 §4.2）、付款表（EC-SPEC-04）由各自的 migration 加入。
- 以 `CREATE OR REPLACE` 更新 `check_commerce_inventory_balance`（`reserved = H + A`）與 `check_commerce_inventory_order`（加 `hosted_checkout` 分支：hold＋配置＝行項）；加配置表的 deferred constraint trigger。
- 不開任何店的交易；店家交易設定預設關（EC-SPEC-02／10）。
- runtime grants 需重跑（新表）；`20-runtime-grants` 與 inventory JSON 依「新增 migration 檢查清單」（WP-00）。

**Backfill**：不需要。現有資料沒有配置，`reserved = H` 已成立，等於 `reserved = H + 0`；migration 結尾仍對所有 hosted item／訂單執行新的檢查，不一致就中止，不製造庫存。

**Switch**：新增 release-compatibility 能力 `commerce.hosted-checkout.v1`。`deploy/cloudflare/lib/release-compatibility.mjs` 沒有 `writerFloor`／`minSchemaVersion` 這類欄位；實際要改的是：`CAPABILITIES` 白名單、`SHAPES` 加一個 shape、「schema ≥ 該 migration 時不論旗標都必須具備此能力」的強制下限（同 162 對 `commerce.hosted-inventory-reservation.v1` 的做法，`:535`）、只留能力時的 retained floor（`:550`），以及所有列舉 `required_capabilities` 的部署測試。M1 本身沒有任何會寫入 `hosted_checkout` 訂單的路徑，所以 M1 只登錄 `FOUNDATION_NAMES`；能力與強制下限跟「第一個能寫入 `hosted_checkout` 訂單的路由」（EC-SPEC-02 §5.4 的下單 API）同一個 migration 加入，且一定早於任何店家能開通結帳。此後所有 active／candidate release 都必須具備此能力；關閉新結帳不移除這個下限。`apps/platform-api/src/readiness.ts` 不讀 migration ledger，readiness 綠燈不能證明 M1 已套用。

**新增 migration 的登錄點**（以 `fe4e083a` 為範例）：`deploy/cloudflare/environments.json` 的 `migrations.last`；`FOUNDATION_NAMES`；`deploy/cloudflare/test/migration-plan.test.mjs` 的 `last` 與最後檔名；`release-compatibility.test.mjs` 中以「最後一筆是 167」為前提的兩個測試改指 `prefix(scan, 167)` 並為 M1 加同樣的一組；`docs/platform-plan/execution/guild-launchpad/README.md` 的 `repo_max_migration`（`validate-spec-pack.py --write-status`）；新表加進 `modules/module-data/catalog.ts` 的 physical locations（含 tenant 解析、RLS／豁免理由、敏感度、保留）。`modules/agent-commerce/freedom.module.json` 已列滿 64 個 owned path（schema 上限），所以交易核心另立 `modules/agent-commerce/checkout/freedom.module.json`（module `hosted-checkout`，相依 `agent-commerce`），由它擁有 `modules/agent-commerce/checkout/**`、M1 與新測試。套用後重跑 `deploy/cloudflare/sql/20-runtime-grants.psql`；最後才跑 `scripts/update-inventory.py`。

**舊 binary**：M1 之後，不懂配置的舊 writer 對 v1 profile 仍然安全（它們只動 hold，`reserved = H + A` 仍成立；它們的 `available` 已經扣掉 A）。但舊 binary 不會處理付款通知、到期或出貨，所以有 `hosted_checkout` 訂單之後不能回退到它（停止新結帳、切相容版本或向前修補，計畫 §18.3）。T-047 限制照舊適用。

## 8. 共用讀取

- 規範公式不變：`available = stock − reserved`。
- 提議在 `modules/agent-commerce/hosted/inventory.ts` 新增 `inventoryPositions(q, itemIds)`：回傳每個 item 的 `stock / held / allocated / available`，並檢查 `reserved = held + allocated`（不符回 409 `reservation_inconsistent`）。Seller Console、供應商出貨頁與新 DTO 用它顯示分項；完成後把函式名稱與 commit 告知供應商 session。
- 舊 `ReservationInventory` 介面保留；新增 `convert`、`allocate`、`releaseAllocation`、`ship`、`restock` 五個操作，都在 SQL 內檢查餘額並寫 movement，不接受呼叫端給的 shop／tenant 權威。

## 9. 測試（全部 not_run）

| 案例 | 驗收 |
| --- | --- |
| 舊 v1 direct／shared 全部既有測試不改仍過；舊 wire 與 hold ID 保留；新交易不寫 v1 literal | EC-AT26、64 |
| A 庫存 10，B／C 同時 6＋5 下單 → 只成功一張；成功者付款後配置，`reserved` 不變；另一張重新下單仍受 `available=4` 限制 | EC-AT29 |
| 已付款配置不被 v1 到期、checkout 到期、取消競態釋放 | EC-AT27 |
| 出貨 2／5：N、A 各只減 2；同一交寄事件重送不再扣；剩 3 仍占用 | EC-AT28 |
| 印單、建單不改 N | EC-AT39 |
| 晚到付款有貨 → 重新配置；無貨 → `paid_unallocatable`，不出現負庫存 | EC-AT30、31 |
| 退件到達不加 N；驗收合格 1 件只加一次；退款不加 N | EC-AT42 |
| 舊式只改 `reserved` 的 SQL 被 23514 拒絕並整筆回滾（沿用 #441 手法） | EC-AT64 |
| 價格／發布／供貨同意在 placement 前變更 → 409，不以前端金額下單 | EC-AT07、08 |
| 撤權、session 到期、店家暫停跨越等待點 → 新動作拒絕，既有付款仍可處理 | EC-AT50 |

測試用隔離 PostgreSQL 與 barrier／DB 時鐘，不用 sleep；不用假的 provider 成功事件代替 EC-SPEC-04 的已驗證通知。

要延伸、不可弄壞的既有測試：`tests/runtime/hosted-direct-orders.test.ts`（含第 205 行「10 件、同時 6＋5」、162 backfill 與不一致中止、未追蹤 writer 被 deferred 檢查拒絕）、`hosted-shared-orders.test.ts`（第 86 行 A／B／C 並行 6＋5）、`hosted-seller-orders.test.ts`、`hosted-order-http.test.ts`、`hosted-order-contracts.test.ts`（拒絕 paid／shipped、拒絕買家身分欄位）、`agent-commerce.test.ts`（imported 舊流程）、`hosted-store.test.ts`（庫存下限）、`tenant-data-catalog.test.ts`（新表必須登錄）、`deploy/cloudflare/test/release-shared-reservations.test.mjs`（在加入能力 `commerce.hosted-checkout.v1` 的那個 migration——第一個能寫入 `hosted_checkout` 訂單的路由，§7——加 retained floor 反例；M1 本身不加能力）；瀏覽器端 `tests/e2e/hosted-shared-orders.spec.ts:136`（同時點擊 6＋5）。這些既有 6＋5 測試只證明 v1 hold，不證明配置、交寄或還原安全，新案例另寫。

## 10. 仍待決與影響範圍

| 項目 | 建議 | 只影響 |
| --- | --- | --- |
| DC05 長效付款 | C2 只開即時信用卡 | ATM／代碼／COD |
| DC08 guest checkout | 允許（EC-SPEC-02 定案存取憑證） | `buyer_principal_id` 可 NULL 與 customer 模型 |
| 部分配置 | v1 不做（整單配置或例外） | 晚到付款且部分有貨的情境 |
| 實體盤虧（實際少於 reserved） | v1 由賣家先取消／退款再改庫存 | 庫存修正流程；之後可加「盤虧」命令 |
| community 序列化 | 保留 | 高併發；需另立 spec |
| 從 v1 預留轉成新交易 | 初版不提供（計畫 §9.3 允許） | 舊預留買家要重新下單 |
