# SPEC-BLD-02 — Canonical freedom-build-system control Skill

> 狀態：現行 canonical baseline（2026-09-17）；planning 文件，不代表已部署。

| 欄位 | 值 |
| --- | --- |
| Spec ID／狀態 | `SPEC-BLD-02`／draft-ready |
| 所屬 milestone／原 package | M02／`BLD-02` |
| Accountable role／implementation agent／AI reviewer／AI verifier | Open Product & Skills；owner＝Ted（建議預設，五人共同閱讀確認）／韋銘＋Codex（implementation；建議預設，五人共同閱讀確認）／Grok／Claude |
| official reviewer（建議預設） | Mini 或 Jason（五人共同閱讀確認）；implementation＝韋銘時由非作者擔任，只控制 official evidence |

## 來源與需求 ID

[`06 §4.1.2`](../../06-delivery-plan.md)、[`08 §12`](../../08-bootstrap-hosting-project-lifecycle.md)、RQ-047；ADR-049；baseline。

## 使用者結果與明確不包含

三 CLI 看到同一 hashed control Skill routing與 stable lifecycle adapter interfaces；未提供 implementation 時明確 fail `capability_unavailable`。不包含 PRJ-01 lifecycle implementation、provider authority或任意 domain Skill execution。

## Actor／principal／acting role／資源範圍

Member Agent、control Skill publisher、adapter owner；Agent仍受 Platform grant/A4，Skill不是安全邊界。

## 既有 canonical entity／command／event／state／projection

SkillPackage/PackageVersion、control activation、stable adapters `bootstrap/new/fork/preview/release/deploy/reconcile`；引用 skill/portable activation schemas。

## 正常／異常／卡點／取消／補件／爭議／恢復

正常：validate manifest/files→resolve entrypoint→route to adapter→human stop as required。異常：missing entrypoint/path traversal/secret request/unavailable adapter。Fail closed且零 cloud write。

## 授權／A4／independence／來源與版本綁定

Skill content不授權；server/provider再驗 principal/grant/A4。Package pin exact digest/dependencies；release reviewer與author分離。

## 版本與獨立驗收

Package immutable semver；publisher-independent parser同 bytes/digest。Breaking adapter interface升 major。

## 冪等／業務唯一鍵／並發／fencing／lease／時間

Routing純 deterministic；external commands沿 ActionIntent idempotency/lease。Skill version expiry/revocation不借用 work clocks。

## UI／CLI／MCP

Codex/Claude/Grok adapters解析相同 root/name；MCP facade不是本 package。人類停點顯示 exact target/diff/consequence。

## 隱私／憑證／資料保留與 provider 邊界

Skill不含 token/trust private key；host config/credential不得複製到 package/session。

## 成本／可觀測性／timeout／retry／reconciliation

記 selected package/entrypoint/digest与 capability unavailable；provider成本只在 downstream approved action。

## 遷移／相容性／rollback

Adapter implementations可獨立升級但 pin interface；rollback回已驗 immutable package，不掃 host猜 fallback。

## Given–When–Then

- Given PRJ adapter未提供；When `release` routing；Then `capability_unavailable`且零外部 write。
- Given support file digest mismatch；When load；Then拒絕。
- Given A4 action；When Skill要求執行；Then停在 exact human approval。

## 實際測試命令（將來會這樣跑；未跑）

以下 `docs/platform-plan/contracts/tests/*.py` 均為（新建）路徑，目前尚不存在。

```bash
python -m pytest docs/platform-plan/contracts/tests/test_control_skill_manifest.py -q
python -m pytest docs/platform-plan/contracts/tests/test_adapter_unavailable_fail_closed.py -q
python -m pytest docs/platform-plan/contracts/tests/test_control_skill_human_stops.py -q
```

尚無 package/tests，**未跑**。

## 缺 evidence 時的標籤／技術依賴

Canonical Skill path／OOB trust尚無建立事實；以 `02 §4.6` authoring source 與 `08 §13` trust resources 作技術依賴。Interface contract／fixture 工作照常。

## 完成證據

未完成；需 package commit、hash manifest、three-parser outputs、security review。
