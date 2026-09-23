# 現行需求基準（Normalized）

> 狀態：現行 canonical baseline（2026-09-19 低維運互惠修訂）；planning 文件，不代表已部署。

> 2026-09-23 會員入口修訂：Ted 明示新註冊會員必須完成重新設計的定位，再選主力公會、領技能書、進入平台。這項指示取代本 planning baseline 對新會員的 optional assessment／可略過入口；保留本人選擇公會、無診斷／資格推定、平台不過手錢等邊界。實作與其餘本輪決定見 [會員入口修訂](../development/member-onboarding-release.md)。

日期：2026-09-19
代號：`SRC-CURRENT`

## 1. 交付目標

交付一套可拆 epic、寫 contract、讓多組人與 AI agent 平行開發及驗收的 Freedom 大平台詳細計畫，包含：

- 社群、組織、職業、會員成長、貢獻與得利模型。
- 八個使用者模組，以及其共同依賴的 operating cores。
- 每個模組的 owner、資料、API、event、state、畫面、外部接點、例外及驗收。
- workspace／repo、code ownership、技術依賴、PR／review／release 與分頭開發方法。
- 一個以 public canonical source 發布、可由 Codex／Claude Code／Grok 解析的共同 `freedom-build-system` 控制 Skill；三種 CLI 驗同一 signed channel、root package、publisher-resolved exact dependency closure、FreedomPlanBundle、ContractBundle 與 current revocation state，並從同一 immutable activation 開始 build。
- Discord、LINE、GitHub、Storefront、seller-owned payment、行銷與 AI/media provider 的串接契約。
- 既有 `ai-online`、`positioning-companion`、`freedom-party-guild-lounge` 與其他附件的採用、重寫、migration 或退場方式。

交付物是 plan/spec；machine-readable 檔案是 implementation 起點，不代表 production 已完成。

### 1.1 P1–P13 地基原則

Ted 第一則原話：

> 我看了一下我不喜歡你們的設計方式。1. 我們是人不是 AI 我們不需要 try and error，我們說要做就是要做了，我們不用一步一步等著試，該買什麼就買，我們不用有什麼 plan 叫做想清楚 domain 才能買 domain，或驗證什麼能通才買 cloudflare，對我們來說就是先開了先買了就對了，讓大家可以 work，真的不需要回頭再關掉，這樣才對。請以這種概念重新設計。

Ted 第二則原話：

> 不要做任何會擋案子進行的閘門，人與人的對接很浪費成本，尤其在開源社群，這些都要儘量省掉。

Ted 第三則原話：

> 一開始的地基就要打廣並且打深，然後整個形狀都要做出來。反而是細節可以慢慢補上。因為這不是一間房間一間房間的裝潢，這是一個大型系統的地基和規劃，你不把整個框架做對慢慢疊代出細節，最後就是義大利麵。

1. **P1 決定即執行。** Day 1 同一工作天完成全部帳號、domain、付費方案、雲端資源、provider 與 channel 的購買或申請；可用性檢查與修正同日進行，不構成前置停點。
2. **P2 只有技術依賴。** 只有「A 必須存在，B 的 API 才能建立」可排序；報價、人選、會議、演練或 review 都不控制工作是否往前。
3. **P3 買最終方案。** GHEC、Workers Paid、多年期 domain、production＋staging PostgreSQL、外部 KMS／HSM 與全部 provider 一次開齊，不以免費 prototype 取代；O1 由平台買、O2 由 Ted 以角色身分開、O3 由成員／Seller／Squad 自有。
4. **P4 安全設定同日做。** 帳號建立後立即設定 2FA、security key、recovery、least privilege、billing alert 與第二管理員邀請；第二人是否已接受只影響 `recovery` 標籤。
5. **P5 人事說要就要。** 五人核心團隊依 `06 §3.1` 的建議預設分工持有 tracks；holders 與 custodians 在一次性五人共同閱讀時確認。Ted 的 Day 1 不等待共同閱讀，AI agents 承擔草擬、建置與審查。
6. **P6 Infrastructure Ready 只有一種。** `08 §13` 的單一清單記錄整套真實地基是否存在；它不是 production readiness 或 release approval。
7. **P7 AI 與人的邊界。** AI 不採購、不決策、不簽 A4，也不建立需真人身分的帳號；人完成登入、付款、邀請與 Ted A4，AI 接手其餘可自動化設定。
8. **P8 衝突直接改 canonical。** 與 Ted 明示決策衝突的 planning 內容直接寫成現行決策，不保留舊分支或並列說法。
9. **P9 誠實。** 價格只用 `08 §3.3` 的 canonical 數字或「採購時查價」；所有 test 均為「未跑」；帳號存在不等於功能上線。
10. **P10 零阻擋閘門。** 採購、建置、契約、實作、社群貢獻與發布準備持續前進；CI、contract tests 與 AI 審查在背景產生修正工作。Ted 的人類簽名點只有付款、法律文件與對外正式發布三類。
11. **P11 最少人際對接。** 五人確認建議預設分工後各自 own track，不設委員會、多人簽核或定期會議，也不排真人 review 時段；Grok adversarial review、Claude verification 與自動 checks 處理平台自身建置，Ted 只處理 P10 的三類 A4。
12. **P12 名冊不是前置。** 不同自然人的條件只控制 `official`、`production-signed`、`commercial-ready` 標籤，不控制工作、candidate、staging、sandbox 或內部 demo。
13. **P13 地基廣、深、全形狀。** 階段 1B 建全形狀，階段 2 補垂直細節；全形狀涵蓋 56 packages、9 repos、12 runtimes／consumers、四個 product repo templates／adapters、五個 cores 與全部 seams。

