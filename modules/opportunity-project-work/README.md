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

## 本人貢獻紀錄的 session lifetime 與分頁（#632、#667）

`GET /api/v1/me/contribution-records?limit=20&offset=0` 驗證整數 query，
`limit` 預設 20、最高 50，`offset` 不得為負數。回應保留
`accepted_work_facts_v1`、完整 `accepted_count` 與原 entry 欄位，並以
`next_offset` 明示下一頁；空白尾頁仍回傳精確總數。accepted-work
statement 先固定本人的 community collaboration facts，再以
`accepted_at DESC, contribution_id DESC` 穩定排序，應用層不再載入完整歷史。

Reader 重用 [readWithMemberSession](../../packages/db/member-session.ts)，只使用
同一 native client。最後 domain SQL 後以 DB `clock_timestamp()` 驗目前
session；等 Contribution／Claim／Decision relation 跨過期限時回
`401 session_expired`，不回 partial page 或本人 Contribution／Claim／
Decision／acting profession membership 引用，沒有裸 Pool read、舊路徑或
第二個授權 facade。

有效登入保留本人 accepted facts，另一位有成果會員的引用不回；session 到期
不刪除或改寫已成立的驗收事實。Community accepted-work 的共享摘要不是本人引用
reader 的替代品；discovery preview／shared feed policy、Work 模式 filter、
command／replay、scoring 與收入規則沒有改動。紀錄不是 XP、報酬、銀行實收或
付款證明。

[flows consumer 回歸](../../tests/runtime/flows.test.ts) 覆蓋跨頁穩定排序、
非法 query、空白尾頁、兩位會員隔離，以及原生 Claim relation 等待與 DB
期限的到期／有效控制。本機真實 HTTP／PostgreSQL 對照與選用 suite 的實跑結果
列於 Issue／PR；不等於 trusted CI、完整 requirement 驗收、merge 或部署。

## Task-board 探索窗口的決策時鐘（#637）

`GET /api/v1/task-board/preview` 的 claim-window eligibility 使用 DB
`clock_timestamp()`，不使用 statement／transaction 起始的 `now()`。
Work relation 等待跨過窗口後，不再把已到期的 open Work列為可認領預覽。
有效窗口保留原 safe DTO、community／collaboration mode filter、排序與
12筆上限；未完成 onboarding的會員仍可讀這個窄探索面，沒有增加 owner、
Claim、條款、private Work或會員資料。

