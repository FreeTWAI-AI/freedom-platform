# 工作計畫：工作包、依賴、CLI 分工與 Supplier Console 接點

狀態：proposed（2026-10-15）。基準 `efaf314d`，2026-10-15 10:03Z 再讀 main 為 `5bee7376`（WP-00 §1）。

本文件把計畫 §20 的 EC-WP00～11 對到規格、里程碑與實際分支。進度以 commit、測試證據與 PR 為準；「現況」欄只記錄 2026-10-15 的狀態，之後不在這裡追進度。

## 1. 原則

- 整合負責人（Claude Opus 5.5）寫規格與工作說明、派工、審查、整合；程式由三個 CLI 寫（§3）。
- 共用的 migration、介面與登錄點由整合者一次合併。兩個工作不同時改同一個檔案（計畫 §20.3、§6）。
- 每個工作有自己的 worktree 與分支 `fc/<job>`，從整合分支的固定 SHA 開出。回報要列實跑的命令與結果；沒跑的寫 `not_run` 與原因。
- 整合者在自己的一次性資料庫重跑測試、逐檔讀差異，才合併進整合分支。有問題就開修正輪：同一個 CLI、同一條分支、新的 commit，不 amend、不 force。
- 不 push、不開 PR、不合併到 main、不部署、不連綠界（含 stage）、不寄信。這些等 Ted 決定（README 的界線）。

## 2. 工作包

| 工作包 | 範圍 | 規格 | 直接依賴 | 里程碑 | 2026-10-15 現況 |
| --- | --- | --- | --- | --- | --- |
| EC-WP00 基準與權利 | 差異、可沿用的程式、缺口、來源權利 | WP-00、sources.md | — | C0 | 完成（文件） |
| EC-WP01 產品與視覺 | 角色、B／E／SL 頁、動線、狀態與文案 | EC-SPEC-01、pages.md | WP00 | C1 | 規格完成；EC 參考畫面的逐頁對照待 Ted 確認（EC-SPEC-01 §5、DC10） |
| EC-WP02 商店與 Seller Console | 變體、照片、分類、店面內容、優惠；E02～E11 的頁 | EC-SPEC-02 §1～§3、EC-SPEC-01 §4、§7.5 | WP01；Supplier Console 的共用殼進 main（§8） | C1；各里程碑自己的 E 頁 | 未開始 |
| EC-WP03 結帳與交易模型 | 顧客、checkout、訂單、N／H／A、付款後配置、出貨與退回的庫存效果；公開結帳路由與訂單存取 | EC-SPEC-02 §4～§5、EC-SPEC-03 | WP00 | M1 | 領域核心通過審查（`fc/wp03-core` `16caa586`）；公開結帳路由、訂單存取、限流、主機設定、排程與能力下限通過審查（`fc/wp03-http` `eea0f328`，整合 `762baaf0`）；兩者都已併入整合分支 |
| EC-WP04 金流與退款 | 收款帳戶與金鑰、PaymentPort、ECPay AIO、通知與查詢、退款、對帳 | EC-SPEC-04 | WP03 | M2 | 協定函式庫與 AIO 信用卡協定通過審查（`fc/ecpay-proto` `67d9ba2e`、`fc/ecpay-aio` `b836419e`），已併入整合分支；退款分攤的純規則通過審查（`fc/refund-rules` `4376e471`，整合 `69067716`）；收款帳戶、封存金鑰、店家准入與商店 1.1.0 完成（`fc/wp04-accounts` `bfab7559`，整合 `38e8db3b`）；付款拆成四個工作（§4）：wp04-payments 完成（`fc/wp04-payments` `c8044968`，整合 `f852b742`），wp04-queries 與 buyer-pay 進行中 |
| EC-WP05 物流與供應商補充 | 出貨設定、配送群組、選店、託運單、標籤、貨態、例外、退回 | EC-SPEC-05；SC-SPEC-07 | WP03；WP04 的協定與排程 | M3 | 配送純規則通過審查（`fc/fulfil-rules` `5c8d8379`）；綠界國內物流協定通過審查（`fc/ecpay-logistics` `1f99faeb`）；兩者都已併入整合分支；收件資料改用 CDN 字詞檢查、門市代號寬度與貨態表凍結的修正輪也已併入（`fc/fulfil-rules-fix2` `d44f1d1d`，整合 `f38b9a08`） |
| EC-WP06 發票與售後 | 發票、更正、對話、RMA、退款分攤、供貨帳 | EC-SPEC-06 | WP03～05 | M4 | 發票純規則通過審查（`fc/invoice-rules` `a9cb0ebf`），已併入整合分支；B2C 電子發票協定通過審查（`fc/ecpay-invoice` `f04b5eba`，整合 `44985a2f`） |
| EC-WP07 營運與技能書 | 29 項技能的落點、報表與漏斗、書與站內應用的連結 | EC-SPEC-07 | WP02；PR #706 | M2 起 | 規格完成；程式未開始 |
| EC-WP08 安全與整合 QA | 權限、閘道例外、限流、遮罩、canary、能力矩陣 | EC-SPEC-09 | 隨 WP02～07 | 每個里程碑 | 每個工作附自己的反例；跨領域測試隨 M2 開始 |
| EC-WP09 可攜營業發行 | 授權子集、發行清單、官方 profile、安裝與升級 | EC-SPEC-08 §2、§3 | WP00；WP03～06 的契約；DC07、DC11 | C3 | 未開始 |
| EC-WP10 遷移與互通 | 匯出匯入、寫入者世代、在途通知、X 旅程 | EC-SPEC-08 §4～§6 | WP09 | C3 | 未開始 |
| EC-WP11 發布與試用 | 主機設定、准入、寫入下限、發布、回退、還原、試用 | EC-SPEC-10 | WP08；Ted 的授權 | 每個里程碑 | 規格完成；執行需要 Ted |

## 3. 三個 CLI 的分工

| CLI | 交給它的工作 | 已完成 |
| --- | --- | --- |
| Codex `gpt-6.1-sol`（high 或 xhigh） | 跨檔的領域邏輯、migration、鎖序與不變條件、權限與入口 | wp03-core 與一輪修正 |
| agy `gemini-4-argon-high` | 規格明確的協定、adapter、較大的純函式庫與官方向量 | ecpay-proto |
| agy `gemini-3.8-flash-high` | 拆得很細、輸入輸出明確的小任務：純規則、對照表、補測試 | invoice-rules |

- 不硬用寫不好的模型：同一個工作若修正輪仍有多項缺陷，下一輪改派 Codex。
- 任何額度錯誤（agy 429、Codex 的 quota 或 rate limit）先停下來問 Ted，附上恢復時間。agy 的 exit 0 不代表成功，要看 commit 與回報。
- 前端工作完成後，整合者另外在瀏覽器看各寬度與主題（DESIGN.md、`rpg-theme.css`、`styles.css`），也檢查 E2E 有沒有加長 timeout 或重試。

## 4. 里程碑與實作切片

每個里程碑一個 migration 與一個能力（EC-SPEC-10 §3、§4.1）。表中「下一批」見 §5。

**M1 訂單與庫存核心（`commerce.hosted-checkout.v1`）**

| 切片 | 內容 | CLI | 依賴 | 狀態 |
| --- | --- | --- | --- | --- |
| wp03-core | migration 168、`modules/agent-commerce/checkout/`、N／H／A、付款後配置、出貨與退回的庫存效果 | Codex | — | 完成 |
| wp03-http | 公開結帳路由（EC-SPEC-02 §5.2～§5.4）；訂單存取憑證與 B10（§4.2，fixture sender）；結帳的限流（EC-SPEC-09 §4）；主機設定 `CHECKOUT`、`QUARANTINE` 與 `site` 布林（EC-SPEC-10 §2.2、§2.3）；到期預留接上排程（§5）；能力、SHAPE 與 168 的強制下限（§3）；同意版本與配送 JSON 的檢查；還原演練補上 168 的 RLS 表 | Codex | wp03-core | 完成（`fc/wp03-http` `eea0f328`，整合 `762baaf0`） |
| buyer-orders | 店面 client bundle（固定檔名 `assets/storefront.js`）；B07 付款前的訂單頁：信件連結的兌換、在這個瀏覽器忘記；B10 在寄送授權前的說明（EC-SPEC-10 §6.2） | argon | wp03-http | 完成（`fc/buyer-orders` `1d4744cc`，整合 `1a9955eb`） |
| buyer-cart | B01／B03 開放結帳時的購物車連結與件數、B03 加入購物車與購物車面板、B04 依伺服器報價的購物車；未開放時 v1 頁面逐位元不變 | argon | buyer-orders；wp04-accounts（店家准入） | 完成（`fc/buyer-cart` `5d226d71`，整合 `942df112`） |
| buyer-checkout | B05、B06（付款前）；線下付款的選項與 B07 的匯款說明（EC-SPEC-11 §6） | 之後決定 | buyer-cart；M3 的配送資料與選店、M4 的發票欄；offline-core | 之後 |

M1 沒有店家准入表（M2），所以正式與 staging 都還不能成立 `hosted_checkout` 訂單；M1 的驗收是不影響 v1 預留，加上本機與 CI 的測試（EC-SPEC-10 §4.6）。

**M2 收款（`commerce.hosted-payment.v1`）**

