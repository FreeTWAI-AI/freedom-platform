# First work batch

> 狀態：現行 canonical baseline（2026-09-19 低維運互惠修訂）；planning 文件，不代表已部署。

FW-01–FW-12保留；新增FW-13–FW-15併入既有package，合計15張。這些卡可在 planning workspace直接開始；不要求先建立雲端資源、外部帳號、provider key、採購或 production release。它們產生 contract／fixture／test／validator evidence，不表示 runtime 已存在。每卡 reviewer 固定為 Grok，verifier 固定為 Claude；AI checks 產生修復工作，不形成開始工作的停點。

測試命令均為將來完成卡片時的預期命令，現在**未跑**。卡片編號不取代 requirement 或 package ID。

Test stack 固定為 `python3`＋`pytest`＋`PyYAML`＋`jsonschema`（Draft 2020-12）。`x-uniqueBy`／`x-invariants` 不是 JSON Schema 關鍵字，標準 validator 不會執行；每張卡的測試必須另寫檢查明示驗證這些規則。

## 外包規則

可外包的範圍是有 contract、mock／sandbox、tests 與 AI review 邊界的 package／工作卡。不可外包的範圍是 O1 帳號建立、keys／custody、付款／法律文件／對外正式發布三類 A4、production release 與 billing。每張卡以 owner、implementation、reviewer、verifier、acceptance 五欄維持可問責性；分工皆為建議預設，五人共同閱讀確認，Ted 的 Day 1 不等這次閱讀。全局建議仍是韋銘只在非作者時擔任具名獨立 reviewer；本批卡的 implementation 是韋銘＋Codex，因此 `official reviewer（建議預設）` 改由 Mini 或 Jason 中的非作者擔任，只控制 `official` evidence。

| 欄位 | 現行規則 |
| --- | --- |
| owner | Ted、Hao、Mini、Jason、韋銘之一；每張卡只列一人（建議預設，五人共同閱讀確認） |
| implementation | 韋銘＋Codex（建議預設，五人共同閱讀確認） |
| reviewer | Grok |
| verifier | Claude |
| `official` 具名獨立 reviewer | 五人中非作者的任一人；全局建議預設韋銘只在非作者時適用，本批因韋銘持 implementation，建議預設為 Mini 或 Jason；五人共同閱讀確認。此欄只形成 `official` evidence，不取代 Grok review 或 Claude verification |
| acceptance | 每張卡的完成條件與測試／evidence；沒有 evidence 時對應標籤或 claim 為 false，工作照常 |

## FW-01 — 五種時間 invariant contract test

| field | value |
|---|---|
| 來源 requirement | RQ-061；ADR-062 |
| package ID | `FND-01`（primary）；`FND-03`, `WRK-01`, `AGT-01`, `PAY-03` 參與 |
| owner | Ted（建議預設，五人共同閱讀確認） |
| implementation | 韋銘＋Codex（建議預設，五人共同閱讀確認） |
| 輸入 | invite／claim `expires_at`、delivery `due_at`、TaskLease／lease proof 同物件的 `expires_at`＋`fencing_token`、`ExecutionGrant.expires_at`、evidence／appointment `valid_until`（`ReviewerAppointment` 用 `review_by`）的現有 contract definitions |
| 輸出 | 跨 fixture invariant tests；驗證五種時間的欄位／setter／到期後果不混用，並鎖定 TaskLease／lease proof 的 `expires_at`＋`fencing_token` 同物件語意，不做 `lease_expires_at` 雙欄名相容 |
| 允許修改路徑 | `docs/platform-plan/contracts/tests/test_five_clock_invariants.py`（新建）；`docs/platform-plan/contracts/tests/fixtures/five-clocks/`（新建） |
| 依賴 | 無；只讀既有 `contracts/**` |
| acceptance | invite／claim、delivery、lease＋fence、grant、evidence／appointment 五類各有正例、setter／expiry 邊界與「另一 clock 不能替代」負例；schema path 全部 resolve；無 runtime claim |
| 測試 | `pytest -q docs/platform-plan/contracts/tests/test_five_clock_invariants.py`（新建；未跑） |
| reviewer | Grok |
| verifier | Claude |
| official reviewer（建議預設） | Mini 或 Jason（五人共同閱讀確認）；由非作者擔任，只控制 `official` evidence |
| Ted 三類一鍵點／外部資源 | **無／無**；允許修正上述來源契約與對應測試，不執行runtime、簽名或外部副作用 |

