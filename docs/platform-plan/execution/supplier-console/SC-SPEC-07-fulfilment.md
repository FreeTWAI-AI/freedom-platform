# SC-SPEC-07 履約、寄件與退回頁面（v1.1 補充）

依據：《Freedom Supplier Console v1.1 物流、履約與售後補充計畫》（2026-10-15，隨 Commerce 規劃包提供，見 [sources.md](sources.md)）。需求：SC-L01～SC-L18。驗收：SC-LAT01～SC-LAT24。里程碑：Commerce C2。全部 planned／`not_run`。

名稱已對齊 Commerce 規格 fd973423（2026-10-15，`feat/freedom-commerce`，本機）：EC-SPEC-01 §6.3、EC-SPEC-05、EC-SPEC-06 §5、§8.3 與 Commerce 的 decisions.md。那些檔案還不在本分支，所以下文只寫章節，不放連結。路由與能力名稱仍標「提議」，能力在 EC-SPEC-09 §2 定案；程式契約提交後再核對一次（§6）。

## 目的與非目標

- 定義 SL-01～SL-05 五個頁面在營運中心裡的位置、操作、權限、狀態、未知結果與反例，以及和賣家端 E 頁面的對應。
- 原 v1.0 的 SC-R01～40、AT-01～48 與 R1 範圍不變。Supplier R1 通過不代表物流完成；Commerce C2 也不能只引用 R1 的通過就宣稱能代出貨。兩者各自驗收，共用同一份資料與領域服務。
- 非目標：第二套訂單、庫存、登入或物流後台；平台代收款、分帳或錢包；沒有開通的物流服務、COD、冷鏈、跨境的假按鈕。
- 本文件不定義型別、資料表或 migration。ShipFromLocation、ShippingProfile、ProductShippingAttributes、FulfillmentAgreement、FulfillmentOrder、Shipment、TrackingEvent、ExceptionCase、ReturnInspection 與供貨帳是計畫用語，表與契約以 Commerce 為準（EC-SPEC-05 §1.3、EC-SPEC-06 §5）。程式識別字一律拼成 `fulfilment`：`fulfilment_order_id`、TypeScript 型別 `FulfilmentOrder`、`FulfilmentAgreement`、契約檔 `hosted-fulfilment.ts`。
- 本文件不授權寄件、建立物流單、扣款、開立發票、部署或接觸正式客戶。

## 1. 分工

2026-10-15 與 Commerce 工作階段確認：

| 範圍 | 負責 | 說明 |
| --- | --- | --- |
| EC-SPEC03 訂單與庫存 | Commerce | 已付款配置（paid allocation）與「available = 實體量 − 短期預留 − 已付款未出貨配置」由唯一庫存服務處理。`supplier-console/reads.ts` 的可用量只在 `own` CTE 的 `available` 一欄計算；v1 DTO 的 `reserved` 仍代表全部占用量時不需修改，規則改變時由 Commerce 一併更新這一欄。Commerce 的讀取 `inventoryPositions(q, itemIds)`（`modules/agent-commerce/hosted/inventory.ts`，已在 Commerce `fc/wp03-core` 的 16caa586 核對，2026-10-15，本機）回每件商品的 `stock`、`held`（短期預留）、`allocated`（已付款未出貨的配置）與 `available`；`reserved` 等於 `held` 加 `allocated`，不一致時回 409 `reservation_inconsistent`。這個讀取不授權也不綁 tenant，呼叫端要先確認商品屬於自己的事業；`available` 仍算入已逾期但尚未結算的預留。 |
| EC-SPEC05 物流與履約 | Commerce | 領域服務、資料表、狀態轉移命令與授權檢查（tenant／instance／出貨者）、provider adapter、callback 與 Shipment 生命週期；SL-01 的寄件地與退回地址、出貨設定、商品配送屬性與代出貨同意的資料結構也在這裡。 |
| EC-SPEC06 發票與售後 | Commerce | 退貨決策、退款、發票更正與供貨帳（帳目、對帳單、調整）。 |
| SL-01～05 頁面、供應商用途的讀取投影與路由 | Supplier Console | 放在 `modules/agent-commerce/supplier-console/`。投影欄位只用 EC-SPEC-05 §9.2 與 EC-SPEC-06 §5.5 的白名單；收件資料只經 Commerce 的授權讀取取得，不進投影。在 Commerce 的程式契約 commit 之前只寫規格；不建立 FulfilmentOrder、Shipment 或付款相關的型別、表或 migration。 |
| 共用前端檔案 | Supplier Console | `HostedStore()` 的路由分派、App 的離開保護與通用的 `ConsoleShell`；Commerce 需要修改時先協調。 |

