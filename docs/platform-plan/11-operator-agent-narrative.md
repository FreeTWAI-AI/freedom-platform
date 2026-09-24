# 管理者與其 Agent 的一天

> 狀態：現行 canonical baseline（2026-09-19 低維運互惠修訂）；planning 文件，不代表已部署。

> 2026-09-23 現況：公開會員 beta 與 Access 驗證管理／會長任命已有實作；完整簽章平面、Agent domain Skill、營運工時／容量首頁仍未完成。下文 2026-09-20 現況按其時點解讀，現行實作與缺口見 [落差盤點](../development/plan-drift-2026-09-23.md)。

> 2026-09-24 現況：加入公會就取得對應的開發資格，離開最後一個適用公會就撤銷：技能開發對應 AI 開發或 AI 導入與驗證公會，平台開發對應平台開發公會。
>
> 幹部不需要逐件核准，也沒有替會員保管 GitHub 權限。Agent 只拿到 60 分鐘、只能提交提案的 key，不是本文 A0–A3 grant 或 domain Skill runtime 已經完成。見 [公會開發資格](../development/guild-development-access.md)。

日期：2026-09-17

本文是給幹部與 NotebookLM 的敘事入口，不是另一份規格。權威仍是 `00`–`08` 與 `contracts/`。成員與幹部的 Agent 只能執行具備 signed overlay、runtime-scope QC、current publisher authority、current revocation 與隔離載入 evidence 的 domain Skill；條件不成立就回 `capability_unavailable`。

先講事實：2026-09-20 已有本機 Portal／API 與限定流程的實跑測試，見[版本紀錄](../releases/2026-09-20-local-core.md)。雲端 production、外部 sandbox、可啟用 Skill 與完整產品／真人驗收仍未取得完成證據。現行目標執行結構如下：

```text
Foundation Day 1   O1／O2 一次開齊；production＋staging 同日建立；AI 完成可自動化設定
階段 1A            契約凍結
階段 1B            56 packages、9 repos、12 runtimes／consumers、四個 product repo templates／adapters 與五個 cores 的全形狀 skeleton
階段 1C            O1／O2 真實 sandbox 接線；O3 走 contract tests＋deterministic mocks
階段 2             垂直細節與發布成熟度
```

順序只受技術依賴影響。人員與 evidence 缺口投影成標籤，不阻擋無關工作。

## 0. 管理者不是所有缺口的預設補位者

2026-09-19修訂後，首頁先看本週核心及其他會員的維持／協調工時、已接受容量、資金來源、未完成責任與資料未知量。任務多、delegate多或自動化比例高，不等於維運低。

普通未認領互助無人接時，系統自助／候補／縮小／到期；scope＋episode只聚合一張導航卡，不每天要求管理者找人。已有合約、付款、安全與正式權益問題則保留原owner及必要升級，不讓auto-close抹除責任。

共同目標由成員在既有Squad／cohort自願提出與承接，管理者不必供應所有題目、主持固定報告會或逐張驗證普通互助。真人交流保留給解題，行政由範本與系統減少。

首批並行驗證有限互助，以及自願作品曝光 → 商機 → 合作 → Seller 外部實收；商品、其他軟體與專業服務仍可建介面及sandbox，沒有真人／資金證據就不新增保證服務。約10次真人合作是互助觀察採樣，不是找客戶的前置門檻；不以AI persona、本機示範帳號或靜態檢查宣稱真人實益及成交已驗證。詳見`12`與[首批營運驗證](../development/operating-validation.md)。

## 1. 這套平台裡，管理者是誰

Freedom Platform 不增加一層總部簽核。它讓人先找對方向，再讓人帶著自己的 AI Agent 做今天的工作。幹部負責維持方向、授權、例外處理與服務連續性。

