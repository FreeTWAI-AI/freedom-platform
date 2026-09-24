# 公會開發資格、GitHub 連動與授權生命週期

日期：2026-09-24。

狀態：公會開發啟用、GitHub Repo 驗證、私人提案 grant／key 與離會撤銷已實作；以下仍包含後續擴充契約。實際發布版本與環境以 deployment ledger 為準，不由文件推定已部署。

## 本輪實作範圍

技能書的「開發這本技能書」與頁面下方的「啟用這一頁的開發」共用任務視窗。未加入時提供相應公會選擇，不要求同時加入兩個 AI 公會，也不改主力公會。OAuth 返回可從分頁儲存的安全 capability／target 恢復任務；不存秘密。公開原作與 Agent 文件仍可閱讀。

`modules/development-access/` 實作 capability `skill`／`platform`，作用為保存本人指定目標的**私人開發提案**。不是原作寫入、合併、平台部署或既有技能書內容管理權。既有投稿 key、一般 `skill.submit` 及具名教材維護任命保持原契約。Agent 執行本機修改與 GitHub push／PR 使用本人另外提供的 GitHub 授權。

Migration `030_development_access.sql` 保存版本化同意、七日目標 grant、60 分鐘 key 與私人提案。每個 grant 最多五個有效 key；只存 SHA-256 hash，secret 只在初次回應顯示，不進 receipt／journal／永久瀏覽器儲存。關閉視窗先清空 secret DOM；晚到的回應不能恢復秘密。提案的 PR URL 必須指向該原作，但仍是本人／Agent 提供的連結，不冒稱已驗證作者、合併或成果認證。

資料庫 trigger 在所有 membership 寫入路徑共用撤權邊界：最後一個有效資格來源消失時，同一交易撤銷 grant 與全部衍生 key；另一個 OR 來源仍有效則保留。停權、GitHub 解除／重新連結同樣永久撤銷舊 grant。撤回同意由服務交易撤銷該能力，其他能力、書籍和既有提案保留。重新入會／重連需新 grant，舊 key 不復活。

