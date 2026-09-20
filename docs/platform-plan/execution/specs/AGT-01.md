# SPEC-AGT-01 — WorkContext、AgentConnection、AgentRun、TaskLease 與 source receipt

> 狀態：現行 canonical baseline（2026-09-17）；planning 文件，不代表已部署。

| 欄位 | 值 |
| --- | --- |
| Spec ID／狀態 | `SPEC-AGT-01`／draft-ready |
| 所屬 milestone／原 package | M01／`AGT-01` |
| Accountable role／implementation agent／AI reviewer／AI verifier | Agent Workflow；owner＝Ted（建議預設，五人共同閱讀確認）／韋銘＋Codex（implementation；建議預設，五人共同閱讀確認）／Grok／Claude |
| official reviewer（建議預設） | Mini 或 Jason（五人共同閱讀確認）；implementation＝韋銘時由非作者擔任，只控制 official evidence |

## 來源與需求 ID

[`03 §3.14/7.18/11`](../../03-domain-events-state-machines.md)、agent work contract、`06 §4.1`、RQ-021/RQ-022/RQ-048/RQ-061；ADR-062；baseline＋five-clock clarification。

## 使用者結果與明確不包含

本人 Agent 取得最小 context、在人的 Claim 上執行、交回可追溯成功/失敗 receipt。不包含 Agent 成為 principal/reviewer、receipt 證明品質/A4或 server attestation remote bytes。

## Actor／principal／acting role／資源範圍

Human/org principal、approved AgentConnection、one acting ProfessionMembership、human-owned Claim、short TaskLease。Server derivation優先於 client assertions。

## 既有 canonical entity／command／event／state／projection

WorkContextBundle、AgentConnection、AgentRun、TaskLease、source requirements/receipt、run states/events；引用 `03`/agent contract/OpenAPI。

## 正常／異常／卡點／取消／補件／爭議／恢復

正常：device approval→minimal context→run/lease→local exact source verify→receipt/result。異常：wrong connection/version/fence、source unavailable/digest mismatch、lease expiry、result unknown。Known failure保留 provenance且零 consequential effect。

## 授權／A4／independence／來源與版本綁定

Connection token只有 bootstrap read；執行另需 AGT-02 grant。Agent receipt不是 A4/review。Run pin context hash、control activation、domain roots、source refs。

## 版本與獨立驗收

Contract versions明列，未知 scalar用 null、sets用空陣列。獨立 reviewer從同 fixture核對 context minimization與 receipt/fence negatives。

## 冪等／業務唯一鍵／並發／fencing／lease／時間

Run/create/receipt idempotent；TaskLease `expires_at`＋monotonic fence同物件。A.1 已撤回 `lease_expires_at` rename；不可重提為無 migration 的 breaking change。

## UI／CLI／MCP

Portal核准/revoke connection；CLI/MCP 讀同一 WorkContext/claim/run API，不接受 client 指定 principal/runtime mode/overlay。

## 隱私／憑證／資料保留與 provider 邊界

不保存 chain-of-thought、raw private document、long-lived secret；只存 refs/hash/redacted receipt。

## 成本／可觀測性／timeout／retry／reconciliation

觀測 run/lease、source failure、tool/provider版本、result_unknown；timeout先 reconcile，不重複 consequential action。

## 遷移／相容性／rollback

AgentRun schema additive；lease field保留既有 `expires_at`。Migration pin contract version；rollback不刪 provenance。

## Given–When–Then

- Given source digest mismatch；When Agent提交 success；Then run fail/provenance retained/零 effect。
- Given stale fence；When receipt/result write；Then拒絕且人的 Claim仍在。
- Given同人兩 Agent；When independence check；Then不能互相成獨立 reviewer。

## 實際測試命令（將來會這樣跑；未跑）

以下 `docs/platform-plan/contracts/tests/*.py` 均為（新建）路徑，目前尚不存在。

```bash
python -m pytest docs/platform-plan/contracts/tests/test_work_context_minimization.py -q
python -m pytest docs/platform-plan/contracts/tests/test_task_lease_fencing.py -q
python -m pytest docs/platform-plan/contracts/tests/test_source_bound_receipts.py -q
```

尚無 tests，**未跑**。

## 缺 evidence 時的標籤／技術依賴

CLI/client actual versions與 repo 未核對；阻塞 adapter live acceptance，不阻塞 contract fixtures。

## 完成證據

未完成；需 code commit、three-client fixtures、test output、security review、limitations。
