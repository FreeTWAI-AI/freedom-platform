# 2026-09-24 大計畫對齊與全站 shell 審查（root）

> 這是各組執行當時的審查與分階段證據；最終合併、完整回歸與發布結果見 [整合總報告](./audit-2026-09-24.md)。
基線：`main` `8338a424a40ec959e9fc7e22ba77cce64192301e`。此 commit 已由 root 部署並驗證，來源是既有交接 `/home/ted-h/projects/Freedom-Platform/HANDOFF-CODEX-EIGHT-AUTHOR-SKILLS-PROFILE-2026-09-24.md`（staging deployment 6632758320、16 項 HTTPS 檢查；public deployment 6632891104、22 項 HTTPS 檢查；CI Verify run 35970930028）。本審查引用該交接，沒有重新部署或重跑那些檢查。本頁只負責 root 計畫與全站共用 UI；各頁內容由另外三組在各自 worktree 處理，報告為 `audit-2026-09-24-{identity,skills,operations}.md`。

## 1. 已完整閱讀

逐段讀完全文，不是只 grep 標題：

- `AGENTS.md`、`CONTRIBUTING.md`、`DESIGN.md`、`README.md`
- `docs/platform-plan/README.md`、`00-current-requirements-baseline.md`、`07-decisions-risks-traceability.md`（543 行）、`08-bootstrap-hosting-project-lifecycle.md`（766 行）、`09-handoff-record.md`、`11-operator-agent-narrative.md`
- `docs/platform-plan/verification/2026-09-17-tree-verification.md`、`verification/2026-09-19-revision-check.md`
- `docs/platform-plan/contracts/tests/fixtures/domain-skill-overlay/README.stage-1a.md`
- `docs/development/plan-drift-2026-09-23.md`、`guild-development-access.md`、`github-social.md`、`community-author-skills.md`、`member-skill-registration.md`（9/24 作者技能與名片說明）

## 2. 與 `/home/ted-h/projects/Freedom-Platform/docs/platform-plan` 的比較

| 檔案 | 鏡像狀態 | 判定 |
| --- | --- | --- |
| `README.md`、`00`、`07`、`08`、`11` | 2026-09-17 基線（標頭寫「現行 canonical baseline（2026-09-17）」）；缺 9/19 低維運修訂、`12` 連結、RQ-066–071、ADR-080–083 與 9/23 註記 | **鏡像落後**。本 repo 較新，不回寫 |
| `09-handoff-record.md` | 9/20 02:45 只更新了檔案清單；內文仍說「此 workspace 不是 Git repository」「九個 repo 均未建立」 | **鏡像落後且與現況矛盾**。本 repo 的 `09` 已記錄 9/20 查到九個 repo |
| `verification/2026-09-17-tree-verification.md` | 鏡像版列 86 個檔案（含 five-clocks fixtures）；本 repo 保留原 70 個檔案版本 | 兩者都是當時的歷史紀錄；本 repo 的 fixtures 已包含 five-clocks 等目錄。不合併 |
| `verification/2026-09-19-revision-check.md`、`12-low-ops-mutual-benefit.md`、stage-1a README | 鏡像沒有 | 只存在本 repo |

結論：鏡像只是舊快照，沒有任何內容比本 repo 新。root 已在舊 planning 目錄的兩個 README（`/home/ted-h/projects/Freedom-Platform/README.md`、`docs/platform-plan/README.md`）加入指向本倉的現行來源指標，歷史副本保留；此項已完成。**不能用鏡像覆蓋本 repo。**

## 3. 計畫與現況的真正矛盾

