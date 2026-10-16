# EC-SPEC-04 收款：商家帳戶、PaymentPort、綠界 AIO 信用卡、通知與查詢、退款與對帳

需求：EC-R13、R15～R24、R29、R53。驗收：EC-AT08、09、12～25、30、31、60、68。

本文件是 C2 收款的設計，基準 `efaf314d`。綠界（ECPay）的協定事實取自官方開發者文件，經本機重算官方範例向量與逐頁抽查（方法與更正見 [sources.md](sources.md)）；文中以 `[頁碼]` 標示 `https://developers.ecpay.com.tw/<頁碼>/`。標「提議」的表、路由與函式尚未存在。本設計不呼叫任何綠界服務；連線 stage 或正式環境都要 Ted 另外授權（§11）。

## 1. 責任與商家帳戶（DC01、DC02）

### 1.1 誰收款

- 一間店一個零售責任主體＝經營該店的事業（tenant）。收款用這個事業**自己的**綠界特店帳號；平台不代收、不分帳、不設錢包（計畫 §4.1）。
- 送給綠界的內容不帶 `PlatformID`（整個欄位省略，不送空字串）：平台不是綠界的「特約合作平台商」，不替會員建單 [2862]。通知裡的 `PlatformID` 必須為空或缺（§5.2）。
- 供應商的貨款、運費與理賠是賣家與供應商之間的應付帳款（EC-SPEC-06 §5），不經過買家付款流程。

### 1.2 帳戶紀錄（提議 `commerce_provider_accounts`＋`commerce_provider_account_services`）

一個綠界特店帳戶可以同時開通金流、物流與發票，三者的金鑰不同 [2853]。帳戶一列，開通的服務各一列；付款、物流（EC-SPEC-05 §2.2）與發票（EC-SPEC-06）共用這兩張表。

帳戶（`commerce_provider_accounts`）：

| 欄位 | 說明 |
| --- | --- |
| `account_id`、tenant／instance | 屬於一間店（一個事業） |
| `provider` | `ecpay` |
| `environment` | `sandbox`（綠界 stage）或 `live`；訂單的 `environment` 必須與帳戶相同（EC-SPEC-03 §3.1） |
| `merchant_id` | 綠界特店編號（非秘密，但只給店內有權者看）；(provider, environment, merchant_id) 在同一間店內唯一 |
| `version`、建立／更新時間 | 每次改動 +1 |

帳戶本身沒有狀態：啟用、停用與退役都記在服務列上。需要「這個帳戶可用」的地方（例如 §1.4 的驗證付款與它的交接頁）檢查的是 tenant 與 instance 為 `active`、帳戶屬於這間店，以及該用途的服務狀態。HTTP 命令沿用帳戶命令既有的檢查（tenant 不是 `active` 回 403 `capability_denied`，instance 不是 `active` 回 409 `storefront_unavailable`），交接頁與訂單交接相同（409 `payment_handoff_unavailable`）；機器路徑的到期工作不呼叫綠界，記 `tenant_inactive`（EC-SPEC-09 §2.5）。

服務（`commerce_provider_account_services`）：

| 欄位 | 說明 |
| --- | --- |
| `account_id`、`purpose` | `payment`／`logistics`／`invoice` |
| `profile` | 付款為 `ecpay.aio.credit.v1`（§2）；物流與發票見 EC-SPEC-05、06 |
| `credential_version` | 這個用途目前使用的金鑰版本（§1.3） |
| `throttled_until` | 綠界對這個用途回 HTTP 403 時設定（§6.3）；同帳戶、同用途的查詢與操作暫停到這個時間，其他用途不受影響（EC-SPEC-09 §4） |
| `state` | `draft` → `active` → `suspended`／`retired`；只有 `active` 能建立新付款。同一間店、同一環境、同一 profile 同時最多一個 `active`。物流例外：子類型各自一列並各自開通，`logistics` 服務列不受這條限制（EC-SPEC-05 §2.2） |
| 開通證據 | §1.4 的驗證交易參考與時間 |
| `version` | 每次改動 +1 |

伺服器依「店＋環境」找帳戶；瀏覽器或 API 呼叫端不能指定 merchant ID、callback URL 或帳戶（計畫 §10.1）。

### 1.3 金鑰保存（提議 `commerce_provider_credentials`）

綠界要求 HashKey／HashIV 不得出現在前端 [2858]；計畫要求也不進 Git、模型上下文、技能書與日誌。做法沿用平台既有的封存方式（`modules/identity-membership/totp.ts:44`、`modules/github-social/service.ts:58`：Worker secret 裡的 32-byte 金鑰＋AES-256-GCM＋AAD）：

- 新 Worker secret `COMMERCE_CREDENTIAL_KEYS`：`key_id → 32-byte 金鑰` 的小型 keyring（每個環境各自一組，由 Ted 建立；本機開發用 `.env`，不進 Git；E2E server 每次啟動時隨機產生）。
  - 格式：`<key_id>:<base64>` 以逗號分隔，不含空白；`key_id` 符合 `^[a-z0-9][a-z0-9_-]{0,31}$`；每把是剛好 32 bytes 的標準 base64（重新編碼必須得到同一字串）；1～8 把、ID 不重複。
  - 第一把封存新資料，每一把都能解封。
  - 沒有設定或是空字串：帳戶與金鑰的寫入回 503 `commerce_credentials_unavailable`，讀取照常。有值但格式錯誤：就緒失敗，錯誤訊息不含值的任何部分。
- 每列：`account_id`、`purpose`（`payment`／`logistics`／`invoice`，綠界三種服務各有自己的金鑰 [2853]）、`credential_version`、`key_id`、`sealed`（nonce‖tag‖ciphertext，內容是 `{hash_key, hash_iv, credit_check_code?}`）、建立時間、`retired_at`。
- AAD＝`freedom.commerce-provider-credential.v1:{account_id}:{purpose}:{environment}:{credential_version}`，換帳戶、換用途或換環境都無法解密。
- 只有 provider adapter 在需要簽章的當下解密，明文只留在記憶體；任何 DTO、journal、outbox、錯誤訊息、日誌都不含明文或可逆片段。設定頁只顯示「已設定（更新於…）」，不回顯任何字元。
- 換金鑰＝新增一個 `credential_version`；舊版本保留到使用它建立的 attempt、退款與查詢全部結束才 `retired`（綠界在換金鑰之前建立的交易，通知仍用舊金鑰簽章）。
- 換 Worker 金鑰（key rotation）＝新 `key_id` 重新封存所有列，再移除舊 key；有測試證明兩把 key 並存期間都能解。重新封存只回數量；被換下的 key 離線保管到最後一份用到它的備份到期（EC-SPEC-10 §4.3）。
- 帳戶與金鑰命令的冪等紀錄（`scoped_command_receipts` 存請求內容的雜湊）不能含金鑰。命令交給 receipt 的內容以 `credential_fingerprint` 代替 `hash_key`、`hash_iv`、`credit_check_code`：以 keyring 第一把衍生的 HMAC 金鑰（`HMAC-SHA256(key, "freedom.commerce-credential-fingerprint.v1")`）對 `[account_id, purpose, profile, hash_key, hash_iv, credit_check_code 或 null]` 的 JSON 計算 HMAC-SHA256。同一個 `Idempotency-Key` 與同一組金鑰重送回原結果；金鑰不同回 409。兩次請求之間換了 keyring 第一把，重送也回 409。
- sandbox 用綠界公開的 stage 測試帳號（AIO `3002607` [2856]）時，一樣走這條封存路徑，不設特殊程式分支。

