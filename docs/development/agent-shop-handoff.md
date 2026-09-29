# AI 雙商店：設計規劃與 Agent 交接

**下一位 Agent 從這份開始讀。** 頁面標記為 `page:supplier`、`page:retail`。

本文件整理已定案的產品方向、實際實作、未完成部分與續作依據。記錄時間：2026-09-30；程式基準 `071d5b43a17ff883b8cb7268f79dc801dc088e5c`。文件隨後另行提交，接手時必須重新讀取最新 Git／PR 狀態。

PR：[FreeTWAI-AI/freedom-platform #46](https://github.com/FreeTWAI-AI/freedom-platform/pull/46)。Fork：`arumwu/freedom-platform`；工作分支：`feat/supplier-retail-pricing-preview`；上游預設分支在本次核對時是 `main`。分支名稱是沿用名稱，不代表本次只做價格試算。

與平台計畫機制的差距與直接矛盾見第 11 節。該節對齊用詞，不改兩店、會員自己的 AI、平台不保管資金這三項產品決定，也不把現有程式改成結算引擎。

## 1. 為什麼要做這個設計

原始討論的問題是：有商品的人希望有人幫忙賣，但推廣者如果只拿很少的分潤，很容易花了製作網站與行銷的時間卻沒有足夠收益。使用者希望讓願意推廣的人真正經營自己的商店、自行定價；有商品的人專心整理商品、收取約定成本並出貨。

因此，兩方都是店主，差別是商店服務的對象。介面不強迫人先選「供應商／經銷商」身分；同一個人也可以兼做兩邊、販售自己的商品。

平台降低開店與合作的操作成本：把複雜工作整理進 MD，交給會員原本會用的 AI 完成。中央保存可驗證格式的商品／商店資料與交易回報，不接管商家的收款資金，也不經營物流系統。

「平台不經手金流」是確定方向；「雙方一定拿得到錢」不是可保證的結果。商店回報、金流業者實收、退款及履約是不同事實，下一位 Agent 不得把它們合併成保證。

## 2. 已定案的分工

| 對象 | 做什麼 | 收誰的款 | 網站可見性 |
| --- | --- | --- | --- |
| 我有東西要賣（內部商店） | 整理自己的商品與條件、接轉單、出貨 | 公開店支付的商品成本及約定運費 | 由外部商店真正驗證登入與授權；中央不公開其入口 |
| 我可以賣東西（公開商店） | 選品、自主定價、網站、推廣、買家客服 | 買家支付的零售款 | 公開商品頁，店主及買家訂單後台仍需各自保護 |
| 自由工坊 | 發 MD、成果預覽與歸檔、共用分單、付款回報與人工出貨登記 | 不代收、不保管、不分帳、不自動扣款 | 目錄供完成會員權限的人選品，公開店有受限的公開資料入口 |

物流由出貨方處理。願意回來登記時，只填交付方式、日期、物流公司與單號；自送／自取不要求單號。平台不接物流商、不追蹤包裹、不推定簽收。

## 3. 會員真正走的流程

### 有商品的人

下載內部商店 MD → 附到自己的 AI 對話 → 提供授權商品來源 → AI 整理商品、做有登入保護的網站並引導金流申請 → 拿回成果檔 → 上傳／预覽／確認歸檔 → 取得工坊商店金鑰並放入外部主機秘密設定 → AI 完成交易串接及測試。

商品價格、可供數量、圖片權利、出貨及退貨條件不能由 AI 猜。本人完成身分、銀行驗證與契約；AI 完成它能做的程式與測試，不要求會員懂 GitHub 或手寫 JSON。

### 想賣東西的人

在工坊挑選商品 → 下載帶有選品資料的公開商店 MD → AI 與本人確認售價，做公開商店與自己的金流 → 帶回成果檔並確認歸檔 → 設定專屬金鑰 → 呼叫 `/connection` 取得 `selection_id` → 跑完整測試交易。

### 避免首次連線的循環依賴

首次先做「尚未連線、不可結帳」的測試网站與成果。歸檔後才有商店代號及金鑰，公開店再取得選品代號。不能要求先有真實成交才能歸檔，也不能把未連線展示頁當成可交易商店。

先用 `mode=test`。本人核准正式上線後，建立 `mode=live` 的正式成果與新金鑰，兩邊商品與商店模式一致。MD 不是已完成商店的證明，分享頁也不等於具備私密後台。

## 4. 一筆交易怎麼走

```mermaid
sequenceDiagram
    participant B as 買家
    participant P as 公開商店後台
    participant F as 自由工坊
    participant I as 內部商店後台
    P->>F: 建立訂單，核對選品與庫存
    F-->>P: 固定金額、30 分鐘保留期限
    B->>P: 使用公開店的金流付款
    P->>F: 驗證業者通知後回報買家已付
    I->>F: 輪詢自己的轉單
    F-->>I: 僅回傳此店應處理的部分
    I->>F: 回傳此單受保護的成本付款入口
    P->>I: 店主親自付款
    I->>F: 驗證自己的金流後回報成本已付
    I->>B: 自行出貨
    I->>F: 可選擇人工登記出貨資料
```

「自動轉單」目前指中央建好分單、在買家已付款回報後讓各內部店讀取；外部店後台依 MD 每 30–60 秒輪詢。**沒有已實作的推送 webhook 或自動成本扣款。**

500 元例子：零售款 500 元歸公開店；商品 300 元加每件運費 60 元，由公開店主親自支付內部店 360 元。140 元是未扣其他費用的差額，不叫淨利或已賺到的錢。

這 140 元不是第 11 節的賣家 margin 投影，360 元也不是 `SupplierPayable`。

付款狀態由各店後台驗證業者資料後上報，證據標記固定是 `merchant_backend_report`。點付款連結、付款頁跳轉、會員自己按「完成」都不會成為中央付款成功證明。

## 5. 已實作的不變條件

- 內部店和公開店有獨立商店及金鑰。金鑰單店、90 天、只存雜湊；輪替使舊金鑰失效，原文不進 command receipt 或 MD。
- 成果先預覽，不寫商品；本人確認後才整批原子匯入。相同會員／相同成果雜湊不重複建立。
- 公開店保存選品時的價格與條件快照。訂單只用中央固定資料算錢，不信任瀏覽器售價。
- 建單先保留數量 30 分鐘，庫存不足不建單。相同外部訂單代號及付款事件重送不可重複扣留或記款。
- 金額以整數分為單位；500 元為 50000。TWD／USD 不換匯；供貨成本按件加運費，公開售價自行包含要向買家收的費用。
- 買家付款與商品成本付款分開保存。各自全額退款，必須引用原收款交易；買家退款不等於成本也已退。
- 內部店在買家付款回報後才可看到自己的轉單，不看其他店資料或公開店零售收入。轉單包含原 SKU 與來源公開店資訊。
- 兩筆均回報已付、且未退款，才允許出貨方人工登記。記錄標 `shipper_entered`，沒有物流核實。
- 買家姓名、電話、地址不存中央 manifest 或 MD；中央只存不含個資的 `delivery_ref`。安全的跨店收件資料交付仍由兩家外部店建立並驗收。
- 建單、付款、取消及出貨等交易處理以社群鎖排序；**等到鎖之後必須重新讀取可變接單狀態**。已有確定性測試防止暫停接單時仍用舊值開單。

## 6. 視覺與互動：不要再誤解的定案

1. 保留原本頁框、左右留白、側欄與文字內距。使用者說的「滿版」指茶葉目錄這種**單一商品卡片填滿商品列表**，不是整個頁面貼齊螢幕。不要重新加入 `shop-shell` 的零 padding 覆寫。
2. 商品列表用 `auto-fit`，只有一件時佔滿整排；多件依可用寬度排列。320 px 手機不橫向溢出。
3. 三個商店主要按鈕同排等寬，使用短而清楚的文字，不讓標籤斷成二、三行；完整意思保留在可存取名稱。桌面按鈕列不無限制拉長。
4. 兩頁以下載 MD、選品、上傳成果為主；不把原本一堆商品表單搬回主要流程。舊資料保留在收合區，不能逕自刪除或冒充新模式商店。
5. 右上「頁面說明」已有各六步教學。每次改 UI，要給使用者看實際新畫面；不可只報 commit 或拿未部署的本機畫面說成正式站。

## 7. 程式與文件的依據

| 要改的內容 | 先讀的權威來源 |
| --- | --- |
| 範圍、協作、設計 | [AGENTS](../../AGENTS.md)、[CONTRIBUTING](../../CONTRIBUTING.md)、[DESIGN](../../DESIGN.md) |
| 平台已定的交易機制（本功能尚未實作） | [領域與狀態](../platform-plan/03-domain-events-state-machines.md) §3.6–3.9、[模組規格](../platform-plan/04-module-specifications.md) §3、[架構](../platform-plan/02-architecture-repositories.md)、[決策](../platform-plan/07-decisions-risks-traceability.md) ADR-026／028／030／031／063；對照見本文第 11 節 |
| 產品操作與部署程序 | [AI 雙商店規格](supplier-retail-pricing.md) |
| 前置審查、併發修正證據 | [審查紀錄](agent-shop-review.md) 與 PR 最新補充 |
| 兩頁實際畫面 | [CommercePanels.tsx](../../apps/portal-web/src/modules/CommercePanels.tsx)、[AgentShops.css](../../apps/portal-web/src/modules/AgentShops.css) |
| 人看的操作教學 | [page-help.ts](../../apps/portal-web/src/page-help.ts) |
| AI 指引原文 | [common.md](../../packages/shop-agent/common.md)、[internal.md](../../packages/shop-agent/internal.md)、[public.md](../../packages/shop-agent/public.md) |
| 完整下載檔組裝 | [kit.ts](../../modules/agent-commerce/kit.ts)、[runtime text 產生器](../../scripts/generate-runtime-text.mjs) |
| 實際成果欄位與限制 | [schema.ts](../../modules/agent-commerce/schema.ts) |
| 商品選品、預覽、匯入、抓取 | [imports.ts](../../modules/agent-commerce/imports.ts) |
| 訂單、付款、暫停、金鑰、出貨 | [orders.ts](../../modules/agent-commerce/orders.ts) |
| URL、驗證與路由權限 | [agent-commerce.ts](../../apps/platform-api/src/routes/agent-commerce.ts)、[platform-app.ts](../../apps/platform-api/src/platform-app.ts) |
| 資料表與約束 | [048_agent_shops.sql](../../migrations/048_agent_shops.sql) |
| 行為驗收 | [runtime](../../tests/runtime/agent-commerce.test.ts)、[E2E](../../tests/e2e/agent-shops.spec.ts) |
| Node／Worker 實際部署規矩 | [Cloudflare README](../../deploy/cloudflare/README.md) |

變更 MD 原文後執行 `npm run generate:runtime-text`，不可只編輯 generated 檔。完整下載檔還含 API 基址、成果範例與實際選品，不是只把某一份原文 MD 直接送出。

文件說明意圖，schema／路由與測試說明目前實作。發現不一致時先列出具體差異，再依使用者已定案方向修正；不能為符合舊程式就默默改產品定義。

## 8. 已完成與尚未完成

### 已完成於 PR

兩頁主流程及教學、角色 MD 與共用交易指引、成果歸檔、目錄選品、單店連線、中央分單／付款紀錄、人工出貨、庫存保留、重送去重、暫停接單與舊資料保留。以上有本機測試，不等於正式平台已提供服務。

截至程式基準，交易 runtime 12 項通過；旧 commerce／client-connections／development-map 22 項通過；教學及開發入口 E2E 6 項通過，最後版型定向 E2E 3 項通過；Worker 10 項通過。前輪完整 runtime 首跑 595 項有 3 項因本機 Python 缺套件失敗，補指定套件後對應兩套 23 項重跑通過，不能寫成整批一次全過。完整命令／範圍見 PR。

### 未完成，不得宣稱已完成

- 上游 PR 合併、最新 head 的 CI 通過、staging／正式 migration 與平台發布。
- 各店真人金流帳號申請、真實收款與退款驗收。
- 外部網站實際發布、內部店登入隔離與兩店收件資料通道的真實驗收。
- 工坊同源託管外部網站程式、任意 CodeSandbox／分享頁網址匯入。現在只歸檔目錄與外部入口；其他主機可交成果檔。

本次最後核對時，GitHub 上游 `push/maintain/admin` 都是 false；CI 為 `action_required`。使用者已要求審查後合併，但文字授權不會自動增加 GitHub 權限。接手時重新核對；不要改用未知帳號、跳過受保護分支或使用 admin bypass。

Jev 已前置審查並促成併發修正，但其 gate／review 曾回 `escalate`。這是需进一步覆核的結果，不是自動放行。分開記錄具體 findings、測試證據及自動判斷；不能只報「Jev 跑過」。

## 9. 下一位 Agent 的工作順序

### 第一優先：把現有 PR 正確交付

讀本文件及 repo 規則 → 讀取最新分支、diff、PR／CI → 保留未提交變更 → Jev 先看相符來源與測試，人工覆核 SQL／MD 及發現 → 完成所需驗證 → 更新同一 PR。

有權維護者完成審查與最新 CI 後才能合併；保存 merged SHA。有部署授權及正確私有 overlay 的操作者再按既有程序先 staging、後正式，先備份、核對 048 migration 與 runtime grants，最後讀回 release SHA 及頁面。沒有權限就提供確切阻礙，不能冒稱已發布。

### 第二優先：驗證一組真正能合作的外部商店

中央與 MD 已具備接口；接下來最有價值的是用一間內部店＋一間公開店走完整測試模式流程，查核 AI 是否能僅依下載檔做出網站、接好兩家金流測試環境、互相授權收件資料、完成付款與退款回報。

先用合成商品及資料；真實扣款、商家申請、秘密設定及對外發布沿用本人實際授權。若缺哪段教程或接口，將可重現問題補到原文 MD／中央測試，避免再靠臨時聊天補丁才能使用。

### 後續候選，不是本次已授權必做

- 商品／庫存／價格更版流程：現在匯入是新商店／新版本，沒有原地編輯。須防同一庫存重複開售，保存舊訂單快照。
- 中央管理畫面的訂單翻頁：機器 API 有 offset，畫面目前只列最新 100 筆。未完成的舊訂單不能因列表限制失去處理入口。
- 更通用的成果來源：保持大小、來源、重新導向及內容限制，不直接抓任意私網或執行外部 HTML。
- 非即時付款、部分退款、合併運費等：目前未支援，需另定業務條件、失敗補償與測試，不能直接取消現有保留期或金額檢查。

這些是需再確認優先序的規劃，不能以本文件為由自動擴張成金流平台、物流平台或通用網站託管服務。


## 10. 最小驗收與重跑入口

修改中央交易時，至少確認：跨店／跨社群拒絕、暫停與並行建單、超賣、事件重送、到期、兩筆付款及退款分離、未付款不能登記出貨。改 UI 時確認四種寬度、正常內距、單件商品填滿列表、按鈕不換行及功能仍可操作。

```sh
npm run typecheck
npm run generate:runtime-text
npm run build
npx tsx --test --test-concurrency=1 tests/runtime/agent-commerce.test.ts tests/runtime/commerce.test.ts tests/runtime/client-connections.test.ts tests/runtime/development-map.test.ts
npm run test:e2e -- tests/e2e/agent-shops.spec.ts tests/e2e/development-guide.spec.ts
npm run worker:dry-run
npm run worker:dry-run:admin-sync
npm run test:worker
python3 scripts/update-inventory.py
npm run verify:inventory
git diff --check
```

依 repo CI 與修改範圍補跑完整 runtime、contracts、consumer repo 測試；以上不是取代 CI 的全部清單。使用隔離 PostgreSQL，不以正式資料做測試。瀏覽器必須在新 build 後跑；缺瀏覽器或 Python 套件時用核准的本機環境及 repo 指定版本，不偽造通過。

每次交接附：程式 SHA、PR／CI 連結、實跑結果、Jev 結果及處置、實際畫面、未驗證事項、下一個明確動作。不要只有「已完成」三個字。

## 11. 平台計畫裡有、這份設計沒寫到或寫反的機制

對照上游 `main` `3750af83` 的 `docs/platform-plan/`（03、04、02、07）。PR head 當時是 `c2237d7`。下面是已定規則，不是新做的付款平台。兩店、MD 交給會員自己的 AI、平台不代收不保管，和「平台不是收款人、沒有錢包」一致，保留。和規則衝突的地方寫明衝突；程式行為與第 2、4、5 節的產品句子不在這次改掉。

### 11.1 這份設計沒有點名、但也還沒做的物件

計畫的路徑是 `SupplierPayable` 加上 `SettlementMandate`，預設 `record_only`，`money_movement_enabled=false`。平台不是收款人，也不做 merchant of record。

- `SellingArrangement` 只有 `reseller` 或 `sales_agent`（ADR-026）。六個責任必須各自快照，不能用頁面名稱推測：`seller_of_record`、`payment_collector`、`invoice_issuer`、`refund_owner`、`price_owner`、`fulfillment_party`。它們住在版本化的 `DistributionAgreement`，雙方對 exact 版本簽名。公開店向買家收零售款、再自己把成本付給內部店，讀起來是 launch default 的 `reseller`，不是 `sales_agent`。價差不是 `CommissionObligation`；沒有已簽 referral rule 就不產生推廣佣金。同一人開兩店可以，但計畫仍要 arrangement、`SellerListingRevision` 與 `DistributionAcceptance`，角色重疊不免除獨立 QC（03 §3.6）。048 沒有這些欄位。
- 三種接點不能互相推定：買家款進 Seller 自己的 `seller_collection`；只有日後 `authorized_mandate` 才用付款人自己的 `payer_disbursement` 付 `SupplierPayable`；供應方另綁 `beneficiary_payout_destination`。現在各店用自己的金流，符合「平台不經手」。沒有這三種 connection，也不在這次補上。
- 一張結帳只有一個 `SellerParty`。付款後才依已簽來源建多張 `SupplyOrder`。現在的 `commerce_orders`／`commerce_transfers` 只是分單形狀，建單時就寫入，不是這兩個 aggregate。
- `SupplyReservation` 在短 TTL 內鎖住的是該 line 的 `DistributionAcceptance`、有效單價與數量。現在只保留 `commerce_items.reserved` 三十分鐘，沒有綁 acceptance。
- `SupplierPayable` 只在 verified paid 且該 line 已簽 `DistributionAcceptance` 之後建立，記供應方 net／批發額，不可原地覆寫。退款是追加 reversal，不刪舊事件，也不進平台錢包。`sales_agent` 或已簽 referral 才有 `CommissionObligation`。服務款是另一種 `ServicePayable`，不借用這張零售單。
- `SettlementMandate` 是付款人對 exact digest 的成員 A4，加上 Ted 對同一 digest 的付款類 A4，才可能變成 `authorized_mandate`。還要平台 flag、有效 mandate、cap、idempotency、reconciliation。缺任一項就維持 `record_only`。範圍內的轉帳不逐筆重簽；超出範圍要新的 A4。本分支沒有 mandate，也不啟用資金移動。
- A4 是有權自然人對 exact artifact／digest 的簽名。聊天、按鈕、匯入確認、`acknowledge_internal_preview` 都不是 A4。Agent 不能代簽。
- 賣家 margin 只是投影：`buyer-facing paid − SupplierPayable − 明示的其他義務／稅／成本`。要等 verified payment 與已簽 acceptance 之後才算，不能顯示成已收到的現金，也不是佣金。介面上 `record_only` 只寫「已記錄」，禁止寫「平台已付」或「平台已結算」。`payable`、`initiated`、`recorded`、`reconciled_received` 是四件不同的事；只有對帳足夠的收款事實才算實收。
- 運費與稅獨立列項，不混進商品單價假裝折扣或加價（03 §3.6、04 §3）。`msrp`／`recommended_floor` 只是建議，禁止低於建議價就自動斷貨。
- 履約授權只在 `SupplierPayable` 的轉帳 confirmed 之後。佣金或服務結算不觸發履約。

### 11.2 和已定規則直接衝突的地方

這些衝突保持可見。沒有偷偷改她的產品句子，也沒有改執行路徑。

1. **內部店看不到實際售價。** 第 5 節寫內部店不看公開店零售收入；`orders.ts` 對內部店刪掉 snapshot 的 `retail_price_minor` 與 `sale_terms`。ADR-028／03 §3.6：Supplier 必須看得到實際售價與供貨條件，並以 A4 接受那一版 `SellerListingRevision` 之後，checkout 才能成立；改價要重新接受。沒有 active `DistributionAcceptance` 就不能結帳。平台用詞以此為準。現行程式與第 5 節仍是相反行為。
2. **舊目錄的「接受」不是 A4。** `modules/catalog-commerce` 的 `confirmation_kind` 固定 `internal_preview`，決定時要 `acknowledge_internal_preview: true`，journal 為 `internal_preview_*`，`official=false`、`checkout_enabled=false`、`money_movement_enabled=false`。這不是 `DistributionAcceptance`。新商店的「本人確認歸檔」同樣不是 A4，只是匯入確認。
3. **360 元不是 `SupplierPayable`，140 元不是 margin。** 例子仍是：零售 500，公開店主親自付內部店 300 加運費 60。140 仍只是她定義的未扣其他費用差額，不叫淨利。計畫的 margin 還要先有 verified payment、已簽 acceptance，再減供應方應付與明示稅費成本，而且不能看成現金。她把運費併進付給內部店的那一筆；計畫把運費、稅與 supplier net 分開。產品上「店主親自付成本加運費」保留，只是不得把 360 或 140 記成應付或已賺到的錢。
4. **兩筆 `reported_paid` 不能當成結算或履約確認。** 付款證據只有 `merchant_backend_report`。狀態是商店回報，不是 `reconciled_received`，也不是平台核實銀行。出貨登記目前要求買家款與成本款都是 `reported_paid`。計畫則是：`SupplierPayable` 轉帳 confirmed 才授權履約；`record_only` 只表示已記錄。`commerce_transfers.total_minor` 在建單時就寫入，早於付款與接受，而且會被狀態欄覆蓋；這不是不可覆寫的 `SupplierPayable`。

### 11.3 已經同向、不要再做成另一套金流的部分

- 平台不代收、不保管、不自動扣款：對應 `record_only` 與 `money_movement_enabled=false`。不要在這個分支加 `authorized_mandate`、錢包或代付。
- 訂單金額由中央快照重算，不信瀏覽器售價：與「client 價格一律忽略」同向。
- 全額退款分開回報、不自動退錢：方向上接近「追加 reversal、不經平台錢包」，但現在沒有 obligation reversal。
- 沒有低價自動斷貨：與建議售價只供提示同向。不要補一條地板價封鎖。

下一位若要接計畫，先補文件已點名的快照與「這不是 A4／這不是實收」的界線，仍不要新建付款平台。第 1 至 10 節的產品流程、500 元例子與出貨條件維持原樣，直到另有決定改產品。