| 切片 | 內容 | CLI | 依賴 | 狀態 |
| --- | --- | --- | --- | --- |
| ecpay-proto | 綠界協定函式庫 | argon | — | 完成 |
| ecpay-aio | AIO 的送出內容、通知的驗證與解析、查詢結果對照、API 退款，全部是純函式加官方向量（EC-SPEC-04 §3.4、§5.2、§6.2、§7.3） | argon | ecpay-proto | 完成（`fc/ecpay-aio` `b836419e`，整合 `d6fa9098`） |
| wp04-accounts | 收款帳戶與封存金鑰；重新確認身分的新用途；`storefront@1.1.0`、`hosted-store@1.1.0` 與升級；入口路由；店家准入；設定變更的控制事件（EC-SPEC-04 §1、EC-SPEC-09 §2.2～§2.5、EC-SPEC-10 §2.5、§8.2） | Codex | wp03-http | 完成（`fc/wp04-accounts` `bfab7559`；整合 `21e46a73`、`4b83fe1c`，修正輪 `38e8db3b`） |
| refund-rules | 退款分攤的純規則：行項上限、運費建議、分攤與調低的檢查、未套用付款的退款（EC-SPEC-06 §2.5、EC-SPEC-04 §7.2） | flash | — | 完成（`fc/refund-rules` `4376e471`，整合 `69067716`） |
| wp04-payments | attempt 與一次性交接頁、付款通知與瀏覽器返回（含閘道例外）、外部效果日誌、到期工作與例外的表、買家的付款摘要、隔離模式的付款閘門、能力 `commerce.hosted-payment.v1` 與強制下限；不呼叫綠界（EC-SPEC-04 §3～§5、EC-SPEC-09 §2.6、EC-SPEC-10 §3） | Codex | wp04-accounts、ecpay-aio | 完成（`fc/wp04-payments` `c8044968`，整合 `f852b742`） |
| wp04-queries | 查詢與到期工作的執行（用 `commerce_due_work`，不建 outbox）、排程與即時執行、確認窗結束、重新付款、按需查詢、收款服務的驗證付款（EC-SPEC-04 §1.4、§4.3、§6） | Codex | wp04-payments | 完成（`fc/wp04-queries` `d87650fa`，整合 `4f7b683b`） |
| wp04-seller | 賣家端的 M2 後端：`FREEDOM_COMMERCE_CONSOLE_ENABLED`（EC-SPEC-10 §2.2）、訂單讀取與聯絡卡（E05 的 `…/checkout-orders`）、未付款取消、付款例外的處理、立即查詢；未套用付款的人工退款紀錄與買家的 `refunded`（EC-SPEC-03 §3.2、EC-SPEC-04 §7.1～7.2、EC-SPEC-09 §2.2） | Codex | wp04-queries、buyer-pay、refund-rules | 進行中（`fc/wp04-seller`） |
| wp04-refund-api | API 退款：operations outbox、QueryTrade/V2 與 DoAction、結果不明、每日關帳時段（EC-SPEC-04 §7.3～7.4）；正式環境預設關閉 | Codex | wp04-seller | C2 受控試用排定時 |
| buyer-pay | B06 待付款與付款返回、B07 的「前往付款」與「查詢付款結果」 | argon | wp04-payments；查詢按鈕要 wp04-queries | 完成（`fc/buyer-pay` `296e02e7`，整合 `9703443b`） |
| b07-live | B07、B06 接真的查詢與重新付款端點的 E2E（buyer-pay 當時只能用 `page.route` 回應） | flash | wp04-queries、buyer-pay | 完成（`fc/b07-live` `dce5c604`，整合 `2586d796`） |
| emails | 交易信件的寄送：`FREEDOM_COMMERCE_EMAIL_ENABLED`、不含個資的信件佇列 `commerce_outbound_emails`、到期工作的 `email`、寄出前寫日誌、Worker 的 `EMAIL` binding 與 fixture sender、寄送打開時的 B10 表單與訂單頁的寄信說明（EC-SPEC-10 §2.2、§6，EC-SPEC-02 §4.2）；打開寄信仍由 Ted 決定 | argon | wp04-queries、buyer-pay、信件範本 | 進行中（`fc/emails`） |
| E 殼與 E05、E09、E11 | 訂單、收款、設定頁；`CONSOLE` 開關（依賴 Supplier Console 的旗標） | argon | 共用殼進 main；wp04-accounts | 之後 |
| 信件範本 | 五封買家信件的純文字範本，README 的範例由測試核對（EC-SPEC-10 §6.1） | flash；修正輪 argon | — | 完成（`fc/email-templates` `04916980`，整合 `0bc97559`） |
| 信件列與寄送 | 信件列、`EmailPort` 的正式實作、到期工作寄送、fixture sender（EC-SPEC-10 §6.3、§6.4） | 之後決定 | 信件範本、wp04-queries（到期工作的執行） | 併入 emails |

M2 的 staging 驗收（EC-SPEC-10 §4.6 的 J02～J04）要先能成立訂單。正式的 Worker 只接上店家准入與付款兩個 port，沒有運費報價（`ShippingQuotePort`），所以 staging 與正式環境成立訂單會回 409 `shipping_not_configured`；只有 E2E 伺服器接上 fixture 運費。運費報價由 M3 的履約模組實作（EC-SPEC-05 §3），B05 結帳頁（buyer-checkout）也排在 M3 的配送資料之後。所以 M2 的程式照常依旗標併入，staging 驗收和 M3 一起做，除非 Ted 決定提早做最小的 B05 與運費設定。

**M3 履約（`commerce.hosted-fulfilment.v1`）**

| 切片 | 內容 | CLI | 依賴 | 狀態 |
| --- | --- | --- | --- | --- |
| fulfil-rules | 配送分組與拆包、運費、收件資料檢查、貨態代碼對照，全部是純函式（EC-SPEC-05 §3.2～§3.5、§6.3、§6.4） | flash | — | 完成（`fc/fulfil-rules` `5c8d8379`，整合 `f941a48b`；CDN 修正輪 `d44f1d1d`，整合 `f38b9a08`） |
| ecpay-logistics | 選店、建單、列印、貨態通知與查詢、7-ELEVEN 店到店取消與改門市的協定（EC-SPEC-05 §5～§7）；共用的 CDN 字詞檢查，AIO 一併套用 | argon | ecpay-proto、ecpay-aio | 完成（`fc/ecpay-logistics` `1f99faeb`，整合 `f7711535`） |
| offline-core | 線下收款設定、sidecar 的 `payment_method`、terms 與下單的線下方式、長效保留與到期、確認收款、面交完成與交貨、主機設定的線下 profile（EC-SPEC-11 §2～§5、§8） | Codex | M2；wp05-settings（`delivery_options[]`） | 之後 |
| wp05-fulfilment | 出貨設定、履約單、shipment、例外、退回與檢驗；給 SL 頁的讀取投影與命令 | Codex | M2 | 之後 |

**M4 發票與售後（`commerce.hosted-invoice.v1`）**

| 切片 | 內容 | CLI | 依賴 | 狀態 |
| --- | --- | --- | --- | --- |
| invoice-rules | 統編、買受人欄位、品項拆分、期別、更正建議 | flash | — | 完成 |
| ecpay-invoice | B2C 電子發票的協定 | argon | ecpay-proto | 完成（`fc/ecpay-invoice` `f04b5eba`，整合 `44985a2f`） |
| wp06-invoice-aftersales | 發票、對話、RMA、退款分攤、供貨帳 | Codex | M3 | 之後 |

C3（EC-WP09、WP10）在 DC07、DC11 有決定、M1～M4 的契約穩定後開始；打包工具與 clean-room 安裝可以先做（decisions.md 的外部條件表）。

## 5. 下一批（2026-10-15）

三個工作同時跑，各自的 worktree 從整合分支的同一個 SHA 開出：

| 工作 | CLI | 分支 | PostgreSQL | E2E |
| --- | --- | --- | --- | --- |
| wp03-http | Codex `gpt-6.1-sol` xhigh | `fc/wp03-http` | 55442 | 4742 |
| ecpay-aio | agy `gemini-4-argon-high` | `fc/ecpay-aio` | 不用（純函式） | 不用 |
| fulfil-rules | agy `gemini-3.8-flash-high` | `fc/fulfil-rules` | 不用（純函式） | 不用 |

先把 `fc/wp03-core`、`fc/ecpay-proto`、`fc/invoice-rules` 與 main `5bee7376` 合進整合分支，跑完整驗證，再開這三個工作。

第二批：ecpay-aio 合併（`d6fa9098`）後，ecpay-logistics 由 agy `gemini-4-argon-high` 從 `edb26526` 開出（`fc/ecpay-logistics`，純函式，不用資料庫）。fulfil-rules 的修正輪合併為 `f941a48b`。ecpay-logistics 通過審查，合併為 `f7711535`：Node 與 workerd 兩邊的 golden 由整合負責人在 repo 外依官方演算法獨立重算。refund-rules 的修正輪通過審查，合併為 `69067716`：3925 組差分案例與 repo 外的獨立參考實作相符。wp03-http 的 Codex 跑滿兩小時的時限，停在最後的全套測試；程式提交完整，由整合負責人接手驗證。fulfil-rules-fix2 由 flash 從 `e9fdadc3` 開出，收件姓名與宅配地址改用 `commerce-providers` 的 CDN 字詞檢查，通過審查，合併為 `f38b9a08`。

2026-10-15 已合併（`da4af013` main、`d3cbb286` wp03-core、`931f8666` ecpay-proto、`f250e66d` invoice-rules）。整合者在一次性資料庫重跑 `f250e66d`：typecheck、build、cloudflare、governance、契約 946、runtime 全部通過；CI 的 worker job 順序（契約、dry-run 後）worker 114/114、migration-postgres 12/12、media-restore 封存 6/6。media-restore 的 J6-R3 失敗 1 項：168 新增的兩張 RLS 表（`commerce_customers`、`commerce_checkout_contacts`）沒有列進還原演練，由 wp03-http 補上。

第三批（2026-10-15）：

| 工作 | CLI | 分支 | PostgreSQL | E2E |
| --- | --- | --- | --- | --- |
| ecpay-invoice | agy `gemini-4-argon-high` | `fc/ecpay-invoice` | 不用（純函式） | 不用 |
| wp04-accounts | Codex `gpt-6.1-sol` xhigh | `fc/wp04-accounts` | 55443 | 4743 |
| email-templates | agy `gemini-3.8-flash-high` | `fc/email-templates` | 不用（純函式） | 不用 |

