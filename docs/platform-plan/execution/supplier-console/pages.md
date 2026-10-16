# SC-01～12 頁面、資料與權限對照

`R` = `/tenants/:tenant_id/storefronts/:instance_id`；「新讀取」的 schema 在 `contracts/guild-launchpad/v1/supplier-console.ts`，細節見 [SC-SPEC-03](SC-SPEC-03-commerce-reads-writes.md)。批次：**S1** 是第一條旅程（見 [first-journey.md](first-journey.md)），S2 是補齊查詢，S3 是素材與報表（WP-05）。

能力簡寫：`read`＝`store:read`、`write`＝`store:write`、`manage`＝`store:manage`、`publish`＝`store:publish`、owner＝tenant owner。介面依能力收合，但每一次讀寫仍由伺服器重新驗權。

## 導覽

側欄三組，手機為同一份資料產生的選單：

| 群組 | 項目 | 頁面 | 批次 |
| --- | --- | --- | --- |
| 營運 | 營運概覽、商品與庫存、預留與訂單 | SC-03、04／05、08 | S1 |
| 合作 | 合作店家、供貨條件與審核 | SC-06、07 | S1 |
| 管理 | 設定與資料 | SC-11 | S1 |
| 管理 | 行銷素材、報表 | SC-09、10 | S3（實作完成才出現在導覽，不放「即將推出」） |
| 營運／管理 | 出貨工作台、例外與退回；履約與寄件設定、費用與交易文件 | SL-02、04；SL-01、05 | v1.1／Commerce C2（[SC-SPEC-07](SC-SPEC-07-fulfilment.md)；同樣實作完成才出現） |

## 頁面

### SC-01 公會入口摘要

- **操作**：在「商品品質與供應公會」看到自己可讀的供貨商品庫、開始供貨設定、進入營運中心。
- **資料**：`GET /me/supply-catalogs?pagination=cursor`（既有 `CatalogBlock`，`useGuildRead`）。
- **權限**：訪客不送私人讀取；成員只看自己 `read` 可見的事業；公會身分不增加任何商品或庫存權限。
- **S1 變更**：無。既有連結 `#stores/<t>/<i>/supply` 在新版開啟時直接進入營運概覽。
- **缺口**：G-14 本人待辦摘要（S2，需要以本人事業為範圍、帶不可用狀態的讀取；不得變成跨事業聚合或公會長可讀）。

### SC-02 事業選擇與建立

- **操作**：從公會「開始供貨設定」沿用或建立事業與 instance（既有 `LaunchFlow`）；已有多個事業時從「我的供貨商品庫」（`#stores/supply`）選擇；首次進入未設定的 instance 時填名稱、幣別、說明。
- **資料**：`GET /me/supply-catalogs`、`POST /tenants`、launch plan／installation 命令（既有）；`GET/POST R/supply-profile`。
- **權限**：建立事業需 owner／admin；設定商品庫需 `manage`。沒有權限時顯示「請業務空間擁有者或管理員設定」，不顯示假表單。
- **S1 變更**：營運中心頂部顯示事業名稱與「切換事業」（回到 `#stores/supply`）；未設定時營運中心只顯示設定表單，其餘導覽停用並說明原因。純供應不要求零售網址。
- **反例**：重複送出設定不會建立第二份 profile（既有 `created:false`）；切換事業後舊頁面的讀取與未送出命令全部作廢（SC-SPEC-02）。

### SC-03 營運概覽

- **操作**：看四個指標與待辦，點指標進入對應清單，點待辦進入對應商品或審核。
- **資料**：新讀取 `GET R/supplier-console/overview`（一個 SQL statement 算出所有數字，`as_of`＝該 statement 時間）。
  - 公開供貨商品：目前有 `offered` 版本的商品數。
  - 待確認售價申請：`awaiting_supply_acceptance` 且 offer 仍 `offered` 的選品數。
  - 有效供貨預留行項：本供應商行項中，訂單仍 `reserved` 且未過 `as_of` 的行數（owner 限定）。
  - 缺貨商品：`stock - reserved = 0` 的商品數。
  - 待辦（最多 20，`truncated`）：待確認申請 → 供貨版本已過期（條件改了未重新公開）→ 缺貨 → 尚未公開。
