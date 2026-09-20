# Execution spec index

> 狀態：現行 canonical baseline（2026-09-19 低維運互惠修訂）；planning 文件，不代表已部署。

狀態詞：`draft-ready`＝可交實作者細化／實作，但沒有 code／test／runtime evidence；`後續`＝只固定跨模組契約與待驗證範圍。沒有任何列是 implemented 或 verified。全表平台建置 reviewer＝Grok adversarial review，verifier＝Claude verification；產品內的自然人 `ReviewerAppointment` 語意不變。

Owner 欄保留 [`06 §4`](../06-delivery-plan.md#4-stable-work-packages) 的 Guild／職能名，並填入具名建議預設；所有分工都在五人共同閱讀時確認。來源以 canonical 章節為準。M00–M02 每個 package 都有一份檔案，M03–M09 不建立空 spec。

### 2026-09-19 運作範圍修訂

56 packages及M00–M09技術membership保留；FW-13–FW-15是既有package的工作卡增量。全形狀建置／帳號／sandbox不等於四線同步營運。首批只一種真需求互助，真人容量、雙方實益、總維持工時與資金證據決定新增對外服務承諾，詳見 `../12-low-ops-mutual-benefit.md`；不封鎖一般貢獻。所有原runtime／真人測試仍未跑。


## 執行層職能對照 `06` Owner／Accountable Squad

下表只解析 acceptance／work-card 的簡寫職能；實際 package 責任仍以 `06 §4` 該列的 Owner／Accountable Squad 為準。複合對照表示依受驗 scope 選其中的 package owner，不新增組織或人類停點。

| 執行層職能名 | `06 §4` Owner／Accountable Squad |
| --- | --- |
| Platform | Foundation；contract scope 為 Foundation & Contracts |
| Identity / Security | Foundation；Agent grant scope 為 Agent Workflow/Security |
| Work / Opportunities | Agent Workflow；opportunity scope 為 Agent/Opportunity |
| Quality / Commercialization | Open Product/QC；service/commercialization scope 為 Open Product |
| People / Identity | Talent/Agent；identity lifecycle scope 為 Foundation |
| Agent Runtime | Agent Workflow |
| Skills / Integrations | Open Product；GitHub/integration scope 為 Community & Migration |
| Build / Release | Foundation & Contracts；control/project scope 為 Open Product & Skills；runtime scope 為 Agent Workflow |
| Catalog / Commerce | Commerce/QC；store/order scope 為 Commerce |
| Payments | Commerce |
| Organizations / Guilds | Foundation；Guild lifecycle scope 為 Organization/Community |
| Product/Operations | Open Product & Skills；cross-domain status/operations scope 為 Foundation/Agent |
| Finance / Legal | package accountability 為 Commerce；專業意見形成 evidence 與工作，不取代 `06` owner |
| AI reviewer／verifier | Grok adversarial review／Claude verification；適用每份 spec 與 package |

| spec／package | owner | 來源 | milestone | 狀態／跨模組契約 |
| --- | --- | --- | --- | --- |
| [FND-01](./specs/FND-01.md) | Ted（Foundation；建議預設，五人共同閱讀時確認） | `06 §4.1`；`03 §§2/4/5/11`；contracts README | M00 | draft-ready；canonical IDs/OpenAPI/events/states/XP contract |
| [FND-02](./specs/FND-02.md) | Ted（Foundation；建議預設，五人共同閱讀時確認） | `06 §4.1`；`02 §§8/10`；`05 §§1/6` | M01 | draft-ready；PostgreSQL/outbox/inbox/job lease |
| [FND-03](./specs/FND-03.md) | Ted（Foundation；建議預設，五人共同閱讀時確認） | `06 §4.1`；`03 §3.1`；`05 §3.1` | M01 | draft-ready；User/session/ExternalIdentity/audit |
| [FND-04](./specs/FND-04.md) | Ted（Foundation；建議預設，五人共同閱讀時確認） | `06 §4.1`；`02 §8.4–8.5`；`08 §5` | M01 | draft-ready；credential/object/observability/restore |
| [FND-06](./specs/FND-06.md) | Ted（Foundation & Contracts；建議預設，五人共同閱讀時確認） | `06 §4.1/.1.1`；`01 §12`；entitlement catalog | M01 | draft-ready；八 entitlement、A4 boundary |
| [ORG-01](./specs/ORG-01.md) | Hao（Foundation／Organizations & Guilds；建議預設，五人共同閱讀時確認） | `06 §4.1`；`03 §3.1.1` | M01 | draft-ready；Guild/Profession/Rank/Office/Stewardship |
| [ORG-02](./specs/ORG-02.md) | Hao（Talent/Agent；建議預設，五人共同閱讀時確認） | `06 §4.1`；`03 §3.14` | M01 | draft-ready；equipped skills/availability/WorkIntent |
| [WRK-01](./specs/WRK-01.md) | Jason（Agent Workflow；建議預設，五人共同閱讀時確認） | `06 §4.1/.6`；`03 §7.5` | M01 | draft-ready；WorkItem/Claim/Result/capacity navigation |
| [AGT-01](./specs/AGT-01.md) | Ted（Agent Workflow；建議預設，五人共同閱讀時確認） | `06 §4.1`；`03 §3.14/7.18`；agent work contract | M01 | draft-ready；WorkContext/Connection/Run/lease/receipt |
| [AGT-02](./specs/AGT-02.md) | Ted（Agent Workflow；建議預設，五人共同閱讀時確認） | `06 §4.1`；`03 §3.14`；`05 §3.3.1` | M01 | draft-ready；ExecutionGrant/A4/ActionIntent/provenance |
| [INT-03A](./specs/INT-03A.md) | Ted（Community & Migration／GitHub organization & App；implementation＝韋銘＋Codex；建議預設，五人共同閱讀確認） | `06 §4.2`；`05 §9` | M01 | draft-ready；credential-free GitHub mocks/semantic facts |
| [BLD-01](./specs/BLD-01.md) | Ted（Foundation & Contracts；建議預設，五人共同閱讀時確認） | `06 §4.1.2`；`05 §2`；`08 §12` | M02 | draft-ready；ContractBundle/PlanBundle publisher |
| [BLD-02](./specs/BLD-02.md) | Ted（Open Product & Skills；建議預設，五人共同閱讀時確認） | `06 §4.1.2`；`08 §12` | M02 | draft-ready；control Skill/stable adapter interfaces |
| [BLD-03](./specs/BLD-03.md) | Ted（Foundation & Contracts；建議預設，五人共同閱讀時確認） | `06 §4.1.2`；portable activation contract | M02 | draft-ready；resolver/channel/signing/revocation |
| [BLD-04](./specs/BLD-04.md) | Ted（Agent Workflow；建議預設，五人共同閱讀時確認） | `06 §4.1.2`；`08 §12` | M02 | draft-ready；installer/cache/pointer/lease/three adapters |
| [BLD-05](./specs/BLD-05.md) | Ted（Agent Workflow；建議預設，五人共同閱讀時確認） | `06 §4.1.2`；domain overlay contract | M02 | draft-ready；階段 1A contract／階段 1B implementation 保留 |
| [AGT-04](./specs/AGT-04.md) | Ted（Agent Workflow；建議預設，五人共同閱讀時確認） | `06 §4.1`；`04 §10.3.1` | M02 | draft-ready；MCP facade/three Platform adapters |
| [AGT-05](./specs/AGT-05.md) | Ted（Agent Workflow/Security；建議預設，五人共同閱讀時確認） | `06 §4.1/.1.1`；`03 §7.18` | M02 | draft-ready；bootstrap read/day-one grant |
| [INT-03B](./specs/INT-03B.md) | Ted（Community & Migration／GitHub organization & App；implementation＝韋銘＋Codex；建議預設，五人共同閱讀確認） | `06 §4.2`；`05 §9` | M02 | draft-ready；GitHub App sandbox/sync |
| [SKL-01](./specs/SKL-01.md) | Ted（Open Product；建議預設，五人共同閱讀時確認） | `06 §4.3`；`04 §7`；skill schema | M02 | draft-ready；Skill manifest/registry/import candidate |
| [SKL-03](./specs/SKL-03.md) | Ted（Open Product/Agent；建議預設，五人共同閱讀時確認） | `06 §4.1.1/4.3`；member-onboarding contract | M02 | draft-ready；member-scoped installation receipt |
| AGT-03 | Ted（Agent Workflow；建議預設，五人共同閱讀時確認） | `06 §4.1`；`03 §8` | M03 | 後續；Feed/Now-Next-Gained/XP projection |
| WRK-02 | Jason（Agent Workflow；建議預設，五人共同閱讀時確認） | `06 §4.1`；`03 §3.14/7.18` | M03 | 後續；DraftArtifact revision/review/apply |
| QLT-01 | Mini（Open Product/QC；建議預設，五人共同閱讀時確認） | `06 §4.3/.6`；`04 §10.4` | M03 | 後續；protocol/appointment/QC |
| QLT-02 | Mini（Open Product/QC；建議預設，五人共同閱讀時確認） | `06 §4.3/.6`；RQ-060 | M03 | 後續；retraction/projection invalidation |
| FND-05 | Ted（Foundation/Agent；建議預設，五人共同閱讀時確認） | `06 §4.1.1`；entity-playbook contract | M04 | 後續；readiness/navigation |
| ORG-03 | Hao（Organization/Community；建議預設，五人共同閱讀時確認） | `06 §4.1.1`；`04 §8.5` | M04 | 後續；Guild lifecycle/starter |
| ONB-01 | Hao（Talent/Agent/Community；建議預設，五人共同閱讀時確認） | `06 §4.1.1`；member-onboarding contract | M04 | 後續；day-one/welcome/stuck |
| POS-01 | Hao（Talent；建議預設，五人共同閱讀時確認） | `06 §4.2`；`04 §2` | M04 | 後續；deterministic assessment parity |
| POS-02 | Hao（Talent；建議預設，五人共同閱讀時確認） | `06 §4.2`；`04 §2` | M04 | 後續；guided draft/confirmation |
| COA-01 | Hao（Talent；建議預設，五人共同閱讀時確認） | `06 §4.2`；`04 §9` | M04 | 後續；free knowledge/checkpoints |
| SKL-02 | Ted（Open Product；建議預設，五人共同閱讀時確認） | `06 §4.3`；`04 §7` | M04 | 後續；maintainer/discussion/run evidence |
| INTK-01 | Hao（Agent Workflow／Community；建議預設，五人共同閱讀確認） | `06 §4.2`；submission-intake contract | M04 | 後續；private intake/exact-source receipt |
| INT-01 | Hao（Community；建議預設，五人共同閱讀時確認） | `06 §4.2`；`05 §7` | M04 | 後續；LINE adapter |
| INT-02 | Hao（Community；建議預設，五人共同閱讀時確認） | `06 §4.2`；`05 §8` | M04 | 後續；Discord adapter |
| PRJ-01 | Ted（Open Product & Skills；建議預設，五人共同閱讀時確認） | `06 §4.1.2`；`08 §§7–12` | M05 | 後續；manifest/workflow/Pages/lifecycle |
| PRJ-02 | Ted（Foundation & Contracts；建議預設，五人共同閱讀時確認） | `06 §4.1.2`；project-status contract | M05 | 後續；A4 release/status attestation |
| OPP-01 | Jason（Agent/Opportunity；建議預設，五人共同閱讀時確認） | `06 §4.3/.6`；`04 §10.2` | M06 | 後續；private opportunity/supply owner |
| SRV-01 | Ted（Open Product service／Skills／OSS／commercialization；建議預設，五人共同閱讀確認） | `06 §4.3`；`04 §10.2` | M06 | 後續；ServiceEngagement/SOW/milestone |
| SRV-02 | Ted（Open Product service／Skills／OSS／commercialization；建議預設，五人共同閱讀確認） | `06 §4.3`；`04 §10.2` | M06 | 後續；allocation/three-human completeness |
| COA-02 | Hao（Talent；建議預設，五人共同閱讀時確認） | `06 §4.2`；`04 §9` | M06 | 後續；paid human capacity |
| CAT-01 | Mini（Commerce/QC；建議預設，五人共同閱讀時確認） | `06 §4.4`；`04 §3` | M07 | 後續；Supplier/Product/Offer/QC |
| CAT-02 | Mini（Commerce；建議預設，五人共同閱讀時確認） | `06 §4.4`；`04 §3` | M07 | 後續；arrangement/listing/guidance |
| CAT-03 | Mini（Commerce/QC；建議預設，五人共同閱讀時確認） | `06 §4.4`；`03 §7.7` | M07 | 後續；acceptance/reservation/revoke |
| STF-01 | Mini（Commerce；建議預設，五人共同閱讀時確認） | `06 §4.4`；`04 §4` | M07 | 後續；Store/Seller/BFF |
| ORD-01 | Mini（Commerce；建議預設，五人共同閱讀時確認） | `06 §4.4`；`03 §§3.7–3.8` | M07 | 後續；BuyerOrder/SupplyOrder |
| PAY-01 | Ted（Commerce／Settlement；建議預設，五人共同閱讀時確認） | `06 §4.4`；`05 §§11–12` | M07 | 後續；three connection purposes |
| PAY-02 | Ted（Commerce／Settlement；建議預設，五人共同閱讀時確認） | `06 §4.4`；`05 §12` | M07 | 後續；PaymentFact/refund/reconcile |
| PAY-03 | Ted（Commerce／Settlement；建議預設，五人共同閱讀時確認） | `06 §4.4/.6`；OD-28 | M07 | 後續；record-only/authorized mandate |
| PAY-04 | Ted（Commerce／Settlement；建議預設，五人共同閱讀時確認） | `06 §4.4/.6`；`04 §10.5` | M07 | 後續；fulfillment/reversal/dispute |
| MKT-01 | Hao（Growth；建議預設，五人共同閱讀時確認） | `06 §4.5`；`04 §5` | M08 | 後續；source-locked campaign |
| MKT-02 | Hao（Growth；建議預設，五人共同閱讀時確認） | `06 §4.5`；`05 §13` | M08 | 後續；publication/retry/metrics |
| MED-01 | Hao（Growth/Media；建議預設，五人共同閱讀時確認） | `06 §4.5`；`05 §14` | M08 | 後續；secure ingest/proposal |
| MED-02 | Hao（Growth/Media；建議預設，五人共同閱讀時確認） | `06 §4.5`；`05 §14` | M08 | 後續；render/reconcile/quota |
| ACT-01 | Hao（Community；建議預設，五人共同閱讀時確認） | `06 §4.2`；`05 §15` | M08 | 後續；Activity/Lounge strangler |
| STA-01 | Ted（Foundation/Agent；建議預設，五人共同閱讀時確認） | `06 §4.5`；`03 §8` | M09 | 後續；cross-domain rebuildable status |

## Global cross-spec constraints

- Canonical entities／states／events 不在 execution specs 另定義；只以相對連結引用 [`03`](../03-domain-events-state-machines.md)、[`04`](../04-module-specifications.md)、[`05`](../05-integration-contracts.md) 與 [`contracts/`](../contracts/README.md)。
- 所有 M00–M02 測試命令都只是 future command，明標「未跑」；目前沒有相應 tests 或 runtime。
- Repo／contract authoring source、external account、key、sandbox 與 release 都依 `02 §4.6`、`06 §6`、`08 §13` 的技術依賴與 evidence 語意執行；缺 evidence 令相應標籤或 claim 為 false，其他工作照常。

## 引用稽核表

本表將每張 FW 卡與每份 M00–M02 spec 的「來源與需求 ID」對回 `07 §3`、`07 §5`、`07 §8` 的穩定 ID；此表是 topic-match 稽核，不取代 `07` 全文。

| 卡／spec | 引用 ID → `07` 標題原文 |
| --- | --- |
| FW-01 | RQ-061 → 五種時間各自有欄位與到期語意；ADR-062 → Invite／claim、delivery、TaskLease＋fence… |
| FW-02 | RQ-058 → XP依profession與training／maintenance…；RQ-060 → Accepted review可更正撤回且舊receipt不復活；ADR-059 → XP採每profession、每track可刪除重建…；ADR-061 → Accepted review可追加retraction fact… |
| FW-03 | RQ-060 → Accepted review可更正撤回且舊receipt不復活；ADR-061 → Accepted review可追加retraction fact… |
| FW-04 | RQ-059 → v1 Reviewer任命以具名、scoped、可撤回…；ADR-060 → ReviewerAppointment是qc.review唯一取得路徑；OD-10 → 建議預設 steward：Ted＝Platform／Agent Control／Contracts、Settlement／ledger、AI Vibe／Skills／OSS；Hao＝Growth、Media、Member／Community、Talent；Mini＝Delivery PM、Product Quality／Supply、Commerce／Storefront；Jason＝Opportunity／Partnership 與 Work 流程；韋銘＝dev implementation。`official` 的具名獨立 reviewer 可由五人中任一非作者擔任，建議預設韋銘；韋銘為作者時改 Mini 或 Jason。五人共同閱讀時確認；Seller／Supplier／Skill／opportunity seed 同步建立 |
| FW-05 | RQ-062 → Seller 資金執行預設 `record_only`，`authorized_mandate` 綁平台 flag 與 exact mandate；ADR-063 → Seller settlement 有 `record_only\|authorized_mandate` 兩個 mode，`money_movement_enabled=false`；OD-28 → `money_movement_enabled=false`、每個 Seller=`record_only`；`authorized_mandate` 只在 Payer 當事人的 A4 與 Ted 付款類 A4 都位於同一 exact `SettlementMandate` digest 時可用，缺一則維持 `record_only` 且商店、listing、對帳照常；明細在 confirmed reconciliation 前只顯示「已記錄」 |
| FW-06 | RQ-063 → Review-required 工作可公開作 candidate；exact-scope reviewer capacity 控制 `official` label readiness；ADR-064 → Review-required WorkItem 保留正交 review-capacity 導航狀態 ID `waiting_reviewer_capacity`，但 capacity 不控制 candidate 是否可領 |
| FW-07 | `06 §5` package dependency map；`milestones.md` Package 依賴表 |
| FW-08 | — → 無 RQ／ADR／OD；來源為 `spec-index.md` 的 Global cross-spec constraints |
| FW-09 | RQ-047 → Codex／Claude／Grok經同一Skill與gh／wrangler操作…；ADR-049 → 日常provider control plane以gh／wrangler為主… |
| FW-10 | RQ-024 → Platform與GitHub雙向追蹤標準fork／PR／review；RQ-064 → GitHub互動只允許本人真實評價…；ADR-065 → GitHub真實本人評價與平台操弄互動明確分開 |
| FW-11 | RQ-049 → 成員接上Agent後可由domain Skills完成每日…；RQ-047 → Codex／Claude／Grok經同一Skill與gh／wrangler操作…；ADR-052 → Domain Skill runtime在階段 1A固定contract… |
| FW-12 | RQ-060 → Accepted review可更正撤回且舊receipt不復活；ADR-061 → Accepted review可追加retraction fact… |
| AGT-01 | RQ-021 → Agent讀取purpose-limited WorkContext與Daily Feed；RQ-022 → Claim、TaskLease、AgentRun與execution mode分開；RQ-048 → External document intake不搬raw bytes…；RQ-061 → 五種時間各自有欄位與到期語意；ADR-062 → Invite／claim、delivery、TaskLease＋fence… |
| AGT-02 | RQ-023 → A0–A4授權、exact signature與ActionIntent；RQ-057 → AgentConnection bootstrap read與第一天standing grant邊界一致；RQ-064 → GitHub互動只允許本人真實評價…；ADR-019 → A0讀／解釋、A1 draft／test／sandbox…；ADR-058 → AgentConnection只給agent.bootstrap.read…；ADR-065 → GitHub真實本人評價與平台操弄分開 |
| AGT-04 | RQ-021 → Agent讀取purpose-limited WorkContext與Daily Feed；RQ-022 → Claim／TaskLease／AgentRun與execution mode分開；RQ-047 → 三 CLI 同一 Skill／plan／contracts；RQ-048 → External document intake不搬raw bytes…；RQ-049 → domain Skills完成成員–Agent flows |
| AGT-05 | RQ-057 → AgentConnection bootstrap read與第一天standing grant邊界一致；ADR-058 → AgentConnection只給agent.bootstrap.read、第一天另有短效grant |
| BLD-01 | RQ-043 → 五個repos contract-first平行開發；RQ-047 → 三 CLI 同一 Skill／plan／contracts；ADR-049 → signed channel／bundle／activation operator target |
| BLD-02 | RQ-047 → Codex／Claude／Grok經同一Skill操作project lifecycle；ADR-049 → 日常provider control plane與同一signed channel |
| BLD-03 | RQ-047 → 三 CLI 同一 signed activation；ADR-049 → signed channel／pinned resolver／trust boundary |
| BLD-04 | RQ-043 → 五個repos contract-first平行開發；RQ-047 → 三 CLI 同一 signed activation；ADR-049 → installer／cache／pointer／per-run discovery |
| BLD-05 | RQ-049 → 成員接上Agent後可由domain Skills完成每日flows；RQ-047 → 三 CLI 同一 signed activation；ADR-052 → Domain Skill signed overlay階段 1A contract／階段 1B runtime |
| FND-01 | RQ-041 → Rules／config可改但歷史可重現；RQ-043 → 五個repos contract-first平行開發；RQ-058 → XP分profession／track可重建；RQ-061 → 五種時間分離；ADR-059 → XP可刪除重建read model；ADR-062 → 五clock invariant |
| FND-02 | RQ-041 → Rules／config可改但歷史可重現；RQ-043 → 五個repos contract-first平行開發 |
| FND-03 | RQ-003 → Discord／LINE／GitHub／Platform facts分工；RQ-005 → Guild縱向、Squad橫向、一人多職；RQ-039 → 會員可export／deactivate並保留必要facts |
| FND-04 | RQ-039 → export／deactivate保留必要facts；RQ-043 → contract-first／Credential Broker；RQ-045 → GitHub Organization＋Cloudflare＋managed PostgreSQL launch topology |
| FND-06 | RQ-004 → 低摩擦、零 automated compliance 阻擋；RQ-023 → A0–A4授權、exact signature與ActionIntent；RQ-059 → 自然人 Reviewer 以具名、scoped、可撤回且有 review date 的 appointment 成立；AI review 不建立 entitlement；ADR-056 → Launch entitlement 只有八個 canonical keys，與 catalog exact-set／conditions 一致，含 `store.deploy`；ADR-060 → `ReviewerAppointment` 是自然人取得 `qc.review:<scope>` 的唯一路徑；AI review 不建立該 entitlement；OD-10 → 建議預設 steward：Ted＝Platform／Agent Control／Contracts、Settlement／ledger、AI Vibe／Skills／OSS；Hao＝Growth、Media、Member／Community、Talent；Mini＝Delivery PM、Product Quality／Supply、Commerce／Storefront；Jason＝Opportunity／Partnership 與 Work 流程；韋銘＝dev implementation。`official` 的具名獨立 reviewer 可由五人中任一非作者擔任，建議預設韋銘；韋銘為作者時改 Mini 或 Jason。五人共同閱讀時確認；Seller／Supplier／Skill／opportunity seed 同步建立 |
| INT-03A | RQ-024 → Platform與GitHub雙向追蹤fork／PR／review；RQ-046 → project manifest／generated Page／canonical link |
| INT-03B | RQ-024 → Platform與GitHub雙向追蹤fork／PR／review；RQ-064 → GitHub真實本人互動／禁操弄；ADR-021 → Platform／GitHub truth boundary；ADR-065 → GitHub真實評價與平台操弄分開 |
| ORG-01 | RQ-005 → Guild縱向／Squad橫向；RQ-006 → Rank與office分開；RQ-007 → 單一stewardship／delegate；RQ-008 → 三Guild一Division；RQ-009 → commercial-ready三個不同自然人；RQ-059 → ReviewerAppointment；ADR-007/008/009/010/011 → 對應組織／rank／stewardship／Division／三人決策；ADR-060 → appointment-only；OD-10 → 首批具名holders |
| ORG-02 | RQ-010 → Deterministic定位可跳過／重做／重現；RQ-011 → Guided discovery draft須本人確認；RQ-012 → 定位後接免費Guild與可選付費人力；ADR-039/040 → optional assessment／positioning-card |
| SKL-01 | RQ-013 → 人人可提交candidate、official仍須QC；RQ-015 → GitHub skills有version／maintainers／discussion／lineage；ADR-015 → candidate／official QC分開；ADR-043 → public visibility與automation readiness分開 |
| SKL-03 | RQ-056 → 成員實裝與package readiness／equip／AgentRun分開；ADR-057 → MemberSkillInstallation aggregate／精確events |
| WRK-01 | RQ-021 → Agent讀取purpose-limited WorkContext與Daily Feed；RQ-022 → Claim、TaskLease、AgentRun與execution mode分開；RQ-063 → Review-required 工作可公開作 candidate；exact-scope reviewer capacity 控制 `official` label readiness；ADR-064 → Review-required WorkItem 保留正交 review-capacity 導航狀態 ID `waiting_reviewer_capacity`，但 capacity 不控制 candidate 是否可領 |
