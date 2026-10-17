# EC-SPEC-11 線下付款：銀行匯款與面交

需求來源：Ted 在 2026-10-16 決定，新結帳的每筆訂單都可以選「銀行匯款」或「面交」，與綠界信用卡並列，由賣家確認收款。沒有綠界帳戶的店也能開放新結帳。

- 本文件以 `b7a991e2`（PR #863 的 head）為基準。
- 標「提議」的表名、欄位、路由與函式名稱可以收斂；不變條件與相容規則不可縮小。
- 本規格就是 DC05 要求的「長效配置、晚付與對帳」定義，只適用於這兩種方式。

## 0. 不變的原則

- **平台不代收，也不核對銀行入帳**（DC01）。線下方式的「已付款」只表示店家確認收款，平台沒有向銀行查證。
  - 買家看到「店家已確認收到付款」。
  - 賣家與報表標示「店家確認」。
  - 不寫「付款成功」或「已入帳」。
- DC05 對綠界的 ATM、超商代碼、條碼與貨到付款仍然有效，本規格只開放兩種線下方式。
- 錢直接付給經營這間店的事業：匯款到它自己的帳戶，面交時當面付給它。平台不經手、不分帳、不設錢包。
- 每間店決定自己提供哪些方式。「每筆訂單都可以選」是指：店家設定好之後，買家在每筆訂單都能從這些方式中選一種。

## 1. 名詞

| 付款方式（terms 與 DTO 的值） | 主機設定的 profile ID | 買家看到 | 說明 |
| --- | --- | --- | --- |
| `immediate_card` | `ecpay.aio.credit.v1` | 信用卡 | 既有，見 EC-SPEC-04 §2 |
| `bank_transfer` | `offline.bank_transfer.v1` | 銀行匯款 | 買家匯款到店家的帳戶，再由店家確認收款 |
| `cash_on_meetup` | `offline.cash_on_meetup.v1` | 面交付款 | 面交時付給店家，店家在面交完成時確認 |

新的配送方式 `meetup` 在買家畫面顯示「面交取貨」，規則見 §2.2。

付款與配送的組合：

| 付款＼配送 | 宅配、超商取貨 | 面交取貨 |
| --- | --- | --- |
| 信用卡 | 可 | 可 |
| 銀行匯款 | 可 | 可 |
| 面交付款 | 不可 | 可 |

## 2. 賣家設定

### 2.1 線下收款設定（E11 `settings/payments`；提議 `commerce_offline_payment_settings`）

每間店一份設定。每次修改都新增一個版本，版本號從 1 開始連續，寫入後不可改。表有 tenant RLS，因為裡面有事業的銀行帳號。

文件 `freedom.offline-payment-settings/v1` 有兩個區塊。區塊是 `null` 表示不提供該方式。

- `bank_transfer`：
  - `bank_code`：3 位數字（金融機構代碼）。
  - `bank_name`：1～20 字。
  - `branch_name`：0～20 字，可省略。
  - `account_number`：去掉空白與連字號後須是 6～16 位數字；只存數字。
  - `account_name`：戶名，1～40 字。
  - `deadline_days`：付款期限，1～7 天，預設 3。
  - `note`：給買家的說明，0～200 字。
- `cash_on_meetup`：
  - `deadline_days`：等候面交的期限，1～14 天，預設 7。

文字欄位的檢查：

- 先去掉頭尾空白，再檢查長度。
- 含控制字元時是欄位錯誤 `format`。
- NUL 與單獨的 surrogate 不會進到欄位檢查。HTTP 的共用 JSON 護欄先回 422 `validation_failed`。直接命令邊界的 `jsonSnapshot` 回 400 `invalid_command_json`。不要放寬這兩道護欄。
- 所有欄位錯誤合併成一個 422 `offline_settings_invalid`，附 `fields`。結構或型別不符（例如期限不是整數）是 422 `validation_failed`，不是欄位錯誤。

權限：