- **權限**：`read` 可開；缺 `write` 時四項指標與待辦回 `unavailable: store_write_required`，缺 owner 時預留行項回 `owner_required`。畫面寫明原因，不顯示 0。
- **狀態**：第一次讀取顯示載入中，不顯示 0；重讀期間保留上一次成功的數字並標示「更新中（資料時間 …）」；讀取失敗標示「未更新（最後成功 …）」與重試；操作成功後若重讀失敗，保留「已保存」的事實並標示「未更新」（SC-SPEC-02）。
- **不做**：營收、佣金、轉換率、趨勢圖；合作店家數不用會員數充數。
- **缺口**：G-09「近期變更」（S2，由 transition journal 投影）。

### SC-04 商品清單

- **操作**：搜尋（名稱／SKU）、依狀態篩選（公開中／尚未公開／需更新版本／缺貨）、排序（SKU、名稱、可用量）、表格（桌面）／卡片（手機）切換，進入詳情或新增。
- **資料**：新讀取 `GET R/supplier-console/products`，一次回傳完整的本店商品（≤200，等同容量上限），每列含供貨單價、運費、stock／reserved／available、目前 offer 與 `matches_current_terms`、合作數（待確認／可售／需修改／停用）。縮圖另讀 `GET R/product-media`（照片旗標開啟時；失敗只影響縮圖）。
- **權限**：`write`。只有 `read` 時頁面說明「供貨價與條件不會顯示」，不送讀取。
- **完整性**：清單是完整有界集合，頁面寫「共 N 件（完整清單）」；搜尋與篩選在這個完整集合上進行，結果數與總數同一份資料。容量顯示「共用商品容量 N／200（含供貨商品與商店選品）」。
- **URL**：狀態篩選與排序放 query（`?state=&sort=`）；搜尋文字只留在記憶體，不進 URL。返回清單時恢復篩選、搜尋、捲動位置與焦點。
- **不做**：刪除商品（沒有安全移除流程）；停止供貨走撤回版本。

### SC-05 商品詳情／編輯

- **操作**：分區編輯——內容（名稱、說明）、媒體（照片）、庫存（stock）、供貨條件（供貨單價、運費、出貨與退貨條件）、供貨版本（公開新版本／撤回，含影響預覽）、合作（這項商品的選品與狀態）。新增商品使用獨立頁 `…/products/new`。
- **資料**：新讀取 `GET R/supplier-console/products/:product_id`（商品、條件全文、目前 offer 凍結條款、此商品的選品 ≤200）。命令沿用：內容與庫存 `PATCH R/supply-products/:id`（只送改動欄位），條件 `PATCH R/products/:id/supply-terms`（整組四欄），公開 `POST R/products/:id/supply-offer`，撤回 `POST R/supply-offers/:offer_id/withdraw`，照片沿用照片命令。
- **權限**：`write`；公開版本另需 `publish`，缺少時按鈕停用並說明。
- **版本**：所有分區共用同一個商品版本；任一分區保存後，其他分區的草稿基準過期。412 時保留草稿、顯示最新值，由使用者選「以最新版本重新套用」（新 key、新版本）或「放棄我的修改」。
- **影響預覽**：公開新版本或撤回前，列出目前版本上的待確認與可售選品數與店家；只作說明，提交時伺服器重新核對版本。
- **反例**：庫存低於已保留量 → 409 `stock_below_reserved`，保留輸入並顯示目前已保留量；已被舊式選品使用時改價 → 409 `supply_terms_in_use`。
- **缺口**：G-05 純供貨商品照片（S1 後端補齊）；「紀錄」分區（S2，journal 投影）。

### SC-06 合作店家清單／詳情

- **操作**：看與我有合作的店家（以店家 ID 區分），每家的待確認／可售／需修改／停用數與商品數；進入詳情看這間店對我的每項選品、售價與狀態，直接審核。
- **資料**：新讀取 `GET R/supplier-console/partners`（≤200 家，`truncated`）、`GET R/supplier-console/partners/:partner_id`（該店對我的選品 ≤200）。`partner_id` 是賣家店面 shop ID，不是 tenant ID。
- **權限**：`write`。只呈現「這間店與我」：不顯示該店的其他供應商、買家或私人經營資料。
- **反例**：兩間同名店顯示為兩列（AT-16）；沒有選品關係的 shop ID 回 404，不洩漏存在與否。
- **S2**：店家詳情加入該店相關的本人預留行項（依 G-07 伺服器篩選）。

