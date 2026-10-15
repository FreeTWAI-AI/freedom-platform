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
| EC-WP03 結帳與交易模型 | 顧客、checkout、訂單、N／H／A、付款後配置、出貨與退回的庫存效果；公開結帳路由與訂單存取 | EC-SPEC-02 §4～§5、EC-SPEC-03 | WP00 | M1 | 領域核心通過審查（`fc/wp03-core` `16caa586`），已併入整合分支；路由、主機設定、排程、能力下限由 wp03-http 進行 |
| EC-WP04 金流與退款 | 收款帳戶與金鑰、PaymentPort、ECPay AIO、通知與查詢、退款、對帳 | EC-SPEC-04 | WP03 | M2 | 協定函式庫與 AIO 信用卡協定通過審查（`fc/ecpay-proto` `67d9ba2e`、`fc/ecpay-aio` `b836419e`），已併入整合分支 |
| EC-WP05 物流與供應商補充 | 出貨設定、配送群組、選店、託運單、標籤、貨態、例外、退回 | EC-SPEC-05；SC-SPEC-07 | WP03；WP04 的協定與排程 | M3 | 未開始 |
| EC-WP06 發票與售後 | 發票、更正、對話、RMA、退款分攤、供貨帳 | EC-SPEC-06 | WP03～05 | M4 | 發票純規則通過審查（`fc/invoice-rules` `a9cb0ebf`），已併入整合分支 |
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
| wp03-http | 公開結帳路由（EC-SPEC-02 §5.2～§5.4）；訂單存取憑證與 B10（§4.2，fixture sender）；結帳的限流（EC-SPEC-09 §4）；主機設定 `CHECKOUT`、`QUARANTINE` 與 `site` 布林（EC-SPEC-10 §2.2、§2.3）；到期預留接上排程（§5）；能力、SHAPE 與 168 的強制下限（§3）；同意版本與配送 JSON 的檢查；還原演練補上 168 的 RLS 表 | Codex | wp03-core | 進行中 |
| 買家頁 | B03 加入購物車、B04、B05、B06（付款前）、B10 | argon | wp03-http 的契約 | 之後 |

M1 沒有店家准入表（M2），所以正式與 staging 都還不能成立 `hosted_checkout` 訂單；M1 的驗收是不影響 v1 預留，加上本機與 CI 的測試（EC-SPEC-10 §4.6）。

**M2 收款（`commerce.hosted-payment.v1`）**

| 切片 | 內容 | CLI | 依賴 | 狀態 |
| --- | --- | --- | --- | --- |
| ecpay-proto | 綠界協定函式庫 | argon | — | 完成 |
| ecpay-aio | AIO 的送出內容、通知的驗證與解析、查詢結果對照、API 退款，全部是純函式加官方向量（EC-SPEC-04 §3.4、§5.2、§6.2、§7.3） | argon | ecpay-proto | 完成（`fc/ecpay-aio` `b836419e`，整合 `d6fa9098`） |
| wp04-accounts | 收款帳戶與封存金鑰；重新確認身分的新用途；`storefront@1.1.0`、`hosted-store@1.1.0` 與升級；店家准入（EC-SPEC-04 §1、EC-SPEC-09 §2.2、§2.3、§2.5、EC-SPEC-10 §2.5） | Codex | wp03-http | 之後 |
| wp04-payments | attempt、交接頁、通知入口與閘道例外、查詢與到期工作、退款、外部效果日誌、隔離模式 | Codex | wp04-accounts、ecpay-aio | 之後 |
| E 殼與 E05、E09、E11 | 訂單、收款、設定頁；`CONSOLE` 開關（依賴 Supplier Console 的旗標） | argon | 共用殼進 main；wp04-accounts | 之後 |
| 交易信件 | 信件列、範本、fixture sender（EC-SPEC-10 §6） | flash | wp03-http | 之後 |

**M3 履約（`commerce.hosted-fulfilment.v1`）**

