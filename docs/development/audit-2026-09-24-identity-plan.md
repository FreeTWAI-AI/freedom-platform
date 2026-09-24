# 身分、公會與計畫文件對齊稽核 · 2026-09-24

範圍：`docs/platform-plan/01`、`10`、`12`、`execution/human-foundation-plan.md`、`execution/specs/ORG-01`、`ORG-02`、`FND-01`、`FND-02`。基準 commit `8338a42`。依主辦者 2026-09-24 說明，公開站與 staging 已部署此 commit；repo 內沒有對應的部署 ledger，本文不另作部署證明。README、`00`／`07`／`08`／`09`／`11`、inventory 與歷史 verification 由總體計畫維護者（下稱 root）更新，本稽核未修改。

## 目前 beta 的實際子集（依程式核對）

| 主題 | 目前行為 | 依據 |
| --- | --- | --- |
| 新人定位 | 2026-09-23 起新註冊帳號 `onboarding_required=true`；完成封閉定位並選主要公會前，登入後的 `/api/v1/*` 會員 API 只放行 `onboardingAllowed` 白名單（session、登出、帳號、定位、入會／離會／主要公會與定位所需唯讀目錄），其他會員 API 不論讀寫皆 403。未登入可讀的公開路徑不受影響；Agent 投稿與開發 Bearer 路徑各自檢查同一狀態。舊會員欄位預設 `false`，不追溯。 | `modules/identity-membership/members.ts`、`apps/platform-api/src/app.ts` `onboardingAllowed`、`modules/skill-submissions/service.ts`、`modules/development-access/service.ts`、`migrations/005`／`006` |
| 公會與技能書 | 15 個公會、37 本技能書；入會即領該公會技能書，離會後已領書目保留。 | README、[公會分組](guild-library-layout.md) |
| 公會貢獻範圍 | `development-access` 的 `skill`／`platform` 私人開發提案 grant：只在持有適用公會資格、GitHub 身分與 repo 核對成立時有效；最後一個資格來源消失時由 DB trigger 在同一交易撤銷 grant 與衍生 key。不授予原作寫入、合併或部署權。 | `modules/development-access/service.ts`、`migrations/030`、[公會開發資格](guild-development-access.md) |
| GitHub 身分 | 以 provider 真實 user ID、App installation 與 repo ID 驗證；自填 slug、作者署名或按過安裝連結都不授權。 | 同上、[GitHub 連結](github-social.md) |
| 投稿 `skill.submit` | 一般技能候選草稿：已登入、帳號啟用且完成定位即可；不需特定公會。與公會範圍的開發提案 key（`development:propose`）互不通用。 | `modules/skill-submissions/service.ts`、[Agent 技能上傳](agent-skill-upload.md) |
| 站內技能書編修 | 修改既有技能書 metadata／內容（不是 `skill.submit`）須同時具備該書現行具名維護任命，以及 AI 開發公會（`guild_ai_vibe`）或 AI 導入與驗證公會（`guild_ai_field`）至少一個有效會籍。會籍不授予全公會編修權，`development:propose` 不轉成編修 token。離開最後一個符合公會即拒絕；另一符合公會仍在則保留；任命仍有效時重新入會恢復會籍條件，已撤銷的 API token 不恢復。公開書目、原作閱讀與一般 `skill.submit` 不變。此為本版實作要求：`8338a42` 只有具名任命檢查；公會會籍條件與 token 行為的 runtime 證據記錄於本版合併稽核，本文不登錄通過結果。 | `modules/guild-workspace/service.ts`、`migrations/023` |
| 原作與公開知識 | 原作署名、固定版本與授權保留；社群投稿 `official=false`。公開介紹、公開 repo 與 fork／PR 途徑不因離會鎖住。 | [原作歸屬](author-owned-collaboration.md)、[四位作者登錄](member-skill-registration.md) |
| Star | 本人明確點選單一 repo 才以本人授權執行；不批量、不因入會自動 Star、離會不自動 Unstar，不進 XP／rank／entitlement。產品方提出的「先按星才領書／推廣」尚未實作為 gate，也尚未決定。 | [公會開發資格 §新會員 GitHub 連結](guild-development-access.md#新會員-github-連結與-star-授權) |
| 基礎設施 | 公開站在 Castle loopback 經 Cloudflare Tunnel；本機 PostgreSQL、每日本機 dump，尚無異地備份或 managed PostgreSQL；staging 由 Cloudflare Access 限定。 | [公開站手冊](public-operations.md) |

未完成且不能由上表推定：正式簽章 ContractBundle、56 packages／9 repos／12 runtimes 全形狀、HA／PITR／KMS／HSM、inbox／job lease fencing、真實買家結帳、Seller 實收核實、GitHub webhook 對帳 worker、GitHub team／collaborator 權限授予與外部撤權。

## 本輪修正

| 文件 | 原矛盾 | 修正 |
| --- | --- | --- |
| `12` | 開頭覆寫說定位必填，§2 內文仍寫「不是新人必須完成的問卷」 | 內文改為現行必填定位，並保留「不以貢獻、收入、QC 為門檻」 |
| `01 §6`／`§9.1` | 定位列為可選三途徑 | 新會員一次必填；其後可自選加入其他公會；AI guided discovery 標為未實作 |
| `01 §3.1` | 缺公會貢獻範圍生命週期 | 補在會期間授予、離會撤銷、GitHub 驗證身分、原作與公開知識不受影響 |
| `01 §12` | `skill.submit` 只寫 `authenticated_user`；定位 gate 寫成僅限寫入並留有待決字樣 | 表格保留未來 canonical 條件；另列 beta 的帳號狀態前提（白名單外會員 API 讀寫皆拒）、投稿與開發提案分開，以及站內編修要求 |
| `01 §13` | 未提使用者的先 Star 要求 | 註明待決策，現行只做本人明示單次操作 |
| `ORG-02` | 排除定位強制、Given 跳過定位 | 改為新會員強制定位（白名單外會員 API 讀寫皆拒），保留 WorkIntent 本人確認；跳過路徑限舊會員 |
| `ORG-01` | 未列目前 beta 子集 | 補 dated 對應、公會資格撤銷與站內編修要求及 Given–When–Then |
| `FND-01`／`FND-02`／`human-foundation-plan` | 寫 repo、DB、部署、tests 皆不存在 | 分開寫出 beta 已有的部分與 formal Day 1／正式契約仍未建立的部分；checkbox 維持未勾 |
| `10` | 2026-09-23 進度 | 更新為 2026-09-24 適用範圍並連到本文 |

## 交給 root 的事項

- 正式 catalog：`docs/platform-plan/contracts/entitlement-catalog.example.yaml` 與 `01 §12` 表格的 `skill.submit` 仍為 `[authenticated_user]`。`01 §12` 已寫明定位完成是帳號狀態前提、不是 acquisition condition；catalog 需要以新版本明確收錄此前提（及站內編修條件），再同步 inventory。
- README、`09` 現況與 inventory 尚未列入 `8338a42` 部署與本稿連結。
- 「先 Star 才領書／推廣」需產品決策；現行只做本人明示的單一 repo 操作（見上表 Star 列）。
