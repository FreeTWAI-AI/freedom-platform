# 2026-09-23 大計畫與目前產品的落差

檢視基線：`8ccb18cfe769056368476438fcb0b1cbc41a7266`，另列本輪尚待整合發布的補強。原計畫 `00`–`12`、`02 §4.7` 接點分工、現有 migrations／routes／modules 及最新會員入口決定一併對照。這是檔案與 runtime 審查，不是重新核實所有雲端資源、真人案例或銀行款項。

**目前是能操作的會員、公會、作品、供貨／商店草稿與共創入口。** 完整 56 packages／12 runtimes、Agent 自主執行、供應鏈訂單／金流、陪跑和媒體執行仍是後續設計；不能因九倉、技能書或選單存在就算交付完成。這些後續能力也不反過來阻止現有會員使用、開源參與或一般外展。

## 決策優先序與產品主線

1. Ted 後來明示的新會員封閉式定位，取代 2026-09-19「定位 optional」入口；不連帶恢復其他入會考核、先貢獻、積分、付費或官方 QC 門檻。
2. 人先知道自己的方向、公會與技能書，再分別使用供貨、銷售、開源、行銷與共創；不把所有東西塞進「作品與商機」。
3. Guild 縱向、Squad 橫向；會員自行選主力／次要公會。指定會長要有真實任命或明示待連結狀態，Repo 作者不自動成為公會長。
4. 技能書是 Repo；「裝備」的會員介面指工具／訂閱，「基本能力」是自填技能，不代表認證。技能書授予是可讀取與 fork 的引用，不是本機安裝成功。
5. GitHub Issues／PR 是 code task、審查及合併真相；平台共創紀錄保存募集目標、角色與協調資訊。一般非 code WorkItem 仍由平台保存，不能宣稱已有雙向 Issue 同步。
6. 平台不過手錢；免費知識和自願合作保留，服務時間可另約收費。開源作品、行銷及商機提供合作入口，不保證收入，也不以十次免費互助作為找客戶的前置條件。

## 對照矩陣

「已實作」指此 checkout 有 API／資料與對應測試，不等於所有外部服務或真人營運證據已完成。