SL-WP01～04 是 EC-WP05／06 的責任細分，不是新團隊、新排程或新看板；不為它們另開 Issue。

## 2. 在營運中心的位置

SL 頁面放進既有的側欄資料清單（SC-SPEC-01），不另建需要重新登入的物流後台。頁面實作並能讀到真實資料後才加入導覽；在那之前這些路徑一律顯示「找不到這個頁面」，不放「即將推出」。

「被指派」的意思（EC-SPEC-05 §4.1）：建立履約單時寫入的出貨者是本事業，而且使用者在本事業有 `store:fulfil`。C2 沒有指派到個人，也沒有改派；指派到個人在 C4。

| 群組 | 頁面 | 預計路徑（`#stores/<tenant>/<instance>/supply/…`） | 出現條件（能力為提議） |
| --- | --- | --- | --- |
| 營運 | SL-02 出貨工作台 | `fulfilment`；履約單 `fulfilment/<fulfilment_order_id>` | `store:fulfil` |
| 營運 | SL-03 包裹與託運單 | `shipments/<shipment_id>`（從履約單或分頁進入，不另列導覽） | `store:fulfil`，且包裹屬於本事業出貨的履約單 |
| 營運 | SL-04 例外與退回 | `exceptions`；例外 `exceptions/<case_id>`；退回 `returns/<return_id>` | `store:fulfil` |
| 管理 | SL-01 履約與寄件設定 | `fulfilment-settings` | `store:read` 以上只看有限資訊（是否已設定、版本、服務是否開通）；地址內容需 `store:manage` 或 `store:fulfil`；修改寄件地、出貨設定與代出貨同意需 `store:manage` |
| 管理 | SL-05 費用與交易文件 | `settlements` | `store:settlements` |

路徑名稱在實作時加入 `route.ts` 的同一份頁面清單，ID 以 Commerce 契約的穩定 ID 為準，並沿用 `OpaqueId` 檢查與「先切 path 與 query」的規則。

委派給 Agent 的憑證在 C2 一律不能讀收件或聯絡資料、開標籤列印、建立或作廢託運單、退款、取消已付款的訂單或行項、作廢發票或開折讓，也不能修改寄件地、出貨設定、物流帳戶、代出貨同意或政策；任何委派範圍都打不開（Commerce decisions.md、EC-SPEC-01 §1）。Agent 只能讀不含個資的清單與狀態、準備草稿，由成員在自己的 session 確認後送出。

## 3. 頁面

所有私有路由在 `/api/v1/tenants/:t/storefronts/:i/…` 之下（EC-SPEC-05 §9.2、EC-SPEC-06 §8.3，皆為提議）；伺服器每次重新核對 tenant、instance、角色與出貨者，前端隱藏按鈕不是授權。

### SL-01 履約與寄件設定

