# 來源、方法與更正紀錄

## 1. 固定基準

| 項目 | 值 |
| --- | --- |
| 程式基準 | `FreeTWAI/freedom-platform@efaf314d7397e288c6ac094c5d90ffdcc1094f14`（2026-10-15 讀回時的 `origin/main`）。2026-10-15 10:03Z 再讀為 `5bee7376`，差異見 [WP-00 §1](WP-00-baseline.md) |
| 規劃包 | Ted 於 2026-10-15 提供的 `Freedom-Commerce-Project-Planning-Pack-v1.0` ZIP，SHA-256 `b87179efbfb2a2dc2a13b31e1b9c97d3e34c21bed80c76f5aad1b3e1bc331b81`，解開為 `Freedom-Commerce-Plan-v1.0/` |
| 包內雜湊 | 依包內 `SHA256SUMS.txt` 執行 `sha256sum -c`：12／12 相符（2026-10-15） |
| 需求與驗收 | `requirements-and-acceptance.json`：EC-R01～60 全部 `planned`、EC-AT01～72 全部 `not_run`；`supplier_addendum` 的 SC-L01～18 `planned`、SC-LAT01～24 `not_run` |
| 最大 migration | `migrations/167_community_ar.sql`（`efaf314d` 與 `5bee7376` 相同） |

| 包內檔案 | SHA-256 | 本目錄怎麼用 |
| --- | --- | --- |
| `Commerce-Storefront-Project-Plan-v1.0.md` | `7847b4ec5633887095cde9c59e30d01d68463dd61502485fee605442ef443dba` | 計畫主稿；本目錄寫「計畫 §N」都指這份 |
| `Commerce-Storefront-Project-Plan-v1.0.docx` | `90369fbb3ffbb570251a5e16f5afcbf6b6745a852e2d671f1d6bf16754d299aa` | 主稿的 Word 版；未與 `.md` 逐字比對，以 `.md` 為準 |
| `Requirements-and-Acceptance.md` | `b732da57fd6dbae7b7046010f2e0cd32d652057ca4ed29d7d6647a6935edd249` | EC-R、EC-AT 的文字 |
| `requirements-and-acceptance.json` | `5642daabf326bf2a39ad6d2da3711ab4c5364ddd8a63cccd937b0727774660b2` | 同上，加上 SC-L、SC-LAT |
| `Capability-Allocation.md` | `f3f2e30643ff1756cf01242d2105bb36c1b080bbd9e8d1d9259eccdadd2f720c` | 29 項技能的分配（EC-SPEC-07） |
| `capability-allocation.json` | `9458b593f97bb005311d0f9ae6248cb1b59555a1352075842d3e75a768d43e37` | 同上 |
| `Supplier-Console-v1.1-Logistics-Addendum.md` | `a3560eba88fe6f74a2d35562d4cba52134c758b47c45c83c703af5b32425ad3b` | 供應商 v1.1 物流補充；頁面部分由 Supplier Console 工作階段寫成 SC-SPEC-07 |
| `Supplier-Console-v1.1-Logistics-Addendum.docx` | `dc66ac8beb57b88512c80bc087c8c215bb38b32580649489d36b5ef037f3973b` | 同上的 Word 版 |
| `baseline/Supplier-Console-Project-Plan-v1.0.md` | `7c13f82e4d1066f86fd97a1b0edfcfe9158985f4fdc01ef399758387cc11baf0` | 與 Supplier Console 目錄引用的主稿雜湊相同 |
| `AGENT-START-HERE.md` | `d5c558242444b76db271c1887e7d855dc51b1b2c11ab77c8ed79d12ad4239ce0` | 第一輪交付清單 |
| `README.md` | `af1d8f34e059c9f8db0a88460954dfb8ecebf4472ff45bbbf36177e0f4fc5fc1` | 包說明 |
| `source-index.json` | `e4d125172553a0b3baccc7c9e6367e9671a5529363273ed7c78235ac2291b3cf` | 規劃時的來源 S01～S31 |

規劃包不提交進 repo，本目錄只以雜湊引用。計畫 §24：規劃包只授權產出規劃與 Spec，不授權發送訊息、開 Issue、合併、部署、操作正式客戶資料、啟動 MCP 或發起扣款、寄件。

## 2. 上游與參考

