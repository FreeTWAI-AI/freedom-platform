# EC-SPEC-06 發票、售後與金額責任：售後申請、退款分攤、綠界 B2C 電子發票、賣方揭露、供應商帳

需求：EC-R19、R22、R23、R25、R26、R38、R39；EC-R57 的報表內容（主責 EC-SPEC-07／09）；Supplier v1.1 的 SC-L12、SC-L13。驗收：EC-AT22～24、45～47；SC-LAT17～19（SL-05 頁面部分見 SC-SPEC-07）。

本文件是 C2 售後、發票與各方金額的設計，基準 `efaf314d`。綠界電子發票的協定事實取自官方開發者文件，官方 AES 與 MD5 範例向量已在本機重算（方法見 [sources.md](sources.md)）；`[頁碼]` 是 `https://developers.ecpay.com.tw/<頁碼>/`，`[support 頁碼]` 是 `https://support.ecpay.com.tw/<頁碼>/`。標「提議」的表、路由與函式尚未存在。本設計不呼叫任何發票服務；連線 stage 或正式環境都要 Ted 另外授權（§10）。

是否開票、何時開票、採用哪種更正，屬於各商家的稅務判斷（DC06）。本文件提供機制與建議預設，不是稅務或法律意見。

## 1. 責任與範圍

### 1.1 三本帳分開

| 帳 | 誰對誰 | 權威 | 本文件 |
| --- | --- | --- | --- |
| 零售收款與退款 | 買家 → 零售商（零售商自己的收款帳戶） | EC-SPEC-04 的 attempt 與 refund | §2.5：退款怎麼連到行項與運費 |
| 零售發票 | 零售商 → 買家 | 零售商自己的發票服務；或商家宣告不開立、站外開立 | §3 |
| 供貨與代出貨費用 | 零售商 ↔ 供應商 | 新的應付帳本（只記錄、不動錢） | §5 |

三本帳可以互相核對，但不互相代替：退款完成不代表發票已更正，折讓不代表已退款，買家退款也不會自動抵銷零售商欠供應商的供貨款（計畫 §12.2、EC-AT24、SC-LAT18）。

### 1.2 誰能做什麼

| 角色 | 可以 | 不可以 |
| --- | --- | --- |
| 零售商（有權成員） | 核准或拒絕售後、決定退款金額、開立與更正發票、核對並登錄付給供應商的款項 | 修改供應商已接受的條件；替供應商確認「已收到款項」 |
| 出貨者／供應商 | 收退回包裹、檢驗、回庫（EC-SPEC-05 §8.3）；開立對帳單、確認收款、提出費用調整 | 退款、零售發票、售後決定、與買家對話（SC-LAT17）；看到零售價、買家付款與發票資料 |
| 買家 | 申請取消、退貨或退款；填寄回單號；在訂單頁與店家對話 | 把任何一條軸線自行標成完成 |
| 平台 | 驗證、保存、計算建議、執行 outbox | 代收、代付、錢包；替商家做稅務或法律判斷 |

## 2. 售後：對話、申請、退款分攤

### 2.1 訂單對話（B07、E07）

- 每張 `hosted_checkout` 訂單最多一個對話串（提議 `commerce_support_threads`，第一則留言時建立）；訊息只能新增（提議 `commerce_support_messages`：作者種類 `buyer`／`store`／`system`、內文 ≤ 2,000 字、時間）。
- 買家以訂單存取憑證或會員本人讀寫（EC-SPEC-02 §4）。店內有 `store:customers:read` 的成員可讀；回覆另需 `store:orders:manage`（EC-SPEC-09 §2.2）。出貨者與供應商看不到。
- 訊息是個資：tenant RLS（零售商），不進 journal、outbox、日誌與分析；保存期限見 EC-SPEC-09 §3。C2 不收附件：asset 的擁有者必須是會員，guest 無法上傳；私有附件用途 `commerce.evidence` 在 C4 加入（WP-00 §7）。
- 售後申請、決定、寄回、檢驗、退款與發票更正的狀態變化，以 `system` 訊息寫進同一串，買家在一個地方看到全部進度。
- 有新回覆時訂單頁顯示未讀。寄 Email 給買家需要寄送授權（EC-SPEC-10 §6.2）；未授權前不寄。
- 購買前的詢問用店家公開的聯絡方式（§4.1），C2 不提供沒有訂單的對話。

### 2.2 售後申請（RMA）

提議 `commerce_aftersales_requests`＋`commerce_aftersales_request_lines`：

| 種類 | 何時 | 實物 | 錢 |
| --- | --- | --- | --- |
| `cancel` | 已付款、該行項尚未交寄 | 釋出尚未交寄的配置（若有；`paid_unallocatable` 沒有配置，EC-SPEC-03 §3.3），不出貨 | 退款 |
| `return` | 已交寄 | 寄回出貨者、檢驗、回庫（EC-SPEC-05 §8） | 全部或部分退款 |
| `refund_only` | 已交寄，不需要寄回（毀損、缺件、未收到、遺失、價差） | 不動 | 全部或部分退款 |

- 欄位：`request_id`、零售商 tenant／instance、`order_id`、種類、開啟者（`buyer`／`store`／`system`）、原因（`changed_mind`、`wrong_item`、`damaged`、`missing_parts`、`not_as_described`、`not_received`、`uncollected`、`lost`、`other`）、適用的 `returns` 政策版本（下單時同意的版本，§4.3）、決定（`pending → approved／rejected／withdrawn`）、決定者與時間、給買家看的決定說明、核准時凍結的退款計畫（§2.5）、`return_due_at`（`return` 的寄回期限）、`version`。買家的說明文字寫在對話串（§2.1），不放在申請列。
- 行項：訂單行項、申請數量、核准數量（≤ 申請數量）。
- 買家可申請的範圍：`cancel` 限尚未交寄的配置；`return` 與 `refund_only` 限 `returns.window_days` 之內，從該包裹的送達事件起算（沒有送達事件時，以交寄時間加 7 天起算，對買家較寬）。超過期間時買家仍可在對話串聯絡店家，由店家開啟申請（開啟者 `store`）。
- 同一行項同時最多在一張 `pending` 申請裡；各申請的數量合計不超過可申請量（`cancel`：未交寄量；`return`：已交寄量－已退回量）。
- 買家建立申請帶 `Idempotency-Key`，重送回同一筆。

### 2.3 進度不是一個欄位

決定之後的進度由三條軸組成，各有權威；申請列只記決定：

| 軸 | 權威 | 完成 |
| --- | --- | --- |
| 實物 | `return`：ReturnInspection（EC-SPEC-05 §8.3）；`cancel`：配置釋出 | `return` 到 `inspected`；`cancel` 在核准時完成；`refund_only` 不適用 |
| 錢 | refund（EC-SPEC-04 §7）與行項分攤（§2.5） | 計畫內的退款全部 `confirmed`／`recorded`，或店家記錄「不退款」的決定與原因 |
| 發票 | 更正（§3.7） | 每筆退款對應的更正完成；訂單沒有發票時不適用 |

- `closed_at` 只由領域函式在所有適用的軸都完成時寫入；店家不能一鍵結案（SC-LAT18）。任何一軸卡住（退款失敗或結果不明、更正失敗）時，申請保持未結，售後清單標出卡住的軸；退款的處理見 EC-SPEC-04 §7.3～7.4，更正見 §3.7。
- 買家與賣家看到的文字（EC-SPEC-01 §6.3）：申請中（`pending`）／未同意（原因）／已撤回／已同意，請寄回（附地址與期限）／已收到退貨，檢驗中（`received`）／退款處理中／已完成。錢與發票的狀態另外各自顯示。

### 2.4 核准時做什麼（同一個 DB 交易）

