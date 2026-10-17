# EC-SPEC-07 營運與技能書：29 項技能的落點、三種資產、報表與 AI 界線

狀態：proposed（2026-10-15），基準 `efaf314d`；本文件引用的檔案在 `5bee7376` 仍相同（WP-00 §1.1）。對應需求 EC-R02、R40（技能與外部通路分期的部分）、R43、R46、R47、R57；驗收 EC-AT02、AT52、AT53（入口部分）、AT70，以及 AT24 與 AT48 的報表部分（全部 `not_run`）。

技能的來源是 Majordomo `5dbab0cb` 的 `docs/SKILLS-INDEX.md`、`docs/MCP-SETUP.md`、`mcp.json` 與 `.claude-plugin/plugin.json`，只讀、沒有執行（雜湊見 [sources.md](sources.md) §2.2）。標「提議」的表、路由與欄位尚未存在。

## 1. 原則

- 技能是需求索引與操作知識，不是 API、功能或操作授權（計畫 §6、§17.4）。Majordomo 列了某項技能，不會因此進入 C2（計畫 §22）。
- 每一項技能都要有主責、階段、交付、規格落點與邊界（EC-AT02）。實作狀態以 EC-SPEC-10 §2.6 的能力清單為準，本文件不寫「已完成」。
- 載入工具、讀取資料、高風險寫入是三種不同的授權（Capability-Allocation 的 MCP 段落）。
- 沒有技能書、沒有模型金鑰，商店照樣能營業（EC-R43、計畫 §14.3）；commerce 的伺服器程式不呼叫任何模型。
- 書、站內應用、可攜發行物是三種各自有版本的資產，可以不同版（EC-R46、R47）。差異要寫出來；隱藏差異才是問題（計畫 §14.2）。
- 平台改編的地方要標出和原技能的不同（§2 的「和原技能不同」）。這些不同是本平台的規則，不是說原作錯了。

## 2. 29 項技能的落點

主責沿用 Capability-Allocation：Seller＝零售商，Supplier＝供應商，Shared＝平台的共用機制（不是平台代收款或代持商家資料）。2026-10-15 的現況：29 項都還沒有可用的功能。CAP26 的協定程式庫在 `fc/ecpay-proto`，CAP11／CAP14 的純規則在 `fc/invoice-rules`，兩支分支都還沒合併，也沒有接任何服務。

### 2.1 C2 要交付的 11 項

