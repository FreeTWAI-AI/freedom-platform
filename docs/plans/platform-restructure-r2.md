# Freedom Platform 詳細重構計畫
## R2 媒體儲存、模組邊界、可執行 Guardrails 與精簡交付流程

版本：1.0 · 日期：2026-10-01（America/New_York）
主倉：`FreeTWAI-AI/freedom-platform`
本次讀取的主線基準：`3de70ccbd24362a7925508fb42d36aaa256a0806`（#99 合併後）
建議放置位置：`docs/plans/platform-restructure-r2.md`

**文件狀態：可供分工與開工的設計／實作計畫，不是已完成重構、已建立雲端資源或已通過驗收的聲明。** 本次沒有修改 GitHub、Cloudflare、資料庫或正式會員資料。實作時重新讀取最新 main、待審 PR 與已部署 migration ledger；本文件的 commit 是查核基準，不是要求回退到它。

**已核定方向：使用 Cloudflare R2 儲存平台媒體二進位。這不是等用量增加才考慮的選項。** 下文的資源名稱、內部型別、保留天數與 PR 分工為具體設計建議；不把建議預設冒充既有正式政策。

---

## 0. 決策摘要與不變範圍

### 0.1 本次要達成的結果

1. 所有現有使用者／平台動態媒體的持久化 bytes 移到 R2。PostgreSQL 保留業務資料、媒體索引、狀態、權限、版本、雜湊與稽核，不再新增媒體 blob。
2. 保持 modular monolith。沿用 React／Vite、Hono、Workers、Hyperdrive、PostgreSQL，不重寫框架、不拆微服務。
3. 一套媒體上傳／提交／讀取／撤銷介面，由現有業務模組使用；不是另一個檔案管理產品。
4. 讓 App.tsx 回歸應用組裝，讓 API 全域 middleware 不再逐項認識所有業務例外。
5. 以必要的小型機械檢查維持資料與授權邊界；CI 依實際影響選測試，不靠刪測試、無條件重試或延長 timeout 解決問題。
6. 人做實質審查與明確合併決定；一般 merge 用確定性工具執行。AI 處理程式、衝突與需要理解的 review，不負責猜測是否可以合併。
7. 解決 migration 編號、共同 inventory 與共用入口檔案造成的反覆整合摩擦。
8. 每一條工作線都留下可重跑證據，包含未驗證部分；merge、staging、production 三種完成狀態分開。

### 0.2 明確不做

- 不新增 Supabase、Redis、Kafka、Kubernetes、新 ORM、新全站狀態框架或第二份會員／任務資料庫。
- 不因 R2 導入而新建獨立媒體微服務、通用工作流平台或常駐 AI server。
- 本次不新增 Queues／Workflows 作為必要依賴。有限重試、回收與搬遷先用既有排程入口、短交易 lease 與可續跑工具完成；不是永久禁止未來有明確需求的使用。
- 不把 R2 當成影片轉碼、直播、HLS 或 Cloudflare Stream 的替代品；保留現有影片能力與限制，不順手擴大產品範圍。
- 不重新設計公會、會員分級、定位、收入、付款或技能授予規則。
- 不自動開 PR、Approve、merge 或 production deploy。無人按下／授權時，不產生新的 GitHub 寫入行為。
- 不把讀取型 client token 或媒體上傳許可升級成通用 Agent 執行權。
- 不以新增委員會、風險分級、SLA 或多人簽核來替代技術整理。
- 不強制把隨版本交付的 Logo、CSS、JS、內建插圖、內建貼圖搬離 Workers Static Assets／Git。

### 0.3 「零阻擋開發」的解讀

雲端資源準備、程式、測試、文件可以並行；不等待會議、成本報價或額外認領審批才開始。真正的技術相依只影響接線及安全發布：例如不能在 object 尚未寫好時將 DB pointer 對外設為 ready，不能在驗證未搬完時刪除唯一舊副本。這些不是新增行政關卡。

---

## 1. 本次查核依據與已知缺口

### 1.1 已觀察的程式事實

| 項目 | 查到的現況 | 重構意義 |
|---|---|---|
| 平台 Worker | 已有 Hyperdrive、Images、Email、Assets；讀取的 wrangler.jsonc 沒有 R2 binding | 在現有 Worker 增加 R2，不另造一個平台 [R1] |
| 圖片處理 | 已有 ImageProcessor 與 Cloudflare Images adapter，包含格式／尺寸／動畫／輸出驗證 | 重用，不再另寫一條未驗證的圖片處理路徑 [R2] |
| 頭像寫入 | saveAvatar 在 command() 的交易與鎖範圍內呼叫 normalizeAvatar | 將外部轉圖與 R2 I/O 移到交易外，提交前重驗授權及版本 [R3] |
| 頭像存在判斷 | 會員、私訊、名片、排行榜等使用 image_bytes IS NOT NULL | 所有 projection 也要更新，不是搬完 bytes 就算完成 [R3, R4] |
| 現有媒體 | 至少七類媒體以 bytea 保存 | 逐一搬遷，不能只做活動圖片 [R4] |
| Migration runner | 依檔名排序，ledger 以 name + digest(sql) 記錄，在 transaction 裡套 SQL | 不改已套用名稱／內容／雜湊語意；大批搬遷不得塞入 schema migration [R5] |
| CI | 主 verify 串行執行全套，deploy-preflight 已獨立，timeout 為 40 分鐘 | 改觸發與範圍，不是再提高 timeout [R6] |
| GitHub 保護 | 本次 branch API 回報 protected:false、必要 status checks 未強制 | 實際設定必須核對，不能拿 workflow 註解當保護證據 [R7] |

### 1.2 尚未取得的資訊

未讀取正式／staging 資料庫的 row count、blob 總量、最大檔案、R2 現有 bucket 清單、私人 overlay、backup policy 或正式站 release SHA。因此不給出虛構搬遷總量、完成時間或節費比例。RS-00 會產生這些盤點資料，但不構成其他開發線的開工前置條件。

### 1.3 來源優先序

本次使用者明示決策 → 最新已核定產品決策 → 現行 runtime 與實際部署證據 → 現行機器可讀設定 → 歷史 planning。

計畫文件不能授予雲端／GitHub 管理權；GitHub 作者及權限不能由公會職稱或自填 slug 推定。歷史說明保留日期，不作為現況的第二套真相。

---

## 2. 目標架構與資料責任

```text
Browser / 已有的會員客戶端
                  |
                  v
Cloudflare Platform Worker（現有 Hono app）
  |-- 身分、Origin/CSRF、業務權限、DTO、版本
  |-- 業務模組：會員／公會／技能／活動／商務／推廣
  |-- MediaAssets 應用服務
  |     |-- 共用 Images processor --> Cloudflare Images（轉圖）
  |     `-- ObjectStore adapter ----> 私有 R2（媒體 bytes）
  `-- Hyperdrive -------------------> PostgreSQL（業務、索引、狀態、稽核）

Workers Static Assets：版本化前端、品牌素材、內建靜態資源
Maintainer Worker：現有 GitHub 同步／request reviewer 限定責任
Admin-sync Worker：現有管理資格同步責任
本機／受信任 operations 工具：搬遷、備份、restore、明確授權的 merge
GitHub：Issue／PR／review／checks／merged commit 的權威紀錄
```

這是邏輯邊界，不代表要新增同等數量的部署服務。MediaAssets 留在現有 repo 與主 Worker；回收排程先接現有 scheduled handler 的獨立有界函式，不把媒體讀寫加到持有 GitHub App 私鑰的 Maintainer Worker。

### 2.1 儲存責任

| 資料 | 目標位置 | 注意事項 |
|---|---|---|
| 使用者頭像、投稿圖片、活動 banner／影片、活動集錦、社群縮圖、服務封面 | R2 | 非可公開 bucket；權限由對應 domain 判斷 |
| 有持久化需求的匯出檔／會員產物 | R2 | 使用同一生命週期；不新增任意檔案上傳產品 |
| 會員、session、權限、公會、交易、訊息文字、技能 structured payload、稽核 | PostgreSQL | 仍為業務權威來源 |
| object key、MIME、size、SHA-256、variant、目前 asset pointer | PostgreSQL | 不存 R2 credentials；不將 key 暴露為授權憑據 |
| 已有 GitHub credential 加密資料與必要 cryptographic bytes | 沿用既有安全設計 | 不因「禁止媒體 blob」而搬到 R2 |
| promotion_click_salts.salt 等固定長度加密用途 bytea | PostgreSQL | 合法例外；不能粗暴禁止所有 bytea |
| JS／CSS／Logo／固定內建插圖／貼圖 | Workers Static Assets／版本庫 | 保持與 release 一致，不為使用 storage 而搬一切 |
| 使用者端即時產生且未要求保存的名片 PNG | Browser 下載 | 無保存需求就不自動新增 R2 副本 |
| 稽核附件、搬遷報告、備份 manifest | 非公開 evidence／backup storage | 報告不得夾帶 media bytes、cookie、token、個資 |

### 2.2 三個常被混淆的概念

- **R2 是儲存；Images 是轉圖。** 使用既有 processor 產生安全輸出後存入 R2，不要求圖片有公開原圖 URL。[C1]
- **R2 強一致不等於 PostgreSQL + R2 的跨系統交易。** object 成功與 DB ready 必須用本計畫的提交協定銜接。[C2]
- **R2 容量／耐久性不等於防誤刪備份。** 正式資料與可恢復副本要分權；不可拿同一個被程式刪除的 object 當備份。[C3]

---

