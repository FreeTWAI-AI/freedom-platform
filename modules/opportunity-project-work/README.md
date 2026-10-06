# 工作模式與私人讀取

本模組的 WORK-A 隔離私人讀取與既有社群協作；WORK-B 的封閉增量新增 server-only 人類目的草稿 create/update/archive 命令。HTTP/UI 仍沒有私人建立、修改、封存、執行、成果、分享或發布入口；沒有任何正式 policy source 接線。這不是完整 WORK-B／Autopilot，也不是私人草稿已可正式使用的聲明。上游規格是 [資產與私人工作](../../docs/platform-plan/execution/unified-foundation/03-assets-private-work.md)。

## Schema 與相容決策

[Migration 077](../../migrations/077_work_scope_privacy.sql) 是合併前的暫用編號。既有 Work 的所有原欄位、ID、條款、hash、Claim、Review、Contribution 與 receipt 不重寫；新增 `work_mode` 預設 `community_collaboration`。舊社群資料仍可使用 null `scope_id` 的相容橋接；日後填 scope 必須由 composite FK 指向同一個真實 community，不能填其他人的 personal scope，也不能把已填的 scope 改綁。

`personal_execution` 必須使用真實 person principal、對應 user 及該 principal 的 personal scope。這些是 composite FK，不是只確認三個 ID 各自存在。私人 Work 的 `community_id` 明確為 null：會員目前參與哪個社群不構成此私有資料的 owner。這是本批的明示相容決策；既有社群分支仍強制 community 非空，API 原 response/receipt shape 由顯式欄位投影保留。

077 的私人分支只允許 `draft`；[暫用 migration 081](../../migrations/081_private_work_commands.sql) 保留 community CHECK 分支逐字不變，將 personal 擴成 `draft/archived`，不改已存在 migration 或資料值。協作條款、條款版本/hash、認領與完成期限、公共 gain/驗收欄位仍必須為 null；不填假的自願條款或自己認領自己的 Claim。SQL 要求私人 row 從 draft 建立，archived 後禁止修改／復原。`service_operation` 尚無 backing schema，SQL 拒絕此模式。Work ID、模式、owner 與已綁 scope 不能修改，也不能 DELETE 後以同 ID 重建；正式刪除與 tombstone/retention 流程留給後續規格。測試由自己的 `fp_*` schema teardown 清理。

Claim、Review route、Contribution 與 Benefit 的固定社群 discriminator 及 composite FK 拒絕私人 Work，即使錯誤程式直接送 SQL 也不能建成協作事實。既有社群程式仍逐一加模式 filter，並在 command replay 前再次驗 domain 權限。

部署限制：原 `3de70cc` 的 `workView` 使用 row spread，套 077 後舊 binary 可能額外回傳新增 metadata；不能把新 binary 的顯式投影測試當成舊新版混跑時的 byte-exact 證據。077 無 down migration，也尚無發布工具強制的 rollback floor。首筆真實私人資料出現後不可降回不支援其 shape/ACL 的 schema 或未核准 binary；啟用私人寫入前須補 OPS 回退政策與實測。

## 讀取介面與鎖

`GET /api/v1/me/private-work` 支援 `q`（標題 literal substring，最多 120 字）、`limit`（1–50，預設 20）與 `offset`（0–10000，預設 0）。單一 SQL snapshot 同時產生 owner-only count 與頁面；SQL statement timeout 為五秒。未知或重複 query key 拒絕，不接受 caller owner/scope。列表依建立時間及 UUID 降冪排序。

`GET /api/v1/me/private-work/:id` 只回本人的同 scope Work。兩個入口都經目前 user/session → principal → personal scope 的共享鎖，接著以 user、principal、scope、模式四者共同過濾；詳情再鎖 Work。撤銷先拿到鎖時，後來的讀取會看到停用並拒絕；已授權的短交易先完成時，撤銷等待它提交。沒有外部 I/O。管理員、公會長、好友或同社群都不增加私人讀權。

