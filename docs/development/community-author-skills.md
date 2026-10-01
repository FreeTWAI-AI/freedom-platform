# 社群原作技能書與名片更新 · 2026-09-24

新增 8 本技能書，目錄共 37 本、repo 指引共 43 個。每本有原作者署名、固定來源版本、入門說明、共創 Agent 指引、100 則分享介紹，以及各自生成的書封與功能示意圖。

| 作者 | 原作 | PR 分支 | 核對版本 | 公會 |
| --- | --- | --- | --- | --- |
| 綠豆 | [領標雷達：標案與補助設計](https://github.com/greenQQQ/bidding-radar-concept) | `main` | [`a02db6cb6ef7`](https://github.com/greenQQQ/bidding-radar-concept/tree/a02db6cb6ef754bff3622e88eb10167cf772ca72) | guild_opportunity_partnership、guild_ai_field |
| 隊長 | [小主腦：本機 AI 任務系統](https://github.com/zaxardery8011-design/aiwff-runtime) | `master` | [`8d3eabf0cb61`](https://github.com/zaxardery8011-design/aiwff-runtime/tree/8d3eabf0cb614f74b6c1d3a0b9316e5c9f2fcc19) | guild_ai_vibe、guild_ai_field |
| Yuri | [n8n 行銷自動化模板](https://github.com/YuriCrystal/n8n-marketing-flows) | `main` | [`46c8e2535430`](https://github.com/YuriCrystal/n8n-marketing-flows/tree/46c8e2535430ebe1e9bb4d8b6b335465c4702ffb) | guild_marketing、guild_ai_field |
| 阿軒哥哥（阿軒割割） | [反詐投資王：交易統計與驗證](https://github.com/mars-tw/anti-gambling-trader-tw) | `main` | [`9d938b64c80e`](https://github.com/mars-tw/anti-gambling-trader-tw/tree/9d938b64c80ee29363aed496ba4e61d9110a7222) | guild_ai_field |
| 阿軒哥哥（阿軒割割） | [裂潮卡牌：網頁卡牌遊戲 Skill](https://github.com/mars-tw/web-card-game-skill) | `main` | [`d690b88ea233`](https://github.com/mars-tw/web-card-game-skill/tree/d690b88ea23333d53d9126c51127ded6b24b4927) | guild_ai_vibe |
| Yuri | [會說話的網站虛擬人](https://github.com/YuriCrystal/ai-avatar-bot) | `main` | [`d9276a227ea3`](https://github.com/YuriCrystal/ai-avatar-bot/tree/d9276a227ea342eebfb9967f9245256406de7d23) | guild_ai_vibe、guild_member_operations |
| 綠豆 | [AI 漫畫圖片翻譯](https://github.com/greenQQQ/ai-manga-translator) | `main` | [`964734a9366b`](https://github.com/greenQQQ/ai-manga-translator/tree/964734a9366b872b4c7ac2069be72124eb3d332e) | guild_ai_field、guild_media_automation |
| 隊長 | [LINE 影分身](https://github.com/zaxardery8011-design/line-persona) | `master` | [`8b44f432a8b8`](https://github.com/zaxardery8011-design/line-persona/tree/8b44f432a8b8e847c7164290f656bcca9164aaec) | guild_member_operations、guild_ai_field |

作者社群名稱由平台負責人提供，不據此認證會員帳號或授予開發權限。Star、Fork、原作與預設 PR 目標都保留在作者 repo；隊長的兩個專案使用 `master`。平台未建立替代原作的 fork，也未執行上游產品或開通外部服務。

## 使用範圍

- 領標雷達僅提供 MIT 概念與設計文件，沒有可安裝程式。標案來源包含 g0v 整理的搜尋 API、政府公開決標與補助資料；不得把全部來源當成官方 API。補助數量與資格依實際公告，不承諾固定 160 筆或核准結果。
- 小主腦先以不需 key 的 mock 模式驗流程；真實 Claude CLI 與 Telegram 需本人設定，可能傳送資料及產生費用。作品頁由作者提供：[小主腦](https://zax.com.tw/minibrain)。
- n8n 模板分本機版、通用版與 skeleton；上游描述與 README 的總數不同，因此不把模板數硬編為使用承諾。待設定節點不表示真實平台發布已通過驗證。
- 反詐投資王提供統計與反詐輔助，程式生成預設 PaperBroker。新手練習使用合成紀錄，不提供選股或獲利承諾。
- 裂潮卡牌遊戲執行期為原生網頁；開發、測試及可選 AI 美術服務另需工具與設定。
- 語音虛擬人自有程式採 MIT，但 LICENSE 明確排除第三方資產，包含 Live2D Cubism Core 與 Haru 模型。GitHub 的自動 license 偵測為 NOASSERTION，本次依 LICENSE 本文記錄自有程式 MIT。作者提供的 [Demo](https://ai-avatar-bot-two.vercel.app/) 未在本輪驗證互動功能。
- 漫畫翻譯使用自己的雲端或本機看圖模型；雲端可能傳圖與計費，翻譯品質需人工核對。
- LINE 分身的訊息仍經 LINE，選雲端模型時也會傳送問答資料。只依原作文件引導本人設定，不代管 token 或聲稱完全離線。

Migration 033 保存本次上架時間，補領符合目前有效公會關係的新書。停用會員與已離會關係不補領，重跑不更改原領取日期，沒有新增同意、職稱或開發授權。

## 名片

「我的名片」可編輯「社群顯示名稱」，提示使用社群最常用的名字。名稱更新沿用原會員帳號，不更改登入 email；會員名冊、名片及後續 session 讀取新名稱。

新增「我是（選填）」：男、女、外星人、AI，或不顯示。這是本人自選的名片標籤，不推斷、驗證或自動替舊會員填寫。選擇後與名片一起供同社群符合資格的已登入會員查看，匿名訪客無法讀取。

Migration 032 在 `member_accounts` 加入 nullable `identity_label`。`GET /me/account`、會員名片與名冊回傳欄位；`POST /me/account` 接受 `male | female | alien | ai | null`，省略則保留現有值，`null` 清除。與名稱及聯絡方式共用版本控制、CSRF、本人權限與原有冪等流程，無效值回傳 422，舊版本回傳 412。

## 圖像與驗證入口

使用內建 imagegen，16 次獨立生成；僅以 sharp 調整尺寸並編碼 WebP。8 張書封位於 `apps/portal-web/public/art/skills/`，8 張功能示意圖位於 `apps/portal-web/public/brand/skill-illustrations/`。完整提示詞、來源、尺寸與雜湊見[書封 manifest](../design/skill-book-art-manifest.json)與[功能示意 manifest](../design/skill-illustration-manifest.json)。圖像是工坊導讀插畫，不是原作產品截圖或人物頭像。

相關檢查入口：`tests/runtime/member-skill-registration.test.ts`、`identity-member.test.ts`、技能書及協作測試；`tests/e2e/onboarding-members.spec.ts`、名片、夥伴名冊及書架測試。部署時 `scripts/verify-public.mjs` 使用獨立合成會員驗證新書、名稱及自選標籤，完畢停用合成帳號並撤銷 session。

## 2026-10-01 · Open SEO Advisor

上架阿軒哥哥（阿軒割割）的 [Open SEO Advisor：SEO 健檢與建站顧問](https://github.com/mars-tw/open-seo-advisor-skill)。原作 `mars-tw/open-seo-advisor-skill`，預設分支 `main`，不是 fork，授權 Apache-2.0。收錄版本 [`f6178d797b45`](https://github.com/mars-tw/open-seo-advisor-skill/tree/f6178d797b45705b5b77f83507366a72eac34bde)（上游 v0.5.0，2026-09-23）。平台核對日是 2026-10-01。本輪只讀該 commit 的 README、SKILL、QUICKSTART、LICENSE 與模式文件，沒有執行上游 CLI、產圖或部署。

成長與行銷公會（`guild_marketing`）指定這本書。指定理由：書的用途與第一步都在練習這個公會自己的工作，也就是離線網站健檢、依計畫套用並保留備份的技術修復，以及搜尋友善的內容整理。第一步是閱讀 QUICKSTART，再對自己的網站原始碼或範例資料夾跑一次離線檢查。這一步不是 AI 公會的驗證練習，所以只由成長與行銷公會指定。加入該公會會領到這本書。Migration `060_open_seo_advisor_skill.sql` 寫入上架時間，並為目前有效會員、且 `guild_marketing` 會籍仍是 active 的人補領。停用會員與已離開的會籍不補領。重跑不改既有領取時間，也不新增同意、職稱或開發授權。

使用邊界照原作文件。CLI 提供離線網站骨架與技術檢查；完整網站仍要由 agent 依品牌實作頁面、內容、功能與圖像。CLI 不呼叫 GPT、不產圖、不建立支付後端、不部署。`website check` 的 `baseline_ready` 只是離線技術基線。GPT 產圖與託管（Cloudflare、Firebase Hosting、GCP Cloud Run）使用會員自己的帳號，可能產生費用，免費額度由會員自行查核。兩個線上示範維持 `noindex`，是故事網站，不是搜尋成效。不保證排名、收錄、流量、AI 搜尋引用、銷售或詢問。

書封 `apps/portal-web/public/art/skills/open-seo-advisor.webp`（768×512），功能示意 `apps/portal-web/public/brand/skill-illustrations/open-seo-advisor.webp`（1200×630）。兩者由內建 imagegen 產生後，只用 sharp 以 contain 編成不透明 WebP。提示詞、來源路徑、尺寸與雜湊見[書封 manifest](../design/skill-book-art-manifest.json)與[功能示意 manifest](../design/skill-illustration-manifest.json)。圖像是工坊導讀插畫，不是原作產品截圖。

目錄現為 38 本技能書、44 個 repo 指引。上文 2026-09-24 記載的 37 本與 43 個指引是當天的結果。