- `cancel`：每個核准行項走 EC-SPEC-03 的「cancel paid」（未交寄的配置釋出）與 EC-SPEC-05 §4.5（整張履約單都取消時 `cancelled`）。行項所在的包裹還沒交寄時，同時作廢那些包裹（EC-SPEC-05 §5.6；已建單的包裹依同意可能產生 `cancelled_parcel_fee`，§5.3），核准前畫面列出會被作廢的包裹，包裹裡沒有取消的行項回到待出貨。行項已交寄（交寄與核准都先鎖訂單，先提交者勝）→ 這一行核准失敗並提示「改為退貨」，其他行項不受影響。依計畫建立退款。
- `return`：依每個行項的出貨者，各建立一張 ReturnInspection（`awaiting_receipt`，來源＝本申請，退回地址取該出貨者當時的版本，EC-SPEC-05 §2.1）。買家此時才看到退回地址與 `return_due_at`（預設核准後 `returns.return_by_days`＝14 天）。原因 `uncollected` 的申請不另建檢驗、不顯示退回地址，直接連到未取退回時自動建立的那一筆（EC-SPEC-05 §8.1）。退款在檢驗定案後才建立（§2.5）。
- `refund_only`：依計畫建立退款。
- 建立退款時：核准者有 `store:refund` 就直接 `approved`，否則留在 `requested` 等有權的人（EC-SPEC-04 §7.2）。退款對應付了這張訂單的 attempt。
- `return` 的檢驗定案（`inspected`）後，系統依收到的數量重算計畫，建立 `requested` 的退款給店家確認；店家可以依政策調低並附原因（§2.5）。退款完成不會自動回庫，回庫也不代表已退款（EC-SPEC-05 §8.3）。

### 2.5 退款金額怎麼連到行項與運費

金額都是整數最小單位，來源都是結帳凍結的 terms（EC-SPEC-02 §3、EC-SPEC-05 §3.4），而且都是 terms 結算單位 u 的倍數（`settlement_unit_minor`：TWD＝100，也就是整數元；USD＝1）。綠界退刷與折讓只收整數元（EC-SPEC-04 §2），所以下面每個上限、建議值與調整都以 u 為單位：

- 行項淨額 L＝單價 × 數量 Q－該行的折扣分攤（L 是 u 的倍數）。
- 退 k 件、之前已退 p 件時，這次的上限＝min(net(p＋k)－net(p), L－這一行已退的金額)，其中 net(j)＝u × ⌊(L ÷ u) × j ÷ Q⌋。一件一件退或一次退完，合計都剛好是 L，不會因為四捨五入多退或少退；先退過價差時，第二項讓合計仍不超過 L。例：L＝290 元、Q＝3，一件一件退依序是 96、97、97 元。p 與「已退的金額」只算未失敗的退款。
- 只退價差（`refund_only`，k＝0）時上限＝L－這一行已退的金額；`cancel` 與 `return` 的 k 至少 1。
- 運費：每個配送群組的運費 F，剩餘＝F－該群組未失敗退款已退的運費。只有這次申請涉及的群組才有運費列。算上這次申請，群組內每一行項的每一件都已在交寄前取消（`cancel`，不論原因），或因店家或出貨方原因（`wrong_item`、`damaged`、`missing_parts`、`not_as_described`、`not_received`、`lost`）退款時，建議退剩餘的運費；其他情況建議 0。只退價差不算件數。店家可在 0 到剩餘之間以 u 為單位調整，不需附原因。
- 店家可以把任何一行調低（例如商品有使用痕跡），要附買家看得到的原因（≤ 500 字）；不能高於上限，調整後仍是 u 的倍數。退款總額必須大於 0，也不能超過那筆 attempt 尚未退的金額（EC-SPEC-04 §7.2）；決定不退款時記錄「不退款」的決定與原因（§2.3），不建立退款。調低的依據是店家已發布的退貨政策；平台不判斷是否合法，也不預設任何扣款，同意勾選不代表放棄法定權利（計畫 §12.3）。
- 提議 `commerce_refund_lines`（隨 EC-SPEC-04 的 M2 建立）：`refund_id`、種類 `item`／`shipping`／`unapplied`、訂單行項或配送群組、數量（`item`；只退價差時為 0）、金額。trigger：各列金額是 u 的倍數、合計＝退款金額；同一行項所有未失敗退款的金額 ≤ L、數量 ≤ Q；同一群組的運費 ≤ F。`unapplied` 只用於沒有套用到訂單的付款（`overpaid`、`paid_after_cancel`、`amount_mismatch`，EC-SPEC-04 §7.2），只能退那筆套用紀錄的金額裡還沒退的部分，不影響發票。M2 建表時只允許 `unapplied`；`item`、`shipping` 與上面的 trigger 隨 M4 加入。
- 並行：退款建立時鎖訂單（鎖序見 §9），同一訂單的兩個退款依序檢查上限（EC-AT22）。

### 2.6 從例外開啟

| 例外（EC-SPEC-05 §7.2、EC-SPEC-03 §5.3） | 售後 |
| --- | --- |
| `uncollected` | 店家開啟 `return`（原因 `uncollected`），連到已自動建立的 ReturnInspection（§2.4）；退款依 `shipping` 政策 |
| `lost` | 店家開啟 `refund_only`（`lost`） |
| `damaged`、`partial_missing` | 買家申請 `return` 或 `refund_only`，或店家代為開啟 |
| `carrier_attention`（EC-SPEC-05 §7.2），包裹退回或寄不出去 | 退回時店家開啟 `return`（原因 `other`），連到已自動建立的 ReturnInspection；寄不出去且店家決定不重新寄出時開啟 `cancel` |
| `fulfiller_unable`、`fulfiller_unresponsive`，店家決定取消 | 店家開啟 `cancel` |
| `paid_unallocatable`，店家決定不補貨 | 店家開啟 `cancel` |

### 2.7 權限

- 建立：買家用訂單憑證或會員本人；店家開啟需要 `store:orders:manage`。
- 決定：`store:orders:manage`；退款核准另需 `store:refund`（EC-SPEC-04 §7.2）。
- 供應商的成員在零售商的 instance 沒有任何能力；售後、退款、發票路由都以零售商的 tenant scope 檢查，供應商呼叫一律拒絕且沒有副作用（SC-LAT17）。
- 買家撤回與店家核准同時發生：以 `version` 判定，後到的一方得到 409 與目前狀態。

## 3. 發票（InvoicePort、綠界 B2C 電子發票）

### 3.1 商家設定（DC06）

提議 `commerce_invoice_settings`（每店一份目前設定，每次修改產生不可改的版本）：

| 欄位 | 值 |
| --- | --- |
| `mode` | `ecpay_b2c`：用商家自己的綠界電子發票服務（§3.4）。`manual_record`：商家在站外開立，平台只記號碼與更正。`not_issued`：商家宣告本店不開立統一發票，並寫明說明（≤ 200 字，顯示給買家） |
| `buyer_types` | 買家可選的類型（§3.3）；`ecpay_b2c` 與 `manual_record` 至少一種 |
| `item_word` | 品項單位，預設「件」 |
| `correction_preference` | 部分退款時建議 `allowance`（預設）或 `void_and_reissue_within_period`（§3.7） |
| `auto_apply_correction` | 退款確認後是否自動執行建議的更正；預設否，商家逐筆確認 |
| `allowance_method` | `online`（預設，買家以 Email 同意）或 `paper`（商家自行取得簽名） |

- C2 限制：幣別 TWD；全部品項應稅（`TaxType=1`、`InvType=07`），價格含稅（`vat=1`）[7896]。零稅率、免稅、混合與特種稅額在 C4：2026-01-01 起零稅率必須填 `ZeroTaxRateReason` [49890]，需要逐品項的稅別資料。販售免稅或零稅率商品的店，C2 只能選 `manual_record` 或 `not_issued`。
- 結帳凍結設定版本（terms 的 `invoice_settings_version_id`）；之後修改設定不影響既有訂單。
- 開放結帳（EC-SPEC-02 §2.3 第 4 項）：`ecpay_b2c` 需要 `active` 的發票服務（§3.10）；`manual_record` 與 `not_issued` 需要店主確認宣告（記錄確認者與時間）。

