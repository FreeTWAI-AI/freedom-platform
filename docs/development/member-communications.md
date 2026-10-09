# 會員通知、閒聊頻道與站內私訊

會員在「設定 → 我的訊息」裡的通知、閒聊頻道與私訊，資料存放在中央 PostgreSQL（migration 035、037），由 `modules/member-communications/` 負責。這裡只有站內紀錄：不寄 email、不推播、不連外部服務，也不回填歷史事件。四個分區與完整路徑見 [會員設定、待辦與訊息](member-settings-messages.md)。

## API（全部需要會員登入，並完成目前加入資格）

分頁參數一律是 `limit`（1–50，預設 20）與 `offset`（0–10000，預設 0）；未知查詢參數回 422。通知與私訊列表都是新到舊，同時間以 UUID 由大到小排序；頻道訊息依交易內配置的序號由大到小排序。未讀數在同一個資料庫快照內計算，不受目前頁數影響。GET 不會標記已讀。

| 方法與路徑 | 回應 |
| --- | --- |
| `GET /api/v1/me/notifications` | `{items: Notification[], unread_count, next_offset}` |
| `POST /api/v1/me/notifications/:id/read` `{}` | `{notification_id, read_at}`；只能標自己的通知，已讀再標回原時間 |
| `POST /api/v1/me/inbox/read-all` `{}` | `{notifications_updated, direct_messages_updated, channels_updated}`；一次標記本人所有頁的通知、收到的私訊及目前可存取的公會／小隊／世界聊天室 |
| `GET /api/v1/me/conversations` | `{items:[{participant, can_send, last_message, unread_count}], unread_count, next_offset}`，依最後一則訊息排序 |
| `GET /api/v1/me/conversations/:userId/messages` | `{participant, can_send, items: Message[], unread_count, next_offset}`；還沒對話時回空陣列，可直接開始撰寫 |
| `POST /api/v1/me/conversations/:userId/messages` `{body}` | `201 Message` |
| `POST /api/v1/me/conversations/:userId/read` `{}` | `{user_id, read_at, updated_count}`；只標對方傳給自己的未讀訊息 |

DTO 定義在 `modules/member-communications/types.ts`。時間是 ISO 字串；`avatar_url` 只在對方目前可見且有頭像時給既有的 `/api/v1/members/:id/avatar?v=` 路徑。回應不含 email、聯絡方式或任何 token。

上表通知與私訊 POST 走既有的 Origin、CSRF 與 `Idempotency-Key` 規則，不需要 `If-Match`；封鎖設定另使用版本 CAS（見下節）。同一個 key 搭配不同內容回 `409 idempotency_conflict`；重送會先重新檢查目前資格，再讀取原收據。

「全部標為已讀」在通知鈴與訊息頁都可使用。它是一個明確的 POST 操作；開啟通知、切換頁面和 GET 不會自動消耗未讀。既有內容與歷史不刪除，也不改其他會員的未讀狀態。聊天室只更新本人目前成員資格允許的頻道；沿用既有成員鎖、channel sequence 鎖及單調 cursor。這些寫入與 command receipt 在同一個交易，任一失敗全部回滾。收到 ACK 後重新讀取各分區的真實未讀數；失敗顯示錯誤，同一 key 重試只回第一次結果，之後的新通知和聊天仍是未讀。

## 服務層授權、鎖與快照

路由仍掛在共用的 session、Origin、CSRF 與加入資格 middleware 之後，但服務函式不信任傳進來的 `Actor`：直接呼叫、或驗證後才被撤銷的請求，也會在服務層重新以資料庫目前狀態判斷。