- **寫入**只限 owner 或 admin，而且要重新輸入密碼。理由：改收款去向不放進可授予的能力（EC-SPEC-09 §2.2）。
  - 沿用重新確認的用途 `commerce.provider_account.write`，不新增用途。
  - `fresh_auth_verification_id` 是命令要求的中繼資料，放在嚴格輸入的頂層，跟 `schema`、`bank_transfer`、`cash_on_meetup` 並列。它不是版本化設定文件的欄位，不寫進 `commerce_offline_payment_settings`，也不出現在設定檢視。缺欄、格式、目前授權、一次性與回條命名空間沿用 provider account 命令。
  - 需要 `If-Match`（目前版本；第一次設定時省略）與 `Idempotency-Key`。
  - 每次寫入記一筆控制事件 `offline_payment_settings.changed`。`detail` 只有提供了哪些方式和版本號，不含帳號。這個種類加進 `commerce_control_events` 的封閉清單（EC-SPEC-10 §8.2）。
- **讀取**：
  - owner 與 admin 看到完整內容。
  - 有 `store:manage` 或 `store:finance:read` 的成員看到銀行、分行、戶名，帳號只顯示末 4 碼。

### 2.2 面交取貨（E11 `settings/shipping`）

`meetup` 是 EC-SPEC-05 §2.4 `delivery_options[]` 的一種：`{method: 'meetup', note}`。

- `note`：1～200 字，寫可以面交的地區與時段；結帳時顯示給買家。
- 面交沒有運費；凍結的運費一律是 0。
- 只有**賣家自出貨**的配送群組能面交（EC-SPEC-05 §1.1）。
  - 供貨商品的庫存在供應商手上，所以直送的群組不提供面交，不可用原因是 `method_unsupported`。
  - 依 EC-SPEC-05 §3.3 的交集規則，購物車裡只要有直送的商品，就不會出現面交。
- 面交不需要寄件地、物流帳戶與商品配送屬性。
  - 選面交時，報價跳過 EC-SPEC-05 §3.2 的拆包，也跳過 `shipping_attributes_missing` 的檢查。
  - 每個群組只有一個面交「包裹」，群組鍵裡沒有寄件地與服務。
- 面交的收件資料只要姓名與手機，不需要地址。

## 3. 結帳與下單

### 3.1 付款方式的選項

**購物車報價**（EC-SPEC-02 §5.2）新增 `payment_options[]`，每項是 `{method, available, reason}`：

- 這是 B05 第 3 步顯示用的資料，不保存。
- 結果可以因呼叫者是否登入而不同。

**checkout 凍結的 terms**（EC-SPEC-02 §5.3）：

- `payment_methods[]`：可用的方式。
  - 只依店家設定、主機設定、配送方式與金額判斷，**不依身分**，因為 checkout 不記錄建立者。
  - 契約從「只有 `immediate_card` 一項」改成 1～3 個不重複的值。
- `offline_payment`：`{settings_version, bank_transfer_deadline_days, meetup_deadline_days}`；沒有線下方式時是 `null`。
- 兩者都計入 `terms_sha256`，所以店家在 checkout 建立後改了設定，下單時會得到 `terms_changed`。
- 公開的 terms 視圖不含帳號；帳號只在下單後的訂單頁出現（§6.2）。
- 沒有任何可用方式時，建立 checkout 回 409 `payment_method_unavailable`。

各方式的可用條件：

| 方式 | 可用條件 | 不可用原因 |
| --- | --- | --- |
| 信用卡 | 店在目前環境有 `active` 的付款服務；profile 在主機設定的清單內；terms 的金額都是整數元（EC-SPEC-04 §2） | `payment_profile_unavailable` |
| 銀行匯款 | 設定有 `bank_transfer`；profile 在清單內；金額都是整數元 | `payment_profile_unavailable` |
| 面交付款 | 設定有 `cash_on_meetup`；profile 在清單內；配送是面交；金額都是整數元 | `payment_profile_unavailable`；配送不是面交時是 `meetup_required` |
| 匯款、面交付款 | 只在報價中多一個條件：呼叫者是登入的會員（§3.3） | `member_required` |

**下單**（EC-SPEC-02 §5.4）：

- 輸入多一個 `payment_method`，必須在凍結的 `payment_methods[]` 裡，否則回 409 `payment_method_unavailable`。
- 線下方式沒有會員 session 時回 403 `offline_payment_requires_member`。
- 選定的方式存進 sidecar `commerce_checkout_orders` 的新欄位 `payment_method`（提議）。
  - 建立後不可改。
  - 既有的列預設是 `immediate_card`。

### 3.2 下單：與信用卡的差異（EC-SPEC-03 §4.1）

