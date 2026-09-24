# 領域模型、事件、簽名與狀態機規格

> 狀態：現行 canonical baseline（2026-09-19 低維運互惠修訂）；planning 文件，不代表已部署。
>
> 2026-09-24 對照：本文是 canonical target。base `8338a42` 的公開會員 beta 只用到局部子集：`sessions`、WorkItem `open/claiming_closed/accepted`、WorkClaim `claimed…accepted`（無 released／cancelled／expired）、BenefitObservation，以及本地 `transition_journal`／`outbox`（非 §4 envelope、無 eventsequence／dispatcher）。`identity.external_identities`、Party、Entitlement、ReviewerAppointment、Agent Control 與其餘 aggregate 尚未實作；差異見 [2026-09-23 落差對照](../development/plan-drift-2026-09-23.md)。

本文的事件名稱與狀態名是其他文件及 machine-readable scaffold 的 canonical vocabulary。

## 1. Canonical model 的設計原則

1. 一個人只發一個平台 `user_id`；LINE、Discord、GitHub 和電商帳號只是外部身分連結。
2. Positioning 結果、自選職業、活動角色、Guild 關係、WorkRole 和 Entitlement 分開。
3. `SkillPackage`／`Product`、`Offer`、`Order` 是三種不同物件。
4. 任何會影響金額的規則在 Order 成立時保存 snapshot；日後改規則不改舊單。
5. `ResultEvent` 記「誰做成什麼」；`LedgerEvent` 記「錢／成本如何變動」；兩者不可互相取代。
6. ResultEvent 是可查事實，不做全平台總分。
7. LedgerEvent 和 DomainEvent 追加不覆寫；錯誤用 reversal 或 superseding event。
8. mutable aggregate 用明確 state machine、version 與 optimistic concurrency。
9. 所有外部事件可重送；consumer 必須冪等。
10. 規則版本、證據程度與責任情境在發生當下分開保存。
11. Guild 是長期縱向專業組織；Squad 是為一個案件成立的橫向交付團隊，兩者不可混成同一種 membership。
12. `Runner / Strategist / Master` 是專業熟練度；`Officer` 是可交接的治理職務。Rank 不自動授予 office，office 也不改寫歷史 rank evidence。
13. Agent 不是會員、Master、reviewer 或收款人；它只可代表已驗證的人／組織 principal，在明確 acting role 與授權內執行。
14. AI 可主動找工作、擬稿與執行已授權動作；正式 QC、金額／合約承諾與 release authority 仍綁人類對精確版本的簽名。
15. 所有正式／商業 Listing 都先有 version-scoped QC；QC 是產品責任，不是全社群入會條件，也不以黑箱分數卡住候選作品的討論、fork 或修改。
16. 一個checkout只有一個buyer-facing`SellerParty`／biller。平台不代收；同一Seller可向多個Supplier進貨，verified paid後按已簽來源建立SupplierPayable／明示CommissionObligation與人工明細。資金執行預設 `record_only`；`authorized_mandate` 在 `money_movement_enabled=true`、Payer 當事人對 exact `SettlementMandate` 的 A4、Ted 對同一 digest 的付款類一鍵 A4 都在時可執行。
17. 開源貢獻、QC 與熟悉度形成 evidence 與未來受邀優先序，不自動形成著作權、永久抽成或 project 收益；付費案件由該 Squad 另行簽 `EngagementAllocationPlan`。

## 2. ID 與共通 Value Objects

| 名稱 | 格式／內容 | 規則 |
| --- | --- | --- |
| `UserId` | opaque UUIDv7/ULID | 不使用 LINE UID、手機、email 或會員代碼作 PK |
| `CommunityId` | opaque ID | 資料／權限的社群 tenant scope；即使初期只有一個也明示，不使用「workspace」混稱 repo 工作空間 |
| `OrganizationId` | opaque ID | 買家公司、社群單位或賣方組織 |
| `PartyId` | opaque ID | 交易參與者 stable identity；恰好映射一個 User 或 Organization，Seller／Supplier／Payer／Beneficiary 是作用於它的交易角色，不是另一套帳號 |
| `GuildId` | opaque ID | 一個長期縱向 profession guild |
| `SquadId` | opaque ID | 一個有目的／期限的橫向交付團隊 |
| `SubmissionDraftId` | opaque ID | 從 Portal、LINE、Discord 或外部文件引用建立、尚待 owner 確認的私密進件草稿；不同於完成 WorkClaim 後的 `work_submission` |
| `WorkItemId` | opaque ID | 人與 Agent 可認領的 canonical 工作 |
| `AgentRunId` | opaque ID | 一次可追蹤、可中止的 agent execution |
| `PackageId` | `skill:<namespace>/<slug>`＋internal ID | stable ID 不含版本 |
| `PackageVersionId` | internal ID＋semver/tag/commit ref | 指向不可變 source snapshot |
| `ProductId` | opaque ID＋可讀 code | 商品／服務／軟體本體 |
| `OfferId` | opaque ID＋可讀 code | 某種賣法、價格、交付與分潤 |
| `OrderId` | opaque ID＋public order number | 一次買家承諾；不以 provider trade no 當 PK |
| `OpportunityId` | opaque ID | 一個商機、資源或合作來源；可公開或私密 |
| `ResultEventId` | opaque ID | 一個可確認結果事實 |
| `LedgerEventId` | opaque ID | 一個不可變金額動作 |
| `Money` | domain/DB：int64 `amount_minor bigint + currency`；JSON：bounded decimal string | 不用float；price/payment/cap/payable/refund使用non-negative或positive型別，只有delta使用signed型別；validator驗int64 bounds與正負限制，同一split basis必須同幣別 |
| `ExternalRef` | provider、tenant/account、external_id | 三者一起 unique；display URL 不作主鍵 |
| `EvidenceRef` | type、URI/object key、hash、issuer、captured_at | 預設保存引用，不把大型內容塞 event |
| `RuleRef` | id、version、hash | 能重現當時決策；event、API 與 snapshot 使用同一欄位名 |
| `ActorRef` | accountable principal `user/organization/activity_guest/service/integration/system`＋ID＋`acting_as`，可另帶`agent_execution` | Agent不是principal；有AgentRun時只在nested provenance記connection/run/grant。`acting_as`是本次職業／office／project role，不是自行宣告權限 |
| `ArtifactRef` | type、id、revision/version、digest | 正式簽名與 review 必須固定 exact artifact，不接受只簽 mutable URL |

`Enforcement`只有`navigation|action_gate`。凡是 playbook item、checklist item、status 或 readiness 欄位都保存此值；預設為`navigation`。`action_gate`必須另存`gate_class=engineering_safety|money_integrity|product_version_qc|a4_exact_artifact_signature`與被擋的`target_action`，不得指向一個人的註冊、討論、學習、瀏覽、Profession Runner 自助加入、裝備、一般 submission 或低風險 WorkItem claim。`navigation`缺項可materialize WorkItem，但不改權限、rank、推薦資格或可發現性。

## 3. 核心資料物件

下列是 domain entities，不表示每個 entity 必須一張表；實作時按查詢與一致性正規化。

除純全域 schema catalog 外，所有 aggregate、fact、binding、inbox/outbox 與 projection 都帶不可由 client 任意指定的 `community_id`，unique/index/authorization/reconciliation 必須包含此 scope。Launch 只啟用一個 Freedom community；這個欄位是清楚的資料邊界與未來演進保留，不表示已完成通用多租戶 SaaS。

### 3.1 User 與 Organization

`identity.users`

| 欄位 | 型別 | 必填 | 說明 |
| --- | --- | --- | --- |
| `id` | UserId | 是 | 中央會員 ID |
| `display_name` | text | 是 | 可改，不作識別 |
| `locale` | text | 是 | 預設 `zh-TW` |
| `timezone` | text | 是 | 預設由會員確認 |
| `status` | enum | 是 | `active/paused/deactivated` |
| `version` | bigint | 是 | optimistic concurrency |
| timestamps | timestamptz | 是 | created/updated |

`identity.external_identities`

| 欄位 | 說明 |
| --- | --- |
| `user_id` | owning user |
| `provider` | `line/discord/github/payment_provider/...` |
| `provider_tenant_id` | Discord guild、GitHub installation 等範圍 |
| `provider_subject_id` | provider stable subject |
| `status` | linked/revoked |
| `linked_at`, `last_verified_at` | 連結時點 |

Unique：`provider + provider_tenant_id + provider_subject_id` 只能連一個 active user。

`identity.organizations`、`organization_memberships`

- Organization 可同時是 buyer、seller 或 partner，但角色用 relationship/entitlement 表達。
- Membership role 僅對該 organization 生效，不等同平台 admin。
- 公司訂單由 `buyer_organization_id` 引用，不另外複製一套會員登入。

`identity.parties` 與 `commerce.party_roles`

- `identity.parties(id, subject_type=user|organization, subject_id, status, version)` 提供跨交易的一致 `PartyId`；同一 active subject 只能有一個 Party，停用 Party 不刪歷史訂單或應付。
- `commerce.party_roles(party_id, role_type=seller|supplier|payer|beneficiary, status, capability/evidence refs)` 是可並存、可撤銷的 scoped relationship。`SellerParty`、`SupplierParty`、payer 與 beneficiary 都指向這個 Party，不複製名稱、登入或 organization membership。
- 每筆 identity-backed BuyerOrder、DistributionAgreement、Mandate、obligation 與 destination snapshot 都保存 PartyId；guest BuyerOrder 則保存最小 `guest_snapshot`，claim 後才另連 User Party，不倒改原買家事實。顯示資料從當時 snapshot 讀取，authorization 則重新驗目前 subject／role，不以可改 display name 判斷身份。

`identity.member_connections`

- `MemberConnection(id, requester_user_id, recipient_user_id, shared_contact_scope, state, accepted_at, ended_at, version)` 是雙方同意的人際接點；unordered pair 在 requested／active 狀態至多一筆。
- lifecycle 為 `requested → active → ended`，requested 亦可 `declined/cancelled`。它不讀取外部私訊，也不等同 integration context 的 provider `Connection`。

`identity.notification_preferences`、`identity.data_sharing_consents`

- 通知偏好按 category＋destination 保存 `enabled/quiet_hours/timezone`，而非只放一個全域開關。
- consent 保存 purpose、scope、state、policy ref、actor 與 granted/revoked time；撤回只停止後續對應用途，不假裝抹掉必要交易事實。
- LINE／Discord 失聯不改會員、權益或成果狀態；Status 仍提供 Portal fallback。

### 3.1.1 Guild、Profession、Rank、Office 與 Squad

`organization.divisions` 是相近 Guild 的治理組合；`organization.guilds` 是長期縱向專業線；`delivery.squads` 是短期橫向案件團隊：

| 物件 | 必要欄位 | 不變量 |
| --- | --- | --- |
| `ProfessionDefinition` | key、name、purpose、contribution、gain、rank rubric、skill refs | 可版本化、可淺顯修改；不先窮舉所有行業 |
| `Guild` | aggregate identity：profession key、name、purpose、pinned playbook ref、lifecycle／aggregate version；create command 的完整 client-required set 固定為 `profession_key`、`name`、`purpose`、`playbook_key`、`expected_catalog_version`，其餘 identity 由 server 產生／解析 | 對專業品質、人才與模組 stewardship 負責；不直接擁有每個 Project 的錢；下列 playbook slots 不是 create guard |
| `ProfessionMembership` | user、profession、Guild、current rank record、evidence refs、status | 一人可同時加入多個 profession；rank是該membership的版本化record，每次工作仍只選一個acting role |
| `XpPolicyVersion` | policy id、profession key、version、effective window、三軌公式、source／dedupe／rebuild contract | 每個 profession 同時最多一份 active version；公式必須可讀且 deterministic |
| `OfficeAssignment` | office type、scope、holder、term、accepted/ended time | `Guild Master` 類似該線 Chief Officer；可交接，不把 Rank 命名成 Officer |
| `ModuleStewardship` | module key、accountable guild、master office、delegates、decision scope | 每個模組恰有一個 accountable Guild/Master；日常 review/release 可委派 Strategist／skill owner |
| `Squad` | purpose、opportunity/project ref、members/roles、start/end、allocation plan ref | 跨 Guild 組成；完成／取消即 close，不取代成員的 Guild 關係 |

Rank canonical vocabulary：`runner → strategist → master`。晉級依可查 evidence 與 Guild rubric；不以全站分數或活躍天數自動晉級。Master office holder 維護方向、人才容量、training、master skills repo 與重大爭議；不必親自 coding，也不是每個 PR 的瓶頸。

`XpPolicyVersion` 的 track 是閉集 `training|maintenance|real_delivery`。XP 只是一個 profession 內、按 track 分開的可重建成長顯示；跨 profession 不加總，API／UI 不提供全站總值。它不得作 `EntitlementSnapshot`、RankRecord decision、`ReviewerAppointment` 或 A4 HumanSignature 的輸入。

Guild 的 operational completeness 只由 pinned `guild.launch-readiness` playbook 表達，與上表 aggregate identity 分開；首版 stable item ID 精確為 `guild.master-office`、`guild.training-route`、`guild.public-community-route`、`guild.private-discord-channel`。四項一律 `enforcement=navigation`、可略過並可委派補齊；missing 可產生 WorkItem 或令 readiness／lifecycle 顯示 `degraded`，但不得阻擋 Guild 建立／`active`、既有 Guild 的 self-service Runner 加入、權益、rank 或未來可發現性。Master office 亦採 delegate-first，不得成為第一天瓶頸。

OfficeAssignment結束與接續不可分成留下治理空窗的兩步：正常handover須在同一transaction啟用successor office及受影響ModuleStewardship revisions；尚無successor時，先啟用每個受影響模組的formal interim stewardship、temporary delegate與公開succession WorkItem，才可結束原office。

`Open AI Product & Skills Division` 第一版包含三個分開的人才線，共用一個產品議事層，沒有額外第四個永久主管：

- `ai_vibe`：設計、寫 code、文件與可重現 build；主要能力是 AI vibe coding。
- `ai_field`：測試、review、推廣、回饋、部署、FAE、support 與 implementation。
- `ai_project`：傳統 PM、客戶探索、商機、scope、銷售與協調 Vibe／Field 交付。

三個 Guild 的當期 `Guild Master` OfficeAssignment 持有人組成 `Division Product Council`。一個開源產品進入正式 commercial-ready 程序時，至少有三個不同自然人承擔 Vibe、Field、Project；QC reviewer 亦須符合獨立性規則。相同人切另一角色或換另一個 Agent 不算獨立人員。這些條件只決定 `commercial-ready`／`official` 標籤；candidate、proposal、內部工作照常。

### 3.1.2 EntityPlaybookVersion 與 EntityReadinessProjection

`organization.entity_playbook_versions`是人與agent共讀的跨entity說明書，第一批固定涵蓋`guild|profession_starter|coaching_program|seller_store|skill_package`。每版保存`playbook_id`、`entity_kind`、applicability、version/hash、lifecycle，以及stable `item_id`、說明、evidence/status resolver `RuleRef`、owner pool、entry/degraded path、`missing_work_item_template_key`與`enforcement`。發布後不原地修改；新版只影響之後建立或明確遷移的projection。

`projection.entity_readiness`以`community_id + entity_kind + entity_id + playbook version/hash`唯一，逐項保存`satisfied|missing|in_progress|not_applicable|unknown`與各自`enforcement`、evidence refs、nullable materialized WorkItem ref及calculated time。Overall readiness本身也保存`enforcement`，只摘要，不計完成率或總分。Resolver輸入只讀canonical facts／verified binding health；projection可刪除後重建，不反向成為權威。

缺項materialize使用`entity instance + playbook version + stable item_id`作冪等scope，恰建立或回傳一張可認領WorkItem。Guild private Discord channel是`navigation` slot，owner pool為Community Ops／Guild delegates；缺少時Guild仍可`active`、成員仍可自助成Runner，現行public-community route維持。SkillPackage既有capability manifest在此作profile：candidate visibility永遠是navigation；只有exact runtime／official／sellable等已承認動作可映射到四類`action_gate`。

### 3.1.3 Guild、starter track、第一天 journey 與歡迎儀式

`organization.guilds`另存`lifecycle=draft|active|degraded|archived`與aggregate version。`draft→active`不以readiness完成為guard；外部connector缺失可把`active→degraded`並顯示替代Portal route，不能改ProfessionMembership。現行不開放一般會員直接create Guild；`GET /guilds`公開`new_profession_line_work_item_template_key`，申請新職業線就是一張Board WorkItem。`POST/PATCH /guilds`只給Board／delegated Community Ops operator，且仍無admission approval queue。

`ProfessionStarterTrackVersion`是`profession + runner entry policy`的versioned playbook；`MemberStarterTrackProgress`以ProfessionMembership與pinned版本唯一。每項可`satisfied|skipped|stuck|alternative_evidence`，可轉WorkItem，全部`enforcement=navigation`。沒有完成率、admission score或自動rank；skip／stuck／替代evidence不影響加入、Work Feed或未來可發現性。

`projection.member_onboarding_journey`按成員重建固定順序：identity → optional positioning → profession confirmation → coaching或starter package分岔 → equip → member installation verify → welcome ritual → first bounded WorkItem。每個step與overall status都有`enforcement=navigation`；定位可skip且與self-declare同權。Canonical `ConfirmMyOnboardingBundle`只收stable profession/package key，在一個idempotent transaction建立或回傳Runner ProfessionMembership、confirmed WorkIntent、profession-scoped equipped set並回傳全部opaque refs；不得讓新人或agent手貼opaque ID，也不允許partial commit。