| 角色 | 白話 | 它不是 |
| --- | --- | --- |
| Guild Master（Officer） | 一條專業線的現任負責人：方向、人才、訓練、重大版本 | 不是因為持有 Master rank 就自動取得的永久權力 |
| Master（rank） | profession 的最高能力階級：Runner → Strategist → Master | 不是官職，也不是全平台管理員 |
| Officer | 有任期、有範圍、可交接的職務 | 不是 rank 的別名 |
| Module Steward | 某個產品模組的 accountable owner | 不必親自處理每張 PR |
| Delegate | 有紀錄、期限與 scope 的受託人 | 不能靠口頭授權無限擴權 |
| Reviewer／Release Captain | 處理 exact artifact 或 release 的人 | 換一個 Agent 不會變成另一個自然人 |
| Seller／Supplier | 面對買家收款的當事人；提供貨與履約的當事人 | 平台畫面角色不會改寫法律與 provider 責任 |
| Agent | 代表 human／organization principal 做事的 client | 不是會員、Master、reviewer、signer 或 payee |

五人核心團隊依 `06 §3.1` 的建議預設分工各自 own track，並在五人共同閱讀時確認；Ted 的 Day 1 不等待共同閱讀。平台自身建置由 Grok adversarial review、Claude verification 與自動 checks 處理；Ted 只在付款、法律文件及對外正式 release 三類 exact artifact 做一鍵 A4。

這篇以 AI Field 幹部與 QC 模組 Module Steward 的協作日常為主軸；建議預設 holder 分別是 Jason 與 Mini，五人共同閱讀時確認。其 Agent 再勤快，做的事仍歸屬它代表的 principal，不能充當第二位獨立 reviewer。

## 2. 早上打開工作台，會看到什麼

在階段 1B 的 skeleton 與階段 1C 的 sandbox evidence 成立後，這位幹部可從 Portal 或自己的 Agent 詢問：「今天 Field 線上有什麼要處理？」在此之前，這仍是目標體驗。

首頁回答三件事：

- **Now：** 她此刻以哪個 profession、OfficeAssignment 與 ModuleStewardship 行動。
- **Next：** 少數高價值工作卡，說明 `why_you`、預估時間、所需 evidence 與可委派範圍。
- **Gained：** 已形成的 QC、教學、交接、protocol 及 contribution 事實。

典型的幹部 Next 卡包括：

1. 日常 review queue：Runner PR 與測試報告已標好 protocol、scope 與 evidence。
2. `official` evidence：一個 Skill 需要獨立自然人 QC，另一個只需要 runtime admission QC；兩者不是同一語意。
3. 平台 dogfood：WorkItem、branch、PR、AI review、Result 與 release preparation。
4. Supplier 進場：實體商品補檢驗與 `DistributionAcceptance` evidence。
5. 客服／爭議：付款事實存在，但履約 evidence 不足。
6. Settlement 對帳：`result_unknown` 要做 reconciliation，不可直接重送付款。
7. 升階 evidence：Runner 申請 Strategist；活躍天數不會自動變成 rank。

Agent 可以讀取、排序、比對、重跑測試與起草意見。它不能把「幹部看過 Feed」當成幹部已對 exact digest 簽成員 A4。

## 3. 怎麼委派，才不會變成單點

`ModuleStewardship` 保存模組所屬 Guild、accountable OfficeAssignment、delegated scopes、期限與交接狀態。日常 listing review、例行 QC 或 release preparation 可以交給 Strategist 或 scoped delegate；重大版本、規則與爭議仍依現行 stewardship 路由。

委派遵守這些規則：

- Rank 不是官職；Strategist 能帶 Runner，不會因此自動成為 Guild Master。
- 官職不是 rank；Officer 交接後，原持有人的 Master rank 仍可保留。
- 同一人換 Agent 不算獨立自然人。
- 委派有 scope、期限且可撤回；Entitlement 到期後，不再授權新操作。
- 交接要保存 successor、interim stewardship、delegate 與 succession WorkItem，避免責任記錄失去 owner。

五人核心團隊依 `06 §3.1` 的建議預設分工持有各項 assignment，五人共同閱讀時確認；工作與委派模型照常運作。人員 evidence 缺失只會使 `official`、`production-signed`、`commercial-ready` 或 `recovery` 等對應標籤維持 false，不讓 candidate、staging、sandbox、內部 demo 或發布準備停下。

