# 公會啟動台與可攜式業務空間：SP-00–SP-12

版本 0.1，2026-10-05。建立時是完整技術規格草案：只有文件與靜態文件驗證，沒有功能實作、正式資料遷移、部署或產品驗收。**2026-10-08 更新：M1 已有部分實作合併並部署到 staging 與 production，兩個環境都已開啟，但 M1 尚未驗收；現況以[目前狀態](#目前狀態)為準。**

目標是全部有效公會都有能保存、返回工作的公版；成員在自己有權的 tenant 啟動應用；每個 module instance 可單獨攜出應用、資料、附件與互通配置，與仍由平台託管的模組繼續合作。一般人工工作不需要模型帳號。公會、主力、職務、tenant、實例與資料權威不能互相代替。

## 目前狀態

<!-- glp-status: as_of=2026-10-08 release.production=cc72c3fd93cea3b1369923b6bd7b8539b23d91d0 release.staging=cc72c3fd93cea3b1369923b6bd7b8539b23d91d0 flag.production=true flag.staging=true repo_max_migration=141 applied_migration.production=133 applied_migration.staging=133 capacity_policy_rows=1 authority_policy_rows=0 accepted_m1=false accepted_full=false -->

本節部署與已套用 migration 是 r9 歷史收據，觀察截至 2026-10-08 19:46Z，不是即時狀態；repository 最大編號則反映本候選原始碼。權威來源是 [unified-foundation 現況快照](../unified-foundation/current-state.json)的 `deployment`、`features.guild_launchpad` 與 `schema`；文字紀錄見 [Foundation 收尾](../unified-foundation/closeout.md)的 10 月 8 日第五輪 rollout、staging 試開、production 開啟，以及第六～第九輪 rollout。上面的 `glp-status` 註解由 `validate-spec-pack.py` 對照來源檢查，CI 的 contracts pytest 也會執行這項檢查，不一致就失敗；更新現況快照的這些欄位時，要同時更新這一節。

狀態行由 `validate-spec-pack.py --write-status` 從 `migrations/`（repository 最大編號）、`current-state.json`（operator 觀察：部署、flag、已套用 migration、政策列）與 `acceptance-progress.json`（各里程碑驗收進度：M1 的 28 案全部有證據通過才接受 M1，60 案全部通過才接受完整計畫）產生。本機候選最新 migration 是 141（商店版型呈現，尚未部署；140 為會員私人收藏／追蹤，尚未部署；139 為私訊圖片 Asset，尚未部署；HO-1/2 候選帶進 138，為自有商品預留的封閉後端，尚未合併或啟用 API；社群搜尋標籤候選新增 137、會員封鎖修復候選新增 136；線上商店會員畫面帶進 135，把線上商店提供給所有公會；線上商店後端帶進 134；#193 的整合 #284 新增 132／133；#244 於 2026-10-08 合併，帶進 126、127；P-D1（#239）帶進 128；P-D2a（#269）帶進 129；P-D2b 帶進 130；P-B2b（#279）帶進 131），r9 時點兩個環境都已套用到 133（128～130 於 2026-10-08 第六輪、131 於第七輪、132／133 於第八輪套用；134、135 在 r9 收據時點尚未套用）。local 執行可以記錄，但不算驗收證據：passed 至少要有一筆 ci、staging 或 production 的通過紀錄。

2026-10-08 電商分類決策：`guild_commerce_sales` 歸 `external`（社群業務推廣）。這是已確認的目標；各環境須由真實有權管理員依 [SP-01 執行步驟](SP-01-guild-preferences.md#2026-10-08-電商分類的執行步驟) 送既有分類命令，保留分類事件與管理稽核。migration 135 不直接更新分類，此處不宣稱已套用。

本候選 S2 會員流程：從電商公會建立業務空間與自己的商店，管理商品、預覽／發布、從 `/shops/<slug>` 看展示頁，再登入可回同一間商店；公開頁明示交易尚未啟用，沒有購買按鈕。分類顯示名稱為「社群架構開發」「社群業務推廣」「社群專業服務」，底層 keys 不變。這些是待發布程式及本機驗證範圍，不能用 r9 收據聲稱已 live 開店或已套用分類；`external` 已授權，目前等待可用的 human Access operator 身份執行。

`accepted_m1`／`accepted_full` 只有在驗證無失敗、里程碑指定 `candidate_sha`，且每案都已通過並有該 SHA 在 ci、staging 或 production 的有效、未被較晚非通過結果推翻的通過證據時才為 true。T-015 與 T-023 依 `acceptance-progress.json` 的 `scope` 採 M1 變體驗收。M1 變體結果記在該案的 `variants.M1`，沿用相同的 `status`／`evidence` 格式，只計入 M1，不計入完整計畫。沒有 `variants.M1` 時，M1 使用該案本身的結果。新增 migration 的 PR 必須重跑 `python3 docs/platform-plan/execution/guild-launchpad/validate-spec-pack.py --write-status`。

- 部署：main `cc72c3fd`（#297 的 merge，第九輪，無 migration）自 2026-10-08 19:19Z 在 staging、19:20Z 在 production 執行；migration 132、133 在第八輪（`e89cd0c8`）兩邊都已套用，131 在第七輪（`3685d626`）、128～130 在第六輪（`d2900cf4`）、126、127 在第五輪（`c84829e2`，M1 候選版本 X）、125 在第四輪（`e8cd72e8`）、120–124 在第三輪（`687dee87`）已套用。
- 啟用：兩個環境都設定 `FREEDOM_GUILD_LAUNCHPAD_ENABLED=true`：staging 自 2026-10-08 06:11Z 起（在 X 上試開），production 自 07:05Z 起（owner 於 06:47Z 決定開啟）。第六輪（`d2900cf4`）、第七輪（`3685d626`）、第八輪（`e89cd0c8`）與第九輪（`cc72c3fd`，Worker 版本 staging `3a5a5308`、production `d80f2817`）都以同一份 dist 部署到兩個環境，flag 維持開啟：第六輪 P-D1、P-D2a、P-D2b，第七輪 P-B2b、P-D3a，第八輪 P-D3a 的目錄修正（#287），第九輪公會首頁設定（D1，#297）隨部署上線。
- 政策列：兩個環境各有 1 列 `tenant_capacity_policies`，值相同（預設範圍、暫時值 10／3／2／1000／104857600／2／0、plan_ref `interim-default-20261007`、revision 1）：staging 於 2026-10-08 05:51Z、production 於 06:55Z 由各自的 migrator 以 #227 的工具寫入，production 依 owner 選擇沿用 staging 的值。`tenant_authority_policies` 兩邊都是 0 列，經營權移交與復原會回 403 `policy_unconfigured`。狀態行的 `capacity_policy_rows` 記的是每個環境各自的列數（兩邊相同）。
- 驗收：M1 尚未接受。第六～第九輪都依 owner 選擇直接上線，沒有跑 staging 驗收，P-D1／P-D2a／P-D2b、P-B2b／P-D3a、P-D3a 的目錄修正與 D1 公會首頁設定沒有 T-ID 證據；第九輪部署後 production 的 33 個公開選定檢查與 4 次新 DNS 解析的 health 讀回都通過（第八輪是 33 與 4，第六、第七輪都是 29 與 4）。X 上 production 開啟後跑了 29 個公開的選定檢查：網站回報 launchpad 啟用，公開分類清單已掛載（catalog revision 24：3 個區塊、12 個已核准、12 個待審）；production 沒有示範帳號，guild-work verifier 只在 staging 執行。staging 試開跑了 47 個選定的檢查：網站回報 launchpad 啟用，公開分類清單已掛載（catalog revision 18：3 個區塊、12 個已核准、6 個待審）。2026-10-08 06:32Z guild-work verifier（#242）在 staging 以真實 R2 通過：T-005 通過；T-023 的 M1 變體（權限半部）通過，完整案例記為 partial（X 沒有匯出路由，匯出還原沒有執行）。M1 的 28 案中有 2 案有通過證據，M1 尚未指定 candidate_sha；[60 項驗收](acceptance.md)的其餘案例仍是 not_run。

M0 規格包（SP-00–SP-12）由 #153（merge `c6f4a2cf`）合併。M1 各部分如下；PR 與 SP 的對應取自各 merge commit 的標題，migration 取自各 merge 對 `migrations/` 的差異。

| M1 部分 | 已合併 | 已部署 | 已啟用 | 已驗收 | 下一步 |
| --- | --- | --- | --- | --- | --- |
| P-A 公會分類與主力偏好（SP-01） | #163，merge `eb4e348e`，migration 120 | 是，`cc72c3fd`；120 兩邊已套用 | 是，兩個環境 | 否 | 2、4、7 |
| P-B1 業務空間授權核心（SP-02） | #164，merge `93e1470b`，migration 121 | 是，`cc72c3fd`；121 兩邊已套用 | 是，兩個環境 | 否 | 4、6、7 |
| P-B2a 經營權移交與受控復原（SP-02） | #175，merge `137ace26`，migration 124 | 是，`cc72c3fd`；124 兩邊已套用 | 是，兩個環境；沒有 authority policy 列，移交與復原回 403 | 否 | 3、4、6、7 |
| P-C1 啟動台殼層與版本化設定（SP-03） | #160，merge `12a2a83c`，migration 122 | 是，`cc72c3fd`；122 兩邊已套用 | 是，兩個環境 | 否 | 4、7 |
| P-C2 業務空間手動工作與人工成果（SP-03／SP-04／SP-06） | #181，merge `57b610ab`，migration 123 | 是，`cc72c3fd`；123 兩邊已套用 | 是，兩個環境 | 否 | 1、4、5、6、7 |
| P-C2-UI「我的工作」畫面（SP-03） | #190，merge `31df6ddb`，無 migration | 是，`cc72c3fd` | 是，兩個環境 | 否 | 4、5、7 |
| P-K／P-K2 啟動台契約（SP-12） | #188，merge `6596263d`；#209，merge `5ccd76c3`；無 migration | 是，包含在 `cc72c3fd` | 不適用，沒有獨立開關 | 否 | 隨上列各部分 |
| P-E1 tenant 表的 row security（SP-06） | #206，merge `70fb6ae7`，migration 125 | 是，`cc72c3fd`；125 兩邊已套用 | 資料庫層已生效，不受 flag 控制 | 否 | 6、7 |
| P-D1 應用目錄、模組實例登錄、啟動操作與容量保留（SP-04） | #239，merge `e3f3b59c`，migration 128 | 是，`cc72c3fd`；128 兩邊已套用 | 是，兩個環境 | 否 | 8 |
| P-D2a 模組實例的暫停與恢復（SP-04） | #269，merge `ed6e47c1`，migration 129 | 是，`cc72c3fd`；129 兩邊已套用 | 是，兩個環境 | 否 | 8 |
| P-D2b 模組實例的封存（SP-04） | #278，merge `d2900cf4`，migration 130 | 是，`cc72c3fd`；130 兩邊已套用 | 是，兩個環境 | 否 | 8 |
| P-B2b 成員的模組實例權限（SP-02） | #279，merge `59cfe68c`，migration 131 | 是，`cc72c3fd`；131 兩邊已套用 | 是，兩個環境 | 否 | 9 |
| P-D3a 公會應用卡與啟動流程（SP-04） | #282，merge `3685d626`；目錄修正 #287，merge `e89cd0c8`；無 migration | 是，`cc72c3fd` | 是，兩個環境 | 否 | 9、10 |
| P-E2 分頁游標綁定與跨業務空間矩陣（SP-06） | #245，merge `87f9fe51`，無 migration | 是，`cc72c3fd` | 是，兩個環境 | 否 | 4、5、7 |
| capacity policy operator 工具 | #227，merge `c84829e2`，無 migration | 是，`cc72c3fd`（operator 工具，不隨 Worker 執行） | 不適用；兩個環境都已寫入相同的暫時值（revision 1） | 否 | 3、4、7 |

下一步相依（都是未完成事項，不是承諾）：

1. PR #227：有界的 capacity policy operator 工具；已合併（merge `c84829e2`，即候選版本 X），2026-10-08 第五輪隨 X 部署；staging（05:51Z）與 production（06:55Z）都已用它寫入相同的暫時預設值（revision 1）。
2. PR #226：#163 的唯讀 backfill／切換狀態；已合併（merge `3e33c736`），包含在 `e8cd72e8`。
3. 缺口：兩邊的 `tenant_authority_policies` 都是 0 列，所以經營權移交與復原會回 403 `policy_unconfigured`。這需要 owner 選定的政策值（[決策待辦](decision-log.md)的 OPEN-02／03），以及類似 #227 的 operator 工具。OPEN-04／13 的 staging 暫時容量值已於 2026-10-07 選定，production 於 2026-10-08 沿用相同的值；OPEN-07 保留期也已於當天決定（見決策待辦），但備份到期清除尚未實作。
4. 只在 staging 的啟用試驗：2026-10-08 06:11Z 起以 X 試開，暫時 capacity policy 已寫入，試開前的備份做過隔離還原與遠端讀回；06:32Z guild-work verifier 通過，06:33Z 開始的試開後備份也做過隔離還原與遠端讀回。主力偏好的 backfill 狀態是 blocked（還有 28 位舊會員未對應，其中 27 位的舊主力公會沒有已核准的分類），所以三分類看板在 staging 仍然隱藏。
5. 在 staging 以真實 R2 做 guild-work 驗收：2026-10-08 06:32Z 完成。owner 先在 staging 管理後台把示範帳號設為兩個原本沒有公會長的公會的公會長（任命時成為正式成員），verifier（#242）的 4 項檢查全部通過，T-005 與 T-023 的 M1 變體記為通過。
6. PR #206（P-E1：tenant 表的 row security，SP-06，migration 125）已合併（merge `70fb6ae7`），2026-10-07 第四輪隨 `e8cd72e8` 部署到兩個環境。備份角色依 owner 選定的路徑取得 BYPASSRLS；兩邊部署後的備份，18 張 row security 表的列數都與 owner 相同。P-E2（#245，不含 P-D1 的部分）已於 2026-10-07 23:47Z 合併（`87f9fe51`）；#244（migration 126、127）已於 2026-10-08 02:40Z 合併（`32899577`），2026-10-08 第五輪隨 X 套用並部署到兩個環境。M1 候選版本 X 是 #227 的 merge `c84829e2`；P-D1（#239，`e3f3b59c`，migration 128）、P-D2a（#269，`ed6e47c1`，migration 129）與 P-D2b（#278，`d2900cf4`，migration 130）都在 X 之後合併，2026-10-08 第六輪隨 `d2900cf4` 部署（第 8 項）。production 已依 owner 決定在 X 上開啟（第 7 項）；M1 驗收仍需要指定附 gate 證據的候選版本。
7. production 啟用：owner 於 2026-10-08 06:47Z 決定開啟，容量值沿用 staging。06:55Z 寫入 capacity policy；06:56Z 開始的開啟前備份做過隔離還原與遠端讀回；07:05Z 以同一份 dist 重新部署 production，唯一的變更是 flag；29 個公開檢查與 4 次新 DNS 解析的 health 讀回都通過；07:05Z 開始的開啟後備份也做過隔離還原與遠端讀回。production 的主力偏好 backfill 狀態同樣是 blocked（還有 305 位舊會員未對應，其中 156 位的舊主力公會沒有已核准的分類），所以三分類看板在 production 也隱藏。
8. 第六輪：P-D1、P-D2a、P-D2b 上線。owner 於 2026-10-08 選擇直接部署、到 live 再測，不跑 staging 驗收。兩個環境各自在 migration 前做了備份（隔離還原與遠端讀回），由 migrator 套用 128～130、重套 runtime grants 並通過唯讀驗證，接著立刻部署 `d2900cf4`。128 對 X 不相容（X 建立新的 manual-work 實例會失敗），所以 migration 與部署連續執行，回滾是關閉 flag 或修正後再部署。staging 08:22Z、production 08:24Z 部署；production 的 29 個公開檢查與 4 次 health 讀回都通過，兩邊部署後的備份也做過隔離還原與遠端讀回。P-D1／P-D2a／P-D2b 的 T-ID 案例（T-008、T-016、T-017、T-018、T-021、T-022、T-024、T-051、T-055、T-057、T-058）沒有執行。
9. 第七輪：P-B2b（#279，migration 131）與 P-D3a（#282，無 migration）上線。owner 於 2026-10-08 12:31Z 選擇照第六輪的方式直接發，不跑 staging 驗收。兩個環境各自在 migration 前做了備份（隔離還原與遠端讀回），由 migrator 套用 131、重套 runtime grants 並通過唯讀驗證，接著立刻部署 `3685d626`。131 對 `d2900cf4` 相容（新增表，並讓實例的 module_release_ref 不可變更，`d2900cf4` 不會改它），回滾是重新部署 `d2900cf4` 或關閉 flag，不需要退回 migration。staging 12:57Z、production 12:59Z 部署；production 的 29 個公開檢查與 4 次 health 讀回都通過，兩邊部署後的備份也做過隔離還原與遠端讀回。P-B2b 的 T-ID 案例（T-013、T-015、T-022、T-047）與 P-D3a 的畫面流程都沒有執行驗收。
10. 第八輪：#193 的社群整合（#284，migration 132、133：社群貼文的按讚、留言與純文字貼文，以及新貼圖）與 P-D3a 的目錄修正（#287，無 migration）上線。owner 於 2026-10-08 13:49Z 選擇在 #287 合併後照第七輪的方式直接發，不跑 staging 驗收。兩個環境各自在 migration 前做了備份（隔離還原與遠端讀回），由 migrator 套用 132、133，重套 runtime grants 並通過唯讀驗證，接著立刻部署 `e89cd0c8`。132、133 對 `3685d626` 只是新增或放寬，回滾是重新部署 `3685d626`，不需要退回 migration；但部署後新增的純文字貼文、按讚、留言與新貼圖，舊版只能部分顯示。staging 14:32Z、production 14:34Z 部署；production 的 33 個公開檢查與 4 次 health 讀回都通過，兩邊部署後的備份也做過隔離還原與遠端讀回。#284 與 #287 都沒有執行驗收。
11. 第九輪：公會首頁設定（D1，#297，無 migration）上線。沒有自訂首頁的電商公會與廣告攝影公會，改用各自的預設區塊順序與推薦應用，正式成員看到主要動作，見習成員看到提示，公會長可以編輯推薦。owner 於 2026-10-08 19:00Z 選擇在 #297 合併後照第八輪的方式直接發，不跑 staging 驗收。部署前兩邊的資料庫都唯讀確認仍在 133、沒有待套用的 migration。staging 19:19Z、production 19:20Z 部署；production 的 33 個公開檢查與 4 次 health 讀回都通過，部署後公開首頁讀回：電商公會是 使命→應用→我的工作→公告→技能書→社群任務→支援，廣告攝影公會是 使命→我的工作→技能書→公告→應用→社群任務→支援，兩邊都是 revision 2。兩邊部署後的備份也做過隔離還原與遠端讀回。回滾是重新部署 `e89cd0c8`，沒有資料變更。#297 沒有執行驗收；部署後另一個 session 用 staging 示範帳號實測：電商公會的正式成員看到主要動作「選品／營運待辦」，非成員看到加入提示，公會長存的推薦草稿重新進入後仍在、公開首頁不變；production 沒有登入實測。

本目錄其他文件是 2026-10-05 以 `567ae8d3` 為基線的規格紀錄，文中的「目前／現行」指當時。`traceability.json` 的 `planning_only` 與各需求的 `planned` 是當時的規劃追蹤，保留不改；60 項驗收在 `traceability.json` 裡維持 `not_run`；實際進度記在 `acceptance-progress.json`，不記在 `traceability.json`。SP-01–SP-04 與 SP-06 的狀態行保留原文，另加 2026-10-07 註記指回本節。

## 先讀

1. [SP-00 基線與追蹤](SP-00-baseline-traceability.md)：來源覆蓋、規則優先序、舊模型的明確取代範圍
2. [共同契約字典](contracts.md)、[資料責任](data-responsibility.md)、[實際檔案對照](repository-map.md)
3. [決策待辦](decision-log.md)：建議技術預設和仍需明訂的政策；不重新詢問已決定的產品方向
4. [64 項需求追蹤](traceability.json)、[60 項未執行驗收](acceptance.md)、[來源](sources.md)

| ID | 技術規格 | 主要介面相依 |
| --- | --- | --- |
| SP-00 | [基線與追蹤](SP-00-baseline-traceability.md) | 可立即開始 |
| SP-01 | [公會與偏好](SP-01-guild-preferences.md) | SP-00 |
| SP-02 | [Tenant 與授權](SP-02-tenant-authorization.md) | SP-00、既有 identity/command |
| SP-03 | [全公會啟動台](SP-03-all-guild-launchpad.md) | SP-01/02；具名 fixture 可並行 |
| SP-04 | [應用與實例](SP-04-applications-instances.md) | SP-02/05 |
| SP-05 | [模組互通](SP-05-module-interoperability.md) | SP-02、command/work |
| SP-06 | [資料隔離與恢復](SP-06-isolation-recovery.md) | SP-02/05、storage/recovery |
| SP-07 | [可攜套件](SP-07-portable-bundle.md) | SP-04/05/06 |
| SP-08 | [單模組遷移](SP-08-module-migration.md) | SP-05/06/07/09 |
| SP-09 | [外部連線安全](SP-09-external-connection-security.md) | SP-02/05、既有 key/grant |
| SP-10 | [領域與原作接入](SP-10-domain-upstream-integration.md) | SP-03/04/05；外移接 SP-08 |
| SP-11 | [AI、用量與維運](SP-11-ai-usage-operations.md) | SP-02/04/05/09、私人 AI 前置 |
| SP-12 | [整合與發佈](SP-12-integration-release.md) | 各包介面；測試設計立即並行 |

## 三條並行線與不可偷換的里程碑

- 共同基礎：tenant/member/permission → command/registry/ports → storage/portability/fencing
- 全公會：catalog/primary → shared shell/default Work+note+attachment+Result → 實際保存再開啟；不等電商完成
- 領域深化：唯一 commerce owner + inventory port、非商務 Work → 單庫存外移、混合聯動、故障恢復

M0 是本次規格/追蹤草案（#153 已合併）。M1 全公會可用公版已有部分實作合併並部署，staging 與 production 都已開啟；M1 尚未驗收，28 案中 2 案有 staging 通過證據（見[目前狀態](#目前狀態)）；M2 受控實例、M3 真正單模組可攜、M4 逐公會深化仍未完成、未驗收。UI fixture 不能代替 M1 的持久化與 ACL；整包 ERP 搬遷不能代替 M3。

## 已核對與未核對

- 中央 source：`567ae8d3849cfaa319b79c42d9c6c0a48d76f4a9`；ERP reference：`077a003634e5c11592b78acd969c6fe0814858a2`
- 已完整閱讀提供的 v1.0 主稿 1,251 行，22 決策、64 需求、60 待驗收、13 spec 包均保留穩定 ID
- 無法取得原對話 session 的逐則完整紀錄；原 ZIP 傳輸失敗，未讀到其 AGENT-START-HERE 或 SHA256SUMS。其後另取得使用者提供的兩份原始 JSON，已核對 requirements/acceptance 的全部文字、章節、D/R/T 關係及 27 個 S/W 來源與主稿一致。主稿第 24 章已含接手規則。此處 traceability.json 是保留原始關係並增補 repo 對照的衍生檔，**不是假造原 ZIP 檔案副本**
- 沒有複製私人對話、客戶資料、私人取檔連結、secret、原始 dump 或 ERP 程式碼。ERP 是有固定來源與 MIT 署名的架構參考
- 2026-10-05 撰寫時，最新部署/治理敘述引用既有 [foundation handoff](../unified-foundation/handoff-2026-10-04.md)，不是本輪 live 查驗；之後的部署狀態見[目前狀態](#目前狀態)。該 ledger 的 168 項要求及[原平台驗收](../acceptance-matrix.md)完整保留，不能被這 60 項取代

[文件驗證紀錄](verification.md)區分本次靜態檢查與未来產品案例；執行 `python3 docs/platform-plan/execution/guild-launchpad/validate-spec-pack.py` 只驗追蹤、文件結構，以及[目前狀態](#目前狀態)的 `glp-status` 行是否與現況快照一致，絕不將 T-ID 改為通過。這是手動指令；CI 只透過 contracts pytest 的 `docs/platform-plan/execution/tools/tests/test_guild_launchpad_status.py` 執行其中的 `glp-status` 檢查。
