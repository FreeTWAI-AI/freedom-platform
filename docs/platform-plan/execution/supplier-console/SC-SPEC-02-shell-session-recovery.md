# SC-SPEC-02 殼層、session、草稿與操作恢復

需求：SC-R05、R07、R10、R11、R12、R13。驗收：AT-03、06、07、10、29、34、36、37、42、44。

## 目的與非目標

把舊頁已經正確的恢復語意（held attempt、session 圍欄、讀取票號、離開保護）搬進新殼層，並補上計畫要求但舊頁沒有的 412 草稿保留。非目標：跨重新整理保存草稿、通用前端快取、背景自動重送。

## 掛載與身分

- `site.supplier_console_enabled === true` 時，`HostedStore` 對 `#stores/<t>/<i>/supply[/…]` 與 `…/supply-orders` 掛 `SupplierConsole`；否則維持 `HostedSupplyCatalog`／`HostedSupplierOrders`（回退路徑）。
- 元件 key＝`${userId}:${client.sessionGeneration}:${tenantId}:${instanceId}`（沿用 `HostedStore.tsx:71,73`）。換帳號、session 世代或事業都會整個卸載：所有讀取 abort、草稿丟棄、票號作廢。
- 同一事業內換頁只改 props，controller 不重建，因此草稿與未確認操作跨頁保留。
- 顯示用的 scope 值（事業名稱、能力、owner 與否）只來自本 scope 成功的讀取；換 scope 前的回應一律丟棄（`AbortController`＋票號＋`sessionGeneration` 三重比對）。

## Controller

一個 `useSupplierConsoleController(scope)`，放在 `modules/agent-commerce/supplier-console/state/`，頁面只呈現：

| 狀態 | 內容 |
| --- | --- |
| `profile` | `GET R/supply-profile` 的結果與讀取狀態 |
| `owner` | `GET R/reservation-setting` 成功＝owner；403／404＝不是；其他錯誤＝未知（可重試） |
| `reads` | 各頁讀取：`{state: idle｜loading｜ready｜failed, data, asOf, lastOkAt, ticket}` |
| `drafts` | 具名草稿：`product:new`、`product:<id>:content`、`product:<id>:stock`、`product:<id>:terms`、`settings:profile`；每份記錄 `baseVersion`、使用者改過的欄位與值 |
| `held` | 唯一的進行中／未確認命令（見下） |

讀取規則：

1. 每次讀取發一張票號並帶 `AbortSignal`；回來時票號、scope、`sessionGeneration` 任一不符就丟棄。
2. 重新讀取期間舊資料可留在畫面上，但必須標示其 `as_of` 與「更新中」；失敗時標「未更新（最後成功 hh:mm）」。不把舊值或 0 重新標成最新。
3. 命令成功後一定重讀受影響的投影；重讀失敗不撤回「已保存」的事實，只把寫入鎖住直到重讀成功（沿用舊頁 `readFailed`）。

## 命令（attempt）生命週期

```
idle ─送出→ sending ─2xx→ 釋放、通知已保存、重讀
                    ├─已知 4xx→ 釋放、顯示原因、保留草稿
                    └─網路／逾時／5xx／回應格式錯→ held（未確認）
held ─重試→ 以完全相同的 method、path、body、If-Match、Idempotency-Key 再送
```

- attempt 在送出前就凍結 `{method, path, body, ifMatch, key, schema, success}`；key 只在建立 attempt 時產生一次。
- 整個營運中心同時只有一個 attempt。`busyRef` 以同步方式擋連點。held 期間所有寫入按鈕停用，讀取仍可做，但重讀不會清掉 held。
- held 只在得到已知結果時解除：2xx（含同 key 重播）或明確 4xx。409 `idempotency_conflict` 視為已知錯誤並保留原 attempt 的內容供檢視。
- 401／存取過期：attempt 保持 held。同一會員重新登入後，未確認的 attempt 從「每個 client、每位會員」的記憶體登錄恢復（照片狀態 `hosted-store-photo-state.ts:24` 的模式），只能重試原操作；不同會員登入時永不可見。重新整理頁面不恢復（記憶體），離開前以 `beforeunload` 警告。
- 403（權限被撤）：解除 held，停用寫入並說明「目前身分已沒有這項權限」；已保存的事實保留。
- 404：商品／offer／selection 不存在只影響該項；事業不存在才把整個營運中心標為找不到。