| 技能 | 主責 | 本平台的交付 | 規格落點 | 邊界；和原技能不同 |
| --- | --- | --- | --- | --- |
| CAP02 `analytics-ga4` | Shared＋Seller | 以權威資料計算的漏斗與營運報表（§4.2）；賣家自己的 GA4 在 C4（§4.3） | 本文件 §4 | 不載第三方追蹤；原技能建議把統編設為 user property，本平台禁止。C2 不做 view／cart 事件，與 Capability-Allocation 的建議不同，Ted 可改（§10） |
| CAP04 `compliance-consumer` | Seller＋Shared | 賣方揭露、政策頁、版本與結帳時的接受紀錄；售後申請流程 | EC-SPEC-06 §2、§4 | 平台提供欄位、版本與紀錄，不判定法律適用。售後期間只設表單最小值（EC-SPEC-06 §12），法定期間由商家確認 |
| CAP06 `compliance-pdpa` | Shared | 顧客屬於店、不是平台會員；個資獨立一表；履約者只拿最小收件資料；保存、遮罩與匯出 | EC-SPEC-02 §4；EC-SPEC-03 §3.1；EC-SPEC-05 §4.4；EC-SPEC-09 §3；EC-SPEC-08 §4 | 平台機制和商家的法律責任分開；個資不送模型、分析與日誌（§4、§6） |
| CAP07 `compliance-product`（C2 範圍） | Supplier＋Seller | 商品配送屬性與限制標記；沒填屬性不能結帳（`shipping_attributes_missing`） | EC-SPEC-05 §2.5 | 只用來擋寄不出去的單，不是法規核准。食品、藥品、化妝品、酒類、醫材等特殊商品的標示與證明在 C4；不以勾選代替核對 |
| CAP11 `invoice-carrier` | Shared＋Seller | 結帳的載具、捐贈碼、公司統編表單與驗證 | EC-SPEC-06 §3.3；`fc/invoice-rules` 的 `buyer.ts`、`ubn.ts` | 載具與統編只給開票方；不進報表 CSV、分析與日誌（EC-SPEC-06 §6）；供應商看不到 |
| CAP14 `invoice-void` | Shared＋Seller | 退款對應作廢、折讓、重開的建議與執行 | EC-SPEC-06 §3.7；`fc/invoice-rules` 的 `period.ts`、`corrections.ts` | 原技能以「同一期內作廢、跨期折讓」概括；本平台依開立時間算出法定作廢期限並提前 2 小時，判斷不了就轉人工例外 |
| CAP17 `logistics-cvs` | Shared＋Supplier＋Seller | 選店、建單、標籤、交寄、貨態、未取件退回 | EC-SPEC-05 §3.6、§5、§6、§8.1 | C2 只有 7-ELEVEN、全家、萊爾富的店到店（C2C）。OK 超商店到店已於 2026/07/01 終止（EC-SPEC-05 §2.2），原技能仍列 OK。超商代碼付款不是超商取貨；取貨付款（COD）在 C4（DC05） |
| CAP18 `logistics-home` | Shared＋Supplier＋Seller | 寄件地、地址檢查、常溫宅配、標籤、交寄、地址例外 | EC-SPEC-05 §2.1、§3.5、§5、§7.4 | C2 只有綠界的黑貓與中華郵政（中華郵政只送本島）。原技能列的宅配通、新竹物流要依商家合約另接，不照抄「有 API」的說法 |
| CAP21 `operations-customer-service` | Seller＋Supplier | 訂單對話、售後申請、例外與責任分工 | EC-SPEC-06 §2、§7；EC-SPEC-05 §7 | AI 不替商家承諾退款（§6）；供應商只看自己的履約事件。原技能的 LINE、Messenger、PTT／Dcard 監看不在 C2 |
| CAP23 `operations-pricing` | Seller＋Supplier | 伺服器定價與凍結報價、運費、供貨價與供貨帳 | EC-SPEC-02 §5；EC-SPEC-05 §3.4；EC-SPEC-06 §5 | C2 價格含稅、只收整數新臺幣（EC-SPEC-02 §3、EC-SPEC-06 §3.1）。促銷不改供貨價，價差不是佣金 |
| CAP26 `payment-ecpay` | Shared＋Seller | 商家自己的綠界帳戶、AIO 導轉一次付清信用卡、callback、查詢、退款 | EC-SPEC-04；`fc/ecpay-proto` | 只用伺服器通知與查詢判定付款；模擬付款不算收款（EC-SPEC-03 §5.4）。原技能涵蓋 ATM、超商代碼、超商取貨付款，C2 不開（DC05） |

### 2.2 C2 只有介面或基礎、C4 擴充的 4 項

| 技能 | 主責 | C2 | C4 | 邊界 |
| --- | --- | --- | --- | --- |
| CAP12 `invoice-ezpay` | Shared | 同一個 InvoicePort（EC-SPEC-06 §3.2） | ezPay 的 adapter | 首發是綠界 B2C（DC06）；有技能不代表能開票，商家合約與正式驗收另外核對 |
| CAP13 `invoice-universalec` | Shared | 同上 | 汎宇的 adapter | 只有一套發票真相；未測的 27 個工具不自動載入 |
| CAP24 `operations-promotion` | Seller／Marketing | 有界的優惠：固定金額或百分比、期間、上限，每單一個（EC-SPEC-02 §3） | 免運、疊加、檔期活動 | 不做通用促銷引擎；不捏造倒數或銷量 |
| CAP25 `payment-dispute` | Seller＋Shared | 訂單頁的事實時間線與人工記錄爭議扣回（§7） | 爭議紀錄、期限提醒、證據包 | 爭議不等於直接扣供應商的錢；保留 provider 的期限 |

### 2.3 知識先行、串接在 C4 的 14 項

