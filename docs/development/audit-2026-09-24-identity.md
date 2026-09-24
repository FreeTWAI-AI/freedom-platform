# 2026-09-24 會員身分與公會頁審查

範圍：會員首頁、註冊／登入、定位（含重新探索）、我的名片、工坊夥伴、我的定位、職業公會（含成員視窗）、小隊集合。基準 commit `8338a42`（分支 `audit/identity-20260924`）。本輪只改動 `apps/portal-web/src/modules/` 內負責的元件與專用 CSS，並新增 `tests/e2e/audit-identity.spec.ts`。同日的後續輪次（§3 第 12–14 項）只改 `MemberHome.tsx`、`Squads.tsx`、`CapabilityTree.tsx`、相關 E2E 與本文。沒有新增權限、API、資料欄位或未來架構；原始 `freedom-workshop.webp`、作者署名、隱私可見範圍語意，以及名片「社群顯示名稱」和「男／女／外星人／AI」選項都保留。

## 1. 完整閱讀的文件

以下文件逐行讀完，未截斷：

| 文件 | 本倉（worktree） | `/home/ted-h/projects/Freedom-Platform/docs/platform-plan` |
| --- | --- | --- |
| `01-product-community-model.md` | 539 行，2026-09-19 低維運互惠修訂＋2026-09-23 會員 beta 註記 | 528 行，2026-09-17 baseline |
| `10-member-agent-narrative.md` | 45 行，互助敘事＋2026-09-23 進度註記 | 120 行，舊版「成員和 Agent 的一天」 |
| `12-low-ops-mutual-benefit.md` | 147 行，2026-09-19＋2026-09-23 入口覆寫 | **不存在** |
| `execution/human-foundation-plan.md` | 220 行，2026-09-19 修訂 | 215 行，2026-09-17 |
| `execution/specs/ORG-01.md` | 88 行，2026-09-19 修訂 | 84 行，2026-09-17 |
| `execution/specs/ORG-02.md` | 84 行 | 相同 |
| `execution/specs/FND-01.md` | 84 行 | 相同 |
| `execution/specs/FND-02.md` | 84 行 | 相同 |

另讀：`AGENTS.md`、`CONTRIBUTING.md`、`DESIGN.md`、`README.md`、`playwright.config.ts`、`scripts/e2e-server.ts`、`tests/e2e/fixtures.ts`、`tests/e2e/navigation.ts`，以及本輪負責的全部模組。

## 2. 兩份計畫的落差，以及哪一份才是現行版本

`projects/Freedom-Platform` 的副本停在 **2026-09-17 baseline**。本倉是較新的現行版本：它包含 2026-09-19 的低維運互惠修訂，以及 2026-09-23 公開會員 beta 的註記。現行程式以本倉版本為準。

本節是第一輪審查當時的比對。計畫文件的修正由另一個分支處理，已合入 `main`：`01`、`10`、`12`、`execution/human-foundation-plan.md`、`ORG-01`、`ORG-02`、`FND-01`、`FND-02` 都已與目前 beta 對齊，包括 ORG-02「member 跳過定位」改為新會員必須完成定位。修正內容與逐項依據見 [身分、公會與計畫文件對齊稽核](audit-2026-09-24-identity-plan.md)（該檔在 `main`，本分支合併後即可連到）。本文不再列出待修的規格缺陷；計畫文件與 Star 需求的措辭由 root 負責。

目前目錄實數（依程式核對）：`modules/positioning/assessment.ts` 的 `guildTitles` 有 **18** 個公會，`modules/community/catalog.ts` 的 `communityCatalog.skill_books` 有 **37** 本技能書。README 寫的「現有 15 個公會」已過時，由 root 修正。

