# 2026-09-24 技能、GitHub 與共創組審查

範圍：開源投稿、一起開發、自由工坊社群、技能書架、技能書介紹視窗、公開 SSR 介紹頁、Agent SKILL.md、GitHub callback、開發 Access、技能上傳與分享。

- 分支：`audit/skills-20260924`，base `8338a42`。
- 實作與測試由實際 Claude CLI `claude-opus-5-5` 執行，協調者 review 後提交；沒有 push 或部署，只使用本機隔離 PostgreSQL schema，沒有碰 public、staging 或真人資料。
- CLI 成功輸出的 `modelUsage.canonicalModel` 均為 `claude-opus-5-5`；UI 第二輪 session `d4c27562-19cf-4007-8a82-2328a1cf3b9b`，完整模型及測試紀錄在 `/tmp/freedom-audit-skills-followup.json`。

## 實際路由與頁面責任

| 入口 | 路由 | 元件／程式 |
| --- | --- | --- |
| 技能書架 | `/#skills` | `SkillsPanel` → `RepositoryLibrary`（`Community.tsx`）、`SkillBookCard`、`SkillUpload`、`CommunitySubmissions` |
| 技能書介紹（會員） | 書卡「閱讀／預覽技能書」視窗 | `SkillBookIntro`、`SkillBookCover`、`SkillBookBadges`、`GitHubBookSocial`、`SkillShare`、`DevelopmentEntry` |
| 開源投稿 | `/#opensource` | `OpenSourcePanel`（`OpenSourcePanels.tsx`；`MarketingPanel` 未動） |
| 一起開發 | `/#cocreation` | `CoCreationPanel` |
| 自由工坊社群 | `/#community` | `CommunityPanel` |
| 每頁開發入口 | 各頁底部 | `DevelopmentContext` → `DevelopmentAccessProvider` 對話框 |
| 公開 SSR 介紹 | `/development/skills/:id`、`/development/submissions/:id`、`/development/skill-upload` | `modules/development/service.ts`、`routes/development.ts`、`routes/published-skills.ts`，Star 由 `skill-social.tsx` 補上 |
| Agent 文件 | `/development/skills/:id/SKILL.md`、`/development/:id/SKILL.md`、`/development/submissions/:id/SKILL.md`、`/llms.txt` | 同上 |
| GitHub callback | `/github/callback` | `GitHubCallback`（由 `App.tsx` 依 pathname 分派） |

## 第二輪（接續）修正

協調者與其他組回報的具體問題，本輪逐項修正並實測：