`credit_check_code`（信用卡商家檢查碼 [2856]）只有 API 退款需要（§7.3）；商家沒填時退款只能走人工紀錄。

### 1.4 開通與驗證

- 店的 owner 或 admin 在 Seller Console「收款設定」（EC-SPEC-01 §7.5 的 payments）輸入特店編號與金鑰，並重新輸入密碼（EC-SPEC-09 §2.2）；儲存即封存，付款服務 `draft`。帳戶、金鑰與服務狀態的其他改動（換金鑰、換特店、啟用、停用、退役）同樣只限 owner／admin 並重新輸入密碼。
- 付款服務 `draft → active` 需要一筆成功的驗證付款。owner 或 admin 在「收款設定」發起（同樣重新輸入密碼），平台建立一個種類 `service_activation` 的 attempt：固定 10 元（一個常數，可調整），經同一個交接頁（§4.1）送到綠界，款項付進商家自己的特店帳戶。平台不退這筆款，商家可在綠界後台自行退刷。sandbox 用 stage 測試卡付（§11 的 stage 層）；live 是 §11 的受控小額試付，每次由 Ted 授權。啟用的證據是伺服器對伺服器查詢確認這筆付款（§5.5）；只有已驗證的通知不會啟用。同一個帳戶同時只能有一筆進行中的驗證付款（已交接且在確認窗內，或已付款待確認）。在完成之前，店家的結帳開關（EC-SPEC-02 §2.3、EC-SPEC-10 §4.5）不能打開。
- 付款服務 `suspended` 後：不建立新 attempt；已建立的 attempt 照常接收通知、查詢與退款（在途責任不因停用消失，EC-R56）。
- `draft → active` 不是 HTTP 命令：驗證付款的 attempt 成為 `confirmed` 時，付款工作在同一個交易呼叫內部的啟用函式（記下啟用時間，證據參考是該 attempt）。同一間店、同一環境、同一 profile 同時只能有一個 `active` 服務：
  - 發起驗證付款時，同店、同環境、同 profile 已有別的帳戶的 `active` 服務，回 409 `provider_service_conflict`（「商店已有相同設定檔的啟用服務。」）。換特店＝先停用（或退役）舊服務，再驗證新帳戶；停用期間不建立新付款，商家宜選離峰時間。平台不會自動停用任何服務（2026-10-16 定案，見 decisions.md）。
  - 確認時服務已不是 `draft`（例如已被退役），或同組已有別的 `active` 服務（在發起之後才恢復或啟用），就只確認付款、不啟用：付款事實與 `confirmed` 照常保存，服務留在 `draft`。商家停用另一個服務之後，再做一次驗證付款。
  - 啟用函式在 savepoint 內執行。它因上面兩種情況回 409（`provider_service_state`、`provider_service_conflict`）時，只退回到 savepoint，付款事實不跟著回滾；其他錯誤照常讓整個交易失敗。
- 換金鑰不改服務狀態，新的 `credential_version` 立即生效。填錯的金鑰要到下一次簽章才發現：綠界拒絕用它簽出的付款表單，通知與查詢也驗證失敗。
- 儲存金鑰時不以伺服器對伺服器的查詢驗證（2026-10-16 依 wp04-payments 的建議定案）：只檢查格式並封存；在本機算出簽章也不算驗證。首次的金鑰由上面的驗證交易證明。換金鑰後，一個版本是否已驗證，只看有沒有由它驗證成功的付款事件（`commerce_hosted_payment_events.credential_version`）；還沒有的版本，Seller Console 標示「尚未經綠界驗證」。

## 2. 首發 profile：`ecpay.aio.credit.v1`

| 項目 | 規則 | 來源 |
| --- | --- | --- |
| 付款方式 | 全方位金流導轉、信用卡一次付清：`ChoosePayment=Credit`、`PaymentType=aio`、`EncryptType=1` | [2862][2866] |
| 不開 | 分期（`CreditInstallment`）、圓夢分期、定期定額、紅利（`Redeem`）、記憶卡號（`BindingCard`）、ATM／超商代碼／條碼（DC05）、Apple Pay、TWQR、BNPL | DC05；這些各有退款或期限規則，另立 profile |
| 幣別與金額 | 只收 TWD。terms 裡每一個金額——行項單價、折扣分攤後的行項淨額、每個配送群組的運費、總額——都必須是整數元（100 的倍數，`100 minor = 1 元`；terms 的 `settlement_unit_minor = 100`，EC-SPEC-02 §3），總額 5～999,999,999 元，`TotalAmount = total_minor / 100`。不合就**不提供**這個付款方式（結帳時 409 `payment_profile_unavailable`，原因 `currency_not_supported`、`amount_not_whole_twd`、`amount_below_minimum` 或 `amount_above_maximum`），adapter 不做四捨五入或截尾。上限是 adapter 讀得回來的金額：付款通知、交易查詢與授權明細的金額欄位最多 9 位數，所以付款表單、查詢與退款也不送更大的金額，同一個上限（`MAX_CREDIT_AMOUNT_MINOR`）用在每一處。只檢查總額不夠：退刷的 `TotalAmount`、發票的 `SalesAmount` 與折讓的 `AllowanceAmount` 也都是整數元，行項或運費有零頭時，部分退款與折讓就無法精確對到行項（EC-SPEC-06 §2.5、§3.5） | [2862]（整數新臺幣、信用卡最低 5 元）[2885][7896][7901]；計畫 §9.2；上限是 adapter 的解析範圍（`aio-credit/profile.ts`） |
| 商家單筆上限 | 由綠界依合約與卡片額度決定，文件沒有固定值；超過時綠界拒絕，attempt 記 `failed` 並顯示原因。這和上一列的 999,999,999 元不同：那是平台送得出、讀得回的範圍，這是商家的額度 | [2862] |
| 確認窗 | attempt 建立後 60 分鐘（§6.2）。窗內未確認付款不取消訂單 | [2887][2890] |
| 退款 | 正式環境以 `CreditDetail/DoAction`；stage 不提供，sandbox 只能人工紀錄（§7） | [2885] |
| 需要額外付款資訊 | `NeedExtraPaidInfo=Y`，為了取得授權單號 `gwsr`（退款前查詢清算狀態要用） | [5675][2894] |

銀行匯款與面交付款不是 PaymentPort 的 provider：沒有 attempt、通知與查詢，由店家確認收款（EC-SPEC-11）。

## 3. 資料模型與 PaymentPort

### 3.1 表（M2；`169` 已建立前五列；`commerce_refunds`、`commerce_refund_lines` 由 wp04-seller 加入，`commerce_payment_operations` 由 wp04-refund-api 加入；M1 是 EC-SPEC-03 的交易核心）

