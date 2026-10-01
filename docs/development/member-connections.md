# 新人入口與會員交流

依 [Issue #42](https://github.com/FreeTWAI-AI/freedom-platform/issues/42)（Hao0321 的 9/30 意見）與 [#43](https://github.com/FreeTWAI-AI/freedom-platform/issues/43) 設計；最初實作來自 Hao0321 的 [PR #68](https://github.com/FreeTWAI-AI/freedom-platform/pull/68)。

加入門、分享名片、好友名單與夥伴推薦的資料在 migration `063_member_connections.sql`：`users.onboarding_entry_mode`（`assessment` 或 `quick`，既有列預設 `assessment`）、`member_card_shares`、`guild_discovery_reports`。公會小問題的答案在 migration `064_member_guild_answers.sql` 的 `member_guild_answers`，每位會員每個公會一筆。

## 新人入口

2026-10-01 整合 Issue #42。新會員仍須**先選擇主要公會，並領取該公會技能書，會員功能才開放**。這道門維持。定位測驗不再是新註冊的必經步驟，可以稍後再做。加入由本人自助完成，沒有審核；既有會員不會被重新封鎖。

歡迎畫面有兩條路：

- **快速加入**是主要入口。從完整公會清單選一個主要公會，清單可搜尋，也可依主題篩選。選好後回答這個公會的 3 到 4 個小問題，再完成加入。
- **定位測驗**提供公會建議。做完後仍由本人確認要加入的公會。這條路不在加入當下強迫回答公會小問題，可以稍後在「我的定位」補。

流程是：Email／密碼（暱稱選填）→ 選主要公會（快速加入或定位測驗）→ 回答所選公會的 3–4 個小問題 → 領技能書 → 開放平台。快速加入、尚未做完測驗的會員，會員首頁顯示「補做定位測驗」，直到測驗完成。

還沒選定主要公會時，登入後的會員 API 只放行加入所需的白名單（含 `POST /api/v1/me/onboarding/quick-start`）。其他會員 API 回 403 `onboarding_required`，說明是「請先選擇主要公會，完成加入後即可使用會員功能。」

`POST /api/v1/me/onboarding/quick-start` 的內容是 `{guild_keys, primary_guild_key, confirmed:true, guild_answers}`。`guild_answers` 要答完主要公會的每一題，選項必須是該題提供的。少答、多答或選項不對回 422 `guild_answers_invalid`，這次不會加入。它在加入門還沒過時可以使用：同一交易加入所選公會、存下小問題答案、設主要公會、領技能書，並記下 `onboarding_completed_at` 與 `entry_mode=quick`。未完成的定位草稿留著，不捏造定位答案、分數或「已完成定位」。已經完成加入回 409 `onboarding_already_completed`。主要公會不在這次選擇裡，或公會鍵不在目錄，回 422。日記與 outbox 只記公會鍵和題組版本，不放答案。`GET /api/v1/guilds/directory` 的每個公會帶 `entry_questions`（題庫，不是某人的答案）。加入之後，`GET/POST /api/v1/me/guild-answers` 讓本人查看或修改；職業公會頁加入成功時，也可以順手前往「我的定位」的「公會小問答」。答案只給本人。`GET /api/v1/me/onboarding` 另有 `entry_mode`（`assessment` 或 `quick`）與 `assessment_completed`。欄位與錯誤見 [定位、公會與技能書 API](onboarding-api.md)。

註冊頁、加入後的首頁下一步與聊天室的後續修改見 [簡約會員體驗](calm-member-experience.md)。

管理員在會員名單看到 `onboarding_entry_mode`，並把加入方式顯示成「已完成定位」、「已加入（未做定位）」、「尚未完成加入」或「既有會員」。見 [管理介面 API](platform-admin-api.md)。

## 分享工坊名片

分享預設關閉。會員在我的名片建立連結；停用後連結失效。重新開啟或按「更新連結」會發出新的 token。Token 是 32 byte 的 base64url，43 個字元，無法由會員 ID 猜出。樣式、一句話介紹和連結存在同一列，migration `068_member_card_designs.sql` 加上 `design`、`headline`、`links`。舊列維持清新、沒有介紹、沒有連結。

名片編輯會自動儲存。頭像勾選、樣式、一句話介紹、手動連結（加入、編完、移除、排序、從社群連結匯入）和下面的公開項目開關，都不用再按保存。介紹在停止輸入約 800 毫秒後送出，離開欄位時立刻送出。一次只送一筆；後改的內容蓋過先送出的那筆，下一筆用上一筆回傳的 `aggregate_version`。回應不會把儲存期間又打上去的字蓋掉。客戶端就知道不合法的內容（例如介紹超過 60 字）只顯示在欄位旁，不會送出。版本衝突（412），以及這一邊還沒有版本、另一邊已經建立名片時的 428 `version_required`，都會重新載入，並說明名片設定在其他地方更新了。儲存或這次重新載入失敗就停下來，狀態顯示錯誤和「重試」，不會自己再送；下一筆要等會員按「重試」、再改一個欄位，或按「建立分享連結」、「更新連結」、「停用分享」。介紹若在按下之後變成不合法，該次動作會取消，按鈕恢復可按，並請會員先修正一句話介紹再按一次。還沒打開分享時，存好會說明要先建立分享連結，朋友看到的才是這個樣子。還沒建立連結時也會以 `enabled: false` 存下選擇；「建立分享連結」才把名片打開。自動儲存永遠帶 `rotate: false`，而且 `enabled` 用最新一次伺服器回應，不會自己把關閉的名片打開。只有「建立分享連結」、「更新連結」、「停用分享」可以換 token 或切換開關，而且跟自動儲存排同一條佇列。

公開頁 `/member-cards/<token>` 呈現的就是預覽那張名片：暱稱、一句話介紹、手動連結、目前主要公會、最多三項最後確認的精選能力、**本人勾選後**的頭像，以及下面這份公開聯絡方式。樣式是清新、工坊、夜空或經典名片。尚未儲存過分享設定的會員，頭像勾選是關的。已確認名片若有精選清單就用那份，否則用已確認能力的前三項；還沒完成定位、沒有已確認名片時，這一份是空的。進行中的草稿不會出現。手動連結仍是最多 8 個，要自己加入；「從我的社群連結加入」只是把一筆抄進這 8 個，不會取代自動帶入的項目。

「平台公開」的範圍除了已登入會員，在分享名片打開之後也包含拿到這條連結的人。對方不必登入。只勾好友、小隊或公會的項目不會出現。本人可以整組關掉，也可以逐項隱藏。Email 是登入帳號，預設不放上名片。

自動帶入的來源有兩種，對應函式是 `mapMemberCardProfileLinks`（網址只在伺服器組，客戶端不自己拼）：

- `member_accounts.contacts` 裡、值不是空的、公開對象含 `public` 的聯絡方式。Email 的值就是登入信箱。順序是 LINE、GitHub、Discord、Email。
- 未刪除、`audiences` 含 `public` 的 `member_social_links`，依 `created_at, link_id`。

LINE：`line.me` / `lin.ee`（含子網域）上、沒有帳號密碼、最多 300 字的 https 網址照原樣使用；`@` 開頭的官方帳號組成 `https://line.me/R/ti/p/`；4 到 20 字的 ID 組成 `https://line.me/ti/p/~`；電話、其他文字、`javascript:` 這類沒有網址，只能複製。GitHub 帳號要是 1 到 39 個字、只含英數與連字號，而且開頭和結尾都是英數，才組成 `https://github.com/<login>`；否則保留帳號、網址是 null，名片上只能複製。Discord 沒有網址，名片上是複製按鈕。Email 是 `mailto:`。社群連結只留下能解析成 https、而且沒有帳號密碼、也不是本機位址的網址（和寫入 `social-links.ts` 同一條規則）；舊的 http 或其他網址整筆不出現。小字是拿掉 `www.` 的主機名。讀取時 SQL 已加 `deleted_at IS NULL`，才能用部分索引 `member_social_links_owner`；程式仍會再濾掉已刪除的列。

項目要同時滿足 `show_profile_links` 為真，而且 `profile_link_prefs[source]` 沒有寫時，除了 `contact:email` 以外都算顯示。手動連結的網址如果和某個項目完全相同，公開頁留手動連結、拿掉那個項目。設定頁仍列出它，方便再打開。

migration `074_member_card_profile_links.sql` 加上 `show_profile_links` 和 `profile_link_prefs`。既有列在加上欄位時預設關閉，因為那些名片是在聯絡方式會出現之前就打開的；新列預設打開。沒有另外的欄位授權，沿用資料表的預設權限。

絕不呈現：會員 ID、未標成平台公開的聯絡方式、已隱藏的項目、已刪除或只給好友／小隊／公會的社群連結、裝備、定位答案、職業。驗證帳與測試帳不能分享。未完成加入、已停用，或分享已關閉時，舊連結回 404。從聯絡方式拿掉「平台公開」，或刪掉一筆社群連結，下一筆讀取就不會再出現，不必重存名片。

公開 JSON（`GET /api/v1/public/member-cards/:token`）有 `design`、`headline`（沒有就是 null）、`links`（`{label, url}`）和 `profile_links`（`{platform, label, handle, url}`，只有顯示中的項目）。沒有 `source`、沒有連結 id、沒有隱藏項目。聯絡方式、社群連結和分享列的條件在同一個 SQL 敘述裡讀。頭像，以及 `/member-cards/<token>` 頁面都是 `Cache-Control: no-store`，並送 `X-Robots-Tag: noindex, nofollow`。noindex 不是存取控制。打得開這張名片的，是這個 token，加上本人的開關。

已登入、看的不是自己的名片時，仍會在電子名片下面看到對方平常的會員名片（`GET /api/v1/member-cards/:token/member`），聯絡方式仍依原本的好友、公會與小隊範圍。分享不會建立好友。本人打開自己的連結時只看到這張電子名片，並可回到我的名片繼續改。

寫入是 `GET/POST /api/v1/me/member-card-share`。內容是 `{enabled, include_avatar, rotate?}`，也可以帶 `design`、`headline`、`links`、`show_profile_links`、`profile_link_prefs`。省略的欄位保留目前的值；第一筆儲存若沒帶 `show_profile_links`，新名片是打開的。`headline: null` 或空白會清掉介紹；有送 `links` 就整份取代。`profile_link_prefs` 也是整份取代，最多 64 個鍵，鍵必須是 `contact:line|github|discord|email` 或 `social:` 加小寫 uuid，值必須是布林，否則 422 `member_card_profile_links_invalid`。連結名稱 1–30 字、單行；網址必須是沒有帳號密碼的 https，最多 300 字。不接受 http、javascript、data。樣式、介紹或連結不合法回 422，說明是中文。沿用 Idempotency-Key；已有設定時要帶目前的 If-Match，沒帶回 428 `version_required`，版本不對回 412。回應帶 `design`、`headline`、`links`、`show_profile_links`、`profile_link_prefs`、`profile_links`（含隱藏項目與 `source`、`shown`）和啟用時的 `share_path`。`shown` 只看單項設定，不看總開關。日記只記開關、是否換連結、樣式、介紹字數、連結數量、`show_profile_links` 和隱藏項目的數量，不記 token、介紹本文、帳號、網址。

推廣讀取用 `readPublicCards(pool, communityId, userIds)`。它不讀這些公開項目，也不寫入。它只讀、一批一查，回傳目前公開看得到的名片：`path`、`title`（「暱稱 的自由工坊名片」）、`summary`（有介紹用介紹，否則是主要公會和最多三項專長，以「・」連接，最多 120 字）、`image: null`、`generation`（分享 token 的 sha256 前 16 個十六進位字；更新連結或重新開啟才會變）。查不到的 id 不在結果裡。token 只出現在 `path`。自動儲存不換 token，所以既有的推廣連結還能計分。

我的名片上的「分享名片」會建立個人推廣連結（`/go/<code>`），別人點開才計入名片點擊排行榜。「開啟名片」仍直接打開這張名片，不計分；還有變更沒送出時它會停住，避免打開舊的那一版。規則見 [分享連結與推廣排行榜](share-promotion.md)。

和計畫的兩處差異：

- [04 模組規格](../platform-plan/04-module-specifications.md) 約在分享卡那一列寫短效 token，並由會員自選欄位。這裡的連結會一直有效，直到本人關閉或更新，因為邀請連結需要持續打得開。本人可選的是頭像、樣式、一句話介紹、最多 8 個手動連結，以及要不要顯示、逐項隱藏那些標成平台公開的聯絡方式和社群連結。名稱、主要公會和精選專長仍是固定帶出的。
- 匿名查看是「平台公開＝已登入同社群會員、沒有匿名人員名錄」的一項新的、須本人開啟的例外。一位會員一條連結、一張名片，沒有名單，也不能搜尋。名片打開之後，本人留在名片上的平台公開項目，拿到連結的人也看得到。

## 我的好友

好友沿用既有的 `member_friendships`。側欄「我的好友」有三個範圍：已接受（`accepted`）、收到的邀請（`incoming`）、送出的邀請（`outgoing`），可依暱稱搜尋並分頁。

`GET /api/v1/friends/directory?scope=accepted|incoming|outgoing&search=&limit=&offset=` 先篩有效關係、同社群、有效會員與搜尋，再分頁。`limit` 1–50（預設 20），`offset` 0–10000。待回覆的邀請仍然看不到聯絡方式。舊的 `/friends` 通知入口保持相容。

計畫裡的 `MemberConnection` 與 `/me/network` 仍是後續工作，這份名單不是那份模型。

## 認識一位工坊夥伴

[#43](https://github.com/FreeTWAI-AI/freedom-platform/issues/43) 的推薦出現在會員首頁和我的名片。每次呈現一位，一定附理由，可以查看名片或送出好友邀請。

排序只用雙方目前都有效的共同公會，以及已確認名片上的能力。共同公會權重較高。理由依序是「你們都加入了…」（最多兩個公會名）、「你們公開的專長有共同項目」，或「認識不同領域的工坊夥伴」。名單依台北日期輪替；「換一位」看下一位，當日名單走完回到第一位。

排除本人、已是好友或待回覆邀請、未完成加入、已停用、其他社群，以及測試帳。不用 XP、年資、Email、私人定位答案或定位分數（見 [01](../platform-plan/01-product-community-model.md) 的推薦說明，以及 [04](../platform-plan/04-module-specifications.md) 不以定位分數篩人、推薦不是授權判斷）。

持久的「不再推薦」或儲存推薦沒有做。

`GET /api/v1/members/recommendations?limit=1&offset=0`。`limit` 最多 3。

## 公會主題篩選

主題寫死在 `packages/shared/guild-topics.ts`，快速加入與職業公會頁共用：

| 鍵 | 標籤 |
| --- | --- |
| `technology` | AI 與技術 |
| `creation` | 影音與創作 |
| `commerce` | 商品與電商 |
| `community` | 社群與活動 |
| `collaboration` | 專案與合作 |
| `learning` | 學習與探索 |

內建公會有固定對照。管理員核准成立的公會不在對照裡，依名稱與目的的關鍵字推主題；對不上可以沒有主題。由管理員自行維護主題是後續工作。

## 每日公會目錄分析

既有的十分鐘 cron 在設定了 `FREEDOM_REGISTRATION_COMMUNITY_ID` 時會跑目錄分析。資料庫以每社群一筆報告、兩分鐘 lease 限制成每天一份；成功後下次在一天後。目錄讀取失敗時，約一小時後可再試。模型失敗或輸出不合法仍保存目錄比對，並標明原因。

只靠目錄的規則不需要模型。它用共同主題、描述用詞與技能書，列出最多 12 組可討論的方向，標示為依公會目錄與技能書比對。

選配的 AI 分析預設關閉。三項都要有才會呼叫：`FREEDOM_GUILD_REVIEW_ENABLED=true`、`AI` binding、`FREEDOM_GUILD_REVIEW_MODEL`。目前的部署模板沒有設定這三項。通過驗證的模型輸出才標成 AI。建議只接受目錄裡不同的公會鍵、限長理由、目的差異，以及 `collaborate`、`clarify` 或 `consider_merge`，最多 12 組，不接受額外欄位。送給模型的只有公會名稱、目的、主題與技能書標題，沒有會員、答案或聯絡資料。

分析不會寫入或合併公會。合併仍是管理員的決定。

待確認：呼叫使用 `response_format: {type: 'json_object'}`，Cloudflare 文件寫的是 `json_schema`。啟用前要先核對 [Workers AI JSON mode](https://developers.cloudflare.com/workers-ai/features/json-mode/)。

管理入口是 `GET /admin/api/guild-discovery` 與 `POST /admin/api/guild-discovery/refresh`，沿用 Access 與管理 CSRF。更新只處理已到期的報告。

## 公會申請進度

[Issue #51](https://github.com/FreeTWAI-AI/freedom-platform/issues/51)：會員的 `GET/POST /api/v1/guild-applications` 只回本人看得到的欄位。送出後表單收起，職業公會頁的「我的公會申請」顯示待審核、已通過或未通過。已通過可查看公會；未通過可修改後重新申請，原紀錄留作歷史。欄位與畫面文字見 [定位、公會與技能書 API](onboarding-api.md)。管理員審核與通過／未通過通知維持原樣。

## 提案截圖（Issue #42，2026-10-01）

以下截圖是提案畫面，現在的畫面可能不同。

- [320px 快速加入公會](../design/member-connections/issue-42-quick-entry-320.png)
- [320px 訪客分享名片](../design/member-connections/issue-42-public-card-320.png)
- [好友列表桌面版](../design/member-connections/issue-42-friends-desktop.png)
- [320px 好友列表](../design/member-connections/issue-42-friends-320.png)
- [320px 公會主題篩選](../design/member-connections/issue-42-guild-tags-320.png)