### 3.2 InvoicePort

介面名稱可與 PaymentPort 收斂；每個方法是一次對外呼叫，只能由 outbox 在交易提交之後執行：

| 方法 | 結果 |
| --- | --- |
| `issue(document)` | `issued{invoice_no, invoice_date, random_number}`／`rejected{code}`／`unknown` |
| `query(relate_number 或 invoice_no＋date)` | `found{狀態、上傳狀態、剩餘可折讓金額}`／`not_found`／`unknown` |
| `void(invoice, reason)` | `voided`／`rejected`／`unknown` |
| `voidWithReissue(invoice, content, reason)` | `reissued`／`rejected`／`unknown` |
| `allowance(invoice, items, method)` | `effective`／`pending_buyer{expires_at}`／`rejected`／`unknown` |
| `cancelPendingAllowance`、`voidAllowance` | `done`／`rejected`／`unknown` |
| `queryAllowances(invoice)` | 已生效的折讓清單（待同意的不會列出 [7928]） |
| `checkBuyerData(type, value)` | `valid`／`invalid`／`indeterminate`（輔助，§3.3） |

協定層（§9）每次呼叫回傳四種結果：`ok`；`rejected`（`RtnCode≠1`，綠界處理後拒絕）；`not_accepted`（`TransCode≠1`，綠界沒有收下請求）；`unknown`（回應解不開、特店代號不符、必要欄位缺漏或與請求不符）。`not_accepted` 的開立可用同一個 `RelateNumber` 重送（號碼唯一，不會開出第二張）；折讓沒有冪等鍵，先以 `GetAllowanceList` 查詢再決定。HTTP 200 以外沒有可信的回應內容：403 是呼叫太頻繁，暫停 30 分鐘 [7854]；其他狀態與 `unknown` 一樣先查詢（§3.6）。

`manual_record` 模式走同一組領域命令，「執行」改成商家輸入結果與證據。

### 3.3 買家發票資料（結帳，EC-AT45）

| 類型 | 買家填 | 送給綠界 [7896][53662] | 本地檢查 |
| --- | --- | --- | --- |
| `member_carrier` 會員載具 | 不用填（用聯絡 Email） | `CarrierType=1`、`CarrierNum=""`、`Print=0`、`Donation=0` | — |
| `mobile_barcode` 手機條碼 | 條碼 | `CarrierType=3`、`CarrierNum`、`Print=0`、`Donation=0` | `^/[0-9A-Z+\-.]{7}$`（半形） |
| `citizen_cert` 自然人憑證 | 憑證號碼 | `CarrierType=2`、`CarrierNum`、`Print=0`、`Donation=0` | `^[A-Z]{2}[0-9]{14}$` |
| `donation` 捐贈 | 捐贈碼 | `Donation=1`、`LoveCode`、`CarrierType=""`、`Print=0`；不得有統編 | `^[0-9]{3,7}$` |
| `company` 公司 | 統編、抬頭；可選手機條碼 | `CustomerIdentifier`、`CustomerName`＝抬頭；有條碼用 `CarrierType=3`，沒有用 `CarrierType=1`；`Print=0`、`Donation=0` | 8 位數字＋財政部檢查碼（依財政部現行公告實作，附來源與測試，WP-06） |

- 每一種都送 `CustomerEmail`（聯絡 Email；會員載具與綠界的開立通知需要；綠界限 80 字元、只能一個信箱 [7896]）。`CustomerID`、`CustomerAddr`、`CustomerPhone` 送空字串（官方範例每個欄位都帶；`CustomerAddr` 只在 `Print=1` 時必填，`CustomerPhone` 只在沒有 Email 時必填 [7896]）。`CustomerName` 只在 `company` 填抬頭，其他類型送空字串。
- 紙本（`Print=1`，商家自行列印或買家到 KIOSK [7896]）與悠遊卡、一卡通載具（`CarrierType=4／5` 需要卡片隱碼 [53662]）在 C4。
- 伺服器拒絕混填（例如捐贈又帶統編），回欄位錯誤，不默默丟掉欄位；前端切換類型時清空不適用的欄位（EC-SPEC-01 §7.3）。
- 輔助查詢：結帳頁在欄位離開時呼叫 `POST …/invoice-checks`（§8.1），伺服器用商家的發票金鑰呼叫 `CheckBarcode` [7886]、`CheckLoveCode` [7891]、`GetCompanyNameByTaxID` [32089]。限流每個 checkout 每分鐘 10 次、每店每分鐘 30 次；超過上限或發票服務暫停（`throttled_until`）時只做本地格式檢查，回 `check_unavailable`，不擋結帳（EC-SPEC-09 §4）。結果以值的雜湊為鍵快取 24 小時，不存原值。
  - 條碼與捐贈碼的查詢官方定位為輔助，不阻擋開立 [7886][62004]。
  - 統編查詢：`1`、`7`（查無登記但檢查碼正確）、`9000001`（財政部系統異常）繼續；`1200125`（檢查碼錯）、`2027000`（格式錯）停止，在欄位提示 [32089]。
  - 逾時（3 秒）或綠界維護：不阻擋，只提示「目前無法即時確認」。查回的公司名稱只當抬頭建議，買家可改。
- 這些值存在 `commerce_checkout_contacts`（個資表，EC-SPEC-03 §3.1），terms 只存類型；不進分析、journal、outbox payload 與日誌（outbox 只存聯絡資料列的 ID，送出時才讀）。
- sandbox：綠界 stage 可能真的寄出測試通知 [7896]，所以 sandbox 訂單送出的 `CustomerEmail` 一律換成部署設定的測試信箱，不送買家的真實 Email；折讓的 `NotifyMail` 同樣處理。

### 3.4 開立

- 時點：付款 `confirmed`（EC-SPEC-04 §5.5，伺服器查詢確認）之後，在套用付款的同一個交易內建立發票文件與 `issue` operation。瀏覽器返回、未經查詢確認的通知、模擬付款都不開立（EC-AT19）。延遲開立（`DelayIssue` [15369]）不在 C2。
- 金額：訂單凍結的應付總額（商品淨額＋運費），等於套用的付款金額。之後的取消與退款一律走更正（§3.7），不在開立前改金額。沒有套用到訂單的付款（溢付、取消後才付）不開票。
- 提議 `commerce_invoice_documents`：`invoice_id`、零售商 tenant／instance、`order_id`、`mode`、`account_id`（發票服務所屬帳戶）與 `environment`、`relate_number`、品項（提議 `commerce_invoice_lines`）、`sales_amount`、買家資料（指向聯絡資料列）、狀態、綠界回傳的 `InvoiceNo`／`InvoiceDate`／`RandomNumber`、上傳狀態（查詢取得）、`replaces_invoice_id`（作廢重開與註銷重開指向原票）、`version`。
- `RelateNumber`＝`I`＋19 個 Crockford Base32 大寫字元：20 字、只有英數，自然符合「不分大小寫唯一」[7896]，也在較舊的「新增載具」版頁面的 30 字上限內 [53662]。前綴 `I` 與付款（`F`）、物流（`L`）的交易編號分開。在帳戶內唯一，作廢後也不重用 [7896]。一份文件一個號碼；重送同一份文件用同一個號碼。
- 狀態：`queued → issuing → issued`；綠界明確拒絕（`TransCode=1` 但 `RtnCode≠1`）→ `failed`；逾時、連線中斷、回應無法驗證 → `unknown`（§3.6）；`issued → voided`。折讓各自一列（§3.7），不改發票的狀態。
- 成功＝`TransCode=1` 且解密後 `RtnCode=1` [7896]。`TransCode≠1`（信封、時間戳記或解密未受理）以同一份文件退避重送；連續 5 次後暫停這個帳戶的發票送出，改顯示下面的店層級提示（多半是金鑰或設定問題）。`Timestamp` 每次送出時重產（10 分鐘有效 [7896]）。`RtnCode` 可能是數字 1 或字串 "1"，兩者都接受。HTTP 403 表示呼叫太頻繁，這個帳戶的所有發票呼叫暫停 30 分鐘 [7854]。HTTP 500 依官方說明多半是格式、金鑰或加密錯誤 [7854]，但無法排除已經開立，所以開立時照「結果不明」處理（§3.6）。
- `failed` 之後要重開：修正資料後建立新文件（新的 `RelateNumber`），以當下尚未退款的金額開立；舊文件留作紀錄。
- 發票服務暫停或金鑰失效：文件留在 `queued`；賣家後台概覽與發票頁顯示「發票服務無法使用，{N} 張待開立」與修正入口。這是店層級的提示，不逐張訂單開例外；修正後依建立順序續開。付款與訂單狀態不受影響（計畫 §12.1）。
- 字軌：開通時以唯讀查詢確認商家已在綠界設定可用的字軌與剩餘號碼（§3.10）；沒有時指引商家到綠界設定（後台或 `AddInvoiceWordSetting` [7870]），平台在 C2 不代設字軌。開立被拒且代碼是 `5070350` 或 `1500047`（字軌未設定、停用或用完 [7954]）時視同設定問題：暫停這個帳戶的送出並顯示店層級提示，不逐張重試。
- `manual_record`：文件 `queued` 時在賣家頁顯示「請在站外開立後填寫」；商家填號碼與日期 → `recorded`。平台不驗證真偽，畫面標示「商家自行登錄」。
- `not_issued`：不建立文件；訂單的發票軸顯示商家的說明。