## 3. Cloudflare 資源與環境設定

### 3.1 資源表（名稱為建議，不表示已建立）

| 環境 | 媒體 bucket | bindings／存取 | 邊界 |
|---|---|---|---|
| local / CI | Wrangler 本機 R2 或臨時 filesystem fixture | 同一 ObjectStore contract | 不連 production；每個測試獨立 namespace |
| staging | freedom-platform-media-staging | 主 staging Worker 的 MEDIA binding | 專用合成資料，不複製正式私密媒體 |
| production | freedom-platform-media-prod | 主 production Worker 的 MEDIA binding | 所有動態媒體；明確環境 allowlist |
| production backup | freedom-platform-backup-prod | 僅 operations backup／restore 身分 | 不綁定一般主 Worker／Maintainer Worker |

需要的資源在第一輪接線時建立。Local 不需要另一套 MinIO／Docker object-storage 服務；可使用已存在的 Wrangler／Miniflare 能力。[C4]

### 3.2 每個媒體 bucket 的初始政策

- 使用 Standard storage；不用 Infrequent Access 作為網站日常媒體的預設。
- `r2.dev` public access 關閉；不為媒體 bucket 直接綁 public custom domain。
- 不新增 wildcard CORS。第一版使用同源 Worker upload／download，因此不需要 browser 直連 R2。
- Production 與 staging bucket、DB、來源網址、credentials 必須分開；設定驗證拒絕交叉綁定。
- `MEDIA` binding 僅授予真正需要 object I/O 的 runtime。Application 不持有 account-wide R2 API key。
- 備份工具以 bucket-scoped credentials 工作；與一般 application 部署／資料操作權限分開。
- Location hint 可採主要使用區域的 Asia-Pacific 類型選項，但不宣稱指定到東京或保證資料落地區；hint 是 best effort。[C5]

R2 bucket 預設私有；公開 custom domain 與 r2.dev 是不同存取入口，不能只關其中一個就當全部私有。驗收逐一確認。[C6]

### 3.3 對現有 wrangler 設定的修改

在 `wrangler.jsonc` 的 local／staging-next／next 明確加入各環境 R2 binding。由現有 deploy helper 渲染環境資源；不在這次重構另加一套 Terraform state 管全部雲端。

```jsonc
// 新設計片段：應合入既有設定，而非整份覆寫。
"r2_buckets": [
  { "binding": "MEDIA", "bucket_name": "freedom-platform-media-prod" }
]
```

上面只示意 production；staging 不得沿用該 bucket。使用倉庫 pinned Wrangler 驗證，不因官方文件有新功能而順手全面升級依賴。

增加非敏感的 storage 設定：`schema_version`、環境 logical name、bucket logical alias、private/public access policy、允許的用途、輸出 profiles。不要把所有設定重複放在多份檔案；`deploy/cloudflare/environments.json` 保留環境真相，生成 release receipt 驗證實際 binding。

### 3.4 缺少 binding 與故障行為

- 切換 R2 前：bridge release 可讀明確標為 legacy 的資料。
- 宣告某環境／類別為 `r2_only` 後：缺 R2 binding 或 R2 故障時，相關媒體寫入回明確 503，不退回 PostgreSQL 保存 bytes。
- 資料庫已指向 ready R2 object，但 object 不見：回媒體不可用並記錄異常；不得回頭找歷史圖片而讓已撤銷／刪除內容重新出現。
- R2 故障不應讓純文字頁面、登入或其他不依賴 R2 的路徑一起失效。Release preflight 應阻止發佈缺少必要 binding 的配置；runtime 可作功能級降級，不造假成功。

---

## 4. 媒體搬遷完整範圍

### 4.1 已確認的七類來源

下表是 schema／source 盤點，不是 production row count。[R4]

| 類別 | 目前 DB bytes 欄位 | 新 pointer／處理方向 | 必須保留的行為 |
|---|---|---|---|
| 會員頭像 | member_avatars.image_bytes | asset_id + 頭像 representation | 目前會員資格、可見性、版本 URL、清除頭像 |
| 技能投稿圖片 | skill_submissions.image_bytes | image_asset_id | 私人草稿／公開狀態、投稿／升級及作者來源 |
| 活動 banner | community_event_banners.image_bytes | asset_id | 活動可見範圍、poster orientation、公開 page 行為 |
| 活動影片 | community_event_videos.media_bytes | asset_id | 現有 MP4／WebM、大小上限、影片讀取／Range |
| 活動集錦圖片 | community_event_highlight_images.bytes | asset_id + variant | image／thumb 配對、移除權限與公開顯示 |
| 社群貼文縮圖 | community_social_post_thumbnails.image_bytes | asset_id | 來源紀錄、fetch 失敗可無縮圖、作者替換／移除 |
| 社員服務封面 | member_service_covers.image_bytes | asset_id | 暫停／隱藏／刪除後不可由舊網址繞過 |

### 4.2 RS-00 必須補齊的動態盤點

掃描所有 schema 中的 media bytea、JSON／text 中的 base64、使用者檔案的本機落地路徑，以及 `Buffer`／`Uint8Array` 直接進 DB 的呼叫點。不要只搜尋字串 image_bytes。

輸出按類別彙總的 row count、null／空物件、總 bytes、最大 bytes、估計 object／variant 數、讀寫入口、當前 policy、可重現 seed。列出 orphan media rows、無 owner 的紀錄及未知 MIME。遇到不合法歷史資料列入例外，不自動公開、丟棄或改內容。

盤點報告只存 metadata；未授權不得把正式圖片或個資帶到本機／CI／PR artifact。

### 4.3 絕對不能漏掉的間接依賴

目前 `image_bytes IS NOT NULL` 不只在媒體 endpoint，還出現在會員、名片、對話、公會、活動、服務、推廣與技能 projection。[R3, R4]

Bridge 期間使用明確的相容表示：有目前有效的 `asset_id`，或尚未搬遷的 legacy bytes，才算 present。最終版本只看 active pointer／representation metadata，不讀 bytes、不以 R2 LIST 查「是否存在」。

保留 `avatar_url`／`has_image`／`has_cover`／版本等既有 DTO 語意。不得出現「R2 內有圖片，但名冊沒有頭像」「排行榜 JOIN 把媒體內容拉回來」「名片分享開關被搬遷重設」。

---

## 5. 媒體模組與 ObjectStore contract

### 5.1 建議目錄

```text
packages/asset-storage/
  contract.ts              # runtime-neutral object I/O types
  r2-worker.ts             # native R2 binding adapter
  local.ts                 # local/test only, bounded filesystem or memory
  errors.ts                # provider error -> stable error taxonomy

modules/media-assets/
  service.ts               # prepare/finalize/retire application operations
  repository.ts            # asset metadata writes
  reads.ts                 # internal descriptor lookup; not permission oracle
  profiles.ts              # supported purpose + image/size profiles
  reconciliation.ts       # bounded recovery and garbage collection
  README.md                # module responsibility and invariants

scripts/media/
  inventory.ts
  backfill.ts
  verify.ts
  finalize-migration.ts
  ops-r2.ts                # optional S3-compatible operations adapter; never Worker bundle
```

不需要為每個檔案建立 npm package，也不需要抽成新 repo。名稱是建議契約；實作者先查有無可重用檔案，避免建立重複抽象。

### 5.2 ObjectStore 的最小能力

- `putImmutable`：在 server 決定的 key 建立物件，輸入 stream／有界 bytes、大小／MIME／完整性資料；不得無條件覆寫已有 key。
- `get`：回傳 stream + safe metadata；可接受經驗證的 single range。
- `head`：recovery／搬遷核對使用，不讓每次列表都逐物件查 R2。
- `delete`：限 cleanup／operations 入口使用，route 不自行對傳入 key 刪檔。
- `list`：限有 prefix、cursor、limit 的搬遷／盤點／回收，不提供會員任意 bucket listing。

型別只含 primitives、Readonly metadata 與 Web Streams。不要把 R2Bucket／Node fs／AWS SDK type 傳入 business module。R2 的 range、conditional operation 與 checksum 能力由 adapter 接妥。[C7]

### 5.3 誰負責權限

對應業務模組判斷誰可以讀／改該資產：頭像由 membership，活動由 events，技能圖片由 skill-submissions，服務封面由 member-services。

MediaAssets 檢查 scope、purpose、資產状态、提交相依與跨社群一致性；它不建立第二套「public/private」業務 ACL，也不能只因拿到 asset_id 就回 bytes。

通用 object reader 只接受已授權 descriptor，不能接收前端自由填入的 bucket／key。新 `/media/:id` 路由不是必要需求；先保留既有 domain URL，全部接到共用讀取核心。

### 5.4 runtime 差異

Production：native R2 binding，不為 application 加 AWS SDK。
Local Node：沿用本機 API／PostgreSQL；ObjectStore 使用測試目錄，拒絕 production hostname／credentials。
Worker tests：使用現有 Miniflare／workerd 與本機 R2 模擬；不可把只有 Node mock 成功當 Worker 證據。
Cloud smoke：另外驗證真實 staging R2／Images。既有 offline Images 模擬和雲端服務不是同一種驗收。[C1, C4]

搬遷／備份工具若需要 S3 client，可在 dev/ops 範圍引入**一個**固定版本的官方相容 SDK；記錄目的及鎖檔，禁止進入 Worker／browser import graph。沒有 presigned URL 需求，就不加 signer 套件。

---

## 6. 資料模型與可見性狀態

### 6.1 建議 schema（由實作 PR 落實為 SQL，不在本文件預占 migration 編號）