2026-10-15 10:03Z 以 GitHub 讀回確認：

| 來源 | 固定版本 | 授權 | 用途 | 不用 |
| --- | --- | --- | --- | --- |
| `hsuanchi/EC-website-project` | `fd5d3c3ad28ae570991a7b2a002c6c9b7f93878f` | 沒有 LICENSE；檔案樹（未截斷）只有 `README.md`、一個 issue template 與 `img/` 的 9 張圖 | 旅程與版面思路（EC-SPEC-01 §5） | 圖片、文案、品牌、截圖裡的商用佈景（DC10） |
| `asgard-ai-platform/tw-ecommerce-majordomo` | `5dbab0cb341a7e113d0d51fbc6463b1a12481ece` | MIT（Copyright (c) 2026 Asgard AI Platform） | 29 項技能索引與 MCP 設定，作為 EC-SPEC-07 的分配依據 | 不執行任何 MCP；技能裡的法規與稅務陳述不當權威；MIT 不延伸到私有相依與 provider 商標 |
| `Moksa1123/taiwan-ecommerce-toolkit` | `5fde04410fbf91f7a091f5d9dbfa0734abf35a93` | MIT（Copyright (c) 2026 Taiwan Invoice Skills Contributors） | 只拿來對照（§6.3） | 不複製程式；協定一律以綠界官方文件為準 |

### 2.1 EC 參考畫面

規劃包 S03 記載「圖片 bytes 下載失敗，未做像素視覺核對」。本輪從 `raw.githubusercontent.com` 依上表的固定版本取得 9 張圖並逐張檢視，結果寫在 EC-SPEC-01 §5。圖檔留在本機工作目錄，不進 repo：

| 檔案 | 尺寸（px） | SHA-256 |
| --- | --- | --- |
| `README.md` | — | `901da8b2956c2dd611702bd980b290bac5dc78092ac3c62dc064016587bcd707` |
| `img/addToCart.png` | 988 × 490 | `6f4f05dee83a43c8c28f3c1340ada363e0a05c3b8b616be7abfbddd97b9d446b` |
| `img/admin-member-crud.png` | 2872 × 1430 | `3fee4ac6718cc1eb0e6f75f90be1521473026b397de8e8f3d07939a04c8db942` |
| `img/admin-order-crud.png` | 2870 × 1582 | `66394ca6a9adc21fde68668e4278a111c658b2951edc953e7c62e9175b689053` |
| `img/admin-product-crud.png` | 2874 × 1588 | `a900c79af66fd43ed294188c04bd13f86cead93d71e12e4bb7dced31b73b0779` |
| `img/brand.png` | 1413 × 810 | `4dfdf0dce778dc9c9454f03f0de98117adc619e2d05201d1f72026d13620e3f4` |
| `img/shop-home.png` | 2876 × 1596 | `26f9ed457590ab18b23236f51302d99061207f7a2c95bd1e521b76e0a950ab4c` |
| `img/shopping_cart.png` | 2866 × 1510 | `669233e3d63690a5adb706bcbec390fb66a97d22f47999921a07f1c2b7ef8aee` |
| `img/trade_fail.png` | 2872 × 1526 | `3b3a97e21ab502e7076c8330903d7ca18463ff9c8941f9dd85f4b14f32f8c965` |
| `img/transaction.png` | 1065 × 693 | `d25d081d15c531ff50a1981a1a5f7958b6f42f61608286e2f6f5332b9e230748` |

### 2.2 Majordomo 的技能索引與 MCP 設定

2026-10-15 依上表的固定版本從 `raw.githubusercontent.com` 讀回，只讀、沒有安裝或執行。EC-SPEC-07 §2 依這些檔案分配技能：

| 檔案 | SHA-256 | 重點 |
| --- | --- | --- |
| `docs/SKILLS-INDEX.md` | `b2eb4db19048b204978f8a17596f39d37735b1e8c83cc0f157d661685eb41f6b` | 29 項 `tw-ecom-*` 技能，各一句摘要 |
| `docs/MCP-SETUP.md` | `ff6a55103de2336fb2d9434f6dbc467395719648d05885a99daa81b3f2be036d` | 12 個 MCP；`91app`、`cyberbiz` 是 private；Claude Code 與 Antigravity 裝 plugin 後自動啟動 |
| `mcp.json` | `bc9e6b1ab75aecc7c8835900f697739b69e5c759525561da3e1d870d1c30b8ec` | 12 個 server 都是 `uvx --from git+https://github.com/asgard-ai-platform/mcp-*@main`，沒有固定版本 |
| `.claude-plugin/plugin.json` | `59bbb5b2d8710d8f9e8038389e44da879720069d988e4df870510b398704c002` | `mcpServers` 直接寫在 plugin 清單裡；授權欄位 MIT |

