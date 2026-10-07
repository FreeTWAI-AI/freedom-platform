# 社群體驗與效能：持續升級紀錄

日期：2026-10-07。Hao 的完整目標為所有功能、UI／UX、按鈕回饋與平台效能持續升級，並以 Meta／Discord／LINE 作競爭標竿。這不是縮減完成條件；以下先處理能實測的瓶頸，完整目標保持未完成。

## 本輪實驗，修改前凍結

- Source baseline：`a10da499ebd88858664388a744b859f0f9f92b3a`，起始 upstream base：`57b610abe0277e4b0fda711f45dd063540252ad0`。起始盤點 8 份 open PR；後續 #192 已合併、#175／#190 更新。07:15 UTC 再查 9 份 open PR（包含本 PR #193），比對其餘 8 份；#190 最新的 PATCH／候選 DTO 及成果上傳、#194 runtime runner／reporter 的分區時間界線均沿用它們的獨立 PR，沒有重做。
- 環境：同一 Windows 主機、Node 24.19.0、Chromium、專用合成 PostgreSQL；本機與正式站、staging、真人及競品證據分開。
- Baseline 前端與上一份建置相同；保存 HTML／assets 的精確 bytes。比較完整初始 JS 靜態依賴，而非只比較改名後入口檔。
- 初始 JS 成本：按頁載入重模組，目標完整初始 JS gzip 降到 baseline 的 70% 以下；登入、首頁與聊天入口仍可用。這只證明本輪 payload，不代替實際使用者 LCP 或萬人效能。
- 即時回饋：人工延遲真實 API 回應時，操作狀態必須在 ACK 前可見；切頁下載時保留導覽，失敗有恢復入口。失敗／超時／取消不顯示成功。
- 網路成本：同 client／同身分／同 GET options 的重疊讀取合併為一個請求；結束後下一次需重新讀取。異身分、不同路徑、獨立取消與所有寫入不得錯合併。正反例驗證 evaluator。
- 零容忍回歸：不串帳號、不擴大可見範圍、不自動重送寫入、不丟失既有待確認 command key；原聊天、貼圖、返回、草稿、主題、發文與已讀回歸。
- Decision：只有實測條件成立才聲稱該維度改善；任何上述回歸阻止採用。未完成的全平台或競品比較保持 open。

## 反例驅動的第二輪條件

擴大回歸的 v5 candidate 發現聊天室實際回歸，不能採用：撤權後的新讀取共用了撤權前仍在等候的清單，讓舊清單回來。另有名片輪換 QR 的截圖解碼失敗。保留失敗 log 與 trace，以下條件在修正前追加，原隱私／恢復門檻保持。

- GET 預設保持各自新讀取；只對明確標記 `coalesce: true`、允許共用的背景提醒讀取合併。聊天室與其他有 generation／撤權／強制刷新語意的讀取保持獨立。寫入開始與結束都清除可共用讀取的索引；不取消既有訂閱者，也不讓較舊回應清除較新的索引。
- 寫入前、寫入中、ACK 後的受控讀取需看到各自快照；撤權後的聊天室不得由遲到清單恢復。GET 比較維持相同 client／相同 options 的正反例：baseline 5 次，符合共用條件的 candidate 1 次；不宣稱所有讀取都合併。
- QR 保留原模板、四格留白與 opt-in URL；真實名片連結建立、更新、撤銷、手機掃碼及 PNG 匯出需解碼正確。v6 的整數比例嘗試仍失敗；檢查原始截圖後發現碼的上半部被置頂導覽遮住，因此撤回比例修改，讓掃碼測試先將完整碼捲至畫面中央再解碼。不能以延長 assertion timeout 或移除掃碼 assertion 放行。