| 技能 | 主責 | C2 時的形式 | C4 | 邊界 |
| --- | --- | --- | --- | --- |
| CAP01 `analytics-benchmarks` | Seller＋Supplier | 技能書第 9 章的參考範圍（§5） | 同左 | 只是參考材料，不當目標、預測或保證；報表不顯示「業界平均」比較 |
| CAP03 `channel-strategy` | Seller | 技能書第 1 章 | 外部通路串接 | 不同時接所有平台、不自動跨平台發文；商品的 SKU 以本平台為準（EC-SPEC-02 §1.1） |
| CAP05 `compliance-cross-border` | Seller＋Supplier＋Shared | 不開跨境：收件地址只收台灣（EC-SPEC-05 §3.5） | 稅費、進出口與退運責任 | 與 CAP16 共用一份契約；不寫死費率 |
| CAP08 `dtc-91app` | Seller＋Shared | 無 | 核准後的商品／訂單 connector | MCP 原始碼是 private（MCP-SETUP §8），沒取得前不承諾 |
| CAP09 `dtc-shopify-localization` | Seller | 技能書第 1 章的比較 | 視需求 | 新站不依賴 Shopify；connector 不能改供貨真相 |
| CAP10 `dtc-shopline` | Seller＋Shared | 無 | Shopline 連線 | 由商家自己核准 API token；沒驗過不稱雙向同步 |
| CAP15 `logistics-cold-chain` | Supplier＋Shared | 溫層欄位已存在，但 C2 只能選常溫（EC-SPEC-05 §2.3） | 冷藏、冷凍服務與包材規則 | 不是一般超商配送加一個 cold 旗標 |
| CAP16 `logistics-cross-border` | Supplier＋Seller＋Shared | 無 | 報關資料、稅費責任、追蹤與退運 | 與 CAP05 同一份契約；未核准不出貨 |
| CAP19 `marketplace-momo` | Seller＋Supplier 資料 | 無 | 刊登、活動與訂單橋接 | 不另外複製一份庫存 |
| CAP20 `marketplace-shopee` | Seller | 無 | 刊登、活動、客服與訂單同步 | Majordomo 的 12 個 MCP 沒有蝦皮；安裝 MCP 也不等於認證合作 |
| CAP22 `operations-line-oa` | Seller／Marketing | C2 只寄 Email（需寄送授權，EC-SPEC-10 §6.2） | 商家自己的 LINE OA 通知與客服 | 不用平台共用的 token 群發；交易通知與行銷同意分開 |
| CAP27 `payment-jkopay` | Shared＋Seller | 同一個 PaymentPort（EC-SPEC-04 §3.2） | 街口 adapter | callback 與退款各自驗證 |
| CAP28 `payment-newebpay` | Shared＋Seller | 同上 | 藍新 adapter（DC02 的替代首發） | 編碼與加密和綠界分開，不共用簽章函式 |
| CAP29 `payment-tappay` | Shared＋Seller | 同上 | 卡片 token、3DS、錢包 | 收單與 PCI 責任另外核對；瀏覽器不存卡號 |

### 2.4 Majordomo 的 12 個 MCP

全部以 `uvx --from git+https://github.com/asgard-ai-platform/mcp-*@main` 安裝，也就是跟著 `main`、沒有固定版本。Claude Code、Antigravity、Codex、Cursor 的 plugin 清單都直接宣告這些 server，MCP-SETUP 寫明「安裝 plugin 後 harness 會自動拉起」。每個 server 從執行環境讀商家的金鑰（例如 `ECPAY_HASH_KEY`）。

| MCP | 對應技能 | 來源 | 本平台的狀態 |
| --- | --- | --- | --- |
| `ecpay` | CAP26 | 公開 | 不啟用；C2 自己實作協定（EC-SPEC-04） |
| `ecpay-logistics` | CAP17、CAP18 | 公開 | 不啟用；C2 自己實作（EC-SPEC-05） |
| `newebpay` | CAP28 | 公開 | 不啟用 |
| `kerry-tj`、`hct-logistics`、`sf-express` | CAP18（其他宅配） | 公開 | 不啟用；C4 依商家合約評估 |
| `shopline` | CAP10 | 公開 | 不啟用 |
| `91app` | CAP08 | private | 不可用：沒有原始碼 |
| `cyberbiz` | 無對應技能 | private | 不可用 |
| `buy123-vendor` | 無對應技能 | 公開 | 不啟用 |
| `ezpay-einvoice` | CAP12 | 公開 | 不啟用 |
| `universalec-einvoice` | CAP13 | 公開 | 不啟用 |

