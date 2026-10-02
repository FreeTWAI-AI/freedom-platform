# 共同基礎：本機交付紀錄

查核日期：2026-10-02。本紀錄區分原始產品要求、本機實作、合成測試及尚缺的真實部署證據；不修改原計畫的歷史內容，也不把組件測試轉寫成完整產品 PASS。

## 本機提交與範圍

| 批次 | 本機 commit／位置 | 交付內容 |
| --- | --- | --- |
| 規格 | `e939e2c` | 三份來源快照、七份分工規格、168 項來源驗收及 guardrail 對照 |
| GOV-A | `2c8da89` | ReleaseSet／pin／proof／trust schemas、本機 verifier、preview v1 相容與中央工具 export |
| GOV-B | `5b98bca` | prepare/context/verify、baseline/candidate 影響聯集、module descriptors、版本及 worktree context、三個合成 consumer |
| CORE-0 | `2a40d8f` | neutral command orchestration、相容 member adapter、legacy transaction/digest 抽取、16 項真實 PostgreSQL 回歸 |
| CORE-1 | `5c9afcd` | common identity refs、person/community/personal 映射、受約束 migration、會員 scope context、可重跑分批回填及 27 項新增 runtime 回歸 |
| GOV-C 本機邊界 | `0963bee` | host-owned Git candidate／policy／observation binding、baseline fallback 與 vendor exact-byte 驗證；尚非可信 CI |
| ASSET-A I/O 首段 | `ded9c98`、修正 `5e23d91` | bounded bytes/profile、immutable object port／fake store、digest read-back 與安全錯誤；尚無 DB lifecycle／R2 接線 |
| WORK-A | `c3eae47` | migration 077、私人 owner/scope FK、社群投影與 mutation 隔離、本人私人 list/detail、18 項新增 runtime 回歸 |

目前整合分支為 `feat/foundation-parallel-20261002`，worktree 同名，包含上表完整提交鏈；CORE-1 與先前批次另保留在各自 worktree。全部只在 `~/tmp-scratch/fp_work/` 工作，未 push、建立 PR、merge main 或部署。主 checkout 及其 staged 刪除未更動。

## GOV-A/B 與 CORE-0 證據

- GOV-A 初版 88 項 Node tests；GOV-B 增量後 106 項，沒有跳過。包括篡改 vendor/lock/簽章、錯誤 purpose/key、缺少可信來源、空／跳過／偽造測試輸出、刪除規則、跨 worktree 與三個獨立合成 consumer。
- 既有契約測試 659 passed、4 skipped；跳過是原有 five-clock 案例不足三個 schema paths。不是新產品驗收通過。
- Preview build 仍為 32 operations／9 artifacts；重產後 `contracts/preview/v1` 與 `packages/sdk` 無差異。
- 交易核心最初 14 項測試在抽取前後均通過；抽取後連同 flows、avatar、access-session 為 56 passed。之後補上 journal／outbox insert 失敗回滾反例。
- 最終完整 `npm test`：898 passed、0 failed、0 skipped，包含上述 16 項 command-core 測試；約 193 秒。`npm run test:worker`：20 passed、0 failed、0 skipped。
- 型別檢查、前端 build、platform／admin-sync／maintainer 的各環境 Worker dry-run 均通過。Build 有既有大型 chunk 警告，未因此改動 UI 或拆包。
- Skill client suite 10 passed。Governance suite 在 CORE-0 worktree 再跑仍為 106 passed。
- Inventory：1,121 個檔案 hash、604 個本機文件／目錄連結，0 failures；`git diff --check` 通過。

失敗及重跑：第一次完整 runtime 執行的測試容器因 512 MB tmpfs 被 WAL 填滿而中斷，後續連線失敗；這次不算通過。重建為 2 GB 上限及較小 WAL/checkpoint 設定後，从頭執行取得 898 passed。Worker 初跑未指定測試連線，之後另遇缺少 admin-sync／maintainer dry-run bundle；補齊隔離連線及全部 bundle 後，从頭執行取得 20 passed。未修改產品程式來略過這些失敗。

