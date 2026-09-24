# 決策、風險與需求追溯

> 狀態：現行 canonical baseline（2026-09-19 低維運互惠修訂）；planning 文件，不代表已部署。

日期：2026-09-17

## 1. 權威、狀態與 no-gate 邊界

### 1.1 衝突處理順序

若文件、附件與 repo 說法衝突，依下列順序處理：

1. Ted 的明示決策。
2. [`00-current-requirements-baseline.md`](./00-current-requirements-baseline.md)。
3. 本 planning baseline 的 ADR、domain invariants 與 machine-readable contracts。
4. 其他 planning 文件與來源附件。
5. 既有 repo 的 code、schema 與 tests；它們只描述 legacy current behavior。

`target`、`legacy current`、`verified evidence`、`working default` 與現行假設分開。帳號存在不表示功能上線，sandbox 不表示 live。產品／營運／真人測試仍待跑；契約 fixture 與本機 scoped runtime milestone 另見 `verification/2026-09-19-revision-check.md` 與 [`docs/releases/2026-09-20-local-core.md`](../releases/2026-09-20-local-core.md)，不得解讀為產品驗收、部署或真人證據。

### 1.2 P5／P10／P11 五人分工、零阻擋與最少人際對接

採購、建置、契約、實作、社群貢獻與發布準備照常前進；不以 AI、KYC、委員會、手機、活躍度、總分、付費狀態、人選或真人 review 排程阻擋工作。QC 是產品責任，不是對人的 admission 條件。

P5 的角色供給由五人核心團隊直接承接：Ted、Hao、Mini、Jason、韋銘的 holder 分工都是建議預設，在一次性的五人共同閱讀時確認；確認後各自 own track。這次共同閱讀不是工作條件，Ted 的 Day 1 付款、帳號、infra、platform 與建置照常一次完成，也不建立固定會議。

平台自身建置由 Grok adversarial review、Claude verification 與自動 checks 處理。Ted 的人類簽名點只有付款、法律文件與對外正式發布三類 A4。成員對 Seller listing revision、Supplier `DistributionAcceptance`、Squad `EngagementAllocationPlan`、`SettlementMandate` 與 ProjectRelease 等 exact digest 的 A4 維持產品語意。

不同自然人的條件只控制三個標籤：獨立 QC reviewer 控制 `official`、Signer A／B custodian 控制 `production-signed`、Vibe／Field／Project 控制 `commercial-ready`。標籤為 false 不阻擋 candidate、staging、sandbox、內部 demo 或發布準備。

系統仍拒絕當次不成立的 action：

- actor、principal、scope、authorization 或 exact signature 不成立。
- schema、state transition、version、digest、concurrency 或 idempotency 不成立。
- price、payment fact、settlement、refund、ledger 或責任快照不一致。
- 檔案、code execution、credential 或資料存取威脅系統安全。
- provider rate、quota、cost cap 或 bounded mandate 不足。

拒絕只作用於該 action，回傳原因、修法、重試或人工處理路徑；不得自動懲罰整個人。定價、seller-of-record、發票、稅務、退款與金流安排的專業確認作用於 arrangement、listing、provider、release 或 policy version，不作用於會員。

### 1.3 2026-09-19 現行運作修訂

本次使用者要求低維運、共同參與、互助得利，並同意修改本ZIP；僅採本次資料與檢視，不引入過去個人記憶。`00 §1.2`與`12`解析P10／P11：不阻擋一般工作，不等於對無容量服務做承諾；減少行政，不取消共同解題、需求交流或外展。四條技術價值循環與 56 packages／9 repos／12 runtimes 保留；原四線同步營運 seed 改為兩條平行的首批驗證路徑（有限互助，以及自願作品展示／外展／商機／合作／外部實收證據）。

本次文件修改與本地驗證由本修訂工具執行；不宣稱原規劃的Grok／Claude reviewer、任何具名holder或真人試行已執行。契約 fixture 與本機 scoped runtime 另見 verification 與 [`docs/releases/2026-09-20-local-core.md`](../releases/2026-09-20-local-core.md)；不登錄通過數。

### 1.4 2026-09-23／24 使用者決策與實作對照

以下增補不改 ADR／OD／RQ 的穩定 ID，只記錄後續 Ted／使用者決策如何覆蓋或延續既有條目。實作證據與分類見 [2026-09-24 計畫對齊](../development/audit-2026-09-24-plan.md)。

| 條目 | 現行決策 | 狀態 |
| --- | --- | --- |
| ADR-039／RQ-010「定位可跳過」 | 9/23 起新會員必須完成封閉式定位；不連帶恢復其他入會考核 | 已實作；見 `00` 標頭 |
| ADR-006「LINE Login 為第一 adapter」 | 使用者 9/23 明示改為 email 註冊，已覆寫舊計畫；GitHub OAuth 只連結 Star 與開發身分，不是登入 | 已實作並修正 ADR-006 本文；LINE Login 只是後續 adapter 需求，不再待決 |
| ADR-053／ADR-058（自助入會、有界 grant） | 加入 `guild_ai_vibe`／`guild_ai_field` 取得技能開發 grant；加入 `guild_platform_engineering` 取得平台開發 grant；最後一個資格來源消失時撤銷 grant 與衍生 key，舊 key 不復活 | 已實作（migration 030）；不需要管理員核准 |
| 站內技能書編修（root 9/24 決定） | 需同時有 AI 開發或 AI 導入與驗證公會有效會籍，以及該書既有具名維護者任命；一般 `skill.submit` 投稿與公開閱讀不變 | 本輪修改中（ops 組）；同交易讀寫、replay 與離會鎖的證據待整合後由 root 補 |
| ADR-034／ADR-050（憑證不外流；broker＋KMS） | GitHub user OAuth、App installation（只有 `starring:write`＋`metadata:read`）與工坊 `development:propose` key 分層 | 分層已實作；token 目前用環境金鑰 AES-256-GCM 加密，broker／KMS 仍是後續實作 |
| ADR-065／RQ-064（只允許本人真實 Star） | 使用者明確要求「先 Star 才能領書／推廣」 | 尚未落地；建議替代尚未獲同意。GitHub AUP §4 列有 rank abuse 與 incentivized inauthentic 條款，但沒有針對本案的裁定 |
| ADR-048、`08 §8`（fork lineage） | 37 本書、43 個原作 repo 保留作者與授權；Star、Fork、PR 指向原作 | 已實作；作者授權確認屬外部證據 |
| ADR-045／046、OD-01（GHEC＋Workers＋PlanetScale） | Beta 暫用 Node＋PostgreSQL＋Cloudflare Tunnel | 過渡拓撲，不推翻目標 |

## 2. 來源 inventory 與現行事實

本規劃的決策權威是 Ted 明示決策與 `SRC-CURRENT`；其餘 artifacts 只供模型、風險、migration 與 legacy behavior 取材。

| Source ID | Artifact | 現行用途 |
| --- | --- | --- |
| SRC-CURRENT | [`00-current-requirements-baseline.md`](./00-current-requirements-baseline.md) | canonical requirements baseline |
| SRC-BRAIN | `開源AI職業成長社群與分潤平臺規劃-6c1bb937.md` | 社群哲學、角色、貢獻／得利、狀態與分配取材 |
| SRC-GUILD-DOC | `Freedom_Workshop_Guild_Lounge_Module_Deep_Dive_zh-TW-d00a0d64.md` | Guild Lounge 行為、安全與 migration 取材 |
| SRC-POS-DOC | `ai-online_MODULE_TECHNICAL_SPEC-6440d3af.md` | deterministic assessment 規則與 legacy 問題取材 |
| SRC-REV | `AI_Revenue_Sharing_Meeting_01_With_Engineering_Spec_v2-a3b6ee5d.md` | Seller-owned payment、歸因、commission 與 ledger 取材 |
| SRC-GUILD-ZIP | `freedom-party-guild-lounge-main-0b55653d.zip` | Lounge legacy source 與 assets inventory |
| SRC-POS-ZIP | `ai-online-master-75ce7f57.zip` | assessment legacy source inventory |
| SRC-POS-MAN | `ai-online_RULES_MANIFEST-61ad225a.json` | assessment machine-readable source index |
| SRC-POS-COMP | `positioning-companion-main-383902aa.zip` | guided discovery、positioning card 與 guardrail 取材 |

### 2.1 Legacy repo 現況與驗證狀態

`ai-online`：

- 現況是固定規則、自陳偏好的 assessment，不是 LLM、技能認證或工作資格判定。
- v2 有 15 題、56 個選項、8 個方向原型；Q14 多選 factor 為 `0.7`，各方向最大分不同，industry／不要清單不改 core score。
- 現行測試狀態：未跑。
- 已知 migration 問題包括 browser `no-cors` 樂觀成功、server 缺 auth/idempotency/recompute、payload/envelope drift、自由文字 analytics、XSS/identity linking 與危險 Sheet clear。

`positioning-companion`：

- 是 MIT 授權的靜態 Skill／文件／browser assets；沒有會員、付款、enrollment、平台 backend 或 canonical database。
- `scripts/validate_public.py`、對話模型品質、安全與平台整合驗證目前均未跑。
- 可採用：`user_words`／`ai_suggestions`／`unknowns` 分離、`first_evidence`、`falsifiable_check`、`no_product_alternative`、純文字 fallback 與 `content|workflow|business-amplifier|pause` modes。
- Target 以一份 machine-readable `positioning-card/v2` 統一 quick/full 輸出；原本分散在 prompt、runner templates 與 prose 的欄位不是多份 canonical schema。
- 對外只使用 advisory `evidence_state`；它描述方向證據是否充足，不授權、不收費、不擋會員。

`freedom-party-guild-lounge`：

- 現況是 React/Vite frontend、Cloudflare Worker、D1 三表與 R2 photos 的單場活動 app；不是中央會員、LINE、Discord、GitHub 或 Guild governance backend。
- clean build、`test:sites`、真實 D1/R2、browser、安全、load 與完整 E2E 目前均未跑。
- 已確認高風險：知道 key 即可讀任意 R2 object、原樣提供 `image/*` 可含 active SVG、participant create 的 check-then-write race 可被覆寫。

## 3. Architecture Decision Record

ADR 編號穩定供其他文件引用；`adopted` 表示 target design 已決定，不表示已實作或上線。