| 項目 | 信用卡 | 匯款、面交付款 |
| --- | --- | --- |
| 保留期限（hold 與 `commerce_orders.expires_at`） | 30 分鐘 | `deadline_days` × 24 小時 |
| `confirmation_window`（EC-SPEC-03 §4.2） | EC-SPEC-04 | 72 小時 |
| 第一個 payment attempt | 建立 | 不建立；線下方式沒有 attempt |
| 到期工作 | `payment_query`、`payment_window_end`（以 attempt 為對象） | 一列 `offline_payment_window_end`（提議，以訂單為對象），`due_at` 是保留期限加 72 小時 |
| 下單後到 | 付款交接頁 | B07 訂單頁（§6.2） |
| 同一個 checkout 的舊單 | EC-SPEC-03 §3.3 的「同 checkout 無未定付款的舊單」 | 還在付款期限內、沒有確認付款的線下訂單也算舊單：回 409 `unresolved_order`，附那張訂單 |

資料庫檢查要放寬：

- 目前的檢查把期限綁在建立時間加 30 分鐘，位置有兩處：
  - 162 的 hold；
  - 168 的 `hosted_checkout` 訂單。
- 新規則：
  - v1 預留的訂單仍然只能是 30 分鐘。
  - `hosted_checkout` 訂單與 hold 可以是 30 分鐘，或剛好 1～14 個整天。
- 期限與 `payment_method` 必須一致：
  - 由下單的領域函式保證；
  - 由 constraint trigger 依 sidecar 與凍結的 terms 核對。
- 既有的「訂單必須與 hold 相符」觸發器不變：它比對的是兩者的 `expires_at` 相等。

### 3.3 防止長時間占用庫存

線下訂單會占用庫存好幾天，所以加上以下限制：

- **只有登入的會員能選線下方式。**
  - guest 仍然可以用信用卡。
  - 店家只提供線下方式時，guest 在 B05 看到「登入會員後才能選擇匯款或面交」。
  - 這是 2026-10-16 的預設，Ted 可以改。
- EC-SPEC-02 §5.5 的上限照舊：每個瀏覽器憑證、每個 Email，在同一家店同時最多 3 張未付款的有效訂單，超過時回 429。
- 線下訂單另以會員計算：每位會員（`buyer_principal_id`）在同一家店同時最多 3 張未付款、還在付款期限內的線下訂單，回應同上。
- 每間店同時最多 50 張未付款、還在付款期限內的線下訂單。超過時回 409 `offline_order_limit`，訊息是：「這間店目前待付款的訂單較多，請稍後再試或選擇其他付款方式。」
- 「還在付款期限內」與上一項的「有效」相同：`commerce_orders.expires_at` 還沒到。寬限期內的訂單已經釋出庫存，不計入。
- 店家隨時可以取消未付款的訂單（EC-SPEC-03 §3.3 的 seller cancel），庫存立即釋出。

## 4. 店家確認收款

共同規則：

- 隔離模式時回 503 `commerce_quarantined`（EC-SPEC-10 §8.3）。
- 新增的能力會帶來新的模組版本（EC-SPEC-09 §2.3），所以這裡只用既有能力。

### 4.1 確認收到匯款（提議 `POST /api/v1/tenants/:t/storefronts/:i/checkout-orders/:order_id/offline-payments`）

| 項目 | 規則 |
| --- | --- |
| 能力 | `store:orders:manage` |
| Header | `Idempotency-Key`；`If-Match`，值是訂單版本 |
| `amount_minor` | 必須等於訂單應付的總額，否則 422 `offline_amount_mismatch`。不收部分付款；金額不符時由店家與買家另外處理，必要時取消訂單 |
| `received_on` | 收款日期 `YYYY-MM-DD`（Asia/Taipei）；不早於下單日，不晚於今天 |
| `reference` | 可省略，0～40 字，例如匯款帳號末五碼 |

條件：

- 訂單是 `open`。
- `payment_method` 是 `bank_transfer`。
- 訂單還沒有確認的付款。
- 已取消的訂單回 409 `order_cancelled`。取消之後才收到的款項，由店家在平台外退還，平台不記錄。

效果（在同一個交易裡）：

1. 新增一列 `commerce_offline_payments`（提議）。
   - 這張表有 tenant RLS，而且只能新增。
   - 記錄方式、金額、日期、參考、確認者與確認時間。
