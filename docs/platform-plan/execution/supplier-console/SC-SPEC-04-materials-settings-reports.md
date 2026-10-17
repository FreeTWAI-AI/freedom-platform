# SC-SPEC-04 素材、設定、報表與資料責任

需求：SC-R26～R32、R34。旅程：J05，以及 J01／J02 的設定部分。驗收：AT-23～28、30、32、33、43。

## 目的與非目標

- S1 讓設定頁可以真的修改事業資料，也讓純供貨商品可以有照片。這兩件事都不新增資料表，也不新增媒體種類。
- S3 交付合作素材與營運報表。合作素材需要新的媒體用途：圖片 D-05、影片 D-14，Ted 已於 2026-10-15 核准；報表不需要新用途。
- 非目標：完整 DAM、影片轉檔或在瀏覽器壓縮、SVG／PDF、AI 產生素材、跨社群發文、財務報表、完整模組匯出（R2-C）、從伺服器端刪除對方已下載的檔案。

## 1. 現有媒體能力（S1 沿用、S3 仿照）

| 事實 | 位置 |
| --- | --- |
| Asset 用途是封閉清單，每種用途都有固定的大小與輸出格式檢查 | `modules/assets/engine.ts:47,91-104` |
| 商品照片用途 `storefront.product-photo`：輸入最大 2 MiB 的靜態 PNG／JPEG／WebP，完整解碼、去除 metadata，輸出 1920×1920 內、最大 1 MiB 的 WebP | `modules/assets/storefront-product-photo.md`、`packages/asset-storage/index.ts:219,252` |
| 上傳順序：權限 → 容量政策 → 媒體政策 → 商品與 selection → target → intent → Asset；保留空間同時計入 tenant 共用額度與照片額度 | 同上 |
| S3 以前，tenant 保留空間只計 `work.tenant-result` 與 `storefront.product-photo` 兩種用途；S3 再加入兩個素材用途（見 §4） | `modules/opportunity-project-work/tenant-capacity.ts` |
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

Ted 已核准 D-05（圖片）與 D-14（影片），2026-10-15。新用途的 host 設定與 storage policy 隨 S3 的 PR 一起審查；在那之前不安裝、不開上傳。

### 第一版範圍

| 素材種類 | 儲存 | 格式 |
| --- | --- | --- |
| 圖片（商品圖、品牌圖） | 新用途 `storefront.supply-material`，沿用商品照片的處理器：2 MiB 靜態 PNG／JPEG／WebP → 1920 內、1 MiB WebP；轉換版本 `storefront.supply-material.webp.v1` | 只接受已核准的圖片格式；超過 2 MiB 的原圖（最多 20 MB）先在裝置上縮小，和商品照片相同 |
| 文案 | 版本列的 `body` 文字欄位（最多 2,000 字），不是檔案 | 純文字 |
| 影片（商品示範、開箱等） | 新用途 `storefront.supply-material-video`，沿用活動影片（`community.event-video`）的做法：上傳前後檢查大小與檔頭，原檔存放、不轉檔，讀取支援 range 播放；轉換版本 `storefront.supply-material-video.original.v1` | MP4 或 WebM，最多 20 MiB；畫面建議先壓成 H.264／AAC、720p、60 秒內 |
| 文件（PDF 等）、SVG | 不接受 | 需另外的格式審核 |

標題最多 80 字、說明最多 500 字。每個業務空間最多 200 筆有效素材，每筆素材最多 100 個版本、200 筆授權列；超過時回 409（`material_limit`、`material_version_limit`、`material_grant_limit`）。

每筆素材有穩定 ID、所屬事業（tenant／instance）、對象（某個自有商品，或整個品牌）、標題、說明、授權範圍、狀態與目前版本。

影片由供應商自己壓縮後上傳（D-14）。平台不在瀏覽器裡壓縮，也不轉檔；超過上限或格式不符時直接說明原因與建議的壓縮設定。另一條路是 Cloudflare Media Transformations：從已存的影片產生縮圖或較小的版本（輸入最多 100 MB；輸出只快取、不另存；每月前 5,000 次免費，之後每 1,000 次 0.5 美元）。它要 Ted 在 zone 開啟，而且來源要讓 Cloudflare 讀得到；素材是私人的，需要另做有時效的簽章來源才能用。S3 第一版不做，等需要平台產生縮圖或收更大的檔案時再提。

