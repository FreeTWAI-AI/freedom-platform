# M00–M09 階段 bundles

> 狀態：現行 canonical baseline（2026-09-19 低維運互惠修訂）；planning 文件，不代表已部署。

M00–M09 是穩定 bundle ID，不是日期承諾；階段 membership 完全以 `06 §6` 為準且可重疊。每個 package 只有一個 unique primary bundle，其他使用處列為參與；本表 primary 只標後續 sandbox／成熟度主場，不是階段排他清單。階段 1B 依 `06 §6` 建立全 56 packages 的 skeleton，包含 unique primary 落在 M06–M09 的 19 個 packages；M01／M02 中不屬 `06 §6` 階段 1A contract／fixture 集合的 primary 工作也屬階段 1B skeleton。Owner 沿用 `06 §4`；平台建置一律由 Grok adversarial review、Claude verification 與自動 checks 驗收。產品／營運／真人測試仍待跑；契約 fixture 與本機 scoped runtime 另記，不把任何 bundle 標為完成。

### 2026-09-19 運作範圍修訂

56 packages及M00–M09技術membership保留；FW-13–FW-15是既有package的工作卡增量。全形狀建置／帳號／sandbox不等於四線同步營運。首批兩條平行驗證路徑：有限互助，以及自願作品展示／外展／商機／合作／外部實收證據；詳見 `../12-low-ops-mutual-benefit.md`。資源與容量只約束已承諾的真人服務，不阻擋一般參與或外展。產品／營運／真人測試仍待跑；契約 fixture 與本機 scoped runtime milestone 另見 `../verification/2026-09-19-revision-check.md` 與 [`2026-09-20-local-core.md`](../../releases/2026-09-20-local-core.md)。不宣稱完整 package 或 milestone 完成。

### 2026-09-24 公開會員 beta 對照

Base `8338a42` 公開會員 beta 只落在 M01（`FND-03` session／隱私、`WRK-01` 單人 claim 與實益回報）、M04（封閉定位、公會與技能書）及 M07（`CAT-01`／`STF-01` 草稿與 client read）的局部 runtime；沒有任何 bundle 因此完成，M02／M03／M05／M06／M08／M09 的主要 evidence 仍為未跑。範圍與未實作清單見 [`06 §11.3`](../06-delivery-plan.md)。


## M00 — 階段 1A：現況與契約基準

- Outcome：固定 canonical 來源、56-package inventory、scope 與 evidence 邊界。
- Scope：planning baseline、contract authoring source、requirement traceability、package／repo／runtime inventories。
- Non-goal：不宣稱 repo、runtime、外部帳號或正式 ContractBundle 已建立。
- 技術依賴／標籤：現行 tree 可讀；implementation claim 需要 repo／commit／schema／test inventory。缺 evidence 只令相應 claim 為 false。
- Owner：Ted（Foundation／`FND-01`；建議預設，五人共同閱讀時確認）。Reviewer：Grok。Verifier：Claude。
- Evidence：inventory、digests、`07 §8`；目前未跑。
- 主 packages：`FND-01`。參與：其餘 55 packages 的 inventory。

## M01 — 階段 1A：共用事實與權限契約

- Outcome：identity、organization、work、grant、event、outbox 使用同一 ID 與 transaction boundary。
- Scope：FND／ORG／WRK／AGT contracts、entitlement、credential、restore 與 GitHub deterministic mocks。
- Non-goal：不把 contract／mock 說成 provider sandbox 或功能上線。
- 技術依賴／標籤：`FND-01` contract vocabulary；repo 與 test harness 存在後才有 executable evidence。provider 或 custody evidence 只控制對應 live／`production-signed` claim。
- Owner：Ted（Foundation／Agent Control／GitHub organization & App，含 `INT-03A`）、Jason（Talent／Work）；implementation＝韋銘＋Codex。保留各 package 的 `06 §4` 職能名（建議預設，五人共同閱讀確認）。Reviewer：Grok。Verifier：Claude。
- Organization／Community owner：Hao（建議預設，五人共同閱讀確認）。
- Evidence：migration dry-run、identity isolation、idempotency、replay、five-clock negatives、restore plan；全部未跑。
- 主 packages：`FND-05`、`FND-06`、`INT-03A` 的階段 1A contract／fixture；`FND-02`、`FND-03`、`FND-04`、`ORG-01`、`ORG-02`、`WRK-01`、`AGT-01`、`AGT-02` 的階段 1B skeleton。
- 參與：`FND-01`；`ORG-03`、`ONB-01` 的階段 1A contract／fixture。

