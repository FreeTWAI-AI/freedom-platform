# EC-SPEC-05 履約與物流：出貨責任、配送群組、選店、Shipment、標籤、貨態、例外與退回

需求：EC-R03、R04、R12、R14、R15、R19、R20、R26、R28、R31～R40、R53；Supplier v1.1 的 SC-L01～L18。驗收：EC-AT10～12、27、28、33～44、60、68；SC-LAT01～24（頁面部分見 SC-SPEC-07）。

本文件是 C2 履約與物流的設計，基準 `efaf314d`。綠界物流的協定事實取自官方開發者文件，經本機重算官方範例向量與逐頁抽查（方法與更正見 [sources.md](sources.md)）；文中以 `[頁碼]` 標示 `https://developers.ecpay.com.tw/<頁碼>/`。標「提議」的表、路由與函式尚未存在。本設計不呼叫任何物流服務；連線 stage 或正式環境都要 Ted 另外授權（§11）。

供應商端頁面 SL-01～05 與供應商用途的讀取投影由 Supplier Console 負責（`SC-SPEC-07-fulfilment.md`）；本文件定義它們使用的領域資料、命令、權限與欄位白名單（§9.2）。

## 1. 責任與名詞

### 1.1 履約方式

| 方式 | 誰出貨 | 何時可用 |
| --- | --- | --- |
| 賣家自出貨 | 零售商（賣家）用自己的寄件地與物流帳戶 | 賣家自有商品（`commerce_items` 屬於賣家的店）。賣家向供應商批發進貨後，貨在自己手上，也是自有商品 |
| 供應商直送 | 供應商用自己的寄件地與物流帳戶，寄給賣家的買家 | 供貨商品（共享供應商的實體庫存，EC-SPEC-03 §2），且該商品有已接受的代出貨同意（§2.6） |
| 第三方倉 | 委外倉儲 | C4，不在本版 |

供貨商品的實體庫存 N 是供應商手上的貨（EC-SPEC-03 §2），只有供應商能把它交寄。所以：

- 供貨商品沒有有效的代出貨同意時，**不能**透過新結帳（`hosted_checkout`）購買；購物車報價顯示「目前無法配送」（`fulfilment_not_agreed`）。v1 的預留流程不受影響（SC-LAT03、EC-AT11）。
- 同一張購物車裡賣家的自有商品照常可買、可自出貨（EC-AT11 的「適用自出貨可繼續」）。
- 只同意供貨價（distribution acceptance，`migrations/056_commerce_distribution.sql:2`）不代表同意代出貨，也不會讓供應商取得任何買家資料（計畫 §11.1）。

### 1.2 誰負責什麼

| 角色 | 負責 | 不會自動取得 |
| --- | --- | --- |
| 零售商（賣家事業） | 對買家的配送承諾與運費、出貨者的決定（凍結在結帳）、取消與退款、例外的最終決定、買家溝通 | 修改供應商的庫存或已接受的條件；使用供應商的物流帳戶 |
| 出貨者（自出貨時是賣家，直送時是供應商） | 接受任務、揀貨包裝、用**自己的**物流帳戶建立物流單、列印、交寄、退回收件與檢驗 | 整張訂單、其他包裹、付款資訊、退款與發票（SC-LAT17） |
| 物流帳戶 | 屬於出貨者的事業；向綠界付運費的是帳戶主人 | 任何其他事業的帳戶（SC-LAT08） |
| 平台 | 驗證、保存、去重 provider 事件；執行 outbox；顯示狀態 | 自己的物流帳戶、代收、代付 |

賣家與供應商之間的每包費用（代出貨費，已包含出貨者自付的物流費；沒有另外的「運費補貼」）依代出貨同意記成應付紀錄（EC-SPEC-06 §5），不經過買家付款。

C2 不支援「出貨者使用別人的物流帳戶」。之後若要支援，必須是帳戶主人對特定事業的明確授權，另立規格。

### 1.3 領域名稱與提議的表

SC-SPEC-07 使用的領域名稱對到以下的表。能沿用既有模型的就沿用（計畫 Supplier v1.1 §4.1）。

拼字：計畫用 FulfillmentOrder、FulfillmentAgreement 當領域名稱；程式裡的識別字一律用 `fulfilment`（repo 既有寫法）——表 `commerce_fulfilment_*`、欄位與路徑參數 `fulfilment_order_id`、TypeScript 型別 `FulfilmentOrder`、`FulfilmentAgreement`、契約檔 `hosted-fulfilment.ts`。下表左欄只是對照計畫用語。

| 領域名稱 | 提議的表 | 說明 |
| --- | --- | --- |
| ShipFromLocation | `commerce_ship_from_locations` | 寄件地與退回地址；有個資，§2.1 |
| 物流帳戶 | 沿用 EC-SPEC-04 §1 的 `commerce_provider_accounts`＋`commerce_provider_account_services` | 金鑰封存方式相同，§2.2 |
| ShippingProfile、DeliveryOption | `commerce_shipping_profile_versions` | 每個商店一份、每次修改一個不可改的新版本，§2.3、§2.4 |
| ProductShippingAttributes | `commerce_item_shipping_attributes` | 屬於實體商品的擁有者，§2.5 |
| FulfillmentAgreement | `commerce_fulfilment_agreements`＋`commerce_fulfilment_agreement_items` | 代出貨同意，§2.6 |
| FulfillmentOrder | `commerce_fulfilment_orders` | 每張訂單每個配送群組一筆；行項由配置推得，不另存，§4 |
| 收件投影 | `commerce_fulfilment_recipients` | 出貨者能讀的最少收件資料，§4.4 |
| 選店 session | `commerce_cvs_selection_sessions` | §3.6 |
| Shipment | `commerce_shipments`＋`commerce_shipment_lines` | 一個實際包裹一筆，§5 |
| ShipmentAttempt | `commerce_logistics_operations` | 對外呼叫的 outbox（建單、查詢、改門市、作廢），§5.2 |
| TrackingEvent | `commerce_logistics_events` | 已驗證的貨態通知與查詢結果（inbox），§6 |
| ExceptionCase | `commerce_exception_cases` | 付款、庫存與物流共用，§7 |
| ReturnInspection | `commerce_return_inspections`＋`commerce_return_inspection_lines` | §8 |
| 費用紀錄 | EC-SPEC-06 §5 | 應付、已核對、已支付 |

FulfillmentOrder 與 Shipment 是既有訂單行項與配置（EC-SPEC-03）的履約投影與行為，不是第二套訂單。

## 2. 設定（SL-01、E11）

所有設定寫入沿用既有的 tenant command（Idempotency-Key、If-Match、未知結果用原 key 重試），沿用 `storeCommand` 的鎖序與目前授權檢查。

### 2.1 寄件地與退回地址（ShipFromLocation）

- 欄位：名稱（給自己看）、寄件人姓名、手機、市話（可選）、郵遞區號、地址、用途（寄件、收退回，可兩者皆是）。
- 寄件人姓名依綠界規則：4～10 字元（中文算 2、英文算 1；即 2～5 個中文字或 4～10 個英文字母），不含數字、表情與符號 [8809][7414]。店到店（C2C）必須是寄件人本人的真實姓名，因為未取件退回時要在門市出示證件 [8809]，設定頁要寫明這一點。
- 手機：`09` 開頭、10 位數字；7-ELEVEN 與萊爾富店到店必填 [8809]。
- 地址：宅配寄件地超過 6 字、最多 60 字 [7414]；不可含 `<`、`>`、`&` 與控制字元，前後不留空白（綠界不允許 HTML 標籤 [7400]）。
- 姓名與地址還要通過綠界 CDN 的字詞檢查：值裡出現 `echo`、`tftp`、`tracert`、`cd/`、`;`、`|`、反引號等指令字詞或字元，整個請求會被 CDN 擋下 [7400]。我們用比綠界更嚴格的 `findCdnBlockedTerm`（commerce-providers）在設定頁儲存時就檢查，命中就請出貨者改寫（例如英文名 `Echo` 改填證件上的中文姓名）。
- 每次修改新增一列，舊列標 `retired_at`；列本身不可改。訂單、代出貨同意與 shipment 指向建立當下那一列，所以歷史不會被改寫（計畫 Supplier v1.1 §4.2）。
- 個資：tenant RLS，只有該事業有 `store:manage` 或 `store:fulfil` 的人看得到完整內容；不進公會區塊、公開頁、分享卡片、journal 與日誌（SC-SPEC-07 SL-01）。
- 退回地址只在需要時揭露：代出貨同意裡給賣家看（賣家要知道退貨寄去哪），售後核准後給該買家看（EC-SPEC-06）。

### 2.2 物流帳戶

沿用 EC-SPEC-04 §1 的帳戶與金鑰封存：帳戶屬於一個事業與環境（`sandbox`／`live`），金鑰以 `purpose=logistics` 封存、只寫不讀。

- 帳戶下的每一個物流子類型是一個服務列（`commerce_provider_account_services`）：`ecpay.logistics.home.tcat`、`ecpay.logistics.home.post`、`ecpay.logistics.cvs.unimartc2c`、`ecpay.logistics.cvs.famic2c`、`ecpay.logistics.cvs.hilifec2c`；B2C 的 `…cvs.unimart`、`…cvs.fami`、`…cvs.hilife`、`…cvs.unimartfreeze` 在 C4。
- 服務狀態 `draft → active → suspended／retired`。`active` 的條件：
  - sandbox：用該環境帳戶完成一次建單＋查詢。綠界 stage 的 B2C／宅配與 C2C 是不同的測試特店（`2000132`、`2000933`，金鑰見 [7398]），所以 sandbox 會有兩個帳戶。
  - live：一筆真實建單與查詢成功（§11 的受控試寄）。
  - B2C 超商另需測標通過：每個子類型都要先以 `Express/CreateTestData` 產生測試標籤、雷射印表機列印、郵寄到物流中心驗收，通過後綠界才允許建 B2C 單 [7402]。結果只在綠界後台看得到，所以由商家填入通過日期，第一次 live 建單成功才算驗證。
- OK 超商店到店（`OKMARTC2C`）已於 2026/07/01 終止 [36099]，不提供。
- 服務 `suspended` 後不能建立新物流單；既有 shipment 照常接收通知、查詢與列印（在途責任不因停用消失，EC-R56）。
- 未開通的服務不出現在任何選單裡，不顯示「即將推出」（EC-AT68、SC-LAT02）。

### 2.3 出貨設定（ShippingProfile，出貨者的能力）

每個商店（賣家或供應商）一份文件 `freedom.shipping-profile/v1`，每次儲存產生新版本（`commerce_shipping_profile_versions`：instance、`version`、`document`、`document_sha256`、建立者、時間；不可改）。目前版本＝最大版本號。

`services[]`（我能怎麼寄）：

| 欄位 | 規則 |
| --- | --- |
| `service_key` | §2.2 的服務之一，且本事業的該服務是 `active` |
| `ship_from_location_id` | 本事業的寄件地 |
| `temperature` | C2 只有 `ambient`（常溫）；冷藏、冷凍在 C4（計畫 §11.5） |
| `handling_days` | 1～14 個作業日，付款確認後幾個作業日內交寄 |
| `cutoff_time` | Asia/Taipei `HH:mm`；在這之後、或在非作業日確認的訂單，從下一個作業日起算 |
| 包裹限制 | 最大重量、最長邊、三邊和；由出貨者依自己的物流合約填入，平台不寫死未核對的數字 |
| `outlying_islands` | `allowed`／`excluded`。中華郵政宅配只送本島 [7414] |

