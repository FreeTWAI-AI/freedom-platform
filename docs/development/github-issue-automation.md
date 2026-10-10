# GitHub Issue / PR 唯讀巡檢

`Report issue closure candidates` 每小時及手動執行皆只讀取本倉 open Issues 與 PR，輸出待人工核對的候選，不關閉 Issue、不發留言，也沒有可啟用寫入的參數。workflow 僅有 `contents: read`、`issues: read`、`pull-requests: read`；排程不等於結案授權。

候選只採已 merge 到目前預設分支的 PR，且 Issue 沒有在 merge 後更新。標題與內文分開解析，只接受獨立一行的 closing keyword 與同倉 `#<issue-number>`（可有項目符號、同倉名稱或句末標點）。否定敘述、引言、程式碼與跨行／跨欄位拼出的詞句不當作聲明；這個保守的提示解析器不宣稱完整模擬 GitHub Markdown 或 closing semantics。

報告明示 `mode: report-only`、`criteriaVerified: false`。PR 文字可在合併後修改，Issue 時間也是讀取時快照；兩者都不能證明原需求、測試、部署或真人驗收已完成。維護者需重新讀取原 Issue、最新討論及實際 merged coverage，保留未完成項，再依授權個別致謝與結案。此工具不能取代該核對，也不聲稱原子性的最新狀態。

手動使用 `node scripts/reconcile-issue-closures.mjs`（需 `GH_TOKEN`、`GITHUB_REPOSITORY`），同樣只有 GET。測試位於既有 governance discovery 範圍：`node --test packages/contribution-tools/test/reconcile-issue-closures.test.mjs`，亦由 `npm run test:governance` 與 pinned `ci.governance-unit` 的目錄規則選入；不需要新 suite 或更新 installed pin。
