# SC-SPEC-04 素材、設定、報表與資料責任

需求：SC-R26～R32、R34。旅程：J05，以及 J01／J02 的設定部分。驗收：AT-23～28、30、32、33、43。

## 目的與非目標

- S1 讓設定頁可以真的修改事業資料，也讓純供貨商品可以有照片。這兩件事都不新增資料表，也不新增媒體種類。
- S3 交付合作素材與營運報表。合作素材需要一種新的媒體用途（D-05），這要 Ted 核准；報表不需要。
- 非目標：完整 DAM、影片／SVG／PDF、AI 產生素材、跨社群發文、財務報表、完整模組匯出（R2-C）、從伺服器端刪除對方已下載的檔案。

## 1. 現有媒體能力（S1 沿用、S3 仿照）

| 事實 | 位置 |
| --- | --- |
| Asset 用途是封閉清單，每種用途都有固定的大小與輸出格式檢查 | `modules/assets/engine.ts:47,91-104` |
| 商品照片用途 `storefront.product-photo`：輸入最大 2 MiB 的靜態 PNG／JPEG／WebP，完整解碼、去除 metadata，輸出 1920×1920 內、最大 1 MiB 的 WebP | `modules/assets/storefront-product-photo.md`、`packages/asset-storage/index.ts:219,252` |
| 上傳順序：權限 → 容量政策 → 媒體政策 → 商品與 selection → target → intent → Asset；保留空間同時計入 tenant 共用額度與照片額度 | 同上 |
| tenant 保留空間只計 `work.tenant-result` 與 `storefront.product-photo` 兩種用途 | `modules/opportunity-project-work/tenant-capacity.ts:46-72` |
| 照片指向放在 `commerce_product_photo_targets`（不可改的路由＋目前可用的 Asset 指標） | `migrations/141_storefront_product_photos.sql:55` |
| 私人讀取 `GET/HEAD R/products/:product_id/photo/:version`，經 API 回傳位元組，不發 R2 網址 | `apps/platform-api/src/routes/hosted-store-media.ts:49` |
| 公開讀取只走已發布店面：`/api/v1/public/stores/:slug/media`、`/shops/:slug/media/:revision/:sku`，`no-store`＋`noindex` | 同檔 `:57-58` |
| 照片功能由 host 個別開啟：`hosted_store_photos_enabled`、`hosted_store_photo_uploads_enabled` | `apps/platform-api/src/platform-app.ts:322` |
| 備份會收集所有已登記、未被圍欄的物件（含舊版照片） | `storefront-product-photo.md` |

## 2. S1：純供貨商品照片

