# 舊社群專案的可用設計與聊天升級

## 來源與採用判斷

2026-10-02 依 Hao 的指示閱讀其 `Social_BIH` 舊專案：`MySocial_技術架構規劃.docx`、Next.js 前端、Supabase migrations、聊天／社群資料層、貼圖選擇器與動態排序。該規劃文件署名 Hao0321 Studio、Claude 協助規劃。以下是程式與文件的靜態判讀；本輪未啟動舊站，也未驗證其 Supabase、通話、營收或部署。

| 舊專案的設計 | 看見的實作／限制 | 自由工坊採用方式 |
| --- | --- | --- |
| 貼圖選擇、搜尋、預覽 | `components/ui/GifStickerPicker.tsx` 的貼圖主要是 emoji，GIF 是漸層示範；`components/chat/StickersPage.tsx` 有貼圖包的呈現 | 本輪加入四張原創圖片貼圖、搜尋與待送預覽。API 驗證固定 ID，訊息實際落庫 |
| 回覆指定訊息 | `types/index.ts`、`components/chat/ChatPage.tsx` 有引用呈現；migration 002 有 `reply_to_id`，UI 部分互動在元件 state | 本輪保存原訊息 ID，由 API 取得精簡引用；資料庫限制同一公會／小隊／世界頻道或相同私訊雙方 |
| 社群 → 頻道 → 訊息 | `lib/db/communities.ts` 與 migration 005 分開社群、成員與頻道 | 延續自由工坊已存在的 community、guild、squad 邊界及即時成員資格；未加入者取得貼圖 ID 也不能加入聊天 |
| UI 與資料存取分層 | `lib/db/*`、`lib/hooks/*` 分開聊天、通知、社群、封鎖等模組 | 延續現有中央 API／PostgreSQL。新增共用 content DTO／驗證與兩個聊天介面共用的貼圖、引用元件 |
| 即時訂閱與輸入狀態 | 舊專案有 Supabase Realtime 訂閱／廣播；兩份聊天資料存取還採用不同 message shape | 後續可設計傳輸適配層。訊息先持久化，推播只通知有更新，再經目前權限讀取；本輪維持既有每秒輕量更新 |
| 動態排序、多樣性、探索 | `lib/algorithm/feed-rank.ts` 有時間衰減、關係與作者多樣性規則，UI 也使用 mock data | 後續將真實活動、任務、作品整理成可篩選動態。先提供「我的公會／追蹤／最新」，讓會員明確知道為何看見一筆內容，再評估推薦 |
| 創作者工具、收藏、媒體 | 舊專案分開草稿、內容排程、媒體、創作者頁 | 後續優先讓創作者分享作品／資源，再連到真實任務、夥伴與合作，衡量完成合作與回訪，而不只增加曝光數 |
| 有原因的審核、申訴時間線 | 舊架構文件描述處分原因、證據及 reviewer，程式有相關 UI／資料層 | 可接續自由工坊已合併的維護者審核中心，設計本人可見的申訴狀態與真人裁決；服務承諾需營運者另定 |
| 大型社群／商業架構 | 文件列出微服務、廣告分潤與規模成本，程式庫以 Next.js／Supabase 為主 | 現有規模先保持模組化與可測的中央寫入。舊文件的收益與成本是規劃假設，不是目前的商業事實或平台政策 |

本 PR 的程式與貼圖重新實作，保留來源的設計署名；未複製舊專案的完整程式、私人設定、資料庫資料或第三方貼圖。原自由工坊品牌與圖片未修改。

## 本次可操作的功能

公會、小隊、世界聊天、私訊及控制台共用同一套內容元件：

1. 按「選擇貼圖」，可搜尋「合作」「加油」等名稱／同義詞。
2. 選擇圖片後顯示預覽，按原有「送出／傳送」保存。選「改寫文字」會回到原文字草稿。
3. 對一則訊息按「回覆」，再輸入文字或選貼圖；可取消回覆。
4. 接收者看見貼圖與引用，重新載入仍存在；引用只提供原訊息作者與最多 160 個 Unicode 字元，沒有遞迴引用全文。
5. 各對象／頻道分開保留文字、選中的貼圖與引用草稿，僅存在目前元件記憶體。取消權限後不顯示聊天引用。
6. 圖片載入失敗仍顯示 `[貼圖] 名稱`。舊版純文字客戶端也可讀取這份 fallback。