- **寄件地與退回地址**（`GET／POST …/ship-from-locations`、`POST …/ship-from-locations/:id/retire`）：名稱、寄件人姓名、手機、市話（可選）、郵遞區號、地址、用途（寄件、收退回）。每次修改新增一筆、舊的停用，訂單與同意指向當時那一筆。店到店的寄件人必須是本人真實姓名（未取件退回要在門市出示證件），設定頁寫明原因。
- **出貨設定**（`GET／PUT …/shipping-profile`，`freedom.shipping-profile/v1`，每次儲存一個新版本）：
  - `services[]`：`service_key`、`ship_from_location_id`、`temperature`（C2 只有常溫 `ambient`）、`handling_days`（1～14 個作業日）、`cutoff_time`、包裹限制、`outlying_islands`。
  - `working_days`：ISO 星期 1～7，預設週一到週五。`ship_by` 由 Commerce 依作業日與截單時間計算，頁面只顯示結果。
  - 沒有「包裝」欄位：裝箱限制由包裹限制與商品配送屬性表達，禮品包裝在 C4。
  - 物流帳戶不在設定裡：伺服器依（出貨者商店、環境、`service_key`）解析唯一可用的帳戶，畫面只唯讀顯示；命令不收帳戶參數（SC-LAT08）。只列已開通的服務；沒有時寫明「尚未開通可用的物流服務」，不提供假選項。
- **代出貨方案**（出貨設定裡的 `drop_ship`，選填）：`offered`、`fees[]`（每個服務一筆 `{service_key, fee_per_parcel_minor}`，每個已交寄包裹的代出貨費，已包含物流費，沒有另外的運費補貼）、`return_location_id`、`liability`、`recipient_retention_days`（1～30）、`accept_within_hours`（1～72，預設 24）。同公會賣家看到的是公開投影 `DropShipOfferSchema`，不含地址、電話、寄件人姓名或物流帳戶；退回地址要等同意 `accepted` 後賣家才看得到。
- **代出貨同意**（`GET／POST …/fulfilment-agreements`、`POST …/fulfilment-agreements/:id/decision`、`…/revoke`）：對賣家申請的確切 `terms_sha256` 接受或拒絕，接受後也可以撤銷（記錄發起者與原因）。畫面列出凍結的內容：
  - 商品清單、服務與每包代出貨費；
  - `cancel_after_create_fee_minor`、`return_handling_fee_minor`、`unsellable_return_default`、`payment_due_days`（預設 30）；
  - 寄件地與退回地址的版本、處理天數與作業日；
  - 例外責任、收件資料用途與保留天數。

  接受時要求確認「每包代出貨費取代供貨條件中按件計算的 `shipping_minor`」。狀態 `proposed → accepted／declined／withdrawn`；`accepted → revoked`（任一方）或 `superseded`。`revoked` 與 `superseded` 只擋之後的結帳（涵蓋的商品在新結帳不能購買，賣家看得到原因），已建立的履約單照凍結的版本完成；撤銷前的確認對話框寫明這一點。供應商不想再處理已建立的單時，逐筆回報無法履約（SL-02）。售價同意不是代出貨同意（SC-07 的固定說明）。
- **規則**：每個欄位真的保存並有版本；寫入沿用 SC-SPEC-02 的 attempt（Idempotency-Key、If-Match、未知結果用原內容重試、412 保留草稿）。欄位還沒有後端時不出現、也不在畫面暫存。
- **權限**：見 §2。賣家、公會長與 Agent 都不能修改（SC-LAT01）。地址只在需要的頁面出現，不進公會區塊、公開頁或分享卡片。
- **對應**：賣家端 E11（配送政策與 provider 帳戶）。
- **需求／驗收**：SC-L01、L02、L03、L15／SC-LAT01、02、03、21。

### SL-02 出貨工作台

- **分頁**（EC-SPEC-05 §4.2；出貨者＝本事業）：

  | 分頁 | `tab` | 每一列 | 讀取 |
  | --- | --- | --- | --- |
  | 待確認 | `awaiting_acceptance` | 履約單 | `GET …/fulfilment-orders?view=executor&tab=…` |
  | 備貨中 | `preparing` | 履約單（還有數量不在已建單的包裹裡） | 同上 |
  | 待印單 | `to_print` | 包裹（已建單、還沒列印） | `GET …/shipments?view=executor&tab=…` |
  | 待交寄 | `to_hand_over` | 包裹（已建單、已列印） | 同上 |
  | 例外 | `exceptions` | 例外（責任方是出貨者） | `GET …/exception-cases?view=executor&state=open` |
  | 已回報無法履約 | `unable_reported` | 履約單 | `GET …/fulfilment-orders?view=executor&tab=…` |
  | 歷史 | `history` | 履約單（已全部交寄或已取消） | 同上 |

  同一張履約單可以同時出現在「備貨中」和「待印單」。各分頁的數量來自 `GET …/fulfilment-counts?view=executor`：同一個 snapshot，`unavailable` 時顯示「無法取得」，不顯示 0。
