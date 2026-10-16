# SC-SPEC-06 發布、資料相容、回退與試用

需求：SC-R36、R39、R40。驗收：AT-42～48。

## 目的與非目標

- 定義新版怎麼開、怎麼關、關掉後資料與操作怎麼辦，以及試用與舊頁退場的條件。
- 本文件**不**授權部署、改正式資料、開旗標、寄信或聯絡會員。每一步都由 Ted 決定，Agent 只準備候選與證據。
- 非目標：新的部署工具、逐事業的白名單機制、整庫回退。

## 1. 功能設定

| 設定 | 預設 | 誰設定 | 說明 |
| --- | --- | --- | --- |
| `FREEDOM_SUPPLIER_CONSOLE_ENABLED` | 關 | Ted，經 release wrapper 的環境設定 | 新畫面與新讀取的開關；需同時開 `FREEDOM_GUILD_LAUNCHPAD_ENABLED` 才生效（`site.supplier_console_enabled` 取兩者的 AND，見 SC-SPEC-03） |
| `FREEDOM_HOSTED_STORE_PHOTOS_ENABLED`／`…_PHOTO_UPLOADS_ENABLED` | 依現況 | 同上 | 照片沿用既有設定；`deploy/cloudflare/lib/media-wrangler.mjs:72-74` 與 `apps/platform-api/src/worker.ts:158-159` 已檢查組合 |

- 這是開關不是授權：每一次讀寫仍由伺服器驗目前的 tenant、instance 與能力。
- 環境變數存在部署端的私人設定，不在 repo（`deploy/cloudflare/environments.json` 的 `execution` 說明）。
- 建議不做逐事業或逐會員的灰度（D-13）：平台現有功能都用 host 設定，新版與舊版用同一套 API 和資料，風險在使用體驗而不是資料，用「staging 先跑完、正式一次開、有問題立刻關」即可。

## 2. 各批次的資料相容

| 批次 | Schema | 寫入的資料 | 舊 runtime 讀到時 | 相容性 floor |
| --- | --- | --- | --- | --- |
| S1 | 無 migration、無新欄位、無新媒體用途 | `commerce_shops` 的名稱／說明（既有欄位）；journal `storefront.supply-profile.update`（operation 只受 `migrations/078_scoped_member_commands.sql:11` 的格式檢查）；純供貨商品的照片（既有用途與表） | 名稱正常顯示；純供貨照片被舊的私人讀取忽略（`photo-projection.ts:33` 的條件），也不會進公開投影 | 不變 |
| S2 | 預計只有讀取；若要索引才有 migration | 無 | — | 有 migration 時照 S3 規則 |
| S3 | 素材三張表、新用途 `storefront.supply-material` 與其 storage policy、容量用途清單 | 素材、版本、授權、物件 | 舊 runtime 不認識新表，不會寫；但舊的容量計算不含新用途，所以回退時必須關閉素材上傳 | 新增 release-compatibility shape，備份／還原含新表與物件（AT-43） |

已套用的 migration 不改 bytes；migration 編號在實作時取當時的下一號（基準時最大為 `167_community_ar.sql`）。

## 3. 固定候選的發布順序

1. 確認沒有尚未部署的必要安全修補；有的話先處理那些。
2. 選定一個已合併的 main SHA 作為候選，之後不追新的 main。
3. 候選的完整 CI 通過（同一個 SHA；取消或略過不算）。
4. 經 release wrapper：備份 → 套用 migration（S1 沒有）→ grants 檢查 → 部署到 staging，新版先保持關閉，確認舊頁與既有測試行為不變。
5. staging 開新版，跑真 API 旅程：J01、J02、J03（兩個帳號）、J04 供應端、J06；照片在真 R2 上傳與讀取。用合成帳號與合成資料。
6. staging 回退演練：關新版 → 舊讀取仍是同樣的商品、條件、選品與預留；同一個書籤（含新頁的深層連結）打開舊頁，並核對畫面上的實際數值，不能只確認頁面打得開。再開回新版後，同一書籤核對營運中心商品詳情的實際數值。檢查定義見 [WP-07](WP-07-release-evidence.md)。
7. production：同一個候選。先部署且保持關閉，確認正常後由 Ted 決定開啟時間，開啟後觀察錯誤率與回報。
8. 每一步都留 receipt（SHA、環境、時間、結果）；任何一步失敗就停在那裡，不跳過。

固定候選、合成驗收腳本與各步驟的證據與現況記在 [WP-07 發布證據](WP-07-release-evidence.md)。

## 4. 回退