C2 一個都不啟用，也不放進技能書或可攜發行物的設定（§6.3）。

## 3. 三種資產與連結

### 3.1 現況

| 資產 | 現在記在哪裡 | 狀態 |
| --- | --- | --- |
| 技能書 | 靜態目錄 `modules/community/catalog.ts`：`storefront`（`:2659`）是「我的第一間商店」，`source_commit: null`、`license_status: NOASSERTION`；公會推薦表 `guild_commerce_sales: ["storefront","pos-pro"]`（`:2955-2958`）。閱讀指南 `modules/community/skill-book-guides.ts:404` 固定在 `9823df79`、2026-09-27 核對，狀態寫著「公開買家商店、結帳、訂單與金流尚未實作」 | 存在 |
| 站內應用 | registry 的 application release：`hosted-store@1.0.0` 的 `skill_book_refs` 是空的，而且 release 不可修改（WP-00 §6） | 存在、沒有連到書 |
| 可攜發行物 | 沒有；`portable_profile_ref` 都是 NULL | 不存在 |

PR #706（2026-10-15 仍是 open，head `24edddb8`）在應用版本詳情加了 `ApplicationSkillSources`（依 `skill_book_refs` 讀公開的技能書）、`PortableBusinessStatus`（目前顯示「沒有已核對的獨立部署發行物可供下載」）、`CommerceReadingReferences`（EC-website-project、Majordomo、Toolkit 的固定版本與角色），以及技能書介紹裡的 `StorefrontBookUsage`。本文件沿用 #706，不另做第二套畫面。#706 合併前，WP-07 的 UI 工作以它為前提排在後面。

### 3.2 兩種關係

| 關係 | 意義 | 記在哪裡 | 怎麼改 |
| --- | --- | --- | --- |
| 版本依據 | 這個站內應用版本改編自、或直接教的書 | application release 的 `skill_book_refs` | 新 release；舊 release 不動 |
| 公會推薦 | 公會建議成員讀的書 | `catalog.ts` 的公會推薦表 | 一般 PR |

- commerce 的新能力本來就需要新的 `storefront` 模組版本（EC-SPEC-09 §2）。同一次登錄新的 `hosted-store` release，`skill_book_refs` 預設只填 `storefront`；Ted 可以增減（§10）。
- 總入口技能書（§5）與 `reconciliation`（商家對帳入門）放在公會推薦表，不放進 release。書會比應用更新得頻繁；放進 release 的話，每改一次推薦就要發一個新版本。
- 同一本書可以被多個公會推薦、被多個應用引用；一個應用也可以引用多本書（計畫 §14.2）。
- 外部參考（Majordomo、Toolkit、EC-website-project）不是會員的書，維持 #706 的固定版本清單，不加進目錄。

### 3.3 差異摘要

計畫要求站內應用記下「採用來源與差異摘要」（§14.2）。registry 沒有這個欄位，release 又不可修改，所以放在 #706 的靜態檔 `apps/portal-web/src/modules/skill-book-commerce-references.ts`（提議新增 `hostedAdaptations`），以（`application_key`、`release_ref`、書的 id）為鍵：

| 欄位 | 內容 |
| --- | --- |
| `book_commit` | 比較時讀的書的版本（40 字元 SHA） |
| `adapted` | 站內版本有、原作沒有的能力，例如「公開店面、結帳、訂單、付款、出貨」 |
| `not_included` | 原作有、站內版本沒有的，例如「本機 HTML 模板下載」 |
| `data` | 資料放在哪裡，例如「商品與訂單在平台的資料庫；原作的範例只用虛構資料」 |
| `reviewed_at` | 核對日期 |

- 畫面在 `ApplicationSkillSources` 的每本書下面顯示「站內版本與原作的差異」，並保留「開啟原作 ↗」。版本不同不是錯誤（EC-AT52）。
- 測試核對兩個方向：每個有 `skill_book_refs` 的 release 都要有摘要，每筆摘要都要對到真的 release 與書。
- 書的閱讀指南（`skill-book-guides.ts`）只描述原作。`storefront` 指南的狀態文字等 C2 的能力在能力清單上真的開了（EC-SPEC-10 §2.6）才更新，不提前改。

### 3.4 啟動台的三個入口

