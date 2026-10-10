# GitHub Issue / PR 巡檢與自動結案

`Reconcile completed issues` 每小時讀取本倉 open Issues、所有狀態的 PR，以及 `issue-closure-evidence` 分支中的 merge-time 證據。GitHub 原生 PR closing keywords 仍是正常主路徑；此巡檢只作為定期 reconciliation，不把單純提及 Issue、PR 關閉但未 merge，或合併到非預設分支視為完成。

`Capture issue closure evidence` 在 PR merge 到預設分支時，以 `pull_request_target` 的 merge event 快照擷取標題／內文中的 closing keywords。它只保存 PR 編號、merge commit、merge 時間、同倉 Issue 編號及來源文字雜湊；不執行或 checkout PR head，也不保存原始內文。證據寫入獨立分支，以非 force 的 fast-forward commit 追加；既有 PR 記錄不會被覆寫。定期巡檢完全不採信目前可編輯的 PR 標題／內文，且會比對 evidence 的 merge commit、時間及預設分支與 GitHub PR metadata。

只有具備 merge-time 證據、已 merge 到預設分支的 PR，其同倉 closing keyword 指向的 Issue 才可能由巡檢以 `completed` 關閉；Issue 若在 merge 後更新則跳過。此機制只追蹤 evidence workflow 啟用後 merge 的 PR；不會從舊 PR 的現行內文推測歷史證據。GitHub Actions 的 evidence capture workflow 使用 `contents: write`，巡檢 workflow 維持 `contents: read`、`issues: write` 與 `pull-requests: read`。

可在 Actions 手動執行巡檢 workflow；預設為 dry-run，只列候選、不寫入。腳本和測試可分別用 `node scripts/reconcile-issue-closures.mjs`（需提供 `GH_TOKEN`、`GITHUB_REPOSITORY`）及 `node --test scripts/reconcile-issue-closures.test.mjs scripts/capture-issue-closure-evidence.test.mjs` 執行。