### 3.5 品項與金額

- 每個訂單行項變成 1～2 個品項，以整數元計算（綠界 profile 保證 L 是整數元，EC-SPEC-04 §2）：淨額 n＝L ÷ 100 元、數量 Q，`base＝⌊n ÷ Q⌋`、`r＝n－base × Q`。`r＝0` 時一項（Q 件 × base 元）；否則兩項（Q－r 件 × base 元，r 件 × (base＋1) 元）。折扣讓每件不到 1 元（`base＝0`）時改成一項「{商品名}（共Q件）」1 × n 元，不送 0 元品項。單價與小計都是整數元，`ItemAmount＝ItemPrice × ItemCount`，合計剛好等於 L，不需要小數單價或負數折扣列（綠界允許小數單價 [7896]，這個 profile 用不到）。例：L＝290 元、Q＝3 → 1 件 × 96 元、2 件 × 97 元。
- 運費：每個配送群組一項「運費」（1 × F）；F＝0 不列。
- `ItemName`：商品名＋選項，最多 100 字，超過以「…」截斷；開立與折讓用同一個名稱。目前的開立、折讓與註銷重開頁寫 String(500) [7896][49890][7901][7918]，較舊的「新增載具」版開立頁寫 String(100) [53662]，取較小的 100。官方沒有寫長度以字元還是位元組計算，也沒有寫能不能用 emoji，都在 stage 確認（§10）。`ItemWord` 用設定值（最多 6 字 [7896]）。
- `SalesAmount`＝各品項 `ItemAmount` 的合計（整數元、> 0）[7896]。不送 `TaxAmount`，由綠界計算（自行送時與綠界計算的差距不得超過 1 元 [7896]）。
- `InvoiceRemark`：「訂單 {顯示用編號}」，方便買家對照，不含個資。
- 購物車最多 50 行（EC-SPEC-02 §5.2），每行最多 2 個品項，加上每個配送群組一項運費（最多 50 項），合計最多 150 項，少於註銷重開的 200 項上限 [7918]（開立上限 999 [7896]）。
- 純函式在 `modules/agent-commerce/invoices/rules/`（WP-06）：`splitUnits`、`invoiceItems`、`allowanceItems`、`toEcpayItems`、`ntdFromMinor`。

### 3.6 結果不明（EC-AT46）

- `unknown` → 以 `RelateNumber` 呼叫 `GetIssue` [7923]：1、5、15、60 分鐘，之後每 6 小時，直到 24 小時。
- 查到 → `issued`，記下號碼、日期與隨機碼。這就是同一張票，不會再開。
- `GetIssue` 回 `RtnCode≠1`（包括查無資料；實際代碼在 stage 確認）當作「查無」；`TransCode≠1` 或 HTTP 錯誤當作這一輪查詢失敗。兩者都照排程繼續查，不因此判定開立失敗。
- 查無 → 繼續查。60 分鐘後仍查無，可用**同一個** `RelateNumber` 重送：這個號碼在綠界必須唯一 [7896]，若第一次其實已經開成，重送會被拒絕，不會產生第二張；重送被拒時立即再查詢。
- 綠界對重複 `RelateNumber` 的實際回應（錯誤碼與訊息）在 stage 驗證前未知（§10）。驗證之前 live 不自動重送：24 小時仍未定 → 例外 `invoice_issue_unknown`，請商家到綠界後台核對後附證據結案。
- 付款事實不變：不重新扣款、不改訂單與付款狀態（EC-AT46、計畫 §12.1）。

### 3.7 更正：作廢、折讓、重開（EC-AT47）

官方規則：

- 發票以兩個月為一期。上一期的發票、折讓只能在**單月 13 日 23:59:59（台灣時間）**以前作廢或註銷重開，例如 1～2 月的票在 3 月 13 日以前 [7906][7911][7918][support 6897]。
- 已有折讓的發票不能作廢或註銷重開，要先作廢全部折讓 [7906][7918]；已註銷重開過的票不能再以 API 作廢 [7906]。
- 折讓沒有期限 [support 6897]，但原票必須已上傳財政部（正式環境約開立後 1～2 小時；stage 立即顯示已上傳 [7849]）；累計折讓不超過原票的剩餘可折讓金額 [7901]。「一張票最多 50 張折讓」與「捐贈的票不能折讓」在目前讀過的官方頁面找不到出處；平台先保守照做，並在 stage 或向綠界確認（§10）。
- 紙本折讓（`Allowance`）呼叫成功即成立，但商家要印兩份請買受人簽名或蓋章留存 [7901]。線上折讓（`AllowanceByCollegiate`）寄同意連結到 Email，72 小時內買家同意才成立，買家點擊前可以取消，取消用 `AllowanceInvalidByCollegiate` [15391][7913][support 8519]。待同意期間平台不對同一張票開新的折讓（平台規則，避免剩餘金額不明）。兩種折讓都送 `AllowanceNotify=E`（線上折讓固定是 E），`NotifyMail`＝聯絡 Email；`CustomerName` 只在 `company` 送抬頭。綠界在隔天把折讓上傳財政部 [7901][15391]。
- 註銷重開（`VoidWithReIssue`）保留原發票號碼、日期與 `RelateNumber` [7918][support 6897]。綠界後台的 B2C 註銷重開要求原票「已上傳且未超過48小時」[support 6906]；API 頁沒有寫這個條件，平台先照同樣的限制（已上傳、開立後 48 小時內，比照作廢期限另留 2 小時緩衝，即 46 小時），並在 stage 確認 API 是否同樣限制（§10）。
- 原因欄位：作廢、作廢折讓、取消線上折讓與註銷重開的原因最多 20 字 [7906][7911][7913][7918]，紙本折讓最多 50 字 [7901]。平台只送固定的中文原因（例如「訂單取消」「退貨退款」「買受人資料更正」），不放買家或商家的自由文字。

更正（提議 `commerce_invoice_corrections`；折讓另存 `commerce_invoice_allowances`＋行項）：

