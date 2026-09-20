# SPEC-AGT-02 — ExecutionGrant、A4 Signature、ActionIntent 與 Provenance

> 狀態：現行 canonical baseline（2026-09-17）；planning 文件，不代表已部署。

| 欄位 | 值 |
| --- | --- |
| Spec ID／狀態 | `SPEC-AGT-02`／draft-ready |
| 所屬 milestone／原 package | M01／`AGT-02` |
| Accountable role／implementation agent／AI reviewer／AI verifier | Agent Workflow；owner＝Ted（建議預設，五人共同閱讀確認）／韋銘＋Codex（implementation；建議預設，五人共同閱讀確認）／Grok／Claude |
| official reviewer（建議預設） | Mini 或 Jason（五人共同閱讀確認）；implementation＝韋銘時由非作者擔任，只控制 official evidence |

## 來源與需求 ID

[`03 §3.14`](../../03-domain-events-state-machines.md)、[`05 §3.3.1`](../../05-integration-contracts.md)、`06 §4.1`、RQ-023/RQ-057/RQ-064；ADR-019/ADR-058/ADR-065；baseline＋GitHub AUP clarification。

## 使用者結果與明確不包含

Agent 在 bounded A0–A3 grant內工作；高後果 action 只由有權自然人簽 exact artifact。不包含 Agent A4、聊天 OK 當簽名、token passthrough、平台操弄互動或一個 grant 無限擴張。

## Actor／principal／acting role／資源範圍

Human/org principal、AgentConnection、acting ProfessionMembership、grant owner、A4 signer、ActionIntent executor；signature writer唯一為 Agent Control。

## 既有 canonical entity／command／event／state／projection

ExecutionGrant、HumanSignature、ActionIntent、authorization snapshot、WorkEvent/Provenance；A0–A4與 state/event引用 `03/05`。

## 正常／異常／卡點／取消／補件／爭議／恢復

正常：grant→intent→preflight→required A4→execute→reconcile/result。異常：wrong principal/role/audience/scope、changed digest、expired/revoked grant、stale fence、result unknown。Revoke停新 action但保留歷史。

## 授權／A4／independence／來源與版本綁定

A4 綁 type/id/revision/digest/action/consequence/signer authority。`github.star` 只有本人決定＋明示可撤 grant＋本人 Connection；平台觸發/批量/獎勵/XP 禁止。

## 版本與獨立驗收

Operation registry與grant template versioned；client不能降 A-level。獨立 reviewer驗 named actions、digest mutation、same-human/different-agent。

## 冪等／業務唯一鍵／並發／fencing／lease／時間

ActionIntent key含 principal/client/operation/target/request hash；provider operation key跨 lease stable。Grant `expires_at`、TaskLease clock分離；每次 execute重驗 current fence/version。

## UI／CLI／MCP

Portal SignaturePanel顯 exact diff/consequence；CLI/MCP只提出 signature request與執行已授權 typed command。

## 隱私／憑證／資料保留與 provider 邊界

不保存 signature secret、provider token或 chain-of-thought；provenance存 refs/hash。HTTP MCP token需固定 audience/scope且不 passthrough。

## 成本／可觀測性／timeout／retry／reconciliation

量測 grant denials、signature waits、intent outcome/result_unknown、provider reconciliation；未知結果不盲重付/重發。

## 遷移／相容性／rollback

新增 action type先 registry/review；breaking A-level change需 migration。Rollback不能讓已撤 grant/signature復活。

## Given–When–Then

- Given A2 token；When official QC/payment/release；Then要求 exact A4且零 partial write。
- Given同 key不同 body；When create intent；Then 409。
- Given revoked grant與舊 snapshot；When consequential write；Then拒絕，安全 failure report可走受限路徑。

## 實際測試命令（將來會這樣跑；未跑）

以下 `docs/platform-plan/contracts/tests/*.py` 均為（新建）路徑，目前尚不存在。

```bash
python -m pytest docs/platform-plan/contracts/tests/test_a0_a4_authorization.py -q
python -m pytest docs/platform-plan/contracts/tests/test_action_intent_idempotency.py -q
python -m pytest docs/platform-plan/contracts/tests/test_mcp_audience_scope.py -q
```

尚無 tests，**未跑**。

## 缺 evidence 時的標籤／技術依賴

HTTP MCP exact authorization implementation/provider 未核對；只阻塞 live MCP acceptance。

## 完成證據

未完成；需 registry/code、negative outputs、UI demo、security review、limitations。
