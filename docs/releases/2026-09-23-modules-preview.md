# 0.2.0-modules-preview — 會員入口與模組擴建

會員現在從自己的定位與參與角色出發，分開使用供貨中心、開店與銷售、開源作品、行銷工作室及職業公會。原有工作認領／驗收與雙方合作紀錄保留在「我的協作」，商品與開源專案不再需要先繞經一般作品商機。

## 本輪可以操作

- 會員首頁：定位摘要與獨立模組入口；切換／重新整理保留當前頁面。
- 我的定位：私有的背景、專長、目標、每週時間、參與角色與最多三個方向。28 個方向對接 12 個 canonical Guild；本人可修改定位、加入／退出多個公會。
- 供貨中心：商品名稱、照片 HTTPS 連結、規格、供貨價格、自報數量、出貨／退換貨條件；供貨者核對指定選品版本後回覆。
- 開店與銷售：本人商店、共用供貨目錄、零售售價與銷售說明、不可被後續改價覆寫的選品快照、供貨請求與回應。
- 開源作品：真實 public GitHub API 讀取、stable repository ID、exact commit、該版本授權、用途／使用說明、來源刷新與本人編輯。登錄者與作品關係仍為自行聲明。
- 行銷工作室：引用本人開源作品或供貨商品的來源版本，或填活動簡述；保存／修改私人文案與人工分享連結。歷史分享保留當時文案。

## 資料與接線

新增 002–004 migrations；同一 PostgreSQL、會員／session、CSRF、冪等 command receipts、版本檢查、交易、journal 與 outbox。每個模組有自己的寫入服務，行銷使用商品／作品的唯讀資料接點。授權與 community／owner scope 在 API command 執行時再檢查。

staging 切換到独立 `freedom_staging` DB／非 superuser role，沿用 Castle PostgreSQL 持久 volume。先 public-only dump／restore，保留原本工作與合作資料，避免複製開發測試 schemas。切換及回退方式見 [運行手冊](../development/staging-operations.md)。新 module DB 與開發測試分離不代表已遷往 managed cloud。

## 已執行驗證

- `npm run typecheck`、`npm run build`：通過。
- `npm test`：**50 passed，0 failed**。涵蓋權限／社群隔離、版本衝突、競爭請求、idempotency、交易失敗回滾、不可變供貨／作品／行銷來源，以及既有工作流程回歸。
- `npm run test:e2e`：**9 passed**。供貨商與店主切換、確認供貨、定位修改／公會、私人行銷草稿、非法 GitHub URL、手機寬度與舊流程皆經 Chromium 實跑。首輪兩個 selector 問題修正後全過，無新增 skip。
- `npm run test:contracts`：**591 passed，4 skipped**；既有四個 skip 未變，沒有把紅測改成跳過。
- 真實 public GitHub API：讀到 `line/line-bot-sdk-nodejs` repository ID `90831455`、commit `e4e2128ddf259d638ebd066cb0ad2b8704b62faf`、`Apache-2.0`；沒有使用私人 gh token。
- 中央 DB 演練：將舊 public schema 還原到唯一暫存 DB，以 `freedom_staging` role 套用四個 migrations；31 個資料表均為該 role 所有，保留 3 個示範會員，演練 DB 用完刪除。

部署驗證另使用 [HTTPS 腳本](../../scripts/verify-staging.mjs) 經 Cloudflare Access／Tunnel 檢查每個新模組的桌面與手機頁面。其短效 service token／policy 必須在驗證後清除；機器驗證不能代替真人 email／OTP。

## 接續範圍

這是可保存資料的內部模組預覽。正式會員 OAuth、既有定位測驗引擎的逐題遷移、真正 Guild 活動／Officer／XP、商品圖片上傳與 QC、正式商店前台／訂單／結帳／履約、provider sandbox、社群自動發布與 referral attribution、managed cloud 與異地備份，都仍須分批實作。

供貨回覆僅為內部演練；草稿不代表已發文，分享紀錄不代表成效，示範收款不代表銀行核實。沒有對外正式發布、沒有平台代收／代付。

Ted 指定的上游逐一研究後採用其適合的設計與接點；本輪沒有複製上游程式。詳見 [取用決定與來源](../development/research/README.md) 及 [大計畫對齊設計](../development/module-expansion-design.md)。