整合後全量 E2E 的第一次 Windows 嘗試在裝置配對 fixture 失敗，於 140 項時停止並保存 log／trace。兩個 static fixture helper 的 bytes 與 baseline a10 相同；它們以 `root + '/'` 判斷邊界，對 Windows `\\` 路徑會拒絕自己的頁面與 JS。修正採 Node `path.sep`，保留相鄰目錄／父目錄越界拒絕；校準同時驗證 Windows／POSIX，不修改產品 ACL 或裝置 consent／CAS assertions。另將帶 receipt key 的 GET 保持獨立，補齊共用讀取的 options 反例。後續完整重跑會另記結果，不能把這次中止記作 PASS。

整合分享入口後的第二次全量嘗試於 23 項時中止（22 pass／1 fail），失敗在真實管理員流程的 fixture 收尾。Browser trace 顯示所有操作與權限 assertions 已完成；只關閉該 fixture 的 HTTP connections 後，同一流程 16.2 秒通過。另依新工具列更新兩個登入 selector、分列工具的對齊檢查，以及等實際 toolbar 掛載才開啟的 helper；保留可見性、accessible name、觸控、顏色、圖示與焦點斷言。型別錯誤及修正前的 8 pass／1 fail、22 pass／1 fail 也保留，沒有提升 timeout、使用 force click 或跳過失敗案例。

原 PR 的四項 P2 review 一併追蹤：名片姓名 token 與工具 dialog 焦點已修正；本輪在 Chromium 加兩個受控實際 API 交錯，修正前為 6 pass／2 fail，重現發文 ACK 搶走新分類的焦點及第一頁留言被作廢。發文依當前分類／選擇版本合併，只有原發文視窗尚未被關閉或重開時恢復其焦點；留言保留讀取與 cursor，暫存新確認留言直到 server page 包含它，再以 ID 去重。26 則既有留言的分頁與新增後 27 則完整顯示都驗證，不新增第二套留言系統。

第三次完整 E2E 在 `e53e4c6f23090dcbe9e3c0b9c350782264bb08ea` 執行，收到 Hao 的手機主牆設計修正後主動停止；已觀察 172 pass，未觀察 fail。這是中止紀錄，不是完整 PASS。原 log／artifacts 保留；先完成貼文優先版面再重新建置、驗證。

## 手機動態牆的再次修正

Hao 明確要求主牆像一般社群直接呈現會員貼文。預設原生貼文＋清楚「＋發文」，移除主畫面的分類下拉、外部分享摺疊表單與原生貼文重複 badge；換圖／刪除移至貼文選項，發布回饋縮成短句。所有平台篩選與原外部 URL／縮圖分享仍可透過動態選項使用，作品／商品／開源投稿沿用全站「＋分享」。按時間顯示，不加入曝光排名或付費加權。

型別檢查與 fresh build 已通過；主牆、外部分享與本人優化在最終手機聊天 v5 的十檔組合中一起驗證，73 pass／0 fail。Guides 另有先前 27 項回歸。前一次全量的中止或前版通過不能代替這個新主牆。

第二次主牆針對性回歸完成 25 pass／1 fail，新的原生主牆、發文 ACK／留言分頁交錯及本人優化均通過。唯一失敗是舊外部作品刪除案例沒有先選擇全部動態、開啟本人的貼文選項；已改為走這兩個真實入口，最終手機聊天 v5 組合中此案例也已通過。

新的針對性第一次 run 在 37 項後停止（34 pass／3 fail），三項失敗均是外部分享測試用部分名稱「連結」，同時找到新 dialog 和實際 input。保留三項 trace，改為 exact 欄位名稱，維持同一縮圖、分享、版面及配色 assertions；未提高 timeout 或改產品 accessible name。

測試期間重新查主線，#190 已合併至 `31df6ddb4e9356715b26d292bb5ab7869d365f36`。同步它的「我的工作」、成果提交／驗收與 DTO，沿用它的 runtime 登錄；只替新 PATCH method 補上本輪 opt-in GET 索引的寫入前／後隔離，同一受控反例也涵蓋 PATCH。#194 更新後維持 local runner 900 秒、只有 hosted partition 1,200 秒，本輪未複製或修改其 runner 工作。

## 聊天分組與自動已讀