貼圖包：工坊夥伴 v1，包含「你好」「謝謝」「加油」「一起共創」。本輪提供靜態原創貼圖；個人上傳、付費貼圖商店、GIF、撤回、表情反應、通話與輸入中狀態屬後續工作。

## 聊天室操作更新（2026-10-02）

依 Hao 要求，完整訊息頁採接近 App 的手機操作：

- **列表 → 對話 → 返回列表**：760px 以下只顯示列表或目前聊天室。公會、小隊與私訊都有明確返回按鈕，返回後焦點回到列表；桌面保留左右雙欄。控制台沿用單一畫面切換。
- **正在和誰聊**：私訊顯示頭像、名字與在線狀態；從既有對話選人時，等待 API 期間也保留對象名稱，不顯示另一人的歷史。
- **訊息獨立捲動**：標頭、訊息區與輸入區分開；較早訊息、回到最新及手動重新讀取仍可操作。零未讀的文字保留給輔助科技，畫面只突出真正未讀或未確認狀態。
- **簡短輸入區**：輸入框由一行自動長高至 128px；手機 Enter 換行、按送出才傳送，桌面維持 Enter 送出／Shift+Enter 換行與中文輸入法防誤送。
- **真實傳送狀態**：傳送中與結果未確認各自顯示；重試沿用同一份 payload／key。只有 API 確認後標為已送出；私訊「對方已讀」來自 read_at。
- **草稿不因返回而消失**：文字、貼圖、引用各自依對象保存於記憶體。手機返回、切換分頁、改變視窗尺寸，都不將草稿寄給別人。

新增 `ChatWorkspace.tsx`／CSS 共用上述操作。私訊 body-free activity DTO 增加 `last_outgoing: {message_id,read_at} | null`，只查最近一則自己送出的訊息狀態；對方標記已讀且沒有新訊息時，畫面也會重新取得授權後的紀錄。活動檢查不傳正文、不自動標記已讀，既有客戶端可忽略新增欄位。

本次合併主線至 `b330aa7`，將尚未部署的聊天 migration 由 065 改為 **072**，避免與主線活動 migration 及待審 069–071 分支碰撞。已套用的主線 migration 未改寫。

## API、資料庫與傳輸

- 原 `POST /me/channels/:kind/:key/messages` 與 `POST /me/conversations/:userId/messages` 可傳 `{body}` 或 `{sticker_id}`，兩者擇一；可選填 `reply_to_message_id`。
- 原文字 DTO 不增加必填欄位。貼圖新增 `sticker: {id,label}`，引用新增 `reply_to: {message_id,sender_ref,sender_name,body,sticker?}`；未用到的欄位不回傳。
- 原 `body` 仍為非空純文字，貼圖採固定名稱 fallback；所有文字都以 React 純文字呈現。任意 URL、HTML、客戶端 quote 正文或假貼圖 metadata 被拒絕。
- migration **072_chat_stickers_replies.sql** 在兩張訊息表增加 nullable 貼圖／引用 ID；私訊新增由 DB 產生的無序會員對，以 composite FK 限定引用範圍。原文不能單獨刪除而留下引用，後續刪除／審核流程須先清除引用，再刪除原文。
- 查詢先通過原 session、同社群及即時成員資格判斷，再以一個批次查詢取得該頁的引用，沒有每則訊息個別查詢。世界聊天繼續排除其他 verification accounts，包括引用檢查。
- CSRF、Idempotency-Key、每分鐘傳送限額、已讀與增量游標沿用原規則。重試比對文字、貼圖與原訊息 ID，不能用同一筆 key 寄另一份內容。receipts 只保存已確認的 message ID。
- 保留已合併的每秒 body-free activity 檢查與立即「傳送中」回饋。沒有新增 WebSocket、外部圖片 provider、廣播聊天正文或把私訊永久存進瀏覽器。

圖片是單一 2×2 atlas，1254×1254、有 alpha，1,026,270 bytes。首次顯示貼圖／開啟選擇器才載入同源圖片；各格透過 CSS 呈現，共享同一檔案。完整生成提示詞、工具與路徑見 [貼圖來源紀錄](../design/chat-sticker-art-manifest.json)。

## 後續升級順序