## 3. 綠界官方文件

規格裡的 `[頁碼]` 是 `https://developers.ecpay.com.tw/<頁碼>/`，`[support 頁碼]` 是 `https://support.ecpay.com.tw/<頁碼>/`。

- 蒐集：agy `gemini-4-argon-high`（2026-10-15 06:00–07:29Z）只讀這兩個文件站（含站上的文章 API）與 Toolkit 的兩份 `SKILL.md`。執行紀錄的監看摘要顯示全部是讀文件的 GET，沒有呼叫付款、物流或發票的 API 主機。報告 1,211 行、SHA-256 `ba48269904de4d21dc9fc112aa3a88964a967845ea00602ae53c67bc4e1fbe2a`，留在本機，不進 repo。
- 整合負責人另外逐頁讀過以下頁面，與報告相符（例外見 §6.2）：
  - [2890] 查詢訂單：`TradeStatus` 為 `0` 未付款、`1` 已付款、`10200095` 訂單未成立（交易失敗）；`TimeStamp` 3 分鐘內有效；呼叫太快回 HTTP 403，要等 30 分鐘；信用卡在付款後 10 分鐘或 40 分鐘再查。
  - [2878] 付款結果通知：回純字串 `1|OK`；沒有正確回應時隔 5～15 分鐘重送，當天共四次；`SimulatePaid=1` 是模擬付款；`ReturnURL` 與 `OrderResultURL` 沒有固定先後。
  - [7420] 物流狀態通知：回 `1|OK`；重送三次後改隔天再送，從貨態更新日起維持三天；測試環境不模擬貨態通知。
  - [7906] 作廢發票：單月 13 日 23:59:59 以後不能作廢前兩個月的發票；有折讓的發票要先作廢全部折讓。
  - [8795] 門市電子地圖：回傳的 `CVSStoreID` 最長 9 字；`CVSOutSide`（0 本島、1 離島）只有 7-ELEVEN（`UNIMART`、`UNIMARTC2C`）與全家（`FAMI`、`FAMIC2C`）會回傳，萊爾富不回傳；`CVSTelephone` 7-ELEVEN 不回傳；stage 不開地圖，直接回固定門市。
