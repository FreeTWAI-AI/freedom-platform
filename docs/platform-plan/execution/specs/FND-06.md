# SPEC-FND-06 — Entitlement catalog 與 A4 boundary

> 狀態：現行 canonical baseline（2026-09-17）；planning 文件，不代表已部署。

| 欄位 | 值 |
| --- | --- |
| Spec ID／狀態 | `SPEC-FND-06`／draft-ready |
| 所屬 milestone／原 package | M01／`FND-06` |
| Accountable role／implementation agent／AI reviewer／AI verifier | Foundation & Contracts；owner＝Ted（建議預設，五人共同閱讀確認）／韋銘＋Codex（implementation；建議預設，五人共同閱讀確認）／Grok／Claude |
| official reviewer（建議預設） | Mini 或 Jason（五人共同閱讀確認）；implementation＝韋銘時由非作者擔任，只控制 official evidence |

## 來源與需求 ID

[`01 §12`](../../01-product-community-model.md)、[`06 §4.1/.1.1`](../../06-delivery-plan.md)、[`entitlement-catalog.example.yaml`](../../contracts/entitlement-catalog.example.yaml)、RQ-004/RQ-023/RQ-059；ADR-056/ADR-060；OD-10；現行 baseline。

## 使用者結果與明確不包含

以 `01 §12`／catalog 的八個 launch entitlement keys 閉集為準：`community.member`、`opportunity.claim.basic`、`skill.submit`、`qc.review:<scope>`、`seller.list`、`store.deploy`、`coaching.offer`、`module.delegate:<scope>`；取得條件與 A4 named-action boundary 在 prose/fixture/API 間不漂移。不包含會員 compliance score、XP/rank 自動授權或 Agent A4 standing grant。

## Actor／principal／acting role／資源範圍

Human/org principal；entitlement owner；authorized operator；Agent 只代表 principal 使用 active grant，不能獨立持 entitlement。

## 既有 canonical entity／command／event／state／projection

EntitlementDefinition/Snapshot、activate/pause/revoke/restore/expire、HumanSignature/ExecutionGrant；八 key exact set 只引用 `01 §12`／catalog 上述閉集，不在 execution 另定取得條件。

## 正常／異常／卡點／取消／補件／爭議／恢復

正常：canonical fact→ruleset→scoped entitlement projection。異常：unknown key、condition drift、XP/rank/office 直接 grant、A4 downgrade 均拒絕。Revoke只作用 scope，恢復另記 fact。

## 授權／A4／independence／來源與版本綁定

A4 僅 exact consequential action；self-join/equip/submission/low-risk claim/welcome 排除。`qc.review:<scope>` 只來自 active exact ReviewerAppointment。

## 版本與獨立驗收

Catalog/ruleset version/hash pin；key 或 acquisition semantic breaking change 由 Grok adversarial review＋Claude verification＋自動 checks 驗證 migration 與 `01 §12` exact set。對外正式發布時才由 Ted 對 exact release 執行一鍵 A4。

## 冪等／業務唯一鍵／並發／fencing／lease／時間

同 source fact/ruleset/scoped key 至多一 active grant effect；appointment `review_by`、grant expiry 各自判定；stale snapshot 不授權 write。

## UI／CLI／MCP

Portal 顯示能做什麼/怎麼取得/為何失效；CLI/MCP server-side 重驗 current entitlement，不信 client cache。

## 隱私／憑證／資料保留與 provider 邊界

Snapshot 不含 XP、secret 或不必要 evidence body；只存 refs。External provider role/name 不直接變 entitlement。

## 成本／可觀測性／timeout／retry／reconciliation

記 grant/revoke consumer lag、ruleset version、denial reason；rebuild 可對 canonical facts reconcile。

## 遷移／相容性／rollback

Rule rollback不倒改歷史；新 projection 明示使用版本。移除 key 需 consumer window與 scoped revoke plan。

## Given–When–Then

- Given 高 XP/Master 無 appointment；When official review；Then `capability_required`。
- Given navigation item missing；When low-risk claim；Then不因該缺項 403。
- Given A2 token；When price/QC/release write；Then轉 exact A4 flow且零局部寫入。

## 實際測試命令（將來會這樣跑；未跑）

以下 `docs/platform-plan/contracts/tests/*.py` 均為（新建）路徑，目前尚不存在。

```bash
python -m pytest docs/platform-plan/contracts/tests/test_entitlement_exact_set.py -q
python -m pytest docs/platform-plan/contracts/tests/test_a4_named_action_boundary.py -q
python -m pytest docs/platform-plan/contracts/tests/test_reviewer_appointment_entitlement.py -q
```

路徑尚不存在，**未跑**。

## 缺 evidence 時的標籤／技術依賴

OD-10 actual appointments 未核對；只阻塞 official QC entitlement。以具名 Council holder＋appointment fixture/approval 解除。

## 完成證據

未完成；需 exact-set output、negative test logs、ruleset digest、review sign-off。