`WelcomeRitualRun`由`freedom.organization.profession.confirmed.v1`觸發。無人步驟：resolve pinned starter track、建歡迎卡、產生Portal／可用channel deep link與第一張bounded WorkItem候選；A0步驟：整理starter track、解釋建議package與替代路；A1步驟：取得ExecutionGrant後才做local preflight；唯一成員輸入是可略過的一句`one_line_goal`。任何步驟未跑、失敗或被略過，都不阻擋學習、submission、claim或其他操作。

四種typed support card為`new_runner_joined|starter_installation_verified|member_stuck|member_requested_help`，每張保存membership/journey/item/receipt refs、reason、suggested action、route、`enforcement=navigation`與dismissal effect。Routine card先進Strategist／delegate pool；Master只收重大版本、規則、爭議、succession或其摘要。任何人不處理、略過或逾時均對新人零後果；不存在「Master簽了新人才能繼續」的transition、guard或queue。

### 3.2 CareerProfile

`positioning.assessment_runs` 是可中斷、可匿名的 mutable aggregate：

- `id`、`owner_user_id` nullable、`definition_id`、`lifecycle_state`、`aggregate_version`。
- 匿名建立前由 Identity 發短效 `guest_session_id` cookie；create idempotency scope 包含此 ID，不使用 IP/fingerprint，`Idempotency-Key` 本身不是 access credential。
- `guest_access_token_hash` 只准操作該 run；`claim_secret_hash`、`claim_expires_at`、`claimed_at`、`claimed_by_user_id` 支援新平台 guest claim。
- 建立 run 時 server 固定 ruleset/content refs；client 只送 raw answers 與 run revision，不可指定 score 或 derived versions。
- secret 只產生一次；aggregate DB 只存 hash，不能進 event、log 或 analytics。為承受首次 `201` response 遺失，短 idempotency window 可在獨立、加密、有 TTL 的 response store 重播同一份 secret，且 response 帶 `Cache-Control: no-store`；TTL 後不復原 secret，只能另建 run。

`positioning.assessment_results` 保存一次伺服器完成的 immutable evaluation；它與會員最後宣告的 CareerProfile 分開：

- `assessment_run_id`、raw-answer snapshot hash、direction scores/contributions、explanation refs。
- `ruleset_ref={id,version,hash}`：題目與計分規則。
- `content_ref={id,locale,version,hash}`：當時呈現的題目／結果文案。
- `evaluator_ref={name,version,build_sha}`：執行計算的 positioning-core build。
- `recommendation_policy_ref={id,version,hash}`：從結果映射到 Track/Skill/Coaching 候選的政策。
- `completed_at`、server result hash；完成後不原地改寫，重做另建 result。

assessment result 只回傳 direction candidate 與理由，欄位不得命名為 `qualified`、能力機率或就業保證。匿名 session 由高熵一次性 claim secret 綁會員，不能靠 email/name 模糊合併。

`positioning.career_profiles`

| 欄位 | 說明 |
| --- | --- |
| `id`, `user_id`, `revision` | 同一人可多版本 |
| `source`, `source_ref` | `assessment/self_declared/coach_assisted/imported`；assessment 必須指向 `assessment_result_id` |
| `real_world_occupations[]` | 現實職業；可多個 |
| `direction_archetypes[]` | 定位原型與相對分數／解釋 |
| `selected_tracks[]` | 本人確認想走的 CareerTrack |
| `goals[]` | 想解決的問題／成果 |
| `constraints` | 時間、預算、工具、語言、地區、不要項目 |
| `ruleset_ref` | assessment 規則版本；自選時可 null |
| `confirmed_at` | 本人確認時間 |
| `supersedes_id` | 新版取代哪版；舊版不刪 |

不變量：任何 assessment output 只能建立／建議 profile，不可直接寫 privileged entitlement。

`positioning.guided_discovery_runs` 支援 `positioning-companion` 的 AI 對話式探索，與 deterministic AssessmentRun 並存而不互相冒充：

- 保存 `conversation_ref`（最小必要摘要，不預設保存外部聊天全文）、prompt/model/skill version、started/completed time 與 owner。
- 每次可編輯 `PositioningDraft` 使用同一 canonical `positioning-card/v2`，不再維持 quick/full 兩套漂移 schema。
- draft 最少包含 `user_words[]`、`ai_suggestions[]`、`unknowns[]`、`first_evidence`、`falsifier`、`fallback`、goals、constraints 與 candidate tracks/professions；每一項區分「使用者原話」和「AI 建議」。
- `strategy_mode=content/workflow/business_amplifier/pause`只是下一步探索／運用方式，不加入ai-online的八個DirectionArchetypes，也不當第九種人格。
- `evidence_state=unknown/exploring/ready_for_first_test` 只說明下一個可驗證小步，不是資格判定。
- `GuidedDiscoveryRun completed` 只產生 suggested `CareerProfile`／`WorkIntent` draft；須由本人逐欄確認後才成為 active revision，不建立付費 enrollment、Entitlement、Guild rank 或工作承諾。

### 3.3 Entitlement

`entitlement.definitions`

| 欄位 | 說明 |
| --- | --- |
| `key` | 例如 `promotion.basic` |
| `scope_type` | global/package/offer/store/guild/opportunity |
| `grant_rule_ref` | 版本化規則；可為 self-service |
| `capabilities[]` | API 可檢查的操作 |
| `display_gain` | 使用者得到什麼的淺顯說明 |
| `obligations[]` | 若有，說明行為而非隱藏條款 |
| `revocation_mode` | self/manual/admin；前期不使用 compliance bot |

`entitlement.user_entitlements`

| 欄位 | 說明 |
| --- | --- |
| `id`, `user_id`, `definition_key` | entitlement identity |
| `scope_type`, `scope_id` | 限定哪個 package/offer/store 等 |
| `state` | `available/active/paused/revoked/expired` |
| `grant_source_type/id` | action、ResultEvent、invite、manual |
| `rule_ref` | 發放時規則 |
| `activated_at`, `expires_at` | expires 可 null |
| `state_reason` | 人可理解原因 |
| `version` | concurrency |

不變量：收回 entitlement 不刪 User、CareerProfile、Package authorship、ResultEvent 或 LedgerEvent。

### 3.4 CareerTrack、Guild 與 StudyGroup

`positioning.career_tracks`

- `id`, stable key, name, description, status。
- `parent_track_id` 可形成逐步細分，不預先定義全世界職業。
- `recommended_package_ids[]` 應由 relationship table/versioned mapping 保存。
- `discord_channel_binding_id`、`default_coaching_program_id`。

`organization.guilds`

- 一條 track 可有一個主要 Guild，也可跨多 tracks。
- Guild membership 是社群關係；coordinator 能力以 scoped capability 另授權。
- Guild 不直接擁有交易、member suspension 或 package ownership。

`community.study_groups` / `community.activities`

- `type=reading_group/workshop/demo/lounge/...`
- `external_event_ref` 指向 Discord Scheduled Event 等。
- 出席與完成成果分開：`activity.attendance.recorded` 不等於 `skill.run.completed`。

### 3.5 SkillPackage 與版本

`skill.packages`

| 欄位 | 說明 |
| --- | --- |
| `id`, `namespace`, `slug`, `name` | stable identity |
| `summary`, `problem_statement` | 解決什麼問題 |
| `source_repo_ref` | GitHub repo stable ref |
| `discussion_bindings[]` | Discord bindings，可依 general/beginner_help/maintainer/study_group 與 audience level 分流 |
| `license_expression` | SPDX expression 或 `NOASSERTION` |
| `publication_state` | draft/candidate/official/archived；candidate 可被看見、討論、fork 與修正，official 才代表指定版本完成 QC |
| `current_recommended_version_id` | 可 null |
| `created_by`, timestamps | source |

`skill.package_versions`

- `package_id`, version label, commit SHA, manifest hash。
- target occupations/tracks、entry level、time/cost、dependencies、platforms。
- install/use/demo/docs/video URL。
- known limitations、responsibility boundary、data/runtime needs。
- `requested_capabilities[]` 與逐項 `capability_readiness`；每項保存 state、validator version、report ref 與 validated time。Validator 只決定 documentation／installation／execution／dependency resolution／version sync 等技術能力；`commercial_binding` 另需該 commit 的人工 QC signature，不能由 schema validator 自動背書。
- `health_state=active/deprecated/withdrawn/unmaintained`。
- automation/field-use/maintained evidence 由獨立 evidence/result relationship 形成 badge。
- 已發布版本內容不可原地覆寫；同版本 label＋不同 hash 拒絕。

`skill.package_maintainers`

- package/version scope、user/organization、role、accepted_at、ended_at。
- 作品可以移交或 fork；歷史 maintainer 不被改成「從未存在」。

`skill.package_lineage`

- child package/version、parent repo/version、relationship `fork/derived/rewrite`。
- lineage 用於 attribution、相容性和感謝，不自動產生商業分潤。

`skill.member_skill_installations`是成員環境實裝aggregate，唯一key至少含`member_user_id + agent_connection_id + package_version_id`，另存platform/runtime profile、state、aggregate version、latest A1 receipt與remediation WorkItem ref。State為`recommended → equipped → installing → verified|failed|degraded`，`verified→outdated`，各狀態可recheck，成員可`removed`。每個state、receipt outcome與對外readiness均帶`enforcement=navigation`。

A1 receipt綁exact PackageVersion/digest、AgentConnection client instance、validator version、最小platform profile、checked time、command/result digest與`pass|fail|degraded`；它是已驗證connection代表該成員環境的fenced provenance，不是假稱server remote attestation。`capability_readiness`回答「package是否提供可驗的能力」；equipped回答「成員選哪版作matching/context」；MemberSkillInstallation回答「這個connection環境是否裝好」；AgentRun回答「某次工作實際用了什麼」。四者不得互相冒充。

Install fail/degraded/outdated只建立Next、替代手動路徑、可選求助與一張冪等WorkItem；絕不撤銷membership／entitlement、降低推薦或阻止candidate submission。`failed`與`degraded`是不同 domain facts，分別發布`freedom.skill.member_installation.failed.v1`與`freedom.skill.member_installation.degraded.v1`，consumer 不必讀 payload 才能分流；裝備與實裝分別使用`equipped_skills.replaced`及`member_installation.*`事件。

`skill.runtime_overlays` 是 domain Skill 可被 Agent launcher 執行時的獨立 trust object；它不改寫 `SkillVersion`，也不把一般 candidate 自動升成可執行：

| 欄位 | 說明 |
| --- | --- |
| `overlay_id`, `sequence`, `community_id` | immutable signed overlay identity；同一 identity sequence 只能單調增加 |
| `runtime_mode` | 固定 `signed_isolated_overlay_v1` |
| `control_activation_digest` | 既有 `freedom-build-system` 八輸入 activation digest；overlay 不重算或取代它 |
| `runtime_roots_set_digest` | `SHA-256(JCS({control_activation_digest,domain_roots}))`；`domain_roots` 依 `skill_version_ref` 排序，逐項綁 package／archive／dependency closure／QC digests |
| `domain_roots[]` | 1–16個server-derived WorkItem exact SkillVersion refs；每項含immutable package identity、archive locator/digest、resolved closure digest與exact runtime-scope QC admission |
| `publisher_authority`, `proof[]` | current bootstrap index／policy／keyset chain；detached JWS 恰有兩個不同且有效的 publisher `kid` |
| `revocation_binding` | current cumulative snapshot、minimum／current sequence、artifact／statement digest 與 exclusive expiry |
| `isolation_profile` | 固定 `per-run-sealed-domain-overlay-v1`；不得落入 host／workspace／global plugin discovery |
| `issued_at`, `valid_from`, `expires_at` | signed validity window；新 session 每次重驗，不能以 cached last-known-good 延命 |

Runtime-scope QC 必須由非 exact package submitter 的另一位自然人，依 versioned protocol 對 exact `skill_package_digest` 與 `package_archive_sha256` 作 `accepted_for_isolated_runtime` decision，並引用 Agent Control 的 exact HumanSignature。這只代表該 bytes 可進隔離 runtime，不自動授予 `official`、commercial-ready、效果保證或任何 ExecutionGrant。Overlay publisher 只組裝已通過 QC 的 exact roots，不得自行替 QC 下結論。

`domain_skill_runtime_mode` 有兩個 v1 值：

- `eligibility_and_provenance_only_v1`：fail-closed 預設；refs 只供 matching、資格與 provenance，不下載、不 materialize、不 discover、不執行。
- `signed_isolated_overlay_v1`：只有 signed overlay schema、exact roots-set、runtime-scope QC、current publisher authority、current revocation、safe extraction／content-addressed cache與 per-run isolated loading 全部通過才可由 server 選用。

切換驗證是逐 AgentRun、逐新 session 執行，不是全域 feature flag：server-derived WorkItem refs 必須與 overlay roots exact-set 相等，client request 不得自報 mode、roots 或 overlay。任一缺件、過期、撤銷、digest/QC mismatch、name collision、host shadow 或 adapter isolation unsupported，若 task 需要 domain runtime 就回 `capability_unavailable`，且不得執行任何 domain Skill bytes或 consequential effect；不需要 runtime 的 task仍可留在 eligibility-only mode。

任何人都可提交 candidate；結構有效且本人確認的 software／Skill／code submission 建立 `Submission`，保存來源、固定版本與起始 evidence。實體貨品、行銷、供應或 service submission 形成該次 acting／corresponding Profession 的 candidate evidence。所有投稿均不自動建立 ProfessionMembership；公會由本人另行選擇並確認加入，受保護的開發操作另查適用公會資格。Submitted、accepted、QC decision 與 official 狀態始終分開。社群可以自由測試 candidate；官方推薦、商業綁定或 Store sellable listing 必須指向已完成相應 scope 的 `QualityReview`。

`quality.review_protocols`、`quality.reviewer_appointments`、`quality.review_submissions`、`quality.reviews`：

| 物件 | 核心內容 |
| --- | --- |
| `ReviewProtocolVersion` | product type、scope、checklist/test recipe、required evidence、reviewer rubric、version/hash；由 accountable Guild Master 發布 |
| `ReviewerAppointment` | `appointment_id`、具名自然人的 `appointer_ref`、`subject_member_ref`、`scope`、`granted_at`、`review_by`、`revoked_at?`、`reason`；v1 appointer 只能是 OD-10 Guild Officeholders Council 的具名自然人 holder |
| `ReviewSubmission` | subject artifact/version/digest、requested scopes、submitter、candidate listing/package ref、state |
| `QualityReview` | reviewer user、acting profession/rank、protocol ref、test environment、findings/evidence、decision、reviewed digest、`decision_signature_ref` |

`decision_signature_ref` 必須指向 Agent Control 唯一寫入的 `agent.human_signatures`；Quality 只引用，不得另建平行 signature table。Agent 可準備 evidence／decision draft，但不能成為 reviewer 或 signer。

Reviewer送出 immutable QualityReview 時先發布 `freedom.quality.review.submitted.v1`；同一 command transaction 再依其 signed decision 將 ReviewSubmission 轉為 `accepted` 或 `changes_requested`，分別發布 `freedom.quality.version.accepted.v1`／`freedom.quality.version.changes_requested.v1`。兩個 event 各有自己的 contiguous sequence，不把「送出證據」和「版本 verdict」混成同一名稱。`qc.review:<scope>` 只能由同一 scope 的有效 `ReviewerAppointment` 投影取得；XP、rank（含 Master）或熟悉度都不能自動建立 appointment。

已接受的 review outcome 可由該 scope 有效 appointment holder 撤回，另發 `freedom.quality.review.retracted.v1`，payload 至少保存 `retracted_by`、`reason`、`original_review_ref`。原 reviewer 可依自己的有效 appointment 撤回；若由另一位 appointment holder 發起，還需第二位不同自然人的有效 appointment／A4 exact decision 共同成立。第二人 UI 與 dispute SLA 尚無更細來源，列入 RQ-060，不由實作者自行放寬。撤回只追加歷史，不刪原 review；原 receipt 再送回 `receipt_superseded_by_retraction`，不得把 outcome 復活。撤回後該 accepted result 不再供 XP、配對優先度或 entitlement projection 使用，無關 evidence 與會員狀態不受影響。

- Software／Skill 的 community QC、review、test 永遠零費；它只建立 Field/Vibe evidence、產品熟悉度與未來 FAE／support／implementation 邀請優先序，不產生付款義務。
- 實體或第三方貨品可由 QC Guild 針對檢驗服務建立明示收費 Offer；費用不等於保證銷量。
- 有客戶／sponsor 出資的testing/review/development才在獨立customer-sponsored `Project`下建立`ServiceEngagement`；費率與分配由該Squad簽署，不由平台公式硬算，也不回頭改寫community QC。
- Reviewer 必須是另一個自然人，且不能 review 自己提交的 exact artifact。Master 定 protocol、training 與重大版本／爭議；符合 protocol 的 Strategist、skill owner 或授權 reviewer 可處理日常版本，避免 Master 成為單點瓶頸。
- 「授權 reviewer」在 canonical 上只指持有效 `ReviewerAppointment` 的自然人；Strategist、skill owner 或 Master 名稱本身都不授予 `qc.review:<scope>`。

### 3.6 Product、CommercialEdition、SupplierOfferVersion、DistributionAgreement、Offer 與 SellerListing

`commerce.products` 是可被供應／交付的本體：

- type：`physical_good/digital_good/software/service/coaching`；owner/supplier、variants、assets 與供應狀態分開。
- Product 不含某 Seller 的售價或分配；一個 Product 可有多個 supplier／seller arrangements。
- Software Product 可引用不可變 `PackageVersionId`，但 source repo、commit、license 與 lineage 仍以開源資產為真相。

