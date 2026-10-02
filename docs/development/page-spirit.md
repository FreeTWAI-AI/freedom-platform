# 當頁龍娘與 NPC 台詞板

會員完成主要公會加入後，26 個會員分頁各有一位固定龍娘。入口只載入目前角色的 96×104 portrait；本人開啟交談後，才載入當頁 JSON、hero 與六個動作影格。每份知識包只含當頁審定 FAQ，沒有全站搜尋、模型推論或業務 API。

`apps/portal-web/src/modules/page-spirit/core.ts` 提供純函式回覆與當頁 session。題目名稱和完整別名只能回該頁固定答案；他頁 topic ID、他頁角色姓名、未知或混合問題回當頁範圍提醒。要求代付款、傳訊或刪除時，只解釋原按鈕。session 最多六輪，只存審定題目名稱或固定意圖標籤，不存未辨識輸入原文。

`PageSpirit.tsx` 掛載於會員 Workspace，以會員 ID、分頁與目前 URL 範圍重新建立 session。切頁、登出或 scope 改變會清除問題、台詞、待載入知識包與動畫回呼。相同頁面手動結束交談可再開啟目前台詞；這不會把台詞帶到其他頁面。

台詞板只顯示目前一句，沒有使用者氣泡或歷史列表。逐字最多三秒，「顯示全文」可立即完成；螢幕閱讀器一次取得完整句。招呼、FAQ 說明及道謝共用一組真實六 bitmap 影格，最多播放 1.5 秒後回 hero；其他狀態使用靜態圖。沒有整張圖片的 CSS 晃動，也不宣稱每種狀態都有獨立動作素材。

「顯示全文」完成後將焦點移至結束交談按鈕，避免手機自動叫出鍵盤。原始 dialog 的 `open` 增減會重新檢查抑制狀態，不靠關閉後的焦點事件才恢復 NPC。

原有 dialog、世界聊天抽屜、展開的 Game Console 或外部表單聚焦時，NPC 關閉並隱藏入口。元件只檢查焦點、可見性及版面，不讀取表單值或私訊草稿。省電、減少動態、背景分頁及關閉都會取消打字與影格，過期載入或回呼不能改寫新頁面。

資產位於 `/art/page-spirit/v2-20261002/{pageId}/`。hero、frame 與 view 均為 384×576；每位有六視角及六個真實抬手／揮掌／眨眼影格。來源生成圖和維護紀錄見 `docs/design/page-spirit-art-manifest.json`。v2 採人物 body ROI framing，保留區內原始人物與柔光，省略框外照明；不是完全去背。角色插畫不是會員身分、進度、付款或業務成功的證據。

## 驗證

純函式測試無需 PostgreSQL：

```sh
npx tsx --test tests/runtime/page-spirit.test.ts
npm run typecheck
```

本輪這兩個入口已執行：32 個 runtime tests 通過，涵蓋 26 頁、79 題與 790 個題目名稱／別名；TypeScript 檢查通過。

介面測試使用 `tests/e2e/fixtures.ts` 的單 worker 隔離 schema、合成註冊會員及既有 `quickJoin`／`navigate` helper。先完成 build，再由維護者提供本機隔離 PostgreSQL 的 `TEST_DATABASE_URL` 後執行：

```sh
npm run build
npx playwright test tests/e2e/page-spirit.spec.ts
```

五個案例檢查懶載、當頁 FAQ、舊頁延遲知識包、raw input 不回顯、真實六影格、取消、省電、既有 dialog／聊天草稿，以及 320／390 px 控制項。第五案透過實際設定選單切換明亮、夜航與敘生，填入 NPC 輸入欄位後，檢查文字與背景對比；輸入框及角色六視圖連結的比值均須至少 4.5，輸入框並繼承 dark color-scheme。普通合成會員只走自己可見的 25 個導覽入口；公會管理知識包由 runtime 契約測試涵蓋，不在 UI 測試假造管理權限。

維護者已於最終 build 後，使用本機隔離 PostgreSQL 與真實 Chromium 重跑：5／5 E2E 通過，耗時 29.4 秒。完整 runtime suite 914／914 通過，耗時 619.5 秒；Worker 測試 20／20 通過。三個 Worker 環境與管理同步、維護者服務的 dry-run 由維護者完成，dry-run 不代表公開部署。

另由維護者執行 Cloudflare 離線預檢測試：Windows 上 37 項中 34 項通過，3 項受 POSIX `0600` 私有檔權限判定限制而失敗。本輪沒有修改相關 deploy 程式或放寬 guard；Linux CI 仍使用既有預檢工作。這組預檢不能記為全數通過。

新增主題案例透過實際設定選單切換明亮、夜航與敘生，再輸入文字並核對瀏覽器計算後的顏色；NPC 輸入欄及六視圖連結在三款主題的對比皆達 4.5：1。桌機與手機截圖已由維護者看圖確認，沒有輸入欄白底白字或深底暗色連結。

Cloudflare 離線預檢本機為 34／37 通過；三項失敗涉及 Windows 無法表達 POSIX 0600 檔案權限。相關憑證檢查與預檢程式未修改，保留 Linux CI 驗證，未放寬權限檢查。正式部署尚未執行，本輪連線不含 freetwai.com 的既有發布權限。

既有 PageTools 的 X 關閉以卸載 native dialog 結束，沒有明確還原 invoker 焦點。本輪先取得該行為 baseline，再確認 NPC 被抑制時不改變焦點、不搶焦點；沒有把這個既有問題稱為已修復。NPC 自身的 X／Esc 關閉仍嚴格檢查焦點返回 launcher。

桌機 1440 px 與手機 390／320 px 的 NPC 圖片由最後的影格案例寫入當次 Playwright output 目錄，檔名為 `page-spirit-{width}.png`。截圖用於檢視實際版面，視覺結論另以維護者看圖結果為準。

測試不使用正式／staging 會員、Provider OAuth 或金流，也不會在測試內 build、啟動外部聊天模型或公開部署。