## FW-02 — XP deterministic rebuild golden fixture

| field | value |
|---|---|
| 來源 requirement | RQ-058（XP 主引用）、RQ-060（retraction 排除次要）；ADR-059、ADR-061 |
| package ID | `FND-01`（primary）；`FND-05`, `QLT-02` 參與 |
| owner | Ted（建議預設，五人共同閱讀確認） |
| implementation | 韋銘＋Codex（建議預設，五人共同閱讀確認） |
| 輸入 | `xp-policy.schema.json`、`xp-policy.example.yaml`、append-only ContributionRecord＋accepted/retracted review semantics |
| 輸出 | ordered source-record fixture、expected `MemberProfessionXpProjection` golden、重建兩次 digest 相同的 test |
| 允許修改路徑 | `docs/platform-plan/contracts/tests/test_xp_projection_rebuild.py`（新建）；`docs/platform-plan/contracts/tests/fixtures/xp-rebuild/`（新建） |
| 依賴 | FW-01 無；現有 XP policy fixture即可開始 |
| acceptance | 三軌涵蓋；retracted outcome 被排除；同 policy/source ordering 重建 byte/digest一致；XP 未成為 entitlement/rank/appointment/A4 input |
| 測試 | `pytest -q docs/platform-plan/contracts/tests/test_xp_projection_rebuild.py`（新建；未跑） |
| reviewer | Grok |
| verifier | Claude |
| official reviewer（建議預設） | Mini 或 Jason（五人共同閱讀確認）；由非作者擔任，只控制 `official` evidence |
| Ted 三類一鍵點／外部資源 | **無／無**；只新增 `contracts/tests` 與 synthetic fixtures |

## FW-03 — 撤回後舊 receipt 拒絕的負例 fixture

| field | value |
|---|---|
| 來源 requirement | RQ-060；ADR-061；T11 |
| package ID | `QLT-02`（primary）；`FND-05` 參與 |
| owner | Mini（建議預設，五人共同閱讀確認） |
| implementation | 韋銘＋Codex（建議預設，五人共同閱讀確認） |
| 輸入 | retract OpenAPI path/problem、`review_outcome accepted → retracted`、retracted event |
| 輸出 | accepted→retracted→replay sequence fixture；固定 `receipt_superseded_by_retraction` assertion；projection rebuild expected state |
| 允許修改路徑 | `docs/platform-plan/contracts/tests/test_retracted_receipt_replay.py`（新建）；`docs/platform-plan/contracts/tests/fixtures/review-retraction/`（新建） |
| 依賴 | 無；不需真的發 event |
| acceptance | 舊 receipt 不復活 outcome；XP/matching/entitlement expected outputs 不含該 review；原 review/retraction history都保存 |
| 測試 | `pytest -q docs/platform-plan/contracts/tests/test_retracted_receipt_replay.py`（新建；未跑） |
| reviewer | Grok |
| verifier | Claude |
| official reviewer（建議預設） | Mini 或 Jason（五人共同閱讀確認）；由非作者擔任，只控制 `official` evidence |
| Ted 三類一鍵點／外部資源 | **無／無**；只新增 `contracts/tests` 與 synthetic fixtures |

## FW-04 — ReviewerAppointment 唯一授權來源測試

| field | value |
|---|---|
| 來源 requirement | RQ-059；ADR-060；OD-10；T08、T14 |
| package ID | `FND-06`（primary）；`ORG-01`, `QLT-01` 參與 |
| owner | Ted（建議預設，五人共同閱讀確認） |
| implementation | 韋銘＋Codex（建議預設，五人共同閱讀確認） |
| 輸入 | entitlement catalog、ReviewerAppointment OpenAPI/components/events/state machine |
| 輸出 | exact-scope active appointment 正例；高 XP、rank/Master、熟悉度、Agent、expired/revoked、self-review 負例 |
| 允許修改路徑 | `docs/platform-plan/contracts/tests/test_reviewer_appointment_entitlement.py`（新建）；`docs/platform-plan/contracts/tests/fixtures/reviewer-appointments/`（新建） |
| 依賴 | 無；named OD-10 holder 全用 synthetic IDs |
| acceptance | 只有 active exact-scope appointment 投影 `qc.review:<scope>`；自然人獨立性與 expiry/revoke boundary 明確 |
| 測試 | `pytest -q docs/platform-plan/contracts/tests/test_reviewer_appointment_entitlement.py`（新建；未跑） |
| reviewer | Grok |
| verifier | Claude |
| official reviewer（建議預設） | Mini 或 Jason（五人共同閱讀確認）；由非作者擔任，只控制 `official` evidence |
| Ted 三類一鍵點／外部資源 | **無／無**；只新增 `contracts/tests` 與 synthetic fixtures |