`commerce.commercial_editions` 把開源版本包成可購買交付，保存 `package_version_id`、license snapshot／obligations、edition version、release artifact、support boundary、delivery mode 與 QC signature。`mode=packaged/hosted/custom/implementation/managed/support`；「商業版」不等於 proprietary，也不把 contributor 自動變 owner 或分潤對象。

`commerce.product_role_assignments` 是 CommercialEdition 的具名人力 child entity：`id`、`commercial_edition_id`、`role=vibe|field|project`、`human_user_id`、`profession_membership_ref`、scope、`state=proposed|active|ended`、accepted/ended time、acceptance signature/ref。被指派者必須本人接受；進入`team_ready`、首次進入`ready`及由`paused`恢復時，都重新要求三個 role 各至少一個 active assignment，且按 `human_user_id` 去重後至少三人。任一required assignment離任使`team_ready → product_ready`或`ready → paused`，只重算未來 readiness／capacity，不改舊 Order；assignment 不推導 ownership、royalty 或 ServiceEngagement 分配。

`commerce.supplier_offer_versions` 是 Supplier 對某 Product 的不可變單方提案，保存 supplier net／wholesale basis、availability、交付／退貨、`msrp`、`recommended_floor`、有效期與 digest；它本身不授予 Seller 供貨權。`DistributionAgreement` 是 Supplier 與 Seller 對 exact SupplierOfferVersion（及任何 negotiated overrides）的雙方簽署版本，才可被 Offer／Listing 引用。

`commerce.distribution_agreements` 是 Supplier 與 Seller 的版本化交易關係：

| 欄位 | 說明 |
| --- | --- |
| `selling_arrangement` | `reseller`（Seller 向買家負責並收款）或 `sales_agent`（由明示 principal 向買家負責） |
| responsibility parties | `seller_of_record`、`payment_collector`、`invoice_issuer`、`refund_owner`、`price_owner`、`fulfillment_party` 必須逐一指定 |
| `supplier_terms` | supplier net／wholesale basis、currency、availability、交付 SLA、取消／退貨、payout timing |
| `price_guidance` | `msrp`、`recommended_floor`、理由與有效期；兩者均為建議資訊，不是平台自動拒售門檻 |
| `promotion_policy` | promoter rate/base/window；只有可量化商品分潤才進固定 snapshot |
| `effective_revision` | exact version/hash、雙方人類簽名、起迄時間；不追溯改舊單 |

Launch default 是 `reseller`：一個 `SellerParty`／buyer-facing biller 收款、開立其責任範圍的對外憑證並處理買家退款；Supplier 依已接受的 SupplyOrder 收款與履約。若採 `sales_agent`，上述六個責任欄位仍須明示，不能只在 UI 換名稱。

同一person／organization Party可以同時註冊為Supplier與Seller並販售自己的商品；仍須建立versioned arrangement、SellerListingRevision與DistributionAcceptance，且buyer-facing責任、帳務來源及Seller-owned collection不能省略。角色重合不豁免產品的獨立QC。

Promoter若只分享attribution link，不向Buyer收款；只有signed referral rule成立時取得CommissionObligation。若推廣者要自己統一收Buyer的錢，就必須另以SellerParty身分開Seller Store、使用自己的collection並承擔seller_of_record／invoice／refund等已簽責任；其保留價差屬reseller margin，不因「也有Promoter身分」再自動產生佣金。

`commerce.offers` 定義某 Seller 怎麼賣：product/edition、distribution agreement version、title、commitments、fulfillment type、seller collection connection、可用 promotion policy 與 lifecycle。`commerce.offer_versions` 保存不可變對外條款；不能以 mutable listing 偷換承諾。

`commerce.seller_listings`／`seller_listing_revisions` 定義 Store 中的實際售價與展示：

- 每個 revision 帶exact `actual_price`、currency、OfferVersion、SellerParty、Store、buyer-facing effective item price schedule、valid period與digest。Shipping/tax另列，不可混入item price掩飾折扣。
- Supplier看得到實際價與相應supply terms；`DistributionAcceptance`對該exact listing revision/digest（含Seller coupon/discount後可能的effective unit prices）記`accepted/changes_requested/declined`，其中accepted須人類簽名。任何Seller-controlled折扣若改變有效單價，必須落在預先接受的price schedule，否則先發新revision並重新接受；checkout不能臨時藏折扣。
- Canonical aggregate只有`DistributionAcceptance`；「Supplier接受／供貨承諾」均指其accepted revision snapshot，不另建平行aggregate或狀態機。
- `msrp`／`recommended_floor` 可顯示差異並提示 Seller／Supplier，但平台不得實作「低於建議價自動斷貨」或隱藏式自動轉售價阻擋。
- Supplier 可拒絕新 revision，或撤回未來新訂單的 supply authorization；撤回effective後立即禁止建立新SupplyReservation。較早建立的active reservation在TTL內仍可完成付款，過期即關閉；Supplier不可只因已接受的實際價格，在買家已付款後拒絕該SupplyOrder。
- 只有 `QC scope satisfied + active distribution acceptance + Seller collection connection active + fulfillment path ready` 的 revision 才是 `sellable`。這是商品／交易完整性檢查，不是對人的 compliance 分數。
- linked DistributionAcceptance一旦revoked、expired或superseded，該revision立即離開`sellable`並停建新reservation；既有未到期reservation與已成立Order仍按immutable snapshot處理。

### 3.7 Storefront

`storefront.stores`

- owner、`seller_party_id` nullable、name、domain、theme ref、locale、status、`store_mode=reference/seller_store`。
- public store id 與 private deploy/admin token 分開。
- `Master Store` 是可 fork 的 catalog／theme／integration reference，預設 `store_mode=reference` 且不綁 SellerParty、不 checkout；每個真正販售的 fork 必須另綁唯一 SellerParty 與該 Seller 自有 `seller_collection` connection。

`storefront.store_bindings`

- store、listing、environment、origin allowlist、SDK contract version。
- `last_deployed_commit`、`last_seen_at`、health。
- Fork repo 本身不等同 active binding；只有完成 signed handshake 才能提交 canonical order。

### 3.8 Attribution、BuyerOrder、SupplyOrder 與 Fulfillment

`commerce.attribution_links` 保存 Offer／SellerListing、promoter、campaign/content、slug 與 window；互動不等於成交。LINE、QR、電話等由 `AttributionClaim` 保存；只有 accepted claim 連到 canonical paid BuyerOrder，且該 Order line 引用明示、已簽的 referral rule，才可產生 `CommissionObligation`。

`commerce.carts` 是可捨棄意圖；line 固定候選 SellerListingRevision 與 quantity，但 checkout 仍由 server 重算。Cart 可混合瀏覽多個 Seller，結帳時必須先按 `seller_party_id` 分段：

- 每個 Seller segment 是獨立 checkout、buyer-facing biller、付款、退款與 BuyerOrder；不同 Seller 不可被包成一個假裝單一 biller 的付款。
- 同一 Seller segment 可包含多個 Supplier 的商品，買家仍只看到該 Seller 一筆對外訂單與一個收款方。
- 建單前逐 line 重新驗 exact listing revision、QC、active supplier acceptance、availability 與 seller collection connection；任一 line 不可承諾時先回 buyer-readable diff，不先收款再請 Supplier 決定。

`commerce.supply_reservations`關閉Supplier revoke與buyer payment之間的race：

- 建立checkout intent時，在同一transaction逐line鎖定`DistributionAcceptance` revision、effective item price、quantity/capacity與短`expires_at`；只有active acceptance可建reservation。
- Supplier revoke先令該acceptance不再接受新reservation；已建立的active reservation在TTL內仍有效。Reservation不是付款、庫存永久占用或SupplyOrder。
- Provider checkout session的可付款deadline不得晚於reservation expiry；payment command／provider pre-charge callback再次驗reservation。Provider-occurred payment time在TTL內即使webhook晚到仍有效。
- Expiry後先把reservation與checkout intent標expired/cancelled，再拒絕／關閉付款session；若provider無法強制expiry，不得用該adapter做此即時checkout。極端provider violation造成late charge時進payment exception並void/refund，不授權fulfillment。
- Scheduler已把reservation標expired後，晚到的verified webhook若其provider `occurred_at <= expires_at`，仍以同一原子consume command收斂到consumed；只有provider occurred time超過TTL才走late-payment exception。

`commerce.buyer_orders` 是 Seller 對買家的 parent order：

| 欄位 | 說明 |
| --- | --- |
| `id`, `public_number`, `seller_party_id` | 一單唯一 Seller／buyer-facing biller |
| `buyer_party_id/guest_snapshot`, `store_id` | 買家與來源 |
| `lines[]` | exact SellerListingRevision、OfferVersion、Product/variant、quantity |
| totals | currency、line effective unit price、subtotal、Seller discount、shipping、tax、total分項；不得用shipping/tax繞過accepted item price |
| `responsibility_snapshot` | seller_of_record/payment_collector/invoice_issuer/refund_owner/support |
| `distribution_snapshot` | 每 line 的 Supplier、已接受價、supplier net、promotion、fulfillment 與 agreement hashes |
| states | payment、buyer-order、aggregate version 分開 |

`commerce.supply_orders` 是 BuyerOrder 依 Supplier／fulfillment party 拆出的子單：

- Order acceptance在同transaction建立全部SupplyOrders，初始`awaiting_buyer_payment`；保存`buyer_order_id`、Supplier、lines、supplier amount、settlement due policy、fulfillment commitments、accepted listing/agreement refs與SupplyReservation refs。
- Buyer 不需分頭 checkout；Seller 對每個 Supplier 的應付與 fulfillment authorization 可獨立進行。
- SupplyOrder在BuyerOrder acceptance時即固定；verified paid consume reservations並建立SettlementInstructions，不再新建SupplyOrder。之後只依snapshot執行，Supplier不得以事後看到同一已接受售價為由拒絕。缺貨／不可抗力走明示exception、substitution/refund，不改寫已接受價格歷史。

`commerce.payment_evidence`

- 用於現金、轉帳、LINE／線下等沒有可驗證 webhook 的路徑；保存 Order、提交者、來源、amount/currency、evidence refs、occurred_at。
- state：`reported → counterparty_confirmed/rejected → resolved`；單方截圖／聲明停在 `reported`，不得令 Payment projection 變 `paid` 或產生任何 financial obligation。
- 相對方明確確認、provider reconciliation 或有權 operator 依 evidence resolve 後，才可建立相應 PaymentFact；保留確認方法與 actors。

`commerce.payment_facts`

- provider connection／manual resolution ref、external transaction ID、type authorized/paid/partially_refunded/refunded/chargeback。
- `verification_level=provider_verified/counterparty_confirmed/operator_resolved`；UI 不得把三者都假稱 provider verified。
- verified webhook/raw hash 或 resolved evidence、amount、currency、occurred_at。
- 只保存必要 provider payload；敏感憑證另存 encrypted connection。

`commerce.fulfillments`

- buyer order/supply order/line、assigned party、type、promised_by、delivered_at、accepted_at。
- physical shipment、download、deployment、session 等使用 subtype details。

`commerce.refund_requests`、`commerce.returns`

- RefundRequest 保存 order/line、requester、reason、requested amount、evidence、state 與 seller decision；它只是請求，不直接形成退款事實。
- state：`requested → accepted → executing → refunded`，也可從`requested`進`rejected/withdrawn`；只有已開始 provider 操作的`executing → failed → executing`，而`accepted/executing/failed`均可依可驗證的人工處理結果進`refunded`或`manually_resolved_not_refunded`。只有 provider verified／雙方確認／operator resolved 的退款才新增 PaymentFact；RefundRequest進`refunded`只表示該請求已有可驗證退款事實，不等於整張 Order 已全額退款。
- physical return 另存 authorization、carrier/tracking、shipped/received/inspected time 與 resolution；digital/service 無需假造物流狀態。
- 每筆 verified partial/full refund 都追加 PaymentFact、發`freedom.commerce.payment.refund.confirmed.v1`並按本次金額追加 Ledger obligation reversal；只有 Order 累計已驗證退款達可退的 confirmed paid amount 時，才發`freedom.commerce.order.refunded.v1`。Chargeback 另發`freedom.commerce.payment.chargeback.recorded.v1`並追加對應 reversal；不得刪 Order、原付款或原 obligation。

### 3.9 Financial Obligation、Settlement Automation 與 LedgerEvent

Ledger 明確區分三種應付款，不能把 Seller 毛利、Supplier 貨款、推廣佣金與專案分配都叫 commission：

| Aggregate | 唯一合法來源 | 說明 |
| --- | --- | --- |
| `SupplierPayable` | reseller Order line 的 verified paid fact＋該 line 所引用、已簽的 `DistributionAcceptance` revision | Supplier 應收的 supplier net／wholesale amount；Seller 保留的差額是 reseller 經濟利益，不是 commission 或另一筆平台應付 |
| `CommissionObligation` | `sales_agent` contract 或明示 referral 的已簽 rule＋qualified paid Order line／accepted attribution | 只支付 rule 中具名 beneficiary；沒有 signed rule 就沒有 commission |
| `ServicePayable` | accepted milestone＋該 milestone pinned 的 active signed `EngagementAllocationPlan`／明示 payment trigger | 只屬該 Squad 自談的 professional service；不使用零售商品分潤公式 |

三種 obligation 都保存 `source_type`、`source_version`、`beneficiary`、`amount`、`currency`，另帶due policy、status與idempotency key。SupplierPayable另綁BuyerOrder／SupplyOrder／order line／DistributionAcceptance；CommissionObligation另綁BuyerOrder／order line／signed rule；ServicePayable另綁ServiceEngagement／accepted milestone／signed AllocationPlan，不用nullable order line假裝相同。價格、付款、cap與obligation使用non-negative或positive minor-unit Money，只有delta使用signed型別；來源版本immutable，舊obligation不因新規則重算。

資金執行另有兩個明示 mode。平台層預設 `money_movement_enabled=false`；`record_only` 是每個 Seller 的預設且永遠可用，只建立／對帳明細與人工處理事實。依 OD-28，`authorized_mandate` 僅在 `money_movement_enabled=true`、Payer 當事人已對 exact `SettlementMandate` digest 簽署成員 A4，且 Ted 已對同一 digest 完成付款類一鍵 A4 時可用；缺任一條件即維持 `record_only`，商店、listing 與對帳照常。該 mandate 仍須 active、未超界並屬於該 Seller；人工明細只能顯示「已記錄」，不得顯示或暗示「平台已付」或「平台已結算」。

- `SupplierPayable`不是推廣佣金：在 reseller 模式，Buyer 付 Seller，Seller 依 Supplier 已簽 supplier-net snapshot 負有貨款義務；`buyer-facing paid - supplier payable - explicit other obligations/tax/cost`才是 Seller 可保留的 margin projection。
- `CommissionObligation`只允許一層明示 sales-agent/referral beneficiary；若未來增加扁平角色報酬，每個 entry 仍須有同一 Order line 的具名責任與 signed rule，不得形成上下線祖譜。
- 開源 PR、community software/Skill QC、review 次數、rank 或 package maintainer 身分本身都不建立 SupplierPayable、CommissionObligation 或 ServicePayable；它們只形成貢獻 evidence 與未來受邀優先。
- Refund／chargeback 不修改原 obligation；追加 `FinancialObligationReversal`，引用原 accrual、同 currency 與本次反轉金額。Partial reversal 可重複追加但累計不得超過原額。

Commerce connection分三種purpose：`seller_collection`收Buyer款、`payer_disbursement`從付款方帳戶發起或匯出付款、`beneficiary_payout_destination`標示受益人收款處。同一provider account可有多種binding，但任一reference都不授予另一種authority。

`commerce.settlement_mandates` 是 Payer 一次設定的 bounded standing authorization，不是平台銀行帳戶；reseller通常由Seller擔任Payer，ServiceEngagement可指定別的付款方：

- 綁payer-owned disbursement connection；每個bound固定唯一`bound_id`、一個beneficiary及其purpose-tagged destination、currency、allowed obligation actions、source scope、per-transfer cap、calendar day/week/month cap、IANA timezone、validity、revocation與human signer。Week一律Monday開始。
- 同一Mandate內，對相同beneficiary/destination/currency/action且scope相交的bounds不得重疊；一筆Instruction必須只命中一個bound。
- Provider-managed/non-exported credential留在provider vault，Platform只存purpose-tagged opaque ref；若參與者明確建立的Platform-proxied connection確實需要dynamic OAuth/API token，只有Credential Broker可解析指向隔離`credential_vault` envelope ciphertext的secret ref。一般domain table仍不存plaintext credential或可顯示銀行帳號，固定root key另放purpose-scoped secret/KMS。
- Mandate可讓系統在已簽範圍內真正呼叫API／銀行connector，不需每單只發訊息問「要不要轉」。超出範圍或改beneficiary要求新的A4 authorization／Mandate revision；只有provider明示不具initiation能力才進`manual_required`。

`SettlementMandateUsageReservation`在同一transaction選定唯一bound並占用額度。cap檢查使用該bound時區的exact period bucket，計算`reserved + consumed + current amount`；同一Instruction/bound只能有一筆reservation。`executing/provider_accepted/result_unknown/reconciling`持續保留capacity，confirmed才consume；尚未送provider或reconciliation證明無外部effect時才能release。

`SettlementInstruction` 是由已成立的SupplierPayable、CommissionObligation或ServicePayable產生的不可變付款指令；`TransferJob` 是實際對外副作用：

