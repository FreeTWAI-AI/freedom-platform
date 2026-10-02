# 工作模式與私人讀取

本模組的 WORK-A 實作先隔離私人讀取與既有社群協作。私人工作只能由合成測試 fixture 建立；產品沒有私人建立、修改、執行、成果、分享或發布入口。這不是完整 Autopilot，也不是私人草稿已可正式使用的聲明。上游規格是 [資產與私人工作](../../docs/platform-plan/execution/unified-foundation/03-assets-private-work.md)。

## Schema 與相容決策

[Migration 077](../../migrations/077_work_scope_privacy.sql) 是合併前的暫用編號。既有 Work 的所有原欄位、ID、條款、hash、Claim、Review、Contribution 與 receipt 不重寫；新增 `work_mode` 預設 `community_collaboration`。舊社群資料仍可使用 null `scope_id` 的相容橋接；日後填 scope 必須由 composite FK 指向同一個真實 community，不能填其他人的 personal scope，也不能把已填的 scope 改綁。

`personal_execution` 必須使用真實 person principal、對應 user 及該 principal 的 personal scope。這些是 composite FK，不是只確認三個 ID 各自存在。私人 Work 的 `community_id` 明確為 null：會員目前參與哪個社群不構成此私有資料的 owner。這是本批的明示相容決策；既有社群分支仍強制 community 非空，API 原 response/receipt shape 由顯式欄位投影保留。

私人分支目前只允許 `draft`，協作條款、條款版本/hash、認領與完成期限、公共 gain/驗收欄位必須為 null；不填假的自願條款或自己認領自己的 Claim。`service_operation` 尚無 backing schema，SQL 拒絕此模式。Work ID、模式、owner 與已綁 scope 不能修改，也不能 DELETE 後以同 ID 重建；正式刪除與 tombstone/retention 流程留給後續規格。測試由自己的 `fp_*` schema teardown 清理。

Claim、Review route、Contribution 與 Benefit 的固定社群 discriminator 及 composite FK 拒絕私人 Work，即使錯誤程式直接送 SQL 也不能建成協作事實。既有社群程式仍逐一加模式 filter，並在 command replay 前再次驗 domain 權限。

## 讀取介面與鎖

`GET /api/v1/me/private-work` 支援 `q`（標題 literal substring，最多 120 字）、`limit`（1–50，預設 20）與 `offset`（0–10000，預設 0）。單一 SQL snapshot 同時產生 owner-only count 與頁面；SQL statement timeout 為五秒。未知或重複 query key 拒絕，不接受 caller owner/scope。列表依建立時間及 UUID 降冪排序。

`GET /api/v1/me/private-work/:id` 只回本人的同 scope Work。兩個入口都經目前 user/session → principal → personal scope 的共享鎖，接著以 user、principal、scope、模式四者共同過濾；詳情再鎖 Work。撤銷先拿到鎖時，後來的讀取會看到停用並拒絕；已授權的短交易先完成時，撤銷等待它提交。沒有外部 I/O。管理員、公會長、好友或同社群都不增加私人讀權。

回傳只有 Work ID、title、objective、draft state、version、created_at。內部 bigint 先保留字串精度，既有 HTTP version adapter 超過 safe integer 時受控拒絕，不能先被 JSON aggregation 四捨五入。回覆 `private, no-store`，不提供 ETag、可分享 URL 或物件 key；HEAD 同樣驗權，Range/條件標頭不產生略過授權的 206/304。匿名或過期 session 在共用 middleware 已被拒絕並回 no-store。

## 讀取與事件面清單

| 現有入口或資料面 | 保護與本批證據 |
| --- | --- |
| work-items、dashboard now/next、review queue | [work.ts](work.ts) 明確篩 `community_collaboration`；新欄位不進舊 response |
| dashboard gained、contribution-records、accepted-work | 與 community Work join，不能只信 contribution 的 community ID |
| task-board preview | [task-board.ts](../community/task-board.ts) 在 SQL 篩模式，並非前端隱藏 |
| Claim create/start/submit/review/decide | 查當前 community Work 後才讀 receipt；資料庫禁止 private Claim |
| Benefit read/write/replay | [benefits.ts](../results/benefits.ts) 的 participant 查詢只認 collaboration |
| private list/search/count/page/detail/HEAD | [private-work.ts](private-work.ts) 同交易驗目前資格及 exact owner/scope |
| private notification、activity、journal/outbox fanout | 此批無私人 producer；fixture 插入後 shared outbox 無私人 sentinel；不宣稱未來 producer 自動安全 |
| private export、Result/Asset、share、Run、service | 路由未註冊，反例驗 404；未來新增時須另建 ACL 及 surface coverage |

[Module descriptor](freedom.module.json) 登記現有 HTTP/private-read 入口。無私人 producer 不等於任意新 consumer 可直接讀 Work；WORK-B 啟用寫入以前，須把新增結果、事件、通知、匯出與分享面補進同一清單及驗收。

## 本機驗證與未完成部分

[WORK-A runtime tests](../../tests/runtime/work-privacy.test.ts) 使用明確傳入的隔離 PostgreSQL URL 與新 `fp_work_privacy_*` schema；沒傳 URL 就拒絕啟動。反例涵蓋同社群/cross-community 枚舉、admin/officer、條件/HEAD、停用/過期、非法 composite refs、假 Claim/Contribution/Benefit、舊 receipt 越權及 bigint 溢位。既有 [flows](../../tests/runtime/flows.test.ts)、[benefits](../../tests/runtime/benefits.test.ts) 與 [CORE 映射升級](../../tests/runtime/resource-scopes.test.ts) 是相容回歸；075 snapshot 固定舊欄位，避免把新增 metadata 誤判成舊事實被改寫。

實跑結果由交付紀錄記載；這些測試不是 production/staging 證據。私人 mutation 的命令命名空間、expected version、Result/Asset、模型/Grant、發布確認、正式資料回填、rollback floor 與 retention 都尚未完成。不能因讀取 ACL 已存在就開私人寫入。
