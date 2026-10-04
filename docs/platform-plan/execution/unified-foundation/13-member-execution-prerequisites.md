# 本人模型選擇、限定 Grant 與封閉 Attempt

本批延續 [Run](04-execution-adapters-release.md)、[配對](10-device-authorization.md)
與 [refresh family](11-bootstrap-sessions.md)，新增會員本人管理的實體 backing
records。對應 U3、AP M1/M2/M3、AP:WORK-03/05 的前置條件；不是完整私人 AI
草稿驗收。中央契約是 [member-execution.ts](../../../../contracts/execution/v1/member-execution.ts)，
封閉服務是 [prerequisites.ts](../../../../modules/agent-execution/prerequisites.ts)，
新增 schema 是 [092](../../../../migrations/092_execution_prerequisites.sql)。

`createExecutionPrerequisites(pool, {environment, clientId, grantTtlSeconds?})`
回傳 `models.create/read/revoke`、`grants.create/read/revoke` 及
`attempts.create/read`。environment/clientId 與 TTL 是可信 server configuration；
會員 Actor 必須來自既有真人驗證路徑，服務仍於 DB 重查目前會員、session、
person/personal scope 及 onboarding。Bootstrap token 的用途仍只有 bootstrap
status，不能拿來操作這些會員服務。[封閉 HTTP factory](14-member-execution-http.md)
沿用真實會員 cookie／CSRF；正式 HTTP/UI 尚未掛載。

## 模型選擇與撤銷

ModelConnection 必須綁定同一本人的真正已登錄 Runtime、有效 AgentConnection
及 active refresh family；ID、owner、scope、environment、client 與選擇不可改綁。
會員明確提供 providerRef、modelRef、processingLocation、artifactCustody，並選擇
下列中央組合，不允許自動補預設或 fallback：

| credentialCustody | engineLocation | billingSource |
| --- | --- | --- |
| official_cli | runtime_local | user_cli |
| local_keychain | runtime_local | user_byok |
| platform_vault | platform | user_byok |

上述全部是尚未驗證的偏好 metadata。選擇某 provider/custody 不代表已有登入、
vault、keychain adapter、模型可用性或帳單事實。模型狀態只允許 `unverified`
與終止的 `revoked`；每筆 metadata 都有 `operational_authority:false`。不收
secret、credentialRef、provider URL、模型登入證明或 caller modelReady。

建立時比對 expectedConnectionVersion；撤銷是本人 CAS，版本加一且不可復活。
本人仍可在連線/family 到期或撤銷後讀取及撤銷自己的紀錄；不必先讓 provider
恢復。每個本人最多保留 32 筆 lifetime model records，撤銷不回收名額。

## 精確範圍的會員同意

建立 Grant 必須明確 `consent:true`，並提供 Run、Work、connection、model 的
expected versions。Server 自目前 locked backing records 取得原始 Work version、
Run version、taskLeaseEpoch/controlEpoch、runtime/family、connection/model versions、
全部模型選擇與目前 private persistence policy revision。Run 必須仍為 created，
Work 必須為本人 draft，且目前版本仍等於 Run 的 immutable inputWorkVersion。
不可把舊 Run 悄悄改接編輯後的 Work。

用途固定 `model.private-draft`。`active` 只表示同意紀錄狀態，不能變成模型驗證
或 execution permit。TTL 預設 3600 秒，server 可縮短為整數 1–3600 秒；
實際 expiry 還須剪裁到 connection/family expiry。Caller 不能選 TTL、scope、
policy、budget、owner、task epoch 或 recovery generation。到期後不延長，
需重新檢查並建立新同意；每人最多 256 筆 lifetime Grant records。

正常 refresh handle 輪替不改變這份同意，Grant 不綁 current_generation。
family 重用撤銷、會員失效、Work/Run/model/connection 版本或狀態改變、policy
撤回或 revision 改變則使後續建立/重播失效。不同 connection 的 model 無法混用。
本人 read/revoke 在上述後端失效後仍可使用；歷史讀取不構成目前授權。

## 不可改綁的 Attempt

建立 Attempt 再次檢查目前會員、所有 backing、Grant 時效與全部版本/epochs，
同 key 重播也必須重查。綁定實體 Run/Grant/Work/runtime/connection/model；
Grant snapshot 是建立時的不可變歷史，不因後續撤銷而重寫。每個 Run 的
attemptNumber 為 1–16，序號與綁定不可更新、刪除或復用。

目前沒有真正 model authentication 或 model adapter，因此每筆 Attempt 都是
`preflight_blocked`，blockers 精確為 `model_authentication_unavailable`、
`model_adapter_unavailable`，`operational_authority:false`。不新增 fake inferenceRef、
lease、currentAttempt pointer、recovery authority、控制器、模型呼叫或 Result。
後續真正執行必須另建立完整 authenticated binding 與中央決策接線。

## 交易、直接 SQL 與時間邊界

所有 command 使用現有 scoped member receipt，domain/fact/outbox/receipt 在同一
client/transaction。建立/replay 的 current authority 位於 receipt lookup 之前，
並在真正 receipt SELECT 與 INSERT 等待後重查。可信第五個 callback
`revalidate(q, context)` 不在 caller JSON/digest 中；callback 等待後亦重查 session。
拒絕時完整回滾。決策使用 DB wall clock，不承諾網路回應/commit 完成前永遠有效。

共同鎖定順序為 member/session/principal/scope → receipt advisory → prerequisites
owner advisory → runtime owner/key advisory → enrollment challenge/runtime →
connection → family → Work → Run → model → Grant → policy；最後才 INSERT
新的 Attempt。歷史 Attempt read 在 Grant 後鎖既有 Attempt，省略 policy。
單純本人讀取或撤銷可省略不需要的後段鎖，不逆向取得前段鎖。建立時 policy
與真實 backing 必須在同一交易檢查；SQL guard 使用同一實體 schema，不能讓
TEMP/search_path 代換。並發建立/撤銷須鎖定共同實體，不能只靠未鎖 SELECT。

092 是 additive migration，不修改 076–091 歷史 bytes。完整 owner/scope
composite FK、immutable guards、正整數 signed bigint 與有界有效時間同時約束
服務和直接 runtime DML。所有 public version/epoch 用 decimal strings，不用
JSON Number；snapshot 必須在 SQL 端保留精度。Runtime role 不能 disable trigger、
修改 schema 或 operator policy。SQL 的結構檢查不取代 trusted service 的真人驗證。

release shape `execution.member-prerequisites.v1` 需要 092 及既有 Work、policy、
Run、runtime、connection、status、refresh 能力。Schema 存在不代表功能已啟用；
enabled/written/history floor 與兩個 release binaries 都須保留依賴。診斷仍沒有
deployment/execution/restore authority。

## 驗證與剩餘工作

本機證據集中記於 [implementation-status.md](implementation-status.md)，包含作者、
獨立反例、中央契約、least privilege、expiry wait、原子回滾與 release compatibility。
必須涵蓋真正配對取得 family、錯誤 owner/environment/client、stale versions、
Work 編輯、Run 控制、model/Grant/family 撤銷、政策撤回、重播、直接 SQL/TEMP
替換，以及 receipt 等待跨過 Grant/session 到期的失敗結果。

真正模型認證、單一明確 adapter、private Result 執行、正式 HTTP/UI、可信 CI、正式金鑰、
cloud/restore、packaged client 與 staging/live 均另列待做，不以本批 metadata 或
測試數量折算產品驗收。168 項原始 acceptance 保留原本 `not_run`。
