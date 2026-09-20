# SPEC-FND-03 — Provider-neutral identity/session/audit

> 狀態：現行 canonical baseline（2026-09-17）；planning 文件，不代表已部署。

| 欄位 | 值 |
| --- | --- |
| Spec ID／狀態 | `SPEC-FND-03`／draft-ready |
| 所屬 milestone／原 package | M01／`FND-03` |
| Accountable role／implementation agent／AI reviewer／AI verifier | Foundation owner；owner＝Ted（建議預設，五人共同閱讀確認）／韋銘＋Codex（implementation；建議預設，五人共同閱讀確認）／Grok／Claude |
| official reviewer（建議預設） | Mini 或 Jason（五人共同閱讀確認）；implementation＝韋銘時由非作者擔任，只控制 official evidence |

## 來源與需求 ID

[`03 §3.1`](../../03-domain-events-state-machines.md)、[`05 §3.1`](../../05-integration-contracts.md)、`06 §4.1`、RQ-003/RQ-005/RQ-039；baseline。

## 使用者結果與明確不包含

同一自然人在 Portal/LINE/Discord/GitHub 仍對應同一 canonical user，且跨 user/community 存取 fail closed。不包含 fuzzy merge、通用 KYC、已啟用 provider login 或 production sessions。

## Actor／principal／acting role／資源範圍

Human user/org principal；identity adapter；scoped operator。Agent 永遠不是 user principal。`community_id`、owner 與 acting role 由可信 context 推導。

## 既有 canonical entity／command／event／state／projection

User、ExternalIdentity、OrganizationMembership、Party、MemberConnection、session/audit；identity linked/revoked 與 user lifecycle events/states皆引用 `03`。

## 正常／異常／卡點／取消／補件／爭議／恢復

正常：session→link verified provider subject→unique identity。異常：link collision、wrong tenant、replay、deactivated session。卡點進 Identity Resolution；unlink 不刪歷史；account recovery 重新驗兩邊身份。

## 授權／A4／independence／來源與版本綁定

Link/unlink 需本人強身份與 CSRF；operator merge 有 audit/authority。External message/display name 不是授權或 identity proof。

## 版本與獨立驗收

Provider mapping additive；身份 merge contract 變更需 migration。獨立 security reviewer 跑 IDOR/cross-community/session revoke fixtures。

## 冪等／業務唯一鍵／並發／fencing／lease／時間

`provider+tenant+subject` active unique；link request 有 idempotency/version。Session/claim token expiry 各自判定，不借 TaskLease 或 grant clock。

## UI／CLI／MCP

Portal 支援 link/conflict/recovery；CLI/MCP 只取得本人/organization scoped token，不能 body 指定 `user_id`。

## 隱私／憑證／資料保留與 provider 邊界

不以 email/name/photo fuzzy merge；token 只存 opaque/encrypted ref；audit 脫敏。Deactivation 依 retention 保留必要 transaction/result refs。

## 成本／可觀測性／timeout／retry／reconciliation

觀測 login/link failure、collision、revocation lag；provider timeout 不建立 linked fact，reconcile current provider state。

## 遷移／相容性／rollback

Legacy rows保留 source/hash/status；無 contemporaneous proof 不自動歸戶。錯誤 link 以 audited unlink/merge correction，不改歷史 event。

## Given–When–Then

- Given 同 provider subject 已連 user A；When user B link；Then 409/人工 resolution 且不洩漏 A。
- Given revoked session；When cross-user query；Then 401/404 且零資料洩漏。
- Given 同一 link request 重送；When idempotency 相同；Then 回同一結果。

## 實際測試命令（將來會這樣跑；未跑）

以下 `docs/platform-plan/contracts/tests/*.py` 均為（新建）路徑，目前尚不存在。

```bash
python -m pytest docs/platform-plan/contracts/tests/test_external_identity_uniqueness.py -q
python -m pytest docs/platform-plan/contracts/tests/test_cross_user_community_idor.py -q
python -m pytest docs/platform-plan/contracts/tests/test_session_revocation.py -q
```

路徑尚不存在，**未跑**。

## 缺 evidence 時的標籤／技術依賴

首個 login provider與recovery operator尚無建立事實；本地identity core可繼續。Sandbox claim需要`08 §13`的provider connection與evidence。

## 完成證據

未完成；需 migration、auth test output、threat review、demo 與限制。
