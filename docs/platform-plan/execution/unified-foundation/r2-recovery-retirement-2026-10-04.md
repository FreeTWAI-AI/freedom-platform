# R2、恢復與舊庫退役操作紀錄（2026-10-04）

本紀錄接續[實際移植](actual-migration-2026-10-04.md)與[P0–P3 計畫](post-migration-plan-2026-10-04.md)。Ted 本輪要求繼續部署、查修網站，並授權「舊資料庫檢查沒問題就可以關掉了，如果東西都在新資料庫跟 R2 上」。本輪先核對資料、媒體、備份及實際恢復，再處理舊資源；未重跑整包來源移植，也未把入口切回舊庫。

公開紀錄只包含版本、aggregate、方法與限制。原始快照、逐列摘要、owner references、憑證及 provider receipts 留在操作者私有目錄；此文件不是獨立第三方 attestation。

## 線上版本及資料路徑

正式站與 staging 的主 Worker 都已部署 #110 merge commit `d269a8d7605630cab1da605d7cac4d0c254e3258`。兩環境只套 pending migrations 112／113；ledger 共 112 筆（檔案最大編號 113），與該 source 的 digest 差異為 0。沒有重新 seed 或覆蓋會員庫。admin-sync 原有程式與 cron 保留。

| 項目 | 正式 | Staging |
| --- | --- | --- |
| 主 Worker version | `0b7ab494-d93d-470a-b450-81b79ce61a59` | `0e79636d-1d4d-4807-92c2-523e331a1a93` |
| Logical DB | `freedom_next` | `freedom_staging_next` |
| 媒體 R2 | `freedom-foundation-production-20261004-media` | `freedom-foundation-candidate-20261004-media` |
| Avatar／banner policy | `bridge` | `bridge` |
| 活動海報 flag | ON | ON |
| 其他五類媒體／Private AI flags | OFF | OFF |

兩個 logical DB 都在 **`freedom-foundation-candidate-20261004-pg`**。名稱中的 candidate 是歷史命名；這個實際承載正式資料的執行個體必須保留，不能當測試庫刪除。Hyperdrive 均指向此新 branch，cache OFF。