文件層級的欄位：

| 欄位 | 規則 |
| --- | --- |
| `working_days` | 作業日，ISO 星期 1～7 的集合，至少一天，預設週一到週五。C2 不內建國定假日；放假期間出貨者用「回報無法履約／改期」（§4.5） |

`ship_by` 的算法：付款確認的時間點落在作業日且在 `cutoff_time` 之前，起算日是當天，否則是下一個作業日；`ship_by`＝起算日之後第 `handling_days` 個作業日的 23:59:59（Asia/Taipei）。例：週一到週五、處理 1 天，週一 `cutoff_time` 前確認 → 週二；週五 `cutoff_time` 後確認 → 下週二。

沒有「包裝」欄位：裝箱限制已由上表的包裹限制與商品配送屬性（§2.5 的需單獨成箱、每箱最多件數）表達；禮品包裝等買家可選的包裝在 C4。

物流帳戶不在這份文件裡：伺服器依（出貨者商店、環境、`service_key`）找到唯一 `active` 的服務列與其帳戶（EC-SPEC-04 §1.2，呼叫端不能指定帳戶）。建單時把解析出的帳戶記在 shipment 上，之後的查詢、列印、改門市都用同一個帳戶；畫面只唯讀顯示（SC-LAT08）。

`drop_ship`（代出貨方案，只有供應商需要，選填）：

| 欄位 | 規則 | 誰看得到 |
| --- | --- | --- |
| `offered` | 是否提供代出貨 | 同公會賣家 |
| `fees[]` | 每個提供的服務一筆 `{service_key, fee_per_parcel_minor}`：每個已交寄包裹向賣家收的代出貨費，**已包含**出貨者自付的物流費。服務必須在上面的 `services[]` 裡 | 同公會賣家 |
| `return_location_id` | 收退回的寄件地（§2.1，用途含「收退回」） | 只有供應商自己；賣家在同意 `accepted` 後才看得到內容（§2.6） |
| `liability` | 例外責任說明（遺失、破損由誰向物流理賠、誰向買家負責），純文字 ≤ 1000 字 | 同公會賣家 |
| `recipient_retention_days` | 收件資料在送達或退回後保留的天數，1～30 | 同公會賣家 |
| `accept_within_hours` | 接受任務期限，1～72，預設 24 | 同公會賣家 |

同公會賣家看到的公開投影（契約 `DropShipOfferSchema`）只有上表標「同公會賣家」的欄位，加上每個服務的 `handling_days`、`working_days`、溫層與是否送離島；**不含**任何地址、電話、寄件人姓名或物流帳戶（§2.1、SC-SPEC-07 SL-01：地址不進公會區塊）。賣家申請時凍結進代出貨同意（§2.6）。

### 2.4 買家配送方式與運費（DeliveryOption，賣家）

同一份文件的 `delivery_options[]`，只有零售商需要。買家看到與付的運費只來自這裡（計畫 §11.2：不由各 adapter 自行加費）：

| 欄位 | 規則 |
| --- | --- |
| `method` | `home`（宅配）或 `cvs:<LogisticsSubType>`（例如 `cvs:UNIMARTC2C`） |
| `fee_per_parcel_minor` | 每個包裹的運費（TWD 最小單位，100 的倍數） |
| `free_over_minor` | 可選；訂單商品金額（折扣後）達到就全部包裹免運，由賣家吸收；離島加價照收（§3.4） |
| `outlying` | `excluded`，或每包離島加價（TWD 最小單位，100 的倍數） |
| 顯示名稱 | 例如「7-ELEVEN 取貨」 |

- 開放結帳的條件之一是至少一個配送方式，而且店家已發布 `shipping` 政策（EC-SPEC-02 §2.3）。
- 修改運費只影響之後的報價；已凍結的 checkout 與訂單不變。

### 2.5 商品配送屬性（ProductShippingAttributes）

- 屬於實體商品（`commerce_items`）的擁有者：自有商品是賣家，供貨商品是供應商。賣家不能改供應商商品的屬性。
- 欄位：重量（g）、長寬高（mm）、溫層（常溫／冷藏／冷凍）、可否超商取貨、需單獨成箱、每箱最多件數、限制標記（液體、電池等，只作檢查用）。
- 契約：`contracts/guild-launchpad/v1/hosted-shipping.ts` 的 `ItemShippingAttributesSchema`（讀取，含 `version`）與 `ItemShippingAttributesInputSchema`（寫入）；同一檔也定義 `ShippingProfileSchema`（`freedom.shipping-profile/v1`）與 `DropShipOfferSchema`。
- 每次修改新增一列（append-only），目前值＝最新一列。結帳時把當時的值凍結進 terms。
- 不是個資，不需要 RLS；寫入只經擁有者的命令（`store:write`），在 `catalog.ts` 註明豁免理由。
- 沒有填屬性的商品不能進新結帳（`shipping_attributes_missing`），避免付款後才發現寄不出去（EC-AT12）。商品詳情的「配送」分區在這個表上線後才出現（SC-SPEC-07 §4）。

### 2.6 代出貨同意（FulfillmentAgreement）

和既有的供貨同意分開，是另一份有版本的同意（SC-L03）：

1. 供應商在出貨設定公開 `drop_ship` 方案（§2.3）。
2. 賣家從已可售的供貨商品（selection `acceptance_state='sellable'`）中挑選商品，向供應商提出申請。申請凍結：商品清單（≤ 200）、供應商出貨設定的版本與服務、各服務的每包費用與其他金額條款（取消、退回處理、不可售責任、付款天數，EC-SPEC-06 §5.2）、寄件地與退回地址的版本（只存 ID；賣家在 `accepted` 之前看不到地址內容）、處理天數與作業日、例外責任、收件資料用途與保留天數；`terms_sha256`。
3. 供應商對**這個確切版本**接受或拒絕；接受時記錄簽署者與 `signed_digest = terms_sha256`（比照 `056` 的 acceptance）。
4. 狀態：`proposed → accepted／declined／withdrawn`；`accepted → revoked`（任一方）或 `superseded`（同商品的新版本被接受）。條款不可改；要改就提新版本。
5. 同一賣家商店、同一商品，同時最多一個 `accepted`（子表 `commerce_fulfilment_agreement_items` 的部分唯一索引）。
6. `withdrawn`（賣家在供應商決定前撤回申請）、`revoked`、`superseded` 只影響之後的結帳：涵蓋的商品在新結帳回 `unavailable(fulfilment_not_agreed)`（§3.1），賣家在同意清單與商品頁看到原因。已建立的履約單照凍結的同意版本繼續到完成或取消：出貨者仍可讀收件資料、建單、列印、交寄與處理退回（§4.4 的條件不包含同意狀態）。供應商不想再做時，逐筆回報無法履約（§4.5）；賣家不想再讓供應商處理時，取消那些履約單並退款。
7. 權限：提出、接受、撤回、撤銷需要該商店的 `store:manage`（綁定地址揭露與費用的商業承諾）。撤銷可由任一方發起（賣家 §9.1、供應商 §9.2），記錄發起者與原因。兩方都能讀自己參與的同意；RLS 依兩個 tenant。

## 3. 結帳：配送群組與凍結報價

`computeCheckoutTerms` 的 `ShippingQuotePort`（EC-SPEC-03、wp03-core 已留介面）由本模組實作。購物車報價（EC-SPEC-02 §5.2）以同一個函式試算，不寫入任何東西。

### 3.1 決定出貨者

每個行項：

- 自有商品 → 賣家自出貨。
- 供貨商品 → 有 `accepted` 代出貨同意涵蓋此商品 → 供應商直送；否則行項 `unavailable(fulfilment_not_agreed)`。
- 出貨者目前的出貨設定與同意凍結的服務取交集；交集為空 → `unavailable(method_unsupported)`。

### 3.2 分組與拆包

- 群組鍵＝(出貨者商店, 代出貨同意, 寄件地, 溫層, 服務)。不同出貨者、不同寄件地、不同溫層一定分開（計畫 §11.2）；同一出貨者的不同同意或不同服務也分開，所以每個群組只有一個服務與一個同意（§3.7 依群組凍結）。
- 對外的群組代號 `group_ref` 只在這次報價內有意義，依群組出現的順序編成 `g1`、`g2`…（包裹 `g1-p1`…）。報價、checkout 與買家頁只看到這個代號，看不到群組鍵裡的出貨者商店、同意或寄件地的 ID（EC-SPEC-09 §2.7）；需要對照時由伺服器用凍結的群組內容查。
- 服務的選法：同一出貨者、同一同意、同一溫層的行項，取出貨設定 `services[]` 順序中第一個所有行項都能用的服務；沒有共同的服務時，各行項用自己第一個能用的服務。這樣同一個出貨者盡量只出一串包裹，買家不多付可避免的包裹運費。
- 每個群組再依限制拆成包裹：需單獨成箱的商品逐件自成一包；其他商品依行項順序逐件放進第一個放得下的包裹（重量不超過上限、超商包裹的商品金額合計不超過上限、同一商品不超過每箱件數），放不下就開新包。重量上限是出貨設定的值，中華郵政另以 20 kg 為頂 [7414]；超商商品金額上限是 `GoodsAmount` 1～20,000 元 [8809]。C2 不做立體裝箱計算：每件商品本身必須符合服務的尺寸上限，否則該服務不可用。
- 出貨者實際出貨時可以拆成更多包，但多出來的運費不向買家收。

### 3.3 配送方式

- 一次結帳只有一個收件目的地（一個聯絡資料列）。買家可選的方式＝每個群組都支援的方式的交集。
- 超商取貨要求所有群組使用**同一個** `LogisticsSubType`，因為門市是在該子類型的電子地圖上選的 [8795]。
- 交集為空時，不收款：在 B05 第 2 步說明哪些商品不能一起配送，提供可用的方式或請買家分開下單（計畫 Supplier v1.1 §3.2、EC-AT12）。
- 不可用原因（逐行回傳，每行只回依下列順序第一個不符合的原因）：`fulfilment_not_agreed`、`shipping_attributes_missing`、`method_unsupported`、`temperature_unsupported`、`too_large`、`cvs_value_limit`、`outlying_unsupported`。

### 3.4 運費

- 每個包裹的運費＝賣家該配送方式的 `fee_per_parcel_minor`；訂單商品金額（折扣後）達到（≥）`free_over_minor` 時為 0（賣家吸收）。
- 離島：配送方式的 `outlying` 是 `excluded` 時，離島地址不可用（`outlying_unsupported`）；是加價時，每個包裹加收離島加價，**免運時也照收**（常見的「滿額免運，離島除外」）。
- 群組運費＝包裹數 ×（每包運費＋離島加價）；總運費＝各群組相加。
- 供應商向賣家收的每包費用不影響買家運費，只記成賣家的應付（EC-SPEC-06 §5）。
- 運費、各包裹、預計出貨日都進凍結 terms；總額＝商品－折扣＋運費（EC-AT09、10）。