## FW-05 — Settlement mode 與 platform condition parity

| field | value |
|---|---|
| 來源 requirement | RQ-062；ADR-063；OD-28；T21 |
| package ID | `FND-04`（primary）；`PAY-03`, `PAY-04` 參與 |
| owner | Ted（建議預設，五人共同閱讀確認） |
| implementation | 韋銘＋Codex（建議預設，五人共同閱讀確認） |
| 輸入 | `PartyCommerceReadiness.money_movement_enabled`、`SettlementMandate.settlement_execution_mode`、`settlement_instruction.enqueue_transfer` guard／`create_transfer_job` effect、commerce branches |
| 輸出 | schema/example/state parity test；default record-only；platform flag=false／invalid mandate 時 zero executable TransferJob |
| 允許修改路徑 | `docs/platform-plan/contracts/tests/test_settlement_execution_modes.py`（新建）；`docs/platform-plan/contracts/tests/fixtures/settlement-modes/`（新建） |
| 依賴 | 無；provider 用 pure fake object，不連網；fake provider 介面由本卡定義並存於 `contracts/tests/fixtures/settlement-modes/`，只需支援 accept／confirm／unknown 三種回應以測 retry 與 reconcile 斷言 |
| acceptance | `record_only` 只顯示 `recorded`；authorized branch 必須同時滿足 platform flag＋active exact mandate；operation key可穩定重試 |
| 測試 | `pytest -q docs/platform-plan/contracts/tests/test_settlement_execution_modes.py`（新建；未跑） |
| reviewer | Grok |
| verifier | Claude |
| official reviewer（建議預設） | Mini 或 Jason（五人共同閱讀確認）；由非作者擔任，只控制 `official` evidence |
| Ted 三類一鍵點／外部資源 | **無／無**；不啟用 money movement、不用 provider sandbox |

## FW-06 — Work reviewer-capacity state parity

| field | value |
|---|---|
| 來源 requirement | RQ-063；ADR-064 |
| package ID | `WRK-01`（primary）；`QLT-01`, `OPP-01` 參與 |
| owner | Jason（建議預設，五人共同閱讀確認） |
| implementation | 韋銘＋Codex（建議預設，五人共同閱讀確認） |
| 輸入 | core `work_item`、agent-work example、ReviewerAppointment active/exact-scope semantics |
| 輸出 | `open`／published candidate 維持；導航 ID `waiting_reviewer_capacity`；capacity 只更新 review route／卡片／`official` evidence |
| 允許修改路徑 | `docs/platform-plan/contracts/state-machines/core.example.yaml`；`docs/platform-plan/contracts/agent-work-contract.example.yaml`；`docs/platform-plan/contracts/tests/test_work_reviewer_capacity.py`；相關synthetic fixtures；`03`／`SPEC-WRK-01`的一致性說明 |
| 依賴 | FW-04 fixture conventions（可平行，最後對齊） |
| acceptance | core/example 的 candidate lifecycle 一致維持 `open`／published 且可領；`waiting_reviewer_capacity` 僅為正交導航狀態；support card 冪等；capacity 出現只更新 review route／卡片／`official` evidence，不更改 Person membership/rank/entitlement/discoverability |
| 測試 | `pytest -q docs/platform-plan/contracts/tests/test_work_reviewer_capacity.py`（新建；未跑） |
| reviewer | Grok |
| verifier | Claude |
| official reviewer（建議預設） | Mini 或 Jason（五人共同閱讀確認）；由非作者擔任，只控制 `official` evidence |
| Ted 三類一鍵點／外部資源 | **無／無**；只新增 `contracts/tests` 與 synthetic fixtures |

