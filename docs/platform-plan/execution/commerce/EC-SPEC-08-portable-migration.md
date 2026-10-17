# EC-SPEC-08 可攜營業版本與遷移：模式、授權子集、匯出匯入、寫入者移交

狀態：proposed（2026-10-15），基準 `efaf314d`。對應需求 EC-R41（匯出的部分）、R47～R54；驗收 EC-AT01、AT53～AT62、AT71（全部 `not_run`）。標「提議」的表、路由、檔案與工具尚未存在。

C3 才交付本文件的內容，但它是本案的必要成果，不是附件（計畫 §15、§23.2）。C2 可以先宣告可用；C3 沒完成，就不能宣告「站內＋可攜營業」整個專案結案。本文件不阻擋 C2 的任何工作，但 C2 的資料設計要先守住 §4、§5 需要的條件（穩定 ID、凍結快照、單一寫入者）。

## 1. 現況（已核對）

| 項目 | 現況 | 位置 |
| --- | --- | --- |
| Node 主機 | 只建立 pool 與 app，固定綁 `127.0.0.1`，啟動訊息寫「no payment execution」；沒有物件儲存與排程 | `apps/platform-api/src/server.ts` |
| 物件儲存 | 介面 `ObjectStore` 只有 `putImmutable`、`get`、`head`、`delete`；實作只有 R2 與測試用 fake | `packages/asset-storage/index.ts:177`、`r2.ts`、`fake-store.ts` |
| 排程 | 只有 Worker 的 `scheduled()` 依旗標跑具名工作 | `apps/platform-api/src/worker.ts:431-458` |
| 圖片處理 | Node 端用 sharp（libvips 是 LGPL） | `packages/shared/image-node.ts:1` |
| 備份 | 整個平台的 PostgreSQL snapshot＋物件一致備份與還原；沒有單一商店的匯出 | `packages/media-migration/` |
| 匯出授權 | 一般成員授權不能有用途與期限，也不能含 `module.data.export` 等能力；註解寫明「Export/purpose-bound grants remain closed」 | `migrations/131_tenant_module_permissions.sql:1`、`:20`、`:26-27` |
| 會員資料匯出 | 只在 openapi 草稿（`createMyDataExport`），沒有實作 | `docs/platform-plan/contracts/openapi-outline.yaml` |
| 外移規則 | 單一寫入者世代、先存操作再連網、結果不明先查詢，都還沒做 | `modules/agent-commerce/hosted/inventory-reservations.md:49-73` |
| 授權欄位 | descriptor schema 不允許額外欄位，沒有 license 或 SPDX 欄位 | `governance/schemas/module.schema.json` |
| 可攜發行物 | 沒有；`portable_profile_ref` 都是 NULL | WP-00 §6 |

對應的缺口是 WP-00 的 G-10～G-14。

## 2. 支援模式與官方 profile

### 2.1 四種模式（計畫 §15.1）

| 模式 | 程式與資料 | 收款、物流、發票帳戶 | 中央平台中斷時 | 首次交付 |
| --- | --- | --- | --- | --- |
| H 站內託管 | 平台 | 商家自己的帳戶，金鑰封存在平台（EC-SPEC-04 §1.3） | 不能營業 | C2 |
| C 自架前端、中央服務 | 會員的前端＋中央 API 與結帳頁 | 同 H | 不保證能下單；前端要顯示無法結帳 | C3 |
| S 完整自架 | 會員的 runtime、資料庫與物件儲存 | 商家自己的帳戶，金鑰只在會員的系統 | 自有商品照常營業；中央供貨商品停止新操作並說明（EC-AT56） | C3 |
| X 混合模組 | 指定模組在外部，其餘在中央 | 依模組 | 依版本化契約；外部模組不可用時，相關操作停止並說明 | C3：外部庫存（§5.4） |