### 1.2 2026-09-19 運作原則修訂（RQ-066–RQ-071）

本次要求為：不依靠大量人力維持、保留共同參與能量與機會、讓使用者互助得利。下列修订適用所有模組與原則解讀，細則見 [12](./12-low-ops-mutual-benefit.md)：

- P11 減少行政對接，不減少有價值的共同解題；以既有 Squad／cohort 承載共同成果，不新增治理層。
- 不阻擋一般參與，不等於無容量也能承諾真人服務。Appointment 是資格、accepted capacity 是可供給時間，兩者分開。
- 每張新公開互助工作明列雙方實益、最大投入與結束方式；志願／有限互助／有預算工作分開，不把XP或未來案源當保證報酬。
- 工時分平台維持、協調摩擦、共同工作與付費履約；前兩者統計核心及其他會員，不能用委派隱藏維持成本。
- 完整地基與所有技術介面保留；首批並行驗證有限互助，以及自願作品曝光 → 商機 → 合作 → Seller 外部實收。找客戶不以前置免費互助次數為門檻；沒有已接受容量及資源，不額外承諾真人服務。詳見 `12 §9`。
- 真人實益、非核心依賴、總工時及資金證據決定是否擴大服務承諾；不構成會員資格或一般開工門檻。既有付費、安全、付款與正式權益責任不自動到期消失。

## 2. 平台定位與八個使用者模組

Freedom Platform 是社群的接點、canonical database、所有 codebase 的核心索引、工作與財務事實帳本，以及會員／組織／agent 查看 `Now / Next / Gained` 的狀態機。它不取代 Discord、LINE 或 GitHub。

八個對外 experience modules 是：

1. 定位模組。
2. 貨品上架／供應商／QC／分潤模組。
3. 電商平台模組。
4. 可導入電商的自動行銷模組。
5. 作為行銷擴充的自動剪輯模組。
6. GitHub 技能包、開源產品、版本、維護者、分級與讀書會模組。
7. 會員管理與個人狀態模組。
8. 接在定位後的陪跑模組。

八個模組共用 Organizations & Professions、Opportunity/Project/Task、AI Agent Control、QC & Commercialization、Distribution & Settlement 等 operating cores；它們是共用能力，不重複包裝成新使用者模組。

## 3. 組織與職業模型

- `Guild` 是長期縱向專業組織，負責方向、知識、訓練、人才接續、專業 skill repos 與模組 stewardship。
- `Squad` 是因 `Opportunity`／`Project` 組成的短期橫向交付團隊；交付完成即可解散，成員仍留在各自 Guild。
- 一個人可以加入多個 Guild，在每條專業分別持有 `Runner → Strategist → Master` 階梯，並裝備不同 SkillPackage、以不同 acting role 接不同 WorkItem。
- `Master` 是可由證據取得的專業階級；`Officer` 是有任期、範圍與交接責任的治理職務，不能互相冒充。
- 每個模組有一筆 active `ModuleStewardship`；建議預設 holder 依 `06 §3.1` 分布於五人核心團隊，並在五人共同閱讀時確認。
- Guild 加入是 self-service，直接建立 `runner`；Master 通知只提供協助，不是 admission approval。

### 3.1 Open AI Product & Skills Division

開源技能與 AI Product Forge／Implementation 是同一個 Division，下含三條彼此獨立的專業 Guild：

