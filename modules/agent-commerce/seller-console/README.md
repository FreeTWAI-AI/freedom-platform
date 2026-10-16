# Seller Console（賣家主控台）

賣家在商店分頁裡的私人營運頁（EC-SPEC-01 §7.5、pages.md 的 E 列）。頁框沿用 Supplier Console 的
`modules/agent-commerce/hosted-ui/ConsoleShell.tsx`；本模組只放賣家頁自己的路由、讀取、命令與頁面。

- 開關：`site.commerce_console_enabled`（console、supplier console 與 launchpad 都開，EC-SPEC-10 §2.3）。關閉時
  這些網址回到既有的商店頁，`orders` 維持 v1 預留的 4 段路徑。
- 伺服器決定每一個事實與權限；頁面只顯示 API 回應，項目依 `StoreView.capabilities` 顯示，伺服器仍逐一檢查。
- 第一批頁面：E05 訂單、E09 收款例外、E11 收款設定（`settings/payments`）。出貨、顧客、優惠、發票與報表在之後的里程碑。
