# 第一條供貨旅程（S1）與測試計畫

## 範圍

R1 核心路徑：供應商從公會進入自己的事業 → 建立商品與素材 → 設定並公開供貨條件 → 處理賣家的選品與售價申請 → 查看相應預留和庫存影響 → 處理取消／到期後的狀態 → 重新登入繼續管理。整條路在新版內完成，不回舊頁、不靠 DB 或手動 API。

S1 的「素材」是商品照片（含純供貨商品）。給合作店家取用的合作素材是 S3（SC-SPEC-04 §4），S1 不出現在導覽，也不放「即將推出」。

## 角色（全部是合成帳號與合成資料）

| 代號 | 身分 | 說明 |
| --- | --- | --- |
| A | 供應商，純供貨事業的 owner | 主角 |
| A2 | A 事業的 viewer（只有 `store:read`） | 權限反例 |
| B | 賣家，已開零售店 | 選品、售價、發布 |
| C | 另一間賣家，店名與 B 相同 | AT-16 |
| 買家 | 未登入的訪客 | 在 B 的店預留 |

## 旅程步驟

| 步 | 誰 | 畫面 | API | 預期 | 驗收 |
| --- | --- | --- | --- | --- | --- |
| 1 | A | 公會區塊「開始供貨設定」→ `#stores/<t>/<i>/supply` | `GET R/supply-profile` 回 `setup_state=setup_required` → `POST R/supply-profile` | 只顯示設定表單，其餘導覽停用並說明；建立後進入概覽；沒有要求零售網址 | AT-01 |
| 2 | A | 概覽 | `GET R/supplier-console/overview` | 四項指標為 ready 的 0、待辦為空、第一步「新增商品」可按 | AT-39 |
| 3 | A | `…/supply/products/new` | `POST R/supply-products` | 進入商品詳情；所有欄位讀回相同；金額標示「供貨單價」 | AT-05 |
| 4 | A | 商品詳情「照片」 | 照片命令（純供貨商品） | 預覽、上傳、讀回；公開頁不出現 | AT-11 |
| 5 | A | 商品詳情「供貨條件」→「供貨版本」 | `PATCH …/supply-terms`、`POST …/supply-offer` | 公開後概覽「公開供貨商品」＝1 | AT-05 |
| 6 | B | 自己商店的「供貨合作」（既有） | 既有 distribution 命令 | 看到 A 的版本並送出售價 | AT-12 |
| 7 | A | 概覽待辦 → 審核頁 `…/supply/terms/<selection_id>` | `POST …/supply-requests/:id/decision` | 看到 B 的名稱、售價、凍結條件、價差（標明不是佣金或利潤）；同意後 B 可售 | AT-12、31 |
| 8 | B／A | B 改價；A 改條件 | 既有命令 | B 改價後回到待確認；A 改條件後商品標「需更新版本」，影響預覽列出 B；重新公開後 B 需重新申請 | AT-13、15 |
| 9 | A | 審核頁 | decision `declined`／`revoked` | 不同意與撤回同意都有確認，歷史保留 | AT-14 |
| 10 | C | 選同一商品 | 既有命令 | A 的合作店家有兩列（同名、不同 ID） | AT-16 |
| 11 | A | 設定與資料 → 新預留 | `PATCH R/reservation-setting` | owner 可開；A2 看到唯讀說明 | AT-17、33 |
| 12 | 買家 | B 的公開店面 | 既有預留流程 | 預留成功 | — |
| 13 | A | 預留與訂單；商品清單 | `GET R/supply-reservations`、`GET R/supplier-console/products` | 只看到自己的行項；該商品已預留增加、可用減少；頁首有法律語意說明 | AT-22、31 |
| 14 | B／系統 | 取消或到期 | 既有 | A 的行項變成已取消／已到期，庫存只釋放一次 | AT-19、20 |
| 15 | A | 登出 → 登入 → 原書籤 `…/supply/products?state=offered` | — | 回到同一事業、同一篩選；資料與 ID 不變 | AT-02、42 |

## 不順利時（J06）

