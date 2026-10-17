# 來源、方法與更正紀錄

## 固定基準

| 項目 | 值 |
| --- | --- |
| 程式基準 | `FreeTWAI/freedom-platform@efaf314d7397e288c6ac094c5d90ffdcc1094f14`（2026-10-15 04:46Z 再次 fetch，`origin/main` 仍為此 SHA） |
| 計畫包 | Ted 提供的 `Freedom-Supplier-Console-Project-Plan-v1.0` ZIP，SHA256 `8fb89a52622714ec1662f9399f58c08dd016e55436ccacb0744a40456b7dd18a` |
| 計畫主稿 | `Supplier-Console-Project-Plan-v1.0.md` SHA256 `7c13f82e4d1066f86fd97a1b0edfcfe9158985f4fdc01ef399758387cc11baf0` |
| 驗收 JSON | `requirements-and-acceptance.json` SHA256 `b87925ff9edcd0b957c32366128798a52176294ef95af28452d96f9b4018d5a1`（SC-R01～R40、AT-01～48 全部 `not_run`） |
| 其他包內檔 | `AGENT-START-HERE.md` `472873fa…eeaac`；`README.md` `0e343b75…36b06`；`.docx` `16c2c212…4ce62`；`source-index.json` `0c1d35e3…3ba17d` |
| v1.1 補充 | Ted 於 2026-10-15 提供的 `Freedom-Commerce-Project-Planning-Pack-v1.0` ZIP（SHA256 `b87179ef…bb81`）內 `Supplier-Console-v1.1-Logistics-Addendum.md` SHA256 `a3560eba88fe6f74a2d35562d4cba52134c758b47c45c83c703af5b32425ad3b`（`.docx` `dc66ac8b…3973b`）；該包 `requirements-and-acceptance.json` `5642daab…60b2` 的 `supplier_addendum`（SC-L01～18、SC-LAT01～24 全部 planned／`not_run`）；包內 `baseline/Supplier-Console-Project-Plan-v1.0.md` 與上列主稿雜湊相同 |
| Refferq | `Refferq/Refferq@25df6596a15cf1e9d26021752137d66c22dd8e34`（MIT），只做靜態閱讀，見 [refferq-adoption.md](refferq-adoption.md) |
| 最大 migration | `migrations/167_community_ar.sql` |

計畫包本身不提交進 repo；本目錄只以 SHA 引用。計畫不授予 merge、部署、正式資料修改、付款、寄信或聯絡會員的權限。

## 盤點方法

WP-00 由整合負責人（Claude Opus 5.5）拆成四個唯讀工作，各在 `efaf314d` 的獨立 detached worktree 執行，不改檔、不跑網路、不碰資料庫：

| 工作 | 執行者 | 結果 |
| --- | --- | --- |
| 前端供貨體驗、恢復行為、E2E 耦合、路由限制 | Codex `gpt-6.1-sol` | 1108 行；抽查的檔案與行號全部正確，採用為主要前端依據 |
| 後端路由、資料權威、並行、旗標 | agy `gemini-4-argon-high` | 378 行；**多處路由路徑與 capability 錯誤**（見下），只採用經逐項核對的事實 |
| 測試、descriptor、CI 範圍 | agy `gemini-4-argon-high` | 可用；兩個不存在的檔名已更正 |
| Refferq 採用界線 | agy `gemini-3.8-flash-high` | 可用；細節更正後寫入採用表 |

所有寫進本目錄的程式事實，都由整合負責人回到 `efaf314d` 原始碼核對過；未核對者標示「未驗證」。

## 更正紀錄

後端盤點與程式實際不符的項目（以程式為準）：