- 審查 ecpay-logistics 工作時，整合負責人再讀了以下頁面（2026-10-15），作為 EC-SPEC-05 與協定程式庫 `ecpay/domestic-logistics/` 的依據：
  - [8809] 建立店到店訂單：`ReceiverStoreID` 是 String(6)，與地圖回傳的 String(9) 不一致；EC-SPEC-05 §3.6 只收 1～6 字，超過的請買家改選，待 stage 核對。`ReturnStoreID` 只用於 7-ELEVEN 店到店；`GoodsName` 是 String(50)，7-ELEVEN 與萊爾富店到店必填。
  - [7400] 物流介接注意事項：參數值不可含 HTML 標籤；回傳網址不支援中文，要用 punycode；只支援 TLS 1.2；呼叫太快回 HTTP 403，要等 30 分鐘；防火牆以網域放行，連出 `logistics(-stage).ecpay.com.tw`、連入 `postgate(-stage).ecpay.com.tw`，都是 TCP 443。CDN 會擋兩類輸入：單獨出現的系統指令字詞（`echo`、`tftp`、`traceroute`、`tracert`、`tclsh`、`cmd.exe`、`cmd` 加 `/c`、`cd` 後接 `/`、`\` 或 `..`、`chmod +x` 等），以及分號、`|`、反引號後接的 shell 指令（`ls`、`rm`、`id`、`ps`、`ping` 等）。頁面沒寫比對是否分大小寫、是否看字詞邊界。協定程式庫的 `findCdnBlockedTerm` 比綠界嚴：三個字元單獨出現就擋，字詞不分大小寫、也不看邊界，寧可多擋。
  - [8795] 補讀：地圖不可放在 iframe 裡；iOS 上不要另開視窗。
  - [7412] 取消 7-ELEVEN 店到店訂單（`Express/CancelC2COrder`）：`MerchantID`、`AllPayLogisticsID`、`CVSPaymentNo`、`CVSValidationNo` 都必填，`PlatformID` 一般特店放空值；回 `1|OK` 才算成功，沒有回應或其他內容都算失敗。
  - [8907] 更新門市（`Express/UpdateStoreInfo`）：`AllPayLogisticsID`、`CVSPaymentNo`（15）、`CVSValidationNo`（10，7-ELEVEN 必填）、`StoreType`（`01` 取件、`02` 退貨），`ReceiverStoreID` 與 `ReturnStoreID`（6）依 `StoreType` 擇一；回 `1|OK` 才算成功。用在門市關轉，綠界以通知與 Email 告知。
  - [7442] 物流子類型：店到店 `FAMIC2C`、`UNIMARTC2C`、`HILIFEC2C`；B2C `FAMI`、`UNIMART`、`UNIMARTFREEZE`、`HILIFE`；宅配 `TCAT`、`POST`。
  - [7444] 訂單有效日（日曆天）：店到店 7-ELEVEN 5 天、全家 6 天、萊爾富 7 天；B2C 全家 6 天、7-ELEVEN 5 天、萊爾富 7 天，另列物流中心的收貨時間。頁面沒寫過期以後怎麼處理。
  - [10419]、[10442] 超商與宅配的建單流程：建單完成後綠界就送一次狀態通知；包裹到店時綠界以簡訊通知買家取貨，所以收件人手機會交給綠界發簡訊。宅配頁的第 7 步沿用超商的寫法（「送達指定超商」），應是誤植。
- 設計 ecpay-invoice 工作前，整合負責人再讀了以下發票頁面（2026-10-15），作為 EC-SPEC-06 §3 與協定程式庫 `ecpay/b2c-invoice/` 的依據：
  - [7854] 介接注意事項：只支援 TLS 1.2、TCP 443；回傳網址要用 punycode；金鑰不可放在前端；防火牆以網域放行；呼叫太快回 HTTP 403，要等 30 分鐘；HTTP 500 多半是格式、金鑰或加密錯誤。
  - [7849] 測試環境：stage 特店 `2000132`；stage 開立後立即顯示已上傳。[7824] 是名詞表。
  - [7896] 一般開立（目前版本）：`RelateNumber` String(50)、`ItemName` String(500)、`ItemRemark` String(120)、`ItemWord` String(6)；`CustomerEmail` String(80)，只能一個信箱，沒有手機時必填；`CustomerName`、`CustomerAddr` 在 `Print=1` 時必填；捐贈時 `Print=0` 且不能有統編；`CarrierType=2` 是 2 個大寫字母加 14 位數字，`CarrierType=3` 是 `/` 加 7 個 `[0-9A-Z+-.]`；`RtnCode` 範例有數字也有字串。選填 `TaxAmount` 在 2025-08-05 加入。
  - [49890] 一般開立（MIG 4.0）：欄位長度同 [7896]；2026-01-01 起零稅率要填 `ZeroTaxRateReason`（71～79）。
  - [53662] 一般開立（新增載具）：`RelateNumber` String(30)、`ItemName` String(100)、`ItemRemark` String(40)；`CarrierType=4／5` 與 `CarrierNum2`。三個版本都送到同一個 `/B2CInvoice/Issue`。
  - [7906] 作廢、[7911] 作廢折讓、[7913] 取消線上折讓：原因都是 String(20)；作廢回 `InvoiceNo`，另外兩個回 `IA_Invoice_No`。
  - [7901] 紙本折讓：`AllowanceNotify` 是 S／E／A／N，`NotifyMail` String(100)，`Reason` String(50)；品項的「單價×數量」與小計最多差 1，品項合計等於 `AllowanceAmount`；綠界隔天上傳；商家要寄紙本請買受人簽名。
  - [15391] 線上折讓：`AllowanceNotify` 固定 E，多一個 `ReturnURL`；同意連結 72 小時有效，買家點擊前可以取消；只有同意時才通知，通知是 form-urlencoded＋MD5，不含 `MerchantID`，要回 `1|OK`；stage 不寄信。
  - [7918] 註銷重開：`VoidModel`（`InvoiceNo`、`VoidReason` String(20)）加 `IssueModel`（原 `RelateNumber`、原開立時間，品項最多 200）；會通知買家。
  - [7923] 查詢發票、[7928] 查詢折讓明細（待同意的線上折讓不列出）、[7933] 查詢作廢、[7943] 查詢作廢折讓：用於 EC-SPEC-06 §3.6～3.8；回應裡的買家個資欄位不保存。
  - [7886] 手機條碼、[7891] 捐贈碼、[32089] 統編：`RtnCode=1` 只表示呼叫成功，結果看 `IsExist` 或公司名稱；統編查無（7）或財政部異常（9000001）繼續，檢查碼錯（1200125）或格式錯（2027000）停止。[62004] 說明這三個查詢只是輔助，統編查無不代表統編不存在。
  - [7881] 查詢字軌：欄位見 EC-SPEC-06 §3.10。[7954] 錯誤碼：`5070350`、`1500047` 是字軌未設定、停用或用完。
  - [36050] 更新紀錄：2026-06-23 新增字軌設定 API；2025-08-05 `TaxAmount`；2025-04 悠遊卡、一卡通載具與 MIG 4.0；2024-06-18 `ProductServiceId`；2023-07-13 線上折讓通知加 CheckMacValue；2023-03-15 Email 格式檢查。
  - [support 6897]：折讓沒有期限；作廢只能在單月 13 日以前處理上一期，申報之後要找國稅局；註銷重開過的票不能再以系統作廢；有折讓的票要先作廢全部折讓；註銷重開保留號碼、日期與 `RelateNumber`。
  - [support 6906]：後台的 B2C 註銷重開要求原票「已上傳且未超過48小時」，而且要在單月 13 日以前。[support 8519]：線上折讓的同意期限是 Email 寄出後 72 小時。[support 20187] 是後台折讓作業的說明，沒有張數或捐贈的限制。
- 其他頁面的事實以報告逐列附的頁碼為依據，規格引用時保留頁碼。實作前（WP-04～06）要重讀當時的頁面；最終以 stage 實測確認，連線 stage 需要 Ted 授權。

### 3.1 官方範例向量

整合負責人用 Node `node:crypto` 在本機重算，全部與官方頁面上的值相符：

| 種類 | 來源頁 | 組數 | 結果 |
| --- | --- | --- | --- |
| AIO CheckMacValue（SHA-256） | 建立訂單 [2902]、付款通知 [2878]、取號通知 [2881][37517] | 3 | 3／3 相符 |
| 物流 CheckMacValue（MD5） | 建立物流訂單 [7424]、查詢物流訂單 [7418] | 2 | [7424] 相符；[7418] 只在去掉 V5 新增欄位時相符（§6.2） |
| AES-128-CBC（PKCS7、Base64） | 全方位物流 [10205]、電子發票 [7958]，各有大寫與小寫 URL 編碼兩組 | 4 | 4／4 相符 |
| 發票 CheckMacValue（MD5） | 線上折讓同意通知 [38242] | 1 | 1／1 相符 |

- 金鑰用的是綠界在 [2856]、[7398]、[10197]、[7849] 公開的 stage 測試特店，只放在測試 fixture，不寫進本目錄。
- 長期留存的版本是 `tests/worker/ecpay-fixtures/vectors.ts`，由 Node 與 workerd 兩邊的測試共用（ecpay-proto 工作，2026-10-15 併入整合分支 `931f8666`）。
- AIO 信用卡的 7 組 golden（送出表單 4 組、查詢、DoAction、credit detail）由整合負責人在 repo 外依官方演算法 [2902][2904] 獨立重算，放在 `tests/worker/ecpay-fixtures/aio-credit-vectors.ts`（ecpay-aio 工作，整合 `d6fa9098`）。credit detail 用的 stage `CreditCheckCode` 出自 [2856]，同樣只放在 fixture。

## 4. 統一編號檢查碼

- 財政部財政資訊中心〈營利事業統一編號檢查碼邏輯修正說明〉（`https://www.fia.gov.tw/singlehtml/3?cntId=c4d9cff38c8642ef8872774ee9987283`）：檢查邏輯由「可被 10 整除」改為「可被 5 整除」，112 年 4 月 1 日（2023-04-01）啟用，各機關的檢核程式要在 112 年 3 月 31 日前改好。新舊號碼格式相同。
- 這頁的正文沒有列出權重與「第 7 位是 7」的例外算法，細節在附件；附件這一輪沒有讀到。
- 規格與 invoice-rules 工作採用的算法是長期通行的寫法：權重 1、2、1、2、1、2、4、1，各位乘積取十位加個位後加總為 S；S 可被 5 整除為正確；第 7 位是 7 時，S＋1 可被 5 整除也正確。本機以合成號碼核對了「新制正確、舊制不正確」與「只靠第 7 位例外才正確」兩類。
- WP-06 正式開放前要讀到財政部附件，對齊權重與例外，並把附件出處寫進測試。綠界的統編查詢對檢查碼錯誤回 `1200125` [32089]，可作為第二道確認。