| # | 計畫說法 | 目前事實（證據） | 處理 |
| --- | --- | --- | --- |
| C1 | `README §1`、`00 §1.1 P9`／`§9`：帳號、repo、deploy 都不宣稱完成；「所有 test 均為未跑」 | 公開會員 beta 在運行（root 已部署驗證 `8338a42`，見上方交接來源）；本機有 runtime／E2E 測試 | 已在 canonical 加日期狀態區塊：「未跑」只適用目標架構與真人／provider 驗收，不適用已上線的 beta 子集。歷史原文保留 |
| C2 | ADR-006：LINE Login 是第一個登入 adapter | 使用者 9/23 明示只用 email 註冊，覆寫舊計畫；GitHub OAuth 只連結 Star 與開發身分，不是登入 | 已修正 `07` ADR-006 本文為現行 default（email 註冊），§1.4 同步；LINE Login 只是後續 adapter 需求，不再列為待決 |
| C3 | ADR-039／RQ-010：定位可跳過 | 9/23 起新會員必須完成封閉式定位（`app.ts:onboardingAllowed`） | 已在 `00` 標頭記錄；本輪在 `07` 補上交叉註記 |
| C4 | ADR-045／046、OD-01：GHEC＋Workers／Hyperdrive／PlanetScale | Beta 是 Node＋PostgreSQL＋Cloudflare Tunnel（`deploy/public`、`deploy/staging`） | 屬於「過渡拓撲」，不是目標被推翻；`08` 加狀態註記 |
| C5 | ADR-050、OD-17：dynamic token 透過 broker 與外部 KMS | GitHub user token 用 AES-256-GCM 加密，金鑰在環境變數（`GITHUB_SOCIAL_TOKEN_KEY`）；沒有 broker 或 KMS | 標為後續實作。不能宣稱已符合 ADR-050 |
| C6 | ADR-065／RQ-064：只允許本人真實的 Star | 使用者明確要求「先 Star 才能領書／推廣」，尚未落地；建議替代尚未獲同意 | 不把要求改寫成「沒有決定」。GitHub AUP §4 列有 rank abuse 與 incentivized inauthentic 相關條款，但沒有針對本案的裁定；本輪不做 gate；整合時已重新查閱官方條文，仍未將替代建議當成使用者同意 |
| C7 | `09 §3`：repos／帳號未建立 | 9/20 查到九個 repo；FreeTWAI-AI org 與 GitHub App 流程存在 | `09` 加 9/24 狀態 |

以下與計畫一致，不算矛盾：

- 公會開發資格：加入即取得資格，離開最後一個適用公會就撤銷。
- OAuth、App 安裝、工坊 key 分層。
- 原作 fork 與署名。
- 名片的自選身分標籤。

它們延續了 ADR-053（自助加入、不設審核）、ADR-058（有界 grant）、ADR-034（憑證不外流）與 `08 §8`（fork lineage）的方向。細節記在 `07` 的 9/24 增補。

## 4. 對齊表：目前可修／需外部證據／後續實作

| 需求 | 目前狀態與證據 | 分類 |
| --- | --- | --- |
| 技能書開發需加入 AI 開發（`guild_ai_vibe`）或 AI 導入與驗證（`guild_ai_field`）公會 | `modules/development-access/service.ts` 的 `developmentGuilds.skill`；migration 030 | 已實作；UX 由技能組審查 |
| 平台開發需加入平台開發公會（`guild_platform_engineering`） | `developmentGuilds.platform` | 已實作 |
| 入會即取得資格、離會撤銷；有其他資格來源時保留；舊 key 不復活 | 030 trigger；`guild-development-access.md` | 已實作；外部 GitHub 權限目前沒有授予，所以沒有東西需要撤回 |
| GitHub 身分 OAuth、App installation、細範圍工坊 key 是三層不同的東西 | OAuth PKCE user token（加密）；App 只有 `starring:write`＋`metadata:read`（`github-social/setup.ts`）；`fpd_` key 60 分鐘、scope 為 `development:propose` | 已實作。程式碼寫入用會員自己的 GitHub 授權，App 不寫程式 |
| Star／Fork／Follow／Watch | Star 由本人在站內操作；Fork／Watch／Follow 連到 GitHub 原作或作者（`github-social.md`） | 已實作；真實 Star 寫入需 repo 擁有者安裝 App，屬**外部必要證據** |
| 原作者 repo 與署名；共創從原作 fork | 37 本書、43 個來源 repo；Star、Fork、PR 都指向原作（`community-author-skills.md`、`author-owned-collaboration.md`） | 已實作。作者同意與授權確認屬外部證據（例如 David 的 repo 沒有 LICENSE） |
| 名片可選男／女／外星人／AI，社群顯示名稱可改 | migration 032；`POST /me/account` | 已實作；註冊欄位本輪同步改名為「社群顯示名稱」（見 §5 U6） |
| 站內技能書編修：需 AI 開發或 AI 導入與驗證公會有效會籍＋該書既有具名維護者任命；一般 `skill.submit` 投稿與公開閱讀不變 | 依使用者「能改技能書至少入 AI 公會」的要求；會籍與任命同交易讀寫、replay、離會鎖皆驗 | **已整合**。43 項相關 runtime、32 項相關 browser 通過；見 `skill-editor-guild-access.md` 與整合總報告 |
| 強制 Star 才能領書 | 使用者明確要求，未實作 | 尚未落地；建議替代尚未獲同意 |
| LINE／Discord bot、通知、陪跑 | 只有連結 | 後續實作 |
| Workers／Hyperdrive、R2 quarantine、KMS／HSM、signed channel、2-of-N | 沒有 | 後續實作。本輪不假裝已完成 |
| 收款、settlement、`authorized_mandate` | `money_movement_enabled=false` | 後續實作。必須先有 Seller／bank 的外部證據 |
| 找回密碼、寄信 | 沒有；註冊頁如實提示「目前無法用 E-mail 找回密碼」 | 本輪不新增實作（需要寄信 provider）；真實限制保留 |
| 真人互惠、北極星指標 | 只有自報資料 | 外部必要證據 |