`OfficeAssignment` 狀態維持 `proposed → active → handing_over → ended`，另可 `declined`；`ModuleStewardship` 維持 `proposed → active → handing_over → superseded`。階段 1A 凍結契約，階段 1B 建立狀態機 skeleton，階段 1C 產生 sandbox evidence。

## 4. 哪些事一定要真人簽 exact digest

A0–A3 綁在 `ExecutionGrant`：誰、哪個 Agent、以哪個 acting role、能動哪些資源、上限與失效時間。A4 不是第五級 Agent grant，而是有權自然人對 exact artifact／digest 的簽名。

| 級別 | Agent 可做 | 人的責任 |
| --- | --- | --- |
| A0 | 讀取、解釋、排序 | 可撤回讀取授權 |
| A1 | 起草、sandbox 測試、產生 diff | 草稿不具正式效力 |
| A2 | 在 bounded grant 內 claim、branch、commit、draft PR、建立草稿 | 保持可撤回且不得冒充 consequential action |
| A3 | 依 exact channel／時間／數量政策發布已鎖定事實的內容 | 超出政策或來源事實改變時提供新授權 |
| A4 | 準備 exact artifact 與 signature request，停在 `awaiting_human` | 有權自然人檢視 exact digest 並簽名；server 再重驗 authority 與 consequences |

### 成員 A4：產品語意不變

以下仍由該當事人簽 exact digest：

- Seller 的 `SellerListingRevision`。
- Supplier 的 `DistributionAcceptance`。
- Squad 成員的 `EngagementAllocationPlan`。
- Payer／Seller 的 `SettlementMandate`。
- Scoped reviewer 的 official QC conclusion。
- Project party 的 ProjectRelease approval、SOW、商業條款及 named application。

已簽 `SettlementMandate` 範圍內且符合 cap、原子容量保留、idempotency 與 reconciliation 的轉帳，不需要每筆重簽；這是引用既有 mandate，不是 Agent 自己取得付款權。LINE 按鈕、Discord emoji 或聊天中的「好」永遠不是 A4。

### Ted 的三類 A4：平台自身停點

Ted 只對三類平台 consequential action 做一鍵 A4：付款、法律文件、對外正式 release。平台自身的 PR、測試、架構與驗證由 AI review 及自動 checks 持續處理，不排真人 reviewer 時段。

Money movement 還有雙方語意：`authorized_mandate` 必須在同一 exact `SettlementMandate` digest 上，同時存在 Payer 當事人（reseller 情境下通常即 Seller）的成員 A4 與 Ted 付款類一鍵 A4；缺一維持 `record_only`，listing、Store 與 reconciliation 繼續運作。

Agent connection token 在結構上不含 A4。即使 Agent 被盜用，也不能替自然人簽 QC、mandate、合約或 release。

## 5. Officer 任期與交接，實際怎麼走

幹部的 OfficeAssignment 接近期限時，系統把交接做成可見工作，不在到期時抹掉責任。

```text
proposed → active → handing_over → ended
         ↘ declined
```

接班人接受自己的 exact OfficeAssignment；舊職務、新職務及受影響的 ModuleStewardship 在一致的狀態變更中留下 evidence。若尚無接班人，現行 holder 建立 interim stewardship、限期 delegate 與公開 succession WorkItem。建議預設 holder 依 `06 §3.1`，五人共同閱讀時確認；交接不停止其他工作。

Agent 能起草 handover、整理未完爭議與 reviewer pool，不能替接班人接受職務。卸任者可保留 Master rank，但不再自動擁有原 office 的代表權；反過來，沒有 OfficeAssignment 與 Entitlement 的暫代者，也不會取得付款或正式 QC 權限。

## 6. 出事時怎麼辦