2. 呼叫既有的付款套用（EC-SPEC-03 §5，`checkout/payments.ts`），`payment_ref` 是這筆線下付款的 uuid。綠界付款的 `payment_ref` 則是 attempt。
   - hold 仍有效 → `converted`。
   - hold 已釋放而庫存足夠 → `allocated`。
   - 庫存不足 → `unallocatable`，並開例外 `paid_unallocatable`。例外的對象是這筆線下付款：`commerce_exception_cases.subject_kind` 新增 `offline_payment`。之後的處理照舊：重新配貨，或由店家在平台外退款。
3. 套用結果是 `converted` 或 `allocated` 時，建立履約單（EC-SPEC-05 §4.1）。履約單由 M3 的履約單工作建立，它要涵蓋綠界付款與線下付款兩種來源；在那之前，這一步沒有東西可建。
4. 寫 journal。

其他規則：

- **出貨門檻**：店家確認的線下付款直接算 `confirmed`（EC-SPEC-05 §4.3），因為沒有伺服器對伺服器的查詢可做。
- **讀取與退款要依付款方式分辨 `payment_ref` 指的是哪種紀錄。** 目前以 attempt 為前提的地方要改，例如 `seller-orders.ts` 的付款摘要與 `payments/refunds.ts`。
- **v1 不能撤銷確認。**
  - 確認對話框寫明：「確認後不能撤銷。請先在銀行核對入帳。」
  - 按錯時，要等 M4 的已付款取消（EC-SPEC-06 §2.4）才能在平台內處理。

### 4.2 面交完成

**面交付款的訂單**：提議 `POST …/checkout-orders/:order_id/meetup-completion`。

- 能力：同時需要 `store:orders:manage` 與 `store:fulfil`。
- 輸入：`amount_minor`（必須等於總額）、`completed_on`。Header 同 §4.1。
- 效果（同一個交易）：
  1. 新增一列線下付款，方式是 `cash_on_meetup`。
  2. 呼叫付款套用。
  3. 建立履約單。
  4. 新增一列面交紀錄（提議 `commerce_meetup_handovers`），然後為每個配置的剩餘量各記一筆 `ship` movement。
     - `source_ref` 是這列面交紀錄。
     - N 與 A 同減。
     - 履約單變成 `fulfilled`。
- 套用結果是 `unallocatable` 時，整個命令回 409 `meetup_stock_unavailable`，什麼都不寫。沒有貨就不能交貨。

**以其他方式付款、但選面交取貨的訂單**（信用卡或匯款已確認）：提議 `POST …/checkout-orders/:order_id/meetup-handover`。

- 以訂單為對象，因為面交一次交完整張訂單，而且只有賣家自出貨的群組能面交（§2.2），出貨者一定是這間店。
- 能力：`store:fulfil`。
- 輸入：`completed_on`。Header 同 §4.1。
- 條件：
  - 訂單是 `open`，付款已經 `confirmed`；
  - 所有配送群組都是面交；
  - 還有沒交出的配置量。
- 效果：只記交貨，做法同上面第 4 步（沿用 `checkout/payments.ts` 的交寄函式，`shipment_ref` 是面交紀錄）。

每張訂單最多一筆面交紀錄，一次交完所有剩餘的量。

面交的履約單不會有物流的包裹，也不能建物流單。

## 5. 期限、到期與取消

- **保留期限到了**：照 EC-SPEC-03 §3.3 釋放 hold，訂單仍是 `open`。
  - 接下來 72 小時內，店家仍然可以確認收款。
  - 這時的付款算晚到，配置規則見 §4.1。
- **再過 72 小時仍沒有確認**：`offline_payment_window_end` 把訂單改為 `cancelled(payment_not_completed)`。
  - 這一步不需要任何外部查詢。
  - 意義同 EC-SPEC-03 §3.3 的 payment window end；線下訂單沒有 attempt，所以只看「有沒有確認付款」。
- 買家與店家取消未付款訂單的規則不變，隨時都可以取消。
  - 店家用既有的 `POST …/checkout-orders/:order_id/cancel`。
  - 買家用 B07 的「取消訂單」，提議 `POST /api/v1/public/stores/:slug/orders/:order_ref/cancel`。它適用於所有付款方式，就是 EC-SPEC-03 §3.3 的 buyer cancel，存取規則同訂單頁。M2 還沒有這個端點，隨線下付款一起補上。
