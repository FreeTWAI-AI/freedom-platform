# SPEC-INT-03A — GitHub contract、semantic facts 與 deterministic mocks

> 狀態：現行 canonical baseline（2026-09-17）；planning 文件，不代表已部署。

| 欄位 | 值 |
| --- | --- |
| Spec ID／狀態 | `SPEC-INT-03A`／draft-ready |
| 所屬 milestone／原 package | M01／`INT-03A` |
| Accountable role／implementation agent／AI reviewer／AI verifier | Community & Migration／GitHub organization & App；owner＝Ted（建議預設，五人共同閱讀確認）／韋銘＋Codex（implementation；建議預設，五人共同閱讀確認）／Grok／Claude |
| official reviewer（建議預設） | Mini 或 Jason（五人共同閱讀確認）；implementation＝韋銘時由非作者擔任，只控制 official evidence |

## 來源與需求 ID

[`05 §9`](../../05-integration-contracts.md)、[`06 §4.2`](../../06-delivery-plan.md)、`08 §§7–12`、RQ-024/RQ-046；baseline。

## 使用者結果與明確不包含

沒有 GitHub credential 也能固定 repo/fork/PR/release semantic contracts與亂序/重送 fixtures。不包含 live GitHub App、org/ruleset、真 webhook 或 official status。

## Actor／principal／acting role／資源範圍

Mock GitHub provider、integration adapter、human contributor/maintainer refs；fixture不能成真 identity/authority。

## 既有 canonical entity／command／event／state／projection

RepositoryBinding、ExternalRef、WebhookInbox、WorkItem↔Issue/PR/Result refs、CandidateProvenance/release facts；沿用 `05/08`。

## 正常／異常／卡點／取消／補件／爭議／恢復

正常：fixture webhook→verify/dedupe→normalized semantic fact。異常：rename/transfer/private/delete、fork, PR close/reopen、out-of-order/replay、same version different hash。Gap/reconcile 回 authoritative mock query。

## 授權／A4／independence／來源與版本綁定

Mock 不授權 merge/release；official/release仍需独立 reviewer/A4。Fixture pin stable repository ID/full SHA，不信 display URL/name。

## 版本與獨立驗收

Provider fixture/version固定；independent reviewer從 clean local mock重播並比對 facts/dedupe。

## 冪等／業務唯一鍵／並發／fencing／lease／時間

Delivery ID＋tenant unique；同 delivery不同 body拒絕；provider occurred time只作 evidence，不替代五時鐘。

## UI／CLI／MCP

無 user UI；future adapter CLI/MCP只對 mock endpoint，不能讀 host `gh` credential。

## 隱私／憑證／資料保留與 provider 邊界

全 fake IDs/tokens；不含 private repo bytes、PAT或真 user data。

## 成本／可觀測性／timeout／retry／reconciliation

本地零 provider cost；記 fixture case、attempt、normalized fact、dedupe/reconcile outcome。

## 遷移／相容性／rollback

Live adapter必須通過同 fixtures；provider semantic change加新 fixture/version，不覆寫 golden。

## Given–When–Then

- Given rename webhook後舊 URL事件；When replay/query；Then stable repo ID收斂。
- Given duplicate/out-of-order PR events；When consume；Then最終 state一致且無重複 Result。
- Given fork自報 official；When semantic check；Then固定 unmanaged/not-official。

## 實際測試命令（將來會這樣跑；未跑）

以下 `docs/platform-plan/contracts/tests/*.py` 均為（新建）路徑，目前尚不存在。

```bash
python -m pytest docs/platform-plan/contracts/tests/test_contract_mock.py -q
python -m pytest docs/platform-plan/contracts/tests/test_webhook_replay_order.py -q
python -m pytest docs/platform-plan/contracts/tests/test_repo_fork_semantics.py -q
```

尚無 tests，**未跑**。

## 缺 evidence 時的標籤／技術依賴

GitHub current official API behavior/sandbox 未核對；不阻塞 deterministic mock，阻塞 INT-03B live acceptance。

## 完成證據

未完成；需 mock code、goldens、test outputs、semantic matrix、limitations。
