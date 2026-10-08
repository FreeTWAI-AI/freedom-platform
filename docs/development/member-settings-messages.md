# 會員設定、待辦與訊息

右上角「設定」依序提供「我的名片」「待辦清單」「我的訊息」，保留 `#account`、`#todos`、`#messages`。「我的訊息」同時列在主要導覽，可透過「搜尋功能」找到；手機、鍵盤與直接網址使用同一套頁面。

GitHub 連結固定列為必做待辦，以 `/me/github` 的真實狀態顯示待完成、已完成或讀取失敗。本人點擊才開始 OAuth，返回 `#todos`；解除連結後恢復待完成。這次沒有新增整站 GitHub 登入門檻。按星權限不足時提供前往原作 GitHub 的操作，不從通用 403 推斷原作者尚未批准。

## 通知、閒聊頻道與私人訊息

「我的訊息」依序提供「通知」「公會閒聊」「小隊閒聊」「私人訊息」「世界聊天」，支援未讀、已讀、分頁及失敗重試。通知只使用固定站內頁面動作，不接受任意跳轉網址。

每個已加入的公會與小隊各有一個閒聊頻道，先顯示本人可用的頻道，選擇後才讀取正文。公會閒聊開放給該公會的有效成員，不限幹部；小隊邀請或尚待核准的申請不授予小隊頻道存取。離開後撤銷讀寫權，既有聊天內容保留在原頻道。私人訊息只有對話雙方可讀。

聊天室與底部控制台共用同一元件。頻道可依名稱搜尋；可見分頁每秒檢查所選對話的小型 `/activity` 回應，有變化時讀取正文。若目前私訊仍有已載入、尚未讀的 outgoing，另每 8 秒重讀原授權分頁核對實際 read_at，避免最新訊息掩蓋舊訊息的已讀變化；offset 上限 10000。其他私訊對話列表維持每 8 秒更新。送出時立即顯示「傳送中」，伺服器確認後才成為正式訊息；不因送出而重讀整批平台動態。切換對話保留本次開頁草稿，桌面 Enter 送出、Shift+Enter 換行，手機 Enter 換行、按送出才傳送；不會在中文組字途中送出。載入較早內容保留捲動位置，閱讀舊內容時的新訊息提供「回到最新」操作。首頁及已加入公會卡片可直接開啟指定公會聊天室，仍由 API 即時核對會員資格。

設定選單的未讀提示於初次載入、開啟選單、回到視窗及站內已讀／傳送後更新；訊息頁提供重新整理。API、鎖定順序與私人資料存取細節見 [通知與私訊服務](member-communications.md)。

| 來源 | 收件人與時機 |
| --- | --- |
| 好友邀請 | 對方收到邀請；接受或婉拒後通知邀請人 |
| 小隊邀請 | 受邀人收到邀請與撤回通知；本人回覆後通知發起人 |
| 公會申請 | 申請人收到審核通過或拒絕結果 |
| 專家、公會長 | 專家任命或解除、公會長任命或改任成功後通知當事人 |
| 公會、小隊閒聊 | 當下有該公會或小隊成員資格的人可讀取及發言 |
| 會員私訊 | 同社群有效且目前可聯絡的會員可開始對話，只有雙方可讀取內容 |

通知與原操作在同一資料庫交易保存，重播或無變動操作不新增通知。Migration 035–037 建立通知、私訊、邀請與閒聊資料表，不補發歷史通知，也不發送站外郵件或推播。

私訊使用純文字，每則最多 2,000 字；每位寄件者每分鐘最多 20 則。重試沿用同一操作識別碼避免重複傳送。對方停權後，既有對話保留給本人閱讀，但無法再傳新訊息。訊息正文只存在私訊資料表，不複製到操作收據或稽核日誌。