## M02 — 階段 1A：portable activation 與 Agent 契約

- Outcome：三 CLI 消費同一 signed activation，domain overlay 與 member installation 邊界固定。
- Scope：Contract／Plan bundles、resolver、signing、installer、cache、lease、overlay、Platform adapters、bootstrap grant、GitHub sandbox contract 與 Skill manifest。
- Non-goal：不把 fake key、schema pass、eligibility-only 或 mock provider 說成 production execution。
- 技術依賴／標籤：`M01` 的 FND／AGT shape；production signer、custody 與 isolation evidence 控制 `production-signed`，不停止 non-production fixtures。
- Owner：Ted（Build／Agent Control／Skills／GitHub organization & App，含 `INT-03B`）；implementation＝韋銘＋Codex。Hao 的 integration 營運 admin 只適用 `INT-01`／`INT-02`。保留各 package 的 `06 §4` 職能名（建議預設，五人共同閱讀確認）。Reviewer：Grok。Verifier：Claude。
- Evidence：same activation digest、three-CLI logs、negative fixtures、revoke→`capability_unavailable`；全部未跑。
- 主 packages：`BLD-01`、`BLD-02`、`BLD-03`、`BLD-04`、`BLD-05`、`AGT-05`、`SKL-03` 的階段 1A contract／fixture；`AGT-04`、`INT-03B`、`SKL-01` 的階段 1B skeleton。
- 參與：`FND-02`、`FND-03`、`AGT-01`、`AGT-02` 的階段 1B skeleton；`PRJ-01` 的階段 1A mock／contract。

## M03 — 階段 1B：工作、驗收與有效成果 skeleton

- Outcome：claim、執行、補件、review、retraction 與 projection rebuild 不依賴聊天補狀態。
- Scope：Feed／XP、non-code Draft／Diff／Review／Apply、ReviewerAppointment、QualityReview／retraction。
- Non-goal：AI review 不建立產品 `ReviewerAppointment`；獨立自然人不足只令 `official=false`。
- 技術依賴／標籤：`M01` work／organization facts；`QLT-02` 依賴 `QLT-01` 與 `SKL-01` contracts。
- Owner：Jason（Agent Workflow）、Mini（Open Product/QC）（建議預設，五人共同閱讀時確認）。Reviewer：Grok。Verifier：Claude。
- Evidence：正常／補件／拒絕／retraction／old-receipt replay、XP rebuild parity、independence negatives；全部未跑。
- 主 packages：`AGT-03`、`WRK-02`、`QLT-01`、`QLT-02`。
- 參與：`WRK-01`、`ORG-01`、`SKL-01`。

## M04 — 階段 1B：Guild 與完整首日旅程 skeleton

- Outcome：新人自助加入既有 Guild、裝備／驗證、做第一件事並理解 Gained／Next。2026-09-23 起新註冊須先完成封閉定位並自行確認公會（Ted 明示 override 原「可跳過定位」）；既有會員不被重新封鎖。
- Scope：readiness、Guild lifecycle、onboarding、positioning、coaching、starter Skill、intake、LINE／Discord ports。
- Non-goal：不把 welcome、private channel、installation、stuck 或 connector 變成人身條件；不自動建立新 Guild。
- 技術依賴／標籤：`M01`；installation contract 來自 `M02`。三類 supply owner evidence 只控制 `supply-ready`。
- Owner：Jason（Talent，含 `ONB-01`、`POS-01`、`POS-02`、`COA-01`，以及參與 package `ORG-02`／`WRK-01` 的 Talent／Work 責任）、Ted（Skills）；保留各 package 的 `06 §4` 職能名（建議預設，五人共同閱讀確認）。Reviewer：Grok。Verifier：Claude。
- Community／`INTK-01` owner：Hao（建議預設，五人共同閱讀確認）。
- Evidence：positioning（既有會員相容與新註冊必填）、multi-Guild、no-CLI path、outage fallback、support cards、supply fixtures；全部未跑。
- 主 packages：`ORG-03`、`ONB-01`、`POS-01`、`POS-02`、`COA-01`、`SKL-02`、`INTK-01`、`INT-01`、`INT-02`。
- 參與：`FND-05`、`ORG-01`、`ORG-02`、`WRK-01`、`AGT-05`、`SKL-03`。