- 有確認付款的訂單不會被到期工作取消。
- 面交付款的買家沒出現時，由店家取消未付款訂單。信用卡或匯款已付、買家卻沒來面交時，等 M4 的已付款取消。

## 6. 買家頁

### 6.1 B05

- **第 1 步**：選面交取貨時只要姓名與手機，並顯示店家的面交說明。
- **第 3 步**：依 `payment_options[]` 列出付款方式。不可用的方式顯示原因：
  - `meetup_required`：「面交付款只能搭配面交取貨」。
  - `member_required`：「登入會員後才能選擇匯款或面交」。
- **第 4 步**：信用卡的按鈕是「確認並付款」，線下方式是「確認下單」。

### 6.2 B07 與訂單信

線下訂單下單後直接到 B07。

- 「需要你處理」依下表顯示。
- 匯款資料來自訂單凍結的設定版本，店家之後改設定不影響這張訂單。
- 只有這張訂單的買家看得到匯款資料。

| 情況 | 買家看到 | 操作 |
| --- | --- | --- |
| 等待匯款 | 「請在 {期限} 前匯款 {金額} 到：{銀行代碼} {銀行} {分行}，帳號 {帳號}，戶名 {戶名}。」加上店家說明，再加「店家確認收款後，這裡會更新。」 | 複製帳號；複製金額；取消訂單 |
| 等待面交 | 「店家會用你留下的手機或 Email 和你約時間地點。」加上店家的面交說明與 {期限} | 取消訂單 |
| 保留期限已過、還在 72 小時內 | 「付款期限已過，保留的商品已釋出。如果你已經匯款，店家仍可能在 {寬限期限} 前確認。」 | 取消訂單 |
| 店家已確認收款 | 「店家已確認收到付款。」之後的進度看包裹卡或面交卡 | — |
| 期限結束而取消 | 「付款期限已結束，訂單已取消。如果你已經匯款，請聯絡店家。」 | 回到商店 |

- 買家的訂單 DTO 新增：
  - `payment_method`。
  - `offline_instructions`：只有匯款訂單有，內容是凍結版本的快照。
  - `payment_grace_until`：線下訂單的寬限期限（保留期限加 72 小時）；信用卡訂單是 `null`。
- 線下訂單的 `can_resume_payment` 一律是 false，`latest_payment_attempt` 一律是 null。
- `payment_state` 在確認前是 `unpaid`，確認後是 `confirmed`。
- 賣家看到的付款狀態是「已收款（店家確認）」（EC-SPEC-01 §6.3）。
- 寄信打開後（EC-SPEC-10 §6），下單信附上同樣的匯款資料。信件佇列照舊不存個資，內容在寄出時由訂單產生。

## 7. 賣家頁

- **E05 訂單**：
  - 清單可以依付款方式篩選，另有「待確認收款」篩選。
  - 詳情的付款卡顯示方式、凍結的匯款資料、期限與寬限期限。
  - 操作：確認收到匯款（§4.1）、確認面交完成（§4.2）、取消未付款訂單。
- **E06 履約**：面交的履約單有「確認已面交」（§4.2）。
- **E09 收款與對帳**：列出線下確認的紀錄（誰、何時、金額、參考），並標示「店家確認」。
- **E11**：
  - `settings/payments` 加入線下收款設定（§2.1）。
  - `settings/shipping` 加入面交取貨（§2.2）。

## 8. 主機設定與開放結帳的條件

- `FREEDOM_COMMERCE_PROVIDER_PROFILES`（EC-SPEC-10 §2.2）：
  - 接受 `offline.bank_transfer.v1` 與 `offline.cash_on_meetup.v1`。
  - 只有清單裡有 `ecpay.*` 時，才需要 `COMMERCE_CREDENTIAL_KEYS` 與 `COMMERCE_JOURNAL`。
  - 只列線下 profile 時，這兩項都不需要。Node host 的 `readNodeCommerceSettings` 也只在清單有 `ecpay.*` 時拒絕。
- 開放結帳的條件（EC-SPEC-02 §2.3）第 2 項改成「至少一個可用的收款方式」。下列任一項即可：
  - 已驗證的綠界收款服務；
  - 匯款設定；
  - 面交付款設定。