| # | 問題 | 修正 | 證據 |
| --- | --- | --- | --- |
| R1 | 書內「開發這本技能書」加入 AI 開發公會後，API 已回 8 本，書架仍顯示「已解鎖 · 0」 | `SkillsPanel` 監聽 `freedom-profile-updated` 並在背景重讀；有任何 `<dialog open>` 時先暫存，全部對話框關閉後才套用，因此不會卸載開著的技能書視窗。套用時顯示「已解鎖 N 本新技能書」，若原焦點所在的書卡離開未解鎖列表，焦點移到「已解鎖」分頁 | `audit-skills.spec.ts`「joining a guild from an open book…」：開發視窗關閉後回到原書且焦點在「開發這本技能書」、書關閉後顯示 `已解鎖 · 8`、焦點在分頁、已解鎖列表 8 張。**把 `SkillsPanel.tsx` 換回 HEAD 版本時，同一測試在 `已解鎖 · 8` 失敗**，確認測試能重現原問題 |
| R2 | 共用頁尾「參與這一頁的開發」量到 32px | 第一輪將 `DevelopmentContext.css` summary 改為 min-height 44px、padding 10px；第二輪同檔 `.benefit-observation summary` 一併改為 44px 並加 focus-visible | 技能書架、一起開發、開源投稿、社群四頁在 1280／390px 斷言高度 ≥ 44、可聚焦、Enter 展開、focus 外框不是 none |
| R3 | 技能書架最上層沒有 GitHub 連線入口 | 新增 `GitHubConnectionSummary`（`GitHubSocial.tsx`），重用 `GitHubSocialStore`，放在書架頂部。未連結時只有一個「連結 GitHub」按鈕（`return_to: '#skills'`），不另跳確認、不 Star；已連結顯示 `@帳號` 與「管理 GitHub 連結」（前往我的名片，解除按鈕只在那裡）；未啟用顯示「GitHub 連結尚未啟用；仍可到 GitHub 上 Star、Fork 原作。」且沒有按鈕；讀取失敗顯示 alert 與「重新讀取 GitHub 連結」。一般會員不需 AI 公會 | 兩個 E2E：合成 OAuth 返回 `/#skills`、0 次 Star 寫入、書卡隨即出現 Star 與 Fork；無公會合成會員先遇 503 再重讀後顯示「尚未啟用」 |
| R4 | `skill-sharing.spec.ts` 寫死 4311 | `origin` 改在 `beforeEach` 由 `baseURL` fixture 取得，所有分享 URL 斷言仍是完整比對 | 4322 上 15 項全過 |
| R5 | `co-creation.md:34` 把已實作流程寫成「待實作」 | 改為已實作並連到公會開發權限文件 | `git diff --check` |
| R5 | `guild-development-access.md` 現況／驗收 | 保留另一個 Claude 的修改（10 項 runtime），補書架 GitHub 入口、本輪 E2E 實跑與驗收 #13–15 | 同上 |
| R6 | 既有技能書 metadata editor 條件 | 只在文件新增「本輪整合」段落：具名 maintainer **且** 有效 AI 開發／AI 導入公會其中之一；程式由 operations 組實作，本分支沒有改 helper 或 guild-workspace，也不寫它的測試結果 | 文件 |
| — | 開源投稿固定寫「平台目前尚未驗證你的 GitHub 身分」 | 改為「由你自行聲明；平台不以這次登錄驗證你與作品的來源、作者或擁有權關係。」 | 開源 E2E 斷言新文案、舊文案 0 筆 |
| — | callback 取消時一律說「帳號尚未連結」 | 取消：「你已取消這次 GitHub 授權，原有的連結狀態不受影響。需要時可回到原頁面再連結。」；缺參數：「…這次連結未完成…」。取消不呼叫伺服器，原連結確實不變 | callback E2E 斷言新文案且沒有「帳號尚未連結」 |
| — | 社群頁讀取失敗沒有重試 | 加「重新載入社群足跡」按鈕 | 社群 E2E：第一次回 503，按重新載入後數據出現 |
| — | DESIGN 字級 | `GitHubSocial.css` 的來源連結、數據說明、狀態、錯誤、重試、dt 標籤與按鈕由 .7–.8rem 改為 .875rem（14px）；`SkillBookIntro.css` 書卡 `.field-hint` 由 .72rem 改為 .875rem，介紹視窗內 `.field-hint` 由全域 .86rem 提到 .875rem。純裝飾眉標與徽章保留原字級，未改全域 CSS | E2E 在 1280／390px 量測書卡與介紹視窗中的可見來源／狀態／提示文字，全部 ≥ 14px |

測試隔離：`audit-skills.spec.ts` 不再依賴 `maker@local.test` 沒有入會。空書架與介紹視窗案例用 route 把 `/me/skill-books` 固定為空（明確標為 UI fixture）；入會刷新與無公會 GitHub 案例各自建立新的合成會員並使用真實 API，不共用 mock。

## 實跑證據

以下都是實際執行的結果。第二輪結果在前，第一輪結果保留在後面的表格。

第二輪（接續）：