新增[聊天操作與範圍說明](social-chat-experience.md)。桌面使用類別／群組列表／單一對話；手機列表與對話有返回動作。沿用現有公會、小隊與私訊資料，沒有第二套群組。依 Hao 最新明確要求，自動已讀是正在顯示最新訊息時的新寫入；背景、未選擇群組及較早歷史不清未讀，回應遺失仍不默默重送。

私訊加入驗證過的 `through_message_id`，保留舊 API 的空 body 相容性。收到 ACK 後向 API 重新確認未讀數，避免 idempotent replay 的原更新數把較新未讀扣掉。93 項 runtime 通過，最新型別檢查與建置通過；手機滿版、聊天、貼圖、通知、控制台及主牆的十檔 v5 組合為 73 pass／0 fail。

## 手機滿版聊天與最新主線整合

手機對話採完整可用高度，分類與建立群組留在列表。返回、頭像、對象／群組名在上方，訊息區伸展，貼圖／輸入／送出在底部。僅聊天時收起全站工具、導覽角色與控制台，示範說明保留；返回即恢復。視窗縮小會跟著 visual viewport 調整，不把有新訊息或載入失敗說成已讀成功。

最終 v5 十檔 73 項 Chromium 全數通過，含原生牆、投稿、分享及本人模型優化。v1 寬度／輔助名稱／fixture 共五項失敗的 trace 保留；v2 在截圖檢視的頭像與列表 activity 假設修正後停止，僅九項已觀察通過；v3 為 73 pass。v4 的 72 pass／1 fail 是導覽 helper 誤點通知鈴卻期待私訊，修正為真正導覽入口後，原 App bytes 的同案例反例 1 fail，修正版 1 pass，v5 全組合通過。沒有提高 timeout、force click 或移除視窗／已讀／ACL assertions。

08:43 UTC GitHub 快照為 9 個 open PR（#193 加其餘 8 個）。新增／更新 #189／#195／#196／#197 pinned CI stack 及 #188 共用 Launchpad primitives／schema 的路徑、精確 diff refs／digest 保留，不重建這些功能。#175 與 #194 已合併至主線 `137ace26dd00252219f7f4fed8c23b60c937ff9c`，直接同步；社群 schema 改為 125，124 原 bytes 保留，manifest／frontier／已知名稱／完整 catalog digest 同步。此整合的離線 Linux 完整 preflight 458 pass／0 fail／0 skip。

完整三階段 E2E、最新 hosted CI 及真人驗收仍未完成，不能把 73 個針對性案例當作全平台 PASS。測試與圖檔留在本機，沒有正式或 staging 寫入。

最終 2026-10-07T09:04:50.434762+00:00 快照增加 #203 JSON 串流上限、#204 活動交易配額：共 11 個 open PR（本 PR＋其餘 10 個）。核對精確 base／head diff 與 candidate 檔案範圍，兩者均無 changed-path overlap，不重複實作，也未合併仍在審查的 PR。

## 全目標待驗收矩陣

本輪新增[分享／提交入口](social-sharing-entry.md)、供貨商／創作者／開發者的具體入口及 [Social Post 本人額度優化](social-post-optimization.md)。手機登入、密碼找回與長發文視窗也納入真實瀏覽器回歸；這些增量不代替下表的真人與正式站驗收。

