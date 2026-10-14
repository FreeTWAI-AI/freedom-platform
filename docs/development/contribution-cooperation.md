# 成果、角色署名與找合作

這個增量沿用社群 Work、Submission、Decision、Contribution 與會員名片。GitHub 件數保留原始作者，不把活動數換成信任度；沒有額外的貨幣、點數錢包、XP 或合作門檻。

## 會員使用

1. 「社群任務」先顯示本人已驗收工作與角色。每個 Work ID 只算一次；同工作多個角色或多次重送不加件數。同標題的不同 Work 保留各自紀錄。
2. 工作卡的「成果角色與署名」可留下本人的提案、設計、實作、測試與驗收、審查、文件、協調或服務交付。摘要、成果代號與分享同意必填，先標示「本人填寫 · 待確認」。GitHub 帳號不是必要條件。
3. 工作真的經既有流程驗收後，目前有效的 Work 驗收者可核對並確認別人的角色。已驗收交付者也可以確認該工作的發起人角色，讓發起人不用自己確認自己。這是明確的合作關係確認，**不是另任命驗收者、官方認證或履約保證**。其他旁觀者、自填 slug、公會職稱與活動榜名次不增加權限。
4. 修改摘要或引用後，狀態回到待確認；原確認 metadata 保留，不自動套到新版本。本人可撤回署名：會員展示與角色成果件數立刻移除；既有交付驗收事實不改寫。撤回是停止展示，沒有永久刪除承諾。
5. 「找夥伴」維持專長／公會搜尋與最新加入的預設排序，明示專長是本人填寫。展開名片可查看真的驗收成果、分工與確認人。新人沒有成果紀錄，不代表不可信；不需要 GitHub 才能被找到。
6. 實際合作的私人經驗回報沿用工作台現有「這次合作帶給我什麼」。只有原工作當事人能回報，敘述只有本人可讀；另一方只看整體回報狀態。沒有公開星等、沉默即同意或申訴自動扣分。

## GitHub 活動

活動榜依原始 Issue／PR 件數排序，計入開放、已關閉及未合併項目，展示同樣的已連結會員／頁面標記來源範圍。Issue「已關閉」不等於已解決；PR「已合併」不等於部署或會員驗收。未合併關閉另外標示。同步時間改為「最早來源同步時間」，不完整／無法讀取／舊快取各自明示。

舊公式 Issue × 5 + PR × 20 保存在預設收合的「舊版 GitHub 活動分」，只供追溯。不影響會員資格、獎勵、成果件數或合作名單排序。沒有從聊天紀錄推定角色、改 GitHub 作者或替任何人補造分數。

## API 與資料責任

需先套用 additive migration **163**，再換入這份 reader/writer；未啟用新的部署流程。新表只容許 `community_collaboration`，composite FK 同時綁 Work、community 和 member。私人／tenant Work 沒有 role child 或公開 reader。

| 入口 | 行為 |
| --- | --- |
| `GET /api/v1/me/contribution-outcomes` | 本人不同已驗收 Work，包含實際交付與已確認角色 |
| `GET /api/v1/members/:id/contribution-outcomes` | 同社群、目前可見名片的成果；匿名、不同社群、停用、未加入或封鎖對象不讀 |
| `GET /api/v1/work-items/:id/contribution-roles` | 同社群 Work 的署名分頁；他人撤回的文字與引用不回傳 |
| `POST /api/v1/work-items/:id/contribution-roles` | 本人宣告角色，需 `share_with_community: true` |
| `POST /api/v1/contribution-roles/:id/edit` | 本人修改摘要／引用，重新分享同意，`If-Match` 比對目前版本 |
| `POST /api/v1/contribution-roles/:id/withdraw` | 本人停止署名展示，`If-Match` 比對目前版本 |
| `POST /api/v1/contribution-roles/:id/confirm` | 合資格另一人確認指定 `payload_sha256`，`If-Match` 比對讀過的版本 |

原交付引用 `delivery_ref` 只回給交付者本人；查看他人成果仍可見已驗收事實與件數，但只能取得對方明示分享、目前已確認的角色 `evidence_ref`。未分享、待確認或撤回的角色不使歷史交付引用公開。

