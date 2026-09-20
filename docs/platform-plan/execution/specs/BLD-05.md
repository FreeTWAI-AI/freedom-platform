# SPEC-BLD-05 — Signed domain Skill runtime overlay

> 狀態：現行 canonical baseline（2026-09-17）；planning 文件，不代表已部署。

| 欄位 | 值 |
| --- | --- |
| Spec ID／狀態 | `SPEC-BLD-05`／draft-ready |
| 所屬 milestone／原 package | M02／`BLD-05` |
| Accountable role／implementation agent／AI reviewer／AI verifier | Agent Workflow；owner＝Ted（建議預設，五人共同閱讀確認）／韋銘＋Codex（implementation；建議預設，五人共同閱讀確認）／Grok／Claude |
| official reviewer（建議預設） | Mini 或 Jason（五人共同閱讀確認）；implementation＝韋銘時由非作者擔任，只控制 official evidence |

## 來源與需求 ID

[`06 §4.1.2 BLD-05`](../../06-delivery-plan.md)、[`08 §12`](../../08-bootstrap-hosting-project-lifecycle.md)、[`domain-skill-overlay.schema.json`](../../contracts/domain-skill-overlay.schema.json)、[`domain-skill-overlay.example.json`](../../contracts/domain-skill-overlay.example.json)、RQ-049（domain overlay 主引用）/RQ-047（三 CLI 參與）；ADR-052；baseline。**階段 1A contract／階段 1B implementation 均保留。**

## 使用者結果與明確不包含

既有 control activation 不變；經簽章、runtime-scope QC、2-of-N proof與撤銷檢查的 exact domain roots，可在 per-run sealed isolation執行，撤銷後回 `capability_unavailable`。不包含任意 Skill bytes執行、改寫control digest、以eligibility-only冒充runtime，或project lifecycle implementation。

## Actor／principal／acting role／資源範圍

Person operator、AgentRun principal、domain Skill publisher、兩位獨立 QC/release signers、runtime loader。WorkItem refs由server derivation；Agent不能自報 roots或QC。每次run資源範圍是exact signed root set與grant交集。

## 既有 canonical entity／command／event／state／projection

DomainSkillOverlay、runtime roots、QC proof、publisher authority/revocation、`runtime_roots_set_digest`、AgentRun、ExecutionGrant。命令：evaluate mode→derive refs→verify overlay/roots/QC/revocation→seal run namespace→load→revoke/stop。mode：`eligibility_and_provenance_only_v1`（default）／`signed_isolated_overlay_v1`；projection：capability availability與denial reason。本 spec不新增事件名。

## 正常／異常／卡點／取消／補件／爭議／恢復

正常：exact roots set按JCS公式得digest，2-of-N不同自然人 proof有效，所有 authority/current revocation成立後封存run namespace。異常：missing/extra/reordered root、package/closure/QC mismatch、自我review、expiry/revoke、case-fold/host shadow、mid-run update或unsupported isolation皆零domain execution。撤銷使新run不可用；active run依signed policy停止/隔離並留audit，不能靜默換root。

## 授權／A4／independence／來源與版本綁定

domain overlay只是A4 exact artifact之一；還須AgentRun/ExecutionGrant與server-derived WorkItem refs exact-set相等。QC signers按自然人獨立，換Agent不算第二人。cache、package capability或eligibility不授權執行。

## 版本與獨立驗收

schema/overlay/package/closure/QC/publisher/revocation全綁 exact version/digest；未知major fail closed。階段 1A 凍結 contract schema、JCS、proof、mode、layout與三adapter fixtures；階段 1B skeleton／implementation 讓至少一個無外部副作用domain Skill在三 CLI完成 enable→execute→revoke→unavailable。

## 冪等／業務唯一鍵／並發／fencing／lease／時間

同 overlay digest與run id重試不重複建立namespace或副作用。mode/overlay generation作fence；mid-run update不能改sealed root。五種時間依 `03 §11`：invite／claim `expires_at`、delivery `due_at`、TaskLease／lease proof `expires_at`＋`fencing_token`、`ExecutionGrant.expires_at`、evidence `valid_until`；本 package 只涉及 TaskLease／lease proof、ExecutionGrant 與 evidence 子集，其餘不得代用。Overlay／index／revocation authority TTL 與 retention 不是 clock，最早安全邊界可阻止新執行但不可互相延長。

## UI／CLI／MCP

UI顯示 mode、exact roots、QC/publisher/revocation freshness與 remediation。CLI/adapter須支援 inspect/evaluate/activate-for-run/revoke-observe；名稱待實作固定。MCP facade只暴露該run已封存且授權的tools，host可見tool不自動進scope。

## 隱私／憑證／資料保留與 provider 邊界

overlay/example不得含secret；signing/runtime credential由隔離broker提供。run namespace只掛所需bytes/data，logs不保存prompt/customer raw data。example的key/signature皆假fixture，永不可activate。

## 成本／可觀測性／timeout／retry／reconciliation

記錄roots-set digest、proof/authority versions、mode decision、load/deny reason、resource cost與revoke propagation。timeout後重查current heads/revocation，不盲目沿舊decision retry；reconcile sealed session與availability projection。

## 遷移／相容性／rollback

預設保持eligibility-only；signed isolated是明示新增mode。階段 1B 先用無外部副作用Skill；失敗回eligibility-only/capability_unavailable，不自動換未簽root。control activation八輸入digest在遷移前後不變。

## Given–When–Then

1. Given valid overlay、獨立2-of-N QC與exact server refs，When三adapter建立run，Then roots-set digest一致且Skill只見sealed roots。
2. Given self-review或多一個root，When evaluate，Then零domain execution與consequential effect。
3. Given run已啟動後root/key撤銷，When新call或新run，Then依policy停止/拒絕並回 `capability_unavailable`，不切別版。
4. Given只通過eligibility，When要求tool execution，Then不執行。

## 實際測試命令（將來會這樣跑；未跑）

以下 `docs/platform-plan/contracts/tests/*.py` 均為（新建）路徑，目前尚不存在。

```bash
pytest -q docs/platform-plan/contracts/tests/test_overlay_roots_qc_parity.py
pytest -q docs/platform-plan/contracts/tests/test_revoke_midrun_and_isolation.py
pytest -q docs/platform-plan/contracts/tests/test_three_adapter_mode_flow.py
```

以上命令目前未跑，路徑是 future implementation contract。

## 缺 evidence 時的標籤／技術依賴

Runtime QC evidence、implementation repo、三 adapter isolation能力與production custody未核對。階段 1A contract fixtures可進行；階段 1B implementation技術上依賴BLD-04與isolation capability；獨立自然人 evidence只控制`official`，production custody evidence控制`production-signed`。

## 完成證據

階段 1A schema／example／JCS／golden／negative fixtures；階段 1B三CLI同root transcripts、zero-effect negatives、revoke／mid-run／isolation drill、control digest unchanged proof、Grok review與Claude verification。目前均不存在。