### SC-07 供貨條件與審核

- **操作**：待確認申請佇列；逐筆審核頁 `…/terms/<selection_id>` 同時呈現賣家售價、凍結的供貨條件、價差（標明「不是佣金或利潤」）與目前條件是否已變；同意／不同意（待確認且版本仍公開時），撤回同意（可售時）；公開中的版本清單與「需要重新公開」提示。
- **資料**：`GET R/supply-requests`（≤200，`truncated`）、`GET R/supply-offers`（≤100，`truncated`）；命令 `POST R/supply-requests/:id/decision`，綁定精確 `listing_sha256` 與 selection 版本。
- **權限**：`write`。
- **狀態**：清單被截斷時寫明「只顯示部分，完整數量見營運概覽」並提供依商品／店家查看的入口；決定的結果不明時鎖住同一筆並只允許重試原操作。
- **不做**：批次同意（R1 不做）；規則引擎或分級價。

### SC-08 預留與訂單

- **操作**：分頁查看本供應商的行項（店家、商品、數量、供貨單價與小計、建立時間、到期時間、終態），owner 開關新預留。
- **資料**：`GET R/supply-reservations?limit=20&cursor=…`（每頁取代，不累加；游標不進 URL）、`GET/PATCH R/reservation-setting`。
- **權限**：owner。非 owner 不顯示導覽項；直接開啟連結時說明「只有業務空間擁有者可以查看預留」。
- **語意**：頁首固定寫「預留最多 30 分鐘，尚未付款或安排出貨；供貨金額不是請款或營收」；`payment/fulfilment/money_movement` 都是 false。供應端沒有取消整張訂單的按鈕。host 停止新預留時仍可停止本店預留並查看歷史。
- **缺口**：G-07 狀態／店家／商品／期間篩選與單筆詳情（S2）。

### SC-09 行銷素材（S3）

- **操作**：上傳商品圖、品牌圖與供應商自己壓縮好的商品影片；關聯商品或品牌；設定「僅授權合作方」或「公開」（公開需本人明示）；版本更替；撤回；合作賣家從自己的合作商品取得當前授權版本。
- **資料**：新 sidecar 表（素材、版本、授權對象）＋既有 Asset intent／finalize／ObjectStore；下載走當前授權的短效讀取，不發永久 URL。需新 media profile（見 work-plan D-05 圖片、D-14 影片）。
- **權限**：上傳與授權 `write`；合作方只讀被授權版本。
- **S1**：只有 SC-05 的商品照片（純供貨商品照片補齊）；不出現在導覽。

### SC-10 營運報表（S3）

- **操作**：選期間與範圍，看商品、合作狀態、預留行項數量，可回查明細；下載 CSV。
- **資料**：有界報表讀取（同一 snapshot、帶篩選定義與產生時間）；CSV 產生器限制列數與欄位，並對 `= + - @ Tab CR` 開頭的儲存格加前綴防護。
- **不做**：營收、獲利、對帳、跨幣相加；不是整模組匯出。

### SC-11 設定與資料

- **操作**：修改事業名稱與說明（純供貨 profile）；查看幣別（建立後不可改）、操作者能力；owner 開關新預留；前往既有團隊與邀請頁；閱讀資料用途、匯出界線與「尚未提供」的能力。
- **資料**：`GET R/supply-profile`；新命令 `PATCH R/supply-profile`（`manage`，If-Match profile 版本，只限 `retail_enabled=false`；已開零售者連到商店資料頁，避免兩個編輯器改同一欄）；`GET/PATCH R/reservation-setting`。
- **權限**：查看 `read`；修改 `manage`；預留設定 owner。
- **反例**：沒有 `manage` 時欄位唯讀並說明，不提供存不了的表單（AT-33）。

### SC-12 合作賣家視圖

- **操作**：在自己的商店後台「供貨合作」瀏覽供貨版本、送出售價、看同意狀態、改價後等待重新同意、停用選品、發布店面。
- **資料**：既有 `HostedDistribution`（完整模式）與商店發布流程。
- **S1 變更**：無程式變更；以 E2E 確認供應端改版後賣家端仍正確顯示「供貨版本已撤回」並可重新申請。
- **S3**：在賣家的合作商品中取得被授權的素材。
