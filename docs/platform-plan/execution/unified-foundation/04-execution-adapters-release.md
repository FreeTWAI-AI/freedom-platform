# 執行端與發布收尾規格

Spec ID：`UF-SPEC-EXEC-OPS`；狀態：`local-closed-run-and-enrollment`。來源：U3/U5/U6/U7/UX、CG-G、統一計畫 §04、08–16、18、29–30。本規格固定共用執行/發布邊界；AP/R2 原文已補齊，詳細 API/瀏覽器見 [BROWSER](06-browser-runtime.md)，七類搬遷見 [MEDIA](05-media-migration.md)。實際 runtime、capability 與 cloud/restore 證據仍由對應實作 PR 完成。

## 已有本機增量與界線

[Execution decision kernel](../../../../packages/execution-state/README.md) 已提供嚴格 schema、生成 JSON Schema、有界 decoder、狀態轉移與反例。它只計算 caller 宣告之事實的假設結果：所有回覆均為 `hypothetical_decision_only`／`operational_authority=false`，activation 固定 unavailable。沒有可信時間、身分／Grant 驗證、durable Run、SQL／HTTP、provider 或 dispatch，不接受其輸出作權限憑證。

具體 enum、轉移矩陣及三層驗證邊界見該 README；`npm run check:execution-contracts` 驗生成 bytes。舊 dispatch 的 recovery generation 與 task/control epochs 分別檢查，Stop 不要求模型健康；遲到 evidence 只能保留觀察，不能恢復 dispatch 或產生 Result。084 的人工 Result 不可作模型成果捷徑，仍須未來 typed attempt/Grant provenance 與 authenticated atomic adapter。下列正式產品規格與未解除依賴維持不變。

另有 [durable member Run](../../../../modules/agent-execution/README.md) 封閉內部服務：暫用 086 保存實際 personal Work/owner/scope FK 與不可變輸入版本，提供本人 create/read/pause/stop。Create 使用目前 085 metadata persistence policy；讀取與停止保留紀錄不受政策撤回或 Work 封存阻擋，仍須目前會員權限。控制使用 Run CAS、task/control epochs 與同交易 scoped facts/receipt，不更動 Work 版本。狀態僅 created/paused/cancelled，所有 DTO 的 `operational_authority` 為 false；它不是完整 RunSnapshot，也没有 runtime、Attempt、Grant、lease、dispatch、model、recovery authority 或 HTTP 接線。不得以待填字串、假預設 generation 或 nullable backing ref 取代真正的執行關聯。

[本機發布相容性診斷](../../../../deploy/cloudflare/release-compatibility.md) 已檢查精確 source/artifact 身分、完整 schema ledger、全部 active consumers 與資料形狀歷史下限；要求的能力包含 explicit Work wire、Asset bridge、personal ACL、human Result、085 server policy 及 086 closed Run。Host v2 另提供外部保留的歷史 ledger/capability floor；觀測和預計 schema 都須保留其 exact prefix，資料庫還原或更換 recovery generation 不能在診斷中清除此下限。Candidate 不能自帶批准或 host；一般 CLI 缺獨立可信 host port 就回 unavailable。Host 驗證／觀察 transport、歷史資料的持續保存及同 schema 下政策撤銷的還原對帳尚未完成。所有結果固定 deployment/execution authority 與 restore proof 為 false，不是正式 rollback 或 release gate 已完成。

## 最小 execution 核心

[Runtime 金鑰登錄](07-runtime-enrollment.md) 及暫用 087 已補封閉會員 begin/confirm/read/revoke。確認使用真正 ES256 挑戰簽章及目前會員權限，原子保存一次性消耗與 owner/key/environment 不可改綁的登錄；撤銷保留 tombstone。它只提供會員核准與持有金鑰的紀錄，不是 build/capability attestation、machine token、model connection 或 Grant；不能把 enrolled 狀態直接接成 execution authentication。

