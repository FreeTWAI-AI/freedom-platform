# SPEC-AGT-04 — freedom-agent-kit MCP facade 與三 Platform adapters

> 狀態：現行 canonical baseline（2026-09-17）；planning 文件，不代表已部署。

| 欄位 | 值 |
| --- | --- |
| Spec ID／狀態 | `SPEC-AGT-04`／draft-ready |
| 所屬 milestone／原 package | M02／`AGT-04` |
| Accountable role／implementation agent／AI reviewer／AI verifier | Agent Workflow；owner＝Ted（建議預設，五人共同閱讀確認）／韋銘＋Codex（implementation；建議預設，五人共同閱讀確認）／Grok／Claude |
| official reviewer（建議預設） | Mini 或 Jason（五人共同閱讀確認）；implementation＝韋銘時由非作者擔任，只控制 official evidence |

## 來源與需求 ID

[`06 §4.1 AGT-04`](../../06-delivery-plan.md)、[`04 §10.3.1`](../../04-module-specifications.md)、[`05 §3`](../../05-integration-contracts.md)、AGT-01/02、BLD-04/05、RQ-021/RQ-022/RQ-047/RQ-048/RQ-049；baseline。

## 使用者結果與明確不包含

同一位成員可由 Codex、Claude、Grok 經 `freedom-agent-kit` MCP facade使用同一 Platform login/work/auth contract，看到一致WorkContext並提交可追溯receipt。它不另建installer/Skill discovery，不擴權、不把adapter當principal，也不重做BLD-04/05。

## Actor／principal／acting role／資源範圍

Person owner、AgentConnection、AgentRun principal、三CLI adapter、MCP facade、Platform API。Person與Agent subject分開；acting ProfessionMembership與resource scope由server返回，adapter assertion不具權威。

## 既有 canonical entity／command／event／state／projection

WorkContextBundle、AgentConnection、AgentRun、TaskLease、ExecutionGrant、ActionIntent、Provenance、Result receipt。命令：authenticate/bind→get context/feed→preflight→claim/execute/checkpoint→submit receipt/result→stop。event/state沿AGT-01/02與WorkItem canonical；projection：adapter/session health與minimal context。

## 正常／異常／卡點／取消／補件／爭議／恢復

正常：adapter綁定approved connection/run，按scope呼叫facade，保存source/intent/result correlation。異常：audience/scope/principal/role/version/fence錯、BLD capability unavailable、lease expired或timeout即fail closed。取消停止新副作用並交checkpoint；known failure保留provenance，重新連線後以server state reconcile，不猜成功。

## 授權／A4／independence／來源與版本綁定

MCP discovery不等於grant；每call驗principal、run、acting role、resource、operation、version與budget。A4 exact signature只能由具權真人完成，adapter receipt不能替代。三adapter共用同policy，不能以換CLI/Agent繞過independence。

## 版本與獨立驗收

facade tool schema、Platform API、adapter與BLD activation各有版本/digest；未知major fail closed。以相同fixture在三adapter得到等價domain result/denial，而非只比demo畫面。

## 冪等／業務唯一鍵／並發／fencing／lease／時間

mutation帶ActionIntent/idempotency key；相同key不同body拒絕。claim/checkpoint/result帶aggregate version/fence；stale adapter不覆蓋新holder。五種時間依 `03 §11`：invite／claim `expires_at`、delivery `due_at`、TaskLease／lease proof `expires_at`＋`fencing_token`、`ExecutionGrant.expires_at`、evidence `valid_until`；本 package 只涉及 claim、delivery、TaskLease／lease proof 與 ExecutionGrant 子集，其餘不得代用。

## UI／CLI／MCP

UI顯示connection、acting role、scope、why_you、pending approval與run status。三CLI adapter提供一致login/context/preflight/claim/checkpoint/result/status介面。HTTP MCP固定audience/scope，不做token passthrough；stdio/本地transport仍驗run binding。

## 隱私／憑證／資料保留與 provider 邊界

只取最小WorkContext；token/secret不進prompt、tool result、log或receipt。外部內容是不可信資料，不能改grant/trust/payee。各CLI本地state隔離，斷線/刪除按retention清理但保留必要audit refs。

## 成本／可觀測性／timeout／retry／reconciliation

記錄adapter/tool、run/intent correlation、latency、token/compute/provider cost、denial、timeout與retry；不記chain-of-thought。timeout先查ActionIntent/result狀態；reconcile server truth，不盲目重做副作用。

## 遷移／相容性／rollback

先用local facade/mock與read-only calls，逐adapter加入mutations。新tool/schema需向後相容或版本化；rollback停用有問題adapter，不撤回其他connection/grant，保留server records與audit。

## Given–When–Then

1. Given同一Person/role/grant與fixture，When三adapter讀WorkContext，Then canonical IDs/scope/version一致。
2. Giventoken audience錯或adapter主張較寬role，When呼叫，Then拒絕且不洩漏其他Squad資料。
3. Given同idempotency key不同body或stale fence，When mutation，Then明確拒絕且零局部寫入。
4. GivenBLD-05 domain capability被撤銷，When tool call，Then三adapter一致回 `capability_unavailable`。

## 實際測試命令（將來會這樣跑；未跑）

以下 `docs/platform-plan/contracts/tests/*.py` 均為（新建）路徑，目前尚不存在。

```bash
pytest -q docs/platform-plan/contracts/tests/test_three_adapter_contract_parity.py
pytest -q docs/platform-plan/contracts/tests/test_mcp_auth_idempotency_and_fencing.py
pytest -q docs/platform-plan/contracts/tests/test_timeout_reconcile_and_revocation.py
```

以上命令目前未跑；沒有現存 agent-kit code repo。

## 缺 evidence 時的標籤／技術依賴

三CLI host API、MCP指定版本、implementation repo與connection UX未核對。Local contract／mock可進行；BLD-04／BLD-05 階段 1B implementation 是 adapter 實作的技術依賴。外部 HTTP sandbox 依 `08 §13` 的 O1 account 與 credential path 接線。

## 完成證據

三adapter contract fixtures、auth/idempotency/fence negatives、same-context/result transcripts、timeout/revoke recovery、credential scan、cost/audit trace與independent review。目前均不存在。