## FW-07 — Execution package DAG validator

| field | value |
|---|---|
| 來源 requirement | `06 §5` package dependency map；`milestones.md` Package 依賴表 |
| package ID | `FND-01` |
| owner | Ted（建議預設，五人共同閱讀確認） |
| implementation | 韋銘＋Codex（建議預設，五人共同閱讀確認） |
| 輸入 | `execution/milestones.md` 最後的固定 dependency table；`06` package ID inventory |
| 輸出 | suffix-aware (`INT-03A/B`) validator，檢查 56 IDs、唯一主 milestone、dangling、self-edge、cycle |
| 允許修改路徑 | `docs/platform-plan/execution/tools/check_package_dag.py`（新建）；`docs/platform-plan/execution/tools/tests/test_check_package_dag.py`（新建） |
| 依賴 | 現行 `milestones.md` |
| acceptance | canonical 56 IDs exact set；目前 dependency table通過；故意加入 dangling/cycle fixture時失敗 |
| 測試 | `pytest -q docs/platform-plan/execution/tools/tests/test_check_package_dag.py`（新建；未跑） |
| reviewer | Grok |
| verifier | Claude |
| official reviewer（建議預設） | Mini 或 Jason（五人共同閱讀確認）；由非作者擔任，只控制 `official` evidence |
| Ted 三類一鍵點／外部資源 | 無／無 |

## FW-08 — M00–M02 spec-template linter

| field | value |
|---|---|
| 來源 requirement | `spec-index.md` Global cross-spec constraints；21 份現行 specs |
| package ID | `FND-01` |
| owner | Ted（建議預設，五人共同閱讀確認） |
| implementation | 韋銘＋Codex（建議預設，五人共同閱讀確認） |
| 輸入 | `execution/spec-index.md` 與 `execution/specs/*.md` |
| 輸出 | linter：index/file parity、required sections、source link、owner、milestone、`未跑` test-command wording |
| 允許修改路徑 | `docs/platform-plan/execution/tools/check_specs.py`（新建）；`docs/platform-plan/execution/tools/tests/test_check_specs.py`（新建） |
| 依賴 | 21 份 M00–M02 specs |
| acceptance | 缺 section、orphan spec、missing file或聲稱 test passed時失敗；目前 corpus通過 |
| 測試 | `pytest -q docs/platform-plan/execution/tools/tests/test_check_specs.py`（新建；未跑） |
| reviewer | Grok |
| verifier | Claude |
| official reviewer（建議預設） | Mini 或 Jason（五人共同閱讀確認）；由非作者擔任，只控制 `official` evidence |
| Ted 三類一鍵點／外部資源 | 無／無 |

## FW-09 — Portable bundle tamper/compatibility fixture

| field | value |
|---|---|
| 來源 requirement | RQ-047；ADR-049；T16 |
| package ID | `BLD-01`（primary）；`BLD-02`, `BLD-03`, `BLD-04` 參與 |
| owner | Ted（建議預設，五人共同閱讀確認） |
| implementation | 韋銘＋Codex（建議預設，五人共同閱讀確認） |
| 輸入 | `contracts/portable-activation.schema.json`、`contracts/portable-activation.example.json` 中的 bundle／source provenance／signature contracts |
| 輸出 | minimal valid bundle manifest；tampered digest、unknown major、revoked signer、host-shadow negative fixtures |
| 允許修改路徑 | `docs/platform-plan/contracts/tests/test_portable_bundle_boundaries.py`（新建）；`docs/platform-plan/contracts/tests/fixtures/portable-bundle/`（新建） |
| 依賴 | 無；簽章用 non-production test key fixture，不建 trust root |
| acceptance | valid fixture schema pass；每個 negative有固定 failure class且 zero execution assertion |
| 測試 | `pytest -q docs/platform-plan/contracts/tests/test_portable_bundle_boundaries.py`（新建；未跑） |
| reviewer | Grok |
| verifier | Claude |
| official reviewer（建議預設） | Mini 或 Jason（五人共同閱讀確認）；由非作者擔任，只控制 `official` evidence |
| Ted 三類一鍵點／外部資源 | 無／無；test key 只存在 synthetic fixture，明標不可用於 production |

## FW-10 — GitHub mock-only read semantics fixture