Work 表達目的，Run 表達一次邏輯執行，RunAttempt 固定 runtime、connection、Grant revision、inference binding、data policy、contract/adapter 版本及 billing source。`(run_id,attempt_number)` 唯一，attempt 的 work/scope 由 run 導出。歷史 binding 不原地更新。

Task lease epoch、browser control epoch、Grant/policy revision、deployment recovery generation 分欄處理。server 以目前值驗 permit；runtime 在外部 effect 前再驗本機 control、target incarnation 與未 dispatch 狀態。相同 tab/profile 的重疊 target 先 canonicalize 成相同控制資源，不能換 ID 逃避互斥。

| RunAttempt 操作 | 必須行為 |
| --- | --- |
| create/preflight | 明選 runtime/model/custody/billing，驗當前能力、Grant、data policy 與預算 |
| activate/advance | 只有目前 lease/fence 的 attempt 可推進；新 AI step 驗模型 ready |
| pause | 停止新 dispatch，保留已在途 evidence；不要求 provider 健康 |
| resume | 重新 preflight、觀察帳號/page generation，不能重用過期 node ref/permit |
| stop/revoke | 本機先 fence 未執行操作，再同步 server；離線遠端只能顯示停止待確認 |
| handoff/change binding | fence 舊 attempt，未知 effect 核對後開新 attempt；不改舊 model/費用資料 |
| late evidence | 只對既有 dispatch 提交大小/來源受限的 observation，不可重啟 effect 或擴大讀權 |
| finish | 全部已派 effect/Result 狀態可解釋；unknown 不得填成 success |

本機 enum／轉移矩陣已有上述封閉 decision 實作；正式 runtime 契約仍須在 EXEC-A 後續補齊目前身分／Grant、持久化、並發衝突、side effects、receipt 與可重試類別。server/native 以同一 vectors 驗證。不能只生成 DTO 或取得 hypothetical admissible 就宣稱可執行的狀態機完成。

## ActionIntent 與本機 journal

ActionIntent 區分未發出、已 dispatch、已知結果、unknown 與 reconciling。dispatch 前將 intent ID、target fingerprint、attempt/epochs、request digest 原子寫入 durable journal；MV3 memory 不作唯一紀錄。

網路/程序在外站 effect 之後斷線時，只補傳 evidence，不能自動再 click。若 intent 已 dispatch 而遠端無 dedupe 能力，timeout 是 unknown；同一工作開新 attempt 也不能把 unknown 清除。對帳保存證據來源，不能直接轉成 accepted/paid/published。

permit 固定 operation、effect family、target、內容摘要及適用 epoch/TTL。未知外站 fill/click 若無可靠 effect 分類，就 assisted/manual。正式付款、法律承諾、GitHub merge/deploy 等仍走各自原生權限及人類確認，不因有 ExecutionGrant 取得。

## 模型連線及 broker

InferenceBinding 分開 model engine location、provider processing location、artifact custody、credential custody、billing source。本人官方 CLI 在本機執行，不等於模型在本機處理。

最小 U4 可由 Agent Kit 的一條受測官方 CLI 或明選 BYOK 路徑產生文字草稿；實作前固定版本、能力證據及測試方式。不能以假 provider 回應當真實 AI 完成。CLI 不能有效限制內建工具時保持 assisted，不宣稱 managed browser execution。

broker 為同 repo 的獨立 Worker、private binding、窄 DB role 及 KEK。僅接受 `ModelStep(attempt_ref,step_ref,binding_ref,context_ref)`；不提供任意 URL/key/body proxy。重新驗 owner、active attempt/Grant、policy、step 唯一性及原子 budget reservation，不能因內網來源跳過。

同 step 的 provider retry 是 inference attempt，不是 RunAttempt 換裝置。timeout 若可能已計費，保留 unknown usage/reservation，先對帳才決定重試。CLI 額度不可觀測就顯示 unknown，禁止平台 key 偷補。Stop 後已在途 model response 可依 policy 收證或丟棄，不能再派 browser effect。