| Guild | 主要貢獻 | 主要技能 | 可得到的優先機會 |
| --- | --- | --- | --- |
| AI Vibe | 寫系統、修 code、建立與維護開源產品 | AI vibe coding、架構、測試與 release | 客製開發、商業版、產品開發 Squad |
| AI Field / FAE | 測試、review、現場 feedback、推廣、部署與支援 | 可重現測試、修改 code、產品熟悉度、導入能力 | FAE、導入、維護、support Squad |
| AI Project | 帶入商機、需求與客戶溝通、產品銷售、協調交付 | PM、提案、scope、sales、客戶與 Squad 協作 | 軟體銷售、專案管理及商機分配 |

Vibe、Field、Project 的建議預設 holder 分別是韋銘、Jason、Mini，五人共同閱讀時確認，完整分工見 `06 §3.1`。三個不同自然人承擔時，`commercial-ready=true`；否則維持 false，工作與發布準備仍持續。三位 Guild Officers 組成 Division Product Council，不增加第四層主管。

## 4. 知識、服務與 QC 邊界

- 專業知識、技能文件、社群教學與一般 Guild 訓練維持開源／免費；專屬於一人的時間、陪跑、責任、客製、部署、代管、算力或 SLA 可以收費。
- 定位與陪跑由同一 Talent & Direction Guild 負責。定位指出方向，Guild 負責把人教會；付費陪跑購買專屬時間與容量，不是購買被鎖住的知識。
- 任何人都能送出商品、技能、repo 或 PR candidate；candidate 可見、可討論、可改進。`official` 取決於 exact version／commit／batch 的 QC evidence 與獨立自然人 reviewer 標籤；標籤為 false 不影響 candidate 流程。
- 結構有效且提交者本人確認的首次 software／Skill／code candidate，直接建立 AI Vibe Runner `ProfessionMembership` 與起始 evidence；不因此推定 submission accepted、QC 完成或 rank 提升。
- 開源軟體／SkillPackage 的 community testing、review 與 QC 不收 review fee；客戶出資的 testing／review 是另一筆 `ServiceEngagement`。
- 實體或第三方貨品的專業檢驗可以由 Product Quality & Supply Guild 定義檢驗費；費用與 QC 結論分開記錄。
- 客戶或 sponsor 帶入 funded testing、review 或 development 時，由該案 Squad 協議 scope、費用與 `EngagementAllocationPlan`。
- PR、review 或開源貢獻不自動產生產品 ownership、永久 royalty 或專案款；著作權與授權以 source repo／license 為真相。

## 5. 商業主線與 Seller 模型

平台同時支持成品販售、開源 AI 產品商品化、AI implementation／managed service，以及各行各業的 Professional Service with AI。金流與帳號 ownership 依 `05 §5.8` 與 `07 §5`：

- 平台是接點、database、code base 協作核心與狀態機；O4 外部事實權威固定為 money 在 Seller 的 provider／bank、code 在 GitHub、chat 在 Discord／LINE、客戶 raw data 在 client／Squad storage。平台只保存 ref、digest 與 fact，不建立第二份外部權威。
- `Master Store` 是可 fork 的參考商店、catalog 與部署範本，以 `reference` mode 放在 `<org>.github.io/freedom-storefront/`，沒有 checkout。
- 每個實際 Store fork 綁定一個 `SellerParty`、Seller 自有 origin 與 `seller_collection` connection；第一家 Store 由 Ted 作為 Seller fork，建議預設部署在 Seller 自己的 Cloudflare 帳號／Pages。
- 一次 checkout 只有一個 buyer-facing biller；不同 Seller 的商品分開 checkout。同一 Seller 可販售多個 Supplier 商品，`BuyerOrder` 依 Supplier 拆為多筆 `SupplyOrder`、settlement 與 fulfillment。
- 收款方一律是 `SellerParty`，付款方用 payer-owned `payer_disbursement`，受款方用 beneficiary-owned destination。平台不申請、不持有 merchant／live payment 帳號，不做 escrow、wallet 或代收。
- `money_movement_enabled=false`，每個 Seller 預設 `record_only`。`authorized_mandate` 僅在 `money_movement_enabled=true`、Payer 當事人已對 exact `SettlementMandate` digest 簽署成員 A4，且 Ted 已對同一 digest 完成付款類一鍵 A4 時可用；缺任一條件即維持 `record_only`，商店、listing 與對帳照常。每筆執行仍受 active mandate、cap、idempotency 與 reconciliation 約束。
- Supplier 以 `DistributionAcceptance` 接受 exact `SellerListingRevision`、實售價格與供貨條件；改價需接受新 revision，future revoke 不推翻短效 reservation 或已付款訂單。
- `MSRP`、平台建議售價與 `recommended_floor` 是透明建議，不自動封鎖價格。
- 商品零售分配由 versioned Offer／Distribution Agreement 決定；服務、導入或客製案由 Squad 簽 `EngagementAllocationPlan`。