- **操作**：
  - 接受（`POST …/fulfilment-orders/:fo/accept`）。
  - 回報無法履約（`…/unable`）：原因代碼與畫面用詞見下表；說明最多 500 字，提醒不要寫買家個資；可改期的原因可附 `expected_ship_date`。

    | `reason` | 畫面用詞 | 可改期 |
    | --- | --- | --- |
    | `out_of_stock` | 實際缺貨 | 是 |
    | `damaged_stock` | 貨品瑕疵或損壞 | 是 |
    | `discontinued` | 已停產、不再供應 | 否 |
    | `cannot_meet_ship_by` | 無法在期限內交寄 | 是 |
    | `carrier_unavailable` | 物流服務暫停或無法寄送此包裹 | 是 |
    | `other` | 其他（說明必填） | 是 |

  - 撤回回報（`…/unable/withdraw`）：回到 `accepted`。
  - 建立包裹草稿（`POST …/fulfilment-orders/:fo/shipments`，預設全部剩餘量）。
- **付款門檻**：付款還沒確認時顯示「付款確認中，請先不要出貨」；仍可接受任務與備貨，但建單、列印與交寄由伺服器拒絕。
- **收件資料**：只經 `GET …/fulfilment-orders/:fo/recipient` 讀取，每次留 receipt；只有收件人姓名、手機、配送方式與門市或宅配地址。超過保留期限回 403，畫面顯示「收件資料已到期」。
- **資料白名單**（EC-SPEC-05 §9.2）：履約單 ID、零售商店名、訂單顯示編號、狀態、`accept_by`、`ship_by`、`revised_ship_by`、無法履約的原因與說明、行項（SKU、名稱、選項、數量）、供貨單價、服務與解析出的物流帳戶（唯讀）、寄件地、同意版本、包裹。不顯示零售價、折扣、買家付款金額、其他群組、付款資訊或整張購物車。這是賣家端同一份 FulfilmentOrder／Shipment ID 的投影，不另造供應商訂單。
- **權限**：使用者失去本事業的 `store:fulfil`、履約單取消、超過收件資料期限或資料已遮罩後，新的讀取與列印一律拒絕，也不會帶出另一包的地址（SC-LAT13）。代出貨同意 `revoked`／`superseded` 不影響已建立的履約單。
- **狀態**：回報無法履約後，賣家選擇等候改期（`wait`，最多 30 天，畫面顯示「賣家同意等候至 {日期}」，逾期改用這個日期判斷）或取消行項並退款（`cancel_lines`）；沒有換貨或替代品。供應商畫面沒有取消整張訂單或退款的按鈕（SC-LAT06、17）。供應商已記錄的交寄事實不因賣家畫面重讀失敗而消失。
- **對應**：E05 訂單詳情、E06 出貨與包裹。
- **需求／驗收**：SC-L05、L09、L10／SC-LAT05、06、13。

### SL-03 包裹與託運單

- **操作**（`POST …/shipments/:sid/provider-order`、`…/query`、`…/print-sessions`、`…/handover`、`…/void`；讀取 `GET …/shipments/:sid`）：
  - 建立託運單：服務是結帳時凍結的，帳戶由伺服器解析，畫面都只唯讀顯示。
  - 查詢。
  - 列印與重印同一張標籤：列印頁一次性、5 分鐘內有效、綁定目前的會員 session。
  - 記錄交寄：可填門市收據號碼或託運單號。
  - 作廢：只有還沒交寄的包裹可以作廢。
