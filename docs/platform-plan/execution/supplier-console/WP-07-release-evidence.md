# WP-07 發布證據：固定候選、合成驗收與回退清單

需求：SC-R36、R39、R40。驗收：AT-42～48（AT-45、47、48 要真人）。規則見 [SC-SPEC-06](SC-SPEC-06-release-rollback-pilot.md)。

這份文件只準備可審查的候選規則、合成驗收腳本與證據格式，**不**授權部署、開旗標、改正式資料、寄信或聯絡會員；每一步都由 Ted 決定。`FREEDOM_SUPPLIER_CONSOLE_ENABLED` 預設關閉。source 合併不代表下面任何一項驗收已完成。

## 1. 固定候選

- 候選是一個已合併的 main SHA；選定後不追新的 main。要納入新的合併，就重新選候選，並從第 3 步重跑。
- 同一個 SHA 的完整 CI 要通過；取消、略過或只跑部分都不算。
- 之後每一步的 receipt 都寫這個 SHA；staging 與 production 用同一個。

歷史快照（2026-10-16，非目前驗收）：

下表保存當時的候選、CI 與 migration 排程；不是目前可直接執行的發布指令。表內 S3／D-11 的預定編號也只屬於當時排程，新候選以實際合併的 migration 清單為準。

| 項目 | 狀態 |
| --- | --- |
| 候選 | main `682fe87c`：S1（#761）與 S2（#857，連同 #856）。Ted 在 16:38:58Z 同意上 staging，16:47:03Z 合併 #857，所以 staging 用合併後的 `682fe87c`，不是先前的 `a4ec6c3b` |
| schema | S1、S2 沒有 migration，staging 仍是 167。S3 帶 168，D-11 帶 169（先合併到 main 的保留編號） |
| 完整 CI | `682fe87c` 的三個 workflow 都通過：Verify local milestone（run [38934643725](https://github.com/FreeTWAI/freedom-platform/actions/runs/38934643725)）、Push on main（CodeQL，[38934643547](https://github.com/FreeTWAI/freedom-platform/actions/runs/38934643547)）、Directory runtime profile tests（[38934643979](https://github.com/FreeTWAI/freedom-platform/actions/runs/38934643979)） |
| 之後的 main | 當時 main 之後合併了 #858 等變更；當時規劃不追新的 main，production 經 Ted 同意後使用同一個 `682fe87c` |

## 2. 合成驗收腳本

工具是 `scripts/verify-cloud-candidate.ts` 的四個 supplier 階段，細節見 [工具說明](../../../../scripts/verify-cloud-candidate.md)。

2026-10-17 整合 main `1ae0d0a4` 後，工具新建合成店固定使用 `hosted-store@1.1.0`，依賴 `169_hosted_payment_core.sql` 提供的新 offering。上表 `682fe87c`／schema 167／1.0.0 的舊候選不適用此版工具，舊 staging 結果也不是此版工具的雲端證據；必須選含 migration 169 與 1.1.0 offering 的新候選，依固定 SHA 重新驗收。既有店不會由此工具自動升級。

已發布公開投影的證據還需要私有 handle 中的 publication revision 與 SKU；它們來自已登入賣家的成功發布回應與私人讀取。phase 層若遇到兩個公開 200 卻缺少這個 pin，會失敗而不聲稱覆蓋；兩個 404 仍只記未發布、未覆蓋。CLI 的 photo／reservations 寫入階段仍要求同次 journey 通過，單獨選 photo 即使提供舊 handle 也會 blocked；底層 phase 測試不代表已支援 CLI 重用寫入。

| 階段 | 對應 | 寫入 |
| --- | --- | --- |
| `supplier-journey` | J01（步驟 1～3、5）、J03（6～7，供應商與賣家兩個帳號）、J02（15，重新登入）、J06 的 API 案例（回應遺失後同 key 重送、412） | 新的合成供貨事業、商品、條件與公開版本；合成賣家店與選品；同意決定 |
| `supplier-photo` | 步驟 4：產生的 PNG 經既有商品照片協定上傳，私人 WebP 讀回並核對尺寸。這一階段不發布賣家店。兩個公開端點都 404 時記 `public_projection: not_covered_unpublished`、`public_projection_private: null`，只表示店尚未發布、公開隔離還沒被這一次讀取覆蓋，階段仍可因私人協定通過。兩個都 200 時，須先匹配 handle 中由已登入賣家發布回應與私人讀取確認的版本、SKU、預期店家及商品內容，再檢查私人資料隔離，才記 `public_projection_private: true`。已發布但沒有 publication pin 時，phase 會失敗；CLI 同次 journey 的依賴不變。其他狀態組合失敗 | 一張產生的照片 |
| `supplier-reservations` | J04 供應端（步驟 11～14）、J06 的 409。賣家店發布後必讀店面與媒體兩個公開端點，都要 200，才記 `public_projection_private: true`；handle 已有照片時另記 `public_photo_checked: true`。200 回應還須匹配已登入賣家確認的發布版本、店名、slug、TWD、目標 SKU 與商品名稱／說明／零售價，以及同版本媒體投影；空物件、空商品清單或錯誤版本不能當證據，合法空 `photos: []` 可通過。檢查拒絕所選商品的非 null 照片或 `read_path`、私人照片路徑、供應商商品 ID，以及任何 `cost_minor`；公開回應裡的 null 照片佔位不算外洩 | 開預留，買家預留 1 件後取消，再關回預留 |
| `supplier-recheck` | 回退演練（SC-SPEC-06 §3.6、§4）。關閉與再開都核對書籤上的實際數值，通過後才記 `bookmark_values_matched: true` | 只讀；用到的登入 session 結束時撤銷 |

前提：

- root 在候選環境先建立三個合成帳號：供應商（供貨公會 full 會員）、賣家（商業公會 full 會員）、買家（一般會員）。帳號檔 0600、`synthetic: true`，綁定候選 origin。自助註冊的帳號是見習會員，不能開店。
- email 不能用 `@example.invalid`：那是驗證測試帳號，不能預留或發布。
- 只在 staging 執行。目標是 `public` 時，四個階段都是 `not_run`，也不讀帳號檔。
- 每次執行都要 Ted 同意。每次旅程用新的 handle 路徑，放在 repo 以外；回退演練的複查沿用同一個 handle。

staging 的順序（每一步都等 Ted 同意）。`health.version` 預設比對執行 checkout 的 `package.json`，不同時用 `--expected-version` 指定候選的版本。

```sh
# 環境變數指向私人檔案：
#   FREEDOM_CANDIDATE_ACCESS_FILE、FREEDOM_CANDIDATE_SUPPLIER_ACCOUNT_FILE、FREEDOM_CANDIDATE_SELLER_ACCOUNT_FILE、
#   FREEDOM_CANDIDATE_BUYER_ACCOUNT_FILE、FREEDOM_CANDIDATE_SUPPLIER_HANDLE_FILE
# 1. 旗標開啟後：旅程、照片、預留，最後複查一次
npx tsx scripts/verify-cloud-candidate.ts execute --target staging --expected-release-sha <候選 SHA> \
  --phases supplier-journey,supplier-photo,supplier-reservations,supplier-recheck --expect-supplier-console on
# 2. operator 在同一個 release 關閉旗標後（不換 origin 與資料庫）：
#    舊讀取與 handle 同值，新營運中心路由 404。同一書籤打開舊供貨商品庫
#    （.hosted-supply-catalog）：標題是供貨事業名稱；商品卡 article.hosted-store-product
#    的商品名稱標題下，要有精確的「供貨單價 <TWD 金額>」、「庫存 <stock>」與商品說明。
#    不得出現「找不到這間商店」或「找不到這個供貨商品庫」。
#    通過後 bookmark 為 old_page，bookmark_values_matched 為 true。
npx tsx scripts/verify-cloud-candidate.ts execute --target staging --expected-release-sha <候選 SHA> \
  --phases supplier-recheck --expect-supplier-console off
# 3. 再開啟後：同一 ID 與同一數值。書籤是營運中心商品頁：標題「商品詳情：<名稱>」，
#    可見列同時有「庫存 <n>」與「可用 <n>」（都等於 handle 的庫存），
#    「儲存供貨條件」表單核對供貨單價、每件運費、出貨條件與退貨條件。
#    通過後 bookmark 為 console_page，bookmark_values_matched 為 true。
npx tsx scripts/verify-cloud-candidate.ts execute --target staging --expected-release-sha <候選 SHA> \
  --phases supplier-recheck --expect-supplier-console on
```

報告是 JSON，只有階段狀態、檢查與計數，不含帳號、ID、slug、run tag 或內容。ID 只寫在 handle 檔。`execute` 的結束碼：所選階段都通過且沒有 `restore_failed` 才是 0；任一階段 fail、blocked、not_run，或任一清理項是 `restore_failed`，都是 1；用法或憑證檔錯誤是 2。任一 `restore_failed` 都讓 `overall` 為 fail、`cloud_proof` 為 false。原本通過的階段在該階段清理之後改為 fail，原因 `cleanup_restore_failed`，並加上檢查 `cleanup_restored` 失敗；這包含最後一個供應商階段結束後的登出。已經失敗的階段保留原原因。`not_run` 與 `blocked` 保持原狀態，但整次執行仍失敗並以 1 結束。`cleanup.restore_failed` 與 `cleanup.required` 是兩個欄位。只有 `cleanup_required` 或 `residual_expected` 不會讓執行失敗，也不會單獨把 `cloud_proof` 改成 false。`cloud_proof` 為 true 還要同時是 `execute`、harness 為 `cloud_candidate`、`overall` 為 pass，且所選階段含有通過的 health（Worker runtime 與預期候選 SHA）。含有其他階段的網路執行會一併選上 health；第 2 節的指令帶有 `--expected-release-sha`。這些雲端指令都還沒執行，仍是 not_run。本機 harness（`local_harness`）的 `cloud_proof` 固定是 false，只證明工具本身。

合成資料留在 staging。工具不發刪除請求。事業、商品、條件、已發布供貨版本、賣家店與選品在報告裡是 `cleanup_required`，由 root 停用；journal、決定紀錄、留下的照片版本與已取消的預留是 `residual_expected`，不刪除。還沒取消的預留是 `cleanup_required`。設定或 session 還原失敗是 `restore_failed`。

旅程在新鮮登入讀取之後才寫 handle。在那之前失敗（含私人檔寫入失敗）就沒有 handle，清理說明也不依賴 handle 檔。說明使用帳號檔裡的專用帳號 label（label 不是秘密，報告不寫 ID）。root 用同一組私人帳號檔解析 label，列出該帳號擁有、且建立時間不早於這份報告 `started_at` 的 tenant：供貨名稱以 `WP07 合成供貨` 開頭，賣家名稱以 `WP07 合成選物` 開頭。停用這個時間窗裡的每一個 tenant，包含只建到一半的；這些專用帳號沒有其他資料。若預留需要清理，再用買家 label 列出 `started_at` 之後、落在那些賣家 tenant 裡的預留，依既有授權程序取消，然後停用供貨與賣家 tenant。handle 若存在，只額外列出精確 ID。帳號檔與脫敏報告保留到這次對帳完成。用過的 session 在最後一個供應商階段結束時撤銷。

## 3. 回退證據清單

每一步記：候選 SHA、環境、UTC 時間、執行者、指令、報告位置與 overall。任何一步失敗就停在那一步，不跳過。

| # | 步驟（SC-SPEC-06 §3） | 證據 | 現況 |
| --- | --- | --- | --- |
| 1 | 確認沒有待部署的必要安全修補 | 檢查紀錄 | not_run |
| 2 | 選定候選 SHA | 本文件 §1 與 Ted 的決定 | `682fe87c`（2026-10-16，Ted 同意上 staging） |
| 3 | 同一 SHA 的完整 CI | Verify run 連結與結論 | `682fe87c` 已通過（§1） |
| 4 | release wrapper：備份 → migration → grants → staging，旗標關閉；舊頁與既有行為不變 | 部署 receipt、備份 unit、grants 檢查、登入後的 staging 檢查 | 2026-10-16 完成：部署前備份通過（17:47Z）；這版沒有 migration，grants 不變；用 operator 的 release kit（不是 `release.sh`）以旗標關閉部署 staging（Worker 版本 `fd16b51f`）；18:00Z 驗收通過（health、protocol、assets、匿名、登入 session、瀏覽器、登出、build 檔案比對；營運中心 API 未掛載）。receipt 由 operator 保存，不進 repo |
| 5 | staging 開旗標，跑合成旅程 | 第 2 節第 1 步的報告 | 一部分：旗標開啟部署（Worker 版本 `e474fb2e`），18:01Z 同一組驗收通過（API 已掛載），部署後備份通過（18:02Z）。第 2 節的合成供應商旅程還沒跑（not_run，要 Ted 同意與三個合成帳號） |
| 6a | 關旗標 | operator receipt；第 2 步的報告（舊讀取同值、新路由 404、書籤核對舊頁的事業名稱、供貨單價、庫存與說明） | not_run |
| 6b | 再開旗標 | 第 3 步的報告（同 ID、同值；書籤核對商品詳情的庫存、可用量、供貨單價、運費與條款） | not_run |
| 7 | production 部署同一候選，旗標先關閉；Ted 決定開啟時間，開啟後觀察錯誤率與回報 | 部署 receipt、觀察紀錄 | not_run |

SC-SPEC-06 §4 的其他情況：

| 情況 | 證據 | 現況 |
| --- | --- | --- |
| 送出中或未確認的操作 | 本機 E2E 的 J06（`supplier-console-recovery.spec.ts`） | 本機有自動測試；staging not_run |
| 照片上傳中途關閉 | intent 自然到期、finalize 冪等（runtime 測試） | staging not_run |
| 程式回退到 S1 之前 | S1 沒有 schema 變更 | 沒有演練（not_run） |
| S3 回退：先關素材上傳再退 runtime | S3 尚未合併 | not_run |

## 4. 尚未執行（not_run）

| 項目 | 前提 | 誰決定 |
| --- | --- | --- |
| staging 開旗標後跑 J01～J04、J06 合成旅程（旗標已開，見 §3 第 5 步） | root 建好三個合成帳號 | Ted |
| 照片在真 R2 上傳與讀取（AT-11 的雲端部分） | staging 照片上傳已開 | Ted |
| 回退演練：關閉後舊讀取同值、新路由 404、書籤核對舊頁實際數值；再開後核對營運中心實際數值 | 上一項通過 | Ted |
| production 部署與開啟 | staging 全部通過 | Ted |
| J05 與素材的備份／還原（AT-43） | S3、D-11 合併並部署 | Ted |
| 經同意的試用：兩位供應商、兩位賣家（AT-47），兩位非核心公會作者（AT-45） | Ted 邀請與安排；Agent 不聯絡會員 | Ted |
| R1 結案與舊頁退場（AT-48） | SC-SPEC-06 §6 的條件全部成立 | Ted |