```text
buyer payment verified
→ create per-recipient SettlementInstruction
→ resolve exactly one active SettlementMandate bound and atomically reserve cap
→ create system ActionIntent bound to mandate + usage reservation
→ TransferJob invokes payer-owned disbursement connector
→ webhook/query reconciliation confirms transfer
→ consume cap and settle referenced obligation
→ only SupplierPayable confirmation authorizes matching SupplyOrder fulfillment
```

- 每個Instruction共同保存obligation type/id、source type/version、payer/disbursement connection、beneficiary/destination、amount/currency、due、source/basis hashes與reversal policy；Supplier、Commission、Service各自帶前述typed context。同一obligation只有一個active transfer effect key。
- `TransferJob` 使用 ActionIntent、stable provider operation key、lease/fencing、retry-before-create reconciliation；success 由 provider verified fact或 recipient confirmation成立。
- Provider無payout initiation API時才降級為payer approve＋匯出付款檔／人工evidence；UI必須標示`manual_required`，不能把提醒宣稱成自動付款。
- 只有SupplierPayable settlement confirmed才把對應fulfillment轉`authorized`（若agreement明訂credit terms，可用受限`T+N` policy）；Commission／ServicePayable transfer不觸發商品履約。買家已付款但Supplier payout延遲要有Seller handling/refund路徑，不能把責任推回買家。
- Refund／chargeback 形成 recipient reverse obligation；可依 agreement 由收款方退回或抵扣未來 settlement，絕不建立平台 wallet 或直接覆寫已確認 TransferFact。

`commerce.ledger_events`

| 欄位 | 說明 |
| --- | --- |
| `id`, `ledger_account_id` | recipient/seller/offer accounts |
| `event_type` | accrual/settlement/refund/reversal/adjustment/cost |
| `amount` | signed minor units＋currency |
| `basis_type/id` | order/payment/settlement/quota |
| `reverses_event_id` | reversal 指向原 event |
| `rule_snapshot_hash` | 算法來源 |
| `occurred_at`, `recorded_at` | 業務時間與入帳時間 |
| `idempotency_key` | exactly-once effect |

不變量：balance 是 events 的 projection；禁止直接 update balance 來「修帳」。

財務 ledger 只表示 obligation／transfer／reversal；`ContributionRecord` 表示人做過的工作。兩者可引用同一 WorkItem/Order，但不能因 contribution 自動猜金額，也不能因付款自動猜誰完成專業工作。

### 3.10 Opportunity、Project、WorkItem、Claim 與 ResultEvent

`work.submission_drafts` 是跨 Portal、LINE、Discord 與 local Agent／文件 adapter 的唯一「待確認進件」aggregate，不是已認領工作的 `work_submission`，也不是可直接套用業務資料的 `DraftArtifact`：

| 欄位 | 說明 |
| --- | --- |
| `id`, `community_id`, `owner_principal_ref` | owner 由登入 session，或由已驗 webhook connection＋active ExternalIdentity server-side 推導；client／bot 不可任填 |
| `source.type/ref/revision/content_sha256` | `portal/line/discord/document` 與 immutable／opaque provenance；同一 source revision 在 community 內只建立一次 |
| `proposed_target` | typed `work_item` 或 `opportunity_stub` payload；target kind 確認後不可改成另一種 |
| `redacted_summary`, `data_classification`, `source_custody` | 最少可辨識摘要、分類與 `external_provider/owner_controlled_storage/platform_consented_content` custody |
| `state`, `version`, `expires_at` | `draft/confirmed/rejected/expired` 與 optimistic concurrency |
| `target_ref`, `confirmed_payload_sha256`, `rejection_reason_code` | 只在 terminal transition 寫入相應結果；confirmed 恰有一個 canonical target |

- 建立只產生 owner-private draft；不 open／publish／claim、不能授予 ExecutionGrant，也不是 A4 HumanSignature、QC、合約、付款、供貨接受或 release。
- Confirm／reject 只能由該 owner，或 server 驗證具該 organization 明示權限的 operator，在 Portal session＋CSRF 下以 `If-Match` 與 idempotency key 執行。LINE／Discord interaction、文件 adapter 與 Agent token只能 create，不能直接 confirm／reject。
- Confirm transaction 先重驗 owner、aggregate version、target kind，並要求owner送回的`acknowledged_source_ref/revision/content_sha256`逐欄等於draft已保存的immutable tuple；文件`access_policy_ref`若已在Platform明示撤銷則conflict。這是owner acknowledgement，不dereference外部文件，也不證明當下source可達或bytes仍相同；端點offline本身不阻擋confirm。之後才恰好呼叫一次`opportunity-project-work` owning command，建立一個仍為 `draft` 的 WorkItem，或一個仍為 `private` 的 OpportunityStub，並與 `target_ref` 原子落帳；競態下只有一個 terminal transition成功。
- Source dedupe key由server以`community_id + source_type + trusted connection/delivery或document ref + source_revision`正規化後計算。同key＋同hash回原draft；同key＋不同hash拒絕為conflict。HTTP Idempotency-Key亦遵守同request回原結果、不同request conflict。
- 平台不中央保存 LINE／Discord 原文或 external-client-owned 文件內容；只存opaque source ref、digest、revision、media metadata與必要redacted summary。文件所建WorkItem把exact ref/revision/digest/access-policy tuple列為input requirement；OpportunityStub則可維持metadata-only，confirm不授予Agent讀取權，日後Project／WorkItem若需要文件須明示複製該exact requirement。真正執行時，bound local Agent才以owner端credential抓exact revision、在本機重算SHA-256並回報immutable verification receipt。Receipt只是authenticated／lease-fenced Agent assertion與provenance，不是Platform對不受信remote host bytes的獨立attestation，也不替代review／signature／A4。`source_unavailable/access_denied/revision_unavailable/digest_mismatch`會留下failure receipt並令AgentRun失敗，但不得建立DraftArtifact／PR／Result／Contribution、執行ActionIntent或產生外部副作用。只有平台自有或本人明示同意的內容才可進具owner／retention class的object storage。

`opportunity.opportunities` 是 lead／fund／investor／sponsor／product／sales／development／professional-service 等機會入口，而不只是公開小任務。長期 Opportunity/Partnership Guild 負責來源與關係；每個實際案件由橫向 Squad 承接。

- `visibility=public/community/private`；source 可以是 Package、Offer、Guild、Campaign、客戶、sponsor 或外部系統。
- 外部來源不必搬進平台；若要使用 agent/task/ledger，至少建立 private `OpportunityStub`，只存 owner、kind、next action、external ref、privacy scope 與最小摘要，敏感原文留在原系統。
- 保存 work type、預期結果、slots、deadline、可見 gain/reward、必要 evidence／capability、newcomer/mentor slot 與 Discord binding；不使用黑箱「最佳人才」封閉派單。

`delivery.projects` 是機會被接受後的交付 aggregate；`delivery.squads` 指定跨 Guild 成員、acting roles、customer/sponsor refs 與 close criteria。`delivery.work_items` 是可由人／Agent 執行的 canonical 工作：

| 欄位 | 說明 |
| --- | --- |
| context | opportunity/project/squad/module/repo/non-code resource refs |
| `required_professions/skills` | 可解釋 filter；不是全人資格判斷 |
| `execution_mode` | `exclusive/collaborative/competitive`；決定 claim／多提交語意 |
| `expected_output` | exact artifact type、驗收 evidence、估計時間與做完得到什麼 |
| authority | required A-level、review policy、signature/release authority |
| lifecycle | draft/open/active/claiming_closed/accepted/cancelled/expired；單一claim的執行進度不塞進WorkItem |
| `participation_terms` | versioned三種參與模式、受益者／幫助者實益、投入上限、容量保留、結束與reuse；唯一結構見 `contracts/work-participation.schema.json` |
| `participation_terms_revision/sha256` | 每個Claim pin當時條款；新revision不改旧Claim的承諾 |
| `shared_goal_ref` | 指既有Squad／Project的共同成果；非額外組織或必填官職 |

`opportunity.claims`保存誰承接一個Opportunity slot；`delivery.work_claims`則是每個WorkItem由person/team/Squad擁有的獨立aggregate，保存`claimed/in_progress/submitted/in_review/changes_requested/accepted/released/cancelled/expired`。`agent.task_leases`只屬於一次AgentRun，保存短效執行租約。AgentRun crash/lease expired不應把人的WorkClaim釋放；只有Claim自身到期／owner release才釋放名額。Collaborative／competitive WorkItem可有多個Claims，各自提交與review，不能互相覆寫。

`delivery.service_engagements` 表達 AI implementation／professional service：

- `ProposalVersion`／`SOWVersion`：客戶問題、scope/out-of-scope、責任、商業條款、接受者與 exact digest。
- `Milestone`／`WorkPackage`：deliverables、WorkItems、acceptance evidence、due、support owner。
- `DeliveryEvidence`／`Acceptance`：客戶或明示 accepter 對 exact version 簽名。
- `ChangeRequest`：在途變更發新 scope/cost/timeline revision，不覆寫原 SOW。
- `SupportPeriod`：開始／結束、service level、handoff／maintenance path。
- `EngagementAllocationPlan`：Squad 對此 paid engagement 自行協商金額／比例／里程碑／支出與簽名；平台只驗總額與簽署一致性，不套全站固定佣金、不因 repo contribution 推導份額。只有accepted milestone pinned的active signed plan與其中明示payment trigger能建立 `ServicePayable`；一般 contribution、PR、community QC 永遠不能代替該來源。

`ContributionRecord` 由 accepted Submission/Result 建立，保存 user、acting profession、WorkItem、artifact/evidence、responsibility context、reviewer 與 time。它用於熟悉度、portfolio、rank evidence 與未來邀請，不等於版權、ownership、工資或 Ledger credit。

`projection.member_profession_xp` 是 `MemberProfessionXpProjection`：每列 key 固定為 `member_ref + profession_key + track`，保存 `xp`、`policy_version`、`rebuilt_from_event_seq` 與 rebuild time。唯一來源是 append-only `ContributionRecord` 加上其 review outcome；只有 accepted 且未 retracted 的來源有效。整表可刪除後按指定 `XpPolicyVersion` 重建，完成後只發一個摘要事件 `freedom.people.xp_projection.rebuilt.v1`；不為單筆增量另發 XP 事件。

`WorkItem(review_required=true)` 在 publish/open command 查指定 review scope 是否至少有一筆有效 `ReviewerAppointment`，但無論容量如何都把 candidate 維持為 canonical `open`／published 且可領取。沒有容量時，正交的 review-capacity 導航狀態使用穩定 ID `waiting_reviewer_capacity`，並以 `enforcement=navigation` 按scope＋capacity episode聚合一張可略過的Guild Officeholders Council support card；不自動承諾補位、不因輪詢反覆開卡；它只影響 `official` 與 review route，不改任何人的 membership、rank、entitlement、discoverability 或 claim 能力。有了有效 reviewer 後只更新 review-capacity 導航狀態與卡片，不改寫 WorkItem lifecycle。

`opportunity.result_events`

| 欄位 | 說明 |
| --- | --- |
| `id`, `type`, `subject_user_id` | 誰的哪種結果 |
| `opportunity_id`, `claim_id` | 可 null，但來源清楚 |
| `package_version_id`, `offer_id`, `order_id` | 相關 context |
| `result_payload` | type-specific validated payload |
| `evidence_refs[]` | system/user/GitHub/customer evidence |
| `confirmation_method` | self/system/peer/maintainer/buyer |
| `evidence_level` | reported/observed/confirmed；是來源／確認程度，不是機率 |
| `responsibility_context` | learning/test/free-help/paid-delivery |
| `state` | recorded/confirmed/disputed/reversed |
| `rule_ref`, timestamps | 當時規則 |

ResultEvent 可以觸發特定 entitlement/reward，但不能把所有類型加總成 `community_score`。

#### 3.10.1 實益、容量與工時（低負擔擴充）

`BenefitObservation` 是既有 Result 領域下的最小、append-only、自願回報，不是金流／品質驗收或新工作生命週期。以 `work_item_ref + work_claim_ref? + reporter_principal_ref + role` 為lineage，server從 authenticated session與工作關係判定本人／有權組織代表；reporter不能由request任意指定。修正產生新revision，projection使用最新有效版但保留歷史。

回報區分 `gained/partly_gained/not_gained/unconfirmed`、具體實益、可選evidence、是否願再參與；工時選填且unknown不是0。Agent可草擬，但不得代確認真人感受。`freedom.result.benefit_observed.v1`只更新Result read models，不能創建ContributionRecord／payable、改official、membership或review acceptance。對未回覆者只做有界提醒，不能自動假造正例。

真人容量使用Work／Coaching owner的versioned availability及原子reservation；ReviewerAppointment僅為資格。跨模組對同一principal同一時窗不可超額，已接受責任不能因Agent lease／invitation過期而消失。Operations projection彙整，不另寫第二份容量帳。

工時最小摘要分 `platform_maintenance/coordination_friction/collaborative_value/paid_delivery`，核心／非核心分列；不擷取私人對話或鍵盤。普通志願未認領請求方可按預定條件expire；已簽履約、付款、安全及正式權益爭議保持既有責任。詳見 `12`。

### 3.11 Coaching

`coaching.programs`

- stable identity、owner、status；可發布多個 immutable `coaching.program_versions`。
- ProgramVersion 固定 linked career track、target result、suggested packages、duration、mode 與 checkpoint templates。
- `mode=peer/free_community/group/one_to_one` 與 `service_capacity=volunteer/paid_human_time` 分開。Guild 的知識、技能文件、route 與共同教學保持公開免費；只有為特定人的排程時間、持續 accountability、客製化／導入／代管、專用算力或 SLA 可成為付費 Offer。

`coaching.suggestions`

- Coaching 是唯一寫入 owner；Positioning/Journey 只能帶 recommendation-policy ref 呼叫 `OfferCoachingSuggestion` command。會員可 accepted/dismissed，過期只移除 Next，不會建立 enrollment 或扣款。

`coaching.mentor_profiles`

- user、tracks/packages、available modes、capacity、LINE deep link policy。
- mentor entitlement 與一般 profile 分開。

`coaching.enrollments`、`matches`、`sessions`、`checkpoints`

- Enrollment 只能由會員明確 request 建立；該 command 可引用已接受的 suggestion，但 suggestion 狀態本身不佔名額。Request 帶本人所見 `program_version_id`／ETag，server 驗證後 pin 該版本；checkpoint instances snapshot 當時 template。
- Match 可以本人選擇、mentor 接受或簡單 filter；不使用定位 raw score 自動決定唯一對象。
- Session 保存 schedule/status、Discord/LINE deep link 和最小 notes ref；預設不保存 LINE 全文。
- Checkpoint 保存 expected result、due、evidence與 result event ref。

### 3.12 Marketing 與 Media

`marketing.campaigns`

- objective、audience、source Product/Offer/SkillPackage、owner、attribution policy、budget/quota、rules/content template versions。

`marketing.content_items`

- channel-neutral source copy、variants、assets、prompt/model refs、owner edits。
- `contributors[]` 保存人類的 contribution type、user/ref、source/evidence；`derived_from[]` 保存 Product/Offer/Skill/Result/Content/Media lineage。
- `reuse_consent` 分 purpose/scope/version；公開作品或外部 provider 可見不等於同意平台把內容再製成廣告、教材或商品。
- AI 產出可以 owner 設定為自動排程，不需平台 compliance approval。

`marketing.publication_jobs`

- channel connection、content variant、scheduled_at、provider external id、state、attempts、last error。

`media.assets`

- owner、object key、mime、size、duration、hash、source rights declaration、created_by_job、contributors、derived-from refs 與 reuse-consent snapshot。

`media.edit_projects`、`edit_jobs`、`renders`

- Project 保存素材、目標 channels、模板和剪輯指示。
- Job 保存 transcript/highlight/storyboard/caption/render stage、provider refs、quota reservation。
- Render 保存 immutable output metadata；不覆寫原始素材。
- 模型生成本身不自動建立人的 ResultEvent；只有可指向人與證據的實質編輯、審核、發布、採用或成效確認，才向 Result core 提交 result candidate，由 Result core 建立各人的獨立 ResultEvent。

### 3.13 Quota 與 BillingSource

`integration.billing_sources`

- type：package_sponsor、offer_budget、user_credit、bring_your_own_key、platform_campaign、buyer_trial。
- owner、provider、spend cap、scope、valid period、secret connection ref。

`integration.quota_accounts`、`quota_events`

- reserve/consume/release/refill/expire 使用 append-only event。
- paid provider command 執行前先 reserve，完成按實際成本 consume，失敗 release。
- exhausted 只拒絕該付費 operation；不改 User/Career/Entitlement。

### 3.14 Agent Control、授權、簽名與 Provenance

`agent.agent_connections` 將一個明示的 Claude／Codex／Grok CLI、server agent 或自帶 Agent client instance 綁到一個 `principal_type=user|organization`；principal仍是被代表的人／組織，Agent只是可撤銷的執行來源。註冊Connection本身不授予工作能力；credential只能查active ExecutionGrant允許的scope，不能自行宣告Profession、Master、reviewer、payee或獨立人員。

`WorkContextBundle` 是短效、purpose-bound read model，不是把整個會員資料丟給模型：

```text
principal + acting ProfessionMembership/rank record
equipped SkillPackageVersions
work_direction_basis:
  person → type=member_work_intent + work_intent（confirmed WorkIntent必要欄位）
  organization → type=organization_work_policy + organization_work_policy_ref + operator_user_ref + acting_profession_membership_refs + authorized_work_types + revision
available WorkItems + reason/gain/effort
active Claim/Squad/Project refs
ExecutionGrant summaries + required signatures/reviews
resource refs and external connector capabilities
```