資料庫證據來自本輪新建的 PostgreSQL 18.6 容器，image digest 與 repo CI 固定版本相同。容器使用 `network=none`、無 published port、tmpfs 資料及專屬 Unix socket。Runtime 測試取得新建 `fp_foundation` 連線，並各自建立／清理 `fp_*` schema。Worker 的 Hyperdrive 測試另用暫時的 localhost 隨機 port proxy 接到同一 Unix socket，各自建立／清理 `fp_*` 資料庫，測試結束即關閉 proxy。未讀取正式環境憑證或使用 Ted 的資料。

收尾已確認測試 schema／子資料庫全部清理，再停止並移除本輪容器及 socket 目錄；只刪除可由測試重建的合成資料，沒有保留長駐資料庫服務。

## CORE-1 證據與邊界

- `contracts/common/v1/identity.ts` 同源產生 Zod validators、TS types 和兩份 JSON Schema。`check:common-contracts` 驗 exact bytes；runtime 測試另以 Python Draft 2020-12 validator 驗正反例。service/site 只保留 wire kind，DB 和 runtime 仍拒絕啟用。尚未加入公開 ReleaseSet、Rust vectors 或真實 consumer。
- 暫用 migration 076 新增 `principals`／`resource_scopes`，以 FK、CHECK、UNIQUE 及 immutable triggers 限制映射；一般 DML 無法改綁或刪除後重建，status 可明確停用。community 不虛構 owner。migration 不自動回填、不改任何舊表。`environments.json` 的 last 同步為 76、known_gaps 保持 `[22]`；合併前仍需重新確認最小可用編號。
- `withMemberScope` 共用舊會員的 user/session 驗證，新增 principal/scope 當前檢查，之後仍強制 domain authorize。同一交易及鎖順序見 [package README](../../../../packages/resource-scopes/README.md)。它不是 command/receipt/Grant，不能取代 idempotency、version、journal/outbox；舊 route 未接入此 helper。
- `backfillLegacyScopeBatch` 每批最多 500 筆，community/user 分階段交易、`SKIP LOCKED`、timeout、失敗整批 rollback。包含 inactive users，但不產生 session 或權限、不重啟 disabled rows；並行 first-use、並行 backfill、失敗重跑均有實際 PostgreSQL 測試。未建立正式 backfill CLI 或排程。
- 新增 27 項 runtime 測試，含 075 升級前後所有既有表 hash 與原 ledger 不變、舊 receipt replay、真實 row-lock 撤銷競態、非 superuser migrator 及 DML-only runtime。這些是合成會員／測試角色，不是正式 grants-check 或完整私人工作 ACL。
- 完整 `npm test`：925 passed、0 failed、0 skipped，約 193 秒；`test:worker`：20 passed、0 failed、0 skipped。
- 型別檢查、前端 build、三類 Worker 的所有環境 dry-run、common schema check 通過。Preview 重產仍為 32 operations／9 artifacts，preview/SDK 沒有 diff。
- 治理 106 passed、skill client 10 passed、部署前檢查 37 passed，均無 skip。既有契約 659 passed、4 個原有 clock cases skipped。本批沒有執行跨 repo 真實 consumer integration 或瀏覽器 E2E。
- 本批發現 CORE-0 的 deploy preflight 靜態測試還在 `packages/db/index.ts` 找 digest 函式本體，先重現失敗，再改驗 re-export 與 `legacy-digest.ts` 的原始 encoder；未改 digest 邏輯。修正後 37 項部署前測試全數通過。
- 以真正 `origin/main` 執行 `prepare`／`verify`：新 descriptor 與參照有效，governance tests 有執行；總結果仍是 exit 2 `unavailable`。原因包含 baseline 缺治理、未登錄 surface、runtime suite adapter 尚缺。沒有改 base 或把手動 runtime 結果當可信檢查。
- Inventory：1,132 個檔案 hash、619 個本機文件／目錄連結，0 failures；`git diff --check` 通過。

