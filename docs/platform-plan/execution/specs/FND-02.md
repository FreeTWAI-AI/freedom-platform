# SPEC-FND-02 — PostgreSQL、outbox/inbox 與 leased jobs

> 狀態：現行 canonical baseline（2026-09-17）；planning 文件，不代表已部署。

| 欄位 | 值 |
| --- | --- |
| Spec ID／狀態 | `SPEC-FND-02`／draft-ready |
| 所屬 milestone／原 package | M01／`FND-02` |
| Accountable role／implementation agent／AI reviewer／AI verifier | Foundation owner；owner＝Ted（建議預設，五人共同閱讀確認）／韋銘＋Codex（implementation；建議預設，五人共同閱讀確認）／Grok／Claude |
| official reviewer（建議預設） | Mini 或 Jason（五人共同閱讀確認）；implementation＝韋銘時由非作者擔任，只控制 official evidence |

## 來源與需求 ID

[`06 §4.1`](../../06-delivery-plan.md#41-foundation組織與-agent)、[`02 §8`](../../02-architecture-repositories.md)、[`05 §§1/6`](../../05-integration-contracts.md)、RQ-041/RQ-043；baseline。

## 使用者結果與明確不包含

Canonical write、outbox、inbox、job lease/fence 與 projection checkpoint 有可遷移、可重播的一致底座。不包含 Cloudflare Queue 作第二真相、正式 provider、業務模組全表或已驗證 HA。

## Actor／principal／acting role／資源範圍

Domain service principal 寫自己的 aggregate/outbox；dispatcher/worker 只持其 DB/job scope；Ops 依 runbook 診斷，不直接無痕改業務資料。

## 既有 canonical entity／command／event／state／projection

沿用 DomainEvent envelope、WebhookInbox、Job/TaskLease、StateTransitionRecord、projection cursor；commands/states 以 [`03`](../../03-domain-events-state-machines.md) 與 [`05`](../../05-integration-contracts.md) 為準。

## 正常／異常／卡點／取消／補件／爭議／恢復

正常：aggregate＋outbox 同 transaction；dispatcher publish ID；worker fenced claim；effect/cursor 同 transaction。異常涵蓋 duplicate/out-of-order、crash、stale fence、gap。卡點進 reconciliation；取消不刪 history；restore 後重播 projection。

## 授權／A4／independence／來源與版本綁定

DB roles least privilege；migration/recovery production execution 需相應 A4。Job payload pin contract version；worker 不能由 body 自報 executor group。

## 版本與獨立驗收

Migration 使用 expand→backfill→switch→later contract。獨立 SRE 從 backup restore，重放 outbox/inbox/job fixtures並核對 canonical state。

## 冪等／業務唯一鍵／並發／fencing／lease／時間

Inbox event/delivery unique、outbox event ID stable、job provider operation key 跨 lease 不變。Lease object 的 `expires_at` 必和 `fencing_token` 同物件；不得替代 claim/grant/due/evidence clock。

## UI／CLI／MCP

Operator CLI 只提供 read-only diagnosis、migration status、replay/reconcile command；Portal/MCP 不得直寫 inbox/outbox/job tables。

## 隱私／憑證／資料保留與 provider 邊界

Payload 只放 ID/opaque refs；secret/raw client data 禁止。DB credential 分 role；backup 不含可單獨解密 vault 的 root key。

## 成本／可觀測性／timeout／retry／reconciliation

量測 outbox age、gap、lease takeover、retry、DLQ/reconcile、storage growth；timeout 不直接重做未知 side effect。

## 遷移／相容性／rollback

Migration forward-fix 優先；rollback 只在 evidence 表明安全。Queue 可清空後由 DB sweeper 補 wake-up。

## Given–When–Then

- Given DB commit 後 Queue wake-up 遺失；When sweeper；Then 同一 event/job 被補送且 business effect 一次。
- Given lease N 完成時 N+1 已取得；When N write；Then `stale_job_lease` 且零副作用。
- Given N+2 先到；When consumer；Then buffer gap，不跳 cursor，補 N+1 後收斂。

## 實際測試命令（將來會這樣跑；未跑）

以下 `docs/platform-plan/contracts/tests/*.py` 均為（新建）路徑，目前尚不存在。

```bash
python -m pytest docs/platform-plan/contracts/tests/test_outbox_inbox_atomicity.py -q
python -m pytest docs/platform-plan/contracts/tests/test_job_lease_fencing.py -q
python -m pytest docs/platform-plan/contracts/tests/test_projection_rebuild.py -q
```

路徑尚不存在，**未跑**。

## 缺 evidence 時的標籤／技術依賴

DB provider／region／HA／PITR未建立；port／schema本地工作照常。`08 §13`的PostgreSQL資源與restore evidence是sandbox／production claim的技術依賴。

## 完成證據

未完成；需 migrations、test output、restore transcript、metrics schema、known limitations。