C 不能包裝成 S。S 連回平台是會員的選擇（供貨、曝光、合作），不是隱藏的啟用金鑰；撤銷連線後，自有商品不會被遠端停業（EC-AT62）。

### 2.2 C 模式的交接

自架前端負責瀏覽與購物車；結帳、付款返回與訂單頁留在中央的 `/shops/:slug/...`。這樣不需要跨網域 cookie 或 CORS，訂單存取憑證（EC-SPEC-02 §4.2）照舊。

- 提議 `GET /shops/:slug/cart?add=<sku>:<qty>,...`：最多 50 行，在中央建立購物車後顯示一般的購物車頁，價格與庫存一律由中央重算（EC-SPEC-02 §5）。
- 商品資料用既有的公開 JSON（`GET /api/v1/public/stores/:slug`，60 秒快取，EC-SPEC-02 §6）；給自架前端用的版本化契約在 WP-09 定案。

### 2.3 官方 profile（DC11 的建議預設）

一個 container 映像，內含：

| 組件 | 內容 | 要補的缺口 |
| --- | --- | --- |
| 應用 | Node 24；只組裝商店需要的路由：身分、事業、商店、commerce、資產、provider adapter（提議新的組裝入口 `apps/commerce-standalone/`） | 現有 `createApp` 組裝整個平台；server 固定綁 `127.0.0.1` |
| 資料庫 | PostgreSQL 18；套用和平台相同的 migration 鏈 | 逐一核對 seed 不含中央的私有事實（WP-09） |
| 物件 | 提議 `packages/asset-storage/fs.ts`（本機檔案，`O_EXCL` 只建不覆寫、寫入後驗 SHA-256）與 `s3.ts`（S3 相容、條件寫入 `If-None-Match: *`）；兩者都實作同一個 `ObjectStore` | G-13 |
| 排程 | 提議 `apps/commerce-standalone/scheduler.ts`：依同樣的旗標、在計時器上呼叫和 `scheduled()` 相同的工作函式（EC-SPEC-10 §5） | G-13 |
| Email | 提議 SMTP adapter；沒設定時，需要寄信的功能（B10 遺失憑證的信件連結、售後通知）明確顯示不可用 | Worker 只有 `EMAIL` binding |
| 管理者 | 本地使用者與管理員；第一位 owner 以 bootstrap 指令建立（計畫 §15.2） | 平台的 session、密碼雜湊、跨 tenant 資料不跟著搬 |
| 前端 | 對外 TLS 由會員自己的反向代理處理；映像內只監聽設定的介面 | — |

選 container 的理由：會員的主機只要能跑 Docker（或相容的 runtime）就能裝，版本、Node 與 libvips 都固定。Cloudflare Workers 等其他 runtime 列為相容性，不是官方支援（DC11）。

H 與 S 共用同一份純領域規則、契約與 provider adapter；只在 runtime、身分與物件儲存的適配層不同（計畫 §15.2）。不另外維護一套商務核心。

## 3. 授權子集與發行清單（DC07、DC10）

### 3.1 現在的權利狀態

摘要自 WP-00 §5：

- 平台：`NOASSERTION`、沒有根目錄 LICENSE；草稿 PR #689 提議原創程式改採 MIT（DC07）。
- npm 相依：lockfile 少了授權欄位的 33 項，實際安裝的套件是 MIT 24、ISC 8、Apache-2.0 1。sharp 帶的 libvips 是 LGPL（14 項）；lightningcss 是 MPL-2.0，只在建置時使用。
- 素材：自由工坊原始 Logo、AI 姊姊圖、龍、貼圖、VERSEFOLK 與 RPG 主題素材、EC 參考圖都不在可攜子集（WP-00 §5.3）。

### 3.2 子集的規則

