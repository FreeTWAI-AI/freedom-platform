# SPEC-WRK-01 — Opportunity／Project／Squad／WorkItem／Claim／Result

> 狀態：現行 canonical baseline（2026-09-19 低維運互惠修訂）；planning 文件，不代表已部署。

| 欄位 | 值 |
| --- | --- |
| Spec ID／狀態 | `SPEC-WRK-01`／draft-ready |
| 所屬 milestone／原 package | M01／`WRK-01` |
| Accountable role／implementation agent／AI reviewer／AI verifier | Agent Workflow；owner＝Jason（建議預設，五人共同閱讀確認）／韋銘＋Codex（implementation；建議預設，五人共同閱讀確認）／Grok／Claude |
| official reviewer（建議預設） | Mini 或 Jason（五人共同閱讀確認）；implementation＝韋銘時由非作者擔任，只控制 official evidence |

## 來源與需求 ID

[`03 §7.5`](../../03-domain-events-state-machines.md)、[`06 §4.1/.6`](../../06-delivery-plan.md)、agent work contract、RQ-021/RQ-022/RQ-063；ADR-064；現行 baseline。

## 使用者結果與明確不包含

成員能認領 ready work；review-required work 沒 capacity 時仍維持 `open`／published candidate 且可領，並以 `waiting_reviewer_capacity` 導航狀態誠實顯示 review route。不包含空白 demo 卡、Agent 擁有 Claim、把導航狀態寫進 WorkItem lifecycle，或無 agreement 建 payable。

## 2026-09-19 互助增量（RQ-066–RQ-071）

WorkItem的`participation_terms`明列三模式、真實受益者與幫助者實益、最大投入、容量／結束／reuse；Claim pin revision/hash。條款與Result的本人實益回報依新schema／OpenAPI，Server驗來源、身份及authorised relation；Agent不能代認真人受益，回報不建立Contribution／payable或official。

reviewer容量卡按scope／episode聚合，不自動補位。未認領志願到期、回饋未知與保護中的付費／付款／安全／權益義務分開。跨Work／Coaching容量transaction與工時projection見`12`，T27–T34為待實作runtime驗收。

本次新增可執行静態檢查`contracts/tests/test_work_reviewer_capacity.py`與`test_low_ops_contracts.py`；它們只測契約／合成資料，不能替代並發／權限／產品驗收。原列尚未新增的runtime tests仍未跑。

## Actor／principal／acting role／資源範圍

Requester/publisher、human/Team/Squad claimant、assigned reviewer route、Agent executor。Claim owner 是人/Team/Squad，Agent 只持 TaskLease。

## 既有 canonical entity／command／event／state／projection

Opportunity/Project/Squad/WorkItem/WorkClaim/Result/ContributionRecord；`waiting_reviewer_capacity` 是正交導航狀態，open/claim/submit/review lifecycle states與 events引用 `03`/core fixture。

## 正常／異常／卡點／取消／補件／爭議／恢復

正常：draft complete→`open`／published candidate→claim→submit→review→accepted。異常：capacity不足時 lifecycle 仍為 `open`，另投影 `waiting_reviewer_capacity`＋單張 support card；concurrent capacity/claim、changes requested、release/expiry/cancel 依原 lifecycle 處理。Capacity出現後只更新 review route、導航狀態、卡片與 `official` evidence。

## 授權／A4／independence／來源與版本綁定

低風險 claim 可 A2；official QC另需 appointment/A4 exact decision。Publisher 不能用 XP/rank 取代 reviewer capacity；WorkItem pin inputs/acceptance/Skill/evidence revisions。

## 版本與獨立驗收

需求變更建立 revision/diff/reconfirmation；accepted evidence不因新版倒改。獨立 reviewer重跑 claim/capacity/time tests。

## 冪等／業務唯一鍵／並發／fencing／lease／時間

Publish/support-card、claim、submit 各有 idempotency key。Exclusive claim capacity原子。Invite/claim `expires_at`、delivery `due_at`、TaskLease `expires_at`＋fence、Grant expiry、evidence validity分離。

## UI／CLI／MCP

Portal/CLI/MCP 共用 typed WorkItem/Claim contract；candidate 維持 member claim feed 可見，`waiting_reviewer_capacity` 卡顯示 review route 與下一步，但不改 visibility、entitlement 或 discoverability。

## 隱私／憑證／資料保留與 provider 邊界

WorkItem 只保存必要 refs/digest；private Opportunity raw data不進 general Feed/Agent context。

## 成本／可觀測性／timeout／retry／reconciliation

量測 open candidate／navigation 狀態、review queue age、claim conflicts、overdue、stale lease；重送不重複 support card、claim或contribution。

## 遷移／相容性／rollback

`waiting_reviewer_capacity` 只加入正交 navigation projection，不加入 exhaustive WorkItem lifecycle state set；`agent-work-contract.example.yaml` 與 consumers 必須維持同一邊界。Rollback須保留 navigation facts與 owner-visible fallback，candidate lifecycle 仍為 `open`。

## Given–When–Then

- Given review required且無 active exact-scope appointment；When publish；Then candidate 維持 `open`／published 且可領，另有 `waiting_reviewer_capacity`＋一張 navigation card，人身與 discoverability 零影響。
- Given兩 Agent concurrent claim exclusive work；When commit；Then僅一個 human Claim成立。
- Given invite expired但 Claim 已成立；When task繼續；Then不抹除 Claim。

## 實際測試命令（將來會這樣跑；未跑）

以下原列runtime測試仍為待實作路徑；另有本次新增的靜態契約測試，結果見verification，不混用。

```bash
python -m pytest docs/platform-plan/contracts/tests/test_reviewer_capacity_navigation.py -q
python -m pytest docs/platform-plan/contracts/tests/test_claim_concurrency.py -q
python -m pytest docs/platform-plan/contracts/tests/test_five_clock_invariants.py -q
```

上述runtime tests尚未實作／未跑；本次靜態測試另列，不代表此SPEC完成。

## 缺 evidence 時的標籤／技術依賴

缺獨立自然人或 supply owner 時，相應標籤（`official`／`supply-ready`）為 false；不停止 candidate、review-required 公開可領與 live 以外的工作。容量出現時只更新 review route、導航狀態、卡片與標籤 evidence。

## 完成證據

未完成；需 migrations、API/contract tests、UI demo、queue metrics、limitations。
