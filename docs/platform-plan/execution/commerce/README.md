# Freedom Commerce（商店、交易履約與可攜營業版本）

依據：《Freedom Commerce 電商商店、交易履約與可攜營業版本專案計畫 v1.0》與同包的 Supplier Console v1.1 物流補充（2026-10-15，來源檔與雜湊見 [sources.md](sources.md)）。程式基準 `efaf314d`（2026-10-15 讀回時的 `origin/main`）。

本目錄是 C0 階段的規格與工作切分，不是進度系統：實作與驗收結果以 PR、commit 與測試證據為準。EC-R01～60、EC-AT01～72、SC-L01～18、SC-LAT01～24 全部仍是 planned／`not_run`。

## 文件

| 文件 | 內容 |
| --- | --- |
| [WP-00-baseline.md](WP-00-baseline.md) | 最新差異、可沿用的程式、缺口、來源權利、三種資產的關係 |
| [sources.md](sources.md) | 規劃包雜湊、上游固定版本、盤點方法與 Agent 盤點的更正紀錄 |
| [pages.md](pages.md) | B01～B10、E01～E11、SL-01～05 對到操作、API、權限、資料與錯誤 |
| [decisions.md](decisions.md) | DC01～DC12 的建議預設、負責人與只阻擋的範圍 |
| [EC-SPEC-01](EC-SPEC-01-product-visual.md) | 角色、頁面、動線、空／錯誤狀態、手機與可存取性 |
| [EC-SPEC-02](EC-SPEC-02-catalog-storefront-cart.md) | 商品、店面、購物車、server 定價、guest 顧客 |
| [EC-SPEC-03](EC-SPEC-03-order-inventory.md) | 訂單與庫存：新舊 profile、hold → 已付款配置、出貨／退回、不變條件 |
| [EC-SPEC-04](EC-SPEC-04-payment.md) | 收款帳戶、PaymentPort、ECPay AIO、callback／inbox、退款與對帳 |
| [EC-SPEC-05](EC-SPEC-05-fulfilment.md) | 履約責任、配送群組、選店、Shipment、標籤、貨態與退回 |
| [EC-SPEC-06](EC-SPEC-06-invoice-aftersales.md) | 發票、售後（RMA）、退款協作與各方金額責任 |
| [EC-SPEC-07](EC-SPEC-07-operations-skillbooks.md) | 29 項技能的落點、技能書／站內應用／可攜包的關係 |
| [EC-SPEC-08](EC-SPEC-08-portable-migration.md) | 可攜營業版本：模式 H／C／S／X、授權子集、安裝與遷移 |
| [EC-SPEC-09](EC-SPEC-09-security-ci-tests.md) | 安全、隱私、CI 範圍與測試層級 |
| [EC-SPEC-10](EC-SPEC-10-release-operations.md) | 能力開關、writer floor、發布順序、回退與試用 |
| [EC-SPEC-11](EC-SPEC-11-offline-payment.md) | 線下付款：銀行匯款、面交付款與面交取貨，由店家確認收款 |
| [work-plan.md](work-plan.md) | 工作包、依賴、CLI 分工、共用檔案與 Supplier Console 的接點 |

## 分工

- 供應商端頁面（SL-01～05）、供應商用途的讀取投影與路由由 Supplier Console 工作階段負責（`docs/platform-plan/execution/supplier-console/SC-SPEC-07-fulfilment.md`）。
- 訂單／庫存、物流與履約、發票與售後的領域服務、資料表、命令與 provider adapter 由 Commerce 負責（EC-SPEC-03／05／06），完成契約後把 commit SHA 交給 Supplier Console。
- 兩邊共用同一份 tenant／instance、商品、offer、selection、order、hold、Asset 與共同 command，不建第二份權威。

## 界線

- 本計畫與這些文件不授予開 Issue、發送訊息、合併、部署、操作正式客戶資料、啟動 MCP，或呼叫付款、寄件、發票服務的權限。外部動作依實際任務與當時授權進行。
- 既有 v1 預留（30 分鐘、未付款、不出貨）保持原語意；新交易使用新的 order profile，不把 v1 的 literal `false` 改成 `true`。
- 一間店一個明確的零售責任主體，收款用商家自己的核准帳戶；平台不代收、不分帳、不設錢包。
- 金鑰（HashKey／HashIV 等）不進前端、Git、模型上下文、技能書或日誌。
- 供應商只依有效的履約指派取得完成該包裹所需的收件資料；供貨同意不等於代出貨。
- Majordomo 技能與 MCP 是知識與可選工具，不是功能或操作授權；沒有 AI 也能營業。