- 只收錄路徑白名單，不是「整個 repo 減去黑名單」。每個收錄路徑都要有 SPDX 授權；`NOASSERTION` 的路徑不能進子集。
- 第三方程式保留原授權與著作權聲明，統一列在 `NOTICE`。
- container 映像內含 libvips：附 LGPL 全文與 libvips 原始碼的取得方式；sharp 以動態函式庫載入，保留替換的能力。實際義務在發布前由 Ted（必要時法律專業）確認。
- lightningcss 只在建置階段使用，不進執行映像。
- 素材：預設只帶原創的占位設計；會員自己的品牌與商品照片由匯入取得（§4），不打包在發行物裡。
- 不帶任何 MCP 設定（`mcpServers`）、`.env`、金鑰、測試用的 provider 帳戶資料（EC-SPEC-07 §6.3）。綠界公開的測試特店資料只能出現在測試 fixture，不出現在設定範本。

### 3.3 發行清單 `freedom.portable-release/v1`（提議）

| 欄位 | 內容 |
| --- | --- |
| `release_id`、`version` | 發行物的識別與版本（自己的版本，不等於站內應用或書的版本） |
| `source_commit` | 建置用的 commit（40 字元） |
| `build` | Node 版本、lockfile 的 SHA-256、建置指令、映像 digest |
| `paths` | 收錄的路徑與 SPDX 授權 |
| `excluded` | 排除的路徑與原因（素材、授權不明、平台專用） |
| `notice_sha256`、`sbom_sha256` | `NOTICE` 與 SBOM（CycloneDX JSON）的雜湊 |
| `migrations` | migration 鏈的範圍與每一個檔案的 digest |
| `modes` | 支援的模式與每項能力的狀態，從 EC-SPEC-10 §2.6 的能力清單產生 |
| `contracts` | API、事件、匯出格式（§4.3）的版本 |
| `assets` | 隨附素材的來源與授權 |

### 3.4 檢查工具

提議 `scripts/portable/check-release.mjs`，任一條不符就失敗：

- 收錄路徑缺授權，或有 `NOASSERTION`；
- 路徑落在素材排除清單；
- 缺 LICENSE、`NOTICE` 或 SBOM，或 SBOM 和 lockfile 不一致；
- 含 `mcpServers` 設定、`.env`、私鑰格式或 provider 金鑰的字樣；
- `source_commit` 不在 repo 的歷史上，或 migration digest 和 repo 不同。

DC07 確定、#689 合併之前，可以建置與檢查，但不能公開發布；啟動台也不顯示下載（EC-SPEC-07 §3.4）。

### 3.5 發行物內容（計畫 §15.2）

| 組件 | 內容 |
| --- | --- |
| 程式與部署 | 原始碼、lockfile、可重現的建置、container 映像、單店啟動設定、health、排程、備份入口 |
| 資料與物件 | migration、匯出匯入工具（§4）、物件清單與 checksum |
| 設定與介接 | 沒有秘密的設定範本、provider profile、callback 網址設定、替換金鑰的步驟、連回平台的步驟 |
| 操作文件 | 安裝、升級、備份、還原、停機與回復、常見失敗、資料與權限的邊界。總入口技能書第 10 章連到這份文件（EC-SPEC-07 §5.2） |
| 來源與相容性 | LICENSE、`NOTICE`、SBOM、上游採用清單、API／事件／資料格式版本與支援矩陣 |

## 4. 商店資料的匯出與匯入（EC-R41、R51）

### 4.1 有用途、有期限的授權

一般成員授權刻意不能匯出（`131:20`、`:26-27`），這條不改。另外提議 `tenant_export_grants`：

- 只有事業 owner 能建立；用途固定 `commerce.store_export`，綁定一個商店 instance；
- 有效 24 小時、只能用一次；建立、使用、到期都寫稽核；
- 能力 `module.data.export` 不會出現在一般授權裡。

### 4.2 範圍