| 報告寫法 | 實際（`efaf314d`） |
| --- | --- |
| `POST …/profile` 建立零售商店 | `POST …/setup`（`apps/platform-api/src/routes/hosted-store.ts:64`） |
| `POST …/publications` | `POST …/publish`、`…/unpublish`（同檔 `:116`） |
| `POST …/products/:id/offers` | `POST …/products/:product_id/supply-offer`（`routes/hosted-distribution.ts:19`） |
| `POST …/offers/:id/withdraw` | `POST …/supply-offers/:offer_id/withdraw`（同檔 `:24`） |
| `…/distributions` | `…/distribution-selections`（同檔 `:29,33,38,48`） |
| `…/supply-requests/:id/decisions` | `…/supply-requests/:selection_id/decision`（同檔 `:43`） |
| 決定可為 `changes_requested` | `DistributionDecisionSchema.decision` 只有 `accepted`／`declined`／`revoked`（`contracts/guild-launchpad/v1/hosted-distribution.ts:19`）；`changes_requested` 只是既有 selection 狀態 |
| `supply-products`、`supply-terms`、`supply-offers`、`supply-requests` 讀取只要 `store:read` | 皆為 `store:write`（`modules/agent-commerce/hosted/supply-catalog.ts:47`、`supply-terms.ts:26`、`distribution.ts:16,78`） |
| 供貨商品庫設定要 `store:write` | `store:manage`（`supply-catalog.ts:26`） |
| 回覆申請時狀態檢查先於版本檢查、回傳只有 ID | 先 `checkVersion`（412），再 409 `snapshot_changed`／`invalid_state`，回傳完整 selection 投影（`distribution.ts:122-139`） |
| `/me/supply-catalogs` 只列 `slug IS NULL` | 列出所有可讀的 storefront instance；只有 `/me/stores` 排除純供貨（`store.ts:196`） |
| 公開店面為 `/hosted-stores/:slug` | `/api/v1/public/stores/:slug`、`/shops/:slug`（`hosted-store.ts:124,130`） |
| 有 `GET supply-reservations/:order_id` | 只有清單 `GET …/supply-reservations`（`routes/hosted-orders.ts:92`），沒有供應端詳情路由 |

測試盤點中 `contracts/guild-launchpad/v1/hosted-store.ts`、`hosted-orders.ts` 並不存在；實際為 `hosted-order.ts`（由 `agent-commerce` descriptor 擁有）與 `hosted-shared-order.ts`（由 `hosted-distribution` 擁有）。

後端盤點中經核對**屬實**並被採用的事實：純供貨商品的照片讀寫因 `photoProducts` 過濾 `l.own_retail_enabled` 而全部 404（`photo-projection.ts:33`，`photo-commands.ts:30,37`，`photo-read.ts:14,32`）；沒有 supply-profile 修改路由；`module_instances_one_storefront` 讓每個 tenant 最多一個 storefront instance（`migrations/134_hosted_storefronts.sql:6`）；業主端沒有列出邀請的 API；repo 內沒有 CSV 公式防護工具。

## S1 實作工作

由整合負責人寫 brief、審查與整合；各 job 在自己的 worktree、拋棄式資料庫與 E2E port 執行，不推送、不開 PR。

| 工作 | 執行者 | 結果 | 整合時的修正 |
| --- | --- | --- | --- |
| A0 新版開關 | Codex `gpt-6.1-sol` | `6787a6ab` | — |
| A 讀取、事業資料修改、權限 | Codex `gpt-6.1-sol` | `b5f2a8b9`…`bb249e56` | 可售量改由同一個讀取欄位推導（`9626ce5b`） |
| B 純供貨商品照片 | agy `gemini-4-argon-high` | `7d0df2e9`、`b62fb5da` | 整合時 rebase |
| C 營運中心前端 | Codex `gpt-6.1-sol` | `d87081bd` | 審查修正 `93b7fb5c`、`6224927b`；以穩定的店面 ID 區分同名合作店家（`cea896f9`） |
| P 效能樣本 | agy `gemini-4-argon-high` | 只在本機量測，不提交 | — |
| D1 連續主線 SC-E2E-01～02 | agy `gemini-4-argon-high` | `c4f3a9ba` | 拿掉自行加長的等待時間，改用共用登入（`e64a805f`） |
| D2 合作 SC-E2E-10～13 | agy `gemini-3.8-flash-high` | `a447fdd7` | 改用共用登入、把條件式檢查改成確定的檢查（`1a10a94d`） |
| D3 恢復 SC-E2E-20～26 | Codex `gpt-6.1-sol` | `d41f8abf` | 測試找到權限降級後的畫面問題（AT-37），修在 `6e606f86` |
| D4 導覽與鍵盤 SC-E2E-30～32 | Codex `gpt-6.1-sol` | `e6e0d116` | 測試找到寫入後鍵盤焦點遺失，修在 `60e9c195` |
| D5 視覺 SC-E2E-40 | agy `gemini-3.8-flash-high` | `39fb9b13` | 測試找到側欄群組標籤只有 12.8px，修在 `60e9c195`；截圖前等該頁標題（`ea24fbf6`） |

