# 會員設定、待辦與訊息

右上角「設定」依序提供「我的名片」「待辦清單」「我的訊息」，保留 `#account`，新增 `#todos`、`#messages`。這三個個人入口不增加側邊欄項目；手機、鍵盤與直接網址使用同一套頁面。

GitHub 連結固定列為必做待辦，以 `/me/github` 的真實狀態顯示待完成、已完成或讀取失敗。本人點擊才開始 OAuth，返回 `#todos`；解除連結後恢復待完成。這次沒有新增整站 GitHub 登入門檻。按星權限不足時提供前往原作 GitHub 的操作，不從通用 403 推斷原作者尚未批准。

## 通知、閒聊頻道與私人訊息

「我的訊息」依序提供「通知」「公會閒聊」「小隊閒聊」「私人訊息」，支援未讀、已讀、分頁及失敗重試。通知只使用固定站內頁面動作，不接受任意跳轉網址。

每個已加入的公會與小隊各有一個閒聊頻道，先顯示本人可用的頻道，選擇後才讀取正文。公會閒聊開放給該公會的有效成員，不限幹部；小隊邀請或尚待核准的申請不授予小隊頻道存取。離開後撤銷讀寫權，既有聊天內容保留在原頻道。私人訊息只有對話雙方可讀。

設定選單的未讀提示於初次載入、開啟選單、回到視窗及站內已讀／傳送後更新；訊息頁提供重新整理。API、鎖定順序與私人資料存取細節見 [通知與私訊服務](member-communications.md)。

| 來源 | 收件人與時機 |
| --- | --- |
| 好友邀請 | 對方收到邀請；接受或婉拒後通知邀請人 |
| 小隊邀請 | 受邀人收到邀請與撤回通知；本人回覆後通知發起人 |
| 公會申請 | 申請人收到審核通過或拒絕結果 |
| 專家、公會長 | 專家任命或解除、公會長任命或改任成功後通知當事人 |
| 公會、小隊閒聊 | 當下有該公會或小隊成員資格的人可讀取及發言 |
| 會員私訊 | 同社群有效會員可開始對話，只有雙方可讀取內容 |

通知與原操作在同一資料庫交易保存，重播或無變動操作不新增通知。Migration 035–037 建立通知、私訊、邀請與閒聊資料表，不補發歷史通知，也不發送站外郵件或推播。

私訊使用純文字，每則最多 2,000 字；每位寄件者每分鐘最多 20 則。重試沿用同一操作識別碼避免重複傳送。對方停權後，既有對話保留給本人閱讀，但無法再傳新訊息。訊息正文只存在私訊資料表，不複製到操作收據或稽核日誌。

頻道未讀排除自己發出的內容；第一次加入尚未標記已讀時，既有他人訊息也列為未讀。已讀只推進到本人指定的已載入訊息，新到的內容仍保留未讀。離開時保留已讀位置，重新加入後接續使用；離開期間的內容仍依該位置計算。公會與小隊頻道彼此獨立，也不會轉成每位成員各一則重複通知。

## API

以下路徑以 `/api/v1` 為前綴，使用既有會員 session；寫入需要 CSRF 與 Idempotency-Key。列表預設 20 筆、最多 50 筆，以 `limit`／`offset` 分頁。這些路徑尚未加入固定版本的 preview SDK。

| 路徑 | 用途 |
| --- | --- |
| `GET /me/notifications` | 本人通知、總未讀數、下一頁 |
| `POST /me/notifications/:id/read` | 將本人的單則通知標為已讀 |
| `GET /me/conversations` | 本人對話列表、私訊總未讀數 |
| `GET /me/conversations/:userId/messages` | 本人與指定會員的訊息 |
| `POST /me/conversations/:userId/messages` | 傳送 `{body}` |
| `POST /me/conversations/:userId/read` | 將對方傳給本人的訊息標為已讀 |
| `GET /me/channels?kind=guild` 或 `kind=squad` | 本人目前可用的頻道及未讀數；不包含正文 |
| `GET /me/channels/:kind/:key/messages` | 本人有資格的指定頻道訊息 |
| `POST /me/channels/:kind/:key/messages` | 傳送 `{body}` 到該頻道 |
| `POST /me/channels/:kind/:key/read` | 用 `{through_message_id}` 標記已看過的訊息範圍 |
| `POST /squads/:id/invitations` | 發起人送出 `{recipient_ref}` 邀請 |
| `GET /squads/:id/invitations` | 發起人查看送出的邀請 |
| `GET /me/squad-invitations` | 本人收到的邀請；`state=pending` 或 `all` |
| `POST /squad-invitations/:id/accept` | 受邀本人接受並加入小隊 |
| `POST /squad-invitations/:id/decline` | 受邀本人婉拒 |
| `POST /squad-invitations/:id/withdraw` | 發起人撤回 |

小隊邀請回覆帶 `If-Match` 邀請版本；邀請本身不建立小隊成員資格，也不開放小隊聯絡資料。接受時沿用既有小隊成員鎖，與申請、核准及退出協調；退出後重播舊的接受收據不會重新加入。

每隊最多 50 份待回覆邀請，並行送出也受限制。受邀人停用或重設定位後，發起人仍能撤回原邀請釋放名額，列表將對方顯示為「目前不可用的會員」。新邀請與接受仍需要雙方資格有效。

通知與私訊標為已讀是冪等操作，不需要 `If-Match`。GET 不改變已讀狀態。

## 驗證入口

使用隔離 PostgreSQL、合成會員及真正的 HTTP／瀏覽器流程驗證權限、重試、邀請同意、未讀與手機操作；不使用正式會員測試私訊或邀請。部署驗證僅查詢合成帳號的空信箱、可用頻道列表與 GitHub 待辦，不載入正式頻道正文，完成後停用帳號並撤銷 session。

- `tests/runtime/member-communications.test.ts`
- `tests/runtime/notification-events.test.ts`
- `tests/runtime/member-channels-core.test.ts`、`tests/runtime/member-channel-access.test.ts`
- `tests/e2e/member-settings.spec.ts`、`tests/e2e/member-channels.spec.ts`
- `tests/e2e/member-settings-real.spec.ts`、`tests/e2e/member-channels-real.spec.ts`
- `tests/runtime/squad-invitations.test.ts`、`tests/e2e/squad-invitations.spec.ts`
- `scripts/verify-staging.mjs`、`scripts/verify-public.mjs`