計畫 §14.1；頁面在 pages.md 的 E01。

| 入口 | 現有元件 | 規則 |
| --- | --- | --- |
| 開始／管理我的商店 | `LaunchFlow`、`MyStoreAction`、`StoreList` | 照舊 |
| 閱讀／下載原作技能書 | `SkillBookIntro`（「開啟原作 ↗」）、`StorefrontBookUsage` | 連到原作的固定版本；說明站內版本另有適配 |
| 下載可自行部署的營業版本 | `PortableBusinessStatus` | 只有發行物真的存在、而且清單檢查通過（EC-SPEC-08 §3）才顯示下載，並附版本、支援的模式（H／C／S／X）、checksum 與授權。在那之前只說明狀態；不連到原作、不拿 CSV 匯出代替（EC-AT53）。資料來源見 EC-SPEC-08 §6 |

### 3.5 公會作者自己加入口（EC-AT70，C3）

- 書：作者用既有的技能書投稿流程（`modules/skill-submissions/service.ts:372` 的 `publishSubmission`，Agent 也能透過 `/agent-api/v1/skill-submissions` 投稿），不需要改中央程式。
- 推薦：公會長用既有的啟動台設定（`modules/guild-workspace/launchpad-config.ts:316` 的 `publishLaunchpad`）推薦應用與書。
- 試用要確認的事：不必在中央程式為這位作者寫特例；作者沒有因此拿到任何商店或訂單資料的權限；在 preview／test 環境就能完成。

## 4. 報表與分析

### 4.1 報表規則（EC-R57）

報表內容在 EC-SPEC-06 §6；這裡是所有 commerce 報表與匯出共用的規則：

- 從權威表即時計算，畫面顯示資料時間。不另存一份統計值，以免和權威資料不一致。
- 依幣別分開，不跨幣別相加；sandbox 與 live 分開。
- 不算進營收：模擬付款、sandbox 訂單、只有買家瀏覽器返回而沒有伺服器確認的付款；物流簽收也不是收款。
- 不顯示「已入帳」「已撥款」：綠界撥款與銀行入帳不在本系統（EC-AT24）。
- 退款分開列 API 確認與人工紀錄；爭議扣回另列一行（§7）。
- 零售實收、應付供應商、運費、未付款分開，不互相抵銷（EC-AT24）。
- 不含個資：Email、姓名、電話、地址、門市、載具號碼、統編、公司抬頭、對話內容（EC-AT48）。需要對照時用顯示用訂單編號。
- 沒有足夠資料時顯示「資料不足」，不補估計值，不畫看起來在成長的趨勢線。
- CSV 匯出：每個以 `=`、`+`、`-`、`@`、Tab、CR 開頭的儲存格前面加 `'`（計畫 §17.2）。平台目前沒有共用的 CSV 工具，提議在 commerce 讀取模組加一個小函式並附測試。
- 供應商只看自己的投影（SL-05、SC-SPEC-07）：供貨單價與費用，看不到零售價、折扣、買家付款、退款與發票（EC-SPEC-06 §5.5）。

### 4.2 C2 的漏斗：只用權威資料

| 步驟 | 來源 | 計數規則 |
| --- | --- | --- |
| 開始結帳 | `commerce_checkouts` | 每個 checkout 一次 |
| 下單 | `commerce_orders`（`hosted_checkout`） | 每張訂單一次 |
| 付款確認 | 付款套用紀錄（EC-SPEC-03 §3.1） | 每張訂單最多一次；同一筆付款的重複通知不重算（EC-AT48 的 purchase 去重） |
| 已交寄 | shipment 交寄事件（EC-SPEC-05 §5.5） | 每張訂單第一次交寄 |
| 售後 | 售後申請（EC-SPEC-06 §2.2） | 每張訂單是否有申請 |

- 依期間與幣別顯示各步驟的數量與轉換率。金額只算付款確認的部分。
- 沒有瀏覽、加入購物車的事件。這兩步需要在買家頁加追蹤，C2 不做：不載第三方 script，就不需要 cookie 同意流程，也不會把機器流量算成成長。
- 這是對 Capability-Allocation 的調整（它建議 C2 有 view／cart 事件），列為 Ted 可改的決定（§10）。

### 4.3 賣家自己的 GA4（C4）