回傳只有 Work ID、title、objective、draft state、version、created_at。archived 不進 list/search/count/page，detail/HEAD 一律 404，沒有 archived listing/restore。函式在第一次 await 前 snapshot Actor，重新驗目前 onboarding，最後一次可能阻塞的查詢後用 DB `clock_timestamp()` 重驗 session，不以 transaction-start `now()` 放行已到期請求。內部 bigint 先保留字串精度，既有 HTTP version adapter 超過 safe integer 時受控拒絕，不能先被 JSON aggregation 四捨五入。回覆 `private, no-store`，不提供 ETag、可分享 URL 或物件 key；HEAD 同樣驗權，Range/條件標頭不產生略過授權的 206/304。匿名或過期 session 在共用 middleware 已被拒絕並回 no-store。

## 封閉人類命令 API

[private-commands.ts](private-commands.ts) 匯出 `createPrivateWorkCommands(pool, { resolvePolicy })`。這是受信任 server API，不是讓 caller 提供 scope、owner、policy 或 serialized VerifiedContext 的入口。

| 命令 | 本人 Actor 以外的輸入 | 成功 receipt |
| --- | --- | --- |
| `create` | `key`, `title`, `objective` | `workId`, `aggregateVersion: '1'`, `state: 'draft'` |
| `update` | `key`, `workId`, `expectedVersion`, 完整 `title/objective` | 同一 ID、遞增真實版本、draft |
| `archive` | `key`, `workId`, `expectedVersion` | 同一 ID、遞增真實版本、archived |

title 最多 120 字元／480 UTF-8 bytes，objective 最多 16 KiB；保留原文字與換行，拒絕空白-only、NUL／不允許的控制字元與孤立 surrogate。限制由 command validator 執行，不宣稱能防止任意受信任 DBA SQL。objective 是人類工作目的，不是 WorkResult、模型回應、Asset 或公開交付；也不接受自填 Grant/Run/provenance。未知欄位與錯誤 bigint 拒絕。缺版本 428、版本落後 412；已 archive 的 edit/replay 拒絕 409。

每個命令使用同一 `scopedMemberCommand` transaction：user → session → principal → personal scope → receipt advisory lock → Work（update/archive）→ trusted policy rows。所有命令先驗當前 member eligibility 及 exact owner/scope，才查 receipt；管理員、公會職務不增加權限。create 的 receipt target 固定本人 collection，Work UUID 只在第一次成功 run 中產生，因此同 key 重試不會新建 Work。update/archive 鎖真實 row 並 CAS `work_items.aggregate_version`，没有第二個版本計數器。

必填的 `resolvePolicy(q, context)` 只可讀本地／DB 政策，且須按上述鎖順序鎖住會改變的 backing rows 到提交；無網路 I/O。create/update 與其 replay 均要求 `platformPersistenceAllowed: true` 及有效政策 revision。這個 revision 只供當前 persistence 決策，不是已實作的歷史 execution policy binding。現有讀取仍以目前 member/owner/scope ACL 為準，不新增 persistence-policy 讀 gate。archive 不寫新 plaintext，也不呼叫 policy/provider，政策拒絕或來源故障時仍可隱藏自己的工作；失效身分仍不可 archive。

archive 是保留型終態，不是資料刪除：title/objective 仍留 SQL，不能宣稱履行 erasure/retention。歷史 create/archive receipt 只含 ID/state/version；update receipt 在 draft 期間可重播歷史 metadata，但不覆寫後續人稿，archive 後拒絕 update replay。receipt 沒有 title/objective，journal/outbox 明選的 data 只有 state；request 只存 digest，不存全文。三種 scoped fact 寫入若失敗，domain plaintext/state/version 一起 rollback。事件沒有 legacy community fanout 或新 consumer。

## 讀取與事件面清單

