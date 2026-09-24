# 原作、版本與貢獻歸屬

日期：2026-09-23。網站與 Agent 導覽改為原作優先；以下另外標明尚未實作的版本登錄與權限規則。部署狀態以交接為準。

使用者決定：工坊協助作者發展作品，保留作者對自己 repo 的管理、原作身分與貢獻 credit。不能藉上架、入公會、Fork、App 安裝或離會，把個人原作轉成平台所有。

## 預設共創流程

```text
原作者的 repo ── Fork ──→ 貢獻者自己的 repo／工作分支
      ↑                         │
      └── 原作者審查、決定合併 ←── PR

原作者的 repo ── Fork ──→ 工坊整合工作區（選用）
      ↑                         │
      └── 可回用的改進 ←──────── PR
```

- 主入口為「開啟原作」「Fork 原作」「從原作開始共創」「查看原作 PR」。工坊版本清楚標為「工坊整合版本」，不以含糊的「共創版本」取代原作。
- 原作變更預設以原作 repo 作 PR 的 base，由原作維護者決定是否接受；建立 fork、向 fork 提 PR、合併到工坊，都不代表已回饋原作。
- 原作者修改自己的專案時可直接開工作分支，不需要 Fork 自己的 repo。
- 工坊自己的整合／教學／平台 adapter 可在工坊 fork 開發。保留原作 commit 歷史、來源與授權，記錄 upstream PR、待回送／已回送／已合併／原作未採納或不適用。不能把工坊審查通過寫成原作者已接受。
- 既有工坊 Issue URL 與 PR 留在原處，不修改 URL 假裝成原作的歷史紀錄。向原作提案時以普通連結引用工坊 Issue；避免使用誤關閉原作同編號 Issue 的關鍵字。
- 直接從原作 Fork 是清楚的預設；同一 fork network 中的其他 fork 亦可向上游提交 PR。真正的回饋依據是 PR 的 base repository、審查與合併事實，不是按鈕文字或 Fork 的層數。[GitHub：從 fork 建立 PR](https://docs.github.com/en/pull-requests/how-tos/create-pull-requests/creating-a-pull-request-from-a-fork)

## 版本保存

原作者 repo 繼續保存原始碼歷史、release 與貢獻規則。工坊上架指向明確版本，不要求轉移 repo，也不為每次上架建立一份無來源的新 repo。

既有投稿會固定來源 commit 與授權觀察。下一步的完整版本登錄應保存以下欄位；這是待實作的契約方向，不代表全部欄位目前已有資料表／API：

| 資料 | 用途 |
| --- | --- |
| 原作 provider repo ID、當時網址 | repo 改名後仍能追溯；帳號／repo 擁有者不自動等於全部著作權人 |
| 原作 full commit SHA | 本次上架的不可混淆版本；不要只記可移动的 branch 或 tag |
| 作者提供的 release／tag | 人可讀的版本名稱，另外固定其對應 SHA |
| 工坊收錄 revision、manifest／artifact digest | 記錄工坊採用哪個版本，與原作者的版本號分開 |
| 原作 LICENSE／NOTICE 及版本來源 | 保留授權證據、第三方來源及作者聲明，不把收錄當作改授權 |
| 衍生 repo ID、parent／source、base SHA、衍生 head SHA | 重現工坊改了什麼，以及與原作的關係 |
| PR URL、作者／共同作者、review、merged SHA | 分別證明提案、實際修改、審查與合併，不推定已發布 |

作者發布新版後，工坊可提示有更新；每次採用形成新收錄 revision，舊版來源與驗證記錄保留。版本回退切回既有 revision，不改寫作者 Git 歷史。若授權允許且需要可重現保存，可另外保存附來源的版本 artifact；不能宣稱只保存一個 commit URL 就已完成異地備份。

## 著作權、專案聲望與個人貢獻

- **作品權利**：保留原作及其他權利人的授權與聲明。Fork／收錄不要求著作權移轉、排他授權或 repo 轉移；App 的技術存取許可不能被當成這些同意。公開可讀也不等於取得任意重用權。[GitHub：授權 repository](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/licensing-a-repository)
- **原作聲望**：主要來源、原作 Star 與專案 Fork 入口指向原作；GitHub 各 repo 的 Stars 不相加、不宣稱工坊 fork 的 Stars 自動轉給原作。
- **共同貢獻**：新增修改屬實際貢獻者的工作，原作者與後續貢獻者分別列示；不把後續修改全改署名為原作者或工坊。
- **Git 身分**：保留真實 commit author／共同作者，維護者與工具的 committer 身分照實呈現。不得為了 credit 冒用別人的姓名／email；GitHub 個人貢獻需符合 GitHub 的帳號、email、分支、repo 等計算條件，不能保證每個 fork commit 都有綠格。[GitHub：貢獻判定](https://docs.github.com/en/account-and-profile/reference/profile-contributions-reference)
- **平台角色**：站內標示收錄、公會指定、測試或協作組織者；沒有相應事實，不把平台列為原作者。來源不明就標未驗證。
- **離會**：工坊發出的未來操作授權可撤銷，原作者的 GitHub repo、既有署名與貢獻紀錄不因此被平台接管。已公開且合法散布的 fork 也不能保證隨離會消失。

## 這輪核對與程式範圍

2026-09-23 透過 GitHub public repository API 讀取 11 個既有工坊衍生 repo，全部確認 `fork=true`，`parent` 與 `source` 均指向登錄的 Hao0321 或 teddashh 原作：

`ai-media-generator`、`ai-security-scanner`、`ai-short-drama`、`AI-Sister`、`claude-skill-social-post`、`Hao0321-Studio-WEB`、`multi-ai-chat`、`multi-ai-chat-desktop`、`pos-pro`、`typo-studio`、`video-autopilot-kit`。

核對結果、repo ID、parent、source 與日期保存於 [repository-guidance-index.json](./repository-guidance-index.json) 的 `fork_lineage`；分支為觀察快照，開始開發前仍需核對當下 HEAD。平台自己建立的原創 repo 保留原始來源，不捏造個人擁有者。

本輪修改會員技能介紹、公開 HTML／Markdown、Agent SKILL.md 與協作 JSON 的預設來源和 PR 路徑。原有任務及整合參考分開標示；未搬移、刪除、轉移任何 GitHub repo，未建立 PR 或重寫作者歷史。完整版本 ledger、credit 同步與自動回送 PR 仍屬後續實作。

協作 JSON 與開發地圖逐書新增 `contribution`，明確指定原作優先的 Fork／PR 目標。為相容舊資料，既有 `repository`／catalog `repository_url`、`fork_url` 仍保留工坊整合來源；新開發入口不得以它們覆蓋 `contribution`。原作自己的正式貢獻規則仍需即時閱讀。
