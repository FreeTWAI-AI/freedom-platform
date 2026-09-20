# SPEC-SKL-01 — SkillPackage manifest、registry validator 與 GitHub import candidate

> 狀態：現行 canonical baseline（2026-09-17）；planning 文件，不代表已部署。

| 欄位 | 值 |
| --- | --- |
| Spec ID／狀態 | `SPEC-SKL-01`／draft-ready |
| 所屬 milestone／原 package | M02／`SKL-01` |
| Accountable role／implementation agent／AI reviewer／AI verifier | Open Product；owner＝Ted（建議預設，五人共同閱讀確認）／韋銘＋Codex（implementation；建議預設，五人共同閱讀確認）／Grok／Claude |
| official reviewer（建議預設） | Mini 或 Jason（五人共同閱讀確認）；implementation＝韋銘時由非作者擔任，只控制 official evidence |

## 來源與需求 ID

[`06 §4.3 SKL-01`](../../06-delivery-plan.md)、[`04 §7`](../../04-module-specifications.md)、[`skill-package.schema.json`](../../contracts/skill-package.schema.json)、INT-03B、RQ-013/RQ-015；ADR-015/ADR-043；baseline。

## 使用者結果與明確不包含

維護者能用versioned manifest描述SkillPackage，registry validator固定來源、digest、capabilities與compatibility，並把GitHub repository/version轉成待review的import candidate。這不自動發布、安裝、授權、賦予Official或執行任意bytes；discussion/run evidence屬SKL-02，member installation屬SKL-03。

## Actor／principal／acting role／資源範圍

Person maintainer/importer、GitHub App connection、registry validator、Open Product steward、reviewer。publisher namespace與repo binding分開；Agent可在bounded grant下起草candidate，不能自批。

## 既有 canonical entity／command／event／state／projection

SkillPackage/PackageVersion、manifest、Capability、RepositoryBinding、CandidateProvenance。命令：parse/validate manifest→resolve exact repo/ref→record bytes/digest/provenance→create candidate→review/publish/reject/withdraw。SkillVersion 狀態只引用 `03 §7.4` 的 `registered/candidate/official/deprecated/withdrawn`；projection：registry catalog、version graph、capability/risk/source。

## 正常／異常／卡點／取消／補件／爭議／恢復

正常：INT-03B取得exact stable repo/ref/bytes，validator驗schema/path/digest/capability並建立candidate。異常：mutable ref、path traversal、secret、undeclared capability、source mismatch、license/provenance缺失或unknown major拒絕。補件產生新candidate/revision；withdraw追加狀態，不刪歷史。

## 授權／A4／independence／來源與版本綁定

import權限不等於publish/release；Official/production需相應QC/A4 exact artifact。manifest宣告capability不授grant，安裝/執行另經SKL-03/AGT-04/BLD-05。reviewer自然人獨立，換Agent不算第二人。

## 版本與獨立驗收

PackageVersion immutable並綁repo stable ID、full ref/commit、file list、bytes digest與manifest version。validator與schema版本明示；INT-03A mock與INT-03B sandbox對同來源產生同candidate digest。

## 冪等／業務唯一鍵／並發／fencing／lease／時間

同namespace/version/source digest重送收斂；同version不同digest衝突。publish/candidate transition用aggregate version/fence。五種時間依 `03 §11`：invite／claim `expires_at`、delivery `due_at`、TaskLease／lease proof `expires_at`＋`fencing_token`、`ExecutionGrant.expires_at`、evidence `valid_until`；本 package 只涉及 TaskLease／lease proof 與 evidence 子集，其餘不得代用。Source time、GitHub token expiry 與 retention 不是 clock。

## UI／CLI／MCP

UI顯示source、version/digest、capabilities、validation、risk、candidate/review/withdraw與修復。CLI提供validate/import/status；名稱待實作。MCP discovery/import不授權安裝或tool call，且不得passthrough GitHub token。

## 隱私／憑證／資料保留與 provider 邊界

manifest/package禁止secret與不必要個資；GitHub token隔離，raw private content按purpose/retention限權。candidate保留必要provenance/digest，不複製無關repo內容；fixture用synthetic data。

## 成本／可觀測性／timeout／retry／reconciliation

記錄validation/import latency、bytes、API/rate limit、failure class、candidate digest與review queue。timeout後依repo/ref/candidate key查詢；reconcile registry candidate與GitHub exact source，不盲目重建。

## 遷移／相容性／rollback

先用INT-03A deterministic mocks，再用INT-03B sandbox。schema major升級需migration/dual validation；rollback停新candidate ingestion並回舊validator，保留既有immutable versions與audit。

## Given–When–Then

1. Given合法manifest與exact GitHub ref，When import，Then candidate綁stable repo ID、full ref、file/digest與provenance，且尚非published/Official。
2. Given同version不同digest或mutable ref，When validate/import，Then明確拒絕且零partial registry write。
3. Givenmanifest要求未宣告capability或含secret/path traversal，When validate，Then fail closed並列修復原因。
4. Givenpackage已withdrawn，When新install/request，Then不可把registry存在誤作grant或runtime資格。

## 實際測試命令（將來會這樣跑；未跑）

以下 `docs/platform-plan/contracts/tests/*.py` 均為（新建）路徑，目前尚不存在。

```bash
pytest -q docs/platform-plan/contracts/tests/test_manifest_registry_validator.py
pytest -q docs/platform-plan/contracts/tests/test_github_import_candidate_parity.py
pytest -q docs/platform-plan/contracts/tests/test_skill_import_boundaries.py
```

以上命令目前未跑；沒有registry implementation。

## 缺 evidence 時的標籤／技術依賴

Registry repo／API、license policy、risk tier與GitHub sandbox未核對。Manifest／validator／mock fixture照常；真實import技術上依賴INT-03B connection，不影響deterministic tests。

## 完成證據

schema/validator、mock/sandbox parity、candidate golden、digest/concurrency/security negatives、withdrawal behavior、secret scan與review sign-off。目前均不存在。