wp03-http 的修正輪通過審查，合併為 `762baaf0`。修正輪的工作說明預期 unknown-paths 剩 2 條；實際是 0，因為新路徑都已登錄，以實跑為準。整合者另外重跑：typecheck、契約、checkout 兩組 runtime 89/89 與 191/191、cloudflare 515/515、selector 38/38。`7b841056` 的完整驗證：typecheck、build、cloudflare、governance、worker、契約都過；runtime 5155/5158。失敗的三個中，T-022 8 的 RLS 固定清單沒有 wp03-http 新增的 `commerce_order_access_grants`，worker-adapter 的設定比對沒有 wp03-http 加的 `commerceSettings`，都是 wp03-http 沒同步既有測試；整合者補上（`f87da3c2`：A、B 兩店用公開下單同一組 helper 建立瀏覽器 grant，改綁租戶被不可改觸發器擋下、跨租戶讀不到、本店讀得到；重跑 2/2、23/23）。operator-media-backfill 的「截止後才到的 PUT」在乾淨資料庫單獨重跑 11/11，是全套負載下的計時問題。worker 序列的契約、check:*、dry-run、worker、media-restore（`f250e66d` 時失敗）都過；migration-postgres 兩次都卡在測試自建 PostgreSQL 時 Docker 逾時（負載約 13），重跑時 migration-plan 6/6、runner-plan 3/3 通過，entrypoints 留待下一次完整驗證。ecpay-invoice 從 `7b841056` 開出並通過審查：程式與 27 組 golden 都對；README 有 11 個 ECPay 頁碼寫成鄰近或不存在的頁，整合者逐頁核對標題後改正（`f04b5eba`）。整合者重跑：typecheck、Node 四組 51/51、workerd 四組 13/13、selector 38/38、unknown-paths 0、stage 金鑰外洩 0、inventory。之後把 main `f8a00469` 併進整合分支（`c81451a4`，只有 inventory 衝突，重新產生），再合併 ecpay-invoice（`44985a2f`），並先登錄 wp04-accounts 與 email-templates 需要的 descriptor 路徑（兩個工作都不改 descriptor），兩個工作再從那個 commit 開出。EC-SPEC-06 的註銷重開比照作廢期限另留 2 小時緩衝（46 小時，`52941ba7`），供 invoice-rules-fix1 使用。

第四批（2026-10-15）：

| 工作 | CLI | 分支 | PostgreSQL | E2E |
| --- | --- | --- | --- | --- |
| buyer-orders | agy `gemini-4-argon-high` | `fc/buyer-orders` | 55444 | 4744 |

invoice-rules-fix1 通過審查：買受人 Email 改用 `commerce-providers` 的 `isInvoiceEmail`；註銷重開限已上傳、開立後 46 小時內；ECPay 時間只收同一個分隔符與 2000～2099 年。整合者把 README 的相依說明改成指名 `isInvoiceEmail`（`24dd537f`），合併為 `18be535a`。整合者重跑：typecheck、發票規則與 B2C 協定 58/58、selector 42/42、unknown-paths 0、inventory。governance 468/472：失敗的 4 項是子行程逾時（git `spawnSync ETIMEDOUT`、exit `null`），當時負載約 31，與發票無關，負載下降後單獨重跑。email-templates 的修正輪由 argon 做，通過審查，合併為 `0bc97559`：店到店包裹帶追蹤碼時拒絕產生信件（EC-SPEC-05 §9.3）；`formatTwd` 不用語系資料並檢查輸入；五個範本共用最後一道檢查（主旨單行、200 個 UTF-16 單位內；內文每行 998 位元組內、沒有 CR、tab 與行尾空白）；店家聯絡 Email 只收可列印的 ASCII；README 的錨點與個資、寄送授權的文字改正。整合者重跑：typecheck、範本 9/9、selector 42/42、unknown-paths 0、inventory；合併後範本與發票規則 55/55。buyer-orders 開出前，先登錄 `commerce-storefront`（§7）。B04 起的買家頁要等店家准入（wp04-accounts），B05 還要 M3 的配送資料與 M4 的發票欄，所以先做不依賴它們的訂單頁與 B10。

第五批（2026-10-16）：

| 工作 | CLI | 分支 | PostgreSQL | E2E |
| --- | --- | --- | --- | --- |
| buyer-cart | agy `gemini-4-argon-high` | `fc/buyer-cart` | 55446 | 4746 |
| wp04-payments | Codex `gpt-6.1-sol` xhigh | `fc/wp04-payments` | 55445 | 4745 |

main `3c1ff744`（#785）先併進整合分支（`eb7fa608`）。buyer-orders 的審查看過 46 張截圖，修正輪 7 項：被拒的連結重試後仍顯示連結無法使用、每個畫面都顯示錯誤與重試、忘記後恢復頁面標題、按鈕的寬度規則只套在訂單頁、`::backdrop` 改用字面色碼、E2E 用這筆訂單的裝置 grant 檢查撤銷、README 換行；合併為 `1a9955eb`。

wp04-accounts 的 Codex 在完整 runtime 測試時被主機的記憶體不足終止（2026-10-15 20:31Z），續跑後補完。完整測試 5272 項：5215 過、56 失敗、1 取消。其中 11 個檔案的失敗是全套負載下的逾時與連線錯誤，單獨重跑 224/224 通過；其餘是新功能沒有同步既有測試，各自修正：啟動 fixture 改選目前提供的 `hosted-store@1.1.0`（1.0.0 已撤下）、身分觸發器保留原有的拒絕訊息、契約產生器的 bundle 數 11、168 的稽核測試只套用到 168、RLS 清單加上三張收款表、路由矩陣加上 8 條設定路由與 3 條准入路由（服務用途是封閉列舉，改測無效輸入回 422）。`media-restore --archive-only` 在它的資料庫上失敗，在乾淨的基準 checkout 也一樣（錯誤是 line 372 對同一個 pool 呼叫兩次 `end`）；整合者在 `93f83960` 用審查用的資料庫重跑 6/6 通過，所以失敗跟那個資料庫的狀態或負載有關，不是程式。這個測試在子測試中途失敗時，清理會對已關閉的 pool 再呼叫一次 `end`，可能蓋掉原本的錯誤。

為了讓 buyer-cart 先開工，wp04-accounts 分兩次併入：`21e46a73`（到 `77033e74`；worker-adapter 採用 wp04 的那一行，tenant-rls-retarget 兩邊都保留：buyer-orders 的 grant 註解與 wp04 的收款帳戶資料）與 `4b83fe1c`（到 `e3830883`）。修正輪 6 項（keyring 的部署說明改成中文的獨立段落、輪替的說明照實寫、`platform-app.ts` 改用 `providerEnvironment()`、e2e server 移除丟棄結果的 parse、跨社群撤銷一律 404 `store_admission_not_found`、inventory）與兩個新工作並行，之後再併。

派工前整合者在整合分支加上 `publicPurchaseState`（`61f329e6`）：B01／B03 是否提供購物車，用的是購物車報價自己的閘門（平台開關、隔離模式、店家准入）與一件的可售量，唯讀、不扣限流額度。公開商店路由與結帳 API 從同一個 `hostedCheckoutOptions()` 取得結帳設定，`hosted-checkout.ts` 自寫的 `'public' ? 'live' : 'sandbox'` 改用 `providerEnvironment()`（`platform-app.ts` 的兩處由 wp04-accounts 的修正輪改）。這樣 buyer-cart 不必改 `platform-app.ts` 與 checkout 模組，兩個工作的檔案不重疊。它的測試把准入閘門拿掉、或把數量不足當成可售，都會失敗。整合者在 `61f329e6` 重跑：typecheck、inventory、purchase-state 1/1、RLS retarget 2/2、buyer-cart 會跑的既有 runtime（買家頁、結帳 HTTP、商店）82/82；在 `4b83fe1c` 重跑 typecheck、inventory、路由矩陣 72/72 與 purchase-state 1/1。buyer-cart 第一次啟動時 Google 的服務回 503（不是額度），還沒開始工作就結束，00:42Z 重新啟動。

M2 的付款拆成四個工作（§4）：wp04-payments 不呼叫綠界，「排查詢」只寫到期工作；需要伺服器查詢的確認窗結束、重新付款與按需查詢由 wp04-queries 接手，退款由 wp04-refunds，買家的付款頁由 buyer-pay。開出前定案的規則：重新付款只在前一個 attempt 確定沒有付款時建立——`failed`，或交接 60 秒後當場查詢回 `TradeStatus=0`；查無此單和其他無法辨識的結果一樣算不明（`96b4d4f4`、`54976ffc`）。`ClientBackURL` 用 `/pay/ecpay/back/{attempt_id}`，不帶商店 slug，避免組出綠界 CDN 的擋字（`96b4d4f4`）。確認窗結束時結果仍不明的 attempt 不取消訂單，繼續查詢到窗後 24 小時再轉例外；從未交接的 attempt 直接 `expired_unpaid`（`d363b78d`）。查詢在回應後由 Worker 的 `waitUntil` 立即執行，10 分鐘的排程只是後備。

wp04-accounts 的修正輪 6 項通過審查，合併為 `38e8db3b`。整合者重跑：typecheck、相關的 runtime 32/32、cloudflare 517/517、inventory。

wp04-payments 第一次執行在寫程式之前就依矛盾規則停下：綠界信用卡 profile 的三處金額範圍不一致。可用性檢查沒有上限，付款表單收到 2,147,483,647 元，付款通知的 `TradeAmt` 卻只讀 9 位數；表單送得出 10 位數的金額，綠界簽章正確的通知反而被拒。整合者把函式庫統一成 5～999,999,999 元（`08f5bea4`）：可用性多一個原因 `amount_above_maximum`；表單、交易查詢與授權明細的預期金額、退款計畫與 DoAction 都拒絕更大的金額。EC-SPEC-04 §2 記下這個範圍，並和商家的單筆額度分開。新的回歸測試放到舊的函式庫上有 4 個失敗。整合者重跑 typecheck、綠界協定測試 52/52 與 inventory。wp04-payments 改以 `08f5bea4` 為基準，01:06Z 續跑同一個 Codex session（資料庫在 55445 重建）。它對 §1.4 的建議也採用：儲存金鑰時不以伺服器查詢驗證。

wp04-payments 續跑後在第 1 項又停下一次：工作說明給收件匣的表名 `commerce_payment_events` 已被 migration 055 用掉。那張表存匯入商店的店家後台付款回報，寫入者是 `orders.ts`，migration 138 限定只收匯入的訂單。整合者決定新表叫 `commerce_hosted_payment_events`，舊表與它的 catalog、測試都不動，兩種模型也不合併；新表的 constraint、index、trigger 與 function 都以新表命名，並加一個回歸測試確認 169 之後舊表的欄位與限制不變（`101441de`，EC-SPEC-04 §1.4、§3.1 一起改名）。同一批重產 guild-launchpad README 的狀態列（`6956f5f6`）：`08f5bea4` 上的 contracts 因為那一行少了 169 有 7 個失敗。wp04-payments 改以 `101441de` 為基準，01:29Z 續跑。

