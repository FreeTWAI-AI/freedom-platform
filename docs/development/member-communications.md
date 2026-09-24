# 會員通知、閒聊頻道與站內私訊

會員在「設定 → 我的訊息」裡的通知、閒聊頻道與私訊，資料存放在中央 PostgreSQL（migration 035、037），由 `modules/member-communications/` 負責。這裡只有站內紀錄：不寄 email、不推播、不連外部服務，也不回填歷史事件。四個分區與完整路徑見 [會員設定、待辦與訊息](member-settings-messages.md)。

## API（全部需要會員登入並完成定位）

分頁參數一律是 `limit`（1–50，預設 20）與 `offset`（0–10000，預設 0）；未知查詢參數回 422。通知與私訊列表都是新到舊，同時間以 UUID 由大到小排序；頻道訊息依交易內配置的序號由大到小排序。未讀數在同一個資料庫快照內計算，不受目前頁數影響。GET 不會標記已讀。

| 方法與路徑 | 回應 |
| --- | --- |
| `GET /api/v1/me/notifications` | `{items: Notification[], unread_count, next_offset}` |
| `POST /api/v1/me/notifications/:id/read` `{}` | `{notification_id, read_at}`；只能標自己的通知，已讀再標回原時間 |
| `GET /api/v1/me/conversations` | `{items:[{participant, can_send, last_message, unread_count}], unread_count, next_offset}`，依最後一則訊息排序 |
| `GET /api/v1/me/conversations/:userId/messages` | `{participant, can_send, items: Message[], unread_count, next_offset}`；還沒對話時回空陣列，可直接開始撰寫 |
| `POST /api/v1/me/conversations/:userId/messages` `{body}` | `201 Message` |
| `POST /api/v1/me/conversations/:userId/read` `{}` | `{user_id, read_at, updated_count}`；只標對方傳給自己的未讀訊息 |

DTO 定義在 `modules/member-communications/types.ts`。時間是 ISO 字串；`avatar_url` 只在對方目前可見且有頭像時給既有的 `/api/v1/members/:id/avatar?v=` 路徑。回應不含 email、聯絡方式或任何 token。

POST 走既有的 Origin、CSRF 與 `Idempotency-Key` 規則，不需要 `If-Match`。同一個 key 搭配不同內容回 `409 idempotency_conflict`；重送會先重新檢查目前資格，再回相同結果。

## 服務層授權、鎖與快照

路由仍掛在共用的 session、Origin、CSRF 與定位 middleware 之後，但服務函式不信任傳進來的 `Actor`：直接呼叫、或驗證後才被撤銷的請求，也會在服務層重新以資料庫目前狀態判斷。

- **讀取**（`listNotifications`、`listConversations`、`conversationMessages`）：在 `BEGIN ISOLATION LEVEL REPEATABLE READ` 交易的第一步先 `FOR SHARE` 鎖會員列（`user_id`＋`community_id`＋`active`），再 `FOR SHARE` 鎖 session 列（未撤銷、未過期），順序與 `command()` 相同（先 users 再 sessions，不反向）。停用、跨社群、撤銷或過期回 `401 session_expired`；定位資格改由剛鎖住的會員列判斷，未完成回 `403 onboarding_required`。計數與分頁仍在同一快照內，GET 不寫任何領域資料。因為 `FOR SHARE` 不能在 `READ ONLY` 交易執行，所以拿掉了 `READ ONLY`，快照不變。
- **與撤銷同時發生**：讀取若先拿到鎖，會排在撤銷之前完成（撤銷等它提交）。若撤銷已提交或先拿到鎖，讀取等待後，快照看到的是舊列而 PostgreSQL 回 `40001`；整個讀取以新交易重跑（最多 3 次，只限這三個讀取），重跑時看到撤銷而拒絕。不會回傳內容，也不會把原始 `40001` 丟出；3 次都衝突時回 `503 communications_busy`。
- **指令**（`markNotificationRead`、`markConversationRead`、`sendDirectMessage`）：`command()` 已先鎖會員列、再鎖 session 列；授權 callback 只在同一交易內用已鎖住的會員列重新確認定位資格（`currentMember(q, actor, false)`，不再鎖 session），之後才查 receipt。所以定位被重設後，重送舊 key 也回 `403 onboarding_required`，不會回放舊結果。私訊重送另外會以 `FOR SHARE` 重新確認收件者可收訊（`409 recipient_unavailable`）。
- 對方停用或未完成定位時，自己仍能讀取既有對話與標已讀（只檢查「自己」的資格，不改變上面的私訊規則）。

## 私訊規則

- 雙方都必須是同一社群、啟用中且已完成定位的會員；不能傳給自己。不需要先成為好友。
- 內容是純文字：前後空白會去掉，換行統一為 `\n`，長度 1–2000 字（以 Unicode 字元計）。不解析 HTML／Markdown，也不抓取網址；前端必須當文字顯示。
- 找不到、跨社群、或未完成定位且沒有往來紀錄的會員一律回 404，無法分辨。已有對話但對方已停用或尚未完成定位時，自己仍能讀取、標已讀，`can_send` 為 `false`，傳送回 `409 recipient_unavailable`。
- 每位傳送者 60 秒內最多 20 則新訊息（`429 message_rate_limited`）。同一傳送者的傳送以 advisory lock 排序，同時送出也不會超過；重送既有 key 不計次、也不會被擋。收件者以 `FOR SHARE` 鎖定，雙向同時傳送不會互鎖。
- 私訊不產生通知（避免未讀重複計算）。訊息內容不寫入 command receipt 或 transition journal；receipt 只保留 `message_id`。