| field | value |
|---|---|
| 來源 requirement | RQ-024、RQ-064；ADR-065；T17 |
| package ID | `INT-03A`（primary contract/risk）；`INT-03B` 參與 |
| owner | Ted（建議預設，五人共同閱讀確認） |
| implementation | 韋銘＋Codex（建議預設，五人共同閱讀確認） |
| 輸入 | canonical read-only scope、Person-only star restrictions、source provenance requirement |
| 輸出 | synthetic GitHub responses與 expected normalized records；write/star surface absent assertions；malicious content fixture |
| 允許修改路徑 | `docs/platform-plan/contracts/tests/test_github_mock_semantics.py`（新建）；`docs/platform-plan/contracts/tests/fixtures/github-mock/`（新建） |
| 依賴 | 無；禁止真實 GitHub token/account/network |
| acceptance | read-only golden穩定；Agent write/star拒絕；外部文字不能改 grant/owner/payee；fixtures通過 secret scan |
| 測試 | `pytest -q docs/platform-plan/contracts/tests/test_github_mock_semantics.py`（新建；未跑） |
| reviewer | Grok |
| verifier | Claude |
| official reviewer（建議預設） | Mini 或 Jason（五人共同閱讀確認）；由非作者擔任，只控制 `official` evidence |
| Ted 三類一鍵點／外部資源 | 無／無；真實帳號與資源依 `08 §13` 建立，不在此卡 |

## FW-11 — BLD-05 階段 1A signed domain overlay fixture

| field | value |
|---|---|
| 來源 requirement | RQ-049（domain overlay 主引用）、RQ-047（三 CLI／signed activation）；ADR-052；T02、T06、T16；BLD-05 階段 1A／1B boundary |
| package ID | `BLD-05`（階段 1A primary）；`BLD-01`, `BLD-03`, `BLD-04`, `AGT-01`, `AGT-02` 參與 |
| owner | Ted（建議預設，五人共同閱讀確認） |
| implementation | 韋銘＋Codex（建議預設，五人共同閱讀確認） |
| 輸入 | domain overlay schema/example、runtime roots-set JCS、QC/authority/revocation/mode contract與 [BLD-05 spec](./specs/BLD-05.md) |
| 輸出 | valid overlay golden；missing/extra/reordered root、self-review、expired/revoked、host-shadow與unsupported isolation negative fixtures；只做階段 1A contract，不寫階段 1B runtime |
| 允許修改路徑 | `docs/platform-plan/execution/proposals/domain-skill-overlay-<topic>.diff`（新建）；`docs/platform-plan/contracts/tests/test_domain_skill_overlay_contract.py`（新建，只測現況）；`docs/platform-plan/contracts/tests/fixtures/domain-skill-overlay/`（新建） |
| 依賴 | FW-09 fixture/key conventions；可先建立negative cases再對齊 |
| acceptance | exact roots-set digest、2-of-N natural-Person independence、current authority/revocation與mode條件可驗；所有negative均零domain execution assertion；control activation digest不變 |
| 測試 | `pytest -q docs/platform-plan/contracts/tests/test_domain_skill_overlay_contract.py`（新建；未跑） |
| reviewer | Grok |
| verifier | Claude |
| official reviewer（建議預設） | Mini 或 Jason（五人共同閱讀確認）；由非作者擔任，只控制 `official` evidence |
| Ted 三類一鍵點／外部資源 | 無／無；canonical schema／example 變更由 AI review＋verification 檢查，不屬 Ted 三類 A4 |

## FW-12 — Retract success response proposal與 parity test

| field | value |
|---|---|
| 來源 requirement | RQ-060；ADR-061；T11；`05 §4` problem／response contract |
| package ID | `QLT-02` |
| owner | Mini（建議預設，五人共同閱讀確認） |
| implementation | 韋銘＋Codex（建議預設，五人共同閱讀確認） |
| 輸入 | current `POST /quality-reviews/{reviewId}:retract` request/error contract與 `review_outcome` state |
| 輸出 | typed success response proposal（retraction ref、original review ref、aggregate version、state）；OpenAPI/state/event parity test |
| 允許修改路徑 | `docs/platform-plan/execution/proposals/retract-success-response.diff`（新建）；`docs/platform-plan/contracts/tests/test_retract_contract_parity.py`（新建，只測現況）；`docs/platform-plan/contracts/tests/fixtures/review-retraction/`（新建） |
| 依賴 | FW-03（共享 fixture；可平行起草） |
| acceptance | 200 response不暗示原 review被刪；version可供 optimistic concurrency；schema references resolve；proposal差異單獨標示 |
| 測試 | `pytest -q docs/platform-plan/contracts/tests/test_retract_contract_parity.py`（新建；未跑） |
| reviewer | Grok |
| verifier | Claude |
| official reviewer（建議預設） | Mini 或 Jason（五人共同閱讀確認）；由非作者擔任，只控制 `official` evidence |
| Ted 三類一鍵點／外部資源 | 無／無；OpenAPI 變更由 AI review＋verification 檢查，不屬 Ted 三類 A4 |