| 情況 | 預期 | 驗收 |
| --- | --- | --- |
| 新增商品送出後回應遺失 | 鎖定為「尚未確認」；重試用同一 key 與內容；最後只有一件商品 | AT-06 |
| 兩個分頁改同一商品 | 後者 412，草稿保留並列出最新值；選「以最新版本重新套用」才送出新操作 | AT-07 |
| 庫存改到低於已預留 | 409，輸入保留並顯示目前已預留量 | AT-08 |
| 未確認時點全站導覽 | 擋下並說明；拒絕後留在原頁、原 hash | AT-36 |
| A 未確認時登出、B 登入 | B 看不到 A 的資料或操作；晚到的讀取被丟棄 | AT-34 |
| 照片讀檔晚到後換人登入 | 舊檔不填入新身分、不送上傳（沿用 `HostedStorePhoto` 的晚到保護；自動測試 not_run，見 SC-SPEC-05） | AT-35 |
| 概覽讀取失敗 | 顯示無法取得與重試，不顯示 0 | AT-29 |
| A2 被移除權限後送出 | 403，停用寫入並說明；已保存的資料不變 | AT-37 |

## 測試計畫

| 範圍 | 檔案 | 層級 |
| --- | --- | --- |
| 新讀取、旗標、權限、計數定義、同名店、到期邊界 | `tests/runtime/supplier-console.test.ts` | 隔離 PostgreSQL／HTTP |
| `PATCH supply-profile`、純供貨照片 | `tests/runtime/supplier-console-writes.test.ts` | 隔離 PostgreSQL／HTTP |
| 路由、attempt、草稿、412、離開判斷 | `tests/runtime/supplier-console-state.test.ts` | 前端狀態邏輯 |
| 新 schema 正反例 | `tests/runtime/guild-launchpad-contracts.test.ts` | 契約 |
| 步驟 1～15 連續一條、舊書籤、新版關閉時回退 | `tests/e2e/supplier-console.spec.ts` | 整合瀏覽器 |
| 步驟 8～11 的分支（改價、改條件、不同意／撤回、同名店、唯讀成員） | `tests/e2e/supplier-console-cooperation.spec.ts` | 整合瀏覽器 |
| J06 | `tests/e2e/supplier-console-recovery.spec.ts` | 整合瀏覽器 |
| 事業切換、200 件商品的清單與返回位置、鍵盤操作 | `tests/e2e/supplier-console-navigation.spec.ts` | 整合瀏覽器 |
| 核心頁的寬度與外觀 | `tests/e2e/supplier-console-visual.spec.ts` | 整合瀏覽器＋截圖 |
| 步驟 4 的真實上傳 | `tests/e2e/hosted-store-photo.spec.ts`（照片 pass） | 整合瀏覽器 |
| 共用庫存 6＋5、取消、到期、撤回後歷史 | 既有 `tests/runtime/hosted-shared-orders.test.ts` | 隔離 PostgreSQL／HTTP |
| 新版關閉時舊頁不變 | 既有 hosted 系列測試（SC-SPEC-05 §2） | 全部層級 |
| 視覺 | SC-SPEC-01「視覺驗收」的寬度與主題，截圖存 `test-results/` | 整合瀏覽器 |

## 驗收狀態

全部 `not_run`。結果要寫 commit SHA、環境、指令與輸出位置；取消或略過不算通過。

| 範圍 | 案例 |
| --- | --- |
| S1 | AT-01～22、29～31、33～37、39～42、44、46 |
| S3 | AT-23～28、32、43 |
| 真人與發布（WP-07） | AT-45、47、48 |

## S1 完成判準

1. 步驟 1～15 與 J06 都在新版內完成，沒有任何一步需要舊頁、DB 或手動 API。
2. 上表 S1 案例在同一個 commit 通過，並記下證據。
3. 新版關閉時既有測試不改也通過。
4. 核心頁面截圖已逐張檢查（溢出、遮擋、按鈕尺寸、焦點、空狀態、錯誤狀態）。
5. diff 不含 `/home/`、`/tmp/`、token、cookie 或客戶資料；inventory 已更新。

達成後由 Ted 決定是否開 PR（D-12）；部署、開旗標與試用依 SC-SPEC-06。