### 3.5 收件資料檢查（在凍結時就驗）

綠界在建單時才會拒絕的欄位，結帳時就先擋下，避免收款後寄不出去：

| 欄位 | 規則 | 來源 |
| --- | --- | --- |
| 收件人姓名 | 4～10 字元（中文算 2）；只能是中文字或英文字母；不含數字、符號、表情。取件時要出示相同姓名的證件，畫面提示「請填寫與證件相同的姓名」 | [8809][62208] |
| 手機 | `^09\d{8}$`（輸入可含空白、`-`、括號或 `+886`，先正規化）；超商與宅配都必填。綠界宅配要求電話與手機擇一，C2 只收手機。包裹到店時綠界會用這支手機發簡訊通知取貨，結帳頁在手機欄旁說明 | [8809][7414][10419] |
| 宅配地址 | 超過 6 字、最多 60 字；郵遞區號 3、5 或 6 碼，前 3 碼必須在中華郵政的前 3 碼一覽表內 | [7414] |
| 中華郵政 | 只送本島；需要重量，最多 20 kg | [7414] |
| 超商商品金額 | 每包 1～20,000 元（整數元）；超過就不提供超商 | [8809] |
| 送綠界的文字 | 姓名與地址不可含綠界 CDN 擋下的指令字詞或字元（`findCdnBlockedTerm`，例如英文名 `Echo`）；地址另不可含 `<`、`>`、`&`、控制字元，前後不留空白 | [7400] |

不合規則回 422 並指出欄位（沿用 EC-SPEC-02 §5.3）。郵遞區號前 3 碼與離島的判斷依中華郵政「臺灣地區郵遞區號前3碼一覽表」（103.12.25 啟用，368 個代碼；來源與離島清單見 [sources.md §7](sources.md)）；離島＝連江 209～212、澎湖 880～885、金門 890～894 與 896、琉球 929、綠島 951、蘭嶼 952、東沙 817、南沙 819、釣魚臺列嶼 290。超商的離島：選店有回傳 `CVSOutSide`（0／1）就以它為準；沒有回傳時改看門市地址，地址含「澎湖縣」「金門縣」「連江縣」或上述離島郵遞區號所屬的 19 個鄉鎮市名稱（馬公市、湖西鄉、白沙鄉、西嶼鄉、望安鄉、七美鄉、金城鎮、金湖鎮、金沙鎮、金寧鄉、烈嶼鄉、烏坵鄉、南竿鄉、北竿鄉、莒光鄉、東引鄉、琉球鄉、綠島鄉、蘭嶼鄉）就算離島。萊爾富店到店一律不回傳 `CVSOutSide`，所以都用地址判斷；7-ELEVEN 與全家店到店會回傳 [8795]（§3.6）。

### 3.6 超商選店（`Express/map`）

綠界電子地圖是瀏覽器 POST，請求與回傳**都沒有** CheckMacValue；回傳是綠界讓瀏覽器 POST 到我們指定的網址，內容不可信 [8795]。所以：

1. 買家在 B05 選超商取貨 → `POST /api/v1/public/stores/:slug/cvs-selection-sessions`（需要 checkout 憑證）建立 session：隨機 `session_ref`、20 字元的 `extra_token`（只存雜湊）、checkout、子類型、所用帳戶、環境、15 分鐘到期。
2. 瀏覽器前往 `/ship/ecpay/map/{token}`：極小的 HTML，表單 POST 到該環境的 `Express/map`，欄位 `MerchantID`、`LogisticsType=CVS`、`LogisticsSubType`、`IsCollection=N`、`ServerReplyURL=/ship/ecpay/map-return/{session_ref}`、`ExtraData=extra_token`、`Device`（手機 1、桌機 0）[8795]。同一個視窗開啟，不用新分頁或 iframe（iOS 會失敗；閒置超過 3 分鐘或開多個地圖分頁會出錯）[8795][62208]。這個路徑的 CSP `form-action` 只加該環境的物流主機，比照付款交接頁（EC-SPEC-04 §4.1）。
3. 綠界把買家帶回 `POST /ship/ecpay/map-return/{session_ref}`：伺服器只檢查 session 存在、未到期、`ExtraData` 符合、`MerchantID` 與 `LogisticsSubType` 相同；把回傳的門市欄位清理後暫存在 session（`CVSStoreID` 1～6 個英數字：地圖回傳的欄位寬度是 9 [8795]，但建單的 `ReceiverStoreID` 只收 6 [8809]，超過 6 字的門市無法建單，所以在選店時就請買家改選；店到店是否真有超過 6 字的門市待 stage 核對，§11；店名 ≤ 10 字、地址 ≤ 60 字、`CVSOutSide` 0／1；萊爾富店到店沒有這個欄位，離島改依 §3.5 的地址規則 [8795][8809]），然後 303 回到結帳頁。這個跨站 POST 不帶買家憑證，所以這一步不改 checkout。這條路徑是請求閘道的例外之一：不檢查 Origin、不要求 JSON，由路由自己檢查表單格式與大小（EC-SPEC-09 §2.6）。
4. 結帳頁（同站 GET，有憑證）呼叫 `POST …/checkouts/:ref/cvs-selection`，伺服器確認 session 屬於這個 checkout、同子類型、同環境、未用過，才把門市寫進新的聯絡資料列（EC-SPEC-02 §5.3）。跨 checkout、跨服務、跨環境一律拒絕，也不回顯門市資料（EC-AT35）。
5. 門市名稱與地址只當文字顯示（不當 HTML），焦點回到門市欄並宣告所選門市（EC-SPEC-01 §7.3）。

- 綠界 stage 的地圖不開互動頁面，直接回固定門市 [8795]；sandbox 的選店測試以此為準。
- 地圖用的 `MerchantID`：優先用零售商自己有此子類型的帳戶；沒有就用其中一個出貨者的帳戶（特店編號不是秘密，物流標籤上也會出現）。門市代號是該連鎖的門市編號，不屬於特定帳戶。
- 門市是否仍可用，以建單結果為準（§5.3）；`Helper/GetStoreList` 的每日門市清單 [47496] 可在之後加作預檢，C2 不依賴。

### 3.7 凍結內容

每個群組：出貨者商店、方式（自出貨／直送）、代出貨同意的 ID 與版本、出貨設定版本與 `service_key`、寄件地版本、溫層、包裹規劃（行項與數量）、每包運費、處理天數。全部進 `freedom.checkout-terms/v1` 並計入 `terms_sha256`；收件資料在聯絡資料列，terms 只含它的摘要（EC-SPEC-03 §3.1）。下單時重算，任何一項改變（同意被撤回、設定改版、屬性改變）→ `terms_changed`，請買家重新確認。

## 4. 履約單（FulfillmentOrder）

### 4.1 建立

- `ensureFulfilmentOrders(q, orderId)`：依凍結的群組，每群組一筆，`UNIQUE(order_id, group_key)`，重複呼叫不會多建。
- 呼叫時機：付款套用結果是 `converted` 或 `allocated` 的同一交易內（EC-SPEC-03 §3.3）；`retryAllocation` 成功後；以及排程補建（防止中間版本漏建）。
- 行項不另存：一筆履約單的行項＝該群組行項對應的配置（EC-SPEC-03 §2）。剩餘可出貨量＝配置量 − 已出貨 − 已釋放 − 未作廢且未交寄的包裹量。
- **指派就是建立履約單時寫入的出貨者**：`executor_tenant_id`／`executor_instance_id` 來自凍結的群組（自有商品＝賣家；供貨商品＝同意裡的供應商），之後不能改。C2 沒有另外的「指派」步驟或狀態：貨在誰手上就由誰出貨（§1.1），賣家在 E06 看到的是已自動指派的結果。出貨者事業裡，任何有該店 `store:fulfil` 的成員都能處理；指派到個人（`assignee`）在 C4。SL-02「只列本人被指派的行項」＝出貨者是本事業、且使用者在本事業有 `store:fulfil` 的履約單。
- 自出貨建立為 `accepted`；直送建立為 `awaiting_acceptance`，`accept_by`＝建立時間＋同意的 `accept_within_hours`。
- `ship_by` 依 §2.3 的作業日算法，只是承諾，不是自動動作。賣家同意等候改期時另記 `revised_ship_by`（§4.5）；逾期判斷用 `coalesce(revised_ship_by, ship_by)`。

### 4.2 狀態

| 狀態 | 意義 | 下一步 |
| --- | --- | --- |
| `awaiting_acceptance` | 等供應商接受 | 接受；回報無法履約；逾期 → 例外 `fulfiller_unresponsive`（賣家處理） |
| `accepted` | 出貨者已接受 | 建包裹、建單、列印、交寄；回報無法履約 |
| `unable_reported` | 出貨者回報做不到（附原因代碼，§4.5） | 出貨者撤回回報（回到 `accepted`）；賣家選擇等候改期或取消行項並退款 |
| `fulfilled` | 全部剩餘量都已交寄或取消 | — |
| `cancelled` | 賣家取消整個群組 | — |

SL-02 的分頁（`tab` 參數；每一列是什麼、條件為何；出貨者＝本事業）：

| `tab` | 中文 | 每一列 | 條件 |
| --- | --- | --- | --- |
| `awaiting_acceptance` | 待確認 | 履約單 | `awaiting_acceptance` |
| `preparing` | 備貨中 | 履約單 | `accepted`，且還有數量不在任何 `created` 或之後的包裹裡（包括只有草稿、建單中、結果確認中、建單失敗的包裹） |
| `to_print` | 待印單 | 包裹 | `created`，列印次數 0 |
| `to_hand_over` | 待交寄 | 包裹 | `created`，列印次數 ≥ 1 |
| `exceptions` | 例外 | 例外 | `open`，責任方是 `executor`，且關聯到本事業的履約單或包裹 |
| `unable_reported` | 已回報無法履約 | 履約單 | `unable_reported` |
| `history` | 歷史 | 履約單 | `fulfilled`／`cancelled`，依最後更新時間新到舊 |

同一張履約單可以同時出現在「備貨中」（還有沒包的數量）和「待印單」（已有一包待印）；計數各自計算。路由與計數見 §9.2。

### 4.3 付款確認門檻

付款 attempt `paid` 就會配置庫存並建立履約單；但**建立物流單、列印、交寄**都要求付款已 `confirmed`（伺服器對伺服器查詢確認，EC-SPEC-04 §5.5）。每次命令執行時讀目前狀態，不用快取。未確認時畫面顯示「付款確認中，請先不要出貨」；出貨者仍可接受任務與備貨。

### 4.4 收件資料的最小揭露

賣家的買家聯絡資料表只對賣家事業開放（tenant RLS，EC-SPEC-03 §3.1）。出貨者讀的是另一份最小投影：