- 賣家填自己的 Measurement ID；平台不設共用 GA 帳戶。
- 事件只用 `view_item`、`add_to_cart`、`begin_checkout`、`purchase`。`purchase` 由伺服器在付款確認後送出，`transaction_id` 用不可逆的訂單代號，同一張單只送一次。
- 欄位白名單：商品代號、名稱、單價、數量、幣別、金額。Email、電話、地址、統編、載具、顧客姓名一律不送；原技能建議的「統編作為 user property」不採用。
- 載入前要有買家的 cookie 同意（CAP06）；買家拒絕時照常購物。

### 4.4 E02 營運概覽

賣家首頁的待辦數字。做法和供應商的 `fulfilment-counts` 相同（EC-SPEC-05 §9.2）：

- `GET /api/v1/tenants/:t/storefronts/:i/overview`（提議）：一個唯讀交易（`REPEATABLE READ`）內算完，回 `{status:'ready', as_of, items}`；超過 2 秒或失敗回 `{status:'unavailable', reason}`，畫面顯示「無法取得」，不顯示 0。
- 項目：付款例外（EC-SPEC-04 §8 的差異清單）、待出貨（自出貨、已確認付款、未交寄的履約單）、供應商回報無法履約、待決定的售後申請、待處理的發票例外、provider 帳戶的提示（暫停、發票服務無法使用）。
- 每個項目依成員的能力裁切：沒有該能力的人看不到那一項，而不是看到 0。

## 5. 總入口技能書《自由工坊電商開店與營運技能書》

### 5.1 形式

- 一本新的文字技能書，形式與既有的 `freedom-skill-*` 書相同（例如 `reconciliation`）。提議 id `commerce-operations`、repo `FreeTWAI/freedom-skill-commerce`。建 repo 與決定書的授權都由 Ted 處理（§10）；repo 存在後才加進目錄，並固定 `source_commit`。
- 引用 Majordomo 與 Toolkit 時連到固定版本並自己改寫。大段複製 MIT 內容的話，必須連同原著作權聲明與授權全文一起保留（sources.md §2）。
- 每章都要寫出不用 AI 的做法。AI 只出現在「可選」段落，而且只做查詢或草稿（§6）。

### 5.2 章節

| 章 | 內容 | 對應 |
| --- | --- | --- |
| 1 開店前 | 自有站與外部通路怎麼選；一間店一個零售責任主體；誰收款、誰出貨 | CAP03、CAP09；DC01 |
| 2 商品與上架 | 變體、照片、分類、配送屬性；哪些商品 C2 不能賣 | EC-SPEC-02 §1；CAP07 |
| 3 價格與優惠 | 含稅價、整數元、運費、優惠上限；供貨價不因促銷改變 | CAP23、CAP24 |
| 4 收款 | 申請綠界帳戶；金鑰只填在 Seller Console 的表單；測試與對帳；站外退款要補人工紀錄 | CAP26；`reconciliation` |
| 5 配送 | 寄件地、超商與宅配、列印、交寄、貨態、退回 | CAP17、CAP18 |
| 6 發票 | 要不要開票由商家決定；買家資料；作廢與折讓 | CAP11、CAP14；DC06 |
| 7 客服與售後 | 訂單對話、退貨、退款、例外、爭議 | CAP21、CAP04、CAP25 |
| 8 資料與個資 | 保存期限、匯出、刪除 | CAP06；EC-SPEC-09 §3、EC-SPEC-08 §4 |
| 9 報表 | 怎麼讀漏斗與對帳報表；業界數字只當參考 | §4；CAP01 |
| 10 自架營業版本 | 發行物存在前只說明狀態 | EC-SPEC-08 |
| 附錄 | 各版本能力對照、名詞、來源清單 | §5.3 |

### 5.3 版本能力對照

附錄的對照表列出站內（H）、自架前端（C）、完整自架（S）、混合（X）各能做哪些事，內容從 EC-SPEC-10 §2.6 的能力清單產生，不手寫。這樣書不會宣稱尚未驗證的能力；清單更新後，書以新的版本跟進。

### 5.4 金鑰與個資

書裡不出現任何真的金鑰、商家代號或顧客資料。範例只用綠界公開的測試特店說明「去哪裡填」，不附金鑰值。示意圖用虛構資料，並標示「示意」。