- **讀取**（`listNotifications`、`listConversations`、`conversationMessages`、`conversationActivity`）：在 `BEGIN ISOLATION LEVEL REPEATABLE READ` 交易的第一步先 `FOR SHARE` 鎖會員列（`user_id`＋`community_id`＋`active`），再 `FOR SHARE` 鎖 session 列（未撤銷、未過期），順序與 `command()` 相同（先 users 再 sessions，不反向）。停用、跨社群、撤銷或過期回 `401 session_expired`；加入資格改由剛鎖住的會員列判斷，未完成目前加入資格回 `403 onboarding_required`。計數與分頁仍在同一快照內，GET 不寫任何領域資料。因為 `FOR SHARE` 不能在 `READ ONLY` 交易執行，所以拿掉了 `READ ONLY`，快照不變。
- **與撤銷同時發生**：讀取若先拿到鎖，會排在撤銷之前完成（撤銷等它提交）。若撤銷已提交或先拿到鎖，讀取等待後，快照看到的是舊列而 PostgreSQL 回 `40001`；整個讀取以新交易重跑（最多 3 次，只限這三個讀取），重跑時看到撤銷而拒絕。不會回傳內容，也不會把原始 `40001` 丟出；3 次都衝突時回 `503 communications_busy`。
- **指令**（`markNotificationRead`、`markConversationRead`、`sendDirectMessage`）：`command()` 已先鎖會員列、再鎖 session 列；授權 callback 在同一交易內用目前會員列重新確認加入資格，之後才查 receipt。私訊傳送先取得雙方無序 pair advisory lock，再鎖收件者並確認可聯絡；等待 pair 或收據後重新核對 session 真實時鐘、加入資格與聯絡限制。加入資格重設或封鎖已生效後，舊 key 也不能繞過現況授權。
- 對方停用、未完成加入或任一方封鎖時，自己仍能讀取既有對話與標已讀（只檢查「自己」的資格）；封鎖不刪除歷史。

## 私訊規則

- 雙方都必須是同一社群、啟用中且已完成目前加入資格、沒有任一方向有效封鎖的會員；不能傳給自己。不需要先成為好友。
- 內容是純文字：前後空白會去掉，換行統一為 `\n`，長度 1–2000 字（以 Unicode 字元計）。不解析 HTML／Markdown，也不抓取網址；前端必須當文字顯示。
- 找不到、跨社群、或未完成加入且沒有往來紀錄的會員一律回 404，無法分辨。已有對話但對方已停用或尚未完成加入時，自己仍能讀取、標已讀，`can_send` 為 `false`，傳送回 `409 recipient_unavailable`。任一方向封鎖時傳送與建立／接受好友邀請回通用 `409 recipient_unavailable`，不回傳反向封鎖欄位。
- 每位傳送者 60 秒內最多 20 則新訊息（`429 message_rate_limited`）。私訊先取得無序 pair lock，再取得傳送者頻率限制 advisory lock；同時送出也不會超過，雙向傳送使用相同 pair barrier。授權通過後重送既有 key 不計次；收件者以 `FOR SHARE` 鎖定。
- 私訊不產生通知（避免未讀重複計算）。訊息內容不寫入 command receipt 或 transition journal；receipt 只保留 `message_id`。

## 獨立會員封鎖與部署邊界

候選 `FREEDOM_MEMBER_BLOCKING_ENABLED` 精確為 `true` 才註冊 `/api/v1/me/blocks` 管理路由並顯示 UI；未設定或其他值均預設關閉，管理路由回 404。Node 與 Worker 使用相同旗標與服務；私訊、好友與小隊新互動的封鎖守衛不依賴旗標，所以已保存的封鎖在 OFF 時仍有效。

`packages/shared/member-blocking.ts` 定義嚴格 DTO：單筆 `{user_id, blocked_by_me, aggregate_version}`；本人名單 `{items:[{user_id, nickname, blocked_at, aggregate_version}], next_offset}`。不提供反向封鎖者名單。不可用會員的本人名單暱稱為 `null`，但原擁有者仍可解除；跨社群、對自己及未授權的目標不可操作。GET 採 `private, no-store`，單筆已有保存列時提供版本 ETag。

`POST /me/blocks/:userId/block|unblock` 僅接受 `{}`、Origin／CSRF 與 Idempotency-Key；已有列需帶引號格式的 `If-Match` 版本，沒有列時不帶版本。UUID 大小寫先正規化為同一指令目標。migration 136 保留同一 `block_id`、`active|removed` 狀態及遞增版本；解除不刪列，重複相同狀態不增版，舊 block 收據重播不重新封鎖。收據僅保存 `{updated}`，journal 使用保存列 ID 及空 body，不複製暱稱、聯絡資料或訊息正文；成功回應另依目前授權重讀狀態，不回放過時的封鎖狀態。

