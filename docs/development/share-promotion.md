# 分享連結與推廣排行榜

社員可以建立個人分享連結。別人點開才會計分，分數只顯示在六塊排行榜上，用來比較誰幫忙把內容帶出去。分數不是經驗、獎勵、貢獻或驗收。

六種分享各有一塊榜。名片先留好資料與空榜，建立連結會回 422。社員服務已可建立連結。

| kind | 分享對象 | 排行榜 | 現況 |
| --- | --- | --- | --- |
| `member_card` | 會員自己的名片 | 名片點擊排行榜 | 尚未開放 |
| `platform` | 自由工坊本身 | 平台推廣排行榜 | 已做 |
| `skill_book` | 目錄技能書或已公開的社群技能書 | 技能推廣排行榜 | 已做 |
| `social_post` | 社群媒體分享專區的一則貼文 | 社群推廣排行榜 | 已做 |
| `member_service` | 一項公開的社員服務 | 業務推廣排行榜 | 已做 |
| `event` | 已公開的社群活動 | 活動推廣排行榜 | 已做 |

`target_key` 的格式：平台是 `workshop`；技能書是 `book:<技能 id>` 或 `submission:<uuid>`；活動、貼文與社員服務都是該筆 uuid。名片仍是日後的 uuid。

## 為什麼先經過中繼頁

會員 session cookie 是 `SameSite=Strict`。從 LINE、Facebook 或其他網站點進來時，瀏覽器不會帶 cookie，直接 302 無法分辨是不是本人在點自己的連結。連結預覽機器人也不該計分。

所以 `GET /go/:code` 先回同一來源的小頁。頁面上的 `/go.js` 再用 same-origin 請求回報點擊，這次才帶得上 session，然後才前往目標。

未知、已撤銷，或目標已不能分享（貼文刪除或隱藏、活動取消／退回／未公開、技能書不存在）時，這個網址 302 回首頁。除了技能書的 `intro`（1–999），其他 query 都忽略，避免開放式重導。

中繼頁含 `noindex,nofollow`、`Cache-Control: no-store`、`Referrer-Policy: no-referrer`，以及網站既有的 CSP。不放 inline script 或 style。OG 圖網址使用 runtime 的公開來源。`og:type` 是 `website`。`og:url` 是這條個人連結本身（公開來源 + `/go/<code>`）；技能書只有在 `intro` 有效（1–999）時才附上 `?intro=N`。它不是目標網址，否則 Facebook 會把分享收成目標頁、跳過個人連結。僅限會員的活動不放標題、內文或海報，只顯示「自由工坊會員活動」。

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

`GET /api/v1/promotion/links/mine` 只讀。週、月、累計與所選期間的分數在同一則查詢用 `count(...) FILTER` 算出，不會為了標題去建立活動分享碼，也不會一條連結再查一次分數。出現過的活動、貼文、已公開社群技能書、社員服務各最多再讀一次（`= ANY`，限本人的社群）；目錄技能書不查資料庫。已公開技能書的條件與 `PUBLISHED` 同一份。每一筆有 `available`：活動要已公開、貼文要是有效、目錄書要在架上、社群技能書要已發布、社員服務要仍公開且擁有者有效。開不了的連結在「我的推廣連結」變淡、顯示「已無法開啟」、沒有複製鈕，分數仍留著。

## 隱私

不保存原始 IP 或 User-Agent。訪客鍵與網路鍵是當天 32-byte salt 加網路（以及匿名訪客的 User-Agent）的 SHA-256。Salt 存在 `promotion_click_salts`，第一次用到那天時建立，並順便刪掉超過 3 天的列（`click_day < 今天 - 3`）。

## 社群媒體分享專區

社員貼一則 https 連結。主機轉小寫、去掉 fragment，並拿掉 `utm_*`、`fbclid`、`igshid`、`si`。拒絕帳密、非預設埠、IP、localhost、單層主機，以及 `.local`、`.internal`、`.lan`。

平台依主機分成 YouTube、Instagram、Facebook、Threads、TikTok、X，其餘為「其他」。同一社群已有相同有效網址時回 409 `social_post_exists`，並帶原本的 `post_id`。

新增貼文在連外之前先驗證內容並正規化網址。網址已經有人分享就直接回 409，不抓頁面。接著每位會員每小時最多預覽 30 次（`social-post-preview`），第 31 次回 429。`freetwai.com`、它的子網域，以及與 `runtime.publicOrigin` 相同的主機，回 422 `social_post_url`，說明是「請分享社群平台上的貼文。」站內的 `/go/` 再貼進專區會讓一次瀏覽記兩次分。

