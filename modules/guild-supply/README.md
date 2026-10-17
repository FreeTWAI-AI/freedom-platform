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

## 待辦摘要（G-14）

登入會員（`member` 或 `read_only`）在商品庫列表就緒後，區塊內前三筆且供貨資料已就緒
（`setup_state === 'ready'`）的商品庫會各自讀取所屬業務空間的待辦摘要：
`GET /tenants/:tenant_id/storefronts/:instance_id/supplier-console/summary`。

- **以單一商品庫為範圍**：每個商品庫獨立讀取，不跨商品庫或業務空間累加數字，也不顯示公會總計。
- **公會頭銜不授予權限**：公會職稱不增加任何商品庫或待辦存取權，每次讀取皆由伺服器
  依成員目前的租戶身分與 instance 能力驗權。
- **未就緒不讀取**：待設定商品庫（`setup_required`）與訪客（`visitor`）不送出待辦讀取。
  只有站點供應商營運中心啟用（`supplier_console_enabled`）時才讀取；關閉時不送出摘要讀取，也不顯示待辦列。
- **呈現狀態**：
  - 載入中：`正在讀取待辦…`
  - 待辦皆為 0：`目前沒有待辦。`
  - 有待辦：`待辦：待確認售價申請 {n}、供貨版本需重新公開 {n}、缺貨商品 {n}`
  - 缺少商品編輯權限（`store_write_required`）：`需要商品編輯權限才能查看待辦。`
  - 讀取失敗（5xx、網路中斷、解析錯誤，或回傳之租戶／instance ID 不合）：
    `暫時無法讀取待辦。` 加上小型次要按鈕 `重新讀取待辦`（無障礙名稱包含商品庫名稱）。
  - 無權限（401/403）與未啟用（404）：不額外渲染提示（由商品庫按鈕與營運中心說明權限）。