| 表 | 用途 | 規則 |
| --- | --- | --- |
| `commerce_provider_accounts`、`commerce_provider_account_services` | §1.2 | tenant RLS；物流與發票共用 |
| `commerce_provider_credentials` | §1.3 | tenant RLS；只有 adapter 讀；不可刪（只能 `retired`） |
| `commerce_payment_attempts` | 一次交給 provider 的付款 | 每張訂單可有多個；收款服務的驗證付款（§1.4）也是 attempt：種類 `service_activation`、沒有訂單、每個帳戶各自編號；`merchant_trade_no` 在 (provider, environment, merchant_id) 內不分大小寫唯一；金額、幣別、帳戶、`credential_version` 建立後不可改；狀態只能依 §3.3 前進 |
| `commerce_hosted_payment_events` | 已驗證的 provider 通知、查詢結果與瀏覽器返回（inbox） | append-only；去重鍵唯一（§5.4）；不存卡號片段與原始 body，只存允許欄位與原始 body 的 SHA-256。名稱避開既有的 `commerce_payment_events`（migration 055）：那是匯入商店由商家後台回報的付款紀錄，兩者不共用 |
| `commerce_due_work` | 到期工作（EC-SPEC-09 §2.4）：付款查詢、確認窗結束；之後的里程碑加入其他種類 | 每個目標每種一列；`due_at`、租約（`lease_until`）、次數、連續未確定次數、封閉錯誤碼。查詢唯讀、可以重試（§6.3），所以不經 outbox：取得租約的交易提交後才呼叫，結果用新交易寫回，只有已驗證的回應寫成事件 |
| `commerce_payment_operations` | 有外部效果、結果不明時不能重送的工作（outbox）：API 退款的步驟（§7.3）；人工紀錄不用 | `pending → in_flight → done／failed／unknown`；`not_before`、租約（`lease_until`）、嘗試次數、錯誤碼；外部呼叫只在租約交易提交後進行 |
| `commerce_refunds` | 退款 | §7；豁免 RLS（`commerce_profile_participant_acl`）：不含個資，只有金額、日期、格式受限的參考號、principal 與付款 ID，日後的機器路徑（API 退款）綁定 tenant 前也能讀；append-only；累計上限由 trigger 依套用紀錄檢查。M2 只有人工紀錄（§7.2）：`basis='unapplied_payment'`、`mode='manual_record'`、`state='recorded'`，M4 再放寬 |
| `commerce_refund_lines` | 每筆退款分到哪些行項與運費（EC-SPEC-06 §2.5） | 豁免 RLS、append-only；提交時檢查每筆退款至少一列、各列合計＝退款金額（deferred trigger）。M2 只有 `unapplied` 列；`item`、`shipping` 與同一行項、同一配送群組的累計上限 trigger 隨 M4 的售後加入 |

訂單的付款摘要（EC-SPEC-03 §3.2：`unpaid`、`pending`、`paid`、`partially_refunded`、`refunded`、`overpaid`、`simulated`）由這些表讀取時計算，不另存。`overpaid` 的定義和優先順序也在 EC-SPEC-03 §3.2。

### 3.2 PaymentPort（介面，名稱可收斂）

```ts
interface PaymentPort {
  profile: 'ecpay.aio.credit.v1';
  createAttempt(order: OrderPaymentView, account: AccountRef): Promise<HandoffForm>;     // 不呼叫外部；產生簽章後的表單欄位
  queryAttempt(attempt: AttemptRef): Promise<QueryOutcome>;                              // QueryTradeInfo/V5
  verifyNotification(raw: RawCallback, account: AccountRef): Promise<VerifiedNotification>;
  cancelOrVoid(attempt: AttemptRef): Promise<OperationOutcome | Unsupported>;            // stage 一律 Unsupported
  refund(refund: RefundRef): Promise<OperationOutcome | Unsupported>;
  queryRefund(refund: RefundRef): Promise<RefundQueryOutcome | Unsupported>;
  reconcile(range: DateRange): Promise<Unsupported>;                                     // C2 以逐筆查詢對帳（§8）
}
```

- 不支援的能力回明確的 `Unsupported`，不假裝成功（計畫 §10.1）。
- adapter 是純函式＋單一 HTTP client（10 秒逾時、只連該環境的官方主機、`redirect: 'manual'`）；簽章與編碼的純函式放在 provider 協定程式庫（§10），由向量測試證明在 Node 與 workerd 結果一致。
- `QueryOutcome`、`VerifiedNotification` 都是判別聯集，呼叫端不能把 `unknown` 當成其中任何一種。查詢沒有獨立的「查無此單」結果：綠界文件沒有列出它的狀態碼，解析器把它和其他無法辨識的狀態一樣回 `unknown`，並保留原始狀態碼供人工核對（§6.2）。

### 3.3 attempt 狀態

| 狀態 | 意義 | 進入 |
| --- | --- | --- |
| `issued` | 表單已產生；買家可能還沒送出或還在綠界頁面 | 建立 |
| `paid` | 已驗證的通知或查詢顯示付款成功，金額相符 | 任何未付狀態（付款事實永不丟棄，含晚到） |
| `confirmed` | `paid` 且伺服器對伺服器查詢也確認（§5.5） | `paid` |
| `failed` | 已驗證的失敗通知，或查詢回 `10200095` | `issued`、`superseded` |
| `superseded` | 買家改用新的 attempt；仍持續查詢到確認窗結束 | `issued` |
| `expired_unpaid` | 確認窗結束後確定沒有付款：窗結束後的查詢回 `TradeStatus=0`，或從未交接（§6.2）。結果不明的 attempt 不進這個狀態 | `issued`、`superseded` |

- `paid`／`confirmed` 之後不會退回未付；之後的退款是 `commerce_refunds` 的事。
- 已付款的 attempt 之後又來一筆矛盾的失敗通知：保留事件、不改狀態、建立例外（§5.6）。
- 同一張訂單有兩個 attempt 都 `paid` → 第二筆的付款套用記為 `overpaid`（EC-SPEC-03 §5），自動建立退款待辦。

### 3.4 MerchantTradeNo 與送出內容

- `MerchantTradeNo`：`F` ＋ 19 個 Crockford Base32 大寫字元（95 bits 隨機），共 20 字元、只含英數字 [2862]。綠界不分大小寫判斷重複 [2862]，大寫字母表本身就避開這個問題；stage 測試帳號是公開共用的，隨機值也避免和其他開發者撞號。DB 唯一索引防自己撞號；撞到就重抽。
- `MerchantTradeDate`：Asia/Taipei 時間 `yyyy/MM/dd HH:mm:ss`。
- `ItemName`：`{商品名} x{數量}` 以 `#` 連接。名稱先把 `#`、`<`、`>`、`|`、`;`、反引號、控制字元（C0、DEL、C1）、落單的 surrogate 與看不見的格式字元（U+200B～U+200F、U+202A～U+202E、U+2060～U+206F、U+FEFF）換成空白，再把連續空白縮成一個、去掉頭尾；清完是空的就用「商品」。`|`、`;`、反引號會被綠界 CDN 的指令過濾擋下 [2858]；看不見的字元可能在綠界頁面上偽裝商品名。合計超過 200 個 UTF-16 字元時改用 `{店名}商品一批 x1`（店名同樣清理、最多 40 字；清完是空的就是 `商品一批 x1`）。綠界在 400 字元處截斷，截到多位元組字元會讓 CheckMacValue 失敗 [61944]，所以留足空間。
- `TradeDesc`：`Freedom order {display_number}`（不含特殊字元 [2862]）。
- `ReturnURL`、`OrderResultURL`、`ClientBackURL`：§4、§5 的固定路徑，HTTPS、網域、443，路徑不含 `&` 或 `<` [2858][61944]；由伺服器依環境組出。
- `PlatformID`、`CustomField1～4`、`StoreID`、`Language`：不送（欄位省略）。

## 4. 買家交接（瀏覽器）

