# SPEC-FND-04 — Credentials、object storage、observability、backup/restore

> 狀態：現行 canonical baseline（2026-09-17）；planning 文件，不代表已部署。

| 欄位 | 值 |
| --- | --- |
| Spec ID／狀態 | `SPEC-FND-04`／draft-ready |
| 所屬 milestone／原 package | M01／`FND-04` |
| Accountable role／implementation agent／AI reviewer／AI verifier | Foundation owner；owner＝Ted（建議預設，五人共同閱讀確認）／韋銘＋Codex（implementation；建議預設，五人共同閱讀確認）／Grok／Claude |
| official reviewer（建議預設） | Mini 或 Jason（五人共同閱讀確認）；implementation＝韋銘時由非作者擔任，只控制 official evidence |

## 來源與需求 ID

[`02 §8.4–8.5`](../../02-architecture-repositories.md)、[`08 §5`](../../08-bootstrap-hosting-project-lifecycle.md)、`06 §4.1`、RQ-039/RQ-043/RQ-045；baseline/provisional provider assumption。

## 使用者結果與明確不包含

Secret、public/private/quarantine object、logs 與 backup 有分離邊界且可恢復。不包含建立雲端資源、宣稱 R2 put-only IAM、保存客戶 raw files 或 production key。

## 2026-09-24 現行 runtime 對照

以 base `8338a42` 核對；公開會員 beta 只有下列局部做法，不構成本 SPEC 的 broker／KMS／restore evidence。

- 公開站是 Castle loopback＋Tunnel、獨立非 superuser `freedom_public` DB 與 0600 env 檔；運行手冊規定每日本機 custom dump 與首次 restore rehearsal，尚無異地備份（[公開站運行手冊](../../../development/public-operations.md)）。
- GitHub OAuth token 以應用層金鑰加密存 DB（`modules/github-social/`）；client read token、開發 key 只存 hash（`tests/runtime/client-connections.test.ts`、`tests/runtime/development-access.test.ts`）。
- 尚未：Credential Broker、KMS／HSM、status signer、R2／quarantine、secret rotation 演練、root recovery material 分離與 restore 後 credential 不復活的驗證。

## Actor／principal／acting role／資源範圍

Credential broker、status signer、quarantine writer/sweeper、SRE operator 各有獨立 deployment/role；一般 Agent/API 無 vault root、signer key或 quarantine read/list。

## 既有 canonical entity／command／event／state／projection

Connection/secret_ref、credential vault refs、object classification/retention、backup/recovery facts；部署邊界依 `02/08`，不在此重定義。

## 正常／異常／卡點／取消／補件／爭議／恢復

正常：scoped connection→broker capability→provider operation；classified object→allowed bucket。異常：wrong audience/AAD、secret leak、forbidden raw upload、restore mismatch。未知 provider effect 走 reconcile；quarantine 依 deadline 刪除並留 receipt。

## 授權／A4／independence／來源與版本綁定

Production key/secret rotation、restore、destructive delete 要 exact A4。Broker/signer roots、DB roles、deploy creds 分離；同人兩 Agent 不等於 custodian separation。

## 版本與獨立驗收

Key version、retention policy、backup manifest 固定。獨立 Security/SRE 驗 cross-role denial、restore、rotation、secret scan。

## 冪等／業務唯一鍵／並發／fencing／lease／時間

Credential issuance 綁 current job lease/fence；rotation/revoke 冪等。五種時間依 `03 §11`：invite／claim `expires_at`、delivery `due_at`、TaskLease／lease proof `expires_at`＋`fencing_token`、`ExecutionGrant.expires_at`、evidence `valid_until`；本 package 只涉及 TaskLease／lease proof 與 evidence／credential 子集，其餘不得代用。Retention deadline 不是 clock。

## UI／CLI／MCP

Operator workbench/CLI 顯示 redacted health、rotation/restore work；MCP/Agent 永不回 refresh token 或 root key。

## 隱私／憑證／資料保留與 provider 邊界

客戶 raw/secret 不進中央 DB/R2/Queue/log/prompt；只存 opaque ref/digest/minimum consent metadata。Fixtures 使用 fake refs。

## 成本／可觀測性／timeout／retry／reconciliation

量測 storage/egress、vault calls、rotation lag、backup age、delete deadline、redaction failures；budget alert 不撤人身 entitlement。

## 遷移／相容性／rollback

Envelope key rotation支援 rewrap；storage provider 可換但保留 opaque contract。Restore 後失效 credential 不可復活。

## Given–When–Then

- Given release worker；When request broker binding；Then denied before secret lookup。
- Given customer raw upload to normal central bucket；When classify；Then reject/quarantine，24h policy receipt。
- Given backup without root recovery material；When restore；Then data可恢復但 vault 不可被單方解密。

## 實際測試命令（將來會這樣跑；未跑）

以下 `docs/platform-plan/contracts/tests/*.py` 均為（新建）路徑，2026-09-24 核對仍不存在。

```bash
python -m pytest docs/platform-plan/contracts/tests/test_broker_signer_separation.py -q
python -m pytest docs/platform-plan/contracts/tests/test_data_classification_quarantine.py -q
python -m pytest docs/platform-plan/contracts/tests/test_backup_restore_key_revoke.py -q
```

路徑尚不存在，**未跑**。

## 缺 evidence 時的標籤／技術依賴

Provider／KMS／budget尚無建立事實；paid／production claim需要`08 §13`相應resource evidence，mock／local contracts照常。

## 完成證據

未完成；需 IaC diff、negative tests、restore/rotation transcript、cost report、limitations。