| 包含 | 不包含 |
| --- | --- |
| 商店設定、外觀、政策的所有版本 | 任何 provider 金鑰（封存的金鑰永遠不匯出） |
| 商品、變體、分類、照片（物件本體） | 平台的會員、session、密碼雜湊 |
| 本店的顧客與結帳聯絡資料 | 其他事業的私有資料：供應商的庫存、成本以外的條款、顧客、帳戶 |
| 訂單、行項、凍結的 terms、付款 attempt、退款、履約單、shipment（不含標籤檔）、發票、售後、對話 | 標籤 PDF（含收件資料；需要時到物流商重印） |
| 自有商品的庫存、hold、已付款配置 | 平台的稽核紀錄與營運資料 |
| 供貨商品：下單當時凍結的供貨條款與合作的 ID（合法快照） | 供應商目前的庫存與其他合作 |
| 本店那一側的供貨帳目與對帳單 | 對方那一側的私有帳目 |

匯出含本店顧客的個資。畫面在建立匯出前說明這點；下載連結只給 owner。

### 4.3 格式 `freedom.store-export/v1`（提議）

- `manifest.json`：格式版本、商店 ID、匯出時間、資料的 snapshot 時間、schema 版本、每種資料的筆數、每個檔案的 SHA-256。
- `data/<資源>.jsonl`：每行一筆，保留原本的 UUID 與版本號。
- `objects/<sha256>`：物件本體，以內容雜湊命名。
- 資料在單一 `REPEATABLE READ` 唯讀交易內讀出，物件依當下的指標讀取並驗證雜湊（做法同 `packages/media-migration/` 的備份）。
- 下載：入口有效 7 天（OPEN-07 的匯出下載連結期限）；每次下載重新確認是 owner，再發一個只給這次匯出、15 分鐘有效的網址；7 天後刪除檔案（EC-SPEC-09 §3）。

### 4.4 匯入（目標是 S 或 X）

- 先驗 manifest 與每個檔案的雜湊；任何一個不符就整包拒絕（EC-AT58）。
- 依原 UUID 寫入。同一包匯入兩次，結果相同、不重複（EC-AT58）；目標已有同 ID 但內容不同的資料時，拒絕該批並列出差異。
- 所有參照都要找得到對象，不留斷掉的參照。
- 匯入後，本地 owner 用 bootstrap 建立；平台的成員與角色不會跟著過來。

## 5. 遷移出去與單一寫入者（EC-R52～R54）

### 5.1 流程（計畫 §15.4）

1. 預檢：列出在途項目——已付款未出貨的訂單、有效的 hold 與配置、已建立未送達的 shipment、`unknown` 的退款、待更正的發票、未結的對帳單。每一項保留穩定 ID。
2. 一致匯出（§4）。
3. 目標匯入並核對筆數與雜湊。
4. 暫停這間店的新寫入（只影響這間店，不承諾零停機），或追平暫停前的增量。
5. 在途項目對帳。
6. 移交寫入者（§5.2）與網址（中央的店面轉址到新網址）。
7. 驗證新站。
8. 依 §5.6 處理中央的舊資料。

### 5.2 寫入者世代

提議 `commerce_writer_fences`：每個範圍（一間店，或外部庫存的一組 item）一列，欄位是 `writer_generation`（遞增）與 `writer_location`（`central` 或外部 binding）。

- 改到庫存、hold、配置、訂單的**每一條**寫入路徑，都在同一個交易裡以 `FOR SHARE` 讀這一列，世代與位置不符就拒絕（`writer_moved`）。範圍包含：下單與付款、賣家手動改庫存、匯入、管理工具、排程工作、還原後的工作。只有訂單路徑加檢查、手動改庫存仍能繞過，不算完成（計畫 §15.5）。
- 移交時，在同一個交易中把世代加一、位置改成外部；之後中央的舊寫入一律失敗。

### 5.3 還原時舊寫入者不能復活（EC-AT61、EC-AT63）

從移交之前的備份還原時，還原出來的 fence 會以為自己還是寫入者。所以：