幹部要讓錯誤停在正確範圍內，保留 reason、actor、scope、evidence 與恢復路徑。Agent 可整理資料及起草處置，但不自行擴大懲罰或重寫歷史。

### 6.1 爭議

買家說沒收到貨時，訂單與價格 snapshot 保持不變；履約 evidence 不足就進 `ManualResolve`。Field 或 Commerce delegate 查看該筆 `SupplyOrder`，Agent 整理 webhook、物流與時間線，人寫下具 scope 的處置理由。

軟體 QC 的 `changes_requested` 只代表該 exact version 尚未取得對應 evidence，不封鎖提交者繼續改進 candidate。新 version 重新送件，舊簽名不會被沿用。

### 6.2 Entitlement 暫停，不是把人刪掉

Entitlement 只回答 API 此刻允許什麼，不代表人的價值。惡意占位可以暫停 `opportunity.claim.basic`，歷史結果與學習入口仍保留；Seller 問題可以暫停新 listing，既有訂單照原事實處理。

每次暫停或撤回保存 actor、reason、scope 與 policy version。前期不以 AI compliance score 自動撤回整個使用者。Agent 能準備處置單，不能自行簽成員 A4。

### 6.3 安全事件與 incident quarantine

中央 object storage 維持三個實體區域：

- 公開且已清理的 assets。
- 平台私有、由平台產生的非機密 evidence。
- 事故隔離區，只接收誤送的敏感內容；一般網站、Portal、API、worker 與 Agent 都沒有讀取權。

事故隔離入口只接受 stream 與最小 metadata，依 retention 刪除內容並保存 deletion receipt。Audit 只留 hash、大小、actor 與 reason，不留檔名或內容。Cloudflare native R2 binding 的 API 權限較廣，不能被描述成 action-level write-only IAM；若 exact requirement 是 provider 強制 hard write-only，就使用具 action-scoped IAM 的 storage。此選擇不停止其他地基工作。

Agent 或 connection 被盜時，撤銷 `AgentConnection` 與 ExecutionGrant；可能已產生外部副作用的工作進 reconciliation，不假裝沒有發生。

### 6.4 撤銷 official status

若公開 GitHub Release 的 QC version、簽名或 key evidence 失效，幹部撤銷或 supersede `ProjectStatusAttestation`，不改寫 immutable release。Public Page 的 live widget 對缺失、過期、撤銷、superseded 或 mismatch 一律顯示 **Unverified**；fork 不能靠自報取得 official。

Domain Skill runtime 同樣在每個新 session 重驗 overlay、root、QC、publisher authority 與 revocation。任何一項失效就回 `capability_unavailable`，不掃 cache 找可執行的舊包；歷史 Result 仍保留。

## 7. 一個開源產品要賣時，三人規則代表什麼

傍晚，一個開源工具準備形成付費導入。平台分開保存三項責任：

| 責任 | 工作 | 不自動得到 |
| --- | --- | --- |
| Vibe | 設計、開發、維護與可重現 release | 產品 ownership、永久抽成或自行宣告 official |
| Field | 測試、review、導入與 support | 因測過就取得股權或付款權 |
| Project | 商機、scope、銷售、組 Squad 與協調分配 | 單方面決定價格與 allocation |

Vibe、Field、Project 的建議預設 holder 分別是韋銘、Jason、Mini，五人共同閱讀時確認；產品、proposal、candidate、staging、sandbox、內部 demo 與服務設計照常推進。三個不同自然人分別接受時，`commercial-ready=true`；不足三人時維持 false。這是標籤，不是工作開關。

同理，獨立 QC reviewer evidence 控制 `official`，Signer A／B custodian 是不同自然人時控制 `production-signed`。換帽子或換 Agent 都不增加自然人數。

社群 QC 維持 zero-fee。客戶出資的 testing、development 或 deployment 另建 `ServiceEngagement`；實際收入依 Offer、SOW 或 Squad 成員簽署的 `EngagementAllocationPlan`，不從 assignment 推導 ownership 或 royalty。

## 8. 幹部的 Agent 要能真的做事，先驗 domain Skill

