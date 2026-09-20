# SPEC-BLD-01 — ContractBundle／FreedomPlanBundle publisher

> 狀態：現行 canonical baseline（2026-09-17）；planning 文件，不代表已部署。

| 欄位 | 值 |
| --- | --- |
| Spec ID／狀態 | `SPEC-BLD-01`／draft-ready |
| 所屬 milestone／原 package | M02／`BLD-01` |
| Accountable role／implementation agent／AI reviewer／AI verifier | Foundation & Contracts；owner＝Ted（建議預設，五人共同閱讀確認）／韋銘＋Codex（implementation；建議預設，五人共同閱讀確認）／Grok／Claude |
| official reviewer（建議預設） | Mini 或 Jason（五人共同閱讀確認）；implementation＝韋銘時由非作者擔任，只控制 official evidence |

## 來源與需求 ID

[`06 §4.1.2`](../../06-delivery-plan.md)、[`05 §2`](../../05-integration-contracts.md)、`08 §12`、RQ-043/RQ-047；ADR-049；baseline。

## 使用者結果與明確不包含

不同 publisher implementation 對 exact contracts/plan bytes產生同 digest與 immutable sidecars。不包含 production signing/channel、改寫 canonical contracts或把 planning scaffold pin 進 production。

## Actor／principal／acting role／資源範圍

Contract publisher service、Contract Steward、release authority；Agent只能對固定 source manifest build candidate。

## 既有 canonical entity／command／event／state／projection

ContractBundle/FreedomPlanBundle manifests、normalized file list/JCS digest、release sidecar；引用 portable activation schema與 `05 §2`。

## 正常／異常／卡點／取消／補件／爭議／恢復

正常：enumerate allowlisted files→normalize manifest/JCS→digest→cross implementation compare。異常：path traversal、extra/missing bytes、mutable ref、planning source in production。失敗不發布；重建從 immutable source。

## 授權／A4／independence／來源與版本綁定

Candidate build無 A4；official immutable release需 release authority exact digest。Publisher implementation與independent verifier分離。

## 版本與獨立驗收

Bundle semver；contract subtree逐 path/bytes等於 source release。兩獨立實作生成相同 digest。

## 冪等／業務唯一鍵／並發／fencing／lease／時間

Bundle ID由version＋manifest digest；同 source重跑一致。Publisher lease若有，不能改 source selection；release time不進 content digest除非 schema明定。

## UI／CLI／MCP

CLI `build/verify` future interface；MCP只讀 bundle metadata，不可選 untrusted source。

## 隱私／憑證／資料保留與 provider 邊界

Public plan/contracts不得含 secret/PII；本地 build不需 provider credential。

## 成本／可觀測性／timeout／retry／reconciliation

記 file count/bytes/digests/tool versions；重試須同 output；release registry mismatch fail closed。

## 遷移／相容性／rollback

首次 materialize formal contracts 由 Grok adversarial review＋Claude verification＋自動 checks 驗證 exact delta；對外正式發布時才由 Ted 對 exact release 執行一鍵 A4。rollback是選前一 immutable bundle，不重簽不同 bytes為同 version。

## Given–When–Then

- Given同 exact tree；When兩 publisher build；Then digests相同。
- Given extra file/path traversal；When build；Then fail且無 sidecar。
- Given planning scaffold；When production pin attempt；Then拒絕。

## 實際測試命令（將來會這樣跑；未跑）

以下 `docs/platform-plan/contracts/tests/*.py` 均為（新建）路徑，目前尚不存在。

```bash
python -m pytest docs/platform-plan/contracts/tests/test_contract_bundle_determinism.py -q
python -m pytest docs/platform-plan/contracts/tests/test_plan_bundle_byte_identity.py -q
python -m pytest docs/platform-plan/contracts/tests/test_bundle_path_safety.py -q
```

尚無 tests，**未跑**。

## 缺 evidence 時的標籤／技術依賴

Formal root contracts repo與 release policy未核對；阻塞 immutable release，不阻塞 local reference implementation。

## 完成證據

未完成；需 two-implementation outputs、manifests、release review、limitations。