- 還原後 commerce 的寫入全部暫停（隔離模式），直到操作者以外部寫入者簽署的世代紀錄核對 fence；不符就保持暫停（EC-SPEC-10 §8.3、§8.5）。
- 已撤權的會員不會因還原恢復權限（沿用 T-047 的限制）。
- 這段在 T-047 解決前是已知限制，列在發布檢查。

### 5.4 第一個 X 旅程：外部庫存（EC-AT59）

A 店把自有商品的庫存移到外部；中央的 B、C 店仍販售 A 供貨的商品：

- 中央透過遠端庫存契約（提議 `InventoryPort`：預留、轉為配置、釋放，每個操作有操作 ID）呼叫外部。操作先存進中央的資料庫，再連網；結果不明時先查詢，不直接重送（`inventory-reservations.md:59-63`）。
- 10 件時 6＋5 不能同時成功；hold 在移交、取消、到期後仍正確；無關的 D 店不受影響。
- 詳細契約在 WP-10 隨實作定案。

### 5.5 在途的 provider 通知（EC-R53、EC-AT60）

綠界的付款通知、物流通知與折讓通知網址都是每筆交易各自帶的（EC-SPEC-04 §3.4、EC-SPEC-05 §5.2、EC-SPEC-06 §3.8）。新站建立的交易自然用新網址；遷移前建立的交易仍會通知中央。

- 中央的舊入口在緩衝期內只接受**既有** attempt、shipment、折讓的通知，照常驗證簽章與帳戶，再經簽章的轉送交給新的寫入者；不建立任何新的商務操作。
- 兩邊都用相同的來源識別去重，同一事件只生效一次。
- 驗證需要商家的金鑰：中央保留封存的金鑰，只用於驗證，直到在途項目都結束並過了緩衝期，再刪除封存列。新站的金鑰由商家重新輸入，不從中央匯出。
- 已開立的發票由同一個商家發票帳戶開出；新站用同一組帳戶就能作廢或折讓，不需要中央。
- 會員退會不會讓已授權的最後一筆通知被丟掉；但新扣款、新 shipment、重新連線仍需要當下的權限（計畫 §15.4）。

### 5.6 中央保留的最小資料（EC-R54、EC-AT62）

- 保留：店的 ID 與轉址、仍有效的合作連線、操作結果、法律或契約要求的交易快照（例如中央供應商參與的訂單，供應商那一側的帳目）、稽核紀錄。
- 不保留：店的商品、顧客、訂單的完整鏡像。緩衝期過後只剩上一行的資料；期限依 DC12 定案（EC-SPEC-09 §3）。
- 平台自己的會員與公會事實不因會員的業務匯出而刪除（計畫 §15.5）。

### 5.7 連回平台

S 模式的店可以選擇連回：讀取供貨目錄、轉送供貨商品的訂單、接受曝光。連線有範圍、可撤銷；撤銷後中央停止新的合作操作，已成立的合作依原條款完成，自有商品不受影響（EC-AT62）。

## 6. 三種資產的連結與下載入口

- 站內的模組版本不可修改，發行物又比模組版本晚出現，所以下載入口不依賴 `portable_profile_ref`。提議一份經 PR 審查的靜態清單 `contracts/portable-releases/v1/releases.json`，每一筆是已發布的發行物：`release_id`、版本、對應的站內應用版本、支援的模式、發行清單的 SHA-256、下載網址、checksum、授權。
- 提議 `GET /api/v1/portable-releases?application_key=hosted-store` 回傳這份清單；`PortableBusinessStatus`（EC-SPEC-07 §3.4）只顯示清單裡的發行物。清單是空的，就只顯示狀態。
- 之後登錄的模組版本可以在 `portable_profile_ref` 寫上相容的發行線（例如 `freedom.portable/commerce-s1`），供相容性檢查使用；畫面不依賴它。
- 總入口技能書第 10 章連到發行物與其操作文件（EC-SPEC-07 §5.2）。