## M05 — 階段 1B：共同開發與 project lifecycle skeleton

- Outcome：WorkItem→Issue／PR→AI review→Result→release evidence 使用同一 contract；human-independent evidence 另投影標籤。
- Scope：project manifest、CandidateProvenance、release approval、status attestation、dogfood。
- Non-goal：單一人或多個 Agent 不算多個自然人；fork 不繼承 `official`。
- 技術依賴／標籤：`M01`、`M02`；GitHub sandbox 需要 `INT-03B` connection，status attestation 需要 `QLT-01` shape。獨立人類 evidence 只控制 `official`。
- Owner：Ted（Open Product & Skills／Foundation & Contracts），Jason 負責 Project／Work 日常協調（建議預設，五人共同閱讀時確認）。Reviewer：Grok。Verifier：Claude。
- Evidence：WorkItem→PR→checks→Result→exact release approval→Contribution、fail-closed status；全部未跑。
- 主 packages：`PRJ-01`、`PRJ-02`。
- 參與：`INT-03A`、`INT-03B`、`BLD-02`、`BLD-04`、`BLD-05`、`WRK-01`、`AGT-02`、`AGT-04`、`QLT-01`。

## M06 — 階段 1C：Squad 與 service sandbox slice

- Outcome：需求形成 Vibe／Field／Project Squad，scope、acceptance、退出、支援與 allocation 可追溯。
- Scope：Opportunity、CommercialEdition、ServiceEngagement、SOW、milestone、allocation、paid coaching capacity。
- Non-goal：不強制平台金流、不把 community QC 變付費認證、不由 Contribution 推算 payable。
- 技術依賴／標籤：`M03` work／quality 與 `M04` intake／people journey；三個不同自然人 evidence 只控制 `commercial-ready`。
- Owner：Ted（`SRV-01`／`SRV-02` 的 Skills／OSS／commercialization steward）、Jason（`OPP-01`、`COA-02` 與 WRK 日常派卡）；Mini 是 `commercial-ready` 的 Project 產品角色，不是 package owner。以上為建議預設，五人共同閱讀確認。Reviewer：Grok。Verifier：Claude。
- Evidence：accepted intake、signed SOW、成員 `EngagementAllocationPlan` exact A4、change／withdraw／support、無 payable negatives；全部未跑。
- 主 packages：`OPP-01`、`SRV-01`、`SRV-02`、`COA-02`。
- 參與：`ORG-01`、`WRK-01`、`AGT-02`、`QLT-01`、`QLT-02`、`SKL-01`。

## M07 — 階段 1C：商品與非託管商業 sandbox

- Outcome：單一 Seller 的商品在 sandbox 完成上架、下單、履約、退款與對帳；資金預設 `record_only`。
- Scope：catalog、acceptance、reservation、Store、Order、payment facts、settlement modes、reversal。
- Non-goal：平台不是收款主體，不建 wallet／escrow；sandbox 不代表 live。
- 技術依賴／標籤：`M03` QC、`M01` credential contracts、Seller-owned connection。`authorized_mandate` 需要 Payer 當事人（reseller 情境下通常即 Seller）的成員 A4 與 Ted 付款類一鍵 A4 位於同一 exact digest；缺一仍可做 store／listing／reconciliation。
- Owner：Mini（Commerce/QC／Commerce）、Ted（Settlement／ledger）（建議預設，五人共同閱讀時確認）。Reviewer：Grok。Verifier：Claude。
- Evidence：one-Seller／multi-Supplier、price snapshot、payment fact、timeout reconcile、refund、record-only、dual-A4 mandate；全部未跑。
- 主 packages：`CAT-01`、`CAT-02`、`CAT-03`、`STF-01`、`ORD-01`、`PAY-01`、`PAY-02`、`PAY-03`、`PAY-04`。
- 參與：`FND-04`、`AGT-02`、`QLT-01`。