`organization.work_intents`由Organizations & Professions core擁有，保存本人此刻想投入的profession、工作類型、availability、risk/cost limits與暫停項目；Positioning只提交draft command，本人確認後才啟用。Person principal的`work_direction_basis.type=member_work_intent`；organization principal則必須使用版本化`organization_work_policy_ref`、具名`operator_user_ref`、該operator的`acting_profession_membership_refs`與`authorized_work_types`，絕不能借用某人的隱藏CareerProfile、定位逐字稿或私人WorkIntent。`DailyWorkFeed`是projection，每項必須回答「為何給我、以哪個身分做、預計多久、做完得到什麼、需要誰review/簽名」。典型queue：可推商品/今日貼文、客服、supplier onboarding、PR/QC、listing review、開發、FAE/implementation與opportunities。

`agent.execution_grants` 使用五級權限，grant 帶 principal、agent/client、acting role、scope/resource、allowed actions、limits、expiry、revocation、rule ref 與人類 signer：

| Level | 可做的事 |
| --- | --- |
| `A0 read_explain` | 查可見狀態、解釋、排序 feed；無外部副作用 |
| `A1 draft_test` | 草稿、diff、sandbox/test、local analysis；不可公開／正式提交 |
| `A2 bounded_reversible` | 在 standing grant 內 claim 低風險工作、branch/commit、draft PR、Listing draft；必須可撤回 |
| `A3 bounded_public` | 依 channel/template/time/count policy 發文、FAQ support 或其他已簽的公共動作 |
| `A4 fresh_signature` | 價格／分配、DistributionAcceptance、建立／修改SettlementMandate、超scope payout/refund、official QC、合約、代表本人對外且有精確承諾後果的named application、任何 official／production immutable release；每個決策綁exact artifact/digest。自助加入Guild、學習、裝備、一般submission、低風險WorkItem與Master welcome明文排除。Mandate本身 fresh-sign 一次後，範圍內 deterministic per-order transfer引用該簽名自動執行，不逐筆重簽。純內部／non-production snapshot 可用 A1／A2，但不得用 `v*` tag、public GitHub Release、production／Pages 發佈或 official 標識 |

`agent.human_signatures` 由 Agent Control 作唯一 writer。`HumanSignature` 不等於一般「同意使用 AI」：必須保存 signer、authority、meaning、artifact revision/digest、呈現內容、method 與 time。QC、Commerce、Service 等 owning contexts 只保存 signature ref 並驗其 purpose／digest，不另建同名簽名表。LINE／Discord 按鈕預設只 deep-link 到 Portal 簽名；若未來要在外部渠道簽，必須達到同等身份、內容綁定與 anti-replay。

已簽SettlementMandate不是泛用grant：它本身是A4 exact artifact，明定payer/disbursement connection、beneficiary/destination、currency、單筆與calendar-period cap/timezone、operation、source scope與期限。符合唯一immutable bound且已原子保留capacity的SettlementInstruction僅在 `authorized_mandate` 且 `money_movement_enabled=true` 時可自動執行；任何條件外付款或refund仍要求新A4簽名。

`agent.agent_runs`、`task_leases`、`action_intents`、`work_events`：

- Agent auth分兩層：device/browser flow經human approval建立`AgentConnection`並發短效connection token；Connection refresh以sender-constrained client-instance proof原子rotation，舊refresh material立即失效。只有已綁同一Connection的active ExecutionGrant可換grant／profession／audience-scoped execution token。A4 signing authority在兩種token都結構性排除；worker的Credential Broker job capability另屬一次lease exchange，永不發refresh token。
- AgentRun由server持久化`agent_connection_ref`、明確可得或`null`的client/model/tool contract versions、exact `WorkContextBundle` canonical hash、acting ProfessionMembership、immutable grant snapshot、server-derived domain SkillVersion exact set、`domain_skill_runtime_mode`、nullable signed overlay provenance、input/output artifact、HumanSignature、Result refs與outcome；尚無值的scalar明確存`null`，集合明確存空陣列，不能靠省略欄位形成多種provenance語意。工作用`equipped_skill_version_refs`不接受client輸入：server由immutable WorkItem的`skill_version_refs`推導exact set；WorkItem未要求domain Skill時exact set可為空，否則要求每一項仍存在於current WorkContext equip且與grant/task相容，再回傳並保存，缺件或多件都拒絕。`domain_skill_runtime_mode`只有`eligibility_and_provenance_only_v1`與`signed_isolated_overlay_v1`；前者要求overlay為`null`且不載入domain package，後者要求server選定的`BLD-05` artifact、statement、`runtime_roots_set_digest`及每個root/QC digest完整保存並於每個新session重驗。任一overlay驗證失敗，runtime task回`capability_unavailable`且零domain execution／consequential effect。另必填control-Skill signed activation的`channel_id`、單調`sequence`、`activation_digest`、`skill_package_digest`、publisher-resolved transitive `skill_dependency_closure_digest`、`plan_bundle_digest`及formal `contract_bundle_digest`；此singular control root＋closure與domain overlay分欄，既有八輸入activation公式不變。Client送來的activation tuple只是expected value，且client不得提交runtime mode／overlay；server建立run前必須以自己的trusted channel root、current bootstrap index及revocation snapshot載入並驗證current exact heads後逐欄相等。Server與installer都不對mutable package registry重新選dependency版本，舊於minimum、撤銷或不相容就拒絕；不保存模型chain-of-thought。
- TaskLease 是短效 executor lease，有 fencing token；Claim 仍屬人／Squad。
- 每個外部副作用先建 immutable `ActionIntent(action_type, target_ref, artifact_sha256, consequence_summary_sha256, request_sha256, idempotency_key, authorization_basis_snapshot_ref, expected_target_version)`；AgentRun origin 另帶`execution_grant_snapshot_ref`。`:execute`只接受allowlisted typed command，server再驗execution token、grant、current TaskLease/fencing與A4 basis。重試查同一intent/provider key，不創第二個副作用。
- `WorkEvent` 是append-only provenance fact，記 accountable human／organization principal 作為`actor`；若由 Agent 執行，另記 optional `AgentRun` provenance，並保存工具、inputs/outputs、grant/signature/reviewer refs；敏感內容只存hash/ref。
- `work.draft_artifacts` 是非code platform-native PR的唯一canonical model；每個`draft_artifact_id`只代表一個immutable revision aggregate，`lineage_id`才串起successors。每版保存WorkItem/WorkClaim、acting ProfessionMembership、human/org principal、optional AgentRun、typed schema ref、target/base version、完整validated content、digest、deterministic diff與review refs。`ChangeProposal`只可作UI概念別名，不另建aggregate，也不可把`draft_artifact_id`誤作可變的整條文件ID。
- Code submission 的 merge/review/release 真相留 GitHub；平台只存 binding、task/claim、signature/provenance/result refs。Listing、QC、campaign、Opportunity、SOW 等非code物件走 `DraftArtifact revision → review → ActionIntent exact apply`；draft本身永不直接改domain。

## 4. Domain Event Envelope

### 4.1 Canonical JSON

```json
{
  "specversion": "1.0",
  "id": "evt_01J7ABCDEF1234567890XYZABC",
  "type": "freedom.result.confirmed.v1",
  "source": "urn:freedom:service:result",
  "subject": "result/res_01J7ABCDEF1234567890XYZABC",
  "time": "<RFC3339 timestamp>",
  "datacontenttype": "application/json",
  "dataschema": "https://contracts.freedom.example/events/freedom.result.confirmed.v1.schema.json",
  "correlationid": "cor_01J7ABCDEF1234567890XYZABC",
  "causationid": "evt_01J7PREVIOUS1234567890ABCD",
  "communityid": "com_01J7ABCDEF1234567890XYZABC",
  "traceid": "trc_01J7ABCDEF1234567890XYZABC",
  "contractversion": "1.0.0",
  "aggregateid": "res_01J7ABCDEF1234567890XYZABC",
  "aggregateversion": 1,
  "eventsequence": 1,
  "data": {
    "actor": {"type": "user", "id": "usr_01J7ABCDEF1234567890XYZABC", "acting_as": "maintainer"},
    "rule_refs": [
      {"id": "entitlement-default", "version": "3", "hash": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}
    ],
    "result_event_id": "res_01J7ABCDEF1234567890XYZABC",
    "result_type": "skill.run.completed",
    "package_version_id": "skv_01J7ABCDEF1234567890XYZABC",
    "confirmation_method": "system_test"
  }
}
```

### 4.2 Envelope 規則

- `id` 全域唯一；consumer 以它去重。
- `type` 最後包含 major schema version；破壞性變更發新 type/version。
- `contractversion` 只標示共同 contract bundle／envelope revision；該 event payload 的版本仍由 `type` major 與 `dataschema` 決定，兩者不可互相取代。
- `time` 是 domain fact 發生時間；adapter 能驗證 provider occurred time 時沿用，否則使用 durable received time，並在 event-specific data 記 time source/quality。資料庫另存 received/recorded time。
- CloudEvents extension attributes 使用小寫英數名稱和 primitive value；`communityid/traceid/contractversion/aggregateid/aggregateversion/eventsequence` 為共同 extensions。
- 每個已接受的 state mutation 都寫一筆內部 `StateTransitionRecord` 並遞增 `aggregateversion`；machine 的 `event` 欄只代表要公開給其他模組的 integration fact。因此兩個公開 event 之間的 `aggregateversion` 可以跳號。
- `eventsequence` 只對同 aggregate 的公開 event stream 連續遞增，與 `aggregateversion` 分離；兩者在 event JSON 都限定為 safe integer。HTTP concurrency 仍用 aggregate ETag／`If-Match`，SDK 不用浮點做版本運算。
- 結構化 `actor`、`rule_refs` 與 event-specific metadata 放在 `data`；actor 是觸發者，不一定等同 `subject`。
- `data` 不放 OAuth token、銀行資料、地址、私人聊天或大型 base64。
- consumer 不認識 type/version 時放 dead-letter，不猜欄位。
- event delivery 為 at-least-once；藉 idempotency key、inbox receipt 與 unique constraint 達成 effectively-once business effect，不宣稱 transport exactly-once。

### 4.3 Consumer 公開事件序號與 gap protocol

每個需要 aggregate ordering 的 consumer，以 `community_id + consumer_name + aggregate type/id` 保存 `last_contiguous_event_sequence`；inbox receipt、projection write、business effect 與 cursor 前移在同一 DB transaction：

1. `eventsequence <= last_contiguous_event_sequence`：同 event ID 是 transport duplicate；不同 event ID 卻占用已處理序號則 quarantine 為 producer invariant violation。兩者都不重做 business effect。
2. `eventsequence == last_contiguous_event_sequence + 1`：驗 payload schema後套用，前移 cursor，並依序 drain 已 buffer 的下一個 contiguous sequence。
3. `eventsequence > last_contiguous_event_sequence + 1`：durably 保存 event 到 gap buffer、記錄缺少的 public sequence range、觸發 producer replay/query；在缺口補齊前不套用該 event，也不前移 cursor。
4. gap 超過候選時限只告警／進 reconciliation workbench，不可跳號。Producer 必須保證同 aggregate/eventsequence 唯一；修復用原 event ID replay，不能另造一個看似相同的歷史。
5. 不需 aggregate ordering 的 append-only fact consumer 仍按 event ID 去重，但必須在自己的 projection key 上使用 commutative operation 或明確排序規則。

擁有 aggregate 的模組從內部 transition journal／snapshot 還原 canonical state；外部 projection 從公開 event 或 authoritative query／snapshot 還原，不能等待未公開的 aggregate version。契約測試固定包含 `eventsequence N+2 → duplicate N → N+1`、consumer crash between effect/cursor、全量 replay 與 gap repair；最終 projection 必須與 canonical query 一致。

## 5. 第一版 Domain Event Catalog

下列每個 type 在 machine-readable catalog 同時索引唯一 producer、aggregate 與 `dataschema` URI。此版 URI 是 planning identifier；1A 契約凍結時，每個 URI 必須可解析到 event-specific JSON Schema 與正／反例 fixtures，否則該 type 不得由 production producer 發送。

### 5.1 Identity／Membership

- `freedom.membership.user.created.v1`
- `freedom.membership.identity.linked.v1`
- `freedom.membership.identity.revoked.v1`
- `freedom.membership.user.paused.v1`
- `freedom.membership.user.reactivated.v1`
- `freedom.membership.notification_preferences.updated.v1`
- `freedom.membership.consent.granted.v1`
- `freedom.membership.consent.revoked.v1`
- `freedom.membership.member_connection.requested.v1`
- `freedom.membership.member_connection.accepted.v1`
- `freedom.membership.member_connection.ended.v1`
- `freedom.entitlement.granted.v1`
- `freedom.entitlement.activated.v1`
- `freedom.entitlement.paused.v1`
- `freedom.entitlement.revoked.v1`
- `freedom.entitlement.restored.v1`
- `freedom.entitlement.expired.v1`
- `freedom.organization.profession.confirmed.v1`
- `freedom.organization.profession_membership.updated.v1`
- `freedom.organization.rank.recorded.v1`
- `freedom.organization.work_intent.confirmed.v1`
- `freedom.organization.equipped_skills.replaced.v1`
- `freedom.organization.guild.created.v1`
- `freedom.organization.guild.updated.v1`
- `freedom.organization.guild.state_changed.v1`
- `freedom.organization.entity_playbook.published.v1`
- `freedom.organization.profession_starter.progressed.v1`
- `freedom.organization.welcome.started.v1`
- `freedom.organization.welcome.progressed.v1`
- `freedom.organization.welcome.completed.v1`
- `freedom.people.xp_projection.rebuilt.v1`
- `freedom.organization.office.assigned.v1`
- `freedom.organization.office.handed_off.v1`
- `freedom.organization.module_stewardship.assigned.v1`

### 5.2 Positioning／Journey

- `freedom.positioning.assessment.started.v1`
- `freedom.positioning.assessment.completed.v1`
- `freedom.positioning.assessment.claimed.v1`
- `freedom.positioning.guided_discovery.started.v1`
- `freedom.positioning.guided_discovery.draft_created.v1`
- `freedom.positioning.profile.confirmed.v1`
- `freedom.positioning.profile.superseded.v1`
- `freedom.positioning.profile.dismissed.v1`
- `freedom.journey.next_action.created.v1`
- `freedom.journey.next_action.completed.v1`

### 5.3 Community／Coaching

- `freedom.community.activity.published.v1`
- `freedom.community.activity.registration.recorded.v1`
- `freedom.community.activity.participation.updated.v1`
- `freedom.community.attendance.recorded.v1`
- `freedom.community.match.round.completed.v1`
- `freedom.community.encounter.reported.v1`
- `freedom.coaching.suggestion.offered.v1`
- `freedom.coaching.suggestion.accepted.v1`
- `freedom.coaching.suggestion.dismissed.v1`
- `freedom.coaching.suggestion.expired.v1`
- `freedom.coaching.enrollment.requested.v1`
- `freedom.coaching.enrollment.waitlisted.v1`
- `freedom.coaching.enrollment.matched.v1`
- `freedom.coaching.enrollment.activated.v1`
- `freedom.coaching.enrollment.paused.v1`
- `freedom.coaching.enrollment.resumed.v1`
- `freedom.coaching.enrollment.withdrawn.v1`
- `freedom.coaching.enrollment.transferred.v1`
- `freedom.coaching.enrollment.completed.v1`
- `freedom.coaching.checkpoint.help_requested.v1`
- `freedom.coaching.checkpoint.completed.v1`
- `freedom.coaching.outcome.submitted.v1`

### 5.4 Skills／GitHub

- `freedom.skill.package.registered.v1`
- `freedom.skill.version.published.v1`
- `freedom.skill.version.automation_ready.v1`
- `freedom.skill.maintainer.changed.v1`
- `freedom.skill.github.pr_merged.v1`
- `freedom.skill.issue.reported.v1`
- `freedom.skill.version.deprecated.v1`
- `freedom.skill.member_installation.started.v1`
- `freedom.skill.member_installation.verified.v1`
- `freedom.skill.member_installation.failed.v1`
- `freedom.skill.member_installation.degraded.v1`
- `freedom.skill.member_installation.outdated.v1`
- `freedom.quality.submission.created.v1`
- `freedom.quality.review.claimed.v1`
- `freedom.quality.review.submitted.v1`
- `freedom.quality.review.retracted.v1`
- `freedom.quality.reviewer_appointment.granted.v1`
- `freedom.quality.reviewer_appointment.revoked.v1`
- `freedom.quality.reviewer_appointment.expired.v1`
- `freedom.quality.version.accepted.v1`
- `freedom.quality.version.changes_requested.v1`
- `freedom.product.commercial_edition.created.v1`
- `freedom.product.commercial_edition.ready.v1`
- `freedom.product.commercial_edition.retired.v1`

### 5.5 Opportunity／Result