| 領域 | 需要證明的結果 | 現況／後續 |
| --- | --- | --- |
| 所有操作入口 | 每個實際按鈕都可辨識、可鍵盤操作、點擊即有適合的狀態，寫入失敗可恢復 | shared request 回饋＋按頁回歸；完整操作清單及逐頁真人驗收仍待完成 |
| 註冊與初次參與 | 包含必要驗證的加入流程 30 秒內，無需旁人教操作 | 既有簡化註冊／公會流程；真人分布與放棄率未量測 |
| 發文與自我展示 | 日常、作品、附件、個人頁與搜尋易用，作者控制可見範圍 | #193 原生發文與時間 feed；發布前附件、完整作品頁、搜尋與匯出待做 |
| 內容選擇與探索 | 追蹤／公會／主題本人選擇、推薦可關、新作者能被找到 | 產品方向已定義；新增功能與真實曝光評估待做 |
| 聊天 | 即時待送、收到／已讀準確，返回／搜尋／附件／斷線重連可用 | 分組導覽、待送、貼圖、返回、顯示後自動已讀與有權限界線的歷史文字搜尋；即時傳輸、附件、封鎖／檢舉待做 |
| 合作與回報 | 需求→找人→對話→約定→交付→驗收閉環，不重建既有業務系統 | 沿用 Work／Opportunity／Engagement；銜接、真人成果及正式回報驗收待做 |
| 全平台效能 | 首次載入、互動延遲、API／DB、聊天延遲、資源量、負載與錯誤率可量測 | 本輪減少起始 payload 與重疊讀取；正式網路／DB／負載尚待實測 |
| 超越競品 | 同任務、同裝置、可比較的完成率／延遲／留存與使用者偏好 | Meta／Discord／LINE 的對照資料仍缺；不能宣稱 parity 或領先 |

本輪 source-only PR 不部署或變更營運旗標。記錄、benchmark 原始嘗試、私有學習與 exact artifacts 留在本機；不提交會員資料。功能與完整驗收以持續更新的原始證據為準。

## 本機已確認的結果

- 完整初始 JS 靜態依賴 closure：baseline 1,361,771 bytes／gzip 383,241 bytes；加入本人模型優化、角色入口、分享選單、review、貼文主牆、主線 #190 及手機聊天改版後 candidate 614,990 bytes／gzip 189,316 bytes。gzip 降低 50.60%，通過預先設定的 70% 門檻；將 baseline 和自己比較的反例仍拒絕。主線 #190 前的主牆為 580,345／180,172；v8 的 572,186／177,671、分享初版的 gzip 180,111 與 review 版的 gzip 180,127 也都是歷史數字，不能代替目前建置。
- 受控、明確允許共用的 5 個同時 GET：baseline 5 次 transport，candidate 1 次；settled 後下一次仍重新請求。預設新讀取、帳號切換、JSON 副本、獨立取消與 POST／DELETE 前後快照的反例一併驗證。
- Client／build benchmark／Social Post／模型 service／上游成果 client runtime tests：62 pass／0 fail／0 skip，包含 PATCH 寫入前／中／後的快照隔離。同步 #190 後的型別檢查與建置通過；先前未含成果 client 為 58 pass。整套 runtime CI 尚未在新 head 執行。
- v4 的 85 項瀏覽器回歸通過。完整 hosted a10 UI CI 揭露 15 項失敗；v5 擴大範圍為 58 pass／7 fail／10 fixture skip，v6 為 7 pass／2 fail。沒有將這些版本放行。修正後 v8 的 9 項針對性反例／瀏覽器檢查全部通過，涵蓋撤權清單、名片 QR／PNG、名片配色、導覽與原素材載入；全量三階段 E2E 仍待本輪最終執行。
- Hosted a10 的四個 runtime partition、runtime aggregate、static worker、governance 與 deploy preflight 已通過；a10 的 UI／verify 仍失敗。這些結果不能當作新 head 的 CI。

- 角色、發文、本人優化、手機登入錯誤、原生 feed、shell 與密碼找回的針對性瀏覽器檢查：26 pass／0 fail。先前候選有 7 fail／19 pass：手機寬度規則把收合工具當成三欄整列，撐出登入標題；鍵盤序列也需包含新增的工具入口。修正實際 CSS 寬度及導覽序列後，未移除寬度、觸控或焦點 assertions。320px／390px 原生截圖已檢視。
- Model fixture 修正後 2 pass／0 fail：正常執行及 ACK 遺失均只有一次 Execute／一次私人成果；不呼叫真實 provider、不消耗真人額度。修正前的失敗、clock 控制反例及拒絕版本留在本機，不能記作成功。
- 新分享入口與既有作品投稿／shell 的針對性回歸：18 pass／0 fail，含桌面與 320px 真實作品提交、五個實際控制項、單次寫入、三主題與失敗恢復。完整三階段 E2E（一般頁面、私人模型 fixture、avatar asset fixture）仍待最終執行。
- Review 修正後，組合回歸 22 pass／1 fail：新的分類／焦點及 27 則留言案例通過，唯一失敗是 test helper 在 toolbar 尚未掛載時返回。依 trace 改等實際可見入口，工具／guide 完整回歸 27 pass／0 fail；包含登入、四種寬度、兩主題、關閉／Esc、私人輸入、真實導引與跨帳號隔離。沒有把先前失敗版本記作 PASS。