**media_assets**：一個邏輯內容版本。

`asset_id`、`community_id`、`purpose`、`created_by`／system provenance、`state`、`created_at`、`ready_at`、`retired_at`、`delete_after`、`profile_version`。

State：`pending → ready → retired → deleted`；失敗的 pending 可轉 `abandoned`。一個新上傳／替換就是新 asset_id，不覆寫舊 representation。

**media_objects**：該版本的實際 representations。

`asset_id`、`variant`、`bucket_alias`、`object_key`、`content_type`、`byte_size`、`sha256`、`etag`、`width`／`height`（適用時）、`verified_at`。

唯一鍵至少包含 `(asset_id, variant)` 和 `(bucket_alias, object_key)`。`etag` 是儲存端標記，**不等於內容 SHA-256**；完整性值由實際 bytes 計算並驗證。

**media_upload_intents**：有界上傳／提交的操作狀態。

`intent_id`、`actor_ref`、`community_id`、`operation`、`idempotency_key`、`request_fingerprint`、`target_type`／`target_id`、`expected_version`、`asset_id`、`state`、`lease_token`、`lease_expires_at`、`expires_at`、`result_reference`。

Intent state：`prepared → stored → committed`，失敗／放棄／過期明確記錄。它是 media 操作紀錄，不是新的通用任務引擎。相同 actor／operation／key 保持唯一；quota reservation 使用 intent_id 去重。

**media_migration_items**：只供可續跑搬遷。

保存 source table／PK／variant、讀取時版本或 source fingerprint、asset_id、copy／verify／link 狀態、error code、retry count。舊表名使用程式 allowlist，不把任意 SQL identifier 當 API 輸入。完成後保留彙總 evidence，按維運規則收斂這份暫時操作資料。

### 6.2 Domain pointer 與 DB 約束

既有 domain 表或其 media 表加 typed asset reference；不將所有 domain links 改成一張無約束的 `owner_type/owner_id` 萬用表。

有 community_id 的表應用 composite FK／等價約束維持 community scope。缺少該欄位的 media 表，由 parent row 推導 scope 並在關聯中驗證；最終提交拒絕跨社群／錯 purpose／非 ready asset。任何 client 傳來的 owner 或社群不能直接決定關聯。

支援「無圖片」的表可以沒有 legacy bytes 也沒有 asset pointer。原本 media bytes NOT NULL 的表，在 expand migration 改成「有有效 pointer 或有 legacy bytes」的過渡約束，否則 R2-only insert 會失敗。不能忘記 CHECK／trigger／view／grant 同步。

### 6.3 Key 與 metadata

建議 key：`v1/<opaque-community-id>/<asset-id>/<variant-id>.<ext>`。

Key 不包含 email、姓名、原始檔名、分享 token、GitHub key、付款參照或來自使用者的路徑。原始檔名如有顯示需求，只作經清理的 metadata，不控制實際 key。相同內容不跨使用者自動去重，避免 reference count／刪除語意與可見性推測變複雜。

不依賴 bucket versioning；版本語意由不可變 key 與 DB pointer 保證。對已存在 key 的重試只能在 size／SHA-256 與 intent 一致時接續，否則拒絕。

---

## 7. 上傳、處理與提交協定

### 7.1 第一版保留同源上傳，不先引入 browser 直傳

現有媒體限額先保持不變；頭像仍保留既有輸入上限、格式與輸出規格。搬遷不能變成任意大檔上傳功能。[R3]

圖片可重用既有有界 Buffer 處理，但不可無上限累積或多次複製；影片與 object response 優先 streaming。現有影片檢查若需要有界 bytes，先保持完整檢查再重構，不可為了 streaming 刪掉安全驗證。Worker memory／request limits 應使用 pinned runtime 實測。[C8]

### 7.2 完整順序

**A. 接收前檢查。** 驗登入／窄範圍 bearer、Host、Origin/CSRF（browser）、用途、目標、size header、MIME、quota、rate limit。Content-Length 不是唯一依據，實際 stream 也要計數並可中止。

**B. 短交易 prepare。** 驗當下 domain 權限，建立或查回 intent，保存 expected version 與語意 fingerprint。建立可續跑 lease，不在交易裡呼叫 Images 或 R2。尚未給 domain 寫入成功 receipt。

**C. 交易外處理。** 完整驗證輸入、算實際 digest；圖片沿用 ImageProcessor 去 metadata、拒絕不支援動畫／格式、限制 pixels，依固定 profiles 產生 variants。外部社群縮圖仍沿用原有 SSRF／redirect／size 驗證，不能在轉存 R2 時放寬 URL 規則。

**D. 交易外儲存。** 將已驗證 representation 寫到 server 決定的 immutable key，記錄 R2 response／size／digest。所有必要 variants 成功且驗證後，才進 finalize。pending object 的 key 即使被猜中，也沒有可讀取入口。

**E. 短交易 finalize。** 重新驗 session／會員是否仍有效、目標是否仍存在、目前 domain 權限、expected version、intent lease fencing token、檔案內容與用途。與 domain pointer 更新、version increment、media ready、journal 及成功 command receipt 在同一 DB transaction 完成。

**F. 回應。** 只在 E commit 後回既有成功 DTO。R2 PUT 成功不是產品上傳成功。Response 遺失後同 key 可得到原結果；每次 replay 仍重新檢查當下授權。

這個協定特別要修掉目前頭像轉圖在 command transaction 內執行的情況。[R3]

### 7.3 冪等與競態

- Fingerprint 至少綁 actor scope、domain target、用途、expected version、輸入內容 digest、profile version。
- 既有小型 upload route 可在有界讀取後算 digest；新 streaming intent 必須驗證聲明 digest 與實際 bytes 相同，不能相信 client header。
- 同 key 不同 bytes／不同 target：409，不回另一筆成功。
- 相同 intent 同時執行：只有目前 lease/fencing token holder 可 finalize；逾期 holder 不得提交。
- 會員在轉圖中被停用或退出公會：finalize 拒絕，object 成為可回收的未提交資料。
- 目標在轉圖中被刪除／換圖：CAS 不符，不得覆蓋較新的 pointer。
- command 已成功但 pointer 後來被新版取代：重送仍回原 operation 結果，不重新設回舊 pointer；讀取時遵守當前 domain state。
- 不保證跨 R2/DB 原子 commit；以「未連結 object 可恢復／可回收、ready pointer 必須先有已驗證 object」收斂。

### 7.4 失敗處理表

| 故障 | 對外結果 | 後續 |
|---|---|---|
| 不合法格式／超額／無權限 | 既有 4xx／明確錯誤 | 不建立 ready asset |
| Images timeout | 503，不宣稱使用者圖片錯誤 | intent 可重試；不保存原始 bytes 到 DB |
| 第一個 variant 成功，第二個失敗 | 不切 pointer | 恢復缺少 variant 或回收整組 |
| R2 成功，DB finalize 失敗 | 不回成功 | same intent 對帳重試；必要時回收 |
| DB commit 成功，HTTP response 遺失 | unknown ACK | 同 key 回原 receipt，不重复寫入 |
| DB 目前 pointer 存在，R2 遺失／digest 不符 | 媒體不可用、內部告警 | 從受控備份恢復；不退回旧版公開 |
| 使用者刪除後 object delete 暫時失敗 | domain 立即不可讀 | 稍後物理刪除，沒有公開 bucket 可繞過 |

### 7.5 Presigned／multipart 的邊界

本次不需要讓所有上傳都改成 presigned。未來增加真正的大檔功能時，才接單 object／短期限的 direct upload、完成檢查與相同 finalize；CORS 要逐 origin，完成端不得只相信 client 說成功。

Presigned URL 是 bearer capability，在期限內持有者可執行該 object 操作；不能宣稱天然一次性或可在資料庫撤銷後立即讓 R2 URL 失效。不得用它承載需要立即遵守會員撤權的私密下載。[C9]

---

## 8. 讀取、快取、Range、分享與撤銷

### 8.1 保留既有 API 與網址

例如頭像 `/api/v1/members/:id/avatar?v=...` 與分享名片的 avatar route 仍是正式入口。業務模組在一次 metadata query 中確認當前權限、pointer、版本及 ready state，再向 R2 取該 immutable representation。前端不取得通用 bucket browser 或 R2 根 URL。

### 8.2 讀取順序

1. 依路由的既有規則驗使用者／分享 token／公開 domain state。
2. 查目前 pointer、representation metadata；不讀 legacy bytes（除橋接規則明確允許的未搬遷紀錄）。
3. 處理 If-None-Match／If-Range／Range，但 **304、HEAD、206 也必須先授權**。
4. 從 R2 或已授權後的內部 object byte cache 讀取。
5. 以 server 決定的 Content-Type／Content-Length／ETag／Content-Disposition 回覆；不原樣轉發任意 client metadata。

DB authorization snapshot 是一次請求的判斷點。撤權 commit 後的下一次授權判斷必須拒絕；已開始傳送的 response／已下載副本無法被遠端收回。不宣稱跨 DB 與 R2 的瞬時原子撤銷。

### 8.3 快取分層

| 類型 | 本次預設 |
|---|---|
| 會員限定、私密草稿、可撤銷分享內容 | 下游 `private, no-store`，Cloudflare cache rules bypass；不可在驗權前回 cache |
| 可被管理員下架的公開 UGC | 同樣先由 Worker 查 current state；不給繞過 Worker 的 R2 public URL |
| 不含使用者資料、隨 release 不可變的品牌靜態資源 | 沿用 Static Assets 的快取方式 |