共用殼層 `ConsoleShell` 由整合負責人抽出（`863614ef`）。

PR #761 審查的三項修正：

| 工作 | 執行者 | 結果 | 整合時的修正 |
| --- | --- | --- | --- |
| F1 審核頁只讀自己那筆申請 | Codex `gpt-6.1-sol` | `25400d64`、`437f79ec` | SC-E2E-14 不再停用供貨條件的保留 trigger；descriptor 補上新讀取（`fc8c7944`） |
| F2 共用版本變動時一起更新事業資料與 owner 投影 | agy `gemini-3.8-flash-high` | `991a706a` | — |
| F3 被拒後重新讀到有效的事業資料才解除寫入鎖 | agy `gemini-4-argon-high` | `cde97f93` | 解除規則移到純狀態模組；重新讀取失敗時顯示「確認目前權限前暫停寫入。」與重試（`2831c6e8`） |

## S2 實作工作

| 工作 | 執行者 | 結果 | 整合時的修正 |
| --- | --- | --- | --- |
| S2-A 讀取：預留篩選與單筆、近期變更、公會本人待辦摘要 | Codex `gpt-6.1-sol` | `ea1bd1c6`、`ea08b51e` | — |
| S2-C 預留篩選與詳情、合作店家的預留、近期變更與紀錄頁 | Codex `gpt-6.1-sol` | `33e8a262`、`c53f4ff3` | 預留日期篩選一律換成台灣日曆日，不受瀏覽器時區影響（`1472a532`） |
| S2-G 公會「商品與供貨」區塊的本人待辦（G-14） | agy `gemini-3.8-flash-high` | `b8754f2a` | README 用詞對齊其他區塊（`1472a532`）；刪掉檔尾多餘空行（`3146648c`） |
| S2-E 瀏覽器測試 SC-E2E-50～54 | agy `gemini-4-argon-high` | `40283a7c` | 拿掉找不到頁面就按「重新載入頁面」的繞道，頁面載入失敗會直接讓測試失敗（`4c9d2fee`） |

契約（`4666e296`）與規格文件由整合負責人撰寫。S2 在概覽加了「近期變更」，S1 的 SC-E2E-13、24 因此改成只檢查各自的區段（`b21d7aa2`）。

## S3 實作工作

