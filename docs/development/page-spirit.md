# 當頁龍娘與 NPC 操作指引

26 個會員主頁各有一位固定龍娘。入口只載入當頁 96×104 portrait；開啟交談後，才載入該頁題庫、hero 與六個動作影格。角色插畫、六視圖與影格沿用原創 v2 WebP，沒有新增外部模型或業務 API。

## 對話與頁面範圍

每頁題庫包含審定答案與自然問法，合計 79 題、860 個題目名稱／別名。core 只去除固定的禮貌問句前後綴，最多 64 個候選、四層；剩餘完整問句須命中本頁唯一別名。未知、混合、跨頁、注入或超過 240 字的內容不猜答案，也不回顯原文。

71 題另有審定下一步。當頁 session 對「下一步呢」「再說一次」「我還是不懂」使用目前顯示的題目；按「上一句」後的追問不會偷用最新題目。API 的第三個 contextTopicId 明確對應這句，不接受他頁 topic。session 最多六輪，只存題目名稱或固定意圖；畫面最多保留六句審定回覆。沒有使用者氣泡、歷史逐字稿或私人資料摘要。

「上一句」「回到最新」僅移動顯示位置，「重新開始」清除當頁 session、前句、草稿與指引。手動收合可在同頁續談並保留未送出的 NPC 草稿；結束交談與自動關閉會清掉草稿，已讀的審定答案仍可在同頁再看。換頁、登出、身份或 scope 改變、disabled 都清除本頁記憶與晚到回呼。

## 找到實際操作位置

guide-data.ts 有 26 頁、45 組指引、48 步，來源與 selector 核對見 [文案與來源紀錄](../design/page-spirit-copy-review.md)。每步最多 23 字，對應既有按鈕、欄位或內容分區。使用者必須明確點擊定位按鈕；只 focus、scroll 與暫時高亮，不會代按原控制項、打開 tab／details、讀取表單 value、傳送草稿、改變資格或推定操作完成。

resolver 限定當前 main#main-content，拒絕 hidden、inert、aria-hidden、aria-busy、disabled 與 dialog 內目標。入口缺失或後來無法使用時，撤掉高亮與臨時 tabindex，保留原指令及「重找入口」；不會自動換到另一個人或控制項。重新定位須由使用者再按按鈕。

定位後 NPC 收成指引條。正在指向的單一欄位允許本人繼續輸入；其他表單、原 modal 與展開的 Game Console 仍會收起 NPC。指引 Esc 保留原欄位焦點與草稿；按結束指引則回到龍娘入口。暫存標記、臨時 tabindex、rAF 與原生 smooth 捲動都隨取消清理；停止捲動只使用當前座標，不回復舊頁座標。大型內容分區定位頂緣，小型操作位置避開頂欄、NPC 與 Console，校正最多 450 ms。

## 手機、輸入與偏好

手機預設使用完整 96×144 動態角色與當句並排、FAQ 跨整行，面板最多占可視高度 60%。低高度隱藏裝飾和偏好列，保留 44 px 關閉與送出。「看角色」可在有足夠空間時展開立繪；「收合交談」只留下小條。

逐字最多三秒，可立即顯示全文；螢幕閱讀器一次取得完整句，相同句重新選取也會公告。中文 IME 組字中的 Enter 不送出，Escape 不關閉交談。原頁面工具的 X 改為先 native dialog.close()，再由 onClose 卸載，X 與 Esc 都還原原按鈕焦點。

「靜態省電」「直接顯示全文」跨頁與重載保留，localStorage 固定 key freedom-page-spirit-ui-v1 只寫兩個布林值 energy／instantText，不含會員 ID、問題、回覆或私人草稿。封鎖或額滿儲存不影響使用。直接全文只停止打字，不會同時關掉角色動作；省電、reduced-motion、背景分頁及關閉會取消動態。招呼、FAQ 與道謝共用一組真實六 bitmap 影格，最多 1.5 秒回 hero，其他狀態靜態；不是六套獨立動畫。

素材維護紀錄見 [原創素材 manifest](../design/page-spirit-art-manifest.json) 與 [本機素材核對](../design/page-spirit-asset-validation.json)。hero／frame／view 均為 384×576，每位有六視角及六張招呼動作幀。人物 ROI 保留原始柔光，不宣稱完全去背。

## 實跑驗證

```sh
npm run typecheck
npm run build
npx tsx --test tests/runtime/page-spirit.test.ts
npx playwright test tests/e2e/page-spirit.spec.ts tests/e2e/page-tools.spec.ts
npm run verify:inventory
```

瀏覽器使用既有單 worker 隔離 schema、本機專用 PostgreSQL 與合成會員；不使用正式／staging 會員、第三方 OAuth、金流或外部聊天模型。普通會員實際走 25 個可見入口，公會管理頁的資料範圍由 unit 和來源核對涵蓋，不假造正式管理權限。

本輪 2026-10-03 最終實跑：TypeScript、正式 build、43／43 unit tests、14／14 瀏覽器案例（11 項 NPC＋3 項原頁面工具，52.3 秒）通過；快速開啟／Esc 關閉的焦點競態另連續三次通過。390×844、320×420／360 的實際截圖已看圖核對；輸入文字、讀屏、圖片、原控制項可點擊位置與 Console 都保留。45 組指引逐項核對來源，但沒有逐一實際操作全部 48 個目標；不存在或資格不可用的目標會明確提示並等待本人重找。先前 fe26d048 的 CI 已通過 914 runtime、399 E2E 與 Linux 37 個部署預檢；它們只屬先前版本，不當作這批 UX 修改的完成證明。正式站部署另需既有發布連線，本輪沒有變更帳號、資料庫、金流、DNS 或 Cloudflare 設定。