- `commerce_fulfilment_recipients`：每筆履約單一列（改門市或更正宅配地址時新增一列），內容只有收件人姓名、手機、配送方式、門市（代號、名稱、地址、是否離島）或宅配（郵遞區號、地址）。不含 Email、發票、其他群組、訂單金額、顧客歷史。
- 擁有者是零售商事業；出貨者的 RLS 讀取條件：自己是這筆履約單的出貨者，且履約單 `accepted`、付款 `confirmed`、未超過 `access_until`、未遮罩。
- 存取期限：包裹送達或退回完成後再加同意裡的保留天數（自出貨依賣家政策，直送 ≤ 30 天）；履約單取消時立即結束。期限後的讀取回 403「收件資料已到期」，列內容遮罩。
- 每次讀取與每次列印都經命令並留 receipt（比照 `modules/agent-commerce/hosted/supplier-orders.ts:16` 的讀取命令），記錄誰、哪一筆、用途；不記內容。
- 履約單取消、使用者失去出貨者事業的 `store:fulfil`、超過 `access_until` 或列已遮罩後，新的讀取與列印一律拒絕，也不會帶出別的包裹（SC-LAT13）。代出貨同意的 `revoked`／`superseded` **不**影響已建立的履約單（§2.6 第 6 點），否則已付款的直送單會出不了貨。
- 委派給 Agent 的憑證不能讀收件資料，也不能開列印 session（EC-SPEC-01 §1、decisions.md）。

### 4.5 無法履約、改期與取消

C2 沒有「改派」：出貨者在建立履約單時就固定（§4.1），賣家不能把供貨商品改成自己出貨（貨不在賣家手上，§1.1），也不能換另一個供應商（那是另一份 offer 與另一筆庫存）。出貨者做不到時，只有改期或取消兩條路。

- 回報無法履約：`POST …/fulfilment-orders/:fo/unable`，輸入 `reason`（下表）、可選 `note`（≤ 500 字，畫面提醒不要寫買家個資）、可選 `expected_ship_date`（Asia/Taipei 日期，只適用標「可改期」的原因）。履約單 → `unable_reported`，建立例外 `fulfiller_unable` 給賣家。供應商畫面沒有取消訂單或退款的按鈕（SC-LAT06、17）。

| `reason` | 中文 | 可改期 |
| --- | --- | --- |
| `out_of_stock` | 實際缺貨（帳上有、架上沒有） | 是 |
| `damaged_stock` | 貨品瑕疵或損壞 | 是 |
| `discontinued` | 已停產、不再供應 | 否 |
| `cannot_meet_ship_by` | 無法在期限內交寄 | 是 |
| `carrier_unavailable` | 物流服務暫停或無法寄送此包裹 | 是 |
| `other` | 其他（`note` 必填） | 是 |

- 撤回回報：`POST …/fulfilment-orders/:fo/unable/withdraw`（出貨者，`unable_reported` 時）→ 回到 `accepted`；例外 `fulfiller_unable` 自動結案（`fulfiller_withdrew`）。用於找到貨、或賣家同意等候之後備好貨。
- 賣家的決定（例外 `fulfiller_unable` 的動作，§7.2）：
  - `wait`（等候改期）：輸入新的日期 `revised_ship_by`（不早於今天，最多 30 天後）；履約單記下這個日期，出貨者在 SL-02 看到「賣家同意等候至 {日期}」。例外維持 `open` 到出貨者撤回回報或賣家取消；逾期判斷改用新日期。通知買家延遲由賣家負責（C2 的訂單訊息，EC-SPEC-06 §2.1）。
  - `cancel_lines`（取消行項並退款）：`releaseAllocation`（EC-SPEC-03）、未交寄的包裹作廢（§5.6）、另建退款（EC-SPEC-04 §7）；履約單在全部剩餘量都取消時 → `cancelled`。
  - 沒有「換貨／替代品」：換成別的商品會改變買家付款時凍結的條件。C2 的做法是取消並退款，買家可以重新下單。
- 賣家主動取消已付款未出貨的群組：同 `cancel_lines`；若出貨者已建單並產生運費，依同意記成賣家的應付（EC-SPEC-06 §5）。
- 已交寄的包裹不能取消，只能走售後（§8、EC-SPEC-06）。

## 5. Shipment：建單、標籤、交寄

### 5.1 狀態

一個實際包裹一筆 shipment（SC-L06）。下表是包裹文字的唯一來源：「買家看到」給買家頁（B07），「出貨者看到」給 SL 頁與賣家的 E06（賣家看自己的包裹或供應商的包裹都用這一欄）。EC-SPEC-01 §6.3 引用本表，不另訂包裹文字。

| 狀態 | 順序 | 買家看到 | 出貨者看到 |
| --- | --- | --- | --- |
| `draft` | 0 | 準備出貨 | 包裹草稿 |
| `creating`／`create_unknown`／`create_failed` | 1 | 準備出貨 | 建立託運單中／結果確認中／建立失敗（原因） |
| `created` | 2 | 已建立託運單 | 待列印／待交寄 |
| `handed_over` | 3 | 已交寄 | 已交寄 |
| `in_transit` | 4 | 運送中 | 運送中 |
| `ready_for_pickup` | 5 | 已到店待取 | 已到店待取 |
| `delivered` | 6 | 已取件或送達 | 已送達 |
| `returning` | 7 | 退回中 | 退回中 |
| `returned` | 8 | 已退回 | 已退回，待收件／待檢驗 |
| `voided` | — | 不顯示 | 已作廢 |

- 正向只前進（2→6）；退回分支可從 3～5 進入 7→8。`delivered` 之後不再改變；之後的退貨是售後的另一件事（§8.2）。
- 「配送異常」不是狀態，是這個包裹有未結例外時的顯示（EC-SPEC-01 §6）。
- 包裹行項（`commerce_shipment_lines`：配置、數量）：所有未作廢包裹的數量合計 ≤ 配置量 − 已釋放量，以 deferred trigger 檢查。

### 5.2 建單（`Express/Create`）

C2 採用綠界舊版國內物流（MD5 CheckMacValue、表單格式），不用全方位物流（AES-JSON、先建暫存單）[7380][10075]：舊版可以在我們自己的結帳頁選店、伺服器背景直接建單，也能用 `MerchantTradeNo` 查回結果 [8809][7418]。全方位物流之後可以另做 adapter。

1. 出貨者在履約單建立包裹（選行項與數量，預設全部剩餘量）→ `draft`。
2. 按「建立託運單」：一個交易內檢查門檻（§4.3、出貨者權限、收件投影可讀），依（出貨者商店、環境、凍結的 `service_key`）解析唯一 `active` 的服務與帳戶並記在 shipment 上（命令不接受帳戶參數），產生 `MerchantTradeNo`（`L`＋19 個 Crockford Base32 大寫字元，共 20 字元 [8809]），寫入 operation（`kind=create`），shipment → `creating`，commit。
3. outbox 執行者在租約交易提交後呼叫 `Express/Create`（背景建單：`ClientReplyURL` 留空 [8809]），10 秒逾時，只連該環境的官方主機。

送出欄位重點：

| 欄位 | 值 | 來源 |
| --- | --- | --- |
| `LogisticsType`／`LogisticsSubType` | `CVS` 或 `HOME`；子類型依服務 | [8809][7414] |
| `GoodsAmount` | 該包裹商品金額的整數元，最少 1；超商 ≤ 20,000 | [8809] |
| `IsCollection` | 一律 `N`（C2 不開貨到付款）；中華郵政不送這個欄位 | [8809][7414] |
| `GoodsName` | 固定 `訂購商品`：標籤會被物流士與門市店員看到，不透露買了什麼；固定字串也不會碰到這個欄位的禁用字元 `` ^ ' ` ! @ # % & * + \ " < > \| _ [ ] ``、50 位元組上限與 CDN 字詞檢查。7-ELEVEN 與萊爾富店到店必填 | [8809] |
| 寄件人 | 寄件地版本的姓名、手機（宅配另需郵遞區號與地址） | [8809][7414] |
| 收件人 | 收件投影的姓名、手機；超商 `ReceiverStoreID`；宅配郵遞區號與地址 | [8809][7414] |
| `ReturnStoreID` | 不送（只有 7-ELEVEN 店到店支援，其他退回原寄件門市） | [8809] |
| 宅配 | `Temperature=0001`。黑貓：`Distance` 依地址（同縣市 `00`、外縣市 `01`、離島 `02`）、`Specification` 依包裹（60／90／120／150 公分＝`0001`～`0004`）、`ScheduledPickupTime=4` 與 `ScheduledDeliveryTime=4`（不指定時段）。中華郵政：`GoodsWeight` 以公斤計、最多 3 位小數、≤ 20，不送 `Distance`、`Specification` 與時段 | [7414] |
| `ServerReplyURL` | §6.1 的回呼路徑 | [8809] |
| `ReceiverEmail`、`ReceiverPhone`、`SenderPhone`、`Remark`、`CollectionAmount` | 不送（資料最少化；不代收） | |
| `ClientReplyURL`、`LogisticsC2CReplyURL`、`PlatformID` | 不送（背景建單；不是平台商） | [8809] |

每個值在簽章前都先過 CDN 字詞檢查（`findCdnBlockedTerm`）[7400]；`MerchantTradeNo` 由 `newTradeNumber` 產生，隨機字元拼出會被擋的字（例如 `TFTP`）時就重抽，最多 16 次。這些欄位組裝、回應與通知的解析都在 `ecpay/domestic-logistics/`（§10）。

回應：成功是 `1|` 後接表單字串，去掉 `1|` 再解析並以 MD5 驗證 CheckMacValue；失敗是 `0|錯誤訊息` [8809]。成功取得 `AllPayLogisticsID`（之後查詢、列印、改門市都用它），店到店另有 `CVSPaymentNo`（7-ELEVEN 另有 `CVSValidationNo`），宅配有 `BookingNote`（託運單號）；B2C 的配送編號 `ShipmentNo` 要用查詢取得 [8809][7418]。結果以新交易寫回，shipment → `created`。

### 5.3 結果不明與失敗

- 逾時、連線錯誤、無法解析或簽章不符 → `create_unknown`。**不換號、不盲目重送**：以同一個 `MerchantTradeNo` 呼叫 `QueryLogisticsTradeInfo/V5` [7418]（1、5、15、60 分鐘後，之後每 6 小時，最多 24 小時）。
  - 查到 → 採用查到的單號與狀態，`created`；不會出現第二個實體包裹或第二筆運費（EC-AT37、SC-LAT07）。
  - 查無時不自動重建。連續查無、且距最後一次送出超過 30 分鐘後，出貨者可以按「重新建立」，沿用**同一個** `MerchantTradeNo` 送出。綠界要求廠商交易編號不可重複使用 [8809]；若綠界以編號重複拒絕，代表第一次其實已建立，回到查詢。綠界對重複編號的實際回應要在 stage 核對（§11）；核對之前，正式環境的「重新建立」要求出貨者先在綠界後台確認沒有這張單。
  - 24 小時仍無法判定 → 例外 `shipment_create_unknown`：出貨者到綠界後台用 `MerchantTradeNo` 核對，以證據結案。
- `0|錯誤` 是明確失敗 → `create_failed`，顯示綠界訊息（清理、截到 200 字）。已知的：`10500040` 商品金額錯誤、`10500036` 姓名長度錯誤 [62208]；`找不到加密金鑰…` 表示特店與子類型不符或環境錯置 [62208]。門市失效時，出貨者選「請買家重新選店」→ 例外 `pickup_store_invalid`（§7.3）；綠界拒絕宅配收件地址或郵遞區號時，選「請買家更正地址」→ 例外 `recipient_address_invalid`（§7.4）。兩者都是 `POST …/shipments/:sid/recipient-fix-requests`（§9.2），只限 `create_failed` 的包裹。修正後重試：先以舊編號查詢確認沒有建立，再產生新編號。
- 這一套不在 SQL 交易中等外部回應（EC-R20）；查詢是唯讀可安全重試，建單不是。