## M08 — 階段 1C：growth、media 與 community sandbox

- Outcome：approved source 在 sandbox 完成 campaign／media flow；Lounge 接續不另造會員真相。
- Scope：fact-locked content、publication／retry、media ingest／render、Activity／Lounge strangler。
- Non-goal：不自動刷外部互動、不集中客戶 raw media、不把 provider accepted 說成 delivered。
- 技術依賴／標籤：`M02` Agent boundary、`M04` connectors、`M07` catalog source；provider connection 存在後才可真接，local fixtures 照常。
- Owner：Hao（Growth／Growth/Media／Community）（建議預設，五人共同閱讀時確認）。Reviewer：Grok。Verifier：Claude。
- Evidence：source lock、member／Ted 適用的 exact A4、timeout reconcile、quota、MIME／SSRF negatives、Lounge outage；全部未跑。
- 主 packages：`MKT-01`、`MKT-02`、`MED-01`、`MED-02`、`ACT-01`。
- 參與：`SKL-01`、`CAT-02`、`AGT-02`、`FND-04`、`INT-02`。

## M09 — 階段 2：垂直細節與發布成熟度

- Outcome：四循環、八模組在 production-like 環境可重複運作，非作者能依 runbook restore／revoke／reconcile，公開 claim 與 evidence 一致。
- Scope：cross-domain Now／Next／Gained、T01–T26、AI scenario checks、restore／rotation、release／rollback／support handoff。
- Non-goal：不是第一次整合；不承諾日期、規模或 production 已上線。
- 技術依賴／標籤：M01–M08 的 in-scope contracts、resources 與 evidence；Ted 只對 exact 對外正式 release A4。`official`、`production-signed`、`commercial-ready`、`recovery`、`SLO` 分別依 evidence 投影。
- Owner：Ted（Foundation/Agent／`STA-01`）＋各 package 建議預設 owner；Mini 負責 milestone／spec-index／acceptance-matrix stewardship（建議預設，五人共同閱讀時確認）。Reviewer：Grok。Verifier：Claude。
- Evidence：`acceptance-matrix.md` 的實際輸出、restore／rebuild／key-revoke consistency、known limitations；全部未跑。
- 主 packages：`STA-01`。參與：其餘 55 packages。

## Package 主 bundle 清單

| bundle | 階段 | primary packages |
| --- | --- | --- |
| M00 | 1A | FND-01 |
| M01 | 1A contract／fixture＋1B skeleton | FND-02, FND-03, FND-04, FND-05, FND-06, ORG-01, ORG-02, WRK-01, AGT-01, AGT-02, INT-03A |
| M02 | 1A contract／fixture＋1B skeleton | BLD-01, BLD-02, BLD-03, BLD-04, BLD-05, AGT-04, AGT-05, INT-03B, SKL-01, SKL-03 |
| M03 | 1B | AGT-03, WRK-02, QLT-01, QLT-02 |
| M04 | 1B | ORG-03, ONB-01, POS-01, POS-02, COA-01, SKL-02, INTK-01, INT-01, INT-02 |
| M05 | 1B | PRJ-01, PRJ-02 |
| M06 | 1C | OPP-01, SRV-01, SRV-02, COA-02 |
| M07 | 1C | CAT-01, CAT-02, CAT-03, STF-01, ORD-01, PAY-01, PAY-02, PAY-03, PAY-04 |
| M08 | 1C | MKT-01, MKT-02, MED-01, MED-02, ACT-01 |
| M09 | 2 | STA-01 |

## Package 依賴表