公開店面目前沒有影片欄位，所以第一版的影片只供合作店家在後台預覽與下載；D-11 的店面複本只適用圖片。

### 資料表（migration `171_supply_materials.sql`）

| 表 | 主要欄位 | 規則 |
| --- | --- | --- |
| `supply_materials` | `material_id`、`tenant_id`、`instance_id`、`scope_id`、`kind`（image／video／copy）、`product_id`（null＝品牌）、`title`、`description`、`access`（`partners`／`public_use`）、`state`（active／withdrawn）、`current_version_id`、`aggregate_version`、時間 | tenant／instance 組合 FK 與 RLS（同 `commerce_items`）；`product_id` 必須是本店自有商品 |
| `supply_material_versions` | `version_id`、`material_id`、`version_no`、`asset_id`＋`representation_id`（圖片、影片）或 `body`（文案）、`content_sha256`、`created_by_principal_id`、`created_at` | 只能新增，不能改或刪（trigger 擋，同 publication refs） |
| `supply_material_grants` | `material_id`、`partner_shop_id`、`granted_at`、`granted_by_principal_id`、`revoked_at`、`revoked_by_principal_id` | 每間店一列；撤銷只寫 `revoked_at`，不刪列 |

三張表都有 tenant RLS policy，另外各有一條合作店家只讀的 policy；資料責任目錄（`modules/module-data/catalog.ts`）登記了三張表與兩個用途。`assets`／`asset_objects` 仍沒有 RLS，由讀取 SQL 綁定 tenant 與物件身分。

2026-10-17 整合固定 main `1ae0d0a4`：Commerce 已使用 168–170，S3 由未發布的暫定 168 改為 171，SQL bytes 不變；`FOUNDATION_NAMES`、migration-plan 最後一筆與 release-compatibility 下限同步為 171。已發布的 SQL 不改寫。

上傳與照片相同：沿既有 intent／容量／媒體檢查／ObjectStore／finalize。`tenant-capacity.ts` 的用途清單已加入兩個新用途，有測試防止素材不計容量。未完成的上傳先預留容量：圖片 1 MiB、影片 20 MiB；存好後改計實際大小。舊版本、未完成或過期的上傳都繼續計入；撤回素材或找不到物件都不釋放容量。每個業務空間預設 100 MiB（`docs/development/tenant-capacity-policy.md`），大約只放得下五支 20 MiB 的影片；第一版沿用預設，畫面在上傳前顯示剩餘容量，要調大另外提。容量不足時回 429 `quota_exceeded`（業務空間共用額度）或 409 `asset_retained_quota`（素材用途自己的額度）。

### 旗標與安裝

| 層 | 名稱 | 預設 | 說明 |
| --- | --- | --- | --- |
| 素材紀錄（文案、授權、清單） | 沿用 `FREEDOM_SUPPLIER_CONSOLE_ENABLED`（且 launchpad 開啟） | 關 | 沒有另外的旗標 |
| 素材檔案讀取 | `FREEDOM_SUPPLY_MATERIAL_MEDIA_ENABLED`；`/api/v1/site` 的 `supply_material_media_enabled` | 關 | Worker 需要 `MEDIA` binding 與 supplier console；沒安裝時檔案路由回 404 |
| 新上傳 | `FREEDOM_SUPPLY_MATERIAL_UPLOADS_ENABLED`；`supply_material_uploads_enabled` | 關 | 另需檔案讀取已安裝與 `IMAGES` binding；關閉時新上傳回 503 `material_upload_unavailable`，原本成功的上傳仍可用同一個 key 重播結果 |
| storage policy | `domain_media_storage_policy` 兩列 | `legacy`、不允許保存 | 營運者另外核准 revision 與容量後才可能啟用 |
| release capability | `media.supply-material.asset.v1`（migration 下限 171） | — | 不能退回看不懂新用途的 reader |

### 授權規則