| 主題 | 舊版（09-17，projects） | 現行（本倉） | 程式現況 |
| --- | --- | --- | --- |
| 平台承諾 | 找方向→學技能→成果→合作→收益 | 真實問題→自願共同改善→雙方實益→重用 | 首頁只有常用入口，沒有「我需要幫助／我能提供協助／我們正在一起做」三個互助入口：**未來缺口**，不是回歸 |
| Now／Next／Gained | 身分／下一步／已確認事實 | 求助、協助、共同目標，並分列未知與單方回報 | 首頁、小隊、公會都沒有這個投影：**未來缺口**。已實作的部分在 work 模組：工作項目的 `participation_terms`（含 revision 與 SHA-256）、認領時比對並保存條款摘要（不符回 409 `terms_changed`），以及單一工作項目的第一人稱實益觀察 `work_benefit_observations`（migration 015） |
| 新人定位 | 定位是導航，可略過 | 12 章 2026-09-23 覆寫：新註冊會員**必須**完成定位、選公會、領技能書 | 已實作（`App.tsx` 在 `required&&!completed` 時擋在定位流程）。ORG-02 已由計畫分支改為新會員必須完成定位 |
| 加入公會 | self-service Runner | 相同，沒有 admission approval | 已實作：直接加入並解鎖技能書，沒有審核步驟 |
| 新職業線 | Board WorkItem | 相同 | 會員送出「申請創建公會」後由管理員確認，屬於部分對應 |
| Squad | 完整 lifecycle | 09-23 註記：先提供 `project`／`mutual_help`，由本人申請、發起人接受；共同目標週期、Work／GitHub 連結、結束與移交仍待補 | 已實作註記所述範圍；結束與移交是**未來缺口** |
| Rank／Office／Stewardship（ORG-01） | Portal 分頁顯示 rank、office、delegation、review appointment | 相同，另加容量段；移除「無 successor 自動建 interim」 | 只顯示公會長與最多三位專家（專家標章不給管理權）。Runner／Strategist／Master、office 任期與 delegation 都沒有 UI：**未來缺口** |
| WorkIntent／equipped Skills（ORG-02） | 本人確認 intent＋裝備 SkillPackage 版本 | 相同 | 定位裡的「裝備」指工具或訂閱名稱，**不是** ORG-02 的 SkillPackage equip，兩者同名不同義（見 §5） |
| XP | 分職業重建 | 相同，禁止跨職業加總 | 未實作；介面也沒有捏造 XP 或等級，符合 DESIGN.md |
| Foundation Day 1、FND-01／02 | 帳號、contract tests 未建立 | 相同，只多了修訂說明 | `docs/platform-plan/contracts/tests/test_fnd_01_*` 等檔案仍不存在，與 spec 的「未跑」一致 |

## 3. 各頁發現、嚴重度與處理

證據目錄在本機 `/tmp/fp-audit-identity/`（未提交）。`probe-before/` 與 `probe-after/` 是各頁桌面 1440px 與手機 390px 的全頁截圖和 `report.json`（heading、溢出、觸控尺寸、輸入字級、重複文字）。`audit-screenshots/` 是新 E2E 的截圖。後續輪次的證據在 `followup/`：`tree-before/`、`tree-after/` 是定位第 3、4 步在 1440×900 與 390×844 的全頁截圖和量測，`audit-screenshots/` 含名片錯誤與復原截圖，`new-tests-on-original.txt`、`final-e2e.txt`、`final-audit-rerun.txt` 是測試輸出。重跑 `audit-identity.spec.ts` 會寫入 `test-results/audit-identity/`（已被 gitignore）。