| 種類 | 用於 | 條件 |
| --- | --- | --- |
| `void` | 全額退款 | 作廢期限前（另留 2 小時緩衝）、沒有未作廢的折讓、沒有註銷重開過 |
| `void_and_reissue_new` | 部分退款，且商家偏好同期作廢重開，或原票是捐贈 | 同上；先作廢原票，確認後才以新的 `RelateNumber` 開立剩餘金額 |
| `allowance` | 部分或全額退款 | 非捐贈、原票已上傳、折讓未滿 50 張、沒有待同意的線上折讓 |
| `void_with_reissue` | 買家資料填錯（載具、統編、捐贈碼），金額不變 | 作廢期限前（另留 2 小時緩衝）、已上傳且開立後 46 小時內、沒有折讓、沒有註銷重開過 |
| `manual` | 以上都不適用（例如捐贈票已過作廢期限） | 商家在站外處理後附證據 |

建議（`suggestInvoiceCorrection`，每筆 `confirmed`／`recorded` 的退款算一次；只看期別的單一規則不夠，EC-AT47）：

1. `unapplied` 退款不需要更正。
2. 發票還沒開成（`queued`／`unknown`）時先等；若改成重開新文件，以當下未退金額開立。
3. 累計退款等於原票金額：能 `void` 就 `void`；否則 `allowance`；都不行 → `manual`。
4. 部分退款：捐贈票 → `void_and_reissue_new`，過期 → `manual`；非捐贈 → 依 `correction_preference`，預設 `allowance`；原票尚未上傳時排在上傳之後（以查詢確認上傳狀態）。

- 商家看到建議、理由與其他可行選項，確認後執行；`auto_apply_correction` 開啟時自動執行建議。
- 同一張票同時只有一個進行中的更正，依序執行。
- `void_and_reissue_new`：作廢結果不明時先查 `GetInvalid` [7933]；作廢確認之前絕不開新票，避免同時有兩張有效的票。
- 折讓品項依退款行項產生：退 k 件用 §3.5 的拆法（包括每件不到 1 元時合併成「（共k件）」一項）；只退價差（數量 0）為「{商品名}（折讓）」1 × 金額；運費為「運費」。品項合計＝退款金額＝`AllowanceAmount`（整數元），單價與小計都含稅 [7901]。
- 線上折讓狀態：`submitting → pending_buyer → effective／expired／cancelled`；`effective → voided`（`AllowanceInvalid`，期限依折讓所屬期別 [7911]）。過期 → 例外 `allowance_unconfirmed`，由商家決定重寄、改紙本或站外處理。
- 更正需要決定、而建議是作廢類且接近期限 → 例外 `invoice_correction_due`（期限前 24 小時）。
- 綠界回的剩餘可折讓金額與平台計算不一致 → 例外，以綠界查詢結果為準人工確認。

### 3.8 線上折讓同意通知

- `POST /api/v1/provider-callbacks/ecpay/{account_ref}/invoice-allowance`：`application/x-www-form-urlencoded`，欄位 `RtnCode`、`RtnMsg`、`IA_Allow_No`、`IA_Invoice_No`、`IA_Date`、`IIS_Remain_Allowance_Amt`、`CheckMacValue`（MD5）[15391][38242]。不含買家個資，也不含 `MerchantID`：帳戶只由路徑上的 `account_ref` 決定。只有買家同意（`RtnCode=1`）才會通知 [15391]。
- 驗證：依帳戶取發票金鑰驗 MD5（官方向量 [38242] 已重算）；`IA_Allow_No` 必須是這個帳戶下 `pending_buyer` 的折讓。寫入事件（提議 `commerce_invoice_events`，去重鍵 (帳戶, `IA_Allow_No`, `RtnCode`)）並把折讓改為 `effective`，交易提交後才回 `1|OK` [15391]。重送只套用一次。
- 通知可能被擋（staging 需要 Access 排除，由 Ted 操作）或遺失，所以同時用 `GetAllowanceList` 定期查：每 6 小時，到到期後 1 小時 [7928]。
- 不需要 CSRF；不做 IP 白名單（同 EC-SPEC-04 §9）。

### 3.9 顯示與通知

- 買家（B07）：發票號碼、日期、隨機碼、類型（載具號碼遮罩，例如 `/AB***9`；統編與捐贈碼照實顯示）、狀態、折讓清單（金額、日期、狀態）。待同意的線上折讓提示「請到 Email 確認折讓，{到期時間}前有效」。
- 賣家（E05、E10）：同上，加上傳狀態、錯誤碼、建議更正與期限、操作紀錄。
- 平台在 C2 不呼叫 `InvoiceNotify` [7938]；綠界是否寄開立通知給買家，依商家在綠界後台的通知設定。平台自己的 Email 需要寄送授權（EC-SPEC-10 §6.2）。
- 不提供發票列印：`InvoicePrint` 只適用 `Print=1` 的票 [7949]，C2 不開紙本。

### 3.10 開通、停用與換帳戶

- 帳戶與金鑰共用 EC-SPEC-04 §1（`purpose=invoice`，金鑰與金流、物流不同 [2853]）。
- 發票服務 `draft → active`：sandbox 以 stage 測試商家（`2000132` [7849]）完成一次開立、查詢、作廢；live 以唯讀查詢確認金鑰與字軌，再由店主確認開票設定。不為了驗證而開一張真發票。
  - 字軌查詢 `GetInvoiceWordSetting` [7881]：`InvoiceYear` 是民國年（只能查去年、今年、明年）；`InvoiceTerm` 0 是全部，1～6 是 1–2 月到 11–12 月；`UseStatus` 0 是全部，1 未啟用、2 使用中、3 已停用、4 暫停中、5 待審核、6 審核不通過；`InvoiceCategory` 固定 1（B2C）。每組字軌回傳 `InvoiceHeader`（2 碼）、`InvoiceStart`／`InvoiceEnd`（8 碼）、`InvoiceNo`（目前已使用的號碼）與 `UseStatus`。
  - 開通條件：本期（台灣時間）有 `InvType=07`、使用中的字軌，且還有號碼（`InvoiceEnd`－`InvoiceNo` > 0；還沒用過時 `InvoiceNo` 的值待 stage 確認）。官方範例的格式有誤（陣列寫成物件、缺逗號），解析以欄位表為準，陣列與單一物件都接受。
- `suspended`：不開新票；既有發票的查詢與更正照常（在途責任不消失，EC-R56）。
- 換帳戶（換特店編號）：舊帳戶留在 `suspended` 並保留可用金鑰；舊票的更正一律用開立它的帳戶。商家確認舊票不再需要更正後，舊帳戶才能 `retired`。

## 4. 賣方揭露與政策

### 4.1 賣方揭露

表在 EC-SPEC-02 §2.1（`commerce_storefront_seller_profiles`）。

- C2 必填：營業名稱（零售責任主體，DC01）、聯絡 Email、電話、地址（營業地址或可受理文件的地址；公開顯示，填寫時提示）、客服時間。可選：統一編號、負責人。
- 顯示在 B09、店面頁尾、結帳確認步驟、訂單頁與確認信，並固定一句：「本店由{營業名稱}經營，負責商品、收款、出貨安排與售後；自由工坊提供網站服務，不是賣方。」
- 收款帳戶一致：開通付款服務時（EC-SPEC-04 §1.4），店主確認「這個綠界特店帳戶屬於{營業名稱}」。平台無法核驗，只記錄確認者與時間。
- 平台不認證揭露內容。這是商家公開的營業資訊，不是買家個資。

### 4.2 政策

表在 EC-SPEC-02 §2.1（`commerce_storefront_policies`）。`shipping`、`returns`、`privacy` 是開放結帳前的必要政策，`terms` 選填（EC-SPEC-02 §2.3）。

編輯器提供每種政策的段落清單（只有標題，不附法律文字），避免漏項：

| 政策 | 段落 |
| --- | --- |
| `shipping` | 配送範圍與方式、運費、出貨時間、拆包、離島、未取件的處理（EC-SPEC-05 §8.1） |
| `returns` | 申請期間與條件、不適用的商品與理由、寄回方式與運費負擔、退款方式與時間、發票如何更正（§3.7） |
| `privacy` | 收集哪些資料、用途、提供給誰（綠界的金流、物流、發票；代出貨的供應商只取得必要收件資料）、保存期限、聯絡方式 |
| `terms` | 契約成立、取消、付款、發票 |