- 預設 `partners`：只有逐店授權的合作店家可以取用。畫面上「授權給目前所有可售的合作店家」會**當下**為每間店各建一列授權，之後新加入的店不會自動取得。
- 合作店家每次讀取都重新檢查：讀取者在自己的店有目前的商店權限、這間店有有效授權列、素材是 active、這間店與本供應商**現在**仍有可售或待確認的選品（商品素材看該商品；品牌素材看任一商品）。任何一項不成立都回 404，不透露素材是否存在。
- `public_use`：供應商另外按確認（對話框寫明「合作店家可以把這個版本用在公開店面」）。只影響合作店家能不能把素材放上自己的公開店面，不會產生一個人人可讀的檔案網址。
- 前端從不取得 R2 金鑰、永久網址或跨 tenant 清單。
- 沒登入的請求在平台登入檢查就回 401，不會查素材，也沒有位元組。

### 讀取（新路由）

`R`＝`/api/v1/tenants/:tenant_id/storefronts/:instance_id`。登入後的回應都是 `Cache-Control: private, no-store`、`Vary: Cookie`；兩個檔案路由在登入檢查回的 401 也一樣。

| 路由 | 誰 | 回傳 |
| --- | --- | --- |
| `GET R/supply-materials`、`/:material_id` | 供應商，`store:write` | 清單：自己的素材與業務空間容量（讀不到時是 `unavailable`，不是 0）；單筆：版本、授權列與目前可授權的合作店家 |
| `GET`／`HEAD R/supply-materials/:material_id/versions/:version_id/content` | 供應商，`store:write` | 圖片或影片的位元組，`Content-Disposition: inline`；任何版本都能讀，撤回後也能讀 |
| `GET R/partner-materials` | 合作賣家（自己的 storefront `R`），`store:read` | 授權給本店、目前有效素材的目前版本 metadata；`applies_to` 列出它適用的本店合作商品 |
| `GET`／`HEAD R/partner-materials/:material_id/versions/:version_id/content` | 同上 | 只限目前版本的位元組；每次都重新驗授權，任何不成立都回同一個 404 |

檔案讀取在讀物件前後各取一次權限快照；兩次不同（例如中途撤銷授權、撤回素材、換新版本或失去角色）就取消串流並回 404。支援單一 range、suffix range 與 strong ETag 的 If-Range；多段 range 或格式不對時回整份 200，超出範圍回 416。物件讀不到或 metadata 對不上時回 503 `material_content_unavailable`，不回 0 位元組冒充成功。range 回應只綁不可變的 ETag，不宣稱驗過整份檔案的 SHA-256；整份 GET 才驗。

### 命令

除了建立以外都要 `Idempotency-Key`＋`If-Match`（素材 `aggregate_version`）；結果不明時沿用原 key、原 body 與原版本重試。每個命令回 `{material_id, version}` 並寫一筆 scoped journal（只有 ID 與版本）。

| 命令 | 路由 | 備註 |
| --- | --- | --- |
| 建立 | `POST R/supply-materials`（201，只要 `Idempotency-Key`） | 文案素材帶第一個版本；圖片、影片素材之後再上傳 |
| 改標題／說明 | `PATCH R/supply-materials/:material_id` | |
| 新文案版本 | `POST …/:material_id/copy` | 只限文案素材 |
| 上傳新檔案版本 | `POST …/:material_id/content`，body 是檔案本身，`Content-Type` 是原檔格式 | 伺服器在同一個請求內跑完 intent → 寫入 → finalize；結果不明時用同一個 key 續傳同一個 intent，不會多一個 Asset |
| 改授權範圍 | `POST …/:material_id/access` | 升為 `public_use` 需帶 `confirm_public_use: true` |
| 授權某些店 | `POST …/:material_id/grants`，`partner_ids` 最多 200 個 | 只能授權目前有可售或待確認合作的店（否則 409 `partner_not_eligible`） |
| 撤銷某店 | `POST …/:material_id/grants/:partner_id/revoke` | 只寫 `revoked_at` |
| 撤回素材 | `POST …/:material_id/withdraw` | 撤回後不能再改或上傳（409 `material_withdrawn`） |

### 與原規格不同之處

| 原規格 | 實作 | 原因 |
| --- | --- | --- |
| 供應商讀檔案只要 `store:read` | 要 `store:write` | 和素材清單一致：素材包含未公開商品的資料，只給能管理商品的人 |
| 合作店家讀 `R/partner-materials/:material_id/content` | 路徑帶 `versions/:version_id`，且只接受目前版本 | 換新版本時，舊網址自然失效；不用另外處理快取 |
| 文案也有 content 路由 | 文案只在 JSON 的 `current.content.body` | 文案不是檔案，不另開位元組路由 |
| 上傳分 intent／上傳／finalize 三步 | 單一 raw POST，伺服器內部跑三步 | 瀏覽器不用持有 lease；重試只需要同一個 key |
| 匿名讀取回 404 | 匿名在平台登入檢查就回 401 | 平台所有私人路由都先檢查登入；401 不透露素材是否存在，也沒有位元組 |