| 現有入口或資料面 | 保護與本批證據 |
| --- | --- |
| work-items、dashboard now/next、review queue | [work.ts](work.ts) 明確篩 `community_collaboration`；新欄位不進舊 response |
| dashboard gained、contribution-records、accepted-work | 與 community Work join，不能只信 contribution 的 community ID |
| task-board preview | [task-board.ts](../community/task-board.ts) 在 SQL 篩模式，並非前端隱藏 |
| Claim create/start/submit/review/decide | 查當前 community Work 後才讀 receipt；資料庫禁止 private Claim |
| Benefit read/write/replay | [benefits.ts](../results/benefits.ts) 的 participant 查詢只認 collaboration |
| private list/search/count/page/detail/HEAD | [private-work.ts](private-work.ts) 同交易驗目前資格及 exact owner/scope |
| private notification、activity、journal/outbox fanout | 封閉命令只寫 scoped ID/state/version metadata；legacy outbox/journal 保持零私人事實；沒有 scoped consumer、通知或 activity fanout |
| private create/update/archive | 僅 server module export，無 HTTP/native/MCP/queue 註冊；本人 current authority、scoped receipt、真實 Work CAS、archive terminal |
| private export、Result/Asset、share、Run、service | 路由未註冊，反例驗 404；未來新增時須另建 ACL 及 surface coverage |

[Module descriptor](freedom.module.json) 登記現有 HTTP/private-read 入口及封閉 command export。scoped producer 不等於任意新 consumer 可直接讀 Work；WORK-B 啟用寫入以前，須把新增結果、事件、通知、匯出與分享面補進同一清單及驗收。

## 本機驗證與未完成部分

[WORK-A runtime tests](../../tests/runtime/work-privacy.test.ts) 使用明確傳入的隔離 PostgreSQL URL 與新 `fp_work_privacy_*` schema；沒傳 URL 就拒絕啟動。反例涵蓋同社群/cross-community 枚舉、admin/officer、條件/HEAD、停用/過期、非法 composite refs、假 Claim/Contribution/Benefit、舊 receipt 越權及 bigint 溢位。既有 [flows](../../tests/runtime/flows.test.ts)、[benefits](../../tests/runtime/benefits.test.ts) 與 [CORE 映射升級](../../tests/runtime/resource-scopes.test.ts) 是相容回歸；075 snapshot 固定舊欄位，避免把新增 metadata 誤判成舊事實被改寫。

[人類命令測試](../../tests/runtime/private-work-commands.test.ts) 登記 `WORK-B-01`–`22`：真實 server create/update/archive、同 key 並行、不同 key CAS、archive/edit 競態、scope 撤銷、等 Work row/table lock 後 session 到期、Actor snapshot、三種 scoped fact 故障回滾、create/archive 收據故障不留半成品、政策拒絕／故障仍可 archive、正文不進 receipt/event、HTTP route absent，以及 075 → 081 原社群欄位不變。競態以 `pg_blocking_pids` 確認實際等待，不以 sleep 推定執行順序。

另有中央 `OpaqueId` 驗證反例，命令 suite 合計 23 項；實跑結果由[交付紀錄](../../docs/platform-plan/execution/unified-foundation/implementation-status.md)記載，這些測試不是 production/staging 證據。[人工 Result 內部服務](../autopilot-work/README.md) 已透過[共用 Asset 引擎](../assets/engine.md)實作，084 schema／讀取／競態有獨立測試；不是模型產稿，也沒有私人 Result HTTP/UI。模型/Grant、發布確認、正式資料回填、正式 policy source、rollback floor、備份及完整 retention 仍未完成。無 feature activation wiring 的結構性封閉維持不變，不能因 read ACL 和內部命令已存在就註冊私人 HTTP 寫入。

## Portal composition

The workbench, showcase/opportunity and engagement cards/forms live in
`apps/portal-web/src/modules/WorkbenchPanel.tsx`, `ShowcasePanel.tsx` and
`EngagementPanel.tsx`. `App.tsx` selects these panels inside the existing member
provider. Shared session/client types and error formatting live in
`portal-session.tsx`; shared feedback components live in `portal-feedback.tsx`.
These leaf modules never import `App.tsx` or create a second client/session.
The shell retains the mutation lock, idempotency-key lifetime and session expiry
callback. Feature extraction does not create a new authorization boundary.
