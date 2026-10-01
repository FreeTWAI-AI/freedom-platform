# 分享連結與推廣排行榜

社員可以建立個人分享連結。別人點開才會計分，分數只顯示在六塊排行榜上，用來比較誰幫忙把內容帶出去。分數不是經驗、獎勵、貢獻或驗收。

六種分享各有一塊榜。名片與社員服務先留好資料與空榜，建立連結會回 422，介面尚未做。

| kind | 分享對象 | 排行榜 | 現況 |
| --- | --- | --- | --- |
| `member_card` | 會員自己的名片 | 名片點擊排行榜 | 尚未開放 |
| `platform` | 自由工坊本身 | 平台推廣排行榜 | 已做 |
| `skill_book` | 目錄技能書或已公開的社群技能書 | 技能推廣排行榜 | 已做 |
| `social_post` | 社群媒體分享專區的一則貼文 | 社群推廣排行榜 | 已做 |
| `member_service` | 社員服務 | 業務推廣排行榜 | 尚未開放 |
| `event` | 已公開的社群活動 | 活動推廣排行榜 | 已做 |

`target_key` 的格式：平台是 `workshop`；技能書是 `book:<技能 id>` 或 `submission:<uuid>`；活動、貼文、日後的服務與名片都是該筆 uuid。

## 為什麼先經過中繼頁

會員 session cookie 是 `SameSite=Strict`。從 LINE、Facebook 或其他網站點進來時，瀏覽器不會帶 cookie，直接 302 無法分辨是不是本人在點自己的連結。連結預覽機器人也不該計分。

所以 `GET /go/:code` 先回同一來源的小頁。頁面上的 `/go.js` 再用 same-origin 請求回報點擊，這次才帶得上 session，然後才前往目標。

未知、已撤銷，或目標已不能分享（貼文刪除或隱藏、活動取消／退回／未公開、技能書不存在）時，這個網址 302 回首頁。除了技能書的 `intro`（1–999），其他 query 都忽略，避免開放式重導。

中繼頁含 `noindex,nofollow`、`Cache-Control: no-store`、`Referrer-Policy: no-referrer`，以及網站既有的 CSP。不放 inline script 或 style。OG 圖網址使用 runtime 的公開來源。僅限會員的活動不放標題、內文或海報，只顯示「自由工坊會員活動」。

## 計分

`POST /api/v1/promotion/clicks` 一律回 `{ok:true}`，不透露這次有沒有計分。以下全部成立才寫入一筆 `promotion_clicks`：

- 連結有效、未撤銷，目標仍可分享，分享者仍是有效會員。
- User-Agent 非空白，且不符合預覽機器人清單（`packages/shared/promotion-bots.ts`）。比對的是不分大小寫的子字串。
- 不是連結主人自己。已登入會員以 `m:<user_id>` 辨識，換瀏覽器同一天仍只算一次。
- 這個連結、這位訪客、台北時區的今天，還沒有計過分。
- 這位訪客今天全部連結合計少於 20 分。
- 這個網路今天全部連結合計少於 60 分。

同一筆用主鍵 `ON CONFLICT DO NOTHING` 擋住，並用 advisory lock 串起同一訪客與同一網路的同時請求。一天的界線是台北時間 00:00。

LINE 應用內瀏覽器（例如 `Line/14.15.0`）、Facebook／Instagram 應用內瀏覽器（`FBAN/FBIOS`、`FB_IAB`、`Instagram 350.0`）要計分。清單不匹配單獨的 `line`，也不把 `javascript` 當成 `java/`。`HeadlessChrome` 含有 `headless`，不算。

每位會員每天最多新建立 200 條連結；已存在的同一條再取一次不算新的。每人每天最多新貼 20 則社群貼文。點擊路由另有每網路每小時約 300 次的速率限制，超過回 429，同樣不計分。

## 隱私

不保存原始 IP 或 User-Agent。訪客鍵與網路鍵是當天 32-byte salt 加網路（以及匿名訪客的 User-Agent）的 SHA-256。Salt 存在 `promotion_click_salts`，第一次用到那天時建立，並順便刪掉超過 3 天的列（`click_day < 今天 - 3`）。

## 社群媒體分享專區

社員貼一則 https 連結。主機轉小寫、去掉 fragment，並拿掉 `utm_*`、`fbclid`、`igshid`、`si`。拒絕帳密、非預設埠、IP、localhost、單層主機，以及 `.local`、`.internal`、`.lan`。

平台依主機分成 YouTube、Instagram、Facebook、Threads、TikTok、X，其餘為「其他」。同一社群已有相同有效網址時回 409 `social_post_exists`，並帶原本的 `post_id`。