以上是載入量、可共用請求成本與特定流程的證據；正式站延遲、負載、全部按鈕真人操作及競品比較仍保留在原目標矩陣中。


## PR #193 再次要求修改與修復（2026-10-07）

GitHub 的 review `5440401866` 在 `fb10504b7cb5bf9f7506efca9d25c5b5c3649c95` 確認前四項 P2 已修復，另外提出兩項 P2。PR 仍是 open Draft／CHANGES_REQUESTED，尚未被關閉或接受。原四項包括名片姓名 CSS、工具關閉焦點、遲到的發文 ACK 與第一頁留言交錯；本輪沒有將 reviewer 的修正要求寫成採用結果。

1. Social Post 手動複製任務 A 後改成 B、再貼回 A，原版會錯誤綁到 B。現在在複製／取得手動任務時記住當時的來源與 session generation；關閉再開仍可核對，改過草稿顯示過期結果、禁止套用。新一輪複製與直接貼入的新草稿仍可使用。也修復結果 textarea 的明確 accessible label，避免輸入內容改變欄位名稱。
2. 私訊已讀請求 A 尚待確認時返回、重進 A，失敗回應被舊 generation 擋住，重試入口消失。現在按目前對象／房間呈現恢復入口，保留原 command key 與讀取界線；切到 B 不顯示 A 的錯誤。不自動重送。私訊同對象重進、不同對象切換、公會返回重進均驗證。

修正前在保留兩個缺陷的來源上以真實 API 交錯重現 2 個產品 FAIL。修正後擴充回歸驗證原本反例與正常下一輪使用；擴充的測試檔與原反例並非全檔相同 bytes，結果依各版本保存。Social Post runtime 10 pass／0 fail／0 skip。

Hosted run `37598716550` 在原 `fb10504` 的 UI 結果為 539 pass／3 fail／12 skip，ui-e2e 與 verify 失敗；其他必要工作成功。三項失敗分別是初次已讀 ACK 之後的真實重讀尚未結束就量測 idle、Home lazy 元件未掛載就找定位入口、開源 lazy 元件未掛載就操作摺疊區。測試改為等實際完成／可見入口；保留原 idle 請求數、待確認互動、dim／disabled 及提交 assertions，沒有提升 timeout、force click 或跳過原案例。三項皆在本機修正版回歸通過，不能因此把原 hosted run 改寫為 PASS。

### 五種帳號介面語言與歷史搜尋

- 帳號入口與基本導覽提供繁體中文、English、日本語、한국어、Español。依瀏覽器預設、使用者可自選並在設定改回自動；切換保留輸入及待確認操作。此為 [帳號與基本入口範圍](social-account-language.md)，公會自訂題目、技能書內容及所有會員功能的內文仍依原資料，未宣稱整站翻譯完成。
- 私訊、公會、小隊與公開聊天室提供歷史文字搜尋，沿用現有資料及權限。字詞 1–100 字、每頁最多 50 筆、預設 20；查詢內 1,500 ms statement timeout。UI 分頁、搜尋期間保留未讀、關閉返回草稿／焦點，遲到回應不跨對象或帳號。權限錯誤不保留舊結果。
- 兩個會員通訊 runtime 檔在同步後的實際 PostgreSQL 執行為 37 pass／0 fail／0 skip；三項瀏覽器搜尋案例含 20＋7 歷史分頁、相同微秒時間、房間隔離、重試、草稿／焦點與手機版面。
- 實際 service SQL 在合成、隔離 PostgreSQL 的 EXPLAIN ANALYZE，私訊／公會／小隊／公開查詢 execution time 分別為 1.106／3.147／1.706／2.066 ms。資料為每個選定範圍 1,000 則，加另一對私訊及另一公會各 10,000 則；只證明此資料下的 SQL 執行計畫，不代表完整 API、正式延遲或萬人負載。