### 4.1 交接頁

- 下單（EC-SPEC-02 §5.4）或「重新付款」（§4.3）產生 attempt，回傳 `handoff_url = /pay/ecpay/{handoff_token}`。`handoff_token` 是 256-bit 隨機值、只存雜湊、只對這個 attempt 有效、15 分鐘到期。
- Worker 對這個路徑回一個極小的 HTML：一個 `method="POST"` 的表單，action 是該環境的 `AioCheckOut/V5` [2862]，欄位含 CheckMacValue（這是簽章，不是金鑰）。同源的外部 script 在 `load` 後自動送出一次；不用 `target="_blank"`、不放 iframe（iOS 內嵌瀏覽器會擋 [2862][61944]）。
- 按鈕一律是「前往綠界付款」，至少 44 px，可用鍵盤操作：
  - `<noscript>` 裡的按鈕立即顯示。
  - 有 script 時，停留 10 秒後才顯示按鈕與「如果畫面一直沒有變化，請按「前往綠界付款」。」。網路慢時第一次 POST 可能還在進行；太早出現的按鈕會讓同一個 `MerchantTradeNo` 送出兩次。按下後立即停用、只送出一次。
  - 從綠界頁按上一頁回到這頁（`pageshow` 的 `persisted`）時不再送出：隱藏表單與按鈕，顯示「已前往付款頁。要重新付款，請回到訂單頁。」與連結「返回訂單」（`/pay/ecpay/back/{attempt_id}`，§4.2）。
- 這個路徑的 CSP 例外：`form-action` 只加上該環境的綠界主機（`https://payment-stage.ecpay.com.tw` 或 `https://payment.ecpay.com.tw`），沿用 `platformContentSecurityPolicy(path)` 依路徑加表單目的地的做法（`apps/platform-api/src/platform-app.ts:146`）。其他頁面不放寬。SPA 用 hash 路由，CSP 只能依 HTTP 路徑區分，所以必須是獨立路徑。
- token 到期後再開：頁面顯示「付款連結已失效或不存在。」；找得到 attempt 時附「返回訂單」連結。
- 只有訂單 `open`、hold 仍有效、attempt 仍是 `issued` 且還沒交接時才交接；`handed_off_at` 提交之後才回付款表單。條件不符就顯示對應的頁面，token 不消耗；hold 已到期時顯示「付款期限已過，保留的商品已釋出。」（與 B07 相同）。hold 到期後不再交接，所以確認窗結束時還沒交接的 attempt 之後也不會付款（§6.2）。

### 4.2 回到商店

- `ClientBackURL`＝`/pay/ecpay/back/{attempt_id}`（GET、無付款參數）[2878]：伺服器找到 attempt 後 303 到訂單頁（`/shops/:slug/orders/:order_ref`），沒有其他效果。送給綠界的網址不放商店 slug 與訂單編號：slug 接上路徑可能組出綠界 CDN 的擋字（例如以 `cd` 結尾的 slug 加上 `/` 成為 `cd/`，或含 `echo`），表單產生器會拒絕整張表單（§3.4）。
- `OrderResultURL`＝`/pay/ecpay/return/{account_ref}`：綠界讓瀏覽器以 POST 帶付款結果回來 [2878]。伺服器驗 CheckMacValue（失敗就當沒有資料）、為對應 attempt 排一次查詢（同 attempt 每分鐘最多一次），然後 303 轉到付款返回頁（B06，`/shops/:slug/payment-return/:attempt_ref`，EC-SPEC-01 §3）。
  - 每個 attempt 只記一筆瀏覽器返回；重送同一份已簽章的表單不再新增紀錄。
  - 記錄前先以 `FOR KEY SHARE` 鎖 attempt，再碰到期工作，與通知同一個鎖序（EC-SPEC-03 §6）。否則兩者幾乎同時到達時，會互相等待對方已鎖的列而死結。
  - 瀏覽器返回只是提示：找到 attempt 之後，排查詢或記錄失敗只記固定的錯誤名稱，照樣 303 到付款返回頁。
  - 不回機器文字：表單格式錯誤或簽章不符 303 到首頁；金鑰環不可用時回 503 的錯誤頁「暫時無法確認付款結果，請稍後到訂單頁查看。」；找到 attempt 之前的其他錯誤回 500 的同一頁。這條路徑是請求閘道的例外之一：不檢查 Origin、不要求 JSON，由路由自己檢查表單格式與大小（EC-SPEC-09 §2.6）。**不改任何付款狀態**：瀏覽器返回不是付款證據（計畫 §10.3、EC-AT18）。
- 從綠界頁面送出的跨站 POST 不帶 `SameSite=Lax` 的買家憑證；303 之後的頂層 GET 導覽會帶它，但不帶 `SameSite=Strict` 的會員 session（EC-SPEC-09 §2.6）。所以這個端點不需要也不讀任何 cookie；返回頁的 HTML 不依身分產生，狀態由頁面內的同站 fetch 讀取。
- 付款返回頁顯示「付款結果確認中」並輪詢付款摘要（每 5 秒、最多 2 分鐘，之後改成按鈕「重新查詢」）；確認後帶到訂單頁（B07）。

### 4.3 重新付款

- 綠界不接受重複的 `MerchantTradeNo`，所以一個 attempt 只交接一次（`handed_off_at`）。交接前，同一個 attempt 可以重發交接連結（下單重送、訂單頁的「前往付款」）；交接後要再付款就需要新的 attempt。
- 建立新 attempt 的條件全部成立才行：訂單 `open`、hold 仍有效（EC-SPEC-03 §4.2）、沒有 `paid`／`confirmed` 的 attempt、未滿 5 個 attempt，而且最新的 attempt 確定沒有付款：
  - 它是 `failed`（已驗證的失敗通知，或查詢回 `10200095`）；或
  - 交接已滿 60 秒，這次請求當場做的伺服器查詢（§6）回 `TradeStatus=0`（已建立未付款），而且沒有尚未套用的已付事件、也沒有 `10300066`。
- 結果不明時不建立新 attempt：查詢失敗或逾時、驗證失敗、查無此單或無法辨識的狀態（§6.2 的 `unknown`）、`10300066`、已驗證但尚未套用的付款事件。畫面顯示「付款結果確認中」，買家稍後再查詢（EC-SPEC-01 J04、pages B06）。
- 新 attempt 建立時，前一個 `issued` 改 `superseded`，仍持續查詢到它的確認窗結束；若它後來付款成功，照常套用（另一個也付了就是 `overpaid`）。查詢顯示未付只代表當下，買家可能還停在綠界頁面上送出；`superseded` 讓這種晚到的付款不會遺失，買家也不用等到前一筆的確認窗結束才能換卡（計畫 §10.2）。
- 實作順序：M2 的第一個工作（wp04-payments）只建立第 1 個 attempt 與重發交接連結。wp04-queries 讓同一個「前往付款」端點（`POST …/orders/:order_ref/payment-handoffs`）在最新 attempt 不能再交接時判斷重新付款，需要時當場查詢；頁面不必分辨兩者。不能建立新 attempt 時回 409：`payment_result_pending`（交接未滿 60 秒時帶 `Retry-After`）、`payment_attempts_exhausted`、`payment_already_applied` 或 `checkout_hold_expired`。
- 每張訂單最多 5 個 attempt；超過回 409，請買家聯絡商家。
- hold 已過期：不在舊單上重新付款，回到 checkout 重新下單（EC-SPEC-03 §4.3）。

