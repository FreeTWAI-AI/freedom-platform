# 單步文字執行與私人模型成果

本批沿 [04](04-execution-adapters-release.md)、[13](13-member-execution-prerequisites.md)
及 [15](15-model-adapter-cores.md) 接完整的本機垂直流程：本人明確同意資料出口、
目前的配對與 Grant、實際 active Attempt／running Run、一次性派送、受限文字
transport、Asset 儲存及有模型來源的私人 Result。本批核心原先沒有 HTTP/UI；
後續 [17](17-private-ai-product.md) 接會員畫面及明確 Node host 安裝。既有 v1 Run
DTO 仍管理前置紀錄，不能承載 running profile；新 ModelStep 契約獨立處理。

合成 loopback fixture 使用真實 HTTP、PostgreSQL、會員簽章配對及 ObjectStore
bytes，但來源必須標為 `synthetic_local_fixture`。這不是正式 provider 成功、
產品會員驗收、可信 CI 或 staging/live 發布證據。程式另外實作固定 HTTPS BYOK
transport；未設定受信任 credential resolver 與外部 recovery port 時不可使用。
沒有讀取 Ted 的金鑰、登入訂閱帳號、付費呼叫或部署。

## 明確出口政策與同意

[093](../../../../migrations/093_export_model_steps.sql) 新增 operator-owned
`model_inference_export_policy`；migration 不植入允許值。政策綁本人 personal
scope、environment、client 與完整 ModelSelection，限 prompt UTF-8 bytes 與
output token cap。runtime role 只能讀政策及 UPDATE generated constant
`scope_kind=DEFAULT` 以取得 row lock，不能改 export/persistence/配額等政策內容。
沿用 [085](../../../../migrations/085_private_work_policy.sql) 的 persistence policy；
儲存同意不能代替向模型出口的同意，092 Grant 也不能代替出口批准。

本人 `approvals.create` 必須提供 consent:true，精確 Work／Run／Grant CAS、
maxOutputTokens 1–4096。伺服器導出 approval 的 owner/scope、完整 selection、
政策版本、context hash/bytes 與有效期（不超過一小時且裁切目前授權期限）。
不能由 caller 提供 prompt、policy、URL、model-ready boolean 或 credential。
批准可讀取、以 CAS 撤銷；撤銷不依賴 provider health 或出口政策仍允許。

context 唯一來源是當前 Work 的 title/objective，固定順序 UTF-8 JSON：
`{"schema":"model-step.context/v1","title":...,"objective":...}`。
包裝後實際大小最多 16 KiB；超過即拒絕，不截斷。沒有 Asset、檔案、瀏覽器、
MCP、caller instruction、隱藏上下文或 arbitrary URL。output 最多 16 KiB，
單次只能一個模型 call、一個 Step；無 fallback 或自動重試。

## 啟用、租約與一次性派送

`activate` 驗證真實配對 connection/family/runtime、目前 Work、ModelConnection、
不可變的原始 Grant、出口與儲存政策，再以私人 host 對明確 exact model 認證。
認證結果是 host WeakMap 管理的 opaque proof；序列化 JSON/ready 欄位不能取代。
credential resolver 必須綁完整 selection/custody/owner，proof 保留其私人 digest
與期限；沒有預設 model/provider/key 或 ambient environment credential。

單一交易加入真正 `execution_attempts.state=active`，保存完整 activation_binding，
建立 reserved Step，Run 從 created 變 running、Run version 與 taskLeaseEpoch
各加一，controlEpoch 不變。舊的 blocked Attempt 保留原內容；新舊 Attempt
共用同一份 1–16 次序和上限，不分表重設次數。092 Grant 保留原 consent snapshot，
新的 running/fence 快照放在 activation binding，沒有把前置同意偷偷改成執行權。

Step lease 最多 90 秒，裁切 Grant、approval、connection、family、host proof、
credential、外部 recovery 的期限；決策依 exclusive PostgreSQL clock_timestamp。
`begin` 在 commit 前先記錄 dispatched、消耗唯一 dispatch intent、保留用量預留，
再給新鮮的 private capability（最多五秒）。receipt 只有 metadata，沒有 capability
或原文。receipt replay 不會給新的 capability；ACK 遺失或重啟不能由 JSON 重建
proof，也不會取得第二個 Attempt、fallback 或再送一次。

host 在第一次 await 前消耗 in-process capability；讀 recovery/credential 後，
實際送出前再執行 privately captured 的 current DB backing/fence validator。
因此 begin 後已提交 Stop／Grant 撤銷的 capability 不會送出資料。每個資料庫決策
都重新核對當前政策、所有相關版本／epochs、family/connection 時效與會員 session；
receipt 寫入及實際索引等待跨越期限也必須回滾。

外部 recovery port 必須提供 positive signed-64 decimal generation 與 exact
millisecond expiry；不能由 DB 自己生成、由 request 注入或預設為一。verify、
派送與 Result finalization 都重新讀取受信任的 recovery，舊世代不得復用。
profile 不宣稱可用跨世代的恢復授權。host port 有有界等待，憑證私人 copy 用完
清零；provider error/帳號/key/raw body 不進 facts、receipts 或 public metadata。

## Transport 與未知結果