### 嘗試紀錄與最後可觀察結果

- 第一次正向組合在 30 秒 webServer 啟動界線內未啟動，0 tests；保留 runtime／measurement 失敗，沒有提高啟動 timeout。與並行建 schema 的關係只有推測，未宣稱已證實根因。
- 第二次組合 18 pass／1 fail、第三次診斷 1 fail，指向手動結果欄位的 implicit label。Dialog 名稱 assertion 通過；修正欄位 label 後同案例 1 pass。
- v5 受影響的 93 項 UI 組合為 88 pass／5 fail；五項均因資源區測試誤選到技能書的巢狀 summary。改用資源區直屬 summary，保留真實三張資源卡與加入 assertions。
- Fresh build 的 v6 回歸為 24 pass／0 fail，包含五語言 9 項、貼文 8 項、簡化介面 4 項與工具 3 項。v5 的其餘 88 項產品 bytes 與 v6 相同；此為兩次執行的證據組合，不是一次 93 項全綠的執行。
- 目前 fresh build 完整初始 JS closure 為 657,378 raw／205,252 gzip bytes，baseline 1,361,771／383,241；gzip 降低 46.44%，通過原 70% 門檻，baseline 對自己的負控制被拒絕。v5／v6 的此建置 closure 每個檔案 hash 相同。前文 50.60% 是加入語言與搜尋前的歷史數字。
- 型別檢查與 fresh build 通過。新 head 的 hosted CI 及人工 review 尚待確認，原 run 的 12 skip 不改成通過。完整平台、真人註冊 30 秒、正式站及競品對照仍 open。

主線後續合併 #188／#189／#191，已同步到 `9674dedfd9f83f47e0352f2497485a9c45753e13`；#191 只改測試收尾與 inventory，產品／build bytes 不變。最新盤點另外 10 個 open PR，核對 frozen base／head、完整檔案與精確 diff digest。#195 CI 分區／runner、#209 tenant-work 共用契約不重做；#205 密碼重設 callback 的 SessionPayload／applySession 是另一份未合併 PR，語言修改維持目前主線流程並記錄未來整合界線。完整 [PR 比對紀錄](social-platform-pr-overlap-2026-10-07.json) 保留歷史快照。

Code Cleanup 與 R&D 的原始失敗、正反例、來源／環境、學習與未驗證範圍保存在專案私有 `.rd/`，不將此 source-only 修改聲稱為全平台安全認證、安裝包或部署。


## 手機安裝、訊息入口與 48 張貼圖的交付候選

沿用 Hao 已授權的 PR 修正與增量需求，同步已合併主線 #195 至 `6ffdf94ad7ef4f1fbf1d533c2391cb248f5904ba`；查看另外 11 個 open PR 的 frozen base／head、完整 files 及 diff。#209 契約工作維持獨立，#210 的 favicon／OG metadata 與本輪 PWA 共用 index.html，涉及不同功能；未採用尚未合併素材。比對收據保留先前快照。