### 版本、撤回與已發布店面

- 新版本只改 `current_version_id`；舊版本保留，合作店家之後讀到的是新版本。
- 撤回（素材 `withdrawn` 或撤銷某店授權）後：新的讀取不能再用它；已被下載的副本無法收回，畫面直說。
- D-11 本機候選：合作賣家選「用於公開店面」並確認後，伺服器當次把供應商的目前版本複製成**賣家自己 tenant** 的普通 `storefront.product-photo` Asset，記下來源素材、版本及內容摘要。Ted 已在 2026-10-16 確認這個複製時機；發布仍是純 SQL 交易，不做物件 I/O。
- 複本先經商品照片 WebP 正規化，使用商品照片 profile／transform version；最多 1 MiB，計入賣家共用容量及商品照片保留額度，供應商容量不增加。替換、停止使用與來源失效都不刪複本、不釋放容量。`commerce_distribution_photo_copies` 保留不可改刪的來源事實；`commerce_distribution_photo_targets` 保存可改的指標與獨立版本，初始為 `0`；不改 `commerce_selections.aggregate_version`。
- 只能用 `image`、`public_use`、active、授權給**這間 storefront shop** 的目前版本，而且本商品須有 offered 供貨與相符的 accepted 同意。商品素材必須對應這件選品；品牌素材必須屬於供應商本身。影片與文案不能用。沿用 `readPartnerMaterial` 的可見規則，沒有第二套授權。
- 新版本不改舊複本。`in_use` 表示來源仍可用且等於目前版本；`update_available` 顯示「供應商已更新為第 M 版，店面仍用第 N 版」，由賣家按「改用新版本」再複製。未改用就再次發布，仍用原複本。
- 來源撤回、本店授權撤銷、改回 `partners` 或本商品合作不再可售時，指標仍保留，清單顯示 `source_unavailable`（包含已失去可售資格但仍有指標的商品）；**下一次發布**不放這張照片。已發布的店面仍用當次發布的快照，直到賣家下次發布。`none` 表示沒有指標；「停止使用」把指標清空、獨立版本加一。
- publication 只參照賣家同 tenant 的 ready Asset，公開讀取維持 `GET /shops/:slug/media/:revision/:sku`；不公開指向供應商 tenant。賣家回應沒有供應商 tenant／instance／scope／asset ID、成本或其他店家資料。

### D-11 店面照片命令與讀取

| 路由 | 權限與契約 | 行為 |
| --- | --- | --- |
| `GET R/distribution-photos` | `store:read`，`DistributionPhotosSchema` | 本店可售合作商品，以及來源失效但仍有指標的商品；版本、狀態、來源版本及賣家複本私人路徑 |
| `POST R/distribution-photos/:product_id/use` | `store:write`，strict `{material_id, version_id}` | `Idempotency-Key`＋指標的 `If-Match`（尚無列是 `"0"`）；先驗來源、在交易外讀驗證物件、再驗相同快照，然後 prepare → write → finalize；finalize 交易內再驗來源，結果不明沿用同 key／body／If-Match，不多建 Asset |
| `POST R/distribution-photos/:product_id/detach` | `store:write`，空物件 | 同樣 key／CAS；清空指標，保留 Asset，回 `{product_id, version, changed, current}` |
| `GET`／`HEAD R/distribution-photos/:product_id/photo/:version` | `store:read` | 只讀本店目前指標的複本；物件 I/O 前後核對指標與權限；inline、strong ETag；不相符回 404 |

所有回應（含匿名 401）為 `private, no-store`、`Vary: Cookie`。讀取失敗顯示原因及「重試」，不顯示「沒有」或 0。公開使用與替換先開確認對話框，說明版本、商品、容量與下次發布才生效；打開時焦點在「取消」，Esc／取消可關閉並回復焦點。無 `store:write` 或旗標關閉時不提供命令按鈕。

供應商撤回或改授權後，「合作素材」的「重新整理」只更新這一區；「店面與發布」要等賣家按「更新供貨狀態」重新讀取店面，才會出現「發布更新」，和其他供貨變動相同（SC-E2E-73 照這個流程走）。