| 要求／原計畫 | 目前行為與證據 | 判定與處理 |
|---|---|---|
| 00／04 定位；後續強制新會員完成 | `app.ts:onboardingAllowed`、`modules/positioning/{assessment,onboarding}.ts`：15 公會、version/hash 固定的原創題目、草稿可續填、本人選擇，舊完成會員不被重新封鎖。 | 已實作。保留 user override；不恢復 optional 新註冊捷徑，不宣稱與私人 ai-online 舊分數相同。 |
| 身分＋會員聯絡可見範圍 | `identity-membership/members.ts`、005／008／012：email/password、暱稱、按好友／小隊／公會等真實關係讀取聯絡欄位、最多三項精選能力及完整清單。 | 已實作子集。一般 Email、GitHub／Discord handle 未驗證；一般找回密碼／OAuth／寄信尚未做。 |
| Guild 自助加入、多重職業、主力唯一 | `positioning/onboarding.ts`、006／009／013：join→repo book grants、primary 排序、離開 primary 前改選；新公會核准須綁現有書籍。 | 已實作。Rank 只有 runner 起步，不把技能勾選、職稱或會長任命冒充升階證據。 |
| Guild leader／Office | `platform-admin/{access,service,leadership}.ts`、011／014：驗證的 Access admin、同信箱會員連結、pending nominee、任命與 audit。 | 已實作精簡管理。完整任期、delegates、handover／succession 尚未做；原五人分工表不是已授權的任命資料。 |
| 技能書 Repo 與作者來源 | `community/catalog.ts`、`listGuildSkillBooks`、`member_skill_book_grants`；公會入門書與來源 fork 有 exact source refs。 | 書架／引用已實作；內容成熟度逐本看。文件型 guide 不是影音 app、已安裝工具或 signed executable Skill。詳細書籍內容本輪另線優化。 |
| 兩種橫向小隊 | `members.ts:SquadInput/listSquads/changeSquadMembership`、005：`project`／`mutual_help`，本人 request、發起人 accept、本人 leave。 | 真實名單與權限關係，非空選單。尚缺共同目標週期、scope／完成條件、每人投入與收益、結束／移交、Work／共創 link；列下一項，不宣稱已是完整交付 Squad。 |
| GitHub 共創與開源＝合作入口 | `co-creation/service.ts`、010；`github.ts` bounded public reads、brief、明示 source_kind。 | 真實 DB 協調＋GitHub Issue／PR 讀取。平台不認領／指派 GitHub 權限；profile slug 不是作者驗證。靜態 pilot 指向實際 repo，是策展資料而非虛构熱度。 |
| Work→submit→accept→Gained | `opportunity-project-work/work.ts`、001、`flows.test.ts`。 | 已實作 exclusive user claim、自願貢獻；不是多人 Squad Claim、funded workflow 或正式 QC。無 reviewer 仍可 claim／submit，回饋改派、放棄／重開與到期排程待做。 |
| 12／FW-13 本人實益回報 | 基線缺此 runtime；本輪新增 015、`results/benefits.ts`、benefits route／選填 widget、`benefits.test.ts`。 | 本輪補上 append-only 需求者／承接者自報、修正、unknown 分布與本人私密細節。參見 [API](benefit-observations.md)；不改付款、rank 或 acceptance。 |
| 01 §16 北極星／12 低維運 | `dashboard().summary.accepted_count` 只是已接受 Contribution 數；本輪回報只產生自報來源。 | 尚不能宣稱互惠／低維運已驗證。未建合作週期去重、跨案時間窗、獨立自然人驗證、持續使用／重用、核心補位及工時覆蓋投影。 |
| Supplier web 平台 | `catalog-commerce/service.ts`、003、commerce routes：商品、供貨版本、選品及供貨請求／回覆。 | 真實持久化供貨協作。未啟用 stock reservation、order、履約、正式 DistributionAcceptance 簽章或供應商付款。 |
| Fork 商店接平台 | `client-connections/service.ts`、007、`packages/client-connections/read-client.mjs`：本人批准、七天／可撤銷 token、scoped read。 | 初期讀取接線已實作，寫入在平台 web。外部 BFF checkout、Seller-owned payment connection 與 Job API 未做；不能稱完整自動開店銷售。 |
| 開源登錄／介紹頁 | `opensource-marketing/service.ts`、004：public repo ID／commit／license snapshot＋自行說明關係；介紹可用 GitHub Pages 或自有網址。 | 版本與引用已實作。登錄不自動 fork 任意 repo、不驗證 owner、不直接發佈 Pages、不授予 official。 |
| 行銷、RefRef／Refferq 參考 | `opensource-marketing/service.ts` campaigns/source snapshots/manual shares。 | 真實草稿與人工分享紀錄；attribution、外部刊登、conversion／佣金結算未接。RefRef 不是供應鏈核心的替代品。 |
| 媒體、音樂／MV、商攝 | Repo／指南與公會已存在；核心沒有 media executor、render job 或影片上傳處理。 | 規劃／外部技能資源，不能把書籍入口說成平台會自動剪輯、作曲或出片。 |
| 商機→合作→收款回報 | `opportunity-project-work/business.ts`、001：雙方條款、交付接受、self_reported／counterparty_confirmed receipt。 | 已有紀錄流程；沒有 provider／bank reconciliation、法律簽章或付款執行。兩方確認仍非銀行已實收。 |
| 02 §4.7 單一 seam | 平台 Node app 直接做有界公開 GitHub GET，fork client 經限定 API；外部 repo 不直連中央 DB。 | 目前保留資料 owner 邊界，但完整 Connection／Broker／Ingress／Job API 尚未建。明示為過渡的讀取接點，不要求為展示先造微服務。 |
| 05 外部事件／03 event＋state | `command()` 同 txn 寫 domain／receipt／journal／outbox。 | 本地交易冪等已有；現在 outbox 不是完整 canonical envelope、跨 provider queue dispatcher／replay／reconciliation 尚未部署。 |
| 02／08 56 packages、12 runtimes／cloud | `apps/platform-api/src/server.ts`、`deploy/public`／`deploy/staging`、[公開運行手冊](public-operations.md)：Node＋Castle Postgres＋Tunnel。 | 公開會員 beta，不是原 managed-cloud 全拓撲。Workers／Hyperdrive／managed Postgres、R2 quarantine、KMS/HSM／signed channels 等依序補，不宣稱已完成。 |
| 05 contract-first 多倉 | `contracts/preview/v1/definition.mjs`、`build-contract-bundle.mjs`、`repositories.lock.json`、跨倉測試。 | Preview 子集有 exact pins／generated clients；新會員／admin／共創／回報目前另有 API 文件。未完成整份 planning OpenAPI runtime 或 cryptographic signed ContractBundle。 |
| LINE／Discord、陪跑與 Agent execution | 現有乾淨連結、unverified contact、可交給 Agent 的 GitHub brief。 | 網站入口是真實；bot／webhook intake、notification、coaching bookings、bounded ExecutionGrant／lease／Skill 安裝尚待開發。不能把貼連結當成橋接完成。 |