- `freedom.work.submission_draft.created.v1`
- `freedom.work.submission_draft.confirmed.v1`
- `freedom.work.submission_draft.rejected.v1`
- `freedom.work.submission_draft.expired.v1`
- `freedom.opportunity.opened.v1`
- `freedom.opportunity.claimed.v1`
- `freedom.opportunity.claim.released.v1`
- `freedom.opportunity.stub.created.v1`
- `freedom.project.created.v1`
- `freedom.project.squad.formed.v1`
- `freedom.service.engagement.opened.v1`
- `freedom.service.sow.version.created.v1`
- `freedom.service.sow.version.signed.v1`
- `freedom.service.allocation.proposed.v1`
- `freedom.service.engagement.allocation_signed.v1`
- `freedom.service.milestone.submitted.v1`
- `freedom.service.milestone.change_requested.v1`
- `freedom.service.milestone.accepted.v1`
- `freedom.ledger.service_payable.accrued.v1`
- `freedom.service.change_request.opened.v1`
- `freedom.work.item.opened.v1`
- `freedom.work.item.claimed.v1`
- `freedom.work.submission.created.v1`
- `freedom.work.submission.accepted.v1`
- `freedom.work.draft_artifact.created.v1`
- `freedom.work.draft_artifact.revised.v1`
- `freedom.work.draft_artifact.applied.v1`
- `freedom.contribution.recorded.v1`
- `freedom.result.recorded.v1`
- `freedom.result.confirmed.v1`
- `freedom.result.disputed.v1`
- `freedom.result.reversed.v1`

### 5.6 Commerce／Ledger

- `freedom.commerce.product.created.v1`
- `freedom.commerce.offer.listed.v1`
- `freedom.commerce.seller_listing.created.v1`
- `freedom.commerce.seller_listing.revised.v1`
- `freedom.commerce.distribution_acceptance.requested.v1`
- `freedom.commerce.distribution_acceptance.accepted.v1`
- `freedom.commerce.distribution_acceptance.change_requested.v1`
- `freedom.commerce.distribution_acceptance.declined.v1`
- `freedom.commerce.distribution_acceptance.revoked.v1`
- `freedom.commerce.supply_reservation.created.v1`
- `freedom.commerce.supply_reservation.consumed.v1`
- `freedom.commerce.supply_reservation.expired.v1`
- `freedom.commerce.attribution.clicked.v1`
- `freedom.commerce.attribution.claimed.v1`
- `freedom.commerce.attribution.accepted.v1`
- `freedom.commerce.order.created.v1`
- `freedom.commerce.supply_order.created.v1`
- `freedom.commerce.payment.authorized.v1`
- `freedom.commerce.payment.confirmed.v1`
- `freedom.commerce.order.fulfilled.v1`
- `freedom.commerce.refund.requested.v1`
- `freedom.commerce.refund.accepted.v1`
- `freedom.commerce.refund.rejected.v1`
- `freedom.commerce.return.received.v1`
- `freedom.commerce.payment.refund.confirmed.v1`
- `freedom.commerce.payment.chargeback.recorded.v1`
- `freedom.commerce.order.refunded.v1`
- `freedom.ledger.supplier_payable.accrued.v1`
- `freedom.ledger.commission_obligation.accrued.v1`
- `freedom.ledger.obligation.reversed.v1`
- `freedom.ledger.settlement.reported.v1`
- `freedom.ledger.settlement.confirmed.v1`
- `freedom.ledger.settlement.disputed.v1`
- `freedom.commerce.settlement_mandate.activated.v1`
- `freedom.commerce.settlement_mandate.revoked.v1`
- `freedom.commerce.settlement_mandate.capacity_reserved.v1`
- `freedom.commerce.settlement_mandate.capacity_consumed.v1`
- `freedom.commerce.settlement_mandate.capacity_released.v1`
- `freedom.commerce.settlement_instruction.created.v1`
- `freedom.commerce.settlement_instruction.manual_evidence_confirmed.v1`
- `freedom.commerce.transfer.provider_accepted.v1`
- `freedom.commerce.transfer.confirmed.v1`
- `freedom.commerce.fulfillment.authorized.v1`

### 5.7 Storefront／Marketing／Media

- `freedom.storefront.binding.activated.v1`
- `freedom.storefront.deployment.reported.v1`
- `freedom.marketing.campaign.created.v1`
- `freedom.marketing.content.generated.v1`
- `freedom.marketing.publication.succeeded.v1`
- `freedom.marketing.publication.failed.v1`
- `freedom.media.edit.requested.v1`
- `freedom.media.render.completed.v1`
- `freedom.media.render.failed.v1`
- `freedom.quota.reserved.v1`
- `freedom.quota.consumed.v1`
- `freedom.quota.exhausted.v1`

### 5.8 Agent／Work

- `freedom.agent.connection.registered.v1`
- `freedom.agent.connection.revoked.v1`
- `freedom.agent.execution_grant.created.v1`
- `freedom.agent.execution_grant.revoked.v1`
- `freedom.agent.run.started.v1`
- `freedom.agent.action_intent.created.v1`
- `freedom.agent.action_intent.signed.v1`
- `freedom.agent.action_intent.succeeded.v1`

### 5.9 低維運互惠事件增量

| Event | 唯一producer | Aggregate | 最小payload／消費邊界 |
| --- | --- | --- | --- |
| `freedom.work.participation_terms.revised.v1` | agent-control（Work owner） | work_item | work_item_ref、terms_revision、terms_sha256；私密條款另依scope查，不廣播真人身份／時間 |
| `freedom.result.benefit_observed.v1` | opportunities-results（Result owner） | benefit_observation | observation_ref、work_item_ref、revision；可重建read model，不建立contribution／payable或改QC |

Event envelope、序號、transaction outbox與dataschema materialization沿用原規範。`freedom.work.participation_terms.revised.v1`尚無producer；`freedom.result.benefit_observed.v1`目前由`modules/results/benefits.ts`寫入本地outbox（只含observation／work_item refs、community與revision），尚未符合上述envelope、dataschema或consumer protocol，不能當作canonical producer已完成。

## 6. Command 與 Event 的界線

Command 是「請系統做某事」，可拒絕；Event 是「某件事已成立」，不可假裝未發生。

| Command | 成功後 Event | 失敗處理 |
| --- | --- | --- |
| `CompleteAssessment` | `freedom.positioning.assessment.completed.v1` | 回 validation error；不發完成事件 |
| `ConfirmWorkIntent` | `freedom.organization.work_intent.confirmed.v1` | Organization/Professions core驗本人；AI draft不自動啟用 |
| `ActivateEntitlement` | `freedom.entitlement.activated.v1` | 顯示缺少條件；不是 compliance punishment |
| `ClaimOpportunity` | `freedom.opportunity.claimed.v1` | slot/version conflict，client reload |
| `CreateServiceSOWVersion` | `freedom.service.sow.version.created.v1` | scope/deliverables/acceptance/milestones/support/change rule/signer set齊全；不改舊SOW |
| `CompleteSOWSignatures` | `freedom.service.sow.version.signed.v1` | 所有required parties對同一digest完成A4；Agent／換角色不重複計人 |
| `ProposeAndSignEngagementAllocation` | `freedom.service.allocation.proposed.v1`／`freedom.service.engagement.allocation_signed.v1` | 每entry由Squad明定person/scope/milestone/calculation並各自簽名；不由PR/QC推算 |
| `SubmitOrReviewServiceMilestone` | `freedom.service.milestone.submitted.v1`／`freedom.service.milestone.change_requested.v1`／`freedom.service.milestone.accepted.v1`；accept後依pinned trigger發`freedom.ledger.service_payable.accrued.v1` | acceptance綁exact deliverable；只建立active signed plan中明定的ServicePayable，同source/milestone/beneficiary冪等 |
| `OpenServiceChangeRequest` | `freedom.service.change_request.opened.v1` | 變更另建request；接受後發新SOW／必要時新AllocationPlan，不原地改signed artifact |
| `SubmitArtifactForQC` | `freedom.quality.submission.created.v1` | candidate仍可討論；未通過只不可official/sellable |
| `SignQualityDecision` | `freedom.quality.version.accepted.v1`／`freedom.quality.version.changes_requested.v1` | reviewer是獨立自然人，簽exact digest |
| `AcceptDistributionRevision` | `freedom.commerce.distribution_acceptance.accepted.v1` | Supplier人類簽actual/effective price schedule與listing revision；不以MSRP自動判斷 |
| `ReserveSupplyForCheckout` | 每 line 一個 `freedom.commerce.supply_reservation.created.v1` | 只接受active DistributionAcceptance；同transaction固定effective item price/quantity/TTL |
| `CreateAndAcceptBuyerOrderAtCheckout` | `freedom.commerce.order.created.v1`＋每 Supplier 一個 `freedom.commerce.supply_order.created.v1` | one SellerParty；重算 sellability；同transaction令Order accepted、SupplyOrders進`awaiting_buyer_payment`；idempotent same response |
| `ConfirmPaymentWebhook` | `freedom.commerce.payment.confirmed.v1`＋每 line 一個 `freedom.commerce.supply_reservation.consumed.v1` | 驗provider occurred time仍在TTL、原子consume；invalid signature reject＋metric |
| `AccrueOrderObligations` | reseller line：`freedom.ledger.supplier_payable.accrued.v1`；明示 sales-agent/referral line：`freedom.ledger.commission_obligation.accrued.v1` | 僅在verified paid後依exact signed source version；Seller retained margin不是commission；同source/order line/beneficiary只形成一次 |
| `CreateSettlementInstructions` | `freedom.commerce.settlement_instruction.created.v1` | 僅按已成立的financial obligation與immutable source snapshot；unique obligation key |
| `ExecuteTransfer` | `freedom.commerce.settlement_mandate.capacity_reserved.v1`後，依結果發`freedom.commerce.transfer.provider_accepted.v1`／`freedom.commerce.transfer.confirmed.v1`及capacity consumed/released | 唯一active bound＋原子`reserved + consumed` cap；result_unknown保留capacity並只進reconciliation，不假造成功event |
| `RequestRefund` | `freedom.commerce.refund.requested.v1` | 建 request；不先改 Payment/Ledger |
| `AppendVerifiedRefundFact` | 每筆發`freedom.commerce.payment.refund.confirmed.v1`；僅當 Order 累計已驗證退款達可退的 confirmed paid amount 時，再發`freedom.commerce.order.refunded.v1` | 驗證累計可退額、currency 與原 payment ref；每筆部分退款都是獨立 fact，並按本次金額追加 Ledger reversal |
| `ReverseFinancialObligation` | `freedom.ledger.obligation.reversed.v1` | 必須引用原 SupplierPayable／CommissionObligation／ServicePayable accrual、同currency與本次金額；不可 update 原 event |
| `PublishContent` | `freedom.marketing.publication.succeeded.v1`／`freedom.marketing.publication.failed.v1` | async job/retry，不在 request 假成功 |
| `RequestRender` | `freedom.media.edit.requested.v1` | quota reserve 失敗只拒絕本 job |
| `CreateAgentRun` | `freedom.agent.run.started.v1` | 驗 principal、acting role、grant、task lease；Agent 不可自授權 |
| `CreateDraftArtifact` | `freedom.work.draft_artifact.created.v1` | 非code完整document須符合pinned schema；建立首個immutable revision，不直接改target |
| `ReviseDraftArtifact` | 舊版發`freedom.work.draft_artifact.revised.v1`，同transaction新successor發`freedom.work.draft_artifact.created.v1` | path ID／prior_revision_id必須是同一舊版；原子supersede舊版並以同lineage_id建立新draft。Successor保存完整validated content與新digest，不把partial patch當canonical content |
| `ApplyDraftArtifactRevision` | `freedom.work.draft_artifact.applied.v1`＋`freedom.agent.action_intent.succeeded.v1`＋WorkEvent | digest／base target version未變、required review與該target A-level authorization齊全；owning aggregate另發自己的fact |

## 7. Aggregate State Machines

### 7.1 User

```text
active ──本人暫停／管理者有理由暫停──> paused
paused ──本人恢復／授權管理者恢復────> active
active/paused ──本人停用──────────────> deactivated
```

- 不因三個月沒 activity 自動切 paused。
- `deactivated` 後依保留規則限制登入，但歷史交易／結果仍以 pseudonymous ref 保留必要連結。
- 單一 Entitlement 問題不應改整個 User state。

```text
MemberConnection:
requested → active → ended
requested → declined / cancelled
```

- requester 與 recipient 必須是不同 User；只有 recipient 可 accept／decline，requester 可 cancel，任一方可 end active connection。
- ended／declined／cancelled 保留 audit，但不授予讀取私訊、完整 contact book 或 integration credential 的權限。

### 7.2 CareerProfile／Assessment

```text
AssessmentRun:
created → in_progress → completed
        → abandoned
created/in_progress → expired

CareerProfileRevision:
suggested → confirmed → superseded
          → dismissed
```

- assessment 可匿名開始，登入後以安全 claim token 綁 user；不能靠 email fuzzy match。
- `completed` 只代表伺服器已完成 evaluation，不等於 profile `confirmed`；使用者可選不同路線。
- 改題目／權重發新 ruleset；舊 evaluation 不重算覆蓋。

### 7.3 Entitlement

```text
available ──activate/self-service grant──> active
active ──本人暫停／scope 暫停──────────> paused
paused ──恢復─────────────────────────> active
active/paused ──人工有理由撤回─────────> revoked
revoked ──申訴／重新授權──────────────> active
active/paused ──明確到期──────────────> expired
```

- `available` 是 UI 提示，不是已有 API capability。
- 前期不由 AI compliance score 轉 revoked。
- 每次 transition 寫 actor、reason、scope、rule ref 和 audit event。

### 7.3.1 ProfessionMembership、Office 與 ModuleStewardship

```text
ProfessionMembership:
runner → strategist_review → strategist → master_review → master
   ↖──────── request_more_evidence ────────↙
runner/strategist_review/strategist/master_review/master → left

WorkIntent:
draft → active → superseded
draft/active → withdrawn

OfficeAssignment:
proposed → active → handing_over → ended
        ↘ declined

ModuleStewardship:
proposed → active → handing_over → superseded
```

- Rank decision建立immutable RankRecord並引用Guild rubric version與human-reviewed evidence；要求更多evidence保留既有rank，不因不活躍自動降級。Office holder可交接給下一位，不改歷史rank。
- WorkIntent只有本人確認才進active；AI/Positioning draft不授予office、entitlement、claim或付款，new revision不改既有工作事實。
- ModuleStewardship在任一時點只有一個accountable Guild/Master office；delegates可多個且有scope/expiry。
- 一人可有多ProfessionMembership，但每個Claim/AgentRun/Signature只記一個acting profession membership；需要三個人或獨立review時按human principal去重。

Guild／WelcomeRitualRun／MemberSkillInstallation：

```text
Guild: draft → active ↔ degraded → archived
       draft ───────────────────→ archived

WelcomeRitualRun: queued → running → completed
                         ↘ skipped

MemberSkillInstallation:
recommended → equipped → installing → verified → outdated
                         ├→ failed ───────┐
                         └→ degraded ─────┴→ installing
recommended/equipped/installing/verified/failed/degraded/outdated → removed
```

- Guild `active`不要求readiness全滿；private Discord missing只能讓readiness顯示缺項或lifecycle標degraded，不能影響Runner self-join。
- Welcome沒有等待Master的state；`completed|skipped`都只是projection事實，成員可在`queued|running`時照常學習與工作。
- MemberSkillInstallation全部是導航；failed/degraded/outdated的transition effect是Next／alternative／help／WorkItem，不是entitlement transition。

### 7.4 SkillPackage 與 SkillVersion

```text
Package:
draft → candidate → official → archived
      ↘ archived

Version:
registered → candidate → official → deprecated → withdrawn
                         ↘ withdrawn
official/deprecated → unmaintained → official (新 maintainer 接手)

Capability readiness（每個 capability 各自 orthogonal）:
not_requested / declared → validating → ready
                                  ↘ not_ready → validating
```

- `candidate/registered` 即可在 registry 被找到、討論、測試與 fork；manifest readiness 不可作可見性前置條件。`documentation/installation/execution/dependency_resolution/version_sync` 各自驗證、各自啟用。
- `official` 需要 protocol-matched independent human QC signature，且registry必須用stable repository ID重查GitHub API確認source repo `is_fork=false`；commercial binding 還須 commercial scope、license disclosure 與三職業人力狀態。Fork Skill可公開candidate、測試與保留lineage，但現行`candidate→official`與commercial-ready guards一律拒絕；要升格須新建non-fork canonical repo/新repository ID並保留source/license lineage。Automated check、community run、field use、maintained 是 evidence，不可冒充正式 QC 簽名。
- 新內容永遠另建candidate Version；不得把既有official Version倒退成candidate或原地換commit。
- `withdrawn` 停止官方推薦／新 binding；已下載 fork 不宣稱被遠端關閉。

ReviewSubmission／QualityReview：

```text
ReviewSubmission:
submitted → in_review → accepted
                    ↘ changes_requested → superseded（作者以新version重送）
submitted/changes_requested → withdrawn
```

- Decision 綁 exact version/digest；內容一變即新 request，不沿用舊簽名。
- `changes_requested/rejected` 不封鎖提交者、repo 或候選討論；修正後再提交。
- revoked_for_future 停止新 official/commercial listing，不抹去歷史 Order／已交付版本。

```text
ReviewerAppointment:
active → revoked
active → expired（server time >= review_by）

review_outcome:
accepted → retracted
```

- `ReviewerAppointment` 建立即為 `active`，appointer 必須是 OD-10 Guild Officeholders Council 的具名自然人 holder；同 scope 的 `qc.review:<scope>` 只投影自有效 appointment。續任建立可追溯的新 appointment，不原地延長舊紀錄。
- `accepted → retracted` 追加 retraction fact，保存原 outcome；若 retractor 不是原 reviewer，需另一位不同自然人的有效 appointment／exact decision。retracted outcome 不再進 XP、matching priority 或 entitlement projection，原 receipt 重送固定拒絕為 `receipt_superseded_by_retraction`。

### 7.5 Opportunity、WorkItem 與 WorkClaim