### 5.4 標籤列印與重印

- 綠界列印端點必須由**瀏覽器**以表單 POST 開啟，伺服器端呼叫只會停在中繼頁；不能放 iframe [62208][7406][8875]。端點依子類型：7-ELEVEN 店到店 `PrintUniMartC2COrderInfo`（需要 `CVSPaymentNo`、`CVSValidationNo`）[7406]、全家店到店 `PrintFAMIC2COrderInfo` [8848]、萊爾富店到店 `PrintHILIFEC2COrderInfo` [8858]、B2C 與宅配 `helper/printTradeDocument` [8875]。
- 流程：`POST …/shipments/:sid/print-sessions`（檢查 §4.3、§4.4 的條件）→ 回傳 `/ship/ecpay/print/{token}`：一次性、5 分鐘、綁定目前的會員 session。該頁產生已簽章的表單並自動送出到綠界；CSP `form-action` 只加物流主機。
- 重印＝同一個 `AllPayLogisticsID` 再開一次，不建新單、不重新付費（EC-AT38、SC-LAT09）。每次列印留紀錄（誰、何時）；列印次數決定 SL-02 的「待印單／待交寄」。
- 列印頁的簽章欄位一旦外流就能重複開啟綠界頁面，這是綠界端的限制。我們的對策是只在授權當下產生、不保存、不寫日誌。
- 平台不保存標籤檔案（由綠界產生），所以沒有公開網址，也沒有需要另外備份的標籤檔。
- 列印或下載標籤不等於交寄，不改庫存（EC-AT39、SC-LAT10）。

### 5.5 交寄與庫存

- `handed_over` 的證據：
  1. 綠界貨態屬於「已交寄」或之後的階段（§6.3）；或
  2. 出貨者以命令記錄交寄（可填門市收據號碼或託運單號），留 receipt。綠界 stage 沒有貨態通知 [7420]，sandbox 只能用這個方式；live 也允許，但 3 天內沒有任何物流貨態就開例外 `no_tracking_progress`。
- 第一次進入順序 ≥ 3 的狀態時（包括先收到退回貨態的情形），同一交易內呼叫 `recordHandover`（EC-SPEC-03，`shipmentRef = shipment_id`）：N 與 A 各減包裹數量；同一 shipment 重送不再扣（EC-AT28）。
- 交寄記錄不能撤銷；記錯的情形走例外與退回檢驗。
- 店到店建單後要在有效日內交寄（日曆天）：7-ELEVEN 5 天、全家 6 天、萊爾富 7 天 [7444]。SL-02 的待交寄清單顯示到期日。過了有效日這張單怎麼處理（能否再寄、是否要重新建單）官方沒有寫，列入 §11 核對；核對前，過期的包裹開例外，由出貨者先查詢再決定。
- 鎖序接在 EC-SPEC-03 §6 之後：… → `commerce_orders` → payment attempt → 履約單 → shipment（UUID 排序）→ 配置 → item（UUID 排序）。

### 5.6 作廢

- 只有未交寄（順序 ≤ 2）的包裹可以作廢。
- 7-ELEVEN 店到店有取消 API（`Express/CancelC2COrder` [7412]：`MerchantID`、`AllPayLogisticsID`、`CVSPaymentNo`、`CVSValidationNo`，回 `1|OK`；協定程式庫已實作）；其他子類型沒有已核對的取消方式，作廢只在本地標記，並提醒出貨者綠界可能仍收運費，費用以查詢的 `HandlingCharge` 為準 [7418]。
- 作廢後配置量回到「可再建包裹」；是否同時取消行項由賣家另外決定（§4.5）。

## 6. 貨態

### 6.1 通知端點

- `POST /api/v1/provider-callbacks/ecpay/{account_ref}/logistics`，規則與付款通知相同（EC-SPEC-04 §5.1）：確切路徑、表單格式、16 KiB 上限、重複參數拒絕；staging 需要 Access 排除（Ted 的基礎設施變更）。
- 綠界以網域 `postgate.ecpay.com.tw`（stage 為 `postgate-stage.ecpay.com.tw`）公布通知來源 [7400]。Worker 不做 IP 白名單，簽章驗證才是依據。
- 驗證：
  1. 依 `account_ref` 找帳戶；找不到 → 404。
  2. 以 `logistics` 金鑰重算 MD5 CheckMacValue：收到的全部欄位（除 CheckMacValue）依參數名不分大小寫排序，前後加 HashKey／HashIV，.NET 規則 URL 編碼、轉小寫、MD5、轉大寫 [7424][7446]。constant-time 比較。
  3. `MerchantID` 相符；依 (帳戶, `AllPayLogisticsID`) 找 shipment，找不到再用 `MerchantTradeNo`；仍找不到 → `unmatched` 事件，回 `1|OK`。
  4. 子類型與 `GoodsAmount` 與 shipment 一致；不一致 → `contradicting_event` 例外。
  5. 依 §6.3 對照、§6.4 規則更新。
- 一個交易內寫入事件（去重）→ 更新 shipment →（需要時）`recordHandover` → commit；**提交成功後**才回純文字 `1|OK`。沒有正確回應時，綠界重送 3 次，之後每天一次、從貨態更新日起維持 3 天 [7420]。
- 通知會回傳收件人姓名、電話、Email、地址 [7420]：只用於簽章驗證，**不保存**、不寫日誌。事件只存帳戶、`AllPayLogisticsID`、`MerchantTradeNo`、`RtnCode`、`RtnMsg`（清理後）、`UpdateStatusDate`、子類型、原始 body 的 SHA-256。
- 去重鍵：(帳戶, `AllPayLogisticsID`, `RtnCode`, `UpdateStatusDate`)。
- 金鑰外洩時可以偽造貨態。影響是訂單顯示錯誤，不會動到錢；對策是 §6.2 的定期查詢核對，訂單結案（`closed`）前以查詢確認最後狀態。

### 6.2 查詢（`QueryLogisticsTradeInfo/V5`）

- 依 `AllPayLogisticsID` 或 `MerchantTradeNo` 查詢近 5 年的物流單；`TimeStamp` 3 分鐘內有效，送出前才產生；回應以 MD5 驗證 [7418]。
- 用途：未知建單（§5.3）、B2C 的 `ShipmentNo`、貨態補漏（綠界 stage 沒有貨態通知 [7420]，正式環境的通知也可能遺失）、費用（`HandlingCharge`、`ShipChargeDate`）。
- 排程：建單後立即一次；之後每 6 小時查進行中的包裹；交寄超過 3 天改每天一次；送達或退回完成後 7 天停止。使用者按「重新查詢」：同包裹每分鐘 1 次。
- 回應含寄件人姓名與電話（V5 新增）[7418]：不保存。
- 官方範例回應的 CheckMacValue 只在去掉 V5 新增欄位時才算得出來（範例沒有跟著更新，見 sources.md）。實作以「全部回傳欄位」驗證，並在 stage 以真實回應確認；未確認前不把查詢結果當成交寄證據以外的唯一依據。

### 6.3 狀態碼對照

- 來源：綠界公開的「物流貨態代碼表」（`https://developers.ecpay.com.tw/logistics_status/`，下載為 xlsx；2026-06-04 版，雜湊與列數見 [sources.md §8](sources.md)）。表依物流分頁；同一代碼在不同物流可能意思不同（例：`5004` 黑貓是「一般單退回」，萊爾富是「賣家未取包裹，待申請退回」），所以對照的鍵是（子類型, 代碼）。本規格先前寫完整表只在廠商後台 [7440]，已更正。
- C2 只對照自己會建立的五種子類型 `UNIMARTC2C`、`FAMIC2C`、`HILIFEC2C`、`TCAT`、`POST`，共 278 列。完整對照是 [ecpay-logistics-status-map.tsv](ecpay-logistics-status-map.tsv)（欄位：子類型、代碼、綠界訊息、效果、狀態、例外）；程式裡的表必須與它逐列相同，由測試檢查。其他子類型的代碼一律視為無法對應（B2C 在 C4，屆時再加入對照）。
- 效果：

| 效果 | 意思 | 列數 |
| --- | --- | --- |
| `progress` | 狀態前進到「狀態」欄，依 §6.4 套用；「例外」欄有值時一併開例外 | 143 |
| `exception` | 狀態不變，依 §6.4 開「例外」欄的例外 | 115 |
| `informational` | 已知、不影響狀態（門市改店號、已申請門市變更、包裹門市確認中）；只保存事件 | 9 |
| `ops_review` | 代碼表有，但 C2 不應收到：退貨便與逆物流的代碼（C2 不建逆物流單），以及意思不明的黑貓 `7029`「已回收」；保存事件、狀態不變、進每日清單給平台維運 | 11 |

- 判讀依綠界訊息文字。意思明確才改狀態；可能重新配送或結果未定的代碼（例如「包裹確認中，將退回物流中心」、「買家未取退回物流中心-爆量」）只開例外、不改狀態，避免先標成退回之後擋住「包裹重新配達取件門市」（§6.4 不倒退）。判讀的取捨列在 decisions.md。
- 依物流整理如下（完整見 TSV）：

| 效果 | 7-ELEVEN 店到店 | 全家店到店 | 萊爾富店到店 | 黑貓 | 中華郵政 |
| --- | --- | --- | --- | --- | --- |
| `created` | 300 | 300、310、7014 | 300、310、311、2001、2024、2031、7014 | 300、310、311 | 320 |
| `handed_over` | 2068 | 3032 | 2068、3032 | — | 3301 |
| `in_transit` | 2030、2041、2043、2058 | 3024 | 2027、2030、2041、2043、2057～2059、3024、7004 | 3001、3002、3004～3007、3010、3013～3015、3118～3120、3122、7004、7024 | 3303、3312、3313 |
| `ready_for_pickup` | 2073、2098 | 3018、3029 | 2063、2073、3018、3029 | 3011、3012、3121 | 3302、3314、3315 |
| `delivered` | 2067 | 3022 | 2067、3022 | 3003 | 3307～3309 |
| `returning`＋`uncollected` | 2074、2076、2078 | 3020、3025 | 2046、2065、2074、3020、3025 | 3123 | 3305 |
| `returning`＋`damaged` | — | — | 5001 | 5001 | — |
| `returning` | 2051、2053、2079～2087、2097 | 7012、7016 | 2016、2026、2033、2034、2038～2040、2045、2047、2049～2055、2060、3033、5005、7012、7016 | 3124、3125、5004、5005 | 3311 |
| `returned` | 2070、2072、2099 | 3019、3023、3031 | 2070、2072、3019、3023、3031、5008 | 5008 | 3310 |
| 例外 `pickup_store_closed` | 2092、2101、2103、2104 | 7011 | 2028、2029、2037、2101、2103、2104、7011 | — | — |
| 例外 `recipient_address_invalid` | — | — | — | 3008、3009、7003 | — |
| 例外 `uncollected` | — | — | — | 3117 | — |
| 例外 `lost` | 2042、2088、7018、7020 | 7006、7007 | 2042、5002、5007、7006、7007 | 5002、5007 | 7302 |
| 例外 `damaged` | — | 7008、7036 | 5006、7008 | 5006 | 7301 |
| 例外 `contradicting_event` | — | — | — | 3016、3017 | — |
| 例外 `carrier_attention` | 2048、2061、2066、2075、2077、2089、2093、2094、2096、7013、7017、7019、7038、9999 | 3021、5009、7009、7010、7013、7015、7032、7034、7035 | 2002～2007、2009～2015、2017～2023、2032、2035、2036、2048、2061、2066、2071、2075、3021、5003、5004、5009、7001～7003、7005、7009、7010、7013、7032、9999 | 5003、7001、7002、7005、7025～7028、7030、7031 | 3304、3306、7300 |
| `informational` | 2062、2102、2105 | 2105 | 2000、2025、2062、2102、2105 | — | — |
| `ops_review` | 2069 | 4001、4002 | 325、2069、4001、4002、9001、9002 | 325、7029 | — |