標題用投稿者填的；沒填就用預覽抓到的頁面標題（最多 120 字）；再沒有就用主機名。預覽失敗仍可建立貼文，只是沒有縮圖。作者可換縮圖或軟刪除。能審核活動的平台管理員可隱藏；公會長不行。隱藏或刪除後，列表看不到，分享連結回到首頁，公開縮圖 404。

預覽抓取（`modules/community/link-preview.ts`）由 runtime 注入。YouTube 取影片 id（`watch?v=`、`youtu.be`、`/shorts/`、`/live/`、`/embed/`），再抓 `i.ytimg.com` 的 `hqdefault.jpg`，標題可選 oEmbed。其他平台讀 `og:image`、`og:image:secure_url` 或 `twitter:image`。限制是：`redirect:manual`、最多 3 次重導、每一跳都重跑網址規則、全程 6 秒、HTML 最多 1 MiB、圖片最多 5 MiB、只接受 png／jpeg／webp。User-Agent 固定為 `FreedomWorkshopPreview/1.0 (+https://freetwai.com)`。圖片再正規化成 640×360 的 WebP（`social_thumbnail`）。處理器失敗就沒有縮圖，不讓貼文失敗。測試與 e2e 使用假的 fetcher，不連外網。

## API

會員路由沿用 session、CSRF、Origin 與新人定位。點擊與公開縮圖在 session middleware 之前。

| 方法與路徑 | 誰 | 用途 |
| --- | --- | --- |
| `GET /go/:code` | 公開 | 中繼頁，或 302 回首頁 |
| `POST /api/v1/promotion/clicks` | 公開 | `{code}`，永遠 `{ok:true}` |
| `POST /api/v1/promotion/links` | 會員 | 取得或建立個人連結 |
| `GET /api/v1/promotion/links/mine?period=` | 會員 | 自己的連結與該期間分數 |
| `GET /api/v1/promotion/leaderboards?period=` | 會員 | 六塊榜，`week`／`month`／`all` |
| `GET /api/v1/social-posts` | 會員 | 有效貼文，每頁 24 |
| `POST /api/v1/social-posts` | 會員 | 新增貼文，需 Idempotency-Key |
| `PUT /api/v1/social-posts/:id/thumbnail` | 作者 | PNG／JPEG／WebP，512 KiB 以下 |
| `GET /api/v1/social-posts/:id/thumbnail` | 會員 | 有效貼文的縮圖 |
| `GET /api/v1/public/social-posts/:id/thumbnail` | 公開 | 同上；隱藏或刪除為 404 |
| `DELETE /api/v1/social-posts/:id` | 作者 | 軟刪除 |
| `POST /api/v1/social-posts/:id/hide` | 平台管理員 | 隱藏 |

`period=week` 從週一 00:00（台北）起算，`month` 從當月 1 日 00:00 起算，`all` 的 `since` 是 null。榜上同分數並列（1、2、2、4），再以顯示名稱與 user id 排序。只計本人所屬社群的有效、已完成定位會員；驗收測試帳號不出現在別人的榜上。每人最多看前 10 名，`me` 是自己的名次，0 分則為 null。頭像規則與會員列表相同。

活動分享沿用原本的活動分享碼。點進 `/go/` 後會到 `/events/<id>?ref=<分享者的活動碼>`，報名統計多了「點擊 N・報名 M 人」。舊的 `?ref=` 連結仍可報名，只是沒有點擊分。

## 資料與部署

資料表在 `migrations/063_share_promotion.sql`：`promotion_links`、`promotion_clicks`、`promotion_click_salts`、`community_social_posts`、`community_social_post_thumbnails`。有效連結以部分唯一索引保證一人一種目標一條；有效貼文的網址同樣唯一。

部署時先套用 migration 063，再換 Worker。Worker 的預覽 fetch 必須是未綁定的 `globalThis.fetch`。

程式入口：`modules/community/promotion.ts`、`modules/community/social-posts.ts`、`modules/community/link-preview.ts`、`packages/shared/share-url.ts`、`packages/shared/promotion-bots.ts`、`apps/platform-api/src/routes/promotion.ts`。介面是「社群分享」與「推廣排行榜」，技能書架、活動與會員首頁接同一套分享對話框。

測試入口：`tests/runtime/share-promotion.test.ts`、`tests/runtime/link-preview.test.ts`、`tests/worker/share-go.test.ts`、`tests/e2e/share-promotion.spec.ts`。瀏覽器測試前先 build。預覽不得打到 YouTube、Instagram、Facebook 或其他外站。

本文件描述功能與維護方式；實跑結果另記於交接，不以文件存在代表已發布。