可在「每次授權成功之後」使用內部 immutable object cache，但 cache 只快取 bytes，不快取「此人目前有權」結論。私密 first release 可完全不加 cache，先用 metadata query + R2 stream 保證邊界。

開啟可繞過 Worker 的 CDN public cache 是另一個明確取捨，會影響下架／撤銷時效；本次不採。R2 的強一致不會替應用快取自動失效。[C2, C6]

### 8.4 影片

只保存與提供既有 MP4／WebM，不做轉碼。GET／HEAD 支援單段 byte range、suffix range 與超界處理；206／Content-Range／Content-Length 必須一致，If-Range 不符依設計回完整 representation。多段 range 明確不支援，不建立記憶體中的多段拼裝。新增至少一次 staging 真實 seek／重讀驗證。[C7]

### 8.5 隱私與分享回歸

名片停用、rotate、取消頭像 opt-in、會員停用／換社群、活動 scope 改變、服務 pause／hide／delete、投稿取消公開後，舊 URL 不能取得當前不應公開的內容。

公開 crawler 仍可經公開業務入口讀允許的 OG 圖；會員限定活動只呈現既有安全預覽。搬遷不會把平台內可見聯絡方式直接變成匿名可見。

---

## 9. 刪除、暫存清理與備份

### 9.1 邏輯刪除先於物理刪除

Domain remove／replace 先以 transaction 移除或替換 pointer，journal 與版本同時更新。只有沒有其他有效 domain reference 的舊 asset 才可標為 retired；對外立即依 current state 拒絕。R2 物理刪除由有界 cleanup 執行。一般上傳不共用其他人的 object；如既有技能升級會重用同一張圖，須先盤點其 references，不能因一處刪圖使另一處消失。

不要在持有 domain lock 時等待 R2 delete，也不要讓 object delete 失敗導致取消下架。每次 GC 真正 delete 前，重新核對 ready/live refs、retention policy 與 currently claimed intent；不能只看建立時間。先在短交易中取得 GC lease 並將無 reference 的 asset 標為不可重新掛載的 retired/abandoned，再於交易外刪 object；finalize 不能掛載這些狀態。過期 uploader 在 GC 後才完成 PUT 的晚到物件，由週期性的有界 orphan scan 再次回收，不把一次 delete-not-found 當永久完成。

### 9.2 提議的預設保留值

以下是待納入現行維運設定的建議，不是法律／已授權保留政策：

- 中止 intent：24 小時後可列為 abandoned。
- 未提交 object：確認沒有 live intent／pointer 後，保留至少 48 小時再回收。
- 被替換的非刪除內容：預設 7 天回退窗口。
- 使用者／管理員要求刪除：立即停止可讀；物理與 backup 到期依正式資料保留政策，不被一般 7 天回退規則擅自覆蓋。
- 搬遷過渡舊 DB bytes：完成驗證與 R2-aware rollback 演練後才清除；不設永遠不結束的 dual storage。

穩定 ready 物件的 prefix 不設 blanket expiration，否則 lifecycle 會刪掉 DB 還指向的內容。Native lifecycle 可清真正 temporary prefix、unfinished multipart；不能把它當跨 DB 的 GC。Lifecycle 實際清理也不是精準計時器。[C10]

### 9.3 有界排程

既有 scheduled 入口呼叫獨立 `runMediaReconciliation()`；使用 row lease／SKIP LOCKED 類型的短交易，限制每輪 item 數與時間。鎖內領工作、鎖外 R2 I/O、鎖內完成狀態，避免 session advisory lock 長期占用 Hyperdrive origin connection。

給 media cleanup 與 GitHub sync 各自明確 budget；前者錯誤不能耗盡後者執行額度。不因回收需要而自動加一整套 Queue runtime。

### 9.4 備份與恢復

正常 operation Worker 不綁 backup bucket。Backup／restore 身分有獨立 scope，不持有 GitHub 寫入權。

備份單位不是只有 pg_dump：必須包含一致時間點的 DB snapshot、當時全部 ready／需要恢復的 media_objects manifest、对应 R2 immutable objects、SHA-256／size 與 tool/release version。

建議先取得 DB snapshot 中的 asset reference 集合，再確保這個集合的所有 object 已備份；immutable key 與 GC retention 保障複製期間可讀。長時間備份需為該集合建立有期限的 backup pin/lease，讓 GC 不在複製途中刪檔；未完成或 lease 過期必須重新核對，不能照樣標 complete。只在集合完整且 digest 核對後宣告該 backup set complete。新上傳落在下一份 snapshot，不需要為備份凍結全站。

備份保留長度、清理與 bucket locks 要與正式刪除政策一起設定；鎖定不可撤銷的長保留不可由 Agent 自作主張。Bucket locks 可保護保留期內的物件，但不是跨系統一致性解法。[C11]

Restore 驗收：在隔離環境還原 DB 與對應 R2 set，重建安全 binding，跑讀取／撤權／缺物件檢查。正式 app 不持有備份刪除權。首次 cutover 前必須完成至少一次可重跑還原演練，不只看「備份指令 exit 0」。

---

## 10. PostgreSQL → R2 線上搬遷協定

### 10.1 發布狀態

| 狀態 | 讀取 | 新寫入 | 可以回退到 |
|---|---|---|---|
| 舊版 | DB bytes | DB bytes | 舊版 |
| Bridge release | 有 pointer 讀 R2；未搬遷明確讀 DB | 切換前沿用舊寫入，R2 接線已驗證 | Bridge／受控舊版（僅尚無 R2-only 資料時） |
| R2 write cutover | R2 優先，未搬遷 legacy fallback | R2-only | **至少是 R2-aware Bridge** |
| Backfill complete | 全部有效 pointer 讀 R2 | R2-only | R2-aware release |
| Contract cleanup | 只讀 R2，legacy 欄位移除 | R2-only | R2-aware release＋必要 schema 相容性 |

**第一筆 R2-only 新資料產生後，不得把不認識 R2 的舊 Worker 當 rollback。** 回退 UI／程式可以，但不能讓新上傳消失。

### 10.2 Expand

新增 metadata／intents／progress 表及 domain pointers；調整原 bytes NOT NULL／CHECK、views、runtime grants。先確保舊 reader 還能工作。全數 additive／compatibility 更新，不在同一 migration 搬檔、呼叫 Cloudflare、清空舊欄位。

所有 migration 以新檔提交；不修改 016／028／045／050／065／066／067 等已套用歷史 SQL。

### 10.3 Bridge

七類讀寫入口與全部 `present` projections 具備 R2-aware 能力。先在 staging 驗證真正 R2／Images；production deploy 必須帶完整 binding 與安全 policy。

在正式啟用 R2-only 前，確認所有會處理該環境的 Worker／發布版本已支援 R2，避免新舊 deployment overlap 還有 DB-only writer。

### 10.4 Cutover 新寫入

採用單一明確的環境／類別 write-mode 設定，不讓各 Agent 自己加 fallback flag。完成 R2-only 切換後，用 DB trigger／明確權限約束拒絕新增或變更 legacy media bytes；metadata 更新與核准的清除作業仍可進行。

不能只做 column REVOKE 卻保留會覆蓋它的 table-wide write grant，再誤認為已封鎖。選用的實作要有舊 writer raw SQL 被拒絕的測試。

必要時只短暫停止該類別新上傳以排空舊 writer；不把整站、登入、聊天文字與其他開發停掉。這是技術切換，不是等待使用量達門檻。

### 10.5 可續跑 Backfill

1. 按 allowlisted source table／主鍵做 keyset pagination，先讀 metadata，再逐筆讀 bytes，不一次把整表 blob 載入 RAM。
2. 記錄來源主鍵、variant、版本／updated_at 與 bytes digest。
3. **歷史 bytes 原樣搬移，不重編碼。** 原來已正規化的 WebP 不應在搬遷時改顏色、尺寸或 digest。
4. 產生 stable migration identity；中斷後可找回同一 intent/object，不每跑一次新增一份。
5. 寫 R2，驗 content length 與由實際內容得到的 SHA-256；不是只信 customMetadata 上自填的 hash。
6. 短交易重新讀取來源狀態；只有 source revision／digest 仍符合且仍應存在，才連接 asset pointer。
7. 來源已修改、刪除或由新版 R2 writer 取代：標記 stale／skip，不覆蓋。
8. 更新 migration progress；只在已驗證＋已連結時算成功。

無 aggregate_version 的表，在 link 前以列鎖比對 updated_at + 實際 bytes／digest，避免同 timestamp 不足以辨識修改。不得盲信舊 checkpoint。

建議預設 metadata batch 50、blob copy concurrency 2，並限制總 in-flight bytes；遇大影片可降為 1。這是可調安全起点，不是推估正式吞吐。不要在每個 item 上重跑全倉 CI。

### 10.6 全量驗證與 Delta

每個有 legacy bytes 的應存資料都必須歸入：verified+linked、合法已刪除、被新版替換或明確待處理例外。不能只說「抽查 10 張都可開」。

必做：row／variant 計數、size／digest 核對、source→pointer 完整性、R2 missing、dangling refs、跨社群 link、read path parity、撤權／刪除競態、全部列表存在判斷。跑 delta 直到沒有未處理來源。

### 10.7 Contract cleanup

确认 R2-only、backfill 完整、可恢復 backup set、R2-aware rollback 成功後，另開清除 PR。先解除 runtime 對舊 bytes 的讀取，再分批清值，最後依 schema 相容性 drop columns／legacy adapter。