| # | 頁面 | 發現 | 嚴重度 | 處理 | 證據 |
| --- | --- | --- | --- | --- | --- |
| 1 | 我的定位 → 重新探索 | 流程在工作區內整份渲染 onboarding：主內容多出第二張品牌圖、第二個「參與這一頁的開發」和社群頁尾 | 中（重複、冗長） | `Onboarding` 的 `optional` 模式不再渲染品牌頭、DevelopmentContext 與 CommunityLinks，工作區殼層已提供。桌面頁高 4051→3665px | `probe-before/desktop-positioning-retake.png` 對照 `probe-after/` |
| 2 | 定位各步驟 | 同一步驟同時顯示三種進度：步驟列、「定位旅程 0X / 05」、眉標編號 | 低（重複） | 刪除「定位旅程 0X / 05」列；步驟列（`aria-current=step`）是唯一進度指示 | `*-onboarding-*.png` |
| 3 | 工坊夥伴 | h2「工坊夥伴」與頂欄 h1 完全相同，違反 DESIGN.md「次標題不重複頁名」 | 低 | h2 改為「依專長與公會找夥伴」，刪除重複說明 | `report.json` headings |
| 4 | 我的名片（桌面） | 聯絡欄位貼在直排五個勾選框的底部，左側留下大片空白，欄位名與輸入框離可見範圍很遠 | 中（版面） | 欄位與選項上緣對齊，可見範圍改為可換行橫排（`MemberDirectory.css`）。桌面頁高 3382→2773px，手機 4373→3711px | `probe-before/desktop-account.png` 對照 `probe-after/` |
| 5 | 我的名片 | 公開範圍規則在表單前後各說一次，內容大半重複 | 低（冗長） | 合併成一段，綁定到每個可見範圍 fieldset（`aria-describedby`）。「好友須雙方接受、小隊與公會依有效成員關係、社群帳號未驗證、平台公開涵蓋所有已登入會員」全部保留；勾「平台公開」時的就地說明也保留 | 同上 |
| 6 | 我的名片 | 自己的名片顯示「沒有對你公開的社群連結」；本人本來就看得到自己的全部連結，這句話會誤導 | 低（標籤） | 本人檢視時改為「尚未新增社群連結。」（伺服器 `visibleSocialLinks` 對本人回傳全部連結，已核對） | E2E |
| 7 | 我的名片 | 表單下方有一顆與個資無關的「前往技能書架」 | 低 | 移除。側欄導覽仍可到技能書架 | 截圖 |
| 8 | 小隊集合 | 「查看小隊」或成立後，詳情出現在清單下方，焦點停在原地，手機上看不到也無法用鍵盤接續；「收起」也不會把焦點送回 | 中（鍵盤／完成動作） | 開啟或成立後焦點移到詳情標題，收起時焦點回到觸發按鈕。按鈕名稱改為「查看{小隊名}」以便辨識 | E2E |
| 9 | 小隊集合 | 空狀態有第三顆「新增小隊」（頂部已有「成立一支小隊」，下方就是表單），另外顯示無意義的「0 / 0 支小隊」 | 低（冗長） | 空狀態改為標題加一句提示；沒有小隊時不顯示計數 | `mobile-squads.png` |
| 10 | 職業公會 | 載入失敗或操作失敗的 alert 沒有 banner 樣式，重試按鈕是沒有樣式的原生按鈕 | 低 | 加上 `banner banner-error` 與 `btn btn-ghost` | E2E（模擬 503） |
| 11 | 我的定位 | 結果區在 h2 之下直接用 h4 | 低（a11y） | 改為 h3，並同步 CSS | E2E |
| 12 | 會員首頁 | 名片讀取失敗時只說「請重新整理」，頁內沒有重試；載入中也沒有任何狀態 | 中（錯誤復原） | 載入中在名片摘要顯示「正在載入名片…」（`aria-busy`）。失敗時只顯示暱稱（來自登入 session），不顯示「主要公會」或「尚未設定主要公會」，也不顯示空的能力區；錯誤 alert 內附「重新載入名片」按鈕。每按一次只送一個請求，不自動重試；等待時按鈕改為 `aria-disabled` 並保留焦點，成功後焦點移到名片摘要。晚到或被新請求取代的回應都會被丟棄，離開頁面後也不寫入。常用入口始終可用。技能名稱標籤讀取失敗時照舊退回原值，不產生 alert。沒有改 API | `followup/audit-screenshots/phone-home-card-error.png`、`phone-home-card-recovered.png`；E2E（模擬 503→重試） |
| 13 | 小隊集合 | 上一輪把最長 80 字的小隊名塞進每張卡片的按鈕，與卡片標題重複 | 低（冗長） | 按鈕可見文字回到「查看小隊」，無障礙名稱仍是唯一的「查看{小隊名}」。開啟後焦點進入詳情、收起後回到按鈕，行為不變 | E2E |
| 14 | 定位第 3、4 步（桌面） | 桌面把 22 類能力、56 個子類全部展開，1440×900 第 3 步頁高 10,118px，第 4 步 3,942px；手機卻是全收合，兩種寬度行為不一致，而且縮放視窗會把使用者自己打開的分類全部關掉 | 中（冗長、狀態遺失） | 所有寬度一開始都是收合的分類清單，分類標題顯示「已選數 / 總數」、子類顯示「N 已選」。展開仍用按鈕（滑鼠或鍵盤）。移除依寬度切換的邏輯，縮放不再改動展開狀態。搜尋時自動展開符合的結果；搜尋中另外開合不影響原本狀態，清除搜尋後回到使用者自己打開的分類。已勾選項目與精選能力都保存在上層，收合、搜尋、縮放、上一步都不會遺失。第 3 步 10,118→3,280px，第 4 步 3,942→1,968px；手機維持 3,646px 與 2,226px | `followup/tree-before/`、`followup/tree-after/`（1440×900 與 390×844 全頁截圖＋`report.json`） |

