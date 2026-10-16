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
| EC-WP04 金流與退款 | 收款帳戶與金鑰、PaymentPort、ECPay AIO、通知與查詢、退款、對帳 | EC-SPEC-04 | WP03 | M2 | 協定函式庫與 AIO 信用卡協定通過審查（`fc/ecpay-proto` `67d9ba2e`、`fc/ecpay-aio` `b836419e`），已併入整合分支；退款分攤的純規則通過審查（`fc/refund-rules` `4376e471`，整合 `69067716`）；收款帳戶、封存金鑰、店家准入與商店 1.1.0 完成（`fc/wp04-accounts` `bfab7559`，整合 `38e8db3b`）；付款拆成四個工作（§4），wp04-payments 進行中 |
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
| buyer-checkout | B05、B06（付款前） | 之後決定 | buyer-cart；M3 的配送資料與選店、M4 的發票欄 | 之後 |

M1 沒有店家准入表（M2），所以正式與 staging 都還不能成立 `hosted_checkout` 訂單；M1 的驗收是不影響 v1 預留，加上本機與 CI 的測試（EC-SPEC-10 §4.6）。

**M2 收款（`commerce.hosted-payment.v1`）**

| 切片 | 內容 | CLI | 依賴 | 狀態 |
| --- | --- | --- | --- | --- |
| ecpay-proto | 綠界協定函式庫 | argon | — | 完成 |
| ecpay-aio | AIO 的送出內容、通知的驗證與解析、查詢結果對照、API 退款，全部是純函式加官方向量（EC-SPEC-04 §3.4、§5.2、§6.2、§7.3） | argon | ecpay-proto | 完成（`fc/ecpay-aio` `b836419e`，整合 `d6fa9098`） |
| wp04-accounts | 收款帳戶與封存金鑰；重新確認身分的新用途；`storefront@1.1.0`、`hosted-store@1.1.0` 與升級；入口路由；店家准入；設定變更的控制事件（EC-SPEC-04 §1、EC-SPEC-09 §2.2～§2.5、EC-SPEC-10 §2.5、§8.2） | Codex | wp03-http | 完成（`fc/wp04-accounts` `bfab7559`；整合 `21e46a73`、`4b83fe1c`，修正輪 `38e8db3b`） |
| refund-rules | 退款分攤的純規則：行項上限、運費建議、分攤與調低的檢查、未套用付款的退款（EC-SPEC-06 §2.5、EC-SPEC-04 §7.2） | flash | — | 完成（`fc/refund-rules` `4376e471`，整合 `69067716`） |
| wp04-payments | attempt 與一次性交接頁、付款通知與瀏覽器返回（含閘道例外）、外部效果日誌、到期工作與例外的表、買家的付款摘要、隔離模式的付款閘門、能力 `commerce.hosted-payment.v1` 與強制下限；不呼叫綠界（EC-SPEC-04 §3～§5、EC-SPEC-09 §2.6、EC-SPEC-10 §3） | Codex | wp04-accounts、ecpay-aio | 進行中（`fc/wp04-payments`） |
| wp04-queries | 查詢與到期工作的執行（用 `commerce_due_work`，不建 outbox）、排程與即時執行、確認窗結束、重新付款、按需查詢、收款服務的驗證付款（EC-SPEC-04 §1.4、§4.3、§6） | Codex | wp04-payments | 之後 |
| wp04-refunds | 退款紀錄、API 退款與人工紀錄、結果不明的退款（EC-SPEC-04 §7、EC-SPEC-06 §2.5） | Codex | wp04-queries、refund-rules | 之後 |
| buyer-pay | B06 待付款與付款返回、B07 的「前往付款」與「查詢付款結果」 | argon | wp04-payments；查詢按鈕要 wp04-queries | 之後 |
| E 殼與 E05、E09、E11 | 訂單、收款、設定頁；`CONSOLE` 開關（依賴 Supplier Console 的旗標） | argon | 共用殼進 main；wp04-accounts | 之後 |
| 信件範本 | 五封買家信件的純文字範本，README 的範例由測試核對（EC-SPEC-10 §6.1） | flash；修正輪 argon | — | 完成（`fc/email-templates` `04916980`，整合 `0bc97559`） |
| 信件列與寄送 | 信件列、`EmailPort` 的正式實作、到期工作寄送、fixture sender（EC-SPEC-10 §6.3、§6.4） | 之後決定 | 信件範本、wp04-payments | 之後 |

**M3 履約（`commerce.hosted-fulfilment.v1`）**

| 切片 | 內容 | CLI | 依賴 | 狀態 |
| --- | --- | --- | --- | --- |
| fulfil-rules | 配送分組與拆包、運費、收件資料檢查、貨態代碼對照，全部是純函式（EC-SPEC-05 §3.2～§3.5、§6.3、§6.4） | flash | — | 完成（`fc/fulfil-rules` `5c8d8379`，整合 `f941a48b`；CDN 修正輪 `d44f1d1d`，整合 `f38b9a08`） |
| ecpay-logistics | 選店、建單、列印、貨態通知與查詢、7-ELEVEN 店到店取消與改門市的協定（EC-SPEC-05 §5～§7）；共用的 CDN 字詞檢查，AIO 一併套用 | argon | ecpay-proto、ecpay-aio | 完成（`fc/ecpay-logistics` `1f99faeb`，整合 `f7711535`） |
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
| `FREEDOM_SUPPLIER_CONSOLE_ENABLED` | Supplier → Commerce | commerce 的 `CONSOLE` 開關依賴它（EC-SPEC-10 §2.2）；它進 main 之前，commerce 不加 `CONSOLE` | 在 `feat/supplier-console-r1` 的 `worker.ts` |
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