本批另建一個 PostgreSQL 18.6 disposable 容器，沿用上述 image digest、network none、2 GB tmpfs、專用 Unix socket／短期 Worker localhost proxy。全部測試只寫合成 `fp_*` schema/db；結束後查到測試 schema 和 role 都是 0、只剩容器本身的 `fp_foundation`，再清理容器/socket，沒有正式資料或長駐測試服務。遠端 main 收尾查核仍為 `3de70ccbd24362a7925508fb42d36aaa256a0806`。

## 平行批次：GOV-C 邊界、ASSET I/O 與 WORK-A

依 Ted 本輪授權，三隻 GPT-6 Astra 在獨立 worktree 分別實作治理、Asset I/O、私人 Work；另以 Grok CLI 的 `grok-4.7` 執行兩路反例審查，以 agy CLI 的 `claude-opus-4-6-thinking` 執行兩路唯讀 schema/治理審查。四路外援都完成，review worktree 無程式變更。主 agent 負責契約交集、整合與全套驗證，再由 Astra 互審實際差異。CLI review 是意見來源，不能計為測試通過或 Ted 的操作批准。

### 實作與交叉審查

- GOV-C 新增 host-only `verifyHostCandidate`，未放進本機 CLI/consumer exports。host 供應固定 verifier、policy 與 bare Git objects，驗真正 base/head/candidate/tree、來源 pins、實際 vendor bytes 與完整 suite/workflow/harness binding，不執行 candidate 程式。審查發現新 descriptor 可覆蓋原本未知路徑後，補上 baseline ownership fallback 反例。完整可信 observation transport、runner isolation、proof/publisher/source approval 接線及 GitHub check/rules 仍缺；report 一律 local、merge/execution 未授權。
- ASSET-A 首段只交付 effect-phase I/O，不建 DB migration 或啟用路由。固定 scope/asset/representation key、先驗 persistence policy、實際 bytes 上限、嚴格 UTF-8/頭像 profile、immutable PUT 後完整 GET + digest；PUT 結果不明時只能核對 bytes 恢復。store 成功不等於 ready、權限或業務 receipt；intent/fence/finalize/GC、R2/Images 與 read ACL 留待後續。
- 跨 agent 審查另重現兩個原 20 tests 未涵蓋的問題：upstream `AssetStorageError` 原樣重拋可能帶出私密診斷；`Uint8Array` 在型別／長度驗證前複製可能接受 array/numeric 或先分配超限記憶體。修正後新增四例，24/24 通過；原審查者再獨立重跑原漏洞案例，確認固定錯誤不含原訊息、非法 bytes 在 allocation/I/O 前拒絕，合法 Buffer 仍正常。
- WORK-A 的 077 保留舊 Work 事實，私人 owner/user/personal scope 用複合 FK 綁定，模式與身分不能改綁或 DELETE 重建。私人只允許 draft，不填協作條款/期限；Claim/Review/Contribution/Benefit 的生成 discriminator + FK 防止私人資料變成社群事實。site/service 仍拒絕。
- 既有 Work、dashboard、task-board、contribution、benefit 與 command replay 均先限社群模式。新 `/api/v1/me/private-work` list/search/count/page/detail 只認當前會員、person principal 與 personal scope；管理員/公會長不例外。HEAD/Range/條件標頭不能省略授權，回覆 private/no-store。私人寫入、Result、Asset/share/export/run 路由未開放；通知/outbox 無私人 producer，新增 producer 前仍須重驗整張讀取矩陣。
- WORK-A 18 項含同/跨社群枚舉、admin/officer、過期/停用、複合 FK、假協作事實、replay、bigint 精度與真正 `pg_blocking_pids` 鎖等待 barrier。075 升級 fixture 補齊 Work→Claim→Submission→Decision→Contribution/Benefit，固定舊欄位 snapshot 避免新增 metadata 造成假失敗。既有 E2E 只調整 fixture cleanup，改由自有 schema teardown 清理 immutable Work；沒有 UI 變更。
- 失敗及重跑：WORK 定向測試初次 65/66，原因是新增合成 admin fixture 使用不存在的 `admin` enum；改為既有 `super_admin` 後完整定向 suite 69/69。後續強化鎖等待 barrier，再跑 WORK-A 18/18。未刪測試、弱化 SQL constraint 或把模型建議直接當通過證據。

### 整合後實測

