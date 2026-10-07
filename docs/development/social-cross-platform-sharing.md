# Social Post：選平台與逐站分享

需求來源：2026-10-07，Hao 要求會員可自行選 X、Instagram、Facebook、Threads，以點選 Logo 亮燈的方式操作，不串社群發文 API；有帳號限制風險時先提醒，讓會員自行開啟。

## 會員操作

1. 在既有「建立貼文」編輯內容，按「Social Post 分享」。首次出現帳號風險說明，按「了解並開啟」才顯示選擇器；「先不要」返回原草稿。
2. 點平台 Logo。選中即亮燈並顯示勾選、已選數量；再次點擊取消。X、IG、FB、Threads 可複選，鍵盤及讀屏可辨識完整名稱與選取狀態。
3. 可加入最多 4 張 JPG／PNG（各 10 MiB），或 1 部 MP4（50 MiB）。照片與影片分開準備；Instagram 必須有素材。這是本工具的選取上限，不保證各平台接受所有尺寸、比例、長度或編碼。
4. 「準備分享」固定當次文案、原始素材與目的地，帶到第一個步驟。複製文案、下載素材，或在支援的裝置上叫出系統素材分享；最後由會員在各平台檢查內容並確認發布。
5. 返回後點「我已完成發布」，焦點移到下一個未確認平台。進度明示「本人確認」，不是社群平台的成功回報。
6. 原稿、平台或素材有變更時，既有步驟仍使用準備時的版本並顯示差異提醒。只有「使用目前內容重新準備」才建立新一輪進度；不修改已在外部發布的貼文。

開啟此面板時，工坊原生貼文按鈕標示「發布到工坊」，以辨識目的地。文案優化仍沿用[本人模型與草稿流程](social-post-optimization.md)。

## 平台能力與公開來源

截至 2026-10-07，採用以下交接方式：

| 平台 | 本版交接 | 會員仍需完成 |
| --- | --- | --- |
| X | 官方 `twitter.com/intent/tweet`，以 `text` 帶入文案 | 在 X 加入素材、檢查字數與格式、按發布 |
| Threads | 官方 `threads.com/intent/post`，以 `text` 帶入文案 | 在 Threads 加素材、檢查內容、按發布 |
| Instagram | 複製文案、下載原始素材、開啟官方網站；裝置支援時可選系統素材分享 | 選 App／素材、貼上文案、確認發布 |
| Facebook | 複製文案、下載原始素材、開啟官方網站；裝置支援時可選系統素材分享 | 選 App／素材、貼上文案、確認發布 |

