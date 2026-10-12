# 供貨公會區塊

[共同開發入口](../../packages/guild-presentation/README.md)包含預覽與 PR 流程。
本模組只呈現目前 API 授權可讀的商品庫，不保存另一份商品、庫存或同意資料。
`CatalogBlock.tsx` 使用既有 `/me/supply-catalogs?pagination=cursor`，最多顯示三筆，
有下一頁時返回完整商品庫列表。商品庫名稱導向原本供貨管理頁。

「開始供貨設定」須由殼層提供既有應用 launcher 與可啟動狀態；不從區塊自行建立
tenant、instance 或授權。唯讀身分不顯示建立動作，實際編輯仍由領域 API 驗權。
不把預留、付款、配送或佣金完成狀態從公會身分推定出來。

日常修改限自己的元件與 `CatalogBlock.spec.ts`。在根目錄執行
`npm run guild:preview`，以及 `npm run guild:test -- modules/guild-supply`。
空庫、訪客、403、404、暫時錯誤與三種外觀都有合成情境。
