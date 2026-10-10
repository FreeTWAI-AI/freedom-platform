# GitHub Issue / PR 巡檢與自動結案

`Reconcile completed issues` 每小時讀取本倉 open Issues、所有狀態的 PR，以及 `issue-closure-evidence` 分支中的 merge-time 證據。GitHub 原生 PR closing keywords 仍是正常主路徑；此巡檢只作為定期 reconciliation，不把單純提及 Issue、PR 關閉但未 merge，或合併到非預設分支視為完成。

`Capture issue closure evidence` 在 PR merge 到預設分支時，以 `pull_request_target` 的 merge event 快照擷取標題或內文各自包含的 closing keywords，不跨欄位拼接匹配。它只保存 PR 編號、merge commit、merge 時間、同倉 Issue 編號及來源文字雜湊；不執行或 checkout PR head，也不保存原始內文。證據寫入獨立分支，以非 force 的 fast-forward commit 追加；既有 PR 記錄不會被覆寫。年度索引追加後若超過 1 MB，會在寫入前拒絕，避免留下無法讀取的索引。

只有具備 merge-time 證據、已 merge 到預設分支的 PR，其同倉 closing keyword 指向的 Issue 才可能由巡檢以 `completed` 關閉；Issue 若在 merge 時間或之後更新則跳過。巡檢在每次 PATCH 前重新讀取該 Issue，重驗開啟狀態及時間條件。[GitHub REST API 的更新最佳實務](https://docs.github.com/rest/guides/best-practices-for-using-the-rest-api)指出，除非 endpoint 另有文件說明，unsafe methods（如 PATCH）不支援 conditional requests；[更新 Issue endpoint](https://docs.github.com/rest/issues/issues?apiVersion=2022-11-28)未定義 compare-and-set 條件。因此最後一次讀取與 PATCH 之間仍有極短的並行更新競態；若不接受此限制，就不能啟用自動寫入，應改採唯讀人工確認流程。此機制只追蹤 evidence workflow 啟用後 merge 的 PR；不會從舊 PR 的現行內文推測歷史證據。GitHub Actions 的 evidence capture workflow 使用 `contents: write`，巡檢 workflow 維持 `contents: read`、`issues: write` 與 `pull-requests: read`。

可在 Actions 手動執行巡檢 workflow；預設為 dry-run，只列候選、不寫入。腳本和測試可分別用 `node scripts/reconcile-issue-closures.mjs`（需提供 `GH_TOKEN`、`GITHUB_REPOSITORY`）及 `node --test packages/contribution-tools/test/issue-closure-reconciler.test.mjs packages/contribution-tools/test/issue-closure-evidence.test.mjs` 執行。