| 命令 | 結果 |
| --- | --- |
| `npm run typecheck` | 通過（exit 0） |
| `npm run build`（每次改前端後、跑瀏覽器測試前） | 通過 |
| `git diff --check` | 通過 |
| `npx playwright test -c .audit-skills.playwright.config.ts tests/e2e/audit-skills.spec.ts --output /tmp/fp-audit-skills-results` | **20 passed**（10 個案例 × 1280／390px） |
| 同一設定跑 `co-creation`、`opensource-modules`、`skill-book-library`、`github-social`、`skill-sharing`、`skill-upload`、`development-guide`、`development-access`、`navigation-audit`、`audit-skills` | **76 passed、0 failed**（1.2 分鐘；log `/tmp/fp-audit-skills-suite.log`） |
| `node --import tsx --test --test-concurrency=1 tests/runtime/{co-creation,development-access,development-map,github-social-routes,github-social-store,github-social,member-skill-registration,opensource-marketing,published-skills,skill-book-guides,skill-collaboration,skill-discovery,skill-share-content,skill-sharing,skill-submissions}.test.ts` | **116 pass、0 fail**；其中 `development-access.test.ts` 單獨跑 10 pass |

第二輪只用一個瀏覽器 runner，artifact 輸出到 `/tmp/fp-audit-skills-results`，不與其他組共用 `test-results/`。截圖在 `test-results/audit-skills/`。

### 各頁操作證據對照

| 範圍 | 桌機／手機實際操作 | 測試 |
| --- | --- | --- |
| 技能書架 | 空書架提示、免費預覽 37 本、頁尾開發入口、GitHub 連線、入會後刷新 | `audit-skills` 前兩項、GitHub 兩項、入會刷新；截圖 `skills-*`、`shelf-github-*` |
| 技能書介紹視窗 | Star／Fork／Follow、來源、字級、Esc 焦點返回；開發視窗返回原書 | `audit-skills` intro 與入會刷新；截圖 `skill-intro-*` |
| 開源投稿 | 讀取失敗後重新載入、展開手動上傳、非 GitHub 網址被拒且草稿保留、390px 無溢出 | `audit-skills` opensource；截圖 `opensource-*`；另 `opensource-modules.spec.ts` |
| 一起開發 | 規則只出現一次、篩選並排、頁尾 44px | `audit-skills` co-creation；截圖 `cocreation-*`；另 `co-creation.spec.ts` |
| 自由工坊社群 | 讀取失敗後重新載入、4 個社群連結高度 ≥ 44、無溢出 | `audit-skills` community；截圖 `community-*` |
| 公開 SSR 介紹頁／SKILL.md | 無登入可讀、summary 44px、frontmatter 只有 name/description | `audit-skills` public；截圖 `public-skill-*`；另 `development-guide.spec.ts` |
| GitHub callback | 取消授權文案、URL 清除 code/state、返回連結 | `audit-skills` callback；書架 OAuth 返回 `#skills` |
| 上傳 | 一次性憑證、關閉後不恢復 secret、320px | `skill-upload.spec.ts` |
| 開發 Access | 公會選擇、焦點、320px、重新載入恢復目標 | `development-access.spec.ts` |
| 分享 | 擲骰、複製、失敗時完整 URL | `skill-sharing.spec.ts`（origin 依 baseURL） |

第一輪：

- E2E 使用協調者建立的暫存設定 `.audit-skills.playwright.config.ts` 與 `scripts/.audit-skills-e2e-server.ts`（port 4322，每次新建 `fp_e2e_*` schema）。這兩個檔案未納入提交。
- 每次改前端後都先跑 `npm run build`，再跑瀏覽器測試。

| 命令 | 結果 |
| --- | --- |
| `npx tsc --noEmit` | 通過（exit 0） |
| `npm run build` | 通過 |
| `git diff --check` | 通過 |
| `playwright … tests/e2e/audit-skills.spec.ts`（新增，1280px 與 390px） | **10 passed**（最後一次 7.2s） |
| `playwright … co-creation、opensource-modules、skill-book-library、github-social、skill-sharing、skill-upload、development-guide、development-access、navigation-audit、audit-skills` | **55 passed、11 failed**。失敗的 11 項全在 `skill-sharing.spec.ts`，原因是該檔把 origin 寫死為 `127.0.0.1:4311`，這次跑在 4322，與本輪修改無關（見下一列） |
| 把 `skill-sharing.spec.ts` 的 4311 換成 4322 的暫存副本（跑完即刪） | **15 passed** |
| `tsx --test` 15 個相關 runtime 檔（development-map、github-social×3、member-skill-registration、skill-book-guides、skill-collaboration、skill-discovery、skill-share-content、skill-sharing、skill-submissions、published-skills、development-access、co-creation、opensource-marketing） | **116 pass、0 fail** |
| 修改前基準探測（同一套設定，桌機與 390px） | 蒐集到 20 組頁面數據；下文的發現都依此重現 |