| ADR | Canonical decision | 狀態 | 主要後果 |
| --- | --- | --- | --- |
| ADR-001 | Platform 是身份／組織／工作／交易的接點、canonical database、core code index 與 `Now/Next/Gained` 狀態機 | adopted | Discord、LINE、GitHub 與 payment provider 保留各自外部事實；Portal 聚合必要 refs |
| ADR-002 | 對外維持八個 experience modules，共用五個 operating cores | adopted | Organizations、Work、Agent Control、QC/Commercialization、Distribution/Settlement 不重複造 User、Task、Order 或 Ledger |
| ADR-003 | 起步採 modular monolith＋background workers | adopted | 優先交易一致、部署與維護簡單；有負載／安全證據才拆 service |
| ADR-004 | 四個協作 workspaces、五個 first-party product repos、四個 governance repos、三個 legacy/reference repos | adopted | Product repos 是 `freedom-platform`、`freedom-agent-kit`、`freedom-storefront`、`freedom-growth-automation`、`freedom-skill-registry`；legacy 以 adapter/migration 處理 |
| ADR-005 | PostgreSQL 是 canonical relational store，S3-compatible storage 放 assets，Postgres outbox／jobs 起步 | adopted | 不先引進 Kafka、Redis 或 distributed transaction；projection 可重建 |
| ADR-006 | User/session provider-neutral；現行 default 是單一 email 註冊與登入（2026-09-23 使用者明示，覆寫 9/17 的「LINE Login 是第一個 adapter」）；GitHub 只做 Star／開發身分連結，不是登入；LINE Login 等其他 provider 是後續需求的 adapter，Discord/GitHub progressive link | adopted working default（2026-09-24 修正） | 不用 nickname、email 或聊天名 fuzzy merge identity；Ted 可替換 provider 而不改 domain identity |
| ADR-007 | Guild 是長期縱向 Profession 線；Squad 是一個 Opportunity／Project 的短期橫向交付隊 | adopted | Guild 維持知識、人才、training；Squad 完工即 close，不擁有永久 Guild 權力 |
| ADR-008 | Profession rank 固定 `Runner → Strategist → Master`；Officer／maintainer／reviewer／Squad Lead 是 scoped office | adopted | 一人可有多筆 `ProfessionMembership` 與不同 rank；rank 不自動授權、發錢或取得職務 |
| ADR-009 | 每個模組恰有一筆 active `ModuleStewardship` 與一位 accountable Master／Officer | adopted | Master 負責方向、人力、training、master skills、major release 與 succession；routine review/release 可委派 |
| ADR-010 | Open Skills/Maintainers 與 AI Product Forge/Implementation 合為 `Open AI Product & Skills Division` | adopted | AI Vibe、AI Field/FAE、AI Project 是三個 Guild；Guild Master 是 office，三個 Guild 的當期 Guild Master `OfficeAssignment` 持有人共組 Product Council，不另設第四位永久主管 |
| ADR-011 | 每個產品的 Vibe、Field、Project 是三筆 `ProductRoleAssignment`，由三個不同自然人承擔時 `commercial-ready=true` | adopted | Guild Master office 不占產品角色。平台自身軟體建議預設為 Vibe＝韋銘、Field＝Jason、Project＝Mini；Ted 作為 AI Vibe Guild Master 不衝突，也可另自任 Vibe，此時三人改為 Ted／Jason／Mini。標籤為 false 不阻擋工作、candidate、sandbox、staging、內部 demo 或發布準備 |
| ADR-012 | 公開知識、Skill、Guild teaching 與一般 software/community QC 免費；專屬人力、責任、算力、hosting、implementation、support/SLA 可收費 | adopted | 付費買 capacity/service，不把專業知識鎖在陪跑付款後 |
| ADR-013 | Product distribution split 與 paid project allocation 分開；不再假設所有收益都是 affiliate commission | adopted | 商品以 versioned DistributionAgreement／Offer 算；ServiceEngagement 由 Squad 簽 `EngagementAllocationPlan`，平台不訂統一費率 |
| ADR-014 | Contribution、Result 與 financial ledger 分開；不做 universal score | adopted | PR/QC 形成 evidence/familiarity，不自動形成 ownership、薪資、永久 royalty 或專案分配 |
| ADR-015 | 所有候選可提交／討論；version/commit/batch-scoped QC evidence 與獨立自然人 reviewer 控制 `official` 標籤 | adopted | 結構有效且本人確認的投稿保存來源、固定版本與起始 evidence，不自動入會；公會由本人另行選擇並確認。AI review 與自動 checks 不排隊，獨立自然人不足時標籤維持 false |
| ADR-016 | Software／Skill community review 一律無償；funded testing/review/development 另建 paid ServiceEngagement | adopted | Community QC 不存在付費模式；隱性客戶交付也不得包成免費 QC。費率、scope、acceptance、allocation 只由另案 Squad 明示協議 |
| ADR-017 | `CommercialEdition` 必須指向 OSS PackageVersion／repo commit、license obligations、QC 與 commercial mode | adopted | Open Source 可商業使用但不等於 proprietary；是否可用及義務依實際 license 判斷，[OSI FAQ](https://opensource.org/faq) 作共同概念參考 |
| ADR-018 | Platform 對 Agent 使用 principal chain、WorkContextBundle、WorkItem/Claim、AgentRun/TaskLease、ActionIntent 與 provenance | adopted | Agent 不是會員、Master、reviewer、締約人、legal signer 或 payee；不保存 chain-of-thought |
| ADR-019 | A0 讀／解釋；A1 draft/test/sandbox；A2 bounded reversible；A3 bounded public/channel；A4 exact consequential action | adopted | A0–A3 可由 scoped standing grant；價格／split、付款／退款、official QC、合約、代表本人對外且有精確承諾後果的具名申請、任何 official／production immutable release 需真人對 exact artifact/digest fresh signature。自助加入Guild、學習、裝備、一般submission、低風險WorkItem與Master welcome明文排除。純內部／non-production snapshot可用A1／A2，但不得用`v*` tag、public GitHub Release、production／Pages發佈或official標識。建立／變更 SettlementMandate 是 A4；符合其既簽 bounds 的 TransferJob 可自動執行 |
| ADR-020 | Human `Claim` 與 Agent `TaskLease` 分開；external effect 一律用 stable idempotent `ActionIntent` | adopted | Agent timeout 不釋放人的承諾；同一人用不同 Agent 仍不是獨立 review |
| ADR-021 | Platform 是 profession/work/business revision/signature/result/ledger truth；GitHub 是 repo/issue/commit/PR/review/check/release truth | adopted | Discord／LINE可建立owner-private SubmissionDraft／task proposal與deep link，不能直建WorkItem或terminal target；一般訊息不是A4 signature |
| ADR-022 | Opportunity 支援 lead、fund、investor、sponsor、product、sales、development 與 professional service | adopted | 外部機會不強迫搬入；需要平台 tasks/agents/ledger 時建最小 private `OpportunityStub` |
| ADR-023 | AI implementation／professional service 用 `ServiceEngagement` 管 Proposal、SOWVersion、Milestone、WorkPackage、Acceptance、ChangeRequest、Evidence、SupportPeriod | adopted | Paid delivery 有清楚 scope、驗收與 self-negotiated allocation，不靠口頭或 repo activity 推算錢 |
| ADR-024 | Master Store 是可 fork reference/catalog/template，以 `reference` mode 放在 organization GitHub Pages，不 checkout、不含 secrets | adopted | 每個實際 fork 綁唯一 SellerParty、seller-owned collection、Seller origin 與 contract version；第一個實例由 Ted 以 Seller 身分建立 |
| ADR-025 | 一個 checkout／BuyerOrder 恰有一個 `SellerParty` 與 buyer-facing biller；可含多 Supplier | adopted for launch | Platform 依 Supplier 拆 `SupplyOrder`、settlement、fulfillment；不同 Seller 必須先分 cart 再各自 checkout |
| ADR-026 | `SellingArrangement=reseller\|sales_agent` 必須快照六個責任欄位 | adopted; reseller launch default | `seller_of_record`、`payment_collector`、`invoice_issuer`、`refund_owner`、`price_owner`、`fulfillment_party` 不靠 UI 名稱推定 |
| ADR-027 | `msrp`、平台建議售價與 `recommended_floor` 都是 advisory | adopted | 不實作「低於建議價自動斷貨」。台灣公平交易法第 19 條及主管機關的[法規全文](https://law.ftc.gov.tw/law/LawContent.aspx?id=FL011898)與[轉售價格維持行為指南](https://www.ftc.gov.tw/upload/1090629-108.pdf)使固定轉售價安排必須依實際事實專業確認 |
| ADR-028 | Supplier 在 listing 可售前，以 A4 signature 接受 exact actual-price `SellerListingRevision` 與供貨條件，形成 `DistributionAcceptance` | adopted | 改價重簽；Supplier revoke 後不建新 reservation／order，已取得的短效 reservation 可在 TTL 內完成付款；已付款訂單不能只因已接受價格被拒絕。無 acceptance 時在付款前 disable checkout |
| ADR-029 | Platform 不接觸或保管買家資金；SellerParty 以 seller-owned collection 收款 | adopted | `seller_collection`、`payer_disbursement`、`beneficiary_payout_destination` 是三種 purpose-tagged authority；同一 provider account 可有多筆 binding，但 collection、disbursement、destination 三種 purpose-tag 不可互相推定。平台不持有 merchant／live payment 帳號，只保存 verified facts、obligations、state 與 audit |
| ADR-030 | Supplier／Commission／Service settlement 從 launch 就設計真正自動發起；預設 `record_only`，啟用條件見 ADR-063／OD-28 | adopted | Due obligation → typed SettlementInstruction → bounded Mandate → atomic UsageReservation → ActionIntent → TransferJob → webhook/reconcile；只有 confirmed SupplierPayable 授權商品履約，不支援 initiation 時進 `manual_required` |
| ADR-031 | Order、biller、price、distribution、DistributionAcceptance、refund 與 fulfillment snapshot immutable；Ledger append/reversal | adopted | Refund/chargeback 建 reverse obligation 或依已簽條款 net future settlement，不改舊單、不建平台 wallet |
| ADR-032 | `/storefront/v1` public BFF 位於 `freedom-platform/apps/platform-api` | adopted | Fork browser 只持 public store ID／短效 purpose token；server 重算 seller、price、split，secret 不進 fork |
| ADR-033 | 跨 repo worker 只走 scoped Job API，使用 short lease、monotonic fencing 與穩定 provider operation key | adopted | Worker 不連 core DB；provider 已接受但結果不明時進 `result_unknown/reconciling`，不盲目重送 |
| ADR-034 | Provider credentials 經 credential broker 以 connection ref、job lease/fence、audience、scope、TTL 兌換 | adopted | 長效 OAuth/API secrets 不進 job payload、event、log、browser 或 repo；不能縮權時由 broker proxy operation |
| ADR-035 | Money wire format 用 decimal string；DB/domain 用 bigint minor unit | adopted | JavaScript禁用浮點Number；price/payment/cap/payable/refund使用non-negative或positive型別，只有delta使用signed型別；SDK驗各自int64 range與正負限制 |
| ADR-036 | Launch 營運一個 Freedom community，但 canonical row/event/config/credential 都帶 `community_id` | adopted for launch | `community_id` 是資料／授權邊界，不是 repo workspace；仍測 cross-community IDOR |
| ADR-037 | Rules、route、QC protocol、delegation、price guidance 與 templates versioned；歷史 hard facts 不回寫 | adopted | 規則可淺顯異動且 prospective；不靠改 code 才換營運方式 |
| ADR-038 | 不以 automated compliance eligibility 阻擋會員與一般貢獻 | adopted | 保留 auth、signature、money、state、security、quota 等 action-level invariants；失敗只拒絕當次 action |
| ADR-039 | `ai-online` 是 optional deterministic assessment；`positioning-companion` 是 AI guided discovery SkillPackage | adopted | 兩者只產生 suggestion/draft；本人確認後才發布 CareerProfile/WorkIntent，不建立 paid enrollment、Entitlement 或 rank |
| ADR-040 | Positioning 用同一 `positioning-card/v2`；`content\|workflow\|business_amplifier\|pause` 是 strategy modes | adopted | 本業放大／pause 不是第九個 archetype；outward `evidence_state` 是 advisory，不作 admission／權限條件 |
| ADR-041 | Guild Lounge 併入 `community-events`／legacy adapter，不成第九模組 | adopted | event role/social energy 只屬單場 context；central identity、asset access、timer、archive 需重建 |
| ADR-042 | 不鏡像 Discord／LINE 全文 | adopted | 只存 binding、delivery receipt、明確 action/evidence 與 consented summary；核心流程有 Portal fallback |
| ADR-043 | Skill public visibility 與 automation readiness 分開 | adopted | Metadata candidate 可公開；requested capability 逐項驗證，正式可售仍需適用 QC/license/商業條件 |
| ADR-044 | Quota/BillingSource 與 Entitlement 分開 | adopted | 算力用完只停該資源操作，不移除身份、Rank、Guild 或無關權益 |
| ADR-045 | First-party repos 由 GHEC non-EMU Freedom organization 持有；個人帳號只作各自身份，vertical ownership 用 team／repo role／CODEOWNERS／ModuleStewardship | adopted working default | Day 1 建立 GHEC、GitHub App 與 9 repos；organization ruleset 綁 public `.github` 中央 workflow，secret／trust-root values 不進 public repo；採購與建立事實以 `08 §13` evidence 記錄 |
| ADR-046 | Launch 採 Cloudflare Registrar＋Workers／Queues／Workflows／R2／Hyperdrive，核心使用 Cloudflare-billed PlanetScale Postgres | adopted working default | Day 1 建 production HA＋staging；Postgres outbox／Job／lease 是 canonical state，Queue 只傳 ID 作 at-least-once wake-up；Ted 可替換 provider 而不改 application contracts |
| ADR-047 | 每個可獨立維護／fork／deploy 的 repo 有一份 `freedom.project.yaml`；GitHub Pages 由 manifest＋GitHub facts 生成 status-neutral release artifact，固定 widget 向 Platform 查 signed status | adopted | Post-release attestation 綁 repo／release／commit／assets／QC 並可過期或撤銷；public source repo 可發布 Pages，登入、API、transactions、credentials 與 runtime 不在 Pages；實作與測試未跑 |
| ADR-048 | Contribution／upstream variant 用 fork；新獨立 product 用 template；fork 永不繼承 official status | adopted；implementation 未建立 | Fork lineage 由 GitHub API 驗證；private／client project 預設禁 fork；official 只對 exact canonical release 生效；測試未跑 |
| ADR-049 | 日常 provider control plane 以 `gh`＋`wrangler` 為主要操作面；一個 signed channel 把 Codex／Claude／Grok 指向同一 Skill、plan 與 formal contracts | adopted | 本目錄 contracts 是 authoring source，`freedom-platform` repo 建立當日搬入並成為一份真相；PlanBundle 保存 byte-identical derived snapshot。`activation_digest` 的八輸入固定為 channel artifact、channel statement、keyset-chain、bootstrap-index artifact、bootstrap-index statement、active policy、revocation artifact、revocation statement；publisher 使用 pinned resolver，installer 不對 mutable registry 重解。任一輸入／revocation 驗證失敗都 fail closed 且零 domain execution；既有 sealed session 只在原 grant／lease 內使用原 generation 收尾，不得 mid-run 混版。Typed network profile、read-only cache、atomic pointer、session lease 與 isolated discovery 對三 CLI 一致 |
| ADR-050 | Dynamic provider tokens 採 per-record envelope encryption＋isolated Credential Broker；固定 KEK、GitHub App key 與 status-signing key 分離 | adopted working default | Ciphertext／wrapped DEK 在隔離 PG schema，root keys 不進 DB；production roots 使用外部 KMS／HSM。Broker 以四個 deploy-time bindings 指向四個 named WorkerEntrypoints，entrypoint 固定方法與 executor group |
| ADR-051 | External-document SubmissionDraft confirm 只記 owner 對 saved exact ref／revision／digest 的 acknowledgement，不作 remote fetch 或 current-byte assertion | adopted | Platform 已知 access-policy revoked 可拒絕該次 action，但 endpoint outage 不阻擋 confirm。Document WorkItem 綁 exact requirement；OpportunityStub 不授予 Agent access。Bound local Agent 在 owner 端 fetch／hash 並回 authenticated、lease-fenced provenance receipt；receipt 不替代 review／A4 |
| ADR-052 | Domain Skill runtime 的獨立 signed overlay 在階段 1A 固定 contract、階段 1B 建立完整 skeleton | adopted | Runtime mode 固定為 fail-closed 預設 `eligibility_and_provenance_only_v1` 與 `signed_isolated_overlay_v1`。Mode 與 exact set 由 server 選用，client 不得自報；signed overlay 以 2-of-N artifact 原子 pin exact domain packages／resolved closures、runtime-scope QC evidence、publisher authority／revocation 與 `runtime_roots_set_digest`，並以 per-run sealed namespace 載入。任一 QC、revocation、root-set 或 isolation 驗證失敗即回 `capability_unavailable`，且零 domain execution／consequential effect |
| ADR-053 | Guild加入維持self-service、初始`runner`；Master welcome/support不是admission approval | adopted；owner ruling | 不新增`applied`／`pending_master`／approval queue。Profession confirmed觸發歡迎與typed support cards；Master/Strategist略過零後果，不存在Master簽了才能繼續的路徑 |
| ADR-054 | 跨 entity 完整度採 versioned playbook＋per-instance readiness，逐 item／status／readiness 都有 `enforcement` | adopted | `navigation` 為預設；`action_gate` 只拒絕當次不成立的 action，不是工作停點；allowlist 可依標籤語意調整，enum 名維持 `action_gate`。不得形成完成率、總分、人身阻擋或 discoverability 懲罰 |
| ADR-055 | D1採單一stable-key onboarding bundle解opaque-ID chicken-and-egg | adopted | 一個idempotent transaction建立／回傳Runner membership、confirmed WorkIntent、equipped set與journey；server解析stable profession/package key並回所有opaque refs，任一version conflict零partial write。Standalone membership/equip mutation仍typed供後續使用，不是第一天必經串接 |
| ADR-056 | Launch entitlement 只有八個 canonical keys，與 catalog exact-set／conditions 一致，含 `store.deploy` | adopted | `01 §12`與catalog exact-set／conditions一致；rules ack只留notice，WorkIntent只做matching，不做人身claim資格；key或取得條件不得各自演進 |
| ADR-057 | 成員實裝是 member＋AgentConnection＋PackageVersion aggregate | adopted | package capability readiness、equip、MemberSkillInstallation與AgentRun四個事實分開；事件使用`equipped_skills.replaced`及`member_installation.*`。fail/degraded/outdated只導航，不revoke或降discoverability |
| ADR-058 | AgentConnection只給`agent.bootstrap.read`；第一天另有固定短效A0–A2 ExecutionGrant模板 | adopted | Connection token只讀本人最小Status／Feed；A1–A3皆需active grant。`day1.learn-equip-and-claim`≤72h、單profession/starter/first-work scope、可撤且不是A4或未來artifact signature |
| ADR-059 | XP採每profession、每track可刪除重建的read model | adopted；依 ADR-059 | `XpPolicyVersion`版本化且公式可讀；`MemberProfessionXpProjection`只讀append-only ContributionRecord＋review outcome，三軌closed set、不跨profession total，也不作EntitlementSnapshot、rank、ReviewerAppointment或A4輸入 |
| ADR-060 | `ReviewerAppointment` 是自然人取得 `qc.review:<scope>` 的唯一路徑；AI review 不建立該 entitlement | adopted | 五人核心團隊模式由 Ted 持有 appointment authority；`official` 的具名獨立 reviewer 是五人中非作者的任一人，建議預設韋銘，韋銘為作者時改 Mini 或 Jason。AI 與自動 checks 處理工作流，appointment 只決定 `official` 標籤；XP、rank 或熟悉度不自動任命 |
| ADR-061 | Accepted review 可以追加 retraction fact，不刪歷史 | adopted | AI checks 與 scoped appointment 驗證 retraction；不同自然人 evidence 只控制 `official` 標籤。Retracted result 退出 XP、matching priority、entitlement projection，舊 receipt 不得復活 |
| ADR-062 | Invite／claim、delivery、TaskLease＋fence、ExecutionGrant、evidence validity是五個不可共用的clock | adopted | lease 語意由TaskLease／lease proof物件承載，`expires_at`必與`fencing_token`同物件出現；WorkItem／Claim／Grant／evidence的`expires_at`永遠不是lease。其餘clock各自保存欄位、setter、expiry consequence及versioned extension；外部provider timestamp只作occurred/reconciliation evidence |
| ADR-063 | Seller settlement 有 `record_only|authorized_mandate` 兩個 mode，`money_movement_enabled=false` | adopted | `record_only` 只顯示「已記錄」；`authorized_mandate` 僅在 `money_movement_enabled=true`、Payer 當事人已對 exact `SettlementMandate` digest 簽署成員 A4，且 Ted 已對同一 digest 完成付款類一鍵 A4 時可用；缺任一條件即維持 `record_only`，商店、listing 與對帳照常。Active mandate、cap、idempotency 與 reconciliation 仍是 action invariants |
| ADR-064 | Review-required WorkItem 保留正交 review-capacity 導航狀態 ID `waiting_reviewer_capacity`，但 capacity 不控制 candidate 是否可領 | adopted | Candidate 仍維持 `open`／published 且可領取，AI review 與自動 checks 照常執行；`official` 的具名獨立 reviewer 是五人中非作者的任一人，建議預設韋銘，韋銘為作者時改 Mini 或 Jason。缺具名獨立 reviewer 只使 `official=false` 並產生 navigation support card，有容量時只更新 review route 與卡片 |
| ADR-065 | GitHub真實本人評價與平台操弄互動明確分開 | adopted；依 ADR-065 | 本人決定＋grant明示`github.star`＋本人AgentConnection執行時可建立／撤回；平台觸發、批量、獎勵導向或XP誘導的star/follow/like禁止，且不進XP |
| ADR-066 | 一個 GHEC non-EMU organization；9 repo 邊界固定，八模組不拆八 repo | adopted framework decision | 五個 product repos 與四個 governance repos 同日 scaffold；來源 `02 §4`、`08 §6` |
| ADR-067 | 主 domain 使用 `www/app/api/hooks/assets` URL 角色；GitHub Pages 留在 `github.io` | adopted framework decision | URL 角色不隨 project 任意漂移；來源 `08 §4` |
| ADR-068 | modular monolith；一個 canonical PostgreSQL，以 schema／role 隔離；客戶 raw data 不進中央儲存 | adopted framework decision | 中央只存必要 fact、ref、digest 與 consented metadata；來源 `02 §5`、`08 §5` |
| ADR-069 | PostgreSQL outbox／job／lease 是唯一 async truth；四個 Queues 只作 transport／wakeup | adopted framework decision | Queue payload 不成為 domain truth；來源 `02 §8.2`、`08 §2.3` |
| ADR-070 | canonical IDs、Domain Event Envelope、event catalog、command／event boundary 一次固定 | adopted framework decision | producer 與 consumer 共享穩定 envelope 與 idempotency 語意；來源 `03 §2`、`03 §4`、`03 §5`、`03 §6` |
| ADR-071 | 人或 organization 是 principal；Agent 只留 provenance；每次 action 只選一個 acting role | adopted framework decision | Agent 不成為會員、締約人、signer 或 payee；來源 `01 §8`、`03 §3.14` |
| ADR-072 | A0–A3 使用 bounded grants；A4 綁 exact digest；Ted 處理平台自身付款、法律文件與對外正式發布 | adopted framework decision | 成員 A4 維持各產品契約語意；來源 `05 §3.3.1`、`11 §4` |
| ADR-073 | Credential Broker、status signer、publisher keys 分離；A／B non-exportable technical planes 加 C offline | adopted framework decision | Custodian 建議預設為 A＝Ted、B＝Mini、C offline＝Jason並在五人共同閱讀時確認；A／B technical planes 同日建立，Ted／Mini 的不同自然人 evidence只控制 `production-signed`；來源 `08 §5.4`、`08 §12` |
| ADR-074 | preview／staging／production resource、secret、DB role 與 token 完全分層 | adopted framework decision | production 與 staging 同日建立，production 維持零 public traffic至 exact release A4；來源 `08 §3.2`、`08 §5` |
| ADR-075 | Agent runtime 固定 WorkContext／Claim／AgentRun／TaskLease／Grant／ActionIntent；Codex／Claude／Grok adapters 使用同一契約 | adopted framework decision | 三種 CLI 不各自解讀聊天內容；來源 `03 §3.10`、`03 §3.14`、`05 §5.7` |
| ADR-076 | build profiles 固定 Cloudflare React／Worker、TypeScript library、static page、agent Skill、custom-reviewed 六類 | adopted framework decision | repo manifest 只能選定義好的 profile 或 custom-reviewed；來源 `08 §6.1` |
| ADR-077 | 四循環、八模組、五個 cores、56 packages 與 12 runtimes／consumers 的形狀固定，內容數量可調 | adopted framework decision | 階段 1B 建完整 skeleton，階段 2 補垂直細節；來源 `02 §3`、`06 §4` |
| ADR-078 | 單一接點 seam：任何模組或外部實例只經 `Connection＋Credential Broker＋Ingress＋Job API` 接平台 | adopted framework decision | fork／template 不直連 DB、不持平台長效 secret；來源 `02 §4.7`、`05 §5.8` |
| ADR-079 | 收款主體永遠是 `SellerParty`；每個實際 Store 綁 seller-owned `seller_collection` | adopted framework decision | 平台不代收、不保管款項、不持有 merchant／live payment 帳號；來源 `01 §7`、`05 §12` |

### 3.1 低維運互惠 ADR 增量

| ADR | 現行決定 | 影響 |
| --- | --- | --- |
| ADR-080 | 主體驗是真實需求、共同成果、雙方實益與重用；不以任務量代替互惠 | `01/04/12`、既有Squad／Work／Result；不新增組織 |
| ADR-081 | appointment與容量分離；總維持工時含核心及其他會員；無人不隱性補位 | capacity reservation、bounded提醒、保護既有義務 |
| ADR-082 | 全架構保留，首批兩條平行驗證路徑（有限互助＋自願作品展示／外展／商機／合作／外部實收）；真人與資源證據決定擴大新服務承諾，不阻擋參與或外展 | `01 §15`、`06 §11`、`12 §9`；不封鎖一般貢獻、開發或找客戶 |
| ADR-083 | reviewer容量只做正交導航；新增條款及實益回報不等於review／payment | core machine、agent contract、OpenAPI、append-only observations |

## 4. 來源採用、調整與拒絕矩陣

### 4.1 Brainstorming 與現行決策

| 來源主張 | 決策 | Target expression |
| --- | --- | --- |
| 付出被 AI、自動化與互助放大 | adopt | Work Feed → Result/Contribution → reusable Skill/template → Opportunity → Now/Next/Gained |
| 利益橫向、學習縱向 | clarify | Guild 縱向維持專業；Squad 橫向交付與逐案分配 |
| Team Master 類似 Chief Officer | adapt | `master` 是 rank，`GuildMasterOffice` 是可交接 office；每模組一個 ModuleStewardship |
| Open Skills 與 AI Product Forge 是同 Team | adopt as Division | 三個獨立 Guild 共用 Product Council 與產品生命週期 |
| Vibe／Field／Project 湊齊即可盈利 | adapt | 三個不同人＋version QC＋license＋signed distribution/service terms 才標 commercial-ready；不保證盈利 |
| Contributor／reviewer 應優先拿未來工作 | adopt | Evidence-based discoverability；Vibe 優先客製，Field 優先 FAE/support/implementation，Project 組案；非 ownership/guarantee |
| 定位與陪跑像家教 | adopt | Talent Guild 指路；各 Guild 教專業；公開知識免費，dedicated human capacity 可付費 |
| 所有商品上架前要 QC | adopt | Candidate 可見；official/sellable 需要 version-scoped human signature |
| Software／Skill community QC 收費 | reject | Community QC 永遠零 review fee；客戶 funded testing/review/development 只能另開 paid Engagement |
| Seller 統一向買家收款 | adopt for launch | 一 checkout 一 Seller/biller，多 Supplier 拆 SupplyOrders |
| Supplier 看到實售價並可不供貨 | adopt with paid-order boundary | Supplier 先接受 exact listing revision；可拒絕未來供貨，不可事後因已接受價格拒絕 paid order |
| 建議最低價以下自動斷貨 | reject | MSRP/floor advisory；human `DistributionAcceptance`＋future revocation，無自動低價封鎖 |
| Agent 登入後自己找工作並完成 | adopt with principal/signature boundary | A0–A3 bounded automation；A4 exact human signature；每個 external effect 有 ActionIntent/provenance |
| 定期 inactivity 自動拔權、普遍資格申請、Gas 用完拔身份 | reject for launch | Reminders／可恢復路徑；scoped Entitlement 與 Quota 分開 |

### 4.2 Positioning sources

| Legacy artifact | 決策 | Target expression |
| --- | --- | --- |
| `ai-online` v2 questions/options/factors/archetypes | preserve/adapt | Immutable `legacy-v2` definition、pure evaluator、golden parity |
| Client-computed score／Google Sheets authority | reject | Server recompute raw answers；PostgreSQL canonical；optional report export |
| Assessment 作資格／派工條件 | reject | Advisory input；本人可 self-declare、edit 或 skip |
| `positioning-companion` guided conversation | adopt as SkillPackage | `GuidedDiscoveryRun` → editable `PositioningDraft` → human confirmation |
| User words、AI suggestions、unknowns、first evidence、falsifier、fallback | adopt | Canonical card fields與 WorkIntent evidence，不把 AI inference 冒充本人話語 |
| Quick/full 分散 templates | normalize | 一份 `positioning-card/v2` schema，`run_depth` 表示 evidence depth |
| 定位 evidence 對外欄位 | adopt | `evidence_state=unknown\|exploring\|ready_for_first_test`；不控制 admission/permission |
| Content/workflow/business-amplifier/pause | adopt/normalize as strategy modes | Target enum 為 `content\|workflow\|business_amplifier\|pause`；不當第九個職業原型 |
| 定位完成自動賣陪跑 | reject | 先給免費 Skill/Guild/讀書會；只有本人選擇專屬時間才建 paid service |

### 4.3 Revenue sharing 與 commerce 來源

| Legacy proposal | 決策 | Target expression |
| --- | --- | --- |
| Supplier offer＋promoter selection | adapt | SupplierOffer／DistributionAgreement＋SellerListing；Seller 是通路，不只 affiliate link |
| 30-day last-click | reject as universal default | AttributionPolicy per Offer versioned；需要時可作可配置 policy value，不是所有成品、服務或線下單的模型 |
| Seller-owned collection | adopt | One Seller/biller checkout；purpose-tagged `SellerCollectionConnection` |
| Direct payout/manual report | replace | PayerDisbursementConnection＋BeneficiaryPayoutDestination＋bounded SettlementMandate／UsageReservation＋provider initiation／reconciliation；manual evidence只在`manual_required`路徑 |
| Mandatory phone/KYC/committee | override | 只有實際 provider／交易責任需要的資料；不作全體會員入會條件 |
| Overdue 自動停 Seller／Platform 保證付款 | reject | Remind/reconcile/dispute＋human scoped action；Seller 仍是 payer，Platform 不保證或 custody |
| Fixed universal commission | reject | Distribution terms versioned；ServiceEngagement allocation 由 Squad 逐案簽署 |

### 4.4 Guild Lounge

| Legacy artifact | 決策 | Target expression |
| --- | --- | --- |
| 世界觀、三 surfaces、check-in journey | adapt | `community-events` UI／experience |
| Four roles／social energy | context only | Activity presentation/preference；不能改 CareerProfile、Rank、Entitlement 或錢 |
| Matching pure function | adapt | Directed assignment＋property tests；assignment 與本人確認 encounter 分開 |
| Participant local token／single host token | retire | Central User/GuestSession＋scoped activity capabilities |
| Worker/D1 三表 | migration adapter | 新資料寫 canonical Platform model；legacy read/reconcile 後退場 |
| Public R2 route／raw SVG／destructive reset | reject/rebuild | Authorized MediaAsset、safe decode/transcode、archive/retention command |
| Existing tests | preserve/expand | Legacy regression＋race/security/state/E2E/load tests |

## 5. 已決定的 launch decisions（working defaults，Ted 可改）

OD-01…OD-28 都是現行決定；外部專業意見與 evidence 會回填並產生後續工作，不中斷無關工作。非 canonical 的供應商、數量、日期或週數均是建議預設。Ted 可在最後一欄寫入 replacement 與日期；未改寫時依表中決定執行。T&D 指 Talent & Direction（定位＋陪跑）。

| OD | 決定 | 依據 | 標籤或技術依賴 | Ted 可改欄 |
| --- | --- | --- | --- | --- |
| OD-01 | Freedom 專用 Cloudflare；Registrar＋Workers／Queues／R2／Pages／Access；Cloudflare-billed PlanetScale PostgreSQL production HA＋staging；Ted 是 billing owner | ADR-046；`08 §3`、`08 §5` | account 存在後 API 才能建資源；安全 evidence 控制 `recovery`／`SLO` | 可：＿＿／日期＿＿ |
| OD-02 | 一組 production LINE OA＋Login channel、一組隔離 test channel；營運 admin 建議預設為 Hao，五人共同閱讀確認；帳號／billing／callback owner 仍由 Ted 持有 | `05 §7`；O1 | channel 存在後 callback 才能接線；E2E 未跑 | 可：＿＿／日期＿＿ |
| OD-03 | 一個 Freedom Discord server＋bot；建立 Profession／Skill／Study／Opportunity／Activity taxonomy | `05 §8`；O1 | server／bot 存在後 bindings 才能建立；E2E 未跑 | 可：＿＿／日期＿＿ |
| OD-04 | GHEC non-EMU Freedom organization、public-first、GitHub App＋9 repos；seat 數建議預設 5 | ADR-045、ADR-066；`08 §3.1`、`08 §6` | organization 存在後 repo／team／App API 才能建立 | 可：＿＿／日期＿＿ |
| OD-05 | 首發市場建議預設台灣；第一個 `SellerParty` 是 Ted 以自然人、商號或法人角色擇一；`SellingArrangement=reseller`，Platform 不 custody；法律與會計同步諮詢 | ADR-026、ADR-029；`01 §7` | 專業確認作用於 arrangement／listing／release，不作用於會員與建置 | 可：市場＿＿／SellerParty＿＿／日期＿＿ |
| OD-06 | 首幣建議預設 `TWD`；第一個 adapter 對接第一個 Seller 自有的綠界 ECPay sandbox，帳號在 Ted 作為 `SellerParty` 的第一個 Seller 名下；Platform 只建 provider-neutral adapter、connection ref 與 `record_only` 路徑 | ADR-029、ADR-079；`05 §5.8`、`05 §12` | Seller sandbox connection 存在後 webhook／refund／query／reconcile 才能真接；live 能力不宣稱 | 可：幣別＿＿／SellerParty＿＿／connection＿＿／日期＿＿ |
| OD-07 | Paid fact 後建立 settlement instruction；確認收款才授權出貨；refund／chargeback 建 reverse obligation 或 future netting | ADR-030、ADR-031；`03 §3.8`、`03 §3.9` | payment fact 與 reconciliation 是 domain action 的技術條件 | 可：＿＿／日期＿＿ |
| OD-08 | MSRP／floor 永遠標「建議」；Supplier 對 exact revision 接受；不做自動低價封鎖 | ADR-027、ADR-028；`01 §7.2` | `DistributionAcceptance` 控制該 listing revision 的 checkout action | 可：＿＿／日期＿＿ |
| OD-09 | Attribution per Offer configurable；支援 signed link＋documented manual claim | `03 §3.8`；`04 §3` | claim 必須綁 Offer policy version 與 evidence | 可：＿＿／日期＿＿ |
| OD-10 | 建議預設 steward：Ted＝Platform／Agent Control／Contracts、Settlement／ledger、AI Vibe／Skills／OSS；Hao＝Growth、Media、Member／Community；Mini＝Delivery PM、Product Quality／Supply、Commerce／Storefront；Jason＝T&D、Opportunity／Partnership 與 Work 流程；韋銘＝dev implementation。`official` 的具名獨立 reviewer 可由五人中任一非作者擔任，建議預設韋銘；韋銘為作者時改 Mini 或 Jason。五人共同閱讀時確認；Seller／Supplier／Skill／opportunity seed 同步建立 | 五人核心團隊；ADR-009、ADR-060、ADR-064 | Grok review、Claude verification與自動 checks 照常；獨立自然人 evidence 只控制 `official`，缺少時不阻擋 candidate | 可：＿＿／日期＿＿ |
| OD-11 | rank 採 evidence rubric；routine work 可委派；office 有 scope／start／end／successor。Guild Master 是 office；每個產品的 Vibe／Field／Project 是三筆 `ProductRoleAssignment` 且必須由不同自然人承擔。建議預設 office holder：Ted＝Platform Engineering、AI Vibe、Settlement；Hao＝Growth、Media、Member／Community；Mini＝Product Quality／Supply、Commerce；Jason＝T&D、Opportunity／Partnership。平台自身軟體建議預設 Vibe＝韋銘、Field＝Jason、Project＝Mini；Ted 的 AI Vibe Guild Master office 不衝突，Ted 另自任 Vibe 時三人改為 Ted／Jason／Mini | ADR-008、ADR-010、ADR-011；`01 §3.4` | evidence 不自動授權；office assignment 控制 scoped capability，產品三人 evidence 只控制 `commercial-ready` | 可：＿＿／日期＿＿ |
| OD-12 | text provider 建議預設 OpenAI API＋Anthropic API＋xAI API；render 建議預設 Runway API；publication adapters 全開 sandbox | O1；`04 §5`、`04 §6` | account／budget 存在後 sandbox Job API 才能真接；測試未跑 | 可：＿＿／日期＿＿ |
| OD-13 | Day 1 盤點 legacy URL／traffic／credentials／data；保留 strangler adapter；migration 結果如實標記 | `02 §4.5`；`06 §10` | legacy access 是 inventory 技術依賴；未取得時走 deterministic fixture | 可：＿＿／日期＿＿ |
| OD-14 | 未確認權利的 legacy asset 只作行為參考；新 brand／font／image 使用已授權來源 | ADR-017；`06 §10` | license evidence 控制特定 asset 是否可進 release artifact | 可：＿＿／日期＿＿ |
| OD-15 | 使用 SPDX allowlist＋人工 obligations note＋每版 source hash | ADR-017；`04 §7` | license evidence 控制 `commercial-ready`，不阻擋 candidate | 可：＿＿／日期＿＿ |
| OD-16 | DB RPO≤15m／RTO≤4h；asset RPO≤24h／RTO≤8h 作 working target；owner 由 Ted 持有 | `08 §5`；建議預設 | restore evidence 控制 `SLO`，restore 測試未跑 | 可：＿＿／日期＿＿ |
| OD-17 | Dynamic token 採 PG envelope ciphertext＋isolated broker；production roots 用外部 KMS／HSM；production／test 分離 | ADR-050、ADR-073；`08 §5.4` | root／binding 存在後 production credential operation 才有技術路徑；rotation／recovery 未跑 | 可：＿＿／日期＿＿ |
| OD-18 | Platform re-auth＋exact digest receipt；e-sign 建議預設 DocuSign evidence export；organization signatory 是 Ted | ADR-019、ADR-072；`05 §3.3.1` | authority 與 exact digest 是該次 A4 的 action invariant | 可：＿＿／日期＿＿ |
| OD-19 | 五人核心團隊＋AI 建完整形狀，各自 own 建議預設 track；可外包具 contract、mock／sandbox、tests 與 AI review 的工作卡；任何日期與週數只是建議預設 | P5、P12、P13；`06 §2` | 共同閱讀只確認分工，不控制工作；只有 API／resource 技術依賴排序 | 可：＿＿／日期＿＿ |
| OD-20 | 無 key coordinator；Signer A custodian＝Ted、Signer B custodian＝Mini、C offline recovery custodian＝Jason，均為建議預設並在五人共同閱讀時確認；A／B 使用不同 runtime／credential／technical plane，A／B／C technical planes 同日建立 | ADR-073；`08 §5.4`、`08 §12` | Ted／Mini 為不同自然人的 custody evidence 控制 `production-signed`；缺 evidence 不阻擋建置 | 可：＿＿／日期＿＿ |
| OD-21 | 採普通 PNG＋入口 QR；可驗證格式預設不做 | legacy activity 需求；證據觸發決定 | Activity identity、驗證者需求與防偽失敗率有實測時建立格式評估；測試未跑 | 可：＿＿／日期＿＿ |
| OD-22 | 不買 badge printer；保留 adapter interface／queue skeleton | P13；證據觸發決定 | 兩場真實活動出現重複列印需求且有耗材／設備 owner 與 offline fallback evidence 時建立硬體工作；目前無 evidence | 可：＿＿／日期＿＿ |
| OD-23 | 不做 MoR、escrow、wallet 或代收；保留 provider-neutral ports | 金流鐵律；ADR-029、ADR-079 | 具名市場／交易量需求與會計、法務、牌照、custody、refund、資本風險 evidence 只建立可行性紀錄，不改變現行 money owner | 可：需同步改寫金流鐵律／日期＿＿ |
| OD-24 | 維持 modular monolith＋四個 Queues＋一個 canonical PostgreSQL；不拆 domain DB | ADR-003、ADR-068、ADR-069 | load／SLO、runtime isolation、security boundary 或 independent release ownership 有量測 evidence 時評估拆分；測試未跑 | 可：＿＿／日期＿＿ |
| OD-25 | 使用可解釋 rule-based matching；model adapter 只留 interface | ADR-014；證據觸發決定 | context-specific accepted／declined／outcome data 與 bias evaluation evidence 存在時建立 model experiment；不建 universal score | 可：＿＿／日期＿＿ |
| OD-26 | 不做 downline；使用 versioned Offer／agreement | ADR-013；證據觸發決定 | 現有 Offer 無法表達的具名 business case 與法律、濫用、退款、揭露 evidence 存在時建立 ADR 工作 | 可：＿＿／日期＿＿ |
| OD-27 | 逐單 instruction／reconcile；batch interface 只留 skeleton | ADR-030；證據觸發決定 | 逐單結算穩定、成本瓶頸量測與雙方額度／reserve／credit／default exact terms 存在時啟用 batch implementation | 可：＿＿／日期＿＿ |
| OD-28 | `money_movement_enabled=false`、每個 Seller=`record_only`；`authorized_mandate` 僅在 `money_movement_enabled=true`、Payer 當事人已對 exact `SettlementMandate` digest 簽署成員 A4，且 Ted 已對同一 digest 完成付款類一鍵 A4 時可用；缺任一條件即維持 `record_only`，商店、listing 與對帳照常；明細在 confirmed reconciliation 前只顯示「已記錄」 | 金流鐵律；ADR-063；`03 §3.9`、`05 §12.4` | active mandate、cap、idempotency、provider connection 與 reconciliation 是 action invariants；測試未跑 | 可：＿＿／日期＿＿ |

## 6. 現行 assumption register

下列是假設，不是停止工作的條件；對應 checks 都未跑。假設不成立時採替代路徑並更新相關 ADR／contract，不回寫歷史 fact。具名角色全部是建議預設，在五人共同閱讀時確認；Ted 的 Day 1 不等待確認。

| A | 現行假設 | Evidence／check | 不成立時替代 |
| --- | --- | --- | --- |
| A-01 | Modular monolith＋PostgreSQL 可承載首批會員、orders、events、tasks | load、queue lag、DB contention；未跑 | Horizontal API／worker scale；維持單一 canonical DB，依 evidence 評估邊界 |
| A-02 | LINE 適合作為會員低摩擦登入與即時提醒方式 | invited pilot conversion／support；未跑 | 加入 magic link／OIDC adapter；canonical User 不變 |
| A-03 | Discord 適合 Guild 討論與讀書會 | activity UAT；未跑 | 換 community adapter；Platform 仍只存 binding／ref |
| A-04 | 第一個 Seller 的綠界 ECPay sandbox 能驗證 collection、webhook、refund、query 與 reconcile；payer／beneficiary 能力由各自 owner connection 提供 | sandbox capability checks；未跑 | `manual_required` approve／export／evidence flow；不宣稱 fully automated |
| A-05 | 一 checkout 一 Seller、多 Supplier 的 buyer experience 可接受 | checkout UAT／support cases；未跑 | 收窄為一 Seller＋一 Supplier；不引入多 biller |
| A-06 | Supplier 願意接受 exact actual-price revision 與每單結算後履約 | Supplier pilot；未跑 | Supplier-specific catalog、pre-funded 或 separately signed terms；不建立無供貨承諾的 payable order |
| A-07 | 第一批 Skill repos 可公開或授權 GitHub App 讀取 | maintainer onboarding；未跑 | Manual manifest＋later binding；保留 source hash |
| A-08 | `ai-online` deterministic baseline 能幫成員取得清楚方向 | parity＋member clarity UAT；未跑 | Self-declared profession＋guided discovery only |
| A-09 | `positioning-companion` guided flow 經 target eval 後適合平台使用 | adversarial／privacy／user UAT；未跑 | 只提供 downloadable Skill／human-assisted draft，不自動寫 profile |
| A-10 | 不保存聊天全文仍足以完成陪跑與工作追蹤 | coach／member pilot；未跑 | 對本人選取摘要另取 consent；不全量鏡像 |
| A-11 | zero-fee community QC是否有持續自願供給仍未知；appointment不代表可用時間 | 雙方實益、accepted capacity、退出／queue及粗估工時；真人未跑 | 縮小範圍、候補／自助；普通未認領到期，不核心補位；有預算需求另開Engagement，不出售QC通過 |
| A-12 | 可發現性是否形成付費需求仍未知，不能用它支付當次貢獻 | 真實邀請、paid conversion與reconciled receipt分列；未跑 | 改善當次非金錢實益／需求；無案源不宣稱收入。已有案才談signed allocation，不能以分配契約假造客戶 |
| A-13 | 五人＋delegates能否低總工時維持仍未知 | 核心／非核心維持與協調總工時、集中度、無核心催促完成率；未跑 | 先減少重複需求／新服務承諾與範圍，不只增人；保留已簽履約與安全責任 |
| A-14 | Guild Lounge legacy data 能可靠映射到一個 Activity | rehearsal／count reconciliation；未跑 | 冷封存；新活動使用 canonical model |
| A-15 | Cloudflare Workers＋Hyperdrive 與 Cloudflare-billed PlanetScale Postgres 可滿足 latency、transaction、HA、PITR 與 restore 需求 | provider matrix＋staging load／restore／exit；未跑 | Hyperdrive 接其他 managed PostgreSQL；domain／application contracts 不變 |
| A-16 | 公開 project 的固定格式 GitHub Pages 能可靠介紹與導流，且不被誤用成 application runtime | official／fork／private fixtures、link／a11y／security tests 與 traffic；未跑 | Pages 只保留 redirect／minimal card；完整介紹回 Cloudflare 官網 |

## 7. Risk register

Likelihood/Impact 使用 L/M/H。Owner 是風險處理責任，不代表最終法律責任。風險表中的 tests、drills、UAT 與 capability checks 均未跑；風險處置不建立工作停點。具名 owner、custodian 與 reviewer 全部是建議預設，在五人共同閱讀時確認。

### 7.1 Organization、work 與 Agent

| Risk | L/I | Trigger/metric | Prevention | Contingency | Owner/階段 |
| --- | --- | --- | --- | --- | --- |
| R-ORG-01 Guild/Master/Officer/rank權限爭議 | M/H | Permission/office dispute | Rank、office、Entitlement、delegation分表；scope/term/successor | Revoke specific office grant、audit、公開交接 | Organization 1B+ |
| R-ORG-02 核心或志工承擔隱形維持工作 | H/H | 核心與非核心總維持／協調工時、accepted capacity、介入覆蓋率 | 兩條平行首批路徑、有限容量、scope／episode去重、模板與自助；appointment不等於可用時間 | 縮減新服務承諾、未認領志願到期；不自動核心補位；不禁止外展；保護既有合約／安全義務 | Guild Masters與Work／Coaching既有owner |
| R-ORG-03 一人多職造成責任不清或三職標籤誤標 | H/H | Same natural person 跨 required roles | Resolve human principal；Agent 不算自然人；建議預設 Vibe＝韋銘、Field＝Jason、Project＝Mini；標籤投影驗 exact assignments | 修正 `commercial-ready`，補 label evidence；工作照常 | Mini／Jason／韋銘 1C+ |
| R-ORG-04 工作被做完但貢獻／得到不清楚 | M/H | Orphan Results、member complaints | WorkItem先列evidence/expected gain；accepted Result才建Contribution | Repair provenance/projector、人工attach evidence | Work Core 1B+ |
| R-AGT-01 Agent取得過多私密context | M/H | Prompt/log DLP alert | Purpose-limited WorkContext；raw positioning/chat/PII/secret排除 | Revoke grant/connection、rotate、incident response | Agent Control all |
| R-AGT-02 Standing grant被誤用為付款/QC/合約簽名 | M/H | A4 action無exact signature | A4不可放入普通 grant；artifact＋consequence digest/re-auth | Stop intent、void unauthorized effect、reconcile | Agent/Identity 1B+ |
| R-AGT-03 Retry或lease過期造成重複外部effect | M/H | Duplicate provider IDs/stale fence | ActionIntent idempotency、stable operation key、lease/fence | `result_unknown`、provider query/reconcile、corrective event | Foundation 1B+ |
| R-AGT-04 AI task matching變黑箱或把人推向不想做的事 | M/M | Skip rate、reason missing、complaints | Explain `why`, acting role, effort/gain；approve all/some/skip | Disable matcher/version、show open queue/manual filters | Agent/Product 1C+ |
| R-AGT-05 Discord/LINE reply被誤當正式授權 | M/H | Consequential action無Platform receipt | Channels只發deep link；A4只在Platform exact-artifact flow | Pause effect、re-auth/re-sign、audit connector | Integrations 1B+ |

### 7.2 Identity、platform 與 integrations

| Risk | L/I | Trigger/metric | Prevention | Contingency | Owner/階段 |
| --- | --- | --- | --- | --- | --- |
| R-ID-01 External identity連錯User | M/H | Uniqueness conflict／merge tickets | Community/provider-scoped subject、雙邊reverify、claim token | Resolution workflow＋audited alias rollback | Identity 1B |
| R-ID-02 OAuth state/redirect/secret leakage | M/H | Invalid state／secret alert | state/nonce/PKCE、redirect allowlist、secret refs/rotation | Revoke sessions/connections、rotate、incident notice | Security 1B |
| R-INT-01 Fake/replayed/duplicate/out-of-order webhook | H/H | Signature failures、gap、duplicates | Raw-body verify、timestamp、inbox unique、aggregate cursor | Quarantine、reconcile、safe replay | Integrations 1B–2 |
| R-INT-02 Provider outage/rate limit | H/M | Queue lag、connection health | Async delivery/backoff、health state、Portal fallback | Pause destination jobs、switch/manual route | Integrations all |
| R-INT-03 Contract/provider drift | M/H | Consumer fixture/deprecation failure | Semver、generated clients、capability snapshot、contract CI | Pin version、kill switch、新 adapter | Contract Steward all |
| R-INT-04 External document confirm被誤當current source驗證，或Agent使用漂移／不可達revision產生副作用 | M/H | Confirm path出現source egress、缺receipt output/action、digest mismatch後仍有domain/provider effect | Confirm只比對saved acknowledgement tuple；WorkItem exact requirement；bound local Agent current-lease local hash receipt；output／ActionIntent validation與normal review／A4 | 記failure receipt、fail run、阻斷／revoke grant；以新revision／新SubmissionDraft重建工作，不覆寫舊source fact | Agent Workflow 1C |
| R-PLAT-01 Outbox/projection lag顯示過期狀態 | M/H | p95 lag/backlog | Index/worker scale、contiguous cursor、replay | Degraded banner、canonical query、rebuild | Foundation 1B+ |
| R-PLAT-02 Versioned config改寫歷史 | M/H | Snapshot/hash mismatch | Immutable version/hash；Order/Result/Signature refs | Roll back active pointer；facts不回寫 | Contracts all |
| R-PLAT-03 PII/secret或client-confidential raw file進中央DB/R2/event/queue/log/AI prompt | M/H | DLP/classification/redaction failure或中央object出現客戶內容 | 客戶內容只留Squad/client-owned storage；中央只收opaque ref/digest/最低consented metadata；allowlisted fields、structured logs、ingress reject與隔離短期刪除tests | 阻斷agent/downstream access、隔離後在核准窗內刪除並留receipt；必要時revoke/rotate與incident通知 | Security all |
| R-PLAT-04 Credential broker發出跨community/job或長效access，或共用RPC surface讓caller跨方法／executor group | M/H | Binding指錯named entrypoint、caller多拿binding、exported method set漂移、body偽造role、aud/scope/fence mismatch | 四個deploy-time binding→named entrypoint exact-set；entrypoint窄方法＋hard-coded group；DB再驗Active Connection＋current exact job/lease/fence/registry＋TTL intersection | 移除／修正binding、pause executor、revoke issuer/connection、rotate，完成IaC與RPC surface audit後恢復 | Platform Ops 1B+ |
| R-PLAT-05 Restore、retention或deactivation破壞ledger/共享connection | M/H | Restore diff、wrong-owner revoke | Per-class policy、PITR drills、shared handoff、append-only facts | Restore/reproject、audited repair/handoff | SRE/Ops 1B+ |
| R-PLAT-06 把PlanetScale-hosted Postgres誤認為Cloudflare原生服務，忽略region/support/backup/exit邊界 | M/H | Provider或region能力缺口、restore/export失敗、unexpected bill | Provider matrix、明示責任、Hyperdrive abstraction、staging restore/exit drill | 換 managed Postgres、rebind Hyperdrive、重跑migration/reconcile | Platform Ops 1A–1C |
| R-PLAT-07 Dynamic OAuth/provider token或status signing key無可擴張安全落點 | M/H | Plaintext token、每會員secret超限、broker跨tenant解密、同一runtime同時持vault KEK與status key、任意API可叫signer、key遺失／外洩 | Per-record AEAD＋AAD、wrapped DEK、credential-broker與status-signer分成不同無public-route Worker／DB role／root binding；Broker四個named-entrypoint bindings硬隔離method/group；只有無broker binding的release-status worker可叫signer；root-key backend 依 OD-17；rotation／recovery／load tests | Revoke provider connections／key、停發 capability／attestation、rotate／rewrap、以 dual-control recovery 或重新連線恢復 | Security/Platform Ops 1A–1C |
| R-PLAT-08 Cloudflare管理員失聯、2FA遺失或帳號遭接管，同時影響Registrar/DNS/runtime/secrets | M/H | Ted／Jason任一Super Administrator無第二因素／backup code、異常session或無法讀audit log | Ted 是 billing owner／Super Administrator；Day 1 把第二 Super Administrator 邀請寄給 Jason 的既有、可獨立恢復、非 Freedom domain email，接受與否只影響 `recovery`。同日啟用2FA enforcement、每位至少兩種因素、分開保管recovery codes、least-privilege member/token與audit／recovery drill | Jason接管、撤銷sessions/tokens、rotate secrets、依runbook恢復DNS/runtime並啟動incident response | Ted／Jason 1A+ |
| R-PLAT-09 PostgreSQL job與Cloudflare Queue/Workflow形成雙主、重送造成重複effect | M/H | Queue/Workflow狀態與DB version/fence不一致、missing outbox delivery或duplicate operation | DB是outbox/Job/lease唯一真相；Queue只傳ID；consumer重claim＋冪等；Workflow逐步回寫；sweeper/reconciliation及stable provider operation key | 暫停partition/workflow、依DB fence重建通知、查provider後收斂`result_unknown`、不盲目重送 | Foundation/Platform Ops 1A+ |

### 7.3 Open source、QC 與 paid services

| Risk | L/I | Trigger/metric | Prevention | Contingency | Owner/階段 |
| --- | --- | --- | --- | --- | --- |
| R-SKL-01 Repo rename/delete/private/transfer | H/M | Webhook/reconcile failure | Stable provider repo ID、commit pin、cached metadata | Mark degraded、bind replacement/fork | Skills 1C+ |
| R-SKL-02 Same version label內容被換 | M/H | Hash mismatch | Commit/hash uniqueness、immutable PackageVersion | Reject、new version、audit | Skills 1C |
| R-SKL-03 Missing/incorrect license或fork lineage | H/H | `NOASSERTION`／scanner conflict | SPDX/source hash/lineage＋human obligations note | Keep candidate discussion；stop official commercial binding | Product Council 1C+ |
| R-SKL-04 Fork／手改介紹頁或混淆URL冒充 official project | H/H | Owner/repo/domain/release與manifest不一致，或userinfo／encoded-authority／IDN host顯示與實際origin不同 | GitHub API semantic check、stable org-ID allowlist、strict URL canonicalization、trusted-registry-derived official origins、field-specific external-origin allowlist、signed Platform status、fixed fork banner | Fail closed並降級/撤銷 official record、unpublish org-controlled page、封鎖惡意origin、security notice | Open Product/Security 1A+ |
| R-SKL-05 Private repo 的公開 Page build 洩漏 source、secret 或 internal metadata | M/H | Unexpected file／log 出現在公開 projection | Private source repo 不直接發布 Pages，只可用 Portal `platform_only` allowlisted projection 或 `withheld`；public companion 使用 signed projection contract | Unpublish、rotate leaked secret、purge／cache incident 流程、停用投影 | Security/Platform Ops 1A+ |
| R-SKL-06 Registry/QC被誤解為資安或效果保證 | H/H | User report/claim wording | Show protocol, environment, evidence, scope, expiry；不執行untrusted code by default | Withdraw official badge/version；incident/re-review | Field/QC 1C+ |
| R-SKL-07 惡意repo／fork誘導local agent下載舊版／替換或shadow Skill、mutable registry令同一channel重新解出不同dependency，或agent忽略prompt停點 | M/H | 任意Skill URL/key/ref、superseded/forked head、unsafe／cross-filesystem alias archive、resolver/snapshot/locator未pin、signed closure與package identity/ranges不符、selected realpath漂移、authority過期、無A4仍送 consequential request | Publisher以pinned resolver＋immutable registry snapshot一次產生signed exact closure；5分鐘signed index pin exact current heads；stable release/asset locators；package外pinned installer＋out-of-band root；typed fetch budgets、safe extraction、完整authority proof cache、atomic read-only activation與live-session lease GC；launcher枚舉collision並驗realpath；repo不能選trust root/ref；CLI/API重驗scope/target/A4/idempotency | 停止新session／副作用、撤銷release/key並隔離cache；失敗activation不改原pointer，但原pointer也必須重新符合current index、snapshot、channel windows與floors才可建立新session。不得掃cache、猜last-known-good或自動rollback；保留證據並稽核AgentRun | Platform Security 1A+ |
| R-SKL-08 PR改寫 repo-local workflow 或偽造同名 required check 繞過 merge validation | M/H | Required check來源不是固定 App／中央 workflow，PR 變更 workflow 仍能自報 success | GHEC organization ruleset 的 `Require workflows to pass before merging` 綁 public 中央 workflow；repo-local workflow 不算同一驗證；central source 經 AI review，外部 actions pin full SHA，PR 執行無 secret／read-only | 關閉 merge action、撤銷受影響 release／status、audit ruleset 與 runs、修復中央 workflow／App 後重跑候選 | Platform Security/Release Engineering 1A+ |
| R-SKL-09 同一 publisher runtime／管理員同時持有兩把 online key，或 quorum／scheduler 中斷卻用單簽延命 | M/H | 一個 credential 可 deploy／讀取兩個 signer key、兩個 signature 來自同一 runtime、index 超 300 秒或 snapshot 超 900 秒、journal heads 不一致 | Coordinator 不持 key；Signer A custodian＝Ted、Signer B custodian＝Mini，使用不同 runtime／deploy credential／technical plane，各只能呼叫一把 non-exportable key並獨立驗 append-only journal；C offline recovery custodian＝Jason。Custodian evidence 控制 `production-signed` | 不降 threshold；停止簽發 action 並讓 activation fail closed；撤銷／rotation 或 OOB root redistribution 後恢復 technical plane | Ted／Mini／Jason 1A–1C |
| R-SKL-10 Domain Skill overlay把未簽、未QC、已撤銷或host-shadowed bytes帶進Agent runtime | M/H | WorkItem refs與overlay roots不等、QC digest/self-review、overlay／index／revocation過期、root/dependency撤銷、case-fold collision、global/project/plugin candidate可見或mid-run混版 | BLD-05獨立2-of-N overlay；exact package/archive/closure與runtime-scope QC；`runtime_roots_set_digest`；每個新session重驗current authority/revocation；safe extraction、read-only CAS與per-run sealed discovery；server推導mode/set，client不得提交 | 立即停建新signed-overlay session並回`capability_unavailable`；撤銷root/key/QC、隔離cache與保留AgentRun證據。Eligibility-only工作可繼續；不得以cached LKG、關閉QC或打開host discovery降級 | Agent Workflow/Security/Open Product 1A–1C |
| R-QC-01 AI preflight冒充獨立human QC | M/H | No natural-person signer | Reviewer identity/signature；author/reviewer separation；具名 reviewer 建議預設為非作者時的韋銘 | Return to review、remove official/sellable state | 韋銘 1C+ |
| R-QC-02 免費社群QC變隱性客戶交付／剝削 | M/H | Private brief、deadline/SLA、mandatory work | WorkItem明示voluntary/unpaid/effort/gain；customer scope建Engagement | Stop task、convert to funded SOW、allow no-penalty withdrawal | Product/Project 1C+ |
| R-SRV-01 Paid work未先定scope/acceptance/allocation | M/H | Work starts without signed SOWVersion/plan | ServiceEngagement＋exact signatures before funded execution | Pause delivery、new version/change request | AI Project 2+ |
| R-SRV-02 貢獻證據被誤當copyright、ownership或perpetual royalty | M/H | Auto financial obligation from PR | Separate Contribution/License/Allocation domains | Reverse invalid obligation、correct UI/audit | Product Council 1C+ |
| R-SRV-03 Three-profession minimum被誤宣稱為盈利保證 | M/M | Marketing claims/failed delivery | Name it `commercial-ready`, not profitable；market validation仍required | Revise status/copy、reform Squad | Product Council 2+ |
| R-OPP-01 外部lead/fund/investor資料過度搬入Platform | M/H | Sensitive fields in Stub/prompt | Private minimal OpportunityStub＋external refs/ACL | Revoke access、redact/delete allowed copy、incident | Opportunity 1C+ |

### 7.4 Commerce、pricing 與 settlement

| Risk | L/I | Trigger/metric | Prevention | Contingency | Owner/階段 |
| --- | --- | --- | --- | --- | --- |
| R-COM-01 Buyer遇到multi-biller或責任不清 | M/H | Mixed Seller cart/support cases | Exactly one Seller/biller per checkout；responsibility snapshot | Segment cart；disable mixed checkout | Commerce 2 |
| R-COM-02 Client tamper price/seller/split/acceptance | H/H | Server mismatch/negative tests | Server recalc from signed Offer/Listing/Acceptance versions | Reject and refresh；audit abuse | Commerce 2 |
| R-COM-03 Supplier未接受實價，Buyer卻已付款 | M/H | Paid Order without active acceptance | Checkout-time transaction revalidation＋availability hold | Stop affected listing；Seller refund/support | Commerce 2 |
| R-COM-04 Supplier事後以價格拒絕已付款單 | M/H | Paid fulfillment refusal | Immutable accepted revision/DistributionAcceptance、clear terms | Seller fulfills/refunds under snapshot；dispute＋future revoke only | Supply/QC 2+ |
| R-PRICE-01 MSRP/floor被實作成固定轉售價或自動斷貨 | M/H | Automatic below-floor block/termination | Advisory schema/UX、human acceptance、professional launch review | Disable rule、reissue terms、review affected listings | Commerce/Product 1B–2 |
| R-PRICE-02 Seller dumping損害Supplier品牌/供應 | H/M | Price variance、future decline rate | Show actual price/delta；Supplier accepts each revision/valid window | Supplier declines or revokes future supply；Seller reprices | Supply/Commerce 2 |
| R-COM-05 Seller-of-record、invoice、tax/refund責任誤標 | M/H | Complaint、invoice mismatch、professional review finding | Six-field arrangement snapshot＋buyer-facing disclosure | Pause live checkout/template；correct documents/process | Commerce 1B–2 |
| R-PAY-01 Provider paid與Platform Order不同步 | M/H | Reconciliation gap | Signed webhook、unique external ref、daily reconcile | Unknown-payment workbench/manual attach | Payments 2 |
| R-PAY-02 Timeout/retry造成重扣或重複Supplier transfer | M/H | Multiple provider operation IDs | Stable idempotency key、result_unknown query、fencing | Freeze/reconcile、refund duplicate、incident | Payments 2 |
| R-PAY-03 SettlementMandate過寬、bounds重疊、併發超額、過期或付錯beneficiary | M/H | Bound mismatch／reserved+consumed anomaly | Purpose-tagged connections；beneficiary/destination/currency/action/scope/amount/period/timezone/expiry；拒絕overlap；A4 creation；atomic UsageReservation | Revoke mandate；ready釋額，in-flight保留並reconcile；recover/dispute | Payments 2 |
| R-PAY-04 Provider根本不支援Seller代付／payout initiation | H/H | 1B capability spike fails | Capability matrix＋sandbox proof before promise | `manual_required` approve/export/deep-link/evidence；choose another provider | Payments 1B/2 |
| R-PAY-05 Seller收款後不付Supplier或資金不足 | M/H | Overdue/failed transfer | Immediate instruction、balance/preflight where available、aging/reconcile | Fulfillment hold、manual dispute、future scoped trading pause by human | Commerce Ops 2+ |
| R-PAY-06 Refund/chargeback未沖Supplier/commission obligation | M/H | Payment-ledger delta | Immutable split＋property tests＋append-only reversals | Corrective reversal、future netting under signed terms | Ledger 2 |
| R-PAY-07 Supplier未確認收款卻出貨 | M/H | Fulfillment before verified settlement | FulfillmentAuthorization only after provider/reconciliation evidence | Stop shipment where possible、manual recovery/dispute | Supply/Payments 2 |
| R-COM-06 Fork洩漏secret或使用舊contract | M/H | Secret scan/compatibility failure | No secrets/DB in fork、short token、binding health、consumer CI | Revoke binding/token、upgrade guide、remove official status | Storefront 2+ |
| R-COM-07 使用者誤以為Platform代管／保證資金 | M/H | Copy UAT/support complaints | Clear Seller/payee/payer/status/fallback disclosure | Halt misleading template、correct support messaging | Product/Commerce 2+ |
| R-COM-08 Money precision/overflow | M/H | Boundary/property failure | Decimal-string wire、bigint minor unit、range validation | Stop checkout、recompute projection、append correction | Contracts 1A+ |

### 7.5 Positioning、community 與 coaching

| Risk | L/I | Trigger/metric | Prevention | Contingency | Owner/階段 |
| --- | --- | --- | --- | --- | --- |
| R-POS-01 AI把推論寫成本人事實或太早定向 | H/M | User correction/unsupported field | User words／AI suggestion／unknowns分欄；human confirmation | Reopen draft、replace CareerProfile revision | Talent 1C+ |
| R-POS-02 `evidence_state` 被誤用為會員／工作阻擋條件 | M/H | Permission depends on card state | No auth relation；CareerProfile advisory only | Remove rule、restore access、audit consumers | Talent/Foundation 1C |
| R-POS-03 Raw定位對話或第三方PII外洩 | M/H | Prompt/log/data scan | Store structured minimal output；redaction／consent；no raw context in Work Feed | Revoke/delete permitted copy、incident | Talent/Security 1C+ |
| R-POS-04 `positioning-companion`靜態validation被誤當模型品質證據 | M/M | Launch without behavior eval | Adversarial/privacy/factual/user-correction evals | Limit to draft/manual facilitator | Talent 1C–2 |
| R-COA-01 免費知識被包在付費陪跑後 | M/H | Public path inaccessible without purchase | Free Skill/Guild/reading path always shown first | Unbundle/refund where applicable、restore access | Talent/Community all |
| R-COA-02 Coach讀取過多私密資料或漏打卡被懲罰 | M/H | Access log/withdraw feedback | Enrollment-scoped minimum view；pause/reschedule/smaller step | Revoke coach scope、transfer/pause、incident | Coaching 2+ |
| R-COMM-01 Discord/Guild title形成隱性全域權力 | M/H | Permission audit mismatch | Capability only from scoped office/Entitlement | Revoke capability、repair map、audit | Community Ops 1B+ |

### 7.6 Marketing、media 與 cost

| Risk | L/I | Trigger/metric | Prevention | Contingency | Owner/階段 |
| --- | --- | --- | --- | --- | --- |
| R-MKT-01 Retry重複發文 | M/H | Duplicate external post | Stable delivery key、provider lookup、result_unknown | Stop queue、owner選擇刪文、reconcile | Growth 2 |
| R-MKT-02 AI捏造price、license、availability或承諾 | H/H | Source-lock diff | Structured approved facts＋locked fields＋tests | Block job、regenerate/edit、correct publication | Growth 2 |
| R-MKT-03 A3 autopublish scope過寬 | M/H | Channel/count/time breach | Channel/template/time/count grant、kill switch | Revoke grant、pause channel、audit/delete if owner chooses | Growth 2 |
| R-MED-01 Fake MIME、active SVG、compression bomb或oversized media | H/H | Scan/decode failure | Quarantine、magic bytes、limits、safe transcode/isolation | Reject/delete quarantined copy、incident | Media/Security 1B+ |
| R-MED-02 Remote ingest SSRF | M/H | Private IP/DNS rebinding alert | URL allowlist、DNS/IP recheck、redirect/time/size bounds | Disable remote ingest；upload only | Media 2 |
| R-MED-03 Render timeout/result unknown覆寫原檔 | M/H | Stuck job/hash mismatch | Immutable source、attempts、callback verify/reconcile | Provider switch/manual export；preserve history | Media 2 |
| R-COST-01 AI/media cost暴增 | H/H | Burn/spend alert | Reserve/consume/release、per-source caps、BYOK | Stop new expensive jobs；保留draft/Entitlement | Growth/Ops 2 |

### 7.7 Guild Lounge legacy risks

若 legacy route 已下線，live likelihood 可調低，但 code exploitability 與回歸測試仍存在；Day 1 必須記錄真實 URL、traffic、credential rotation 與 storage exposure，不能以未知當安全。

| Risk/evidence | L/I | Target fix/test | Owner/階段 |
| --- | --- | --- | --- |
| R-GL-01 Known arbitrary R2 key可由public photo route讀取 | H/H | MediaAsset owner/purpose＋signed URL；wrong-owner/key negative test | Community/Media 1B |
| R-GL-02 Arbitrary `image/*` same-origin serving可含active SVG | H/H | Magic-byte decode/rasterize/isolate；SVG/fake-MIME tests | Media/Security 1B |
| R-GL-03 Concurrent create check-then-write造成雙token／覆寫 | H/H | DB unique/transaction/owner conflict＋race test | Community 1B |
| R-GL-04 Shared host token可list/control/delete all | H/H | Scoped display/check-in/round/archive capability | Community/Foundation 1B |
| R-GL-05 三表缺activity/user scope | H/H | Canonical actor/activity IDs＋migration mapping | Community 1C |
| R-GL-06 Countdown依賴big-screen callback | H/H | Server timer/lease/idempotent complete；no-screen test | Community 1C–2 |
| R-GL-07 Photo upload/DB reference不一致 | H/M | Asset state＋transactional reference/compensation | Community/Media 1B–1C |
| R-GL-08 Directed match被敘述成mutual encounter | H/M | Assignment/Encounter分事件＋UAT/property tests | Community 1C–2 |
| R-GL-09 Destructive reset與partial R2 delete | M/H | Archive/retention job＋reconciliation | Community/Ops 1C |
| R-GL-10 Polling/heartbeat load與presence語意 | H/M | Server presence window、backoff/load tests | Community/SRE 2 |
| R-GL-11 Assets/repo權利未知 | H/M | OD-14確認；未確認即替換assets | Product/Legal 1A–1C |

## 8. Requirement traceability matrix

本表保存 RQ-001…RQ-065 的穩定追溯。產品／營運／真人列的測試狀態仍是「未跑」；契約 fixture 與本機 scoped runtime 另見 verification 與 [`docs/releases/2026-09-20-local-core.md`](../releases/2026-09-20-local-core.md)，不得改寫本表為已通過。target 已定義不表示 implementation、provider setup 或 production evidence 已存在。Implementation repo 以 `requirements.yaml` 連回同一 RQ ID，補 `implementation_pr`、`test_run`、`release` 與 evidence URL。

| Req | Requirement | Canonical owner/entities | Spec/contracts | Minimum acceptance | 階段/測試狀態 |
| --- | --- | --- | --- | --- | --- |
| RQ-001 | Portal 顯示每人 `Now/Next/Gained` | Membership/StatusProjection | 01 §1/11；03 §8；04 §11 | Event replay後相同；每個result有gain/next | 1B–2；未跑 |
| RQ-002 | 八個experience modules共享五個cores | ModuleStewardship | 02 §3；04 §2–10 | 每模組owner/entity/API/event/state/degraded path齊全 | 1A–2；未跑 |
| RQ-003 | Discord討論/讀書會、LINE即時、GitHub code、Platform facts | Connections/Bindings | 01 §13；05 §7–10；ADR-021/042 | Outage有Portal fallback；不鏡像全文／不把chat當signature | 1B–2；未跑 |
| RQ-004 | 低摩擦、零 automated compliance 阻擋 | All/Entitlement | 00 §8；01 §12；ADR-038 | Zero-blocking UAT；stuck／skip／quota 不 revoke person | 全階段；未跑 |
| RQ-005 | Guild縱向、Squad橫向、一人多職 | Guild/ProfessionMembership/Squad | 01 §3；03 §3.1.1；organization contract | Cross-Guild Squad lifecycle；acting role逐action保存 | 1B–2；未跑 |
| RQ-006 | Rank與office分開且可交接 | ProfessionMembership/OfficeAssignment | 01 §3.4；03 §3.1.1 | Rank不授權；office scope/term/successor/audit | 1B–1C；未跑 |
| RQ-007 | 每模組單一accountable stewardship且可delegate | ModuleStewardship/Delegation | 01 §3.5/4；06 §3.1 | Exactly one active steward；routine queue不需Master逐件簽 | 1A–1C；未跑 |
| RQ-008 | AI Vibe/Field/Project組成一Division三Guild | Division/Guild | 01 §5；04 §7.1；organization contract | Product Council由三個當期 Guild Master OfficeAssignment holders組成；無第四永久boss | 1B–2；未跑 |
| RQ-009 | 三個不同自然人的 Vibe／Field／Project evidence 控制 `commercial-ready` | CommercialEdition/ProductRoleAssignment | 03 §3.1.1/3.6/7.7；04 §7.6/10.4；ADR-011 | 三角色 assignment 本人接受時標籤為 true；same-human／different-agent 維持 false；不阻擋工作 | 2；未跑 |
| RQ-010 | Deterministic定位可跳過、重做、重現 | Assessment/CareerProfile | 04 §2；03 §3.2 | Golden parity；server recompute；self-declare path | 1C；未跑 |
| RQ-011 | Guided discovery產生可修正draft，須本人確認 | GuidedDiscoveryRun/PositioningDraft | 03 §3.2；04 §2.2（C）；OpenAPI | User/AI/unknown分離；unconfirmed draft無權益效果 | 1C；未跑 |
| RQ-012 | 定位後接免費Guild路徑與可選付費人力 | CoachingProgram/Enrollment | 01 §6；04 §9 | Free path always available；paid item標time/capacity/SLA | 1C–2；未跑 |
| RQ-013 | 人人可提交 candidate；有效且本人確認的投稿保存來源、固定版本及相應 Profession 起始 evidence；入會由本人另選確認，不因投稿自動建立 membership | Submission/ProfessionMembership/ReviewSubmission/QualityReview | 03 §3.5；04 §7/10.4；ADR-015 | Submission／入會／acceptance／QC 分開；exact version／protocol／evidence 與獨立自然人 reviewer 控制 `official` 標籤 | 1C–2；未跑 |
| RQ-014 | Software community QC免費；funded work另立案 | ServiceEngagement/EngagementAllocationPlan | 01 §5.3；04 §7/10.4；ADR-016 | Unpaid/funded明示；Platform不套global rate | 2；未跑 |
| RQ-015 | GitHub skills有version、maintainers、discussion、lineage | SkillPackage/PackageVersion | 04 §7；05 §9；skill schema | Commit/hash/license/maintainer/repo-change tests | 1C–2；未跑 |
| RQ-016 | OSS可連CommercialEdition且保留license obligations | CommercialEdition | 03 §3.5；04 §7；ADR-017 | Source commit/license/QC/commercial-mode refs齊全 | 2；未跑 |
| RQ-017 | PR/QC貢獻產生evidence與priority，不產生ownership/royalty | Result/ContributionRecord | 01 §5.2/11；03 §3.10 | No financial obligation from PR；invitation有可解釋evidence | 1C–2；未跑 |
| RQ-018 | Opportunity可帶大lead/fund/investor/sponsor | Opportunity/OpportunityStub | 01 §10；03 §3.10；04 §10.2 | Private minimal stub＋external ref/access negative tests | 1C–2；未跑 |
| RQ-019 | AI/professional service有完整engagement lifecycle | ServiceEngagement/SOW/Milestone | 03 §3.10；04 §10.2 | Versioned SOW/change/acceptance/support/evidence | 2；未跑 |
| RQ-020 | Paid service split由Squad自行簽署 | EngagementAllocationPlan | 01 §5.3/10；04 §10.2 | All affected parties sign exact plan before paid work | 2；未跑 |
| RQ-021 | Agent讀取purpose-limited WorkContext與Daily Feed | WorkContextBundle/WorkItem | 02 §6；04 §8.3/10.3；agent contract | Feed顯why/role/effort/gain/review；raw private data excluded | 1B–1C；未跑 |
| RQ-022 | Claim、TaskLease、AgentRun與execution mode分開 | Claim/TaskLease/AgentRun | 03 §3.10/3.14；04 §10.2–3 | Lease expiry不丟human claim；exclusive/collaborative/competitive tests | 1B–1C；未跑 |
| RQ-023 | A0–A4授權、exact signature與ActionIntent | ExecutionGrant/Signature/ActionIntent | 02 §6.3；05 §3.3.1/5.7；agent contract | A4 fresh digest；chat/Agent不可sign；retry idempotent | 1B–2；未跑 |
| RQ-024 | Platform與GitHub雙向追蹤標準fork/PR/review | WorkItem/GitHubBinding | 05 §9；06 §7–8 | Issue↔WorkItem↔PR↔Result完整provenance | 1B–2；未跑 |
| RQ-025 | 非code artifact也走Draft/Diff/Review/Apply | DraftArtifact（UI alias：ChangeProposal） | 03 §3.14/7.18；04 §10.3 | Listing/QC/Campaign至少一條無DB手改完成 | 1C–2；未跑 |
| RQ-026 | Product、Offer、Listing、Order各自版本化 | Commerce aggregates | 03 §3.6–3.9；04 §3 | Server recalc、snapshot、refund/reversal property tests | 2；未跑 |
| RQ-027 | Master Store只作reference；live fork綁唯一Seller | Store/Binding/SellerParty | 02 §4.3/7；04 §4；commerce contract | Fork無secret/order；binding/origin/contract health tests | 2；未跑 |
| RQ-028 | 一個checkout一個Seller/biller，多Supplier拆子單 | BuyerOrder/SupplyOrder | 03 §3.7–3.8；04 §3–4；commerce contract | One buyer payment/receipt；N SupplyOrders；mixed Seller分車 | 2；未跑 |
| RQ-029 | Reseller/sales-agent責任明示 | SellingArrangement | 03 §3.6；04 §3.2；commerce contract | Six responsibility fields snapshotted and shown | 2；未跑 |
| RQ-030 | MSRP/floor只建議；Supplier接受exact實售價 | SellerListingRevision/DistributionAcceptance | 03 §3.6；04 §3/10.5；commerce contract | Below-guidance不auto-block；price change re-sign | 2；未跑 |
| RQ-031 | Supplier future revoke不破壞短效reservation或已付款承諾 | DistributionAcceptance/SupplyReservation/Fulfillment | 03 §3.6–3.8；state machine | Revoke blocks new reservation；TTL race與paid accepted order tests | 2；未跑 |
| RQ-032 | Seller-owned收款且Platform不custody | SellerCollectionConnection/PaymentFact | 05 §12；ADR-029 | Redirect不算paid；verified webhook/reconcile；clear biller copy；collection權限不等於disbursement | 2；未跑 |
| RQ-033 | 三種應付共用真正API automation且有manual-required路徑 | SettlementMandate/UsageReservation/Instruction/TransferJob | 02 §7.3；03 §3.9；05 §12.4；commerce contract | Sandbox auto-transfer/reconcile；overlap與parallel-cap negative tests；revoke race；只有SupplierPayable觸發fulfillment；unsupported provider enters manual_required | 2；未跑 |
| RQ-034 | Refund/chargeback與分配正確反向 | Refund/Obligation/LedgerEvent | 03 §3.8/3.9；04 §3 | Partial/full/concurrent/duplicate reversal tests | 2；未跑 |
| RQ-035 | Forkable storefront由public BFF安全接核心 | StorefrontBinding/BFF token | 02 §4.3/7；05 §11；ADR-032 | CORS/origin/token replay/price tamper/old-contract tests | 2；未跑 |
| RQ-036 | Product/Skill可導入自動行銷 | Campaign/PublicationJob | 04 §5；05 §13 | Source locks、A3/A4、retry/result-unknown | 2；未跑 |
| RQ-037 | 自動剪輯是行銷擴充 | EditProject/RenderJob/MediaAsset | 04 §6；05 §14 | Ingest/transcript/render/quota/MIME/provider failure tests | 2；未跑 |
| RQ-038 | Quota與身份／Entitlement分開 | Quota/BillingSource | 03 §3.13；04 §5–6 | Exhaustion只阻止該expensive action | 2；未跑 |
| RQ-039 | 會員可export/deactivate並保留必要facts | User/DataExport/Connection | 04 §8.6.1；05 §15–16 | Cross-user export、shared handoff、idempotent deactivation | 1B；未跑 |
| RQ-040 | Guild Lounge安全遷移且角色只屬活動 | Activity/Participation/MediaAsset | 04 §8.8；05 §15；R-GL-* | Race/IDOR/MIME/timer/matching/migration rehearsal suite | 1B–2；未跑 |
| RQ-041 | Rules/config可改但歷史可重現 | Ruleset/Snapshot | 03 §9；ADR-031/037 | Old Order/Result/Signature replay against original hash | 1A–2；未跑 |
| RQ-042 | Platform自身用同一工作系統dogfood | PlatformBuildProgram/WorkItem | 06 §7 | Spec→Issue→Agent→PR→review→release→Contribution完整一輪 | 1A–1C；未跑 |
| RQ-043 | 五個 product repos contract-first 平行開發，四個 governance repos 同步提供共用控制面 | Contracts/Job API/Credential Broker | 02 §4/9；05 §2–6；06 §8；ADR-066 | Generated-client diff、consumer CI、worker no-DB／no-secret tests；Broker IaC 驗 caller deployment→binding→named entrypoint→methods／hard-coded group | 1A–2；未跑 |
| RQ-044 | 一人的付出可轉為可重用資產與下一Opportunity | Result/Skill/Template/Status | 01 §9/11；04 §11 | 每個accepted contribution至少一個reuse/gain/next route | 1C–2；未跑 |
| RQ-045 | GitHub Organization＋Cloudflare＋managed PostgreSQL形成可重播的launch topology | Organization/Deployment/Connection | 08 §1–6/13；ADR-045/046 | Account/role/token isolation；staging DB restore/exit；Worker→Hyperdrive→Postgres E2E；尚未把planned冒充live | 1A–1C；未跑 |
| RQ-046 | 每個獨立 project 有嚴格 manifest、generated GitHub Page 與 canonical 官網連結 | Project/RepositoryBinding/Release/ProjectStatusAttestation | 08 §6–11；project manifest＋status-attestation schemas；ADR-047/048 | Official／fork／private fixtures；GitHub semantic＋JCS／JWS／revocation checks；private repo 不直發 Pages；fork 不繼承 official | 1A–1C；未跑 |
| RQ-047 | Codex／Claude／Grok 經同一 Skill 與 `gh`＋`wrangler` 操作 project lifecycle | SkillPackage/AgentRun/ActionIntent | 08 §12–14；agent contract；ADR-049 | 三個 installers 使用 pinned resolver 解析同一 signed exact closure、FreedomPlanBundle、ContractBundle 與八輸入 activation，不對 mutable registry 重解；sealed session mid-run 不混版。任一 QC、revocation 或 isolation 失敗即 fail closed 且零 domain execution；billable action、法律文件與對外正式發布綁 Ted A4 | 1A–1C；未跑 |
| RQ-048 | External document intake不搬raw bytes且不把confirm誤稱verification | SubmissionDraft/WorkItem/AgentRun | 03 §3.10；04 §10.2；05 §10.4；submission-intake fixture；ADR-051 | Offline confirm只ack saved tuple、零source egress；OpportunityStub無Agent access；source-bound WorkItem需current fenced local receipt，failure fail run且零 consequential effects，success仍須review／A4 | 1C；未跑 |
| RQ-049 | 成員接上 Agent 後可由 domain Skills 完成每日選品、上架、社群宣傳、軟體測試／評分與 spec-driven 開發／審核 | Daily Work Feed/AgentRun/DomainSkillOverlay/DraftArtifact/PR | 03 §3.5/3.14；04 §10.3.1；06 BLD-05；08 §12；ADR-052 | 四個 flow 驗 trigger、exact SkillVersion、A0–A4 與成員簽名；三 CLI 使用 pinned resolver 對同一 signed overlay exact-set 一致，不對 mutable registry 重解，sealed session mid-run 不混版。任一 QC、revocation 或 isolation 失敗回 `capability_unavailable` 且零 domain execution；1B 建 overlay skeleton，1C–2 接完整 slice | 1B–2；未跑 |
| RQ-050 | 每個核心entity有共用versioned說明書與可重建readiness | EntityPlaybookVersion/EntityReadinessProjection | 03 §3.1.2；04 §8.5.3；entity-playbook contract；ADR-054 | Guild／Profession starter／CoachingProgram／Seller Store／SkillPackage五profile；逐item/status/readiness enforcement；missing冪等WorkItem；navigation不403、不改discoverability | 1A–1C；未跑 |
| RQ-051 | 第一天stable-key bundle原子建立Runner membership、WorkIntent與equip並回所有refs | OnboardingBundle/ProfessionMembership/WorkIntent/EquippedSkillSet | 03 §3.1.3；04 §8.5.1；OpenAPI；ADR-055 | Same-key replay、different-body 409、stale-version 412零partial；不用手貼opaque ID；positioning skip可走 | 1B–1C；未跑 |
| RQ-052 | Profession confirmed自動跑可略過welcome並投影支援卡 | WelcomeRitualRun/OperatorFeedCard | 03 §3.1.3；04 §8.5.1；member-onboarding contract；ADR-053 | A0/A1/system/one-line optional步驟分明；未完成仍可learn/submit/claim；routine到delegate，Master只收major/rule/dispute/succession且略過零後果 | 1B–1C；未跑 |
| RQ-053 | 卡住有deterministic條件與零懲罰替代路 | OnboardingJourney/StarterProgress/MemberSkillInstallation/WorkClaim | 03 §8.1；04 §8.5.1；member-onboarding contract | starter idle、install fail/degraded、claim no-progress各產Next/alternative/help/WorkItem；不revoke、不降rank或discoverability | 1B–1C；未跑 |
| RQ-054 | Guild lifecycle／create／update 完整且 private Discord 只是 readiness slot | Guild/EntityReadiness | 03 §3.1.2–3；04 §8.5.3；OpenAPI；ADR-053/054 | draft／active／degraded／archived；private 缺失仍 active／self-join Runner；新 Guild 需求建立 Board WorkItem | 1A–1C；未跑 |
| RQ-055 | 每個 Profession 有 versioned starter track 與 per-membership progress | ProfessionStarterTrackVersion/MemberStarterTrackProgress | 03 §3.1.3；04 §8.5.2；OpenAPI | item 可 skip／替代 evidence／轉 WorkItem；沒有 completion score 或 admission 阻擋；未完成仍可 Feed／claim | 1A–1C；未跑 |
| RQ-056 | 成員實裝與package readiness/equip/AgentRun分開 | MemberSkillInstallation | 03 §3.5/7.3.1；04 §8.5.2；member-onboarding contract；ADR-057 | member+connection+version receipt；health/outdated；wrong scope/fence拒絕；fail只導航；catalog無孤兒adoption event | 1B–1C；未跑 |
| RQ-057 | AgentConnection bootstrap read與第一天standing grant邊界一致 | AgentConnection/ExecutionGrant | 03 §3.14/7.18；05 §5.7／§10.1；OpenAPI；ADR-058 | Connection只有agent.bootstrap.read；A1–A3無grant拒絕；day-one模板≤72h且無法加入A3/A4/payment/contract/QC/release；receipt不是A4 | 1B；未跑 |
| RQ-058 | XP依profession與training／maintenance／real_delivery分軌顯示且可重建 | XpPolicyVersion/MemberProfessionXpProjection | 00 §6；01 §9/12；03 §3.1.1/8；xp-policy contract；ADR-059 | 全表delete/rebuild parity；每列policy version/event seq；無跨profession total；entitlement/rank/appointment/A4負例 | 1B–1C；未跑 |
| RQ-059 | 自然人 Reviewer 以具名、scoped、可撤回且有 review date 的 appointment 成立；AI review 不建立 entitlement | ReviewerAppointment/Entitlement | 01 §12；03 §3.5/7.4；04 §10.4；OpenAPI／entitlement catalog；ADR-060；OD-10 | Ted 持有 appointment authority；active exact-scope appointment 產生 `qc.review` 並控制獨立 reviewer label；高 XP／Master 不自動取得 | 1A–2；未跑 |
| RQ-060 | Accepted review 可更正撤回且舊 receipt 不復活 | ReviewOutcome/ReviewerAppointment | 03 §3.5/7.4；04 §10.4；core state machine；ADR-061 | retracted event 含 retracted_by／reason／original_review_ref；AI checks 與 scoped appointment 驗證 action；不同自然人 evidence 只更新 `official` | 2；未跑 |
| RQ-061 | 五種時間各自有欄位與到期語意 | WorkItem/TaskLease/ExecutionGrant/Evidence | 03 §11；05 §7–9；ADR-062 | invite/claim、delivery、lease+fence、grant、evidence validity的setter/expiry/extension negative fixtures；external timestamp不可代用 | 1B–2；未跑 |
| RQ-062 | Seller 資金執行預設 `record_only`，`authorized_mandate` 綁平台 flag 與 exact mandate | SettlementMandate/TransferJob | 03 §3.9/11；04 §3/10.5；OD-28；ADR-063 | flag false 時無可執行 TransferJob；record-only 只顯示已記錄；authorized 需要 Payer A4 與 Ted 付款類 A4 位於同一 exact mandate digest、active mandate、cap 與 reconciliation，缺一時商店、listing、對帳照常 | 1A–2；未跑 |
| RQ-063 | Review-required 工作可公開作 candidate；exact-scope reviewer capacity 控制 `official` label readiness | WorkItem/ReviewerAppointment/SupportCard | 03 §3.10/7.5；04 §10.2；06 §4.6；ADR-064 | 無 capacity 時保留導航狀態 ID `waiting_reviewer_capacity`，candidate 仍維持 `open`／published 且可領取，並建立 navigation card；缺獨立 reviewer 只影響 `official` 與導航，capacity 出現後只更新 review route 與卡片 | 1B–2；未跑 |
| RQ-064 | GitHub互動只允許本人真實評價，不允許平台操弄 | ExecutionGrant/AgentConnection/GitHub action | 00 §6；01 §13；04 §10.3.1；ADR-065 | 本人決定＋github.star grant＋本人connection正例；平台觸發／批量／獎勵／XP誘導負例；star不進XP | 1C；未跑 |
| RQ-065 | Ted 可將 scoped Reviewer appointment authority 委派給 Guild Master office holder 或具名 delegate | ReviewerAppointment/OfficeAssignment/Delegation | ADR-060；OD-10；RQ-059 | 委派綁 exact scope／term／revocation；未委派時 Ted 持有；不影響 AI review 與 candidate 工作 | 2；未跑 |

### 8.1 RQ-066–RQ-071 修訂追溯

| Requirement | 規則 | 規格／契約 | 驗證 |
| --- | --- | --- | --- |
| RQ-066 | 當次雙方實益、三模式、有限投入與結束 | `01 §11`、`03 §3.10.1`、work-participation schema | T27/T28；UAT-M1 |
| RQ-067 | 求助／協助／共同成果入口，既有Squad自願參與 | `04 §1.1`、`12 §2/6` | T29；UAT-M2 |
| RQ-068 | 核心／非核心總工時、容量原子保留、不隱性補位 | `06 §12.1`、operating-policy | T30/T31；UAT-M3 |
| RQ-069 | 無人／未知回饋有界；保留履約、付款、安全與權益義務 | `12 §5`、core machine | T32/T33；UAT-M4 |
| RQ-070 | 兩條平行首批驗證路徑、資金來源與真人證據控制擴張承諾，不以前置互助次數阻擋外展 | `01 §15/16`、`06 §11`、`08 §3.4`、`12 §9` | UAT-M1–M5；不做會員門檻或外展門檻 |
| RQ-071 | reviewer導航一致；條款版本、server actor與結果語意一致 | core／agent contract／OpenAPI／events | FW-06、T27/T28/T34及本地靜態檢查 |

## 9. Professional confirmation，不阻擋會員與工作

下列確認與建置並行；其 evidence 作用於 arrangement、listing、provider、release 或 policy version 的正確宣稱，不作用於會員是否能加入社群，也不停止 candidate、sandbox、staging 或內部 demo：

- Seller、Supplier、Platform、fulfiller 的交易、發票、稅務、退款、售後與資料責任。
- MSRP／recommended floor／DistributionAcceptance 的合約文字及市場行為；不得用自動規則取代個案判斷。
- Seller、payer 與 beneficiary 自有 provider connection 的帳戶資格、API scope、limits、webhook、refund、reconciliation 與 fallback。
- CommercialEdition、SkillPackage、fork、media、fonts、brand與訓練資料的 license/copyright obligations。
- Contract／QC／price、建立或變更 payout mandate，以及越界 payout 等 A4 簽名的 authentication、authority 與法律證據需求；既簽 mandate 內的 deterministic transfer 不逐筆重簽。
- Retention/export/deactivation、backup region、credential custody、incident window與 dispute SLA。

工程提供 responsibility snapshot、version／digest、evidence、idempotency、reversal、audit、scoped pause 及修復路徑；AI review 與自動 checks 持續執行。

## 10. 現行 planning 檢查

以下都是現行檢查項，不是工作停點。勾選必須附 evidence；目前全部未跑、未勾選。

- [ ] 八模組與五個 cores 各有唯一 ModuleStewardship、repo／path、entities、commands、events、states、projections 與 degraded path。
- [ ] 56 packages、9 repos、12 runtimes／consumers 與四個 Queues 有完整 skeleton；對應測試未跑。
- [ ] Guild／Squad、ProfessionMembership／Rank／Office／Entitlement、Human Claim／Agent Lease 在 API、DB、UI 是不同物件。
- [ ] Open AI Product & Skills Division 的 Vibe／Field／Project 貢獻、得到、Skill、rank、Master duties、標籤與 succession 可追溯。
- [ ] 免費知識／community QC 與付費 dedicated capacity／ServiceEngagement 分開；PR 不自動發錢或產生 ownership。
- [ ] Agent 可依 WorkContext＋Skill＋WorkItem 開工；A0–A3 grant 有 bounds，A4 綁 exact artifact／digest 與相應真人。
- [ ] Discord／LINE 不是 signature 或 canonical work state；GitHub 與 Platform 沒有 Issue／PR／Result 雙主。
- [ ] Candidate、`official`、`commercial-ready`、`production-signed`、sellable 是不同狀態；缺標籤不阻擋工作。
- [ ] Platform build review 使用 Grok＋Claude＋自動 checks；Ted 只處理付款、法律文件、對外正式發布三類 A4。
- [ ] CommercialEdition 保存 OSS source、license 與 obligations；Open Source commercial use 不被誤寫成 proprietary ownership。
- [ ] Master Store 是無 checkout 的 reference；每個實際 Store 綁一個 SellerParty／biller／Seller origin，不同 Seller 分 checkout，同 Seller 多 Supplier 拆 SupplyOrders。
- [ ] MSRP／floor 只顯示建議；Supplier 接受 actual-price `SellerListingRevision`，future revoke 不推翻 TTL 內 reservation 或 paid-order snapshot。
- [ ] SellingArrangement 六個責任欄位、Order split、refund 與 fulfillment terms 在下單時形成 immutable snapshot。
- [ ] SellerCollection、PayerDisbursement、BeneficiaryPayoutDestination 三種 binding、bounded Mandate、atomic UsageReservation、typed Instruction、TransferJob、webhook／reconcile／manual-required 已定義；端到端測試未跑。
- [ ] Platform 不 custody、不建 wallet、不持有 merchant／live payment 帳號，也不把 redirect 或 Seller 口頭回報當 confirmed PaymentFact。
- [ ] 每個 provider／connector 定義 auth、ID、signature、idempotency、retry、result-unknown、reconciliation、degraded mode、PII 與 secret policy；測試未跑。
- [ ] OpportunityStub 最小化敏感資料；ServiceEngagement 具 SOW／change／acceptance／support 與 signed allocation。
- [ ] `ai-online` parity、`positioning-companion` guided eval 與 single card schema 已定義；驗證未跑，兩者不直接 grant rank／Entitlement／enrollment。
- [ ] Lounge exposure、R2 object access、SVG、race、host scope、server timer、archive 與 migration tests 均未跑。
- [ ] `community_id`、workspace、provider tenant 與 SellerParty 不混用；cross-scope negative tests 未跑。
- [ ] Projection rebuild、restore、retention／export／deactivation、credential rotation、provider outage 與 manual exception 有 runbook；演練未跑。
- [ ] 所有公開宣稱標示 `planned|beta|live|unsupported`；每個 OD 有 decision evidence，Ted replacement 以日期與 exact value 回填。
