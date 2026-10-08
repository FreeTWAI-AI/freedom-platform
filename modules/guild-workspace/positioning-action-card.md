# 我的方向卡內容格式

定位公會既有 My Work 的小型手動練習，步驟沿 [career-guide 導讀](../community/skill-book-guides.ts)。它不執行外部 Skill、重新計算會員定位或承諾職涯／收入。

## 保存與續作

先建立 Work，填一至兩個可試活動，選一個、補完成條件、可投入時間、需要協助與回顧日期。未填完可存草稿；本人確認要求目標、所選活動、完成條件、時間與有效回顧日期齊備。修改計畫會取消本人確認，回顧／下一步可續填。

[型別內容](positioning-action-card.ts) 是 `freedom.positioning-action-card/v1` Markdown，綁唯一 `work_id`，使用既有 Result prepare → raw bytes → finalize → confirm checkpoint。建立 Work 與第一張卡是兩次命令；只有按「儲存方向卡」成功的欄位才有 Result。卡片內容留在目前業務空間，具有該 Work 讀取權限的成員可閱讀；公會會員或會長身分不授予此權限。沒有自動匯入私人 assessment／answers／notes，沒有新 API、migration、model、provider、ACL 或一般流程引擎。

重新登入、選原空間與工作後，reader 按 Result 分頁尋找最後的方向卡。它先驗證原始 bytes 長度／SHA-256，再解析內容，並核對分頁 `source_version` 與最後 Work version。一般文字附件不遮蔽較早的卡片；新版本／損壞格式、跨 Work、摘要或版本 fence 不符會鎖住欄位，不當空白覆寫。原始 Results 仍可依權限下載。Reader 與製作企劃共用同一有界掃描主體，兩種格式的資料與解析各自獨立。

結果不明時保留相同操作 key／bytes／body／已確認 checkpoint，要求先在原頁確認；已知 412 保留草稿、讀取目前伺服器資料並讓本人比較選擇後另存新版。未送草稿可確認離開；pending／unknown 的方向卡保存或第一份 Work 建立不可用站內導航丟掉 attempt。全頁關閉只提供 beforeunload 提示，不宣稱瀏覽器崩潰後仍有未送內容。

建立、Work metadata、封存、Result 寫入分別看目前 tenant template 或同 instance 的明確 grants，server 每次重驗。read-only 可還原與下載；Result-only writer 不取得 Work 建立／metadata／封存權。換帳號／tenant／guild 後清掉舊 generation 與私人畫面。archive 仍是終態；需要回顧時用 progress=done，不封存。

## 驗證範圍

`tests/runtime/positioning-action-card.test.ts` 檢查草稿／本人確認、嚴格欄位、未知格式、跨 Work、原 bytes／BOM、摘要與 source version；production reader 與既有 uploader 回歸繼續保留。本機真 HTTP browser 的保存再登入、未知回應同 key、版本比較及 read grant 證據另記；測試 source 或合併不表示功能已部署。