## 公會與小隊頻道

`channels.ts`、`channel-types.ts` 與 migration 037 提供頻道。列表從有效成員資格產生；沒有聊天紀錄的頻道也會出現，第一次發言才建立儲存列。頻道 key 與歷史收據都不能授予存取權。公會頻道開放給一般有效成員，與既有幹部議事廳的權限分開；自建公會另檢查同社群已核准的建會申請。

讀寫鎖定順序為會員、session、成員資格、傳送者頻率限制、頻道。公會沿用 `lockMemberGuilds`，小隊沿用既有成員操作的 advisory lock；離會或退隊後，讀取、傳送、標讀與重送舊 key 都會重新檢查並回 `404 channel_not_available`。讀取使用同樣的可重試快照。傳送完成後，回應正文前再檢查資格；若離開已在兩者之間提交，合法送出的訊息仍保留，但回應拒絕讀取。

公會與小隊共用每位傳送者每 60 秒 20 則的頻率限制，與私訊計量分開。內容沿用純文字、Unicode 2,000 字與冪等規則；收據只留 message ID。每個頻道在同一交易內配置並提交遞增序號，DTO 用字串保存 bigint 精度。標讀以本人指定的已載入 `through_message_id` 推進游標，不能把之後提交的訊息一併標讀；自己的發言不計未讀。

離開保留歷史和已讀游標，但不保留讀寫權。重新加入後接續游標，離開期間的他人發言仍計未讀。前端先取得可用頻道列表，由本人選擇後才讀取正文，未讀提示不會預先載入頻道內容。

## 通知來源

`notifyMember(q, input)`（`notifications.ts`）在呼叫端的交易內寫入，與領域變更一起提交或回滾；同一 `(community, recipient, source_key)` 只寫一次。輸入不合法（未知 kind、任意網址或額外欄位的 action）或收件者不在同社群會直接丟錯，讓整個指令回滾。通知只是站內提示，不授予任何權限。

目前接上的事件（`events.ts`）：

| 事件 | 收件者 | kind | action |
| --- | --- | --- | --- |
| 送出或重新送出好友邀請 | 受邀者 | `friend_request` | `members` + 邀請者 |
| 接受邀請 | 原邀請者 | `friend_accepted` | `members` + 接受者 |
| 受邀者移除待處理邀請（婉拒） | 原邀請者 | `friend_declined` | `members` + 受邀者 |
| 管理員核准／退回公會申請 | 申請者 | `guild_application_approved` / `_rejected` | `guilds` + 新公會 key／`null` |
| 公會專家由未任命變任命／由任命變解除 | 該會員 | `guild_expert_appointed` / `_revoked` | `guilds` + 公會 key |
| 公會長換人（管理員任命或本人確認提名後新增席位） | 新任／卸任者 | `guild_master_appointed` / `_revoked` | `guild-workspace`／`guilds` + 公會 key |

不通知的情況：邀請者自己取消、移除已是好友的關係、重複送出仍在等待的邀請、重送同一 key、專家狀態沒有真的改變（即使版本號增加）、重新任命同一位公會長、提名確認時席位原本就是本人。公會申請通知會附上審查說明；申請者原本就能在自己的申請列表看到這段文字。其他通知只用顯示名稱與公會名稱，不放 email、管理員身分或內部識別碼。

`squad_invitation` 由小隊邀請（migration 036）呼叫同一個 `notifyMember`。

## 測試

```sh
npx tsx --test --test-concurrency=1 tests/runtime/member-communications.test.ts tests/runtime/notification-events.test.ts
```

兩個檔案都在獨立的 PostgreSQL schema 執行。`notification-events.test.ts` 以只存在於測試 schema 的 trigger 讓 receipt／audit 寫入失敗，證明領域變更與通知一起回滾。

`member-communications.test.ts` 另外直接呼叫服務函式（不經 HTTP middleware）：以登入取得 `Actor` 後撤銷 session、讓 session 過期、停用會員、換成其他社群、或重設定位，三個讀取與兩個標已讀（含重送既有 key）都必須被拒絕且不寫任何資料；私訊重送會重新檢查傳送者與收件者。併發測試用另一條連線持有撤銷交易，以 `pg_blocking_pids` 確認讀取確實在等待（不靠 sleep 當證據），提交後讀取必須回 401／403，不能回內容或原始 `40001`。

2026-09-24 驗證紀錄：在修改服務前先跑新測試，舊程式 13 個測試中 2 個失敗——撤銷／過期／停用後直接呼叫三個讀取服務仍回傳內容（跨社群 Actor 的兩個列表也未拒絕），定位重設後讀取、標已讀與重送舊 key 都成功，併發讀取也不會等待撤銷。修改後 `npm run typecheck` 通過，兩個 runtime 檔案 20/20 通過；把重試次數暫改為 1 時併發測試得到 `503 communications_busy`，證明 `40001` 重試路徑確實被觸發。完整測試、瀏覽器與 e2e 本輪未執行。

## 目前限制

- 沒有即時推送或輪詢頻率建議；前端需自行重新整理列表。
- 沒有封鎖、檢舉、刪除或編輯訊息；也沒有通知「全部標為已讀」。
- 會員因退出公會而自動解除的專家或公會長身分不發通知，只有管理員操作與提名確認會發。
- 分頁使用 offset；有新訊息寫入時，翻頁可能看到重複或跳過的項目，前端應以 id 去重。