buyer-cart 的審查逐行讀過五個 commit，從基準的 renderer 重算 12 個 v1 位元組 pin，全部相符，沒有阻擋的缺陷。修正輪 6 項（`5d226d71`）：購買狀態只由第五個參數傳入，預覽一律不開放；路由先用 `publicProduct()` 確認 SKU 合法且在商店裡，才查購買狀態，否則回 404、不設 cookie；`aria-busy` 只在 effect 裡設定；新加的樣式只套在有 `<main id="main">` 的開放頁面，關閉商店的 v1 頁面維持原樣；最後一行商品不再重複底線；B04 加上長店名與長商品名在五種寬度的截圖；fixture 的「手拉坯青瓷茶海」改正。整合者在 `5d226d71` 重跑：typecheck、build、runtime 10/10 與 77/77、E2E 購物車 8、訂單頁 5、商店 15、selector 42/42、unknown-paths 0、inventory，看過 70 張截圖；合併為 `942df112`，合併後同一組檢查與契約 946/946 都過。

`a3045598` 的完整驗證：typecheck、build、cloudflare、governance、worker 都過；契約 7 個失敗是 guild-launchpad README 的狀態列還寫 168，`6956f5f6` 已修正（`942df112` 上 946/946）；runtime 5290/5292，失敗的兩個（`identity-member` 的隱私投影、`model-broker-bridge-adversarial` 的到期回滾）在審查用的資料庫單獨重跑 23/23 與 8/8 通過，是全套負載下的計時問題。worker 序列的契約、check:*、dry-run、worker、media-restore、`--archive-only` 與 migration-postgres 都過。

wp04-payments 的審查逐行讀過每個 commit；`f342df47` 只改格式（esbuild 重新輸出、去掉空白後 23 個檔案逐一相同）。
修正輪 15 項（`b2342e9e`～`d35f3f5d`），每項一個 commit，各帶一個在 `94b579b1` 上會失敗的測試：

- 瀏覽器返回先以 `FOR KEY SHARE` 鎖住 attempt，不會和付款通知互相等待；返回的紀錄或排查詢失敗時仍 303 回訂單；
  表單錯誤導回首頁，缺金鑰與其他錯誤回 HTML 頁「暫時無法確認付款結果，請稍後到訂單頁查看。」。
- 通知在驗證前的額度改以（帳戶, 網路）計，一個網路的未簽章流量用不完別人的額度。
- 隔離解除的順序：Worker 先套用延後的付款事件，再掃到期預留；有未套用的已驗證付款通知時，下單時的結算與排程掃描都不
  釋出那張訂單的預留；同一 attempt 的通知依收到順序套用，瀏覽器返回不擋。
- T-022 8 的 RLS 清單加上 `commerce_exception_cases`。
- 買家讀訂單只跑交接的閘門、不解封金鑰（20 次讀取 0 次解封，交接頁 1 次）；一次摘要只限一間店。
- 取消的重送不再呼叫付款 hook。
- 交接頁的按鈕一律是「前往綠界付款」：沒有 script 時立即顯示；有 script 時 10 秒後才和說明一起出現，按一次就停用；
  從上一頁回來時顯示「返回訂單」。保留過期的訊息改成「付款期限已過，保留的商品已釋出。」。
- 延後套用與日誌補寫都逐筆接住錯誤：失敗的事件只記事件 ID，同一 attempt 後面的事件留到下次，其他 attempt 照常。
- 付款通知先鎖帳戶再鎖金鑰，和金鑰退役的順序一致。
- 169 原地修改：每個 attempt 只留一筆瀏覽器返回；`paid`／`confirmed` 的 attempt 與 `paid` 事件必須有綠界交易號與
  付款時間（事件另需金額）；金額上限 999,999,999 元；移除兩個沒有查詢用到的部分索引。
- Wrangler 預檢拒絕跨環境重複、或與其他 R2 binding 共用的 `COMMERCE_JOURNAL` bucket。

`c8044968` 把原有交接測試的 noscript 斷言改成「前往綠界付款」。Codex 在 `c8044968` 上的最後驗證：typecheck、契約、
付款五組 runtime 360/360、checkout 與相關回歸 236/236、cloudflare 543/543、selector 42/42、unknown-paths 0、build
都過；worker 118/123。失敗的 3 個缺 admin-sync 與 maintainer 的 dry-run 打包檔（驗證只跑了主 Worker 的 dry-run）；
另外 2 個是 `tests/worker/github-sync-scheduled.test.ts` 的排程 fixture 只替 `commerceSweep` 放了 stub，新的延後付款
工作在只有 `end()` 的假 pool 上失敗，多記一行 `commerce_payment_deferred_failed`。這個測試檔沒有登錄在任何
descriptor，context 工具回 `surface_unmapped`，Codex 依規則停下，媒體還原、E2E、完整測試與 inventory 都沒有跑。
合併為 `f852b742`；整合者在 `2cbe3c1d` 把這個測試登錄到 `worker.ts` 的擁有者 application-composition 並加上 stub
（4/4），`09fd2145` 更新 inventory。

派工前整合者在整合分支加上 `f4b2be35`：checkout 契約的封閉錯誤碼加上 `checkout_order_closed`、`checkout_hold_expired`、
`payment_already_applied`、`payment_attempts_exhausted`、`payment_result_pending`（wp04-queries 用，buyer-pay
同時要能解析）；`resolvePaymentReturn` 給 B06 用（attempt 只在屬於這個 slug 的商店時才解析）；先登錄 wp04-queries
的測試路徑。`723ace13`：買家 DTO 的 `payment_state` 加上 `overpaid`（EC-SPEC-03 §3.2：有 `overpaid`、`after_cancel`
或 `amount_mismatch` 的付款套用紀錄時，優先於其他狀態，`can_resume_payment` 為假，B06／B07 顯示「付款金額待店家確認」）。
規格對齊：`8424559c` 把 EC-SPEC-01、03、04、09、10 與 decisions 照修正輪的實作改寫，每一項都對過合併後的程式；
`0495da30` 定義付款摘要的 `overpaid`；`2d2aa544` 把未付款取消的條件寫成 `cancelUnpaidOrder` 實際檢查的：訂單 `open`
且沒有確認付款。

第六批（2026-10-16）：

| 工作 | CLI | 分支 | PostgreSQL | E2E |
| --- | --- | --- | --- | --- |
| wp04-queries | Codex `gpt-6.1-sol` xhigh | `fc/wp04-queries` | 55445 | 4745 |
| buyer-pay | agy `gemini-4-argon-high` | `fc/buyer-pay` | 55446 | 4746 |

兩個工作從同一個 SHA 開出。buyer-pay 的「查詢付款結果」在它的 E2E 用 `page.route` 回應；wp04-queries 先合併，
整合者再用真的端點重跑 buyer-pay 的 E2E。合併後的整合驗證（聚焦的 runtime、worker、媒體還原、E2E 與完整測試）和這兩個
工作同時跑，結果記在下一次更新。

第六批原本從 `fb27a3fc` 開出。整合者在工作改動任何檔案前停下：那個 SHA 的 typecheck 在兩個購物車測試失敗（TS2741）。
wp04-payments 讓 `CommerceSettings.providerProfiles` 成為必填，buyer-cart 的 fixture 寫在那之前；兩個分支各自都過，
合併後才出現。整合者在 fixture 補上 `providerProfiles: []`（`cb5e4e34`），兩個工作改從這個 SHA 開出。之後每次合併都先跑
typecheck，再從那個 SHA 派工。

`cb5e4e34` 的整合驗證：typecheck、契約、build、付款 runtime 364/364、checkout 238/238、商店 40/40、cloudflare
543/543、selector 42/42、unknown-paths 0、媒體還原、E2E 付款 18 與商店 15、inventory 都過。worker 122/123：
`media-operator-images-worker` 的「private native operator RPC installs only four purposes」在兩個 CLI 工作同時執行時
到 60 秒逾時；單獨重跑（自己的資料庫）7.1 秒通過，以前的執行是 6.8～7.4 秒，`cb5e4e34` 只改購物車的測試 fixture，
所以是負載造成的逾時。worker 序列與完整測試在 `cb5e4e34` 上執行中。

wp04-queries 在寫程式前依矛盾規則停下：工作說明要驗證付款的命令檢查「收款帳戶是 `active`」，但收款帳戶沒有自己的
生命週期，只有付款服務有（EC-SPEC-04 §1.2）。這是工作說明寫錯。整合者改成：店家與商店實例是 `active`、帳戶屬於它們，
沿用 `payments/accounts.ts` 的 `command(...)`，不符時回 403 `capability_denied`，不加新的錯誤碼；`service_activation`
的交接頁遇到停用的店家，和訂單付款一樣回 409 `payment_handoff_unavailable`；`tenant_inactive` 只是到期工作的
`last_error`。第一份補充說明誤把 `tenant_inactive` 寫成 HTTP 錯誤碼，整合者在 Codex 還在讀檔時停下那次續跑，
改用更正後的補充說明重開。EC-SPEC-04 §1.2 補上「收款帳戶沒有生命週期」（`1641c394`）。

M2 剩下的工作重新切分（§4）。E05 原本列的 `GET …/orders` 已是 v1 直接預留的賣家路徑（`hosted-orders.ts:72`），
`hosted_checkout` 的訂單還沒有任何賣家 API；`cancelUnpaidOrder` 沒有路由，付款例外也沒有讀取與結案的路徑。
M2 的驗收（EC-SPEC-10 §4.6）不含退款；API 退款只限正式環境，要等 C2 的受控試用。所以 wp04-refunds 拆成兩個：
wp04-seller 做賣家端的 M2 後端與未套用付款的人工退款紀錄；wp04-refund-api 做 API 退款，受控試用排定時才開出。
規格先改（`6a61d053`）：M2 的退款只有人工紀錄，每筆連到一筆未套用的付款，上限是那筆套用紀錄的金額（已驗證的實付），
全額退完時自動結案那筆例外；買家的付款摘要加上 `refunded`，畫面寫「店家已登記退回」，因為平台沒有向綠界確認；
E05 的路徑改成 `…/checkout-orders`。

buyer-pay 通過審查，合併為 `9703443b`。argon 沒有 `ui-design-system` 與 `huashu-design`，依 DESIGN.md 與 `shops.css`
做；整合者看過 1440、768、390、320 的截圖。合併後整合者重跑：typecheck、build、店面 runtime 14/14、E2E 付款 8、訂單與
購物車 13、商店 20、selector 42/42、unknown-paths 0、inventory 都過。付款與結帳 runtime 249/250：「review 1: browser
return locks its attempt…」在完整測試、wp04-queries 與 Supplier 同時執行時，被擋住的 `FOR KEY SHARE` 超過測試連線的
20 秒 statement timeout；單獨重跑 84/84（這項 0.66 秒），合併沒有改付款程式，所以是負載造成的逾時。「查詢付款結果」
在 buyer-pay 的 E2E 用 `page.route`，wp04-queries 合併後再用真的端點重跑。