Seller／Supplier 所在地、seller-of-record、發票、退款與稅務責任由具名專業角色確認；此確認作用於 arrangement、listing、provider 或 release，不作用於會員、candidate、sandbox 或一般貢獻。

## 6. AI-first 工作方式

| Requirement | 規則 | 來源 |
| --- | --- | --- |
| `RQ-058` profession-scoped XP read model | `XpPolicyVersion` 版本化且公式可讀；`MemberProfessionXpProjection` 只由 append-only `ContributionRecord` 與 review outcome 重建，固定分 `training\|maintenance\|real_delivery`，不跨 profession 加總，也不作 EntitlementSnapshot、rank、reviewer appointment 或 A4 的輸入 | Ted 明示方向；ADR-059 |

- SkillPackage 是人與 agent 共用的可執行工作說明；所有模組把可做工作發成 versioned `WorkItem`，由 Portal 與 GitHub 雙向追蹤。
- agent 依 principal、profession memberships、equipped skills、work intent、availability 與授權取得 Daily Work Feed。
- AI 可提出下一步、做 preflight、認領 bounded task、建立 branch／commit／draft PR、產生 listing 或 campaign draft。
- agent 不是會員、Master、締約人或收款人；每個動作代表一個 human／organization principal 與明確 acting role。
- 成員 A4 語意維持：Seller listing revision、Supplier `DistributionAcceptance`、Squad `EngagementAllocationPlan`、`SettlementMandate`、ProjectRelease approval 等由該當事人對 exact digest 簽名。Ted 對平台自身付款、法律文件與對外正式發布簽 A4。
- A0–A3 可在 bounded `ExecutionGrant` 內執行。所有外部副作用都有 ActionIntent、冪等鍵、provenance 與結果；平台不保存 agent chain-of-thought。
- GitHub 評價只有在本人決定、grant 明示 `github.star` 並由本人 AgentConnection 執行時才可建立或撤回；平台觸發、批量、獎勵導向或 XP 誘導的互動不進 XP。
- 外部 intake 建立 owner-private `SubmissionDraft` 與最小來源 reference；external message 不是 A4。Bound local Agent 以 owner-side authority 取得 exact revision、重算 digest 並回 fenced provenance receipt。

## 7. 外部場域與 source of truth

- Discord：討論區、讀書會與群體現場；bot 可建立 owner-private 進件草稿與 deep link，不直接建立 WorkItem。
- LINE：即時提醒、陪跑、客服與 deep link；一般聊天回覆不構成付款、QC 或合約簽名。
- GitHub：repo、Issue、commit、branch、PR、review、checks 與 release 的版本真相。
- Freedom Portal：身份連結、profession、work intent、Opportunity／Project／Squad、tasks／grants／signatures、非 code artifact review、個人狀態與帳本真相。
- Platform database：保存必要 domain facts、external references、receipts、events 與 projections；不鏡像 Discord／LINE 全文，也不保存 provider secret 明文。
- 客戶 raw data 留在 client／Squad storage；Platform 只保存 opaque ref、digest 與最低 consented metadata。

## 8. 輕量但可擴張的治理原則

- 不用 AI、KYC、委員會、總分或付費狀態阻擋註冊、公開討論、學習與一般貢獻；QC 是產品責任，不是對人的 admission 條件。
- 每個 playbook item、status 與 readiness 欄位使用 `enforcement=navigation|action_gate`；預設 `navigation`。`action_gate` 只拒絕當次不成立的 action，並回傳原因、修法與重試路徑，不是工作停點；allowlist 可依標籤語意調整，enum 名維持 `action_gate`。
- 加入既有 Guild 由本人直接建立 Runner ProfessionMembership；歡迎、實裝回報與卡點通知是可略過的 assistance automation。
- authentication、authorization、schema/state、signature、money/ledger、idempotency、file/runtime safety、rate/quota/cost limit 是 action-level invariants。
- 路線、工作模板、QC protocol、委派範圍與推薦規則採 versioned configuration；歷史訂單、簽名、成果與財務快照不可回寫。
- 現行採五人核心團隊；Ted 持有 infra／platform／設計／建置 owner 與三類 A4，其餘 office、custodian、reviewer 與 delivery tracks 依 `06 §3.1` 的建議預設由 Hao、Mini、Jason、韋銘分持。具名分工只調整責任與三個自然人標籤，不改變系統形狀。
- 爭議、安全事件及 scoped entitlement 暫停由人處理，保存理由與恢復路徑；收回權益不刪除人、作品或歷史。