```text
Opportunity:
draft → open → filled → closed
            ↘ cancelled
open/filled → paused → open

OpportunityClaim:
claimed → in_progress → submitted → confirmed
       ↘ released       ↘ changes_requested → submitted
       ↘ expired        ↘ disputed → confirmed/rejected
```

- `claimed` 使用 atomic slot allocation。
- 到期 release 只釋放名額；不自動停會員。
- 普通任務：confirmed ResultEvent 後發 reward/entitlement。
- 高責任交付可在 Opportunity 指定額外 accepted/warranty results；不是所有任務都被強迫走。

```text
Squad: proposed → forming → active → completed
                 ↘ cancelled   ↘ cancelled

WorkItem lifecycle:
draft → open → active → claiming_closed → accepted
         └──────────────→ claiming_closed
draft/open/active/claiming_closed → cancelled
open/active → expired

Review-capacity navigation（與 WorkItem lifecycle 正交，穩定 ID 不變）:
available ↔ waiting_reviewer_capacity

WorkClaim:
claimed → in_progress → submitted → in_review → accepted
                         ↖ changes_requested ↙
claimed/in_progress/submitted/in_review/changes_requested → cancelled
claimed/in_progress/submitted/changes_requested → released
claimed/in_progress → expired
```

- Opportunity Claim與WorkClaim都屬人／Team／Squad；Agent `TaskLease`可過期重領但不改Claim。
- `review_required=true` 且指定 scope 沒有有效 `ReviewerAppointment` 時，candidate 仍維持 `open`／published 且可領取；review-capacity 導航狀態記為 `waiting_reviewer_capacity` 並建立 Council support card。缺容量只使 `official=false` 並更新導航；有容量後更新 review route 與卡片，不改 WorkItem lifecycle。
- Exclusive mode在第一個claim transaction後直接令WorkItem`claiming_closed`；collaborative／competitive進`active`並依pinned capacity/deadline收多個WorkClaims，之後才關claiming。
- 每個WorkClaim自行submitted／review／accepted；未入選、release或expiry仍保留evidence/provenance，不產生隱藏負分，也不能覆寫別人的結果。
- accepted WorkClaim建立ContributionRecord；任何payment必須另有Order/reward/EngagementAllocationPlan。

```text
ServiceEngagement:
draft → proposed → squad_forming → active ↔ milestone_review
                                active → support_period → completed
draft/proposed/squad_forming/active → cancelled

SOWVersion:
draft → collecting_signatures ↺ → signed → superseded
draft/collecting_signatures → withdrawn

Milestone:
planned → in_progress → submitted → accepted
                         ↘ changes_requested → in_progress

EngagementAllocationPlan:
draft → collecting_acceptances ↺ → signed → superseded
draft/collecting_acceptances → withdrawn

ServiceChangeRequest:
opened → accepted / rejected / withdrawn
```

- SOW、ChangeRequest、Milestone Acceptance與AllocationPlan皆綁exact revision/digest；變更不能以聊天覆寫。Signed SOW／AllocationPlan immutable，新版本只有在required signer set完整簽署後才取代舊版。
- AllocationPlan未完成所需Squad signatures前不可從客戶付款自動分配，但不阻塞免費探索／proposal工作；需先做的成本由成員明示承擔。
- Accepted Milestone只按active signed AllocationPlan建立該milestone明定的service payables；community QC、PR或ContributionRecord本身仍是零金額evidence。

### 7.6 ResultEvent

```text
recorded → confirmed
         → disputed → confirmed / rejected
confirmed → reversed
```

- system-observed 的低風險結果可直接建立 confirmed event。
- self report 建 recorded，若規則只需本人回報也可觸發低風險 gain，但 UI 顯示證據來源。
- reversed 建新的 reversal fact，原 event 保持可查。
- Result 不自動推導法律責任；保存 `responsibility_context` 供後續理解。

### 7.7 Product／Offer／Listing

```text
Product:
draft → candidate → active → paused → active
        (QC)             ↘ archived

CommercialEdition:
draft → product_ready → team_ready → ready ↔ paused
draft/product_ready/team_ready/ready/paused → retired

Offer:
draft → review_ready → listed → paused → listed
                    ↘ archived

SellerListingRevision:
draft → awaiting_supply_acceptance → sellable → paused
                               ↘ changes_requested
changes_requested/sellable/paused → superseded
任一非終止state → retired

DistributionAcceptance:
requested → accepted → revoked / expired / superseded
          ↘ changes_requested / declined

SupplyReservation:
active → consumed
active → expired / released
expired ── late verified webhook with provider occurred_at within TTL ──→ consumed
```

- Official/listed 前驗 functional fields、applicable QC signature、seller responsibility、exact supplier acceptance 與 payment/fulfillment path；不用 AI compliance score。
- CommercialEdition domain state `ready`（UI／業務標籤可顯示`commercial-ready`）須綁exact PackageVersion/license obligations、commercial-scope QC，以及三個不同自然人的Vibe/Field/Project assignments；任一人離隊後可標capacity attention／paused，不改舊Order。
- MSRP／recommended floor 只做 advisory display。Supplier decision 是對 exact actual price revision 的人類接受／拒絕，不是自動低價 cutoff。
- DistributionAcceptance `revoked`只阻止新reservation／order intent；較早建立的未付款BuyerOrder只在其active reservation TTL內保留付款資格，已付款BuyerOrder則按當時acceptance snapshot走履約或明示退款處理。
- Revoke與reservation create使用同一acceptance version／DB serialization；revoke後不能出現新active reservation。既有active reservation只到其TTL，provider session expiry不得更晚。
- Product 暫停不刪既有 Order。
- Offer 新條款產生新 version；在途訂單仍按 snapshot。

### 7.8 Order、Payment 與 Fulfillment

三個 orthogonal state，避免單一 `status` 爆炸。

```text
BuyerOrder lifecycle:
created → accepted → completed
       ↘ cancelled
accepted/completed → disputed → completed

Payment:
unpaid → pending → authorized → paid → partially_refunded → refunded
            └───────────────→ paid       ↺ partial refunds
pending/authorized → failed → pending
paid/partially_refunded → chargeback

SupplyOrder:
awaiting_buyer_payment → settlement_due → fulfillment_authorized → fulfilling → fulfilled
                    ↘ cancelled                              ↘ refunded
settlement_due/fulfillment_authorized/fulfilling/fulfilled → refunded

Fulfillment:
not_authorized → authorized → in_progress → delivered → accepted
                         ↘ failed/cancelled
delivered → changes_requested → delivered
```

Derived order view：

- `awaiting_payment` = BuyerOrder accepted且Payment尚無paid fact；它是derived view，不是BuyerOrder lifecycle state。
- `ready_to_fulfill` = 該 SupplyOrder 的 settlement confirmed／有效 credit term 且 fulfillment authorized；買家 paid 不直接授權未結算 Supplier 出貨。
- `settlement_eligible` = payment qualified、退款等待期滿且相應條件成立。
- UI 顯示 derived label，但不把它存成唯一真相。
- `authorized`、`paid`、每一筆 partial/full refund 與 chargeback 都是不同 immutable PaymentFact；projection state 不能取代 facts。只有 verified paid 才可形成 Order financial obligations，authorization 不可。
- 同一 BuyerOrder 只有一個 SellerParty／payment collector；多 Supplier 以 SupplyOrders 和 SettlementInstructions 拆分，買家不分頭付款。

Refund/Return 是獨立流程，不塞進單一 Order status：

```text
RefundRequest:
requested → accepted → executing → refunded
          → rejected
          → withdrawn
executing → failed → executing
accepted/executing/failed → refunded（verified fact／evidence-backed operator resolution）
                          → manually_resolved_not_refunded

PhysicalReturn:
authorized → shipped → received → inspected → resolved
          → cancelled
```

- `accepted` 只是 seller 接受處理，不可顯示「已退款」；新增 verified refund PaymentFact 並發`freedom.commerce.payment.refund.confirmed.v1`後，RefundRequest 才是`refunded`，但不因此把整張 Order 標為全額退款。
- 人工結案必須明分兩個命令：有可驗證退款事實才進 `refunded` 並連回 PaymentFact；明確查證未退款則進 `manually_resolved_not_refunded`。不得用一個含糊 `resolved` 同時代表兩者。
- 部分退款保留其 amount；累計 refund 不得超過可退的 confirmed paid amount。僅當 Order 累計已驗證退款達該金額時，才發`freedom.commerce.order.refunded.v1`。併發退款以 DB lock／aggregate version 防止超退。
- Return 是否必要、運費責任與期限固定在 OfferVersion/Order commitments snapshot；服務／數位交付可直接走 refund/dispute。

### 7.9 AttributionClaim

```text
pending → accepted → linked_to_order
        → rejected
        → disputed → accepted/rejected
pending → expired
```

優先序預設：signed referral/session evidence > store promo code > buyer order-time selection > manual post-order claim。規則可配置但需 versioned；manual claim 不因雙方互點就立即撥款。

### 7.10 Financial Obligation／Settlement

```text
SupplierPayable:
pending → qualified → due

CommissionObligation:
pending → qualified → due

ServicePayable:
pending → qualified → due

FinancialObligationReversal（orthogonal）:
none → partially_reversed ↺ → fully_reversed

SettlementMandate:
draft → active → revoked / expired / superseded

SettlementInstruction:
created → authorization_required → ready
   └── exact bound + atomic capacity reservation ──→ ready
ready → executing → provider_accepted → confirmed
                  ↘ result_unknown → reconciling → confirmed / ready / authorization_required / manual_required
ready → authorization_required（mandate revoked/expired；release capacity）
ready → manual_required（provider無initiation能力）→ confirmed / written_off
confirmed/manual_required → reversed（refund/chargeback reverse obligation）
```

- `authorization_required`表示obligation已成立但沒有matching active Mandate；不刪除應付。
- `ready`表示typed source、purpose-tagged connections、唯一bound及UsageReservation已固定；執行前仍重驗Mandate active、target version與reservation。
- Provider timeout 是 `result_unknown`，先 reconcile；不可用新 transfer key 盲重送。
- `manual_required`只在provider明示沒有initiation能力，或reconciliation需要人工evidence時使用；ambiguous transfer不可另走一筆人工付款。recipient/provider evidence確認前保持未confirmed。
- Mandate revoke／expire／supersede都令ready instruction回`authorization_required`並release capacity；executing/provider_accepted/result_unknown保留capacity與operation key直到reconciliation證明confirmed或no-effect。
- `manual_required`若承接仍未查明外部效果的reservation，不先釋放capacity；verified evidence確認transfer時必須consume仍為reserved的capacity，再確認ledger settlement。
- `confirmed`與SupplyOrder的`fulfilled`都是可見成功態，但不是不可逆terminal；後續refund／chargeback只能追加reverse obligation／refunded transition，不可改寫原fact。
- 不使用「七天未按視為 confirmed」；逾期只提醒與 attention flag，不自動做 compliance suspension。
- reseller `SupplierPayable`只由verified paid＋signed DistributionAcceptance建立；Seller retained margin不是commission payable。`CommissionObligation`只由明示且已簽的sales-agent/referral rule建立；`ServicePayable`只由accepted milestone pinned的signed EngagementAllocationPlan/payment trigger建立。
- refund/chargeback 建 generic obligation reversal ledger event；不能刪 SupplierPayable、CommissionObligation 或 ServicePayable row。
- 每筆 reversal 必須引用原 accrual、使用相同 currency，並以 effect idempotency key 去重；所有 partial reversal 累計不得超過原 accrual，full reversal 必須剛好等於未沖回餘額。

### 7.11 Store／Binding

```text
Store:
draft → active → paused → active
             ↘ archived

Binding:
requested → verified → active → revoked
                   ↘ failed
active → outdated → active (upgrade)
```

- domain/origin challenge 驗證是技術完整性，不是商品審批。
- revoke binding 只停止 canonical API／官方標示；不刪 GitHub fork。

### 7.12 Campaign／PublicationJob

```text
Campaign:
draft → ready → running → completed
            ↘ paused → running
            ↘ cancelled

PublicationJob:
queued → publishing → published
                    → failed → queued / abandoned
queued → cancelled
```

- Owner 可選「每次預覽」或「符合 template 即自動發布」；不是平台 compliance 審查。
- provider 接受不等於公開成功；需保存 provider external ID 或後續 reconciliation。

### 7.13 EditProject／RenderJob

```text
EditProject:
draft → analyzing → storyboard_ready → rendering → completed
                 ↘ needs_input          ↘ failed

RenderJob:
queued → running → succeeded
                → failed → queued / abandoned
queued → cancelled
```

- 每次 provider call 前 reserve quota。
- retry 沿用 idempotency key，不重複計費或產生多份「最新」輸出。
- 成功 output 形成 immutable MediaAsset；新版本另建 asset。

### 7.14 Coaching

```text
CoachingSuggestion:
offered → accepted / dismissed / expired

Enrollment:
requested → matched → active → completed
requested → waitlisted → matched
requested/waitlisted/matched/active/paused → withdrawn
active ↔ paused

Checkpoint:
planned → in_progress → submitted → confirmed
planned/in_progress → skipped

Checkpoint attention_state:
none ↔ needs_help
```

- Positioning 只能建立 `offered` suggestion，不自動替會員報名或付費。
- mentor/mentee 雙方可 withdraw／transfer；已完成 checkpoint 不消失。`needs_help` 與 overdue 是支援／投影狀態，不是失敗 lifecycle。
- 陪跑完成以學員指定結果為主，不以聊天訊息數／在線時間作主要成果。
- 學員完成目標與 coach 的陪跑貢獻是兩筆不同 ResultEvent，例如 `coaching.learner.target_completed` 與 `coaching.coach.support_delivered`；可共用 enrollment/correlation，但 evidence、確認者與 entitlement 各自獨立。

### 7.15 Quota

Quota 不以 mutable balance 作唯一帳：

```text
reserve → consume
        → release
refill / expire / adjust
```

Projection 可顯示 available/reserved/consumed。Provider 成本晚到時以 adjustment 補記；不能把 quota negative 當作撤銷會員資格的理由。

### 7.16 Activity、Participation 與 MatchRound

```text
Activity:
draft → published → registration_open → live → completed → archived
             └──────── cancel ───────────────→ cancelled → archived

ActivityParticipation:
registered → checked_in → participating → completed
          └──────────────────────────────→ withdrawn

MatchRound:
scheduled → running → completed
        └────────────→ cancelled

EncounterReport（與 assignment 分開）:
unreported → reported / declined / expired
```

- Activity／round 的 timer 由 server 擁有；大屏只讀狀態，不負責讓 round 完成。
- role、social energy、wall/matching preference、照片與 guest ID 都是 activity scope；不改 CareerProfile、User 或 Entitlement。
- 報到唯一性在 `community_id + activity_id + actor` 的同一 transaction 保證；沒有先查後寫 race。
- 分輪完成只表示產生 directed assignments；必須由參與者另送 EncounterReport 才能說真的見面。Attendance 同樣不等於 Skill／Coaching Result。
- `archive` 取代 destructive reset；歷史 participant、assignment、encounter 與必要 asset refs 依 retention policy 保留。

### 7.17 Integration Connection、Delivery 與 ProviderJob

```text
Connection:
pending → active ↔ degraded → reauth_required → active
任一非終止 state ──owner/operator revoke──→ revoked

OutboundDelivery:
queued → sending → accepted → delivered
              ├→ accepted_no_receipt
              ├→ receipt timeout/negative → result_unknown/retry/permanent
              ├→ retry_wait → sending
              └→ result_unknown → reconciling → accepted/accepted_no_receipt/delivered/retry_wait/manual_unknown

ProviderJob:
queued → leased → running → succeeded
          │         ├→ known-safe retry_wait → queued
          │         └→ result_unknown → reconciling → succeeded/retry_wait/manual_unknown
          ├── needs input且無未查明外部副作用 → manual_unknown
          └── lease expired before external start → queued（新 fencing token）
running lease expired → result_unknown（不可直接 requeue）
```

- `accepted_no_receipt` 只適用 connector capability 明示無 receipt 的 provider；有 receipt 時 accepted 不是 delivered。
- `reconciling` 一定有收斂出口，不可讓使用者永久只看到「處理中」；查回 provider 已接受但該 Connection 明示無 receipt capability 時，直接收斂到 terminal `accepted_no_receipt`。
- `dead_letter` 只表示已知可重試工作耗盡 retry policy；仍不確定外部副作用是否發生的 reconciliation 只能查明結果或進 `manual_unknown`，不可假裝成 failed/dead-letter 後重送。
- Job 的 lease ID＋遞增 fencing token 是 canonical write fence；N+1 claim 後，持 N 的 heartbeat/complete/fail 必須以 `stale_job_lease` 無副作用拒絕。
- `provider_operation_key` 由 canonical job 派生且跨 lease attempts 不變；worker 在 external call 前先經 canonical `:begin-provider-operation` transaction 把 job 原子標成 running，Credential Broker 只服務 running job，之後任何不確定結果都先 reconcile。
- `complete`只接受`running`的current lease；`leased`不可跳過begin直接成功。`needs_input`只在確認沒有未查明外部副作用時收斂到`manual_unknown`，保留checkpoint與可操作的redacted input要求。
- Job payload 只帶 `connection_ref`／object refs；worker 依 current lease 向 Credential Broker 交換短效 scoped capability，不能收到 core 的長效 OAuth/API secret。

### 7.18 SubmissionDraft、AgentConnection、AgentRun、TaskLease、ExecutionGrant 與 DraftArtifact