## 5. 付款通知（ReturnURL）

### 5.1 路徑與入口規則

- `POST /api/v1/provider-callbacks/ecpay/{account_ref}/payment`。只接受這個確切路徑與方法，比照 `isMaintainerWebhookPath`（`apps/platform-api/src/routes/repo-maintainer.ts:19`）跳過 JSON、Origin、CSRF 與 session 規則；其他規則照常。
- `account_ref` 是帳戶的不透明 ID，只用來找金鑰；帳戶的身分仍以通知內容驗證（§5.2）。格式是 26 個小寫 Crockford Base32 字元（128 bits 隨機），存在 `commerce_entry_routes`（EC-SPEC-09 §2.4），建立帳戶時一起產生。
- 公開不等於免驗證（計畫 §10.3）。staging 在 Cloudflare Access 之後：這個路徑必須在 Access 設定中排除，否則綠界會收到 302 而一直重送。這是 Ted 的基礎設施變更（EC-SPEC-10 §4.4）；本機沒有公開網址，只能靠查詢。
- `Content-Type` 必須是 `application/x-www-form-urlencoded` [2878]；body 上限 16 KiB；重複的參數名一律拒絕；參數名必須是 ASCII 英數與 `_`。

### 5.2 驗證順序

1. 依 `account_ref` 找帳戶；找不到 → 404，不洩漏原因。
2. 以帳戶的 `payment` 金鑰（依 attempt 的 `credential_version`；不知道 attempt 時依序試目前與未退役的舊版本）重算 CheckMacValue：收到的**全部**欄位（含空值、含 `NeedExtraPaidInfo=Y` 的額外欄位）除了 CheckMacValue 本身，依參數名不分大小寫排序，前後加 HashKey／HashIV，.NET 規則 URL 編碼、轉小寫、SHA-256、轉大寫 [2902][2904]。以 constant-time 比較。不得把 form 轉成 JSON 或重新排版後再算（計畫 §10.3）。
3. `MerchantID` 等於帳戶的特店編號；`PlatformID` 為空或缺。
4. `MerchantTradeNo` 與 `TradeNo` 先轉大寫（CheckMacValue 在雜湊前整串轉小寫，大小寫不受簽章保護；我們的編號只用大寫），再依 (帳戶, `MerchantTradeNo`) 找 attempt；找不到 → 記 `unmatched` 事件、建立例外、回 `1|OK`（簽章正確代表確實是這個特店的交易，重送也不會找到）。
5. `TradeAmt` 等於 attempt 金額（整數元）；不符 → 付款套用記 `amount_mismatch`、例外、回 `1|OK`。
6. `SimulatePaid=1` → 記 `simulated` 事件，**不**改 attempt、不套用庫存、不建立履約；即使 `RtnCode=1` 也一樣 [2878]（EC-AT19）。
7. `RtnCode=1` 且 `SimulatePaid=0` → attempt `paid`；`RtnCode` 為其他值 → `failed`（若 attempt 尚未付款）。`10300066`（結果待確認，勿出貨 [2878]）視為未決：attempt 維持原狀並排查詢。

### 5.3 交易順序與回應

- 一個 DB 交易：寫入事件（去重）→ 鎖序 EC-SPEC-03 §6 → 改 attempt → 呼叫 `applyConfirmedPayment`（EC-SPEC-03 §5，`payment_ref = attempt_id`）→ 排確認查詢 → commit。
- **提交成功後**才回 `1|OK`（純文字、HTTP 200、無引號空白 [2878]）。提交失敗回 500 `0|error`，讓綠界重送（隔 5～15 分鐘、當天最多 4 次 [2878]）。超過限流回 429 `0|limited`（帶 `Retry-After`）；金鑰環不可用回 503 `0|unavailable`；兩者綠界都會重送。
- 驗證失敗（簽章、商家、格式）回 400 `0|invalid`，只記錄計數與帳戶，不存 body。

### 5.4 去重與亂序

- 事件去重鍵：(帳戶, `MerchantTradeNo`, `TradeNo`, `RtnCode`, `SimulatePaid`, `PaymentDate`)，編號用 §5.2 轉大寫後的值，改了大小寫的重送仍是同一筆。重送命中唯一鍵 → 不重複套用，直接回 `1|OK`。
- 付款套用以 `payment_ref` 冪等（EC-SPEC-03 §5）：同一 attempt 的通知與查詢結果先後到達，只套用一次。
- 通知與 `OrderResultURL` 沒有固定先後 [2878]；查詢與通知也可能交錯。狀態只依 §3.3 前進，不倒退（EC-AT21）。
- 通知與保留到期結算、買家取消、另一筆通知同時發生：全部走同一組鎖，先提交者勝（EC-SPEC-03 §6；測試見 §12）。
- 同一 attempt 的通知事件依（`received_at`, `event_id`）的順序套用。較早的事件還沒套用時（例如隔離期間延後的事件），新事件只寫入收件匣、照樣回 `1|OK`，由排程依序補套用。否則延後的 `failed` 會晚於後到的 `paid` 套用，開出不實的 `contradicting_event`。
- 補套用時，一筆事件套用失敗只記固定的錯誤名稱與事件 ID，並略過同一 attempt 後面的事件；其他 attempt 照常處理。

### 5.5 確認查詢與出貨門檻

- 通知簽章是商家金鑰產生的；若金鑰外洩，偽造的「已付款」通知也會驗證成功。因此：
  - 已驗證的通知足以讓 attempt `paid` 並保護庫存（convert／allocate）。
  - **出貨前**還需要伺服器對伺服器的 `QueryTradeInfo/V5` 回 `TradeStatus=1` 且金額、`TradeNo` 相符，attempt 才 `confirmed`；履約單只在 `confirmed` 後才能交寄（EC-SPEC-05 §4）。綠界也要求收到通知後呼叫查詢驗證 [2887]。
- 確認查詢在通知交易提交後立即排入；查詢失敗依 §6.3 重試。60 分鐘後仍無法確認，或查詢明確顯示未付 → 例外 `payment_unconfirmed`：賣家看到「付款待確認，請勿出貨」，可選擇再查詢、聯絡綠界或取消並釋放配置；系統不自動釋放庫存。

### 5.6 例外

付款相關例外都進 EC-SPEC-05 的 ExceptionCase（同一個工作台）：`unmatched_payment`、`amount_mismatch`、`paid_unallocatable`、`paid_after_cancel`、`overpaid`、`payment_unconfirmed`、`contradicting_event`。`payment_unconfirmed` 有兩種來源：已付款但查詢無法確認（§5.5），以及確認窗後 24 小時仍查不出結果的未付 attempt（§6.3）。每個例外有責任人（賣家）、下一個合法動作與期限，不只顯示「請聯絡客服」。

M2 的處理（wp04-seller）：賣家在 `GET …/exception-cases?view=retailer`（`store:orders:read`）看本店的付款例外，動作走 `POST …/exception-cases/:id/actions/:action`（`store:orders:manage`，EC-SPEC-05 §9.1）。`169` 的 CHECK 要求結案者是一個人，所以付款例外只由賣家的動作結案，包括登錄退款時的自動結案；排程、查詢與付款通知都不結案。