未跑（not_run）：

- 完整 `npm test`、`npm run test:e2e`、`test:repos`。UI 輪只跑與修改範圍相關的項目，其餘交由協調者統一執行。契約全文閱讀與完整 `test:contracts` 結果另見[計畫附錄](./audit-2026-09-24-skills-plan.md)。

## 各頁發現與修正

嚴重度：高 = 誤導操作或違反規範；中 = 明顯的 UX 或重複；低 = 文字或細節。

### 技能書架（桌機與手機）

1. **高，已修：已解鎖 0 本時畫面誤導。**
   - 修正前：仍顯示 5 顆榜單按鈕、搜尋欄、用途篩選、「顯示 0 / 0」，以及「沒有符合的技能書。試試另一個關鍵字或用途。」。使用者並沒有搜尋，卻被引導去換關鍵字。
   - 修正後：只顯示「還沒有已解鎖的技能書。加入公會即可領取，也可先免費預覽。」，並提供「選擇公會」與「免費預覽技能書」兩個操作（後者切換到未解鎖）。`RepositoryLibrary` 在可用書目為 0 時也不再畫出篩選器。
   - 手機版少了一整段無效控制項。
   - 驗證：E2E 確認 API 目錄正好 37 本，切換到未解鎖後顯示 37 張書卡。
2. **中，已修：「參與這一頁的開發」觸控高度只有 32px。** 低於 DESIGN 規定的 44px，每一頁都受影響。已改為 min-height 44px（`DevelopmentContext.css`），第二輪在四頁補量測與鍵盤操作斷言（見 R2）。
3. 低，未改：這頁的「手動登錄作品」按鈕會導向開源頁，但開源頁的摺疊標題叫「手動上傳」，名稱不一致。`navigation-audit.spec.ts` 屬其他組，沒有改（見共享修改需求）。

### 技能書介紹視窗（桌機與手機）

4. **中，已修：連結與說明重複。**
   - 修正前：原作 repo 連結在同一個視窗出現 6 次（說明行、開啟原作、原作者 GitHub、Watch、前往 GitHub Star、查看來源專案），工坊整合版連結 2 次。「參與開發」摺疊區又重複了一次「一起開發」的內容。
   - 修正後：
     - 刪除「參與開發」摺疊區。「查看原作 PR ↗」「查看協調任務 ↗」移到「一起開發」區，另附一句 PR／授權規則。
     - 「作者、授權與收錄來源」只保留帳號、授權、核對日期、證據檔與收錄版本，不再重複專案連結。
     - 頂部說明行改成純文字的作者與原作名稱，不再帶連結。
   - 仍保留：開啟原作、Fork 原作、查看工坊整合版本；Star 按鈕，以及 Fork、Watch、Follow 原作者的 GitHub 連結。
   - 驗證：E2E 檢查 Fork／Follow 的 href、Star 控制項存在、無橫向捲動，以及按 Esc 後焦點回到原按鈕。

### 開源投稿

5. 低，已修：頁首眉標「OPEN SOURCE / 分享程式，累積使用與協作」屬於英語口號加重複說明，縮成「OPEN SOURCE」。
6. 第二輪已修：關係欄位提示原本寫「平台目前尚未驗證你的 GitHub 身分」，但站內已有真實 GitHub 連線；改為只說明來源／作者／擁有權是本人聲明、不由登錄驗證。NOASSERTION 授權與固定版本仍有顯示。