成員問商品、宣傳、測試或開發時，Agent 需要兩層互不混淆的 trust：

**第一層是控制 Skill。** Agent 從 Freedom 簽署的 `freedom-build-system` 啟動，使用相同的 signed channel、activation digest 與 adapter contract。

**第二層是 domain Skill overlay。** `freedom.domain-skill-overlay-artifact/v1` 列出該次 run 可載入的 exact domain roots，綁定 package、dependency closure、runtime-scope QC、publisher authority、revocation 與 per-run isolation。`BLD-05` 在階段 1A 凍結 contract，在階段 1B 建立 implementation skeleton，階段 1C 以真實 sandbox 驗證。

| 模式 | 條件 | Agent 能做什麼 |
| --- | --- | --- |
| `eligibility_and_provenance_only_v1` | 預設；overlay、QC、authority、revocation 或 isolation evidence 不完整 | 只做 matching 與 provenance；執行 Skill 時回 `capability_unavailable` |
| `signed_isolated_overlay_v1` | Server-derived roots 與 signed exact set 相等，全部驗證成立 | 在 per-run 隔離中執行 exact Skill bytes；不得寫入 host 全域插件或改 control digest |

Mode 與 Skill refs 由 server 從 immutable WorkItem、current equipment 與 grant 推導，client 不得自報。Ted 的 Skills／OSS track 與韋銘的 implementation reviewer track 在這條鏈上維持 runtime-scope QC、撤銷與 exception evidence；這些分工都是建議預設，五人共同閱讀時確認。Runtime admission QC 不自動等於 `official` 或 `commercial-ready`。

| 成員提問 | Agent 的 bounded 工作 | 成員要做的事 | 交付結構 |
| --- | --- | --- | --- |
| 有什麼商品，要不要放進我的店 | A0 列出、A1 比較、A2 起草 listing | 選擇商品；Seller／Supplier 對 exact artifact 簽成員 A4 | 1B skeleton；1C sandbox；2 細節成熟 |
| 要不要宣傳 | A0 看 channel／quota、A1 起草、A3 依 exact policy 發布 | 選 channel；超政策時給新授權 | 1B skeleton；1C sandbox；2 細節成熟 |
| 新軟體要不要測、按星星 | A1 隔離測試、A2 交 reproduction；star 需明示 scope | 決定是否測與公開背書；獨立 reviewer 簽 official QC | 1B skeleton；1C sandbox；2 細節成熟 |
| 規格上了，要不要開發 | A0 解釋、A2 claim／branch／draft PR | 選工單；project party 保留自己的 release A4 | 1B 平台 dogfood；1C 真實接線；2 成熟 |

Planning fixtures 使用 fake digest／signature，永遠不得啟用。靜態 fixture 檢查與本機會員工作流程已另有實跑紀錄；本節 domain Skill runtime 尚未驗收，在真實 evidence 形成前，不宣稱任何成員 Agent 已在 production 執行 domain Skill。

## 9. Seller、Supplier、客服與對帳：另一條幹部日常

Commerce 幹部會看到：哪些商品具備 QC 與 Supplier acceptance、哪些 Seller 改價後需要新的 `DistributionAcceptance`、哪些退款或 chargeback 需要成員 A4，以及哪些 transfer 是 `result_unknown`、需要 reconciliation。

收款方一律是 `SellerParty`，使用自己的 `seller_collection`；付款方使用 payer-owned `payer_disbursement`，受款方使用 beneficiary-owned destination。平台不做 merchant of record、escrow、wallet 或代收，不申請、不持有任何 merchant／live payment 帳號，只保存 ref、digest 與 fact。Money 的權威事實在 Seller 的 provider／bank。

平台預設 `money_movement_enabled=false`，每個 Seller 是 `record_only`。同一 exact `SettlementMandate` 同時具備 Payer 當事人（reseller 情境下通常即 Seller）的成員 A4 與 Ted 付款類一鍵 A4，且符合 active bounds 時，才可使用 `authorized_mandate`。對不上 provider 回條就保留 `result_unknown` 並查詢，不讓 Agent 再轉一次碰碰運氣。

