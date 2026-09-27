# 頁面工具與世界聊天

每個會員工作區、登入、必要定位與管理入口都顯示想法、說明、編修三個頁面工具。頁面識別碼與用途由 `modules/development/pages.ts` 管理；新增頁面時需同時加入該表，避免 Issue 被歸到錯誤頁面。手機聊天在站內抽屜展開；管理入口有會員登入時可讀取與發送世界聊天，單獨的管理員驗證不會取得會員聊天權限。

## 想法與 GitHub

- 公開 `GET /api/v1/pages/github-activity?page=<id>` 讀取平台 Repo 最近 100 筆 Issue／PR，分辨兩者，僅列出該頁仍開啟的 Issue。伺服器快取 90 秒；`refresh=1` 最快每 30 秒讀一次。達到 100 筆時畫面明示清單可能不完整，並提供完整 GitHub 入口。
- 頁面標記為 `page:<id>`，Issue 正文保留 `<!-- freedom-page:<id> -->`。既有 GitHub label `page:<id>` 也可辨識。GitHub 網站路徑會用使用者自己的帳號開啟填好的 Issue 表單；只有 GitHub 真的建立後，世界聊天才顯示該事件。
- 站內發布是 `POST /api/v1/me/github/pages/:id/issues`，只能用會員本人連結的 GitHub user access token，目標 Repo 固定為 `FreeTWAI-AI/freedom-platform`。CSRF、定位完成、輸入長度與操作鍵由 API 驗證；提交表保存操作鍵、請求摘要與確認結果，不保存正文或 token。GitHub 回應不明時保存 `pending` 並拒絕自動重送，避免重複發文。
- 既有 GitHub App 若只有 Starring／Metadata 權限，組織擁有者還需在 GitHub 將 **Issues: write** 加入 App、核准新權限並確認 App 可存取平台 Repo。此權限未備妥時，站內發布會回傳權限錯誤，使用者仍可用 GitHub 網站表單或複製給 Agent 的指令。新增 App 的 manifest 已要求此權限。
- 世界聊天中的 GitHub 公告由 GitHub 讀取結果產生，按 Issue／PR 編號去重；沒有從點擊表單或草稿推定發布成功。此摘要受最近 100 筆 API 清單和快取更新間隔限制。

## 說明與編修

說明使用 `modules/development/pages.ts` 的用途、第一個可做的事與既有 `/development/<id>` 指引。Agent 指令要求先讀 Repo、核對目前頁面程式、列出新手常見問題；編修指令要求核對現有 Issue／PR、Fork、建立分支、執行測試、以本人 GitHub 權限送 PR。指令本身不授予帳號權限。

驗證：`npm run typecheck`、`npm run build`、`npx tsx --test tests/runtime/page-github.test.ts tests/runtime/github-social-routes.test.ts tests/runtime/github-app-setup.test.ts`、`npx playwright test tests/e2e/page-tools.spec.ts tests/e2e/game-console.spec.ts`。