## 5. 全站 shell UX 審查

方法：用 `scripts/e2e-server.ts` 在 4311 埠建立獨立的 `fp_e2e_*` schema，以 Playwright 實際操作 1280、1000、390、320 寬度。截圖在 `/tmp/freedom-audit-root-artifacts/`（`before-*`、`after-*`、`audit-shell-*`）。

| # | 缺陷與證據 | 嚴重度 | 修正 |
| --- | --- | --- | --- |
| U1 | 「跳到主要內容」連結原本位移 -40px，但它高約 44px，所以每頁頂端露出 3–4px 綠條（`before-shell-1280.png` 第一行有 106 個萊姆綠像素，修正後 0） | 中 | `LayoutDesign.css`：`.skip` 改用 `transform` 完全隱藏，取得焦點時才出現 |
| U2 | 手機登入時，表單排在品牌說明與 CTA 文案之後：390×844 的 email 欄位頂端在 649px；320×640 的登入鍵底端在 860px，超出畫面 | 高（回訪會員每次都要先捲動） | 手機版順序改為「完整 Logo → 表單 → 說明文案」，只改 CSS（`display:contents`＋`order`），DOM 與讀屏順序不變。修正後 email 頂端 496／477px。320×640 加上示範 banner 時登入鍵底端 677px；示範 banner 只出現在 local／staging |
| U3 | 示範帳號說明框沒有左右 padding，文字貼著框線（`before-login-390.png`） | 低 | `.login-card .help-box` 加 12px padding |
| U4 | 「會員登入／建立帳號」只用顏色表示目前選項，缺 `aria-pressed` 與群組標籤（違反 DESIGN「不依靠顏色表示」） | 中 | `App.tsx` 的 LoginView：加 `role=group`、`aria-label`、`aria-pressed` |
| U5 | DESIGN 規定觸控目標至少 44px；skip link 取得焦點時實測 42.39px，`.topbar-actions .btn`（≤860px）與 `.auth-switch button` 的 `min-height` 宣告是 42px。上一輪測試只驗 42px，是錯的 | 中 | `LayoutDesign.css`：skip 改 `inline-flex`＋`min-height:44px`；topbar 與登入切換 `min-height:44px`。測試改為對實際渲染的 login 控制項、註冊控制項、focused skip、topbar、手機選單鈕、側欄／手機選單項目驗寬高 ≥44 |
| U6 | 註冊欄「喜歡的暱稱」與名片的「社群顯示名稱」不一致 | 低 | 改為「社群顯示名稱」，`aria-labelledby` 讓名稱精確等於標籤；簡短提示「建議使用大家熟悉的社群名字」以 `aria-describedby` 關聯，不算進名稱。註冊仍只有一個 email 欄。同步 `onboarding-recovery`、`onboarding-members`、`guild-members` E2E 與 `scripts/verify-public.mjs` |
| U7 | 登入頁冗詞：英文眉標 BUILD WITHOUT LIMITS、兩行標語＋一段說明、三行英文 01/DISCOVER…journey，表單上方又有 FREEDOM WORKSHOP／自由工坊小標與歡迎 lede，和 Logo 重複 | 中 | 保留完整原 Logo 與一句具體用途作為唯一 h1：「完成定位、加入公會、領取 Repo 技能書，和夥伴一起供貨、開店與做開源作品。」刪除英文眉標、journey、重複品牌小標與登入／註冊 lede。品牌圖不變；demo 說明、密碼限制、Email 不公開提示、開發指引與社群連結保留。中文片語不斷行（`word-break: keep-all`），桌機左 Logo＋句子、右表單；手機仍是 Logo → 表單 → 句子 |

