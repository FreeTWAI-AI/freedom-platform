# 從網站的一頁到正確的 Repo

網站每頁底部都有預設收起的「參與這一頁的開發」。一般會員先完成原有操作；想貢獻的人再打開，選擇網站說明、給 Agent 的文字版或 Fork。技能書先在站內介紹用途和第一個成果，再連到對應工具的原始碼。

## 公開入口

- [開發導覽](https://freetwai.com/development)：19 個頁面與 22 本技能書的 HTML 指引，不需要 JavaScript。
- [Agent 文字索引](https://freetwai.com/llms.txt)：各頁與技能書 Markdown 的穩定入口。
- [完整 JSON 地圖](https://freetwai.com/api/v1/development-map)：頁面目的、原始碼路徑、測試指令、28 個 Repo 的用途與協作文件，以及逐本技能書的來源。
- `/.well-known/freedom-development.json`：同一份 JSON 的 discovery alias。
- `/development/<page>.md`、`/development/skills/<book>.md`：不依賴聊天上下文的文字指引。

開發資料是靜態公開內容，不包含會員、私人工作、聯絡方式、管理員名單或 token。這些入口不需要會員定位，但不放行任何會員工作區 API；下載指引與 Fork 都不授予資料或執行權限。Staging 本身仍在 Cloudflare Access 後面。

## 選擇修改的位置

1. 網站畫面、中央會員、權限、資料庫與業務規則：`FreeTWAI-AI/freedom-platform`。
2. 供應端 client、商店、專案介紹頁、行銷工具：該頁指引列出的模組 Repo。
3. 技能書裡的工具或手冊：預設從該書原作 Fork，向原作提交 PR，由原作維護者決定合併。工坊既有 Issue 保留作任務協調；明確針對工坊整合的改動才送工坊 fork，另記回饋原作的 PR 或未回送原因。參見[原作、版本與貢獻歸屬](./author-owned-collaboration.md)。

每個 Repo 的 README 說明用途和目前範圍，AGENTS 說明資料與操作邊界，CONTRIBUTING 說明任務、認領、驗證、PR、署名和溝通。GitHub Issue／PR 是程式任務的協調與審查來源；平台不另造一份認領狀態。已明確派工的對話沿用現有授權，不為流程再等待一次。

中央與外倉的通訊仍以 `contracts/preview/v1`、來源 pins、範圍受限的 client token 和 `/api/v1/protocol` 為準。新開發地圖是文件 discovery，不是新版業務 SDK，也不表示所有規劃模組已互通。不可由外倉直接連中央資料庫。

## 維護方式

- 頁面路徑、用途與驗證命令：`modules/development/pages.ts`。
- HTML、Markdown、JSON 與 crawler index：`modules/development/service.ts`。
- Repo 清單：`repository-guidance-index.json`，只存公開資料，不存 checkout 的本機絕對路徑。
- `contribution_target`／`contribution_default_branch` 是原作優先的預設 PR 目標；`repository`／`default_branch` 仍描述工坊整合工作區。兩者不可混用。11 筆個人原作 fork 的 parent／source 已於 2026-09-23 由 GitHub public API 核對；開始任務前仍須核對當下分支與 HEAD。
- 技能書的實際內容、來源 commit 與第一個練習：`modules/community/skill-book-guides.ts`；書架歸屬：`modules/community/catalog.ts`。
- 修改前端後先 `npm run build`，再跑 Playwright。使用隔離的測試資料庫；不把正式會員或客戶資料放入測試。

所有技能書都應說清適合誰、目前能做什麼、前置準備、實作步驟、第一個成果、可以貢獻什麼，以及查證來源。尚未實作的功能明列現況；不以通用介紹段落取代逐本核對。