## 6. AI 與 MCP 的界線

### 6.1 工具的五種類別

| 類別 | 定義 | commerce 的例子 | C2 |
| --- | --- | --- | --- |
| 讀取 | 不含個資的清單與狀態 | 商品、庫存、訂單狀態（不含聯絡與收件資料）、報表 | hosted 商店沒有委派憑證（§6.2），所以不提供 |
| 草稿 | 產生文字，不寫入 | 商品描述、客服回覆、政策初稿 | 成員在自己的工具產生，自己貼進表單送出 |
| 預覽 | 計算結果但不寫入 | 報價試算 | 不提供給 Agent |
| 需批准的寫入 | 經成員逐次確認的寫入 | 改價、上架 | 不開放。日後要開，需在 EC-SPEC-09 §2 定義逐項、限時、可撤銷的授權，並經 Ted 同意 |
| 禁止 | 任何委派都打不開 | decisions.md 的清單：讀收件或聯絡資料、開列印、建立或作廢託運單、核准或送出退款、取消已付款的訂單或行項、作廢發票或開折讓、修改寄件地、出貨設定、provider 帳戶、代出貨同意、政策 | 一律禁止 |

### 6.2 C2 沒有 hosted 商店的委派憑證

平台既有的「連接我的客戶端」是唯讀的配對：`fw_read_` token、種類只有 `storefront` 與 `supplier`（`modules/client-connections/service.ts:9`），回應固定 `read_only:true`、`money_movement_enabled:false`（`:14`），只對舊的 `retail_stores`（`:90`、`:139`），不涵蓋 hosted 商店。C2 不擴充它，也不為 hosted commerce 發任何 Agent 憑證。成員要 AI 協助時，自己把不含個資的內容貼到自己的工具。

日後若要開放（C4），必須：

- 使用和成員相同的領域命令與 receipt，不另開旁路；
- 憑證綁定一間店、一組能力、一段期限，可以撤銷；
- 永遠不含 §6.1 的禁止清單；
- 平台不保管任何商家的 provider 金鑰給 Agent 使用。

### 6.3 Majordomo 的 MCP

- 平台不安裝、不啟動、不建議自動啟動這些 MCP。技能書與可攜發行物都不附會自動啟動的 MCP 設定（計畫 §17.4：不執行未固定版本的遠端程式）。EC-SPEC-08 §3 的發行清單檢查要擋下 `mcpServers` 設定。
- 商家自己使用 MCP 或綠界後台做的退款、建單、開票，不經過平台，平台不會自動知道。C2 只用逐筆查詢對帳（EC-SPEC-04 §8），查不到站外退款，所以這類退款要由賣家補一筆人工紀錄（`manual_record`）。訂單頁與技能書第 4 章都要說明這點；批次對帳媒體在 C4。
- C4 若要採用任何一個 MCP，條件是：固定到審過的 commit；讀過原始碼；金鑰依用途、商店、profile、環境分開，存成伺服器的秘密參照，不放在 Agent 的環境變數；每個工具依 §6.1 分類；寫入改走平台的領域命令。private 的 MCP 要先取得原始碼與授權。

### 6.4 外部內容是資料

商品描述、顧客訊息、技能書、provider 回應都是資料，不能指示 Agent 讀秘密、略過審查或擴大付款操作（計畫 §17.4）。訂單對話是個資，不送進模型（EC-SPEC-06 §2.1）。

### 6.5 沒有 AI 也能營業

- commerce 的伺服器程式不 import 任何模型 client。
- C2 的端到端旅程在沒有任何模型金鑰的環境跑完（EC-SPEC-09 §5）。
- 中央服務中斷時的自架營業屬於 C3（EC-AT56，EC-SPEC-08）。

## 7. 爭議（CAP25）

- C2：信用卡爭議由賣家在綠界後台與收單機構處理。平台在訂單頁（E05）提供整理好的事實：付款、出貨與貨態、發票、對話與售後的時間線，讓賣家自己整理證據。平台不會收到爭議通知。
- 爭議扣回：賣家以人工紀錄登錄（EC-SPEC-04 §7.2，`manual_record`、依據 `dispute`），附綠界後台的日期、金額與參考號。這樣訂單的付款軸與報表才是真的；發票的更正照 EC-SPEC-06 §3.7 的建議走。
- 供應商：爭議不會自動扣供應商的錢。要分擔損失，只能在對帳單裡以 `adjustment` 列出，經雙方核對（EC-SPEC-06 §5.3、§5.4）。
- C4：爭議紀錄（provider 期限、證據清單、結果）、期限提醒、證據包匯出。
- 這是 Ted 可改的預設（§10）。