更新後的 private release helper 強制保留 banner reader floor，拒絕 false flag／舊 release 搭配新 pointer；本次 source pin 限定 d269，後續 source 必須由操作者重新核對。18 項正反例通過。主 Worker placement 指定 `aws:ap-northeast-1`，與資料庫區域一致；另外 4 項 placement 正反例通過。此配置採用 Cloudflare 的[指定區域 placement](https://developers.cloudflare.com/workers/configuration/placement/)。

## 真正使用 R2 的範圍

操作前重新盤點，正式站已是 **26 個歷史頭像、266,954 bytes，加 1 張海報、81,110 bytes**，共 348,064 bytes；與較早報告的 25 個頭像不同，沒有沿用過期筆數。使用現有 canonical identity／scope backfill 補齊 legacy owner 映射，再依當前批准、immutable representation、完整讀回 digest 及 pointer CAS 搬移。

27 個歷史媒體全數完成；20:24:58 UTC 的最後盤點，兩環境七類媒體的 `legacy_with_bytes` 均為 0。這表示已無仍依賴 legacy 路徑的非空媒體，不代表資料庫所有 bytea 已清除：正式新庫仍保留 26 個頭像與 1 張海報的舊 bytes 作恢復副本。現行 GET 使用 Asset／R2，已核對原有路徑、內容 digest 與存取權限。頭像的 `?v=` 會隨 aggregate version 更新。

Staging 原本七類皆空。本輪用自己的測試會員建立 legacy 頭像／海報正例，實際搬移並驗證新上傳、替換、移除與未授權拒絕。正式另用自有測試會員驗證新頭像寫入 R2、DB 不保存新 image bytes。最終正式桶共 30 個物件、348,644 bytes，其中 27 個是歷史媒體，3 個是已退役的操作測試物件；staging 桶 9 個、8,254 bytes，均為本輪測試保留物件。兩桶均無公開 r2.dev／custom domain，透過應用權限讀取。

**GC 與 legacy bytes 清除仍未開啟。** 五個原本空白的用途（技能圖片、活動影片、活動精華、社群縮圖、服務封面）仍未完成各自的受控雲端正例、權限、Range／播放及恢復驗收。不能用本輪頭像／海報結果宣稱七類全部驗收。

## 實際恢復及每日異地備份

先從新庫的同一 exported snapshot 產生 pg_dump 及逐表全欄位摘要／counts／sequences，實際還原到隔離 PG18 並比對。此階段正式 192 表、16,387 rows，staging 192 表、3,279 rows；與切換當時的 140 表基線屬不同時點／schema，不能直接比較總數判斷資料遺失。兩環境還原比對均通過。

媒體搬移後，另使用現有 `createConsistentAssetBackup`、maintenance fence 及 pins，將同一 exported snapshot 的資料庫與所有可恢復 R2 representations 保存為一組。從異地桶完整下載、驗證 archive SHA-256，再實際還原 PostgreSQL，核對 DB object references，並以 canonical transfer restore 到本機 Miniflare 原生 R2 binding，逐物件完整核對 bytes／metadata。這是實際資料與實際 R2 runtime 的隔離恢復，**不是已演練切換至另一個正式雲端站**。

| 環境／完成時間 UTC | Dump bytes／SHA-256 | R2 數量／bytes | 恢復結果 |
| --- | --- | --- | --- |
| Staging 19:38:32 | 1,408,824／`7a8fc2c1a5bbbc2f0c8fae8e9dcef92ab0b93a5344b60f5b34ea9f215782c33c` | 2／1,962 | DB refs、原生 R2 讀回一致 |
| 正式 20:20:13 | 5,092,134／`844295cf517bf6e0912dee6960b78db326c860aec5e4bd84c7e9d78557c9a1cd` | 30／348,644 | DB refs、原生 R2 讀回一致 |

以上是完成時間，精確 snapshot 時點見私有 capture receipts。Staging 恢復在後續新增／刪除測試前完成；最新每日備份另涵蓋最終 9 個保留物件。正式恢復 archive 為 5,662,720 bytes，SHA-256 `9d4c52b411e10b800009a6b4566cdf5f31c5a7bdda1bb0550383b1781c79769a`。

異地桶 `freedom-database-recovery-20261004` 無公開入口，沒有 app Worker binding。原來源的最後 frozen dumps、原始精確還原證據、新庫 snapshots、DB＋R2 archive 均已上傳並完整下載核對 SHA-256。副本位於操作者主機及 PlanetScale 之外；媒體與異地 archive 同在 Cloudflare 帳戶，尚非跨 Cloudflare 帳戶的災難隔離。

保留原有 `freedom-next-backup`／`freedom-staging-next-backup` timers，在 service 成功 pg_dump 後追加 offsite-media 步驟：驗證 archive、複製當前所有 immutable R2 物件、驗 metadata／digest、打包上傳並完整讀回。正式 20:26:21 UTC 成功（30 物件），staging 20:18:15 UTC 成功（9 物件）。此每日方法是 **dump 後的 immutable object superset**，依賴 GC 關閉、零 deletion fences；不是上述 coordinator 同一 snapshot pins，也不是 PITR。每日仍未自動產生同 exported snapshot 的全欄位摘要／counts／sequences。

可恢復到保存的 dump 時點；其後寫入需另有較新備份，不能承諾零資料損失。排程仍依賴這台操作者主機上線；本機 media archives／R2 副本的自動 retention 尚未設定。開啟 GC 前必須先改成具持續 pins 的一致性備份。這些限制保留在 P0 後續範圍。

## 實跑網站核對與修正

| 核對 | 結果與邊界 |
| --- | --- |
| 正式 #110 HTTPS | 100 項通過，包含部署、註冊、會員與訊息流程 |
| Staging HTTPS | 首次訊息請求 timeout 保留失敗紀錄；後續 messages 專項及共用前置重跑通過 |
| 正式瀏覽器 | Desktop 登入、重新載入、登出、cookie、console／routing 核對通過；未以此宣稱 mobile 全站驗收 |
| 歷史正式媒體 | 60 項通過，涵蓋 26 頭像及 1 海報的來源／Asset／HTTP 內容與權限 |
| Staging 頭像／海報 | 分別 18／18、15／15 通過 |
| 正式新媒體操作 | 30／30 通過，實際註冊、R2 寫入、替換、移除、ACL |
| 最終 placement | 兩環境各 9／9 通過，包含登入、上傳、R2 讀取及未授權／移除拒絕 |

檢查時發現跨區資料庫往返放大了上傳延遲。指定 Tokyo placement 後，同一操作類型的單次正式上傳由先前最慢 27,806 ms 降至 2,472 ms，staging 為 2,474 ms。這是本輪觀測，不是負載測試、長期 p95 或可用性承諾；接續 [#107 登入速度](https://github.com/FreeTWAI-AI/freedom-platform/issues/107) 還應持續觀察真實裝置。

[#109 GitHub Star 失敗](https://github.com/FreeTWAI-AI/freedom-platform/issues/109) 仍未解決；先前查核確認實際授權拒絕，會員授權／Repo 存取仍需核對，不能拿模擬 GitHub 測試冒充真人成功。

兩項程式修正已獨立提交並 ready for review；查核時各 14 個 hosted checks 全部 success，**尚未合併／部署**：

- [#111](https://github.com/FreeTWAI-AI/freedom-platform/pull/111)：避免舊 session／中止請求清除新登入，補上傳與 MemberApp request generation 防護；50 項 targeted unit、53 項 selected browser 通過。
- [#112](https://github.com/FreeTWAI-AI/freedom-platform/pull/112)：remaining backfill 計數排除已移除頭像的 NULL bytes，避免實際搬完卻報未完成；先重現失敗，再以隔離 PostgreSQL／原生 R2 的 29 項測試核對，typecheck 通過。首輪 CI inventory mismatch 修正後重跑全部成功。

## 操作中的失敗與剩餘狀態

私有 operator 使用受限 SQL grants、當前 DB approval 及原生 R2。原生 cron 曾接受設定但未取得成功執行證據；實際搬移透過 Wrangler loopback caller 的 `remote: true` service binding 呼叫部署中的私有 RPC，沒有建立公開 execute 入口。不能宣稱已驗收可靠的定時搬移服務。

新 cluster 僅 25 個連線，兩個臨時 operator pool 與 app pools 同時存在時發生連線耗盡。完成後移除 operator 的 DB／R2 bindings、刪除 operator 專用 Hyperdrives、撤銷 migration approvals，並僅終止已退役 operator 的 3＋5 個 idle backend；未終止 app backend。Future operator 要逐環境安裝，不能假設 Hyperdrive origin limit 是跨整個 cluster 的硬上限。

曾有過期 job／不明外部 PUT 結果。保留既有 intent、effect ledger、lease 與 immutable key，依 canonical resume 重試並完成 CAS；未把一次 404 推論成外部動作未發生。仍有一筆歷史 started／unsettled object-write effect 保留，不偽造結案；GC 維持 OFF。operator release identity 仍是 operator-declared，不能拿這次成功補成 P2 trusted publisher 證據。

本輪的正式 3 個、staging 5 個自有測試帳號已停用，sessions 撤銷；自有測試活動已取消，測試媒體 pointer 已移除，audit rows 與退休物件保留。未修改其他人的帳號。兩個搬移 callers 也已明確 OFF、清除 service bindings 與 schedules；臨時 staging Access policy／token 已刪除，未授權 staging 請求仍導向 Access。隔離恢復／測試容器已移除，其他工作容器保留。20:32:26 UTC 的清理後正式 health 仍為 200、d269、ok。

## 舊庫退役及交接

退役前重新核對兩個舊來源仍為切換時的完整資料：正式 140 表／15,989 rows／387 users，staging 140 表／3,203 rows／8 users；全欄位摘要／counts／sequences 與 frozen 基線一致，原始還原到新 branch 的精確比對證據保留。舊 app 寫入權限為 0，所有 Worker 對舊 Hyperdrive 的引用為 0；provider 預設 postgres 無業務表，其餘額外庫確認為 provider 內部用途。舊 final dump 與還原證據也已存至異地桶並完整讀回核對。

完成上述條件、DB＋R2 恢復及最新日備份後，依 Ted 的條件式授權執行刪除：

| 舊資源 | 完成時間 UTC | Provider 回讀 |
| --- | --- | --- |
| `freedom-staging-next-pg` | 20:27:14 | Database 已不存在；舊 Hyperdrive 已刪除 |
| `freedom-next-pg` | 20:27:19 | Database 已不存在；舊 Hyperdrive 已刪除 |

每次刪除後重新核對新 cluster 仍在、main branch ready，以及正式／staging health HTTP 200、release SHA d269、status ok。這是退役兩個舊執行個體，沒有刪除承載現行兩個 logical DB 的新 cluster，也沒有刪除異地快照。資料不能再由舊實例直接查詢；需要歷史資料時使用保留的 frozen dump。

私有操作目錄為 `~/.local/state/freedom-media-retirement-20261004/`；重點 receipts 包括 `final-audit.completed.json`、兩環境 `*-media-backup.completed.json`、`production-media-sweep.completed.json`、`*-old-source-proof.completed.json` 及 `database-retirement.completed.json`。它們記錄實際時點，不應重新執行帶 completed／started 防重入標記的腳本。

後續主 Worker 發布由 `placement-release-next/`、`placement-release-staging/` 接續；canonical `release-latest.txt` 已指向本輪正式 plan。舊 `actual-migration/current-release/` 的 9cc／全 OFF templates 已過時，禁止直接部署。必須維持新的 R2 reader floor，不能僅切 legacy flag 或用舊 helper 做回退。

P1 尚餘五類用途正例、legacy bytes 清除與 GC 的完整條件；P2 可信 publisher／App-bound enforcement 及負向 PR，P3 私人 AI／跨端 Autopilot 的真人流程均未因此完成。後續沿用[現有計畫](post-migration-plan-2026-10-04.md)，不另起架構。