- **狀態文字**：只用 EC-SPEC-05 §5.1 的「出貨者看到」欄，和賣家的 E06 共用：包裹草稿、建立託運單中、結果確認中、建立失敗（原因）、待列印／待交寄、已交寄、運送中、已到店待取、已送達、退回中、已退回，待收件／待檢驗、已作廢。「配送異常」不是狀態，只在包裹有未結例外時顯示。
- **規則**：
  - 一個實際包裹對應一個穩定的 Shipment。
  - 建單結果不明時先用原交易編號查詢，不換號重建。連續查無超過 30 分鐘後，才可以「重新建立」，而且沿用同一個交易編號；正式環境先請出貨者在物流商後台確認沒有這張單。
  - 重印不重新付費、不產生新單。平台不保存標籤檔案，沒有公開網址。
  - 列印標籤不等於交寄，也不扣實體庫存；只有交寄事實才由唯一庫存服務扣量（SC-LAT10）。拿到物流單號或 HTTP 200 不等於已交寄或已送達。
  - 畫面顯示單號、子類型、狀態與事件時間線、列印次數和本事業的實際運費。
- **貨態**：由共用物流服務驗證、去重後的事件；頁面只讀。亂序事件不讓狀態倒退，合法的退回流程保留（SC-LAT11）；一張訂單多包時逐包顯示，不把部分送達說成全部完成（SC-LAT12）。用不可用的帳戶或服務建單會被拒絕，任務不被標成成功（SC-LAT08）。
- **對應**：E06。
- **需求／驗收**：SC-L06、L07、L08／SC-LAT07～12。

### SL-04 例外與退回

- **例外**（`GET …/exception-cases?view=executor&state=open|closed`、`GET …/exception-cases/:id`、`POST …/exception-cases/:id/actions/:action`）：
  - 每筆顯示種類、責任方（`retailer`／`executor`／`buyer`）、下一個合法動作與期限；不顯示零售商的內部說明。
  - 出貨者可做的動作只有四個：
    - `add_note`：補充說明，最多 500 字，不放買家個資。
    - `resolve_with_evidence`：用於 `shipment_create_unknown`、`no_tracking_progress`。
    - `mark_lost`：用於 `no_tracking_progress`。
    - `record_claim`：用於 `lost`，記錄向物流理賠的參考號與狀態。
  - 其他動作走各自的命令，不在例外上重複：重新建單、查詢與請買家重新選店或更正地址在包裹，回報無法履約在履約單，檢驗在退回。
- **門市或收件地址被拒**：建單時物流商拒絕門市，或拒絕宅配收件地址與郵遞區號，包裹是「建立失敗」。出貨者在包裹選「請買家重新選店」或「請買家更正地址」（`POST …/shipments/:sid/recipient-fix-requests`，`kind` 為 `pickup_store_invalid` 或 `recipient_address_invalid`，只限建立失敗的包裹）。由買家更正、零售商負責聯絡，期限 48 小時；出貨者不能自己改地址，也不聯絡買家。新地址必須留在結帳時凍結的服務與運費區，否則由零售商取消該群組並退款。更正後先以舊編號查詢，再建新單；不假成功、不重複扣費（SC-LAT14）。寄件資料或設定錯誤是另一種例外 `shipment_create_failed`，由出貨者修正後重試。交寄後才發現地址問題時，C2 不改運送中的地址，包裹依物流退回。
- **其他例外**：延遲、遺失、未取等由例外顯示責任方與下一步，買家端不被告知已完成（SC-LAT15）。
- **退回**（`GET …/returns?state=`、`GET …/returns/:rid`、`POST …/returns/:rid/receive`、`POST …/returns/:rid/inspection`）：
  - 狀態 `awaiting_receipt → received → inspected`。收到後先「待檢、不可售」。
  - 檢驗一次定案：可再售的數量一次回庫，不可售的只記結果，費用責任依代出貨同意（SC-LAT16）。
  - 收件超過 7 天未檢驗會開例外 `return_inspection_due`。
- **權限**：只處理本事業出貨的包裹與退回。供應商不做售後決定，也不直接和買家對話。零售退款、發票與客戶溝通由有權的賣家在 E07／E09／E10 處理。
- **對應**：E05、E06、E09。
- **需求／驗收**：SC-L10、L11、L14／SC-LAT14～16、20。

