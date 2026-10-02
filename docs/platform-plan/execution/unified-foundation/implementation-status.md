# 共同基礎：本機交付紀錄

查核日期：2026-10-02。本紀錄區分原始產品要求、本機實作、合成測試及尚缺的真實部署證據；不修改原計畫的歷史內容，也不把組件測試轉寫成完整產品 PASS。

## 本機提交與範圍

| 批次 | 本機 commit／位置 | 交付內容 |
| --- | --- | --- |
| 規格 | `e939e2c` | 三份來源快照、七份分工規格、168 項來源驗收及 guardrail 對照 |
| GOV-A | `2c8da89` | ReleaseSet／pin／proof／trust schemas、本機 verifier、preview v1 相容與中央工具 export |
| GOV-B | `5b98bca` | prepare/context/verify、baseline/candidate 影響聯集、module descriptors、版本及 worktree context、三個合成 consumer |
| CORE-0 | 本文件所在的後續提交 | neutral command orchestration、相容 member adapter、legacy transaction/digest 抽取、16 項真實 PostgreSQL 回歸 |

工作分支為 `feat/foundation-command-core-20261002`，包含前面三個提交；前一批保留在 `feat/foundation-governance-20261002`。全部只在 `~/tmp-scratch/fp_work/` 的 worktree，未 push、建立 PR、merge 或部署。主 checkout 及其 staged 刪除未更動。

## 已取得的證據

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

## 尚未交付

- Principal/ResourceScope 映射與相應 CHECK/FK、execution/service current-state validators、新 receipt namespace。
- 新 Asset/R2 頭像流程、private Work 完整讀取矩陣、RunAttempt／模型 broker／私人 AI 草稿及瀏覽器 execution guard。
- 真實 consumer 升級、TS/Rust 共用樣本、Windows/macOS、packaged clients、cloud 備份恢復及 staging/prod 演練。
- 已批准的 publisher/trust profile、可信 CI publisher／required workflow、GitHub 強制審查與不可繞過的發布限制。

本機 `verify` 面對尚未治理的 main 或未實作的 runtime adapter，明確回 `unavailable`，不是綠燈。手動跑過 runtime tests 不會自動偽造 trusted check。原始 168 項產品驗收仍保留 `not_run`，須逐項取得完整證據再更新。

## 下一批

先審查 CORE-0 的相容性，再實作有真實 backing records 的 person/community/personal 映射與受約束 backfill；service 分支在 backing schema 和 validator 齊備前拒絕啟用。migration 編號於實際合併時重新解析，本批未配置 076。接著完成 private Work 讀取 ACL，才能開啟新 private 寫入。

推送、PR、合併、GitHub 規則、信任來源／金鑰、正式資料盤點或部署另依 Ted 的操作授權處理；Discord 全文仍須逐則核准。