| 拒絕 | 狀態與 code | 文字 |
| --- | --- | --- |
| 非本店可售選品、不可見或不適用素材、其他店 | 404 `not_found` | 找不到這個素材。 |
| 可見但非公開使用 | 409 `material_not_public` | 供應商尚未同意把這個素材用在公開店面。 |
| 非圖片 | 409 `material_not_image` | 只有圖片素材可以用在公開店面。 |
| 可見素材已換版本 | 409 `material_version_changed` | 供應商已更新這個素材。 |
| 上傳／lifecycle／商品照片 policy 不可用 | 503 `distribution_photo_unavailable` | 目前無法把素材用在公開店面。 |
| 來源物件無法讀取或 metadata 不符 | 503 `material_content_unavailable` | 素材檔案暫時無法讀取。 |
| 容量、版本 | 429 `quota_exceeded`／409 `asset_retained_quota`；412 `version_conflict`／428 | 沿既有照片命令文字 |

賣家畫面在伺服器文字後接一句下一步：換版本時請按合作素材的「重新整理」再選用新版本；非公開使用時改用其他素材或請供應商開放；非圖片時改選圖片；兩種 503 請稍後再試。其他沿商店頁既有的下一步文字。

### S3 反例（runtime＋E2E）

| 反例 | 期望 |
| --- | --- |
| 匿名讀素材 | 401，沒有任何檔案位元組（AT-25） |
| 未授權的店（C）讀素材 | 404，沒有任何檔案位元組（AT-25） |
| 上傳時容量不足，按重試 | 同一操作、同一 key；沒有重複 Asset，也沒有可讀的半成品（AT-24） |
| 讀取途中撤銷授權 | 讀完物件後再檢查一次，撤銷後回 404 並取消串流；不承諾收回已下載的副本（AT-26） |
| 換新版本 | 合作店家只讀得到新版本，舊版本的網址回 404；已發布店面保留賣家複本，改用與發布後才換版（D-11／AT-27） |
| 切換帳號時檔案讀取晚到 | 舊回應被丟棄，不填進新身分的畫面，也不觸發上傳（AT-35） |
| 新用途沒登記到容量計算 | 測試失敗（防止素材不計容量） |
| 影片不是 MP4／WebM、檔頭不符或超過 20 MiB | 拒絕，沒有 Asset；畫面說明原因與建議的壓縮設定 |
| 備份後還原 | SQL 列與物件都在；授權對帳完成前不公開（AT-43） |

## 5. S3：營運報表（SC-10）

### 讀取

`GET R/supplier-console/report?from=YYYY-MM-DD&to=YYYY-MM-DD`（`store:write`；預留部分 owner 才有）

- 期間以 `Asia/Taipei` 日界計算（含首尾日），最長 366 天，畫面預設最近 30 天；只影響「期間內建立的預留」。商品與合作狀態是 `as_of` 當下的快照，畫面寫清楚哪一段是快照、哪一段依期間。
- 與概覽相同：在 `withTenantRead` 內用**一個** SQL statement（多個 CTE）算出全部數字與明細，`as_of`＝`statement_timestamp()`。`withTenantRead` 的交易是預設隔離等級的 `BEGIN`（`packages/resource-scopes/tenant-transaction.ts:37`），分開的多個查詢不保證同一個快照，所以不拆查詢。
- 內容：
  - 商品：依狀態（公開中／尚未公開／需更新版本／缺貨）的件數。
  - 合作：依店家與狀態的選品數。
  - 預留（owner）：期間內本供應商的預留行項，依狀態（預留中／已取消／已到期）列出件數、數量與「預留供貨金額」（`supply_total_minor` 加總，單一幣別），明標「不是營收或請款」。
- 每個數字都附上可回查的連結：商品清單的狀態篩選、合作店家詳情、預留清單（需要 S2 的伺服器篩選 G-07）。
- 明細以 `LIMIT 10001` 讀取；商品、合作店家與預留行項（也就是 CSV 的資料列）合計超過 10,000 時，畫面讀取與 CSV 都回 409 `report_too_large`，請使用者縮短期間；不回部分結果冒充總數。
- 預留行項的幣別與事業幣別不同時回 500 `supplier_report_inconsistent`，不把不同幣別相加。

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
