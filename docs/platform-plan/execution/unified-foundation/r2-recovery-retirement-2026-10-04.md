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

## 新版封存的真實資料還原（2026-10-05）

這是其後新一輪證據，不覆寫上文較早 snapshots。Operator source 為 `88ef1b7b58c20f6aa26f4d4db89c398cbee7d362`，線上 source 仍為 d269。使用新的 coordinator／seal／readback／restore API：先取得同一 exported snapshot 的全表欄位摘要、counts、sequences 與 custom dump，保存同 snapshot object pins，再 create-only 封裝並最後發布 manifest、fsync；異地 TAR 完整下載核對後，還原到自有 network-none PG18 暫存容器及 Miniflare 原生 R2。

| 環境／完成 UTC | 全表 evidence | R2 objects／bytes | Dump bytes／SHA-256 | 異地 TAR SHA-256 |
| --- | --- | --- | --- | --- |
| staging／00:22:26 | 192 表、3,843 rows、2 sequences；matched | 18／30,056 | 1,448,366／`7389e3326a15ad0a84256fd5499a452fd7916c7071e2714789d9e07833992bb1` | `7cd270d344e447e3b1824504d4d50f5d040313805f6d9c2a909485dee112a5b2` |
| production／00:31:39 | 192 表、17,915 rows、2 sequences；matched | 37／382,316 | 5,120,362／`a5a563e306b9507605fcc1374230f582060cee80393fb0edc62f33483f7b7fa6` | `fb9970857fb4ebb0e80b932eb28b149545a3e64657b1fbb5bd73664576a1f72c` |

兩邊所有 sequence 均未超過記錄下限；完整 DB evidence、DB references 及每個 R2 object bytes／metadata 均一致。Manifest SHA-256 分別為 staging `059be3479a212c2262b0decf158fda9091a5886ee6170bd87eadaab9b4df1e89`、production `0200ecdc035e514db089e120abc639630f1584632104f22d905c9858dc6c74b3`。異地副本仍在同一 private Cloudflare recovery bucket，沒有公開資料入口。

Staging 首輪 capture 後因 operator 傳入 `staging-next` 而非 archive schema 的 `staging` 被拒絕；核對已完成 dump／objects、未封裝及 GC OFF 後修正 enum，只接續原 capture。接續完成 seal／異地 readback 後，過長 Unix socket path 造成隔離 PG 連線 EINVAL；清除自有容器，改用短暫存路徑，再以 restore-only 完整重讀同一封存並成功還原，沒有重複上傳或覆寫 archive。正式環境使用修正後 helper，一次完成。

兩個 completion receipts 均在確認 **GC disabled**、自有隔離環境清除後才寫入。恢復結果為 `quarantine_not_approved_for_exposure`：沒有對外服務、沒有替換現行資料庫，也沒有宣稱已完成 cloud cutover、目前撤銷權限重套或 PITR。私有證據在 `freedom-platform-push-20261004/archive-live/{staging,next}-media-backup.completed.json` 及 `archive-live-reconciliation.md`。

既有 daily timers 仍用較早的 disabled-GC object-superset 方法；本輪未把 migrator credential 加入新排程。新版每次 capture 的持續 source pins 保留；自動 retention、日常同 snapshot evidence、獨立排程與跨 Cloudflare 帳戶備援仍待接續。

## 新 daily coordinator 與既有服務切換（2026-10-05）

接續上節尚未切換排程的狀態，本輪使用[既有服務切換方案](../../../development/daily-recovery-backup-installation.md)的同一個 private wrapper，先 staging、再 production，實際執行新的 daily coordinator。Operator source 為 `c3e5a537a75303c4688e01b7f0d8477c3587a26f`，線上 release 仍為 `d269a8d7605630cab1da605d7cac4d0c254e3258`；adapter SHA-256 為 `5d56f5256cbfdd972ed7db3bfb569fc3b271df899772c3bf77ea360efe2e716a`。以下先記錄新 daily 入口的兩次手動驗收；其後的 systemd service 切換與驗收另列於後節，與 timer 自動觸發分開記錄。

| 環境 | Set 建立 UTC／獨立核對 UTC | 全表 evidence | Objects／bytes | Dump bytes／異地 TAR bytes |
| --- | --- | --- | --- | --- |
| staging | 01:36:07.734／01:47:35.712 | 192 表、4,075 rows、2 sequences | 25／44,267 | 1,469,804／1,730,560 |
| production | 01:43:14.889／01:52:50.334 | 192 表、18,011 rows、2 sequences | 37／382,316 | 5,126,880／5,877,760 |

| 環境 | Recovery manifest SHA-256 | Dump SHA-256 | 異地 TAR SHA-256 |
| --- | --- | --- | --- |
| staging | `e69139b645e14b61c0f4f58a66e8024d5617297b5f908c7876c586aafa1836fd` | `6950c1a295ad3966e13f21c167c07bf04f352a774c53f1c935c48460f0aa7e0a` | `37f3146315b2ec9bfc76de9ef6a6023e7a0f1bb5a6b4274e8606d01e8ffe7db3` |
| production | `755b5f151994402a26497a98ee4c47a27539ad96d53923da8a7d37cd07aa8f10` | `6f772554dea29156b0952c4b2bbb72f171a0798078b0aeab0285e674aa93c20d` | `086520f46e3becc7641acfb1fb63b82274b6dbc243f311a80aadfd4e54ab88e0` |