| 種類 | 下一個合法動作 | 結案 |
| --- | --- | --- |
| `amount_mismatch`、`paid_after_cancel`、`overpaid` | 在綠界後台退款，再登錄人工退款（§7.2）。`amount_mismatch` 的訂單沒有確認付款時不會自己結束，另用未付款取消 | 退款合計等於套用金額時自動結案（`refunded`）；登錄的金額有誤、合計到不了時用 `resolve_with_evidence`（`refunded`） |
| `paid_unallocatable` | 補貨後 `retry_allocation`（EC-SPEC-03 §5.3）；不補貨的已付款取消與退款隨 M4（EC-SPEC-06 §2.4） | `retry_allocation` 成功時同一個交易結案（`allocated`） |
| `payment_unconfirmed` | 立即查詢；到綠界後台核對 | `resolve_with_evidence`：`confirmed`（attempt 已 `confirmed`）或 `checked_with_provider` |
| `unmatched_payment`、`contradicting_event` | 到綠界後台核對 | `resolve_with_evidence`（`checked_with_provider`） |

`resolve_with_evidence` 只收結案代碼、綠界後台的日期（Asia/Taipei，不晚於今天）與參考號（`^[A-Za-z0-9_-]{1,64}$`），不收自由文字；`resolution_note` 由伺服器用固定格式組成：`refunded` 是「店家已在綠界後台退款（{日期}，參考號 {參考號}）。」，`checked_with_provider` 是「店家已在綠界後台核對（{日期}，參考號 {參考號}）。」，`confirmed` 是「付款已向綠界確認。」；`retry_allocation` 成功時是「補貨後已重新配貨。」，登錄退款的自動結案是「店家已登記全額退款。」（§7.2）。代碼 `confirmed` 不需要日期與參考號，由伺服器確認 attempt 已 `confirmed`。案件一律最後鎖（訂單、attempt、套用紀錄之後）：付款路徑持有 attempt 時會開例外，`INSERT … ON CONFLICT` 要等正在結案同一主體的交易，順序相反就會死結。付款其實沒有完成、訂單卻已確認付款時的取消，隨 M4 的已付款取消。

## 6. 查詢（QueryTradeInfo/V5）

### 6.1 觸發

| 觸發 | 時間 | 限制 |
| --- | --- | --- |
| 通知之後的確認查詢 | 立即：回應送出後，在同一個請求的背景執行；排程是後備 | §5.5 |
| 瀏覽器返回 | 立即（同上） | 同 attempt 每分鐘 1 次 |
| 買家或賣家按「查詢付款結果」 | 請求當場 | 同訂單每分鐘 1 次、每小時 10 次 |
| 重新付款（§4.3） | 請求當場 | 與「查詢付款結果」共用同訂單的限額 |
| 排程 | attempt 建立後 10、20、40、60 分鐘 | 只查已交接的 attempt；結果確定（`confirmed`、`failed`、`expired_unpaid`，或 §6.2 的金額不符與 `TradeNo` 不符）後停止。綠界建議付款 10 分鐘後查、或建立 40 分鐘後查 [2887][2890] |
| 確認窗結束 | attempt 建立後 60 分鐘 | 已交接的 attempt 立即查詢；從未交接的不查詢，直接 `expired_unpaid`（§6.2）；已有金額或 `TradeNo` 不符的 attempt 不查詢，狀態也不變 |

### 6.2 結果對應

| 查詢結果 | 處理 |
| --- | --- |
| `TradeStatus=1`、金額與 `TradeNo` 相符 | `paid`（若尚未）→ `confirmed` |
| `TradeStatus=1` 但金額不符 | 和通知相同（§5.2 第 5 點）：以實付金額記付款套用 `amount_mismatch`，開 `amount_mismatch` 例外；attempt 狀態不變。驗證付款（§1.4）沒有訂單，只開例外 |
| `TradeStatus=1` 但 `TradeNo` 和這個 attempt 已記下的不同 | `contradicting_event` 例外，不記付款套用（不知道錢屬於哪一筆交易） |
| `TradeStatus=0`（已建立未付款） | 不變；確認窗結束後的查詢仍是如此 → `expired_unpaid` |
| `TradeStatus=10200095`（未完成付款、交易失敗） | `failed` |
| 查無此單、或無法辨識的回應 | 記為 `unknown`，attempt 不變；確認窗結束後仍是如此 → 不改狀態、不取消，依 §6.3 繼續查詢 |

- 查詢到的金額不符或 `TradeNo` 不符，以及付款通知的金額不符，都是確定的結果：之後不再排查詢，確認窗結束時不查詢、也不改成 `expired_unpaid`，例外結案後也不重開。訂單沒有確認付款時不會自己結束，由賣家用未付款取消並登錄退款（§5.6）。
- 查詢回應同樣以 SHA-256 CheckMacValue 驗證 [2890]；驗證失敗當 `unknown`。
- 請求的 `TimeStamp` 3 分鐘內有效 [2890]：送出前才產生，不重用；重試時重新簽章。
- 從未交接的 attempt（`handed_off_at` 為空）不查詢：已簽章的付款表單只在交接時送到瀏覽器，hold 到期後也不再交接（§4.1），綠界不會有這筆交易；確認窗結束時直接 `expired_unpaid`。
- 訂單 `open`、沒有確認付款（EC-SPEC-03 §5），而且所有 attempt 都是 `failed` 或 `expired_unpaid` → 訂單 `cancelled(payment_not_completed)`（EC-SPEC-03 §3.3）。只要還有 attempt 結果不明，就不取消。之後若仍有真實付款到達（例如商家在綠界後台補觸發通知 [2878]），照 EC-SPEC-03 §5.3 記 `paid_after_cancel` 並退款。

### 6.3 呼叫規則

- 只在取得到期工作（`commerce_due_work`）租約的交易提交後呼叫；結果用新交易寫回（計畫 §10.2、EC-R20）。等待綠界時不持有交易或列鎖。傳輸失敗、非 200、回應超過 64 KiB 或驗證失敗都不寫事件，只在到期工作列記封閉錯誤碼並退避。
- 請求用目前的金鑰版本簽章；回應用所有未退役的版本驗證，事件記下驗證成功的版本。查詢不寫外部效果日誌：EC-SPEC-10 §8.2 只記對外效果，查詢不改變綠界的任何狀態。
- 查詢不要求付款服務 `active`，也不要求 profile 在清單內（EC-SPEC-09 §2.5、EC-SPEC-10 §5.1）；隔離模式時不查詢（EC-SPEC-10 §8.3）。
- HTTP 403 → 同帳戶付款服務列的 `throttled_until = now + 30 分`，這個帳戶的付款查詢與操作延後；物流與發票不受影響（EC-SPEC-09 §4）[2890]。
- 逾時或網路錯誤 → 指數退避（1、2、5、10 分，之後每 10 分）重試；確認窗結束後結果仍是 `unknown`，也照這個間隔繼續查詢。最多查到確認窗後 24 小時；仍沒有確定結果就停止自動查詢，開例外 `payment_unconfirmed`，賣家可再查詢、到綠界後台核對這筆 `MerchantTradeNo`，或取消訂單（之後到達的真實付款照 EC-SPEC-03 §5.3 處理）。
- 已付款但還沒 `confirmed` 的 attempt 依同樣的退避持續查詢，到付款後 24 小時為止；付款後 60 分鐘仍未確認，就開 `payment_unconfirmed`（§5.5）。
- 查詢是唯讀，可以安全重試；退款不行（§7.4）。

## 7. 退款

