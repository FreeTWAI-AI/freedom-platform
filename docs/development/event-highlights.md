# 活動集錦

已發布的社群活動結束後，會自動出現在活動集錦。線上、實體、混合都算；公開、介紹、工坊與公會活動結束後也一樣列入。這是一項查詢，不是事後補資料，所以這項功能上線前就已結束的活動也會出現。

這一區是公開的，用來把舊活動分享到社群。未登入的訪客和連結預覽爬蟲都可以看。寫入（新增、移除）需要已完成加入（選定主要公會）的會員 session，並沿用 CSRF 與 Origin 檢查。

尚未結束、待審核、已拒絕、已取消的活動不會出現。驗收用測試帳號主辦的活動，只有主辦者自己在會員頁看得到，公開頁和其他會員都看不到。測試帳號上傳的項目也只有上傳者自己看得到，不會出現在公開頁。

## 不公開的欄位

活動集錦不顯示地點、線上會議網址、報名與出席名單、電子郵件、分享碼。回顧顯示標題、時間、形式、活動種類、主辦者顯示名稱、參加人數、活動海報，以及夥伴補上的項目。參加人數的算法與活動頁相同：不含測試帳號的「會參加」，加上已寄出確認信的來賓報名。

活動說明另算。公開、介紹（`open`、`referral`）的說明會出現在公開頁，也用作 `description`、`og:description`、`twitter:description`。工坊與公會活動（以及其他非公開、非介紹的可見性）的公開頁不放說明，預覽改用「自由工坊社群活動回顧：海報、照片與錄影連結。」，內文改放「這是一場會員活動，活動說明只提供給會員。」

會員明細對公開、介紹、工坊活動回傳說明。公會活動只在觀看者開得了該場時回傳（主辦者，或該公會的有效成員，沿用 `canAccessGuildEvent`）；其他人拿到 `description: null`，會員頁就收起說明與「展開」，改放同一句短說明。列表端點一律不回說明。

## 誰可以補、誰可以移除

任何已完成加入（選定主要公會）的有效會員都可以為看得到的活動補上內容。可以移除項目的人是：上傳者、該場活動的主辦者、以及會員端認定的平台管理員（已驗證信箱且為該社群的有效管理員）。其他人會收到 403 `highlight_remove_forbidden`。

影片不上傳檔案，只貼連結。主辦者決定分享時以連結為準，這樣就不處理影片檔的授權與儲存。

## 數量與頻率

| | 連結 | 照片 | 海報 |
| --- | --- | --- | --- |
| 每場活動 | 60 | 120 | 10 |
| 每位會員每場活動 | 10 | 30 | 3 |

超過上限回 409 `highlight_limit_reached`，訊息會寫出是個人上限還是整場上限。上限計算包含仍在資料庫裡的有效項目，也包含畫面上隱藏的測試帳號上傳。

另外，每位會員每小時大約可上傳 30 張圖片（照片與海報合計），以及新增 20 則連結。

## 連結

只接受 https，最長 2048 字。含帳密、非預設連接埠、私有或本機位址的網址會被拒絕。儲存前會把主機轉成小寫、去掉片段，並拿掉 `utm_*`、`fbclid`、`igshid`、`si`。同一場活動裡，有效的相同連結只能有一筆；重複時回 409 `highlight_link_exists`，訊息是「這個連結已經在活動集錦裡了。」

平台依主機判斷：YouTube、Facebook、Instagram、Threads、TikTok、X、Vimeo、Google 雲端硬碟、Google 相簿，其餘為「其他」。沒有自訂標題時，用該平台的預設標題，例如「YouTube 影片」。

YouTube 的影片縮圖由瀏覽器直接向 `https://i.ytimg.com/vi/<id>/hqdefault.jpg` 讀取，並加上 `referrerpolicy="no-referrer"`。伺服器不抓取任何外部網址。其他平台用版面裡的占位，不向外站要圖。

## 圖片

照片與海報接受 JPEG、PNG、WebP，單張最多 10 MiB，並沿用活動海報的簽章與動畫檢查。動畫、SVG、GIF 不接受。方向由 `X-Photo-Orientation: landscape|portrait` 指定。正方形視為橫向。

每張圖存兩個 WebP：

- `image`：橫向收進 1600×1200，直向收進 1200×1600，背景 `#14161b`，品質約 80，不超過 1 MiB。
- `thumb`：裁成 480×360，不超過 200 KiB。

圖片處理器無法使用時回 503 `image_processing_unavailable`，不會留下半成品。

