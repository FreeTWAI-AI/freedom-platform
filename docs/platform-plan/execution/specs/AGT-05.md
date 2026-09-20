# SPEC-AGT-05 — agent.bootstrap.read 與 day-one bounded grant

> 狀態：現行 canonical baseline（2026-09-17）；planning 文件，不代表已部署。

| 欄位 | 值 |
| --- | --- |
| Spec ID／狀態 | `SPEC-AGT-05`／draft-ready |
| 所屬 milestone／原 package | M02／`AGT-05` |
| Accountable role／implementation agent／AI reviewer／AI verifier | Agent Workflow/Security；owner＝Ted（建議預設，五人共同閱讀確認）／韋銘＋Codex（implementation；建議預設，五人共同閱讀確認）／Grok／Claude |
| official reviewer（建議預設） | Mini 或 Jason（五人共同閱讀確認）；implementation＝韋銘時由非作者擔任，只控制 official evidence |

## 來源與需求 ID

[`06 §4.1/.1.1 AGT-05`](../../06-delivery-plan.md)、[`03 §7.18`](../../03-domain-events-state-machines.md)、[`05 §3`](../../05-integration-contracts.md)、RQ-057；ADR-058；baseline＋proposed bounded day-one template。

## 使用者結果與明確不包含

成員連上自己的Agent後，connection-only `agent.bootstrap.read`只讀本人最小Status/Feed；本人一次明示同意的`day1.learn-equip-and-claim`模板讓Agent在≤72小時、單profession、指定starter package與第一個low-risk WorkItem內preflight/equip/verify/claim/checkpoint。它不含A3/A4、付款、合約、QC、release或未指定resource。

## Actor／principal／acting role／資源範圍

Person member、其AgentConnection/Agent principal、grant issuer/authorization service。Person是同意者；Agent只能用被綁定connection與profession/resource。template不能跨Person、跨profession或擴到下一張WorkItem。

## 既有 canonical entity／command／event／state／projection

AgentConnection、AuthorizationGrant/ExecutionGrant、WorkContextBundle、ProfessionMembership、SkillPackageVersion、WorkItem/Claim、grant receipt。命令：read bootstrap→present exact template→Person consent→instantiate→preflight/equip/verify/claim/checkpoint→revoke/expire。ExecutionGrant 狀態只引用 `03 §7.18` 的 `draft/active/expired/revoked/exhausted/superseded`；projection：本人day-one可用動作與expiry。

## 正常／異常／卡點／取消／補件／爭議／恢復

正常：connection read取得最小資料；UI顯示exact scope/expiry，Person同意後原子建立bounded grant。異常：未指定resource、>72h、多profession、A3/A4/付款/QC/release operation或錯connection皆拒絕。取消/revoke後新動作停；已知未知結果按ActionIntent reconcile，不把grant receipt當完成證據。

## 授權／A4／independence／來源與版本綁定

`agent.bootstrap.read`只讀本人資料；A1–A3 mutations沒有對應grant全部拒絕。template白名單只含preflight/equip/verify/first low-risk claim/checkpoint。grant receipt不是A4 signature、review authority或membership/rank evidence。

## 版本與獨立驗收

template ID/version、profession、package version、WorkItem/resource與expiry exact-bound；未知version fail closed。驗收同時要正例完整day-one與每一 forbidden operation/resource的負例。

## 冪等／業務唯一鍵／並發／fencing／lease／時間

consent/idempotency key同body回同grant，不同body拒絕且零partial write。grant instantiation帶expected Person/connection version；revoke race fail closed。五種時間依 `03 §11`：invite／claim `expires_at`、delivery `due_at`、TaskLease／lease proof `expires_at`＋`fencing_token`、`ExecutionGrant.expires_at`、evidence `valid_until`；本 package 只涉及 claim、delivery、TaskLease／lease proof 與 ExecutionGrant 子集，其餘不得代用，且 grant ≤72h。

## UI／CLI／MCP

UI用plain language顯示可做/不可做、profession/package/WorkItem、expiry與revoke。CLI/MCP先bootstrap read，再呈 exact consent deep link；不可用文字prompt暗示已同意。每tool call仍驗operation/resource。

## 隱私／憑證／資料保留與 provider 邊界

bootstrap response只含本人最小Status/Feed，不含其他Squad私有資料。connection token不進prompt/log；grant存reference/hash與audit，不存provider secret。expiry後按retention保存必要consent/revoke證據。

## 成本／可觀測性／timeout／retry／reconciliation

記錄template/version、consent/revoke、allowed/denied operation、expiry、claim/checkpoint、cost/budget；不記敏感prompt。timeout後查grant/ActionIntent狀態；不重複consent或claim。

## 遷移／相容性／rollback

先只提供bootstrap read與synthetic template；再啟用low-risk actions。template擴scope必須新version＋新consent，不能原地擴大。rollback撤銷該version的新grant，既有歷史/audit保留。

## Given–When–Then

1. Given只有connection token，When讀本人最小Status/Feed，Then成功；When做A1–A3 mutation，Then無grant即拒絕。
2. Given合法≤72h單profession模板，When本人同意，ThenAgent只能對指定starter/first WorkItem執行白名單動作。
3. Given模板要求payment/QC/release或unspecified resource，When instantiate，Then拒絕且不建立部分grant。
4. Givengrant已revoke，When新tool call，Then停止；receipt不得被API接受成A4。

## 實際測試命令（將來會這樣跑；未跑）

以下 `docs/platform-plan/contracts/tests/*.py` 均為（新建）路徑，目前尚不存在。

```bash
pytest -q docs/platform-plan/contracts/tests/test_bootstrap_read_minimality.py
pytest -q docs/platform-plan/contracts/tests/test_day_one_grant_allowlist_and_bounds.py
pytest -q docs/platform-plan/contracts/tests/test_day_one_revoke_idempotency.py
```

以上命令目前未跑；沒有現存 tests/runtime。

## 缺 evidence 時的標籤／技術依賴

Exact low-risk WorkItem type、consent UX與connection implementation未核對。Template contract／negative fixtures可進行；AGT-01、AGT-02、ORG-02 implementation 是完整 journey 的技術依賴。不得把此卡擴成外部 Agent enrollment。

## 完成證據

template schema/fixture、minimal read field diff、allowlist/forbidden tests、idempotency/revoke races、consent UI/UAT與audit trace。目前均不存在。
