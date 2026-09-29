# 原作、版本與貢獻歸屬

日期：2026-09-23。網站與 Agent 導覽改為原作優先；以下另外標明尚未實作的版本登錄與權限規則。部署狀態以交接為準。

使用者決定：工坊協助作者發展作品，保留作者對自己 repo 的管理、原作身分與貢獻 credit。不能藉上架、入公會、Fork、App 安裝或離會，把個人原作轉成平台所有。

## 技能書是導覽，不是作品副本

已有作者作品時，技能書記錄作者、原作、核對版本、使用方式和協作入口，讓讀者前往作者維護的產品或 repo。工坊自己從頭創作的手冊／工具則以工坊原創 repo 為原作；Ted 等工坊成員已持有的產品仍以本人原作為準。新增第三方技能書不因收錄而建立工坊 fork。

- 原作者 repo 是技能書的主要站點與主要按鈕；作者網站或展示頁只作補充說明。網站連結不等於已驗證可下載或可立即使用，須依原作發布狀態描述。
- 閱讀固定來源 commit 的指南可保留教學可重現性；Star、產品下載、安裝說明、問題回報和可回用的 PR 應回到原作者維護的入口。工坊協調任務可另外列出，清楚標明管理方。
- Fork 是開發時按需建立的工作副本；既有 11 個工坊 fork 可保留整合程式與 Issue／PR 歷史，作為次要入口，不作產品首頁、官方下載或原作的替身。
- 下一步為每本書分別登錄並核對「作品型態」（網站、桌面 app、Agent Skill、文件等）、「作者指定的使用／下載 URL」、「發布狀態」與核對日期。沒有已確認的入口時只連原作；不能從 repo 網址推測正式安裝包。現有 `introduction_url` 僅表示作者網站，不保證是可操作的 app。

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

## Repo 認領、共同開發與技能分類

Ted 指定原作 Repo 為主站點，並希望每個 Repo 顯示原創作者「認領」、共同開發者「加入」，以及公會指定／私人技能分類。這三件事分屬**作品身分、參與事實、展示與可見範圍**，不能由同一個「作者」或「官方」布林值推定。

### 原作者認領

每本技能書先保存**原作 Repo** 的 GitHub repository ID、目前 URL、fork `parent`／`source`、收錄 SHA 與現有來源署名。歷史工坊 fork 只能指回原作，不另開一個與原作者競爭的認領入口。Repo 改名後依 ID 延續；原作變更時要重新核對，不能把新 repo 自動繼承給舊認領者。

公開卡片可列「來源標示的作者：某人」及狀態：`尚未認領`、`認領審核中`、`已核實原作者`、`有爭議`。**來源署名與認領身分分開保存**；未認領時不顯示「已驗證」。一件作品可以有多位原創作者，也可由維護者代管，不能把 Repo owner 或收錄者直接當成唯一作者。

`認領這件原作` 的落地流程：登入工坊 → 連結 GitHub（站內已有 OAuth 與穩定 `github_user_id`）→ 選原作及角色（原創作者／共同原創作者／維護者）→ 提交可核對的證據與聲明 → 人工審核並留下審核者、時間、來源快照與理由 → 公開顯示已核實角色。可接受的證據包括 Repo 歷史／署名、原作維護者的確認，必要時請申請者以受控方式證明其對 Repo 的管理權。**Repo 寫入權只能證明目前管理權，不能單獨證明原創**；GitHub App 安裝、平台投稿或公會職務也不能代替作者證據。申請可撤回；申訴、多人共同作者、帳號變更與相互衝突的申請交人工審核。審核者不可審自己的申請。撤銷錯誤認領時保留審計紀錄，不重寫 Git 作者與授權。

建議資料契約：`canonical_repositories(provider,provider_repo_id,current_url,source_repo_id,observed_at)`、`repo_credit_claims(repo_id,member_id,github_user_id,role,state,evidence_url,submitted_at,reviewed_by,reviewed_at,reason,version)`。原作署名另以可多人的 `repo_credits` 保存來源與核對日期。唯一限制以「同一人、同一 Repo、同一角色的有效申請」為界；不要禁止多位共同原創者。公開 API 只回傳已核實顯示資訊及必要狀態，私人證據與審核理由不公開。這是待實作契約；目前 `oss_projects.relationship_verification=self_declared`，不能升格成已認領。

### 共同開發者加入