- 第 3 項「可用的配送設定」可以只有面交。
  - 所以一間只用匯款、面交付款與面交取貨的店，完全不需要綠界的帳戶。
- `commerce_checkout_enabled` 與 console、checkout 開關之間的依賴都不變。

## 9. 程式位置、migration 與能力

- **程式位置**：
  - 線下付款：`modules/agent-commerce/payments/offline/`（提議）。
  - 面交：`modules/agent-commerce/fulfilment/`。
  - 付款套用沿用 `checkout/payments.ts`，事實來源多一種線下付款。
- **migration**：加在 M3 的 migration 裡，目前是 wp05-settings 建立的 `170_hosted_fulfilment.sql`。編號在整合時依 main 決定。一個里程碑只有一個 migration（work-plan §4、EC-SPEC-10 §4.1）。要加的內容：
  - 線下設定、線下付款、面交紀錄三張表；
  - sidecar 的 `payment_method`；
  - hold 與訂單期限的新檢查；
  - 到期工作與控制事件的新種類；
  - tenant data catalog、RLS、route matrix 與還原演練的對應更新。
- **能力**：屬於 M3，由 `commerce.hosted-fulfilment.v1` 涵蓋（EC-SPEC-10 §3）。如果 Ted 決定先上線匯款與面交（§11），M3 就拆成兩次發布，各有自己的 migration 與能力。
- **依賴**：
  - 面交需要 M3 的出貨設定（`delivery_options[]`）與報價。
  - 匯款加宅配或超商取貨，還需要綠界物流（M3）。
  - 匯款或面交付款加面交取貨，不需要綠界的任何帳戶。

## 10. 測試

| 範圍 | 案例 |
| --- | --- |
| 設定 | 每個欄位的錯誤碼；HTTP 的 NUL 與單獨 surrogate 回 422 `validation_failed`，直接命令邊界回 400 `invalid_command_json`，而且什麼都沒寫；版本連續；`If-Match`；重新輸入密碼；只有 owner 與 admin 能寫；讀取依能力遮罩；控制事件不含帳號 |
| 報價與 checkout | `payment_options[]` 與每種不可用原因；面交只在全部自出貨時出現；面交跳過拆包與配送屬性；改設定後 `terms_changed`；沒有可用方式時 409；公開 terms 不含帳號 |
| 下單 | guest 選線下方式時 403；期限是整天數；沒有 attempt；每店 50 張的上限；每位會員 3 張的上限；hold 與訂單的檢查同時接受 30 分鐘與整天數、拒絕其他值；v1 預留仍只能 30 分鐘 |
| 確認收款 | 三種套用結果；金額不符；訂單已取消；同一個 key 重送；`If-Match` 衝突；能力矩陣；確認後可建物流單（出貨門檻）；付款摘要與退款依付款方式分辨 `payment_ref`；隔離模式 503 |
| 面交 | 完成命令在缺貨時什麼都不寫；N 與 A 同減；只有出貨者能記交貨；信用卡加面交的交貨；面交履約單不能建物流單 |
| 到期 | 保留期限到了釋放庫存、訂單仍 open；寬限期內確認；寬限期後自動取消；已確認的訂單不被取消 |
| 買家頁 | B07 各狀態的文案；複製帳號；線下訂單沒有付款與重新付款按鈕；不同訂單、不同店之間看不到彼此的匯款資料 |
| 主機設定 | 只列線下 profile 時不需要金鑰與日誌；有 `ecpay.*` 時仍需要；未知 ID 就緒失敗 |
| 隔離與還原 | 新表的 tenant 隔離、route matrix、還原演練 |

## 11. 待決

- 只有會員能選線下方式（§3.3）：這是預設，等 Ted 確認。
- 先後順序由 Ted 決定。只用匯款或面交付款、再加面交取貨的店，可以比綠界物流早上線（§9）。
  - 代價：M3 要拆成兩次發布。
  - 第一次：出貨設定、報價、線下付款、面交、B05 與 E 頁。
  - 第二次：綠界物流的建單、標籤、貨態與退回。
- 不在 v1：
  - 部分付款；
  - 撤銷確認（§4.1）；
  - 買家回報已匯款，例如末五碼；
  - 多個收款帳戶；
  - 期限前的提醒信；
  - 超商取貨付款。
- 面交的地點與時段是自由文字。v1 沒有預約功能，由店家與買家自己約。
