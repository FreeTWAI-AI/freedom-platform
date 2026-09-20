# SPEC-BLD-03 — Deterministic channel publisher與 revocation

> 狀態：現行 canonical baseline（2026-09-17）；planning 文件，不代表已部署。

| 欄位 | 值 |
| --- | --- |
| Spec ID／狀態 | `SPEC-BLD-03`／draft-ready |
| 所屬 milestone／原 package | M02／`BLD-03` |
| Accountable role／implementation agent／AI reviewer／AI verifier | Foundation & Contracts；owner＝Ted（建議預設，五人共同閱讀確認）／韋銘＋Codex（implementation；建議預設，五人共同閱讀確認）／Grok／Claude |
| official reviewer（建議預設） | Mini 或 Jason（五人共同閱讀確認）；implementation＝韋銘時由非作者擔任，只控制 official evidence |

## 來源與需求 ID

[`06 §4.1.2`](../../06-delivery-plan.md)、portable activation schema、`08 §§12–13`、RQ-047；ADR-049；baseline。

## 使用者結果與明確不包含

Immutable registry snapshot產生 exact dependency closure、monotonic channel/index與 current revocation；quorum失效 fail closed。不包含把 fake signatures當 production、單 signer降級或建立真 key/KMS。

## Actor／principal／acting role／資源範圍

No-key coordinator、Signer A/B、offline custodian、release authority；每 runtime只接一把 non-exportable key與 read-only journal view。

## 既有 canonical entity／command／event／state／projection

RegistrySnapshot/Channel/BootstrapIndex/RevocationSnapshot/KeyPolicy/closure/bundle digests；沿 portable activation contract。

## 正常／異常／卡點／取消／補件／爭議／恢復

正常：pin registry→resolve exact closure→candidate digest→2-of-N sign→publish index/revocation。異常：range/cycle/conflict、journal fork、old head、revoked key/package、quorum outage。恢復靠 offline key rotation/OOB root。

## 授權／A4／independence／來源與版本綁定

Release authority核准 exact candidate；coordinator無 key，兩 signer不同 admin/deploy/custodian。Agent不能選 trust root/channel。

## 版本與獨立驗收

Monotonic sequence、active policy/transition chain、TTL固定；獨立 verifier 重算 signature/JCS/closure/current heads。

## 冪等／業務唯一鍵／並發／fencing／lease／時間

同 sequence只能一 candidate digest；signer durable high-water防 rollback/equivocation。300/900 秒 TTL各自判定，不延借 grant/lease。

## UI／CLI／MCP

Publisher CLI build/sign/verify候選；client只 consume signed artifacts。MCP無 signing/private-key surface。

## 隱私／憑證／資料保留與 provider 邊界

Private keys non-exportable/isolated；fixtures只 fake/test key。Journal append-only，logs不含 signing secret。

## 成本／可觀測性／timeout／retry／reconciliation

觀測 quorum latency、high-water、expiry、revocation freshness、signer health；timeout不降 threshold。

## 遷移／相容性／rollback

Key rotation cross-signed；rollback也須明示 signed policy且不得低於 minimum/current revocation。

## Given–When–Then

- Given registry簽後新增版本；When activate；Then closure/digest不變。
- Given一 signer失聯；When TTL到；Then新 activation fail closed，不單簽。
- Given revoked key/package；When fresh install；Then拒絕且不掃 cache fallback。

## 實際測試命令（將來會這樣跑；未跑）

以下 `docs/platform-plan/contracts/tests/*.py` 均為（新建）路徑，目前尚不存在。

```bash
python -m pytest docs/platform-plan/contracts/tests/test_deterministic_dependency_resolver.py -q
python -m pytest docs/platform-plan/contracts/tests/test_publisher_quorum_fail_closed.py -q
python -m pytest docs/platform-plan/contracts/tests/test_channel_revocation_rotation.py -q
```

尚無 implementation/tests，**未跑**。

## 缺 evidence 時的標籤／技術依賴

Production KMS／runtime／custodian／OOB root 未核對；non-production fixtures可做，缺 evidence 時 `production-signed=false` 且不得宣稱 production trust。

## 完成證據

未完成；需 independent implementations、signature outputs、quorum/rotation drill、limitations。