技能介紹的「加入共同開發」應帶會員進入既有開發任務：選適用公會、連 GitHub、閱讀原作貢獻指引、從**原作** Fork 到自己帳號、驗證工作 Repo，最後向原作提出 PR。已有原作寫入權的維護者可直接開分支。平台保留自己的提案與協作紀錄；原作維護者仍決定 Issue 分工、審查與合併。

點「加入」只表示有意參與；Fork 只表示建立工作副本；提交 PR 是提案；PR 被原作合併才是已接受的程式貢獻。公開 `共同開發者` 身分應由原作 Repo 的可核對 PR／commit 或維護者確認支撐，列出對應作品與貢獻，不把所有公會會員自動標成共同開發者。未有實際貢獻可顯示「參與中」，不可顯示「已貢獻」。工坊 fork 上的 PR 應另標「工坊整合貢獻」，不能冒稱原作已合併。

### 公會指定與私人技能

分類採兩個獨立欄位，避免把公開範圍與公會指定混在一起：

| 維度 | 值與公開顯示 | 權限來源 |
| --- | --- | --- |
| 可見範圍 | `private_draft`：「私人技能草稿」，僅本人可見；`public`：「社群投稿・公開」或一般公開收錄 | 投稿者明確按公開並同意分享；草稿不進公開 API |
| 公會指定 | 無：不顯示官方徽章；有：`[公會名稱]指定技能`，可多公會 | 現有公會技能綁定／日後的公會授權流程，不能由作者或投稿者自填 |

「公會指定」表示該公會選它作為學習／協作技能，**不表示原作者背書、作品歸公會所有、或具有平台官方產品保證**。對外文案採具名公會；若資料缺少公會名稱，退回泛稱並修正資料，不臆測名稱。若要讓新投稿成為指定技能，需公會有權人提出、審核與撤銷，紀錄誰在何時指定哪個 Repo／收錄版；公開投稿本身維持非官方。私人草稿不得因公會指定而公開；須先由本人發布。

### 實作順序與驗收

1. 本輪：原作 Repo 作主要入口；作者網站補充；具名公會指定徽章；公開個人投稿與私人草稿分開標示；「加入共同開發」接現有 GitHub/Fork 流程。保留現有 fork 的歷史，不刪除外部 Repo。
2. 認領：新增 Repo 身分與申請／審核資料表、會員申請 UI、審核 UI、公開狀態。測試同 Repo 多作者、惡意自填、Repo 改名／轉移、撤銷與申訴；完成後才上線「認領」按鈕。
3. 貢獻與指定：按原作 PR／commit 或維護者確認列共同開發者；公會指定改為有權限、可撤銷、帶版本的操作。測試 fork PR 與原作 PR 不混淆，個人投稿不會自動獲官方標記。

第 2、3 步需要資料遷移與審核職責，並非本輪 UI 標籤已經具備的功能。上線前仍需決定由誰處理有爭議的作者認領，以及公會指定是否只能由公會幹部提出。

## 這輪核對與程式範圍

2026-09-23 透過 GitHub public repository API 讀取 11 個既有工坊衍生 repo，全部確認 `fork=true`，`parent` 與 `source` 均指向登錄的 Hao0321 或 teddashh 原作：

`ai-media-generator`、`ai-security-scanner`、`ai-short-drama`、`AI-Sister`、`claude-skill-social-post`、`Hao0321-Studio-WEB`、`multi-ai-chat`、`multi-ai-chat-desktop`、`pos-pro`、`typo-studio`、`video-autopilot-kit`。

核對結果、repo ID、parent、source 與日期保存於 [repository-guidance-index.json](./repository-guidance-index.json) 的 `fork_lineage`；分支為觀察快照，開始開發前仍需核對當下 HEAD。平台自己建立的原創 repo 保留原始來源，不捏造個人擁有者。

本輪修改會員技能介紹、公開 HTML／Markdown、Agent SKILL.md 與協作 JSON 的預設來源和 PR 路徑。原有任務及整合參考分開標示；未搬移、刪除、轉移任何 GitHub repo，未建立 PR 或重寫作者歷史。完整版本 ledger、credit 同步與自動回送 PR 仍屬後續實作。

協作 JSON 與開發地圖逐書新增 `contribution`，明確指定原作優先的 Fork／PR 目標。為相容舊資料，既有 `repository`／catalog `repository_url`、`fork_url` 仍保留工坊整合來源；新開發入口不得以它們覆蓋 `contribution`。原作自己的正式貢獻規則仍需即時閱讀。
