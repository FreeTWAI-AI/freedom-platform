# 頁面工具與世界聊天

每個會員工作區、登入、必要定位與管理入口都顯示想法、說明、編修三個頁面工具。頁面識別碼與用途由 `modules/development/pages.ts` 管理；新增頁面時需同時加入該表，避免 Issue 被歸到錯誤頁面。手機聊天在站內抽屜展開；管理入口有會員登入時可讀取與發送世界聊天，單獨的管理員驗證不會取得會員聊天權限。

## 想法與 GitHub

- 公開 `GET /api/v1/pages/github-activity?page=<id>` 從 PostgreSQL 的 `github_items` 讀取 `FreeTWAI-AI/freedom-platform`，頁面請求不再呼叫 GitHub。沒有 `page` 時回最近 100 筆 Issue／PR；有 `page` 時只列該頁仍開啟、`page_ids` 含該頁的 Issue。`checked_at` 是這個儲存庫的 `last_synced_at`。超過 30 分鐘，或還沒有同步時間，標成 `stale`。只有尚未同步（沒有資料列、`pending`，或沒有 `last_synced_at`）才是 `partial`。`refresh=1` 仍接受，只是再讀一次資料庫。超過 100 筆時 `truncated`。Migration 057 會清掉 issue 同步游標，部署後大約一小時內，頁面活動可能是空的，直到每 10 分鐘的 cron 重新讀完。
- 頁面標記為 `page:<id>`，Issue 正文保留 `<!-- freedom-page:<id> -->`。既有 GitHub label `page:<id>` 也可辨識。GitHub 網站路徑會用使用者自己的帳號開啟填好的 Issue 表單；只有 GitHub 真的建立後，世界聊天才顯示該事件。
- 站內發布是 `POST /api/v1/me/github/pages/:id/issues`，只能用會員本人連結的 GitHub user access token，目標 Repo 固定為 `FreeTWAI-AI/freedom-platform`。CSRF、定位完成、輸入長度與操作鍵由 API 驗證；提交表保存操作鍵、請求摘要與確認結果，不保存正文或 token。GitHub 回應不明時保存 `pending` 並拒絕自動重送，避免重複發文。
- 發布紀錄也保存使用者提交的標題。GitHub 公開清單尚未同步到新 Issue 時，頁面用此標題補齊；舊紀錄會嘗試向 GitHub 補回真實標題，暫時無法讀取時顯示 Issue 編號。
- 每則開啟的頁面 Issue 可在站內展開認領回覆。`POST /api/v1/me/github/pages/:id/issues/:number/design-claim` 先確認目標是該頁仍開啟的 GitHub Issue，再以會員本人的 GitHub token 送出留言並附 `<!-- freedom-design-claim -->`。提交紀錄只保存操作鍵、摘要、Issue／留言編號與確認狀態；不保存留言正文或 token。回應不明時停止重送，會員可到 GitHub 核對；沒有站內寫入權時可複製該 Issue 的 Agent 送出指令。
- 既有 GitHub App 若只有 Starring／Metadata 權限，組織擁有者還需在 GitHub 將 **Issues: write** 加入 App、核准新權限並確認 App 可存取平台 Repo。此權限未備妥時，站內發布會回傳權限錯誤，使用者仍可用 GitHub 網站表單或複製給 Agent 的指令。新增 App 的 manifest 已要求此權限。
- 世界聊天中的 GitHub 公告來自 cron 寫入的公開事件；控制台仍輪詢 `GET /api/v1/pages/github-events`，這次讀取不再呼叫 GitHub。事件按 Issue／PR 編號去重；沒有從點擊表單或草稿推定發布成功。清單最多 100 筆，超過時 `truncated`。

## 說明與編修

說明使用 `modules/development/pages.ts` 的用途、第一個可做的事與既有 `/development/<id>` 指引。Agent 指令要求先讀 Repo、核對目前頁面程式、列出新手常見問題；編修指令要求核對現有 Issue／PR、Fork、建立分支、執行測試、以本人 GitHub 權限送 PR。指令本身不授予帳號權限。

「參與編修」的 Agent 指令與手動步驟都要求 PR 說明同時寫下 `page:<id>`，並保留 `<!-- freedom-page:<id> -->`。從 Fork 送出的 PR 不能自加 GitHub label；頁面歸屬只讀 label 與這個 HTML 標記。

驗證：`npm run typecheck`、`npm run build`、`npx tsx --test tests/runtime/page-github.test.ts tests/runtime/github-social-routes.test.ts tests/runtime/github-app-setup.test.ts`、`npx playwright test tests/e2e/page-tools.spec.ts tests/e2e/game-console.spec.ts`。
