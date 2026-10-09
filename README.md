# Freedom Platform

共同基礎收尾從 [Foundation Complete](docs/platform-plan/execution/unified-foundation/closeout.md) 開始；
[現況快照](docs/platform-plan/execution/unified-foundation/current-state.json)區分已合併、已部署與實際驗收，
[原需求證據](docs/platform-plan/execution/unified-foundation/requirement-evidence.json)是逐項狀態的唯一索引。

<!-- freedom-repository-guide:start -->
## 在自由工坊的位置

[自由工坊](https://freetwai.com) 讓會員先選擇公會並領取 Repo 技能書（定位測驗可稍後補做），再以供貨、商店、開源作品、行銷與小隊共同完成成果。

自由工坊的會員入口、中央資料庫與跨模組業務規則。 已提供 email 註冊、選主要公會（定位測驗可稍後補做）、公會與技能書、會員隱私、小隊、供貨與商店草稿、作品共創、行銷紀錄、Access 管理與公會長本人確認。

正式買家結帳、平台代收款、銀行實收核實、通用 Agent 執行授權都不能由目前的預覽紀錄推定已完成。

本 repo 的維護者負責「自由工坊的會員入口、中央資料庫與跨模組業務規則。」這個模組；公會職稱與自填 GitHub slug 不授予寫入權。

程式／內容入口：[apps/portal-web/src/modules/](apps/portal-web/src/modules/)、[apps/platform-api/src/routes/](apps/platform-api/src/routes/)、[modules/](modules/)、[migrations/](migrations/)、[packages/db/](packages/db/)。協作先讀 [CONTRIBUTING.md](CONTRIBUTING.md)，讓 Agent 讀 [AGENTS.md](AGENTS.md)；從[本倉 Issues](https://github.com/FreeTWAI-AI/freedom-platform/issues)認領、[查看既有 PR](https://github.com/FreeTWAI-AI/freedom-platform/pulls)避免重工。

會員、權限、公會、商品、商店、合作和稽核的權威寫入在本 repo 的 API／PostgreSQL。外倉用版本化契約；本機、staging、public 使用分開的資料庫。GitHub Issue／PR 保存程式協作事實；Seller／bank 保存實收事實。 跨 repo 的協定由[中央平台](https://github.com/FreeTWAI-AI/freedom-platform)維護。
<!-- freedom-repository-guide:end -->

本 workspace 保存 Freedom 大平台的完整規格，以及 **0.13.0-member-messages 自由工坊會員入口**。內建目錄為 18 個公會、41 本技能書（47 個原作 repo 指引）；管理員另可核准會員申請的自訂公會。新會員註冊後選擇主要公會並取得 Repo 技能書（定位測驗可稍後補做），再進入供貨、商店、作品、行銷與小隊。會員名片有個別聯絡欄位的可見範圍。各模組共用中央會員與 PostgreSQL。

API 的 Node／Worker 共用 request middleware 僅在耗時 ≥ 1000 ms 或最終 status ≥ 500 時，以 `console.warn` 輸出一行 JSON：`{event, method, route, status, duration_ms}`。5xx 優先使用 `server_error`，其餘為 `slow_request`；耗時包含 I/O 等待，`route` 是含 sub-app prefix 的 Hono 路由樣板，未匹配時為 `unmatched`，不記錄實際 path／params、query、headers、cookie、body、user ID 或錯誤內容。快速 2xx／4xx 不新增 log，既有錯誤回應與 `request_failed` 保留；此候選不代表已部署。

技能書分享可從每本 100 則介紹擲骰子選文，再分享或複製介紹與連結；41 本技能各有功能示意圖，供介紹頁與分享縮圖使用。新增「上傳技能」私人 Agent 指令、60 分鐘一次性投稿授權，以及可撤銷的投稿專用 API 金鑰與 Node 客戶端。Agent 上傳後由本人預覽送出，公開介紹頁保留 GitHub 來源、固定版本與授權；公開的作品列在技能書架的「社群技能書」，不自動成為公會指定技能。詳見 [Agent 技能草稿上傳](./docs/development/agent-skill-upload.md) 與 [0.12 版本紀錄](./docs/releases/2026-09-23-agent-skill-sharing.md)。

歷史（2026-09-24 第一批）：新增 Mini 的 Local Workspace MCP、Hao 的 Editkin、Jason 的定位小書僮與 David 的巫師公會交誼廳，當時目錄 29 本。保留原作署名、版本與授權觀察，詳見 [四位作者技能書登錄](./docs/development/member-skill-registration.md)。

2026-09-24 第二批：加入綠豆、隊長、Yuri、阿軒哥哥的 8 個作品，目錄從 29 本增至 37 本；名片可修改社群顯示名稱，並選填男／女／外星人／AI。詳見 [社群原作技能書與名片更新](./docs/development/community-author-skills.md)。

2026-10-01：上架阿軒哥哥（阿軒割割）的 Open SEO Advisor，由成長與行銷公會指定，當時目錄 38 本技能書、44 個原作 repo 指引。

2026-10-01 第三批：會員以「手動登錄作品」登錄的 3 件作品（jasonlee(J太郎) 的自動 Podcast 剪輯與 AutoVtuber、小艾老師的 Coding Audit Harness）整理為社群技能書，目錄為 41 本技能書、47 個原作 repo 指引。詳見 [手動登錄作品整理為社群技能書](./docs/development/manual-work-skill-books.md)。

前版 0.9.7 修正 GitHub Star 權限錯誤提示，App 建立流程明確申請 Metadata 讀取，後台提供權限與 Repo 安裝入口。既有 App 仍需在 GitHub 補齊設定；站內連結成功不代表每個按星請求都已獲 GitHub 允許。

公開會員入口：<https://freetwai.com>；內部入口：<https://staging.freetwai.com>（Cloudflare Access 限定名單）。
部署 source、schema 的最近觀察、功能狀態、R2／恢復限制及治理 pins 統一見上方現況快照。
[首次 Cloudflare 切換](docs/development/cloudflare-migration.md#14-切換後現況2026-09-25)、
[PostgreSQL 移植](docs/platform-plan/execution/unified-foundation/actual-migration-2026-10-04.md)及
[R2／恢復操作](docs/platform-plan/execution/unified-foundation/r2-recovery-retirement-2026-10-04.md)
保留各次有日期的歷史證據。下面的功能敘述說明實作範圍，不另作部署或完整驗收聲明。
目前工作順序以 Foundation Complete 收尾入口為準。

本分支新增 #252「搜尋社群內容」：沿用 PostgreSQL 即時讀取外部分享貼文、公開作品、技能書與活動，支援中文子串、類型與選填主題組合及游標分頁；不搜尋私訊或草稿；#193 原生短貼文與外部分享一樣只對同社群會員可見，標題取內文開頭、連到「社群分享」，不含留言或按讚。`FREEDOM_COMMUNITY_SEARCH_ENABLED=true` 才註冊入口，預設關閉，啟用前須套用 migration 137；本機驗證不表示部署或 flag-on 授權。搜尋只投影原可讀內容，不回傳 email、線上參與連結或私人位置；作者／技能書維護者可補至多三個主題，寫入沿用 command、If-Match 與稽核。

工坊夥伴名冊支援公開資料搜尋、公會篩選、加入日期／暱稱排序與緊湊列表；詳細技能和聯絡方式可展開。舊會員依開站日 2026/9/23 記錄，新會員保存實際加入時間。

名片可新增多個社群帳號或頻道，同平台也可重複加入；每筆獨立編輯、刪除及設定可見範圍，預設只有本人可見。詳見 [會員社群連結](./docs/development/member-social-links.md)。

右上角「設定」集中我的名片、GitHub 必做待辦與我的訊息。訊息也可從主要導覽或功能搜尋找到，分為通知、公會閒聊、小隊閒聊、私人訊息與世界聊天，依當下成員資格開放；通知包含好友、小隊邀請、公會審核與任命結果。小隊邀請由受邀本人接受。詳見 [會員設定與訊息](./docs/development/member-settings-messages.md)。

本分支提供獨立會員封鎖候選：阻止雙向私訊與好友邀請，保留本人歷史訊息與共同頻道；本人可管理私人封鎖名單。`FREEDOM_MEMBER_BLOCKING_ENABLED` 僅在精確值 `true` 時開放管理入口，預設關閉；部署本程式前仍須先套用 migration 136，即使旗標關閉也會保護已保存的封鎖。這是 #251 的封鎖切片，不含檢舉案件、政策核定或部署驗收。操作與回滾邊界見 [會員設定與訊息](./docs/development/member-settings-messages.md)及[通知與私訊服務](./docs/development/member-communications.md)。

本分支新增工坊原創圖片貼圖與指定訊息回覆，公會、小隊、世界與私訊均可使用；重新載入後仍能讀取，未知傳送結果可用同一筆 key 重試。舊社群專案的採用對照、資料邊界、素材來源及部署步驟見 [社群設計與聊天升級](./docs/development/social-project-upgrade.md)。這是本分支提交範圍，尚未宣稱已部署。

本分支的社群活動支援每場專頁與會員專屬分享連結、分享報名統計、未來活動行事曆，以及公會限定／工坊會員／推薦連結公開／完全公開四種參與範圍。推薦連結公開活動在報名後才提供線上連結，並寄送參與資料到填寫的 Email；公開訪客報名需要可用的 `EMAIL` binding（Node 本機可注入 `eventEmailSender`）。活動海報支援直式與橫式 PNG／JPEG／WebP（512 KiB 以下），影片支援 MP4／WebM（20 MiB 以下）。會員名冊與私訊依最近兩分鐘的有效 session 活動顯示在線狀態，並列出可確認的上次上線時間（最近一次 session 活動）；沒有活動紀錄的舊 session 不推測。這些是本分支實作，並非已部署聲明。

登入後的全站 Game Console 以底欄、展開面板與獨立視窗呈現系統提示、AI 工作說明、會員聊天與發布動態；資料來源和更新間隔見 [會員 Game Console](./docs/development/game-console.md)。

各頁右上角提供想法、說明與編修入口；想法按頁面標記整理 GitHub Issue，站內發布使用會員自己的 GitHub 授權，手機世界聊天使用站內抽屜。權限與資料邊界見 [頁面工具與世界聊天](./docs/development/page-tools.md)。

會員入口已按用途整理：技能書架獨立提供「已解鎖／未解鎖」書目，開源投稿只處理專案登錄；公會與平台管理集中在管理分組，手機使用可展開選單。詳見 [全站導覽審查](./docs/development/workspace-ia-review.md)。

公會頁在該社群尚未由平台管理員切換前，仍依「主要與次要」「其他已加入」「未加入」分區。最上方最多三張：一個主要、兩個可自行設定的次要公會；新入會不會擠掉已選次要。管理員對該社群執行「分類與主力切換」之後，同一頁改為三類主力（社群架構開發、社群業務推廣、社群專業服務），每類至多一個、可以留空；次要公會不會自動升成主力。分類未定的公會顯示「分類整理中」，仍可加入與使用。卡片只列第一本入門技能，其餘收進公會技能書庫。已領取技能書在退出後保留，未解鎖書目仍可免費預覽。詳見 [公會分組與解鎖書架](./docs/development/guild-library-layout.md)。

公會長與專家各占一列，會長在上、專家在下；頭像、姓名與職稱一起呈現，手機版以精簡人物列保留閱讀寬度。技能書架使用小封面橫列，首頁與模組入口縮減裝飾圖和留白，完整介紹仍可展開閱讀。每個公會最多三位專家；後台可從啟用中的平台會員直接任命，未入會者會同時加入該公會並領取技能書，保留原主要公會與定位。專家標章不增加管理權限，詳見 [公會管理 API](./docs/development/platform-admin-api.md)。

歷史（2026-09-23 公會共作版）：加入活動與空間、光影光雕、人類圖研究所三個公會，當時 25 本技能書的一鍵分享與 Agent SKILL.md、公會指定技能標章、真實加星週／月榜，以及會長公告、技能負責人編輯與會長討論區。使用方式與資料邊界見 [公會共作與技能分享](./docs/development/guild-collaboration.md)。

前版新增 GitHub 真實 Stars／Forks／追蹤與更新指標、會員授權後直接加星／取消星星，以及後台 GitHub App 設定，詳見 [GitHub 連結與部署](./docs/development/github-social.md)。0.7 版包含會員頭像、當時 22 本專屬技能書插圖與原作者 Star 連結、任務／商品／小隊篩選，以及後台管理員任命。定位只保留一套流程，調整方向由「重新探索定位」進入。詳見 [0.7 操作與部署](./docs/development/member-toolkit.md)。既有共創與 Repo 指引見 [0.5 版本紀錄](./docs/releases/2026-09-23-collaboration-optimization.md)、[原計畫對照](./docs/development/plan-drift-2026-09-23.md) 與[網站／Agent 開發導覽](./docs/development/agent-development-guide.md)。

各產品模板已依 [九倉分工與串接方式](./docs/development/repository-integration.md) 獨立保存，透過固定版本的 API／SDK 共用中央會員與資料。

## AI 雙商店

「我有東西要賣」下載內部商店 MD；「我可以賣東西」挑商品後下載公開商店 MD。AI 整理商品、製作網站並引導各店申請金流，再由本人上傳成果、預覽確認歸檔。中央提供轉單、商店後台回報的兩筆付款記錄，以及人工出貨登記；不代收、不自動扣款、不追蹤物流。真人金流與各外部網站仍须另行驗收。詳見 [AI 雙商店規格](docs/development/supplier-retail-pricing.md)；下一位 Agent 先讀 [設計規劃與交接](docs/development/agent-shop-handoff.md)。

## 新人入口與會員交流

本分支新增 #249 訪客公開探索，**尚未部署，預設關閉**；只有 `FREEDOM_COMMUNITY_DISCOVERY_ENABLED=true` 才啟用，Node 與 Worker 共用有效開關，`/api/v1/site` 回報 `community_discovery_enabled`。

- 首頁與 `/api/v1/public/community-discovery` 提供公開資源、會員作品、近期活動、活動回顧及會員服務，每類最多 3 筆。來源為既有技能書目錄及目前合法公開的 PostgreSQL 投影；不使用私人草稿、會員 API、聯絡方式或隱藏內容數量。作品卡不新增公開會員顯示名稱，既有投稿 API 投影不變；資源保留原作來源，活動與服務沿用已公開的名稱。真實零內容與來源暫時不可用分開顯示，單一來源失敗不抹除其他內容，訪客可重試。
- 保留原 Logo、三主題、登入／註冊、密碼重設與頁面工具。先探索不要求帳號；加入後只返回仍合法公開的同站內容，不新增強制定位。`return_to` 僅接受既有內容路徑，不接受外站、query、hash、推薦碼或 token；內容已撤銷或無法確認時，保留已建立的帳號並提示原因。

本分支新增 #230 私訊圖片，**尚未部署，預設關閉**：只限 1:1 私訊、每則 1 張、JPEG／PNG／WebP、輸入 2 MiB 以下，伺服器重新輸出 WebP 並移除 EXIF 等中繼資料，最長邊 1920 px、不放大。走既有網域媒體 Asset 管線（新 purpose `member.message-image`、provisional migration 139），讀取只有該則訊息的雙方，第三人、跨社群或撤權一律 404，不產生公開或簽章網址。Worker 開關 `FREEDOM_MESSAGE_IMAGE_ENABLED="true"`（須有 `MEDIA`、`IMAGES`）或 Node 注入兩個媒體 port，決定 `/api/v1/site` 的 `message_images_enabled` 與圖片路由是否安裝；未安裝時為 false／404。新上傳還需要營運設定 `domain_media_storage_policy` 的 `member.message-image` 為非 `legacy` 模式（建議 `r2_only`）、有效政策 revision、至少 1 MiB 保留容量及允許保存；未符合時新上傳回 503，site 的安裝旗標不變。停止新保存不撤銷仍具讀取權的既有圖片，也不清除未知結果。保存期限、孤兒草稿與刪除規則見 [訊息圖片 Asset](modules/assets/message-image.md)：本變更不啟用任何清理排程，沿既有會員封鎖阻擋新上傳／重播／傳送並保留歷史讀取；不新增檢舉。僅本機與 Miniflare R2 驗證，未做遠端 Workers／R2 驗收。
- 公開摘要、詳頁及媒體讀取使用目前狀態與作者權限，啟用時採 `no-store` 並在既有 domain reader 前後核對。首頁及活動頁重新可見時先清除舊資料再查詢。僅在啟用時，服務、回顧及公開技能介紹的唯讀 HTML 注入同站外部 script：`pagehide` 清除內容與 OG，`pageshow` 的 `persisted` 返回重新讀取，避免 bfcache 還原已撤銷內容；不因 `focus`／`visibilitychange` 重載或丟失捲動，不放寬 CSP。關閉時不注入，保留既有 HTML 與登入連結。
- 啟用時活動與回顧探索只列 `open`；既有推薦連結活動的未列出 metadata／報名流程不轉為公開探索或可索引內容。關閉時保留既有活動回顧「各種可見範圍的已結束活動」公開描述政策，不把它誤稱為全站 `open-only`。本案未啟用正式站開關，也未授予 merge／deploy 權限。

本分支簡化作品分享與開源投稿：一般作品只需名稱與介紹，作品連結選填；開源工具直接填表、預覽、本人確認公開，不必操作 Agent 或貼 JSON。公開失敗保留可修改的私人草稿。流程與 AI 共創社群電商後續規劃見 [簡單分享作品與投稿工具](docs/development/simple-work-sharing.md)。尚未宣稱已部署。

本分支新增「工坊誌」會員名片模板，以自由工坊配色自動帶入頭像、姓名、公會與精選專長；開啟分享後提供可撤銷的 QR Code 與 PNG 下載。接續 PR #86 的電子名片功能，設計畫面、隱私邊界與驗證見 [工坊誌會員名片](docs/development/member-editorial-card.md)。尚未宣稱已部署。

新會員須先選擇主要公會並領取該公會技能書，會員功能才會開放；定位測驗可稍後補做。我的名片可開啟可撤銷的分享連結。首頁與名片會推薦一位工坊夥伴，並提供好友名單、公會主題篩選，以及每日公會目錄分析。詳見 [新人入口與會員交流](docs/development/member-connections.md)。

註冊只需 Email 與密碼，顯示名稱選填；訪客可先預覽免費資源。加入公會後，首頁直接提供已領技能書、公會聊天室與任務／作品入口。控制台與訊息頁只顯示選定的對話，保留草稿，並自動帶入新訊息。詳見 [簡約會員體驗](docs/development/calm-member-experience.md)。

## 啟動本機版本

需要 Node.js 24 與 Docker Compose：

```sh
npm ci
npm run demo
```

開啟 <http://127.0.0.1:4310>。示範帳號為 `maker@local.test`、`reviewer@local.test`、`client@local.test`，共用示範密碼 `freedom-local-demo`。

操作方式、架構位置與重跑檢查見 [本機運行手冊](./docs/development/local-runtime.md)；筆電／手機入口見 [Staging＋Access 佈署清單](./docs/development/staging-access-deploy.md)；已完成範圍與驗證見 [模組版本紀錄](./docs/releases/2026-09-23-modules-preview.md)。舊版工作認領、交付驗收與合作流程保留。供貨與合作流程仍屬會員內部預覽，供貨回應屬演練，尚無正式結帳；示範收款紀錄不代表真實收入或銀行核實。

靜態建置快取（#322，尚未部署）：Worker 與 Node 僅對成功找到的 `/assets/<name>-<8 字元 base64url hash>` JS／CSS／圖片／字型等建置檔回 `Cache-Control: public, max-age=31536000, immutable`。HTML／SPA shell、固定入口 `/assets/skill-social.js`、`/assets/` 外檔案、API、404 與缺檔 fallback 保持 `no-store`；CSP、nosniff 與 Referrer-Policy 不變。

## 完整計畫與營運驗證

Freedom Platform 是社群的接點、共同資料庫、核心 codebase 協作索引、工作／商業事實帳本與狀態機。Discord 承接討論與讀書會，LINE 承接即時聯絡，GitHub 承接程式版本與 PR；money 的權威事實留在 Seller 的 provider／bank，客戶 raw data 留在 client／Squad storage，平台只保存必要的 ref、digest 與 fact。

現行推進：**2026-10-01 整合 Issue #42，選主要公會（定位測驗可稍後補做）、Repo 技能書與公開會員 Beta。** 2026-09-23 起曾以封閉式新人定位為入口。 2026-09-24：加入 AI 開發或 AI 導入與驗證公會取得技能開發資格，加入平台開發公會取得平台開發資格，離會即撤銷；GitHub OAuth、App 安裝與細範圍 key 分開驗證。見[公會開發資格](./docs/development/guild-development-access.md)，計畫對齊、逐頁稽核與驗證見 [2026-09-24 全站整合報告](./docs/development/audit-2026-09-24.md)。 完整架構保留，不把未來案源當報酬，不預設核心補位。第一筆真實合作與收款仍待真人證據，見 [首批營運驗證](./docs/development/operating-validation.md)。

先讀 [低維運互惠運作契約](./docs/platform-plan/12-low-ops-mutual-benefit.md) 與 [現況紀錄](./docs/platform-plan/09-handoff-record.md)。[2026-09-19 變更說明](./CHANGES-2026-09-19.md) 與當日 verification 保留作歷史紀錄；本次實跑結果以新版本紀錄為準。

第一次接觸專案，可先讀兩份白話敘事：

- [成員與 Agent 的一天](./docs/platform-plan/10-member-agent-narrative.md)：從真實求助、共同成果與合法重用，看見三種參與模式及實益如何形成。
- [管理者與 Agent 的一天](./docs/platform-plan/11-operator-agent-narrative.md)：從五人核心團隊、委派、A4、labels、事故處理與 Foundation Day 1，看見平台如何運作。

完整入口是 [`docs/platform-plan/README.md`](./docs/platform-plan/README.md)；現況、未建立事實與驗證方式見 [`docs/platform-plan/09-handoff-record.md`](./docs/platform-plan/09-handoff-record.md)。Foundation Day 1 依 `08 §13` 一次建立 O1／O2 與 production／staging 地基，之後依技術依賴推進階段 1A 契約凍結、1B 全形狀 skeleton、1C 真實 sandbox 接線與 2 垂直細節及發布成熟度。

規格涵蓋：

- 八個使用者模組、五個 operating cores，以及唯一 module seams。
- 縱向 Guild、橫向 Squad、Runner → Strategist → Master 與可交接 Officer。
- 五人核心團隊、AI review、成員 A4、Ted 三類 A4 與 evidence labels。
- 開源 Skill、商品 QC、AI 軟體商品化、專業服務與 Opportunity。
- 單一 Seller checkout、Supplier 承諾、seller-owned collection 與 bounded settlement。
- 56 packages、9 repos、12 runtimes／consumers、contracts、tests 與完整交付計畫。

文件中的 adopted／decided 只表示設計已納入現行 baseline，不表示功能已上線。Machine-readable contracts 在階段 1A 凍結，並於後續階段實作、取得驗證 evidence 後，才可能成為可發布的 production contract。

## 一起開發

會員可從「一起開發」找到專案缺少的角色，讀取 GitHub Issues、複製給 Agent 的任務說明，再由維護者審查 PR。詳見 [共創與貢獻紀錄](docs/development/co-creation.md)。示範 repo：[工坊 video-autopilot-kit](https://github.com/FreeTWAI-AI/video-autopilot-kit/issues)。

會員註冊只填一個 Email；登入信箱即聯絡信箱，公開範圍於名片多選設定。目前有 18 個內建公會，包含資安、音樂創作與 MV、廣告攝影與影片，另可加入已核准的自訂公會；公會長未任命時如實顯示待任命。

本分支的 #258 沒有另開分享頁，而是擴充標題列既有的「＋分享」單一入口，且預設關閉：`FREEDOM_UNIFIED_SHARING_ENABLED=true` 才在同一個選單說明各目的的可見範圍與草稿／發布差異，並加入「找人合作」「發起共創邀請」兩個原表單入口；沒開時維持原本的發文、分享作品、刊登商品、分享開源資源。不另建統一發布表、不增加一般作品的 GitHub／Agent／JSON 門檻，原本的來源、授權、本人公開同意與雙方合作隱私仍由各模組負責。「發文」使用既有原生短貼文，只有同社群會員可見、送出即發布；它沒有原生提問型別、草稿或留言通知，本分支不改動這些 #193 契約。

切換入口時，原表單尚未送出的輸入、同意、待處理狀態與實際成功結果只保留在**目前登入工作階段的記憶體**（這部分不受旗標控制）；重新整理、登出或切換帳號會清除。原流程已保存的伺服器私人草稿仍依各自規則續寫。延遲回應不能替下一位會員公開，未知送出結果沿用原 Idempotency-Key 重試；成功只顯示真正已保存物件的原入口，不把草稿當成發布。詳見 [會員 API](docs/development/member-api.md#unified-sharing-entry-258)；本機驗證不代表全項 #258 驗收、部署或啟用完成。