| 情況 | 做法 | 結果 |
| --- | --- | --- |
| 新版有問題 | 關 `FREEDOM_SUPPLIER_CONSOLE_ENABLED` | 重新整理後回到舊頁；資料與 ID 相同；新讀取路由 404 |
| 新版的深層連結在關閉後被打開 | `HostedStore` 把 `#stores/<t>/<i>/supply/…` 導到同一事業的舊供貨商品庫。驗收要求該頁出現事業名稱，以及所選商品的供貨單價、庫存與說明，且不出現「找不到這間商店」或「找不到這個供貨商品庫」 | 書籤保留同一筆資料，並核對實際數值 |
| 送出中或未確認的操作 | attempt 只在記憶體；旗標切換要重新整理才生效，所以不會有半途換畫面的命令。伺服器端每個命令是單一交易，結果只有「已完成」或「未發生」 | 使用者重新整理後看目前資料；需要時重做 |
| 照片上傳中 | intent 自然到期；finalize 有冪等 key | 不會留下可讀的半成品 |
| 預留 | 營運中心不建立或改動預留，只讀與設定開關 | 不受影響 |
| 程式回退到 S1 之前 | S1 沒有 schema 變更，前一版 runtime 可直接用 | 純供貨商品照片暫時看不到，roll forward 後恢復；不刪任何資料 |
| S3 回退 | 先關素材上傳，再退 runtime；不做 down migration、不刪歷史 | 合作店家暫時讀不到素材 |

不以整庫還原作為改版回退。庫存相關仍遵守 pre-162 writer 不能回退與 T-047 的還原隔離（`modules/agent-commerce/hosted/inventory-reservations.md`）。

## 5. 試用（M3／M4）

由 Ted 邀請與安排；Agent 不聯絡會員，只準備任務卡與記錄表。

| 對象 | 人數 | 任務 |
| --- | --- | --- |
| 供應商 | 至少 2 | J01（第一次開始）、J03（審核申請）、J02（隔天回來繼續）；S3 後加 J05 |
| 賣家 | 至少 2 | 在自己的店選用供貨商品、送出售價、等待同意、發布 |
| 非核心公會作者 | 2 | `guild-supply` 區塊的作者任務（SC-SPEC-05 §6） |

- 不同裝置（至少一位手機）。
- 記錄：完成與否、耗時、求助次數、卡住的位置、是否需要 DB／API 代操作（需要就是 blocker）。觀察者可以問「你在找什麼」，不能代按。
- 只用合成資料或取得同意的試用內容；記錄不含個人資料。小樣本只描述發生了什麼，不推成成功率。
- 門檻（計畫 13.4）：兩位供應商、兩位賣家自主完成；跨 tenant、庫存、重試類 blocker 為零。

## 6. 舊頁退場

條件全部成立才開退場 PR：

1. J01～J06 在新版完成，且 staging 與 production 都驗過。
2. 試用完成，沒有只能回舊頁才能做的主要操作。
3. 舊測試都有新版的對應案例並在同一候選通過（對照如下）。
4. 舊連結全部導到新版的正確頁面。

| 舊測試 | 新版對應 |
| --- | --- |
| `hosted-supply-catalog.spec.ts`：owner 讀取成功才顯示預留設定、讀取失敗恢復 | 設定頁的預留區塊 |
| 同檔：回應不可讀時保留原操作（新增商品、改內容等） | `supplier-console.spec.ts` 的 J06 |
| 同檔：預留開關的未知結果與離開保護、CAS 衝突、admission 關閉 | 設定頁 |
| 同檔：admin／唯讀不能看預留、拒絕後入口不出現、換人登入後晚到的讀取 | 預留頁與導覽（AT-04、34） |
| 同檔：草稿保護與一次一個工作區 | 商品詳情的分區草稿與離開保護 |
| 同檔：商品卡顯示供貨版本與待確認申請 | 商品清單與概覽待辦 |
| `hosted-supply-terms.spec.ts`：條件跨登入保留、回應遺失重試、舊分頁需重看 | 商品詳情的供貨條件區（AT-06、07） |
| `hosted-distribution.spec.ts` 的供應端步驟 | 審核頁；賣家端步驟不變 |
| `hosted-shared-orders.spec.ts:169` 供應端讀自己的行項 | 預留頁（J04） |

退場 PR 移除 `HostedSupplyCatalog` 的供應端畫面、`HostedSupplierOrders` 與新版旗標；保留仍被使用的共用部分（`HostedReservationSetting`、照片狀態、`HostedDistribution` 的賣家端）。不把 `legacy` 永久留著。

## 7. R1 完成與 R2 邊界

- R1 完成清單見計畫第 17 章。營運中心不提供付款、收款、出貨、佣金或模組外移；設定頁的「尚未提供」說明這些。
- R2-A 交易履約、R2-B 推薦佣金、R2-C 單模組外移各自有負責範圍，不是 R1 的前置，也不在 R1 冒稱可用。

## 8. 決策

| 決策 | 建議 | 只影響 |
| --- | --- | --- |
| D-13 正式環境要不要逐事業開 | 不要，沿用 host 設定一次開 | WP-07 |
| 正式開啟時間 | Ted 依 staging 結果決定 | WP-07 |
| 試用名單與時間 | Ted 安排 | WP-07 |