### SL-05 費用與交易文件

這是供貨帳的收款方畫面（EC-SPEC-06 §5、§8.3）：只記錄、不動錢，不是平台錢包；B2B 交易文件不是零售發票，平台在 C2 不開立 B2B 發票。

- **讀取**：對帳單清單（`GET …/settlement-statements?role=payee`）、對帳單明細（`GET …/settlement-statements/:stid`）、還沒進對帳單的帳目（`GET …/settlement-entries?role=payee`）。
- **帳目種類**（畫面用詞與 E09 共用，唯一來源是 EC-SPEC-06 §5.3）：

  | 種類 | 畫面用詞 | 何時產生 |
  | --- | --- | --- |
  | `supply_cost` | 供貨款 | 交寄 |
  | `parcel_fee` | 代出貨費 | 交寄（每個包裹一次） |
  | `cancelled_parcel_fee` | 已建單作廢費 | 零售商取消、已建單的包裹作廢 |
  | `return_credit` | 退回回庫扣抵 | 檢驗定案的可再售數量 |
  | `return_handling_fee` | 退回處理費 | 檢驗定案 |
  | `unsellable_credit` | 不可售扣抵 | 檢驗為不可售且責任在供應商 |
  | `adjustment` | 調整 | 一方提出、另一方接受 |

- **對帳單狀態**（EC-SPEC-06 §5.4 的用詞）：

  | 狀態 | 畫面用詞 |
  | --- | --- |
  | `draft` | 草稿 |
  | `issued` | 已請款，待核對 |
  | `reconciled` | 已核對，待付款 |
  | `disputed` | 有異議 |
  | `partially_paid` | 部分付款 |
  | `paid` | 已支付 |
  | `withdrawn` | 已撤回 |

  逾期不是狀態，另外標示「已逾期」。
- **操作**（收款方）：
  - 建立對帳單：依付款天數自動分張，每張只有一個到期日。
  - 請款，以及在草稿、已請款或有異議時撤回。
  - 確認收到：畫面標示「收款方已確認」。
  - 提出或回應調整（`POST …/settlement-adjustments`、`…/:id/decision`）：調整必須指定一份代出貨同意。
- **規則**：
  - 應付（已記帳、還沒進對帳單）、已核對、已支付分開顯示，對帳單另依上表的狀態顯示（SC-LAT19；EC-SPEC-06 §6 的供貨帳報表）。
  - 「已支付」只代表付款方登錄了付款證據，畫面標示「付款方自行登錄，平台未核對銀行紀錄」。沒有付款或銀行證據時不標成已收。
  - 交寄後的帳目不因買家退款消失；供應商這邊的退件、檢驗與帳目逐條顯示，不一鍵結案（SC-LAT18）。
- **可見範圍**（EC-SPEC-06 §5.5）：零售商店名、訂單顯示編號、SKU、數量、供貨單價與各項費用。看不到零售價、折扣、買家付款、退款與發票。
- **對應**：E09 收款／退款／對帳、E10 發票與報表。
- **需求／驗收**：SC-L12、L13／SC-LAT17～19、21。

## 4. 與 R1 頁面的接點