## 5. 盤點方法

WP-00 由整合負責人（Claude Opus 5.5）拆成五個唯讀工作，各在 `efaf314d` 的獨立 detached worktree 執行：不改檔、不碰資料庫；只有 res-ecpay 讀網路上的文件。

| 工作 | 執行者 | 時間（2026-10-15 UTC） | 範圍 | 報告 |
| --- | --- | --- | --- | --- |
| inv-core | Codex `gpt-6.1-sol`（high） | 06:00–06:23 | 訂單、庫存、預留、供貨、權限、migration 登錄點 | 365 KB，`f206e4a4…d11d` |
| inv-infra | Codex `gpt-6.1-sol`（high） | 06:00–06:22 | Worker、綁定、排程、command／outbox、webhook、Email、Asset、旗標 | 98 KB，`b6f1f860…c828` |
| inv-portable | agy `gemini-4-argon-high` | 06:00–06:25 | 技能書、模組登錄、授權、素材、匯出、自架所需 | 92 KB，`494333cb…dede` |
| inv-ui | agy `gemini-3.8-flash-high` | 06:00–06:11 | 店面、賣家頁、啟動流程、既有瀏覽器測試的斷言 | 59 KB，`2cb11a18…104a` |
| res-ecpay | agy `gemini-4-argon-high` | 06:00–07:29 | 綠界金流、物流、電子發票（§3） | 195 KB，`ba482699…be2a` |

