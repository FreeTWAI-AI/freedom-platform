# 2026-10-04 實際資料移植與流量切換

2026-10-04 09:03:44 UTC，正式站 [freetwai.com](https://freetwai.com) 與受 Access 保護的 [staging.freetwai.com](https://staging.freetwai.com) 已切換至新的 PostgreSQL 環境。兩個入口均實際回應首頁／health 200，部署版本為 `0.13.0-member-messages`，release SHA `9cc283c6976a920b5f481ec605a7f468044e3a1b`。

本次依 Ted 的直接移植指示執行，沒有再加獨立預演。完成的是既有會員平台、資料與 legacy 媒體內容移植；媒體仍以資料庫 bytea 儲存。新 R2 已分環境接線，object backfill／非 legacy policy、Private AI、broker 與 machine execution 保持 OFF。這份紀錄不宣稱 R2 轉存或完整 Autopilot 已完成。

## 資料與切換結果

| 項目 | 正式站 | Staging |
| --- | --- | --- |
| 邏輯資料庫 | `freedom_next` | `freedom_staging_next` |
| 最後來源快照會員數 | 387 | 8 |
| 來源資料表數 | 140 | 140 |
| 來源資料列總數 | 15,989 | 3,203 |
| 最後來源 dump 大小 | 4,316,421 bytes | 734,314 bytes |
| 還原後、migration 前資料比對 | 全部來源表的欄位／逐列 SHA-256 多重集合／筆數／序列值一致 | 同左 |
| Migration ledger | 110 份 canonical files，最後編號 111 | 同左 |
| HTTPS 驗收 | 66／66 通過 | 66／66 通過 |
| 新環境每日備份工作 | 真實執行成功，checksum 通過 | 同左 |

數字是最後凍結快照，不是切換後持續變動的即時人數。驗收另各建立一位 synthetic member，兩者均已停用、所有 session 已撤銷，稽核／定位／公會紀錄保留；不把測試帳號計入原始會員數。沒有 seed、逐表重新配號或重建真實會員帳號。

新目標是 Tokyo 的 `freedom-foundation-candidate-20261004-pg`，PostgreSQL 18.6、PS5 ARM 單節點。原本零會員的 candidate schema database 先改名保留，兩個實際目的資料庫重新以空 public schema 建立，再還原來源；沒有把完整 dump 蓋進既有 schema。正式與 staging 使用不同資料庫、runtime／migrator／backup roles、Hyperdrive 及私有 R2。Hyperdrive cache OFF，來源連線上限各為 5。

正式 Worker 名稱維持 `freedom-platform-next`／`freedom-admin-sync-next`；staging 維持 `freedom-platform-staging-next`／`freedom-admin-sync-staging-next`。四個 Worker 已更新至新連線，原有 secrets、Access、EMAIL、IMAGES、註冊 community 及相關設定經回讀核對保留。主站與 admin-sync 排程已恢復，credential-renewal timer 已接新庫並實跑成功。

## 實際操作與核對

1. 保存來源部署設定、ACL 與操作前一致性備份。來源沒有 R2 pointers，原始媒體內容位於資料庫。
2. 暫停四個 Worker 的 cron 與本機 renewal，將兩個入口暫時路由到 Opus 5.5 實作的 maintenance Worker。08:48:48 UTC 記錄 maintenance route 生效，08:48:58 UTC 完成來源 app 寫入封鎖及連線排空。
3. 取得最後 exported PostgreSQL snapshot；同一快照生成 custom-format dump 與完整來源資料摘要，保存全部 public sequence 狀態。失敗紀錄保留，未刪 marker 重跑整包。
4. 以 PG18 client、`verify-full` TLS、單一 transaction 還原到空目的地。先核對全部 280 張來源表，再套用 36 份 pending migrations。完成 migrator ownership、PUBLIC function ACL lockdown、runtime／operator grants 與實際角色登入核對。
5. Grok 4.7 撰寫、Sol 審查的第二套 snapshot 工具另行核對兩環境的 users／sessions，均一致。它與主要還原摘要是兩套實作；不以只有 row count 相等當完整資料證明。
6. 部署固定 9cc 的主站與 admin-sync bundle，先恢復 staging，再恢復正式入口。09:03:44 UTC 切換 receipt 完成，原 cron 及 renewal 恢復。
7. 真實 HTTPS 驗收涵蓋 preflight 5、health 12、protocol 2、assets 15、anonymous 16、registration 16，每環境共 66 項。實際註冊、定位、主要公會、onboarding、session、重新登入、登出及 Origin 防護均通過。沒有把未選用的 browser／load／完整消息 phase 計為完成。

操作中已依具體錯誤修正 PG client 系統根憑證設定、空 schema restore 範圍、臨時 owner membership、systemd user bus 環境與 Cloudflare route 傳播等待。失敗及修正 receipts 留在私有 journal；所有已完成步驟以 provider／SQL 回讀確認。

## 媒體盤點與真實讀取

新資料庫的七來源 aggregate inventory 均完整執行。正式站有內容的 legacy 媒體為 25 個頭像（258,694 bytes）及 1 張活動海報（81,110 bytes）；其餘五類沒有 bytes，staging 七類均無 bytes。資料表列數可以包含沒有媒體的 metadata，不能直接當媒體檔案數。

以本輪 synthetic member 的短效 session 抽驗 8 個既有頭像及該活動海報，GET／HEAD 全部 200，回傳 bytes 的 SHA-256 全部符合新庫保留內容；所有來源資料 bytes 另已包含在完整 dump／restore 摘要比對中。沒有修改真會員 session、媒體內容或 ACL；短效驗收 session 及兩個驗收帳號已完成清理。空類別如實記為 empty，沒有虛構七類皆有正式 HTTP 正例。

## 備份與後續操作

最後來源 dump SHA-256：

- 正式：`279277f398d8bf8c9fd0fd76438ad2fd63b39ef66f92445cca667606b3762052`
- Staging：`3d8c622d3e79a3738658a12b9db590842ca3059bcb371d2b73208774bfb7b08b`

兩個原有每日備份 timer 現在使用新庫的專用唯讀 backup role，透過 disposable PG18 client 執行，避免依賴已停止的本機 compose DB。兩個 service 均於 09:05:54 UTC 成功結束；新備份分別為 4,958,046 與 1,381,487 bytes，archive TOC 與 SHA-256 已核對。這是本機保存、離開資料庫供應商的邏輯備份；本輪沒有額外進行另一套離線災難恢復演練，也沒有把本機檔案稱為異地備援。

routine release／admin-sync 私有部署工具已更新新 Hyperdrive；release template 保留正確的 R2 bucket、七個 OFF flags、EMAIL 與 cron。兩個真實 read-only release plans 均通過，三項針對性的 regression checks 通過，正式 release pointer 已更新。這些 plan 沒有另行部署第二次。

舊來源資料庫、切換前備份及 ACL 原件保留；舊 app 的資料表／欄位／序列寫入權限已封鎖。**新庫已接收寫入，不能直接把流量切回舊庫。** 後續採前向修正或從相符的新快照一致性恢復，不能丟棄切換後的新資料。maintenance Worker 已確認無 route／cron／custom domain 後刪除；臨時 Access policy／token 已刪除，synthetic sessions 已撤銷，不刪來源恢復材料。

## 程式交付與仍未完成範圍

本輪把工作拆成八個 GPT-6.1 Sol 工作包；環境僅允許主 agent 加三個子 agent 同時執行，因此採分批並行。Grok CLI 的 Grok 4.7 與 agy CLI 的 Opus 5.5 均實際產出程式，經整合審查使用。

- `561bd8c`：media inventory／verify 接受 PlanetScale branch-qualified username，仍核對實際 SQL role／database。
- `20eccbc`：Opus maintenance Worker；真實 workerd 3／3、四個 mutation 反例及 dry-run 通過，無 DB binding。
- `0d92e53`、`6237f8f`：Grok snapshot evidence 與安全修正；專用真實 PostgreSQL suite 8／8 通過，包括資料欄位與 table alias 同名的回歸。
- `f6788a3`：保留 CodeQL alert 39 的精確分析及發布 gate 缺口，未 dismiss 或排除安全 query。

實際部署的 9cc 有其 [hosted Verify 證據](https://github.com/FreeTWAI-AI/freedom-platform/actions/runs/37186706935)：runtime 2,620／2,620、Worker 60／60、合成 DB/native-R2 restore 2／2、UI 413 pass／5 既有 disabled-feature skips。這不是後續工具／文件 commit 的完整 CI 結果。整合後另實跑 `npm run typecheck`、maintenance Worker 3／3、文件 inventory 1,726 hashes／994 local links（0 failures）及 `git diff --check`，均通過；新 head 的完整 hosted CI 以 GitHub 實際結果為準。

截至本次移植收尾的 09:18 UTC，R2 全量 object backfill／非 legacy 切換、七類皆有正例的雲端 HTTP 媒體驗收、完整恢復產品驗收、CodeQL alert 39 正式核定、可信 publisher 與 App-bound GitHub 強制 gate 仍有剩餘工作。這些缺口沒有藉此次資料切換改記 PASS；當時 PR #108 保持未合併；後續授權、安全判定及合併結果請讀[最新交接](handoff-2026-10-04.md)及 PR 紀錄。完整原始 Autopilot／私人模型／跨端執行仍在後續範圍。

原始 dump、憑證、Access、完整 provider metadata、私有 journal 與驗收 JSON 保存於操作者本機 `~/.local/state/freedom-foundation-candidate-20261004/actual-migration/`，不隨 Git 公開。接手入口見[最新交接](handoff-2026-10-04.md)；過往 checkpoint 留在[交付紀錄](implementation-status.md)及[發布狀態](release-readiness.md)。
