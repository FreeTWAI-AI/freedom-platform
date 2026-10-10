# GitHub Issue / PR 巡檢與自動結案

`Reconcile completed issues` 每小時讀取本倉 open Issues 與所有狀態的 PR，並補做符合明確完成證據的 Issue 結案。GitHub 原生的 PR closing keywords 仍是正常主路徑；此巡檢只作為定期 reconciliation，不把單純提及 Issue、PR 關閉但未 merge，或合併到非預設分支視為完成。

只有已 merge 到預設分支的 PR 標題／內文含 GitHub closing keyword（`close`、`fix`、`resolve` 的標準變體）及同倉 `#<issue-number>`，且 Issue 在 merge 後沒有更新時，巡檢才會以 `completed` 關閉它。merge 後有新留言或重新開啟等活動會更新 Issue 時間，並保守跳過，避免定期工作流把重新開啟的 Issue 關回去。

可在 Actions 手動執行 workflow；預設為 dry-run，只列候選、不寫入。定時執行使用最小 `issues: write` 與 `pull-requests: read` 權限。腳本和測試可分別用 `node scripts/reconcile-issue-closures.mjs`（需提供 `GH_TOKEN`、`GITHUB_REPOSITORY`）及 `node --test scripts/reconcile-issue-closures.test.mjs` 執行。