- 報告是工作底稿，留在本機，不進 repo。寫進本目錄的程式事實都由整合負責人回到原始碼核對過，並附檔案與行號；規格中引用盤點的完整清單時（例如 EC-SPEC-03 的寫入者總數），指的是這些報告。
- Supplier Console 工作階段的三份盤點（後端、前端、測試）也拿來交叉核對供貨與履約的接點。

## 6. 更正紀錄

### 6.1 簡報裡的名稱，由盤點更正

這些名稱是整合負責人寫在工作簡報裡的，程式裡並不存在；盤點正確指出實際名稱，本目錄以實際名稱為準：

| 簡報寫法 | 實際（`efaf314d`） |
| --- | --- |
| `module_registry` 表 | `application_definitions`、`module_definitions`（`migrations/128_module_registry.sql:47`、`:107`） |
| `tenant_module_instances` 表 | `module_instances`（`migrations/123_tenant_manual_work.sql:7`，之後的 migration 加欄位） |
| `guild_module_launches` 表 | 上架是 `guild_application_offerings`（`128_module_registry.sql:166`）；啟動是 `module_launch_plans`、`module_provision_operations`、`module_launch_plan_consumptions`、`module_provision_steps`（同檔 `:413`、`:449`、`:476`、`:495`） |
| `scoped_command_idempotency` 表 | `scoped_command_receipts`（`migrations/078_scoped_member_commands.sql:4`）；交易內加鎖，沒有會過期的 lease |
| 發布檢查的 `writerFloor`、`readerFloor`、`minSchemaVersion` 欄位 | 沒有這些欄位。writer floor 是文件裡的概念（例如 `modules/agent-commerce/hosted/inventory-reservations.md:49` 的 162 writer floor）；`deploy/cloudflare/lib/release-compatibility.mjs` 以 `CAPABILITIES`（`:15`）、`SHAPES` 的強制 capability（`:16`）、精確的 `FOUNDATION_NAMES`（`:80`）與主機另外提供的 `rollback_floor` 表達。runtime readiness 不讀 migration ledger |
| 發布檢查的 `FRONTIER_NAME` 常數 | 不存在；測試以 `legacyScan.last` 動態取得（`deploy/cloudflare/test/release-compatibility.test.mjs:628`），新增 migration 時沒有常數要改 |

