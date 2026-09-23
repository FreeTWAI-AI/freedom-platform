# 會員社群連結

會員可在「我的名片」新增自己的社群帳號、頻道與個人網站。同一平台可保存多筆，例如個人 YouTube 與音樂頻道分開列出；每筆都有名稱、網址及自己的可見範圍。新增、修改、刪除只影響該筆，不會整包覆寫名片或其他連結。

登入 Email 仍是聯絡 Email，不增加第二個必填信箱。既有 Discord、GitHub、LINE 聯絡欄位保留原本設定；新增社群連結也不會授予平台或 GitHub 權限。

## 可見範圍

每筆新連結預設只有本人可見。可選擇公開，或複選好友、小隊夥伴、公會夥伴；複選代表符合任一有效關係即可閱讀，不要求同時符合全部關係。本人可以讀到自己的全部連結。

「公開」目前表示在工坊會員介面向有權瀏覽名片的會員展示，不會建立匿名個人檔案頁。伺服器依同社群、有效帳號與即時關係篩選讀取結果；不能只在畫面把私密網址隱藏。好友移除、退出共同小隊或公會後，後續讀取須重新判定權限。

名冊搜尋不使用這些網址、標籤或聯絡帳號。`/llms.txt`、開發導覽、公開技能書頁與分享摘要不收錄會員社群連結；Agent 文件只描述 API 和協作規範，不帶入真人資料。

## 外部連結

連結由會員自行填寫，未驗證本人是否擁有該帳號，也不構成職稱、能力、信用或官方背書。網站只顯示文字連結，不自動嵌入影片、追蹤程式或抓取外站內容。

平台選項為 Facebook、Instagram、YouTube、Threads、TikTok、LinkedIn、X、個人網站與其他。平台帳號須使用相符的官方網域；自有網域用「個人網站」或「其他」。網址須為 HTTPS，不接受帳密、控制字元、本機或私有 IP 網址。

## API 與分頁

以下路徑均以 `/api/v1` 為前綴，沿用會員 session、新人定位及 CSRF 邊界。

| 方法與路徑 | 用途 |
| --- | --- |
| `GET /me/social-links` | 本人管理清單，預設每頁 20 筆 |
| `POST /me/social-links` | 新增一筆連結 |
| `POST /me/social-links/:id/edit` | 修改本人指定連結 |
| `POST /me/social-links/:id/delete` | 刪除本人指定連結，body 為 `{}` |
| `GET /members/:id/social-links` | 依目前登入者權限讀取名片連結，預設每頁 6 筆 |

GET 支援 `limit`（1–50）與 `offset`（0–1,000,000），回傳 `{items, total, next_offset}`。其他會員的清單先套用可見範圍再計算總數及分頁，不透露藏起來的筆數。這是單次回應大小限制，不是每人只能放幾筆連結；同平台多筆紀錄也不共用一份覆寫陣列。

新增與修改 body：

```json
{
  "platform": "youtube",
  "label": "我的音樂頻道",
  "url": "https://www.youtube.com/@example",
  "audiences": ["friends", "guild"]
}
```

`platform` 為 `facebook | instagram | youtube | threads | tiktok | linkedin | x | website | other`；`label` 1–80 字，`url` 最多 2,048 字。`audiences` 省略或 `[]` 表示只限本人；可複選 `friends`、`squad`、`guild`，`public` 表示對有權瀏覽名片的工坊會員公開。

本人 DTO 有 `link_id`、`platform`、`label`、`url`、`audiences`、`aggregate_version`、`created_at`、`updated_at`、`verified: false`。他人閱讀 DTO 僅含 `link_id`、`platform`、`label`、`url`、`verified: false`，不附隱私設定或管理版本。

寫入附 `X-CSRF-Token` 與 `Idempotency-Key`；修改、刪除另附該筆最新 `If-Match`，例如 `"3"`。版本衝突時重新讀取，不覆蓋其他分頁或裝置的修改。未知結果由使用者明確重試並沿用同一操作識別碼；命令紀錄不保存私密網址，新增／修改重播會重新讀取目前資料。已刪除的重播回傳 `{link_id, deleted: true, aggregate_version}`，不復活舊網址。

## 協作邊界

這項功能由 `FreeTWAI-AI/freedom-platform` 維護；中央 API／PostgreSQL 保存權威紀錄。外部 repo 不直接寫會員資料庫，也不把會員自填的 GitHub 連結視為 OAuth 授權。

程式入口：`modules/identity-membership/social-links.ts`、`apps/platform-api/src/routes/members.ts`、`apps/portal-web/src/modules/MemberSocialLinks.tsx`；資料表見 `migrations/025_member_social_links.sql`。介面沿用「我的名片」和「工坊夥伴」，公會成員列表也使用同一個有權限的名片讀取流程。

修改時核對：同平台多筆可獨立編輯；不同筆不互相覆寫；私密預設與複選可見範圍；關係撤銷及跨社群讀取；篩選後分頁；版本衝突與明確重試；不讓外部 URL、公開索引或名冊搜尋繞過隱私。

對應測試入口是 `tests/runtime/social-links.test.ts` 與 `tests/e2e/social-links.spec.ts`；改公會名冊另跑 `tests/e2e/guild-members.spec.ts`。瀏覽器檢查前先 build，且使用專用測試資料庫及 `tests/e2e/fixtures.ts`，不修改真人名片來驗證功能。

本文件描述功能與維護方式；實跑結果及部署版本另記於交接，不以文件存在代表已發布。