寄信（emails）等 wp04-queries 的到期工作執行器與 buyer-pay 的頁面合併後開出。規格先改：信件列只在
`FREEDOM_COMMERCE_EMAIL_ENABLED` 打開時建立，所以第一次打開不會寄出之前訂單的信；信件佇列不含個資、豁免 RLS、結束後
45 天刪除；寄出前寫日誌，訂單連結在寄出時才建立；店家還沒有公開聯絡 Email 時不設 Reply-To（EC-SPEC-10 §2.2、§6，
EC-SPEC-09 §2.4、§3）。工作與測試只用 fixture sender，不寄真的信。

wp04-queries 通過審查，合併為 `4f7b683b`（`fc/wp04-queries` `d87650fa`），合併後 typecheck 通過。審查找到五項，一輪修正
（`d641f427`～`d87650fa`）：到期工作只領取有處理程式的種類，新種類留給新版程式；重新付款不再被已有後續結果的「待確認」
擋住；交接發不出去時回它本身的 503，不再變成 1 秒後重試的「確認中」；import 移到檔頭；刪掉 Cloudflare README 過時的一句。
Codex 另外修了一個併發問題（`05295d2a`：兩個查詢同時遇到 403 時保留較長的暫停）。驗證付款的命令沿用帳戶命令既有的包裝：
店家停用回 403 `capability_denied`，商店實例停用回 409 `storefront_unavailable`，比上面的紀錄多一種；EC-SPEC-04 §1.2 已同步。
查到金額或交易號碼不符算確定結果，之後不再查詢（EC-SPEC-04 §6.2、decisions.md）。Codex 收尾的完整測試在修正輪前由整合者
中止，因為修正會改程式；合併後的整合驗證（含重跑 buyer-pay 的 E2E）與完整測試和第七批同時跑，結果記在下一次更新。

第七批（2026-10-16）：

| 工作 | CLI | 分支 | PostgreSQL | E2E |
| --- | --- | --- | --- | --- |
| wp04-seller | Codex `gpt-6.1-sol` xhigh | `fc/wp04-seller` | 55441 | 4741 |
| emails | agy `gemini-4-argon-high` | `fc/emails` | 55442 | 4742 |
| b07-live | agy `gemini-3.8-flash-high` | `fc/b07-live` | 55443 | 4743 |

三個工作從同一個 SHA 開出。emails 的新測試路徑先登記（`0090248d`）。b07-live 只加 E2E：B07 與 B06 不模擬任何 API，
用真的端點跑查詢付款結果、重新付款與同一訂單的查詢限額。

`151c0ba0` 的整合驗證：
- 都過：typecheck、契約、build、付款 runtime 573/573、checkout 258/258、商店 45/45、cloudflare 543/543、
  selector 42/42、未登記路徑 0、worker 123/123、E2E（查詢 14/14、付款 18/18、店面 15/15）、inventory。
- 完整 runtime（10:08Z～11:42Z）共 5906 項：5895 過、10 失敗、1 取消。
  - 路由矩陣的計數失敗：wp04-queries 新增的驗證付款路由沒有分類，`5dc52a16` 補上。
  - 其餘 9 個檔案的失敗都是全套負載下的 statement timeout、連線逾時與測試逾時。單獨重跑 223/223 通過，不是回歸。

路由矩陣補上這條路由後，非成員的請求回 429，不是 404。原因是帳戶的驗證付款額度（每小時 10 次）在授權之前就扣：
- 沒有權限的人可以用光店家的額度；
- 從 429 與 404 的差別可以知道帳戶存在。

`160417fe` 改成先做命令本身的授權（商店實例、`store:read`、owner／admin、帳戶查找）再扣額度，並加上回歸測試。
EC-SPEC-09 §4 同步（`b0a1c3b8`）。驗證：付款開通 32/32、路由矩陣 72/72、typecheck 通過。

b07-live 通過審查，合併為 `2586d796`。審查時刪掉一個沒用到的讀取函式。驗證：店面付款 E2E 11/11，三個新測試各重跑三次
9/9。`feat/freedom-commerce` 快轉到 `151c0ba0`。

接手快照（2026-10-17 01:50Z）：