細節在 [SC-SPEC-03](SC-SPEC-03-commerce-reads-writes.md#純供貨商品照片g-05)。這裡只記資料責任：

- 用途、物件格式、容量計算、備份方式都不變；只是允許的商品範圍從「有開零售的商品」擴大到「本店所有自有商品」。
- 新增的是**資料主體**，不是資料結構：純供貨商品的照片也會進 `assets`／`asset_objects`／`commerce_product_photo_targets`，跟零售商品照片同一個備份範圍。
- 公開投影不變：純供貨商品不在公開頁，合作賣家的公開頁也不會帶出供應商照片。要給合作賣家用，屬於 S3 合作素材。
- 回退：關掉 console 旗標不影響照片；已上傳的純供貨照片留在原處，舊頁讀不到（它只列零售商品），這是可接受的唯讀落差，不會刪資料。

## 3. S1：設定與資料（SC-11）

### 頁面區塊

| 區塊 | 內容 | 讀寫 |
| --- | --- | --- |
| 事業資料 | 名稱、說明；幣別唯讀並註明「建立後不可修改」 | 讀 `GET R/supply-profile`（`read`）；改 `PATCH R/supply-profile`（`manage`，見 SC-SPEC-03） |
| 已開零售的事業 | 名稱與說明唯讀，連到商店資料頁修改 | 單一寫入者，不在這裡提供第二個編輯器 |
| 我的權限 | 列出目前身分在這個商品庫的能力（`supply-profile` 回應的 `capabilities`），每項一句白話說明 | 唯讀 |
| 新預留 | owner：沿用 `HostedReservationSetting`；其他人：說明「只有業務空間擁有者可以設定」 | `GET/PATCH R/reservation-setting` |
| 團隊與邀請 | 「前往業務空間管理成員與邀請」：把目前 tenant 寫入 `freedom-acting-tenant:<userId>`（`TenantSettings.tsx:49` 與 `GuildLaunchpadMyWork.tsx:41` 已用同一個 key），再開 `#business` | 不在營運中心重做成員管理 |
| 資料用途與匯出界線 | 固定說明文字（見下） | 唯讀 |

### 資料說明文字（要點）

- 商品、供貨條件、庫存、合作與預留資料存在這個業務空間，只有具備相應能力的成員可以讀寫；公會身分不會增加讀取權。
- 公開的只有：你公開的供貨版本（合作賣家可見）以及合作賣家自己發布的店面。
- 目前**沒有**完整匯出或搬遷工具；S3 的營運報表下載只是報表，不是備份或搬家用的資料包。
- 尚未提供：付款與收款、出貨履約、佣金、模組外移。這些不在主要導覽裡，只在這裡說明一次。

### 反例

| 反例 | 期望 |
| --- | --- |
| 只有 `read` 的成員開設定頁 | 欄位唯讀並說明需要「管理」能力；沒有存不了的表單（AT-33） |
| 兩人同時改名稱 | 後者 412，草稿保留並列出最新值（SC-SPEC-02） |
| 已開零售的事業 | 不顯示名稱編輯器；伺服器也拒絕（409 `retail_profile_settings`） |
| 前往業務空間時目前身分沒有該 tenant | 業務空間頁照原本邏輯改選第一個可用事業，不顯示錯誤的 tenant |

## 4. S3：合作素材（SC-09）

S3 開始前需要 Ted 核准 D-05（新媒體用途）。核准前只做設計與合成資料的測試，不安裝 host 設定、不寫 storage policy、不開上傳。

### 第一版範圍

| 素材種類 | 儲存 | 格式 |
| --- | --- | --- |
| 圖片（商品圖、品牌圖） | 新用途 `storefront.supply-material`，沿用商品照片的處理器：2 MiB 靜態 PNG／JPEG／WebP → 1920 內、1 MiB WebP；轉換版本 `storefront.supply-material.webp.v1` | 只接受已核准的圖片格式 |
| 文案 | sidecar 文字欄位（最多 2,000 字），不是檔案 | 純文字 |
| 文件（PDF 等）、影片、SVG | 不接受 | 需另外的格式審核（D-05 的附帶事項） |

每筆素材有穩定 ID、所屬事業（tenant／instance）、對象（某個自有商品，或整個品牌）、標題、說明、授權範圍、狀態與目前版本。

### 資料表（S3 migration，編號在實作時取當時的下一號）

| 表 | 主要欄位 | 規則 |
| --- | --- | --- |
| `supply_materials` | `material_id`、`tenant_id`、`instance_id`、`scope_id`、`kind`（image／copy）、`product_id`（null＝品牌）、`title`、`description`、`access`（`partners`／`public_use`）、`state`（active／withdrawn）、`current_version_id`、`aggregate_version`、時間 | tenant／instance 組合 FK 與 RLS（同 `commerce_items`）；`product_id` 必須是本店自有商品 |
| `supply_material_versions` | `version_id`、`material_id`、`version_no`、`asset_id`（圖片）或 `body`（文案）、`sha256`、`created_by_principal`、`created_at` | 只能新增，不能改或刪（trigger 擋，同 publication refs） |
| `supply_material_grants` | `material_id`、`partner_shop_id`、`granted_at`、`granted_by_principal`、`revoked_at` | 每間店一列；撤銷只寫 `revoked_at`，不刪列 |

上傳與照片相同：沿既有 intent／容量／媒體檢查／ObjectStore／finalize。`tenant-capacity.ts` 的用途清單要加入新用途，否則素材不會計入業務空間的容量（這是必改點，要有測試）。

### 授權規則

- 預設 `partners`：只有逐店授權的合作店家可以取用。畫面上「授權給目前所有可售的合作店家」會**當下**為每間店各建一列授權，之後新加入的店不會自動取得。
- 合作店家每次讀取都重新檢查：讀取者在自己的店有目前的商店權限、這間店有有效授權列、素材是 active、這間店與本供應商**現在**仍有可售或待確認的選品（商品素材看該商品；品牌素材看任一商品）。任何一項不成立都回 404，不透露素材是否存在。
- `public_use`：供應商另外按確認（對話框寫明「合作店家可以把這個版本用在公開店面」）。只影響合作店家能不能把素材放上自己的公開店面，不會產生一個人人可讀的檔案網址。
- 前端從不取得 R2 金鑰、永久網址或跨 tenant 清單。

### 讀取（新路由）

| 路由 | 誰 | 回傳 |
| --- | --- | --- |
| `GET R/supply-materials`、`/:material_id` | 供應商，`store:write` | 自己的素材、版本、授權列 |
| `GET R/supply-materials/:material_id/versions/:version_id/content` | 供應商，`store:read` | 位元組（圖片）或文字；`private, no-store` |
| `GET R/partner-materials` | 合作賣家（自己的 storefront `R`），`store:read` | 授權給本店的素材目前版本 metadata，依合作商品分組 |
| `GET R/partner-materials/:material_id/content` | 同上 | 目前版本位元組；每次都重新驗授權 |

### 命令（皆 `Idempotency-Key`＋`If-Match`＝素材 `aggregate_version`，結果不明時沿用原 key／payload 重試）

建立素材、上傳新版本（intent → 上傳 → finalize，同照片流程）、改標題／說明、改授權範圍（升為 `public_use` 需在 body 帶 `confirm_public_use: true`）、授權／撤銷某店、撤回素材。每個命令寫一筆 scoped journal。

### 版本、撤回與已發布店面

- 新版本只改 `current_version_id`；舊版本保留，合作店家之後讀到的是新版本。
- 合作店家已放上公開店面的素材，屬於**那一次發布的快照**，不會被新版本自動改寫；合作賣家的「供貨合作」頁顯示「供應商已更新素材，重新發布後才會更換」。
- 撤回（素材 `withdrawn` 或撤銷某店授權）後：新的讀取與新的發布都不能再用它；已經發布的店面維持到賣家下次發布；已被下載的副本無法收回，畫面直說。
- 合作店家在公開店面使用素材的方式（D-11）：發布時把該版本複製成**賣家自己 tenant** 的 Asset 並記下來源版本，公開讀取仍走既有店面媒體路由。這樣不需要跨 tenant 的公開參照，也符合「publication 只參照同 tenant Asset」的既有不變條件（`storefront-product-photo.md`）。複製計入賣家容量。

### S3 反例（runtime＋E2E）

| 反例 | 期望 |
| --- | --- |
| 匿名或未授權的店（C）讀素材 | 404，沒有任何檔案位元組（AT-25） |
| 上傳時容量不足，按重試 | 同一操作、同一 key；沒有重複 Asset，也沒有可讀的半成品（AT-24） |
| 讀取途中撤銷授權 | 撤銷後開始的讀取被拒；不承諾收回已下載的副本（AT-26） |
| 換新版本 | 已發布的店面不變；下一次發布才用新版本（AT-27） |
| 切換帳號時檔案讀取晚到 | 舊回應被丟棄，不填進新身分的畫面，也不觸發上傳（AT-35） |
| 新用途沒登記到容量計算 | 測試失敗（防止素材不計容量） |
| 備份後還原 | SQL 列與物件都在；授權對帳完成前不公開（AT-43） |

## 5. S3：營運報表（SC-10）

### 讀取

`GET R/supplier-console/report?from=YYYY-MM-DD&to=YYYY-MM-DD`（`store:write`；預留部分 owner 才有）

- 期間以 `Asia/Taipei` 日界計算，最長 366 天；只影響「期間內建立的預留」。商品與合作狀態是 `as_of` 當下的快照，畫面寫清楚哪一段是快照、哪一段依期間。
- 與概覽相同：在 `withTenantRead` 內用**一個** SQL statement（多個 CTE）算出全部數字與明細，`as_of`＝`statement_timestamp()`。`withTenantRead` 的交易是預設隔離等級的 `BEGIN`（`packages/resource-scopes/tenant-transaction.ts:37`），分開的多個查詢不保證同一個快照，所以不拆查詢。
- 內容：
  - 商品：依狀態（公開中／尚未公開／需更新版本／缺貨）的件數。
  - 合作：依店家與狀態的選品數。
  - 預留（owner）：期間內本供應商的預留行項，依狀態（預留中／已取消／已到期）列出件數、數量與「預留供貨金額」（`supply_total_minor` 加總，單一幣別），明標「不是營收或請款」。
- 每個數字都附上可回查的連結：商品清單的狀態篩選、合作店家詳情、預留清單（需要 S2 的伺服器篩選 G-07）。
- 明細以 `LIMIT 10001` 讀取；超過 10,000 列時回 409 `report_too_large`，請使用者縮短期間；不回部分結果冒充總數。

### CSV 下載

`GET R/supplier-console/report.csv?from=&to=`，同一份資料、同一權限。

- 檔頭幾行：產生時間、事業名稱與 ID、期間、篩選定義、幣別、「本檔不是完整資料匯出」。
- 只含呼叫者當下有權看的欄位；不含買家、其他供應商或賣家的其他資料。
- 防公式注入：文字欄位若以 `=`、`+`、`-`、`@`、Tab（0x09）、CR（0x0D）開頭，前面加 `'`；所有欄位加引號、內部引號重複。數字欄只輸出非負整數。
- UTF-8 含 BOM、最多 10,000 列、`Content-Disposition: attachment`、`Cache-Control: private, no-store`。伺服器不保存產生的檔案。

### 反例

| 反例 | 期望 |
| --- | --- |
| 商品名稱是 `=HYPERLINK(...)` | CSV 內為 `'=HYPERLINK(...)`（AT-32） |
| admin 下載 | 沒有預留欄位，檔頭說明原因 |
| 期間內有 10,001 列 | 409，畫面提示縮短期間 |
| 報表讀取失敗 | 顯示無法取得與重試，不顯示 0（AT-29） |

## 6. 資料責任

Dataset 編號沿用 [guild-launchpad data-responsibility](../guild-launchpad/data-responsibility.md)。

| 資料 | 批次 | Dataset | 權威與寫入者 | 讀取 | 敏感度 | 匯出 | 保留／備份 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 事業名稱／說明（既有欄位） | S1 | DC-08 | `PATCH R/supply-profile`（只限純供貨） | `read` | 低；已公開版本的 `supplier_name` 另有凍結值 | 報表檔頭 | 既有備份 |
| journal `storefront.supply-profile.update` | S1 | DC-14 | 同一交易 | 既有 journal 讀者 | 低（只有 ID 與版本） | 無 | 依既有 journal 政策 |
| 純供貨商品照片 | S1 | DC-13 | 照片命令 | `read`（metadata）、私人讀取 | 中（未公開商品） | 無 | 既有物件備份 |
| 營運中心讀取投影（概覽、商品、合作店家） | S1 | DC-15 | 不儲存，每次重算 | 見 SC-SPEC-03 | 中（含供貨價） | 無 | 無快取；`no-store` |
| `supply_materials`／`_versions`／`_grants` | S3 | DC-07＋DC-13 | 素材命令 | 供應商 `write`；合作店家經授權 | 中 | 供應商可逐檔下載；無整批匯出 | 加入 SQL 備份與物件備份；版本不可刪；保留期限待政策（不宣稱已刪除） |
| 素材物件（`storefront.supply-material`） | S3 | DC-13 | Asset engine | 同上 | 中 | 同上 | 需驗證新用途的 R2 備份與還原（AT-43） |
| 賣家發布時的素材副本 | S3 | DC-08＋DC-13 | 賣家發布命令 | 公開店面 | 低（已公開） | 無 | 隨賣家發布保留 |
| 報表與 CSV | S3 | DC-15 | 不儲存 | `write`；預留 owner | 中 | CSV 本身就是匯出，有大小與欄位限制 | 不保存 |

沒有新增搜尋索引、快取、背景工作或通知。若之後加入，須先補這張表。