- 交寄：順序 ≥ 4 的代碼都隱含已交寄（§5.5）。黑貓沒有單獨的交寄碼，集貨就是 `3001`「轉運中(即集貨)」。
- 無法對應的代碼（TSV 沒有的，或其他子類型）：存成事件、狀態不變、進每日「未對應代碼」清單給平台維運，不對使用者開例外。`ops_review` 也進同一份清單。
- 綠界更新代碼表時（xlsx 有「異動歷程」頁）：重新下載，比對雜湊與異動歷程，更新 TSV 與程式表，在 sources.md 記下日期。

### 6.4 亂序與矛盾

- 事件依 §5.1 的順序套用：比目前低的事件只保存、不倒退（EC-AT40、SC-LAT11）。
- 已到店待取之後收到較舊的「運送中」→ 保存，不改；之後收到七天未取 → 允許進入 `returning`（有證據的退回流程）。
- `delivered` 之後收到退回類貨態、或 `returning` 之後收到取件成功 → 不改狀態，開例外 `contradicting_event`，由賣家依證據決定。
- 同一包裹的事件永不刪除；一張訂單多包時逐包計算，不因一包送達就說整單完成（EC-AT34、SC-LAT12）。
- 例外依下列規則開立；同一包裹同一種類已有 `open` 的就不重開（§7.1）：
  1. `progress` 且狀態前進：開「例外」欄的例外。這次從正向或建單前進入退回分支（`returning`／`returned`），而「例外」欄是空的、包裹也沒有任何未結例外 → 開 `carrier_attention`（退回原因待確認）。
  2. `progress` 但矛盾（`delivered` 後的退回、退回分支中的取件成功、`voided` 後的任何貨態）→ `contradicting_event`。較舊或相同的事件不開例外。
  3. `exception`：包裹已 `delivered` 或 `voided` → 改開 `contradicting_event`；`pickup_store_closed` 與 `recipient_address_invalid` 只在順序 2～5（`created`～`ready_for_pickup`）時開，其他狀態只保存事件；其餘種類照開。
- 包裹進入退回分支時，未結的 `pickup_store_closed`、`recipient_address_invalid` 不自動結案，由零售商決定（聯絡買家、讓包裹退回、退款）。買家頁只在順序 2～5 時顯示重選門市或更正地址的提示。

## 7. 例外（ExceptionCase）

### 7.1 共用表

`commerce_exception_cases` 是付款、庫存與物流共用的待辦（EC-SPEC-04 §5.6、EC-SPEC-03 §5.3）：

- 欄位：`case_id`、零售商 tenant／instance、`order_id`、種類、關聯對象（attempt、refund、履約單、shipment、return；EC-SPEC-06 §7 另加售後申請、發票文件、更正與折讓）、責任方（`retailer`／`executor`／`buyer`）、出貨者 tenant（可空）、狀態 `open → resolved／dismissed`、`due_at`、結案代碼與說明、開立者（系統或成員）、結案者、`version`。
- 同一 (種類, 對象) 同時最多一個 `open`，重送事件不會開出重複例外。
- 表屬於交易核心（`hosted-checkout` 模組），隨付款的 migration（M2）建立；本文件的物流種類在 M3 加入。
- 出貨者只看到關聯到自己履約單或包裹的例外，且看不到賣家的內部說明。
- 每個例外都有責任方、下一個合法動作與期限，不只顯示「請聯絡客服」（計畫 §11.4）。

### 7.2 物流相關種類

| 種類 | 來源 | 責任方 | 下一個合法動作 | 期限 |
| --- | --- | --- | --- | --- |
| `fulfiller_unresponsive` | 直送履約單超過 `accept_by` | 零售商 | 聯絡供應商；取消行項並退款 | 立即 |
| `fulfiller_unable` | 出貨者回報（§4.5） | 零售商 | `wait`（等候改期）；`cancel_lines`（取消行項並退款） | 24 小時內回覆買家 |
| `ship_by_overdue` | 超過 `ship_by` 未交寄 | 出貨者（零售商可見） | 出貨；回報無法履約；零售商通知買家延遲 | — |
| `shipment_create_failed` | `0|錯誤`，且不是門市或收件地址問題 | 出貨者 | 修正寄件資料或設定後重試 | — |
| `shipment_create_unknown` | 24 小時無法判定（§5.3） | 出貨者 | 到綠界後台核對後附證據結案 | — |
| `pickup_store_invalid` | 建單時門市不可用 | 買家（零售商負責聯絡） | 買家重新選店 | 48 小時 |
| `recipient_address_invalid` | 建單時綠界拒絕宅配收件地址或郵遞區號；交寄後黑貓回報地址錯誤或搬家（§6.3、§7.4） | 買家（零售商負責聯絡） | 建單時：買家更正地址；超出原服務或運費區 → 零售商取消群組並退款。交寄後：零售商聯絡買家，請買家以託運單號直接聯絡物流；送不到就依物流退回（§8.1） | 建單時 48 小時 |
| `pickup_store_closed` | 門市關轉、尚未開店或查無取件門市（§6.3、§7.3） | 買家（零售商負責聯絡） | 買家重新選店；期限前未選 → 零售商聯絡買家或讓包裹退回 | 第 3 日 10:00 前 |
| `no_tracking_progress` | 交寄後 3 天無新貨態 | 出貨者 | 查詢；向物流查件；轉 `lost` | — |
| `uncollected` | 買家未取件或拒收（§6.3，例如 2074／3020、黑貓 3123 與 3117、郵局 3305） | 零售商 | 等退回；聯絡買家；依政策退款 | — |
| `lost` | 出貨者確認遺失，或物流回報遺失（§6.3） | 出貨者向物流理賠；零售商對買家 | 退款（EC-SPEC-04 §7）；重寄在 C4 | — |
| `damaged`、`partial_missing` | 買家回報；`damaged` 也可由物流回報破損（§6.3） | 零售商（必要時加出貨者）；物流回報破損時出貨者向物流理賠 | 售後（EC-SPEC-06）；退款 | — |
| `contradicting_event` | §6.1、§6.4；黑貓刪除已配達或退回狀態（3016、3017） | 零售商 | 依證據人工決定 | — |
| `carrier_attention` | §6.3 的物流異常代碼（包裝或包裹異常、協尋、超過驗收期限、賣家未取退回包裹、物流刪除託運單或取消訂單、宅配取件失敗等），或退回原因不明（§6.4） | 出貨者（零售商可見） | 出貨者依綠界訊息向綠界或物流查明並處理（例如到門市取回包裹、作廢後重新建單），附證據結案；包裹退回或寄不出去時，零售商決定買家的處理（聯絡、退款） | — |
| `return_inspection_due` | 退回已收件、未檢驗 | 收件的出貨者 | 檢驗（§8.3） | 7 天 |

例外的動作以 `POST …/exception-cases/:id/actions/:action` 執行（§9），伺服器依種類、責任方與呼叫者的角色檢查。出貨者（`view=executor`）可做的動作：

| 種類 | 出貨者動作 | 說明 |
| --- | --- | --- |
| 全部可見的種類 | `add_note` | 補充說明（≤ 500 字，零售商看得到；不放買家個資） |
| `shipment_create_unknown`、`no_tracking_progress`、`carrier_attention` | `resolve_with_evidence` | 附綠界後台或物流查件的證據（參考號、日期）結案 |
| `no_tracking_progress` | `mark_lost` | 確認遺失：結案並開 `lost` |
| `lost` | `record_claim` | 記錄向物流理賠的參考號與狀態；買家端的退款仍由零售商決定 |

其他動作走各自的命令，不在例外上重複：重新建單、查詢、請買家重新選店或更正地址在包裹（§5、§7.3、§7.4）；回報無法履約在履約單（§4.5）；檢驗在退回（§8.3）。零售商的動作是上表各種類的「下一個合法動作」，由 E 頁呼叫同一個路由。

### 7.3 門市關轉

- B2C：綠界以貨態通知（7-ELEVEN `2037`、全家與萊爾富 `7011`）並寄 Email 給商家；必須在**收到通知後第 3 日上午 10:00 前**更新門市（例：5/26 收到，5/28 10:00 前）[7410]。更新用 `Helper/UpdateShipmentInfo`（`AllPayLogisticsID`、`ReceiverStoreID`），回 `1|OK` [7410]。
- 店到店：綠界同樣以通知與 Email 告知；更新用 `Express/UpdateStoreInfo`（`AllPayLogisticsID`、`CVSPaymentNo`、`StoreType=01` 取件門市、`ReceiverStoreID`；7-ELEVEN 另需 `CVSValidationNo`；回 `1|OK`）[8907]。我們不改退貨門市（`StoreType=02`）。官方沒有寫明固定期限，C2 採用與 B2C 相同的內部期限。店到店的關轉代碼見 §6.3（7-ELEVEN 2092、2101、2103、2104；全家 7011；萊爾富 2028、2029、2037、2101、2103、2104、7011）。
- 流程：例外 `pickup_store_closed`（`due_at`＝官方期限前 2 小時）→ 買家在訂單頁看到「原取貨門市暫停服務，請重新選擇」→ 以綁定這個 shipment 的選店 session 重選（§3.6，`purpose=shipment_reselect`）→ 新的收件投影列 → operation `update_store` → 成功後結案。
- 期限前買家沒有選：零售商決定聯絡買家或任其退回；系統不自動挑門市。
- 建單時門市就已失效（EC-AT36）：shipment `create_failed`、例外 `pickup_store_invalid`，同一套重選流程，不假裝建單成功、不重複收費。

### 7.4 宅配地址無法使用

