# GitHub Issue / PR 結案候選巡檢

`Report issue closure candidates` 每小時唯讀查詢本倉 open Issues 與所有狀態的 PR，產出待核對清單。GitHub 原生的 PR closing keywords 仍是正常主路徑；此巡檢不關閉、留言或修改任何 Issue／PR。

已 merge 到預設分支的 PR 標題／內文含 GitHub closing keyword（`close`、`fix`、`resolve` 的標準變體）及同倉 `#<issue-number>`，且 Issue 在 merge 後沒有更新時，才列為候選。單純提及、程式碼範例、未 merge 或非預設分支的 PR 不列入；merge 後有新留言或重新開啟等 Issue 活動也會跳過。

**候選不等於完成證據。** PR 標題／內文在合併後仍可編輯，後補的關鍵字也可能被列入；掃描後 Issue 也可能出現新留言或重新開啟。每列均標示 `requiresReview: true`，必須另外核對原 Issue 驗收條件、實際合併內容、必要部署／啟用證據及最新討論，才能由有權者結案。沒有候選不代表所有 Issue 尚未完成。

排程與 Actions 手動執行都固定為 report-only，沒有切換成寫入的選項。workflow 只有 `contents: read`、`issues: read` 與 `pull-requests: read`，checkout 不保存憑證。結果以 JSON 輸出 `mode`、掃描數量及 `candidates`，不會把候選標成 `closed`。

腳本和測試可分別用 `node scripts/reconcile-issue-closures.mjs`（需提供 `GH_TOKEN`、`GITHUB_REPOSITORY`）及 `node --test scripts/reconcile-issue-closures.test.mjs` 執行。供本機使用的 token 也應只具讀取權；舊 `DRY_RUN` 變數不會啟用任何寫入。