## 9. 來源優先序與驗收

來源優先序：Ted 明示決策 → 本 baseline → 其他 planning 文件、來源附件與 legacy code。與前兩者衝突的材料只是取材或 migration input，不綁住 target design。

現行規劃驗收條件：

1. 每個使用者模組都有 accountable ModuleStewardship，以及 entity、command/API、event、state、projection、接點與 degraded path。
2. Guild／Squad、rank／office、一人多職與各職業的貢獻、獲得、技能及接續方式可追溯。
3. 社群成長、開源產品商業化、單一 Seller checkout／Supplier settlement、Professional Service 四條閉環有明確契約。
4. candidate、`official`、`production-signed` 與 `commercial-ready` 標籤分開；標籤不足不阻擋工作與發布準備。
5. agent 能依 WorkContext、Skill 與 WorkItem 工作；A0–A3 有 bounds，A4 綁 exact artifact／digest 與相應真人。
6. 文件清楚區分 target、legacy current、working default、現行假設與已驗證證據。
7. 兩個 publisher／installer reference implementations 與三個 CLI adapters 以相同的 channel artifact、channel statement、keyset-chain、bootstrap-index artifact、bootstrap-index statement、active policy、revocation artifact、revocation statement 八項輸入，產生相同 root Skill、publisher-resolved exact dependency closure、PlanBundle、ContractBundle 與 `activation_digest`；不得對 mutable registry 重新解析。任一輸入、QC、revocation 或 isolation 驗證失敗都 fail closed 且零 domain execution；既有 sealed session 只可在原 grant／lease 內使用原 generation 收尾，不得 mid-run 混版。

產品、runtime、整合與真人試行測試仍為「未跑」。本次文件／契約靜態檢查的實跑狀態另見 `verification/2026-09-19-revision-check.md`，不得用它代替產品驗收。

## 10. Foundation Day 1、Hosting 與 Project Factory

`08 §13` 是 Foundation Day 1 的現行 runbook；它把 O1／O2／O3 帳號 ownership、唯一 Infrastructure Ready 清單與技術依賴順序合在一起：

- Ted 同次買齊 O1 平台基礎設施，並以第一個 Seller 身分建立 O2 的 `SellerParty`、Seller-owned 綠界 ECPay sandbox 與 Seller-owned Store origin；Freedom 品牌 X／Meta／YouTube `ChannelConnection` 是 Hao 的獨立品牌 lane，Hao 當日不便時由 Ted 以品牌名義先開並同日移交 owner／admin。以上分工為建議預設，五人共同閱讀確認；Ted 的 O1 與 Seller lane 不等待任何人。O3 由成員／Seller／Squad 自有，平台只提供 contract tests 與 deterministic mock。
- O4 固定外部事實權威：money 在 Seller provider／bank、code 在 GitHub、chat 在 Discord／LINE、raw data 在 client／Squad storage；平台只存 ref／digest／fact，且不申請、不持有 merchant／live payment 帳號。
- production 與 staging resources 同日建立；production 保持零 public traffic，直到 Ted 對 exact production release 簽 A4。
- AI 完成 O1／O2 帳號與 resources 的可自動化設定、IaC、9 repos scaffold、四個 Queues、12 runtime resources、Connection／ResourceBinding，以及 adapter sandbox 能力與 smoke 真連；完整 provider request／webhook／reconcile 流程與 evidence 留在階段 1C。
- 安全設定同日啟動並持續執行；結果只控制 `SLO`、`production-signed`、`recovery` 與 public traffic。
- 後續依序為階段 1A 契約凍結、1B 全形狀 skeleton、1C 真實 sandbox 接線、2 垂直細節與發布成熟度；階段 1B 建立 56 packages、9 repos、12 runtimes 的可啟動 skeleton，並涵蓋四個可 fork product templates／adapters、五個共同 cores 與全部 seams，階段 2 補垂直細節與發布成熟度；順序只由技術依賴決定。
- 五個 first-party product repos、四個 governance repos 與每個可獨立維護／fork／deploy 的 `freedom.project.yaml` 依 `02 §4` 與 `08 §6`。
- 日常 provider 操作面使用 `gh`＋`wrangler`；共同 Skill、PlanBundle 與 ContractBundle 綁 immutable release 與 signed activation。
- 公開 project page 是 status-neutral artifact；official 狀態由平台的 signed attestation 即時判讀。GitHub Pages 不承載登入、API、交易、credentials 或 production application runtime。
- 正式帳戶、repo、資源、部署與功能目前均不宣稱已建立或上線；建立事實由 `08 §13` evidence 欄與 `09 §1` inventory 記錄。