- 建單時綠界以 `0|錯誤` 拒絕收件地址或郵遞區號：shipment `create_failed`，出貨者選「請買家更正地址」→ 例外 `recipient_address_invalid`（`due_at` 48 小時）。出貨者不能自己改地址，也不聯絡買家。
- 買家在訂單頁看到「宅配地址無法使用，請更正」，送出新地址（`POST …/orders/:ref/shipments/:sid/address-correction`，§9.3）。檢查同 §3.5，而且必須留在原凍結的服務與運費區（本島／離島；中華郵政只送本島）；不合就不能更正，只能由零售商取消該群組並退款（§4.5）。
- 更正成功 → 新的收件投影列 → 出貨者依 §5.3 重試（先以舊編號查詢確認沒有建立，再用新編號建單）→ 例外結案。
- 交寄後物流才發現地址有問題：C2 不更改運送中的宅配地址（已核對的官方文件沒有這個 API），包裹依物流退回，走 §8.1。黑貓的地址錯誤與搬家代碼（3008、3009、7003，§6.3）也開這個例外，讓零售商先聯絡買家。

## 8. 退回與檢驗

### 8.1 未取件退回

- 買家未取件或拒收（§6.3 的 `uncollected` 代碼，例如 2074／3020）→ `returning`；店到店退回原寄件門市（7-ELEVEN 店到店可另設退貨門市）[8809]，寄件人憑證件取回（所以寄件人姓名必須是本人，§2.1）。
- 包裹退到寄件門市或寄件人（§6.3 的 `returned` 代碼，例如 7-ELEVEN 店到店 2072、2099，全家與萊爾富 3019、3031）或出貨者記錄已取回 → `returned`，自動建立 ReturnInspection（`awaiting_receipt` 或 `received`）。
- 零售商決定買家的處理：依政策退款（可扣運費，政策寫在 `shipping` 政策中）。C2 不提供同訂單重寄（§13）。

### 8.2 售後退貨（RMA）

- 是否接受退貨、退款金額由零售商在 EC-SPEC-06 決定。核准後買家才看到退回地址（出貨者的退回地址，§2.1）。
- C2 的退貨寄送由買家自行寄回並填寄件編號；綠界 B2C 逆物流 API（`ReturnUniMartCVS`、`ReturnCVS`、`ReturnHilifeCVS`、`ReturnHome`）[7408][8894][8896][7416] 在 C4。
- 退貨包裹到達 → ReturnInspection。

### 8.3 檢驗與回庫（ReturnInspection）

- `commerce_return_inspections`（ID 即 SL-04 路徑的 `return_id`）：來源（未取退回的 shipment，或 EC-SPEC-06 的 RMA）、收件的出貨者、零售商、狀態 `awaiting_receipt → received → inspected`、收件時間、檢驗者、說明。
- 行項（`commerce_return_inspection_lines`）：配置、收到數量、可再售數量、不可售數量；可再售＋不可售＝收到數量；收到數量 ≤ 該配置已出貨量 − 已回庫量。
- `received`：實物到了，先「待檢、不可售」，不動 N（EC-SPEC-03 §2.1）。
- `inspected`：一次定案，之後不可改；可再售的數量以 `restockReturn(returnRef = return_id)` 回庫，每個 (return_id, 配置) 只會加一次（EC-AT42、SC-LAT16）。不可售的只記結果，費用責任依同意（EC-SPEC-06 §5）。
- 檢驗者是收件的出貨者（直送時是供應商）；零售商看得到結果，據以決定退款。退款成功不會自動回庫，回庫也不代表已退款（計畫 §11.4、SC-LAT18）。
- 收件超過 7 天未檢驗 → 例外 `return_inspection_due`。

## 9. 頁面與 API

所有私有路由在 `/api/v1/tenants/:t/storefronts/:i/…` 之下，伺服器每次重新核對 tenant、instance、角色與出貨者（§4.1）；前端隱藏按鈕不是授權。委派給 Agent 的憑證另有限制（EC-SPEC-01 §1）。能力見 EC-SPEC-09 §2.2：`store:fulfil`（操作履約單與包裹）、`store:manage`（寄件地、出貨設定、代出貨同意）、`store:write`（商品配送屬性）。物流帳戶與金鑰只有 owner／admin 能改，並要重新輸入密碼。

### 9.1 賣家（E05、E06、E11）

| 路由（提議） | 用途 |
| --- | --- |
| `GET …/fulfilment-orders?view=retailer&state=&cursor=` | 本店訂單的履約單；`fulfilment` 頁 |
| `GET …/fulfilment-orders/:fo` | 履約單、包裹、例外；賣家看得到出貨者是誰與包裹狀態，看不到供應商的帳戶與運費成本以外的資料 |
| `POST …/fulfilment-orders/:fo/cancel` | 取消群組（§4.5） |
| `GET …/shipments?view=retailer`、`GET …/shipments/:sid` | `shipments` 頁 |
| `GET／PUT …/shipping-profile`、`GET／POST …/ship-from-locations`、`POST …/ship-from-locations/:id/retire` | `settings/shipping` |
| `GET／POST …/fulfilment-agreements`、`POST …/fulfilment-agreements/:id/withdraw`、`…/revoke` | 代出貨同意（賣家側） |
| `GET …/exception-cases?view=retailer`、`POST …/exception-cases/:id/actions/:action` | 例外處理 |

自出貨時，賣家同時是出貨者，使用 §9.2 的出貨者路由（`view=executor`）。

### 9.2 出貨者／供應商（SL-01～04）

| 路由（提議） | 用途 |
| --- | --- |
| `GET …/fulfilment-counts?view=executor` | SL-02 各分頁的數量與 SC-03 概覽的四個指標，同一個 snapshot（下面說明） |
| `GET …/fulfilment-orders?view=executor&tab=awaiting_acceptance\|preparing\|unable_reported\|history&cursor=`、`GET …/fulfilment-orders/:fo` | SL-02 的履約單分頁（§4.2） |
| `GET …/shipments?view=executor&tab=to_print\|to_hand_over\|in_progress\|done&cursor=`、`GET …/shipments/:sid` | SL-02 的包裹分頁與 SL-03；`in_progress`＝已交寄未結束，`done`＝已送達、已退回、已作廢 |
| `POST …/fulfilment-orders/:fo/accept`、`…/unable`、`…/unable/withdraw` | 接受、回報無法履約（§4.5 的原因代碼）、撤回回報 |
| `GET …/fulfilment-orders/:fo/recipient` | 收件資料（§4.4，每次留 receipt） |
| `POST …/fulfilment-orders/:fo/shipments` | 建立包裹草稿 |
| `POST …/shipments/:sid/provider-order`、`…/query`、`…/print-sessions`、`…/handover`、`…/void` | SL-03 |
| `POST …/shipments/:sid/recipient-fix-requests` | `kind` 為 `pickup_store_invalid` 或 `recipient_address_invalid`；只限 `create_failed` 的包裹；開對應例外，請買家重新選店或更正地址（§7.3、§7.4） |
| `GET …/exception-cases?view=executor&state=open\|closed&cursor=`、`GET …/exception-cases/:id`、`POST …/exception-cases/:id/actions/:action` | SL-04 的例外；動作見 §7.2 的出貨者動作表 |
| `GET …/returns?state=&cursor=`、`GET …/returns/:rid`、`POST …/returns/:rid/receive`、`POST …/returns/:rid/inspection` | SL-04 的退回與檢驗 |
| `GET／PUT …/shipping-profile`、`GET／POST …/ship-from-locations`、`POST …/ship-from-locations/:id/retire` | SL-01（同 §9.1；路由不分賣家或供應商，依呼叫者自己的店） |
| `GET／POST …/fulfilment-agreements`、`POST …/fulfilment-agreements/:id/decision`、`…/revoke` | 代出貨同意（供應商側：接受確切的 `terms_sha256` 或拒絕；已接受後撤銷，只影響之後的結帳，§2.6） |
| `GET／PUT …/products/:pid/shipping-attributes` | SC-05 的「配送」分區 |

`GET …/fulfilment-counts?view=executor`：一個唯讀交易（`REPEATABLE READ`）內算完，回 `{status:'ready', as_of, tabs:{awaiting_acceptance, preparing, to_print, to_hand_over, exceptions, unable_reported}, overview:{to_process, ship_by_overdue, delivery_exceptions, returns_to_inspect}}`；超過 2 秒或失敗回 `{status:'unavailable', reason}`，畫面顯示「無法取得」，不顯示 0（同 E02）。概覽指標的定義：

| 指標 | 中文 | 定義（出貨者＝本事業） |
| --- | --- | --- |
| `to_process` | 待處理出貨 | `awaiting_acceptance`，或 `accepted` 且還有未交寄數量的履約單數 |
| `ship_by_overdue` | 逾期備貨 | `accepted`、還有未交寄數量、`coalesce(revised_ship_by, ship_by)` 早於 `as_of` 的履約單數（與例外 `ship_by_overdue` 同條件；例外由排程開立，可能晚幾分鐘） |
| `delivery_exceptions` | 配送例外 | 關聯到本事業包裹的 `open` 例外數（不分責任方） |
| `returns_to_inspect` | 退件待檢 | 本事業收件、狀態 `received` 的退回數 |

Supplier Console 實作供應商頁面與讀取投影時，欄位只能來自這份白名單：

- 履約單：ID、零售商店名、訂單顯示編號、狀態、`accept_by`、`ship_by`、`revised_ship_by`、無法履約的原因代碼與說明、行項（SKU、名稱、選項、數量）、供貨單價（來自 offer）、服務與解析出的物流帳戶（唯讀）、寄件地、同意版本、包裹。**不含**零售價、折扣、買家付款金額、其他群組、付款資訊。
- 收件資料：只能透過 `GET …/recipient`（Commerce 的閘門與 receipt），不得直接查表。
- 包裹：單號、子類型、狀態與事件時間線（正規化後）、列印次數、本事業的實際運費。
- 例外：關聯到本事業履約單或包裹的例外，不含零售商的內部說明。

### 9.3 買家（B05、B07）

| 路由（提議） | 用途 |
| --- | --- |
| `POST /api/v1/public/stores/:slug/cvs-selection-sessions` | 建立選店 session（checkout 憑證或訂單憑證） |
| `POST …/checkouts/:ref/cvs-selection` | 結帳時附上門市（§3.6） |
| `POST …/orders/:ref/shipments/:sid/cvs-selection` | 門市失效或關轉後重選（§7.3） |
| `POST …/orders/:ref/shipments/:sid/address-correction` | 更正宅配地址（§7.4）；只在該包裹有 `open` 的 `recipient_address_invalid` 時接受 |
| `GET …/orders/:ref` | EC-SPEC-02 的訂單讀取，加上每個包裹：狀態、物流公司、門市名稱與地址、宅配託運單號、事件時間線 |

買家看不到出貨者是誰、店到店的寄件代碼（`CVSPaymentNo` 是寄件用，不是追蹤用）與任何費用成本。

### 9.4 伺服器頁與機器路徑

| 路徑 | 說明 |
| --- | --- |
| `GET /ship/ecpay/map/{token}` | 自動送出到 `Express/map`；CSP `form-action` 只加物流主機 |
| `POST /ship/ecpay/map-return/{session_ref}` | 綠界讓瀏覽器帶回門市（未簽章）；只暫存、303 回原頁 |
| `GET /ship/ecpay/print/{token}` | 自動送出到列印端點；一次性、綁 session |
| `POST /api/v1/provider-callbacks/ecpay/{account_ref}/logistics` | 貨態通知（§6.1） |

`/ship/` 下是伺服器產生的 HTML，不是 SPA 的 hash 路由；CSP 只能依 HTTP 路徑區分，所以要有獨立路徑（同 EC-SPEC-04 §4.1）。