| R1 頁面 | v1.1 的變化 | 何時 |
| --- | --- | --- |
| SC-03 營運概覽 | 加入待處理出貨（`to_process`）、逾期備貨（`ship_by_overdue`）、配送例外（`delivery_exceptions`）、退件待檢（`returns_to_inspect`）四個指標，取自 `fulfilment-counts` 的 `overview`。它和 R1 概覽是不同的 snapshot，所以自成一組並顯示自己的資料時間；`unavailable` 時顯示無法取得與原因，不顯示 0，也不用總單數充數 | SL-02／04 上線時 |
| SC-04 商品清單 | 「庫存／已預留／可用」的「已預留」改成「已占用」，並以 `inventoryPositions` 分列預留中（`held`）與已付款待出貨（`allocated`）。v1 DTO 的 `reserved` 仍是兩者合計，`available` 不變；預留中的數量仍不是成交 | Commerce 的 M2 付款版本（能力 `commerce.hosted-payment.v1`）同時或更早；只有確認付款才會產生配置，之前 `allocated` 一定是 0 |
| SC-05 商品詳情 | 新增「配送」分區：重量（g）、長寬高（mm）、溫層、可否超商取貨、需單獨成箱、每箱最多件數、限制標記（`GET／PUT …/products/:pid/shipping-attributes`，`store:write`，契約 `ItemShippingAttributesSchema`）。沒有配送屬性的商品不能進新結帳，代出貨的商品缺屬性時明確提示 | EC-SPEC05 欄位上線後；之前不出現 |
| SC-07 審核頁 | R1 起固定說明「同意的是這個售價與供貨版本；不代表同意代出貨，也不會取得買家收件資料。」代出貨條件（SC-L03）是另一份有版本的同意（SL-01），不併入售價同意 | 說明：R1；代出貨同意：C2 |
| SC-08 預留與訂單 | 預留頁不變（預留不是成交）；付款後的履約單在 SL-02 | — |
| SC-11 設定與資料 | 連到 SL-01；唯讀顯示物流帳戶與服務狀態，不顯示任何秘密 | SL-01 上線時 |

SL 頁面沿用同一個 controller、單一 attempt、每位會員的記憶體登錄與 412 草稿規則（SC-SPEC-02）。外部 provider 的未知結果另依 EC-SPEC-05 §5.3「先查後重試」處理。

## 5. 驗收對應

| 驗收 | 主要頁面 | 層級 |
| --- | --- | --- |
| SC-LAT01 寄件設定保存、02 不相容配送拒絕、21 COD 未對帳 | SL-01、結帳（Commerce） | 領域＋旅程 |
| SC-LAT03 同意與地址用途 | SC-07、SL-01／02 | 領域＋旅程 |
| SC-LAT04 同店拆包費用 | 結帳（Commerce）、SL-02 | 領域＋旅程 |
| SC-LAT05 任務範圍、06 無法履約、13 撤權與標籤 | SL-02 | 領域＋旅程 |
| SC-LAT07 未知建單、08 錯帳戶、09 重印、10 標籤不等交寄、11 亂序貨態、12 部分完成 | SL-03 | 領域＋旅程 |
| SC-LAT14 門市失效、15 未取／遺失、16 退回待檢、20 已付款超過 30 分鐘 | SL-04、庫存（Commerce） | 領域＋旅程 |
| SC-LAT17 供應商不得退款、18 售後多軸、19 應付與收付 | SL-05、E09 | 領域＋旅程 |
| SC-LAT22 還原與資料包 | 營運（Commerce＋Supplier） | 營運演練 |
| SC-LAT23 舊 ID 與新版接軌 | 全部 SL 頁面＋R1 頁面 | 旅程 |
| SC-LAT24 真人直送與退回 | SL-J01～03 | 真人試用 |

隔離測試不產生真實物流費用；正式驗收需要商家與操作者的授權與明確範圍，由 Ted 決定。

## 6. 開始條件

1. Commerce 已在規格 fd973423 定下名稱，本文件已對齊。程式契約（`hosted-fulfilment.ts`、`hosted-shipping.ts` 與供貨帳）提交並告知 SHA 後，依實際名稱再核對一次（路徑、ID、能力、狀態清單）。checkout core（`fc/wp03-core` 16caa586，本機）已核對：庫存讀取 `inventoryPositions`；記錄交寄 `recordHandover` 以同一 `shipmentRef` 冪等，品項或數量不同時回 409 `shipment_ref_conflict` 且不生效；`cancelPaidOrder` 在有任何已交寄時回 409 `order_partially_shipped`，也不建立退款。這些和本文件一致，合併前依當時的 SHA 再核對一次。
2. 實作供應商用途的讀取投影與 SL 頁面；寫入只呼叫 Commerce 的共同命令。
3. 物流 provider 尚未開通時只擋住該服務，不凍結 R1 的供貨功能。