### 6.2 綠界研究報告的勘誤

| 報告寫法 | 實際 | 本目錄的處理 |
| --- | --- | --- |
| §4.2.2：`10200095` 是「交易編號重複」、`10200163` 是「CheckMacValue 驗證失敗」 | 與報告自己的 §1.7 矛盾；[2890] 上 `10200095` 是訂單未成立、交易失敗（已逐頁讀過）。`10200163` 在 [2890] 的讀回中沒有出現，只有報告 §1.7 說是先買後付申請失敗，未獨立確認 | EC-SPEC-04 只把查詢的 `10200095` 當失敗；其他未知代碼一律當結果不明，再查詢 |
| 報告引用 [7901] 的「一張發票最多僅能開立50張折讓單」與「發票若有捐贈，不可開立折讓單」 | 2026-10-15 讀的 [7901] 與其他已讀的發票頁都沒有這兩句 | EC-SPEC-06 §3.7 保守照做，標為待 stage 或向綠界確認 |
| [7418] 查詢物流訂單的範例回應 | 頁面在 2024-11-25 升到 V5 時加了 `SenderName`、`SenderPhone`、`SenderCellPhone`，範例的 CheckMacValue 沒有跟著更新：不含這三欄才算得出頁面上的 `B655FB0F…`，含的話是 `9FB2FDBE…` | EC-SPEC-05 以實際收到的全部欄位驗證，並在 stage 以真實回應確認；protocol 測試兩種情況都涵蓋 |

### 6.2.1 綠界發票頁面彼此不一致的地方

| 地方 | 不一致 | EC-SPEC-06 的處理 |
| --- | --- | --- |
| `ItemName`、`RelateNumber`、`ItemRemark` 長度 | 開立 [7896][49890] 是 500／50／120，`ItemName` 在 [7901][7918] 也是 500；[53662] 是 100／30／40 | 名稱上限 100 字，`RelateNumber` 20 字；長度單位待 stage 確認 |
| `Data` 裡的 `MerchantID` | [7906][7911][7913][7923][7928][7933][7943][7886][7881][15391] 的範例寫成數字；[7896][7901][7891][32089] 是字串 | 一律送字串；stage 確認 |
| [7906]、[7911] 範例的 `InvoiceNo` | 範例是 8 字，欄位表寫固定 10 字 | 以欄位表為準 |
| [7881] 回應範例 | `InvoiceInfo` 寫成物件、少一個逗號 | 解析以欄位表為準，陣列與單一物件都接受 |
| [7918] 回應範例 | 範例的 `InvoiceNo` 格式不對 | 以欄位表為準 |
| 註銷重開的 48 小時 | 只有後台說明 [support 6906] 有，API 頁 [7918] 沒有 | 照後台的限制，stage 確認 |

### 6.3 Toolkit 與官方文件不同的地方

以下是研究報告 §4.1 的比對結果；標「已確認」的由整合負責人讀官方頁面核對，其餘未獨立重驗：

- 作廢期限寫成「同月 13 日前可作廢上期發票」：官方是單月 13 日 23:59:59 以前（[7906]，已確認）。
- 物流查詢只列 `/Helper/QueryLogisticsTradeInfo/V2`：官方已是 V5 [7418]，另有全方位物流的查詢。
- 沒有全方位物流（`Express/v2/*`，AES-JSON）與 `UNIMARTFREEZE`。
- 電子發票缺 2025 年後的欄位：`CarrierType=4／5` 與 `CarrierNum2` [53662]、`ZeroTaxRateReason` [49890]、選填的 `TaxAmount` [7896]。
- 把 AIO 的兩個 stage 特店說成 C2C／B2C：官方的區分是有無 3D 驗證 [2856]；B2C／C2C 是物流的分法。

### 6.4 盤點報告與原始碼不符的地方

寫規格時引用的事實都已回到原始碼核對；以下是發現的錯誤，WP-00 以實際內容為準：