## 10. 程式位置、migration 與能力

- 綠界物流的 MD5 CheckMacValue、表單與 `1|…`／`0|…` 回應解析：協定程式庫 `modules/agent-commerce/providers/ecpay/`（EC-SPEC-04 §10，descriptor `commerce-providers`）。各端點的欄位組裝與回應解析（建單、通知、查詢、列印表單、選店、7-ELEVEN 取消、改門市）在 `ecpay/domestic-logistics/`（profile `ecpay.logistics.domestic.v1`，已完成；README 說明每個匯出）。CDN 字詞檢查 `findCdnBlockedTerm` 由 `ecpay/index.ts` 匯出，給領域檢查使用者輸入與自產的參照。
- 領域、routes、outbox：提議 `modules/agent-commerce/fulfilment/`，新 descriptor（module `commerce-fulfilment`，相依 `hosted-checkout`、`commerce-providers`）。`ExceptionCase` 的程式在 `modules/agent-commerce/checkout/`。
- 契約：`contracts/guild-launchpad/v1/` 下新檔（例如 `hosted-fulfilment.ts`、`hosted-shipping.ts`），不改既有 v1 契約。
- M3（履約）：§1.3 的表；RLS（寄件地、收件投影、選店 session 屬於個資或與個資相連；物流事件只存允許欄位）；不可刪與只前進的 trigger；包裹數量的 deferred trigger；`commerce_exception_cases` 的物流種類；`catalog.ts` 登錄與豁免理由；新增 migration 的全部登錄點（WP-00）。
- 能力 `commerce.hosted-fulfilment.v1` 與強制下限跟物流回呼路由同一個 migration 上線；之後回退到不認得回呼的 binary 會漏接貨態，所以不能回退（EC-SPEC-10 §7）。
- Worker 需要的設定：回呼路徑的 Access 排除（staging）、查詢與 operation 的排程（cron），都由 Ted 操作。
- 搬遷（C3）：每個 shipment 的 `ServerReplyURL` 在建單時就固定，舊網址在包裹結束前仍會收到通知；轉交方式在 EC-SPEC-08（EC-AT60）。
- 備份與匯出：履約、包裹、事件、檢驗都屬於零售商或出貨者的業務資料，依 `catalog.ts` 的 tenant 解析匯出；匯出給供應商的資料不含零售商的顧客資料（SC-LAT22）。還原後先以查詢核對進行中的包裹，再開放新操作（EC-SPEC-10 §8.4、T-047）。

## 11. 外部驗證的分層（需要 Ted 授權）

| 層 | 內容 | 授權 |
| --- | --- | --- |
| 向量與契約 | 官方物流 MD5 範例 [7424]、查詢範例與勘誤 [7418]、`1|`／`0|` 解析、禁用字元與位元組長度、負面案例；Node 與 workerd 結果一致 | 不需要（不連線） |
| stage sandbox | C2C `2000933`、B2C／宅配 `2000132` [7398]；地圖回固定門市 [8795]；建單、查詢、列印；stage 沒有貨態通知 [7420]，交寄以人工紀錄驗證。順便核對文件沒寫清楚的事：重複 `MerchantTradeNo` 的回應；查無訂單時 V5 查詢的回應；查詢回應的簽章欄位範圍（§6.2）與店到店 `LogisticsType` 的寫法（`CVS_UNIMARTC2C` 或 `CVS_UNIMART`）；門市失效時的錯誤訊息；地圖回傳的字元集與門市代號長度（欄位 9、建單 6，§3.6）；宅配地址長度的單位（字、UTF-16 或位元組）；呼叫太快的 HTTP 403（要等 30 分鐘 [7400]）與 CDN 擋下如何分辨；沒有 shell 字元的單獨字詞（`echo`、`tftp`）是否真的被擋；店到店過了有效日的處理（§5.5） | 需要：連線綠界 stage |
| 正式受控試寄 | 一個真實商家帳戶：店到店與宅配各一包，從建單、列印、交寄到取件；可加一包未取退回 | 需要：Ted＋該商家；真實運費 |

stage 的固定門市（7-ELEVEN `131386`、全家 `006598`）[8809] 只用於 sandbox。拿到物流單號或 HTTP 200 不代表已交寄或送達（Supplier v1.1 §9）。

## 12. 測試（全部 not_run）

| 案例 | 驗收 |
| --- | --- |
| 同店 A 供貨直送＋B 自有：兩個群組、兩段運費、預計出貨日，付款前可見；總額可核對 | EC-AT10、SC-LAT04 |
| A 只同意供貨價、沒有代出貨同意：A 的商品不可結帳，B 的自有商品可以；A 看不到任何地址 | EC-AT11、SC-LAT03 |
| 冷凍或超尺寸商品、超商金額 > 20,000、離島不配送、群組沒有共同方式：收款前拒絕並說明 | EC-AT12、SC-LAT02 |
| 超商離島：有 `CVSOutSide` 就照它；萊爾富店到店沒有，依門市地址（「屏東縣琉球鄉」是離島、「琉球路」「金門街」不是）；離島門市照 `outlying` 拒絕或加價 | EC-AT12、SC-LAT02 |
| 未授權的賣家或其他 tenant 改供應商的寄件地與出貨設定：拒絕，舊版本保留 | EC-AT33、SC-LAT01 |
| 一單兩包，只有 A 包送達：B 包未完成，訂單不顯示全部完成 | EC-AT34、SC-LAT12 |
| 選店：A checkout 的 session 回傳給 B checkout、換子類型、換環境、過期、重用 → 拒絕且不回顯門市 | EC-AT35 |
| 建單時門市失效（`0|`）：`create_failed`＋重選，不假成功、不重複收費 | EC-AT36、SC-LAT14 |
| 建單時宅配地址被拒：`create_failed`＋請買家更正；更正超出原服務或運費區被拒；更正後先查舊編號再建單，不出現第二張託運單；出貨者不能直接改地址 | EC-AT41、SC-LAT14 |
| 供應商撤銷已接受的代出貨同意：之後的結帳回 `fulfilment_not_agreed`；已建立的履約單照常出貨、讀收件資料與處理退回 | EC-AT11、SC-LAT03 |
| 建單逾時：查詢找到原單、不建第二張；查無時不自動重建，人工重建沿用同一編號；SQL 鎖不等外部 | EC-AT37、SC-LAT07 |
| 重印同一單號、無新 operation；無權者、撤權後、期限後都拒絕；不產生公開網址 | EC-AT38、SC-LAT09、13 |
| 只列印不交寄：N、A 不變；交寄後才扣 | EC-AT39、SC-LAT10 |
| 已到店 → 晚到的運送中 → 七天未取：不倒退，進入退回；三筆事件都保存 | EC-AT40、SC-LAT11 |
| 貨態代碼表：程式表與 TSV 逐列相同；`5004` 依物流意思不同；可能重新配送的代碼只開例外；退回原因不明開 `carrier_attention`；`delivered` 後的例外碼改開 `contradicting_event`；`ops_review` 與無法對應的代碼進每日清單 | EC-AT40、SC-LAT11 |
| 兩包其中一包遺失：例外有責任方、下一步、期限；賣家與供應商畫面一致 | EC-AT41、SC-LAT15 |
| 退回到達先不可售；檢驗合格 1 件只回庫一次；退款不回庫 | EC-AT42、SC-LAT16 |
| A、B 兩個供應商各一包：A 只讀得到自己那包的收件資料與行項 | EC-AT43、SC-LAT05 |
| 任何地方都選不到貨到付款 | EC-AT44、SC-LAT21 |
| 已付款超過 30 分鐘：配置不被釋放；交寄扣一次 | EC-AT27、28、SC-LAT20 |
| 物流通知：MD5 正確才處理；重送三次只套用一次；提交失敗不回 `1|OK`；收件人欄位不進資料庫與日誌 | EC-AT40、SC-LAT11 |
| 供應商指向別人的帳戶建單：拒絕，任務不標成功 | SC-LAT08 |
| 供應商回報無法履約：賣家拿到可處理的例外；供應商不能取消或退款 | SC-LAT06、17 |
| 付款未 `confirmed`：不能建單、列印、交寄 | EC-AT27（與 EC-SPEC-04） |
| 服務未開通、B2C 未測標：不出現在選項，也不能建單 | EC-AT68 |
| 既有 offer、selection、acceptance 的 ID 不變；沒有第二套訂單或庫存 | SC-LAT23 |
| SL-02 計數：六個分頁（歷史不計數）與四個概覽指標來自同一個 snapshot；讀取失敗回 `unavailable`，畫面不顯示 0；一張履約單同時在「備貨中」與「待印單」 | SC-LAT04、SC-LAT12 |
| 已付款的直送單建立後，賣家撤銷代出貨同意：新結帳被拒；既有履約單仍可讀收件資料、建單、列印、交寄 | SC-LAT13、EC-AT11 |
| 回報無法履約：六個原因代碼；`other` 沒有說明被拒；賣家 `wait` 設定新日期後逾期改用新日期；出貨者撤回回報自動結案；沒有改派或換貨的路由 | SC-LAT06 |
| 作業日（週一到週五、處理 1 天）：週一 `cutoff_time` 之前確認 → 週二 23:59:59；週五 `cutoff_time` 之後或週六確認 → 下週二 23:59:59（Asia/Taipei） | EC-AT10 |
| 同公會賣家讀代出貨方案：沒有任何地址、電話、姓名或帳戶；同意 `accepted` 後賣家才看得到退回地址 | SC-LAT05、SC-LAT01 |
| 建單命令帶帳戶參數 → 400；帳戶由（出貨者、環境、服務）解析；shipment 記下帳戶，之後的查詢與列印用同一個 | SC-LAT08 |
| C2 沒有委派憑證：任何不是會員 session 的憑證（`fw_read_` token、Agent 上傳 token、`/shop-api/v1/` 金鑰）呼叫收件資料、列印 session、建單、作廢與出貨設定的路由 → 401／403、沒有副作用（EC-SPEC-09 §2.8） | SC-LAT01、SC-LAT13 |

測試用隔離 PostgreSQL、barrier 與 DB 時鐘；provider 用本機的假 HTTP 伺服器回放官方格式，不連綠界。

## 13. 仍待決

| 項目 | 建議 | 只影響 |
| --- | --- | --- |
| DC03 首發配送 | 黑貓宅配常溫＋一條店到店（依第一位商家已開通的連鎖） | 其他子類型；B2C 需要測標 |
| 同訂單重寄（未取、遺失後） | C2 不提供；改為退款，買家可重新下單 | 重寄需要「不扣庫存的包裹行項」，C4 另立 |
| 供應商收件資料保留 | 送達或退回後 14 天（同意可設 ≤ 30） | 隱私承諾（DC12） |
| 直送接受期限 | 24 小時 | 例外 `fulfiller_unresponsive` 的時間點 |
| 離島 | 預設不配送；店家可開並加價 | 離島買家 |
| live 人工交寄 | 允許，3 天無貨態開例外 | 交寄證據的強度 |
| 逆物流 API、COD、冷鏈 | C4 | 對應的 profile |
| stage 連線授權 | 需要 Ted | sandbox 端到端驗證；不影響向量與契約測試 |
