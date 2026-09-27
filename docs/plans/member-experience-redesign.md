# Issue #12 會員體驗 redesign 與 Staging 整合計畫

日期：2026-09-27。這份計畫以 Ted 在 Issue #12 [回覆的產品決策](https://github.com/FreeTWAI-AI/freedom-platform/issues/12#issuecomment-5858498505) 為準。隔離實作已開始；尚未合併、推送或部署。

## 範圍與版本基線

- 需求來源：[Hao 的 Issue #12](https://github.com/FreeTWAI-AI/freedom-platform/issues/12) 是**產品提案**，原文說明驗收條件尚未獲批准；[PR #14](https://github.com/FreeTWAI-AI/freedom-platform/pull/14) 是該提案的一個實作版本，不等於已核定的全站規格。2026-09-27 查詢時，PR 開啟中、無 review decision、無 GitHub check 回報。
- `origin/main`：`b0516d2`；Hao fork `feat/member-experience-issue-12`：`f0afb02`，共同基點 `f50c181`。PR 相對 `origin/main` 只有一個功能 commit，**35 files changed, +702/-47**；涵蓋 11 個前端檔、4 個 API／domain 檔、1 個 migration、`DESIGN.md`、開發頁索引／腳本與 16 個測試檔。此數字是 PR 差異，不能用本 BAT worktree 的舊 `main`（`4c019ff`）比較，否則會誤報 681 個檔案。
- Staging 使用另一個 repo/worktree 的 `feat/global-game-console`：`f958dcc`（`/home/ted-h/projects/Freedom-Platform/worktrees/game-console`）。它含底部 Game Console、世界聊天、頁面工具、GitHub Issue 工具與 migration 038–040；本計畫以它作整合基線。本次只讀取該 worktree，**不直接修改 Staging worktree**。隔離分支現名 `feat/member-experience-redesign`，從 `f958dcc` 建立。
- `origin/main` 的 `b0516d2` 增加 UI 設計技能規則；Game Console 分支與 Hao 分支都從它的父提交分出。整合分支已移植此提交（`7b5a8a6`）與 Hao 功能提交（適配後 `3a138f0`，保留 Hao 為作者），並依 `AGENTS.md` 和 `DESIGN.md` 工作。

## Hao PR 實際做了什麼

| 產品面 | 實作入口 | 審查要點 |
| --- | --- | --- |
| 新會員先看內容 | `App.tsx`、`WelcomePreview.tsx`、`platform-app.ts` | 登入但未完成定位者看活動、開放工作與技能書摘要；保留原定位流程和 API gate。預覽並非匿名首頁，也不給完整會員功能。 |
| 明亮主題與導覽 | `light-theme.css`、`main.tsx`、`Navigation.tsx`、`MemberHome.tsx`、`DESIGN.md` | 明亮版直接設預設，新增主題切換；活動、任務升成主入口，定位與夥伴移到分組。 |
| 活動 | `EventsPanel.tsx`、`community-events.ts`、`modules/community/events.ts`、原 `038_community_events.sql` | Hao 原版由已定位會員直接發布，缺審核、系統公告與通知。本整合依 Ted 決策改成任何登入會員可提交，管理員或主辦公會長核准後才公開報名。 |
| 任務與貢獻值 | `TaskBoardPanel.tsx`、`modules/community/task-board.ts` | Hao 原版每件已接受工作 +10，顯示跨職業總值。Ted 沒有核定固定分數；整合版改顯示帶來源的驗收事實，日後再計分。 |
| 驗證 | `member-experience.spec.ts`、`member-experience.test.ts` 及既有測試調整 | PR 描述聲稱本機通過 typecheck/build、547 runtime、特定 e2e 和 Worker；本輪未在整合分支重跑，不能當整合驗收。 |

## 三方衝突與保留條件

已用 `git merge-tree --write-tree f958dcc f0afb02` 做不改工作樹的預演；**4 個文字衝突**：`apps/platform-api/src/platform-app.ts`、`apps/portal-web/src/App.tsx`、`Navigation.tsx`、`main.tsx`。`MemberHome.tsx` 兩邊都改但預演可自動合，仍要做產品審查。`DESIGN.md` 與 `light-theme.css` 沒有文字衝突，卻有視覺與元件相容性風險。

| 衝突面 | Staging 已有功能 | 整合方式與不得退化的條件 |
| --- | --- | --- |
| 右上三個頁面工具 | `PageTools.tsx` 在頂欄提供「提出想法」「頁面說明」「參與編修」；註冊頁也有工具。`PageTools.css` 管手機排序與 dialog。 | 保留三個 icon button 的頁面上下文、GitHub Issue 列表、本人發布／認領及錯誤復原。主題切換應放在設定或頂欄次要位置，由桌機／320px／390px 版面原型決定，不能擠走三工具、設定、登出或觸控範圍。新 `events`／`tasks` 頁補 `developmentPages` 與 `page-help`，讓工具不是空按鈕。 |
| 設定與訊息 | Game Console 分支的頂欄仍有「設定」「登出」，設定含名片／待辦；`#messages` 有通知、公會、小隊、私訊。導覽有直接「我的訊息」入口。 | 保留 `#messages`、SettingsMenu 未讀、四個分頁及直接連結；加頂欄通知鈴與未讀數，能查看最近通知並前往完整訊息頁。不要用 Hao 舊版 `SettingsMenu` props 覆蓋 Game Console 版，也不要清掉 member chat 的存取檢查。 |
| 底部訊息／聊天室 | `GameConsoleProvider` 包住定位和整個工作區，底部 44px 訊息列常駐；世界聊天、公會／小隊／私訊、世界導覽、AI／系統頻道與獨立視窗共存。 | 把 Hao 的 WelcomePreview／Onboarding **放在既有 Provider 內**。未完成定位時保留訊息列，但 `feedEnabled=false`、不能讀／送受保護聊天；完成定位後啟用頻道。切頁不能重建控制台、遺失草稿或未讀；登出／Access 失效清空。預覽頁、活動頁、任務頁都要有底部 48px 安全空間，展開面板不遮住唯一操作。 |
| API 與訊息來源 | `platform-app.ts` 已掛世界聊天、頁面工具與 GitHub 相關路由；Console 會讀任務、公告等 feed。 | 逐條合併 route／onboarding allowlist，保留現有授權和 GitHub 讀寫邊界。活動提交與審核寫交易內公告，世界頻道以 bulletin ID 去重讀取；驗收工作以 contribution ID 去重讀取。活動報名不產生貢獻成果。 |
| 資料庫 | Staging 分支已有 `038_game_console.sql`、`039_page_issues.sql`、`040_page_issue_titles_and_claims.sql`；migration runner 依檔名排序並核對已套用檔案的 SHA-256。 | 將 Hao 尚未發佈的 `038_community_events.sql` **在整合分支改名為 `041_community_events.sql`**，不改動既有 038–040。以現有 Staging schema 的拷貝／隔離 DB 驗證升級與重跑；不得用改既有 migration 的方式避過 hash 檢查。 |
| 明亮主題 | Console、PageTools、會員訊息的 CSS 以深色為主，部份元件用固定色；Hao 以全站 selector 覆蓋一部分。 | 決定 Console／PageTools 在明亮模式採一致淺色或有意保留深色獨立面板，並逐狀態驗證對比、焦點、未讀、錯誤與 modal 層級。不要只看首頁截圖；檢查 320／390 手機和桌面、鍵盤與縮放。 |

## 合併策略與里程碑

採 **以 Game Console 建隔離整合分支、選擇性移植 Hao 單一 commit**。保留 Hao 為原作者並在後續 PR 註明來源；不把 Staging 分支重置成 Hao fork，也不改 Hao 的分支。`App`、導覽、API 入口與主題載入的四個衝突已按行為手工合併，Hao 的活動 API／畫面／測試在整合分支上按 Ted 已核定政策重做。先用隔離 DB 驗證，之後再做 Staging 候選；此計畫不授權推送、合併或部署。

1. **產品與版面契約**（決策已核定）：登入後的預覽保留；明亮設預設，另有「自由工坊－夜航（深色）」和「自由工坊－敘生」。敘生可參考 Ted 的 VERSEFOLK，但以新的可愛原創畫面呈現。三個頁面工具、通知鈴、設定與訊息入口、底部 Console 在完整工作區同時存在；未定位者可提交活動、看本人審核狀態與通知，不能讀完整會員聊天／工作。驗收：桌機及 320／390 手機都能看見並操作重要入口，通知數與訊息數取自真實 API。
2. **隔離整合與安全預覽**（本地完成）：從 Staging HEAD 建 `feat/member-experience-redesign`、移植 Hao commit，手解四衝突、採 migration 041、保留 Provider。驗收：typecheck/build；未定位帳號只讀明確允許的摘要與本人提交狀態，無會員私訊、世界聊天、成員資料或受保護任務正文；定位草稿可續填，完成後舊 hash 與原操作可用。
3. **全站 UI 與訊息保護**：三個主題共用元件與設計 token。敘生使用本整合重新生成的工坊插圖，不直接貼 VERSEFOLK 舊畫面。驗收：三工具可見可用、通知鈴與訊息四分頁、底部 Console／世界聊天／獨立視窗正常；320／390／桌面無橫向溢出或遮擋，觸控至少 44px、焦點與對比可辨。訊息控制台切頁不重建，預覽期不輪詢 gated 聊天。
4. **活動與任務政策實作**：任何已登入會員可提交公開活動；平台管理員可審核全部，指定主辦公會的現任會長可審核其活動；核准後才可報名。提交與核准都在同一交易寫系統公告與站內通知，頂欄通知鈴仍可存取。已驗收工作沿用 `work_decisions`／`contributions` 與 outbox transaction，展示 claim、decision、acting profession 參照；世界頻道播報，不給固定 +10。驗收：跨社群隔離、審核權限、審核併發／重播、容量併發、取消、退回理由與通知、公告去重；GitHub Issue 不被顯示成已驗收。
5. **整合驗收與交付**：在隔離 PostgreSQL 執行 migration 038→041 與重跑，執行 typecheck/build、相關 runtime／e2e、Worker dry-run；新增兩分支交界的瀏覽器驗收（預覽＋底部列、右上三工具＋三主題＋通知、世界聊天＋訊息頁、活動／任務＋導覽）。記錄本次真實結果。Staging 使用獨立候選與合成帳號驗證後，再安排對外 merge／release；保留回退版本與 migration 前備份。

## 已核定決策與待後續政策

| 項目 | Ted 核定與本次範圍 |
| --- | --- |
| 主題 | 預設「自由工坊－明亮」；原版命名為「自由工坊－夜航（深色）」；第三款「自由工坊－敘生」取 VERSEFOLK 的溫暖敘事風格，由本專案重畫可愛插圖。Ted 明確確認對 VERSEFOLK 素材有使用權，但不要 1:1 複製。 |
| 公開活動 | 任何已登入會員可提交；平台管理員或主辦公會長審核；提交與核准均寫系統公告並發站內通知。右上角保留類似 FB 的通知入口。 |
| 驗收工作 | 資料庫保留每人完成的工作、驗收決定、當時職業身分及時間，世界頻道記錄。固定分數政策待後續決定，現在不展示跨職業總分；職業總值也留待獨立政策。 |
| 登入預覽 | Ted 對第一階段進站方案回覆「ok」；維持登入後、未定位前安全預覽，並允許此狀態提交活動。 |

仍需獨立政策的是計分版本、重新計分／撤回規則及是否增加職業總值；這不阻擋已核定的體驗改版。尚未授權對外 merge、正式站部署或更改 Hao PR／分支。

## 本地驗證與交接

- `npm run typecheck`、`npm run build`、`npm run worker:dry-run` 已通過；Worker 僅產生本地乾跑輸出，未部署。
- runtime 指定測試：會員體驗／活動／管理員／既有流程 43 項、頁面工具與 Console feed 6 項均通過。先前整套 `npm test` 只有 `page-issue-label` 因新活動／任務缺頁面說明而失敗；補齊兩頁說明後，該指定測試已通過，整套未再次執行。
- Chromium E2E：預覽／三主題／320px 版面 3 項、頁面工具與 Console 13 項、設定選單補測 3 項、聊天室 UI 11 項、兩人真實 API 訊息流程 1 項通過。敘生小螢幕截圖已人工檢查；原有 Console 展開列仍固定於視窗底端，內容可捲動。
- 新繪的敘生插圖與產生提示、雜湊記錄於 `docs/design/versefolk-theme-art-manifest.json`；沒有直接貼用 VERSEFOLK 畫面。正式 Staging 候選仍須升級現有資料庫副本並做完整三主題跨頁視覺驗收；本地測試使用隔離 schema。