## 小隊類型與北極星是否對上

目前兩種 key **維持 `project` 與 `mutual_help`**，不另建新的組織類別：`project` 是有交付目的的跨職能隊伍，`mutual_help` 是一輪共同改善。這是起步對應，不冒充 Ted 已另行給過完整兩種隊伍的商業條款。兩者與 Work 的 `participation_mode` 分開：專案可以完全自願；互助也不代表欠債或一定有收入。

共同目標目前只存 `purpose`，缺週期 ID／結束條件和工作 link，所以不能按 squad 人數、Issue 數、PR 數或 accepted_count 計「有效合作」。本輪先補本人自報這個缺少的資料來源；下一步才讓既有小隊接一個可結束的共同目標，重用 Work／GitHub 引用，不新增另一份 code 任務真相。

北極星保留「另一位真人／組織得到持續價值」；輔助指標分列收益、未知、投入、再參與與重用。兩個帳號回報 gained 只能叫「兩位參與帳號自報有收穫」，自然人獨立性未驗證，不算已證明雙方互惠。沒有現金、provider fact 或核實資料就不把它叫收入。

## 真正的佔位與後續未完成

- **會誤導現況的文字：** 新會員定位可跳過、只有內部 staging、admin 任命仍全部待做、所有 fork 仍只能 demo cookie，均已被後續實作／指示取代；本輪在相關文件修正或加日期說明。
- **本輪修掉的實際 prototype 值：** `voluntaryTerms()` 不再把 `local-demo-author-consent` 寫入新工作；依原 canonical schema 使用 `artifact_license_ref:null`、`consent_required:true`，明示尚未記錄重用授權。既有 Work／Claim 的 terms 與 hash 不回寫；未來可補真正的 consent／license revision。business.ts 的「本機驗證流程」過時提示已改為一般交付狀態說明，付款仍不執行。
- **誠實的未完成：** `shared_goal_ref:null`、`funding:null`、`human_support.promised:false`、未任命 leader、來源授權未知不是假功能。保持 null／unknown，比偽造承諾、source 或 officer 正確。
- **後續功能缺口：** Squad 關閉／共同目標、Work review 改派與放棄、一般帳號恢復、外部通知、跨 Work／Coaching 容量。優先處理使用者實際走不完的路，不先擴大金流或全套簽章架構。
- **另列的行為差異：** `claimWork()` 目前驗證 `users.profession_membership_ref`，尚未支援每件工作選另一個 `positioning_profession_memberships` acting role。它不是已完成的多公會工作身分；後續需 versioned contract migration，不能直接把兩種 UUID 混用。

## 獨立審查與驗證

依使用者指定執行 Claude Code CLI read-only 審查：CLI **2.1.280**；請求 `--model opus`，回應 `modelUsage` 與 `canonicalModel` 均為 **`claude-opus-5-5`**。`--safe-mode --tools '' --strict-mcp-config --disable-slash-commands --no-session-persistence --output-format json`；180 秒上限，實際 140 秒、1 turn、exit 0。沒有給它 write／shell／browser tools，輸入是約 103 KB 的 bounded 文件與後端原始碼節錄；沒有提供 auth 檔案、環境 secret 或私人會員資料。

CLI 原始回應保留在本機 task temp `/tmp/freedom-plan-drift-audit-20260923/claude-result.json`，不當作程式測試通過證據。本報告逐項回讀原碼核對；未提供給 CLI 的 squad、identity 內容由本輪直接查證。其建議中的 `project_delivery` 僅為描述名稱，實際 API key 是 `project`，沒有照單改 enum；它把 legacy self-declared profile 與舊 quiz v1 相聯繫的推測也未採用。無 reviewer 的 submitted 不代表工作不能開始，不採用新增完成門檻或偷偷指派回饋者的修法。

本輪新增回報 runtime 測試 **5 passed**，含原 canonical JSON Schema、跨程序持久化、參與身分／跨社群／CSRF／If-Match、同 key 重送、並發 supersedes、未知／零分鐘區分、私人敘述不進 journal、Contribution／付款不變。TypeScript 檢查通過；browser 與整體 release 檢查由整合後結果補記，不能以本文件宣稱已部署或真人互惠已驗證。