## 412 與草稿保留（舊頁沒有，新做）

- 已知 412：釋放 attempt、保留草稿、立刻重讀該項。編輯區顯示「資料剛剛被更新。你的修改還在」，逐欄並列「你的修改」與「目前資料」。
- 使用者二選一：「以最新版本重新套用」＝建立**新的** attempt（新 key、最新版本、body＝仍然有效的草稿欄位）；「放棄我的修改」＝丟棄草稿。不自動合併、不自動重送。
- 商品各分區共用同一商品版本；某分區保存後，其他分區草稿的 `baseVersion` 立刻標為過期，畫面提示「保存前會以最新資料核對」，實際送出仍用原 `baseVersion` 並走 412 流程，不偷偷改版本。
- `PATCH supply-products` 只送使用者改過的欄位；`PATCH supply-terms` 依契約送整組四欄。

## 離開保護

- App 的頁面離開檢查改為接收目的地：`pageLeaveGuard: (nextHash: string | null) => boolean`（`App.tsx:621,664,725,794`；舊的檢查忽略參數即可，不影響其他頁）。登出時傳 `null`。
- 營運中心只註冊一次檢查：目的地仍在同一事業的營運中心內→直接允許（草稿跟著 controller 保留）；離開營運中心或換事業時：有 attempt 在送出或未確認→拒絕並說明「正在確認原操作…／尚未確認原操作的結果…」；有草稿→確認「還有尚未儲存的內容，要離開嗎？」。
- 拒絕時 App 以 `replaceState` 回到原 hash（既有行為）。`beforeunload` 涵蓋草稿、送出中與未確認。

## 清單位置與焦點

- 清單頁（商品、合作店家、審核佇列）在 controller 保存篩選、搜尋文字、排序、捲動位置與最後開啟的項目 ID。從詳情返回時恢復，焦點回到該項目的連結；項目已不存在時焦點回到清單標題。
- 重新整理後只恢復 URL 上的篩選與排序。

## 舊入口相容

- `#stores/<t>/<i>/supply` 的書籤、公會區塊連結、`LegacyLaunchpadPrimary.legacyStorePath`、`MyStoreAction` 的目的地都不改；它們打開的就是新概覽。
- 分享入口 `#stores/supply` 與 `[data-share-entry]` 焦點目標不變。
- 新版關閉＝`HostedSupplyCatalog` 原樣回來，資料與 ID 相同；held attempt 只存在記憶體，切換旗標需重新載入頁面，因此不會有半途換 UI 的命令。

## 反例（需測）

| 反例 | 期望 |
| --- | --- |
| 新增商品送出後網路中斷，重試 | 同一 key、同一 body；只有一件商品（AT-06） |
| held 時切到別頁再回來 | 仍是同一個未確認操作，不能改內容再送 |
| A 帳號未確認時登出、B 登入 | B 看不到 A 的任何資料或 attempt；B 的新寫入不帶 A 的 key（AT-34） |
| 兩人同時改同一商品 | 後者 412，草稿保留並並列最新值，不覆寫前者（AT-07） |
| 讀回失敗 | 「已保存」保留、數字標未更新、寫入暫停到重讀成功（AT-29、37） |
| 在商品詳情有草稿時點側欄的「合作店家」 | 直接換頁；回來草稿仍在 |
| 有草稿時點全站導覽「首頁」 | 確認對話；取消則留在原頁、原 hash |
