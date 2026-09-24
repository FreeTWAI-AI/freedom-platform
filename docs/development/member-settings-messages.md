# 會員設定、待辦與訊息

右上角「設定」依序提供「我的名片」「待辦清單」「我的訊息」，保留 `#account`，新增 `#todos`、`#messages`。這三個個人入口不增加側邊欄項目；手機、鍵盤與直接網址使用同一套頁面。

GitHub 連結固定列為必做待辦，以 `/me/github` 的真實狀態顯示待完成、已完成或讀取失敗。本人點擊才開始 OAuth，返回 `#todos`；解除連結後恢復待完成。這次沒有新增整站 GitHub 登入門檻。按星權限不足時提供前往原作 GitHub 的操作，不從通用 403 推斷原作者尚未批准。

## 通知與私訊

「我的訊息」分為通知與私訊，支援未讀、已讀、分頁及失敗重試。通知只使用固定站內頁面動作，不接受任意跳轉網址。

| 來源 | 收件人與時機 |
| --- | --- |
| 好友邀請 | 對方收到邀請；接受或婉拒後通知邀請人 |
| 小隊邀請 | 受邀人收到邀請與撤回通知；本人回覆後通知發起人 |
| 公會申請 | 申請人收到審核通過或拒絕結果 |
| 專家、公會長 | 專家任命或解除、公會長任命或改任成功後通知當事人 |
| 會員私訊 | 同社群有效會員可開始對話，只有雙方可讀取內容 |

通知與原操作在同一資料庫交易保存，重播或無變動操作不新增通知。Migration 035、036 建立新資料表，不補發歷史通知，也不發送站外郵件或推播。

私訊使用純文字，每則最多 2,000 字；每位寄件者每分鐘最多 20 則。重試沿用同一操作識別碼避免重複傳送。對方停權後，既有對話保留給本人閱讀，但無法再傳新訊息。訊息正文只存在私訊資料表，不複製到操作收據或稽核日誌。

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
| `POST /squads/:id/invitations` | 發起人送出 `{recipient_ref}` 邀請 |
| `GET /squads/:id/invitations` | 發起人查看送出的邀請 |
| `GET /me/squad-invitations` | 本人收到的邀請；`state=pending` 或 `all` |
| `POST /squad-invitations/:id/accept` | 受邀本人接受並加入小隊 |
| `POST /squad-invitations/:id/decline` | 受邀本人婉拒 |
| `POST /squad-invitations/:id/withdraw` | 發起人撤回 |

小隊邀請回覆帶 `If-Match` 邀請版本；邀請本身不建立小隊成員資格，也不開放小隊聯絡資料。接受時沿用既有小隊成員鎖，與申請、核准及退出協調；退出後重播舊的接受收據不會重新加入。

通知與私訊標為已讀是冪等操作，不需要 `If-Match`。GET 不改變已讀狀態。

## 驗證入口

使用隔離 PostgreSQL、合成會員及真正的 HTTP／瀏覽器流程驗證權限、重試、邀請同意、未讀與手機操作；不使用正式會員測試私訊或邀請。部署驗證僅查詢合成帳號的空信箱與 GitHub 待辦，完成後停用帳號並撤銷 session。

- `tests/runtime/member-communications.test.ts`
- `tests/runtime/notification-events.test.ts`
- `tests/e2e/member-settings.spec.ts`
- 小隊邀請的 runtime 與 E2E 測試
- `scripts/verify-staging.mjs`、`scripts/verify-public.mjs`
