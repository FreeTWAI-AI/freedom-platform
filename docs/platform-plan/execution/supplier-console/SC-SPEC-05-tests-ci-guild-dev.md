# SC-SPEC-05 測試、效能、CI 與公會開發

需求：SC-R17（效能部分）、R25、R35、R37、R38。驗收：AT-18～22、45、46，以及其他案例的測試位置。

## 目的與非目標

- 說清楚每個驗收案例由哪一層測試、在哪個檔案、用什麼環境證明；沿用既有測試，只補真正缺的代表案例。
- 非目標：新的驗證平台、新的 mandatory pipeline、把 JSON 對照表變成 CI、為每個元件組合加全站 E2E、提高 timeout 或 retry。

## 1. 證據層級與實際做法

| 層級 | 本案做法 | 環境 | 不能證明 |
| --- | --- | --- | --- |
| 契約 | `npm run check:guild-launchpad-contracts`；`tests/runtime/guild-launchpad-contracts.test.ts` 加入新 schema 的正反例 | 無資料庫 | 實際資料與權限 |
| 前端狀態邏輯 | `tests/runtime/supplier-console-state.test.ts`：路由解析與正規化、attempt 生命週期、草稿與 412、離開判斷。寫法同 `hosted-store-photo-state.test.ts`（直接 import 純狀態模組） | 無資料庫 | 瀏覽器行為 |
| 隔離 PostgreSQL／HTTP | `tests/runtime/supplier-console.test.ts`（新讀取與旗標）、`tests/runtime/supplier-console-writes.test.ts`（`PATCH supply-profile`、純供貨照片，fake object store）：SC-SPEC-03 的反例 | 拋棄式資料庫（`TEST_DATABASE_URL`，資料庫名 `fp_…`），絕不連 54339 | 部署設定、真 R2 |
| 整合瀏覽器 | `tests/e2e/supplier-console.spec.ts`（J01、J02、J04 供應端連成一條，加舊書籤與新版關閉時回退）、`supplier-console-cooperation.spec.ts`（J03 供應端＋賣家端、唯讀成員）、`supplier-console-recovery.spec.ts`（J06）；每個案例以 `memberFeatures: {guildLaunchpadEnabled: true, hostedReservationsEnabled: true, supplierConsoleEnabled: true}` 開啟 | 本機 build 後、獨立 `FREEDOM_E2E_PORT`（不用 4310／4312） | 真人是否看得懂 |
| 真儲存／staging | 照片與（S3）素材在 R2 的寫入、讀取、備份與還原 | Ted 核准後由 release wrapper 操作 | 一般會員採用 |
| 真人與作者 | SC-SPEC-06 的試用 | Ted 安排 | 負載與完整安全稽核 |

所有案例初始 `not_run`。每筆結果都要寫 commit SHA、環境、指令與結果；取消或略過不算通過。

## 2. 沿用的既有測試

新版關閉是預設值，以下測試**不改**，在新版關閉下照常通過，證明回退路徑仍然完整：

| 測試 | 保護什麼 |
| --- | --- |
| `tests/runtime/hosted-supply-catalog.test.ts`、`tests/e2e/hosted-supply-catalog.spec.ts` | 舊供貨商品庫、預留設定、未知結果恢復、草稿保護 |
| `tests/e2e/hosted-supply-terms.spec.ts` | 條件保存、回應遺失重試、舊分頁需重看版本 |
| `tests/runtime/hosted-distribution.test.ts`、`tests/e2e/hosted-distribution.spec.ts` | 精確版本同意、改價重新同意、撤回 |
| `tests/runtime/hosted-shared-orders.test.ts`、`tests/e2e/hosted-shared-orders.spec.ts` | 共用庫存與預留（見下） |
| `tests/runtime/hosted-store-photo*.test.ts`、`storefront-product-photo-*.test.ts`、`tests/e2e/hosted-store-photo.spec.ts` | 照片的上傳、CAS、未知結果與公開投影 |
| `tests/e2e/guild-launchpad*.spec.ts`、`guild-block-composition.spec.ts` | 公會入口與商品庫區塊 |

共用庫存的反例已經在 `hosted-shared-orders.test.ts`，營運中心不改這些命令，所以沿用、不重寫：

| 驗收 | 既有測試（`tests/runtime/hosted-shared-orders.test.ts`） |
| --- | --- |
| AT-18 跨店 6＋5／10 | `:81` two storefronts request 6 + 5 from one stock of 10 |
| AT-19 取消只釋放一次 | 同上（recovery and cancellation release only once） |
| AT-20 到期與取消競態 | `:176` C reclaims physically expired stock held by B |
| AT-21 停止供貨後的歷史 | `:107` withdrawal … committed history and release survive withdrawal and admission OFF |
| AT-22 只見自己的行項 | `:227` supplier cursors do not grant another party access |