標題用投稿者填的；沒填就用預覽抓到的頁面標題（最多 120 字）；再沒有就用主機名。預覽失敗仍可建立貼文，只是沒有縮圖。作者可換縮圖或軟刪除。能審核活動的平台管理員可隱藏；公會長不行。隱藏或刪除後，列表看不到，分享連結回到首頁，公開縮圖 404。

預覽抓取（`modules/community/link-preview.ts`）由 runtime 注入。YouTube 取影片 id（`watch?v=`、`youtu.be`、`/shorts/`、`/live/`、`/embed/`），再抓 `i.ytimg.com` 的 `hqdefault.jpg`，標題可選 oEmbed。其他平台讀 `og:image`、`og:image:secure_url` 或 `twitter:image`。限制是：`redirect:manual`、最多 3 次重導、每一跳都重跑網址規則、全程 6 秒、HTML 最多 1 MiB、圖片最多 5 MiB。回應只要聲明 `image/*` 就收下；格式以檔案簽名判斷，不採用對方的 Content-Type。GIF、動畫 PNG、動畫 WebP、簽名不符或超過 5 MiB 時捨棄縮圖、保留標題。靜態 png／jpeg／webp 正規化成 640×360 的 WebP（`social_thumbnail`）。處理器失敗就沒有縮圖，不讓貼文失敗。上傳的縮圖仍要聲明類型與簽名一致，且在 512 KiB 以下。User-Agent 固定為 `FreedomWorkshopPreview/1.0 (+https://freetwai.com)`。測試與 e2e 使用假的 fetcher，不連外網。

## API

會員路由沿用 session、CSRF、Origin 與新人定位。點擊與公開縮圖在 session middleware 之前。

| 方法與路徑 | 誰 | 用途 |
| --- | --- | --- |
| `GET /go/:code` | 公開 | 中繼頁，或 302 回首頁 |
| `POST /api/v1/promotion/clicks` | 公開 | `{code}`，永遠 `{ok:true}` |
| `POST /api/v1/promotion/links` | 會員 | 取得或建立個人連結 |
| `GET /api/v1/promotion/links/mine?period=` | 會員 | 自己的連結、各期間分數與 `available`；只讀 |
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

資料表在 `migrations/063_share_promotion.sql`：`promotion_links`、`promotion_clicks`、`promotion_click_salts`、`community_social_posts`、`community_social_post_thumbnails`。有效連結以部分唯一索引保證一人一種目標一條；有效貼文的網址同樣唯一。`promotion_links_target` 索引 `(kind, target_key)`，給貼文列表的點擊合計、活動推薦報表，以及之後的服務列表用。

部署時先套用 migration 063，再套用 065，然後換 Worker。064 不是這次變更。Worker 的預覽 fetch 必須是未綁定的 `globalThis.fetch`。

程式入口：`modules/community/promotion.ts`、`modules/community/social-posts.ts`、`modules/community/member-services.ts`、`modules/community/link-preview.ts`、`packages/shared/share-url.ts`、`packages/shared/promotion-bots.ts`、`packages/shared/member-service.ts`、`apps/platform-api/src/routes/promotion.ts`、`apps/platform-api/src/routes/member-services.ts`。介面是「社群分享」、「社員服務」與「推廣排行榜」，技能書架、活動與會員首頁接同一套分享對話框。

測試入口：`tests/runtime/share-promotion.test.ts`、`tests/runtime/member-services.test.ts`、`tests/runtime/link-preview.test.ts`、`tests/worker/share-go.test.ts`、`tests/e2e/share-promotion.spec.ts`、`tests/e2e/member-services.spec.ts`。瀏覽器測試前先 build。預覽不得打到 YouTube、Instagram、Facebook 或其他外站。

## 社員服務

社員可以列出自己的本業服務。任何看得到該服務的社員都能用自己的 `/go/` 連結分享；點的人不是分享者本人，才算分享者的業務推廣分。服務主人分享自己的服務，分數也算主人的。

每位社員最多 5 項 `active` 或 `paused` 服務。隱藏與刪除不計入，上限在交易裡用 advisory lock 檢查，沒有資料庫 CHECK。分類是 `hair_beauty` 美髮造型・假髮、`courses` 課程・教學、`language` 語言教學、`design` 設計、`photo_video` 攝影・影音、`tech` 技術・開發、`consulting` 顧問・諮詢、`handmade` 手作・商品、`other` 其他。服務方式是 `online`、`in_person` 或 `both`。