```text
SubmissionDraft:
draft → confirmed / rejected / expired

AgentConnection:
pending_user_approval → active → revoked
                     ↘ denied
                     ↘ expired

ExecutionGrant:
draft → active → expired / revoked / exhausted / superseded

AgentRun:
prepared → running → awaiting_human → running → submitted → succeeded
prepared/running/awaiting_human/submitted → cancelled
running → failed
running → result_unknown → reconciling → succeeded / manual_unknown

TaskLease:
offered → leased → released / expired / completed

ActionIntent:
drafted → awaiting_signature → authorized → executing → succeeded
       ↘ authorized                 ↘ failed
executing → result_unknown → succeeded / manual_unknown
drafted/awaiting_signature/authorized → expired / superseded

DraftArtifact（每個ID是一個platform-native non-code PR immutable revision）:
draft → superseded / applied / abandoned
```

- SubmissionDraft create只建立owner-private intake；confirmed transition比對owner對saved exact source tuple的acknowledgement後，以單一transaction呼叫恰好一個`CreateDraftWorkItem`或`CreatePrivateOpportunityStub` owning command並保存其ref，不能順帶open／publish／claim／grant／sign。External document confirm零fetch且不是current-byte proof；LINE／Discord／document adapter與Agent token不能觸發terminal transition；同source dedupe key／HTTP idempotency key與expected version共同阻止重送及confirm／reject競態。
- AgentRun可因等待人類簽名進`awaiting_human`；不得把沒有A4簽名當工具錯誤重試。
- AgentConnection只綁一個已顯示的client instance與principal；active只帶明確命名、purpose-minimized、read-only的`agent.bootstrap.read`，可讀本人最小Status／Feed並尋找下一個grant入口。它不等於有ExecutionGrant，不能執行A1–A3 domain action，也永遠不包含A4 signing authority；A1–A3一律先驗同connection的active grant。Principal撤銷後停止新動作，已不確定的外部副作用仍進reconciliation。
- TaskLease 過期只換 executor；WorkItem Claim 仍屬原人／Squad。
- Grant revoke 停止新 ActionIntent，已發生外部副作用進 reconciliation；不刪 provenance。
- Revision command原子把舊DraftArtifact轉`superseded`、發revised event，並以同`lineage_id`建立新的draft aggregate、發created event；兩個ID不同。A4 signature只授權其digest。DraftArtifact content/diff或base target version變動必須建立新immutable revision，原ActionIntent `superseded`並重新review/sign；target已變時舊revision保持draft但apply回version conflict。`ChangeProposal`只是UI別名，不另有state machine。
- 同一 principal 的第二個 Agent、第二個 profession role 或第二個 browser session都不是獨立 reviewer。

## 8. Member Status Projection

`projection.member_status` 是可重建 read model，不是另一份權威資料。

建議欄位：

| 區塊 | 投影 |
| --- | --- |
| Identity | linked LINE/Discord/GitHub、缺少的漸進資料 |
| Direction | current declared tracks、assessment version、可修改入口 |
| Profession | 多個 ProfessionMembership/rank records、目前 WorkIntent/equipped skills、Guild/office（分開顯示） |
| XP | 各 profession 各 track 的 `MemberProfessionXpProjection`、policy version、rebuild position；不顯示跨 profession total |
| Now | active skill runs、Claims、Squads、AgentRuns、coaching、Buyer/Supply Orders/actions |
| Next | 最多三個本人 next actions；另提供完整 Daily Work Feed，全部帶 acting role／原因／耗時／gain／authority |
| Gained | active entitlements、recent confirmed results、settled rewards |
| Skills | equipped package versions、member+AgentConnection+PackageVersion installation health／outdated、maintained packages、recent versions；不使用模糊adoption狀態 |
| Community | Guild、讀書會、Squad、mentor/mentee relationships |
| Commerce | promotion links、Buyer/Supply Orders、SupplierPayable／明示CommissionObligation、settlement instructions/transfers/reversals |
| Agent | linked clients、active grants、waiting signatures、recent provenance與可 revoke 入口 |
| Resources | quota by billing source、cost warnings |

### 8.1 Next action ranking

規則透明、可配置、不可黑箱：

```text
1. 阻塞中的本人工作／待確認事項
2. 已開始流程的下一合法 transition
3. 90 分鐘內可形成第一個 result 的動作
4. 對 current declared track 直接有幫助
5. 有現任 maintainer/mentor、可取得即時回饋
6. 符合本人時間、預算、工具 constraint
7. 有真實 Opportunity／買家需求的項目
8. 本人 WorkIntent／acting profession 與已 equipped skill 可執行
```

「卡住」只用可重現條件：starter item的`due_at`已過且沒有progress receipt、最新MemberSkillInstallation A1 receipt為`fail|degraded`、或WorkClaim的`expected_update_at`已過且沒有checkpoint／submission。命中後只插入Next、建議替代路、顯示可選求助、依stable item id冪等materialize WorkItem並投影Strategist／delegate卡。`stuck|skip|missing|connector_unavailable`一律`enforcement=navigation`、零懲罰、不降低未來可發現性、不自動revoke任何entitlement。

輸出一定附 `reason_codes[]`、`acting_profession`、`expected_gain`、`authority_level` 與 `review_path`；會員可以隱藏／改路線。Agent 可以建議「我幫你做」，但必須先顯示實際副作用與授權範圍，不顯示虛假的 87% 適合度。

### 8.2 Projection rebuild

- 每個 projection 保存 `last_event_position`。
- 可以從 canonical tables/events 全量重建。
- Event consumer lag 時 UI 顯示資料最後更新時間；不把 stale projection 當寫入成功。
- 個人首頁只讀 projection；command 仍送 owning module API。
- `MemberProfessionXpProjection` 可以單獨整表刪除，再只從 append-only `ContributionRecord` 與 review outcome 重建；每列保存 `policy_version` 與 `rebuilt_from_event_seq`，retracted outcome 必須在同一 replay 結果中失效。

## 9. Ruleset 與 Snapshot

### 9.1 Rule categories

| Ruleset | 影響 | 是否追溯 |
| --- | --- | --- |
| positioning rules | 新 assessment evaluation | 否 |
| positioning content | 題目、選項與結果文案 | 舊 result 使用原 `content_ref` |
| recommendation policy | Track、Skill、Guild、Coaching mapping | 新 projection 可使用新版；每個 Next 保存 policy ref，不覆寫舊 result |
| XP policy | 該 profession 三個 track 的可讀重建公式 | 新 rebuild 使用明示版本；每列保存 policy version，不跨 profession 合計 |
| entitlement rules | 新 grant/next action | 預設否；明確 migration 才重算 |
| attribution rules | 新 click/claim/order | Order 成立後不追溯 |
| order obligation rules | 新 Order 的 supplier payable／明示 referral commission snapshot | 絕不原地改舊單；Seller margin不記為commission |
| QC protocol | 新 ReviewSubmission／新 artifact version | 舊 signature 只證明原 digest；不自動套新版 |
| price guidance | 新 Listing draft | MSRP/floor 只提示；不自動拒售或切斷供應 |
| distribution agreement | 新 SellerListing／BuyerOrder | 新 revision 需雙方簽；舊 paid order 按原 snapshot |
| settlement mandate | 新 TransferJob | 可立即 revoke future intent；已發生副作用須 reconcile |
| agent grant | 新 ActionIntent | scope/limit/expiry 立即生效；不可擴張已簽權限 |
| notification rules | 未來通知 | 可立即切換，不重發舊通知除非明示 |
| quota/pricing rules | 新 reserve/consume | 已 reserve 按原 snapshot |

### 9.2 Snapshot minimum

任何影響錢、權益或正式結果的決策至少保存：

- ruleset ID/version/hash。
- evaluated inputs 的 canonical hash。
- decision outputs。
- actor/service version。
- occurred/evaluated time。
- 若被人工 override，保存原決策、override actor、reason 與新 event。

## 10. 資料保留與刪除語意

這裡只定義工程語意，不在前期建立 compliance 停點：

- 會員刪除請求不能 cascade 刪除其他人的訂單、共同作品或帳本；以合法需要的 pseudonymization/reference preservation 處理。
- Platform 不保存 Discord／LINE 全文作狀態真相；沒有資料就不需做大規模聊天刪除流程。
- External-client-owned 文件原文留在owner／Squad端點；SubmissionDraft只保存opaque ref、digest、revision、media metadata、最小redacted summary與retention/access policy ref，不能把可重用下載credential或原文放進event、log或prompt。
- Payment secret、OAuth token 與 bank data 分開加密並可獨立撤銷。
- Object storage asset 有 owner、purpose、retention class；不能只有永久公開 URL。
- Ledger/Order/Result 的修正透過 reversal/supersede；不使用後台直接 SQL 改歷史。
- Guild Lounge 的 legacy participant 先匯入 guest participation；不以 nickname/photo 猜 User。

## 11. Model 驗收不變量

五種時間必須保存為不同欄位、由各自 owner 設定並獨立判定：

| 時間語意 | Canonical 欄位 | 誰設定 | 到期後果 | 可否延長 | 絕不可代替 |
| --- | --- | --- | --- | --- | --- |
| invite／claim window | invite／claim 的 `expires_at` | requester／WorkItem publisher 依 pinned policy | 到期後不能建立新 Claim；到期前已成立的 Claim 不被抹除 | 可在到期前以新 revision／明示延長 command 更新，保留舊值 audit | delivery `due_at`、TaskLease、ExecutionGrant 或 evidence validity |
| delivery commitment | delivery／Milestone／WorkItem 的 `due_at` | requester 與 claimant／Squad 依 SOW 或 accepted WorkItem revision | 顯示 overdue 並進協調／change path；不自動判失敗、降 rank 或移除技能 | 可由具權限者接受 versioned change；不回寫原承諾 | claim availability、lease authority、grant authority 或 evidence validity |
| current executor authority | lease 語意由 lease 物件（TaskLease／lease proof）承載；`expires_at` 必與 `fencing_token` 同物件出現；WorkItem／Claim／Grant／evidence 物件上的 `expires_at` 永遠不是 lease | server lease coordinator | 舊 executor 的新 write 以 stale fence 拒絕；人的 WorkClaim 保留 | 只能 renew／reassign 並發新有效期與 fence，不能沿用舊 token | WorkClaim ownership、delivery deadline、ExecutionGrant 或 evidence validity |
| Agent action authority | `ExecutionGrant.expires_at` | principal 在 bounded grant 內設定，server另套上限 | 停止新的受控 action；已發生或不確定副作用只進 reconciliation | 以新的 grant／revision 明示授權，不靜默延長 | TaskLease、claim／invite window、delivery deadline 或 A4 |
| evidence／qualification currency | evidence／appointment／credential 的 `valid_until`（ReviewerAppointment 使用 `review_by`） | evidence issuer／protocol owner；appointment 由具名 appointer 設定 | 之後不供需要 current evidence 的決策或 projection 使用；歷史仍保留 | 重新驗證並建立新 evidence／appointment revision | membership、rank history、claim、lease、grant 或 delivery deadline |

五種時間不得共用欄位或語意；外部 provider timestamp 只能作 `occurred_at`／`recorded_at` 類證據，不能成為其中任一 canonical clock。

1. 同一 canonical assessment answers hash＋ruleset ref＋evaluator ref 永遠得到相同 core result；四重 refs 可重現當時內容與初始推薦。
2. 同一 idempotency key＋相同 request 回同結果；不同 payload 回 conflict。
3. 任一 Ledger account balance 等於其不可變 events 加總。
4. 每個 reversal 必須引用同幣別、未被完整 reversal 的原 event。
5. Order 的 obligation snapshot 總額不超過 declared distributable basis；rounding deterministic。Reseller SupplierPayable、明示 referral CommissionObligation 與 Seller retained margin 可各自重現且不混名。
6. Refund 只反轉相應交易financial obligations，不撤銷無關 ResultEvent。
7. CareerProfile/Activity role/Guild role 永遠不能直接滿足 privileged API capability。
8. Quota exhausted 不改 User 或 Entitlement。
9. Package version 的 source ref＋manifest hash 發布後不可改。
10. Opportunity slot 不會因併發 claim 超額。
11. 每個 external webhook ID 的業務 effect 至多一次。
12. Projection 可刪除後從 canonical facts 重建成相同結果。
12a. `MemberProfessionXpProjection` 可整表刪除，並只由 append-only `ContributionRecord` 與 accepted／retracted review outcome 重建；每列含 `policy_version`、`rebuilt_from_event_seq`，三個 track 固定且不產生跨 profession total。
13. 一個 BuyerOrder 恰有一個 SellerParty／buyer-facing biller；不同 Seller 永不共用 checkout，單一 Seller 的多 Supplier 只拆 SupplyOrders。
14. 每個 sellable SellerListingRevision 都可追到 applicable QC signature、exact DistributionAcceptance、actual/effective item price schedule digest 與 active Seller collection connection；MSRP/floor 不構成自動 transition。
15. Supplier 對 future listing 的撤回不改寫已 paid BuyerOrder/SupplyOrder 的 acceptance snapshot。
16. DistributionAcceptance revoke與SupplyReservation create無競態漏洞：revoke後無新reservation，既有reservation只在TTL內可付；provider occurred time晚於TTL不形成可履約payment。
17. 每個TransferJob可追到typed SettlementInstruction、payer-owned disbursement connection、beneficiary destination、已fresh-sign的SettlementMandate、唯一bound、UsageReservation與固定provider operation key；同一period bucket的reserved＋consumed永不超cap。Mandate內deterministic transfer不逐筆重簽，只有越界才要求新A4簽名。平台ledger balance不代表平台持有款項。
17a. 依 OD-28，`record_only` 永遠可用且只顯示「已記錄」；`authorized_mandate` 同時要求 `money_movement_enabled=true`、Payer 當事人對 exact `SettlementMandate` 的 A4、Ted 對同一 digest 的付款類一鍵 A4，以及該 mandate 屬於該 Seller、active 且未超界；缺任一條件不得建立可執行 TransferJob，維持 `record_only`，商店、listing 與對帳照常。
18. 每個 A2+ Agent 外部／canonical write 可追到 principal、acting role、ExecutionGrant、ActionIntent 和 WorkItem；每個 A4 write另可追到 exact human signature。
19. 同一自然人無論使用幾個 Agent／角色，都不能同時滿足「提交者」和「獨立 reviewer」兩個人數要求。
20. Accepted ContributionRecord 不自動新增 Financial Ledger；EngagementAllocationPlan 不自動改著作權／repo ownership。ServicePayable只由accepted milestone pinned的已簽plan與明示payment trigger建立。
21. PositioningDraft／AI suggestion 不直接建立 Profession rank、paid enrollment、Entitlement、Claim 或 ExecutionGrant。
22. Person WorkContextBundle只以本人confirmed WorkIntent為`work_direction_basis`；organization bundle只以versioned organization work policy＋具名operator／acting ProfessionMembership為basis，不讀取隱藏個人定位。
23. AgentConnection token不能執行工作；只有綁同一Connection的active A0–A3 ExecutionGrant可mint短效execution token，任何Agent token都不含A4 signing authority。
24. Exclusive WorkItem最多一個WorkClaim；collaborative／competitive可依pinned capacity與期限有多個互不覆寫的WorkClaims。TaskLease到期不釋放任何人的WorkClaim。
25. 非code platform-native PR只有DraftArtifact aggregate；每個revision immutable且只可經review＋ActionIntent套用。Code的branch/PR/review/merge authority仍在GitHub。
26. 每個 LINE／Discord／document／Portal 進件先成為owner-private SubmissionDraft；external adapter只能create。只有owner／authorized organization operator可在Portal以versioned、idempotent command confirm或reject；confirmed只acknowledge saved source tuple並恰好建立一個typed draft WorkItem或private OpportunityStub，不能把external document confirm當成source verification，外部訊息永遠不構成A4或任何正式批准。
27. 每個playbook item、status與readiness都有`enforcement`；`action_gate`只准四個allowlisted gate class，`navigation`缺項不改人身、權限、rank、可發現性或一般操作。
28. `ConfirmMyOnboardingBundle`以stable keys在單一idempotent transaction建立／回傳Runner membership、WorkIntent與equipped set，全部opaque refs由response給出；任何子寫入失敗都rollback。
29. ProfessionMembership create初始永遠是`runner`；沒有`applied`、`pending_master`或Master admission approval transition。Welcome／support card沒有任何member-facing guard。
30. MemberSkillInstallation以member＋AgentConnection＋PackageVersion為scope，不能由package capability readiness、equipped set或單次AgentRun推導；fail/degraded/outdated只形成導航與WorkItem。
31. AgentConnection token只准`agent.bootstrap.read`讀本人最小Status／Feed；所有A1–A3 action仍需綁同一Connection的active ExecutionGrant。
32. Day-one standing grant至多A0–A2、至多72小時，只綁單一confirmed profession、resolved starter package與第一張low-risk WorkItem；它不是A4 artifact signature，不得引用於日後合約、付款、official QC或release。
33. `qc.review:<scope>` 只可由同 scope 的有效 `ReviewerAppointment` 產生；XP、rank、Master office、熟悉度或 Agent 都不能自動任命 reviewer。
34. Review outcome 撤回只追加歷史；retracted accepted result 不再供 XP、matching priority 或 entitlement projection 使用，原 receipt 重送固定拒絕且不得復活。
35. `review_required=true` 的 WorkItem 若沒有相應有效 reviewer capacity，candidate 仍維持 canonical `open`／published 且可領取；正交導航狀態保留穩定 ID `waiting_reviewer_capacity` 並建立 Council support card。它只影響 `official` 與 review route，不改任何人的 membership、rank、entitlement、discoverability 或 WorkItem lifecycle。