| 切片 | 內容 | CLI | 依賴 | 狀態 |
| --- | --- | --- | --- | --- |
| fulfil-rules | 配送分組與拆包、運費、收件資料檢查、貨態代碼對照，全部是純函式（EC-SPEC-05 §3.2～§3.5、§6.3、§6.4） | flash | — | 完成（`fc/fulfil-rules` `5c8d8379`，整合 `f941a48b`） |
| ecpay-logistics | 選店、建單、列印、貨態通知與查詢的協定（EC-SPEC-05 §5、§6）；共用的 CDN 字詞檢查，AIO 一併套用 | argon | ecpay-proto、ecpay-aio | 進行中（`fc/ecpay-logistics`，從 `edb26526` 開出） |
| wp05-fulfilment | 出貨設定、履約單、shipment、例外、退回與檢驗；給 SL 頁的讀取投影與命令 | Codex | M2 | 之後 |

**M4 發票與售後（`commerce.hosted-invoice.v1`）**

| 切片 | 內容 | CLI | 依賴 | 狀態 |
| --- | --- | --- | --- | --- |
| invoice-rules | 統編、買受人欄位、品項拆分、期別、更正建議 | flash | — | 完成 |
| ecpay-invoice | B2C 電子發票的協定 | argon | ecpay-proto | 之後 |
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

第二批：ecpay-aio 合併（`d6fa9098`）後，ecpay-logistics 由 agy `gemini-4-argon-high` 從 `edb26526` 開出（`fc/ecpay-logistics`，純函式，不用資料庫）。fulfil-rules 的修正輪合併為 `f941a48b`。wp03-http 仍在跑。

2026-10-15 已合併（`da4af013` main、`d3cbb286` wp03-core、`931f8666` ecpay-proto、`f250e66d` invoice-rules）。整合者在一次性資料庫重跑 `f250e66d`：typecheck、build、cloudflare、governance、契約 946、runtime 全部通過；CI 的 worker job 順序（契約、dry-run 後）worker 114/114、migration-postgres 12/12、media-restore 封存 6/6。media-restore 的 J6-R3 失敗 1 項：168 新增的兩張 RLS 表（`commerce_customers`、`commerce_checkout_contacts`）沒有列進還原演練，由 wp03-http 補上。

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
| `hosted-checkout` | `modules/agent-commerce/checkout/**`、M1 migration、checkout 測試 | `agent-commerce` | 已登錄（wp03-core） |
| `commerce-providers` | `modules/agent-commerce/providers/**`、協定測試與向量 | 無 | 已登錄（ecpay-proto） |
| `commerce-invoices` | `modules/agent-commerce/invoices/**`、發票測試；M4 起加 migration | 目前無（純規則）；M4 加 `hosted-checkout`、`commerce-payments`、`commerce-providers` | 已登錄（invoice-rules） |
| `commerce-operations` | `modules/agent-commerce/operations/**`：主機設定、准入、能力清單、信件、外部效果日誌、報表與漏斗（EC-SPEC-10 §10、EC-SPEC-07 §8） | `hosted-checkout` | wp03-http 建立 |
| `commerce-payments` | `modules/agent-commerce/payments/**`、M2 migration、付款測試 | `hosted-checkout`、`commerce-providers`、`commerce-operations` | M2 |
| `commerce-fulfilment` | `modules/agent-commerce/fulfilment/**`、官方貨態表 `ecpay-logistics-status-map.tsv`、M3 migration、履約測試 | 目前無（純規則）；M3 加 `hosted-checkout`、`commerce-providers` | 已登錄（fulfil-rules） |
| `commerce-aftersales` | `modules/agent-commerce/aftersales/**`、售後測試 | `hosted-checkout`、`commerce-payments` | M4 |

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
- 改了前端先 `npm run build`，再跑瀏覽器測試。

## 10. 每個工作的交付

- 工作說明（brief）列：要讀的規格與報告、精確的檔案範圍、編號的建構項目、驗收條件、確切的驗證命令、commit 格式、回報格式。
- 回報列：commit、實跑的命令與結果、`not_run` 與原因、刻意沒做的事、對規格的疑問。
- 整合者的審查：重跑測試、逐檔讀差異、對照規格與官方文件；發現問題就開修正輪。通過後才合併，並把 SHA 交給相關的工作階段。