第一家 Store 是 O2：SellerParty 建議預設為 Ted，五人共同閱讀時確認，也可改為五人中任一人；Store 使用 Seller 自有 origin 與綠界 ECPay sandbox，Freedom 帳號只放 reference mode、無 checkout 的 Master Store。其他 Seller provider、成員 repo、BYOK key、Squad storage 與 coach 收款是 O3，由各自 owner 建立。

## 10. Foundation Day 1 與後續階段

`08 §13` 是唯一 Infrastructure Ready 清單。Day 1 不是只做討論：Ted 同次完成 O1 付款／帳號與 O2 角色帳號，production 和 staging resources 都建立；AI 隨即完成可自動化設定。安全設定同日啟動並持續產生 evidence。

| Day 1 owner 類別 | 範圍 |
| --- | --- |
| O1 平台基礎設施 | GitHub org／GHEC／App、Cloudflare 全套、PostgreSQL、KMS／HSM signing planes、password manager、LINE、Discord、transactional email、monitoring、e-sign evidence archive、R2、平台自用 AI／render quota 與 vendor billing identity |
| O2 第一個營運實例 | Ted 以角色身分建立第一個 SellerParty、綠界 ECPay sandbox、Seller 自有 Store origin 與 Freedom 品牌 X／Meta／YouTube ChannelConnections；品牌 campaign／account owner 建議預設為 Hao，五人共同閱讀時確認 |
| O3 成員／Seller／Squad 自有 | 平台不購買其他 Seller provider、成員 repo、BYOK key、Squad storage 或 coach 收款帳號；只提供 contract tests 與 deterministic mocks |
| O4 事實權威 | Money 在 Seller provider／bank，code 在 GitHub，chat 在 Discord／LINE，客戶 raw data 在 client／Squad storage；平台只存 ref、digest、fact |

Break-glass co-owner 建議預設為 Mini，第二 Super Administrator 與 offline recovery custodian 建議預設為 Jason；所有分工在五人共同閱讀時確認。邀請在 Day 1 寄出，使用既有、可獨立恢復、非 Freedom domain 的 email；接受狀態只影響 `recovery` 標籤。Signer A／B custodian 的建議預設分別是 Ted／Mini；technical planes 同日建立，不同自然人 custody evidence 缺失時 `production-signed=false`，建置照常。

Production 保持零 public traffic，直到 Ted 對 exact release 做對外正式發布的一鍵 A4。帳號或資源存在不等於功能上線。Day 1 之後按技術依賴推進 1A、1B、1C 與 2；日期和週數只作建議預設。

## 11. 幹部只要記得的操作原則

1. 階級表示能力 evidence，職務表示有 scope 的代表權；兩者分開保存。
2. 五人核心團隊依建議預設分工各自 own track，並在五人共同閱讀時確認；Ted 的 Day 1 不等待共同閱讀。
3. Agent 是加速器，不是第二個獨立的人，也不是 signer、reviewer 或 payee。
4. 成員 A4 與 Ted 三類 A4 要分清楚；兩者都看 exact digest，不能用聊天訊息代替。
5. `official`、`production-signed`、`commercial-ready` 與 `recovery` 是 evidence labels；false 不阻擋 candidate、staging、sandbox、內部 demo 或發布準備。
6. Money、code、chat 與 client raw data 各留在 O4 權威系統；平台只保存必要 ref、digest 與 fact。
7. Domain Skill 缺任一 authority、QC、revocation、roots-set 或 isolation evidence，就回 `capability_unavailable`。
8. Day 1 依 `08 §13` 一次建立 O1／O2 與 production／staging 地基；是否上線由可查 evidence 與 exact release A4 決定。

欄位與 API 回到 `01 §3.4`、`03 §3`、`04 §10.3.1`、`06 §6` 與 `08 §13`；本文只負責讓幹部看見現行目標日常。