### 一起開發

7. **中，已修：同一條規則講了很多次。**
   - 「先到 GitHub 任務留言認領；完成後提交 PR…」原本是頁首下方的獨立段落，已併入頁首描述，只出現一次。
   - 刪除「篩選本次載入的任務；條件會保留到你關閉這個瀏覽器分頁」這句低價值提示。
   - 頁首次要按鈕「投稿作品」改名為「登錄作品」，與目的地一致。
8. **中，已修：手機版篩選欄太佔高度。** 只有 1 項任務時，390px 仍有 4 個全寬欄位。現在搜尋獨占一列，其餘三個兩兩並排，頁高由 2459px 降到 2415px。E2E 確認類型與負責人兩欄並排。
9. 低，未改：「把開發指令貼給你的 Agent…」「通用改善優先回饋原作…」「以下依 GitHub 已合併的 PR 顯示…」三句仍在。它們涉及權限與署名邊界，依 DESIGN「必要限制仍須看得見」保留。

### 自由工坊社群

10. 低，已修：每個數據卡已有「非即時或去重人數」的註記，下面又有一句同義總結，已刪除總結，保留開放資料連結。
11. 已檢查：Discord／LINE 連結高度 44px；原始品牌圖完整顯示；手機版無橫向捲動。
11a. 第二輪已修：社群足跡讀取失敗時只有文字、沒有重試，現在有「重新載入社群足跡」。

### 公開 SSR 介紹頁與 Agent SKILL.md

12. **中，已修：「工坊整合與任務來源」摺疊標題只有 27px 高。** 在 `collaborationCss` 補上 44px 高度與 focus-visible 樣式。
13. 已檢查：SKILL.md 以 `text/markdown` 回應，frontmatter 只有 `name` 與 `description`，name 符合小寫連字號、64 字以內（契約 README:70）。頁面不需登入即可閱讀；Follow 與 Fork 是真實的 GitHub 連結。
14. 低，未改：`/development/skills/:id.md` 回應的是 `text/plain`，SKILL.md 是 `text/markdown`，兩者不一致。不影響使用。

### GitHub callback

15. 中，已修：使用者在 GitHub 按取消（`error=access_denied`）時，畫面只顯示「尚未連結 GitHub。」。現在分成兩種訊息（第二輪依 review 改寫，不再聲稱帳號未連結）：
   - 取消授權：「你已取消這次 GitHub 授權，原有的連結狀態不受影響。需要時可回到原頁面再連結。」
   - 缺少回傳參數：「GitHub 沒有回傳授權結果，這次連結未完成。請回到原頁面重新連結。」
   - 網址仍會清掉 code 與 state。
16. 低，未改：失敗時的返回按鈕固定是 `/#skills`。return_to 只存在伺服器端的 state，失敗時無法得知原頁。

### 開發 Access、上傳、分享

17. 已檢查、未改：
    - 開發 Access 對話框在桌機與手機都沒有溢出，GitHub App 未設定時有如實提示。
    - 上傳視窗的 60 分鐘一次性憑證、投稿專用金鑰與「本人預覽送出」都符合需求。
    - 分享擲骰子與複製流程由既有 skill-sharing／skill-upload E2E 覆蓋（見實跑證據）。

## 必須保留的需求核對

| 需求 | 本輪結果 |
| --- | --- |
| 公會 grant、離開 revoke | 未改動相關程式；development-access runtime 測試通過 |
| 自填 GitHub slug 不授權 | 未改動；開源與上傳流程仍標示「自行聲明」 |
| Star／Fork／Follow 可操作 | Star 在站內可操作（github-social E2E 通過）。Fork 與 Follow 是連到 GitHub 的真實連結，要在 GitHub 上完成操作。書架頂部新增的 GitHub 連線不取代每本書的操作 |
| OR 公會、key 撤銷 | 未改伺服器程式；`development-access.test.ts` 10 pass |
| 強制 Star gate | 仍是使用者要求但未落地；建議的自願方案未獲使用者接受。本輪沒有做任何決定 |
| 原作者來源、署名、授權 | 視窗與 SSR 仍保留作者、原作、授權、收錄版本與證據檔 |
| 37 本技能書 | E2E 斷言 `/api/v1/community` 回傳 37 本，未解鎖列表 37 張 |