檢查過但沒有問題：兩種寬度的註冊、登入、首頁、公會、成員視窗和定位各步都沒有橫向溢出；公會卡片視窗的 Esc 與焦點返回已由既有 `guild-organization.spec.ts:80-82` 覆蓋並通過；手機表單字級不小於 16px（`smallInputs` 只在桌面列出 14px 的小隊搜尋）。

## 4. 不在本輪編輯範圍，建議由 root 處理

- `App.tsx` 登入／註冊頁：除了故事區的 h1，表單區還有 `<h2>自由工坊</h2>`（`.login-brand`），接著又是 `<h2>登入</h2>`，同一頁有兩個平行 h2，其中一個只是品牌字。建議把 `.login-brand` 的 `h2` 改成 `<strong>` 或 `<p>`，保留視覺。
- `SkillBookIntro.tsx`／`SkillBookCard`：定位完成頁在 h1 下直接出現 h4（如「供應端工作台」）。建議加上 heading level 參數，或在該頁改用 h2／h3。
- `DevelopmentContext.css`：`summary`「參與這一頁的開發」高 32px，低於 DESIGN.md 要求的 44px 觸控目標。建議加 `min-height:44px`。

## 5. 真正的未來缺口，不是回歸

以下都已對照程式確認尚未實作，畫面也沒有把它們偽裝成已完成；本輪沒有新增這些功能：

- 首頁「我需要幫助／我能提供協助／我們正在一起做」三個互助入口，以及跨模組的 Now／Next／Gained 投影。`MemberHome.tsx` 只有名片摘要、常用入口與四個模組入口。
- 跨模組的容量與實益觀察。work 模組已經有 `participation_terms`、認領時的條款摘要比對、`review_capacity` 狀態與 `work_benefit_observations`，這些**已實作**，不屬於缺口。缺的是小隊、公會與首頁層級的容量與觀察，目前沒有對應的資料表或 API。
- Rank／Office／ModuleStewardship 的 UI。`positioning_profession_memberships.rank` 只允許 `runner`（migration 002）。現有的只有公會長任命（`positioning_guild_officers`）與最多三位專家標章。
- XP 投影。程式裡沒有 XP 或等級欄位。
- Squad 共同目標週期、結束與移交。目前有成立、申請、隊主接受與退出。
- ORG-02 的 WorkIntent revision 與 SkillPackage equip。程式沒有 `work_intent` 或 SkillEquip。定位的「裝備」（工具名稱）和規格裡的 `SkillEquip` 同名不同義，將來實作時要換掉其中一個用詞。
- FND-01／02 的 contract tests。FND-01 指定的 `docs/platform-plan/contracts/tests/test_fnd_01_contract_baseline.py` 不存在。
- 「先 Star 才領書／推廣」：使用者已明確提出這項要求，目前尚未實作。領書與加入公會都不檢查 Star；站內 Star 只在本人明確點選單一 repo 時執行。需求措辭由 root 在計畫文件中處理。

