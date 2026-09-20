# SPEC-SKL-03 — MemberSkillInstallation、A1 receipt 與 remediation

> 狀態：現行 canonical baseline（2026-09-17）；planning 文件，不代表已部署。

| 欄位 | 值 |
| --- | --- |
| Spec ID／狀態 | `SPEC-SKL-03`／draft-ready |
| 所屬 milestone／原 package | M02／`SKL-03` |
| Accountable role／implementation agent／AI reviewer／AI verifier | Open Product/Agent；owner＝Ted（建議預設，五人共同閱讀確認）／韋銘＋Codex（implementation；建議預設，五人共同閱讀確認）／Grok／Claude |
| official reviewer（建議預設） | Mini 或 Jason（五人共同閱讀確認）；implementation＝韋銘時由非作者擔任，只控制 official evidence |

## 來源與需求 ID

[`06 §4.1.1/4.3 SKL-03`](../../06-delivery-plan.md)、[`03 §7.3`](../../03-domain-events-state-machines.md)、[`04 §8.5.2`](../../04-module-specifications.md)、[`member-onboarding.schema.json`](../../contracts/member-onboarding.schema.json)、RQ-056；ADR-057；baseline。階段 1B contract／fake receipt；階段 1C CLI adapter。

## 使用者結果與明確不包含

成員能看見指定Member＋AgentConnection＋PackageVersion的安裝狀態、A1 deterministic verification receipt、health/outdated與修復下一步。失敗只建立Next/help/WorkItem，不影響membership、entitlement或discoverability。不包含Skill registry lifecycle（SKL-01）、equip本身或BLD runtime activation。

## Actor／principal／acting role／資源範圍

Person member、其AgentConnection、installer/CLI adapter、Open Product/Agent steward。installation scope必須同時綁member、connection、package version；AgentRun或package capability readiness不能冒充member installation。

## 既有 canonical entity／command／event／state／projection

MemberSkillInstallation、Person/ProfessionMembership、AgentConnection、SkillPackageVersion、A1 receipt、remediation WorkItem。命令只使用 OpenAPI 既有 `startMyMemberSkillInstallation`，不另造 verb。installation 狀態閉集引用 `03 §7.3`／`04 §8.5.2` 的 `recommended|equipped|installing|verified|failed|degraded|outdated|removed`，轉移引用同處 canonical 圖。A1 receipt 結果 `pass|fail|degraded` 是驗證結果，不是 installation 狀態；projection 只呈現 canonical member-scoped status、health、outdated、Next/help。

## 正常／異常／卡點／取消／補件／爭議／恢復

正常：指定connection安裝exact version並提交deterministic receipt，server驗connection/version/fence後投影verified。異常：wrong connection/version/fence、missing evidence、known failure或outdated標明原因，不投影verified。取消保留attempt；修復可重試新attempt；failed/degraded產生可claim remediation，零人身懲罰。

## 授權／A4／independence／來源與版本綁定

本人或bounded A1 grant可啟動/回報安裝；receipt只證明該scope的verification，不授 entitlement/QC/release/A4。server綁member/connection/package exact refs與fence；client self-assertion不具權威。

## 版本與獨立驗收

PackageVersion immutable；receipt schema/adapter version明示。pass/fail/degraded/outdated fixtures可重建同projection。階段 1B skeleton／implementation 只用fake receipts；階段 1C sandbox 由三種／指定CLI adapter驗真實本地狀態，不可把階段 1B fake receipt稱為已安裝。

## 冪等／業務唯一鍵／並發／fencing／lease／時間

同member＋connection＋version＋idempotency key同body收斂同attempt/receipt；不同body拒絕。新attempt generation/fence阻止舊receipt覆蓋。五種時間依 `03 §11`：invite／claim `expires_at`、delivery `due_at`、TaskLease／lease proof `expires_at`＋`fencing_token`、`ExecutionGrant.expires_at`、evidence `valid_until`；本 package 只涉及 delivery、TaskLease／lease proof、ExecutionGrant 與 evidence 子集，其餘不得代用。Verification time、connection credential expiry 與 retention 不是 clock；outdated由version policy決定，不等於失權。

## UI／CLI／MCP

UI顯示exact version、connection、status/health、last verified、outdated reason與remediation。階段 1C CLI adapter輸出typed receipt與known failure；名稱由 implementation repo 固定。MCP只能讀/提交授權scope，不得直接寫verified projection。

## 隱私／憑證／資料保留與 provider 邊界

receipt保存digest/version/result/必要環境摘要，不含token、home path或任意檔案內容。connection credential不進fixture/log。attempt/audit按retention保留；remediation不洩漏其他member狀態。

## 成本／可觀測性／timeout／retry／reconciliation

記錄attempt/result、adapter/version、latency、failure class、retry/outdated/remediation與本地資源成本。timeout視unknown，先查receipt/attempt再重試；projector可由exact events重建。

## 遷移／相容性／rollback

階段 1B 凍結scope/state/event/receipt並建立fake fixtures，移除孤兒adoption event；階段 1C 逐adapter rollout。新receipt major需版本化。rollback停用adapter新attempt，保留install history並把未知狀態顯示degraded/needs verification，不降member權利。

## Given–When–Then

1. Given同member/connection/version與相同body，When重送receipt，Then只有一個有效attempt/result。
2. Givenwrong connection/version/fence，When提交pass receipt，Then拒絕且不投影verified。
3. Givenfailure/degraded/outdated，Whenproject，Then只顯示Next/help/WorkItem，membership/entitlement/discoverability不變。
4. Given只有equip、package capability或AgentRun，When查verified，Then結果仍不是verified installation。

## 實際測試命令（將來會這樣跑；未跑）

以下 `docs/platform-plan/contracts/tests/*.py` 均為（新建）路徑，目前尚不存在。

```bash
pytest -q docs/platform-plan/contracts/tests/test_member_installation_receipt_contract.py
pytest -q docs/platform-plan/contracts/tests/test_installation_projection_rebuild.py
pytest -q docs/platform-plan/contracts/tests/test_installation_scope_fence_negatives.py
```

以上命令目前未跑；沒有階段 1B／1C implementation。

## 缺 evidence 時的標籤／技術依賴

Receipt schema、event names與CLI host probe未 materialize；完整journey技術上依賴SKL-01、AGT-01／02與FND-05 readiness implementation。階段 1B fixtures不需外部資源；階段 1C adapter需host capability。

## 完成證據

Schema／events、四狀態fixtures、idempotency／scope／fence negatives、projection rebuild digest、階段 1C adapter transcripts、credential scan、Grok review與Claude verification。目前均不存在。