## 真正未完成的缺口

1. **Follow 沒有站內操作。** 現在只能連到 GitHub 個人頁。要做成站內 Follow，需要 GitHub App 開啟 Followers 權限，並新增 `PUT /user/following` 路由與 fixture。這牽涉後台 GitHub 設定（其他組）與權限審查，本輪沒有做。
2. 完整的 SkillVersion／QC 執行路徑、GitHub App webhook／對帳 worker、原作版本與 credit 同步仍是後續範圍。已領書籍紀錄、開發能力 grant、Agent ExecutionGrant 是不同物件；首輪將三者混同而建議 ADR 的說法已撤回，詳見計畫附錄 §4。
3. ~~`skill-sharing.spec.ts` 把 port 4311 寫死~~：第二輪已改為依 `baseURL`（R4）。
4. 既有技能書 metadata editor 的「maintainer 且 AI 公會」條件：程式在 operations 組分支，待 root 整合與補測試結果。

## 共享修改需求（本組不能改的檔案）

- `tests/e2e/navigation-audit.spec.ts`（導覽組）：如果要把開源頁的「手動上傳」改名為「手動登錄作品」以對齊技能書架按鈕，需要同步更新第 33 行。本輪沒有改名。
- `tests/e2e/skill-sharing.spec.ts`：第二輪已依協調者指示改為使用 `baseURL`，產品程式未改。

## 工作區內非本組的變更

`git status` 裡有幾個不是本 agent 產生的檔案，本輪沒有動，請協調者判斷：

- `docs/development/guild-development-access.md`：另一個 Claude 的修改已保留，第二輪在其上補 GitHub 入口、E2E 實跑與 metadata editor 條件。
- `.audit-refresh.playwright.config.ts`、`scripts/.audit-refresh-e2e-server.ts`：協調者的 4325 重現設定，保留未動、不提交。`tests/e2e/.audit-refresh.spec.ts` 已整合進 `audit-skills.spec.ts` 並刪除。
- 第二輪期間工作區出現、本 agent 未建立也未修改：`docs/platform-plan/contracts/openapi-outline.yaml`、`organization-professions.example.yaml`、`contracts/tests/test_membership_submission_contract.py`、`docs/development/audit-2026-09-24-skills-plan.md`。本報告的測試結果不涵蓋它們。
- `.audit-skills.playwright.config.ts`、`scripts/.audit-skills-e2e-server.ts`：4322 暫存設定，不提交；root 會以正式 `FREEDOM_E2E_PORT` harness 取代。

## 計畫閱讀清單與差異

**閱讀方式：** 首輪唯讀子 agent 完整閱讀 02、spec-index 與指定 specs，與舊版 `/home/ted-h/projects/Freedom-Platform/docs/platform-plan` 做 diff；05 §11–15 與大型 contracts 當時只讀相關段落。後續由獨立實際 Claude CLI 補完 05 全文、全部 contracts 頂層 schema／example、OpenAPI（修改前 9175 行）及 core（2116 行）；逐檔完整範圍、契約修正、測試與更正解讀見[計畫附錄](./audit-2026-09-24-skills-plan.md)。fixtures 依任務要求只看目錄與相關測試。

### 已讀清單（新版行數 → 與舊版比較）