- [手機安裝](social-mobile-install.md)提供 manifest／品牌圖示、登入／設定入口、五語說明、離線提示與安全邊界。六個案例包含真實 Chromium installability 和斷線；系統 prompt／standalone／瀏海屬模擬，手機真人安裝未驗。
- [聊天室入口和貼圖](social-chat-experience.md)加入右下角 60px 訊息按鈕，以及 Hao 提供的 48 張。96 個 WebP 的解碼、雜湊及尺寸全數核對；512 圖 2,892,096 bytes＋144 縮圖 354,702 bytes，合計較 16,262,574 bytes 原 JPEG 少 80.035%。手機選單可捲動，先取縮圖、選取後才取聊天圖；原 4 個 ID 保留。
- Fresh Node24 typecheck／build 通過；完整初始 JS closure 為 671,388 raw／209,711 gzip bytes，baseline 1,361,771／383,241，gzip 少 45.28%，通過原 70% 門檻。這不代替操作延遲、真人體驗、正式負載或競品比較。
- 隔離 PostgreSQL 最新 3 檔 runtime 為 46 pass／0 fail／0 skip，包含 37 項會員通訊／搜尋及 9 項貼圖內容。新 48 個 ID 通過私訊／群聊資料庫限制；原 4 張、API 保存、未知 ID、回覆範圍、CSRF 與 rate limit 均回歸。Social Post unit 10 pass；release compatibility 118 pass，保留未知 migration 及過期批准的拒絕。
- 畫面主組合 114 pass／0 fail，另原簡化社群 4 項單獨重跑 4 pass／0 fail；合計 118 項、兩次執行，前端及測試 source blobs 一致。其後只移除 migration126 末尾多餘空白，另重跑 9 項內容 runtime 及 118 項相容性；不以空白格式變更推定新產品行為。包含先前 3 個 hosted 失敗案例、2 項 P2、五語 9、搜尋 3、PWA 6 及 4 項新貼圖／訊息入口。
- 首次貼圖 run 因 126 未列 frontier 而 0 tests；11／1 的 focused UI 使用錯誤世界聊天按鈕名稱。API fixture 的 45／1 失敗是 48 則「新」raw fixture 觸發既有 20-per-minute 限制，改為較早歷史資料後 46 全綠；原 rate-limit 斷言保留。主組合漏寫簡化社群檔名，4 案例另跑並區分兩次 run。早期 PWA 111／3、其他失敗及 trace 保留，未提高 timeout 或 skip 案例。

獨立 Code Cleanup 與 typed R&D evidence 留於本專案私有 `.rd/`，保存 source／environment／hash、正反例、失敗分類與未驗項。Whole-project 既有 FAIL／REVIEW／NOT_CHECKED 不改成 PASS，不做 strict promotion。Context 工具對未知 root surfaces 回報 `surface_unmapped`，保留 fallback；已讀受影響及全部模組規則，未將工具結果改寫為 complete。

本輪只更新原 Draft PR #193；新的 hosted CI 與人工 review 仍待外部 readback，未 merge／deploy。原 `fb10504` hosted 539 pass／3 fail／12 skip 保持 FAIL。完整平台目標 ACTIVE；正式效能、全站翻譯、實際手機安裝與競品驗收仍 open。

## 貼圖交付後的完整部署預檢修正

交付 `873b76424a8be066bd8833327d0b27e770d97f65` 後，GitHub run `37612706890` 的 deploy-preflight 為 **457 pass／1 fail／0 skip**。完整遷移清單的既有測試仍使用 `last:125` 與第125版 digest，所以拒絕新貼圖的第126版；先前118項 focused release compatibility 通過並未涵蓋這個完整清單案例。原失敗 log 保留，未將其改寫成成功。

只更新 `deploy/cloudflare/test/migration-plan.test.mjs` 的完整清單 fixture 至 `last:126`，以及125個 canonical Git SQL blobs（含已知022空缺）的精確 ledger digest `c70269d381d1c8b9e43afa7abd5d95af4d31918125358c041b91d8d0046ae00c`。原有 `ok`、dependencies、特權 SQL、未知遷移及過期批准的拒絕 assertions 保留，沒有放寬部署條件或修改任何 migration SQL。

在修正 commit `85701e8ebc2ad18572a7d566b9b8f97998cd8d13`／tree `f0ecd0d8cc83d011008346541eddfc7712e9b31a`，用固定 Node24.21 image、Git archive stream、無網路的自有 Linux 容器執行 **全部** `node --test deploy/cloudflare/test/*.test.mjs`，實際 **458 pass／0 fail／0 skip**。這是完整本機部署預檢；新 head 的 hosted 結果與人工 review 另行讀回。先前1951個受測 source blobs中僅此CI測試變更，其餘1950個相同；前端、API、catalog、96個壓縮資產及migration SQL都維持原結果的受測bytes，因此本次不重跑與此fixture無關的UI／API。