兩個 GET 清單均接受 `limit` 1–50、`offset` 0–10000；未知 query key 拒絕。新命令沿 member session、Origin、CSRF、Idempotency-Key、共享 `command()` transaction。UUID 大小寫使用相同 receipt namespace。body／Actor 在第一次 await 前 snapshot；changed body/key、CAS、原子 role／確認／journal／receipt 與 response-loss replay 分開驗證。domain 期限使用 `clock_timestamp()`，role/receipt 等待後重新檢查，journal 不包含摘要或成果引用。

新表和 confirmation metadata 登記到既有資料責任 catalog；保留期限仍沿 `policy_undecided`，沒有 GC、刪除排程、匿名公開成果或事件 consumer。官方公開名片不接入此會員 reader。修改／撤回後，舊確認不作新版本的權威；命令 receipt 只回歷史 ID/state/version/hash，UI 隨後讀目前狀態。

## Work 角色頁的 statement snapshot（#641、#645）

`/work-items/:id/contribution-roles` 將 Work scope／header、已驗收交付者、
角色 visibility、withdrawn／current confirmation、page selection 與
current review availability 放在同一 SELECT snapshot。Review relation
等待期間雙向 block 或撤回已成立時，不回較早挑出的署名文字／evidence；
predicate 在 LIMIT 前套用，會補上合法下一項並保留 page cursor，
不是晚到 filter 後回空頁或漏掉剩餘角色。

同一 statement 也讀目前 Work state／accepted_at／accepted_member：
驗收後才提交的新署名，不會配上驗收前的 header 或 false can_confirm。
原先獨立 Work metadata lookup、review lookup 及較早 state 參數已移除。
Member eligibility 仍沿既有 helper；Work 的同社群／community_collaboration
條件在主查詢套用。LEFT JOIN LATERAL 保留空角色頁的 Work header；
空清單或 offset 超出目前頁面不產生 null-role item、假 cursor 或 404。

Review availability 以 EXISTS 及 DB `clock_timestamp()` 判定，
未 accepted 時 CASE 不求值。Internal derived 欄位不進原 DTO。
Pending／self／Work state 與已驗收交付者確認發起人角色的窄 counterpart
條件不變；review 期限跨過時 can_confirm=false，有效時 true，
counterpart 權限不被 review route 期限代替。沒有重讀 loop、retry、
額外 table／pair lock 或第二 reader。

本人仍可讀 withdrawn retained role，第三人只讀目前可見項目；
這不是 erasure、私人交付 ref 公開、評分或付款。原 sharing／community／
mode／verification eligibility、command／receipt／default flag 不變；
既有 session 最終 DB 時鐘仍保留，歷史驗收事實不改寫。

Consumer 回歸覆蓋雙向 block／撤回的 limit=1 refill、有效控制、
review expiry／counterpart、驗收與新署名並行、實際確認或未驗收拒絕，
以及空清單／exhausted offset。Issue／PR 區分各次真實 HTTP 證據，
不等於 browser、trusted CI、merge、部署或完整 Foundation 驗收。

## 給 Ted 的審查重點

- 核對「已驗收交付者確認發起人角色」的窄條件；不接受自確認、替別人填角色或旁觀者授權。
- 核對原始 Work 驗收與角色確認分開，私人的合作回饋不匯出為信任分。
- 無全站信用排行、公開負評／星等、可轉移點數或回報獎勵。公開評價的保存、更正、申訴與營運政策仍需有權負責人定案，不能由這份 source PR 代替 #261。
- 歷史對話提案若要署名，需本人在對應 Work 填寫、由合資格另一人確認，沒有自動補造。
- Migration163 是額外表與 unique constraint，舊 community Work 欄位／receipt 不改寫。既有 schema162 與私人資料／媒體 reader 的回退下限仍適用；不要為撤回這個 UI 降級到不相容的舊 reader。
- 交付是可審查程式與本機真實測試；不代表已合併、正式站上線、長期會員留存或完整 Foundation 完成。

測試入口：`tests/runtime/contribution-roles.test.ts`、`tests/e2e/contribution-roles.spec.ts`、受影響的 `member-experience.spec.ts`；既有 flows、benefits、work-privacy、member-directory、tenant-data-catalog 保護相容性。