窗口到期不改寫 Work state／version、不抹除既有 Claim，也不能由 future
delivery `due_at` 代替；canonical五種時間見
[domain invariants §11](../../docs/platform-plan/03-domain-events-state-machines.md#11-model-驗收不變量)。
這是 preview決策時鐘，不替代 Claim write／receipt邊界；沒有改 command、
replay、UI、onboarding entry gating、scoring或付款規則。

[member-experience consumer 回歸](../../tests/runtime/member-experience.test.ts)
以原生 Work relation wait與真正DB期限涵蓋 onboarding到期／有效控制、
safe DTO與事實保留；真實HTTP同時對照完整會員及onboarding兩種身分。
Issue／PR列本輪實跑範圍；source／HTTP證據不等於browser視覺、trusted CI、
merge或部署。

## Portal composition

The workbench, showcase/opportunity and engagement cards/forms live in
`apps/portal-web/src/modules/WorkbenchPanel.tsx`, `ShowcasePanel.tsx` and
`EngagementPanel.tsx`. `App.tsx` selects these panels inside the existing member
provider. Shared session/client types and error formatting live in
`portal-session.tsx`; shared feedback components live in `portal-feedback.tsx`.
These leaf modules never import `App.tsx` or create a second client/session.
The shell retains the mutation lock, idempotency-key lifetime and session expiry
callback. Feature extraction does not create a new authorization boundary.

### 社群工作清單查詢（#349）

`listWorks` 使用明確欄位與原排序 `created_at DESC, work_item_id`；本人 Claim
以 `work_item_id = ANY(...) AND claimant_ref = ...` 批次讀取，再以
`DISTINCT ON (claim_id)`／`revision DESC` 讀取最新 Submission。有工作的清單最多
三次 domain SQL（沒有本人 Claim 時兩次，空清單一次）；另有 session 驗證與交易
SQL。DTO、回饋、條款、驗收安排與社群／工作模式可見性不變，Submission 的內部
`claim_id` 不加入回應。

`GET /api/v1/work-items` 仍回 preview v1 的完整 `{items}`，既有外部 consumer
不會被靜默截斷。`freedom.preview/v1` revision `0.4.1` 新增
`listWorksPage`／`WorkPage`：`GET /api/v1/work-items/page` 每頁最多回 24 筆
`{items,next_cursor}`；續頁以 `?cursor=` 原樣送回 opaque cursor。Cursor 綁定
`created_at DESC, work_item_id ASC` 的兩個排序鍵，時間保留 PostgreSQL 六位小數，
同一毫秒內的列不會遺失或重複。格式不正確、重複或未知 query 均回 422；cursor
不是授權，續頁仍逐次重驗目前 member session 與 community。

分頁端點接受 `scope=all|open`（預設 `all`，保留 Workbench 原始範圍）與 `search`
（trim 後最多 2,000 字）。`open` 同時要求 open state 與尚未到認領期限；
搜尋在 title、objective、gain 的合併文字上做不分大小寫的 literal substring，
`%`／`_` 不是 wildcard。兩個條件都在 SQL 排序／LIMIT 前套用，不只搜尋目前 24 筆。
TaskBoard 預設明送 `open`；切換條件重新從第一頁讀取，續頁沿用同一組條件。
搜尋輸入採 250ms debounce，新的條件／重新整理會淘汰舊讀取與續頁回應。

`WorkbenchPanel` 與 `TaskBoardPanel` 顯示第一頁，並以小型次要按鈕按需載入較早工作；
續頁失敗保留已載入內容供重試。`dashboard.now` 改用本人所有尚未 accepted 的 Claim
專用查詢，所以較舊認領不受 catalog 頁面限制；`review_queue` 仍按目前 reviewer
安排直接取完整目標 Work 與最新 Submission。`dashboard.next` 只投影最新 24 筆 open
工作，不再為這個建議區讀完整 catalog。DTO、回饋、條款、驗收安排及社群／工作模式
可見性不變，Submission 的內部 `claim_id` 不加入回應。

`flows.test.ts` 以真實 PostgreSQL／HTTP 驗證 legacy 完整清單、24 筆邊界、多頁不漏不重、
同毫秒六位小數排序、錯誤 cursor、較舊本人認領、dashboard 上限及分頁 session 到期；
批次 Claim／Submission 等價案例與待回饋 0／1／6 筆反例保留。瀏覽器回歸另在桌面
Workbench 與手機 TaskBoard 實際載入第二頁，不以 mock forwarding 代替產品行為。
此瀏覽器回歸亦涵蓋 29 筆較新已關閉工作後的舊 open 工作、literal 搜尋、
全部範圍的有界續頁，以及較舊搜尋回應延遲抵達時不能覆蓋目前結果。
`preview-protocol.test.ts` 另以生成 SDK 呼叫分頁端點並驗錯誤 cursor；bundle、
OpenAPI、SDK 型別與 runtime protocol 由同一 `definition.mjs` 重新產生。外倉仍由
各自維護者審查並更新來源 pin，本輪不代替它們發布。

### 舊版會員投影的 session lifetime（#607）

`GET /api/v1/work-items` 不只有社群 Work，還有本人的 Claim／Submission；
`GET /api/v1/dashboard` 也有 gained 及指定 reviewer 的待驗收 Submission。兩個
server reader 都重用 `readWithMemberSession`，完整 database-only 投影使用同一
原生 transaction client，在最後 domain SQL 後驗目前 session 決策時鐘。
dashboard 內部共用 query-only 投影，不巢狀呼叫另一 public reader。

Review 可用性／review_queue 保留原本每個 SQL statement 的時間語意：
`statement_timestamp()` 不會像移入交易後的 `now()` 固定在整個交易起點。這不
改 review 規則、claim／receipt、community_collaboration 篩選、私人／tenant Work
或完整清單契約，也沒有加入 pagination、上限或外部 I/O。

Consumer regression 以實際 PostgreSQL 阻塞與資料庫時鐘驗證本人最後 Submission、
dashboard 後段的 session 到期／有效，以及有效 session 的 Review 期限在兩段 SQL
之間到期。Runtime、loopback HTTP 與部署驗收是分開的證據，不能由 source 推定已部署。


### 舊版驗收命令的 reviewer 決策時鐘（#617）

`begin-review`／`decide` 仍要求同社群協作 Work 的指定 reviewer，禁止自己驗收。
`scopedClaim` 沿原順序取得 Review route 的共享鎖，鎖取得後才用資料庫
`clock_timestamp()` 驗 `valid_until`；不以交易起點或鎖等待前的時間授權。
兩個 reviewer 命令重用既有 command 的 domain revalidate hook，在 receipt SELECT
等待後／重播前及最後 receipt INSERT 後重驗目前 reviewer。Session 與 reviewer
期限是兩個不同邊界，不用其中之一代替另一個。

到期回既有 `403 review_authority_required`。新命令的 Claim／Work state、version、
Decision、Contribution、journal、outbox 與 receipt 一起 rollback；合法舊 receipt
保留但不能在過期安排下重播。安排恢復有效後可用原 key 恢復／重播，不重複事實。
本人 start／submit、撤銷、self-review、版本與 Submission digest 契約不改，沒有
migration、retry、外部 I/O 或私人／tenant Work 授權擴充。

`flows.test.ts` 的 consumer regression 用原生 claim／review route 列鎖、Decision INSERT、
receipt INSERT／SELECT 等待與 DB 時鐘，涵蓋到期／有效、整組事實 rollback、
合法歷史 receipt 保留、原 key 恢復及重播不重複。Loopback HTTP、runtime、
source 與部署是分開證據；本節不宣稱已部署或 Foundation 整體驗收完成。

### 雙方私人商機與合作讀取的 session lifetime（#621）

`GET /api/v1/opportunities` 與 `GET /api/v1/engagements` 含雙方私人需求、
合作條款、交付 ref 與自填／對方確認的收款觀察 evidence。兩個 reader 重用
`readWithMemberSession`，完整 domain SELECT 使用同一原生 transaction client，
取得投影後再以資料庫決策時鐘驗 session；SQL 等待跨過期限回 `401 session_expired`，
不返回私人資料。有效者的 `{items}`、完整清單／排序、雙方／community 篩選、
版本、decimal 文字與 receipt 狀態不改，沒有加入 pagination 或 limit。

`flows.test.ts` 的 consumer regression 驗兩個讀面的原生 SQL 阻塞與 DB 期限、
有效等待後的原投影、不同 provider／同 client 合作隔離；fixture 沿真實 API 完成
showcase → 商機 → 提案 → 同意 → 交付／驗收 → 自填／對方確認收款觀察。
這些不是 Seller／bank 實收或平台代收事實；command／receipt 契約、公開 showcase、
私人／tenant Work、migration 與付款能力不變。Loopback HTTP、runtime 與部署
證據分開，本節不宣稱已部署或 Foundation 整體完成。

### 新認領窗口與歷史 receipt（#626）

依 [五個時鐘的 invite／claim 規則](../../docs/platform-plan/03-domain-events-state-machines.md#11-model-驗收不變量)，
窗口到期不能建立新 Claim，但不抹除已成立的 Claim。`claimWork` 在原 Work 列鎖
取得後以 native DB `clock_timestamp()` 驗窗口，並重用既有 command 的 domain
revalidate，在新認領的最後 receipt INSERT 等待後再驗。

只有本次 request 實際進入新 domain run 才啟用最後窗口 gate；原合法 receipt
不重新取得 availability 資格，但仍經原目前身分／Work 模式與 session 保護。
新認領若在 Claim／receipt INSERT 等待期間過期，以既有 `409 claim_window_closed`
拒絕，Work state／version、Claim、journal、outbox、receipt 一起 rollback。
已成立認領仍可 start／submit；原 key 回歷史 response，不重寫目前 Claim state。

`flows.test.ts` consumer regression 用原生 Work 列鎖、Claim／receipt INSERT、
receipt SELECT 等待與資料庫期限，驗到期／有效、整組 rollback，以及過期歷史
重播後仍可 start、再次重播不回寫已前進的 state／version。排他認領、terms
revision／hash、版本、模式與本人／self-claim 契約不改；沒有新增窗口延長、
policy、migration、retry 或外部 I/O。Loopback HTTP／runtime 不代表已部署，
本節不宣稱 Foundation 整體驗收完成。

### 第一人稱效益私稿的 session lifetime（#628）

`benefitView` 是社群 Work 兩位參與者的本人敘述／evidence／工時及 outcomes
彙總，不是公開私稿、獨立收入核實或 Contribution。完整 Work → Claim →
最新 Observation → DTO 重用 `readWithMemberSession` 的同一原生 client，
最後 SQL 後驗資料庫 session 時鐘。到期回 `401 session_expired`，不回私稿
或 Observation ID，也不讓原 route 發出成功 ETag；有效者保留原 DTO／ETag。
其 query-only helpers 只接 native PoolClient，不保留裸 Pool 的舊讀取路徑。

`benefits.test.ts` consumer regression 驗初始 Work／最後 Observation 的真實 SQL
等待、到期／有效、If-None-Match、私稿及 ETag 邊界；兩參與者只見本人正文與
彙總，第三成員仍 404。原 append-only／supersede／command receipt、缺稿 unknown、
self_reported／independent_people_verified=false／income_verified=false、
私稿不進 journal／outbox、Work 模式與 Contribution／付款語意不變。

本項保留 full affected scope。整合候選在既有 Work descriptor 補齊 benefits
route／runtime test 的 ownership；原 baseline 缺項仍保留 `surface_unmapped`
與完整測試 fallback，不以 candidate 宣告反向批准 baseline。此 metadata 修正
仍由正常 CI／維護者 review 核對；沒有 migration、retry、provider 或已部署／
整體完成的宣稱。

## Tenant manual Work

Tenant Work is the `tenant_execution` mode of the same `work_items` table. It is not a personal draft and not a community collaboration. `tenant-work.ts` reads and `tenant-work-commands.ts` creates, replaces, and archives. The author is `owner_ref`; `owner_principal_id` and `community_id` stay null. Placement (`tenant_id`, `instance_id`, `workspace_id`, `created_by_principal_id`) is frozen. Archive is retained and terminal. HTTP is `apps/platform-api/src/routes/tenant-work.ts`, mounted only while guild launchpad is enabled. Owners and admins use the existing Work role template. Operators and viewers require active ordinary grants on the addressed instance; tenant-wide admission happens before lookup, unreadable id-addressed targets use the existing 404, and a missing requested instance key is 403. Workspace routes check their bound instance. Commands authorize before receipt lookup; Result commands also repeat target authorization after each receipt read/write and after external storage I/O.

New writes (create, save, result prepare, write, and finalize) lock the bound module instance `FOR SHARE` and then its deployment `FOR SHARE`. Both must be `active`, or the write returns 409 `work_instance_unavailable`. Manual-work enable on an already-bound workspace uses the same check. Reads are unchanged. Archive does not consult instance status. There is no reopen command. Tenant lock order, skipping locks a path does not use: tenant scope, receipt advisory, workspace, instance then deployment, capacity-policy advisory then policy row, dimension advisory, asset quota advisory, upload intent, work row. Enable takes guild membership `FOR SHARE` after the policy lock. Private reads go through `withTenantRead` in `packages/resource-scopes` (`forUpdate: false`, `tenantWorkCapabilities`). That helper calls `assertCurrentSessionClock` after a successful read.

### 製作企劃內容格式

非商務製作公會的[企劃與版本工作台](../guild-workspace/production-dossier.md) 是這條 tenant Work／immutable 文字 Result 路徑的具型別 UI。Work 的 title／objective／progress 保持獨立；brief、鏡位與版本記錄保存為 `freedom.production-dossier/v1` Markdown Result，沒有新的 project table、API 或 module pin。一般附件與製作快照共用 Result revision 序列，`current_result_id` 仍指最新任意 Result；reader 須按分頁與 Work source version 找最新可辨識快照，不把檔名或 pointer 當專用 dossier 權威。

素材引用綁同 Work 的實際 Result ID／revision／digest，或自填外部位置與版本；交付清單凍結引用，回饋綁該交付 ID／版本。原檔媒體與客戶核准未接線，自填使用權或外部回饋不產生核實事實。建立 Work 與首份製作快照分兩次命令；附件保存與登記引用也分兩次，後一步失敗保留同一 Work／既有 Result 供續作。412 不丟草稿。完成後若須重開，使用 `progress=done`；archive 仍是一般入口不可重開的保留終態。

入口權限沿 [tenant-capabilities.ts](tenant-capabilities.ts)；前端的 instance health flag 不取代會員 template／同 instance grants。內容格式、原始 bytes／BOM 與版本 fence 的 unit tests 由 guild-workspace 擁有，既有 tenant authority／Result schema 測試繼續保護本模組的寫入邊界。