第二欄只列 `06 §5` 的無條件技術依賴，用於 cycle／dangling 檢查；第三欄只記特定 runtime 或 sandbox slice 的技術依賴，不納入硬 DAG。`STA-01` 的 cross-domain sources 由 contracts／events 驅動，不擴寫成額外硬邊。

| package | depends_on | conditional_runtime_deps／註記 |
| --- | --- | --- |
| FND-01 | 無 | — |
| FND-02 | FND-01 | — |
| FND-03 | FND-01, FND-02 | — |
| FND-04 | FND-02 | — |
| FND-05 | FND-01, FND-02, WRK-01 | — |
| FND-06 | FND-01 | — |
| ORG-01 | FND-03 | — |
| ORG-02 | ORG-01 | — |
| ORG-03 | ORG-01, ORG-02, FND-05 | — |
| WRK-01 | FND-02, FND-03, ORG-01 | — |
| AGT-01 | WRK-01 | — |
| AGT-02 | AGT-01 | — |
| AGT-03 | ORG-02, AGT-02 | — |
| AGT-04 | AGT-01, AGT-02, BLD-04, BLD-05 | — |
| AGT-05 | AGT-01, AGT-02, ORG-02 | — |
| WRK-02 | WRK-01, AGT-02 | — |
| ONB-01 | FND-05, ORG-03, SKL-03, AGT-05, WRK-01 | — |
| BLD-01 | FND-01 | — |
| BLD-02 | BLD-01 | — |
| BLD-03 | BLD-01, BLD-02 | — |
| BLD-04 | BLD-03 | — |
| BLD-05 | BLD-01, BLD-03, BLD-04 | signed isolated execution：FND-02, FND-03, AGT-01, AGT-02 |
| PRJ-01 | FND-01, BLD-02, INT-03A | sandbox completion：INT-03B |
| PRJ-02 | PRJ-01, FND-02, FND-04, AGT-02, QLT-01 | — |
| POS-01 | FND-01, FND-02, FND-03 | — |
| POS-02 | POS-01 | — |
| COA-01 | POS-02, ORG-01, WRK-01 | — |
| COA-02 | COA-01, SRV-01 | — |
| INTK-01 | FND-02, FND-03, WRK-01, AGT-01 | — |
| INT-01 | FND-03, FND-04, INTK-01 | — |
| INT-02 | FND-03, FND-04, ORG-01, INTK-01 | — |
| INT-03A | FND-01 | — |
| INT-03B | FND-03, FND-04, WRK-01, INT-03A | — |
| ACT-01 | FND-02, FND-03, INT-02 | — |
| SKL-01 | FND-01, INT-03B | — |
| SKL-02 | SKL-01, INT-02 | — |
| SKL-03 | SKL-01, AGT-01, AGT-02, FND-05 | — |
| QLT-01 | FND-01, FND-02, WRK-02, ORG-01 | — |
| QLT-02 | QLT-01, SKL-01 | — |
| SRV-01 | SKL-01, WRK-01 | — |
| SRV-02 | SRV-01, ORG-01, AGT-02 | — |
| OPP-01 | WRK-01, ORG-01 | — |
| CAT-01 | FND-02, FND-03, QLT-01 | — |
| CAT-02 | CAT-01 | — |
| CAT-03 | CAT-02, AGT-02 | — |
| STF-01 | CAT-03, FND-01 | — |
| ORD-01 | STF-01 | — |
| PAY-01 | FND-04, ORD-01 | — |
| PAY-02 | PAY-01 | — |
| PAY-03 | PAY-02, AGT-02 | — |
| PAY-04 | PAY-03 | — |
| MKT-01 | SKL-01, CAT-02 | — |
| MKT-02 | MKT-01, AGT-02, FND-04 | — |
| MED-01 | FND-04 | — |
| MED-02 | MED-01, MKT-01 | — |
| STA-01 | 無 | cross-domain event consumers |

自查標準：56 rows；每個 dependency 都是上述 package ID；不得有 self-edge、dangling 或 cycle。條件式欄不納入硬 DAG，但不得把缺少 runtime evidence 說成 sandbox 或 production 已完成。