保留 key／digest／來源與遷移摘要 evidence，不保留永久 DB 媒體副本。清 blob 後 PostgreSQL 的已配置磁碟／費用不一定立即下降；評估必要的資料庫維護，不能承諾 drop column 就馬上縮小帳單。

### 10.8 工具命令設計（待實作，不是現有指令）

```sh
npm run media:inventory -- --env staging --output <private-report-dir>
npm run media:backfill -- --env staging --resume --batch-size 50 --concurrency 2
npm run media:verify -- --env staging --full
npm run media:finalize -- --env staging --evidence <verified-manifest>
```

Production 只由已授權 operations 身分執行，明確提供 env／預期 DB／bucket／release。工具預設 read-only 或 dry-run；寫入模式明確指定，不掃憑證、不自動登入、不從本機預設 DATABASE_URL 猜正式目標。

---

## 11. Migration 撞號的永久處理

### 11.1 不再讓每個分支手算下一個三位數

本次建議採「舊格式保留、新格式使用 UTC timestamp + random suffix」的相容擴充。不導入新的 migration framework。

新檔名示意：`20261002T001530123Z_a1b2c3d4_media_assets.sql`。

它是唯一 identity，不是業務依賴的證明。真正依赖另一個 PR 的 schema，仍要先 merge 該 PR，或以明確 base／相依 PR 驗證整合；不能用時間戳替代技術相依。

### 11.2 一次更新的元件

- Migration discovery／sort／validation：legacy NNN 依原數字排在前，新格式依 timestamp + suffix 排序；不能任意接受未知檔名。
- `schema_migrations`：既有 name 與 `digest(sql)` 不變；不得改成另一個 raw hash 而讓所有已套用紀錄失效。
- Deploy preflight：檢查完整檔案集合、雜湊、歷史不可變與未套用檔案，不再以 `migrations.last` 作唯一正確性依據。
- `modules/repo-maintainer/policy.ts`、handoff builder、相關測試：不再硬編 NNN-only 或「新增號碼必須大於當前 max」為所有 migration 的規則。
- Release receipt：從提交的實際 migration 集合生成 release migration manifest，不要求每個 feature PR 手改共同 maximum。
- 環境 manifest：轉成清楚的 v2 schema；不能同時維護互相矛盾的舊 last 與新 files 為權威。

來源讀取顯示本機 runner 有自己的 ledger／排序語意；正式 deploy helper 也必須一起查核，不能只改本機腳本就宣稱完成。[R5]

### 11.3 必要測試

空庫全量、既有 ledger 增量、重跑 no-op、歷史檔遭改拒絕、兩個獨立 PR 同時間新增、合併次序逆轉、未知檔名、同 ID 不同 SQL、並行 migrator 鎖、缺少相依 schema 的候選版本。

已先套用較新 timestamp 後再合併較舊 timestamp 的獨立 migration，必須仍按 ledger 偵測「未套用」並可正確執行；不准只篩 `id > latest`。相依不成立的版本由整合測試拒絕，而不是靜默跳過。

此工具相容 PR 先獨立通過，再讓 R2 schema 用新格式。若部署工具尚未更新，R2 工作仍可在分支開發；不得提前把新格式丟給舊 production runner。

---

## 12. 模組整理：維持單體，移除責任混雜

### 12.1 前端

第一步只做 responsibility extraction，不同時換 UI：

```text
apps/portal-web/src/
  App.tsx                       # shell + composition only
  shell/                        # navigation, session/provider composition
  modules/
    work/                       # workbench/list/forms moved from App
    opportunities/              # showcase/opportunity/engagement views
    membership/                 # member card/profile UI
    media/                      # shared upload state, not a second ACL
    ...existing modules...
```

Session／API client／全站 providers 保持單一。跨頁共用型別放合適的 shared contract，module 不回頭 import App.tsx。

Extraction PR 不改文案、不重新配色、不加新 state library。原路由、手機行為、三主題、焦點、autosave／unknown ACK 等用原測試固定。完成後再做有量測的 lazy loading；不要為達到任意行數目標過度拆檔。

### 12.2 API

`platform-app.ts` 留組裝、全域 Host／安全 headers／error mapping。共用 router factories 承擔少數明確安全 profile：

| Profile | 身分／驗證 |
|---|---|
| member-json | session + browser Origin/CSRF + bounded JSON |
| member-media | session + browser Origin/CSRF + purpose-bound media stream |
| public-read | 公開業務投影與 current state，不接受任意 DB/key |
| narrow-agent | 已有 bearer scope；不自動取得 member/session 全權 |
| shop-machine | 現有 shop credential／scope；保留原商務規則 |
| verified-webhook | 原始 body cap + 簽章驗證，再進 DB |

Profile 不等於授權結束：活動主辦人、服務 owner、公會資格等仍由 domain 判斷。未知 write route 預設拒絕，不設「先用通用 public handler 讓功能跑」捷徑。

為降低衝突，優先接新 media profile，逐步移除原 binary exception chain；一次只搬一組路由。保留 webhook 驗原始 bytes 的順序，不能先 JSON parse 再 HMAC。

### 12.3 後端業務模組

不做「所有 module 必須禁止 JOIN」。跨模組 read projection 可以有明確 owner 與有界 JOIN。跨模組寫入走對方公開 command／已有 transaction-safe function，不直接改對方狀態表。

不要每個 domain 都新增 repository/service/controller 十幾個空檔。只對目前多責任／反覆衝突位置拆分。`modules/community` 可依 events、social/promotion、catalog 子責任整理，但保持原 export 過渡層，避免所有 active PR 同時大規模路徑衝突。

### 12.4 runtime 邊界

PlatformRuntime 顯式注入 ObjectStore／ImageProcessor 與已需外部 side effects。Browser import graph 不含 pg、R2 ops、secret；Worker graph 不含 fs／native sharp／ops SDK；允許現有經驗證的 nodejs_compat 能力，不粗暴禁止全部 node: imports。

---

## 13. 註解、架構設定與可執行 Guardrails

### 13.1 一個現行架構來源

更新 `freedom.project.yaml` 與現有 deployment manifest 的過期欄位，不另寫相互競爭的多份「現行架構」。增補 `docs/architecture/current.md` 作人讀索引，指向 machine-readable source 與 evidence。

模組責任／相依可以放一份小型 `architecture.json`，只存 runtime allowed edges、module ownership、public entrypoints、受影響測試映射；不可重複抄 deployment facts。值由實際程式路徑驗證，未知路徑進 full test fallback。

### 13.2 每個主要模組的責任說明

```text
Purpose：本模組解決什麼。
Owns：資料表、狀態轉換與 side effects。
Public API：其他模組可以呼叫什麼。
Dependencies：允許的依賴方向。
Invariants：不可破壞的規則與原因。
Tests：可重跑的檢查入口。
```

函式註解寫「為什麼需要這個鎖／這次驗權／這個版本檢查」，不是把語法翻成中文。全域安全政策只存一份；不複製到每個 AGENTS。

### 13.3 Guardrail 清單

| ID | 不變條件 | 實作證據 |
|---|---|---|
| G01 | Production 不新增媒體 bytes 到 DB／永久 local disk | 指定 media columns 寫入拒絕＋runtime SQL regression；保留 crypto bytea 例外 |
| G02 | 已發布 SQL／contract bundle 不可任意改寫 | baseline hash／ledger／contract compatibility tests |
| G03 | Browser／Worker／ops import 邊界正確 | 既有 TS parser／bundle graph；不只 grep 字串 |
| G04 | 撤權後新操作與 replay 不得成功 | 真正 DB transaction／session／guild race tests |
| G05 | ready pointer 必須對應先寫好的已驗證 object | failure injection：R2 success/DB fail、partial variants、unknown ACK |
| G06 | public URL 不繞過 domain／share revoke | GET/HEAD/Range/304、cache hit、舊 token 回歸 |
| G07 | 外部 I/O 不在業務 DB lock 內 | provider delayed latch + 第二 DB connection 的確定性測試 |
| G08 | 不新增第二套 truth、未登錄 provider/runtime | dependency／binding diff + 架構宣告核對 |
| G09 | 必要 checks 確實執行，不能 skipped/cancelled 被當通過 | trusted selector、job result aggregator negative tests |
| G10 | 真實 scope reviewer、人授權、current head/base 才能 merge | GitHub protection／輕量 review-policy／sandbox negative cases |
| G11 | 既有使用者功能與 DTO 不消失 | 原 runtime、Worker、browser journey regression |
| G12 | 無秘密／media body 出現在 log、receipt、PR artifact | serialization tests、secret scan、人工抽查安全 evidence |

規則由一個快檢入口彙總，不建立十二條獨立 workflow。新增 guardrail 本身須能用反例證明會擋下錯誤，而不只驗證「檔案存在」。

### 13.4 既有債務處理

可對原有 module graph 先建立可追蹤 baseline，只禁止新增不合理的循環／反向寫入，再逐步清舊債；不得用 baseline 放行新的秘密外洩、錯誤授權或媒體 bypass。任何 allowlist 必須有具體路徑與理由，不能 `**` 全放行。

---

## 14. CI 重構

### 14.1 目標而非已量測承諾

純文件不啟動 DB／browser；小 UI PR 不跑全部 provider／cross-repo suites；R2／權限／schema 的相依測試必須在合併前完成。完整回歸保留在需要的整合版本、main／排程及 release，不以「nightly 會測」取代核心改動的 merge 前驗證。