## Queue 及 outbox

PostgreSQL transaction 寫 domain state 與 outbox，commit 後 dispatcher 只送 job/attempt/intent ID、schema version 與必要 routing metadata。consumer 重新讀 DB state，以短交易 claim/lease，交易外做 I/O，再記錄結果並 ACK。

重複投遞、先 commit 後 ACK 遺失、dispatcher 送出後 crash、lease 過期均必測。需要業務唯一鍵、step reservation 與 fence，不能因 queue message ID 不同就重做效果。

model 與 asset maintenance 分 lane/權限，共用 transport library；各 worker 只取得自己的 binding。Stop/Revoke 走直接控制及本機 fence，不排重型 queue。queue backlog/unavailable 時 DB 仍為狀態權威，恢復時補 cursor，不創造第二份 job 真相。

Workers runtime 的 model step 最長時間、provider async 支援及 retry 上限需實測後固定；未有證據的長工作不以 waitUntil 當 durable completion。

## 三端與版本相容

TS/Rust 同源 wire schema、固定 canonicalization/reject vectors。標準 extension 使用 MV3/Native Messaging；neo 保留 Rust/backend/upstream build。adapter tools 隨受控 client 打包，平台不動態下發可執行 JS/WASM。

握手回報 supported families、operation/policy/adapter versions、ReleaseSet 及 capability evidence。unknown required policy、withdrawn release、wrong environment 或不相容 operation 拒絕新 effect；原安全 read、設定、Stop/Revoke 路徑保持可用。

跨 runtime 驗收：Chrome pause → 核對 unknown effects → neo 建新 attempt → 原 Work 及可合法讀的 Result 仍在 → 舊 permit 被拒。local-only artifact 不能自動搬上雲；缺資料回 custody blocker。裝置自行登入，不複製 cookie、CLI OAuth 或完整 profile。

## 信任與 key 用途

公開 trust profile 列 issuer/audience/typ/alg、key purpose、kid、環境、有效期、可信 keyset 來源與 freshness。不得接受 token 自帶任意 jku/x5u 下載；未知 kid 最多一次有界可信刷新，仍未知就拒絕。時鐘誤差及 TTL 由 profile 明確固定。

release 簽發、execution token/permit、device proof、site credential、provider key、vault KEK、R2 及 GitHub deploy 秘密用途分離。public client 不含 private/HMAC signing secret；connection ref 可重用但 broker 仍验 owner/Grant/policy。

rotation 先公布可信新 public key，再換 signer，舊 key 在明確窗口只驗不簽後移除。撤銷不受 semver 相容掩蓋；工作中不相容 policy 更新先 fence 舊 attempt，保留 late evidence，再重新 preflight。初版必有 wrong-purpose/environment、unknown-kid、downgrade、offline/restore fixtures。

## Migration v2 與 inventory 遷移

維持 numeric ID 到新 runner、deploy scanner、manifest 及 private helper 全部相容。新 ID grammar 需在獨立 PR 固定 timestamp 時區、精度、suffix、case 及 dependency metadata；舊 SQL name/digest 完全不動。

明確有相依的 migration 依 DAG 排序，缺 dependency/cycle/duplicate 拒絕；獨立 SQL 在不同合併顺序 replay 得到等價結果。不得只找 id 大於 latest。candidate manifest 由整組檔案及 legacy ledger 生成，兼容歷史 gaps。

公開 spec/fixture 只提供 private helper 的輸入輸出契約及測試結果欄位；grok 不可讀含秘密的實際 release 目錄。operators 需另跑其真實相容測試並提供 redacted evidence。若缺此證據，新命名不得進正式 migrations。

Inventory 從每 PR 移到 release/archive 需獨立 PR：先有可信 impact mapping、未知範圍 full fallback、release full inventory 與還原檢查，才調整現行 push 規則。在此之前依舊重產並驗證。

## 既有 shell 與 route 拆責任

