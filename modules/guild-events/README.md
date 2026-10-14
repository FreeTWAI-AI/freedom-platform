# 近期活動公會區塊

[共同開發入口](../../packages/guild-presentation/README.md)包含預覽與 PR 流程。
本模組只呈現既有 `GET /events`（`community.event.list`，[listEvents](../community/events.ts)）已授權可讀的活動，不另建活動資料表、API、路由或 migration。

`EventsBlock.tsx` 最多顯示三筆，且必須同時符合：`state === 'published'`、`guild_key` 等於區塊收到的公會代碼、`ends_at` 仍在未來。依 `starts_at` 由早到晚排列。沒有 `guild_key` 的列（尚未完成加入的會員會拿到這種列）不顯示。草稿、待審核，以及查看者自己尚未發布的活動也不顯示。其他公會的活動即使出現在同一份清單裡也不顯示。

伺服器仍依活動的參與範圍決定這份清單看不看得到；區塊不再放寬。訪客不讀取這個端點。

時間用與活動列表相同的 `zh-TW` 年月日時分。形式沿用活動列表：線上、實體、線上與實體。標題連到既有活動專頁 `#events/<event_id>`，「查看全部活動」連到既有活動頁 `#events`。

空狀態：

- 沒有公會代碼：「這個區塊需要在公會頁使用，才能列出公會活動。」
- 這個公會沒有符合條件的活動：「這個公會目前沒有近期活動。」

日常修改限自己的元件與 `EventsBlock.spec.ts`。在根目錄執行
`npm run guild:preview`，以及 `npm run guild:test -- modules/guild-events`。