## 6. 驗證

隔離環境：一份未追蹤的 harness，放在 `tests/.e2e-4321/`（提交前已刪除）。Playwright 伺服器跑在 `127.0.0.1:4321`（沒有使用 `PORT` 環境變數，因此用預設值），使用本機 Docker PostgreSQL（`127.0.0.1:54339`）中每次新建的 `fp_e2e_<uuid>` schema，結束時 drop。沒有連 staging、public 或真實會員 DB。runtime 測試各自建立 `fp_*_${pid}_${time}` schema。

- `npm run typecheck`：通過。
- `npm run build`：通過（瀏覽器測試前都先 build）。
- 修正前 baseline：11 個相關 spec，`46 passed (1.4m)`。
- 新 spec 在**原始碼**上：7 個全部失敗，而且都失敗在各自的斷言（重測殼層重複、名片 `aria-describedby`、小隊焦點、公會重試樣式等），證明測到的是真實缺陷。
- 修正後 E2E：`audit-identity onboarding-members onboarding-recovery member-directory social-links guild-members guild-organization navigation-audit positioning-modules avatar workshop-design journeys modules-beginners`，結果 `56 passed (1.7m)`。
- runtime：`tsx --test tests/runtime/{onboarding,identity-member,member-directory,social-links,guild-preferences,positioning,guild-experts}.test.ts`，結果 `tests 91, pass 91, fail 0`。
- `not_run`：`npm run test:contracts`、`test:repos`，以及全量 `test:e2e`／`npm test`。這些超出本輪修改範圍，由 root 做整合時再跑。

### 後續輪次（§3 第 12–14 項）

使用同一種隔離方式：未追蹤的 `tests/.e2e-4321/`，內含改成 4321 埠的伺服器與 Playwright 設定，以及把測試裡寫死的 `Origin: 127.0.0.1:4311` 換成 4321 的 spec 副本。提交前已刪除，全域 config 與 `scripts/e2e-server.ts` 沒有修改。每次瀏覽器測試前都先 `npm run build`。

- `npm run typecheck`、`npm run build`：通過。
- 新增與改寫的斷言在**原始元件**上：4 個測試失敗，都失敗在新斷言上：桌面第 3 步有展開的分類、「查看小隊」可見文字、錯誤訊息仍要求重新整理、桌面分類預設展開。手機版 identity 測試在原始碼上通過，因為手機本來就是收合的。
- `onboarding-members.spec.ts` 的「skill trees」測試不再假設桌面全部展開，改為驗證以下行為：1440×900 時所有分類收合、頁高低於 4,500px；用滑鼠和鍵盤展開分類並勾選；用搜尋勾選收合分類裡的項目，清除搜尋後回到原本打開的分類；縮放到 390 再回到 1280 時，已勾選項目、精選能力與打開的分類都保留；按「上一步」回來後也都保留。
- 修正後 E2E：`audit-identity onboarding-members onboarding-recovery member-directory social-links guild-members guild-organization navigation-audit positioning-modules avatar workshop-design journeys modules-beginners` 共 57 個測試，`56 passed (1.8m)`。唯一失敗的是 audit-identity 桌面測試的第一張登入頁截圖，Chromium 回報 `Page.captureScreenshot: Unable to capture screenshot`，發生在任何受測程式執行前。單獨重跑 `audit-identity.spec.ts`：`8 passed (40.4s)`。
- runtime 91 個測試沒有重跑：這輪只改前端元件與 E2E，沒有動 API 或資料層。
- `not_run`：`test:contracts`、`test:repos`，以及全量 `test:e2e`／`npm test`，由 root 在整合時執行。