正式 host 只接 `user_byok`、`provider_remote`、`platform_vault`、platform engine
及 `platform_asset` artifact custody 的明確 OpenAI/Anthropic selection。先 GET 官方固定 `/v1/models/{exactModel}`
並核對精確回報 ID，再 POST 固定 OpenAI Responses 或 Anthropic Messages。
native HTTPS 不接受 redirect、caller fetch/endpoint、proxy environment 或 TLS
override。GET 認證及 POST 都有界；response 最多 32 KiB/256 chunks、30 秒，
fatal UTF-8／strict codec 拒絕 tool call、model mismatch、未完成或混合結果。

`local_keychain`／runtime_local 的 codec 保留，但這個中央 host 尚未取得 native
custody 證明，正式 transport 不支援。Codex/Claude 訂閱仍依 15 保留 unsupported，
不能把本機診斷成功當訂閱模型執行。fixture factory 只收 numeric loopback origin
和 local environment；caller 不可透過 wire 選 synthetic/production evidence。

dispatch 開始就視為 unknown；逾時、ACK 遺失、恢復變更、卡住或拒絕記錄都保留
unknown/reservation，不用「未看到成功」推出沒有送出或沒有費用。known token
usage 只表示精確回報 token 數字；貨幣費用 `costStatus:unknown`，不推導零元、
價格、退款或 entitlement。record 只接受綁原 consumed capability 的 opaque
observation，資料庫保存 digest、大小、exact reported model、usage、origin 等
metadata；文字只在私人 host memory，尚未完成 Asset finalization 的重啟不能重跑。

pause/stop 不需 provider health、export policy 或持續有效的 Grant。控制增加 Run、
task、control fences；reserved 可取消並釋放未派送預留，已派送未知結果仍保留預留，
Stop 使用 reconciling 而不聲稱已取消上游。晚到 observation／Result 不得發布。
舊 v1 Run read/pause/stop 對新的 Step Run 明確回 `execution_run_profile_required`；
舊 Attempt read 只接受 blocked profile，避免把 active 轉成 blocked DTO 或 schema 500。
新 `.read/.control` 提供該 Step 的真實狀態；新 HTTP/產品控制仍待接線。

## Typed Result、Asset 與人工改稿

[094](../../../../migrations/094_private_model_results.sql) 新增
`private_model_work_results`，來源 generated `model`，完整綁真正的 Step、Attempt、
dispatch intent、input/fences、exact selection、observed digest/bytes/usage/origin。
原 `private_work_results.provenance=human` 保留 generated 欄位，不接受 AI 偽裝人工。
共同 immutable identity index/catalog 提供一份 global revision 與 current pointer。
歷史成果含實際 provenance；讀取 AI 草稿另外標示 evidence origin 與未知貨幣成本。

[私人 finalizer](../../../../modules/agent-execution/model-results.ts) 第三參數是
private opaque observation，不是 public body。它使用既有 Asset lifecycle 的
work.private-draft purpose、新 work.model-result typed target、16 KiB profile，
完整 prepare/claim/write/verify/finalize 與 per-scope 共用 quota。Retained、orphan、
expired、retired Assets 仍計入配額；無自動 GC 或特殊免費通道。ObjectStore I/O
不持有 SQL 交易；write 後與 finalize 前重新檢查政策/Work/fences/recovery/credential。

SQL 的成功 Result INSERT 是唯一 Work CAS：inputWorkVersion→+1，共同 revision
+1、更新目前 pointer、finalize intent、Step succeeded、Run succeeded、facts/receipt
同交易完成。索引、receipt sink 等待後再核對實際時鐘、受限 trusted recovery/credential ports
與完成後的精確 Run/Work/fences（交易內不作 provider 請求或 ObjectStore I/O），
不能從過期 Step 發布。人工改稿或 archive 先提交，晚到模型成果就失敗；Asset 的
孤立內容仍沿原維護生命週期回收，不用覆蓋真人資料。人工接續 AI 的下一稿正常
增加共同 revision，AI／人工歷史仍可各自讀取，沒有自動對外發布。

已成功 finalization 的同 key replay 只回歷史 metadata，重新檢查本人 session、
onboarding 與目前 persistence policy；不重新派送、不寫 Asset、也不讀文字。
成功後撤銷出口／Grant 不抹除已存在的私人歷史，但不能授予任何新的 effect。
讀取文字沿既有 current policy/owner/object digest recheck，不靠 receipt 授權。

## 驗收與剩餘工作

完整 fixture 及反例結果見 [交付紀錄](implementation-status.md)。必須涵蓋完整鏈、
人工/AI 共同序列、once-only/ACK loss、撤銷後零 POST、未知結果、租約跨實際 SQL
等待、資料庫約束與 runtime role 權限；fixture 不改 triggers、不用 superuser runtime。

下一批是產品 HTTP 的用途/CSRF/來源/限流/嚴格 CAS、實際 Work/Run UI 與控制；
再接 server vault/recovery 的正式信任來源、受批准 exact provider/model 及真正
會員端驗收。訂閱 native host、execution machine auth、heartbeat/reconciliation、
多步排程、trusted CI/ReleaseSet、consumer 升級、staging、受控資料 migration 及
live 仍待完成。工程完成率與原 168 項產品驗收分開記錄，不用本機測試替代。