確認正常、不需修改：

- 1000px 與 1280px 桌機：分組全展開時側欄可獨立捲動，也保持固定。
- 手機選單：可用 Esc 關閉、選頁後自動關閉、焦點移回主內容。
- Topbar 的「我的名片」與「登出」在 320px 仍在畫面內，實際高度 ≥44px（U5 後由測試固定）。
- 320px 與 390px 登入頁、註冊頁、工作區都沒有水平溢出。

保留不動：

- 註冊頁「目前無法用 E-mail 找回密碼」：這是真實限制。
- Email 預設不公開的提示。
- 示範帳號的虛構身分聲明。
- Logo 完整呈現。

## 6. 測試證據

第一輪（review 前）結果保留作歷史：audit-shell 9 passed、對 HEAD shell 5 failed／4 passed、navigation-audit＋workshop-design 7 passed。第一輪的觸控目標只驗 42px，已在第二輪修正。

第二輪（review 修正後，2026-09-24）；瀏覽器測試都在最後一次 `npm run build` 之後跑，輸出在 `/tmp/freedom-audit-root-artifacts/round2-*`：

| 命令 | 結果 |
| --- | --- |
| `npm run typecheck` | exit 0（`round2-typecheck.txt`） |
| `npm run build` | exit 0（`round2-build.txt`） |
| `npx playwright test tests/e2e/audit-shell.spec.ts` | **9 passed**（`round2-audit-shell-final.txt`）。覆蓋 1280／390／320 登入、註冊（1280／320）、錯誤登入、skip link、工作區 shell；驗單一 h1 與句子可讀（≥16px、可見）、無英文眉標／journey／重複小標、鍵盤 Tab 順序與 focus ring、實際渲染觸控目標 ≥44px、無水平溢出 |
| 同一 spec 暫時拿掉 U5 的 44px CSS（重新 build，跑完還原並再 build） | 1 failed／8 passed：focused skip link 實測 42.39px 被擋下。topbar 在舊 42px 宣告下實際渲染已 ≥44px（內容撐高），所以該項沒有失敗；44px 宣告仍補上避免之後回退（`round2-touch-against-42px.txt`） |
| `npx playwright test tests/e2e/navigation-audit.spec.ts tests/e2e/workshop-design.spec.ts tests/e2e/onboarding-recovery.spec.ts tests/e2e/onboarding-members.spec.ts tests/e2e/guild-members.spec.ts` | **24 passed**（navigation-audit 6、workshop-design 1、onboarding-recovery 4、onboarding-members 7、guild-members 6；`round2-adjacent-final.txt`） |
| 同上但 `FREEDOM_E2E_PORT=4391` | 22 passed、2 failed（`round2-adjacent-specs.txt`）：`onboarding-members` 兩項把 `Origin: http://127.0.0.1:4311` 寫死，換埠後 CSRF origin 不符回 403，與本輪修改無關；預設埠重跑 7/7 通過。寫死 4311 的 spec 還有 `skill-sharing`、`avatar`、`github-setup`、`modules-beginners`、`benefits`，平行 worktree 若改埠會遇到同樣問題（階段紀錄；其後已由 root 修成統一 `e2eOrigin()`／Playwright baseURL，完整整合結果見總報告） |
| `git diff --check` | OK |
| 全套 `npm test`、`npm run test:e2e`、`test:contracts`、`test:repos`、`verify:inventory` | **not_run**：依分工由 root 統一執行。文件已修改，舊 inventory hash 預期不符 |

## 7. 今日優先序與未完成

1. 修正已上線 beta 的可用性：本輪 shell 修正加上三組各頁審查，由 root 整合後跑全套測試。
2. 開發資格路徑（公會 → GitHub OAuth → App 安裝 → key）的 UX 由技能組負責；站內技能書編修的公會會籍＋具名任命要求已整合，證據見 `skill-editor-guild-access.md`。
3. 使用者明確要求但尚未落地：強制 Star gate（建議替代尚未獲同意）。找回密碼本輪不實作（需要寄信 provider），註冊頁的真實限制保留。LINE Login 只是後續 adapter 需求；現行 default 是 email 註冊，已寫入 ADR-006。
4. 後續架構（Workers、KMS、signed channel、金流）不在本輪範圍，也不宣稱完成。

本組沒有修改 `Workspace` 元件本體、各頁模組或 guild／service 等他組檔案。