封鎖、好友建立／接受／移除及私訊共用既有 `friend/<community>/<low>/<high>` barrier，在 receipt 查詢之前取得。封鎖同一交易將已有或待接受好友關係移除、靜默撤回雙方待處理小隊邀請；不發 declined／封鎖通知。好友移除與邀請撤回都是同一 `member_interaction_block` journal 的交易副作用，不另產生通知型邀請 transition；失敗會一併回滾。小隊邀請／接受與申請加入／接受申請在授權與 receipt 重驗使用相同 pair barrier，舊 key 不能繞過。推薦、好友搜尋及會員目錄在分頁前排除雙向封鎖，卡片組成後再次重查；並行變更時 total 仍表示原候選快照。先完成的合法傳送可保留；封鎖先提交時，排隊傳送或接受邀請必須拒絕。好友移除、私訊歷史／已讀、已存在的公會／小隊資格、退出及共同頻道不受此封鎖阻擋。本人設定 DTO 沒有反向封鎖欄位；實際互動沿用不可用的一般錯誤碼與訊息。成員仍可能從原本可聯絡到不可聯絡、can_send 或推薦變化推論限制；本功能不承諾無法推論，也不隱藏既有歷史／共同頻道或公開名片。

**部署本程式前必須先跑到 migration 136，即使旗標 OFF**：守衛會查新表，不能把 OFF 誤當成舊 schema 相容模式。沿用既有 migration／runtime grants 流程，先在隔離與 staging 資料庫驗證，再由獲授權的操作者決定啟用。此次沒有部署或修改 production 旗標。OFF 不會解除設定；舊版程式沒有守衛，回滾舊 binary 會忽略已保存封鎖，因此應 forward-fix 或採安全維護模式，不能把「舊 binary 回滾」當成維持封鎖承諾的退路。

number 136 is provisional if another migration lands first.

這是 #251 已授權的獨立封鎖切片；檢舉案件／證據／申訴不在本切片；正式政策另由 #261 追蹤，不以此切片關閉整張 Issue。

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
| 會長把成員改為正式成員 | 該會員 | `guild_member_promoted` | `guilds` + 公會 key |
| 會長把成員改回實習成員 | 該會員 | `guild_member_demoted` | `guilds` + 公會 key |

晉升通知標題是「你已成為正式成員」，正文是「你已成為「公會名稱」的正式成員，可以發布與編輯公會內容。」改回實習的標題是「你已改為實習成員」，正文是「你在「公會名稱」改為實習成員。」

不通知的情況：封鎖與因此移除的好友／待回覆邀請、邀請者自己取消、移除已是好友的關係、重複送出仍在等待的邀請、重送同一 key、專家狀態沒有真的改變（即使版本號增加）、重新任命同一位公會長、提名確認時席位原本就是本人、同一個成員等級再寫一次（版本也不增加）。公會申請通知會附上審查說明；申請者原本就能在自己的申請列表看到這段文字。其他通知只用顯示名稱與公會名稱，不放 email、管理員身分或內部識別碼。

`squad_invitation` 由小隊邀請（migration 036）呼叫同一個 `notifyMember`。

## 測試

```sh
node --import tsx --test --test-concurrency=1 tests/runtime/member-blocking.test.ts tests/runtime/member-communications.test.ts tests/runtime/notification-events.test.ts
```

先設定指向隔離 PostgreSQL 的 `TEST_DATABASE_URL`。這三個檔案都在獨立 schema 執行；`member-blocking.test.ts` 覆蓋雙向守衛、本人資料、保留版本、收據、資格與真實鎖等待；`notification-events.test.ts` 以只存在於測試 schema 的 trigger 讓 receipt／audit 寫入失敗，證明領域變更與通知一起回滾。

`member-communications.test.ts` 另外直接呼叫服務函式（不經 HTTP middleware）：以登入取得 `Actor` 後撤銷 session、讓 session 過期、停用會員、換成其他社群、或重設定位，三個讀取與兩個標已讀（含重送既有 key）都必須被拒絕且不寫任何資料；私訊重送會重新檢查傳送者與收件者。併發測試用另一條連線持有撤銷交易，以 `pg_blocking_pids` 確認讀取確實在等待（不靠 sleep 當證據），提交後讀取必須回 401／403，不能回內容或原始 `40001`。