## Ted 三類一鍵點

平台建置只有下列三類由 Ted 對 exact artifact 一鍵 A4；外部資源的完整採購與角色帳號清單見 `08 §13`。AI 先準備 exact scope、digest、cost／consequence、evidence 與 rollback，Grok review、Claude verify。

| 類別 | 本批次可能觸發的 exact scope | Ted artifact | 不受影響的工作 |
| --- | --- | --- | --- |
| 付款 | O1 平台資源、O2 角色帳號的任何實際費用；付款類 `SettlementMandate` | invoice／mandate digest／cap／currency／owner | 所有 local fixtures、contract tests、mocks；該 Seller 成員 A4 仍另行保留 |
| 法律文件 | provider terms、法務／會計 engagement、DPA 等 exact document | document digest／party／consequence | cards、tests、schemas、sandbox preparation |
| 對外正式發布 | production release、public `official` 標示 | release digest／evidence／rollback | local、candidate、staging、sandbox、內部 demo |

FW-11／FW-12 的 canonical contract 內容由 Grok＋Claude 與自動 checks 驗收，不是 Ted 人類停點。Seller listing revision、Supplier `DistributionAcceptance`、Squad `EngagementAllocationPlan`、Seller `SettlementMandate`、`ProjectRelease` approval 等成員 A4 依產品契約保留。

## 建議認領順序

先並行 FW-01、FW-02、FW-03、FW-04、FW-05、FW-09；它們都只建立本地、可重現的 contract evidence。FW-06 對齊 FW-04，FW-11 對齊 FW-09，FW-12 對齊 FW-03。FW-07／FW-08 可在任何時候加入 CI，但不宣稱 CI 已存在。

## FW-13 — 互助條款與當事人實益

- Requirement：RQ-066／RQ-071；primary WRK-01，OPP-01參與；owner沿用Jason職能分工，非新增人員。
- 修改範圍：work-participation schema／examples、agent contract、OpenAPI、event catalog、Work／Result實作與對應tests；本包只已完成planning與靜態例子，runtime待做。
- Outcome：Claim pin terms、當事人自願回報、unknown保留、回報不改QC／contribution／ledger；T27/T28。
- 真人capacity／付款承諾不得由schema fixture、AI或request的自填ref證明；必須server讀取有效來源。

## FW-14 — 容量、低維運與有界例外

- Requirement：RQ-068／RQ-069；primary WRK-01，ORG-01、Coaching、Platform參與；不增加package或runtime。
- 修改範圍：operating-policy、Work／Coaching共用capacity reservation、Notification與Results projection、tests。
- Outcome：跨模組不double-book、unknown不算零工時、核心／非核心分列、普通有界到期及保護義務；T30–T33。
- 此卡包含真正database並發／auth／notification測試；本次檔案靜態檢查不能標為已完成。

## FW-15 — 共同成果入口與真人觀察

- Requirement：RQ-067／RQ-070；primary OPP-01，People／Coaching／WRK-01參與；owner沿用現有對應職能。
- 修改範圍：既有Portal Now／Next／Gained、Squad／cohort、matching reason、pilot去識別觀察及報表；不建立新委員會。
- Outcome：三個入口、成員自願提案／續組、有界容量與可重用成果；T29、UAT-M1–M5。
- AI可協助整理觀察，不能冒充真人回饋或自動增加對外服務承諾。未取得證據維持未知。

上述新增卡沿用本檔reviewer／verifier規劃，但本次未執行Grok／Claude或任何具名真人review。產品實作與真人驗證仍未完成。