### 7.1 何時需要退款

賣家同意的已付款取消（EC-SPEC-03 §3.3）、`paid_after_cancel`、`overpaid`、`paid_unallocatable` 決定不補貨、售後（EC-SPEC-06）。退款金額連到原行項、折扣分攤與運費（計畫 §9.2、§10.4；分攤規則在 EC-SPEC-06 §2.5）。

M2 只處理沒有套用到訂單的付款（以下稱未套用的付款）：套用結果是 `overpaid`、`after_cancel`（例外 `paid_after_cancel`）或 `amount_mismatch` 的付款（EC-SPEC-03 §5）。這些錢不屬於訂單的任何行項，要整筆退回。已付款取消、`paid_unallocatable` 決定不補貨與售後的退款，隨 M4 的售後申請建立（EC-SPEC-06 §2.4、§2.6）。

### 7.2 退款紀錄（提議 `commerce_refunds`）

- 欄位：`refund_id`、`order_id`、`attempt_id`（退哪一筆付款）、`amount_minor`、原因、依據（取消、RMA、例外、爭議扣回；爭議扣回只能是 `manual_record`，EC-SPEC-07 §7）、申請者、核准者、`mode`（`provider_api`／`manual_record`）、狀態、provider 參考、建立時間、`version`。
- 狀態：`requested → approved → submitted → confirmed／failed`；`submitted` 之後結果不明 → `unknown`，只能靠查詢或人工證據離開。`manual_record` 直接 `recorded`（附商家在綠界後台的退款日期、金額、參考號）。
- 上限 trigger：同一 attempt 所有非 `failed` 退款的合計 ≤ 該 attempt 的已付款金額（EC-AT22）。
- 每筆退款都有分攤列（`commerce_refund_lines`：`item`／`shipping`／`unapplied`，EC-SPEC-06 §2.5）；行項與運費的累計上限跨 attempt 計算，所以並行申請先鎖訂單、再鎖 attempt（EC-SPEC-03 §6）。

M2 的範圍（wp04-seller）：

- 只有 `manual_record`，直接 `recorded`；記錄後不能改（記錯時的更正方式見 §13）。
- 每筆退款連到一筆未套用的付款：`commerce_checkout_payment_applications` 的一列（`payment_ref` 是 attempt），以及它開出的例外（`overpaid`、`paid_after_cancel`、`amount_mismatch`）。確認付款（`converted`、`allocated`、`unallocatable`）與 `simulated` 不能在 M2 退款。
- 上限：同一筆套用紀錄所有未失敗退款的合計 ≤ 該紀錄的金額，由 trigger 檢查。`amount_mismatch` 的 attempt 狀態不變，它的 `amount_minor` 是應付而不是實付，所以上限一律用套用紀錄的金額，也就是已驗證的實付金額。
- 分攤列只有一列 `unapplied`，金額等於退款金額；檢查用 `checkUnappliedRefund`（`payments/rules/unapplied.ts`）。
- 人工紀錄附綠界後台的退款日期（Asia/Taipei，不早於付款日期、不晚於今天）與選填的參考號；不收自由文字，避免個資。
- 合計等於套用紀錄的金額時，同一個交易把那筆例外結案：`resolved`、`resolution_code='refunded'`，結案者是記錄的人；`resolution_note` 用固定文字「店家已登記全額退款。」（`169` 的 CHECK 要求結案時附說明）。
- 記錄需要 `store:refund`（owner／admin 本來就有），讀取需要 `store:finance:read`。隔離模式時回 503 `commerce_quarantined`（EC-SPEC-10 §8.3）。
- sandbox 的人工紀錄在畫面標示「商家自行退款（平台未經綠界確認）」（§7.5）。
- 權限：只有店的 owner／admin 或有 `store:refund` 的成員能建立與核准（EC-SPEC-09 §2.2）；供應商不能退他店訂單（計畫 §4.1）。
- 已交寄的包裹不會因退款被撤回；退款也不代表商品已回庫（EC-SPEC-05、06）。

### 7.3 綠界 API 退款（只限正式環境）

§7.3～§7.4 由 wp04-refund-api 實作，在 C2 受控試用排定時開始；在那之前只有人工紀錄（§7.5）。

`CreditDetail/DoAction` 在 stage 不可用 [2885]。正式環境依目前清算狀態選擇動作；狀態先以 `CreditDetail/QueryTrade/V2`（需要 `gwsr`、金額與商家檢查碼）讀取 [2894]：

| 清算狀態 | 全額退款 | 部分退款 |
| --- | --- | --- |
| 已授權（未關帳） | `N`（放棄授權，一律全額） | 先 `C` 關帳，再 `R` |
| 要關帳 | `E`（取消關帳）＋`N` | `R` |
| 已關帳 | `R` | `R` |

- 只有一般一次付清可以部分退刷 [2885]；本 profile 不開分期與紅利，所以都可以。
- 每日自動關帳開啟時，20:15:00～20:30:59（Asia/Taipei）不呼叫 DoAction，20:31 再試；自動關帳後的取消在授權隔日 06:00 之後 [2885]。
- 綠界帳戶餘額不足時退刷失敗 [2885]：結果記 `failed`，原因顯示「綠界帳戶餘額不足，請先儲值」，不自動重試。
- 多步驟（`C`+`R`、`E`+`N`）每一步都是一個 operation，前一步確認後才做下一步。

### 7.4 結果不明

- DoAction 逾時或回應無法驗證 → 退款 `unknown`。**不得**直接重送（可能重複退款）；先用 QueryTrade/V2 的 `close_data` 判斷是否已生效；仍無法判斷 → 人工例外，賣家到綠界後台確認後以證據結案。
- QueryTrade/V2 同樣有 403 → 30 分鐘的限制 [2894]。

### 7.5 sandbox 與正式開放

- sandbox（stage）沒有 DoAction，sandbox 店只有 `manual_record`；畫面標示「商家自行退款（平台未經綠界確認）」。
- API 退款在正式環境預設關閉，直到完成 §11 的受控試退（Ted 授權、真實小額、全額與部分各一）；在那之前正式店也只能 `manual_record`。這是 EC-AT23 的實際限制，列為未驗證範圍，不宣稱全功能上線（計畫 §10.4）。

## 8. 對帳與報表（EC-R23）

- 每個 attempt 保存：綠界 `TradeNo`、`PaymentDate`、`PaymentType`、手續費（通知的 `PaymentTypeChargeFee`、查詢的 `HandlingCharge` [2878][2890]）。查詢結果可能沒有付款時間，所以只由查詢確認的 attempt 可以沒有 `PaymentDate`；付款通知一定要有。
- 收款報表（Seller Console 的 payments／reports）：已確認收款、退款（分 API 確認與人工紀錄）、手續費、待確認、例外。明示「綠界撥款到銀行」不在本系統範圍，報表不顯示「已入帳」（計畫 §10.2）。
- 每日對帳差異清單：`paid` 但未 `confirmed` 超過 1 小時、`unknown` 退款、`unmatched` 事件、付款套用為例外但無人處理。
- 批次下載對帳媒體（`TradeNoAio` [2896]）與撥款對帳（`FundingReconDetail`，只限正式 [2898]）列為 C4；C2 以逐筆查詢與上表為準。
- 供應商貨款與運費是另一本帳（EC-SPEC-06 §5），不與買家收款混算（EC-AT24）。

## 9. 安全與隱私（EC-R24）