啟用、發 key、保存提案（含重送 receipt）都持有 user → guild → GitHub 的鎖序並重查當下資格。GitHub 驗證重用加密的 user access token，核對真實 user ID、原作／工作 repo ID、公開與未封存、本人 push 權限、Fork 來源、正確 App 的有效 installation，以及該 repo 是否在可存取清單。metadata 權限只支援這個核對與站內提案，不宣稱 App 可寫程式。依 [GitHub installation/user access API](https://docs.github.com/en/rest/apps/installations#list-repositories-accessible-to-the-user-access-token) 實作；最多查 300 個 installations 與所選 installation 的前 500 個 repositories，每個清單回應上限 1 MiB；超出範圍不推定有權，建議安裝時只選必要 repo。

GitHub 暫時故障時拒絕操作，不以快取授權；已確認的權限消失、安裝 ID／repo ID 改變會撤銷 grant。這版沒有 App webhook 或獨立 GitHub 對帳 worker，外部變更在下一次受保護操作重新驗證；不能宣稱離線期間已即時收到卸載事件。沒有授予 GitHub team／collaborator 權限，因而沒有可代為移除的外部權限；未來若增加，仍須下文的 outbox 與簽章事件設計。

### 已提供 API

瀏覽器路徑前綴 `/api/v1/me/development/:kind/:target`，使用登入、CSRF、Idempotency-Key。`kind` 為 `skill`／`platform`，`target` 為既有技能／頁面 ID：

| 路徑 | 用途 |
| --- | --- |
| `GET /`（即前綴本身） | 本人資格、任務清單、grant/key metadata 與近期私人提案 |
| `POST /consent` | `{policy_version:"development-proposal-v1",accepted:true/false}` |
| `POST /activate` | `{working_repository_url}`；GitHub 即時核對後建立目標 grant |
| `POST /keys` | `{}`；產生一次顯示的 60 分鐘提案 key |
| `POST /revoke` | `{key_id?}`；指定 key 或本目標所有現行 grant |
| `POST /proposals` | `{title,summary,pr_url?}`；保存本人私人交接紀錄 |

Agent 使用 `POST /development-agent/v1/proposals`，Bearer `fpd_…`、JSON 與 Idempotency-Key；不接受 cookie 作授權，外站 Origin 拒絕，串流上限 32 KiB，scope 固定 `development:propose`。kind、target、owner 由 key 的 source grant 決定，不接受客戶端改寫。這個 key 不能呼叫一般技能上傳 API，也不能取得其他會員的資料。

會員從技能書或頁面的開發入口開始，選擇適用公會、完成 GitHub 與該操作所需的設定，直接回到原任務。在適用公會期間，平台依目前資格授權；資格失去時，平台撤銷由該資格產生的授權。每個模組使用同一套規則，避免各自維護入會檢查。

## 資格與授權範圍

| 工作 | 適用公會 | 入會可取得的資格 | 仍需獨立確認 |
| --- | --- | --- | --- |
| 技能書技術開發 | `guild_ai_vibe` 或 `guild_ai_field` | 在指定技能／repo 提交修改提案 | GitHub 身分、相應連線／同意、目標作品權限 |
| 平台頁面與功能開發 | `guild_platform_engineering` | 參與指定平台任務、提交修改提案 | GitHub 身分、相應連線／同意、目標 repo／任務權限 |
| 直接編輯既有作品 | 對應開發資格 | 不因入會自動取得所有作品的編輯權 | 本人作品或具名、有效的作品維護任命 |
| 合併、正式發布、部署 | 相應職務及專案規則 | 不由一般入會授予 | 該操作既有審查與發布授權 |

畫面名稱沿用實際公會目錄；目前平台公會 canonical key 為 `guild_platform_engineering`，不可因「平台開發公會／平台工程公會」文字差異另建重複公會。

一般瀏覽、使用技能書、提供建議、分享連結、手動提交可追溯候選作品，保留原有入口。領域專家補充教材與公會內容維護，依相應內容職務處理。公開 GitHub repo 與其 fork／PR 的外部開源貢獻途徑，不受工坊頁面隱藏控制。

`skill.submit` 現行一般投稿資格與既有投稿憑證，不可默默改成公會開發資格。新開發憑證必須明確記錄 `source_grant_id`、用途及目標；若現有上傳流程增加「開發」用途，必須版本化區分一般投稿與開發操作，並測試兩種授權。任何要收緊既有投稿資格的變更，必須同步修改產品規格、API 與遷移說明。

## 共用判斷

對每次受保護操作，伺服器重新計算：

```text
允許 = 會員有效
    且目前至少有一個符合該能力的有效公會身分
    且該操作必要的同意仍有效
    且該操作必要的 GitHub 身分與目標 repo 存取有效
    且本人／維護任命／任務範圍允許操作目標
    且使用的憑證未過期、未撤銷，且範圍包含該操作
```

網頁操作用登入工作階段，不要求會員手動建立 API key。Agent／CLI 使用工坊發出的短效、限定用途憑證；憑證不能擴張持有人的目前權限。GitHub App 私鑰與 installation token 留在伺服器，不交給會員或 Agent。

資格查詢、介面任務清單、寫入 API、Agent／CLI、排程 worker 共用同一份能力定義。介面顯示「可開發」只是提示，API 不採信客戶端提供的公會、完成狀態或權限旗標。重送先重新授權，再讀取 idempotency receipt。

## 開發啟用任務

入口保留 `intent`，包含能力、技能／頁面、目標 repo 和安全的站內返回位置。可中斷、重新登入後接續，不能接受任意外站 redirect。

1. **加入適用公會**：未加入時顯示可選公會與用途，由會員選一個加入。已加入任一適用公會，直接沿用資格；不要求同時加入兩個 AI 公會，也不更換主力公會。
2. **連結 GitHub**：提供 GitHub 註冊入口與授權按鈕。授權回來後讀取 provider 的穩定 user ID 與 login。自填 slug 不是身分證明，改名不建立第二個人。
3. **連動本次 repo**：操作需要 App 存取時，提供安裝入口與指定 repo 選擇。由伺服器驗證目前 App、installation、repo ID、使用者存取與必要 permissions；按過安裝連結、回傳 installation ID 或 public visibility 均不能單獨當作完成證據。組織管理者尚未核准時顯示等待狀態。
4. **確認具體規則**：分別記錄貢獻規則版本、必要資料使用、Agent 操作範圍。公開發布同意仍綁定本次待公開內容，不因入會取代本人預覽。
5. **返回原任務**：必要條件齊全即開放相應能力。需要 Agent 時才產生一次顯示的短效憑證，不把 secret 放在 URL、公開 SKILL.md、事件正文或永久瀏覽器儲存。

缺什麼就顯示什麼；既有 GitHub 連結、已確認同意、仍有效的 repo binding 可重用，但每次動作仍檢查當下資格。App 只有 metadata／starring 權限時，不能顯示已有寫入程式或建立 PR 的能力。

## Grant／revoke 語意

公會資格與實際操作 readiness 分開顯示：

- 入會即取得對應開發資格；必要 GitHub 授權或同意未完成時，狀態為「待完成設定」，不發可執行寫入的憑證。
- 條件齊全即啟用對應 grant，不要求管理員重複核准自助資格。
- 離開其中一個 AI 公會，但另一個仍有效，技能開發資格保留。每個能力按所有有效資格來源重算，不能按單一離會事件直接刪除全部權限。
- 離開最後一個適用公會，撤銷該能力的 grant 及其衍生憑證；其他公會提供的不同能力保留。
- 再入會可重新取得資格及新 grant；已撤銷的 token 永不復活，不以改回 `active` 恢復舊憑證。
- 退出、停權、取消作品維護任命、撤回必要同意、解除 GitHub 連結、App 卸載／停用、repo 被移出安裝範圍，都重新計算受影響的能力；不要連帶撤銷無關能力。
- 草稿、已發布作品、既有 PR、作者署名、貢獻紀錄與已領取書籍保留；撤銷未來操作權不等於刪除過往成果。作品下架另走既有流程。
- 留有權限外的會員仍能檢視及撤銷自己的憑證、清理或撤回未公開草稿，不為停止授權再要求入會。

Grant 至少記錄 principal、community、capability、target、資格來源、policy version、必要 consent version、建立／到期／撤銷時間與撤銷原因。衍生憑證引用 grant，預設只儲存 secret hash；provider secret 沿用既有加密機制。

## 一致性與 GitHub 邊界

入會／離會與平台權限狀態變更須有同一交易的一致性。可重用現有 `lockMemberGuilds` 鎖序；服務、Agent 與排程 worker 必須遵守相同鎖序，避免發 key／離會競態與死鎖。所有新增會員路徑，包括定位完成與管理員任命附帶入會，都要走相同能力推導。

平台撤權在離會交易提交後生效。已排隊但未開始的工作取消或轉為需要重新授權；長任務在實際副作用前再驗權限。已送到 GitHub 的請求可能完成，不宣稱能撤回已發生的外部操作，也不為「回滾」自動刪除他人的 PR 或作品。操作結果須照實對帳。

GitHub App 安裝授權來自 repo／組織管理者；公會入會不會自行產生 GitHub provider permissions。個人授權與 App installation 是不同事實，見 [GitHub 安裝與授權說明](https://docs.github.com/en/apps/using-github-apps/installing-a-github-app-from-a-third-party)。

會員離會時，立即停止工坊透過該 grant 發動的操作。保留其 GitHub 帳號連結，不替他解除整個 App 安裝、刪除個人 repo、取消 Stars，或移除其他用途的授權。若未來另授予「工坊管理的 GitHub team／collaborator 存取」，須記錄這筆外部權限的來源及目標，以 durable outbox 撤銷平台實際授予且不再有其他有效來源的權限。

外部撤權有 pending／confirmed／failed 與有界重試、對帳；GitHub 暫時故障不恢復本地資格，也不顯示外部撤權已完成。不是平台授予的權限不代為移除。

GitHub repo binding 以穩定 repo ID／installation ID 記錄，保存 full name 作顯示。App 事件驗證簽章並去重；漏掉事件靠重新驗證及對帳修復，不能永遠採信過期的「已安裝」快取。使用者 token、App installation token 與工坊 API key 分開管理。

新增原作歸屬規則：開發 grant 的目標必須區分原作與工坊整合 repo；預設從原作 Fork 並向原作提 PR，原作維護者保有合併決定。入會／上架／App 授權不要求著作權或 repo 所有權移轉，離會也不改寫既有作者與貢獻。詳見[原作、版本與貢獻歸屬](./author-owned-collaboration.md)。

## 新會員 GitHub 連結與 Star 授權

使用者追加需求：希望推廣作品與領取技能書之前都先按星，因此 GitHub Star 操作的授權要在一開始就能完成，而非等會員參與技術開發時才出現。

**納入前置設定的方向：** GitHub 個人連結與 Star 操作授權為所有會員共用的啟用項目，不限定開發公會。首次會員啟用顯示「連結 GitHub，之後可直接替你選擇的作品按星」。由本人在 GitHub 完成 user authorization；記錄已連結帳號與功能狀態，後續領書、閱讀、分享／推廣與開發入口重用同一個連線。

本人授權與實際按星分開。操作說明為：「允許自由工坊在你按下 Star／取消 Star 時，使用你的 GitHub 帳號執行對應操作。」後續明確點選某個 repo 的 Star 即表達這次操作意圖，不再疊加不必要的確認對話框；首次連線返回時只恢復原頁，不把授權完成當成一次點星，也不默默替整批書目按星。

既有 App manifest 已請求 `starring:write` 與 `metadata:read`，見 `modules/github-social/setup.ts`。將連線入口前移不是另外擴張 repo code-write 權限。Token 可以在有效授權範圍內刷新；遭撤銷、身分失配或新權限需要本人批准時才重新授權，不能承諾一次授權永不再提示。

會員 user authorization 不等於原作 repo 的 installation 存取。上架／收錄流程須驗證每個原作所需的 App 存取；權限不足時指出是會員連線或 repo 管理者設定尚未完成。不能要會員授予自己所有 repo 的存取，來掩蓋第三方原作尚未開放 App 的問題。[GitHub App 授權與安裝](https://docs.github.com/en/apps/using-github-apps/installing-a-github-app-from-a-third-party)

**待討論決策：強制按星才能領書／推廣。** 這是使用者明確提出的新增條件，本輪沒有把它悄悄改寫成使用者已接受的自願方案，也尚未將它設為產品 gate。GitHub 的 [Acceptable Use Policies §4](https://docs.github.com/en/site-policy/acceptable-use-policies/github-acceptable-use-policies#4-spam-and-inauthentic-activity-on-github) 禁止排名操弄（包含 automated starring）與以獎勵誘導的不真實互動。條文明文未逐項判定工坊領書的具體情境；將資源／資格交換綁定 Star 有此風險，是本輪設計判斷，不宣稱已有 GitHub 對本案的裁定。

建議替代流程：領書或推廣前呈現原作者與專案，提供獨立的「Star 支持作者」和「繼續領書／推廣」。Star 可在本站直接執行、已按過可重用真實狀態；不按、不想建立 GitHub 帳號或 GitHub 暫時故障仍保留原有領書／推廣途徑。若目的是確保推廣者了解內容，以閱讀、試用和本人願意推薦的確認作資格條件。這是建議，尚未當成使用者已同意的替代決策。

## Stars 與頁面可見性

Repo Stars 以 GitHub 為準。讀取作品計數、取得會員本人 Star 狀態、代本人 Star／Unstar 是不同動作，按各自所需權限處理。入會、完成任務或授權 App 不自動 Star；退出公會也不自動 Unstar。[GitHub Star API](https://docs.github.com/en/rest/activity/starring)

公開說明、加入條件、開發導覽與公開來源仍可閱讀。私人開發工作區、編輯、金鑰管理及受保護資料由後端依身分與目標授權；不能只靠前端藏按鈕。對外公開的 GitHub code 與 commit 無法因離會而收回讀取權。

## 整合位置與現況

| 位置 | 現有實作 | 本規格需補的部分 |
| --- | --- | --- |
| `modules/positioning/service.ts`、`onboarding.ts` | 入會／離會、membership version、每人公會鎖、領書 | 共用能力推導、最後資格來源消失時的撤權 |
| `modules/github-social/` | GitHub 個人授權、加密 user token、本人 Star | App installation／指定 repo 驗證、失效事件與對帳 |
| `modules/skill-submissions/` | 一般技能候選草稿、投稿 key、一次性 grant、本人公開 | 若增加開發用途，新增明確用途及 source grant；保留一般投稿契約 |
| `modules/guild-workspace/service.ts` | 會長依有效公會與任命驗證；技能內容依維護任命驗證 | 技術開發 grant 與既有內容職務的明確分工 |
| `apps/portal-web/src/modules/DevelopmentContext.tsx` | 每頁公開開發指引 | 平台開發啟用入口、任務進度及返回原頁 |
| `apps/portal-web/src/modules/SkillBookIntro.tsx` | 技能介紹、公開任務與 Agent 指引 | 技能開發啟用入口，重用同一清單元件 |

本規格不新增通用永久寫入金鑰，也不把目前公開導覽包成有名無實的「已授權開發」。操作尚未支援時應顯示具體缺項。

## 驗收案例

以下為待實作測試要求，尚未執行：

1. 無適用公會點技能開發：顯示兩個公會選項；選一個即可，保留原主力、原技能與返回位置。
2. 無平台公會點頁面開發：引導加入平台公會；技能開發資格不能替代平台資格，反之亦然。
3. 只有手填 slug、其他 App 安裝、未授權的 repo、遭停用 installation、缺必要 permission：均不能完成對應啟用任務。
4. 同時在兩個 AI 公會：離開第一個仍可操作；離開最後一個後，瀏覽器、既有 Agent key、一次性 grant、重送 receipt、排程 worker 都拒絕受影響操作。
5. 仍有另一種能力：撤銷技能開發不影響平台開發；不同社群、不同會員或不同作品不得串用授權。
6. 重入公會取得新資格，舊 key／grant 即使未過期仍不可用。
7. 在不同分頁退出公會，舊頁面的按鈕即使尚未更新，下一次 API 操作仍被拒絕並指出恢復路徑。
8. 入會、離會與發 key／上傳／啟動任務併發：交易結果一致，不遺留無資格的有效寫入授權。
9. 斷開 GitHub 或卸載 App：需要該連線的操作被拒絕；不刪除歷史作品、Stars 或無關公會資格。
10. 會員離會後仍能看自己的草稿、撤銷金鑰；一般分享與手動候選投稿符合既有契約。
11. 普通公會成員不能編輯別人的書、合併平台程式或部署；任命撤銷立即反映在相關操作。
12. 外部撤權失敗：本地先拒絕，顯示外部待處理；重試可去重，成功後對帳，不移除外部獨立授權。
13. GitHub 授權返回、取消後續作、已完成項目重用、鍵盤焦點、手機窄螢幕及公開無 JavaScript 指引都可用。
14. 未加入開發公會的普通會員可以完成 GitHub 個人連結與 Star 授權；授權本身不替任何 repo 按星。
15. 有效連線在領書、閱讀、分享與開發入口重用；本人明確按 Star 時只對所選原作執行一次，重讀以 provider 狀態為準，不以本地數字加一冒充成功。
16. 第三方原作缺 App 存取時不顯示 Star 成功，不反覆要求會員授權自己的無關 repo；斷線／取消授權後引導恢復。
17. 新會員啟用與 OAuth 返回不批量 Star；公會離會也不批量 Unstar。強制 Star gate 尚未實作，驗收不得將建議的自願流程冒充使用者已採納的決策。

相關既有實作：[GitHub 連結](./github-social.md)、[技能投稿](./agent-skill-upload.md)、[公會共作](./guild-collaboration.md)、[開發指引](./agent-development-guide.md)。