較早的 staging v1 嘗試 `298e2c2e-0de8-451d-a0ea-d086c5d7174e` 在 dump 前被既有 SQL constraint 拒絕：adapter 的 `pin_seconds=172800` 超過允許上限 86400。該次失敗保留，GC OFF／cleanup 已核對；後續只將 private adapter 改為 86400，未放寬 SQL constraint，並以新的 set 完成上列 staging v2 驗收。

兩份 completed receipts 均為 `passed`：同 exported snapshot capture／dump／evidence，seal 後完整下載異地副本，再以該副本實際還原 SQL 與 native R2；`remoteReadback:verified`、`restore:database_and_objects_restored`、`cleanupVerified:true`。操作人另行核對完整 remote digest、GC disabled 及自有容器不存在，保存獨立 acceptance receipts；不是只採信上傳 ACK 或重用先前一輪 archive。Sequences 仍是非 MVCC 的下限證據，不能把上述 counts 宣稱為 snapshot sequence 一致性或未前進的證明。

恢復狀態保持 `quarantine_not_approved_for_exposure`，source pins 保留，未執行 retention、GC、PITR 或 cutover。異地 REST 發布明列 `mode:unique_single_writer`、`atomicCreateOnly:false`：使用同一操作人鎖、新 UUID key、先記錄且 fsync 的單次 PUT intent 與完整下載核對；未冒充 provider 原生 atomic create-only／CAS。

來源檢查已補齊 policy UPDATE 未知 ACK 的精確 backend／revision 對帳、建立前持久記錄自有容器名稱與 labels、Docker client 中止後的自有 daemon container 清理，以及部分配置失敗時的獨立資源關閉。容器建立 ACK 未知且未取得可核對的自有資源時，單次查無容器不能宣稱 cleanup 完成。Wrapper 對兩環境使用同一非阻塞 host lock，固定 Node／source／adapter pins；這些來源檢查與手動正例不等於所有故障情境均已在線上注入驗證。

Aggregate receipts 定位為 `freedom-platform-push-20261004/daily-live/runs/9255e7a8-0bfc-485e-85e3-823f0a980108/`（staging）及 `afc8c38d-7076-4ec6-9a02-f484d841fbff/`（production）中的 `completed.json`、`independent-acceptance.json`。帳號、憑證、object keys、原始 dump 與 provider receipts 不進 Git。

### Service 切換驗收與 timer 恢復

操作人已依 `c3e5a537a75303c4688e01b7f0d8477c3587a26f` 的 reviewed templates，對兩個既有 services 安裝字典順序最後的 `zz-coordinator-20261005.conf`；原 migration／offsite drop-ins 保留。兩個 services 的有效 ExecStart 均已改為新 wrapper，ExecStartPost 經獨立 D-Bus 回讀確認為空陣列。首次 `systemctl` 文字解析即使用 `--all` 仍未列出空的 ExecStartPost，因此 verifier 先拒絕；後續使用 `busctl` 明確核對空陣列，沒有把欄位缺漏當成成功，該解析失敗本身未觸發服務效果。

依切換程序，兩個 timers 暫停，接著依序驗收實際 systemd service 入口。staging service 於 01:55:08–02:02:08 UTC 執行，unit Result `success`、exit status 0；新 set `0a474ba2-d3a8-48c1-af49-c4f9085a3b97` 完成後，02:02:11.702 UTC 的獨立 acceptance 再次核對 full remote readback、GC OFF、自有容器不存在與 quarantine。Production service 於 02:02:11–02:10:22 UTC 執行，同為 Result `success`、exit status 0；新 set `f8a57c7a-0b90-4382-a973-3b11cbcb81f6` 於 02:10:29.461 UTC 通過相同獨立核對。兩個都是由實際 service 入口產生的新 set，未沿用上列 wrapper 手動驗收集。

| Service set | 全表 evidence／objects | Dump bytes／SHA-256 | Manifest SHA-256 | 異地 TAR bytes／SHA-256 |
| --- | --- | --- | --- | --- |
| staging | 192 表、4,109 rows、2 sequences；25 objects／44,267 bytes | 1,470,280／`775169467cc1145236f55046d024598f1d3ade71deeeed59586abbeab709f394` | `79d3e2d843a5439e3dfc951393b22b6db52e6781b2f7847ed9470c72f88baad4` | 1,730,560／`ee4d1bf6a66925884285f4afed177d650ee9316c37596543513d935abaeb0d5b` |
| production | 192 表、18,145 rows、2 sequences；37 objects／382,316 bytes | 5,135,054／`2344aaab12a912780b567b327ce42998663d45982e50df58087259598c0cade7` | `477bab94f04d5c03469b6154de7166f793fb12d09eab92c6d44d671df22c2956` | 5,888,000／`f6e649570c9fc19da12da49e833864c8c504f93f95e12630ceb7beb4697fa1ae` |

兩邊實際 service 驗收通過後，02:10:29.665 UTC 回讀原 timers 均為 active／enabled。原 UTC 04:30（production）與 04:45（staging）、`Persistent=yes`、5 分鐘 randomized delay 均保留；當下 next-trigger 回讀分別為 04:33:52 UTC 與 04:45:17 UTC。舊 unit／drop-in files 保留。安裝與手動 systemd 入口驗收已完成，**下一次 timer 自動觸發尚未觀察**；不能將 armed timer 當成已產生排程備份。

Service aggregate 證據定位為同一私有 journal 的 `daily-live/timer-switch/staging-service-accepted.json`、`production-service-accepted.json` 及 `completed.json`。這輪未啟用 retention／GC／PITR／cutover，亦未完成獨立雲端排程或其他未驗收功能。