- 系統要用的結構化欄位：`returns.window_days`（售後申請期間，§2.2）、`returns.return_by_days`（核准後寄回期限，預設 14）。其餘是文字。
- 代出貨：店裡有已接受的代出貨同意（EC-SPEC-05 §2.6）時，`privacy` 必須勾選「已說明代出貨時會把必要收件資料提供給負責出貨的供應商」，否則不能開放結帳。
- AI 只能產生草稿，由店主修改後發布（計畫 §12.3、EC-SPEC-07）。

### 4.3 版本與凍結

- 每次發布產生不可改的版本。店面發布文件記錄當時的版本（EC-SPEC-02 §2.2）；結帳的 `consents` 凍結買家同意的版本（EC-SPEC-02 §5.3）；訂單另記賣方揭露的版本。
- 公開路徑：`/shops/:slug/policies/:kind`（目前版本）、`/shops/:slug/policies/:kind/v/:version_id`（訂單頁連到下單時的版本）。內容是店家公開的條款，所以版本都可公開讀取。
- 修改政策只影響之後的結帳；售後申請期間依訂單凍結的 `returns` 版本判斷（§2.2）。

## 5. 零售商與供應商之間的金額（SL-05）

### 5.1 原則與既有表

- 只記錄、不動錢：平台不代收、不代付、不扣款、不設錢包（計畫 §12.2）。
- 既有的 `commerce_supplier_payables`、`commerce_obligation_reversals`、`commerce_settlement_records`（`migrations/056_commerce_distribution.sql:29-66`）屬於匯入商店：以使用者為受款人（`beneficiary_user_id`）、付款時入帳、狀態只有 `recorded`，且 `138` 以複合外鍵限定 `order_profile='imported_reseller'`（`migrations/138_hosted_direct_reservations.sql:77-78`）。新交易不寫這三張表，也不放寬它們的約束；沿用的是同樣的原則：只能新增、`money_movement_enabled=false`、`platform_collects=false`、`auto_debit=false`。
- 新帳本以事業（tenant／instance）為雙方：付款方＝零售商，收款方＝供應商。

### 5.2 代出貨同意中的金額條款

代出貨同意（EC-SPEC-05 §2.6）凍結以下條款：

| 條款 | 說明 |
| --- | --- |
| 供貨單價 | 訂單行項凍結的 offer terms `cost_minor`（`contracts/guild-launchpad/v1/hosted-supply-terms.ts:9`），同意中不另訂 |
| `dropship_fees[]` | 每個服務一筆 `{service_key, fee_per_parcel_minor}`，來自供應商代出貨方案的 `fees[]`（EC-SPEC-05 §2.3）：每個已交寄包裹的代出貨費，**已包含**出貨者自付的物流費，沒有另外的運費補貼。一個包裹適用它所屬群組凍結的 `service_key` 那一筆。取代 offer terms 中按件計算的 `shipping_minor`（`modules/agent-commerce/distribution.ts:65` 以數量相乘），避免重複計算；供應商接受同意時確認這一點。和賣家向買家收的運費（EC-SPEC-05 §2.4 的 `fee_per_parcel_minor`）無關 |
| `cancel_after_create_fee_minor` | 已建立託運單、因零售商取消而作廢的包裹，預設 0 |
| `return_handling_fee_minor` | 每筆退回檢驗，預設 0 |
| `unsellable_return_default` | 檢驗為不可售時的預設責任：`retailer`／`supplier`／`case_by_case` |
| `payment_due_days` | 對帳單核對後幾天內付款，1～90，預設 30。對帳單只收同一個付款天數的帳目（§5.4） |
| 幣別 | 與 offer 相同 |

### 5.3 帳目（提議 `commerce_settlement_entries`）

欄位：`entry_id`、付款方與收款方 tenant／instance、`agreement_id`、零售商的 `order_id`、種類、來源鍵（唯一）、金額（正數＝付款方欠收款方；負數＝收款方退回）、幣別、狀態（自動帳目直接 `posted`；調整為 `proposed → posted／rejected`）、建立者、時間。只能新增；更正是另一筆帳目。

| 種類 | 畫面用詞（E09、SL-05 共用） | 何時（來源事實） | 金額 |
| --- | --- | --- | --- |
| `supply_cost` | 供貨款 | 交寄（EC-SPEC-05 §5.5 的每個 (shipment, 配置)） | 供貨單價 × 交寄數量 |
| `parcel_fee` | 代出貨費 | 交寄（每個 shipment 一次） | 該包裹服務在 `dropship_fees[]` 的 `fee_per_parcel_minor` |
| `cancelled_parcel_fee` | 已建單作廢費 | 已建單、因零售商取消而作廢的包裹 | `cancel_after_create_fee_minor` |
| `return_credit` | 退回回庫扣抵 | 檢驗定案的可再售數量（EC-SPEC-05 §8.3） | －供貨單價 × 回庫數量 |
| `return_handling_fee` | 退回處理費 | 檢驗定案 | `return_handling_fee_minor` |
| `unsellable_credit` | 不可售扣抵 | 檢驗為不可售，且預設責任為 `supplier` | －供貨單價 × 不可售數量 |
| `adjustment` | 調整 | 任一方提出、另一方接受（遺失理賠、毀損、運費差額等）；必須指定一份雙方的代出貨同意，付款天數依那份同意 | 附原因的任意金額 |

- 自動帳目的來源鍵唯一（例如 (`supply_cost`, shipment, 配置)），事件重送不會重複入帳。交寄後的帳目不因買家退款消失（SC-LAT18）。
- `adjustment` 由一方提出，另一方接受才 `posted`；拒絕也留紀錄。預設責任為 `case_by_case` 的不可售檢驗，會自動開一筆待雙方處理的提議。
- 賣家自出貨（自己的商品）不產生帳目；賣家付給綠界的物流費在綠界自己的帳單上，`HandlingCharge`（EC-SPEC-05 §6.2）只作報表參考。

### 5.4 對帳單與付款證據

提議 `commerce_settlement_statements`：一組 (付款方, 收款方, 幣別, 付款天數)、期間、包含的帳目（每筆帳目最多在一張未撤回的對帳單裡）、合計、狀態、到期日。付款天數來自帳目所屬的代出貨同意；收款方選一個期間建立對帳單時，期間內的帳目依付款天數自動分成多張，所以每張對帳單只有一個到期日。

| 狀態 | 中文 | 誰 | 意義 |
| --- | --- | --- | --- |
| `draft` | 草稿 | 收款方 | 選取期間內 `posted` 的帳目；付款方看不到 |
| `issued` | 已請款，待核對 | 收款方 | 送出請款；可附交易文件參考（例如 B2B 發票號碼或收據編號），平台不開立也不驗證 |
| `reconciled` | 已核對，待付款 | 付款方 | **已核對**：同意金額；到期日＝核對日＋付款天數 |
| `disputed` | 有異議 | 付款方 | 逐筆註明異議；出現在收款方的待辦，收款方撤回對帳單，以 `adjustment` 更正後重開，或補充說明後請付款方重新核對（回到 `issued`） |
| `partially_paid` | 部分付款 | 付款方 | 登錄了付款證據（日期、金額、方式、參考末碼；附件在 C4，WP-00 §7），合計未達總額 |
| `paid` | 已支付 | 付款方 | 付款證據合計達到總額 |
| `withdrawn` | 已撤回 | 收款方 | `draft`、`issued` 或 `disputed` 時撤回；帳目釋出，可放進新的對帳單。已核對或已有付款證據後不能撤回，只能以 `adjustment` 更正 |

逾期不是狀態：`reconciled`／`partially_paid` 超過到期日時，雙方清單另外標示「已逾期」。