UX 的 shell extraction 每個 PR 只抽一組責任，維持現有會員 session、navigation、權限提示及 URL 行為。API route safety profile 明分 member、execution、service、webhook；新增機器入口不能靠全域 CSRF/Origin 豁免接入。抽出前後跑相同登入/登出、深連結、module navigation 與 unauthorized route 案例，surface registry 不得減少入口覆蓋。

此工作先重讀 #85/#87/#100–103 的最新差異，保留作者現有 UI 工作；視覺改動依 repo DESIGN 與適用設計技能。首批核心不需要為了接新 module 整批重寫 App 或所有 routes。

## 發布與 restore

依 Ted 於 2026-10-02 的歷史指示，當時先完成原計畫 scope 再受控前向 migration；2026-10-03 已更新為 [基底優先](00-baseline-and-decisions.md#2026-10-03-基底優先的最新指示)，未驗收執行端維持關閉。不另做提早上線用的多版過渡 release，也不把退回舊應用程式當成發布策略。下列歷史資料形狀／復原要求仍約束資料安全，不代表要擴大成一項舊版維護工程。正式切換需停止不相容的舊 consumers，完成 schema/grants 及驗證後才恢復新程式；維護窗口另確認。

相容下限合併 Asset bridge、private ACL、execution evidence/reconciliation、credential purpose 及 vault 邊界。rollback 須能處理所有已啟用資料形狀，不只 UI 可開。U7 移除 legacy 欄位之前要證明受支援舊 client/舊資料均已退出。

restore 前 fence runtime；restore 環境預設停 dispatch。以不隨舊 DB snapshot 回退的環境 recovery generation 作新授權前提，恢復後增加 generation，再對帳 R2、撤銷/刪除 tombstones、outbox、provider unknown effects。不能靠還原同一 DB 欄位阻止舊 token 復活。

停止新 AI 執行時仍保留會員登入、Asset 讀取、人類控制/撤銷及有限 evidence 回收。一般媒體操作只在共用 Asset 故障時受影響。

正式 rollout 沿 Ted 既有順序：核對發布槽 → prepare 固定 SHA → staging/prod 備份 → staging 以 migrator 套 migration、grants-check/app-probe、部署 → 對應 prod 步驟 → health 核對 release_sha。若涉及 sync/cron，要有 staging 真正寫入證據。資料搬遷、schema、release、backup 不隨普通 PR 的新 CI run 被取消。

## 後續 PR 與未解除依賴

| PR | 主要交付 | 進入正式執行的必要證據 |
| --- | --- | --- |
| EXEC-A | RunAttempt/Grant/Control/Action/state transition schema | CORE、全部轉移及並發 fence vectors |
| EXEC-B | Kit 最小模型 adapter、私人草稿 Result | 明選模型的真實產稿、wrong owner/過期 Grant/人工改稿競態 |
| EXEC-C | outbox/Queues/broker | 窄權部署、provider timeout/unknown billing、duplicate delivery、Stop backlog |
| CLIENT-A | 標準 extension/native host | BROWSER 的 API/permissions、entrypoint audit、durable journal、packaged browser 測試 |
| CLIENT-B | neo guard/cockpit | neo 固定 source audit、全部 managed 可達入口、TS/Rust vectors、跨端 handoff |
| OPS-A | migration v2/private helper/完整 inventory | 雙 runner replay、legacy digest、redacted helper evidence |
| OPS-B | 七類 media backfill/restore；拆 MEDIA-A–F | 現行 profile 盤點、bridge、checksum/version race、DB+R2 備份對帳 |
| OPS-C | mixed versions/rotation/recovery/U7 清理 | supported matrix、withdrawn release、DB+R2 restore、舊 token 不復活 |

上述不是一次發出的派工授權。現有 runtime/環境證據缺口只阻擋相應 PR 的正式完成，不阻擋已固定核心的 coding/fixture 工作。所有產品案例目前 `not_run`；完整映射見 [共同驗收](acceptance.md) 及 [R2/AP 驗收](source-acceptance.md)。
