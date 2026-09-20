# SPEC-INT-03B — GitHub App sandbox 與 semantic sync

> 狀態：現行 canonical baseline（2026-09-17）；planning 文件，不代表已部署。

| 欄位 | 值 |
| --- | --- |
| Spec ID／狀態 | `SPEC-INT-03B`／draft-ready |
| 所屬 milestone／原 package | M02／`INT-03B` |
| Accountable role／implementation agent／AI reviewer／AI verifier | Community & Migration／GitHub organization & App；owner＝Ted（建議預設，五人共同閱讀確認）／韋銘＋Codex（implementation；建議預設，五人共同閱讀確認）／Grok／Claude |
| official reviewer（建議預設） | Mini 或 Jason（五人共同閱讀確認）；implementation＝韋銘時由非作者擔任，只控制 official evidence |

## 來源與需求 ID

[`06 §4.2 INT-03B`](../../06-delivery-plan.md)、[`05 §9`](../../05-integration-contracts.md)、INT-03A deterministic mocks、RQ-024/RQ-064；ADR-021/ADR-065；baseline。

## 使用者結果與明確不包含

核准的GitHub App sandbox能綁repo，將Issue/PR/review/release同步為canonical stable-ID facts並可reconcile。預設只用必要read/metadata與明示workflow scopes；不自動star/follow、不把repo自報當Official、不以live sandbox取代INT-03A deterministic tests。

## Actor／principal／acting role／資源範圍

Person installation owner、GitHub App installation principal、webhook verifier、sync worker、Agent（僅經Platform grant）。每個RepositoryBinding綁stable provider/repository ID與installation；repo name/URL不是identity。

## 既有 canonical entity／command／event／state／projection

ExternalIdentity/Connection、RepositoryBinding、WebhookInbox、ExternalRef、WorkItem/Issue/PR/Review/Release semantic facts、CandidateProvenance。命令：install/bind→verify webhook→dedupe/normalize→apply fact→backfill/reconcile→require reauthentication/revoke。`integration_connection` 狀態只引用 `core.example.yaml` 的 `pending/active/degraded/reauth_required/revoked`；projection：sync cursor/health/rate limit。

## 正常／異常／卡點／取消／補件／爭議／恢復

正常：驗signature/delivery/repo binding，append inbox，再由worker正規化stable facts。異常：replay/out-of-order、rename/transfer/private/delete、scope loss、rate limit、schema drift或provider timeout不做未驗mutation。恢復用authoritative query/cursor reconcile；partial結果標degraded，撤銷停止新calls但保留refs/audit。

## 授權／A4／independence／來源與版本綁定

App permission與Platform grant雙重限制；Agent不能直接取得App private key/token。release/Official仍需exact A4/attestation；PR review的GitHub actor解析到自然人，換Agent/role不構成independent review。`github.star`只允許Person明示決策＋自身connection＋explicit grant，且不在default adapter surface。

## 版本與獨立驗收

GitHub API/webhook version、INT-03A normalized schema與mapping固定；live sandbox輸出要與deterministic mock golden等價。未知required semantic/version fail closed，raw payload只作有期限reconcile input。

## 冪等／業務唯一鍵／並發／fencing／lease／時間

delivery ID＋provider/repo stable ID dedupe；aggregate version/cursor fence阻止舊event覆新fact。五種時間依 `03 §11`：invite／claim `expires_at`、delivery `due_at`、TaskLease／lease proof `expires_at`＋`fencing_token`、`ExecutionGrant.expires_at`、evidence `valid_until`；本 package 只涉及 TaskLease／lease proof 與 ExecutionGrant 子集，其餘不得代用。Source `occurred_at`、App token expiry 與 retention 不是 clock。timeout後依operation/delivery查詢，不重建重複Issue/PR/release。

## UI／CLI／MCP

UI顯示installation/repo stable ID、permissions、last sync、lag、rate limit、degraded/revoke與reconcile。CLI提供bind/status/reconcile/revoke；名稱待實作。MCP只能透過Platform semantic commands，不能passthrough GitHub token或暴露未授權raw payload。

## 隱私／憑證／資料保留與 provider 邊界

private key/token存隔離credential broker；log/fixture禁secret。private repo content按exact purpose最小化，raw webhook加密、限權、到期刪除；canonical只保必要refs/digests/facts。

## 成本／可觀測性／timeout／retry／reconciliation

記錄delivery/dedupe、API calls、latency、rate limit、cursor lag、schema/mapping failure與reconcile差異；成本歸installation/repo。retry用backoff與stable keys；provider accepted/timeout先查狀態。

## 遷移／相容性／rollback

先通過INT-03A mocks，再申請exact sandbox App。mapping升版shadow compare；rollback停新mapping/worker，保留inbox與舊projector可重放。permission縮減fail closed，不自動要求更寬scope。

## Given–When–Then

1. Given sandbox delivery重送/亂序，When sync，Then每個semantic fact只成立一次且終態與authoritative query一致。
2. Givenrepo rename/transfer，When reconcile，Thenstable repository ID不變且binding owner變更需明示處理。
3. Giventoken scope不足或revoked，When worker執行，Then只阻塞GitHub動作，不更改member權利或既有work facts。
4. GivenAgent要求star/write但沒有explicit Person grant，When呼叫，Then拒絕且不產生provider request。

## 實際測試命令（將來會這樣跑；未跑）

以下 `docs/platform-plan/contracts/tests/*.py` 均為（新建）路徑，目前尚不存在。

```bash
pytest -q docs/platform-plan/contracts/tests/test_app_sandbox_sync.py
pytest -q docs/platform-plan/contracts/tests/test_replay_ordering_and_reconcile.py
pytest -q docs/platform-plan/contracts/tests/test_github_permissions_and_token_boundary.py
```

以上命令目前未跑；真實sandbox未建立。

## 缺 evidence 時的標籤／技術依賴

GitHub organization／App、permissions、account owner與budget尚無建立事實；sandbox credential技術上依賴`08 §13`的O1 account與scoped secret path。INT-03A mocks、mapping與fixtures照常。

## 完成證據

App manifest/permission decision、mock parity、sandbox webhook/API transcripts、replay/reconcile/rename/transfer tests、secret scan、revoke drill與review sign-off。目前均不存在。