| 檢查 | 結果 | 邊界 |
| --- | --- | --- |
| `npm test` | 967 passed，0 failed/skipped；約 204 秒 | 隔離 PostgreSQL，含新 24 ASSET／18 WORK cases |
| `npm run test:worker` | 20 passed，0 failed/skipped | localhost proxy 接合成資料庫；非真實 Cloudflare |
| `npm run test:governance` | 119 passed，0 skipped | 含 13 個新 host-boundary cases；非 GitHub 強制 |
| `npm run test:contracts` | 659 passed，4 個原有 clock cases skipped | 不改原有 skip 條件 |
| Skill client／deploy preflight | 10／37 passed，0 skipped | 既有回歸及靜態發布前檢查 |
| `typed-line-breaks.spec.ts` | Chromium 1 passed | build 後執行受影響 cleanup 的案例，非全套 E2E；GitHub 使用 fixtures |
| typecheck／build／common schemas | 全通過 | build 保留既有 large-chunk 警告 |
| 三類 Worker dry-run | 各環境全通過 | platform、admin-sync、maintainer；沒有上傳部署 |
| preview build | 32 operations／9 artifacts | preview 與 SDK 重產無 diff |
| inventory／diff-check | 1,144 hashes、637 本機連結，0 failures；diff-check 通過 | 不驗外部連結或產品行為 |
| 對真正 `origin/main` prepare／verify | exit 2，unavailable | descriptor/refs、preview、119 governance tests 通過；缺 baseline governance、surface audit 及 runtime suite adapter |

本批使用新的 PostgreSQL 18.6 container（與 repo CI 同 image digest）、network none、無 published port、2 GiB tmpfs、專用 Unix socket。Runtime/E2E 使用新 `fp_*` schema，Worker 使用新 `fp_*` database；不繼承 provider/DB secrets。結束查到 `fp_*` schema/role 都為 0，資料庫僅有本輪 `fp_foundation` 及預設 postgres/template，隨後移除容器和空 socket 目錄。只刪可重建的合成資料，未讀寫 `freedom_local.public`。

migration 076/077 仍是暫用號；整合 manifest last=77、known_gaps=`[22]`，遠端 main 收尾再查仍為 `3de70ccbd24362a7925508fb42d36aaa256a0806`。077 尚無 down migration 或 release-tool rollback floor；舊 binary 的 row spread 可能額外回 metadata，不能宣稱新舊混跑 byte-exact。私人寫入保持關閉，直到回退、命令與新增讀取面驗收齊備。

## 尚未交付

- Scoped command composition、新 receipt namespace、execution/service current-state validators，以及有真實 backing record 的 service/site schema。
- Asset DB intent/fence/finalize/GC、真實 R2 頭像流程、新增私人寫入/Result/share 的完整讀取矩陣、RunAttempt／模型 broker／私人 AI 草稿及瀏覽器 execution guard。
- 真實 consumer 升級、TS/Rust 共用樣本、Windows/macOS、packaged clients、cloud 備份恢復及 staging/prod 演練。
- 已批准的 publisher/trust profile、可信 CI publisher／required workflow、GitHub 強制審查與不可繞過的發布限制。

本機 `verify` 面對尚未治理的 main 或未實作的 runtime adapter，明確回 `unavailable`，不是綠燈。手動跑過 runtime tests 不會自動偽造 trusted check。原始 168 項產品驗收仍保留 `not_run`，須逐項取得完整證據再更新。

## 下一批

銜接 ASSET-A 的 durable intent/fence/finalize/GC 與 scoped command/receipt，再接頭像 bridge 及私人 Result；同時補治理的 runtime adapter、實際 surface audit 與 host observation 接線。private mutation 仍須目前權限、expected version、撤銷重驗及無外部 I/O 的短交易。service 分支在 backing schema 和 validator 齊備前拒絕啟用。migration 076/077 尚未合併或發布，不永久預留編號。完整新增 private 讀取矩陣及 rollback floor 齊備前不開啟私人寫入。

推送、PR、合併、GitHub 規則、信任來源／金鑰、正式資料盤點或部署另依 Ted 的操作授權處理；Discord 全文仍須逐則核准。
