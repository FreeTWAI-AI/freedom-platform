# 開源作品與行銷模組：上游選型及第一刀

檢查日期：2026-09-23。這次只讀上游公開原始碼、README、license 與 GitHub API；沒有執行上游程式、安裝上游依賴或複製原始碼進 Freedom。維護狀況是所列 commit 的觀察，不是對未來維護的保證。

| 專案 | 實際檢查的 default-branch SHA | 授權／維護觀察 | Freedom 採用方式 |
| --- | --- | --- | --- |
| [Penpot](https://github.com/penpot/penpot) | `267134e77983b04fc0f31a91170afa944f04369c`（develop；2026-09-22） | MPL-2.0；未封存，近期有 runtime 更新 | 設計協作工具，後續接外部設計資產；不拿來重建 GitHub 作品登錄核心 |
| [Refferq](https://github.com/Refferq/Refferq) | `25df6596a15cf1e9d26021752137d66c22dd8e34`（main；2026-06-13） | MIT；未封存；本次 HEAD 為依賴更新 | 參考 affiliate portal／campaign 入口；不採用其 payout 帳本或整包部署 |
| [RefRef](https://github.com/amicalhq/refref) | `81af934fec3b20990a4d9af7ed472d0d14d73a82`（main；2026-03-20） | AGPL-3.0；README 明列 alpha；未封存 | 參考 program／participant／refcode／attribution 概念；不當供貨 SKU、出貨或中央結算底座 |

## Penpot 適合放在哪裡

Penpot 提供多人設計、元件／design token、原型與程式檢視。其 [backend dependencies](https://github.com/penpot/penpot/blob/267134e77983b04fc0f31a91170afa944f04369c/backend/deps.edn) 是 Clojure/JVM，並不是 Freedom 的 TypeScript 模組；[Compose](https://github.com/penpot/penpot/blob/267134e77983b04fc0f31a91170afa944f04369c/docker/images/docker-compose.yaml) 有自己的 PostgreSQL、Valkey、frontend、backend、exporter 及 MCP。整包改成作品平台會引入另一套身份與資料生命週期，卻仍缺 repo／commit／license／maintainer 這些必要領域。

適合的後續整合是 `DesignArtifactRef(project_id, provider, external_ref, revision, preview_ref)`：在作品頁連到設計文件或公開原型。Penpot 的 [官方 integration guide](https://help.penpot.app/technical-guide/integration/) 提供 team webhook 與 access-token API；未來由窄權限 connector 接入，token 留在 server credential boundary，Penpot 仍保存設計真相。這次沒有部署 Penpot，也沒有啟用其 connector。

## Referral 工具可以借什麼，不能直接承接什麼

RefRef 的 [schema](https://github.com/amicalhq/refref/blob/81af934fec3b20990a4d9af7ed472d0d14d73a82/packages/coredb/src/schema.ts) 有 organization、product、program、participant、refcode、referral、event、reward；這裡的 product 是 referral program 的商家／產品範圍，不是實體供貨的 SKU／規格／庫存／履約完整模型。[purchase tracking](https://github.com/amicalhq/refref/blob/81af934fec3b20990a4d9af7ed472d0d14d73a82/apps/api/src/routes/v1/track/purchase.ts) 可供理解事件歸因；[reward engine](https://github.com/amicalhq/refref/blob/81af934fec3b20990a4d9af7ed472d0d14d73a82/apps/api/src/services/reward-engine.ts) 有獎勵計算，但本次看到寫入 reward 時使用固定 USD，不能直接代替 Freedom 的幣別／金額與版本化分配規則。[LICENSE](https://github.com/amicalhq/refref/blob/81af934fec3b20990a4d9af7ed472d0d14d73a82/LICENSE) 為 AGPL-3.0；本輪不搬程式，未形成混合授權程式庫。

Refferq 的 [schema](https://github.com/Refferq/Refferq/blob/25df6596a15cf1e9d26021752137d66c22dd8e34/prisma/schema.prisma) 含 Affiliate、Referral、Conversion、Commission、Payout，是推薦者管理而非多 Supplier／單 Seller 商務契約。實際 [payout route](https://github.com/Refferq/Refferq/blob/25df6596a15cf1e9d26021752137d66c22dd8e34/src/app/api/admin/payouts/route.ts) 在建立 PENDING payout 後把相關 commissions 設為 PAID，這個路徑沒有外部付款確認。該檔亦查詢 schema 未列於 Affiliate 的 name/email 欄位，並以 any 繞過型別。這是靜態發現，沒有宣稱整套上游已通過執行測試；足以判定不可直接拿來當資金或付款真相。

Freedom 會保留「內容來源 → 私人文案 → 當事人分享 → 有來源的結果觀察」主線。Tracking link、partner program 與 attribution 可以下一輪加入；成交、付款與退款只消費既有商務核心的可驗證事件。行銷模組不自創收益、佣金已付或銀行實收。

## 已實作的可操作範圍

遵循 `02-architecture-repositories.md` 的同一 PostgreSQL、模組化單體與共用 identity；遵循 `04-module-specifications.md` §5、§7 的來源版本與候選作品入口。畫面獨立為「開源作品」與「行銷工作室」，不再借用一般作品／商機物件。

### 開源作品

- 會員填公開 `https://github.com/owner/repo`、名稱、用途、使用方式、可選展示網址，以及自行聲明的 author／maintainer／contributor／curator 關係。
- 後端僅匿名讀取固定 `api.github.com` 的 public repo metadata、default branch commit，以及該 commit 的 license。8 秒整體 timeout、196608 bytes 回應上限、禁止 redirect，不讀 server `gh` 登入或 token。
- 保存 stable repository ID、immutable SHA、授權、fork／archived 與 source snapshot。相同 SHA 的 metadata 改變也新增 observation；原 snapshot 不改寫。重新查詢同一組 facts 則不重複建版。
- 作品是登入社群內可見的 candidate。Relationship 明標 self-declared，不假裝已驗證 GitHub owner、official 或 commercial-ready；缺授權標 `NOASSERTION`。Verified GitHub 身份、manifest capability readiness、QC／付費合作留待後續，不讓這些缺口消失於 UI。
- Owner 可以修改介紹或手動更新 GitHub 版本。stable ID 變更、private repo、API 限流／失效會報錯並保留原紀錄；不把網路失敗變成成功。
- 文件、issues 與 demo 是外部 link；不執行上游 code、不鏡像 README HTML、不替使用者 fork。

### 行銷工作室

- 選自己登錄的作品、自己的供貨商品，或填手動活動 brief；保存受眾、目標、文案與來源 snapshot/digest。
- Supplier source 經 `catalog-commerce.getMarketingProductSource` 唯讀 application port 取得，保留供貨 offer revision；不直接寫供貨資料，也不把供貨價稱為零售价。
- 草稿只有 owner 可讀／改。作品後來 refresh 或供貨價後來更新，不改寫既有 campaign source。
- 可修改文案與記錄人工分享／推薦連結。Share observation 保留當時內容 snapshot；狀態固定 self_reported，campaign 仍是 draft。
- 本刀沒有生成模型、自動發文、排程 provider、click analytics、推薦佣金或 payment execution。下一刀可依現行 canonical SourceSnapshot／ActionIntent／bounded grant 逐一接渠道。

## API 給下一位接線者

以下均掛在 `/api/v1`，沿用 session、Origin、CSRF、Idempotency-Key；update 另帶 If-Match。

| API | Body／結果 |
| --- | --- |
| `GET /opensource/projects` | `{items}`，同社群 candidate；每件含 `current_version` |
| `POST /opensource/projects` | `repository_url,title,description,use_notes,demo_url?,relationship,consent_to_share:true` |
| `POST /opensource/projects/{id}:refresh` | `{}`；owner scope，固定新的 source observation |
| `POST /opensource/projects/{id}:revise` | `title,description,use_notes,demo_url?`；不改 GitHub identity |
| `GET /marketing/campaigns` | `{items}`，僅 owner；每件含 source_snapshot 及 shares |
| `POST /marketing/campaigns` | `title,audience,goal,draft_text`；來源三擇一：`source_project_id`／`source_supplier_product_id`／`source_brief` |
| `POST /marketing/campaigns/{id}:revise` | `title,audience,goal,draft_text`；來源與歷史分享不改寫 |
| `POST /marketing/campaigns/{id}/shares` | `channel,share_url,note?`；人工回報，不發送外部訊息 |

檢驗見 `tests/runtime/opensource-marketing.test.ts`（真 PostgreSQL；GitHub public response fixture 為邊界測試）與 `tests/e2e/opensource-modules.spec.ts`（真 API／DB 的文案編輯、分享、重整與帳號隔離）。部署後的真 GitHub public import 另外記錄，不能把 fixture 測試稱為 provider 真接線驗收。
