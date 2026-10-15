# 自由工坊電商買家交易信件範本（Buyer Commerce Email Templates）

本模組提供 Freedom Commerce C2 規格（[EC-SPEC-10 §6.1](../../../../docs/platform-plan/execution/commerce/EC-SPEC-10-release-operations.md#61-c2-寄出的信)）所定義的五種買家交易信件純文字渲染函式。此處為純函式渲染，不涉及資料庫、排程、發送或外部 I/O。

## 五種信件與觸發時機

| 範本識別碼 (`template`) | 觸發時機 | 內容重點 | 相關規格 |
| --- | --- | --- | --- |
| `order_confirmed` | 付款確認且套用庫存為 `converted` 或 `allocated` | 訂單已成立、顯示用編號、店名、商品明細（最多 10 行加剩餘項數）、金額總計、一次性查看連結 | [EC-SPEC-10 §6.1](../../../../docs/platform-plan/execution/commerce/EC-SPEC-10-release-operations.md#61-c2-寄出的信)、[EC-SPEC-02 §4.2](../../../../docs/platform-plan/execution/commerce/EC-SPEC-02-catalog-storefront-cart.md#42-訂單存取憑證) |
| `paid_unallocatable` | 付款確認但因缺貨套用為 `unallocatable` | 已付款但庫存不足暫無法出貨、店家將補庫存出貨或取消並退款、後續結果見訂單頁、聯絡方式 | [EC-SPEC-10 §6.1](../../../../docs/platform-plan/execution/commerce/EC-SPEC-10-release-operations.md#61-c2-寄出的信)、[EC-SPEC-03 §5.3](../../../../docs/platform-plan/execution/commerce/EC-SPEC-03-order-inventory.md#53-晚到付款hold-已釋放) |
| `order_access` | 買家於 B10 申請找回訂單且比對相符 | 收到查看連結申請、一次性查看連結、非本人申請請忽略說明 | [EC-SPEC-10 §6.1](../../../../docs/platform-plan/execution/commerce/EC-SPEC-10-release-operations.md#61-c2-寄出的信)、[EC-SPEC-02 §4.2](../../../../docs/platform-plan/execution/commerce/EC-SPEC-02-catalog-storefront-cart.md#42-訂單存取憑證) |
| `shipment_handed_over` | 包裹狀態順序首次達到 ≥ 3（`handed_over` 已交寄） | 包裹已交寄、物流承運商名稱、包裹追蹤碼（若有）、超商取件提醒（若為超商服務）、訂單連結 | [EC-SPEC-10 §6.1](../../../../docs/platform-plan/execution/commerce/EC-SPEC-10-release-operations.md#61-c2-寄出的信)、[EC-SPEC-05 §5.1](../../../../docs/platform-plan/execution/commerce/EC-SPEC-05-fulfilment.md#51-狀態)、[EC-SPEC-05 §5.5](../../../../docs/platform-plan/execution/commerce/EC-SPEC-05-fulfilment.md#55-交寄與庫存) |
| `aftersale_reply` | 店家回覆售後申請或售後狀態變更 | 售後申請有新回覆或進度更新、訂單查看連結（不含任何回覆內文或個資） | [EC-SPEC-10 §6.1](../../../../docs/platform-plan/execution/commerce/EC-SPEC-10-release-operations.md#61-c2-寄出的信)、[EC-SPEC-06 §2.1](../../../../docs/platform-plan/execution/commerce/EC-SPEC-06-invoice-aftersales.md#21-訂單對話b07e07) |

## 寄件人與 Reply-To

- 固定寄件人：`no-reply@mail.freetwai.com`。
- `replyTo`：若店家設定了公開聯絡 Email，則為該 Email（`store.contactEmail`）；未提供時為 `null`。
- 聯絡 Email（`store.contactEmail`）必須僅由可列印 ASCII 字元（U+0021–U+007E）組成，因其會進入 `Reply-To` 標頭。
- 注意：實際寄件工作負責設定此欄位；目前 Cloudflare Workers 的 `EMAIL` binding 是否支援 `Reply-To` 標頭尚未經正式環境驗證（unverified）。

## 個資保護與外發記錄（EC-SPEC-10 §6.3）

- 外發信件記錄（如 `commerce_outbound_emails`）不儲存 Email 與任何個資，僅記錄來源參照（checkout、order、request）與範本代碼。
- 寄出當下於 tenant 隔離環境內讀取收件人 Email；若買家聯絡資料已遮罩，則標記為 `suppressed` 且不寄送。
- 信件內文不含買家姓名、地址、電話或 Email，不含付款資料（卡號、金流商、交易編號）與費用，也不含供應商或出貨者身分。店到店包裹不印追蹤碼：寄件代碼只供寄件使用（EC-SPEC-05 §9.3）。

## 寄送授權（EC-SPEC-10 §6.2）

在 Ted 正式審核通過並開啟 `FREEDOM_COMMERCE_EMAIL_ENABLED` 之前：
- 平台不得向買家寄送任何 commerce 信件。
- 結帳完成頁顯示「這間店目前不寄確認信，請用這個瀏覽器回到訂單，或聯絡店家」；B10 顯示同樣的說明，且不收集 Email。

## 範例

以下為測試套件共用合成資料所渲染出的五種信件主旨與本文範例（單元測試會直接解析此區塊進行雙向比對，防止文件與程式漂移）：

### order_confirmed
```text
主旨：自由工坊：「示範店家」訂單 261015-ABCDEF 已成立

你向「示範店家」建立的訂單 261015-ABCDEF 已完成付款，店家將開始為你準備商品。

訂單內容：
・測試商品 × 1
合計：NT$1,234

查看訂單請開啟以下連結：
https://example.test/shops/demo-store/orders/018d0000-0000-7000-8000-000000000001#access=abcdefghijklmnopqrstuvwxyz0123456789-_ABCDE

此連結有效期限為 7 天，只能使用一次；使用後會在此瀏覽器開啟訂單，請勿轉寄給他人。

這封信由自由工坊代「示範店家」僅就此筆訂單發送，不含任何行銷廣告。
店家聯絡 Email：shop@example.test
若你沒有在這間店下單，請忽略這封信。
```

### paid_unallocatable
```text
主旨：自由工坊：「示範店家」訂單 261015-ABCDEF 已付款，等待配貨

你向「示範店家」建立的訂單 261015-ABCDEF 已完成付款。因商品目前庫存不足，暫時無法出貨。

店家將確認庫存狀態，若補足庫存將為你出貨，或取消訂單並由店家辦理退款；後續處理結果將更新於訂單頁面。若有任何疑問，請透過下方的聯絡方式與店家聯繫。

查看訂單請開啟以下連結：
https://example.test/shops/demo-store/orders/018d0000-0000-7000-8000-000000000001#access=abcdefghijklmnopqrstuvwxyz0123456789-_ABCDE

此連結有效期限為 7 天，只能使用一次；使用後會在此瀏覽器開啟訂單，請勿轉寄給他人。

這封信由自由工坊代「示範店家」僅就此筆訂單發送，不含任何行銷廣告。
店家聯絡 Email：shop@example.test
若你沒有在這間店下單，請忽略這封信。
```

### order_access
```text
主旨：自由工坊：「示範店家」訂單 261015-ABCDEF 的查看連結

有人申請了「示範店家」訂單 261015-ABCDEF 的查看連結。

查看訂單請開啟以下連結：
https://example.test/shops/demo-store/orders/018d0000-0000-7000-8000-000000000001#access=abcdefghijklmnopqrstuvwxyz0123456789-_ABCDE

此連結有效期限為 7 天，只能使用一次；使用後會在此瀏覽器開啟訂單，請勿轉寄給他人。

若不是你提出申請，請忽略此信。

這封信由自由工坊代「示範店家」僅就此筆訂單發送，不含任何行銷廣告。
店家聯絡 Email：shop@example.test
```

### shipment_handed_over
```text
主旨：自由工坊：「示範店家」訂單 261015-ABCDEF 有包裹已交寄

你向「示範店家」建立的訂單 261015-ABCDEF 有包裹已交寄。

物流方式：黑貓宅急便
包裹追蹤碼：TCAT-12345678

查看訂單請開啟以下連結：
https://example.test/shops/demo-store/orders/018d0000-0000-7000-8000-000000000001#access=abcdefghijklmnopqrstuvwxyz0123456789-_ABCDE

此連結有效期限為 7 天，只能使用一次；使用後會在此瀏覽器開啟訂單，請勿轉寄給他人。

這封信由自由工坊代「示範店家」僅就此筆訂單發送，不含任何行銷廣告。
店家聯絡 Email：shop@example.test
若你沒有在這間店下單，請忽略這封信。
```

### aftersale_reply
```text
主旨：自由工坊：「示範店家」訂單 261015-ABCDEF 有新回覆

你向「示範店家」建立的訂單 261015-ABCDEF 的售後申請有新回覆或進度更新。

查看訂單請開啟以下連結：
https://example.test/shops/demo-store/orders/018d0000-0000-7000-8000-000000000001#access=abcdefghijklmnopqrstuvwxyz0123456789-_ABCDE

此連結有效期限為 7 天，只能使用一次；使用後會在此瀏覽器開啟訂單，請勿轉寄給他人。

這封信由自由工坊代「示範店家」僅就此筆訂單發送，不含任何行銷廣告。
店家聯絡 Email：shop@example.test
若你沒有在這間店下單，請忽略這封信。
```