2026-09-24 驗證紀錄：在修改服務前先跑新測試，舊程式 13 個測試中 2 個失敗——撤銷／過期／停用後直接呼叫三個讀取服務仍回傳內容（跨社群 Actor 的兩個列表也未拒絕），定位重設後讀取、標已讀與重送舊 key 都成功，併發讀取也不會等待撤銷。修改後 `npm run typecheck` 通過，兩個 runtime 檔案 20/20 通過；把重試次數暫改為 1 時併發測試得到 `503 communications_busy`，證明 `40001` 重試路徑確實被觸發。完整測試、瀏覽器與 e2e 本輪未執行。

## 目前限制

- 沒有即時推送。前端目前僅對可見、選定的對話每秒讀取輕量 activity；待確認的已載入私訊 outgoing receipts 另每 8 秒以原授權訊息分頁核對，保留手動重讀與失敗退避。詳見[訊息介面](member-settings-messages.md)；這些週期性核對不會自動標已讀。
- 尚未提供檢舉、刪除或編輯訊息；也沒有通知「全部標為已讀」。獨立封鎖候選的預設 OFF 與部署邊界見上節，不代表檢舉／政策已完成。
- 會員因退出公會而自動解除的專家或公會長身分不發通知，只有管理員操作與提名確認會發。
- 分頁使用 offset；有新訊息寫入時，翻頁可能看到重複或跳過的項目，前端應以 id 去重。

### 封鎖與搜尋整合的發布界線

整合候選以既有商店 migration 134／135 為父線，新增 136（會員封鎖）與 137（社群搜尋標籤）。001～135 的 SQL 不變，136／137 都是新增社群表，沿用既有 runtime grants 與目前會員命令授權；不新增 tenant 權限或 RLS。兩個功能開關仍預設關閉，合併不代表部署或產品驗收。

回退到不認得封鎖的舊 binary 會忽略已保存的封鎖關係，失去聯絡保護；不能把新增資料表的 schema 相容當成安全回退承諾。本候選即使關閉封鎖管理介面，已保存的封鎖仍保護好友、邀請及私訊。回退應保留這項保護或以修復版前進，不把關閉介面當成刪除設定。

### 私訊圖片的 metadata 歸屬

`member-communications` descriptor 僅登錄這次新增的圖片 reader/client、139 migration
與圖片 runtime/browser 測試，不以目錄 wildcard 吸收舊 communications、App 或 routes。
既有未映射 surface 仍回報 unavailable；descriptor 是來源 metadata，不是模組安裝
或 application release。圖片沿 [既有 Asset adapter](../../modules/assets/message-image.md)。

圖片或訊息送出時，原 tuple 先同步保存於本次 session 的記憶體 ref，再發起請求；
React state 只負責畫面。頁面離開、Console 自身的 session-end 與 beforeunload
讀同一 ref，包含首次 send 同一事件內的導覽；不同 principal／已撤銷 session
仍清除私有資料。主視窗仍無法詢問另一 popout 的 pending tuple，不承諾跨窗
登出攔截或 crash durability。

送出結果為 unknown 後，只有 canonical ACK 核對成功才釋放原 key、body 與圖片 bytes：核對 message UUID、
目前 sender／精確 recipient、server 正規化後正文、reply ID／sticker 與 image
有無；圖片 metadata 必須為 WebP、正整數且不超過 1 MiB。Message.image
沒有 image_id，不要求虛構欄位。2xx 的空物件或錯誤對象仍視為 unknown，
沿原 tuple 重試，不以 HTTP status 代替提交確認。上傳 ACK 使用同一 byte bounds。

先前已是 unknown 的文字／貼圖，同 tuple 重試即使收到確定 4xx 也不能據此
否定前一次可能已提交的操作；保留原 key／body 直到 canonical ACK。首次就
收到確定拒絕的文字／貼圖仍可修改後重新送出，不把所有失敗一律鎖住。

圖片的唯一可解除例外：首次上傳階段、此前沒有 unknown，且收到非 network／timeout／Access 過期的
`422 invalid_message_image`。這是解碼器在 upload prepare 前的明確拒絕；清除 pending 後
仍保留選取圖片、說明與回覆草稿，會員可修改、移除或離開。曾有 unknown 的同 tuple
重試，或已進入 message 階段的同碼 422，仍保留原 file／upload key／message key 與
離開保護。這不擴大到其他 4xx，不清理已上傳素材，也不承諾重新整理後恢復記憶體草稿。
