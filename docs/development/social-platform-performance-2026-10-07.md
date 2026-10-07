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

型別檢查與 fresh build 已通過；手機主牆、外部分享、本人優化、配色與 guides 的完整針對性回歸正在執行，結果待回填。前一次全量的中止或前版通過不能代替這個新主牆。

新的針對性第一次 run 在 37 項後停止（34 pass／3 fail），三項失敗均是外部分享測試用部分名稱「連結」，同時找到新 dialog 和實際 input。保留三項 trace，改為 exact 欄位名稱，維持同一縮圖、分享、版面及配色 assertions；未提高 timeout 或改產品 accessible name。

測試期間重新查主線，#190 已合併至 `31df6ddb4e9356715b26d292bb5ab7869d365f36`。同步它的「我的工作」、成果提交／驗收與 DTO，沿用它的 runtime 登錄；只替新 PATCH method 補上本輪 opt-in GET 索引的寫入前／後隔離，同一受控反例也涵蓋 PATCH。#194 更新後維持 local runner 900 秒、只有 hosted partition 1,200 秒，本輪未複製或修改其 runner 工作。

## 全目標待驗收矩陣

本輪新增[分享／提交入口](social-sharing-entry.md)、供貨商／創作者／開發者的具體入口及 [Social Post 本人額度優化](social-post-optimization.md)。手機登入、密碼找回與長發文視窗也納入真實瀏覽器回歸；這些增量不代替下表的真人與正式站驗收。

| 領域 | 需要證明的結果 | 現況／後續 |
| --- | --- | --- |
| 所有操作入口 | 每個實際按鈕都可辨識、可鍵盤操作、點擊即有適合的狀態，寫入失敗可恢復 | shared request 回饋＋按頁回歸；完整操作清單及逐頁真人驗收仍待完成 |
| 註冊與初次參與 | 包含必要驗證的加入流程 30 秒內，無需旁人教操作 | 既有簡化註冊／公會流程；真人分布與放棄率未量測 |
| 發文與自我展示 | 日常、作品、附件、個人頁與搜尋易用，作者控制可見範圍 | #193 原生發文與時間 feed；發布前附件、完整作品頁、搜尋與匯出待做 |
| 內容選擇與探索 | 追蹤／公會／主題本人選擇、推薦可關、新作者能被找到 | 產品方向已定義；新增功能與真實曝光評估待做 |
| 聊天 | 即時待送、收到／已讀準確，返回／搜尋／附件／斷線重連可用 | 既有 pending、貼圖與返回；即時傳輸、附件、搜尋、封鎖／檢舉待做 |
| 合作與回報 | 需求→找人→對話→約定→交付→驗收閉環，不重建既有業務系統 | 沿用 Work／Opportunity／Engagement；銜接、真人成果及正式回報驗收待做 |
| 全平台效能 | 首次載入、互動延遲、API／DB、聊天延遲、資源量、負載與錯誤率可量測 | 本輪減少起始 payload 與重疊讀取；正式網路／DB／負載尚待實測 |
| 超越競品 | 同任務、同裝置、可比較的完成率／延遲／留存與使用者偏好 | Meta／Discord／LINE 的對照資料仍缺；不能宣稱 parity 或領先 |

本輪 source-only PR 不部署或變更營運旗標。記錄、benchmark 原始嘗試、私有學習與 exact artifacts 留在本機；不提交會員資料。功能與完整驗收以持續更新的原始證據為準。

## 本機已確認的結果

- 完整初始 JS 靜態依賴 closure：baseline 1,361,771 bytes／gzip 383,241 bytes；加入本人模型優化、角色入口、分享選單、review 及貼文主牆修正後 candidate 580,345 bytes／gzip 180,172 bytes。gzip 降低 52.99%，通過預先設定的 70% 門檻；將 baseline 和自己比較的反例仍拒絕。v8 的 572,186／177,671、分享初版的 gzip 180,111 與 review 版的 gzip 180,127 是歷史數字，不能代替目前建置。
- 受控、明確允許共用的 5 個同時 GET：baseline 5 次 transport，candidate 1 次；settled 後下一次仍重新請求。預設新讀取、帳號切換、JSON 副本、獨立取消與 POST／DELETE 前後快照的反例一併驗證。
- Client／build benchmark／Social Post／模型 service runtime tests：58 pass／0 fail／0 skip。最後分享入口的型別檢查與建置通過；整套 runtime CI 尚未在新 head 執行。
- v4 的 85 項瀏覽器回歸通過。完整 hosted a10 UI CI 揭露 15 項失敗；v5 擴大範圍為 58 pass／7 fail／10 fixture skip，v6 為 7 pass／2 fail。沒有將這些版本放行。修正後 v8 的 9 項針對性反例／瀏覽器檢查全部通過，涵蓋撤權清單、名片 QR／PNG、名片配色、導覽與原素材載入；全量三階段 E2E 仍待本輪最終執行。
- Hosted a10 的四個 runtime partition、runtime aggregate、static worker、governance 與 deploy preflight 已通過；a10 的 UI／verify 仍失敗。這些結果不能當作新 head 的 CI。

- 角色、發文、本人優化、手機登入錯誤、原生 feed、shell 與密碼找回的針對性瀏覽器檢查：26 pass／0 fail。先前候選有 7 fail／19 pass：手機寬度規則把收合工具當成三欄整列，撐出登入標題；鍵盤序列也需包含新增的工具入口。修正實際 CSS 寬度及導覽序列後，未移除寬度、觸控或焦點 assertions。320px／390px 原生截圖已檢視。
- Model fixture 修正後 2 pass／0 fail：正常執行及 ACK 遺失均只有一次 Execute／一次私人成果；不呼叫真實 provider、不消耗真人額度。修正前的失敗、clock 控制反例及拒絕版本留在本機，不能記作成功。
- 新分享入口與既有作品投稿／shell 的針對性回歸：18 pass／0 fail，含桌面與 320px 真實作品提交、五個實際控制項、單次寫入、三主題與失敗恢復。完整三階段 E2E（一般頁面、私人模型 fixture、avatar asset fixture）仍待最終執行。
- Review 修正後，組合回歸 22 pass／1 fail：新的分類／焦點及 27 則留言案例通過，唯一失敗是 test helper 在 toolbar 尚未掛載時返回。依 trace 改等實際可見入口，工具／guide 完整回歸 27 pass／0 fail；包含登入、四種寬度、兩主題、關閉／Esc、私人輸入、真實導引與跨帳號隔離。沒有把先前失敗版本記作 PASS。

以上是載入量、可共用請求成本與特定流程的證據；正式站延遲、負載、全部按鈕真人操作及競品比較仍保留在原目標矩陣中。