1. **找得到人與合作**：可篩選的真實社群動態、私人收藏，以及「作品 → 所需角色 → 任務／小隊」的直接入口。
2. **溝通與信任**：真人可管理的封鎖／檢舉／申訴，通知偏好；再評估即時推播的權限撤銷、重連游標與負載。
3. **創作者參與**：有作者、授權、審核與版本的自訂貼圖包；實際活動／資源／作品的分享頁，及創作者本人可見的真實成效。
4. **可驗證的商業合作**：各方同意的分工、交付與收益條款，銜接既有 Seller 付款事實；社群參與數不能推定收入。

「第二個 META」是使用者提出的長期願景。可驗證的近期成果是加入者能找到夥伴、順利溝通並完成一次合作。上述後續項目是建議，本 PR 的可用範圍是聊天室操作、貼圖及回覆。作品分享與合作入口另見 PR #90，兩個分支可分開審核。

## 驗收與部署

開發使用 Node 24、隔離 PostgreSQL schema、合成會員及 Chromium；local／staging／production 的速度與部署狀態分開記錄。

| 本次命令／範圍 | 實跑結果 |
| --- | --- |
| `npm run typecheck`、`npm run build` | 通過；build 仍有既有大於 500 KiB chunk 提示 |
| `tsx --test`：chat-content、member-communications、member-channels-core、member-channel-access | 48/48 通過；含已讀狀態更新、既有並行傳送、權限撤銷、跨社群與 DB 約束 |
| `playwright test`：chat-stickers、member-settings、member-channels、member-channels-real、game-console | 最終同一輪 39/39 通過；含六個真實貼圖／操作案例、兩個真實成員資格案例、所有原有聊天／通知／控制台回歸及三主題 |
| 手機私訊返回／草稿／已讀、公會返回與尺寸切換兩案例 | 最終整理截圖後補跑 2/2 通過 |
| `npm run worker:dry-run` | local／staging-next／next 三環境打包通過，未部署 |

SQL migration 的最初草稿對 generated pair 使用 `ON DELETE SET NULL`，被 PostgreSQL 拒絕；已採相同對話的 FK 與預設 NO ACTION。新增 raw-write 測試的未使用 SQL 參數已修正。此次 UI 更新第一輪 37 案例有六個失敗：圖示加入 accessible name、手機不再顯示列表的舊觸控測量、即時撤權限後點擊已消失的重讀按鈕，以及通用 hover 蓋掉敘生分頁選取狀態。已修正按鈕名稱／hover，更新手機返回與撤權限的實際操作測試；最終完整受影響五份 suite 39/39 通過。

以上不代表全倉測試都已重跑；完整 gate 交由本次提交的 CI。靜態契約及跨倉 integration 本輪未重跑。手機驗證使用 Chromium 的 320px／390px 視窗，尚未在實體手機確認作業系統鍵盤、staging 或 production。

實際畫面：[公會貼圖回覆 390px](../design/social-chat/guild-sticker-reply-390.png)、[私人貼圖回覆 1280px](../design/social-chat/private-sticker-reply-1280.png)、[明亮](../design/social-chat/picker-light-320.png)／[夜航](../design/social-chat/picker-dark-320.png)／[敘生](../design/social-chat/picker-versefolk-320.png)貼圖選擇器 320px。

App 操作畫面：[私訊與返回入口 390px](../design/social-chat/private-workspace-390.png)、[公會聊天室 320px](../design/social-chat/guild-workspace-320.png)。全部使用本機合成會員。

維護者部署順序：

1. 更新主線相依，依既有流程套用主線 migrations，再套用 **072_chat_stickers_replies.sql**；本 PR 的部署 manifest pin 為 72。069–071 為其他待審分支使用，合併時請核對順序。
2. 部署同一 commit 的 Worker 與前端資產，確認 atlas 可以同源讀取。
3. 兩位合成會員分別在公會、小隊、世界與私訊寄送貼圖／引用，重新載入並檢查成員退出後的拒絕行為。
4. 在 320px／390px 及三主題確認貼圖選擇、搜尋、Esc、引用取消與送出；測試低速網路及未知 ACK 重試。
5. 回退應用程式時保留 migration 072 與既有訊息。舊客戶端能讀貼圖 fallback，升級後再呈現原貼圖；不刪除會員訊息。

本輪不部署正式站或 staging，不操作真實會員資料。提交作者 Hao0321，Codex 協助靜態查核、程式、原創素材生成、測試與文件，交由自由工坊維護者審查。