- 收款方可以按「確認收到」，畫面另外標示「收款方已確認」。
- 「已支付」只代表付款方登錄了證據。平台沒有銀行資料，畫面標示「付款方自行登錄，平台未核對銀行紀錄」（SC-LAT19）。
- C2 不自動產生月結，由收款方隨時建立；過了到期日未付清，雙方清單都標示逾期。
- B2B 交易文件不是零售發票；平台在 C2 不開立 B2B 發票（計畫 §4.1）。

### 5.5 可見範圍

- 雙方都看得到自己參與的帳目與對帳單；RLS 依兩個 tenant。
- 供應商看到：零售商店名、訂單顯示編號、SKU、數量、供貨單價與各項費用。**看不到**零售價、折扣、買家付款、退款與發票（同 EC-SPEC-05 §9.2 的白名單）。
- 零售商另外看得到自己訂單的零售資料。

## 6. 報表（E09、E10、SL-05）

`GET …/reports?kind=&from=&to=` 依權威表即時計算；依幣別分開、不含個資、顯示資料時間，sandbox 與 live 分開：

| 報表 | 內容 |
| --- | --- |
| 收款 | 已確認收款、退款（API 確認與人工紀錄分開）、手續費、待確認、例外（EC-SPEC-04 §8） |
| 發票 | 已開立、已作廢、折讓（生效／待同意／已作廢）、開立失敗、待更正 |
| 供貨帳 | 應付（已記帳、未進對帳單）、已核對、已支付、收款方已確認；依對方分組 |
| 履約 | 依狀態的包裹數、交寄所需時間、例外數（EC-SPEC-05） |

- 不顯示「已入帳」「已撥款」：綠界撥款與銀行入帳不在本系統（EC-AT24）。
- 不跨幣別相加；不把模擬付款、sandbox 訂單或物流簽收算成營收（計畫 §12.3、EC-R57）。
- CSV 匯出不含收件資料與發票載具號碼（EC-AT48）。

## 7. 例外種類

加進共用的 `commerce_exception_cases`（EC-SPEC-05 §7.1），隨本文件的 migration 建立；關聯對象增加售後申請、發票文件、更正與折讓。責任方都是零售商：

| 種類 | 來源 | 責任方 | 下一個合法動作 | 期限 |
| --- | --- | --- | --- | --- |
| `aftersales_decision_due` | 售後申請未決定 | 零售商 | 核准或拒絕 | 申請後 3 天 |
| `return_not_received` | 超過寄回期限仍未收件 | 零售商 | 聯絡買家；延長期限或結束申請 | `return_due_at` |
| `refund_not_created` | 檢驗已定案，退款尚未建立或核准 | 零售商 | 建立或核准退款 | 3 天 |
| `invoice_issue_failed` | 開立被拒（§3.4） | 零售商 | 修正資料後重開 | — |
| `invoice_issue_unknown` | 24 小時無法判定（§3.6） | 零售商 | 到綠界後台核對後附證據結案 | — |
| `invoice_correction_due` | 作廢類建議接近期限仍未決定 | 零售商 | 確認更正 | 作廢期限前 24 小時 |
| `invoice_correction_manual` | 沒有可用的 API 更正 | 零售商 | 站外處理後附證據 | — |
| `allowance_unconfirmed` | 線上折讓 72 小時未同意 | 零售商 | 重寄、改紙本或站外處理 | — |

不進這張表的兩種待辦：發票服務無法使用是店層級的提示（§3.4），不逐張訂單開例外；對帳單異議以對帳單本身的 `disputed` 狀態出現在收款方的待辦（§5.4），因為一張對帳單涵蓋多張訂單。

## 8. 頁面與 API

私有路由在 `/api/v1/tenants/:t/storefronts/:i/…` 之下，伺服器每次重新核對 tenant、instance 與能力。能力見 EC-SPEC-09 §2.2：`store:orders:manage`（售後決定、對話回覆；回覆另需 `store:customers:read`）、`store:refund`（退款核准）、`store:invoices`（發票設定與更正）、`store:settlements`（供貨帳，付款方與收款方都用）、`store:customers:read`（讀對話）、`store:finance:read`（讀發票、退款與供貨帳）。

### 8.1 買家（B07、B08）

| 路由（提議） | 用途 |
| --- | --- |
| `POST /api/v1/public/stores/:slug/orders/:order_ref/aftersales-requests` | 申請取消、退貨或退款（`Idempotency-Key`） |
| `POST …/orders/:order_ref/aftersales-requests/:rid/withdraw` | 撤回（`pending` 時） |
| `POST …/orders/:order_ref/aftersales-requests/:rid/return-shipment` | 填寄回的物流公司與單號 |
| `GET／POST …/orders/:order_ref/messages` | 訂單對話 |
| `POST /api/v1/public/stores/:slug/invoice-checks` | 結帳時的輔助查詢（需要 checkout 憑證、限流，§3.3） |
| `GET …/orders/:order_ref` | EC-SPEC-02 的訂單讀取，加上售後、退款狀態與發票 |

### 8.2 賣家（E05、E07、E09、E10）

| 路由（提議） | 用途 |
| --- | --- |
| `GET …/aftersales-requests?state=&cursor=`、`GET …/aftersales-requests/:rid` | 售後清單與詳情 |
| `POST …/aftersales-requests` | 店家開啟（含從例外開啟，§2.6） |
| `POST …/aftersales-requests/:rid/decision` | 核准（含退款計畫）或拒絕 |
| `GET …/support-threads?state=`、`POST …/support-threads/:id/messages` | 對話 |
| `GET／PUT …/invoice-settings` | §3.1 |
| `GET …/invoices?state=`、`GET …/invoices/:id`、`POST …/invoices/:id/query` | 發票與立即查詢 |
| `POST …/invoices/:id/manual-result` | `manual_record` 登錄號碼 |
| `POST …/invoice-corrections/:cid/decision` | 確認建議，或改選其他可行的更正 |
| `GET …/settlement-statements?role=payer&state=&cursor=`、`GET …/settlement-statements/:stid`、`GET …/settlement-entries?role=payer&agreement=&from=&to=&cursor=` | 供貨帳（付款方）：對帳單清單、明細（含帳目列）、未進對帳單的帳目 |
| `POST …/settlement-statements/:stid/reconcile`、`…/dispute`、`…/payments` | 核對、異議、登錄付款證據 |
| `GET …/reports?kind=` | §6 |

### 8.3 供應商（SL-05）

| 路由（提議） | 用途 |
| --- | --- |
| `GET …/settlement-statements?role=payee&state=&cursor=`、`GET …/settlement-statements/:stid`、`GET …/settlement-entries?role=payee&agreement=&from=&to=&cursor=` | 收款方：對帳單清單、明細、未進對帳單的帳目 |
| `POST …/settlement-statements`、`…/:stid/issue`、`…/:stid/withdraw`、`…/:stid/confirm-receipt` | 建立（依付款天數自動分張）、請款、撤回、確認收到 |
| `POST …/settlement-adjustments`、`POST …/settlement-adjustments/:id/decision` | 提出或接受調整（雙方都可） |

Supplier Console 的 SL-05 讀取投影只能用 §5.5 的欄位。

### 8.4 機器路徑

| 路徑 | 說明 |
| --- | --- |
| `POST /api/v1/provider-callbacks/ecpay/{account_ref}/invoice-allowance` | 線上折讓同意通知（§3.8） |

## 9. 程式位置、migration 與能力