## 7. 程式位置與 migration

| 項目 | 位置 | 里程碑 |
| --- | --- | --- |
| 匯出授權、fence | 新 migration（C3 開始時的下一個編號） | C3 |
| 匯出、匯入 | 提議 `modules/agent-commerce/portable/`；descriptor 依 [work-plan.md](work-plan.md) | C3 |
| 獨立組裝、排程 | 提議 `apps/commerce-standalone/` | C3 |
| 物件儲存 adapter | `packages/asset-storage/fs.ts`、`s3.ts`（提議） | C3 |
| 發行清單與檢查 | `scripts/portable/`、`contracts/portable-releases/v1/`（提議） | C3 |

C2 要先守住的條件：所有 commerce 資料用 UUID 與版本號；交易當時的條款凍結在 terms；外部呼叫一律經可查詢的 operation（EC-SPEC-04 §3、EC-SPEC-05 §5、EC-SPEC-06 §3）。

## 8. 測試（全部 not_run）

| 測試 | 驗收 |
| --- | --- |
| 上游與平台來源都固定；MIT 與 `NOASSERTION` 分開；沒有授權的部分不能發布（審查本文件 §3 與 WP-00 §5） | EC-AT01 |
| 沒有發行物時不顯示下載，也不拿原書或 CSV 代替 | EC-AT53 |
| 離線檢查發行物：原始碼、建置、lockfile、migration、操作文件、SBOM、`NOTICE` 齊全；沒有排除清單上的素材、MCP 設定或秘密 | EC-AT54 |
| 全新的 runtime、資料庫、物件儲存：依技能書安裝、建立本地 owner；health、migration、備份可用；不需要中央的資料庫或秘密 | EC-AT55 |
| 阻斷中央連線、不提供模型金鑰：自有商品可以完成購買與出貨；中央供貨商品顯示受限 | EC-AT56 |
| A 店匯出含照片：A 的資料完整、有合法快照；沒有 B 供應商的庫存、顧客或帳戶 | EC-AT57 |
| 同一包匯入兩次結果相同；雜湊錯誤整包拒絕；參照完整 | EC-AT58 |
| 外部庫存移交後舊寫入者被拒；B、C 仍用同一份庫存；D 不受影響 | EC-AT59 |
| 舊網址與新網址同時送出既有事件：只生效一次、交給正確的寫入者、舊端不建立新交易 | EC-AT60 |
| 還原移交前的備份後，舊工作與後台改庫存都被 fence 拒絕；撤權的會員不復活 | EC-AT61 |
| 連回後撤銷：中央只剩約定的資料；自有店照常營業；新的合作操作被拒 | EC-AT62 |
| 非核心部署者只靠發行物與技能書完成營業、升級與備份，不需要原開發者補秘密或 SQL | EC-AT71（真人） |

## 9. 仍待決

| 項目 | 建議 | 只影響 |
| --- | --- | --- |
| DC07 可攜授權 | #689 合併後完成路徑白名單與相依、素材的權利對帳 | 公開發布 |
| DC11 官方 profile | 單一 container：Node 24＋PostgreSQL 18＋本機或 S3 相容物件儲存 | C3 的支援範圍 |
| libvips 的 LGPL 義務 | 發布前由 Ted（必要時法律專業）確認 | 映像的發布 |
| 匯出檔是否另外加密 | C3 先用每次 15 分鐘的下載網址、7 天後刪檔；加密在 C4 | 下載後的保管 |
| 舊通知的緩衝期 | 在途項目全部結束後再 30 天 | 中央保留金鑰的時間 |
| 中央舊資料的保留期 | 依 DC12（EC-SPEC-09 §3） | 遷移後的清除 |
| C 模式的交接 | 中央購物車預填網址（§2.2） | 自架前端的結帳方式 |
