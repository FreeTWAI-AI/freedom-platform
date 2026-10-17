# 頁面對照：B01～B10、E01～E11、SL-01～05

每頁列出：現況（以 `efaf314d` 讀回的實際程式）、目標操作、資料與 API（既有／新增提議）、權限、主要錯誤與空狀態、里程碑。新增 API 與欄位名稱是提議，定案以 EC-SPEC-02～06 的契約為準。視覺、狀態語言與可存取性的共同規則在 [EC-SPEC-01](EC-SPEC-01-product-visual.md)。

現況判定：`exists`＝可直接沿用；`partial`＝有基礎、缺主要能力；`missing`＝沒有對應頁面。

## 2026-10-17 後續實作觀察

下表保留 `efaf314d` 的原需求盤點。最新 source 與驗證層級見
[work-plan 的 #863 合併與離線買家頁紀錄](work-plan.md#2026-10-17-863-合併與離線買家頁補齊)。
`1ae0d0a4` 已包含 B04、B06、B07／B10 與離線後端；後續買家頁補齊 B05 的聯絡人、
配送報價、付款方式、凍結確認，以及 B07 的匯款／面交說明、期限與未付款取消。
超商選店、發票、逐包履約與完整售後仍待完成；本機合成驗證不代表正式啟用或真人驗收。

## 共同前提

- **公開店面**：`/shops/:slug`、`/shops/:slug/products/:sku` 是 server 產生的 HTML（`modules/agent-commerce/hosted/page.ts:42,58`，路由在 `apps/platform-api/src/routes/hosted-store.ts:130,136`），只連 `/shops.css`；JSON 投影在 `GET /api/v1/public/stores/:slug`（`hosted-store.ts:124`）。不經過 React portal，匿名可讀。
- **登入牆**：目前任何「預留」都要先登入工坊會員。商品頁按鈕連到 `/#reservations/:slug/product/:sku`（`page.ts:13,63`），`App.tsx:317` 在沒有 session 時直接顯示登入頁，而且登入後不會回到原本的商品（`LoginView` 只保留 `#join/*` 與活動的 `return_to`）。
- **v1 預留**：買家流程在 `apps/portal-web/src/modules/HostedOrder.tsx`（路由文法在 `hosted-order-state.ts:9-20`），頁首固定「僅預留 30 分鐘，尚未付款，不會安排出貨。運費未設定，稅額未評估。」（`HostedOrder.tsx:11`）。這條流程保留，不改語意（EC-SPEC-03 §3）。
- **買家頁的位置**：B 頁面不放進 portal 的 `app-frame`。`shops.css` 直接改 `body` 與 `:root`（`shops.css:1-17`），portal 的 `rpg-theme.css:2` 也直接改 `input/select/textarea`，兩邊混用會互相污染。新的購物車、結帳、付款返回與訂單頁放在 `/shops/:slug/...` 之下的獨立頁面（server HTML＋只屬於店面的小型 client bundle），樣式只用店面自己的變數（EC-SPEC-01 §4）。
- **賣家頁的位置**：E 頁面在既有 `stores` 分頁之下：`#stores/<tenant>/<instance>/<page>`；供貨頁在 `…/supply/…`（Supplier Console，SC-SPEC-01）。不新增全站 TabId。側欄殼沿用 Supplier Console 的做法（一份項目資料、桌面側欄、窄螢幕 `<select>`），殼的元件與 `HostedStore()` 路由分派由 Supplier Console 工作階段負責，Commerce 只加賣家頁的項目與頁面。
- **權限**：今天 storefront 模組只有 `store:manage`、`store:read`、`store:write`、`store:publish`（`modules/module-registry/definitions.ts:75`，DB 端在 `migrations/134_hosted_storefronts.sql:88`）。訂單、收款、出貨、退款等需要新的能力名稱與新的模組版本 `storefront@1.1.0`（EC-SPEC-09 §2.2、§2.3）；下表的能力名稱依 EC-SPEC-09 §2.2。

## 買家頁（B）

| 頁面 | 現況 | 目標操作 | 資料／API | 權限 | 錯誤與空狀態 | 里程碑 |
| --- | --- | --- | --- | --- | --- | --- |
| **B01 店首頁／品牌** | `partial`：`storeHtml`（`page.ts:42`）顯示品牌眉標、店名、介紹、商品卡；封面取第一張商品照，沒有就用平台圖（`page.ts:33,46`） | 封面、品牌、主打商品、分類入口、明確導購；平台限制說明不佔首屏 | 既有：`readPublicStorePage`、`GET /api/v1/public/stores/:slug`。新增：店面外觀（封面、主打、分類、主色 token）隨發布版本凍結（EC-SPEC-02 §2） | 匿名 | 停止公開或不存在→404 頁並給平台首頁連結；沒有商品→「這間店正在準備商品」 | C1 |
| **B02 商品清單／搜尋** | `partial`：同一頁平鋪全部商品（格狀或直列，`page.ts:56`），無搜尋、分類、分頁 | 搜尋、分類篩選、排序、分頁；返回時保留條件與捲動 | 新增：`GET /api/v1/public/stores/:slug/products?q=&category=&cursor=`（發布版本內查詢）；條件放 query string，可分享 | 匿名 | 無結果→說明條件並提供清除；讀取失敗不顯示「0 件」 | C1 |
| **B03 商品詳情** | `partial`：`productHtml`（`page.ts:58`）一張照片、價格、介紹、「登入確認預留條件」 | 圖組、規格／變體、數量、可售狀態、配送與退貨說明、加入購物車 | 既有：單 SKU、一張 WebP（`migrations/141_storefront_product_photos.sql`：≤1 MiB、≤1920px）。新增：variant、多張照片、配送說明、政策連結（EC-SPEC-02 §1） | 匿名 | 售完→「目前沒有可售數量」且不給加入；不存在或下架→404（既有 `storefront-product.spec.ts` 已涵蓋） | C1（變體 C1，配送說明 C2） |
| **B04 購物車** | `partial`：只有登入後的 30 分鐘預留「查看預留內容」（`HostedOrder.tsx:177-187`） | 同一店的購物車：修改、移除、回到商品；小計、折扣、運費、總額各有來源 | 新增：瀏覽器端購物車（每店一份，只存 SKU、數量、發布版本）；`POST /api/v1/public/stores/:slug/cart-quotes` 由 server 計價、不保存、不占庫存 | 匿名 | 價格或可售量變動→逐行標示並要求確認；商品下架→移出並說明 | C1（運費、折扣顯示 C2） |
| **B05 結帳** | `missing`：只有「確認預留 30 分鐘」按鈕 | 聯絡人與收件、宅配地址或超商門市、配送群組與運費、付款方式、發票資料、必要同意、最終確認 | 新增：`POST /api/v1/public/stores/:slug/checkouts`（Idempotency-Key）凍結報價；`POST …/checkouts/:id/orders` 建立 `hosted_checkout` 訂單與預留（EC-SPEC-03 §4） | 匿名（guest）或會員；結帳後以私有存取憑證操作 | 欄位錯誤在欄位旁保留輸入；配送不可行→收款前擋下（EC-AT12）；報價過期→重新確認 | C2 |
| **B06 待付款／付款返回** | `missing`：只有 v1 預留的「結果不確定」恢復（`HostedOrder.tsx:120,157-158`） | 依 server 狀態顯示待付款、已確認、失敗、未知；未知時查詢；確定沒有付款才可續付（EC-SPEC-04 §4.3） | 新增：`POST …/orders/:order_ref/payment-handoffs`（交接前重發同一 attempt 的交接連結）與重新付款（新 attempt，EC-SPEC-04 §4.3）都回傳 `handoff_url`，交接頁 `/pay/ecpay/{token}` 由伺服器產生並自動送出表單；返回頁 `/shops/:slug/payment-return/:attempt_ref` 只觸發查詢；`GET …/orders/:order_ref` | 訂單存取憑證或會員本人 | 返回頁永遠不直接顯示「付款成功」，直到 server 確認（EC-AT18）；未知不允許新 attempt（J04） | C2 |
| **B07 訂單與包裹** | `partial`：只有 v1 預留清單與明細（`#reservations`、`#reservations/order/:id`） | 每筆訂單的付款、每個包裹、發票各自顯示；包裹需要時重新選店或更正宅配地址 | 新增：`GET …/orders/:id`（付款、庫存、履約、發票、售後各一個軸）；會員另有 `GET /api/v1/me/orders`；`…/shipments/:sid/cvs-selection`、`…/address-correction`（EC-SPEC-05 §7.3～7.4、§9.3） | 同 B06 | 部分出貨→逐包顯示，不說成全部完成（EC-AT34） | C2 |
| **B08 取消／退貨／退款** | `missing`：只有未付款預留的「取消預留」 | 未付款取消；已付款申請取消、退貨或只退款（行項、數量、理由）；核准後看到退回地址並填寄回單號；查看各軸進度；與店家對話 | 新增：`POST …/orders/:id/cancel`（未付款）、`POST …/orders/:id/aftersales-requests`、`…/return-shipment`、`GET／POST …/orders/:id/messages`；退款金額由賣家決定（EC-SPEC-06 §2） | 同 B06 | 畫面不自行宣稱「已退款」；顯示仍在處理的軸 | C2 |
| **B09 品牌／政策／聯絡** | `partial`：只有品牌、介紹與平台說明 | 賣方身分與聯絡方式、配送、退換貨、隱私等政策頁；結帳保存當時版本 | 新增：店家政策（有版本、隨發布凍結）與賣方揭露欄位（EC-SPEC-02 §2、EC-SPEC-06 §4） | 匿名 | 政策未填→該店不能開放結帳（C2 啟用條件） | C1 顯示、C2 必填 |
| **B10 顧客安全返回** | `missing`：查詢預留要登入且只能查自己的 | guest 用訂單連結回到訂單；遺失連結時以 Email＋訂單編號重寄；可選擇關聯到會員帳號 | 新增：訂單存取憑證（高熵、雜湊保存、可撤銷）；`POST /api/v1/public/stores/:slug/order-access-requests` 一律回 202（EC-SPEC-02 §4） | 匿名＋憑證 | 猜訂單編號讀不到（EC-AT05）；不自動建立會員 | C2（寄信需要寄送授權） |

## 賣家頁（E，Seller Console）

| 頁面 | 現況 | 目標操作 | 資料／API | 權限（現有／新能力提議） | 錯誤與空狀態 | 里程碑 |
| --- | --- | --- | --- | --- | --- | --- |
| **E01 公會啟動／我的商店** | `exists`：`LegacyLaunchpadPrimary`、`MyStoreAction`（`MyStoreAction.tsx:42`）、`StoreList`（`HostedStore.tsx:77`）、`LaunchFlow`（`GuildLaunchpadApplications.tsx`，已有商店時不能另建，`:693,699`） | 建立／沿用商店；另外兩個入口「閱讀／下載原作技能書」「下載可自行部署的營業版本」，後者只有發行物真的可用才顯示下載 | 既有：`GET /me/stores`、`POST /tenants/:id/application-launch-plans`、`…/application-installations`。新增：入口讀取技能書與可攜發行物的關係（EC-SPEC-07 §3） | 會員；建立需要事業 owner | 營業版尚未發行→說明狀態，不連到原作冒充 | C1（營業版入口 C3） |
| **E02 營運概覽** | `missing`：只有說明文字「已開放 30 分鐘庫存預留；付款與出貨尚未啟用。」（`HostedStore.tsx:240`） | 待付款例外、待出貨、待處理退貨、provider 異常、資料時間 | 新增：`GET /api/v1/tenants/:t/storefronts/:i/overview`（同一 snapshot、`ready`／`unavailable`＋原因） | `store:read`；數字依各能力裁切 | 讀取失敗顯示「無法取得」，不顯示 0 | C2 |
| **E03 品牌與版面** | `partial`：店名、品牌、網址、介紹、幣別；兩種版型（`catalog-grid-v1`／`catalog-list-v1`，`contracts/guild-launchpad/v1/storefront-presentation.ts:6`）；預覽、發布、停止公開（`HostedStore.tsx:282-309`） | 封面、分類、主打商品、受控主色、政策頁；草稿→預覽→發布 | 既有：`PATCH …/appearance`、`GET …/preview`、`POST …/publish`、`…/unpublish`。新增：外觀欄位與政策（EC-SPEC-02 §2） | `store:write`、`store:publish` | 草稿未存不能發布（既有）；網址發布後鎖定（既有 `slug_locked`） | C1 |
| **E04 商品與選品** | `partial`：商品表單（名稱、價格、庫存、介紹）、一張照片、供貨條件、合作（`HostedStore.tsx:256-281`、`HostedDistribution.tsx`） | 變體、多張照片、分類、庫存來源（自有／供應）、售價、供貨授權狀態 | 既有：`…/products` CRUD、`…/products/:pid/photo`、供貨 offer／selection。新增：variant 與分類（EC-SPEC-02 §1） | `store:write` | 庫存不得低於已占用量（既有 409 `stock_below_reserved`）；供貨撤回→該商品停止接單並說明 | C1 |
| **E05 訂單詳情** | `partial`：v1 預留清單與明細、取消（`HostedSellerOrders.tsx`、`HostedSupplierOrders.tsx`；入口先探測 `…/reservations?limit=1` 成功才顯示） | 同一頁看訂單、付款、配置、履約、發票、售後；下一個合法操作 | 新增：`GET …/checkout-orders`、`GET …/checkout-orders/:id`、`GET …/checkout-orders/:id/contact`（聯絡卡；訂單本身只帶遮罩的姓名）、`POST …/checkout-orders/:id/cancel`（未付款）、`POST …/checkout-orders/:id/payment-queries`（立即查詢）、`GET …/exception-cases?view=retailer`、`GET …/exception-cases/:id`、`POST …/exception-cases/:id/actions/:action`（EC-SPEC-05 §9.1，付款種類的動作見 EC-SPEC-04 §5.6；`…/orders` 已是 v1 直接預留的賣家路徑，`hosted-orders.ts:72`）；v1 `…/reservations` 照舊 | `store:orders:read`；取消、付款例外的處理、售後與對話回覆另需 `store:orders:manage`；聯絡卡需要 `store:customers:read`；付款明細與退款需要 `store:finance:read` | 每個軸各自的未知／失敗；不以單一 paid 字樣代表全部完成 | C2 |
| **E06 出貨與包裹** | `missing`（舊 `CommercePanels.tsx:112` 只有說明文字） | 查看已自動指派的履約單（自有商品自出貨；供貨商品由代出貨同意的供應商出貨，EC-SPEC-05 §4.1）、處理供應商的無法履約回報（等候改期或取消退款）、自出貨時建立包裹、物流單、列印、交寄；貨態、配送例外 | 新增：履約單／Shipment 命令與讀取（EC-SPEC-05 §4～7） | `store:fulfil` | 建單未知→先查詢；列印不等於交寄 | C2 |
| **E07 客戶與客服** | `missing` | 本店顧客、訂單聯絡紀錄、售後工單 | 新增：`GET …/customers`、`…/support-threads`、`…/aftersales-requests`（EC-SPEC-06 §2） | `store:customers:read`；回覆與售後決定另需 `store:orders:manage` | 不顯示他店顧客；地址只在需要的訂單頁出現 | C2 |
| **E08 優惠與推廣** | `missing`（只有複製商店／商品連結，`HostedStore.tsx:195`） | 有界優惠（固定金額或百分比、期間、上限）、分享連結與預覽 | 新增：`…/promotions`（EC-SPEC-02 §3），結帳時凍結分攤 | `store:write` | 優惠不得暗改供貨價；不自動對外發文 | C2 基礎、C4 擴充 |
| **E09 收款／退款／對帳** | `missing`（只有「店鋪／商品展示已就緒，交易尚未啟用」，`HostedStore.tsx:29`） | 收款帳戶狀態、付款 attempt、退款申請與進度、差異清單；付給供應商的帳（核對、登錄付款） | 新增：`…/provider-accounts` 的付款服務（金鑰只寫不讀，EC-SPEC-04 §1）、`…/checkout-orders/:id/refunds`、`…/reconciliation`（EC-SPEC-04 §7～8）、`…/settlement-statements?role=payer`（EC-SPEC-06 §5、§8.2） | 讀取 `store:finance:read`；退款另需 `store:refund`、供貨帳的操作需要 `store:settlements`；收款帳戶與金鑰只有 owner／admin，並要重新輸入密碼 | 不是平台錢包；未確認的退款不顯示完成 | C2 |
| **E10 發票與報表** | `missing` | 發票設定、開立、查詢、更正（作廢、折讓、重開）；營運與配送報表 | 新增：`…/invoice-settings`、`…/invoices`、`…/invoice-corrections`（EC-SPEC-06 §3）、`…/reports`（EC-SPEC-06 §6） | 讀取 `store:finance:read`；發票設定與更正 `store:invoices`；報表 `store:read` | 報表不跨幣別相加；不含個資 | C2 |
| **E11 設定／團隊／帶走商店** | `partial`：商店資料（`HostedStore.tsx:316-369`）；團隊與 owner 轉移在 `TenantSettings.tsx` | 配送政策、provider 帳戶、政策頁、資料匯出、營業版下載與連回設定 | 新增：`…/shipping-profile`、`…/ship-from-locations`、`…/provider-accounts`（EC-SPEC-05 §2、EC-SPEC-04 §1）、`…/exports`（EC-SPEC-08 §4） | `store:manage`；provider 帳戶與金鑰只有 owner／admin，匯出只有 owner，都要重新輸入密碼（EC-SPEC-09 §2.2） | 匯出不含秘密與他人資料 | C2（帶走商店 C3） |

## 供應商履約頁（SL，由 Supplier Console 實作）

頁面規格在 `docs/platform-plan/execution/supplier-console/SC-SPEC-07-fulfilment.md`（commit `c876b891`，Supplier Console 分支）。Commerce 提供以下契約，SL 頁面只讀供應商用途投影、寫入只呼叫共同命令：

| 頁面 | Commerce 提供 | 對應賣家頁 |
| --- | --- | --- |
| SL-01 履約與寄件設定 | ShipFromLocation、退回地址、可用物流服務、作業日、代出貨方案（`drop_ship`，公開投影不含地址）、商品配送屬性、代出貨同意（有版本）的命令與讀取（EC-SPEC-05 §2） | E11 |
| SL-02 出貨工作台 | 七個分頁（待確認、備貨中、待印單、待交寄、例外、已回報無法履約、歷史）與同一 snapshot 的計數；SC-03 概覽的四個指標；接受、回報無法履約（原因代碼）與撤回；最小收件資料讀取（EC-SPEC-05 §4、§9.2） | E05、E06 |
| SL-03 包裹與託運單 | Shipment 建立／查詢／重印／交寄、標籤短效讀取、貨態事件（EC-SPEC-05 §5～6）；建單被拒時請買家重新選店或更正地址（§7.3～7.4） | E06 |
| SL-04 例外與退回 | ExceptionCase（`view=executor` 與出貨者動作）、退回包裹與詳情、退件檢驗（可再售／不可售）與回庫（EC-SPEC-05 §7～8；回庫對庫存的影響在 EC-SPEC-03 §2.1） | E05、E06、E09 |
| SL-05 費用與交易文件 | 帳目、對帳單清單與明細（依付款天數分張；狀態與中文見 EC-SPEC-06 §5.4）、雙方同意的調整、付款證據與「確認收到」；欄位白名單（EC-SPEC-06 §5.5、§8.3） | E09、E10 |

## 現有測試要保護的介面

改動 B／E 頁面時，以下既有瀏覽器測試的角色名稱、標籤與數量斷言要維持（完整清單在 inv-ui 盤點，見 [sources.md](sources.md)）：`tests/e2e/hosted-store.spec.ts`（建立、發布、版型、複製連結）、`hosted-order.spec.ts`（HO-UI01～03、買家清單分頁）、`hosted-seller-order.spec.ts`（HO-SUI01～04）、`storefront-product.spec.ts`（公開商品頁、OG、noindex、下架不能預留）、`hosted-shared-orders.spec.ts`、`hosted-supply-catalog.spec.ts`、`hosted-supply-terms.spec.ts`。
