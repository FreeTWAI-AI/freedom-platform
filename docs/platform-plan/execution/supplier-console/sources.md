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

## 開放 PR 重疊檢查（2026-10-15 04:46Z）

沒有其他開放 PR 修改供貨相關檔案。#680 修改 `apps/platform-api/src/platform-app.ts`（本案也要在此加功能設定欄位），合併時可能有小衝突；#670 屬 catalog-commerce，無重疊。#680 描述中的部署狀態未經本案驗證。