本分支提供四張工坊原創圖片貼圖與指定訊息回覆，可用於公會、小隊、世界與私訊。可搜尋、預覽及取消引用；文字、貼圖與引用草稿按對話分開。貼圖使用固定 `sticker_id`，引用使用 `reply_to_message_id`，由 API 核對同一對話及讀取原文。詳見 [社群設計與聊天升級](social-project-upgrade.md)，部署需本整合候選的 migration 113（最終基底更新時重新核對編號）。

頻道未讀排除自己發出的內容；第一次加入尚未標記已讀時，既有他人訊息也列為未讀。已讀只推進到本人指定的已載入訊息，新到的內容仍保留未讀。離開時保留已讀位置，重新加入後接續使用；離開期間的內容仍依該位置計算。公會與小隊頻道彼此獨立，也不會轉成每位成員各一則重複通知。

## 本人封鎖（候選，預設關閉）

`FREEDOM_MEMBER_BLOCKING_ENABLED=true` 才顯示夥伴名冊、私人訊息及控制台的「封鎖設定」，並在「我的好友」提供「我的封鎖名單」。其他值與未設定均關閉管理入口及管理 API；已保存的封鎖仍由 API 強制執行，不會因關閉旗標失效。此候選尚未宣稱部署。

本人確認封鎖後，雙方都不能傳送新私訊或建立、接受好友邀請；現有好友關係與待回覆邀請在同一交易內移除，不發送封鎖或婉拒通知。既有私訊歷史、標已讀、公會／小隊成員資格及共同頻道不變。解除封鎖不恢復好友，也不自動傳送保留的訊息草稿；若另一方仍有封鎖，仍不能聯絡。

名單只包含本人主動設定的有效封鎖，不提供「誰封鎖我」名單。對方已不可用時遮蔽暱稱，但本人仍能解除原設定。名單每頁 20 筆；API 上限 50 筆、offset 上限 10000。

未知傳送結果保留原 key、操作和版本；關閉再開、切換對話或清單分頁後，重試仍沿用同一筆指令。已知錯誤（例如 412）需先重讀最新設定，不能盲目重送。完成時刷新目前清單頁，而不是指令送出時的舊頁；離開登入 session 後不保留前一位會員的操作。

本切片只處理雙向聯絡封鎖，不建立檢舉案件、證據、申訴或管理員處分；這些仍依 #193 的內容契約及 #261 的正式政策另行完成。migration 與舊版回滾限制見[通知與私訊服務](member-communications.md)。

## API

以下路徑以 `/api/v1` 為前綴，使用既有會員 session；寫入需要 CSRF 與 Idempotency-Key。列表預設 20 筆、最多 50 筆，以 `limit`／`offset` 分頁。這些路徑尚未加入固定版本的 preview SDK。

| 路徑 | 用途 |
| --- | --- |
| `GET /me/notifications` | 本人通知、總未讀數、下一頁 |
| `POST /me/notifications/:id/read` | 將本人的單則通知標為已讀 |
| `GET /me/conversations` | 本人對話列表、私訊總未讀數 |
| `GET /me/conversations/:userId/messages` | 本人與指定會員的訊息 |
| `POST /me/conversations/:userId/messages` | 傳送 `{body}` 或 `{sticker_id}`，可選填 `reply_to_message_id` |
| `POST /me/conversations/:userId/read` | 將對方傳給本人的訊息標為已讀 |
| `GET /me/blocks` | 旗標開啟時讀取本人的有效封鎖名單 |
| `GET /me/blocks/:userId` | 旗標開啟時讀取本人對指定會員的設定（僅 blocked_by_me 與本人版本） |
| `POST /me/blocks/:userId/block` `{}` | 旗標開啟時本人確認封鎖；已有設定需帶其 `If-Match` 版本 |
| `POST /me/blocks/:userId/unblock` `{}` | 旗標開啟時本人解除設定；已有設定需帶其 `If-Match` 版本 |
| `GET /me/channels?kind=guild` 或 `kind=squad` | 本人目前可用的頻道及未讀數；不包含正文 |
| `GET /me/channels/:kind/:key/messages` | 本人有資格的指定頻道訊息 |
| `POST /me/channels/:kind/:key/messages` | 傳送 `{body}` 或 `{sticker_id}` 到該頻道，可選填 `reply_to_message_id` |
| `POST /me/channels/:kind/:key/read` | 用 `{through_message_id}` 標記已看過的訊息範圍 |
| `POST /squads/:id/invitations` | 發起人送出 `{recipient_ref}` 邀請 |
| `GET /squads/:id/invitations` | 發起人查看送出的邀請 |
| `GET /me/squad-invitations` | 本人收到的邀請；`state=pending` 或 `all` |
| `POST /squad-invitations/:id/accept` | 受邀本人接受並加入小隊 |
| `POST /squad-invitations/:id/decline` | 受邀本人婉拒 |
| `POST /squad-invitations/:id/withdraw` | 發起人撤回 |