營運中心只補畫面層：預留頁顯示的行項與 API 一致、法律語意說明存在、非 owner 看不到入口。

## 3. 新測試要涵蓋的案例

| 驗收 | 層級與位置 |
| --- | --- |
| AT-01、02、05、39 | E2E：純供應商從公會進入、建立商品庫、空狀態第一步可做、建立商品並保存所有欄位 |
| AT-03、34 | E2E：兩個事業切換；A 登出 B 登入時舊讀取晚到被丟棄 |
| AT-04、37 | HTTP：viewer／admin／他人 tenant；E2E：權限撤回後寫入停用 |
| AT-06、36 | 狀態邏輯＋E2E：送出後回應遺失，同一 key 重試只有一件商品；未確認時離開被擋 |
| AT-07 | E2E：兩個分頁改同一商品，後者 412，草稿保留並列出最新值 |
| AT-08 | HTTP＋E2E：庫存低於已預留量 409，輸入保留 |
| AT-09、10 | E2E：200 件商品的搜尋與篩選計數、從詳情返回的位置與焦點 |
| AT-11 | HTTP：未公開的新商品不出現在任何公開或合作投影 |
| AT-12～16 | HTTP：合作數分桶、`matches_current_terms`、同名店分開；E2E：審核頁同意／不同意／撤回同意 |
| AT-17 | 沿用既有預留設定 E2E（新版開啟時跑同樣流程於設定頁） |
| AT-29、30 | HTTP：概覽讀取失敗不回 0；數字與清單用同一定義；E2E：讀回失敗時標示未更新 |
| AT-31 | HTTP：所有金額單一幣別、`supply_price_minor` 命名；畫面文字檢查（不出現營收、佣金） |
| AT-33 | E2E：沒有 `manage` 的成員看到唯讀設定 |
| AT-40、41 | E2E 截圖與鍵盤操作（SC-SPEC-01 的視覺驗收） |
| AT-42 | E2E：舊書籤 `#stores/<t>/<i>/supply`、`…/supply-orders` 打開正確頁面 |
| AT-44 | E2E：同一資料在新版關閉時由舊頁正確顯示 |
| AT-23～28、32、43 | S3（SC-SPEC-04） |
| AT-35 | S1 的商品照片沿用 `HostedStorePhoto` 的晚到保護：會話世代與處理序號都相符、元件也仍掛載時，才把讀好的檔案放進預覽和待上傳內容。目前沒有不靠等待時間就能重現的自動測試，S1 記為 not_run。S3 素材沿用同一規則 |

新測試以前綴命名，從測試輸出可以直接對回這裡：

| 前綴 | 檔案 | 涵蓋 |
| --- | --- | --- |
| `SC-FLAG-01`～`06` | `tests/runtime/supplier-console.test.ts` | Node 與 Worker 的開關預設關、只接受精確的 true；Worker 啟動檢查拒絕拼錯與缺 launchpad；`site` 欄位需要兩個開關 |
| `SC-API-01`～`10` | 同上 | 新版關閉時新路由 404、舊讀取不變（AT-44）；未設定回 409；空商品庫是 ready 的 0（AT-39）；旅程計數、目前條件與同名店（AT-05、12、13、15、16、30、31）；預留只給 owner、讀取不結算（AT-22）；能力、tenant、session 與私人快取（AT-04、37）；詳情不透露他人資料；`PATCH supply-profile` 的版本檢查、權限與凍結名稱；完整清單與待辦上限；合作狀態分桶與共用容量（AT-14、30） |
| `SC-PHOTO-01`～`06` | `tests/runtime/supplier-console-writes.test.ts` | 新版關閉時純供貨照片 404 且不寫入；開啟時清單、上傳、讀取、重播、412、移除；viewer 只見 metadata（AT-04、37）；公開與合作投影不含純供貨商品（AT-11）；容量計算與零售照片相同；關閉後照片保留（AT-44） |
| `SC-UI-nn` | `tests/runtime/supplier-console-state.test.ts` | 路由、導覽、操作結果分類、未確認操作登錄、草稿、離開判斷、篩選定義與文案 |

測試名稱裡的 AT 編號只表示對應關係；驗收狀態仍依 §1，在同一個候選 commit 記下證據後才改。

純供貨照片的瀏覽器案例放進既有的照片 pass（`FREEDOM_E2E_STORE_PHOTO_FIXTURE=1`，`scripts/run-e2e.mjs`），加在 `tests/e2e/hosted-store-photo.spec.ts`，不新增 pass、不改 runner。

## 4. 效能

計畫 9.5 的目標（API p95 < 1 秒、核心頁可操作 p95 < 3 秒）是待校準的工程目標，不是宣稱。量法：

