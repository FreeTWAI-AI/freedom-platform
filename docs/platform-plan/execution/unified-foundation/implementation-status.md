# 共同基礎：本機交付紀錄

查核日期：2026-10-02。本紀錄區分原始產品要求、本機實作、合成測試及尚缺的真實部署證據；不修改原計畫的歷史內容，也不把組件測試轉寫成完整產品 PASS。

## 本機提交與範圍

| 批次 | 本機 commit／位置 | 交付內容 |
| --- | --- | --- |
| 規格 | `e939e2c` | 三份來源快照、七份分工規格、168 項來源驗收及 guardrail 對照 |
| GOV-A | `2c8da89` | ReleaseSet／pin／proof／trust schemas、本機 verifier、preview v1 相容與中央工具 export |
| GOV-B | `5b98bca` | prepare/context/verify、baseline/candidate 影響聯集、module descriptors、版本及 worktree context、三個合成 consumer |
| CORE-0 | `2a40d8f` | neutral command orchestration、相容 member adapter、legacy transaction/digest 抽取、16 項真實 PostgreSQL 回歸 |
| CORE-1 | 本文件所在的後續提交 | common identity refs、person/community/personal 映射、受約束 migration、會員 scope context、可重跑分批回填及 27 項新增 runtime 回歸 |

目前工作分支為 `feat/foundation-principal-scope-20261002`，包含前面四個提交；前兩批保留在 `feat/foundation-command-core-20261002` 與 `feat/foundation-governance-20261002`。全部只在 `~/tmp-scratch/fp_work/` 的 worktree，未 push、建立 PR、merge 或部署。主 checkout 及其 staged 刪除未更動。

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

## 尚未交付

- Scoped command composition、新 receipt namespace、execution/service current-state validators，以及有真實 backing record 的 service/site schema。
- 新 Asset/R2 頭像流程、private Work 完整讀取矩陣、RunAttempt／模型 broker／私人 AI 草稿及瀏覽器 execution guard。
- 真實 consumer 升級、TS/Rust 共用樣本、Windows/macOS、packaged clients、cloud 備份恢復及 staging/prod 演練。
- 已批准的 publisher/trust profile、可信 CI publisher／required workflow、GitHub 強制審查與不可繞過的發布限制。

本機 `verify` 面對尚未治理的 main 或未實作的 runtime adapter，明確回 `unavailable`，不是綠燈。手動跑過 runtime tests 不會自動偽造 trusted check。原始 168 項產品驗收仍保留 `not_run`，須逐項取得完整證據再更新。

## 下一批

先審查 CORE-0/1 的相容性、映射 lifecycle 與鎖順序，再銜接 Asset/Work 的 composite scope FK 及 private Work 讀取 ACL；新 private mutation 仍須適用的 command/receipt 保護。service 分支在 backing schema 和 validator 齊備前拒絕啟用。migration 076 尚未合併或發布，不永久預留編號。完整 private 讀取矩陣通過前不開啟新 private 寫入。

推送、PR、合併、GitHub 規則、信任來源／金鑰、正式資料盤點或部署另依 Ted 的操作授權處理；Discord 全文仍須逐則核准。