Claude 達到額度上限後，Ted 授權 Codex 接手，並可使用 Grok CLI `grok-4.7` 與 agy CLI Opus 5.5。
目前可推送功能分支與更新 [PR #863](https://github.com/FreeTWAI/freedom-platform/pull/863)；合併 main 前仍須問 Ted。
部署、綠界連線（含 stage）與實際寄信沒有本批授權。下列是具版本的接手紀錄，不改寫前面的歷史狀態欄。

- `integ-11` 已包含賣家後端（`b65a47cd`）、交易信件（`318eeb4a`）、出貨設定與 migration 170
  （`d3219f0a`）、seller-console 與八分割 runtime（`49900aa2`），以及 main PR #870（`fc374412`）。
- `wp05-quote` 交付 `db997d6b` 已整合：正式 Node 與 Worker 都接上 SQL 本地運費報價。
  面交與既有可用物流設定可報價；供貨協議尚未實作的品項仍回 `fulfilment_not_agreed`，超商未選店仍不能下單。
  這不是整個 M3 完成；B05、物流啟用、正式選店與履約單仍是後續切片。
- `offline-core` 的設定、准入、凍結條款、下單、到期、賣家確認收款、面交交貨與主機接線已整合至
  `6c823444`（整合 `952ab161`）。其餘測試、文件與交付審查仍在進行。設定／契約測試由獨立工作負責，
  不與核心工作同時修改同一檔案。
- 整合者用正式 Node ports 跑過設定、准入、購物車、凍結條款、成立面交訂單、完成及重放，沒有覆寫 ports，
  也沒有 ECPay 帳戶、keyring 或 journal；相關 runtime 66/66、wrangler 52/52 與 typecheck 通過。
  `46272518` 另修正只有 Email 提供 journal binding 時，離線 profile 的排程不會封存日誌，以及離線設定版本與
  方法被日誌白名單丟掉的問題；實際 SQL/R2 與 codec 回歸先失敗 4 項，修正後日誌測試 35/35 通過。
- 已推送的 `b5dd3a74` 在 hosted run `38988236119` 的八個 runtime 分割與 aggregate 全過：6154 項、413 檔，
  最長分割 1082.229 秒，低於 1500 秒上限；九份產物的 digest、內容、來源 hash、分割聯集與清理證據均核對。
  同輪 UI 為 982 過、18 明示 skip、15 未跑、1 失敗、1 中斷；賣家 8 項與 chat-stickers 20 項都過。
  失敗是 AR-UI-05 的單次畫布像素斷言，tenant-ownership 是隨後中斷，不能把整輪寫成通過。
- AR trace 顯示先畫出圖卡，稍後畫布與連結都被清除；trace 未證實清除來源。`d1dde3f8` 讓同一像素斷言在原本 30 秒取得追蹤的期限內等待；
  保留真實影片辨識、90 秒案例上限及零重試。本機 AR 9/9 與 typecheck 通過，最終候選仍須重新驗證 hosted CI。
- 此快照的整合分支尚未推送。最終候選要完成合併後的 scoped runtime、資料目錄／retarget、Worker、瀏覽器與還原驗證，
  再跑一次完整 serial runtime。既有 T-047 還原 TODO（備份後撤銷的會員／邀請可能復活）保留，不能當完整還原驗收通過。

接手續記（2026-10-17 02:27Z）：

- Ted 撤回 Grok CLI 的使用許可；三個進行中的工作已停止，工作檔與提交保留，所屬 PostgreSQL 容器及 volume 已移除。
  剩餘工作由 Codex 接手。舊 Claude worktree 目錄已移除，提交保存在 Git 與獨立整合分支。
- `f6856e30` 已推送 PR #863，AR-UI-05 改為在同一次瀏覽器取樣中檢查可見連結與非空畫布。
  同樣保留 30 秒取得期限、90 秒案例期限及零重試。該候選的 AR、商店流程與賣家 browser 共 26/26 通過，
  typecheck、build、inventory、完整 context 通過。治理 suite 589/593；同一檔在並行負載下超過測試金鑰的
  60 秒有效期，單獨重跑 12/12 通過，兩份結果均保留。Hosted run `38994760099` 尚在排隊，不能算遠端通過。
- `offline-core` 後續提交 `48375889` 與設定／契約測試已由整合者審查，合入 `d6cb1fd4`。
  第一輪六檔 43/43 通過；之後補齊 fixture 型別、SQL 欄位／唯一性邊界與三種賣家命令的收據隱私斷言，
  四個受影響檔案 36/36 與 typecheck 通過。競態測試不再以重試掩蓋第一次競爭結果。
  使用真實過期訂單的寬限期補測，將隨完整整合驗證一起執行。
- `ab6c9204` 納入已推送的 AR 候選；`f421b684` 納入 main PR #872 的 client-read 相容性修正。
  下一步在固定候選上驗證 scoped runtime、資料目錄／retarget、Worker、還原、browser 與完整 serial runtime。
  本機整合尚未推送，未部署、未連線綠界、未寄信；main 合併仍須 Ted 決定。

接手驗證續記（2026-10-17 03:03Z）：

- `fe7dd76f` 的 typecheck、契約、build、inventory（5091 hashes／1715 links）、325 項 scoped runtime、
  593 項治理、562 項部署設定、42 項 selector、946 項 Python 契約與所有 Worker dry-run 通過。
- Worker 整輪 122/123；原生 main／broker 案例在服務呼叫的 40 秒期限後回 `model_broker_unavailable`。
  同一來源單跑 1/1 通過（39.35 秒），沒有修改期限；35 次資料庫觀察沒有阻塞樣本，但不能據此判定原失敗原因。
  兩份結果都保留，所屬 PostgreSQL 容器與 volume 已移除。
- 還原演練揭露三處過時的預期筆數：匯款 fixture 複製每個租戶的 checkout 聯絡資料後，合計應為四筆，
  每個租戶可見兩筆。修正總數、各租戶筆數與聯絡資料排序，保留未綁定租戶時零筆的要求。
  修正前完整演練與單檔都出現相同三項失敗並碰到外層 120 秒期限；修正後租戶還原單檔 8 項通過、
  1 項既有 T-047 TODO（10.30 秒），typecheck 通過。未改備份／還原實作、RLS、測試期限或 T-047。
- 完整還原、封存與瀏覽器驗證接續執行；之後完整 serial runtime 與新 head 的 hosted CI 並行。
  426 個 runtime 檔案均納入八分區，沒有遺漏或重複；排程權重不是實測通過證據。

訂單恢復授權修正（2026-10-17 03:28Z）：

- PR #863 的審查指出 access link 在原生 PostgreSQL 行鎖等待期間過期，仍能兌換。
  整合者先用完整 HTTP／受限 runtime role 重現：第一筆實際兌換暫持 transaction，第二筆 HTTP
  由 `pg_blocking_pids` 證實等待，資料庫時鐘跨過不可改的期限後回滾第一筆，舊實作仍回 200 與私有訂單。
  等待裝置鎖至連結過期也回 200；期限前成功的兌換時間則錯用等待前的時間。四個新案例先失敗三項。
- 修正先鎖定原 link 身分，再用另一 SQL statement 的資料庫時鐘檢查期限、撤銷與一次性狀態；
  裝置／grant／訂單處理後再查一次 link 期限。失敗回相同 404，整筆回滾，不留 redeemed marker、
  新 device、grant、cookie 或私有回應。未改 migration 168、trigger、固定 168 小時期限、token 或訂單範圍。
- 四個新流程修正後通過，包含期限前 rollback 後成功、新 B10 fixture 郵件恢復讀單、原 key 無法繞過
  forget，以及新 device 只取得該訂單權限。原有一般併發一次控制也通過。完整 HTTP 首輪 50/51：
  一處舊公開條款清單漏列已合併的 `offline_payment`；補上精確清單與卡片 fixture 必須為 null 的斷言。
  修正後 typecheck 與結帳核心／HTTP／schema／競態／郵件相關全套 168/168 通過（117.42 秒，零 skip）。
  訂單頁 7/7、browser 恢復旅程 6/6（零重試／skip／flaky）、build 也通過。
  隨後補驗新 device 已 INSERT、grant 等待訂單 FK 鎖期間過期的回滾，確認新 device 也不會留下；
  完整 HTTP 52/52 與 typecheck 通過。已同步 main `dc0f615d` 的 #867，新增治理測試 5/5；
  最終仍待 #871 的實際 main 整合、新 head 完整 CI 與獨立審查，不能用舊 head 綠燈代替。
- `fe7d0d1d` 已完成還原 10 pass／1 既有 T-047 TODO、封存 6/6、browser 75/75（零重試）。
  該來源的完整 serial runtime 因發現上述尚未修正的授權問題而主動中止，原日誌保留；中止不是全套通過。

### 2026-10-17：同步 #871 的實際 main

- 整合 main `08a832d3`（#871），保留訊息微秒排序、歷史分頁與收回刷新、真實 ACK 的測試修正。
  唯一文字衝突是檔案清單，依規則重新產生；沒有新增 migration，Commerce 的 168～170 未改號。
- 結帳 README 的公開條款清單補上既有 nullable `offline_payment`，與程式及 HTTP 精確清單一致。
- 此整合來源的 typecheck、相關 runtime、build、預設與圖片 fixture 瀏覽器，以及完整 runtime／CI
  尚待執行；前述 `ea6d4e47` 結果不能直接算成本次來源的全套通過。agy 初審未見程式阻塞，
  但規則全文尚未讀完，已要求補完，暫不算完整獨立審查；另將隔離移除最後期限檢查，
  驗證裝置鎖及訂單 FK 鎖兩個反例確實失敗，不修改交付分支的防護。

### 2026-10-17：CodeQL 合成銀行代碼修正

- `9a84f07c` 的 CodeQL check `117306013479` 失敗，兩項 annotation 均為還原／retarget
  fixture 的 `randomBytes(1)[0] % 900`。單一 byte 只能提供 0～255，原式無法涵蓋所需的 900 個值。
  兩處改用 `randomInt(100, 1000)` 產生三位合成代碼，未加 suppression；其他秘密材料仍由
  原本的安全亂數產生。卡片 checkout 另建銀行 frozen terms、RLS 與還原斷言完全保留。
- `9a84f07c` 已完成 typecheck、相關 runtime 218/218、build、inventory；預設 browser 37/38，
  私訊顯示新訊息的原 5 秒斷言失敗。保持原程式及斷言單跑 1/1、圖片 fixture 18/18 通過，
  原失敗保留，原因未確定。agy 已補完 96 份規則全文並確認 access-link 聚焦範圍無阻塞；
  隔離移除最後期限檢查時，裝置／訂單鎖兩反例均以 200≠404 如預期失敗。
- 已保留上述失敗與中止紀錄。Verify run `39001723029` 為修正已知 CodeQL 阻塞主動取消；
  本機 serial runtime 在中止前有 107 個通過標記、零失敗標記，但不是全套通過。
  修正後仍須驗證完整 retarget／還原、typecheck、最終來源完整 CI／CodeQL 與 serial runtime。

### 2026-10-17：離線／運費整合後的完整 runtime 修正

- `ec3adc97` 的 CodeQL 已通過。Verify `39002910800` 的八份 runtime 與 aggregate ZIP
  均核對 digest、candidate `91aa27e4`、父節點及 426 檔來源；6,254 案有 11 案失敗，
  沒有 skip／todo／cancelled。最長分區 1,150.196 秒，沒有觸及 1,500 秒上限。
  分區 1 的 871 案雖全過，DROP 後仍觀察到 database_present，清理不合格，aggregate 失敗。
  其 checkpoint 僅 0.098 秒；後續 DROP 的 query_read_timeout 原因未確定，未改清理期限或 guard。
- 同一乾淨 `ec3adc97` 重現四份 Commerce 檔案 104/114、賣家 view 17/18。
  排程 fixture 沒有注入新增離線到期工作會用到的 due-work port；補齊隔離 port，保留 exact log、
  quarantine 與後續工作斷言。Worker 及真實 offline expiry 不改回依賴金流金鑰。
- 准入 fixture 接上實際卡片付款 port 與同一封存 keyring，金額符合原有 5 元最低額；保留獨立管理員、
  跨社群拒絕、撤銷准入後讀取保留訂單與到期釋放。下單階段的四種不合法條款 fixture 在凍結時隔離
  兩個 quote-time gate，下單前還原實際 ports，原 409 中文訊息及零副作用斷言全部保留。
- 買家付款頁的卡片 DTO fixture 補齊 `payment_method`、nullable `payment_grace_until` 與
  `offline_instructions`。賣家既有警示區補齊五個物流錯誤的下一步提示，不改頁面結構或 API 權限。
- 修正後 typecheck 與八份相關 runtime **212/212** 通過（192.84 秒，零 skip／todo／cancelled），
  包含真實離線到期、due work 與結帳核心；所屬磁碟 PostgreSQL 容器及 volume 已清理。
  build 及付款／賣家 browser **22/22** 通過（43.1 秒，零重試／skip）；五種物流提示在既有
  警示區的前後畫面各 1 案通過，390／768／1440 均無橫向溢出，桌面、平板與手機截圖已檢視。
  首次額外視覺腳本因外部 config 的相對工作目錄在啟動測試前拒絕；修正腳本 cwd 後執行，原錯誤保留。
  完整 serial runtime、新 head 全部必要 CI 與 code-owner 審查仍須各自完成。
  舊完整 serial runtime 因已知 Commerce 阻塞中止，保留中止前五項實際失敗，不把中止後的 pending
  promise 訊息當新案例失敗，也不宣稱整輪通過。

### 2026-10-17：聊天撤權的第三種 HTTP 順序

- `ce9cba16` 的 Verify `39005304736` 八區及 aggregate 已通過：426 檔、6,254/6,254 案，
  零失敗／skip／todo／cancelled、八區清理成功，最長 1,122.732 秒。九份 ZIP、來源 hashes、
  互斥完整聯集及 candidate `3dfe1609` 的父節點 `[08a832d3, ce9cba16]` 已核對；CodeQL 亦通過。
  該來源的整輪 UI 失敗，不能把 runtime 成功稱為整輪成功。
- Browser artifact `12091641685` 的 ZIP、listing 及兩份 raw report digest 已核對。
  原 `chat-stickers` manual-first 在第 362 行等 activity 404，5 秒內計數仍為零。
  Trace 顯示真實貼圖 POST 201 後丟失 ACK、activity 200、其後自動 messages GET 404；頁面已撤權，
  下一輪 activity 停止，因此原 fixture 等待的事件不會再出現。測試與產品檔皆來自 actual main #871。
  default 兩區共 993 passed；另有一個實際失敗、一個中止、skip 與未執行案例，後五個 fixture 模式未跑。
- 原 activity-first／manual-first 現在分別控制真實 activity 請求讀取及回應交付；不關 polling、不偽造
  授權回應。新增 history-first：先取得看到已提交訊息的真實 activity 200，撤權後才交付，確認自動
  history 404 先於手動操作。三種順序均保留隱藏內容、返回原 pending、無權／恢復後重查零 POST、
  明確重試同 body／key／message_id，以及一 message／一 receipt 的完整斷言；finally 釋放全部 gates。
- 相同產品來源的受控反例在已確認 history 404 警示後保留原 activity 計數斷言，精確重現原 5 秒失敗。
  修正後三種順序 **3/3**（29.6 秒、零 retry／skip）、typecheck、build 通過。完整貼圖及兩份頻道
  流程為 **40/41**（343.5 秒、零 retry／skip），保留唯一 manual-first 的新失敗：真實手動 GET 404
  在約 5 毫秒內收到，原 5 秒 DOM 斷言未觀察到警示；trace 的撤權 DOM snapshot 在斷言期限後、
  gated activity 回應交付前才出現。此畫面更新延遲原因未確定，沒有改產品、斷言期限或重試數。
- 上述受控／回歸使用獨立 worktree、磁碟 PostgreSQL、單一 browser worker 及重工作鎖，所屬兩個容器
  與 volume 已清理；與原 `ce9cba16` serial runtime 同時執行的事實亦保留。原 serial 的配對、grant、
  execution-run 與 guild-entry 失敗標記在這批診斷前已出現，仍等原 reporter 的完整 assertion／hook
  摘要，不因 hosted 全過或同 main 而稱無關。原 PostgreSQL 的三筆 statement timeout 訊息已保存，
  尚不把時間相近視為每個案例根因。serial 完成後需做一次同來源、單獨執行的訊息流程對照。
  最終來源的必要 CI 與 code-owner 核准仍待完成，合併 main 前仍須 Ted 確認。

### 2026-10-17：53aa 驗證完成與 code-owner 的兩項修正

- `53aa3486` 的 Verify `39009777021` 全 17 jobs 與 CodeQL `39009774355` 通過。
  同 run 的 runtime 九份 artifact 已獨立核對：426 檔、6,254/6,254、八區 cleanup=true，
  最長 1,257.906 秒；source artifact 的父節點／tree／5,095 checkout files 已核對。
  Browser artifact 為 165 檔／1,044 唯一案例、六模式全成功；default 是 1,007 passed／18
  fixture-OFF skipped，後五模式補足覆蓋。成功 artifact 只保留 raw report digest references，
  因此不宣稱已讀回 raw Playwright JSON 或 browser DB 清理證明。
- 原本機 serial 已完整結束：6,223 passed、31 failed cases、2 after-hook file failures，
  Node totals 為 6,256 tests／33 failed，零 cancelled／skip／TODO，7,297.3 秒、exit 1。
  guild-entry／tenant-ownership 的 shared before 建 schema 連線逾時分別影響 8／13 案，
  after 清理各另算一個檔案失敗；另有四個 beforeEach TRUNCATE、model fixture INSERT 的
  57014、device positive exchange 503、machine approval 503、client blocker 觀察失敗及
  skill-book 兩項被 predicate 遮蔽的原始錯誤。沒有從相近時間的 DB 訊息推定全部根因。
  測試原始輸出、完整 PG logs 與來源 hashes 均保留，精確容器／磁碟 volume 已核對移除。
- 同來源、原期限、零重試的單次獨立對照：完整訊息三檔 **41/41**（175.8 秒），原失敗所在
  完整 runtime 十一檔 **251/251**（330.3 秒）；兩批容器／volume 均已核對移除。
  這些對照不取代原 40/41 browser 與失敗 serial，也不證明原共享主機上的延遲原因。
  補正 trace 證據界線：11 份可逐 byte 核對的資產全部是 CSS；28 個 JavaScript 請求沒有保存本文。
- Code-owner review `5556812783` 要求修改。P1：quarantine 下 shipping、offline bank、provider
  account／credentials／logistics 仍可寫入。現於平台 storefront 根路徑與子路徑的 member 邊界
  統一拒絕非 GET／HEAD／OPTIONS 的請求；同時涵蓋 upgrade、商品、商店、媒體與分銷設定。
  保留 GET 的能力檢查及投影，不讓 fulfilment 引入 operations 依賴；刪除 README 的未核准例外。
  真實 HTTP 反例分別收到 201／201／200／200，原本應為 `503 commerce_quarantined`。
  新測試比較完整 Commerce／hosted rows、receipt、journal、fresh proof 與 tenant／instance
  版本，並以同 key／body／proof／version 在解除 quarantine 後成功執行每項受測命令。
- P2：Email expiry 與 retention 掃除先鎖 Email 再刪 due-work，與投遞相反。兩個控制案例均以
  真實 delivery 在持有 due-work 鎖後的 barrier 重現 PostgreSQL `40P01 deadlock detected`。
  掃除改為候選無鎖讀取、due-work 先鎖、Email 後鎖，兩步均 `SKIP LOCKED`；排除未取得
  due-work 鎖的 Email，且只刪本交易已持鎖的工作 ID。修正後兩個重疊案例均成功，保留未處理
  列的 lease／attempts，處理另一個不忙碌候選，且 delivery 不產生外部呼叫。
  typecheck 與 14 個完整相關 runtime 檔案 **121/121** 通過（164.2 秒，零 skip／TODO／cancelled）。
  測試用容器與精確磁碟 volume 已核對移除。首次治理測試在尚未提交的 worktree 執行，
  598 案有 11 項失敗：九項 runtime-matrix 被 `runtime_source_changed` 的乾淨來源守門拒絕，
  另兩項 child-process status 為 null（CircleCI fixture／ingest reporter；原始期限未調整）。
  原輸出保留；提交後須以乾淨來源完成治理驗證，不把未提交來源的失敗稱為成功。
  新來源 CI 與 code-owner 核准仍待完成，合併 main 前仍須 Ted 確認。
- 買家 B05→B07 的剩餘範圍保持明示：後端已凍結 `payment_method`、`offline_instructions`、
  `payment_grace_until`，但 storefront 頁面尚未消費這些欄位，缺銀行帳號複製、面交指引、
  付款期限與取消入口。後續需驗證選擇方式→凍結訂單→B07→賣家確認→重新登入，以及取消／
  結果不明恢復、版本過期、忘記連結／裝置、撤權清除與零額外 payment attempt；目前旗標關閉，
  不稱完整離線買家體驗已交付，亦不是本次新增 review blocker。

### 2026-10-17：隔離 middleware 的路由盤點補齊

- `195eb8a2` 的 Verify `39015627503` 第 7 區有 1,050 案，唯一失敗在
  `tenant-route-matrix` 的路由清單檢查；同檔其餘 71 案通過。該區 837.489 秒完成且
  `database_cleanup_verified=true`，不是容量或清理失敗。ZIP digest 與候選來源已保存。
  八區與失敗 aggregate 的九份 ZIP／解壓內容、427 份來源 hashes、候選父節點與完整互斥
  聯集已獨立核對：**6,259 passed／1 failed**，零 skip／TODO／cancelled，八區 cleanup=true，
  最長 1,135.682 秒。aggregate 正確拒絕此失敗結果，未將七區成功拼成通過。
- 乾淨同來源的完整 72 案本機反例精確重現 **71 passed／1 failed**：預期路由數 160，
  實際 162（15.98 秒，零 skip／TODO／cancelled）。新增 storefront 根路徑與 wildcard 的
  quarantine middleware 需要與既有 cache middleware 一樣登錄在嚴格分類表中。
- 補入兩條 `ALL` middleware 分類，middleware 預期 8→10、總路由 160→162。
  每一已掛載路由必須被分類、每一分類必須實際存在的雙向斷言及完整 ACL／RLS 矩陣均保留。
  產品、migration、Email 鎖順序與 quarantine 邊界的程式 bytes 維持 `195eb8a2`。
  typecheck 與完整路由／隔離回歸 **76/76** 通過（21.69 秒，零 skip／TODO／cancelled），
  路由矩陣實際執行 2,763 次 request，同一 runtime-role connection 且 context 清空。
  前後兩批測試的容器與精確磁碟 volume 均已核對移除；新來源 CI 仍須另跑，
  不把 195e 的失敗整輪稱為通過。195e 的乾淨治理測試 598/598 及新的 CodeQL 成功另行保留；
  額外 AGY／Opus 5.5 複核因 CLI 內容過濾錯誤中止，沒有採用為 review approval。

### 2026-10-17：#863 合併與離線買家頁補齊

- Ted 已在本次對話授權結案、正常合併與部署，並撤回 Grok 使用授權；早先快照的「合併前再問」不再適用。
  AGY Opus 5.5 額度不足，這輪由 Codex 接續，沒有將失敗的 CLI 呼叫稱為審查。
- [PR #863](https://github.com/FreeTWAI/freedom-platform/pull/863) 於 2026-10-17 10:16:58 UTC
  正常合併為 `1ae0d0a40219cf8cd80c12f9d515a4ce242afaf8`，mergedBy `teddashh`；未 bypass。
  `e737f79c` 的 code-owner review `5557024538` 是 AI-assisted review，不冒充真人驗收。
  Verify [39017464361](https://github.com/FreeTWAI/freedom-platform/actions/runs/39017464361)
  17 jobs 通過；runtime **6,260/6,260**、427 檔、八區清理通過、最長 1,333.022 秒。
  UI 六種 fixture mode 合計 **1,044** 個不重複案例；主模式 18 項預期 skip 由其他模式覆蓋。
  runtime 九份 ZIP／來源／互斥聯集及 browser aggregate 已獨立讀回；沒有留存全部原始 browser report，
  不宣稱其逐案原始報告與 browser cleanup 已獨立驗證。合併後 main Verify
  [39024313796](https://github.com/FreeTWAI/freedom-platform/actions/runs/39024313796) 亦為 17 jobs 成功。
  此段不改寫先前失敗與取消的結果，也不等於已部署 schema170。
- 後續 `fc/offline-buyer-flow` 以該 merge 為基底，實作 B04→B05→B07 的最小離線流程：
  面交／宅配收件、server 報價與付款選項、凍結條款、最後確認，及私有的匯款帳號、複製、
  面交說明、期限／72 小時寬限、取消與店家確認後重讀。超商選店與發票／售後仍待既有後續工作。
  公開 checkout terms 不輸出銀行資料；B07 的面交說明來自凍結的配送群組，新增 optional `meetup_notes`。
- 登入但尚未建立 person principal 的新會員現在可在唯讀報價看到線下方式；正式 checkout 才建立映射。
  已停用的 principal 仍被拒絕。前端只在 tab sessionStorage 保存原 checkout ref、terms hash、付款方式與
  client order ID；回應不明或刷新沿用同一筆下單，不保存聯絡資料、帳號或 checkout key。
  既有訂單頁加強完整 DTO／商店與訂單座標檢查、失效與忘記裝置清除，以及晚到回應的隔離。
- 本機磁碟 PostgreSQL 的 5 項新 browser 情境、26 項既有 browser 回歸、30 項 runtime、typecheck
  與 build 通過；390／768／1440 截圖已檢視。首次 browser **1 passed／2 failed** 保留：
  成功下單立即導頁後，測試讀取舊 response body 失敗；改為在真實回應送到頁面之前捕獲，不替換業務回應。
  重跑及原始測試容器／精確 volume 均已核對移除。`2e8dbba1` 的欄位旁錯誤、輸入保留與
  response payment method 檢查再次通過相同 5／26／30 項測試、typecheck 與重新 build。
- PR #875 的 `2e8dbba1` hosted Verify
  [39028228960](https://github.com/FreeTWAI/freedom-platform/actions/runs/39028228960) 中，UI 全模式
  1,049 案通過；runtime 427 檔 6,261／6,262 通過，八區 cleanup 均成立。
  唯一失敗在既有 `github-social.test.ts`（54／55，`testCodeFailure`）；hosted 未保留原始 assertion。
  不改原碼的本機對照為 55／55，不能據此認定根因或把原失敗改列成功。
- `detna-vibe-coding` 的獨立 AI-assisted review 在 `2e8dbba1` 提出 P2：遺失下單回應後，
  另一分頁修改購物車，重新載入再重送原 intent，可能清除新的購物車。真實 browser 先重現
  「數量 2 的購物車變成 null」。修正採恢復 intent 時保留目前購物車；一般下單仍只清除
  本頁送出的原購物車，不增加 sessionStorage 的商品或個資內容。
  修正後 typecheck、重新 build 與 6／6 browser 案通過；確認跨分頁購物車保留、相同重送座標、
  只建立一筆原數量訂單，以及一般下單的購物車清除。原重現失敗的 trace／截圖與 log 保留。
- 此後續來源仍待修正後的 hosted CI、再次 source review、合併及雲端驗收。
  不更新 Foundation 168 項要求為 accepted，不宣告完整 M3／M4、真實金流、物流、寄信或商家採用完成。

### 2026-10-17：離線買家流程合併與限定部署完成

- #875 已正常合併為 `d39370a17d1d1d6af2507acd9ee7b592ff221a21`；精確 head `0d700e1d7f5e919b629f52eb2e9fd3c765db7e32` 的 Verify
  [39037614076 attempt 2](https://github.com/FreeTWAI/freedom-platform/actions/runs/39037614076)
  17 jobs、runtime 435 檔／6393 案與 browser
  1105 個不重複案例通過。來源、同一 attempt 的八區清理／聯集、UI、
  CodeQL、worker 與獨立 AI-assisted source review 已分別讀回；原失敗保持原結果。
- #863／schema168–170 與後續買家版本／主線 schema171 已依序部署 staging、production。
  實際 before／after 的 DB＋物件備份、完整隔離還原、保留 floor 與清理通過；新 daily operator
  已安裝並恢復原 timer，自然排程未驗。詳見[具日期部署收據](../unified-foundation/rollout-commerce-buyer-2026-10-17.json)。
- Commerce console／checkout／email仍 OFF；未開放真實商家或 provider 交易。供應商 console
  保持 staging ON、production OFF。Production 未做會員登入／browser／OAuth驗收。
  本輪工程與限定部署已結案，完整 M3／M4、原168項 Foundation要求、T-047及真人驗收仍按原缺口追蹤。

## 6. 共用檔案

| 檔案 | 誰改 | 規則 |
| --- | --- | --- |
| `migrations/16x_*.sql` | 該里程碑的主工作 | 一個里程碑一個檔案。編號在整合時依 main 決定；Supplier Console 的 S3 誰先合併誰取下一號，後到的一方改號並更新全部登錄點（WP-00 §4） |
| `deploy/cloudflare/environments.json`、`lib/release-compatibility.mjs`、`release-compatibility.md`、`deploy/cloudflare/test/*` | 帶 migration 或能力的工作 | 同一時間只有一個工作改 |
| `apps/platform-api/src/platform-app.ts`、`worker.ts`、`server.ts`、`runtime.ts`、`app.ts` | wp03-http，之後 wp04-* | 同上 |
| `modules/module-data/catalog.ts` | 帶新表的工作 | 同上 |
| `modules/module-registry/definitions.ts`、`contracts/guild-launchpad/v1/tenant.ts` | wp04-accounts | 同上 |
| `docs/platform-plan/verification/2026-09-20-file-inventory.json` | 每個工作最後重產 | 合併衝突一律重產，不手改 |
| `modules/agent-commerce/freedom.module.json` | 不改 | 已有 64 條路徑；新路徑放新的 descriptor（§7） |
| `modules/agent-commerce/supplier-console/**`、`HostedStore()` 的路由、App 的離開提示 | Supplier Console 工作階段 | commerce 的工作不改 |

## 7. descriptor

`owns()` 只認精確路徑與結尾的 `/**`；每個 descriptor 最多 64 條，含自己（EC-SPEC-09 §6）。新增路徑後跑 unknown-paths 與 selectImpact 的 owner 檢查。

| descriptor | 路徑 | 相依 | 狀態 |
| --- | --- | --- | --- |
| `hosted-checkout` | `modules/agent-commerce/checkout/**`、M1 migration、checkout 測試 | `agent-commerce` | 已登錄（wp03-core）；purchase-state 測試（`61f329e6`） |
| `commerce-providers` | `modules/agent-commerce/providers/**`、協定測試與向量 | 無 | 已登錄（ecpay-proto；ecpay-aio、ecpay-logistics 加上各自的測試與匯出） |
| `commerce-invoices` | `modules/agent-commerce/invoices/**`、發票測試；M4 起加 migration | `commerce-providers`（發票 Email 規則 `isInvoiceEmail`）；M4 加 `hosted-checkout`、`commerce-payments` | 已登錄（invoice-rules；invoice-rules-fix1 加上相依） |
| `commerce-operations` | `modules/agent-commerce/operations/**`：主機設定、准入、能力清單、信件、外部效果日誌、報表與漏斗（EC-SPEC-10 §10、EC-SPEC-07 §8）；准入的 admin 路由與測試、信件範本的測試 | `hosted-checkout`、`commerce-fulfilment`（信件的物流名稱） | wp03-http 建立；准入與信件範本的路徑在派工前登錄 |
| `commerce-payments` | `modules/agent-commerce/payments/**`、M2 migration（169）、`hosted-commerce-setup` 的路由與契約、帳戶與升級的測試、封存的 workerd 測試 | `hosted-checkout`、`commerce-providers`、`commerce-operations`（控制事件） | 已登錄（refund-rules）；wp04-accounts 的路徑在派工前登錄；wp04-payments 再補 |
| `commerce-fulfilment` | `modules/agent-commerce/fulfilment/**`、官方貨態表 `ecpay-logistics-status-map.tsv`、M3 migration、履約測試 | `commerce-providers`（CDN 字詞檢查）；M3 加 `hosted-checkout` | 已登錄（fulfil-rules；fulfil-rules-fix2 加上相依） |
| `commerce-aftersales` | `modules/agent-commerce/aftersales/**`、售後測試 | `hosted-checkout`、`commerce-payments` | M4 |
| `commerce-storefront` | `modules/agent-commerce/storefront/**`（買家頁的 server HTML）、`apps/portal-web/src/storefront/**`（店面 client bundle）、買家頁的 runtime 與 E2E 測試 | `agent-commerce`、`hosted-checkout` | buyer-orders 派工前登錄；buyer-cart 的三個測試在派工前登錄（`61f329e6`） |

## 8. 與 Supplier Console 的接點

分工見 README：Commerce 負責訂單、庫存、履約、發票的領域、migration、命令與 adapter；Supplier Console 負責 SL-01～05 的頁、供應商用的讀取投影、`HostedStore()` 的路由、App 的離開提示與共用的 console 殼。

| 項目 | 方向 | 內容 | 狀態 |
| --- | --- | --- | --- |
| 訂單與庫存核心 | Commerce → Supplier | `fc/wp03-core` `16caa586`：`recordHandover`、`restockReturn`、`cancelPaidOrder`、確認付款的定義、`reserved = H + A` | 2026-10-15 已通知 SHA；已併入整合分支（`d3cbb286`），尚未進 main |
| 共用 console 殼 | Supplier → Commerce | `863614ef` 抽出的共用殼；E 頁沿用同一個殼與導覽樣式（`ea24fbf6` 的導覽字級 .875rem） | 在 `feat/supplier-console-r1`，尚未進 main |
| `FREEDOM_SUPPLIER_CONSOLE_ENABLED` | Supplier → Commerce | commerce 的 `CONSOLE` 開關依賴它（EC-SPEC-10 §2.2）。它進 main 之前，wp04-seller 加的 `CONSOLE` 只依賴 launchpad，只開賣家的新路由、沒有 E 頁；進 main 後加上對它的依賴 | 在 `feat/supplier-console-r1` 的 `worker.ts` |
| 「已占用」的文字 | Supplier | `stock − reserved` 的說明改成含已付款未出貨，跟 M2 同一次發布 | 依 M2 |
| 履約契約與 SL 頁 | Commerce → Supplier | M3 的 `contracts/guild-launchpad/v1/` 新檔與讀取投影；SL 頁等 Commerce 交 SHA 才開始 | 依 M3 |
| migration 編號 | 雙方 | Commerce 的 M1～M4 與 Supplier 的 S3 依合併順序取號 | 整合時決定 |

雙方都會改的共用檔（spec index、file inventory、`generate-contracts`、guild-launchpad 契約測試）在整合時合併，衝突時兩邊都保留。

## 9. 埠與資料庫

- PostgreSQL 用 55441～55449，E2E 用 4741～4749，第 n 號工作用第 n 個。55441 是 wp03-core，55448 是整合者的審查，55449 是整合後的完整測試。
- 每個工作建立自己的一次性 PostgreSQL 18 container：只綁 127.0.0.1、資料放磁碟（不用 tmpfs）、資料庫名稱以 `fp_` 開頭，工作結束就 `docker rm -fv`。不用共用的 54339。
- 啟動 CLI 的腳本先載入該工作的環境檔（`TEST_DATABASE_URL`、`FREEDOM_E2E_PORT`），所有子行程都繼承；環境檔指向 54339 時拒絕啟動。2026-10-15 wp04-accounts 有一次 worker 測試命令漏帶 `TEST_DATABASE_URL`，幾個舊測試改連預設的 54339，連線被拒（`ECONNREFUSED`），沒有執行任何 SQL；之後加上這條。
- 重的命令（typecheck、build、多檔 runtime、E2E、worker 測試）跨工作一次只跑一個，經同一把檔案鎖（`flock`）排隊：主機與其他專案共用，2026-10-15 曾因記憶體不足終止 CLI。完整 runtime 測試是序列執行、要幾個小時，不進鎖，每個工作最後只跑一次。
- 改了前端先 `npm run build`，再跑瀏覽器測試。

## 10. 每個工作的交付

- 工作說明（brief）列：要讀的規格與報告、精確的檔案範圍、編號的建構項目、驗收條件、確切的驗證命令、commit 格式、回報格式。
- 回報列：commit、實跑的命令與結果、`not_run` 與原因、刻意沒做的事、對規格的疑問。
- 整合者的審查：重跑測試、逐檔讀差異、對照規格與官方文件；發現問題就開修正輪。通過後才合併，並把 SHA 交給相關的工作階段。
