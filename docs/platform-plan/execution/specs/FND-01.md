# SPEC-FND-01 — Canonical contract baseline

> 狀態：現行 canonical baseline（2026-09-17）；planning 文件，不代表已部署。

| 欄位 | 值 |
| --- | --- |
| Spec ID／狀態 | `SPEC-FND-01`／draft-ready |
| 所屬 milestone／原 package | M00／`FND-01` |
| Accountable role／implementation agent／AI reviewer／AI verifier | Contract Steward；owner＝Ted（建議預設，五人共同閱讀確認）／韋銘＋Codex（implementation；建議預設，五人共同閱讀確認）／Grok／Claude |
| official reviewer（建議預設） | Mini 或 Jason（五人共同閱讀確認）；implementation＝韋銘時由非作者擔任，只控制 official evidence |

## 來源與需求 ID

[`06 §4.1`](../../06-delivery-plan.md#41-foundation組織與-agent)、[`03 §§2/4/5/11`](../../03-domain-events-state-machines.md)、RQ-041/RQ-043/RQ-058/RQ-061；ADR-059/ADR-062；現行 baseline。需求追溯見 `07 §8`。

## 使用者結果與明確不包含

實作者與 consumer 能固定同一 glossary、ID、error、OpenAPI、event/state 與 XP policy contract。此 spec 不建立正式 ContractBundle、DB、API、runtime 或 production trust root。

## Actor／principal／acting role／資源範圍

Contract Steward 以 `contract_steward` role 管 planning-to-formal delta；module delegate 只 review 受影響 scope；Agent 只能在 WorkItem 允許的 contract paths 產生 diff。

## 既有 canonical entity／command／event／state／projection

只引用 [`03`](../../03-domain-events-state-machines.md) 的 vocabulary、[`openapi-outline.yaml`](../../contracts/openapi-outline.yaml)、[`event-catalog.example.yaml`](../../contracts/event-catalog.example.yaml)、[`core.example.yaml`](../../contracts/state-machines/core.example.yaml) 與 XP schema；不得在 spec 另造 User、WorkItem、Money、Contribution 或 Skill registry。

## 正常／異常／卡點／取消／補件／爭議／恢復

正常：固定 file manifest→schema/reference/example lint→cross-catalog comparison→review。異常：dangling ref、event drift、同名異義、unsupported custom format 均 fail。卡點回 Contract Steward；取消保留 diff。爭議以 ADR/RQ disposition 解決。恢復由固定 baseline 重跑產生相同結果。

## 授權／A4／independence／來源與版本綁定

Planning lint 不需 A4；breaking formal contract 或 production bundle 需受影響 Masters/release authority。作者不可冒充獨立 reviewer。輸入綁 tree digest 與每檔 SHA-256。

## 版本與獨立驗收

Additive 同 major；移除／語意改變升 major並列 consumer migration。獨立 reviewer 重算 manifest、schema/example、OpenAPI refs、events、entitlement exact-set。

## 冪等／業務唯一鍵／並發／fencing／lease／時間

同 baseline digest 重跑輸出一致；artifact identity 是 path＋bytes digest。此 package 無 runtime lease；不得把 file timestamp 當版本或驗收時間。

## UI／CLI／MCP

沒有產品 UI。Future CLI/MCP 只讀固定 ContractBundle metadata；不能讓 client 放寬 schema 或 authorization semantics。

## 隱私／憑證／資料保留與 provider 邊界

Fixtures 不含真 secret、PII、token 或可啟用簽章；驗證不需 network/provider credential。

## 成本／可觀測性／timeout／retry／reconciliation

本地 validator 成本；輸出 tool versions、file counts、hashes、duration、errors。重跑不得修改來源；catalog mismatch 必須人工 disposition。

## 遷移／相容性／rollback

Planning scaffold materialize 到 future root contracts 時須 byte/delta review；rollback 回前一 immutable bundle，不原地重寫已發布 artifact。

## Given–When–Then

- Given 固定 tree；When 兩次產生 manifest；Then path/digest 完全相同。
- Given OpenAPI dangling ref 或 event catalog 少一項；When lint；Then 非零退出且不產生 release candidate。
- Given XP fixture；When validate/rebuild-contract lint；Then三軌 closed set 且 authorization inputs 明確禁止。

## 實際測試命令（將來會這樣跑；未跑）

以下 `docs/platform-plan/contracts/tests/*.py` 均為（新建）路徑，目前尚不存在。

```bash
python -m pytest docs/platform-plan/contracts/tests/test_fnd_01_contract_baseline.py -q
python -m pytest docs/platform-plan/contracts/tests/test_event_catalog_parity.py -q
python -m pytest docs/platform-plan/contracts/tests/test_xp_policy_contract.py -q
```

以上命令對應的 repo/tests 尚不存在，**未跑**，沒有結果可報。

## 缺 evidence 時的標籤／技術依賴

Formal repo／contract source未建立；authoring source依`02 §4.6`搬入implementation repo後才能產生formal bundle。現行fixtures與checks照常。

## 完成證據

未完成。未來需 commit、validator 原始輸出、manifest、review disposition 與已知限制。