- 協定：`modules/agent-commerce/providers/ecpay/`（EC-SPEC-04 §10）。發票 profile `ecpay.invoice.b2c.v1` 在 `ecpay/b2c-invoice/`（ecpay-invoice 工作）：15 個端點的請求組裝與回應解析、線上折讓同意通知（MD5 CheckMacValue，同物流 [38242]）、三種輔助查詢的判讀、字軌剩餘號碼與 HTTP 狀態判讀。AES 信封是 JSON → .NET 規則 URL 編碼 → AES-128-CBC＋PKCS7 → Base64，解密反向 [7958][38406]。IV 固定，同一份 `Data` 每次加密結果都一樣，所以整個請求內容碰到 CDN 字詞時，在 JSON 開頭 `{` 後加 1～15 個空白重新加密（仍是同一個 JSON 值），16 次都碰到就不送。結果只帶白名單欄位，綠界回傳的買家資料一律丟棄；`RtnMsg`／`TransMsg` 可能帶回請求內容，視同買家資料，不寫日誌。領域程式只呼叫這一層，不直接用 `invoice.buildEnvelope`／`invoice.openResponse`。官方向量：AES 兩組（大寫與小寫 URL 編碼）[7958]、折讓通知 MD5 一組 [38242]；另有在 repo 外以公開 stage 金鑰獨立算出的 27 組請求 golden，Node 與 workerd 都要相同。
- 領域：提議 `modules/agent-commerce/invoices/`（descriptor `commerce-invoices`，相依 `hosted-checkout`、`commerce-payments`、`commerce-providers`）與 `modules/agent-commerce/aftersales/`（descriptor `commerce-aftersales`：售後申請、對話、供貨帳；相依 `hosted-checkout`、`commerce-payments`、`commerce-fulfilment`）。`commerce_refund_lines` 隨 EC-SPEC-04 的 M2。
- 契約：`contracts/guild-launchpad/v1/` 下新檔（例如 `hosted-aftersales.ts`、`hosted-invoice.ts`、`hosted-settlement.ts`），不改既有 v1 契約。
- M4（發票與售後，在 M3 之後）：§2～§5 的表；RLS（對話與發票買家資料屬個資；帳本依兩個 tenant）；不可改與只能前進的 trigger；退款行項上限的 trigger；例外種類；`catalog.ts` 登錄與豁免理由；新增 migration 的全部登錄點（WP-00）。帳目由來源鍵決定性產生，M4 上線時可從 M3 起的交寄與檢驗事實補齊，重跑結果相同。
- 能力 `commerce.hosted-invoice.v1` 與強制下限跟折讓通知路由同一個 migration 上線；回退限制同 EC-SPEC-04／05（EC-SPEC-10 §7）。
- 鎖序：EC-SPEC-03 §6 第 4 項在 `commerce_orders` 之後依序是售後申請（UUID 排序）→ payment attempt → 退款 → 發票文件，再接履約單、shipment、配置與 item。
- Worker 設定：折讓通知路徑的 Access 排除（staging）、發票 operation 的排程、sandbox 測試信箱（§3.3），都由 Ted 操作。
- 搬遷（C3）：發票留在開立它的特店帳戶；可攜版本接手後，舊票的更正仍用同一個帳戶（EC-SPEC-08）。

## 10. 外部驗證的分層（需要 Ted 授權）

| 層 | 內容 | 授權 |
| --- | --- | --- |
| 向量與契約 | AES 2 組、MD5 1 組；品項拆分與退款分攤；作廢期限（每一期別、11～12 月跨年、台灣時區、緩衝）；更正建議矩陣；買家類型矩陣 | 不需要（不連線） |
| stage sandbox | 測試商家 `2000132` [7849]：五種買家類型的開立、以 `RelateNumber` 查詢、作廢、紙本與線上折讓（stage 不寄信，在 stage 後台同意 [15391]）、註銷重開、捐贈票的作廢、重複 `RelateNumber` 的回應、輔助查詢。另外確認：`ItemName` 的長度單位與 emoji；`MerchantID` 送字串是否被接受（部分官方範例寫成數字）；`GetIssue` 查無時的代碼；字軌查詢在號碼還沒用過時的 `InvoiceNo`，以及回傳是陣列還是物件；`VoidModel`／`IssueModel` 是巢狀物件還是 JSON 字串；註銷重開的 48 小時限制；一張票的折讓張數上限與捐贈票能否折讓；加密前的 `Data` JSON 在開頭 `{` 後多出空白（避開 CDN 字詞的變體）是否照常解析，以及發票主機的 CDN 是否也檢查請求內容；回應的 `MerchantID` 是字串還是數字；折讓的 `CustomerName`、`NotifyPhone` 留空是否被接受；註銷重開後發票號碼是否不變（沿用原 `RelateNumber` 與 `InvoiceDate`）；回應日期用 `-` 還是 `/`；`RtnMsg` 會不會帶回請求的內容（決定能否寫進日誌）；HTTP 403 限速只觀察、不刻意觸發 | 需要：連線綠界 stage |
| 正式 | 商家自己的發票帳戶：唯讀開通查詢；第一筆真實訂單的開立與一次更正由商家確認 | 需要：Ted＋該商家 |

## 11. 測試（全部 not_run）

| 案例 | 驗收 |
| --- | --- |
| 退款上限：兩個並行退款；行項金額與數量、運費上限；`unapplied` 只退未套用金額 | EC-AT22 |
| 退款結果不明不重送，查詢後只確認一次（與 EC-SPEC-04） | EC-AT23 |
| 報表：零售實收、退款、供貨應付、已核對、已支付分開；不跨幣別；沒有「已入帳」 | EC-AT24、SC-LAT19 |
| 五種買家類型各自的合法組合；混填被拒；切換類型清空；Email 與載具不進分析與日誌 | EC-AT45 |
| 開立回應遺失 → 以 `RelateNumber` 查回同一張；查無時同號重送被拒、不產生第二張；付款與訂單不變 | EC-AT46 |
| 已開票訂單部分退貨：退款、檢驗、折讓各自完成；作廢期限前後、捐贈票、已有折讓、未上傳、50 張上限、待同意的線上折讓 | EC-AT47 |
| 品項拆分與退款分攤（整數元）：L < Q 元（合併成一項、不送 0 元品項）、L 可整除、大數；逐件退的合計＝L；非整數元的金額被拒 | EC-AT47 |
| 供應商呼叫退款、發票、售後決定的路由 → 拒絕且沒有副作用；零售商可以 | SC-LAT17 |
| 退款成功但退件未檢、發票未更正 → 售後不能結案，畫面列出未完成的軸 | SC-LAT18 |
| 帳目來源鍵去重（交寄、檢驗事件重送）；調整要另一方接受；對帳單不重複收錄帳目 | SC-LAT19 |
| 代出貨費依包裹的服務取 `dropship_fees[]`；兩份付款天數不同的同意 → 建立對帳單時分成兩張、各有到期日；撤回的對帳單釋出帳目；已核對後不能撤回 | SC-LAT19 |
| 折讓通知：MD5 向量、錯帳戶、未知折讓、重送只套用一次、提交後才回 `1\|OK` | EC-R19 |
| 政策：缺 `returns` 或 `privacy` 不能開放結帳；代出貨未勾選說明不能開放；舊訂單依凍結版本判斷申請期間 | EC-SPEC-02 §2.3 |
| 售後申請：期間邊界、送達事件缺漏、同一行項兩張申請、撤回與核准同時發生 | EC-R39 |

## 12. 仍待決

| 項目 | 建議 | 只影響 |
| --- | --- | --- |
| DC06 發票責任 | 每位商家自己決定；平台不代開 | 該商家的正式交易 |
| 開立時點 | 付款確認後立即；延遲開立在 C4 | 取消造成的作廢次數 |
| 折讓方式預設 | 線上同意（72 小時） | 買家未同意時的處理量 |
| 免稅、零稅率、混合稅率、紙本、實體卡載具 | C4 | 對應商品與買家 |
| 售後申請期間的下限 | 表單最小值 7 天；法定期間與合理例外由商家（必要時法律專業）確認 | 商家的退貨政策 |
| 對話附件（照片證據） | 預設：C2 只收文字，C4 加私有附件用途（WP-00 §7） | 毀損、缺件的舉證 |
| 自動月結對帳單 | C2 不提供，收款方隨時建立 | 對帳頻率 |
| 依實際物流帳單轉嫁運費 | C4；C2 用每包固定費用 | 運費差額 |
| stage 連線授權 | 需要 Ted | sandbox 端到端；不影響向量與契約測試 |
