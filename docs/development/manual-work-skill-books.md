# 手動登錄作品整理為社群技能書 · 2026-10-01

平台負責人說：「手動登錄技能包不應該被差別對待, 應該也把他們做成技能包, 也要幫它們畫圖, 登入成格式化的樣子」。三件作品原先只經「手動登錄作品」出現在開源頁，身分是社群候選作品。這次把它們做成與 `modules/community/community-author-skills.ts` 相同格式的社群技能書：導讀、100 則分享介紹、書封與功能示意圖、原作 repo 指引、上架時間。三本的 `guilds` 都是空的，沒有公會指定，也不發放技能書或開發授權。核對日期是 2026-10-01。平台沒有執行上游程式，也沒有安裝它們的依賴。

## 收錄

| 作者 | 原作 | PR 分支 | 核對版本 | 授權 |
| --- | --- | --- | --- | --- |
| jasonlee(J太郎) | [自動 Podcast 剪輯：訪談影片轉上架素材](https://github.com/Lee-unhn/video-to-podcast-toolkit) | `main` | [`2ea2f0e6f115`](https://github.com/Lee-unhn/video-to-podcast-toolkit/tree/2ea2f0e6f11533ec08cff4d9db3a46859ec7ed4f) | MIT（只涵蓋原始碼） |
| jasonlee(J太郎) | [AutoVtuber：表單生成 VTuber 模型](https://github.com/Lee-unhn/AutoVtuber) | `master` | [`1c4d045d5bf6`](https://github.com/Lee-unhn/AutoVtuber/tree/1c4d045d5bf602561953adfe914e033364131600) | NOASSERTION |
| 小艾老師 | [Coding Audit Harness：AI 寫的程式，驗過才算數](https://github.com/weiwei-alvin/Coding-Audit-Harness) | `main` | [`c4526624f655`](https://github.com/weiwei-alvin/Coding-Audit-Harness/tree/c4526624f65530c009c57b9add233b1060fa01df) | MIT |

作者欄用的是會員手動登錄時的社群顯示名稱，以及本人當時自述的作者關係。名稱沒有拿 GitHub 帳號再核對一次。開源頁上既有的登錄沒有改寫，這次也沒有編輯正式環境的會員資料。

兩位會員手動登錄時勾選的是「我同意讓社群會員看見作品介紹與來源關係」；技能書頁面則對外公開。平台負責人於 2026-10-01 核可這三本技能書以會員的社群顯示名稱公開署名。

導讀沿用技能書的欄位：適合誰、目前限制、做得到的事、開始前要備什麼、第一個小步驟、第一個具體結果、可以怎麼回饋原作。分享介紹各 100 則，連結由分享介面另外附上，句子裡不放網址。

## 使用邊界

- 自動 Podcast 剪輯：轉錄在本機以 Whisper 執行。標題、金句、文案與字幕校對會把文字送到 Google Gemini API，免費額度有限。音檔預設不足 30 分鐘會自動補長，可調整 `min_duration_sec`。MIT 只涵蓋原始碼；品牌素材、字型、來賓照片與第三方工具依原作 `NOTICE.md` 各自授權，repo 不附。
- AutoVtuber：Repo 沒有 LICENSE 檔。README 標示 MIT，但原作發佈文件記載程式授權仍待作者決定，因此收錄為 NOASSERTION，重用或散布前先向作者確認。Repo 不附可用於產品的 VRM 底模；原作發佈文件判定 VRoid AvatarSample 不可作角色建立服務的產品底模，預設會阻擋生成，需自備或另行取得授權的 VRM 0.x 底模。原作者 2026-07-12 在 `AUTOVTUBER.md` 記錄將轉向使用者自捏 VRoid 底模、AI 只產生貼圖的路線，本書介紹的是固定版本現有的表單流程。
- Coding Audit Harness：不是沙箱。同一個使用者仍能修改 state、測試與收據，雜湊只檢查新鮮度，不是簽章。Runner 從 TICKETS 階段才強制；DISCOVERY 與 SPEC 只靠 agent 自律。它不呼叫 LLM，也不判斷程式品質。

## 圖像

六張圖各自以 builtin-imagegen 獨立生成，之後只經 sharp 調整尺寸並編成 WebP。書封：

- `apps/portal-web/public/art/skills/video-to-podcast-toolkit.webp`
- `apps/portal-web/public/art/skills/autovtuber.webp`
- `apps/portal-web/public/art/skills/coding-audit-harness.webp`

功能示意圖：

- `apps/portal-web/public/brand/skill-illustrations/video-to-podcast-toolkit.webp`
- `apps/portal-web/public/brand/skill-illustrations/autovtuber.webp`
- `apps/portal-web/public/brand/skill-illustrations/coding-audit-harness.webp`

提示詞、尺寸與雜湊記在[書封 manifest](../design/skill-book-art-manifest.json)與[功能示意 manifest](../design/skill-illustration-manifest.json)。圖像是工坊導讀插畫，不是原作產品截圖，也不是人物頭像。

## 上架

`migrations/070_manual_work_skill_books.sql` 接在 main 的 065–069 之後，`deploy/cloudflare/environments.json` 的 `migrations.last` 也改成 70；如果合併前 main 又先加了 migration，要再重編這個檔案和數字。檔案只新增三筆 `skill_publications`，衝突時不覆寫既有上架時間。沒有 `member_skill_book_grants`，也沒有開發授權。

## 驗證入口

目錄與導讀：`tests/runtime/member-skill-registration.test.ts`、`skill-book-guides.test.ts`、`skill-book-upstreams.test.ts`、`skill-collaboration.test.ts`、`development-map.test.ts`。分享介紹：`tests/runtime/skill-share-content.test.ts`。書架：`tests/e2e/skill-book-library.spec.ts`、`tests/e2e/audit-skills.spec.ts`。部署腳本的本數期望寫在 `scripts/verify-public.mjs`；本輪只改期望，沒有執行該腳本，也沒有對公開站送出請求。