先記錄每個步驟的耗時、runner-minutes、取消數、flake 根因、重跑數；本文件不承諾未量測的加速倍數。

### 14.2 固定結果入口

保留必要技術 check 名稱 `verify`，內部拆成 prepare/affected/static/runtime/worker/browser 等適量 job；最後彙總所有選中的必要結果。

Workflow 不因 path filter 整條消失；改在內部選 jobs，避免 required check 永久 pending。彙總必须區分「未選取」和「應執行卻跳過／取消／失敗」。[G1]

### 14.3 測試選擇

| Changed surface | 必跑範圍 |
|---|---|
| 真正純說明文件 | links、格式與文件引用；不啟 DB |
| 執行期 Markdown／生成文字 | source generation drift、相依 modules／output tests |
| 個別前端模組 | typecheck/build、受影響畫面、關聯 user journeys |
| shared CSS／theme／shell | 較廣的手機／三主題／導航回歸 |
| media service／storage／images | metadata+R2 transaction cases、Worker parity、7類 reader/writer mapping |
| identity／permission／command／db | 所有相依 domain runtime + 核心 E2E；必要時全套 |
| schema／migration runner | 空庫／增量／ledger／grants／受影響全流程 |
| Worker adapter／binding | 指定 runtime＋環境 dry-run；不能只驗 Node |
| 跨倉 contract／SDK／pins | contract build + consumer integration |
| 未知路徑、selector／workflow／guardrail | full relevant suites／安全審查，不自行縮小 |

用「檔案→模組→反向相依→suite」選擇；不只看名稱相似。Selector 使用受信任 default-branch policy，加上保守 fallback；PR 不能更改自己的 selector 然後只跑空集合。

### 14.4 Concurrency 與環境

同一 PR 新 commit 取消舊驗證 run。Release／schema／搬遷／backup jobs 不使用同一取消策略；資源變更不能被下一個 UI push 中斷。[G2]

保留 npm cache／可安全重用的工具快取，但不跨 PR 重用未驗證產物或把私人 artifacts 給 fork。

E2E 先完成每輪／每 shard DB、schema、port、fixtures 與清理隔離，才增加平行數。每個 shard 初期仍可 workers:1；不要將共用狀態測試直接開 workers:8。

### 14.5 Worker build 範圍

將目前多 runtime×多 environment 的 dry-run 分成「bundle 相容性」與「environment config 驗證」。若輸入與 bindings／vars 相同，不必為不相關文件反覆跑九個 bundle；但受影響環境的配置必須仍有實際驗證。Release 時驗要部署的 exact SHA/config，而非沿用別的分支成功。

### 14.6 Deploy preflight

依既有決定，完整 `deploy-preflight` 在 PR 顯示但非必要 job。最小 code integrity（migration 名稱唯一、既有 SQL 未改、有效 schema／必需授權測試）屬 verify 本身，不應被當成可忽略的雲端 availability。

正式發布時必須驗 DB ledger、R2 binding、bucket 私有、Images 與 environment identity。不能因 PR advisory 不擋 merge，就發佈明知無法讀媒體的版本。

### 14.7 Full source inventory 移位

保留發版／固定 bundle 的完整性驗證；將每個 source file 的 inventory 由 release／archive job 自動生成，作 artifact／evidence。日常 PR 不必人人更新同一份全倉 hash JSON。

相對連結檢查獨立保留；contract／SDK／已發布 SQL 的 exact digest 保留。先查舊 inventory 的 consumers，移轉後才刪除舊 required 入口，不能直接跳過所有 integrity checks。

---

## 15. Review／Approve／Merge 的精簡設計

### 15.1 對使用者的流程

```text
作者完成候選 PR
  -> verify（自動）
  -> 有資格、非作者的 reviewer 做一次實質 review
  -> 人明確按合併／加入合併佇列
  -> 確定性工具重新驗證並 merge
  -> GitHub webhook/sync 回到平台
```

認領只是避免重工，不是另一份 approval。平台不再要求「平台核准＋GitHub 核准＋AI 再決定」三套決策。需要修程式／解衝突時才按 AI handoff；新程式產生新 head，必要驗證與 reviewer 對最終候選負責，不能沿用舊內容的批准。

### 15.2 最小可實作版本

先在現有 repo 建 `scripts/maintainer/merge.ts` 或同等工具。使用操作者自己的 GitHub credential；平台不必先持有可替全組 merge 的廣權 token，也不新增雲端 Agent runtime。

輸入 repo／PR／expected head／明確操作意圖。輸出結構化檢查結果與 merged commit。工具實際執行 API，LLM 不是最後一段執行者。此工具的 command 是待實作介面，不宣稱現在已存在。

驗證：OPEN、非 draft、正確 base、最新 head、required checks 的可信來源與完整結果、有效且當下有資格的非作者 review、未解決的 changes requested／hold、migration compatibility、操作者 native GitHub 權限。查詢不完整或 UNKNOWN 不當成綠燈。

Merge request 帶 expected SHA；GitHub 拒絕則回報，不加 `--admin`、不撤保護、不改憑證繞過。Expected head 只能防止 head 被換掉，不能保證 base 沒前進。[G3]

### 15.3 Base freshness 與並行 PR

建議在 verify 已支援 `merge_group` 後，採 GitHub native merge queue；由人的明確按鈕授權該 PR 排隊，queue 驗最新 base + 前面候選的組合。不是看見綠燈就由巡查 Agent 自行 enqueue。[G4]

未啟用 queue 時，工具發現 base 改變而缺新的整合證據就停止，產生技術待辦；不能在 check-to-merge 競態中假裝已排除風險。不要自建一個無 GitHub 原生保護支撐的「假 merge queue」。

### 15.4 真正的 enforcement

本次查核 branch API 顯示 main 未受保護；在實作環境重新核對，並由有權操作者設定真正的 required checks、禁止 force push／branch deletion、必要的獨立 review。[R7]

平台的 guild／skill-maintainer eligibility 不等於 GitHub native write 權。不得自動因認領而授予 write。

若原生 CODEOWNERS／team 設定能精確表達資格，就直接使用；若不能（例如資格來自動態公會／技能任命），增加**輕量、無 LLM**的 trusted `review-policy` required check，對 current head 與最新 eligibility 作判定。這是既有產品規則的執行，不是新增第二位審核者。不能只靠本機工具檢查，卻留下 GitHub UI 直接 merge 的繞過入口。

Review／label／資格變更只更新該輕量判定，不重跑全部 E2E。兩個穩定 required checks（技術 verify＋必要時的 review-policy）比為追求「只有一個 check」而留下權限漏洞更簡單。

### 15.5 不可信 PR 與工作流自我修改

Fork PR 不取得 production／R2／GitHub secrets，不在 privileged `pull_request_target` 中 checkout 並執行 PR 程式。工作流／guardrail／merge tool 改動由有效獨立 reviewer 核對，測試計畫以可信基線作保守選擇。

不只以 check 名稱與 github-actions App slug 就認定沒有被 PR 改寫工作流作弊；保護規則、可信 workflow path/revision 與實際執行證據要一起驗。

---

## 16. Repo／檔案修改地圖