頻道列表可加 `search`（最多 100 字），在分頁前篩選名稱；回傳總未讀數仍涵蓋本人全部可用頻道。`GET /me/channels/:kind/:key/messages` 可加 `after_sequence` 非負 bigint 字串（上限 `9223372036854775807`），從該序號後依序讀取新訊息；不能與非零 `offset` 合用。有後續增量時回傳 `next_after_sequence`。未帶游標時仍沿用原本的最近訊息與 offset 分頁。

`GET /me/channels/:kind/:key/activity` 回 `{latest_sequence, unread_count}`，`GET /me/conversations/:userId/activity` 回 `{last_message_id, unread_count, can_send, last_outgoing}`，其中 `last_outgoing` 是最近送出訊息的 `{message_id,read_at}` 或 `null`。兩者不帶查詢參數、不含訊息正文、不標已讀，資格檢查與讀取同一對話的訊息相同。世界頻道使用 `kind=world&key=world` 的同一讀寫、已讀介面。

小隊邀請回覆帶 `If-Match` 邀請版本；邀請本身不建立小隊成員資格，也不開放小隊聯絡資料。接受時沿用既有小隊成員鎖，與申請、核准及退出協調；退出後重播舊的接受收據不會重新加入。

每隊最多 50 份待回覆邀請，並行送出也受限制。受邀人停用或重設定位後，發起人仍能撤回原邀請釋放名額，列表將對方顯示為「目前不可用的會員」。新邀請與接受仍需要雙方資格有效。

通知與私訊標為已讀是冪等操作，不需要 `If-Match`。GET 不改變已讀狀態。

封鎖設定的 GET 使用 `Cache-Control: private, no-store`；有保存列時單筆回應提供帶引號的版本 ETag。POST 僅接受空物件，已有保存列（包含已解除）時需用該版本作 `If-Match`；首次沒有保存列時不帶版本。解除不刪除版本列，舊收據重播不重新封鎖，成功回應從目前設定重讀。詳細 DTO、授權與重試邊界見[通知與私訊服務](member-communications.md)。

## 驗證入口

使用隔離 PostgreSQL、合成會員及真正的 HTTP／瀏覽器流程驗證權限、重試、邀請同意、未讀與手機操作；不使用正式會員測試私訊或邀請。部署驗證僅查詢合成帳號的空信箱、可用頻道列表與 GitHub 待辦，不載入正式頻道正文，完成後停用帳號並撤銷 session。

- `tests/runtime/member-communications.test.ts`
- `tests/runtime/member-blocking.test.ts`
- `tests/runtime/notification-events.test.ts`
- `tests/runtime/member-channels-core.test.ts`、`tests/runtime/member-channel-access.test.ts`
- `tests/e2e/member-settings.spec.ts`、`tests/e2e/member-channels.spec.ts`
- `tests/e2e/member-settings-real.spec.ts`、`tests/e2e/member-channels-real.spec.ts`
- `tests/runtime/squad-invitations.test.ts`、`tests/e2e/squad-invitations.spec.ts`
- `scripts/verify-staging.mjs`、`scripts/verify-public.mjs`
