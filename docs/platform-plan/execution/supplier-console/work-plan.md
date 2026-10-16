# 工作包、批次、依賴與決策

整體進度追蹤沿用 [#234](https://github.com/FreeTWAI/freedom-platform/issues/234)，這裡只記錄工作怎麼切、誰改哪些檔案、彼此依賴與待決事項，不另開進度系統。

## 1. 工作包與批次

| 工作包 | 本案內容 | 批次 | 直接依賴 |
| --- | --- | --- | --- |
| WP-00 現況與差異 | [WP-00-baseline.md](WP-00-baseline.md)、[sources.md](sources.md)、[refferq-adoption.md](refferq-adoption.md) | — | 無 |
| WP-01 產品設計與 Spec | [pages.md](pages.md)、SC-SPEC-01～06、契約 `contracts/guild-launchpad/v1/supplier-console.ts` | — | WP-00 |
| WP-02 殼層與路由 | 營運中心殼層、路由、controller、離開保護、舊入口 | S1 | WP-01 契約 |
| WP-03 用途查詢與資料 | 五個新讀取、`PATCH supply-profile`、純供貨照片、旗標 | S1；S2 補查詢 | WP-01 契約 |
| WP-04 供貨旅程整合 | 各頁接上真 API，J01～J04、J06 在新版走通 | S1 | WP-02、WP-03 |
| WP-05 素材與管理完整度 | 合作素材、營運報表、CSV | S3 | WP-02、WP-03、D-05、D-14 |
| WP-06 整合與驗證 | 同一候選的 runtime／E2E／視覺／效能證據 | 每批 | WP-04（S1）、WP-05（S3） |
| WP-07 發布、試用與退場 | staging、正式開啟、試用、舊頁退場 | 每批 | WP-06 |

批次內容：

- **S1 第一條供貨旅程**（本輪實作）：殼層、概覽、商品清單／新增／詳情（含照片）、供貨條件與審核、合作店家清單／詳情、預留、設定與資料。詳見 [first-journey.md](first-journey.md)。
- **S2 補齊查詢**：預留的伺服器篩選與單筆詳情（G-07）、近期變更（G-09）、公會區塊的本人待辦（G-14）。可先接在 S1 分支上開發，S1 合併後開 PR。
- **S3 素材與報表**：SC-09、SC-10（SC-SPEC-04 §4、§5）。D-05、D-14 已核准。報表要連到 S2 的預留篩選，所以 S3 接在 S2 分支上開發，S1、S2 合併後開 PR。D-11（素材進公開店面）不在 S3 這批，見 §5。

## 2. 三條實作線與 S1 分工

每條線只有一個寫入者；Claude（Opus 5.5）負責設計、寫 brief、整合與驗證，不和實作者同時改同一個檔案。

| 線 | S1 job | 執行者 | 內容 |
| --- | --- | --- | --- |
| 用途 API／資料 | A | Codex `gpt-6.1-sol` | 旗標（app、runtime、server、worker、site、E2E fixture 與 E2E server）；`apps/platform-api/src/routes/hosted-supplier-console.ts`（五個讀取與 `PATCH R/supply-profile`），只在新版開啟時掛在 `platform-app.ts` 的 launchpad 區塊內；讀取服務 `modules/agent-commerce/supplier-console/reads.ts`；`updateSupplyProfile`（`supply-catalog.ts`）；從 `publishSupplyOffer` 抽出 `supplyOfferTerms`；descriptor 的 API surface；`tests/runtime/supplier-console.test.ts` 與契約正反例 |
| 用途 API／資料 | B | agy `gemini-4-argon-high` | 純供貨照片：`photoProducts` 的 `retailOnly` 參數、四個呼叫點與 `hosted-store-media.ts`（只在新版開啟時放寬）；`tests/runtime/supplier-console-writes.test.ts` |
| 殼層／體驗 | C | Codex `gpt-6.1-sol` | `modules/agent-commerce/supplier-console/**` 的殼層、頁面、controller 與純狀態模組；`HostedStore.tsx` 路由與關閉時的舊頁回退；`App.tsx` 的 h1 與離開檢查；頁面工具登錄；`tests/runtime/supplier-console-state.test.ts` |
| 旅程／素材 | D1 | agy `gemini-4-argon` | `tests/e2e/supplier-console.spec.ts`：旅程 1～15 連續一條、舊書籤、新版關閉時回退 |
| 旅程／素材 | D2 | agy `gemini-3.8-flash` | `tests/e2e/supplier-console-cooperation.spec.ts`：步驟 8～11 的分支（改價、改條件、不同意／撤回、同名店、唯讀成員） |
| 旅程／素材 | D3 | Codex `gpt-6.1-sol` | `tests/e2e/supplier-console-recovery.spec.ts`：J06；照片 pass 的純供貨案例 |
| 旅程／素材 | D4 | Codex `gpt-6.1-sol` | `tests/e2e/supplier-console-navigation.spec.ts`：事業切換時晚到的讀取（AT-03）、200 件商品的清單與返回位置（AT-09、10、30）、鍵盤與焦點（AT-41） |
| 旅程／素材 | D5 | agy `gemini-3.8-flash` | `tests/e2e/supplier-console-visual.spec.ts`：五種寬度與五種外觀的視覺驗收（AT-40） |

A、B、C 平行（各自的 worktree、拋棄式資料庫與 E2E port），以已提交的契約為共同邊界；D1～D3 在 A＋B＋C 整合後平行開始，各寫一支 spec；D4、D5 是整合後補上的瀏覽器缺口，同樣各寫一支。agy 的輸出（B、D1、D2、D5）只當草稿：Claude 逐項對照程式與測試後才整合。

實際分工的調整：原排給 B 的 `PATCH supply-profile` 改由 A 放在新路由檔與 `supply-catalog.ts`，`store.ts` 與 `hosted-store.ts` 都不必修改；契約與 `generate-contracts.ts` 已隨 WP-01 提交。

## 3. 共用檔案

擁有者以各 `freedom.module.json` 的 `owned_paths` 解析（`packages/contribution-tools/context.mjs` 的 `owns`）。

| 檔案 | Descriptor 擁有者 | Job | 改動 |
| --- | --- | --- | --- |
| `apps/platform-api/src/app.ts`、`runtime.ts`、`server.ts`、`worker.ts` | application-composition、work | A | `supplierConsoleEnabled` 選項與環境變數 |
| `apps/platform-api/src/platform-app.ts` | work | A | `site` 欄位；在 launchpad 區塊內依旗標掛新路由 |
| `apps/portal-web/src/modules/Community.tsx` | community | A | `SiteConfig` 加 `supplier_console_enabled` |
| `tests/e2e/member-feature-fixture.ts`、`scripts/e2e-server.ts` | e2e-harness | A | `Features` 與 E2E server 加旗標 |
| `modules/guild-workspace/generate-contracts.ts` | guild-workspace | WP-01 | 新 bundle（隨契約提交） |
| `tests/runtime/guild-launchpad-contracts.test.ts` | guild-workspace | A | 新 schema 正反例 |
| `modules/agent-commerce/hosted/distribution.ts` | agent-commerce、hosted-distribution | A | 抽出 `supplyOfferTerms` |
| `modules/agent-commerce/hosted/supply-catalog.ts` | agent-commerce | A | `updateSupplyProfile` |
| `modules/agent-commerce/hosted/photo-{projection,read,commands}.ts`、`publish.ts`、`apps/platform-api/src/routes/hosted-store-media.ts` | agent-commerce | B | `retailOnly`（新版開啟時才放寬） |
| `tests/helpers/hosted-store-photo.ts` | agent-commerce | B | 測試 app 可帶 runtime 選項 |
| `apps/portal-web/src/modules/HostedStore.tsx` | agent-commerce | C | 路由與回退 |
| `apps/portal-web/src/App.tsx` | application-composition、work | C | h1、頁面工具的 `pageId`、離開檢查帶目的地 |
| `apps/portal-web/src/Navigation.tsx` | application-composition | C | 營運中心子頁仍標示供貨商品庫 |
| `apps/portal-web/src/interface-messages.ts`、`page-help.ts` | application-composition | C | 頁名（五種語言）與 `supplier-console` 說明 |
| `apps/portal-web/src/modules/newcomer-guides/page-support.ts`、`ai-sister-pages.ts` | newcomer-guides | C | `supplier-console` 登錄為停用（同 `stores`） |
| `apps/portal-web/src/modules/HostedStorePhoto.tsx` | agent-commerce | C | `product` 參數只取 ID、名稱與版本 |
| `modules/agent-commerce/hosted-ui/ConsoleShell.{tsx,css}`（新檔） | agent-commerce | Claude | 營運中心與賣家後台共用的側欄殼層 |
| `modules/development/pages.ts` | development | C | `supplier-console` 頁面 |
| `tests/e2e/hosted-store-photo.spec.ts` | agent-commerce | D3 | 純供貨照片案例 |
| `docs/platform-plan/execution/spec-index.md` | 無 | Claude | 一行索引 |

新檔案全部列入 `supplier-console` descriptor（SC-SPEC-05 §5），避免成為 `selectImpact` 的未知路徑。

## 4. 依賴順序

```
WP-00 → WP-01（含契約）─┬→ A ─┐
                        ├→ B ─┼→ Claude 整合 → D1～D5 → WP-06（S1 證據）→ Ted 決定 PR／合併 → WP-07
                        └→ C ─┘
S1 合併 → S2 → S3（D-05、D-14 已核准）
S3 → D-11 素材進公開店面（先通知 Commerce）
```

只有一件事會擋路：合併、部署、開旗標與試用都等 Ted（開 PR 已依 D-12 核准）。S2、S3 可以先接在前一批的分支上開發，前一批合併後再各自開 PR。其餘依上圖往下做。

## 5. 決策

「採用」表示依建議直接進行（屬工程預設，沒有改變產品承諾）；「需 Ted」表示會影響成本、對外行為或權限，要 Ted 決定；「Ted 核准」表示 Ted 已同意建議。

| 編號 | 決策 | 建議 | 狀態 | 只影響 |
| --- | --- | --- | --- | --- |
| D-01 | 路由放哪裡 | `#stores/<t>/<i>/supply/...`，不新增全站分頁 | 採用 | WP-02 |
| D-02 | 新版開關 | `FREEDOM_SUPPLIER_CONSOLE_ENABLED`，預設關，需 launchpad 同時開 | 採用 | WP-02、03、06、07 |
| D-03 | 程式位置 | `modules/agent-commerce/supplier-console/`＋nested descriptor `supplier-console` | 採用 | WP-02、03 |
| D-04 | 合作店家用什麼 ID | 賣家店面 shop ID（`commerce_selections.shop_id`），不用名稱或 tenant | 採用 | WP-03 |
| D-05 | 素材用哪種媒體用途 | 新用途 `storefront.supply-material`，只收靜態圖片並沿用商品照片處理器；文案存文字；PDF／SVG 不收；影片見 D-14 | Ted 核准（2026-10-15） | WP-05 |
| D-06 | 草稿存哪裡 | 只在記憶體；未確認操作在同一會員重新登入後恢復，不跨重新整理 | 採用 | WP-02 |
| D-07 | 事業資料的修改範圍 | 只限純供貨事業；已開零售的在商店資料頁修改 | 採用 | WP-03、05 |
| D-08 | 純供貨商品照片的讀取權限 | 與零售商品照片相同（`store:read`，只回 ID、版本與照片 metadata） | 採用 | WP-03、04 |
| D-09 | 離開檢查 | App 的檢查接收目的地 hash，營運中心內換頁不打斷 | 採用 | WP-02 |
| D-10 | 頁面工具與新手引導 | 頁面工具用 `supplier-console`；引導沿用 `stores` 的停用 | 採用 | WP-02 |
| D-11 | 合作店家如何在公開店面使用素材 | 選「用於公開店面」時複製成賣家 tenant 的 Asset（佔賣家容量）；發布只引用複本 | Ted 已核准 D-11（2026-10-15）；本機 job-d11 候選，未合併／未部署；選用時複製的時機尚待 Ted 確認；瀏覽器 SC-E2E-72～75（本機） | WP-05 |
| D-12 | PR 怎麼包 | 文件＋S1 一支 PR，一次完整 CI、同一候選的證據 | Ted 核准（2026-10-15） | WP-06、07 |
| D-13 | 正式環境怎麼開 | 沿用 host 設定一次開，不做逐事業灰度 | Ted 核准（2026-10-15） | WP-07 |
| D-14 | 素材影片 | 供應商自己壓縮後上傳：MP4 或 WebM，最多 20 MiB；平台只檢查格式與大小，不轉檔，也不在瀏覽器壓縮。另立用途 `storefront.supply-material-video`，存放與播放沿用活動影片。Cloudflare Media Transformations 是之後要由平台產生縮圖或較小版本時的做法（SC-SPEC-04 §4） | Ted 核准（2026-10-15） | WP-05 |

計畫 16.2 已列的預設（沿用品牌與 token、對外名稱「供應商營運中心」、商品容量 200、供貨價可見範圍沿用現有角色、素材預設只給明確授權的合作方、撤回後禁止新取用但保留歷史、R2 交易責任另定）全部照建議採用，不影響本輪工作。

## 6. 成本與資源

- 不新增付費服務、第二套資料庫、常駐服務或追蹤 SaaS。
- 每個候選一次完整 CI；本機驗證用拋棄式 PostgreSQL（`postgres:18-alpine`，tmpfs），不碰開發資料庫 54339。
- 各 job 的實際投入與返工原因記在 [sources.md](sources.md) 的方法表。