| 報告 | 寫法 | 實際（`efaf314d`） |
| --- | --- | --- |
| inv-portable A.6 | `repositories.lock.json` 有 9 個帶 `role` 的消費者 repo，例如 `freedom-marketing-hub`、`freedom-oss-kit`；storefront 釘在 `87eda487fb15…` | 9 個 `FreeTWAI-AI/*` repo：`.github`、`FreeTWAI-AI.github.io`、`freedom-agent-kit`、`freedom-growth-automation`、`freedom-project-page`、`freedom-project-template`、`freedom-skill-registry`、`freedom-storefront`、`freedom-supplier-client`；沒有 `role` 欄位；storefront 是 `87eda4878fb7…` |
| inv-portable C.3 | 由 `governance/migration-immutability-baseline.json` 保護 migration 不被修改 | 沒有這個檔案；由 `scripts/ci/verify-source-boundaries.py:77-82` 對照 inventory，以及套用時的 digest 比對（`packages/db/migration-plan.mjs:132`）保護 |
| inv-portable C.4 | 33 個套件沒有授權 | lockfile 少了 `license` 欄位；已安裝的套件都有授權（MIT 24、ISC 8、Apache-2.0 1，WP-00 §5.2） |
| inv-portable D.1 | Worker 用 `AVATAR_BUCKET`、`MEDIA_BUCKET`；最新 migration 是 `167_guild_Rename_and_reclassify.sql` | 只有可選的 `MEDIA`（`apps/platform-api/src/worker.ts:232`），主設定沒有 R2 binding；最新是 `167_community_ar.sql` |
| inv-portable D.3 | `commerce_inventory_reservations.status IN ('reserved','released','Restored')` | 欄位是 `state IN ('held','released')`（`migrations/162_hosted_inventory_reservations.sql:9`） |
| inv-infra | `direct-quotes.ts:68` 的 `payment_state` | 在 `:70` |

### 6.5 規劃包的限制，本輪補上的部分

- EC 參考圖片：已取得並檢視（§2.1）。
- 三個上游 repo 與任何 MCP 仍未執行；金流、物流、發票的 sandbox 與正式環境仍未操作（規劃包 limitations）。

## 7. 郵遞區號

- 中華郵政「臺灣地區郵遞區號前3碼一覽表」（103.12.25 啟用），下載頁 `https://www.post.gov.tw/post/internet/Download/index.jsp?ID=220306`。2026-10-15 由整合負責人取得（xls，SHA-256 `0b0a6672d53c174ed5db432cb9c24872edecf204fe7c060bc541dfd495486ff0`）並逐列解析：368 個前 3 碼。2020 年改用 3+3 碼時，前 3 碼沒有變。
- 離島（EC-SPEC-05 §3.5）：連江 209 南竿、210 北竿、211 莒光、212 東引；澎湖 880～885；金門 890～894 與 896 烏坵；屏東 929 琉球；臺東 951 綠島、952 蘭嶼；南海諸島 817 東沙、819 南沙；宜蘭 290 釣魚臺列嶼。
- 表格寫進 `modules/agent-commerce/fulfilment/rules/postal.ts`（fulfil-rules 工作）；中華郵政公布新表時要重新核對。xls 留在本機，不進 repo。

## 8. 物流貨態代碼表

- 綠界「物流貨態代碼表」：`https://developers.ecpay.com.tw/logistics_status/` 轉址到 xlsx 檔。2026-10-15 由整合負責人下載（`Last-Modified` 2026-06-04，SHA-256 `16bddad1c85b91ba5decd148d60dc0143b62a1d7ff693b568e9148cfdf45bef3`）並逐列解析：統一超商、全家、萊爾富、黑貓、中華郵政五頁，依子類型展開共 523 列，另有「異動歷程」頁。最近的異動：2026-06-04 因 OK 超商店到店 2026-07-01 停止服務，移除 `OKMARTC2C` 的代碼；2026-05-13 更新 `2053`、`2066`、`2062`、`2097` 的說明。
- C2 用到的五種子類型共 278 列，對照寫在 [ecpay-logistics-status-map.tsv](ecpay-logistics-status-map.tsv)（EC-SPEC-05 §6.3）。綠界訊息照原文；判讀依訊息文字，取捨見 decisions.md。
- 這份表可公開下載；EC-SPEC-05 先前引用的是廠商後台的「物流貨態代碼查詢」[7440]。兩者或實際通知不一致時，記入本節再改 TSV。xlsx 留在本機，不進 repo。
