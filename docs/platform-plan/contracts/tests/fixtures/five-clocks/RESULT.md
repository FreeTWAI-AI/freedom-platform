> Historical source archive, imported 2026-10-03 from the preserved original checkout. The dated results and reviewer statements below describe the original FW-01 source snapshot, not the current integration tests, contracts, CI or deployed runtime. Current tests use catalog/YAML fixtures and a nested complete ReleaseStatusLeaseProof; do not reapply the historical response-level duplicate-fence proposal or infer current PASS from these logs. Companion files retain original bytes and historical digests, which intentionally do not match current sources.

# FW-01 本地契約檢查證據

日期：2026-09-20。所有身份、時間、授權與費用範例均為 synthetic。

**狀態：測試已建立並實跑；114 passed／0 failed；FW-01 驗收條件（五類 clock 正例、setter／expiry 邊界、另一 clock 不可替代負例、schema refs 全部 resolve）已達成。**

## 可重跑命令與結果

從 Freedom-Platform 根目錄執行；python3、pytest、PyYAML、jsonschema（包含 referencing）需可匯入：

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m pytest -q -p no:cacheprovider docs/platform-plan/contracts/tests/test_five_clock_invariants.py
```

**114 passed／0 failed in 0.49s；exit code 0。** 其中 70 個檢查真實 canonical artifact，另 44 個只測 synthetic reference model。完整 stdout 在同目錄 `pytest-output.txt`；來源與測試輸入雜湊、套件版本在 `input-digests.json`。

## 契約補洞

1. `ReleaseStatusJobLease` 已在與 `expires_at` 相同的頂層物件加入 required `fencing_token`，落實 ADR-062 與 `03 §11` 的 lease expiry／fence 同物件要求。
2. `ReleaseStatusJobHeartbeat` 已在與 `expires_at` 相同的頂層物件加入 required `fencing_token`，落實 ADR-062 與 `03 §11` 的 lease expiry／fence 同物件要求。
3. `work_item.add_exclusive_claim_atomically` 已加入 `claim_window_open` guard，落實 ADR-062 與 `03 §11` 對 invite／claim clock 到期後果及不可由其他 clock 替代的要求。

## 覆蓋與限制

- 真實 contract 檢查：完整 synthetic 物件經既有 OpenAPI／JSON Schema 驗證；刪除／更名／替代 clock 的負例；所有相關 schema 的遞迴本地 refs；72 小時 grant 邊界；claim、appointment 與 current-fence 的 state guards。
- 五類 clock 的 setter、到期後果、歷史保留與續期規則：按 `03 §11` 表格逐欄回歸檢查，另有 setter 被其他 clock 替代的負例。這是文字契約檢查，未執行產品權限或歷史更新。
- 44 個 synthetic 測試涵蓋 before／at／after、其他物件的較晚 expiry 不能延長本物件、缺失 clock 不能向別種物件借用、provider timestamp 不可替代、stale fence 與續期後舊 fence；它們不是 runtime evidence。
- 沒有 runtime、部署或真人授權驗證的宣稱。
- invite／claim window 的完整 schema carrier 與一般 evidence 的 `valid_until` 在目前 scaffold 尚未具備；這些部分採文字與 synthetic 案例，不拿 `SubmissionDraft.expires_at` 冒充 invite，也不宣稱完整 schema／runtime 覆蓋。
- evidence family 同時覆蓋一般 `valid_until` 的文字／synthetic 案例及 `ReviewerAppointment.review_by` 的實際 schema／guard。
- delivery 以「嚴格晚於 `due_at` 才 overdue」作為 synthetic 邊界慣例；相等時的 scheduler 行為尚未由產品驗證。

## 修改邊界

本回合只更新以下 FW-01 證據檔，未修改測試或 canonical，也未建立 `.git`：

- `docs/platform-plan/contracts/tests/fixtures/five-clocks/pytest-output.txt`
- `docs/platform-plan/contracts/tests/fixtures/five-clocks/input-digests.json`
- `docs/platform-plan/contracts/tests/fixtures/five-clocks/RESULT.md`