- `02-architecture-repositories.md`（641）：已更新。09-19 低維運互惠修訂；§4.5 加 09-23 覆寫（`ai-online` 只參考形式、新會員必填定位）；§4.7 加 Node core 只做有界 GitHub GET。
- `05-integration-contracts.md`（1142）：已更新，加 §18.1 participation-terms／benefit-observations；後續已全文補讀。
- `execution/spec-index.md`（138）：已更新，加 09-19 範圍修訂與 FW-01–12 靜態交付註記。
- `execution/specs` 的 BLD-01～05、AGT-01、AGT-02、AGT-04、AGT-05、INT-03A、INT-03B、SKL-01、SKL-03：新舊版**完全相同**，仍停在 2026-09-17。
- `contracts/README.md`（98）：已更新，加 client scoped read token 例外與 09-19 契約增量。
- `contracts/agent-work-contract.example.yaml`、`event-catalog.example.yaml`、`openapi-outline.yaml`、`project-manifest.schema.json`、`state-machines/core.example.yaml`：已更新，屬 work participation 與 reviewer capacity 相關；技能段落沒有變。
- 新檔：`operating-policy.example.yaml`、`work-participation.schema.json`／`.example.yaml`。
- 無差異：`skill-package.schema.json`／`.example.yaml`、`entitlement-catalog.example.yaml`、`member-onboarding.*`、organization-professions、entity-playbook、xp-policy、submission-intake、commerce、discord、line、event-envelope、domain-skill-overlay、portable-activation、project-status-attestation、external-personal-fork。
- fixtures 目錄：review-retraction、github-mock、domain-skill-overlay、portable-bundle、settlement-modes、five-clocks、reviewer-appointments、xp-rebuild。

### 真正不一致（依使用者最新需求判斷）

- **C1 已修契約：投稿不自動入會。** OpenAPI 與 organization-professions 改為只保存來源、版本與候選證據，加入公會需另行選擇確認；root 同步修核心 prose，見計畫附錄。
- **C2 更正：四種不同 aggregate。** 執行版投稿、未來 SkillVersion／QC、SubmissionDraft 不應硬套同一組 enum。SkillVersion 狀態在 03 已有定義；附錄 §4 列對照。執行版 `published` 是公開 candidate，沒有冒充 official。
- **C3 更正：保留已領書籍，撤銷未來開發能力。** 離開最後一個適用 AI 公會會撤銷開發 grant／key；原本已領書籍、提案與署名保留。這不是缺一個 ADR 才能解決的衝突。
- **C4 「技能書」與 installation 語意不同。** 00:7 說技能書指 Repo，不是 Agent installation；實作的領書紀錄與 installation 分開，一致。
- **C5 已修契約：rank 與 state 對齊。** Read model 支援 runner／strategist／master，review 保留既有 rank、left 保留歷史 rank；新加入仍只授 runner，並有正反例測試。
- **C6 更正：本人點 Star 與 Agent ExecutionGrant 不同。** 本人點擊表示該次操作意圖；Agent 代做才適用 AGT-02／INT-03B 的 grant。連結本身不加星，也不能代替未來 Agent grant；強制 Star gate 仍是使用者要求但未落地，自願替代尚未獲同意。
- **C7 spec 的狀態聲明過時**（仍寫未測、09-17），以 spec-index 為準。
- **C8 02 §4.5 表格與上方覆寫矛盾**（02:266 對 02:262），以 02:262 覆寫為準。

## 變更檔案

- `apps/portal-web/src/modules/`：`SkillsPanel.tsx`、`Community.tsx`、`SkillBookIntro.tsx`、`SkillBookIntro.css`、`GitHubSocial.tsx`、`GitHubSocial.css`、`CoCreationPanel.tsx`、`CoCreation.css`、`DevelopmentContext.css`、`GitHubCallback.tsx`、`OpenSourcePanels.tsx`（只改 `OpenSourcePanel` 的眉標與關係提示）
- `modules/development/service.ts`：只改 `collaborationCss` 的 summary 觸控樣式
- `tests/e2e/co-creation.spec.ts`：配合頁首文案更新；`tests/e2e/skill-sharing.spec.ts`：origin 依 baseURL
- `docs/development/co-creation.md`、`docs/development/guild-development-access.md`
- 新增 `tests/e2e/audit-skills.spec.ts`、本報告
- 未改 App、全域樣式、導覽、`pages.ts`、`guild-eligibility` helper 或 `guild-workspace`