| 路徑／範圍 | 修改 | 不修改 |
|---|---|---|
| wrangler.jsonc | R2 binding、環境校驗 | 既有 hostname／Hyperdrive cache policy／必要 security headers |
| apps/platform-api/src/runtime.ts、worker.ts、app.ts | 注入 ObjectStore；R2-aware runtime | 不讓 ops SDK 進 Worker，不把秘密給前端 |
| packages/asset-storage/*（新增） | 小型 storage adapter | 不承擔會員／活動 ACL |
| modules/media-assets/*（新增） | intent、metadata、finalize、回收 | 不建第二份 generic task truth |
| modules/identity-membership/avatars.ts、member-sharing.ts | R2 pointer、transaction 外轉圖、presence | 原授權／opt-in／version／autosave 語意 |
| modules/skill-submissions/{service,public}.ts | 圖片 pointer 與草稿／公開投影 | 內容授權、claim、投稿狀態 |
| modules/community/{events,event-highlights,social-posts,member-services,promotion}.ts | media I/O、presence、metadata | 商業、積分、活動可見範圍不擴張 |
| modules/member-communications/*、positioning/onboarding.ts | 間接頭像 presence／projection | 不因搬圖改聊天或 onboarding 規則 |
| apps/platform-api/src/routes/*media相關 | 共用安全 profile、stream responses | 舊網址／JSON shape／error semantics 優先維持 |
| migrations/*（新增） | metadata、pointers、約束、legacy 相容／清理 | 所有已套用 migration 原文與 identity |
| scripts/database.ts、deploy/cloudflare 工具 | 新 migration ID 相容、manifest generation | 現有 ledger hash 語意、環境角色分離 |
| modules/repo-maintainer/{policy,handoff-task}.ts | v2 migration 辨識、確定性 merge 接線 | scope／當下資格／人授權 |
| App.tsx 與前端 modules | 按責任搬檔、共用 media client | 不同時換 framework／品牌視覺 |
| .github/workflows/verify.yml、scripts/ci/* | affected selection、結果彙總、取消舊 run | 不取消必要的安全測試 |
| freedom.project.yaml、docs/architecture/*、現行 manifest | 現況對齊、來源唯一 | 歷史 planning 保留日期，不當 runtime 宣告 |

此表依實際讀取／搜尋路徑整理；實作者需更新最終 affected list，不能把它當成允許漏掉未列出的讀取點。[R1–R6]

---

## 17. 工作包與 PR 順序

工作包不是新 committee／人事角色。每包由一位已承接的 Agent／維護者負責，沿用正常 PR；同一小改不拆成十幾個空 PR。

| ID | 工作包 | 真正相依 | 驗收重點 |
|---|---|---|---|
| RS-00 | 現況、媒體、依賴、CI baseline 盤點；更新現行決策 | 無 | 可重跑報告；不混入正式 secrets／media |
| RS-01 | R2 資源／配置與安全接線 | 有權 operations 身分 | staging/prod/backup 分離；私有；Cloud smoke |
| RS-02 | Migration ID v2 相容＋release manifest | 無，可與 RS-01 並行 | 既有 ledger 原封不動；並行新增不撞號 |
| RS-03 | ObjectStore、MediaAssets schema／intents、故障測試 | contract 已定；schema 落地需 RS-02 | R2/DB failure cases、no long transaction |
| RS-04 | 頭像＋會員／名片／列表 vertical slice | RS-03 | 真正 R2 存取、版本、撤權、存在判斷 |
| RS-05A | 技能投稿圖片 | RS-03；沿用 RS-04 interface | 私人／公開、升級投稿、作者歸屬不變 |
| RS-05B | 活動 banner／video／highlights | RS-03 | 各 scope、variants、Range／影片 seek |
| RS-05C | 社群縮圖／服務封面 | RS-03 | SSRF 邊界、替換、pause／hide／delete |
| RS-06 | backfill／verify／restore 工具與演練 | RS-03；可先用 fixtures | 可續跑、內容不變、delta、回退最低版本 |
| RS-07 | CI affected pipeline＋inventory 移位 | 無；跟變更 mapping 接線 | selected jobs 正確；unknown full fallback |
| RS-08 | 確定性 merge／native protections／可選 queue 接線 | RS-02、RS-07 的 policy contract | 人授權、current SHA/base、無 bypass |
| RS-09A | 前端 App.tsx responsibility extraction | 無，避開 active PR 同檔大改 | 行為／畫面／焦點不變 |
| RS-09B | API route safety profiles | RS-03 contract；漸進搬路由 | 預設拒絕、webhook 原始 body、驗權保留 |
| RS-10 | staging→production R2-only／backfill | RS-01、04、05、06 | 真實 bucket／DB 全量證據 |
| RS-11 | 移除 legacy blob read/write/schema | RS-10 + backup/rollback 證據 | 无新 media DB bytes；七類全部讀 R2 |

### 17.1 四條並行線

A：資源／migration／storage／搬遷。
B：各 media domain adapters 與前端／API 模組整理。
C：CI／guardrails／inventory。
D：審核／merge deterministic execution。

接線與發布才按技術相依排序，不要求 A 全部 production 完成才讓 B/C/D 開工。RS-04 的一條完整 vertical slice 用來固定共同介面，其他類別可以同時寫測試與 adapter，避免各自發明不同的媒體協定。

### 17.2 PR 提交規則

一個 PR 一個可審閱責任；schema、adapter、功能路由相依寫清楚。不要把整個 storage 搬遷、UI 重設計與 CI 更換塞進同一份巨型 PR。

對已有人工作的分支先同步事實；保留原作者 commits，不 force-push 他人分支。不再每次來源有變就另開替代 PR，除非確實沒有可寫權且維護者採用既有替代流程。

PR 內文最小包含：對應 RS-ID／需求、前後行為、不變條件、資料與 secret 邊界、migration／相依、確切 head、實跑命令結果與 not_run。可用機器生成摘要，不寫大量無法核實的「all safe」。

---

## 18. 驗收矩陣

### 18.1 Storage 與資料一致性

| ID | 測試 | 通過條件 |
|---|---|---|
| S01 | 七類新媒體上傳 | 實際 R2 object 存在；DB 僅 metadata/pointer；既有 DTO 正確 |
| S02 | 新 DB media bytes 寫入 | R2-only 下被拒絕；crypto bytea 不受誤傷 |
| S03 | 同 key retry | 不重複 pointer、quota、journal 或成功 receipt |
| S04 | 同 key 不同內容 | 409；不污染先前版本 |
| S05 | R2/Images delay | 不長持 domain/user DB lock；另一合法交易可完成 |
| S06 | 部分 variants／R2 success DB fail | 無 ready dangling pointer；可續跑或回收 |
| S07 | DB success response lost | 重送回原結果，不重新掛回已取代版本 |
| S08 | 上傳中撤權／刪目標／換圖 | finalize 拒絕舊操作，保留新狀態 |
| S09 | object 遺失／破壞 | 明確 unavailable/evidence，不回舊私密圖 |
| S10 | GC 與 finalize 同時 | live object 不被刪；fencing／狀態轉換有效 |
| S11 | invalid input／假 MIME／超 cap／動畫 | 保持原拒絕規則，不因 R2 接線放寬 |
| S12 | video Range／HEAD／If-Range | 正確 bytes/headers/206/416 邊界；可實際 seek |

### 18.2 權限與隱私

| ID | 測試 | 通過條件 |
|---|---|---|
| A01 | 跨社群／他人資產 id | 无權者不得連接／讀取；DB 最終提交拒絕 |
| A02 | revoke share／rotate／取消 avatar opt-in | 下一次授權判斷拒絕舊入口 |
| A03 | session 撤銷、退出公會、停用 user | 原資格限制完整保留 |
| A04 | 暫停／隱藏／刪除服務或活動 | 舊 URL 不繞過 domain state |
| A05 | cache hit／304／HEAD／Range | 全部先驗權，不靠 body 是否需要傳輸決定 |
| A06 | R2 public domain／r2.dev | 正式媒體 bucket 不能匿名直讀 |
| A07 | JSON／log／receipt／trace | 無原始 bytes、share token、credential、私人 URL |
| A08 | SSRF preview + R2 存檔 | redirect／host／size 邊界不變；不能讀內網或轉存未授權秘密 |

### 18.3 搬遷與恢復

| ID | 測試 | 通過條件 |
|---|---|---|
| M01 | 有舊資料的 bridge | 原網址仍能讀；不存在資料不被誤判有圖 |
| M02 | 全量 backfill | 每筆／每variant 可分類；size+實際 digest 相同 |
| M03 | 中途停止／重跑 | 可續跑，不重复資產，不將未完成標成功 |
| M04 | 來源同時更改／刪除 | 舊副本不覆蓋新 pointer、不使刪除復活 |
| M05 | R2-only 舊 writer | 不能新增 DB blob，出明確錯誤 |
| M06 | rollback | 回退到 R2-aware release 後，新舊資產皆可按權限讀 |
| M07 | restore | 隔離 DB+R2 還原集合完整，應拒絕者仍拒絕 |
| M08 | cleanup | legacy read route／bytes／相關存在判斷已退場，必要 evidence 保留 |

### 18.4 架構與交付

| ID | 測試 | 通過條件 |
|---|---|---|
| D01 | Import graph 反例 | browser→db、Worker→ops SDK、新增不准循環會 fail |
| D02 | pure docs PR | 不啟 DB/browser；verify 正常回報 |
| D03 | runtime MD 假裝 docs | 仍選到 generation/runtime tests |
| D04 | selected job cancelled/skipped | 不被 verify 當成功 |
| D05 | 修改 selector/workflow | 可信基線與獨立審查仍生效 |
| D06 | 舊／自審／失格 approval | merge 被拒絕，不靠 AI 自行判讀放行 |
| D07 | head／base 前進 | 重驗或 queue 驗證，不合併未測組合 |
| D08 | 沒有人按按鈕 | 無新增 GitHub merge／Approve／push／comment 副作用 |
| D09 | App/API extraction | 既有業務、三主題、手機／焦點／autosave／聊天行為保留 |
| D10 | deployment config drift | 不能將 staging DB 綁 prod bucket；missing MEDIA 不當成功部署 |

---

## 19. 上線與回退 Runbook

### 19.1 Staging

以合成資料建立七類 assets／授權組合，驗 Node fixture、local workerd，再驗真實 staging R2/Images。套 expand schema、部署 bridge、啟用 R2-only、執行 backfill／full verify、restore／rollback 演練。核對 deployment receipt 的 source SHA、migration manifest、bucket logical identity、private access 與實際 health/capability。

### 19.2 Production

沿用既有正式發布授權，不新增第二個平台审批。發佈前備份現有 DB、完成受控 restore 證據與 dry-run inventory。部署 exact tested release，觀察媒體讀寫／例外，切換新寫入，再有界 backfill。

Schema migration 與搬檔分開；不把 object copy 放進 transaction-only SQL runner。恢復／中斷只影響這一輪搬遷或相應媒體寫入，不清正式內容。

### 19.3 暫停／回退觸發

Digest mismatch、跨社群／匿名可讀、ready pointer 缺檔、原功能大量錯誤、DB lock 異常等，停止受影響寫入／搬遷並保留 evidence。R2 access／資料一致性問題不要用「先 fallback DB」掩蓋。

修復使用最後一個 R2-aware release；public URL／domain ACL 保持。需要從 backup 恢復時，使用完整 backup set，不只 restore DB。

### 19.4 Evidence 最小欄位

`environment`、`source_sha`、`tree_sha`、`migration_manifest_digest`、`tool_version`、`started_at`、`completed_at`、`counts_by_class`、`bytes_by_class`、`verified_objects`、`exceptions`、`test_command`、`result`、`not_run`、`rollback_release_sha`。

適合放 R2 evidence 的大報告不塞進 DB；DB 保存小型摘要／reference／digest。私密 evidence 不作公開 PR artifact。

---

## 20. 可觀測性、成本與維運

### 20.1 必要指標

| 面向 | 指標 |
|---|---|
| 完整性 | ready pointer missing object、digest mismatch、未處理例外、orphan、backfill coverage |
| 延遲 | media prepare/finalize transaction duration、Images duration、R2 put/get、TTFB、stream abort |
| 容量 | total bytes/objects/variants、pending/retired bytes、upload size 分布、DB legacy media bytes |
| CI | PR wall time、runner-minutes、各 suite 時間、取消／重跑、真正 regression 與 flake |
| Merge | 等 review／checks／conflict 原因、失格／舊 SHA 拒絕、AI repair 次數 |

日誌不含原始 IP／UA（除既有明確政策）、token、private URL、media body；不得因新增 dashboard 引入第二套監控 SaaS。

### 20.2 R2 成本模型

2026-10-01 官方頁列 Standard：storage $0.015/GB-month、Class A $4.50/million、Class B $0.36/million，R2 對外傳輸不收 egress；其他串接計量服務仍可收費。Standard free tier 是帳戶使用量層面的共用額度，不按本計畫每個 bucket 各送一份。[C12]

例如 100 GB 持續一個月，若 10 GB-month free storage 尚可用，單純 storage 約 $1.35；未計 API、Images、Workers、備份副本或其它既有用量。這只是算式示例，不是專案帳單預測，也不是採購上限。

一張圖多個 variants、HEAD/LIST、重試與備份都可能增加操作數。上傳時固定產出 variants，之後讀現成 bytes，避免每次畫面瀏覽都轉圖；不要為省 R2 request 而繞過權限或把 bytes 存回 DB。

### 20.3 不做虛構的優化承諾

搬走 blob 應以結構責任、可恢復性與實測效能判斷，不保證 p95 立刻降低或 PostgreSQL tier 立刻能降。受信任 metadata authorization 仍會讀 DB，這是正確權限成本，而非應被刪掉的多餘查詢。

---

## 21. 最終完成定義

本計畫不是「bucket 建好」就完成。需同時符合：

- 七類現有動態媒體的新寫入與有效舊資料都使用 R2；無未解釋的待搬遷資料。
- PostgreSQL 不再承擔媒體 bytes 持久化；必要 crypto／structured data 不受錯誤搬移。
- 原網址、核心 DTO、授權、版本／冪等、撤銷與公開範圍保留；所有間接 presence projections 正確。
- R2／Images 外部 I/O 不在 domain DB lock 內；競態與故障有重現測試。
- 全部環境隔離與 bucket 私有狀態有實際證據；application 無 backup／account-wide key。
- Backup＋restore＋最低可回退版本已驗；不是只保留 DB dump。
- Migration v2 已由本機與正式工具一致支援，歷史 ledger 不變；不再手改共同 max number。
- CI 依影響選擇、可取消舊 PR run、完整性檢查沒有被偷刪；所選必要結果可靠彙總。
- 真正的 GitHub protection／review eligibility 已驗，正常 merge 不再依賴 LLM；無人授權時不寫 GitHub。
- App.tsx／API 組裝熱點完成責任拆分，未換框架、未新增第二份業務真相。
- 現行 manifest、architecture map、模組責任說明與部署證據一致；每個未完成項有明確 not_run／缺口，不用文件頁數宣稱完成。

---

## 附錄 A：交給 Coding Agent 的開工指令

以下是任務說明，不是可繞過實際帳號權限的授權。

> 請在 FreeTWAI-AI/freedom-platform 執行 docs/plans/platform-restructure-r2.md 的指定工作包。先讀目前 main、AGENTS、CONTRIBUTING、現行需求／架構與相關 PR，保留其他人的已合併功能。
>
> 已決定使用 Cloudflare R2 保存所有動態媒體 bytes；PostgreSQL 僅存業務與媒體 metadata。不要再建新的 DB blob 寫入，也不要新增微服務、第二個 DB、Redis、Queue 平台或通用 Agent runtime。
>
> 本輪範圍請寫明 RS-ID、檔案範圍、相依、保留行為與驗收。先做共用 storage contract 與故障測試，再接 domain。R2/Images I/O 不得放入 domain transaction；finalize 重新驗權、版本與 intent。
>
> 歷史 migration 不改；新格式上線前先完成所有 migration tooling 相容。不得把 schema SQL runner 拿來搬 R2 檔案，也不得把 production 當本機測試。
>
> 一個 PR 一個完整責任，保留真實作者。不要 force-push、Approve、merge、部署、讀 secrets 或建立雲端資源，除非本次工作另有明確授權且連線權限存在。
>
> 報告必須列 source/head SHA、實跑指令／結果、生成 artifacts、缺口／not_run、下一個真正技術相依。不得用舊 SHA 的成功、mock R2、文件聲明或 command exit 0 冒充真實 cloud／restore 驗收。

---

## 附錄 B：資料來源

本文件的架構安排、表名／state 設計、工作包、保留預設與測試矩陣是針對此 repo 的設計建議。下列來源用來支撐現況與服務能力，不代表來源已實作本計畫。

### Repository

- [R1 — pinned wrangler.jsonc](https://github.com/FreeTWAI-AI/freedom-platform/blob/3de70ccbd24362a7925508fb42d36aaa256a0806/wrangler.jsonc)
- [R2 — pinned image-cloudflare.ts](https://github.com/FreeTWAI-AI/freedom-platform/blob/3de70ccbd24362a7925508fb42d36aaa256a0806/packages/shared/image-cloudflare.ts)
- [R3 — pinned avatars.ts](https://github.com/FreeTWAI-AI/freedom-platform/blob/3de70ccbd24362a7925508fb42d36aaa256a0806/modules/identity-membership/avatars.ts)
- R4 — schema／projection search 快照 `c78efb93cbf47f0812e17006c47413001b649a40`，為本次 main 的父版本；schema 盤點需由 RS-00 在最新基準重新執行：
  - [016 member avatars](https://github.com/FreeTWAI-AI/freedom-platform/blob/c78efb93cbf47f0812e17006c47413001b649a40/migrations/016_member_avatars.sql)
  - [028 skill submissions](https://github.com/FreeTWAI-AI/freedom-platform/blob/c78efb93cbf47f0812e17006c47413001b649a40/migrations/028_skill_submissions.sql)
  - [045 event banners](https://github.com/FreeTWAI-AI/freedom-platform/blob/c78efb93cbf47f0812e17006c47413001b649a40/migrations/045_community_event_banners.sql)
  - [050 event media](https://github.com/FreeTWAI-AI/freedom-platform/blob/c78efb93cbf47f0812e17006c47413001b649a40/migrations/050_event_media.sql)
  - [065 highlights](https://github.com/FreeTWAI-AI/freedom-platform/blob/c78efb93cbf47f0812e17006c47413001b649a40/migrations/065_event_highlights.sql)
  - [066 promotion](https://github.com/FreeTWAI-AI/freedom-platform/blob/c78efb93cbf47f0812e17006c47413001b649a40/migrations/066_share_promotion.sql)
  - [067 services](https://github.com/FreeTWAI-AI/freedom-platform/blob/c78efb93cbf47f0812e17006c47413001b649a40/migrations/067_member_services.sql)
  - [member-sharing projection](https://github.com/FreeTWAI-AI/freedom-platform/blob/c78efb93cbf47f0812e17006c47413001b649a40/modules/identity-membership/member-sharing.ts)
  - [social-posts projection](https://github.com/FreeTWAI-AI/freedom-platform/blob/c78efb93cbf47f0812e17006c47413001b649a40/modules/community/social-posts.ts)
- [R5 — pinned migration runner](https://github.com/FreeTWAI-AI/freedom-platform/blob/3de70ccbd24362a7925508fb42d36aaa256a0806/scripts/database.ts)
- [R6 — pinned verify.yml](https://github.com/FreeTWAI-AI/freedom-platform/blob/3de70ccbd24362a7925508fb42d36aaa256a0806/.github/workflows/verify.yml)
- [R7 — main branch API（動態資源；本文記錄查詢時的 protected:false）](https://api.github.com/repos/FreeTWAI-AI/freedom-platform/branches/main)

### Cloudflare 官方文件（2026-10-01 查閱）

- [C1 — Images binding](https://developers.cloudflare.com/images/optimization/binding/)
- [C2 — R2 consistency](https://developers.cloudflare.com/r2/reference/consistency/)
- [C3 — R2 durability](https://developers.cloudflare.com/r2/reference/durability/)
- [C4 — R2 Workers binding / local development](https://developers.cloudflare.com/r2/api/workers/workers-api-usage/)
- [C5 — Data location hints](https://developers.cloudflare.com/r2/reference/data-location/)
- [C6 — Public buckets](https://developers.cloudflare.com/r2/buckets/public-buckets/)
- [C7 — R2 Workers API reference](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)
- [C8 — Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
- [C9 — Presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/)
- [C10 — Object lifecycles](https://developers.cloudflare.com/r2/buckets/object-lifecycles/)
- [C11 — Bucket locks](https://developers.cloudflare.com/r2/buckets/bucket-locks/)
- [C12 — R2 pricing](https://developers.cloudflare.com/r2/pricing/)

### GitHub 官方文件（2026-10-01 查閱）

- [G1 — Required status checks](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks)
- [G2 — Workflow concurrency](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency)
- [G3 — Pull request merge API](https://docs.github.com/en/rest/pulls/pulls#merge-a-pull-request)
- [G4 — Merge queue](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue)