| 工作 | 執行者 | 結果 | 整合時的修正 |
| --- | --- | --- | --- |
| S3-RA 營運報表的讀取、CSV 與 runtime 測試（SC-10） | Codex `gpt-6.1-sol` | `da101fbe`、`1f5690c3` | — |
| S3-RC 營運報表頁與 CSV 下載 | Codex `gpt-6.1-sol` | `e537b988`、`39022460`、`7c93c78d` | CSV 請求逾時或取消後，晚到的失敗也要接住（`eeeec085`） |
| M1A 素材的媒體用途、上傳、供應商讀取檔案與旗標（D-05、D-14） | Codex `gpt-6.1-sol` | `20effdd6`、`6d11a1fd` | — |
| M1B 素材紀錄、路由、合作方清單與 runtime 測試 | Codex `gpt-6.1-sol` | `6319be96` | — |
| M1C 合作方讀取目前的素材檔案（AT-25、AT-26） | Codex `gpt-6.1-sol` | `adbd1c0c` | 匿名被拒時也回 private、no-store 與 `Vary: Cookie`（`9002ba56`）；路由清單把這三個快取 middleware 歸類（`f7969658`） |
| M2 賣家「供貨合作」面板的合作素材區 | agy `gemini-3.8-flash-high` | `816cb395`、`28cfe2d6`；第二輪 `15348393` | 第一輪沒有讀完規則分片，第二輪補讀，並修正同名供應商的 React key、身分檢查、原始錯誤文字與更新中的提示；標題間距由整合負責人收緊（`d20682e9`） |
| M3 供應商的「行銷素材」頁 | Codex `gpt-6.1-sol` | `249d2c85`、`36f421a6` | 接上導覽、頁面標籤與測試（`2fde1329`）；上傳前檢查改讀契約上限，D-11 之前的公開使用與撤回文字保持屬實（`9a9cdfb1`） |
| S3-E 瀏覽器測試 SC-E2E-60～68 | agy `gemini-4-argon-high` | `99df135d` | — |
| S3-E 第二輪 SC-E2E-69～71 | agy `gemini-4-argon-high` | `3f73957f` | SC-E2E-70 確認重新授權後同一路徑又能讀，證明撤回後的 404 來自撤回（`076f5106`） |
| S3-AT 瀏覽器測試 SC-E2E-78（上傳中切換事業或帳號，AT-35） | Codex `gpt-6.1-sol` | `210192f1` | 測試內的動態 import 改成檔案頂端的 import（`e4423182`） |
| 審查修正：讀權拒絕清除合作素材，同版本媒體在暫時 503 後可重試（M2-18、M2-19，SC-E2E-79～81） | 本分支審查修正 | 與 SC-SPEC-05 同一提交 | 401／403／404 與其餘拒絕清掉該次讀取範圍；5xx 保留明示舊資料。成功的 metadata 讀取才清除媒體失敗狀態。權限恢復後不強制重下已解碼的同一版本圖片 |

契約（`f72e0663`、`f85512bd`）、migration 168（`54c0b14d`）與規格文件由整合負責人撰寫。S3 新增「行銷素材」與「營運報表」兩頁，S1 的 SC-E2E-01 因此改成逐一列出設定前停用的頁面（`da56baf7`、`71cc2789`）。

## D-11 實作工作

| 工作 | 執行者 | 結果 | 整合時的修正 |
| --- | --- | --- | --- |
| D11 合作圖片複製成賣家的店面照片（migration 169、路由、賣家畫面、runtime 測試） | Codex `gpt-6.1-sol` | `583f8d29`、`6140a86e`、`3277b44b` | 契約產生器補上三份文件，店面頁接上旗標，對話框與縮圖改用樣式表（`a039d64c`）；旗標關閉時改成每張圖片一行說明（`5f329f84`）；每種拒絕附一個下一步（`a80cbca7`）；素材卡片裡的商品列加上「店面照片・」（`4cc33e9f`） |
| D11-E 瀏覽器測試 SC-E2E-72～75 | agy `gemini-4-argon-high` | `a4ce48b5` | 測試找到確認對話框打開時焦點落在「複製並使用」，修在 `3f4f267b` |
| D11 後續：DP-13／14、已儲存預覽與 SC-E2E-76、77 | Codex `gpt-6.1-sol` | `bd09a9c9`、`81e6f13a`、`f2c62178` | 旗標關閉時保留目前公開快照；下次發布拿掉失效來源，仍然有效的來源留原複本。已儲存預覽 200。SC-E2E-77 改為送出中的離開保護；審查執行裡晚到請求是 `net::ERR_ABORTED`，不記成已送到下一個帳號 |

## 開放 PR 重疊檢查（2026-10-15 14:54Z，main `5bee7376`）

27 個開放 PR 中，除了各 PR 都會改的 file inventory（合併時重新產生），與本案重疊的只有：

- `apps/platform-api/src/platform-app.ts`：#660、#757、#759。本案只在這裡加一行旗標開啟時的路由與 `/api/v1/site` 的 `supplier_console_enabled` 欄位，合併時可能有小衝突。
- `apps/portal-web/src/modules/Community.tsx`：#690（draft）。本案只在 `SiteConfig` 型別加 `supplier_console_enabled`。