移除在同一個交易裡完成：標成 `removed`、刪掉圖片列、寫入 journal。圖片位元組因此釋放。依目前的壓縮上限，一場活動最多 120 張照片加 10 張海報，每張再加一張預覽，約 155.4 MiB（130 ×（1 MiB + 200 KiB））。資料表對每個版本的上限是 1 MiB，所以資料庫層的上限是 260 MiB。活動本身的海報另外計算，最多 512 KiB，不在這個表裡。

會員頁也使用公開圖片網址，因為這些圖本來就是公開的。測試帳號的海報與上傳在公開圖片路由會回 404。

## 公開頁與預覽

`GET /highlights` 每頁 12 場，用 `?before=` 連到「較早的活動」，形式用 `?mode=online` 或 `?mode=in_person`。混合活動兩種篩選都會出現。不正確的分頁或形式會回到第一頁，不是錯誤。

`GET /highlights/:eventId` 是單場回顧。沒有這一場時是同一風格的 404 頁，並連回列表。公開頁的「海報」、「錄影與影片」、「活動照片」只在該區有內容時出現；活動本身的海報算海報區。還沒有任何集錦項目時，留下「還沒有人補上內容。參加過的夥伴可以上傳照片、海報或貼上影片連結。」會員頁仍顯示這三個標題。

頁面標題是「活動集錦｜自由工坊」或「{活動標題}｜自由工坊活動集錦」。含 canonical、說明，以及 Open Graph／Twitter 標籤（`summary_large_image`，含 `twitter:description`）。可以索引。預覽圖依序使用：活動海報、最新海報、最新照片、最新 YouTube 縮圖、最後才是 `/brand/freedom-workshop.webp`（1280×720）。列表頁用品牌圖。公開、介紹活動的說明取前 160 字；沒有可公開的說明時用「自由工坊社群活動回顧：海報、照片與錄影連結。」

預覽圖的寬高跟處理器的固定輸出，不另外讀圖片位元組：活動海報橫向 1200×675、直向 900×1200；集錦照片與海報橫向 1600×1200、直向 1200×1600；YouTube 縮圖 480×360；品牌圖 1280×720。公開頁只查一次活動明細。

會員頁在「認識夥伴」裡，工坊夥伴的下一個是活動集錦。

## API 與資料表

會員路由（需要 session）：

| 方法與路徑 | 用途 |
| --- | --- |
| `GET /api/v1/event-highlights` | 已結束活動，每頁 12 筆，`mode` 與 `cursor` |
| `GET /api/v1/event-highlights/:eventId` | 單場公開欄位、項目、剩餘額度 |
| `POST /api/v1/event-highlights/:eventId/links` | JSON `{url, title?}` |
| `POST /api/v1/event-highlights/:eventId/photos` | 原始圖片 |
| `POST /api/v1/event-highlights/:eventId/posters` | 原始圖片 |
| `POST /api/v1/event-highlights/media/:mediaId/remove` | 移除 |

圖片上傳要帶 `Content-Type`、`Idempotency-Key`、`X-Photo-Orientation`，標題可放在 `X-Media-Title`（percent-encoded UTF-8）。

公開路由（不需要 session）：

| 方法與路徑 | 用途 |
| --- | --- |
| `GET /highlights`、`GET /highlights/:eventId` | 公開 HTML |
| `GET /highlights.css` | 公開頁樣式 |
| `GET /api/v1/public/event-highlights/:eventId/banner` | 活動海報 |
| `GET /api/v1/public/event-highlights/media/:mediaId/image` | 照片或海報 |
| `GET /api/v1/public/event-highlights/media/:mediaId/thumb` | 預覽 |

圖片回應是 `image/webp`，`Cache-Control: public, max-age=300`。列表與明細的 JSON 不包含圖片位元組。

資料表：

- `community_event_highlights`：項目中繼資料。`kind` 為 `link`、`photo` 或 `poster`。有效連結以 `(event_id, url)` 唯一。
- `community_event_highlight_images`：`image` 與 `thumb` 的位元組，每份最多 1 MiB。列表查詢不讀這張表。

新增與移除都會寫入 `transition_journal`（`community_event_highlight`）。

## 部署順序

先套用 migration `065_event_highlights.sql`，再發布 Worker。表還沒建立就上新程式，公開頁與會員頁都會在查詢時失敗。

程式入口：`modules/community/event-highlights.ts`、`modules/community/event-highlights-page.ts`、`apps/platform-api/src/routes/event-highlights.ts`、`apps/portal-web/src/modules/EventHighlights.tsx`。YouTube 影片編號的純函式在 `packages/shared/youtube-video-id.ts`。

對應測試是 `tests/runtime/event-highlights.test.ts`、`tests/e2e/event-highlights.spec.ts`，以及 Worker 對 `/highlights` 不落入 SPA shell 的檢查。