失敗原因、原hosted收據、完整native log及修正後的Source／Cleanup／R&D紀錄保存在本專案私有`.freedom/`與`.rd/`；不做共享規則升級。本輪仍更新原Draft PR #193，不包含部署或合併。

## 通知入口的回饋與查詢成本

延續[多平台分享](social-cross-platform-sharing.md)的四個可選 Logo、亮燈、取消與草稿保留操作，這次改善共用通知入口：點開立即顯示局部載入狀態，失敗可按「再試一次」；Escape 關閉並回到鈴鐺，點面板外關閉。介面文字使用既有五語設定，會員通知標題與內容保留原文。320／390／820／1280px 面板維持在畫面內，操作目標至少 44px。

只合併尚未結束的同身分、同 options 背景讀取；關閉不查詢，下一次點開仍向伺服器確認，沒有加入已完成回應快取、輪詢或第三方服務。標已讀收到確認後，由一個既有 inbox 事件刷新。單則與全部已讀的舊帳號回應必須先核對目前 session，才可更新本機、通知其他入口或導覽。

| 受控本機量測 | 原 0120 版本 | 修正版本 |
| --- | --- | --- |
| 點開／關閉／focus／inbox 事件的重疊 GET | 4 次 | 1 次 |
| 單則已讀確認後的通知刷新 | 2 次 | 1 次 |
| 切換帳號後，舊單則／全部已讀 ACK 的 inbox 事件 | 各 1 次 | 各 0 次 |
| 完整初始 JS 靜態依賴 closure gzip | 209,716 bytes | 210,838 bytes（+0.535%，低於本輪 1% 上限） |

同一版測試 bytes 在原產品為 1 pass／4 fail，既有真實朋友通知為正控制。修正後 fresh typecheck／build 通過，54 項 native 通過；最後 66 項瀏覽器回歸為 66 pass／0 fail／0 skip，包含五語帳號、通知、分享、手機安裝與四平台操作。54 項 native 後只有兩個 CSS 變更，產品邏輯與 native evaluator bytes 相同。成功附件因僅使用 list reporter 未保留，再用相同 source／build／10 個測試與 JSON reporter 另跑 10 pass／0 fail，取得點擊至載入回饋下一幀 9.6ms 的單次本機樣本；不作正式 p95 或多出十項覆蓋宣稱。

第一版修正的 12 pass／5 fail 保留：五語面板均量到 x=-37px 裁切。改為對齊整個帳號工具列並計入 padding，原斷言下五語乘四寬度的 20 組幾何檢查通過；實際載入、錯誤、西班牙文通知及登入／安裝截圖已檢視。早期測試曾使用錯誤行號，只跑正控制；跨帳號 helper 曾重新載入頁面而中斷舊 promise，及誤假設首頁 URL。這些量測失敗分開保存，修正測試後重新測原產品，沒有降低 assertion、提高 timeout 或跳過案例。

原 head `0120c45` 的 hosted run `37624831193` 已結束為 failure：一般 UI 577 pass／1 fail／12 skip，西班牙文 320x844 的第一個 Email 欄位 bottom=855.5 超出 844；額外私人模型與 avatar fixture 階段未開始。實際 checkout 為合併後 `d2f37aaa154ec3a82659d795af9d8099c8d24e0e`，主線 `4b3180740524d4ff1fcc41a9971e5522fdca951f`、trusted evaluator `6ffdf94ad7ef4f1fbf1d533c2391cb248f5904ba`，不是單獨 PR head 執行。結構化失敗 summary 的 test_count=0 不能替代原 log 的實際數量。

本輪縮小窄手機登入區塊間距，保留原品牌圖、文字、16px 輸入字體與 44px 控制項。本機五語原斷言通過，新 source 的 hosted Linux 結果仍待確認。全部 hosted、人工驗收、實體 iOS／Android 分享、正式負載與完整平台／競品比較保持待完成；這些局部改善不宣稱整平台完成。