## 8. 程式位置與工作

| 工作 | 位置 | 依賴 |
| --- | --- | --- |
| 差異摘要與測試 | `apps/portal-web/src/modules/skill-book-commerce-references.ts`（#706）；`tests/e2e/skill-book-usage.spec.ts`（#706）擴充 | #706 合併 |
| 新 `hosted-store` release 的 `skill_book_refs` | 與新的 `storefront` 模組版本同一個 migration（EC-SPEC-09 §2.3、EC-SPEC-10 §4.2） | M2 |
| 公會推薦表加入新書 | `modules/community/catalog.ts` | 書的 repo 存在 |
| `storefront` 指南狀態更新 | `modules/community/skill-book-guides.ts` | 能力清單真的開了 |
| E02 概覽、報表、漏斗、CSV | commerce 讀取模組（descriptor 依 [work-plan.md](work-plan.md)） | M1～M4 的表 |
| 爭議的退款依據 | EC-SPEC-04 §7.2 的 `commerce_refunds` | M2 |
| 總入口技能書 | 新 repo | Ted 建 repo、決定授權 |

## 9. 測試（全部 not_run）

| 測試 | 驗收 |
| --- | --- |
| 本文件 §2 每項技能都有主責、階段、交付、落點與邊界；§2.4 每個 MCP 都有狀態；private 與未核准的工具都不啟用（審查） | EC-AT02 |
| repo 與可攜發行物裡沒有 `mcpServers` 設定；commerce 模組沒有 import 模型 client | EC-AT02、EC-R43 |
| 新 release 的應用詳情顯示 `storefront` 書、固定版本、差異摘要與「開啟原作」；書與應用版本不同時不顯示錯誤 | EC-AT52 |
| 每個有 `skill_book_refs` 的 release 都有差異摘要，每筆摘要都對得到 release 與書 | EC-AT52 |
| 沒有發行物時，營業版入口不出現下載，也不連到原作或 CSV；用測試資料的發行物時，顯示版本、支援模式、checksum 與授權 | EC-AT53 |
| 收款與供貨帳報表：零售實收、應付供應商、運費、未付分開；不出現「已撥款」；爭議扣回單獨一行 | EC-AT24 |
| 報表、CSV、日誌、分析的輸出沒有 Email、電話、地址、門市、載具、統編；同一筆付款的重複通知只算一次 | EC-AT48 |
| 漏斗不算模擬付款與 sandbox 訂單；不同幣別不相加 | EC-R57 |
| CSV 開頭是 `=`、`+`、`-`、`@`、Tab、CR 的儲存格加上 `'` | 計畫 §17.2 |
| E02：超過 2 秒或失敗顯示「無法取得」；沒有能力的項目不出現 | pages.md E02 |
| C2 端到端旅程在沒有模型金鑰的環境完成 | EC-R43 |
| 公會作者在 preview 環境用既有投稿與啟動台設定加入書與推薦，不改中央程式、不取得額外資料權限 | EC-AT70（C3） |

## 10. 仍待決

| 項目 | 建議 | 只影響 |
| --- | --- | --- |
| C2 的分析 | 只用權威資料的漏斗；GA4 在 C4（§4.2、§4.3） | 有沒有瀏覽與加入購物車的數字 |
| 爭議 | C2 在綠界後台處理，平台記人工扣回；爭議紀錄在 C4（§7） | 爭議的追蹤方式 |
| 總入口技能書 | 新 repo `FreeTWAI/freedom-skill-commerce`；授權由 Ted 決定 | 書的出版；不影響商店功能 |
| 新 release 引用哪些書 | 只引用 `storefront`；其他書放公會推薦 | 應用詳情顯示的書 |
| 是否聯絡 Majordomo 與 Toolkit 的作者 | 對外聯絡需要 Ted 授權；在那之前只引用固定版本 | 書裡的合作說明 |