- 卡號與安全碼只在綠界頁面輸入；平台不收、不轉送（EC-AT25）。
- `NeedExtraPaidInfo=Y` 會帶回 `card6no`、`card4no` [5675]：只用於簽章驗證，**不保存**、不顯示、不寫日誌；事件只存 `gwsr`、授權碼以外的必要欄位與原始 body 的 SHA-256。`auth_code` 不保存。
- 日誌只記事件 ID、帳戶、結果碼；不記 body、金鑰、簽章字串。
- callback 端點不需要 CSRF token，但有簽章、商家、金額與交易識別驗證；去重鍵防重放。
- 綠界主機 IP 不固定 [2858]：不做 IP 白名單；也不對 callback 做容易誤擋的嚴格限流（綠界提醒雲端 WAF 會擋高峰通知 [61944]）；只限 body 大小與每個（帳戶, 網路）每分鐘 600 次。這個額度在驗證之前計數，所以不能只以帳戶為鍵：`account_ref` 出現在每張交接表單的 `ReturnURL`，只以帳戶為鍵時任何人都能耗盡它，讓真通知收到 429（EC-SPEC-09 §4）。
- 機器路徑沒有 principal：以帳戶列解析出的 tenant 設定交易身分變數（EC-SPEC-09 §2），不接受請求內容指定 tenant。

## 10. 程式位置與 migration

- 綠界協定純函式（CheckMacValue SHA-256／MD5、.NET URL 編碼、AES-128-CBC 信封、表單與回應解析）：提議 `modules/agent-commerce/providers/ecpay/`，新 descriptor（module `commerce-providers`，無資料庫相依）。付款、物流、發票共用。
- 付款領域、routes 與 outbox：提議 `modules/agent-commerce/payments/`，新 descriptor（module `commerce-payments`，相依 `hosted-checkout`、`commerce-providers`）。
- 退款分攤的純函式（行項上限、運費建議、分攤檢查，EC-SPEC-06 §2.5）：`modules/agent-commerce/payments/rules/`，M2 的領域與 trigger 之前先建；`commerce-payments` 的 descriptor 隨它登錄，相依在 M2 的 migration 加入。
- M2（付款）在 M1 之後：§3.1 的表、RLS、trigger、索引；能力 `commerce.hosted-payment.v1` 與強制下限跟 callback 路由同一個 migration 上線——之後回退到不認得 callback 的 binary 會漏接付款，所以不能回退（EC-SPEC-10 §7）。
- Worker 需要的設定：`COMMERCE_CREDENTIAL_KEYS` secret、callback 路徑的 Access 排除（staging）、到期工作與退款 operation 的排程（cron）。都是部署設定，由 Ted 操作（EC-SPEC-10 §4.3、§4.4）。

## 11. 外部驗證的分層（需要 Ted 授權）

| 層 | 內容 | 授權 |
| --- | --- | --- |
| 向量與契約 | 官方範例向量（AIO 3 組、物流 MD5 2 組、AES 4 組、發票 MD5 1 組，已在本機重算）、Node 與 workerd 一致、負面案例 | 不需要（不連線） |
| stage sandbox | 用公開測試帳號 `3002607` 與測試卡 [2856] 跑完整付款、通知（需要 staging 的 Access 排除）、查詢 | 需要：連線綠界 stage |
| 正式受控試付 | 一個真實商家帳戶、一筆小額真實付款、全額與部分退款各一 | 需要：Ted＋該商家；真實扣款與退款 |

模擬付款（`SimulatePaid=1`）只證明 callback 收得到，不是收款證據 [2878]。

## 12. 測試（全部 not_run）

| 案例 | 驗收 |
| --- | --- |
| CheckMacValue：3 組官方向量；參數名大小寫、空值、`+`／空白、`~`、`'`、中文、額外欄位；重複參數名被拒 | EC-AT15 |
| 同一組向量在 Node 與 workerd（`nodejs_compat`）結果相同 | EC-AT15 |
| 金額：`total_minor` 非 100 倍數、< 5 元、> 999,999,999 元、非 TWD → 不提供本 profile；`TotalAmount` 永遠是整數 | EC-AT08、09 |
| 錯商家、錯金額、錯環境、錯帳戶、未知 `MerchantTradeNo` | EC-AT16 |
| 通知重送（含並行兩筆相同通知）只套用一次；先失敗後成功、先成功後失敗、查詢與通知交錯 | EC-AT17、21 |
| `SimulatePaid=1` 且 `RtnCode=1`：不改 attempt、不動庫存、不建立履約 | EC-AT19 |
| 瀏覽器 `OrderResultURL` 帶有效簽章的成功資料：不改狀態，只排查詢 | EC-AT18 |
| 提交失敗不回 `1\|OK`；提交成功才回 | EC-AT17 |
| 查詢 403 → 同帳戶付款服務暫停 30 分、物流與發票不受影響；逾時退避；`TimeStamp` 每次重產 | EC-AT20 |
| 確認窗結束：全部 attempt 確定未付 → 取消；有 `unknown` → 不取消、繼續查詢、24 小時後開例外；從未交接 → `expired_unpaid` 且不查詢 | EC-SPEC-03 §3.3 |
| 重新付款：當場查詢回未付才建立新 attempt；結果不明、交接未滿 60 秒、已有付款、滿 5 個、hold 過期各回對應的 409；並行兩次只建一個；被取代的 attempt 晚到的付款照常套用 | EC-SPEC-04 §4.3 |
| 收款服務的驗證付款：查詢確認才啟用，只有通知不啟用；服務已不是 `draft` 時只確認付款 | EC-SPEC-04 §1.4 |
| 通知 vs 保留到期結算、通知 vs 買家取消、兩個 attempt 都付款（overpaid） | EC-AT21、30、31 |
| 退款累計上限、並行退款、`unknown` 不重送、人工紀錄 | EC-AT22、23 |
| 兩間店兩個帳戶：A 店的通知不能套到 B 店；A 的金鑰解不開 B 的封存 | EC-AT13 |
| 金鑰輪替（帳戶版本與 Worker key 兩種）期間舊交易仍可驗證 | EC-AT14 |
| 任何 DTO、journal、log、錯誤訊息不含金鑰、卡號片段 | EC-AT25 |
| 已付款但未 `confirmed` 的履約單不能交寄 | EC-AT27（與 EC-SPEC-05） |

## 13. 仍待決

| 項目 | 建議 | 只影響 |
| --- | --- | --- |
| DC02 首家支付 | 本 profile | 其他 provider 之後依 PaymentPort 加入 |
| DC05 長效付款 | 不開 | ATM／超商代碼／條碼／COD |
| 確認窗長度 | 60 分鐘 | 未付款訂單多久後取消 |
| 查無此單的狀態碼 | stage 驗證（§11）時記下綠界對不存在的 `MerchantTradeNo` 的回應；在那之前一律當 `unknown` | 確認窗後能否把查無此單當成確定未付；現在要等確認窗後 24 小時的人工例外 |
| API 退款開放時點 | 受控試退通過後 | 正式店的退款自動化；在此之前人工紀錄 |
| 人工退款記錯 | M2 不能改；之後加「作廢這筆紀錄」的命令（owner／admin，保留原列與作廢者） | 記錯的金額會讓例外無法自動結案，只能由店家手動結案 |
| stage 連線授權 | 需要 Ted | sandbox 端到端驗證；不影響向量與契約測試 |
