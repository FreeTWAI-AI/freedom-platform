# 自由工坊電商買家交易信件與寄送（Buyer Commerce Transactional Email）

本模組實作 Freedom Commerce C2 規格（[EC-SPEC-10 §6](../../../../docs/platform-plan/execution/commerce/EC-SPEC-10-release-operations.md#6-買家通知信m2m4)）：包含五種買家交易信件純文字渲染函式（`templates.ts`）、外發信件佇列（`outbox.ts`）、透過 `commerce_due_work` 執行的分段寄送與保留期清理（`delivery.ts`），以及寄件介面與測試替身（`email-port.ts`）。

## 五種信件與觸發時機

| 範本識別碼 (`template`) | 觸發時機 | 內容重點 | 相關規格 |
| --- | --- | --- | --- |
| `order_confirmed` | 付款確認且套用庫存為 `converted` 或 `allocated` | 訂單已成立、顯示用編號、店名、商品明細（最多 10 行加剩餘項數）、金額總計、一次性查看連結 | [EC-SPEC-10 §6.1](../../../../docs/platform-plan/execution/commerce/EC-SPEC-10-release-operations.md#61-c2-寄出的信)、[EC-SPEC-02 §4.2](../../../../docs/platform-plan/execution/commerce/EC-SPEC-02-catalog-storefront-cart.md#42-訂單存取憑證) |
| `paid_unallocatable` | 付款確認但因缺貨套用為 `unallocatable` | 已付款但庫存不足暫無法出貨、店家將補庫存出貨或取消並退款、後續結果見訂單頁、聯絡方式 | [EC-SPEC-10 §6.1](../../../../docs/platform-plan/execution/commerce/EC-SPEC-10-release-operations.md#61-c2-寄出的信)、[EC-SPEC-03 §5.3](../../../../docs/platform-plan/execution/commerce/EC-SPEC-03-order-inventory.md#53-晚到付款hold-已釋放) |
| `order_access` | 買家於 B10 申請找回訂單且比對相符 | 收到查看連結申請、一次性查看連結、非本人申請請忽略說明 | [EC-SPEC-10 §6.1](../../../../docs/platform-plan/execution/commerce/EC-SPEC-10-release-operations.md#61-c2-寄出的信)、[EC-SPEC-02 §4.2](../../../../docs/platform-plan/execution/commerce/EC-SPEC-02-catalog-storefront-cart.md#42-訂單存取憑證) |
| `shipment_handed_over` | 包裹狀態順序首次達到 ≥ 3（`handed_over` 已交寄，M3） | 包裹已交寄、物流承運商名稱、包裹追蹤碼（若有）、超商取件提醒（若為超商服務）、訂單連結 | [EC-SPEC-10 §6.1](../../../../docs/platform-plan/execution/commerce/EC-SPEC-10-release-operations.md#61-c2-寄出的信)、[EC-SPEC-05 §5.1](../../../../docs/platform-plan/execution/commerce/EC-SPEC-05-fulfilment.md#51-狀態)、[EC-SPEC-05 §5.5](../../../../docs/platform-plan/execution/commerce/EC-SPEC-05-fulfilment.md#55-交寄與庫存) |
| `aftersale_reply` | 店家回覆售後申請或售後狀態變更（M4） | 售後申請有新回覆或進度更新、訂單查看連結（不含任何回覆內文或個資） | [EC-SPEC-10 §6.1](../../../../docs/platform-plan/execution/commerce/EC-SPEC-10-release-operations.md#61-c2-寄出的信)、[EC-SPEC-06 §2.1](../../../../docs/platform-plan/execution/commerce/EC-SPEC-06-invoice-aftersales.md#21-訂單對話b07e07) |

M2 實際入列與寄送前三種範本（`order_confirmed`、`paid_unallocatable`、`order_access`）；`overpaid`、`after_cancel`、`amount_mismatch`、`simulated` 與後續 `retry_allocation` 不寄信。

## 旗標規則與寄送授權（EC-SPEC-10 §2.2、§6.2）

- `FREEDOM_COMMERCE_EMAIL_ENABLED` 預設為 `'false'`（只接受 `'true'` 或 `'false'`）。在 Ted 審核通過並開啟旗標之前，正式環境不寄送任何買家交易信。
- Worker 開啟 `FREEDOM_COMMERCE_EMAIL_ENABLED='true'` 時，必須同時具備 `EMAIL`（`send_email`）binding 與 `COMMERCE_JOURNAL` R2 binding；Node 伺服器不具備這些 binding，開啟時直接拒絕啟動（`commerce_email_requires_worker`）。E2E 測試伺服器使用記憶體 `FixtureEmailSender` 與 `MemoryEffectJournal`。
- 只有在事件發生當下 `emailEnabled` 為 `true` 時，付款確認與 B10 才會寫入 `commerce_outbound_emails` 佇列；旗標為 `false` 時付款不入列、B10 在執行任何 SQL 前直接回 409 `order_access_email_unavailable`。
- 已在旗標開啟期間入列的 `queued` 信件，若旗標暫時關閉會保留在佇列中（執行器在旗標關閉或未安裝寄件器時不領取 `email` 工作），待旗標重新開啟且未逾 `expires_at` 時再寄出；因此首次開啟旗標不會補寄舊訂單信件。
- 訂單頁（B07）在旗標關閉時於所有付款視圖顯示「這間店目前不寄確認信，請用這個瀏覽器回到訂單，或聯絡店家。」；旗標開啟時僅於付款確認前的五種視圖（`ready`、`awaiting`、`checking`、`failed`、`expired`）顯示「付款確認後，訂單成立信會寄到你填寫的 Email。」。B10 在旗標開啟時提供 Email 與訂單編號表單，對 202 與 429 皆顯示相同提示，不洩漏訂單是否存在。

## 內容規則

- 信件內文不含買家姓名、地址、電話或 Email，不含付款資料（卡號、金流商、交易編號）與費用，也不含供應商或出貨者身分。店到店包裹不印追蹤碼：寄件代碼只供寄件使用（EC-SPEC-05 §9.3）。

## 外發佇列（Outbox：`outbox.ts` 與 `commerce_outbound_emails`）

- `commerce_outbound_emails` 只保存參照與狀態（`email_id`、`tenant_id`、`instance_id`、`order_id`、`template`、`application_id` 或 `access_request_id`、`state`、`attempts`、`last_error`、`journaled_at`、`sent_at`、`created_at`、`updated_at`、`expires_at = created_at + 7 days`），不儲存 Email、姓名、連結或權杖。跨租戶執行器需要讀取此表，故在資料目錄列為 RLS 豁免（`commerce_profile_participant_acl`）。
- 資料庫 trigger 強制：新增時只能為 `state = 'queued'`、`attempts = 0` 且無 `journaled_at`/`sent_at`/`last_error`；只有 `queued` 列可更新；身分與時間邊界欄位不可變更；`journaled_at` 最多設定一次；只有已結束狀態（`sent`、`suppressed`、`expired`、`failed`）且 `updated_at <= clock_timestamp() - 45 days` 的列才可刪除。
- `queueCommerceEmail(q, input)` 在呼叫端的交易內以 `INSERT … ON CONFLICT DO NOTHING` 去重（付款範本以 `(application_id, template)` 唯一，B10 以 `(access_request_id)` 唯一），並僅在實際寫入新列時於同一交易呼叫 `scheduleDueWork(q, { kind: 'email', targetId: email_id, dueAt: now })`。
- 付款通知與瀏覽器返回的 `afterResponse` 工作依序執行兩步：(1) 若有到期的 `attemptId` 且已安裝金流傳輸與金鑰環，先對該 `attemptId` 執行 `runDueCommerceWork`（瀏覽器返回可在此步完成查單、套用付款並將信件入列）；(2) 若已啟用信件寄送（`emailEnabled`、`emailSender`、`journal` 與 `origin` 皆齊備）且有 `orderId`，再查詢該訂單最多 10 筆 `state = 'queued'` 的 `email_id`（依 `created_at` 排序）並立即執行 `runDueCommerceWork`，使付款觸發的信件（含瀏覽器先返回或晚到付款）不必等待 10 分鐘排程。

## 寄送流程（Delivery：`delivery.ts`）

`runDueCommerceWork` 在非隔離狀態、`emailEnabled` 為真且安裝了 `emailSender`、`journal` 與明確的 `origin` 時領取 `kind = 'email'` 的到期工作，每筆先以 2 分鐘租約權杖分段執行（不在交易或鎖定期間進行網路呼叫、寫入日誌或寄信）：

1. **Check（短交易，綁定租戶）**：鎖定 `commerce_due_work` 與 `commerce_outbound_emails`。若租約已失效則停止；若狀態非 `queued` 則刪除到期工作並停止；若 `expires_at <= now` 則標記 `expired` 並刪除到期工作；若訂單聯絡人或顧客已遮罩（`redacted_at IS NOT NULL`）則標記 `suppressed` 並刪除到期工作。
2. **Journal（無資料庫交易）**：若 `journaled_at` 為空，先寫入外部效果日誌（`kind: 'email_send'`、`id: email_id`、`occurred_at: created_at`、`detail: { order_id, purpose: template }`，不含任何個資），成功後在獨立短交易寫入 `journaled_at`。若日誌寫入失敗則不寄信，記錄 `last_error = 'journal_unavailable'` 並依退避排程釋放租約。
3. **Prepare（短交易，綁定租戶）**：再次確認租約有效且狀態為 `queued` 並已完成日誌，讀取訂單聯絡 Email、店名與網址代稱、訂單顯示編號與（`order_confirmed` 時）商品明細及總額，在交易內呼叫 `createAccessLink` 產生一次性查看連結權杖，並在提交前最後一步將 `commerce_due_work.lease_until` 延長為 `now + 60 seconds`、回傳新的寄送租約權杖 `sendLeaseToken`。提交交易後於記憶體中以 `renderCommerceEmail` 渲染信件（M2 傳入 `contactEmail: null`）。明文權杖只存在於此步驟至寄出之間的記憶體中；重試寄送會建立新連結。
4. **Send（無資料庫交易）**：呼叫 `sender.send({ to, subject, text, replyTo })`，每次寄送計入執行器的 1 次外部呼叫配額。
5. **Record（短交易）**：
   - 寄送成功時：只要 `commerce_outbound_emails.state` 仍為 `'queued'`，不論租約是否逾時或被其他執行器重取，一律更新為 `state = 'sent'`、`sent_at`、`updated_at`（因信件已實際寄出，避免慢速成功寄送後重試再寄第二封）；僅在 `commerce_due_work` 的權杖仍等於 `sendLeaseToken` 時才刪除該筆到期工作（若已被其他執行器重取，交由該執行器在 Step 1 見到 `sent` 時清理）。
   - 寄送失敗時：仍受 `sendLeaseToken` 與租約未逾時保護；將錯誤映射為固定代碼並只記錄 `{"event":"commerce_email_failed","template":…,"code":…}`（絕不記錄信箱、連結或內文）：
     - 永久錯誤（`E_VALIDATION_ERROR` / `E_TOO_MANY_RECIPIENTS` → `invalid_message`、`E_RECIPIENT_NOT_ALLOWED` → `recipient_not_allowed`、`E_SENDER_NOT_VERIFIED` → `sender_not_verified`）：標記 `state = 'failed'` 並刪除到期工作。
     - 暫時錯誤（`E_RATE_LIMIT_EXCEEDED` → `rate_limited`、其他錯誤 → `send_failed`）：`attempts + 1`，依第 1、5、15、之後每 60 分鐘退避重排 `due_at`（不超過 `expires_at`）並釋放租約。

## 寄件人與 Reply-To

- 固定寄件人：`no-reply@mail.freetwai.com`。
- `replyTo`：若店家設定了公開聯絡 Email，則為該 Email（`store.contactEmail`）；M2 尚未開放店家公開聯絡 Email，固定傳入 `null`，信件頁尾改印店家頁面網址。注意：實際寄件工作負責設定此欄位；目前 Cloudflare Workers 的 `EMAIL` binding 是否支援 `Reply-To` 標頭尚未經正式環境驗證（unverified）。
- 聯絡 Email（`store.contactEmail`）必須僅由可列印 ASCII 字元（U+0021–U+007E）組成，因其會進入 `Reply-To` 標頭。

## 保留期與定期清理（Retention Sweep）

- `sweepCommerceOutboundEmails(pool, { limit = 500, quarantine })` 於 Worker `scheduled()` 的執行器之後執行（不論 `emailEnabled` 開關，但在 `quarantine` 為真時跳過）：
  1. 將已逾 7 天 `expires_at` 的 `queued` 列標記為 `expired`，並刪除對應的 `commerce_due_work` 列（每次最多 500 筆）。
  2. 刪除已處於終態（`sent`、`suppressed`、`expired`、`failed`）且 `updated_at <= clock_timestamp() - interval '45 days'` 的列（每次最多 500 筆）。
  兩階段共用同一批次上限，並依投遞程序的順序先鎖 due-work、再鎖 Email。
  掃除使用 `SKIP LOCKED`，跳過無法取得 due-work 或 Email 鎖的候選，保留其 lease／attempts。
  只刪除本交易已鎖定且對應已處理 Email 的 due-work ID，避免鎖住 Email 後等待新出現的工作列。

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
