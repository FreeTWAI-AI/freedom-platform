# Seller Console（賣家主控台）

賣家在商店分頁裡的私人營運頁（EC-SPEC-01 §7.5、pages.md 的 E 列）。頁框沿用 Supplier Console 的
`modules/agent-commerce/hosted-ui/ConsoleShell.tsx`；本模組只放賣家頁自己的路由、讀取、命令與頁面。

- 開關：`site.commerce_console_enabled`（console、supplier console 與 launchpad 都開，EC-SPEC-10 §2.3）。關閉時
  這些網址回到既有的商店頁，`orders` 維持 v1 預留的 4 段路徑。
- 伺服器決定每一個事實與權限；頁面只顯示 API 回應，項目依 `StoreView.capabilities` 顯示，伺服器仍逐一檢查。
- 第一批頁面：E05 訂單、E09 收款例外、E11 收款設定（`settings/payments`）。出貨、顧客、優惠、發票與報表在之後的里程碑。

`orders/reservations` 保留既有預留頁，`orders/<order_ref>` 與 `payments/<case_ref>` 是本批在既定 slug 下新增的明細子路徑。

## 實作入口

- `route.ts`：不依賴 React 的路由、query 白名單、能力導覽及舊頁 fallback；導覽只用 hash。
- `state/attempt.ts`、`state/controller.ts`：保留原 key/body/version 的不確定寫入、session/store 讀取隔離、離開保護與保存後重讀。
- `ui/SellerConsole.tsx`：共用 ConsoleShell、商店名稱、setup/capability 檢查；舊版預留仍由 HostedSellerOrders 自己檢查。
- `ui/Orders.tsx`：E05 清單/明細，分軸狀態、按需聯絡資料、手動退款紀錄。
- `ui/Exceptions.tsx`：E09 零自行推論的 allowed_actions/resolution_codes。
- `ui/Settings.tsx`：E11 版本、綠界帳戶、一次 fresh auth、write-only 金鑰、驗證付款與服務狀態。
- `ui/SellerConsole.css`：只在 seller-console 範圍重用現有 tokens；不修改共用頁框。

銀行匯款與面交由之後的工作新增；本批付款方式文字取自 API，不能從付款軸推論庫存或訂單狀態。

## 已知 API 邊界

目前 PortalClient 不提供 Retry-After，付款查詢遭拒後先停用本頁查詢，請稍後重開訂單；無法精準依該 header 自動恢復。
PortalClient 也會將 mutating 5xx 轉成無 problem code 的 network error，因此這些回應會維持不確定狀態、使用原 key 重試；
無法在不改共用 client error 協議的前提下顯示特定 503 code。E09 導覽依 finance:read，但現行例外讀取 API 另要求 orders:read；
伺服器的 403 會顯示權限說明。Order DTO 沒有 lifecycle/inventory 最近變更時間，頁面明示讀取時間，不虛構事件時間。