X 官方分享按鈕容許帶入內容，最後由使用者確認送出。[X 分享按鈕說明](https://help.x.com/en/using-x/add-x-share-button)。Threads 官方 Web Intent 支援文字參數，未提供本地素材檔案參數。[Threads Web Intents](https://developers.facebook.com/documentation/threads/threads-web-intents.md)。

Facebook 的 Web Share Dialog 以連結分享為主，URL 流程需要 `app_id`；本版使用一般網站交接，不冒稱可直接填入任意圖文。[Facebook Share Dialog](https://developers.facebook.com/documentation/sharing/reference/share-dialog.md)。Instagram 文件提供原生 Android／iOS 素材交接；目前產品是網頁，不能據此保證瀏覽器可指定 Instagram App 或帶入文案。[Instagram Sharing to Feed](https://developers.facebook.com/documentation/instagram-platform/sharing-to-feed.md)。

`navigator.share({files})` 在使用者點擊中同步呼叫，並以 `navigator.canShare` 檢查當次檔案。分享選單與可用 App 由裝置提供，本頁不知道實際目的地；Promise 完成也不是發布成功。取消、失敗或不支援皆保留準備內容，提供複製／下載／官方網站備援。[W3C Web Share 規格](https://w3c.github.io/web-share/)。

無法確認使用者提到的「快手」是哪款 App。Kwai 的公開商店介紹提到對外分享，但不能從這項介紹推定其內部使用免 API 自動多平台發文。[Kwai 開發者商店頁](https://apps.apple.com/us/app/kwai-short-video-community/id1338605092)。本版設計根據各平台公開文件，不宣稱已逆向其程式。

## 帳號、資料與恢復

- 預設關閉。提醒內容涵蓋平台可能依內容、頻率與操作限制或停權；開啟同意不提供「不會被鎖」的保證。X 官方明示不允許以腳本自動操作網站等非 API 自動化，可能永久停權。本版不執行這類網站機器人。[X 自動化規則](https://help.x.com/en/rules-and-policies/x-automation)。
- 不收集社群帳密、Cookie 或 Token，不由伺服器用管理者帳號分送。交接動作在會員自己的瀏覽器／裝置上執行。
- 草稿快照、`File`、檔名、選擇與確認進度只保留在目前登入世代的記憶體，不寫入 `localStorage`、`sessionStorage` 或新增伺服器資料表。關閉面板／同登入導覽可續接；完整重載或重開瀏覽器不保證恢復。登出或登入世代變更會取得新的空工作，舊非同步結果不能恢復上一身分的內容。
- 素材不為此功能上傳伺服器或壓縮；只讀取最多 16 bytes 格式標頭。這是基本格式篩選，不是完整解碼、病毒掃描或外部平台相容性驗證。無效、超量或超限的新增素材被拒絕，原本有效素材保留。
- 關閉功能保留本次登入中的草稿與準備內容，阻止所有對外交接；重新開啟需再次確認提醒。
- UI 區分「待操作」「已請求開啟」「系統分享已交接」「本人已確認」。不從分頁關閉、回到焦點、開啟連結或系統分享完成推導發布結果。
- 失敗提示位於素材、文案或目前平台步驟附近。複製失敗自動展開可選取的文案；取消系統分享可以重試，也可以下載素材。
- 分享工具延後載入。載入失敗時保留工坊發文器與原稿；對當次同源、固定名稱的雜湊 JS chunk，最多提供 3 次明確重試，使用新的模組快取鍵。其他 URL、CSS 失敗或無法辨識的錯誤不提供假的恢復承諾；原生發文仍可操作。

## 已驗證範圍

產品來源：`SocialZone.tsx`、`SocialCrossPlatformShare.tsx/.css`、`social-share.ts`、`share-module-loader.ts`。既有 API、資料庫與原生貼文命令未新增外部發文能力。

- Node 24：`npm run typecheck`、`npm run build` 通過。
- 4 個 runtime 檔合計 30 pass／0 fail／0 skip：新增分享邊界 15、既有設定登出 3、build measurement 4、Social Post 任務 8。命令：`node --import tsx --test --test-concurrency=1 tests/runtime/social-share.test.ts tests/runtime/page-tools-notification.test.ts tests/runtime/portal-build-benchmark.test.ts tests/runtime/social-post-task.test.ts`。
- Chromium：5 個受影響 suite 合計 35 pass／0 fail／0 skip，包含本功能 10 項、原有文案優化 4、帳號語言 9、簡化社群 4、原生動態 8。命令：`npm run test:e2e -- tests/e2e/social-cross-platform-share.spec.ts tests/e2e/social-post-optimizer.spec.ts tests/e2e/account-language.spec.ts tests/e2e/simple-social-experience.spec.ts tests/e2e/social-feed.spec.ts`。
- 320px／桌面、light／rpg／versefolk、Logo 與逐站操作觸控範圍、焦點返回與前進、減少動畫設定；5 種介面語言保留會員原文。測試使用真實站內合成登入及隔離 PostgreSQL，外部網站交接受控，不建立真人社群貼文。系統分享成功／取消／失敗是明示模擬，實際 iOS／Android App 仍待驗收。
- 初始 JS gzip 由 209,711 bytes 變成 209,720 bytes（增加 9 bytes），同一 HTML 靜態依賴閉包算法，通過事前設定的增加不超過 7% 門檻。選擇器 JS gzip 12,309 bytes、CSS gzip 1,571 bytes 在開啟工具時才載入；不是實際操作延遲或正式負載量測。

首次瀏覽器組合為 33 pass／2 fail，保留原失敗：Windows 剪貼簿讀回 CRLF 的測試可攜性問題，以及瀏覽器快取失敗模組造成原重試無法恢復的產品問題。前者只正規化測試讀回換行，後者修復上述受限的明確重試；未放寬原稿、選取、發布狀態或恢復斷言。

先前 source `ea0f687` 的 hosted run `37614196445` 仍有 UI job 逾時及 8 個已出現的失敗案例，沒有完整 UI 結果；不得以這 35 項本機通過替代整套 hosted CI。該 run 的 runtime partition 5 登出文字 fixture 已在本版更新為既有翻譯呼叫，原結構斷言保留並本機通過。人工 review、實體手機交接、正式負載與全平台 UX／效能驗收仍未完成。