標題 1–80 字、簡介 1–160 字、說明最多 2000 字、價格與地區各最多 60 字。聯絡方式 1–3 個，名稱 1–20 字。網址必須是 https，沒有帳密、非預設埠、本機或 IP 主機，並用 `normalizeShareUrl` 正規化後儲存。表單送出前跑同一份檢查。

建立、修改、暫停、恢復與刪除只有主人能做。修改、暫停、恢復、刪除、封面與隱藏都要 `If-Match` 的 `aggregate_version`，並用 Idempotency-Key。刪除是軟刪除（`state=deleted`），同時刪掉封面。暫停只給主人在「我的服務」看見；公開頁與 `/go/` 都回到找不到。平台管理員可隱藏；公會長不行。隱藏後各處都看不到，`/go/` 回到首頁。擁有者停用或是驗收測試帳號時，其他人與公開頁都看不到，主人仍可在會員介面看見自己的有效服務。

封面輸入是 JPEG、PNG 或 WebP，最多 4 MiB，簽名與動畫檢查與其他上傳相同。輸出是 `service_cover`，`cover` 成 1200×675 的 WebP，最多 512 KiB。上傳是帶 Idempotency-Key 與 If-Match 的二進位 PUT。會員看封面走 `GET /api/v1/member-services/:id/cover`（暫停的服務主人仍看得到）；公開封面是 `GET /api/v1/public/member-services/:id/cover`。

公開頁 `GET /services` 每頁 12 筆，分類是連結，下一頁用 `?before=`。不正確的分類或分頁標記回到第一頁，不回應那串原文。`GET /services/:id` 只顯示封面、標題、分類、主人顯示名稱、簡介、說明、價格、地區、方式與聯絡按鈕，不顯示信箱、頭像或登入資料。頁面可被索引。找不到或未公開是同一風格的 404。OG 標題是「{標題}｜{主人} 的服務｜自由工坊」，描述是簡介，圖片是封面，否則是 `/brand/freedom-workshop.webp`。可見的圖片與頁內連結用根相對路徑；canonical 與 OG 用 `runtime.publicOrigin`。

`member_service` 的目標是服務 uuid。服務仍公開、主人有效且不是測試帳號時才可分享，`/go/` 前往 `/services/<id>`。中繼頁的 OG 用服務標題、簡介與封面。業務榜的說明是「在社員服務分享區分享社員的服務，每次點擊 +1。」`member_card` 仍回 422 `promotion_kind_unavailable`。

### API

會員路由沿用 session、CSRF、Origin 與新人定位。公開封面與公開頁在 session middleware 之前。

| 方法與路徑 | 誰 | 用途 |
| --- | --- | --- |
| `GET /services` | 公開 | 服務列表，每頁 12 |
| `GET /services/:id` | 公開 | 服務頁，或同風格 404 |
| `GET /api/v1/public/member-services/:id/cover` | 公開 | 公開封面；未公開為 404 |
| `GET /api/v1/member-services` | 會員 | 有效服務，每頁 24，含 `total_points`、`my_points` |
| `GET /api/v1/member-services/mine` | 會員 | 自己的有效與暫停服務 |
| `POST /api/v1/member-services` | 會員 | 新增，需 Idempotency-Key |
| `PUT /api/v1/member-services/:id` | 主人 | 修改，需 If-Match |
| `POST /api/v1/member-services/:id/pause` | 主人 | 暫停 |
| `POST /api/v1/member-services/:id/resume` | 主人 | 恢復 |
| `DELETE /api/v1/member-services/:id` | 主人 | 軟刪除並移除封面 |
| `POST /api/v1/member-services/:id/hide` | 平台管理員 | 隱藏 |
| `GET /api/v1/member-services/:id/cover` | 看得到的會員 | 封面，含主人的暫停服務 |
| `PUT /api/v1/member-services/:id/cover` | 主人 | 上傳封面 |
| `POST /api/v1/member-services/:id/cover/remove` | 主人 | 移除封面 |

### 資料

`migrations/065_member_services.sql`：`member_services`、`member_service_covers`。公開列表索引是 `(community_id, updated_at DESC, service_id DESC) WHERE state='active'`，主人索引含有效與暫停。封面 `ON DELETE CASCADE`，但軟刪除要另外刪封面列。點擊分仍只在 `promotion_clicks`。列表的 `total_points` 用既有的 `promotion_links_target` 索引，合計該服務全部 `member_service` 連結的點擊。

本文件描述功能與維護方式；實跑結果另記於交接，不以文件存在代表已發布。