- 合成資料：一個供應商 200 件商品；超過 200 間合作店家（測截斷）；1,000 筆歷史預留。由 runtime 測試的 fixture 寫入拋棄式資料庫，不碰正式資料。
- 量 `overview`、`products`、`partners`、`products/:id` 各 30 次，記錄 runner、CPU、資料量與 p50／p95；附上 `EXPLAIN (ANALYZE, BUFFERS)`。
- 需要索引時先寫明瓶頸；索引要 migration，屬於 S1 範圍外的決定，不在 S1 默默加。
- 營運中心以 lazy chunk 載入；初始 JS closure gzip 增加不超過 1%（同 `docs/development/social-platform-performance-2026-10-07.md` 的量尺）。
- 單次本機樣本只記為樣本，不寫成正式 p95。

## 5. CI 與本機驗證

### 這個工作一定是完整 CI

`scripts/ci/select-affected-jobs.mjs:81` 的 `FULL_SCOPE` 包含 `docs/platform-plan/`、`contracts/`、`migrations/`、`tests/runtime/`，而且 descriptor 變更也算。本案每個批次都會碰到其中之一，所以一律跑完整 CI，不把它包裝成前端小改，也不為了縮短 CI 去改選擇器。

### 模組與擁有者

新增 nested descriptor `modules/agent-commerce/supplier-console/freedom.module.json`（module `supplier-console`，依賴 `agent-commerce`、`hosted-distribution`，tests `runtime.full`、`e2e.harness`），擁有：

- `modules/agent-commerce/supplier-console/**`（畫面元件與純狀態模組）
- `apps/platform-api/src/routes/hosted-supplier-console.ts`
- `contracts/guild-launchpad/v1/supplier-console.ts` 與 `.schema.json`
- `tests/runtime/supplier-console.test.ts`、`tests/runtime/supplier-console-writes.test.ts`、`tests/runtime/supplier-console-state.test.ts`、`tests/e2e/supplier-console.spec.ts`、`tests/e2e/supplier-console-cooperation.spec.ts`、`tests/e2e/supplier-console-recovery.spec.ts`

`context.mjs` 的 `selectImpact` 把沒有擁有者的路徑當成未知，會選到全部模組；每次新增檔案後都要確認 `unknown_paths` 為空。會改到的既有共用檔案與其擁有者列在 [work-plan.md](work-plan.md#3-共用檔案)。

### 本機驗證順序（每個候選）

1. `node scripts/freedom.mjs prepare --base-ref <baseline SHA> --paths <逗號分隔的變更路徑>`，讀完 context。
2. `npm run typecheck`、`npm run check:guild-launchpad-contracts`。
3. `npm run contracts:build`、`npm run build`（瀏覽器與依賴 dist 的 runtime 測試都要先 build）。
4. 目標 runtime 測試，再跑 `npm test` 全套；都用拋棄式資料庫。
5. 目標 E2E（`npm run test:e2e -- tests/e2e/supplier-console.spec.ts …`），再跑受影響的既有 spec。
6. `python3 scripts/update-inventory.py`、`npm run verify:inventory`。
7. 檢查 diff 不含 `/home/`、`/tmp/`、token、cookie 或客戶資料；截圖只存 `test-results/`。

本機結果不是可信 CI 證據；它只決定能不能交給 CI。

## 6. 公會開發（SC-R35、AT-45）

- 公會入口是 `modules/guild-supply/CatalogBlock.tsx`（module `guild-supply`），它的連結 `#stores/<t>/<i>/supply` 就是營運中心入口。R1 不改這個區塊，也不改 `packages/contribution-tools/guild-presentation-profile.mjs` 的凍結 import。
- 公會作者的流程不變：`npm run guild:preview`（`127.0.0.1:4487`，合成資料）、`npm run guild:check`、`npm run guild:test -- modules/guild-supply`。只改那一個 tsx 時 CI 走公會呈現路徑，不是完整 CI（`docs/development/limited-trial-kit.md` 的作者任務卡）。
- 作者可以做的有用擴充：區塊的文案與版面（例如把入口說明改成「進入營運中心」）。不能做的：讀營運中心資料、加 API 呼叫、改中央殼層。
- G-14（公會區塊顯示本人待辦摘要）需要新的讀取與凍結 import 變更，屬核心工作（S2），不交給作者。
- AT-45 需要兩位非核心作者實際完成，由 Ted 安排；Agent 不聯絡會員。

## 7. 未決與影響

| 事項 | 建議 | 只影響 |
| --- | --- | --- |
| 效能目標是否足夠 | 先量 S1 的實際數字再校準 | WP-06 |
| S1 證據需要真 R2 嗎 | 純供貨照片沿用既有用途，S1 只需 fake store＋既有原生測試；真 R2 留到 staging（WP-07） | WP-06、WP-07 |
